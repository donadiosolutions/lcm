import { isMainThread, parentPort, workerData } from "node:worker_threads";

// Wait up to 200 ms for a transient lock, such as a hook connection closing or SQLite
// rebuilding the WAL index after the -wal/-shm siblings were removed, instead of failing
// the poll immediately. This stays inside the contract's 250 ms per-query deadline,
// which the parent still enforces by terminating this worker.
export const OBSERVER_BUSY_TIMEOUT_MS = 200;

// The observer read settings of a run: the busy timeout above plus the contract's observer
// poll interval, per-query deadline and maximum poll gap. Execution provenance records
// this object, the machine agent's observer runs on it, and the gate checks it.
export function observerReadSettings(contract) {
  const observer = contract?.oracle?.observer ?? {};
  const settings = {
    pollSeconds: observer.pollSeconds,
    busyTimeoutMs: OBSERVER_BUSY_TIMEOUT_MS,
    perQueryDeadlineMs: observer.perQueryDeadlineMs,
    maxPollGapSeconds: observer.maxPollGapSeconds,
  };
  for (const [name, value] of Object.entries(settings)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid certification observer read setting ${name}`);
  }
  if (settings.busyTimeoutMs >= settings.perQueryDeadlineMs) {
    throw new Error("certification observer busy timeout must be shorter than its per-query deadline");
  }
  return settings;
}

// Query only when started as an observer worker. Importing this module for its settings
// runs nothing else and does not load node:sqlite.
if (!isMainThread && typeof workerData?.databasePath === "string") {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(workerData.databasePath, { readOnly: true, timeout: OBSERVER_BUSY_TIMEOUT_MS });
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
}
