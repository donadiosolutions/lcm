import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigValidationError } from "../../src/daemon/config.js";

const state = vi.hoisted(() => ({
  exit: vi.fn((code?: string | number | null): never => { throw new Error(`exit:${code ?? 0}`); }),
  printHelp: vi.fn(),
  ensureDaemon: vi.fn(async () => ({ connected: true, spawned: false, restartedForParent: false, pid: 42 })),
  restartDaemon: vi.fn(async () => ({ connected: true, restarted: true, spawned: false, pid: 42 })),
  post: vi.fn(async (path: string) => path === "/status" ? ({
    daemon: { version: "1.0.0", uptime: 5, port: 3737 },
    project: { messageCount: 2, summaryCount: 1, promotedCount: 1, lastIngest: "now", lastCompact: "now", lastPromote: "now" },
  }) : ({ ok: true, promoted: 1, processed: 1, skipped: 0, errors: 0, processedProjects: 1 })),
  get: vi.fn(async () => ({ totalConnections: 2, activeConnections: 1, idleConnections: 1, connections: [{ refs: 1, status: "active", path: "/db" }] })),
  health: vi.fn(async () => true),
  dispatchHook: vi.fn(async () => ({ stdout: "hook-output", exitCode: 0 })),
  loadConfig: vi.fn(() => ({
    daemon: state.daemonPort === undefined ? undefined : { port: state.daemonPort },
    llm: {
      provider: state.provider, apiMode: "responses", requestTimeoutMs: 1000,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2 },
    },
    compaction: { autoCompactMinTokens: 100 },
  })),
  fileText: JSON.stringify({ version: "1.4.0", entries: [] }),
  installed: [] as Array<{ agentId: string; type: string; path: string }>,
  installResult: { path: "/connector", requiresRestart: false } as Record<string, unknown>,
  removeResult: true,
  batchResult: { compacted: 1, failures: 0 },
  importResult: { imported: 1, skipped: 0 },
  portableResult: { exported: 1, imported: 1, skipped: 0, total: 1, dryRun: false },
  provider: "openai",
  entries: [] as Array<{ name: string; isDirectory: () => boolean }>,
  exists: true,
  readError: undefined as Error | undefined,
  doctorResults: [{ status: "pass" }],
  configGetError: undefined as unknown,
  configSetError: undefined as unknown,
  exportError: undefined as Error | undefined,
  importKnowledgeError: undefined as Error | undefined,
  daemonPort: 3737 as number | undefined,
  batchProgressLast: true,
  importProgressLast: true,
  sensitiveStdout: "sensitive",
  packageVersion: "1.4.0" as unknown,
}));

const fakeStdin = vi.hoisted(() => ({
  isTTY: true,
  destroy: vi.fn(),
  on: vi.fn(),
}));

