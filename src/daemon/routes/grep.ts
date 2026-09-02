import type { DaemonConfig } from "../config.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { createRetrievalEngine, normalizeGrepMode, normalizeGrepScope } from "../../retrieval.js";
import { validateCwd } from "../validate-cwd.js";
import type { StorageBackendFactory } from "../../storage/index.js";
import {
  storageRouteFailureResponse,
  withProjectStorage,
} from "./storage-lifecycle.js";

export function createGrepHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body, context) => {
    const input = JSON.parse(body || "{}");
    const { query, scope, mode, since } = input;

    if (!query) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }

    const normalizedMode = normalizeGrepMode(mode);
    if (!normalizedMode) {
      sendJson(res, 400, { error: "invalid mode" });
      return;
    }

    const normalizedScope = normalizeGrepScope(scope);
    if (!normalizedScope) {
      sendJson(res, 400, { error: "invalid scope" });
      return;
    }

    if (!input.cwd) {
      sendJson(res, 200, { matches: [] });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch {
      sendJson(res, 200, { matches: [] });
      return;
    }

    try {
      const result = await withProjectStorage(
        { config, cwd, factory: storageFactory, context, mode: "existing" },
        async (project) => createRetrievalEngine(project).grep({
          query,
          mode: normalizedMode,
          scope: normalizedScope,
          since,
        }),
      );
      sendJson(res, 200, result ?? { matches: [] });
    } catch (error) {
      const storageFailure = storageRouteFailureResponse(config.storage.backend, error, "grep", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 200, { matches: [] });
    }
  };
}
