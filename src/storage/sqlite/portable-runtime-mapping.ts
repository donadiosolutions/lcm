import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import {
  PORTABLE_LIMITS,
  PortableStreamError,
  type PortableDomain,
  type PortableProjectIdentity,
  type PortableRecord,
} from "../portable-record.js";

import { decodeSqliteUtf8Row, sqliteUtf8Projection } from "./portable-utf8.js";

export interface SqliteRawDomainRow {
  readonly locator: string;
  readonly value: Record<string, unknown>;
  readonly references?: readonly {
    readonly field: string;
    readonly domain: PortableDomain;
    readonly locator: string;
  }[];
}

export interface SqliteRuntimeReadOptions {
  readonly projectIdentity?: PortableProjectIdentity;
  readonly sourceLocalProjectId?: string;
  readonly conversationLocator?: string;
  /** Caller-owned evidence, bound to one verified immutable database lifetime. */
  readonly arrayValidation?: {
    readonly has: (domain: PortableDomain, parent: string) => boolean;
    readonly add: (domain: PortableDomain, parent: string) => void;
  };
}

type Field = readonly [field: string, column: string, kind?: "boolean" | "timestamp" | "json" | "conversations" | "messages"];
interface Mapping {
  readonly table: string;
  readonly key: readonly string[];
  readonly fields: readonly Field[];
}

// These fixed descriptors are the complete native-column contract, including
// fields that ordinary runtime repositories do not currently expose.
const mappings: Partial<Record<PortableDomain, Mapping>> = {
  conversations: { table: "conversations", key: ["conversation_id"], fields: [
    ["sessionId", "session_id"], ["title", "title"], ["bootstrappedAt", "bootstrapped_at", "timestamp"],
    ["createdAt", "created_at", "timestamp"], ["updatedAt", "updated_at", "timestamp"],
  ] },
  messages: { table: "messages", key: ["message_id"], fields: [
    ["conversationIdentitySha256", "conversation_id", "conversations"], ["seq", "seq"], ["role", "role"],
    ["content", "content"], ["tokenCount", "token_count"], ["createdAt", "created_at", "timestamp"],
  ] },
  "message-parts": { table: "message_parts", key: ["part_id"], fields: [
    ["messageIdentitySha256", "message_id", "messages"], ["partId", "part_id"], ["sessionId", "session_id"],
    ["partType", "part_type"], ["ordinal", "ordinal"], ["textContent", "text_content"],
    ["isIgnored", "is_ignored", "boolean"], ["isSynthetic", "is_synthetic", "boolean"],
    ["toolCallId", "tool_call_id"], ["toolName", "tool_name"], ["toolStatus", "tool_status"],
    ["toolInput", "tool_input"], ["toolOutput", "tool_output"], ["toolError", "tool_error"], ["toolTitle", "tool_title"],
    ["patchHash", "patch_hash"], ["patchFiles", "patch_files"], ["fileMime", "file_mime"],
    ["fileName", "file_name"], ["fileUrl", "file_url"], ["subtaskPrompt", "subtask_prompt"],
    ["subtaskDescription", "subtask_desc"], ["subtaskAgent", "subtask_agent"], ["stepReason", "step_reason"],
    ["stepCost", "step_cost"], ["stepTokensIn", "step_tokens_in"], ["stepTokensOut", "step_tokens_out"],
    ["snapshotHash", "snapshot_hash"], ["compactionAuto", "compaction_auto", "boolean"], ["metadata", "metadata"],
  ] },
  "large-files": { table: "large_files", key: ["file_id"], fields: [
    ["fileId", "file_id"], ["conversationIdentitySha256", "conversation_id", "conversations"],
    ["fileName", "file_name"], ["mimeType", "mime_type"], ["byteSize", "byte_size"], ["storageUri", "storage_uri"],
    ["explorationSummary", "exploration_summary"], ["createdAt", "created_at", "timestamp"],
  ] },
  summaries: { table: "summaries", key: ["summary_id"], fields: [
    ["summaryId", "summary_id"], ["conversationIdentitySha256", "conversation_id", "conversations"],
    ["kind", "kind"], ["depth", "depth"], ["content", "content"], ["tokenCount", "token_count"],
    ["earliestAt", "earliest_at", "timestamp"], ["latestAt", "latest_at", "timestamp"],
    ["descendantCount", "descendant_count"], ["descendantTokenCount", "descendant_token_count"],
    ["sourceMessageTokenCount", "source_message_token_count"], ["createdAt", "created_at", "timestamp"],
  ] },
  "summary-message-links": { table: "summary_messages", key: ["summary_id", "message_id"], fields: [
    ["summaryId", "summary_id"], ["ordinal", "ordinal"], ["messageIdentitySha256", "message_id", "messages"],
  ] },
  "summary-parent-links": { table: "summary_parents", key: ["summary_id", "parent_summary_id"], fields: [
    ["summaryId", "summary_id"], ["ordinal", "ordinal"], ["parentSummaryId", "parent_summary_id"],
  ] },
  "context-items": { table: "context_items", key: ["conversation_id", "ordinal"], fields: [
    ["conversationIdentitySha256", "conversation_id", "conversations"], ["ordinal", "ordinal"], ["itemType", "item_type"],
    ["messageIdentitySha256", "message_id", "messages"], ["summaryId", "summary_id"], ["createdAt", "created_at", "timestamp"],
  ] },
  "promoted-memories": { table: "promoted", key: ["id"], fields: [
    ["memoryId", "id"], ["content", "content"], ["metadata", "metadata", "json"],
    ["sourceProjectId", "project_id"], ["sourceSummaryId", "source_summary_id"], ["sessionId", "session_id"],
    ["depth", "depth"], ["confidence", "confidence"], ["createdAt", "created_at", "timestamp"], ["archivedAt", "archived_at", "timestamp"],
  ] },
  "recall-surfacings": { table: "recall_surfacing", key: ["id"], fields: [
    ["memoryId", "memory_id"], ["sessionId", "session_id"], ["surfacedAt", "surfaced_at", "timestamp"],
  ] },
  "redaction-counters": { table: "redaction_stats", key: ["category"], fields: [["category", "category"], ["count", "count"]] },
  "session-ingest": { table: "session_ingest_log", key: ["session_id"], fields: [
    ["sessionId", "session_id"], ["messageCount", "message_count"], ["completedAt", "completed_at", "timestamp"],
  ] },
};

