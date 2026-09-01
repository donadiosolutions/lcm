import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ConnectorTransport } from "./types.js";

export const CODEX_HOOKS_PATH = "~/.codex/hooks.json";
export const CODEX_CONFIG_PATH = "~/.codex/config.toml";
export const LEGACY_CODEX_HOOKS_PATHS = [".codex/hooks.json"] as const;

const MAX_CODEX_HOOKS_BYTES = 4 * 1024 * 1024;

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
  mkdirSync(dirname(hooksPath), { recursive: true });
  enableCodexHooksFeature(configPath);
  let existing = "";
  try { existing = readFileSync(hooksPath, "utf-8"); } catch { /* malformed/absent is treated as empty */ }
  writeFileSync(hooksPath, mergeCodexHooksContent(existing, transport));
}

type CodexHooksDescriptorIdentity = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
}>;

function assertCodexHooksMutationDescriptor(
  descriptor: number,
  hooksPath: string,
  identity: CodexHooksDescriptorIdentity,
): ReturnType<typeof fstatSync> {
  const stats = fstatSync(descriptor);
  if (!stats.isFile() || stats.dev !== identity.dev || stats.ino !== identity.ino) {
    throw new Error(`Codex hooks descriptor identity changed at ${hooksPath}`);
  }
  if (stats.nlink !== 1) {
    throw new Error(`Refusing connector mutation through a multiply linked file at ${hooksPath}`);
  }
  return stats;
}

function writeCodexHooksDescriptor(
  descriptor: number,
  hooksPath: string,
  identity: CodexHooksDescriptorIdentity,
  content: Buffer,
): void {
  assertCodexHooksMutationDescriptor(descriptor, hooksPath, identity);
  ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < content.length) {
    assertCodexHooksMutationDescriptor(descriptor, hooksPath, identity);
    const count = writeSync(descriptor, content, offset, content.length - offset, offset);
    if (count <= 0) throw new Error(`Codex hooks write made no progress at ${hooksPath}`);
    offset += count;
  }
}

function readCodexHooksDescriptor(
  descriptor: number,
  size: number,
): Buffer | undefined {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, bytes, offset, size - offset, offset);
    if (count <= 0) return undefined;
    offset += count;
  }
  return bytes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restoreCodexHooksDescriptor(
  descriptor: number,
  hooksPath: string,
  identity: CodexHooksDescriptorIdentity,
  content: Buffer,
  mode: number,
): void {
  writeCodexHooksDescriptor(descriptor, hooksPath, identity, content);
  assertCodexHooksMutationDescriptor(descriptor, hooksPath, identity);
  fchmodSync(descriptor, mode);
  const restoredStats = assertCodexHooksMutationDescriptor(descriptor, hooksPath, identity);
  if ((Number(restoredStats.mode) & 0o777) !== mode || restoredStats.size !== content.length) {
    throw new Error(`Codex hooks restoration verification failed at ${hooksPath}`);
  }
  const restored = readCodexHooksDescriptor(descriptor, content.length);
  if (!restored?.equals(content)) {
    throw new Error(`Codex hooks restoration verification failed at ${hooksPath}`);
  }
}

export function removeCodexHooks(hooksPath: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(
      hooksPath,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return false;
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) return false;
    if (before.nlink !== 1) {
      throw new Error(`Refusing connector mutation through a multiply linked file at ${hooksPath}`);
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0) return false;
    if (size > MAX_CODEX_HOOKS_BYTES) {
      throw new Error(`Refusing to read Codex hooks larger than 4 MiB at ${hooksPath}`);
    }
    const bytes = readCodexHooksDescriptor(descriptor, size);
    if (!bytes) return false;
    const result = removeCodexHooksContent(bytes.toString("utf-8"));
    if (result.state === "unchanged") return false;
    const updated = Buffer.from(result.state === "remove" ? "{}\n" : result.content, "utf-8");
    const identity = { dev: before.dev, ino: before.ino };
    try {
      writeCodexHooksDescriptor(descriptor, hooksPath, identity, updated);
    } catch (primaryError) {
      try {
        restoreCodexHooksDescriptor(
          descriptor,
          hooksPath,
          identity,
          bytes,
          Number(before.mode) & 0o777,
        );
      } catch (restorationError) {
        throw new Error(
          `Codex hooks restoration failed at ${hooksPath} after ${errorMessage(primaryError)}: ${errorMessage(restorationError)}`,
        );
      }
      throw primaryError;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino) return false;
    try {
      const publicStats = lstatSync(hooksPath);
      return publicStats.isFile() && publicStats.dev === before.dev && publicStats.ino === before.ino;
    } catch {
      return false;
    }
  } finally {
    closeSync(descriptor);
  }
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
