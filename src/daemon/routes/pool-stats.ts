import { collectStats, StatsUnavailableError } from "../../stats.js";
import { backendDiagnosticFailure } from "../../storage/diagnostics.js";
import type { StorageBackendFactory } from "../../storage/contracts.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";

export function createPoolStatsHandler(homeDir?: string, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, _body, context) => {
    try {
      const { backendDiagnostics } = await collectStats({ homeDir, storageFactory, signal: context?.signal });
      sendJson(res, 200, { backendDiagnostics });
    } catch (error) {
      sendJson(res, 200, { backendDiagnostics: error instanceof StatsUnavailableError
        ? error.diagnostics : backendDiagnosticFailure(error, storageFactory?.backend) });
    }
  };
}
