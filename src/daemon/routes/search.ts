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
  storageIdentityRequiredResponse,
} from "./storage-lifecycle.js";

export function createSearchHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { query, limit = 5, layers, tags } = input;
    const activeLayers: string[] = layers ?? ["episodic", "promoted"];
    const filterTags: string[] | undefined = Array.isArray(tags) && tags.length > 0 ? tags : undefined;

    if (!query) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }

    let cwd: string | undefined;
    if (input.cwd) {
      try {
        cwd = validateCwd(input.cwd);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
        return;
      }
    }

    let episodic: unknown[] = [];
    let promoted: unknown[] = [];

    if (cwd) {
      let project: ProjectStorage | undefined;
      let ownedFactory: StorageBackendFactory | undefined;
      let activeFactory: StorageBackendFactory | undefined;
      try {
        const identity = projectIdentity(cwd, config.storage);
        activeFactory = storageFactory ?? (ownedFactory = createStorageBackendFactory(config.storage));
        project = await openExistingProject(activeFactory, identity) ?? undefined;
        if (project) {

          // Episodic: FTS5 search across messages + summaries
          if (activeLayers.includes("episodic")) {
            try {
              const engine = createRetrievalEngine(project);
              const result = await engine.grep({ query, mode: "full_text", scope: "both" });
              const allMatches = [...result.messages, ...result.summaries];
              const episodicMatches = filterTags
                ? allMatches.filter((m) => {
                    const t = (m as Record<string, unknown>).tags;
                    return Array.isArray(t) && filterTags.every(ft => t.includes(ft));
                  })
                : allMatches;
              episodic = episodicMatches.slice(0, limit);
            } catch { /* non-fatal */ }
          }

          // Promoted: FTS5 search across promoted memories
          if (activeLayers.includes("promoted")) {
            try {
              promoted = await project.lexicalSearch.searchPromoted(query, limit, filterTags);
            } catch { /* non-fatal */ }
          }
        }
      } catch (error) {
        const identityRequired = storageIdentityRequiredResponse(error);
        if (identityRequired) {
          sendJson(res, 409, identityRequired);
          return;
        }
        const unavailable = stagedPostgreSqlUnavailableResponse(activeFactory, error, "search");
        if (unavailable) {
          sendJson(res, 503, unavailable);
          return;
        }
        // SQLite read/search failures remain non-fatal and return empty layers.
      }
      finally {
        await closeRouteStorage(project, ownedFactory);
      }
    }

    sendJson(res, 200, { episodic, promoted });
  };
}
