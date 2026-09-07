import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";
import type { OpenSqlitePortableSourceInput, SqlitePortableIdentityFacts } from "../../src/storage/sqlite/portable-source.js";
import type { PortableProjectIdentity } from "../../src/storage/portable-record.js";

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

export const SQLITE_PORTABLE_FIXTURE = {
  sourceLocalProjectId: createHash("sha256").update("/fixture/linked-project").digest("hex"),
  ownProjectMemoryId: "33333333-3333-4333-8333-333333333334",
  externalMemoryId: "33333333-3333-4333-8333-333333333335",
  externalProjectId: "external-sqlite-project",
  timestamp: "2026-09-06T12:00:00.123456Z",
  sessionId: "independent-sqlite-session",
  memoryId: "33333333-3333-4333-8333-333333333333",
  partId: "44444444-4444-4444-8444-444444444444",
  content: "Independently seeded SQLite portable memory",
  scopeHash: "d".repeat(64),
  ingestKey: "e".repeat(64),
  sourceLocator: "capture://independent-sqlite/native.jsonl",
} as const;

/** Independent native SQL seed: no canonical destination or mapping writer is used. */
export function seedPortableSqlite(databasePath: string, input: {
  readonly projectIdentity: PortableProjectIdentity;
  readonly identityFacts: SqlitePortableIdentityFacts;
  readonly sourceLocalProjectId?: string;
}): Pick<OpenSqlitePortableSourceInput, "sourceLocalProjectId" | "identityFacts" | "expectedFactsSha256" | "machineIdentityKey" | "capturedSidecars"> {
  const sourceLocalProjectId = input.sourceLocalProjectId ?? SQLITE_PORTABLE_FIXTURE.sourceLocalProjectId;
  const identityFacts = { ...input.identityFacts, sourceLocalProjectId };
  const machineIdentityKey = identityFacts.machines[0].identityKey;
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE");
    runLcmMigrations(db, { fts5Available: false });
    const f = SQLITE_PORTABLE_FIXTURE;
    const t = f.timestamp.replace("T", " ").replace("Z", "");
    db.exec("BEGIN");
    db.prepare("INSERT INTO conversations(conversation_id,session_id,title,created_at,updated_at) VALUES(71,?,'SQLite source',?,?)").run(f.sessionId, t, t);
    db.prepare("INSERT INTO messages(message_id,conversation_id,seq,role,content,token_count,created_at) VALUES(83,71,?,'assistant','SQLite source message',?,?)").run(9007199254740993n, 9007199254740995n, t);
    db.prepare(`INSERT INTO message_parts(part_id,message_id,session_id,part_type,ordinal,text_content,
      is_ignored,is_synthetic,tool_call_id,tool_name,tool_status,tool_input,tool_output,tool_error,tool_title,
      patch_hash,patch_files,file_mime,file_name,file_url,subtask_prompt,subtask_desc,subtask_agent,step_reason,
      step_cost,step_tokens_in,step_tokens_out,snapshot_hash,compaction_auto,metadata)
      VALUES(?,83,?,'subtask',0,'part text',0,1,'call','tool','done','{}','output','error','title',
      'patch','["a","a"]','text/plain','a','file:///opaque/a','prompt','exact subtask description','agent',
      'stop',0.125,?,?, 'snapshot',1,'{"preserved":true}')`).run(f.partId, f.sessionId, 9007199254740993n, 9007199254740994n);
    db.prepare("INSERT INTO large_files(file_id,conversation_id,file_name,mime_type,byte_size,storage_uri,exploration_summary,created_at) VALUES('sqlite-file',71,'a','text/plain',?,'opaque://sqlite-file','explored',?)").run(9007199254740993n, t);
    db.prepare(`INSERT INTO summaries(summary_id,conversation_id,kind,depth,content,token_count,earliest_at,latest_at,
      descendant_count,descendant_token_count,source_message_token_count,created_at,file_ids)
      VALUES('sqlite-leaf',71,'leaf',0,'SQLite leaf',3,?,?,0,0,?,?, '["sqlite-file","missing-file","sqlite-file"]')`).run(t, t, 9007199254740995n, t);
    db.prepare("INSERT INTO summaries(summary_id,conversation_id,kind,depth,content,token_count,created_at) VALUES('sqlite-parent',71,'condensed',1,'SQLite parent',4,?)").run(t);
    db.exec("INSERT INTO summary_messages VALUES('sqlite-leaf',83,0); INSERT INTO summary_parents VALUES('sqlite-parent','sqlite-leaf',0)");
    db.prepare("INSERT INTO context_items VALUES(71,0,'message',83,NULL,?),(71,1,'summary',NULL,'sqlite-parent',?)").run(t, t);
    db.prepare(`INSERT INTO promoted(id,content,tags,metadata,source_summary_id,project_id,session_id,depth,confidence,created_at,archived_at)
      VALUES(?,?,'["same","","same"]','{"nested":{"ok":true},"ordinal":2}','orphan-summary',?,?,1,0.75,?,?)`).run(f.memoryId, f.content, sourceLocalProjectId, f.sessionId, t, t);
    db.prepare("INSERT INTO recall_surfacing(memory_id,session_id,surfaced_at) VALUES('orphan-memory',NULL,?),('orphan-memory',NULL,?)").run(t, t);
    db.prepare("INSERT INTO redaction_stats VALUES(?,'gitleaks',?)").run(sourceLocalProjectId, 9223372036854775807n);
    db.prepare("INSERT INTO session_ingest_log(session_id,completed_at,message_count) VALUES(?,?,?)").run(f.sessionId, t, 9007199254740993n);
    db.prepare(`INSERT INTO promoted(id,content,tags,metadata,project_id,session_id,depth,confidence,created_at)
      VALUES(?,'Active own SQLite memory','["own"]','{}',?,?,0,1,?),
      (?,'External SQLite provenance','["external"]','{}',?,?,0,1,?)`).run(
      f.ownProjectMemoryId, sourceLocalProjectId, f.sessionId, t,
      f.externalMemoryId, f.externalProjectId, f.sessionId, t);
    db.prepare("INSERT INTO session_instruction_cache VALUES(?,?,?,?,?,?,?,?,?)").run(
      sourceLocalProjectId, f.scopeHash, "codex", f.sessionId, "/portable/sqlite", "/portable/sqlite/src",
      "main instructions", "c".repeat(64), t);
    db.prepare("INSERT INTO runtime_native_transcripts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "sqlite-transcript", sourceLocalProjectId, "local", "codex", "jsonl", "1", f.sessionId, f.sourceLocator,
      1n, t, t, "1", "b".repeat(64), f.ingestKey, '{"role":"assistant","content":["scrubbed","native"]}');
    db.prepare("INSERT INTO runtime_native_transcript_messages VALUES(?,?,71,83,0)").run(sourceLocalProjectId, "sqlite-transcript");
    db.prepare("INSERT INTO runtime_native_ingest_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      sourceLocalProjectId, "local", "codex", f.sourceLocator, 9007199254740991n, 9007199254740993n,
      9007199254740993n, 2n, 1n, '{"cursor":"exact","nested":{"offset":"9007199254740993"}}', t);
    db.exec("COMMIT");
  } finally { db.close(); }
  const capturedFile = (path: string, machineKey: string, seed: (connection: DatabaseSync) => void) => {
    const connection = new DatabaseSync(path);
    try { connection.exec("PRAGMA journal_mode=DELETE"); seed(connection); } finally { connection.close(); }
    chmodSync(path, 0o600);
    return { databasePath: path, machineIdentityKey: machineKey,
      expectedFileSha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
  };
  const f = SQLITE_PORTABLE_FIXTURE;
  const t = f.timestamp.replace("T", " ").replace("Z", "");
  const instructions = input.identityFacts.machines.map((machine, ordinal) => capturedFile(
    `${databasePath}.instructions-${ordinal}.sqlite`, machine.identityKey, connection => {
      connection.exec(instructionsSql);
      connection.prepare("INSERT INTO session_instruction_cache VALUES(?,?,?,?,?,?,?,?,?)").run(
        sourceLocalProjectId, createHash("sha256").update(`sidecar-scope-${ordinal}`).digest("hex"), "codex",
        f.sessionId, "/portable/sqlite", "/portable/sqlite/src", `sidecar instructions ${ordinal}`, "c".repeat(64), t);
    }));
  const events = capturedFile(`${databasePath}.events.sqlite`, machineIdentityKey, connection => {
    connection.exec(eventsSql); connection.exec(eventMetadataSql);
    for (const [ordinal, state] of ["pending", "acknowledged", "quarantined"].entries()) {
      connection.prepare(`INSERT INTO events(event_uuid,event_version,machine_id,machine_sequence,session_id,seq,
        type,category,data,priority,source_hook,created_at,delivery_state,remote_inbox_id,acknowledged_at,quarantine_reason)
        VALUES(?,1,?,?,?,?, 'user_prompt','prompt','{"safe":true}',0,'UserPromptSubmit',?,?,?,?,?)`).run(
        `55555555-5555-4555-8555-55555555555${ordinal}`, identityFacts.machines[0].machineId,
        String(9007199254740993n + BigInt(ordinal)).padStart(19, "0"), f.sessionId, ordinal, t, state,
        state === "acknowledged" ? "remote-inbox" : null, state === "acknowledged" ? t : null,
        state === "quarantined" ? "fixture quarantine" : null);
    }
  });
  // The facts hash uses the same frozen canonical JSON representation as source
  // admission, independently encoded here by sorting object keys recursively.
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)])) : value;
  return { sourceLocalProjectId, identityFacts, machineIdentityKey,
    expectedFactsSha256: createHash("sha256").update(JSON.stringify(sorted(identityFacts))).digest("hex"),
    capturedSidecars: { instructions, events } };
}
