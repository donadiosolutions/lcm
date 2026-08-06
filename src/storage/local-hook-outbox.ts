import { EventsDb } from "../hooks/events-db.js";
import { StorageOperationError } from "./errors.js";

export interface LocalHookEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
  tags?: string[];
}

export const LOCAL_HOOK_EVENT_ENVELOPE_VERSION = 1 as const;

export type LocalHookDeliveryState =
  | "pending"
  | "claimed"
  | "retry"
  | "replicated"
  | "acknowledged"
  | "quarantined";

export interface LocalHookEventRow {
  event_id: number;
  event_uuid: string;
  event_version: number;
  machine_id: string | null;
  machine_sequence: string;
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
  delivery_state: LocalHookDeliveryState;
  delivery_generation: number;
  delivery_attempts: number;
  delivery_owner: string | null;
  delivery_claimed_at: string | null;
  delivery_next_attempt_at: string;
  delivery_last_error: string | null;
  remote_inbox_id: string | null;
  quarantine_reason: string | null;
  acknowledged_at: string | null;
  remote_pruned_at: string | null;
  delivery_updated_at: string;
}

export interface LocalHookOutboxHealth {
  totalEvents: number;
  unprocessed: number;
  errors: number;
  lastCapture: string | null;
  lastError: string | null;
  deliveryPending: number;
  deliveryClaimed: number;
  deliveryRetry: number;
  deliveryReplicated: number;
  deliveryAcknowledged: number;
  deliveryAwaitingRemotePrune: number;
  deliveryQuarantined: number;
  oldestDeliveryAt: string | null;
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

export interface LocalHookDeliveryClaimInput {
  readonly machineId: string;
  readonly claimOwner: string;
  readonly limit: number;
  readonly staleClaimMs: number;
}

export interface LocalHookDeliveryDiagnostics {
  readonly pending: number;
  readonly claimed: number;
  readonly retry: number;
  readonly replicated: number;
  readonly acknowledged: number;
  readonly awaitingRemotePrune: number;
  readonly quarantined: number;
  readonly oldestReadyAt: string | null;
  readonly oldestClaimedAt: string | null;
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
  claimDeliveries(input: LocalHookDeliveryClaimInput): Promise<LocalHookEventRow[]>;
  markReplicated(
    eventUuid: string,
    claimOwner: string,
    remoteInboxId: bigint,
  ): Promise<boolean>;
  markDeliveryRetry(
    eventUuid: string,
    claimOwner: string,
    error: string,
    nextAttemptAt: string,
  ): Promise<boolean>;
  markDeliveryQuarantined(
    eventUuid: string,
    claimOwner: string,
    reason: string,
  ): Promise<boolean>;
  listAwaitingRemote(
    limit?: number,
    includeQuarantined?: boolean,
  ): Promise<LocalHookEventRow[]>;
  listQuarantined(limit?: number): Promise<LocalHookEventRow[]>;
  markAcknowledged(eventUuid: string, remoteInboxId: bigint): Promise<boolean>;
  markQuarantined(
    eventUuid: string,
    remoteInboxId: bigint,
    reason: string,
  ): Promise<boolean>;
  replayQuarantined(eventUuid: string): Promise<boolean>;
  listAcknowledgedForRemotePrune(limit?: number): Promise<LocalHookEventRow[]>;
  markRemotePruned(eventUuid: string): Promise<boolean>;
  getDeliveryDiagnostics(): Promise<LocalHookDeliveryDiagnostics>;
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
      throw new StorageOperationError(
        "STORAGE_CLOSED",
        "sqlite",
        undefined,
        "passive-events",
        "open",
      );
    }

