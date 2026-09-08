import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptMigrationReceiptEpoch,
  classifyMigrationQueue,
  readMigrationReceiptEvidence,
  recordMigrationReceipt,
  findMatchingMigrationReceipt,
  getMigrationReceiptEpoch,
  iterateMigrationReceiptChecksums,
  migrationReceiptEnvelopeSha256,
  MIGRATION_RECEIPT_EPOCHS_DDL,
  MIGRATION_RECEIPT_EVENTS_DDL,
  type MigrationReceiptEnvelope,
} from "../../src/migration/receipts.js";
import { recoverMachineIdentity } from "../../src/machine-identity.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import { backendPublicationCanonicalSha256 } from "../../src/storage/backend-publication.js";

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

function receiptInput() {
  return { projectId: PROJECT_ID, epochId: EPOCH_ID, envelope: envelope(),
    effectWitness: { version: 1 as const, outcome: "applied" as const, promotedMemoryId: "memory-1" },
    committedAt: "2026-09-07T03:05:06.654321Z" };
}

function seededReceipt() {
  const db = database();
  adopt(db);
  db.exec("BEGIN");
  recordMigrationReceipt(db, receiptInput());
  db.exec("COMMIT");
  return db;
}

describe("receipt authentication failure boundaries", () => {
  it.each([
    { eventUuid: "not-a-uuid" }, { machineSequence: "invalid" },
    { machineSequence: "9223372036854775808" }, { eventVersion: 0 },
    { eventVersion: 1.5 }, { sessionSequence: -1 }, { sessionSequence: 1.5 },
    { priority: Infinity },
  ])("refuses malformed original envelope %j", (change) => {
    expect(() => migrationReceiptEnvelopeSha256(envelope(change))).toThrow();
  });

  it("refuses negative zero envelope integers under the canonical JSON contract", () => {
    expect(() => migrationReceiptEnvelopeSha256(envelope({ priority: -0 }))).toThrow();
  });

  it.each(["2026-09-07", "2026-99-07T03:05:06.654321Z"])("refuses malformed timestamp %s", (committedAt) => {
    const db = database(); adopt(db); db.exec("BEGIN");
    expect(() => recordMigrationReceipt(db, { ...receiptInput(), committedAt })).toThrow("timestamp");
    db.exec("ROLLBACK");
  });

  it.each([
    { version: 2, outcome: "applied", promotedMemoryId: "memory-1" },
    { version: 1, outcome: "applied", promotedMemoryId: "" },
    { version: 1, outcome: "applied", promotedMemoryId: "x".repeat(16384) },
    { version: 1, outcome: "unknown" },
    { version: 1, outcome: "unknown", reason: "unreinforced-pattern" },
    { version: 1, outcome: "no-effect", reason: "unknown" },
    { version: 1, outcome: "applied", promotedMemoryId: "memory-1", invalid: Infinity },
    { version: 1, outcome: "applied", promotedMemoryId: "memory-1", invalid: undefined },
    { version: 1, outcome: "applied", promotedMemoryId: "memory-1", extra: true },
    { version: 1, outcome: "no-effect", reason: "unreinforced-pattern", extra: true },
  ])("refuses malformed receipt effect %j", (effectWitness) => {
    const db = database(); adopt(db); db.exec("BEGIN");
    expect(() => recordMigrationReceipt(db, { ...receiptInput(), effectWitness: effectWitness as never })).toThrow();
    expect(db.prepare("SELECT count(*) AS count FROM migration_receipt_v1_events").get()).toEqual({ count: 0 });
    db.exec("ROLLBACK");
  });

  it("refuses missing and pre-enforcement epochs and same-sequence event reuse", () => {
    const db = database(); adopt(db); db.exec("BEGIN");
    expect(() => recordMigrationReceipt(db, { ...receiptInput(), epochId: "318f0b5d-1234-4abc-8def-1234567890ab" })).toThrow("epoch is missing");
    expect(() => recordMigrationReceipt(db, { ...receiptInput(), envelope: envelope({ machineSequence: "0000000000000000006" }) })).toThrow("predates");
    recordMigrationReceipt(db, receiptInput());
    expect(() => recordMigrationReceipt(db, { ...receiptInput(), envelope: envelope({ eventUuid: "318f0b5d-1234-4abc-8def-1234567890ab" }) })).toThrow("conflict");
    db.exec("ROLLBACK");
  });

  it.each(["partial", "wrong-first", "wrong-second", "trigger", "view"])("refuses %s receipt schema", (shape) => {
    const db = database();
    if (shape === "partial") db.exec(MIGRATION_RECEIPT_EPOCHS_DDL);
    else if (shape === "wrong-first") db.exec("CREATE TABLE migration_receipt_v1_aaa(x); CREATE TABLE migration_receipt_v1_zzz(x)");
    else if (shape === "wrong-second") db.exec(`${MIGRATION_RECEIPT_EPOCHS_DDL}; CREATE TABLE migration_receipt_v1_zzz(x)`);
    else if (shape === "view") db.exec(`CREATE VIEW migration_receipt_v1_epochs AS SELECT 1; ${MIGRATION_RECEIPT_EVENTS_DDL}`);
    else { adopt(db); db.exec("CREATE TRIGGER bad AFTER INSERT ON migration_receipt_v1_events BEGIN SELECT 1; END"); }
    expect(() => readMigrationReceiptEvidence(db, PROJECT_ID, MACHINE_ID)).toThrow("schema");
  });

  it("preserves epoch adoption failure when rollback also fails", () => {
    const db = database(); db.exec(MIGRATION_RECEIPT_EPOCHS_DDL);
    const original = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      original(sql);
    });
    try { expect(() => adopt(db)).toThrow("partial"); }
    finally { spy.mockRestore(); db.exec("ROLLBACK"); }
  });

  it.each(["0".repeat(64), "malformed"])("refuses corrupted epoch checksum %s", (checksum) => {
    const db = database(); adopt(db); db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE migration_receipt_v1_epochs SET checksum_sha256 = ?").run(checksum);
    expect(() => getMigrationReceiptEpoch(db, PROJECT_ID, MACHINE_ID)).toThrow("checksum");
  });

  it.each([
    ["effect_witness_json", "{"],
    ["effect_witness_json", '{ "version":1,"outcome":"applied","promotedMemoryId":"memory-1"}'],
    ["envelope_sha256", "malformed"], ["checksum_sha256", "malformed"],
    ["outcome", "no-effect"],
  ])("refuses malformed stored %s", (field, value) => {
    const db = seededReceipt(); db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare(`UPDATE migration_receipt_v1_events SET ${field} = ?`).run(value);
    expect(() => readMigrationReceiptEvidence(db, PROJECT_ID, MACHINE_ID)).toThrow();
  });

  it("refuses NUL data anywhere in the receipt tables and a missing requested epoch", () => {
    const db = seededReceipt();
    expect(() => readMigrationReceiptEvidence(db, "unknown-project", MACHINE_ID)).toThrow("epoch is missing");
    db.prepare("UPDATE migration_receipt_v1_events SET effect_witness_json = ?").run("bad\0witness");
    expect(() => readMigrationReceiptEvidence(db, PROJECT_ID, MACHINE_ID)).toThrow("NUL");
  });

  it("refuses receipts rebound to a different valid epoch", () => {
    const db = seededReceipt();
    const epoch = readMigrationReceiptEvidence(db, PROJECT_ID, MACHINE_ID).epoch;
    const changed = { ...epoch, epochId: "318f0b5d-1234-4abc-8def-1234567890ab" };
    const { checksumSha256: _old, ...body } = changed;
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE migration_receipt_v1_epochs SET epoch_id = ?, checksum_sha256 = ?")
      .run(changed.epochId, backendPublicationCanonicalSha256({ version: 1, ...body }));
    expect(() => readMigrationReceiptEvidence(db, PROJECT_ID, MACHINE_ID)).toThrow("epoch identity");
    db.exec("BEGIN");
    expect(() => findMatchingMigrationReceipt(db, { ...receiptInput(), epochId: changed.epochId })).toThrow("envelope conflict");
    db.exec("ROLLBACK");
  });

  it.each(["projectId", "machineId", "epochId", "firstMachineSequence"] as const)("refuses streamed receipts outside the authenticated %s", (field) => {
    const db = seededReceipt();
    const epoch = readMigrationReceiptEvidence(db, PROJECT_ID, MACHINE_ID).epoch;
    const changed = { ...epoch, [field]: field === "firstMachineSequence" ? "0000000000000000008" : "wrong" };
    expect(() => [...iterateMigrationReceiptChecksums(db, changed)]).toThrow("epoch identity");
  });

  it("rejects oversized stored effect data before streaming", () => {
    const db = seededReceipt();
    const epoch = readMigrationReceiptEvidence(db, PROJECT_ID, MACHINE_ID).epoch;
    db.prepare("UPDATE migration_receipt_v1_events SET effect_witness_json = ?").run("x".repeat(16385));
    expect(() => [...iterateMigrationReceiptChecksums(db, epoch)]).toThrow("too large");
  });

  function queueFixture() {
    const project = seededReceipt();
    const events = database();
    events.exec(`CREATE TABLE events (
      event_uuid TEXT, event_version INTEGER, machine_id TEXT, machine_sequence TEXT,
      session_id TEXT, seq INTEGER, type TEXT, category TEXT, data TEXT, priority INTEGER,
      source_hook TEXT, processed_at TEXT, created_at TEXT
    )`);
    events.prepare("INSERT INTO events VALUES (?,1,?,?,'session-1',2,'decision','decision','keep exact bytes',1,'SessionStart',NULL,'2026-09-07 03:04:05')")
      .run(EVENT_ID, MACHINE_ID, FIRST);
    const classify = (queueCutoff: string | null = "0000000000000000009") => classifyMigrationQueue(project, events, {
      projectId: PROJECT_ID, machineId: MACHINE_ID, queueCutoff,
    });
    return { project, events, classify };
  }

  it("admits an empty cutoff without inspecting later queue input", () => {
    const fixture = queueFixture();
    expect(fixture.classify(null)).toMatchObject({ state: "ready", records: [] });
  });

  it.each([
    ["event_uuid", null, "queue-row-malformed"],
    ["machine_id", null, "machine-identity-ambiguous"],
    ["event_version", 0, "queue-row-malformed"],
    ["data", "conflicting bytes", "receipt-conflict"],
    ["machine_sequence", "0000000000000000008", "receipt-conflict"],
  ])("refuses malformed queue %s", (field, value, reason) => {
    const fixture = queueFixture();
    fixture.events.prepare(`UPDATE events SET ${field} = ?`).run(value);
    expect(fixture.classify()).toMatchObject({ state: "refused", reason });
  });

  it.each(["event", "sequence"])("refuses colliding queue %s identities", (collision) => {
    const fixture = queueFixture();
    fixture.events.exec("INSERT INTO events SELECT * FROM events");
    if (collision === "event") fixture.events.exec("UPDATE events SET machine_sequence = '0000000000000000008' WHERE rowid=2");
    else fixture.events.prepare("UPDATE events SET event_uuid = ? WHERE rowid=2").run("318f0b5d-1234-4abc-8def-1234567890ab");
    expect(fixture.classify()).toMatchObject({ state: "refused", reason: "queue-row-malformed" });
  });
});

