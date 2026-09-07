import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  existsSync,
  fchmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runLcmMigrations } from "./db/migration.js";
import { getLcmDbFeatures } from "./db/features.js";
import {
  EventsDb,
  isValidMissingCwdStateRow,
} from "./hooks/events-db.js";
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
  projectMapPath,
  readProjectMapSnapshot,
  type ProjectIdentity,
  type ProjectMapEntry,
  withProjectMapReconciliationLock,
} from "./project-map.js";
import { lcmHomeDir, projectsDir } from "./runtime-paths.js";
import {
  atomicWritePrivateFile,
  atomicWritePrivateFileExclusive,
  assertPrivateDirectoryEntry,
  ensurePrivateDirectory,
  openPrivateDirectory,
  openPrivateDirectoryForCreation,
  openPrivateDirectoryIfExists,
  readBoundedRegularFile,
  type PrivateDirectoryHandle,
} from "./security-files.js";
import {
  PrivateMutationLockContentionError,
  withPrivateMutationLock,
} from "./private-mutation-lock.js";
import {
  withBackendPublicationConsumerLock,
  BackendPublicationJournalError,
  type BackendPublicationLockToken,
} from "./storage/backend-publication.js";
import { historicalWorktreeEntriesForProject } from "./codex-project-resolution.js";
import {
  allocateLocalHookEventSequences,
  deriveLegacyLocalHookEventUuid,
  formatLocalHookMachineSequence,
  parseLocalHookMachineSequence,
} from "./storage/local-hook-event-sequence.js";
import {
  isWorktreeReconciliationFence,
  serializeWorktreeReconciliationFence,
} from "./worktree-reconciliation-fence.js";

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_PATTERN_BYTES = 1024 * 1024;
const MAX_PROJECT_METADATA_BYTES = 1024 * 1024;
const RECONCILIATION_VERSION = 1;
const HASH_RE = /^[a-f0-9]{64}$/u;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_DISCOVERY_ENTRIES = 50_000;
const DEFAULT_SOURCE_BUSY_TIMEOUT_MS = 5_000;
const RECONCILIATION_CACHE_TTL_MS = 1_000;
const RECONCILIATION_JOURNAL_PARENT_DRIFT_DIAGNOSTIC =
  "worktree reconciliation journal parent changed during retryable contention";
// Reconciliation must be audited independently for every event schema. Do not
// replace this ceiling with the live EventsDb schema version.
const MAX_RECONCILIABLE_EVENT_SCHEMA_VERSION = 5;

type ReconciledProcessCacheEntry = {
  readonly discoveryFingerprint: string;
  readonly identityCanonical: string;
  readonly targetHash: string;
  readonly stateGuard: string;
  readonly expiresAt: number;
};

const reconciledThisProcess = new Map<string, ReconciledProcessCacheEntry>();

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

function normalizeSourceBusyTimeoutMs(value: number | undefined): number {
  return value !== undefined
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0
    ? value
    : DEFAULT_SOURCE_BUSY_TIMEOUT_MS;
}

function cacheTtlMs(value: number | undefined): number {
  return value !== undefined
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0
    ? Math.min(value, RECONCILIATION_CACHE_TTL_MS)
    : RECONCILIATION_CACHE_TTL_MS;
}

function fileStateGuard(path: string): string | null {
  try {
    const stat = lstatSync(path);
    return [
      stat.mode,
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
    ].join(":");
  } catch {
    return null;
  }
}

function reconciliationCacheStateGuard(targetHash: string): string | null {
  const mapGuard = fileStateGuard(projectMapPath());
  const journalGuard = fileStateGuard(journalPath(targetHash));
  return [mapGuard, journalGuard].includes(null)
    ? null
    : `${mapGuard!}|${journalGuard!}`;
}

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

type RetainedReconciliationTarget = Readonly<{
  rootPath: string;
  projectsPath: string;
  targetPath: string;
  eventsPath: string;
  root: PrivateDirectoryHandle;
  projects: PrivateDirectoryHandle;
  target: PrivateDirectoryHandle;
  events: PrivateDirectoryHandle;
}>;

type RetainedReconciliationJournalParent = Readonly<{
  rootPath: string;
  directoryPath: string;
  root: PrivateDirectoryHandle;
  directory: PrivateDirectoryHandle;
}>;

function closeRetainedChildAndRethrow(
  child: PrivateDirectoryHandle,
  primaryError: unknown,
): never {
  try {
    child.close();
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `reconciliation target child admission failed: ${String(primaryError)}`,
      { cause: primaryError },
    );
  }
  throw primaryError;
}

