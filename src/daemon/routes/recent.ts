import type { DaemonConfig } from "../config.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import type { StorageBackendFactory } from "../../storage/index.js";
import {
  storageRouteFailureResponse,
  withProjectStorage,
} from "./storage-lifecycle.js";

function sqliteTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export function createRecentHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body, context) => {
    const input = JSON.parse(body || "{}");
    const { limit = 5 } = input;

    if (!input.cwd) {
      sendJson(res, 200, { summaries: [] });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch {
      sendJson(res, 200, { summaries: [] });
      return;
    }

    try {
      const summaries = await withProjectStorage(
        { config, cwd, factory: storageFactory, context, mode: "existing" },
        async (project) => project.summaries.listRecentSummaries(limit),
      );
      const rows = summaries?.map((summary) => ({
        summary_id: summary.summaryId,
        content: summary.content,
        depth: summary.depth,
        token_count: summary.tokenCount,
        created_at: sqliteTimestamp(summary.createdAt),
      })) ?? [];
      sendJson(res, 200, { summaries: rows });
    } catch (error) {
      const storageFailure = storageRouteFailureResponse(config.storage.backend, error, "recent", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 200, { summaries: [] });
    }
  };
}