describe("migration receipt v1", () => {
  it.each([
    ["epoch primary key", MIGRATION_RECEIPT_EPOCHS_DDL.replace("  PRIMARY KEY (project_id, machine_id),\n", ""), MIGRATION_RECEIPT_EVENTS_DDL],
    ["event unique sequence", MIGRATION_RECEIPT_EPOCHS_DDL, MIGRATION_RECEIPT_EVENTS_DDL.replace("  UNIQUE (project_id, machine_id, machine_sequence),\n", "")],
    ["event foreign key", MIGRATION_RECEIPT_EPOCHS_DDL, MIGRATION_RECEIPT_EVENTS_DDL.replace("REFERENCES migration_receipt_v1_epochs(epoch_id)", "REFERENCES migration_receipt_v1_epochs(machine_id)")],
    ["event check", MIGRATION_RECEIPT_EPOCHS_DDL, MIGRATION_RECEIPT_EVENTS_DDL.replace("CHECK (", "CHECK (1 OR ")],
  ])("rejects same-column receipt schemas with changed %s", (_name, epochs, events) => {
    const db = database();
    db.exec(`${epochs};${events};`);
    expect(() => adopt(db)).toThrow("schema");
  });

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

  it.each(["applied", "no-effect"] as const)("authenticates the stored %s outcome without a new timestamp", (outcome) => {
    const db = database();
    adopt(db);
    const input = { projectId: PROJECT_ID, epochId: EPOCH_ID, envelope: envelope() };
    expect(() => findMatchingMigrationReceipt(db, input)).toThrow("transaction");
    db.exec("BEGIN IMMEDIATE");
    expect(findMatchingMigrationReceipt(db, input)).toBeNull();
    const receipt = recordMigrationReceipt(db, {
      ...input,
      effectWitness: outcome === "applied"
        ? { version: 1, outcome, promotedMemoryId: "memory-1" }
        : { version: 1, outcome, reason: "unreinforced-pattern" },
      committedAt: "2026-09-07T03:05:06.654321Z",
    });
    db.exec("COMMIT; BEGIN IMMEDIATE");
    expect(findMatchingMigrationReceipt(db, input)).toEqual(receipt);
    db.exec("COMMIT");
  });

  it.each([
    ["data", { data: "conflicting original envelope" }],
    ["event UUID", { eventUuid: "318f0b5d-1234-4abc-8def-1234567890ab" }],
    ["machine sequence", { machineSequence: "0000000000000000008" }],
  ])("refuses a prior receipt with conflicting %s", (_name, changedEnvelope) => {
    const db = database();
    adopt(db);
    db.exec("BEGIN IMMEDIATE");
    recordMigrationReceipt(db, {
      projectId: PROJECT_ID, epochId: EPOCH_ID, envelope: envelope(),
      effectWitness: { version: 1, outcome: "applied", promotedMemoryId: "memory-1" },
      committedAt: "2026-09-07T03:05:06.654321Z",
    });
    expect(() => findMatchingMigrationReceipt(db, {
      projectId: PROJECT_ID, epochId: EPOCH_ID, envelope: envelope(changedEnvelope),
    })).toThrow("conflict");
    db.exec("ROLLBACK");
  });

  it("refuses colliding receipt identities and corrupted stored checksums", () => {
    const db = database();
    adopt(db);
    db.exec("BEGIN IMMEDIATE");
    const secondEvent = "318f0b5d-1234-4abc-8def-1234567890ab";
    for (const event of [envelope(), envelope({ eventUuid: secondEvent, machineSequence: "0000000000000000008" })]) {
      recordMigrationReceipt(db, {
        projectId: PROJECT_ID, epochId: EPOCH_ID, envelope: event,
        effectWitness: { version: 1, outcome: "applied", promotedMemoryId: "memory-1" },
        committedAt: "2026-09-07T03:05:06.654321Z",
      });
    }
    expect(() => findMatchingMigrationReceipt(db, {
      projectId: PROJECT_ID, epochId: EPOCH_ID,
      envelope: envelope({ machineSequence: "0000000000000000008" }),
    })).toThrow("identity conflict");
    db.prepare("UPDATE migration_receipt_v1_events SET checksum_sha256 = ? WHERE event_uuid = ?")
      .run("0".repeat(64), EVENT_ID);
    expect(() => findMatchingMigrationReceipt(db, {
      projectId: PROJECT_ID, epochId: EPOCH_ID, envelope: envelope(),
    })).toThrow("checksum");
    db.exec("ROLLBACK");
  });

  it("refuses absent, changed and pre-enforcement epochs during lookup", () => {
    const db = database();
    const input = { projectId: PROJECT_ID, epochId: EPOCH_ID, envelope: envelope() };
    db.exec("BEGIN IMMEDIATE");
    expect(() => findMatchingMigrationReceipt(db, input)).toThrow("epoch conflict");
    db.exec("ROLLBACK");
    adopt(db);
    db.exec("BEGIN IMMEDIATE");
    expect(() => findMatchingMigrationReceipt(db, {
      ...input, epochId: "318f0b5d-1234-4abc-8def-1234567890ab",
    })).toThrow("epoch conflict");
    expect(() => findMatchingMigrationReceipt(db, {
      ...input, envelope: envelope({ machineSequence: "0000000000000000006" }),
    })).toThrow("epoch conflict");
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

describe("Node 22.12 receipt transaction compatibility", () => {
  it("proves transaction ownership when the driver has no isTransaction property", () => {
    const native = database();
    const db = { exec: native.exec.bind(native), prepare: native.prepare.bind(native), isTransaction: undefined } as unknown as DatabaseSync;
    adopt(db);
    const input = { projectId: PROJECT_ID, epochId: EPOCH_ID, envelope: envelope() };
    expect(() => findMatchingMigrationReceipt(db, input)).toThrow("active project transaction");
    db.exec("BEGIN");
    expect(findMatchingMigrationReceipt(db, input)).toBeNull();
    const receipt = recordMigrationReceipt(db, { ...input, effectWitness: { version: 1, outcome: "no-effect", reason: "unreinforced-pattern" }, committedAt: "2026-09-07T03:04:05.123456Z" });
    expect(findMatchingMigrationReceipt(db, input)).toEqual(receipt);
    expect(() => adopt(db)).toThrow("owns its transaction");
    db.exec("ROLLBACK");
    expect(() => recordMigrationReceipt(db, { ...input, effectWitness: { version: 1, outcome: "no-effect", reason: "unreinforced-pattern" }, committedAt: "2026-09-07T03:04:05.123456Z" })).toThrow("active project transaction");
    db.exec("BEGIN; COMMIT");
  });

  it.each([
    { code: "ERR_SQLITE_ERROR", errcode: 5, message: "database is locked" },
    { code: "ERR_SQLITE_ERROR", errcode: 1, message: "unexpected SQLite failure" },
    { code: "EIO", errcode: 1, message: "cannot start a transaction within a transaction" },
  ])("does not treat an arbitrary failed probe as active transaction proof", (failure) => {
    const native = database();
    const db = { exec: native.exec.bind(native), prepare: native.prepare.bind(native), isTransaction: undefined } as unknown as DatabaseSync;
    const exec = vi.spyOn(db, "exec").mockImplementationOnce(() => { throw failure; });
    try { expect(() => adopt(db)).toThrow(); } finally { exec.mockRestore(); }
  });

  it("propagates rollback failure instead of granting probe admission", () => {
    const native = database();
    const db = { exec: native.exec.bind(native), prepare: native.prepare.bind(native), isTransaction: undefined } as unknown as DatabaseSync;
    const original = db.exec.bind(db);
    const exec = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") throw new Error("probe rollback failed");
      original(sql);
    });
    try { expect(() => adopt(db)).toThrow("probe rollback failed"); } finally { exec.mockRestore(); db.exec("ROLLBACK"); }
  });
});
