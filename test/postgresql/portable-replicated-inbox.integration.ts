/**
 * #1694: the replication pass uploads every local hook event with the local
 * previousEventId pointer in its payload, and the upload stays resident in
 * lcm.passive_event_inbox until the apply settles. A portable export of the
 * project must still represent those rows, so the rows below come from a real
 * replication pass, not from hand-written payloads.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createPortableRecordStream } from "../../src/storage/portable-record-stream.js";
import { createPostgreSqlPortableSource } from "../../src/storage/postgresql/portable-source.js";
import { assertHarnessReady, settings, type PostgreSqlTestDatabase, withPostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql, PORTABLE_POSTGRESQL_FIXTURE, seedPortablePostgreSql } from "./portable-fixture.js";
import { sqliteSource } from "./portable-corpus.js";
import { replicateIntoInbox } from "./replicated-inbox-fixture.js";
import { seedPortableSqlite } from "../storage/sqlite-portable-fixture.js";

beforeAll(assertHarnessReady);

const fixture = PORTABLE_POSTGRESQL_FIXTURE;
const context = { domain: "passive-events", operation: "portableReplicatedInbox" } as const;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lcm-replicated-inbox-"));
  directories.push(directory);
  return directory;
}

function openSource(database: PostgreSqlTestDatabase) {
  return createPostgreSqlPortableSource({
    settings: settings(database.runtimeUrl),
    expectedOwner: "lcm_test_migrator",
    expectedIdentity: fixture.expectedIdentity,
  });
}

async function exportPassiveEvents(database: PostgreSqlTestDatabase) {
  const stream = await createPortableRecordStream(await openSource(database));
  try {
    const batch = await stream.readBatch({ domain: "passive-events", maxRecords: 500, maxBytes: 150994944 });
    return batch.records.map((record) => record.value as Record<string, unknown>);
  } finally {
    await stream.close();
  }
}

async function exportError(database: PostgreSqlTestDatabase): Promise<unknown> {
  return openSource(database).then(async (source) => { await source.close(); return undefined; }, (error: unknown) => error);
}

/**
 * The canonical passive-events records the SQLite portable source emits for the same local outbox, captured as its
 * events sidecar for the machine that replicated them.
 */
async function sqliteExportOfOutbox(outboxPath: string): Promise<Array<Record<string, unknown>>> {
  const directory = tempDirectory();
  const captured = join(directory, "events.sqlite");
  copyFileSync(outboxPath, captured);
  chmodSync(captured, 0o600);
  const connection = new DatabaseSync(captured);
  try { connection.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE"); } finally { connection.close(); }
  const native = seedPortableSqlite(join(directory, "native.sqlite"), {
    projectIdentity: { scope: "shared", projectId: fixture.projectId },
    identityFacts: {
      machines: [
        { identityKey: fixture.machineIdentityKey, machineId: fixture.machineId },
        { identityKey: fixture.secondaryMachineIdentityKey, machineId: fixture.secondaryMachineId },
      ],
      aliases: [],
    },
  });
  const stream = await sqliteSource(join(directory, "native.sqlite"), fixture.expectedIdentity, directory, {
    ...native,
    capturedSidecars: {
      ...native.capturedSidecars,
      events: {
        databasePath: captured,
        machineIdentityKey: fixture.secondaryMachineIdentityKey,
        expectedFileSha256: createHash("sha256").update(readFileSync(captured)).digest("hex"),
      },
    },
  });
  try {
    const batch = await stream.readBatch({ domain: "passive-events", maxRecords: 500, maxBytes: 150994944 });
    return batch.records.map((record) => record.value as Record<string, unknown>);
  } finally {
    await stream.close();
  }
}

function byEventId(values: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...values].sort((left, right) => String(left.eventId).localeCompare(String(right.eventId)));
}

/** The seeded project plus a real replication pass by its secondary machine. */
async function seedReplicated(database: PostgreSqlTestDatabase) {
  await seedPortablePostgreSql(database.migrator);
  await grantPortablePostgreSql(database);
  return replicateIntoInbox(database, tempDirectory(), {
    projectId: fixture.projectId,
    machineId: fixture.secondaryMachineId,
  });
}

