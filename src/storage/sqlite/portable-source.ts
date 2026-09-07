import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createCapturedSqliteAuthority, openCapturedSqliteDatabase, type CapturedSqliteAuthority } from "./portable-capture.js";
import { decodeSqliteUtf8Row, sqliteUtf8Projection } from "./portable-utf8.js";
import {
  PORTABLE_LIMITS, PORTABLE_RECORD_DOMAIN_ORDER, PORTABLE_RECORD_SCHEMA_SHA256, canonicalJson, canonicalSha256,
  createPortableRecord, serializePortableRecord,
} from "../portable-record.js";
import type {
  PortableDomain, PortableProjectIdentity, PortableRecord, PortableRecordInput,
  PortableRawConversationOrder, PortableRawMessageOrder,
} from "../portable-record.js";
import { parsePortableManifest, parsePortableCheckpoint, verifyPortableCheckpoint } from "../portable-record-stream.js";
import type { PortableRecordSource, PortableSourceDescription, PortableSourcePageInput } from "../portable-record-stream.js";
import { PortableTransferError, normalizePortableTransferError } from "../portable-transfer.js";
import { createPortableIndex } from "../portable-index.js";
import { PORTABLE_ARCHIVE_DOMAINS, readArchiveDomain, readArchiveDomainRow, createSqlitePortableArchiveReader, type SqlitePortableArchiveReader } from "./portable-archive.js";
import { iteratePortableRuntimeRows, readPortableRuntimeRow } from "./portable-runtime-mapping.js";
import { iterateSqliteSidecarDomainRows, readSqliteSidecarDomainRow, validateSqliteSidecarSchema } from "./portable-sidecars.js";
import type { SqliteRawDomainRow } from "./portable-runtime-mapping.js";

export interface SqlitePortableIdentityFacts {
  readonly sourceLocalProjectId?: string;
  readonly machines: readonly Readonly<{identityKey:string;machineId:string|null}>[];
  readonly aliases: readonly Readonly<{machineIdentityKey:string;path:string;normalizedPath:string}>[];
}
export interface SqlitePortableCapturedFile {
  readonly databasePath: string;
  readonly expectedFileSha256: string;
  readonly machineIdentityKey: string;
}
export interface SqlitePortableAbsentSidecar {
  readonly absent: true;
  readonly evidenceSha256: string;
}
export interface SqlitePortableCapturedSidecars {
  readonly events: SqlitePortableCapturedFile | SqlitePortableAbsentSidecar;
  readonly instructions: readonly SqlitePortableCapturedFile[] | SqlitePortableAbsentSidecar;
}
export interface SqlitePortableRecordSource extends PortableRecordSource {
  readonly recoveryArchive: SqlitePortableArchiveReader;
}
export interface OpenSqlitePortableSourceInput {
  readonly databasePath: string;
  readonly projectIdentity: PortableProjectIdentity;
  /** Native SQLite scope authenticated by identityFacts; distinct from a shared canonical UUID. */
  readonly sourceLocalProjectId?: string;
  readonly expectedFileSha256: string;
  /** Explicit captured identity facts, never discovered from the live installation. */
  readonly identityFacts?: SqlitePortableIdentityFacts;
  readonly expectedFactsSha256?: string;
  /** Explicit owner of the main capture when more than one machine is represented. */
  readonly machineIdentityKey?: string;
  /** Required for nonarchive sources; absence must be explicit captured evidence. */
  readonly capturedSidecars?: SqlitePortableCapturedSidecars;
  readonly capturedAt: string;
  readonly scratchParent?: string;
  readonly signal?: AbortSignal;
}

/** Hash a supplied immutable database with bounded memory; capture coherence belongs to its producer. */
export function sqlitePortableFileSha256(path: string): string {
  const fd=openSync(path,"r");
  try { const hash=createHash("sha256");const buffer=Buffer.alloc(64*1024);let count:number;
    while((count=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));
    return hash.digest("hex");
  } finally {closeSync(fd);}
}

function timestamp(value:unknown):string|null {
  if(value===null)return null;
  const text=String(value).replace(" ","T");
  const match=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z?$/.exec(text);
  if(!match)throw new PortableTransferError("unsupported-capability");
  return `${match[1]}.${(match[2]??"").padEnd(6,"0")}Z`;
}
function header(row:SqliteRawDomainRow):readonly [string,string|null,string|null,string,string] {
  return [String(row.value.sessionId),row.value.title as string|null,timestamp(row.value.bootstrappedAt),timestamp(row.value.createdAt)!,timestamp(row.value.updatedAt)!];
}
function tableExists(db:DatabaseSync,table:string):boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)!==undefined;
}

