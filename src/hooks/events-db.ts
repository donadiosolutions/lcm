// src/hooks/events-db.ts
import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLcmConnection, closeLcmConnection, isLcmConnectionOpen } from "../db/connection.js";
import { sanitizeError } from "../daemon/safe-error.js";
import { sanitizeHookErrorDiagnostic } from "./hook-error-diagnostic.js";
import type {
  LocalHookErrorQuery,
  LocalHookErrorRecord,
  LocalHookEvent,
  LocalHookEventRow,
  LocalHookOutboxHealth,
  LocalHookOutboxOpenOptions,
  PatternReinforcementStats,
} from "../storage/local-hook-outbox.js";

/**
 * Tracks which db paths have already had migrations applied in this process.
 * When a pooled connection is reused (refs > 1), we skip the migration check
 * entirely — it already ran during the first open. Cleared on process exit or
 * when a path is explicitly evicted from the pool.
 */
const _migratedPaths = new Set<string>();

interface BusyTimeoutOverrideState {
  baselineMs: number;
  overrides: Map<symbol, number>;
}

const _busyTimeoutOverrides = new Map<string, BusyTimeoutOverrideState>();

export type EventRow = LocalHookEventRow;
export type HealthStats = LocalHookOutboxHealth;
export type { PatternReinforcementStats } from "../storage/local-hook-outbox.js";
export { MAX_HOOK_ERROR_DIAGNOSTIC_LENGTH } from "./hook-error-diagnostic.js";

const SCHEMA_VERSION = 3;
export const EVENTS_UNPROCESSED_BATCH_LIMIT = 500;
const DEFAULT_RECENT_ERROR_LIMIT = 5;
const MAX_RECENT_ERROR_LIMIT = 100;

function normalizeRecentErrorLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_RECENT_ERROR_LIMIT;
  return Math.min(MAX_RECENT_ERROR_LIMIT, Math.max(0, Math.trunc(limit)));
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL DEFAULT 0,
  type          TEXT NOT NULL,
  category      TEXT NOT NULL,
  data          TEXT NOT NULL,
  priority      INTEGER DEFAULT 3,
  source_hook   TEXT NOT NULL,
  prev_event_id INTEGER,
  processed_at  TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(processed_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_pattern_lookup ON events(type, category, data, created_at);
CREATE TABLE IF NOT EXISTS error_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hook       TEXT NOT NULL,
  error      TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);
