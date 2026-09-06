import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import type { PostgreSqlQueryExecutor } from "../../src/storage/postgresql/contracts.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { settings, type PostgreSqlTestDatabase } from "./harness.js";

/** Install the reviewed grant profile using the isolated harness administrator. */
export async function grantPortablePostgreSql(
  database: PostgreSqlTestDatabase,
  options: { readonly transfer?: boolean } = {},
): Promise<void> {
  const scripts = [
    "postgresql-runtime-readiness-grants.sql",
    "postgresql-runtime-identity-grants.sql",
    "postgresql-runtime-conversation-grants.sql",
    "postgresql-runtime-summary-context-grants.sql",
    "postgresql-runtime-memory-grants.sql",
    "postgresql-runtime-search-grants.sql",
    "postgresql-runtime-coordination-grants.sql",
    "postgresql-runtime-transcript-grants.sql",
    ...(options.transfer ? ["postgresql-transfer-grants.sql"] : []),
  ];
  const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
  try {
    for (const script of scripts) {
      const sql = readFileSync(join(process.cwd(), "src/storage/postgresql/reference", script), "utf8")
        .split("\n").filter(line => !line.startsWith("\\")).join("\n")
        .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"')
        .replaceAll(':"lcm_transfer_role"', '"lcm_test_runtime"');
      await administrator.query({ text: sql }, {
        domain: "factory", operation: "grantPortablePostgreSql",
      });
    }
  } finally {
    await administrator.close();
  }
}

const path = "/portable-project";
const localProjectId = createHash("sha256").update(path).digest("hex");
const projectId = "01990000-0000-7000-8000-000000000001";
const machineId = "01990000-0000-7000-8000-000000000002";
const secondaryMachineId = "01990000-0000-7000-8000-000000000003";

/** Fixed authority is reproduced in separate, harness-owned databases only. */
export const PORTABLE_POSTGRESQL_FIXTURE = Object.freeze({
  projectId,
  machineId,
  secondaryMachineId,
  identityKey: localProjectId,
  localProjectId,
  path,
  machineIdentityKey: `machine:${"a".repeat(64)}`,
  secondaryMachineIdentityKey: `machine:${"b".repeat(64)}`,
  memoryId: "11111111-1111-4111-8111-111111111111",
  archivedMemoryId: "11111111-1111-4111-8111-111111111112",
  partId: "22222222-2222-4222-8222-222222222222",
  nullPartId: "22222222-2222-4222-8222-222222222223",
  sessionId: "portable-session",
  summaryId: "portable-leaf",
  parentSummaryId: "portable-condensed",
  fileId: "portable-file",
  scopeHash: "c".repeat(64),
  ingestKey: "d".repeat(64),
  sourceLocator: "portable/native.jsonl",
  timestamp: "2026-01-02T03:04:05.123456Z",
  laterTimestamp: "2026-01-02T03:04:06.654321Z",
  largeInteger: "9007199254740993",
  expectedIdentity: Object.freeze({
    id: projectId,
    localProjectId,
    canonical: path,
    selectedPath: path,
    remoteProjectId: projectId,
    machineId,
  } satisfies StorageIdentityContext),
});

/**
 * Independent native SQL oracle: never calls the portable mapper or writer.
 * The executor must belong to a fresh isolated PostgreSQL 18 test database.
 * Factory context is intentional: only this administrative fixture bypasses
 * ordinary project mutation guards. The caller owns transaction and cleanup.
 */
