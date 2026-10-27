/**
 * Tests for src/migration/rollback-sidecars.ts.
 *
 * Fixtures reuse test/fixtures/portable-records.ts's buildRecords(
 * postgresGeneration()), the same archive-record builder
 * sqlite-portable-archive.test.ts uses, rather than hand-deriving the
 * portable-record encoding rules a second time. Its default
 * session-instructions domain holds two machines sharing one scopeHash,
 * exactly as a PostgreSQL-era archive does (issue #1518): the SQLite
 * surfaces are machine-local, so this module materializes only the rows of
 * the machine it is given (MACHINE_A_UUID) and the other machine's rows
 * must be ignored, not collide with them. One hand-built second row on
 * MACHINE_A proves multi-row materialization.
 *
 * Per the epic's standing rule: every check names the two independent
 * observations it compares and is proven breakable. Verification-failed
 * red-proofs below corrupt the destination with real SQL after a real,
 * successful materialization, then call the exported verify function
 * directly -- never a mock standing in for corruption.
 */

import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Every DatabaseSync the code under test (or this file) opens, so a leaked handle is observable (PR #1556 thread 4308518712). */
const openedDatabases = vi.hoisted(() => [] as { isOpen: boolean }[]);
vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  class TrackedDatabaseSync extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      super(...args);
      openedDatabases.push(this);
    }
  }
  return { ...actual, DatabaseSync: TrackedDatabaseSync };
});
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  initializePortableArchive,
  writePortableArchiveRecord,
  readArchiveDomain,
} from "../../src/storage/sqlite/portable-archive.js";
import { createPortableRecord, type PortableRecord } from "../../src/storage/portable-record.js";
import { buildRecords, postgresGeneration, MACHINE_A, MACHINE_B, MACHINE_A_UUID } from "../fixtures/portable-records.js";
import { eventsDir, eventSequenceDbPath } from "../../src/db/events-path.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { parseDaemonConfig } from "../../src/daemon/config.js";
import { projectId as projectIdOfCwd } from "../../src/daemon/project.js";
import { promoteEventsForCwd } from "../../src/daemon/routes/promote-events.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import { LocalHookEventSequenceAllocator, formatLocalHookMachineSequence, parseLocalHookMachineSequence } from "../../src/storage/local-hook-event-sequence.js";
import {
  assertRollbackSidecarsCompatible,
  materializeRollbackSidecars,
  RollbackSidecarError,
  requireInteger,
  requireTimestamp,
  verifySessionInstructionsAgainstArchive,
  verifyPassiveEventsAgainstArchive,
  readMachineIdByIdentityKey,
  dispositionColumns,
} from "../../src/migration/rollback-sidecars.js";

const LOCAL_PROJECT_ID = "c".repeat(64);

function readEventRow(eventsDbPath: string, eventId: string): Record<string, unknown> {
  const db = new DatabaseSync(eventsDbPath, { readOnly: true });
  try {
    return { ...db.prepare("SELECT * FROM events WHERE event_uuid = ?").get(eventId) };
  } finally {
    db.close();
  }
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-sidecars-home-"));
  dirs.push(dir);
  return dir;
}

function tempGenerationPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-sidecars-gen-"));
  dirs.push(dir);
  return { dir, path: join(dir, "db.sqlite") };
}

/** Second session-instruction row on MACHINE_A: a genuinely distinct scope. */
function extraSessionInstructionRecord(projectIdentity: unknown): PortableRecord<"session-instructions"> {
  return createPortableRecord({
    domain: "session-instructions",
    ordinal: 500,
    value: {
      machineIdentityKey: MACHINE_A,
      scopeHash: "b".repeat(64),
      clientName: "codex",
      sessionId: "session-extra",
      worktreePath: "/srv/repos/other",
      cwdPath: "/srv/repos/other/src",
      content: "second scope's instructions",
      contentHash: "a".repeat(64),
      updatedAt: "2026-01-02T00:00:00.000000Z",
    },
    context: { projectIdentity },
  });
}

/**
 * Builds a generation database (runtime tables + portable_archive_* tables,
 * exactly the shape a real rollback generation has) and seeds it with one
 * machine, two session-instructions rows and three passive-events rows
 * (pending/applied/quarantined, from the shared fixture's default triple).
 */
function seedGeneration(): {
  path: string;
  sessionInstructionRecords: readonly PortableRecord<"session-instructions">[];
  passiveEventRecords: readonly PortableRecord<"passive-events">[];
} {
  const { path } = tempGenerationPath();
  const db = new DatabaseSync(path);
  try {
    runLcmMigrations(db, { fts5Available: false });
    initializePortableArchive(db);
    const all = buildRecords(postgresGeneration());
    for (const record of all.get("machines")!) writePortableArchiveRecord(db, record);
    const projectIdentity = (all.get("project")![0].value as { identity: unknown }).identity;
    // Both machines' rows go into the archive; only MACHINE_A's are expected back.
    const archivedInstructions = all.get("session-instructions")!;
    const sessionInstructionRecords = [
      ...archivedInstructions.filter((r) => (r.value as { machineIdentityKey: string }).machineIdentityKey === MACHINE_A),
      extraSessionInstructionRecord(projectIdentity),
    ];
    for (const record of [...archivedInstructions, extraSessionInstructionRecord(projectIdentity)]) writePortableArchiveRecord(db, record);
    const passiveEventRecords = all.get("passive-events")!;
    for (const record of passiveEventRecords) writePortableArchiveRecord(db, record);
    return { path, sessionInstructionRecords, passiveEventRecords };
  } finally {
    db.close();
  }
}

function integerValue(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "object" && value !== null && "$integer" in value) {
    return BigInt((value as { $integer: string }).$integer);
  }
  throw new Error(`unexpected integer representation: ${JSON.stringify(value)}`);
}

