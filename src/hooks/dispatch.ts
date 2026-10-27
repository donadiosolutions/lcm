import { validateAndFixHooks } from "./auto-heal.js";
import { resolveLcmConfig } from "../db/config.js";
import { configPath as defaultConfigPath } from "../runtime-paths.js";
import { PrivateMutationLockContentionError } from "../private-mutation-lock.js";
import {
  HOOK_SESSION_END_CONTENTION_WAIT_MS,
  hookAdmissionRetry,
  rethrowBackendPublicationJournalError,
  type HookAdmissionRetry,
} from "./publication-fence.js";
import type { ConnectorTransport } from "../connectors/types.js";
import { resolveHookSessionScope } from "./subagent-scope.js";
import type { TerminalHookContext } from "./terminal-snapshot.js";

export const HOOK_COMMANDS = ["compact", "post-tool", "pre-tool", "restore", "session-end", "session-snapshot", "user-prompt"] as const;
export type HookCommand = typeof HOOK_COMMANDS[number];
export type HookExecutionContext = Readonly<{
  transport?: ConnectorTransport;
  /** Present only for Codex Interrupt and SessionEnd snapshots. */
  terminal?: TerminalHookContext;
  /**
   * Shared contention allowance of one invocation. Dispatch creates it for the
   * hooks that opt in; a caller may supply one, which tests use to avoid timers.
   */
  admissionRetry?: HookAdmissionRetry;
}>;

// Event names used when the dispatch-level config load is skipped by lock
// contention; they match the names each handler logs its own contention under.
const HOOK_EVENT_NAMES = {
  compact: "PreCompact",
  restore: "SessionStart",
  "session-end": "SessionEnd",
} as const;

export function isHookCommand(cmd: string): cmd is HookCommand {
  return (HOOK_COMMANDS as readonly string[]).includes(cmd);
}

function hookClientFromPayload(stdinText: string): string | undefined {
  try {
    const parsed = JSON.parse(stdinText || "{}") as { client?: unknown };
    return typeof parsed.client === "string" ? parsed.client : undefined;
  } catch {
    return undefined;
  }
}

