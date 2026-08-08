import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { lcmPath } from "../runtime-paths.js";
import { consumeBoundedRegularFile, readBoundedRegularFile } from "../security-files.js";
import { hasUrlQueryComponent, sanitizeUrlForDisplay } from "../url-display.js";
import { MANAGED_CREDENTIAL_NAMES } from "./managed-credentials.js";
import {
  assertBackendPublicationConfigAccess,
  withBackendPublicationConfigLock,
} from "../storage/backend.js";

export { sanitizeUrlForDisplay } from "../url-display.js";

export const CANONICAL_LLM_PROVIDERS = [
  "auto",
  "claude-process",
  "codex-process",
  "anthropic",
  "openai",
  "disabled",
] as const;
export type LlmProvider = typeof CANONICAL_LLM_PROVIDERS[number];

export const LLM_API_MODES = ["chat-completions", "responses"] as const;
export type LlmApiMode = typeof LLM_API_MODES[number];

export const LLM_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type LlmReasoningEffort = typeof LLM_REASONING_EFFORTS[number];

export const OPENAI_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type OpenAIReasoningEffort = typeof OPENAI_REASONING_EFFORTS[number];
export const CLAUDE_PROCESS_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeProcessReasoningEffort = typeof CLAUDE_PROCESS_REASONING_EFFORTS[number];
export const CODEX_PROCESS_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type CodexProcessReasoningEffort = typeof CODEX_PROCESS_REASONING_EFFORTS[number];
export const AUTO_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export function reasoningEffortsForProvider(
  provider: LlmProvider,
  apiMode?: LlmApiMode,
): readonly LlmReasoningEffort[] {
  switch (provider) {
    case "auto": return AUTO_REASONING_EFFORTS;
    case "claude-process": return CLAUDE_PROCESS_REASONING_EFFORTS;
    case "codex-process": return CODEX_PROCESS_REASONING_EFFORTS;
    case "openai": return apiMode === "responses" ? OPENAI_REASONING_EFFORTS : [];
    default: return [];
  }
}

export function supportsFastMode(provider: LlmProvider): boolean {
  return provider === "auto" || provider === "claude-process" || provider === "codex-process";
}

export function supportsRequestTimeout(provider: LlmProvider): boolean {
  return provider === "auto" || provider === "openai" || provider === "claude-process" || provider === "codex-process";
}

export interface LlmRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

export interface LlmRequestPolicy {
  requestTimeoutMs: number;
  retry: LlmRetryPolicy;
}

export interface LlmInvocationRequestPolicy {
  requestTimeoutMs: number;
  retry?: LlmRetryPolicy;
}

export interface LlmRequestPolicyConfig {
  llm: LlmRequestPolicy & { provider: LlmProvider };
}

export interface LlmRequestPolicyOverride {
  requestTimeoutMs?: unknown;
  retry?: unknown;
}

export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 600_000;
export const DEFAULT_LLM_RETRY_POLICY: Readonly<LlmRetryPolicy> = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
});

export const DEFAULT_DAEMON_PORT = 3737;

export const STORAGE_BACKENDS = ["sqlite", "postgresql"] as const;
export type StorageBackend = typeof STORAGE_BACKENDS[number];

/** Maximum accepted PostgreSQL CA bundle size (1 MiB). */
export const POSTGRESQL_CA_FILE_MAX_BYTES = 1024 * 1024;

export interface PostgreSqlStorageSettings {
  poolMax: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface StoredStorageConfig {
  backend: StorageBackend;
  postgresql?: Partial<PostgreSqlStorageSettings>;
}

export type ResolvedStorageConfig =
  | { backend: "sqlite" }
  | {
    backend: "postgresql";
    postgresql: PostgreSqlStorageSettings & {
      url: string;
      caFile: string;
    };
  };

export const DEFAULT_POSTGRESQL_STORAGE_SETTINGS: Readonly<PostgreSqlStorageSettings> = Object.freeze({
  poolMax: 5,
  connectionTimeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  statementTimeoutMs: 60_000,
});

export interface SecurityConfig {
  /** User-defined global regex patterns (plain strings, no /.../ delimiters). */
  sensitivePatterns: string[];
  /**
   * Emit a stderr warning when sensitive data is filtered from session history.
   * Shows the pattern category (e.g. "gitleaks", "built_in"), not the actual value.
   * Defaults to true.
   */
  notify_on_filter?: boolean;
}

export type DaemonConfig = {
  version: number;
  storage: ResolvedStorageConfig;
  daemon: { port: number; socketPath: string; logLevel: string; logMaxSizeMB: number; logRetentionDays: number; idleTimeoutMs: number };
  compaction: {
    leafTokens: number; maxDepth: number; autoCompactMinTokens: number;
    promotionThresholds: { minDepth: number; compressionRatio: number; keywords: Record<string, string[]>; architecturePatterns: string[]; dedupBm25Threshold: number; dedupCandidateLimit: number; eventConfidence?: { decision?: number; plan?: number; errorFix?: number; batch?: number; pattern?: number }; reinforcementBoost?: number; maxConfidence?: number; insightsMaxAgeDays?: number };
  };
  restoration: {
    recentSummaries: number;
    promptSearchMinScore: number;
    promptSearchMaxResults: number;
    promptSnippetLength: number;
    maxInjectedMemoryBytes: number;
    reservedForLearningInstruction: number;
    maxInjectedMemoryItems: number;
    dedupMinPrefix: number;
    recencyHalfLifeHours: number;
    crossSessionAffinity: number;
    recallUsageBoost: number;
    recallUsageSmoothing: number;
    surfacingCooldownWindow: number;
    resurfaceMargin: number;
    unusedSurfacingPenalty: number;
    staleAfterDays: number;
    staleSurfacingWithoutUseLimit: number;
    restoreMaxPromotedAgeDays: number;
    stalePenalty: number;
    allowStaleOnStrongMatch: boolean;
  };
  llm: {
    provider: LlmProvider;
    model: string;
    apiKey?: string;
    baseUrl: string;
    apiMode?: LlmApiMode;
    reasoningEffort?: LlmReasoningEffort;
    fastMode: boolean;
    requestTimeoutMs: number;
    retry: LlmRetryPolicy;
  };
  summarizer: { mock: boolean };
  security: SecurityConfig;
  hooks: { snapshotIntervalSec: number; disableAutoCompact: boolean };
};

type DaemonConfigDefaults = Omit<DaemonConfig, "storage"> & { storage: StoredStorageConfig };

const DEFAULTS: DaemonConfigDefaults = {
  version: 1,
  storage: {
    backend: "sqlite",
    postgresql: { ...DEFAULT_POSTGRESQL_STORAGE_SETTINGS },
  },
  daemon: { port: DEFAULT_DAEMON_PORT, socketPath: lcmPath("daemon.sock"), logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
  compaction: {
    leafTokens: 1000, maxDepth: 5, autoCompactMinTokens: 10000,
    promotionThresholds: {
      minDepth: 2, compressionRatio: 0.3,
      keywords: { decision: ["decided", "agreed", "will use", "going with", "chosen"], fix: ["fixed", "root cause", "workaround", "resolved"] },
      architecturePatterns: ["src/[\\w/]+\\.ts", "[A-Z][a-zA-Z]+(Engine|Store|Service|Manager|Handler|Client)", "interface [A-Z]", "class [A-Z]"],
      dedupBm25Threshold: 15,
      dedupCandidateLimit: 100,
      eventConfidence: {
        decision: 0.5,
        plan: 0.7,
        errorFix: 0.4,
        batch: 0.3,
        pattern: 0.2,
      },
      reinforcementBoost: 0.3,
      maxConfidence: 1.0,
      insightsMaxAgeDays: 90,
    },
  },
  restoration: {
    recentSummaries: 3,
    promptSearchMinScore: 2,
    promptSearchMaxResults: 3,
    promptSnippetLength: 200,
    maxInjectedMemoryBytes: 2048,
    reservedForLearningInstruction: 1024,
    maxInjectedMemoryItems: 3,
    dedupMinPrefix: 64,
    recencyHalfLifeHours: 24,
    crossSessionAffinity: 0.85,
    recallUsageBoost: 0.75,
    recallUsageSmoothing: 1,
    surfacingCooldownWindow: 2,
    resurfaceMargin: 0.75,
    unusedSurfacingPenalty: 0.15,
    staleAfterDays: 90,
    staleSurfacingWithoutUseLimit: 5,
    restoreMaxPromotedAgeDays: 180,
    stalePenalty: 0.5,
    allowStaleOnStrongMatch: true,
  },
  llm: {
    provider: "auto",
    model: "",
    apiKey: "",
    baseUrl: "",
    fastMode: false,
    requestTimeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    retry: { ...DEFAULT_LLM_RETRY_POLICY },
  },
  summarizer: { mock: false },
  security: {
    sensitivePatterns: [],
  },
  hooks: { snapshotIntervalSec: 60, disableAutoCompact: false },
};

const DENIED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const SYSTEMD_CREDENTIAL_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "LCM_SUMMARY_API_KEY",
  "LCM_POSTGRES_URL",
] as const;
type SystemdCredentialEnvName = typeof SYSTEMD_CREDENTIAL_ENV_NAMES[number];
const SYSTEMD_CREDENTIAL_ENV_NAME_SET = new Set<SystemdCredentialEnvName>(SYSTEMD_CREDENTIAL_ENV_NAMES);
const LAUNCHD_CREDENTIAL_DIRECTORY_ENV = "LCM_CREDENTIAL_DIRECTORY";
const LAUNCHD_CREDENTIAL_FILE_PREFIX = "LCM_CREDENTIAL_";
const LAUNCHD_CREDENTIAL_FILE_SUFFIX = "_FILE";
const CREDENTIAL_MAX_BYTES = 1024 * 1024;

/**
 * systemd deliberately uses a read-only credential directory and read-only
 * regular leaves.  The user manager observed on Linux exposes these as 0500
 * and 0400 respectively; launchd's 0700/0600 contract is intentionally not
 * reused here.
 */
const SYSTEMD_CREDENTIAL_DIRECTORY_MODES = Object.freeze([0o500]);
const SYSTEMD_CREDENTIAL_FILE_MODES = Object.freeze([0o400]);
const SYSTEMD_CREDENTIAL_MAX_COUNT = SYSTEMD_CREDENTIAL_ENV_NAMES.length;
/**
 * Production launchd uses one credential context. Keep a small fixed allowance
 * for isolated in-process contexts, but never evict an established snapshot:
 * eviction could make a later reload reopen a one-shot credential file.
 */
const LAUNCHD_CREDENTIAL_SNAPSHOT_CAPACITY = 16;
const launchdCredentialSnapshots = new Map<string, CredentialProjection>();

type SystemdCredentialPrefix = {
  path: string;
  expectedUid?: number;
};

type TrustedSystemdCredentialsDir = SystemdCredentialPrefix & {
  path: string;
  dev: number;
  ino: number;
  runtimeRoot?: string;
};

type CredentialProjection = Readonly<{
  authenticated: boolean;
  /** Credential names are masked from ambient env once markers authenticate. */
  names: readonly string[];
  values: Readonly<Record<string, string>>;
}>;

const EMPTY_CREDENTIAL_PROJECTION: CredentialProjection = Object.freeze({
  authenticated: false,
  names: Object.freeze([]),
  values: Object.freeze({}),
});

function systemdCredentialDirPrefixes(): SystemdCredentialPrefix[] {
  const prefixes: SystemdCredentialPrefix[] = [{ path: "/run/credentials/" }];
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    if (Number.isSafeInteger(uid) && uid >= 0) {
      prefixes.push({ path: `/run/user/${uid}/credentials/`, expectedUid: uid });
    }
  }
  return prefixes;
}