    return this.register(new EventsDb(dbPath, options));
  }

  /** Open an existing local outbox without creating its file or parent directory. */
  async openExisting(
    dbPath: string,
    options: LocalHookOutboxOpenOptions = {},
  ): Promise<LocalHookOutboxRepository | null> {
    if (this.closed) {
      throw new StorageOperationError(
        "STORAGE_CLOSED",
        "sqlite",
        undefined,
        "passive-events",
        "openExisting",
      );
    }

    const database = EventsDb.openExisting(dbPath, options);
    return database === null ? null : this.register(database);
  }

  private register(database: EventsDb): LocalHookOutboxRepository {
    let repository: SQLiteLocalHookOutboxRepository;
    repository = new SQLiteLocalHookOutboxRepository(
      database,
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
    this.assertOpen("insertEvent");
    return this.database.insertEvent(sessionId, event, sourceHook);
  }

  async getUnprocessed(limit?: number): Promise<LocalHookEventRow[]> {
    this.assertOpen("getUnprocessed");
    return this.database.getUnprocessed(limit);
  }

  async markProcessed(eventIds: number[]): Promise<void> {
    this.assertOpen("markProcessed");
    this.database.markProcessed(eventIds);
  }

  async pruneProcessed(olderThanDays: number): Promise<number> {
    this.assertOpen("pruneProcessed");
    return this.database.pruneProcessed(olderThanDays);
  }

  async setPrevEventId(eventId: number, prevEventId: number): Promise<void> {
    this.assertOpen("setPrevEventId");
    this.database.setPrevEventId(eventId, prevEventId);
  }

  async getPatternReinforcement(
    type: string,
    category: string,
    data: string,
    maxAgeDays?: number,
  ): Promise<PatternReinforcementStats> {
    this.assertOpen("getPatternReinforcement");
    return this.database.getPatternReinforcement(type, category, data, maxAgeDays);
  }

  async logHookError(hook: string, error: unknown, sessionId?: string): Promise<void> {
    this.assertOpen("logHookError");
    this.database.logHookError(hook, error, sessionId);
  }

  async getHealthStats(): Promise<LocalHookOutboxHealth> {
    this.assertOpen("getHealthStats");
    return this.database.getHealthStats();
  }

  async getRecentErrors(options?: LocalHookErrorQuery): Promise<LocalHookErrorRecord[]> {
    this.assertOpen("getRecentErrors");
    return this.database.getRecentErrors(options);
  }

  async pruneUnprocessed(maxRows?: number, maxAgeDays?: number): Promise<{ pruned: number }> {
    this.assertOpen("pruneUnprocessed");
    return this.database.pruneUnprocessed(maxRows, maxAgeDays);
  }

  async pruneErrorLog(olderThanDays?: number): Promise<number> {
    this.assertOpen("pruneErrorLog");
    return this.database.pruneErrorLog(olderThanDays);
  }

  async claimDeliveries(input: LocalHookDeliveryClaimInput): Promise<LocalHookEventRow[]> {
    this.assertOpen("claimDeliveries");
    return this.database.claimDeliveries(input);
  }

  async markReplicated(
    eventUuid: string,
    claimOwner: string,
    remoteInboxId: bigint,
  ): Promise<boolean> {
    this.assertOpen("markReplicated");
    return this.database.markReplicated(eventUuid, claimOwner, remoteInboxId);
  }

  async markDeliveryRetry(
    eventUuid: string,
    claimOwner: string,
    error: string,
    nextAttemptAt: string,
  ): Promise<boolean> {
    this.assertOpen("markDeliveryRetry");
    return this.database.markDeliveryRetry(eventUuid, claimOwner, error, nextAttemptAt);
  }

  async markDeliveryQuarantined(
    eventUuid: string,
    claimOwner: string,
    reason: string,
  ): Promise<boolean> {
    this.assertOpen("markDeliveryQuarantined");
    return this.database.markDeliveryQuarantined(eventUuid, claimOwner, reason);
  }

  async listAwaitingRemote(
    limit?: number,
    includeQuarantined?: boolean,
  ): Promise<LocalHookEventRow[]> {
    this.assertOpen("listAwaitingRemote");
    return this.database.listAwaitingRemote(limit, includeQuarantined);
  }

  async listQuarantined(limit?: number): Promise<LocalHookEventRow[]> {
    this.assertOpen("listQuarantined");
    return this.database.listQuarantined(limit);
  }

  async markAcknowledged(eventUuid: string, remoteInboxId: bigint): Promise<boolean> {
    this.assertOpen("markAcknowledged");
    return this.database.markAcknowledged(eventUuid, remoteInboxId);
  }

  async markQuarantined(
    eventUuid: string,
    remoteInboxId: bigint,
    reason: string,
  ): Promise<boolean> {
    this.assertOpen("markQuarantined");
    return this.database.markQuarantined(eventUuid, remoteInboxId, reason);
  }

  async replayQuarantined(eventUuid: string): Promise<boolean> {
    this.assertOpen("replayQuarantined");
    return this.database.replayQuarantined(eventUuid);
  }

  async listAcknowledgedForRemotePrune(limit?: number): Promise<LocalHookEventRow[]> {
    this.assertOpen("listAcknowledgedForRemotePrune");
    return this.database.listAcknowledgedForRemotePrune(limit);
  }

  async markRemotePruned(eventUuid: string): Promise<boolean> {
    this.assertOpen("markRemotePruned");
    return this.database.markRemotePruned(eventUuid);
  }

  async getDeliveryDiagnostics(): Promise<LocalHookDeliveryDiagnostics> {
    this.assertOpen("getDeliveryDiagnostics");
    return this.database.getDeliveryDiagnostics();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
    this.onClose();
  }

  private assertOpen(operation: string): void {
    if (!this.closed) return;
    throw new StorageOperationError(
      "STORAGE_CLOSED",
      "sqlite",
      undefined,
      "passive-events",
      operation,
    );
  }
}