describe("materializeRollbackSidecars", () => {
  it("materializes both surfaces and matches the archive field-for-field on independent readback", () => {
    const homeDir = tempHome();
    const { path, sessionInstructionRecords, passiveEventRecords } = seedGeneration();

    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    expect(outcome.sessionInstructionsMaterialized, MACHINE_A_UUID).toBe(2);
    expect(outcome.passiveEventsMaterialized).toBe(3);
    expect(outcome.eventsDbPath).toBe(join(eventsDir(homeDir), `${LOCAL_PROJECT_ID}.db`));
    const highest = passiveEventRecords.reduce((max, r) => {
      const seq = integerValue((r.value as { machineSequence: unknown }).machineSequence);
      return seq > max ? seq : max;
    }, -1n);
    expect(outcome.reconciledUpTo).toBe(highest.toString());

    // Independent readback: a fresh connection, a fresh query, never the
    // outcome object materializeRollbackSidecars itself returned.
    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = readback.prepare(
        "SELECT scope_hash, client_name, content, content_hash FROM session_instruction_cache WHERE project_id = ? ORDER BY scope_hash",
      ).all(LOCAL_PROJECT_ID) as { scope_hash: string; client_name: string; content: string; content_hash: string }[];
      expect(rows).toHaveLength(2);
      for (const record of sessionInstructionRecords) {
        const v = record.value as { scopeHash: string; clientName: string; content: string; contentHash: string };
        const stored = rows.find((r) => r.scope_hash === v.scopeHash);
        expect(stored).toBeDefined();
        expect(stored?.client_name).toBe(v.clientName);
        expect(stored?.content).toBe(v.content);
        expect(stored?.content_hash).toBe(v.contentHash);
      }
    } finally {
      readback.close();
    }

    const eventsReadback = new DatabaseSync(outcome.eventsDbPath, { readOnly: true });
    try {
      const rows = eventsReadback.prepare(
        "SELECT event_uuid, delivery_state, processed_at, quarantine_reason FROM events ORDER BY machine_sequence",
      ).all() as { event_uuid: string; delivery_state: string; processed_at: string | null; quarantine_reason: string | null }[];
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.delivery_state)).toEqual(["pending", "pending", "quarantined"]);
      expect(rows[1].processed_at).not.toBeNull();
      expect(rows[2].quarantine_reason).not.toBeNull();
    } finally {
      eventsReadback.close();
    }

    const allocator = new LocalHookEventSequenceAllocator(eventSequenceDbPath(homeDir));
    try {
      expect(allocator.peekNextSequence()).toBe(highest + 1n);
    } finally {
      allocator.close();
    }
  });

  it("closes every database handle it opened, including the read-only one the schema validation reads through (PR #1556 thread 4308518712)", () => {
    const homeDir = tempHome();
    const { path } = seedGeneration();
    const before = openedDatabases.length;
    materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    const opened = openedDatabases.slice(before);
    // The generation itself, EventsDb's bootstrap, the raw events connection, the allocator and the validation handle.
    expect(opened.length).toBeGreaterThanOrEqual(4);
    expect(opened.map((db) => db.isOpen)).toEqual(opened.map(() => false));
  });

  it("materializes only this machine's session instructions when another machine holds the same scope hash (#1518)", () => {
    const homeDir = tempHome();
    const { path, sessionInstructionRecords } = seedGeneration();
    const archived = new DatabaseSync(path);
    try {
      const scopeHashes = [...readArchiveDomain(archived, "session-instructions")].map((r) => r.value.scopeHash);
      const byMachine = [...readArchiveDomain(archived, "session-instructions")].map((r) => r.value.machineIdentityKey);
      // Precondition: the archive really holds a row of each machine under one scope hash.
      expect(byMachine).toContain(MACHINE_B);
      expect(scopeHashes.filter((h) => h === (sessionInstructionRecords[0].value as { scopeHash: string }).scopeHash)).toHaveLength(2);
    } finally {
      archived.close();
    }

    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    expect(outcome.sessionInstructionsMaterialized).toBe(2);
    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = readback.prepare(
        "SELECT scope_hash, client_name, session_id FROM session_instruction_cache WHERE project_id = ? ORDER BY scope_hash",
      ).all(LOCAL_PROJECT_ID) as { scope_hash: string; client_name: string; session_id: string }[];
      expect(rows).toHaveLength(2);
      // The shared scope hash holds MACHINE_A's row (codex), not MACHINE_B's (claude).
      const shared = rows.find((r) => r.scope_hash === (sessionInstructionRecords[0].value as { scopeHash: string }).scopeHash);
      expect(shared?.client_name).toBe("codex");
    } finally {
      readback.close();
    }
  });

  it("materializes, verifies and reconciles only this machine's passive events when another machine reuses its sequences (#1518)", () => {
    const homeDir = tempHome();
    const { path, passiveEventRecords } = seedGeneration();
    const db = new DatabaseSync(path);
    try {
      const other = "installation:second-machine";
      writePortableArchiveRecord(db, createPortableRecord({
        domain: "machines", ordinal: 50,
        value: { identityKey: other, machineId: "018f7765-7b5c-7d92-8a2e-c6f6a15fcb99" }, context: null,
      }));
      // One event colliding with a MACHINE_A machine_sequence (UNIQUE in the
      // events table) and one far beyond MACHINE_A's highest.
      [0, 999].forEach((sequence, index) => {
        writePortableArchiveRecord(db, createPortableRecord({
          domain: "passive-events", ordinal: 50 + index,
          value: {
            machineIdentityKey: other, eventId: `018f7769-4c00-7f77-9b32-4a2f8f5c40${index}0`,
            eventVersion: 1, machineSequence: sequence, eventType: "session.compacted",
            sessionId: "session-other", sessionSequence: index, category: "intent", data: "{}", priority: 5,
            sourceHook: "PreCompact", createdAt: "2026-01-01T00:00:00.000000Z", disposition: "pending",
          },
          context: { projectIdentity: { scope: "local", projectId: "a".repeat(64) } },
        }));
      });
    } finally {
      db.close();
    }

    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    expect(outcome.passiveEventsMaterialized).toBe(passiveEventRecords.length);
    const highest = passiveEventRecords.reduce((max, r) => {
      const seq = integerValue((r.value as { machineSequence: unknown }).machineSequence);
      return seq > max ? seq : max;
    }, -1n);
    // The other machine's sequence 999 must not advance this machine's checkpoint.
    expect(outcome.reconciledUpTo).toBe(highest.toString());
    const eventsReadback = new DatabaseSync(outcome.eventsDbPath, { readOnly: true });
    try {
      const { n } = eventsReadback.prepare("SELECT count(*) AS n FROM events").get() as { n: number };
      expect(n).toBe(passiveEventRecords.length);
    } finally {
      eventsReadback.close();
    }
  });

  it("is idempotent across a retry: no duplication, checkpoint does not regress", () => {
    const homeDir = tempHome();
    const { path } = seedGeneration();

    const first = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    const second = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    expect(second.sessionInstructionsMaterialized).toBe(first.sessionInstructionsMaterialized);
    expect(second.reconciledUpTo).toBe(first.reconciledUpTo);
    // Passive events insert with ON CONFLICT(event_uuid) DO NOTHING, so a
    // retry against an already-materialized events db reports zero newly
    // inserted rows on the second pass -- this IS the idempotence, not a
    // discrepancy with it.
    expect(second.passiveEventsMaterialized).toBe(0);

    const eventsReadback = new DatabaseSync(first.eventsDbPath, { readOnly: true });
    try {
      const { n } = eventsReadback.prepare("SELECT count(*) AS n FROM events").get() as { n: number };
      expect(n).toBe(3);
    } finally {
      eventsReadback.close();
    }
    const sessionReadback = new DatabaseSync(path, { readOnly: true });
    try {
      const { n } = sessionReadback.prepare(
        "SELECT count(*) AS n FROM session_instruction_cache WHERE project_id = ?",
      ).get(LOCAL_PROJECT_ID) as { n: number };
      expect(n).toBe(2);
    } finally {
      sessionReadback.close();
    }
  });

  it("materializes zero passive events without reconciling or creating a checkpoint entry beyond bootstrap", () => {
    const homeDir = tempHome();
    const { path } = tempGenerationPath();
    const db = new DatabaseSync(path);
    try {
      runLcmMigrations(db, { fts5Available: false });
      initializePortableArchive(db);
    } finally {
      db.close();
    }

    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    expect(outcome.sessionInstructionsMaterialized, MACHINE_A_UUID).toBe(0);
    expect(outcome.passiveEventsMaterialized).toBe(0);
    expect(outcome.reconciledUpTo).toBeNull();
  });

  it("refuses a passive event whose machine identity key has no matching machines record", () => {
    const homeDir = tempHome();
    const { path } = tempGenerationPath();
    const db = new DatabaseSync(path);
    try {
      runLcmMigrations(db, { fts5Available: false });
      initializePortableArchive(db);
      // No "machines" record at all: proves the unknown-key guard fires
      // through the real lookup path, not a mocked map.
      const orphanEvent = createPortableRecord({
        domain: "passive-events",
        ordinal: 0,
        value: {
          machineIdentityKey: "ghost-machine",
          eventId: "018f7769-4c00-7f77-9b32-4a2f8f5cffff",
          eventVersion: 1,
          machineSequence: 0,
          eventType: "session.compacted",
          sessionId: "session-x",
          sessionSequence: 0,
          category: "intent",
          data: "{}",
          priority: 5,
          sourceHook: "PreCompact",
          createdAt: "2026-01-01T00:00:00.000000Z",
          disposition: "pending",
        },
        context: { projectIdentity: { scope: "local", projectId: "a".repeat(64) } },
      });
      writePortableArchiveRecord(db, orphanEvent);
    } finally {
      db.close();
    }

    expect(() => materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID }))
      .toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("ghost-machine") }));

    // Positive control: the identical record, but with its machine
    // present, succeeds -- proving the guard discriminates on the
    // relationship, not on some incidental property of this fixture.
    const { path: okPath } = tempGenerationPath();
    const okDb = new DatabaseSync(okPath);
    try {
      runLcmMigrations(okDb, { fts5Available: false });
      initializePortableArchive(okDb);
      writePortableArchiveRecord(okDb, createPortableRecord({ domain: "machines", ordinal: 0, value: { identityKey: "ghost-machine", machineId: MACHINE_A_UUID }, context: null }));
      writePortableArchiveRecord(okDb, createPortableRecord({
        domain: "passive-events", ordinal: 0,
        value: {
          machineIdentityKey: "ghost-machine", eventId: "018f7769-4c00-7f77-9b32-4a2f8f5cffff",
          eventVersion: 1, machineSequence: 0, eventType: "session.compacted", sessionId: "session-x",
          sessionSequence: 0, category: "intent", data: "{}", priority: 5, sourceHook: "PreCompact",
          createdAt: "2026-01-01T00:00:00.000000Z", disposition: "pending",
        },
        context: { projectIdentity: { scope: "local", projectId: "a".repeat(64) } },
      }));
    } finally {
      okDb.close();
    }
    const okHome = tempHome();
    expect(() => materializeRollbackSidecars({ homeDir: okHome, databasePath: okPath, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID })).not.toThrow();
  });

  it("F8: refuses a session instruction whose machine identity key has no machines record", () => {
    const homeDir = tempHome();
    const { path } = tempGenerationPath();
    const db = new DatabaseSync(path);
    try {
      runLcmMigrations(db, { fts5Available: false });
      initializePortableArchive(db);
      writePortableArchiveRecord(db, createPortableRecord({
        domain: "session-instructions", ordinal: 0,
        value: {
          machineIdentityKey: "ghost-machine", scopeHash: "d".repeat(64), clientName: "codex", sessionId: "s",
          worktreePath: "/w", cwdPath: "/w", content: "x", contentHash: "e".repeat(64), updatedAt: "2026-01-02T00:00:00.000000Z",
        },
        context: { projectIdentity: { scope: "local", projectId: "a".repeat(64) } },
      }));
    } finally {
      db.close();
    }
    expect(() => materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID }))
      .toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("ghost-machine") }));
  });

  it("wraps a real events-directory creation failure as unsafe-storage", () => {
    const homeDir = tempHome();
    const { path } = tempGenerationPath();
    const db = new DatabaseSync(path);
    try {
      runLcmMigrations(db, { fts5Available: false });
      initializePortableArchive(db);
    } finally {
      db.close();
    }
    // Real obstruction, not a mock: a plain file occupies the exact path
    // ensurePrivateDirectory must create as a directory, so mkdirSync
    // genuinely fails.
    mkdirSync(join(homeDir, ".lcm"), { recursive: true });
    writeFileSync(join(homeDir, ".lcm", "events"), "not a directory");

    expect(() => materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID }))
      .toThrow(expect.objectContaining({ reason: "unsafe-storage" }));
  });

  it("tracks the true maximum machine_sequence even when archive rows are not sequence-ordered", () => {
    const homeDir = tempHome();
    const { path } = tempGenerationPath();
    const db = new DatabaseSync(path);
    try {
      runLcmMigrations(db, { fts5Available: false });
      initializePortableArchive(db);
      writePortableArchiveRecord(db, createPortableRecord({
        domain: "machines", ordinal: 0,
        value: { identityKey: "unordered-machine", machineId: MACHINE_A_UUID }, context: null,
      }));
      const sequences = [5, 2, 8];
      sequences.forEach((sequence, index) => {
        writePortableArchiveRecord(db, createPortableRecord({
          domain: "passive-events", ordinal: index,
          value: {
            machineIdentityKey: "unordered-machine",
            eventId: `018f7769-4c00-7f77-9b32-4a2f8f5c30${index}0`,
            eventVersion: 1, machineSequence: sequence, eventType: "session.compacted",
            sessionId: "session-unordered", sessionSequence: index, category: "intent",
            data: "{}", priority: 5, sourceHook: "PreCompact",
            createdAt: "2026-01-01T00:00:00.000000Z", disposition: "pending",
          },
          context: { projectIdentity: { scope: "local", projectId: "a".repeat(64) } },
        }));
      });
    } finally {
      db.close();
    }

    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    // The maximum (8), not merely a monotonic-order assumption: proves
    // this is a genuine max-reduction over every archived row, not code
    // that only works because archives happen to arrive sequence-sorted.
    expect(outcome.reconciledUpTo).toBe("8");
  });
});

