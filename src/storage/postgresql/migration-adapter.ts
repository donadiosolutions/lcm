import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fsyncSync, linkSync, openSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { QueryResultRow } from "pg";
import { CanonicalRowDigest, canonicalJson, fingerprintMigrationFileSync, type CanonicalValue, type MigrationFileFingerprint } from "../migration-manifest.js";
import { PRIVATE_FILE_MODE } from "../../security-files.js";
import type { MigrationRow, MigrationTableInventory } from "../sqlite/migration-adapter.js";
import type { PostgreSqlOperationContext, PostgreSqlQueryExecutor, PostgreSqlTransactionScopeExecutor } from "./contracts.js";
import { PostgreSqlWorkCoordinator, type PostgreSqlLeaseMutationInput } from "./coordination.js";
import { PostgreSqlCommitOutcomeUnknownError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const READ_BATCH = 1_000;

export interface PostgreSqlMigrationRuntime extends PostgreSqlQueryExecutor {
  transaction<T>(callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>, options: PostgreSqlOperationContext & { readonly signal?: AbortSignal }): Promise<T>;
}
export interface PostgreSqlMigrationIdentity { readonly localProjectId: string; readonly remoteProjectId: string; readonly machineId: string; readonly aliases: readonly string[] }
export interface PostgreSqlMigrationFence extends Omit<PostgreSqlLeaseMutationInput, "signal"> { readonly signal?: AbortSignal }
export interface PostgreSqlBatchResult { readonly rows: number; readonly uncertainCommitRecovered: boolean }
export interface PostgreSqlDestinationState { readonly projectExists: boolean; readonly stateRows: number; readonly tableCounts: Readonly<Record<string, number>> }
export interface PostgreSqlSchemaHistoryEntry { readonly id: string; readonly sha256: string }
export interface PostgreSqlOperationalSidecars { readonly nativeTranscriptSidecar: MigrationFileFingerprint; readonly passiveEventSidecar: MigrationFileFingerprint; readonly checkpointSidecar: MigrationFileFingerprint }

type RowPlan = { readonly table: string; readonly columns: readonly string[]; readonly values: readonly unknown[]; readonly keyColumns: readonly string[]; readonly keyValues: readonly unknown[]; readonly timestampColumns?: readonly string[] };
type LogicalTable = { readonly name: string; readonly sql: (identity: PostgreSqlMigrationIdentity) => string; readonly values: (identity: PostgreSqlMigrationIdentity) => readonly unknown[]; readonly normalize?: (row: Record<string, unknown>) => MigrationRow };

function options(identity: PostgreSqlMigrationIdentity, operation: string, signal?: AbortSignal) {
  return { domain: "transaction" as const, operation, projectId: identity.remoteProjectId, machineId: identity.machineId, ...(signal === undefined ? {} : { signal }) };
}
function text(value: unknown, field: string): string { if (typeof value !== "string" || value.includes("\0")) throw new Error(`${field} is not valid text`); return value; }
function safeInteger(value: unknown, field: string): number { const parsed = typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : value; if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) throw new Error(`${field} exceeds SQLite's safe integer migration range`); return parsed; }
function finite(value: unknown, field: string): number { const parsed = typeof value === "string" ? Number(value) : value; if (typeof parsed !== "number" || !Number.isFinite(parsed)) throw new Error(`${field} is not finite`); return parsed; }
function timestamp(value: unknown, field: string): string | null { if (value === null) return null; const date = value instanceof Date ? value : new Date(text(value, field)); if (!Number.isFinite(date.getTime())) throw new Error(`${field} is not a timestamp`); return date.toISOString(); }
function jsonValue(value: unknown): CanonicalValue { return JSON.parse(canonicalJson(typeof value === "string" ? JSON.parse(value) as unknown : value)) as CanonicalValue; }
function uuid(value: unknown, field: string): string { const result = text(value, field); if (!UUID.test(result)) throw new Error(`${field} is not a UUID`); return result.toLowerCase(); }