// Supported captured layouts are explicit. Source admission never runs migrations.
const sourceLayouts: Readonly<Record<string,string>> = {
  "context_items": "conversation_id:INTEGER|ordinal:INTEGER|item_type:TEXT|message_id:INTEGER|summary_id:TEXT|created_at:TEXT",
  "conversations": "conversation_id:INTEGER|session_id:TEXT|title:TEXT|bootstrapped_at:TEXT|created_at:TEXT|updated_at:TEXT",
  "large_files": "file_id:TEXT|conversation_id:INTEGER|file_name:TEXT|mime_type:TEXT|byte_size:INTEGER|storage_uri:TEXT|exploration_summary:TEXT|created_at:TEXT",
  "message_parts": "part_id:TEXT|message_id:INTEGER|session_id:TEXT|part_type:TEXT|ordinal:INTEGER|text_content:TEXT|is_ignored:INTEGER|is_synthetic:INTEGER|tool_call_id:TEXT|tool_name:TEXT|tool_status:TEXT|tool_input:TEXT|tool_output:TEXT|tool_error:TEXT|tool_title:TEXT|patch_hash:TEXT|patch_files:TEXT|file_mime:TEXT|file_name:TEXT|file_url:TEXT|subtask_prompt:TEXT|subtask_desc:TEXT|subtask_agent:TEXT|step_reason:TEXT|step_cost:REAL|step_tokens_in:INTEGER|step_tokens_out:INTEGER|snapshot_hash:TEXT|compaction_auto:INTEGER|metadata:TEXT",
  "messages": "message_id:INTEGER|conversation_id:INTEGER|seq:INTEGER|role:TEXT|content:TEXT|token_count:INTEGER|created_at:TEXT",
  "messages_fts": "content:",
  "messages_fts_config": "k:|v:",
  "messages_fts_content": "id:INTEGER|c0:",
  "messages_fts_data": "id:INTEGER|block:BLOB",
  "messages_fts_docsize": "id:INTEGER|sz:BLOB",
  "messages_fts_idx": "segid:|term:|pgno:",
  "promoted": "id:TEXT|content:TEXT|tags:TEXT|metadata:TEXT|source_summary_id:TEXT|project_id:TEXT|session_id:TEXT|depth:INTEGER|confidence:REAL|created_at:TEXT|archived_at:TEXT",
  "promoted_fts": "content:|tags:",
  "promoted_fts_config": "k:|v:",
  "promoted_fts_content": "id:INTEGER|c0:|c1:",
  "promoted_fts_data": "id:INTEGER|block:BLOB",
  "promoted_fts_docsize": "id:INTEGER|sz:BLOB",
  "promoted_fts_idx": "segid:|term:|pgno:",
  "recall_surfacing": "id:INTEGER|memory_id:TEXT|session_id:TEXT|surfaced_at:TEXT",
  "redaction_stats": "project_id:TEXT|category:TEXT|count:INTEGER",
  "runtime_native_ingest_checkpoints": "project_id:TEXT|machine_id:TEXT|client_name:TEXT|source_locator:TEXT|revision:INTEGER|last_source_ordinal:INTEGER|imported_count:INTEGER|skipped_count:INTEGER|quarantined_count:INTEGER|checkpoint:TEXT|updated_at:TEXT",
  "runtime_native_transcript_messages": "project_id:TEXT|transcript_id:TEXT|conversation_id:INTEGER|message_id:INTEGER|source_ordinal:INTEGER",
  "runtime_native_transcripts": "transcript_id:TEXT|project_id:TEXT|machine_id:TEXT|client_name:TEXT|format_name:TEXT|format_version:TEXT|native_session_id:TEXT|source_locator:TEXT|source_ordinal:INTEGER|observed_at:TEXT|ingested_at:TEXT|scrubber_version:TEXT|content_sha256:TEXT|ingest_key:TEXT|native_payload:TEXT",
  "session_ingest_log": "session_id:TEXT|completed_at:TEXT|message_count:INTEGER",
  "session_instruction_cache": "project_id:TEXT|scope_hash:TEXT|client_name:TEXT|session_id:TEXT|worktree_path:TEXT|cwd_path:TEXT|content:TEXT|content_hash:TEXT|updated_at:TEXT",
  "sqlite_sequence": "name:|seq:",
  "summaries": "summary_id:TEXT|conversation_id:INTEGER|kind:TEXT|depth:INTEGER|content:TEXT|token_count:INTEGER|earliest_at:TEXT|latest_at:TEXT|descendant_count:INTEGER|descendant_token_count:INTEGER|source_message_token_count:INTEGER|created_at:TEXT|file_ids:TEXT",
  "summaries_fts": "summary_id:|content:",
  "summaries_fts_config": "k:|v:",
  "summaries_fts_content": "id:INTEGER|c0:|c1:",
  "summaries_fts_data": "id:INTEGER|block:BLOB",
  "summaries_fts_docsize": "id:INTEGER|sz:BLOB",
  "summaries_fts_idx": "segid:|term:|pgno:",
  "summary_messages": "summary_id:TEXT|message_id:INTEGER|ordinal:INTEGER",
  "summary_parents": "summary_id:TEXT|parent_summary_id:TEXT|ordinal:INTEGER",
  "portable_archive_machines": "_ordinal:INTEGER|_identity_sha256:TEXT|identityKey:TEXT|machineId:TEXT",
  "portable_archive_native_transcript_checkpoints": "_ordinal:INTEGER|_identity_sha256:TEXT|machineIdentityKey:TEXT|clientName:TEXT|sourceLocator:TEXT|revision:INTEGER|lastSourceOrdinal:INTEGER|importedCount:INTEGER|skippedCount:INTEGER|quarantinedCount:INTEGER|checkpoint:TEXT|updatedAt:TEXT",
  "portable_archive_native_transcript_message_links": "_ordinal:INTEGER|_identity_sha256:TEXT|machineIdentityKey:TEXT|ingestKey:TEXT|sourceOrdinal:INTEGER|conversationIdentitySha256:TEXT|messageIdentitySha256:TEXT|_transcript_identity_sha256:TEXT",
  "portable_archive_native_transcripts": "_ordinal:INTEGER|_identity_sha256:TEXT|machineIdentityKey:TEXT|clientName:TEXT|formatName:TEXT|formatVersion:TEXT|nativeSessionId:TEXT|sourceLocator:TEXT|sourceOrdinal:INTEGER|observedAt:TEXT|ingestedAt:TEXT|scrubberVersion:TEXT|contentSha256:TEXT|ingestKey:TEXT|nativePayload:TEXT",
  "portable_archive_passive_events": "_ordinal:INTEGER|_identity_sha256:TEXT|machineIdentityKey:TEXT|eventId:TEXT|eventVersion:INTEGER|machineSequence:INTEGER|eventType:TEXT|sessionId:TEXT|sessionSequence:INTEGER|category:TEXT|data:TEXT|priority:INTEGER|sourceHook:TEXT|createdAt:TEXT|disposition:TEXT",
  "portable_archive_project": "_ordinal:INTEGER|_identity_sha256:TEXT|scope:TEXT|projectId:TEXT",
  "portable_archive_project_aliases": "_ordinal:INTEGER|_identity_sha256:TEXT|machineIdentityKey:TEXT|path:TEXT|normalizedPath:TEXT",
  "portable_archive_session_instructions": "_ordinal:INTEGER|_identity_sha256:TEXT|machineIdentityKey:TEXT|scopeHash:TEXT|clientName:TEXT|sessionId:TEXT|worktreePath:TEXT|cwdPath:TEXT|content:TEXT|contentHash:TEXT|updatedAt:TEXT",
  "transfer_batches": "run_sha:TEXT|domain:TEXT|prior_sha:TEXT|result_sha:TEXT|checkpoint_json:TEXT|batch_sha:TEXT",
  "transfer_identities": "run_sha:TEXT|domain:TEXT|identity_sha:TEXT|ordinal:INTEGER|locator:TEXT|record_sha:TEXT",
  "transfer_runs": "generation_sha:TEXT|project_json:TEXT|manifest_sha:TEXT|manifest_json:TEXT|source_identity:TEXT|source_witness:TEXT|checkpoints_json:TEXT|schema_ready:INTEGER|complete:INTEGER",
  sqlite_stat1: "tbl:|idx:|stat:",
  sqlite_stat4: "tbl:|idx:|neq:|nlt:|ndlt:|sample:",
};
const sourceTriggers: Readonly<Record<string,string>> = {
  "transfer_batches_no_delete": "CREATE TRIGGER transfer_batches_no_delete BEFORE DELETE ON transfer_batches BEGIN SELECT RAISE(ABORT,'immutable receipt');END",
  "transfer_batches_no_update": "CREATE TRIGGER transfer_batches_no_update BEFORE UPDATE ON transfer_batches BEGIN SELECT RAISE(ABORT,'immutable receipt');END"
};
export function validateSqlitePortableSchema(db: DatabaseSync): void {
  if(db.prepare("PRAGMA encoding").get()?.encoding!=="UTF-8")throw new PortableTransferError("unsupported-capability");
  if (db.prepare("PRAGMA user_version").get()?.user_version !== 0) throw new PortableTransferError("unsupported-capability");
  const seen = new Set<string>();
  const seenTriggers = new Set<string>();
  let count = 0;
  for (const row of db.prepare("SELECT CASE WHEN length(CAST(name AS BLOB))<=1024 THEN name END AS name,type,CASE WHEN length(CAST(sql AS BLOB))<=4096 THEN sql END AS sql FROM sqlite_schema WHERE type IN ('table','view','trigger') LIMIT 128").iterate()) {
    if (++count === 128 || typeof row.name !== "string") throw new PortableTransferError("unsupported-capability");
    if (row.type === "trigger" && Object.hasOwn(sourceTriggers,row.name) && row.sql === sourceTriggers[row.name]) {seenTriggers.add(row.name);continue;}
    if (row.type !== "table" || !Object.hasOwn(sourceLayouts,row.name)) throw new PortableTransferError("unsupported-capability");
    const name=row.name;
    const expected=sourceLayouts[name];
    const actual: string[]=[];
    for (const column of db.prepare(`PRAGMA table_xinfo("${name}")`).iterate()) {
      if (column.hidden === 1 && /^(messages|summaries|promoted)_fts$/.test(name) && (column.name === name || column.name === "rank")) continue;
      if (column.hidden !== 0 || actual.length >= 64) throw new PortableTransferError("unsupported-capability");
      actual.push(`${column.name}:${column.type}`);
    }
    if (actual.join("|") !== expected) throw new PortableTransferError("unsupported-capability");
    // node:sqlite decodes TEXT through a NUL-terminated string. Refuse literal
    // NUL before fetching scalar text; escaped JSON reaches the codec unchanged.
    const textColumns=expected.split("|").filter(column=>column.endsWith(":TEXT")).map(column=>column.slice(0,-5));
    if(textColumns.length>0 && db.prepare(`SELECT 1 FROM "${name}" WHERE ${textColumns.map(column=>`instr("${column}",char(0))>0`).join(" OR ")} LIMIT 1`).get()!==undefined)throw new PortableTransferError("unsupported-capability");
    seen.add(name);
  }
  for (const name of Object.keys(sourceLayouts)) {
    if (name.includes("_fts") || name.startsWith("sqlite_") || name.startsWith("runtime_native_") || name.startsWith("portable_archive_") || name.startsWith("transfer_")) continue;
    if (!seen.has(name)) throw new PortableTransferError("unsupported-capability");
  }
  for (const prefix of ["runtime_native_","portable_archive_","transfer_"]) {
    const group=Object.keys(sourceLayouts).filter(name=>name.startsWith(prefix));
    const present=group.filter(name=>seen.has(name)).length;
    if(present !== 0 && present !== group.length) throw new PortableTransferError("unsupported-capability");
  }
  if (seen.has("transfer_runs") && seenTriggers.size !== Object.keys(sourceTriggers).length) throw new PortableTransferError("unsupported-capability");
  if (db.prepare("SELECT 1 FROM pragma_foreign_key_check LIMIT 1").get() !== undefined) throw new PortableTransferError("unsupported-capability");
}

