import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderGuidance } from "../src/connectors/template-service.js";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  restartDaemon: vi.fn(),
  collectEvents: vi.fn(),
  collectDetailedEvents: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../src/daemon/lifecycle.js", () => ({
  ensureDaemon: mocks.ensureDaemon,
  restartDaemon: mocks.restartDaemon,
}));
vi.mock("../src/db/events-stats.js", () => ({
  collectEventStats: (...args: unknown[]) => mocks.collectEvents(...args),
  collectDetailedEventStats: (...args: unknown[]) => mocks.collectDetailedEvents(...args),
}));
vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => mocks.spawnSync(...args),
  spawn: (...args: unknown[]) => mocks.spawn(...args),
}));

import { formatResultsPlain, printResults, runDoctor } from "../src/doctor/doctor.js";
import { LCM_MD_CONTENT } from "../src/daemon/orientation.js";
import { ScrubEngine } from "../src/scrub.js";
import type { CheckResult, DoctorDeps } from "../src/doctor/types.js";
import { backendDiagnosticFailure } from "../src/storage/diagnostics.js";
import { doctorConfigReadFailureSeams, doctorConfigSeams } from "./doctor/config-seams.js";

function isolatedPath(name: string): string {
  const runtimeHome = process.env.HOME;
  if (!runtimeHome) throw new Error("Vitest runtime HOME is not configured");
  const fixtureRoot = join(runtimeHome, "lcm-doctor-service-fixtures");
  mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  return join(fixtureRoot, name);
}

const DOCTOR_HOME = isolatedPath("coverage-services-doctor-home");
const DOCTOR_CWD = isolatedPath("coverage-services-doctor-project");
const DOCTOR_FIXTURE_ROOT = dirname(DOCTOR_HOME);

function makeDeps(options: {
  config?: unknown;
  configText?: string;
  settings?: unknown;
  settingsText?: string;
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
  writes?: string[];
} = {}): DoctorDeps {
  const health = [...(options.health ?? [{ ok: false }])];
  const configReadError = options.readError?.(join(DOCTOR_HOME, ".lcm", "config.json"));
  const configSeams = configReadError
    ? doctorConfigReadFailureSeams(configReadError)
    : doctorConfigSeams(options.configText ?? JSON.stringify(options.config ?? {}));
  return {
    existsSync: options.exists ?? (() => true),
    readFileSync: (path: string) => {
      options.readPaths?.push(path);
      const readError = options.readError?.(path);
      if (readError) throw readError;
      if (path.endsWith("config.json")) return options.configText ?? JSON.stringify(options.config ?? {});
      if (path.endsWith("settings.json")) {
        return options.settingsText ?? JSON.stringify(options.settings ?? { mcpServers: { lcm: {} } });
      }
      if (path.endsWith("daemon.token")) return "doctor-fixture-token";
      if (path.endsWith("package.json")) return JSON.stringify(options.pkg ?? { version: "1.2.3" });
      if (path.endsWith("CLAUDE.md")) return options.claudeMd ?? "<!-- lcm:start -->\n@lcm.md\n<!-- lcm:end -->";
      if (path.endsWith("lcm.md")) return options.lcmMd ?? LCM_MD_CONTENT;
      if (path.endsWith("lcm-memory/SKILL.md")) return renderGuidance("skill", "mcp");
      if (path.startsWith("/proc/")) return options.procEnviron ?? "";
      return "{}";
    },
    writeFileSync: vi.fn((_path, content) => {
      if (options.writeError) throw options.writeError;
      options.writes?.push(content);
    }),
    mkdirSync: vi.fn(),
    spawnSync: (...args) => mocks.spawnSync(...args),
    fetch: vi.fn().mockImplementation(async () => health.shift() ?? { ok: false }) as typeof fetch,
    homedir: DOCTOR_HOME,
    platform: "linux",
    cwd: DOCTOR_CWD,
    managedDaemonPath: options.managedDaemonPath,
    _expectedRuntimeDigestForTesting: "doctor-fixture-digest",
    ...configSeams,
  };
}

