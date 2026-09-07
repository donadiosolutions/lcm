import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { openSqlitePortableSource, sqlitePortableFileSha256 } from "../../src/storage/sqlite/portable-source.js";
import { openSqlitePortableDestination } from "../../src/storage/sqlite/portable-destination.js";
import { canonicalJson, canonicalSha256, createPortableRecordStream, PORTABLE_LIMITS, PORTABLE_RECORD_DOMAIN_ORDER,
  type PortableRecordStream, type PortableRecord, type PortableCheckpoint } from "../../src/storage/portable-record-stream.js";
import { runPortableTransfer, type PortableRecordWriter } from "../../src/storage/portable-transfer.js";

// Literal owner contract: https://github.com/donadiosolutions/lcm/issues/622#issuecomment-5565672907
const receiptSql = readFileSync(new URL("../fixtures/migration-receipt-v1.sql", import.meta.url), "utf8");
const receiptSqlSha256 = "7f1b424c205d83243be6e58cb04426b68a36c7d38aa5a86c3f1edc3eafcaa40e";
if (createHash("sha256").update(receiptSql).digest("hex") !== receiptSqlSha256) throw new Error("Receipt fixture contract hash mismatch");
const eventDdlStart = receiptSql.indexOf("CREATE TABLE migration_receipt_v1_events");
const projectIdentity = { scope: "local", projectId: "a".repeat(64) } as const;
const machineId = "018f7766-1c40-7a11-b3d6-5c1f0a2b7e94";
const epochId = "018f7766-1c40-7a11-b3d6-5c1f0a2b7e95";
const memoryId = "33333333-3333-4333-8333-333333333333";
const capturedAt = "2026-09-07T00:00:00.000000Z";
const facts = { machines: [{ identityKey: `machine:${"b".repeat(64)}`, machineId }], aliases: [] };
const dirs: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
function own<T extends { close(): Promise<void> }>(handle: T): T { handles.push(handle); return handle; }
afterEach(async () => {
  try { for (const handle of handles.splice(0).reverse()) await handle.close(); }
  finally { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); }
});

function withDatabase<T>(path: string, callback: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return callback(db); } finally { db.close(); }
}
function fixture(encoding = "UTF-8") {
  const dir = mkdtempSync(join(tmpdir(), "lcm-portable-receipts-")); dirs.push(dir);
  const path = join(dir, "source.db");
  withDatabase(path, db => {
    db.exec(`PRAGMA encoding='${encoding}'; PRAGMA foreign_keys=ON`);
    runLcmMigrations(db, { fts5Available: false });
    db.prepare("INSERT INTO conversations(session_id,created_at,updated_at) VALUES(?,?,?)").run("receipt-session", capturedAt, capturedAt);
    db.prepare("INSERT INTO messages(conversation_id,seq,role,content,token_count,created_at) VALUES(1,0,'user','Ordinary canonical message',4,?)").run(capturedAt);
    db.prepare("INSERT INTO promoted(id,content,project_id,created_at) VALUES(?,?,?,?)").run(memoryId, "Ordinary promoted memory", projectIdentity.projectId, capturedAt);
  });
  chmodSync(path, 0o600);
  return { dir, path };
}

