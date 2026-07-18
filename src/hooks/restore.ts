import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openSync, closeSync, writeFileSync } from "node:fs";
import { daemonPidPath, tmpDir } from "../runtime-paths.js";
import { fenceContent } from "../daemon/content-fence.js";
import {
  deleteRegularFile,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
  readBoundedRegularFile,
} from "../security-files.js";

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

type RestoreHookInput = Record<string, unknown> & {
  session_id?: string;
  cwd?: string;
};

export async function handleSessionStart(stdin: string, client: Pick<DaemonClient, "post">, port?: number): Promise<{ exitCode: number; stdout: string }> {
  const parsed: unknown = JSON.parse(stdin || "{}");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { exitCode: 0, stdout: "" };
  }
  const input = parsed as RestoreHookInput;
  if ((input.session_id != null && typeof input.session_id !== "string")
    || (input.cwd != null && typeof input.cwd !== "string")) {
    return { exitCode: 0, stdout: "" };
  }
  const sessionId = input.session_id ?? "";
  if (sessionId && !tryAcquireSessionLock(sessionId)) {
    return { exitCode: 0, stdout: "" };
  }

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

    // SessionStart scavenge: prune old processed events and trigger promotion for unprocessed ones
    try {
      const { EventsDb } = await import("./events-db.js");
      const { eventsDbPath } = await import("../db/events-path.js");
      const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
      const eventsDb = new EventsDb(eventsDbPath(cwd));
      try {
        eventsDb.pruneProcessed(7);
        eventsDb.pruneUnprocessed(10_000, 30);
        eventsDb.pruneErrorLog(30);
        const unprocessed = eventsDb.getUnprocessed(1);
        if (unprocessed.length > 0) {
          const { firePromoteEventsRequest } = await import("./session-end.js");
          firePromoteEventsRequest(daemonPort, { cwd });
        }
      } finally {
        eventsDb.close();
      }
    } catch {
      // Silent fail — scavenge is best-effort
    }

    const result = await client.post<{ context: string; insights?: Array<{ content: string; confidence: number; tags: string[] }> }>("/restore", input);
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

    return { exitCode: 0, stdout };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
