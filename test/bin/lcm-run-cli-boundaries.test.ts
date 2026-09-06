import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const state = vi.hoisted(() => ({
  exit: vi.fn((code?: string | number | null): never => { throw new Error(`exit:${code ?? 0}`); }),
  killProcess: vi.fn((_pid: number, _signal: 0): never => {
    throw Object.assign(new Error("process absent"), { code: "ESRCH" });
  }),
  ensureDaemon: vi.fn(async () => ({ connected: true, spawned: false, restartedForParent: false, pid: 42 })),
  restartDaemon: vi.fn(async () => ({ connected: true, restarted: true, spawned: false, pid: 42 })),
  createDaemon: vi.fn(async () => ({ address: () => ({ port: 3737 }), stop: vi.fn() })),
  post: vi.fn(async () => ({ processed: 1, promoted: 1 })),
  get: vi.fn(async () => ({ totalConnections: 1, activeConnections: 0, idleConnections: 1, connections: [] })),
  health: vi.fn(async () => true),
  startInvocation: vi.fn(async (target: unknown) => ({ ...target as object, state: "active", activeCount: 0, workCount: 0, commitCount: 0, leaseExpiresAt: null })),
  heartbeatInvocation: vi.fn(async (target: unknown) => ({ ...target as object, state: "active", activeCount: 0, workCount: 0, commitCount: 0, leaseExpiresAt: null })),
  cancelInvocation: vi.fn(async (target: unknown) => ({ ...target as object, state: "cancelled", activeCount: 0, workCount: 0, commitCount: 0, leaseExpiresAt: null })),
  finishInvocation: vi.fn(async (target: unknown) => ({ ...target as object, state: "finished", activeCount: 0, workCount: 0, commitCount: 0, leaseExpiresAt: null })),
  readAuthToken: vi.fn(() => state.authToken),
  authToken: "test-token" as string | null,
  migrateLegacyHome: vi.fn(),
  loadConfig: vi.fn(() => ({
    daemon: { port: 3737 },
    storage: { backend: "sqlite" },
    llm: {
      provider: "openai", apiMode: "responses", requestTimeoutMs: 1000,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2 },
    },
    compaction: { autoCompactMinTokens: 1 },
  })),
  fileText: "{}",
  packageVersion: "1.4.0" as unknown,
  readError: undefined as unknown,
  files: new Map<string, string>(),
  exists: new Set<string>(),
  entries: [] as Array<{ name: string; isDirectory: () => boolean }>,
  projectList: vi.fn(async () => ({
    local: [{ hash: "hash", canonical: "/canonical", aliases: ["/alias"], remoteProjectId: "remote-id" }],
    remote: [{ projectId: "remote-id", displayName: "Remote", aliases: [{ machineId: "machine-id", path: "/canonical" }] }],
  })),
  projectShow: vi.fn(async () => ({
    hash: "hash",
    entry: { canonical: "/canonical", aliases: ["/alias"], remoteProjectId: "remote-id" },
    remote: { projectId: "remote-id", displayName: "Remote", aliases: [] },
  })),
  projectLink: vi.fn(async () => ({
    local: { id: "hash", canonical: "/canonical", aliases: ["/alias"], remoteProjectId: "remote-id" },
  })),
  projectUnlink: vi.fn(async () => ({ hash: "hash", remoteProjectId: "remote-id", aliasRemoved: true })),
  projectCreate: vi.fn(async () => ({
    local: { id: "hash", canonical: "/canonical", aliases: [], remoteProjectId: "remote-id" },
    remote: { projectId: "remote-id", displayName: "Remote", aliases: [] },
  })),
  reconcileWorktrees: vi.fn(() => ({
    status: "completed",
    targetHash: "target-hash",
    canonical: "/canonical",
    sourceHashes: ["source-hash"],
    aliases: ["/canonical", "/alias"],
    journalPath: "/lcm/reconciliations/target-hash.json",
    backupPaths: ["/lcm/oldprojects/source"],
    reason: "completed after retry",
  })),
  machineRegister: vi.fn(async () => ({
    identity: { version: 1, machineId: "machine-id", displayName: "Workstation", identityKey: "secret" },
    created: true,
  })),
  machineShow: vi.fn(() => ({
    version: 1, machineId: "machine-id", displayName: "Workstation", identityKey: "secret",
  })),
  machineRecover: vi.fn(async () => ({
    identity: { version: 1, machineId: "machine-id", displayName: "Workstation", identityKey: "secret" },
    backupPath: "/lcm/machine.json.backup",
  })),
  installConnector: vi.fn(() => ({ path: "/hook", requiresRestart: false })),
  removeConnector: vi.fn(() => true),
  installed: [] as Array<{ agentId: string; type: string; path: string }>,
  storedCodexTransport: undefined as "cli" | "mcp" | undefined,
  batchResult: { compacted: 1, unchanged: 0, skipped: 0, failures: 0, compactedProjects: ["/good"] },
  batchError: undefined as unknown,
  batchGate: undefined as Promise<void> | undefined,
  batchOptions: undefined as unknown,
  batchPatch: { lastResult: { ok: true } } as Record<string, unknown>,
  batchTransportFailure: undefined as unknown,
  batchSignal: undefined as "SIGINT" | "SIGTERM" | undefined,
  providerWitnessReads: [] as Array<{ available: boolean; providers: unknown[] } | Error>,
  providerWitnessReconciles: [] as Array<{ available: boolean; providers: unknown[] } | Error>,
  portableResult: { exported: 1, imported: 1, skipped: 0, total: 1, dryRun: false },
  importResult: { imported: 1, skipped: 0 },
  importPatch: { lastResult: { ok: true } } as Record<string, unknown>,
  renderer: { start: vi.fn(), stop: vi.fn(), sessionDone: vi.fn(), printSummary: vi.fn() },
  rendererOptions: undefined as unknown,
  progressState: undefined as undefined | Record<string, unknown>,
  writeFile: vi.fn(), unlink: vi.fn(), mkdir: vi.fn(),
  dispatchHook: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
}));

vi.mock("../../src/daemon/version.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/daemon/version.js")>()),
  PKG_VERSION: "1.4.2",
  PACKAGED_RUNTIME_ENTRYPOINT: "/daemon",
  RUNTIME_DIGEST: "runtime",
}));

const fakeStdin = vi.hoisted(() => ({ isTTY: true, destroy: vi.fn(), on: vi.fn() }));

