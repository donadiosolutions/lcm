import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigValidationError } from "../../src/daemon/config.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import { StorageBackendUnavailableError } from "../../src/storage/backend.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";
import { createPublicationConvergence } from "../../src/storage/publication-convergence.js";

const FIXED_PUBLICATION_ADMISSION_DIAGNOSTIC =
  "lcm: backend publication admission blocked; preserve the evidence, run 'lcm doctor', and resolve the authenticated publication before retrying.";

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
  readAuthToken: vi.fn(() => state.authToken),
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
  codexMcpInspection: { state: "absent" as "installed" | "absent" | "unknown" } as { state: "installed" | "absent" | "unknown"; reason?: "collision" | "unavailable" },
  storedCodexTransport: undefined as "cli" | "mcp" | undefined,
  installResult: { path: "/connector", requiresRestart: false } as Record<string, unknown>,
  removeResult: true,
  batchResult: { compacted: 1, unchanged: 0, skipped: 0, failures: 0, compactedProjects: ["/project"] },
  importResult: { imported: 1, skipped: 0 },
  portableResult: { exported: 1, imported: 1, skipped: 0, total: 1, dryRun: false },
  provider: "openai",
  authToken: "test-token" as string | null,
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
  packageFileReads: 0,
  storageBackend: "sqlite" as "sqlite" | "postgresql",
  packagedRuntimeEntrypoint: "/daemon" as string | undefined,
  runtimeDigest: "runtime" as string | undefined,
  provisionResult: {
    applied: ["0001_migration_ledger"],
    current: ["0001_migration_ledger"],
  },
  provisionError: undefined as unknown,
  reconcileWorktrees: vi.fn((path: string) => ({
    targetHash: path,
    canonical: path,
  })),
  daemonClientInstances: 0,
  listConnectors: vi.fn(() => state.installed),
  listConnectorInventory: vi.fn(() => ({ installed: state.installed, codexMcp: state.codexMcpInspection })),
  installConnector: vi.fn(() => state.installResult),
  removeConnector: vi.fn(() => state.removeResult),
  inspectCodexPostToolHook: vi.fn(() => ({
    path: "/home/test/.codex/hooks.json",
    state: "installed",
    structural: true,
  })),
  resolveCodexHooksPath: vi.fn(() => "/home/test/.codex/hooks.json"),
  codexPostToolFunctionalCoverage: vi.fn(() => true),
  registerMachine: vi.fn(),
  showMachine: vi.fn(),
  recoverMachine: vi.fn(),
  listProjects: vi.fn(),
  showProject: vi.fn(),
  linkProject: vi.fn(),
  unlinkProject: vi.fn(),
  createProject: vi.fn(),
  runtimeHome: "/lcm",
  runtimePidPath: "/lcm/daemon.pid",
  runtimeTokenPath: "/lcm/daemon.token",
  migrateLegacyHome: vi.fn(),
  install: vi.fn(async () => undefined),
  createInstallerPublicationConvergence: vi.fn(),
  ensureAuthToken: vi.fn(),
  createDaemon: vi.fn(async () => ({ address: () => ({ port: 3737 }) })),
}));

vi.mock("../../src/daemon/version.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/daemon/version.js")>()),
  PKG_VERSION: "1.4.2",
  get PACKAGED_RUNTIME_ENTRYPOINT() { return state.packagedRuntimeEntrypoint; },
  get RUNTIME_DIGEST() { return state.runtimeDigest; },
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
    if (String(path).endsWith("package.json")) {
      state.packageFileReads += 1;
      return JSON.stringify({ version: state.packageVersion });
    }
    if (state.readError) throw state.readError;
    return state.fileText;
  }),
  existsSync: vi.fn(() => state.exists),
  readdirSync: vi.fn(() => state.entries),
  mkdirSync: vi.fn(), writeFileSync: vi.fn(), unlinkSync: vi.fn(),
}));
vi.mock("../../src/storage/backend-publication.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/storage/backend-publication.js")>();
  return {
    ...actual,
    assertBackendPublicationConsumerAccess: vi.fn(({ backend }: { readonly backend?: string }) => {
      if (backend === "postgresql") {
        throw new actual.BackendPublicationJournalError(
          "publication-evidence-missing",
          "test publication admission blocked",
        );
      }
    }),
  };
});
vi.mock("../../src/runtime-paths.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/runtime-paths.js")>()),
  configPath: () => `${state.runtimeHome}/.lcm/config.json`,
  daemonPidPath: () => state.runtimePidPath,
  daemonTokenPath: () => state.runtimeTokenPath,
  lcmHomeDir: () => state.runtimeHome,
  migrateLegacyHomeIfNeeded: state.migrateLegacyHome,
  projectsDir: () => `${state.runtimeHome}/projects`,
}));
vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: class {
    post = state.post;
    get = state.get;
    health = state.health;
    constructor() {
      state.daemonClientInstances++;
    }
  },
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
vi.mock("../../src/cli-help.js", () => ({
  hasCommandHelp: vi.fn((command: string) => new Set([
    "install", "uninstall", "daemon", "config", "status", "doctor", "machine", "project",
    "postgres", "search", "grep", "describe", "expand", "store", "compact", "restore",
    "session-end", "user-prompt", "post-tool", "session-snapshot", "mcp", "events", "diagnose",
    "connectors", "sensitive", "import", "promote", "export", "import-knowledge",
  ]).has(command)),
  printHelp: state.printHelp,
}));
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
vi.mock("../../src/daemon/server.js", () => ({ createDaemon: state.createDaemon }));
vi.mock("../../src/daemon/auth.js", () => ({ ensureAuthToken: state.ensureAuthToken, readAuthToken: state.readAuthToken }));
vi.mock("../../src/stats.js", () => ({ collectStats: vi.fn(() => ({ ok: true })), printStats: vi.fn() }));
vi.mock("../../src/doctor/doctor.js", () => ({ runDoctor: vi.fn(async () => state.doctorResults), printResults: vi.fn() }));
vi.mock("../../src/diagnose.js", () => ({ diagnose: vi.fn(async () => ({ ok: true })), formatDiagnoseResult: vi.fn(() => "diagnosed") }));
vi.mock("../../src/sensitive.js", () => ({ handleSensitive: vi.fn(async () => ({ stdout: state.sensitiveStdout, exitCode: 0 })) }));
vi.mock("../../src/connectors/registry.js", () => ({
  AGENTS: [
    {
      id: "codex", name: "Codex", category: "cli", defaultTransport: "cli",
      capabilities: { cli: { guidance: ["skill"] }, mcp: { guidance: ["skill"], mcpAdapter: true } },
    },
    {
      id: "cursor", name: "Cursor", category: "ai-ide", defaultTransport: "cli",
      capabilities: { cli: { guidance: ["skill", "rules"] }, mcp: { guidance: ["skill"], mcpAdapter: true } },
    },
    {
      id: "cline", name: "Cline", category: "vscode-ext", defaultTransport: "cli",
      capabilities: { cli: { guidance: ["rules"] } },
    },
    {
      id: "qwen-code", name: "Qwen Code", category: "cli", defaultTransport: "mcp",
      capabilities: { cli: { guidance: ["skill", "rules"] }, mcp: { guidance: ["rules"], mcpAdapter: true } },
    },
  ],
  findAgent: vi.fn((name: string) => name === "codex" ? ({ id: "codex", name: "Codex" }) : undefined),
}));
vi.mock("../../src/connectors/installer.js", () => ({
  listConnectors: state.listConnectors,
  listConnectorInventory: vi.fn(() => ({ installed: state.installed, codexMcp: state.codexMcpInspection })),
  installConnector: state.installConnector,
  removeConnector: state.removeConnector,
}));
vi.mock("../../src/connectors/codex-hooks.js", () => ({
  inspectCodexPostToolHook: state.inspectCodexPostToolHook,
  resolveCodexHooksPath: state.resolveCodexHooksPath,
}));
vi.mock("../../src/hooks/post-tool-normalization.js", () => ({
  codexPostToolFunctionalCoverage: state.codexPostToolFunctionalCoverage,
}));
vi.mock("../../src/identity-service.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/identity-service.js")>()),
  registerMachine: state.registerMachine,
  showMachine: state.showMachine,
  recoverMachine: state.recoverMachine,
  listProjects: state.listProjects,
  showProject: state.showProject,
  linkProject: state.linkProject,
  unlinkProject: state.unlinkProject,
  createProject: state.createProject,
}));
vi.mock("../../src/config-manager.js", () => ({
  getConfigValue: state.configGetValue,
  formatConfigValue: vi.fn((value: unknown) => JSON.stringify(value)), normalizeConfigPath: vi.fn((path: string) => path),
  setConfigValue: state.configSetValue,
  readConnectorTransport: vi.fn(() => state.storedCodexTransport),
  readConnectorTransportSnapshot: vi.fn(() => state.storedCodexTransport),
}));
vi.mock("../../installer/install.js", () => ({
  install: state.install,
  createInstallerPublicationConvergence: state.createInstallerPublicationConvergence,
}));
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
  assertParsedInternalDaemonTestIdentity, handleCliError, isStrictContainedRelativePath,
  migrateLegacyHomeWithRetry,
  resolveCompactRequestPolicyOverride,
  runCli, runMainIfInvoked, shouldRunMain,
  withHookOverrides, writeCliError, writeCliOutput,
} = await import("../../bin/lcm.js");
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const actualRuntimePaths = await vi.importActual<typeof import("../../src/runtime-paths.js")>("../../src/runtime-paths.js");
const { batchCompact } = await import("../../src/batch-compact.js");
const { isDaemonTransportFailure } = await import("../../src/daemon/http-url.js");

type RootBootstrapTestSeams = {
  migrate: () => unknown;
  sleep: (delayMs: number) => Promise<void>;
  attempt?: (attempt: number) => void;
};

