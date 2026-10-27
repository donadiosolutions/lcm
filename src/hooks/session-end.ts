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
import { admitDaemonPeer, type DaemonPeerAdmission } from "../daemon/peer-admission.js";
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
  NO_HOOK_ADMISSION_RETRY,
  rethrowBackendPublicationJournalError,
  type HookAdmissionRetry,
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

/** One monotonic allowance shared by consecutive best-effort notifications. */
export type HookPeerBudget = Readonly<{
  deadline: number;
  /** @internal Deterministic listener admission for hook tests. */
  admitPeerForTesting?: (port: number, deadline: number) => DaemonPeerAdmission | null;
}>;

function fireLocalPostRequestRaw(
  port: number,
  path: string,
  body: Record<string, unknown>,
  lockToken: HookPublicationLockToken,
  budget?: HookPeerBudget,
): void {
  assertHookPublicationFenceToken(lockToken);
  const deadline = budget?.deadline ?? performance.now() + 500;
  const peer = budget?.admitPeerForTesting === undefined
    ? admitDaemonPeer({ port, deadline })
    : budget.admitPeerForTesting(port, deadline);
  if (peer === null || performance.now() >= deadline) return;
  const json = JSON.stringify(body);
  assertHookPublicationFenceToken(lockToken);
  if (performance.now() >= deadline) return;
  const token = getDaemonToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(json)),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  assertHookPublicationFenceToken(lockToken);
  if (performance.now() >= deadline) return;
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
  budget?: HookPeerBudget,
): void {
  withHookPublicationFence((lockToken) => fireLocalPostRequestRaw(port, "/compact", body, lockToken, budget));
}

export function firePromoteRequest(port: number, body: Record<string, unknown>, budget?: HookPeerBudget): void {
  withHookPublicationFence((lockToken) => fireLocalPostRequestRaw(port, "/promote", body, lockToken, budget));
}

export function firePromoteEventsRequest(port: number, body: Record<string, unknown>, budget?: HookPeerBudget): void {
  withHookPublicationFence((lockToken) => fireLocalPostRequestRaw(port, "/promote-events", body, lockToken, budget));
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
export function firePromoteEventsNotifyRequest(port: number, body: Record<string, unknown>, budget?: HookPeerBudget): void {
  withHookPublicationFence((lockToken) => fireLocalPostRequestRaw(port, "/promote-events/notify", body, lockToken, budget));
}

function scheduleBackgroundRequest(schedule: () => void): void {
  try {
    schedule();
  } catch (error) {
    rethrowBackendPublicationJournalError(error);
  }
}

function classifyCompletionFailure(signal: AbortSignal | undefined, error: unknown): string {
  if (signal?.aborted === true) return "timeout";
  const statusCode = typeof error === "object" && error !== null
    ? (error as { statusCode?: unknown }).statusCode
    : undefined;
  return typeof statusCode === "number" && Number.isInteger(statusCode)
    && statusCode >= 100 && statusCode <= 599
    ? "status-" + statusCode
    : "unavailable";
}

// Fixed text only: never include the error message, response body or paths.
function reportUnacknowledgedCompletion(reason: string): void {
  try {
    process.stderr.write("lcm: session completion was not acknowledged (" + reason + ")\n");
  } catch {
    // The diagnostic is best-effort and must not change the hook outcome.
  }
}

export async function handleSessionEnd(
  stdin: string,
  client: DaemonClient,
  port?: number,
  storage: StorageBackendSelection = { backend: "sqlite" },
  admissionRetry?: HookAdmissionRetry,
): Promise<{ exitCode: number; stdout: string }> {
  const retry = admissionRetry ?? NO_HOOK_ADMISSION_RETRY;
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
      await retry(() => assertHookPublicationFence());
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
        ...(admissionRetry === undefined ? {} : { _withPublicationAdmissionRetry: admissionRetry }),
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
      // Snapshot settings before ingest can trigger concurrent daemon writes.
      // The authenticated config load releases its lock before network work.
      const config = await retry(() => loadDaemonConfig(defaultConfigPath()));
      const disableCompact = config.hooks?.disableAutoCompact ?? false;
      // The daemon client owns its own admission at the lifecycle boundary;
      // perform a fresh read-only check without holding it across the request.
      await retry(() => assertHookPublicationFence());
      const ingestResult = await client.post<{
        ingested: number;
        totalTokens?: number;
        redacted?: number;
        redactedCategories?: string[];
      }>("/ingest", { ...input, client: clientName });

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
  const backgroundPeerBudget: HookPeerBudget = { deadline: performance.now() + 500 };
  if (!disableCompact) {
    scheduleBackgroundRequest(() => fireCompactRequest(daemonPort, {
      session_id: input.session_id,
      cwd: input.cwd,
      skip_ingest: true,
      client: clientName,
    }, backgroundPeerBudget));
  }
  scheduleBackgroundRequest(() => firePromoteRequest(daemonPort, { cwd: input.cwd }, backgroundPeerBudget));
  scheduleBackgroundRequest(() => firePromoteEventsRequest(daemonPort, { cwd: input.cwd }, backgroundPeerBudget));
  if (clientName === "claude") {
    // Created only after the fence check so the one-second budget covers the request alone.
    let completionSignal: AbortSignal | undefined;
    try {
      // The CLI explicitly exits after dispatch. Wait for the completion
      // response, with an absolute bound, without retaining publication locks.
      assertHookPublicationFence();
      completionSignal = AbortSignal.timeout(1000);
      await client.post("/session-complete", {
        session_id: input.session_id,
        cwd: input.cwd,
        message_count: ingestResult.ingested ?? 0,
      }, { signal: completionSignal });
    } catch (error) {
      if (isBackendPublicationJournalError(error)) throw error;
      // Completion remains best-effort on contention or transport failure.
      reportUnacknowledgedCompletion(classifyCompletionFailure(completionSignal, error));
    }
  }
  return { exitCode: 0, stdout: "" };
}