function systemdCredentialDirectoryPrefix(path: string): SystemdCredentialPrefix | undefined {
  const normalized = resolve(path);
  return systemdCredentialDirPrefixes().find(({ path: prefix }) => {
    if (!normalized.startsWith(prefix)) return false;
    const suffix = normalized.slice(prefix.length);
    return suffix.length > 0 && !suffix.includes("/");
  });
}

function trustedSystemdRuntimeDirectory(path: string | undefined): string | undefined {
  if (!path || !isAbsolute(path) || /[\u0000\r\n]/u.test(path)) return undefined;
  const normalized = resolve(path);
  try {
    const stats = lstatSync(normalized);
    const canonical = realpathSync(normalized);
    const uid = typeof process.getuid === "function" ? process.getuid() : stats.uid;
    if (
      stats.isSymbolicLink()
      || !stats.isDirectory()
      || canonical !== normalized
      || stats.uid !== uid
      || (stats.mode & 0o777) !== 0o700
    ) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

function trustedSystemdCredentialsDir(
  credentialsDir: string | undefined,
  runtimeDirectory?: string,
): TrustedSystemdCredentialsDir | undefined {
  if (!credentialsDir || !isAbsolute(credentialsDir)) return undefined;
  const requested = resolve(credentialsDir);
  let stats: ReturnType<typeof lstatSync>;
  let realDir: string;
  try {
    stats = lstatSync(requested);
    realDir = realpathSync(requested);
  } catch {
    return undefined;
  }
  const standardPrefix = systemdCredentialDirectoryPrefix(realDir);
  const trustedRuntimeRoot = standardPrefix === undefined
    ? trustedSystemdRuntimeDirectory(runtimeDirectory)
    : undefined;
  const runtimePrefix = trustedRuntimeRoot === undefined ? undefined : `${trustedRuntimeRoot}/credentials/`;
  const runtimeSuffix = runtimePrefix === undefined || !realDir.startsWith(runtimePrefix)
    ? undefined
    : realDir.slice(runtimePrefix.length);
  const prefix = standardPrefix ?? (runtimePrefix !== undefined
    && runtimeSuffix !== undefined
    && runtimeSuffix.length > 0
    && !runtimeSuffix.includes("/")
    ? { path: runtimePrefix, expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined }
    : undefined);
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || realDir !== requested
    || prefix === undefined
    || !SYSTEMD_CREDENTIAL_DIRECTORY_MODES.includes(stats.mode & 0o7777)
    || (prefix.expectedUid !== undefined && stats.uid !== prefix.expectedUid)
  ) return undefined;
  return {
    ...prefix,
    path: realDir,
    dev: stats.dev,
    ino: stats.ino,
    ...(trustedRuntimeRoot === undefined ? {} : { runtimeRoot: trustedRuntimeRoot }),
  };
}

function isSystemdCredentialEnvName(name: string): name is SystemdCredentialEnvName {
  return SYSTEMD_CREDENTIAL_ENV_NAME_SET.has(name as SystemdCredentialEnvName);
}

function credentialNamesFromEnv(env: Record<string, string | undefined>): SystemdCredentialEnvName[] | undefined {
  const raw = env.LCM_SYSTEMD_CRED_IDS;
  if (raw === undefined) return [];
  if (typeof raw !== "string") return undefined;
  if (raw.trim() === "") return [];
  const names = raw.split(",").map((name) => name.trim());
  if (
    names.length === 0
    || names.length > SYSTEMD_CREDENTIAL_MAX_COUNT
    || names.some((name) => !isSystemdCredentialEnvName(name))
    || new Set(names).size !== names.length
  ) return undefined;
  return names as SystemdCredentialEnvName[];
}

function credentialFileName(name: SystemdCredentialEnvName): string {
  switch (name) {
    case "ANTHROPIC_API_KEY":
      return "ANTHROPIC_API_KEY";
    case "CLAUDE_CODE_OAUTH_TOKEN":
      return "CLAUDE_CODE_OAUTH_TOKEN";
    case "OPENAI_API_KEY":
      return "OPENAI_API_KEY";
    case "LCM_SUMMARY_API_KEY":
      return "LCM_SUMMARY_API_KEY";
    case "LCM_POSTGRES_URL":
      return "LCM_POSTGRES_URL";
  }
}

function trustedSystemdCredentialsDirStillValid(directory: TrustedSystemdCredentialsDir): boolean {
  try {
    const stats = lstatSync(directory.path);
    const prefix = directory.runtimeRoot === undefined
      ? systemdCredentialDirectoryPrefix(directory.path)
      : (() => {
        const runtimeRoot = trustedSystemdRuntimeDirectory(directory.runtimeRoot);
        const runtimePrefix = runtimeRoot === undefined ? undefined : `${runtimeRoot}/credentials/`;
        const suffix = runtimePrefix === undefined || !directory.path.startsWith(runtimePrefix)
          ? undefined
          : directory.path.slice(runtimePrefix.length);
        return runtimePrefix !== undefined && suffix !== undefined && suffix.length > 0 && !suffix.includes("/")
          ? { path: runtimePrefix, expectedUid: directory.expectedUid }
          : undefined;
      })();
    return !stats.isSymbolicLink()
      && stats.isDirectory()
      && prefix !== undefined
      && stats.dev === directory.dev
      && stats.ino === directory.ino
      && SYSTEMD_CREDENTIAL_DIRECTORY_MODES.includes(stats.mode & 0o7777)
      && (prefix.expectedUid === undefined || stats.uid === prefix.expectedUid)
      && realpathSync(directory.path) === directory.path;
  } catch {
    return false;
  }
}

function readSystemdCredentialEnv(env: Record<string, string | undefined>): CredentialProjection {
  const credentialsDir = trustedSystemdCredentialsDir(env.CREDENTIALS_DIRECTORY, env.XDG_RUNTIME_DIR);
  const names = credentialNamesFromEnv(env);
  if (!credentialsDir || names === undefined || names.length === 0) return EMPTY_CREDENTIAL_PROJECTION;
  const credentialEnv: Record<string, string> = {};
  for (const name of names) {
    if (!trustedSystemdCredentialsDirStillValid(credentialsDir)) return EMPTY_CREDENTIAL_PROJECTION;
    const credentialFile = resolve(credentialsDir.path, credentialFileName(name));
    try {
      if (realpathSync(credentialFile) !== credentialFile) continue;
    } catch {
      // Ignore missing credentials; normal env/config validation will report required keys.
      continue;
    }
    try {
      const value = readBoundedRegularFile(credentialFile, {
        allowedRoot: credentialsDir.path,
        maxBytes: CREDENTIAL_MAX_BYTES,
        expectedUid: credentialsDir.expectedUid,
        allowedModes: SYSTEMD_CREDENTIAL_FILE_MODES,
        requireSingleLink: true,
      }).replace(/\n+$/, "");
      // A unit credential directory is immutable for this read.  If its
      // canonical inode or security metadata changed while reading, discard
      // every projected value rather than returning a mixed snapshot.
      if (!trustedSystemdCredentialsDirStillValid(credentialsDir)) return EMPTY_CREDENTIAL_PROJECTION;
      credentialEnv[name] = value;
    } catch {
      // Ignore missing credentials; normal env/config validation will report required keys.
    }
  }
  return Object.freeze({
    authenticated: true,
    names: Object.freeze([...names]),
    values: Object.freeze(credentialEnv),
  });
}

function trustedLaunchdCredentialsDir(path: string | undefined): string | undefined {
  if (!path || !isAbsolute(path)) return undefined;
  try {
    const stats = lstatSync(path);
    const canonical = realpathSync(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : stats.uid;
    if (
      stats.isSymbolicLink()
      || !stats.isDirectory()
      || stats.uid !== uid
      || (stats.mode & 0o777) !== 0o700
      || canonical !== resolve(path)
    ) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

/**
 * Identify one launchd credential context without touching its filesystem.
 *
 * The marker directory is nonce-scoped by the supervisor.  Keeping its
 * normalized marker paths in the key prevents independent launch contexts from
 * sharing a snapshot while still allowing a reload after launchd cleanup has
 * removed the source files or directory.
 */
function normalizedLaunchdCredentialPath(path: string | undefined): string | null {
  if (path === undefined) return null;
  return isAbsolute(path) ? `absolute:${resolve(path)}` : `relative:${path}`;
}

function launchdCredentialSnapshotKey(env: Record<string, string | undefined>): string {
  const configuredFiles = MANAGED_CREDENTIAL_NAMES.map(name => [
    name,
    normalizedLaunchdCredentialPath(env[`${LAUNCHD_CREDENTIAL_FILE_PREFIX}${name}${LAUNCHD_CREDENTIAL_FILE_SUFFIX}`]),
  ]);
  return JSON.stringify([
    normalizedLaunchdCredentialPath(env[LAUNCHD_CREDENTIAL_DIRECTORY_ENV]),
    configuredFiles,
  ]);
}

type LaunchdCredentialMarker = Readonly<{ name: string; path: string; expected: string }>;

function launchdCredentialMarkers(
  env: Record<string, string | undefined>,
  directory: string,
): readonly LaunchdCredentialMarker[] | undefined {
  const markers: LaunchdCredentialMarker[] = [];
  for (const name of MANAGED_CREDENTIAL_NAMES) {
    const configured = env[`${LAUNCHD_CREDENTIAL_FILE_PREFIX}${name}${LAUNCHD_CREDENTIAL_FILE_SUFFIX}`];
    if (configured === undefined) continue;
    if (!isAbsolute(configured)) return undefined;
    const expected = resolve(directory, name);
    if (resolve(configured) !== expected) return undefined;
    markers.push(Object.freeze({ name, path: configured, expected }));
  }
  return markers;
}

function authenticatedCredentialProjection(
  names: readonly string[],
  values: Readonly<Record<string, string>>,
): CredentialProjection {
  return Object.freeze({
    authenticated: true,
    names: Object.freeze([...names]),
    values: Object.freeze({ ...values }),
  });
}

/** Resolve allow-listed private one-launch credential files used by launchd. */
function readLaunchdCredentialEnv(env: Record<string, string | undefined>): CredentialProjection {
  const snapshotKey = launchdCredentialSnapshotKey(env);
  const snapshot = launchdCredentialSnapshots.get(snapshotKey);
  if (snapshot !== undefined) return snapshot;
  const directory = trustedLaunchdCredentialsDir(env[LAUNCHD_CREDENTIAL_DIRECTORY_ENV]);
  if (!directory) return EMPTY_CREDENTIAL_PROJECTION;
  const markers = launchdCredentialMarkers(env, directory);
  if (markers === undefined || markers.length === 0) return EMPTY_CREDENTIAL_PROJECTION;
  const names = markers.map(({ name }) => name);
  if (launchdCredentialSnapshots.size >= LAUNCHD_CREDENTIAL_SNAPSHOT_CAPACITY) {
    // The bound is deliberately fail-closed. Do not read a new file and do not
    // evict an established context, because either action could expose a later
    // reload to a replacement one-shot file.
    return authenticatedCredentialProjection(names, {});
  }
  const credentialEnv: Record<string, string> = {};
  for (const { name, path, expected } of markers) {
    try {
      const stats = lstatSync(path);
      const uid = typeof process.getuid === "function" ? process.getuid() : stats.uid;
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1 || stats.uid !== uid || (stats.mode & 0o777) !== 0o600) continue;
      if (realpathSync(path) !== expected) continue;
      credentialEnv[name] = consumeBoundedRegularFile(path, {
        allowedRoot: directory,
        maxBytes: CREDENTIAL_MAX_BYTES,
        expectedUid: typeof process.getuid === "function" && Number.isSafeInteger(uid) ? uid : undefined,
        allowedModes: [0o600],
        requireSingleLink: true,
      }).replace(/\n+$/u, "");
    } catch {
      // Missing, stale, tampered, and oversized launch credentials remain
      // unavailable; ordinary configuration validation reports the key.
    }
  }
  const projection = authenticatedCredentialProjection(names, credentialEnv);
  launchdCredentialSnapshots.set(snapshotKey, projection);
  return projection;
}

/** Resolve the environment used for daemon configuration, including trusted systemd credentials. */
export function resolveDaemonConfigEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const resolved: Record<string, string | undefined> = { ...env };
  for (const projection of [readSystemdCredentialEnv(env), readLaunchdCredentialEnv(env)]) {
    if (!projection.authenticated) continue;
    for (const name of projection.names) delete resolved[name];
    Object.assign(resolved, projection.values);
  }
  return resolved;
}

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  if (!source || typeof source !== "object") return target;
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (DENIED_KEYS.has(key)) continue;
    if (source[key] !== undefined) {
      result[key] = (
        typeof source[key] === "object" &&
        source[key] !== null &&
        !Array.isArray(source[key]) &&
        typeof result[key] === "object" &&
        result[key] !== null &&
        !Array.isArray(result[key])
      )
        ? deepMerge(result[key] as Record<string, unknown>, source[key] as Record<string, unknown>)
        : source[key];
    }
  }
  return result;
}

