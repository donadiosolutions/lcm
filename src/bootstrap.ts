import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mergeClaudeSettings } from "./installer/settings.js";
import type { ConnectorTransport } from "./connectors/types.js";
import { packageExecutable } from "./runtime-root.js";
import {
  daemonConfigForPersistence,
  parseDaemonConfig,
  resolveDaemonConfigEnv,
} from "./daemon/config.js";
import {
  bootstrapLcmHome,
  configPath as defaultConfigPath,
  tmpDir as lcmTmpDir,
} from "./runtime-paths.js";
import {
  assertBackendPublicationConfigAccess,
  assertBackendPublicationConfigMutation,
  assertBackendPublicationConsumerAccess,
  backendPublicationHomeForConfigPath,
  withBackendPublicationConfigLock,
} from "./storage/backend-publication.js";
import {
  atomicWritePrivateFileDurable,
  OWNER_ONLY_FILE_MODES,
  readBoundedRegularFileWithStat,
} from "./security-files.js";
import { selectStorageBackend } from "./storage/backend.js";
import { resolveAgentTransport } from "./connectors/registry.js";
import { PKG_VERSION, RUNTIME_DIGEST } from "./daemon/version.js";
import type { VerifiedRunningDaemon, VerifyRunningDaemonOptions } from "./daemon/lifecycle.js";

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

type PublicationAdmissionRetry = <T>(step: () => T | Promise<T>) => Promise<T>;

/** A caller-supplied retry replaces the dependency's own; none leaves it unchanged. */
function withAdmissionRetry<D extends EnsureCoreDeps>(deps: D, retry?: PublicationAdmissionRetry): D {
  return retry === undefined ? deps : { ...deps, _withPublicationAdmissionRetry: retry };
}

export interface EnsureCoreDeps {
  configPath: string;
  settingsPath: string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  chmodSync?: (path: string, mode: number) => void;
  atomicWritePrivateFileDurable?: typeof atomicWritePrivateFileDurable;
  ensureRuntimeHome?: (homeDir: string) => void;
  /** @internal Bounded admission convergence for one lock-taking step. */
  _withPublicationAdmissionRetry?: <T>(step: () => T | Promise<T>) => Promise<T>;
  binaryPath?: string;
  transport?: ConnectorTransport;
  ensureDaemon: (opts: {
    port: number;
    pidFilePath: string;
    spawnTimeoutMs: number;
    expectedVersion?: string;
    expectedStorageBackend?: "sqlite" | "postgresql";
    expectedEntrypoint?: string;
    expectedRuntimeDigest?: string;
    enforceUserManagerParent?: boolean;
    spawnCommand?: string;
    spawnArgs?: string[];
    _withPublicationAdmissionRetry?: <T>(step: () => T | Promise<T>) => Promise<T>;
  }) => Promise<{ connected: boolean }>;
}

function defaultDeps(): EnsureCoreDeps {
  const configPath = defaultConfigPath();
  return {
    configPath,
    settingsPath: join(homedir(), ".claude", "settings.json"),
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    mkdirSync,
    chmodSync: chmodSync,
    atomicWritePrivateFileDurable,
    ensureRuntimeHome: (homeDir) => { bootstrapLcmHome(homeDir); },
    binaryPath: packageExecutable(import.meta.url, 2),
    transport: resolveAgentTransport("claude-code", undefined, { configPath }).transport,
    ensureDaemon: async (opts) => {
      const { ensureDaemon } = await import("./daemon/lifecycle.js");
      return ensureDaemon(opts);
    },
  };
}

export type VerifiedCoreEndpoint = { connected: boolean; port: number };

