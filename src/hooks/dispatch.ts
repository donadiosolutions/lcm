import { validateAndFixHooks } from "./auto-heal.js";
import { configPath as defaultConfigPath } from "../runtime-paths.js";

export const HOOK_COMMANDS = ["compact", "post-tool", "restore", "session-end", "session-snapshot", "user-prompt"] as const;
export type HookCommand = typeof HOOK_COMMANDS[number];

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
): Promise<{ exitCode: number; stdout: string }> {
  let verifiedSnapshotPort: number | undefined;
  // Early return for post-tool — runs on EVERY tool call, must skip bootstrap for performance
  if (command === "post-tool") {
    const { handlePostToolUse } = await import("./post-tool.js");
    return handlePostToolUse(stdinText);
  }

  // Skip bootstrap for compact — the daemon is already running by the time
  // PreCompact fires (SessionStart ensures it). Skipping saves ~5s of
  // ensureDaemon timeout budget under the hook runner's tight deadline.
  if (command !== "compact") {
    // Lazy bootstrap: create config + start daemon on first hook fire per session
    try {
      const { session_id } = JSON.parse(stdinText || "{}");
      if (session_id) {
        const { ensureBootstrapped, ensureCoreEndpoint } = await import("../bootstrap.js");
        // Session snapshots contain transcript paths and payload data, so they
        // reverify the current endpoint even when this session has a bootstrap
        // flag from an earlier healthy daemon.
        const endpoint = command === "session-snapshot" ? await ensureCoreEndpoint() : undefined;
        const verified = endpoint?.connected ?? await ensureBootstrapped(session_id);
        if (command === "session-snapshot" && !verified) {
          return { exitCode: 0, stdout: "" };
        }
        if (command === "session-snapshot") verifiedSnapshotPort = endpoint!.port;
      }
    } catch {
      // Most hooks retain their existing best-effort behavior, but snapshots
      // must never send transcript data or credentials to an unverified port.
      if (command === "session-snapshot") return { exitCode: 0, stdout: "" };
    }
  }

  const hookClient = hookClientFromPayload(stdinText) ?? process.env.LCM_CLIENT;
  if (hookClient !== "codex") {
    validateAndFixHooks();
  }

  const { DaemonClient } = await import("../daemon/client.js");
  const { loadDaemonConfig } = await import("../daemon/config.js");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const config = loadDaemonConfig(defaultConfigPath());
  const port = config.daemon?.port ?? 3737;
  const client = new DaemonClient(`http://127.0.0.1:${port}`);

  switch (command) {
    case "compact": {
      const { handlePreCompact } = await import("./compact.js");
      return handlePreCompact(stdinText, client, port);
    }
    case "restore": {
      const { handleSessionStart } = await import("./restore.js");
      return handleSessionStart(stdinText, client, port);
    }
    case "session-end": {
      const { handleSessionEnd } = await import("./session-end.js");
      return handleSessionEnd(stdinText, client, port);
    }
    case "session-snapshot": {
      const { handleSessionSnapshot } = await import("./session-snapshot.js");
      return verifiedSnapshotPort === undefined
        ? handleSessionSnapshot(stdinText)
        : handleSessionSnapshot(stdinText, { verifiedPort: verifiedSnapshotPort });
    }
    case "user-prompt": {
      const { handleUserPromptSubmit } = await import("./user-prompt.js");
      return handleUserPromptSubmit(stdinText, client, port);
    }
    default:
      throw new Error(`Unknown hook command: ${command}`);
  }
}
