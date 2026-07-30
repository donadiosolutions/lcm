import type { JsonObject } from "../storage/contracts.js";
import {
  LOCAL_HOOK_EVENT_ENVELOPE_VERSION,
  type LocalHookEventRow,
  type LocalHookOutboxRepository,
} from "../storage/local-hook-outbox.js";
import {
  PostgreSqlPassiveEventDataError,
  PostgreSqlPassiveEventRepository,
  type PostgreSqlPassiveEventRecord,
} from "../storage/postgresql/passive-event-repository.js";
import type {
  PostgreSqlPassiveEventClaim,
} from "../storage/postgresql/coordination.js";
import type { PostgreSqlQueryExecutor } from "../storage/postgresql/contracts.js";
import { sanitizeHookErrorDiagnostic } from "../hooks/hook-error-diagnostic.js";

export const PASSIVE_EVENT_REPLICATION_DEFAULTS = {
  batchSize: 100,
  staleClaimMs: 60_000,
  leaseTtlMs: 30_000,
  pollIntervalMs: 3_000,
  retryBaseMs: 1_000,
  retryMaxMs: 5 * 60_000,
  retryJitterRatio: 0.2,
  quarantineAfterAttempts: 5,
} as const;

export interface PassiveEventReplicationOptions {
  readonly processId: string;
  readonly batchSize?: number;
  readonly staleClaimMs?: number;
  readonly leaseTtlMs?: number;
  readonly pollIntervalMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly retryJitterRatio?: number;
  readonly quarantineAfterAttempts?: number;
}

export interface PassiveEventReplicationResult {
  readonly leaseAcquired: boolean;
  readonly uploaded: number;
  readonly applied: number;
  readonly retried: number;
  readonly quarantined: number;
  readonly acknowledged: number;
  readonly pruned: number;
}

export interface PassiveEventReplicationDependencies {
  readonly local: LocalHookOutboxRepository;
  readonly remote: PostgreSqlPassiveEventRepository;
  readonly applyEvent: (
    executor: PostgreSqlQueryExecutor,
    event: PostgreSqlPassiveEventClaim,
  ) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly onError?: (error: unknown) => void | Promise<void>;
}

type Timer = ReturnType<typeof setTimeout>;

function positiveInteger(value: number, field: string, maximum?: number): number {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || (maximum !== undefined && value > maximum)
  ) {
    throw new Error(
      `${field} must be a positive safe integer`
        + (maximum === undefined ? "" : ` no greater than ${maximum}`),
    );
  }
  return value;
}

function jitterRatio(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("retry jitter ratio must be between 0 and 1");
  }
  return value;
}

