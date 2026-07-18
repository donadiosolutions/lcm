import { projectDbPath, ensureProjectDir } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { validateCwd } from "../validate-cwd.js";
import { closeLcmConnection, getLcmConnection } from "../../db/connection.js";

export function createSessionCompleteHandler(): RouteHandler {
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
    ensureProjectDir(cwd);
    const dbPath = projectDbPath(cwd);
    let db: ReturnType<typeof getLcmConnection> | undefined;
    try {
      db = getLcmConnection(dbPath);
      runLcmMigrations(db);
      const stored = db.prepare(
        `SELECT COUNT(m.message_id) AS message_count
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.conversation_id
         WHERE c.session_id = ?`,
      ).get(session_id) as { message_count: number } | undefined;
      db.prepare(
        "INSERT INTO session_ingest_log (session_id, message_count) VALUES (?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET message_count = excluded.message_count",
      ).run(session_id, stored?.message_count ?? 0);
      sendJson(res, 200, { recorded: true });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "session completion failed" });
    } finally {
      if (db) closeLcmConnection(dbPath);
    }
  };
}