vi.mock("node:process", async importOriginal => ({
  ...(await importOriginal<typeof import("node:process")>()),
  exit: state.exit,
  kill: state.killProcess,
  stdin: fakeStdin,
}));
vi.mock("node:fs", async importOriginal => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  realpathSync: vi.fn((path: unknown) => String(path)),
  readFileSync: vi.fn((path: unknown) => {
    const key = String(path);
    if (key.endsWith("package.json")) return JSON.stringify({ version: state.packageVersion });
    if (state.readError !== undefined) throw state.readError;
    return state.files.get(key) ?? state.fileText;
  }),
  existsSync: vi.fn((path: unknown) => state.exists.has(String(path))),
  readdirSync: vi.fn(() => state.entries),
  mkdirSync: state.mkdir,
  writeFileSync: state.writeFile,
  unlinkSync: state.unlink,
}));
vi.mock("../../src/storage/backend-publication.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/storage/backend-publication.js")>();
  return {
    ...actual,
    assertBackendPublicationConsumerAccess: vi.fn(() => undefined),
  };
});
vi.mock("../../src/runtime-paths.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/runtime-paths.js")>()),
  configPath: () => "/lcm/.lcm/config.json", daemonPidPath: () => "/lcm/daemon.pid",
  daemonTokenPath: () => "/lcm/daemon.token", lcmHomeDir: () => "/lcm",
  migrateLegacyHomeIfNeeded: state.migrateLegacyHome, projectsDir: () => "/lcm/projects",
}));
vi.mock("../../src/daemon/config.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/daemon/config.js")>()), loadDaemonConfig: state.loadConfig,
}));
vi.mock("../../src/daemon/lifecycle.js", () => ({ ensureDaemon: state.ensureDaemon, restartDaemon: state.restartDaemon }));
vi.mock("../../src/daemon/client.js", () => ({ DaemonClient: class {
  post = state.post;
  get = state.get;
  health = state.health;
  startInvocation = state.startInvocation;
  heartbeatInvocation = state.heartbeatInvocation;
  cancelInvocation = state.cancelInvocation;
  finishInvocation = state.finishInvocation;
} }));
vi.mock("../../src/daemon/server.js", () => ({ createDaemon: state.createDaemon }));
vi.mock("../../src/daemon/auth.js", () => ({ ensureAuthToken: vi.fn(), readAuthToken: state.readAuthToken }));
vi.mock("../../src/llm/process-utils.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/llm/process-utils.js")>()),
  readProviderProcessWitnesses: vi.fn(() => {
    const result = state.providerWitnessReads.shift() ?? { available: true, providers: [] };
    if (result instanceof Error) throw result;
    return result;
  }),
  reconcileProviderProcessWitnesses: vi.fn(() => {
    const result = state.providerWitnessReconciles.shift() ?? { available: true, providers: [] };
    if (result instanceof Error) throw result;
    return result;
  }),
}));
vi.mock("../../src/cli-help.js", () => ({ printHelp: vi.fn() }));
vi.mock("../../src/identity-service.js", () => ({
  listProjects: state.projectList,
  showProject: state.projectShow,
  linkProject: state.projectLink,
  unlinkProject: state.projectUnlink,
  createProject: state.projectCreate,
  registerMachine: state.machineRegister,
  showMachine: state.machineShow,
  recoverMachine: state.machineRecover,
}));
vi.mock("../../src/worktree-reconciliation.js", () => ({
  reconcileWorktrees: state.reconcileWorktrees,
}));
vi.mock("../../src/config-manager.js", () => ({
  getConfigValue: vi.fn(() => "value"), formatConfigValue: vi.fn((value: unknown) => String(value)),
  normalizeConfigPath: vi.fn((path: string) => path), setConfigValue: vi.fn(() => "stored"),
  readConnectorTransport: vi.fn(() => state.storedCodexTransport),
  readConnectorTransportSnapshot: vi.fn(() => state.storedCodexTransport),
}));
vi.mock("../../src/batch-compact.js", (): { batchCompact: ReturnType<typeof vi.fn> } => ({ batchCompact: vi.fn(async (opts: { onProgress?: (patch: unknown) => void; onTransportFailure?: (error: unknown) => void }): Promise<typeof state.batchResult> => {
  state.batchOptions = opts;
  opts.onProgress?.(state.batchPatch);
  if (state.batchSignal !== undefined) process.emit(state.batchSignal);
  if (state.batchTransportFailure !== undefined) opts.onTransportFailure?.(state.batchTransportFailure);
  if (state.batchGate !== undefined) await state.batchGate;
  if (state.batchError !== undefined) throw state.batchError;
  return state.batchResult;
}) }));
vi.mock("../../src/cli/progress-state.js", () => ({ makeProgressState: vi.fn((value: Record<string, unknown>) => {
  const progressState = {
    total: 0, completed: 0, errors: [], phaseErrors: [], tokensIn: 0, tokensOut: 0, messagesIn: 0, ...value,
  };
  state.progressState = progressState;
  return progressState;
}) }));
vi.mock("../../src/cli/pipeline-runner.js", () => ({ NinjaRenderer: class {
  constructor(options: unknown) { state.rendererOptions = options; }
  start = state.renderer.start; stop = state.renderer.stop;
  sessionDone = state.renderer.sessionDone; printSummary = state.renderer.printSummary;
} }));
vi.mock("../../src/hooks/dispatch.js", () => ({ dispatchHook: state.dispatchHook }));
vi.mock("../../src/connectors/registry.js", () => ({
  AGENTS: [{
    id: "codex", name: "Codex", category: "cli", defaultTransport: "cli",
    capabilities: { cli: { guidance: ["skill"] }, mcp: { guidance: ["skill"], mcpAdapter: true } },
  }],
  findAgent: vi.fn((name: string) => name === "codex" ? ({ id: "codex", name: "Codex" }) : undefined),
}));
vi.mock("../../src/connectors/installer.js", () => ({
  listConnectors: vi.fn(() => state.installed), listConnectorInventory: undefined,
  installConnector: state.installConnector, removeConnector: state.removeConnector,
}));
vi.mock("../../src/import.js", () => ({
  cwdToProjectHash: vi.fn(() => "cwd-hash"), findSessionFiles: vi.fn(() => ["one", "two"]),
  importSessions: vi.fn(async (_client: unknown, opts: { onProgress?: (patch: unknown) => void }) => {
    opts.onProgress?.(state.importPatch); return state.importResult;
  }),
}));
vi.mock("../../src/codex-transcript.js", () => ({ findAllCodexTranscripts: vi.fn(() => ["codex-one"]) }));
vi.mock("../../src/import-summary.js", () => ({
  printImportSummary: vi.fn(),
  printCodexResolutionSummary: vi.fn(),
}));
vi.mock("../../src/portable-knowledge.js", () => ({
  exportKnowledge: vi.fn(async () => state.portableResult), importKnowledge: vi.fn(async () => state.portableResult),
}));
vi.mock("../../src/mcp/server.js", () => ({ startMcpServer: vi.fn(async () => undefined) }));
vi.mock("../../src/stats.js", () => ({ collectStats: vi.fn(() => ({})), printStats: vi.fn() }));
vi.mock("../../src/doctor/doctor.js", () => ({ runDoctor: vi.fn(async () => []), printResults: vi.fn() }));
vi.mock("../../src/diagnose.js", () => ({ diagnose: vi.fn(async () => ({})), formatDiagnoseResult: vi.fn(() => "ok") }));
vi.mock("../../src/sensitive.js", () => ({ handleSensitive: vi.fn(async () => ({ stdout: "", exitCode: 0 })) }));
vi.mock("../../installer/install.js", () => ({
  install: vi.fn(async () => undefined),
  createInstallerPublicationConvergence: vi.fn(async () => undefined),
}));
vi.mock("../../installer/uninstall.js", () => ({ uninstall: vi.fn(async () => undefined) }));
vi.mock("../../installer/dry-run-deps.js", () => ({ DryRunServiceDeps: class {} }));

const {
  compactFailureExitCode, registerMachineCommand, registerMemoryCommands, registerProjectCommand,
  resolveCompactRequestPolicyOverride, resolveManualCompactProvider, runCli, withHookOverrides,
} = await import("../../bin/lcm.js");

type ActionHandler = (...args: any[]) => unknown;

const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function captureActions(register: (program: Command) => void): Map<string, ActionHandler> {
  const captured = new Map<string, ActionHandler>();
  const original = Command.prototype.action;
  const spy = vi.spyOn(Command.prototype, "action").mockImplementation(function (this: Command, handler: ActionHandler) {
    captured.set(this.name(), handler);
    return original.call(this, handler);
  });
  try { register(new Command()); } finally { spy.mockRestore(); }
  return captured;
}

async function captureRunCliActions(): Promise<Map<string, ActionHandler>> {
  const captured = new Map<string, ActionHandler>();
  const original = Command.prototype.action;
  const spy = vi.spyOn(Command.prototype, "action").mockImplementation(function (this: Command, handler: ActionHandler) {
    captured.set(`${this.parent?.name() ?? "root"}/${this.name()}`, handler);
    return original.call(this, handler);
  });
  try { await invoke([]); } finally { spy.mockRestore(); }
  return captured;
}