function acquireRetainedChild(
  parent: PrivateDirectoryHandle,
  parentPath: string,
  childPath: string,
): PrivateDirectoryHandle {
  const expectedUid = parent.witness.uid;
  assertPrivateDirectoryEntry(parent, parentPath, expectedUid);
  const existing = openPrivateDirectoryIfExists(childPath, { expectedUid });
  if (existing !== undefined) {
    try {
      assertPrivateDirectoryEntry(existing, childPath, expectedUid);
      return existing;
    } catch (error) {
      closeRetainedChildAndRethrow(existing, error);
    }
  }

  let created = false;
  try {
    mkdirSync(childPath, { recursive: false, mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const child = created
    ? openPrivateDirectoryForCreation(childPath, { expectedUid })
    : openPrivateDirectory(childPath, { expectedUid });
  try {
    if (created) fchmodSync(child.fd, 0o700);
    assertPrivateDirectoryEntry(child, childPath, expectedUid);
    return child;
  } catch (error) {
    closeRetainedChildAndRethrow(child, error);
  }
}

function assertRetainedReconciliationTarget(target: RetainedReconciliationTarget): void {
  assertPrivateDirectoryEntry(target.root, target.rootPath, target.root.witness.uid);
  assertPrivateDirectoryEntry(
    target.projects,
    target.projectsPath,
    target.projects.witness.uid,
  );
  assertPrivateDirectoryEntry(target.target, target.targetPath, target.target.witness.uid);
  assertPrivateDirectoryEntry(target.events, target.eventsPath, target.events.witness.uid);
}

function closePrivateDirectoryHandles(
  handles: readonly PrivateDirectoryHandle[],
): unknown[] {
  const errors: unknown[] = [];
  for (const handle of [...handles].reverse()) {
    try {
      handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function assertRetainedReconciliationJournalParent(
  parent: RetainedReconciliationJournalParent,
): void {
  assertPrivateDirectoryEntry(parent.root, parent.rootPath, parent.root.witness.uid);
  assertPrivateDirectoryEntry(
    parent.directory,
    parent.directoryPath,
    parent.directory.witness.uid,
  );
}

function preservesReconciliationErrorClassification(error: unknown): boolean {
  return error instanceof BackendPublicationJournalError
    || error instanceof PrivateMutationLockContentionError;
}

function withRetainedReconciliationJournalParent<T>(
  homeDir: string | undefined,
  operation: (parent: RetainedReconciliationJournalParent) => T,
): T {
  const rootPath = lcmHomeDir(homeDir);
  const directoryPath = reconciliationDir(homeDir);
  const handles: PrivateDirectoryHandle[] = [];
  let result: T | undefined;
  let operationFailed = false;
  let primaryError: unknown;
  let retained: RetainedReconciliationJournalParent | undefined;
  let retryTopologyError: unknown;
  try {
    const root = openPrivateDirectory(rootPath);
    handles.push(root);
    const directory = acquireRetainedChild(root, rootPath, directoryPath);
    handles.push(directory);
    retained = { rootPath, directoryPath, root, directory };
    assertRetainedReconciliationJournalParent(retained);
    result = operation(retained);
    assertRetainedReconciliationJournalParent(retained);
  } catch (error) {
    operationFailed = true;
    primaryError = error;
    if (error instanceof PrivateMutationLockContentionError && retained !== undefined) {
      try {
        assertRetainedReconciliationJournalParent(retained);
      } catch (topologyError) {
        retryTopologyError = topologyError;
      }
    }
  }
  const cleanupErrors = closePrivateDirectoryHandles(handles);
  if (operationFailed) {
    if (retryTopologyError !== undefined) {
      throw new BackendPublicationJournalError(
        "unsafe-storage",
        RECONCILIATION_JOURNAL_PARENT_DRIFT_DIAGNOSTIC,
        {
          cause: new AggregateError(
            [primaryError, retryTopologyError],
            "worktree reconciliation contention coincided with journal-parent topology drift",
            { cause: primaryError },
          ),
        },
      );
    }
    if (preservesReconciliationErrorClassification(primaryError)) throw primaryError;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        `reconciliation journal operation failed: ${String(primaryError)}`,
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "reconciliation journal directory cleanup failed");
  }
  return result as T;
}

function withRetainedReconciliationTarget<T>(
  targetHash: string,
  homeDir: string | undefined,
  operation: (target: RetainedReconciliationTarget) => T,
  onCompleted: () => void,
): T {
  const rootPath = lcmHomeDir(homeDir);
  const projectsPath = projectsDir(homeDir);
  const targetPath = projectStateDir(targetHash, homeDir);
  const eventsPath = dirname(projectEventsPath(targetHash, homeDir));
  const handles: PrivateDirectoryHandle[] = [];
  let result: T | undefined;
  let primaryError: unknown;
  try {
    const root = openPrivateDirectory(rootPath);
    handles.push(root);
    const projects = acquireRetainedChild(root, rootPath, projectsPath);
    handles.push(projects);
    const target = acquireRetainedChild(projects, projectsPath, targetPath);
    handles.push(target);
    const events = acquireRetainedChild(root, rootPath, eventsPath);
    handles.push(events);
    const retained = {
      rootPath,
      projectsPath,
      targetPath,
      eventsPath,
      root,
      projects,
      target,
      events,
    };
    assertRetainedReconciliationTarget(retained);
    result = operation(retained);
    assertRetainedReconciliationTarget(retained);
    onCompleted();
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = closePrivateDirectoryHandles(handles);
  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `reconciliation target operation failed: ${String(primaryError)}`,
      { cause: primaryError },
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "reconciliation target directory cleanup failed");
  }
  return result as T;
}

function observeRetainedReconciliationTarget(
  target: RetainedReconciliationTarget,
  observer: ((
    event: string,
    source?: WorktreeReconciliationSource,
    detailPath?: string,
  ) => void) | undefined,
  event: string,
  source?: WorktreeReconciliationSource,
  detailPath?: string,
): void {
  assertRetainedReconciliationTarget(target);
  observer?.(event, source, detailPath);
  assertRetainedReconciliationTarget(target);
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

function writeJournal(
  path: string,
  journal: ReconciliationJournal,
  parent: PrivateDirectoryHandle,
): void {
  journal.updatedAt = new Date().toISOString();
  atomicWritePrivateFile(path, `${JSON.stringify(journal, null, 2)}\n`, {}, parent);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mappedPathObservation(
  path: string,
  tolerateUnavailableParent: boolean,
): readonly string[] {
  const normalized = resolve(path);
  try {
    const stat = lstatSync(normalized);
    if (stat.isSymbolicLink()) return [normalized, "symlink"];
    if (!stat.isDirectory()) return [normalized, "non-directory"];
    let anchor: ReturnType<typeof resolveGitProjectAnchor>;
    try {
      anchor = resolveGitProjectAnchor(normalized);
    } catch (error) {
      return [normalized, "git-error", String(error)];
    }
    return anchor
      ? [normalized, "git", anchor.commonDir, anchor.canonical]
      : [normalized, "directory"];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [normalized, "missing"];
    }
    if (tolerateUnavailableParent && code === "ENOTDIR") {
      return [normalized, "unavailable", code];
    }
    throw error;
  }
}

function mapFingerprint(
  map: Record<string, ProjectMapEntry>,
  strictHashes: ReadonlySet<string>,
): string {
  return fingerprint(
    Object.entries(map)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([hash, entry]) => [
        hash,
        resolve(entry.canonical),
        [...entry.aliases].map((alias) => resolve(alias)).sort(),
        entry.remoteProjectId ?? null,
        [entry.canonical, ...entry.aliases]
          .map((path) => mappedPathObservation(path, !strictHashes.has(hash)))
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
  targetHash: string,
  codexDir?: string,
  maxEntries?: number,
  observer?: (path: string) => void,
  strictSourceHashes: readonly string[] = [],
): ReconciliationDiscovery {
  const codex = codexCatalogueFingerprint(codexDir, maxEntries, observer);
  return reconciliationDiscoveryForSources(
    map,
    targetHash,
    codex,
    strictSourceHashes,
  );
}

function reconciliationDiscoveryForSources(
  map: Record<string, ProjectMapEntry>,
  targetHash: string,
  codex: CodexCatalogueObservation,
  strictSourceHashes: readonly string[],
): ReconciliationDiscovery {
  return {
    mapFingerprint: mapFingerprint(
      map,
      new Set([targetHash, ...strictSourceHashes]),
    ),
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

function assertNoRuntimeNativeTranscriptState(db: DatabaseSync): void {
  const nativeTables = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') AND lower(name) GLOB 'runtime_native_*'",
  ).iterate();
  for (const table of nativeTables) {
    if (db.prepare(`SELECT 1 FROM ${quoteIdentifier(String(table.name))} LIMIT 1`).get()) {
      throw new Error("legacy SQLite native transcript state cannot be reconciled safely");
    }
  }
}

function preflightNativeTranscriptSources(sources: readonly WorktreeReconciliationSource[]): void {
  for (const source of sources) {
    const sourcePath = join(source.projectDir, "db.sqlite");
    if (!isRegularFile(sourcePath)) continue;
    const database = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      assertNoRuntimeNativeTranscriptState(database);
    } finally {
      database.close();
    }
  }
}

function rows(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): SqlRow[] {
  return db.prepare(sql).all(...params) as SqlRow[];
}

function row(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): SqlRow | undefined {
  return db.prepare(sql).get(...params) as SqlRow | undefined;
}

function legacyEventsSchemaVersion(db: DatabaseSync): number {
  if (!tableExists(db, "schema_version")) return 1;
  const value = row(db, "SELECT version FROM schema_version")?.version;
  if (value === undefined) return 1;
  if (typeof value !== "number") {
    throw new Error(`legacy events database has invalid schema_version: ${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`legacy events database has invalid schema_version: ${String(value)}`);
  }
  if (value < 1) {
    throw new Error(`legacy events database has invalid schema_version: ${String(value)}`);
  }
  return value;
}

type ReconciliableMissingCwdState = {
  readonly observations: number;
  readonly lastObservedAt: number;
  readonly parkedAt: string | null;
};

function readReconciliableMissingCwdState(
  db: DatabaseSync,
  schemaVersion: number,
  side: "source" | "target",
): ReconciliableMissingCwdState | undefined {
  if (schemaVersion < 5) return undefined;
  if (!tableExists(db, "missing_cwd_state")) {
    throw new Error(`${side} events schema v5 is missing missing_cwd_state`);
  }
  const stateRows = rows(
    db,
    "SELECT id, observations, last_observed_at, parked_at FROM missing_cwd_state",
  );
  if (stateRows.length === 0) return undefined;
  if (stateRows.length !== 1) {
    throw new Error(`${side} events schema v5 has conflicting missing-CWD state rows`);
  }
  const state = stateRows[0]!;
  if (!isValidMissingCwdStateRow(db, state)) {
    throw new Error(`${side} events schema v5 has invalid missing-CWD state`);
  }
  return {
    observations: state.observations,
    lastObservedAt: state.last_observed_at,
    parkedAt: state.parked_at,
  };
}

/**
 * Merge copied sidecar evidence as an idempotent join, never as a sum.
 * Stronger observation count and recency win independently; parking is
 * monotonic and retains the earliest timestamp at which any copy parked.
 * SQLite datetime('now') emits fixed-width UTC `YYYY-MM-DD HH:MM:SS`, so
 * lexicographic ordering is chronological for every parked_at value produced
 * by EventsDb. Reconciliation preserves that canonical representation.
 */
function mergeMissingCwdState(
  source: DatabaseSync,
  target: DatabaseSync,
  sourceSchemaVersion: number,
  targetSchemaVersion: number,
): void {
  const sourceState = readReconciliableMissingCwdState(
    source,
    sourceSchemaVersion,
    "source",
  );
  const targetState = readReconciliableMissingCwdState(
    target,
    targetSchemaVersion,
    "target",
  );
  if (!sourceState) return;
  const parkedAt = [targetState?.parkedAt, sourceState.parkedAt]
    .filter((value): value is string => value !== null && value !== undefined)
    .sort()[0] ?? null;
  target.prepare(`
    INSERT INTO missing_cwd_state(id, observations, last_observed_at, parked_at)
    VALUES(1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      observations = excluded.observations,
      last_observed_at = excluded.last_observed_at,
      parked_at = excluded.parked_at
  `).run(
    Math.max(targetState?.observations ?? 0, sourceState.observations),
    Math.max(targetState?.lastObservedAt ?? 0, sourceState.lastObservedAt),
    parkedAt,
  );
}

function comparable(value: unknown): string {
  return JSON.stringify(value);
}

function rowsEqual(left: SqlRow[], right: SqlRow[]): boolean {
  return comparable(left) === comparable(right);
}

const PASSIVE_EVENT_IMMUTABLE_COLUMNS = [
  "event_uuid",
  "event_version",
  "session_id",
  "seq",
  "type",
  "category",
  "data",
  "priority",
  "source_hook",
  "created_at",
] as const;

const PASSIVE_EVENT_DELIVERY_COLUMNS = [
  "delivery_state",
  "delivery_generation",
  "delivery_attempts",
  "delivery_owner",
  "delivery_claimed_at",
  "delivery_next_attempt_at",
  "delivery_last_error",
  "remote_inbox_id",
  "quarantine_reason",
  "acknowledged_at",
  "remote_pruned_at",
] as const;

function hasSamePassiveEventImmutableEnvelope(
  existing: SqlRow,
  incoming: SqlRow,
): boolean {
  return [
    ...PASSIVE_EVENT_IMMUTABLE_COLUMNS,
    "machine_id",
    "machine_sequence",
  ].every((column) =>
    comparable(existing[column]) === comparable(incoming[column])
  );
}

function legacyEventUuidForCandidate(
  value: SqlRow,
  candidateEventId: number,
): string {
  return deriveLegacyLocalHookEventUuid({
    event_id: candidateEventId,
    session_id: String(value.session_id),
    seq: Number(value.seq),
    type: String(value.type),
    category: String(value.category),
    data: String(value.data),
    priority: Number(value.priority),
    source_hook: String(value.source_hook),
    created_at: String(value.created_at),
  });
}

function isProvablyMigratedLegacyEventPair(
  existing: SqlRow,
  incoming: SqlRow,
  incomingSourceId: number,
): boolean {
  if (
    existing.event_version !== 1
    || incoming.event_version !== 1
    || typeof existing.event_uuid !== "string"
    || existing.event_uuid !== incoming.event_uuid
    || PASSIVE_EVENT_IMMUTABLE_COLUMNS.some((column) =>
      comparable(existing[column]) !== comparable(incoming[column]))
  ) {
    return false;
  }
  const existingId = Number(existing.event_id);
  return [existingId, incomingSourceId].some((candidateEventId) =>
    legacyEventUuidForCandidate(existing, candidateEventId) === existing.event_uuid
    && legacyEventUuidForCandidate(incoming, candidateEventId) === incoming.event_uuid);
}

function isPristineMigratedLegacyDelivery(value: SqlRow): boolean {
  return value.delivery_state === "pending"
    && value.delivery_generation === 0
    && value.delivery_attempts === 0
    && value.delivery_owner === null
    && value.delivery_claimed_at === null
    && value.delivery_last_error === null
    && value.remote_inbox_id === null
    && value.quarantine_reason === null
    && value.acknowledged_at === null
    && value.remote_pruned_at === null
    && value.delivery_next_attempt_at === value.created_at
    && value.delivery_updated_at === value.created_at;
}

function hasPassiveEventTransportProgress(value: SqlRow): boolean {
  return comparable([
    value.delivery_state,
    value.delivery_attempts,
    value.delivery_owner,
    value.delivery_claimed_at,
    value.delivery_last_error,
    value.remote_inbox_id,
    value.quarantine_reason,
    value.acknowledged_at,
    value.remote_pruned_at,
  ]) !== comparable([
    "pending",
    0,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
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
    `SELECT summary_id, conversation_id, kind, depth, content, token_count,
            earliest_at, latest_at, descendant_count, descendant_token_count,
            source_message_token_count, created_at, file_ids
       FROM summaries WHERE conversation_id = ? ORDER BY summary_id`,
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

function mergeInstructionCacheRows(
  source: DatabaseSync,
  target: DatabaseSync,
  targetHash: string,
): void {
  // The scoped cache schema supersedes the legacy timestamp merge policy:
  // timestamps cannot authorize overwriting the same project/scope identity.
  // Exact duplicates deduplicate; any residual difference fails closed.
  mergeUniqueRows(
    source,
    target,
    "session_instruction_cache",
    [
      "project_id",
      "scope_hash",
    ],
    (value) => ({ ...value, project_id: targetHash }),
  );
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
  for (const table of tables) {
    const tableName = String(table.name);
    const tableDigest = createHash("sha256").update(tableName).digest("hex");
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const triggerName =
        `lcm_reconciliation_fence_${tableDigest}_${operation.toLowerCase()}`;
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

function withNormalizedMainSnapshot<T>(
  source: DatabaseSync,
  targetPath: string,
  fts5AvailableOverride: boolean | undefined,
  assertTarget: () => void,
  operation: (
    normalizedSource: DatabaseSync,
    features: { readonly fts5Available: boolean },
  ) => T,
): T {
  assertTarget();
  const snapshotDir = mkdtempSync(
    join(dirname(targetPath), ".lcm-reconciliation-snapshot-"),
  );
  assertTarget();
  const snapshotDirectory = openPrivateDirectory(snapshotDir, {
    expectedUid: process.getuid?.(),
  });
  const snapshotPath = join(snapshotDir, "db.sqlite");
  let snapshot: DatabaseSync | undefined;
  let result: T | undefined;
  let primaryError: unknown;
  try {
    assertPrivateDirectoryEntry(snapshotDirectory, snapshotDir, snapshotDirectory.witness.uid);
    assertTarget();
    source.prepare("VACUUM INTO ?").run(snapshotPath);
    assertTarget();
    snapshot = new DatabaseSync(snapshotPath);
    for (const trigger of rows(
      snapshot,
      `SELECT name FROM sqlite_schema
         WHERE type = 'trigger' AND name LIKE 'lcm_reconciliation_fence_%'`,
    )) {
      snapshot.exec(`DROP TRIGGER ${quoteIdentifier(String(trigger.name))}`);
    }
    const features = fts5AvailableOverride === undefined
      ? getLcmDbFeatures(snapshot)
      : { fts5Available: fts5AvailableOverride };
    assertTarget();
    runLcmMigrations(snapshot, features);
    assertTarget();
    result = operation(snapshot, features);
    assertTarget();
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    snapshot?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    assertTarget();
    assertPrivateDirectoryEntry(snapshotDirectory, snapshotDir, snapshotDirectory.witness.uid);
    rmSync(snapshotDir, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    snapshotDirectory.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `worktree reconciliation failed before safe snapshot cleanup: ${String(primaryError)}`,
      { cause: primaryError },
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "normalized reconciliation snapshot cleanup failed");
  }
  return result as T;
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
      // Recheck under the write lock: ingestion may race the read-only preflight.
      if (kind === "project") assertNoRuntimeNativeTranscriptState(source);
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

function rollbackTargetReconciliationTransaction(
  target: DatabaseSync,
  committed: boolean,
  primaryError: unknown,
): never {
  if (!committed && target.isTransaction !== false) {
    try {
      target.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [primaryError, rollbackError],
        `worktree reconciliation target transaction failed: ${String(primaryError)}`,
        { cause: primaryError },
      );
    }
  }
  throw primaryError;
}

function mergeMainDatabase(
  sourcePath: string,
  targetPath: string,
  targetHash: string,
  sourceHash: string,
  busyTimeoutMs: number,
  assertTarget: () => void,
  fts5AvailableOverride?: boolean,
  afterSourceFenceCommit?: () => void,
): void {
  assertTarget();
  withSourceWriteFence(sourcePath, sourceHash, "project", busyTimeoutMs, (
    source,
    commitFence,
  ) => {
    commitFence();
    assertTarget();
    return withNormalizedMainSnapshot(
      source,
      targetPath,
      fts5AvailableOverride,
      assertTarget,
      (normalizedSource, features) => {
        assertTarget();
        const target = getLcmConnection(targetPath);
        try {
          assertTarget();
          runLcmMigrations(target, features);
          assertTarget();
          target.exec(`
            CREATE TABLE IF NOT EXISTS worktree_reconciliation_sources (
              source_hash TEXT PRIMARY KEY,
              merged_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `);
          assertTarget();
          target.exec("BEGIN IMMEDIATE");
          let committed = false;
          try {
            afterSourceFenceCommit?.();
            assertTarget();
            if (
              row(
                target,
                "SELECT source_hash FROM worktree_reconciliation_sources WHERE source_hash = ?",
                sourceHash,
              )
            ) {
              assertTarget();
              target.exec("COMMIT");
              committed = true;
              assertTarget();
              return;
            }
            for (const conversation of rows(
              normalizedSource,
              "SELECT * FROM conversations ORDER BY conversation_id",
            )) {
              copyConversation(normalizedSource, target, conversation);
            }
            mergeUniqueRows(normalizedSource, target, "promoted", ["id"], (value) => ({
              ...value,
              project_id: targetHash,
            }));
            mergeUniqueRows(normalizedSource, target, "session_ingest_log", ["session_id"]);
            mergeUniqueRows(
              normalizedSource,
              target,
              "recall_surfacing",
              ["memory_id", "session_id", "surfaced_at"],
              (value) => {
                const { id: _id, ...rest } = value;
                return rest;
              },
            );
            mergeInstructionCacheRows(normalizedSource, target, targetHash);
            if (tableExists(normalizedSource, "redaction_stats")) {
              for (const count of rows(
                normalizedSource,
                "SELECT category, count FROM redaction_stats",
              )) {
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
            assertTarget();
            target.exec("COMMIT");
            committed = true;
            assertTarget();
          } catch (error) {
            rollbackTargetReconciliationTransaction(target, committed, error);
          }
        } finally {
          closeLcmConnection(targetPath, target);
        }
        assertTarget();
      },
    );
  });
  assertTarget();
}

function mergeEventsDatabase(
  sourcePath: string,
  targetPath: string,
  sourceHash: string,
  busyTimeoutMs: number,
  assertTarget: () => void,
  afterTargetMigration: () => void,
  afterSourceFenceCommit?: () => void,
): void {
  assertTarget();
  withSourceWriteFence(sourcePath, sourceHash, "events", busyTimeoutMs, (
    source,
    commitFence,
  ) => {
    assertTarget();
    const migratedTarget = new EventsDb(targetPath);
    migratedTarget.close();
    assertTarget();
    // Deterministic audit seam between live-schema migration and the
    // independently versioned reconciliation admission check.
    afterTargetMigration();
    assertTarget();
    const target = getLcmConnection(targetPath);
    try {
      assertTarget();
      const targetSchemaVersion = legacyEventsSchemaVersion(target);
      if (targetSchemaVersion > MAX_RECONCILIABLE_EVENT_SCHEMA_VERSION) {
        throw new Error(
          `unsupported target events database schema: ${String(targetSchemaVersion)}`,
        );
      }
      target.exec(`
        CREATE TABLE IF NOT EXISTS worktree_reconciliation_sources (
          source_hash TEXT PRIMARY KEY,
          merged_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      assertTarget();
      target.exec("BEGIN IMMEDIATE");
      let committed = false;
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
          assertTarget();
          target.exec("COMMIT");
          committed = true;
          assertTarget();
          return;
        }
        const sourceSchemaVersion = legacyEventsSchemaVersion(source);
        if (sourceSchemaVersion > MAX_RECONCILIABLE_EVENT_SCHEMA_VERSION) {
          throw new Error(
            `unsupported legacy events database schema: ${String(sourceSchemaVersion)}`,
          );
        }
        const sourceEvents = rows(source, "SELECT * FROM events ORDER BY event_id");
        assertTarget();
        const legacySequences = sourceSchemaVersion < 4
          ? allocateLocalHookEventSequences(
            sourceEvents.length,
            join(dirname(targetPath), ".machine-sequence.sqlite"),
          )
          : [];
        assertTarget();
        const sourceEventIds = new Set(sourceEvents.map((event) => Number(event.event_id)));
        const eventMap = new Map<number, number>();
        for (let sourceIndex = 0; sourceIndex < sourceEvents.length; sourceIndex++) {
          const sourceEvent = sourceEvents[sourceIndex]!;
          const sourceId = Number(sourceEvent.event_id);
          const legacyCreatedAt = typeof sourceEvent.created_at === "string"
            ? sourceEvent.created_at
            : "1970-01-01 00:00:00";
          const previousSourceId = sourceEvent.prev_event_id === null
            ? null
            : Number(sourceEvent.prev_event_id);
          if (
            previousSourceId !== null
            && sourceEventIds.has(previousSourceId)
            && !eventMap.has(previousSourceId)
          ) {
            throw new Error(
              `event ${sourceId} references an unmapped predecessor ${previousSourceId}`,
            );
          }
          const mappedPreviousId = previousSourceId === null
            ? null
            : eventMap.get(previousSourceId) ?? null;
          const existingVersionedEvent = sourceSchemaVersion >= 4
            ? row(
              target,
              "SELECT * FROM events WHERE event_uuid = ?",
              sourceEvent.event_uuid,
            )
            : undefined;
          // A predecessor pruned from both copies has no map entry. Preserve
          // its numeric identity only when the destination proves no remap.
          const preserveDanglingPreviousId = (
            previousSourceId !== null
            && mappedPreviousId === null
            && !sourceEventIds.has(previousSourceId)
            && existingVersionedEvent !== undefined
            && comparable(existingVersionedEvent.prev_event_id)
              === comparable(previousSourceId)
            && hasSamePassiveEventImmutableEnvelope(
              existingVersionedEvent,
              sourceEvent,
            )
            && !row(
              target,
              "SELECT event_id FROM events WHERE event_id = ?",
              previousSourceId,
            )
          );
          const reconciledPreviousId = preserveDanglingPreviousId
            ? previousSourceId
            : mappedPreviousId;
          if (
            sourceSchemaVersion >= 4
            && comparable(reconciledPreviousId) !== comparable(previousSourceId)
            && hasPassiveEventTransportProgress(sourceEvent)
          ) {
            throw new Error(
              `cannot remap delivered passive event predecessor: ${String(sourceEvent.event_uuid)}`,
            );
          }
          const value: SqlRow = sourceSchemaVersion < 4 ? {
            event_uuid: deriveLegacyLocalHookEventUuid({
              event_id: sourceId,
              session_id: String(sourceEvent.session_id),
              seq: Number(sourceEvent.seq),
              type: String(sourceEvent.type),
              category: String(sourceEvent.category),
              data: String(sourceEvent.data),
              priority: Number(sourceEvent.priority),
              source_hook: String(sourceEvent.source_hook),
              created_at: legacyCreatedAt,
            }),
            event_version: 1,
            machine_id: null,
            machine_sequence: formatLocalHookMachineSequence(legacySequences[sourceIndex]!),
            session_id: sourceEvent.session_id,
            seq: sourceEvent.seq,
            type: sourceEvent.type,
            category: sourceEvent.category,
            data: sourceEvent.data,
            priority: sourceEvent.priority,
            source_hook: sourceEvent.source_hook,
            prev_event_id: reconciledPreviousId,
            processed_at: sourceEvent.processed_at,
            created_at: legacyCreatedAt,
            delivery_state: "pending",
            delivery_generation: 0,
            delivery_attempts: 0,
            delivery_owner: null,
            delivery_claimed_at: null,
            delivery_next_attempt_at: legacyCreatedAt,
            delivery_last_error: null,
            remote_inbox_id: null,
            quarantine_reason: null,
            acknowledged_at: null,
            remote_pruned_at: null,
            delivery_updated_at: legacyCreatedAt,
          } : {
            ...sourceEvent,
            prev_event_id: reconciledPreviousId,
          };
          delete value.event_id;
          const existing = sourceSchemaVersion >= 4
            ? existingVersionedEvent
            : row(
              target,
              "SELECT * FROM events WHERE event_uuid = ?",
              value.event_uuid,
            );
          let targetId: number;
          if (!existing) {
            targetId = Number(insertRow(target, "events", value));
          } else {
            targetId = Number(existing.event_id);
            if (
              PASSIVE_EVENT_IMMUTABLE_COLUMNS.some((column) =>
                comparable(existing[column]) !== comparable(value[column]))
              || (
                sourceSchemaVersion >= 4
                && existing.machine_id !== null
                && value.machine_id !== null
                && comparable(existing.machine_id) !== comparable(value.machine_id)
              )
            ) {
              throw new Error(`divergent passive event UUID collision: ${String(value.event_uuid)}`);
            }
            const sequenceDiffers = sourceSchemaVersion >= 4
              && comparable(existing.machine_sequence)
                !== comparable(value.machine_sequence);
            let reconciledSequence = existing.machine_sequence;
            let preferredDelivery: SqlRow | undefined;
            if (sequenceDiffers) {
              if (
                !isProvablyMigratedLegacyEventPair(existing, value, sourceId)
                || typeof existing.machine_sequence !== "string"
                || typeof value.machine_sequence !== "string"
              ) {
                throw new Error(`divergent passive event UUID collision: ${String(value.event_uuid)}`);
              }
              const existingPristine = isPristineMigratedLegacyDelivery(existing);
              const incomingPristine = isPristineMigratedLegacyDelivery(value);
              if (!existingPristine && !incomingPristine) {
                throw new Error(`divergent passive event UUID collision: ${String(value.event_uuid)}`);
              }
              if (existingPristine && incomingPristine) {
                const existingSequence = parseLocalHookMachineSequence(
                  existing.machine_sequence,
                );
                const incomingSequence = parseLocalHookMachineSequence(
                  value.machine_sequence,
                );
                reconciledSequence = incomingSequence < existingSequence
                  ? value.machine_sequence
                  : existing.machine_sequence;
                preferredDelivery = existing;
              } else {
                preferredDelivery = existingPristine ? value : existing;
                reconciledSequence = preferredDelivery.machine_sequence;
              }
              if (
                reconciledSequence !== existing.machine_sequence
                && row(
                  target,
                  `SELECT event_uuid FROM events
                   WHERE machine_sequence = ? AND event_uuid <> ?`,
                  reconciledSequence,
                  value.event_uuid,
                )
              ) {
                throw new Error(
                  `divergent passive event machine sequence collision: ${String(value.event_uuid)}`,
                );
              }
            }
            const existingGeneration = Number(existing.delivery_generation);
            const sourceGeneration = Number(value.delivery_generation);
            if (
              !Number.isSafeInteger(existingGeneration)
              || !Number.isSafeInteger(sourceGeneration)
              || existingGeneration < 0
              || sourceGeneration < 0
            ) {
              throw new Error(`invalid passive event delivery generation: ${String(value.event_uuid)}`);
            }
            if (
              comparable(existing.prev_event_id) !== comparable(value.prev_event_id)
              && (
                hasPassiveEventTransportProgress(existing)
                || hasPassiveEventTransportProgress(value)
              )
            ) {
              throw new Error(
                `cannot reconcile delivered passive event predecessor: ${String(value.event_uuid)}`,
              );
            }
            if (
              existing.prev_event_id !== null
              && value.prev_event_id !== null
              && comparable(existing.prev_event_id) !== comparable(value.prev_event_id)
            ) {
              throw new Error(`divergent passive event predecessor: ${String(value.event_uuid)}`);
            }
            if (
              preferredDelivery === undefined
              && sourceGeneration === existingGeneration
              && PASSIVE_EVENT_DELIVERY_COLUMNS.some((column) =>
                comparable(existing[column]) !== comparable(value[column]))
            ) {
              throw new Error(`divergent passive event delivery state: ${String(value.event_uuid)}`);
            }
            const earliest = (
              left: SQLInputValue,
              right: SQLInputValue,
            ): SQLInputValue => {
              if (left === null) return right;
              if (right === null) return left;
              return comparable(left) <= comparable(right) ? left : right;
            };
            const latest = (
              left: SQLInputValue,
              right: SQLInputValue,
            ): SQLInputValue => comparable(left) >= comparable(right) ? left : right;
            const sourceWins = sourceGeneration > existingGeneration;
            const deliverySource = preferredDelivery
              ?? (sourceWins ? value : existing);
            const merged: SqlRow = {
              machine_id: existing.machine_id ?? value.machine_id,
              machine_sequence: reconciledSequence,
              prev_event_id: existing.prev_event_id ?? value.prev_event_id,
              processed_at: earliest(existing.processed_at, value.processed_at),
              ...Object.fromEntries(PASSIVE_EVENT_DELIVERY_COLUMNS.map((column) => [
                column,
                deliverySource[column],
              ])),
              delivery_updated_at: preferredDelivery !== undefined
                ? preferredDelivery.delivery_updated_at
                : sourceGeneration === existingGeneration
                ? latest(existing.delivery_updated_at, value.delivery_updated_at)
                : sourceWins
                  ? value.delivery_updated_at
                  : existing.delivery_updated_at,
            };
            const mutableColumns = [
              "machine_id",
              "machine_sequence",
              "prev_event_id",
              "processed_at",
              ...PASSIVE_EVENT_DELIVERY_COLUMNS,
              "delivery_updated_at",
            ] as const;
            if (mutableColumns.some((column) =>
              comparable(existing[column]) !== comparable(merged[column]))) {
              target.prepare(`
                UPDATE events
                SET ${mutableColumns.map((column) => `${column} = ?`).join(", ")}
                WHERE event_id = ?
              `).run(...mutableColumns.map((column) => merged[column]), targetId);
            }
          }
          eventMap.set(sourceId, targetId);
        }
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
        mergeMissingCwdState(
          source,
          target,
          sourceSchemaVersion,
          targetSchemaVersion,
        );
        target
          .prepare("INSERT INTO worktree_reconciliation_sources(source_hash) VALUES(?)")
          .run(sourceHash);
        commitFence();
        afterSourceFenceCommit?.();
        assertTarget();
        target.exec("COMMIT");
        committed = true;
        assertTarget();
      } catch (error) {
        rollbackTargetReconciliationTransaction(target, committed, error);
      }
    } finally {
      closeLcmConnection(targetPath, target);
    }
    assertTarget();
  });
  assertTarget();
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
  targetParent: PrivateDirectoryHandle,
  assertTarget: () => void,
): void {
  assertTarget();
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
  if (!sourceExists) {
    assertTarget();
    return;
  }
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
  assertTarget();
  const targetExists = isRegularFile(targetPath);
  const target = targetExists
    ? readBoundedRegularFile(targetPath, { allowedRoot: targetDir, maxBytes: MAX_PATTERN_BYTES })
    : "";
  assertTarget();
  const targetEffective = new Set(effectivePatterns(target));
  const additions = [...new Set(effectivePatterns(sourceContent))]
    .filter((pattern) => !targetEffective.has(pattern));
  if (additions.length === 0) {
    if (!targetExists) atomicWritePrivateFile(targetPath, "", {}, targetParent);
    assertTarget();
    return;
  }
  const separator = target.length === 0 || target.endsWith("\n") ? "" : "\n";
  atomicWritePrivateFile(
    targetPath,
    `${target}${separator}${additions.join("\n")}\n`,
    {},
    targetParent,
  );
  assertTarget();
}

function writeCanonicalTargetMetadata(
  targetDir: string,
  canonical: string,
  targetParent: PrivateDirectoryHandle,
  assertTarget: () => void,
): void {
  assertTarget();
  const metaPath = join(targetDir, "meta.json");
  let metadata: Record<string, unknown> = {};
  if (existsSync(metaPath)) {
    if (!isRegularFile(metaPath)) {
      throw new Error(`invalid canonical project metadata path: ${metaPath}`);
    }
    const parsed = JSON.parse(readBoundedRegularFile(metaPath, {
      allowedRoot: targetDir,
      maxBytes: MAX_PROJECT_METADATA_BYTES,
      expectedUid: targetParent.witness.uid,
      requireSingleLink: true,
    })) as unknown;
    assertTarget();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`invalid canonical project metadata: ${metaPath}`);
    }
    metadata = parsed as Record<string, unknown>;
    if (metadata.cwd === canonical) {
      assertTarget();
      return;
    }
  }
  atomicWritePrivateFile(
    metaPath,
    `${JSON.stringify({ ...metadata, cwd: canonical }, null, 2)}\n`,
    {},
    targetParent,
  );
  assertTarget();
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

function isProjectPathFence(path: string, hash: string): boolean {
  return isWorktreeReconciliationFence(path, hash, "project");
}

function isEventsPathFence(path: string, hash: string): boolean {
  return isWorktreeReconciliationFence(path, hash, "events");
}

function installFilesystemFences(
  source: WorktreeReconciliationSource,
  observe: (event: string, path: string) => void,
): void {
  if (!existsSync(source.projectDir)) {
    observe("before-project-path-fence", source.projectDir);
    if (!atomicWritePrivateFileExclusive(
      source.projectDir,
      serializeWorktreeReconciliationFence(source.hash, "project"),
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
      atomicWritePrivateFileExclusive(
        marker,
        serializeWorktreeReconciliationFence(source.hash, "events"),
      );
    } else if (!isEventsPathFence(prepared, source.hash)) {
      throw new Error(`invalid prepared events fence: ${prepared}`);
    }
    observe("before-events-path-fence-publish", source.eventsPath);
    renameSync(prepared, source.eventsPath);
  } else if (!isEventsPathFence(source.eventsPath, source.hash)) {
    throw new Error(`legacy events path remained writable after reconciliation: ${source.eventsPath}`);
  }
}

function archiveEventFileNoReplace(
  sourcePath: string,
  destination: string,
  recordBackup: (path: string) => void,
  observe: (event: string, path: string) => void,
): void {
  const sourceStat = lstatSync(sourcePath);
  if (!sourceStat.isFile()) {
    throw new Error(`invalid legacy events state path: ${sourcePath}`);
  }
  if (existsSync(destination)) {
    const destinationStat = lstatSync(destination);
    if (
      !destinationStat.isFile()
      || `${destinationStat.dev}:${destinationStat.ino}`
        !== `${sourceStat.dev}:${sourceStat.ino}`
    ) {
      throw new Error(`legacy events archive destination is already occupied: ${destination}`);
    }
    unlinkSync(sourcePath);
    observe("after-source-archive-rename", destination);
    return;
  }
  recordBackup(destination);
  observe("before-source-archive-rename", destination);
  try {
    linkSync(sourcePath, destination);
  } catch {
    throw new Error(`legacy events archive destination is already occupied: ${destination}`);
  }
  observe("after-source-archive-link", destination);
  unlinkSync(sourcePath);
  observe("after-source-archive-rename", destination);
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
    archiveEventFileNoReplace(
      source.eventsPath,
      eventsDestination,
      recordBackup,
      observeRename,
    );
  }
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${source.eventsPath}${suffix}`;
    if (!existsSync(sidecar)) continue;
    ensurePrivateDirectory(eventsRoot);
    const sidecarDestination = `${eventsDestination}${suffix}`;
    archiveEventFileNoReplace(
      sidecar,
      sidecarDestination,
      recordBackup,
      observeRename,
    );
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
      let anchor: ReturnType<typeof resolveGitProjectAnchor>;
      try {
        anchor = resolveGitProjectAnchor(entry.canonical);
      } catch {
        continue;
      }
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
    /** @internal Token held by a caller that already has publication admission. */
    readonly _publicationLockToken?: BackendPublicationLockToken;
  } = {},
): WorktreeReconciliationResult {
  if (opts._publicationLockToken === undefined) {
    return withBackendPublicationConsumerLock(opts.homeDir, (publicationLockToken) =>
      reconcileWorktrees(path, {
        ...opts,
        _publicationLockToken: publicationLockToken,
      }));
  }
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
  const sourceBusyTimeoutMs = normalizeSourceBusyTimeoutMs(opts._sourceBusyTimeoutMs);
  if (!opts.dryRun) {
    const fastJournal = readJournal(journalFile);
    const fastMap = listProjectMapEntries(opts.homeDir, opts._publicationLockToken);
    if (
      fastJournal?.phase === "completed"
      && resolve(fastJournal.canonical) === canonical
      && discoveriesEqual(
        fastJournal.discovery,
        reconciliationDiscovery(
          fastMap,
          targetHash,
          opts._codexDir,
          opts._maxDiscoveryEntries,
          opts._discoveryObserver,
          fastJournal.sourceHashes,
        ),
      )
    ) {
      return resultFromJournal(fastJournal, journalFile);
    }
  }
  const executeLocked = (
    map: Record<string, ProjectMapEntry>,
    completion: { marked: boolean },
    retainedJournalParent: RetainedReconciliationJournalParent | undefined,
    blockedRecording: { attempted: boolean },
  ): WorktreeReconciliationResult => {
    const assertJournalParent = (): void => {
      if (retainedJournalParent !== undefined) {
        assertRetainedReconciliationJournalParent(retainedJournalParent);
      }
    };
    const writeAttemptJournal = (journal: ReconciliationJournal): void => {
      writeJournal(journalFile, journal, retainedJournalParent!.directory);
    };
    const throwAfterBlockedRecording = (
      primaryError: unknown,
      record: () => void,
    ): never => {
      if (preservesReconciliationErrorClassification(primaryError)) throw primaryError;
      blockedRecording.attempted = true;
      try {
        record();
      } catch (recordingError) {
        throw new AggregateError(
          [primaryError, recordingError],
          `worktree reconciliation failed and blocked journal could not be recorded: ${String(primaryError)}`,
          { cause: primaryError },
        );
      }
      throw primaryError;
    };

    assertJournalParent();
    opts._observer?.("after-map-preflight");
    assertJournalParent();
    const existingJournal = readJournal(journalFile);
    assertJournalParent();
    if (
      existingJournal
      && resolve(existingJournal.canonical) !== canonical
    ) {
      throw new Error("worktree reconciliation journal does not match the requested project");
    }
    const codexDiscovery = codexCatalogueFingerprint(
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
    const discovery = reconciliationDiscoveryForSources(
      map,
      targetHash,
      codexDiscovery,
      discovered.sources.map(({ hash }) => hash),
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
        writeAttemptJournal(completed);
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
    // Admit every source before any source fencing, snapshot migration or target write.
    preflightNativeTranscriptSources(sources);
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
    const sourceComponents = journal.sourceComponents;
    for (const source of sources) {
      const current = sourceComponentSnapshot(source);
      let expected = sourceComponents[source.hash];
      if (!expected) {
        if (journal.phase !== "planned") {
          throw new Error(
            `worktree reconciliation journal lacks a component snapshot for ${source.hash}`,
          );
        }
        sourceComponents[source.hash] = current;
        continue;
      }
      if (expected.patterns && expected.patternsDigest === undefined) {
        if (journal.phase !== "planned" || !current.patterns) {
          throw new Error(
            `worktree reconciliation journal lacks a patterns digest for ${source.hash}`,
          );
        }
        sourceComponents[source.hash] = current;
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
    writeAttemptJournal(journal);

    const reconcileRetainedTarget = (
      retainedTarget: RetainedReconciliationTarget,
    ): WorktreeReconciliationResult => {
      const targetDir = retainedTarget.targetPath;
      const targetDbPath = join(targetDir, "db.sqlite");
      const targetEventsPath = projectEventsPath(targetHash, opts.homeDir);
      const assertTarget = () => assertRetainedReconciliationTarget(retainedTarget);
      assertTarget();
      if (journal.phase === "planned") {
        for (const source of sources) {
          assertTarget();
          const sourceDbPath = join(source.projectDir, "db.sqlite");
          if (isRegularFile(sourceDbPath)) {
            observeRetainedReconciliationTarget(
              retainedTarget,
              opts._observer,
              "before-source-main-merge",
              source,
            );
            mergeMainDatabase(
              sourceDbPath,
              targetDbPath,
              targetHash,
              source.hash,
              sourceBusyTimeoutMs,
              assertTarget,
              opts._fts5Available,
              () => observeRetainedReconciliationTarget(
                retainedTarget,
                opts._observer,
                "after-source-fence-commit-before-target-commit",
                source,
              ),
            );
          }
          if (isRegularFile(source.eventsPath)) {
            observeRetainedReconciliationTarget(
              retainedTarget,
              opts._observer,
              "before-source-events-merge",
              source,
            );
            mergeEventsDatabase(
              source.eventsPath,
              targetEventsPath,
              source.hash,
              sourceBusyTimeoutMs,
              assertTarget,
              () => observeRetainedReconciliationTarget(
                retainedTarget,
                opts._observer,
                "after-target-events-migration",
                source,
              ),
              () => observeRetainedReconciliationTarget(
                retainedTarget,
                opts._observer,
                "after-source-fence-commit-before-target-commit",
                source,
              ),
            );
          }
          observeRetainedReconciliationTarget(
            retainedTarget,
            opts._observer,
            "before-source-patterns-merge",
            source,
          );
          mergePatterns(
            source,
            targetDir,
            sourceComponents[source.hash]!,
            retainedTarget.target,
            assertTarget,
          );
          assertTarget();
        }
        writeCanonicalTargetMetadata(
          targetDir,
          canonical,
          retainedTarget.target,
          assertTarget,
        );
        assertTarget();
        journal.phase = "merged";
        writeAttemptJournal(journal);
        observeRetainedReconciliationTarget(
          retainedTarget,
          opts._observer,
          "after-merge-before-archive",
        );
      }
      if (journal.phase === "merged") {
        for (const source of sources) {
          assertTarget();
          const expected = sourceComponents[source.hash]!;
          assertNoUnmergedComponentsAppeared(
            source,
            expected,
            sourceComponentSnapshot(source),
          );
          assertTarget();
        }
        journal.archiveAt ??= (opts.now ?? new Date()).toISOString();
        writeAttemptJournal(journal);
        const now = new Date(journal.archiveAt);
        for (const source of sources) {
          assertTarget();
          archiveSource(source, opts.homeDir, now, (backupPath) => {
            assertTarget();
            journal.backupPaths.push(backupPath);
            writeAttemptJournal(journal);
            assertTarget();
          }, (event, detailPath) => observeRetainedReconciliationTarget(
            retainedTarget,
            opts._observer,
            event,
            source,
            detailPath,
          ));
          assertTarget();
          assertArchivedPatternsMatch(
            source,
            sourceComponents[source.hash]!,
            opts.homeDir,
            now,
          );
          observeRetainedReconciliationTarget(
            retainedTarget,
            opts._observer,
            "after-source-archive",
            source,
          );
        }
        assertTarget();
        journal.phase = "archived";
        writeAttemptJournal(journal);
      }
      observeRetainedReconciliationTarget(
        retainedTarget,
        opts._observer,
        "before-project-map-publication",
      );
      const currentMap = listProjectMapEntries(opts.homeDir, opts._publicationLockToken);
      assertTarget();
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
        assertTarget();
        foldProjectMapEntriesLocked({
          targetHash,
          canonical,
          sourceHashes: pendingSourceHashes,
          aliases,
          expectedRemoteProjectId: journal.remoteProjectId ?? null,
          homeDir: opts.homeDir,
          _publicationLockToken: opts._publicationLockToken,
          onBackupCreated: (backupPath) => {
            assertTarget();
            journal.backupPaths.push(backupPath);
            writeAttemptJournal(journal);
            assertTarget();
          },
          onMapPublished: () => observeRetainedReconciliationTarget(
            retainedTarget,
            opts._observer,
            "after-project-map-published",
          ),
        });
        assertTarget();
      }
      assertTarget();
      journal.pendingSourceHashes = [];
      journal.phase = "completed";
      const publishedMapDiscovery = reconciliationDiscovery(
        listProjectMapEntries(opts.homeDir, opts._publicationLockToken),
        targetHash,
        opts._codexDir,
        opts._maxDiscoveryEntries,
        opts._discoveryObserver,
      );
      journal.discovery = {
        mapFingerprint: publishedMapDiscovery.mapFingerprint,
        codexFingerprint: discovery.codexFingerprint,
        complete: discovery.complete && publishedMapDiscovery.complete,
      };
      writeAttemptJournal(journal);
      assertTarget();
      return resultFromJournal(journal, journalFile);
    };
    try {
      return withRetainedReconciliationTarget(
        targetHash,
        opts.homeDir,
        reconcileRetainedTarget,
        () => {
          completion.marked = true;
        },
      );
    } catch (error) {
      if (!completion.marked) {
        throwAfterBlockedRecording(error, () => {
          journal.blockedFrom = journal.phase === "merged" || journal.phase === "archived"
            ? journal.phase
            : journal.blockedFrom ?? "planned";
          journal.phase = "blocked";
          journal.reason = String(error);
          writeAttemptJournal(journal);
        });
      }
      throw error;
    }
  };

  const execute = (map: Record<string, ProjectMapEntry>): WorktreeReconciliationResult => {
    const completion = { marked: false };
    const blockedRecording = { attempted: false };
    const executeWithJournalParent = (
      retainedJournalParent: RetainedReconciliationJournalParent | undefined,
    ): WorktreeReconciliationResult => {
      try {
        return executeLocked(map, completion, retainedJournalParent, blockedRecording);
      } catch (error) {
        if (preservesReconciliationErrorClassification(error)) throw error;
        if (opts.dryRun) throw error;
        if (completion.marked || blockedRecording.attempted) throw error;
        blockedRecording.attempted = true;
        let current: ReconciliationJournal | null;
        try {
          assertRetainedReconciliationJournalParent(retainedJournalParent!);
          current = readJournal(journalFile);
          assertRetainedReconciliationJournalParent(retainedJournalParent!);
        } catch (recordingError) {
          throw new AggregateError(
            [error, recordingError],
            `worktree reconciliation failed and blocked journal could not be recorded: ${String(error)}`,
            { cause: error },
          );
        }
        if (current && resolve(current.canonical) !== canonical) throw error;
        try {
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
          writeJournal(journalFile, blocked, retainedJournalParent!.directory);
        } catch (recordingError) {
          throw new AggregateError(
            [error, recordingError],
            `worktree reconciliation failed and blocked journal could not be recorded: ${String(error)}`,
            { cause: error },
          );
        }
        throw error;
      }
    };

    if (opts.dryRun) return executeWithJournalParent(undefined);
    return withRetainedReconciliationJournalParent(
      opts.homeDir,
      executeWithJournalParent,
    );
  };

  if (opts.dryRun) return execute(readProjectMapSnapshot(opts.homeDir, opts._publicationLockToken));
  const lockWaitMs = opts._lockWaitMs ?? 5_000;
  const retryDelayMs = opts._lockRetryDelayMs ?? 50;
  const deadline = performance.now() + lockWaitMs;
  let retryWaiter: Int32Array | undefined;
  while (true) {
    try {
      return withPrivateMutationLock(
        reconciliationLockPath(targetHash, opts.homeDir),
        "worktree reconciliation",
        () => withProjectMapReconciliationLock(
          execute,
          opts.homeDir,
          opts._publicationLockToken,
        ),
      );
    } catch (error) {
      if (!(error instanceof PrivateMutationLockContentionError) || performance.now() >= deadline) {
        throw error;
      }
      Atomics.wait(
        retryWaiter ??= new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.min(retryDelayMs, Math.max(1, deadline - performance.now())),
      );
    }
  }
}

export function ensureWorktreeProjectReconciled(
  cwd: string,
  identity?: ProjectIdentity,
  opts: {
    /** @internal Override the bounded process-cache lifetime for deterministic tests. */
    readonly _cacheTtlMs?: number;
    /** @internal Override monotonic elapsed milliseconds for deterministic cache tests. */
    readonly _nowMs?: number;
    /** @internal Override ~/.codex for deterministic catalogue tests. */
    readonly _codexDir?: string;
    /** @internal Bound catalogue walks for deterministic tests. */
    readonly _maxDiscoveryEntries?: number;
    /** @internal Observe catalogue walks for deterministic tests. */
    readonly _discoveryObserver?: (path: string) => void;
    /** @internal Token held by a caller that already has publication admission. */
    readonly _publicationLockToken?: BackendPublicationLockToken;
  } = {},
): WorktreeReconciliationResult {
  if (opts._publicationLockToken === undefined) {
    return withBackendPublicationConsumerLock(undefined, (publicationLockToken) =>
      ensureWorktreeProjectReconciled(cwd, identity, {
        ...opts,
        _publicationLockToken: publicationLockToken,
      }));
  }
  const anchor = identity ? undefined : resolveGitProjectAnchor(cwd);
  if (!identity && !anchor) {
    return reconcileWorktrees(cwd, {
      _publicationLockToken: opts._publicationLockToken,
    });
  }
  const project = identity ?? {
    id: hashProjectPath(anchor!.canonical),
    canonical: anchor!.canonical,
  };
  const now = opts._nowMs ?? performance.now();
  const ttlMs = cacheTtlMs(opts._cacheTtlMs);
  const identityCanonical = resolve(project.canonical);
  const cached = reconciledThisProcess.get(project.id);
  const cacheIdentityMatches = cached?.identityCanonical === identityCanonical;
  const currentStateGuard = cached
    ? reconciliationCacheStateGuard(cached.targetHash)
    : null;
  if (
    cached
    && cacheIdentityMatches
    && currentStateGuard !== null
    && currentStateGuard === cached.stateGuard
    && now < cached.expiresAt
  ) {
    return {
      status: "completed",
      targetHash: project.id,
      canonical: project.canonical,
      sourceHashes: [],
      aliases: [project.canonical],
      backupPaths: [],
    };
  }
  if (identity) {
    const before = reconciliationDiscovery(
      listProjectMapEntries(undefined, opts._publicationLockToken),
      project.id,
      opts._codexDir,
      opts._maxDiscoveryEntries,
      opts._discoveryObserver,
    );
    if (
      cached
      && cacheIdentityMatches
      && currentStateGuard !== null
      && currentStateGuard === cached.stateGuard
      && before.complete
      && cached.discoveryFingerprint === fingerprint(before)
    ) {
      const stateGuard = reconciliationCacheStateGuard(cached.targetHash);
      if (stateGuard !== null) {
        reconciledThisProcess.set(project.id, {
          ...cached,
          stateGuard,
          expiresAt: now + ttlMs,
        });
      }
      return {
        status: "completed",
        targetHash: project.id,
        canonical: project.canonical,
        sourceHashes: [],
        aliases: [project.canonical],
        backupPaths: [],
      };
    }
  }
  const result = reconcileWorktrees(cwd, {
    _codexDir: opts._codexDir,
    _maxDiscoveryEntries: opts._maxDiscoveryEntries,
    _discoveryObserver: opts._discoveryObserver,
    _publicationLockToken: opts._publicationLockToken,
  });
  const publishedDiscovery = result.journalPath
    ? readJournal(result.journalPath)?.discovery
    : reconciliationDiscovery(
        listProjectMapEntries(undefined, opts._publicationLockToken),
        result.targetHash,
        opts._codexDir,
        opts._maxDiscoveryEntries,
        opts._discoveryObserver,
      );
  if (publishedDiscovery?.complete) {
    const stateGuard = reconciliationCacheStateGuard(result.targetHash);
    if (stateGuard !== null) {
      const entry: ReconciledProcessCacheEntry = {
        discoveryFingerprint: fingerprint(publishedDiscovery),
        identityCanonical,
        targetHash: result.targetHash,
        stateGuard,
        expiresAt: now + ttlMs,
      };
      reconciledThisProcess.set(project.id, entry);
      reconciledThisProcess.set(result.targetHash, entry);
    }
  }
  return result;
}

export function clearWorktreeReconciliationCache(): void {
  reconciledThisProcess.clear();
}

export function listWorktreeReconciliationJournals(homeDir?: string): ReconciliationJournal[] {
  return withBackendPublicationConsumerLock(homeDir, () => {
    const root = reconciliationDir(homeDir);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
      .map((entry) => readJournal(join(root, entry.name)))
      .filter((journal): journal is ReconciliationJournal => journal !== null);
  });
}