const LLM_PROVIDER_ALIASES: Readonly<Record<string, LlmProvider>> = {
  claude: "claude-process",
  "claude-cli": "claude-process",
  codex: "codex-process",
  custom: "openai",
  "openai-compatible": "openai",
};
const LLM_KEYS = new Set([
  "provider", "model", "apiKey", "baseUrl", "baseURL", "apiMode", "reasoningEffort", "fastMode",
  "requestTimeoutMs", "retry",
]);
const CONFIG_EXAMPLE = JSON.stringify({
  storage: {
    backend: "sqlite",
  },
  llm: {
    provider: "openai",
    model: "gpt-5",
    apiKey: "${OPENAI_API_KEY}",
    baseUrl: "https://api.openai.com/v1",
    apiMode: "responses",
    reasoningEffort: "medium",
  },
}, null, 2);

export class ConfigValidationError extends Error {
  constructor(path: string, detail: string) {
    super(`[lcm] Invalid configuration at ${path}: ${detail}\nExample:\n${CONFIG_EXAMPLE}`);
    this.name = "ConfigValidationError";
  }
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isCredentialPath(path: string): boolean {
  const key = path.split(".").at(-1)!;
  return /(?:api[-_]?key|token|secret|password|credential)/i.test(key);
}

function displayValue(path: string, value: unknown): string {
  if (isCredentialPath(path)) return '"[REDACTED]"';
  // Structured values are only displayed for type errors, where their contents
  // are not useful and may contain credentials under arbitrary header names.
  if (value !== null && typeof value === "object") return '"[REDACTED]"';
  if ((path === "llm.baseUrl" || path === "llm.baseURL") && typeof value === "string") {
    return JSON.stringify(sanitizeUrlForDisplay(value));
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  const serialized = JSON.stringify(value, (_key, nestedValue) => {
    if (typeof nestedValue === "string" && /^[a-z][a-z\d+.-]*:\/\//i.test(nestedValue)) {
      return sanitizeUrlForDisplay(nestedValue);
    }
    return nestedValue;
  });
  return serialized === undefined ? String(value) : serialized;
}

function invalidType(path: string, value: unknown, expected: string): never {
  throw new ConfigValidationError(
    path,
    `expected ${expected}, received ${valueType(value)} ${displayValue(path, value)}`,
  );
}

export function normalizeLlmProvider(value: string): string {
  return LLM_PROVIDER_ALIASES[value] ?? value;
}

function validateProviderChoice(path: string, value: string): LlmProvider {
  const provider = normalizeLlmProvider(value);
  if (!(CANONICAL_LLM_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ConfigValidationError(
      path,
      `received ${displayValue(path, value)}; valid choices: ${CANONICAL_LLM_PROVIDERS.join(", ")}`,
    );
  }
  return provider as LlmProvider;
}

function validateStringField(llm: Record<string, unknown>, key: string): void {
  if (llm[key] !== undefined && typeof llm[key] !== "string") {
    invalidType(`llm.${key}`, llm[key], "a string");
  }
}

function validateBoundedInteger(path: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    invalidType(path, value, `an integer between ${min} and ${max}`);
  }
  if (value < min || value > max) {
    throw new ConfigValidationError(path, `expected an integer between ${min} and ${max}, received ${displayValue(path, value)}`);
  }
  return value;
}

function validateBoundedNumber(path: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidType(path, value, `a finite number between ${min} and ${max}`);
  }
  if (value < min || value > max) {
    throw new ConfigValidationError(path, `expected a number between ${min} and ${max}, received ${displayValue(path, value)}`);
  }
  return value;
}

function validateObject(path: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidType(path, value, "an object");
  }
  return value as Record<string, unknown>;
}

