import type { DaemonConfig } from "./config.js";
import { sendJson, type RouteHandler } from "./server.js";
import { validateCwd } from "./validate-cwd.js";
import { safeLogError } from "../hooks/hook-errors.js";
import { EVENTS_UNPROCESSED_BATCH_LIMIT } from "../hooks/events-db.js";
import { collectEventSidecars } from "../db/event-sidecars.js";
import { promoteEventsForCwd, type PromoteResult } from "./routes/promote-events.js";
import type { StorageBackendFactory } from "../storage/index.js";

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

interface PassiveEventProcessorDeps {
  promoteEventsForCwd?: typeof promoteEventsForCwd;
  storageFactory?: StorageBackendFactory;
  collectEventSidecars?: typeof collectEventSidecars;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  safeLogError?: typeof safeLogError;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

export class PassiveEventProcessor {
  private readonly promoteOneBatch: typeof promoteEventsForCwd;
  private readonly scanSidecars: typeof collectEventSidecars;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly setRepeating: typeof setInterval;
  private readonly clearRepeating: typeof clearInterval;
  private readonly logError: typeof safeLogError;
  private readonly debounceTimers = new Map<string, TimeoutHandle>();
  private readonly debounceDeadlines = new Map<string, number>();
  private readonly queuedProjects = new Set<string>();
  private draining = false;
  private stopped = false;
  private sweepTimer: TimeoutHandle | null = null;
  private sweepInterval: IntervalHandle | null = null;
  private sweepStartIndex = 0;
  private readonly drainWaiters = new Set<() => void>();

  constructor(
    private readonly config: DaemonConfig,
    private readonly defaults = PASSIVE_EVENT_PROCESSOR_DEFAULTS,
    deps: PassiveEventProcessorDeps = {},
  ) {
    const promoteOneBatch = deps.promoteEventsForCwd ?? promoteEventsForCwd;
    this.promoteOneBatch = deps.storageFactory
      ? (config, cwd, sidecarPath) =>
          promoteOneBatch(config, cwd, sidecarPath, deps.storageFactory)
      : promoteOneBatch;
    this.scanSidecars = deps.collectEventSidecars ?? collectEventSidecars;
    this.setTimer = deps.setTimeout ?? setTimeout;
    this.clearTimer = deps.clearTimeout ?? clearTimeout;
    this.setRepeating = deps.setInterval ?? setInterval;
    this.clearRepeating = deps.clearInterval ?? clearInterval;
    this.logError = deps.safeLogError ?? safeLogError;
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

  async stopAndWait(): Promise<void> {
    this.stop();
    if (!this.draining) return;
    await new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }

  notify(input: PassiveEventNotification): void {
    if (this.stopped) return;
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

  async runSweep(): Promise<void> {
    if (this.stopped) return;
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
          await this.promoteOneBatch(this.config, sidecar.cwd, sidecar.path);
        } catch (error) {
          await this.logError("passive-event-processor", error, { cwd: sidecar.cwd });
        }
      }
    } finally {
      this.finishDrain();
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
        result = await this.promoteOneBatch(this.config, cwd);
      } catch (error) {
        await this.logError("passive-event-processor", error, { cwd });
        return;
      }
      if (result.message === "no unprocessed events") return;
      const processed = result.promoted + result.skipped;
      if (processed === 0) return;
      remaining = processed >= EVENTS_UNPROCESSED_BATCH_LIMIT || result.errors > 0;
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
