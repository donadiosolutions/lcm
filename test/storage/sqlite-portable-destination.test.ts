import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { buildDomainDrafts, buildDomainRecords, buildRecords, createFixtureSource, createGeneration, sqliteBoundGeneration } from "../fixtures/portable-records.js";
import { initializePortableArchive, PORTABLE_ARCHIVE_DOMAINS, writePortableArchiveRecord } from "../../src/storage/sqlite/portable-archive.js";
import { writePortableRuntimeRecord } from "../../src/storage/sqlite/portable-runtime-mapping.js";
import * as migration from "../../src/db/migration.js";
import { openSqlitePortableSource, sqlitePortableFileSha256 } from "../../src/storage/sqlite/portable-source.js";
import { applyPortableBatchInTransaction, openSqlitePortableDestination } from "../../src/storage/sqlite/portable-destination.js";
import type { OpenSqlitePortableDestinationInput } from "../../src/storage/sqlite/portable-destination.js";
import { canonicalSha256, createPortableBatch, createPortableManifest, createPortableRecord, sha256, createPortableRecordStream, serializePortableCheckpoint, PORTABLE_LIMITS, PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record-stream.js";
import type { PortableBatch, PortableCheckpoint, PortableRecordStream } from "../../src/storage/portable-record-stream.js";
import { runPortableTransfer } from "../../src/storage/portable-transfer.js";
import type { PortableRecordWriter } from "../../src/storage/portable-transfer.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

const dirs: string[] = [];
const handles: {close(): void | Promise<void>}[] = [];
const projectIdentity = { scope: "local", projectId: "a".repeat(64) } as const;
const facts = { machines: [{ identityKey: "local-machine", machineId: null }], aliases: [] };
const capturedAt = "2026-09-06T00:00:00.000000Z";
const generationIdentitySha256 = "b".repeat(64);
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lcm-sqlite-target-")); dirs.push(dir);
  const path = join(dir, "source.db");
  const db = new DatabaseSync(path);
  migration.runLcmMigrations(db, { fts5Available: false });
  db.prepare("INSERT INTO conversations(session_id,created_at,updated_at) VALUES(?,?,?)").run("hello", capturedAt, capturedAt);
  db.exec("INSERT INTO messages(conversation_id,seq,role,content,token_count) VALUES(1,0,'user','real SQL content',9007199254740993),(1,1,'assistant','second message',2)");
  db.close(); chmodSync(path, 0o600);
  const source = await sourceAt(path, dir);
  return { dir, path, source, target: join(dir, "target.db") };
}
async function sourceAt(path: string, dir: string) {
  const source = await createPortableRecordStream(await openSqlitePortableSource({ databasePath: path, projectIdentity, identityFacts: facts, capturedSidecars: { events: { absent: true, evidenceSha256: "e".repeat(64) }, instructions: { absent: true, evidenceSha256: "f".repeat(64) } }, expectedFactsSha256: canonicalSha256(facts), expectedFileSha256: sqlitePortableFileSha256(path), capturedAt, scratchParent: dir }));
  handles.push(source); return source;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function destination(f: Fixture, extra: Partial<OpenSqlitePortableDestinationInput> = {}) {
  const writer = await openSqlitePortableDestination({ databasePath: f.target, projectIdentity, generationIdentitySha256, mode: "create", scratchParent: f.dir, ...extra });
  handles.push(writer); return writer;
}
async function admit(f: Fixture, writer: PortableRecordWriter) {
  const manifest = f.source.describe();
  await writer.admit(manifest, await writer.preflight(manifest, f.source));
  return manifest;
}
async function batches(source: PortableRecordStream, maxRecords = 500) {
  const result: PortableBatch[] = [];
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    let after: PortableCheckpoint | undefined;
    do {
      const batch = await source.readBatch({ domain, after, maxRecords, maxBytes: 4 * 1024 * 1024 });
      result.push(batch); after = batch.checkpoint;
    } while (!after.complete);
  }
  return result;
}
function sql(f: Fixture, action: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(f.target);
  try { action(db); } finally { db.close(); }
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0).reverse()) await handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SQLite canonical destination", () => {
  it("rejects oversized valid durable control JSON before the driver materializes it", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer);
    const oversized=" ".repeat(PORTABLE_LIMITS.maxControlBytes+1)+"[]";
    sql(f,db=>db.prepare("UPDATE transfer_runs SET checkpoints_json=?").run(oversized));
    let largestReturnedControl=0;
    const get=StatementSync.prototype.get;
    const spy=vi.spyOn(StatementSync.prototype,"get").mockImplementation(function(this:StatementSync,...args){
      const result=get.apply(this,args);
      if(result&&"checkpoints_json" in result){
        const value=result.checkpoints_json;
        if(typeof value==="string")largestReturnedControl=Math.max(largestReturnedControl,Buffer.byteLength(value));
        else if(value instanceof Uint8Array)largestReturnedControl=Math.max(largestReturnedControl,value.byteLength);
      }
      return result;
    });
    const outcome=await writer.readProgress(manifest.manifestSha256).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    spy.mockRestore();
    expect(largestReturnedControl).toBeLessThanOrEqual(PORTABLE_LIMITS.maxControlBytes);
    expect(outcome.error).toMatchObject({code:"checkpoint-mismatch"});
    sql(f,db=>expect(db.prepare("SELECT length(CAST(checkpoints_json AS BLOB)) AS bytes,complete FROM transfer_runs").get()).toEqual({bytes:Buffer.byteLength(oversized),complete:0}));
  });
  it("refuses an imported source ledger with oversized individually valid checkpoints JSON before fetching it", async () => {
    const f=await fixture();
    await runPortableTransfer({source:f.source,destination:await destination(f)});
    sql(f,db=>db.prepare("UPDATE transfer_runs SET checkpoints_json=?||checkpoints_json").run(" ".repeat(PORTABLE_LIMITS.maxControlBytes+1)));
    let largestReturnedControl=0;
    const get=StatementSync.prototype.get;
    const spy=vi.spyOn(StatementSync.prototype,"get").mockImplementation(function(this:StatementSync,...args){
      const result=get.apply(this,args);
      if(result&&"checkpoints_json" in result){
        const value=result.checkpoints_json;
        if(typeof value==="string")largestReturnedControl=Math.max(largestReturnedControl,Buffer.byteLength(value));
        else if(value instanceof Uint8Array)largestReturnedControl=Math.max(largestReturnedControl,value.byteLength);
      }
      return result;
    });
    const outcome=await openSqlitePortableSource({databasePath:f.target,projectIdentity,expectedFileSha256:sqlitePortableFileSha256(f.target),capturedAt,scratchParent:f.dir}).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    spy.mockRestore();
    if(outcome.value)handles.push(outcome.value);
    expect(largestReturnedControl).toBeLessThanOrEqual(PORTABLE_LIMITS.maxControlBytes);
    expect(outcome.error).toMatchObject({code:"verification-failed"});
  });

  it.each(["manifest_json","project_json","checkpoint_json"])("bounds malformed resumed ledger control %s before comparison or parse", async field => {
    const f=await fixture();const first=await destination(f);const manifest=await admit(f,first);
    const batch=(await batches(f.source))[0];await first.applyBatch(batch);await first.close();
    sql(f,db=>{
      const table=field==="checkpoint_json"?"transfer_batches":"transfer_runs";
      let trigger:string|undefined;
      if(field==="checkpoint_json"){
        trigger=String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='transfer_batches_no_update'").get()!.sql);
        db.exec("DROP TRIGGER transfer_batches_no_update");
      }
      db.prepare(`UPDATE ${table} SET ${field}=?||${field}`).run(" ".repeat(PORTABLE_LIMITS.maxControlBytes+1));
      if(trigger!==undefined)db.exec(trigger);
    });
    let largest=0;const get=StatementSync.prototype.get;
    const spy=vi.spyOn(StatementSync.prototype,"get").mockImplementation(function(this:StatementSync,...args){
      const row=get.apply(this,args);const value=row?.[field];
      if(typeof value==="string")largest=Math.max(largest,Buffer.byteLength(value));
      else if(value instanceof Uint8Array)largest=Math.max(largest,value.byteLength);
      return row;
    });
    const operation=async()=>{
      const resumed=await destination(f,{mode:"resume"});
      await admit(f,resumed);
      await resumed.readProgress(manifest.manifestSha256);
    };
    const failure=await operation().then(()=>undefined,error=>error);
    spy.mockRestore();
    expect(largest).toBeLessThanOrEqual(PORTABLE_LIMITS.maxControlBytes);
    expect(failure).toMatchObject({code:field==="checkpoint_json"?"checkpoint-mismatch":"destination-conflict"});
    sql(f,db=>expect(db.prepare("SELECT count(*) AS count FROM transfer_batches").get()).toEqual({count:1}));
  });

  it("writes runtime data and verifies all real SQL domains", async () => {
    const f = await fixture();
    const result = await runPortableTransfer({ source: f.source, destination: await destination(f) });
    expect(result.checkpoints).toHaveLength(22);
    sql(f, db => {
      expect(db.prepare("SELECT content, CAST(token_count AS TEXT) AS tokens FROM messages WHERE seq=0").get()).toEqual({ content: "real SQL content", tokens: "9007199254740993" });
      expect(db.prepare("SELECT complete FROM transfer_runs").get()).toEqual({ complete: 1 });
    });
  });

  it("rolls back data, identities, receipts and checkpoints before commit", async () => {
    const f = await fixture(); let fail = true;
    const writer = await destination(f, { _transactionObserver(stage) { if (fail && stage === "before-commit") throw new Error("sensitive driver failure"); } });
    const manifest = await admit(f, writer); const batch = (await batches(f.source))[0];
    await expect(writer.applyBatch(batch)).rejects.toMatchObject({ code: "destination-failed", message: "Portable transfer error: destination-failed" });
    expect((await writer.readProgress(manifest.manifestSha256)).checkpoints).toEqual([]);
    sql(f, db => { for (const table of ["transfer_identities", "transfer_batches", "portable_archive_machines"]) expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 }); });
    fail = false;
    expect(await writer.applyBatch(batch)).toEqual(batch.checkpoint);
  });

  it("reconciles a lost commit acknowledgement and replays its exact receipt once", async () => {
    const f = await fixture();
    const writer = await destination(f, { _transactionObserver(stage) { if (stage === "after-commit") throw new Error("lost acknowledgment"); } });
    const manifest = await admit(f, writer); const batch = (await batches(f.source))[0];
    expect(await writer.applyBatch(batch)).toEqual(batch.checkpoint);
    expect(await writer.applyBatch(batch)).toEqual(batch.checkpoint);
    expect((await writer.readProgress(manifest.manifestSha256)).checkpoints).toEqual([batch.checkpoint]);
    sql(f, db => expect(db.prepare("SELECT count(*) AS count FROM transfer_batches").get()).toEqual({ count: 1 }));
  });

  it("resumes an interrupted partial domain using the same file and exact manifest", async () => {
    const f = await fixture(); const first = await destination(f); const manifest = await admit(f, first);
    const all = await batches(f.source, 1); const stop = all.findIndex(batch => batch.domain === "messages");
    for (const batch of all.slice(0, stop + 1)) await first.applyBatch(batch);
    expect((await first.readProgress(manifest.manifestSha256)).checkpoints.at(-1)?.complete).toBe(false);
    await first.close();
    const resumed = await destination(f, { mode: "resume" });
    await admit(f, resumed);
    expect(await resumed.applyBatch(all[stop])).toEqual(all[stop].checkpoint);
    for (const batch of all.slice(stop + 1)) await resumed.applyBatch(batch);
    expect(await resumed.verifyComplete(manifest)).toMatchObject({ complete: true, contentSha256: manifest.contentSha256 });
    await resumed.close();
    const completed = await destination(f, { mode: "resume" }); await admit(f, completed);
    expect((await completed.readProgress(manifest.manifestSha256)).complete).toBe(true);
    expect(await completed.applyBatch(all[0])).toEqual(all[0].checkpoint);
  });

  it("refuses wrong generation, project, or manifest on resume", async () => {
    const f = await fixture(); const writer = await destination(f); await admit(f, writer); await writer.close();
    await expect(destination(f, { mode: "resume", generationIdentitySha256: "c".repeat(64) })).rejects.toMatchObject({ code: "destination-conflict" });
    await expect(destination(f, { mode: "resume", projectIdentity: { ...projectIdentity, projectId: "d".repeat(64) } })).rejects.toMatchObject({ code: "destination-conflict" });
    await f.source.close(); const original = new DatabaseSync(f.path); original.exec("UPDATE messages SET content='new generation'"); original.close();
    const changed = await sourceAt(f.path, f.dir); const resumed = await destination(f, { mode: "resume" });
    await expect(resumed.admit(changed.describe(), await resumed.preflight(changed.describe(), changed))).rejects.toMatchObject({ code: "destination-conflict" });
  });

  it("refuses skipped domains, unknown prior receipts and altered source records", async () => {
    const f = await fixture(); const writer = await destination(f); await admit(f, writer); const all = await batches(f.source, 1);
    await expect(writer.applyBatch(all[1])).rejects.toMatchObject({ code: "checkpoint-mismatch" });
    const secondMessage = all.find(batch => batch.domain === "messages" && batch.priorCheckpointSha256 !== null)!;
    await expect(writer.applyBatch(secondMessage)).rejects.toMatchObject({ code: "checkpoint-mismatch" });
    const altered = { ...all[0], records: [{ ...all[0].records[0], recordSha256: "0".repeat(64) }] } as PortableBatch;
    await expect(writer.applyBatch(altered)).rejects.toMatchObject({ code: "checkpoint-mismatch" });
    const unknown = { ...all[0], records: [{ ...all[0].records[0], identitySha256: "0".repeat(64) }] } as PortableBatch;
    await expect(writer.applyBatch(unknown)).rejects.toMatchObject({ code: "checkpoint-mismatch" });
    await writer.applyBatch(all[0]);
    await expect(writer.applyBatch({ ...all[0], framedBytes: all[0].framedBytes + 1 })).rejects.toMatchObject({ code: "checkpoint-mismatch" });
  });

  it("rejects incomplete progress and hashes actual native tables at final verification", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer);
    await expect(writer.verifyComplete(manifest)).rejects.toMatchObject({ code: "checkpoint-mismatch" });
    for (const batch of await batches(f.source)) await writer.applyBatch(batch);
    sql(f, db => db.exec("UPDATE messages SET content='tampered after receipt'"));
    await expect(writer.verifyComplete(manifest)).rejects.toMatchObject({ code: "verification-failed" });
    expect((await writer.readProgress(manifest.manifestSha256)).complete).toBe(false);
  });

  it("refuses nonempty unowned files and resume without a ledger", async () => {
    const f = await fixture();
    await expect(destination(f, { databasePath: f.path })).rejects.toMatchObject({ code: "destination-conflict" });
    await expect(destination(f, { databasePath: f.path, mode: "resume" })).rejects.toMatchObject({ code: "destination-conflict" });
  });

  it("refuses held targets and releases ownership on idempotent close", async () => {
    const f = await fixture(); const writer = await destination(f);
    await expect(destination(f, { mode: "resume" })).rejects.toMatchObject({ code: "destination-conflict" });
    const manifest = await admit(f, writer); await writer.close(); await writer.close();
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: "destination-conflict" });
    await expect(destination(f, { mode: "resume" })).resolves.toBeDefined();
  });

  it.each(["file-mode", "parent-mode", "replace-inode", "missing-file", "symlink"])("revokes capability when target changes: %s", async kind => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer);
    if (kind === "file-mode") chmodSync(f.target, 0o644);
    if (kind === "parent-mode") chmodSync(f.dir, 0o755);
    if (kind === "replace-inode") { renameSync(f.target, `${f.target}.old`); writeFileSync(f.target, "", { mode: 0o600 }); }
    if (kind === "missing-file") rmSync(f.target);
    if (kind === "symlink") { renameSync(f.target, `${f.target}.old`); symlinkSync(`${f.target}.old`, f.target); }
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: "destination-conflict" });
    if (kind === "file-mode") chmodSync(f.target, 0o600);
    if (kind === "parent-mode") chmodSync(f.dir, 0o700);
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: "destination-conflict" });
  });

  it("rejects unsafe parents, symlink targets, invalid inputs and WAL files", async () => {
    const f = await fixture();
    await expect(destination(f, { generationIdentitySha256: "invalid" })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(destination(f, { mode: "unsafe" as "create" })).rejects.toMatchObject({ code: "invalid-input" });
    chmodSync(f.dir, 0o755);
    await expect(destination(f)).rejects.toMatchObject({ code: "destination-conflict" }); chmodSync(f.dir, 0o700);
    symlinkSync(f.path, f.target);
    await expect(destination(f, { mode: "resume" })).rejects.toMatchObject({ code: "destination-conflict" }); rmSync(f.target);
    const db = new DatabaseSync(f.target); db.exec("PRAGMA journal_mode=WAL"); db.close(); chmodSync(f.target, 0o600);
    await expect(destination(f, { mode: "resume" })).rejects.toMatchObject({ code: "unsupported-capability" });
  });

  it("admits only its own branded preflight and rejects unknown transaction authority", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = f.source.describe(); const proof = await writer.preflight(manifest, f.source);
    await expect(writer.admit(manifest, { ...proof })).rejects.toMatchObject({ code: "destination-conflict" });
    const other = await destination(f, { databasePath: join(f.dir, "other.db") });
    await expect(other.admit(manifest, proof)).rejects.toMatchObject({ code: "destination-conflict" });
    const batch = (await batches(f.source))[0];
    await expect(writer.applyBatch(batch)).rejects.toMatchObject({ code: "destination-conflict" });
    await expect(writer.verifyComplete(manifest)).rejects.toMatchObject({ code: "destination-conflict" });
    sql(f, db => expect(() => applyPortableBatchInTransaction(db, {}, batch)).toThrow(expect.objectContaining({ code: "destination-conflict" })));
    const renewed = await writer.preflight(manifest, f.source);
    await expect(writer.admit(manifest, proof)).rejects.toMatchObject({ code: "destination-conflict" });
    await writer.admit(manifest, renewed);
  });

  it("honors abort on opening and every admitted operation", async () => {
    const f = await fixture(); const signal = AbortSignal.abort();
    await expect(destination(f, { databasePath: join(f.dir, "aborted.db"), signal })).rejects.toMatchObject({ code: "aborted" });
    const writer = await destination(f); const manifest = f.source.describe();
    await expect(writer.preflight(manifest, f.source, signal)).rejects.toMatchObject({ code: "aborted" });
    const proof = await writer.preflight(manifest, f.source);
    await expect(writer.admit(manifest, proof, signal)).rejects.toMatchObject({ code: "aborted" });
    await writer.admit(manifest, proof);
    const batch = (await batches(f.source))[0];
    await expect(writer.applyBatch(batch, signal)).rejects.toMatchObject({ code: "aborted" });
    await expect(writer.readProgress(manifest.manifestSha256, signal)).rejects.toMatchObject({ code: "aborted" });
    await expect(writer.verifyComplete(manifest, signal)).rejects.toMatchObject({ code: "aborted" });
    expect((await writer.readProgress(manifest.manifestSha256)).checkpoints).toEqual([]);
  });

  it("sanitizes source exceptions and refuses a source/manifest mismatch", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = f.source.describe();
    const broken = { ...f.source, readBatch: async () => { throw new Error("postgres://secret@host/private-record"); } };
    await expect(writer.preflight(manifest, broken)).rejects.toMatchObject({ message: "Portable transfer error: destination-failed" });
    await expect(writer.preflight(manifest, { ...f.source, describe: () => ({ ...manifest, manifestSha256: "f".repeat(64) }) })).rejects.toMatchObject({ code: "checkpoint-mismatch" });
    await admit(f, writer);
    await expect(writer.readProgress("0".repeat(64))).rejects.toMatchObject({ code: "destination-conflict" });
  });

  it("resumes authenticated bootstrap after migration failure before schema_ready", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = f.source.describe(); const proof = await writer.preflight(manifest, f.source);
    vi.spyOn(migration, "runLcmMigrations").mockImplementationOnce(() => { throw new Error("migration interrupted"); });
    await expect(writer.admit(manifest, proof)).rejects.toMatchObject({ code: "destination-failed" });
    sql(f, db => expect(db.prepare("SELECT schema_ready FROM transfer_runs").get()).toEqual({ schema_ready: 0 }));
    await writer.close();
    const resumed = await destination(f, { mode: "resume" }); await admit(f, resumed);
    sql(f, db => expect(db.prepare("SELECT schema_ready FROM transfer_runs").get()).toEqual({ schema_ready: 1 }));
    for (const batch of await batches(f.source)) await resumed.applyBatch(batch);
    expect(await resumed.verifyComplete(manifest)).toMatchObject({ complete: true });
  });
  it("round trips all populated runtime and archive domains from real SQLite", async () => {
    const f = await fixture(); const options = sqliteBoundGeneration();
    const path = join(f.dir, "full-source.db"); const db = new DatabaseSync(path);
    migration.runLcmMigrations(db, { fts5Available: false }); initializePortableArchive(db);
    const identities = new Map<string, string>();
    db.exec("BEGIN");
    for (const [domain, records] of buildRecords(options)) {
      for (const record of records) {
        const locator = (PORTABLE_ARCHIVE_DOMAINS as readonly string[]).includes(domain)
          ? (writePortableArchiveRecord(db, record), record.identitySha256)
          : writePortableRuntimeRecord(db, record, (dependency, identity) => identities.get(`${dependency}:${identity}`)!, options.projectIdentity);
        identities.set(`${domain}:${record.identitySha256}`, locator);
      }
    }
    db.exec("COMMIT"); db.close(); chmodSync(path, 0o600);
    const source = await createPortableRecordStream(await openSqlitePortableSource({ databasePath: path, projectIdentity: options.projectIdentity, expectedFileSha256: sqlitePortableFileSha256(path), capturedAt, scratchParent: f.dir }));
    handles.push(source);
    const writer = await destination(f, { projectIdentity: options.projectIdentity });
    const manifest = source.describe();
    expect(manifest.domains.every(domain => domain.recordCount > 0)).toBe(true);
    const result = await runPortableTransfer({ source, destination: writer, maxRecords: 1 });
    expect(result.contentSha256).toBe(manifest.contentSha256);
    sql(f, db => {
      expect(db.prepare("SELECT count(*) AS n FROM messages").get()!.n).toBeGreaterThan(1);
      expect(db.prepare("SELECT tags FROM promoted WHERE id='memory-alpha-1'").get()).toEqual({ tags: '["storage","protocol","storage"]' });
      expect(db.prepare("SELECT count(*) AS n FROM portable_archive_native_transcripts").get()!.n).toBeGreaterThan(0);
    });
  });

  it.each(["project", "manifest", "run"])("revokes target authority on durable identity drift: %s", async kind => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer);
    sql(f, db => db.exec(kind === "project" ? "UPDATE transfer_runs SET project_json='{}'" : kind === "manifest" ? "UPDATE transfer_runs SET manifest_sha='changed'" : "DELETE FROM transfer_runs"));
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: "destination-conflict" });
    await expect(writer.preflight(manifest, f.source)).rejects.toMatchObject({ code: "destination-conflict" });
  });

  it.each(["{}", JSON.stringify(Array(23).fill("{}")), "not JSON"])("rejects malformed durable checkpoint state: %s", async checkpoints => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer);
    sql(f, db => db.prepare("UPDATE transfer_runs SET checkpoints_json=?").run(checkpoints));
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: checkpoints === "not JSON" ? "destination-failed" : "checkpoint-mismatch" });
  });

  it("refuses unrelated tables inserted between target creation and admission", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = f.source.describe(); const proof = await writer.preflight(manifest, f.source);
    sql(f, db => db.exec("CREATE TABLE unrelated(secret TEXT); INSERT INTO unrelated VALUES('keep')"));
    await expect(writer.admit(manifest, proof)).rejects.toMatchObject({ code: "destination-conflict" });
    sql(f, db => expect(db.prepare("SELECT secret FROM unrelated").get()).toEqual({ secret: "keep" }));
  });

  it("reports uncertain commit if the durable target cannot be reauthenticated", async () => {
    const f = await fixture(); const writer = await destination(f, { _transactionObserver(stage) { if (stage === "after-commit") { chmodSync(f.target, 0o644); throw new Error("lost commit"); } } });
    await admit(f, writer); const batch = (await batches(f.source))[0];
    await expect(writer.applyBatch(batch)).rejects.toMatchObject({ code: "destination-uncertain", retryable: true });
    chmodSync(f.target, 0o600);
    sql(f, db => expect(db.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 1 }));
  });

  it("rejects corrupt receipt data returned during commit reconciliation", async () => {
    const f = await fixture(); const writer = await destination(f, { _transactionObserver(stage) { if (stage === "after-commit") throw new Error("lost commit"); } });
    await admit(f, writer); const batch = (await batches(f.source))[0];
    const get = StatementSync.prototype.get;
    vi.spyOn(StatementSync.prototype, "get").mockImplementation(function(this: StatementSync, ...args) {
      const row = Reflect.apply(get, this, args);
      return row && "batch_sha" in row && "checkpoint_json" in row ? { ...row, batch_sha: Buffer.from("corrupt read") } : row;
    });
    await expect(writer.applyBatch(batch)).rejects.toMatchObject({ code: "checkpoint-mismatch" });
    await expect(writer.applyBatch(batch)).rejects.toMatchObject({ code: "checkpoint-mismatch" });
  });

  it("keeps no receipt or progress after a failed SQLite commit", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer); const batch = (await batches(f.source))[0];
    const exec = DatabaseSync.prototype.exec;
    const fault = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, statement) {
      if (statement === "COMMIT") { fault.mockRestore(); exec.call(this, "ROLLBACK"); throw new Error("commit failed"); }
      return exec.call(this, statement);
    });
    await expect(writer.applyBatch(batch)).rejects.toMatchObject({ code: "destination-failed" });
    expect((await writer.readProgress(manifest.manifestSha256)).checkpoints).toEqual([]);
    expect(await writer.applyBatch(batch)).toEqual(batch.checkpoint);
  });

  it("reports close failure while permanently revoking its capability", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer);
    const original = DatabaseSync.prototype.close; const failed: DatabaseSync[] = [];
    const fault = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) { failed.push(this); throw new Error("secret close failure"); });
    await expect(writer.close()).rejects.toMatchObject({ code: "close-failed", message: "Portable transfer error: close-failed" });
    fault.mockRestore(); for (const db of failed) original.call(db);
    await writer.close();
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: "destination-conflict" });
  });

  it("requires an admitted authority and its own active database transaction", async () => {
    const f = await fixture(); const writer = await destination(f); const batch = (await batches(f.source))[0];
    const other = new DatabaseSync(":memory:");
    try {
      expect(() => applyPortableBatchInTransaction(other, writer, batch)).toThrow(expect.objectContaining({ code: "destination-conflict" }));
      other.exec("BEGIN");
      expect(() => applyPortableBatchInTransaction(other, writer, batch)).toThrow(expect.objectContaining({ code: "destination-conflict" }));
      await admit(f, writer);
      expect(() => applyPortableBatchInTransaction(other, writer, batch)).toThrow(expect.objectContaining({ code: "destination-conflict" }));
    } finally { other.close(); }
  });

  it("refuses new data when the durable run is marked complete", async () => {
    const f = await fixture(); const writer = await destination(f); await admit(f, writer);
    sql(f, db => db.exec("UPDATE transfer_runs SET complete=1"));
    await expect(writer.applyBatch((await batches(f.source))[0])).rejects.toMatchObject({ code: "destination-conflict" });
  });

  it("rolls back a dependent batch if its imported identity mapping disappears", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer); const all = await batches(f.source);
    const next = all.findIndex(batch => batch.domain === "messages");
    for (const batch of all.slice(0, next)) await writer.applyBatch(batch);
    const before = await writer.readProgress(manifest.manifestSha256);
    sql(f, db => db.exec("DELETE FROM transfer_identities WHERE domain='conversations'"));
    await expect(writer.applyBatch(all[next])).rejects.toMatchObject({ code: "invalid-input" });
    expect(await writer.readProgress(manifest.manifestSha256)).toEqual(before);
    sql(f, db => expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 }));
  });

  it("detects file substitution between exclusive create and database open", async () => {
    const f = await fixture(); const close = fs.closeSync; let substituted = false;
    const race = vi.spyOn(fs, "closeSync").mockImplementation(fd => {
      const opened = fs.fstatSync(fd);
      const isTarget = fs.existsSync(f.target) && fs.lstatSync(f.target).ino === opened.ino;
      close(fd);
      if (isTarget) {
        substituted = true; renameSync(f.target, `${f.target}.original`); writeFileSync(f.target, "substituted", { mode: 0o600 });
      }
    });
    await expect(destination(f)).rejects.toMatchObject({ code: "destination-conflict" });
    race.mockRestore();
    expect(substituted).toBe(true);
    expect(fs.readFileSync(f.target, "utf8")).toBe("substituted");
  });

  it("rejects an otherwise matching resume ledger containing another run", async () => {
    const f = await fixture(); const writer = await destination(f); await admit(f, writer); await writer.close();
    sql(f, db => db.exec("INSERT INTO transfer_runs SELECT 'another',project_json,'different',manifest_json,source_identity,source_witness,checkpoints_json,schema_ready,complete FROM transfer_runs"));
    await expect(destination(f, { mode: "resume" })).rejects.toMatchObject({ code: "destination-conflict" });
  });

  it("rejects a source for another project before any schema mutation", async () => {
    const f = await fixture(); const writer = await destination(f, { projectIdentity: { ...projectIdentity, projectId: "d".repeat(64) } });
    await expect(writer.preflight(f.source.describe(), f.source)).rejects.toMatchObject({ code: "unsupported-capability" });
    sql(f, db => expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]));
  });

  it("refuses noncontiguous per-memory tag ordinals during whole-source preflight", async () => {
    const f = await fixture(); const options = sqliteBoundGeneration(); const generation = createGeneration(options); const records = new Map(generation.records);
    records.set("promoted-memory-tags", records.get("promoted-memory-tags")!.map((record, ordinal) => {
      const value = record.value as { memoryId: string; ordinal: { $integer: string }; tag: string };
      return createPortableRecord({ domain: "promoted-memory-tags", ordinal, context: null, value: { ...value, ordinal: BigInt(value.ordinal.$integer) + 1n } });
    }));
    const source = await createPortableRecordStream(createFixtureSource({ description: generation.description, records })); handles.push(source);
    const writer = await destination(f, { projectIdentity: options.projectIdentity });
    await expect(writer.preflight(source.describe(), source)).rejects.toMatchObject({ code: "unsupported-capability" });
  });



  it.each(["duplicate-part", "summary-message", "summary-parent", "context", "native-link", "cycle", "missing-summary"])("rejects unrepresentable relationships during preflight: %s", async kind => {
    const f = await fixture(); const options = sqliteBoundGeneration(); const generation = createGeneration(options);
    const drafts = buildDomainDrafts(options).map(draft => ({ ...draft, values: draft.values.map(value => ({ ...value })), contexts: [...draft.contexts] }));
    const draft = (domain: string) => drafts.find(value => value.domain === domain)!;
    const messages = generation.records.get("messages")!;
    const firstMessage = messages.find(record => record.identitySha256 === draft("message-parts").values[0].messageIdentitySha256)!;
    const firstConversation = (firstMessage.value as { conversationIdentitySha256: string }).conversationIdentitySha256;
    const foreignMessage = messages.find(record => (record.value as { conversationIdentitySha256: string }).conversationIdentitySha256 !== firstConversation)!;
    if (kind === "duplicate-part") {
      const parts = draft("message-parts");
      const otherMessage = messages.find(record => record.identitySha256 !== firstMessage.identitySha256 && (record.value as { conversationIdentitySha256: string }).conversationIdentitySha256 === firstConversation)!;
      parts.values[1].partId = parts.values[0].partId;
      parts.values[1].messageIdentitySha256 = otherMessage.identitySha256;
      parts.contexts[1] = { messageOrder: otherMessage.order.map(value => typeof value === "object" && value !== null && "$integer" in value ? BigInt(value.$integer) : value) };
    }
    if (kind === "summary-message") draft("summary-message-links").values[0].messageIdentitySha256 = foreignMessage.identitySha256;
    if (kind === "summary-parent") draft("summaries").values[2].conversationIdentitySha256 = (foreignMessage.value as { conversationIdentitySha256: string }).conversationIdentitySha256;
    if (kind === "context") draft("context-items").values[0].messageIdentitySha256 = foreignMessage.identitySha256;
    if (kind === "native-link") draft("native-transcript-message-links").values[0].messageIdentitySha256 = foreignMessage.identitySha256;
    if (kind === "missing-summary") draft("summary-message-links").values[0].summaryId = "absent-summary";
    if (kind === "cycle") {
      const parents = draft("summary-parent-links"); const edge = parents.values[0];
      parents.values.push({ summaryId: edge.parentSummaryId, ordinal: 0, parentSummaryId: edge.summaryId }); parents.contexts.push(null);
    }
    const records = new Map(drafts.map(value => [value.domain, buildDomainRecords(value)]));
    const source = await createPortableRecordStream(createFixtureSource({ description: generation.description, records })); handles.push(source);
    const writer = await destination(f, { projectIdentity: options.projectIdentity });
    await expect(writer.preflight(source.describe(), source)).rejects.toMatchObject({ code: "unsupported-capability" });
    sql(f, db => expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]));
  });

  it.each(["missing-receipt", "duplicate-domain", "missing-domain"])("rejects corrupted durable progress: %s", async kind => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer); const all = await batches(f.source);
    if (kind !== "missing-receipt") for (const batch of all.slice(0, 3)) await writer.applyBatch(batch);
    sql(f, db => {
      if (kind === "missing-receipt") db.prepare("UPDATE transfer_runs SET checkpoints_json=?").run(JSON.stringify([Buffer.from(serializePortableCheckpoint(all[0].checkpoint)).toString()]));
      else {
        const entries = JSON.parse(String(db.prepare("SELECT checkpoints_json FROM transfer_runs").get()!.checkpoints_json));
        if (kind === "duplicate-domain") entries[1] = entries[0];
        else entries.splice(0, 1);
        db.prepare("UPDATE transfer_runs SET checkpoints_json=?").run(JSON.stringify(entries));
      }
    });
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: "checkpoint-mismatch" });
    await expect(writer.applyBatch(all[3])).rejects.toMatchObject({ code: "checkpoint-mismatch" });
  });

  it("rejects a self-consistent hostile stream with no project record", async () => {
    const f = await fixture(); const original = f.source.describe();
    const domains = original.domains.map(entry => ({ ...entry, recordCount: 0, prefixSha256: canonicalSha256(["lcm-portable-domain-v1", original.schemaSha256, entry.domain, 1]) }));
    let contentSha256 = canonicalSha256(["lcm-portable-content-v1", original.schemaSha256]);
    const digestLength = Buffer.alloc(8); digestLength.writeBigUInt64BE(32n);
    for (const domain of domains) contentSha256 = sha256(Buffer.concat([Buffer.from(contentSha256, "hex"), digestLength, Buffer.from(domain.prefixSha256, "hex")]));
    const manifest = createPortableManifest({ version: original.version, schemaSha256: original.schemaSha256, source: original.source, domains, contentSha256, limits: original.limits });
    const source: PortableRecordStream = {
      describe: () => manifest,
      verify: async () => { throw new Error("This hostile source cannot authorize checkpoints"); },
      readBatch: async request => createPortableBatch({ manifest, ...request, page: { predecessor: null, records: [], complete: true } }),
      close: async () => {},
    };
    const writer = await destination(f);
    await expect(writer.preflight(manifest, source)).rejects.toMatchObject({ code: "invalid-input" });
    sql(f, db => expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]));
  });

  it("never acknowledges an uncommitted receipt when a reader blocks COMMIT", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer);
    const batch = (await batches(f.source))[0];
    const reader = new DatabaseSync(f.target);
    try {
      reader.exec("BEGIN");
      expect(reader.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 0 });
      const outcome = await writer.applyBatch(batch).then(checkpoint => ({ checkpoint }), error => ({ error }));
      expect(reader.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 0 });
      expect(reader.prepare("SELECT checkpoints_json FROM transfer_runs").get()).toEqual({ checkpoints_json: "[]" });
      expect(reader.prepare("SELECT count(*) AS n FROM portable_archive_machines").get()).toEqual({ n: 0 });
      expect(outcome).toMatchObject({ error: { code: "destination-failed" } });
      reader.exec("ROLLBACK");
      expect((await writer.readProgress(manifest.manifestSha256)).checkpoints).toEqual([]);
      expect(await writer.applyBatch(batch)).toEqual(batch.checkpoint);
      expect(reader.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 1 });
      expect((await writer.readProgress(manifest.manifestSha256)).checkpoints).toEqual([batch.checkpoint]);
    } finally { reader.close(); }
  }, 15000);

  it("refuses resume when an unknown trigger is added to an owned target", async () => {
    const f = await fixture(); const writer = await destination(f); await admit(f, writer); await writer.close();
    sql(f, db => db.exec("CREATE TRIGGER unexpected_transfer_hook BEFORE INSERT ON messages BEGIN SELECT 1; END"));
    await expect(destination(f, { mode: "resume" })).rejects.toMatchObject({ code: "unsupported-capability" });
    sql(f, db => expect(db.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 0 }));
  });

  it("reports uncertainty if a failed COMMIT cannot be rolled back", async () => {
    const f = await fixture(); const writer = await destination(f); await admit(f, writer); const batch = (await batches(f.source))[0];
    const exec = DatabaseSync.prototype.exec;
    const fault = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, statement) {
      if (statement === "COMMIT" || statement === "ROLLBACK") throw new Error("injected SQLite I/O failure");
      return exec.call(this, statement);
    });
    await expect(writer.applyBatch(batch)).rejects.toMatchObject({ code: "destination-uncertain", retryable: true });
    fault.mockRestore();
    sql(f, db => expect(db.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 0 }));
    await writer.close();
    const resumed = await destination(f, { mode: "resume" }); await admit(f, resumed);
    expect(await resumed.applyBatch(batch)).toEqual(batch.checkpoint);
    sql(f, db => expect(db.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 1 }));
  });

  it("does not acknowledge a commit when independent receipt reading fails", async () => {
    const f = await fixture(); const writer = await destination(f, { _transactionObserver(stage) { if (stage === "after-commit") throw new Error("lost acknowledgement"); } });
    await admit(f, writer); const batch = (await batches(f.source))[0];
    const exec = DatabaseSync.prototype.exec;
    const fault = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, statement) {
      if (statement === "PRAGMA query_only=ON") { fault.mockRestore(); throw new Error("read connection failed"); }
      return exec.call(this, statement);
    });
    await expect(writer.applyBatch(batch)).rejects.toMatchObject({ code: "destination-uncertain", retryable: true });
    sql(f, db => expect(db.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 1 }));
    expect(await writer.applyBatch(batch)).toEqual(batch.checkpoint);
    sql(f, db => expect(db.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 1 }));
  });

  it("does not acknowledge reconciliation when its independent reader cannot close", async () => {
    const f = await fixture(); const writer = await destination(f, { _transactionObserver(stage) { if (stage === "after-commit") throw new Error("lost acknowledgement"); } });
    await admit(f, writer); const batch = (await batches(f.source))[0];
    const close = DatabaseSync.prototype.close; let reader: DatabaseSync | undefined;
    const fault = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(function(this: DatabaseSync) { reader = this; throw new Error("reader close failed"); });
    await expect(writer.applyBatch(batch)).rejects.toMatchObject({ code: "destination-uncertain", retryable: true });
    fault.mockRestore(); close.call(reader!);
    sql(f, db => expect(db.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 1 }));
    expect(await writer.applyBatch(batch)).toEqual(batch.checkpoint);
  });

  it.each([0, 2])("revokes an admitted handle if schema readiness changes to %s", async schemaReady => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer);
    sql(f, db => db.prepare("UPDATE transfer_runs SET schema_ready=?").run(schemaReady));
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: "destination-conflict" });
    await expect(writer.applyBatch((await batches(f.source))[0])).rejects.toMatchObject({ code: "destination-conflict" });
  });

  it("refuses bootstrap resume when durable batch receipts already exist", async () => {
    const f = await fixture(); const writer = await destination(f); await admit(f, writer); const batch = (await batches(f.source))[0];
    await writer.applyBatch(batch); await writer.close();
    sql(f, db => db.exec("UPDATE transfer_runs SET schema_ready=0"));
    await expect(destination(f, { mode: "resume" })).rejects.toMatchObject({ code: "destination-conflict" });
    sql(f, db => expect(db.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 1 }));
  });

  it("revokes the active writer when the authenticated schema version changes", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer);
    sql(f, db => db.exec("CREATE TRIGGER unexpected_transfer_hook BEFORE INSERT ON messages BEGIN SELECT 1; END"));
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: "unsupported-capability" });
    await expect(writer.applyBatch((await batches(f.source))[0])).rejects.toMatchObject({ code: "destination-conflict" });
  });

  it("revokes the admitted writer if its authenticated run ledger disappears", async () => {
    const f = await fixture(); const writer = await destination(f); const manifest = await admit(f, writer); const batch = (await batches(f.source))[0];
    sql(f, db => db.exec("DROP TABLE transfer_runs"));
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: "destination-conflict" });
    await expect(writer.applyBatch(batch)).rejects.toMatchObject({ code: "destination-conflict" });
    sql(f, db => {
      expect(db.prepare("SELECT count(*) AS n FROM transfer_batches").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM portable_archive_machines").get()).toEqual({ n: 0 });
    });
  });

});
