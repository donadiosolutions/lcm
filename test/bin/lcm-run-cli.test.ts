import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigValidationError } from "../../src/daemon/config.js";
import { StorageBackendUnavailableError } from "../../src/storage/backend.js";

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
  health: vi.fn(async (): Promise<unknown> => true),
  dispatchHook: vi.fn(async () => ({ stdout: "hook-output", exitCode: 0 })),
  loadConfig: vi.fn(() => ({
    daemon: state.daemonPort === undefined ? undefined : { port: state.daemonPort },
    storage: { backend: state.storageBackend },
    llm: {
      provider: state.provider, apiMode: "responses", requestTimeoutMs: 1000,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2 },
    },
    compaction: { autoCompactMinTokens: 100 },
  })),
  loadPolicyConfig: vi.fn(() => ({
    llm: {
      provider: state.provider, requestTimeoutMs: 1000,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2 },
    },
  })),
  fileText: JSON.stringify({ version: "1.4.0", entries: [] }),
  installed: [] as Array<{ agentId: string; type: string; path: string }>,
  installResult: { path: "/connector", requiresRestart: false } as Record<string, unknown>,
  removeResult: true,
  batchResult: { compacted: 1, unchanged: 0, skipped: 0, failures: 0, compactedProjects: ["/project"] },
  importResult: { imported: 1, skipped: 0 },
  portableResult: { exported: 1, imported: 1, skipped: 0, total: 1, dryRun: false },
  provider: "openai",
  entries: [] as Array<{ name: string; isDirectory: () => boolean }>,
  exists: true,
  readError: undefined as Error | undefined,
  doctorResults: [{ status: "pass" }],
  configGetError: undefined as unknown,
  configSetError: undefined as unknown,
  configGetValue: vi.fn(() => {
    if (state.configGetError !== undefined) throw state.configGetError;
    return "value";
  }),
  configSetValue: vi.fn(() => {
    if (state.configSetError !== undefined) throw state.configSetError;
    return "stored";
  }),
  exportError: undefined as Error | undefined,
  importKnowledgeError: undefined as Error | undefined,
  daemonPort: 3737 as number | undefined,
  batchProgressLast: true,
  importProgressLast: true,
  sensitiveStdout: "sensitive",
  packageVersion: "1.4.0" as unknown,
  storageBackend: "sqlite" as "sqlite" | "postgresql",
  provisionResult: {
    applied: ["0001_migration_ledger"],
    current: ["0001_migration_ledger"],
  },
  provisionError: undefined as unknown,
  reconcileWorktrees: vi.fn(),
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
vi.mock("../../src/config-projection.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/config-projection.js")>()),
  loadStoredLlmRequestPolicyConfig: state.loadPolicyConfig,
}));
vi.mock("../../src/daemon/lifecycle.js", () => ({ ensureDaemon: state.ensureDaemon, restartDaemon: state.restartDaemon }));
vi.mock("../../src/cli-help.js", () => ({ printHelp: state.printHelp }));
vi.mock("../../src/hooks/dispatch.js", () => ({ dispatchHook: state.dispatchHook }));
vi.mock("../../src/mcp/server.js", () => ({ startMcpServer: vi.fn(async () => undefined) }));
vi.mock("../../src/batch-compact.js", (): { batchCompact: ReturnType<typeof vi.fn> } => ({ batchCompact: vi.fn(async (options: { onProgress?: (patch: unknown) => void }): Promise<typeof state.batchResult> => {
  options.onProgress?.(state.batchProgressLast ? { lastResult: { ok: true } } : {});
  return state.batchResult;
}) }));
vi.mock("../../src/cli/progress-state.js", () => ({ makeProgressState: vi.fn((value: Record<string, unknown>) => ({
  total: 0, completed: 0, errors: [], phaseErrors: [], tokensIn: 0, tokensOut: 0, messagesIn: 0, ...value,
})) }));
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
  getConfigValue: state.configGetValue,
  formatConfigValue: vi.fn((value: unknown) => JSON.stringify(value)), normalizeConfigPath: vi.fn((path: string) => path),
  setConfigValue: state.configSetValue,
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
vi.mock("../../src/import-summary.js", () => ({
  printImportSummary: vi.fn(),
  printCodexResolutionSummary: vi.fn(),
}));
vi.mock("../../src/portable-knowledge.js", () => ({
  exportKnowledge: vi.fn(async () => { if (state.exportError) throw state.exportError; return state.portableResult; }),
  importKnowledge: vi.fn(async () => { if (state.importKnowledgeError) throw state.importKnowledgeError; return state.portableResult; }),
}));
vi.mock("../../src/worktree-reconciliation.js", () => ({
  reconcileWorktrees: state.reconcileWorktrees,
}));
vi.mock("../../src/storage/postgresql/provisioning.js", () => ({
  provisionPostgreSql: vi.fn(async () => {
    if (state.provisionError !== undefined) throw state.provisionError;
    return state.provisionResult;
  }),
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
  state.storageBackend = "sqlite";
  state.provisionResult = {
    applied: ["0001_migration_ledger"],
    current: ["0001_migration_ledger"],
  };
  state.provisionError = undefined;
  state.batchResult = { compacted: 1, unchanged: 0, skipped: 0, failures: 0, compactedProjects: ["/project"] };
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
    const genericError = new Error("boom");
    const configError = new ConfigValidationError("cli", "invalid");
    const backendError = new StorageBackendUnavailableError("postgresql");
    expect(() => handleCliError(genericError)).toThrow("exit:1");
    expect(() => handleCliError(configError)).toThrow("exit:1");
    expect(() => handleCliError(backendError)).toThrow("exit:1");
    expect(() => writeCliOutput("out")).not.toThrow();
    expect(() => writeCliError("err")).not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(3);
    expect(consoleError).toHaveBeenNthCalledWith(1, genericError);
    expect(consoleError).toHaveBeenNthCalledWith(2, configError.message);
    expect(consoleError).toHaveBeenNthCalledWith(3, backendError.message);
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

  it("waits for the unknown-command fallback before settling", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const order: string[] = [];
    state.printHelp.mockImplementationOnce(() => { order.push("help"); });
    state.exit.mockImplementationOnce((() => { order.push("exit"); }) as never);
    const result = await invoke(["unknown"]).then(error => {
      order.push("settled");
      return error;
    });

    expect(result).toBeUndefined();
    expect(order).toEqual(["help", "exit", "settled"]);
    expect(stderr).toHaveBeenCalledWith("lcm: unknown command 'unknown'\n\n");
  });

  it.each([
    [[], undefined], [["--help"], undefined], [["help"], undefined], [["help", "compact"], "compact"],
    [["daemon", "--help"], "daemon"], [["daemon", "start", "--help"], "daemon"], [["daemon", "restart", "--help"], "daemon"],
    [["machine", "--help"], "machine"], [["machine", "register", "--help"], "machine"],
    [["machine", "show", "--help"], "machine"], [["machine", "recover", "--help"], "machine"],
    [["project", "--help"], "project"], [["project", "list", "--help"], "project"],
    [["project", "show", "--help"], "project"], [["project", "link", "--help"], "project"],
    [["project", "unlink", "--help"], "project"], [["project", "create", "--help"], "project"],
    [["postgres", "--help"], "postgres"], [["postgres", "migrate", "--help"], "postgres"],
    [["connectors", "list", "--help"], "connectors"], [["connectors", "install", "--help"], "connectors"],
    [["connectors", "remove", "--help"], "connectors"], [["connectors", "doctor", "--help"], "connectors"],
    [["config", "get", "daemon.port", "--help"], "config"],
    [["config", "set", "daemon.port", "4242", "-h"], "config"],
    [["config"], "config"],
    [["compact", "--help"], "compact"], [["restore", "--help"], "restore"], [["session-end", "--help"], "session-end"],
    [["user-prompt", "--help"], "user-prompt"], [["post-tool", "--help"], "post-tool"], [["session-snapshot", "--help"], "session-snapshot"],
    [["mcp", "--help"], "mcp"], [["install", "--help"], "install"], [["uninstall", "--help"], "uninstall"], [["status", "--help"], "status"],
    [["stats", "--help"], "stats"], [["doctor", "--help"], "doctor"], [["events", "--help"], "events"], [["events", "promote", "--help"], "events"],
    [["diagnose", "--help"], "diagnose"], [["connectors", "--help"], "connectors"], [["sensitive", "--help"], "sensitive"], [["import", "--help"], "import"],
    [["promote", "--help"], "promote"], [["export", "--help"], "export"], [["import-knowledge", "x", "--help"], "import-knowledge"],
    [["search", "q", "--help"], "search"], [["grep", "q", "--help"], "grep"], [["describe", "n", "--help"], "describe"],
    [["expand", "n", "--help"], "expand"], [["store", "text", "--help"], "store"],
  ] as const)("routes custom help for %#", async (args, expectedCommand) => {
    expect((await invoke(args))?.message).toBe("exit:0");
    expect(state.exit).toHaveBeenCalledOnce();
    expect(state.exit).toHaveBeenCalledWith(0);
    expect(state.printHelp).toHaveBeenCalledOnce();
    if (expectedCommand === undefined && args[0] !== "help") {
      expect(state.printHelp.mock.calls[0]).toEqual([undefined]);
    } else {
      expect(state.printHelp).toHaveBeenCalledWith(expectedCommand);
    }
    if (args[0] === "config" && args.length > 2) {
      expect(state.configGetValue).not.toHaveBeenCalled();
      expect(state.configSetValue).not.toHaveBeenCalled();
    }
  });

  it("rejects removed map help through the unknown-command path", async () => {
    expect((await invoke(["map", "add", "--help"]))?.message).toBe("exit:1");
    expect(state.printHelp).toHaveBeenCalledWith();
    expect(state.printHelp).not.toHaveBeenCalledWith("map");
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
    ["search", "q"],
    ["grep", "q"],
    ["describe", "node"],
    ["expand", "node"],
    ["store", "memory"],
    ["stats", "--pool"],
    ["events", "promote"],
  ])("rejects daemon-backed command %# before lifecycle mutation when PostgreSQL is selected", async (...args) => {
    state.storageBackend = "postgresql";

    await expect(runCli(["node", "lcm", ...args])).rejects.toBeInstanceOf(StorageBackendUnavailableError);
    expect(state.ensureDaemon).not.toHaveBeenCalled();
    expect(state.health).not.toHaveBeenCalled();
    expect(state.get).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
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
  it("refuses normal stats when the effective backend is unavailable", async () => {
    state.loadConfig.mockReturnValueOnce({ storage: { backend: "postgresql" } });

    await expect(runCli(["node", "lcm", "stats"])).rejects.toBeInstanceOf(StorageBackendUnavailableError);
  });

  it.each(["start", "restart"])("runs managed daemon %s with staged PostgreSQL storage", async (action) => {
    state.loadConfig.mockReturnValueOnce({ daemon: { port: 3737 }, storage: { backend: "postgresql" } });

    expect((await invoke(["daemon", action]))?.message).toBe("exit:0");
    const lifecycle = action === "start" ? state.ensureDaemon : state.restartDaemon;
    expect(lifecycle).toHaveBeenCalledWith(expect.objectContaining({
      port: 3737,
      expectedStorageBackend: "postgresql",
    }));
  });

  it.each([
    ["restore"], ["session-end", "--client", "codex"], ["user-prompt"], ["post-tool"],
    ["session-snapshot"], ["compact", "--hook", "--client", "claude"],
  ])("dispatches hook action %#", async (...args) => {
    expect((await invoke(args))?.message).toBe("exit:0");
  });

  it("dispatches PreCompact without resolving PostgreSQL storage secrets", async () => {
    state.storageBackend = "postgresql";
    const loadConfig = state.loadConfig.getMockImplementation()!;
    state.loadConfig.mockImplementation(() => {
      throw new ConfigValidationError("LCM_POSTGRES_URL", "must be set");
    });

    try {
      expect((await invoke(["compact", "--hook"]))?.message).toBe("exit:0");
      expect(state.loadConfig).not.toHaveBeenCalled();
      expect(state.loadPolicyConfig).not.toHaveBeenCalled();

      expect((await invoke(["compact", "--hook", "--timeout-ms", "2000"]))?.message).toBe("exit:0");
      expect(state.loadConfig).not.toHaveBeenCalled();
      expect(state.loadPolicyConfig).toHaveBeenCalledOnce();
      expect(state.loadPolicyConfig).toHaveBeenLastCalledWith("/lcm/config.json");
      expect(JSON.parse(state.dispatchHook.mock.calls.at(-1)![1])).toMatchObject({
        request_timeout_ms: 2000,
      });
    } finally {
      state.loadConfig.mockImplementation(loadConfig);
    }
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

  it("rejects portable CLI operations before dispatch when PostgreSQL is selected", async () => {
    const portable = await import("../../src/portable-knowledge.js");
    state.storageBackend = "postgresql";

    expect(await invoke(["export", "--all"])).toBeInstanceOf(StorageBackendUnavailableError);
    expect(await invoke(["import-knowledge", "input.json"])).toBeInstanceOf(StorageBackendUnavailableError);
    expect(portable.exportKnowledge).not.toHaveBeenCalled();
    expect(portable.importKnowledge).not.toHaveBeenCalled();
  });

  it.each([
    ["compact", "--dry-run"],
    ["import", "--dry-run"],
    ["promote", "--dry-run"],
  ])("rejects direct daemon command %# before lifecycle or daemon network activity", async (...args) => {
    state.storageBackend = "postgresql";

    expect(await invoke(args)).toBeInstanceOf(StorageBackendUnavailableError);
    expect(state.ensureDaemon).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
    expect(state.get).not.toHaveBeenCalled();
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

  it("reports a staged PostgreSQL daemon as up with unavailable storage", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stagedHealth = {
      status: "unavailable",
      version: "1.4.1",
      storageBackend: "postgresql",
      uptime: 10,
      pid: 1234,
      storage: { status: "unavailable" },
    };
    state.storageBackend = "postgresql";

    state.health.mockResolvedValueOnce(stagedHealth);
    expect(await invoke(["status"])).toBeUndefined();
    const text = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(text).toContain("Daemon: up");
    expect(text).toContain("Storage: postgresql (unavailable)");
    expect(text).not.toContain("Project:");
    expect(state.post).not.toHaveBeenCalled();

    log.mockClear();
    state.health.mockResolvedValueOnce(stagedHealth);
    expect(await invoke(["status", "--json"])).toBeUndefined();
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toEqual({
      daemon: {
        status: "up",
        version: "1.4.1",
        uptime: 10,
        port: 3737,
        storageBackend: "postgresql",
        storageStatus: "unavailable",
      },
    });
    expect(state.post).not.toHaveBeenCalled();
  });

  it("runs the supported PostgreSQL migration command in text and JSON modes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    state.storageBackend = "postgresql";

    expect(await invoke(["postgres", "migrate"])).toBeUndefined();
    expect(log.mock.calls.map(([message]) => String(message)).join("\n"))
      .toContain("Applied 1 PostgreSQL migration: 0001_migration_ledger");

    state.provisionResult = {
      applied: ["0001_migration_ledger", "0002_schema_baseline"],
      current: ["0001_migration_ledger", "0002_schema_baseline"],
    };
    log.mockClear();
    expect(await invoke(["postgres", "migrate"])).toBeUndefined();
    expect(log.mock.calls.map(([message]) => String(message)).join("\n"))
      .toContain("Applied 2 PostgreSQL migrations: 0001_migration_ledger, 0002_schema_baseline");

    state.provisionResult = {
      applied: [],
      current: ["0001_migration_ledger"],
    };
    log.mockClear();
    expect(await invoke(["postgres", "migrate"])).toBeUndefined();
    expect(log).toHaveBeenCalledWith("PostgreSQL schema is current.");

    expect(await invoke(["postgres", "migrate", "--json"])).toBeUndefined();
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toEqual({
      backend: "postgresql",
      applied: [],
      current: ["0001_migration_ledger"],
    });
  });

  it("reports PostgreSQL migration errors in text and JSON modes", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    state.provisionError = new Error("migration unavailable");

    expect((await invoke(["postgres", "migrate"]))?.message).toBe("exit:1");
    expect(stderr).toHaveBeenCalledWith("Error: migration unavailable");
    expect((await invoke(["postgres", "migrate", "--json"]))?.message).toBe("exit:1");
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toEqual({
      error: "migration unavailable",
    });

    state.provisionError = "migration unavailable";
    expect((await invoke(["postgres", "migrate"]))?.message).toBe("exit:1");
    expect((await invoke(["postgres"]))?.message).toBe("exit:1");
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
    state.post
      .mockResolvedValueOnce({ processed: 2, promoted: 2 })
      .mockResolvedValueOnce({ processed: 2, promoted: 2, conversations: 2, errors: 0, skipped: 0 });

    expect(await invoke(["compact", "--all"])).toBeUndefined();
    expect(await invoke(["import", "--all", "--provider", "claude"])).toBeUndefined();
    expect(await invoke(["promote", "--all", "--verbose", "--dry-run"])).toBeUndefined();
    expect(state.reconcileWorktrees).not.toHaveBeenCalled();
    expect(await invoke(["export", "--all"])).toBeUndefined();
    expect(state.reconcileWorktrees).toHaveBeenCalledOnce();
    expect(state.reconcileWorktrees).toHaveBeenCalledWith(process.cwd());
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

  it("fails compact when automatic promotion fails while keeping explicit promote best-effort", async () => {
    state.post.mockRejectedValueOnce(new Error("promote failed"));
    expect(await invoke(["compact"])).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    state.post.mockRejectedValueOnce("promote failed");
    expect(await invoke(["compact"])).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
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
