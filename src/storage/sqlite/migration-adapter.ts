import { chmodSync, closeSync, constants, existsSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../db/migration.js";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../../security-files.js";
import {
  CanonicalRowDigest,
  canonicalJson,
  fingerprintMigrationFileSync,
  sameMigrationFingerprint,
  sha256Canonical,
  type CanonicalScalar,
  type CanonicalValue,
  type MigrationFileFingerprint,
  type MigrationSourceFingerprint,
} from "../migration-manifest.js";

export type MigrationRow = Readonly<Record<string, CanonicalValue>>;
export interface MigrationTableInventory { readonly table: string; readonly rows: number; readonly sha256: string }
export interface SqliteSnapshotResult {
  readonly pages: number;
  readonly sourceFingerprint: MigrationSourceFingerprint;
  readonly snapshotFingerprint: MigrationFileFingerprint;
  readonly tables: readonly MigrationTableInventory[];
}
export interface SqliteMigrationSnapshotOptions {
  /** @internal Deterministic concurrent-writer seam for migration protocol tests. */
  readonly _afterBackupForTesting?: () => void;
}

type RawRow = Record<string, unknown>;
type TableDescriptor = { readonly name: string; readonly select: string; readonly orderBy: string; readonly normalize: (row: RawRow) => MigrationRow };

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${field} is not valid text`);
  return value;
}

function nullableText(value: unknown, field: string): string | null { return value === null ? null : text(value, field); }

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field} is not a safe integer`);
  return value;
}

function nullableInteger(value: unknown, field: string): number | null { return value === null ? null : integer(value, field); }

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} is not finite`);
  return value;
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null) return null;
  if (value === 0) return false;
  if (value === 1) return true;
  throw new Error(`${field} is not a SQLite boolean`);
}

function timestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  const raw = text(value, field);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} is not a valid timestamp`);
  return parsed.toISOString();
}

function json(value: unknown, field: string): CanonicalValue {
  const parsed = JSON.parse(text(value, field)) as unknown;
  return JSON.parse(canonicalJson(parsed)) as CanonicalValue;
}

function baseRow(row: RawRow): MigrationRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return [key, value];
    if (typeof value === "number" && Number.isFinite(value)) return [key, value];
    throw new Error(`${key} has an unsupported SQLite migration value`);
  })) as MigrationRow;
}

const MESSAGE_PART_COLUMNS = `part_id, message_id, session_id, part_type, ordinal, text_content,
  is_ignored, is_synthetic, tool_call_id, tool_name, tool_status, tool_input,
  tool_output, tool_error, tool_title, patch_hash, patch_files, file_mime,
  file_name, file_url, subtask_prompt, subtask_desc, subtask_agent, step_reason,
  step_cost, step_tokens_in, step_tokens_out, snapshot_hash, compaction_auto, metadata`.replaceAll(/\s+/gu, " ");