function makeTestConvergence(
  readOwner: () => { version: 1; pid: number; processStartTime: string; nonce: string } =
    () => ({ version: 1, pid: 42, processStartTime: "birth", nonce: "a".repeat(32) }),
) {
  let now = 0;
  return createPublicationConvergence({
    port: 3737,
    identity: { pid: 42, version: "1.4.2", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" },
    expectedEntrypoint: "/daemon",
    expectedRuntimeDigest: "runtime",
    deps: {
      now: () => now,
      sleep: async (delayMs: number) => { now += delayMs; },
      readToken: () => "token",
      readOwner,
      processBirth: () => "birth",
      lockPath: "/tmp/publication.lock",
      fetch: vi.fn(async () => ({ ok: true, json: async () => ({
        status: "ok", pid: 42, version: "1.4.2", storageBackend: "sqlite",
        entrypoint: "/daemon", runtimeDigest: "runtime",
      }) })) as unknown as typeof globalThis.fetch,
    },
  });
}

async function invoke(args: string[], seams?: RootBootstrapTestSeams): Promise<Error | undefined> {
  try {
    await runCli(["node", "lcm", ...args], seams);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.createInstallerPublicationConvergence.mockResolvedValue(undefined);
  state.install.mockResolvedValue(undefined);
  fakeStdin.on.mockReset();
  fakeStdin.destroy.mockReset();
  fakeStdin.isTTY = true;
  state.ensureDaemon.mockResolvedValue({ connected: true, spawned: false, restartedForParent: false, pid: 42 });
  state.health.mockResolvedValue(true);
  state.authToken = "test-token";
  state.installed = [];
  state.codexMcpInspection = { state: "absent" };
  state.storedCodexTransport = undefined;
  state.installResult = { path: "/connector", requiresRestart: false };
  state.removeResult = true;
  state.inspectCodexPostToolHook.mockReturnValue({
    path: "/home/test/.codex/hooks.json",
    state: "installed",
    structural: true,
  });
  state.resolveCodexHooksPath.mockReturnValue("/home/test/.codex/hooks.json");
  state.codexPostToolFunctionalCoverage.mockReturnValue(true);
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
  state.packageFileReads = 0;
  state.runtimeHome = "/lcm";
  state.runtimePidPath = "/lcm/daemon.pid";
  state.runtimeTokenPath = "/lcm/daemon.token";
  state.storageBackend = "sqlite";
  state.packagedRuntimeEntrypoint = "/daemon";
  state.runtimeDigest = "runtime";
  state.provisionResult = {
    applied: ["0001_migration_ledger"],
    current: ["0001_migration_ledger"],
  };
  state.provisionError = undefined;
  state.daemonClientInstances = 0;
  state.batchResult = { compacted: 1, unchanged: 0, skipped: 0, failures: 0, compactedProjects: ["/project"] };
  state.migrateLegacyHome.mockReset();
  state.migrateLegacyHome.mockImplementation(() => undefined);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runCli registration and help dispatch", () => {
  it("creates one convergence and passes it to top-level install", async () => {
    const convergence = createPublicationConvergence({
      port: 3737,
      identity: { pid: 42, version: "1.4.2", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" },
      expectedEntrypoint: "/daemon",
      expectedRuntimeDigest: "runtime",
      deps: {
        readToken: () => "token",
        readOwner: () => ({ version: 1, pid: 42, processStartTime: "birth", nonce: "a".repeat(32) }),
        processBirth: () => "birth",
        lockPath: "/tmp/publication.lock",
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({ status: "ok", pid: 42, version: "1.4.2", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" }) })) as unknown as typeof globalThis.fetch,
      },
    });
    state.createInstallerPublicationConvergence.mockResolvedValue(convergence);

    await invoke(["install"]);

    expect(state.createInstallerPublicationConvergence).toHaveBeenCalledOnce();
    expect(state.install).toHaveBeenCalledWith(undefined, convergence);
  });

  it("retries top-level doctor migration through the shared convergence", async () => {
    const convergence = createPublicationConvergence({
      port: 3737,
      identity: { pid: 42, version: "1.4.2", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" },
      expectedEntrypoint: "/daemon",
      expectedRuntimeDigest: "runtime",
      deps: {
        now: (() => { let value = 0; return () => value; })(),
        sleep: async () => undefined,
        readToken: () => "token",
        readOwner: () => ({ version: 1, pid: 42, processStartTime: "birth", nonce: "a".repeat(32) }),
        processBirth: () => "birth",
        lockPath: "/tmp/publication.lock",
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({ status: "ok", pid: 42, version: "1.4.2", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" }) })) as unknown as typeof globalThis.fetch,
      },
    });
    state.createInstallerPublicationConvergence.mockResolvedValue(convergence);
    const contention = new PrivateMutationLockContentionError("publication busy");
    state.migrateLegacyHome.mockImplementationOnce(() => { throw contention; }).mockImplementationOnce(() => undefined);

    await invoke(["doctor"]);

    expect(state.createInstallerPublicationConvergence).toHaveBeenCalledOnce();
    expect(state.migrateLegacyHome).toHaveBeenCalledTimes(2);
  });

  it("reuses the preAction convergence for config reads and prints once", async () => {
    const convergence = createPublicationConvergence({
      port: 3737,
      identity: { pid: 42, version: "1.4.2", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" },
      expectedEntrypoint: "/daemon",
      expectedRuntimeDigest: "runtime",
      deps: {
        sleep: async () => undefined,
        readToken: () => "token",
        readOwner: () => ({ version: 1, pid: 42, processStartTime: "birth", nonce: "a".repeat(32) }),
        processBirth: () => "birth",
        lockPath: "/tmp/publication.lock",
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({
          status: "ok", pid: 42, version: "1.4.2", storageBackend: "sqlite",
          entrypoint: "/daemon", runtimeDigest: "runtime",
        }) })) as unknown as typeof globalThis.fetch,
      },
    });
    state.createInstallerPublicationConvergence.mockResolvedValue(convergence);
    const contention = new PrivateMutationLockContentionError("publication busy");
    state.configGetValue.mockImplementationOnce(() => { throw contention; });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await invoke(["config", "get", "llm.provider"]);

    expect(state.createInstallerPublicationConvergence).toHaveBeenCalledOnce();
    expect(state.migrateLegacyHome).toHaveBeenCalledOnce();
    expect(state.configGetValue).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
  });

  it("preserves the original action contention when the shared deadline expires", async () => {
    let now = 0;
    let sleeps = 0;
    const convergence = createPublicationConvergence({
      port: 3737,
      identity: { pid: 42, version: "1.4.2", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" },
      expectedEntrypoint: "/daemon",
      expectedRuntimeDigest: "runtime",
      deps: {
        now: () => now,
        sleep: async () => { sleeps += 1; now = sleeps === 1 ? 1_990 : 2_000; },
        readToken: () => "token",
        readOwner: () => ({ version: 1, pid: 42, processStartTime: "birth", nonce: "a".repeat(32) }),
        processBirth: () => "birth",
        lockPath: "/tmp/publication.lock",
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({
          status: "ok", pid: 42, version: "1.4.2", storageBackend: "sqlite",
          entrypoint: "/daemon", runtimeDigest: "runtime",
        }) })) as unknown as typeof globalThis.fetch,
      },
    });
    state.createInstallerPublicationConvergence.mockResolvedValue(convergence);
    const contention = new PrivateMutationLockContentionError("publication busy");
    state.migrateLegacyHome.mockImplementationOnce(() => { throw contention; }).mockImplementationOnce(() => undefined);
    state.configGetValue.mockImplementationOnce(() => { throw contention; });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect((await invoke(["config", "get", "llm.provider"]))?.message).toBe("exit:1");
    expect(state.migrateLegacyHome).toHaveBeenCalledTimes(2);
    expect(state.configGetValue).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it("does not retry action contention for a foreign lock owner", async () => {
    const convergence = makeTestConvergence(() => ({
      version: 1, pid: 99, processStartTime: "foreign", nonce: "b".repeat(32),
    }));
    state.createInstallerPublicationConvergence.mockResolvedValue(convergence);
    const contention = new PrivateMutationLockContentionError("publication busy");
    state.configGetValue.mockImplementationOnce(() => { throw contention; });

    expect((await invoke(["config", "get", "llm.provider"]))?.message).toBe("exit:1");
    expect(state.configGetValue).toHaveBeenCalledOnce();
  });

  it.each([
    ["machine", "show"],
    ["project", "list"],
    ["project", "show"],
    ["config", "get", "llm.provider"],
    ["stats"],
    ["events", "status"],
    ["events", "validate"],
    ["events", "quarantine"],
    ["sensitive", "list"],
    ["sensitive", "test", "value"],
    ["export"],
  ])("admits selected local read %# through the convergence gate", async (...args) => {
    state.createInstallerPublicationConvergence.mockResolvedValue(makeTestConvergence());
    const contention = new PrivateMutationLockContentionError("publication busy");
    state.migrateLegacyHome.mockImplementationOnce(() => { throw contention; }).mockImplementationOnce(() => undefined);
    state.showMachine.mockReturnValue({ version: 1, machineId: "machine", displayName: "test" });
    state.listProjects.mockResolvedValue({ local: [], remote: null });
    state.showProject.mockResolvedValue({ hash: "hash", entry: { canonical: "/project", aliases: [] }, remote: null });
    await invoke(args);
    expect(state.createInstallerPublicationConvergence).toHaveBeenCalledOnce();
    expect(state.migrateLegacyHome).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["machine", "register"],
    ["project", "link", "target"],
    ["config", "set", "llm.provider", "openai"],
    ["events", "promote"],
    ["sensitive", "add", "PATTERN"],
  ])("keeps mutation action %# outside the read convergence gate", async (...args) => {
    state.migrateLegacyHome.mockImplementation(() => undefined);
    await invoke(args);
    expect(state.createInstallerPublicationConvergence).not.toHaveBeenCalled();
  });

  it("pins sensitive variadic parsing and preserves mutation migration", async () => {
    state.createInstallerPublicationConvergence.mockResolvedValue(makeTestConvergence());
    await invoke(["sensitive", "--", "list"]);
    expect(state.createInstallerPublicationConvergence).toHaveBeenCalledOnce();

    state.createInstallerPublicationConvergence.mockClear();
    await invoke(["sensitive"]);
    await invoke(["sensitive", "unknown"]);
    expect(state.createInstallerPublicationConvergence).not.toHaveBeenCalled();

    const contention = new PrivateMutationLockContentionError("publication busy");
    state.migrateLegacyHome.mockImplementation(() => { throw contention; });
    expect(await invoke(["sensitive", "add", "PATTERN"])).toBe(contention);
    expect(state.createInstallerPublicationConvergence).not.toHaveBeenCalled();
  });

  it("retries project list and show preparation while preserving one result", async () => {
    state.createInstallerPublicationConvergence.mockImplementation(async () => makeTestConvergence());
    state.listProjects.mockImplementationOnce(() => { throw new PrivateMutationLockContentionError("busy"); })
      .mockResolvedValue({ local: [], remote: null });
    state.showProject.mockImplementationOnce(() => { throw new PrivateMutationLockContentionError("busy"); })
      .mockResolvedValue({ hash: "hash", entry: { canonical: "/project", aliases: [] }, remote: null });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const list = await invoke(["project", "list", "--json"]);
    const show = await invoke(["project", "show", "--json"]);
    expect(list).toBeUndefined();
    expect(show).toBeUndefined();
    expect(state.listProjects).toHaveBeenCalledTimes(2);
    expect(state.showProject).toHaveBeenCalledTimes(2);
    expect(output).toHaveBeenCalledTimes(2);
  });

  it("retries stats, sensitive, and export preparation without replaying output", async () => {
    state.createInstallerPublicationConvergence.mockImplementation(async () => makeTestConvergence());
    const statsModule = await import("../../src/stats.js");
    vi.mocked(statsModule.collectStats).mockImplementationOnce(() => { throw new PrivateMutationLockContentionError("busy"); });
    await invoke(["stats"]);
    expect(statsModule.collectStats).toHaveBeenCalledTimes(2);

    const sensitiveModule = await import("../../src/sensitive.js");
    vi.mocked(sensitiveModule.handleSensitive).mockImplementationOnce(async () => { throw new PrivateMutationLockContentionError("busy"); });
    await invoke(["sensitive", "list"]);
    expect(sensitiveModule.handleSensitive).toHaveBeenCalledTimes(2);

  });

  it("passes the captured convergence to export exactly once", async () => {
    const convergence = makeTestConvergence();
    state.createInstallerPublicationConvergence.mockResolvedValue(convergence);
    const portable = await import("../../src/portable-knowledge.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await invoke(["export", "--output", "out.json"]);

    expect(state.createInstallerPublicationConvergence).toHaveBeenCalledOnce();
    expect(portable.exportKnowledge).toHaveBeenCalledOnce();
    expect(portable.exportKnowledge.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ _publicationConvergence: convergence, output: "out.json" }),
    );
    expect(log).toHaveBeenCalledWith("  Exported 1 entries to out.json");
  });

  it("passes one captured convergence to each export-all target", async () => {
    const convergence = makeTestConvergence();
    state.createInstallerPublicationConvergence.mockResolvedValue(convergence);
    state.entries = [{ name: "project", isDirectory: () => true }];
    state.fileText = JSON.stringify({ cwd: "/project" });
    const portable = await import("../../src/portable-knowledge.js");

    await invoke(["export", "--all"]);

    expect(portable.exportKnowledge).toHaveBeenCalledOnce();
    expect(portable.exportKnowledge.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ _publicationConvergence: convergence }),
    );
  });

  it("retries transient root bootstrap contention for an ordinary command", async () => {
    vi.useFakeTimers();
    const contention = new actualRuntimePaths.BootstrapLockContentionError(
      "LCM root bootstrap is already in progress; retry after it completes",
    );
    state.migrateLegacyHome
      .mockImplementationOnce(() => { throw contention; })
      .mockImplementationOnce(() => undefined);

    const pending = invoke(["search", "q"]);
    await vi.advanceTimersByTimeAsync(50);

    expect(await pending).toBeUndefined();
    expect(state.post).toHaveBeenCalledWith("/search", expect.objectContaining({ query: "q" }));
    expect(state.migrateLegacyHome).toHaveBeenCalledTimes(2);
  });

  it("uses a single root bootstrap migration for an immediately successful search", async () => {
    expect(await invoke(["search", "q"])).toBeUndefined();
    expect(state.post).toHaveBeenCalledWith("/search", expect.objectContaining({ query: "q" }));
    expect(state.migrateLegacyHome).toHaveBeenCalledTimes(1);
  });

  it("root bootstrap retry policy retries typed contention and records attempts", async () => {
    const contention = new actualRuntimePaths.BootstrapLockContentionError(
      "LCM root bootstrap is already in progress; retry after it completes",
    );
    const migrate = vi.fn()
      .mockImplementationOnce(() => { throw contention; })
      .mockImplementationOnce(() => undefined);
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const attempt = vi.fn();

    await migrateLegacyHomeWithRetry({
      migrate,
      sleep,
      attempt,
    });

    expect(migrate).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(50);
    expect(attempt.mock.calls.map(([value]) => value)).toEqual([1, 2]);
  });

  it("root bootstrap retry policy stops after twenty typed contention attempts", async () => {
    const contention = new actualRuntimePaths.BootstrapLockContentionError(
      "LCM root bootstrap is already in progress; retry after it completes",
    );
    const migrate = vi.fn(() => { throw contention; });
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const attempt = vi.fn();

    await expect(migrateLegacyHomeWithRetry({ migrate, sleep, attempt })).rejects.toBe(contention);

    expect(migrate).toHaveBeenCalledTimes(20);
    expect(sleep).toHaveBeenCalledTimes(19);
    expect(sleep).toHaveBeenNthCalledWith(19, 50);
    expect(attempt.mock.calls.map(([value]) => value)).toEqual(
      Array.from({ length: 20 }, (_value, index) => index + 1),
    );
  });

  it.each([
    "LCM root bootstrap owner state is ambiguous",
    "LCM root bootstrap stale-lock recovery is already in progress",
    "bootstrap lock changed during stale-owner recovery",
    "LCM root bootstrap lock was claimed concurrently",
    "LCM root bootstrap lock could not be authenticated",
    "non-contention migration failure",
  ])("does not retry untyped root bootstrap failure: %s", async (message) => {
    const failure = new Error(message);
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const migrate = vi.fn(() => { throw failure; });

    await expect(migrateLegacyHomeWithRetry({ migrate, sleep })).rejects.toBe(failure);

    expect(migrate).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

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
    const contentionError = new actualRuntimePaths.BootstrapLockContentionError(
      "safe bootstrap contention message",
    );
    expect(() => handleCliError(genericError)).toThrow("exit:1");
    expect(() => handleCliError(configError)).toThrow("exit:1");
    expect(() => handleCliError(backendError)).toThrow("exit:1");
    expect(() => handleCliError(contentionError)).toThrow("exit:1");
    expect(() => writeCliOutput("out")).not.toThrow();
    expect(() => writeCliError("err")).not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(4);
    expect(consoleError).toHaveBeenNthCalledWith(1, genericError);
    expect(consoleError).toHaveBeenNthCalledWith(2, configError.message);
    expect(consoleError).toHaveBeenNthCalledWith(3, backendError.message);
    expect(consoleError).toHaveBeenNthCalledWith(4, contentionError.message);
    const publicationContention = new PrivateMutationLockContentionError("publication contention");
    expect(() => handleCliError(publicationContention)).toThrow("exit:1");
    expect(consoleError).toHaveBeenNthCalledWith(5, publicationContention.message);
    expect(consoleError).toHaveBeenCalledTimes(5);
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

  it("renders a direct publication admission failure as one fixed diagnostic", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const malicious = new BackendPublicationJournalError(
      "malformed-journal",
      "raw publication secret /tmp/private https://user:password@example.test/path\u001b[31m",
      { cause: new Error("raw cause") },
    );

    expect(() => handleCliError(malicious)).toThrow("exit:1");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(FIXED_PUBLICATION_ADMISSION_DIAGNOSTIC);
    const rendered = JSON.stringify(consoleError.mock.calls);
    expect(rendered).not.toContain(malicious.message);
    expect(rendered).not.toContain("raw cause");
    expect(rendered).not.toContain("/tmp/private");
    expect(rendered).not.toContain("https://user:password");
    expect(rendered).not.toContain("\\u001b");
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

  it.each([
    [["search", "--help"], "search"],
    [["grep", "--help"], "grep"],
    [["describe", "--help"], "describe"],
    [["expand", "--help"], "expand"],
    [["store", "--help"], "store"],
    [["import-knowledge", "--help"], "import-knowledge"],
    [["events", "replay", "--help"], "events"],
    [["config", "get", "--help"], "config"],
    [["config", "set", "--help"], "config"],
    [["machine", "recover", "--help"], "machine"],
    [["project", "link", "--help"], "project"],
    [["connectors", "install", "--help"], "connectors"],
    [["connectors", "remove", "--type", "--help"], "connectors"],
  ] as const)("renders help before required validation for %#", async (args, topic) => {
    expect((await invoke(args))?.message).toBe("exit:0");
    expect(state.printHelp).toHaveBeenCalledWith(topic);
    expect(state.ensureDaemon).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
    expect(state.migrateLegacyHome).not.toHaveBeenCalled();
    expect(state.configGetValue).not.toHaveBeenCalled();
    expect(state.configSetValue).not.toHaveBeenCalled();
    expect(state.listConnectors).not.toHaveBeenCalled();
    expect(state.installConnector).not.toHaveBeenCalled();
    expect(state.removeConnector).not.toHaveBeenCalled();
    expect(state.registerMachine).not.toHaveBeenCalled();
    expect(state.showMachine).not.toHaveBeenCalled();
    expect(state.recoverMachine).not.toHaveBeenCalled();
    expect(state.listProjects).not.toHaveBeenCalled();
    expect(state.showProject).not.toHaveBeenCalled();
    expect(state.linkProject).not.toHaveBeenCalled();
    expect(state.unlinkProject).not.toHaveBeenCalled();
    expect(state.createProject).not.toHaveBeenCalled();
    expect(state.packageFileReads).toBe(0);
  });

  it("keeps unknown --help on the unknown-command path", async () => {
    expect((await invoke(["unknown", "--help"]))?.message).toBe("exit:1");
    expect(state.printHelp).toHaveBeenCalledWith();
    expect(state.printHelp).not.toHaveBeenCalledWith("unknown");
  });

  it("keeps literal arguments after -- out of custom help resolution", async () => {
    expect(await invoke(["store", "--", "--help"])).toBeUndefined();
    expect(state.printHelp).not.toHaveBeenCalled();
    expect(state.post).toHaveBeenCalledWith("/store", expect.objectContaining({ text: "--help" }));
  });

  it.each([
    [["help", "store"], "store"],
    [["help", "store", "--help"], "store"],
    [["help", "--help"], undefined],
  ] as const)("preserves explicit help pseudo-command %#", async (args, topic) => {
    expect((await invoke(args))?.message).toBe("exit:0");
    if (topic === undefined) expect(state.printHelp).toHaveBeenCalledWith(undefined);
    else expect(state.printHelp).toHaveBeenCalledWith(topic);
  });

  it("rejects removed map help through the unknown-command path", async () => {
    expect((await invoke(["map", "add", "--help"]))?.message).toBe("exit:1");
    expect(state.printHelp).toHaveBeenCalledWith();
    expect(state.printHelp).not.toHaveBeenCalledWith("map");
  });
});

describe("runCli daemon-backed and utility actions", () => {
  it("routes all six daemon reads through an authenticated healthy daemon without migration", async () => {
    state.health.mockResolvedValue({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      entrypoint: "/daemon",
      runtimeDigest: "runtime",
    });
    const migrate = vi.fn();
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const root = actualFs.mkdtempSync(join(tmpdir(), "lcm-cli-concurrent-"));
    expect(dirname(root)).toBe(tmpdir());
    actualFs.mkdirSync(join(root, ".lcm"), { recursive: true });
    const previousRuntime = {
      home: state.runtimeHome,
      pid: state.runtimePidPath,
      token: state.runtimeTokenPath,
    };
    state.runtimeHome = root;
    state.runtimePidPath = join(root, ".lcm", "daemon.pid");
    state.runtimeTokenPath = join(root, ".lcm", "daemon.token");
    const reads = [
      ["search", "query"],
      ["grep", "query"],
      ["describe", "node"],
      ["expand", "node"],
      ["status"],
      ["stats", "--pool"],
    ];

    try {
      const results = await Promise.all(reads.map((args) => invoke(args, { migrate, sleep })));

      expect(results).toEqual(reads.map(() => undefined));
      expect(migrate).not.toHaveBeenCalled();
      expect(state.ensureDaemon).not.toHaveBeenCalled();
      expect(state.health).toHaveBeenCalled();
    } finally {
      state.runtimeHome = previousRuntime.home;
      state.runtimePidPath = previousRuntime.pid;
      state.runtimeTokenPath = previousRuntime.token;
      actualFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs legacy migration before routing store through an authenticated healthy daemon", async () => {
    state.health.mockResolvedValue({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      entrypoint: "/daemon",
      runtimeDigest: "runtime",
    });
    const migrate = vi.fn();
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const root = actualFs.mkdtempSync(join(tmpdir(), "lcm-cli-store-"));
    actualFs.mkdirSync(join(root, ".lcm"), { recursive: true });
    const previousRuntime = {
      home: state.runtimeHome,
      pid: state.runtimePidPath,
      token: state.runtimeTokenPath,
    };
    state.runtimeHome = root;
    state.runtimePidPath = join(root, ".lcm", "daemon.pid");
    state.runtimeTokenPath = join(root, ".lcm", "daemon.token");

    try {
      expect(await invoke(["store", "memory", "--tag", "project:lcm"], {
        migrate,
        sleep,
      })).toBeUndefined();

      expect(migrate).toHaveBeenCalledOnce();
      expect(state.ensureDaemon).not.toHaveBeenCalled();
      expect(state.health).toHaveBeenCalledOnce();
      expect(migrate.mock.invocationCallOrder[0])
        .toBeLessThan(state.health.mock.invocationCallOrder[0]!);
      expect(state.post).toHaveBeenCalledWith("/store", {
        cwd: process.cwd(),
        text: "memory",
        tags: ["project:lcm"],
        metadata: {},
      });
    } finally {
      state.runtimeHome = previousRuntime.home;
      state.runtimePidPath = previousRuntime.pid;
      state.runtimeTokenPath = previousRuntime.token;
      actualFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to one authenticated migration when the read fast path cannot authorize", async () => {
    state.health.mockResolvedValue({ status: "ok", storageBackend: "postgresql" });
    const migrate = vi.fn();
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    expect(await invoke(["search", "query"], { migrate, sleep })).toBeUndefined();

    expect(migrate).toHaveBeenCalledOnce();
    expect(state.ensureDaemon).toHaveBeenCalledOnce();
  });

  it("falls back to authenticated migration when store preflight cannot authorize", async () => {
    state.health.mockResolvedValue({ status: "ok", storageBackend: "postgresql" });
    const migrate = vi.fn();
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    expect(await invoke(["store", "memory"], { migrate, sleep })).toBeUndefined();

    expect(migrate).toHaveBeenCalledOnce();
    expect(state.health).toHaveBeenCalledOnce();
    expect(state.ensureDaemon).toHaveBeenCalledOnce();
    expect(migrate.mock.invocationCallOrder[0])
      .toBeLessThan(state.health.mock.invocationCallOrder[0]!);
    expect(state.health.mock.invocationCallOrder[0])
      .toBeLessThan(state.ensureDaemon.mock.invocationCallOrder[0]!);
    expect(state.post).toHaveBeenCalledWith("/store", expect.objectContaining({
      text: "memory",
    }));
  });

  it("never authorizes the read fast path from public health without a token", async () => {
    state.authToken = null;
    state.health.mockResolvedValue({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      entrypoint: "/daemon",
      runtimeDigest: "runtime",
    });
    const migrate = vi.fn();
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    expect(await invoke(["search", "query"], { migrate, sleep })).toBeUndefined();

    expect(migrate).toHaveBeenCalledOnce();
    expect(state.ensureDaemon).toHaveBeenCalledOnce();
    expect(state.health).not.toHaveBeenCalled();
  });

  it.each([
    ["entrypoint", undefined, "runtime"],
    ["runtime digest", "/daemon", undefined],
  ] as const)("falls back when the local packaged %s is unavailable", async (
    _label,
    entrypoint,
    runtimeDigest,
  ) => {
    state.packagedRuntimeEntrypoint = entrypoint;
    state.runtimeDigest = runtimeDigest;
    state.health.mockResolvedValue({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      entrypoint: "/daemon",
      runtimeDigest: "runtime",
    });
    const migrate = vi.fn();
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    expect(await invoke(["search", "query"], { migrate, sleep })).toBeUndefined();

    expect(migrate).toHaveBeenCalledOnce();
    expect(state.ensureDaemon).toHaveBeenCalledOnce();
  });

  it.each([
    ["a stale version", { status: "ok", version: "1.4.1", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" }],
    ["a tokenless daemon marker", { status: "ok", version: "1.4.2", storageBackend: "sqlite", entrypoint: "/daemon" }],
    ["an empty entrypoint", { status: "ok", version: "1.4.2", storageBackend: "sqlite", entrypoint: "", runtimeDigest: "runtime" }],
    ["another entrypoint", { status: "ok", version: "1.4.2", storageBackend: "sqlite", entrypoint: "/other", runtimeDigest: "runtime" }],
    ["an empty runtime marker", { status: "ok", version: "1.4.2", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "" }],
    ["another runtime digest", { status: "ok", version: "1.4.2", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "other" }],
  ])("does not treat %s as authenticated with a stale token", async (_label, health) => {
    state.health.mockResolvedValue(health);
    const migrate = vi.fn();
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    expect(await invoke(["search", "query"], { migrate, sleep })).toBeUndefined();

    expect(migrate).toHaveBeenCalledOnce();
    expect(state.ensureDaemon).toHaveBeenCalledOnce();
  });

  it("keeps pure exits and usage-only parents free of startup migration", async () => {
    const migrate = vi.fn();
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const pureCases = [
      [],
      ["--version"],
      ["unknown"],
      ["help"],
      ["daemon"],
      ["config"],
      ["machine"],
      ["project"],
      ["postgres"],
      ["events"],
      ["connectors"],
      ["diagnose"],
      ["connectors", "list"],
      ["connectors", "doctor", "codex"],
    ];

    for (const args of pureCases) await invoke(args, { migrate, sleep });

    expect(migrate).not.toHaveBeenCalled();
  });

  it("keeps mutation and unclassified actions on the migration path", async () => {
    const migrate = vi.fn();
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const mutationCases = [
      ["daemon", "start"],
      ["daemon", "restart"],
      ["stats"],
      ["doctor"],
      ["config", "get", "daemon.port"],
      ["machine", "show"],
      ["events", "status"],
      ["sensitive", "list"],
      ["project", "list"],
      ["connectors", "install", "codex"],
    ];

    for (const args of mutationCases) {
      await invoke(args, { migrate, sleep });
    }

    expect(migrate).toHaveBeenCalledTimes(mutationCases.length);
  });

  it("propagates private mutation-lock contention from the routed migration", async () => {
    state.health.mockResolvedValue({ status: "ok", storageBackend: "postgresql" });
    const contention = new PrivateMutationLockContentionError("publication lock is busy");
    const migrate = vi.fn(() => { throw contention; });

    await expect(runCli(["node", "lcm", "store", "text"], {
      migrate,
      sleep: async (_delayMs: number) => undefined,
    })).rejects.toBe(contention);

    expect(migrate).toHaveBeenCalledOnce();
    expect(state.health).not.toHaveBeenCalled();
    expect(state.ensureDaemon).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated legacy coexistence before healthy store admission", async () => {
    state.health.mockResolvedValue({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "sqlite",
      entrypoint: "/daemon",
      runtimeDigest: "runtime",
    });
    const rejection = new Error("legacy and active LCM homes coexist without authenticated migration evidence");
    const migrate = vi.fn(() => { throw rejection; });
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    let observed: unknown;
    try {
      await runCli(["node", "lcm", "store", "text"], { migrate, sleep });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(rejection);
    expect(observed).toMatchObject({
      message: "legacy and active LCM homes coexist without authenticated migration evidence",
    });

    expect(migrate).toHaveBeenCalledOnce();
    expect(state.health).not.toHaveBeenCalled();
    expect(state.ensureDaemon).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
  });

  it("defers verified PostgreSQL store mutation admission to the daemon", async () => {
    const root = actualFs.mkdtempSync(join(tmpdir(), "lcm-cli-store-pg-"));
    const lcmDir = join(root, ".lcm");
    const caFile = join(root, "ca.pem");
    actualFs.mkdirSync(lcmDir, { recursive: true });
    actualFs.writeFileSync(join(lcmDir, "config.json"), JSON.stringify({
      storage: { backend: "postgresql" },
    }));
    actualFs.writeFileSync(caFile, "test-ca\n");
    const previousRuntime = {
      home: state.runtimeHome,
      pid: state.runtimePidPath,
      token: state.runtimeTokenPath,
    };
    const previousEnv = {
      url: process.env.LCM_POSTGRES_URL,
      caFile: process.env.LCM_POSTGRES_CA_FILE,
      migrationRole: process.env.LCM_POSTGRES_MIGRATION_ROLE,
    };
    state.runtimeHome = root;
    state.runtimePidPath = join(lcmDir, "daemon.pid");
    state.runtimeTokenPath = join(lcmDir, "daemon.token");
    state.storageBackend = "postgresql";
    process.env.LCM_POSTGRES_URL = "postgresql://lcm:secret@localhost:5432/lcm";
    process.env.LCM_POSTGRES_CA_FILE = caFile;
    process.env.LCM_POSTGRES_MIGRATION_ROLE = "lcm_migrator";
    state.health.mockResolvedValue({
      status: "healthy",
      version: "1.4.2",
      storageBackend: "postgresql",
      entrypoint: "/daemon",
      runtimeDigest: "runtime",
    });
    const migrate = vi.fn();
    const sleep = vi.fn(async (_delayMs: number) => undefined);

    try {
      expect(await invoke(["store", "memory"], { migrate, sleep })).toBeUndefined();
      expect(state.health).toHaveBeenCalledOnce();
      expect(migrate).toHaveBeenCalledOnce();
      expect(state.ensureDaemon).not.toHaveBeenCalled();
      expect(state.post).toHaveBeenCalledWith("/store", expect.objectContaining({
        text: "memory",
      }));
      expect(migrate.mock.invocationCallOrder[0])
        .toBeLessThan(state.health.mock.invocationCallOrder[0]!);
    } finally {
      state.runtimeHome = previousRuntime.home;
      state.runtimePidPath = previousRuntime.pid;
      state.runtimeTokenPath = previousRuntime.token;
      if (previousEnv.url === undefined) delete process.env.LCM_POSTGRES_URL;
      else process.env.LCM_POSTGRES_URL = previousEnv.url;
      if (previousEnv.caFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE;
      else process.env.LCM_POSTGRES_CA_FILE = previousEnv.caFile;
      if (previousEnv.migrationRole === undefined) delete process.env.LCM_POSTGRES_MIGRATION_ROLE;
      else process.env.LCM_POSTGRES_MIGRATION_ROLE = previousEnv.migrationRole;
      actualFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["search", "needle", "--limit", "2", "--layer", "episodic", "--tag", "decision"],
    ["grep", "needle", "--mode", "regex", "--scope", "messages", "--since", "2026-01-01T00:00:00Z"],
    ["describe", "node"], ["expand", "node", "--depth", "2"], ["store", "memory", "--tag", "one"],
  ])("dispatches memory action %#", async (...args) => {
    expect(await invoke(args)).toBeUndefined();
  });

  it("preserves mixed store tag aliases in command-line order", async () => {
    await invoke(["store", "memory", "--tag", "one", "--tags", "two", "--tag", "three"]);
    expect(state.post).toHaveBeenCalledWith("/store", expect.objectContaining({
      text: "memory",
      tags: ["one", "two", "three"],
    }));
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
    state.authToken = null;

    await expect(runCli(["node", "lcm", ...args])).rejects.toBeInstanceOf(BackendPublicationJournalError);
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

    await expect(runCli(["node", "lcm", "stats"])).rejects.toBeInstanceOf(BackendPublicationJournalError);
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
      expect(state.loadPolicyConfig).toHaveBeenLastCalledWith("/lcm/.lcm/config.json");
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

  it("validates compact dry-run without daemon registration or dispatch", async () => {
    expect(await invoke(["compact", "--dry-run", "--max-concurrency", "4"])).toBeUndefined();

    expect(state.ensureDaemon).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
    expect(vi.mocked(batchCompact)).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, maxConcurrency: 4 }),
    );
  });

  it("forwards the CLI concurrency override over the stored setting", async () => {
    state.loadConfig.mockImplementationOnce(() => ({
      daemon: { port: 3737 },
      storage: { backend: "sqlite" },
      llm: {
        provider: "openai",
        apiMode: "responses",
        maxConcurrency: 7,
        requestTimeoutMs: 1000,
        retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2 },
      },
      compaction: { autoCompactMinTokens: 100 },
    }));

    expect(await invoke(["compact", "--no-promote", "--max-concurrency", "4"])).toBeUndefined();
    expect(vi.mocked(batchCompact)).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, maxConcurrency: 4 }),
    );
  });

  it("rejects invalid compact concurrency before daemon registration or dispatch", async () => {
    expect((await invoke(["compact", "--max-concurrency", "0"]))).toMatchObject({
      message: expect.stringContaining("max-concurrency"),
    });

    expect(state.ensureDaemon).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
    expect(batchCompact).not.toHaveBeenCalled();
  });

  it("rejects replay concurrency above one before daemon registration or dispatch", async () => {
    expect((await invoke(["compact", "--replay", "--max-concurrency", "2"]))).toMatchObject({
      message: expect.stringContaining("replay"),
    });

    expect(state.ensureDaemon).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
    expect(batchCompact).not.toHaveBeenCalled();
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

    expect(await invoke(["export", "--all"])).toBeInstanceOf(BackendPublicationJournalError);
    expect(await invoke(["import-knowledge", "input.json"])).toBeInstanceOf(BackendPublicationJournalError);
    expect(portable.exportKnowledge).not.toHaveBeenCalled();
    expect(portable.importKnowledge).not.toHaveBeenCalled();
  });

  it("preserves export --tags comma-separated filtering", async () => {
    const portable = await import("../../src/portable-knowledge.js");
    await invoke(["export", "--tags", "one, two"]);
    expect(portable.exportKnowledge).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: ["one", "two"] }),
    );
  });

  it.each([
    ["compact", "--dry-run"],
    ["import", "--dry-run"],
    ["promote", "--dry-run"],
  ])("rejects direct daemon command %# before lifecycle or daemon network activity", async (...args) => {
    state.storageBackend = "postgresql";

    expect(await invoke(args)).toBeInstanceOf(BackendPublicationJournalError);
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

  it("injects and preserves the top-level Codex client for post-tool dispatch", async () => {
    fakeStdin.isTTY = false;
    fakeStdin.on.mockImplementation((event: string, callback: (chunk?: Buffer) => void) => {
      if (event === "data") queueMicrotask(() => callback(Buffer.from(JSON.stringify({
        client: "claude",
        session_id: "codex-session",
        tool_name: "functions.exec",
      }))));
      if (event === "end") queueMicrotask(() => callback());
      return fakeStdin;
    });

    expect((await invoke(["post-tool", "--client", "codex"]))?.message).toBe("exit:0");
    expect(JSON.parse(state.dispatchHook.mock.calls.at(-1)![1])).toMatchObject({
      client: "codex",
      session_id: "codex-session",
      tool_name: "functions.exec",
    });
  });

  it("dispatches post-tool without root bootstrap migration", async () => {
    fakeStdin.isTTY = false;
    fakeStdin.on.mockImplementation((event: string, callback: (chunk?: Buffer) => void) => {
      if (event === "data") queueMicrotask(() => callback(Buffer.from(JSON.stringify({
        session_id: "codex-session",
        tool_name: "functions.exec",
      }))));
      if (event === "end") queueMicrotask(() => callback());
      return fakeStdin;
    });
    const contention = new PrivateMutationLockContentionError("publication lock is busy");
    const migrate = vi.fn(() => { throw contention; });

    expect((await invoke(["post-tool", "--client", "codex"], {
      migrate,
      sleep: async (_delayMs: number) => undefined,
    }))?.message).toBe("exit:0");
    expect(migrate).not.toHaveBeenCalled();
    expect(state.dispatchHook).toHaveBeenCalledWith("post-tool", expect.any(String));
  });

  it("reports exact Codex structure and functional capture health", async () => {
    state.installed = [{ agentId: "codex", type: "hook", path: "/partial/hooks.json" }];
    state.inspectCodexPostToolHook.mockReturnValue({
      path: "/home/test/.codex/hooks.json",
      state: "installed",
      structural: true,
    });
    state.codexPostToolFunctionalCoverage.mockReturnValue(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await invoke(["connectors", "doctor", "codex", "--global"])).toBeUndefined();
    expect(state.resolveCodexHooksPath).toHaveBeenCalledWith(expect.any(String));
    expect(state.inspectCodexPostToolHook).toHaveBeenCalledWith("/home/test/.codex/hooks.json");
    expect(state.codexPostToolFunctionalCoverage).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join("\n")).toContain("✓ Codex: PostToolUse hook installed");
    expect(log.mock.calls.flat().join("\n")).toContain("✓ Codex: native exec capture functional");
    expect(state.dispatchHook).not.toHaveBeenCalled();
  });

  it("skips the pure functional check when Codex structure is incomplete", async () => {
    state.installed = [{ agentId: "codex", type: "hook", path: "/partial/hooks.json" }];
    state.inspectCodexPostToolHook.mockReturnValue({
      path: "/home/test/.codex/hooks.json",
      state: "incomplete",
      structural: false,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect((await invoke(["connectors", "doctor", "codex"]))?.message).toBe("exit:1");
    expect(state.codexPostToolFunctionalCoverage).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("Codex: native exec capture functional check skipped");
  });

  it("aggregates a nonfunctional Codex result and exits after printing the failure", async () => {
    state.installed = [{ agentId: "codex", type: "hook", path: "/hooks.json" }];
    state.inspectCodexPostToolHook.mockReturnValue({
      path: "/home/test/.codex/hooks.json",
      state: "installed",
      structural: true,
    });
    state.codexPostToolFunctionalCoverage.mockReturnValue(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect((await invoke(["connectors", "doctor", "codex"]))?.message).toBe("exit:1");
    expect(log.mock.calls.flat().join("\n")).toContain("✗ Codex: native exec capture functional");
  });

  it("fails closed when the pure Codex functional probe throws", async () => {
    state.installed = [{ agentId: "codex", type: "hook", path: "/hooks.json" }];
    state.inspectCodexPostToolHook.mockReturnValue({
      path: "/home/test/.codex/hooks.json",
      state: "installed",
      structural: true,
    });
    state.codexPostToolFunctionalCoverage.mockImplementationOnce(() => {
      throw new Error("probe failed");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect((await invoke(["connectors", "doctor", "codex"]))?.message).toBe("exit:1");
    expect(log.mock.calls.flat().join("\n")).toContain("✗ Codex: native exec capture functional");
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

  it("covers lifecycle exceptions and preserves bounded refusal guidance", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    state.ensureDaemon.mockResolvedValueOnce({
      connected: false,
      spawned: false,
      restartedForParent: false,
      pid: undefined,
      refusalReason: "not-running",
    });
    expect((await invoke(["search", "q"]))?.message).toBe("exit:1");
    expect(consoleError).toHaveBeenCalledWith("  lcm daemon unavailable (not-running); run 'lcm daemon start'.");

    consoleError.mockClear();
    state.ensureDaemon.mockRejectedValueOnce(new Error("ensure failed"));
    expect((await invoke(["search", "q"]))?.message).toBe("exit:1");
    expect(consoleError).toHaveBeenCalledWith("  lcm daemon unavailable (ambiguous); run 'lcm daemon restart' or 'lcm doctor'.");

    consoleError.mockClear();
    state.ensureDaemon.mockRejectedValueOnce(new Error("start failed"));
    expect((await invoke(["daemon", "start"]))?.message).toBe("exit:1");
    expect(consoleError).toHaveBeenCalledWith("  lcm daemon unavailable (ambiguous); run 'lcm daemon restart' or 'lcm doctor'.");

    consoleError.mockClear();
    state.restartDaemon.mockRejectedValueOnce(new Error("restart failed"));
    expect((await invoke(["daemon", "restart"]))?.message).toBe("exit:1");
    expect(consoleError).toHaveBeenCalledWith("  lcm daemon unavailable (ambiguous); run 'lcm daemon restart' or 'lcm doctor'.");
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
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    state.authToken = null;
    state.health.mockReset().mockResolvedValue(null);
    expect(await invoke(["status"])).toBeUndefined();
    expect(log).toHaveBeenCalledWith("daemon: down · provider: openai");

    expect(await invoke(["status", "--json"])).toBeUndefined();
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toEqual({
      daemon: { status: "down" },
    });
    expect(state.health).toHaveBeenCalledTimes(2);

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

    state.health.mockResolvedValueOnce(stagedHealth).mockResolvedValueOnce(stagedHealth);
    expect(await invoke(["status"])).toBeUndefined();
    const text = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(text).toContain("Daemon: up");
    expect(text).toContain("Storage: postgresql (unavailable)");
    expect(text).not.toContain("Project:");
    expect(state.post).not.toHaveBeenCalled();

    log.mockClear();
    state.health.mockResolvedValueOnce(stagedHealth).mockResolvedValueOnce(stagedHealth);
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
    expect(await invoke(["connectors", "install", "codex", "--transport", "mcp"])).toBeUndefined();
    state.removeResult = false;
    expect(await invoke(["connectors", "remove", "codex", "--global"])).toBeUndefined();
    state.installed = [{ agentId: "codex", type: "hook", path: "/hook" }];
    expect(await invoke(["connectors", "list"])).toBeUndefined();
    expect(await invoke(["connectors", "list", "--format", "json"])).toBeUndefined();
    expect(await invoke(["connectors", "doctor", "codex"])).toBeUndefined();
  });

  it("lists transport vocabulary and keeps installed surfaces explicit", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    state.installed = [
      { agentId: "codex", type: "hook", path: "/hook" },
      { agentId: "codex", type: "skill", path: "/skill" },
      { agentId: "cursor", type: "mcp", path: "/cursor-mcp" },
      { agentId: "cline", type: "skill", path: "/cline-skill" },
    ];

    expect(await invoke(["connectors", "list", "--format", "json"])).toBeUndefined();

    const payload = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join("")) as {
      agents: Array<Record<string, unknown>>;
    };
    const codex = payload.agents.find(agent => agent.id === "codex");
    expect(codex).toMatchObject({
      defaultTransport: "cli",
      supportedTransports: ["cli", "mcp"],
      installed: ["hook", "skill"],
      installedTransports: ["cli"],
    });
    expect(codex).not.toHaveProperty("defaultType");
    expect(codex).not.toHaveProperty("defaultTypes");
    expect(codex).not.toHaveProperty("supportedTypes");
    expect(payload.agents.find(agent => agent.id === "cursor")).toMatchObject({
      installed: ["mcp"], installedTransports: ["mcp"],
    });
    expect(payload.agents.find(agent => agent.id === "cline")).toMatchObject({
      installed: ["skill"], installedTransports: ["cli"],
    });
    expect(payload.agents.find(agent => agent.id === "qwen-code")).toMatchObject({
      installed: [], installedTransports: [],
    });
  });

  it("uses transport vocabulary in the human-readable connector list", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await invoke(["connectors", "list"])).toBeUndefined();

    const text = log.mock.calls.flat().map(value => String(value)).join("\n");
    expect(text).toContain("Default transport");
    expect(text).toContain("Supported transports");
    expect(text).not.toContain("Default  ");
  });

  it("does not infer a Codex CLI transport when native MCP inspection is unknown", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    state.installed = [
      { agentId: "codex", type: "hook", path: "/hook" },
      { agentId: "codex", type: "skill", path: "/skill" },
    ];
    state.codexMcpInspection = { state: "unknown", reason: "collision" };

    expect(await invoke(["connectors", "list", "--format", "json"])).toBeUndefined();
    const payload = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join("")) as {
      agents: Array<Record<string, unknown>>;
    };
    const codex = payload.agents.find(agent => agent.id === "codex");
    expect(codex).toMatchObject({ installedTransports: [], mcpInspection: "unknown" });

    expect(await invoke(["connectors", "list"])).toBeUndefined();
    const text = log.mock.calls.flat().map(value => String(value)).join("\n");
    expect(text).toContain("transport unknown");
    expect(text).not.toContain("(CLI)");
    expect(text).not.toContain("(MCP)");
  });

  it("reports native Codex MCP health as unknown instead of claiming a transport", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    state.installed = [{ agentId: "codex", type: "hook", path: "/hook" }];
    state.codexMcpInspection = { state: "unknown", reason: "unavailable" };

    expect((await invoke(["connectors", "doctor", "codex"]))?.message).toBe("exit:1");
    const text = log.mock.calls.flat().map(value => String(value)).join("\n");
    expect(text).toContain("native MCP inspection unknown");
    expect(text).not.toContain("(CLI)");
    expect(text).not.toContain("(MCP)");
  });

  it("does not fail all-agent doctor when unused Codex MCP inspection is unavailable", async () => {
    state.codexMcpInspection = { state: "unknown", reason: "unavailable" };

    expect(await invoke(["connectors", "doctor"])).toBeUndefined();
  });

  it("does not fail all-agent doctor for an installed Codex CLI transport", async () => {
    state.installed = [{ agentId: "codex", type: "hook", path: "/hook" }];
    state.codexMcpInspection = { state: "unknown", reason: "unavailable" };

    expect(await invoke(["connectors", "doctor"])).toBeUndefined();
  });

  it("fails all-agent doctor for an installed Codex MCP transport when inspection is unavailable", async () => {
    state.installed = [{ agentId: "codex", type: "mcp", path: "codex mcp" }];
    state.codexMcpInspection = { state: "unknown", reason: "unavailable" };

    expect((await invoke(["connectors", "doctor"]))?.message).toBe("exit:1");
  });

  it("does not fail all-agent doctor for a stored Codex CLI transport", async () => {
    state.storedCodexTransport = "cli";
    state.codexMcpInspection = { state: "unknown", reason: "unavailable" };

    expect(await invoke(["connectors", "doctor"])).toBeUndefined();
  });

  it("fails all-agent doctor for a stored Codex MCP transport when inspection is unavailable", async () => {
    state.storedCodexTransport = "mcp";
    state.codexMcpInspection = { state: "unknown", reason: "unavailable" };

    expect((await invoke(["connectors", "doctor"]))?.message).toBe("exit:1");
  });

  it("keeps all-agent doctor fail-closed for a Codex MCP collision", async () => {
    state.codexMcpInspection = { state: "unknown", reason: "collision" };

    expect((await invoke(["connectors", "doctor"]))?.message).toBe("exit:1");
  });

  it("reports a verified native Codex MCP transport in JSON and text", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    state.installed = [{ agentId: "codex", type: "mcp", path: "codex mcp" }];
    state.codexMcpInspection = { state: "installed" };

    expect(await invoke(["connectors", "list", "--format", "json"])).toBeUndefined();
    const payload = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join("")) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(payload.agents.find(agent => agent.id === "codex")).toMatchObject({
      installed: ["mcp"], installedTransports: ["mcp"], mcpInspection: "installed",
    });

    expect(await invoke(["connectors", "list"])).toBeUndefined();
    expect(log.mock.calls.flat().map(value => String(value)).join("\n")).toContain("(MCP)");
  });

  it("reports independently active Codex CLI and MCP transports", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    state.installed = [
      { agentId: "codex", type: "hook", path: "/hook" },
      { agentId: "codex", type: "skill", path: "/skill" },
      { agentId: "codex", type: "mcp", path: "codex mcp" },
    ];
    state.codexMcpInspection = { state: "installed" };

    expect(await invoke(["connectors", "list", "--format", "json"])).toBeUndefined();
    const payload = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join("")) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(payload.agents.find(agent => agent.id === "codex")).toMatchObject({
      installed: ["hook", "skill", "mcp"],
      installedTransports: ["cli", "mcp"],
      mcpInspection: "installed",
    });

    expect(await invoke(["connectors", "list"])).toBeUndefined();
    expect(log.mock.calls.flat().map(value => String(value)).join("\n"))
      .toContain("hook, skill, mcp (CLI, MCP)");
  });

  it("routes connector transport options and rejects stale selectors", async () => {
    const cwd = process.cwd();

    expect(await invoke(["connectors", "install", "codex"])).toBeUndefined();
    expect(state.installConnector).toHaveBeenLastCalledWith(
      "codex", undefined, cwd, { persistTransport: false, queryCodexMcp: false },
    );

    expect(await invoke(["connectors", "install", "codex", "--transport", "cli"])).toBeUndefined();
    expect(state.installConnector).toHaveBeenLastCalledWith(
      "codex", "cli", cwd, { persistTransport: true, queryCodexMcp: true },
    );

    expect(await invoke(["connectors", "install", "codex", "--transport", "mcp"])).toBeUndefined();
    expect(state.installConnector).toHaveBeenLastCalledWith(
      "codex", "mcp", cwd, { persistTransport: true, queryCodexMcp: false },
    );

    state.installConnector.mockClear();
    expect(await invoke(["connectors", "install", "codex", "--type", "hook"])).toBeInstanceOf(Error);
    expect(state.installConnector).not.toHaveBeenCalled();
    expect(await invoke(["connectors", "install", "codex", "--bogus"])).toBeInstanceOf(Error);
    expect(state.installConnector).not.toHaveBeenCalled();
  });

  it("removes the complete connector bundle and handles structured outcomes", async () => {
    const cwd = process.cwd();
    state.removeResult = { success: true, removed: false, paths: [], failures: [] };
    expect(await invoke(["connectors", "remove", "codex"])).toBeUndefined();
    expect(state.removeConnector).toHaveBeenLastCalledWith("codex", cwd, {});

    state.removeResult = { success: false };
    expect((await invoke(["connectors", "remove", "codex"]))?.message).toBe("exit:1");

    state.removeResult = { success: false, failures: ["mcp: collision"] };
    expect((await invoke(["connectors", "remove", "codex"]))?.message).toBe("exit:1");

    state.removeResult = true;
    expect(await invoke(["connectors", "remove", "codex"])).toBeUndefined();
  });

  it("uses the safe fallback when native Codex MCP inspection has no reason", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    state.installed = [{ agentId: "codex", type: "hook", path: "/hook" }];
    state.codexMcpInspection = { state: "unknown" };

    expect((await invoke(["connectors", "doctor", "codex"]))?.message).toBe("exit:1");
    expect(log.mock.calls.flat().map(value => String(value)).join("\n"))
      .toContain("native MCP inspection unknown (unavailable)");
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

  it("rejects partial and fabricated internal daemon identities before side effects", async () => {
    const ownerOption = "--internal-lcm-test-daemon-owner";
    const entrypointOption = "--internal-lcm-test-daemon-entrypoint";
    expect((await invoke([
      "daemon",
      "start",
      "--foreground",
      ownerOption,
      "partial",
    ]))?.message).toContain("complete owner and entrypoint pair");
    expect(state.migrateLegacyHome).not.toHaveBeenCalled();
    expect(state.ensureAuthToken).not.toHaveBeenCalled();
    expect(state.createDaemon).not.toHaveBeenCalled();

    expect((await invoke([
      "daemon",
      "start",
      "--foreground",
      ownerOption,
      "fabricated",
      entrypointOption,
      "/tmp/fabricated-daemon.mjs",
    ]))?.message).toContain("not confined to an isolated lifecycle environment");
    expect(state.migrateLegacyHome).not.toHaveBeenCalled();
    expect(state.ensureAuthToken).not.toHaveBeenCalled();
    expect(state.createDaemon).not.toHaveBeenCalled();
  });

  it("rejects missing, duplicate, misplaced, and malformed internal identity options", async () => {
    const ownerOption = "--internal-lcm-test-daemon-owner";
    const entrypointOption = "--internal-lcm-test-daemon-entrypoint";
    const cases: Array<{ args: string[]; expected: string }> = [
      {
        args: ["daemon", "start", "--foreground", ownerOption],
        expected: "requires a value",
      },
      {
        args: ["daemon", "start", ownerOption, "--foreground", entrypointOption, "/tmp/owned.mjs"],
        expected: "requires a value",
      },
      {
        args: ["daemon", "start", "--foreground", `${ownerOption}=owned`, `${entrypointOption}=`],
        expected: "requires a value",
      },
      {
        args: [
          "daemon",
          "start",
          "--foreground",
          ownerOption,
          "owned",
          ownerOption,
          "duplicate",
          entrypointOption,
          "/tmp/owned.mjs",
        ],
        expected: "one complete owner and entrypoint pair",
      },
      {
        args: ["status", "--foreground", `${ownerOption}=owned`, `${entrypointOption}=/tmp/owned.mjs`],
        expected: "restricted to foreground daemon startup",
      },
      {
        args: [
          "daemon",
          "start",
          `${ownerOption}=owned`,
          `${entrypointOption}=/tmp/owned.mjs`,
          "--",
          "--foreground",
        ],
        expected: "restricted to foreground daemon startup",
      },
      {
        args: [
          "daemon",
          "start",
          "--foreground",
          "--",
          `${ownerOption}=owned`,
          `${entrypointOption}=/tmp/owned.mjs`,
        ],
        expected: "restricted to foreground daemon startup",
      },
      {
        args: ["daemon", "start", "--foreground", `${ownerOption}=bad owner`, `${entrypointOption}=/tmp/owned.mjs`],
        expected: "identity is malformed",
      },
      {
        args: [
          "daemon",
          "start",
          "--foreground",
          `${ownerOption}=owned`,
          `${entrypointOption}=/repo/node_modules/vitest/dist/workers/forks.js`,
        ],
        expected: "identity is malformed",
      },
    ];

    for (const { args, expected } of cases) {
      expect((await invoke(args))?.message).toContain(expected);
    }
    expect(state.migrateLegacyHome).not.toHaveBeenCalled();
    expect(state.ensureAuthToken).not.toHaveBeenCalled();
    expect(state.createDaemon).not.toHaveBeenCalled();
    expect(isStrictContainedRelativePath("child/file")).toBe(true);
    expect(isStrictContainedRelativePath("")).toBe(false);
    expect(isStrictContainedRelativePath("../outside")).toBe(false);
    expect(isStrictContainedRelativePath("/absolute")).toBe(false);
    expect(() => assertParsedInternalDaemonTestIdentity(
      {
        internalLcmTestDaemonOwner: "changed",
        internalLcmTestDaemonEntrypoint: "/tmp/owned.mjs",
      },
      { ownerId: "owned", entrypoint: "/tmp/owned.mjs" },
    )).toThrow("did not survive CLI parsing intact");
    expect(() => assertParsedInternalDaemonTestIdentity(
      {
        internalLcmTestDaemonOwner: "owned",
        internalLcmTestDaemonEntrypoint: "/tmp/changed.mjs",
      },
      { ownerId: "owned", entrypoint: "/tmp/owned.mjs" },
    )).toThrow("did not survive CLI parsing intact");
  });

  it("rejects every unconfined environment and state root before side effects", async () => {
    const previous = {
      home: process.env.HOME,
      runtime: process.env.XDG_RUNTIME_DIR,
      owner: process.env.LCM_DAEMON_OWNER_ID,
    };
    const ownerOption = "--internal-lcm-test-daemon-owner=owned";
    const entrypointOption = "--internal-lcm-test-daemon-entrypoint=/tmp/lcm-owned/runtime/owned.mjs";
    const invokeIdentity = (): Promise<Error | undefined> => invoke([
      "daemon",
      "start",
      "--foreground",
      ownerOption,
      entrypointOption,
    ]);
    const setValidEnvironment = (): void => {
      process.env.HOME = "/tmp/lcm-owned";
      process.env.XDG_RUNTIME_DIR = "/tmp/lcm-owned/runtime";
      process.env.LCM_DAEMON_OWNER_ID = "owned";
      state.runtimeHome = "/tmp/lcm-owned/.lcm";
      state.runtimePidPath = "/tmp/lcm-owned/.lcm/daemon.pid";
      state.runtimeTokenPath = "/tmp/lcm-owned/.lcm/daemon.token";
    };

    try {
      setValidEnvironment();
      process.env.LCM_DAEMON_OWNER_ID = "foreign";
      expect((await invokeIdentity())?.message).toContain("not confined");
      setValidEnvironment();
      delete process.env.HOME;
      expect((await invokeIdentity())?.message).toContain("not confined");
      setValidEnvironment();
      delete process.env.XDG_RUNTIME_DIR;
      expect((await invokeIdentity())?.message).toContain("not confined");
      setValidEnvironment();
      process.env.HOME = "/";
      expect((await invokeIdentity())?.message).toContain("not confined");
      setValidEnvironment();
      process.env.HOME = "relative";
      expect((await invokeIdentity())?.message).toContain("not confined");
      setValidEnvironment();
      process.env.XDG_RUNTIME_DIR = "relative";
      expect((await invokeIdentity())?.message).toContain("not confined");
      setValidEnvironment();
      process.env.XDG_RUNTIME_DIR = "/tmp/foreign-runtime";
      expect((await invokeIdentity())?.message).toContain("not confined");
      setValidEnvironment();
      const outsideEntrypoint = entrypointOption.replace(
        "/tmp/lcm-owned/runtime/owned.mjs",
        "/tmp/foreign-entrypoint.mjs",
      );
      expect((await invoke([
        "daemon",
        "start",
        "--foreground",
        ownerOption,
        outsideEntrypoint,
      ]))?.message).toContain("not confined");

      setValidEnvironment();
      state.runtimeHome = "/tmp/foreign-state";
      expect((await invokeIdentity())?.message).toContain("state is not confined");
      setValidEnvironment();
      state.runtimePidPath = "/tmp/lcm-owned/foreign.pid";
      expect((await invokeIdentity())?.message).toContain("state is not confined");
      setValidEnvironment();
      state.runtimeTokenPath = "/tmp/lcm-owned/foreign.token";
      expect((await invokeIdentity())?.message).toContain("state is not confined");
    } finally {
      if (previous.home === undefined) delete process.env.HOME;
      else process.env.HOME = previous.home;
      if (previous.runtime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous.runtime;
      if (previous.owner === undefined) delete process.env.LCM_DAEMON_OWNER_ID;
      else process.env.LCM_DAEMON_OWNER_ID = previous.owner;
    }

    expect(state.migrateLegacyHome).not.toHaveBeenCalled();
    expect(state.ensureAuthToken).not.toHaveBeenCalled();
    expect(state.createDaemon).not.toHaveBeenCalled();
  });

  it("passes one confined internal daemon identity explicitly to the server", async () => {
    const previous = {
      home: process.env.HOME,
      runtime: process.env.XDG_RUNTIME_DIR,
      owner: process.env.LCM_DAEMON_OWNER_ID,
    };
    const homeDir = actualFs.mkdtempSync(join(tmpdir(), "lcm-cli-owned-home-"));
    expect(dirname(homeDir)).toBe(tmpdir());
    const runtimeDir = `${homeDir}/runtime`;
    const entrypoint = `${runtimeDir}/owned-lcm.mjs`;
    actualFs.mkdirSync(runtimeDir, { recursive: true });
    actualFs.mkdirSync(`${homeDir}/.lcm`, { recursive: true });
    actualFs.writeFileSync(entrypoint, "export {};\n");
    state.runtimeHome = `${homeDir}/.lcm`;
    state.runtimePidPath = `${state.runtimeHome}/daemon.pid`;
    state.runtimeTokenPath = `${state.runtimeHome}/daemon.token`;
    process.env.HOME = homeDir;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    process.env.LCM_DAEMON_OWNER_ID = "cli-owned";
    try {
      expect(await invoke([
        "daemon",
        "start",
        "--foreground",
        "--internal-lcm-test-daemon-owner=cli-owned",
        `--internal-lcm-test-daemon-entrypoint=${entrypoint}`,
      ])).toBeUndefined();
      expect(state.createDaemon).toHaveBeenCalledWith(
        expect.any(Object),
        {
          tokenPath: `${state.runtimeHome}/daemon.token`,
          publicationConfigPath: `${state.runtimeHome}/config.json`,
          _testIdentity: {
            ownerId: "cli-owned",
            entrypoint,
          },
        },
      );
      expect(state.ensureAuthToken).toHaveBeenCalledWith(
        `${state.runtimeHome}/daemon.token`,
      );
    } finally {
      if (previous.home === undefined) delete process.env.HOME;
      else process.env.HOME = previous.home;
      if (previous.runtime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous.runtime;
      if (previous.owner === undefined) delete process.env.LCM_DAEMON_OWNER_ID;
      else process.env.LCM_DAEMON_OWNER_ID = previous.owner;
      actualFs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects linked hidden-pair state and entrypoints before side effects", async () => {
    const previous = {
      home: process.env.HOME,
      runtime: process.env.XDG_RUNTIME_DIR,
      owner: process.env.LCM_DAEMON_OWNER_ID,
    };
    const root = actualFs.mkdtempSync(join(tmpdir(), "lcm-cli-symlink-"));
    expect(dirname(root)).toBe(tmpdir());
    const homeDir = `${root}/home`;
    const runtimeDir = `${homeDir}/runtime`;
    const stateTarget = `${root}/canonical-target-state`;
    const entrypointTarget = `${root}/canonical-target-entrypoint.mjs`;
    const entrypoint = `${runtimeDir}/owned-lcm.mjs`;
    actualFs.mkdirSync(runtimeDir, { recursive: true });
    actualFs.mkdirSync(stateTarget, { recursive: true });
    actualFs.writeFileSync(`${stateTarget}/sentinel`, "untouched");
    actualFs.writeFileSync(entrypoint, "export {};\n");
    actualFs.writeFileSync(entrypointTarget, "export const target = true;\n");
    actualFs.symlinkSync(stateTarget, `${homeDir}/.lcm`, "dir");
    state.runtimeHome = `${homeDir}/.lcm`;
    state.runtimePidPath = `${state.runtimeHome}/daemon.pid`;
    state.runtimeTokenPath = `${state.runtimeHome}/daemon.token`;
    process.env.HOME = homeDir;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    process.env.LCM_DAEMON_OWNER_ID = "cli-symlink";
    const invokeOwned = (): Promise<Error | undefined> => invoke([
      "daemon",
      "start",
      "--foreground",
      "--internal-lcm-test-daemon-owner=cli-symlink",
      `--internal-lcm-test-daemon-entrypoint=${entrypoint}`,
    ]);
    try {
      expect((await invokeOwned())?.message).toContain("filesystem is not canonical");
      actualFs.unlinkSync(`${homeDir}/.lcm`);
      actualFs.mkdirSync(`${homeDir}/.lcm`);
      actualFs.unlinkSync(entrypoint);
      actualFs.symlinkSync(entrypointTarget, entrypoint, "file");
      expect((await invokeOwned())?.message).toContain("filesystem is not canonical");
      actualFs.unlinkSync(entrypoint);
      actualFs.writeFileSync(entrypoint, "export const owned = true;\n", {
        mode: 0o640,
      });
      const hardlinkTarget = `${root}/hardlinked-entrypoint.mjs`;
      actualFs.linkSync(entrypoint, hardlinkTarget);
      const hardlinkContent = actualFs.readFileSync(hardlinkTarget, "utf-8");
      const hardlinkMode = actualFs.statSync(hardlinkTarget).mode & 0o777;
      expect((await invokeOwned())?.message).toContain("filesystem is not canonical");
      expect(actualFs.readFileSync(`${stateTarget}/sentinel`, "utf-8")).toBe("untouched");
      expect(actualFs.readFileSync(entrypointTarget, "utf-8")).toContain("target");
      expect(actualFs.readFileSync(hardlinkTarget, "utf-8")).toBe(hardlinkContent);
      expect(actualFs.statSync(hardlinkTarget).mode & 0o777).toBe(hardlinkMode);
      expect(actualFs.existsSync(`${stateTarget}/daemon.pid`)).toBe(false);
      expect(actualFs.existsSync(`${stateTarget}/daemon.token`)).toBe(false);
    } finally {
      if (previous.home === undefined) delete process.env.HOME;
      else process.env.HOME = previous.home;
      if (previous.runtime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous.runtime;
      if (previous.owner === undefined) delete process.env.LCM_DAEMON_OWNER_ID;
      else process.env.LCM_DAEMON_OWNER_ID = previous.owner;
      actualFs.rmSync(root, { recursive: true, force: true });
    }
    expect(state.migrateLegacyHome).not.toHaveBeenCalled();
    expect(state.ensureAuthToken).not.toHaveBeenCalled();
    expect(state.createDaemon).not.toHaveBeenCalled();
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
    expect(state.reconcileWorktrees).toHaveBeenCalledWith("/project");
  });

  it("deduplicates export-all candidates by their reconciled project identity", async () => {
    const portable = await import("../../src/portable-knowledge.js");
    state.entries = [
      { name: "canonical", isDirectory: () => true },
      { name: "legacy", isDirectory: () => true },
    ];
    state.fileText = JSON.stringify({ cwd: "/linked-worktree" });
    state.reconcileWorktrees.mockReturnValue({
      targetHash: "canonical-hash",
      canonical: "/primary",
    });

    expect(await invoke(["export", "--all"])).toBeUndefined();

    expect(state.reconcileWorktrees).toHaveBeenCalledTimes(2);
    expect(portable.exportKnowledge).toHaveBeenCalledOnce();
    expect(portable.exportKnowledge).toHaveBeenCalledWith(
      "/primary",
      expect.objectContaining({ output: expect.stringContaining("lcm-export-") }),
    );
  });

  it("warns and skips export-all candidates that cannot be reconciled", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    state.entries = [
      { name: "error", isDirectory: () => true },
      { name: "primitive", isDirectory: () => true },
    ];
    state.fileText = JSON.stringify({ cwd: "/unavailable" });
    state.reconcileWorktrees
      .mockImplementationOnce(() => { throw new Error("map changed"); })
      .mockImplementationOnce(() => { throw "source vanished"; });

    expect(await invoke(["export", "--all"])).toBeUndefined();

    expect(state.reconcileWorktrees).toHaveBeenCalledTimes(2);
    expect(stderr).toHaveBeenCalledWith(
      "  Warning: could not reconcile /unavailable: map changed\n",
    );
    expect(stderr).toHaveBeenCalledWith(
      "  Warning: could not reconcile /unavailable: source vanished\n",
    );
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
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.post.mockRejectedValueOnce(new Error("promote\u001b[31m\nfailed"));
    expect(await invoke(["compact"])).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("promote failed");
    expect(error.mock.calls.flat().join("\n")).not.toContain("\u001b");
    expect(state.ensureDaemon).toHaveBeenCalledTimes(1);
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

  it("retries automatic promotion once after daemon transport recovery with a fresh client", async () => {
    const transportError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    state.batchResult = {
      compacted: 1,
      unchanged: 0,
      skipped: 0,
      failures: 0,
      compactedProjects: ["/project"],
    };
    state.post
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce({ processed: 2, promoted: 2 });

    expect(await invoke(["compact"])).toBeUndefined();

    expect(state.post).toHaveBeenNthCalledWith(1, "/promote", {
      cwd: "/project",
      dry_run: false,
    });
    expect(state.post).toHaveBeenNthCalledWith(2, "/promote", {
      cwd: "/project",
      dry_run: false,
    });
    expect(state.ensureDaemon).toHaveBeenCalledTimes(2);
    expect(state.ensureDaemon).toHaveBeenNthCalledWith(2, {
      port: 3737,
      pidFilePath: "/lcm/daemon.pid",
      spawnTimeoutMs: 10000,
      expectedStorageBackend: "sqlite",
      enforceUserManagerParent: true,
    });
    expect(state.daemonClientInstances).toBe(2);
    expect(vi.mocked(batchCompact)).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it("gives later projects an independent recovery after a retry still loses transport", async () => {
    const reset = (): Error => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    state.batchResult = {
      compacted: 2,
      unchanged: 0,
      skipped: 0,
      failures: 0,
      compactedProjects: ["/one", "/two"],
    };
    state.post
      .mockRejectedValueOnce(reset())
      .mockRejectedValueOnce(reset())
      .mockRejectedValueOnce(reset())
      .mockResolvedValueOnce({ processed: 1, promoted: 1 });

    expect(await invoke(["compact", "--all"])).toBeUndefined();

    expect(state.post).toHaveBeenCalledTimes(4);
    expect(state.ensureDaemon).toHaveBeenCalledTimes(3);
    expect(state.daemonClientInstances).toBe(3);
    expect(vi.mocked(batchCompact)).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("does not retry when daemon recovery cannot reconnect", async () => {
    state.post.mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    state.ensureDaemon
      .mockResolvedValueOnce({ connected: true, spawned: false, restartedForParent: false, pid: 42 })
      .mockResolvedValueOnce({ connected: false, spawned: false, restartedForParent: false, pid: undefined });

    expect(await invoke(["compact"])).toBeUndefined();

    expect(state.post).toHaveBeenCalledOnce();
    expect(state.ensureDaemon).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });

  it("recognizes only daemon transport failures, including nested causes", () => {
    expect(isDaemonTransportFailure(Object.assign(new Error("refused"), { code: "econnrefused" }))).toBe(true);
    expect(isDaemonTransportFailure(new Error("Daemon request timed out"))).toBe(true);
    expect(isDaemonTransportFailure(new Error("outer", {
      cause: Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
    }))).toBe(true);
    expect(isDaemonTransportFailure(new Error("HTTP 503"))).toBe(false);
    expect(isDaemonTransportFailure("socket hang up")).toBe(false);
    const cycle = Object.assign(new Error("application failure"), { cause: undefined as unknown });
    cycle.cause = cycle;
    expect(isDaemonTransportFailure(cycle)).toBe(false);
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
