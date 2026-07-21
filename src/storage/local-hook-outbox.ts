import { EventsDb } from "../hooks/events-db.js";

export interface LocalHookEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
  tags?: string[];
}

export interface LocalHookEventRow {
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
  created_at: string;
}

export interface LocalHookOutboxHealth {
  totalEvents: number;
  unprocessed: number;
  errors: number;
  lastCapture: string | null;
  lastError: string | null;
}

export interface PatternReinforcementStats {
  totalCount: number;
  distinctSessions: number;
}

export interface LocalHookErrorRecord {
  created_at: string;
  hook: string;
  error: string;
  session_id?: string | null;
}

export interface LocalHookErrorQuery {
  limit?: number;
  includeMaintenance?: boolean;
}

export interface LocalHookOutboxRepository {
  insertEvent(sessionId: string, event: LocalHookEvent, sourceHook: string): Promise<number>;
  getUnprocessed(limit?: number): Promise<LocalHookEventRow[]>;
  markProcessed(eventIds: number[]): Promise<void>;
  pruneProcessed(olderThanDays: number): Promise<number>;
  setPrevEventId(eventId: number, prevEventId: number): Promise<void>;
  getPatternReinforcement(
    type: string,
    category: string,
    data: string,
    maxAgeDays?: number,
  ): Promise<PatternReinforcementStats>;
  logHookError(hook: string, error: unknown, sessionId?: string): Promise<void>;
  getHealthStats(): Promise<LocalHookOutboxHealth>;
  getRecentErrors(options?: LocalHookErrorQuery): Promise<LocalHookErrorRecord[]>;
  pruneUnprocessed(maxRows?: number, maxAgeDays?: number): Promise<{ pruned: number }>;
  pruneErrorLog(olderThanDays?: number): Promise<number>;
  close(): Promise<void>;
}

export interface LocalHookOutboxOpenOptions {
  busyTimeoutMs?: number;
}

/**
 * Opens explicitly local SQLite hook outboxes.
 *
 * This factory is intentionally separate from StorageBackendFactory: selecting
 * PostgreSQL for project storage must never move hook durability onto the
 * network or turn the outbox into a general backend cache.
 */
export class SQLiteLocalHookOutboxFactory {
  private readonly repositories = new Set<SQLiteLocalHookOutboxRepository>();
  private closed = false;

  async open(
    dbPath: string,
    options: LocalHookOutboxOpenOptions = {},
  ): Promise<LocalHookOutboxRepository> {
    if (this.closed) {
      throw new Error("local hook outbox factory is closed");
    }

    let repository: SQLiteLocalHookOutboxRepository;
    repository = new SQLiteLocalHookOutboxRepository(
      new EventsDb(dbPath, options),
      () => this.repositories.delete(repository),
    );
    this.repositories.add(repository);
    return repository;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const repositories = [...this.repositories];
    this.repositories.clear();
    await Promise.all(repositories.map((repository) => repository.close()));
  }
}

class SQLiteLocalHookOutboxRepository implements LocalHookOutboxRepository {
  private closed = false;

  constructor(
    private readonly database: EventsDb,
    private readonly onClose: () => void,
  ) {}

  async insertEvent(sessionId: string, event: LocalHookEvent, sourceHook: string): Promise<number> {
    return this.database.insertEvent(sessionId, event, sourceHook);
  }

  async getUnprocessed(limit?: number): Promise<LocalHookEventRow[]> {
    return this.database.getUnprocessed(limit);
  }

  async markProcessed(eventIds: number[]): Promise<void> {
    this.database.markProcessed(eventIds);
  }

  async pruneProcessed(olderThanDays: number): Promise<number> {
    return this.database.pruneProcessed(olderThanDays);
  }

  async setPrevEventId(eventId: number, prevEventId: number): Promise<void> {
    this.database.setPrevEventId(eventId, prevEventId);
  }

  async getPatternReinforcement(
    type: string,
    category: string,
    data: string,
    maxAgeDays?: number,
  ): Promise<PatternReinforcementStats> {
    return this.database.getPatternReinforcement(type, category, data, maxAgeDays);
  }

  async logHookError(hook: string, error: unknown, sessionId?: string): Promise<void> {
    this.database.logHookError(hook, error, sessionId);
  }

  async getHealthStats(): Promise<LocalHookOutboxHealth> {
    return this.database.getHealthStats();
  }

  async getRecentErrors(options?: LocalHookErrorQuery): Promise<LocalHookErrorRecord[]> {
    return this.database.getRecentErrors(options);
  }

  async pruneUnprocessed(maxRows?: number, maxAgeDays?: number): Promise<{ pruned: number }> {
    return this.database.pruneUnprocessed(maxRows, maxAgeDays);
  }

  async pruneErrorLog(olderThanDays?: number): Promise<number> {
    return this.database.pruneErrorLog(olderThanDays);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
    this.onClose();
  }
}