interface SourceAuthority {
  readonly capture: CapturedSqliteAuthority;
  active: boolean;
}
const authorities = new WeakMap<object, SourceAuthority>();
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PortableTransferError("aborted", true);
}
async function cooperate(signal?: AbortSignal): Promise<void> {
  abort(signal);
  await yieldToEventLoop();
  abort(signal);
}
function authority(token: object, signal?: AbortSignal): SourceAuthority {
  abort(signal);
  const state = authorities.get(token);
  if (!state?.active) throw new PortableTransferError("source-failed");
  return state;
}
function changed(state: SourceAuthority, error: unknown): never {
  if (error instanceof PortableTransferError && error.code === "aborted") throw error;
  state.active = false;
  throw normalizePortableTransferError(error, "source-changed");
}
function assertAuthority(token: object): void {
  const state = authority(token);
  try {
    state.capture.checkSync();
  } catch (error) { changed(state, error); }
}
/** Async operations hash in bounded I/O chunks so cancellation can arrive during verification. */
async function assertAuthorityAsync(token: object, signal?: AbortSignal, forceHash = false): Promise<void> {
  const state = authority(token, signal);
  try {
    await state.capture.check(signal,forceHash);
    authority(token, signal);
  } catch (error) { changed(state, error); }
}

function snapshotFacts(input: SqlitePortableIdentityFacts, expectedHash: string | undefined): SqlitePortableIdentityFacts {
  if (!Array.isArray(input.machines) || !Array.isArray(input.aliases)
    || input.machines.length > 500 || input.aliases.length > 500) {
    throw new PortableTransferError("unsupported-capability");
  }
  // Refuse oversized strings before JSON cloning; permit only this fixed, shallow shape.
  let bytes = 0;
  const shapes = [[input.machines, ["identityKey", "machineId"]],
    [input.aliases, ["machineIdentityKey", "path", "normalizedPath"]]] as const;
  if (Object.keys(input).length !== (input.sourceLocalProjectId === undefined ? 2 : 3)
    || (input.sourceLocalProjectId !== undefined && !/^[a-f0-9]{64}$/.test(input.sourceLocalProjectId))) throw new PortableTransferError("invalid-input");
  for (const [values, keys] of shapes) {
    for (const value of values) {
      if (Object.keys(value).length !== keys.length) throw new PortableTransferError("invalid-input");
      for (const key of keys) {
        const scalar = (value as unknown as Record<string, unknown>)[key];
        if (scalar === null && key === "machineId") continue;
        if (typeof scalar !== "string") throw new PortableTransferError("invalid-input");
        bytes += Buffer.byteLength(scalar);
        if (bytes > PORTABLE_LIMITS.maxControlBytes) throw new PortableTransferError("unsupported-capability");
      }
    }
  }
  const json = canonicalJson(input);
  if (Buffer.byteLength(json) > PORTABLE_LIMITS.maxControlBytes) throw new PortableTransferError("unsupported-capability");
  if (canonicalSha256(input) !== expectedHash) throw new PortableTransferError("source-changed");
  return JSON.parse(json) as SqlitePortableIdentityFacts;
}