`;

export class EventsDb {
  private db: DatabaseSync;
  private dbPath: string;
  private closed = false;
  private busyTimeoutOverrideId: symbol | undefined;

  constructor(dbPath: string, options: LocalHookOutboxOpenOptions = {}) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.dbPath = dbPath;
    // getLcmConnection returns the pooled (or newly-opened) DatabaseSync handle
    // and increments its ref-count. Connections are kept alive across EventsDb
    // instances so that high-frequency hooks (PostToolUse fires 50-200x/session)
    // reuse the same underlying connection instead of opening/closing each time.
    this.db = getLcmConnection(dbPath);
    if (options.busyTimeoutMs !== undefined && Number.isFinite(options.busyTimeoutMs)) {
      try {
        this.addBusyTimeoutOverride(Math.max(0, Math.trunc(options.busyTimeoutMs)));
      } catch (e) {
        closeLcmConnection(dbPath);
        const message = sanitizeError(e instanceof Error ? e.message : String(e));
        throw new Error(message);
      }
    }
    if (!_migratedPaths.has(dbPath)) {
      try {
        this.migrate();
      } catch (e) {
        // Migration failed — release the pooled connection so the ref-count
        // doesn't leak. The constructor will re-throw, so callers see the error.
        try { this.removeBusyTimeoutOverride(); } catch { /* preserve the migration failure */ }
        closeLcmConnection(dbPath);
        const message = sanitizeError(e instanceof Error ? e.message : String(e));
        throw new Error(message);
      }
      _migratedPaths.add(dbPath);
    }
  }

  private addBusyTimeoutOverride(timeoutMs: number): void {
    let state = _busyTimeoutOverrides.get(this.dbPath);
    if (!state) {
      const baseline = this.db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      state = { baselineMs: baseline.timeout, overrides: new Map() };
      _busyTimeoutOverrides.set(this.dbPath, state);
    }

    const overrideId = Symbol("busy-timeout-override");
    state.overrides.set(overrideId, timeoutMs);
    try {
      this.db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
      this.busyTimeoutOverrideId = overrideId;
    } catch (error) {
      state.overrides.delete(overrideId);
      if (state.overrides.size === 0) _busyTimeoutOverrides.delete(this.dbPath);
      throw error;
    }
  }

  private removeBusyTimeoutOverride(): void {
    const overrideId = this.busyTimeoutOverrideId;
    if (!overrideId) return;
    this.busyTimeoutOverrideId = undefined;

    const state = _busyTimeoutOverrides.get(this.dbPath)!;
    state.overrides.delete(overrideId);

    let effectiveTimeoutMs = state.baselineMs;
    for (const timeoutMs of state.overrides.values()) effectiveTimeoutMs = timeoutMs;
    try {
      this.db.exec(`PRAGMA busy_timeout = ${effectiveTimeoutMs}`);
    } finally {
      if (state.overrides.size === 0) _busyTimeoutOverrides.delete(this.dbPath);
    }
  }

  private migrate(): void {
    // Check if schema_version table exists
    const row = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).get() as { name: string } | undefined;

    if (!row) {
      this.runMigrationTransaction(() => {
        this.db.exec(SCHEMA_SQL);
        this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
      });
      return;
    }

    const versionRow = this.db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;

    // Handle empty schema_version table (table exists but has no rows)
    if (!versionRow) {
      this.runMigrationTransaction(() => {
        this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
        // Ensure latest tables and indexes exist even in this edge case.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS error_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            hook       TEXT NOT NULL,
            error      TEXT NOT NULL,
            session_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);
          CREATE INDEX IF NOT EXISTS idx_events_pattern_lookup ON events(type, category, data, created_at);
        `);
      });
      return;
    }

    const currentVersion = versionRow.version;

    if (currentVersion < SCHEMA_VERSION) {
      this.runMigrationTransaction(() => {
        if (currentVersion < 2) {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS error_log (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              hook       TEXT NOT NULL,
              error      TEXT NOT NULL,
              session_id TEXT,
              created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);
          `);
        }
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS idx_events_pattern_lookup ON events(type, category, data, created_at)"
        );
        this.db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
      });
    }
  }

  private runMigrationTransaction(migration: () => void): void {
    this.db.exec("BEGIN EXCLUSIVE");
    try {
      migration();
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the migration failure */ }
      const message = sanitizeError(e instanceof Error ? e.message : String(e));
      throw new Error(message);
    }
  }

  insertEvent(sessionId: string, event: LocalHookEvent, sourceHook: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO events (session_id, seq, type, category, data, priority, source_hook)
      VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?),
              ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      sessionId, sessionId,
      event.type, event.category, event.data, event.priority, sourceHook
    );
    return Number(result.lastInsertRowid);
  }

  getUnprocessed(limit = EVENTS_UNPROCESSED_BATCH_LIMIT): EventRow[] {
    return this.db.prepare(
      "SELECT * FROM events WHERE processed_at IS NULL ORDER BY session_id, seq LIMIT ?"
    ).all(limit) as unknown as EventRow[];
  }

  markProcessed(eventIds: number[]): void {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => "?").join(",");
    this.db.prepare(
      `UPDATE events SET processed_at = datetime('now') WHERE event_id IN (${placeholders})`
    ).run(...eventIds);
  }

  pruneProcessed(olderThanDays: number): number {
    const result = this.db.prepare(
      `DELETE FROM events WHERE processed_at IS NOT NULL
       AND processed_at < datetime('now', '-' || ? || ' days')`
    ).run(olderThanDays);
    return Number(result.changes);
  }

  setPrevEventId(eventId: number, prevEventId: number): void {
    this.db.prepare("UPDATE events SET prev_event_id = ? WHERE event_id = ?")
      .run(prevEventId, eventId);
  }

  getPatternReinforcement(type: string, category: string, data: string, maxAgeDays = 90): PatternReinforcementStats {
    const row = this.db.prepare(
      `SELECT COUNT(*) as totalCount,
              COUNT(DISTINCT session_id) as distinctSessions
       FROM events
       WHERE type = ?
         AND category = ?
         AND data = ?
         AND created_at >= datetime('now', '-' || ? || ' days')`
    ).get(type, category, data, maxAgeDays) as unknown as PatternReinforcementStats | undefined;

    return row!;
  }

  logHookError(hook: string, error: unknown, sessionId?: string): void {
    this.db.prepare(
      "INSERT INTO error_log (hook, error, session_id) VALUES (?, ?, ?)"
    ).run(hook, sanitizeHookErrorDiagnostic(error), sessionId ?? null);
  }

  getHealthStats(): HealthStats {
    const eventTotals = this.db.prepare(
      "SELECT COUNT(*) as totalEvents, MAX(created_at) as lastCapture FROM events"
    ).get() as { totalEvents: number; lastCapture: string | null };
    const unprocessedRow = this.db.prepare(
      "SELECT COUNT(*) as unprocessed FROM events WHERE processed_at IS NULL"
    ).get() as { unprocessed: number };
    const errorTotals = this.db.prepare(
      "SELECT COUNT(*) as errors, MAX(created_at) as lastError FROM error_log WHERE hook NOT LIKE 'maintenance:%' AND created_at >= datetime('now', '-30 days')"
    ).get() as { errors: number; lastError: string | null };

    return {
      totalEvents: eventTotals.totalEvents,
      unprocessed: unprocessedRow.unprocessed,
      errors: errorTotals.errors,
      lastCapture: eventTotals.lastCapture,
      lastError: errorTotals.lastError,
    };
  }

  getRecentErrors(options: LocalHookErrorQuery = {}): LocalHookErrorRecord[] {
    const where = options.includeMaintenance ? "" : "WHERE hook NOT LIKE 'maintenance:%'";
    const rows = this.db.prepare(
      `SELECT created_at, hook, error, session_id FROM error_log ${where} ORDER BY id DESC LIMIT ?`,
    ).all(normalizeRecentErrorLimit(options.limit)) as unknown as LocalHookErrorRecord[];
    return rows.map((row) => ({
      ...row,
      error: sanitizeHookErrorDiagnostic(row.error),
    }));
  }

  pruneUnprocessed(maxRows = 10_000, maxAgeDays = 30): { pruned: number } {
    let pruned = 0;
    this.db.exec("BEGIN");
    try {
      const ageCountRow = this.db.prepare(
        `SELECT COUNT(*) as c FROM events
         WHERE processed_at IS NULL
         AND created_at < datetime('now', '-' || ? || ' days')`
      ).get(maxAgeDays) as { c: number };
      const ageCount = ageCountRow.c;

      const totalUnprocessedRow = this.db.prepare(
        "SELECT COUNT(*) as c FROM events WHERE processed_at IS NULL"
      ).get() as { c: number };
      const totalUnprocessed = totalUnprocessedRow.c;

      const remainingAfterAge = totalUnprocessed - ageCount;
      let excess = 0;
      if (remainingAfterAge > maxRows) {
        excess = remainingAfterAge - maxRows;
      }

      pruned = ageCount + excess;

      if (pruned > 0) {
        this.db.prepare(
          "INSERT INTO error_log (hook, error, session_id) VALUES (?, ?, NULL)"
        ).run("maintenance:pruneUnprocessed", `pruned ${pruned} unprocessed events (age/cap limit)`);
      }

      if (ageCount > 0) {
        this.db.prepare(
          `DELETE FROM events WHERE processed_at IS NULL
           AND event_id IN (
             SELECT event_id FROM events WHERE processed_at IS NULL
             AND created_at < datetime('now', '-' || ? || ' days')
           )`
        ).run(maxAgeDays);
      }

      if (excess > 0) {
        this.db.prepare(
          `DELETE FROM events WHERE event_id IN (
             SELECT event_id FROM events WHERE processed_at IS NULL
             ORDER BY event_id ASC LIMIT ?
           )`
        ).run(excess);
      }

      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
    return { pruned };
  }

  pruneErrorLog(olderThanDays = 30): number {
    const result = this.db.prepare(
      "DELETE FROM error_log WHERE created_at < datetime('now', '-' || ? || ' days')"
    ).run(olderThanDays);
    return Number(result.changes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Decrement pool ref-count. The underlying connection stays open as long as
    // other callers hold a reference — it is only closed when refs reach 0.
    try {
      this.removeBusyTimeoutOverride();
    } finally {
      closeLcmConnection(this.dbPath);
    }
    // If the connection was fully evicted from the pool, invalidate the
    // migration-done cache so the next open re-runs migrations on a fresh handle.
    if (!isLcmConnectionOpen(this.dbPath)) {
      _migratedPaths.delete(this.dbPath);
    }
  }
}

/**
 * Clear the migration-done cache. Intended for tests that create/destroy temp
 * databases and need migration to re-run on the same path.
 *
 * @internal
 */
export function _resetMigratedPathsForTesting(): void {
  _migratedPaths.clear();
}
