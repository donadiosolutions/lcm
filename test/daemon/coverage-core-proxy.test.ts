import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), read: vi.fn(), write: vi.fn(), unlink: vi.fn(), exists: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", async importOriginal => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: mocks.read, writeFileSync: mocks.write, unlinkSync: mocks.unlink, existsSync: mocks.exists,
}));

import { createClaudeCliProxyManager } from "../../src/daemon/proxy-manager.js";

function child(pid: number | undefined = 123) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    pid, stderr: { on: vi.fn() }, unref: vi.fn(), kill: vi.fn(),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => { handlers.set(event, fn); }), handlers,
  };
}

const response = (ok: boolean, service = "claude-server") => ({ ok, json: async () => ({ service }) });

beforeEach(() => {
  vi.useFakeTimers();
  mocks.spawn.mockReset();
  mocks.read.mockReset();
  mocks.write.mockReset();
  mocks.unlink.mockReset();
  mocks.exists.mockReset();
  mocks.spawn.mockImplementation(() => { throw new Error("spawn not configured"); });
  mocks.read.mockReturnValue("not-a-pid");
  mocks.write.mockImplementation(() => {});
  mocks.unlink.mockImplementation(() => {});
  mocks.exists.mockReturnValue(false);
  vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("dead"); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("proxy manager failure and monitor boundaries", () => {
  it("uses global fetch, preserves one monitor, and reports foreign health", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(true) as Response);
    mocks.spawn.mockReturnValue(child());
    const manager = createClaudeCliProxyManager({ port: 8, startupTimeoutMs: 10, model: "m", pidFilePath: "/pid" });
    await manager.start();
    await manager.start();
    expect(globalFetch).toHaveBeenCalled();
    globalFetch.mockResolvedValue(response(true, "foreign") as Response);
    await expect(manager.isHealthy()).resolves.toBe(false);
    await manager.stop();
  });

  it("uses defaults, handles non-ok health, no child pid/stderr, and concurrent starts", async () => {
    const cp = child(); cp.pid = undefined; cp.stderr = null as never; mocks.spawn.mockReturnValue(cp);
    const fetch = vi.fn().mockResolvedValue(response(false));
    const manager = createClaudeCliProxyManager({ port: 1, startupTimeoutMs: 1, model: "m", _fetchOverride: fetch });
    const first = manager.start(); const second = manager.start();
    await vi.runAllTimersAsync(); await Promise.all([first, second]);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(manager.available).toBe(false);
    expect(await manager.isHealthy()).toBe(false);
  });

  it("handles malformed PID files, read failures, and the default kill-check failure path", async () => {
    mocks.exists.mockReturnValue(true);
    mocks.read.mockImplementation(() => { throw new Error("read"); });
    const cp = child(); mocks.spawn.mockReturnValue(cp);
    const manager = createClaudeCliProxyManager({ port: 2, startupTimeoutMs: 20, model: "m", pidFilePath: "/pid", healthPollIntervalMs: 1, _fetchOverride: vi.fn().mockResolvedValue(response(true)) });
    await manager.start();
    expect(mocks.unlink).toHaveBeenCalled();

    await manager.stop();
    mocks.read.mockReturnValue("NaN");
    const second = createClaudeCliProxyManager({ port: 2, startupTimeoutMs: 20, model: "m", pidFilePath: "/pid", _fetchOverride: vi.fn().mockResolvedValue(response(true)), _killCheck: undefined });
    mocks.spawn.mockReturnValue(child());
    await second.start();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    await second.stop();

    mocks.exists.mockReturnValue(true); mocks.read.mockReturnValue("77");
    vi.mocked(process.kill).mockReturnValue(true);
    mocks.spawn.mockReturnValue(child());
    const third = createClaudeCliProxyManager({ port: 2, startupTimeoutMs: 20, model: "m", pidFilePath: "/pid", _fetchOverride: vi.fn().mockResolvedValue(response(true, "foreign")) });
    await third.start();
    expect(process.kill).toHaveBeenCalledWith(77, 0);
    await third.stop();
  });

  it("handles spawn error and exit callbacks plus PID cleanup failures", async () => {
    const cp = child(); mocks.spawn.mockReturnValue(cp);
    mocks.exists.mockReturnValue(true); mocks.unlink.mockImplementation(() => { throw new Error("unlink"); });
    mocks.read.mockReturnValue("88");
    const manager = createClaudeCliProxyManager({ port: 3, startupTimeoutMs: 20, model: "m", pidFilePath: "/pid", _fetchOverride: vi.fn().mockResolvedValue(response(true)) });
    await manager.start();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledWith(88, 0);
    const errorHandler = cp.handlers.get("error");
    const exitHandler = cp.handlers.get("exit");
    expect(errorHandler).toBeTypeOf("function");
    expect(exitHandler).toBeTypeOf("function");
    expect(manager.available).toBe(true);
    errorHandler?.(new Error("spawn"));
    expect(manager.available).toBe(false);
    exitHandler?.();
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it("distinguishes unavailable and foreign services and kills failed children", async () => {
    for (const fetch of [
      vi.fn().mockRejectedValue(new Error("down")),
      vi.fn().mockResolvedValue(response(true, "foreign")),
    ]) {
      mocks.exists.mockReturnValue(false);
      const cp = child(); mocks.spawn.mockReturnValue(cp);
      const manager = createClaudeCliProxyManager({ port: 4, startupTimeoutMs: 1, model: "m", pidFilePath: "/pid", healthPollIntervalMs: 1, _fetchOverride: fetch });
      const start = manager.start(); await vi.runAllTimersAsync(); await start;
      expect(cp.kill).toHaveBeenCalledWith("SIGTERM");
      expect(manager.available).toBe(false);
    }
  });

  it("does not kill a child that exits while startup health is pending", async () => {
    const cp = child(); mocks.spawn.mockReturnValue(cp);
    const fetch = vi.fn().mockImplementation(async () => {
      cp.handlers.get("exit")?.();
      return response(false);
    });
    const manager = createClaudeCliProxyManager({ port: 9, startupTimeoutMs: 1, model: "m", pidFilePath: "/pid", _fetchOverride: fetch });
    const start = manager.start(); await vi.runAllTimersAsync(); await start;
    expect(cp.kill).not.toHaveBeenCalled();
  });

  it("monitors health, attempts one restart, and disables after subsequent misses", async () => {
    const cp1 = child(1); const cp2 = child(2); mocks.spawn.mockReturnValueOnce(cp1).mockReturnValueOnce(cp2);
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(false));
    const manager = createClaudeCliProxyManager({
      port: 5, startupTimeoutMs: 10, model: "m", pidFilePath: "/pid", healthPollIntervalMs: 1,
      healthMonitorIntervalMs: 10, maxHealthMisses: 2, _fetchOverride: fetch,
    });
    await manager.start();
    await vi.advanceTimersByTimeAsync(10); // healthy monitor
    await vi.advanceTimersByTimeAsync(20); // two misses, restart succeeds
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20); // second monitor reaches misses after restart attempt
    expect(manager.available).toBe(false);
    await manager.stop();
  });

  it("reuses a live stored PID without spawning", async () => {
    mocks.exists.mockReturnValue(true);
    mocks.read.mockReturnValue("101");
    vi.mocked(process.kill).mockReturnValue(true);
    const manager = createClaudeCliProxyManager({
      port: 10, startupTimeoutMs: 10, model: "m", pidFilePath: "/pid",
      _fetchOverride: vi.fn().mockResolvedValue(response(true)),
    });

    await manager.start();

    expect(process.kill).toHaveBeenCalledWith(101, 0);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(manager.available).toBe(true);
    await manager.stop();
  });

  it("handles a failed automatic restart and resets restart state on stop", async () => {
    const cp = child(); mocks.spawn.mockReturnValue(cp);
    const fetch = vi.fn().mockResolvedValueOnce(response(true)).mockRejectedValue(new Error("down"));
    const manager = createClaudeCliProxyManager({
      port: 6, startupTimeoutMs: 1, model: "m", pidFilePath: "/pid", healthPollIntervalMs: 1,
      healthMonitorIntervalMs: 5, maxHealthMisses: 1, _fetchOverride: fetch,
    });
    await manager.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(manager.available).toBe(false);
    await manager.stop();
  });

  it("handles a synchronous spawn failure during automatic restart", async () => {
    const cp = child();
    mocks.spawn.mockReturnValueOnce(cp).mockImplementationOnce(() => { throw new Error("spawn unavailable"); });
    const fetch = vi.fn().mockResolvedValueOnce(response(true)).mockResolvedValue(response(false));
    const manager = createClaudeCliProxyManager({
      port: 7, startupTimeoutMs: 1, model: "m", pidFilePath: "/pid", healthPollIntervalMs: 1,
      healthMonitorIntervalMs: 5, maxHealthMisses: 1, _fetchOverride: fetch,
    });
    await manager.start();
    await vi.advanceTimersByTimeAsync(5);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("claude-server unavailable"));
    expect(manager.available).toBe(false);
    await manager.stop();
  });
});
