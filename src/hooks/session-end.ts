import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { loadDaemonConfig } from "../daemon/config.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { request } from "node:http";
import { Buffer } from "node:buffer";
import { normalizeTranscriptClient } from "../transcript-provider.js";
import { safeLogError } from "./hook-errors.js";
import { configPath as defaultConfigPath, daemonPidPath, daemonTokenPath, lcmHomeDir } from "../runtime-paths.js";
import { readAuthToken } from "../daemon/auth.js";
import type { StorageBackendSelection } from "../storage/backend.js";
import {
  clearDaemonNotice,
  maybeEmitDaemonNotice,
  sanitizeDaemonRefusalReason,
} from "./daemon-notice.js";
import { isDaemonRefusalReason, type DaemonRefusalReason } from "../daemon/remediation.js";
import {
  assertHookPublicationFence,
  assertHookPublicationFenceToken,
  isBackendPublicationEvidenceMissing,
  isBackendPublicationJournalError,
  type HookPublicationLockToken,
  withHookPublicationFence,
} from "./publication-fence.js";

type EnsureResultWithRefusal = Readonly<{ connected: boolean; refusalReason?: unknown }>;

function canonicalRemediationScope(): Readonly<{ scope: string; stateRoot: string }> {
  const root = lcmHomeDir(homedir());
  try {
    const canonical = realpathSync(root);
    return { scope: canonical, stateRoot: canonical };
  } catch {
    const lexical = resolve(root);
    return { scope: lexical, stateRoot: lexical };
  }
}

function emitAdmissionNotice(result: EnsureResultWithRefusal | undefined, fallback: DaemonRefusalReason): void {
  const reason = isDaemonRefusalReason(result?.refusalReason)
    ? result.refusalReason
    : sanitizeDaemonRefusalReason(fallback);
  maybeEmitDaemonNotice({ ...canonicalRemediationScope(), reason });
}

function clearAdmissionNotice(): void {
  clearDaemonNotice(canonicalRemediationScope());
}

function getDaemonToken(): string | null {
  return readAuthToken(daemonTokenPath());
}

function fireLocalPostRequestRaw(
  port: number,
  path: string,
  body: Record<string, unknown>,
  lockToken: HookPublicationLockToken,
): void {
  assertHookPublicationFenceToken(lockToken);
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
  withHookPublicationFence((lockToken) => fireLocalPostRequestRaw(port, "/compact", body, lockToken));
}

export function firePromoteRequest(port: number, body: Record<string, unknown>): void {
  withHookPublicationFence((lockToken) => fireLocalPostRequestRaw(port, "/promote", body, lockToken));
}

export function firePromoteEventsRequest(port: number, body: Record<string, unknown>): void {
  withHookPublicationFence((lockToken) => fireLocalPostRequestRaw(port, "/promote-events", body, lockToken));
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
  withHookPublicationFence((lockToken) => fireLocalPostRequestRaw(port, "/promote-events/notify", body, lockToken));
}

export function fireSessionCompleteRequest(port: number, body: Record<string, unknown>): void {
  withHookPublicationFence((lockToken) => fireLocalPostRequestRaw(port, "/session-complete", body, lockToken));
}

export async function handleSessionEnd(
  stdin: string,
  client: DaemonClient,
  port?: number,
  storage: StorageBackendSelection = { backend: "sqlite" },
): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = daemonPidPath();
  let admitted: Readonly<{
    input: Record<string, unknown>;
    clientName: string;
    ingestResult: {
      ingested: number;
      totalTokens?: number;
      redacted?: number;
      redactedCategories?: string[];
    };
    disableCompact: boolean;
  }>;
  try {
    try {
      assertHookPublicationFence();
    } catch (error) {
      if (isBackendPublicationJournalError(error) && !isBackendPublicationEvidenceMissing(error)) throw error;
      await safeLogError(
        "SessionEnd",
        error,
        {},
      );
      return { exitCode: 0, stdout: "" };
    }

    let ensureResult: EnsureResultWithRefusal;
    try {
      // The lifecycle owns its own before/after publication admission. Do not
      // retain the interprocess lock across spawn, signal, or health waits.
      ensureResult = await ensureDaemon({
        port: daemonPort,
        pidFilePath,
        spawnTimeoutMs: 5000,
        expectedStorageBackend: storage.backend,
        enforceUserManagerParent: true,
      });
    } catch (error) {
      if (isBackendPublicationJournalError(error)) throw error;
      emitAdmissionNotice(undefined, "ambiguous");
      return { exitCode: 0, stdout: "" };
    }
    if (!ensureResult.connected) {
      emitAdmissionNotice(ensureResult, "not-running");
      return { exitCode: 0, stdout: "" };
    }
    clearAdmissionNotice();

    try {
      const input = JSON.parse(stdin || "{}") as Record<string, unknown>;
      const clientName = normalizeTranscriptClient(input.client ?? process.env.LCM_CLIENT);
      // The daemon client owns its own admission at the lifecycle boundary;
      // perform a fresh read-only check without holding it across the request.
      assertHookPublicationFence();
      const ingestResult = await client.post<{
        ingested: number;
        totalTokens?: number;
        redacted?: number;
        redactedCategories?: string[];
      }>("/ingest", { ...input, client: clientName });

      const config = loadDaemonConfig(defaultConfigPath());
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
      admitted = { input, clientName, ingestResult, disableCompact };
    } catch (error) {
      if (isBackendPublicationJournalError(error)) throw error;
      return { exitCode: 0, stdout: "" };
    }
  } catch (error) {
    if (isBackendPublicationJournalError(error)) throw error;
    return { exitCode: 0, stdout: "" };
  }

  const { input, clientName, ingestResult, disableCompact } = admitted;
  if (!disableCompact) {
    fireCompactRequest(daemonPort, {
      session_id: input.session_id,
      cwd: input.cwd,
      skip_ingest: true,
      client: clientName,
    });
  }
  firePromoteRequest(daemonPort, { cwd: input.cwd });
  firePromoteEventsRequest(daemonPort, { cwd: input.cwd });
  if (clientName === "claude") {
    fireSessionCompleteRequest(daemonPort, {
      session_id: input.session_id,
      cwd: input.cwd,
      message_count: ingestResult.ingested ?? 0,
    });
  }
  return { exitCode: 0, stdout: "" };
}
