import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
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

const DENIED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const REDACTED = "[REDACTED]";
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

function readConfigContent(configPath: string): string {
  try {
    return readFileSync(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
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
  const segments = parseConfigPath(options.path);
  const path = segments.join(".");
  const content = readConfigContent(options.configPath);
  const config = options.effective
    ? parseDaemonConfig(content, {}, resolveDaemonConfigEnv(options.env ?? process.env))
    : parseStoredConfig(content);
  return maskConfigSecrets(valueAtPath(config, segments, path), segments);
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

function writeConfigAtomic(configPath: string, content: string): void {
  const directory = dirname(configPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempDirectory = mkdtempSync(join(directory, ".lcm-config-"));
  const tempPath = join(tempDirectory, "config.json");
  try {
    writeFileSync(tempPath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, configPath);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

/** Set, fully validate, normalize, and atomically persist a configuration value. */
export function setConfigValue(options: SetConfigValueOptions): unknown {
  const segments = parseConfigPath(options.path);
  const path = segments.join(".");
  const content = readConfigContent(options.configPath);
  const stored = structuredClone(parseStoredConfig(content));
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
  writeConfigAtomic(options.configPath, `${JSON.stringify(canonical, null, 2)}\n`);
  return maskConfigSecrets(valueAtPath(canonical, segments, path), segments);
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
