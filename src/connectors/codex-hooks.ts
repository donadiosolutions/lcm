import {
  closeSync,
  chmodSync,
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
import { strict as assert } from "node:assert";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ConnectorTransport } from "./types.js";
import { addCodexHooksFeature, classifyCodexHooksFeature } from "./codex-config-toml.js";

export const CODEX_HOOKS_PATH = "~/.codex/hooks.json";
export const CODEX_CONFIG_PATH = "~/.codex/config.toml";
export const LEGACY_CODEX_HOOKS_PATHS = [".codex/hooks.json"] as const;


export type CodexPostToolHookState = "absent" | "incomplete" | "installed";

export interface CodexPostToolHookInspection {
  readonly path: string;
  readonly state: CodexPostToolHookState;
  readonly structural: boolean;
}

export type CodexCommandHook = {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
  [key: string]: unknown;
};

export type CodexHookGroup = {
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

/** Optional Codex hook registrations; callers resolve the value, generators never read config. */
export interface CodexLcmHookOptions {
  /** Register the opt-in PreToolUse memory hint hook (default off). */
  readonly preToolRecall?: boolean;
}

/** Tools whose pending call the opt-in PreToolUse hook can derive a memory query from. */
const PRE_TOOL_RECALL_MATCHER = "^(Bash|apply_patch|mcp__.*)$";

export function codexLcmHooks(
  transport: ConnectorTransport = "cli",
  options: CodexLcmHookOptions = {},
): Record<string, CodexHookGroup[]> {
  const hooks: Record<string, CodexHookGroup[]> = {
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact|fork",
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
    SubagentStart: [
      {
        hooks: [
          {
            type: "command",
            command: lcmCommand("restore"),
            timeout: 30,
            statusMessage: "Loading LCM memory for subagent",
          },
        ],
      },
    ],
    SubagentStop: [
      {
        hooks: [
          {
            type: "command",
            command: lcmCommand("session-snapshot"),
            timeout: 30,
            statusMessage: "Saving LCM subagent memory",
          },
        ],
      },
    ],
    // Codex clamps Interrupt and SessionEnd command hooks to 1..3 seconds and
    // kills the process group at the cap, so 3 is the most these can use.
    Interrupt: [
      {
        hooks: [
          {
            type: "command",
            command: `${lcmCommand("session-snapshot")} --terminal`,
            timeout: 3,
            statusMessage: "Saving LCM memory after interruption",
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: "command",
            command: `${lcmCommand("session-snapshot")} --terminal`,
            timeout: 3,
            statusMessage: "Saving LCM memory before session end",
          },
        ],
      },
    ],
  };
  if (options.preToolRecall === true) {
    hooks.PreToolUse = [
      {
        matcher: PRE_TOOL_RECALL_MATCHER,
        hooks: [
          {
            type: "command",
            command: lcmCommand("pre-tool"),
            timeout: 5,
            statusMessage: "Checking LCM memory for this action",
          },
        ],
      },
    ];
  }
  return hooks;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Structural path from the document root: object member names and array indices. */
export type CodexHooksJsonPath = ReadonlyArray<string | number>;

export interface CodexHooksJson {
  /** What JSON.parse returns; a repeated member keeps its last value. */
  readonly value: unknown;
  /**
   * One entry per repeated member name, compared after unescaping, with the path of the object that
   * repeats it. Objects deeper than every typed object (more than TYPED_OBJECT_PATH_DEPTH segments)
   * contribute only their first repeat in the document, so the list stays small on adversarial input.
   */
  readonly duplicates: ReadonlyArray<{ readonly path: CodexHooksJsonPath; readonly name: string }>;
  /**
   * True when the number written at path is not an unsigned integer token (a sign, fraction or exponent).
   * Only the handler count fields are tracked, at ["hooks", <event>, <group index>, "hooks", <handler index>,
   * "timeout" | "additionalContextLimit"]; every other path is false. A field written more than once is true
   * when any of its occurrences is not an unsigned integer token.
   */
  readonly nonIntegerNumberAt: (path: CodexHooksJsonPath) => boolean;
}

const UNSIGNED_INTEGER_TOKEN = /^(?:0|[1-9][0-9]*)$/;
const NUMBER_TOKEN_CHAR = /[0-9eE+\-.]/;
/** hooks / event / group / hooks / handler / field: the only numbers the connector reads. */
const HANDLER_FIELD_PATH_DEPTH = 6;
const HANDLER_COUNT_FIELDS: ReadonlySet<string> = new Set(["timeout", "additionalContextLimit"]);
/** root, hooks, group and handler objects: the deepest object path the connector checks. */
const TYPED_OBJECT_PATH_DEPTH = 5;

type Segment = string | number;
type Frame = { readonly object: boolean; readonly names: Set<string>; key: string; index: number; expectKey: boolean };
/** event -> group index -> handler index -> count fields written with a non-integer spelling. */
type NonIntegerFields = Map<Segment, Map<Segment, Map<Segment, Set<Segment>>>>;

function entryOf<Key, Value>(map: Map<Key, Value>, key: Key, create: () => Value): Value {
  const found = map.get(key);
  if (found !== undefined) return found;
  const created = create();
  map.set(key, created);
  return created;
}

/**
 * The handler count field a number is being read for, decided from the open frames alone:
 * object (root) / object (hooks) / array (groups) / object (group) / array (handlers) / object (handler).
 */
function handlerCountField(stack: readonly Frame[]): string | undefined {
  if (stack.length !== HANDLER_FIELD_PATH_DEPTH) return undefined;
  const [root, hooks, groups, group, handlers, handler] = stack;
  if (!root.object || !hooks.object || groups.object || !group.object || handlers.object || !handler.object) {
    return undefined;
  }
  if (root.key !== "hooks" || group.key !== "hooks") return undefined;
  return HANDLER_COUNT_FIELDS.has(handler.key) ? handler.key : undefined;
}

/**
 * Read hooks.json text with JSON.parse for syntax and values, then walk the same text
 * once, iteratively, for what JSON.parse discards: repeated member names and how each
 * number was written. Undefined means the text is not valid JSON.
 */
export function parseCodexHooksJson(content: string): CodexHooksJson | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  const segment = (frame: Frame): string | number => (frame.object ? frame.key : frame.index);
  const stack: Frame[] = [];
  const duplicates: Array<{ path: CodexHooksJsonPath; name: string }> = [];
  let deepDuplicateSeen = false;
  const nonInteger: NonIntegerFields = new Map();
  let at = 0;
  while (at < content.length) {
    const char = content[at];
    const top = stack[stack.length - 1];
    if (char === "{" || char === "[") {
      stack.push({ object: char === "{", names: new Set(), key: "", index: 0, expectKey: char === "{" });
      at += 1;
    } else if (char === "}" || char === "]") {
      stack.pop();
      at += 1;
    } else if (char === ",") {
      if (top.object) top.expectKey = true;
      else top.index += 1;
      at += 1;
    } else if (char === '"') {
      let end = at + 1;
      while (content[end] !== '"') end += content[end] === "\\" ? 2 : 1;
      if (top?.object && top.expectKey) {
        const name = JSON.parse(content.slice(at, end + 1)) as string;
        if (top.names.has(name) && (stack.length - 1 <= TYPED_OBJECT_PATH_DEPTH || !deepDuplicateSeen)) {
          if (stack.length - 1 > TYPED_OBJECT_PATH_DEPTH) deepDuplicateSeen = true;
          duplicates.push({ path: stack.slice(0, -1).map(segment), name });
        }
        top.names.add(name);
        top.key = name;
        top.expectKey = false;
      }
      at = end + 1;
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      let end = at + 1;
      while (end < content.length && NUMBER_TOKEN_CHAR.test(content[end])) end += 1;
      const field = handlerCountField(stack);
      if (field !== undefined && !UNSIGNED_INTEGER_TOKEN.test(content.slice(at, end))) {
        const [, hooks, groups, , handlers] = stack;
        const groupsOfEvent = entryOf(nonInteger, hooks.key, () => new Map());
        const handlersOfGroup = entryOf(groupsOfEvent, groups.index, () => new Map());
        entryOf(handlersOfGroup, handlers.index, () => new Set()).add(field);
      }
      at = end;
    } else {
      at += 1;
    }
  }
  return {
    value,
    duplicates,
    nonIntegerNumberAt: (path) => {
      const [root, event, group, hooks, handler, field] = path;
      if (path.length !== HANDLER_FIELD_PATH_DEPTH || root !== "hooks" || hooks !== "hooks") return false;
      return nonInteger.get(event)?.get(group)?.get(handler)?.has(field) === true;
    },
  };
}

function normalizeHooksConfig(value: unknown): CodexHooksConfig {
  const config = isObject(value) ? { ...value } : {};
  if (!isObject(config.hooks)) {
    config.hooks = {};
  }
  return config as CodexHooksConfig;
}

export function isLcmHookCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  if (/\blcm\s+user-prompt\s+--client\s+codex(?:\s+--transport\s+(?:cli|mcp))?$/.test(command)) {
    return true;
  }
  return /\blcm\s+(restore|post-tool|pre-tool|session-snapshot)\b/.test(command);
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

export interface CodexHooksMergePlan {
  readonly content: string;
  /** Set when updating would silently move other hooks' per-hook Codex state. */
  readonly refusal?: string;
}

const LCM_HOOK_ROLE = /\blcm\s+(user-prompt|restore|post-tool|pre-tool|session-snapshot)\b/;

/** The LCM subcommand a managed handler runs; with its event it identifies one hook role. */
export function codexLcmHookRole(command: unknown): string | undefined {
  return isLcmHookCommand(command) ? LCM_HOOK_ROLE.exec(command as string)![1] : undefined;
}

function refusal(event: string, detail: string): string {
  return "LCM cannot update " + event + " (" + detail + ") without moving other hooks' Codex state; "
    + "move/remove the LCM handler manually or run lcm connectors remove codex first";
}

type HooksRead = { readonly config: CodexHooksConfig; readonly refusal?: undefined }
  | { readonly config?: undefined; readonly refusal: string };

/**
 * Read existing hooks.json text for rewriting. Only empty or JSON-whitespace text starts
 * from nothing; invalid JSON, or any object that repeats a member name at any depth, is a
 * refusal because rewriting would drop the user's other hooks or the shadowed member.
 */
function readHooksConfigFromContent(content: string): HooksRead {
  if (/^[ \t\r\n]*$/.test(content)) return { config: normalizeHooksConfig(undefined) };
  const parsed = parseCodexHooksJson(content);
  const why = parsed === undefined ? "is not valid JSON"
    : parsed.duplicates.length > 0 ? "repeats the key " + JSON.stringify(parsed.duplicates[0].name)
    : undefined;
  if (why !== undefined) {
    return {
      refusal: "LCM cannot update hooks.json: it " + why + ", so LCM left it unchanged; "
        + "fix the file or move it aside, then rerun lcm connectors install codex",
    };
  }
  return { config: normalizeHooksConfig(parsed!.value) };
}

/**
 * Merge LCM handlers in place. Codex keys per-hook enablement and trust by
 * (event, group index, handler index), so every existing LCM handler keeps its
 * coordinates; only a clean tail append or removal is allowed to change layout.
 */
export function planCodexHooksMerge(
  content: string,
  transport: ConnectorTransport = "cli",
  expected: Record<string, CodexHookGroup[]> = codexLcmHooks(transport),
): CodexHooksMergePlan {
  const read = readHooksConfigFromContent(content);
  if (read.refusal !== undefined) return { content, refusal: read.refusal };
  const config = read.config;
  const roleKey = (event: string, role: string): string => event + "\u0000" + role;
  const expectedRoles = new Set<string>();
  for (const [event, groups] of Object.entries(expected)) {
    for (const group of groups) {
      for (const hook of group.hooks!) expectedRoles.add(roleKey(event, codexLcmHookRole(hook.command)!));
    }
  }

  type Located = { event: string; group: number; handler: number; key: string };
  const located: Located[] = [];
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return;
      group.hooks.forEach((hook, handlerIndex) => {
        const role = isObject(hook) ? codexLcmHookRole(hook.command) : undefined;
        if (role !== undefined) located.push({ event, group: groupIndex, handler: handlerIndex, key: roleKey(event, role) });
      });
    });
  }

  const occurrences = new Map<string, Located[]>();
  for (const entry of located) occurrences.set(entry.key, [...(occurrences.get(entry.key) ?? []), entry]);
  for (const [key, entries] of occurrences) {
    if (expectedRoles.has(key) && entries.length > 1) {
      return { content, refusal: refusal(entries[0].event, "multiple LCM handlers share one role") };
    }
  }

  const obsolete = located.filter((entry) => !expectedRoles.has(entry.key));
  // An obsolete role may only be the very last handler of the event's last group,
  // judged on the original coordinates: any later handler or group means refusal.
  for (const entry of obsolete) {
    const groups = config.hooks[entry.event];
    const hooks = (groups[entry.group] as CodexHookGroup).hooks!;
    if (entry.handler < hooks.length - 1 || entry.group < groups.length - 1) {
      return { content, refusal: refusal(entry.event, "a later hook would change position") };
    }
  }

  // Replace each existing role entirely, at its original coordinates.
  const missing: Array<{ event: string; matcher?: string; hooks: CodexCommandHook[] }> = [];
  for (const [event, wanted] of Object.entries(expected)) {
    for (const wantedGroup of wanted) {
      const absent: CodexCommandHook[] = [];
      for (const hook of wantedGroup.hooks!) {
        const existing = occurrences.get(roleKey(event, codexLcmHookRole(hook.command)!))?.[0];
        if (existing === undefined) {
          absent.push(hook);
          continue;
        }
        const group = config.hooks[event][existing.group] as CodexHookGroup;
        if (group.matcher !== wantedGroup.matcher) {
          const onlyReplacedLcm = group.hooks!.every((peer) => {
            const role = isObject(peer) ? codexLcmHookRole(peer.command) : undefined;
            return role !== undefined && expectedRoles.has(roleKey(event, role));
          });
          if (!onlyReplacedLcm) return { content, refusal: refusal(event, "the group matcher must change") };
          if (wantedGroup.matcher === undefined) delete group.matcher;
          else group.matcher = wantedGroup.matcher;
        }
        group.hooks![existing.handler] = structuredClone(hook);
      }
      if (absent.length > 0) {
        missing.push({ event, ...(wantedGroup.matcher === undefined ? {} : { matcher: wantedGroup.matcher }), hooks: absent });
      }
    }
  }

  for (const event of new Set(obsolete.map((entry) => entry.event))) {
    // The check above guarantees one obsolete handler, last in the last group.
    const groups = config.hooks[event];
    const hooks = (groups[groups.length - 1] as CodexHookGroup).hooks!;
    hooks.pop();
    if (hooks.length === 0) groups.pop();
    if (groups.length === 0) delete config.hooks[event];
  }

  for (const entry of missing) {
    const groups = Array.isArray(config.hooks[entry.event]) ? config.hooks[entry.event] : [];
    config.hooks[entry.event] = [...groups, structuredClone({ ...(entry.matcher === undefined ? {} : { matcher: entry.matcher }), hooks: entry.hooks })];
  }
  return { content: JSON.stringify(config, null, 2) + "\n" };
}

