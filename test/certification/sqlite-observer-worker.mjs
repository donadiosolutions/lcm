import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

// Wait up to 200 ms for a transient lock, such as a hook connection closing or SQLite
// rebuilding the WAL index after the -wal/-shm siblings were removed, instead of failing
// the poll immediately. This stays inside the contract's 250 ms per-query deadline,
// which the parent still enforces by terminating this worker.
const BUSY_TIMEOUT_MS = 200;

const database = new DatabaseSync(workerData.databasePath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
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
