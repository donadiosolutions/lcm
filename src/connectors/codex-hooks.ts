import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmdirSync,
  renameSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ConnectorTransport } from "./types.js";

export const CODEX_HOOKS_PATH = "~/.codex/hooks.json";
export const CODEX_CONFIG_PATH = "~/.codex/config.toml";
export const LEGACY_CODEX_HOOKS_PATHS = [".codex/hooks.json"] as const;


export type CodexPostToolHookState = "absent" | "incomplete" | "installed";

export interface CodexPostToolHookInspection {
  readonly path: string;
  readonly state: CodexPostToolHookState;
  readonly structural: boolean;
}

type CodexCommandHook = {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
  [key: string]: unknown;
};

type CodexHookGroup = {
  matcher?: string;
  hooks?: CodexCommandHook[];
  [key: string]: unknown;
};

type CodexHooksConfig = {
  hooks: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
};

function lcmCommand(command: string, transport: ConnectorTransport = "cli"): string {
  if (transport !== "cli" && transport !== "mcp") {
    throw new Error(`Unsupported hook transport: ${transport}`);
  }
  const suffix = command === "user-prompt" ? ` --transport ${transport}` : "";
  return `lcm ${command} --client codex${suffix}`;
}

function codexLcmHooks(transport: ConnectorTransport = "cli"): Record<string, CodexHookGroup[]> {
  return {
    SessionStart: [
      {
        matcher: "startup|resume|clear",
        hooks: [
          {
            type: "command",
            command: lcmCommand("restore"),
            timeout: 30,
            statusMessage: "Loading LCM memory",
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: lcmCommand("user-prompt", transport),
            timeout: 30,
            statusMessage: "Searching LCM memory",
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: lcmCommand("post-tool"),
            timeout: 10,
            statusMessage: "Recording LCM tool context",
          },
        ],
      },
    ],
    PreCompact: [
      {
        matcher: "manual|auto",
        hooks: [
          {
            type: "command",
            command: lcmCommand("session-snapshot"),
            timeout: 30,
            statusMessage: "Saving LCM memory before compaction",
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: lcmCommand("session-snapshot"),
            timeout: 30,
            statusMessage: "Saving LCM memory",
          },
        ],
      },
    ],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeHooksConfig(value: unknown): CodexHooksConfig {
  const config = isObject(value) ? { ...value } : {};
  if (!isObject(config.hooks)) {
    config.hooks = {};
  }
  return config as CodexHooksConfig;
}

function isLcmHookCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  if (/\blcm\s+user-prompt\s+--client\s+codex(?:\s+--transport\s+(?:cli|mcp))?$/.test(command)) {
    return true;
  }
  return /\blcm\s+(restore|post-tool|session-snapshot)\b/.test(command);
}

function stripLcmHooks(config: CodexHooksConfig): { config: CodexHooksConfig; removed: boolean } {
  let removed = false;
  const next: CodexHooksConfig = { ...config, hooks: {} };

  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) continue;

    const keptGroups: CodexHookGroup[] = [];
    for (const group of groups) {
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      const keptHooks = hooks.filter((hook) => !isLcmHookCommand(hook.command));
      if (keptHooks.length !== hooks.length) removed = true;

      if (keptHooks.length > 0) {
        keptGroups.push({ ...group, hooks: keptHooks });
      } else if (!Array.isArray(group.hooks)) {
        keptGroups.push(group);
      } else if (Object.keys(group).some((key) => key !== "hooks" && key !== "matcher")) {
        keptGroups.push({ ...group, hooks: keptHooks });
      }
    }

    if (keptGroups.length > 0) {
      next.hooks[event] = keptGroups;
    }
  }

  return { config: next, removed };
}

function hasAnyHookGroups(config: CodexHooksConfig): boolean {
  return Object.values(config.hooks).some((groups) => Array.isArray(groups) && groups.length > 0);
}

function hasNonHookKeys(config: CodexHooksConfig): boolean {
  return Object.keys(config).some((key) => key !== "hooks");
}

/** Pure content operation used by the anchored installer mutation seam. */
export function mergeCodexHooksContent(content: string, transport: ConnectorTransport = "cli"): string {
  const config = stripLcmHooks(readHooksConfigFromContent(content)).config;
  const lcmHooks = codexLcmHooks(transport);
  for (const [event, groups] of Object.entries(lcmHooks)) {
    config.hooks[event] = [...(config.hooks[event] ?? []), ...groups];
  }
  return JSON.stringify(config, null, 2) + "\n";
}

/** Pure content operation for removing LCM hooks. */
export function removeCodexHooksContent(content: string): { state: "unchanged" | "rewrite" | "remove"; content: string } {
  const { config, removed } = stripLcmHooks(readHooksConfigFromContent(content));
  if (!removed) return { state: "unchanged", content };
  if (!hasAnyHookGroups(config) && !hasNonHookKeys(config)) return { state: "remove", content: "" };
  return { state: "rewrite", content: JSON.stringify(config, null, 2) + "\n" };
}

export function hasCodexHooksContent(content: string): boolean {
  const config = readHooksConfigFromContent(content);
  return Object.values(config.hooks).some((groups) =>
    Array.isArray(groups) && groups.some((group) =>
      Array.isArray(group.hooks) && group.hooks.some((hook) => isLcmHookCommand(hook.command)),
    ),
  );
}

function readHooksConfigFromContent(content: string): CodexHooksConfig {
  try {
    return normalizeHooksConfig(JSON.parse(content));
  } catch {
    return { hooks: {} };
  }
}

