import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runLcmMigrations } from "./db/migration.js";
import { getLcmDbFeatures } from "./db/features.js";
import { closeLcmConnection, getLcmConnection } from "./db/connection.js";
import { resolveGitProjectAnchor } from "./git-project.js";
import {
  foldProjectMapEntries,
  hashProjectPath,
  listProjectMapEntries,
  type ProjectIdentity,
  type ProjectMapEntry,
} from "./project-map.js";
import { lcmHomeDir, projectsDir } from "./runtime-paths.js";
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  readBoundedRegularFile,
} from "./security-files.js";
import { withPrivateMutationLock } from "./private-mutation-lock.js";
import { historicalWorktreeEntriesForProject } from "./codex-project-resolution.js";

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_PATTERN_BYTES = 1024 * 1024;
const RECONCILIATION_VERSION = 1;
const HASH_RE = /^[a-f0-9]{64}$/u;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const reconciledThisProcess = new Set<string>();

type SqlRow = Record<string, SQLInputValue>;

export type WorktreeReconciliationSource = {
  readonly hash: string;
  readonly entry: ProjectMapEntry;
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
  readonly sourceHashes: string[];
  readonly aliases: string[];
  readonly remoteProjectId?: string;
  readonly createdAt: string;
  updatedAt: string;
  phase: "planned" | "merged" | "archived" | "completed" | "blocked";
  backupPaths: string[];
  reason?: string;
};

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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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
    || !Array.isArray(value.aliases)
    || !value.aliases.every((alias) => typeof alias === "string" && isAbsolute(alias))
    || !Array.isArray(value.backupPaths)
    || !value.backupPaths.every((backup) => typeof backup === "string" && isAbsolute(backup))
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
    || (value.remoteProjectId !== undefined
      && (typeof value.remoteProjectId !== "string" || !UUID_V7_RE.test(value.remoteProjectId)))
    || (value.reason !== undefined && typeof value.reason !== "string")
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
        `UPDATE ${table} SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?`,
      ).run(sourceRow.content, sourceRow.content_hash, sourceRow.updated_at, sourceRow.id);
    }
  }
}

function mergeMainDatabase(
  sourcePath: string,
  targetPath: string,
  targetHash: string,
  sourceHash: string,
): void {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const target = getLcmConnection(targetPath);
    try {
      // Read-only source handles must not change a database-wide journal mode,
      // but they still need the normal wait policy while another process commits.
      source.exec("PRAGMA busy_timeout = 5000");
      runLcmMigrations(target, getLcmDbFeatures(target));
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
        target.exec(`
          DELETE FROM messages_fts;
          INSERT INTO messages_fts(rowid, content) SELECT message_id, content FROM messages;
          DELETE FROM summaries_fts;
          INSERT INTO summaries_fts(summary_id, content) SELECT summary_id, content FROM summaries;
          DELETE FROM promoted_fts;
          INSERT INTO promoted_fts(rowid, content, tags)
            SELECT rowid, content, tags FROM promoted;
        `);
        const foreignKeyFailures = target.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeyFailures.length > 0) {
          throw new Error("foreign-key verification failed after worktree database merge");
        }
        target
          .prepare("INSERT INTO worktree_reconciliation_sources(source_hash) VALUES(?)")
          .run(sourceHash);
        target.exec("COMMIT");
      } catch (error) {
        target.exec("ROLLBACK");
        throw error;
      }
    } finally {
      closeLcmConnection(targetPath, target);
    }
  } finally {
    source.close();
  }
}

function mergeEventsDatabase(sourcePath: string, targetPath: string, sourceHash: string): void {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const target = getLcmConnection(targetPath);
    try {
      // Keep source reads non-mutating while applying the same contention policy
      // as every other LCM SQLite connection.
      source.exec("PRAGMA busy_timeout = 5000");
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
        target
          .prepare("INSERT INTO worktree_reconciliation_sources(source_hash) VALUES(?)")
          .run(sourceHash);
        target.exec("COMMIT");
      } catch (error) {
        target.exec("ROLLBACK");
        throw error;
      }
    } finally {
      closeLcmConnection(targetPath, target);
    }
  } finally {
    source.close();
  }
}

