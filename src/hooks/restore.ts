import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openSync, closeSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { daemonPidPath, lcmHomeDir, tmpDir } from "../runtime-paths.js";
import { fenceContent } from "../daemon/content-fence.js";
import type { StorageBackendSelection } from "../storage/backend.js";
import {
  deleteRegularFile,
  assertPrivateDirectory,
  ensurePrivateDirectory,
  openPrivateDirectory,
  PRIVATE_FILE_MODE,
  readBoundedRegularFile,
  type PrivateDirectoryHandle,
  type PrivateDirectoryWitness,
} from "../security-files.js";
import {
  clearDaemonNotice,
  maybeEmitDaemonNotice,
  sanitizeDaemonRefusalReason,
} from "./daemon-notice.js";
import { isDaemonRefusalReason, type DaemonRefusalReason } from "../daemon/remediation.js";
import { LCM_RESTORATION_MARKER, readLiveCodexRestoration } from "../codex-transcript.js";
import { normalizeTranscriptClient } from "../transcript-provider.js";
import {
  assertHookPublicationFence,
  isBackendPublicationEvidenceMissing,
  isBackendPublicationJournalError,
  hookPublicationHome,
  hookPublicationBackend,
  NO_HOOK_ADMISSION_RETRY,
  withHookPublicationFenceAsync,
  type HookAdmissionRetry,
} from "./publication-fence.js";
import { withBackendPublicationAppendBarrierAsync } from "../storage/backend-publication.js";
import { resolveHookSessionScope } from "./subagent-scope.js";

function assertStableRoot(
  handle: PrivateDirectoryHandle,
  path: string,
  expected: PrivateDirectoryWitness,
): void {
  const actual = assertPrivateDirectory(handle, path);
  if (
    actual.mode !== expected.mode
    || actual.uid !== expected.uid
    || actual.gid !== expected.gid
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
  ) {
    throw new Error("private directory witness changed");
  }
}

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

function sessionLockPath(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(tmpDir(), `restore-${digest}.lock`);
}

type SessionLockDeps = {
  open: typeof openSync;
  write: typeof writeFileSync;
  close: typeof closeSync;
  read: typeof readBoundedRegularFile;
  delete: typeof deleteRegularFile;
  isProcessAlive: (pid: number) => boolean;
};

const defaultSessionLockDeps: SessionLockDeps = {
  open: openSync,
  write: writeFileSync,
  close: closeSync,
  read: readBoundedRegularFile,
  delete: deleteRegularFile,
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
};

function createLockFile(path: string, deps: SessionLockDeps): void {
  let fd: number | undefined;
  try {
    fd = deps.open(path, "wx", PRIVATE_FILE_MODE);
    deps.write(fd, process.pid.toString(), "utf-8");
    deps.close(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try { deps.close(fd); } catch { /* preserve the initialization failure */ }
      try { deps.delete(path); } catch { /* preserve the initialization failure */ }
    }
    throw error;
  }
}

