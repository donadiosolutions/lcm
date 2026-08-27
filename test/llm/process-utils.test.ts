import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __processUtilsTestUtils,
  createOwnedProcessTeardown,
  createProviderProcessWitnessStore,
  readProviderProcessWitnesses,
} from "../../src/llm/process-utils.js";
import { PrivateMutationLockContentionError, withPrivateMutationLock } from "../../src/private-mutation-lock.js";

type Child = EventEmitter & {
  pid?: number;
  kill: ReturnType<typeof vi.fn>;
};

function child(pid?: number): Child {
  const value = new EventEmitter() as Child;
  value.pid = pid;
  value.kill = vi.fn();
  return value;
}

describe("owned process lifecycle utilities", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("uses the direct child when the pid/group identity is not safe", async () => {
    const processChild = child(0);
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "win32",
      daemonProcessGroupId: 99,
    });
    expect(teardown.groupValidated).toBe(false);
    const pending = teardown.terminate();
    processChild.emit("close");
    await expect(pending).resolves.toBe(true);
    expect(processChild.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(teardown.terminate()).resolves.toBe(true);
    expect(processChild.kill).toHaveBeenCalledTimes(1);
  });

  it("keeps timeout compatibility for a child without a numeric pid", async () => {
    const processChild = child();
    const teardown = createOwnedProcessTeardown({ child: processChild, platform: "linux" });
    await expect(teardown.terminate("timeout")).resolves.toBe(false);
    expect(processChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("waits for an already-closed direct child without retaining a timer", async () => {
    const processChild = child();
    const teardown = createOwnedProcessTeardown({ child: processChild, platform: "win32" });
    processChild.emit("close");
    await expect(teardown.waitForSettlement()).resolves.toBe(true);
  });

  it("ignores a late polling callback after settlement", async () => {
    const processChild = child(7012);
    const timers: Array<() => void> = [];
    const setTimeoutMock = vi.fn((callback: () => void) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearTimeoutMock = vi.fn() as unknown as typeof clearTimeout;
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      processGroupId: 7012,
      daemonProcessGroupId: 7011,
      processBirthTime: () => "birth-7012",
      isProcessGroupAlive: () => false,
      setTimeout: setTimeoutMock,
      clearTimeout: clearTimeoutMock,
      killProcess: vi.fn(),
    });
    const pending = teardown.terminate();
    processChild.emit("close");
    await expect(pending).resolves.toBe(true);
    timers.at(-1)?.();
    expect(clearTimeoutMock).toHaveBeenCalled();
  });

  it("signals a validated owned group and waits for child close", async () => {
    const processChild = child(4312);
    const killProcess = vi.fn();
    const isProcessGroupAlive = vi.fn(() => false);
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      processGroupId: 4312,
      daemonProcessGroupId: 4311,
      processBirthTime: () => "birth-4312",
      killProcess,
      isProcessGroupAlive,
    });
    const pending = teardown.terminate();
    expect(killProcess).toHaveBeenCalledWith(-4312, "SIGTERM");
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    processChild.emit("close");
    await expect(pending).resolves.toBe(true);
    expect(isProcessGroupAlive).toHaveBeenCalledWith(4312);
  });

  it("revalidates process birth and group identity before escalation", async () => {
    vi.useFakeTimers();
    try {
      const processChild = child(7412);
      let birth = "birth-1";
      let groupAlive = true;
      const killProcess = vi.fn();
      const teardown = createOwnedProcessTeardown({
        child: processChild,
        platform: "linux",
        processGroupId: 7412,
        daemonProcessGroupId: 7411,
        processBirthTime: () => birth,
        killProcess,
        isProcessGroupAlive: () => groupAlive,
      });

      const pending = teardown.terminate();
      expect(killProcess).toHaveBeenCalledWith(-7412, "SIGTERM");
      birth = "birth-reused";
      await vi.advanceTimersByTimeAsync(2_000);
      expect(killProcess).not.toHaveBeenCalledWith(-7412, "SIGKILL");

      processChild.emit("close");
      groupAlive = false;
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clean a live group after child reaping without current identity", async () => {
    vi.useFakeTimers();
    try {
      const processChild = child(7462);
      let birth: string | null = "birth-7462";
      let groupAlive = true;
      const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === "SIGKILL") groupAlive = false;
      });
      const teardown = createOwnedProcessTeardown({
        child: processChild,
        platform: "linux",
        processGroupId: 7462,
        daemonProcessGroupId: 7461,
        processBirthTime: () => birth,
        killProcess,
        isProcessGroupAlive: () => groupAlive,
      });
      processChild.emit("close");
      birth = null;
      const pending = teardown.terminate("close");
      expect(killProcess).not.toHaveBeenCalledWith(-7462, expect.anything());
      groupAlive = false;
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never signals a live group after child close when birth identity is unavailable", async () => {
    vi.useFakeTimers();
    try {
      const processChild = child(7472);
      let birth: string | null = "birth-7472";
      let groupAlive = true;
      const killProcess = vi.fn();
      const teardown = createOwnedProcessTeardown({
        child: processChild,
        platform: "linux",
        processGroupId: 7472,
        daemonProcessGroupId: 7471,
        processBirthTime: () => birth,
        processGroupIdProbe: () => 7472,
        killProcess,
        isProcessGroupAlive: () => groupAlive,
      });

      processChild.emit("close");
      birth = null;
      const pending = teardown.terminate("close");
      expect(killProcess).not.toHaveBeenCalledWith(-7472, expect.anything());
      groupAlive = false;
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never signals a live group after child close when its PGID changes", async () => {
    vi.useFakeTimers();
    try {
      const processChild = child(7482);
      let observedGroup = 7482;
      let groupAlive = true;
      const killProcess = vi.fn();
      const teardown = createOwnedProcessTeardown({
        child: processChild,
        platform: "linux",
        processGroupId: 7482,
        daemonProcessGroupId: 7481,
        processBirthTime: () => "birth-7482",
        processGroupIdProbe: () => observedGroup,
        killProcess,
        isProcessGroupAlive: () => groupAlive,
      });

      processChild.emit("close");
      observedGroup = 9999;
      const pending = teardown.terminate("close");
      expect(killProcess).not.toHaveBeenCalledWith(-7482, expect.anything());
      groupAlive = false;
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never signals a live group after child close without a current PGID probe", async () => {
    vi.useFakeTimers();
    try {
      const processChild = child(7492);
      let groupAlive = true;
      const killProcess = vi.fn();
      const teardown = createOwnedProcessTeardown({
        child: processChild,
        platform: "linux",
        processGroupId: 7492,
        daemonProcessGroupId: 7491,
        processBirthTime: () => "birth-7492",
        killProcess,
        isProcessGroupAlive: () => groupAlive,
      });

      processChild.emit("close");
      const pending = teardown.terminate("close");
      expect(killProcess).not.toHaveBeenCalledWith(-7492, expect.anything());
      groupAlive = false;
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("latches group disappearance before a later PGID reuse", async () => {
    const processChild = child(7512);
    let groupAlive = false;
    const killProcess = vi.fn();
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      processGroupId: 7512,
      daemonProcessGroupId: 7511,
      processBirthTime: () => "birth-7512",
      killProcess,
      isProcessGroupAlive: () => groupAlive,
    });

    processChild.emit("close");
    await expect(teardown.waitForSettlement()).resolves.toBe(true);
    groupAlive = true;
    await expect(teardown.terminate()).resolves.toBe(true);
    expect(killProcess).not.toHaveBeenCalledWith(-7512, expect.anything());
  });

  it("does not escalate a group after it disappears before child close", async () => {
    vi.useFakeTimers();
    try {
      const processChild = child(7612);
      let groupAlive = true;
      const killProcess = vi.fn();
      const teardown = createOwnedProcessTeardown({
        child: processChild,
        platform: "linux",
        processGroupId: 7612,
        daemonProcessGroupId: 7611,
        processBirthTime: () => "birth-7612",
        killProcess,
        isProcessGroupAlive: () => groupAlive,
      });
      const pending = teardown.terminate();
      groupAlive = false;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(killProcess).not.toHaveBeenCalledWith(-7612, "SIGKILL");
      processChild.emit("close");
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the child when an active birth witness disappears", async () => {
    const processChild = child(7712);
    let probeCalls = 0;
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      processGroupId: 7712,
      daemonProcessGroupId: 7711,
      processBirthTime: () => {
        probeCalls += 1;
        if (probeCalls === 1) return "birth-7712";
        throw new Error("birth probe unavailable");
      },
      isProcessGroupAlive: () => false,
    });
    const pending = teardown.terminate();
    processChild.emit("close");
    await expect(pending).resolves.toBe(true);
    expect(processChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails closed after identity invalidation", async () => {
    vi.useFakeTimers();
    try {
      const processChild = child(7992);
      let birth: string | null = "birth-7992";
      let groupAlive = true;
      const killProcess = vi.fn();
      const teardown = createOwnedProcessTeardown({
        child: processChild,
        platform: "linux",
        processGroupId: 7992,
        daemonProcessGroupId: 7991,
        processBirthTime: () => {
          const observed = birth;
          birth = null;
          return observed;
        },
        killProcess,
        isProcessGroupAlive: () => groupAlive,
      });

      const pending = teardown.terminate();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(killProcess).not.toHaveBeenCalled();
      expect(processChild.kill).toHaveBeenCalledWith("SIGTERM");
      groupAlive = false;
      processChild.emit("close");
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses and clears settlement timers while ignoring stale polls", async () => {
    const processChild = child(7995);
    let groupAlive = true;
    const timers: Array<() => void> = [];
    const setTimeoutMock = vi.fn((callback: () => void) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearTimeoutMock = vi.fn() as unknown as typeof clearTimeout;
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      processGroupId: 7995,
      daemonProcessGroupId: 7991,
      processBirthTime: () => "birth-7995",
      isProcessGroupAlive: () => groupAlive,
      setTimeout: setTimeoutMock,
      clearTimeout: clearTimeoutMock,
      killProcess: vi.fn(),
    });
    const pending = teardown.terminate();
    const duplicateWait = teardown.waitForSettlement();
    expect(duplicateWait).toBeInstanceOf(Promise);
    // Close while the group is still alive, then let the poll observe its
    // disappearance; this settles after the poll timer has cleared itself.
    processChild.emit("close");
    timers[0]?.();
    groupAlive = false;
    timers[2]?.();
    await expect(pending).resolves.toBe(true);
    timers[0]?.();
    expect(clearTimeoutMock).toHaveBeenCalled();
  });

  it("clears an active deadline timer when the child settles", async () => {
    const processChild = child(7996);
    const timers: Array<() => void> = [];
    const setTimeoutMock = vi.fn((callback: () => void) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearTimeoutMock = vi.fn() as unknown as typeof clearTimeout;
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      processGroupId: 7996,
      daemonProcessGroupId: 7991,
      processBirthTime: () => "birth-7996",
      isProcessGroupAlive: () => false,
      setTimeout: setTimeoutMock,
      clearTimeout: clearTimeoutMock,
      killProcess: vi.fn(),
    });
    const pending = teardown.terminate();
    // The first callback is the poll; the second is the deadline.
    expect(timers.length).toBe(2);
    processChild.emit("close");
    await expect(pending).resolves.toBe(true);
    expect(clearTimeoutMock).toHaveBeenCalledTimes(2);
    timers[1]?.();
  });

  it("settles a plain wait without a deadline timer", async () => {
    const processChild = child(7997);
    let groupAlive = true;
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      processGroupId: 7997,
      daemonProcessGroupId: 7991,
      processBirthTime: () => "birth-7997",
      isProcessGroupAlive: () => groupAlive,
    });
    const pending = teardown.waitForSettlement();
    processChild.emit("close");
    groupAlive = false;
    await expect(pending).resolves.toBe(true);
  });

  it("uses direct-child cleanup on non-Linux hosts without group witnesses", async () => {
    const childWithoutGroup = child(7993);
    const direct = createOwnedProcessTeardown({
      child: childWithoutGroup,
      platform: "darwin",
      processBirthTime: () => "birth-7993",
    });
    expect(direct.groupValidated).toBe(false);
    const directPending = direct.terminate();
    childWithoutGroup.emit("close");
    await expect(directPending).resolves.toBe(true);

    const groupWithoutDaemonWitness = child(7994);
    const fallback = createOwnedProcessTeardown({
      child: groupWithoutDaemonWitness,
      platform: "darwin",
      processGroupId: 7994,
      processBirthTime: () => "birth-7994",
    });
    expect(fallback.groupValidated).toBe(false);
    const fallbackPending = fallback.terminate();
    groupWithoutDaemonWitness.emit("close");
    await expect(fallbackPending).resolves.toBe(true);
  });

  it("disables group signaling when birth capture fails", async () => {
    const processChild = child(7762);
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      processGroupId: 7762,
      daemonProcessGroupId: 7761,
      processBirthTime: () => { throw new Error("birth capture failed"); },
    });
    expect(teardown.groupValidated).toBe(false);
    const pending = teardown.terminate();
    processChild.emit("close");
    await expect(pending).resolves.toBe(true);
  });

  it("falls back to the child when a live birth witness becomes unavailable", async () => {
    const processChild = child(7862);
    let probeCalls = 0;
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      processGroupId: 7862,
      daemonProcessGroupId: 7861,
      processBirthTime: () => {
        probeCalls += 1;
        return probeCalls === 1 ? "birth-7862" : null;
      },
      isProcessGroupAlive: () => false,
    });
    const pending = teardown.terminate();
    processChild.emit("close");
    await expect(pending).resolves.toBe(true);
    expect(processChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back to the child when the current process group changes", async () => {
    const processChild = child(7812);
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      processGroupId: 7812,
      daemonProcessGroupId: 7811,
      processBirthTime: () => "birth-7812",
      processGroupIdProbe: () => 9000,
      isProcessGroupAlive: () => false,
    });
    const pending = teardown.terminate();
    processChild.emit("close");
    await expect(pending).resolves.toBe(true);
    expect(processChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back to the child when the current process group probe throws", async () => {
    const processChild = child(7912);
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      processGroupId: 7912,
      daemonProcessGroupId: 7911,
      processBirthTime: () => "birth-7912",
      processGroupIdProbe: () => { throw new Error("group probe unavailable"); },
      isProcessGroupAlive: () => false,
    });
    const pending = teardown.terminate();
    processChild.emit("close");
    await expect(pending).resolves.toBe(true);
    expect(processChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates to SIGKILL after the two-second TERM grace", async () => {
    vi.useFakeTimers();
    const processChild = child(7312);
    let alive = true;
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") alive = false;
    });
    const teardown = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
        processGroupId: 7312,
        daemonProcessGroupId: 7311,
        processBirthTime: () => "birth-7312",
      killProcess,
      isProcessGroupAlive: () => alive,
    });
    const pending = teardown.terminate();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(killProcess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(killProcess).toHaveBeenNthCalledWith(2, -7312, "SIGKILL");
    processChild.emit("close");
    await expect(pending).resolves.toBe(true);
  });

  it("falls back to a direct child when the group is the daemon group or signaling fails", async () => {
    const sameGroupChild = child(8123);
    const sameGroup = createOwnedProcessTeardown({
      child: sameGroupChild,
      platform: "linux",
      processGroupId: 8123,
      daemonProcessGroupId: 8123,
      killProcess: vi.fn(),
    });
    const samePending = sameGroup.terminate();
    sameGroupChild.emit("close");
    await expect(samePending).resolves.toBe(true);
    expect(sameGroupChild.kill).toHaveBeenCalledWith("SIGTERM");

    const failedGroupChild = child(8124);
    const killProcess = vi.fn(() => { throw new Error("unsupported"); });
    const failedGroup = createOwnedProcessTeardown({
      child: failedGroupChild,
      platform: "linux",
      processGroupId: 8124,
      daemonProcessGroupId: 8123,
      processBirthTime: () => "birth-8124",
      killProcess,
    });
    const failedPending = failedGroup.terminate();
    failedGroupChild.emit("close");
    await expect(failedPending).resolves.toBe(true);
    expect(failedGroupChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("handles invalid process identities, probes, and signaling failures safely", async () => {
    expect(__processUtilsTestUtils.positivePid(-1)).toBeUndefined();
    expect(__processUtilsTestUtils.positivePid(Number.NaN)).toBeUndefined();
    expect(__processUtilsTestUtils.linuxProcessGroupId(process.pid)).toBeGreaterThan(0);
    expect(__processUtilsTestUtils.linuxProcessGroupId(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(typeof __processUtilsTestUtils.defaultProcessGroupAlive(Number.MAX_SAFE_INTEGER)).toBe("boolean");

    const invalidGroupChild = child(9123);
    const invalidGroup = createOwnedProcessTeardown({
      child: invalidGroupChild,
      platform: "linux",
      processGroupId: 0,
      daemonProcessGroupId: 1,
    });
    const invalidPending = invalidGroup.terminate();
    invalidGroupChild.emit("close");
    await expect(invalidPending).resolves.toBe(true);

    const throwingChild = child(9124);
    throwingChild.kill.mockImplementation(() => { throw new Error("already gone"); });
    const throwingGroup = createOwnedProcessTeardown({
      child: throwingChild,
      platform: "win32",
    });
    const throwingPending = throwingGroup.terminate();
    throwingChild.emit("close");
    await expect(throwingPending).resolves.toBe(true);

    let probes = 0;
    const probingChild = child(9125);
    const probingGroup = createOwnedProcessTeardown({
      child: probingChild,
      platform: "linux",
      processGroupId: 9125,
      daemonProcessGroupId: 1,
      processBirthTime: () => "birth-9125",
      isProcessGroupAlive: () => {
        probes += 1;
        if (probes === 1) throw new Error("probe unavailable");
        return false;
      },
    });
    const probingPending = probingGroup.terminate();
    probingChild.emit("close");
    await expect(probingPending).resolves.toBe(true);
  });

  it("derives Linux group state conservatively when explicit identities are omitted", async () => {
    const processChild = child(process.pid);
    const derived = createOwnedProcessTeardown({
      child: processChild,
      platform: "linux",
      isProcessGroupAlive: () => false,
    });
    expect(derived.groupValidated).toBe(false);
    const pending = derived.terminate();
    processChild.emit("close");
    await expect(pending).resolves.toBe(true);
  });

  it("persists only provider identity in an owner-only witness and removes it at zero", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const store = createProviderProcessWitnessStore({ daemonInstanceId: "daemon-a", path });
    const entry = {
      daemonInstanceId: "daemon-a",
      providerId: "claude-process",
      pid: 1234,
      pgid: 1234,
      processStartTime: "9876",
    } as const;
    store.add(entry);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const content = readFileSync(path, "utf8");
    expect(JSON.parse(content)).toEqual({ version: 1, daemonInstanceId: "daemon-a", providers: [entry] });
    expect(content).not.toMatch(/prompt|output|auth|token|url/i);
    store.add(entry);
    expect(JSON.parse(readFileSync(path, "utf8")).providers).toHaveLength(1);
    store.remove(entry);
    expect(() => readFileSync(path)).toThrow();
  });

  it("reads a provider witness snapshot for old-instance disappearance proof", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-read-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const store = createProviderProcessWitnessStore({ daemonInstanceId: "daemon-a", path });
    const entry = {
      daemonInstanceId: "daemon-a",
      providerId: "claude-process",
      pid: 1234,
      pgid: 1234,
      processStartTime: "9876",
    } as const;
    store.add(entry);
    expect(readProviderProcessWitnesses({ path })).toMatchObject({
      available: true,
      providers: [entry],
    });
    expect(readProviderProcessWitnesses({ path, daemonInstanceId: "daemon-b" })).toMatchObject({
      available: true,
      providers: [],
    });
    store.remove(entry);
    expect(readProviderProcessWitnesses({ path })).toMatchObject({ available: false, providers: [] });
    writeFileSync(path, "not-json", { mode: 0o600 });
    expect(readProviderProcessWitnesses({ path })).toMatchObject({ available: false, providers: [] });
  });

  it("treats a missing provider witness as unavailable proof", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-missing-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");

    expect(readProviderProcessWitnesses({ path })).toEqual({
      available: false,
      providers: [],
    });
  });

  it.each([
    ["symlink", (root: string, path: string) => {
      const target = join(root, "target.json");
      writeFileSync(target, JSON.stringify({ version: 1, daemonInstanceId: "daemon-a", providers: [] }), { mode: 0o600 });
      const linkTarget = join(root, "link-target.json");
      renameSync(target, linkTarget);
      symlinkSync(linkTarget, path);
    }],
    ["world-readable mode", (_root: string, path: string) => {
      writeFileSync(path, JSON.stringify({ version: 1, daemonInstanceId: "daemon-a", providers: [] }), { mode: 0o644 });
      chmodSync(path, 0o644);
    }],
    ["unsupported version", (_root: string, path: string) => {
      writeFileSync(path, JSON.stringify({ version: 2, daemonInstanceId: "daemon-a", providers: [] }), { mode: 0o600 });
    }],
  ])("fails closed for an unsafe witness (%s)", (_label, setup) => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-unsafe-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    setup(root, path);
    expect(readProviderProcessWitnesses({ path })).toEqual({
      available: false,
      providers: [],
    });
  });

  it.each([
    ["top-level null", null],
    ["top-level array", []],
    ["missing top-level key", { version: 1, daemonInstanceId: "daemon-a" }],
    ["non-array providers", { version: 1, daemonInstanceId: "daemon-a", providers: "invalid" }],
    ["empty top-level identity", { version: 1, daemonInstanceId: "", providers: [] }],
    ["null provider entry", { version: 1, daemonInstanceId: "daemon-a", providers: [null] }],
    ["array provider entry", { version: 1, daemonInstanceId: "daemon-a", providers: [[]] }],
    ["extra provider field", {
      version: 1,
      daemonInstanceId: "daemon-a",
      providers: [{ daemonInstanceId: "daemon-a", providerId: "claude-process", pid: 1, pgid: null, processStartTime: null, extra: true }],
    }],
    ["empty provider identity", {
      version: 1,
      daemonInstanceId: "daemon-a",
      providers: [{ daemonInstanceId: "", providerId: "claude-process", pid: 1, pgid: null, processStartTime: null }],
    }],
    ["non-string provider identity", {
      version: 1,
      daemonInstanceId: "daemon-a",
      providers: [{ daemonInstanceId: 1, providerId: "claude-process", pid: 1, pgid: null, processStartTime: null }],
    }],
    ["empty provider id", {
      version: 1,
      daemonInstanceId: "daemon-a",
      providers: [{ daemonInstanceId: "daemon-a", providerId: "", pid: 1, pgid: null, processStartTime: null }],
    }],
    ["non-string provider id", {
      version: 1,
      daemonInstanceId: "daemon-a",
      providers: [{ daemonInstanceId: "daemon-a", providerId: 1, pid: 1, pgid: null, processStartTime: null }],
    }],
    ["invalid pid", {
      version: 1,
      daemonInstanceId: "daemon-a",
      providers: [{ daemonInstanceId: "daemon-a", providerId: "claude-process", pid: 0, pgid: null, processStartTime: null }],
    }],
    ["invalid pgid", {
      version: 1,
      daemonInstanceId: "daemon-a",
      providers: [{ daemonInstanceId: "daemon-a", providerId: "claude-process", pid: 1, pgid: 0, processStartTime: null }],
    }],
    ["non-string process birth", {
      version: 1,
      daemonInstanceId: "daemon-a",
      providers: [{ daemonInstanceId: "daemon-a", providerId: "claude-process", pid: 1, pgid: null, processStartTime: 1 }],
    }],
    ["empty process birth", {
      version: 1,
      daemonInstanceId: "daemon-a",
      providers: [{ daemonInstanceId: "daemon-a", providerId: "claude-process", pid: 1, pgid: null, processStartTime: "" }],
    }],
  ])("rejects malformed witness document (%s)", (_label, value) => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-malformed-document-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    expect(readProviderProcessWitnesses({ path })).toEqual({ available: false, providers: [] });
  });

  it("rejects duplicate provider identities in a witness snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-duplicate-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const entry = {
      daemonInstanceId: "daemon-a",
      providerId: "claude-process",
      pid: 19,
      pgid: null,
      processStartTime: null,
    };
    writeFileSync(path, JSON.stringify({ version: 1, daemonInstanceId: "daemon-a", providers: [entry, entry] }), { mode: 0o600 });
    expect(readProviderProcessWitnesses({ path })).toEqual({ available: false, providers: [] });
  });

  it("retains another daemon witness while removing only the matching entry", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const first = createProviderProcessWitnessStore({ daemonInstanceId: "daemon-a", path });
    const second = createProviderProcessWitnessStore({ daemonInstanceId: "daemon-b", path });
    const entryA = {
      daemonInstanceId: "daemon-a",
      providerId: "codex-process",
      pid: 12,
      pgid: null,
      processStartTime: null,
    } as const;
    const entryB = {
      daemonInstanceId: "daemon-b",
      providerId: "claude-process",
      pid: 13,
      pgid: 13,
      processStartTime: "1",
    } as const;
    first.add(entryA);
    second.add(entryB);
    first.remove(entryA);
    expect(JSON.parse(readFileSync(path, "utf8")).providers).toEqual([entryB]);
    chmodSync(path, 0o600);
  });

  it("serializes daemon updates and uses unique temporary witness paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-concurrent-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const temporaryPaths: string[] = [];
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    const write = (target: Parameters<typeof writeFileSync>[0], ...args: Parameters<typeof writeFileSync> extends [unknown, ...infer Rest] ? Rest : never): void => {
      temporaryPaths.push(String(target));
      writeFileSync(target, ...args as Parameters<typeof writeFileSync> extends [unknown, ...infer Rest] ? Rest : never);
    };
    const first = createProviderProcessWitnessStore({
      daemonInstanceId: "daemon-a",
      path,
      operations: { writeFileSync: write as typeof writeFileSync },
    });
    const second = createProviderProcessWitnessStore({
      daemonInstanceId: "daemon-b",
      path,
      operations: { writeFileSync: write as typeof writeFileSync },
    });
    const entryA = {
      daemonInstanceId: "daemon-a",
      providerId: "claude-process",
      pid: 121,
      pgid: null,
      processStartTime: null,
    } as const;
    const entryB = {
      daemonInstanceId: "daemon-b",
      providerId: "codex-process",
      pid: 122,
      pgid: null,
      processStartTime: null,
    } as const;

    try {
      await Promise.all([first.add(entryA), second.add(entryB)]);
      expect(JSON.parse(readFileSync(path, "utf8")).providers).toEqual([entryA, entryB]);
      expect(new Set(temporaryPaths).size).toBe(2);
      await Promise.all([first.remove(entryA), second.remove(entryB)]);
      expect(() => readFileSync(path)).toThrow();
    } finally {
      now.mockRestore();
    }
  });

  it("drains a reentrant witness update after the outer atomic write", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-reentrant-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const entryA = {
      daemonInstanceId: "daemon-a",
      providerId: "claude-process",
      pid: 131,
      pgid: null,
      processStartTime: null,
    } as const;
    const entryB = {
      daemonInstanceId: "daemon-a",
      providerId: "codex-process",
      pid: 132,
      pgid: null,
      processStartTime: null,
    } as const;
    let store: ReturnType<typeof createProviderProcessWitnessStore>;
    let queued = false;
    const write = (target: Parameters<typeof writeFileSync>[0], ...args: Parameters<typeof writeFileSync> extends [unknown, ...infer Rest] ? Rest : never): void => {
      if (!queued) {
        queued = true;
        store.add(entryB);
      }
      writeFileSync(target, ...args as Parameters<typeof writeFileSync> extends [unknown, ...infer Rest] ? Rest : never);
    };
    store = createProviderProcessWitnessStore({
      daemonInstanceId: "daemon-a",
      path,
      operations: { writeFileSync: write as typeof writeFileSync },
    });
    store.add(entryA);
    expect(JSON.parse(readFileSync(path, "utf8")).providers).toEqual([entryA, entryB]);
  });

  it("preserves an outer witness write error over a queued update error", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-queue-error-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const error = new Error("witness rename failed");
    const entryA = {
      daemonInstanceId: "daemon-a",
      providerId: "claude-process",
      pid: 133,
      pgid: null,
      processStartTime: null,
    } as const;
    const entryB = {
      daemonInstanceId: "daemon-a",
      providerId: "codex-process",
      pid: 134,
      pgid: null,
      processStartTime: null,
    } as const;
    let store: ReturnType<typeof createProviderProcessWitnessStore>;
    let queued = false;
    const rename = vi.fn(() => { throw error; });
    const write = (target: Parameters<typeof writeFileSync>[0], ...args: Parameters<typeof writeFileSync> extends [unknown, ...infer Rest] ? Rest : never): void => {
      if (!queued) {
        queued = true;
        store.add(entryB);
      }
      writeFileSync(target, ...args as Parameters<typeof writeFileSync> extends [unknown, ...infer Rest] ? Rest : never);
    };
    store = createProviderProcessWitnessStore({
      daemonInstanceId: "daemon-a",
      path,
      operations: {
        writeFileSync: write as typeof writeFileSync,
        renameSync: rename,
      },
    });
    expect(() => store.add(entryA)).toThrow(error);
    expect(rename).toHaveBeenCalled();
  });

  it("surfaces a queued witness error when the outer write succeeds", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-queue-error-2-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const error = new Error("queued witness rename failed");
    const entryA = {
      daemonInstanceId: "daemon-a",
      providerId: "claude-process",
      pid: 135,
      pgid: null,
      processStartTime: null,
    } as const;
    const entryB = {
      daemonInstanceId: "daemon-a",
      providerId: "codex-process",
      pid: 136,
      pgid: null,
      processStartTime: null,
    } as const;
    let store: ReturnType<typeof createProviderProcessWitnessStore>;
    let queued = false;
    let renames = 0;
    const write = (target: Parameters<typeof writeFileSync>[0], ...args: Parameters<typeof writeFileSync> extends [unknown, ...infer Rest] ? Rest : never): void => {
      if (!queued) {
        queued = true;
        store.add(entryB);
      }
      writeFileSync(target, ...args as Parameters<typeof writeFileSync> extends [unknown, ...infer Rest] ? Rest : never);
    };
    const rename = vi.fn((...args: Parameters<typeof import("node:fs").renameSync>) => {
      renames += 1;
      if (renames === 2) throw error;
      return renameSync(...args);
    });
    store = createProviderProcessWitnessStore({
      daemonInstanceId: "daemon-a",
      path,
      operations: {
        writeFileSync: write as typeof writeFileSync,
        renameSync: rename,
      },
    });
    expect(() => store.add(entryA)).toThrow(error);
  });

  it("preserves the original witness publication failure and tolerates missing cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-failure-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const entry = {
      daemonInstanceId: "daemon-a",
      providerId: "claude-process",
      pid: 14,
      pgid: null,
      processStartTime: null,
    } as const;
    const renameError = new Error("rename failed");
    const store = createProviderProcessWitnessStore({
      daemonInstanceId: "daemon-a",
      path,
      operations: {
        renameSync: () => { throw renameError; },
      },
    });
    expect(() => store.add(entry)).toThrow(renameError);

    const cleanupErrorStore = createProviderProcessWitnessStore({
      daemonInstanceId: "daemon-a",
      path,
      operations: {
        renameSync: () => { throw renameError; },
        unlinkSync: () => { throw new Error("unlink failed"); },
      },
    });
    expect(() => cleanupErrorStore.add(entry)).toThrow(renameError);
  });

  it("ignores malformed witness input and tolerates an already-removed file", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-malformed-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const entry = {
      daemonInstanceId: "daemon-a",
      providerId: "claude-process",
      pid: 15,
      pgid: null,
      processStartTime: null,
    } as const;
    const store = createProviderProcessWitnessStore({ daemonInstanceId: "daemon-a", path });
    const malformed = JSON.stringify({ version: 1, daemonInstanceId: "daemon-a", providers: [null, {}, { pid: 0 }] });
    writeFileSync(path, malformed, { mode: 0o600 });
    store.remove(entry);
    store.add(entry);
    store.remove(entry);
    store.remove(entry);
    expect(() => readFileSync(path)).toThrow();
  });

  it("handles missing or unsupported witness files without inventing entries", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-empty-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const store = createProviderProcessWitnessStore({ daemonInstanceId: "daemon-a", path });
    const entry = {
      daemonInstanceId: "daemon-a",
      providerId: "codex-process",
      pid: 16,
      pgid: null,
      processStartTime: null,
    } as const;
    store.remove(entry);
    writeFileSync(path, JSON.stringify(null), { mode: 0o600 });
    store.remove(entry);
    writeFileSync(path, JSON.stringify({ providers: "invalid" }), { mode: 0o600 });
    store.remove(entry);
  });

  it("uses the canonical default witness path when no path override is supplied", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-default-"));
    roots.push(root);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      mkdirSync(join(root, ".lcm"), { recursive: true, mode: 0o700 });
      const store = createProviderProcessWitnessStore({ daemonInstanceId: "daemon-default" });
      const entry = {
        daemonInstanceId: "daemon-default",
        providerId: "claude-process",
        pid: 17,
        pgid: null,
        processStartTime: null,
      } as const;
      store.add(entry);
      expect(store.path).toContain("daemon-runtime.json");
      const originalGetuid = process.getuid;
      Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
      try {
        expect(readProviderProcessWitnesses()).toMatchObject({ available: true, providers: [entry] });
      } finally {
        Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
      }
      store.remove(entry);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("fails closed for a non-missing witness unlink error", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-unlink-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const store = createProviderProcessWitnessStore({
      daemonInstanceId: "daemon-a",
      path,
      operations: { unlinkSync: () => { throw error; } },
    });
    expect(() => store.remove({
      daemonInstanceId: "daemon-a",
      providerId: "claude-process",
      pid: 18,
      pgid: null,
      processStartTime: null,
    })).toThrow(error);
  });

  it("fails closed when another live writer owns the witness mutation lock", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-provider-witness-lock-contention-"));
    roots.push(root);
    const path = join(root, "daemon-runtime.json");
    const store = createProviderProcessWitnessStore({ daemonInstanceId: "daemon-a", path });
    const entry = {
      daemonInstanceId: "daemon-a",
      providerId: "claude-process",
      pid: 20,
      pgid: null,
      processStartTime: null,
    } as const;

    withPrivateMutationLock(`${path}.lock`, "test witness", () => {
      expect(() => store.add(entry)).toThrow(PrivateMutationLockContentionError);
    });
    expect(() => readFileSync(path)).toThrow();
  });
});
