// src/hooks/pre-tool.ts
//
// Opt-in Codex PreToolUse memory hints (hooks.preToolRecall, default off).
//
// The hook runs synchronously before a tool call, so every failure mode ends
// with empty stdout and exit 0: the pending call proceeds unchanged. The
// handler never bootstraps or starts the daemon, never records events, and
// never writes decisions, permission verdicts or input rewrites. Codex honors
// additional context only as JSON on stdout.
import { DaemonClient } from "../daemon/client.js";
import { admitDaemonPeer } from "../daemon/peer-admission.js";
import type { DaemonPeerAdmission } from "../daemon/peer-admission.js";
import { configPath as defaultConfigPath } from "../runtime-paths.js";
import { loadStoredPreToolRecallSettings } from "../config-projection.js";
import { buildMemoryContext } from "./memory-context.js";
import {
  assertHookPublicationFence,
  assertHookRootEstablished,
  isBackendPublicationEvidenceMissing,
  isBackendPublicationJournalError,
} from "./publication-fence.js";

type HookResult = { exitCode: number; stdout: string };

type PromptSearchResponse = {
  hints?: unknown;
  ids?: unknown;
};

/** Wall-clock budget for the daemon request; Codex's own hook timeout bounds the whole process. */
export const PRE_TOOL_DEADLINE_MS = 1500;

const EMPTY: HookResult = { exitCode: 0, stdout: "" };
const MAX_QUERY_TERMS = 12;
const MIN_TERM_LENGTH = 3;

const TOOL_LABELS = ["shell command", "file edit", "MCP tool"] as const;
type ToolLabel = typeof TOOL_LABELS[number];

function preToolPreamble(label: ToolLabel): string {
  return "LCM memory related to the pending " + label
    + ". Advisory only: this call proceeds unchanged; consider it for later steps.";
}

/** Largest preamble plus its newline; the daemon reserves it out of the injection budget. */
export const PRE_TOOL_PREAMBLE_BYTES = Math.max(
  ...TOOL_LABELS.map((label) => Buffer.byteLength(preToolPreamble(label), "utf8")),
) + 1;

const GENERIC_TERMS: ReadonlySet<string> = new Set([
  "src", "lib", "test", "tests", "docs", "doc", "run", "main", "index", "file", "files",
  "home", "tmp", "usr", "bin", "dist", "build", "node", "the", "and", "for", "with",
  "true", "false", "null", "dev", "out",
]);

const TRIVIAL_EXECUTABLES: ReadonlySet<string> = new Set([
  "ls", "pwd", "cd", "echo", "printf", "true", "false", "clear", "sleep", "which", "type",
  "whoami", "date", "cat", "head", "tail", "wc", "less", "more", "sort", "uniq", "tee",
  "env", "export", "set", "unset", "source", "exit", "test",
]);

const PATH_READERS: ReadonlySet<string> = new Set(["cat", "head", "tail", "less", "more", "wc"]);
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "add", "commit", "checkout", "switch", "restore",
  "fetch", "pull", "push", "branch", "merge", "rebase",
]);
const COMMAND_PREFIXES: ReadonlySet<string> = new Set(["sudo", "env", "time", "nohup", "command"]);

