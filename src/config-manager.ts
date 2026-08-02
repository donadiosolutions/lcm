import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  normalizeLlmProvider,
  parseDaemonConfig,
  parseStoredConfig,
  reasoningEffortsForProvider,
  resolveDaemonConfigEnv,
  supportsFastMode,
  supportsRequestTimeout,
  type LlmApiMode,
  type LlmProvider,
  type LlmReasoningEffort,
} from "./daemon/config.js";
import { isSensitiveKey } from "./secret-key.js";
import { sanitizeUrlValueForDisplay } from "./url-display.js";
import { lcmHomeDir } from "./runtime-paths.js";
import { atomicWritePrivateFile, readBoundedRegularFile } from "./security-files.js";
import {
  assertBackendPublicationConfigAccess,
  assertBackendPublicationConfigMutation,
  assertBackendPublicationConsumerAccess,
  backendPublicationHomeForConfigPath,
  captureBackendPublicationState,
  withBackendPublicationConfigLock,
  type BackendPublicationFileMutationContext,
  type BackendPublicationFileWitness,
} from "./storage/backend-publication.js";

const DENIED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const REDACTED = "[REDACTED]";
const MAX_CONFIG_BYTES = 1024 * 1024;
const OPENAI_ONLY_LLM_KEYS = [
  "apiMode",
  "retry",
] as const;
const CONFIG_PATH_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["llm.baseURL", ["llm", "baseUrl"]],
  [
    "compaction.promotionThresholds.mergeMaxEntries",
    ["compaction", "promotionThresholds", "dedupCandidateLimit"],
  ],
]);

export type ConfigValueOptions = {
  configPath: string;
  path: string;
  env?: Record<string, string | undefined>;
};

export type GetConfigValueOptions = ConfigValueOptions & {
  effective?: boolean;
};

export type SetConfigValueOptions = ConfigValueOptions & {
  value: string;
  json?: boolean;
};

export class ConfigManagerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigManagerError";
  }
}

/** Parse and canonicalize a dotted configuration path. */
export function parseConfigPath(path: string): string[] {
  const segments = path.split(".");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new ConfigManagerError("Configuration paths must contain non-empty dotted segments.");
  }
  for (const segment of segments) {
    if (segment.trim() !== segment) {
      throw new ConfigManagerError(
        "Configuration path segments must not contain leading or trailing whitespace.",
      );
    }
    if (DENIED_PATH_SEGMENTS.has(segment)) {
      throw new ConfigManagerError(`Configuration path contains forbidden segment ${JSON.stringify(segment)}.`);
    }
  }
  const aliasedSegments = CONFIG_PATH_ALIASES.get(segments.join("."));
  return aliasedSegments === undefined ? segments : [...aliasedSegments];
}

function canonicalPath(path: string): string {
  return parseConfigPath(path).join(".");
}

type ConfigFileState = {
  readonly content: string;
  readonly observedContent: string | null;
};

function readConfigContent(configPath: string): ConfigFileState {
  try {
    const content = readBoundedRegularFile(configPath, {
      allowedRoot: dirname(configPath),
      maxBytes: MAX_CONFIG_BYTES,
    });
    return { content, observedContent: content };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "{}", observedContent: null };
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAtPath(root: unknown, segments: readonly string[], path: string): unknown {
  let current = root;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new ConfigManagerError(`Configuration path ${JSON.stringify(path)} does not exist.`);
    }
    current = current[segment];
  }
  return current;
}

function isSecretPath(segments: readonly string[]): boolean {
  return segments.some(isSensitiveKey) || segments.join(".") === "storage.postgresql.url";
}

/** Recursively redact secret-like keys. The supplied path protects scalar secret reads too. */
export function maskConfigSecrets(value: unknown, path: readonly string[] = []): unknown {
  if (isSecretPath(path)) return REDACTED;
  if (typeof value === "string") return sanitizeUrlValueForDisplay(value, path.at(-1));
  if (Array.isArray(value)) {
    return value.map((entry) => maskConfigSecrets(entry, path));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, maskConfigSecrets(entry, [...path, key])]),
    );
  }
  return value;
}

/** Get a stored normalized value, or an effective defaults/env-resolved value. */
export function getConfigValue(options: GetConfigValueOptions): unknown {
  return withBackendPublicationConfigLock(options.configPath, () => {
    const publicationHome = backendPublicationHomeForConfigPath(options.configPath);
    if (publicationHome !== undefined) {
      assertBackendPublicationConsumerAccess({ homeDir: publicationHome });
    }
    const segments = parseConfigPath(options.path);
    const path = segments.join(".");
    const { content, observedContent } = readConfigContent(options.configPath);
    const config = options.effective
      ? parseDaemonConfig(content, {}, resolveDaemonConfigEnv(options.env ?? process.env))
      : parseStoredConfig(content);
    const backend = (
      config.storage as { backend?: "sqlite" | "postgresql" } | undefined
    )?.backend ?? "sqlite";
    assertBackendPublicationConfigAccess(
      options.configPath,
      backend,
      observedContent,
    );
    return maskConfigSecrets(valueAtPath(config, segments, path), segments);
  });
}

/** Parse a CLI value as a string by default or as a JSON value when requested. */
export function parseConfigValue(value: string, json = false): unknown {
  if (!json) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigManagerError(`Invalid JSON configuration value (${detail}).`, { cause: error });
  }
}