export async function dispatchHook(
  command: HookCommand,
  stdinText: string,
  context: HookExecutionContext = {},
): Promise<{ exitCode: number; stdout: string }> {
  // Documented contract (docs/configuration.md#disabling-lcm): LCM_ENABLED=false
  // keeps the hooks installed but makes every one of them a no-op.
  if (!resolveLcmConfig(process.env).enabled) return { exitCode: 0, stdout: "" };

  let verifiedSnapshotPort: number | undefined;
  // Terminal snapshots only hand the transcript to an already-running, verified
  // daemon: no bootstrap, hook repair, cursor or throttle work precedes this.
  if (command === "session-snapshot" && context.terminal !== undefined) {
    const { handleTerminalSnapshot } = await import("./terminal-snapshot.js");
    return handleTerminalSnapshot(stdinText, context.terminal);
  }
  // Early return for post-tool — runs on EVERY tool call, must skip bootstrap for performance
  if (command === "post-tool") {
    const { handlePostToolUse } = await import("./post-tool.js");
    return handlePostToolUse(stdinText);
  }

  // Early return for pre-tool — opt-in, runs synchronously before every
  // matched tool call, and must never bootstrap or start the daemon.
  if (command === "pre-tool") {
    const { handlePreToolUse } = await import("./pre-tool.js");
    return handlePreToolUse(stdinText);
  }

  // Restore, compact and session snapshots have Codex timeouts of 30 seconds
  // (Claude's defaults are not shorter), so they wait briefly for a live
  // publication-lock owner. One allowance covers every pre-effect admission
  // of the invocation. Session-end runs under a much shorter host timeout and
  // gets a proportionally smaller allowance.
  const admissionRetry = context.admissionRetry ?? hookAdmissionRetry(
    command === "session-end" ? { totalMs: HOOK_SESSION_END_CONTENTION_WAIT_MS } : {},
  );

  // Skip bootstrap for compact because SessionStart already ensured the daemon.
  // UserPromptSubmit owns its ordering: persist the local SQLite outbox first,
  // then preflight storage and ensure the daemon from inside its handler.
  if (command !== "compact" && command !== "user-prompt") {
    // Lazy bootstrap: create config + start daemon on first hook fire per session
    try {
      // A Codex child bootstraps under its tree session_id; one that lacks it
      // is still verified under its agent_id, like any other snapshot.
      const scope = resolveHookSessionScope(JSON.parse(stdinText || "{}"));
      const session_id = scope.treeSessionId ?? scope.sessionId;
      if (session_id) {
        const { ensureBootstrapped, ensureCoreEndpoint } = await import("../bootstrap.js");
        // Session snapshots contain transcript paths and payload data, so they
        // reverify the current endpoint even when this session has a bootstrap
        // flag from an earlier healthy daemon.
        const endpoint = command === "session-snapshot"
          ? await ensureCoreEndpoint(undefined, admissionRetry)
          : undefined;
        const verified = endpoint?.connected ?? await ensureBootstrapped(session_id, undefined, admissionRetry);
        if (command === "session-snapshot" && !verified) {
          return { exitCode: 0, stdout: "" };
        }
        if (command === "session-snapshot") verifiedSnapshotPort = endpoint!.port;
      }
    } catch (error) {
      rethrowBackendPublicationJournalError(error);
      // Most hooks retain their existing best-effort behavior, but snapshots
      // must never send transcript data or credentials to an unverified port.
      if (command === "session-snapshot") return { exitCode: 0, stdout: "" };
    }
  }

  const hookClient = hookClientFromPayload(stdinText) ?? process.env.LCM_CLIENT;
  if (command !== "user-prompt" && hookClient !== "codex") {
    validateAndFixHooks();
  }

  // UserPromptSubmit owns its own ordering: it must append the local event
  // before loading the selected backend/configuration or booting the daemon.
  // Its handler loads the config lazily inside the publication fence.
  if (command === "user-prompt") {
    const { handleUserPromptSubmit } = await import("./user-prompt.js");
    return context.transport === undefined
      ? handleUserPromptSubmit(stdinText)
      : handleUserPromptSubmit(stdinText, undefined, undefined, undefined, context.transport);
  }

  // Session snapshots use neither the loaded port nor the storage selection,
  // so they must not wait on the publication lock for a config projection.
  if (command === "session-snapshot") {
    const { handleSessionSnapshot } = await import("./session-snapshot.js");
    return handleSessionSnapshot(
      stdinText,
      verifiedSnapshotPort === undefined
        ? { admissionRetry }
        : { verifiedPort: verifiedSnapshotPort, admissionRetry },
    );
  }
  const { DaemonClient } = await import("../daemon/client.js");
  const { loadHookConfig } = await import("./config.js");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  let config: ReturnType<typeof loadHookConfig>;
  try {
    config = await admissionRetry(() => loadHookConfig(defaultConfigPath()));
  } catch (error) {
    // Ordinary publication-lock contention is a best-effort hook outcome, the
    // same one each handler's own publication fence produces. Journal errors
    // and every other failure still propagate.
    if (!(error instanceof PrivateMutationLockContentionError)) throw error;
    const { safeLogError } = await import("./hook-errors.js");
    await safeLogError(HOOK_EVENT_NAMES[command], error, {});
    return { exitCode: 0, stdout: "" };
  }
  const port = config.daemonPort;
  const client = new DaemonClient(`http://127.0.0.1:${port}`);

  switch (command) {
    case "compact": {
      const { handlePreCompact } = await import("./compact.js");
      return handlePreCompact(stdinText, client, port, config.storage, admissionRetry);
    }
    case "restore": {
      const { handleSessionStart } = await import("./restore.js");
      return handleSessionStart(stdinText, client, port, config.storage, admissionRetry);
    }
    case "session-end": {
      const { handleSessionEnd } = await import("./session-end.js");
      return handleSessionEnd(stdinText, client, port, config.storage, admissionRetry);
    }
    default:
      throw new Error(`Unknown hook command: ${command}`);
  }
}
