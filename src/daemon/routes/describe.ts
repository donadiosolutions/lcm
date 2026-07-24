import type { DaemonConfig } from "../config.js";
import { projectIdentity } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { createRetrievalEngine } from "../../retrieval.js";
import { validateCwd } from "../validate-cwd.js";
import { createStorageBackendFactory, type ProjectStorage, type StorageBackendFactory } from "../../storage/index.js";
import {
  closeRouteStorage,
  openExistingProject,
  stagedPostgreSqlUnavailableResponse,
} from "./storage-lifecycle.js";

export function createDescribeHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { nodeId } = input;

    if (!nodeId) {
      sendJson(res, 400, { error: "nodeId is required" });
      return;
    }

    let cwd: string | undefined;
    if (input.cwd) {
      try {
        cwd = validateCwd(input.cwd);
      } catch {
        sendJson(res, 200, { node: null });
        return;
      }
    }

    if (!cwd) {
      sendJson(res, 200, { node: null });
      return;
    }

    let project: ProjectStorage | undefined;
    let ownedFactory: StorageBackendFactory | undefined;
    let activeFactory: StorageBackendFactory | undefined;
    try {
      const identity = projectIdentity(cwd, config.storage);
      activeFactory = storageFactory ?? (ownedFactory = createStorageBackendFactory(config.storage));
      project = await openExistingProject(activeFactory, identity) ?? undefined;
      if (!project) {
        sendJson(res, 200, { node: null });
        return;
      }
      const engine = createRetrievalEngine(project);
      const result = await engine.describe(nodeId);
      sendJson(res, 200, { node: result });
    } catch (err) {
      const unavailable = stagedPostgreSqlUnavailableResponse(activeFactory, err, "describe");
      if (unavailable) {
        sendJson(res, 503, unavailable);
        return;
      }
      sendJson(res, 200, { node: null, error: err instanceof Error ? err.message : "describe failed" });
    } finally {
      await closeRouteStorage(project, ownedFactory);
    }
  };
}
