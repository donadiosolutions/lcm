// src/connectors/codex-readiness.ts
// Static, read-only report of whether the installed LCM Codex hooks can run.
// It reads the base user hooks.json and config.toml; it never writes Codex state.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readBoundedRegularFileWithStat } from "../security-files.js";
import { readCodexHookReceipts, type CodexHookReceipt } from "../hooks/codex-hook-receipts.js";
import { classifyCodexHooksFeatureScan, scanCodexConfigToml, type CodexTomlScan } from "./codex-config-toml.js";
import {
  codexLcmHookRole,
  codexLcmHooks,
  parseCodexHooksJson,
  type CodexHookGroup,
  type CodexHooksJsonPath,
} from "./codex-hooks.js";
import type { ConnectorTransport } from "./types.js";

export const CODEX_MIN_VERSION = "0.163.0";
const MAX_READINESS_FILE_BYTES = 4 * 1024 * 1024;
const OBSERVATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OBSERVATION_MAX_SKEW_MS = 5 * 60 * 1000;

const EVENT_SNAKE: Readonly<Record<string, string>> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt",
};

const EVENT_CAPABILITY: Readonly<Record<string, string>> = {
  PreToolUse: "recall LCM memory before tool use",
  PermissionRequest: "LCM permission-request handling",
  PostToolUse: "record tool context",
  PreCompact: "save memory before compaction",
  PostCompact: "LCM post-compaction handling",
  SessionStart: "restore LCM memory at session start",
  SessionEnd: "save memory when a session ends",
  UserPromptSubmit: "search LCM memory on each prompt",
  SubagentStart: "restore LCM memory for subagents",
  SubagentStop: "LCM subagent shutdown handling",
  Stop: "save a session snapshot when a turn ends",
  Interrupt: "LCM interrupt handling",
};

const EVENTS_WITHOUT_MATCHER: ReadonlySet<string> = new Set(["UserPromptSubmit", "Stop", "Interrupt"]);
const EVENTS_WITH_CONTEXT_LIMIT: ReadonlySet<string> = new Set([
  "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart",
]);
const DEFAULT_CONTEXT_LIMIT = 2500;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function normalizedTimeout(eventName: string, timeout: unknown): number {
  const configured = typeof timeout === "number" ? timeout : undefined;
  if (eventName === "SessionEnd" || eventName === "Interrupt") {
    return Math.min(3, Math.max(1, configured ?? 1));
  }
  return Math.max(1, configured ?? 600);
}

/**
 * Codex's trust identity: sha256 of the key-sorted JSON of the normalized
 * single-handler identity (verified against Codex 0.163.0 hooks/list output).
 */
export function computeCodexHookHash(
  eventName: string,
  group: { readonly matcher?: unknown },
  handler: Readonly<Record<string, unknown>>,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const snake = EVENT_SNAKE[eventName];
  if (snake === undefined || handler.type !== "command" || typeof handler.command !== "string") return undefined;
  const windowsCommand = handler.commandWindows ?? handler.command_windows;
  const command = platform === "win32" && typeof windowsCommand === "string"
    ? windowsCommand
    : handler.command;
  const normalized: Record<string, unknown> = {
    type: "command",
    command,
    timeout: normalizedTimeout(eventName, handler.timeout),
    async: handler.async === true,
  };
  if (typeof handler.statusMessage === "string") normalized.statusMessage = handler.statusMessage;
  const limit = handler.additionalContextLimit;
  if (EVENTS_WITH_CONTEXT_LIMIT.has(eventName) && typeof limit === "number" && limit !== DEFAULT_CONTEXT_LIMIT) {
    normalized.additionalContextLimit = limit;
  }
  const identity: Record<string, unknown> = { event_name: snake, hooks: [normalized] };
  if (!EVENTS_WITHOUT_MATCHER.has(eventName) && typeof group.matcher === "string") identity.matcher = group.matcher;
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonicalize(identity))).digest("hex");
}

export type CodexHookStatus =
  | "ready" | "missing" | "disabled" | "untrusted" | "modified" | "state-unknown"
  | "feature-disabled" | "hooks-file-unreadable" | "failing" | "degraded";