/** Pure content operation used by the anchored installer mutation seam. */
export function mergeCodexHooksContent(
  content: string,
  transport: ConnectorTransport = "cli",
  options: CodexLcmHookOptions = {},
): string {
  const plan = planCodexHooksMerge(content, transport, codexLcmHooks(transport, options));
  if (plan.refusal !== undefined) throw new Error(plan.refusal);
  return plan.content;
}

/** Pure content operation for removing LCM hooks. */
export function removeCodexHooksContent(content: string): { state: "unchanged" | "rewrite" | "remove"; content: string } {
  const read = readHooksConfigFromContent(content);
  if (read.refusal !== undefined) return { state: "unchanged", content };
  const { config, removed } = stripLcmHooks(read.config);
  if (!removed) return { state: "unchanged", content };
  if (!hasAnyHookGroups(config) && !hasNonHookKeys(config)) return { state: "remove", content: "" };
  return { state: "rewrite", content: JSON.stringify(config, null, 2) + "\n" };
}

export function hasCodexHooksContent(content: string): boolean {
  const read = readHooksConfigFromContent(content);
  if (read.refusal !== undefined) return false;
  return Object.values(read.config.hooks).some((groups) =>
    Array.isArray(groups) && groups.some((group) =>
      Array.isArray(group.hooks) && group.hooks.some((hook) => isLcmHookCommand(hook.command)),
    ),
  );
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

export const CODEX_TRUST_NOTICE = "Open Codex /hooks to review and trust the LCM hooks; they do not run until trusted.";

export interface CodexHooksInstallPlan {
  readonly hooksContent: string;
  /** Undefined when config.toml must stay byte-identical. */
  readonly configContent?: string;
  readonly notices: readonly string[];
  readonly refusal?: string;
}

/**
 * Decide every install write before any file is touched. A refusal means
 * neither hooks.json nor config.toml may be written.
 */
export function planCodexHooksInstall(
  hooksContent: string,
  configContent: string,
  transport: ConnectorTransport = "cli",
  options: CodexLcmHookOptions & { readonly expected?: Record<string, CodexHookGroup[]> } = {},
): CodexHooksInstallPlan {
  const merge = planCodexHooksMerge(
    hooksContent,
    transport,
    options.expected ?? codexLcmHooks(transport, { preToolRecall: options.preToolRecall }),
  );
  if (merge.refusal !== undefined) return { hooksContent, notices: [], refusal: merge.refusal };
  const feature = addCodexHooksFeature(configContent);
  const state = classifyCodexHooksFeature(configContent);
  const notices: string[] = [];
  if (state === "explicit-false") {
    notices.push("Codex hooks feature is disabled in config.toml; left unchanged; LCM hooks will not run until you enable it");
  } else if (state === "unrecognized") {
    notices.push("Could not interpret the Codex hooks feature setting in config.toml; left unchanged; confirm hooks are not disabled");
  } else if (state === "absent" && !feature.added) {
    notices.push("Could not safely add the Codex hooks feature to config.toml; left unchanged (Codex enables hooks by default)");
  }
  notices.push(CODEX_TRUST_NOTICE);
  return {
    hooksContent: merge.content,
    ...(feature.added ? { configContent: feature.content } : {}),
    notices,
  };
}

export function setCodexHooksFeature(content: string): string {
  return addCodexHooksFeature(content).content;
}

export function installCodexHooks(
  hooksPath: string,
  configPath: string,
  transport: ConnectorTransport = "cli",
): void {
  // Legacy two-path helper with no production callers (tests only); it never
  // reads daemon config, so the opt-in PreToolUse hook is always off here.
  // Callers requiring Bug #713 guarantees use installConnector.
  let existingConfig = "";
  try {
    existingConfig = readFileSync(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let existing = "";
  try { existing = readFileSync(hooksPath, "utf-8"); } catch { /* malformed/absent is treated as empty */ }
  const plan = planCodexHooksInstall(existing, existingConfig, transport);
  if (plan.refusal !== undefined) throw new Error(plan.refusal);
  mkdirSync(dirname(hooksPath), { recursive: true });
  if (plan.configContent !== undefined) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, plan.configContent);
  }
  writeFileSync(hooksPath, plan.hooksContent);
}

/** Internal captured state.  It is observational input, never authority. */
export type ConnectorLeafState =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "regular";
      content: Buffer;
      mode: number;
      dev: number | bigint;
      ino: number | bigint;
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

export type ConnectorLeafObservation =
  | Readonly<{ state: "absent"; certificate: Readonly<{ state: "absent" }> }>
  | Readonly<{
      state: "regular";
      content: Buffer;
      certificate: Extract<ConnectorLeafCertificate, { state: "regular" }>;
    }>;

export type ConnectorLeafDecision =
  | Readonly<{ state: "unchanged" }>
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "regular"; content: Buffer; mode: number }>;

