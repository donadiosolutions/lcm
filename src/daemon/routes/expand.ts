import { existsSync } from "node:fs";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { RetrievalEngine } from "../../retrieval.js";
import { ExpansionOrchestrator } from "../../expansion.js";
import { validateCwd } from "../validate-cwd.js";
import { closeLcmConnection, getLcmConnection } from "../../db/connection.js";

export function createExpandHandler(_config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { nodeId, depth = 1 } = input;

    if (!nodeId) {
      sendJson(res, 400, { error: "nodeId is required" });
      return;
    }

    let cwd: string | undefined;
    if (input.cwd) {
      try {
        cwd = validateCwd(input.cwd);
      } catch {
        sendJson(res, 200, { expanded: null, error: "project not found" });
        return;
      }
    }

    if (!cwd || !existsSync(projectDbPath(cwd))) {
      sendJson(res, 200, { expanded: null, error: "project not found" });
      return;
    }

    const dbPath = projectDbPath(cwd);
    try {
      const db = getLcmConnection(dbPath);
      runLcmMigrations(db);
      const convStore = new ConversationStore(db);
      const summStore = new SummaryStore(db);
      const retrieval = new RetrievalEngine(convStore, summStore);
      const orchestrator = new ExpansionOrchestrator(retrieval);
      const result = await orchestrator.expand({ summaryIds: [nodeId], maxDepth: depth });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, { expanded: null, error: err instanceof Error ? err.message : "expansion failed" });
    } finally {
      closeLcmConnection(dbPath);
    }
  };
}
