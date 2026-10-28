import { describe, expect, it, onTestFinished, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import type { EventSidecarSummary, collectEventSidecars } from "../../src/db/event-sidecars.js";
import {
  createPromoteEventsNotifyHandler,
  PassiveEventProcessor,
  PASSIVE_EVENT_PROCESSOR_DEFAULTS,
  type BackgroundPublicationAdmission,
} from "../../src/daemon/passive-event-processor.js";
import type { PromoteResult, promoteEventsForCwd } from "../../src/daemon/routes/promote-events.js";
import {
  assertBackendPublicationConsumerAccess,
  BackendPublicationJournalError,
  withBackendPublicationConfigLockAsync,
  withBackendPublicationConsumerLock,
  withBackendPublicationConsumerLockAsync,
} from "../../src/storage/backend-publication.js";

type CollectEventSidecars = typeof collectEventSidecars;
type PromoteEventsForCwd = typeof promoteEventsForCwd;
type PassiveEventProcessorDeps = NonNullable<ConstructorParameters<typeof PassiveEventProcessor>[2]>;
type PublicationAdmission = <T>(operation: (publicationLockToken: object) => Promise<T> | T) => Promise<T>;
type ScheduledTimer = {
  callback: () => void;
  ms: number;
  unref: ReturnType<typeof vi.fn>;
};

const request = {} as IncomingMessage;
const testPublicationAdmission: BackgroundPublicationAdmission = async operation => operation({});

function makeConfig() {
  return loadDaemonConfig("/nonexistent", { daemon: { port: 0 }, llm: { provider: "disabled" } });
}

/** A daemon whose selected backend can actually replicate passive events. */
function makeReplicatingConfig() {
  return {
    ...makeConfig(),
    storage: {
      backend: "postgresql",
      postgresql: { url: "postgresql://example.test/lcm" },
    },
  } as unknown as ReturnType<typeof makeConfig>;
}

function replicationSummary() {
  return {
    leaseAcquired: true,
    uploaded: 1,
    applied: 1,
    retried: 0,
    quarantined: 0,
    acknowledged: 1,
    pruned: 1,
    backlog: false,
  };
}

function publicationFixture(): { home: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), "lcm-passive-publication-"));
  const lcmDir = join(home, ".lcm");
  mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
  const configPath = join(lcmDir, "config.json");
  writeFileSync(configPath, "{}\n", { mode: 0o600 });
  return { home, configPath };
}

/** A publication home for one test, removed when that test finishes. */
function replicationHome(): string {
  const { home } = publicationFixture();
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }); });
  return home;
}

/**
 * Background admission as the daemon really grants it. The publication
 * consumer lock is held for the whole admitted operation, so the callback
 * receives a live token that its nested local-outbox work can inherit. A
 * synthetic token cannot stand in here: the append barrier rejects one that
 * no lock owns, which is the property replication depends on.
 */
function realPublicationAdmission(home: string): PublicationAdmission {
  return async operation =>
    withBackendPublicationConsumerLockAsync(home, token => operation(token));
}

function mockRes() {
  let body = "";
  const res = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn((data?: string) => { body = data ?? ""; }),
  } as unknown as ServerResponse;
  return { res, getBody: () => JSON.parse(body || "{}") };
}

function timerDeps(): {
  timers: ScheduledTimer[];
  intervals: ScheduledTimer[];
  deps: PassiveEventProcessorDeps;
} {
  const timers: ScheduledTimer[] = [];
  const intervals: ScheduledTimer[] = [];
  const clearTimeout: typeof globalThis.clearTimeout = vi.fn();
  const clearInterval: typeof globalThis.clearInterval = vi.fn();
  const setTimeout: typeof globalThis.setTimeout = (callback, ms = 0, ...args) => {
    const handle: ScheduledTimer = {
      callback: () => {
        if (typeof callback === "function") callback(...args);
      },
      ms: Number(ms),
      unref: vi.fn(),
    };
    timers.push(handle);
    // Node's Timeout is opaque; this deterministic scheduler needs only `unref`.
    return handle as unknown as ReturnType<typeof globalThis.setTimeout>;
  };
  const setInterval: typeof globalThis.setInterval = (callback, ms = 0, ...args) => {
    const handle: ScheduledTimer = {
      callback: () => {
        if (typeof callback === "function") callback(...args);
      },
      ms: Number(ms),
      unref: vi.fn(),
    };
    intervals.push(handle);
    // Node's Interval is opaque; this deterministic scheduler needs only `unref`.
    return handle as unknown as ReturnType<typeof globalThis.setInterval>;
  };
  return {
    timers,
    intervals,
    deps: {
      withPublicationAdmission: testPublicationAdmission,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      safeLogError: vi.fn(),
    },
  };
}

function sidecar(overrides: Partial<EventSidecarSummary> = {}): EventSidecarSummary {
  return {
    file: "project.db",
    projectId: "project",
    path: "/events/project.db",
    cwd: "/tmp",
    metadataMissing: false,
    captured: 1,
    unprocessed: 1,
    errors: 0,
    lastCapture: null,
    deliveryPending: 0,
    deliveryClaimed: 0,
    deliveryRetry: 0,
    deliveryReplicated: 0,
    deliveryAcknowledged: 0,
    deliveryAwaitingRemotePrune: 0,
    deliveryQuarantined: 0,
    oldestDeliveryAt: null,
    ...overrides,
  };
}

/**
 * Run a background timer and return every unhandled rejection it leaked. The
 * listener is installed before the timer fires and one macrotask is awaited so
 * the rejection has surfaced.
 */
async function leakedRejections(fireTimer: () => void | Promise<void>): Promise<unknown[]> {
  const leaked: unknown[] = [];
  const record = (reason: unknown): void => { leaked.push(reason); };
  process.on("unhandledRejection", record);
  try {
    await fireTimer();
    await new Promise<void>(resolve => { setImmediate(resolve); });
  } finally {
    process.off("unhandledRejection", record);
  }
  return leaked;
}