function deterministicRetryRandom(eventId: string, attempt: number): number {
  let hash = 2_166_136_261;
  const input = `${eventId}:${String(attempt)}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

function eventPayload(event: LocalHookEventRow): JsonObject {
  return {
    sessionId: event.session_id,
    sessionSequence: event.seq,
    category: event.category,
    data: event.data,
    priority: event.priority,
    sourceHook: event.source_hook,
    previousEventId: event.prev_event_id,
    createdAt: event.created_at,
  };
}

function sameEnvelope(
  local: LocalHookEventRow,
  remote: PostgreSqlPassiveEventRecord,
): boolean {
  const payload = remote.payload as Record<string, unknown>;
  return local.machine_id === remote.machineId
    && local.event_uuid === remote.eventId
    && local.event_version === remote.eventVersion
    && BigInt(local.machine_sequence) === remote.machineSequence
    && local.type === remote.eventType
    && payload.sessionId === local.session_id
    && payload.sessionSequence === local.seq
    && payload.category === local.category
    && payload.data === local.data
    && payload.priority === local.priority
    && payload.sourceHook === local.source_hook
    && payload.previousEventId === local.prev_event_id
    && payload.createdAt === local.created_at;
}

function supportsEnvelopeVersion(version: number): boolean {
  return Number.isSafeInteger(version)
    && version >= 1
    && version <= LOCAL_HOOK_EVENT_ENVELOPE_VERSION;
}

function result(): PassiveEventReplicationResult {
  return {
    leaseAcquired: false,
    uploaded: 0,
    applied: 0,
    retried: 0,
    quarantined: 0,
    acknowledged: 0,
    pruned: 0,
  };
}

export class PassiveEventReplicationWorker {
  private readonly options: Required<PassiveEventReplicationOptions>;
  private readonly now: () => number;
  private readonly random: (eventId: string, attempt: number) => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly onError: (error: unknown) => void | Promise<void>;
  private timer: Timer | null = null;
  private running: Promise<PassiveEventReplicationResult> | null = null;
  private stopped = false;

  constructor(private readonly dependencies: PassiveEventReplicationDependencies, options: PassiveEventReplicationOptions) {
    this.options = {
      processId: options.processId.trim(),
      batchSize: positiveInteger(
        options.batchSize ?? PASSIVE_EVENT_REPLICATION_DEFAULTS.batchSize,
        "replication batch size",
        500,
      ),
      staleClaimMs: positiveInteger(
        options.staleClaimMs ?? PASSIVE_EVENT_REPLICATION_DEFAULTS.staleClaimMs,
        "stale claim milliseconds",
      ),
      leaseTtlMs: positiveInteger(
        options.leaseTtlMs ?? PASSIVE_EVENT_REPLICATION_DEFAULTS.leaseTtlMs,
        "lease TTL milliseconds",
      ),
      pollIntervalMs: positiveInteger(
        options.pollIntervalMs ?? PASSIVE_EVENT_REPLICATION_DEFAULTS.pollIntervalMs,
        "poll interval milliseconds",
      ),
      retryBaseMs: positiveInteger(
        options.retryBaseMs ?? PASSIVE_EVENT_REPLICATION_DEFAULTS.retryBaseMs,
        "retry base milliseconds",
      ),
      retryMaxMs: positiveInteger(
        options.retryMaxMs ?? PASSIVE_EVENT_REPLICATION_DEFAULTS.retryMaxMs,
        "retry maximum milliseconds",
      ),
      retryJitterRatio: jitterRatio(
        options.retryJitterRatio ?? PASSIVE_EVENT_REPLICATION_DEFAULTS.retryJitterRatio,
      ),
      quarantineAfterAttempts: positiveInteger(
        options.quarantineAfterAttempts
          ?? PASSIVE_EVENT_REPLICATION_DEFAULTS.quarantineAfterAttempts,
        "quarantine attempt count",
      ),
    };
    if (this.options.processId.length === 0) {
      throw new Error("replication process ID must not be blank");
    }
    if (this.options.retryBaseMs > this.options.retryMaxMs) {
      throw new Error("retry base milliseconds must not exceed retry maximum milliseconds");
    }
    this.now = dependencies.now ?? Date.now;
    const injectedRandom = dependencies.random;
    this.random = injectedRandom === undefined
      ? deterministicRetryRandom
      : () => injectedRandom();
    this.setTimer = dependencies.setTimeout ?? setTimeout;
    this.clearTimer = dependencies.clearTimeout ?? clearTimeout;
    this.onError = dependencies.onError ?? (() => undefined);
  }

  start(): void {
    if (this.stopped || this.timer !== null || this.running !== null) return;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    await this.running;
  }

  async runOnce(signal?: AbortSignal): Promise<PassiveEventReplicationResult> {
    if (this.running !== null) return this.running;
    const operation = this.performOnce(signal);
    this.running = operation;
    try {
      return await operation;
    } finally {
      this.running = null;
    }
  }

  private async performOnce(signal?: AbortSignal): Promise<PassiveEventReplicationResult> {
    const summary = result();
    const lease = await this.dependencies.remote.acquireDrainLease(
      this.options.processId,
      this.options.leaseTtlMs,
      signal,
    );
    if (!lease) return summary;
    const mutable = { ...summary, leaseAcquired: true };
    try {
      await this.uploadLocal(mutable, signal);
      if (!await this.renewLease(lease.fencingToken, signal)) return mutable;
      const claims = await this.dependencies.remote.claimEvents({
        claimOwner: `${this.options.processId}:${lease.fencingToken.toString()}`,
        limit: this.options.batchSize,
        staleClaimMs: this.options.staleClaimMs,
        signal,
      });
      for (const claim of claims) {
        if (!await this.renewLease(lease.fencingToken, signal)) break;
        await this.applyClaim(claim, lease.fencingToken, mutable, signal);
      }
      await this.reconcileLocal(mutable, signal);
      await this.pruneAcknowledged(mutable, signal);
      return mutable;
    } finally {
      try {
        await this.dependencies.remote.releaseDrainLease(
          this.options.processId,
          lease.fencingToken,
          undefined,
        );
      } catch (error) {
        await this.reportError(error);
      }
    }
  }

  private async uploadLocal(
    summary: {
      uploaded: number;
      retried: number;
      quarantined: number;
      acknowledged: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const owner = `${this.options.processId}:local`;
    const claimed = await this.dependencies.local.claimDeliveries({
      machineId: this.dependencies.remote.machineId,
      claimOwner: owner,
      limit: this.options.batchSize,
      staleClaimMs: this.options.staleClaimMs,
    });
    if (claimed.length === 0) return;
    const supported: LocalHookEventRow[] = [];
    for (const event of claimed) {
      if (supportsEnvelopeVersion(event.event_version)) {
        supported.push(event);
        continue;
      }
      if (await this.dependencies.local.markDeliveryQuarantined(
        event.event_uuid,
        owner,
        `unsupported local hook event envelope version ${String(event.event_version)}`,
      )) {
        summary.quarantined += 1;
      }
    }
    if (supported.length === 0) return;
    let remote: PostgreSqlPassiveEventRecord[];
    try {
      remote = await this.dependencies.remote.insertEvents(
        supported.map((event) => ({
          eventId: event.event_uuid,
          eventVersion: event.event_version,
          machineId: event.machine_id!,
          machineSequence: BigInt(event.machine_sequence),
          eventType: event.type,
          payload: eventPayload(event),
        })),
        signal,
      );
    } catch (insertError) {
      try {
        remote = await this.dependencies.remote.readEvents(
          supported.map((event) => ({
            machineId: event.machine_id!,
            eventId: event.event_uuid,
          })),
          signal,
        );
        const byId = new Map(remote.map((event) => [event.eventId, event]));
        if (
          supported.some((event) => {
            const record = byId.get(event.event_uuid);
            return record === undefined || !sameEnvelope(event, record);
          })
        ) {
          throw insertError;
        }
      } catch (readbackError) {
        for (const event of supported) {
          const disposition = await this.recoverLocalDelivery(
            event,
            owner,
            readbackError,
          );
          if (disposition === "quarantined") summary.quarantined += 1;
          if (disposition === "retried") summary.retried += 1;
        }
        return;
      }
    }
    const byId = new Map(remote.map((event) => [event.eventId, event]));
    for (const event of supported) {
      const record = byId.get(event.event_uuid);
      if (!record || !sameEnvelope(event, record)) {
        if (await this.retryLocal(event, owner, "remote inbox readback mismatch")) {
          summary.retried += 1;
        }
        continue;
      }
      summary.uploaded += 1;
      if (record.status === "applied") {
        if (await this.dependencies.local.markAcknowledged(
          event.event_uuid,
          record.inboxId,
        )) {
          summary.acknowledged += 1;
        }
      } else if (record.status === "quarantined") {
        if (await this.dependencies.local.markQuarantined(
          event.event_uuid,
          record.inboxId,
          record.quarantineReason ?? "remote event quarantined",
        )) {
          summary.quarantined += 1;
        }
      } else {
        await this.dependencies.local.markReplicated(
          event.event_uuid,
          owner,
          record.inboxId,
        );
      }
    }
  }

  private async applyClaim(
    claim: PostgreSqlPassiveEventClaim,
    fencingToken: bigint,
    summary: {
      applied: number;
      retried: number;
      quarantined: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!supportsEnvelopeVersion(claim.eventVersion)) {
      try {
        await this.dependencies.remote.quarantine({
          claim,
          processId: this.options.processId,
          fencingToken,
          reason: `unsupported local hook event envelope version ${String(claim.eventVersion)}`,
          signal,
        });
        summary.quarantined += 1;
      } catch (error) {
        try {
          const readback = await this.dependencies.remote.readEvent({
            machineId: claim.machineId,
            eventId: claim.eventId,
          }, signal);
          if (readback?.status === "quarantined") {
            summary.quarantined += 1;
          } else {
            await this.reportError(error);
          }
        } catch (readbackError) {
          await this.reportError(readbackError);
        }
      }
      return;
    }
    try {
      await this.dependencies.remote.completeApplied({
        claim,
        processId: this.options.processId,
        fencingToken,
        signal,
      }, this.dependencies.applyEvent);
      summary.applied += 1;
      return;
    } catch (error) {
      let readback: PostgreSqlPassiveEventRecord | null;
      try {
        readback = await this.dependencies.remote.readEvent({
          machineId: claim.machineId,
          eventId: claim.eventId,
        }, signal);
      } catch (readbackError) {
        await this.reportError(readbackError);
        return;
      }
      if (readback?.status === "applied") {
        summary.applied += 1;
        return;
      }
      if (
        readback?.status !== "claimed"
        || readback.claimedBy !== claim.claimedBy
      ) {
        await this.reportError(error);
        return;
      }
      if (claim.attemptCount >= this.options.quarantineAfterAttempts) {
        await this.dependencies.remote.quarantine({
          claim,
          processId: this.options.processId,
          fencingToken,
          reason: sanitizeHookErrorDiagnostic(
            error instanceof Error
              ? error.message
              : "passive event application failed",
          ),
          signal,
        });
        summary.quarantined += 1;
        return;
      }
      await this.dependencies.remote.scheduleRetry({
        claim,
        processId: this.options.processId,
        fencingToken,
        delayMs: this.retryDelay(claim.eventId, claim.attemptCount),
        signal,
      });
      summary.retried += 1;
    }
  }

  private async reconcileLocal(
    summary: { acknowledged: number; quarantined: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const local = await this.dependencies.local.listAwaitingRemote(this.options.batchSize);
    if (local.length === 0) return;
    const remote = await this.dependencies.remote.readEvents(
      local.map((event) => ({
        machineId: event.machine_id!,
        eventId: event.event_uuid,
      })),
      signal,
    );
    const byId = new Map(remote.map((event) => [event.eventId, event]));
    for (const event of local) {
      const record = byId.get(event.event_uuid);
      if (!record || !sameEnvelope(event, record)) continue;
      if (record.status === "applied") {
        if (await this.dependencies.local.markAcknowledged(
          event.event_uuid,
          record.inboxId,
        )) {
          summary.acknowledged += 1;
        }
      } else if (record.status === "quarantined") {
        if (await this.dependencies.local.markQuarantined(
          event.event_uuid,
          record.inboxId,
          record.quarantineReason ?? "remote event quarantined",
        )) {
          summary.quarantined += 1;
        }
      }
    }
  }

  private async pruneAcknowledged(
    summary: { pruned: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const acknowledged = await this.dependencies.local.listAcknowledgedForRemotePrune(
      this.options.batchSize,
    );
    if (acknowledged.length === 0) return;
    const keys = acknowledged.map((event) => ({
      inboxId: BigInt(event.remote_inbox_id!),
      machineId: event.machine_id!,
      eventId: event.event_uuid,
    }));
    let deleted: bigint | undefined;
    try {
      deleted = await this.dependencies.remote.pruneApplied(keys, signal);
    } catch (error) {
      await this.reportError(error);
    }
    let proven = new Set<string>();
    if (deleted === BigInt(acknowledged.length)) {
      proven = new Set(acknowledged.map((event) => event.event_uuid));
    } else {
      try {
        const remaining = await this.dependencies.remote.readEvents(
          acknowledged.map((event) => ({
            machineId: event.machine_id!,
            eventId: event.event_uuid,
          })),
          signal,
        );
        const remainingById = new Map(
          remaining.map((event) => [event.eventId, event]),
        );
        for (const event of acknowledged) {
          const record = remainingById.get(event.event_uuid);
          if (record === undefined) {
            proven.add(event.event_uuid);
          } else if (
            record.inboxId !== BigInt(event.remote_inbox_id!)
            || record.machineId !== event.machine_id
            || !sameEnvelope(event, record)
          ) {
            await this.reportError(
              new Error(`remote prune readback mismatch for ${event.event_uuid}`),
            );
          } else if (record.status !== "applied") {
            await this.reportError(
              new Error(
                `remote prune readback is ${record.status} for ${event.event_uuid}`,
              ),
            );
          }
        }
      } catch (error) {
        await this.reportError(error);
      }
    }
    for (const event of acknowledged) {
      if (!proven.has(event.event_uuid)) continue;
      if (await this.dependencies.local.markRemotePruned(event.event_uuid)) {
        summary.pruned += 1;
      }
    }
  }

  private retryDelay(eventId: string, attempt: number): number {
    const exponent = Math.max(0, Math.min(52, attempt - 1));
    const unjittered = Math.min(
      this.options.retryMaxMs,
      this.options.retryBaseMs * 2 ** exponent,
    );
    const random = this.random(eventId, attempt);
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      throw new Error("replication random source must return a number between 0 and 1");
    }
    const factor = 1 - this.options.retryJitterRatio
      + random * this.options.retryJitterRatio * 2;
    return Math.max(0, Math.min(this.options.retryMaxMs, Math.round(unjittered * factor)));
  }

  private retryLocal(
    event: LocalHookEventRow,
    owner: string,
    error: unknown,
  ): Promise<boolean> {
    const delay = this.retryDelay(event.event_uuid, event.delivery_attempts);
    return this.dependencies.local.markDeliveryRetry(
      event.event_uuid,
      owner,
      error instanceof Error ? error.message : String(error),
      new Date(this.now() + delay).toISOString(),
    );
  }

  private async recoverLocalDelivery(
    event: LocalHookEventRow,
    owner: string,
    error: unknown,
  ): Promise<"quarantined" | "retried" | null> {
    if (
      error instanceof PostgreSqlPassiveEventDataError
      && error.eventId === event.event_uuid
      && event.delivery_attempts >= this.options.quarantineAfterAttempts
    ) {
      const quarantined = await this.dependencies.local.markDeliveryQuarantined(
        event.event_uuid,
        owner,
        `remote envelope validation failed: ${error.field}`,
      );
      return quarantined ? "quarantined" : null;
    }
    return await this.retryLocal(event, owner, error) ? "retried" : null;
  }

  private async renewLease(
    fencingToken: bigint,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const renewed = await this.dependencies.remote.renewDrainLease(
      this.options.processId,
      fencingToken,
      this.options.leaseTtlMs,
      signal,
    );
    if (renewed !== null) return true;
    await this.reportError(new Error("passive-event drain lease expired"));
    return false;
  }

  private schedule(delayMs: number): void {
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.runOnce().catch(async (error) => {
        await this.reportError(error);
      }).finally(() => {
        if (!this.stopped) this.schedule(this.options.pollIntervalMs);
      });
    }, delayMs);
    try { this.timer.unref?.(); } catch { /* a ref'ed test timer is still safe */ }
  }

  private async reportError(error: unknown): Promise<void> {
    try {
      await this.onError(error);
    } catch {
      // Diagnostics must never replace or interrupt durable recovery.
    }
  }
}