function validateOptionalInteger(
  object: Record<string, unknown>,
  key: string,
  path: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): void {
  if (object[key] !== undefined) validateBoundedInteger(`${path}.${key}`, object[key], min, max);
}

function validateOptionalNumber(
  object: Record<string, unknown>,
  key: string,
  path: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): void {
  if (object[key] !== undefined) validateBoundedNumber(`${path}.${key}`, object[key], min, max);
}

function validateOptionalString(object: Record<string, unknown>, key: string, path: string): void {
  if (object[key] !== undefined && typeof object[key] !== "string") {
    invalidType(`${path}.${key}`, object[key], "a string");
  }
}

function validateOptionalBoolean(object: Record<string, unknown>, key: string, path: string): void {
  if (object[key] !== undefined && typeof object[key] !== "boolean") {
    invalidType(`${path}.${key}`, object[key], "a boolean");
  }
}

function validateStringArray(path: string, value: unknown): void {
  if (!Array.isArray(value)) invalidType(path, value, "an array of strings");
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") invalidType(`${path}.${index}`, entry, "a string");
  }
}

function validateOptionalStringArray(object: Record<string, unknown>, key: string, path: string): void {
  if (object[key] !== undefined) validateStringArray(`${path}.${key}`, object[key]);
}

function rejectUnknownKeys(
  object: Record<string, unknown>,
  path: string,
  allowedKeys: ReadonlySet<string>,
): void {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      throw new ConfigValidationError(
        `${path}.${key}`,
        `unknown key ${JSON.stringify(key)}; valid keys: ${[...allowedKeys].join(", ")}`,
      );
    }
  }
}

const DAEMON_KEYS = new Set(["port", "socketPath", "logLevel", "logMaxSizeMB", "logRetentionDays", "idleTimeoutMs"]);
const COMPACTION_KEYS = new Set(["leafTokens", "maxDepth", "autoCompactMinTokens", "promotionThresholds"]);
const PROMOTION_THRESHOLD_KEYS = new Set([
  "minDepth", "compressionRatio", "keywords", "architecturePatterns", "dedupBm25Threshold",
  "dedupCandidateLimit", "eventConfidence", "reinforcementBoost", "maxConfidence", "insightsMaxAgeDays",
  // Supported legacy fields removed by the post-merge migration.
  "mergeMaxEntries", "confidenceDecayRate",
]);
const EVENT_CONFIDENCE_KEYS = new Set(["decision", "plan", "errorFix", "batch", "pattern"]);
const RESTORATION_KEYS = new Set([
  "recentSummaries", "promptSearchMinScore", "promptSearchMaxResults", "promptSnippetLength",
  "maxInjectedMemoryBytes", "reservedForLearningInstruction", "maxInjectedMemoryItems", "dedupMinPrefix",
  "recencyHalfLifeHours", "crossSessionAffinity", "recallUsageBoost", "recallUsageSmoothing",
  "surfacingCooldownWindow", "resurfaceMargin", "unusedSurfacingPenalty", "staleAfterDays",
  "staleSurfacingWithoutUseLimit", "restoreMaxPromotedAgeDays", "stalePenalty", "allowStaleOnStrongMatch",
  // Supported legacy names migrated after defaults are merged.
  "promptHintsByteBudget", "promptHintsReservedForLearningInstruction", "promptHintsMaxEmitted",
  "promptHintsDedupMinPrefix",
]);
const SUMMARIZER_KEYS = new Set(["mock"]);
const SECURITY_KEYS = new Set(["sensitivePatterns", "notify_on_filter"]);
const HOOK_KEYS = new Set(["snapshotIntervalSec", "disableAutoCompact"]);
const STORAGE_KEYS = new Set(["backend", "postgresql"]);
const POSTGRESQL_STORAGE_KEYS = new Set([
  "poolMax",
  "connectionTimeoutMs",
  "idleTimeoutMs",
  "statementTimeoutMs",
]);
const POSTGRESQL_STORAGE_OVERRIDE_KEYS = new Set([
  ...POSTGRESQL_STORAGE_KEYS,
  "url",
  "caFile",
]);

function validateStorageSection(value: unknown, allowRuntimeSecrets: boolean): void {
  const storage = validateObject("storage", value);
  rejectUnknownKeys(storage, "storage", STORAGE_KEYS);
  if (storage.backend !== undefined) {
    if (typeof storage.backend !== "string") invalidType("storage.backend", storage.backend, "a string");
    if (!(STORAGE_BACKENDS as readonly string[]).includes(storage.backend)) {
      throw new ConfigValidationError(
        "storage.backend",
        `received ${displayValue("storage.backend", storage.backend)}; valid choices: ${STORAGE_BACKENDS.join(", ")}`,
      );
    }
  }
  if (storage.postgresql === undefined) return;
  const postgresql = validateObject("storage.postgresql", storage.postgresql);
  for (const secretKey of ["url", "caFile"] as const) {
    if (!allowRuntimeSecrets && postgresql[secretKey] !== undefined) {
      throw new ConfigValidationError(
        `storage.postgresql.${secretKey}`,
        `must not be stored in config.json; use ${secretKey === "url" ? "LCM_POSTGRES_URL" : "LCM_POSTGRES_CA_FILE"}`,
      );
    }
  }
  rejectUnknownKeys(
    postgresql,
    "storage.postgresql",
    allowRuntimeSecrets ? POSTGRESQL_STORAGE_OVERRIDE_KEYS : POSTGRESQL_STORAGE_KEYS,
  );
  validateOptionalInteger(postgresql, "poolMax", "storage.postgresql", 1, 100);
  validateOptionalInteger(postgresql, "connectionTimeoutMs", "storage.postgresql", 1, 600_000);
  validateOptionalInteger(postgresql, "idleTimeoutMs", "storage.postgresql", 0, 3_600_000);
  validateOptionalInteger(postgresql, "statementTimeoutMs", "storage.postgresql", 1, 3_600_000);
  if (allowRuntimeSecrets) {
    validateOptionalString(postgresql, "url", "storage.postgresql");
    validateOptionalString(postgresql, "caFile", "storage.postgresql");
  }
}

