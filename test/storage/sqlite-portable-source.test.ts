import { afterEach, describe, expect, it, vi } from "vitest";
import * as filesystem from "node:fs";
import { PortableIndex } from "../../src/storage/portable-index.js";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";
import { openSqlitePortableSource, sqlitePortableFileSha256, type OpenSqlitePortableSourceInput } from "../../src/storage/sqlite/portable-source.js";
import { initializePortableArchive, PORTABLE_ARCHIVE_DOMAINS, writePortableArchiveRecord } from "../../src/storage/sqlite/portable-archive.js";
import { writePortableRuntimeRecord } from "../../src/storage/sqlite/portable-runtime-mapping.js";
import { PORTABLE_LIMITS, PORTABLE_RECORD_DOMAIN_ORDER, canonicalSha256, type PortableDomain } from "../../src/storage/portable-record.js";
import type { PortableRecordSource, PortableSourcePageInput } from "../../src/storage/portable-record-stream.js";
import { createPortableRecordStream } from "../../src/storage/portable-record-stream.js";
import { openSqlitePortableDestination } from "../../src/storage/sqlite/portable-destination.js";
import { runPortableTransfer, PortableTransferError } from "../../src/storage/portable-transfer.js";
import { buildRecords, independentSha256, integer, postgresGeneration } from "../fixtures/portable-records.js";

vi.mock("node:fs", async importOriginal => ({...await importOriginal<typeof import("node:fs")>()}));

const eventsSql = `CREATE TABLE events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid TEXT NOT NULL UNIQUE,
  event_version INTEGER NOT NULL CHECK(event_version > 0),
  machine_id TEXT,
  machine_sequence TEXT NOT NULL UNIQUE CHECK(length(machine_sequence)=19 AND machine_sequence NOT GLOB '*[^0-9]*'),
  session_id TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL, category TEXT NOT NULL, data TEXT NOT NULL,
  priority INTEGER DEFAULT 3, source_hook TEXT NOT NULL, prev_event_id INTEGER,
  processed_at TEXT, created_at TEXT NOT NULL DEFAULT(datetime('now')),
  delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','claimed','retry','replicated','acknowledged','quarantined')),
  delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK(delivery_generation>=0),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts>=0),
  delivery_owner TEXT, delivery_claimed_at TEXT,
  delivery_next_attempt_at TEXT NOT NULL DEFAULT(datetime('now')),
  delivery_last_error TEXT, remote_inbox_id TEXT, quarantine_reason TEXT,
  acknowledged_at TEXT, remote_pruned_at TEXT,
  delivery_updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  CHECK((delivery_state='claimed')=(delivery_claimed_at IS NOT NULL)),
  CHECK((delivery_claimed_at IS NULL)=(delivery_owner IS NULL)),
  CHECK((delivery_state='acknowledged')=(acknowledged_at IS NOT NULL)),
  CHECK((delivery_state='quarantined')=(quarantine_reason IS NOT NULL)),
  CHECK(delivery_state<>'replicated' OR remote_inbox_id IS NOT NULL),
  CHECK(delivery_state<>'acknowledged' OR remote_inbox_id IS NOT NULL),
  CHECK(remote_pruned_at IS NULL OR(delivery_state='acknowledged' AND remote_inbox_id IS NOT NULL))
)`;
const eventMetadataSql = `CREATE TABLE error_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, hook TEXT NOT NULL,error TEXT NOT NULL,
 session_id TEXT, created_at TEXT DEFAULT(datetime('now')));
 CREATE TABLE missing_cwd_state(id INTEGER PRIMARY KEY CHECK(id=1),observations INTEGER NOT NULL CHECK(observations>0),last_observed_at INTEGER NOT NULL CHECK(last_observed_at>=0),parked_at TEXT CHECK(parked_at IS NULL OR observations>=3));
 CREATE TABLE schema_version(version INTEGER NOT NULL);
 INSERT INTO schema_version VALUES(5);`;

const instructionsSql = `CREATE TABLE session_instruction_cache (
  project_id TEXT NOT NULL,
  scope_hash TEXT NOT NULL CHECK(length(scope_hash)=64 AND scope_hash NOT GLOB '*[^a-f0-9]*'),
  client_name TEXT NOT NULL CHECK(client_name IN ('claude','codex')),
  session_id TEXT NOT NULL CHECK(session_id<>''),
  worktree_path TEXT NOT NULL CHECK(worktree_path<>''),
  cwd_path TEXT NOT NULL CHECK(cwd_path<>''),
  content TEXT NOT NULL, content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(project_id,scope_hash)
)`;

const dirs: string[] = [];
const sources: PortableRecordSource[] = [];
const identity = { scope: "local", projectId: "a".repeat(64) } as const;
const facts = { machines: [{ identityKey: "local-machine", machineId: null }], aliases: [] };
const capturedAt = "2026-09-06T00:00:00.000000Z";
function fixture(seed?: (db: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), "lcm-sqlite-source-"));
  dirs.push(dir);
  const path = join(dir, "source.db");
  const db = new DatabaseSync(path);
  try { runLcmMigrations(db, { fts5Available: false }); seed?.(db); } finally { db.close(); }
  chmodSync(path, 0o600);
  return { dir, path };
}
function capturedSidecar(seed: (db: DatabaseSync) => void) {
  const dir=mkdtempSync(join(tmpdir(),"lcm-captured-sidecar-"));dirs.push(dir);
  const path=join(dir,"sidecar.db");const db=new DatabaseSync(path);
  try{seed(db);}finally{db.close();}chmodSync(path,0o600);return {dir,path};
}
function input(file: ReturnType<typeof fixture>, overrides: Partial<OpenSqlitePortableSourceInput> = {}): OpenSqlitePortableSourceInput {
  return { databasePath: file.path, scratchParent: file.dir, projectIdentity: identity, identityFacts: facts,
    expectedFileSha256: sqlitePortableFileSha256(file.path), expectedFactsSha256: canonicalSha256(facts), capturedAt, capturedSidecars: { events: { absent: true, evidenceSha256: "f".repeat(64) }, instructions: { absent: true, evidenceSha256: "e".repeat(64) } }, ...overrides };
}
async function open(file: ReturnType<typeof fixture>, overrides: Partial<OpenSqlitePortableSourceInput> = {}) {
  const source = await openSqlitePortableSource(input(file, overrides)); sources.push(source); return source;
}
function page(domain: PortableDomain, overrides: Partial<PortableSourcePageInput> = {}): PortableSourcePageInput {
  return { domain, afterOrdinal: 0, includePredecessor: false, maxRecords: 500, maxBytes: PORTABLE_LIMITS.maxBatchBytes, ...overrides };
}
function conversations(db: DatabaseSync, count: number) {
  const insert = db.prepare("INSERT INTO conversations(session_id,created_at,updated_at) VALUES(?,?,?)");
  db.exec("BEGIN");
  for (let n = 0; n < count; n++) insert.run(`session-${String(n).padStart(5, "0")}`, "2026-09-06 00:00:00", "2026-09-06 00:00:00");
  db.exec("COMMIT");
}
function native(db: DatabaseSync, machine = "local") {
  db.prepare("INSERT INTO runtime_native_transcripts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("transcript", identity.projectId, machine,
    "codex", "jsonl", "1", "native-session", "/captured/session.jsonl", 9007199254740993n,
    "2026-09-06 00:00:00.123456", "2026-09-06 00:00:01", "1", "b".repeat(64), "c".repeat(64), '{"message":"scrubbed"}');
  db.prepare("INSERT INTO runtime_native_ingest_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(identity.projectId, machine, "codex",
    "/captured/session.jsonl", 9007199254740991n, 9007199254740993n, 9223372036854775807n, 0n, 1n, '{"offset":42}', "2026-09-06 00:00:02");
}
function instructions(db: DatabaseSync, project = identity.projectId) {
  db.prepare("INSERT INTO session_instruction_cache VALUES(?,?,?,?,?,?,?,?,?)").run(project, "d".repeat(64), "codex", "session", "/worktree", "/worktree/sub", "cached instructions", "e".repeat(64), "2026-09-06 00:00:00.123456");
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const source of sources.splice(0)) await source.close().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
},60000);