vi.mock("node:process", async importOriginal => ({
  ...(await importOriginal<typeof import("node:process")>()),
  exit: state.exit,
  stdin: fakeStdin,
}));
vi.mock("node:fs", async importOriginal => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: vi.fn((path: unknown) => {
    if (String(path).endsWith("package.json")) return JSON.stringify({ version: state.packageVersion });
    if (state.readError) throw state.readError;
    return state.fileText;
  }),
  existsSync: vi.fn(() => state.exists),
  readdirSync: vi.fn(() => state.entries),
  mkdirSync: vi.fn(), writeFileSync: vi.fn(), unlinkSync: vi.fn(),
}));
vi.mock("../../src/runtime-paths.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/runtime-paths.js")>()),
  configPath: () => "/lcm/config.json", daemonPidPath: () => "/lcm/daemon.pid",
  daemonTokenPath: () => "/lcm/daemon.token", lcmHomeDir: () => "/lcm",
  migrateLegacyHomeIfNeeded: vi.fn(), projectsDir: () => "/lcm/projects",
}));
vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: class { post = state.post; get = state.get; health = state.health; },
}));
vi.mock("../../src/daemon/config.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/daemon/config.js")>()),
  loadDaemonConfig: state.loadConfig,
}));
vi.mock("../../src/daemon/lifecycle.js", () => ({ ensureDaemon: state.ensureDaemon, restartDaemon: state.restartDaemon }));
vi.mock("../../src/cli-help.js", () => ({ printHelp: state.printHelp }));
vi.mock("../../src/hooks/dispatch.js", () => ({ dispatchHook: state.dispatchHook }));
vi.mock("../../src/mcp/server.js", () => ({ startMcpServer: vi.fn(async () => undefined) }));
vi.mock("../../src/batch-compact.js", () => ({ batchCompact: vi.fn(async (options: { onProgress?: (patch: unknown) => void }) => {
  options.onProgress?.(state.batchProgressLast ? { lastResult: { ok: true } } : {});
  return state.batchResult;
}) }));
vi.mock("../../src/cli/progress-state.js", () => ({ makeProgressState: vi.fn((value: Record<string, unknown>) => ({ ...value })) }));
vi.mock("../../src/cli/pipeline-runner.js", () => ({ NinjaRenderer: class {
  start = vi.fn(); stop = vi.fn(); sessionDone = vi.fn(); printSummary = vi.fn();
} }));
vi.mock("../../src/daemon/server.js", () => ({ createDaemon: vi.fn(async () => ({ address: () => ({ port: 3737 }) })) }));
vi.mock("../../src/daemon/auth.js", () => ({ ensureAuthToken: vi.fn() }));
vi.mock("../../src/stats.js", () => ({ collectStats: vi.fn(() => ({ ok: true })), printStats: vi.fn() }));
vi.mock("../../src/doctor/doctor.js", () => ({ runDoctor: vi.fn(async () => state.doctorResults), printResults: vi.fn() }));
vi.mock("../../src/diagnose.js", () => ({ diagnose: vi.fn(async () => ({ ok: true })), formatDiagnoseResult: vi.fn(() => "diagnosed") }));
vi.mock("../../src/sensitive.js", () => ({ handleSensitive: vi.fn(async () => ({ stdout: state.sensitiveStdout, exitCode: 0 })) }));
vi.mock("../../src/connectors/registry.js", () => ({
  AGENTS: [{ id: "codex", name: "Codex", category: "agent", defaultType: "hook", supportedTypes: ["hook"] }],
  findAgent: vi.fn((name: string) => name === "codex" ? ({ id: "codex", name: "Codex" }) : undefined),
}));
vi.mock("../../src/connectors/installer.js", () => ({
  listConnectors: vi.fn(() => state.installed), installConnector: vi.fn(() => state.installResult),
  removeConnector: vi.fn(() => state.removeResult),
}));
vi.mock("../../src/config-manager.js", () => ({
  getConfigValue: vi.fn(() => { if (state.configGetError !== undefined) throw state.configGetError; return "value"; }),
  formatConfigValue: vi.fn((value: unknown) => JSON.stringify(value)), normalizeConfigPath: vi.fn((path: string) => path),
  setConfigValue: vi.fn(() => { if (state.configSetError !== undefined) throw state.configSetError; return "stored"; }),
}));
vi.mock("../../installer/install.js", () => ({ install: vi.fn(async () => undefined) }));
vi.mock("../../installer/uninstall.js", () => ({ uninstall: vi.fn(async () => undefined) }));
vi.mock("../../installer/dry-run-deps.js", () => ({ DryRunServiceDeps: class {} }));
vi.mock("../../src/import.js", () => ({
  cwdToProjectHash: vi.fn(() => "hash"), findSessionFiles: vi.fn(() => ["session"]),
  importSessions: vi.fn(async (_client: unknown, options: { onProgress?: (patch: unknown) => void }) => {
    options.onProgress?.(state.importProgressLast ? { lastResult: { ok: true } } : {});
    return state.importResult;
  }),
}));
vi.mock("../../src/codex-transcript.js", () => ({ findAllCodexTranscripts: vi.fn(() => ["codex-session"]) }));
vi.mock("../../src/import-summary.js", () => ({ printImportSummary: vi.fn() }));
vi.mock("../../src/portable-knowledge.js", () => ({
  exportKnowledge: vi.fn(async () => { if (state.exportError) throw state.exportError; return state.portableResult; }),
  importKnowledge: vi.fn(async () => { if (state.importKnowledgeError) throw state.importKnowledgeError; return state.portableResult; }),
}));

