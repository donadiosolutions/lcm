import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassiveEventReplicationWorker } from "../../src/daemon/passive-event-replication.js";
import {
  SQLiteLocalHookOutboxFactory,
  type LocalHookOutboxRepository,
} from "../../src/storage/local-hook-outbox.js";
import { PostgreSqlPassiveEventRepository } from "../../src/storage/postgresql/passive-event-repository.js";
import type { PostgreSqlTestDatabase } from "./harness.js";

export interface ReplicatedInbox {
  /** Event data strings, in upload order, with the local previous-event pointer each row carried. */
  readonly events: ReadonlyArray<{ readonly data: string; readonly prevEventId: number | null }>;
  readonly outboxPath: string;
  close(): Promise<void>;
}

function worker(
  local: LocalHookOutboxRepository,
  remote: PostgreSqlPassiveEventRepository,
  quarantineAfterAttempts: number,
): PassiveEventReplicationWorker {
  return new PassiveEventReplicationWorker({
    local,
    remote,
    // The apply always fails, so every uploaded row stays resident in the remote inbox.
    applyEvent: async () => {
      throw new Error("held in the inbox");
    },
    random: () => 0.5,
  }, {
    processId: "replicated-inbox",
    batchSize: 5,
    staleClaimMs: 50,
    leaseTtlMs: 1_000,
    retryBaseMs: 60_000,
    retryMaxMs: 60_000,
    retryJitterRatio: 0,
    quarantineAfterAttempts,
  });
}

function clearCapturedMachineIdentity(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("UPDATE events SET machine_id = NULL");
  } finally {
    database.close();
  }
}

/**
 * Uploads real local hook events through the real replication worker and leaves them resident in
 * lcm.passive_event_inbox: the first (previous pointer null) quarantined, the second (pointer set)
 * in retry, the third (pointer set) pending. The caller owns the machine, which must belong to the project.
 */
export async function replicateIntoInbox(
  database: PostgreSqlTestDatabase,
  directory: string,
  target: { readonly projectId: string; readonly machineId: string; readonly outboxPath?: string },
): Promise<ReplicatedInbox> {
  const factory = new SQLiteLocalHookOutboxFactory();
  const outboxPath = target.outboxPath ?? join(directory, "outbox", "events.db");
  const local = await factory.open(outboxPath);
  const remote = new PostgreSqlPassiveEventRepository(database.runtime, target.projectId, target.machineId);
  const insert = (index: number): Promise<number> => local.insertEvent("replicated-session", {
    type: "choice",
    category: "decision",
    data: `replicated-${String(index)}`,
    priority: index,
  }, "PostToolUse");
  let ids: readonly [number, number, number];
  try {
    const first = await insert(0);
    clearCapturedMachineIdentity(outboxPath);
    await worker(local, remote, 1).runOnce();
    const second = await insert(1);
    const third = await insert(2);
    await local.setPrevEventId(second, first);
    await local.setPrevEventId(third, second);
    clearCapturedMachineIdentity(outboxPath);
    await worker(local, remote, 5).runOnce();
    ids = [first, second, third];
  } catch (error) {
    await factory.close();
    throw error;
  }
  return {
    events: [
      { data: "replicated-0", prevEventId: null },
      { data: "replicated-1", prevEventId: ids[0] },
      { data: "replicated-2", prevEventId: ids[1] },
    ],
    outboxPath,
    close: () => factory.close(),
  };
}

/** The local previous-event pointers by data, read straight from the outbox file. */
export function readOutboxPrevEventIds(outboxPath: string): ReadonlyMap<string, number | null> {
  const database = new DatabaseSync(outboxPath, { readOnly: true });
  try {
    const rows = database.prepare("SELECT data, prev_event_id FROM events ORDER BY event_id").all() as Array<{
      data: string;
      prev_event_id: number | null;
    }>;
    return new Map(rows.map((row) => [row.data, row.prev_event_id]));
  } finally {
    database.close();
  }
}
