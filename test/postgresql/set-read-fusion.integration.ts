import { Client, type QueryConfig } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { setTimeout as pause } from "node:timers/promises";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql, PORTABLE_POSTGRESQL_FIXTURE, seedPortablePostgreSql } from "./portable-fixture.js";
import type { PostgreSqlQueryExecutor, PostgreSqlQueryOptions } from "../../src/storage/postgresql/contracts.js";
import { buildPostgreSqlClientConfig } from "../../src/storage/postgresql/client-config.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  PostgreSqlRuntimeReadinessError, verifyPostgreSqlRuntimeSchema, verifyPostgreSqlTransferSchema,
} from "../../src/storage/postgresql/runtime-readiness.js";
import { postgreSqlSearchConfigurationStatus } from "../../src/storage/postgresql/search-configuration.js";
import {
  findOccupiedCanonicalDomain, listCanonicalHeaders, readCanonicalDomainOccupancy,
} from "../../src/storage/postgresql/portable-mapping.js";
import { createPostgreSqlPortableSource } from "../../src/storage/postgresql/portable-source.js";
import { captureDestinationSchemaWitness } from "../../src/migration/verify-generation.js";
import * as copy from "../../src/migration/copy-destination.js";
import {
  createPortableRecordStream, PORTABLE_LIMITS, PORTABLE_RECORD_DOMAIN_ORDER,
} from "../../src/storage/portable-record-stream.js";

beforeAll(assertHarnessReady);

/**
 * Signal-bearing PostgreSQL 18 tests for the #1869 slice-2 statement fusion:
 * fused reads keep their settings isolation and row shapes, the ordered
 * emptiness check never evaluates a domain after the first occupied one, the
 * key-only page sentinel never projects the row it finds, and identity is
 * re-read after the locks a batch takes.
 */
const EXPECTED_OWNER = "lcm_test_migrator";
const context = { domain: "factory", operation: "setReadFusionIntegration" } as const;
const FIXTURE = PORTABLE_POSTGRESQL_FIXTURE;
const FUSED_PREFIX = "SELECT (SELECT COALESCE(pg_catalog.json_agg(fragment_row";
/** One json_agg part of a fused statement, as queryReadinessFragments and readSchemaWitnessInputs write it. */
const FUSED_PART = /\(SELECT COALESCE\(pg_catalog\.json_agg\(fragment_row( ORDER BY [^)]*)?\), '\[\]'::pg_catalog\.json\) FROM \(([\s\S]*?)\) AS fragment_row\) AS f(\d+)/gu;

type FusedPart = Readonly<{ ordered: boolean; column: string; text: string; values: readonly unknown[] }>;

/** Splits a fused statement into its parts, each with its own placeholder numbering and binds. */
function fusedParts(text: string, values: readonly unknown[]): FusedPart[] {
  let offset = 0;
  return [...text.matchAll(FUSED_PART)].map((match) => {
    const body = match[2]!;
    const placeholders = [...body.matchAll(/\$([1-9][0-9]*)/gu)].map((placeholder) => Number(placeholder[1]));
    const count = placeholders.length === 0 ? 0 : Math.max(...placeholders) - offset;
    const part = {
      ordered: match[1] !== undefined,
      column: "f" + match[3]!,
      text: body.replace(/\$([1-9][0-9]*)/gu, (_placeholder, number: string) => "$" + String(Number(number) - offset)),
      values: values.slice(offset, offset + count),
    };
    offset += count;
    return part;
  });
}

type Recorded = Readonly<{ config: QueryConfig<unknown[]>; operation: string }>;

function recording(executor: PostgreSqlQueryExecutor, recorded: Recorded[]): PostgreSqlQueryExecutor {
  return {
    query: ((config: QueryConfig<unknown[]>, options: PostgreSqlQueryOptions) => {
      recorded.push({ config, operation: options.operation });
      return executor.query(config, options);
    }) as PostgreSqlQueryExecutor["query"],
  };
}

const canonical = (row: unknown) => JSON.stringify(row, Object.keys(row as object).sort());

/**
 * Re-runs every fused statement and each of its parts as its own statement,
 * and requires the decoded parts to equal the standalone rows: the pg
 * driver's values on one side, JSON's on the other. Returns the number of
 * parts compared.
 */