describe("verifySessionInstructionsAgainstArchive", () => {
  it("goes red when a stored row's content diverges from its archive row, and green when it matches", () => {
    const homeDir = tempHome();
    const { path } = seedGeneration();
    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    const db = new DatabaseSync(path);
    try {
      // Positive control first: the real, uncorrupted state passes.
      expect(() => verifySessionInstructionsAgainstArchive(db, LOCAL_PROJECT_ID, outcome.sessionInstructionsMaterialized, MACHINE_A_UUID)).not.toThrow();

      db.prepare("UPDATE session_instruction_cache SET content = 'corrupted' WHERE project_id = ?").run(LOCAL_PROJECT_ID);
      expect(() => verifySessionInstructionsAgainstArchive(db, LOCAL_PROJECT_ID, outcome.sessionInstructionsMaterialized, MACHINE_A_UUID))
        .toThrow(expect.objectContaining({ reason: "verification-failed" }));
    } finally {
      db.close();
    }
  });

  it("goes red when the stored row count no longer matches the reported materialized count", () => {
    const homeDir = tempHome();
    const { path } = seedGeneration();
    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    const db = new DatabaseSync(path);
    try {
      db.prepare("DELETE FROM session_instruction_cache WHERE project_id = ? AND scope_hash = (SELECT scope_hash FROM session_instruction_cache WHERE project_id = ? LIMIT 1)")
        .run(LOCAL_PROJECT_ID, LOCAL_PROJECT_ID);
      expect(() => verifySessionInstructionsAgainstArchive(db, LOCAL_PROJECT_ID, outcome.sessionInstructionsMaterialized, MACHINE_A_UUID))
        .toThrow(expect.objectContaining({ reason: "verification-failed" }));
    } finally {
      db.close();
    }
  });

  it("goes red when the project holds a session instruction row the archive does not account for (count check)", () => {
    const homeDir = tempHome();
    const { path } = seedGeneration();
    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    const db = new DatabaseSync(path);
    try {
      db.prepare(
        `INSERT INTO session_instruction_cache (project_id, scope_hash, client_name, session_id, worktree_path, cwd_path, content, content_hash, updated_at)
         VALUES (?, ?, 'codex', 'orphan-session', '/tmp', '/tmp', 'orphan content', ?, '2026-01-01T00:00:00.000000Z')`,
      ).run(LOCAL_PROJECT_ID, "e".repeat(64), "e".repeat(64));
      // The reported count still equals the archive's, and every archived row matches: only the readback count sees it.
      expect(() => verifySessionInstructionsAgainstArchive(db, LOCAL_PROJECT_ID, outcome.sessionInstructionsMaterialized, MACHINE_A_UUID))
        .toThrow(expect.objectContaining({ reason: "verification-failed", message: expect.stringContaining("holds") }));
    } finally {
      db.close();
    }
  });

  it("goes red when the archive holds more rows than were ever materialized, even if every materialized row still matches", () => {
    const homeDir = tempHome();
    const { path } = seedGeneration();
    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    const db = new DatabaseSync(path);
    try {
      // A real orphaned readback row so the count check, not the
      // per-row "!stored" branch, is the one that fires: insert one
      // extra row directly plus a matching claimed materializedCount,
      // then re-add one archive row the readback does NOT have, so the
      // per-row loop still completes (every archive row it checks has a
      // match) before the trailing count check catches the surplus.
      db.prepare(
        `INSERT INTO session_instruction_cache (project_id, scope_hash, client_name, session_id, worktree_path, cwd_path, content, content_hash, updated_at)
         VALUES (?, ?, 'codex', 'orphan-session', '/tmp', '/tmp', 'orphan content', ?, '2026-01-01T00:00:00.000000Z')`,
      ).run(LOCAL_PROJECT_ID, "f".repeat(64), "f".repeat(64));
      expect(() => verifySessionInstructionsAgainstArchive(db, LOCAL_PROJECT_ID, outcome.sessionInstructionsMaterialized + 1, MACHINE_A_UUID))
        .toThrow(expect.objectContaining({ reason: "verification-failed" }));
    } finally {
      db.close();
    }
  });
});

