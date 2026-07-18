import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openSync, closeSync, writeFileSync } from "node:fs";
import { daemonPidPath, tmpDir } from "../runtime-paths.js";
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

/** Returns true if lock was acquired, false if another live process holds it. */
export function tryAcquireSessionLockForTesting(
  sessionId: string,
  deps: SessionLockDeps = defaultSessionLockDeps,
): boolean {
  const lockDir = tmpDir();
  ensurePrivateDirectory(lockDir);
  const lockPath = sessionLockPath(sessionId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = deps.open(lockPath, "wx", PRIVATE_FILE_MODE);
      try {
        deps.write(fd, process.pid.toString(), "utf-8");
      } finally {
        deps.close(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      // Lock exists — check if the owner process is still alive.
      try {
        const ownerPid = parseInt(deps.read(lockPath, {
          allowedRoot: lockDir,
          maxBytes: 32,
        }).trim(), 10);
        if (isNaN(ownerPid)) return false;
        if (deps.isProcessAlive(ownerPid)) return false; // owner alive, genuine dedup
        // Owner dead — remove only a regular file, then retry once with wx.
        deps.delete(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

export const sessionLockPathForTesting = sessionLockPath;

export async function handleSessionStart(stdin: string, client: DaemonClient, port?: number): Promise<{ exitCode: number; stdout: string }> {
  const input = JSON.parse(stdin || "{}");
  const sessionId = input.session_id ?? "";
  if (sessionId && !tryAcquireSessionLockForTesting(sessionId)) {
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
      stdout += `\n<learned-insights source="passive-capture">\nRecent learnings from your previous sessions:\n${insightsBlock}\n</learned-insights>`;
    }

    return { exitCode: 0, stdout };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