function mappingFor(domain: PortableDomain): Mapping {
  const mapping = mappings[domain];
  if (mapping === undefined) throw new PortableStreamError("unknown-domain", { domain });
  return mapping;
}

function locatorFor(keys: readonly string[], row: Record<string, SQLOutputValue>): string {
  const values = keys.map(key => String(row[key]));
  return values.length === 1 ? values[0] : JSON.stringify(values);
}

function locatorValues(locator: string, count: number): string[] {
  if (count === 1) return [locator];
  let values: unknown;
  try { values = JSON.parse(locator); } catch { throw new PortableStreamError("source-invalid"); }
  if (!Array.isArray(values) || values.length !== count || values.some(value => typeof value !== "string")) {
    throw new PortableStreamError("source-invalid");
  }
  return values;
}

function scalar(value: unknown): SQLInputValue {
  if (value !== null && typeof value === "object" && "$integer" in value) return BigInt(value.$integer as string);
  return value as SQLInputValue;
}

function timestamp(value: SQLOutputValue): string {
  if (typeof value !== "string") throw new PortableStreamError("source-invalid");
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/.exec(value);
  if (match === null) throw new PortableStreamError("source-invalid");
  return `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(6, "0")}Z`;
}

function projectId(options: SqliteRuntimeReadOptions): string {
  if (options.projectIdentity === undefined) throw new PortableStreamError("source-invalid");
  return options.sourceLocalProjectId ?? options.projectIdentity.projectId;
}

interface ArrayMapping { readonly table: string; readonly key: string; readonly column: string; readonly parentField: string; readonly valueField: string }
function arrayMapping(domain: PortableDomain): ArrayMapping | undefined {
  if (domain === "summary-file-links") return { table: "summaries", key: "summary_id", column: "file_ids", parentField: "summaryId", valueField: "fileId" };
  if (domain === "promoted-memory-tags") return { table: "promoted", key: "id", column: "tags", parentField: "memoryId", valueField: "tag" };
  return undefined;
}