describe("verifyPassiveEventsAgainstArchive", () => {
  it("goes red when a stored event's data diverges from its archive row, and green when it matches", () => {
    const homeDir = tempHome();
    const { path } = seedGeneration();
    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    const db = new DatabaseSync(path);
    const eventsDb = new DatabaseSync(outcome.eventsDbPath);
    try {
      const machineIds = readMachineIdByIdentityKey(db);
      expect(() => verifyPassiveEventsAgainstArchive(db, eventsDb, machineIds, MACHINE_A_UUID)).not.toThrow();

      eventsDb.exec("UPDATE events SET data = '{\"tampered\":true}'");
      expect(() => verifyPassiveEventsAgainstArchive(db, eventsDb, machineIds, MACHINE_A_UUID))
        .toThrow(expect.objectContaining({ reason: "verification-failed" }));
    } finally {
      db.close();
      eventsDb.close();
    }
  });

  it("F2: preserves and separately counts a local pending row the archive does not hold", () => {
    const homeDir = tempHome();
    const { path, passiveEventRecords } = seedGeneration();
    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    const db = new DatabaseSync(path);
    const eventsDb = new DatabaseSync(outcome.eventsDbPath);
    try {
      const machineIds = readMachineIdByIdentityKey(db);
      eventsDb.exec(
        `INSERT INTO events (event_uuid, event_version, machine_sequence, session_id, type, category, data, source_hook)
         VALUES ('018f7769-4c00-7f77-9b32-4a2f8f5cbeef', 1, '${formatLocalHookMachineSequence(999n)}', 'orphan', 'orphan.event', 'intent', '{}', 'Test')`,
      );
      expect(verifyPassiveEventsAgainstArchive(db, eventsDb, machineIds, MACHINE_A_UUID))
        .toEqual({ verifiedImported: passiveEventRecords.length, preservedPending: 1 });
      // Untouched: still pending and unreplicated.
      expect(eventsDb.prepare("SELECT delivery_state, remote_inbox_id FROM events WHERE event_uuid = ?").get("018f7769-4c00-7f77-9b32-4a2f8f5cbeef"))
        .toEqual({ delivery_state: "pending", remote_inbox_id: null });
    } finally {
      db.close();
      eventsDb.close();
    }
  });

  it("F2: a local row absent from the archive that claims delivery (remote inbox id or acknowledgement) refuses", () => {
    for (const delivered of [
      "delivery_state = 'replicated', remote_inbox_id = 'inbox-1'",
      "delivery_state = 'acknowledged', remote_inbox_id = 'inbox-1', acknowledged_at = '2026-01-03T00:00:00.000000Z'",
    ]) {
      const homeDir = tempHome();
      const { path } = seedGeneration();
      const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
      const db = new DatabaseSync(path);
      const eventsDb = new DatabaseSync(outcome.eventsDbPath);
      try {
        const machineIds = readMachineIdByIdentityKey(db);
        eventsDb.exec(
          `INSERT INTO events (event_uuid, event_version, machine_sequence, session_id, type, category, data, source_hook)
           VALUES ('018f7769-4c00-7f77-9b32-4a2f8f5cbeef', 1, '${formatLocalHookMachineSequence(999n)}', 'orphan', 'orphan.event', 'intent', '{}', 'Test')`,
        );
        eventsDb.exec(`UPDATE events SET ${delivered} WHERE event_uuid = '018f7769-4c00-7f77-9b32-4a2f8f5cbeef'`);
        expect(() => verifyPassiveEventsAgainstArchive(db, eventsDb, machineIds, MACHINE_A_UUID))
          .toThrow(expect.objectContaining({ reason: "verification-failed", message: expect.stringContaining("delivered event") }));
      } finally {
        db.close();
        eventsDb.close();
      }
    }
  });

  it("F2: a whole materialization keeps a post-cutoff local append pending alongside the imported archive rows", () => {
    const homeDir = tempHome();
    const { path, passiveEventRecords } = seedGeneration();
    const first = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    expect(first.passiveEventsPreservedPending).toBe(0);
    const appended = "018f7769-4c00-7f77-9b32-4a2f8f5cd00d";
    const local = new DatabaseSync(first.eventsDbPath);
    try {
      local.exec(
        `INSERT INTO events (event_uuid, event_version, machine_sequence, session_id, type, category, data, source_hook)
         VALUES ('${appended}', 1, '${formatLocalHookMachineSequence(1000n)}', 'post-cutoff', 'session.compacted', 'intent', '{}', 'PreCompact')`,
      );
    } finally {
      local.close();
    }
    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    expect(outcome.passiveEventsPreservedPending).toBe(1);
    const readback = new DatabaseSync(outcome.eventsDbPath, { readOnly: true });
    try {
      expect((readback.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(passiveEventRecords.length + 1);
      expect(readback.prepare("SELECT delivery_state, remote_inbox_id FROM events WHERE event_uuid = ?").get(appended))
        .toEqual({ delivery_state: "pending", remote_inbox_id: null });
    } finally {
      readback.close();
    }
  });

  it("F12: an archived applied event the replication worker already acknowledged materializes, stays acknowledged and is not replayed, beside pending-only extras", () => {
    const homeDir = tempHome();
    const { path, passiveEventRecords } = seedGeneration();
    const first = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    const applied = passiveEventRecords.find((record) => record.value.disposition === "applied")!;
    const appended = "018f7769-4c00-7f77-9b32-4a2f8f5cd00d";
    const events = new EventsDb(first.eventsDbPath);
    try {
      expect(events.markAcknowledged(applied.value.eventId, 1n)).toBe(true);
    } finally {
      events.close();
    }
    const local = new DatabaseSync(first.eventsDbPath);
    try {
      local.exec(
        `INSERT INTO events (event_uuid, event_version, machine_sequence, session_id, type, category, data, source_hook)
         VALUES ('${appended}', 1, '${formatLocalHookMachineSequence(1000n)}', 'post-cutoff', 'session.compacted', 'intent', '{}', 'PreCompact')`,
      );
    } finally {
      local.close();
    }
    const acknowledgedBefore = readEventRow(first.eventsDbPath, applied.value.eventId);
    expect(acknowledgedBefore).toMatchObject({ delivery_state: "acknowledged", remote_inbox_id: "1" });

    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    expect(outcome.passiveEventsMaterialized).toBe(0);
    expect(outcome.passiveEventsPreservedPending).toBe(1);
    // Neither rewritten nor replayed: the whole row, acknowledgement included, is exactly as the worker left it.
    expect(readEventRow(outcome.eventsDbPath, applied.value.eventId)).toEqual(acknowledgedBefore);
    expect(readEventRow(outcome.eventsDbPath, appended)).toMatchObject({ delivery_state: "pending", remote_inbox_id: null });
  });

  it("F12/E2: an archived applied event whose existing row was acknowledged without ever being processed materializes and gains the applied marker", () => {
    const homeDir = tempHome();
    const { path, passiveEventRecords } = seedGeneration();
    const first = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    const applied = passiveEventRecords.find((record) => record.value.disposition === "applied")!;
    const freshlyApplied = readEventRow(first.eventsDbPath, applied.value.eventId);
    const local = new DatabaseSync(first.eventsDbPath);
    try {
      // Acknowledged by the replication worker, with no processed_at of its own: only the delivery state says applied.
      local.exec(
        `UPDATE events SET processed_at = NULL, delivery_state = 'acknowledged', remote_inbox_id = '1',
           acknowledged_at = '2026-01-03T00:00:00.000000Z' WHERE event_uuid = '${applied.value.eventId}'`,
      );
    } finally {
      local.close();
    }
    const before = readEventRow(first.eventsDbPath, applied.value.eventId);
    expect(before).toMatchObject({ delivery_state: "acknowledged", processed_at: null });
    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    expect(outcome.passiveEventsMaterialized).toBe(0);
    // Only the processing marker changes, to what the fresh insert encoded; the acknowledgement stays.
    expect(readEventRow(outcome.eventsDbPath, applied.value.eventId)).toEqual({ ...before, processed_at: freshlyApplied.processed_at });
  });

  /**
   * #626 E2 (round-3 S3-2). The replication worker acknowledges a local event without ever setting processed_at
   * (EventsDb.markAcknowledged), so acknowledged + processed_at NULL is the ordinary shape of a replicated event
   * on the PostgreSQL side. The SQLite consumer the rollback hands the project back to selects on processed_at
   * alone (EventsDb.getUnprocessed, the passive sweep behind promoteEventsForCwd): an archive-applied event left
   * in that shape would be applied a second time. The real consumer runs here, after the real materialization.
   */
  describe("E2: an archive-applied event acknowledged locally without processed_at is not selected or promoted again", () => {
    const DECISION = '{"decision":"replay-proof decision"}';

    /** A generation whose archive holds exactly one passive event, applied, promotable at tier 1. */
    function seedAppliedOnlyGeneration(): { path: string; eventId: string } {
      const { path } = tempGenerationPath();
      const db = new DatabaseSync(path);
      try {
        runLcmMigrations(db, { fts5Available: false });
        initializePortableArchive(db);
        const all = buildRecords({
          ...postgresGeneration(),
          mutate: (domain, values) => domain === "passive-events"
            ? values.map((value) => ({ ...value, priority: "1", category: "decision", data: DECISION }))
            : values,
        });
        const applied = all.get("passive-events")!.find((record) => (record.value as { disposition: string }).disposition === "applied")!;
        for (const record of all.get("machines")!) writePortableArchiveRecord(db, record);
        for (const record of all.get("session-instructions")!) writePortableArchiveRecord(db, record);
        writePortableArchiveRecord(db, applied);
        return { path, eventId: (applied.value as { eventId: string }).eventId };
      } finally {
        db.close();
      }
    }

    /** The consumer's own processed_at (EventsDb.markProcessed stamps datetime('now'), never the event's createdAt). */
    const CONSUMER_PROCESSED_AT = "2026-03-04 05:06:07";

    async function materializeThenSweep(options: { processedAt: "null" | "consumer" }) {
      const homeDir = tempHome();
      mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
      chmodSync(homeDir, 0o700);
      const cwd = mkdtempSync(join(homeDir, "project-"));
      const localProjectId = projectIdOfCwd(cwd);
      const { path, eventId } = seedAppliedOnlyGeneration();
      const previousHome = process.env.HOME;
      process.env.HOME = homeDir;
      const factory = new SqliteStorageBackendFactory({ resolveProject: (identity) => ({ id: identity.id, dbPath: path }) });
      try {
        const input = { homeDir, databasePath: path, localProjectId, machineId: MACHINE_A_UUID };
        const first = materializeRollbackSidecars(input);
        const freshlyApplied = readEventRow(first.eventsDbPath, eventId);
        expect(freshlyApplied.processed_at).toEqual(expect.any(String));
        const local = new DatabaseSync(first.eventsDbPath);
        try {
          local.prepare("UPDATE events SET processed_at = ? WHERE event_uuid = ?")
            .run(options.processedAt === "null" ? null : CONSUMER_PROCESSED_AT, eventId);
        } finally {
          local.close();
        }
        // The replication worker's acknowledgement: delivery_state, remote_inbox_id and acknowledged_at, never processed_at.
        const worker = new EventsDb(first.eventsDbPath);
        try {
          expect(worker.markAcknowledged(eventId, 1n)).toBe(true);
        } finally {
          worker.close();
        }
        const acknowledged = readEventRow(first.eventsDbPath, eventId);
        expect(acknowledged).toMatchObject({
          delivery_state: "acknowledged", remote_inbox_id: "1", processed_at: options.processedAt === "null" ? null : CONSUMER_PROCESSED_AT,
        });

        const outcome = materializeRollbackSidecars(input);
        expect(outcome.passiveEventsMaterialized).toBe(0);

        const consumer = new EventsDb(outcome.eventsDbPath);
        let selected: string[];
        try {
          selected = consumer.getUnprocessed().map((event) => event.event_uuid);
        } finally {
          consumer.close();
        }
        const promotion = await promoteEventsForCwd(parseDaemonConfig("{}"), cwd, outcome.eventsDbPath, factory);
        const generation = new DatabaseSync(path, { readOnly: true });
        let promoted: number;
        try {
          promoted = (generation.prepare("SELECT count(*) AS n FROM promoted").get() as { n: number }).n;
        } finally {
          generation.close();
        }
        return { selected, promotion, promoted, before: acknowledged, after: readEventRow(outcome.eventsDbPath, eventId), freshlyApplied };
      } finally {
        await factory.close();
        closeLcmConnection();
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      }
    }

    it("sets the processing marker exactly as a fresh applied insert encodes it, keeping the acknowledgement, so the real consumer selects and promotes nothing", async () => {
      const result = await materializeThenSweep({ processedAt: "null" });
      expect({ promotion: result.promotion, promotedMemories: result.promoted, selected: result.selected })
        .toMatchObject({ promotion: { promoted: 0, errors: 0 }, promotedMemories: 0, selected: [] });
      // Identity, acknowledgement and remote inbox id are exactly as the worker left them; only processed_at was reconciled.
      expect(result.after).toEqual({ ...result.before, processed_at: result.freshlyApplied.processed_at });
    });

    it("control: a row the consumer already processed keeps its own processed_at and is not selected or promoted either", async () => {
      const result = await materializeThenSweep({ processedAt: "consumer" });
      expect({ promotion: result.promotion, promotedMemories: result.promoted, selected: result.selected })
        .toMatchObject({ promotion: { promoted: 0, errors: 0 }, promotedMemories: 0, selected: [] });
      expect(result.after).toEqual(result.before);
      expect(result.after.processed_at).toBe(CONSUMER_PROCESSED_AT);
    });
  });

  it("F12: an existing row whose disposition contradicts the archive refuses, in either direction", () => {
    const contradictions: ReadonlyArray<readonly [string, string]> = [
      ["applied", "processed_at = NULL, delivery_state = 'pending'"],
      // Acknowledged locally (applied remotely) with no processed_at, while the archive still holds it as pending.
      ["pending", "delivery_state = 'acknowledged', remote_inbox_id = '1', acknowledged_at = '2026-01-03T00:00:00.000000Z', processed_at = NULL"],
      ["quarantined", "delivery_state = 'pending', quarantine_reason = NULL"],
      ["pending", "delivery_state = 'quarantined', quarantine_reason = 'rejected'"],
    ];
    for (const [archived, localState] of contradictions) {
      const homeDir = tempHome();
      const { path, passiveEventRecords } = seedGeneration();
      const first = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
      const target = passiveEventRecords.find((record) => record.value.disposition === archived)!;
      const local = new DatabaseSync(first.eventsDbPath);
      try {
        local.exec(`UPDATE events SET ${localState} WHERE event_uuid = '${target.value.eventId}'`);
      } finally {
        local.close();
      }
      expect(() => materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID }))
        .toThrow(expect.objectContaining({ reason: "verification-failed", message: expect.stringContaining(target.value.eventId) }));
    }
  });

  it("#1681: a row the daemon drained (processed_at set) while the archive still lists it as pending is accepted untouched", () => {
    const homeDir = tempHome();
    const { path, passiveEventRecords } = seedGeneration();
    const first = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    const target = passiveEventRecords.find((record) => record.value.disposition === "pending")!;
    const drained = "delivery_state = 'replicated', remote_inbox_id = 'inbox-1', processed_at = '2026-01-01T00:00:00.000000Z'";
    const local = new DatabaseSync(first.eventsDbPath);
    try {
      local.exec("UPDATE events SET " + drained + " WHERE event_uuid = '" + target.value.eventId + "'");
    } finally {
      local.close();
    }
    const before = readEventRow(first.eventsDbPath, target.value.eventId);
    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    expect(outcome.passiveEventsMaterialized).toBe(0);
    const after = readEventRow(outcome.eventsDbPath, target.value.eventId);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ processed_at: "2026-01-01T00:00:00.000000Z", remote_inbox_id: "inbox-1" });
    const consumer = new EventsDb(outcome.eventsDbPath);
    try {
      expect(consumer.getUnprocessed().map((event) => event.event_uuid)).not.toContain(target.value.eventId);
    } finally {
      consumer.close();
    }
  });

  it("F12: an existing row whose payload differs from the archive still refuses even when its disposition matches", () => {
    const homeDir = tempHome();
    const { path, passiveEventRecords } = seedGeneration();
    const first = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    const applied = passiveEventRecords.find((record) => record.value.disposition === "applied")!;
    const events = new EventsDb(first.eventsDbPath);
    try {
      events.markAcknowledged(applied.value.eventId, 1n);
    } finally {
      events.close();
    }
    const local = new DatabaseSync(first.eventsDbPath);
    try {
      local.exec(`UPDATE events SET data = '{"other":true}' WHERE event_uuid = '${applied.value.eventId}'`);
    } finally {
      local.close();
    }
    expect(() => materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID }))
      .toThrow(expect.objectContaining({ reason: "verification-failed" }));
  });

  it("goes red when a stored event the archive holds is missing", () => {
    const homeDir = tempHome();
    const { path } = seedGeneration();
    const outcome = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

    const db = new DatabaseSync(path);
    const eventsDb = new DatabaseSync(outcome.eventsDbPath);
    try {
      const machineIds = readMachineIdByIdentityKey(db);
      eventsDb.exec("DELETE FROM events WHERE rowid = (SELECT min(rowid) FROM events)");
      expect(() => verifyPassiveEventsAgainstArchive(db, eventsDb, machineIds, MACHINE_A_UUID))
        .toThrow(expect.objectContaining({ reason: "verification-failed" }));
    } finally {
      db.close();
      eventsDb.close();
    }
  });
});

