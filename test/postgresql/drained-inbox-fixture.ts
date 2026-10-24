import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyReplicatedPassiveEvent } from "../../src/daemon/passive-event-replication-pass.js";
import { PassiveEventReplicationWorker } from "../../src/daemon/passive-event-replication.js";
import {
  SQLiteLocalHookOutboxFactory,
  type LocalHookOutboxRepository,
} from "../../src/storage/local-hook-outbox.js";
import { PostgreSqlPassiveEventRepository } from "../../src/storage/postgresql/passive-event-repository.js";
import type { PostgreSqlTestDatabase } from "./harness.js";

export interface DrainedInbox {
  /** The uploaded event data strings, in upload order. */
  readonly data: readonly string[];
  readonly outboxPath: string;
}

const DATA_PREFIX = "drained-";

function clearCapturedMachineIdentity(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("UPDATE events SET machine_id = NULL");
  } finally {
    database.close();
  }
}

function worker(local: LocalHookOutboxRepository, remote: PostgreSqlPassiveEventRepository): PassiveEventReplicationWorker {
  return new PassiveEventReplicationWorker({
    local,
    remote,
    // The daemon's own apply: the inbox row is the delivery artifact, so the applied transition is the whole effect.
    applyEvent: applyReplicatedPassiveEvent,
    random: () => 0.5,
  }, {
    processId: "drained-inbox",
    batchSize: 5,
    staleClaimMs: 50,
    leaseTtlMs: 1_000,
    retryBaseMs: 1,
    retryMaxMs: 10,
    retryJitterRatio: 0,
    quarantineAfterAttempts: 3,
  });
}

/**
 * Uploads real local hook events through the real replication worker with the daemon's own apply and drives it until
 * every row is applied remotely, acknowledged locally and pruned from lcm.passive_event_inbox (local remote_pruned_at
 * set): the steady state after a drain. The caller owns the machine, which must belong to the project.
 */
export async function drainIntoPrunedState(
  database: PostgreSqlTestDatabase,
  target: { readonly projectId: string; readonly machineId: string; readonly outboxPath: string; readonly count?: number },
): Promise<DrainedInbox> {
  const count = target.count ?? 3;
  const factory = new SQLiteLocalHookOutboxFactory();
  const local = await factory.open(target.outboxPath);
  const remote = new PostgreSqlPassiveEventRepository(database.runtime, target.projectId, target.machineId);
  const data: string[] = [];
  try {
    for (let index = 0; index < count; index++) {
      data.push(DATA_PREFIX + String(index));
      await local.insertEvent("drained-session", {
        type: "choice",
        category: "decision",
        data: data[index]!,
        priority: index,
      }, "PostToolUse");
    }
    clearCapturedMachineIdentity(target.outboxPath);
    const replication = worker(local, remote);
    for (let attempt = 0; attempt < 30; attempt++) {
      await replication.runOnce();
      const rows = readDeliveryRows(target.outboxPath);
      if (rows.length === count && rows.every((row) => row.delivery_state === "acknowledged" && row.remote_pruned_at !== null)) {
        return { data, outboxPath: target.outboxPath };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("passive-event replication did not reach a pruned checkpoint");
  } finally {
    await factory.close();
  }
}

export interface DeliveryRow {
  readonly data: string;
  readonly delivery_state: string;
  readonly remote_inbox_id: string | null;
  readonly acknowledged_at: string | null;
  readonly remote_pruned_at: string | null;
  readonly processed_at: string | null;
}

/** The local delivery columns of the drained rows, straight from the outbox file. */
export function readDeliveryRows(outboxPath: string): DeliveryRow[] {
  const database = new DatabaseSync(outboxPath, { readOnly: true });
  try {
    return database.prepare(
      "SELECT data, delivery_state, remote_inbox_id, acknowledged_at, remote_pruned_at, processed_at FROM events "
      + "WHERE data LIKE ? ORDER BY machine_sequence",
    ).all(DATA_PREFIX + "%") as unknown as DeliveryRow[];
  } finally {
    database.close();
  }
}

/** Forgets that one drained row was pruned locally, as if the daemon never recorded the prune. */
export function forgetLocalPrune(outboxPath: string, data: string): void {
  const database = new DatabaseSync(outboxPath);
  try {
    database.prepare("UPDATE events SET remote_pruned_at = NULL WHERE data = ?").run(data);
  } finally {
    database.close();
  }
}
