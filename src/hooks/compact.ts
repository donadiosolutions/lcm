import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { normalizeTranscriptClient } from "../transcript-provider.js";
import { daemonPidPath, lcmHomeDir } from "../runtime-paths.js";
import { fenceContent } from "../daemon/content-fence.js";
import { safeLogError } from "./hook-errors.js";
import type { StorageBackendSelection } from "../storage/backend.js";
import { selectStorageBackend } from "../storage/backend.js";
import {
  clearDaemonNotice,
  maybeEmitDaemonNotice,
  sanitizeDaemonRefusalReason,
} from "./daemon-notice.js";
import { isDaemonRefusalReason, type DaemonRefusalReason } from "../daemon/remediation.js";
import {
  assertHookPublicationFence,
  isBackendPublicationJournalError,
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

export async function handlePreCompact(
  stdin: string,
  client: DaemonClient,
  port?: number,
  storage: StorageBackendSelection = { backend: "sqlite" },
): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = daemonPidPath();
  let ensureResult: EnsureResultWithRefusal;
  try {
    selectStorageBackend(storage);
  } catch (error) {
    if (isBackendPublicationJournalError(error)) return { exitCode: 0, stdout: "" };
    await safeLogError("PreCompact", error, {});
    return { exitCode: 0, stdout: "" };
  }
  try {
    ensureResult = await ensureDaemon({
      port: daemonPort,
      pidFilePath,
      spawnTimeoutMs: 5000,
      expectedStorageBackend: storage.backend,
      enforceUserManagerParent: true,
    });
  } catch (error) {
    if (isBackendPublicationJournalError(error)) return { exitCode: 0, stdout: "" };
    emitAdmissionNotice(undefined, "ambiguous");
    return { exitCode: 0, stdout: "" };
  }
  if (!ensureResult.connected) {
    emitAdmissionNotice(ensureResult, "not-running");
    return { exitCode: 0, stdout: "" };
  }
  clearAdmissionNotice();

  try {
    const input = JSON.parse(stdin || "{}");
    const clientName = normalizeTranscriptClient(input.client ?? process.env.LCM_CLIENT);
    // Check immediately before the daemon request, then release the lock so
    // the daemon's own config/lifecycle admission cannot self-contention.
    assertHookPublicationFence();
    const result = await client.post<{ summary: string; latestSummaryContent?: string }>("/compact", {
      ...input,
      client: clientName,
    });

    try {
      const { firePromoteEventsRequest } = await import("./session-end.js");
      firePromoteEventsRequest(daemonPort, { cwd: input.cwd });
    } catch (error) {
      if (isBackendPublicationJournalError(error)) return { exitCode: 0, stdout: "" };
      // Silent fail — PreCompact must not delay session
    }

    const parts: string[] = [];
    if (result.summary) parts.push(result.summary);
    if (result.latestSummaryContent) {
      const truncated = result.latestSummaryContent.length > 2000
        ? result.latestSummaryContent.slice(0, 2000) + "\n[truncated]"
        : result.latestSummaryContent;
      parts.push(fenceContent(truncated, "compaction-summary"));
    }

    return { exitCode: 0, stdout: parts.join("\n\n") };
  } catch (error) {
    if (isBackendPublicationJournalError(error)) return { exitCode: 0, stdout: "" };
    return { exitCode: 0, stdout: "" };
  }
}