export async function seedPortablePostgreSql(
  executor: PostgreSqlQueryExecutor,
  options: { readonly identityOnly?: boolean } = {},
) {
  const fixture = PORTABLE_POSTGRESQL_FIXTURE;
  const at = fixture.timestamp;
  const later = fixture.laterTimestamp;
  const big = fixture.largeInteger;
  const query = (text: string, values: unknown[] = []) => executor.query(
    { text, values }, { domain: "factory", operation: "seedPortablePostgreSql" },
  );
  await query(`INSERT INTO lcm.machines
    (machine_id, identity_key, display_name, registered_at, last_seen_at)
    VALUES ($1, $2, 'Portable primary', $5, $6), ($3, $4, NULL, $5, $6)`,
  [machineId, fixture.machineIdentityKey, secondaryMachineId,
    fixture.secondaryMachineIdentityKey, at, later]);
  await query(`INSERT INTO lcm.projects
    (project_id, identity_key, display_name, created_at, updated_at)
    VALUES ($1, $2, 'Portable project', $3, $4)`, [projectId, localProjectId, at, later]);
  await query(`INSERT INTO lcm.project_aliases
    (project_id, machine_id, path, normalized_path, linked_at)
    VALUES ($1, $2, $4, $4, $5),
      ($1, $2, '/portable-worktree', '/portable-worktree', $5),
      ($1, $3, '/secondary/portable-project', '/secondary/portable-project', $5)`,
  [projectId, machineId, secondaryMachineId, path, at]);
  if (options.identityOnly) return { ...fixture };

  const conversation = await query(`INSERT INTO lcm.conversations
    (project_id, session_id, title, bootstrapped_at, created_at, updated_at)
    VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING conversation_id::text`,
  [projectId, fixture.sessionId, at, later]);
  const conversationId = conversation.rows[0].conversation_id as string;
  const duplicate = await query(`INSERT INTO lcm.conversations
    (project_id, session_id, title, bootstrapped_at, created_at, updated_at)
    VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING conversation_id::text`,
  [projectId, fixture.sessionId, at, later]);
  const duplicateConversationId = duplicate.rows[0].conversation_id as string;
  const message = await query(`INSERT INTO lcm.messages
    (project_id, conversation_id, seq, role, content, token_count, created_at)
    VALUES ($1, $2, 0, 'user', 'Portable primary message', $3, $4)
    RETURNING message_id::text`, [projectId, conversationId, big, at]);
  const messageId = message.rows[0].message_id as string;
  await query(`INSERT INTO lcm.messages
    (project_id, conversation_id, seq, role, content, token_count, created_at)
    VALUES ($1, $2, 0, 'assistant', 'Different duplicate-header closure', 7, $3)`,
  [projectId, duplicateConversationId, later]);
  await query(`INSERT INTO lcm.message_parts
    (part_id, project_id, conversation_id, message_id, session_id, part_type, ordinal,
     text_content, is_ignored, is_synthetic, tool_call_id, tool_name, tool_status,
     tool_input, tool_output, tool_error, tool_title, patch_hash, patch_files,
     file_mime, file_name, file_url, subtask_prompt, subtask_desc, subtask_agent,
     step_reason, step_cost, step_tokens_in, step_tokens_out, snapshot_hash,
     compaction_auto, metadata)
    VALUES ($1, $2, $3, $4, $5, 'subtask', 0, 'part text', false, true,
     'call-1', 'fixture-tool', 'completed', '{"input":true}', 'output', 'error',
     'tool title', 'patch-hash', '["a.ts","a.ts"]', 'text/plain', 'a.ts',
     'file:///portable-project/a.ts', 'inspect', 'subtask description', 'codex',
     'finished', 0.125, $6, 17, 'snapshot-hash', false, '{"nested":{"null":null}}')`,
  [fixture.partId, projectId, conversationId, messageId, fixture.sessionId, big]);
  await query(`INSERT INTO lcm.message_parts
    (part_id, project_id, conversation_id, message_id, session_id, part_type, ordinal)
    VALUES ($1, $2, $3, $4, $5, 'text', 1)`,
  [fixture.nullPartId, projectId, conversationId, messageId, fixture.sessionId]);
  await query(`INSERT INTO lcm.large_files
    (project_id, conversation_id, file_id, file_name, mime_type, byte_size,
     storage_uri, exploration_summary, created_at)
    VALUES ($1, $2, $3, 'large.txt', 'text/plain', $4, 'archive/large.txt', 'explored', $5),
      ($1, $2, 'portable-null-file', NULL, NULL, NULL, 'archive/null', NULL, $5)`,
  [projectId, conversationId, fixture.fileId, big, at]);
  const summary = await query(`INSERT INTO lcm.summaries
    (project_id, conversation_id, summary_id, kind, depth, content, token_count,
     earliest_at, latest_at, descendant_count, descendant_token_count,
     source_message_token_count, created_at)
    VALUES ($1, $2, $3, 'leaf', 0, 'Portable leaf', 11, $4, $5, 1, $6, $6, $5)
    RETURNING summary_key`, [projectId, conversationId, fixture.summaryId, at, later, big]);
  const summaryKey = summary.rows[0].summary_key as string;
  const parent = await query(`INSERT INTO lcm.summaries
    (project_id, conversation_id, summary_id, kind, depth, content, token_count,
     earliest_at, latest_at, descendant_count, descendant_token_count,
     source_message_token_count, created_at)
    VALUES ($1, $2, $3, 'condensed', 1, 'Portable condensed', 5, NULL, NULL, 1, 11, $4, $5)
    RETURNING summary_key`, [projectId, conversationId, fixture.parentSummaryId, big, later]);
  const parentSummaryKey = parent.rows[0].summary_key as string;
  await query(`INSERT INTO lcm.summary_large_files
    (project_id, conversation_id, summary_key, file_id, ordinal)
    VALUES ($1, $2, $3, $4, 0), ($1, $2, $3, $4, 1),
      ($1, $2, $3, 'deleted-file-provenance', 2)`,
  [projectId, conversationId, summaryKey, fixture.fileId]);
  await query(`INSERT INTO lcm.summary_messages
    (project_id, conversation_id, summary_key, message_id, ordinal)
    VALUES ($1, $2, $3, $4, 0)`, [projectId, conversationId, summaryKey, messageId]);
  await query(`INSERT INTO lcm.summary_parents
    (project_id, conversation_id, summary_key, parent_summary_key, ordinal)
    VALUES ($1, $2, $3, $4, 0)`, [projectId, conversationId, parentSummaryKey, summaryKey]);
  await query(`INSERT INTO lcm.context_items
    (project_id, conversation_id, ordinal, item_type, message_id, summary_key, created_at)
    VALUES ($1, $2, 0, 'message', $3, NULL, $5), ($1, $2, 1, 'summary', NULL, $4, $5)`,
  [projectId, conversationId, messageId, parentSummaryKey, later]);
  await query(`INSERT INTO lcm.promoted_memories
    (memory_id, project_id, content, source_summary_id, source_project_id, session_id,
     depth, confidence, metadata, created_at, archived_at)
    VALUES ($1, $2, 'Portable memory', 'deleted-summary', 'deleted-project', $3,
      2, 0.75, '{"nested":[true,null,"value"]}', $4, NULL),
      ($5, $2, 'Archived portable memory', NULL, NULL, NULL, 0, 1, '{}', $4, $6)`,
  [fixture.memoryId, projectId, fixture.sessionId, at, fixture.archivedMemoryId, later]);
  await query(`INSERT INTO lcm.promoted_memory_tags (project_id, memory_id, ordinal, tag)
    VALUES ($1, $2, 0, 'Repeat'), ($1, $2, 1, 'Repeat'), ($1, $2, 2, 'repeat')`,
  [projectId, fixture.memoryId]);
  await query(`INSERT INTO lcm.recall_surfacing (project_id, memory_id, session_id, surfaced_at)
    VALUES ($1, $2, $3, $4), ($1, $2, $3, $4), ($1, 'deleted-memory', NULL, $4)`,
  [projectId, fixture.memoryId, fixture.sessionId, later]);
  await query(`INSERT INTO lcm.redaction_counters (project_id, category, count, updated_at)
    VALUES ($1, 'built_in', $2, $3), ($1, 'global', 0, $3),
      ($1, 'project', 3, $3), ($1, 'gitleaks', 4, $3)`, [projectId, big, later]);
  await query(`INSERT INTO lcm.session_ingest_log (project_id, session_id, message_count, completed_at)
    VALUES ($1, $2, $3, $4)`, [projectId, fixture.sessionId, big, later]);
  await query(`INSERT INTO lcm.session_instructions
    (project_id, machine_id, scope_hash, client_name, session_id, worktree_path,
     cwd_path, content, content_hash, updated_at)
    VALUES ($1, $2, $4, 'codex', $5, $6, $6, 'Primary instruction', $7, $8),
      ($1, $3, $4, 'claude', $5, '/secondary/portable-project',
       '/secondary/portable-project/subdir', 'Secondary instruction', $7, $8)`,
  [projectId, machineId, secondaryMachineId, fixture.scopeHash, fixture.sessionId,
    path, "e".repeat(64), later]);
  const transcript = await query(`INSERT INTO lcm.native_transcripts
    (project_id, machine_id, client_name, format_name, format_version, native_session_id,
     source_locator, source_ordinal, observed_at, ingested_at, scrubber_version,
     content_sha256, ingest_key, native_payload)
    VALUES ($1, $2, 'codex', 'jsonl', '1', $3, $4, $5, $6, $7, 'fixture-v1',
      $8, $9, '{"type":"message","content":[{"text":"scrubbed"}],"optional":null}')
    RETURNING transcript_id`, [projectId, machineId, fixture.sessionId,
    fixture.sourceLocator, big, at, later, "f".repeat(64), fixture.ingestKey]);
  const transcriptId = transcript.rows[0].transcript_id as string;
  await query(`INSERT INTO lcm.transcript_messages
    (project_id, transcript_id, conversation_id, message_id, source_ordinal)
    VALUES ($1, $2, $3, $4, 0)`, [projectId, transcriptId, conversationId, messageId]);
  await query(`INSERT INTO lcm.ingest_checkpoints
    (project_id, machine_id, client_name, source_locator, last_source_ordinal,
     imported_count, skipped_count, quarantined_count, revision, checkpoint, updated_at)
    VALUES ($1, $2, 'codex', $3, $4, $4, 1, 2, 3, '{"offset":"9007199254740993","end":null}', $5)`,
  [projectId, machineId, fixture.sourceLocator, big, later]);
  await query(`INSERT INTO lcm.passive_event_inbox
    (project_id, machine_id, event_id, event_version, machine_sequence, event_type,
     payload, status, received_at, next_attempt_at, applied_at, quarantined_at, quarantine_reason)
    VALUES ($1, $2, '01990000-0000-7000-8000-000000000010', 1, $3::bigint,
      'fixture.pending', '{"sessionId":"portable-session","sessionSequence":1,"category":"context","data":"pending data","priority":0,"sourceHook":"fixture","createdAt":"2026-01-02T03:04:05.123456Z"}',
      'pending', $4, $4, NULL, NULL, NULL),
      ($1, $2, '01990000-0000-7000-8000-000000000011', 1, $3::bigint + 1,
       'fixture.applied', '{"sessionId":"portable-session","sessionSequence":2,"category":"context","data":"applied data","priority":1,"sourceHook":"fixture","createdAt":"2026-01-02T03:04:05.123456Z"}',
       'applied', $4, $4, $5, NULL, NULL),
      ($1, $2, '01990000-0000-7000-8000-000000000012', 1, $3::bigint + 2,
       'fixture.quarantined', '{"sessionId":"portable-session","sessionSequence":3,"category":"context","data":"quarantined data","priority":2,"sourceHook":"fixture","createdAt":"2026-01-02T03:04:05.123456Z"}',
       'quarantined', $4, $4, NULL, $5,
       'fixture recovery quarantine')`, [projectId, machineId, big, at, later]);
  return {
    ...fixture, conversationId, duplicateConversationId, messageId, summaryKey,
    parentSummaryKey, transcriptId,
  };
}