export function enableCodexHooksFeature(configPath: string): void {
  // Legacy installCodexHooks config writer; Bug #713 leaf transactions use installConnector.
  mkdirSync(dirname(configPath), { recursive: true });
  let existing = "";
  try {
    existing = readFileSync(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const updated = setCodexHooksFeature(existing);
  if (updated !== existing) {
    writeFileSync(configPath, updated);
  }
}

export function setCodexHooksFeature(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  if (!normalized) {
    return "[features]\nhooks = true\n";
  }

  const lines = normalized.split("\n");
  const sectionHeader = /^\s*\[features\]\s*(?:#.*)?$/;
  const anySectionHeader = /^\s*\[[^\]]+\]\s*(?:#.*)?$/;
  const hooksFeatureLine = /^(\s*hooks\s*=\s*).*(\s*)$/;
  const deprecatedFeatureLine = /^\s*codex_hooks\s*=.*$/;

  const featuresStart = lines.findIndex((line) => sectionHeader.test(line));
  if (featuresStart === -1) {
    return `${normalized}\n\n[features]\nhooks = true\n`;
  }

  let insertAt = featuresStart + 1;
  let featuresEnd = lines.length;
  let hooksLine = -1;
  for (let i = featuresStart + 1; i < lines.length; i++) {
    if (anySectionHeader.test(lines[i])) {
      featuresEnd = i;
      break;
    }
    if (hooksFeatureLine.test(lines[i])) {
      hooksLine = i;
    }
    insertAt = i + 1;
  }

  for (let i = featuresEnd - 1; i > featuresStart; i--) {
    if (deprecatedFeatureLine.test(lines[i])) {
      lines.splice(i, 1);
      if (hooksLine > i) hooksLine -= 1;
      featuresEnd -= 1;
      insertAt = Math.min(insertAt, featuresEnd);
    }
  }

  if (hooksLine !== -1) {
    lines[hooksLine] = lines[hooksLine].replace(hooksFeatureLine, "$1true");
    return `${lines.join("\n")}\n`;
  }

  lines.splice(Math.min(insertAt, featuresEnd), 0, "hooks = true");
  return `${lines.join("\n")}\n`;
}

export function installCodexHooks(
  hooksPath: string,
  configPath: string,
  transport: ConnectorTransport = "cli",
): void {
  // Legacy two-path helper; callers requiring Bug #713 guarantees use installConnector.
  mkdirSync(dirname(hooksPath), { recursive: true });
  enableCodexHooksFeature(configPath);
  let existing = "";
  try { existing = readFileSync(hooksPath, "utf-8"); } catch { /* malformed/absent is treated as empty */ }
  writeFileSync(hooksPath, mergeCodexHooksContent(existing, transport));
}

export type ConnectorLeafState =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "regular";
      content: Buffer;
      mode: number;
      dev: number | bigint;
      ino: number | bigint;
      readonly certificate?: ConnectorLeafCertificate;
    }>;

/** Immutable authority value produced before a public hard link exists. */
export type ConnectorLeafCertificate =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "regular";
      sha256: string;
      size: number;
      mode: number;
      dev: string;
      ino: string;
    }>;

export type ConnectorLeafObservation = Readonly<ConnectorLeafState & {
  certificate?: ConnectorLeafCertificate;
}>;

export type ConnectorLeafDecision =
  | Readonly<{ state: "unchanged" }>
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "regular"; content: Buffer; mode: number }>;

export type ConnectorLeafOperation = Readonly<{
  displayPath: string;
  operationPath: string;
  parentOperationPath: string;
  expected: ConnectorLeafState | ConnectorLeafCertificate;
  decide: (base: ConnectorLeafObservation) => ConnectorLeafDecision;
}>;

export type ConnectorLeafEvidenceKind =
  | "staging" | "initial" | "current-public" | "current-private"
  | "superseded" | "rollback" | "restore" | "detached" | "recovery";

export type ConnectorLeafEvidence = Readonly<{
  kind: ConnectorLeafEvidenceKind;
  operationPath: string;
  displayPath: string;
  status: "retained" | "detached" | "retain-only";
  certificate?: Extract<ConnectorLeafCertificate, { state: "regular" }>;
  cleanupIdentity?: Readonly<{ dev: string; ino: string; type: "regular" }>;
}>;

export type ConnectorLeafFailureEvidence = Readonly<{
  displayPath: string;
  transactionDisplayPath: string;
  evidence: readonly ConnectorLeafEvidence[];
}>;

export type ConnectorLeafCompensationResult = Readonly<{
  receipt: ConnectorLeafReceipt;
  compensated: boolean;
  failures: readonly string[];
}>;

type ConnectorLeafFailureList = readonly string[] & {
  readonly receipt: ConnectorLeafReceipt;
  readonly compensated: boolean;
  readonly failures: readonly string[];
};
type ConnectorLeafFinalizationList = readonly string[] & {
  readonly receipt: ConnectorLeafReceipt;
  readonly finalized: boolean;
  readonly failures: readonly string[];
};

function resultList<T extends object>(failures: readonly string[], result: T): readonly string[] & T & { readonly failures: readonly string[] } {
  const list = [...failures] as readonly string[] & T & { readonly failures: readonly string[] };
  Object.defineProperty(list, "failures", { value: Object.freeze([...failures]), enumerable: false });
  const record = result as { receipt?: unknown; compensated?: unknown; finalized?: unknown };
  Object.defineProperty(list, "receipt", { value: record.receipt, enumerable: false });
  Object.defineProperty(list, "compensated", { value: record.compensated, enumerable: false });
  Object.defineProperty(list, "finalized", { value: record.finalized, enumerable: false });
  return Object.freeze(list);
}

export type ConnectorLeafFinalizationResult = Readonly<{
  receipt: ConnectorLeafReceipt;
  finalized: boolean;
  failures: readonly string[];
}>;

export type ConnectorLeafReceipt = Readonly<{
  readonly displayPath: string;
  readonly operationPath: string;
  readonly parentOperationPath: string;
  readonly initial: ConnectorLeafCertificate | ConnectorLeafState;
  readonly current: ConnectorLeafCertificate | ConnectorLeafState;
  readonly transactionDisplayPath: string;
  readonly transactionOperationPath: string;
  readonly initialHoldOperationPath?: string;
  readonly initialHoldState?: Extract<ConnectorLeafState, { state: "regular" }>;
  readonly currentHoldOperationPath?: string;
  readonly currentHoldState?: Extract<ConnectorLeafState, { state: "regular" }>;
  readonly evidence: readonly ConnectorLeafEvidence[];
  readonly mutationCommitted: boolean;
  readonly recoveryRequired: boolean;
}>;

const leafFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_CONNECTOR_LEAF_BYTES = 4 * 1024 * 1024;

function leafMode(stats: ReturnType<typeof fstatSync>): number { return Number(stats.mode) & 0o7777; }

function normalizedIdentity(value: number | bigint): string { return BigInt(value).toString(10); }

function certificateFromState(state: ConnectorLeafState): ConnectorLeafCertificate {
  if (state.state === "absent") return Object.freeze({ state: "absent" });
  const cert = Object.freeze({
    state: "regular" as const,
    sha256: createHash("sha256").update(state.content).digest("hex"),
    size: state.content.length,
    mode: state.mode & 0o7777,
    dev: normalizedIdentity(state.dev),
    ino: normalizedIdentity(state.ino),
  });
  return cert;
}

function copyCertificate(value: ConnectorLeafCertificate): ConnectorLeafCertificate {
  return value.state === "absent"
    ? Object.freeze({ state: "absent" })
    : Object.freeze({
      state: "regular" as const,
      sha256: value.sha256,
      size: value.size,
      mode: value.mode & 0o7777,
      dev: BigInt(value.dev).toString(10),
      ino: BigInt(value.ino).toString(10),
    });
}

function isCertificate(value: unknown): value is ConnectorLeafCertificate {
  if (!value || typeof value !== "object") return false;
  const state = (value as { state?: unknown }).state;
  if (state === "absent") return true;
  if (state !== "regular") return false;
  const candidate = value as Partial<Extract<ConnectorLeafCertificate, { state: "regular" }>>;
  return typeof candidate.sha256 === "string"
    && /^[0-9a-f]{64}$/u.test(candidate.sha256)
    && Number.isSafeInteger(candidate.size) && (candidate.size ?? -1) >= 0
    && Number.isSafeInteger(candidate.mode)
    && typeof candidate.dev === "string" && typeof candidate.ino === "string";
}

function certificateEqual(left: ConnectorLeafCertificate, right: ConnectorLeafCertificate): boolean {
  if (left.state !== right.state) return false;
  if (left.state === "absent" || right.state === "absent") return true;
  return (
    left.sha256 === right.sha256 && left.size === right.size && left.mode === right.mode
    && left.dev === right.dev && left.ino === right.ino
  );
}

