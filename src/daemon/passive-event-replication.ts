import type { JsonObject } from "../storage/contracts.js";
import {
  LOCAL_HOOK_EVENT_ENVELOPE_VERSION,
  type LocalHookEventRow,
  type LocalHookOutboxRepository,
} from "../storage/local-hook-outbox.js";
import {
  PostgreSqlPassiveEventDataError,
  PostgreSqlPassiveEventRepository,
  samePassiveEventPayload,
  type PostgreSqlPassiveEventInput,
  type PostgreSqlPassiveEventRecord,
  type PostgreSqlPassiveEventReleaseResult,
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

/**
 * One publication admission around a single replication phase. The daemon
 * pass supplies this so every phase re-checks the frozen startup backend
 * before touching replication state, while the consumer lock is released
 * between phases so hook appends can proceed. Absent, phases run directly.
 */
export type PassiveEventReplicationPhaseAdmission = <T>(operation: () => Promise<T>) => Promise<T>;

export interface PassiveEventReplicationDependencies {
  readonly local: LocalHookOutboxRepository;
  readonly remote: PostgreSqlPassiveEventRepository;
  readonly admitPhase?: PassiveEventReplicationPhaseAdmission;
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

function remoteInput(event: LocalHookEventRow): PostgreSqlPassiveEventInput {
  return {
    eventId: event.event_uuid,
    eventVersion: event.event_version,
    machineId: event.machine_id!,
    machineSequence: BigInt(event.machine_sequence),
    eventType: event.type,
    payload: eventPayload(event),
  };
}

/** What the bound project holds of an upload batch. */
interface UploadReadback {
  readonly records: PostgreSqlPassiveEventRecord[];
  readonly byId: ReadonlyMap<string, PostgreSqlPassiveEventRecord>;
  /** Batch rows the bound project lacks. */
  readonly missing: LocalHookEventRow[];
  /** Whether any returned record differs from its local row. */
  readonly differs: boolean;
}

export function sameEnvelope(
  local: LocalHookEventRow,
  remote: PostgreSqlPassiveEventRecord,
): boolean {
  return local.machine_id === remote.machineId
    && local.event_uuid === remote.eventId
    && local.event_version === remote.eventVersion
    && BigInt(local.machine_sequence) === remote.machineSequence
    && local.type === remote.eventType
    && samePassiveEventPayload(eventPayload(local), remote.payload);
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
    // Each phase runs under its own publication admission so the consumer
    // lock is released between phases and hook appends can proceed. Every
    // admission re-checks the frozen startup backend, so a publication
    // switch that lands between phases halts the pass at the next phase
    // instead of writing to a backend the daemon has already lost (#1384).
    // Without an admission the phases run directly, as a standalone worker
    // has no publication topology to consult.
    const admit = this.dependencies.admitPhase ?? (operation => operation());
    // The lease acquisition is itself a remote write, so it runs admitted:
    // a publication switch that lands before the pass starts must refuse
    // before any row is written to a backend the daemon has already lost.
    // Only the cleanup release below runs outside admission.
    const lease = await admit(() =>
      this.dependencies.remote.acquireDrainLease(
        this.options.processId,
        this.options.leaseTtlMs,
        signal,
      ),
    );
    if (!lease) return summary;
    const mutable = { ...summary, leaseAcquired: true };
    try {
      await admit(() => this.uploadLocal(mutable, signal));
      // The existing renewal below serves the first claim fetch.
      if (!await admit(() => this.renewLease(lease.fencingToken, signal))) return mutable;
      // A fetch returns at most one row per machine, because the claim query
      // withholds a row until every earlier row of its machine is terminal.
      // Applying a head therefore makes its successor claimable only after
      // the fetch has run, so the pass keeps claiming while its own applies
      // settle rows (#1530). The claimed-row budget is shared by every fetch
      // of the pass and never refunded, which bounds the fetch count by the
      // batch size. A fetch whose claims settle nothing ends the loop: no
      // successor can have become claimable from this pass's own work.
      let budget = this.options.batchSize;
      while (budget > 0) {
        const claims = await admit(() => this.dependencies.remote.claimEvents({
          claimOwner: `${this.options.processId}:${lease.fencingToken.toString()}`,
          limit: budget,
          staleClaimMs: this.options.staleClaimMs,
          signal,
        }));
        if (claims.length === 0) break;
        budget -= claims.length;
        // Taken here, not before uploadLocal: uploads and reconciliation also
        // move the quarantined counter and are not claim progress.
        const settledBefore = mutable.applied + mutable.quarantined;
        let kept = true;
        for (const claim of claims) {
          kept = await admit(async () => {
            if (!await this.renewLease(lease.fencingToken, signal)) return false;
            await this.applyClaim(claim, lease.fencingToken, mutable, signal);
            return true;
          });
          if (!kept) break;
        }
        if (!kept || budget <= 0) break;
        if (mutable.applied + mutable.quarantined === settledBefore) break;
        // The claim fetch itself is not fenced, so every further fetch needs
        // its own renewal. A lost lease stops claiming but still reconciles.
        if (!await admit(() => this.renewLease(lease.fencingToken, signal))) break;
      }
      await admit(() => this.reconcileLocal(mutable, signal));
      await admit(() => this.pruneAcknowledged(mutable, signal));
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
    let batch: readonly LocalHookEventRow[] = supported;
    let remote: PostgreSqlPassiveEventRecord[];
    try {
      remote = await this.dependencies.remote.insertEvents(batch.map(remoteInput), signal);
    } catch (insertError) {
      const settled = await this.settleFailedUpload(batch, owner, insertError, summary, signal);
      if (settled === null) return;
      ({ batch, remote } = settled);
    }
    const byId = new Map(remote.map((event) => [event.eventId, event]));
    for (const event of batch) {
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

  /**
   * What the bound project holds of an upload batch: the records it returned,
   * the rows it lacks, and whether any returned record differs from its row.
   */
  private async readBack(
    batch: readonly LocalHookEventRow[],
    signal?: AbortSignal,
  ): Promise<UploadReadback> {
    const records = await this.dependencies.remote.readEvents(
      batch.map((event) => ({
        machineId: event.machine_id!,
        eventId: event.event_uuid,
      })),
      signal,
    );
    const byId = new Map(records.map((event) => [event.eventId, event]));
    const missing: LocalHookEventRow[] = [];
    let differs = false;
    for (const event of batch) {
      const record = byId.get(event.event_uuid);
      if (record === undefined) missing.push(event);
      else if (!sameEnvelope(event, record)) differs = true;
    }
    return { records, byId, missing, differs };
  }

  private async recoverRow(
    event: LocalHookEventRow,
    owner: string,
    error: unknown,
    summary: { retried: number; quarantined: number },
  ): Promise<void> {
    const disposition = await this.recoverLocalDelivery(event, owner, error);
    if (disposition === "quarantined") summary.quarantined += 1;
    if (disposition === "retried") summary.retried += 1;
  }

  private async recoverBatch(
    batch: readonly LocalHookEventRow[],
    owner: string,
    error: unknown,
    summary: { retried: number; quarantined: number },
  ): Promise<void> {
    for (const event of batch) await this.recoverRow(event, owner, error, summary);
  }

  /**
   * An upload batch failed. The bound project is read back to tell an
   * uncertain commit (every row is there: adopt it) from a failure that left
   * rows out. A row that is out because its earlier upload committed to the
   * project this machine was bound to before a relink, and the local record
   * of it was lost, cannot be inserted while that copy exists and it fails
   * the whole batch (#1511). Any failure that left rows out, with no returned
   * row differing from its local row, therefore asks the other projects about
   * the missing rows once and inserts the batch once more without the rows
   * that cannot go. A differing row, a failed readback or a failed recovery
   * query leaves every row to retry with backoff. Returns the batch and
   * records to account for, or null when every row has been dealt with.
   */
  private async settleFailedUpload(
    batch: readonly LocalHookEventRow[],
    owner: string,
    insertError: unknown,
    summary: {
      retried: number;
      quarantined: number;
      acknowledged: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly batch: readonly LocalHookEventRow[];
    readonly remote: PostgreSqlPassiveEventRecord[];
  } | null> {
    let view: UploadReadback;
    try {
      view = await this.readBack(batch, signal);
    } catch (readbackError) {
      await this.recoverBatch(batch, owner, readbackError, summary);
      return null;
    }
    if (view.differs) {
      await this.recoverBatch(batch, owner, insertError, summary);
      return null;
    }
    if (view.missing.length === 0) return { batch, remote: view.records };

    let outcomes: PostgreSqlPassiveEventReleaseResult[];
    try {
      outcomes = await this.dependencies.remote.releaseFromOtherProjects(
        view.missing.map(remoteInput),
        { staleClaimMs: this.options.staleClaimMs, signal },
      );
    } catch (releaseError) {
      await this.reportError(releaseError);
      await this.recoverBatch(batch, owner, releaseError, summary);
      return null;
    }
    const asked = new Set(view.missing.map((event) => event.event_uuid));
    const answers = new Map<string, PostgreSqlPassiveEventReleaseResult>();
    const repeated = new Set<string>();
    for (const outcome of outcomes) {
      // Only keys that were asked about are acted on, and the first answer wins.
      if (!asked.has(outcome.eventId)) continue;
      if (answers.has(outcome.eventId)) repeated.add(outcome.eventId);
      else answers.set(outcome.eventId, outcome);
    }
    if (repeated.size > 0) {
      await this.reportError(new Error(
        `remote answered more than once for local rows: ${[...repeated].join(", ")}`,
      ));
    }
    const retry: LocalHookEventRow[] = [];
    const mismatched: string[] = [];
    for (const event of batch) {
      const eventId = event.event_uuid;
      if (view.byId.has(eventId)) {
        retry.push(event);
        continue;
      }
      const answer = answers.get(eventId);
      if (answer === undefined) {
        await this.recoverRow(event, owner, insertError, summary);
      } else if (answer.outcome === "absent" || answer.outcome === "released") {
        retry.push(event);
      } else if (answer.outcome === "applied") {
        if (await this.dependencies.local.markAcknowledged(eventId, answer.inboxId)) {
          summary.acknowledged += 1;
        }
      } else if (answer.outcome === "quarantined") {
        if (await this.dependencies.local.markQuarantined(
          eventId,
          answer.inboxId,
          answer.quarantineReason,
        )) {
          summary.quarantined += 1;
        }
      } else if (answer.outcome === "mismatch") {
        mismatched.push(eventId);
        if (event.delivery_attempts >= this.options.quarantineAfterAttempts) {
          if (await this.dependencies.local.markDeliveryQuarantined(
            eventId,
            owner,
            "remote copy in another project differs from the local row",
          )) {
            summary.quarantined += 1;
          }
        } else if (await this.retryLocal(
          event,
          owner,
          "remote copy in another project differs from the local row",
        )) {
          summary.retried += 1;
        }
      } else if (await this.retryLocal(
        event,
        owner,
        answer.outcome === "busy"
          ? "remote copy in another project is claimed by another process"
          : "remote copy appeared in the bound project",
      )) {
        // A live claim or a copy that raced into the bound project is left
        // for a later pass; neither is ever quarantined from here.
        summary.retried += 1;
      }
    }
    if (mismatched.length > 0) {
      await this.reportError(new Error(
        `local rows differ from their copy in another remote project: ${mismatched.join(", ")}`,
      ));
    }
    if (retry.length === 0) return null;

    // The one bounded extra insert; a failure here is not recovered again.
    try {
      return {
        batch: retry,
        remote: await this.dependencies.remote.insertEvents(retry.map(remoteInput), signal),
      };
    } catch (retryError) {
      let again: UploadReadback;
      try {
        again = await this.readBack(retry, signal);
      } catch (readbackError) {
        await this.recoverBatch(retry, owner, readbackError, summary);
        return null;
      }
      if (again.differs || again.missing.length > 0) {
        await this.recoverBatch(retry, owner, retryError, summary);
        return null;
      }
      return { batch: retry, remote: again.records };
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
    const unbound: LocalHookEventRow[] = [];
    for (const event of local) {
      const record = byId.get(event.event_uuid);
      if (!record) {
        // Not in the bound project: either it went to a project this
        // machine was bound to before a relink, or it is gone everywhere.
        // Only this machine's own rows are ever recovered (#1509).
        if (event.machine_id === this.dependencies.remote.machineId) unbound.push(event);
        continue;
      }
      if (!sameEnvelope(event, record)) continue;
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
    if (unbound.length > 0) await this.recoverUnbound(unbound, summary, signal);
  }

  /**
   * Rows that were replicated to a previous remote project (#1509). The
   * remote repository withdraws or settles this machine's copies in every
   * other project, and the outcome decides the local transition: a withdrawn
   * or missing copy is queued again for the current binding, an applied one
   * is acknowledged, and a quarantined one stays quarantined. A live claim
   * is left for a later pass. A failure only postpones the recovery, so it
   * never blocks the prune phase that follows.
   */
  private async recoverUnbound(
    rows: readonly LocalHookEventRow[],
    summary: { acknowledged: number; quarantined: number },
    signal?: AbortSignal,
  ): Promise<void> {
    let outcomes: PostgreSqlPassiveEventReleaseResult[];
    try {
      outcomes = await this.dependencies.remote.releaseFromOtherProjects(
        rows.map((event) => ({
          inboxId: BigInt(event.remote_inbox_id!),
          machineId: event.machine_id!,
          eventId: event.event_uuid,
          eventVersion: event.event_version,
          machineSequence: BigInt(event.machine_sequence),
          eventType: event.type,
          payload: eventPayload(event),
        })),
        { staleClaimMs: this.options.staleClaimMs, signal },
      );
    } catch (error) {
      await this.reportError(error);
      return;
    }
    const requested = new Map(rows.map((event) => [event.event_uuid, event]));
    const mismatched: string[] = [];
    for (const outcome of outcomes) {
      // Only keys that were asked about are ever acted on.
      const event = requested.get(outcome.eventId);
      if (event === undefined) continue;
      if (outcome.outcome === "absent" || outcome.outcome === "released") {
        await this.dependencies.local.requeueReplicated(
          event.event_uuid,
          BigInt(event.remote_inbox_id!),
        );
      } else if (outcome.outcome === "applied") {
        if (await this.dependencies.local.markAcknowledged(
          event.event_uuid,
          outcome.inboxId,
        )) {
          summary.acknowledged += 1;
        }
      } else if (outcome.outcome === "quarantined") {
        if (await this.dependencies.local.markQuarantined(
          event.event_uuid,
          outcome.inboxId,
          outcome.quarantineReason,
        )) {
          summary.quarantined += 1;
        }
      } else if (outcome.outcome === "mismatch") {
        mismatched.push(event.event_uuid);
      }
    }
    if (mismatched.length > 0) {
      await this.reportError(new Error(
        `replicated rows differ from their copy in another remote project: ${mismatched.join(", ")}`,
      ));
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
