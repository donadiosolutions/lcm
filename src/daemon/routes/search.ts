import type { DaemonConfig } from "../config.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import {
  createRetrievalEngine,
  normalizeSearchLayers,
  normalizeSearchLimit,
} from "../../retrieval.js";
import { validateCwd } from "../validate-cwd.js";
import type { StorageBackendFactory } from "../../storage/index.js";
import { StorageOperationError } from "../../storage/errors.js";
import {
  storageRouteFailureResponse,
  withProjectStorage,
} from "./storage-lifecycle.js";

export function createSearchHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body, context) => {
    const input = JSON.parse(body || "{}");
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      sendJson(res, 400, { error: "invalid request body" });
      return;
    }
    const { query, limit, layers, tags } = input;
    if (!query) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }

    const normalizedLimit = normalizeSearchLimit(limit);
    if (normalizedLimit === null) {
      sendJson(res, 400, { error: "invalid limit" });
      return;
    }

    const activeLayers = normalizeSearchLayers(layers);
    if (!activeLayers) {
      sendJson(res, 400, { error: "invalid layers" });
      return;
    }
    const filterTags: string[] | undefined = Array.isArray(tags) && tags.length > 0 ? tags : undefined;

    let cwd: string | undefined;
    if (input.cwd) {
      try {
        cwd = validateCwd(input.cwd);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
        return;
      }
    }

    if (cwd) {
      try {
        const result = await withProjectStorage(
          { config, cwd, factory: storageFactory, context, mode: "existing" },
          async (project) => {
            let episodic: unknown[] = [];
            let promoted: unknown[] = [];

            // Episodic: FTS5 search across messages + summaries
            if (activeLayers.includes("episodic")) {
              try {
                const retrieval = createRetrievalEngine(project);
                const episodicResult = await retrieval.grep({
                  query,
                  mode: "full_text",
                  scope: "both",
                  limit: Math.max(50, normalizedLimit),
                });
                const allMatches = [...episodicResult.messages, ...episodicResult.summaries];
                episodic = allMatches.slice(0, normalizedLimit);
              } catch (error) {
                if (config.storage.backend === "postgresql" && error instanceof StorageOperationError) throw error;
              }
            }

            // Promoted: FTS5 search across promoted memories
            if (activeLayers.includes("promoted")) {
              try {
                promoted = await project.lexicalSearch.searchPromoted(query, normalizedLimit, filterTags);
              } catch (error) {
                if (config.storage.backend === "postgresql" && error instanceof StorageOperationError) throw error;
              }
            }

            return { episodic, promoted };
          },
        );
        sendJson(res, 200, result ?? { episodic: [], promoted: [] });
      } catch (error) {
        const storageFailure = storageRouteFailureResponse(config.storage.backend, error, "search", storageFactory);
        if (storageFailure) {
          sendJson(res, storageFailure.status, storageFailure.body);
          return;
        }
        // SQLite read/search failures remain non-fatal and return empty layers.
        sendJson(res, 200, { episodic: [], promoted: [] });
      }
      return;
    }

    sendJson(res, 200, { episodic: [], promoted: [] });
  };
}
