import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runLcmMigrations } from "./db/migration.js";
import { getLcmDbFeatures } from "./db/features.js";
import {
  closeLcmConnection,
  getExistingLcmConnection,
  getLcmConnection,
} from "./db/connection.js";
import { resolveGitProjectAnchor } from "./git-project.js";
import {
  foldProjectMapEntriesLocked,
  hashProjectPath,
  listProjectMapEntries,
  readProjectMapSnapshot,
  type ProjectIdentity,
  type ProjectMapEntry,
  withProjectMapReconciliationLock,
} from "./project-map.js";
import { lcmHomeDir, projectsDir } from "./runtime-paths.js";
import {
  atomicWritePrivateFile,
  atomicWritePrivateFileExclusive,
  ensurePrivateDirectory,
  readBoundedRegularFile,
} from "./security-files.js";
import {
  PrivateMutationLockContentionError,
  withPrivateMutationLock,
} from "./private-mutation-lock.js";
import { historicalWorktreeEntriesForProject } from "./codex-project-resolution.js";

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_PATTERN_BYTES = 1024 * 1024;
const RECONCILIATION_VERSION = 1;
const HASH_RE = /^[a-f0-9]{64}$/u;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_DISCOVERY_ENTRIES = 50_000;
const SOURCE_FENCE_VERSION = 1;
const reconciledThisProcess = new Map<string, string>();

type SqlRow = Record<string, SQLInputValue>;

export type WorktreeReconciliationSource = {
  readonly hash: string;
  readonly projectDir: string;
  readonly eventsPath: string;
};

export type WorktreeReconciliationStatus =
  | "not-needed"
  | "planned"
  | "completed"
  | "blocked";

export type WorktreeReconciliationResult = {
  readonly status: WorktreeReconciliationStatus;
  readonly targetHash: string;
  readonly canonical: string;
  readonly sourceHashes: string[];
  readonly aliases: string[];
  readonly journalPath?: string;
  readonly backupPaths: string[];
  readonly reason?: string;
};

export type ReconciliationJournal = {
  readonly version: 1;
  readonly targetHash: string;
  readonly canonical: string;
  sourceHashes: string[];
  pendingSourceHashes?: string[];
  aliases: string[];
  remoteProjectId?: string;
  readonly createdAt: string;
  updatedAt: string;
  archiveAt?: string;
  phase: "planned" | "merged" | "archived" | "completed" | "blocked";
  blockedFrom?: "planned" | "merged" | "archived";
  backupPaths: string[];
  discovery?: ReconciliationDiscovery;
  sourceComponents?: Record<string, SourceComponentSnapshot>;
  reason?: string;
};

type ReconciliationDiscovery = {
  readonly mapFingerprint: string;
  readonly codexFingerprint: string;
  readonly complete: boolean;
};

type CodexCatalogueObservation = {
  readonly fingerprint: string;
  readonly complete: boolean;
};

type SourceComponentSnapshot = {
  readonly projectDb: boolean;
  readonly eventsDb: boolean;
  readonly patterns: boolean;
  readonly patternsDigest?: string;
};

type HistoricalEntriesResolver = typeof historicalWorktreeEntriesForProject;

function reconciliationDir(homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "reconciliations");
}

function journalPath(targetHash: string, homeDir?: string): string {
  return join(reconciliationDir(homeDir), `${targetHash}.json`);
}

function reconciliationLockPath(targetHash: string, homeDir?: string): string {
  return join(reconciliationDir(homeDir), `${targetHash}.lock`);
}

function projectStateDir(hash: string, homeDir?: string): string {
  return join(projectsDir(homeDir), hash);
}

function projectEventsPath(hash: string, homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "events", `${hash}.db`);
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`refusing to reconcile symlink: ${path}`);
    return stat.isFile();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function readJournal(path: string): ReconciliationJournal | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readBoundedRegularFile(path, {
    allowedRoot: dirname(path),
    maxBytes: MAX_JOURNAL_BYTES,
  })) as Partial<ReconciliationJournal>;
  if (
    value.version !== RECONCILIATION_VERSION
    || typeof value.targetHash !== "string"
    || !HASH_RE.test(value.targetHash)
    || basename(path) !== `${value.targetHash}.json`
    || typeof value.canonical !== "string"
    || !isAbsolute(value.canonical)
    || !Array.isArray(value.sourceHashes)
    || !value.sourceHashes.every((hash) => typeof hash === "string" && HASH_RE.test(hash))
    || new Set(value.sourceHashes).size !== value.sourceHashes.length
    || value.sourceHashes.includes(value.targetHash)
    || (
      value.pendingSourceHashes !== undefined
      && (
        !Array.isArray(value.pendingSourceHashes)
        || !value.pendingSourceHashes.every(
          (hash) => typeof hash === "string"
            && HASH_RE.test(hash)
            && value.sourceHashes?.includes(hash),
        )
        || new Set(value.pendingSourceHashes).size !== value.pendingSourceHashes.length
      )
    )
    || !Array.isArray(value.aliases)
    || !value.aliases.every((alias) => typeof alias === "string" && isAbsolute(alias))
    || !Array.isArray(value.backupPaths)
    || !value.backupPaths.every((backup) => typeof backup === "string" && isAbsolute(backup))
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
    || (value.archiveAt !== undefined && typeof value.archiveAt !== "string")
    || (
      value.blockedFrom !== undefined
      && !["planned", "merged", "archived"].includes(value.blockedFrom)
    )
    || (value.remoteProjectId !== undefined
      && (typeof value.remoteProjectId !== "string" || !UUID_V7_RE.test(value.remoteProjectId)))
    || (value.reason !== undefined && typeof value.reason !== "string")
    || (
      value.discovery !== undefined
      && (
        typeof value.discovery !== "object"
        || value.discovery === null
        || !HASH_RE.test((value.discovery as Partial<ReconciliationDiscovery>).mapFingerprint ?? "")
        || !HASH_RE.test((value.discovery as Partial<ReconciliationDiscovery>).codexFingerprint ?? "")
        || typeof (value.discovery as Partial<ReconciliationDiscovery>).complete !== "boolean"
      )
    )
    || (
      value.sourceComponents !== undefined
      && (
        typeof value.sourceComponents !== "object"
        || value.sourceComponents === null
        || Object.entries(value.sourceComponents).some(([hash, component]) => (
          !HASH_RE.test(hash)
          || !value.sourceHashes?.includes(hash)
          || typeof component !== "object"
          || component === null
          || typeof (component as Partial<SourceComponentSnapshot>).projectDb !== "boolean"
          || typeof (component as Partial<SourceComponentSnapshot>).eventsDb !== "boolean"
          || typeof (component as Partial<SourceComponentSnapshot>).patterns !== "boolean"
          || (
            (component as Partial<SourceComponentSnapshot>).patternsDigest !== undefined
            && !HASH_RE.test(
              (component as Partial<SourceComponentSnapshot>).patternsDigest ?? "",
            )
          )
        ))
      )
    )
    || !["planned", "merged", "archived", "completed", "blocked"].includes(value.phase ?? "")
  ) {
    throw new Error(`worktree reconciliation journal is malformed: ${path}`);
  }
  return value as ReconciliationJournal;
}