function effectivePatterns(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function mergePatterns(sourceDir: string, targetDir: string): void {
  const sourcePath = join(sourceDir, "sensitive-patterns.txt");
  if (!isRegularFile(sourcePath)) return;
  const source = readBoundedRegularFile(sourcePath, {
    allowedRoot: sourceDir,
    maxBytes: MAX_PATTERN_BYTES,
  });
  const targetPath = join(targetDir, "sensitive-patterns.txt");
  const targetExists = isRegularFile(targetPath);
  const target = targetExists
    ? readBoundedRegularFile(targetPath, { allowedRoot: targetDir, maxBytes: MAX_PATTERN_BYTES })
    : "";
  const targetEffective = new Set(effectivePatterns(target));
  const additions = [...new Set(effectivePatterns(source))]
    .filter((pattern) => !targetEffective.has(pattern));
  if (additions.length === 0) {
    if (!targetExists) atomicWritePrivateFile(targetPath, "");
    return;
  }
  const separator = target.length === 0 || target.endsWith("\n") ? "" : "\n";
  atomicWritePrivateFile(targetPath, `${target}${separator}${additions.join("\n")}\n`);
}

function backupName(hash: string, now: Date): string {
  return `${hash}-${now.toISOString().replace(/[:.]/gu, "-")}`;
}

function archiveSource(
  source: WorktreeReconciliationSource,
  homeDir: string | undefined,
  now: Date,
): string[] {
  const archived: string[] = [];
  if (existsSync(source.projectDir)) {
    const root = join(lcmHomeDir(homeDir), "oldprojects");
    ensurePrivateDirectory(root);
    const destination = join(root, backupName(source.hash, now));
    renameSync(source.projectDir, destination);
    archived.push(destination);
  }
  if (existsSync(source.eventsPath)) {
    const root = join(lcmHomeDir(homeDir), "oldevents");
    ensurePrivateDirectory(root);
    const destination = join(root, `${backupName(source.hash, now)}.db`);
    renameSync(source.eventsPath, destination);
    archived.push(destination);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${source.eventsPath}${suffix}`;
      if (!existsSync(sidecar)) continue;
      const sidecarDestination = `${destination}${suffix}`;
      renameSync(sidecar, sidecarDestination);
      archived.push(sidecarDestination);
    }
  }
  return archived;
}

function entryPaths(entry: ProjectMapEntry): string[] {
  return [entry.canonical, ...entry.aliases].map((path) => resolve(path));
}

function discoverSources(
  canonical: string,
  commonDir: string,
  targetHash: string,
  homeDir?: string,
  codexDir?: string,
): {
  sources: WorktreeReconciliationSource[];
  aliases: string[];
  remoteProjectId?: string;
} {
  const map = listProjectMapEntries();
  const aliases = new Set<string>([canonical]);
  const matches = new Map<string, ProjectMapEntry>();
  for (const [hash, entry] of Object.entries(map)) {
    let sameRepository = hash === targetHash;
    for (const path of entryPaths(entry)) {
      if (!existsSync(path)) continue;
      const anchor = resolveGitProjectAnchor(path);
      if (anchor?.commonDir === commonDir) sameRepository = true;
    }
    if (sameRepository) {
      matches.set(hash, entry);
      for (const path of entryPaths(entry)) aliases.add(path);
    }
  }
  const historical = historicalWorktreeEntriesForProject(canonical, commonDir, codexDir);
  for (const alias of historical.aliases) aliases.add(alias);
  for (const hash of historical.hashes) {
    const entry = map[hash]!;
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
      .map(([hash, entry]) => ({
        hash,
        entry,
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
        ? "completed"
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
  const execute = (): WorktreeReconciliationResult => {
    const existingJournal = readJournal(journalFile);
    if (
      existingJournal
      && resolve(existingJournal.canonical) !== canonical
    ) {
      throw new Error("worktree reconciliation journal does not match the requested project");
    }
    if (existingJournal?.phase === "completed") {
      return resultFromJournal(existingJournal, journalFile);
    }
    const discovered = discoverSources(
      canonical,
      anchor.commonDir,
      targetHash,
      opts.homeDir,
      opts._codexDir,
    );
    const sourceHashes = existingJournal?.sourceHashes ?? discovered.sources.map(({ hash }) => hash);
    const aliases = existingJournal?.aliases ?? discovered.aliases;
    if (sourceHashes.length === 0) {
      return {
        status: "not-needed",
        targetHash,
        canonical,
        sourceHashes,
        aliases,
        backupPaths: [],
      };
    }
    const sourcesByHash = new Map(discovered.sources.map((source) => [source.hash, source]));
    const sources = sourceHashes.map((hash) => sourcesByHash.get(hash) ?? {
      hash,
      entry: listProjectMapEntries()[hash]!,
      projectDir: projectStateDir(hash, opts.homeDir),
      eventsPath: projectEventsPath(hash, opts.homeDir),
    });
    const journal: ReconciliationJournal = existingJournal ?? {
      version: RECONCILIATION_VERSION,
      targetHash,
      canonical,
      sourceHashes,
      aliases,
      ...(discovered.remoteProjectId ? { remoteProjectId: discovered.remoteProjectId } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "planned",
      backupPaths: [],
    };
    if (opts.dryRun) return resultFromJournal(journal, journalFile);
    if (journal.phase === "blocked") {
      journal.phase = "planned";
      delete journal.reason;
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
            mergeMainDatabase(sourceDbPath, targetDbPath, targetHash, source.hash);
          }
          if (isRegularFile(source.eventsPath)) {
            mergeEventsDatabase(source.eventsPath, targetEventsPath, source.hash);
          }
          mergePatterns(source.projectDir, targetDir);
        }
        journal.phase = "merged";
        writeJournal(journalFile, journal);
      }
      if (journal.phase === "merged") {
        const now = opts.now ?? new Date();
        for (const source of sources) {
          journal.backupPaths.push(...archiveSource(source, opts.homeDir, now));
        }
        journal.phase = "archived";
        writeJournal(journalFile, journal);
      }
      const map = listProjectMapEntries();
      const targetEntry = map[targetHash];
      const sourcesRemain = sourceHashes.some((hash) => map[hash] !== undefined);
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
        const folded = foldProjectMapEntries({
          targetHash,
          canonical,
          sourceHashes,
          aliases,
          expectedRemoteProjectId: journal.remoteProjectId,
        });
        journal.backupPaths.push(folded.backupPath!);
      }
      journal.phase = "completed";
      writeJournal(journalFile, journal);
      return resultFromJournal(journal, journalFile);
    } catch (error) {
      journal.phase = "blocked";
      journal.reason = String(error);
      writeJournal(journalFile, journal);
      throw error;
    }
  };

  if (opts.dryRun) return execute();
  return withPrivateMutationLock(
    reconciliationLockPath(targetHash, opts.homeDir),
    "worktree reconciliation",
    execute,
  );
}

export function ensureWorktreeProjectReconciled(
  cwd: string,
  identity: ProjectIdentity,
): WorktreeReconciliationResult {
  if (reconciledThisProcess.has(identity.id)) {
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
  reconciledThisProcess.add(identity.id);
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
