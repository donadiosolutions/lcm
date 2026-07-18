import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { loadDaemonConfig } from "../daemon/config.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { request } from "node:http";
import { Buffer } from "node:buffer";
import { normalizeTranscriptClient } from "../transcript-provider.js";
import { configPath as defaultConfigPath, daemonPidPath, daemonTokenPath } from "../runtime-paths.js";
import { readAuthToken } from "../daemon/auth.js";

function getDaemonToken(): string | null {
  return readAuthToken(daemonTokenPath());
}

function fireLocalPostRequest(port: number, path: string, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  const token = getDaemonToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(json)),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const req = request({
    hostname: "127.0.0.1",
    port,
    path,
    method: "POST",
    headers,
  });
  req.on("socket", (socket) => {
    // Defer unref until after the request body is flushed so the daemon
    // request reliably reaches the daemon before the process is allowed to exit.
    req.on("finish", () => (socket as import("node:net").Socket).unref());
  });
  req.on("error", () => {}); // non-fatal
  req.write(json);
  req.end();
}

/**
 * Fire a compact request to the daemon without blocking the hook process.
 *
 * Uses a raw http.request with socket.unref() so the Node.js event loop
 * does not wait for a response — the process exits as soon as the request
 * is sent. The daemon receives and processes the request independently.
 *
 * This is intentionally separate from DaemonClient.post() (which uses fetch
 * and keeps the event loop alive until a response is received).
 */
export function fireCompactRequest(
  port: number,
  body: Record<string, unknown>,
): void {
  fireLocalPostRequest(port, "/compact", body);
}

export function firePromoteRequest(port: number, body: Record<string, unknown>): void {
  fireLocalPostRequest(port, "/promote", body);
}

export function firePromoteEventsRequest(port: number, body: Record<string, unknown>): void {
  fireLocalPostRequest(port, "/promote-events", body);
}

/**
 * Fire a promote-events notification to the daemon without blocking the hook process.
 *
 * Uses a raw http.request with socket.unref() so the Node.js event loop does not
 * wait for a response. The daemon receives and processes the notification
 * independently.
 *
 * This is intentionally separate from DaemonClient.post(), which is a full
 * request/response client.
 */
export function firePromoteEventsNotifyRequest(port: number, body: Record<string, unknown>): void {
  fireLocalPostRequest(port, "/promote-events/notify", body);
}

export function fireSessionCompleteRequest(port: number, body: Record<string, unknown>): void {
  fireLocalPostRequest(port, "/session-complete", body);
}

export async function handleSessionEnd(
  stdin: string,
  client: DaemonClient,
  port?: number,
): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = daemonPidPath();
  const { connected } = await ensureDaemon({
    port: daemonPort,
    pidFilePath,
    spawnTimeoutMs: 5000,
    enforceUserManagerParent: true,
  });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");
    const clientName = normalizeTranscriptClient(input.client ?? process.env.LCM_CLIENT);
    const ingestResult = await client.post<{
      ingested: number;
      totalTokens?: number;
      redacted?: number;
      redactedCategories?: string[];
    }>("/ingest", { ...input, client: clientName });

    const configPath = defaultConfigPath();
    const config = loadDaemonConfig(configPath);
    const disableCompact = config.hooks?.disableAutoCompact ?? false;

    // Notify user when sensitive data was filtered (default: on)
    const notifyOnFilter = config.security?.notify_on_filter !== false;
    if (notifyOnFilter && ingestResult.redacted && ingestResult.redacted > 0) {
      const categories = ingestResult.redactedCategories
        ?.map((category) => category.trim())
        .filter(Boolean)
        .join(", ") || "unknown";
      process.stderr.write(
        `⚠️  lcm: filtered sensitive data from history (pattern: ${categories})\n`,
      );
    }

    if (!disableCompact) {
      // Fire-and-forget via unreffed http.request — does not block the event loop.
      // The daemon receives and compacts independently after the hook process exits.
      fireCompactRequest(daemonPort, {
        session_id: input.session_id,
        cwd: input.cwd,
        skip_ingest: true,
        client: clientName,
      });
    }

    // Always promote
    firePromoteRequest(daemonPort, { cwd: input.cwd });

    // Promote events for passive learning
    firePromoteEventsRequest(daemonPort, { cwd: input.cwd });

    if (clientName === "claude") {
      // Record session completion in manifest. Codex Stop is turn-scoped, so
      // marking complete there would block later turn snapshots for the session.
      fireSessionCompleteRequest(daemonPort, {
        session_id: input.session_id,
        cwd: input.cwd,
        message_count: ingestResult.ingested ?? 0,
      });
    }

    return { exitCode: 0, stdout: "" };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
