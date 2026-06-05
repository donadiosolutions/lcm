import type { DaemonConfig } from "./config.js";
import { sendJson, type RouteHandler } from "./server.js";
import { validateCwd } from "./validate-cwd.js";
import { safeLogError } from "../hooks/hook-errors.js";
import { EventsDb } from "../hooks/events-db.js";
import { eventsDbPath } from "../db/events-path.js";
import { collectEventSidecars } from "../db/event-sidecars.js";
import { drainEventsForCwd, promoteEventsForCwd, type PromoteResult } from "./routes/promote-events.js";

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
  drainEventsForCwd?: typeof drainEventsForCwd;
  collectEventSidecars?: typeof collectEventSidecars;
  getPendingCount?: (cwd: string) => number;
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
  private readonly drainProject: typeof drainEventsForCwd;
  private readonly scanSidecars: typeof collectEventSidecars;
  private readonly readPendingCount: (cwd: string) => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly setRepeating: typeof setInterval;
  private readonly clearRepeating: typeof clearInterval;
  private readonly logError: typeof safeLogError;
  private readonly debounceTimers = new Map<string, TimeoutHandle>();
  private readonly queuedProjects = new Set<string>();
  private draining = false;
  private stopped = false;
  private sweepTimer: TimeoutHandle | null = null;
  private sweepInterval: IntervalHandle | null = null;

  constructor(
    private readonly config: DaemonConfig,
    private readonly defaults = PASSIVE_EVENT_PROCESSOR_DEFAULTS,
    deps: PassiveEventProcessorDeps = {},
  ) {
    this.promoteOneBatch = deps.promoteEventsForCwd ?? promoteEventsForCwd;
    this.drainProject = deps.drainEventsForCwd ?? drainEventsForCwd;
    this.scanSidecars = deps.collectEventSidecars ?? collectEventSidecars;
    this.readPendingCount = deps.getPendingCount ?? getPendingCount;
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
      void this.runSweep().catch(error => this.logError("passive-event-processor", error, {}));
    }, this.defaults.sweepIntervalMs);
    this.unref(this.sweepInterval);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.debounceTimers.values()) {
      this.clearTimer(timer);
    }
    this.debounceTimers.clear();
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

  notify(input: PassiveEventNotification): void {
    if (this.stopped) return;
    const cwd = validateCwd(input.cwd);
    const priority = normalizePriority(input.priority);
    const pendingCount = input.pendingCount ?? this.safePendingCount(cwd);
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
    const sidecars = this.scanSidecars({
      timeoutMs: this.defaults.sweepScanTimeoutMs,
      maxDbs: this.defaults.sweepMaxSidecars,
    });

    for (const sidecar of sidecars) {
      if (this.stopped) return;
      if (sidecar.scanError || sidecar.scanSkipped || sidecar.unprocessed === 0 || !sidecar.cwd) {
        continue;
      }
      try {
        await this.drainProject(this.config, sidecar.cwd, sidecar.path);
      } catch (error) {
        this.logError("passive-event-processor", error, { cwd: sidecar.cwd });
      }
    }
  }

  private scheduleProject(cwd: string, delayMs: number): void {
    const existing = this.debounceTimers.get(cwd);
    if (existing) this.clearTimer(existing);
    const timer = this.setTimer(() => {
      this.debounceTimers.delete(cwd);
      void this.drainQueuedProjects().catch(error => this.logError("passive-event-processor", error, { cwd }));
    }, delayMs);
    this.unref(timer);
    this.debounceTimers.set(cwd, timer);
  }

  private scheduleSweep(delayMs: number): void {
    if (this.sweepTimer) this.clearTimer(this.sweepTimer);
    this.sweepTimer = this.setTimer(() => {
      this.sweepTimer = null;
      void this.runSweep().catch(error => this.logError("passive-event-processor", error, {}));
    }, delayMs);
    this.unref(this.sweepTimer);
  }

  private async drainQueuedProjects(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      const projects = [...this.queuedProjects];
      this.queuedProjects.clear();
      for (const cwd of projects) {
        await this.processProject(cwd);
      }
    } finally {
      this.draining = false;
      if (!this.stopped && this.queuedProjects.size > 0) {
        for (const cwd of this.queuedProjects) {
          this.scheduleProject(cwd, this.defaults.debounceMs);
        }
      }
    }
  }

  private async processProject(cwd: string): Promise<void> {
    let remaining = false;
    for (let batch = 0; batch < this.defaults.backgroundBatchLimit; batch++) {
      let result: PromoteResult;
      try {
        result = await this.promoteOneBatch(this.config, cwd);
      } catch (error) {
        this.logError("passive-event-processor", error, { cwd });
        return;
      }
      if (result.message === "no unprocessed events") return;
      const processed = result.promoted + result.skipped;
      if (processed === 0) return;
      remaining = this.safePendingCount(cwd) > 0;
      if (!remaining) return;
    }
    if (remaining && !this.stopped) {
      this.queuedProjects.add(cwd);
    }
  }

  private safePendingCount(cwd: string): number {
    try {
      return this.readPendingCount(cwd);
    } catch (error) {
      this.logError("passive-event-processor", error, { cwd });
      return 0;
    }
  }

  private unref(handle: { unref?: () => unknown } | null): void {
    try { handle?.unref?.(); } catch { /* non-fatal */ }
  }
}

function normalizePriority(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 1 && value <= 3 ? value : undefined;
}

function getPendingCount(cwd: string): number {
  const db = new EventsDb(eventsDbPath(cwd));
  try {
    return db.getHealthStats().unprocessed;
  } finally {
    db.close();
  }
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
    if (typeof input.cwd !== "string" || input.cwd.trim().length === 0) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }
    try {
      processor.notify({
        cwd: input.cwd,
        priority: typeof input.priority === "number" ? input.priority : undefined,
        pendingCount: typeof input.pendingCount === "number" ? input.pendingCount : undefined,
        sourceHook: typeof input.sourceHook === "string" ? input.sourceHook : undefined,
      });
      sendJson(res, 200, { queued: true });
    } catch (error) {
      safeLogError("promote-events-notify", error, {});
      sendJson(res, 400, { error: "cwd is invalid" });
    }
  };
}
