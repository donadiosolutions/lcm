import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __processUtilsTestUtils,
  createOwnedProcessTeardown,
  createProviderProcessWitnessStore,
} from "../../src/llm/process-utils.js";

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
});
