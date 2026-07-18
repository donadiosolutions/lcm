import { existsSync } from "node:fs";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { validateCwd } from "../validate-cwd.js";
import { closeLcmConnection, getLcmConnection } from "../../db/connection.js";

export function createRecentHandler(_config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { limit = 5 } = input;

    if (!input.cwd) {
      sendJson(res, 200, { summaries: [] });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch {
      sendJson(res, 200, { summaries: [] });
      return;
    }

    try {
      const dbPath = projectDbPath(cwd);
      if (!existsSync(dbPath)) {
        sendJson(res, 200, { summaries: [] });
        return;
      }
      try {
        const db = getLcmConnection(dbPath);
        runLcmMigrations(db);
        const rows = db.prepare(
          `SELECT s.summary_id, s.content, s.depth, s.token_count, s.created_at
           FROM summaries s
           ORDER BY s.created_at DESC LIMIT ?`
        ).all(limit) as Array<Record<string, unknown>>;
        sendJson(res, 200, { summaries: rows });
      } finally {
        closeLcmConnection(dbPath);
      }
    } catch {
      sendJson(res, 200, { summaries: [] });
    }
  };
}
