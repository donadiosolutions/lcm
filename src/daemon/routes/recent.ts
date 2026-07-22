import type { DaemonConfig } from "../config.js";
import { projectIdentity } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { createStorageBackendFactory, type ProjectStorage, type StorageBackendFactory } from "../../storage/index.js";
import { closeRouteStorage, openExistingProject } from "./storage-lifecycle.js";

function sqliteTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export function createRecentHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body) => {
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

    let project: ProjectStorage | undefined;
    let ownedFactory: StorageBackendFactory | undefined;
    try {
      const factory = storageFactory ?? (ownedFactory = createStorageBackendFactory(config.storage));
      project = await openExistingProject(factory, projectIdentity(cwd)) ?? undefined;
      if (!project) {
        sendJson(res, 200, { summaries: [] });
        return;
      }
      const summaries = await project.summaries.listRecentSummaries(limit);
      const rows = summaries.map((summary) => ({
        summary_id: summary.summaryId,
        content: summary.content,
        depth: summary.depth,
        token_count: summary.tokenCount,
        created_at: sqliteTimestamp(summary.createdAt),
      }));
      sendJson(res, 200, { summaries: rows });
    } catch {
      sendJson(res, 200, { summaries: [] });
    } finally {
      await closeRouteStorage(project, ownedFactory);
    }
  };
}
