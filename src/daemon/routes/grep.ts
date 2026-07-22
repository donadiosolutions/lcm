import type { DaemonConfig } from "../config.js";
import { projectIdentity } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { createRetrievalEngine } from "../../retrieval.js";
import { validateCwd } from "../validate-cwd.js";
import { createStorageBackendFactory, type ProjectStorage, type StorageBackendFactory } from "../../storage/index.js";
import { closeRouteStorage, openExistingProject } from "./storage-lifecycle.js";

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
    try {
      const factory = storageFactory ?? (ownedFactory = createStorageBackendFactory(config.storage));
      project = await openExistingProject(factory, projectIdentity(cwd)) ?? undefined;
      if (!project) {
        sendJson(res, 200, { matches: [] });
        return;
      }
      const engine = createRetrievalEngine(project);
      const result = await engine.grep({ query, mode: mode ?? "full_text", scope: scope ?? "both", since });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, { matches: [] });
    } finally {
      await closeRouteStorage(project, ownedFactory);
    }
  };
}