const {
  handleCliError, resolveCompactRequestPolicyOverride, runCli, runMainIfInvoked, shouldRunMain,
  withHookOverrides, writeCliError, writeCliOutput,
} = await import("../../bin/lcm.js");

async function invoke(args: string[]): Promise<Error | undefined> {
  try {
    await runCli(["node", "lcm", ...args]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeStdin.on.mockReset();
  fakeStdin.destroy.mockReset();
  fakeStdin.isTTY = true;
  state.ensureDaemon.mockResolvedValue({ connected: true, spawned: false, restartedForParent: false, pid: 42 });
  state.health.mockResolvedValue(true);
  state.installed = [];
  state.installResult = { path: "/connector", requiresRestart: false };
  state.removeResult = true;
  state.provider = "openai";
  state.entries = [];
  state.exists = true;
  state.readError = undefined;
  state.fileText = JSON.stringify({ version: "1.4.0", entries: [] });
  state.doctorResults = [{ status: "pass" }];
  state.configGetError = undefined;
  state.configSetError = undefined;
  state.exportError = undefined;
  state.importKnowledgeError = undefined;
  state.portableResult = { exported: 1, imported: 1, skipped: 0, total: 1, dryRun: false };
  state.daemonPort = 3737;
  state.batchProgressLast = true;
  state.importProgressLast = true;
  state.sensitiveStdout = "sensitive";
  state.packageVersion = "1.4.0";
});

afterEach(() => {
  process.exitCode = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runCli registration and help dispatch", () => {
  it("covers standalone parsing and entry guard fallbacks", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(withHookOverrides("not-json", "codex", undefined)).toBe("not-json");
    expect(withHookOverrides("[]", "codex", undefined)).toBe("[]");
    expect(withHookOverrides("null", "codex", undefined)).toBe("null");
    expect(shouldRunMain(undefined, "/bin/lcm.js")).toBe(false);
    expect(() => resolveCompactRequestPolicyOverride(state.loadConfig() as never, { timeoutMs: " " })).toThrow();
    expect(() => handleCliError(new Error("boom"))).toThrow("exit:1");
    expect(() => handleCliError(new ConfigValidationError("cli", "invalid"))).toThrow("exit:1");
    expect(() => writeCliOutput("out")).not.toThrow();
    expect(() => writeCliError("err")).not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(stdout).toHaveBeenCalledWith("out");
    expect(stderr).toHaveBeenCalledWith("err");
    const runner = vi.fn(async () => undefined);
    runMainIfInvoked(undefined, "/bin/lcm.js", runner);
    expect(runner).not.toHaveBeenCalled();
    runMainIfInvoked("/missing/lcm.js", "/missing/lcm.js", runner);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("routes executable failures to the supplied top-level handler", async () => {
    const failure = new Error("failed");
    const onError = vi.fn();
    runMainIfInvoked("/missing/lcm.js", "/missing/lcm.js", async () => { throw failure; }, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });

  it("waits for the stdin timeout when a pipe never closes", async () => {
    vi.useFakeTimers();
    fakeStdin.isTTY = false;
    fakeStdin.on.mockReturnValue(fakeStdin);
    const pending = invoke(["restore"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending)?.message).toBe("exit:0");
    expect(fakeStdin.destroy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores late stdin timeout/end callbacks after resolution", async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    fakeStdin.isTTY = false;
    let end: (() => void) | undefined;
    fakeStdin.on.mockImplementation((event: string, callback: () => void) => {
      if (event === "end") end = callback;
      return fakeStdin;
    });
    const ended = invoke(["restore"]);
    await vi.advanceTimersByTimeAsync(0);
    end ??= fakeStdin.on.mock.calls.find(([event]) => event === "end")?.[1] as (() => void) | undefined;
    expect(end).toBeDefined();
    end?.();
    await ended;
    await vi.advanceTimersByTimeAsync(5000);

    let lateEnd: (() => void) | undefined;
    fakeStdin.on.mockImplementation((event: string, callback: () => void) => {
      if (event === "end") lateEnd = callback;
      return fakeStdin;
    });
    const timedOut = invoke(["restore"]);
    await vi.advanceTimersByTimeAsync(0);
    lateEnd ??= fakeStdin.on.mock.calls.find(([event]) => event === "end")?.[1] as (() => void) | undefined;
    expect(lateEnd).toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    lateEnd?.();
    await timedOut;
    clear.mockRestore();
    vi.useRealTimers();
  });

  it("runs the currently asynchronous unknown-command fallback", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    state.exit.mockImplementationOnce((() => undefined) as never);
    expect(await invoke(["unknown"])).toBeUndefined();
    await vi.waitFor(() => expect(state.printHelp).toHaveBeenCalled());
    expect(stderr).toHaveBeenCalledWith("lcm: unknown command 'unknown'\n\n");
  });

  it.each([
    [], ["--help"], ["help"], ["help", "compact"],
    ["daemon", "--help"], ["daemon", "start", "--help"], ["daemon", "restart", "--help"],
    ["config"],
    ["compact", "--help"], ["restore", "--help"], ["session-end", "--help"],
    ["user-prompt", "--help"], ["post-tool", "--help"], ["session-snapshot", "--help"],
    ["mcp", "--help"], ["install", "--help"], ["uninstall", "--help"], ["status", "--help"],
    ["stats", "--help"], ["doctor", "--help"], ["events", "--help"], ["events", "promote", "--help"],
    ["diagnose", "--help"], ["connectors", "--help"], ["sensitive", "--help"], ["import", "--help"],
    ["promote", "--help"], ["export", "--help"], ["import-knowledge", "x", "--help"],
    ["search", "q", "--help"], ["grep", "q", "--help"], ["describe", "n", "--help"],
    ["expand", "n", "--help"], ["store", "text", "--help"],
  ])("routes custom help for %#", async (...args) => {
    expect((await invoke(args))?.message).toBe("exit:0");
  });
});

describe("runCli daemon-backed and utility actions", () => {
  it.each([
    ["search", "needle", "--limit", "2", "--layer", "episodic", "--tag", "decision"],
    ["grep", "needle", "--mode", "regex", "--scope", "messages", "--since", "2026-01-01"],
    ["describe", "node"], ["expand", "node", "--depth", "2"], ["store", "memory", "--tag", "one"],
  ])("dispatches memory action %#", async (...args) => {
    expect(await invoke(args)).toBeUndefined();
  });

  it.each([
    ["search", "q", "--limit", "0"], ["search", "q", "--layer", "bad"],
    ["grep", "q", "--mode", "bad"], ["grep", "q", "--scope", "bad"],
    ["expand", "n", "--depth", "bad"],
  ])("rejects invalid memory option %#", async (...args) => {
    expect((await invoke(args))?.message).toBe("exit:1");
  });

  it("handles daemon connection failure", async () => {
    state.ensureDaemon.mockResolvedValueOnce({ connected: false, spawned: false, restartedForParent: false, pid: undefined });
    expect((await invoke(["search", "q"]))?.message).toBe("exit:1");
  });

  it.each([
    ["config", "get", "llm.provider", "--effective"], ["config", "set", "llm.provider", "openai", "--json"],
    ["status"], ["status", "--json"], ["stats"], ["stats", "--pool"], ["stats", "--pool", "--json"],
    ["diagnose"], ["diagnose", "--all", "--verbose", "--json"], ["sensitive", "list"],
    ["connectors", "list"], ["connectors", "list", "--format", "json", "--global"],
    ["connectors", "install", "codex"], ["connectors", "remove", "codex"],
    ["connectors", "doctor"], ["connectors", "doctor", "codex", "--global"],
  ])("runs utility action %#", async (...args) => {
    const error = await invoke(args);
    if (args[0] === "sensitive") expect(error?.message).toBe("exit:0");
    else expect(error).toBeUndefined();
  });

  it.each([["connectors"], ["events"], ["diagnose", "--days", "0"], ["connectors", "doctor", "unknown"]])(
    "reports command usage/error %#", async (...args) => expect((await invoke(args))?.message).toBe("exit:1"),
  );
});

describe("runCli orchestration actions", () => {
  it.each([
    ["restore"], ["session-end", "--client", "codex"], ["user-prompt"], ["post-tool"],
    ["session-snapshot"], ["compact", "--hook", "--client", "claude"],
  ])("dispatches hook action %#", async (...args) => {
    expect((await invoke(args))?.message).toBe("exit:0");
  });

  it.each([
    ["install"], ["install", "--dry-run"], ["uninstall"], ["uninstall", "--dry-run"],
    ["mcp"], ["daemon", "start"], ["daemon", "restart"], ["daemon", "start", "--foreground"],
  ])("runs lifecycle action %#", async (...args) => {
    const error = await invoke(args);
    if (args[0] === "daemon" && args[2] !== "--foreground") expect(error?.message).toBe("exit:0");
    else expect(error).toBeUndefined();
  });

  it.each([
    ["compact", "--dry-run", "--verbose", "--replay", "--no-promote"],
    ["events", "promote"], ["events", "promote", "--all", "--json"],
    ["import"], ["import", "--codex", "--dry-run", "--verbose", "--replay"], ["import", "--provider", "all", "--all"],
    ["promote"], ["promote", "--all", "--verbose", "--dry-run"],
    ["export"], ["export", "--tags", "one, two", "--since", "2026-01-01", "--output", "out.json"], ["export", "--all"],
  ])("runs batch action %#", async (...args) => {
    expect(await invoke(args)).toBeUndefined();
  });

  it("runs supported manual provider overrides", async () => {
    state.provider = "auto";
    expect(await invoke(["compact", "--all", "--reasoning-effort", "low", "--fast-mode"])).toBeUndefined();
  });

  it("runs doctor success and failure exits", async () => {
    expect((await invoke(["doctor", "--verbose", "--events-max-dbs", "all"]))?.message).toBe("exit:0");
    expect((await invoke(["doctor", "--events-max-dbs", "unlimited"]))?.message).toBe("exit:0");
    state.doctorResults = [{ status: "fail" }];
    expect((await invoke(["doctor"]))?.message).toBe("exit:1");
  });

  it("validates and imports portable knowledge", async () => {
    state.fileText = JSON.stringify({ version: 1, entries: [{ id: "one" }] });
    expect((await invoke(["import-knowledge", "input.json", "--dry-run"]))?.message).toBe("exit:0");
    expect(await invoke(["import-knowledge", "input.json", "--confidence", "0.5"])).toBeUndefined();
  });
});

describe("runCli failure and alternate presentation branches", () => {
  it("covers piped hook input and empty hook output", async () => {
    fakeStdin.isTTY = false;
    fakeStdin.on.mockImplementation((event: string, callback: (chunk?: Buffer) => void) => {
      if (event === "data") queueMicrotask(() => callback(Buffer.from('{"session_id":"one"}')));
      if (event === "end") queueMicrotask(() => callback());
      return fakeStdin;
    });
    state.dispatchHook.mockResolvedValueOnce({ stdout: "", exitCode: 0 });
    expect((await invoke(["restore", "--client", "codex"]))?.message).toBe("exit:0");
  });

  it("covers daemon start and restart outcomes", async () => {
    state.ensureDaemon.mockResolvedValueOnce({ connected: false, spawned: false, restartedForParent: false, pid: undefined, warning: "blocked" });
    expect((await invoke(["daemon", "start"]))?.message).toBe("exit:1");
    state.ensureDaemon.mockResolvedValueOnce({ connected: true, spawned: false, restartedForParent: true, pid: undefined, warning: "moved" });
    expect((await invoke(["daemon", "start"]))?.message).toBe("exit:0");
    state.ensureDaemon.mockResolvedValueOnce({ connected: true, spawned: true, restartedForParent: false, pid: undefined });
    expect((await invoke(["daemon", "start"]))?.message).toBe("exit:0");
    state.ensureDaemon.mockResolvedValueOnce({ connected: true, spawned: false, restartedForParent: false, pid: undefined });
    expect((await invoke(["daemon", "start"]))?.message).toBe("exit:0");
    state.ensureDaemon.mockResolvedValueOnce({ connected: false, spawned: false, restartedForParent: false, pid: undefined });
    expect((await invoke(["daemon", "start"]))?.message).toBe("exit:1");

    state.restartDaemon.mockResolvedValueOnce({ connected: false, restarted: false, spawned: false, pid: undefined, warning: "blocked" });
    expect((await invoke(["daemon", "restart"]))?.message).toBe("exit:1");
    state.restartDaemon.mockResolvedValueOnce({ connected: true, restarted: false, spawned: true, pid: undefined, warning: "started" });
    expect((await invoke(["daemon", "restart"]))?.message).toBe("exit:0");
    state.restartDaemon.mockResolvedValueOnce({ connected: true, restarted: false, spawned: false, pid: undefined });
    expect((await invoke(["daemon", "restart"]))?.message).toBe("exit:0");
    state.restartDaemon.mockResolvedValueOnce({ connected: false, restarted: false, spawned: false, pid: undefined });
    expect((await invoke(["daemon", "restart"]))?.message).toBe("exit:1");
  });

  it("omits invalid package versions from daemon expectations", async () => {
    state.packageVersion = 1;
    expect((await invoke(["daemon", "start"]))?.message).toBe("exit:0");
    expect((await invoke(["daemon", "restart"]))?.message).toBe("exit:0");
  });

  it("covers configuration failures without leaking thrown values", async () => {
    state.configGetError = new Error("get failed");
    expect((await invoke(["config", "get", "x"]))?.message).toBe("exit:1");
    state.configGetError = undefined;
    state.configSetError = "set failed";
    expect((await invoke(["config", "set", "x", "y"]))?.message).toBe("exit:1");
    state.configSetError = new Error("set failed");
    expect((await invoke(["config", "set", "x", "y"]))?.message).toBe("exit:1");
    state.configSetError = undefined;
    state.configGetError = "get failed";
    expect((await invoke(["config", "get", "x"]))?.message).toBe("exit:1");
  });

  it("covers compact validation and daemon failures", async () => {
    expect((await invoke(["compact", "--reasoning-effort", "max"]))?.message).toBe("exit:1");
    state.provider = "openai";
    expect((await invoke(["compact", "--fast-mode"]))?.message).toBe("exit:1");
    expect((await invoke(["compact", "--no-fast-mode"]))?.message).toBe("exit:1");
    state.ensureDaemon.mockResolvedValueOnce({ connected: false, spawned: false, restartedForParent: false, pid: undefined });
    expect((await invoke(["compact"]))?.message).toBe("exit:1");
    state.provider = "disabled";
    expect((await invoke(["compact", "--reasoning-effort", "max"]))?.message).toBe("exit:1");
  });

  it("covers daemon-down status and pool failures", async () => {
    state.health.mockResolvedValueOnce(false);
    expect(await invoke(["status"])).toBeUndefined();
    state.get.mockRejectedValueOnce(new Error("pool failed"));
    expect((await invoke(["stats", "--pool"]))?.message).toBe("exit:1");
    state.get.mockRejectedValueOnce("pool failed");
    expect((await invoke(["stats", "--pool"]))?.message).toBe("exit:1");
  });

  it("covers event result variants", async () => {
    state.post.mockResolvedValueOnce({ promoted: 1, skipped: 0, errors: 1, batches: 2, message: "partial", incomplete: true });
    expect((await invoke(["events", "promote"]))?.message).toBe("exit:1");
    state.post.mockResolvedValueOnce({ promoted: 1, skipped: 0, errors: 0, processedProjects: 2, failedProjects: 1, orphanedProjects: 1 });
    expect((await invoke(["events", "promote", "--all"]))?.message).toBe("exit:1");
    state.post.mockResolvedValueOnce({ promoted: 0, skipped: 0, errors: 1, processedProjects: 0 });
    expect(await invoke(["events", "promote", "--all", "--json"])).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  it("covers connector alternate and failure outcomes", async () => {
    state.installResult = { manual: "manual steps" };
    expect(await invoke(["connectors", "install", "codex", "--global"])).toBeUndefined();
    state.installResult = { paths: ["/one", ""], requiresRestart: true };
    expect(await invoke(["connectors", "install", "codex", "--type", "hook"])).toBeUndefined();
    state.removeResult = false;
    expect(await invoke(["connectors", "remove", "codex", "--global"])).toBeUndefined();
    state.installed = [{ agentId: "codex", type: "hook", path: "/hook" }];
    expect(await invoke(["connectors", "list"])).toBeUndefined();
    expect(await invoke(["connectors", "list", "--format", "json"])).toBeUndefined();
    expect(await invoke(["connectors", "doctor", "codex"])).toBeUndefined();
  });

  it("runs foreground cleanup and signal callbacks", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const on = vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(event, listener);
      return process;
    }) as typeof process.on);
    state.fileText = String(process.pid);
    expect(await invoke(["daemon", "start", "--foreground"])).toBeUndefined();
    expect(() => handlers.get("exit")?.()).not.toThrow();
    state.fileText = "different-pid";
    expect(() => handlers.get("exit")?.()).not.toThrow();
    expect(() => handlers.get("SIGTERM")?.()).toThrow("exit:0");
    expect(() => handlers.get("SIGINT")?.()).toThrow("exit:0");
    on.mockRestore();
  });

  it("executes restart preflight validation", async () => {
    state.restartDaemon.mockImplementationOnce(async (options: { validateBeforeRestart?: () => void }) => {
      options.validateBeforeRestart?.();
      return { connected: true, restarted: true, spawned: false, pid: 42 };
    });
    expect((await invoke(["daemon", "restart"]))?.message).toBe("exit:0");
  });

  it("rejects import provider and unavailable daemon", async () => {
    expect((await invoke(["import", "--provider", "bad"]))?.message).toBe("exit:1");
    state.ensureDaemon.mockResolvedValueOnce({ connected: false, spawned: false, restartedForParent: false, pid: undefined });
    expect((await invoke(["import"]))?.message).toBe("exit:1");
    state.ensureDaemon.mockResolvedValueOnce({ connected: false, spawned: false, restartedForParent: false, pid: undefined });
    expect((await invoke(["promote"]))?.message).toBe("exit:1");
  });

  it("validates malformed portable knowledge", async () => {
    expect((await invoke(["import-knowledge", "x", "--confidence", "2"]))?.message).toBe("exit:1");
    state.fileText = "not-json";
    expect((await invoke(["import-knowledge", "x"]))?.message).toBe("exit:1");
    state.fileText = JSON.stringify({ version: "bad", entries: [] });
    expect((await invoke(["import-knowledge", "x"]))?.message).toBe("exit:1");
    state.readError = new Error("denied");
    expect((await invoke(["import-knowledge", "x"]))?.message).toBe("exit:1");
  });

  it("walks metadata-backed projects for compact, import, promote, and export", async () => {
    state.entries = [
      { name: "file", isDirectory: () => false },
      { name: "project", isDirectory: () => true },
    ];
    state.fileText = JSON.stringify({ cwd: "/project" });
    state.post.mockResolvedValue({ processed: 2, promoted: 2, conversations: 2, errors: 0, skipped: 0 });

    expect(await invoke(["compact", "--all"])).toBeUndefined();
    expect(await invoke(["import", "--all", "--provider", "claude"])).toBeUndefined();
    expect(await invoke(["promote", "--all", "--verbose", "--dry-run"])).toBeUndefined();
    expect(await invoke(["export", "--all"])).toBeUndefined();
  });

  it("renders TTY summaries for compact and import", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    try {
      expect(await invoke(["compact", "--no-promote"])).toBeUndefined();
      expect(await invoke(["import"])).toBeUndefined();
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  it("keeps best-effort promotion and export failures non-fatal", async () => {
    state.post.mockRejectedValueOnce(new Error("promote failed"));
    expect(await invoke(["compact"])).toBeUndefined();
    state.post.mockRejectedValueOnce("promote failed");
    expect(await invoke(["promote", "--verbose"])).toBeUndefined();
    state.exportError = new Error("export failed");
    expect(await invoke(["export"])).toBeUndefined();
  });

  it("reports portable import dry-run results and import failures", async () => {
    state.fileText = JSON.stringify({ version: 1, entries: [{ id: "one" }] });
    state.portableResult = { exported: 0, imported: 0, skipped: 0, total: 1, dryRun: true };
    expect(await invoke(["import-knowledge", "x"])).toBeUndefined();
    state.importKnowledgeError = new Error("import failed");
    expect((await invoke(["import-knowledge", "x"]))?.message).toBe("exit:1");
  });

  it("uses default daemon ports at every client boundary", async () => {
    state.daemonPort = undefined;
    expect(await invoke(["search", "q"])).toBeUndefined();
    expect((await invoke(["daemon", "start"]))?.message).toBe("exit:0");
    expect((await invoke(["daemon", "restart"]))?.message).toBe("exit:0");
    expect(await invoke(["compact", "--no-promote"])).toBeUndefined();
    expect(await invoke(["import"])).toBeUndefined();
    expect(await invoke(["promote"])).toBeUndefined();
  });

  it("covers quiet progress callbacks and hook outputs", async () => {
    state.batchProgressLast = false;
    expect(await invoke(["compact", "--no-promote"])).toBeUndefined();
    state.importProgressLast = false;
    expect(await invoke(["import"])).toBeUndefined();
    for (const command of ["session-end", "user-prompt", "post-tool", "session-snapshot", "compact"] as const) {
      state.dispatchHook.mockResolvedValueOnce({ stdout: "", exitCode: 0 });
      const args = command === "compact" ? [command, "--hook"] : [command];
      expect((await invoke(args))?.message).toBe("exit:0");
    }
    state.sensitiveStdout = "";
    expect((await invoke(["sensitive", "list"]))?.message).toBe("exit:0");
  });

  it("covers compact, status, and pool presentation alternatives", async () => {
    state.post.mockResolvedValueOnce({ processed: 1, promoted: 0 });
    expect(await invoke(["compact"])).toBeUndefined();
    state.post.mockResolvedValueOnce({ processed: 1, promoted: 1 });
    expect(await invoke(["compact"])).toBeUndefined();
    state.provider = "auto";
    state.post.mockResolvedValueOnce({
      daemon: { version: "1", uptime: 1, port: 3737 },
      project: { messageCount: 0, summaryCount: 0, promotedCount: 0 },
    });
    expect(await invoke(["status"])).toBeUndefined();
    state.provider = undefined as never;
    state.health.mockResolvedValueOnce(false);
    expect(await invoke(["status"])).toBeUndefined();
    state.health.mockResolvedValueOnce(false);
    expect(await invoke(["status", "--json"])).toBeUndefined();
    state.get.mockResolvedValueOnce({ totalConnections: 1, activeConnections: 0, idleConnections: 1, connections: [{ refs: 0, status: "idle", path: "/idle" }] });
    expect(await invoke(["stats", "--pool"])).toBeUndefined();
    state.get.mockResolvedValueOnce({ totalConnections: 0, activeConnections: 0, idleConnections: 0, connections: [] });
    expect(await invoke(["stats", "--pool"])).toBeUndefined();
  });

  it("covers plural and missing event result fields", async () => {
    state.post.mockResolvedValueOnce({ promoted: 2, skipped: 1, errors: undefined, processedProjects: 2, failedProjects: undefined, orphanedProjects: 2 });
    expect(await invoke(["events", "promote", "--all"])).toBeUndefined();
    state.post.mockResolvedValueOnce({ promoted: 2, skipped: 0, errors: undefined });
    expect(await invoke(["events", "promote"])).toBeUndefined();
    state.post.mockResolvedValueOnce({ promoted: 1, skipped: 0, errors: 0, processedProjects: 1, orphanedProjects: 0 });
    expect(await invoke(["events", "promote", "--all"])).toBeUndefined();
  });

  it("handles absent project directories and promotion conversation labels", async () => {
    state.exists = false;
    expect(await invoke(["compact", "--all"])).toBeUndefined();
    expect(await invoke(["import", "--all"])).toBeUndefined();
    expect(await invoke(["promote", "--all"])).toBeUndefined();
    expect(await invoke(["export", "--all"])).toBeUndefined();
    expect(await invoke(["import"])).toBeUndefined();
    state.exists = true;
    state.post.mockResolvedValueOnce({ processed: 1, promoted: 0, conversations: 1 });
    expect(await invoke(["promote", "--verbose"])).toBeUndefined();
    state.post.mockResolvedValueOnce({ processed: 1, promoted: 0 });
    expect(await invoke(["promote", "--verbose"])).toBeUndefined();
    state.post.mockRejectedValueOnce(new Error("failed"));
    expect(await invoke(["promote", "--verbose"])).toBeUndefined();
    state.post.mockRejectedValueOnce(new Error("failed"));
    expect(await invoke(["promote"])).toBeUndefined();
  });
});
