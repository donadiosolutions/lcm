import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeStdin = EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  writable: boolean;
  destroyed: boolean;
  writableEnded: boolean;
};

type FakeStdout = EventEmitter & {
  destroy: ReturnType<typeof vi.fn>;
};

type FakeChild = EventEmitter & {
  stdout: FakeStdout;
  stdin: FakeStdin;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  collectEvents: vi.fn(),
  collectDetailedEvents: vi.fn(),
  spawnSync: vi.fn(),
  mcpStdout: "",
  mcpError: false,
  mcpHang: false,
  mcpSetup: undefined as ((child: FakeChild) => void) | undefined,
  mcpChild: undefined as FakeChild | undefined,
}));

vi.mock("../src/daemon/lifecycle.js", () => ({ ensureDaemon: mocks.ensureDaemon }));
vi.mock("../src/db/events-stats.js", () => ({
  collectEventStats: (...args: unknown[]) => mocks.collectEvents(...args),
  collectDetailedEventStats: (...args: unknown[]) => mocks.collectDetailedEvents(...args),
}));
vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => mocks.spawnSync(...args),
  spawn: vi.fn().mockImplementation(() => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    child.stdin = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: vi.fn(() => { child.stdin.writableEnded = true; }),
      destroy: vi.fn(() => { child.stdin.destroyed = true; }),
      writable: true,
      destroyed: false,
      writableEnded: false,
    });
    child.exitCode = null;
    child.signalCode = null;
    child.unref = vi.fn();
    child.kill = vi.fn(() => {
      child.signalCode = "SIGTERM";
      child.emit("close", null, "SIGTERM");
    });
    mocks.mcpChild = child;
    if (mocks.mcpSetup) {
      mocks.mcpSetup(child);
      return child;
    }
    setTimeout(() => {
      if (mocks.mcpHang) return;
      if (mocks.mcpError) child.emit("error", new Error("spawn failed"));
      else {
        if (mocks.mcpStdout) child.stdout.emit("data", Buffer.from(mocks.mcpStdout));
        child.exitCode = 0;
        child.emit("close", 0);
      }
    }, 1);
    return child;
  }),
}));

import { formatResultsPlain, printResults, runDoctor } from "../src/doctor/doctor.js";
import { LCM_MD_CONTENT } from "../src/daemon/orientation.js";
import { ScrubEngine } from "../src/scrub.js";
import { REQUIRED_HOOKS } from "../installer/install.js";
import type { CheckResult, DoctorDeps } from "../src/doctor/types.js";

function isolatedPath(name: string): string {
  const runtimeHome = process.env.HOME;
  if (!runtimeHome) throw new Error("Vitest runtime HOME is not configured");
  return join(runtimeHome, name);
}

const DOCTOR_HOME = isolatedPath("coverage-services-doctor-home");
const DOCTOR_CWD = isolatedPath("coverage-services-doctor-project");

function makeDeps(options: {
  config?: unknown;
  configText?: string;
  settings?: unknown;
  pkg?: unknown;
  health?: Array<unknown>;
  exists?: (path: string) => boolean;
  readError?: (path: string) => unknown;
  writeError?: unknown;
  claudeMd?: string;
  lcmMd?: string;
  managedDaemonPath?: string;
  procEnviron?: string;
  readPaths?: string[];
} = {}): DoctorDeps {
  const health = [...(options.health ?? [{ ok: false }])];
  return {
    existsSync: options.exists ?? (() => true),
    readFileSync: (path: string) => {
      options.readPaths?.push(path);
      const readError = options.readError?.(path);
      if (readError) throw readError;
      if (path.endsWith("config.json")) return options.configText ?? JSON.stringify(options.config ?? {});
      if (path.endsWith("settings.json")) return JSON.stringify(options.settings ?? { mcpServers: { lcm: {} } });
      if (path.endsWith("package.json")) return JSON.stringify(options.pkg ?? { version: "1.2.3" });
      if (path.endsWith("CLAUDE.md")) return options.claudeMd ?? "<!-- lcm:start -->\n@lcm.md\n<!-- lcm:end -->";
      if (path.endsWith("lcm.md")) return options.lcmMd ?? LCM_MD_CONTENT;
      if (path.startsWith("/proc/")) return options.procEnviron ?? "";
      return "{}";
    },
    writeFileSync: () => { if (options.writeError) throw options.writeError; },
    mkdirSync: vi.fn(),
    spawnSync: (...args) => mocks.spawnSync(...args),
    fetch: vi.fn().mockImplementation(async () => health.shift() ?? { ok: false }) as typeof fetch,
    homedir: DOCTOR_HOME,
    platform: "linux",
    cwd: DOCTOR_CWD,
    managedDaemonPath: options.managedDaemonPath,
  };
}

async function runWithHandshake(deps: DoctorDeps) {
  const promise = runDoctor(deps);
  await vi.advanceTimersByTimeAsync(1000);
  return promise;
}

