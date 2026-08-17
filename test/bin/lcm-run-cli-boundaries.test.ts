import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const state = vi.hoisted(() => ({
  exit: vi.fn((code?: string | number | null): never => { throw new Error(`exit:${code ?? 0}`); }),
  ensureDaemon: vi.fn(async () => ({ connected: true, spawned: false, restartedForParent: false, pid: 42 })),
  restartDaemon: vi.fn(async () => ({ connected: true, restarted: true, spawned: false, pid: 42 })),
  createDaemon: vi.fn(async () => ({ address: () => ({ port: 3737 }) })),
  post: vi.fn(async () => ({ processed: 1, promoted: 1 })),
  get: vi.fn(async () => ({ totalConnections: 1, activeConnections: 0, idleConnections: 1, connections: [] })),
  health: vi.fn(async () => true),
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
  batchPatch: { lastResult: { ok: true } } as Record<string, unknown>,
  portableResult: { exported: 1, imported: 1, skipped: 0, total: 1, dryRun: false },
  importResult: { imported: 1, skipped: 0 },
  importPatch: { lastResult: { ok: true } } as Record<string, unknown>,
  renderer: { start: vi.fn(), stop: vi.fn(), sessionDone: vi.fn(), printSummary: vi.fn() },
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
vi.mock("../../src/daemon/client.js", () => ({ DaemonClient: class { post = state.post; get = state.get; health = state.health; } }));
vi.mock("../../src/daemon/server.js", () => ({ createDaemon: state.createDaemon }));
vi.mock("../../src/daemon/auth.js", () => ({ ensureAuthToken: vi.fn(), readAuthToken: state.readAuthToken }));
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
vi.mock("../../src/batch-compact.js", (): { batchCompact: ReturnType<typeof vi.fn> } => ({ batchCompact: vi.fn(async (opts: { onProgress?: (patch: unknown) => void }): Promise<typeof state.batchResult> => {
  if (state.batchError !== undefined) throw state.batchError;
  opts.onProgress?.(state.batchPatch); return state.batchResult;
}) }));
vi.mock("../../src/cli/progress-state.js", () => ({ makeProgressState: vi.fn((value: Record<string, unknown>) => {
  const progressState = {
    total: 0, completed: 0, errors: [], phaseErrors: [], tokensIn: 0, tokensOut: 0, messagesIn: 0, ...value,
  };
  state.progressState = progressState;
  return progressState;
}) }));
vi.mock("../../src/cli/pipeline-runner.js", () => ({ NinjaRenderer: class {
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
vi.mock("../../installer/install.js", () => ({ install: vi.fn(async () => undefined) }));
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
  state.batchPatch = { lastResult: { ok: true } };
  state.importPatch = { lastResult: { ok: true } };
  state.health.mockResolvedValue(true);
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