async function expectRowParity(db: PostgreSqlTestDatabase, recorded: readonly Recorded[]): Promise<number> {
  let compared = 0;
  for (const { config, operation } of recorded) {
    if (!config.text.startsWith(FUSED_PREFIX)) continue;
    const fused = (await db.runtime.query(config, context)).rows[0] as Record<string, unknown>;
    const operations = operation.split("+");
    for (const [index, part] of fusedParts(config.text, config.values ?? []).entries()) {
      const name = operations[index] ?? operation + ":" + part.column;
      // The preload probe's row is discarded; only its success matters.
      if (name.endsWith(":probePgStatStatements")) continue;
      const standalone = (await db.runtime.query({ text: part.text, values: [...part.values] }, context)).rows;
      const decoded = (fused[part.column] as Record<string, unknown>[]).map((row) => (
        name === "inspectRequiredGinTrgmIndirectOperators"
          ? { ...row, referenced_operator_oid: Number(row.referenced_operator_oid) }
          : row
      ));
      if (name === "verifyGenerationSchemaWitness:f1" || name === "verifyGenerationSchemaWitnessLiveToLive:f1") {
        // The search part is evaluated as one status row.
        expect(postgreSqlSearchConfigurationStatus(decoded[0]), name).toEqual(postgreSqlSearchConfigurationStatus(standalone[0]));
      } else if (part.ordered) {
        expect(decoded, name).toEqual(standalone);
      } else {
        expect([...decoded].map(canonical).sort(), name).toEqual([...standalone].map(canonical).sort());
      }
      compared += 1;
    }
  }
  return compared;
}

async function asAdministrator(db: PostgreSqlTestDatabase, statements: readonly string[]): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    for (const text of statements) await administrator.query({ text }, context);
  } finally {
    await administrator.close();
  }
}

async function readinessOutcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { readiness: await run() };
  } catch (error) {
    if (error instanceof PostgreSqlRuntimeReadinessError) return { reason: error.reason, operation: error.operation };
    throw error;
  }
}