function validateDaemonSection(value: unknown, allowEphemeralPort: boolean): void {
  const daemon = validateObject("daemon", value);
  rejectUnknownKeys(daemon, "daemon", DAEMON_KEYS);
  validateOptionalInteger(daemon, "port", "daemon", allowEphemeralPort ? 0 : 1, 65_535);
  validateOptionalString(daemon, "socketPath", "daemon");
  validateOptionalString(daemon, "logLevel", "daemon");
  validateOptionalNumber(daemon, "logMaxSizeMB", "daemon", 0, Number.MAX_SAFE_INTEGER);
  validateOptionalInteger(daemon, "logRetentionDays", "daemon");
  validateOptionalInteger(daemon, "idleTimeoutMs", "daemon", 0, 86_400_000);
}

function validatePromotionThresholds(value: unknown): void {
  const thresholds = validateObject("compaction.promotionThresholds", value);
  const path = "compaction.promotionThresholds";
  rejectUnknownKeys(thresholds, path, PROMOTION_THRESHOLD_KEYS);
  validateOptionalInteger(thresholds, "minDepth", path);
  validateOptionalNumber(thresholds, "compressionRatio", path, 0, 1);
  validateOptionalNumber(thresholds, "dedupBm25Threshold", path);
  validateOptionalInteger(thresholds, "dedupCandidateLimit", path, 1);
  validateOptionalNumber(thresholds, "reinforcementBoost", path, 0, 1);
  validateOptionalNumber(thresholds, "maxConfidence", path, 0, 1);
  validateOptionalInteger(thresholds, "insightsMaxAgeDays", path);
  // Supported legacy fields remain valid until the post-merge migration removes them.
  validateOptionalInteger(thresholds, "mergeMaxEntries", path, 1);
  validateOptionalNumber(thresholds, "confidenceDecayRate", path, 0, 1);
  validateOptionalStringArray(thresholds, "architecturePatterns", path);

  if (thresholds.keywords !== undefined) {
    const keywords = validateObject(`${path}.keywords`, thresholds.keywords);
    for (const [category, entries] of Object.entries(keywords)) {
      validateStringArray(`${path}.keywords.${category}`, entries);
    }
  }
  if (thresholds.eventConfidence !== undefined) {
    const confidence = validateObject(`${path}.eventConfidence`, thresholds.eventConfidence);
    rejectUnknownKeys(confidence, `${path}.eventConfidence`, EVENT_CONFIDENCE_KEYS);
    for (const key of ["decision", "plan", "errorFix", "batch", "pattern"]) {
      validateOptionalNumber(confidence, key, `${path}.eventConfidence`, 0, 1);
    }
  }
}

function validateCompactionSection(value: unknown): void {
  const compaction = validateObject("compaction", value);
  rejectUnknownKeys(compaction, "compaction", COMPACTION_KEYS);
  validateOptionalInteger(compaction, "leafTokens", "compaction", 1);
  validateOptionalInteger(compaction, "maxDepth", "compaction", 1);
  validateOptionalInteger(compaction, "autoCompactMinTokens", "compaction");
  if (compaction.promotionThresholds !== undefined) validatePromotionThresholds(compaction.promotionThresholds);
}

function validateRestorationSection(value: unknown): void {
  const restoration = validateObject("restoration", value);
  const path = "restoration";
  rejectUnknownKeys(restoration, path, RESTORATION_KEYS);
  for (const key of [
    "recentSummaries", "promptSearchMaxResults", "promptSnippetLength", "maxInjectedMemoryBytes",
    "reservedForLearningInstruction", "maxInjectedMemoryItems", "dedupMinPrefix",
    "staleSurfacingWithoutUseLimit", "restoreMaxPromotedAgeDays",
    "promptHintsByteBudget", "promptHintsReservedForLearningInstruction", "promptHintsMaxEmitted",
    "promptHintsDedupMinPrefix",
  ]) {
    validateOptionalInteger(restoration, key, path);
  }
  for (const key of [
    "promptSearchMinScore", "recallUsageBoost", "recallUsageSmoothing", "surfacingCooldownWindow",
    "resurfaceMargin", "unusedSurfacingPenalty", "staleAfterDays",
  ]) {
    validateOptionalNumber(restoration, key, path);
  }
  for (const key of ["crossSessionAffinity", "stalePenalty"]) {
    validateOptionalNumber(restoration, key, path, 0, 1);
  }
  if (restoration.recencyHalfLifeHours !== undefined) {
    const halfLife = restoration.recencyHalfLifeHours;
    if (typeof halfLife !== "number" || !Number.isFinite(halfLife)) {
      invalidType(`${path}.recencyHalfLifeHours`, halfLife, "a positive finite number");
    }
    if (halfLife <= 0) {
      throw new ConfigValidationError(`${path}.recencyHalfLifeHours`, `expected a positive number, received ${displayValue(`${path}.recencyHalfLifeHours`, halfLife)}`);
    }
  }
  validateOptionalBoolean(restoration, "allowStaleOnStrongMatch", path);
}

/** Validate every known non-LLM configuration leaf while preserving extension keys. */
function validateKnownConfigSections(
  config: Record<string, unknown>,
  options: { allowEphemeralDaemonPort?: boolean; allowStorageSecrets?: boolean } = {},
): void {
  if (config.version !== undefined) validateBoundedInteger("version", config.version, 1, Number.MAX_SAFE_INTEGER);
  if (config.storage !== undefined) validateStorageSection(config.storage, options.allowStorageSecrets === true);
  if (config.daemon !== undefined) validateDaemonSection(config.daemon, options.allowEphemeralDaemonPort === true);
  if (config.compaction !== undefined) validateCompactionSection(config.compaction);
  if (config.restoration !== undefined) validateRestorationSection(config.restoration);
  if (config.summarizer !== undefined) {
    const summarizer = validateObject("summarizer", config.summarizer);
    rejectUnknownKeys(summarizer, "summarizer", SUMMARIZER_KEYS);
    validateOptionalBoolean(summarizer, "mock", "summarizer");
  }
  if (config.security !== undefined) {
    const security = validateObject("security", config.security);
    rejectUnknownKeys(security, "security", SECURITY_KEYS);
    validateOptionalStringArray(security, "sensitivePatterns", "security");
    validateOptionalBoolean(security, "notify_on_filter", "security");
  }
  if (config.hooks !== undefined) {
    const hooks = validateObject("hooks", config.hooks);
    rejectUnknownKeys(hooks, "hooks", HOOK_KEYS);
    validateOptionalInteger(hooks, "snapshotIntervalSec", "hooks");
    validateOptionalBoolean(hooks, "disableAutoCompact", "hooks");
  }
}