export const SQLITE_MIGRATION_TABLES: readonly TableDescriptor[] = [
  { name: "conversations", select: "conversation_id, session_id, title, bootstrapped_at, created_at, updated_at", orderBy: "conversation_id", normalize: (row) => ({ conversation_id: integer(row.conversation_id, "conversation_id"), session_id: text(row.session_id, "session_id"), title: nullableText(row.title, "title"), bootstrapped_at: timestamp(row.bootstrapped_at, "bootstrapped_at"), created_at: timestamp(row.created_at, "created_at")!, updated_at: timestamp(row.updated_at, "updated_at")! }) },
  { name: "messages", select: "message_id, conversation_id, seq, role, content, token_count, created_at", orderBy: "message_id", normalize: (row) => ({ message_id: integer(row.message_id, "message_id"), conversation_id: integer(row.conversation_id, "conversation_id"), seq: integer(row.seq, "seq"), role: text(row.role, "role"), content: text(row.content, "content"), token_count: integer(row.token_count, "token_count"), created_at: timestamp(row.created_at, "created_at")! }) },
  { name: "message_parts", select: MESSAGE_PART_COLUMNS, orderBy: "part_id", normalize: (row) => ({
    part_id: text(row.part_id, "part_id"), message_id: integer(row.message_id, "message_id"), session_id: text(row.session_id, "session_id"), part_type: text(row.part_type, "part_type"), ordinal: integer(row.ordinal, "ordinal"), text_content: nullableText(row.text_content, "text_content"), is_ignored: nullableBoolean(row.is_ignored, "is_ignored"), is_synthetic: nullableBoolean(row.is_synthetic, "is_synthetic"), tool_call_id: nullableText(row.tool_call_id, "tool_call_id"), tool_name: nullableText(row.tool_name, "tool_name"), tool_status: nullableText(row.tool_status, "tool_status"), tool_input: nullableText(row.tool_input, "tool_input"), tool_output: nullableText(row.tool_output, "tool_output"), tool_error: nullableText(row.tool_error, "tool_error"), tool_title: nullableText(row.tool_title, "tool_title"), patch_hash: nullableText(row.patch_hash, "patch_hash"), patch_files: nullableText(row.patch_files, "patch_files"), file_mime: nullableText(row.file_mime, "file_mime"), file_name: nullableText(row.file_name, "file_name"), file_url: nullableText(row.file_url, "file_url"), subtask_prompt: nullableText(row.subtask_prompt, "subtask_prompt"), subtask_desc: nullableText(row.subtask_desc, "subtask_desc"), subtask_agent: nullableText(row.subtask_agent, "subtask_agent"), step_reason: nullableText(row.step_reason, "step_reason"), step_cost: row.step_cost === null ? null : finite(row.step_cost, "step_cost"), step_tokens_in: nullableInteger(row.step_tokens_in, "step_tokens_in"), step_tokens_out: nullableInteger(row.step_tokens_out, "step_tokens_out"), snapshot_hash: nullableText(row.snapshot_hash, "snapshot_hash"), compaction_auto: nullableBoolean(row.compaction_auto, "compaction_auto"), metadata: nullableText(row.metadata, "metadata"),
  }) },
  { name: "summaries", select: "summary_id, conversation_id, kind, depth, content, token_count, earliest_at, latest_at, descendant_count, descendant_token_count, source_message_token_count, created_at", orderBy: "summary_id", normalize: (row) => ({ summary_id: text(row.summary_id, "summary_id"), conversation_id: integer(row.conversation_id, "conversation_id"), kind: text(row.kind, "kind"), depth: integer(row.depth, "depth"), content: text(row.content, "content"), token_count: integer(row.token_count, "token_count"), earliest_at: timestamp(row.earliest_at, "earliest_at"), latest_at: timestamp(row.latest_at, "latest_at"), descendant_count: integer(row.descendant_count, "descendant_count"), descendant_token_count: integer(row.descendant_token_count, "descendant_token_count"), source_message_token_count: integer(row.source_message_token_count, "source_message_token_count"), created_at: timestamp(row.created_at, "created_at")! }) },
  { name: "summary_messages", select: "summary_id, message_id, ordinal", orderBy: "summary_id, ordinal, message_id", normalize: baseRow },
  { name: "summary_parents", select: "summary_id, parent_summary_id, ordinal", orderBy: "summary_id, ordinal, parent_summary_id", normalize: baseRow },
  { name: "context_items", select: "conversation_id, ordinal, item_type, message_id, summary_id, created_at", orderBy: "conversation_id, ordinal", normalize: (row) => ({ conversation_id: integer(row.conversation_id, "conversation_id"), ordinal: integer(row.ordinal, "ordinal"), item_type: text(row.item_type, "item_type"), message_id: nullableInteger(row.message_id, "message_id"), summary_id: nullableText(row.summary_id, "summary_id"), created_at: timestamp(row.created_at, "created_at")! }) },
  { name: "large_files", select: "file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at", orderBy: "file_id", normalize: (row) => ({ file_id: text(row.file_id, "file_id"), conversation_id: integer(row.conversation_id, "conversation_id"), file_name: nullableText(row.file_name, "file_name"), mime_type: nullableText(row.mime_type, "mime_type"), byte_size: nullableInteger(row.byte_size, "byte_size"), storage_uri: text(row.storage_uri, "storage_uri"), exploration_summary: nullableText(row.exploration_summary, "exploration_summary"), created_at: timestamp(row.created_at, "created_at")! }) },
  { name: "summary_large_files", select: "summary_id, file_ids", orderBy: "summary_id", normalize: (row) => ({ summary_id: text(row.summary_id, "summary_id"), file_ids: json(row.file_ids, "file_ids") }) },
  { name: "promoted_memories", select: "id, content, metadata, source_summary_id, project_id, session_id, depth, confidence, created_at, archived_at", orderBy: "id", normalize: (row) => ({ memory_id: text(row.id, "id"), content: text(row.content, "content"), metadata: json(row.metadata, "metadata"), source_summary_id: nullableText(row.source_summary_id, "source_summary_id"), source_project_id: text(row.project_id, "project_id"), session_id: nullableText(row.session_id, "session_id"), depth: integer(row.depth, "depth"), confidence: finite(row.confidence, "confidence"), created_at: timestamp(row.created_at, "created_at")!, archived_at: timestamp(row.archived_at, "archived_at") }) },
  { name: "promoted_memory_tags", select: "id, tags", orderBy: "id", normalize: (row) => ({ memory_id: text(row.id, "id"), tags: json(row.tags, "tags") }) },
  { name: "recall_surfacing", select: "id, memory_id, session_id, surfaced_at", orderBy: "id", normalize: (row) => ({ surfacing_id: integer(row.id, "id"), memory_id: text(row.memory_id, "memory_id"), session_id: nullableText(row.session_id, "session_id"), surfaced_at: timestamp(row.surfaced_at, "surfaced_at")! }) },
  { name: "redaction_counters", select: "project_id, category, count", orderBy: "project_id, category", normalize: baseRow },
  { name: "session_ingest_log", select: "session_id, message_count, completed_at", orderBy: "session_id", normalize: (row) => ({ session_id: text(row.session_id, "session_id"), message_count: integer(row.message_count, "message_count"), completed_at: timestamp(row.completed_at, "completed_at")! }) },
  { name: "session_instructions", select: "project_id, scope_hash, client_name, session_id, worktree_path, cwd_path, content, content_hash, updated_at", orderBy: "project_id, scope_hash", normalize: (row) => ({ project_id: text(row.project_id, "project_id"), scope_hash: text(row.scope_hash, "scope_hash"), client_name: text(row.client_name, "client_name"), session_id: text(row.session_id, "session_id"), worktree_path: text(row.worktree_path, "worktree_path"), cwd_path: text(row.cwd_path, "cwd_path"), content: text(row.content, "content"), content_hash: text(row.content_hash, "content_hash"), updated_at: timestamp(row.updated_at, "updated_at")! }) },
] as const;