const INTEGERS = new Set(["conversation_id", "message_id", "seq", "token_count", "ordinal", "depth", "descendant_count", "descendant_token_count", "source_message_token_count", "step_tokens_in", "step_tokens_out", "byte_size", "surfacing_id", "count", "message_count"]);
const FLOATS = new Set(["step_cost", "confidence"]);
const TIMES = new Set(["bootstrapped_at", "created_at", "updated_at", "earliest_at", "latest_at", "archived_at", "surfaced_at", "completed_at"]);
const JSON_VALUES = new Set(["file_ids", "tags"]);
function baseRow(row: Record<string, unknown>): MigrationRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (INTEGERS.has(key)) return [key, value === null ? null : safeInteger(value, key)];
    if (FLOATS.has(key)) return [key, value === null ? null : finite(value, key)];
    if (TIMES.has(key)) return [key, timestamp(value, key)];
    if (JSON_VALUES.has(key) && value !== null) return [key, jsonValue(value)];
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return [key, value];
    if (typeof value === "bigint") return [key, { $integer: value.toString() }];
    if (value instanceof Date) return [key, value.toISOString()];
    if (Buffer.isBuffer(value)) return [key, value.toString("hex")];
    return [key, jsonValue(value)];
  })) as MigrationRow;
}
function deterministicUuid(projectId: string, kind: string, source: string): string { const bytes = createHash("sha256").update(projectId).update("\0").update(kind).update("\0").update(source).digest().subarray(0, 16); bytes[6] = (bytes[6]! & 0x0f) | 0x70; bytes[8] = (bytes[8]! & 0x3f) | 0x80; const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }
function rowValue(row: MigrationRow, key: string): CanonicalValue { const value = row[key]; if (value === undefined) throw new Error(`migration row is missing ${key}`); return value; }
function comparable(value: unknown, isTimestamp: boolean): unknown { if (isTimestamp) return timestamp(value, "timestamp"); if (typeof value === "bigint") return value.toString(); if (value instanceof Date) return value.toISOString(); if (Buffer.isBuffer(value)) return value.toString("hex"); if (value !== null && typeof value === "object") return JSON.parse(canonicalJson(value)); return value; }
function matches(plan: RowPlan, row: QueryResultRow | undefined): boolean {
  if (!row) return false;
  return plan.columns.every((column, index) => { const expected = comparable(plan.values[index], plan.timestampColumns?.includes(column) === true); let actual = comparable(row[column], plan.timestampColumns?.includes(column) === true); if (typeof expected === "number" && typeof actual === "string") actual = finite(actual, column); return canonicalJson(actual) === canonicalJson(expected); });
}
function makePlan(table: string, columns: readonly string[], values: readonly unknown[], keyColumns: readonly string[], keyValues: readonly unknown[], timestampColumns?: readonly string[]): RowPlan { return { table, columns, values, keyColumns, keyValues, ...(timestampColumns ? { timestampColumns } : {}) }; }
function selectPlan(plan: RowPlan): string { return `SELECT ${plan.columns.join(", ")} FROM lcm.${plan.table} WHERE ${plan.keyColumns.map((column, index) => `${column} = $${index + 1}`).join(" AND ")}`; }
async function readPlan(executor: PostgreSqlQueryExecutor, identity: PostgreSqlMigrationIdentity, plan: RowPlan, operation: string, signal?: AbortSignal): Promise<QueryResultRow | undefined> { const result = await executor.query({ text: selectPlan(plan), values: [...plan.keyValues] }, options(identity, operation, signal)); if (result.rows.length > 1) throw new Error(`duplicate PostgreSQL migration key in ${plan.table}`); return result.rows[0]; }
async function insertOrCompare(transaction: PostgreSqlTransactionScopeExecutor, identity: PostgreSqlMigrationIdentity, plan: RowPlan, signal?: AbortSignal): Promise<void> {
  const existing = await readPlan(transaction, identity, plan, `migrationReadExisting:${plan.table}`, signal);
  if (existing) { if (!matches(plan, existing)) throw new Error(`divergent stable-ID conflict in ${plan.table}`); return; }
  await transaction.query({ text: `INSERT INTO lcm.${plan.table} (${plan.columns.join(", ")}) VALUES (${plan.columns.map((_column, index) => `$${index + 1}`).join(", ")})`, values: plan.values.map((value) => value !== null && typeof value === "object" && !(value instanceof Date) ? canonicalJson(value) : value) }, options(identity, `migrationInsert:${plan.table}`, signal));
  if (!matches(plan, await readPlan(transaction, identity, plan, `migrationReadInserted:${plan.table}`, signal))) throw new Error(`PostgreSQL readback mismatch in ${plan.table}`);
}
async function conversation(executor: PostgreSqlQueryExecutor, identity: PostgreSqlMigrationIdentity, table: "messages" | "summaries", keyColumn: "message_id" | "summary_key", key: unknown, signal?: AbortSignal): Promise<number> { const result = await executor.query<{ conversation_id: unknown }>({ text: `SELECT conversation_id FROM lcm.${table} WHERE project_id = $1 AND ${keyColumn} = $2`, values: [identity.remoteProjectId, key] }, options(identity, "migrationResolveConversation", signal)); if (result.rows.length !== 1) throw new Error(`missing migration dependency in ${table}`); return safeInteger(result.rows[0]!.conversation_id, "conversation_id"); }