// Anything outside this alphabet (quotes, expansions, redirections, globs,
// subshells, escapes, newlines, non-ASCII) rejects the whole Bash input.
const SUPPORTED_BASH_CHARACTERS = /^[A-Za-z0-9_./:=@%+,\- \t;&|]*$/;
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
const EXECUTABLE_WORD = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;
const SCRIPT_NAME = /^[A-Za-z][A-Za-z0-9:_-]*$/;
const SAFE_PATH_OPERAND = /^(?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const PATCH_PATH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

/** Basename, extension-less stem and immediate parent directory of a path. */
function pathFragments(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  const base = segments.at(-1);
  if (base === undefined) return [];
  const dot = base.lastIndexOf(".");
  const fragments = [base, dot > 0 ? base.slice(0, dot) : base];
  const parent = segments.at(-2);
  if (parent !== undefined) fragments.push(parent);
  return fragments;
}

/**
 * Fragments contributed by one simple Bash command. Interpreters, unknown
 * commands and every flag tail contribute nothing beyond the executable name.
 */
function simpleCommandFragments(segment: string): string[] {
  const words = segment.trim().split(/\s+/);
  let index = 0;
  for (;;) {
    const word = words[index];
    if (word === undefined) return [];
    if (ASSIGNMENT_WORD.test(word)) {
      index += 1;
    } else if (COMMAND_PREFIXES.has(word)) {
      const next = words[index + 1];
      if (next === undefined || next.startsWith("-")) return [];
      index += 1;
    } else {
      break;
    }
  }
  const executable = words[index]!.split("/").at(-1)!;
  if (!EXECUTABLE_WORD.test(executable)) return [];
  const fragments = TRIVIAL_EXECUTABLES.has(executable) ? [] : [executable];

  const operands: string[] = [];
  for (const word of words.slice(index + 1)) {
    if (word.startsWith("-")) break;
    operands.push(word);
  }

  if (executable === "git") {
    if (operands[0] !== undefined && GIT_SUBCOMMANDS.has(operands[0])) fragments.push(operands[0]);
  } else if (PACKAGE_RUNNERS.has(executable)) {
    if (operands[0] === "run" && operands[1] !== undefined && SCRIPT_NAME.test(operands[1])) {
      fragments.push("run", operands[1]);
    }
  } else if (PATH_READERS.has(executable)) {
    for (const operand of operands) {
      if (SAFE_PATH_OPERAND.test(operand)) fragments.push(...pathFragments(operand));
    }
  }
  return fragments;
}

function bashFragments(command: string): string[] | null {
  if (!SUPPORTED_BASH_CHARACTERS.test(command)) return null;
  const fragments: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    // A leftover "&" is a background job or a malformed operator.
    if (segment.trim() === "" || segment.includes("&")) return null;
    fragments.push(...simpleCommandFragments(segment));
  }
  return fragments;
}

function patchFragments(patch: string): string[] {
  const fragments: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const header = PATCH_PATH_HEADER.exec(line);
    if (header !== null) fragments.push(...pathFragments(header[1]!));
  }
  return fragments;
}

function mcpFragments(toolName: string): string[] | null {
  const identity = toolName.slice("mcp__".length);
  const boundary = identity.indexOf("__");
  const server = boundary < 0 ? identity : identity.slice(0, boundary);
  const tool = boundary < 0 ? "" : identity.slice(boundary + 2);
  if (server.toLowerCase() === "lcm") return null;
  return [...server.split(/[_-]+/), ...tool.split(/[_-]+/)];
}

