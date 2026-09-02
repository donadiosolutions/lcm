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
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
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
    }>;

export type ConnectorLeafDecision =
  | Readonly<{ state: "unchanged" }>
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "regular"; content: Buffer; mode: number }>;

export type ConnectorLeafOperation = Readonly<{
  displayPath: string;
  operationPath: string;
  parentOperationPath: string;
  expected: ConnectorLeafState;
  decide: (base: ConnectorLeafState) => ConnectorLeafDecision;
}>;

export type ConnectorLeafReceipt = {
  readonly displayPath: string;
  readonly operationPath: string;
  readonly parentOperationPath: string;
  readonly initial: ConnectorLeafState;
  current: ConnectorLeafState;
  readonly transactionDisplayPath: string;
  readonly transactionOperationPath: string;
  initialHoldOperationPath?: string;
  currentHoldOperationPath?: string;
  mutationCommitted: boolean;
  recoveryRequired: boolean;
};

const leafFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function leafMode(stats: ReturnType<typeof fstatSync>): number { return Number(stats.mode) & 0o777; }

function readLeaf(descriptor: number, size: number): Buffer {
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

export function captureConnectorLeaf(displayPath: string, operationPath: string): ConnectorLeafState {
  let descriptor: number;
  try { descriptor = openSync(operationPath, leafFlags); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    const wrapped = new Error(`Unable to inspect connector leaf at ${displayPath}`, { cause: error });
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") Object.assign(wrapped, { code });
    throw wrapped;
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`Connector leaf is not a regular file at ${displayPath}`);
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Unable to read connector leaf at ${displayPath}`);
    const content = readLeaf(descriptor, size);
    const after = fstatSync(descriptor);
    const mode = leafMode(before);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || leafMode(after) !== mode || Number(after.size) !== size) {
      throw new Error(`Connector leaf changed while being read at ${displayPath}`);
    }
    return { state: "regular", content, mode, dev: before.dev, ino: before.ino };
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

function stageCandidate(path: string, content: Buffer, mode: number): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
  try {
    let offset = 0;
    while (offset < content.length) {
      const count = writeSync(fd, content, offset, content.length - offset, offset);
      if (count <= 0) throw new Error("connector candidate write made no progress");
      offset += count;
    }
    fchmodSync(fd, mode);
    fsyncSync(fd);
    const stats = fstatSync(fd);
    if (!stats.isFile() || leafMode(stats) !== mode || Number(stats.size) !== content.length) throw new Error("connector candidate verification failed");
    const readback = readLeaf(fd, content.length);
    if (!readback.equals(content)) throw new Error("connector candidate readback mismatch");
    const after = fstatSync(fd);
    if (!after.isFile() || after.dev !== stats.dev || after.ino !== stats.ino
      || leafMode(after) !== mode || Number(after.size) !== content.length) {
      throw new Error("connector candidate changed while being staged");
    }
  } finally { closeSync(fd); }
}

function safeUnlink(path: string): void { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }

function sanitizeLeafError(error: unknown, operation: ConnectorLeafOperation, tx?: { operation: string; display: string }): Error {
  const source = error instanceof Error ? error.message : String(error);
  let message = source.replaceAll(operation.operationPath, operation.displayPath)
    .replaceAll(operation.parentOperationPath, dirname(operation.displayPath));
  if (tx) message = message.replaceAll(tx.operation, tx.display);
  const wrapped = new Error(message);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === "string") Object.assign(wrapped, { code });
  return wrapped;
}

function unlinkPublicIfExact(publicPath: string, candidatePath: string, displayPath: string): void {
  const publicState = captureConnectorLeaf(displayPath, publicPath);
  const candidateState = captureConnectorLeaf(displayPath, candidatePath);
  if (publicState.state === "regular" && candidateState.state === "regular" && stateEqual(publicState, candidateState)) {
    safeUnlink(publicPath);
  }
}

export function mutateConnectorLeaf(operation: ConnectorLeafOperation, priorReceipt?: ConnectorLeafReceipt): ConnectorLeafMutationResult {
  const expected = priorReceipt?.current ?? operation.expected;
  const observed = captureConnectorLeaf(operation.displayPath, operation.operationPath);
  if (!stateEqual(observed, expected)) throw Object.assign(new Error(`Connector path changed before mutation at ${operation.displayPath}`), { code: "EAGAIN" });
  const decision = operation.decide({ ...observed, ...(observed.state === "regular" ? { content: Buffer.from(observed.content) } : {}) });
  if (decision.state === "unchanged") {
    if (priorReceipt) return { changed: false, receipt: priorReceipt };
    return {
      changed: false,
      receipt: {
        displayPath: operation.displayPath,
        operationPath: operation.operationPath,
        parentOperationPath: operation.parentOperationPath,
        initial: expected,
        current: expected,
        transactionDisplayPath: "",
        transactionOperationPath: "",
        mutationCommitted: false,
        recoveryRequired: false,
      },
    };
  }
  const tx = priorReceipt ? { operation: priorReceipt.transactionOperationPath, display: priorReceipt.transactionDisplayPath } : transactionDir(operation.parentOperationPath, dirname(operation.displayPath));
  const candidate = decision.state === "regular" ? join(tx.operation, `candidate-${Date.now()}-${randomBytes(4).toString("hex")}`) : undefined;
  try {
    validateTransactionDirectory(tx);
    if (candidate) {
      const regularDecision = decision as Extract<ConnectorLeafDecision, { state: "regular" }>;
      stageCandidate(candidate, regularDecision.content, regularDecision.mode);
    }
    let hold: string | undefined;
    if (expected.state === "regular") {
      const holdName = priorReceipt ? `superseded-${randomBytes(4).toString("hex")}` : "initial";
      hold = join(tx.operation, holdName);
      renameSync(operation.operationPath, hold);
      const claimed = captureConnectorLeaf(operation.displayPath, hold);
      if (!stateEqual(claimed, expected)) {
        try { linkSync(hold, operation.operationPath); } catch { /* retain recovery artifact */ }
        throw new Error(`Connector leaf claim validation failed at ${operation.displayPath}`);
      }
    }
    if (decision.state === "regular") {
      try { linkSync(candidate!, operation.operationPath); }
      catch (error) { throw error; }
      const publicState = captureConnectorLeaf(operation.displayPath, operation.operationPath);
      const candidateState = captureConnectorLeaf(operation.displayPath, candidate!);
      if (!stateEqual(publicState, candidateState)) {
        unlinkPublicIfExact(operation.operationPath, candidate!, operation.displayPath);
        throw new Error(`Connector candidate publication verification failed at ${operation.displayPath}`);
      }
      const receipt: ConnectorLeafReceipt = {
        displayPath: operation.displayPath,
        operationPath: operation.operationPath,
        parentOperationPath: operation.parentOperationPath,
        initial: priorReceipt?.initial ?? expected,
        current: publicState,
        transactionDisplayPath: tx.display,
        transactionOperationPath: tx.operation,
        initialHoldOperationPath: priorReceipt?.initialHoldOperationPath ?? (expected.state === "regular" ? hold : undefined),
        currentHoldOperationPath: candidate,
        mutationCommitted: true,
        recoveryRequired: false,
      };
      if (priorReceipt?.currentHoldOperationPath && priorReceipt.currentHoldOperationPath !== candidate) safeUnlink(priorReceipt.currentHoldOperationPath);
      if (hold && hold !== receipt.initialHoldOperationPath) safeUnlink(hold);
      return { changed: true, content: decision.content, receipt };
    }
    const receipt: ConnectorLeafReceipt = {
      displayPath: operation.displayPath,
      operationPath: operation.operationPath,
      parentOperationPath: operation.parentOperationPath,
      initial: priorReceipt?.initial ?? expected,
      current: { state: "absent" },
      transactionDisplayPath: tx.display,
      transactionOperationPath: tx.operation,
      initialHoldOperationPath: priorReceipt?.initialHoldOperationPath ?? (expected.state === "regular" ? hold : undefined),
      currentHoldOperationPath: hold,
      mutationCommitted: true,
      recoveryRequired: false,
    };
    if (priorReceipt?.currentHoldOperationPath && priorReceipt.currentHoldOperationPath !== hold) safeUnlink(priorReceipt.currentHoldOperationPath);
    return { changed: true, receipt };
  } catch (error) {
    if (candidate) { try { safeUnlink(candidate); } catch { /* preserve primary */ } }
    if (!priorReceipt) { try { rmdirSync(tx.operation); } catch { /* preserve recovery namespace */ } }
    throw sanitizeLeafError(error, operation, tx);
  }
}

export function compensateConnectorLeaf(receipt: ConnectorLeafReceipt): readonly string[] {
  const failures: string[] = [];
  try {
    if (!receipt.mutationCommitted) return failures;
    if (receipt.current.state === "regular") {
      const now = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
      if (!stateEqual(now, receipt.current)) throw new Error("current receipt changed");
      const rollbackHold = join(receipt.transactionOperationPath, `rollback-${randomBytes(4).toString("hex")}`);
      renameSync(receipt.operationPath, rollbackHold);
      const claimed = captureConnectorLeaf(receipt.displayPath, rollbackHold);
      if (!stateEqual(claimed, receipt.current)) throw new Error("current receipt changed after rollback claim");
      if (receipt.initial.state === "regular") {
        if (!receipt.initialHoldOperationPath) throw new Error("initial hold unavailable");
        linkSync(receipt.initialHoldOperationPath, receipt.operationPath);
        const restored = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
        if (!stateEqual(restored, receipt.initial)) throw new Error("initial receipt restoration mismatch");
      }
      safeUnlink(rollbackHold);
    } else if (receipt.initial.state === "regular") {
      if (!receipt.initialHoldOperationPath) throw new Error("initial hold unavailable");
      const now = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
      if (now.state !== "absent") throw new Error("current receipt changed");
      linkSync(receipt.initialHoldOperationPath, receipt.operationPath);
      const restored = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
      if (!stateEqual(restored, receipt.initial)) throw new Error("initial receipt restoration mismatch");
    } else {
      const now = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
      if (now.state !== "absent") throw new Error("current receipt changed");
    }
  } catch (error) {
    receipt.recoveryRequired = true;
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${receipt.displayPath}: rollback incomplete (${message})`);
  }
  return failures;
}

