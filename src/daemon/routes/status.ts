import type { DaemonConfig } from "../config.js";
import { sendJson, PKG_VERSION, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { collectStats, StatsUnavailableError } from "../../stats.js";
import { backendDiagnosticFailure } from "../../storage/diagnostics.js";
import type { StorageBackendFactory } from "../../storage/contracts.js";

export function createStatusHandler(
  config: DaemonConfig,
  startTime: number,
  actualPort?: number,
  homeDir?: string,
  storageFactory?: StorageBackendFactory,
): RouteHandler {
  return async (_req, res, body, context) => {
    let input: unknown;
    try { input = JSON.parse(body || "{}"); }
    catch { sendJson(res, 400, { error: "invalid request body" }); return; }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      sendJson(res, 400, { error: "invalid request body" }); return;
    }
    const candidate = (input as Record<string, unknown>).cwd;
    if (!candidate) { sendJson(res, 400, { error: "cwd is required" }); return; }
    if (typeof candidate !== "string") { sendJson(res, 400, { error: "invalid cwd" }); return; }
    let cwd: string;
    try { cwd = validateCwd(candidate); }
    catch { sendJson(res, 400, { error: "invalid cwd" }); return; }

    const daemon = {
      version: PKG_VERSION,
      uptime: Math.max(0, Math.floor((Date.now() - startTime) / 1000)),
      port: actualPort ?? config.daemon.port,
    };
    try {
      const stats = await collectStats({ cwd, homeDir, storageFactory, signal: context?.signal });
      sendJson(res, 200, {
        daemon,
        backendDiagnostics: stats.backendDiagnostics,
        project: {
          messageCount: stats.messages,
          summaryCount: stats.summaries,
          promotedCount: stats.promotedCount,
        },
      });
    } catch (error) {
      sendJson(res, 200, {
        daemon,
        backendDiagnostics: error instanceof StatsUnavailableError
          ? error.diagnostics : backendDiagnosticFailure(error, config.storage.backend),
      });
    }
  };
}