describe("SQLite supplied canonical generation", () => {
  it("roundtrips all 22 real runtime and archive domains with exact values, relationships and hashes", async () => {
    // The fixture's default digest belongs to its declared backend dialect. Supply
    // the production closure vocabulary using the independent fixture encoder.
    const options = { ...postgresGeneration(), closureDigest: (closure: import("../fixtures/portable-records.js").ConversationClosure) => independentSha256([
      "lcm-portable-conversation-closure-v1", { ...closure, messages: closure.messages.map(([seq, role, content, tokens, createdAt]) => [integer(seq), role, content, integer(tokens), createdAt]) },
    ]) };
    const records = buildRecords(options);
    const file = fixture(db => {
      initializePortableArchive(db);
      const ids = new Map<string, string>();
      const lookup = (domain: PortableDomain, hash: string) => {
        const locator = ids.get(`${domain}:${hash}`); if (locator === undefined) throw new Error("missing fixture dependency"); return locator;
      };
      for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) for (const record of records.get(domain)!) {
        if ((PORTABLE_ARCHIVE_DOMAINS as readonly string[]).includes(domain)) writePortableArchiveRecord(db, record);
        else ids.set(`${domain}:${record.identitySha256}`, writePortableRuntimeRecord(db, record, lookup, options.projectIdentity));
      }
    });
    const before = readFileSync(file.path);
    const source = await open(file, { projectIdentity: options.projectIdentity, identityFacts: undefined, expectedFactsSha256: undefined });
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      const result = await source.readDomainPage(page(domain));
      expect(result.records, domain).toEqual(records.get(domain));
      expect(result.complete, domain).toBe(true);
      expect(result.predecessor, domain).toBeNull();
    }
    expect(Object.keys(source.describeSource().coverage)).toHaveLength(22);
    await source.close();
    expect(readFileSync(file.path)).toEqual(before);
    expect(readdirSync(file.dir)).toEqual(["source.db"]);
  });

  it.each(["version", "column", "table", "generated column", "missing table"])("refuses unsupported source schema %s without changing captured bytes", async change => {
    const file=fixture(db => {
      if(change === "version") db.exec("PRAGMA user_version=999");
      if(change === "column") db.exec("ALTER TABLE conversations ADD COLUMN future_metadata TEXT");
      if(change === "table") db.exec("CREATE TABLE future_domain(content TEXT)");
      if(change === "generated column") db.exec("ALTER TABLE conversations ADD COLUMN future_generated TEXT GENERATED ALWAYS AS (session_id) VIRTUAL");
      if(change === "missing table") db.exec("DROP TABLE runtime_native_ingest_checkpoints");
    });
    const before=readFileSync(file.path);
    await expect(openSqlitePortableSource(input(file)).then(source => { sources.push(source); return "unexpected success"; })).rejects.toMatchObject({code:"unsupported-capability"});
    expect(readFileSync(file.path)).toEqual(before);
  });

  it("combines authenticated main and external machine instruction caches with direct point rereads", async () => {
    const main=fixture(db=>instructions(db));
    const extra=fixture(db=>{instructions(db);db.exec("UPDATE session_instruction_cache SET scope_hash='"+"c".repeat(64)+"'");});
    const machines=facts;
    const source=await open(main,{identityFacts:machines,expectedFactsSha256:canonicalSha256(machines),capturedSidecars:{events:{absent:true,evidenceSha256:"f".repeat(64)},instructions:[{databasePath:extra.path,expectedFileSha256:sqlitePortableFileSha256(extra.path),machineIdentityKey:"local-machine"}]}});
    expect((await source.readDomainPage(page("session-instructions"))).records).toHaveLength(2);
  });

  it("binds external cache bytes and explicit absence evidence into the source witness", async () => {
    const main=fixture(); const extra=fixture(db=>instructions(db));
    const capturedSidecars={events:{absent:true as const,evidenceSha256:"f".repeat(64)},instructions:[{databasePath:extra.path,expectedFileSha256:sqlitePortableFileSha256(extra.path),machineIdentityKey:"local-machine"}]};
    const source=await open(main,{capturedSidecars});
    expect((await source.readDomainPage(page("session-instructions"))).records[0].value).toMatchObject({machineIdentityKey:"local-machine",content:"cached instructions"});
    const absence=await open(main);
    expect(source.describeSource().sourceIdentitySha256).not.toBe(absence.describeSource().sourceIdentitySha256);
    const bytes=readFileSync(extra.path);bytes[60]^=1;writeFileSync(extra.path,bytes);
    await expect(source.readDomainPage(page("session-instructions"))).rejects.toMatchObject({code:"source-changed"});
    expect(()=>source.describeSource()).toThrow(expect.objectContaining({code:"source-failed"}));
  });

  it.each(["missing evidence", "empty instructions", "unknown machine", "same file", "wrong hash"])("refuses invalid captured sidecars: %s",async change=>{
    const main=fixture();const extra=fixture();
    const descriptor={databasePath:extra.path,expectedFileSha256:sqlitePortableFileSha256(extra.path),machineIdentityKey:"local-machine"};
    const capturedSidecars: NonNullable<OpenSqlitePortableSourceInput["capturedSidecars"]>={events:{absent:true,evidenceSha256:"f".repeat(64)},instructions:[descriptor]};
    const candidate=change === "empty instructions" ? {...capturedSidecars,instructions:[]} : change === "missing evidence" ? {...capturedSidecars,events:{absent:true as const,evidenceSha256:"bad"}} : capturedSidecars;
    if(change === "unknown machine")descriptor.machineIdentityKey="unknown";
    if(change === "same file")descriptor.databasePath=main.path;
    if(change === "wrong hash")descriptor.expectedFileSha256="0".repeat(64);
    await expect(openSqlitePortableSource(input(main,{capturedSidecars:candidate}))).rejects.toMatchObject({code:change === "unknown machine" ? "unsupported-capability" : change === "wrong hash" ? "source-changed" : "invalid-input"});
    expect(readdirSync(main.dir)).toEqual(["source.db"]);
  });

  it("exports real captured events in all dispositions and preserves sidecar authority separately from replay",async()=>{
    const main=fixture();
    const side=capturedSidecar(db=>{
      db.exec(eventsSql+";"+eventMetadataSql);
      const insert=db.prepare("INSERT INTO events(event_uuid,event_version,machine_sequence,session_id,type,category,data,source_hook,created_at) VALUES(?,2,?,'session','learning','pattern','captured data','PostToolUse','2026-09-06 00:00:00.123456')");
      for(let n=1;n<=5;n++)insert.run(`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`,String(n).padStart(19,"0"));
      db.exec("UPDATE events SET processed_at='done' WHERE event_id=2; UPDATE events SET delivery_state='quarantined',quarantine_reason='private raw reason' WHERE event_id=3; UPDATE events SET delivery_state='acknowledged',acknowledged_at='done',remote_inbox_id='remote' WHERE event_id=4; UPDATE events SET delivery_state='claimed',delivery_claimed_at='now',delivery_owner='private owner' WHERE event_id=5");
    });
    const before=readFileSync(side.path);
    const source=await open(main,{capturedSidecars:{events:{databasePath:side.path,expectedFileSha256:sqlitePortableFileSha256(side.path),machineIdentityKey:"local-machine"},instructions:{absent:true,evidenceSha256:"e".repeat(64)}}});
    const events=(await source.readDomainPage(page("passive-events"))).records;
    expect(events.map(record=>record.value.disposition)).toEqual(["pending","applied","quarantined","applied","pending"]);
    expect(events[0].value).toMatchObject({machineIdentityKey:"local-machine",eventVersion:{$integer:"2"},machineSequence:{$integer:"1"},createdAt:"2026-09-06T00:00:00.123456Z"});
    expect(JSON.stringify(events)).not.toContain("private");
    expect(()=>source.recoveryArchive).toThrow(expect.objectContaining({code:"unsupported-capability"}));
    await source.close();expect(readFileSync(side.path)).toEqual(before);
  });

  it.each([false,true])("admits dedicated cache schema and refuses additive meaningful sidecar fields=%s",async altered=>{
    const main=fixture();const side=capturedSidecar(db=>{db.exec(instructionsSql);instructions(db);if(altered)db.exec("ALTER TABLE session_instruction_cache ADD COLUMN unknown_data TEXT");});
    const operation=open(main,{capturedSidecars:{events:{absent:true,evidenceSha256:"f".repeat(64)},instructions:[{databasePath:side.path,expectedFileSha256:sqlitePortableFileSha256(side.path),machineIdentityKey:"local-machine"}]}});
    if(altered)await expect(operation).rejects.toMatchObject({code:"unsupported-capability"});
    else expect((await (await operation).readDomainPage(page("session-instructions"))).records).toHaveLength(1);
  });

  it("rereads explicit machine and alias facts without discovering installation state",async()=>{
    const alias={machineIdentityKey:"local-machine",path:"/workspace",normalizedPath:"/workspace"};
    const evidence={...facts,aliases:[alias]};const source=await open(fixture(),{identityFacts:evidence,expectedFactsSha256:canonicalSha256(evidence)});
    expect((await source.readDomainPage(page("machines"))).records[0].value).toEqual(facts.machines[0]);
    expect((await source.readDomainPage(page("project-aliases"))).records[0].value).toEqual(alias);
    expect((await source.readDomainPage(page("project"))).records[0].value).toEqual({identity});
  });

  it("reads registered native machine IDs and captures generations predating native support",async()=>{
    const registered={machines:[{identityKey:"registered",machineId:"00000000-0000-7000-8000-000000000001"}],aliases:[]};
    const source=await open(fixture(db=>native(db,registered.machines[0].machineId)),{identityFacts:registered,expectedFactsSha256:canonicalSha256(registered)});
    expect((await source.readDomainPage(page("native-transcripts"))).records[0].value.machineIdentityKey).toBe("registered");
    const legacy=await open(fixture(db=>db.exec("DROP TABLE runtime_native_transcript_messages; DROP TABLE runtime_native_transcripts; DROP TABLE runtime_native_ingest_checkpoints")));
    expect((await legacy.readDomainPage(page("native-transcripts"))).records).toEqual([]);
  });

  it("uses keyset scanning after 500 main instruction rows and returns exact point records",async()=>{
    const source=await open(fixture(db=>{
      const insert=db.prepare("INSERT INTO session_instruction_cache VALUES(?,?,'codex','session','/worktree','/cwd','content','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','2026-09-06 00:00:00')");
      for(let n=0;n<503;n++)insert.run(identity.projectId,n.toString(16).padStart(64,"0"));
    }));
    expect((await source.readDomainPage(page("session-instructions"))).records).toHaveLength(500);
    expect((await source.readDomainPage(page("session-instructions",{afterOrdinal:500}))).records).toHaveLength(3);
  });

  it.each(["array", "size", "shape", "scalar", "strings", "escaping"])("rejects malformed or oversized identity facts: %s",async kind=>{
    let evidence: unknown=facts;
    if(kind === "array")evidence={machines:null,aliases:[]};
    if(kind === "size")evidence={machines:Array(501).fill(facts.machines[0]),aliases:[]};
    if(kind === "shape")evidence={machines:[{...facts.machines[0],extra:1}],aliases:[]};
    if(kind === "scalar")evidence={machines:[{identityKey:1,machineId:null}],aliases:[]};
    if(kind === "strings")evidence={machines:[{identityKey:"x".repeat(PORTABLE_LIMITS.maxControlBytes+1),machineId:null}],aliases:[]};
    if(kind === "escaping")evidence={machines:[{identityKey:"\n".repeat(PORTABLE_LIMITS.maxControlBytes),machineId:null}],aliases:[]};
    await expect(openSqlitePortableSource(input(fixture(),{identityFacts:evidence as typeof facts}))).rejects.toMatchObject({code:["shape","scalar"].includes(kind)?"invalid-input":"unsupported-capability"});
  });

  it("aborts source verification without revoking subsequent independent reads",async()=>{
    const source=await open(fixture());const description=source.describeSource();const controller=new AbortController();controller.abort();
    await expect(source.verifySource({...description,signal:controller.signal})).rejects.toMatchObject({code:"aborted"});
    expect(await source.verifySource(description)).toBe("unchanged");
    expect(await source.verifySource({...description,sourceIdentitySha256:"0".repeat(64)})).toBe("changed");
  });

  it("refuses unexpected archive project cardinality and malformed runtime timestamps",async()=>{
    await expect(openSqlitePortableSource(input(fixture(db=>initializePortableArchive(db))))).rejects.toMatchObject({code:"source-changed"});
    const file=fixture(db=>{native(db);db.exec("UPDATE runtime_native_transcripts SET observed_at='invalid timestamp'");});
    await expect(openSqlitePortableSource(input(file))).rejects.toMatchObject({code:"unsupported-capability"});
  });

  it("preserves the same instruction scope across explicitly bound main and external machines",async()=>{
    const main=fixture(db=>instructions(db));const extra=fixture(db=>instructions(db));
    const evidence={machines:[...facts.machines,{identityKey:"external-machine",machineId:null}],aliases:[]};
    const source=await open(main,{identityFacts:evidence,expectedFactsSha256:canonicalSha256(evidence),machineIdentityKey:"local-machine",capturedSidecars:{events:{absent:true,evidenceSha256:"f".repeat(64)},instructions:[{databasePath:extra.path,expectedFileSha256:sqlitePortableFileSha256(extra.path),machineIdentityKey:"external-machine"}]}});
    const result=(await source.readDomainPage(page("session-instructions"))).records;
    expect(result.map(record=>record.value.machineIdentityKey)).toEqual(["external-machine","local-machine"]);
    expect(new Set(result.map(record=>record.identitySha256)).size).toBe(2);
  });

  it.each(["instructions","native"])("refuses archive mixed with newer runtime %s facts",async kind=>{
    const file=fixture(db=>{initializePortableArchive(db);writePortableArchiveRecord(db,buildRecords(postgresGeneration()).get("project")![0]);if(kind === "instructions")instructions(db);else native(db);});
    await expect(open(file,{projectIdentity:postgresGeneration().projectIdentity})).rejects.toMatchObject({code:"unsupported-capability"});
  });

  it("refuses orphan native links before the join can omit captured facts",async()=>{
    const file=fixture(db=>{db.exec("PRAGMA foreign_keys=OFF");db.prepare("INSERT INTO runtime_native_transcript_messages VALUES(?,?,?,?,?)").run(identity.projectId,"missing-transcript",1,1,0);});
    const before=readFileSync(file.path);
    await expect(open(file)).rejects.toMatchObject({code:"unsupported-capability"});
    expect(readFileSync(file.path)).toEqual(before);
  });

  it("refuses a previously imported archive after native runtime data changes",async()=>{
    const main=fixture(db=>conversations(db,1));
    const source=await createPortableRecordStream(await open(main));
    const target=join(main.dir,"target.db");
    const writer=await openSqlitePortableDestination({databasePath:target,projectIdentity:identity,generationIdentitySha256:"b".repeat(64),mode:"create",scratchParent:main.dir});
    await runPortableTransfer({source,destination:writer});
    const db=new DatabaseSync(target);try{db.exec("UPDATE conversations SET title='changed after import'");}finally{db.close();}
    await expect(open({dir:main.dir,path:target})).rejects.toMatchObject({code:"verification-failed"});
  });

  it("authenticates partial boundary digests and rejects forged content and counts",async()=>{
    const source=await open(fixture(db=>conversations(db,3)));const stream=await createPortableRecordStream(source);
    const batch=await stream.readBatch({domain:"conversations",maxRecords:1,maxBytes:PORTABLE_LIMITS.maxBatchBytes});
    const description=source.describeSource();
    const boundary={...batch.checkpoint};
    expect(await source.verifySource({...description,boundary})).toBe("unchanged");
    expect(await source.verifySource({...description,boundary:{...boundary,prefixSha256:"0".repeat(64)}})).toBe("changed");
    expect(await source.verifySource({...description,boundary:{...boundary,recordCount:2}})).toBe("invalid");
    for(const patch of [{nextOrdinal:-0,recordCount:0},{nextOrdinal:0,recordCount:-0},{nextOrdinal:4,recordCount:4},{nextOrdinal:0.5,recordCount:0.5},{domain:"unknown"}])expect(await source.verifySource({...description,boundary:{...boundary,...patch} as typeof boundary})).toBe("invalid");
    expect(await source.verifySource({...description,contentSha256:"0".repeat(64)})).toBe("changed");
    expect(await source.verifySource({...description,contentSha256:stream.describe().contentSha256})).toBe("unchanged");
  });

  it("revokes synchronous description reads when captured bytes change",async()=>{
    const file=fixture();const source=await open(file);const bytes=readFileSync(file.path);bytes[60]^=1;writeFileSync(file.path,bytes);
    expect(()=>source.describeSource()).toThrow(expect.objectContaining({code:"source-changed"}));
  });

  it("detects a file replacement between path admission and descriptor authentication",async()=>{
    const file=fixture();const request=input(file);const original=filesystem.lstatSync;let calls=0;
    vi.spyOn(filesystem,"lstatSync").mockImplementation(((...args: Parameters<typeof filesystem.lstatSync>)=>{
      const result=original(...args);
      if(args[0]===file.path && ++calls===2){renameSync(file.path,file.path+".old");writeFileSync(file.path,readFileSync(file.path+".old"),{mode:0o600});}
      return result;
    }) as typeof filesystem.lstatSync);
    await expect(openSqlitePortableSource(request)).rejects.toMatchObject({code:"source-changed"});
  });

  it.each(["facts root", "sidecar root", "descriptor", "main machine"])("rejects hostile captured descriptor shape: %s",async kind=>{
    const file=fixture();const overrides:Partial<OpenSqlitePortableSourceInput>=kind === "facts root" ? {identityFacts:{...facts,extra:1} as typeof facts} : kind === "main machine" ? {machineIdentityKey:"missing"} : {capturedSidecars:(kind === "sidecar root" ? null : {events:{databasePath:"x"},instructions:{absent:true,evidenceSha256:"e".repeat(64)}}) as unknown as OpenSqlitePortableSourceInput["capturedSidecars"]};
    await expect(openSqlitePortableSource(input(file,overrides))).rejects.toMatchObject({code:kind === "main machine" ? "unsupported-capability" : "invalid-input"});
  });

  it("refuses a missing mandatory runtime table and oversized schema names",async()=>{
    await expect(open(fixture(db=>db.exec("DROP TABLE recall_surfacing")))).rejects.toMatchObject({code:"unsupported-capability"});
    await expect(open(fixture(db=>db.exec(`CREATE TABLE "${"x".repeat(1025)}"(value TEXT)`)))).rejects.toMatchObject({code:"unsupported-capability"});
  });

  it.each(["runtime","machine","alias","cache","sidecar","sidecar locator","archive"])("detects private ordering index locator corruption: %s",async kind=>{
    const file=fixture(db=>{conversations(db,1);if(kind === "cache")instructions(db);if(kind === "archive"){initializePortableArchive(db);writePortableArchiveRecord(db,buildRecords(postgresGeneration()).get("project")![0]);}});
    const extra=fixture(db=>instructions(db));
    const evidence={...facts,aliases:[{machineIdentityKey:"local-machine",path:"/worktree",normalizedPath:"/worktree"}]};
    const source=await open(file,{identityFacts:evidence,expectedFactsSha256:canonicalSha256(evidence),...(kind === "archive" ? {projectIdentity:postgresGeneration().projectIdentity} : {}),...(kind.startsWith("sidecar") ? {capturedSidecars:{events:{absent:true as const,evidenceSha256:"f".repeat(64)},instructions:[{databasePath:extra.path,expectedFileSha256:sqlitePortableFileSha256(extra.path),machineIdentityKey:"local-machine"}]}} : {})});
    const domain:PortableDomain=kind === "runtime" ? "conversations" : kind === "machine" ? "machines" : kind === "alias" ? "project-aliases" : kind === "archive" ? "project" : "session-instructions";
    const indexPath=join(file.dir,readdirSync(file.dir).find(name=>name.startsWith("lcm-portable-index-"))!,"index.sqlite");
    const db=new DatabaseSync(indexPath);
    try{db.prepare("UPDATE records SET locator=? WHERE domain=?").run(kind === "sidecar" ? '["sidecar",999,"missing"]' : kind === "sidecar locator" ? '["sidecar",0,"missing"]' : "missing",domain);}finally{db.close();}
    await expect(source.readDomainPage(page(domain))).rejects.toMatchObject({code:"source-changed"});
  });

  it.each(["lookup","conversation identity","message identity","empty index"])("sanitizes ordering index failures during source construction: %s",async kind=>{
    const file=fixture(db=>{conversations(db,1);db.exec("INSERT INTO messages(message_id,conversation_id,seq,role,content,token_count) VALUES(1,1,0,'user','content',1); INSERT INTO message_parts(part_id,message_id,session_id,part_type,ordinal,text_content) VALUES('00000000-0000-4000-8000-000000000001',1,'session-00000','text',0,'part')");});
    if(kind === "lookup")vi.spyOn(PortableIndex.prototype,"lookup").mockReturnValue(null);
    if(kind === "empty index")vi.spyOn(PortableIndex.prototype,"entries").mockReturnValue([]);
    if(kind.includes("identity")){
      const original=PortableIndex.prototype.lookupIdentity;
      vi.spyOn(PortableIndex.prototype,"lookupIdentity").mockImplementation(function(domain,hash){return domain===(kind === "conversation identity" ? "conversations" : "messages")?null:original.call(this,domain,hash);});
    }
    await expect(open(file)).rejects.toMatchObject({code:kind === "empty index" ? "source-changed":"invalid-input"});
  });

  it.each(["index","database"])("attempts every resource close and reports sanitized %s cleanup failure",async kind=>{
    const source=await open(fixture());
    if(kind === "index"){
      const original=PortableIndex.prototype.close;vi.spyOn(PortableIndex.prototype,"close").mockImplementation(function(){original.call(this);throw new Error("private cleanup detail");});
    }else{
      const original=DatabaseSync.prototype.close;vi.spyOn(DatabaseSync.prototype,"close").mockImplementation(function(){original.call(this);throw new Error("private cleanup detail");});
    }
    await expect(source.close()).rejects.toMatchObject({code:"close-failed"});
    await source.close();
  });

  it("rejects a native/cache row disappearing between bounded metadata and point reads",async()=>{
    const file=fixture(db=>instructions(db));const original=DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype,"prepare").mockImplementation(function(sql){const statement=original.call(this,sql);if(sql.startsWith("SELECT s.scope_hash AS scope_hash"))vi.spyOn(statement,"get").mockReturnValue(undefined);return statement;});
    await expect(open(file)).rejects.toMatchObject({code:"source-changed"});
  });

  it("compares actual duplicate conversation closures when the ordering index asks for collision adjudication",async()=>{
    const file=fixture(db=>{conversations(db,2);});const original=PortableIndex.prototype.finalizeConversations;
    vi.spyOn(PortableIndex.prototype,"finalizeConversations").mockImplementation(async function(compare){expect(await compare("1","2")).toBe(false);return original.call(this,compare);});
    expect((await (await open(file)).readDomainPage(page("conversations"))).records).toHaveLength(2);
  });

  it.each(["missing trigger","extra run","oversized manifest","checkpoint shape","checkpoint element","checkpoint order","missing receipt","unready"])("rejects altered imported generation evidence: %s",async kind=>{
    const main=fixture(db=>conversations(db,1));const source=await createPortableRecordStream(await open(main));const target=join(main.dir,"target.db");
    const writer=await openSqlitePortableDestination({databasePath:target,projectIdentity:identity,generationIdentitySha256:"b".repeat(64),mode:"create",scratchParent:main.dir});
    await runPortableTransfer({source,destination:writer});
    const db=new DatabaseSync(target);
    try{
      if(kind === "missing trigger")db.exec("DROP TRIGGER transfer_batches_no_delete");
      if(kind === "extra run")db.prepare("INSERT INTO transfer_runs SELECT ?,project_json,?,manifest_json,source_identity,source_witness,checkpoints_json,schema_ready,complete FROM transfer_runs").run("c".repeat(64),"d".repeat(64));
      if(kind === "oversized manifest")db.prepare("UPDATE transfer_runs SET manifest_json=?").run("x".repeat(4*PORTABLE_LIMITS.maxControlBytes));
      if(kind === "unready")db.exec("UPDATE transfer_runs SET schema_ready=0");
      if(kind.startsWith("checkpoint")){
        const checkpoints=JSON.parse(String(db.prepare("SELECT checkpoints_json FROM transfer_runs").get()!.checkpoints_json));
        if(kind === "checkpoint element")checkpoints[0]=1;
        if(kind === "checkpoint order")[checkpoints[0],checkpoints[1]]=[checkpoints[1],checkpoints[0]];
        db.prepare("UPDATE transfer_runs SET checkpoints_json=?").run(JSON.stringify(kind === "checkpoint shape" ? {} : checkpoints));
      }
      if(kind === "missing receipt"){
        const trigger=String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='transfer_batches_no_delete'").get()!.sql);db.exec("DROP TRIGGER transfer_batches_no_delete; DELETE FROM transfer_batches WHERE domain='machines'");db.exec(trigger);
      }
    }finally{db.close();}
    await expect(open({dir:main.dir,path:target})).rejects.toMatchObject({code:kind === "missing trigger" ? "unsupported-capability":"verification-failed"});
  });

  it("stops a page at the byte budget using serialized bytes and resumes exactly",async()=>{
    const payloadBytes=1024*1024;
    const file=fixture(db=>{
      const insert=db.prepare("INSERT INTO session_instruction_cache VALUES(?,?,'codex','session','/worktree','/cwd',replace(hex(zeroblob(?)),'00',char(1)),?,'2026-09-06 00:00:00')");
      for(let n=0;n<26;n++)insert.run(identity.projectId,n.toString(16).padStart(64,"0"),payloadBytes,"e".repeat(64));
    });
    const source=await open(file);const first=await source.readDomainPage(page("session-instructions"));
    expect(first.records).toHaveLength(23);expect(first.records[0].ordinal).toBe(0);expect(first.complete).toBe(false);
    const next=await source.readDomainPage(page("session-instructions",{afterOrdinal:23}));
    expect(next.records).toHaveLength(3);expect(next.records[0].ordinal).toBe(23);expect(next.complete).toBe(true);
  },180000);

  it("does not invent a predecessor after private index damage",async()=>{
    const file=fixture(db=>conversations(db,2));const source=await open(file);
    const indexPath=join(file.dir,readdirSync(file.dir).find(name=>name.startsWith("lcm-portable-index-"))!,"index.sqlite");const db=new DatabaseSync(indexPath);
    try{db.exec("DELETE FROM records WHERE domain='conversations' AND ordinal=0");}finally{db.close();}
    await expect(source.readDomainPage(page("conversations",{afterOrdinal:1,includePredecessor:true}))).rejects.toMatchObject({code:"source-changed"});
  });

  it("refuses a non-sidecar passive-event locator forged in the private index",async()=>{
    const file=fixture();const source=await open(file);const indexPath=join(file.dir,readdirSync(file.dir).find(name=>name.startsWith("lcm-portable-index-"))!,"index.sqlite");const db=new DatabaseSync(indexPath);
    try{db.exec("UPDATE records SET domain='passive-events' WHERE domain='machines'");}finally{db.close();}
    await expect(source.readDomainPage(page("passive-events"))).rejects.toMatchObject({code:"source-changed"});
  });

  it("refuses SQLite text the native driver would truncate at an embedded NUL",async()=>{
    const file=fixture(db=>{instructions(db);db.prepare("UPDATE session_instruction_cache SET content=?").run("before\0after");});
    const before=readFileSync(file.path);
    await expect(open(file)).rejects.toMatchObject({code:"unsupported-capability"});
    expect(readFileSync(file.path)).toEqual(before);
  });

  it.each(["facts", "main path", "main machine", "sidecar path", "sidecar machine"])("refuses NUL in explicit capture scalar descriptors: %s",async kind=>{
    const file=fixture();const overrides:{-readonly [K in keyof OpenSqlitePortableSourceInput]?:OpenSqlitePortableSourceInput[K]}={};
    if(kind === "facts")overrides.identityFacts={machines:[{identityKey:"before\0after",machineId:null}],aliases:[]};
    if(kind === "main path")overrides.databasePath=file.path+"\0suffix";
    if(kind === "main machine")overrides.machineIdentityKey="before\0after";
    if(kind.startsWith("sidecar"))overrides.capturedSidecars={events:{absent:true,evidenceSha256:"f".repeat(64)},instructions:[{databasePath:file.path+(kind === "sidecar path" ? "\0suffix" : ""),machineIdentityKey:kind === "sidecar machine" ? "before\0after" : "local-machine",expectedFileSha256:"a".repeat(64)}]};
    await expect(openSqlitePortableSource(input(file,overrides))).rejects.toMatchObject({code:kind === "facts" ? "invalid-input":"unsupported-capability"});
  });

  it("rejects escaped JSON NUL through the canonical codec without driver truncation",async()=>{
    const file=fixture(db=>{native(db);db.prepare("UPDATE runtime_native_transcripts SET native_payload=?").run(JSON.stringify({message:"before\0after"}));});
    await expect(open(file)).rejects.toMatchObject({code:"invalid-input"});
  });

  it("requires explicit sidecar absence evidence for ordinary captured databases", async () => {
    const file = fixture();
    await expect(openSqlitePortableSource(input(file, { capturedSidecars: undefined }))).rejects.toMatchObject({ code: "unsupported-capability" });
  });

  it("exposes recovery data through source authority and revokes retained readers on close", async () => {
    const records = buildRecords(postgresGeneration());
    const file = fixture(db => {
      initializePortableArchive(db);
      for (const record of records.get("project")!) writePortableArchiveRecord(db, record);
      for (const record of records.get("machines")!) writePortableArchiveRecord(db, record);
    });
    const source = await open(file, { projectIdentity: postgresGeneration().projectIdentity, identityFacts: undefined, expectedFactsSha256: undefined, capturedSidecars: undefined });
    const reader = source.recoveryArchive;
    expect(await reader.getProject()).toEqual(records.get("project")![0].value);
    await source.close();
    expect(() => source.recoveryArchive).toThrow(expect.objectContaining({ code: "source-failed" }));
    await expect(reader.getProject()).rejects.toMatchObject({ code: "source-failed" });
  });

  it("pages more than 500 rows using next ordinals with the exact predecessor and terminal page", async () => {
    const source = await open(fixture(db => conversations(db, 503)));
    const first = await source.readDomainPage(page("conversations"));
    expect(first.records).toHaveLength(500); expect(first.complete).toBe(false);
    expect(first.records[0].ordinal).toBe(0); expect(first.records[499].ordinal).toBe(499);
    const second = await source.readDomainPage(page("conversations", { afterOrdinal: 500, includePredecessor: true }));
    expect(second.records.map(record => record.ordinal)).toEqual([500, 501, 502]);
    expect(second.predecessor).toEqual(first.records[499]); expect(second.complete).toBe(true);
    const end = await source.readDomainPage(page("conversations", { afterOrdinal: 503, includePredecessor: true }));
    expect(end.records).toEqual([]); expect(end.predecessor).toEqual(second.records[2]); expect(end.complete).toBe(true);
    expect(await source.readDomainPage(page("conversations"))).toEqual(first);
  });

  it.each([false, true])("assigns stable occurrences for duplicate headers with equal closures=%s", async equal => {
    const file = fixture(db => {
      db.exec("INSERT INTO conversations(conversation_id,session_id,created_at,updated_at) VALUES(20,'duplicate','2026-09-06 00:00:00','2026-09-06 00:00:00'),(10,'duplicate','2026-09-06 00:00:00','2026-09-06 00:00:00')");
      const insert = db.prepare("INSERT INTO messages(conversation_id,seq,role,content,token_count,created_at) VALUES(?,0,'user',?,0,'2026-09-06 00:00:00')");
      insert.run(20, "same"); insert.run(10, equal ? "same" : "different");
    });
    const source = await open(file);
    const rows = (await source.readDomainPage(page("conversations"))).records;
    expect(rows.map(record => record.value.occurrenceOrdinal)).toEqual([{ $integer: "0" }, { $integer: "1" }]);
    expect(new Set(rows.map(record => record.identitySha256)).size).toBe(2);
    const messages = (await source.readDomainPage(page("messages"))).records;
    expect(new Set(messages.map(record => record.value.conversationIdentitySha256))).toEqual(new Set(rows.map(record => record.identitySha256)));
    expect(messages.map(record => record.value.content).sort()).toEqual(equal ? ["same", "same"] : ["different", "same"]);
  });

  it("exports native bigint metadata, checkpoint counts and runtime message links without precision loss", async () => {
    const file = fixture(db => {
      conversations(db, 1); native(db);
      db.exec("INSERT INTO messages(message_id,conversation_id,seq,role,content,token_count,created_at) VALUES(1,1,0,'user','scrubbed',0,'2026-09-06 00:00:00')");
      db.prepare("INSERT INTO runtime_native_transcript_messages VALUES(?,?,?,?,?)").run(identity.projectId, "transcript", 1, 1, 0);
    });
    const source = await open(file);
    const transcripts = (await source.readDomainPage(page("native-transcripts"))).records;
    expect(transcripts[0].value).toMatchObject({ sourceOrdinal: { $integer: "9007199254740993" }, observedAt: "2026-09-06T00:00:00.123456Z", nativePayload: { message: "scrubbed" } });
    const checkpoints = (await source.readDomainPage(page("native-transcript-checkpoints"))).records;
    expect(checkpoints[0].value).toMatchObject({ revision: { $integer: "9007199254740991" }, importedCount: { $integer: "9223372036854775807" }, checkpoint: { offset: 42 } });
    const links = (await source.readDomainPage(page("native-transcript-message-links"))).records;
    const messages = (await source.readDomainPage(page("messages"))).records;
    expect(links[0].value).toMatchObject({ messageIdentitySha256: messages[0].identitySha256, conversationIdentitySha256: messages[0].value.conversationIdentitySha256 });
  });

  it("exports only the admitted project's live instruction cache with normalized timestamps", async () => {
    const source = await open(fixture(db => { instructions(db); instructions(db, "other-project"); }));
    const result = await source.readDomainPage(page("session-instructions"));
    expect(result.records).toHaveLength(1);
    expect(result.records[0].value).toEqual({ machineIdentityKey: "local-machine", scopeHash: "d".repeat(64), clientName: "codex", sessionId: "session", worktreePath: "/worktree", cwdPath: "/worktree/sub", content: "cached instructions", contentHash: "e".repeat(64), updatedAt: "2026-09-06T00:00:00.123456Z" });
  });

  it("revokes describe and page authority after close and closes idempotently", async () => {
    const source = await open(fixture()); const description = source.describeSource();
    expect(await source.verifySource(description)).toBe("unchanged");
    expect(await source.verifySource({ ...description, sourceWitnessSha256: "0".repeat(64) })).toBe("changed");
    await source.close(); await source.close();
    expect(() => source.describeSource()).toThrow(expect.objectContaining({ code: "source-failed" }));
    await expect(source.readDomainPage(page("conversations"))).rejects.toMatchObject({ code: "source-failed" });
    expect(await source.verifySource(description)).toBe("changed");
  });

  it.each(["bytes", "replacement", "permissions", "wal"])("revokes admitted authority on %s drift", async change => {
    const file = fixture(); const source = await open(file); const description = source.describeSource();
    if (change === "bytes") { const bytes = readFileSync(file.path); bytes[60] ^= 1; writeFileSync(file.path, bytes); }
    if (change === "replacement") { renameSync(file.path, `${file.path}.old`); writeFileSync(file.path, readFileSync(`${file.path}.old`), { mode: 0o600 }); }
    if (change === "permissions") chmodSync(file.path, 0o644);
    if (change === "wal") writeFileSync(`${file.path}-wal`, "unexpected captured WAL");
    await expect(source.readDomainPage(page("conversations"))).rejects.toMatchObject({ code: "source-changed" });
    expect(await source.verifySource(description)).toBe("changed");
    await expect(source.readDomainPage(page("conversations"))).rejects.toMatchObject({ code: "source-failed" });
  });

  it.each([
    ["hash mismatch", { expectedFileSha256: "0".repeat(64) }, "source-changed"],
    ["malformed hash", { expectedFileSha256: "invalid" }, "invalid-input"],
    ["malformed capture", { capturedAt: "yesterday" }, "invalid-input"],
    ["identity evidence mismatch", { expectedFactsSha256: "0".repeat(64) }, "source-changed"],
    ["absent identity evidence", { identityFacts: undefined, expectedFactsSha256: undefined }, "unsupported-capability"],
  ] as const)("rejects %s without changing the supplied database", async (_name, overrides, code) => {
    const file = fixture(); const before = readFileSync(file.path);
    await expect(openSqlitePortableSource(input(file, overrides))).rejects.toMatchObject({ code });
    expect(readFileSync(file.path)).toEqual(before); expect(readdirSync(file.dir)).toEqual(["source.db"]);
  });

  it("rejects a symlink and publicly readable source parent", async () => {
    const file = fixture(); const link = join(file.dir, "link.db"); symlinkSync(file.path, link);
    await expect(openSqlitePortableSource(input(file, { databasePath: link }))).rejects.toMatchObject({ code: "source-changed" });
    chmodSync(file.dir, 0o755);
    await expect(openSqlitePortableSource(input(file))).rejects.toMatchObject({ code: "source-changed" });
  });

  it.each([{ afterOrdinal: -1 }, { afterOrdinal: -0 }, { afterOrdinal: 1 }, { includePredecessor: "true" }, { afterOrdinal: 0.5 }, { maxRecords: 501 }, { maxBytes: 1 }, { domain: "untrusted-domain" }])("rejects invalid page controls %j", async overrides => {
    const source = await open(fixture());
    await expect(source.readDomainPage(page("conversations", overrides as Partial<PortableSourcePageInput>))).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("rejects ambiguous local native machine identity before publishing any records", async () => {
    const file = fixture(db => native(db));
    const ambiguous = { machines: [...facts.machines, { identityKey: "second-machine", machineId: null }], aliases: [] };
    await expect(openSqlitePortableSource(input(file, { identityFacts: ambiguous, expectedFactsSha256: canonicalSha256(ambiguous) }))).rejects.toMatchObject({ code: "unsupported-capability" });
  });

  it("aborts before opening without scratch or source changes", async () => {
    const file = fixture(); const before = readFileSync(file.path);
    const controller = new AbortController(); controller.abort();
    await expect(openSqlitePortableSource(input(file, { signal: controller.signal })).then(result => { sources.push(result); return "unexpected success"; })).rejects.toMatchObject({ code: "aborted", retryable: true });
    expect(readFileSync(file.path)).toEqual(before); expect(readdirSync(file.dir)).toEqual(["source.db"]);
  });

  it("observes a timer abort during real source pre-scan and cleans its validation index", async () => {
    const file = fixture(db => conversations(db, 1000));
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 0);
    try { await expect(openSqlitePortableSource(input(file, { signal: controller.signal })).then(result => { sources.push(result); return "unexpected success"; })).rejects.toMatchObject({ code: "aborted", retryable: true }); }
    finally { clearTimeout(timer); }
    expect(readdirSync(file.dir)).toEqual(["source.db"]);
  });

  it("observes timer cancellation during a page and preserves the reusable source", async () => {
    const source = await open(fixture(db => conversations(db, 503)));
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 0);
    try { await expect(source.readDomainPage(page("conversations", { signal: controller.signal })).then(() => "unexpected success")).rejects.toMatchObject({ code: "aborted", retryable: true }); }
    finally { clearTimeout(timer); }
    expect((await source.readDomainPage(page("conversations"))).records).toHaveLength(500);
  });

  it("sanitizes malformed SQL payload failures without exposing record text, paths or raw causes", async () => {
    const secret = "sensitive-native-payload";
    const file = fixture(db => { db.prepare("INSERT INTO promoted(id,content,project_id,metadata) VALUES('bad',?,?,?)").run(secret, identity.projectId, secret); });
    const error = await openSqlitePortableSource(input(file)).catch(error => error);
    expect(error).toBeInstanceOf(PortableTransferError); expect(error.code).toBe("source-failed");
    expect(error).not.toHaveProperty("cause"); expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(file.path);
  });

  it.each(["native metadata", "native payload", "instruction cache"])("rejects oversized %s in SQL before loading content", async kind => {
    const file = fixture(db => {
      if (kind === "instruction cache") {
        instructions(db);
        db.prepare("UPDATE session_instruction_cache SET content=replace(hex(zeroblob(?)), '00', 'x')").run(PORTABLE_LIMITS.maxRecordBytes + 1);
      } else {
        native(db);
        if (kind === "native metadata") db.prepare("UPDATE runtime_native_transcripts SET source_locator=replace(hex(zeroblob(?)), '00', 'x')").run(PORTABLE_LIMITS.maxControlBytes + 1);
        else db.prepare("UPDATE runtime_native_transcripts SET native_payload=json_object('data',replace(hex(zeroblob(?)), '00', 'x'))").run(100 * 1024 * 1024 + 1);
      }
    });
    const before = sqlitePortableFileSha256(file.path);
    const original = DatabaseSync.prototype.prepare;
    const contentReads: string[] = [];
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
      const projection = sql.split(/\bFROM\b/i)[0];
      const target = kind === "instruction cache" ? /session_instruction_cache/i : /runtime_native_transcripts/i;
      if (/^\s*SELECT/i.test(sql) && target.test(sql) && !/length\s*\(/i.test(projection)
        && (/(?:SELECT|,)\s*(?:\w+\.)?\*/i.test(projection) || /\b(?:native_payload|content)\b/.test(projection))) contentReads.push(sql);
      return original.call(this, sql);
    });
    try {
      await expect(openSqlitePortableSource(input(file)).then(result => { sources.push(result); return "unexpected success"; })).rejects.toMatchObject({ code: "unsupported-capability" });
      expect(contentReads).toEqual([]);
    } finally { spy.mockRestore(); }
    expect(sqlitePortableFileSha256(file.path)).toBe(before);
    expect(readdirSync(file.dir)).toEqual(["source.db"]);
  });

  it("rejects archived project identity mismatch before exposing archived recovery data", async () => {
    const records = buildRecords(postgresGeneration());
    const file = fixture(db => {
      initializePortableArchive(db);
      for (const record of records.get("project")!) writePortableArchiveRecord(db, record);
    });
    await expect(openSqlitePortableSource(input(file))).rejects.toMatchObject({ code: "source-changed" });
  });

  it("rejects unknown native machine IDs instead of attributing them to the local installation", async () => {
    const file = fixture(db => native(db, "unregistered-machine"));
    await expect(openSqlitePortableSource(input(file))).rejects.toMatchObject({ code: "unsupported-capability" });
  });

  it("reports a sanitized close failure and revokes reads when SQLite cleanup fails", async () => {
    const source = await open(fixture());
    const original = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === "ROLLBACK") throw new Error("private SQL cleanup diagnostic");
      return original.call(this, sql);
    });
    try {
      await expect(source.close()).rejects.toMatchObject({ code: "close-failed", retryable: false });
      await expect(source.readDomainPage(page("conversations"))).rejects.toMatchObject({ code: "source-failed" });
    } finally { spy.mockRestore(); }
    await source.close();
  });


  it.each(["pre-scan", "page"])("honors timer cancellation after %s starts reading runtime rows", async phase => {
    const file = fixture(db => conversations(db, 503));
    const source = phase === "page" ? await open(file) : undefined;
    const controller = new AbortController();
    const original = DatabaseSync.prototype.prepare;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
      if (timer === undefined && /FROM conversations/i.test(sql)) timer = setTimeout(() => controller.abort(), 0);
      return original.call(this, sql);
    });
    try {
      const operation = source === undefined
        ? openSqlitePortableSource(input(file, { signal: controller.signal })).then(result => { sources.push(result); return "unexpected success"; })
        : source.readDomainPage(page("conversations", { signal: controller.signal })).then(() => "unexpected success");
      await expect(operation).rejects.toMatchObject({ code: "aborted", retryable: true });
      expect(timer).toBeDefined();
    } finally { spy.mockRestore(); if (timer !== undefined) clearTimeout(timer); }
    if (source !== undefined) expect((await source.readDomainPage(page("conversations"))).records).toHaveLength(500);
    else expect(readdirSync(file.dir)).toEqual(["source.db"]);
  });

  it("keeps accepted page reads ordered before concurrent close and refuses later work", async () => {
    const source = await open(fixture(db => conversations(db, 3)));
    const reading = source.readDomainPage(page("conversations"));
    const closing = source.close();
    expect((await reading).records).toHaveLength(3);
    await closing;
    await expect(source.readDomainPage(page("conversations"))).rejects.toMatchObject({ code: "source-failed" });
  });

  it("sanitizes an invalid SQLite file rather than returning driver diagnostics", async () => {
    const file = fixture(); writeFileSync(file.path, "private malformed SQLite data");
    const error = await openSqlitePortableSource(input(file)).catch(error => error);
    expect(error).toBeInstanceOf(PortableTransferError); expect(error.code).toBe("source-failed");
    expect(error).not.toHaveProperty("cause"); expect(String(error)).not.toContain(file.path); expect(String(error)).not.toContain("SQLite");
  });

});
