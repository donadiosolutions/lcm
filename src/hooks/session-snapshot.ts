import { statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { normalizeTranscriptClient } from "../transcript-provider.js";
import { daemonJsonRequest, normalizeDaemonPort } from "../daemon/http-url.js";
import { admitDaemonPeer, type DaemonPeerAdmission } from "../daemon/peer-admission.js";
import type { HookPeerBudget } from "./session-end.js";
import { configPath as defaultConfigPath, daemonTokenPath, tmpDir as lcmTmpDir } from "../runtime-paths.js";
import {
  assertHookPublicationFence,
  assertHookRootEstablished,
  isBackendPublicationJournalError,
  NO_HOOK_ADMISSION_RETRY,
  type HookAdmissionRetry,
} from "./publication-fence.js";
import { resolveHookSessionScope } from "./subagent-scope.js";

export interface SnapshotDeps {
  statSync: (path: string) => { mtimeMs: number } | null;
  writeFileSync: (path: string, data: string) => void;
  snapshotIntervalSec: number;
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  verifiedPort?: number;
  /** Waits for a live publication-lock owner before each pre-effect admission. */
  admissionRetry?: HookAdmissionRetry;
  /** @internal Deterministic listener admission for snapshot tests. */
  _admitPeerForTesting?: (port: number, deadline: number) => DaemonPeerAdmission | null;
}

function defaultStatSync(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export async function handleSessionSnapshot(
  stdin: string,
  deps?: Partial<SnapshotDeps>,
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const input = JSON.parse(stdin || "{}");
    const { cwd } = input;
    const scope = resolveHookSessionScope(input);
    const session_id = scope.sessionId;
    const isSubagentStop = input.hook_event_name === "SubagentStop";
    // A SubagentStop transcript_path is the parent's rollout (or null); the
    // child's own rollout is agent_transcript_path. Select first, then
    // validate, and never read the parent's rollout for a child.
    const transcript_path = isSubagentStop ? input.agent_transcript_path : input.transcript_path;
    if (
      !session_id
      || !cwd
      || typeof transcript_path !== "string"
      || !transcript_path
      || (isSubagentStop && !scope.isSubagent)
    ) {
      return { exitCode: 0, stdout: "" };
    }
    const clientName = normalizeTranscriptClient(input.client ?? process.env.LCM_CLIENT);

    const retry = deps?.admissionRetry ?? NO_HOOK_ADMISSION_RETRY;
    const safeSessionId = session_id.replace(/[^a-zA-Z0-9_-]/g, "_");
    // Bootstrap/install owns root creation. Authenticate the established root
    // before creating the cursor directory so a missing or unsafe root cannot
    // be created as a hook side effect.
    assertHookRootEstablished();
    const cursorDir = lcmTmpDir();
    mkdirSync(cursorDir, { recursive: true, mode: 0o700 });
    const cursorPath = join(cursorDir, `snap-${safeSessionId}.json`);
    const _statSync = deps?.statSync ?? defaultStatSync;
    let intervalSec = deps?.snapshotIntervalSec;
    if (intervalSec === undefined) {
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { homedir } = await import("node:os");
      const config = await retry(() => loadDaemonConfig(defaultConfigPath()));
      intervalSec = config.hooks?.snapshotIntervalSec ?? 60;
    }
    const forceSnapshot = input.hook_event_name === "PreCompact" || isSubagentStop;

    // Throttle: stat cursor mtime, skip if within interval. PreCompact is a
    // boundary event, so force a final ingest attempt before Codex compacts.
    let stat: { mtimeMs: number } | null = null;
    try {
      stat = _statSync(cursorPath);
    } catch {
      // No cursor file — treat as expired
    }
    if (!forceSnapshot && stat && (Date.now() - stat.mtimeMs) < intervalSec * 1000) {
      return { exitCode: 0, stdout: "" };
    }

    // POST to /ingest — daemon handles delta via storedCount
    let ingestResult: { totalTokens?: number } | undefined;
    let peerBudget: HookPeerBudget | undefined;
    const _post = deps?.post;
    if (_post) {
      await retry(() => assertHookPublicationFence());
      ingestResult = await _post("/ingest", { session_id, cwd, transcript_path, client: clientName }) as { totalTokens?: number };
    } else {
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { readFileSync: _readFileSync } = await import("node:fs");
      const config = await retry(() => loadDaemonConfig(defaultConfigPath()));
      const port = deps?.verifiedPort ?? normalizeDaemonPort(config.daemon?.port ?? 3737);
      const deadline = performance.now() + 5_000;
      await retry(() => assertHookPublicationFence());
      const admitPeer = (): DaemonPeerAdmission | null => deps?._admitPeerForTesting === undefined
        ? admitDaemonPeer({ port, deadline })
        : deps._admitPeerForTesting(port, deadline);
      if (admitPeer() === null || performance.now() >= deadline) return { exitCode: 0, stdout: "" };
      // The publication fence may wait after the first process proof. Recheck
      // both boundaries so a changed selection or listener cannot use it.
      await retry(() => assertHookPublicationFence());
      if (admitPeer() === null || performance.now() >= deadline) return { exitCode: 0, stdout: "" };
      peerBudget = { deadline, admitPeerForTesting: deps?._admitPeerForTesting };

      // Read token from token file if available (silent fallback if not found)
      let token: string | null = null;
      try {
        const tokenPath = daemonTokenPath();
        const raw = _readFileSync(tokenPath, "utf-8").trim();
        token = raw || null;
      } catch {
        // Token file not found — auth not yet set up, proceed without it
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      assertHookPublicationFence();
      if (performance.now() >= deadline) return { exitCode: 0, stdout: "" };

      ingestResult = await daemonJsonRequest<{ totalTokens?: number }>(port, "/ingest", {
        method: "POST",
        headers,
        body: { session_id, cwd, transcript_path, client: clientName },
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
      });
    }

    if (!_post && clientName === "codex" && typeof ingestResult?.totalTokens === "number") {
      try {
        const { loadDaemonConfig } = await import("../daemon/config.js");
        const config = loadDaemonConfig(defaultConfigPath());
        const disableCompact = config.hooks?.disableAutoCompact ?? false;
        const minTokens = config.compaction.autoCompactMinTokens;
        if (!disableCompact && ingestResult.totalTokens >= minTokens) {
          const { fireCompactRequest } = await import("./session-end.js");
          fireCompactRequest(deps?.verifiedPort ?? normalizeDaemonPort(config.daemon?.port ?? 3737), {
            session_id,
            cwd,
            skip_ingest: true,
            client: "codex",
          }, peerBudget);
        }
      } catch (error) {
        if (isBackendPublicationJournalError(error)) throw error;
        // Best-effort only
      }
    }

    // Touch cursor file for normal snapshots only. PreCompact is forced and
    // must not refresh the throttle cursor used by regular Stop snapshots.
    if (!forceSnapshot) {
      const _writeFileSync = deps?.writeFileSync ?? writeFileSync;
      _writeFileSync(cursorPath, JSON.stringify({ ts: Date.now() }));
      try { chmodSync(cursorPath, 0o600); } catch { /* non-fatal */ }
    }

    // Best-effort promote-events flush
    try {
      const { loadDaemonConfig: _loadConfig } = await import("../daemon/config.js");
      const _config = _loadConfig(defaultConfigPath());
      const port = deps?.verifiedPort ?? normalizeDaemonPort(_config.daemon?.port ?? 3737);
      const { firePromoteEventsRequest } = await import("./session-end.js");
      firePromoteEventsRequest(port, { cwd: input.cwd }, peerBudget);
    } catch (error) {
      if (isBackendPublicationJournalError(error)) throw error;
      // Best-effort only
    }

    return { exitCode: 0, stdout: "" };
  } catch (error) {
    if (isBackendPublicationJournalError(error)) throw error;
    return { exitCode: 0, stdout: "" };
  }
}