describe("fused readiness and schema-witness reads (#1869)", () => {
  it("keep every part's settings isolation under a hostile search_path and quote_all_identifiers, in autocommit and in the snapshot session", async () => {
    await withPostgreSqlTestDatabase("fusion-hostile-settings", async (db) => {
      const seeded = await seedPortablePostgreSql(db.migrator);
      await grantPortablePostgreSql(db, { transfer: true });
      const baseline = {
        runtime: await readinessOutcome(() => verifyPostgreSqlRuntimeSchema(db.runtime, { expectedOwner: EXPECTED_OWNER })),
        transfer: await readinessOutcome(() => verifyPostgreSqlTransferSchema(db.runtime, { expectedOwner: EXPECTED_OWNER })),
        witness: await captureDestinationSchemaWitness(db.runtime),
      };
      expect(baseline.transfer).toMatchObject({ readiness: { runtimeRole: "lcm_test_runtime" } });
      await asAdministrator(db, ["CREATE SCHEMA lcm_hostile"]);
      // The production client pins search_path in its startup options, so a
      // role or database default cannot make it hostile; a session can still
      // change it, which is what the fused statements must withstand.
      const hostileSettings = ["SET search_path = lcm_hostile, pg_catalog", "SET quote_all_identifiers = on"];
      const client = new Client(buildPostgreSqlClientConfig(settings(db.runtimeUrl)));
      await client.connect();
      try {
        for (const text of hostileSettings) await client.query(text);
        const autocommit: PostgreSqlQueryExecutor = {
          query: ((config: QueryConfig<unknown[]>) => client.query(config)) as PostgreSqlQueryExecutor["query"],
        };
        const shown = await client.query("SELECT pg_catalog.current_setting('search_path') AS search_path, pg_catalog.current_setting('quote_all_identifiers') AS quote_all");
        expect(shown.rows).toEqual([{ search_path: "lcm_hostile, pg_catalog", quote_all: "on" }]);
        expect(await readinessOutcome(() => verifyPostgreSqlRuntimeSchema(autocommit, { expectedOwner: EXPECTED_OWNER }))).toEqual(baseline.runtime);
        expect(await readinessOutcome(() => verifyPostgreSqlTransferSchema(autocommit, { expectedOwner: EXPECTED_OWNER }))).toEqual(baseline.transfer);
        expect(await captureDestinationSchemaWitness(autocommit)).toEqual(baseline.witness);
        // Each statement's guarded settings revert with its implicit transaction.
        expect((await client.query("SELECT pg_catalog.current_setting('search_path') AS search_path")).rows)
          .toEqual([{ search_path: "lcm_hostile, pg_catalog" }]);
      } finally {
        await client.end();
      }
      const session = await db.runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        // In the snapshot transaction a guarded setter lasts until rollback,
        // so the hostile settings are restored before each read.
        const hostile = async () => {
          for (const text of hostileSettings) await session.query({ text: text.replace("SET ", "SET LOCAL ") }, context);
        };
        await hostile();
        expect(await readinessOutcome(() => verifyPostgreSqlTransferSchema(session, { expectedOwner: EXPECTED_OWNER }))).toEqual(baseline.transfer);
        await hostile();
        expect(await captureDestinationSchemaWitness(session)).toEqual(baseline.witness);
      } finally {
        await session.close();
      }
    });
  }, 120_000);

  it("decode every fused part to the rows its own statement returns, on healthy and degraded catalogs", async () => {
    await withPostgreSqlTestDatabase("fusion-row-parity", async (db) => {
      await seedPortablePostgreSql(db.migrator);
      await grantPortablePostgreSql(db, { transfer: true });
      const recorded: Recorded[] = [];
      const recorder = recording(db.runtime, recorded);
      await verifyPostgreSqlTransferSchema(recorder, { expectedOwner: EXPECTED_OWNER });
      await captureDestinationSchemaWitness(recorder);
      // Healthy: three fused readiness statements (R2, R3, R5) plus the witness.
      expect(recorded.filter(({ config }) => config.text.startsWith(FUSED_PREFIX)).map(({ operation }) => operation.split("+")[0]))
        .toEqual(["inspectRuntimeRolePolicy", "runtimeReadinessExtensions:probePgStatStatements", "readMigrations", "verifyGenerationSchemaWitness"]);
      expect(await expectRowParity(db, recorded)).toBe(2 + 7 + 8 + 4);

      // Degraded: an unsanctioned column grant changes the ACL rows and
      // refuses in R5, and a missing digest overload changes the
      // trusted-function rows and stops at R3.
      await db.migrator.query({ text: "GRANT UPDATE (project_id) ON TABLE lcm.message_parts TO lcm_test_runtime" }, context);
      const extraGrant: Recorded[] = [];
      await expect(verifyPostgreSqlTransferSchema(recording(db.runtime, extraGrant), { expectedOwner: EXPECTED_OWNER })).rejects.toBeInstanceOf(PostgreSqlRuntimeReadinessError);
      expect(await expectRowParity(db, extraGrant)).toBe(2 + 7 + 8);
      await asAdministrator(db, ["ALTER EXTENSION pgcrypto DROP FUNCTION public.digest(bytea, text)", "DROP FUNCTION public.digest(bytea, text)"]);
      const missingDigest: Recorded[] = [];
      await expect(verifyPostgreSqlTransferSchema(recording(db.runtime, missingDigest), { expectedOwner: EXPECTED_OWNER }))
        .rejects.toMatchObject({ reason: "extension-preflight", operation: "inspectRequiredExtensionFunctions" });
      expect(await expectRowParity(db, missingDigest)).toBe(2 + 7);
    });
  }, 120_000);
});

const NON_IDENTITY_DOMAINS = PORTABLE_RECORD_DOMAIN_ORDER.filter((domain) => !["machines", "project", "project-aliases"].includes(domain));
/** A passive event the payload CHECK admits only once dropped: every envelope key is present, as array elements, so the projection reaches jsonb_object_keys. */
const RAISING_PAYLOAD = JSON.stringify(["sessionId", "sessionSequence", "category", "data", "priority", "sourceHook", "createdAt"]);
const VALID_PAYLOAD = JSON.stringify({ sessionId: "s", sessionSequence: 1, category: "c", data: "d", priority: 1, sourceHook: "h", createdAt: FIXTURE.timestamp });

async function insertPassiveEvent(db: PostgreSqlTestDatabase, sequence: number, payload: string): Promise<void> {
  await db.migrator.query({
    text: "INSERT INTO lcm.passive_event_inbox (inbox_id, project_id, machine_id, event_id, event_version, machine_sequence, event_type, payload) "
      + "OVERRIDING SYSTEM VALUE VALUES ($1::bigint, $2::uuid, $3::uuid, pg_catalog.md5('fusion-event-' || $1::bigint::text)::uuid, 1, $1::bigint, 'fusion', $4::jsonb)",
    values: [sequence, FIXTURE.projectId, FIXTURE.machineId, payload],
  }, context);
}