export type ConnectorLeafOperation = Readonly<{
  displayPath: string;
  operationPath: string;
  parentOperationPath: string;
  expected: ConnectorLeafCertificate;
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

export type ConnectorLeafFinalizationResult = Readonly<{
  receipt: ConnectorLeafReceipt;
  finalized: boolean;
  failures: readonly string[];
}>;

export type ConnectorLeafReceipt = Readonly<{
  readonly displayPath: string;
  readonly operationPath: string;
  readonly parentOperationPath: string;
  readonly initial: ConnectorLeafCertificate;
  readonly current: ConnectorLeafCertificate;
  readonly transactionDisplayPath: string;
  readonly transactionOperationPath: string;
  readonly evidence: readonly ConnectorLeafEvidence[];
  readonly mutationCommitted: boolean;
  readonly recoveryRequired: boolean;
}>;

const leafFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_CONNECTOR_LEAF_BYTES = 4 * 1024 * 1024;

function leafMode(stats: ReturnType<typeof fstatSync>): number { return Number(stats.mode) & 0o7777; }

function normalizedIdentity(value: number | bigint): string { return BigInt(value).toString(10); }

function certificateFromState(state: Extract<ConnectorLeafState, { state: "regular" }>): Extract<ConnectorLeafCertificate, { state: "regular" }> {
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
    && Number.isSafeInteger(candidate.size) && candidate.size! >= 0
    && Number.isSafeInteger(candidate.mode)
    && typeof candidate.dev === "string" && typeof candidate.ino === "string";
}

function certificateEqual(left: ConnectorLeafCertificate, right: ConnectorLeafCertificate): boolean {
  if (left.state === "absent") return true;
  const regularRight = right as Extract<ConnectorLeafCertificate, { state: "regular" }>;
  return (
    left.sha256 === regularRight.sha256 && left.size === regularRight.size && left.mode === regularRight.mode
    && left.dev === regularRight.dev && left.ino === regularRight.ino
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

/** Compare a stable observation with immutable authority; observations never grant authority. */
export function matchesCertificate(
  observation: ConnectorLeafObservation,
  certificate: ConnectorLeafCertificate,
): boolean {
  if (!isCertificate(certificate)) return false;
  if (observation.state !== certificate.state) return false;
  return certificateEqual(observation.certificate, certificate);
}

function uniqueEvidence(entries: readonly ConnectorLeafEvidence[]): readonly ConnectorLeafEvidence[] {
  const byPath = new Map<string, ConnectorLeafEvidence>();
  for (const entry of entries) {
    const copy = { ...entry, operationPath: entry.operationPath } as ConnectorLeafEvidence;
    Object.defineProperty(copy, "operationPath", { value: entry.operationPath, enumerable: false, configurable: false });
    byPath.set(entry.operationPath, Object.freeze(copy));
  }
  return Object.freeze([...byPath.values()]);
}

function markEvidence(entries: readonly ConnectorLeafEvidence[], operationPath: string, status: ConnectorLeafEvidence["status"]): readonly ConnectorLeafEvidence[] {
  return uniqueEvidence(entries.map((entry) => entry.operationPath === operationPath ? { ...entry, operationPath, status } : entry));
}


/** Keep operation/evidence paths private while retaining direct internal access. */
function freezeReceipt(value: ConnectorLeafReceipt): ConnectorLeafReceipt {
  for (const key of [
    "operationPath", "parentOperationPath", "transactionDisplayPath", "transactionOperationPath",
    "operationPath", "parentOperationPath", "transactionDisplayPath", "transactionOperationPath", "evidence",
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    Object.defineProperty(value, key, { ...descriptor, enumerable: false });
  }
  return Object.freeze(value);
}

export function captureConnectorLeaf(displayPath: string, operationPath: string): ConnectorLeafObservation {
  let descriptor: number;
  try { descriptor = openSync(operationPath, leafFlags); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ state: "absent", certificate: Object.freeze({ state: "absent" }) });
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
    const certificate = certificateFromState({ state: "regular", content, mode, dev: before.dev, ino: before.ino });
    const observation = { state: "regular" as const, content: Buffer.from(content), certificate } as ConnectorLeafObservation & Record<string, unknown>;
    // Legacy callers may inspect these fields; they are deliberately non-enumerable
    // and never participate in authority or public serialization.
    Object.defineProperties(observation, {
      mode: { value: mode, enumerable: false },
      dev: { value: before.dev, enumerable: false },
      ino: { value: before.ino, enumerable: false },
    });
    return Object.freeze(observation);
  } finally { closeSync(descriptor); }
}

function transactionDir(parent: string, displayParent: string): { operation: string; display: string } {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `.lcm-connector-txn-${randomBytes(16).toString("hex")}`;
    const operation = join(parent, name);
    try {
      mkdirSync(operation, { mode: 0o700 });
      chmodSync(operation, 0o700);
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
  const opened = fstatSync(fd);
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
  } catch (error) {
    const diagnostic = error as Error;
    Object.defineProperty(diagnostic, "cleanupIdentity", {
      value: Object.freeze({ dev: normalizedIdentity(opened.dev), ino: normalizedIdentity(opened.ino), type: "regular" as const }),
      enumerable: false,
      configurable: false,
    });
    throw diagnostic;
  } finally { closeSync(fd); }
}

function unlinkPartialIfExact(path: string, identity: Readonly<{ dev: string; ino: string; type: "regular" }>): void {
  const stats: ReturnType<typeof lstatSync> = lstatSync(path);
  if (!stats.isFile() || normalizedIdentity(stats.dev) !== identity.dev || normalizedIdentity(stats.ino) !== identity.ino) return;
  unlinkSync(path);
}

function safeUnlink(path: string): void { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }

function sanitizeLeafError(error: unknown, operation: ConnectorLeafOperation, tx: { operation: string; display: string }): Error {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : "connector mutation failed";
  let message = source.replaceAll(operation.operationPath, operation.displayPath)
    .replaceAll(operation.parentOperationPath, dirname(operation.displayPath));
  message = message.replaceAll(tx.operation, tx.display);
  message = message.replaceAll(/\/proc\/self\/fd\/\d+(?:\/[^\s;,)]+)*/gu, operation.displayPath);
  const wrapped = new Error(message);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === "string") Object.assign(wrapped, { code });
  return wrapped;
}