/** Called inside the destination's transaction; no independent commit or ledger. */
export function writePortableRuntimeRecord(
  db: DatabaseSync,
  record: PortableRecord,
  lookup: (domain: PortableDomain, identitySha256: string) => string,
  identity: PortableProjectIdentity,
): string {
  const value = record.value as unknown as Record<string, unknown>;
  const array = arrayMapping(record.domain);
  if (array !== undefined) {
    const parent = scalar(value[array.parentField]);
    const ordinal = scalar(value.ordinal);
    // JSON append retains duplicates and exact spellings. A gap or replay is an
    // error: batch-replay reconciliation belongs to the enclosing writer.
    const statement = db.prepare(`UPDATE ${array.table} SET ${array.column}=json_insert(${array.column}, '$[#]', ?)
      WHERE ${array.key}=? AND json_array_length(${array.column})=? RETURNING ${array.key}`);
    statement.setReadBigInts(true);
    if (statement.get(scalar(value[array.valueField]), parent, ordinal) === undefined) {
      throw new PortableStreamError("record-unrepresentable", { domain: record.domain });
    }
    return JSON.stringify([String(parent), String(ordinal)]);
  }
  const mapping = mappingFor(record.domain);
  const columns = mapping.fields.map(([, column]) => column);
  const values = mapping.fields.map(([field, , kind]) => {
    const input = value[field];
    if (record.domain === "promoted-memories" && field === "sourceProjectId") return scalar(input ?? identity.projectId);
    if (input === null) return null;
    if (kind === "conversations" || kind === "messages") return BigInt(lookup(kind, input as string));
    if (kind === "boolean") return input ? 1 : 0;
    if (kind === "json") return JSON.stringify(input);
    return scalar(input);
  });
  if (record.domain === "redaction-counters") { columns.push("project_id"); values.push(identity.projectId); }
  const statement = db.prepare(`INSERT INTO ${mapping.table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) RETURNING ${mapping.key.join(",")}`);
  statement.setReadBigInts(true);
  return locatorFor(mapping.key, statement.get(...values)!);
}

function decodeRow(domain: PortableDomain, mapping: Mapping, row: Record<string, SQLOutputValue>, options: SqliteRuntimeReadOptions): SqliteRawDomainRow {
  const value: Record<string, unknown> = {};
  const references: { field: string; domain: PortableDomain; locator: string }[] = [];
  for (const [field, column, kind] of mapping.fields) {
    const native = row[column];
    if (native === null) value[field] = null;
    else if (kind === "conversations" || kind === "messages") {
      const locator = String(native);
      value[field] = locator;
      references.push({ field, domain: kind, locator });
    } else if (kind === "timestamp") value[field] = timestamp(native);
    else if (kind === "boolean") {
      if (native !== 0n && native !== 1n) throw new PortableStreamError("source-invalid", { domain });
      value[field] = native === 1n;
    } else if (kind === "json") {
      try { value[field] = JSON.parse(native as string); } catch { throw new PortableStreamError("source-invalid", { domain }); }
    } else value[field] = native;
  }
  if (domain === "promoted-memories" && value.sourceProjectId === projectId(options)) value.sourceProjectId = null;
  return { locator: locatorFor(mapping.key, row), value, references };
}

function byteCheck(bytes: SQLOutputValue): void {
  if (BigInt(bytes as bigint) > BigInt(PORTABLE_LIMITS.maxRecordBytes)) throw new PortableStreamError("record-unrepresentable");
}