async function invoke(args: string[]): Promise<Error | undefined> {
  try { await runCli(["node", "lcm", ...args]); return undefined; }
  catch (error) { return error instanceof Error ? error : new Error(String(error)); }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.killProcess.mockImplementation((_pid: number, _signal: 0): never => {
    throw Object.assign(new Error("process absent"), { code: "ESRCH" });
  });
  fakeStdin.isTTY = true;
  state.ensureDaemon.mockResolvedValue({ connected: true, spawned: false, restartedForParent: false, pid: 42 });
  state.restartDaemon.mockResolvedValue({ connected: true, restarted: true, spawned: false, pid: 42 });
  state.loadConfig.mockReturnValue({
    daemon: { port: 3737 },
    storage: { backend: "sqlite" },
    llm: { provider: "openai", apiMode: "responses", requestTimeoutMs: 1000, retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2 } },
    compaction: { autoCompactMinTokens: 1 },
  });
  state.files.clear(); state.exists.clear(); state.entries = []; state.readError = undefined;
  state.fileText = "{}"; state.packageVersion = "1.4.0"; state.installed = [];
  state.storedCodexTransport = undefined;
  state.batchResult = { compacted: 1, unchanged: 0, skipped: 0, failures: 0, compactedProjects: ["/good"] };
  state.batchError = undefined;
  state.batchGate = undefined;
  state.batchOptions = undefined;
  state.batchPatch = { lastResult: { ok: true } };
  state.batchTransportFailure = undefined;
  state.batchSignal = undefined;
  state.providerWitnessReads = [];
  state.providerWitnessReconciles = [];
  state.importPatch = { lastResult: { ok: true } };
  state.rendererOptions = undefined;
  state.health.mockResolvedValue(true);
  state.startInvocation.mockClear();
  state.heartbeatInvocation.mockClear();
  state.cancelInvocation.mockClear();
  state.finishInvocation.mockClear();
  state.authToken = "test-token";
  state.migrateLegacyHome.mockReset();
  state.portableResult = { exported: 1, imported: 1, skipped: 0, total: 1, dryRun: false };
  state.projectList.mockResolvedValue({
    local: [{ hash: "hash", canonical: "/canonical", aliases: ["/alias"], remoteProjectId: "remote-id" }],
    remote: [{ projectId: "remote-id", displayName: "Remote", aliases: [{ machineId: "machine-id", path: "/canonical" }] }],
  });
  state.projectShow.mockResolvedValue({
    hash: "hash",
    entry: { canonical: "/canonical", aliases: ["/alias"], remoteProjectId: "remote-id" },
    remote: { projectId: "remote-id", displayName: "Remote", aliases: [] },
  });
  state.projectLink.mockResolvedValue({
    local: { id: "hash", canonical: "/canonical", aliases: ["/alias"], remoteProjectId: "remote-id" },
  });
  state.projectUnlink.mockResolvedValue({ hash: "hash", remoteProjectId: "remote-id", aliasRemoved: true });
  state.projectCreate.mockResolvedValue({
    local: { id: "hash", canonical: "/canonical", aliases: [], remoteProjectId: "remote-id" },
    remote: { projectId: "remote-id", displayName: "Remote", aliases: [] },
  });
  state.machineRegister.mockResolvedValue({
    identity: { version: 1, machineId: "machine-id", displayName: "Workstation", identityKey: "secret" },
    created: true,
  });
  state.machineShow.mockReturnValue({
    version: 1, machineId: "machine-id", displayName: "Workstation", identityKey: "secret",
  });
  state.machineRecover.mockResolvedValue({
    identity: { version: 1, machineId: "machine-id", displayName: "Workstation", identityKey: "secret" },
    backupPath: "/lcm/machine.json.backup",
  });
  state.installConnector.mockReturnValue({ path: "/hook", requiresRestart: false });
  state.removeConnector.mockReturnValue(true);
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  if (stdoutIsTTYDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutIsTTYDescriptor);
  else Reflect.deleteProperty(process.stdout, "isTTY");
  vi.restoreAllMocks();
});

