import type { DaemonConfig } from "./config.js";
import { sendJson, type RouteExecutionContext, type RouteHandler } from "./server.js";
import { validateCwd } from "./validate-cwd.js";
import { safeLogError } from "../hooks/hook-errors.js";
import { EVENTS_UNPROCESSED_BATCH_LIMIT } from "../hooks/events-db.js";
import { collectEventSidecars } from "../db/event-sidecars.js";
import { promoteEventsForCwd, type PromoteResult } from "./routes/promote-events.js";
import type { StorageBackendFactory } from "../storage/index.js";
import type { PassiveEventReplicationResult } from "./passive-event-replication.js";
import {
  BackendPublicationJournalError,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";

export const PASSIVE_EVENT_PROCESSOR_DEFAULTS = {
  priorityDelayMs: 250,
  debounceMs: 3000,
  activeProjectThreshold: 10,
  sweepIntervalMs: 5 * 60 * 1000,
  sweepMaxSidecars: 20,
  sweepScanTimeoutMs: 5000,
  backgroundBatchLimit: 1,
} as const;

export interface PassiveEventNotification {
  cwd: string;
  priority?: number;
  pendingCount?: number;
  sourceHook?: string;
}

/**
 * A running daemon's startup backend is frozen for its whole lifetime, so a
 * configured-backend change can never be admitted by the current process. The
 * background sweep records that halt instead of retrying every five minutes
 * with nothing but a log line to show for it (#1384).
 */
export interface PassiveEventBackgroundDiagnostics {
  readonly halted: boolean;
  readonly haltedReason: "backend-mismatch" | null;
  readonly haltedMessage: string | null;
  readonly replication: PassiveEventReplicationDiagnostics;
}

/**
 * Operator-visible proof that replication is running (#1383). The worker
 * previously had no caller and nothing reported its absence, so "never ran"
 * has to be as legible from outside as "ran at T and moved N events".
 */
export interface PassiveEventReplicationDiagnostics {
  readonly enabled: boolean;
  readonly lastPassAt: string | null;
  readonly passes: number;
  readonly projects: number;
  readonly uploaded: number;
  readonly applied: number;
  readonly acknowledged: number;
  readonly pruned: number;
  readonly retried: number;
  readonly quarantined: number;
}

export type PassiveEventReplicationPassRunner = (
  cwd: string,
  signal?: AbortSignal,
) => Promise<PassiveEventReplicationResult | null>;

export interface PassiveEventProcessorDeps {
  promoteEventsForCwd?: typeof promoteEventsForCwd;
  storageFactory?: StorageBackendFactory;
  withPublicationAdmission: BackgroundPublicationAdmission;
  collectEventSidecars?: typeof collectEventSidecars;
  replicatePassiveEvents?: PassiveEventReplicationPassRunner;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  safeLogError?: typeof safeLogError;
  signal?: AbortSignal;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

export type BackgroundPublicationAdmission = <T>(
  operation: (publicationLockToken: BackendPublicationLockToken) => Promise<T> | T,
) => Promise<T>;

type PromoteOneBatch = (
  config: DaemonConfig,
  cwd: string,
  sidecarPath: string | undefined,
  publicationLockToken?: BackendPublicationLockToken,
  context?: Pick<RouteExecutionContext, "publicationLockToken" | "withPublicationAdmission" | "signal">,
) => Promise<PromoteResult>;

export class PassiveEventProcessor {
  private readonly promoteOneBatch: PromoteOneBatch;
  private readonly withPublicationAdmission: BackgroundPublicationAdmission;
  private readonly scanSidecars: typeof collectEventSidecars;
  private readonly replicatePassiveEvents?: PassiveEventReplicationPassRunner;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly setRepeating: typeof setInterval;
  private readonly clearRepeating: typeof clearInterval;
  private readonly logError: typeof safeLogError;
  private readonly stopController = new AbortController();
  private readonly backgroundSignal: AbortSignal;
  private readonly detachExternalSignal?: () => void;
  private readonly debounceTimers = new Map<string, TimeoutHandle>();
  private readonly debounceDeadlines = new Map<string, number>();
  private readonly queuedProjects = new Set<string>();
  private draining = false;
  private stopped = false;
  private sweepTimer: TimeoutHandle | null = null;
  private sweepInterval: IntervalHandle | null = null;
  private sweepStartIndex = 0;
  private haltedReason: "backend-mismatch" | null = null;
  private haltedMessage: string | null = null;
  private readonly replication = {
    lastPassAt: null as string | null,
    passes: 0,
    projects: 0,
    uploaded: 0,
    applied: 0,
    acknowledged: 0,
    pruned: 0,
    retried: 0,
    quarantined: 0,
  };
  private readonly drainWaiters = new Set<() => void>();

  constructor(
    private readonly config: DaemonConfig,
    private readonly defaults = PASSIVE_EVENT_PROCESSOR_DEFAULTS,
    deps: PassiveEventProcessorDeps,
  ) {
    const promoteOneBatch = deps.promoteEventsForCwd ?? promoteEventsForCwd;
    this.promoteOneBatch = (config, cwd, sidecarPath, publicationLockToken, context) =>
      promoteOneBatch(config, cwd, sidecarPath, deps.storageFactory, publicationLockToken, context);
    this.withPublicationAdmission = deps.withPublicationAdmission;
    this.scanSidecars = deps.collectEventSidecars ?? collectEventSidecars;
    // A daemon whose selected backend cannot replicate must not report
    // replication as enabled, and must not record five-minute passes it never
    // made (#1383). The startup backend is frozen for this process, so this
    // decision is settled once here rather than re-asked every sweep.
    this.replicatePassiveEvents = config.storage.backend === "postgresql"
      ? deps.replicatePassiveEvents
      : undefined;
    this.setTimer = deps.setTimeout ?? setTimeout;
    this.clearTimer = deps.clearTimeout ?? clearTimeout;
    this.setRepeating = deps.setInterval ?? setInterval;
    this.clearRepeating = deps.clearInterval ?? clearInterval;
    this.logError = deps.safeLogError ?? safeLogError;
    this.backgroundSignal = this.stopController.signal;
    if (deps.signal !== undefined) {
      const abortBackground = (): void => {
        this.stopController.abort(deps.signal?.reason);
      };
      if (deps.signal.aborted) abortBackground();
      else {
        deps.signal.addEventListener("abort", abortBackground, { once: true });
        this.detachExternalSignal = () => deps.signal?.removeEventListener("abort", abortBackground);
      }
    }
  }

  start(): void {
    if (this.stopped) return;
    this.scheduleSweep(0);
    this.sweepInterval = this.setRepeating(() => {
      void this.runSweep().catch(async error => {
        await this.logError("passive-event-processor", error, {});
      });
    }, this.defaults.sweepIntervalMs);
    this.unref(this.sweepInterval);
  }

  stop(): void {
    this.stopped = true;
    this.stopController.abort();
    this.detachExternalSignal?.();
    this.clearScheduledWork();
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    if (!this.draining) return;
    await new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }

  notify(input: PassiveEventNotification): void {
    if (this.stopped || this.haltedReason !== null) return;
    const cwd = validateCwd(input.cwd);
    const priority = normalizePriority(input.priority);
    const pendingCount = normalizePendingCount(input.pendingCount);
    const delay = priority === 1 || pendingCount >= this.defaults.activeProjectThreshold
      ? this.defaults.priorityDelayMs
      : this.defaults.debounceMs;

    this.queuedProjects.add(cwd);
    this.scheduleProject(cwd, delay);
  }

  async flushOnce(): Promise<void> {
    await this.drainQueuedProjects();
  }

  /** Background halt state for operator-facing daemon status (#1384). */
  backgroundDiagnostics(): PassiveEventBackgroundDiagnostics {
    return {
      halted: this.haltedReason !== null,
      haltedReason: this.haltedReason,
      haltedMessage: this.haltedMessage,
      replication: {
        enabled: this.replicatePassiveEvents !== undefined,
        ...this.replication,
      },
    };
  }

  async runSweep(): Promise<void> {
    if (this.stopped) return;
    if (this.haltedReason !== null) return;
    if (this.draining) {
      this.scheduleSweep(this.defaults.debounceMs);
      return;
    }
    this.draining = true;
    try {
      const sidecars = await this.scanSidecars({
        timeoutMs: this.defaults.sweepScanTimeoutMs,
        maxDbs: this.defaults.sweepMaxSidecars,
        startIndex: this.sweepStartIndex,
      });
      const attempted = sidecars.filter(sidecar => !sidecar.scanSkipped).length;
      this.sweepStartIndex += Math.max(1, attempted);

      for (const sidecar of sidecars) {
        if (this.stopped) return;
        if (sidecar.scanError || sidecar.scanSkipped || sidecar.unprocessed === 0 || !sidecar.cwd) {
          continue;
        }
        try {
          await this.promoteOneBatch(
            this.config,
            sidecar.cwd!,
            sidecar.path,
            undefined,
            {
              withPublicationAdmission: this.withPublicationAdmission,
              signal: this.backgroundSignal,
            },
          );
        } catch (error) {
          if (isFrozenBackendMismatch(error)) {
            await this.haltForBackendMismatch(error);
            return;
          }
          await this.logError("passive-event-processor", error, { cwd: sidecar.cwd });
        }
      }
      await this.replicateSidecars(sidecars);
    } finally {
      this.finishDrain();
    }
  }

  /**
   * Drain each project's local outbox to the remote inbox (#1383).
   *
   * This runs after promotion and independently of it: an event can be
   * promoted locally yet still be undelivered, and only this pass can advance
   * a row to the acknowledged-and-remote-pruned state that local retention
   * requires. Projects without a PostgreSQL binding skip quietly.
   *
   * Each project is admitted before it replicates. Replication resolves its
   * backend from this daemon's frozen startup configuration, and the promotion
   * loop above skips any sidecar with no unprocessed events, so without this
   * admission a settled daemon would keep uploading to a backend that
   * publication has already moved away from (#1384).
   */
  private async replicateSidecars(
    sidecars: readonly Awaited<ReturnType<typeof collectEventSidecars>>[number][],
  ): Promise<void> {
    const replicate = this.replicatePassiveEvents;
    if (replicate === undefined) return;
    this.replication.passes += 1;
    this.replication.lastPassAt = new Date().toISOString();
    for (const sidecar of sidecars) {
      if (this.stopped || this.haltedReason !== null) return;
      if (sidecar.scanError || sidecar.scanSkipped || !sidecar.cwd) continue;
      let result: PassiveEventReplicationResult | null;
      try {
        await this.withPublicationAdmission(() => undefined);
        result = await replicate(sidecar.cwd, this.backgroundSignal);
      } catch (error) {
        if (isFrozenBackendMismatch(error)) {
          await this.haltForBackendMismatch(error);
          return;
        }
        await this.logError("passive-event-processor", error, { cwd: sidecar.cwd });
        continue;
      }
      if (result === null) continue;
      this.replication.projects += 1;
      this.replication.uploaded += result.uploaded;
      this.replication.applied += result.applied;
      this.replication.acknowledged += result.acknowledged;
      this.replication.pruned += result.pruned;
      this.replication.retried += result.retried;
      this.replication.quarantined += result.quarantined;
    }
  }

  private scheduleProject(cwd: string, delayMs: number): void {
    const deadline = Date.now() + delayMs;
    const existingDeadline = this.debounceDeadlines.get(cwd);
    if (existingDeadline !== undefined && existingDeadline <= deadline) return;

    const existing = this.debounceTimers.get(cwd);
    if (existing) this.clearTimer(existing);
    const timer = this.setTimer(() => {
      this.debounceTimers.delete(cwd);
      this.debounceDeadlines.delete(cwd);
      void this.drainQueuedProjects().catch(async error => {
        await this.logError("passive-event-processor", error, { cwd });
      });
    }, delayMs);
    this.unref(timer);
    this.debounceTimers.set(cwd, timer);
    this.debounceDeadlines.set(cwd, deadline);
  }

  private scheduleSweep(delayMs: number): void {
    if (this.sweepTimer) this.clearTimer(this.sweepTimer);
    this.sweepTimer = this.setTimer(() => {
      this.sweepTimer = null;
      void this.runSweep().catch(async error => {
        await this.logError("passive-event-processor", error, {});
      });
    }, delayMs);
    this.unref(this.sweepTimer);
  }

  private async drainQueuedProjects(): Promise<void> {
    if (this.stopped) return;
    if (this.draining) {
      for (const cwd of this.queuedProjects) {
        this.scheduleProject(cwd, this.defaults.debounceMs);
      }
      return;
    }
    this.draining = true;
    try {
      const projects = [...this.queuedProjects];
      this.queuedProjects.clear();
      for (const cwd of projects) {
        if (this.haltedReason !== null) break;
        await this.processProject(cwd);
      }
    } finally {
      this.finishDrain();
    }
  }

  private async processProject(cwd: string): Promise<void> {
    let remaining = false;
    for (let batch = 0; batch < this.defaults.backgroundBatchLimit; batch++) {
      let result: PromoteResult;
      try {
        result = await this.promoteOneBatch(
          this.config,
          cwd,
          undefined,
          undefined,
          {
            withPublicationAdmission: this.withPublicationAdmission,
            signal: this.backgroundSignal,
          },
        );
      } catch (error) {
        if (isFrozenBackendMismatch(error)) {
          await this.haltForBackendMismatch(error);
          return;
        }
        await this.logError("passive-event-processor", error, { cwd });
        return;
      }
      if (result.terminal) return;
      if (result.message === "no unprocessed events") return;
      const processed = result.promoted + result.skipped;
      remaining = processed >= EVENTS_UNPROCESSED_BATCH_LIMIT || result.errors > 0;
      if (processed === 0 && !remaining) return;
      if (!remaining) return;
    }
    if (remaining && !this.stopped) {
      this.queuedProjects.add(cwd);
    }
  }

  private finishDrain(): void {
    this.draining = false;
    if (!this.stopped && this.queuedProjects.size > 0) {
      for (const cwd of this.queuedProjects) {
        this.scheduleProject(cwd, this.defaults.debounceMs);
      }
    }
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private unref(handle: { unref?: () => unknown } | null): void {
    try { handle?.unref?.(); } catch { /* non-fatal */ }
  }

  /**
   * Retire every scheduled background timer. Shared by ordinary shutdown and by
   * the #1384 frozen-backend halt, which must stop rescheduling work that this
   * process can never get admitted again.
   */
  private clearScheduledWork(): void {
    for (const timer of this.debounceTimers.values()) {
      this.clearTimer(timer);
    }
    this.debounceTimers.clear();
    this.debounceDeadlines.clear();
    this.queuedProjects.clear();
    if (this.sweepTimer) {
      this.clearTimer(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.sweepInterval) {
      this.clearRepeating(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  /**
   * The configured backend no longer matches this daemon's authenticated
   * startup backend. Only a restart resolves it, so record the halt, drop every
   * scheduled sweep, and report once instead of logging the identical refusal
   * every five minutes. The next hook's `ensureDaemon` observes the `/health`
   * backend mismatch and replaces this daemon.
   */
  private async haltForBackendMismatch(
    error: BackendPublicationJournalError,
  ): Promise<void> {
    this.haltedReason = "backend-mismatch";
    this.haltedMessage = error.message;
    this.clearScheduledWork();
    await this.logError("passive-event-processor", error, {});
  }
}

function isFrozenBackendMismatch(
  error: unknown,
): error is BackendPublicationJournalError {
  return error instanceof BackendPublicationJournalError
    && error.reason === "backend-mismatch";
}

function normalizePriority(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 1 && value <= 3 ? value : undefined;
}

function normalizePendingCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

export function createPromoteEventsNotifyHandler(processor: PassiveEventProcessor): RouteHandler {
  return async (_req, res, body) => {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(body || "{}") as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      sendJson(res, 400, { error: "invalid request body" });
      return;
    }
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (cwd.length === 0) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }
    try {
      processor.notify({
        cwd,
        priority: typeof input.priority === "number" ? input.priority : undefined,
        pendingCount: typeof input.pendingCount === "number" ? input.pendingCount : undefined,
        sourceHook: typeof input.sourceHook === "string" ? input.sourceHook : undefined,
      });
      sendJson(res, 200, { queued: true });
    } catch (error) {
      await safeLogError("promote-events-notify", error, { cwd });
      sendJson(res, 400, { error: "cwd is invalid" });
    }
  };
}