async function plansForRow(executor: PostgreSqlQueryExecutor, identity: PostgreSqlMigrationIdentity, table: string, row: MigrationRow, signal?: AbortSignal): Promise<RowPlan[]> {
  const p = identity.remoteProjectId;
  switch (table) {
    case "conversations": { const id = safeInteger(rowValue(row, "conversation_id"), "conversation_id"); return [makePlan("conversations", ["conversation_id", "project_id", "session_id", "title", "bootstrapped_at", "created_at", "updated_at"], [id, p, rowValue(row, "session_id"), rowValue(row, "title"), rowValue(row, "bootstrapped_at"), rowValue(row, "created_at"), rowValue(row, "updated_at")], ["conversation_id"], [id], ["bootstrapped_at", "created_at", "updated_at"])]; }
    case "messages": { const id = safeInteger(rowValue(row, "message_id"), "message_id"); return [makePlan("messages", ["message_id", "project_id", "conversation_id", "seq", "role", "content", "token_count", "created_at"], [id, p, rowValue(row, "conversation_id"), rowValue(row, "seq"), rowValue(row, "role"), rowValue(row, "content"), rowValue(row, "token_count"), rowValue(row, "created_at")], ["message_id"], [id], ["created_at"])]; }
    case "message_parts": { const id = uuid(rowValue(row, "part_id"), "part_id"); const messageId = safeInteger(rowValue(row, "message_id"), "message_id"); const conversationId = await conversation(executor, identity, "messages", "message_id", messageId, signal); const source = Object.keys(row); return [makePlan("message_parts", ["part_id", "project_id", "conversation_id", ...source.filter((key) => key !== "part_id")], [id, p, conversationId, ...source.filter((key) => key !== "part_id").map((key) => rowValue(row, key))], ["part_id"], [id])]; }
    case "summaries": { const summaryId = text(rowValue(row, "summary_id"), "summary_id"); const key = deterministicUuid(p, "summary", summaryId); const source = Object.keys(row); return [makePlan("summaries", ["summary_key", "project_id", ...source], [key, p, ...source.map((column) => rowValue(row, column))], ["summary_key"], [key], ["earliest_at", "latest_at", "created_at"])]; }
    case "summary_messages": { const key = deterministicUuid(p, "summary", text(rowValue(row, "summary_id"), "summary_id")); const messageId = safeInteger(rowValue(row, "message_id"), "message_id"); const conversationId = await conversation(executor, identity, "summaries", "summary_key", key, signal); return [makePlan("summary_messages", ["project_id", "conversation_id", "summary_key", "message_id", "ordinal"], [p, conversationId, key, messageId, rowValue(row, "ordinal")], ["project_id", "summary_key", "message_id"], [p, key, messageId])]; }
    case "summary_parents": { const key = deterministicUuid(p, "summary", text(rowValue(row, "summary_id"), "summary_id")); const parent = deterministicUuid(p, "summary", text(rowValue(row, "parent_summary_id"), "parent_summary_id")); const conversationId = await conversation(executor, identity, "summaries", "summary_key", key, signal); return [makePlan("summary_parents", ["project_id", "conversation_id", "summary_key", "parent_summary_key", "ordinal"], [p, conversationId, key, parent, rowValue(row, "ordinal")], ["project_id", "summary_key", "parent_summary_key"], [p, key, parent])]; }
    case "context_items": { const conversationId = safeInteger(rowValue(row, "conversation_id"), "conversation_id"); const ordinal = safeInteger(rowValue(row, "ordinal"), "ordinal"); const sourceSummary = rowValue(row, "summary_id"); const summaryKey = sourceSummary === null ? null : deterministicUuid(p, "summary", text(sourceSummary, "summary_id")); return [makePlan("context_items", ["project_id", "conversation_id", "ordinal", "item_type", "message_id", "summary_key", "created_at"], [p, conversationId, ordinal, rowValue(row, "item_type"), rowValue(row, "message_id"), summaryKey, rowValue(row, "created_at")], ["project_id", "conversation_id", "ordinal"], [p, conversationId, ordinal], ["created_at"])]; }
    case "large_files": { const fileId = text(rowValue(row, "file_id"), "file_id"); const key = deterministicUuid(p, "large-file", fileId); const source = Object.keys(row); return [makePlan("large_files", ["file_key", "project_id", ...source], [key, p, ...source.map((column) => rowValue(row, column))], ["file_key"], [key], ["created_at"])]; }
    case "summary_large_files": { const key = deterministicUuid(p, "summary", text(rowValue(row, "summary_id"), "summary_id")); const conversationId = await conversation(executor, identity, "summaries", "summary_key", key, signal); const fileIds = rowValue(row, "file_ids"); if (!Array.isArray(fileIds) || !fileIds.every((value) => typeof value === "string")) throw new Error("file_ids is not a text array"); return fileIds.map((fileId, ordinal) => makePlan("summary_large_files", ["project_id", "conversation_id", "summary_key", "file_id", "ordinal"], [p, conversationId, key, fileId, ordinal], ["project_id", "summary_key", "ordinal"], [p, key, ordinal])); }
    case "promoted_memories": { const id = uuid(rowValue(row, "memory_id"), "memory_id"); const source = Object.keys(row); return [makePlan("promoted_memories", ["project_id", ...source], [p, ...source.map((column) => column === "memory_id" ? id : rowValue(row, column))], ["memory_id"], [id], ["created_at", "archived_at"])]; }
    case "promoted_memory_tags": { const id = uuid(rowValue(row, "memory_id"), "memory_id"); const tags = rowValue(row, "tags"); if (!Array.isArray(tags) || !tags.every((value) => typeof value === "string")) throw new Error("tags is not a text array"); return tags.map((tag, ordinal) => makePlan("promoted_memory_tags", ["project_id", "memory_id", "ordinal", "tag"], [p, id, ordinal, tag], ["project_id", "memory_id", "ordinal"], [p, id, ordinal])); }
    case "recall_surfacing": { const id = safeInteger(rowValue(row, "surfacing_id"), "surfacing_id"); return [makePlan("recall_surfacing", ["surfacing_id", "project_id", "memory_id", "session_id", "surfaced_at"], [id, p, rowValue(row, "memory_id"), rowValue(row, "session_id"), rowValue(row, "surfaced_at")], ["surfacing_id"], [id], ["surfaced_at"])]; }
    case "redaction_counters": { const category = text(rowValue(row, "category"), "category"); return [makePlan("redaction_counters", ["project_id", "category", "count"], [p, category, rowValue(row, "count")], ["project_id", "category"], [p, category])]; }
    case "session_ingest_log": { const session = text(rowValue(row, "session_id"), "session_id"); const key = deterministicUuid(p, "session-ingest", session); return [makePlan("session_ingest_log", ["ingest_key", "project_id", "session_id", "message_count", "completed_at"], [key, p, session, rowValue(row, "message_count"), rowValue(row, "completed_at")], ["ingest_key"], [key], ["completed_at"])]; }
    case "session_instructions": { const scope = text(rowValue(row, "scope_hash"), "scope_hash"); return [makePlan("session_instructions", ["project_id", "machine_id", "scope_hash", "client_name", "session_id", "worktree_path", "cwd_path", "content", "content_hash", "updated_at"], [p, identity.machineId, scope, rowValue(row, "client_name"), rowValue(row, "session_id"), rowValue(row, "worktree_path"), rowValue(row, "cwd_path"), rowValue(row, "content"), rowValue(row, "content_hash"), rowValue(row, "updated_at")], ["project_id", "machine_id", "scope_hash"], [p, identity.machineId, scope], ["updated_at"])]; }
    default: throw new Error(`unknown PostgreSQL migration table: ${table}`);
  }
}