/** Returns true if acquired; false when ownership or safe reclamation cannot be verified. */
function tryAcquireSessionLock(
  sessionId: string,
  deps: SessionLockDeps = defaultSessionLockDeps,
): boolean {
  const lockDir = tmpDir();
  ensurePrivateDirectory(lockDir);
  const lockPath = sessionLockPath(sessionId);
  try {
    createLockFile(lockPath, deps);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }

  const reclaimPath = `${lockPath}.reclaim`;
  try {
    createLockFile(reclaimPath, deps);
  } catch {
    return false;
  }
  try {
    const ownerPid = parseInt(deps.read(lockPath, {
      allowedRoot: lockDir,
      maxBytes: 32,
    }).trim(), 10);
    if (isNaN(ownerPid)) return false;
    if (deps.isProcessAlive(ownerPid)) return false;
    deps.delete(lockPath);
    try {
      createLockFile(lockPath, deps);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  } finally {
    try { deps.delete(reclaimPath); } catch { /* a failed cleanup safely blocks later reclaimers */ }
  }
}

export const tryAcquireSessionLockForTesting = tryAcquireSessionLock;
export const sessionLockPathForTesting = sessionLockPath;

/** Remove the lock only when it still names this process. */
function releaseSessionLock(sessionId: string): void {
  const lockPath = sessionLockPath(sessionId);
  try {
    const ownerPid = parseInt(defaultSessionLockDeps.read(lockPath, {
      allowedRoot: tmpDir(),
      maxBytes: 32,
    }).trim(), 10);
    if (ownerPid === process.pid) defaultSessionLockDeps.delete(lockPath);
  } catch {
    // A missing or unreadable lock has nothing of ours to release.
  }
}

type RestoreHookInput = Record<string, unknown> & {
  session_id?: string;
  cwd?: string;
};

const TRANSCRIPT_PROOF_SOURCES: readonly unknown[] = ["resume", "fork", "compact"];

/**
 * Codex prints a leading marker so later sessions can recognize the block in
 * their rollout. A resumed, forked or compacted session whose own rollout
 * already holds a live restoration prints nothing.
 */
function codexRestorationOutput(input: RestoreHookInput, stdout: string): string {
  if (!stdout) return "";
  if (TRANSCRIPT_PROOF_SOURCES.includes(input.source) && readLiveCodexRestoration(input.transcript_path)) {
    return "";
  }
  return `${LCM_RESTORATION_MARKER}\n${stdout}`;
}

export async function handleSessionStart(
  stdin: string,
  client: Pick<DaemonClient, "post">,
  port?: number,
  storage: StorageBackendSelection = { backend: "sqlite" },
  admissionRetry?: HookAdmissionRetry,
): Promise<{ exitCode: number; stdout: string }> {
  const parsed: unknown = JSON.parse(stdin || "{}");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { exitCode: 0, stdout: "" };
  }
  const input = parsed as RestoreHookInput;
  const scope = resolveHookSessionScope(input);
  if ((!scope.isSubagent && input.session_id != null && typeof input.session_id !== "string")
    || (input.cwd != null && typeof input.cwd !== "string")) {
    return { exitCode: 0, stdout: "" };
  }
  const daemonPort = port ?? 3737;
  const pidFilePath = daemonPidPath();
  try {
    // Pre-effect check: a live publication-lock owner is waited for briefly.
    await (admissionRetry ?? NO_HOOK_ADMISSION_RETRY)(() => assertHookPublicationFence());
  } catch (error) {
    if (isBackendPublicationEvidenceMissing(error)) {
      emitAdmissionNotice(undefined, "ambiguous");
      return { exitCode: 0, stdout: "" };
    }
    if (isBackendPublicationJournalError(error)) throw error;
    emitAdmissionNotice(undefined, "ambiguous");
    return { exitCode: 0, stdout: "" };
  }

  // A Codex subagent restores under its own thread id so the parent's and
  // siblings' restore locks, and their recorded sessions, never suppress it.
  const sessionId = scope.sessionId ?? "";
  if (sessionId && !tryAcquireSessionLock(sessionId)) {
    return { exitCode: 0, stdout: "" };
  }

  try {
    return await runSessionStart(input, scope, client, daemonPort, pidFilePath, storage, admissionRetry);
  } finally {
    if (sessionId) releaseSessionLock(sessionId);
  }
}