describe("runCli identity boundaries", () => {
  it("covers nested project and machine help callbacks through the registration seam", async () => {
    const projectActions = captureActions(registerProjectCommand);
    await expect(projectActions.get("project")!({ help: true })).rejects.toThrow("exit:0");
    await expect(projectActions.get("project")!({})).rejects.toThrow("exit:1");
    await expect(projectActions.get("list")!({ help: true })).rejects.toThrow("exit:0");
    await expect(projectActions.get("reconcile-worktrees")!(undefined, { help: true })).rejects.toThrow("exit:0");
    await expect(projectActions.get("show")!(undefined, { help: true })).rejects.toThrow("exit:0");
    await expect(projectActions.get("link")!(undefined, undefined, { help: true })).rejects.toThrow("exit:0");
    await expect(projectActions.get("unlink")!(undefined, { help: true })).rejects.toThrow("exit:0");
    await expect(projectActions.get("create")!(undefined, { help: true })).rejects.toThrow("exit:0");

    const machineActions = captureActions(registerMachineCommand);
    await expect(machineActions.get("machine")!({ help: true })).rejects.toThrow("exit:0");
    await expect(machineActions.get("machine")!({})).rejects.toThrow("exit:1");
    await expect(machineActions.get("register")!({ help: true })).rejects.toThrow("exit:0");
    await expect(machineActions.get("show")!({ help: true })).rejects.toThrow("exit:0");
    await expect(machineActions.get("recover")!(undefined, { help: true })).rejects.toThrow("exit:0");
  });

  it("covers pure compact option boundary combinations", () => {
    const config = state.loadConfig();
    expect(resolveCompactRequestPolicyOverride(config as never, { timeoutMs: "250" })).toMatchObject({ requestTimeoutMs: 250 });
    expect(resolveCompactRequestPolicyOverride(config as never, { retryMaxAttempts: "2" })).toMatchObject({ retry: { maxAttempts: 2 } });
    expect(resolveCompactRequestPolicyOverride({ ...config, llm: { ...config.llm, provider: "claude-process" } } as never, { timeoutMs: "250" }))
      .toMatchObject({ requestTimeoutMs: 250 });
    expect(() => resolveCompactRequestPolicyOverride({ ...config, llm: { ...config.llm, provider: "claude-process" } } as never, { retryMaxAttempts: "2" }))
      .toThrow("retry overrides require");
    expect(() => resolveCompactRequestPolicyOverride({ ...config, llm: { ...config.llm, provider: "disabled" } } as never, { timeoutMs: "250" }))
      .toThrow("timeout overrides require");
    expect(compactFailureExitCode(0)).toBeUndefined();
    expect(compactFailureExitCode(2)).toBe(1);
    expect(resolveManualCompactProvider("auto")).toBe("claude-process");
    expect(resolveManualCompactProvider("openai")).toBe("openai");
    expect(withHookOverrides("{}", "other", undefined, undefined, undefined)).toBe("{}");
    expect(withHookOverrides("{}", "codex", "low", {
      requestTimeoutMs: 100, retry: { maxAttempts: 2, initialDelayMs: 3, maxDelayMs: 4, multiplier: 2 },
    }, false)).toContain('"fast_mode":false');
  });

  it("renders every project operation in text and JSON forms", async () => {
    expect(await invoke(["project", "reconcile-worktrees", "/canonical", "--dry-run"])).toBeUndefined();
    expect(await invoke(["project", "reconcile-worktrees", "--json"])).toBeUndefined();
    state.reconcileWorktrees.mockReturnValueOnce({
      status: "not-needed",
      targetHash: "target-hash",
      canonical: "/canonical",
      sourceHashes: [],
      aliases: ["/canonical"],
      journalPath: undefined,
      backupPaths: [],
      reason: undefined,
    });
    expect(await invoke(["project", "reconcile-worktrees", "/canonical"])).toBeUndefined();
    expect(await invoke(["project", "list"])).toBeUndefined();
    expect(await invoke(["project", "list", "--json"])).toBeUndefined();
    expect(await invoke(["project", "show", "/alias"])).toBeUndefined();
    expect(await invoke(["project", "show", "--json"])).toBeUndefined();
    expect(await invoke(["project", "link", "remote-id", "/canonical", "--allow-existing-data"])).toBeUndefined();
    expect(await invoke(["project", "link", "remote-id", "--json"])).toBeUndefined();
    expect(await invoke(["project", "unlink", "/alias"])).toBeUndefined();
    expect(await invoke(["project", "unlink", "--json"])).toBeUndefined();
    expect(await invoke(["project", "create", "/canonical", "--name", "Remote"])).toBeUndefined();
    expect(await invoke(["project", "create", "--json"])).toBeUndefined();
  });

  it("sanitizes persisted remote project text only for human output", async () => {
    const log = vi.spyOn(console, "log");
    const write = vi.spyOn(process.stdout, "write");
    state.projectList.mockResolvedValueOnce({
      local: [{
        hash: "local-hash",
        canonical: "/canonical\u001b]8;;https://attacker.invalid\u0007click\u001b]8;;\u0007",
        aliases: ["/alias\u001b[31mred\u001b[0m"],
      }],
      remote: [{
        projectId: "remote-id",
        displayName: "Remote\nInjected",
        aliases: [{ machineId: "machine-id", path: "/safe\nInjected" }],
      }],
    });
    await invoke(["project", "list"]);
    expect(log).toHaveBeenCalledWith("  canonical: /canonicalclick");
    expect(log).toHaveBeenCalledWith("  alias: /aliasred");
    expect(log).toHaveBeenCalledWith("  remote-id  Remote Injected");
    expect(log).toHaveBeenCalledWith("    machine-id: /safe Injected");

    log.mockClear();
    state.projectShow.mockResolvedValueOnce({
      hash: "hash",
      entry: {
        canonical: "/canonical\u001b]8;;https://attacker.invalid\u0007click\u001b]8;;\u0007",
        aliases: ["/alias\u001b[31mred\u001b[0m"],
        remoteProjectId: "remote-id",
      },
      remote: { projectId: "remote-id", displayName: "Remote\nInjected", aliases: [] },
    });
    await invoke(["project", "show"]);
    expect(log).toHaveBeenCalledWith("  canonical: /canonicalclick");
    expect(log).toHaveBeenCalledWith("  alias: /aliasred");
    expect(log).toHaveBeenCalledWith("  name: Remote Injected");

    log.mockClear();
    state.projectLink.mockResolvedValueOnce({
      local: {
        id: "hash",
        canonical: "/linked\u001b]8;;https://attacker.invalid\u0007click\u001b]8;;\u0007\nInjected",
        aliases: [],
        remoteProjectId: "remote-id",
      },
    });
    await invoke(["project", "link", "remote-id"]);
    expect(log).toHaveBeenCalledWith("Linked /linkedclick Injected");

    log.mockClear();
    state.projectCreate.mockResolvedValueOnce({
      local: {
        id: "hash",
        canonical: "/created\u001b[31mred\u001b[0m\nInjected",
        aliases: [],
        remoteProjectId: "remote-id",
      },
      remote: { projectId: "remote-id", displayName: "Remote", aliases: [] },
    });
    await invoke(["project", "create"]);
    expect(log).toHaveBeenCalledWith("  path: /createdred Injected");

    log.mockClear();
    write.mockClear();
    state.projectShow.mockResolvedValueOnce({
      hash: "hash",
      entry: {
        canonical: "/canonical\u001b]8;;https://attacker.invalid\u0007click\u001b]8;;\u0007",
        aliases: ["/alias\u001b[31mred\u001b[0m"],
        remoteProjectId: "remote-id",
      },
      remote: { projectId: "remote-id", displayName: "Remote\nInjected", aliases: [] },
    });
    await invoke(["project", "show", "--json"]);
    const jsonOutput = write.mock.calls.map(([value]) => String(value)).join("");
    expect(jsonOutput).toContain("\\nInjected");
    expect(jsonOutput).toContain("\\u001b]8;;https://attacker.invalid");
    expect(jsonOutput).toContain("\\u001b[31mred");

    write.mockClear();
    state.projectLink.mockResolvedValueOnce({
      local: {
        id: "hash",
        canonical: "/linked\u001b]8;;https://attacker.invalid\u0007click\nInjected",
        aliases: [],
        remoteProjectId: "remote-id",
      },
    });
    state.projectCreate.mockResolvedValueOnce({
      local: {
        id: "hash",
        canonical: "/created\u001b[31mred\u001b[0m\nInjected",
        aliases: [],
        remoteProjectId: "remote-id",
      },
      remote: { projectId: "remote-id", displayName: "Remote", aliases: [] },
    });
    await invoke(["project", "link", "remote-id", "--json"]);
    await invoke(["project", "create", "--json"]);
    const mutationJsonOutput = write.mock.calls.map(([value]) => String(value)).join("");
    expect(mutationJsonOutput).toContain("\\nInjected");
    expect(mutationJsonOutput).toContain("\\u001b]8;;https://attacker.invalid");
    expect(mutationJsonOutput).toContain("\\u001b[31mred");
  });

  it("renders every machine operation in text and JSON forms", async () => {
    expect(await invoke(["machine", "register", "--name", "Workstation"])).toBeUndefined();
    expect(await invoke(["machine", "register", "--json"])).toBeUndefined();
    expect(await invoke(["machine", "show"])).toBeUndefined();
    expect(await invoke(["machine", "show", "--json"])).toBeUndefined();
    expect(await invoke(["machine", "recover", "machine-id", "--force"])).toBeUndefined();
    expect(await invoke(["machine", "recover", "machine-id", "--json"])).toBeUndefined();
  });

  it("reports Error and primitive identity failures in text and JSON", async () => {
    state.reconcileWorktrees.mockImplementationOnce(() => { throw new Error("reconcile failed"); });
    expect((await invoke(["project", "reconcile-worktrees"]))?.message).toBe("exit:1");
    state.projectList.mockRejectedValueOnce(new Error("list failed"));
    expect((await invoke(["project", "list"]))?.message).toBe("exit:1");
    state.projectShow.mockRejectedValueOnce("show failed");
    expect((await invoke(["project", "show", "--json"]))?.message).toBe("exit:1");
    state.projectLink.mockRejectedValueOnce(new Error("link failed"));
    expect((await invoke(["project", "link", "target"]))?.message).toBe("exit:1");
    state.projectUnlink.mockRejectedValueOnce(new Error("unlink failed"));
    expect((await invoke(["project", "unlink"]))?.message).toBe("exit:1");
    state.projectCreate.mockRejectedValueOnce(new Error("create failed"));
    expect((await invoke(["project", "create", "--json"]))?.message).toBe("exit:1");
    state.machineRegister.mockRejectedValueOnce(new Error("register failed"));
    expect((await invoke(["machine", "register"]))?.message).toBe("exit:1");
    state.machineShow.mockImplementationOnce(() => { throw "show failed"; });
    expect((await invoke(["machine", "show", "--json"]))?.message).toBe("exit:1");
    state.machineRecover.mockRejectedValueOnce(new Error("recover failed"));
    expect((await invoke(["machine", "recover", "machine-id"]))?.message).toBe("exit:1");
  });

  it("covers malformed memory option shapes through registration callbacks", async () => {
    const actions = captureActions(registerMemoryCommands);
    await expect(actions.get("search")!("query", { limit: "5", layer: "episodic", tag: "tag" })).resolves.toBeUndefined();
    await expect(actions.get("search")!("query", { limit: undefined, layer: undefined, tag: undefined })).resolves.toBeUndefined();
    await expect(actions.get("grep")!("query", { mode: undefined, scope: undefined, since: "" })).resolves.toBeUndefined();
    await expect(actions.get("describe")!("node", { help: true })).rejects.toThrow("exit:0");
    await expect(actions.get("expand")!("node", { help: true })).rejects.toThrow("exit:0");
    await expect(actions.get("expand")!("node", { depth: undefined })).resolves.toBeUndefined();
    await expect(actions.get("store")!("text", { help: true })).rejects.toThrow("exit:0");
    await expect(actions.get("store")!("text", { tag: "not-an-array" })).resolves.toBeUndefined();
  });

  it("forwards every explicit grep since value through Commander", async () => {
    const cases: Array<{ args: string[]; since: string | undefined }> = [
      { args: ["grep", "query", "--since", ""], since: "" },
      { args: ["grep", "query", "--since="], since: "" },
      { args: ["grep", "query"], since: undefined },
      { args: ["grep", "query", "--since", "2026-01-01T00:00:00Z"], since: "2026-01-01T00:00:00Z" },
      { args: ["grep", "query", "--since", "2026-01-01T00:00:00+03:00"], since: "2026-01-01T00:00:00+03:00" },
      { args: ["grep", "query", "--since", "not-a-date"], since: "not-a-date" },
      { args: ["grep", "query", "--since", " "], since: " " },
    ];

    for (const testCase of cases) {
      state.post.mockClear();
      await expect(invoke(testCase.args)).resolves.toBeUndefined();
      expect(state.post).toHaveBeenCalledWith("/grep", expect.objectContaining({ since: testCase.since }));
    }

    const emptyError = Object.assign(new Error("invalid since"), { statusCode: 400 });
    state.post.mockRejectedValueOnce(emptyError);
    await expect(invoke(["grep", "query", "--since", ""])).resolves.toBe(emptyError);
  });
});