type CapturedDomain = "session-instructions" | "native-transcripts" | "native-transcript-message-links" | "native-transcript-checkpoints";
type SqlRow = Record<string, SQLOutputValue>;
interface CapturedTable {
  readonly from: string;
  readonly keys: readonly string[];
  readonly fields: readonly (readonly [name: string, expression: string])[];
}
function columns(names: readonly string[]): readonly (readonly [string, string])[] {
  return names.map(name => [name, `s.${name}`] as const);
}
const capturedTables: Record<CapturedDomain, CapturedTable> = {
  "session-instructions": {
    from: "session_instruction_cache s", keys: ["scope_hash"],
    fields: columns(["scope_hash", "client_name", "session_id", "worktree_path", "cwd_path", "content", "content_hash", "updated_at"]),
  },
  "native-transcripts": {
    from: "runtime_native_transcripts s", keys: ["transcript_id"],
    fields: columns(["transcript_id", "machine_id", "client_name", "format_name", "format_version", "native_session_id", "source_locator", "source_ordinal", "observed_at", "ingested_at", "scrubber_version", "content_sha256", "ingest_key", "native_payload"]),
  },
  "native-transcript-checkpoints": {
    from: "runtime_native_ingest_checkpoints s", keys: ["machine_id", "client_name", "source_locator"],
    fields: columns(["machine_id", "client_name", "source_locator", "revision", "last_source_ordinal", "imported_count", "skipped_count", "quarantined_count", "checkpoint", "updated_at"]),
  },
  "native-transcript-message-links": {
    from: "runtime_native_transcript_messages s JOIN runtime_native_transcripts t ON t.project_id=s.project_id AND t.transcript_id=s.transcript_id",
    keys: ["transcript_id", "source_ordinal"],
    fields: [...columns(["transcript_id", "source_ordinal", "conversation_id", "message_id"]), ["machine_id", "t.machine_id"], ["ingest_key", "t.ingest_key"]],
  },
};
function physicalKey(keys: readonly string[], row: SqlRow): string {
  const values = keys.map(key => String(row[key]));
  return values.length === 1 ? values[0] : canonicalJson(values);
}
/** Bounded key metadata, followed by a direct point read; no payload crosses the driver before its length check. */
function* capturedRows(db: DatabaseSync, domain: CapturedDomain, projectId: string, locator?: string): Generator<SqlRow> {
  if (domain !== "session-instructions" && !tableExists(db, "runtime_native_transcripts")) return;
  const { from, keys, fields } = capturedTables[domain];
  const byteLength = fields.map(([, expr]) => `coalesce(length(CAST(${expr} AS BLOB)),0)`).join("+");
  const keySql = keys.map(key => `s.${key}`);
  const projection = fields.map(([name, expr]) => `${expr} AS ${name}`).join(",");
  let point: SQLInputValue[] | undefined;
  if (locator !== undefined) point = keys.length === 1 ? [locator] : JSON.parse(locator) as string[];
  const pointWhere = keySql.map(key => `${key}=?`).join(" AND ");
  let content: ReturnType<DatabaseSync["prepare"]> | undefined;
  const nativeMetadataBytes = fields.filter(([name]) => name !== "native_payload").map(([, expr]) => `coalesce(length(CAST(${expr} AS BLOB)),0)`).join("+");
  const extraMeta = domain === "native-transcripts" ? `,${nativeMetadataBytes} AS _metadata_bytes,length(CAST(s.native_payload AS BLOB)) AS _payload_bytes` : "";
  let after: SQLInputValue[] | undefined;
  for (;;) {
    const predicate = point !== undefined ? ` AND ${pointWhere}`
      : after === undefined ? "" : ` AND (${keySql.join(",")}) > (${keys.map(() => "?").join(",")})`;
    const metaColumns = keys.map((key, index) => `CASE WHEN ${byteLength}<=${PORTABLE_LIMITS.maxRecordBytes} THEN ${keySql[index]} END AS ${key}`);
    const statement = db.prepare(`SELECT ${sqliteUtf8Projection(keys)},_bytes${domain === "native-transcripts" ? ",_metadata_bytes,_payload_bytes" : ""} FROM (SELECT ${metaColumns.join(",")},${byteLength} AS _bytes${extraMeta} FROM ${from}
      WHERE s.project_id=?${predicate} ORDER BY ${keySql.join(",")} LIMIT ${point === undefined ? 500 : 1})`);
    statement.setReadBigInts(true);
    let count = 0;
    for (const rawMeta of statement.iterate(projectId, ...(point ?? after ?? []))) {
      const meta=decodeSqliteUtf8Row(rawMeta,keys);
      if (BigInt(meta._bytes as bigint) > BigInt(PORTABLE_LIMITS.maxRecordBytes)) throw new PortableTransferError("unsupported-capability");
      if (domain === "native-transcripts" && (BigInt(meta._metadata_bytes as bigint) > BigInt(PORTABLE_LIMITS.maxControlBytes)
        || BigInt(meta._payload_bytes as bigint) > 100n * 1024n * 1024n)) throw new PortableTransferError("unsupported-capability");
      const values = keys.map(key => meta[key]);
      if (!content) {
        content = db.prepare(`SELECT ${sqliteUtf8Projection(fields.map(([name])=>name))} FROM (SELECT ${projection} FROM ${from} WHERE s.project_id=? AND ${pointWhere})`);
        content.setReadBigInts(true);
      }
      const row = content.get(projectId, ...values);
      if (row === undefined) throw new PortableTransferError("source-changed");
      yield decodeSqliteUtf8Row(row,fields.map(([name])=>name));
      after = values;
      count++;
    }
    if (point !== undefined || count < 500) return;
  }
}

/**
 * Open an owner-selected captured database. Hashes authenticate the supplied
 * files; they cannot prove a historical atomic capture of independently made
 * files or sidecars. The producer must establish that capture coherence.
 */
