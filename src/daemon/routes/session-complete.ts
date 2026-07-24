import type { DaemonConfig } from "../config.js";
import { projectIdentity } from "../project.js";
import { sanitizeError } from "../safe-error.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { createStorageBackendFactory, type ProjectStorage, type StorageBackendFactory } from "../../storage/index.js";
import { closeRouteStorage, storageRouteFailureResponse } from "./storage-lifecycle.js";

export function createSessionCompleteHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { session_id } = input;
    if (!session_id || !input.cwd) {
      sendJson(res, 400, { error: "session_id and cwd required" });
      return;
    }
    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }
    let project: ProjectStorage | undefined;
    let ownedFactory: StorageBackendFactory | undefined;
    let activeFactory: StorageBackendFactory | undefined;
    try {
      const identity = projectIdentity(cwd, config.storage);
      activeFactory = storageFactory ?? (ownedFactory = createStorageBackendFactory(config.storage));
      project = await activeFactory.openProject(identity);
      await project.transaction(async (repositories) => {
        const messageCount = await repositories.conversations.getMessageCountBySessionId(session_id);
        await repositories.coordination.recordSessionIngest(session_id, messageCount);
      });
      sendJson(res, 200, { recorded: true });
    } catch (err) {
      const storageFailure = storageRouteFailureResponse(
        activeFactory,
        err,
        "session-complete",
      );
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, {
        error: sanitizeError(err instanceof Error ? err.message : "session completion failed"),
      });
    } finally {
      await closeRouteStorage(project, ownedFactory);
    }
  };
}
