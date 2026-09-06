import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProxyManager } from "../../src/daemon/proxy-manager.js";

// We'll mock child_process, fs, and http to test without real processes
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
  };
});

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createClaudeCliProxyManager } from "../../src/daemon/proxy-manager.js";

function makeMockChild() {
  const child: any = {
    pid: 12345,
    killed: false,
    on: vi.fn(),
    kill: vi.fn().mockImplementation(() => { child.killed = true; }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    unref: vi.fn(),
  };
  return child;
}

describe("ClaudeCliProxyManager", () => {
  let manager: ProxyManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createClaudeCliProxyManager({
      port: 13456,
      startupTimeoutMs: 500,
      model: "claude-haiku-4-5",
      pidFilePath: "/tmp/test-lcm-proxy.pid",
      healthPollIntervalMs: 50,
      _fetchOverride: vi.fn(),
    });
  });

  it("has correct port", () => {
    expect(manager.port).toBe(13456);
  });

  it("available is false before start()", () => {
    expect(manager.available).toBe(false);
  });

  describe("start()", () => {
    it("admits health before the monotonic deadline after a forward wall-clock jump", async () => {
      vi.useFakeTimers({
        now: new Date("2026-01-01T00:00:00.000Z"),
        toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      const child = makeMockChild();
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ service: "claude-server" }),
        });
      const performanceNowSpy = vi.spyOn(performance, "now");
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 500,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
      });

      try {
        const start = manager.start();
        await vi.advanceTimersByTimeAsync(0);
        const monotonicBeforeJump = performance.now();
        vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
        expect(Date.now()).toBeGreaterThan(new Date("2026-01-01T00:00:00.000Z").getTime());
        expect(performance.now()).toBe(monotonicBeforeJump);

        await vi.advanceTimersByTimeAsync(50);
        await expect(start).resolves.toBeUndefined();
        expect(manager.available).toBe(true);
        expect(child.kill).not.toHaveBeenCalled();
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        await manager.stop();
        performanceNowSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("times out and cleans up after a backward wall-clock jump", async () => {
      vi.useFakeTimers({
        now: new Date("2026-01-01T00:00:00.000Z"),
        toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      const child = makeMockChild();
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);
      (existsSync as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(false)
        .mockReturnValue(true);
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      });
      const performanceNowSpy = vi.spyOn(performance, "now");
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 100,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
      });

      try {
        const initialWallClock = Date.now();
        const start = manager.start();
        let settledAfterMonotonicBudget = false;
        const completion = start.then(
          () => { settledAfterMonotonicBudget = true; },
          () => { settledAfterMonotonicBudget = true; },
        );
        await vi.advanceTimersByTimeAsync(0);
        const monotonicBeforeJump = performance.now();
        vi.setSystemTime(new Date(initialWallClock - 1_000));
        expect(performance.now()).toBe(monotonicBeforeJump);

        await vi.advanceTimersByTimeAsync(100);
        const settledAtMonotonicBudget = settledAfterMonotonicBudget;
        if (!settledAtMonotonicBudget) {
          vi.setSystemTime(new Date(initialWallClock + 101));
          await vi.advanceTimersByTimeAsync(50);
        }
        await completion;

        expect(settledAtMonotonicBudget).toBe(true);
        expect(manager.available).toBe(false);
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(unlinkSync).toHaveBeenCalledWith("/tmp/test-lcm-proxy.pid");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await manager.stop();
        performanceNowSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("spawns claude-server and writes PID file when no existing process", async () => {
      const child = makeMockChild();
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ service: "claude-server" }),
        });
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 2000,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
      });

      await manager.start();

      expect(spawn).toHaveBeenCalledWith(
        "claude-server",
        expect.arrayContaining(["--port", "13456", "--model", "claude-haiku-4-5"]),
        expect.objectContaining({ stdio: ["ignore", "ignore", "pipe"] }),
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        "/tmp/test-lcm-proxy.pid",
        "12345",
      );
      const stderrHandler = child.stderr.on.mock.calls.find(([event]: [string]) => event === "data")?.[1];
      expect(stderrHandler).toBeTypeOf("function");
      expect(() => stderrHandler(Buffer.from("diagnostic output"))).not.toThrow();
      expect(manager.available).toBe(true);
    });

    it("reuses existing process when PID file exists and health check passes", async () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("99999");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ service: "claude-server" }),
      });
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 2000,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
        _killCheck: vi.fn().mockReturnValue(true), // process alive
      });

      await manager.start();

      expect(spawn).not.toHaveBeenCalled();
      expect(manager.available).toBe(true);
    });

    it("cleans up stale PID and spawns when recorded process is dead", async () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("99999");

      const child = makeMockChild();
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);

      const mockFetch = vi.fn()
        // First call: stale PID health check fails
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        // Second call: new process health check succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ service: "claude-server" }),
        });

      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 2000,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
        _killCheck: vi.fn().mockReturnValue(false), // process dead
      });

      await manager.start();

      expect(unlinkSync).toHaveBeenCalledWith("/tmp/test-lcm-proxy.pid");
      expect(spawn).toHaveBeenCalled();
    });

    it("marks unavailable when port is occupied by a foreign process", async () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const child = makeMockChild();
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);

      // Health check returns wrong service identity
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ service: "some-other-server" }),
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 500,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
      });

      await manager.start();

      expect(manager.available).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe("stop()", () => {
    it("kills child process and deletes PID file", async () => {
      const child = makeMockChild();
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);
      (existsSync as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(false) // no PID file at start
        .mockReturnValueOnce(true); // PID file exists at stop

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ service: "claude-server" }),
      });
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 2000,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
      });

      await manager.start();
      await manager.stop();

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(unlinkSync).toHaveBeenCalledWith("/tmp/test-lcm-proxy.pid");
    });
  });

  describe("isHealthy()", () => {
    it("returns false when not started", async () => {
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 500,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      });
      expect(await manager.isHealthy()).toBe(false);
    });
  });
});