export const SQLITE_MIGRATION_SCHEMA_MANIFEST_SHA256 = sha256Canonical(SQLITE_MIGRATION_TABLES.map(({ name, select, orderBy }) => ({ name, select, orderBy })));

function descriptor(name: string): TableDescriptor {
  const found = SQLITE_MIGRATION_TABLES.find((entry) => entry.name === name);
  if (!found) throw new Error(`unknown migration table: ${name}`);
  return found;
}

function sourceTable(name: string): string {
  if (name === "session_instructions") return "session_instruction_cache";
  if (name === "redaction_counters") return "redaction_stats";
  if (name === "promoted_memories" || name === "promoted_memory_tags") return "promoted";
  if (name === "summary_large_files") return "summaries";
  return name;
}

function sqliteSchemaSha256(db: DatabaseSync): string {
  return sha256Canonical(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all());
}

function assertSqliteIntegrity(db: DatabaseSync): void {
  const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: unknown }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("SQLite integrity verification failed");
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new Error("SQLite foreign-key verification failed");
}

function optionalFingerprint(path: string): MigrationFileFingerprint | null {
  return existsSync(path) ? fingerprintMigrationFileSync(path, dirname(path)) : null;
}

function assertSourceUnchanged(
  beforeMain: MigrationFileFingerprint,
  beforeWal: MigrationFileFingerprint | null,
  afterMain: MigrationFileFingerprint,
  afterWal: MigrationFileFingerprint | null,
): void {
  if (!sameMigrationFingerprint(beforeMain, afterMain) || !sameMigrationFingerprint(beforeWal, afterWal)) throw new Error("SQLite source changed during backup");
}

