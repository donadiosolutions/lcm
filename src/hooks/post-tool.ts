// src/hooks/post-tool.ts
import { extractPostToolEvents } from "./extractors.js";
import { EventsDb } from "./events-db.js";
import { eventsDbPath } from "../db/events-path.js";
import { firePromoteEventsNotifyRequest } from "./session-end.js";
import { safeLogError } from "./hook-errors.js";
import { ensureProjectDir } from "../daemon/project.js";


function resolveHookCwd(inputCwd: unknown): string {
  const cwd = typeof inputCwd === "string" ? inputCwd.trim() : "";
  const envCwd = typeof process.env.CLAUDE_PROJECT_DIR === "string"
    ? process.env.CLAUDE_PROJECT_DIR.trim()
    : "";
  if (cwd.length > 0) return cwd;
  if (envCwd.length > 0) return envCwd;
  return process.cwd();
}

export async function handlePostToolUse(
  stdin: string,
): Promise<{ exitCode: number; stdout: string }> {
  let cwd: string | undefined;
  try {
    const input = JSON.parse(stdin);
    const { session_id, tool_name, tool_input, tool_response, tool_output } = input;

    if (!tool_name || !session_id) return { exitCode: 0, stdout: "" };

    const events = extractPostToolEvents({ tool_name, tool_input: tool_input ?? {}, tool_response, tool_output });
    if (events.length === 0) return { exitCode: 0, stdout: "" };

    const resolvedCwd = resolveHookCwd(input.cwd);
    cwd = resolvedCwd;
    ensureProjectDir(resolvedCwd);
    const dbPath = eventsDbPath(resolvedCwd);
    const db = new EventsDb(dbPath);

    try {
      for (const event of events) {
        db.insertEvent(session_id, event, "PostToolUse");
      }

      const port = input.daemon_port ?? 3737;
      const priority = Math.min(...events.map(e => e.priority));
      const pendingCount = db.getHealthStats().unprocessed;
      firePromoteEventsNotifyRequest(port, {
        cwd: resolvedCwd,
        priority,
        pendingCount,
        sourceHook: "PostToolUse",
      });
    } finally {
      db.close();
    }
  } catch (error) {
    safeLogError("PostToolUse", error, { cwd });
  }

  return { exitCode: 0, stdout: "" };
}
