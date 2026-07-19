import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeStdin = EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  writable: boolean;
  destroyed: boolean;
  writableEnded: boolean;
};

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stdin: FakeStdin;
  kill: ReturnType<typeof vi.fn>;
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
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: vi.fn(() => { child.stdin.writableEnded = true; }),
      writable: true,
      destroyed: false,
      writableEnded: false,
    });
    child.exitCode = null;
    child.signalCode = null;
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
} = {}): DoctorDeps {
  const health = [...(options.health ?? [{ ok: false }])];
  return {
    existsSync: options.exists ?? (() => true),
    readFileSync: (path: string) => {
      const readError = options.readError?.(path);
      if (readError) throw readError;
      if (path.endsWith("config.json")) return options.configText ?? JSON.stringify(options.config ?? {});
      if (path.endsWith("settings.json")) return JSON.stringify(options.settings ?? { mcpServers: { lcm: {} } });
      if (path.endsWith("package.json")) return JSON.stringify(options.pkg ?? { version: "1.2.3" });
      if (path.endsWith("CLAUDE.md")) return options.claudeMd ?? "<!-- lcm:start -->\n@lcm.md\n<!-- lcm:end -->";
      if (path.endsWith("lcm.md")) return options.lcmMd ?? LCM_MD_CONTENT;
      return "{}";
    },
    writeFileSync: () => { if (options.writeError) throw options.writeError; },
    mkdirSync: vi.fn(),
    spawnSync: (...args) => mocks.spawnSync(...args),
    fetch: vi.fn().mockImplementation(async () => health.shift() ?? { ok: false }) as typeof fetch,
    homedir: DOCTOR_HOME,
    platform: "linux",
    cwd: DOCTOR_CWD,
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

  it("uses buffered handshake output when stdin errors", async () => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ id: 2, method: "tools/list", result: { tools: Array(7).fill({}) } })));
        child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      }, 1);
    };

    const results = await runWithHandshake(healthyDeps());
    expect(results.find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({ status: "pass", message: "lcm: 7/7 tools" });
    expect(mocks.mcpChild?.stdin.end).not.toHaveBeenCalled();
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

  it.each([false, true])("settles a hung MCP handshake at timeout when kill throws=%s", async (killThrows) => {
    vi.useFakeTimers();
    mocks.ensureDaemon.mockResolvedValue({ connected: true });
    mocks.mcpSetup = (child) => {
      child.kill = vi.fn(() => {
        if (killThrows) throw new Error("kill failed");
      });
    };
    const promise = runDoctor(healthyDeps());
    await vi.advanceTimersByTimeAsync(6000);
    expect((await promise).find((result) => result.name === "mcp-handshake-lcm")?.status).toBe("warn");
    expect(mocks.mcpChild?.kill).toHaveBeenCalledOnce();
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
      mocks.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "missing" });
      const results = await runDoctor({
        homedir: home,
        cwd: join(home, "project"),
        fetch: vi.fn().mockResolvedValue({ ok: false }) as typeof fetch,
      });
      expect(results.find((result) => result.name === "claude-process")?.status).toBe("fail");
      expect(results.find((result) => result.name === "codex-process")?.status).toBe("fail");
      expect(mocks.spawnSync.mock.calls.length).toBeGreaterThanOrEqual(2);
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
    ["{bad", 3737],
  ])("recovers malformed config port from %s", async (configText, expectedPort) => {
    const results = await runDoctor(makeDeps({ configText }));
    expect(results.find((result) => result.name === "config")?.status).toBe("fail");
    expect(mocks.ensureDaemon).toHaveBeenLastCalledWith(expect.objectContaining({ port: expectedPort }));
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
    expect(results.find((result) => result.name === "hooks")?.message).toContain("Duplicate");
    expect(results.find((result) => result.name === "mcp-lcm")?.status).toBe("fail");
    expect(results.find((result) => result.name === "lcm-md")?.status).toBe("fail");

    results = await runDoctor(makeDeps({
      settings: {},
      claudeMd: "no managed block",
      lcmMd: "stale",
      readError: (path) => path.endsWith("CLAUDE.md") ? new Error("cannot read claude") : undefined,
    }));
    expect(results.find((result) => result.name === "mcp-lcm")?.status).toBe("warn");
    expect(results.find((result) => result.name === "lcm-md")?.status).toBe("warn");

    results = await runDoctor(makeDeps({
      readError: (path) => path.endsWith("settings.json") || path.endsWith("lcm.md") ? new Error("cannot read") : undefined,
    }));
    expect(results.find((result) => result.name === "mcp-lcm")?.status).toBe("warn");
    expect(results.find((result) => result.name === "lcm-md")?.status).toBe("warn");
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
    for (const { event, command } of REQUIRED_HOOKS) hooks[event] = [{ hooks: [{ command }] }];
    let results = await runDoctor(makeDeps({ settings: { hooks }, writeError: "plain write failure" }));
    expect(results.find((result) => result.name === "hooks")?.message).toContain("entries");

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
    const finalResults = await isolated.runDoctor(makeDeps({ settings: {} }));
    expect(finalResults.find((result) => result.name === "project-map")?.message).toContain("2 mapped projects");
    expect(finalResults.find((result) => result.name === "secret-detection")?.status).toBe("fail");
    expect(finalResults.find((result) => result.name === "mcp-lcm")?.status).toBe("warn");

    vi.resetModules();
    vi.doMock("../src/generated-patterns.js", () => ({ GITLEAKS_PATTERNS: [{}] }));
    vi.doMock("../src/scrub.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../src/scrub.js")>();
      return {
        ...original,
        readGitleaksSyncDate: () => "2026-01-01",
        ScrubEngine: { loadProjectPatterns: vi.fn().mockResolvedValue([]) },
      };
    });
    const noSyncDate = await import("../src/doctor/doctor.js");
    expect((await noSyncDate.runDoctor(makeDeps())).find((result) => result.name === "secret-detection")?.message)
      .toContain("synced 2026-01-01");
    rmSync(root, { recursive: true, force: true });
  });
});