function recoveryDisplayPath(tx: { operation: string; display: string }, operationPath: string): string {
  return join(tx.display, basename(operationPath));
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
    const detail = (error as Error).message.replaceAll(/\/proc\/self\/fd\/\d+(?:\/[^\s;,)]+)*/gu, operation.displayPath);
    return new Error(`${context} at ${operation.displayPath}; recovery artifact retained at ${recoveryPath} (${detail})`);
  }
  try {
    safeUnlink(hold);
    return new Error(`${context} at ${operation.displayPath}; recovery republished the moved entry without replacement`);
  } catch (error) {
    const detail = (error as Error).message.replaceAll(/\/proc\/self\/fd\/\d+(?:\/[^\s;,)]+)*/gu, operation.displayPath);
    return new Error(`${context} at ${operation.displayPath}; recovery artifact retained at ${recoveryPath} (${detail})`);
  }
}

function unlinkPrivateIfExact(
  path: string,
  expected: ConnectorLeafCertificate,
  displayPath: string,
  tx: { operation: string; display: string },
): string | undefined {
  try {
    const observed = captureConnectorLeaf(displayPath, path);
    if (!matchesCertificate(observed, expected)) {
      return `${displayPath}: cleanup incomplete; recovery artifact retained at ${recoveryDisplayPath(tx, path)}`;
    }
    safeUnlink(path);
    return undefined;
  } catch {
    return `${displayPath}: cleanup incomplete; recovery artifact retained at ${recoveryDisplayPath(tx, path)}`;
  }
}

