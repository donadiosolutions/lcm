import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  normalizeLlmProvider,
  daemonConfigSnapshotWitnessEqual,
  parseDaemonConfig,
  parseStoredConfig,
  reasoningEffortsForProvider,
  resolveDaemonConfigEnv,
  supportsFastMode,
  supportsRequestTimeout,
  type LlmApiMode,
  type LlmProvider,
  type LlmReasoningEffort,
  type DaemonConfigSnapshotWitness,
} from "./daemon/config.js";
import { isSensitiveKey } from "./secret-key.js";
import { sanitizeUrlValueForDisplay } from "./url-display.js";
import { lcmHomeDir } from "./runtime-paths.js";
import {
  assertBackendPublicationConfigAccess,
  assertBackendPublicationConfigReadAccess,
  assertBackendPublicationConfigMutation,
  assertBackendPublicationPermit,
  captureBackendPublicationState,
  withBackendPublicationConfigLockAsync,
  withBackendPublicationConfigLock,
  type BackendPublicationFileMutationContext,
  type BackendPublicationFileWitness,
  type BackendPublicationRecoveryFile,
} from "./storage/backend-publication.js";
import {
  atomicWritePrivateFileDurable,
  consumeBoundedRegularFile,
  ensurePrivateDirectory,
  readBoundedRegularFile,
  readBoundedRegularFileWithStat,
  syncPrivateDirectory,
  OWNER_ONLY_FILE_MODES,
} from "./security-files.js";
import type { ConnectorTransport } from "./connectors/types.js";

const DENIED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const REDACTED = "[REDACTED]";
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
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

