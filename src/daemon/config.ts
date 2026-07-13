import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { lcmPath } from "../runtime-paths.js";
import { sanitizeUrlForDisplay } from "../url-display.js";

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

export const LLM_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type LlmReasoningEffort = typeof LLM_REASONING_EFFORTS[number];

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
    baseUrl: string;
    apiMode?: LlmApiMode;
    reasoningEffort?: LlmReasoningEffort;
    requestTimeoutMs: number;
    retry: LlmRetryPolicy;
  };
  summarizer: { mock: boolean };
  security: SecurityConfig;
  hooks: { snapshotIntervalSec: number; disableAutoCompact: boolean };
};

const DEFAULTS: DaemonConfig = {
  version: 1,
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
  custom: "openai",
  "openai-compatible": "openai",
};
const LLM_KEYS = new Set([
  "provider", "model", "apiKey", "baseUrl", "baseURL", "apiMode", "reasoningEffort",
  "requestTimeoutMs", "retry",
]);
const CONFIG_EXAMPLE = JSON.stringify({
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
  const key = path.split(".").at(-1) ?? path;
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
  options: { allowEphemeralDaemonPort?: boolean } = {},
): void {
  if (config.version !== undefined) validateBoundedInteger("version", config.version, 1, Number.MAX_SAFE_INTEGER);
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
  return root;
}

/** Parse and normalize stored configuration without applying defaults or environment values. */
export function parseStoredConfig(content: string): Record<string, unknown> {
  return parseConfigRoot(content);
}

/**
 * Convert effective daemon configuration back to a safe persisted document.
 * OpenAI request policy defaults remain effective at runtime but are explicit
 * configuration only when the persisted provider is OpenAI-compatible.
 */
export function daemonConfigForPersistence(config: DaemonConfig): Record<string, unknown> {
  const stored = structuredClone(config) as unknown as Record<string, unknown>;
  const llm = stored.llm as Record<string, unknown>;
  if (llm.provider !== "openai") {
    delete llm.requestTimeoutMs;
    delete llm.retry;
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

function validateResolvedLlm(merged: DaemonConfig, explicitlyConfigured: ReadonlySet<string>): void {
  const { llm } = merged;
  if (llm.provider === "anthropic") {
    requireNonEmpty(llm.model, "llm.model", llm.provider);
    requireNonEmpty(llm.apiKey ?? "", "llm.apiKey", llm.provider);
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
      requireNonEmpty(llm.apiKey ?? "", "llm.apiKey", llm.provider);
    }
    llm.apiMode ??= "chat-completions";
  } else {
    if (explicitlyConfigured.has("apiMode")) {
      throw new ConfigValidationError(
        "llm.apiMode",
        `is only valid when llm.provider is "openai"`,
      );
    }
    if (explicitlyConfigured.has("reasoningEffort")) {
      throw new ConfigValidationError(
        "llm.reasoningEffort",
        `is only valid when llm.provider is "openai" and llm.apiMode is "responses"`,
      );
    }
    if (explicitlyConfigured.has("requestTimeoutMs") || explicitlyConfigured.has("retry")) {
      throw new ConfigValidationError(
        explicitlyConfigured.has("requestTimeoutMs") ? "llm.requestTimeoutMs" : "llm.retry",
        `is only valid when llm.provider is "openai"`,
      );
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
  validateKnownConfigSections(normalizedOverrides, { allowEphemeralDaemonPort: true });
  const overrideLlm = validateLlmObject(normalizedOverrides.llm, providerOverride);
  if (overrideLlm !== undefined) normalizedOverrides.llm = overrideLlm;

  const fileLlm = fileConfig.llm as Record<string, unknown> | undefined;
  const fileModelProvider = typeof fileLlm?.provider === "string"
    ? normalizeLlmProvider(fileLlm.provider)
    : undefined;
  const hasExplicitFileModel = typeof fileLlm?.model === "string";
  const hasExplicitRuntimeModel = typeof overrideLlm?.model === "string";
  const explicitLlmKeys = new Set([
    ...Object.keys(fileLlm ?? {}),
    ...Object.keys(overrideLlm ?? {}),
  ]);

  // Always merge untrusted sources into a trusted target so DENIED_KEYS filtering
  // applies before any untrusted key reaches the result object.
  const withFile = deepMerge(structuredClone(DEFAULTS) as Record<string, unknown>, fileConfig);
  const merged = deepMerge(withFile, normalizedOverrides) as DaemonConfig;
  const effectivePolicy = resolveLlmRequestPolicy(
    { requestTimeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS, retry: { ...DEFAULT_LLM_RETRY_POLICY } },
    { requestTimeoutMs: merged.llm.requestTimeoutMs, retry: merged.llm.retry },
  );
  merged.llm.requestTimeoutMs = effectivePolicy.requestTimeoutMs;
  merged.llm.retry = effectivePolicy.retry;
  // Migrate legacy mergeMaxEntries (renamed to dedupCandidateLimit)
  const thresholds = merged.compaction.promotionThresholds as Record<string, unknown>;
  if (thresholds["mergeMaxEntries"] !== undefined && thresholds["dedupCandidateLimit"] === undefined) {
    thresholds["dedupCandidateLimit"] = thresholds["mergeMaxEntries"];
  }
  delete thresholds["mergeMaxEntries"];
  delete thresholds["confidenceDecayRate"];
  if (merged.llm.apiKey) merged.llm.apiKey = merged.llm.apiKey.replace(/\$\{(\w+)\}/g, (_: string, k: string) => env[k] ?? "");

  // Env var override: LCM_SUMMARY_PROVIDER takes precedence over config
  if (providerOverride !== undefined) {
    merged.llm.provider = providerOverride;
    // Runtime models belong to the runtime/environment selection. Only discard
    // a model inherited from a file that explicitly paired it with another
    // provider; provider-less file models remain intentionally portable.
    if (
      hasExplicitFileModel
      && !hasExplicitRuntimeModel
      && fileModelProvider !== undefined
      && fileModelProvider !== providerOverride
      && env.LCM_SUMMARY_MODEL === undefined
    ) {
      merged.llm.model = "";
    }
    if (providerOverride !== "openai") {
      delete merged.llm.apiMode;
      delete merged.llm.reasoningEffort;
      explicitLlmKeys.delete("apiMode");
      explicitLlmKeys.delete("reasoningEffort");
      explicitLlmKeys.delete("requestTimeoutMs");
      explicitLlmKeys.delete("retry");
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