export function mutateConnectorLeaf(operation: ConnectorLeafOperation, priorReceipt?: ConnectorLeafReceipt): ConnectorLeafMutationResult {
  const suppliedExpected = priorReceipt?.current ?? operation.expected;
  const expected = isCertificate(suppliedExpected)
    ? suppliedExpected
    : (suppliedExpected as unknown as { certificate?: ConnectorLeafCertificate }).certificate;
  if (!isCertificate(expected)) {
    throw Object.assign(new Error(`Invalid connector publication certificate at ${operation.displayPath}`), { code: "EINVAL" });
  }
  const expectedCertificate = copyCertificate(expected);
  const observed = captureConnectorLeaf(operation.displayPath, operation.operationPath);
  if (!matchesCertificate(observed, expectedCertificate)) throw Object.assign(new Error(`Connector path changed before mutation at ${operation.displayPath}`), { code: "EAGAIN" });
  const decision = operation.decide(observed);
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
    if (candidate) {
      const regularDecision = decision as Extract<ConnectorLeafDecision, { state: "regular" }>;
      stagedState = stageCandidate(
        candidate,
        regularDecision.content,
        regularDecision.mode,
        expectedCertificate.state === "absent",
        operation.displayPath,
      );
      stagedCertificate = certificateFromState(stagedState);
      const stagedObservation = captureConnectorLeaf(operation.displayPath, candidate);
      if (!matchesCertificate(stagedObservation, stagedCertificate)) {
        throw new Error(`Connector candidate changed before publication at ${operation.displayPath}`);
      }
    }
    let hold: string | undefined;
    if (expectedCertificate.state === "regular") {
      const holdName = priorReceipt ? `superseded-${randomBytes(4).toString("hex")}` : "initial";
      hold = join(tx.operation, holdName);
      renameSync(operation.operationPath, hold);
      let claimed: ConnectorLeafObservation | undefined;
      try { claimed = captureConnectorLeaf(operation.displayPath, hold); } catch { /* recovery below */ }
      if (!claimed || !matchesCertificate(claimed, expectedCertificate)) {
        throw republishMovedEntry(hold, operation, tx, "Connector leaf claim validation failed");
      }
      validatedHold = hold;
    }
    if (decision.state === "regular") {
      try { linkSync(candidate!, operation.operationPath); }
      catch (error) { throw error; }
      publicationCommitted = true;
      const priorCurrentHold = (priorReceipt?.evidence ?? []).find((entry) => entry.kind === "current-private" && entry.status === "retained")?.operationPath;
      const initialCertificate = priorReceipt?.initial ? copyCertificate(priorReceipt.initial) : expectedCertificate;
      const evidence = uniqueEvidence([
        ...(priorReceipt?.evidence ?? []),
        Object.freeze({ kind: priorReceipt ? "superseded" as const : "initial" as const, operationPath: hold ?? operation.operationPath, displayPath: hold ? recoveryDisplayPath(tx, hold) : operation.displayPath, status: "retained" as const, certificate: expectedCertificate.state === "regular" ? expectedCertificate : undefined }),
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
        transactionDisplayPath: priorReceipt.transactionDisplayPath,
        transactionOperationPath: priorReceipt.transactionOperationPath,
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
        evidence,
      }) as ConnectorLeafReceipt);
      committedReceipt = receipt;
      const publicState = captureConnectorLeaf(operation.displayPath, operation.operationPath);
      const candidateState = captureConnectorLeaf(operation.displayPath, candidate!);
      if (publicState.state !== "regular" || candidateState.state !== "regular"
        || !matchesCertificate(publicState, stagedCertificate!)
        || !matchesCertificate(candidateState, stagedCertificate!)) {
        throw new Error(`Connector candidate publication verification failed at ${operation.displayPath}`);
      }
      const cleanupFailures: string[] = [];
      let finalEvidence = evidence;
      if (priorCurrentHold && priorCurrentHold !== candidate && expectedCertificate.state === "regular") {
        const failure = unlinkPrivateIfExact(priorCurrentHold, expectedCertificate, operation.displayPath, tx);
        if (failure) cleanupFailures.push(failure);
        else finalEvidence = markEvidence(finalEvidence, priorCurrentHold, "detached");
      }
      if (cleanupFailures.length > 0) {
        throw new Error(cleanupFailures.join("; "));
      }
      const finalizedReceipt = finalEvidence === evidence ? receipt : freezeReceipt({
        ...receipt,
        operationPath: receipt.operationPath,
        parentOperationPath: receipt.parentOperationPath,
        transactionDisplayPath: receipt.transactionDisplayPath,
        transactionOperationPath: receipt.transactionOperationPath,
        evidence: finalEvidence,
      });
      return { changed: true, content: Buffer.from(decision.content), receipt: finalizedReceipt };
    }
    const priorCurrentHold = (priorReceipt?.evidence ?? []).find((entry) => entry.kind === "current-private" && entry.status === "retained")?.operationPath;
    const initialCertificate = priorReceipt?.initial ? copyCertificate(priorReceipt.initial) : expectedCertificate;
    const receipt: ConnectorLeafReceipt = freezeReceipt((priorReceipt ? {
      ...priorReceipt,
      initial: initialCertificate,
      current: Object.freeze({ state: "absent" as const }) as ConnectorLeafCertificate,
      operationPath: operation.operationPath,
      parentOperationPath: operation.parentOperationPath,
      transactionDisplayPath: priorReceipt.transactionDisplayPath,
      transactionOperationPath: priorReceipt.transactionOperationPath,
      mutationCommitted: true,
      recoveryRequired: false,
      evidence: uniqueEvidence([
        ...(priorReceipt.evidence ?? []),
        // expectedCertificate is regular in this branch, so the claim always
        // produced a hold before this receipt is constructed.
        Object.freeze({ kind: "superseded" as const, operationPath: hold!, displayPath: recoveryDisplayPath(tx, hold!), status: "retained" as const, certificate: expectedCertificate as Extract<ConnectorLeafCertificate, { state: "regular" }> }),
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
      evidence: uniqueEvidence([
        // As above, a regular expected state necessarily has a claimed hold.
        Object.freeze({ kind: "initial" as const, operationPath: hold!, displayPath: recoveryDisplayPath(tx, hold!), status: "retained" as const, certificate: expectedCertificate as Extract<ConnectorLeafCertificate, { state: "regular" }> }),
        Object.freeze({ kind: "current-public" as const, operationPath: operation.operationPath, displayPath: operation.displayPath, status: "retained" as const }),
      ]),
    }) as ConnectorLeafReceipt);
    let finalEvidence = receipt.evidence;
    if (priorCurrentHold && priorCurrentHold !== hold && expectedCertificate.state === "regular") {
      const failure = unlinkPrivateIfExact(priorCurrentHold, expectedCertificate, operation.displayPath, tx);
      if (failure) {
        throw new Error(failure);
      }
      finalEvidence = markEvidence(finalEvidence, priorCurrentHold, "detached");
    }
    return { changed: true, receipt: finalEvidence === receipt.evidence ? receipt : freezeReceipt({
      ...receipt,
      operationPath: receipt.operationPath,
      parentOperationPath: receipt.parentOperationPath,
      transactionDisplayPath: receipt.transactionDisplayPath,
      transactionOperationPath: receipt.transactionOperationPath,
      evidence: finalEvidence,
    }) };
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
      try {
        const identity = (error as { cleanupIdentity?: Readonly<{ dev: string; ino: string; type: "regular" }> }).cleanupIdentity;
        if (identity) unlinkPartialIfExact(candidate, identity);
        else safeUnlink(candidate);
      }
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
      const cleanupIdentity = (error as { cleanupIdentity?: Readonly<{ dev: string; ino: string; type: "regular" }> }).cleanupIdentity;
      Object.defineProperty(primary, "connectorLeafFailureEvidence", {
        value: Object.freeze({
          displayPath: operation.displayPath,
          transactionDisplayPath: tx.display,
          evidence: uniqueEvidence([
            ...(candidate ? [Object.freeze({ kind: "staging" as const, operationPath: candidate, displayPath: recoveryDisplayPath(tx, candidate), status: "retained" as const, cleanupIdentity })] : []),
            ...(validatedHold ? [Object.freeze({ kind: "recovery" as const, operationPath: validatedHold, displayPath: recoveryDisplayPath(tx, validatedHold), status: "retain-only" as const })] : []),
          ]),
        }),
        enumerable: false,
      });
    }
    throw primary;
  }
}

