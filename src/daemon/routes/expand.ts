import type { DaemonConfig } from "../config.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { createRetrievalEngine } from "../../retrieval.js";
import { ExpansionOrchestrator } from "../../expansion.js";
import { validateCwd } from "../validate-cwd.js";
import type { StorageBackendFactory } from "../../storage/index.js";
import {
  storageRouteFailureResponse,
  withProjectStorage,
} from "./storage-lifecycle.js";

export function createExpandHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body, context) => {
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

    try {
      const result = await withProjectStorage(
        { config, cwd, factory: storageFactory, context, mode: "existing" },
        async (project) => new ExpansionOrchestrator(createRetrievalEngine(project))
          .expand({ summaryIds: [nodeId], maxDepth: depth }),
      );
      sendJson(res, 200, result ?? { expanded: null, error: "project not found" });
    } catch (err) {
      const storageFailure = storageRouteFailureResponse(config.storage.backend, err, "expand", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 200, { expanded: null, error: err instanceof Error ? err.message : "expansion failed" });
    }
  };
}
