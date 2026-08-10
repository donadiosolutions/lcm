// src/hooks/events-db.ts
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getExistingLcmConnection,
  getLcmConnection,
  closeLcmConnection,
  isLcmConnectionOpen,
} from "../db/connection.js";
import { sanitizeError } from "../daemon/safe-error.js";
import {
  ensurePrivateDirectory,
  PRIVATE_DIRECTORY_MODE,
} from "../security-files.js";
import { readMachineIdentity } from "../machine-identity.js";
import { sanitizeHookErrorDiagnostic } from "./hook-error-diagnostic.js";
import {
  allocateLocalHookEventSequences,
  deriveLegacyLocalHookEventUuid,
  formatLocalHookMachineSequence,
  LocalHookEventSequenceAllocator,
} from "../storage/local-hook-event-sequence.js";
import type {
  LocalHookDeliveryClaimInput,
  LocalHookDeliveryDiagnostics,
  LocalHookErrorQuery,
  LocalHookErrorRecord,
  LocalHookEvent,
  LocalHookEventRow,
  LocalHookMissingCwdState,
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

function effectiveBusyTimeoutMs(state: BusyTimeoutOverrideState): number {
  let effective = state.baselineMs;
  for (const timeoutMs of state.overrides.values()) {
    effective = Math.max(effective, timeoutMs);
  }
  return effective;
}

export type EventRow = LocalHookEventRow;
export type HealthStats = LocalHookOutboxHealth;
export type { PatternReinforcementStats } from "../storage/local-hook-outbox.js";
export { MAX_HOOK_ERROR_DIAGNOSTIC_LENGTH } from "./hook-error-diagnostic.js";

export const EVENTS_SCHEMA_VERSION = 5;
const SCHEMA_VERSION = EVENTS_SCHEMA_VERSION;
export const EVENTS_UNPROCESSED_BATCH_LIMIT = 500;
export const EVENTS_DELIVERY_BATCH_LIMIT = 500;
const DEFAULT_RECENT_ERROR_LIMIT = 5;
const MAX_RECENT_ERROR_LIMIT = 100;
const LEGACY_EVENT_CREATED_AT_FALLBACK = "1970-01-01 00:00:00";
const MAX_POSTGRESQL_BIGINT = 9_223_372_036_854_775_807n;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[457][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MISSING_CWD_PARKING_OBSERVATIONS = 3;

export type MissingCwdStateRow = {
  readonly id: number;
  readonly observations: number;
  readonly last_observed_at: number;
  readonly parked_at: string | null;
};

function isCanonicalSqliteUtcTimestamp(
  db: DatabaseSync,
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  const normalized = db.prepare("SELECT datetime(?) AS value").get(value) as {
    value: string | null;
  };
  return normalized.value === value;
}

/** Validate persisted missing-CWD state before any caller interprets it. */
export function isValidMissingCwdStateRow(
  db: DatabaseSync,
  row: unknown,
): row is MissingCwdStateRow {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const state = row as Record<string, unknown>;
  if (state.id !== 1) return false;
  if (
    typeof state.observations !== "number"
    || !Number.isSafeInteger(state.observations)
    || state.observations <= 0
  ) {
    return false;
  }
  if (
    typeof state.last_observed_at !== "number"
    || !Number.isSafeInteger(state.last_observed_at)
    || state.last_observed_at < 0
  ) {
    return false;
  }
  if (state.parked_at === null) return true;
  return state.observations >= MISSING_CWD_PARKING_OBSERVATIONS
    && isCanonicalSqliteUtcTimestamp(db, state.parked_at);
}

function normalizeRecentErrorLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_RECENT_ERROR_LIMIT;
  return Math.min(MAX_RECENT_ERROR_LIMIT, Math.max(0, Math.trunc(limit)));
}

const EVENTS_TABLE_SQL = `
CREATE TABLE events (
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid    TEXT NOT NULL UNIQUE,
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  machine_id    TEXT,
  machine_sequence TEXT NOT NULL UNIQUE
    CHECK (length(machine_sequence) = 19 AND machine_sequence NOT GLOB '*[^0-9]*'),
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL DEFAULT 0,
  type          TEXT NOT NULL,
  category      TEXT NOT NULL,
  data          TEXT NOT NULL,
  priority      INTEGER DEFAULT 3,
  source_hook   TEXT NOT NULL,
  prev_event_id INTEGER,
  processed_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN (
    'pending', 'claimed', 'retry', 'replicated', 'acknowledged', 'quarantined'
  )),
  delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivery_owner TEXT,
  delivery_claimed_at TEXT,
  delivery_next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivery_last_error TEXT,
  remote_inbox_id TEXT,
  quarantine_reason TEXT,
  acknowledged_at TEXT,
  remote_pruned_at TEXT,
  delivery_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((delivery_state = 'claimed') = (delivery_claimed_at IS NOT NULL)),
  CHECK ((delivery_claimed_at IS NULL) = (delivery_owner IS NULL)),
  CHECK ((delivery_state = 'acknowledged') = (acknowledged_at IS NOT NULL)),
  CHECK ((delivery_state = 'quarantined') = (quarantine_reason IS NOT NULL)),
  CHECK (delivery_state <> 'replicated' OR remote_inbox_id IS NOT NULL),
  CHECK (delivery_state <> 'acknowledged' OR remote_inbox_id IS NOT NULL),
  CHECK (
    remote_pruned_at IS NULL
    OR (delivery_state = 'acknowledged' AND remote_inbox_id IS NOT NULL)
  )
);
`;

const EVENT_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(processed_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_pattern_lookup ON events(type, category, data, created_at);
CREATE INDEX IF NOT EXISTS idx_events_delivery_ready
  ON events(delivery_state, delivery_next_attempt_at, machine_sequence)
  WHERE delivery_state IN ('pending', 'retry', 'claimed');
CREATE INDEX IF NOT EXISTS idx_events_delivery_remote
  ON events(delivery_state, machine_sequence)
  WHERE delivery_state IN ('replicated', 'quarantined', 'acknowledged');
`;

const ERROR_LOG_SQL = `
CREATE TABLE IF NOT EXISTS error_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hook       TEXT NOT NULL,
  error      TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);
`;

const MISSING_CWD_STATE_SQL = `
CREATE TABLE IF NOT EXISTS missing_cwd_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  observations INTEGER NOT NULL CHECK (observations > 0),
  last_observed_at INTEGER NOT NULL CHECK (last_observed_at >= 0),
  parked_at TEXT CHECK (parked_at IS NULL OR observations >= 3)
);
`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
${EVENTS_TABLE_SQL}
${EVENT_INDEX_SQL}
${ERROR_LOG_SQL}
${MISSING_CWD_STATE_SQL}
`;

