import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptMigrationReceiptEpoch,
  classifyMigrationQueue,
  readMigrationReceiptEvidence,
  recordMigrationReceipt,
  type MigrationReceiptEnvelope,
} from "../../src/migration/receipts.js";
import { recoverMachineIdentity } from "../../src/machine-identity.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";

const PROJECT_ID = "a".repeat(64);
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const EPOCH_ID = "118f0b5d-1234-4abc-8def-1234567890ab";
const EVENT_ID = "218f0b5d-1234-4abc-8def-1234567890ab";
const FIRST = "0000000000000000007";
const databases: DatabaseSync[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  databases.push(db);
  return db;
}

function envelope(overrides: Partial<MigrationReceiptEnvelope> = {}): MigrationReceiptEnvelope {
  return {
    eventUuid: EVENT_ID,
    eventVersion: 1,
    machineId: MACHINE_ID,
    machineSequence: FIRST,
    sessionId: "session-1",
    sessionSequence: 2,
    type: "decision",
    category: "decision",
    data: "keep exact bytes",
    priority: 1,
    sourceHook: "SessionStart",
    createdAt: "2026-09-07 03:04:05",
    ...overrides,
  };
}

function adopt(db: DatabaseSync) {
  return adoptMigrationReceiptEpoch(db, {
    projectId: PROJECT_ID,
    machineId: MACHINE_ID,
    epochId: EPOCH_ID,
    firstMachineSequence: FIRST,
    establishedAt: "2026-09-07T03:04:05.123456Z",
  });
}