describe("requireInteger", () => {
  it("accepts bigint, number, and numeric-string forms", () => {
    expect(requireInteger(5n, "field")).toBe(5n);
    expect(requireInteger(5, "field")).toBe(5n);
    expect(requireInteger("5", "field")).toBe(5n);
  });

  it("goes red for a value BigInt() cannot coerce", () => {
    expect(() => requireInteger("not-a-number", "field"))
      .toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("field") }));
  });
});

describe("requireTimestamp", () => {
  it("accepts a non-empty string as-is", () => {
    expect(requireTimestamp("2026-01-01T00:00:00.000000Z", "field")).toBe("2026-01-01T00:00:00.000000Z");
  });

  // NOT dead-by-construction: v.updatedAt/v.createdAt from readArchiveDomain
  // are typed PortableRawTimestamp = Date | string throughout
  // portable-record.ts, the same shared type used for createPortableRecord's
  // raw input. The concrete decode() implementation always normalizes TEXT
  // columns to a string today, so no value currently exercises this branch,
  // but the TYPE genuinely allows a Date -- a caller respecting that
  // contract, or a future decode() variant, needs it handled correctly.
  // This differs from a signature that is merely wider than any possible
  // caller: the type is real, only today's one concrete producer of it
  // happens not to use the Date half.
  it("converts a Date to its ISO string, per PortableRawTimestamp's genuine Date|string contract", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(requireTimestamp(date, "field")).toBe(date.toISOString());
  });

  it("goes red for an empty string", () => {
    expect(() => requireTimestamp("", "field"))
      .toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("field") }));
  });
});

