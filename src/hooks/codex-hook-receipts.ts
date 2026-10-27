// src/hooks/codex-hook-receipts.ts
// LCM-local, unauthenticated record of the last persisted Codex hook handler outcome per event.
// Codex persists no hook run history; this record is an observation for doctor, never proof.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { lcmHomeDir } from "../runtime-paths.js";
import {
  OWNER_ONLY_FILE_MODES,
  atomicWritePrivateFile,
  openPrivateDirectory,
  openPrivateDirectoryIfExists,
  readBoundedRegularFileWithStat,
} from "../security-files.js";

export const CODEX_HOOK_EVENT_NAMES = [
  "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "SessionStart",
  "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop", "Interrupt",
] as const;

export type CodexHookReceiptOutcome = "exit-0" | "exit-nonzero" | "threw";

export interface CodexHookReceipt {
  readonly version: 1;
  readonly event: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly outcome: CodexHookReceiptOutcome;
  readonly exitCode: number | null;
  readonly loggedErrors: boolean;
}

const THROTTLE_MS = 60_000;
const MAX_RECEIPT_BYTES = 4096;
const FALLBACK_EVENTS: Readonly<Record<string, string>> = {
  restore: "SessionStart",
  "user-prompt": "UserPromptSubmit",
  "post-tool": "PostToolUse",
  "pre-tool": "PreToolUse",
};
const PAYLOAD_EVENT_COMMANDS: ReadonlySet<string> = new Set(["restore", "session-snapshot"]);
const ERROR_MARKER = Symbol.for("lcm.hookErrorReported");

export function codexHookReceiptDir(): string {
  return join(lcmHomeDir(), "state", "codex-hooks");
}

function isEventName(value: unknown): value is string {
  return typeof value === "string" && (CODEX_HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

function resolveEvent(command: string, stdinText: string): string | undefined {
  if (PAYLOAD_EVENT_COMMANDS.has(command)) {
    try {
      const payload = JSON.parse(stdinText) as { hook_event_name?: unknown } | null;
      if (isEventName(payload?.hook_event_name)) return payload.hook_event_name;
    } catch {
      // Not a JSON payload: fall back to the command's own event.
    }
  }
  return FALLBACK_EVENTS[command];
}

function parseReceipt(text: string, event: string): CodexHookReceipt | undefined {
  try {
    const value = JSON.parse(text) as Partial<CodexHookReceipt> | null;
    if (
      value?.version === 1
      && value.event === event
      && Number.isFinite(value.startedAt)
      && Number.isFinite(value.completedAt)
      && (value.outcome === "exit-0" || value.outcome === "exit-nonzero" || value.outcome === "threw")
      && (value.exitCode === null || Number.isInteger(value.exitCode))
      && typeof value.loggedErrors === "boolean"
    ) return value as CodexHookReceipt;
  } catch {
    // Invalid records are ignored.
  }
  return undefined;
}

function readReceiptFile(dir: string, event: string): { receipt: CodexHookReceipt; mtimeMs: number } | undefined {
  try {
    const file = readBoundedRegularFileWithStat(join(dir, event + ".json"), {
      allowedRoot: dir,
      maxBytes: MAX_RECEIPT_BYTES,
      allowedModes: OWNER_ONLY_FILE_MODES,
      requireSingleLink: true,
      expectedUid: process.getuid?.(),
    });
    const receipt = parseReceipt(file.content, event);
    return receipt === undefined ? undefined : { receipt, mtimeMs: file.mtimeMs };
  } catch {
    return undefined;
  }
}

function ensureDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    // An existing or uncreatable directory is judged by the authenticated open that follows.
  }
}

function persist(receipt: CodexHookReceipt): void {
  const dir = codexHookReceiptDir();
  const previous = readReceiptFile(dir, receipt.event);
  if (
    previous !== undefined
    && previous.receipt.outcome === receipt.outcome
    && previous.receipt.loggedErrors === receipt.loggedErrors
    && receipt.completedAt - previous.mtimeMs < THROTTLE_MS
  ) return;
  // Hooks must never bootstrap the LCM home: record only beside an existing one.
  const root = openPrivateDirectoryIfExists(lcmHomeDir());
  if (root === undefined) return;
  root.close();
  const stateDir = join(lcmHomeDir(), "state");
  ensureDirectory(stateDir);
  const stateHandle = openPrivateDirectory(stateDir);
  try {
    ensureDirectory(dir);
    const parent = openPrivateDirectory(dir);
    try {
      atomicWritePrivateFile(join(dir, receipt.event + ".json"), JSON.stringify(receipt) + "\n", {}, parent);
    } finally {
      parent.close();
    }
  } finally {
    stateHandle.close();
  }
}

/**
 * Run a Codex hook entrypoint and record its completion. Non-Codex clients run untouched.
 * The original result is returned and the original exception rethrown unchanged;
 * every receipt failure is swallowed.
 */
export async function runObservedCodexHook<T extends { readonly exitCode: number }>(
  hook: { readonly client: unknown; readonly command: string; readonly stdinText: string },
  run: () => Promise<T>,
): Promise<T> {
  if (hook.client !== "codex") return run();
  const startedAt = Date.now();
  const marks = globalThis as Record<symbol, unknown>;
  marks[ERROR_MARKER] = false;
  let result: T | undefined;
  let thrown: { readonly error: unknown } | undefined;
  try {
    result = await run();
  } catch (error) {
    thrown = { error };
  }
  try {
    const event = resolveEvent(hook.command, hook.stdinText);
    if (event !== undefined) {
      persist({
        version: 1,
        event,
        startedAt,
        completedAt: Date.now(),
        outcome: thrown !== undefined ? "threw" : result!.exitCode === 0 ? "exit-0" : "exit-nonzero",
        exitCode: thrown !== undefined ? null : result!.exitCode,
        loggedErrors: marks[ERROR_MARKER] === true,
      });
    }
  } catch {
    // Observation is best effort and must never alter the hook outcome.
  }
  if (thrown !== undefined) throw thrown.error;
  return result!;
}

/** Bounded, invalid-tolerant read of the persisted receipts for doctor. */
export function readCodexHookReceipts(dir: string = codexHookReceiptDir()): CodexHookReceipt[] {
  return CODEX_HOOK_EVENT_NAMES.flatMap((event) => {
    const found = readReceiptFile(dir, event);
    return found === undefined ? [] : [found.receipt];
  });
}