export async function ensureCoreEndpoint(
  initialDeps: EnsureCoreDeps = defaultDeps(),
  admissionRetry?: PublicationAdmissionRetry,
): Promise<VerifiedCoreEndpoint> {
  const deps = withAdmissionRetry(initialDeps, admissionRetry);
  const binaryPath = deps.binaryPath ?? packageExecutable(import.meta.url, 2);
  const publicationHome = backendPublicationHomeForConfigPath(deps.configPath);
  if (publicationHome === undefined) {
    throw new Error("canonical LCM configuration path is required");
  }
  const wrap = deps._withPublicationAdmissionRetry
    ?? (async <T>(step: () => T | Promise<T>) => await step());
  if (deps.ensureRuntimeHome !== undefined) {
    await wrap(() => deps.ensureRuntimeHome!(publicationHome));
  } else {
    // Explicit test/embedding dependencies do not get implicit filesystem
    // mutation, but they still inherit the publication fail-closed gate.
    assertBackendPublicationConsumerAccess({ homeDir: publicationHome });
  }

  // 1. Authenticate publication state, then create config.json with
  // defaults if missing. Production defaults use the descriptor-bound durable
  // writer; injected dependencies retain the historical seam for tests.
  const config = await wrap(() => withBackendPublicationConfigLock(deps.configPath, (lockToken) => {
    if (!deps.existsSync(deps.configPath)) {
      const defaults = parseDaemonConfig("{}", {}, resolveDaemonConfigEnv(process.env));
      const content = JSON.stringify(daemonConfigForPersistence(defaults), null, 2);
      if (deps.ensureRuntimeHome !== undefined) {
        assertBackendPublicationConfigMutation(
          deps.configPath,
          "sqlite",
          "sqlite",
          content,
          null,
          undefined,
          lockToken,
        );
      }
      if (deps.atomicWritePrivateFileDurable !== undefined) {
        deps.atomicWritePrivateFileDurable(deps.configPath, content, { requireAbsent: true });
      } else {
        // This branch is only for explicit dependency injection. The default
        // path has already authenticated and created the root above.
        deps.mkdirSync(dirname(deps.configPath), { recursive: true });
        deps.writeFileSync(deps.configPath, content);
        try {
          deps.chmodSync?.(deps.configPath, 0o600);
        } catch {}
      }
    }

    let content = "{}";
    let observedContent: string | null = null;
    try {
      const observed = readBoundedRegularFileWithStat(deps.configPath, {
        allowedRoot: dirname(deps.configPath),
        maxBytes: MAX_CONFIG_BYTES,
        expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
        allowedModes: OWNER_ONLY_FILE_MODES,
        requireSingleLink: true,
      });
      content = observed.content;
      observedContent = observed.content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parsed = parseDaemonConfig(content, {}, resolveDaemonConfigEnv(process.env));
    assertBackendPublicationConfigAccess(
      deps.configPath,
      parsed.storage.backend,
      observedContent,
      undefined,
      lockToken,
    );
    return parsed;
  }));

  // 2. Clean stale/duplicate hooks from settings.json (fixes #94)
  // Only rewrite settings.json if mergeClaudeSettings actually changed the data
  if (deps.existsSync(deps.settingsPath)) {
    try {
      const existing = JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"));
      const merged = mergeClaudeSettings(existing, binaryPath, process.execPath, deps.transport);
      if (JSON.stringify(existing) !== JSON.stringify(merged)) {
        deps.mkdirSync(dirname(deps.settingsPath), { recursive: true });
        deps.writeFileSync(deps.settingsPath, JSON.stringify(merged, null, 2));
      }
    } catch {}
  }

  // 3. Start daemon if not running
  await wrap(() => selectStorageBackend({ ...config.storage, homeDir: publicationHome }));
  const result = await deps.ensureDaemon({
    port: config.daemon.port,
    pidFilePath: join(dirname(deps.configPath), "daemon.pid"),
    spawnTimeoutMs: 5000,
    expectedStorageBackend: config.storage.backend,
    expectedEntrypoint: binaryPath,
    spawnCommand: process.execPath,
    spawnArgs: [binaryPath, "daemon", "start", "--foreground"],
    enforceUserManagerParent: true,
    _withPublicationAdmissionRetry: deps._withPublicationAdmissionRetry,
  });
  return { connected: result.connected, port: config.daemon.port };
}

export async function ensureCore(deps: EnsureCoreDeps = defaultDeps()): Promise<boolean> {
  return (await ensureCoreEndpoint(deps)).connected;
}

export interface VerifyCoreDeps {
  configPath: string;
  binaryPath: string;
  verifyRunningDaemon: (
    opts: VerifyRunningDaemonOptions,
  ) => Promise<VerifiedRunningDaemon | null>;
}

function defaultVerifyDeps(): VerifyCoreDeps {
  return {
    configPath: defaultConfigPath(),
    binaryPath: packageExecutable(import.meta.url, 2),
    verifyRunningDaemon: async (opts) => {
      const { verifyRunningDaemon } = await import("./daemon/lifecycle.js");
      return verifyRunningDaemon(opts);
    },
  };
}

/**
 * Read-only counterpart of `ensureCoreEndpoint` for hooks that must not
 * start, repair or configure anything. It reads the existing config and
 * returns the verified port with its token, or null when the daemon is
 * absent, mismatched, unreadable or slower than `budgetMs`.
 */
export async function verifyCoreEndpoint(
  opts: { budgetMs: number; signal?: AbortSignal },
  deps: VerifyCoreDeps = defaultVerifyDeps(),
): Promise<{ port: number; token: string } | null> {
  try {
    const observed = readBoundedRegularFileWithStat(deps.configPath, {
      allowedRoot: dirname(deps.configPath),
      maxBytes: MAX_CONFIG_BYTES,
      expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      allowedModes: OWNER_ONLY_FILE_MODES,
      requireSingleLink: true,
    });
    const config = parseDaemonConfig(observed.content, {}, resolveDaemonConfigEnv(process.env));
    return await deps.verifyRunningDaemon({
      port: config.daemon.port,
      pidFilePath: join(dirname(deps.configPath), "daemon.pid"),
      expectedVersion: PKG_VERSION,
      expectedStorageBackend: config.storage.backend,
      expectedEntrypoint: deps.binaryPath,
      expectedRuntimeDigest: RUNTIME_DIGEST,
      budgetMs: opts.budgetMs,
      signal: opts.signal,
    });
  } catch {
    return null;
  }
}

export interface BootstrapDeps extends EnsureCoreDeps {
  flagExists: (path: string) => boolean;
  writeFlag: (path: string) => void;
}

function defaultBootstrapDeps(): BootstrapDeps {
  return {
    ...defaultDeps(),
    flagExists: existsSync,
    writeFlag: (p) => writeFileSync(p, ""),
  };
}

export async function ensureBootstrapped(
  sessionId: string,
  initialDeps: BootstrapDeps = defaultBootstrapDeps(),
  admissionRetry?: PublicationAdmissionRetry,
): Promise<boolean> {
  const deps = withAdmissionRetry(initialDeps, admissionRetry);
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const flagDir = lcmTmpDir();
  const flagPath = join(flagDir, `bootstrapped-${safeId}.flag`);
  try {
    if (deps.flagExists(flagPath)) return true;
  } catch {}

  const connected = await ensureCore(deps);
  if (!connected) return false;
  // Root bootstrap happens in ensureCore before this path is created. A
  // read-only flag check must never be the operation that recursively creates
  // ~/.lcm.
  deps.mkdirSync(flagDir, { recursive: true });
  try { deps.writeFlag(flagPath); } catch {}
  return true;
}
