import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  type BigIntStats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertPrivateDirectory,
  openPrivateDirectory,
  PRIVATE_FILE_MODE,
  requireSupportedProcessUid,
  retainedDirectoryDescriptorPath,
  type PrivateDirectoryHandle,
} from "../security-files.js";
import {
  admitDatabaseParent,
  sameDatabaseParentWitness,
  type DatabaseParentIdentity,
  type DatabaseParentTestingOptions,
} from "./database-parent.js";

type ConnectionEntry = {
  db: DatabaseSync;
  refs: number;
  fileIdentity: DatabaseFileIdentity | null;
  parentIdentity: DatabaseParentIdentity | null;
};

// Decimal strings rather than numbers: a device or inode beyond
// Number.MAX_SAFE_INTEGER would round, and two distinct rounded values
// comparing equal is a silent admission. Strings also match the identity shape
// the database parent already publishes, and survive the JSON journals that
// carry these identities.
type DatabaseFileIdentity = {
  device: string;
  inode: string;
};

function sameDatabaseFileIdentity(
  left: DatabaseFileIdentity,
  right: DatabaseFileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

const _connections = new Map<string, ConnectionEntry>();
const _connectionLocks = new Map<string, Promise<void>>();

export async function withLcmConnectionLock<T>(
  dbPath: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const previous = _connectionLocks.get(dbPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  _connectionLocks.set(dbPath, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (_connectionLocks.get(dbPath) === queued) _connectionLocks.delete(dbPath);
  }
}

export interface YieldingLcmConnectionLock {
  /** Run slow non-database work without blocking queued users of this database. */
  yieldWhile<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Serialize database work while allowing the owner to yield around slow work
 * that does not touch the connection, such as an external summarizer call.
 */
export async function withYieldingLcmConnectionLock<T>(
  dbPath: string,
  operation: (lock: YieldingLcmConnectionLock) => Promise<T>,
): Promise<T> {
  let releaseCurrent: (() => void) | undefined;
  let queuedCurrent: Promise<void> | undefined;

  const acquire = async (): Promise<void> => {
    const previous = _connectionLocks.get(dbPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    _connectionLocks.set(dbPath, queued);
    await previous;
    releaseCurrent = release;
    queuedCurrent = queued;
  };

  const release = (): void => {
    releaseCurrent?.();
    if (queuedCurrent && _connectionLocks.get(dbPath) === queuedCurrent) {
      _connectionLocks.delete(dbPath);
    }
    releaseCurrent = undefined;
    queuedCurrent = undefined;
  };

  await acquire();
  try {
    return await operation({
      yieldWhile: async <U>(slowOperation: () => Promise<U>): Promise<U> => {
        release();
        try {
          return await slowOperation();
        } finally {
          await acquire();
        }
      },
    });
  } finally {
    release();
  }
}

function isConnectionHealthy(db: DatabaseSync): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

function forceCloseConnection(entry: ConnectionEntry): void {
  try {
    entry.db.close();
  } catch {
    // Ignore close failures; caller is already replacing/removing this handle.
  }
}

function getPooledLcmConnection(dbPath: string): DatabaseSync | undefined {
  // No TOCTOU race here: Node.js is single-threaded and this function is
  // synchronous. There is no await/yield between the health check and the
  // refs increment, so no other caller can interleave and close the connection
  // in between. The sequence (check => increment => return) is atomic w.r.t.
  // the JavaScript event loop.
  const existing = _connections.get(dbPath);
  if (existing) {
    if (isConnectionHealthy(existing.db)) {
      existing.refs += 1;
      return existing.db;
    }
    forceCloseConnection(existing);
    _connections.delete(dbPath);
  }

  return undefined;
}

/** Inspect an existing database leaf without following symlinks. */
export function inspectExistingLcmDatabasePath(dbPath: string): DatabaseFileIdentity | null {
  try {
    const stat = lstatSync(dbPath, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to open a symlink database path: ${dbPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`database path is not a regular file: ${dbPath}`);
    }
    return { device: stat.dev.toString(10), inode: stat.ino.toString(10) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

export type LcmConnectionOptions = Readonly<{
  /** @internal Deterministic database-parent admission seams for tests. */
  _databaseParentForTesting?: DatabaseParentTestingOptions;
}>;

export type ExistingLcmConnectionOptions = LcmConnectionOptions & Readonly<{
  /** Bind a completed read-only preflight before any writable connection setup. */
  expectedFileIdentity?: Readonly<{ device: string; inode: string }>;
  /** Safely repair the authenticated existing parent to mode 0700. */
  tightenDatabaseParent?: boolean;
}>;

/** Stable diagnostic for a handle that is not provably the authenticated file. */
const DATABASE_HANDLE_BINDING_ERROR =
  "database handle is not bound to the authenticated database file";

/**
 * Identity and change timestamps of one authenticated object. Two observations
 * that match prove the kernel recorded no rename, creation, or removal of that
 * object between them.
 */
type AuthenticatedFileWitness = Readonly<{
  device: bigint;
  inode: bigint;
  modifiedNs: bigint;
  changedNs: bigint;
}>;

function fileWitness(fd: number): AuthenticatedFileWitness {
  const descriptor = fstatSync(fd, { bigint: true });
  return {
    device: descriptor.dev,
    inode: descriptor.ino,
    modifiedNs: descriptor.mtimeNs,
    changedNs: descriptor.ctimeNs,
  };
}

function sameFileWitness(
  left: AuthenticatedFileWitness,
  right: AuthenticatedFileWitness,
): boolean {
  return left.device === right.device && left.inode === right.inode
    && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs;
}

/**
 * Retain the authenticated database leaf itself for the duration of an open.
 * The descriptor pins the inode that the pathname named when it was admitted,
 * so later evidence is about that object rather than about whatever the name
 * resolves to next.
 */
function retainAuthenticatedLeaf(
  dbPath: string,
  expected: DatabaseFileIdentity,
): Readonly<{ fd: number; witness: AuthenticatedFileWitness }> {
  const fd = openSync(
    dbPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const witness = fileWitness(fd);
    if (witness.device.toString(10) !== expected.device
      || witness.inode.toString(10) !== expected.inode) {
      throw new Error(DATABASE_HANDLE_BINDING_ERROR);
    }
    return { fd, witness };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Create the database leaf under the admitted parent before SQLite opens it.
 * Letting SQLite be the first creator would leave nothing to authenticate: a
 * file planted at the pathname during the constructor would be adopted, and an
 * absent leaf cannot be pinned. Creating it here makes every open, including a
 * create-capable one, take the retained-leaf and directory evidence.
 */
function createAuthenticatedLeaf(dbPath: string): DatabaseFileIdentity | null {
  let fd: number;
  try {
    fd = openSync(
      dbPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
  } catch (error) {
    // Another writer created the database first. Its leaf is authenticated by
    // the ordinary existing-file path on the next inspection.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  try {
    const witness = fileWitness(fd);
    return { device: witness.device.toString(10), inode: witness.inode.toString(10) };
  } finally {
    closeSync(fd);
  }
}

const DATABASE_LEAF_ADMISSION_ATTEMPTS = 3;

/**
 * Identify the leaf this open will authenticate. A create-capable open creates
 * it when absent, and yields to a writer that wins the exclusive create. Either
 * the leaf is identified or the open refuses: constructing a handle with nothing
 * retained is what let a planted database be adopted.
 */
function admitDatabaseLeafIdentity(
  dbPath: string,
  expectedIdentity: DatabaseFileIdentity | null,
): DatabaseFileIdentity {
  if (expectedIdentity !== null) return expectedIdentity;
  for (let attempt = 0; attempt < DATABASE_LEAF_ADMISSION_ATTEMPTS; attempt += 1) {
    const created = createAuthenticatedLeaf(dbPath);
    if (created !== null) return created;
    const existing = inspectExistingLcmDatabasePath(dbPath);
    if (existing !== null) return existing;
  }
  throw new Error(DATABASE_HANDLE_BINDING_ERROR);
}

function openLcmConnection(
  dbPath: string,
  createIfMissing: boolean,
  options: ExistingLcmConnectionOptions = {},
): DatabaseSync | null {
  const isInMemory = dbPath === ":memory:";
  if (isInMemory) {
    if (!createIfMissing) return null;
    const pooled = getPooledLcmConnection(dbPath);
    if (pooled) return pooled;
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA foreign_keys = ON");
    } catch (error) {
      forceCloseConnection({
        db,
        refs: 0,
        fileIdentity: null,
        parentIdentity: null,
      });
      throw error;
    }
    _connections.set(dbPath, {
      db,
      refs: 1,
      fileIdentity: null,
      parentIdentity: null,
    });
    return db;
  }

  const pooledEntry = _connections.get(dbPath);
  const parent = admitDatabaseParent(dbPath, {
    createIfMissing,
    tighten: createIfMissing || options.tightenDatabaseParent === true,
    expectedIdentity: pooledEntry?.parentIdentity ?? undefined,
    _databaseParentForTesting: options._databaseParentForTesting,
  });
  if (parent === null) return null;
  let parentClosed = false;
  let primaryError: unknown;
  let db: DatabaseSync | undefined;
  let fileIdentity: DatabaseFileIdentity | null = null;
  let retainedLeaf: Readonly<{ fd: number; witness: AuthenticatedFileWitness }> | null = null;

  const releaseParent = (): void => {
    parent.assertCurrent();
    parent.close();
    parentClosed = true;
  };

  try {
    // Persistent callers must validate the current filesystem leaf before a
    // pooled handle can be reused. An unlinked/rotated database may remain fully
    // usable through SQLite while no longer representing the requested path.
    parent.assertCurrent();
    const expectedIdentity = inspectExistingLcmDatabasePath(dbPath);
    if (options.expectedFileIdentity !== undefined
      && (expectedIdentity === null || !sameDatabaseFileIdentity(options.expectedFileIdentity, expectedIdentity))) {
      throw new Error("database path changed after read-only preflight");
    }
    if (!createIfMissing && expectedIdentity === null) return null;
    if (
      pooledEntry
      && (
        !expectedIdentity
        || !pooledEntry.fileIdentity
        || !sameDatabaseFileIdentity(pooledEntry.fileIdentity, expectedIdentity)
      )
    ) {
      if (createIfMissing) {
        throw new Error("pooled database path no longer matches the requested file");
      }
      return null;
    }

    if (pooledEntry) {
      if (isConnectionHealthy(pooledEntry.db)) {
        releaseParent();
        pooledEntry.refs += 1;
        return pooledEntry.db;
      }
      forceCloseConnection(pooledEntry);
      _connections.delete(dbPath);
    }

    // Retain the admitted leaf and directory across the open. Substituting the
    // leaf requires renaming entries in this directory, which the kernel records
    // on the directory and on the moved inode, so a substitution that is
    // restored before the pathname recheck still leaves evidence behind.
    // A create-capable open creates the leaf itself rather than letting SQLite
    // adopt whatever appears at the pathname, so the same evidence applies and
    // no constructor runs without a retained leaf.
    const admittedIdentity = admitDatabaseLeafIdentity(dbPath, expectedIdentity);
    retainedLeaf = retainAuthenticatedLeaf(dbPath, admittedIdentity);
    const parentBeforeOpen = parent.witness();
    // SQLite's URI mode=rw opens an existing database read/write but atomically
    // refuses to create it if another process removes it after the lstat above.
    // Resolving the pathname is itself part of the open: a symlink that exists
    // only across the resolution sends the constructor to another file while
    // every pathname recheck afterwards still describes the authentic leaf.
    // The resolution therefore happens after the leaf and directory evidence
    // is in hand, so planting and removing that symlink lands in the window.
    const location = createIfMissing
      ? dbPath
      : (() => {
        // URL parsing removes dot segments lexically. Resolve the admitted,
        // existing leaf through the filesystem first so an interior symlink
        // followed by `..` keeps the same kernel path semantics as admission.
        const url = pathToFileURL(realpathSync.native(dbPath));
        url.searchParams.set("mode", "rw");
        return url;
      })();
    parent.assertCurrent();
    db = new DatabaseSync(location);
    parent.assertCurrent();
    const openedIdentity = inspectExistingLcmDatabasePath(dbPath);
    if (!openedIdentity) {
      throw new Error("database path disappeared while opening");
    }
    if (!sameDatabaseFileIdentity(admittedIdentity, openedIdentity)) {
      throw new Error("database path changed while opening");
    }
    if (!sameDatabaseParentWitness(parentBeforeOpen, parent.witness())
      || !sameFileWitness(retainedLeaf.witness, fileWitness(retainedLeaf.fd))) {
      throw new Error(DATABASE_HANDLE_BINDING_ERROR);
    }
    // Tighten the mode through the retained descriptor. The pathname is the
    // one thing an attacker can still redirect inside this window, and the
    // descriptor is the inode the handle was just proven to be bound to, so
    // the permission change cannot land on anything else.
    fchmodSync(retainedLeaf.fd, PRIVATE_FILE_MODE);
    // Enable WAL mode for better concurrent read performance
    parent.assertCurrent();
    db.exec("PRAGMA journal_mode = WAL");
    // Wait up to 5 seconds on busy instead of failing immediately
    db.exec("PRAGMA busy_timeout = 5000");
    // Enable foreign key enforcement
    db.exec("PRAGMA foreign_keys = ON");
    parent.assertCurrent();
    fileIdentity = inspectExistingLcmDatabasePath(dbPath);
    if (!fileIdentity) {
      throw new Error("database path disappeared while opening");
    }
    if (!sameDatabaseFileIdentity(openedIdentity, fileIdentity)) {
      throw new Error("database path changed while opening");
    }
    // Close the retained leaf before pooling. A close failure is then an open
    // failure like any other, handled by the catch below, instead of a throw
    // that replaces the return and strands a pooled reference no caller holds.
    const retained = retainedLeaf;
    retainedLeaf = null;
    closeSync(retained.fd);
    releaseParent();
    _connections.set(dbPath, {
      db,
      refs: 1,
      fileIdentity,
      parentIdentity: parent.identity,
    });
    return db;
  } catch (error) {
    primaryError = error;
    if (db) {
      forceCloseConnection({
        db,
        refs: 0,
        fileIdentity,
        parentIdentity: parent.identity,
      });
    }
    // An existing-only caller treats an unlink after the pre-open lstat as
    // absence, not an initialization failure. It must never recreate the file.
    if (!createIfMissing) {
      parent.assertCurrent();
      if (inspectExistingLcmDatabasePath(dbPath) === null) return null;
    }
    throw error;
  } finally {
    if (retainedLeaf !== null) {
      try {
        closeSync(retainedLeaf.fd);
      } catch {
        // The open is already failing; keep that error rather than this one.
      }
    }
    if (!parentClosed) {
      try {
        parent.close();
      } catch (closeError) {
        if (primaryError === undefined) throw closeError;
      }
    }
  }
}

export function getLcmConnection(
  dbPath: string,
  options: LcmConnectionOptions = {},
): DatabaseSync {
  return openLcmConnection(dbPath, true, options)!;
}

/** Open an existing pooled or on-disk database without creating backend state. */
export function getExistingLcmConnection(
  dbPath: string,
  options: ExistingLcmConnectionOptions = {},
): DatabaseSync | null {
  return openLcmConnection(dbPath, false, options);
}

/** Stable path-free error for an unsafe or continuously changing preview source. */
export const SQLITE_PREVIEW_SNAPSHOT_ERROR =
  "SQLite preview could not capture a stable database generation; retry after database activity settles.";

const SQLITE_PREVIEW_SNAPSHOT_ATTEMPTS = 3;
const SQLITE_PREVIEW_COPY_CHUNK = 1024 * 1024;
const SQLITE_PREVIEW_SOURCE_LIMIT = 8n * 1024n * 1024n * 1024n;
const SQLITE_PREVIEW_DIRECTORY_PREFIX = "lcm-sqlite-preview-";

class SqlitePreviewDriftError extends Error {}
class SqlitePreviewUnsafeError extends Error {}

export class SqlitePreviewSnapshotError extends Error {
  constructor(cause: unknown) {
    super(SQLITE_PREVIEW_SNAPSHOT_ERROR, { cause });
    this.name = "SqlitePreviewSnapshotError";
  }
}

type SqlitePreviewFileWitness = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  digest: string;
}>;

type RetainedSqlitePreviewFile = Readonly<{
  path: string;
  fd: number;
  stat: BigIntStats;
}>;

type SqlitePreviewCaptureBaseline = {
  main?: Readonly<{ dev: bigint; ino: bigint }>;
  wal?: Readonly<{ dev: bigint; ino: bigint }>;
  sawWal: boolean;
  lastMainDigest?: string;
};

export type SqlitePreviewSnapshotTestingOptions = Readonly<{
  tempRoot?: string;
  openDatabase?: (path: string) => DatabaseSync;
  closeDatabase?: (database: DatabaseSync) => void;
  read?: typeof readSync;
  write?: typeof writeSync;
  beforeAttempt?: (input: Readonly<{ attempt: number; dbPath: string }>) => void;
  afterSourceOpen?: (input: Readonly<{ attempt: number; dbPath: string; walPath: string }>) => void;
  afterCopy?: (input: Readonly<{
    attempt: number;
    dbPath: string;
    walPath: string;
    snapshotPath: string;
  }>) => void;
}>;

export type SqlitePreviewSnapshotOptions = Readonly<{
  _snapshotForTesting?: SqlitePreviewSnapshotTestingOptions;
}>;

export type SqlitePreviewSnapshot = Readonly<{
  db: DatabaseSync;
  close: () => void;
}>;

type CapturedSqlitePreview = Readonly<{
  directory: string;
  directoryHandle: PrivateDirectoryHandle;
  databasePath: string;
}>;

function sqlitePreviewErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function sqlitePreviewMode(stat: BigIntStats): number {
  return Number(stat.mode & 0o7777n);
}

function validateSqlitePreviewSourceFile(stat: BigIntStats, expectedUid: number): void {
  const mode = sqlitePreviewMode(stat);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1n
    || Number(stat.uid) !== expectedUid
    || (mode & 0o400) === 0
    || (mode & 0o7000) !== 0
    || stat.size < 0n
    || stat.size > SQLITE_PREVIEW_SOURCE_LIMIT
  ) {
    throw new SqlitePreviewUnsafeError();
  }
}

function sameSqlitePreviewInode(
  left: Readonly<{ dev: bigint; ino: bigint }>,
  right: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sqlitePreviewWitness(stat: BigIntStats, digest: string): SqlitePreviewFileWitness {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    digest,
  };
}

function sameSqlitePreviewWitness(
  left: SqlitePreviewFileWitness,
  right: SqlitePreviewFileWitness,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.digest === right.digest;
}

function relevantSqlitePreviewMembership(parent: PrivateDirectoryHandle, leaf: string): string[] {
  const relevant = new Set([leaf, `${leaf}-wal`, `${leaf}-shm`, `${leaf}-journal`]);
  return readdirSync(retainedDirectoryDescriptorPath(parent.fd))
    .filter(entry => relevant.has(entry))
    .sort();
}

function openRetainedSqlitePreviewFile(
  parent: PrivateDirectoryHandle,
  parentPath: string,
  leaf: string,
  expectedUid: number,
): RetainedSqlitePreviewFile {
  const retainedPath = join(retainedDirectoryDescriptorPath(parent.fd), leaf);
  const fd = openSync(
    retainedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    validateSqlitePreviewSourceFile(stat, expectedUid);
    const retainedEntry = lstatSync(retainedPath, { bigint: true });
    const path = join(parentPath, leaf);
    const pathEntry = lstatSync(path, { bigint: true });
    if (
      retainedEntry.isSymbolicLink()
      || pathEntry.isSymbolicLink()
      || !sameSqlitePreviewInode(stat, retainedEntry)
      || !sameSqlitePreviewInode(stat, pathEntry)
    ) {
      throw new SqlitePreviewUnsafeError();
    }
    return { path, fd, stat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function digestSqlitePreviewFile(
  fd: number,
  size: bigint,
  testing: SqlitePreviewSnapshotTestingOptions | undefined,
): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(SQLITE_PREVIEW_COPY_CHUNK);
  let position = 0n;
  while (position < size) {
    const wanted = Number(size - position > BigInt(buffer.byteLength)
      ? BigInt(buffer.byteLength)
      : size - position);
    const count = (testing?.read ?? readSync)(fd, buffer, 0, wanted, Number(position));
    if (!Number.isSafeInteger(count) || count <= 0 || count > wanted) {
      throw new SqlitePreviewDriftError();
    }
    hash.update(buffer.subarray(0, count));
    position += BigInt(count);
  }
  if ((testing?.read ?? readSync)(fd, buffer, 0, 1, Number(position)) !== 0) {
    throw new SqlitePreviewDriftError();
  }
  return hash.digest("hex");
}

function sqlitePreviewMainUsesWal(
  source: RetainedSqlitePreviewFile,
  testing: SqlitePreviewSnapshotTestingOptions | undefined,
): boolean {
  if (source.stat.size < 20n) return false;
  const header = Buffer.alloc(20);
  const count = (testing?.read ?? readSync)(source.fd, header, 0, header.byteLength, 0);
  if (count !== header.byteLength) throw new SqlitePreviewDriftError();
  return header[18] === 2 && header[19] === 2;
}

function copySqlitePreviewFile(
  source: RetainedSqlitePreviewFile,
  destination: string,
  testing: SqlitePreviewSnapshotTestingOptions | undefined,
): SqlitePreviewFileWitness {
  const destinationFd = openSync(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(SQLITE_PREVIEW_COPY_CHUNK);
  let position = 0n;
  try {
    while (position < source.stat.size) {
      const wanted = Number(source.stat.size - position > BigInt(buffer.byteLength)
        ? BigInt(buffer.byteLength)
        : source.stat.size - position);
      const count = (testing?.read ?? readSync)(source.fd, buffer, 0, wanted, Number(position));
      if (!Number.isSafeInteger(count) || count <= 0 || count > wanted) {
        throw new SqlitePreviewDriftError();
      }
      hash.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        const writeCount = (testing?.write ?? writeSync)(
          destinationFd,
          buffer,
          written,
          count - written,
          null,
        );
        if (!Number.isSafeInteger(writeCount) || writeCount <= 0 || writeCount > count - written) {
          throw new SqlitePreviewUnsafeError();
        }
        written += writeCount;
      }
      position += BigInt(count);
    }
    if ((testing?.read ?? readSync)(source.fd, buffer, 0, 1, Number(position)) !== 0) {
      throw new SqlitePreviewDriftError();
    }
    fsyncSync(destinationFd);
  } finally {
    closeSync(destinationFd);
  }
  const copied = lstatSync(destination, { bigint: true });
  if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1n
    || copied.size !== source.stat.size || sqlitePreviewMode(copied) !== PRIVATE_FILE_MODE) {
    throw new SqlitePreviewUnsafeError();
  }
  return sqlitePreviewWitness(source.stat, hash.digest("hex"));
}

function revalidateSqlitePreviewFile(
  source: RetainedSqlitePreviewFile,
  before: SqlitePreviewFileWitness,
  expectedUid: number,
  testing: SqlitePreviewSnapshotTestingOptions | undefined,
): void {
  const afterStat = fstatSync(source.fd, { bigint: true });
  validateSqlitePreviewSourceFile(afterStat, expectedUid);
  let pathEntry: BigIntStats;
  try {
    pathEntry = lstatSync(source.path, { bigint: true });
  } catch (error) {
    if (sqlitePreviewErrorCode(error) === "ENOENT") throw new SqlitePreviewDriftError();
    throw error;
  }
  if (pathEntry.isSymbolicLink() || !sameSqlitePreviewInode(afterStat, pathEntry)) {
    throw new SqlitePreviewUnsafeError();
  }
  const after = sqlitePreviewWitness(
    afterStat,
    digestSqlitePreviewFile(source.fd, afterStat.size, testing),
  );
  if (!sameSqlitePreviewWitness(before, after)) throw new SqlitePreviewDriftError();
}

function cleanupSqlitePreviewDirectory(
  directory: string,
  handle: PrivateDirectoryHandle,
  expectedUid: number,
): void {
  let primaryError: unknown;
  try {
    const retained = retainedDirectoryDescriptorPath(handle.fd);
    for (const leaf of readdirSync(retained)) {
      const path = join(retained, leaf);
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
        || Number(stat.uid) !== expectedUid) throw new SqlitePreviewUnsafeError();
      unlinkSync(path);
    }
    assertPrivateDirectory(handle, directory, handle.witness, expectedUid);
    rmdirSync(directory);
  } catch (error) {
    primaryError = error;
  }
  try {
    handle.close();
  } catch (closeError) {
    if (primaryError === undefined) throw closeError;
    throw new AggregateError([primaryError, closeError], "SQLite preview cleanup failed", {
      cause: primaryError,
    });
  }
  if (primaryError !== undefined) throw primaryError;
}

function createSqlitePreviewDirectory(tempRoot: string, expectedUid: number): Readonly<{
  directory: string;
  handle: PrivateDirectoryHandle;
}> {
  const directory = mkdtempSync(join(tempRoot, SQLITE_PREVIEW_DIRECTORY_PREFIX));
  try {
    chmodSync(directory, 0o700);
    const handle = openPrivateDirectory(directory, { expectedUid });
    return { directory, handle };
  } catch (error) {
    try {
      rmdirSync(directory);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "SQLite preview directory initialization and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

function captureSqlitePreviewAttempt(
  dbPath: string,
  attempt: number,
  baseline: SqlitePreviewCaptureBaseline,
  options: SqlitePreviewSnapshotOptions,
): CapturedSqlitePreview | null {
  options._snapshotForTesting?.beforeAttempt?.({ attempt, dbPath });
  const expectedUid = requireSupportedProcessUid();
  const parentPath = dirname(dbPath);
  let parent: PrivateDirectoryHandle;
  try {
    parent = openPrivateDirectory(parentPath, { expectedUid });
  } catch (error) {
    if (sqlitePreviewErrorCode(error) === "ENOENT" && attempt === 1) return null;
    throw error;
  }
  const sources: RetainedSqlitePreviewFile[] = [];
  let captured: ReturnType<typeof createSqlitePreviewDirectory> | undefined;
  let keepCapture = false;
  let primaryError: unknown;
  try {
    assertPrivateDirectory(parent, parentPath, parent.witness, expectedUid);
    const leaf = basename(dbPath);
    const beforeMembership = relevantSqlitePreviewMembership(parent, leaf);
    let main: RetainedSqlitePreviewFile;
    try {
      main = openRetainedSqlitePreviewFile(parent, parentPath, leaf, expectedUid);
    } catch (error) {
      if (sqlitePreviewErrorCode(error) === "ENOENT" && attempt === 1) return null;
      throw error;
    }
    sources.push(main);
    if (beforeMembership.includes(`${leaf}-journal`)
      && !sqlitePreviewMainUsesWal(main, options._snapshotForTesting)) {
      throw new SqlitePreviewUnsafeError();
    }
    if (baseline.main === undefined) baseline.main = { dev: main.stat.dev, ino: main.stat.ino };
    else if (!sameSqlitePreviewInode(baseline.main, main.stat)) throw new SqlitePreviewUnsafeError();

    const walLeaf = `${leaf}-wal`;
    let wal: RetainedSqlitePreviewFile | null = null;
    if (beforeMembership.includes(walLeaf)) {
      baseline.sawWal = true;
      try {
        wal = openRetainedSqlitePreviewFile(parent, parentPath, walLeaf, expectedUid);
      } catch (error) {
        if (sqlitePreviewErrorCode(error) === "ENOENT") {
          try {
            const mainDigest = digestSqlitePreviewFile(
              main.fd,
              main.stat.size,
              options._snapshotForTesting,
            );
            revalidateSqlitePreviewFile(
              main,
              sqlitePreviewWitness(main.stat, mainDigest),
              expectedUid,
              options._snapshotForTesting,
            );
            assertPrivateDirectory(parent, parentPath, parent.witness, expectedUid);
            baseline.lastMainDigest = mainDigest;
          } catch (witnessError) {
            baseline.lastMainDigest = undefined;
            if (!(witnessError instanceof SqlitePreviewDriftError)) throw witnessError;
          }
          throw new SqlitePreviewDriftError();
        }
        throw error;
      }
    }
    if (wal !== null) {
      sources.push(wal);
      if (baseline.wal === undefined) baseline.wal = { dev: wal.stat.dev, ino: wal.stat.ino };
      else if (!sameSqlitePreviewInode(baseline.wal, wal.stat)) throw new SqlitePreviewUnsafeError();
    }
    options._snapshotForTesting?.afterSourceOpen?.({
      attempt,
      dbPath,
      walPath: `${dbPath}-wal`,
    });
    if (relevantSqlitePreviewMembership(parent, leaf).join("\0") !== beforeMembership.join("\0")) {
      throw new SqlitePreviewDriftError();
    }

    const tempRoot = options._snapshotForTesting?.tempRoot ?? tmpdir();
    captured = createSqlitePreviewDirectory(tempRoot, expectedUid);
    const retainedCapture = retainedDirectoryDescriptorPath(captured.handle.fd);
    const snapshotPath = join(retainedCapture, "main.sqlite");
    const copiedMain = copySqlitePreviewFile(main, snapshotPath, options._snapshotForTesting);
    const copiedWal = wal === null
      ? null
      : copySqlitePreviewFile(wal, `${snapshotPath}-wal`, options._snapshotForTesting);
    const previousMainDigest = baseline.lastMainDigest;
    if (wal === null && baseline.sawWal
      && (previousMainDigest === undefined || previousMainDigest === copiedMain.digest)) {
      throw new SqlitePreviewUnsafeError();
    }
    baseline.lastMainDigest = copiedMain.digest;

    options._snapshotForTesting?.afterCopy?.({
      attempt,
      dbPath,
      walPath: `${dbPath}-wal`,
      snapshotPath: join(captured.directory, "main.sqlite"),
    });

    revalidateSqlitePreviewFile(main, copiedMain, expectedUid, options._snapshotForTesting);
    if (wal !== null && copiedWal !== null) {
      revalidateSqlitePreviewFile(wal, copiedWal, expectedUid, options._snapshotForTesting);
    }
    assertPrivateDirectory(parent, parentPath, parent.witness, expectedUid);
    const afterMembership = relevantSqlitePreviewMembership(parent, leaf);
    if (afterMembership.join("\0") !== beforeMembership.join("\0")) {
      throw new SqlitePreviewDriftError();
    }
    assertPrivateDirectory(captured.handle, captured.directory, captured.handle.witness, expectedUid);
    keepCapture = true;
    return {
      directory: captured.directory,
      directoryHandle: captured.handle,
      databasePath: join(captured.directory, "main.sqlite"),
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const source of [...sources].reverse()) {
      try { closeSync(source.fd); } catch (error) { cleanupErrors.push(error); }
    }
    try { parent.close(); } catch (error) { cleanupErrors.push(error); }
    if (!keepCapture && captured !== undefined) {
      try {
        cleanupSqlitePreviewDirectory(captured.directory, captured.handle, expectedUid);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (keepCapture && captured !== undefined && cleanupErrors.length > 0) {
      try {
        cleanupSqlitePreviewDirectory(captured.directory, captured.handle, expectedUid);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      if (primaryError === undefined && cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(
        [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
        "SQLite preview capture cleanup failed",
        { cause: primaryError },
      );
    }
  }
}

/**
 * Capture a stable main+WAL generation and open only its disposable private copy.
 * Source generation drift retries a bounded number of times; unsafe topology and
 * retry exhaustion fail with one path-free preview diagnostic.
 */
export function captureExistingLcmSnapshot(
  dbPath: string,
  options: SqlitePreviewSnapshotOptions = {},
): SqlitePreviewSnapshot | null {
  if (dbPath === ":memory:") return null;
  const baseline: SqlitePreviewCaptureBaseline = { sawWal: false };
  const capture = (attempt: number): SqlitePreviewSnapshot | null => {
    let captured: CapturedSqlitePreview | null;
    try {
      captured = captureSqlitePreviewAttempt(dbPath, attempt, baseline, options);
    } catch (error) {
      if (error instanceof SqlitePreviewDriftError
        && attempt < SQLITE_PREVIEW_SNAPSHOT_ATTEMPTS) return capture(attempt + 1);
      throw new SqlitePreviewSnapshotError(error);
    }
    if (captured === null) return null;
    let db: DatabaseSync;
    try {
      db = options._snapshotForTesting?.openDatabase?.(captured.databasePath)
        ?? new DatabaseSync(captured.databasePath, { timeout: 5000 });
    } catch (error) {
      try {
        cleanupSqlitePreviewDirectory(
          captured.directory,
          captured.directoryHandle,
          requireSupportedProcessUid(),
        );
      } catch (cleanupError) {
        throw new SqlitePreviewSnapshotError(new AggregateError(
          [error, cleanupError],
          "SQLite preview open and cleanup failed",
          { cause: error },
        ));
      }
      throw new SqlitePreviewSnapshotError(error);
    }
    let closed = false;
    return {
      db,
      close: () => {
        if (closed) return;
        closed = true;
        let closeError: unknown;
        try {
          if (options._snapshotForTesting?.closeDatabase === undefined) db.close();
          else options._snapshotForTesting.closeDatabase(db);
        } catch (error) { closeError = error; }
        try {
          cleanupSqlitePreviewDirectory(
            captured.directory,
            captured.directoryHandle,
            requireSupportedProcessUid(),
          );
        } catch (cleanupError) {
          if (closeError === undefined) throw cleanupError;
          throw new AggregateError([closeError, cleanupError], "SQLite preview close failed", {
            cause: closeError,
          });
        }
        if (closeError !== undefined) throw closeError;
      },
    };
  };
  return capture(1);
}

export interface PoolStats {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  connections: Array<{
    path: string;
    refs: number;
    status: "active" | "idle";
  }>;
}

export function getPoolStats(): PoolStats {
  const connections = Array.from(_connections.entries()).map(([path, entry]) => ({
    path,
    refs: entry.refs,
    // Zero-ref entries are evicted immediately by closeLcmConnection.
    status: "active" as const,
  }));
  const activeConnections = connections.length;
  return {
    totalConnections: connections.length,
    activeConnections,
    idleConnections: connections.length - activeConnections,
    connections,
  };
}

/**
 * Returns true if a pooled connection for dbPath is currently open (refs > 0).
 * Used by callers that track per-connection state (e.g., migration-done cache)
 * so they can invalidate their state when the underlying connection is evicted.
 */
export function isLcmConnectionOpen(dbPath: string): boolean {
  return _connections.has(dbPath);
}

/** Force-evict exactly the expected pooled handle, regardless of its reference count. */
export function invalidateLcmConnection(dbPath: string, expectedDb: DatabaseSync): boolean {
  const entry = _connections.get(dbPath);
  if (!entry || entry.db !== expectedDb) return false;
  _connections.delete(dbPath);
  forceCloseConnection(entry);
  return true;
}

export function closeLcmConnection(dbPath?: string, expectedDb?: DatabaseSync): void {
  if (typeof dbPath === "string" && dbPath.trim()) {
    const entry = _connections.get(dbPath);
    if (!entry) {
      return;
    }
    if (expectedDb && entry.db !== expectedDb) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      forceCloseConnection(entry);
      _connections.delete(dbPath);
    }
    return;
  }

  for (const entry of _connections.values()) {
    forceCloseConnection(entry);
  }
  _connections.clear();
}
