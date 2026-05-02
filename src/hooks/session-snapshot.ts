import { statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { normalizeTranscriptClient } from "../transcript-provider.js";
import { daemonHttpUrl, normalizeDaemonPort } from "../daemon/http-url.js";

export interface SnapshotDeps {
  statSync: (path: string) => { mtimeMs: number } | null;
  writeFileSync: (path: string, data: string) => void;
  snapshotIntervalSec: number;
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>;
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
    const { session_id, cwd, transcript_path } = input;
    if (!session_id || !cwd || !transcript_path) {
      return { exitCode: 0, stdout: "" };
    }
    const clientName = normalizeTranscriptClient(input.client ?? process.env.LCM_CLIENT);

    const safeSessionId = session_id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const cursorDir = join(homedir(), ".lossless-claude", "tmp");
    mkdirSync(cursorDir, { recursive: true, mode: 0o700 });
    const cursorPath = join(cursorDir, `snap-${safeSessionId}.json`);
    const _statSync = deps?.statSync ?? defaultStatSync;
    let intervalSec = deps?.snapshotIntervalSec;
    if (intervalSec === undefined) {
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      intervalSec = config.hooks?.snapshotIntervalSec ?? 60;
    }

    // Throttle: stat cursor mtime, skip if within interval
    let stat: { mtimeMs: number } | null = null;
    try {
      stat = _statSync(cursorPath);
    } catch {
      // No cursor file — treat as expired
    }
    if (stat && (Date.now() - stat.mtimeMs) < intervalSec * 1000) {
      return { exitCode: 0, stdout: "" };
    }

    // POST to /ingest — daemon handles delta via storedCount
    let ingestResult: { totalTokens?: number } | undefined;
    const _post = deps?.post;
    if (_post) {
      ingestResult = await _post("/ingest", { session_id, cwd, transcript_path, client: clientName }) as { totalTokens?: number };
    } else {
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { readFileSync: _readFileSync } = await import("node:fs");
      const { homedir: _homedir } = await import("node:os");
      const config = loadDaemonConfig(join(_homedir(), ".lossless-claude", "config.json"));
      const port = normalizeDaemonPort(config.daemon?.port ?? 3737);

      // Read token from token file if available (silent fallback if not found)
      let token: string | null = null;
      try {
        const tokenPath = join(_homedir(), ".lossless-claude", "daemon.token");
        const raw = _readFileSync(tokenPath, "utf-8").trim();
        token = raw || null;
      } catch {
        // Token file not found — auth not yet set up, proceed without it
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const response = await fetch(daemonHttpUrl(port, "/ingest"), {
        method: "POST",
        headers,
        body: JSON.stringify({ session_id, cwd, transcript_path, client: clientName }),
        signal: AbortSignal.timeout(5000),
      });
      try {
        ingestResult = await response.json() as { totalTokens?: number };
      } catch {
        ingestResult = undefined;
      }
    }

    if (!_post && clientName === "codex" && typeof ingestResult?.totalTokens === "number") {
      try {
        const { loadDaemonConfig } = await import("../daemon/config.js");
        const { homedir: _homedir3 } = await import("node:os");
        const config = loadDaemonConfig(join(_homedir3(), ".lossless-claude", "config.json"));
        const disableCompact = config.hooks?.disableAutoCompact ?? false;
        const minTokens = config.compaction.autoCompactMinTokens;
        if (!disableCompact && ingestResult.totalTokens >= minTokens) {
          const { fireCompactRequest } = await import("./session-end.js");
          fireCompactRequest(normalizeDaemonPort(config.daemon?.port ?? 3737), {
            session_id,
            cwd,
            skip_ingest: true,
            client: "codex",
          });
        }
      } catch {
        // Best-effort only
      }
    }

    // Touch cursor file
    const _writeFileSync = deps?.writeFileSync ?? writeFileSync;
    _writeFileSync(cursorPath, JSON.stringify({ ts: Date.now() }));
    try { chmodSync(cursorPath, 0o600); } catch { /* non-fatal */ }

    // Best-effort promote-events flush
    try {
      const { loadDaemonConfig: _loadConfig } = await import("../daemon/config.js");
      const { homedir: _homedir2 } = await import("node:os");
      const _config = _loadConfig(join(_homedir2(), ".lossless-claude", "config.json"));
      const port = normalizeDaemonPort(_config.daemon?.port ?? 3737);
      const { firePromoteEventsRequest } = await import("./session-end.js");
      firePromoteEventsRequest(port, { cwd: input.cwd });
    } catch {
      // Best-effort only
    }

    return { exitCode: 0, stdout: "" };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