function openExclusiveFile(path: string, collisionMessage: string): number {
  try { return openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, PRIVATE_FILE_MODE); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(collisionMessage, { cause: error });
    throw error;
  }
}

function reserveDestination(path: string): void {
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) throw new Error("migration generation directory must use mode 0700");
  const fd = openExclusiveFile(path, "migration backup destination already exists");
  closeSync(fd);
  unlinkSync(path);
}

export async function createSqliteMigrationSnapshot(sourcePath: string, destinationPath: string, options: SqliteMigrationSnapshotOptions = {}): Promise<SqliteSnapshotResult> {
  reserveDestination(destinationPath);
  const beforeMain = fingerprintMigrationFileSync(sourcePath, dirname(sourcePath));
  const beforeWal = optionalFingerprint(`${sourcePath}-wal`);
  const source = new DatabaseSync(sourcePath, { readOnly: true, readBigInts: false, timeout: 5_000 });
  let pages: number;
  try { pages = await backup(source, destinationPath); } finally { source.close(); }
  options._afterBackupForTesting?.();
  chmodSync(destinationPath, PRIVATE_FILE_MODE);
  const destination = lstatSync(destinationPath);
  if (!destination.isFile() || destination.nlink !== 1) throw new Error("SQLite backup destination is not a private single-link file");
  const afterMain = fingerprintMigrationFileSync(sourcePath, dirname(sourcePath));
  const afterWal = optionalFingerprint(`${sourcePath}-wal`);
  assertSourceUnchanged(beforeMain, beforeWal, afterMain, afterWal);
  const snapshot = new DatabaseSync(destinationPath, { timeout: 5_000 });
  let schemaSha256: string;
  try { runLcmMigrations(snapshot); assertSqliteIntegrity(snapshot); schemaSha256 = sqliteSchemaSha256(snapshot); } finally { snapshot.close(); }
  const reader = new SqliteMigrationReader(destinationPath);
  let tables: MigrationTableInventory[];
  try { tables = reader.inventory(); } finally { reader.close(); }
  return { pages, sourceFingerprint: { main: beforeMain, wal: beforeWal, schemaSha256 }, snapshotFingerprint: fingerprintMigrationFileSync(destinationPath, dirname(destinationPath)), tables };
}

export class SqliteMigrationReader {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(readonly path: string) { this.db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 }); }

  inventory(): MigrationTableInventory[] {
    this.assertOpen();
    return SQLITE_MIGRATION_TABLES.map(({ name }) => {
      const digest = new CanonicalRowDigest();
      for (const row of this.iterate(name)) digest.update(row);
      return { table: name, ...digest.digest() };
    });
  }

  readBatch(table: string, offset: number, limit: number): MigrationRow[] {
    this.assertOpen();
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be non-negative");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("limit must be positive");
    const entry = descriptor(table);
    const rows = this.db.prepare(`SELECT ${entry.select} FROM ${sourceTable(entry.name)} ORDER BY ${entry.orderBy} LIMIT ? OFFSET ?`).all(limit, offset) as RawRow[];
    return rows.map((row) => entry.normalize(row));
  }

  *iterate(table: string): IterableIterator<MigrationRow> {
    this.assertOpen();
    const entry = descriptor(table);
    const statement = this.db.prepare(`SELECT ${entry.select} FROM ${sourceTable(entry.name)} ORDER BY ${entry.orderBy}`);
    for (const row of statement.iterate() as IterableIterator<RawRow>) yield entry.normalize(row);
  }

  sample(table: string, count: number): MigrationRow[] { return this.readBatch(table, 0, count); }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
  private assertOpen(): void { if (this.closed) throw new Error("SQLite migration reader is closed"); }
}