export type CodexFileRead =
  | { readonly state: "absent" }
  | { readonly state: "unreadable" }
  | { readonly state: "content"; readonly content: string; readonly mtimeMs: number };

export type CodexVersionProbe =
  | { readonly state: "found"; readonly raw: string }
  | { readonly state: "unavailable"; readonly reason: string };

export type CodexTransportLookup =
  | { readonly state: "stored"; readonly transport: ConnectorTransport }
  | { readonly state: "none" }
  | { readonly state: "error"; readonly reason: string };

export interface CodexReadinessInput {
  readonly hooksPath: string;
  readonly hooks: CodexFileRead;
  readonly config: CodexFileRead;
  readonly receipts: readonly CodexHookReceipt[];
  readonly version: CodexVersionProbe;
  readonly storedTransport: CodexTransportLookup;
  readonly now: number;
  readonly platform?: NodeJS.Platform;
  /** The opt-in PreToolUse role is expected only while hooks.preToolRecall is enabled. */
  readonly preToolRecall?: boolean;
  /** Test seam: replaces the default required LCM definitions. */
  readonly expected?: Record<string, CodexHookGroup[]>;
}

export interface CodexReadinessRow {
  readonly event: string;
  readonly role: string;
  readonly status: CodexHookStatus;
  readonly key?: string;
  readonly drift: boolean;
  readonly observation?: CodexHookReceipt;
}

export type CodexClientCompatibility =
  | { readonly state: "compatible"; readonly raw: string }
  | { readonly state: "incompatible"; readonly raw: string }
  | { readonly state: "unknown"; readonly reason: string };

export interface CodexReadinessReport {
  readonly hooksPath: string;
  readonly rows: readonly CodexReadinessRow[];
  readonly client: CodexClientCompatibility;
  readonly transportNote?: string;
}

interface InstalledHandler {
  readonly event: string;
  readonly groupIndex: number;
  readonly handlerIndex: number;
  readonly role: string;
  readonly group: { readonly matcher?: unknown };
  readonly handler: Readonly<Record<string, unknown>>;
  readonly command: boolean;
}

const KNOWN_HANDLER_TYPES: ReadonlySet<string> = new Set(["command", "mcp_tool", "prompt", "agent"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optional(value: unknown, valid: (value: unknown) => boolean): boolean {
  return value === undefined || value === null || valid(value);
}

const isString = (value: unknown): boolean => typeof value === "string";
const isCount = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const I64_LIMIT = 2 ** 63;

/** Codex converts an mcp_tool input map to TOML, which has no null. */
function tomlRepresentable(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "boolean") return true;
  // JSON cannot say whether a large integral number is an integer or a float, so anything TOML
  // could not store as an i64 (or a finite float) fails closed.
  if (typeof value === "number") return Number.isFinite(value) && !(Number.isInteger(value) && Math.abs(value) >= I64_LIMIT);
  if (Array.isArray(value)) return value.every(tomlRepresentable);
  return isRecord(value) && Object.values(value).every(tomlRepresentable);
}

/** A timeout or limit must be a safe unsigned integer written as one (no sign, fraction or exponent). */
function optionalCount(handler: Record<string, unknown>, field: string, notIntegerToken: (field: string) => boolean): boolean {
  return optional(handler[field], (value) => isCount(value) && !notIntegerToken(field));
}

function validHandler(handler: unknown, notIntegerToken: (field: string) => boolean): handler is Record<string, unknown> {
  if (!isRecord(handler) || typeof handler.type !== "string" || !KNOWN_HANDLER_TYPES.has(handler.type)) return false;
  // Codex defines prompt and agent handlers as empty variants and ignores their timeout, so only
  // command and mcp_tool timeouts need the integer token.
  const timeoutValid = handler.type === "command" || handler.type === "mcp_tool"
    ? optionalCount(handler, "timeout", notIntegerToken)
    : optional(handler.timeout, isCount);
  if (!timeoutValid || !optional(handler.statusMessage, isString)) return false;
  if (handler.type === "mcp_tool") {
    return isString(handler.server) && isString(handler.tool)
      && (handler.input === undefined || (isRecord(handler.input) && tomlRepresentable(handler.input)));
  }
  if (handler.type !== "command") return true;
  // commandWindows and its command_windows alias map to one field: both present is a duplicate.
  return isString(handler.command)
    && optional(handler.commandWindows, isString)
    && optional(handler.command_windows, isString)
    && (handler.commandWindows === undefined || handler.command_windows === undefined)
    && (handler.async === undefined || typeof handler.async === "boolean")
    && optionalCount(handler, "additionalContextLimit", notIntegerToken);
}

/**
 * The members each handler variant's Codex struct knows (HookHandlerConfig in codex-rs/config/src/hook_config.rs),
 * plus the "type" tag. Both spellings of commandWindows are listed because serde maps them to one field. Codex's
 * prompt and agent variants are empty structs, so only the tag is known there.
 */
const KNOWN_HANDLER_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["command", new Set(["type", "command", "commandWindows", "command_windows", "timeout", "async", "statusMessage", "additionalContextLimit"])],
  ["mcp_tool", new Set(["type", "server", "tool", "input", "timeout", "statusMessage"])],
  ["prompt", new Set(["type"])],
  ["agent", new Set(["type"])],
]);