function readConfigContent(configPath: string): {
  readonly content: string;
  readonly observedContent: string | null;
} {
  try {
    const content = readBoundedRegularFile(configPath, {
      allowedRoot: dirname(configPath),
      maxBytes: MAX_CONFIG_BYTES,
      allowedModes: OWNER_ONLY_FILE_MODES,
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
  return withBackendPublicationConfigLock(options.configPath, (lockToken) => {
    const segments = parseConfigPath(options.path);
    const path = segments.join(".");
    const file = readConfigContent(options.configPath);
    const config = options.effective
      ? parseDaemonConfig(file.content, {}, resolveDaemonConfigEnv(options.env ?? process.env))
      : parseStoredConfig(file.content);
    const backend = (
      config.storage as { backend?: string } | undefined
    )?.backend;
    assertBackendPublicationConfigAccess(
      options.configPath,
      backend === "postgresql" ? "postgresql" : "sqlite",
      file.observedContent,
      undefined,
      lockToken,
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

function writeConfigAtomic(
  configPath: string,
  content: string,
  observedContent: string | null = null,
): void {
  const directory = dirname(configPath);
  ensurePrivateDirectory(directory);
  atomicWritePrivateFileDurable(configPath, content, {
    expectedContentSha256: observedContent === null
      ? null
      : createHash("sha256").update(observedContent).digest("hex"),
    maxExistingBytes: MAX_CONFIG_BYTES,
    requireAbsent: observedContent === null,
    finalMode: 0o600,
  });
  syncPrivateDirectory(directory);
}

function configBackend(content: string): "sqlite" | "postgresql" {
  const stored = parseStoredConfig(content);
  return (
    stored.storage as { backend?: string } | undefined
  )?.backend === "postgresql" ? "postgresql" : "sqlite";
}

function configWitnessMatches(
  actual: BackendPublicationFileWitness,
  expected: BackendPublicationFileWitness,
  requireDescriptorIdentity = true,
): boolean {
  for (const field of ["presence", "rawSha256", "semanticSha256", "byteLength", "mode", "uid", "gid", "nlink"] as const) {
    if (actual[field] !== expected[field]) return false;
  }
  return !requireDescriptorIdentity || (["dev", "ino", "parentDev", "parentIno"] as const).every((field) =>
    expected[field] === null || actual[field] === expected[field]);
}

function recoveryConfigContent(input: BackendPublicationFileMutationContext): string | null {
  if (input.file.presence === "absent") return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input.file.content);
  } catch (error) {
    throw new ConfigManagerError("Backend publication config material is not UTF-8.", { cause: error });
  }
}

function expectedConfigBeforeWitness(input: BackendPublicationFileMutationContext): BackendPublicationFileWitness {
  if (input.mutationAccess === "publish-config") return input.journal.sourceState.config;
  if (input.mutationAccess === "restore-config") return input.journal.targetState.config;
  throw new ConfigManagerError("Invalid coordinator access for config publication: " + input.mutationAccess);
}

/** Apply exact authenticated config bytes from a coordinator permit. */
export async function applyBackendPublicationConfigFile(
  input: BackendPublicationFileMutationContext,
): Promise<BackendPublicationFileWitness> {
  assertBackendPublicationPermit(input.permit, input.homeDir, input.journal);
  const configPath = join(lcmHomeDir(input.homeDir), "config.json");
  return withBackendPublicationConfigLockAsync(configPath, async () => {
    const current = readConfigContent(configPath);
    const before = captureBackendPublicationState(input.homeDir).config;
    if (!configWitnessMatches(
      before,
      expectedConfigBeforeWitness(input),
      input.mutationAccess !== "restore-config",
    )) {
      throw new ConfigManagerError("Configuration changed before coordinator publication.");
    }
    const candidateContent = recoveryConfigContent(input);
    const currentBackend = configBackend(current.content);
    const candidateBackend = configBackend(candidateContent ?? "{}");
    assertBackendPublicationConfigMutation(
      configPath,
      currentBackend,
      candidateBackend,
      candidateContent,
      current.observedContent,
      input.permit,
    );
    if (candidateContent === null) {
      if (before.presence === "present") {
        consumeBoundedRegularFile(configPath, {
          allowedRoot: dirname(configPath),
          maxBytes: 4 * 1024 * 1024,
          expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
          allowedModes: OWNER_ONLY_FILE_MODES,
          requireSingleLink: true,
          expectedRawSha256: before.rawSha256,
        });
        syncPrivateDirectory(dirname(configPath));
      }
    } else {
      const recoveryFile = input.file as Extract<BackendPublicationRecoveryFile, { presence: "present" }>;
      atomicWritePrivateFileDurable(configPath, candidateContent, {
        requireAbsent: before.presence === "absent",
        expectedContentSha256: before.presence === "present" ? before.rawSha256 : null,
        maxExistingBytes: 4 * 1024 * 1024,
        finalMode: recoveryFile.mode,
      });
      syncPrivateDirectory(dirname(configPath));
    }
    const after = captureBackendPublicationState(input.homeDir).config;
    if (!configWitnessMatches(after, input.expectedWitness, false)) {
      throw new ConfigManagerError("Configuration does not match authenticated coordinator witness after publication.");
    }
    return after;
  }, input.permit);
}

/** Set, fully validate, normalize, and atomically persist a configuration value. */
export function setConfigValue(options: SetConfigValueOptions): unknown {
  return withBackendPublicationConfigLock(options.configPath, (lockToken) => {
    const segments = parseConfigPath(options.path);
    const path = segments.join(".");
    const file = readConfigContent(options.configPath);
    const stored = structuredClone(parseStoredConfig(file.content));
    const currentBackend = (
      stored.storage as { backend?: string } | undefined
    )?.backend === "postgresql" ? "postgresql" : "sqlite";
    assertBackendPublicationConfigAccess(
      options.configPath,
      currentBackend,
      file.observedContent,
      undefined,
      lockToken,
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
      canonical.storage as { backend?: string } | undefined
    )?.backend === "postgresql" ? "postgresql" : "sqlite";
    const persistedContent = `${JSON.stringify(canonical, null, 2)}\n`;
    assertBackendPublicationConfigMutation(
      options.configPath,
      currentBackend,
      candidateBackend,
      persistedContent,
      file.observedContent,
      undefined,
      lockToken,
    );
    writeConfigAtomic(options.configPath, persistedContent, file.observedContent);
    return maskConfigSecrets(valueAtPath(canonical, segments, path), segments);
  });
}

const CONNECTOR_TRANSPORT_VALUES = new Set<ConnectorTransport>(["cli", "mcp"]);

function connectorTransportValue(value: unknown, path: string): ConnectorTransport {
  if (typeof value !== "string" || !CONNECTOR_TRANSPORT_VALUES.has(value as ConnectorTransport)) {
    throw new ConfigManagerError(`${path} must be one of "cli" or "mcp".`);
  }
  return value as ConnectorTransport;
}

function readConnectorTransportFromStored(
  stored: Record<string, unknown>,
  agentId: string,
): ConnectorTransport | undefined {
  const transports = connectorTransportsFromStored(stored);
  if (transports === undefined) return undefined;
  const value = transports[agentId];
  return value === undefined
    ? undefined
    : connectorTransportValue(value, `connectors.transports.${agentId}`);
}

function connectorTransportsFromStored(
  stored: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const connectors = stored.connectors;
  if (connectors === undefined) return undefined;
  if (!isRecord(connectors)) throw new ConfigManagerError("connectors must be an object.");
  const transports = connectors.transports;
  if (transports === undefined) return undefined;
  if (!isRecord(transports)) throw new ConfigManagerError("connectors.transports must be an object.");
  for (const [storedAgentId, value] of Object.entries(transports)) {
    connectorTransportValue(value, `connectors.transports.${storedAgentId}`);
  }
  return transports;
}

function persistConnectorTransportConfig(
  configPath: string,
  stored: Record<string, unknown>,
  file: { readonly observedContent: string | null },
  currentBackend: "sqlite" | "postgresql",
  lockToken: Parameters<typeof assertBackendPublicationConfigAccess>[4],
): void {
  const candidateContent = JSON.stringify(stored);
  const env = resolveDaemonConfigEnv({});
  delete env.LCM_SUMMARY_PROVIDER;
  delete env.LCM_SUMMARY_MODEL;
  parseDaemonConfig(candidateContent, {}, env);
  const canonical = parseStoredConfig(candidateContent);
  const persistedContent = `${JSON.stringify(canonical, null, 2)}\n`;
  const candidateBackend = configBackend(candidateContent);
  assertBackendPublicationConfigMutation(
    configPath,
    currentBackend,
    candidateBackend,
    persistedContent,
    file.observedContent,
    undefined,
    lockToken,
  );
  writeConfigAtomic(configPath, persistedContent, file.observedContent);
}

/** Read one validated stored connector transport under the configuration lock. */
export function readConnectorTransport(configPath: string, agentId: string): ConnectorTransport | undefined {
  return withBackendPublicationConfigLock(configPath, (lockToken) => {
    const file = readConfigContent(configPath);
    const stored = parseStoredConfig(file.content);
    const backend = configBackend(file.content);
    assertBackendPublicationConfigAccess(configPath, backend, file.observedContent, undefined, lockToken);
    return readConnectorTransportFromStored(stored, agentId);
  });
}

type ConnectorTransportSnapshotOptions = Readonly<{
  /** @internal Deterministic config-drift seam for tests. */
  _afterFirstSnapshotForTesting?: () => void;
}>;

type ConnectorConfigSnapshot = Readonly<{
  content: string;
  witness: DaemonConfigSnapshotWitness;
}>;

function readConnectorConfigSnapshot(configPath: string): ConnectorConfigSnapshot {
  let initiallyPresent = false;
  try {
    lstatSync(configPath);
    initiallyPresent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const observed = readBoundedRegularFileWithStat(configPath, {
      allowedRoot: dirname(configPath),
      maxBytes: MAX_CONFIG_BYTES,
      allowedModes: OWNER_ONLY_FILE_MODES,
    });
    return {
      content: observed.content,
      witness: {
        presence: "present",
        rawSha256: createHash("sha256").update(observed.content).digest("hex"),
        byteLength: Buffer.byteLength(observed.content),
        dev: observed.exactDev,
        ino: observed.exactIno,
        mtimeMs: observed.mtimeMs,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || initiallyPresent) throw error;
    return {
      content: "{}",
      witness: {
        presence: "absent",
        rawSha256: null,
        byteLength: 0,
        dev: null,
        ino: null,
        mtimeMs: null,
      },
    };
  }
}

/** Read one validated stored connector transport without taking the publication lock. */
export function readConnectorTransportSnapshot(
  configPath: string,
  agentId: string,
  options: ConnectorTransportSnapshotOptions = {},
): ConnectorTransport | undefined {
  const first = readConnectorConfigSnapshot(configPath);
  const backend = configBackend(first.content);
  assertBackendPublicationConfigReadAccess(configPath, backend, first.witness);
  options._afterFirstSnapshotForTesting?.();
  const second = readConnectorConfigSnapshot(configPath);
  if (!daemonConfigSnapshotWitnessEqual(first.witness, second.witness)) {
    throw new ConfigManagerError("Configuration changed during lock-free connector transport inspection.");
  }
  return readConnectorTransportFromStored(parseStoredConfig(second.content), agentId);
}

/** Persist one validated connector transport while retaining all other settings. */
export function setConnectorTransport(
  configPath: string,
  agentId: string,
  transport: ConnectorTransport,
): void {
  connectorTransportValue(transport, `connectors.transports.${agentId}`);
  parseConfigPath(`connectors.transports.${agentId}`);
  withBackendPublicationConfigLock(configPath, (lockToken) => {
    const file = readConfigContent(configPath);
    const stored = structuredClone(parseStoredConfig(file.content));
    const currentBackend = configBackend(file.content);
    assertBackendPublicationConfigAccess(
      configPath,
      currentBackend,
      file.observedContent,
      undefined,
      lockToken,
    );
    const connectors = stored.connectors;
    if (connectors !== undefined && !isRecord(connectors)) {
      throw new ConfigManagerError("connectors must be an object.");
    }
    const connectorObject = connectors ?? {};
    if (connectors === undefined) stored.connectors = connectorObject;
    const transports = connectorTransportsFromStored(stored) ?? {};
    if (connectorObject.transports === undefined) connectorObject.transports = transports;
    transports[agentId] = transport;
    persistConnectorTransportConfig(configPath, stored, file, currentBackend, lockToken);
  });
}

/** Remove one stored connector transport without removing unrelated settings. */
export function clearConnectorTransport(configPath: string, agentId: string): boolean {
  return withBackendPublicationConfigLock(configPath, (lockToken) => {
    const file = readConfigContent(configPath);
    const stored = structuredClone(parseStoredConfig(file.content));
    const currentBackend = configBackend(file.content);
    assertBackendPublicationConfigAccess(
      configPath,
      currentBackend,
      file.observedContent,
      undefined,
      lockToken,
    );
    const connectors = stored.connectors;
    if (connectors === undefined) return false;
    if (!isRecord(connectors)) throw new ConfigManagerError("connectors must be an object.");
    const transports = connectorTransportsFromStored(stored);
    if (transports === undefined) return false;
    if (!Object.hasOwn(transports, agentId)) return false;

    delete transports[agentId];
    if (Object.keys(transports).length === 0) delete connectors.transports;
    if (Object.keys(connectors).length === 0) delete stored.connectors;

    persistConnectorTransportConfig(configPath, stored, file, currentBackend, lockToken);
    return true;
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