async function sqlState(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(() => "resolved", (error: { sqlState?: unknown }) => error.sqlState);
}

describe("ordered emptiness and the key-only page sentinel on PostgreSQL 18 (#1869)", () => {
  it("evaluates no domain after the first occupied one, and raises a lone malformed domain as its own header read did", async () => {
    await withPostgreSqlTestDatabase("fusion-ordered-emptiness", async (db) => {
      await seedPortablePostgreSql(db.migrator, { identityOnly: true });
      await db.migrator.query({ text: "ALTER TABLE lcm.passive_event_inbox DROP CONSTRAINT passive_event_inbox_payload_check" }, context);
      await insertPassiveEvent(db, 1, RAISING_PAYLOAD);
      const viaHeader = await sqlState(() => listCanonicalHeaders(db.migrator, FIXTURE.projectId, "passive-events", null, 1));
      expect(viaHeader).toBe("22023");
      // Alone, the malformed domain raises exactly as its header read did.
      expect(await sqlState(() => findOccupiedCanonicalDomain(db.migrator, FIXTURE.projectId, NON_IDENTITY_DOMAINS))).toBe(viaHeader);
      // The probe evaluated every domain, and still does.
      expect(await sqlState(() => readCanonicalDomainOccupancy(db.migrator, FIXTURE.projectId, NON_IDENTITY_DOMAINS, true))).toBe(viaHeader);
      // The key-only presence read never projects a row.
      const presence = await readCanonicalDomainOccupancy(db.migrator, FIXTURE.projectId, NON_IDENTITY_DOMAINS, false);
      expect(NON_IDENTITY_DOMAINS.filter((domain) => presence.get(domain) === true)).toEqual(["passive-events"]);
      // An earlier occupied domain decides, and the malformed one is never read.
      await db.migrator.query({
        text: "INSERT INTO lcm.conversations (project_id, session_id, created_at, updated_at) VALUES ($1, 'fusion-earlier', $2, $2)",
        values: [FIXTURE.projectId, FIXTURE.timestamp],
      }, context);
      expect(await findOccupiedCanonicalDomain(db.migrator, FIXTURE.projectId, NON_IDENTITY_DOMAINS)).toBe("conversations");
    });
  }, 120_000);

  it("ends a walk on its last page, including an exact multiple of the page size and an empty domain, without reading the row after a page", async () => {
    await withPostgreSqlTestDatabase("fusion-page-sentinel", async (db) => {
      await seedPortablePostgreSql(db.migrator, { identityOnly: true });
      expect(await listCanonicalHeaders(db.migrator, FIXTURE.projectId, "passive-events", null, 2)).toEqual({ headers: [], more: false });
      for (const sequence of [1, 2, 3, 4]) await insertPassiveEvent(db, sequence, VALID_PAYLOAD);
      const first = await listCanonicalHeaders(db.migrator, FIXTURE.projectId, "passive-events", null, 2);
      expect(first.headers.map(({ locator }) => locator)).toEqual(['["1"]', '["2"]']);
      expect(first.more).toBe(true);
      const second = await listCanonicalHeaders(db.migrator, FIXTURE.projectId, "passive-events", '["2"]', 2);
      expect(second.headers.map(({ locator }) => locator)).toEqual(['["3"]', '["4"]']);
      expect(second.more).toBe(false);
      // A malformed row right after a page: the page read succeeds and says a
      // row follows; reading that row raises, as the next page did before.
      await db.migrator.query({ text: "ALTER TABLE lcm.passive_event_inbox DROP CONSTRAINT passive_event_inbox_payload_check" }, context);
      await insertPassiveEvent(db, 5, RAISING_PAYLOAD);
      const beforeMalformed = await listCanonicalHeaders(db.migrator, FIXTURE.projectId, "passive-events", '["2"]', 2);
      expect(beforeMalformed).toMatchObject({ more: true });
      expect(await sqlState(() => listCanonicalHeaders(db.migrator, FIXTURE.projectId, "passive-events", '["4"]', 2))).toBe("22023");
    });
  }, 120_000);
});

