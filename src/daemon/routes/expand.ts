import type { DaemonConfig } from "../config.js";
import { projectIdentity } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { createRetrievalEngine } from "../../retrieval.js";
import { ExpansionOrchestrator } from "../../expansion.js";
import { validateCwd } from "../validate-cwd.js";
import { createStorageBackendFactory, type ProjectStorage, type StorageBackendFactory } from "../../storage/index.js";
import { closeRouteStorage, openExistingProject } from "./storage-lifecycle.js";

export function createExpandHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { nodeId, depth = 1 } = input;

    if (!nodeId) {
      sendJson(res, 400, { error: "nodeId is required" });
      return;
    }

    let cwd: string | undefined;
    if (input.cwd) {
      try {
        cwd = validateCwd(input.cwd);
      } catch {
        sendJson(res, 200, { expanded: null, error: "project not found" });
        return;
      }
    }

    if (!cwd) {
      sendJson(res, 200, { expanded: null, error: "project not found" });
      return;
    }

    let project: ProjectStorage | undefined;
    let ownedFactory: StorageBackendFactory | undefined;
    try {
      const identity = projectIdentity(cwd, config.storage);
      const factory = storageFactory ?? (ownedFactory = createStorageBackendFactory(config.storage));
      project = await openExistingProject(factory, identity) ?? undefined;
      if (!project) {
        sendJson(res, 200, { expanded: null, error: "project not found" });
        return;
      }
      const retrieval = createRetrievalEngine(project);
      const orchestrator = new ExpansionOrchestrator(retrieval);
      const result = await orchestrator.expand({ summaryIds: [nodeId], maxDepth: depth });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, { expanded: null, error: err instanceof Error ? err.message : "expansion failed" });
    } finally {
      await closeRouteStorage(project, ownedFactory);
    }
  };
}
