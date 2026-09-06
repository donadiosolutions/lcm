import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";
import { initializePortableArchive } from "../../src/storage/sqlite/portable-archive.js";
import type { SqlitePortableIdentityFacts } from "../../src/storage/sqlite/portable-source.js";
import type { PortableProjectIdentity } from "../../src/storage/portable-record.js";

// The fixture preimages below contain arrays and one-key integer objects only,
// so JSON.stringify is independently canonical without production hash helpers.
function independentSha256(preimage: unknown): string {
  return createHash("sha256").update(JSON.stringify(preimage)).digest("hex");
}
function independentIdentity(domain: string, key: readonly unknown[]): string {
  return independentSha256(["lcm-portable-identity-v1", domain, key]);
}
function integer(value: number | bigint): { $integer: string } { return { $integer: String(value) }; }

export const SQLITE_PORTABLE_FIXTURE = {
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
}): void {
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE");
    runLcmMigrations(db, { fts5Available: false });
    initializePortableArchive(db);
    const f = SQLITE_PORTABLE_FIXTURE;
    const t = f.timestamp.replace("T", " ").replace("Z", "");
    const machine = input.identityFacts.machines[0].identityKey;
    const fingerprint = independentSha256(["lcm-portable-conversation-value-v1", f.sessionId, "SQLite source", null, f.timestamp, f.timestamp]);
    const conversationIdentity = independentIdentity("conversations", [fingerprint, integer(0)]);
    const messageIdentity = independentIdentity("messages", [conversationIdentity, integer(9007199254740993n)]);
    const transcriptIdentity = independentIdentity("native-transcripts", [machine, f.ingestKey]);
    const archive = (domain: string, ordinal: number, fields: Record<string, SQLInputValue>) => {
      const columns = Object.keys(fields);
      db.prepare(`INSERT INTO portable_archive_${domain.replaceAll("-", "_")}
        (_ordinal,_identity_sha256,${columns.map(column => `"${column}"`).join(",")})
        VALUES(?,?,${columns.map(() => "?").join(",")})`).run(
        ordinal, independentSha256(["independent-native-sqlite-fixture", domain, ordinal]), ...Object.values(fields),
      );
    };
    db.exec("BEGIN");
    for (const [ordinal, value] of input.identityFacts.machines.entries()) archive("machines", ordinal, { ...value });
    archive("project", 0, { ...input.projectIdentity });
    for (const [ordinal, value] of input.identityFacts.aliases.entries()) archive("project-aliases", ordinal, { ...value });
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
      VALUES(?,?,'["same","","same"]','{"nested":{"ok":true},"ordinal":2}','orphan-summary',?,?,1,0.75,?,?)`).run(f.memoryId, f.content, input.projectIdentity.projectId, f.sessionId, t, t);
    db.prepare("INSERT INTO recall_surfacing(memory_id,session_id,surfaced_at) VALUES('orphan-memory',NULL,?),('orphan-memory',NULL,?)").run(t, t);
    db.prepare("INSERT INTO redaction_stats VALUES(?,'gitleaks',?)").run(input.projectIdentity.projectId, 9223372036854775807n);
    db.prepare("INSERT INTO session_ingest_log(session_id,completed_at,message_count) VALUES(?,?,?)").run(f.sessionId, t, 9007199254740993n);
    for (const [ordinal, value] of input.identityFacts.machines.entries()) archive("session-instructions", ordinal, {
      machineIdentityKey: value.identityKey, scopeHash: f.scopeHash, clientName: "codex", sessionId: f.sessionId,
      worktreePath: "/portable/sqlite", cwdPath: "/portable/sqlite/src", content: `instructions ${ordinal}`,
      contentHash: "c".repeat(64), updatedAt: f.timestamp,
    });
    archive("native-transcripts", 0, {
      machineIdentityKey: machine, clientName: "codex", formatName: "jsonl", formatVersion: "1",
      nativeSessionId: f.sessionId, sourceLocator: f.sourceLocator, sourceOrdinal: 1n,
      observedAt: f.timestamp, ingestedAt: f.timestamp, scrubberVersion: "1", contentSha256: "b".repeat(64),
      ingestKey: f.ingestKey, nativePayload: '{"role":"assistant","content":["scrubbed","native"]}',
    });
    archive("native-transcript-message-links", 0, {
      machineIdentityKey: machine, ingestKey: f.ingestKey, sourceOrdinal: 0n,
      conversationIdentitySha256: conversationIdentity, messageIdentitySha256: messageIdentity,
      _transcript_identity_sha256: transcriptIdentity,
    });
    archive("native-transcript-checkpoints", 0, {
      machineIdentityKey: machine, clientName: "codex", sourceLocator: f.sourceLocator, revision: 9007199254740991n,
      lastSourceOrdinal: 9007199254740993n, importedCount: 9007199254740993n, skippedCount: 2n,
      quarantinedCount: 1n, checkpoint: '{"cursor":"exact","nested":{"offset":"9007199254740993"}}', updatedAt: f.timestamp,
    });
    for (const [ordinal, disposition] of ["pending", "applied", "quarantined"].entries()) archive("passive-events", ordinal, {
      machineIdentityKey: machine, eventId: `55555555-5555-4555-8555-55555555555${ordinal}`,
      eventVersion: 1n, machineSequence: 9007199254740993n + BigInt(ordinal), eventType: "user_prompt",
      sessionId: f.sessionId, sessionSequence: BigInt(ordinal), category: "prompt", data: '{"safe":true}',
      priority: 0n, sourceHook: "UserPromptSubmit", createdAt: f.timestamp, disposition,
    });
    db.exec("COMMIT");
  } finally { db.close(); }
}