type CopyHarness = Readonly<{
  source: Awaited<ReturnType<typeof createPortableRecordStream>>;
  destination: Awaited<ReturnType<typeof copy.openMigrationCopyDestination>>;
}>;

async function openCopy(
  sourceDb: PostgreSqlTestDatabase, targetDb: PostgreSqlTestDatabase,
  withSourceAuthority: <T>(operation: (reauthenticate: () => Promise<void>) => Promise<T>) => Promise<T>,
): Promise<CopyHarness> {
  const seeded = await seedPortablePostgreSql(sourceDb.migrator);
  await seedPortablePostgreSql(targetDb.migrator, { identityOnly: true });
  await grantPortablePostgreSql(sourceDb);
  await grantPortablePostgreSql(targetDb, { transfer: true });
  const source = await createPortableRecordStream(await createPostgreSqlPortableSource({
    settings: settings(sourceDb.runtimeUrl), expectedOwner: EXPECTED_OWNER, expectedIdentity: seeded.expectedIdentity,
  }));
  try {
    const destination = await copy.openMigrationCopyDestination({
      settings: settings(targetDb.runtimeUrl), expectedOwner: EXPECTED_OWNER, expectedIdentity: seeded.expectedIdentity,
      generationId: "fusion-generation", runId: "fusion-run", source, ownerProcessId: "fusion-owner",
      leaseTtlMs: 300000, maximumTransactionAttempts: 3, withSourceAuthority,
    });
    return { source, destination };
  } catch (error) {
    await source.close();
    throw error;
  }
}

async function batchRows(db: PostgreSqlTestDatabase): Promise<unknown> {
  return (await db.migrator.query({ text: "SELECT pg_catalog.count(*)::int AS batches FROM lcm.transfer_batches" }, context)).rows;
}

/**
 * A refusal raised inside the copy destination's guarded transaction, as its
 * caller receives it: the runtime's transaction wrapper normalizes the
 * transfer error into its own storage error, with no SQLSTATE because no
 * statement failed. Undoing the identity change then lets the same batch
 * apply, which ties the refusal to the identity re-read.
 */
const GUARDED_REFUSAL = { code: "STORAGE_OPERATION_FAILED", operation: "migrationCopy", sqlState: null, retryable: false } as const;
const LINKED_MACHINE_ID = "01990000-0000-7000-8000-0000000018a9";