function termsFromFragments(fragments: readonly string[]): string | null {
  const terms: string[] = [];
  for (const fragment of fragments) {
    for (const unit of fragment.match(/[A-Za-z0-9_]+/g) ?? []) {
      const term = unit.toLowerCase();
      if (
        term.length < MIN_TERM_LENGTH
        || /^[0-9]+$/.test(term)
        || GENERIC_TERMS.has(term)
        || terms.includes(term)
      ) continue;
      terms.push(term);
      if (terms.length === MAX_QUERY_TERMS) return terms.join(" ");
    }
  }
  return terms.length >= 2 ? terms.join(" ") : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derive a conservative memory query from the identity of a pending tool call.
 *
 * Only command words, a closed set of semantic subcommands, file path names
 * and MCP server/tool names contribute. Quoted text, flags and their values,
 * environment assignments, redirections, heredocs, script bodies, patch
 * bodies and MCP arguments never do. Returns null when fewer than two useful
 * terms remain.
 */
export function buildPreToolRecallQuery(toolName: string, toolInput: unknown): string | null {
  const command = isRecord(toolInput) ? toolInput.command : undefined;
  let fragments: string[] | null;
  if (toolName === "Bash") {
    fragments = typeof command === "string" ? bashFragments(command) : null;
  } else if (toolName === "apply_patch") {
    fragments = typeof command === "string" ? patchFragments(command) : null;
  } else if (toolName.startsWith("mcp__")) {
    fragments = mcpFragments(toolName);
  } else {
    fragments = null;
  }
  return fragments === null ? null : termsFromFragments(fragments);
}

function toolLabel(toolName: string): ToolLabel {
  if (toolName === "Bash") return "shell command";
  return toolName === "apply_patch" ? "file edit" : "MCP tool";
}

/** Zip hints with ids only when the daemon aligned them one to one; drop blank hints with their ids. */
function usableHints(rawHints: readonly unknown[], rawIds: unknown): { hints: string[]; ids: string[] } {
  const aligned = Array.isArray(rawIds)
    && rawIds.length === rawHints.length
    && rawIds.every((id) => typeof id === "string" && id.trim().length > 0);
  const hints: string[] = [];
  const ids: string[] = [];
  rawHints.forEach((hint, position) => {
    if (typeof hint !== "string" || hint.trim().length === 0) return;
    hints.push(hint);
    if (aligned) ids.push((rawIds as string[])[position]!);
  });
  return { hints, ids };
}

async function runPreToolUse(
  stdin: string,
  deadlineMs: number,
  admitPeerForTesting?: (port: number, deadline: number) => DaemonPeerAdmission | null,
): Promise<HookResult> {
  const input: unknown = JSON.parse(stdin);
  if (!isRecord(input)) return EMPTY;
  if (process.env.LCM_ENABLED === "false") return EMPTY;
  // Hints are scoped to the root thread: skip every subagent call, and treat a
  // present non-string identity as malformed.
  for (const identity of [input.agent_id, input.agent_type]) {
    if (identity !== undefined && (typeof identity !== "string" || identity.length > 0)) return EMPTY;
  }
  const { tool_name: toolName, tool_input: toolInput, cwd, session_id: sessionId } = input;
  if (typeof toolName !== "string" || typeof cwd !== "string" || cwd.trim().length === 0) return EMPTY;
  const query = buildPreToolRecallQuery(toolName, toolInput);
  if (query === null) return EMPTY;

  assertHookRootEstablished();
  const settings = loadStoredPreToolRecallSettings(defaultConfigPath());
  if (!settings.enabled) return EMPTY;
  assertHookPublicationFence();

  const deadline = performance.now() + deadlineMs;
  const client = new DaemonClient("http://127.0.0.1:" + settings.daemonPort, undefined,
    () => admitPeerForTesting === undefined
      ? admitDaemonPeer({ port: settings.daemonPort, deadline })
      : admitPeerForTesting(settings.daemonPort, deadline));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let response: PromptSearchResponse;
  try {
    response = await client.post<PromptSearchResponse>("/prompt-search", {
      query,
      cwd,
      session_id: typeof sessionId === "string" ? sessionId : undefined,
      learningInstructionBytes: PRE_TOOL_PREAMBLE_BYTES,
      recallMode: "pre-tool",
    }, { signal: controller.signal, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) });
  } finally {
    clearTimeout(timer);
  }
  if (!isRecord(response) || !Array.isArray(response.hints)) return EMPTY;

  const { hints, ids } = usableHints(response.hints, response.ids);
  const block = buildMemoryContext(hints, ids);
  if (block === null) return EMPTY;
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: preToolPreamble(toolLabel(toolName)) + "\n" + block,
      },
    }),
  };
}

/**
 * Handle one Codex PreToolUse payload. The only non-empty outcome is JSON
 * additional context; the only rethrown failures are non-benign publication
 * journal errors, which the CLI reports with a static diagnostic while the
 * tool still runs.
 */
export async function handlePreToolUse(
  stdin: string,
  deps: {
    deadlineMs?: number;
    /** @internal Deterministic peer admission for hook tests. */
    _admitPeerForTesting?: (port: number, deadline: number) => DaemonPeerAdmission | null;
  } = {},
): Promise<HookResult> {
  try {
    return await runPreToolUse(stdin, deps.deadlineMs ?? PRE_TOOL_DEADLINE_MS, deps._admitPeerForTesting);
  } catch (error) {
    if (isBackendPublicationJournalError(error) && !isBackendPublicationEvidenceMissing(error)) throw error;
    return EMPTY;
  }
}
