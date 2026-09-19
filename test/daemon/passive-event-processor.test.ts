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
  mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
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
        }
        : null
    ));
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      collectEventSidecars,
      replicatePassiveEvents,
    } as never);

    await processor.runSweep();

    // Only scannable projects with a cwd are offered to replication.
    expect(replicatePassiveEvents.mock.calls.map(call => call[0]))
      .toEqual(["/bound", "/unbound"]);
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
    processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      collectEventSidecars,
      replicatePassiveEvents,
    } as never);

    await processor.runSweep();

    expect(replicatePassiveEvents).toHaveBeenCalledTimes(1);
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