function writeJournal(path: string, journal: ReconciliationJournal): void {
  journal.updatedAt = new Date().toISOString();
  atomicWritePrivateFile(path, `${JSON.stringify(journal, null, 2)}\n`);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mappedPathObservation(path: string): readonly string[] {
  const normalized = resolve(path);
  try {
    const stat = lstatSync(normalized);
    if (stat.isSymbolicLink()) return [normalized, "symlink"];
    if (!stat.isDirectory()) return [normalized, "non-directory"];
    const anchor = resolveGitProjectAnchor(normalized);
    return anchor
      ? [normalized, "git", anchor.commonDir, anchor.canonical]
      : [normalized, "directory"];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [normalized, "missing"];
    }
    throw error;
  }
}

function mapFingerprint(map: Record<string, ProjectMapEntry>): string {
  return fingerprint(
    Object.entries(map)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([hash, entry]) => [
        hash,
        resolve(entry.canonical),
        [...entry.aliases].map((alias) => resolve(alias)).sort(),
        entry.remoteProjectId ?? null,
        [entry.canonical, ...entry.aliases]
          .map(mappedPathObservation)
          .sort(([left], [right]) => left.localeCompare(right)),
      ]),
  );
}

/**
 * Fingerprint only Codex's directory catalogue. This deliberately avoids
 * opening or parsing transcript JSONL on the hook hot path while still
 * invalidating when a managed-worktree tombstone or transcript leaf appears.
 */
function codexCatalogueFingerprint(
  codexDir?: string,
  maxEntries = MAX_DISCOVERY_ENTRIES,
  observer?: (path: string) => void,
): CodexCatalogueObservation {
  const root = resolve(codexDir ?? join(homedir(), ".codex"));
  const catalogue: Array<readonly [string, string, number, number]> = [];
  let visited = 0;
  const visit = (path: string, relative: string, depth: number): void => {
    if (visited >= maxEntries) return;
    let stat: ReturnType<typeof lstatSync>;
    try {
      observer?.(path);
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    visited += 1;
    const type = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file";
    catalogue.push([relative, type, stat.mtimeMs, stat.size]);
    if (type !== "dir" || depth === 0) return;
    for (const entry of readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      // Transcript files are deliberately excluded: appending JSONL must not
      // invalidate the reconciliation fast path. Directory metadata still
      // detects new session leaves and managed-worktree tombstones.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      visit(join(path, entry.name), join(relative, entry.name), depth - 1);
      if (visited >= maxEntries) break;
    }
  };
  visit(join(root, "worktrees"), "worktrees", 3);
  visit(join(root, "sessions"), "sessions", 5);
  visit(join(root, "archived_sessions"), "archived_sessions", 2);
  const complete = visited < maxEntries;
  return {
    fingerprint: fingerprint({ catalogue, complete }),
    complete,
  };
}

function reconciliationDiscovery(
  map: Record<string, ProjectMapEntry>,
  codexDir?: string,
  maxEntries?: number,
  observer?: (path: string) => void,
): ReconciliationDiscovery {
  const codex = codexCatalogueFingerprint(codexDir, maxEntries, observer);
  return {
    mapFingerprint: mapFingerprint(map),
    codexFingerprint: codex.fingerprint,
    complete: codex.complete,
  };
}

function discoveriesEqual(
  left: ReconciliationDiscovery | undefined,
  right: ReconciliationDiscovery,
): boolean {
  return left?.complete === true
    && right.complete
    && left.mapFingerprint === right.mapFingerprint
    && left.codexFingerprint === right.codexFingerprint;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
  ).get(table) !== undefined;
}

function rows(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): SqlRow[] {
  return db.prepare(sql).all(...params) as SqlRow[];
}

function row(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): SqlRow | undefined {
  return db.prepare(sql).get(...params) as SqlRow | undefined;
}

function comparable(value: unknown): string {
  return JSON.stringify(value);
}

function rowsEqual(left: SqlRow[], right: SqlRow[]): boolean {
  return comparable(left) === comparable(right);
}

function insertRow(
  db: DatabaseSync,
  table: string,
  value: SqlRow,
  omit: readonly string[] = [],
): bigint | number {
  const columns = Object.keys(value).filter((column) => !omit.includes(column));
  const placeholders = columns.map(() => "?").join(", ");
  const result = db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
  ).run(...columns.map((column) => value[column]));
  return result.lastInsertRowid;
}

function conversationSnapshot(db: DatabaseSync, conversationId: number): unknown {
  const conversation = row(
    db,
    `SELECT session_id, title, bootstrapped_at, created_at, updated_at
       FROM conversations WHERE conversation_id = ?`,
    conversationId,
  );
  const messages = rows(
    db,
    `SELECT seq, role, content, token_count, created_at
       FROM messages WHERE conversation_id = ? ORDER BY seq`,
    conversationId,
  );
  const messageIds = rows(
    db,
    "SELECT message_id, seq FROM messages WHERE conversation_id = ? ORDER BY seq",
    conversationId,
  );
  const seqByMessage = new Map(messageIds.map((item) => [
    Number(item.message_id),
    Number(item.seq),
  ]));
  const parts = rows(
    db,
    `SELECT mp.*, m.seq AS message_seq
       FROM message_parts mp JOIN messages m ON m.message_id = mp.message_id
       WHERE m.conversation_id = ? ORDER BY m.seq, mp.ordinal`,
    conversationId,
  ).map(({ message_id: _messageId, message_seq, ...part }) => ({ message_seq, ...part }));
  const summaries = rows(
    db,
    "SELECT * FROM summaries WHERE conversation_id = ? ORDER BY summary_id",
    conversationId,
  ).map(({ conversation_id: _conversationId, ...summary }) => summary);
  const summaryIds = summaries.map((summary) => String(summary.summary_id));
  const summaryMessages = summaryIds.flatMap((summaryId) =>
    rows(
      db,
      `SELECT summary_id, message_id, ordinal
         FROM summary_messages WHERE summary_id = ? ORDER BY ordinal, message_id`,
      summaryId,
    ).map((link) => ({
      summary_id: link.summary_id,
      message_seq: seqByMessage.get(Number(link.message_id)),
      ordinal: link.ordinal,
    })));
  const summaryParents = summaryIds.flatMap((summaryId) =>
    rows(
      db,
      `SELECT summary_id, parent_summary_id, ordinal
         FROM summary_parents WHERE summary_id = ? ORDER BY ordinal, parent_summary_id`,
      summaryId,
    ));
  const context = rows(
    db,
    "SELECT * FROM context_items WHERE conversation_id = ? ORDER BY ordinal",
    conversationId,
  ).map(({ conversation_id: _conversationId, message_id, ...item }) => ({
    ...item,
    message_seq: message_id === null ? null : seqByMessage.get(Number(message_id)),
  }));
  const files = rows(
    db,
    "SELECT * FROM large_files WHERE conversation_id = ? ORDER BY file_id",
    conversationId,
  ).map(({ conversation_id: _conversationId, ...file }) => file);
  return { conversation, messages, parts, summaries, summaryMessages, summaryParents, context, files };
}