describe("migration receipt v1", () => {
  it("atomically adopts the exact two-table epoch schema", () => {
    const db = database();
    const epoch = adopt(db);
    const tables = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'migration_receipt_v1_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;

    expect(tables.map(({ name }) => name)).toEqual([
      "migration_receipt_v1_epochs",
      "migration_receipt_v1_events",
    ]);
    expect(epoch).toMatchObject({
      projectId: PROJECT_ID,
      machineId: MACHINE_ID,
      epochId: EPOCH_ID,
      firstMachineSequence: FIRST,
    });
    expect(epoch.checksumSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(adopt(db)).toEqual(epoch);
  });

  it("commits applied effect and exact receipt in the same project transaction", () => {
    const db = database();
    adopt(db);
    db.exec("CREATE TABLE effects (id TEXT PRIMARY KEY)");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO effects(id) VALUES (?)").run("memory-1");
    const receipt = recordMigrationReceipt(db, {
      projectId: PROJECT_ID,
      epochId: EPOCH_ID,
      envelope: envelope(),
      effectWitness: { version: 1, outcome: "applied", promotedMemoryId: "memory-1" },
      committedAt: "2026-09-07T03:05:06.654321Z",
    });
    db.exec("COMMIT");

    expect(receipt.outcome).toBe("applied");
    expect(readMigrationReceiptEvidence(db, PROJECT_ID, MACHINE_ID)).toMatchObject({
      epoch: { epochId: EPOCH_ID },
      receipts: [{ eventUuid: EVENT_ID, effectWitness: {
        version: 1,
        outcome: "applied",
        promotedMemoryId: "memory-1",
      } }],
    });
  });

  it("rolls back no-effect receipt with its lexical decision transaction", () => {
    const db = database();
    adopt(db);
    db.exec("BEGIN IMMEDIATE");
    recordMigrationReceipt(db, {
      projectId: PROJECT_ID,
      epochId: EPOCH_ID,
      envelope: envelope(),
      effectWitness: { version: 1, outcome: "no-effect", reason: "unreinforced-pattern" },
      committedAt: "2026-09-07T03:05:06.654321Z",
    });
    db.exec("ROLLBACK");

    expect(readMigrationReceiptEvidence(db, PROJECT_ID, MACHINE_ID).receipts).toEqual([]);
  });

  it("is idempotent for the exact event and refuses conflicting reuse", () => {
    const db = database();
    adopt(db);
    const input = {
      projectId: PROJECT_ID,
      epochId: EPOCH_ID,
      envelope: envelope(),
      effectWitness: { version: 1, outcome: "applied", promotedMemoryId: "memory-1" } as const,
      committedAt: "2026-09-07T03:05:06.654321Z",
    };
    db.exec("BEGIN IMMEDIATE");
    const first = recordMigrationReceipt(db, input);
    const second = recordMigrationReceipt(db, input);
    db.exec("COMMIT");
    expect(second).toEqual(first);

    db.exec("BEGIN IMMEDIATE");
    expect(() => recordMigrationReceipt(db, {
      ...input,
      envelope: envelope({ data: "different" }),
    })).toThrow("conflict");
    db.exec("ROLLBACK");
  });

  it("refuses receipt writes outside a transaction, before epoch, or with NUL text", () => {
    const db = database();
    expect(() => recordMigrationReceipt(db, {
      projectId: PROJECT_ID,
      epochId: EPOCH_ID,
      envelope: envelope(),
      effectWitness: { version: 1, outcome: "no-effect", reason: "unreinforced-pattern" },
      committedAt: "2026-09-07T03:05:06.654321Z",
    })).toThrow("transaction");
    adopt(db);
    db.exec("BEGIN IMMEDIATE");
    expect(() => recordMigrationReceipt(db, {
      projectId: PROJECT_ID,
      epochId: EPOCH_ID,
      envelope: envelope({ data: "bad\0value" }),
      effectWitness: { version: 1, outcome: "no-effect", reason: "unreinforced-pattern" },
      committedAt: "2026-09-07T03:05:06.654321Z",
    })).toThrow("NUL");
    db.exec("ROLLBACK");
  });

  it("adopts an epoch on an enrolled SQLite project open", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-receipt-factory-"));
    roots.push(root);
    const lcm = join(root, ".lcm");
    const projectDir = join(lcm, "projects", PROJECT_ID);
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(lcm, "events"), { recursive: true, mode: 0o700 });
    chmodSync(lcm, 0o700);
    recoverMachineIdentity({
      version: 1,
      identityKey: `machine:${"d".repeat(64)}`,
      machineId: "018f0b5d-1234-7abc-8def-1234567890ab",
      displayName: "Machine A",
    }, { homeDir: root });
    const dbPath = join(projectDir, "db.sqlite");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: () => ({ id: PROJECT_ID, dbPath }),
    });
    const project = await factory.openProject({ id: PROJECT_ID, canonical: root });
    await project.close();
    await factory.close();

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    const evidence = readMigrationReceiptEvidence(
      verify,
      PROJECT_ID,
      "018f0b5d-1234-7abc-8def-1234567890ab",
    );
    expect(evidence.epoch.firstMachineSequence).toBe("0000000000000000000");
    verify.close();
  });

  it("classifies exact receipt-era represented and pending rows and refuses legacy ambiguity", () => {
    const project = database();
    const events = database();
    adopt(project);
    events.exec(`
      CREATE TABLE events (
        event_uuid TEXT, event_version INTEGER, machine_id TEXT,
        machine_sequence TEXT, session_id TEXT, seq INTEGER, type TEXT,
        category TEXT, data TEXT, priority INTEGER, source_hook TEXT,
        processed_at TEXT, created_at TEXT
      )
    `);
    const insert = events.prepare(`
      INSERT INTO events VALUES (?, 1, ?, ?, 'session-1', 2, 'decision',
        'decision', ?, 1, 'SessionStart', ?, '2026-09-07 03:04:05')
    `);
    insert.run(EVENT_ID, MACHINE_ID, FIRST, "represented", "2026-09-07 03:05:00");
    insert.run("418f0b5d-1234-4abc-8def-1234567890ab", MACHINE_ID,
      "0000000000000000008", "pending", null);
    project.exec("BEGIN IMMEDIATE");
    recordMigrationReceipt(project, {
      projectId: PROJECT_ID,
      epochId: EPOCH_ID,
      envelope: envelope({ data: "represented" }),
      effectWitness: { version: 1, outcome: "applied", promotedMemoryId: "memory-1" },
      committedAt: "2026-09-07T03:05:06.654321Z",
    });
    project.exec("COMMIT");

    expect(classifyMigrationQueue(project, events, {
      projectId: PROJECT_ID,
      machineId: MACHINE_ID,
      queueCutoff: "0000000000000000008",
    })).toMatchObject({
      state: "ready",
      records: [
        { eventUuid: EVENT_ID, disposition: "represented" },
        { eventUuid: "418f0b5d-1234-4abc-8def-1234567890ab", disposition: "retained" },
      ],
    });

    insert.run("518f0b5d-1234-4abc-8def-1234567890ab", MACHINE_ID,
      "0000000000000000006", "legacy", null);
    expect(classifyMigrationQueue(project, events, {
      projectId: PROJECT_ID,
      machineId: MACHINE_ID,
      queueCutoff: "0000000000000000008",
    })).toMatchObject({ state: "refused", reason: "legacy-effect-ambiguous" });
    events.prepare("DELETE FROM events WHERE data = 'legacy'").run();
    insert.run("618f0b5d-1234-4abc-8def-1234567890ab", MACHINE_ID,
      "0000000000000000009", "processed-without-receipt", "2026-09-07 03:05:00");
    expect(classifyMigrationQueue(project, events, {
      projectId: PROJECT_ID,
      machineId: MACHINE_ID,
      queueCutoff: "0000000000000000009",
    })).toMatchObject({ state: "refused", reason: "receipt-era-processed-without-receipt" });
  });
});