describe("identity is re-read by every guarded batch (#1869)", () => {
  it.each([
    ["inserts an alias",
      ["INSERT INTO lcm.project_aliases (project_id, machine_id, path, normalized_path, linked_at) VALUES ('" + FIXTURE.projectId + "', '" + FIXTURE.machineId + "', '/fusion-extra', '/fusion-extra', '" + FIXTURE.timestamp + "')"],
      ["DELETE FROM lcm.project_aliases WHERE machine_id = '" + FIXTURE.machineId + "' AND normalized_path = '/fusion-extra'"]],
    ["changes an alias path",
      ["UPDATE lcm.project_aliases SET path = '/portable-worktree/' WHERE project_id = '" + FIXTURE.projectId + "' AND normalized_path = '/portable-worktree'"],
      ["UPDATE lcm.project_aliases SET path = '/portable-worktree' WHERE project_id = '" + FIXTURE.projectId + "' AND normalized_path = '/portable-worktree'"]],
    ["links a new machine",
      [
        "INSERT INTO lcm.machines (machine_id, identity_key, display_name, registered_at, last_seen_at) VALUES ('" + LINKED_MACHINE_ID + "', 'machine:" + "e".repeat(64) + "', NULL, '" + FIXTURE.timestamp + "', '" + FIXTURE.timestamp + "')",
        "INSERT INTO lcm.project_aliases (project_id, machine_id, path, normalized_path, linked_at) VALUES ('" + FIXTURE.projectId + "', '" + LINKED_MACHINE_ID + "', '/fusion-machine', '/fusion-machine', '" + FIXTURE.timestamp + "')",
      ],
      ["DELETE FROM lcm.project_aliases WHERE machine_id = '" + LINKED_MACHINE_ID + "'", "DELETE FROM lcm.machines WHERE machine_id = '" + LINKED_MACHINE_ID + "'"]],
  ] as const)("refuses a batch after an identity change that %s, writing no batch", async (_label, statements, undo) => {
    await withPostgreSqlTestDatabase("fusion-identity-source", async (sourceDb) => withPostgreSqlTestDatabase("fusion-identity-target", async (targetDb) => {
      let mutate = false;
      const harness = await openCopy(sourceDb, targetDb, async (operation) => {
        if (mutate) {
          mutate = false;
          for (const text of statements) await targetDb.migrator.query({ text }, context);
        }
        return operation(async () => {});
      });
      try {
        await harness.destination.admit(false);
        const first = await harness.source.readBatch({ domain: "machines", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
        mutate = true;
        await expect(harness.destination.applyBatch(first)).rejects.toMatchObject(GUARDED_REFUSAL);
        expect(await batchRows(targetDb)).toEqual([{ batches: 0 }]);
        for (const text of undo) await targetDb.migrator.query({ text }, context);
        await harness.destination.applyBatch(first);
        expect(await batchRows(targetDb)).toEqual([{ batches: 1 }]);
      } finally {
        await harness.destination.close();
        await harness.source.close();
      }
    }));
  }, 180_000);

  it("refuses an identity change committed while the batch waits for its lease fence", async () => {
    await withPostgreSqlTestDatabase("fusion-lock-source", async (sourceDb) => withPostgreSqlTestDatabase("fusion-lock-target", async (targetDb) => {
      let hold = false;
      let waited = false;
      const competing = new PostgreSqlRuntime(settings(targetDb.migratorUrl));
      const harness = await openCopy(sourceDb, targetDb, async (operation) => {
        if (!hold) return operation(async () => {});
        hold = false;
        let locked!: () => void;
        let commit!: () => void;
        let holder = 0;
        const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
        const commitPromise = new Promise<void>((resolve) => { commit = resolve; });
        const holding = competing.transaction(async (executor) => {
          holder = (await executor.query<{ pid: number }>({ text: "SELECT pg_catalog.pg_backend_pid() AS pid" }, { ...context, projectId: FIXTURE.projectId })).rows[0]!.pid;
          await executor.query({
            text: "SELECT 1 FROM lcm.fenced_leases WHERE project_id = $1 AND resource_type = 'migration-copy' AND resource_key = 'copy' FOR UPDATE",
            values: [FIXTURE.projectId],
          }, { ...context, projectId: FIXTURE.projectId });
          locked();
          await commitPromise;
          await executor.query({
            text: "INSERT INTO lcm.project_aliases (project_id, machine_id, path, normalized_path, linked_at) VALUES ($1, $2, '/fusion-late', '/fusion-late', $3)",
            values: [FIXTURE.projectId, FIXTURE.machineId, FIXTURE.timestamp],
          }, { ...context, projectId: FIXTURE.projectId });
        }, { ...context, projectId: FIXTURE.projectId, transactionMode: "read-committed-read-write" });
        await lockedPromise;
        const outcome = operation(async () => {}).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
        // The batch transaction is parked on the lease row before the change
        // commits. pg_locks is readable by every role, unlike another role's
        // wait columns in pg_stat_activity, and only the batch waits on the holder.
        for (let attempt = 0; attempt < 200 && !waited; attempt += 1) {
          const waiting = await targetDb.migrator.query<{ waiting: boolean }>({
            text: "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE NOT granted AND $1::int = ANY (pg_catalog.pg_blocking_pids(pid))) AS waiting",
            values: [holder],
          }, context);
          waited = waiting.rows[0]!.waiting === true;
          if (!waited) await pause(50);
        }
        commit();
        await holding;
        const result = await outcome;
        if (!result.ok) throw result.error;
        return result.value;
      });
      try {
        await harness.destination.admit(false);
        const first = await harness.source.readBatch({ domain: "machines", maxRecords: 1, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
        hold = true;
        await expect(harness.destination.applyBatch(first)).rejects.toMatchObject(GUARDED_REFUSAL);
        expect(waited).toBe(true);
        expect(await batchRows(targetDb)).toEqual([{ batches: 0 }]);
        await targetDb.migrator.query({ text: "DELETE FROM lcm.project_aliases WHERE machine_id = $1 AND normalized_path = '/fusion-late'", values: [FIXTURE.machineId] }, context);
        await harness.destination.applyBatch(first);
        expect(await batchRows(targetDb)).toEqual([{ batches: 1 }]);
      } finally {
        await harness.destination.close();
        await harness.source.close();
        await competing.close();
      }
    }));
  }, 180_000);
});
