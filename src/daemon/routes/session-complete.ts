import type { DaemonConfig } from "../config.js";
import { projectIdentity } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { createStorageBackendFactory, type ProjectStorage, type StorageBackendFactory } from "../../storage/index.js";
import { closeRouteStorage } from "./storage-lifecycle.js";

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
    try {
      const factory = storageFactory ?? (ownedFactory = createStorageBackendFactory(config.storage));
      project = await factory.openProject(projectIdentity(cwd));
      await project.transaction(async (repositories) => {
        const conversation = await repositories.conversations.getConversationBySessionId(session_id);
        const messageCount = conversation
          ? await repositories.conversations.getMessageCount(conversation.conversationId)
          : 0;
        await repositories.coordination.recordSessionIngest(session_id, messageCount);
      });
      sendJson(res, 200, { recorded: true });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "session completion failed" });
    } finally {
      await closeRouteStorage(project, ownedFactory);
    }
  };
}
