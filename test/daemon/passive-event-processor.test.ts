import { describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import {
  createPromoteEventsNotifyHandler,
  PassiveEventProcessor,
  PASSIVE_EVENT_PROCESSOR_DEFAULTS,
} from "../../src/daemon/passive-event-processor.js";

function makeConfig() {
  return loadDaemonConfig("/nonexistent", { daemon: { port: 0 }, llm: { provider: "disabled" } });
}

function mockRes() {
  let body = "";
  const res = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn((data?: string) => { body = data ?? ""; }),
  } as any;
  return { res, getBody: () => JSON.parse(body || "{}") };
}

function timerDeps() {
  const timers: Array<{ callback: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
  const intervals: Array<{ callback: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
  const clearTimeout = vi.fn();
  const clearInterval = vi.fn();
  return {
    timers,
    intervals,
    deps: {
      setTimeout: vi.fn((callback: () => void, ms: number) => {
        const handle = { callback, ms, unref: vi.fn() };
        timers.push(handle);
        return handle as any;
      }),
      clearTimeout: clearTimeout as any,
      setInterval: vi.fn((callback: () => void, ms: number) => {
        const handle = { callback, ms, unref: vi.fn() };
        intervals.push(handle);
        return handle as any;
      }),
      clearInterval: clearInterval as any,
      safeLogError: vi.fn(),
    },
  };
}

describe("PassiveEventProcessor", () => {
  it("schedules priority and threshold notifications with near-immediate delay", () => {
    const { timers, deps } = timerDeps();
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      getPendingCount: vi.fn().mockReturnValue(0),
      promoteEventsForCwd: vi.fn(),
    });

    processor.notify({ cwd: "/tmp", priority: 1, pendingCount: 1 });
    processor.notify({ cwd: "/tmp", priority: 3, pendingCount: 10 });

    expect(timers.map(timer => timer.ms)).toEqual([250, 250]);
    expect(timers.every(timer => timer.unref.mock.calls.length === 1)).toBe(true);
  });

  it("debounces normal notifications", () => {
    const { timers, deps } = timerDeps();
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      getPendingCount: vi.fn().mockReturnValue(1),
      promoteEventsForCwd: vi.fn(),
    });

    processor.notify({ cwd: "/tmp", priority: 3, pendingCount: 1 });

    expect(timers[0].ms).toBe(3000);
  });

  it("runs startup and periodic sweeps with configured scan budget", async () => {
    const { timers, intervals, deps } = timerDeps();
    const drainEventsForCwd = vi.fn().mockResolvedValue({ promoted: 1, skipped: 0, correlated: 0, errors: 0, batches: 1 });
    const collectEventSidecars = vi.fn().mockReturnValue([
      { cwd: "/tmp", path: "/events/tmp.db", unprocessed: 1 },
      { cwd: "/tmp", path: "/events/tmp.db", unprocessed: 0 },
      { path: "/events/orphan.db", unprocessed: 1 },
    ]);
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      collectEventSidecars: collectEventSidecars as any,
      drainEventsForCwd: drainEventsForCwd as any,
    });

    processor.start();
    expect(timers[0].ms).toBe(0);
    expect(intervals[0].ms).toBe(5 * 60 * 1000);

    timers[0].callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(collectEventSidecars).toHaveBeenCalledWith({ timeoutMs: 5000, maxDbs: 20 });
    expect(drainEventsForCwd).toHaveBeenCalledTimes(1);
    expect(drainEventsForCwd.mock.calls[0][1]).toBe("/tmp");
    expect(drainEventsForCwd.mock.calls[0][2]).toBe("/events/tmp.db");
  });

  it("prevents concurrent active drains and requeues remaining work after the batch limit", async () => {
    const { deps } = timerDeps();
    let resolvePromotion: ((value: unknown) => void) | undefined;
    const promoteEventsForCwd = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => {
        resolvePromotion = resolve;
      }))
      .mockResolvedValue({ promoted: 1, skipped: 0, correlated: 0, errors: 0 });
    const getPendingCount = vi.fn()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1);
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      getPendingCount,
      promoteEventsForCwd: promoteEventsForCwd as any,
    });

    processor.notify({ cwd: "/tmp", priority: 1, pendingCount: 1 });
    const first = processor.flushOnce();
    const second = processor.flushOnce();
    await second;

    expect(promoteEventsForCwd).toHaveBeenCalledTimes(1);
    resolvePromotion?.({ promoted: 1, skipped: 0, correlated: 0, errors: 0 });
    await first;

    await processor.flushOnce();
    expect(promoteEventsForCwd).toHaveBeenCalledTimes(2);
  });

  it("stop clears project, startup, and periodic timers", () => {
    const { deps } = timerDeps();
    const processor = new PassiveEventProcessor(makeConfig(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      ...deps,
      getPendingCount: vi.fn().mockReturnValue(1),
      promoteEventsForCwd: vi.fn(),
    });

    processor.start();
    processor.notify({ cwd: "/tmp", priority: 3, pendingCount: 1 });
    processor.stop();

    expect(deps.clearTimeout).toHaveBeenCalledTimes(2);
    expect(deps.clearInterval).toHaveBeenCalledTimes(1);
  });
});

describe("createPromoteEventsNotifyHandler", () => {
  it("validates cwd and queues processor work", async () => {
    const processor = { notify: vi.fn() } as unknown as PassiveEventProcessor;
    const handler = createPromoteEventsNotifyHandler(processor);
    const { res, getBody } = mockRes();

    await handler({} as any, res, JSON.stringify({
      cwd: "/tmp",
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

    await handler({} as any, res, JSON.stringify({ priority: 1 }));

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(getBody().error).toBe("cwd is required");
    expect(processor.notify).not.toHaveBeenCalled();
  });
});
