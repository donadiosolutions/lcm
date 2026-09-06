import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PORTABLE_LIMITS } from "../../src/storage/portable-record.js";
import { PortableTransferError } from "../../src/storage/portable-transfer.js";
import {
  iterateSqliteSidecarDomainRows,
  readSqliteSidecarDomainRow,
  validateSqliteSidecarSchema,
} from "../../src/storage/sqlite/portable-sidecars.js";

// Independent copies of the current production schemas, not adapter DDL.
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
const options = {
  projectIdentity: { scope: "local" as const, projectId: "project-one" },
  machineIdentityKey: "machine-key",
  machineId: "machine-registration",
};
const resources: { root: string; db: DatabaseSync }[] = [];
function database(seed: (db: DatabaseSync) => void): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "lcm-sidecar-"));
  const path = join(root, "sidecar.db");
  const writable = new DatabaseSync(path);
  try { seed(writable); } finally { writable.close(); }
  const db = new DatabaseSync(path, { readOnly: true });
  resources.push({ root, db });
  return db;
}
function event(db: DatabaseSync, id = 1n): void {
  db.prepare(`INSERT INTO events(event_id,event_uuid,event_version,machine_id,machine_sequence,session_id,seq,type,category,data,source_hook,created_at)
    VALUES(?,?,2,?,?,?,?,'learning','pattern','{"value":"é"}','PostToolUse','2026-09-06 10:11:12.123456')`)
    .run(id, `event-${id}`, options.machineId, String(id).padStart(19,"0"), "session", id);
}
function instruction(db: DatabaseSync, id = 1, project = "project-one"): void {
  db.prepare(`INSERT INTO session_instruction_cache VALUES(?,?,'codex','session','/worktree','/cwd','content','hash','2026-09-06 10:11:12')`)
    .run(project, id.toString(16).padStart(64,"0"));
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, db } of resources.splice(0)) {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("captured SQLite sidecar projection", () => {
  it("projects exact event facts and all normalized dispositions without delivery authority", () => {
    const db = database(db => {
      db.exec(eventsSql);
      for (let id = 1n; id <= 7n; id++) event(db,id);
      db.exec(`UPDATE events SET processed_at='done',delivery_last_error='PRIVATE-CANARY' WHERE event_id=2;
        UPDATE events SET delivery_state='quarantined',quarantine_reason='PRIVATE-CANARY' WHERE event_id IN(3,4);
        UPDATE events SET processed_at='done' WHERE event_id=4;
        UPDATE events SET delivery_state='acknowledged',acknowledged_at='done',remote_inbox_id='PRIVATE-CANARY' WHERE event_id=5;
        UPDATE events SET delivery_state='claimed',delivery_claimed_at='now',delivery_owner='PRIVATE-CANARY' WHERE event_id=6;
        UPDATE events SET machine_id=NULL,delivery_state='retry' WHERE event_id=7`);
    });
    const rows = [...iterateSqliteSidecarDomainRows(db,"passive-events",options)];
    expect(rows.map(row => row.value.disposition)).toEqual(["pending","applied","quarantined","applied","applied","pending","pending"]);
    expect(rows[0]).toEqual({locator:"1",value:{machineIdentityKey:"machine-key",eventId:"event-1",eventVersion:2n,machineSequence:1n,eventType:"learning",sessionId:"session",sessionSequence:1n,category:"pattern",data:'{"value":"é"}',priority:3n,sourceHook:"PostToolUse",createdAt:"2026-09-06T10:11:12.123456Z",disposition:"pending"}});
    expect(rows.flatMap(row => Object.keys(row.value))).not.toContain("machineId");
    expect(rows.flatMap(row => Object.values(row.value))).not.toContain("PRIVATE-CANARY");
    expect(readSqliteSidecarDomainRow(db,"passive-events","3",options)).toEqual(rows[2]);
    expect(readSqliteSidecarDomainRow(db,"passive-events","100",options)).toBeUndefined();
    expect(db.prepare("SELECT delivery_owner FROM events WHERE event_id=6").get()?.delivery_owner).toBe("PRIVATE-CANARY");
  });

  it("uses integer keysets beyond 500 rows and retains int64 values exactly", () => {
    const large = 9007199254740993n;
    const db = database(db => {
      db.exec(eventsSql);
      for(let id=1n;id<=1005n;id++) event(db,id);
      event(db,large);
      db.exec(`UPDATE events SET event_version=9007199254740993 WHERE event_id=${large}`);
    });
    const rows=[...iterateSqliteSidecarDomainRows(db,"passive-events",options)];
    expect(rows).toHaveLength(1006);
    expect(rows[499]?.locator).toBe("500");
    expect(rows[500]?.locator).toBe("501");
    expect(rows[1005]?.value).toMatchObject({eventVersion:large,machineSequence:large,sessionSequence:large});
    expect(readSqliteSidecarDomainRow(db,"passive-events",String(large),options)).toEqual(rows[1005]);
  });

  it.each(["different",null])("rejects mismatched admitted machine %s without raw identifiers", machineId => {
    const db=database(db=>{db.exec(eventsSql);event(db);});
    expect(()=>[...iterateSqliteSidecarDomainRows(db,"passive-events",{...options,machineId})]).toThrow(new PortableTransferError("unsupported-capability"));
  });

  it("retains null local machine registrations without inventing identities", () => {
    const db=database(db=>{db.exec(eventsSql);event(db);db.exec("UPDATE events SET machine_id=NULL");});
    expect(readSqliteSidecarDomainRow(db,"passive-events","1",{...options,machineId:null})?.value.machineIdentityKey).toBe("machine-key");
  });

  it("refuses canonical-unsupported nullable priority", () => {
    const db=database(db=>{db.exec(eventsSql);event(db);db.exec("UPDATE events SET priority=NULL");});
    expect(()=>readSqliteSidecarDomainRow(db,"passive-events","1",options)).toThrow(new PortableTransferError("unsupported-capability"));
  });

  it("scopes caches exactly by project and pages by scope across 500 records", () => {
    const db=database(db=>{
      db.exec(instructionsSql);
      for(let id=1;id<=501;id++) instruction(db,id);
      instruction(db,1,"project-one-suffix");
      instruction(db,502,"other");
    });
    const rows=[...iterateSqliteSidecarDomainRows(db,"session-instructions",options)];
    expect(rows).toHaveLength(501);
    expect(rows[0]).toEqual({locator:"1".padStart(64,"0"),value:{machineIdentityKey:"machine-key",scopeHash:"1".padStart(64,"0"),clientName:"codex",sessionId:"session",worktreePath:"/worktree",cwdPath:"/cwd",content:"content",contentHash:"hash",updatedAt:"2026-09-06T10:11:12.000000Z"}});
    expect(readSqliteSidecarDomainRow(db,"session-instructions",rows[500]!.locator,options)).toEqual(rows[500]);
    expect(readSqliteSidecarDomainRow(db,"session-instructions",(502).toString(16).padStart(64,"0"),options)).toBeUndefined();
    expect([...iterateSqliteSidecarDomainRows(db,"session-instructions",{...options,projectIdentity:{scope:"local",projectId:"absent"}})]).toEqual([]);
  });

  it.each(["passive-events","session-instructions"] as const)("rejects oversized %s payload before the driver fetch", domain => {
    const db=database(db=>{
      db.exec(domain==="passive-events"?eventsSql:instructionsSql);
      if(domain==="passive-events") { event(db);db.exec(`UPDATE events SET data=zeroblob(${PORTABLE_LIMITS.maxRecordBytes+1})`); }
      else { instruction(db);db.exec(`UPDATE session_instruction_cache SET content=zeroblob(${PORTABLE_LIMITS.maxRecordBytes+1})`); }
    });
    const prepare=vi.spyOn(db,"prepare");
    expect(()=>[...iterateSqliteSidecarDomainRows(db,domain,options)]).toThrow(new PortableTransferError("unsupported-capability"));
    expect(()=>readSqliteSidecarDomainRow(db,domain,domain==="passive-events"?"1":"1".padStart(64,"0"),options)).toThrow(new PortableTransferError("unsupported-capability"));
    for(const [sql] of prepare.mock.calls) expect(sql).toContain("length(CAST(");
  });

  it("uses direct indexed point predicates with no full-domain scan", () => {
    const db=database(db=>{db.exec(eventsSql);event(db);db.exec(instructionsSql);instruction(db);});
    const prepare=vi.spyOn(db,"prepare");
    readSqliteSidecarDomainRow(db,"passive-events","1",options);
    readSqliteSidecarDomainRow(db,"session-instructions","1".padStart(64,"0"),options);
    expect(prepare.mock.calls).toHaveLength(4);
    for(const [sql] of prepare.mock.calls) {
      expect(sql).toMatch(/WHERE/);
      expect(sql).not.toMatch(/OFFSET|ORDER BY/);
      const params=sql.includes("session_instruction_cache")?["project-one","1".padStart(64,"0")]:["1"];
      const plan=DatabaseSync.prototype.prepare.call(db,`EXPLAIN QUERY PLAN ${sql}`).all(...params);
      expect(plan.map(row=>row.detail).join(" ")).toContain("SEARCH");
    }
  });

  it("sanitizes missing or incompatible SQL schemas", () => {
    const db=database(db=>{db.exec("CREATE TABLE secret_canary(data TEXT)");});
    expect(()=>[...iterateSqliteSidecarDomainRows(db,"passive-events",options)]).toThrow(new PortableTransferError("source-failed"));
    expect(()=>readSqliteSidecarDomainRow(db,"session-instructions","1",options)).toThrow(new PortableTransferError("source-failed"));
  });
});


describe("captured SQLite schema admission", () => {
  it("accepts current events and standalone instructions without schema changes", () => {
    const db = database(db=>{db.exec(eventsSql+";"+eventMetadataSql);event(db);});
    expect(()=>validateSqliteSidecarSchema(db,"passive-events")).not.toThrow();
    const cache=database(db=>{db.exec(instructionsSql);instruction(db);});
    expect(()=>validateSqliteSidecarSchema(cache,"session-instructions")).not.toThrow();
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
    expect(db.prepare("SELECT version FROM schema_version").get()?.version).toBe(5);
  });

  it.each([
    "PRAGMA user_version=1", "UPDATE schema_version SET version=6",
    "INSERT INTO schema_version VALUES(5)", "DELETE FROM schema_version",
    "ALTER TABLE events ADD COLUMN future_field TEXT",
    "CREATE TABLE future_domain(data TEXT)", "CREATE VIEW future_domain AS SELECT data FROM events",
    "CREATE TRIGGER future_trigger AFTER INSERT ON events BEGIN SELECT 1; END",
    "DROP TABLE error_log", "ALTER TABLE schema_version ADD COLUMN future_field TEXT",
    "DROP TABLE error_log; CREATE TABLE unknown_data(value TEXT)",
    "DROP TABLE error_log; CREATE VIEW error_log AS SELECT data FROM events",
    "ALTER TABLE events RENAME COLUMN data TO future_data",
    "DROP TABLE missing_cwd_state; CREATE TABLE missing_cwd_state(id INTEGER, observations TEXT, last_observed_at INTEGER, parked_at TEXT)",
  ])("refuses unsupported events shape: %s", mutation => {
    const db=database(db=>{db.exec(eventsSql+";"+eventMetadataSql);db.exec(mutation);});
    expect(()=>validateSqliteSidecarSchema(db,"passive-events")).toThrow(new PortableTransferError("unsupported-capability"));
  });

  it.each([
    "ALTER TABLE session_instruction_cache ADD COLUMN future_field TEXT",
    "CREATE TABLE events(data TEXT)",
    "DROP TABLE session_instruction_cache; CREATE TABLE session_instruction_cache(id INTEGER PRIMARY KEY,content TEXT,content_hash TEXT,updated_at TEXT)",
  ])("refuses incompatible dedicated instruction cache: %s", mutation=>{
    const db=database(db=>{db.exec(instructionsSql);db.exec(mutation);});
    expect(()=>validateSqliteSidecarSchema(db,"session-instructions")).toThrow(new PortableTransferError("unsupported-capability"));
  });

  it("sanitizes admission driver failure",()=>{
    const db=database(db=>{db.exec(eventsSql+";"+eventMetadataSql);});
    vi.spyOn(db,"prepare").mockImplementation(()=>{throw new Error("PRIVATE-SCHEMA-CANARY");});
    expect(()=>validateSqliteSidecarSchema(db,"passive-events")).toThrow(new PortableTransferError("source-failed"));
  });
});

describe("sidecar projection malformed and lost rows",()=>{
  it.each(["'not-a-timestamp'", "x'1234'"])("refuses unsupported timestamp %s",value=>{
    const db=database(db=>{db.exec(eventsSql);event(db);db.exec(`UPDATE events SET created_at=${value}`);});
    expect(()=>readSqliteSidecarDomainRow(db,"passive-events","1",options)).toThrow(new PortableTransferError("unsupported-capability"));
  });

  it.each(["'wrong-sequence'","1234","x'1234'"])("refuses corrupted machine sequence %s",value=>{
    const db=database(db=>{db.exec(eventsSql);event(db);db.exec(`PRAGMA ignore_check_constraints=ON;UPDATE events SET machine_sequence=${value}`);});
    expect(()=>readSqliteSidecarDomainRow(db,"passive-events","1",options)).toThrow(new PortableTransferError("unsupported-capability"));
  });

  it.each(["metadata","payload"])("fails closed if %s point row disappears",missing=>{
    const db=database(db=>{db.exec(eventsSql);event(db);});
    const original=db.prepare.bind(db);
    vi.spyOn(db,"prepare").mockImplementation(sql=>{
      const statement=original(sql);
      const match=missing==="metadata"?sql.includes(" AS bytes FROM "):!sql.includes("length(CAST(");
      if(match) vi.spyOn(statement,"get").mockReturnValue(undefined);
      return statement;
    });
    expect(()=>[...iterateSqliteSidecarDomainRows(db,"passive-events",options)]).toThrow(new PortableTransferError("source-failed"));
  });
});


it("preserves exact project scope even if a cache column has a case-insensitive collation",()=>{
  const db=database(db=>{
    db.exec(instructionsSql.replace("project_id TEXT NOT NULL","project_id TEXT COLLATE NOCASE NOT NULL"));
    instruction(db,1,"PROJECT-ONE");
  });
  expect([...iterateSqliteSidecarDomainRows(db,"session-instructions",options)]).toEqual([]);
  expect(readSqliteSidecarDomainRow(db,"session-instructions","1".padStart(64,"0"),options)).toBeUndefined();
});


describe("sidecar TEXT NUL capability boundary", () => {
  it.each([
    ["passive-events", "event_uuid"], ["passive-events", "machine_id"],
    ["passive-events", "session_id"], ["passive-events", "data"],
    ["passive-events", "created_at"], ["session-instructions", "scope_hash"],
    ["session-instructions", "content"], ["session-instructions", "cwd_path"],
  ] as const)("refuses actual NUL in %s.%s in admission and both read interfaces", (domain, column) => {
    const value = "prefix\0suffix";
    const table = domain === "passive-events" ? "events" : "session_instruction_cache";
    const db = database(db => {
      db.exec(domain === "passive-events" ? eventsSql + ";" + eventMetadataSql : instructionsSql);
      if (domain === "passive-events") event(db); else instruction(db);
      db.exec("PRAGMA ignore_check_constraints=ON");
      db.prepare(`UPDATE ${table} SET ${column}=?`).run(value);
    });
    expect(db.prepare(`SELECT length(CAST(${column} AS BLOB)) AS bytes, ${column} AS value FROM ${table}`).get())
      .toEqual({ bytes: Buffer.byteLength(value), value: "prefix" });
    expect(() => validateSqliteSidecarSchema(db, domain)).toThrow(new PortableTransferError("unsupported-capability"));
    const prepare = vi.spyOn(db, "prepare");
    expect(() => [...iterateSqliteSidecarDomainRows(db, domain, options)]).toThrow(new PortableTransferError("unsupported-capability"));
    expect(() => readSqliteSidecarDomainRow(db, domain, domain === "passive-events" ? "1" : column === "scope_hash" ? value : "1".padStart(64, "0"), options))
      .toThrow(new PortableTransferError("unsupported-capability"));
    expect(prepare.mock.calls).toHaveLength(2);
    for (const [sql] of prepare.mock.calls) expect(sql).toContain(" AS nul, ");
  });

  it("refuses NUL in instruction project scope during admission and scoped reads", () => {
    const value = "project-one\0suffix";
    const db = database(db => { db.exec(instructionsSql); instruction(db, 1, value); });
    const identity = { ...options, projectIdentity: { scope: "local" as const, projectId: value } };
    expect(() => validateSqliteSidecarSchema(db, "session-instructions")).toThrow(new PortableTransferError("unsupported-capability"));
    expect(() => [...iterateSqliteSidecarDomainRows(db, "session-instructions", identity)]).toThrow(new PortableTransferError("unsupported-capability"));
    expect(() => readSqliteSidecarDomainRow(db, "session-instructions", "1".padStart(64,"0"), identity)).toThrow(new PortableTransferError("unsupported-capability"));
  });

  it("preserves escaped NUL text and does not inspect private operational fields", () => {
    const text = JSON.stringify({ value: "prefix\0suffix", literal: "\\u0000" });
    const db = database(db => {
      db.exec(eventsSql + ";" + eventMetadataSql); event(db);
      db.prepare("UPDATE events SET data=?, delivery_last_error=?, quarantine_reason=?, delivery_state='quarantined'")
        .run(text, "private\0error", "private\0reason");
      db.prepare("INSERT INTO error_log(hook,error) VALUES('hook',?)").run("private\0error");
    });
    expect(() => validateSqliteSidecarSchema(db, "passive-events")).not.toThrow();
    const row = readSqliteSidecarDomainRow(db, "passive-events", "1", options)!;
    expect(row.value.data).toBe(text);
    expect(JSON.parse(row.value.data as string)).toEqual({ value: "prefix\0suffix", literal: "\\u0000" });
    expect([...iterateSqliteSidecarDomainRows(db, "passive-events", options)]).toEqual([row]);
  });
});
