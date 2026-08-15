import type { DaemonConfig } from "../config.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import type { StorageBackendFactory } from "../../storage/index.js";
import { storageRouteFailureResponse, withProjectStorage } from "./storage-lifecycle.js";

export type StaleCandidate = {
  id: string;
  content: string;
  tags: string[];
  projectId: string;
  confidence: number;
  createdAt: string;
  daysSinceCreated: number;
  surfacingCount: number;
  usageCount: number;
};

export function createReviewStaleHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body, context) => {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(body || "{}") as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    if (!input.cwd) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd as string);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    const action = input.action as string | undefined;
    const targetId = input.target_id as string | undefined;
    if (action && targetId && action !== "archive" && action !== "revive") {
      sendJson(res, 400, { error: `Unknown action: ${action}. Use "archive" or "revive".` });
      return;
    }

    try {
      const result = await withProjectStorage(
        { config, cwd, factory: storageFactory, context, mode: "existing" },
        async (project) => {
          if (action && targetId) {
            return project.transaction(async (repositories) => {
              const memory = await repositories.promotedMemory.getById(targetId);
              if (!memory) return { kind: "missing" as const, id: targetId };

              if (action === "archive") {
                await repositories.promotedMemory.archive(targetId);
                return { kind: "action" as const, action: "archived" as const, id: targetId };
              }
              await repositories.promotedMemory.revive(targetId);
              return { kind: "action" as const, action: "revived" as const, id: targetId };
            });
          }

          const staleRows = await project.promotedMemory.findStale({
            staleAfterDays: config.restoration.staleAfterDays,
            staleSurfacingWithoutUseLimit: config.restoration.staleSurfacingWithoutUseLimit,
            sourceProjectId: input.project_id as string | undefined,
          });

          const stale: StaleCandidate[] = staleRows.map((row) => ({
            id: row.id,
            content: row.content,
            tags: row.tags,
            projectId: row.projectId,
            confidence: row.confidence,
            createdAt: row.createdAt,
            daysSinceCreated: row.daysSinceCreated,
            surfacingCount: row.surfacingCount,
            usageCount: row.usageCount,
          }));
          return { kind: "list" as const, stale };
        },
      );

      if (result === null) {
        sendJson(res, 200, { stale: [], total: 0 });
        return;
      }

      if (result.kind === "missing") {
        sendJson(res, 404, { error: `Memory ${result.id} not found` });
        return;
      }
      if (result.kind === "action") {
        sendJson(res, 200, { action: result.action, id: result.id });
        return;
      }
      sendJson(res, 200, { stale: result.stale, total: result.stale.length });
    } catch (err) {
      const storageFailure = storageRouteFailureResponse(config.storage.backend, err, "review-stale", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : "review-stale failed" });
    }
  };
}