function resultReceipt(receipt: ConnectorLeafReceipt): ConnectorLeafReceipt {
  return freezeReceipt({
    ...receipt,
    operationPath: receipt.operationPath,
    parentOperationPath: receipt.parentOperationPath,
    transactionDisplayPath: receipt.transactionDisplayPath,
    transactionOperationPath: receipt.transactionOperationPath,
    evidence: uniqueEvidence(receipt.evidence ?? []),
  });
}

function resultCompensation(receipt: ConnectorLeafReceipt, failures: readonly string[]): ConnectorLeafCompensationResult {
  return Object.freeze({ receipt: resultReceipt(receipt), compensated: failures.length === 0, failures: Object.freeze([...failures]) });
}

function resultFinalization(receipt: ConnectorLeafReceipt, failures: readonly string[]): ConnectorLeafFinalizationResult {
  return Object.freeze({ receipt: resultReceipt(receipt), finalized: failures.length === 0, failures: Object.freeze([...failures]) });
}

export function compensateConnectorLeaf(receipt: ConnectorLeafReceipt): ConnectorLeafCompensationResult {
  const failures: string[] = [];
  const extraEvidence: ConnectorLeafEvidence[] = [];
  let initialHold: string | undefined;
  let rollbackHold: string | undefined;
  let rollbackClaimed = false;
  let compensationCommitted = false;
  try {
    if (!receipt.mutationCommitted) return resultCompensation(receipt, failures);
    const initialCertificate = copyCertificate((receipt.initial as unknown as { certificate?: ConnectorLeafCertificate }).certificate ?? receipt.initial);
    const currentCertificate = copyCertificate((receipt.current as unknown as { certificate?: ConnectorLeafCertificate }).certificate ?? receipt.current);
    initialHold = (receipt.evidence ?? []).find((entry) => entry.kind === "initial" && entry.status === "retained")?.operationPath;
    if (initialCertificate.state === "regular") {
      if (!initialHold) throw new Error("initial hold unavailable");
      const retainedInitial = captureConnectorLeaf(receipt.displayPath, initialHold);
      if (!matchesCertificate(retainedInitial, initialCertificate)) throw new Error("initial hold changed");
    }
    if (currentCertificate.state === "regular") {
      const now = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
      if (!matchesCertificate(now, currentCertificate)) throw new Error("current receipt changed");
      rollbackHold = join(receipt.transactionOperationPath, `rollback-${randomBytes(4).toString("hex")}`);
      renameSync(receipt.operationPath, rollbackHold);
      extraEvidence.push({
        kind: "rollback",
        operationPath: rollbackHold,
        displayPath: recoveryDisplayPath({ operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath }, rollbackHold),
        status: "retained",
        certificate: currentCertificate,
      });
      let claimed: ConnectorLeafObservation | undefined;
      try { claimed = captureConnectorLeaf(receipt.displayPath, rollbackHold); } catch { /* recovery below */ }
      if (!claimed || !matchesCertificate(claimed, currentCertificate)) {
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
        if (initialState.state !== "regular" || !matchesCertificate(initialState, initialCertificate)) throw new Error("initial hold changed");
        const restorePath = join(receipt.transactionOperationPath, `restore-${randomBytes(4).toString("hex")}`);
        const restoreState = stageCandidate(restorePath, initialState.content, initialCertificate.mode, false, receipt.displayPath);
        const restoreCertificate = certificateFromState(restoreState);
        assert.strictEqual(restoreCertificate.sha256, initialCertificate.sha256, "initial restore certificate digest mismatch");
        assert.strictEqual(restoreCertificate.size, initialCertificate.size, "initial restore certificate size mismatch");
        assert.strictEqual(restoreCertificate.mode, initialCertificate.mode & 0o7777, "initial restore certificate mode mismatch");
        const restoreObservation = captureConnectorLeaf(receipt.displayPath, restorePath);
        assert.strictEqual(matchesCertificate(restoreObservation, restoreCertificate), true, "initial restore candidate changed before publication");
        extraEvidence.push({
          kind: "restore",
          operationPath: restorePath,
          displayPath: recoveryDisplayPath({ operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath }, restorePath),
          status: "retained",
          certificate: restoreCertificate as Extract<ConnectorLeafCertificate, { state: "regular" }>,
        });
        // Keep the restore candidate bound to the immutable initial
        // certificate before linking it into the public namespace.
        linkSync(restorePath, receipt.operationPath);
        compensationCommitted = true;
        const restored = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
        if (!matchesCertificate(restored, restoreCertificate)) throw new Error("initial receipt restoration mismatch");
        const restoreFailure = unlinkPrivateIfExact(restorePath, restoreCertificate, receipt.displayPath, { operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath });
        if (restoreFailure) throw new Error(restoreFailure);
        extraEvidence[extraEvidence.length - 1] = { ...extraEvidence[extraEvidence.length - 1], status: "detached" };
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
      for (const entry of receipt.evidence) {
        if (entry.kind !== "current-private" || entry.status !== "retained" || !entry.certificate) continue;
        const aliasFailure = unlinkPrivateIfExact(
          entry.operationPath,
          entry.certificate,
          receipt.displayPath,
          { operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath },
        );
        if (aliasFailure) throw new Error(aliasFailure);
      }
    } else if (initialCertificate.state === "regular") {
      const now = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
      if (now.state !== "absent") throw new Error("current receipt changed");
      const initialState = captureConnectorLeaf(receipt.displayPath, initialHold!);
      if (initialState.state !== "regular" || !matchesCertificate(initialState, initialCertificate)) throw new Error("initial hold changed");
      const restorePath = join(receipt.transactionOperationPath, `restore-${randomBytes(4).toString("hex")}`);
      const restoreState = stageCandidate(restorePath, initialState.content, initialCertificate.mode, false, receipt.displayPath);
      const restoreCertificate = certificateFromState(restoreState);
      assert.strictEqual(restoreCertificate.sha256, initialCertificate.sha256, "initial restore certificate digest mismatch");
      assert.strictEqual(restoreCertificate.size, initialCertificate.size, "initial restore certificate size mismatch");
      assert.strictEqual(restoreCertificate.mode, initialCertificate.mode & 0o7777, "initial restore certificate mode mismatch");
      const restoreObservation = captureConnectorLeaf(receipt.displayPath, restorePath);
      assert.strictEqual(matchesCertificate(restoreObservation, restoreCertificate), true, "initial restore candidate changed before publication");
      extraEvidence.push({
        kind: "restore",
        operationPath: restorePath,
        displayPath: recoveryDisplayPath({ operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath }, restorePath),
        status: "retained",
        certificate: restoreCertificate as Extract<ConnectorLeafCertificate, { state: "regular" }>,
      });
      // Keep the restore candidate bound to the immutable initial
      // certificate before linking it into the public namespace.
      linkSync(restorePath, receipt.operationPath);
      compensationCommitted = true;
      const restored = captureConnectorLeaf(receipt.displayPath, receipt.operationPath);
      if (!matchesCertificate(restored, restoreCertificate)) throw new Error("initial receipt restoration mismatch");
      const restoreFailure = unlinkPrivateIfExact(restorePath, restoreCertificate, receipt.displayPath, { operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath });
      if (restoreFailure) throw new Error(restoreFailure);
      extraEvidence[extraEvidence.length - 1] = { ...extraEvidence[extraEvidence.length - 1], status: "detached" };
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
    failures.push(`${receipt.displayPath}: rollback incomplete (${message})`);
  }
  const evidenceReceipt = extraEvidence.length > 0 ? freezeReceipt({
    ...receipt,
    operationPath: receipt.operationPath,
    parentOperationPath: receipt.parentOperationPath,
    transactionDisplayPath: receipt.transactionDisplayPath,
    transactionOperationPath: receipt.transactionOperationPath,
    evidence: uniqueEvidence([...receipt.evidence, ...extraEvidence]),
  }) : receipt;
  const compensatedReceipt = compensationCommitted
    ? freezeReceipt({
      ...evidenceReceipt,
      operationPath: evidenceReceipt.operationPath,
      parentOperationPath: evidenceReceipt.parentOperationPath,
      transactionDisplayPath: evidenceReceipt.transactionDisplayPath,
      transactionOperationPath: evidenceReceipt.transactionOperationPath,
      evidence: uniqueEvidence([
        ...evidenceReceipt.evidence.map((entry) =>
          entry.kind === "current-private" ? { ...entry, status: "detached" as const } : entry),
        ...extraEvidence.map((entry) => entry.kind === "rollback" ? { ...entry, status: "detached" as const } : entry),
      ]),
    })
    : evidenceReceipt;
  return resultCompensation(compensatedReceipt, failures);
}

export function finalizeConnectorLeaf(receipt: ConnectorLeafReceipt): ConnectorLeafFinalizationResult {
  const failures: string[] = [];
  const tx = { operation: receipt.transactionOperationPath, display: receipt.transactionDisplayPath };
  let finalEvidence = receipt.evidence ?? [];
  for (const entry of receipt.evidence ?? []) {
    if (entry.status !== "retained" || entry.kind === "current-public" || entry.kind === "recovery") continue;
    const path = entry.operationPath;
    const expected = entry.certificate;
    if (!expected) {
      failures.push(`${receipt.displayPath}: cleanup incomplete; recovery artifact retained at ${recoveryDisplayPath(tx, path)}`);
      continue;
    }
    const failure = unlinkPrivateIfExact(path, expected, receipt.displayPath, tx);
    if (failure) failures.push(failure);
    else finalEvidence = markEvidence(finalEvidence, path, "detached");
  }
  try { rmdirSync(receipt.transactionOperationPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && failures.length === 0) {
      failures.push(`${receipt.displayPath}: cleanup incomplete; recovery artifact retained at ${receipt.transactionDisplayPath}`);
    }
  }
  const finalizedReceipt = freezeReceipt({
    ...receipt,
    operationPath: receipt.operationPath,
    parentOperationPath: receipt.parentOperationPath,
    transactionDisplayPath: receipt.transactionDisplayPath,
    transactionOperationPath: receipt.transactionOperationPath,
    evidence: finalEvidence,
  });
  return resultFinalization(finalizedReceipt, failures);
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
      result = mutateConnectorLeaf({ displayPath: hooksPath, operationPath, parentOperationPath, expected: expected.certificate, decide: (base) => {
      // The expected snapshot is captured immediately above and mutation
      // revalidates it before invoking this callback, so this is necessarily
      // a regular leaf. Keep the transform bound to that captured state.
      const regularBase = base as Extract<ConnectorLeafObservation, { state: "regular" }>;
      const decision = removeCodexHooksContent(regularBase.content.toString("utf-8"));
      if (decision.state === "unchanged") return { state: "unchanged" };
      if (decision.state === "remove") return { state: "absent" };
      return { state: "regular", content: Buffer.from(decision.content, "utf-8"), mode: regularBase.certificate.mode };
      }});
    } catch (error) {
      const message = (error instanceof Error ? error.message : typeof error === "string" ? error : "connector hooks mutation failed")
        .replaceAll(operationPath, hooksPath)
        .replaceAll(parentOperationPath, parent)
        .replaceAll(/\/proc\/self\/fd\/\d+(?:\/[^\s;,)]+)*/gu, hooksPath);
      const receipt = (error as Error & { connectorLeafReceipt?: ConnectorLeafReceipt }).connectorLeafReceipt;
      if (receipt?.mutationCommitted) {
        const compensation = compensateConnectorLeaf(receipt);
      const finalization = compensation.compensated ? finalizeConnectorLeaf(compensation.receipt) : undefined;
        const failures = [...compensation.failures, ...(finalization?.failures ?? [])];
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
    const finalization = result.changed ? finalizeConnectorLeaf(result.receipt) : undefined;
    if (finalization && !finalization.finalized) throw new Error(finalization.failures.join("; "));
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