function sqliteValue(value: CanonicalValue): string | number | null {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return canonicalJson(value);
}

export class SqliteMigrationWriter {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(readonly path: string) {
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) throw new Error("reverse SQLite directory must use mode 0700");
    const fd = openExclusiveFile(path, "reverse SQLite destination already exists");
    closeSync(fd);
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    runLcmMigrations(this.db);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  writeBatch(table: string, rows: readonly MigrationRow[]): void {
    this.assertOpen();
    if (rows.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try { for (const row of rows) this.insertRow(table, row); this.db.exec("COMMIT"); }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* preserve original */ } throw error; }
  }

  verify(): MigrationTableInventory[] {
    this.assertOpen();
    assertSqliteIntegrity(this.db);
    const reader = new SqliteMigrationReader(this.path);
    try { return reader.inventory(); } finally { reader.close(); }
  }

  checkpointAndClose(): void {
    if (this.closed) return;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assertSqliteIntegrity(this.db);
    this.closed = true;
    this.db.close();
    chmodSync(this.path, PRIVATE_FILE_MODE);
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }

  private insertRow(table: string, row: MigrationRow): void {
    if (table === "summary_large_files") { this.db.prepare("UPDATE summaries SET file_ids = ? WHERE summary_id = ?").run(sqliteValue(row.file_ids!), sqliteValue(row.summary_id!)); return; }
    if (table === "promoted_memory_tags") { this.db.prepare("UPDATE promoted SET tags = ? WHERE id = ?").run(sqliteValue(row.tags!), sqliteValue(row.memory_id!)); return; }
    const mappings: Readonly<Record<string, { readonly target: string; readonly columns?: readonly string[] }>> = {
      conversations: { target: "conversations" }, messages: { target: "messages" }, message_parts: { target: "message_parts" }, summaries: { target: "summaries" }, summary_messages: { target: "summary_messages" }, summary_parents: { target: "summary_parents" }, context_items: { target: "context_items" }, large_files: { target: "large_files" },
      promoted_memories: { target: "promoted", columns: ["id", "content", "metadata", "source_summary_id", "project_id", "session_id", "depth", "confidence", "created_at", "archived_at"] },
      recall_surfacing: { target: "recall_surfacing", columns: ["id", "memory_id", "session_id", "surfaced_at"] }, redaction_counters: { target: "redaction_stats" }, session_ingest_log: { target: "session_ingest_log" },
      session_instructions: { target: "session_instruction_cache", columns: ["project_id", "scope_hash", "client_name", "session_id", "worktree_path", "cwd_path", "content", "content_hash", "updated_at"] },
    };
    const mapping = mappings[table];
    if (!mapping) throw new Error(`unsupported reverse SQLite table: ${table}`);
    const sourceColumns = Object.keys(row);
    const columns = mapping.columns ?? sourceColumns;
    if (columns.length !== sourceColumns.length) throw new Error(`invalid column mapping for ${table}`);
    this.db.prepare(`INSERT INTO ${mapping.target} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...sourceColumns.map((column) => sqliteValue(row[column]!)));
  }

  private assertOpen(): void { if (this.closed) throw new Error("SQLite migration writer is closed"); }
}

export function lastCanonicalKey(row: MigrationRow): readonly CanonicalScalar[] {
  const last = Object.values(row).at(-1);
  if (last === null || typeof last === "string" || typeof last === "number" || typeof last === "boolean" || (typeof last === "object" && !Array.isArray(last) && "$integer" in last)) return [last as CanonicalScalar];
  return [sha256Canonical(last)];
}

export const SQLITE_MIGRATION_TEST_SEAMS = {
  assertSourceUnchanged,
  assertSqliteIntegrity,
  baseRow,
  descriptor,
  finite,
  integer,
  json,
  nullableBoolean,
  nullableInteger,
  nullableText,
  openExclusiveFile,
  reserveDestination,
  sourceTable,
  sqliteValue,
  text,
  timestamp,
} as const;