/** Valid test-only epoch and applied/no-effect receipts; #622 owns authentication. */
function seedReceipts(db: DatabaseSync) {
  const epoch = { version: 1, projectId: projectIdentity.projectId, machineId, epochId,
    firstMachineSequence: "0000000000000000001", establishedAt: capturedAt };
  db.prepare("INSERT INTO migration_receipt_v1_epochs VALUES(?,?,?,?,?,?)")
    .run(epoch.projectId, machineId, epochId, epoch.firstMachineSequence, epoch.establishedAt, canonicalSha256(epoch));
  for (const [index, outcome] of ["applied", "no-effect"].entries()) {
    const eventUuid = index === 0 ? "44444444-4444-4444-8444-444444444444" : "55555555-5555-4555-8555-555555555555";
    const machineSequence = String(index + 1).padStart(19, "0");
    const envelope = { version: 1, eventUuid, eventVersion: 1, machineId, machineSequence,
      sessionId: "receipt-session", sessionSequence: index + 1, type: "observation", category: "decision",
      data: `private receipt envelope ${outcome}`, priority: 1, sourceHook: "fixture", createdAt: capturedAt };
    const effectWitness = outcome === "applied" ? { version: 1, outcome, promotedMemoryId: memoryId }
      : { version: 1, outcome, reason: "unreinforced-pattern" };
    const receipt = { version: 1, projectId: epoch.projectId, machineId, epochId, eventUuid, machineSequence,
      envelopeSha256: canonicalSha256(envelope), outcome, effectWitness, committedAt: capturedAt };
    db.prepare("INSERT INTO migration_receipt_v1_events VALUES(?,?,?,?,?,?,?,?,?,?)").run(epoch.projectId, machineId, epochId,
      eventUuid, machineSequence, receipt.envelopeSha256, outcome, canonicalJson(effectWitness), capturedAt, canonicalSha256(receipt));
  }
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}
function plant(path: string, sql = receiptSql, populated = false) {
  withDatabase(path, db => { db.exec(sql); if (populated) seedReceipts(db); });
}
function privateSnapshot(path: string): string {
  return withDatabase(path, db => canonicalJson({
    ddl: db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name LIKE 'migration_receipt_v1_%' ORDER BY name").all(),
    epochs: db.prepare("SELECT * FROM migration_receipt_v1_epochs ORDER BY project_id,machine_id").all(),
    events: db.prepare("SELECT * FROM migration_receipt_v1_events ORDER BY machine_sequence,event_uuid").all(),
  }));
}
function receiptTables(path: string) {
  return withDatabase(path, db => db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'migration_receipt_v1_%' ORDER BY name").all());
}
async function sourceAt(path: string, dir: string, archive = false) {
  return own(await createPortableRecordStream(await openSqlitePortableSource({ databasePath: path, projectIdentity,
    expectedFileSha256: sqlitePortableFileSha256(path), capturedAt, scratchParent: dir,
    ...(!archive ? { identityFacts: facts, expectedFactsSha256: canonicalSha256(facts), capturedSidecars: {
      events: { absent: true as const, evidenceSha256: "e".repeat(64) }, instructions: { absent: true as const, evidenceSha256: "f".repeat(64) },
    } } : {}),
  })));
}
async function corpus(source: PortableRecordStream) {
  const records: PortableRecord[] = [];
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    let after: PortableCheckpoint | undefined;
    do {
      const batch = await source.readBatch({ domain, after, maxRecords: 500, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
      records.push(...batch.records); after = batch.checkpoint;
      await source.verify(after);
    } while (!after.complete);
  }
  return { records, contentSha256: source.describe().contentSha256,
    domains: source.describe().domains.map(({ domain, recordCount, prefixSha256 }) => ({ domain, recordCount, prefixSha256 })) };
}
async function destination(path: string, dir: string, mode: "create" | "resume" = "create") {
  return own(await openSqlitePortableDestination({ databasePath: path, projectIdentity, generationIdentitySha256: "c".repeat(64), mode, scratchParent: dir }));
}
async function bootstrap(source: PortableRecordStream, target: PortableRecordWriter) {
  const manifest = source.describe();
  await target.admit(manifest, await target.preflight(manifest, source));
  // Commit the initial dependency-ordered checkpoints before closing so the
  // receipt-bearing target exercises resume with an existing archive project.
  for (const domain of ["machines", "project"] as const) {
    await target.applyBatch(await source.readBatch({ domain, maxRecords: 500, maxBytes: PORTABLE_LIMITS.maxBatchBytes }));
  }
  await target.close();
}

describe("optional migration receipt v1 schema through public portable adapters", () => {
  it("preserves canonical records with neither, empty, and populated exact receipt tables without source writes", async () => {
    const f = fixture();
    const baseline = await sourceAt(f.path, f.dir);
    const expected = await corpus(baseline);
    expect(expected.domains.map(row => row.domain)).toEqual(PORTABLE_RECORD_DOMAIN_ORDER);
    for (const populated of [false, true]) {
      const path = join(f.dir, populated ? "populated.db" : "empty.db");
      copyFileSync(f.path, path); plant(path, receiptSql, populated);
      const bytes = readFileSync(path); const receipts = privateSnapshot(path);
      const source = await sourceAt(path, f.dir);
      expect(await corpus(source)).toEqual(expected);
      expect(source.describe().source.sourceIdentitySha256).not.toBe(baseline.describe().source.sourceIdentitySha256);
      expect(source.describe().source.sourceWitnessSha256).not.toBe(baseline.describe().source.sourceWitnessSha256);
      await source.close();
      expect(privateSnapshot(path)).toBe(receipts);
      expect(readFileSync(path)).toEqual(bytes);
    }
  });

  const malformed = [
    ["epochs only", receiptSql.slice(0, eventDdlStart)],
    ["events only", receiptSql.slice(eventDdlStart)],
    ["missing column", receiptSql.replace("  established_at TEXT NOT NULL,\n", "")],
    ["extra column", receiptSql.replace("  established_at TEXT NOT NULL,", "  established_at TEXT NOT NULL,\n  extra TEXT,")],
    ["wrong column order", receiptSql.replace("  project_id TEXT NOT NULL,\n  machine_id TEXT NOT NULL,", "  machine_id TEXT NOT NULL,\n  project_id TEXT NOT NULL,")],
    ["wrong column type", receiptSql.replace("established_at TEXT", "established_at INTEGER")],
    ["generated column", receiptSql.replace("established_at TEXT NOT NULL", "established_at TEXT GENERATED ALWAYS AS ('fixed') VIRTUAL")],
    ["event missing column", receiptSql.replace("  committed_at TEXT NOT NULL,\n", "")],
    ["event extra column", receiptSql.replace("  committed_at TEXT NOT NULL,", "  committed_at TEXT NOT NULL,\n  extra TEXT,")],
    ["event wrong column order", receiptSql.replace("  epoch_id TEXT NOT NULL,\n  event_uuid TEXT NOT NULL,", "  event_uuid TEXT NOT NULL,\n  epoch_id TEXT NOT NULL,")],
    ["event wrong column type", receiptSql.replace("committed_at TEXT", "committed_at INTEGER")],
    ["event generated column", receiptSql.replace("committed_at TEXT NOT NULL", "committed_at TEXT GENERATED ALWAYS AS ('fixed') VIRTUAL")],
    ["unknown third table", receiptSql + "CREATE TABLE migration_receipt_v1_other(value TEXT);"],
    ["unexpected view", receiptSql + "CREATE VIEW migration_receipt_v1_view AS SELECT * FROM migration_receipt_v1_epochs;"],
    ["unexpected trigger", receiptSql + "CREATE TRIGGER migration_receipt_v1_trigger AFTER INSERT ON migration_receipt_v1_epochs BEGIN SELECT 1; END;"],
  ] as const;
  it.each(malformed)("refuses source %s without changing its bytes", async (_label, ddl) => {
    const f = fixture(); plant(f.path, ddl);
    const bytes = readFileSync(f.path);
    await expect(sourceAt(f.path, f.dir)).rejects.toMatchObject({ code: "unsupported-capability" });
    expect(readFileSync(f.path)).toEqual(bytes);
  });

  it.each(["UTF-16le", "user version", "base column", "epoch NUL", "event NUL"])("retains the existing %s boundary with receipt tables", async kind => {
    const f = fixture(kind === "UTF-16le" ? kind : "UTF-8"); plant(f.path, receiptSql, true);
    withDatabase(f.path, db => {
      if (kind === "user version") db.exec("PRAGMA user_version=1");
      if (kind === "base column") db.exec("ALTER TABLE messages ADD COLUMN unknown TEXT");
      if (kind === "epoch NUL") db.prepare("UPDATE migration_receipt_v1_epochs SET established_at=?").run("hidden\0value");
      if (kind === "event NUL") db.prepare("UPDATE migration_receipt_v1_events SET effect_witness_json=?").run("hidden\0value");
    });
    const bytes = readFileSync(f.path);
    await expect(sourceAt(f.path, f.dir)).rejects.toMatchObject({ code: "unsupported-capability" });
    expect(readFileSync(f.path)).toEqual(bytes);
  });

  it("transfers receipt-bearing sources without manufacturing or copying private tables", async () => {
    const f = fixture(); plant(f.path, receiptSql, true);
    const before = readFileSync(f.path); const source = await sourceAt(f.path, f.dir);
    const expected = await corpus(source); const targetPath = join(f.dir, "target.db");
    await expect(runPortableTransfer({ source, destination: await destination(targetPath, f.dir) }))
      .resolves.toMatchObject({ contentSha256: expected.contentSha256 });
    expect(withDatabase(targetPath, db => db.prepare("SELECT complete FROM transfer_runs").get())).toEqual({ complete: 1 });
    expect(receiptTables(targetPath)).toEqual([]);
    expect(await corpus(await sourceAt(targetPath, f.dir, true))).toEqual(expected);
    expect(readFileSync(f.path)).toEqual(before);
  });

  it.each([false, true])("resumes an exact receipt-bearing archive and retains its private rows (populated=%s)", async populated => {
    const f = fixture(); const source = await sourceAt(f.path, f.dir); const expected = await corpus(source);
    const targetPath = join(f.dir, "target.db");
    await bootstrap(source, await destination(targetPath, f.dir));
    plant(targetPath, receiptSql, populated);
    const receipts = privateSnapshot(targetPath);
    await expect(runPortableTransfer({ source, destination: await destination(targetPath, f.dir, "resume") }))
      .resolves.toMatchObject({ contentSha256: expected.contentSha256 });
    expect(withDatabase(targetPath, db => db.prepare("SELECT complete FROM transfer_runs").get())).toEqual({ complete: 1 });
    expect(privateSnapshot(targetPath)).toBe(receipts);
    const archive = await sourceAt(targetPath, f.dir, true);
    expect(await corpus(archive)).toEqual(expected);
    await archive.close();
    expect(privateSnapshot(targetPath)).toBe(receipts);
  });

  it.each(malformed)("refuses resumed destination %s without changing private state", async (_label, ddl) => {
    const f = fixture(); const source = await sourceAt(f.path, f.dir); const targetPath = join(f.dir, "target.db");
    await bootstrap(source, await destination(targetPath, f.dir));
    plant(targetPath, ddl); const bytes = readFileSync(targetPath);
    await expect(destination(targetPath, f.dir, "resume")).rejects.toMatchObject({ code: "unsupported-capability" });
    expect(readFileSync(targetPath)).toEqual(bytes);
  });
});