export async function openSqlitePortableSource(input:OpenSqlitePortableSourceInput):Promise<SqlitePortableRecordSource> {
  let db:DatabaseSync|undefined;
  let index:ReturnType<typeof createPortableIndex>|undefined;
  const token=Object.freeze({});
  const tokens: object[] = [token];
  const sidecars: { connection: DatabaseSync; domain: "passive-events" | "session-instructions"; identity: { projectIdentity: PortableProjectIdentity; machineIdentityKey: string; machineId: string | null; sourceLocalProjectId: string } }[] = [];
  function revoke(): void { for (const item of tokens) { const state=authorities.get(item); if(state) state.active=false; } }
  function guardSync(): void {
    try { for (const item of tokens) assertAuthority(item); }
    catch (error) { revoke(); throw error; }
  }
  async function guard(signal?: AbortSignal,forceHash=false): Promise<void> {
    try { for (const item of tokens) await assertAuthorityAsync(item,signal,forceHash); }
    catch (error) { if (!(error instanceof PortableTransferError && error.code === "aborted")) revoke(); throw error; }
  }
  const { databasePath, expectedFileSha256, expectedFactsSha256, capturedAt, scratchParent, signal, machineIdentityKey } = input;
  try {
    if(databasePath.includes("\0") || machineIdentityKey?.includes("\0"))throw new PortableTransferError("unsupported-capability");
    if(!/^[0-9a-f]{64}$/.test(expectedFileSha256)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(capturedAt))throw new PortableTransferError("invalid-input");
    const path=resolve(databasePath);
    authorities.set(token,{capture:createCapturedSqliteAuthority(path,expectedFileSha256),active:true});
    await assertAuthorityAsync(token,signal);
    db=openCapturedSqliteDatabase(path);
    db.exec("PRAGMA query_only=ON; BEGIN");
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    await assertAuthorityAsync(token,signal);
    const connection=db;
    const identity=JSON.parse(canonicalJson(input.projectIdentity)) as PortableProjectIdentity;
    let facts:SqlitePortableIdentityFacts|undefined;
    if(input.identityFacts!==undefined) facts=snapshotFacts(input.identityFacts,expectedFactsSha256);
    validateSqlitePortableSchema(connection);
    const archive=tableExists(connection,"portable_archive_project");
    const sourceLocalProjectId=input.sourceLocalProjectId ?? identity.projectId;
    if(input.sourceLocalProjectId!==undefined && (!/^[a-f0-9]{64}$/.test(input.sourceLocalProjectId)
      || facts?.sourceLocalProjectId!==input.sourceLocalProjectId))throw new PortableTransferError("unsupported-capability");
    if(facts?.sourceLocalProjectId!==undefined && facts.sourceLocalProjectId!==sourceLocalProjectId)throw new PortableTransferError("unsupported-capability");
    if(!archive && identity.scope==="shared" && input.sourceLocalProjectId===undefined)throw new PortableTransferError("unsupported-capability");
    if(archive && sourceLocalProjectId!==identity.projectId)throw new PortableTransferError("unsupported-capability");
    for(const table of ["redaction_stats","runtime_native_transcripts","runtime_native_transcript_messages","runtime_native_ingest_checkpoints"]){
      if(tableExists(connection,table) && connection.prepare(`SELECT 1 FROM ${table} WHERE project_id<>? LIMIT 1`).get(sourceLocalProjectId)!==undefined)throw new PortableTransferError("unsupported-capability");
    }
    function validateCacheScope(handle:DatabaseSync):void {
      if(handle.prepare("SELECT 1 FROM session_instruction_cache LIMIT 1").get()!==undefined
        && handle.prepare("SELECT 1 FROM session_instruction_cache WHERE project_id=? LIMIT 1").get(sourceLocalProjectId)===undefined)throw new PortableTransferError("unsupported-capability");
    }
    validateCacheScope(connection);
    if(!archive&&!facts)throw new PortableTransferError("unsupported-capability");
    if(archive){
      for(const table of ["session_instruction_cache","runtime_native_transcripts","runtime_native_transcript_messages","runtime_native_ingest_checkpoints"]){
        if(tableExists(connection,table) && connection.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined) throw new PortableTransferError("unsupported-capability");
      }
      const projects=readArchiveDomain(connection,"project");
      try {
        const first=projects.next();
        if(first.done || !projects.next().done || canonicalJson(first.value.value)!==canonicalJson({identity}))throw new PortableTransferError("source-changed");
      } finally { projects.return(undefined); }
    }
    const mainMachineIdentityKey = machineIdentityKey ?? (facts?.machines.length === 1 ? facts.machines[0].identityKey : null);
    if (machineIdentityKey !== undefined && !facts?.machines.some(machine => machine.identityKey === machineIdentityKey)) throw new PortableTransferError("unsupported-capability");
    let sidecarEvidence: unknown = null;
    if (!archive) {
      const captured = input.capturedSidecars;
      if (captured === undefined) throw new PortableTransferError("unsupported-capability");
      const absent = (value: unknown): value is SqlitePortableAbsentSidecar => {
        if (typeof value !== "object" || value === null || !("absent" in value)) return false;
        if (value.absent !== true || Object.keys(value).length !== 2 || !("evidenceSha256" in value)
          || typeof value.evidenceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.evidenceSha256)) throw new PortableTransferError("invalid-input");
        return true;
      };
      if (typeof captured !== "object" || captured === null || Object.keys(captured).length !== 2) throw new PortableTransferError("invalid-input");
      const eventsAbsent = absent(captured.events);
      const instructionsAbsent = absent(captured.instructions);
      if (!instructionsAbsent && (!Array.isArray(captured.instructions) || captured.instructions.length === 0 || captured.instructions.length > 500)) throw new PortableTransferError("invalid-input");
      const entries: { domain: "passive-events" | "session-instructions"; file: SqlitePortableCapturedFile }[] = [
        ...(eventsAbsent ? [] : [{ domain: "passive-events" as const, file: captured.events as SqlitePortableCapturedFile }]),
        ...(instructionsAbsent ? [] : (captured.instructions as readonly SqlitePortableCapturedFile[]).map(file => ({domain: "session-instructions" as const, file}))),
      ];
      // Copy and bound the descriptors before awaiting; callers cannot change the admitted capture.
      const descriptors = entries.map(({domain,file}) => {
        if (typeof file !== "object" || file === null || Object.keys(file).length !== 3
          || typeof file.databasePath !== "string" || typeof file.machineIdentityKey !== "string"
          || typeof file.expectedFileSha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.expectedFileSha256)
          || Buffer.byteLength(file.databasePath) + Buffer.byteLength(file.machineIdentityKey) > PORTABLE_LIMITS.maxControlBytes) throw new PortableTransferError("invalid-input");
        if(file.databasePath.includes("\0") || file.machineIdentityKey.includes("\0"))throw new PortableTransferError("unsupported-capability");
        const machine = facts!.machines.find(item => item.identityKey === file.machineIdentityKey);
        if (!machine) throw new PortableTransferError("unsupported-capability");
        return {domain,path:resolve(file.databasePath),expected:file.expectedFileSha256,machineIdentityKey:machine.identityKey,machineId:machine.machineId};
      });
      sidecarEvidence = {events:eventsAbsent ? {...captured.events} : descriptors.filter(item => item.domain === "passive-events").map(({path:_,...item}) => item),
        instructions:instructionsAbsent ? {...captured.instructions} : descriptors.filter(item => item.domain === "session-instructions").map(({path:_,...item}) => item)};
      const seen = new Set([path]);
      for (const descriptor of descriptors) {
        if (seen.has(descriptor.path)) throw new PortableTransferError("invalid-input");
        seen.add(descriptor.path);
        const sideToken=Object.freeze({});tokens.push(sideToken);
        authorities.set(sideToken,{capture:createCapturedSqliteAuthority(descriptor.path,descriptor.expected),active:true});
        await assertAuthorityAsync(sideToken,signal);
        const sideConnection = openCapturedSqliteDatabase(descriptor.path);
        sidecars.push({connection:sideConnection,domain:descriptor.domain,identity:{projectIdentity:identity,machineIdentityKey:descriptor.machineIdentityKey,machineId:descriptor.machineId,sourceLocalProjectId}});
        sideConnection.exec("PRAGMA query_only=ON; BEGIN");
        sideConnection.prepare("SELECT count(*) FROM sqlite_master").get();
        if(sideConnection.prepare("PRAGMA encoding").get()?.encoding!=="UTF-8")throw new PortableTransferError("unsupported-capability");
        if (descriptor.domain === "session-instructions" && tableExists(sideConnection,"conversations")) validateSqlitePortableSchema(sideConnection);
        else validateSqliteSidecarSchema(sideConnection,descriptor.domain);
        if(descriptor.domain === "session-instructions")validateCacheScope(sideConnection);
        await assertAuthorityAsync(sideToken,signal);
      }
    }
    index=createPortableIndex({scratchParent:scratchParent,signal:signal});
    const ordinalIndex=index;
    const options={projectIdentity:identity,sourceLocalProjectId,arrayValidation:{
      has(domain:PortableDomain,parent:string){return ordinalIndex.getScope(`source-array:${domain}`,parent)!==null;},
      add(domain:PortableDomain,parent:string){ordinalIndex.bindScope(`source-array:${domain}`,parent,"validated");},
    }};
    const machineKey=():string=>{
      if(mainMachineIdentityKey === null)throw new PortableTransferError("unsupported-capability");
      return mainMachineIdentityKey;
    };
    function* rows(domain:PortableDomain):Generator<SqliteRawDomainRow>{
      if(archive&&(PORTABLE_ARCHIVE_DOMAINS as readonly string[]).includes(domain)){
        for(const row of readArchiveDomain(connection,domain as typeof PORTABLE_ARCHIVE_DOMAINS[number]))yield {locator:row.physicalIdentityKey,value:row.value as unknown as Record<string,unknown>};return;
      }
      if(domain==="project"){yield {locator:"project",value:{identity}};return;}
      if(domain==="machines"){for(const value of facts!.machines)yield {locator:value.identityKey,value:{...value}};return;}
      if(domain==="project-aliases"){for(const value of facts!.aliases)yield {locator:canonicalJson([value.machineIdentityKey,value.normalizedPath]),value:{...value}};return;}
      if(domain==="session-instructions" || domain==="passive-events") {
        for (const [position, sidecar] of sidecars.entries()) if (sidecar.domain === domain) {
          for (const row of iterateSqliteSidecarDomainRows(sidecar.connection,domain,sidecar.identity)) yield {...row,locator:canonicalJson(["sidecar",position,row.locator])};
        }
      }
      if(domain==="session-instructions" || domain==="native-transcripts" || domain==="native-transcript-message-links" || domain==="native-transcript-checkpoints") {
        for (const value of capturedRows(connection,domain,sourceLocalProjectId)) yield decodeCaptured(domain,value);
        return;
      }
      if(domain==="passive-events")return;
      yield* iteratePortableRuntimeRows(connection,domain,options);
    }
    function decodeCaptured(domain: CapturedDomain, r: SqlRow): SqliteRawDomainRow {
      const locator=physicalKey(capturedTables[domain].keys,r);
      if(domain==="session-instructions") return {locator,value:{machineIdentityKey:machineKey(),scopeHash:r.scope_hash,clientName:r.client_name,sessionId:r.session_id,worktreePath:r.worktree_path,cwdPath:r.cwd_path,content:r.content,contentHash:r.content_hash,updatedAt:r.updated_at}};
      const machine=(id:unknown):string=>{
        if(id==="local")return machineKey();
        const found=facts!.machines.find(value=>value.machineId===id);
        if(!found)throw new PortableTransferError("unsupported-capability");return found.identityKey;
      };
      if(domain==="native-transcripts") return {locator,value:{machineIdentityKey:machine(r.machine_id),clientName:r.client_name,formatName:r.format_name,formatVersion:r.format_version,nativeSessionId:r.native_session_id,sourceLocator:r.source_locator,sourceOrdinal:r.source_ordinal,observedAt:r.observed_at,ingestedAt:r.ingested_at,scrubberVersion:r.scrubber_version,contentSha256:r.content_sha256,ingestKey:r.ingest_key,nativePayload:JSON.parse(String(r.native_payload))}};
      if(domain==="native-transcript-checkpoints") return {locator,value:{machineIdentityKey:machine(r.machine_id),clientName:r.client_name,sourceLocator:r.source_locator,revision:r.revision,lastSourceOrdinal:r.last_source_ordinal,importedCount:r.imported_count,skippedCount:r.skipped_count,quarantinedCount:r.quarantined_count,checkpoint:JSON.parse(String(r.checkpoint)),updatedAt:r.updated_at}};
      return {locator,value:{machineIdentityKey:machine(r.machine_id),ingestKey:r.ingest_key,sourceOrdinal:r.source_ordinal,conversationIdentitySha256:String(r.conversation_id),messageIdentitySha256:String(r.message_id)},references:[{field:"conversationIdentitySha256",domain:"conversations",locator:String(r.conversation_id)},{field:"messageIdentitySha256",domain:"messages",locator:String(r.message_id)}]};
    }
    function readRow(domain:PortableDomain,locator:string):SqliteRawDomainRow {
      if(archive&&(PORTABLE_ARCHIVE_DOMAINS as readonly string[]).includes(domain)){
        const row=readArchiveDomainRow(connection,domain as typeof PORTABLE_ARCHIVE_DOMAINS[number],locator);
        if(!row)throw new PortableTransferError("source-changed");return {locator,value:row.value as unknown as Record<string,unknown>};
      }
      if ((domain === "session-instructions" || domain === "passive-events") && locator.startsWith('["sidecar",')) {
        const [,position,rawLocator] = JSON.parse(locator) as [string,number,string];
        const sidecar = sidecars[position];
        if (!sidecar || sidecar.domain !== domain) throw new PortableTransferError("source-changed");
        const row=readSqliteSidecarDomainRow(sidecar.connection,domain,rawLocator,sidecar.identity);
        if(!row)throw new PortableTransferError("source-changed");return {...row,locator};
      }
      if(!(PORTABLE_ARCHIVE_DOMAINS as readonly string[]).includes(domain)){
        const row=readPortableRuntimeRow(connection,domain,locator,options);
        if(!row)throw new PortableTransferError("source-changed");return row;
      }
      if(domain==="project")return {locator,value:{identity}};
      if(domain==="machines"){
        const value=facts!.machines.find(machine=>machine.identityKey===locator);
        if(value)return {locator,value:{...value}};
      } else if(domain==="project-aliases"){
        const value=facts!.aliases.find(alias=>canonicalJson([alias.machineIdentityKey,alias.normalizedPath])===locator);
        if(value)return {locator,value:{...value}};
      } else if(domain!=="passive-events") {
        for(const row of capturedRows(connection,domain as CapturedDomain,sourceLocalProjectId,locator))return decodeCaptured(domain as CapturedDomain,row);
      }
      throw new PortableTransferError("source-changed");
    }
    function* closure(row:SqliteRawDomainRow):Generator<string>{
      const h=header(row);
      yield `["lcm-portable-conversation-closure-v1",{"bootstrappedAt":${canonicalJson(h[2])},"createdAt":${canonicalJson(h[3])},"messages":[`;
      let first=true;
      for(const message of iteratePortableRuntimeRows(connection,"messages",{...options,conversationLocator:row.locator})){
        if(!first)yield ",";first=false;const v=message.value;
        yield canonicalJson([{$integer:String(v.seq)},v.role,v.content,{$integer:String(v.tokenCount)},timestamp(v.createdAt)]);
      }
      yield `],"sessionId":${canonicalJson(h[0])},"title":${canonicalJson(h[1])},"updatedAt":${canonicalJson(h[4])}}]`;
    }
    for(const row of rows("conversations")){
      await cooperate(signal);
      const digest=createHash("sha256");for(const chunk of closure(row)){await cooperate(signal);digest.update(chunk);}
      ordinalIndex.addConversation({locator:row.locator,headerOrder:header(row),closureSha256:digest.digest("hex")});
    }
    await ordinalIndex.finalizeConversations(async(left,right)=>{
      const a=closure(readRow("conversations",left));const b=closure(readRow("conversations",right));
      try {
        for(;;){await cooperate(signal);const x=a.next();const y=b.next();if(x.done||y.done)return x.done===y.done;if(x.value!==y.value)return false;}
      } finally {a.return(undefined);b.return(undefined);}
    });
    function build(domain:PortableDomain,row:SqliteRawDomainRow,ordinal:number):PortableRecord{
      const value={...row.value};
      for(const ref of row.references??[]){const parent=ordinalIndex.lookup(ref.domain,ref.locator);if(!parent)throw new PortableTransferError("invalid-input");value[ref.field]=parent.identitySha256;}
      let context:unknown=null;
      if(["project-aliases","conversations","promoted-memories","recall-surfacings","redaction-counters","session-ingest","session-instructions","native-transcript-checkpoints","passive-events"].includes(domain))context={projectIdentity:identity};
      if(domain==="conversations"){
        const h=header(row);value.conversationFingerprint=canonicalSha256(["lcm-portable-conversation-value-v1",...h]);value.occurrenceOrdinal=ordinalIndex.conversation(row.locator)!.occurrenceOrdinal;
      }
      if(domain==="messages"||domain==="context-items"){
        const parent=ordinalIndex.lookupIdentity("conversations",String(value.conversationIdentitySha256));if(!parent)throw new PortableTransferError("invalid-input");
        context={conversationOrder:parent.order.map(rawOrder) as unknown as PortableRawConversationOrder};
      }
      if(domain==="message-parts"){
        const parent=ordinalIndex.lookupIdentity("messages",String(value.messageIdentitySha256));if(!parent)throw new PortableTransferError("invalid-input");
        context={messageOrder:parent.order.map(rawOrder) as unknown as PortableRawMessageOrder};
      }
      if(domain==="recall-surfacings")value.occurrenceOrdinal=ordinalIndex.allocateOccurrence("recall",canonicalJson([value.memoryId,value.sessionId,timestamp(value.surfacedAt)]));
      if(domain==="native-transcripts"){
        const nativePayload=value.nativePayload;const canonicalPayloadBytes=Buffer.byteLength(canonicalJson(nativePayload));
        const metadata: Record<string, unknown>={...value,sourceOrdinal:{$integer:String(value.sourceOrdinal)},observedAt:timestamp(value.observedAt),ingestedAt:timestamp(value.ingestedAt)};delete metadata.nativePayload;
        context={projectIdentity:identity,canonicalPayloadBytes,canonicalMetadataBytes:Buffer.byteLength(canonicalJson(metadata))};
      }
      return createPortableRecord({domain,ordinal,value,context} as PortableRecordInput);
    }
    const counts = new Map<PortableDomain,number>();
    for(const domain of PORTABLE_RECORD_DOMAIN_ORDER){
      let count=0;
      for(const row of rows(domain)){await cooperate(signal);ordinalIndex.add(row.locator,build(domain,row,0));count++;}
      await cooperate(signal);
      ordinalIndex.finalizeDomain(domain);counts.set(domain,count);
    }
    ordinalIndex.verifyDependencies();
    await guard(signal);
    const sourceIdentitySha256=canonicalSha256(["sqlite-supplied-generation-v1",expectedFileSha256,identity,sourceLocalProjectId,expectedFactsSha256??null,mainMachineIdentityKey,sidecarEvidence]);
    const sourceWitnessSha256=canonicalSha256([sourceIdentitySha256,capturedAt]);
    const description:PortableSourceDescription=Object.freeze({capturedAt:capturedAt,sourceIdentitySha256,sourceWitnessSha256,coverage:Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map(domain=>[domain,{state:"available",evidenceSha256:canonicalSha256([sourceWitnessSha256,domain])}])) as PortableSourceDescription["coverage"]});
    function recordAt(domain:PortableDomain,metadata:NonNullable<ReturnType<typeof ordinalIndex.lookup>>):PortableRecord{
      const row=readRow(domain,metadata.locator);
      if(domain==="recall-surfacings")row.value.occurrenceOrdinal=rawOrder(metadata.order.at(-1)!);
      // Occurrences are assigned once during index construction, then taken from persisted order.
      const record=domain==="recall-surfacings" ? createPortableRecord({domain,ordinal:metadata.ordinal,context:{projectIdentity:identity},value:row.value} as PortableRecordInput) : build(domain,row,metadata.ordinal);
      const expected=ordinalIndex.getScope("source-record-digest",`${domain}:${metadata.ordinal}`);
      if(record.identitySha256!==metadata.identitySha256 || (expected!==null && record.recordSha256!==expected))throw new PortableTransferError("source-changed");
      return record;
    }
    function appendDigest(previous: string, bytes: Uint8Array): string {
      const length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(bytes.byteLength));
      return createHash("sha256").update(Buffer.from(previous,"hex")).update(length).update(bytes).digest("hex");
    }
    // Authenticate each prefix once from actual records, keeping fixed-size evidence
    // on bounded scratch disk. Arbitrary resume checkpoints use this exact index.
    async function boundaryAt(domain: PortableDomain,nextOrdinal: number,signal?: AbortSignal) {
      let prefix=canonicalSha256(["lcm-portable-domain-v1",PORTABLE_RECORD_SCHEMA_SHA256,domain,1]);
      let last: {recordSha256:string;identitySha256:string}|null=null;
      let ordinal=0;
      ordinalIndex.bindScope("source-boundary",`${domain}:0`,canonicalJson({prefix,last}));
      while(ordinal<nextOrdinal){
        const entries=ordinalIndex.entries(domain,{afterOrdinal:ordinal-1,limit:Math.min(500,nextOrdinal-ordinal),maxBytes:PORTABLE_LIMITS.maxBatchBytes,signal});
        if(entries.length===0)throw new PortableTransferError("source-changed");
        for(const entry of entries){
          await cooperate(signal);
          const record=recordAt(domain,entry);prefix=appendDigest(prefix,serializePortableRecord(record));
          last={recordSha256:record.recordSha256,identitySha256:record.identitySha256};ordinal++;
          ordinalIndex.bindScope("source-record-digest",`${domain}:${entry.ordinal}`,record.recordSha256);
          ordinalIndex.bindScope("source-boundary",`${domain}:${ordinal}`,canonicalJson({prefix,last}));
        }
      }
      return {prefix,last};
    }
    const terminals=new Map<PortableDomain,Awaited<ReturnType<typeof boundaryAt>>>();
    let contentSha256=canonicalSha256(["lcm-portable-content-v1",PORTABLE_RECORD_SCHEMA_SHA256]);
    for(const domain of PORTABLE_RECORD_DOMAIN_ORDER){
      const terminal=await boundaryAt(domain,counts.get(domain)!,signal);terminals.set(domain,terminal);
      contentSha256=appendDigest(contentSha256,Buffer.from(terminal.prefix,"hex"));
    }
    if(archive && tableExists(connection,"transfer_runs")){
      const runMeta=connection.prepare("SELECT rowid,length(CAST(manifest_json AS BLOB)) AS manifest_bytes,length(CAST(checkpoints_json AS BLOB)) AS checkpoint_bytes,length(CAST(manifest_json AS BLOB))+length(CAST(checkpoints_json AS BLOB))+length(CAST(project_json AS BLOB))+length(CAST(generation_sha AS BLOB))+length(CAST(manifest_sha AS BLOB)) AS bytes FROM transfer_runs LIMIT 2").all();
      if(runMeta.length!==1 || BigInt(runMeta[0].manifest_bytes as number)>BigInt(PORTABLE_LIMITS.maxControlBytes)
        || BigInt(runMeta[0].checkpoint_bytes as number)>BigInt(PORTABLE_LIMITS.maxControlBytes)
        || BigInt(runMeta[0].bytes as number)>BigInt(3*PORTABLE_LIMITS.maxControlBytes))throw new PortableTransferError("verification-failed");
      const controlColumns=["generation_sha","manifest_sha","manifest_json","checkpoints_json","project_json","schema_ready"];
      const run=decodeSqliteUtf8Row(connection.prepare(`SELECT ${sqliteUtf8Projection(controlColumns)} FROM transfer_runs WHERE rowid=?`).get(runMeta[0].rowid)!,controlColumns);
      const expected=parsePortableManifest(Buffer.from(String(run.manifest_json)));
      const encodedCheckpoints:unknown=JSON.parse(String(run.checkpoints_json));
      if(run.schema_ready!==1 || run.manifest_sha!==expected.manifestSha256 || run.project_json!==canonicalJson(identity)
        || !Array.isArray(encodedCheckpoints) || encodedCheckpoints.length!==22)throw new PortableTransferError("verification-failed");
      for(const [position,encoded] of encodedCheckpoints.entries()){
        await cooperate(signal);
        if(typeof encoded!=="string")throw new PortableTransferError("verification-failed");
        const checkpoint=verifyPortableCheckpoint(parsePortableCheckpoint(Buffer.from(encoded)),expected);
        if(!checkpoint.complete || checkpoint.domain!==PORTABLE_RECORD_DOMAIN_ORDER[position]
          || connection.prepare("SELECT 1 FROM transfer_batches WHERE run_sha=? AND result_sha=? AND domain=? AND checkpoint_json=?").get(run.generation_sha,checkpoint.checkpointSha256,checkpoint.domain,encoded)===undefined)throw new PortableTransferError("verification-failed");
      }
      if(expected.contentSha256!==contentSha256 || expected.domains.some(domain=>domain.recordCount!==counts.get(domain.domain) || domain.prefixSha256!==terminals.get(domain.domain)!.prefix))throw new PortableTransferError("verification-failed");
    }
    await guard(signal,true);
    let queue: Promise<unknown> = Promise.resolve();
    let closing = false;
    let closePromise: Promise<void> | undefined;
    function enqueue<T>(operation: () => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new PortableTransferError("source-failed"));
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    }
    const recoveryArchive = createSqlitePortableArchiveReader(connection, async signal => {
      await guard(signal);
    });
    const source:SqlitePortableRecordSource={
      get recoveryArchive(){guardSync();if(!archive)throw new PortableTransferError("unsupported-capability");return recoveryArchive;},
      describeSource(){guardSync();return description;},
      readDomainPage(page:PortableSourcePageInput){return enqueue(async () => {
        await guard(page.signal);
        if(!PORTABLE_RECORD_DOMAIN_ORDER.includes(page.domain)||!Number.isSafeInteger(page.afterOrdinal)||page.afterOrdinal<0||Object.is(page.afterOrdinal,-0)||page.afterOrdinal>counts.get(page.domain)!||typeof page.includePredecessor!=="boolean"||page.maxRecords!==500||page.maxBytes!==PORTABLE_LIMITS.maxBatchBytes)throw new PortableTransferError("invalid-input");
        try {
          const metadata=ordinalIndex.entries(page.domain,{afterOrdinal:page.afterOrdinal-1,limit:500,maxBytes:PORTABLE_LIMITS.maxBatchBytes,signal:page.signal});
          const records:PortableRecord[]=[];let bytes=0;let byteLimited=false;
          for(const entry of metadata){await cooperate(page.signal);const record=recordAt(page.domain,entry);const length=serializePortableRecord(record).byteLength+8;if(bytes+length>page.maxBytes){byteLimited=true;break;}records.push(record);bytes+=length;}
          let predecessor:PortableRecord|null=null;
          if(page.includePredecessor&&page.afterOrdinal>0){const previous=ordinalIndex.entries(page.domain,{afterOrdinal:page.afterOrdinal-2,limit:1,maxBytes:PORTABLE_LIMITS.maxBatchBytes,signal:page.signal})[0];if(!previous||previous.ordinal!==page.afterOrdinal-1)throw new PortableTransferError("source-changed");predecessor=recordAt(page.domain,previous);}
          const after=records.at(-1)?.ordinal??page.afterOrdinal-1;
          const complete=!byteLimited&&ordinalIndex.entries(page.domain,{afterOrdinal:after,limit:1,maxBytes:PORTABLE_LIMITS.maxBatchBytes,signal:page.signal}).length===0;
          await guard(page.signal);return {predecessor,records,complete};
        }catch(error){throw normalizePortableTransferError(error,"source-failed");}
      });},
      async verifySource(verification){
        try{return await enqueue(async () => {
          // The stream supplies contentSha256 on every batch, so only the final
          // domain boundary forces another complete file hash. Close also hashes.
          await guard(verification.signal,verification.boundary?.domain === "passive-events"
            && verification.boundary.nextOrdinal === counts.get("passive-events"));
          if(verification.sourceIdentitySha256!==sourceIdentitySha256 || verification.sourceWitnessSha256!==sourceWitnessSha256
            || (verification.contentSha256!==undefined && verification.contentSha256!==contentSha256))return "changed" as const;
          if(verification.boundary!==undefined){
            const boundary=verification.boundary;const count=counts.get(boundary.domain);
            if(count===undefined || !Number.isSafeInteger(boundary.nextOrdinal) || boundary.nextOrdinal<0 || Object.is(boundary.nextOrdinal,-0)
              || Object.is(boundary.recordCount,-0) || boundary.recordCount!==boundary.nextOrdinal || boundary.nextOrdinal>count)return "invalid" as const;
            const cached=ordinalIndex.getScope("source-boundary",`${boundary.domain}:${boundary.nextOrdinal}`);
            if(cached===null)throw new PortableTransferError("source-changed");
            const actual=JSON.parse(cached) as Awaited<ReturnType<typeof boundaryAt>>;
            if(actual.prefix!==boundary.prefixSha256 || (actual.last?.recordSha256??null)!==boundary.lastRecordSha256
              || (actual.last?.identitySha256??null)!==boundary.lastRecordIdentitySha256)return "changed" as const;
          }
          await guard(verification.signal);return "unchanged" as const;
        });}catch(error){if ((error instanceof PortableTransferError) && error.code === "aborted")throw error;return "changed";}
      },
      close(){
        if(closePromise)return closePromise.catch(() => {});
        closing=true;
        closePromise=queue.then(async () => {
          let verificationError:unknown;
          try{if(authorities.get(token)!.active)await guard(undefined,true);}catch(error){verificationError=error;}
          revoke();let failed=false;
          try{ordinalIndex.close();}catch{failed=true;}
          for(const handle of [connection,...sidecars.map(item=>item.connection)]){
            try{handle.exec("ROLLBACK");}catch{failed=true;}
            try{handle.close();}catch{failed=true;}
          }
          db=undefined;
          if(verificationError!==undefined)throw verificationError;
          if(failed)throw new PortableTransferError("close-failed");
        });
        // Cleanup is attempted exactly once, including after a reported close failure.
        return closePromise;
      },
    };
    return Object.freeze(source);
  }catch(error){revoke();for(const item of tokens)authorities.delete(item);for(const sidecar of sidecars){try{sidecar.connection.close();}catch{/* Preserve primary failure. */}}try{index?.close();}catch{/* Preserve primary failure. */}try{db?.close();}catch{/* Preserve primary failure. */}throw normalizePortableTransferError(error,"source-failed");}
}
function rawOrder(value:unknown):unknown {return typeof value==="object"&&value!==null&&"$integer"in value?(value as {$integer:string}).$integer:value;}
