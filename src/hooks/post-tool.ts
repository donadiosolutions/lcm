// src/hooks/post-tool.ts
import { extractPostToolEvents } from "./extractors.js";
import { EventsDb } from "./events-db.js";
import { eventsDbPath } from "../db/events-path.js";
import { firePromoteEventsNotifyRequest } from "./session-end.js";
import { safeLogError } from "./hook-errors.js";
import { ensureProjectDir } from "../daemon/project.js";

interface PostToolHookInput {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_output?: unknown;
  cwd?: unknown;
  daemon_port?: unknown;
}

function resolveHookCwd(inputCwd: unknown): string {
  const cwd = typeof inputCwd === "string" ? inputCwd.trim() : "";
  const envCwd = typeof process.env.CLAUDE_PROJECT_DIR === "string"
    ? process.env.CLAUDE_PROJECT_DIR.trim()
    : "";
  if (cwd.length > 0) return cwd;
  if (envCwd.length > 0) return envCwd;
  return process.cwd();
}

function normalizeHookPort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 1 && value <= 65535 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolOutput(value: unknown): { isError?: boolean } | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.isError === "boolean" ? { isError: value.isError } : {};
}

export async function handlePostToolUse(
  stdin: string,
  port?: number,
): Promise<{ exitCode: number; stdout: string }> {
  let cwd: string | undefined;
  try {
    const input = JSON.parse(stdin) as PostToolHookInput;
    const { session_id, tool_name, tool_input, tool_response, tool_output } = input;

    if (typeof tool_name !== "string" || typeof session_id !== "string") return { exitCode: 0, stdout: "" };

    const events = extractPostToolEvents({
      tool_name,
      tool_input: isRecord(tool_input) ? tool_input : {},
      tool_response,
      tool_output: normalizeToolOutput(tool_output),
    });
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

      const daemonPort = normalizeHookPort(input.daemon_port) ?? port ?? 3737;
      const priority = Math.min(...events.map(e => e.priority));
      firePromoteEventsNotifyRequest(daemonPort, {
        cwd: resolvedCwd,
        priority,
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