const LOGICAL_TABLES: readonly LogicalTable[] = [
  { name: "conversations", sql: () => "SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at FROM lcm.conversations WHERE project_id = $1 ORDER BY conversation_id", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "messages", sql: () => "SELECT message_id, conversation_id, seq, role, content, token_count, created_at FROM lcm.messages WHERE project_id = $1 ORDER BY message_id", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "message_parts", sql: () => "SELECT part_id, message_id, session_id, part_type, ordinal, text_content, is_ignored, is_synthetic, tool_call_id, tool_name, tool_status, tool_input, tool_output, tool_error, tool_title, patch_hash, patch_files, file_mime, file_name, file_url, subtask_prompt, subtask_desc, subtask_agent, step_reason, step_cost, step_tokens_in, step_tokens_out, snapshot_hash, compaction_auto, metadata FROM lcm.message_parts WHERE project_id = $1 ORDER BY part_id", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "summaries", sql: () => "SELECT summary_id, conversation_id, kind, depth, content, token_count, earliest_at, latest_at, descendant_count, descendant_token_count, source_message_token_count, created_at FROM lcm.summaries WHERE project_id = $1 ORDER BY summary_id", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "summary_messages", sql: () => "SELECT s.summary_id, sm.message_id, sm.ordinal FROM lcm.summary_messages sm JOIN lcm.summaries s USING (project_id, conversation_id, summary_key) WHERE sm.project_id = $1 ORDER BY s.summary_id, sm.ordinal, sm.message_id", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "summary_parents", sql: () => "SELECT s.summary_id, parent.summary_id AS parent_summary_id, sp.ordinal FROM lcm.summary_parents sp JOIN lcm.summaries s ON s.project_id = sp.project_id AND s.conversation_id = sp.conversation_id AND s.summary_key = sp.summary_key JOIN lcm.summaries parent ON parent.project_id = sp.project_id AND parent.conversation_id = sp.conversation_id AND parent.summary_key = sp.parent_summary_key WHERE sp.project_id = $1 ORDER BY s.summary_id, sp.ordinal, parent.summary_id", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "context_items", sql: () => "SELECT ci.conversation_id, ci.ordinal, ci.item_type, ci.message_id, s.summary_id, ci.created_at FROM lcm.context_items ci LEFT JOIN lcm.summaries s ON s.project_id = ci.project_id AND s.conversation_id = ci.conversation_id AND s.summary_key = ci.summary_key WHERE ci.project_id = $1 ORDER BY ci.conversation_id, ci.ordinal", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "large_files", sql: () => "SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at FROM lcm.large_files WHERE project_id = $1 ORDER BY file_id", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "summary_large_files", sql: () => "SELECT s.summary_id, COALESCE(jsonb_agg(slf.file_id ORDER BY slf.ordinal) FILTER (WHERE slf.ordinal IS NOT NULL), '[]'::jsonb) AS file_ids FROM lcm.summaries s LEFT JOIN lcm.summary_large_files slf USING (project_id, conversation_id, summary_key) WHERE s.project_id = $1 GROUP BY s.summary_id ORDER BY s.summary_id", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "promoted_memories", sql: () => "SELECT memory_id, content, metadata, source_summary_id, source_project_id, session_id, depth, confidence, created_at, archived_at FROM lcm.promoted_memories WHERE project_id = $1 ORDER BY memory_id", values: ({ remoteProjectId }) => [remoteProjectId], normalize: (row) => ({ ...baseRow(row), metadata: jsonValue(row.metadata) }) },
  { name: "promoted_memory_tags", sql: () => "SELECT pm.memory_id, COALESCE(jsonb_agg(pmt.tag ORDER BY pmt.ordinal) FILTER (WHERE pmt.ordinal IS NOT NULL), '[]'::jsonb) AS tags FROM lcm.promoted_memories pm LEFT JOIN lcm.promoted_memory_tags pmt USING (project_id, memory_id) WHERE pm.project_id = $1 GROUP BY pm.memory_id ORDER BY pm.memory_id", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "recall_surfacing", sql: () => "SELECT surfacing_id, memory_id, session_id, surfaced_at FROM lcm.recall_surfacing WHERE project_id = $1 ORDER BY surfacing_id", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "redaction_counters", sql: ({ localProjectId }) => `SELECT '${localProjectId}'::text AS project_id, category, count FROM lcm.redaction_counters WHERE project_id = $1 ORDER BY category`, values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "session_ingest_log", sql: () => "SELECT session_id, message_count, completed_at FROM lcm.session_ingest_log WHERE project_id = $1 ORDER BY session_id", values: ({ remoteProjectId }) => [remoteProjectId] },
  { name: "session_instructions", sql: ({ localProjectId }) => `SELECT '${localProjectId}'::text AS project_id, scope_hash, client_name, session_id, worktree_path, cwd_path, content, content_hash, updated_at FROM lcm.session_instructions WHERE project_id = $1 ORDER BY scope_hash`, values: ({ remoteProjectId }) => [remoteProjectId] },
] as const;
const PROJECT_STATE_TABLES = ["conversations", "messages", "message_parts", "native_transcripts", "transcript_messages", "summaries", "summary_messages", "summary_parents", "context_items", "large_files", "summary_large_files", "promoted_memories", "promoted_memory_tags", "recall_surfacing", "redaction_counters", "ingest_checkpoints", "session_ingest_log", "session_instructions", "passive_event_inbox", "fenced_leases"] as const;
const SEQUENCES = [
  ["lcm.conversations_conversation_id_seq", "lcm.conversations", "conversation_id"],
  ["lcm.messages_message_id_seq", "lcm.messages", "message_id"],
  ["lcm.recall_surfacing_surfacing_id_seq", "lcm.recall_surfacing", "surfacing_id"],
  ["lcm.session_instructions_instruction_id_seq", "lcm.session_instructions", "instruction_id"],
] as const;
const SIDECARS = [
  { key: "nativeTranscriptSidecar", sql: "SELECT transcript_id, machine_id, client_name, format_name, format_version, native_session_id, source_locator, source_ordinal, observed_at, ingested_at, scrubber_version, content_sha256, ingest_key, native_payload FROM lcm.native_transcripts WHERE project_id = $1 ORDER BY transcript_id" },
  { key: "passiveEventSidecar", sql: "SELECT inbox_id, machine_id, event_id, event_version, machine_sequence, event_type, payload, status, attempt_count, received_at, next_attempt_at, claimed_at, claimed_by, applied_at, quarantined_at, quarantine_reason FROM lcm.passive_event_inbox WHERE project_id = $1 ORDER BY inbox_id" },
  { key: "checkpointSidecar", sql: "SELECT machine_id, client_name, source_locator, last_source_ordinal, imported_count, skipped_count, quarantined_count, revision, checkpoint, updated_at FROM lcm.ingest_checkpoints WHERE project_id = $1 ORDER BY machine_id, client_name, source_locator" },
] as const;
function logical(name: string): LogicalTable { const found = LOGICAL_TABLES.find((table) => table.name === name); if (!found) throw new Error(`unknown PostgreSQL migration table: ${name}`); return found; }