function setAtPath(root: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!Object.hasOwn(current, segment)) {
      const child: Record<string, unknown> = {};
      current[segment] = child;
      current = child;
      continue;
    }
    const child = current[segment];
    if (!isRecord(child)) {
      throw new ConfigManagerError(
        `Cannot traverse configuration path through non-object segment ${JSON.stringify(segment)}.`,
      );
    }
    current = child;
  }
  current[segments.at(-1)!] = value;
}

/** Remove settings that are incompatible with an intentional provider transition. */
function canonicalizeLlmProviderTransition(
  root: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  if (
    segments.length !== 2
    || segments[0] !== "llm"
    || segments[1] !== "provider"
    || typeof value !== "string"
  ) {
    return;
  }
  // setAtPath has just established llm as an object for this exact path.
  const llm = root.llm as Record<string, unknown>;
  const provider = normalizeLlmProvider(value) as LlmProvider;
  if (provider !== "openai") {
    for (const key of OPENAI_ONLY_LLM_KEYS) delete llm[key];
  }
  if (!supportsRequestTimeout(provider)) delete llm.requestTimeoutMs;
  const apiMode = typeof llm.apiMode === "string" ? llm.apiMode as LlmApiMode : undefined;
  const reasoningEffort = llm.reasoningEffort;
  if (
    typeof reasoningEffort === "string"
    && !reasoningEffortsForProvider(provider, apiMode).includes(reasoningEffort as LlmReasoningEffort)
  ) {
    delete llm.reasoningEffort;
  }
  if (!supportsFastMode(provider)) delete llm.fastMode;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeConfigAtomic(configPath: string, content: string): void {
  const directory = dirname(configPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWritePrivateFile(configPath, content);
  syncDirectory(directory);
}

function storedBackend(content: string): "sqlite" | "postgresql" {
  const stored = parseStoredConfig(content);
  return (
    stored.storage as { backend?: "sqlite" | "postgresql" } | undefined
  )?.backend ?? "sqlite";
}

function recoveryConfigContent(
  input: BackendPublicationFileMutationContext,
): string | null {
  if (input.file.presence === "absent") return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input.file.content);
  } catch (error) {
    throw new ConfigManagerError("Backend publication config material is not UTF-8.", {
      cause: error,
    });
  }
}

/**
 * Publish or restore the exact canonical config state supplied by a guarded
 * BackendPublicationCoordinator callback.
 */
export async function applyBackendPublicationConfigFile(
  input: BackendPublicationFileMutationContext,
): Promise<BackendPublicationFileWitness> {
  const configPath = join(lcmHomeDir(input.homeDir), "config.json");
  return withBackendPublicationConfigLock(configPath, () => {
    const current = readConfigContent(configPath);
    const candidateContent = recoveryConfigContent(input);
    const currentBackend = storedBackend(current.content);
    const candidateBackend = storedBackend(candidateContent ?? "{}");
    assertBackendPublicationConfigMutation(
      configPath,
      currentBackend,
      candidateBackend,
      candidateContent,
      current.observedContent,
    );
    if (input.file.presence === "absent") {
      rmSync(configPath, { force: true });
      syncDirectory(dirname(configPath));
    } else {
      writeConfigAtomic(configPath, candidateContent!);
    }
    return captureBackendPublicationState(input.homeDir).config;
  });
}

/** Set, fully validate, normalize, and atomically persist a configuration value. */
export function setConfigValue(options: SetConfigValueOptions): unknown {
  return withBackendPublicationConfigLock(options.configPath, () => {
    const publicationHome = backendPublicationHomeForConfigPath(options.configPath);
    if (publicationHome !== undefined) {
      assertBackendPublicationConsumerAccess({ homeDir: publicationHome });
    }
    const segments = parseConfigPath(options.path);
    const path = segments.join(".");
    const { content, observedContent } = readConfigContent(options.configPath);
    const stored = structuredClone(parseStoredConfig(content));
    const selectedBackend = (
      stored.storage as { backend?: "sqlite" | "postgresql" } | undefined
    )?.backend ?? "sqlite";
    assertBackendPublicationConfigAccess(
      options.configPath,
      selectedBackend,
      observedContent,
    );
    const value = parseConfigValue(options.value, options.json);
    setAtPath(stored, segments, value);
    canonicalizeLlmProviderTransition(stored, segments, value);

    const candidateContent = JSON.stringify(stored);
    const env = resolveDaemonConfigEnv(options.env ?? process.env);
    const persistedValidationEnv = { ...env };
    delete persistedValidationEnv.LCM_SUMMARY_PROVIDER;
    delete persistedValidationEnv.LCM_SUMMARY_MODEL;
    parseDaemonConfig(candidateContent, {}, persistedValidationEnv);
    const canonical = parseStoredConfig(candidateContent);
    const candidateBackend = (
      canonical.storage as { backend?: "sqlite" | "postgresql" } | undefined
    )?.backend ?? "sqlite";
    const persistedContent = `${JSON.stringify(canonical, null, 2)}\n`;
    assertBackendPublicationConfigMutation(
      options.configPath,
      selectedBackend,
      candidateBackend,
      persistedContent,
      observedContent,
    );
    writeConfigAtomic(options.configPath, persistedContent);
    return maskConfigSecrets(valueAtPath(canonical, segments, path), segments);
  });
}

/** Render a value for CLI output without adding quoting around scalar strings. */
export function formatConfigValue(value: unknown): string {
  if (typeof value === "string") return value;
  const formatted = JSON.stringify(value, null, 2);
  return formatted === undefined ? String(value) : formatted;
}

/** Return the canonical dotted spelling used for display and persistence. */
export function normalizeConfigPath(path: string): string {
  return canonicalPath(path);
}