/** The value the parsed document holds at path, or undefined when a repeated ancestor member replaced it. */
function valueAt(root: unknown, path: CodexHooksJsonPath): unknown {
  let node = root;
  for (const segment of path) {
    node = Array.isArray(node) || isRecord(node) ? (node as Record<string | number, unknown>)[segment] : undefined;
  }
  return node;
}

/**
 * True when a member repeated inside a typed object is one Codex's serde struct for that object knows, which makes
 * its derived visitor fail with duplicate_field. A repeated member it does not know is discarded without a check,
 * so Codex loads the file. The root is the exception: HooksFile denies unknown fields, so any root repeat fails.
 * Repeats below an unknown event are discarded with the rest of that event, and a repeat under a shape Codex
 * cannot deserialize is already rejected by the shape validation that follows.
 */
function repeatsKnownMember(root: unknown, { path, name }: { readonly path: CodexHooksJsonPath; readonly name: string }): boolean {
  if (path.length === 0) return true;
  if (path[0] !== "hooks") return false;
  if (path.length === 1) return Object.hasOwn(EVENT_SNAKE, name);
  const event = path[1];
  if (typeof event !== "string" || !Object.hasOwn(EVENT_SNAKE, event)) return false;
  if (path.length === 3) return name === "matcher" || name === "hooks";
  if (path.length !== 5 || path[3] !== "hooks") return false;
  const handler = valueAt(root, path);
  // A repeated "type" is always a duplicate_field error, so the final tag below is not ambiguous.
  if (!isRecord(handler) || typeof handler.type !== "string") return false;
  return KNOWN_HANDLER_MEMBERS.get(handler.type)?.has(name) === true;
}

/** Parse hooks.json with the strictness of Codex's typed schema; undefined means Codex would reject it. */
function parseInstalledHandlers(content: string): InstalledHandler[] | undefined {
  const strict = parseCodexHooksJson(content);
  if (strict === undefined || strict.duplicates.some((duplicate) => repeatsKnownMember(strict.value, duplicate))) return undefined;
  const value = strict.value;
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => key !== "hooks" && key !== "description")) return undefined;
  if (!optional(value.description, isString)) return undefined;
  if (value.hooks !== undefined && !isRecord(value.hooks)) return undefined;
  const found: InstalledHandler[] = [];
  for (const event of Object.keys(EVENT_SNAKE)) {
    const groups = value.hooks?.[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) return undefined;
    for (const [groupIndex, group] of groups.entries()) {
      if (!isRecord(group) || !optional(group.matcher, isString)) return undefined;
      if (group.hooks !== undefined && !Array.isArray(group.hooks)) return undefined;
      for (const [handlerIndex, handler] of (group.hooks ?? []).entries()) {
        const handlerPath: CodexHooksJsonPath = ["hooks", event, groupIndex, "hooks", handlerIndex];
        if (!validHandler(handler, (field) => strict.nonIntegerNumberAt([...handlerPath, field]))) return undefined;
        const role = codexLcmHookRole(handler.command);
        if (role !== undefined) {
          found.push({
            event, groupIndex, handlerIndex, group,
            role,
            handler,
            command: handler.type === "command",
          });
        }
      }
    }
  }
  return found;
}