describe("PassiveEventProcessor", () => {
  it("schedules priority and threshold notifications with near-immediate delay", () => {
    const { timers, deps } = timerDeps();
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd: vi.fn(),
    });

    processor.notify({ cwd: "/tmp", priority: 1, pendingCount: 1 });
    processor.notify({ cwd: "/tmp", priority: 3, pendingCount: 10 });

    expect(timers.map(timer => timer.ms)).toEqual([250]);
    expect(timers.every(timer => timer.unref.mock.calls.length === 1)).toBe(true);
  });

  it("schedules threshold notifications with near-immediate delay", () => {
    const { timers, deps } = timerDeps();
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd: vi.fn(),
    });

    processor.notify({ cwd: "/tmp", priority: 3, pendingCount: 10 });

    expect(timers.map(timer => timer.ms)).toEqual([250]);
  });

  it("debounces normal notifications", () => {
    const { timers, deps } = timerDeps();
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd: vi.fn(),
    });

    processor.notify({ cwd: "/tmp", priority: 3, pendingCount: 1 });

    expect(timers[0].ms).toBe(3000);
  });

  it("does not delay an earlier priority timer after a later normal notification", () => {
    const { timers, deps } = timerDeps();
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd: vi.fn(),
    });

    processor.notify({ cwd: "/tmp", priority: 1 });
    processor.notify({ cwd: "/tmp", priority: 3 });

    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(250);
    expect(deps.clearTimeout).not.toHaveBeenCalled();
  });

  it("runs startup and periodic sweeps with configured scan budget", async () => {
    const { timers, intervals, deps } = timerDeps();
    let resolveDrained: (() => void) | undefined;
    const drained = new Promise<void>(resolve => { resolveDrained = resolve; });
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockImplementation(async () => {
      resolveDrained?.();
      return { promoted: 1, skipped: 0, correlated: 0, errors: 0 };
    });
    const collectEventSidecars = vi.fn<CollectEventSidecars>().mockResolvedValue([
      sidecar({ cwd: "/tmp", path: "/events/tmp.db", unprocessed: 1 }),
      sidecar({ cwd: "/tmp", path: "/events/tmp.db", unprocessed: 0 }),
      sidecar({ cwd: undefined, path: "/events/orphan.db", unprocessed: 1 }),
    ]);
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      collectEventSidecars,
      promoteEventsForCwd,
    });

    processor.start();
    expect(timers[0].ms).toBe(0);
    expect(intervals[0].ms).toBe(5 * 60 * 1000);

    timers[0].callback();
    await drained;

    expect(collectEventSidecars).toHaveBeenCalledWith({ timeoutMs: 5000, maxDbs: 20, startIndex: 0 });
    expect(promoteEventsForCwd).toHaveBeenCalledTimes(1);
    expect(promoteEventsForCwd.mock.calls[0][1]).toBe("/tmp");
    expect(promoteEventsForCwd.mock.calls[0][2]).toBe("/events/tmp.db");
  });

  it("rechecks a durably parked sidecar without logging or reprocessing it", async () => {
    const { deps } = timerDeps();
    const promote = vi.fn<PromoteEventsForCwd>().mockResolvedValue({
      promoted: 0,
      skipped: 0,
      correlated: 0,
      errors: 0,
      terminal: { kind: "parked", reason: "unavailable-cwd" },
      message: "parked local promotion for unavailable cwd; preserved unprocessed events",
    });
    const collect = vi.fn<CollectEventSidecars>().mockImplementation(async () => [sidecar({
      cwd: "/deleted-project",
      path: "/events/deleted.db",
      unprocessed: 1,
    })]);
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      collectEventSidecars: collect,
      promoteEventsForCwd: promote,
    });

    await processor.runSweep();
    await processor.runSweep();

    expect(promote).toHaveBeenCalledTimes(2);
    expect(deps.safeLogError).not.toHaveBeenCalled();
  });

  it("retries a cwd awaiting absence confirmation without growing the error ledger", async () => {
    const { deps } = timerDeps();
    const deferred: PromoteResult = {
      promoted: 0,
      skipped: 0,
      correlated: 0,
      errors: 0,
      deferred: {
        kind: "awaiting-confirmation",
        reason: "unavailable-cwd",
        observations: 1,
        retryAfterMs: 5 * 60 * 1000,
      },
      message: "cwd is unavailable; awaiting confirmation (1/3)",
    };
    const promote = vi.fn<PromoteEventsForCwd>().mockResolvedValue(deferred);
    const collect = vi.fn<CollectEventSidecars>().mockResolvedValue([sidecar({
      cwd: "/temporarily-unavailable-project",
      path: "/events/temporary.db",
      unprocessed: 1,
    })]);
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      collectEventSidecars: collect,
      promoteEventsForCwd: promote,
    });

    await processor.runSweep();
    await processor.runSweep();

    expect(promote).toHaveBeenCalledTimes(2);
    expect(deps.safeLogError).not.toHaveBeenCalled();
  });

  it("does not requeue a terminal parked result at the batch boundary", async () => {
    const { deps } = timerDeps();
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockResolvedValue({
      promoted: 0,
      skipped: 0,
      correlated: 0,
      errors: 0,
      terminal: { kind: "parked", reason: "unavailable-cwd" },
    });
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd,
    });

    processor.notify({ cwd: "/tmp", priority: 1 });
    await processor.flushOnce();
    await processor.flushOnce();

    expect(promoteEventsForCwd).toHaveBeenCalledTimes(1);
  });

  it("prevents concurrent active drains and requeues remaining work after the batch limit", async () => {
    const { deps } = timerDeps();
    let resolvePromotion: ((value: PromoteResult) => void) | undefined;
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>()
      .mockImplementationOnce(() => new Promise<PromoteResult>(resolve => {
        resolvePromotion = resolve;
      }))
      .mockResolvedValue({ promoted: 1, skipped: 0, correlated: 0, errors: 0 });
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd,
    });

    processor.notify({ cwd: "/tmp", priority: 1, pendingCount: 1 });
    const first = processor.flushOnce();
    const second = processor.flushOnce();
    await second;

    expect(promoteEventsForCwd).toHaveBeenCalledTimes(1);
    resolvePromotion?.({ promoted: 500, skipped: 0, correlated: 0, errors: 0 });
    await first;

    await processor.flushOnce();
    expect(promoteEventsForCwd).toHaveBeenCalledTimes(2);
  });

  it("requeues active work when a batch reports promotion errors", async () => {
    const { deps } = timerDeps();
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>()
      .mockResolvedValueOnce({ promoted: 2, skipped: 0, correlated: 0, errors: 1 })
      .mockResolvedValueOnce({ promoted: 0, skipped: 0, correlated: 0, errors: 0, message: "no unprocessed events" });
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd,
    });

    processor.notify({ cwd: "/tmp", priority: 1, pendingCount: 1 });
    await processor.flushOnce();
    await processor.flushOnce();

    expect(promoteEventsForCwd).toHaveBeenCalledTimes(2);
  });

  it("stop clears project, startup, and periodic timers", () => {
    const { deps } = timerDeps();
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd: vi.fn(),
    });

    processor.start();
    processor.notify({ cwd: "/tmp", priority: 3, pendingCount: 1 });
    processor.stop();

    expect(deps.clearTimeout).toHaveBeenCalledTimes(2);
    expect(deps.clearInterval).toHaveBeenCalledTimes(1);
  });

  it("propagates an external daemon abort and detaches it during stop", () => {
    const { deps } = timerDeps();
    const external = new AbortController();
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      signal: external.signal,
      promoteEventsForCwd: vi.fn(),
    });

    external.abort();
    processor.stop();
    expect(external.signal.aborted).toBe(true);
  });

  it("honors a daemon signal that was already aborted at construction", () => {
    const { deps } = timerDeps();
    const external = new AbortController();
    external.abort();

    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      signal: external.signal,
      promoteEventsForCwd: vi.fn(),
    });

    processor.stop();
    expect(external.signal.aborted).toBe(true);
  });

  it("passes the daemon-owned storage factory to background promotion", async () => {
    const { deps } = timerDeps();
    const storageFactory = { backend: "sqlite" } as never;
    const promoteEventsForCwd = vi.fn().mockResolvedValue({
      promoted: 0,
      skipped: 0,
      correlated: 0,
      errors: 0,
      message: "no unprocessed events",
    });
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      storageFactory,
      promoteEventsForCwd: promoteEventsForCwd as never,
    });

    processor.notify({ cwd: "/tmp", priority: 1 });
    await processor.flushOnce();

    expect(promoteEventsForCwd).toHaveBeenCalledWith(
      expect.any(Object),
      "/tmp",
      undefined,
      storageFactory,
      undefined,
      expect.objectContaining({
        withPublicationAdmission: expect.any(Function),
        signal: expect.any(Object),
      }),
    );
  });

  it("passes bounded admission to a notified promotion batch without retaining it around promotion work", async () => {
    const { home, configPath } = publicationFixture();
    const { deps } = timerDeps();
    let releasePromotion: () => void = () => undefined;
    let markPromotionStarted!: () => void;
    const promotionStarted = new Promise<void>(resolve => { markPromotionStarted = resolve; });
    let capturedToken: object | undefined;
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockImplementation(async (
      _config,
      _cwd,
      _sidecarPath,
      _storageFactory,
      _publicationLockToken,
      context,
    ) => {
      await context?.withPublicationAdmission?.(token => {
        capturedToken = token;
      });
      markPromotionStarted();
      await new Promise<void>(resolve => {
        releasePromotion = resolve;
      });
      return { promoted: 0, skipped: 0, correlated: 0, errors: 0, message: "no unprocessed events" };
    });
    const withPublicationAdmission: PublicationAdmission = async operation =>
      withBackendPublicationConsumerLockAsync(home, operation);
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd,
      withPublicationAdmission,
    } as never);

    try {
      processor.notify({ cwd: "/tmp", priority: 1 });
      await expect(withBackendPublicationConfigLockAsync(configPath, async () => undefined)).resolves.toBeUndefined();

      const drain = processor.flushOnce();
      await promotionStarted;
      expect(capturedToken).toEqual(expect.any(Object));
      await expect(withBackendPublicationConfigLockAsync(configPath, async () => undefined)).resolves.toBeUndefined();
      expect(promoteEventsForCwd).toHaveBeenCalledWith(
        expect.any(Object),
        "/tmp",
        undefined,
        undefined,
        undefined,
        expect.objectContaining({
          withPublicationAdmission: expect.any(Function),
          signal: expect.any(Object),
        }),
      );

      let shutdownComplete = false;
      const shutdown = processor.stopAndWait().then(() => { shutdownComplete = true; });
      await Promise.resolve();
      expect(shutdownComplete).toBe(false);
      releasePromotion();
      await Promise.all([drain, shutdown]);
      await expect(withBackendPublicationConfigLockAsync(configPath, async () => undefined)).resolves.toBeUndefined();
      expect(() => assertBackendPublicationConsumerAccess({
        homeDir: home,
        lockToken: capturedToken,
      })).toThrowError(expect.objectContaining({ reason: "permit-mismatch" }));
    } finally {
      releasePromotion();
      processor.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("passes bounded admission to an independent sweep batch only after sidecar scanning", async () => {
    const { home, configPath } = publicationFixture();
    const { deps } = timerDeps();
    let releaseScan: () => void = () => undefined;
    let markScanFinished!: () => void;
    const scanFinished = new Promise<void>(resolve => { markScanFinished = resolve; });
    let releasePromotion: () => void = () => undefined;
    let markPromotionStarted!: () => void;
    const promotionStarted = new Promise<void>(resolve => { markPromotionStarted = resolve; });
    let capturedToken: object | undefined;
    const collectEventSidecars = vi.fn<CollectEventSidecars>().mockImplementation(async () => {
      markScanFinished();
      await new Promise<void>(resolve => {
        releaseScan = resolve;
      });
      return [sidecar({ cwd: "/tmp", path: "/events/tmp.db", unprocessed: 1 })];
    });
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockImplementation(async (
      _config,
      _cwd,
      _sidecarPath,
      _storageFactory,
      _publicationLockToken,
      context,
    ) => {
      await context?.withPublicationAdmission?.(token => {
        capturedToken = token;
      });
      markPromotionStarted();
      await new Promise<void>(resolve => {
        releasePromotion = resolve;
      });
      return { promoted: 1, skipped: 0, correlated: 0, errors: 0 };
    });
    const withPublicationAdmission: PublicationAdmission = async operation =>
      withBackendPublicationConsumerLockAsync(home, operation);
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      collectEventSidecars,
      promoteEventsForCwd,
      withPublicationAdmission,
    } as never);

    try {
      const sweep = processor.runSweep();
      await scanFinished;
      await expect(withBackendPublicationConfigLockAsync(configPath, async () => undefined)).resolves.toBeUndefined();
      releaseScan();
      await promotionStarted;
      expect(capturedToken).toEqual(expect.any(Object));
      await expect(withBackendPublicationConfigLockAsync(configPath, async () => undefined)).resolves.toBeUndefined();
      expect(promoteEventsForCwd).toHaveBeenCalledWith(
        expect.any(Object),
        "/tmp",
        "/events/tmp.db",
        undefined,
        undefined,
        expect.objectContaining({
          withPublicationAdmission: expect.any(Function),
          signal: expect.any(Object),
        }),
      );
      releasePromotion();
      await sweep;
    } finally {
      releaseScan();
      releasePromotion();
      processor.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("logs a notified admission failure and continues with the next queued project", async () => {
    const { deps } = timerDeps();
    const blockedCwd = mkdtempSync(join(tmpdir(), "lcm-passive-blocked-"));
    const healthyCwd = mkdtempSync(join(tmpdir(), "lcm-passive-healthy-"));
    const admissionFailure = new BackendPublicationJournalError("unexpected-state", "blocked");
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockImplementation(async (...args) =>
      args[5]?.withPublicationAdmission?.(() => {
        admissionCalls++;
        if (admissionCalls === 1) throw admissionFailure;
        return {
          promoted: 0,
          skipped: 0,
          correlated: 0,
          errors: 0,
          message: "no unprocessed events",
        };
      }) ?? {
        promoted: 0,
        skipped: 0,
        correlated: 0,
        errors: 0,
        message: "no unprocessed events",
      });
    let admissionCalls = 0;
    const withPublicationAdmission: PublicationAdmission = async operation => operation({});
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd,
      withPublicationAdmission,
    } as never);

    try {
      processor.notify({ cwd: blockedCwd, priority: 1 });
      processor.notify({ cwd: healthyCwd, priority: 1 });
      await processor.flushOnce();

      expect(deps.safeLogError).toHaveBeenCalledWith(
        "passive-event-processor",
        admissionFailure,
        { cwd: blockedCwd },
      );
      expect(promoteEventsForCwd).toHaveBeenCalledTimes(2);
      expect(promoteEventsForCwd).toHaveBeenCalledWith(
        expect.any(Object),
        healthyCwd,
        undefined,
        undefined,
        undefined,
        expect.objectContaining({
          withPublicationAdmission: expect.any(Function),
          signal: expect.any(Object),
        }),
      );
    } finally {
      processor.stop();
      rmSync(blockedCwd, { recursive: true, force: true });
      rmSync(healthyCwd, { recursive: true, force: true });
    }
  });

  it("logs a sweep admission failure and continues with later sidecars", async () => {
    const { deps } = timerDeps();
    const admissionFailure = new BackendPublicationJournalError("unexpected-state", "blocked");
    const collectEventSidecars = vi.fn<CollectEventSidecars>().mockResolvedValue([
      sidecar({ cwd: "/blocked", path: "/events/blocked.db", unprocessed: 1 }),
      sidecar({ cwd: "/healthy", path: "/events/healthy.db", unprocessed: 1 }),
    ]);
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockImplementation(async (...args) =>
      args[5]?.withPublicationAdmission?.(() => {
        admissionCalls++;
        if (admissionCalls === 1) throw admissionFailure;
        return { promoted: 1, skipped: 0, correlated: 0, errors: 0 };
      }) ?? { promoted: 1, skipped: 0, correlated: 0, errors: 0 });
    let admissionCalls = 0;
    const withPublicationAdmission: PublicationAdmission = async operation => operation({});
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      collectEventSidecars,
      promoteEventsForCwd,
      withPublicationAdmission,
    } as never);

    await processor.runSweep();

    expect(deps.safeLogError).toHaveBeenCalledWith(
      "passive-event-processor",
      admissionFailure,
      { cwd: "/blocked" },
    );
    expect(promoteEventsForCwd).toHaveBeenCalledTimes(2);
    expect(promoteEventsForCwd).toHaveBeenCalledWith(
      expect.any(Object),
      "/healthy",
      "/events/healthy.db",
      undefined,
      undefined,
      expect.objectContaining({
        withPublicationAdmission: expect.any(Function),
        signal: expect.any(Object),
      }),
    );
  });

  // #1384: a frozen startup backend can never be re-admitted by this process,
  // so the sweep must stop and report instead of retrying every five minutes.
  it("halts the sweep and reports once on a frozen startup-backend mismatch", async () => {
    const { deps } = timerDeps();
    const mismatch = new BackendPublicationJournalError(
      "backend-mismatch",
      "daemon request backend differs from the authenticated startup backend",
    );
    const collectEventSidecars = vi.fn<CollectEventSidecars>().mockResolvedValue([
      sidecar({ cwd: "/mismatched", path: "/events/mismatched.db", unprocessed: 1 }),
      sidecar({ cwd: "/later", path: "/events/later.db", unprocessed: 1 }),
    ]);
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockImplementation(async (...args) =>
      args[5]?.withPublicationAdmission?.(() => {
        throw mismatch;
      }) ?? { promoted: 1, skipped: 0, correlated: 0, errors: 0 });
    const withPublicationAdmission: PublicationAdmission = async operation => operation({});
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      collectEventSidecars,
      promoteEventsForCwd,
      withPublicationAdmission,
    } as never);

    processor.start();
    expect(processor.backgroundDiagnostics()).toMatchObject({
      halted: false,
      haltedReason: null,
      haltedMessage: null,
    });

    await processor.runSweep();

    // The later sidecar is abandoned: every sidecar would fail identically.
    expect(promoteEventsForCwd).toHaveBeenCalledTimes(1);
    expect(deps.safeLogError).toHaveBeenCalledTimes(1);
    expect(deps.safeLogError).toHaveBeenCalledWith("passive-event-processor", mismatch, {});
    expect(processor.backgroundDiagnostics()).toMatchObject({
      halted: true,
      haltedReason: "backend-mismatch",
      haltedMessage: "daemon request backend differs from the authenticated startup backend",
    });
    // The periodic sweep is retired rather than left looping.
    expect(deps.clearInterval).toHaveBeenCalled();

    // A further sweep neither promotes nor re-reports the identical refusal.
    await processor.runSweep();
    expect(promoteEventsForCwd).toHaveBeenCalledTimes(1);
    expect(deps.safeLogError).toHaveBeenCalledTimes(1);
  });

  it("halts notified promotion and abandons the remaining queued projects", async () => {
    const { deps } = timerDeps();
    const mismatch = new BackendPublicationJournalError(
      "backend-mismatch",
      "daemon request backend differs from the authenticated startup backend",
    );
    const firstCwd = mkdtempSync(join(tmpdir(), "lcm-passive-mismatch-"));
    const secondCwd = mkdtempSync(join(tmpdir(), "lcm-passive-later-"));
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockImplementation(async (...args) =>
      args[5]?.withPublicationAdmission?.(() => {
        throw mismatch;
      }) ?? { promoted: 0, skipped: 0, correlated: 0, errors: 0, message: "no unprocessed events" });
    const withPublicationAdmission: PublicationAdmission = async operation => operation({});
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd,
      withPublicationAdmission,
    } as never);

    try {
      processor.notify({ cwd: firstCwd, priority: 1 });
      processor.notify({ cwd: secondCwd, priority: 1 });
      await processor.flushOnce();

      expect(promoteEventsForCwd).toHaveBeenCalledTimes(1);
      expect(deps.safeLogError).toHaveBeenCalledTimes(1);
      expect(processor.backgroundDiagnostics().haltedReason).toBe("backend-mismatch");

      // A halted processor stops accepting new background work entirely.
      processor.notify({ cwd: secondCwd, priority: 1 });
      await processor.flushOnce();
      expect(promoteEventsForCwd).toHaveBeenCalledTimes(1);
    } finally {
      processor.stop();
      rmSync(firstCwd, { recursive: true, force: true });
      rmSync(secondCwd, { recursive: true, force: true });
    }
  });

  // #1383: the replication worker had no production caller, so markReplicated
  // and markRemotePruned were unreachable and nothing reported the absence.
  it("drains each scanned project and reports what replication moved", async () => {
    const home = replicationHome();
    const { deps } = timerDeps();
    const collectEventSidecars = vi.fn<CollectEventSidecars>().mockResolvedValue([
      sidecar({ cwd: "/bound", path: "/events/bound.db", unprocessed: 0 }),
      sidecar({ cwd: "/unbound", path: "/events/unbound.db", unprocessed: 0 }),
      sidecar({ cwd: "/broken", path: "/events/broken.db", scanError: "io" }),
      sidecar({ cwd: "/budget", path: "/events/budget.db", scanSkipped: true }),
      sidecar({ cwd: undefined, path: "/events/orphan.db" }),
    ]);
    const replicatePassiveEvents = vi.fn(async (cwd: string) => (
      cwd === "/bound"
        ? {
          leaseAcquired: true,
          uploaded: 4,
          applied: 3,
          retried: 1,
          quarantined: 2,
          acknowledged: 3,
          pruned: 5,
          backlog: false,
        }
        : null
    ));
    const processor = new PassiveEventProcessor(
      makeReplicatingConfig(),
      PASSIVE_EVENT_PROCESSOR_DEFAULTS,
      {
        ...deps,
        collectEventSidecars,
        replicatePassiveEvents,
        withPublicationAdmission: realPublicationAdmission(home),
      } as never,
    );

    await processor.runSweep();

    // Only scannable projects with a cwd are offered to replication.
    expect(replicatePassiveEvents.mock.calls.map(call => call[0]))
      .toEqual(["/bound", "/unbound"]);
    // The scanned sidecar path travels with its cwd (#1488).
    expect(replicatePassiveEvents.mock.calls.map(call => call[2]))
      .toEqual(["/events/bound.db", "/events/unbound.db"]);
    expect(processor.backgroundDiagnostics().replication).toMatchObject({
      enabled: true,
      passes: 1,
      projects: 1,
      uploaded: 4,
      applied: 3,
      acknowledged: 3,
      pruned: 5,
      retried: 1,
      quarantined: 2,
    });
    expect(processor.backgroundDiagnostics().replication.lastPassAt).toEqual(expect.any(String));
  });

  it("reports that replication never ran when the daemon cannot replicate", async () => {
    const { deps } = timerDeps();
    const collectEventSidecars = vi.fn<CollectEventSidecars>().mockResolvedValue([
      sidecar({ cwd: "/project", path: "/events/project.db", unprocessed: 0 }),
    ]);
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      collectEventSidecars,
    } as never);

    await processor.runSweep();

    expect(processor.backgroundDiagnostics().replication).toEqual({
      enabled: false,
      lastPassAt: null,
      passes: 0,
      projects: 0,
      uploaded: 0,
      applied: 0,
      acknowledged: 0,
      pruned: 0,
      retried: 0,
      quarantined: 0,
    });
  });

  it("abandons replication when the processor stops mid-pass", async () => {
    const home = replicationHome();
    const { deps } = timerDeps();
    const collectEventSidecars = vi.fn<CollectEventSidecars>().mockResolvedValue([
      sidecar({ cwd: "/first", path: "/events/first.db", unprocessed: 0 }),
      sidecar({ cwd: "/second", path: "/events/second.db", unprocessed: 0 }),
    ]);
    let processor!: PassiveEventProcessor;
    const replicatePassiveEvents = vi.fn(async () => {
      processor.stop();
      return null;
    });
    processor = new PassiveEventProcessor(
      makeReplicatingConfig(),
      PASSIVE_EVENT_PROCESSOR_DEFAULTS,
      {
        ...deps,
        collectEventSidecars,
        replicatePassiveEvents,
        withPublicationAdmission: realPublicationAdmission(home),
      } as never,
    );

    await processor.runSweep();

    expect(replicatePassiveEvents).toHaveBeenCalledTimes(1);
  });

  // #1383 asked for trustworthy replication signals. A SQLite daemon can never
  // replicate, so counting five-minute passes and reporting `enabled` there is
  // a standing false signal on the default backend.
  it("never claims replication on a daemon whose backend cannot replicate", async () => {
    const { deps } = timerDeps();
    const collectEventSidecars = vi.fn<CollectEventSidecars>().mockResolvedValue([
      sidecar({ cwd: "/project", path: "/events/project.db", unprocessed: 0 }),
    ]);
    const replicatePassiveEvents = vi.fn(async () => replicationSummary());
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      collectEventSidecars,
      replicatePassiveEvents,
    } as never);

    await processor.runSweep();

    expect(replicatePassiveEvents).not.toHaveBeenCalled();
    expect(processor.backgroundDiagnostics().replication).toEqual({
      enabled: false,
      lastPassAt: null,
      passes: 0,
      projects: 0,
      uploaded: 0,
      applied: 0,
      acknowledged: 0,
      pruned: 0,
      retried: 0,
      quarantined: 0,
    });
  });

  // #1384 in the other direction. That issue was a frozen startup backend
  // making the daemon do nothing and say nothing; this is the same frozen
  // snapshot making it keep uploading to a backend it has already lost.
  // Promotion is skipped entirely once a sidecar has no unprocessed events, so
  // replication is the only remaining pass that can reach the old backend.
  // The pass admits each phase separately and rethrows a frozen-backend
  // refusal instead of reporting it, so the sweep still halts here.
  it("halts replication when a phase admission reports the backend left", async () => {
    const { home } = publicationFixture();
    const { deps } = timerDeps();
    const mismatch = new BackendPublicationJournalError(
      "backend-mismatch",
      "daemon request backend differs from the authenticated startup backend",
    );
    const collectEventSidecars = vi.fn<CollectEventSidecars>().mockResolvedValue([
      sidecar({ cwd: "/promoted", path: "/events/promoted.db", unprocessed: 0 }),
    ]);
    const replicatePassiveEvents = vi.fn()
      .mockResolvedValueOnce(replicationSummary())
      .mockRejectedValueOnce(mismatch);
    const processor = new PassiveEventProcessor(
      makeReplicatingConfig(),
      PASSIVE_EVENT_PROCESSOR_DEFAULTS,
      {
        ...deps,
        collectEventSidecars,
        replicatePassiveEvents,
      } as never,
    );

    try {
      await processor.runSweep();
      expect(replicatePassiveEvents).toHaveBeenCalledTimes(1);

      // Publication moves the daemon off PostgreSQL. The next phase
      // admission refuses, the pass rethrows, and the sweep halts.
      await processor.runSweep();

      expect(replicatePassiveEvents).toHaveBeenCalledTimes(2);
      expect(processor.backgroundDiagnostics()).toMatchObject({
        halted: true,
        haltedReason: "backend-mismatch",
      });
    } finally {
      processor.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The sweep must not hold publication admission across the replication
  // call: the pass admits each worker phase separately (proved at the pass
  // level), so the admission lock file must be absent for the whole call
  // and hook appends are never blocked behind a full sweep. A reverted
  // processor that re-wraps the call observes the lock file instead.
  it("releases publication admission across the replication call", async () => {
    const { home } = publicationFixture();
    const { deps } = timerDeps();
    const lockPath = join(home, ".lcm.backend-publication.lock");
    let lockHeldDuringReplication: boolean | null = null;
    let outboxAccess = "not attempted";
    const withPublicationAdmission = realPublicationAdmission(home);
    const collectEventSidecars = vi.fn<CollectEventSidecars>().mockResolvedValue([
      sidecar({ cwd: "/bound", path: "/events/bound.db", unprocessed: 0 }),
    ]);
    const replicatePassiveEvents = vi.fn(async () => {
      lockHeldDuringReplication = existsSync(lockPath);
      try {
        outboxAccess = withBackendPublicationConsumerLock(home, () => "acquired");
      } catch (error) {
        outboxAccess = (error as Error).message;
      }
      return replicationSummary();
    });
    const processor = new PassiveEventProcessor(
      makeReplicatingConfig(),
      PASSIVE_EVENT_PROCESSOR_DEFAULTS,
      {
        ...deps,
        collectEventSidecars,
        replicatePassiveEvents,
        withPublicationAdmission,
      } as never,
    );

    try {
      await processor.runSweep();

      expect(replicatePassiveEvents).toHaveBeenCalledTimes(1);
      expect(lockHeldDuringReplication).toBe(false);
      expect(outboxAccess).toBe("acquired");
    } finally {
      processor.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports one failed replication pass and continues to the next project", async () => {
    const home = replicationHome();
    const { deps } = timerDeps();
    const failure = new Error("replication pass failed");
    const collectEventSidecars = vi.fn<CollectEventSidecars>().mockResolvedValue([
      sidecar({ cwd: "/first", path: "/events/first.db", unprocessed: 0 }),
      sidecar({ cwd: "/second", path: "/events/second.db", unprocessed: 0 }),
    ]);
    const replicatePassiveEvents = vi.fn(async (cwd: string) => {
      if (cwd === "/first") throw failure;
      return replicationSummary();
    });
    const processor = new PassiveEventProcessor(
      makeReplicatingConfig(),
      PASSIVE_EVENT_PROCESSOR_DEFAULTS,
      {
        ...deps,
        collectEventSidecars,
        replicatePassiveEvents,
        withPublicationAdmission: realPublicationAdmission(home),
      } as never,
    );

    await processor.runSweep();

    expect(deps.safeLogError)
      .toHaveBeenCalledWith("passive-event-processor", failure, { cwd: "/first" });
    expect(processor.backgroundDiagnostics()).toMatchObject({
      halted: false,
      replication: { projects: 1 },
    });
  });

  it("waits for an in-flight drain before completing shutdown", async () => {
    const { deps } = timerDeps();
    let releasePromotion: ((value: unknown) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const promoteEventsForCwd = vi.fn().mockImplementation(() => {
      markStarted?.();
      return new Promise((resolve) => { releasePromotion = resolve; });
    });
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd: promoteEventsForCwd as never,
    });

    processor.notify({ cwd: "/tmp", priority: 1 });
    const drain = processor.flushOnce();
    await started;
    let shutdownComplete = false;
    const shutdown = processor.stopAndWait().then(() => { shutdownComplete = true; });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    releasePromotion?.({ promoted: 0, skipped: 0, correlated: 0, errors: 0 });
    await Promise.all([drain, shutdown]);
    expect(shutdownComplete).toBe(true);
    await expect(processor.stopAndWait()).resolves.toBeUndefined();
  });

  it("aborts background promotion context before completing processor shutdown", async () => {
    const { deps } = timerDeps();
    let signal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockImplementation(async (...args) => {
      signal = args[5]?.signal;
      markStarted();
      return new Promise<PromoteResult>(resolve => {
        signal?.addEventListener("abort", () => resolve({
          promoted: 0,
          skipped: 0,
          correlated: 0,
          errors: 0,
          message: "promotion cancelled",
        }), { once: true });
      });
    });
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      promoteEventsForCwd,
    });

    processor.notify({ cwd: "/tmp", priority: 1 });
    const drain = processor.flushOnce();
    await started;
    const shutdown = processor.stopAndWait();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await Promise.all([drain, shutdown]);
    expect(signal?.aborted).toBe(true);
  });

  describe("a failing diagnostic logger in a background timer (#1786)", () => {
    const logFailure = new Error("logger failed");

    it("contains it when the interval sweep fails", async () => {
      const { intervals, deps } = timerDeps();
      const scanError = new Error("scan failed");
      const safeLogError = vi.fn().mockRejectedValue(logFailure);
      const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
        ...deps,
        safeLogError,
        collectEventSidecars: vi.fn<CollectEventSidecars>().mockRejectedValue(scanError),
      });
      processor.start();

      const leaked = await leakedRejections(() => { intervals[0].callback(); });

      expect(leaked).toEqual([]);
      expect(safeLogError).toHaveBeenCalledTimes(1);
      expect(safeLogError).toHaveBeenCalledWith("passive-event-processor", scanError, {});
      processor.stop();
    });

    it("contains it when the scheduled sweep fails", async () => {
      const { timers, deps } = timerDeps();
      const scanError = new Error("scan failed");
      const safeLogError = vi.fn().mockRejectedValue(logFailure);
      const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
        ...deps,
        safeLogError,
        collectEventSidecars: vi.fn<CollectEventSidecars>().mockRejectedValue(scanError),
      });
      processor.start();
      expect(timers[0].ms).toBe(0);

      const leaked = await leakedRejections(() => { timers[0].callback(); });

      expect(leaked).toEqual([]);
      expect(safeLogError).toHaveBeenCalledTimes(1);
      expect(safeLogError).toHaveBeenCalledWith("passive-event-processor", scanError, {});
      processor.stop();
    });

    it("contains it when a project debounce drain fails", async () => {
      const { timers, deps } = timerDeps();
      const promoteError = new Error("promote failed");
      const safeLogError = vi.fn().mockRejectedValue(logFailure);
      const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
        ...deps,
        safeLogError,
        promoteEventsForCwd: vi.fn<PromoteEventsForCwd>().mockRejectedValue(promoteError),
      });
      processor.notify({ cwd: "/tmp", priority: 1 });

      const leaked = await leakedRejections(() => { timers[0].callback(); });

      expect(leaked).toEqual([]);
      expect(safeLogError).toHaveBeenCalledTimes(2);
      expect(safeLogError).toHaveBeenNthCalledWith(1, "passive-event-processor", promoteError, { cwd: "/tmp" });
      expect(safeLogError).toHaveBeenNthCalledWith(2, "passive-event-processor", logFailure, { cwd: "/tmp" });
      processor.stop();
    });
  });
});

