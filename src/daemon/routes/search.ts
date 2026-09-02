import type { DaemonConfig } from "../config.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { createRetrievalEngine, normalizeSearchLayers } from "../../retrieval.js";
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
    const { query, limit = 5, layers, tags } = input;
    if (!query) {
      sendJson(res, 400, { error: "query is required" });
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
                const episodicResult = await retrieval.grep({ query, mode: "full_text", scope: "both" });
                const allMatches = [...episodicResult.messages, ...episodicResult.summaries];
                const episodicMatches = filterTags
                  ? allMatches.filter((m) => {
                      const t = (m as Record<string, unknown>).tags;
                      return Array.isArray(t) && filterTags.every(ft => t.includes(ft));
                    })
                  : allMatches;
                episodic = episodicMatches.slice(0, limit);
              } catch (error) {
                if (config.storage.backend === "postgresql" && error instanceof StorageOperationError) throw error;
              }
            }

            // Promoted: FTS5 search across promoted memories
            if (activeLayers.includes("promoted")) {
              try {
                promoted = await project.lexicalSearch.searchPromoted(query, limit, filterTags);
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