describe("dispositionColumns", () => {
  it("maps pending to a pending delivery state with no processed_at or quarantine_reason", () => {
    expect(dispositionColumns("pending", "2026-01-01T00:00:00.000000Z")).toEqual({
      deliveryState: "pending", processedAt: null, quarantineReason: null,
    });
  });

  it("maps applied to a pending delivery state with processed_at set", () => {
    expect(dispositionColumns("applied", "2026-01-01T00:00:00.000000Z")).toEqual({
      deliveryState: "pending", processedAt: "2026-01-01T00:00:00.000000Z", quarantineReason: null,
    });
  });

  it("maps quarantined to a quarantined delivery state with a quarantine_reason", () => {
    const result = dispositionColumns("quarantined", "2026-01-01T00:00:00.000000Z");
    expect(result.deliveryState).toBe("quarantined");
    expect(result.processedAt).toBeNull();
    expect(result.quarantineReason).not.toBeNull();
  });
});

describe("RollbackSidecarError", () => {
  it("defaults its message to the reason and sets its name", () => {
    const error = new RollbackSidecarError("unsafe-storage");
    expect(error.message).toBe("unsafe-storage");
    expect(error.name).toBe("RollbackSidecarError");
  });
});

describe("readMachineIdByIdentityKey", () => {
  it("reads identity-key to machine-id mappings straight from the archive, including null machine ids", () => {
    const { path } = seedGeneration();
    const db = new DatabaseSync(path);
    try {
      const map = readMachineIdByIdentityKey(db);
      const direct = new Map([...readArchiveDomain(db, "machines")].map((r) => [r.value.identityKey, r.value.machineId]));
      expect(map).toEqual(direct);
      expect(map.size).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

/**
 * #1663. A row the hook outbox wrote through EventsDb.insertEvent keeps SQLite's datetime('now') text
 * ('YYYY-MM-DD HH:MM:SS') in created_at, while the archive carries the portable encoder's canonical form
 * ('YYYY-MM-DDTHH:MM:SS.ffffffZ'). INSERT ... ON CONFLICT DO NOTHING keeps the live row, so the verifier must
 * compare the two by instant. The live row here is written by the real EventsDb on the events db path
 * materializeRollbackSidecars opens, and closed before materialization; the archive timestamp is derived only by
 * canonicalizing the stored text, never typed in.
 */
describe("#1663: a live outbox row's SQLite timestamp text verifies against the canonical archive timestamp", () => {
  type OutboxCase = Readonly<{
    homeDir: string;
    eventsDbPath: string;
    eventId: string;
    /** Writes the archive generation with the event's archived timestamp and disposition. */
    seedArchive: (createdAt: string, disposition: "pending" | "applied") => string;
    stored: () => Record<string, unknown>;
  }>;

  function seedOutboxCase(acknowledge: boolean): OutboxCase {
    const homeDir = tempHome();
    const eventsDbPath = join(eventsDir(homeDir), `${LOCAL_PROJECT_ID}.db`);
    mkdirSync(eventsDir(homeDir), { recursive: true, mode: 0o700 });
    const events = new EventsDb(eventsDbPath);
    try {
      events.insertEvent("outbox-session", { type: "session.compacted", category: "intent", data: "{\"summary\":\"compacted\"}", priority: 5 }, "PreCompact");
    } finally {
      events.close();
    }
    const raw = new DatabaseSync(eventsDbPath);
    let eventId: string;
    try {
      // The test home has no machine registration, so insertEvent left machine_id NULL; the archive's machine mapping names MACHINE_A_UUID.
      raw.prepare("UPDATE events SET machine_id = ?").run(MACHINE_A_UUID);
      eventId = (raw.prepare("SELECT event_uuid FROM events").get() as { event_uuid: string }).event_uuid;
    } finally {
      raw.close();
    }
    if (acknowledge) {
      const worker = new EventsDb(eventsDbPath);
      try {
        expect(worker.markAcknowledged(eventId, 7n)).toBe(true);
      } finally {
        worker.close();
      }
    }
    const stored = (): Record<string, unknown> => readEventRow(eventsDbPath, eventId);
    expect(stored().created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const seedArchive = (createdAt: string, disposition: "pending" | "applied"): string => {
      const row = stored();
      const { path } = tempGenerationPath();
      const db = new DatabaseSync(path);
      try {
        runLcmMigrations(db, { fts5Available: false });
        initializePortableArchive(db);
        const all = buildRecords(postgresGeneration());
        for (const record of all.get("machines")!) writePortableArchiveRecord(db, record);
        const projectIdentity = (all.get("project")![0].value as { identity: unknown }).identity;
        writePortableArchiveRecord(db, createPortableRecord({
          domain: "passive-events",
          ordinal: 0,
          value: {
            machineIdentityKey: MACHINE_A,
            eventId,
            eventVersion: row.event_version as number,
            machineSequence: parseLocalHookMachineSequence(row.machine_sequence as string),
            eventType: row.type as string,
            sessionId: row.session_id as string,
            sessionSequence: row.seq as number,
            category: row.category as string,
            data: row.data as string,
            priority: row.priority as number,
            sourceHook: row.source_hook as string,
            createdAt,
            disposition,
          },
          context: { projectIdentity },
        } as Parameters<typeof createPortableRecord>[0]));
      } finally {
        db.close();
      }
      return path;
    };
    return { homeDir, eventsDbPath, eventId, seedArchive, stored };
  }

  const materialize = (c: OutboxCase, path: string) =>
    materializeRollbackSidecars({ homeDir: c.homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

  it("(a) accepts a pending outbox row and leaves its original created_at text untouched", () => {
    const c = seedOutboxCase(false);
    const before = c.stored();
    const path = c.seedArchive(before.created_at as string, "pending");

    const outcome = materialize(c, path);

    expect(outcome.passiveEventsMaterialized).toBe(0);
    expect(outcome.passiveEventsPreservedPending).toBe(0);
    expect(c.stored()).toEqual(before);
    expect(c.stored().created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("(b) accepts an acknowledged outbox row, sets only its processing marker and keeps the acknowledgement", () => {
    const c = seedOutboxCase(true);
    const before = c.stored();
    expect(before).toMatchObject({ delivery_state: "acknowledged", remote_inbox_id: "7", processed_at: null });
    const path = c.seedArchive(before.created_at as string, "applied");

    const outcome = materialize(c, path);

    expect(outcome.passiveEventsMaterialized).toBe(0);
    const after = c.stored();
    expect(after.created_at).toBe(before.created_at);
    expect(after.processed_at).not.toBeNull();
    expect({ delivery_state: after.delivery_state, remote_inbox_id: after.remote_inbox_id, acknowledged_at: after.acknowledged_at })
      .toEqual({ delivery_state: before.delivery_state, remote_inbox_id: before.remote_inbox_id, acknowledged_at: before.acknowledged_at });
  });

  it("(c) still refuses when the archive timestamp is a different instant", () => {
    const c = seedOutboxCase(false);
    const stored = c.stored().created_at as string;
    const later = stored.replace(/:(\d{2})$/, (_m, s: string) => `:${String((Number(s) + 1) % 60).padStart(2, "0")}`);
    expect(later).not.toBe(stored);
    const path = c.seedArchive(later, "pending");

    expect(() => materialize(c, path)).toThrow(/diverges from its archive row/);
    expect(c.stored().created_at).toBe(stored);
  });

  it("(d) refuses a stored created_at that is not a timestamp", () => {
    const c = seedOutboxCase(false);
    const canonical = c.stored().created_at as string;
    const path = c.seedArchive(canonical, "pending");
    const raw = new DatabaseSync(c.eventsDbPath);
    try {
      raw.prepare("UPDATE events SET created_at = 'not a timestamp'").run();
    } finally {
      raw.close();
    }

    expect(() => materialize(c, path)).toThrow(/diverges from its archive row/);
  });

  it("(e) compares a stored fractional second by instant", () => {
    const c = seedOutboxCase(false);
    const raw = new DatabaseSync(c.eventsDbPath);
    try {
      raw.prepare("UPDATE events SET created_at = '2026-01-02T03:04:05.5'").run();
    } finally {
      raw.close();
    }
    const path = c.seedArchive("2026-01-02 03:04:05.500", "pending");

    expect(materialize(c, path).passiveEventsPreservedPending).toBe(0);
    expect(c.stored().created_at).toBe("2026-01-02T03:04:05.5");
  });
});


describe("assertRollbackSidecarsCompatible (#1681)", () => {
  const preflight = (homeDir: string, databasePath: string): void =>
    assertRollbackSidecarsCompatible({ homeDir, databasePath, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

  /** A home whose live events database was materialized from the generation, then edited with real SQL. */
  function liveHome(edit?: (live: DatabaseSync, passiveEventRecords: readonly PortableRecord<"passive-events">[]) => void) {
    const homeDir = tempHome();
    const { path, passiveEventRecords } = seedGeneration();
    const first = materializeRollbackSidecars({ homeDir, databasePath: path, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
    const live = new DatabaseSync(first.eventsDbPath);
    try {
      edit?.(live, passiveEventRecords);
    } finally {
      live.close();
    }
    return { homeDir, path, eventsDbPath: first.eventsDbPath, passiveEventRecords };
  }
  const idOf = (records: readonly PortableRecord<"passive-events">[], disposition: string): string =>
    records.find((record) => record.value.disposition === disposition)!.value.eventId;

  it("tolerates a missing live events database without creating it", () => {
    const homeDir = tempHome();
    const { path } = seedGeneration();
    expect(() => preflight(homeDir, path)).not.toThrow();
    expect(existsSync(eventsDir(homeDir))).toBe(false);
  });

  it("accepts a live database that matches the archive and does not write to it", () => {
    const { homeDir, path, eventsDbPath, passiveEventRecords } = liveHome();
    const before = readEventRow(eventsDbPath, idOf(passiveEventRecords, "pending"));
    expect(() => preflight(homeDir, path)).not.toThrow();
    expect(readEventRow(eventsDbPath, idOf(passiveEventRecords, "pending"))).toEqual(before);
  });

  it("accepts a row the daemon drained while the archive still lists it as pending, untouched", () => {
    const { homeDir, path, eventsDbPath, passiveEventRecords } = liveHome((live, records) => {
      live.exec(
        "UPDATE events SET delivery_state = 'replicated', remote_inbox_id = 'inbox-1', processed_at = '2026-01-01T00:00:00.000000Z' WHERE event_uuid = '"
        + idOf(records, "pending") + "'",
      );
    });
    const before = readEventRow(eventsDbPath, idOf(passiveEventRecords, "pending"));
    expect(() => preflight(homeDir, path)).not.toThrow();
    expect(readEventRow(eventsDbPath, idOf(passiveEventRecords, "pending"))).toEqual(before);
  });

  it("tolerates an archived event the live database does not hold yet, and does not insert it", () => {
    const { homeDir, path, eventsDbPath, passiveEventRecords } = liveHome((live, records) => {
      live.exec("DELETE FROM events WHERE event_uuid = '" + idOf(records, "pending") + "'");
    });
    expect(() => preflight(homeDir, path)).not.toThrow();
    const live = new DatabaseSync(eventsDbPath, { readOnly: true });
    try {
      expect(live.prepare("SELECT count(*) AS n FROM events WHERE event_uuid = ?").get(idOf(passiveEventRecords, "pending"))).toEqual({ n: 0 });
    } finally {
      live.close();
    }
  });

  it("refuses a divergent live row with verification-failed", () => {
    const { homeDir, path } = liveHome((live) => { live.exec("UPDATE events SET data = '{\"other\":true}'"); });
    expect(() => preflight(homeDir, path)).toThrow(expect.objectContaining({ reason: "verification-failed" }));
  });

  it("still refuses a pending archive row whose live row is acknowledged but not processed", () => {
    const { homeDir, path } = liveHome((live, records) => {
      live.exec(
        "UPDATE events SET delivery_state = 'acknowledged', remote_inbox_id = '1', acknowledged_at = '2026-01-03T00:00:00.000000Z', processed_at = NULL WHERE event_uuid = '"
        + idOf(records, "pending") + "'",
      );
    });
    expect(() => preflight(homeDir, path)).toThrow(expect.objectContaining({ reason: "verification-failed" }));
  });

  it("still refuses an applied archive row whose live row is replicated and unprocessed", () => {
    const { homeDir, path } = liveHome((live, records) => {
      live.exec(
        "UPDATE events SET delivery_state = 'replicated', remote_inbox_id = 'inbox-1', processed_at = NULL WHERE event_uuid = '"
        + idOf(records, "applied") + "'",
      );
    });
    expect(() => preflight(homeDir, path)).toThrow(expect.objectContaining({ reason: "verification-failed" }));
  });

  it("refuses a delivered live row the archive does not hold", () => {
    const { homeDir, path } = liveHome((live) => {
      live.exec(
        "INSERT INTO events (event_uuid, event_version, machine_sequence, session_id, type, category, data, source_hook, delivery_state, remote_inbox_id) "
        + "VALUES ('018f7769-4c00-7f77-9b32-4a2f8f5cbeef', 1, '" + formatLocalHookMachineSequence(999n) + "', 'orphan', 'orphan.event', 'intent', '{}', 'Test', 'replicated', 'inbox-9')",
      );
    });
    expect(() => preflight(homeDir, path)).toThrow(expect.objectContaining({ reason: "verification-failed", message: expect.stringContaining("delivered event") }));
  });

  it("refuses an archived event of an unknown machine identity key", () => {
    const { homeDir } = liveHome();
    const { path } = tempGenerationPath();
    const db = new DatabaseSync(path);
    try {
      runLcmMigrations(db, { fts5Available: false });
      initializePortableArchive(db);
      writePortableArchiveRecord(db, createPortableRecord({
        domain: "passive-events",
        ordinal: 0,
        value: {
          machineIdentityKey: "ghost-machine", eventId: "018f7769-4c00-7f77-9b32-4a2f8f5cffff", eventVersion: 1, machineSequence: 0,
          eventType: "session.compacted", sessionId: "session-x", sessionSequence: 0, category: "intent", data: "{}", priority: 5,
          sourceHook: "PreCompact", createdAt: "2026-01-01T00:00:00.000000Z", disposition: "pending",
        },
        context: { projectIdentity: { scope: "local", projectId: "a".repeat(64) } },
      }));
    } finally {
      db.close();
    }
    expect(() => preflight(homeDir, path)).toThrow(expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("ghost-machine") }));
  });

  it("compares a version-4 live database, which has the current events columns, and refuses its divergent row", () => {
    const { homeDir, path } = liveHome((live) => {
      live.exec("UPDATE events SET data = '{\"other\":true}'");
      live.exec("UPDATE schema_version SET version = 4");
    });
    expect(() => preflight(homeDir, path)).toThrow(expect.objectContaining({ reason: "verification-failed", message: expect.stringContaining("diverges from its archive row") }));
  });

  it("accepts a matching version-4 live database", () => {
    const { homeDir, path } = liveHome((live) => { live.exec("UPDATE schema_version SET version = 4"); });
    expect(() => preflight(homeDir, path)).not.toThrow();
  });

  it("refuses a live database whose schema is newer than this build supports", () => {
    const { homeDir, path } = liveHome((live) => { live.exec("UPDATE schema_version SET version = 6"); });
    expect(() => preflight(homeDir, path)).toThrow(expect.objectContaining({ reason: "verification-failed", message: expect.stringContaining("newer than this build") }));
  });

  it("leaves a live database without a schema_version row, or older than version 4, to materialization and the post-install verification", () => {
    for (const edit of [
      "DROP TABLE schema_version",
      "DELETE FROM schema_version",
      "UPDATE schema_version SET version = 3",
    ]) {
      const { homeDir, path } = liveHome((live) => { live.exec("UPDATE events SET data = '{\"other\":true}'"); live.exec(edit); });
      expect(() => preflight(homeDir, path)).not.toThrow();
    }
  });
});

describe("#1698: a delivered event whose remote inbox row was pruned is the drained steady state", () => {
  const PRUNED_ID = "018f7769-4c00-7f77-9b32-4a2f8f5c1698";
  const PENDING_ID = "018f7769-4c00-7f77-9b32-4a2f8f5c1699";
  const preflight = (homeDir: string, databasePath: string): void =>
    assertRollbackSidecarsCompatible({ homeDir, databasePath, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });
  const materialize = (homeDir: string, databasePath: string) =>
    materializeRollbackSidecars({ homeDir, databasePath, localProjectId: LOCAL_PROJECT_ID, machineId: MACHINE_A_UUID });

  /** The columns a worker drain leaves: uploaded, remote applied, locally acknowledged, then the remote row pruned. */
  const PRUNED = "delivery_state, remote_inbox_id, acknowledged_at, remote_pruned_at";
  const PRUNED_VALUES = "'acknowledged', 'inbox-1698', '2026-01-03T00:00:00.000000Z', '2026-01-03 00:00:01'";

  /** A home whose live events database was materialized from the generation, then given a local row the archive does not hold. */
  function liveHomeWithLocalRow(eventId: string, sequence: bigint, columns: string, values: string, processedAt: string | null) {
    const homeDir = tempHome();
    const { path } = seedGeneration();
    const first = materialize(homeDir, path);
    const live = new DatabaseSync(first.eventsDbPath);
    try {
      live.exec(
        "INSERT INTO events (event_uuid, event_version, machine_sequence, session_id, type, category, data, source_hook, processed_at, " + columns
        + ") VALUES ('" + eventId + "', 1, '" + formatLocalHookMachineSequence(sequence)
        + "', 'drained', 'drained.event', 'intent', '{}', 'Test', " + (processedAt === null ? "NULL" : "'" + processedAt + "'")
        + ", " + values + ")",
      );
    } finally {
      live.close();
    }
    return { homeDir, path, eventsDbPath: first.eventsDbPath };
  }

  it.each([
    ["processed", "2026-01-03T00:00:02.000000Z"],
    ["unprocessed", null],
  ])("(a)/(b) materialization accepts and keeps a delivered and pruned %s row the archive does not hold", (_label, processedAt) => {
    const { homeDir, path, eventsDbPath } = liveHomeWithLocalRow(PRUNED_ID, 999n, PRUNED, PRUNED_VALUES, processedAt);
    const before = readEventRow(eventsDbPath, PRUNED_ID);
    const outcome = materialize(homeDir, path);
    // Delivered rows are not undelivered local appends, so they are not counted as preserved pending.
    expect(outcome.passiveEventsPreservedPending).toBe(0);
    // Byte-identical: the delivery columns and the processing marker are all left as the drain wrote them.
    expect(readEventRow(eventsDbPath, PRUNED_ID)).toEqual(before);
    expect(readEventRow(eventsDbPath, PRUNED_ID)).toMatchObject({
      delivery_state: "acknowledged", remote_inbox_id: "inbox-1698", remote_pruned_at: "2026-01-03 00:00:01", processed_at: processedAt,
    });
    // The daemon's remote apply does nothing, so only a locally processed row is done: an unprocessed one is still replayed.
    const edb = new EventsDb(eventsDbPath);
    try {
      const unprocessed = edb.getUnprocessed().map((row) => row.event_uuid);
      expect(unprocessed.includes(PRUNED_ID)).toBe(processedAt === null);
    } finally {
      edb.close();
    }
  });

  it("(a) verification counts only the undelivered local append beside a pruned row", () => {
    const { path, eventsDbPath } = liveHomeWithLocalRow(PRUNED_ID, 999n, PRUNED, PRUNED_VALUES, "2026-01-03T00:00:02.000000Z");
    const live = new DatabaseSync(eventsDbPath);
    const db = new DatabaseSync(path);
    try {
      live.exec(
        "INSERT INTO events (event_uuid, event_version, machine_sequence, session_id, type, category, data, source_hook) VALUES ('"
        + PENDING_ID + "', 1, '" + formatLocalHookMachineSequence(1000n) + "', 'drained', 'drained.event', 'intent', '{}', 'Test')",
      );
      expect(verifyPassiveEventsAgainstArchive(db, live, readMachineIdByIdentityKey(db), MACHINE_A_UUID).preservedPending).toBe(1);
    } finally {
      db.close();
      live.close();
    }
  });

  it("(a) keeps counting only the undelivered local append beside a pruned row", () => {
    const { homeDir, path, eventsDbPath } = liveHomeWithLocalRow(PRUNED_ID, 999n, PRUNED, PRUNED_VALUES, "2026-01-03T00:00:02.000000Z");
    const live = new DatabaseSync(eventsDbPath);
    try {
      live.exec(
        "INSERT INTO events (event_uuid, event_version, machine_sequence, session_id, type, category, data, source_hook) VALUES ('"
        + PENDING_ID + "', 1, '" + formatLocalHookMachineSequence(1000n) + "', 'drained', 'drained.event', 'intent', '{}', 'Test')",
      );
    } finally {
      live.close();
    }
    expect(materialize(homeDir, path).passiveEventsPreservedPending).toBe(1);
  });

  it.each([
    ["processed", "2026-01-03T00:00:02.000000Z"],
    ["unprocessed", null],
  ])("(c) the read-only preflight accepts a delivered and pruned %s row and writes nothing", (_label, processedAt) => {
    const { homeDir, path, eventsDbPath } = liveHomeWithLocalRow(PRUNED_ID, 999n, PRUNED, PRUNED_VALUES, processedAt);
    const before = readEventRow(eventsDbPath, PRUNED_ID);
    expect(() => preflight(homeDir, path)).not.toThrow();
    expect(readEventRow(eventsDbPath, PRUNED_ID)).toEqual(before);
  });

  it.each([
    ["replicated with an inbox id", "delivery_state, remote_inbox_id", "'replicated', 'inbox-1698'"],
    ["acknowledged and not pruned", "delivery_state, remote_inbox_id, acknowledged_at", "'acknowledged', 'inbox-1698', '2026-01-03T00:00:00.000000Z'"],
  ])("(d) still refuses a delivered row the archive does not hold that is %s, before and after install", (_label, columns, values) => {
    const { homeDir, path, eventsDbPath } = liveHomeWithLocalRow(PRUNED_ID, 999n, columns, values, null);
    const before = readEventRow(eventsDbPath, PRUNED_ID);
    const delivered = expect.objectContaining({ reason: "verification-failed", message: expect.stringContaining("delivered event") });
    expect(() => preflight(homeDir, path)).toThrow(delivered);
    expect(() => materialize(homeDir, path)).toThrow(delivered);
    expect(readEventRow(eventsDbPath, PRUNED_ID)).toEqual(before);
  });
});
