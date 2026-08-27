import { describe, expect, it } from "vitest";
import {
  createInvocationCoordinator,
  isCanonicalInvocationId,
  type InvocationCoordinator,
} from "../../src/daemon/invocation-coordinator.js";

const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
const invocationId = "22222222-2222-4222-8222-222222222222";
const secondInvocationId = "33333333-3333-4333-8333-333333333333";

type Timer = { at: number; callback: () => void; active: boolean };

function clockHarness() {
  let now = 0;
  const timers: Timer[] = [];
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter(candidate => candidate.active && candidate.at <= now)) {
        timer.active = false;
        timer.callback();
      }
    },
    timers,
    setTimeout(callback: () => void, delay: number) {
      const timer = { at: now + delay, callback, active: true };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>) {
      (handle as unknown as Timer).active = false;
    },
  };
}

function target(id = invocationId, command = "compact", instance = daemonInstanceId) {
  return { invocationId: id, command, daemonInstanceId: instance } as const;
}

function createHarness(options: Partial<Parameters<typeof createInvocationCoordinator>[0]> = {}) {
  const clock = clockHarness();
  const coordinator = createInvocationCoordinator({
    daemonInstanceId,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...options,
  });
  return { coordinator, clock };
}

describe("invocation coordinator", () => {
  it("validates canonical identifiers and injectable option seams", async () => {
    expect(isCanonicalInvocationId(invocationId)).toBe(true);
    expect(isCanonicalInvocationId("not-a-uuid")).toBe(false);
    expect(() => createInvocationCoordinator({ daemonInstanceId: "bad" })).toThrow(/instance/i);
    expect(() => createInvocationCoordinator({ leaseMs: -1 })).toThrow(/lease/i);
    expect(() => createInvocationCoordinator({ tombstoneTtlMs: Number.NaN })).toThrow(/tombstone/i);
    expect(() => createInvocationCoordinator({ maxTombstones: 1.5 })).toThrow(/integer/i);

    const clock = clockHarness();
    const aliases = createInvocationCoordinator({
      instanceId: daemonInstanceId,
      _now: clock.now,
      _setTimeout: clock.setTimeout,
      _clearTimeout: clock.clearTimeout,
    });
    expect(aliases.daemonInstanceId).toBe(daemonInstanceId);
    await aliases.shutdown();

    const defaults = createInvocationCoordinator();
    const defaultTarget = {
      invocationId: "44444444-4444-4444-8444-444444444444",
      command: "compact",
      daemonInstanceId: defaults.daemonInstanceId,
    } as const;
    expect(defaults.start(defaultTarget).leaseExpiresAt).toBeGreaterThan(Date.now());
    await expect(defaults.finish(defaultTarget)).resolves.toMatchObject({ state: "finished" });
    await defaults.shutdown();
  });

  it("accepts wire-style target aliases and rejects malformed direct inputs", () => {
    const { coordinator } = createHarness();
    const wireTarget = {
      invocation_id: invocationId,
      command: "compact",
      daemon_instance_id: daemonInstanceId,
    } as never;
    expect(coordinator.start(wireTarget)).toMatchObject({ invocationId });
    expect(coordinator.heartbeat(wireTarget)).toMatchObject({ state: "active" });
    expect(() => coordinator.start(null as never)).toThrow(/input/i);
    expect(() => coordinator.start([] as never)).toThrow(/input/i);
    expect(() => coordinator.snapshot("bad")).toThrow(/uuid/i);
    expect(() => coordinator.snapshot("55555555-5555-4555-8555-555555555555")).toThrow(/unknown/i);
  });

  it("starts one compact invocation and rejects malformed, duplicate, and cross-instance operations", () => {
    const { coordinator } = createHarness();
    expect(coordinator.start(target())).toMatchObject({
      invocationId,
      command: "compact",
      daemonInstanceId,
      state: "active",
      activeCount: 0,
    });
    expect(() => coordinator.start(target())).toThrow(/active|replay/i);
    expect(() => coordinator.start(target(secondInvocationId, "promote"))).toThrow(/command/i);
    expect(() => coordinator.start(target(secondInvocationId, "compact", "44444444-4444-4444-8444-444444444444"))).toThrow(/instance/i);
    expect(() => coordinator.start({ ...target(), invocationId: "bad" })).toThrow(/uuid/i);
  });

  it("admits work atomically, latches cancel, and waits only for the targeted invocation", async () => {
    const { coordinator } = createHarness();
    coordinator.start(target());
    coordinator.start(target(secondInvocationId));
    const firstWork = coordinator.admitWork(target());
    const secondWork = coordinator.admitWork(target(secondInvocationId));
    expect(firstWork.signal.aborted).toBe(false);
    expect(coordinator.snapshot(invocationId)).toMatchObject({ activeCount: 1 });
    const cancelling = coordinator.cancel(target());
    expect(firstWork.signal.aborted).toBe(true);
    await Promise.resolve();
    let cancelled = false;
    void cancelling.then(() => { cancelled = true; });
    await Promise.resolve();
    expect(cancelled).toBe(false);
    expect(() => coordinator.admitWork(target())).toThrow(/cancel|finish|admission/i);
    expect(coordinator.snapshot(secondInvocationId)).toMatchObject({ state: "active", activeCount: 1 });
    secondWork.release();
    firstWork.release();
    await expect(cancelling).resolves.toMatchObject({ state: "cancelling", activeCount: 0 });
    expect(coordinator.snapshot(secondInvocationId)).toMatchObject({ state: "active", activeCount: 0 });
  });

  it("allows a pre-cancel commit permit to finish and blocks later permits", async () => {
    const { coordinator } = createHarness();
    coordinator.start(target());
    const permit = coordinator.acquireCommit(target());
    const cancelling = coordinator.cancel(target());
    expect(permit.signal.aborted).toBe(true);
    expect(() => coordinator.acquireCommit(target())).toThrow(/cancel|finish|commit/i);
    let settled = false;
    void cancelling.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    permit.release();
    await expect(cancelling).resolves.toMatchObject({ activeCount: 0 });
    permit.release();
  });

  it("keeps cancellation idempotent after zero and rejects late work", async () => {
    const { coordinator } = createHarness();
    coordinator.start(target());
    await expect(coordinator.cancel(target())).resolves.toMatchObject({
      state: "cancelling",
      activeCount: 0,
    });
    await expect(coordinator.cancel(target())).resolves.toMatchObject({ state: "cancelling" });
    expect(() => coordinator.heartbeat(target())).toThrow(/cancel/i);
    await expect(coordinator.finish(target())).resolves.toMatchObject({ state: "finished" });
    expect(() => coordinator.admitWork(target())).toThrow(/terminal|cancel/i);
    expect(() => coordinator.admitCommit(target())).toThrow(/terminal|cancel/i);
    expect(() => coordinator.admitCommit(target())).toThrow(/terminal|cancel/i);
    await expect(coordinator.cancel(target())).resolves.toMatchObject({ state: "finished" });
    await expect(coordinator.finish(target())).resolves.toMatchObject({ state: "finished" });
    expect(() => coordinator.heartbeat(target())).toThrow(/terminal/i);
  });

  it("waits for active finish permits and releases each permit exactly once", async () => {
    const { coordinator } = createHarness();
    coordinator.start(target());
    const work = coordinator.admitWork(target());
    const commit = coordinator.admitCommit(target());
    const finishing = coordinator.finish(target());
    let settled = false;
    void finishing.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    work.release();
    work.release();
    await Promise.resolve();
    expect(settled).toBe(false);
    commit.release();
    await expect(finishing).resolves.toMatchObject({ state: "finished", activeCount: 0 });
    commit.release();
  });

  it("finishes into a bounded tombstone and rejects replay until reaped", async () => {
    const { coordinator, clock } = createHarness();
    coordinator.start(target());
    await expect(coordinator.finish(target())).resolves.toMatchObject({ state: "finished", activeCount: 0 });
    expect(() => coordinator.start(target())).toThrow(/tombstone|replay/i);
    clock.advance(60_001);
    expect(() => coordinator.start(target())).not.toThrow();
  });

  it("expires leases through cancellation and bounds terminal tombstones", async () => {
    const { coordinator, clock } = createHarness({ maxTombstones: 2 });
    coordinator.start(target());
    coordinator.start(target(secondInvocationId));
    const third = "44444444-4444-4444-8444-444444444444";
    coordinator.start(target(third));
    clock.advance(30_001);
    expect(() => coordinator.snapshot(invocationId)).toThrow(/unknown|tombstone/i);
    expect(coordinator.snapshot(secondInvocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
    await expect(coordinator.finish(target(secondInvocationId))).resolves.toMatchObject({ state: "cancelled" });
    await expect(coordinator.finish(target(third))).resolves.toMatchObject({ state: "cancelled" });
    expect(coordinator.tombstoneCount()).toBeLessThanOrEqual(2);
  });

  it("reaps only expired tombstones and ignores stale lease callbacks", async () => {
    const { coordinator, clock } = createHarness({ tombstoneTtlMs: 10 });
    coordinator.start(target());
    const leaseTimer = clock.timers.find(timer => timer.active)!;
    await expect(coordinator.finish(target())).resolves.toMatchObject({ state: "finished" });
    leaseTimer.callback();
    expect(coordinator.tombstoneCount()).toBe(1);
    const reaperTimer = clock.timers.find(timer => timer.active)!;
    reaperTimer.callback();
    expect(coordinator.tombstoneCount()).toBe(1);
    const early = "55555555-5555-4555-8555-555555555555";
    coordinator.start(target(early));
    const earlyLeaseTimer = clock.timers.find(timer => timer.active && timer.at === 30_000)!;
    earlyLeaseTimer.callback();
    expect(coordinator.snapshot(early)).toMatchObject({ state: "active" });
    await expect(coordinator.finish(target(early))).resolves.toMatchObject({ state: "finished" });
    clock.advance(11);
    expect(() => coordinator.snapshot(invocationId)).toThrow(/unknown/i);
  });

  it("clears a pending reaper while draining shutdown", async () => {
    const { coordinator } = createHarness({ tombstoneTtlMs: 100_000 });
    coordinator.start(target());
    await expect(coordinator.finish(target())).resolves.toMatchObject({ state: "finished" });
    coordinator.start(target(secondInvocationId));
    const work = coordinator.admitWork(target(secondInvocationId));
    const stopping = coordinator.shutdown();
    work.release();
    await expect(stopping).resolves.toBeUndefined();
  });

  it("drains without a reaper when terminal tombstones are disabled", async () => {
    const { coordinator } = createHarness({ maxTombstones: 0 });
    coordinator.start(target());
    const work = coordinator.admitWork(target());
    const stopping = coordinator.shutdown();
    work.release();
    await expect(stopping).resolves.toBeUndefined();
  });

  it("shuts down all records and rejects later starts", async () => {
    const { coordinator } = createHarness();
    coordinator.start(target());
    coordinator.start(target(secondInvocationId));
    const first = coordinator.admitWork(target());
    const second = coordinator.admitWork(target(secondInvocationId));
    const stopping = coordinator.shutdown();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    let settled = false;
    void stopping.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    first.release();
    second.release();
    await expect(stopping).resolves.toBeUndefined();
    await expect(coordinator.shutdown()).resolves.toBeUndefined();
    expect(() => coordinator.start(target("55555555-5555-4555-8555-555555555555"))).toThrow(/shutdown/i);
  });

  it("renews only a matching active lease", () => {
    const { coordinator, clock } = createHarness();
    coordinator.start(target());
    expect(coordinator.heartbeat(target())).toMatchObject({ state: "active" });
    clock.advance(29_000);
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "active" });
    expect(() => coordinator.heartbeat(target(secondInvocationId))).toThrow();
    expect(() => coordinator.heartbeat({ ...target(), command: "promote" })).toThrow();
  });
});

void (undefined as unknown as InvocationCoordinator);
