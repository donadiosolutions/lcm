import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { lcmPath } from "../runtime-paths.js";

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

export const LLM_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type LlmReasoningEffort = typeof LLM_REASONING_EFFORTS[number];

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
    baseURL: string;
    apiMode?: LlmApiMode;
    reasoningEffort?: LlmReasoningEffort;
  };
  summarizer: { mock: boolean };
  security: SecurityConfig;
  hooks: { snapshotIntervalSec: number; disableAutoCompact: boolean };
};

const DEFAULTS: DaemonConfig = {
  version: 1,
  daemon: { port: 3737, socketPath: lcmPath("daemon.sock"), logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
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
  llm: { provider: "auto", model: "", apiKey: "", baseURL: "" },
  summarizer: { mock: false },
  security: {
    sensitivePatterns: [],
  },
  hooks: { snapshotIntervalSec: 60, disableAutoCompact: false },
};

const DENIED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SYSTEMD_CREDENTIAL_ENV_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LCM_SUMMARY_API_KEY"] as const;
type SystemdCredentialEnvName = typeof SYSTEMD_CREDENTIAL_ENV_NAMES[number];
const SYSTEMD_CREDENTIAL_ENV_NAME_SET = new Set<SystemdCredentialEnvName>(SYSTEMD_CREDENTIAL_ENV_NAMES);

function systemdCredentialDirPrefixes(): string[] {
  const prefixes = ["/run/credentials/"];
  if (typeof process.getuid === "function") {
    prefixes.push(`/run/user/${process.getuid()}/credentials/`);
  }
  return prefixes;
}

function hasTrustedSystemdCredentialPrefix(path: string): boolean {
  return systemdCredentialDirPrefixes().some((prefix) => path.startsWith(prefix));
}

function trustedSystemdCredentialsDir(credentialsDir: string | undefined): string | undefined {
  if (!credentialsDir || !isAbsolute(credentialsDir)) return undefined;
  let realDir: string;
  try {
    realDir = realpathSync(resolve(credentialsDir));
  } catch {
    return undefined;
  }
  return hasTrustedSystemdCredentialPrefix(`${realDir}/`) ? realDir : undefined;
}

function isSystemdCredentialEnvName(name: string): name is SystemdCredentialEnvName {
  return SYSTEMD_CREDENTIAL_ENV_NAME_SET.has(name as SystemdCredentialEnvName);
}

function credentialNamesFromEnv(env: Record<string, string | undefined>): SystemdCredentialEnvName[] {
  return (env.LCM_SYSTEMD_CRED_IDS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(isSystemdCredentialEnvName);
}

function credentialFileName(name: SystemdCredentialEnvName): string {
  switch (name) {
    case "ANTHROPIC_API_KEY":
      return "ANTHROPIC_API_KEY";
    case "OPENAI_API_KEY":
      return "OPENAI_API_KEY";
    case "LCM_SUMMARY_API_KEY":
      return "LCM_SUMMARY_API_KEY";
  }
}

function readSystemdCredentialEnv(env: Record<string, string | undefined>): Record<string, string> {
  const credentialsDir = trustedSystemdCredentialsDir(env.CREDENTIALS_DIRECTORY);
  if (!credentialsDir) return {};
  const credentialEnv: Record<string, string> = {};
  for (const name of credentialNamesFromEnv(env)) {
    let credentialFile: string;
    try {
      credentialFile = realpathSync(resolve(credentialsDir, credentialFileName(name)));
    } catch {
      // Ignore missing credentials; normal env/config validation will report required keys.
      continue;
    }
    if (!hasTrustedSystemdCredentialPrefix(credentialFile)) continue;
    if (!credentialFile.startsWith(`${credentialsDir}/`)) continue;
    try {
      credentialEnv[name] = readFileSync(credentialFile, "utf-8").replace(/\n+$/, "");
    } catch {
      // Ignore missing credentials; normal env/config validation will report required keys.
    }
  }
  return credentialEnv;
}

/** Resolve the environment used for daemon configuration, including trusted systemd credentials. */
export function resolveDaemonConfigEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...readSystemdCredentialEnv(env), ...env };
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
};
const LLM_KEYS = new Set(["provider", "model", "apiKey", "baseURL", "apiMode", "reasoningEffort"]);
const CONFIG_EXAMPLE = JSON.stringify({
  llm: {
    provider: "openai",
    model: "gpt-5",
    apiKey: "${OPENAI_API_KEY}",
    baseURL: "https://api.openai.com/v1",
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
  const key = path.split(".").at(-1) ?? path;
  return /(?:api[-_]?key|token|secret|password|credential)/i.test(key);
}

function sanitizeUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "[REDACTED]";
      url.password = "";
    }
    if (url.search) url.search = "?[REDACTED]";
    if (url.hash) url.hash = "#[REDACTED]";
    return url.toString();
  } catch {
    return value
      .replace(/\/\/[^/@\s]+@/, "//[REDACTED]@")
      .replace(/[?#].*$/, "?[REDACTED]");
  }
}

function displayValue(path: string, value: unknown): string {
  if (isCredentialPath(path)) return '"[REDACTED]"';
  if (path === "llm.baseURL" && typeof value === "string") {
    return JSON.stringify(sanitizeUrlForDisplay(value));
  }
  const serialized = JSON.stringify(value, (key, nestedValue) => {
    if (key && isCredentialPath(key)) return "[REDACTED]";
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

function normalizeProvider(value: string): string {
  return LLM_PROVIDER_ALIASES[value] ?? value;
}

function validateStringField(llm: Record<string, unknown>, key: string): void {
  if (llm[key] !== undefined && typeof llm[key] !== "string") {
    invalidType(`llm.${key}`, llm[key], "a string");
  }
}

function validateLlmObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidType("llm", value, "an object");
  }

  const llm = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(llm)) {
    if (!LLM_KEYS.has(key)) {
      throw new ConfigValidationError(
        `llm.${key}`,
        `unknown key ${JSON.stringify(key)} with ${valueType(llm[key])} value ${displayValue(`llm.${key}`, llm[key])}; valid keys: ${[...LLM_KEYS].join(", ")}`,
      );
    }
  }

  for (const key of ["provider", "model", "apiKey", "baseURL", "apiMode", "reasoningEffort"]) {
    validateStringField(llm, key);
  }

  if (typeof llm.provider === "string") {
    const provider = normalizeProvider(llm.provider);
    llm.provider = provider;
    if (!(CANONICAL_LLM_PROVIDERS as readonly string[]).includes(provider)) {
      throw new ConfigValidationError(
        "llm.provider",
        `received ${displayValue("llm.provider", llm.provider)}; valid choices: ${CANONICAL_LLM_PROVIDERS.join(", ")}`,
      );
    }
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

function parseConfigRoot(content: string): Record<string, unknown> {
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
  const llm = validateLlmObject(root.llm);
  if (llm !== undefined) root.llm = llm;
  return root;
}

function requireNonEmpty(value: string, path: string, provider: LlmProvider): void {
  if (value.trim() === "") {
    throw new ConfigValidationError(
      path,
      `expected a non-empty string when llm.provider is ${JSON.stringify(provider)}, received string ${displayValue(path, value)}`,
    );
  }
}

function validateResolvedLlm(merged: DaemonConfig, explicitlyConfigured: ReadonlySet<string>): void {
  const { llm } = merged;
  if (llm.provider === "anthropic") {
    requireNonEmpty(llm.model, "llm.model", llm.provider);
    requireNonEmpty(llm.apiKey ?? "", "llm.apiKey", llm.provider);
  }

  if (llm.provider === "openai") {
    requireNonEmpty(llm.model, "llm.model", llm.provider);
    requireNonEmpty(llm.baseURL, "llm.baseURL", llm.provider);
    let baseURL: URL;
    try {
      baseURL = new URL(llm.baseURL);
    } catch {
      throw new ConfigValidationError("llm.baseURL", `expected an absolute HTTP(S) URL, received string ${displayValue("llm.baseURL", llm.baseURL)}`);
    }
    if (!(["http:", "https:"] as const).includes(baseURL.protocol as "http:" | "https:")) {
      throw new ConfigValidationError("llm.baseURL", `expected an absolute HTTP(S) URL, received string ${displayValue("llm.baseURL", llm.baseURL)}`);
    }
    const normalizedHostname = baseURL.hostname.toLowerCase().replace(/\.+$/, "");
    if (normalizedHostname === "api.openai.com") {
      requireNonEmpty(llm.apiKey ?? "", "llm.apiKey", llm.provider);
    }
    llm.apiMode ??= "chat-completions";
  } else {
    for (const key of ["apiMode", "reasoningEffort"] as const) {
      if (explicitlyConfigured.has(key)) {
        throw new ConfigValidationError(
          `llm.${key}`,
          `is only valid when llm.provider is "openai" and llm.apiMode is "responses"`,
        );
      }
    }
  }

  if (llm.reasoningEffort !== undefined && llm.apiMode !== "responses") {
    throw new ConfigValidationError(
      "llm.reasoningEffort",
      `requires llm.provider "openai" and llm.apiMode "responses"; current apiMode is ${JSON.stringify(llm.apiMode)}`,
    );
  }
}

/** Parse, merge, resolve, and validate daemon configuration without filesystem access. */
export function parseDaemonConfig(
  content: string,
  overrides: unknown = {},
  env: Record<string, string | undefined> = {},
): DaemonConfig {
  const fileConfig = parseConfigRoot(content);
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    invalidType("overrides", overrides, "an object");
  }
  const normalizedOverrides = { ...(overrides as Record<string, unknown>) };
  const overrideLlm = validateLlmObject(normalizedOverrides.llm);
  if (overrideLlm !== undefined) normalizedOverrides.llm = overrideLlm;

  const fileLlm = fileConfig.llm as Record<string, unknown> | undefined;
  const explicitLlmKeys = new Set([
    ...Object.keys(fileLlm ?? {}),
    ...Object.keys(overrideLlm ?? {}),
  ]);

  // Always merge untrusted sources into a trusted target so DENIED_KEYS filtering
  // applies before any untrusted key reaches the result object.
  const withFile = deepMerge(structuredClone(DEFAULTS) as Record<string, unknown>, fileConfig);
  const merged = deepMerge(withFile, normalizedOverrides) as DaemonConfig;
  // Migrate legacy mergeMaxEntries (renamed to dedupCandidateLimit)
  const thresholds = merged.compaction.promotionThresholds as Record<string, unknown>;
  if (thresholds["mergeMaxEntries"] !== undefined && thresholds["dedupCandidateLimit"] === undefined) {
    thresholds["dedupCandidateLimit"] = thresholds["mergeMaxEntries"];
  }
  delete thresholds["mergeMaxEntries"];
  delete thresholds["confidenceDecayRate"];
  if (merged.llm.apiKey) merged.llm.apiKey = merged.llm.apiKey.replace(/\$\{(\w+)\}/g, (_: string, k: string) => env[k] ?? "");

  // Env var override: LCM_SUMMARY_PROVIDER takes precedence over config
  if (env.LCM_SUMMARY_PROVIDER) {
    const normalized = normalizeProvider(env.LCM_SUMMARY_PROVIDER);
    if (!(CANONICAL_LLM_PROVIDERS as readonly string[]).includes(normalized)) {
      throw new ConfigValidationError(
        "LCM_SUMMARY_PROVIDER",
        `received ${JSON.stringify(env.LCM_SUMMARY_PROVIDER)}; valid choices: ${CANONICAL_LLM_PROVIDERS.join(", ")}`,
      );
    }
    merged.llm.provider = normalized as LlmProvider;
    if (normalized !== "openai") {
      delete merged.llm.apiMode;
      delete merged.llm.reasoningEffort;
      explicitLlmKeys.delete("apiMode");
      explicitLlmKeys.delete("reasoningEffort");
    }
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
  if (!merged.llm.apiKey && merged.llm.provider === "openai") {
    merged.llm.apiKey = env.LCM_SUMMARY_API_KEY || env.OPENAI_API_KEY || "";
  }

  validateResolvedLlm(merged, explicitLlmKeys);
  return merged;
}

export function loadDaemonConfig(configPath: string, overrides?: unknown, env?: Record<string, string | undefined>): DaemonConfig {
  const rawEnv = env ?? process.env;
  const resolvedEnv = resolveDaemonConfigEnv(rawEnv);
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    content = "{}";
  }
  return parseDaemonConfig(content, overrides, resolvedEnv);
}