function parseVersion(raw: string): { major: number; minor: number; patch: number; pre: boolean } | undefined {
  // The version is the token after "codex"/"codex-cli", or the whole output's last token.
  const tokens = raw.trim().split(/\s+/);
  const named = tokens.findIndex((token) => token === "codex" || token === "codex-cli");
  const candidate = named >= 0 && named + 1 < tokens.length ? tokens[named + 1] : tokens[tokens.length - 1];
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(candidate);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] !== undefined };
}

function clientCompatibility(version: CodexVersionProbe): CodexClientCompatibility {
  if (version.state === "unavailable") return { state: "unknown", reason: version.reason };
  const parsed = parseVersion(version.raw);
  if (parsed === undefined) return { state: "unknown", reason: "codex --version output was not recognised" };
  const minimum = parseVersion(CODEX_MIN_VERSION)!;
  const order = parsed.major - minimum.major || parsed.minor - minimum.minor || parsed.patch - minimum.patch;
  const compatible = order > 0 || (order === 0 && !parsed.pre);
  return compatible ? { state: "compatible", raw: version.raw } : { state: "incompatible", raw: version.raw };
}

type FeatureState = "enabled" | "disabled" | "unknown";

function featureState(config: CodexFileRead, scan: CodexTomlScan): FeatureState {
  if (config.state === "unreadable") return "unknown";
  const feature = classifyCodexHooksFeatureScan(scan);
  if (feature === "unrecognized") return "unknown";
  return feature === "explicit-false" ? "disabled" : "enabled";
}

function freshObservation(
  receipts: readonly CodexHookReceipt[],
  event: string,
  hooksMtimeMs: number,
  now: number,
): CodexHookReceipt | undefined {
  return receipts.find((receipt) =>
    receipt.event === event
    && receipt.completedAt > hooksMtimeMs
    && now - receipt.completedAt < OBSERVATION_MAX_AGE_MS
    && receipt.completedAt - now <= OBSERVATION_MAX_SKEW_MS);
}

function installedUserPromptTransport(installed: readonly InstalledHandler[]): ConnectorTransport | undefined {
  const prompt = installed.find((entry) => entry.event === "UserPromptSubmit" && entry.role === "user-prompt" && entry.command);
  if (prompt === undefined) return undefined;
  return /--transport\s+mcp\b/.test(prompt.handler.command as string) ? "mcp" : "cli";
}

function roleKey(event: string, role: string): string {
  return event + "\u0000" + role;
}

