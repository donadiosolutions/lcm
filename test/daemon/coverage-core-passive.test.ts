import { describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import {
  createPromoteEventsNotifyHandler,
  PassiveEventProcessor,
  PASSIVE_EVENT_PROCESSOR_DEFAULTS,
  type BackgroundPublicationAdmission,
} from "../../src/daemon/passive-event-processor.js";

const config = () => loadDaemonConfig("/missing", { daemon: { port: 0 }, llm: { provider: "disabled" } });
const testPublicationAdmission: BackgroundPublicationAdmission = async operation => operation({});

function harness(overrides: Record<string, unknown> = {}) {
  const timers: Array<{ callback: () => void; ms: number; unref?: () => void }> = [];
  const intervals: Array<{ callback: () => void; ms: number; unref?: () => void }> = [];
  const log = vi.fn();
  const deps = {
    promoteEventsForCwd: vi.fn().mockResolvedValue({ promoted: 0, skipped: 0, correlated: 0, errors: 0 }),
    collectEventSidecars: vi.fn().mockReturnValue([]),
    setTimeout: vi.fn((callback: () => void, ms: number) => { const h = { callback, ms, unref: vi.fn() }; timers.push(h); return h; }),
    clearTimeout: vi.fn(),
    setInterval: vi.fn((callback: () => void, ms: number) => { const h = { callback, ms, unref: vi.fn() }; intervals.push(h); return h; }),
    clearInterval: vi.fn(), safeLogError: log,
    withPublicationAdmission: testPublicationAdmission,
    ...overrides,
  };
  return { processor: new PassiveEventProcessor(config(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, deps as never), deps, timers, intervals, log };
}

describe("passive event processor boundary coverage", () => {
  it("uses production dependencies with an explicit test admission seam", () => {
    const processor = new PassiveEventProcessor(config(), PASSIVE_EVENT_PROCESSOR_DEFAULTS, {
      withPublicationAdmission: testPublicationAdmission,
    });
    processor.stop();
  });

  it("fails closed when the publication admission seam is absent", () => {
    expect(() => new PassiveEventProcessor(
      config(),
      PASSIVE_EVENT_PROCESSOR_DEFAULTS,
      undefined as never,
    )).toThrow(TypeError);
  });

  it("ignores work after stop and logs rejected periodic and startup sweeps", async () => {
    const h = harness();
    h.processor.stop();
    h.processor.start();
    h.processor.notify({ cwd: "/tmp" });
    await h.processor.runSweep();
    await h.processor.flushOnce();
    expect(h.timers).toHaveLength(0);

    const active = harness();
    active.processor.start();
    active.processor.start();
    expect(active.deps.clearTimeout).toHaveBeenCalledOnce();
    vi.spyOn(active.processor, "runSweep").mockRejectedValue(new Error("sweep"));
    active.timers[0].callback();
    active.intervals[0].callback();
    await Promise.resolve(); await Promise.resolve();
    expect(active.log).toHaveBeenCalledTimes(2);
    active.processor.stop();
  });

  it("reschedules a sweep during a drain and processes sidecar filters and errors", async () => {
    let release: ((value: unknown) => void) | undefined;
    const promote = vi.fn().mockRejectedValue(new Error("promotion"));
    const scan = vi.fn().mockReturnValue([
      { cwd: "/tmp", path: "/a", unprocessed: 1, scanError: "bad" },
      { cwd: "/tmp", path: "/b", unprocessed: 1, scanSkipped: true },
      { cwd: "/tmp", path: "/c", unprocessed: 0 },
      { path: "/d", unprocessed: 1 },
      { cwd: "/tmp", path: "/e", unprocessed: 1 },
    ]);
    const h = harness({ promoteEventsForCwd: promote, collectEventSidecars: scan });
    h.processor.notify({ cwd: "/tmp" });
    promote.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const drain = h.processor.flushOnce();
    await Promise.resolve();
    await h.processor.runSweep();
    expect(h.timers.at(-1)?.ms).toBe(PASSIVE_EVENT_PROCESSOR_DEFAULTS.debounceMs);
    release?.({ promoted: 1, skipped: 0, errors: 0 });
    await drain;
    await h.processor.runSweep();
    expect(promote).toHaveBeenCalledTimes(2);
    expect(h.log).toHaveBeenCalledWith("passive-event-processor", expect.any(Error), { cwd: "/tmp" });
  });

  it("stops a sweep mid-iteration and reschedules queued projects after a sweep", async () => {
    let processor: PassiveEventProcessor;
    const promote = vi.fn().mockImplementation(async () => { processor.stop(); });
    const h = harness({
      promoteEventsForCwd: promote,
      collectEventSidecars: vi.fn().mockReturnValue([
        { cwd: "/tmp", path: "/a", unprocessed: 1 }, { cwd: "/tmp", path: "/b", unprocessed: 1 },
      ]),
    });
    processor = h.processor;
    await processor.runSweep();
    expect(promote).toHaveBeenCalledOnce();

    const queued = harness();
    queued.processor.notify({ cwd: "/tmp" });
    await queued.processor.runSweep();
    expect(queued.timers.some(t => t.ms === PASSIVE_EVENT_PROCESSOR_DEFAULTS.debounceMs)).toBe(true);
  });

  it("replaces later debounce timers and logs rejected callback drains", async () => {
    const h = harness();
    h.processor.notify({ cwd: "/tmp", priority: 3 });
    h.processor.notify({ cwd: "/tmp", priority: 1 });
    expect(h.deps.clearTimeout).toHaveBeenCalledOnce();

    let callback: (() => void) | undefined;
    let timerCalls = 0;
    const failing = harness({
      promoteEventsForCwd: vi.fn().mockResolvedValue({ promoted: 500, skipped: 0, errors: 0 }),
      setTimeout: vi.fn((fn: () => void) => {
        timerCalls++;
        if (timerCalls > 1) throw new Error("timer failed");
        callback = fn;
        return { unref: vi.fn() };
      }),
    });
    failing.processor.notify({ cwd: "/tmp", priority: 1 });
    callback!();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(failing.log).toHaveBeenCalledWith("passive-event-processor", expect.any(Error), { cwd: "/tmp" });
  });

  it("covers project processing terminal outcomes and draining requeue", async () => {
    const noEvents = harness({ promoteEventsForCwd: vi.fn().mockResolvedValue({ promoted: 0, skipped: 0, errors: 0, message: "no unprocessed events" }) });
    noEvents.processor.notify({ cwd: "/tmp" }); await noEvents.processor.flushOnce();

    const zero = harness();
    zero.processor.notify({ cwd: "/tmp" }); await zero.processor.flushOnce();

    const partial = harness({ promoteEventsForCwd: vi.fn().mockResolvedValue({ promoted: 1, skipped: 0, errors: 0 }) });
    partial.processor.notify({ cwd: "/tmp" }); await partial.processor.flushOnce();

    const failed = harness({ promoteEventsForCwd: vi.fn().mockRejectedValue(new Error("failed")) });
    failed.processor.notify({ cwd: "/tmp" }); await failed.processor.flushOnce();
    expect(failed.log).toHaveBeenCalled();

    let stoppedProcessor: PassiveEventProcessor;
    const stopped = harness({ promoteEventsForCwd: vi.fn().mockImplementation(async () => {
      stoppedProcessor.stop();
      return { promoted: 500, skipped: 0, errors: 0 };
    }) });
    stoppedProcessor = stopped.processor;
    stopped.processor.notify({ cwd: "/tmp" }); await stopped.processor.flushOnce();
    await stopped.processor.flushOnce();
    expect(stopped.deps.promoteEventsForCwd).toHaveBeenCalledOnce();

    const draining = harness();
    let release: ((value: unknown) => void) | undefined;
    draining.deps.promoteEventsForCwd.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    draining.processor.notify({ cwd: "/tmp" });
    const first = draining.processor.flushOnce();
    await Promise.resolve();
    draining.processor.notify({ cwd: "/var" });
    await draining.processor.flushOnce();
    expect(draining.timers.length).toBeGreaterThan(1);
    release?.({ promoted: 1, skipped: 0, errors: 0 });
    await first;
  });

  it("normalizes invalid notification values and tolerates absent or throwing unref", () => {
    const h = harness();
    h.processor.notify({ cwd: "/tmp", priority: 1.5, pendingCount: Number.NaN });
    expect(h.timers[0].ms).toBe(PASSIVE_EVENT_PROCESSOR_DEFAULTS.debounceMs);
    h.processor.notify({ cwd: "/var", priority: 4, pendingCount: -1 });
    const nullHandle = harness({ setTimeout: vi.fn(() => null) });
    expect(() => nullHandle.processor.notify({ cwd: "/tmp" })).not.toThrow();
    const throwingHandle = harness({ setTimeout: vi.fn(() => ({ unref: () => { throw new Error("ignored"); } })) });
    expect(() => throwingHandle.processor.notify({ cwd: "/tmp" })).not.toThrow();
  });

  it("handles malformed notify payloads and invalid cwd", async () => {
    const notify = vi.fn(() => { throw new Error("invalid cwd"); });
    const handler = createPromoteEventsNotifyHandler({ notify } as unknown as PassiveEventProcessor);
    for (const body of ["{", "", JSON.stringify({ cwd: 2 }), JSON.stringify({ cwd: "/missing", priority: "1", pendingCount: "2", sourceHook: 3 })]) {
      let data = ""; let status = 0;
      const res = { writeHead: (s: number) => { status = s; }, end: (v: string) => { data = v; } };
      await handler({} as never, res as never, body);
      expect(status).toBe(400);
      expect(JSON.parse(data)).toHaveProperty("error");
    }
  });
});
