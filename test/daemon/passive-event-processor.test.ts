import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import {
  assertBackendPublicationConsumerAccess,
  BackendPublicationJournalError,
  withBackendPublicationConfigLockAsync,
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

function publicationFixture(): { home: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), "lcm-passive-publication-"));
  const lcmDir = join(home, ".lcm");
  mkdirSync(join(lcmDir, "backend-publication"), { recursive: true, mode: 0o700 });
  const configPath = join(lcmDir, "config.json");
  writeFileSync(configPath, "{}\n", { mode: 0o600 });
  return { home, configPath };
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
      expect.any(Object),
    );
  });

  it("holds live admission for a notified promotion batch and revokes its token after completion", async () => {
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
      publicationLockToken,
    ) => {
      capturedToken = publicationLockToken;
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
      await expect(withBackendPublicationConfigLockAsync(configPath, async () => undefined))
        .rejects.toBeInstanceOf(PrivateMutationLockContentionError);
      expect(promoteEventsForCwd).toHaveBeenCalledWith(
        expect.any(Object),
        "/tmp",
        undefined,
        undefined,
        capturedToken,
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

  it("holds live admission for an independent sweep batch only after sidecar scanning", async () => {
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
      publicationLockToken,
    ) => {
      capturedToken = publicationLockToken;
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
      await expect(withBackendPublicationConfigLockAsync(configPath, async () => undefined))
        .rejects.toBeInstanceOf(PrivateMutationLockContentionError);
      expect(promoteEventsForCwd).toHaveBeenCalledWith(
        expect.any(Object),
        "/tmp",
        "/events/tmp.db",
        undefined,
        capturedToken,
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
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockResolvedValue({
      promoted: 0,
      skipped: 0,
      correlated: 0,
      errors: 0,
      message: "no unprocessed events",
    });
    let admissionCalls = 0;
    const withPublicationAdmission: PublicationAdmission = async operation => {
      admissionCalls++;
      if (admissionCalls === 1) throw admissionFailure;
      return operation({});
    };
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
      expect(promoteEventsForCwd).toHaveBeenCalledTimes(1);
      expect(promoteEventsForCwd).toHaveBeenCalledWith(
        expect.any(Object),
        healthyCwd,
        undefined,
        undefined,
        expect.any(Object),
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
    const promoteEventsForCwd = vi.fn<PromoteEventsForCwd>().mockResolvedValue({
      promoted: 1,
      skipped: 0,
      correlated: 0,
      errors: 0,
    });
    let admissionCalls = 0;
    const withPublicationAdmission: PublicationAdmission = async operation => {
      admissionCalls++;
      if (admissionCalls === 1) throw admissionFailure;
      return operation({});
    };
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
    expect(promoteEventsForCwd).toHaveBeenCalledTimes(1);
    expect(promoteEventsForCwd).toHaveBeenCalledWith(
      expect.any(Object),
      "/healthy",
      "/events/healthy.db",
      undefined,
      expect.any(Object),
    );
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
});

describe("createPromoteEventsNotifyHandler", () => {
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