/** Evaluate every installed LCM handler and every missing default-required role. */
export function inspectCodexReadiness(input: CodexReadinessInput): CodexReadinessReport {
  const platform = input.platform ?? process.platform;
  const client = clientCompatibility(input.version);
  const installed = input.hooks.state === "content" ? parseInstalledHandlers(input.hooks.content) : [];
  let transportNote: string | undefined;
  let transport: ConnectorTransport | undefined;
  if (input.storedTransport.state === "stored") {
    transport = input.storedTransport.transport;
  } else {
    if (input.storedTransport.state === "error") {
      transportNote = "stored connector transport unreadable (" + input.storedTransport.reason
        + "); expected user-prompt transport inferred from the installed hook";
    }
    transport = installedUserPromptTransport(installed ?? []);
  }
  const expected = input.expected ?? codexLcmHooks(transport ?? "cli", { preToolRecall: input.preToolRecall });
  const expectedRoles = new Map<string, string | undefined>();
  for (const [event, groups] of Object.entries(expected)) {
    for (const group of groups) {
      for (const hook of group.hooks!) {
        expectedRoles.set(roleKey(event, codexLcmHookRole(hook.command)!), computeCodexHookHash(event, group, hook, platform));
      }
    }
  }
  const expectedList = [...expectedRoles.keys()].map((key) => {
    const [event, role] = key.split("\u0000");
    return { event, role };
  });

  if (input.hooks.state === "unreadable" || installed === undefined) {
    return {
      hooksPath: input.hooksPath,
      client,
      transportNote,
      rows: expectedList.map(({ event, role }) => ({ event, role, status: "hooks-file-unreadable" as const, drift: false })),
    };
  }

  const scan = scanCodexConfigToml(input.config.state === "content" ? input.config.content : "");
  const feature = featureState(input.config, scan);
  const hooksMtimeMs = input.hooks.state === "content" ? input.hooks.mtimeMs : 0;
  const rows: CodexReadinessRow[] = installed.map((entry) => {
    const key = input.hooksPath + ":" + EVENT_SNAKE[entry.event] + ":" + entry.groupIndex + ":" + entry.handlerIndex;
    const hash = entry.command ? computeCodexHookHash(entry.event, entry.group, entry.handler, platform) : undefined;
    const wanted = roleKey(entry.event, entry.role);
    const drift = expectedRoles.has(wanted) && hash !== expectedRoles.get(wanted);
    const base = { event: entry.event, role: entry.role, key, drift };
    if (feature === "disabled") return { ...base, status: "feature-disabled" };
    const fields = scan.states.get(key);
    if (
      feature === "unknown" || scan.statesUnknown || !entry.command
      || fields?.enabled === "unknown" || fields?.trustedHash === "unknown"
    ) return { ...base, status: "state-unknown" };
    if (fields?.enabled === false) return { ...base, status: "disabled" };
    if (fields?.trustedHash === undefined) return { ...base, status: "untrusted" };
    if (fields.trustedHash !== hash) return { ...base, status: "modified" };
    const observation = freshObservation(input.receipts, entry.event, hooksMtimeMs, input.now);
    if (observation?.outcome === "exit-nonzero" || observation?.outcome === "threw") {
      return { ...base, status: "failing", observation };
    }
    if (observation?.loggedErrors) return { ...base, status: "degraded", observation };
    return { ...base, status: "ready", ...(observation === undefined ? {} : { observation }) };
  });
  for (const { event, role } of expectedList) {
    if (!installed.some((entry) => entry.event === event && entry.role === role)) {
      rows.push({ event, role, status: feature === "disabled" ? "feature-disabled" : "missing", drift: false });
    }
  }
  return { hooksPath: input.hooksPath, client, transportNote, rows };
}

function capability(event: string): string {
  return EVENT_CAPABILITY[event] ?? "LCM lifecycle capability";
}

function observed(receipt: CodexHookReceipt): string {
  return "last persisted LCM-local observation at " + new Date(receipt.completedAt).toISOString() + " (unauthenticated)";
}

function rowDetail(row: CodexReadinessRow): string {
  switch (row.status) {
    case "missing":
      return 'not installed; run "lcm connectors install codex --global"';
    case "disabled":
      return "disabled in Codex (your choice is preserved; LCM never changes it); re-enable in Codex /hooks to "
        + "regain this capability: " + capability(row.event);
    case "untrusted":
      return "awaiting trust; review and trust in Codex /hooks; it will not run unless trusted "
        + "(or Codex is launched with hook-trust bypass)";
    case "modified":
      return "definition changed since you trusted it; Codex requires renewed review in /hooks";
    case "state-unknown":
      return "could not read Codex hook state in config.toml (unsupported form); check /hooks";
    case "failing": {
      const receipt = row.observation!;
      const how = receipt.outcome === "threw" ? "with an error" : "with exit code " + String(receipt.exitCode);
      return "handler exited " + how + "; " + observed(receipt);
    }
    case "degraded":
      return "handler exited 0 but reported errors through the best-effort hook error channel "
        + "(see ~/.lcm/logs/events.log or lcm doctor); " + observed(row.observation!);
    default:
      return "enabled and trusted in base user config (static check only)"
        + (row.observation === undefined ? "" : "; handler exited 0; " + observed(row.observation));
  }
}

const FAILING_STATUSES: ReadonlySet<CodexHookStatus> = new Set([
  "missing", "disabled", "untrusted", "modified", "state-unknown", "failing",
]);