function queryParts(mapping: Mapping, domain: PortableDomain, options: SqliteRuntimeReadOptions, locator?: string) {
  const predicates: string[] = [];
  const values: SQLInputValue[] = [];
  if (domain === "redaction-counters") { predicates.push("project_id=?"); values.push(projectId(options)); }
  if (options.conversationLocator !== undefined && domain === "messages") {
    predicates.push("conversation_id=?"); values.push(options.conversationLocator);
  }
  if (locator !== undefined) {
    for (const key of mapping.key) predicates.push(`${key}=?`);
    values.push(...locatorValues(locator, mapping.key.length));
  }
  return { where: predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`, values };
}

function nativeColumns(mapping: Mapping): string[] {
  return [...new Set([...mapping.key, ...mapping.fields.map(([, column]) => column)])];
}

function nativeBytes(mapping: Mapping): string {
  return nativeColumns(mapping).map(column => `coalesce(length(CAST(${column} AS BLOB)),0)`).join("+");
}

function readNative(db: DatabaseSync, domain: PortableDomain, mapping: Mapping, locator: string, options: SqliteRuntimeReadOptions): SqliteRawDomainRow | undefined {
  const { where, values } = queryParts(mapping, domain, options, locator);
  const columns = nativeColumns(mapping);
  // Fetch only lengths first: a single huge native row must not cross the
  // driver boundary before the portable byte cap is checked.
  const length = nativeBytes(mapping);
  const header = db.prepare(`SELECT ${length} AS bytes FROM ${mapping.table}${where}`).get(...values);
  if (header === undefined) return undefined;
  byteCheck(header.bytes);
  const statement = db.prepare(`SELECT ${sqliteUtf8Projection(columns)} FROM ${mapping.table}${where}`);
  statement.setReadBigInts(true);
  return decodeRow(domain, mapping, decodeSqliteUtf8Row(statement.get(...values)!, columns), options);
}

function* readArray(db: DatabaseSync, domain: PortableDomain, mapping: ArrayMapping, options: SqliteRuntimeReadOptions, locator?: string): Generator<SqliteRawDomainRow> {
  const keys = locator === undefined ? undefined : locatorValues(locator, 2);
  const length = `length(CAST(${mapping.column} AS BLOB))+length(CAST(${mapping.key} AS BLOB))`;
  const parents = db.prepare(`SELECT ${sqliteUtf8Projection(["parent"])}, bytes FROM (SELECT CASE WHEN ${length}<=${PORTABLE_LIMITS.maxRecordBytes} THEN ${mapping.key} END AS parent, ${length} AS bytes FROM ${mapping.table}${keys === undefined ? "" : ` WHERE ${mapping.key}=?`})`);
  for (const rawParent of parents.iterate(...(keys === undefined ? [] : [keys[0]]))) {
    byteCheck(rawParent.bytes);
    const parent = decodeSqliteUtf8Row(rawParent, ["parent"]);
    // Validate original JSON before JSON1 expansion, once per immutable parent
    // when the source supplies its bounded validation index. Direct readers
    // have no retained authority and validate the complete parent every time.
    const parentLocator = String(parent.parent);
    if (!options.arrayValidation?.has(domain, parentLocator)) {
      const rawJson = db.prepare(`SELECT ${sqliteUtf8Projection([mapping.column])} FROM ${mapping.table} WHERE ${mapping.key}=?`).get(parent.parent)!;
      decodeSqliteUtf8Row(rawJson, [mapping.column]);
      const shape = db.prepare(`SELECT json_valid(${mapping.column}) AS valid, CASE WHEN json_valid(${mapping.column}) THEN json_type(${mapping.column}) END AS kind FROM ${mapping.table} WHERE ${mapping.key}=?`).get(parent.parent)!;
      if (shape.valid !== 1 || shape.kind !== "array") throw new PortableStreamError("source-invalid", { domain });
      options.arrayValidation?.add(domain, parentLocator);
    }
    const statement = db.prepare(`SELECT ${sqliteUtf8Projection(["value"])}, ordinal, nul_at, type FROM (SELECT j.key AS ordinal, CASE WHEN instr(j.value,char(0))=0 THEN j.value END AS value, instr(j.value,char(0)) AS nul_at, j.type AS type FROM ${mapping.table} AS p, json_each(p.${mapping.column}) AS j WHERE p.${mapping.key}=?${keys === undefined ? "" : " AND j.key=CAST(? AS INTEGER)"} ORDER BY j.key)`);
    statement.setReadBigInts(true);
    for (const rawItem of statement.iterate(...(keys === undefined ? [parent.parent] : [parent.parent, keys[1]]))) {
      if (rawItem.type !== "text") throw new PortableStreamError("source-invalid", { domain });
      if (rawItem.nul_at !== 0n) throw new PortableStreamError("record-unrepresentable", { domain });
      const item = decodeSqliteUtf8Row(rawItem, ["value"]);
      yield {
        locator: JSON.stringify([String(parent.parent), String(item.ordinal)]),
        value: { [mapping.parentField]: parent.parent, ordinal: item.ordinal, [mapping.valueField]: item.value },
      };
    }
  }
}

/** Native physical order only. Canonical ordering/occurrences belong to the source index. */
export function* iteratePortableRuntimeRows(db: DatabaseSync, domain: PortableDomain, options: SqliteRuntimeReadOptions = {}): Generator<SqliteRawDomainRow> {
  const array = arrayMapping(domain);
  if (array !== undefined) { yield* readArray(db, domain, array, options); return; }
  const mapping = mappingFor(domain);
  const { where, values } = queryParts(mapping, domain, options);
  const order = domain === "messages" ? "conversation_id,seq" : mapping.key.join(",");
  const bytes = nativeBytes(mapping);
  const keys = mapping.key.map(key => `CASE WHEN ${bytes}<=${PORTABLE_LIMITS.maxRecordBytes} THEN ${key} END AS ${key}`);
  const statement = db.prepare(`SELECT ${sqliteUtf8Projection(mapping.key)}, bytes FROM (SELECT ${keys.join(",")},${bytes} AS bytes FROM ${mapping.table}${where} ORDER BY ${order})`);
  statement.setReadBigInts(true);
  for (const header of statement.iterate(...values)) {
    byteCheck(header.bytes);
    yield readNative(db, domain, mapping, locatorFor(mapping.key, decodeSqliteUtf8Row(header, mapping.key)), options)!;
  }
}

/** Point reread from native tables, never a transfer-ledger payload echo. */
export function readPortableRuntimeRow(db: DatabaseSync, domain: PortableDomain, locator: string, options: SqliteRuntimeReadOptions = {}): SqliteRawDomainRow | undefined {
  const array = arrayMapping(domain);
  if (array !== undefined) {
    // for-of closes both SQLite iterators on the early point-read return.
    for (const row of readArray(db, domain, array, options, locator)) return row;
    return undefined;
  }
  return readNative(db, domain, mappingFor(domain), locator, options);
}