function assertConnectorLeafReadSize(size: number, displayPath: string): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Unable to read connector leaf at ${displayPath}`);
  }
  if (size > MAX_CONNECTOR_LEAF_BYTES) {
    throw new Error(`Refusing to read connector leaf larger than 4 MiB at ${displayPath}`);
  }
}

function readLeaf(descriptor: number, size: number, displayPath: string): Buffer {
  assertConnectorLeafReadSize(size, displayPath);
  const out = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, out, offset, size - offset, offset);
    if (count <= 0) throw new Error("short connector leaf read");
    offset += count;
  }
  return out;
}

function stateEqual(left: ConnectorLeafState, right: ConnectorLeafState): boolean {
  if (left.state !== right.state) return false;
  return left.state === "absent" || (
    left.mode === (right as Extract<ConnectorLeafState, { state: "regular" }>).mode
    && left.dev === (right as Extract<ConnectorLeafState, { state: "regular" }>).dev
    && left.ino === (right as Extract<ConnectorLeafState, { state: "regular" }>).ino
    && left.content.equals((right as Extract<ConnectorLeafState, { state: "regular" }>).content)
  );
}

function stateMatchesCertificate(state: ConnectorLeafState, certificate: ConnectorLeafCertificate | ConnectorLeafState): boolean {
  if (!certificate || typeof certificate !== "object") return false;
  if (!isCertificate(certificate)) {
    if (!("state" in certificate)) return false;
    return stateEqual(state, certificate);
  }
  if (state.state !== certificate.state) return false;
  return certificateEqual(certificateFromState(state), certificate);
}

/** Compare a stable observation with immutable authority; observations never grant authority. */
export function matchesCertificate(
  observation: ConnectorLeafObservation | ConnectorLeafState,
  certificate: ConnectorLeafCertificate,
): boolean {
  return stateMatchesCertificate(observation, certificate);
}

function stateMatchesLogical(state: ConnectorLeafState, certificate: ConnectorLeafCertificate): boolean {
  if (certificate.state !== state.state) return false;
  if (certificate.state === "absent") return true;
  if (state.state !== "regular") return false;
  return state.content.length === certificate.size
    && state.mode === certificate.mode
    && createHash("sha256").update(state.content).digest("hex") === certificate.sha256;
}

function observationForDecision(state: ConnectorLeafState): ConnectorLeafObservation {
  if (state.state === "absent") return Object.freeze({ state: "absent" as const, certificate: Object.freeze({ state: "absent" as const }) });
  return Object.freeze({
    ...state,
    content: Buffer.from(state.content),
    certificate: certificateFromState(state),
  });
}

function uniqueEvidence(entries: readonly ConnectorLeafEvidence[]): readonly ConnectorLeafEvidence[] {
  const seen = new Set<string>();
  const out: ConnectorLeafEvidence[] = [];
  for (const entry of entries) {
    if (seen.has(entry.operationPath)) continue;
    seen.add(entry.operationPath);
    out.push(Object.freeze(entry));
  }
  return Object.freeze(out);
}

/** Keep operation/evidence paths private while retaining direct internal access. */
function freezeReceipt(value: ConnectorLeafReceipt): ConnectorLeafReceipt {
  for (const key of [
    "operationPath", "parentOperationPath", "transactionDisplayPath", "transactionOperationPath",
    "initialHoldOperationPath", "initialHoldState", "currentHoldOperationPath", "currentHoldState", "evidence",
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor) Object.defineProperty(value, key, { ...descriptor, enumerable: false });
  }
  return Object.freeze(value);
}

export function captureConnectorLeaf(displayPath: string, operationPath: string): ConnectorLeafState {
  let descriptor: number;
  try { descriptor = openSync(operationPath, leafFlags); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    const wrapped = new Error(`Unable to inspect connector leaf at ${displayPath}`);
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") Object.assign(wrapped, { code });
    throw wrapped;
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`Connector leaf is not a regular file at ${displayPath}`);
    const size = Number(before.size);
    const content = readLeaf(descriptor, size, displayPath);
    const after = fstatSync(descriptor);
    const mode = leafMode(before);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || leafMode(after) !== mode || Number(after.size) !== size) {
      throw new Error(`Connector leaf changed while being read at ${displayPath}`);
    }
    const result = { state: "regular" as const, content, mode, dev: before.dev, ino: before.ino };
    Object.defineProperty(result, "certificate", {
      value: certificateFromState(result),
      enumerable: false,
      configurable: false,
    });
    return result;
  } finally { closeSync(descriptor); }
}

function transactionDir(parent: string, displayParent: string): { operation: string; display: string } {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `.lcm-connector-txn-${randomBytes(16).toString("hex")}`;
    const operation = join(parent, name);
    try {
      mkdirSync(operation, { mode: 0o700 });
      const stats = lstatSync(operation);
      if (!stats.isDirectory() || leafMode(stats) !== 0o700) throw new Error("invalid transaction directory");
      return { operation, display: join(displayParent, name) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("unable to allocate connector transaction directory");
}

function validateTransactionDirectory(tx: { operation: string; display: string }): void {
  const stats = lstatSync(tx.operation);
  if (!stats.isDirectory() || leafMode(stats) !== 0o700) {
    throw new Error(`Connector transaction namespace changed at ${tx.display}`);
  }
}

function stageCandidate(
  path: string,
  content: Buffer,
  mode: number,
  applyUmask: boolean,
  displayPath: string,
): Extract<ConnectorLeafState, { state: "regular" }> {
  const effectiveMode = applyUmask ? mode & ~process.umask() : mode;
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, effectiveMode);
  try {
    let offset = 0;
    while (offset < content.length) {
      const count = writeSync(fd, content, offset, content.length - offset, offset);
      if (count <= 0) throw new Error("connector candidate write made no progress");
      offset += count;
    }
    fchmodSync(fd, effectiveMode);
    fsyncSync(fd);
    const stats = fstatSync(fd);
    if (!stats.isFile() || leafMode(stats) !== effectiveMode || Number(stats.size) !== content.length) throw new Error("connector candidate verification failed");
    const readback = readLeaf(fd, content.length, displayPath);
    if (!readback.equals(content)) throw new Error("connector candidate readback mismatch");
    const after = fstatSync(fd);
    if (!after.isFile() || after.dev !== stats.dev || after.ino !== stats.ino
      || leafMode(after) !== effectiveMode || Number(after.size) !== content.length) {
      throw new Error("connector candidate changed while being staged");
    }
    return {
      state: "regular",
      content: Buffer.from(readback),
      mode: effectiveMode,
      dev: stats.dev,
      ino: stats.ino,
    };
  } finally { closeSync(fd); }
}

function safeUnlink(path: string): void { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }

function sanitizeLeafError(error: unknown, operation: ConnectorLeafOperation, tx: { operation: string; display: string }): Error {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : "connector mutation failed";
  let message = source.replaceAll(operation.operationPath, operation.displayPath)
    .replaceAll(operation.parentOperationPath, dirname(operation.displayPath));
  message = message.replaceAll(tx.operation, tx.display);
  const wrapped = new Error(message);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === "string") Object.assign(wrapped, { code });
  return wrapped;
}

function recoveryDisplayPath(tx: { operation: string; display: string }, operationPath: string): string {
  return join(tx.display || dirname(operationPath), basename(operationPath));
}

function republishMovedEntry(
  hold: string,
  operation: Pick<ConnectorLeafOperation, "displayPath" | "operationPath">,
  tx: { operation: string; display: string },
  context: string,
): Error {
  const recoveryPath = recoveryDisplayPath(tx, hold);
  try {
    linkSync(hold, operation.operationPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const detail = error instanceof Error && !error.message.includes("/proc/self/fd/") ? error.message : (typeof code === "string" ? code : "operation failed");
    return new Error(`${context} at ${operation.displayPath}; recovery artifact retained at ${recoveryPath} (${detail})`);
  }
  try {
    safeUnlink(hold);
    return new Error(`${context} at ${operation.displayPath}; recovery republished the moved entry without replacement`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const detail = error instanceof Error && !error.message.includes("/proc/self/fd/") ? error.message : (typeof code === "string" ? code : "operation failed");
    return new Error(`${context} at ${operation.displayPath}; recovery artifact retained at ${recoveryPath} (${detail})`);
  }
}

function unlinkPrivateIfExact(
  path: string,
  expected: ConnectorLeafCertificate | Extract<ConnectorLeafState, { state: "regular" }>,
  displayPath: string,
  tx: { operation: string; display: string },
): string | undefined {
  try {
    const observed = captureConnectorLeaf(displayPath, path);
    if (!stateMatchesCertificate(observed, expected)) {
      return `${displayPath}: cleanup incomplete; recovery artifact retained at ${recoveryDisplayPath(tx, path)}`;
    }
    safeUnlink(path);
    return undefined;
  } catch {
    return `${displayPath}: cleanup incomplete; recovery artifact retained at ${recoveryDisplayPath(tx, path)}`;
  }
}

export function mutateConnectorLeaf(operation: ConnectorLeafOperation, priorReceipt?: ConnectorLeafReceipt): ConnectorLeafMutationResult {
  const expected = priorReceipt?.current ?? operation.expected;
  if (!isCertificate(expected) && expected.state === "regular" && !Buffer.isBuffer(expected.content)) {
    throw Object.assign(new Error(`Invalid connector publication certificate at ${operation.displayPath}`), { code: "EINVAL" });
  }
  const expectedCertificate = isCertificate(expected) ? copyCertificate(expected) : certificateFromState(expected);
  const observed = captureConnectorLeaf(operation.displayPath, operation.operationPath);
  if (!stateMatchesCertificate(observed, expectedCertificate)) throw Object.assign(new Error(`Connector path changed before mutation at ${operation.displayPath}`), { code: "EAGAIN" });
  const decision = operation.decide(observationForDecision(observed));
  if (decision.state === "regular") {
    assertConnectorLeafReadSize(decision.content.length, operation.displayPath);
  }
  if (decision.state === "unchanged" || (decision.state === "absent" && observed.state === "absent")) {
    if (priorReceipt) return { changed: false, receipt: priorReceipt };
    return {
      changed: false,
      receipt: freezeReceipt({
        displayPath: operation.displayPath,
        operationPath: operation.operationPath,
        parentOperationPath: operation.parentOperationPath,
        initial: expectedCertificate,
        current: expectedCertificate,
        transactionDisplayPath: "",
        transactionOperationPath: "",
        mutationCommitted: false,
        recoveryRequired: false,
        evidence: Object.freeze([]),
      }),
    };
  }
  const tx = priorReceipt ? { operation: priorReceipt.transactionOperationPath, display: priorReceipt.transactionDisplayPath } : transactionDir(operation.parentOperationPath, dirname(operation.displayPath));
  const candidate = decision.state === "regular" ? join(tx.operation, `candidate-${Date.now()}-${randomBytes(4).toString("hex")}`) : undefined;
  let publicationCommitted = false;
  let committedReceipt: ConnectorLeafReceipt | undefined;
  let validatedHold: string | undefined;
  try {
    validateTransactionDirectory(tx);
    let stagedState: Extract<ConnectorLeafState, { state: "regular" }> | undefined;
    let stagedCertificate: Extract<ConnectorLeafCertificate, { state: "regular" }> | undefined;
    let claimedState: Extract<ConnectorLeafState, { state: "regular" }> | undefined;
    if (candidate) {
      const regularDecision = decision as Extract<ConnectorLeafDecision, { state: "regular" }>;
      stagedState = stageCandidate(
        candidate,
        regularDecision.content,
        regularDecision.mode,
        expectedCertificate.state === "absent",
        operation.displayPath,
      );
      stagedCertificate = certificateFromState(stagedState) as Extract<ConnectorLeafCertificate, { state: "regular" }>;
    }
    let hold: string | undefined;
    if (expectedCertificate.state === "regular") {
      const holdName = priorReceipt ? `superseded-${randomBytes(4).toString("hex")}` : "initial";
      hold = join(tx.operation, holdName);
      renameSync(operation.operationPath, hold);
      let claimed: ConnectorLeafState | undefined;
      try { claimed = captureConnectorLeaf(operation.displayPath, hold); } catch { /* recovery below */ }
      if (!claimed || !stateMatchesCertificate(claimed, expectedCertificate)) {
        throw republishMovedEntry(hold, operation, tx, "Connector leaf claim validation failed");
      }
      claimedState = claimed.state === "regular" ? claimed : undefined;
      validatedHold = hold;
    }
    if (decision.state === "regular") {
      try { linkSync(candidate!, operation.operationPath); }
      catch (error) { throw error; }
      publicationCommitted = true;
      const priorCurrentHold = priorReceipt?.currentHoldOperationPath;
      const initialCertificate = priorReceipt?.initial
        ? (isCertificate(priorReceipt.initial) ? copyCertificate(priorReceipt.initial) : certificateFromState(priorReceipt.initial))
        : expectedCertificate;
      const evidence = uniqueEvidence([
        ...(priorReceipt?.evidence ?? []),
        Object.freeze({ kind: priorReceipt ? "superseded" as const : "initial" as const, operationPath: hold ?? operation.operationPath, displayPath: hold ? recoveryDisplayPath(tx, hold) : operation.displayPath, status: "retained" as const, certificate: priorReceipt ? (expectedCertificate.state === "regular" ? expectedCertificate : undefined) : (expectedCertificate.state === "regular" ? expectedCertificate : undefined) }),
        Object.freeze({ kind: "staging" as const, operationPath: candidate!, displayPath: recoveryDisplayPath(tx, candidate!), status: "retained" as const, certificate: stagedCertificate }),
        Object.freeze({ kind: "current-public" as const, operationPath: operation.operationPath, displayPath: operation.displayPath, status: "retained" as const, certificate: stagedCertificate }),
        Object.freeze({ kind: "current-private" as const, operationPath: candidate!, displayPath: recoveryDisplayPath(tx, candidate!), status: "retained" as const, certificate: stagedCertificate }),
      ]);
      const receipt: ConnectorLeafReceipt = freezeReceipt((priorReceipt ? {
        ...priorReceipt,
        initial: initialCertificate,
        current: stagedCertificate!,
        operationPath: operation.operationPath,
        parentOperationPath: operation.parentOperationPath,
        transactionDisplayPath: priorReceipt.transactionDisplayPath || tx.display,
        transactionOperationPath: priorReceipt.transactionOperationPath || tx.operation,
        initialHoldOperationPath: priorReceipt.initialHoldOperationPath ?? (expectedCertificate.state === "regular" ? hold : undefined),
        initialHoldState: priorReceipt.initialHoldState ?? claimedState,
        currentHoldOperationPath: candidate,
        currentHoldState: stagedState,
        mutationCommitted: true,
        recoveryRequired: false,
        evidence,
      } : {
        displayPath: operation.displayPath,
        operationPath: operation.operationPath,
        parentOperationPath: operation.parentOperationPath,
        initial: initialCertificate,
        current: stagedCertificate!,
        transactionDisplayPath: tx.display,
        transactionOperationPath: tx.operation,
        mutationCommitted: true,
        recoveryRequired: false,
        initialHoldOperationPath: expectedCertificate.state === "regular" ? hold : undefined,
        initialHoldState: expectedCertificate.state === "regular" ? claimedState : undefined,
        currentHoldOperationPath: candidate,
        currentHoldState: stagedState,
        evidence,
      }) as ConnectorLeafReceipt);
      committedReceipt = receipt;
      const publicState = captureConnectorLeaf(operation.displayPath, operation.operationPath);
      const candidateState = captureConnectorLeaf(operation.displayPath, candidate!);
      if (publicState.state !== "regular" || candidateState.state !== "regular"
        || !stateMatchesCertificate(publicState, stagedCertificate!)
        || !stateMatchesCertificate(candidateState, stagedCertificate!)) {
        throw new Error(`Connector candidate publication verification failed at ${operation.displayPath}`);
      }
      const cleanupFailures: string[] = [];
      if (priorCurrentHold && priorCurrentHold !== candidate && expectedCertificate.state === "regular") {
        const failure = unlinkPrivateIfExact(priorCurrentHold, expectedCertificate, operation.displayPath, tx);
        if (failure) cleanupFailures.push(failure);
      }
      if (hold && hold !== receipt.initialHoldOperationPath && expectedCertificate.state === "regular") {
        const failure = unlinkPrivateIfExact(hold, claimedState ?? expectedCertificate, operation.displayPath, tx);
        if (failure) cleanupFailures.push(failure);
      }
      if (cleanupFailures.length > 0) {
        throw new Error(cleanupFailures.join("; "));
      }
      return { changed: true, content: decision.content, receipt };
    }
    const priorCurrentHold = priorReceipt?.currentHoldOperationPath;
    const initialCertificate = priorReceipt?.initial
      ? (isCertificate(priorReceipt.initial) ? copyCertificate(priorReceipt.initial) : certificateFromState(priorReceipt.initial))
      : expectedCertificate;
    const receipt: ConnectorLeafReceipt = freezeReceipt((priorReceipt ? {
      ...priorReceipt,
      initial: initialCertificate,
      current: Object.freeze({ state: "absent" as const }) as ConnectorLeafCertificate,
      operationPath: operation.operationPath,
      parentOperationPath: operation.parentOperationPath,
      transactionDisplayPath: priorReceipt.transactionDisplayPath || tx.display,
      transactionOperationPath: priorReceipt.transactionOperationPath || tx.operation,
      initialHoldOperationPath: priorReceipt.initialHoldOperationPath ?? hold,
      initialHoldState: priorReceipt.initialHoldState ?? claimedState,
      currentHoldOperationPath: hold,
      currentHoldState: expectedCertificate.state === "regular" ? claimedState : undefined,
      mutationCommitted: true,
      recoveryRequired: false,
      evidence: uniqueEvidence([
        ...(priorReceipt.evidence ?? []),
        ...(hold ? [Object.freeze({ kind: priorReceipt ? "superseded" as const : "initial" as const, operationPath: hold, displayPath: recoveryDisplayPath(tx, hold), status: "retained" as const, certificate: expectedCertificate.state === "regular" ? expectedCertificate : undefined })] : []),
        Object.freeze({ kind: "current-public" as const, operationPath: operation.operationPath, displayPath: operation.displayPath, status: "retained" as const }),
      ]),
    } : {
      displayPath: operation.displayPath,
      operationPath: operation.operationPath,
      parentOperationPath: operation.parentOperationPath,
      initial: initialCertificate,
      current: Object.freeze({ state: "absent" as const }) as ConnectorLeafCertificate,
      transactionDisplayPath: tx.display,
      transactionOperationPath: tx.operation,
      mutationCommitted: true,
      recoveryRequired: false,
      initialHoldOperationPath: expectedCertificate.state === "regular" ? hold : undefined,
      initialHoldState: expectedCertificate.state === "regular" ? claimedState : undefined,
      currentHoldOperationPath: hold,
      currentHoldState: expectedCertificate.state === "regular" ? claimedState : undefined,
      evidence: uniqueEvidence([
        ...(hold ? [Object.freeze({ kind: "initial" as const, operationPath: hold, displayPath: recoveryDisplayPath(tx, hold), status: "retained" as const, certificate: expectedCertificate.state === "regular" ? expectedCertificate : undefined })] : []),
        Object.freeze({ kind: "current-public" as const, operationPath: operation.operationPath, displayPath: operation.displayPath, status: "retained" as const }),
      ]),
    }) as ConnectorLeafReceipt);
    if (priorCurrentHold && priorCurrentHold !== hold && expectedCertificate.state === "regular") {
      const failure = unlinkPrivateIfExact(priorCurrentHold, expectedCertificate, operation.displayPath, tx);
      if (failure) {
        throw new Error(failure);
      }
    }
    return { changed: true, receipt };
  } catch (error) {
    const failure = validatedHold && decision.state === "regular" && !publicationCommitted
      ? republishMovedEntry(
        validatedHold,
        operation,
        tx,
        "Connector candidate publication failed",
      )
      : error;
    const primary = sanitizeLeafError(failure, operation, tx);
    const cleanupFailures: string[] = [];
    if (candidate && !publicationCommitted) {
      try { safeUnlink(candidate); }
      catch (cleanupError) { cleanupFailures.push(`candidate cleanup failed (${sanitizeLeafError(cleanupError, operation, tx).message})`); }
    }
    if (!priorReceipt) {
      try { rmdirSync(tx.operation); }
      catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          cleanupFailures.push(`transaction cleanup failed (${sanitizeLeafError(cleanupError, operation, tx).message})`);
        }
      }
    }
    if (cleanupFailures.length > 0) primary.message = `${primary.message}; ${cleanupFailures.join("; ")}`;
    if (committedReceipt) {
      Object.defineProperty(primary, "connectorLeafReceipt", {
        value: committedReceipt,
        enumerable: false,
        configurable: false,
      });
    } else {
      Object.defineProperty(primary, "connectorLeafFailureEvidence", {
        value: Object.freeze({
          displayPath: operation.displayPath,
          transactionDisplayPath: tx.display,
          evidence: uniqueEvidence([
            ...(candidate ? [Object.freeze({ kind: "staging" as const, operationPath: candidate, displayPath: recoveryDisplayPath(tx, candidate), status: "retained" as const })] : []),
            ...(validatedHold ? [Object.freeze({ kind: "recovery" as const, operationPath: validatedHold, displayPath: recoveryDisplayPath(tx, validatedHold), status: "retain-only" as const })] : []),
          ]),
        }),
        enumerable: false,
      });
    }
    throw primary;
  }
}

export function compensateConnectorLeaf(receipt: ConnectorLeafReceipt): ConnectorLeafFailureList {
  const failures: string[] = [];
  let rollbackHold: string | undefined;
  let rollbackClaimed = false;
  let compensationCommitted = false;
  try {
    if (!receipt.mutationCommitted) return resultList(failures, { receipt, compensated: true });
    const initialCertificate = isCertificate(receipt.initial) ? receipt.initial : certificateFromState(receipt.initial);
    const currentCertificate = isCertificate(receipt.current) ? receipt.current : certificateFromState(receipt.current);
    let initialHold: string | undefined;
    if (initialCertificate.state === "regular") {
      initialHold = receipt.initialHoldOperationPath;
      if (!initialHold) throw new Error("initial hold unavailable");
      const retainedInitial = captureConnectorLeaf(receipt.displayPath, initialHold);
      if (!stateMatchesCertificate(retainedInitial, initialCertificate)) throw new Error("initial hold changed");
    }
    if (currentCertificate.state === "regular") {
      const now = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
      if (!stateMatchesCertificate(now, currentCertificate)) throw new Error("current receipt changed");
      rollbackHold = join(receipt.transactionOperationPath, `rollback-${randomBytes(4).toString("hex")}`);
      renameSync(receipt.operationPath, rollbackHold);
      let claimed: ConnectorLeafState | undefined;
      try { claimed = captureConnectorLeaf(receipt.displayPath, rollbackHold); } catch { /* recovery below */ }
      if (!claimed || !stateMatchesCertificate(claimed, currentCertificate)) {
        const recoveryFailure = republishMovedEntry(
          rollbackHold,
          {
            displayPath: receipt.displayPath,
            operationPath: receipt.operationPath,
          },
          { operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath },
          "current receipt changed after rollback claim",
        );
        rollbackHold = undefined;
        throw recoveryFailure;
      }
      rollbackClaimed = true;
      if (initialCertificate.state === "regular") {
        const initialState = captureConnectorLeaf(receipt.displayPath, initialHold!);
        if (initialState.state !== "regular") throw new Error("initial hold changed");
        const restorePath = join(receipt.transactionOperationPath, `restore-${randomBytes(4).toString("hex")}`);
        const restoreState = stageCandidate(restorePath, initialState.content, initialCertificate.mode, false, receipt.displayPath);
        const restoreCertificate = certificateFromState(restoreState);
        if (!stateMatchesLogical(restoreState, initialCertificate)) throw new Error("restore candidate certificate mismatch");
        linkSync(restorePath, receipt.operationPath);
        compensationCommitted = true;
        const restored = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
        if (!stateMatchesLogical(restored, initialCertificate)) throw new Error("initial receipt restoration mismatch");
        const restoreFailure = unlinkPrivateIfExact(restorePath, restoreCertificate, receipt.displayPath, { operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath });
        if (restoreFailure) throw new Error(restoreFailure);
      } else {
        compensationCommitted = true;
      }
      const cleanupFailure = unlinkPrivateIfExact(
        rollbackHold,
        currentCertificate,
        receipt.displayPath,
        { operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath },
      );
      if (cleanupFailure) throw new Error(cleanupFailure);
    } else if (initialCertificate.state === "regular") {
      const now = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
      if (now.state !== "absent") throw new Error("current receipt changed");
      const initialState = captureConnectorLeaf(receipt.displayPath, initialHold!);
      if (initialState.state !== "regular") throw new Error("initial hold changed");
      const restorePath = join(receipt.transactionOperationPath, `restore-${randomBytes(4).toString("hex")}`);
      const restoreState = stageCandidate(restorePath, initialState.content, initialCertificate.mode, false, receipt.displayPath);
      const restoreCertificate = certificateFromState(restoreState);
      if (!stateMatchesLogical(restoreState, initialCertificate)) throw new Error("restore candidate certificate mismatch");
      linkSync(restorePath, receipt.operationPath);
      compensationCommitted = true;
      const restored = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
      if (!stateMatchesLogical(restored, initialCertificate)) throw new Error("initial receipt restoration mismatch");
      const restoreFailure = unlinkPrivateIfExact(restorePath, restoreCertificate, receipt.displayPath, { operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath });
      if (restoreFailure) throw new Error(restoreFailure);
    } else {
      const now = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
      if (now.state !== "absent") throw new Error("current receipt changed");
    }
  } catch (error) {
    const failure = rollbackHold && rollbackClaimed && !compensationCommitted
      ? republishMovedEntry(
        rollbackHold,
        { displayPath: receipt.displayPath, operationPath: receipt.operationPath },
        { operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath },
        "rollback failed",
      )
      : error;
    const message = failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "rollback failed";
    const named = receipt.initialHoldOperationPath && message.includes("initial hold")
      ? `${message}; recovery artifact retained at ${receipt.initialHoldOperationPath}` : message;
    failures.push(`${receipt.displayPath}: rollback incomplete (${named})`);
  }
  return resultList(failures, { receipt, compensated: failures.length === 0 });
}

export function finalizeConnectorLeaf(receipt: ConnectorLeafReceipt): ConnectorLeafFinalizationList {
  const failures: string[] = [];
  const tx = { operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath };
  const holds = new Map<string, ConnectorLeafCertificate | Extract<ConnectorLeafState, { state: "regular" }> | undefined>();
  if (receipt.currentHoldOperationPath) {
    holds.set(
      receipt.currentHoldOperationPath,
      receipt.currentHoldState ?? (isCertificate(receipt.current) ? receipt.current : receipt.current.state === "regular" ? receipt.current : undefined),
    );
  }
  if (receipt.initialHoldOperationPath) {
    holds.set(
      receipt.initialHoldOperationPath,
      receipt.initialHoldState ?? (isCertificate(receipt.initial) ? receipt.initial : receipt.initial.state === "regular" ? receipt.initial : undefined),
    );
  }
  for (const [path, expected] of holds) {
    if (!expected) {
      failures.push(`${receipt.displayPath}: cleanup incomplete; recovery artifact retained at ${recoveryDisplayPath(tx, path)}`);
      continue;
    }
    const failure = unlinkPrivateIfExact(path, expected, receipt.displayPath, tx);
    if (failure) failures.push(failure);
  }
  try { rmdirSync(receipt.transactionOperationPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && failures.length === 0) {
      failures.push(`${receipt.displayPath}: cleanup incomplete; recovery artifact retained at ${receipt.transactionDisplayPath}`);
    }
  }
  return resultList(failures, { receipt, finalized: failures.length === 0 });
}

export type ConnectorLeafMutationResult = Readonly<{ changed: boolean; content?: Buffer; receipt: ConnectorLeafReceipt }>;

export function removeCodexHooks(hooksPath: string): boolean {
  if (process.platform !== "linux") throw new Error("Connector filesystem mutation requires Linux proc-descriptor anchoring");
  const parent = dirname(hooksPath);
  let parentFd: number;
  try { parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    const wrapped = new Error(`Unable to inspect connector hooks parent at ${parent}`);
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") Object.assign(wrapped, { code });
    throw wrapped;
  }
  try {
    const leaf = basename(hooksPath);
    if (!leaf || leaf === "." || leaf === "..") throw new Error(`Unable to inspect connector hooks parent at ${parent}`);
    const operationPath = `/proc/self/fd/${parentFd}/${leaf}`;
    const parentOperationPath = `/proc/self/fd/${parentFd}`;
    let result: ConnectorLeafMutationResult;
    try {
      const expected = captureConnectorLeaf(hooksPath, operationPath);
      if (expected.state === "absent") return false;
      result = mutateConnectorLeaf({ displayPath: hooksPath, operationPath, parentOperationPath, expected, decide: (base) => {
      // The expected snapshot is captured immediately above and mutation
      // revalidates it before invoking this callback, so this is necessarily
      // a regular leaf. Keep the transform bound to that captured state.
      const regularBase = base as Extract<ConnectorLeafState, { state: "regular" }>;
      const decision = removeCodexHooksContent(regularBase.content.toString("utf-8"));
      if (decision.state === "unchanged") return { state: "unchanged" };
      if (decision.state === "remove") return { state: "absent" };
      return { state: "regular", content: Buffer.from(decision.content, "utf-8"), mode: regularBase.mode };
      }});
    } catch (error) {
      const message = (error instanceof Error ? error.message : typeof error === "string" ? error : "connector hooks mutation failed").replaceAll(operationPath, hooksPath).replaceAll(parentOperationPath, parent);
      const receipt = (error as Error & { connectorLeafReceipt?: ConnectorLeafReceipt }).connectorLeafReceipt;
      if (receipt?.mutationCommitted) {
        const compensation = compensateConnectorLeaf(receipt);
        const finalization = compensation.length === 0 ? finalizeConnectorLeaf(receipt) : [];
        const failures = [...compensation, ...finalization];
        const outcome = failures.length === 0
          ? "standalone committed mutation compensated"
          : `standalone compensation incomplete (${failures.join("; ")})`;
        const wrapped = new Error(`${message}; ${outcome}`);
        const code = (error as NodeJS.ErrnoException)?.code;
        if (typeof code === "string") Object.assign(wrapped, { code });
        throw wrapped;
      }
      const wrapped = new Error(message);
      const code = (error as NodeJS.ErrnoException)?.code;
      if (typeof code === "string") Object.assign(wrapped, { code });
      throw wrapped;
    }
    const failures = result.changed ? finalizeConnectorLeaf(result.receipt) : [];
    if (failures.length) throw new Error(failures.join("; "));
    return result.changed;
  } finally { closeSync(parentFd); }
}

export function hasCodexHooks(hooksPath: string): boolean {
  return hasCodexHooksContent(readFileContent(hooksPath));
}

function readFileContent(path: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, leafFlags);
  } catch { return ""; }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) return "";
    const content = readLeaf(descriptor, Number(before.size), path);
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || leafMode(after) !== leafMode(before) || Number(after.size) !== Number(before.size)) return "";
    return content.toString("utf-8");
  } catch { return ""; }
  finally { closeSync(descriptor); }
}

/** Resolve the Codex hooks path using the same `~/` convention as installation. */
export function resolveCodexHooksPath(cwd: string = process.cwd()): string {
  void cwd;
  return join(homedir(), CODEX_HOOKS_PATH.slice(2));
}

function hasExactPostToolHook(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.hooks)) return false;
  const postToolUse = value.hooks.PostToolUse;
  if (!Array.isArray(postToolUse)) return false;

  return postToolUse.some((group) => {
    if (!isObject(group) || group.matcher !== "*" || !Array.isArray(group.hooks)) return false;
    return group.hooks.some((hook) =>
      isObject(hook)
      && hook.type === "command"
      && hook.command === "lcm post-tool --client codex",
    );
  });
}

/** Inspect only the exact native Codex PostToolUse contract; this function never writes. */
export function inspectCodexPostToolHook(hooksPath: string): CodexPostToolHookInspection {
  const content = readFileContent(hooksPath);
  if (!content) {
    try { lstatSync(hooksPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: hooksPath, state: "absent", structural: false };
    }
    return { path: hooksPath, state: "incomplete", structural: false };
  }
  let value: unknown;
  try { value = JSON.parse(content); } catch { return { path: hooksPath, state: "incomplete", structural: false }; }

  const structural = hasExactPostToolHook(value);
  return { path: hooksPath, state: structural ? "installed" : "incomplete", structural };
}