export function formatCodexReadiness(report: CodexReadinessReport): { lines: string[]; failures: number } {
  const lines: string[] = [];
  let failures = 0;
  const { client } = report;
  if (client.state === "compatible") {
    lines.push("  ✓ Codex: codex CLI on PATH is " + client.raw);
  } else if (client.state === "incompatible") {
    lines.push("  ✗ Codex: codex CLI on PATH is " + client.raw + "; LCM requires Codex " + CODEX_MIN_VERSION
      + " or later; desktop/IDE builds may differ");
    failures += 1;
  } else {
    lines.push("  ⚠ Codex: could not determine the codex CLI version (" + client.reason + "); LCM requires Codex "
      + CODEX_MIN_VERSION + " or later");
  }
  if (report.transportNote !== undefined) lines.push("  ⚠ Codex: " + report.transportNote);

  const unreadable = report.rows.some((row) => row.status === "hooks-file-unreadable");
  const featureOff = report.rows.some((row) => row.status === "feature-disabled");
  const unavailable = new Set<string>();
  if (unreadable) {
    lines.push("  ✗ Codex: " + report.hooksPath + " is unreadable or malformed; fix the file (or move it aside), then reinstall (Codex ignores it with a warning)");
    failures += 1;
    for (const row of report.rows) unavailable.add(capability(row.event));
  } else if (featureOff) {
    lines.push("  ✗ Codex: [features] hooks is disabled; all LCM lifecycle capabilities unavailable; LCM left it unchanged");
    failures += 1;
    for (const row of report.rows) unavailable.add(capability(row.event));
  }
  for (const row of report.rows) {
    if (row.status === "hooks-file-unreadable" || row.status === "feature-disabled") continue;
    const failing = FAILING_STATUSES.has(row.status);
    lines.push("  " + (failing ? "✗" : row.status === "degraded" ? "⚠" : "✓") + " Codex: " + row.event
      + " hook (" + capability(row.event) + "): " + rowDetail(row));
    if (failing) {
      failures += 1;
      unavailable.add(capability(row.event));
    }
    if (row.drift) lines.push("  ⚠ Codex: " + row.event + " hook differs from current LCM definition; reinstall");
  }
  if (unavailable.size > 0) lines.push("  Codex: unavailable LCM capabilities: " + [...unavailable].join(", "));
  lines.push("  Codex: checked base user config; profile layers, session flags and managed requirements are not visible");
  lines.push("  Codex: operational verification is not established by doctor");
  return { lines, failures };
}

/** One-descriptor bounded read of a Codex config file, distinguishing absence from unreadability. */
export function readCodexReadinessFile(path: string): CodexFileRead {
  try {
    const file = readBoundedRegularFileWithStat(path, { allowedRoot: dirname(path), maxBytes: MAX_READINESS_FILE_BYTES });
    return { state: "content", content: file.content, mtimeMs: file.mtimeMs };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unreadable" };
  }
}

export interface CodexReadinessCheckOptions {
  readonly homeDir: string;
  readonly probeVersion: () => CodexVersionProbe;
  readonly readStoredTransport: () => ConnectorTransport | undefined;
  /** Whether hooks.preToolRecall is enabled; an unreadable setting counts as disabled. */
  readonly readPreToolRecall?: () => boolean;
  readonly now?: () => number;
  readonly readReceipts?: () => readonly CodexHookReceipt[];
}

/** Gather the on-disk inputs and format the doctor lines. */
export function runCodexReadinessCheck(options: CodexReadinessCheckOptions): { lines: string[]; failures: number } {
  const codexHome = join(options.homeDir, ".codex");
  const hooksPath = join(codexHome, "hooks.json");
  let storedTransport: CodexTransportLookup;
  try {
    const transport = options.readStoredTransport();
    storedTransport = transport === undefined ? { state: "none" } : { state: "stored", transport };
  } catch {
    storedTransport = { state: "error", reason: "could not be read" };
  }
  let preToolRecall = false;
  try {
    preToolRecall = options.readPreToolRecall?.() === true;
  } catch {
    preToolRecall = false;
  }
  let receipts: readonly CodexHookReceipt[];
  try {
    receipts = (options.readReceipts ?? readCodexHookReceipts)();
  } catch {
    receipts = [];
  }
  return formatCodexReadiness(inspectCodexReadiness({
    hooksPath,
    hooks: readCodexReadinessFile(hooksPath),
    config: readCodexReadinessFile(join(codexHome, "config.toml")),
    receipts,
    version: options.probeVersion(),
    storedTransport,
    preToolRecall,
    now: (options.now ?? Date.now)(),
  }));
}