/** Validate and merge a partial request policy over an already-effective policy. */
export function resolveLlmRequestPolicy(
  configPolicy: LlmRequestPolicy,
  partialOverride: LlmRequestPolicyOverride = {},
  pathPrefix = "llm",
): LlmRequestPolicy {
  if (partialOverride === null || typeof partialOverride !== "object" || Array.isArray(partialOverride)) {
    invalidType(pathPrefix, partialOverride, "an object");
  }
  const override = partialOverride as Record<string, unknown>;
  for (const key of Object.keys(override)) {
    if (key !== "requestTimeoutMs" && key !== "retry") {
      throw new ConfigValidationError(`${pathPrefix}.${key}`, `unknown request policy key ${JSON.stringify(key)}`);
    }
  }
  const requestTimeoutMs = override.requestTimeoutMs === undefined
    ? configPolicy.requestTimeoutMs
    : validateBoundedInteger(`${pathPrefix}.requestTimeoutMs`, override.requestTimeoutMs, 1, 3_600_000);

  let retryOverride: Record<string, unknown> = {};
  if (override.retry !== undefined) {
    if (override.retry === null || typeof override.retry !== "object" || Array.isArray(override.retry)) {
      invalidType(`${pathPrefix}.retry`, override.retry, "an object");
    }
    retryOverride = override.retry as Record<string, unknown>;
    const validRetryKeys = new Set(["maxAttempts", "initialDelayMs", "maxDelayMs", "multiplier"]);
    for (const key of Object.keys(retryOverride)) {
      if (!validRetryKeys.has(key)) {
        throw new ConfigValidationError(`${pathPrefix}.retry.${key}`, `unknown retry policy key ${JSON.stringify(key)}`);
      }
    }
  }

  const retry: LlmRetryPolicy = {
    maxAttempts: retryOverride.maxAttempts === undefined
      ? configPolicy.retry.maxAttempts
      : validateBoundedInteger(`${pathPrefix}.retry.maxAttempts`, retryOverride.maxAttempts, 1, 10),
    initialDelayMs: retryOverride.initialDelayMs === undefined
      ? configPolicy.retry.initialDelayMs
      : validateBoundedInteger(`${pathPrefix}.retry.initialDelayMs`, retryOverride.initialDelayMs, 0, 600_000),
    maxDelayMs: retryOverride.maxDelayMs === undefined
      ? configPolicy.retry.maxDelayMs
      : validateBoundedInteger(`${pathPrefix}.retry.maxDelayMs`, retryOverride.maxDelayMs, 0, 600_000),
    multiplier: retryOverride.multiplier === undefined
      ? configPolicy.retry.multiplier
      : validateBoundedNumber(`${pathPrefix}.retry.multiplier`, retryOverride.multiplier, 1, 10),
  };
  if (retry.initialDelayMs > retry.maxDelayMs) {
    throw new ConfigValidationError(
      `${pathPrefix}.retry.initialDelayMs`,
      `must be less than or equal to ${pathPrefix}.retry.maxDelayMs (${retry.maxDelayMs}), received ${retry.initialDelayMs}`,
    );
  }
  return { requestTimeoutMs, retry };
}

function normalizeBaseUrl(llm: Record<string, unknown>): void {
  validateStringField(llm, "baseUrl");
  validateStringField(llm, "baseURL");
  if (llm.baseUrl !== undefined && llm.baseURL !== undefined && llm.baseUrl !== llm.baseURL) {
    throw new ConfigValidationError(
      "llm.baseUrl",
      "conflicts with legacy llm.baseURL; remove llm.baseURL or make both values identical",
    );
  }
  if (llm.baseUrl === undefined && llm.baseURL !== undefined) llm.baseUrl = llm.baseURL;
  delete llm.baseURL;
}

function validateLlmObject(
  value: unknown,
  providerOverride?: LlmProvider,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidType("llm", value, "an object");
  }

  const llm = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(llm)) {
    if (!LLM_KEYS.has(key)) {
      throw new ConfigValidationError(
        `llm.${key}`,
        `unknown key ${JSON.stringify(key)} with ${valueType(llm[key])} value; valid keys: ${[...LLM_KEYS].join(", ")}`,
      );
    }
  }

  for (const key of ["provider", "model", "apiKey", "apiMode", "reasoningEffort"]) {
    validateStringField(llm, key);
  }
  validateOptionalBoolean(llm, "fastMode", "llm");
  normalizeBaseUrl(llm);
  resolveLlmRequestPolicy(
    { requestTimeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS, retry: { ...DEFAULT_LLM_RETRY_POLICY } },
    { requestTimeoutMs: llm.requestTimeoutMs, retry: llm.retry },
  );

  if (typeof llm.provider === "string") {
    // Preserve the configured provider long enough to determine whether an
    // environment override also invalidates its provider-specific model. An
    // override still permits recovery from stale provider names.
    llm.provider = providerOverride === undefined
      ? validateProviderChoice("llm.provider", llm.provider)
      : normalizeLlmProvider(llm.provider);
  }
  if (typeof llm.apiMode === "string" && !(LLM_API_MODES as readonly string[]).includes(llm.apiMode)) {
    throw new ConfigValidationError(
      "llm.apiMode",
      `received ${displayValue("llm.apiMode", llm.apiMode)}; valid choices: ${LLM_API_MODES.join(", ")}`,
    );
  }
  if (typeof llm.reasoningEffort === "string" && !(LLM_REASONING_EFFORTS as readonly string[]).includes(llm.reasoningEffort)) {
    throw new ConfigValidationError(
      "llm.reasoningEffort",
      `received ${displayValue("llm.reasoningEffort", llm.reasoningEffort)}; valid choices: ${LLM_REASONING_EFFORTS.join(", ")}`,
    );
  }
  return llm;
}