function healthyDeps(): DoctorDeps {
  return makeDeps({
    health: [
      { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
      { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
    ],
  });
}

describe("doctor service coverage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.ensureDaemon.mockResolvedValue({ connected: false });
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    mocks.collectEvents.mockReturnValue({ captured: 1, unprocessed: 0, errors: 0, lastCapture: null });
    mocks.collectDetailedEvents.mockReturnValue({ captured: 1, unprocessed: 0, errors: 0, lastCapture: null, projects: [], recentErrors: [] });
    mocks.mcpStdout = "";
    mocks.mcpError = false;
    mocks.mcpHang = false;
    mocks.mcpSetup = undefined;
    mocks.mcpChild = undefined;
    vi.spyOn(ScrubEngine, "loadProjectPatterns").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    [JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", result: { tools: Array(7).fill({}) } }), "pass", "7/7"],
    [JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: Array(6).fill({}) } }), "warn", "6/7"],
    [`not-json\n${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: Array(3).fill({}) } })}\n{ "id" : 2, "result" : { "tools" : [ {}, {}, {}, {}, {}, {}, {} ] } }`, "pass", "7/7"],
    ["not-json tools/list", "warn", "0/7"],
    ["ordinary output", "warn", "0/7"],
    [JSON.stringify({ id: 2, tools: [] }), "warn", "0/7"],
    [JSON.stringify({ id: 2, method: "tools/list", result: {} }), "warn", "0/7"],
  ])("covers MCP handshake output %s", async (stdout, status, message) => {
    vi.useFakeTimers();
    mocks.mcpStdout = stdout;
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    const results = await runWithHandshake(makeDeps({
      health: [
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
      ],
    }));
    expect(results.find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({ status, message: expect.stringContaining(message) });
  });

  it("completes the normal MCP handshake lifecycle in protocol order", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = () => {};

    const promise = runDoctor(healthyDeps());
    await vi.advanceTimersByTimeAsync(0);
    const child = mocks.mcpChild!;

    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(child.stdin.write.mock.calls[0]?.[0]).trim())).toMatchObject({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "doctor", version: "0.1" } },
    });

    await vi.advanceTimersByTimeAsync(299);
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.stdin.write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(child.stdin.write.mock.calls[1]?.[0]).trim())).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(child.stdin.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.stdin.end).toHaveBeenCalledOnce();
    child.stdin.emit("close");
    expect(child.kill).not.toHaveBeenCalled();

    child.stdout.emit("data", Buffer.from(JSON.stringify({ id: 2, method: "tools/list", result: { tools: Array(7).fill({}) } })));
    child.exitCode = 0;
    child.emit("close", 0);

    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({
      status: "pass",
      message: "lcm: 7/7 tools",
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("reports MCP spawn failure", async () => {
    vi.useFakeTimers();
    mocks.mcpError = true;
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    const results = await runWithHandshake(makeDeps({
      health: [
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
      ],
    }));
    expect(results.find((result) => result.name === "mcp-handshake-lcm")?.message).toContain("Could not spawn");
  });

  it("stops delayed stdin work after an early close and ignores late duplicate events", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      setTimeout(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      }, 1);
    };

    const results = await runWithHandshake(healthyDeps());
    const child = mocks.mcpChild!;
    child.emit("error", new Error("late child error"));
    child.stdin.emit("error", new Error("late stdin error"));
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(7000);

    expect(results.find((result) => result.name === "mcp-handshake-lcm")?.message).toContain("0/7");
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("drains late handshake output after stdin errors", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      setTimeout(() => {
        child.kill.mockImplementationOnce(() => { child.signalCode = "SIGTERM"; });
        child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
        setTimeout(() => {
          child.stdout.emit("data", Buffer.from(JSON.stringify({ id: 2, method: "tools/list", result: { tools: Array(7).fill({}) } })));
          child.emit("close", null, "SIGTERM");
        }, 1);
      }, 1);
    };

    const results = await runWithHandshake(healthyDeps());
    expect(results.find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({ status: "pass", message: "lcm: 7/7 tools" });
    expect(mocks.mcpChild?.stdin.end).not.toHaveBeenCalled();
    expect(mocks.mcpChild?.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(7000);
    expect(mocks.mcpChild?.kill).toHaveBeenCalledOnce();
  });

  it("drains late handshake output after stdout errors", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      setTimeout(() => {
        child.kill.mockImplementationOnce(() => { child.signalCode = "SIGTERM"; });
        child.stdout.emit("error", new Error("stdout failed"));
        setTimeout(() => {
          child.stdout.emit("data", Buffer.from(JSON.stringify({ id: 2, result: { tools: Array(7).fill({}) } })));
          child.emit("close", null, "SIGTERM");
        }, 1);
      }, 1);
    };

    const results = await runWithHandshake(healthyDeps());
    expect(results.find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({ status: "pass", message: "lcm: 7/7 tools" });
    expect(mocks.mcpChild?.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(7000);
    expect(mocks.mcpChild?.kill).toHaveBeenCalledOnce();
  });

  it("stops a live child when stdin closes unexpectedly", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      setTimeout(() => { child.stdin.emit("close"); }, 1);
    };

    const results = await runWithHandshake(healthyDeps());
    const child = mocks.mcpChild!;
    expect(results.find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({ status: "warn", message: "lcm: 0/7 tools" });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdin.write).toHaveBeenCalledOnce();
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it("escalates to SIGKILL when a child never closes after stdin failure", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      child.kill.mockImplementation((signal: NodeJS.Signals) => {
        if (signal === "SIGKILL") {
          child.signalCode = signal;
          child.emit("close", null, signal);
        }
        return true;
      });
      setTimeout(() => { child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })); }, 1);
    };

    const promise = runDoctor(healthyDeps());
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.mcpChild?.kill).toHaveBeenCalledOnce();
    expect(mocks.mcpChild?.stdin.write).toHaveBeenCalledOnce();
    expect(mocks.mcpChild?.stdin.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({
      status: "warn",
      message: "lcm: 0/7 tools",
    });
    expect(mocks.mcpChild?.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("serializes termination while ignoring child errors emitted during shutdown", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      child.kill.mockImplementation((signal: NodeJS.Signals) => {
        if (signal === "SIGKILL") {
          setTimeout(() => {
            child.signalCode = signal;
            child.emit("close", null, signal);
          }, 1);
        }
        return true;
      });
      setTimeout(() => {
        child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
        setTimeout(() => { child.emit("error", new Error("termination failed")); }, 1);
      }, 1);
    };

    const settled = vi.fn();
    const promise = runDoctor(healthyDeps());
    void promise.then(settled);
    await vi.advanceTimersByTimeAsync(2);
    const child = mocks.mcpChild!;

    expect(settled).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdin.write).toHaveBeenCalledOnce();
    expect(child.stdin.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(248);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);

    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({
      status: "warn",
      message: "lcm: 0/7 tools",
    });
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.stdin.write).toHaveBeenCalledOnce();
    expect(child.stdin.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it.each(["returns-false", "throws"] as const)("escalates a failed SIGTERM when kill %s", async (failure) => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      child.kill = vi.fn((signal: NodeJS.Signals) => {
        if (signal === "SIGTERM") {
          if (failure === "throws") throw new Error("kill failed");
          return false;
        }
        child.signalCode = signal;
        child.emit("close", null, signal);
        return true;
      });
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ id: 2, result: { tools: Array(7).fill({}) } })));
        child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
        child.stdout.emit("error", new Error("duplicate pipe failure"));
        child.stdin.emit("close");
      }, 1);
    };

    const promise = runDoctor(healthyDeps());
    await vi.advanceTimersByTimeAsync(1000);
    const child = mocks.mcpChild!;
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.stdin.write).toHaveBeenCalledOnce();
    expect(child.stdin.end).not.toHaveBeenCalled();

    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({
      status: "pass",
      message: "lcm: 7/7 tools",
    });
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it.each(["destroyed", "unwritable"])("settles without writing when stdin is initially %s", async (state) => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      if (state === "destroyed") child.stdin.destroyed = true;
      else child.stdin.writable = false;
    };

    const results = await runWithHandshake(healthyDeps());
    expect(results.find((result) => result.name === "mcp-handshake-lcm")?.message).toContain("0/7");
    expect(mocks.mcpChild?.stdin.write).not.toHaveBeenCalled();
    expect(mocks.mcpChild?.stdin.end).not.toHaveBeenCalled();
    expect(mocks.mcpChild?.kill).toHaveBeenCalledOnce();
  });

  it.each([
    ["exitCode", "tools-list"],
    ["signalCode", "tools-list"],
    ["exitCode", "stdin-end"],
    ["signalCode", "stdin-end"],
  ] as const)("waits for stdout close when the child sets %s before delayed %s", async (exitState, delayedAction) => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = () => {};

    const promise = runDoctor(healthyDeps());
    await vi.advanceTimersByTimeAsync(0);
    const child = mocks.mcpChild!;
    await vi.advanceTimersByTimeAsync(delayedAction === "tools-list" ? 100 : 400);
    if (exitState === "exitCode") child.exitCode = 0;
    else child.signalCode = "SIGTERM";
    await vi.advanceTimersByTimeAsync(delayedAction === "tools-list" ? 200 : 400);

    expect(child.stdin.write).toHaveBeenCalledTimes(delayedAction === "tools-list" ? 1 : 2);
    expect(child.stdin.end).not.toHaveBeenCalled();

    child.stdout.emit("data", Buffer.from(JSON.stringify({ id: 2, method: "tools/list", result: { tools: Array(7).fill({}) } })));
    child.emit("close", exitState === "exitCode" ? 0 : null, exitState === "signalCode" ? "SIGTERM" : null);

    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({
      status: "pass",
      message: "lcm: 7/7 tools",
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("settles when stdin becomes unusable before the delayed close", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = () => {};

    const promise = runDoctor(healthyDeps());
    await vi.advanceTimersByTimeAsync(300);
    const child = mocks.mcpChild!;
    expect(child.stdin.write).toHaveBeenCalledTimes(2);

    child.stdin.destroyed = true;
    await vi.advanceTimersByTimeAsync(500);

    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({
      status: "warn",
      message: "lcm: 0/7 tools",
    });
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it.each(["initialize", "tools-list", "stdin-end"])("contains a synchronous %s stream failure", async (stage) => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      if (stage === "initialize") child.stdin.write.mockImplementationOnce(() => { throw new Error("write failed"); });
      if (stage === "tools-list") child.stdin.write.mockImplementationOnce(() => true).mockImplementationOnce(() => { throw new Error("write failed"); });
      if (stage === "stdin-end") child.stdin.end.mockImplementationOnce(() => { throw new Error("end failed"); });
    };

    const results = await runWithHandshake(healthyDeps());
    expect(results.find((result) => result.name === "mcp-handshake-lcm")?.message).toContain("0/7");
    expect(mocks.mcpChild?.kill).toHaveBeenCalledOnce();
  });

  it("contains synchronous or asynchronous MCP handshake failures", async () => {
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    const results = await runDoctor({
      ...makeDeps({
        health: [
          { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
          { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
        ],
      }),
      _testMcpHandshake: vi.fn(() => { throw new Error("synchronous spawn boundary"); }),
    });

    expect(results.find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({
      status: "warn",
      message: "Could not test MCP handshake",
    });
  });

  it.each([false, true])("escalates a hung MCP handshake at timeout when SIGTERM throws=%s", async (killThrows) => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      child.kill = vi.fn((signal: NodeJS.Signals) => {
        if (signal === "SIGTERM" && killThrows) throw new Error("kill failed");
        if (signal === "SIGKILL") {
          child.signalCode = signal;
          child.emit("close", null, signal);
        }
        return true;
      });
    };
    const promise = runDoctor(healthyDeps());
    await vi.advanceTimersByTimeAsync(6250);
    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")?.status).toBe("warn");
    expect(mocks.mcpChild?.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("bounds cleanup when both child signals fail without a close event", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      child.kill = vi.fn(() => false);
    };

    const settled = vi.fn();
    const promise = runDoctor(healthyDeps());
    void promise.then(settled);
    await vi.advanceTimersByTimeAsync(6000);

    const child = mocks.mcpChild!;
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(249);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")?.status).toBe("warn");
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it.each([false, true])("bounds post-SIGKILL cleanup when teardown throws=%s", async (teardownThrows) => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      child.kill = vi.fn(() => true);
      if (teardownThrows) {
        child.stdin.destroy.mockImplementation(() => { throw new Error("stdin destroy failed"); });
        child.stdout.destroy.mockImplementation(() => { throw new Error("stdout destroy failed"); });
        child.unref.mockImplementation(() => { throw new Error("unref failed"); });
      }
    };

    const settled = vi.fn();
    const promise = runDoctor(healthyDeps());
    void promise.then(settled);
    await vi.advanceTimersByTimeAsync(6249);

    const child = mocks.mcpChild!;
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM"]);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(249);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")?.status).toBe("warn");
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("does not abandon a child that closes during the post-SIGKILL grace", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      child.kill = vi.fn((signal: NodeJS.Signals) => {
        if (signal === "SIGKILL") {
          setTimeout(() => {
            child.signalCode = signal;
            child.emit("close", null, signal);
          }, 100);
        }
        return true;
      });
    };

    const settled = vi.fn();
    const promise = runDoctor(healthyDeps());
    void promise.then(settled);
    await vi.advanceTimersByTimeAsync(6349);

    const child = mocks.mcpChild!;
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")?.status).toBe("warn");
    expect(child.stdin.destroy).not.toHaveBeenCalled();
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("handles a child exit racing the timeout signal", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      let exitCodeReads = 0;
      Object.defineProperty(child, "exitCode", {
        configurable: true,
        get: () => exitCodeReads++ < 2 ? null : 0,
      });
      setTimeout(() => {
        child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      }, 1);
    };

    const promise = runDoctor(healthyDeps());
    await vi.advanceTimersByTimeAsync(6000);

    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")?.status).toBe("warn");
    expect(mocks.mcpChild?.kill).not.toHaveBeenCalled();
  });

  it("does not kill a child that exited without close before the process timeout", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      setTimeout(() => { child.exitCode = 0; }, 1000);
    };
    const promise = runDoctor(healthyDeps());
    await vi.advanceTimersByTimeAsync(6000);
    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")?.status).toBe("warn");
    expect(mocks.mcpChild?.kill).not.toHaveBeenCalled();
  });

  it("prints and formats every result status, category transition, stack, and auto-fix suffix", () => {
    const results: CheckResult[] = [
      { name: "stack", category: "Stack", status: "pass", message: "stack detail" },
      { name: "pass", category: "One", status: "pass", message: "passed" },
      { name: "warn", category: "One", status: "warn", message: "warning", fixApplied: true },
      { name: "skip", category: "Two", status: "skip", message: "skipped" },
      { name: "fail", category: "Two", status: "fail", message: "failed" },
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printResults(results);
    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain("auto-fixed");
    expect(printed).toContain("1 passed · 1 failed · 1 warnings · 1 skipped");
    const plain = formatResultsPlain(results);
    expect(plain).toContain("## Stack");
    expect(plain).toContain("| skip | ⏭️ skipped |");
    expect(plain).toContain("(auto-fixed)");
  });

  it("executes default filesystem, process, and directory dependency wrappers in an isolated home", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-default-deps-"));
    try {
      mkdirSync(join(home, ".lcm"), { recursive: true });
      writeFileSync(join(home, ".lcm", "config.json"), JSON.stringify({ llm: { provider: "auto" } }));
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ mcpServers: { lcm: {} } }));
      mocks.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "missing" });
      const results = await runDoctor({
        homedir: home,
        cwd: join(home, "project"),
        fetch: vi.fn().mockResolvedValue({ ok: false }) as typeof fetch,
      });
      expect(results.find((result) => result.name === "claude-process")?.status).toBe("fail");
      expect(results.find((result) => result.name === "codex-process")?.status).toBe("fail");
      expect(mocks.spawnSync.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks)
        .toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["null", 3737],
    ["[]", 3737],
    [JSON.stringify({ daemon: null }), 3737],
    [JSON.stringify({ daemon: [] }), 3737],
    [JSON.stringify({ daemon: { port: "bad" } }), 3737],
    [JSON.stringify({ daemon: { port: 1.5 } }), 3737],
    [JSON.stringify({ daemon: { port: 0 } }), 3737],
    [JSON.stringify({ daemon: { port: 65536 } }), 3737],
    [JSON.stringify({ daemon: { port: 4545 }, storage: { backend: "invalid" } }), 4545],
    ["{bad", 3737],
  ])("observes but does not repair from malformed config %s", async (configText, expectedPort) => {
    const deps = makeDeps({ configText });
    const results = await runDoctor(deps);
    expect(results.find((result) => result.name === "config")?.status).toBe("fail");
    expect(results.find((result) => result.name === "daemon")).toMatchObject({
      status: "fail",
      fixApplied: false,
      message: expect.stringContaining("automatic start skipped because config is invalid"),
    });
    expect(deps.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:${expectedPort}/health`,
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
  });

  it("wraps Error and non-Error config read failures and package failures", async () => {
    for (const failure of [new Error("read failed"), "plain read failure"]) {
      const results = await runDoctor(makeDeps({
        readError: (path) => path.endsWith("config.json") || path.endsWith("package.json") ? failure : undefined,
      }));
      expect(results.find((result) => result.name === "config")?.status).toBe("fail");
      expect(results.find((result) => result.name === "version")?.status).toBe("warn");
    }
  });

  it("covers package metadata without a version and process provider success/failure branches", async () => {
    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => ({
      status: args.at(-1)?.includes("claude") ? 0 : 1, stdout: "", stderr: "",
    }));
    const auto = await runDoctor(makeDeps({ config: { llm: { provider: "auto", fastMode: true } }, pkg: {} }));
    expect(auto.find((result) => result.name === "version")?.status).toBe("warn");
    expect(auto.find((result) => result.name === "claude-process")?.status).toBe("pass");
    expect(auto.find((result) => result.name === "codex-process")?.status).toBe("fail");

    mocks.spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    expect((await runDoctor(makeDeps({ config: { llm: { provider: "codex-process" } } })))
      .find((result) => result.name === "codex-process")?.status).toBe("pass");
  });

  it("checks Linux process providers against the managed daemon PATH", async () => {
    mocks.spawnSync.mockImplementation((cmd: string, args: string[], opts?: object) => {
      if (cmd === "/bin/sh" && args[1]?.includes("command -v codex")) {
        const path = (opts as { env?: { PATH?: string } } | undefined)?.env?.PATH;
        return { status: path?.startsWith("/trusted/lcm/bin:") ? 0 : 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const found = await runDoctor(makeDeps({
      config: { llm: { provider: "codex-process" } },
      managedDaemonPath: "/trusted/lcm/bin:/usr/bin:/bin",
    }));
    expect(found.find((result) => result.name === "codex-process")).toMatchObject({
      status: "pass",
      message: "codex CLI found on managed daemon PATH",
    });

    const missing = await runDoctor(makeDeps({
      config: { llm: { provider: "codex-process" } },
      managedDaemonPath: "/usr/bin:/bin",
    }));
    expect(missing.find((result) => result.name === "codex-process")).toMatchObject({
      status: "fail",
      message: expect.stringContaining("codex CLI not found on managed daemon PATH"),
    });
  });

  it("checks providers against the reused daemon process PATH", async () => {
    mocks.ensureDaemon.mockResolvedValue({ connected: true, pid: 4242 });
    mocks.spawnSync.mockImplementation((cmd: string, args: string[], opts?: object) => {
      if (cmd === "/bin/sh" && args[1]?.includes("command -v codex")) {
        const path = (opts as { env?: { PATH?: string } } | undefined)?.env?.PATH;
        return { status: path === "/daemon/runtime/bin:/usr/bin" ? 0 : 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const results = await runDoctor(makeDeps({
      config: { llm: { provider: "codex-process" } },
      procEnviron: "HOME=/isolated\0PATH=/daemon/runtime/bin:/usr/bin\0LANG=C\0",
      health: [
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 4242 }) },
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 4242 }) },
      ],
    }));

    expect(results.find((result) => result.name === "codex-process")?.status).toBe("pass");
  });

  it("uses the recognized health PID after lifecycle validation omits its PID", async () => {
    const readPaths: string[] = [];
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.spawnSync.mockImplementation((cmd: string, args: string[], opts?: object) => {
      if (cmd === "/bin/sh" && args[1]?.includes("command -v codex")) {
        const path = (opts as { env?: { PATH?: string } } | undefined)?.env?.PATH;
        return { status: path === "/health-pid/bin:/usr/bin" ? 0 : 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const results = await runDoctor(makeDeps({
      config: { llm: { provider: "codex-process" } },
      procEnviron: "PATH=/health-pid/bin:/usr/bin\0",
      readPaths,
      health: [
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 4343 }) },
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 4343 }) },
      ],
    }));

    expect(readPaths).toContain("/proc/4343/environ");
    expect(results.find((result) => result.name === "codex-process")?.status).toBe("pass");
  });

  it("uses only the lifecycle-verified PID when post-validation health reports another PID", async () => {
    const readPaths: string[] = [];
    mocks.ensureDaemon.mockResolvedValue({ connected: true, pid: 4242 });
    mocks.spawnSync.mockImplementation((cmd: string, args: string[], opts?: object) => {
      if (cmd === "/bin/sh" && args[1]?.includes("command -v codex")) {
        const path = (opts as { env?: { PATH?: string } } | undefined)?.env?.PATH;
        return { status: path === "/verified/bin" ? 0 : 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const results = await runDoctor(makeDeps({
      config: { llm: { provider: "codex-process" } },
      procEnviron: "PATH=/verified/bin\0",
      readPaths,
      health: [
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 9999 }) },
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 9999 }) },
      ],
    }));

    expect(readPaths).toContain("/proc/4242/environ");
    expect(readPaths).not.toContain("/proc/9999/environ");
    expect(results.find((result) => result.name === "codex-process")?.status).toBe("pass");
  });

  it.each(["disconnected", "throws"] as const)(
    "does not inspect the initial health PID when daemon validation %s",
    async (failure) => {
      const readPaths: string[] = [];
      if (failure === "disconnected") {
        mocks.ensureDaemon.mockResolvedValue({ connected: false });
      } else {
        mocks.ensureDaemon.mockRejectedValue(new Error("validation failed"));
      }
      mocks.spawnSync.mockImplementation((cmd: string, args: string[], opts?: object) => {
        if (cmd === "/bin/sh" && args[1]?.includes("command -v codex")) {
          const path = (opts as { env?: { PATH?: string } } | undefined)?.env?.PATH;
          return { status: path?.includes("/stale/bin") ? 1 : 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });

      const results = await runDoctor(makeDeps({
        config: { llm: { provider: "codex-process" } },
        health: [{ ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 4242 }) }],
        procEnviron: "PATH=/stale/bin\0",
        readPaths,
      }));

      expect(readPaths).not.toContain("/proc/4242/environ");
      expect(results.find((result) => result.name === "codex-process")?.status).toBe("pass");
    },
  );

  it.each([
    [undefined, "HOME=/isolated\0", false],
    [0, "HOME=/isolated\0", false],
    [1.5, "HOME=/isolated\0", false],
    [4242, "HOME=/isolated\0", false],
    [4242, "", true],
  ] as const)("uses the deterministic managed path when daemon environment pid=%s is unavailable", async (
    pid,
    procEnviron,
    readFails,
  ) => {
    mocks.ensureDaemon.mockResolvedValue({ connected: true, pid });
    mocks.spawnSync.mockImplementation((cmd: string, args: string[], opts?: object) => {
      if (cmd === "/bin/sh" && args[1]?.includes("command -v codex")) {
        const path = (opts as { env?: { PATH?: string } } | undefined)?.env?.PATH;
        return {
          status: path?.endsWith("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
            && !path.startsWith("/daemon/runtime/bin:") ? 0 : 1,
          stdout: "",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const results = await runDoctor(makeDeps({
      config: { llm: { provider: "codex-process" } },
      procEnviron,
      readError: (path) => readFails && path === "/proc/4242/environ" ? new Error("proc hidden") : undefined,
      health: [
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid }) },
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid }) },
      ],
    }));

    expect(results.find((result) => result.name === "codex-process")?.status).toBe("pass");
  });

  it("tests an explicitly empty daemon PATH without falling back", async () => {
    mocks.ensureDaemon.mockResolvedValue({ connected: true, pid: 4242 });
    let checkedPath: string | undefined;
    mocks.spawnSync.mockImplementation((cmd: string, args: string[], opts?: object) => {
      if (cmd === "/bin/sh" && args[1]?.includes("command -v codex")) {
        checkedPath = (opts as { env?: { PATH?: string } } | undefined)?.env?.PATH;
        return { status: 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const results = await runDoctor(makeDeps({
      config: { llm: { provider: "codex-process" } },
      procEnviron: "HOME=/isolated\0PATH=\0LANG=C\0",
      health: [
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
      ],
    }));

    expect(checkedPath).toBe("");
    expect(results.find((result) => result.name === "codex-process")?.status).toBe("fail");
  });

  it("covers anthropic key states and valid/invalid project patterns", async () => {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = "set";
      vi.mocked(ScrubEngine.loadProjectPatterns).mockResolvedValueOnce(["valid.*", "["]);
      let results = await runDoctor(makeDeps({ config: { llm: { provider: "anthropic", model: "claude-sonnet" } } }));
      expect(results.find((result) => result.name === "anthropic-key")?.status).toBe("pass");
      expect(results.find((result) => result.name === "user-patterns")?.status).toBe("warn");

      delete process.env.ANTHROPIC_API_KEY;
      vi.mocked(ScrubEngine.loadProjectPatterns).mockResolvedValueOnce(["valid.*"]);
      results = await runDoctor(makeDeps({ config: { llm: { provider: "anthropic", model: "claude-sonnet", apiKey: "configured" } } }));
      expect(results.find((result) => result.name === "anthropic-key")?.status).toBe("warn");
      expect(results.find((result) => result.name === "user-patterns")?.status).toBe("pass");
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });

  it("covers settings parse/repair/read failures and lcm.md repair failures", async () => {
    const settingsWithDuplicate = {
      hooks: { SessionStart: [{ hooks: [{ command: "lcm restore" }] }] },
    };
    let results = await runDoctor(makeDeps({
      settings: settingsWithDuplicate,
      writeError: new Error("cannot write"),
      exists: (path) => !path.endsWith("lcm.md"),
    }));
    expect(results.find((result) => result.name === "hooks")?.message).toContain("Could not manage native Claude Code hooks");
    expect(results.find((result) => result.name === "mcp-lcm")?.status).toBe("fail");
    expect(results.find((result) => result.name === "lcm-md")?.status).toBe("fail");

    results = await runDoctor(makeDeps({
      settings: { mcpServers: { lcm: {} } },
      claudeMd: "no managed block",
      lcmMd: "stale",
      readError: (path) => path.endsWith("CLAUDE.md") ? new Error("cannot read claude") : undefined,
    }));
    expect(results.find((result) => result.name === "mcp-lcm")?.status).toBe("warn");
    expect(results.find((result) => result.name === "lcm-md")?.status).toBe("warn");

    results = await runDoctor(makeDeps({
      readError: (path) => path.endsWith("settings.json") || path.endsWith("lcm.md") ? new Error("cannot read") : undefined,
    }));
    expect(results.find((result) => result.name === "mcp-lcm")?.status).toBe("fail");
    expect(results.find((result) => result.name === "lcm-md")?.status).toBe("fail");
  });

  it("covers passive-learning detailed boundaries", async () => {
    const now = Date.now();
    const sqlTime = (agoMs: number) => new Date(now - agoMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    mocks.collectDetailedEvents.mockReturnValue({
      captured: 20, unprocessed: 1, errors: 2, lastCapture: null, scanErrors: 2, scanSkipped: 2,
      prunedSidecars: 2,
      projects: [
        { file: "pruned-one", path: "/p1", pruned: true },
        { file: "scan-error", path: "/p2", scanError: "broken" },
        { file: "scan-skip", path: "/p3", scanSkipped: "budget" },
        { file: "just-now", path: "/p4", captured: 1, unprocessed: 0, lastCapture: sqlTime(0), cwd: "/cwd" },
        { file: "minutes", path: "/p5", captured: 1, unprocessed: 0, lastCapture: sqlTime(5 * 60_000), metadataMissing: true },
        { file: "hours", path: "/p6", captured: 1, unprocessed: 0, lastCapture: sqlTime(2 * 60 * 60_000), projectId: "project" },
        { file: "days", path: "/p7", captured: 1, unprocessed: 0, lastCapture: sqlTime(2 * 24 * 60 * 60_000), projectId: "project" },
        { file: "never", path: "/p8", captured: 0, unprocessed: 0, lastCapture: null, projectId: "project" },
      ],
      recentErrors: [{ created_at: "now", hook: "PostToolUse", error: "failure" }],
    });
    const results = await runDoctor(makeDeps(), { verbose: true, eventsMaxDbs: 3 });
    expect(results.find((result) => result.name === "events-recent-errors")?.message).toContain("PostToolUse");
    expect(results.filter((result) => result.name.startsWith("events-project-"))).toHaveLength(8);
    expect(results.find((result) => result.name === "events-errors")?.status).toBe("warn");

    mocks.collectEvents.mockReturnValue({ captured: 1, unprocessed: 0, errors: 0, lastCapture: "invalid-date" });
    expect((await runDoctor(makeDeps())).some((result) => result.name === "events-staleness")).toBe(false);
  });

  it("covers healthy daemon backlog without sidecar metadata notes and plural scan messages", async () => {
    vi.useFakeTimers();
    mocks.mcpStdout = JSON.stringify({ id: 2, result: { tools: Array(7).fill({}) } });
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.collectEvents.mockReturnValue({
      captured: 300, unprocessed: 250, errors: 0, lastCapture: null,
      sidecarsWithUnprocessed: 0, orphanedSidecarsWithUnprocessed: 0,
      scanErrors: 2, scanSkipped: 2, prunedSidecars: 2,
    });
    const results = await runWithHandshake(makeDeps({
      health: [
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
        { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
      ],
    }));
    expect(results.find((result) => result.name === "events-capture")?.message).toContain("run: lcm events promote --all");
    expect(results.find((result) => result.name === "events-sidecar-scan")?.message).toContain("sidecars");
  });

  it("covers daemon restart failure, offline rejection, and warning-bearing successful restarts", async () => {
    let results: CheckResult[];

    mocks.ensureDaemon.mockResolvedValueOnce({ connected: false });
    results = await runDoctor(makeDeps({ health: [{ ok: true, json: async () => ({ status: "ok", version: "old" }) }] }));
    expect(results.find((result) => result.name === "daemon")?.message).toContain("restart failed");

    mocks.ensureDaemon.mockRejectedValueOnce(new Error("start failed"));
    results = await runDoctor(makeDeps());
    expect(results.find((result) => result.name === "daemon")?.status).toBe("fail");

    vi.useFakeTimers();
    mocks.mcpStdout = JSON.stringify({ id: 2, result: { tools: Array(7).fill({}) } });
    mocks.ensureDaemon.mockResolvedValueOnce({ connected: true, warning: "restart warning" });
    results = await runWithHandshake(makeDeps({ health: [
      { ok: true, json: async () => ({ status: "ok", version: "old" }) },
      { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
    ] }));
    expect(results.find((result) => result.name === "daemon")?.message).toContain("restart warning");

    mocks.ensureDaemon.mockResolvedValueOnce({ connected: true, restartedForParent: true, warning: "parent warning" });
    results = await runWithHandshake(makeDeps({ health: [
      { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
      { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
    ] }));
    expect(results.find((result) => result.name === "daemon")?.message).toContain("parent warning");

    mocks.ensureDaemon.mockResolvedValueOnce({ connected: true });
    results = await runWithHandshake(makeDeps());
    expect(results.find((result) => result.name === "daemon")?.message).toContain("started");
  });

  it("covers singular passive sidecar wording and recent aggregate staleness", async () => {
    mocks.collectEvents.mockReturnValue({
      captured: 250, unprocessed: 250, errors: 0,
      sidecarsWithUnprocessed: 1, orphanedSidecarsWithUnprocessed: 0,
      prunedSidecars: 1, scanErrors: 1, scanSkipped: 1,
      lastCapture: new Date(Date.now() - 2 * 60 * 60_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""),
    });
    const results = await runDoctor(makeDeps());
    expect(results.find((result) => result.name === "events-sidecar-prune")?.message).toContain("sidecar");
    expect(results.find((result) => result.name === "events-staleness")?.message).toContain("h ago");
  });

  it("covers multiple duplicate hook repair failure and lcm.md patch-only/non-Error repair paths", async () => {
    const hooks: Record<string, unknown[]> = {};
    for (const { event, command } of REQUIRED_HOOKS) hooks[event] = [{ hooks: [{ command: `lcm ${command}` }] }];
    let results = await runDoctor(makeDeps({ settings: { hooks }, writeError: "plain write failure" }));
    expect(results.find((result) => result.name === "hooks")?.message).toContain("Could not manage native Claude Code hooks");

    results = await runDoctor(makeDeps({ claudeMd: "no reference" }));
    expect(results.find((result) => result.name === "lcm-md")?.message).toContain("added @lcm.md");

    results = await runDoctor(makeDeps({
      exists: (path) => !path.endsWith("lcm.md"),
      writeError: "plain write failure",
    }));
    expect(results.find((result) => result.name === "lcm-md")?.message).toContain("plain write failure");
  });

  it("formats future captures as just now in verbose project output", async () => {
    mocks.collectDetailedEvents.mockReturnValue({
      captured: 1, unprocessed: 0, errors: 0, lastCapture: null,
      projects: [{
        file: "future", path: "/future", captured: 1, unprocessed: 0, projectId: "future-project",
        lastCapture: new Date(Date.now() + 60_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""),
      }],
      recentErrors: [],
    });
    const results = await runDoctor(makeDeps(), true);
    expect(results.find((result) => result.name === "events-project-future")?.message).toContain("just now");
  });

  it("covers healthy singular-sidecar scope and one-to-seven-day aggregate staleness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T00:00:00Z"));
    mocks.mcpStdout = JSON.stringify({ id: 2, result: { tools: Array(7).fill({}) } });
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.collectEvents.mockReturnValue({
      captured: 250, unprocessed: 250, errors: 0,
      sidecarsWithUnprocessed: 1, orphanedSidecarsWithUnprocessed: 0,
      lastCapture: "2026-01-08 00:00:00",
    });
    const results = await runWithHandshake(makeDeps({ health: [
      { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
      { ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) },
    ] }));
    expect(results.find((result) => result.name === "events-capture")?.message).toContain("1 project sidecar");
    expect(results.find((result) => result.name === "events-staleness")?.message).toContain("2d ago");
  });

  it("covers isolated project-map, generated-pattern, MCP normalization, and config fallback branches", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-doctor-isolated-"));
    const mapPath = join(root, "map.json");
    writeFileSync(mapPath, "{}");
    let validation: unknown = { ok: true, fixApplied: false, warnings: [], errors: [], path: mapPath, map: undefined };
    let thrown: unknown;

    vi.resetModules();
    vi.doMock("../src/project-map.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/project-map.js")>()),
      validateProjectMap: () => { if (thrown !== undefined) throw thrown; return validation; },
      projectMapPath: () => mapPath,
    }));
    vi.doMock("../src/generated-patterns.js", () => ({ GITLEAKS_PATTERNS: [] }));
    vi.doMock("../src/scrub.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../src/scrub.js")>();
      return {
        ...original,
        readGitleaksSyncDate: () => undefined,
        ScrubEngine: { loadProjectPatterns: vi.fn().mockResolvedValue([]) },
      };
    });
    vi.doMock("../src/daemon/config.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/daemon/config.js")>()),
      loadDaemonConfig: () => ({}),
    }));
    vi.doMock("../installer/install.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../installer/install.js")>()),
      mergeClaudeSettings: () => ({}),
    }));
    const isolated = await import("../src/doctor/doctor.js");

    thrown = "plain map failure";
    expect((await isolated.runDoctor(makeDeps())).find((result) => result.name === "project-map")?.message).toContain("plain map failure");
    thrown = undefined;

    validation = { ok: true, fixApplied: true, warnings: [], errors: [], path: mapPath };
    expect((await isolated.runDoctor(makeDeps())).find((result) => result.name === "project-map")?.message).toBe("formatted map.json");
    validation = { ok: true, fixApplied: true, warnings: ["map warning"], errors: [], path: mapPath };
    expect((await isolated.runDoctor(makeDeps())).find((result) => result.name === "project-map")?.message).toBe("map warning");

    validation = { ok: true, fixApplied: false, warnings: [], errors: [], path: mapPath, map: undefined };
    expect((await isolated.runDoctor(makeDeps())).find((result) => result.name === "project-map")?.message).toContain("0 mapped projects");
    validation = { ok: true, fixApplied: false, warnings: [], errors: [], path: mapPath, map: { one: {} } };
    expect((await isolated.runDoctor(makeDeps())).find((result) => result.name === "project-map")?.message).toContain("1 mapped project");
    validation = { ok: true, fixApplied: false, warnings: [], errors: [], path: mapPath, map: { one: {}, two: {} } };
    const finalResults = await isolated.runDoctor(makeDeps({ settings: { mcpServers: { lcm: {} } } }));
    expect(finalResults.find((result) => result.name === "project-map")?.message).toContain("2 mapped projects");
    expect(finalResults.find((result) => result.name === "secret-detection")?.status).toBe("fail");
    expect(finalResults.find((result) => result.name === "mcp-lcm")?.status).toBe("warn");

    vi.resetModules();
    vi.doMock("../src/generated-patterns.js", () => ({ GITLEAKS_PATTERNS: [{}] }));
    let syncDate: string | undefined = "2026-01-01";
    vi.doMock("../src/scrub.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../src/scrub.js")>();
      return {
        ...original,
        readGitleaksSyncDate: () => syncDate,
        ScrubEngine: { loadProjectPatterns: vi.fn().mockResolvedValue([]) },
      };
    });
    const syncDateDoctor = await import("../src/doctor/doctor.js");
    expect((await syncDateDoctor.runDoctor(makeDeps())).find((result) => result.name === "secret-detection")?.message)
      .toContain("synced 2026-01-01");
    syncDate = undefined;
    expect((await syncDateDoctor.runDoctor(makeDeps())).find((result) => result.name === "secret-detection")?.message)
      .not.toContain("(synced ");
    rmSync(root, { recursive: true, force: true });
  });
});
