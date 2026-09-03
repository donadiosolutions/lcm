import type { DaemonConfig } from "../config.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { createRetrievalEngine } from "../../retrieval.js";
import { validateCwd } from "../validate-cwd.js";
import type { StorageBackendFactory } from "../../storage/index.js";
import { sanitizeError } from "../safe-error.js";
import {
  storageRouteFailureResponse,
  withProjectStorage,
} from "./storage-lifecycle.js";

export function createDescribeHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body, context) => {
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

    try {
      const result = await withProjectStorage(
        { config, cwd, factory: storageFactory, context, mode: "existing" },
        async (project) => ({ node: await createRetrievalEngine(project).describe(nodeId) }),
      );
      sendJson(res, 200, result ?? { node: null });
    } catch (err) {
      const storageFailure = storageRouteFailureResponse(config.storage.backend, err, "describe", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 200, {
        node: null,
        error: err instanceof Error ? sanitizeError(err.message) : "describe failed",
      });
    }
  };
}