describe("PassiveEventProcessor replication follow-up (#1764)", () => {
  const BACKLOG_DELAY = PASSIVE_EVENT_PROCESSOR_DEFAULTS.replicationBacklogDelayMs;
  const DEBOUNCE = PASSIVE_EVENT_PROCESSOR_DEFAULTS.debounceMs;
  const idle: PromoteResult = {
    promoted: 0,
    skipped: 0,
    correlated: 0,
    errors: 0,
    message: "no unprocessed events",
  };

  function outcome(overrides: Partial<ReturnType<typeof replicationSummary>> = {}) {
    return {
      leaseAcquired: true,
      uploaded: 0,
      applied: 0,
      retried: 0,
      quarantined: 0,
      acknowledged: 0,
      pruned: 0,
      backlog: false,
      ...overrides,
    };
  }

  const saturated = (overrides: Partial<ReturnType<typeof outcome>> = {}) =>
    outcome({ applied: 1, backlog: true, ...overrides });

  const A = sidecar({ cwd: "/a", path: "/events/a.db", unprocessed: 0 });
  const B = sidecar({ cwd: "/b", path: "/events/b.db", unprocessed: 0 });

  /** Timers that track cancellation and firing so only live ones are exposed. */
  function harness(
    sidecars: readonly EventSidecarSummary[],
    replicate: (cwd: string, signal: AbortSignal | undefined, path: string) => Promise<unknown>,
    extra: Record<string, unknown> = {},
  ) {
    const base = timerDeps();
    const cleared = new Set<unknown>();
    const fired = new Set<unknown>();
    base.deps.clearTimeout = ((handle: unknown) => { cleared.add(handle); }) as typeof clearTimeout;
    const collect = vi.fn<CollectEventSidecars>().mockResolvedValue([...sidecars]);
    const replicatePassiveEvents = vi.fn(replicate);
    const processor = new PassiveEventProcessor(
      makeReplicatingConfig(),
      PASSIVE_EVENT_PROCESSOR_DEFAULTS,
      {
        ...base.deps,
        collectEventSidecars: collect,
        replicatePassiveEvents,
        promoteEventsForCwd: vi.fn<PromoteEventsForCwd>().mockResolvedValue(idle),
        ...extra,
      } as never,
    );
    const live = (ms: number) =>
      base.timers.filter(timer => timer.ms === ms && !cleared.has(timer) && !fired.has(timer));
    /** Fire one timer and return the timers it scheduled. */
    const fireTimer = async (timer: ScheduledTimer | undefined) => {
      if (timer === undefined) throw new Error("no timer to fire");
      const before = base.timers.length;
      fired.add(timer);
      timer.callback();
      await new Promise<void>(resolve => { setImmediate(resolve); });
      return base.timers.slice(before);
    };
    const fire = (ms: number) => fireTimer(live(ms)[0]);
    return { ...base, processor, collect, replicatePassiveEvents, live, fire, fireTimer, cleared };
  }

  const calledPaths = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map(call => call[2]);

  it("replicates only the saturated project again shortly after, until it is no longer saturated", async () => {
    const results = [saturated(), saturated(), outcome({ applied: 1 })];
    const h = harness([A, B], async (_cwd, _signal, path) =>
      path === A.path ? results.shift() : outcome({ applied: 1 }));

    await h.processor.runSweep();
    expect(calledPaths(h.replicatePassiveEvents)).toEqual([A.path, B.path]);
    expect(h.live(BACKLOG_DELAY)).toHaveLength(1);
    expect(h.live(BACKLOG_DELAY)[0]?.unref).toHaveBeenCalled();

    await h.fire(BACKLOG_DELAY);
    expect(calledPaths(h.replicatePassiveEvents)).toEqual([A.path, B.path, A.path]);
    expect(h.live(BACKLOG_DELAY)).toHaveLength(1);

    await h.fire(BACKLOG_DELAY);
    expect(calledPaths(h.replicatePassiveEvents)).toEqual([A.path, B.path, A.path, A.path]);
    expect(h.live(BACKLOG_DELAY)).toHaveLength(0);
    expect(h.replicatePassiveEvents.mock.calls.at(-1)?.[1]).toBeInstanceOf(AbortSignal);
    expect(h.processor.backgroundDiagnostics().replication).toMatchObject({
      passes: 3,
      projects: 4,
      applied: 4,
    });
    h.processor.stop();
  });

  it.each(["uploaded", "applied", "acknowledged", "quarantined", "pruned"] as const)(
    "counts %s as terminal progress for a saturated pass",
    async field => {
      const h = harness([A], async () => outcome({ backlog: true, [field]: 1 }));
      await h.processor.runSweep();
      expect(h.live(BACKLOG_DELAY)).toHaveLength(1);
      h.processor.stop();
    },
  );

  it.each([
    ["only retried rows", outcome({ backlog: true, retried: 3 })],
    ["no progress at all", outcome({ backlog: true })],
    ["progress without a backlog", outcome({ applied: 2 })],
  ])("does not schedule a follow-up after a pass with %s", async (_name, result) => {
    const h = harness([A], async () => result);
    await h.processor.runSweep();
    expect(h.live(BACKLOG_DELAY)).toHaveLength(0);
    h.processor.stop();
  });

  it("forgets a project whose follow-up returns null or fails", async () => {
    const failure = new Error("remote unavailable");
    for (const next of [null, failure]) {
      const results: unknown[] = [saturated(), next];
      const h = harness([A], async () => {
        const value = results.shift();
        if (value instanceof Error) throw value;
        return value;
      });
      await h.processor.runSweep();
      expect(h.live(BACKLOG_DELAY)).toHaveLength(1);
      await h.fire(BACKLOG_DELAY);
      expect(h.replicatePassiveEvents).toHaveBeenCalledTimes(2);
      expect(h.live(BACKLOG_DELAY)).toHaveLength(0);
      if (next !== null) {
        expect(h.deps.safeLogError)
          .toHaveBeenCalledWith("passive-event-processor", failure, { cwd: A.cwd });
      }
      h.processor.stop();
    }
  });

  it("keeps a saturated project that a later sweep did not reach", async () => {
    const h = harness([A], async (_cwd, _signal, path) =>
      path === A.path ? saturated() : outcome());
    await h.processor.runSweep();
    const [first] = h.live(BACKLOG_DELAY);

    h.collect.mockResolvedValueOnce([B]);
    await h.processor.runSweep();
    // The later sweep re-armed the single follow-up rather than stacking one.
    expect(h.cleared.has(first)).toBe(true);
    expect(h.live(BACKLOG_DELAY)).toHaveLength(1);

    await h.fire(BACKLOG_DELAY);
    expect(calledPaths(h.replicatePassiveEvents)).toEqual([A.path, B.path, A.path]);
    h.processor.stop();
  });

  it("lets queued local promotion run before the follow-up replication", async () => {
    const order: string[] = [];
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockImplementation(async () => {
      order.push("promote");
      return idle;
    });
    const h = harness([A], async () => {
      order.push("replicate");
      return saturated();
    }, { promoteEventsForCwd });
    await h.processor.runSweep();
    order.length = 0;

    h.processor.notify({ cwd: "/tmp", priority: 1 });
    const [deferred] = await h.fire(BACKLOG_DELAY);
    expect(order).toEqual([]);
    expect(deferred?.ms).toBe(DEBOUNCE);

    await h.processor.flushOnce();
    await h.fireTimer(deferred);
    expect(order).toEqual(["promote", "replicate"]);
    h.processor.stop();
  });

  it("re-arms instead of overlapping an in-flight drain", async () => {
    let releasePromotion!: () => void;
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockImplementation(() =>
      new Promise<PromoteResult>(resolve => { releasePromotion = () => resolve(idle); }));
    const h = harness([A], async () => saturated(), { promoteEventsForCwd });
    await h.processor.runSweep();
    expect(h.replicatePassiveEvents).toHaveBeenCalledTimes(1);

    h.processor.notify({ cwd: "/tmp", priority: 1 });
    const drain = h.processor.flushOnce();
    await new Promise<void>(resolve => { setImmediate(resolve); });
    const [rearmed] = await h.fire(BACKLOG_DELAY);
    expect(h.replicatePassiveEvents).toHaveBeenCalledTimes(1);
    expect(rearmed?.ms).toBe(DEBOUNCE);

    releasePromotion();
    await drain;
    await h.fireTimer(rearmed);
    expect(h.replicatePassiveEvents).toHaveBeenCalledTimes(2);
    h.processor.stop();
  });

  it("yields to promotion once, so a project that keeps requeuing cannot starve replication", async () => {
    let active = 0;
    let overlapped = false;
    const guarded = async <T>(work: () => T): Promise<T> => {
      active += 1;
      if (active > 1) overlapped = true;
      await new Promise<void>(resolve => { setImmediate(resolve); });
      try { return work(); } finally { active -= 1; }
    };
    const order: string[] = [];
    // Project A fails to promote forever and so requeues itself every drain.
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockImplementation(() =>
      guarded(() => {
        order.push("promote");
        return { promoted: 0, skipped: 0, correlated: 0, errors: 1 };
      }));
    const h = harness([B], () => guarded(() => {
      order.push("replicate");
      return saturated();
    }), { promoteEventsForCwd });
    await h.processor.runSweep();
    order.length = 0;

    h.processor.notify({ cwd: "/tmp", priority: 1 });
    await h.processor.flushOnce();
    expect(order).toEqual(["promote"]);

    // First turn goes to promotion; the follow-up defers a single time.
    const [deferred] = await h.fire(BACKLOG_DELAY);
    expect(order).toEqual(["promote"]);
    expect(deferred?.ms).toBe(DEBOUNCE);

    // A is queued again, yet replication now gets its turn.
    await h.processor.flushOnce();
    await h.fireTimer(deferred);
    await vi.waitFor(() => expect(order).toEqual(["promote", "promote", "replicate"]));
    expect(overlapped).toBe(false);
    h.processor.stop();
  });

  it("cancels the follow-up when the processor stops", async () => {
    const h = harness([A], async () => saturated());
    await h.processor.runSweep();
    const [pending] = h.live(BACKLOG_DELAY);

    h.processor.stop();
    expect(h.cleared.has(pending)).toBe(true);

    // A callback that was already due does nothing once stopped.
    pending?.callback();
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(h.replicatePassiveEvents).toHaveBeenCalledTimes(1);
  });

  it("halts a follow-up that hits a frozen-backend mismatch", async () => {
    const mismatch = new BackendPublicationJournalError(
      "backend-mismatch",
      "daemon request backend differs from the authenticated startup backend",
    );
    const results: unknown[] = [saturated(), mismatch];
    const h = harness([A], async () => {
      const value = results.shift();
      if (value instanceof Error) throw value;
      return value;
    });
    await h.processor.runSweep();

    await h.fire(BACKLOG_DELAY);
    expect(h.deps.safeLogError).toHaveBeenCalledWith("passive-event-processor", mismatch, {});
    expect(h.processor.backgroundDiagnostics()).toMatchObject({
      halted: true,
      haltedReason: "backend-mismatch",
    });
    expect(h.live(BACKLOG_DELAY)).toHaveLength(0);
  });

  it("ignores a due follow-up after a halt from promotion", async () => {
    const mismatch = new BackendPublicationJournalError(
      "backend-mismatch",
      "daemon request backend differs from the authenticated startup backend",
    );
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockRejectedValue(mismatch);
    const h = harness([A], async () => saturated(), { promoteEventsForCwd });
    await h.processor.runSweep();
    const [pending] = h.live(BACKLOG_DELAY);

    h.processor.notify({ cwd: "/tmp", priority: 1 });
    await h.processor.flushOnce();
    expect(h.processor.backgroundDiagnostics().halted).toBe(true);
    expect(h.cleared.has(pending)).toBe(true);

    pending?.callback();
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(h.replicatePassiveEvents).toHaveBeenCalledTimes(1);
  });

  it("keeps replicating when logging a failed project rejects, and arms no follow-up for it", async () => {
    const failure = new Error("replicate failed");
    const results: Record<string, unknown[]> = {
      [A.path]: [saturated(), failure],
      [B.path]: [saturated(), saturated(), outcome({ applied: 1 })],
    };
    const safeLogError = vi.fn().mockImplementation(async () => {
      throw new Error("log failed");
    });
    const h = harness([A, B], async (_cwd, _signal, path) => {
      const value = results[path]?.shift();
      if (value instanceof Error) throw value;
      return value;
    }, { safeLogError });
    await h.processor.runSweep();
    expect(h.live(BACKLOG_DELAY)).toHaveLength(1);

    // A fails and its logger rejects; B in the same pass is still replicated.
    await h.fire(BACKLOG_DELAY);
    expect(calledPaths(h.replicatePassiveEvents)).toEqual([A.path, B.path, A.path, B.path]);
    expect(safeLogError).toHaveBeenCalledTimes(1);
    expect(safeLogError).toHaveBeenCalledWith("passive-event-processor", failure, { cwd: A.cwd });

    // Only B stays in the follow-up set.
    await h.fire(BACKLOG_DELAY);
    expect(calledPaths(h.replicatePassiveEvents).slice(4)).toEqual([B.path]);
    h.processor.stop();
  });

  it("logs a follow-up that fails outside the per-project handling", async () => {
    const mismatch = new BackendPublicationJournalError(
      "backend-mismatch",
      "daemon request backend differs from the authenticated startup backend",
    );
    const logFailure = new Error("log failed");
    const results: unknown[] = [saturated(), mismatch];
    const safeLogError = vi.fn().mockRejectedValueOnce(logFailure).mockResolvedValue(undefined);
    const h = harness([A], async () => {
      const value = results.shift();
      if (value instanceof Error) throw value;
      return value;
    }, { safeLogError });
    await h.processor.runSweep();

    await h.fire(BACKLOG_DELAY);

    expect(safeLogError).toHaveBeenNthCalledWith(1, "passive-event-processor", mismatch, {});
    expect(safeLogError).toHaveBeenNthCalledWith(2, "passive-event-processor", logFailure, {});
    h.processor.stop();
  });

  it("contains a logger that keeps failing while a follow-up fails", async () => {
    const mismatch = new BackendPublicationJournalError(
      "backend-mismatch",
      "daemon request backend differs from the authenticated startup backend",
    );
    const logFailure = new Error("logger failed");
    const results: unknown[] = [saturated(), mismatch];
    const safeLogError = vi.fn().mockRejectedValue(logFailure);
    const h = harness([A], async () => {
      const value = results.shift();
      if (value instanceof Error) throw value;
      return value;
    }, { safeLogError });
    await h.processor.runSweep();

    const leaked = await leakedRejections(() => h.fire(BACKLOG_DELAY).then(() => undefined));

    expect(leaked).toEqual([]);
    expect(safeLogError).toHaveBeenCalledTimes(2);
    expect(safeLogError).toHaveBeenNthCalledWith(1, "passive-event-processor", mismatch, {});
    expect(safeLogError).toHaveBeenNthCalledWith(2, "passive-event-processor", logFailure, {});
    h.processor.stop();
  });
});


