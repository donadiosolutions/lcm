import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from "../security-files.js";

type ConnectionEntry = {
  db: DatabaseSync;
  refs: number;
};

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

function validatePersistentDatabasePath(dbPath: string, createIfMissing: boolean): boolean {
  if (createIfMissing) ensurePrivateDirectory(dirname(dbPath));
  try {
    const stat = lstatSync(dbPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to open a symlink database path: ${dbPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`database path is not a regular file: ${dbPath}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return createIfMissing;
  }
}

function openLcmConnection(dbPath: string, createIfMissing: boolean): DatabaseSync | null {
  const pooled = getPooledLcmConnection(dbPath);
  if (pooled) return pooled;

  const isInMemory = dbPath === ":memory:";
  if (isInMemory && !createIfMissing) return null;
  if (!isInMemory && !validatePersistentDatabasePath(dbPath, createIfMissing)) return null;

  // SQLite's URI mode=rw opens an existing database read/write but atomically
  // refuses to create it if another process removes it after the lstat above.
  const location = createIfMissing || isInMemory
    ? dbPath
    : (() => {
      const url = pathToFileURL(dbPath);
      url.searchParams.set("mode", "rw");
      return url;
    })();
  const db = new DatabaseSync(location);
  try {
    if (!isInMemory) chmodSync(dbPath, PRIVATE_FILE_MODE);
    // Enable WAL mode for better concurrent read performance
    db.exec("PRAGMA journal_mode = WAL");
    // Wait up to 5 seconds on busy instead of failing immediately
    db.exec("PRAGMA busy_timeout = 5000");
    // Enable foreign key enforcement
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    forceCloseConnection({ db, refs: 0 });
    throw error;
  }

  _connections.set(dbPath, { db, refs: 1 });
  return db;
}

export function getLcmConnection(dbPath: string): DatabaseSync {
  return openLcmConnection(dbPath, true)!;
}

/** Open an existing pooled or on-disk database without creating backend state. */
export function getExistingLcmConnection(dbPath: string): DatabaseSync | null {
  return openLcmConnection(dbPath, false);
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

export function closeLcmConnection(dbPath?: string): void {
  if (typeof dbPath === "string" && dbPath.trim()) {
    const entry = _connections.get(dbPath);
    if (!entry) {
      return;
    }
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
