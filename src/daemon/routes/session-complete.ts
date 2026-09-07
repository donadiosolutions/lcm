import type { DaemonConfig } from "../config.js";
import { sanitizeError } from "../safe-error.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import type { StorageBackendFactory } from "../../storage/index.js";
import { storageRouteFailureResponse, withProjectStorage } from "./storage-lifecycle.js";

export function createSessionCompleteHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body, context) => {
    const input = JSON.parse(body || "{}");
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      sendJson(res, 400, { error: "invalid request body" });
      return;
    }
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
    try {
      await withProjectStorage(
        { config, cwd, factory: storageFactory, context, mode: "create" },
        async (project) => project.transaction(async (repositories) => {
          const messageCount = await repositories.conversations.getMessageCountBySessionId(session_id);
          await repositories.coordination.recordSessionIngest(session_id, messageCount);
        }),
      );
      sendJson(res, 200, { recorded: true });
    } catch (err) {
      const storageFailure = storageRouteFailureResponse(
        config.storage.backend,
        err,
        "session-complete",
        storageFactory,
      );
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, {
        error: sanitizeError(err instanceof Error ? err.message : "session completion failed"),
      });
    }
  };
}