function copyConversation(
  source: DatabaseSync,
  target: DatabaseSync,
  sourceConversation: SqlRow,
): boolean {
  const sourceId = Number(sourceConversation.conversation_id);
  const matches = rows(
    target,
    "SELECT conversation_id FROM conversations WHERE session_id = ? ORDER BY conversation_id",
    sourceConversation.session_id,
  );
  if (matches.length > 0) {
    if (
      matches.length === 1
      && comparable(conversationSnapshot(source, sourceId))
        === comparable(conversationSnapshot(target, Number(matches[0].conversation_id)))
    ) {
      return false;
    }
    throw new Error(`divergent conversation collision for session ${String(sourceConversation.session_id)}`);
  }

  const targetConversationId = Number(insertRow(
    target,
    "conversations",
    sourceConversation,
    ["conversation_id"],
  ));
  const messageMap = new Map<number, number>();
  for (const message of rows(
    source,
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq",
    sourceId,
  )) {
    const sourceMessageId = Number(message.message_id);
    message.conversation_id = targetConversationId;
    const targetMessageId = Number(insertRow(target, "messages", message, ["message_id"]));
    messageMap.set(sourceMessageId, targetMessageId);
  }
  for (const part of rows(
    source,
    `SELECT mp.* FROM message_parts mp
       JOIN messages m ON m.message_id = mp.message_id
       WHERE m.conversation_id = ? ORDER BY m.seq, mp.ordinal`,
    sourceId,
  )) {
    part.message_id = messageMap.get(Number(part.message_id))!;
    insertRow(target, "message_parts", part);
  }
  const summaryIds: string[] = [];
  for (const summary of rows(
    source,
    "SELECT * FROM summaries WHERE conversation_id = ? ORDER BY summary_id",
    sourceId,
  )) {
    summary.conversation_id = targetConversationId;
    summaryIds.push(String(summary.summary_id));
    insertRow(target, "summaries", summary);
  }
  for (const summaryId of summaryIds) {
    for (const link of rows(
      source,
      "SELECT * FROM summary_messages WHERE summary_id = ? ORDER BY ordinal",
      summaryId,
    )) {
      link.message_id = messageMap.get(Number(link.message_id))!;
      insertRow(target, "summary_messages", link);
    }
    for (const link of rows(
      source,
      "SELECT * FROM summary_parents WHERE summary_id = ? ORDER BY ordinal",
      summaryId,
    )) {
      insertRow(target, "summary_parents", link);
    }
  }
  for (const item of rows(
    source,
    "SELECT * FROM context_items WHERE conversation_id = ? ORDER BY ordinal",
    sourceId,
  )) {
    item.conversation_id = targetConversationId;
    if (item.message_id !== null) item.message_id = messageMap.get(Number(item.message_id))!;
    insertRow(target, "context_items", item);
  }
  for (const file of rows(
    source,
    "SELECT * FROM large_files WHERE conversation_id = ? ORDER BY file_id",
    sourceId,
  )) {
    file.conversation_id = targetConversationId;
    insertRow(target, "large_files", file);
  }
  return true;
}

function mergeUniqueRows(
  source: DatabaseSync,
  target: DatabaseSync,
  table: string,
  identityColumns: readonly string[],
  transform: (row: SqlRow) => SqlRow = (value) => value,
): void {
  if (!tableExists(source, table)) return;
  for (const sourceRow of rows(source, `SELECT * FROM ${table}`)) {
    const value = transform({ ...sourceRow });
    const where = identityColumns.map((column) => `${column} IS ?`).join(" AND ");
    const selectedColumns = Object.keys(value).join(", ");
    const existing = row(
      target,
      `SELECT ${selectedColumns} FROM ${table} WHERE ${where}`,
      ...identityColumns.map((column) => value[column]),
    );
    if (!existing) {
      insertRow(target, table, value);
    } else if (!rowsEqual([existing], [value])) {
      throw new Error(
        `divergent ${table} collision for ${identityColumns.map((column) => String(value[column])).join("/")}`,
      );
    }
  }
}