function parseConfigRoot(content: string, providerOverride?: LlmProvider): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError("$", `malformed JSON (${detail})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    invalidType("$", parsed, "a JSON object");
  }
  const root = { ...(parsed as Record<string, unknown>) };
  validateKnownConfigSections(root);
  const llm = validateLlmObject(root.llm, providerOverride);
  if (llm !== undefined) root.llm = llm;
  return migrateLegacyConfig(root);
}

/** Parse and normalize stored configuration without applying defaults or environment values. */
export function parseStoredConfig(content: string): Record<string, unknown> {
  return parseConfigRoot(content);
}

function normalizeProviderOverrideRequestPolicyKeys(
  explicitlyConfigured: Set<string>,
  providerOverride: LlmProvider | undefined,
): void {
  if (providerOverride === undefined || providerOverride === "openai") return;
  explicitlyConfigured.delete("retry");
  if (!supportsRequestTimeout(providerOverride)) {
    explicitlyConfigured.delete("requestTimeoutMs");
  }
}

function validateResolvedLlmRequestPolicy(
  provider: LlmProvider,
  explicitlyConfigured: ReadonlySet<string>,
): void {
  if (explicitlyConfigured.has("requestTimeoutMs") && !supportsRequestTimeout(provider)) {
    throw new ConfigValidationError(
      "llm.requestTimeoutMs",
      `is only valid when llm.provider is "auto", "openai", "claude-process", or "codex-process"`,
    );
  }
  if (explicitlyConfigured.has("retry") && provider !== "openai") {
    throw new ConfigValidationError(
      "llm.retry",
      `is only valid when llm.provider is "openai"`,
    );
  }
}

/** Resolve only the stored LLM request-policy fields needed by hook wrappers. */
export function parseLlmRequestPolicyConfig(
  content: string,
  env: Record<string, string | undefined> = {},
): LlmRequestPolicyConfig {
  const providerOverride = env.LCM_SUMMARY_PROVIDER
    ? validateProviderChoice("LCM_SUMMARY_PROVIDER", env.LCM_SUMMARY_PROVIDER)
    : undefined;
  const stored = parseConfigRoot(content, providerOverride);
  const llm = stored.llm as Partial<DaemonConfig["llm"]> | undefined;
  const explicitlyConfigured = new Set(Object.keys(llm ?? {}));
  normalizeProviderOverrideRequestPolicyKeys(explicitlyConfigured, providerOverride);
  const provider = providerOverride ?? llm?.provider ?? "auto";
  validateResolvedLlmRequestPolicy(provider, explicitlyConfigured);
  const policy = resolveLlmRequestPolicy(
    { requestTimeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS, retry: { ...DEFAULT_LLM_RETRY_POLICY } },
    { requestTimeoutMs: llm?.requestTimeoutMs, retry: llm?.retry },
  );
  return {
    llm: {
      provider,
      ...policy,
    },
  };
}

function requiredPostgreSqlSecret(
  value: unknown,
  envName: "LCM_POSTGRES_URL" | "LCM_POSTGRES_CA_FILE",
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigValidationError(envName, `must be a non-empty string when storage.backend is "postgresql"`);
  }
  return value.trim();
}

/** Resolve backend selection, environment-only secrets, bounds, and PostgreSQL TLS preflight. */
export function resolveStorageConfig(
  value: unknown,
  env: Record<string, string | undefined> = {},
): ResolvedStorageConfig {
  validateStorageSection(value, true);
  const storage = value as Record<string, unknown>;
  const backend = (storage.backend ?? "sqlite") as StorageBackend;
  if (backend === "sqlite") return { backend: "sqlite" };

  const postgresql = (storage.postgresql ?? {}) as Record<string, unknown>;
  const urlValue = postgresql.url ?? env.LCM_POSTGRES_URL;
  const caFileValue = postgresql.caFile ?? env.LCM_POSTGRES_CA_FILE;
  const url = requiredPostgreSqlSecret(urlValue, "LCM_POSTGRES_URL");
  const caFile = requiredPostgreSqlSecret(caFileValue, "LCM_POSTGRES_CA_FILE");

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ConfigValidationError("LCM_POSTGRES_URL", "must be an absolute postgresql: URL");
  }
  if (parsedUrl.protocol !== "postgresql:") {
    throw new ConfigValidationError("LCM_POSTGRES_URL", "must use the postgresql: scheme");
  }
  if (!url.toLowerCase().startsWith("postgresql://") || parsedUrl.hostname === "") {
    throw new ConfigValidationError(
      "LCM_POSTGRES_URL",
      "must use hierarchical postgresql:// form with a non-empty hostname",
    );
  }
  const port = parsedUrl.port === "" ? 5432 : Number(parsedUrl.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigValidationError(
      "LCM_POSTGRES_URL",
      "must use a PostgreSQL port from 1 through 65535",
    );
  }
  if (hasUrlQueryComponent(url)) {
    throw new ConfigValidationError(
      "LCM_POSTGRES_URL",
      "must not contain URL query parameters, including TLS parameters; configure PostgreSQL behavior through LCM settings and LCM_POSTGRES_CA_FILE",
    );
  }
  if (parsedUrl.hash !== "") {
    throw new ConfigValidationError(
      "LCM_POSTGRES_URL",
      "must not contain a URL fragment; provide only the PostgreSQL server, credentials, port, and database",
    );
  }
  let database: string;
  let username: string;
  let password: string;
  try {
    database = decodeURIComponent(parsedUrl.pathname.slice(1));
    username = decodeURIComponent(parsedUrl.username);
    password = decodeURIComponent(parsedUrl.password);
  } catch {
    throw new ConfigValidationError(
      "LCM_POSTGRES_URL",
      "must include an explicit non-empty username and password and exactly one non-empty decoded database path segment",
    );
  }
  if (username === "" || password === "" || database === "" || database.includes("/")) {
    throw new ConfigValidationError(
      "LCM_POSTGRES_URL",
      "must include an explicit non-empty username and password and exactly one non-empty decoded database path segment",
    );
  }
  if (!isAbsolute(caFile)) {
    throw new ConfigValidationError("LCM_POSTGRES_CA_FILE", `must be an absolute path, received ${JSON.stringify(caFile)}`);
  }
  let resolvedCaFile: string;
  let caContents: string;
  try {
    resolvedCaFile = realpathSync(caFile);
    // A user-selected absolute CA file has no narrower application-owned trust
    // root. dirname(...) only satisfies the generic reader contract; safety
    // comes from the canonical path plus its descriptor-bound no-follow,
    // regular-file, identity, and size checks.
    caContents = readBoundedRegularFile(resolvedCaFile, {
      allowedRoot: dirname(resolvedCaFile),
      maxBytes: POSTGRESQL_CA_FILE_MAX_BYTES,
    });
  } catch {
    throw new ConfigValidationError(
      "LCM_POSTGRES_CA_FILE",
      `must resolve to a readable regular file no larger than ${POSTGRESQL_CA_FILE_MAX_BYTES} bytes: ${JSON.stringify(caFile)}`,
    );
  }
  if (Buffer.byteLength(caContents) === 0) {
    throw new ConfigValidationError("LCM_POSTGRES_CA_FILE", `must not be empty: ${JSON.stringify(caFile)}`);
  }

  return {
    backend: "postgresql",
    postgresql: {
      poolMax: (postgresql.poolMax ?? DEFAULT_POSTGRESQL_STORAGE_SETTINGS.poolMax) as number,
      connectionTimeoutMs: (postgresql.connectionTimeoutMs ?? DEFAULT_POSTGRESQL_STORAGE_SETTINGS.connectionTimeoutMs) as number,
      idleTimeoutMs: (postgresql.idleTimeoutMs ?? DEFAULT_POSTGRESQL_STORAGE_SETTINGS.idleTimeoutMs) as number,
      statementTimeoutMs: (postgresql.statementTimeoutMs ?? DEFAULT_POSTGRESQL_STORAGE_SETTINGS.statementTimeoutMs) as number,
      url,
      caFile: resolvedCaFile,
    },
  };
}

/**
 * Convert effective daemon configuration back to a safe persisted document.
 * Request timeout defaults remain effective at runtime but are explicit only
 * for providers that use them. Retry settings remain OpenAI-only.
 */
export function daemonConfigForPersistence(config: DaemonConfig): Record<string, unknown> {
  const stored = structuredClone(config) as unknown as Record<string, unknown>;
  stored.storage = config.storage.backend === "sqlite"
    ? { backend: "sqlite" }
    : {
      backend: "postgresql",
      postgresql: {
        poolMax: config.storage.postgresql.poolMax,
        connectionTimeoutMs: config.storage.postgresql.connectionTimeoutMs,
        idleTimeoutMs: config.storage.postgresql.idleTimeoutMs,
        statementTimeoutMs: config.storage.postgresql.statementTimeoutMs,
      },
    };
  const llm = stored.llm as Record<string, unknown>;
  if (!supportsRequestTimeout(config.llm.provider)) {
    delete llm.requestTimeoutMs;
  }
  if (llm.provider !== "openai") {
    delete llm.retry;
  }
  if (!supportsFastMode(config.llm.provider)) delete llm.fastMode;
  if (
    config.llm.reasoningEffort !== undefined
    && !reasoningEffortsForProvider(config.llm.provider, config.llm.apiMode).includes(config.llm.reasoningEffort)
  ) {
    delete llm.reasoningEffort;
  }
  return stored;
}

function requireNonEmpty(value: string, path: string, provider: LlmProvider): void {
  if (value.trim() === "") {
    throw new ConfigValidationError(
      path,
      `expected a non-empty string when llm.provider is ${JSON.stringify(provider)}, received string ${displayValue(path, value)}`,
    );
  }
}

function isPublicOpenAIBaseURL(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, "") === "api.openai.com";
  } catch {
    return false;
  }
}

function migrateLegacyPromotionThresholds(thresholds: Record<string, unknown>): Record<string, unknown> {
  const migrated = { ...thresholds };
  if (migrated.mergeMaxEntries !== undefined && migrated.dedupCandidateLimit === undefined) {
    migrated.dedupCandidateLimit = migrated.mergeMaxEntries;
  }
  delete migrated.mergeMaxEntries;
  delete migrated.confidenceDecayRate;
  return migrated;
}

function migrateLegacyConfig(config: Record<string, unknown>): Record<string, unknown> {
  const compaction = config.compaction as Record<string, unknown> | undefined;
  const thresholds = compaction?.promotionThresholds as Record<string, unknown> | undefined;
  if (thresholds === undefined) return config;

  return {
    ...config,
    compaction: {
      ...compaction,
      promotionThresholds: migrateLegacyPromotionThresholds(thresholds),
    },
  };
}

function validateResolvedLlm(merged: DaemonConfig, explicitlyConfigured: ReadonlySet<string>): void {
  const { llm } = merged;
  if (llm.provider === "anthropic") {
    requireNonEmpty(llm.model, "llm.model", llm.provider);
    requireNonEmpty(llm.apiKey!, "llm.apiKey", llm.provider);
  }

  if (llm.provider === "openai") {
    requireNonEmpty(llm.model, "llm.model", llm.provider);
    requireNonEmpty(llm.baseUrl, "llm.baseUrl", llm.provider);
    let baseUrl: URL;
    try {
      baseUrl = new URL(llm.baseUrl);
    } catch {
      throw new ConfigValidationError("llm.baseUrl", `expected an absolute HTTP(S) URL, received string ${displayValue("llm.baseUrl", llm.baseUrl)}`);
    }
    if (!(["http:", "https:"] as const).includes(baseUrl.protocol as "http:" | "https:")) {
      throw new ConfigValidationError("llm.baseUrl", `expected an absolute HTTP(S) URL, received string ${displayValue("llm.baseUrl", llm.baseUrl)}`);
    }
    if (isPublicOpenAIBaseURL(llm.baseUrl)) {
      requireNonEmpty(llm.apiKey!, "llm.apiKey", llm.provider);
    }
    llm.apiMode ??= "chat-completions";
  } else {
    if (explicitlyConfigured.has("apiMode")) {
      throw new ConfigValidationError(
        "llm.apiMode",
        `is only valid when llm.provider is "openai"`,
      );
    }
  }
  validateResolvedLlmRequestPolicy(llm.provider, explicitlyConfigured);

  if (explicitlyConfigured.has("reasoningEffort") && llm.reasoningEffort !== undefined) {
    const validEfforts = reasoningEffortsForProvider(llm.provider, llm.apiMode);
    if (!validEfforts.includes(llm.reasoningEffort)) {
      const providerContext = llm.provider === "openai"
        ? `llm.provider "openai" with llm.apiMode ${JSON.stringify(llm.apiMode)}`
        : `llm.provider ${JSON.stringify(llm.provider)}`;
      throw new ConfigValidationError(
        "llm.reasoningEffort",
        validEfforts.length > 0
          ? `received ${displayValue("llm.reasoningEffort", llm.reasoningEffort)}; valid choices for ${providerContext}: ${validEfforts.join(", ")}`
          : `is not supported for ${providerContext}`,
      );
    }
  }
  if (explicitlyConfigured.has("fastMode") && !supportsFastMode(llm.provider)) {
    throw new ConfigValidationError(
      "llm.fastMode",
      `is only valid when llm.provider is "auto", "claude-process", or "codex-process"`,
    );
  }
}

/** Parse, merge, resolve, and validate daemon configuration, including selected-backend preflight. */
export function parseDaemonConfig(
  content: string,
  overrides: unknown = {},
  env: Record<string, string | undefined> = {},
): DaemonConfig {
  const providerOverride = env.LCM_SUMMARY_PROVIDER
    ? validateProviderChoice("LCM_SUMMARY_PROVIDER", env.LCM_SUMMARY_PROVIDER)
    : undefined;
  const fileConfig = parseConfigRoot(content, providerOverride);
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    invalidType("overrides", overrides, "an object");
  }
  const normalizedOverrides = { ...(overrides as Record<string, unknown>) };
  // Port 0 is an internal runtime/testing escape hatch for ephemeral binding.
  // Persisted configuration must always name a reconnectable TCP port.
  validateKnownConfigSections(normalizedOverrides, {
    allowEphemeralDaemonPort: true,
    allowStorageSecrets: true,
  });
  const overrideLlm = validateLlmObject(normalizedOverrides.llm, providerOverride);
  if (overrideLlm !== undefined) normalizedOverrides.llm = overrideLlm;
  const migratedOverrides = migrateLegacyConfig(normalizedOverrides);

  const fileLlm = fileConfig.llm as Record<string, unknown> | undefined;
  const fileModelProvider = typeof fileLlm?.provider === "string"
    ? normalizeLlmProvider(fileLlm.provider)
    : undefined;
  const hasExplicitFileModel = typeof fileLlm?.model === "string";
  const hasExplicitRuntimeModel = typeof overrideLlm?.model === "string";
  const selectedProvider = providerOverride ?? (
    typeof overrideLlm?.provider === "string"
      ? normalizeLlmProvider(overrideLlm.provider)
      : undefined
  );
  const explicitLlmKeys = new Set([
    ...Object.keys(fileLlm ?? {}),
    ...Object.keys(overrideLlm ?? {}),
  ]);

  // Always merge untrusted sources into a trusted target so DENIED_KEYS filtering
  // applies before any untrusted key reaches the result object.
  const withFile = deepMerge(structuredClone(DEFAULTS) as Record<string, unknown>, fileConfig);
  const mergedRecord = deepMerge(withFile, migratedOverrides);
  mergedRecord.storage = resolveStorageConfig(mergedRecord.storage, env);
  const merged = mergedRecord as DaemonConfig;
  const effectivePolicy = resolveLlmRequestPolicy(
    { requestTimeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS, retry: { ...DEFAULT_LLM_RETRY_POLICY } },
    { requestTimeoutMs: merged.llm.requestTimeoutMs, retry: merged.llm.retry },
  );
  merged.llm.requestTimeoutMs = effectivePolicy.requestTimeoutMs;
  merged.llm.retry = effectivePolicy.retry;
  if (merged.llm.apiKey) merged.llm.apiKey = merged.llm.apiKey.replace(/\$\{(\w+)\}/g, (_: string, k: string) => env[k] ?? "");

  // Runtime models belong to the runtime/environment selection. Only discard
  // a model inherited from a file that explicitly paired it with another
  // selected provider; provider-less file models remain intentionally portable.
  if (
    selectedProvider !== undefined
    && hasExplicitFileModel
    && !hasExplicitRuntimeModel
    && fileModelProvider !== undefined
    && fileModelProvider !== selectedProvider
    && env.LCM_SUMMARY_MODEL === undefined
  ) {
    merged.llm.model = "";
  }

  // Env var override: LCM_SUMMARY_PROVIDER takes precedence over config
  if (providerOverride !== undefined) {
    merged.llm.provider = providerOverride;
    if (providerOverride !== "openai") {
      delete merged.llm.apiMode;
      explicitLlmKeys.delete("apiMode");
    }
    normalizeProviderOverrideRequestPolicyKeys(explicitLlmKeys, providerOverride);
    const transitioningToOpenAI = providerOverride === "openai"
      && fileModelProvider !== undefined
      && fileModelProvider !== providerOverride;
    if (
      merged.llm.reasoningEffort !== undefined
      && (providerOverride !== "openai" || transitioningToOpenAI)
      && !reasoningEffortsForProvider(providerOverride, merged.llm.apiMode).includes(merged.llm.reasoningEffort)
    ) {
      delete merged.llm.reasoningEffort;
      explicitLlmKeys.delete("reasoningEffort");
    }
    if (!supportsFastMode(providerOverride)) {
      merged.llm.fastMode = false;
      explicitLlmKeys.delete("fastMode");
    }
  }
  if (env.LCM_SUMMARY_MODEL !== undefined) {
    merged.llm.model = env.LCM_SUMMARY_MODEL;
  }

  // Migrate old config names to new names for backward compatibility
  const oldNameMap: Record<string, string> = {
    promptHintsByteBudget: "maxInjectedMemoryBytes",
    promptHintsReservedForLearningInstruction: "reservedForLearningInstruction",
    promptHintsMaxEmitted: "maxInjectedMemoryItems",
    promptHintsDedupMinPrefix: "dedupMinPrefix",
  };
  for (const [oldName, newName] of Object.entries(oldNameMap)) {
    const restoration = merged.restoration as Record<string, unknown>;
    if (restoration[oldName] !== undefined) {
      // Only migrate if the new name was not explicitly set by the user
      if (restoration[newName] === (DEFAULTS.restoration as Record<string, unknown>)[newName]) {
        restoration[newName] = restoration[oldName];
      }
      delete restoration[oldName];
    }
  }

  // Anthropic API key fallback from env
  if (!merged.llm.apiKey && merged.llm.provider === "anthropic") {
    merged.llm.apiKey = env.LCM_SUMMARY_API_KEY || env.ANTHROPIC_API_KEY || "";
  }
  if (!merged.llm.apiKey && merged.llm.provider === "openai" && isPublicOpenAIBaseURL(merged.llm.baseUrl)) {
    merged.llm.apiKey = env.LCM_SUMMARY_API_KEY || env.OPENAI_API_KEY || "";
  }

  validateResolvedLlm(merged, explicitLlmKeys);
  return merged;
}

type ConfigLoadTestHooks = Readonly<{
  afterBoundedRead?: (content: string, observedContent: string | null) => void;
}>;

function loadDaemonConfigWithHooks(
  configPath: string,
  overrides?: unknown,
  env?: Record<string, string | undefined>,
  hooks?: ConfigLoadTestHooks,
): DaemonConfig {
  const rawEnv = env ?? process.env;
  const resolvedEnv = resolveDaemonConfigEnv(rawEnv);
  return withBackendPublicationConfigLock(configPath, (lockToken) => {
    let content: string;
    let observedContent: string | null;
    try {
      content = readBoundedRegularFile(configPath, {
        allowedRoot: dirname(configPath),
        maxBytes: MAX_CONFIG_BYTES,
      });
      observedContent = content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      content = "{}";
      observedContent = null;
    }
    hooks?.afterBoundedRead?.(content, observedContent);
    const config = parseDaemonConfig(content, overrides, resolvedEnv);
    assertBackendPublicationConfigAccess(
      configPath,
      config.storage.backend,
      observedContent,
      lockToken,
    );
    return config;
  });
}

export function loadDaemonConfig(configPath: string, overrides?: unknown, env?: Record<string, string | undefined>): DaemonConfig {
  return loadDaemonConfigWithHooks(configPath, overrides, env);
}

/** Internal pure seams used by configuration boundary tests. */
export const __configTestUtils = {
  migrateLegacyPromotionThresholds,
  loadAfterBoundedRead: (
    configPath: string,
    afterBoundedRead: ConfigLoadTestHooks["afterBoundedRead"],
  ): DaemonConfig => loadDaemonConfigWithHooks(configPath, undefined, undefined, { afterBoundedRead }),
};