function currentRegisteredMachineId(): string | null {
  try {
    return readMachineIdentity()?.machineId ?? null;
  } catch {
    // Hooks must remain offline-safe even when machine registration needs repair.
    return null;
  }
}

function nonblank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be blank`);
  return normalized;
}

function positiveBatchLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > EVENTS_DELIVERY_BATCH_LIMIT) {
    throw new Error(`${field} must be an integer between 1 and ${EVENTS_DELIVERY_BATCH_LIMIT}`);
  }
  return value;
}

function nonnegativeMilliseconds(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function formatRemoteInboxId(value: bigint): string {
  if (value < 1n || value > MAX_POSTGRESQL_BIGINT) {
    throw new Error("remote inbox ID is outside the PostgreSQL bigint range");
  }
  return value.toString();
}

function eventUuid(value: string): string {
  const normalized = value.toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new Error("invalid local hook event UUID");
  return normalized;
}

export class EventsDb {
  private db: DatabaseSync;
  private dbPath: string;
  private closed = false;
  private busyTimeoutOverrideId: symbol | undefined;
  private sequenceAllocator: LocalHookEventSequenceAllocator | undefined;

  static openExisting(
    dbPath: string,
    options: LocalHookOutboxOpenOptions = {},
  ): EventsDb | null {
    const connection = getExistingLcmConnection(dbPath);
    if (connection === null) return null;
    try {
      chmodSync(dirname(dbPath), PRIVATE_DIRECTORY_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        closeLcmConnection(dbPath, connection);
        throw error;
      }
    }
    return new EventsDb(dbPath, options, connection);
  }

  constructor(
    dbPath: string,
    options: LocalHookOutboxOpenOptions = {},
    existingConnection?: DatabaseSync,
  ) {
    this.dbPath = dbPath;
    if (existingConnection) {
      this.db = existingConnection;
    } else {
      // Create-capable opens always enforce the private-directory invariant,
      // including when getLcmConnection reuses an already-pooled handle.
      ensurePrivateDirectory(dirname(dbPath));
      // getLcmConnection returns the pooled (or newly-opened) DatabaseSync handle
      // and increments its ref-count. Connections are kept alive across EventsDb
      // instances so that high-frequency hooks (PostToolUse fires 50-200x/session)
      // reuse the same underlying connection instead of opening/closing each time.
      this.db = getLcmConnection(dbPath);
    }
    if (options.busyTimeoutMs !== undefined && Number.isFinite(options.busyTimeoutMs)) {
      try {
        this.addBusyTimeoutOverride(Math.max(0, Math.trunc(options.busyTimeoutMs)));
      } catch (e) {
        closeLcmConnection(dbPath, this.db);
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
        closeLcmConnection(dbPath, this.db);
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
      this.db.exec(`PRAGMA busy_timeout = ${effectiveBusyTimeoutMs(state)}`);
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

    try {
      this.db.exec(`PRAGMA busy_timeout = ${effectiveBusyTimeoutMs(state)}`);
    } finally {
      if (state.overrides.size === 0) _busyTimeoutOverrides.delete(this.dbPath);
    }
  }

  private readSchemaVersion(): {
    currentVersion: number;
    versionRow: { version: number } | undefined;
  } | undefined {
    const row = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).get() as { name: string } | undefined;

    if (!row) return undefined;

    const versionRow = this.db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;

    const currentVersion = versionRow?.version ?? 1;
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
      throw new Error(`invalid events schema version: ${String(currentVersion)}`);
    }
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(`unsupported events schema version: ${String(currentVersion)}`);
    }

    return { currentVersion, versionRow };
  }

  private migrate(): void {
    this.runMigrationTransaction(() => {
      this.migrateUnderExclusiveLock();
    });
  }

  private migrateUnderExclusiveLock(): void {
    const schema = this.readSchemaVersion();
    if (!schema) {
      this.db.exec(SCHEMA_SQL);
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
      return;
    }

    const { currentVersion, versionRow } = schema;
    if (currentVersion === SCHEMA_VERSION) {
      const eventsTable = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='events'",
      ).get();
      if (!eventsTable) {
        this.db.exec(EVENTS_TABLE_SQL);
      }
      // Current-schema repair is deliberately part of this migration
      // transaction: a later DDL failure rolls every earlier repair back.
      this.db.exec(EVENT_INDEX_SQL);
      this.db.exec(ERROR_LOG_SQL);
      this.db.exec(MISSING_CWD_STATE_SQL);
      return;
    }

    if (currentVersion === 4) {
      const eventsTable = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='events'",
      ).get();
      if (!eventsTable) {
        this.db.exec(`${EVENTS_TABLE_SQL}${EVENT_INDEX_SQL}${ERROR_LOG_SQL}`);
      } else {
        this.db.exec(`${EVENT_INDEX_SQL}${ERROR_LOG_SQL}`);
      }
      this.db.exec(MISSING_CWD_STATE_SQL);
      this.db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
      return;
    }

    const legacyRows = this.db.prepare(
      `SELECT event_id, session_id, seq, type, category, data, priority,
              source_hook, prev_event_id, processed_at, created_at
       FROM events
       ORDER BY event_id`,
    ).all() as Array<{
      event_id: number;
      session_id: string;
      seq: number;
      type: string;
      category: string;
      data: string;
      priority: number;
      source_hook: string;
      prev_event_id: number | null;
      processed_at: string | null;
      created_at: string | null;
    }>;
    const allocated = allocateLocalHookEventSequences(
      legacyRows.length,
      join(dirname(this.dbPath), ".machine-sequence.sqlite"),
    );
    const machineId = currentRegisteredMachineId();
    this.db.exec(ERROR_LOG_SQL);
    this.db.exec("DROP TABLE IF EXISTS events_v4");
    this.db.exec(EVENTS_TABLE_SQL.replace("CREATE TABLE events", "CREATE TABLE events_v4"));
    const insert = this.db.prepare(`
      INSERT INTO events_v4 (
        event_id, event_uuid, event_version, machine_id, machine_sequence,
        session_id, seq, type, category, data, priority, source_hook,
        prev_event_id, processed_at, created_at, delivery_state,
        delivery_generation, delivery_attempts, delivery_owner,
        delivery_claimed_at, delivery_next_attempt_at, delivery_last_error,
        remote_inbox_id, quarantine_reason, acknowledged_at,
        remote_pruned_at, delivery_updated_at
      ) VALUES (
        ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, 0, 0, NULL, NULL, ?, NULL, NULL, NULL, ?, NULL, ?
      )
    `);
    legacyRows.forEach((legacy, index) => {
      const createdAt = legacy.created_at ?? LEGACY_EVENT_CREATED_AT_FALLBACK;
      insert.run(
        legacy.event_id,
        deriveLegacyLocalHookEventUuid({ ...legacy, created_at: createdAt }),
        machineId,
        formatLocalHookMachineSequence(allocated[index]!),
        legacy.session_id,
        legacy.seq,
        legacy.type,
        legacy.category,
        legacy.data,
        legacy.priority,
        legacy.source_hook,
        legacy.prev_event_id,
        legacy.processed_at,
        createdAt,
        "pending",
        createdAt,
        null,
        createdAt,
      );
    });
    this.db.exec(`
      DROP TABLE events;
      ALTER TABLE events_v4 RENAME TO events;
      ${EVENT_INDEX_SQL}
      ${MISSING_CWD_STATE_SQL}
    `);
    if (versionRow) {
      this.db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    } else {
      this.db.prepare("INSERT INTO schema_version(version) VALUES(?)").run(SCHEMA_VERSION);
    }
  }

  private runMigrationTransaction(migration: () => void): void {
    this.db.exec("BEGIN EXCLUSIVE");
    try {
      migration();
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the migration failure */ }
      // The constructor owns the public error boundary and sanitizes both
      // Error and non-Error migration failures after releasing the connection.
      throw e;
    }
  }

  private localHookEventSequenceAllocator(): LocalHookEventSequenceAllocator {
    if (this.closed) {
      throw new Error("events database is closed");
    }
    this.sequenceAllocator ??= new LocalHookEventSequenceAllocator(
      join(dirname(this.dbPath), ".machine-sequence.sqlite"),
    );
    return this.sequenceAllocator;
  }

  insertEvent(sessionId: string, event: LocalHookEvent, sourceHook: string): number {
    const sequence = formatLocalHookMachineSequence(
      this.localHookEventSequenceAllocator().allocateSequence(),
    );
    const stmt = this.db.prepare(`
      INSERT INTO events (
        event_uuid, event_version, machine_id, machine_sequence,
        session_id, seq, type, category, data, priority, source_hook
      )
      VALUES (?, 1, ?, ?, ?,
              (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?),
              ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      randomUUID(), currentRegisteredMachineId(), sequence, sessionId, sessionId,
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
      `UPDATE events
       SET processed_at = COALESCE(processed_at, datetime('now'))
       WHERE event_id IN (${placeholders})`
    ).run(...eventIds);
  }

  observeMissingCwd(
    observedAtMs: number,
    minimumIntervalMs: number,
    requiredObservations: number,
  ): LocalHookMissingCwdState {
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new Error("observedAtMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new Error("minimumIntervalMs must be a non-negative safe integer");
    }
    if (
      !Number.isSafeInteger(requiredObservations)
      || requiredObservations < MISSING_CWD_PARKING_OBSERVATIONS
    ) {
      throw new Error(
        `requiredObservations must be a positive safe integer no less than ${MISSING_CWD_PARKING_OBSERVATIONS}`,
      );
    }

    const stateRows = this.db.prepare(
      "SELECT id, observations, last_observed_at, parked_at FROM missing_cwd_state",
    ).all() as unknown[];
    if (stateRows.length > 1) {
      throw new Error("invalid missing-CWD state");
    }
    const rawState = stateRows[0];
    if (rawState !== undefined && !isValidMissingCwdStateRow(this.db, rawState)) {
      throw new Error("invalid missing-CWD state");
    }
    const state = rawState as MissingCwdStateRow | undefined;
    if (state && state.parked_at !== null) {
      return { parked: true, observations: state.observations, retryAfterMs: 0 };
    }

    const elapsed = state === undefined ? minimumIntervalMs : Math.max(
      0,
      observedAtMs - state.last_observed_at,
    );
    if (state && elapsed < minimumIntervalMs) {
      return {
        parked: false,
        observations: state.observations,
        retryAfterMs: minimumIntervalMs - elapsed,
      };
    }

    const observations = (state?.observations ?? 0) + 1;
    const parked = observations >= requiredObservations;
    this.db.prepare(`
      INSERT INTO missing_cwd_state (id, observations, last_observed_at, parked_at)
      VALUES (1, ?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END)
      ON CONFLICT(id) DO UPDATE SET
        observations = excluded.observations,
        last_observed_at = excluded.last_observed_at,
        parked_at = excluded.parked_at
    `).run(observations, observedAtMs, parked ? 1 : 0);
    return {
      parked,
      observations,
      retryAfterMs: parked ? 0 : minimumIntervalMs,
    };
  }

  clearMissingCwd(): void {
    this.db.prepare("DELETE FROM missing_cwd_state WHERE id = 1").run();
  }

  pruneProcessed(olderThanDays: number): number {
    const result = this.db.prepare(
      `DELETE FROM events WHERE processed_at IS NOT NULL
       AND delivery_state = 'acknowledged'
       AND remote_pruned_at IS NOT NULL
       AND processed_at < datetime('now', '-' || ? || ' days')`
    ).run(olderThanDays);
    return Number(result.changes);
  }

  setPrevEventId(eventId: number, prevEventId: number): void {
    this.db.prepare(`
      UPDATE events
      SET prev_event_id = ?,
          delivery_generation = delivery_generation + 1,
          delivery_updated_at = datetime('now')
      WHERE event_id = ?
        AND prev_event_id IS NOT ?
        AND delivery_state = 'pending'
        AND delivery_attempts = 0
        AND remote_inbox_id IS NULL
    `).run(prevEventId, eventId, prevEventId);
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
    const delivery = this.db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE delivery_state = 'pending') AS deliveryPending,
        COUNT(*) FILTER (WHERE delivery_state = 'claimed') AS deliveryClaimed,
        COUNT(*) FILTER (WHERE delivery_state = 'retry') AS deliveryRetry,
        COUNT(*) FILTER (WHERE delivery_state = 'replicated') AS deliveryReplicated,
        COUNT(*) FILTER (WHERE delivery_state = 'acknowledged') AS deliveryAcknowledged,
        COUNT(*) FILTER (
          WHERE delivery_state = 'acknowledged'
            AND remote_inbox_id IS NOT NULL
            AND remote_pruned_at IS NULL
        ) AS deliveryAwaitingRemotePrune,
        COUNT(*) FILTER (WHERE delivery_state = 'quarantined') AS deliveryQuarantined,
        MIN(created_at) FILTER (
          WHERE delivery_state <> 'acknowledged'
        ) AS oldestDeliveryAt
      FROM events
    `).get() as {
      deliveryPending: number;
      deliveryClaimed: number;
      deliveryRetry: number;
      deliveryReplicated: number;
      deliveryAcknowledged: number;
      deliveryAwaitingRemotePrune: number;
      deliveryQuarantined: number;
      oldestDeliveryAt: string | null;
    };

    return {
      totalEvents: eventTotals.totalEvents,
      unprocessed: unprocessedRow.unprocessed,
      errors: errorTotals.errors,
      lastCapture: eventTotals.lastCapture,
      lastError: errorTotals.lastError,
      ...delivery,
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
    const normalizedMaxRows = Math.max(0, Math.trunc(maxRows));
    const candidates = this.db.prepare(`
      WITH age_candidates AS (
        SELECT event_id
        FROM events
        WHERE processed_at IS NULL
          AND created_at < datetime('now', '-' || ? || ' days')
      ),
      remaining AS (
        SELECT event_id
        FROM events
        WHERE processed_at IS NULL
          AND event_id NOT IN (SELECT event_id FROM age_candidates)
        ORDER BY event_id DESC
        LIMIT ?
      )
      SELECT COUNT(*) AS retained
      FROM events
      WHERE processed_at IS NULL
        AND (
          event_id NOT IN (
            SELECT event_id FROM age_candidates
            UNION ALL
            SELECT event_id FROM remaining
          )
          OR event_id IN (SELECT event_id FROM age_candidates)
        )
    `).get(maxAgeDays, normalizedMaxRows) as { retained: number };
    if (candidates.retained > 0) {
      this.db.prepare(
        "INSERT INTO error_log (hook, error, session_id) VALUES (?, ?, NULL)"
      ).run(
        "maintenance:pruneUnprocessed",
        `retained ${candidates.retained} unprocessed events beyond the age/cap guard`,
      );
    }
    return { pruned: 0 };
  }

  claimDeliveries(input: LocalHookDeliveryClaimInput): EventRow[] {
    const machineId = eventUuid(input.machineId);
    const claimOwner = nonblank(input.claimOwner, "claim owner");
    const limit = positiveBatchLimit(input.limit, "delivery limit");
    const staleClaimMs = nonnegativeMilliseconds(input.staleClaimMs, "stale claim milliseconds");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const mismatch = this.db.prepare(`
        SELECT event_uuid
        FROM events
        WHERE machine_id IS NOT NULL
          AND machine_id <> ?
          AND delivery_state <> 'acknowledged'
        ORDER BY machine_sequence
        LIMIT 1
      `).get(machineId) as { event_uuid: string } | undefined;
      if (mismatch) {
        throw new Error(
          `local hook event ${mismatch.event_uuid} belongs to a different machine`,
        );
      }
      this.db.prepare(`
        UPDATE events
        SET machine_id = ?,
            delivery_generation = delivery_generation + 1,
            delivery_updated_at = datetime('now')
        WHERE machine_id IS NULL
      `).run(machineId);
      const candidates = this.db.prepare(`
        WITH ordered AS (
          SELECT
            event_id,
            machine_sequence,
            CASE
              WHEN delivery_state IN ('pending', 'retry')
                AND delivery_next_attempt_at <= datetime('now')
                THEN 1
              WHEN delivery_state = 'claimed'
                AND julianday(delivery_claimed_at)
                      <= julianday('now') - (? / 86400000.0)
                THEN 1
              ELSE 0
            END AS eligible,
            SUM(
              CASE
                WHEN delivery_state IN ('pending', 'retry')
                  AND delivery_next_attempt_at <= datetime('now')
                  THEN 0
                WHEN delivery_state = 'claimed'
                  AND julianday(delivery_claimed_at)
                        <= julianday('now') - (? / 86400000.0)
                  THEN 0
                ELSE 1
              END
            ) OVER (
              ORDER BY machine_sequence, event_id
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS blockers
          FROM events
          WHERE delivery_state IN ('pending', 'retry', 'claimed')
        )
        SELECT event_id
        FROM ordered
        WHERE eligible = 1
          AND blockers = 0
        ORDER BY machine_sequence, event_id
        LIMIT ?
      `).all(staleClaimMs, staleClaimMs, limit) as Array<{ event_id: number }>;
      if (candidates.length === 0) {
        this.db.exec("COMMIT");
        return [];
      }
      const placeholders = candidates.map(() => "?").join(",");
      this.db.prepare(`
        UPDATE events
        SET delivery_state = 'claimed',
            delivery_generation = delivery_generation + 1,
            delivery_attempts = delivery_attempts + 1,
            delivery_owner = ?,
            delivery_claimed_at = datetime('now'),
            delivery_last_error = NULL,
            quarantine_reason = NULL,
            delivery_updated_at = datetime('now')
        WHERE event_id IN (${placeholders})
      `).run(claimOwner, ...candidates.map(({ event_id: id }) => id));
      const claimed = this.db.prepare(`
        SELECT *
        FROM events
        WHERE event_id IN (${placeholders})
        ORDER BY machine_sequence, event_id
      `).all(...candidates.map(({ event_id: id }) => id)) as unknown as EventRow[];
      this.db.exec("COMMIT");
      return claimed;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve claim failure */ }
      throw error;
    }
  }

  markReplicated(eventId: string, claimOwner: string, remoteInboxId: bigint): boolean {
    const inboxId = formatRemoteInboxId(remoteInboxId);
    const result = this.db.prepare(`
      UPDATE events
      SET delivery_state = 'replicated',
          delivery_generation = delivery_generation + 1,
          delivery_owner = NULL,
          delivery_claimed_at = NULL,
          delivery_last_error = NULL,
          remote_inbox_id = ?,
          quarantine_reason = NULL,
          delivery_updated_at = datetime('now')
      WHERE event_uuid = ?
        AND delivery_state = 'claimed'
        AND delivery_owner = ?
    `).run(
      inboxId,
      eventUuid(eventId),
      nonblank(claimOwner, "claim owner"),
    );
    return Number(result.changes) === 1;
  }

  markDeliveryRetry(
    eventId: string,
    claimOwner: string,
    error: string,
    nextAttemptAt: string,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE events
      SET delivery_state = 'retry',
          delivery_generation = delivery_generation + 1,
          delivery_owner = NULL,
          delivery_claimed_at = NULL,
          delivery_next_attempt_at = datetime(?),
          delivery_last_error = ?,
          quarantine_reason = NULL,
          delivery_updated_at = datetime('now')
      WHERE event_uuid = ?
        AND delivery_state = 'claimed'
        AND delivery_owner = ?
    `).run(
      nextAttemptAt,
      sanitizeHookErrorDiagnostic(error),
      eventUuid(eventId),
      nonblank(claimOwner, "claim owner"),
    );
    return Number(result.changes) === 1;
  }

  markDeliveryQuarantined(
    eventId: string,
    claimOwner: string,
    reason: string,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE events
      SET delivery_state = 'quarantined',
          delivery_generation = delivery_generation + 1,
          delivery_owner = NULL,
          delivery_claimed_at = NULL,
          delivery_last_error = NULL,
          quarantine_reason = ?,
          delivery_updated_at = datetime('now')
      WHERE event_uuid = ?
        AND delivery_state = 'claimed'
        AND delivery_owner = ?
        AND remote_inbox_id IS NULL
    `).run(
      sanitizeHookErrorDiagnostic(reason),
      eventUuid(eventId),
      nonblank(claimOwner, "claim owner"),
    );
    return Number(result.changes) === 1;
  }

  listAwaitingRemote(
    limit = EVENTS_DELIVERY_BATCH_LIMIT,
    includeQuarantined = false,
  ): EventRow[] {
    const normalizedLimit = positiveBatchLimit(limit, "delivery limit");
    return this.db.prepare(`
      SELECT *
      FROM events
      WHERE (
          delivery_state = 'replicated'
          OR (? = 1 AND delivery_state = 'quarantined')
        )
        AND remote_inbox_id IS NOT NULL
      ORDER BY machine_sequence, event_id
      LIMIT ?
    `).all(includeQuarantined ? 1 : 0, normalizedLimit) as unknown as EventRow[];
  }

  listQuarantined(limit = EVENTS_DELIVERY_BATCH_LIMIT): EventRow[] {
    const normalizedLimit = positiveBatchLimit(limit, "delivery limit");
    return this.db.prepare(`
      SELECT *
      FROM events
      WHERE delivery_state = 'quarantined'
      ORDER BY machine_sequence, event_id
      LIMIT ?
    `).all(normalizedLimit) as unknown as EventRow[];
  }

  markAcknowledged(eventId: string, remoteInboxId: bigint): boolean {
    const inboxId = formatRemoteInboxId(remoteInboxId);
    const result = this.db.prepare(`
      UPDATE events
      SET delivery_state = 'acknowledged',
          delivery_generation = delivery_generation + 1,
          delivery_owner = NULL,
          delivery_claimed_at = NULL,
          delivery_last_error = NULL,
          remote_inbox_id = ?,
          quarantine_reason = NULL,
          acknowledged_at = COALESCE(acknowledged_at, datetime('now')),
          delivery_updated_at = datetime('now')
      WHERE event_uuid = ?
        AND (remote_inbox_id IS NULL OR remote_inbox_id = ?)
        AND (
          delivery_state <> 'acknowledged'
          OR acknowledged_at IS NULL
        )
    `).run(
      inboxId,
      eventUuid(eventId),
      inboxId,
    );
    return Number(result.changes) === 1;
  }

  markQuarantined(eventId: string, remoteInboxId: bigint, reason: string): boolean {
    const inboxId = formatRemoteInboxId(remoteInboxId);
    const sanitizedReason = sanitizeHookErrorDiagnostic(reason);
    const result = this.db.prepare(`
      UPDATE events
      SET delivery_state = 'quarantined',
          delivery_generation = delivery_generation + 1,
          delivery_owner = NULL,
          delivery_claimed_at = NULL,
          delivery_last_error = NULL,
          remote_inbox_id = ?,
          quarantine_reason = ?,
          delivery_updated_at = datetime('now')
      WHERE event_uuid = ?
        AND (remote_inbox_id IS NULL OR remote_inbox_id = ?)
        AND delivery_state <> 'acknowledged'
        AND (
          delivery_state <> 'quarantined'
          OR quarantine_reason <> ?
        )
    `).run(
      inboxId,
      sanitizedReason,
      eventUuid(eventId),
      inboxId,
      sanitizedReason,
    );
    return Number(result.changes) === 1;
  }

  replayQuarantined(eventId: string): boolean {
    const result = this.db.prepare(`
      UPDATE events
      SET delivery_state = CASE
            WHEN remote_inbox_id IS NULL THEN 'pending'
            ELSE 'replicated'
          END,
          delivery_generation = delivery_generation + 1,
          delivery_next_attempt_at = datetime('now'),
          delivery_last_error = NULL,
          quarantine_reason = NULL,
          delivery_updated_at = datetime('now')
      WHERE event_uuid = ?
        AND delivery_state = 'quarantined'
    `).run(eventUuid(eventId));
    return Number(result.changes) === 1;
  }

  listAcknowledgedForRemotePrune(limit = EVENTS_DELIVERY_BATCH_LIMIT): EventRow[] {
    const normalizedLimit = positiveBatchLimit(limit, "delivery limit");
    return this.db.prepare(`
      SELECT *
      FROM events
      WHERE delivery_state = 'acknowledged'
        AND remote_inbox_id IS NOT NULL
        AND remote_pruned_at IS NULL
      ORDER BY machine_sequence, event_id
      LIMIT ?
    `).all(normalizedLimit) as unknown as EventRow[];
  }

  markRemotePruned(eventId: string): boolean {
    const result = this.db.prepare(`
      UPDATE events
      SET remote_pruned_at = COALESCE(remote_pruned_at, datetime('now')),
          delivery_generation = delivery_generation + 1,
          delivery_updated_at = datetime('now')
      WHERE event_uuid = ?
        AND delivery_state = 'acknowledged'
        AND remote_inbox_id IS NOT NULL
        AND remote_pruned_at IS NULL
    `).run(eventUuid(eventId));
    return Number(result.changes) === 1;
  }

  getDeliveryDiagnostics(): LocalHookDeliveryDiagnostics {
    return this.db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE delivery_state = 'pending') AS pending,
        COUNT(*) FILTER (WHERE delivery_state = 'claimed') AS claimed,
        COUNT(*) FILTER (WHERE delivery_state = 'retry') AS retry,
        COUNT(*) FILTER (WHERE delivery_state = 'replicated') AS replicated,
        COUNT(*) FILTER (WHERE delivery_state = 'acknowledged') AS acknowledged,
        COUNT(*) FILTER (
          WHERE delivery_state = 'acknowledged'
            AND remote_inbox_id IS NOT NULL
            AND remote_pruned_at IS NULL
        ) AS awaitingRemotePrune,
        COUNT(*) FILTER (WHERE delivery_state = 'quarantined') AS quarantined,
        MIN(delivery_next_attempt_at) FILTER (
          WHERE delivery_state IN ('pending', 'retry')
        ) AS oldestReadyAt,
        MIN(delivery_claimed_at) FILTER (
          WHERE delivery_state = 'claimed'
        ) AS oldestClaimedAt
      FROM events
    `).get() as unknown as LocalHookDeliveryDiagnostics;
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
    try { this.removeBusyTimeoutOverride(); } catch { /* timeout restoration is best-effort */ }
    try {
      this.sequenceAllocator?.close();
    } finally {
      try {
        closeLcmConnection(this.dbPath, this.db);
      } finally {
        // If the connection was fully evicted from the pool, invalidate the
        // migration cache so the next open re-runs migrations on a fresh handle.
        if (!isLcmConnectionOpen(this.dbPath)) {
          _migratedPaths.delete(this.dbPath);
        }
      }
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