describe("runCli lifecycle and connector boundaries", () => {
  it("does not bootstrap the root before an authenticated healthy daemon read", async () => {
    state.health.mockResolvedValue({
      status: "ok",
      version: "1.4.2",
      storageBackend: "sqlite",
      entrypoint: "/daemon",
      runtimeDigest: "runtime",
    });

    expect(await invoke(["search", "q"])).toBeUndefined();

    expect(state.migrateLegacyHome).not.toHaveBeenCalled();
    expect(state.ensureDaemon).not.toHaveBeenCalled();
  });

  it("ignores timeout after stdin end has resolved", async () => {
    fakeStdin.isTTY = false;
    let timeout: (() => void) | undefined;
    let end: (() => void) | undefined;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      timeout = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    fakeStdin.on.mockImplementation((event: string, callback: () => void) => {
      if (event === "end") end = callback;
      return fakeStdin;
    });
    const pending = invoke(["restore"]);
    await vi.waitFor(() => expect(end).toBeDefined());
    end!();
    expect((await pending)?.message).toBe("exit:0");
    timeout!();
  });

  it("ignores stdin end after the timeout has resolved", async () => {
    fakeStdin.isTTY = false;
    let timeout: (() => void) | undefined;
    let end: (() => void) | undefined;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      timeout = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    fakeStdin.on.mockImplementation((event: string, callback: () => void) => {
      if (event === "end") end = callback;
      return fakeStdin;
    });
    const pending = invoke(["restore"]);
    await vi.waitFor(() => expect(timeout).toBeDefined());
    timeout!();
    expect((await pending)?.message).toBe("exit:0");
    end!();
  });

  it("covers custom help callbacks through captured Commander actions", async () => {
    const captured = await captureRunCliActions();

    const helpCases: Array<[string, unknown[]]> = [
      ["daemon/start", [{ help: true }]], ["daemon/restart", [{ help: true }]], ["root/daemon", [{ help: true }]],
      ["config/get", ["x", { help: true }]], ["config/set", ["x", "y", { help: true }]],
      ["lcm/compact", [{ help: true }]], ["lcm/restore", [{ help: true }]], ["lcm/session-end", [{ help: true }]],
      ["lcm/user-prompt", [{ help: true }]], ["lcm/post-tool", [{ help: true }]], ["lcm/session-snapshot", [{ help: true }]],
      ["lcm/mcp", [{ help: true }]], ["lcm/status", [{ help: true }]], ["lcm/stats", [{ help: true }]],
      ["lcm/doctor", [{ help: true }]], ["lcm/diagnose", [{ help: true }]], ["lcm/sensitive", [[], { help: true }]],
      ["lcm/import", [{ help: true }]], ["lcm/promote", [{ help: true }]], ["lcm/export", [{ help: true }]],
      ["lcm/import-knowledge", ["x", { help: true }]],
    ];
    for (const [key, args] of helpCases) {
      await expect(Promise.resolve().then(() => captured.get(key)!(...args))).rejects.toThrow("exit:0");
    }
  });

  it("covers daemon PID, warning, cleanup, and signal branches", async () => {
    const on = vi.spyOn(process, "on").mockImplementation((() => process) as typeof process.on);
    state.ensureDaemon.mockResolvedValueOnce({ connected: true, spawned: false, restartedForParent: true, pid: 7, warning: "moved" });
    expect((await invoke(["daemon", "start"]))?.message).toBe("exit:0");
    state.ensureDaemon.mockResolvedValueOnce({ connected: true, spawned: true, restartedForParent: false, pid: 8 });
    expect((await invoke(["daemon", "start"]))?.message).toBe("exit:0");
    state.restartDaemon.mockResolvedValueOnce({ connected: true, restarted: false, spawned: true, pid: 9, warning: "started" });
    expect((await invoke(["daemon", "restart"]))?.message).toBe("exit:0");

    state.files.set("/lcm/daemon.pid", String(process.pid));
    expect(await invoke(["daemon", "start", "--foreground"])).toBeUndefined();
    const exitHandler = on.mock.calls.find(([event]) => event === "exit")?.[1] as (() => void);
    exitHandler();
    expect(state.unlink).toHaveBeenCalledWith("/lcm/daemon.pid");
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const handler = on.mock.calls.find(([event]) => event === signal)?.[1] as (() => void);
      expect(() => handler()).toThrow("exit:0");
    }

    state.files.set("/lcm/daemon.pid", "someone-else");
    await invoke(["daemon", "start", "--foreground"]);
    const mismatchCleanup = on.mock.calls.filter(([event]) => event === "exit").at(-1)?.[1] as (() => void);
    mismatchCleanup();
  });

  it("reports compact startup and health failures", async () => {
    state.ensureDaemon.mockRejectedValueOnce(new Error("daemon startup failed"));
    expect((await invoke(["compact", "--no-promote"]))?.message).toBe("daemon startup failed");

    state.ensureDaemon.mockResolvedValueOnce({ connected: true, spawned: false, restartedForParent: false, pid: 42 });
    state.health.mockRejectedValueOnce(new Error("health failed"));
    expect((await invoke(["compact", "--no-promote"]))?.message).toBe("health failed");

    state.ensureDaemon.mockResolvedValueOnce({ connected: false, spawned: false, restartedForParent: false, pid: undefined });
    expect((await invoke(["compact", "--no-promote"]))?.message).toBe("exit:1");
  });

  it("settles compact pre-registration and health drains without dispatching work", async () => {
    state.ensureDaemon.mockImplementationOnce(async () => {
      process.emit("SIGINT");
      return { connected: false, spawned: false, restartedForParent: false, pid: undefined };
    });
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(process.exitCode).toBe(130);

    state.ensureDaemon.mockResolvedValueOnce({ connected: true, spawned: false, restartedForParent: false, pid: 42 });
    state.health.mockImplementationOnce(async () => {
      process.emit("SIGTERM");
      return true;
    });
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(process.exitCode).toBe(143);
    expect(state.batchOptions).toBeUndefined();
  });

  it("starts a bounded drain when compact transport reports a primitive failure", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.batchTransportFailure = "transport disconnected";
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(diagnostic).toHaveBeenCalledWith("  compact transport disconnected: request failed");
    expect(state.cancelInvocation).toHaveBeenCalledOnce();
  });

  it("reports an Error compact transport failure before draining", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.batchTransportFailure = new Error("transport disconnected");
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(diagnostic).toHaveBeenCalledWith("  compact transport disconnected: transport disconnected");
    expect(state.cancelInvocation).toHaveBeenCalledOnce();
  });

  it("uses the compact failure fallback when an automatic heartbeat drain starts early", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.heartbeatInvocation.mockRejectedValueOnce("heartbeat disconnected");
    const setInterval = vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return {} as ReturnType<typeof globalThis.setInterval>;
    }) as typeof globalThis.setInterval);

    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(state.batchOptions).toBeUndefined();
    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    setInterval.mockRestore();
  });

  it("drains when invocation registration loses its start response", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.startInvocation.mockRejectedValueOnce(new Error("start response lost"));
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(state.startInvocation).toHaveBeenCalledOnce();
    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("reports a primitive heartbeat control failure before draining", async () => {
    vi.useFakeTimers();
    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.heartbeatInvocation.mockRejectedValueOnce("heartbeat disconnected");
    let release!: () => void;
    state.batchGate = new Promise<void>(resolve => { release = resolve; });
    const pending = invoke(["compact", "--no-promote"]);
    await vi.waitFor(() => expect(state.startInvocation).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_000);
    release();
    await expect(pending).resolves.toBeUndefined();
    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    vi.useRealTimers();
  });

  it("breaks promotion after a signal begins draining", async () => {
    state.health.mockResolvedValueOnce({ status: "healthy", version: "1.4.2", storageBackend: "sqlite", daemonInstanceId: "11111111-1111-4111-8111-111111111111" });
    state.batchResult = { compacted: 1, unchanged: 0, skipped: 0, failures: 0, compactedProjects: ["/one", "/two"] };
    state.post.mockImplementationOnce(async (path: string) => { if (path === "/promote") process.emit("SIGINT"); return { processed: 1, promoted: 1 }; });
    await expect(invoke(["compact"])).resolves.toBeUndefined();
    expect(state.post).toHaveBeenCalledTimes(1);
  });

  it("starts a drain when invocation-aware promotion loses transport", async () => {
    state.health.mockResolvedValueOnce({ status: "healthy", version: "1.4.2", storageBackend: "sqlite", daemonInstanceId: "11111111-1111-4111-8111-111111111111" });
    const transport = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    state.post.mockImplementationOnce(async (path: string) => {
      if (path === "/promote") throw transport;
      return { processed: 1, promoted: 1 };
    });
    await expect(invoke(["compact"])).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(state.post).toHaveBeenCalledWith("/promote", expect.any(Object), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("recovers a legacy promotion after a primitive transport failure", async () => {
    const transport = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    state.post.mockImplementationOnce(async (path: string) => {
      if (path === "/promote") throw transport;
      return { processed: 1, promoted: 1 };
    });
    state.batchResult = { compacted: 1, unchanged: 0, skipped: 0, failures: 0, compactedProjects: ["/legacy"] };
    await expect(invoke(["compact"])).resolves.toBeUndefined();
    expect(state.ensureDaemon).toHaveBeenCalledTimes(2);
    expect(state.post).toHaveBeenCalledTimes(2);
  });

  it("drains after malformed or rejected invocation finish control", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.finishInvocation.mockResolvedValueOnce({ state: "finished" });
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(state.finishInvocation).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);

    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.finishInvocation.mockRejectedValueOnce(new Error("finish failed"));
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  it("records a primitive compact failure while a drain is active", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.batchError = "compact primitive failure";
    state.batchSignal = "SIGINT";
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(130);
  });

  it("records a primitive invocation finish failure and drains", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.finishInvocation.mockRejectedValueOnce("finish primitive failure");
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(state.progressState?.phaseErrors).toEqual([
      { phase: "Compact", message: "invocation finish failed" },
    ]);
  });

  it("suppresses an abort finish failure diagnostic", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const { createAbortError } = await import("../../src/daemon/cancellation.js");
    state.finishInvocation.mockRejectedValueOnce(createAbortError("finish aborted"));
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(state.progressState?.phaseErrors).toEqual([]);
  });

  it("keeps finish cleanup on the already-draining path", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.finishInvocation.mockImplementationOnce(async () => {
      process.emit("SIGINT");
      throw new Error("finish after signal");
    });
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(130);
  });

  it.each([
    ["owned provider evidence", { available: true, providers: [{}] }],
    ["provider proof failure", new Error("provider witness read failed")],
  ])("drains normal completion after %s", async (_label, firstRead) => {
    const owned = { available: true, providers: [{}] };
    state.health.mockResolvedValueOnce({
      status: "healthy", version: "1.4.2", storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.providerWitnessReads = [firstRead, { available: true, providers: [] }];
    state.providerWitnessReconciles = [owned];

    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();

    expect(state.finishInvocation).not.toHaveBeenCalled();
    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it("awaits foreground daemon stop before exiting on SIGTERM", async () => {
    let release!: () => void;
    const stop = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    state.createDaemon.mockResolvedValueOnce({ address: () => ({ port: 3737 }), stop });
    const on = vi.spyOn(process, "on");
    await expect(invoke(["daemon", "start", "--foreground"])).resolves.toBeUndefined();
    const exit = state.exit;
    const handler = on.mock.calls.filter(([event]) => event === "SIGTERM").at(-1)?.[1] as (() => void);

    handler();
    expect(stop).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalledWith(0);
    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("reports synchronous and asynchronous foreground stop failures", async () => {
    const on = vi.spyOn(process, "on");
    const synchronousHandlers = new Map<string, (...args: unknown[]) => unknown>();
    on.mockImplementation(((event: string, listener: (...args: unknown[]) => unknown) => {
      synchronousHandlers.set(event, listener);
      return process;
    }) as typeof process.on);
    state.createDaemon.mockResolvedValueOnce({
      address: () => ({ port: 3737 }),
      stop: vi.fn(() => { throw new Error("sync stop failed"); }),
    });
    await expect(invoke(["daemon", "start", "--foreground"])).resolves.toBeUndefined();
    synchronousHandlers.get("SIGTERM")?.();
    await vi.waitFor(() => expect(state.exit).toHaveBeenCalledWith(1));

    state.exit.mockClear();
    const asynchronousHandlers = new Map<string, (...args: unknown[]) => unknown>();
    on.mockImplementation(((event: string, listener: (...args: unknown[]) => unknown) => {
      asynchronousHandlers.set(event, listener);
      return process;
    }) as typeof process.on);
    state.createDaemon.mockResolvedValueOnce({
      address: () => ({ port: 3737 }),
      stop: vi.fn(() => Promise.reject(new Error("async stop failed"))),
    });
    await expect(invoke(["daemon", "start", "--foreground"])).resolves.toBeUndefined();
    asynchronousHandlers.get("SIGINT")?.();
    await vi.waitFor(() => expect(state.exit).toHaveBeenCalledWith(1));
  });

  it("covers defaulted raw action options and empty service results", async () => {
    const actions = await captureRunCliActions();
    state.loadConfig.mockReturnValue({
      daemon: undefined,
      storage: { backend: "sqlite" },
      llm: { provider: "auto", apiMode: "responses", requestTimeoutMs: 1000, retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2 } },
      compaction: { autoCompactMinTokens: 1 },
    });

    await expect(actions.get("root/daemon")!({})).resolves.toBeUndefined();
    state.ensureDaemon.mockResolvedValueOnce({ connected: true, spawned: false, restartedForParent: false, pid: undefined });
    await expect(actions.get("daemon/start")!({})).rejects.toThrow("exit:0");
    state.restartDaemon.mockResolvedValueOnce({ connected: true, restarted: false, spawned: false, pid: undefined });
    await expect(actions.get("daemon/restart")!({})).rejects.toThrow("exit:0");

    state.batchResult = { compacted: 0, unchanged: 0, skipped: 0, failures: 1, compactedProjects: [] };
    state.batchPatch = {};
    await expect(actions.get("lcm/compact")!({})).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);

    state.importPatch = {};
    await expect(actions.get("lcm/import")!({ provider: undefined })).resolves.toBeUndefined();
    await expect(actions.get("lcm/promote")!({ all: true })).resolves.toBeUndefined();
    await expect(actions.get("lcm/export")!({ all: true })).resolves.toBeUndefined();
  });

  it("covers omitted warnings, versions, defaults, and singular output", async () => {
    state.packageVersion = 14;
    const actions = await captureRunCliActions();
    state.ensureDaemon.mockResolvedValueOnce({ connected: false, spawned: false, restartedForParent: false, pid: undefined });
    await expect(actions.get("daemon/start")!({})).rejects.toThrow("exit:1");
    state.restartDaemon.mockResolvedValueOnce({ connected: false, restarted: false, spawned: false, pid: undefined });
    await expect(actions.get("daemon/restart")!({})).rejects.toThrow("exit:1");

    state.projectList.mockResolvedValueOnce({
      local: [{ hash: "hash", canonical: "/canonical", aliases: [] }],
    });
    expect(await invoke(["project", "list"])).toBeUndefined();
    state.projectShow.mockResolvedValueOnce({
      hash: "hash",
      entry: { canonical: "/canonical", aliases: [] },
    });
    expect(await invoke(["project", "show"])).toBeUndefined();
    state.projectLink.mockResolvedValueOnce({
      local: { id: "hash", canonical: "/canonical", aliases: [] },
    });
    expect(await invoke(["project", "link", "hash"])).toBeUndefined();
    state.projectUnlink.mockResolvedValueOnce({ hash: "hash", aliasRemoved: false });
    expect(await invoke(["project", "unlink"])).toBeUndefined();
    state.machineRegister.mockResolvedValueOnce({
      identity: { version: 1, machineId: "machine-id", displayName: "Workstation", identityKey: "secret" },
      created: false,
    });
    expect(await invoke(["machine", "register"])).toBeUndefined();
    state.machineShow.mockReturnValueOnce({
      version: 1, machineId: null, displayName: "Workstation", identityKey: "secret",
    });
    expect(await invoke(["machine", "show"])).toBeUndefined();
    state.machineRecover.mockResolvedValueOnce({
      identity: { version: 1, machineId: "machine-id", displayName: "Workstation", identityKey: "secret" },
    });
    expect(await invoke(["machine", "recover", "machine-id"])).toBeUndefined();

    state.batchResult = { compacted: 1, unchanged: 0, skipped: 0, failures: 0, compactedProjects: ["/good"] };
    state.post.mockResolvedValueOnce({ processed: 1, promoted: 1 });
    await expect(actions.get("lcm/compact")!({ promote: true })).resolves.toBeUndefined();

    state.health.mockResolvedValueOnce(false);
    await expect(actions.get("lcm/status")!({ json: true })).resolves.toBeUndefined();
    await expect(actions.get("lcm/doctor")!({ eventsMaxDbs: undefined })).rejects.toThrow("exit:0");
    await expect(actions.get("connectors/list")!({ format: undefined })).resolves.toBeUndefined();

    state.post.mockResolvedValueOnce({ promoted: 1, processedProjects: 1, skipped: 0, errors: 0, orphanedProjects: 0 });
    await expect(actions.get("events/promote")!({ all: true })).resolves.toBeUndefined();
    state.post.mockRejectedValueOnce("request failed");
    await expect(actions.get("lcm/promote")!({ verbose: false })).resolves.toBeUndefined();
  });

  it("covers connector help, installed display, and installer errors", async () => {
    state.installed = [{ agentId: "codex", type: "hook", path: "/hook" }];
    expect(await invoke(["connectors", "list"])).toBeUndefined();
    expect(await invoke(["connectors", "list", "--format", "json"])).toBeUndefined();
    expect(await invoke(["connectors", "doctor"])).toBeUndefined();
    state.installConnector.mockImplementationOnce(() => { throw new Error("install failed"); });
    expect((await invoke(["connectors", "install", "codex"]))?.message).toBe("exit:1");
    state.removeConnector.mockImplementationOnce(() => { throw new Error("remove failed"); });
    expect((await invoke(["connectors", "remove", "codex"]))?.message).toBe("exit:1");
  });

  it("covers nested connector callbacks which Commander cannot route", async () => {
    const captured = new Map<string, ActionHandler>();
    const original = Command.prototype.action;
    const spy = vi.spyOn(Command.prototype, "action").mockImplementation(function (this: Command, handler: ActionHandler) {
      if (["list", "install", "remove", "doctor"].includes(this.name())) captured.set(this.name(), handler);
      return original.call(this, handler);
    });
    try { await invoke([]); } finally { spy.mockRestore(); }

    await expect(captured.get("list")!({ help: true })).rejects.toThrow("exit:0");
    await expect(captured.get("install")!("codex", { help: true })).rejects.toThrow("exit:0");
    await expect(captured.get("remove")!("codex", { help: true })).rejects.toThrow("exit:0");
    await expect(captured.get("doctor")!("codex", { help: true })).rejects.toThrow("exit:0");
    await expect(captured.get("install")!("", {})).rejects.toThrow("exit:1");
    await expect(captured.get("remove")!("", {})).rejects.toThrow("exit:1");
  });
});

describe("runCli scanning and portable knowledge boundaries", () => {
  it("stops the compact renderer when batch compaction rejects", async (): Promise<void> => {
    state.batchError = new Error("batch failed");

    expect((await invoke(["compact"]))?.message).toBe("batch failed");
    expect(state.renderer.start).toHaveBeenCalledOnce();
    expect(state.renderer.stop).toHaveBeenCalledOnce();
    expect(state.renderer.printSummary).not.toHaveBeenCalled();
  });

  it("covers compact TTY summary and fatal targeted promotion failure", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    state.entries = [
      { name: "file", isDirectory: () => false },
      { name: "missing", isDirectory: () => true },
      { name: "bad", isDirectory: () => true },
      { name: "good", isDirectory: () => true },
    ];
    state.exists.add("/lcm/projects");
    state.exists.add("/lcm/projects/bad/meta.json");
    state.exists.add("/lcm/projects/good/meta.json");
    state.files.set("/lcm/projects/bad/meta.json", "not json");
    state.files.set("/lcm/projects/good/meta.json", JSON.stringify({ cwd: "/good" }));
    state.post.mockRejectedValueOnce(new Error("best effort"));
    expect(await invoke(["compact", "--all"])).toBeUndefined();
    expect(state.renderer.printSummary).toHaveBeenCalled();
    expect(state.post).toHaveBeenCalledWith("/promote", { cwd: "/good", dry_run: false });
    expect(process.exitCode).toBe(1);
    expect(state.progressState?.errors).toEqual([]);
    expect(state.progressState?.phaseErrors).toEqual([
      { phase: "Promote", target: "/good", message: "best effort" },
    ]);
  });

  it("registers one invocation and reuses it for automatic promotion", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.batchResult = { compacted: 1, unchanged: 0, skipped: 0, failures: 0, compactedProjects: ["/good"] };
    await expect(invoke(["compact"])).resolves.toBeUndefined();

    expect(state.startInvocation).toHaveBeenCalledOnce();
    const target = state.startInvocation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(target).toMatchObject({ command: "compact", daemonInstanceId: "11111111-1111-4111-8111-111111111111" });
    expect(target.invocationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(state.finishInvocation).toHaveBeenCalledWith(target, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(state.post).toHaveBeenCalledWith("/promote", {
      cwd: "/good",
      dry_run: false,
      invocation_id: target.invocationId,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("disables renderer-owned process signals for compact lifecycle control", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(state.rendererOptions).toMatchObject({ handleSignals: false });
  });

  it("fails closed when a live manual daemon cannot provide invocation identity", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
    });

    const result = await invoke(["compact", "--no-promote"]);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/invocation control|identity/i);
    expect(state.batchOptions).toBeUndefined();
    expect(state.startInvocation).not.toHaveBeenCalled();
  });

  it("returns the latched signal status when authenticated health aborts before registration", async () => {
    state.health.mockImplementationOnce(async () => {
      process.emit("SIGINT");
      throw new Error("health request aborted");
    });

    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(state.startInvocation).not.toHaveBeenCalled();
    expect(state.batchOptions).toBeUndefined();
    expect(process.exitCode).toBe(130);
  });

  it("drains a signal that arrives during invocation start before returning", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    let startSignal!: AbortSignal;
    state.startInvocation.mockImplementationOnce(async (target: unknown, options: { signal?: AbortSignal }) => {
      startSignal = options.signal!;
      process.emit("SIGINT");
      return { ...target as object, state: "active", activeCount: 0, workCount: 0, commitCount: 0, leaseExpiresAt: null };
    });
    let release!: () => void;
    state.cancelInvocation.mockImplementationOnce((target: unknown) => new Promise(resolve => {
      release = () => resolve({ ...target as object, state: "cancelled", activeCount: 0, workCount: 0, commitCount: 0, leaseExpiresAt: null });
    }));

    let settled = false;
    const pending = invoke(["compact", "--no-promote"]).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(state.cancelInvocation).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toBeUndefined();
    expect(startSignal.aborted).toBe(false);
    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(130);
  });

  it("cancels the invocation after SIGINT and preserves the 130 status", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    let release!: () => void;
    state.batchGate = new Promise<void>(resolve => { release = resolve; });

    const pending = invoke(["compact", "--no-promote"]);
    await vi.waitFor(() => expect(state.startInvocation).toHaveBeenCalledOnce());
    process.emit("SIGINT");
    release();
    await expect(pending).resolves.toBeUndefined();

    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(state.finishInvocation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(130);
  });

  it("turns a heartbeat control failure into cancellation and an invocation failure", async () => {
    vi.useFakeTimers();
    state.health.mockResolvedValueOnce({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.heartbeatInvocation.mockRejectedValueOnce(new Error("heartbeat unavailable"));
    let release!: () => void;
    state.batchGate = new Promise<void>(resolve => { release = resolve; });

    const pending = invoke(["compact", "--no-promote"]);
    await vi.waitFor(() => expect(state.startInvocation).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_000);
    release();
    await expect(pending).resolves.toBeUndefined();

    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    vi.useRealTimers();
  });

  it("preserves SIGTERM precedence and only reports repeated signals while draining", async () => {
    state.health.mockResolvedValueOnce({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    let release!: () => void;
    state.batchGate = new Promise<void>(resolve => { release = resolve; });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const pending = invoke(["compact", "--no-promote"]);
    await vi.waitFor(() => expect(state.startInvocation).toHaveBeenCalledOnce());
    process.emit("SIGTERM");
    process.emit("SIGINT");
    release();
    await expect(pending).resolves.toBeUndefined();

    expect(state.cancelInvocation).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(143);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("already draining"));
  });

  it("cleans up a pre-registration signal without creating an invocation or dispatching work", async () => {
    state.ensureDaemon.mockImplementationOnce(async () => {
      process.emit("SIGINT");
      return { connected: true, spawned: false, restartedForParent: false, pid: 42 };
    });

    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();
    expect(state.startInvocation).not.toHaveBeenCalled();
    expect(state.cancelInvocation).not.toHaveBeenCalled();
    expect(state.batchOptions).toBeUndefined();
    expect(process.exitCode).toBe(130);
  });

  it("preserves a preflight signal when daemon startup fails concurrently", async () => {
    state.ensureDaemon.mockImplementationOnce(async () => {
      process.emit("SIGINT");
      throw new Error("daemon startup failed");
    });

    const result = await invoke(["compact", "--no-promote"]);
    expect(result).toBeUndefined();
    expect(state.startInvocation).not.toHaveBeenCalled();
    expect(state.batchOptions).toBeUndefined();
    expect(process.exitCode).toBe(130);
  });

  it("removes command signal handlers after normal compact teardown", async () => {
    const on = vi.spyOn(process, "on");
    const remove = vi.spyOn(process, "removeListener");
    await expect(invoke(["compact", "--no-promote"])).resolves.toBeUndefined();

    const installed = on.mock.calls.filter(([event]) => event === "SIGINT" || event === "SIGTERM");
    expect(installed).toHaveLength(2);
    for (const [event, handler] of installed) {
      expect(remove).toHaveBeenCalledWith(event, handler);
    }
  });

  it("keeps draining without a final exit when targeted zero remains unproved", async () => {
    vi.useFakeTimers();
    state.health.mockResolvedValueOnce({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    state.cancelInvocation
      .mockImplementationOnce(async (target: unknown) => ({
        ...target as object,
        state: "cancelling",
        activeCount: 1,
        workCount: 1,
        commitCount: 0,
        leaseExpiresAt: null,
      }))
      .mockImplementationOnce(async (target: unknown) => ({
        ...target as object,
        state: "cancelled",
        activeCount: 0,
        workCount: 0,
        commitCount: 0,
        leaseExpiresAt: null,
      }));
    let release!: () => void;
    state.batchGate = new Promise<void>(resolve => { release = resolve; });

    const pending = invoke(["compact", "--no-promote"]);
    await vi.waitFor(() => expect(state.startInvocation).toHaveBeenCalledOnce());
    process.emit("SIGINT");
    release();
    await vi.waitFor(() => expect(state.cancelInvocation).toHaveBeenCalledOnce());
    expect(process.exitCode).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeUndefined();

    expect(state.cancelInvocation).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(130);
    vi.useRealTimers();
  });

  it("does not claim signal exit when a batch failure leaves cancellation unproved", async () => {
    vi.useFakeTimers();
    state.health.mockResolvedValueOnce({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    let release!: () => void;
    state.batchGate = new Promise<void>(resolve => { release = resolve; });
    state.batchError = new Error("ordinary batch failure");
    state.cancelInvocation
      .mockImplementationOnce(async (target: unknown) => ({
        ...target as object,
        state: "cancelling",
        activeCount: 1,
        workCount: 1,
        commitCount: 0,
        leaseExpiresAt: null,
      }))
      .mockImplementationOnce(async (target: unknown) => ({
        ...target as object,
        state: "cancelled",
        activeCount: 0,
        workCount: 0,
        commitCount: 0,
        leaseExpiresAt: null,
      }));

    const pending = invoke(["compact", "--no-promote"]);
    await vi.waitFor(() => expect(state.startInvocation).toHaveBeenCalledOnce());
    process.emit("SIGINT");
    release();
    await vi.waitFor(() => expect(state.cancelInvocation).toHaveBeenCalledOnce());
    expect(process.exitCode).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result).toBeUndefined();
    expect(state.cancelInvocation).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(130);
    vi.useRealTimers();
  });

  it.each([
    { pid: 9, restarted: false, stoppedPid: undefined },
    { pid: 9, restarted: true, stoppedPid: undefined },
    { pid: 9, restarted: true, stoppedPid: 8 },
    { pid: 9, restarted: true, stoppedPid: 9 },
  ] as const)("checks managed restart old-instance identity for %#", async (scenario) => {
    vi.useFakeTimers();
    try {
      state.health.mockReset();
      state.cancelInvocation.mockReset();
      state.health
        .mockResolvedValueOnce({
          status: "healthy", version: "1.4.2", storageBackend: "sqlite",
          daemonInstanceId: "11111111-1111-4111-8111-111111111111",
          ...(scenario.pid === undefined ? {} : { pid: scenario.pid }),
        })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          status: "healthy", version: "1.4.2", storageBackend: "sqlite",
          daemonInstanceId: "33333333-3333-4333-8333-333333333333",
          runtimeDigest: "runtime",
        });
      state.restartDaemon.mockResolvedValueOnce({
        connected: true,
        restarted: scenario.restarted,
        stoppedPid: scenario.stoppedPid,
        pid: 10,
      });
      state.cancelInvocation
        .mockImplementationOnce(async (target: unknown) => ({
          ...target as object,
          state: "cancelling",
          activeCount: 1,
          workCount: 1,
          commitCount: 0,
          leaseExpiresAt: null,
        }))
        .mockImplementationOnce(async (target: unknown) => ({
          ...target as object,
          state: "cancelled",
          activeCount: 0,
          workCount: 0,
          commitCount: 0,
          leaseExpiresAt: null,
        }));
      state.batchSignal = "SIGINT";

      const pending = invoke(["compact", "--no-promote"]);
      await vi.waitFor(() => expect(state.cancelInvocation).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBeUndefined();
      expect(state.restartDaemon).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("covers TTY all-provider import directory filtering", async () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    state.entries = [{ name: "file", isDirectory: () => false }, { name: "project", isDirectory: () => true }];
    state.exists.add(`${process.env.HOME}/.claude/projects`);
    expect(await invoke(["import", "--provider", "all", "--all"])).toBeUndefined();
    expect(state.renderer.printSummary).toHaveBeenCalled();
  });

  it("covers verbose promotion successes, primitive failures, and plural summaries", async () => {
    state.entries = [
      { name: "file", isDirectory: () => false },
      { name: "missing", isDirectory: () => true },
      { name: "bad", isDirectory: () => true },
      { name: "one", isDirectory: () => true },
      { name: "two", isDirectory: () => true },
    ];
    state.exists.add("/lcm/projects");
    for (const name of ["bad", "one", "two"]) state.exists.add(`/lcm/projects/${name}/meta.json`);
    state.files.set("/lcm/projects/bad/meta.json", "bad json");
    state.files.set("/lcm/projects/one/meta.json", JSON.stringify({ cwd: "/one" }));
    state.files.set("/lcm/projects/two/meta.json", JSON.stringify({ cwd: "/two" }));
    state.post.mockResolvedValueOnce({ processed: 2, promoted: 1, conversations: 2 }).mockRejectedValueOnce("failed");
    expect(await invoke(["promote", "--all", "--verbose", "--dry-run"])).toBeUndefined();
  });

  it("covers all-project exports, generated slugs, metadata skips, and warnings", async () => {
    state.entries = [
      { name: "file", isDirectory: () => false },
      { name: "missing", isDirectory: () => true },
      { name: "bad", isDirectory: () => true },
      { name: "one", isDirectory: () => true },
      { name: "two", isDirectory: () => true },
    ];
    state.exists.add("/lcm/projects");
    for (const name of ["bad", "one", "two"]) state.exists.add(`/lcm/projects/${name}/meta.json`);
    state.files.set("/lcm/projects/bad/meta.json", "bad json");
    state.files.set("/lcm/projects/one/meta.json", JSON.stringify({ cwd: "/a path/one" }));
    state.files.set("/lcm/projects/two/meta.json", JSON.stringify({ cwd: "/two" }));
    const portable = await import("../../src/portable-knowledge.js");
    vi.mocked(portable.exportKnowledge).mockResolvedValueOnce({ exported: 2, entries: [] }).mockRejectedValueOnce(new Error("export failed"));
    expect(await invoke(["export", "--all"])).toBeUndefined();
  });

  it("covers import result dry-run and rejection branches", async () => {
    state.fileText = JSON.stringify({ version: 1, entries: [] });
    state.portableResult = { exported: 0, imported: 0, skipped: 0, total: 2, dryRun: true };
    expect(await invoke(["import-knowledge", "input.json"])).toBeUndefined();
    const portable = await import("../../src/portable-knowledge.js");
    vi.mocked(portable.importKnowledge).mockRejectedValueOnce(new Error("import failed"));
    expect((await invoke(["import-knowledge", "input.json"]))?.message).toBe("exit:1");
  });

});
