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

export function createGrepHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { query, scope, mode, since } = input;

    if (!query) {
      sendJson(res, 400, { error: "query is required" });
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

    let project: ProjectStorage | undefined;
    let ownedFactory: StorageBackendFactory | undefined;
    let activeFactory: StorageBackendFactory | undefined;
    try {
      const identity = projectIdentity(cwd, config.storage);
      activeFactory = storageFactory ?? (ownedFactory = await createStorageBackendFactory(config.storage));
      project = await openExistingProject(activeFactory, identity) ?? undefined;
      if (!project) {
        sendJson(res, 200, { matches: [] });
        return;
      }
      const engine = createRetrievalEngine(project);
      const result = await engine.grep({ query, mode: mode ?? "full_text", scope: scope ?? "both", since });
      sendJson(res, 200, result);
    } catch (error) {
      const identityRequired = storageIdentityRequiredResponse(error);
      if (identityRequired) {
        sendJson(res, 409, identityRequired);
        return;
      }
      const unavailable = stagedPostgreSqlUnavailableResponse(activeFactory, error, "grep");
      if (unavailable) {
        sendJson(res, 503, unavailable);
        return;
      }
      sendJson(res, 200, { matches: [] });
    } finally {
      await closeRouteStorage(project, ownedFactory);
    }
  };
}