function readyHealth(overrides: Record<string, unknown> = {}) {
  return { ok: true, json: async () => ({
    status: "ok", version: "1.2.3", pid: 4242, storageBackend: "sqlite",
    entrypoint: join(process.cwd(), "dist", "lcm.mjs"),
    runtimeDigest: "doctor-fixture-digest", ...overrides,
  }) };
}

describe("doctor service coverage", () => {
  beforeEach(() => {
    rmSync(DOCTOR_HOME, { recursive: true, force: true });
    mkdirSync(DOCTOR_HOME, { recursive: true, mode: 0o700 });
    mkdirSync(join(DOCTOR_HOME, ".lcm"), { recursive: true, mode: 0o700 });
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.ensureDaemon.mockResolvedValue({ connected: false });
    mocks.restartDaemon.mockResolvedValue({ connected: false, restarted: false });
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    mocks.collectEvents.mockReturnValue({ captured: 1, unprocessed: 0, errors: 0, lastCapture: null });
    mocks.collectDetailedEvents.mockReturnValue({ captured: 1, unprocessed: 0, errors: 0, lastCapture: null, projects: [], recentErrors: [] });
    vi.spyOn(ScrubEngine, "loadProjectPatterns").mockResolvedValue([]);
  });

  afterEach(() => {
    rmSync(DOCTOR_HOME, { recursive: true, force: true });
    rmSync(DOCTOR_CWD, { recursive: true, force: true });
    vi.useRealTimers();
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
    expect(mocks.restartDaemon).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(DOCTOR_FIXTURE_ROOT, { recursive: true, force: true });
  });

  it("does not start an MCP handshake or invoke daemon lifecycle operations", async () => {
    const deps = makeDeps({ health: [readyHealth()] });
    const results = await runDoctor(deps);
    expect(results.find((result) => result.name === "daemon")).toMatchObject({ status: "pass" });
    expect(deps.fetch).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:3737/health", {
      headers: { Authorization: "Bearer doctor-fixture-token" }, signal: expect.any(AbortSignal),
    });
    expect(deps.writeFileSync).not.toHaveBeenCalled();
    expect(deps.mkdirSync).not.toHaveBeenCalled();
    expect(results.some((result) => "fixApplied" in result)).toBe(false);
    expect(results.find((result) => result.name === "mcp-handshake-lcm")).toMatchObject({
      status: "skip", message: expect.stringMatching(/not.probed/i),
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
    expect(mocks.restartDaemon).not.toHaveBeenCalled();
  });

  it("prints and formats every result status, category transition, stack, and ignores obsolete repair metadata", () => {
    const results: CheckResult[] = [
      { name: "stack", category: "Stack", status: "pass", message: "stack detail" },
      { name: "pass", category: "One", status: "pass", message: "passed" },
      { name: "warn", category: "One", status: "warn", message: "warning", ...{ fixApplied: true } },
      { name: "skip", category: "Two", status: "skip", message: "skipped" },
      { name: "fail", category: "Two", status: "fail", message: "failed" },
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printResults(results);
    const printed = log.mock.calls.flat().join("\n");
    expect(printed).not.toContain("auto-fixed");
    expect(printed).toContain("1 passed · 1 failed · 1 warnings · 1 skipped");
    const plain = formatResultsPlain(results);
    expect(plain).toContain("## Stack");
    expect(plain).toContain("| skip | ⏭️ skipped |");
    expect(plain).not.toContain("(auto-fixed)");
  });

  it("executes default filesystem, process, and directory dependency wrappers in an isolated home", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-doctor-default-deps-"));
    try {
      mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, ".lcm", "config.json"), JSON.stringify({ llm: { provider: "auto" } }), { mode: 0o600 });
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ mcpServers: { lcm: {} } }));
      mocks.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "missing" });
      const results = await runDoctor({
        homedir: home,
        cwd: join(home, "project"),
        collectBackendSnapshot: async () => backendDiagnosticFailure(new Error("fixture unavailable")),
        fetch: vi.fn().mockResolvedValue({ ok: false }) as typeof fetch,
      });
      expect(results.find((result) => result.name === "claude-process")?.status).toBe("fail");
      expect(results.find((result) => result.name === "codex-process")?.status).toBe("fail");
      expect(mocks.spawnSync.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks)
        .toBeUndefined();
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
  ])("observes but does not repair from malformed config %s", async (configText) => {
    const deps = makeDeps({ configText });
    const results = await runDoctor(deps);
    expect(results.find((result) => result.name === "config")?.status).toBe("fail");
    expect(results.find((result) => result.name === "daemon")).toMatchObject({
      status: "skip",
      message: expect.stringMatching(/config/i),
    });
    expect(deps.fetch).not.toHaveBeenCalled();
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

  it("checks providers against the authenticated daemon process PATH", async () => {
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
        readyHealth({ pid: 4242 }),
        readyHealth({ pid: 4242 }),
      ],
    }));

    expect(results.find((result) => result.name === "codex-process")?.status).toBe("pass");
  });

  it("uses the PID from authenticated matching health", async () => {
    const readPaths: string[] = [];
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
        readyHealth({ pid: 4343 }),
        readyHealth({ pid: 4343 }),
      ],
    }));

    expect(readPaths).toContain("/proc/4343/environ");
    expect(results.find((result) => result.name === "codex-process")?.status).toBe("pass");
  });

  it.each(["version", "runtimeDigest", "entrypoint", "storageBackend"])(
    "does not inspect a health PID when %s mismatches the expected identity",
    async (field) => {
      const readPaths: string[] = [];
      const results = await runDoctor(makeDeps({
        config: { llm: { provider: "codex-process" } }, readPaths,
        health: [readyHealth({ [field]: "untrusted-identity-canary" })],
      }));
      expect(results.find((result) => result.name === "daemon")?.status).toBe("fail");
      expect(readPaths).not.toContain("/proc/4242/environ");
      expect(mocks.ensureDaemon).not.toHaveBeenCalled();
      expect(mocks.restartDaemon).not.toHaveBeenCalled();
      expect(JSON.stringify(results)).not.toContain("untrusted-identity-canary");
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
        readyHealth({ pid }),
        readyHealth({ pid }),
      ],
    }));

    expect(results.find((result) => result.name === "codex-process")?.status).toBe("pass");
  });

  it("tests an explicitly empty daemon PATH without falling back", async () => {
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
        readyHealth(),
        readyHealth(),
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

  it("covers the explicit Claude process summarizer branch", async () => {
    const results = await runDoctor(makeDeps({
      config: { llm: { provider: "claude-process" } },
    }));

    expect(results.some((result) => result.name === "claude-process")).toBe(true);
  });

  it.each([new Error("private-read-error-canary"), "private-read-error-canary"])(
    "reports settings and skill read failures without raw errors",
    async (failure) => {
      const deps = makeDeps({
        readError: (path) => path.endsWith("settings.json") || path.endsWith("lcm-memory/SKILL.md") ? failure : undefined,
      });
      const results = await runDoctor(deps);
      expect(results.find((result) => result.name === "hooks")?.status).toBe("fail");
      expect(results.find((result) => result.name === "mcp-lcm")?.status).toBe("fail");
      expect(JSON.stringify(results)).not.toContain("private-read-error-canary");
      expect(deps.writeFileSync).not.toHaveBeenCalled();
      expect(deps.mkdirSync).not.toHaveBeenCalled();
    },
  );

  it("observes stale hooks and missing skill without attempting repair", async () => {
    const deps = makeDeps({
      settings: { hooks: { SessionStart: [{ hooks: [{ command: "lcm restore" }] }] } },
      exists: (path) => !path.endsWith("lcm-memory/SKILL.md"),
      writeError: new Error("unexpected write"),
    });
    const results = await runDoctor(deps);
    expect(results.find((result) => result.name === "hooks")?.status).toBe("warn");
    expect(results.find((result) => result.name === "lcm-md")?.status).toBe("warn");
    expect(deps.writeFileSync).not.toHaveBeenCalled();
    expect(deps.mkdirSync).not.toHaveBeenCalled();
  });

  it("gives matching actionable JSON guidance for malformed Claude settings", async () => {
    const results = await runDoctor(makeDeps({ settingsText: "{" }));
    const hooks = results.find((result) => result.name === "hooks");
    const mcp = results.find((result) => result.name === "mcp-lcm");

    expect(hooks?.status).toBe("fail");
    expect(mcp?.status).toBe("fail");
    expect(mcp?.message).toBe(hooks?.message);
    expect(mcp?.message).toContain("Fix the JSON, then run: lcm install");
  });

  it.each([
    { type: "sse", url: "https://private-host-canary/lcm", headers: { Authorization: "private-token-canary" }, env: { LCM_POSTGRES_URL: "postgresql://private-database-canary" } },
    ["malformed"],
  ])("observes stale MCP registration without changing any settings", async (lcm) => {
    const settings = { theme: "dark", mcpServers: { other: { command: "other" }, lcm } };
    const before = JSON.stringify(settings);
    const deps = makeDeps({ settings });
    const results = await runDoctor(deps);
    expect(results.find((result) => result.name === "mcp-lcm")?.status).toBe("warn");
    expect(deps.writeFileSync).not.toHaveBeenCalled();
    expect(JSON.stringify(settings)).toBe(before);
    expect(JSON.stringify(results)).not.toMatch(/private-(host|token|database)-canary/);
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
    expect(results.some((result) => result.name === "events-recent-errors")).toBe(false);
    expect(results.filter((result) => result.name.startsWith("events-project-"))).toHaveLength(8);
    expect(JSON.stringify(results)).not.toMatch(/PostToolUse|failure|\/cwd|\/p[1-8]/);
    expect(mocks.collectDetailedEvents).toHaveBeenCalledWith(expect.objectContaining({ pruneOrphanSidecars: false, maxDbs: 3 }));
    expect(results.find((result) => result.name === "events-errors")?.status).toBe("warn");

    mocks.collectEvents.mockReturnValue({ captured: 1, unprocessed: 0, errors: 0, lastCapture: "invalid-date" });
    expect((await runDoctor(makeDeps())).some((result) => result.name === "events-staleness")).toBe(false);
  });

  it("covers healthy daemon backlog without sidecar metadata notes and plural scan messages", async () => {
    vi.useFakeTimers();
    mocks.collectEvents.mockReturnValue({
      captured: 300, unprocessed: 250, errors: 0, lastCapture: null,
      sidecarsWithUnprocessed: 0, orphanedSidecarsWithUnprocessed: 0,
      scanErrors: 2, scanSkipped: 2, prunedSidecars: 2,
    });
    const results = await runDoctor(makeDeps({
      health: [
        readyHealth(),
        readyHealth(),
      ],
    }));
    expect(results.find((result) => result.name === "events-capture")?.message).toContain("run: lcm events promote --all");
    expect(results.find((result) => result.name === "events-sidecar-scan")?.message).toContain("sidecars");
  });

  it("reports an offline daemon without starting or restarting it", async () => {
    const results = await runDoctor(makeDeps());
    expect(results.find((result) => result.name === "daemon")?.status).toBe("fail");
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
    expect(mocks.restartDaemon).not.toHaveBeenCalled();
  });

  it("covers singular passive sidecar wording and recent aggregate staleness", async () => {
    mocks.collectEvents.mockReturnValue({
      captured: 250, unprocessed: 250, errors: 0,
      sidecarsWithUnprocessed: 1, orphanedSidecarsWithUnprocessed: 0,
      prunedSidecars: 1, scanErrors: 1, scanSkipped: 1,
      lastCapture: new Date(Date.now() - 2 * 60 * 60_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""),
    });
    const results = await runDoctor(makeDeps());
    expect(results.some((result) => result.name === "events-sidecar-prune")).toBe(false);
    expect(mocks.collectEvents).toHaveBeenCalledWith(expect.objectContaining({ pruneOrphanSidecars: false }));
    expect(results.find((result) => result.name === "events-staleness")?.message).toContain("h ago");
  });

  it("covers healthy singular-sidecar scope and one-to-seven-day aggregate staleness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T00:00:00Z"));
    mocks.collectEvents.mockReturnValue({
      captured: 250, unprocessed: 250, errors: 0,
      sidecarsWithUnprocessed: 1, orphanedSidecarsWithUnprocessed: 0,
      lastCapture: "2026-01-08 00:00:00",
    });
    const results = await runDoctor(makeDeps({ health: [
      readyHealth(),
      readyHealth(),
    ] }));
    expect(results.find((result) => result.name === "events-capture")?.message).toContain("1 project sidecar");
    expect(results.find((result) => result.name === "events-staleness")?.message).toContain("2d ago");
  });

  it("covers isolated project-map, generated-pattern, MCP normalization, and config fallback branches", async () => {
    const mapPath = join(DOCTOR_HOME, ".lcm", "map.json");
    writeFileSync(mapPath, "{}", { mode: 0o600 });

    vi.resetModules();
    vi.doMock("../src/generated-patterns.js", () => ({ GITLEAKS_PATTERNS: [] }));
    vi.doMock("../src/scrub.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../src/scrub.js")>();
      return {
        ...original,
        readGitleaksSyncDate: () => undefined,
        ScrubEngine: { loadProjectPatterns: vi.fn().mockResolvedValue([]) },
      };
    });
    vi.doMock("../installer/install.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../installer/install.js")>()),
      mergeClaudeSettings: () => ({}),
    }));
    const isolated = await import("../src/doctor/doctor.js");

    writeFileSync(mapPath, "invalid-map-canary", { mode: 0o600 });
    const invalidResults = await isolated.runDoctor(makeDeps());
    expect(invalidResults.find((result) => result.name === "project-map")?.status).toBe("fail");
    expect(JSON.stringify(invalidResults)).not.toContain("invalid-map-canary");
    expect(readFileSync(mapPath, "utf8")).toBe("invalid-map-canary");

    writeFileSync(mapPath, "{}", { mode: 0o600 });
    expect((await isolated.runDoctor(makeDeps())).find((result) => result.name === "project-map")?.message).toContain("0 mapped projects");
    const map = { ["a".repeat(64)]: { canonical: "/one", aliases: [] } };
    writeFileSync(mapPath, JSON.stringify(map), { mode: 0o600 });
    expect((await isolated.runDoctor(makeDeps())).find((result) => result.name === "project-map")?.message).toContain("1 mapped project");
    const two = JSON.stringify({ ...map, ["b".repeat(64)]: { canonical: "/two", aliases: [] } });
    writeFileSync(mapPath, two, { mode: 0o600 });
    const finalResults = await isolated.runDoctor(makeDeps({ settings: { mcpServers: { lcm: {} } } }));
    expect(readFileSync(mapPath, "utf8")).toBe(two);
    expect(finalResults.find((result) => result.name === "project-map")?.message).toContain("2 mapped projects");
    expect(finalResults.find((result) => result.name === "secret-detection")).toMatchObject({
      status: "fail",
      message: "No gitleaks patterns were loaded (GITLEAKS_PATTERNS is empty) — run pnpm run update:patterns from an LCM source checkout",
    });
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
  });
});