function mergeInstructionRows(source: DatabaseSync, target: DatabaseSync, table: string): void {
  if (!tableExists(source, table)) return;
  for (const sourceRow of rows(source, `SELECT * FROM ${table}`)) {
    const existing = row(target, `SELECT * FROM ${table} WHERE id = ?`, sourceRow.id);
    if (!existing) {
      insertRow(target, table, sourceRow);
      continue;
    }
    if (rowsEqual([existing], [sourceRow])) continue;
    if (
      sourceRow.content !== existing.content
      || sourceRow.content_hash !== existing.content_hash
    ) {
      throw new Error(`divergent ${table} collision for id ${String(sourceRow.id)}`);
    }
    if (String(sourceRow.updated_at) > String(existing.updated_at)) {
      target.prepare(
        `UPDATE ${table} SET updated_at = ? WHERE id = ?`,
      ).run(sourceRow.updated_at, sourceRow.id);
    }
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function installSourceWriteFence(
  source: DatabaseSync,
  sourceHash: string,
  kind: "project" | "events",
): void {
  source.exec(`
    CREATE TABLE IF NOT EXISTS worktree_reconciliation_fence (
      source_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      fenced_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(source_hash, kind)
    )
  `);
  source.prepare(
    `INSERT OR IGNORE INTO worktree_reconciliation_fence(source_hash, kind)
     VALUES(?, ?)`,
  ).run(sourceHash, kind);
  const tables = rows(
    source,
    `SELECT name FROM sqlite_schema
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'worktree_reconciliation_%'
         AND name NOT GLOB '*_fts_*'
         AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
       ORDER BY name`,
  );
  for (const [index, table] of tables.entries()) {
    const tableName = String(table.name);
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const triggerName = `lcm_reconciliation_fence_${index}_${operation.toLowerCase()}`;
      source.exec(
        `CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(triggerName)}
         BEFORE ${operation} ON ${quoteIdentifier(tableName)}
         BEGIN
           SELECT RAISE(ABORT, 'LCM source retired by worktree reconciliation');
         END`,
      );
    }
  }
}

function withSourceWriteFence<T>(
  sourcePath: string,
  sourceHash: string,
  kind: "project" | "events",
  busyTimeoutMs: number,
  operation: (source: DatabaseSync, commitFence: () => void) => T,
): T {
  const source = getExistingLcmConnection(sourcePath);
  if (!source) throw new Error(`worktree reconciliation source disappeared: ${sourcePath}`);
  let fenceCommitted = false;
  try {
    source.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    source.exec("BEGIN EXCLUSIVE");
    try {
      installSourceWriteFence(source, sourceHash, kind);
      const result = operation(source, () => {
        source.exec("COMMIT");
        fenceCommitted = true;
      });
      return result;
    } catch (error) {
      if (!fenceCommitted) source.exec("ROLLBACK");
      throw error;
    }
  } finally {
    closeLcmConnection(sourcePath, source);
  }
}

function mergeMainDatabase(
  sourcePath: string,
  targetPath: string,
  targetHash: string,
  sourceHash: string,
  busyTimeoutMs: number,
  fts5AvailableOverride?: boolean,
  afterSourceFenceCommit?: () => void,
): void {
  withSourceWriteFence(sourcePath, sourceHash, "project", busyTimeoutMs, (
    source,
    commitFence,
  ) => {
    const target = getLcmConnection(targetPath);
    try {
      const features = fts5AvailableOverride === undefined
        ? getLcmDbFeatures(target)
        : { fts5Available: fts5AvailableOverride };
      runLcmMigrations(target, features);
      target.exec(`
        CREATE TABLE IF NOT EXISTS worktree_reconciliation_sources (
          source_hash TEXT PRIMARY KEY,
          merged_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      target.exec("BEGIN IMMEDIATE");
      try {
        if (
          row(
            target,
            "SELECT source_hash FROM worktree_reconciliation_sources WHERE source_hash = ?",
            sourceHash,
          )
        ) {
          commitFence();
          afterSourceFenceCommit?.();
          target.exec("COMMIT");
          return;
        }
        for (const conversation of rows(
          source,
          "SELECT * FROM conversations ORDER BY conversation_id",
        )) {
          copyConversation(source, target, conversation);
        }
        mergeUniqueRows(source, target, "promoted", ["id"], (value) => ({
          ...value,
          project_id: targetHash,
        }));
        mergeUniqueRows(source, target, "session_ingest_log", ["session_id"]);
        mergeUniqueRows(
          source,
          target,
          "recall_surfacing",
          ["memory_id", "session_id", "surfaced_at"],
          (value) => {
            const { id: _id, ...rest } = value;
            return rest;
          },
        );
        mergeInstructionRows(source, target, "session_instructions");
        mergeInstructionRows(source, target, "session_instruction_cache");
        if (tableExists(source, "redaction_stats")) {
          for (const count of rows(source, "SELECT category, count FROM redaction_stats")) {
            target
              .prepare(
                `INSERT INTO redaction_stats(project_id, category, count) VALUES(?, ?, ?)
                 ON CONFLICT(project_id, category) DO UPDATE SET count = count + excluded.count`,
              )
              .run(targetHash, count.category, count.count);
          }
        }
        if (features.fts5Available) {
          target.exec(`
            DELETE FROM messages_fts;
            INSERT INTO messages_fts(rowid, content) SELECT message_id, content FROM messages;
            DELETE FROM summaries_fts;
            INSERT INTO summaries_fts(summary_id, content) SELECT summary_id, content FROM summaries;
            DELETE FROM promoted_fts;
            INSERT INTO promoted_fts(rowid, content, tags)
              SELECT rowid, content, tags FROM promoted;
          `);
        }
        const foreignKeyFailures = target.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeyFailures.length > 0) {
          throw new Error("foreign-key verification failed after worktree database merge");
        }
        target
          .prepare("INSERT INTO worktree_reconciliation_sources(source_hash) VALUES(?)")
          .run(sourceHash);
        commitFence();
        afterSourceFenceCommit?.();
        target.exec("COMMIT");
      } catch (error) {
        target.exec("ROLLBACK");
        throw error;
      }
    } finally {
      closeLcmConnection(targetPath, target);
    }
  });
}

function mergeEventsDatabase(
  sourcePath: string,
  targetPath: string,
  sourceHash: string,
  busyTimeoutMs: number,
  afterSourceFenceCommit?: () => void,
): void {
  withSourceWriteFence(sourcePath, sourceHash, "events", busyTimeoutMs, (
    source,
    commitFence,
  ) => {
    const target = getLcmConnection(targetPath);
    try {
      target.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
          seq INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL, category TEXT NOT NULL,
          data TEXT NOT NULL, priority INTEGER DEFAULT 3, source_hook TEXT NOT NULL,
          prev_event_id INTEGER, processed_at TEXT, created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS error_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, hook TEXT NOT NULL, error TEXT NOT NULL,
          session_id TEXT, created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(processed_at)
          WHERE processed_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_events_pattern_lookup
          ON events(type, category, data, created_at);
        CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);
        CREATE TABLE IF NOT EXISTS worktree_reconciliation_sources (
          source_hash TEXT PRIMARY KEY,
          merged_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      target.exec("BEGIN IMMEDIATE");
      try {
        if (
          row(
            target,
            "SELECT source_hash FROM worktree_reconciliation_sources WHERE source_hash = ?",
            sourceHash,
          )
        ) {
          commitFence();
          afterSourceFenceCommit?.();
          target.exec("COMMIT");
          return;
        }
        const eventMap = new Map<number, number>();
        for (const sourceEvent of rows(source, "SELECT * FROM events ORDER BY event_id")) {
          const sourceId = Number(sourceEvent.event_id);
          const previousSourceId = sourceEvent.prev_event_id === null
            ? null
            : Number(sourceEvent.prev_event_id);
          if (previousSourceId !== null && !eventMap.has(previousSourceId)) {
            throw new Error(
              `event ${sourceId} references unknown predecessor ${previousSourceId}`,
            );
          }
          const value: SqlRow = {
            ...sourceEvent,
            prev_event_id: previousSourceId === null ? null : eventMap.get(previousSourceId)!,
          };
          delete value.event_id;
          const existing = row(
            target,
            `SELECT * FROM events
             WHERE session_id IS ? AND seq IS ? AND type IS ? AND category IS ?
               AND data IS ? AND priority IS ? AND source_hook IS ?
               AND prev_event_id IS ? AND processed_at IS ? AND created_at IS ?
             ORDER BY event_id LIMIT 1`,
            value.session_id,
            value.seq,
            value.type,
            value.category,
            value.data,
            value.priority,
            value.source_hook,
            value.prev_event_id,
            value.processed_at,
            value.created_at,
          );
          const targetId = existing
            ? Number(existing.event_id)
            : Number(insertRow(target, "events", value));
          eventMap.set(sourceId, targetId);
        }
        const sourceSchemaVersion = Number(
          row(source, "SELECT version FROM schema_version")?.version,
        );
        const sourceHasErrorLog = tableExists(source, "error_log");
        if (!sourceHasErrorLog && sourceSchemaVersion !== 1) {
          throw new Error(
            `legacy events database schema ${String(sourceSchemaVersion)} is missing error_log`,
          );
        }
        if (sourceHasErrorLog) {
          for (const sourceError of rows(source, "SELECT * FROM error_log ORDER BY id")) {
            const value = { ...sourceError };
            delete value.id;
            const existing = row(
              target,
              `SELECT id FROM error_log
               WHERE hook IS ? AND error IS ? AND session_id IS ? AND created_at IS ?
               ORDER BY id LIMIT 1`,
              value.hook,
              value.error,
              value.session_id,
              value.created_at,
            );
            if (!existing) insertRow(target, "error_log", value);
          }
        }
        target
          .prepare("INSERT INTO worktree_reconciliation_sources(source_hash) VALUES(?)")
          .run(sourceHash);
        commitFence();
        afterSourceFenceCommit?.();
        target.exec("COMMIT");
      } catch (error) {
        target.exec("ROLLBACK");
        throw error;
      }
    } finally {
      closeLcmConnection(targetPath, target);
    }
  });
}

function effectivePatterns(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function patternsDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function mergePatterns(
  source: WorktreeReconciliationSource,
  targetDir: string,
  expected: SourceComponentSnapshot,
): void {
  const sourcePath = join(source.projectDir, "sensitive-patterns.txt");
  const sourceExists = isRegularFile(sourcePath);
  if (!expected.patterns && sourceExists) {
    throw new Error(
      `legacy patterns component appeared after the reconciliation snapshot for ${source.hash}`,
    );
  }
  if (expected.patterns && !sourceExists) {
    throw new Error(
      `worktree reconciliation source component disappeared before merge: ${source.hash}`,
    );
  }
  if (!sourceExists) return;
  const sourceContent = readBoundedRegularFile(sourcePath, {
    allowedRoot: source.projectDir,
    maxBytes: MAX_PATTERN_BYTES,
  });
  if (
    expected.patternsDigest === undefined
    || patternsDigest(sourceContent) !== expected.patternsDigest
  ) {
    throw new Error(
      `legacy patterns component changed after the reconciliation snapshot for ${source.hash}`,
    );
  }
  const targetPath = join(targetDir, "sensitive-patterns.txt");
  const targetExists = isRegularFile(targetPath);
  const target = targetExists
    ? readBoundedRegularFile(targetPath, { allowedRoot: targetDir, maxBytes: MAX_PATTERN_BYTES })
    : "";
  const targetEffective = new Set(effectivePatterns(target));
  const additions = [...new Set(effectivePatterns(sourceContent))]
    .filter((pattern) => !targetEffective.has(pattern));
  if (additions.length === 0) {
    if (!targetExists) atomicWritePrivateFile(targetPath, "");
    return;
  }
  const separator = target.length === 0 || target.endsWith("\n") ? "" : "\n";
  atomicWritePrivateFile(targetPath, `${target}${separator}${additions.join("\n")}\n`);
}

function sourceComponentSnapshot(
  source: WorktreeReconciliationSource,
): SourceComponentSnapshot {
  const patternsPath = join(source.projectDir, "sensitive-patterns.txt");
  const patterns = isRegularFile(patternsPath);
  return {
    projectDb: isRegularFile(join(source.projectDir, "db.sqlite")),
    eventsDb: isRegularFile(source.eventsPath),
    patterns,
    ...(patterns
      ? {
          patternsDigest: patternsDigest(
            readBoundedRegularFile(patternsPath, {
              allowedRoot: source.projectDir,
              maxBytes: MAX_PATTERN_BYTES,
            }),
          ),
        }
      : {}),
  };
}

function assertNoUnmergedComponentsAppeared(
  source: WorktreeReconciliationSource,
  expected: SourceComponentSnapshot,
  current: SourceComponentSnapshot,
): void {
  for (const component of ["projectDb", "eventsDb", "patterns"] as const) {
    if (!expected[component] && current[component]) {
      throw new Error(
        `legacy ${component} component appeared after the reconciliation snapshot for ${source.hash}`,
      );
    }
  }
  if (
    expected.patterns
    && current.patterns
    && expected.patternsDigest !== current.patternsDigest
  ) {
    throw new Error(
      `legacy patterns component changed after the reconciliation snapshot for ${source.hash}`,
    );
  }
}

function backupName(hash: string, now: Date): string {
  return `${hash}-${now.toISOString().replace(/[:.]/gu, "-")}`;
}

function sourceFenceContent(hash: string, kind: "project" | "events"): string {
  return `${JSON.stringify({ version: SOURCE_FENCE_VERSION, hash, kind })}\n`;
}

function isProjectPathFence(path: string, hash: string): boolean {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  return readBoundedRegularFile(path, {
    allowedRoot: dirname(path),
    maxBytes: 1024,
  }) === sourceFenceContent(hash, "project");
}

function isEventsPathFence(path: string, hash: string): boolean {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const marker = join(path, "fence.json");
  return readBoundedRegularFile(marker, {
    allowedRoot: path,
    maxBytes: 1024,
  }) === sourceFenceContent(hash, "events");
}

function installFilesystemFences(
  source: WorktreeReconciliationSource,
  observe: (event: string, path: string) => void,
): void {
  if (!existsSync(source.projectDir)) {
    observe("before-project-path-fence", source.projectDir);
    if (!atomicWritePrivateFileExclusive(
      source.projectDir,
      sourceFenceContent(source.hash, "project"),
    )) {
      throw new Error(`legacy project path was recreated during reconciliation: ${source.projectDir}`);
    }
  } else if (!isProjectPathFence(source.projectDir, source.hash)) {
    throw new Error(`legacy project path remained writable after reconciliation: ${source.projectDir}`);
  }

  if (!existsSync(source.eventsPath)) {
    observe("before-events-path-fence", source.eventsPath);
    if (existsSync(source.eventsPath)) {
      throw new Error(`legacy events path was recreated during reconciliation: ${source.eventsPath}`);
    }
    const prepared = `${source.eventsPath}.lcm-fence-pending`;
    if (!existsSync(prepared)) {
      mkdirSync(prepared, { mode: 0o700 });
    } else {
      const preparedStat = lstatSync(prepared);
      if (
        preparedStat.isSymbolicLink()
        || !preparedStat.isDirectory()
        || readdirSync(prepared).some((entry) => entry !== "fence.json")
      ) {
        throw new Error(`invalid prepared events fence: ${prepared}`);
      }
    }
    observe("after-events-fence-directory-prepared", prepared);
    const marker = join(prepared, "fence.json");
    if (!existsSync(marker)) {
      atomicWritePrivateFileExclusive(marker, sourceFenceContent(source.hash, "events"));
    } else if (!isEventsPathFence(prepared, source.hash)) {
      throw new Error(`invalid prepared events fence: ${prepared}`);
    }
    observe("before-events-path-fence-publish", source.eventsPath);
    renameSync(prepared, source.eventsPath);
  } else if (!isEventsPathFence(source.eventsPath, source.hash)) {
    throw new Error(`legacy events path remained writable after reconciliation: ${source.eventsPath}`);
  }
}

function archiveSource(
  source: WorktreeReconciliationSource,
  homeDir: string | undefined,
  now: Date,
  recordBackup: (path: string) => void,
  observeRename: (event: string, path: string) => void,
): void {
  if (existsSync(source.projectDir) && !isProjectPathFence(source.projectDir, source.hash)) {
    const sourceStat = lstatSync(source.projectDir);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      throw new Error(`invalid legacy project state path: ${source.projectDir}`);
    }
    const root = join(lcmHomeDir(homeDir), "oldprojects");
    ensurePrivateDirectory(root);
    const destination = join(root, backupName(source.hash, now));
    recordBackup(destination);
    observeRename("before-source-archive-rename", destination);
    renameSync(source.projectDir, destination);
    observeRename("after-source-archive-rename", destination);
  }
  const eventsRoot = join(lcmHomeDir(homeDir), "oldevents");
  const eventsDestination = join(eventsRoot, `${backupName(source.hash, now)}.db`);
  if (existsSync(source.eventsPath) && !isEventsPathFence(source.eventsPath, source.hash)) {
    const sourceStat = lstatSync(source.eventsPath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error(`invalid legacy events state path: ${source.eventsPath}`);
    }
    ensurePrivateDirectory(eventsRoot);
    recordBackup(eventsDestination);
    observeRename("before-source-archive-rename", eventsDestination);
    renameSync(source.eventsPath, eventsDestination);
    observeRename("after-source-archive-rename", eventsDestination);
  }
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${source.eventsPath}${suffix}`;
    if (!existsSync(sidecar)) continue;
    ensurePrivateDirectory(eventsRoot);
    const sidecarDestination = `${eventsDestination}${suffix}`;
    recordBackup(sidecarDestination);
    observeRename("before-source-archive-rename", sidecarDestination);
    renameSync(sidecar, sidecarDestination);
    observeRename("after-source-archive-rename", sidecarDestination);
  }
  installFilesystemFences(source, observeRename);
}

function assertArchivedPatternsMatch(
  source: WorktreeReconciliationSource,
  expected: SourceComponentSnapshot,
  homeDir: string | undefined,
  now: Date,
): void {
  const archivedProjectDir = join(
    lcmHomeDir(homeDir),
    "oldprojects",
    backupName(source.hash, now),
  );
  const archivedPatternsPath = join(archivedProjectDir, "sensitive-patterns.txt");
  const archivedPatterns = isRegularFile(archivedPatternsPath);
  if (!expected.patterns && archivedPatterns) {
    throw new Error(
      `legacy patterns component appeared after the reconciliation snapshot for ${source.hash}`,
    );
  }
  if (expected.patterns && !archivedPatterns) {
    throw new Error(
      `archived patterns component disappeared during worktree reconciliation for ${source.hash}`,
    );
  }
  if (!archivedPatterns) return;
  const archivedContent = readBoundedRegularFile(archivedPatternsPath, {
    allowedRoot: archivedProjectDir,
    maxBytes: MAX_PATTERN_BYTES,
  });
  if (
    expected.patternsDigest === undefined
    || patternsDigest(archivedContent) !== expected.patternsDigest
  ) {
    throw new Error(
      `archived patterns component changed during worktree reconciliation for ${source.hash}`,
    );
  }
}

function entryPaths(entry: ProjectMapEntry): string[] {
  return [entry.canonical, ...entry.aliases].map((path) => resolve(path));
}

function discoverSources(
  canonical: string,
  commonDir: string,
  targetHash: string,
  map: Record<string, ProjectMapEntry>,
  homeDir?: string,
  codexDir?: string,
  historicalResolver: HistoricalEntriesResolver = historicalWorktreeEntriesForProject,
): {
  sources: WorktreeReconciliationSource[];
  aliases: string[];
  remoteProjectId?: string;
} {
  const aliases = new Set<string>([canonical]);
  const matches = new Map<string, ProjectMapEntry>();
  for (const [hash, entry] of Object.entries(map)) {
    let sameRepository = hash === targetHash;
    if (!sameRepository && existsSync(entry.canonical)) {
      const anchor = resolveGitProjectAnchor(entry.canonical);
      if (anchor?.commonDir === commonDir) sameRepository = true;
    }
    if (sameRepository) {
      matches.set(hash, entry);
      for (const path of entryPaths(entry)) aliases.add(path);
    }
  }
  const historical = historicalResolver(canonical, commonDir, codexDir, map);
  for (const alias of historical.aliases) aliases.add(alias);
  for (const hash of historical.hashes) {
    const entry = map[hash];
    if (!entry) continue;
    matches.set(hash, entry);
    for (const path of entryPaths(entry)) aliases.add(path);
  }
  const bindings = new Set(
    [...matches.values()].flatMap((entry) => entry.remoteProjectId ? [entry.remoteProjectId] : []),
  );
  if (bindings.size > 1) {
    throw new Error(
      `conflicting PostgreSQL project bindings block worktree reconciliation: ${[...bindings].join(", ")}`,
    );
  }
  return {
    sources: [...matches.entries()]
      .filter(([hash]) => hash !== targetHash)
      .map(([hash]) => ({
        hash,
        projectDir: projectStateDir(hash, homeDir),
        eventsPath: projectEventsPath(hash, homeDir),
      })),
    aliases: [...aliases],
    ...([...bindings][0] ? { remoteProjectId: [...bindings][0] } : {}),
  };
}

function resultFromJournal(journal: ReconciliationJournal, path: string): WorktreeReconciliationResult {
  return {
    status: journal.phase === "blocked"
      ? "blocked"
      : journal.phase === "completed"
        ? journal.sourceHashes.length === 0 ? "not-needed" : "completed"
        : "planned",
    targetHash: journal.targetHash,
    canonical: journal.canonical,
    sourceHashes: journal.sourceHashes,
    aliases: journal.aliases,
    journalPath: path,
    backupPaths: journal.backupPaths,
    ...(journal.reason ? { reason: journal.reason } : {}),
  };
}

export function reconcileWorktrees(
  path: string = process.cwd(),
  opts: {
    readonly dryRun?: boolean;
    readonly homeDir?: string;
    readonly now?: Date;
    /** @internal Override ~/.codex for deterministic tests. */
    readonly _codexDir?: string;
    /** @internal Bound source-lock waits for deterministic contention tests. */
    readonly _sourceBusyTimeoutMs?: number;
    /** @internal Override runtime FTS5 detection for deterministic tests. */
    readonly _fts5Available?: boolean;
    /** @internal Avoid transcript fixtures when testing discovery invalidation. */
    readonly _historicalResolver?: HistoricalEntriesResolver;
    /** @internal Observe lifecycle boundaries without exposing partial state. */
    readonly _observer?: (
      event: string,
      source?: WorktreeReconciliationSource,
      detailPath?: string,
    ) => void;
    /** @internal Bound reconciliation-lock waits for deterministic contention tests. */
    readonly _lockWaitMs?: number;
    /** @internal Override reconciliation-lock polling for deterministic tests. */
    readonly _lockRetryDelayMs?: number;
    /** @internal Bound catalogue walks for deterministic tests. */
    readonly _maxDiscoveryEntries?: number;
    /** @internal Inject catalogue races and failures deterministically. */
    readonly _discoveryObserver?: (path: string) => void;
  } = {},
): WorktreeReconciliationResult {
  const anchor = resolveGitProjectAnchor(path);
  const canonical = anchor?.canonical ?? resolve(path);
  const targetHash = hashProjectPath(canonical);
  if (!anchor) {
    return {
      status: "not-needed",
      targetHash,
      canonical,
      sourceHashes: [],
      aliases: [canonical],
      backupPaths: [],
    };
  }
  const journalFile = journalPath(targetHash, opts.homeDir);
  if (!opts.dryRun) {
    const fastJournal = readJournal(journalFile);
    const fastMap = listProjectMapEntries(opts.homeDir);
    if (
      fastJournal?.phase === "completed"
      && resolve(fastJournal.canonical) === canonical
      && discoveriesEqual(
        fastJournal.discovery,
        reconciliationDiscovery(
          fastMap,
          opts._codexDir,
          opts._maxDiscoveryEntries,
          opts._discoveryObserver,
        ),
      )
    ) {
      return resultFromJournal(fastJournal, journalFile);
    }
  }
  const executeLocked = (map: Record<string, ProjectMapEntry>): WorktreeReconciliationResult => {
    opts._observer?.("after-map-preflight");
    const existingJournal = readJournal(journalFile);
    if (
      existingJournal
      && resolve(existingJournal.canonical) !== canonical
    ) {
      throw new Error("worktree reconciliation journal does not match the requested project");
    }
    const discovery = reconciliationDiscovery(
      map,
      opts._codexDir,
      opts._maxDiscoveryEntries,
      opts._discoveryObserver,
    );
    const discovered = discoverSources(
      canonical,
      anchor.commonDir,
      targetHash,
      map,
      opts.homeDir,
      opts._codexDir,
      opts._historicalResolver,
    );
    const discoveredHashes = discovered.sources.map(({ hash }) => hash);
    const priorHashes = new Set(existingJournal?.sourceHashes ?? []);
    const retryPreflightDiscovery = existingJournal?.phase === "blocked"
      && (existingJournal.blockedFrom ?? "planned") === "planned"
      && existingJournal.pendingSourceHashes?.length === 0;
    const pendingSourceHashes = existingJournal?.phase === "completed" || retryPreflightDiscovery
      ? discoveredHashes.filter((hash) => !priorHashes.has(hash))
      : existingJournal?.pendingSourceHashes
        ?? existingJournal?.sourceHashes
        ?? discoveredHashes;
    const sourceHashes = [...new Set([
      ...(existingJournal?.sourceHashes ?? []),
      ...pendingSourceHashes,
    ])];
    const aliases = [...new Set([
      ...(existingJournal?.aliases ?? []),
      ...discovered.aliases,
    ])];
    if (
      existingJournal
      && existingJournal.phase !== "completed"
      && discovered.remoteProjectId !== existingJournal.remoteProjectId
      && !(
        retryPreflightDiscovery
        && existingJournal.sourceHashes.length === 0
        && existingJournal.remoteProjectId === undefined
      )
    ) {
      throw new Error("PostgreSQL project binding changed during worktree reconciliation");
    }
    if (pendingSourceHashes.length === 0) {
      if (!opts.dryRun) {
        ensurePrivateDirectory(reconciliationDir(opts.homeDir));
        const completed: ReconciliationJournal = existingJournal ?? {
          version: RECONCILIATION_VERSION,
          targetHash,
          canonical,
          sourceHashes: [],
          aliases,
          ...(discovered.remoteProjectId ? { remoteProjectId: discovered.remoteProjectId } : {}),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          phase: "completed",
          backupPaths: [],
        };
        completed.aliases = aliases;
        completed.pendingSourceHashes = [];
        completed.discovery = discovery;
        completed.phase = "completed";
        delete completed.reason;
        writeJournal(journalFile, completed);
      }
      return {
        status: sourceHashes.length === 0 ? "not-needed" : "completed",
        targetHash,
        canonical,
        sourceHashes,
        aliases,
        ...(!opts.dryRun || existingJournal ? { journalPath: journalFile } : {}),
        backupPaths: existingJournal?.backupPaths ?? [],
      };
    }
    const sourcesByHash = new Map(discovered.sources.map((source) => [source.hash, source]));
    const sources = pendingSourceHashes.map((hash) => {
      const discoveredSource = sourcesByHash.get(hash);
      if (discoveredSource) return discoveredSource;
      if (
        !existingJournal ||
        existingJournal.phase === "planned" ||
        (existingJournal.phase === "blocked" &&
          (existingJournal.blockedFrom ?? "planned") === "planned")
      ) {
        throw new Error(`worktree reconciliation source disappeared before merge: ${hash}`);
      }
      return {
        hash,
        projectDir: projectStateDir(hash, opts.homeDir),
        eventsPath: projectEventsPath(hash, opts.homeDir),
      };
    });
    const journal: ReconciliationJournal = existingJournal ?? {
      version: RECONCILIATION_VERSION,
      targetHash,
      canonical,
      sourceHashes,
      pendingSourceHashes,
      aliases,
      ...(discovered.remoteProjectId ? { remoteProjectId: discovered.remoteProjectId } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "planned",
      backupPaths: [],
    };
    journal.sourceHashes = sourceHashes;
    journal.pendingSourceHashes = pendingSourceHashes;
    journal.aliases = aliases;
    journal.remoteProjectId = discovered.remoteProjectId;
    journal.discovery = discovery;
    if (existingJournal?.phase === "completed") journal.phase = "planned";
    if (opts.dryRun) return resultFromJournal(journal, journalFile);
    if (journal.phase === "blocked") {
      journal.phase = journal.blockedFrom ?? "planned";
      delete journal.blockedFrom;
      delete journal.reason;
    }
    journal.sourceComponents ??= {};
    for (const source of sources) {
      const current = sourceComponentSnapshot(source);
      let expected = journal.sourceComponents[source.hash];
      if (!expected) {
        if (journal.phase !== "planned") {
          throw new Error(
            `worktree reconciliation journal lacks a component snapshot for ${source.hash}`,
          );
        }
        journal.sourceComponents[source.hash] = current;
        continue;
      }
      if (expected.patterns && expected.patternsDigest === undefined) {
        if (journal.phase !== "planned" || !current.patterns) {
          throw new Error(
            `worktree reconciliation journal lacks a patterns digest for ${source.hash}`,
          );
        }
        journal.sourceComponents[source.hash] = current;
        expected = current;
      }
      assertNoUnmergedComponentsAppeared(source, expected, current);
      if (
        journal.phase === "planned"
        && (
          (expected.projectDb && !current.projectDb)
          || (expected.eventsDb && !current.eventsDb)
          || (expected.patterns && !current.patterns)
        )
      ) {
        throw new Error(
          `worktree reconciliation source component disappeared before merge: ${source.hash}`,
        );
      }
    }
    ensurePrivateDirectory(reconciliationDir(opts.homeDir));
    writeJournal(journalFile, journal);

    try {
      const targetDir = projectStateDir(targetHash, opts.homeDir);
      ensurePrivateDirectory(targetDir);
      const targetDbPath = join(targetDir, "db.sqlite");
      const targetEventsPath = projectEventsPath(targetHash, opts.homeDir);
      ensurePrivateDirectory(dirname(targetEventsPath));
      if (journal.phase === "planned") {
        for (const source of sources) {
          const sourceDbPath = join(source.projectDir, "db.sqlite");
          if (isRegularFile(sourceDbPath)) {
            opts._observer?.("before-source-main-merge", source);
            mergeMainDatabase(
              sourceDbPath,
              targetDbPath,
              targetHash,
              source.hash,
              opts._sourceBusyTimeoutMs ?? 5_000,
              opts._fts5Available,
              () => opts._observer?.(
                "after-source-fence-commit-before-target-commit",
                source,
              ),
            );
          }
          if (isRegularFile(source.eventsPath)) {
            opts._observer?.("before-source-events-merge", source);
            mergeEventsDatabase(
              source.eventsPath,
              targetEventsPath,
              source.hash,
              opts._sourceBusyTimeoutMs ?? 5_000,
              () => opts._observer?.(
                "after-source-fence-commit-before-target-commit",
                source,
              ),
            );
          }
          opts._observer?.("before-source-patterns-merge", source);
          mergePatterns(source, targetDir, journal.sourceComponents[source.hash]!);
        }
        journal.phase = "merged";
        writeJournal(journalFile, journal);
        opts._observer?.("after-merge-before-archive");
      }
      if (journal.phase === "merged") {
        for (const source of sources) {
          const expected = journal.sourceComponents[source.hash]!;
          assertNoUnmergedComponentsAppeared(
            source,
            expected,
            sourceComponentSnapshot(source),
          );
        }
        journal.archiveAt ??= (opts.now ?? new Date()).toISOString();
        writeJournal(journalFile, journal);
        const now = new Date(journal.archiveAt);
        for (const source of sources) {
          archiveSource(source, opts.homeDir, now, (backupPath) => {
            journal.backupPaths.push(backupPath);
            writeJournal(journalFile, journal);
          }, (event, detailPath) => opts._observer?.(event, source, detailPath));
          assertArchivedPatternsMatch(
            source,
            journal.sourceComponents[source.hash]!,
            opts.homeDir,
            now,
          );
          opts._observer?.("after-source-archive", source);
        }
        journal.phase = "archived";
        writeJournal(journalFile, journal);
      }
      const currentMap = listProjectMapEntries(opts.homeDir);
      const targetEntry = currentMap[targetHash];
      const sourcesRemain = pendingSourceHashes.some((hash) => currentMap[hash] !== undefined);
      if (!sourcesRemain && targetEntry) {
        const publishedPaths = new Set(entryPaths(targetEntry));
        const missingAlias = aliases.find(
          (alias) => resolve(alias) !== canonical && !publishedPaths.has(resolve(alias)),
        );
        if (
          resolve(targetEntry.canonical) !== canonical
          || missingAlias
          || targetEntry.remoteProjectId !== journal.remoteProjectId
        ) {
          throw new Error("published worktree reconciliation map does not match its journal");
        }
      } else {
        const folded = foldProjectMapEntriesLocked({
          targetHash,
          canonical,
          sourceHashes: pendingSourceHashes,
          aliases,
          expectedRemoteProjectId: journal.remoteProjectId ?? null,
          homeDir: opts.homeDir,
          onBackupCreated: (backupPath) => {
            journal.backupPaths.push(backupPath);
            writeJournal(journalFile, journal);
          },
          onMapPublished: () => opts._observer?.("after-project-map-published"),
        });
      }
      journal.pendingSourceHashes = [];
      journal.phase = "completed";
      const publishedMapDiscovery = reconciliationDiscovery(
        listProjectMapEntries(opts.homeDir),
        opts._codexDir,
        opts._maxDiscoveryEntries,
        opts._discoveryObserver,
      );
      journal.discovery = {
        mapFingerprint: publishedMapDiscovery.mapFingerprint,
        codexFingerprint: discovery.codexFingerprint,
        complete: discovery.complete && publishedMapDiscovery.complete,
      };
      writeJournal(journalFile, journal);
      return resultFromJournal(journal, journalFile);
    } catch (error) {
      journal.blockedFrom = journal.phase === "merged" || journal.phase === "archived"
        ? journal.phase
        : journal.blockedFrom ?? "planned";
      journal.phase = "blocked";
      journal.reason = String(error);
      writeJournal(journalFile, journal);
      throw error;
    }
  };

  const execute = (map: Record<string, ProjectMapEntry>): WorktreeReconciliationResult => {
    try {
      return executeLocked(map);
    } catch (error) {
      if (opts.dryRun) throw error;
      const current = readJournal(journalFile);
      if (current && resolve(current.canonical) !== canonical) throw error;
      {
        const now = new Date().toISOString();
        const blocked: ReconciliationJournal = current ?? {
          version: RECONCILIATION_VERSION,
          targetHash,
          canonical,
          sourceHashes: [],
          pendingSourceHashes: [],
          aliases: [...new Set([
            canonical,
            ...(map[targetHash] ? entryPaths(map[targetHash]) : []),
          ])],
          ...(map[targetHash]?.remoteProjectId
            ? { remoteProjectId: map[targetHash].remoteProjectId }
            : {}),
          createdAt: now,
          updatedAt: now,
          phase: "blocked",
          blockedFrom: "planned",
          backupPaths: [],
        };
        if (blocked.phase !== "blocked") {
          blocked.blockedFrom = blocked.phase === "merged" || blocked.phase === "archived"
            ? blocked.phase
            : "planned";
        }
        blocked.phase = "blocked";
        blocked.reason = String(error);
        ensurePrivateDirectory(reconciliationDir(opts.homeDir));
        writeJournal(journalFile, blocked);
      }
      throw error;
    }
  };

  if (opts.dryRun) return execute(readProjectMapSnapshot(opts.homeDir));
  const lockWaitMs = opts._lockWaitMs ?? 5_000;
  const retryDelayMs = opts._lockRetryDelayMs ?? 50;
  const deadline = Date.now() + lockWaitMs;
  while (true) {
    try {
      return withPrivateMutationLock(
        reconciliationLockPath(targetHash, opts.homeDir),
        "worktree reconciliation",
        () => withProjectMapReconciliationLock(execute, opts.homeDir),
      );
    } catch (error) {
      if (!(error instanceof PrivateMutationLockContentionError) || Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.min(retryDelayMs, Math.max(1, deadline - Date.now())),
      );
    }
  }
}

export function ensureWorktreeProjectReconciled(
  cwd: string,
  identity: ProjectIdentity,
): WorktreeReconciliationResult {
  const before = reconciliationDiscovery(listProjectMapEntries());
  if (
    before.complete
    && reconciledThisProcess.get(identity.id) === fingerprint(before)
  ) {
    return {
      status: "completed",
      targetHash: identity.id,
      canonical: identity.canonical,
      sourceHashes: [],
      aliases: [identity.canonical],
      backupPaths: [],
    };
  }
  const result = reconcileWorktrees(cwd);
  const publishedDiscovery = result.journalPath
    ? readJournal(result.journalPath)?.discovery
    : reconciliationDiscovery(listProjectMapEntries());
  if (publishedDiscovery?.complete) {
    const publishedFingerprint = fingerprint(publishedDiscovery);
    reconciledThisProcess.set(identity.id, publishedFingerprint);
    reconciledThisProcess.set(result.targetHash, publishedFingerprint);
  }
  return result;
}

export function clearWorktreeReconciliationCache(): void {
  reconciledThisProcess.clear();
}

export function listWorktreeReconciliationJournals(homeDir?: string): ReconciliationJournal[] {
  const root = reconciliationDir(homeDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
    .map((entry) => readJournal(join(root, entry.name))!);
}