async function runSessionStart(
  input: RestoreHookInput,
  scope: ReturnType<typeof resolveHookSessionScope>,
  client: Pick<DaemonClient, "post">,
  daemonPort: number,
  pidFilePath: string,
  storage: StorageBackendSelection,
  admissionRetry: HookAdmissionRetry | undefined,
): Promise<{ exitCode: number; stdout: string }> {
  let ensureResult: EnsureResultWithRefusal;
  try {
    ensureResult = await ensureDaemon({
      port: daemonPort,
      pidFilePath,
      spawnTimeoutMs: 5000,
      expectedStorageBackend: storage.backend,
      enforceUserManagerParent: true,
      ...(admissionRetry === undefined ? {} : { _withPublicationAdmissionRetry: admissionRetry }),
    });
  } catch (error) {
    if (isBackendPublicationEvidenceMissing(error)) {
      emitAdmissionNotice(undefined, "ambiguous");
      return { exitCode: 0, stdout: "" };
    }
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

    // SessionStart scavenge: prune old processed events and trigger promotion for unprocessed ones.
    // Subagents skip it: it is root maintenance that the next root start
    // repeats, and concurrent children would contend on the outbox lock.
    if (!scope.isSubagent) try {
      const { SQLiteLocalHookOutboxFactory } = await import("../storage/local-hook-outbox.js");
      const { eventsDbPath } = await import("../db/events-path.js");
      const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
      const shouldPromote = await withHookPublicationFenceAsync(async (lockToken) => (
        withBackendPublicationAppendBarrierAsync(
          hookPublicationHome(),
          async () => {
            const rootPath = lcmHomeDir();
            const rootHandle = openPrivateDirectory(rootPath);
            const rootWitness = rootHandle.witness;
            const outboxFactory = new SQLiteLocalHookOutboxFactory();
            try {
              assertStableRoot(rootHandle, rootPath, rootWitness);
              const eventsDb = await outboxFactory.open(eventsDbPath(cwd), {}, lockToken);
              try {
                // #1395: only a PostgreSQL install can drain events to a
                // remote inbox, so only there must retention wait for that
                // proof. The backend comes from this fence rather than from
                // the configuration this hook loaded before it, so a
                // SessionStart overlapping a publication cannot apply the
                // permissive predicate to a state that has already moved.
                await eventsDb.pruneProcessed(7, {
                  awaitingReplication: hookPublicationBackend(lockToken) === "postgresql",
                });
                await eventsDb.pruneUnprocessed(10_000, 30);
                await eventsDb.pruneErrorLog(30);
                const unprocessed = await eventsDb.getUnprocessed(1);
                return unprocessed.length > 0;
              } finally {
                await outboxFactory.close(lockToken);
              }
            } finally {
              try {
                assertStableRoot(rootHandle, rootPath, rootWitness);
              } finally {
                rootHandle.close();
              }
            }
          },
          lockToken,
        )
      ));
      if (shouldPromote) {
        const { firePromoteEventsRequest } = await import("./session-end.js");
        firePromoteEventsRequest(daemonPort, { cwd });
      }
    } catch (error) {
      if (isBackendPublicationJournalError(error)) throw error;
      // Silent fail — scavenge is best-effort
    }

    // The client owns its network lifecycle; perform only a short admission
    // check immediately before the request and do not retain the lock over it.
    await (admissionRetry ?? NO_HOOK_ADMISSION_RETRY)(() => assertHookPublicationFence());
    const result = await client.post<{ context: string; insights?: Array<{ content: string; confidence: number; tags: string[] }> }>(
      "/restore",
      scope.isSubagent ? { ...input, session_id: scope.sessionId } : input,
    );
    let stdout = result.context || "";

    if (result.insights && result.insights.length > 0) {
      const insightsBlock = result.insights
        .map((i) => `- ${i.content} (confidence: ${i.confidence})`)
        .join("\n");
      const fenced = fenceContent(
        `Recent learnings from your previous sessions:\n${insightsBlock}`,
        "learned-insights",
      ).replace("<learned-insights>", '<learned-insights source="passive-capture">');
      stdout += `\n${fenced}`;
    }

    if (normalizeTranscriptClient(input.client ?? process.env.LCM_CLIENT) === "codex") {
      stdout = codexRestorationOutput(input, stdout);
    }
    return { exitCode: 0, stdout };
  } catch (error) {
    if (isBackendPublicationJournalError(error)) throw error;
    return { exitCode: 0, stdout: "" };
  }
}
