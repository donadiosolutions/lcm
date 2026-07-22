import type { DaemonConfig } from "../config.js";
import { projectIdentity } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { createStorageBackendFactory, type ProjectStorage, type StorageBackendFactory } from "../../storage/index.js";
import { closeRouteStorage, openExistingProject } from "./storage-lifecycle.js";

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
  return async (_req, res, body) => {
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

    let project: ProjectStorage | undefined;
    let ownedFactory: StorageBackendFactory | undefined;
    try {
      const factory = storageFactory ?? (ownedFactory = createStorageBackendFactory(config.storage));
      project = await openExistingProject(factory, projectIdentity(cwd)) ?? undefined;
      if (!project) {
        sendJson(res, 200, { stale: [], total: 0 });
        return;
      }

      // Handle archive/revive actions
      const action = input.action as string | undefined;
      const targetId = input.target_id as string | undefined;

      if (action && targetId) {
        if (action !== "archive" && action !== "revive") {
          sendJson(res, 400, { error: `Unknown action: ${action}. Use "archive" or "revive".` });
          return;
        }

        // Verify target exists before acting
        const memory = await project.promotedMemory.getById(targetId);
        if (!memory) {
          sendJson(res, 404, { error: `Memory ${targetId} not found` });
          return;
        }

        if (action === "archive") {
          await project.promotedMemory.archive(targetId);
          sendJson(res, 200, { action: "archived", id: targetId });
        } else {
          await project.promotedMemory.revive(targetId);
          sendJson(res, 200, { action: "revived", id: targetId });
        }
        return;
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

      sendJson(res, 200, { stale, total: stale.length });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "review-stale failed" });
    } finally {
      await closeRouteStorage(project, ownedFactory);
    }
  };
}
