import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mergeClaudeSettings } from "./installer/settings.js";
import { packageExecutable } from "./runtime-root.js";
import { daemonConfigForPersistence, loadDaemonConfig } from "./daemon/config.js";
import {
  configPath as defaultConfigPath,
  migrateLegacyHomeIfNeeded,
  tmpDir as lcmTmpDir,
} from "./runtime-paths.js";
import { selectStorageBackend } from "./storage/backend.js";
import {
  assertBackendPublicationConfigAccess,
  assertBackendPublicationConfigMutation,
  assertBackendPublicationConsumerAccess,
  backendPublicationHomeForConfigPath,
  withBackendPublicationConfigLock,
  withBackendPublicationConsumerLock,
} from "./storage/backend-publication.js";

export interface EnsureCoreDeps {
  configPath: string;
  settingsPath: string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  chmodSync?: (path: string, mode: number) => void;
  binaryPath?: string;
  ensureDaemon: (opts: {
    port: number;
    pidFilePath: string;
    spawnTimeoutMs: number;
    expectedStorageBackend?: "sqlite" | "postgresql";
    expectedEntrypoint?: string;
    enforceUserManagerParent?: boolean;
    spawnCommand?: string;
    spawnArgs?: string[];
  }) => Promise<{ connected: boolean }>;
}

function defaultDeps(): EnsureCoreDeps {
  return {
    configPath: defaultConfigPath(),
    settingsPath: join(homedir(), ".claude", "settings.json"),
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    mkdirSync,
    chmodSync: chmodSync,
    binaryPath: packageExecutable(import.meta.url, 2),
    ensureDaemon: async (opts) => {
      const { ensureDaemon } = await import("./daemon/lifecycle.js");
      return ensureDaemon(opts);
    },
  };
}

export type VerifiedCoreEndpoint = { connected: boolean; port: number };

export async function ensureCoreEndpoint(deps: EnsureCoreDeps = defaultDeps()): Promise<VerifiedCoreEndpoint> {
  const binaryPath = deps.binaryPath ?? packageExecutable(import.meta.url, 2);
  const publicationHome = backendPublicationHomeForConfigPath(deps.configPath);
  if (deps.configPath === defaultConfigPath()) {
    withBackendPublicationConsumerLock(publicationHome, () => {
      assertBackendPublicationConsumerAccess({ homeDir: publicationHome });
      migrateLegacyHomeIfNeeded(publicationHome);
    });
  }
  // 1. Create config.json with defaults if missing
  withBackendPublicationConfigLock(deps.configPath, () => {
    if (publicationHome !== undefined) {
      assertBackendPublicationConsumerAccess({ homeDir: publicationHome });
    }
    if (deps.existsSync(deps.configPath)) return;
    const defaults = loadDaemonConfig("/nonexistent");
    const serialized = JSON.stringify(daemonConfigForPersistence(defaults), null, 2);
    assertBackendPublicationConfigAccess(deps.configPath, "sqlite", null);
    assertBackendPublicationConfigMutation(
      deps.configPath,
      "sqlite",
      "sqlite",
      serialized,
      null,
    );
    deps.mkdirSync(dirname(deps.configPath), { recursive: true });
    deps.writeFileSync(deps.configPath, serialized);
    try {
      deps.chmodSync?.(deps.configPath, 0o600);
    } catch {}
  });

  // 2. Clean stale/duplicate hooks from settings.json (fixes #94)
  // Only rewrite settings.json if mergeClaudeSettings actually changed the data
  if (deps.existsSync(deps.settingsPath)) {
    try {
      const existing = JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"));
      const merged = mergeClaudeSettings(existing, binaryPath);
      if (JSON.stringify(existing) !== JSON.stringify(merged)) {
        deps.mkdirSync(dirname(deps.settingsPath), { recursive: true });
        deps.writeFileSync(deps.settingsPath, JSON.stringify(merged, null, 2));
      }
    } catch {}
  }

  // 3. Start daemon if not running
  const config = loadDaemonConfig(deps.configPath);
  selectStorageBackend(config.storage);
  const result = await deps.ensureDaemon({
    port: config.daemon.port,
    pidFilePath: join(dirname(deps.configPath), "daemon.pid"),
    spawnTimeoutMs: 5000,
    expectedStorageBackend: config.storage.backend,
    expectedEntrypoint: binaryPath,
    spawnCommand: process.execPath,
    spawnArgs: [binaryPath, "daemon", "start", "--foreground"],
    enforceUserManagerParent: true,
  });
  return { connected: result.connected, port: config.daemon.port };
}

export async function ensureCore(deps: EnsureCoreDeps = defaultDeps()): Promise<boolean> {
  return (await ensureCoreEndpoint(deps)).connected;
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
  deps: BootstrapDeps = defaultBootstrapDeps(),
): Promise<boolean> {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const flagDir = lcmTmpDir();
  mkdirSync(flagDir, { recursive: true });
  const flagPath = join(flagDir, `bootstrapped-${safeId}.flag`);
  try {
    if (deps.flagExists(flagPath)) return true;
  } catch {}

  const connected = await ensureCore(deps);
  if (!connected) return false;
  try { deps.writeFlag(flagPath); } catch {}
  return true;
}