describe("createPromoteEventsNotifyHandler", () => {
  it.each(["null", "[]", "[1]", '"text"', "0", "42", "true", "false"])(
    "rejects the non-object body %s before notification",
    async (body) => {
      const processor = { notify: vi.fn() } as unknown as PassiveEventProcessor;
      const handler = createPromoteEventsNotifyHandler(processor);
      const { res, getBody } = mockRes();

      await expect(handler(request, res, body)).resolves.toBeUndefined();

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(getBody()).toEqual({ error: "invalid request body" });
      expect(processor.notify).not.toHaveBeenCalled();
    },
  );

  it("preserves empty-body fallback and malformed JSON handling", async () => {
    const processor = { notify: vi.fn() } as unknown as PassiveEventProcessor;
    const handler = createPromoteEventsNotifyHandler(processor);
    const empty = mockRes();
    const object = mockRes();
    const malformed = mockRes();

    await handler(request, empty.res, "");
    await handler(request, object.res, "{}");
    await handler(request, malformed.res, "{");

    expect(empty.res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(empty.getBody()).toEqual({ error: "cwd is required" });
    expect(object.getBody()).toEqual(empty.getBody());
    expect(malformed.res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(malformed.getBody()).toEqual({ error: "invalid json" });
    expect(processor.notify).not.toHaveBeenCalled();
  });

  it("validates cwd and queues processor work", async () => {
    const processor = { notify: vi.fn() } as unknown as PassiveEventProcessor;
    const handler = createPromoteEventsNotifyHandler(processor);
    const { res, getBody } = mockRes();

    await handler(request, res, JSON.stringify({
      cwd: "  /tmp  ",
      priority: 1,
      pendingCount: 12,
      sourceHook: "PostToolUse",
    }));

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(getBody()).toEqual({ queued: true });
    expect(processor.notify).toHaveBeenCalledWith({
      cwd: "/tmp",
      priority: 1,
      pendingCount: 12,
      sourceHook: "PostToolUse",
    });
  });

  it("rejects missing cwd", async () => {
    const processor = { notify: vi.fn() } as unknown as PassiveEventProcessor;
    const handler = createPromoteEventsNotifyHandler(processor);
    const { res, getBody } = mockRes();

    await handler(request, res, JSON.stringify({ priority: 1 }));

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(getBody().error).toBe("cwd is required");
    expect(processor.notify).not.toHaveBeenCalled();
  });
});