describe("PostgreSQL 18 portable export of replicated inbox rows (#1694)", { timeout: 120_000 }, () => {
  it("exports inbox rows a real replication pass uploaded, without the local previousEventId pointer", async () => {
    await withPostgreSqlTestDatabase("portable-replicated-inbox", async (database) => {
      const replicated = await seedReplicated(database);
      try {
        const resident = await database.migrator.query<{ data: string; status: string; previous: string | null; created_at: string }>({
          text: "SELECT payload->>'data' AS data, status, payload->>'previousEventId' AS previous, payload->>'createdAt' AS created_at "
            + "FROM lcm.passive_event_inbox WHERE machine_id = $1 ORDER BY machine_sequence",
          values: [fixture.secondaryMachineId],
        }, context);
        // The uploads are what the daemon writes: the SQLite created_at text and a previousEventId key, resident in three states.
        expect(resident.rows.map((row) => [row.data, row.status])).toEqual([
          ["replicated-0", "quarantined"], ["replicated-1", "retry"], ["replicated-2", "pending"],
        ]);
        expect(resident.rows.map((row) => row.previous)).toEqual(
          replicated.events.map((event) => (event.prevEventId === null ? null : String(event.prevEventId))),
        );
        for (const row of resident.rows) expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

        const exported = await exportPassiveEvents(database);
        // Records come out in canonical identity order, so order them by the data they carry.
        const uploaded = exported
          .filter((value) => String(value.data).startsWith("replicated-"))
          .sort((left, right) => String(left.data).localeCompare(String(right.data)));
        expect(uploaded.map((value) => [value.data, value.disposition])).toEqual([
          ["replicated-0", "quarantined"], ["replicated-1", "pending"], ["replicated-2", "pending"],
        ]);
        for (const [index, value] of uploaded.entries()) {
          expect(value).toMatchObject({
            sessionId: "replicated-session",
            category: "decision",
            sourceHook: "PostToolUse",
            sessionSequence: { $integer: String(index + 1) },
            priority: { $integer: String(index) },
            createdAt: resident.rows[index]!.created_at.replace(" ", "T") + ".000000Z",
          });
          expect(value).not.toHaveProperty("previousEventId");
        }
        // The seeded fixture rows ride along in the same export.
        expect(exported).toHaveLength(6);

        // The SQLite source emits the complete canonical record for the same local events: identity, machine,
        // version, sequence, envelope fields and disposition all match. Nothing is excluded, because both
        // backends build the value from the same canonical fields and the pointer is omitted by both.
        await replicated.close();
        const sqliteRecords = byEventId(await sqliteExportOfOutbox(replicated.outboxPath));
        expect(sqliteRecords).toHaveLength(3);
        expect(byEventId(uploaded)).toEqual(sqliteRecords);
      } finally {
        await replicated.close();
      }
    });
  });

  it("accepts the SQLite created_at text on its own, so the previousEventId key is the only unsupported part", async () => {
    await withPostgreSqlTestDatabase("portable-replicated-inbox-created-at", async (database) => {
      await seedPortablePostgreSql(database.migrator);
      await grantPortablePostgreSql(database);
      await database.migrator.query({
        text: "UPDATE lcm.passive_event_inbox SET payload = jsonb_set(payload, '{createdAt}', '\"2026-01-02 03:04:05\"') WHERE status = 'pending'",
      }, context);
      const exported = await exportPassiveEvents(database);
      expect(exported.find((value) => value.disposition === "pending")).toMatchObject({
        data: "pending data", createdAt: "2026-01-02T03:04:05.000000Z",
      });
    });
  });

  it("still refuses an uploaded row whose envelope is not the replication envelope", async () => {
    await withPostgreSqlTestDatabase("portable-replicated-inbox-negatives", async (database) => {
      const replicated = await seedReplicated(database);
      try {
        const base = await database.migrator.query<{ payload: unknown }>({
          text: "SELECT payload FROM lcm.passive_event_inbox WHERE payload->>'data' = 'replicated-2'",
        }, context);
        const original = JSON.stringify(base.rows[0]!.payload);
        const mutate = async (expression: string, value: string | null): Promise<void> => {
          await database.migrator.query({
            text: `UPDATE lcm.passive_event_inbox SET payload = ${expression} WHERE payload->>'data' = 'replicated-2'`,
            values: value === null ? [original] : [original, value],
          }, context);
        };
        const refused = async (): Promise<void> => {
          expect(await exportError(database)).toMatchObject({ code: "record-unrepresentable" });
        };

        await mutate("$1::jsonb || '{\"extraEnvelope\":1}'::jsonb", null);
        await refused();
        for (const invalid of ['"1"', "true", "0", "-1", "1.5", "1.0", "1e-2", "{}", "[]"]) {
          await mutate("jsonb_set($1::jsonb, '{previousEventId}', $2::jsonb)", invalid);
          await refused();
        }
        await mutate("$1::jsonb - 'createdAt'", null);
        await refused();

        // The key is optional, and a JSON null is a value of its own, distinct from a missing key.
        await mutate("$1::jsonb - 'previousEventId'", null);
        expect(await exportError(database)).toBeUndefined();
        await mutate("jsonb_set($1::jsonb, '{previousEventId}', $2::jsonb)", "null");
        expect(await exportError(database)).toBeUndefined();
        await mutate("jsonb_set($1::jsonb, '{previousEventId}', $2::jsonb)", "9007199254");
        expect(await exportError(database)).toBeUndefined();
        // The boundary is the stored jsonb value: 1e2 is stored as 100, so it is a positive integer.
        await mutate("jsonb_set($1::jsonb, '{previousEventId}', $2::jsonb)", "1e2");
        expect(await exportError(database)).toBeUndefined();

        // Restoring the uploaded envelope makes the project exportable again.
        await mutate("$1::jsonb", null);
        expect(await exportError(database)).toBeUndefined();
      } finally {
        await replicated.close();
      }
    });
  });
});