export function finalizeConnectorLeaf(receipt: ConnectorLeafReceipt): readonly string[] {
  const failures: string[] = [];
  for (const path of new Set([receipt.currentHoldOperationPath, receipt.initialHoldOperationPath])) {
    if (!path) continue;
    try { safeUnlink(path); } catch (error) { failures.push(`${receipt.displayPath}: cleanup failed at ${receipt.transactionDisplayPath}`); }
  }
  try { rmdirSync(receipt.transactionOperationPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(`${receipt.displayPath}: cleanup failed at ${receipt.transactionDisplayPath}`); }
  return failures;
}

export type ConnectorLeafMutationResult = Readonly<{ changed: boolean; content?: Buffer; receipt: ConnectorLeafReceipt }>;

export function removeCodexHooks(hooksPath: string): boolean {
  if (process.platform !== "linux") throw new Error("Connector filesystem mutation requires Linux proc-descriptor anchoring");
  const parent = dirname(hooksPath);
  let parentFd: number;
  try { parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    const wrapped = new Error(`Unable to inspect connector hooks parent at ${parent}`, { cause: error });
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") Object.assign(wrapped, { code });
    throw wrapped;
  }
  try {
    const operationPath = `/proc/self/fd/${parentFd}/${hooksPath.slice(parent.length + 1)}`;
    const parentOperationPath = `/proc/self/fd/${parentFd}`;
    const expected = captureConnectorLeaf(hooksPath, operationPath);
    if (expected.state === "absent") return false;
    let result: ConnectorLeafMutationResult;
    try {
      result = mutateConnectorLeaf({ displayPath: hooksPath, operationPath, parentOperationPath, expected, decide: (base) => {
      if (base.state !== "regular") throw new Error(`Codex hooks leaf is not regular at ${hooksPath}`);
      const decision = removeCodexHooksContent(base.content.toString("utf-8"));
      if (decision.state === "unchanged") return { state: "unchanged" };
      if (decision.state === "remove") return { state: "absent" };
      return { state: "regular", content: Buffer.from(decision.content, "utf-8"), mode: base.mode };
      }});
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replaceAll(operationPath, hooksPath).replaceAll(parentOperationPath, parent);
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
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
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
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(hooksPath, "utf-8"));
  } catch (error) {
    const state: CodexPostToolHookState = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "incomplete";
    return { path: hooksPath, state, structural: false };
  }

  const structural = hasExactPostToolHook(value);
  return { path: hooksPath, state: structural ? "installed" : "incomplete", structural };
}
