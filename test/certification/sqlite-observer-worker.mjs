import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(workerData.databasePath, { readOnly: true, timeout: 0 });
try {
  const fields = "event_uuid, machine_sequence, session_id, type, source_hook, data, delivery_state, remote_inbox_id, acknowledged_at, remote_pruned_at";
  const rows = workerData.mode === "session"
    ? database.prepare(`SELECT ${fields} FROM events WHERE session_id = ? ORDER BY event_id`).all(workerData.sessionId)
    : workerData.mode === "acknowledgments"
      ? database.prepare(`SELECT ${fields} FROM events WHERE delivery_state IN ('replicated', 'acknowledged') ORDER BY event_id`).all()
      : database.prepare(`SELECT ${fields} FROM events ORDER BY event_id`).all();
  parentPort.postMessage({ rows });
} finally {
  database.close();
}
