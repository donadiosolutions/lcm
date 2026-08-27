// src/hooks/post-tool.ts
import { extractPostToolEvents } from "./extractors.js";
import { normalizePostToolInput } from "./post-tool-normalization.js";
import { safeLogError } from "./hook-errors.js";
import { ensureProjectDir } from "../daemon/project.js";
import { PrivateMutationLockContentionError } from "../private-mutation-lock.js";
import { appendLocalHookEvents } from "./local-enqueue.js";
import {
  BACKEND_PUBLICATION_ADMISSION_DIAGNOSTIC,
  assertHookPublicationFence,
  isBackendPublicationEvidenceMissing,
  isBackendPublicationJournalError,
} from "./publication-fence.js";

interface PostToolHookInput {
  client?: unknown;
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_output?: unknown;
  cwd?: unknown;
}

function resolveHookCwd(inputCwd: unknown): string {
  const cwd = typeof inputCwd === "string" ? inputCwd : "";
  const envCwd = typeof process.env.CLAUDE_PROJECT_DIR === "string"
    ? process.env.CLAUDE_PROJECT_DIR
    : "";
  if (cwd.trim().length > 0) return cwd;
  if (envCwd.trim().length > 0) return envCwd;
  return process.cwd();
}

export async function handlePostToolUse(
  stdin: string,
  _port?: number,
): Promise<{ exitCode: number; stdout: string }> {
  let cwd: string | undefined;
  let enqueued = false;
  try {
    const input = JSON.parse(stdin) as PostToolHookInput;
    const { session_id, tool_name } = input;

    if (typeof tool_name !== "string" || typeof session_id !== "string") return { exitCode: 0, stdout: "" };

    const extractedEvents = extractPostToolEvents(normalizePostToolInput(input));
    if (extractedEvents.length === 0) return { exitCode: 0, stdout: "" };

    const resolvedCwd = resolveHookCwd(input.cwd);
    cwd = resolvedCwd;
    const { scrubExtractedEvents } = await import("./event-scrubbing.js");
    let events;
    try {
      events = await scrubExtractedEvents(extractedEvents, resolvedCwd);
    } catch (error) {
      if (!isBackendPublicationJournalError(error)) throw error;
      // A malformed or unresolved publication cannot prevent the original
      // event from reaching the durable local outbox. Built-in scrubbing is
      // still applied while the publication error remains control flow.
      events = await scrubExtractedEvents(extractedEvents, resolvedCwd, []);
    }

    await appendLocalHookEvents({
      cwd: resolvedCwd,
      sessionId: session_id,
      events,
      sourceHook: "PostToolUse",
    });
    enqueued = true;

    // Project metadata is a selected-state consumer. Re-admit immediately
    // before its own coordinator-aware operation; do not retain this lock over
    // project-map reconciliation.
    try {
      assertHookPublicationFence();
      ensureProjectDir(resolvedCwd);
    } catch (error) {
      // A staged backend without terminal publication evidence blocks all
      // selected-state consumers, but the already-durable local event remains
      // the successful PostToolUse outcome.
      if (isBackendPublicationEvidenceMissing(error)) return { exitCode: 0, stdout: "" };
      throw error;
    }

    // PostToolUse payloads are untrusted. Persist events locally and let the
    // daemon's bounded background scan process them; never use a payload port
    // for a token-bearing request.
  } catch (error) {
    if (isBackendPublicationJournalError(error)) {
      try {
        await safeLogError(
          "PostToolUse",
          `${BACKEND_PUBLICATION_ADMISSION_DIAGNOSTIC} (reason: ${error.reason})`,
          { cwd },
        );
      } catch {
        // Preserve the original publication error when diagnostic logging fails.
      }
      if (enqueued) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ systemMessage: BACKEND_PUBLICATION_ADMISSION_DIAGNOSTIC }),
        };
      }
      throw error;
    }
    if (enqueued && error instanceof PrivateMutationLockContentionError) {
      return { exitCode: 0, stdout: "" };
    }
    await safeLogError("PostToolUse", error, { cwd });
  }

  return { exitCode: 0, stdout: "" };
}