async function writeSidecar(path: string, rows: AsyncIterable<Record<string, unknown>>): Promise<MigrationFileFingerprint> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, PRIVATE_FILE_MODE);
  try {
    for await (const row of rows) {
      const line = Buffer.from(`${canonicalJson(row)}\n`, "utf8");
      let offset = 0;
      while (offset < line.length) { const written = writeSync(fd, line, offset, line.length - offset); if (written === 0) throw new Error("sidecar write made no progress"); offset += written; }
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(temporary, PRIVATE_FILE_MODE);
  try {
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const candidate = fingerprintMigrationFileSync(temporary, dirname(temporary));
    const published = fingerprintMigrationFileSync(path, dirname(path));
    if (candidate.size !== published.size || candidate.sha256 !== published.sha256) throw new Error("existing PostgreSQL operational sidecar diverges");
    return published;
  } finally { unlinkSync(temporary); }
}

export class PostgreSqlMigrationAdapter {
  constructor(private readonly runtime: PostgreSqlMigrationRuntime, readonly identity: PostgreSqlMigrationIdentity) {
    if (!/^[a-f0-9]{64}$/u.test(identity.localProjectId)) throw new Error("invalid local project identity hash");
    uuid(identity.remoteProjectId, "remoteProjectId"); uuid(identity.machineId, "machineId");
  }

  async destinationState(signal?: AbortSignal): Promise<PostgreSqlDestinationState> {
    const project = await this.runtime.query<{ identity_key: unknown }>({ text: "SELECT identity_key FROM lcm.projects WHERE project_id = $1", values: [this.identity.remoteProjectId] }, options(this.identity, "migrationDestinationProject", signal));
    if (project.rows.length > 1) throw new Error("duplicate remote project identity");
    if (project.rows[0] && project.rows[0].identity_key !== this.identity.localProjectId) throw new Error("remote project binding does not match the canonical local identity");
    const counts: Record<string, number> = {};
    for (const table of PROJECT_STATE_TABLES) { const result = await this.runtime.query<{ count: unknown }>({ text: `SELECT count(*)::text AS count FROM lcm.${table} WHERE project_id = $1`, values: [this.identity.remoteProjectId] }, options(this.identity, `migrationDestinationCount:${table}`, signal)); counts[table] = safeInteger(result.rows[0]?.count ?? "0", `${table}.count`); }
    return { projectExists: project.rows.length === 1, stateRows: Object.values(counts).reduce((sum, count) => sum + count, 0), tableCounts: counts };
  }

  async assertEmptyDestination(signal?: AbortSignal): Promise<void> { const state = await this.destinationState(signal); if (!state.projectExists) throw new Error("remote project identity is not registered"); if (state.stateRows !== 0) { const occupied = Object.entries(state.tableCounts).filter(([, count]) => count > 0).map(([table, count]) => `${table}:${count}`).join(","); throw new Error(`remote project destination is not empty (${occupied})`); } }
  async verifyAliases(signal?: AbortSignal): Promise<void> { const result = await this.runtime.query<{ path: unknown }>({ text: "SELECT path FROM lcm.project_aliases WHERE project_id = $1 AND machine_id = $2 ORDER BY path", values: [this.identity.remoteProjectId, this.identity.machineId] }, options(this.identity, "migrationVerifyAliases", signal)); const actual = result.rows.map(({ path }) => text(path, "alias.path")).sort(); const expected = [...new Set(this.identity.aliases)].sort(); if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("remote aliases do not match the canonical local project map"); }
  async schemaHistory(signal?: AbortSignal): Promise<PostgreSqlSchemaHistoryEntry[]> { const result = await this.runtime.query<{ migration_id: unknown; sha256: unknown }>({ text: "SELECT id AS migration_id, checksum_sha256 AS sha256 FROM lcm.schema_migrations ORDER BY id" }, options(this.identity, "migrationSchemaHistory", signal)); return result.rows.map((row) => ({ id: text(row.migration_id, "migration_id"), sha256: text(row.sha256, "sha256") })); }

  async writeBatch(table: string, rows: readonly MigrationRow[], fence: PostgreSqlMigrationFence): Promise<PostgreSqlBatchResult> {
    if (rows.length === 0) return { rows: 0, uncertainCommitRecovered: false };
    let completed: RowPlan[] = [];
    try {
      completed = await this.runtime.transaction(async (transaction) => {
        const coordinator = new PostgreSqlWorkCoordinator(transaction, this.identity.remoteProjectId, this.identity.machineId);
        await coordinator.assertLeaseFence(fence);
        const plans: RowPlan[] = [];
        for (const row of rows) { const next = await plansForRow(transaction, this.identity, table, row, fence.signal); for (const item of next) await insertOrCompare(transaction, this.identity, item, fence.signal); plans.push(...next); }
        await coordinator.assertLeaseFence(fence);
        return plans;
      }, options(this.identity, `migrationWriteBatch:${table}`, fence.signal));
    } catch (error) {
      if (!(error instanceof PostgreSqlCommitOutcomeUnknownError)) throw error;
      const plans: RowPlan[] = []; for (const row of rows) plans.push(...await plansForRow(this.runtime, this.identity, table, row, fence.signal)); await this.assertPlans(plans, fence.signal); return { rows: rows.length, uncertainCommitRecovered: true };
    }
    await this.assertPlans(completed, fence.signal);
    return { rows: rows.length, uncertainCommitRecovered: false };
  }

  async repairSharedSequences(fence: PostgreSqlMigrationFence): Promise<void> {
    await this.runtime.transaction(async (transaction) => { const coordinator = new PostgreSqlWorkCoordinator(transaction, this.identity.remoteProjectId, this.identity.machineId); await coordinator.assertLeaseFence(fence); for (const [sequence, table, column] of SEQUENCES) await transaction.query({ text: `SELECT pg_catalog.setval('${sequence}'::pg_catalog.regclass, GREATEST((SELECT last_value FROM ${sequence}), COALESCE((SELECT max(${column}) FROM ${table}), 1)), true)` }, options(this.identity, `migrationRepairSequence:${column}`, fence.signal)); await coordinator.assertLeaseFence(fence); }, options(this.identity, "migrationRepairSequences", fence.signal));
  }

  async readBatch(table: string, offset: number, limit: number, signal?: AbortSignal): Promise<MigrationRow[]> { if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be non-negative"); if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("limit must be positive"); const descriptor = logical(table); const values = descriptor.values(this.identity); const result = await this.runtime.query({ text: `${descriptor.sql(this.identity)} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, values: [...values, limit, offset] }, options(this.identity, `migrationReadBatch:${table}`, signal)); return result.rows.map((row) => (descriptor.normalize ?? baseRow)(row)); }
  async inventory(signal?: AbortSignal): Promise<MigrationTableInventory[]> { const result: MigrationTableInventory[] = []; for (const table of LOGICAL_TABLES) { const digest = new CanonicalRowDigest(); let offset = 0; for (;;) { const rows = await this.readBatch(table.name, offset, READ_BATCH, signal); rows.forEach((row) => digest.update(row)); offset += rows.length; if (rows.length < READ_BATCH) break; } result.push({ table: table.name, ...digest.digest() }); } return result; }
  async sample(table: string, count: number, signal?: AbortSignal): Promise<MigrationRow[]> { return this.readBatch(table, 0, count, signal); }
  async verifyRelationalIntegrity(signal?: AbortSignal): Promise<void> { const result = await this.runtime.query<{ violations: unknown }>({ text: `WITH RECURSIVE ancestry(summary_key, parent_summary_key, path, cycle) AS (SELECT summary_key, parent_summary_key, ARRAY[summary_key], false FROM lcm.summary_parents WHERE project_id = $1 UNION ALL SELECT ancestry.summary_key, edge.parent_summary_key, ancestry.path || edge.parent_summary_key, edge.parent_summary_key = ANY(ancestry.path) FROM ancestry JOIN lcm.summary_parents edge ON edge.project_id = $1 AND edge.summary_key = ancestry.parent_summary_key WHERE NOT ancestry.cycle), violations AS (SELECT count(*)::bigint AS count FROM ancestry WHERE cycle UNION ALL SELECT count(*)::bigint FROM lcm.transcript_messages tm LEFT JOIN lcm.messages m ON m.project_id = tm.project_id AND m.conversation_id = tm.conversation_id AND m.message_id = tm.message_id WHERE tm.project_id = $1 AND m.message_id IS NULL) SELECT COALESCE(sum(count), 0)::text AS violations FROM violations`, values: [this.identity.remoteProjectId] }, options(this.identity, "migrationVerifyRelationalIntegrity", signal)); if (safeInteger(result.rows[0]?.violations ?? "0", "violations") !== 0) throw new Error("PostgreSQL FK, DAG, or transcript coverage verification failed"); }
  async exportOperationalSidecars(paths: { readonly nativeTranscriptSidecar: string; readonly passiveEventSidecar: string; readonly checkpointSidecar: string }, signal?: AbortSignal): Promise<PostgreSqlOperationalSidecars> {
    const output = {} as Record<string, MigrationFileFingerprint>;
    for (const sidecar of SIDECARS) {
      const self = this;
      async function* rows(): AsyncIterable<Record<string, unknown>> {
        let offset = 0;
        for (;;) {
          const result = await self.runtime.query({ text: `${sidecar.sql} LIMIT $2 OFFSET $3`, values: [self.identity.remoteProjectId, READ_BATCH, offset] }, options(self.identity, `migrationSidecar:${sidecar.key}`, signal));
          for (const row of result.rows) yield row;
          offset += result.rows.length;
          if (result.rows.length < READ_BATCH) break;
        }
      }
      output[sidecar.key] = await writeSidecar(paths[sidecar.key], rows());
    }
    return output as unknown as PostgreSqlOperationalSidecars;
  }

  private async assertPlans(plans: readonly RowPlan[], signal?: AbortSignal): Promise<void> { for (const plan of plans) if (!matches(plan, await readPlan(this.runtime, this.identity, plan, `migrationAuthoritativeReadback:${plan.table}`, signal))) throw new Error(`authoritative PostgreSQL readback mismatch in ${plan.table}`); }
}

export const POSTGRESQL_MIGRATION_SCHEMA_MANIFEST_SHA256 = createHash("sha256").update(canonicalJson({ tables: LOGICAL_TABLES.map(({ name }) => name), stateTables: PROJECT_STATE_TABLES, sequences: SEQUENCES })).digest("hex");
export const POSTGRESQL_MIGRATION_TABLE_NAMES = LOGICAL_TABLES.map(({ name }) => name);
