import { describe, expect, it, vi } from "vitest";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import type {
  LocalHookEventRow,
  LocalHookOutboxRepository,
} from "../../src/storage/local-hook-outbox.js";
import {
  PostgreSqlPassiveEventRepository,
  type PostgreSqlPassiveEventRepositoryExecutor,
} from "../../src/storage/postgresql/passive-event-repository.js";
import type {
  PostgreSqlFencedLease,
} from "../../src/storage/postgresql/coordination.js";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlTransactionScopeExecutor,
} from "../../src/storage/postgresql/contracts.js";
import { PassiveEventReplicationWorker } from "../../src/daemon/passive-event-replication.js";

// #1693: a pending hook event retained across a cutover exists twice. The
// migration copy wrote the inbox row in the portable form (ISO createdAt, no
// previousEventId); replication builds its upload from the local SQLite row
// (SQLite createdAt, previousEventId always present). The real repository
// runs over an in-memory inbox so its idempotent insert, readback and
// comparison are exercised by the daemon replication pass.

const PROJECT_ID = "0195d250-0000-7000-8000-000000000001";
const MACHINE_ID = "0195d250-0000-7000-8000-000000000002";
const MIGRATED_EVENT_ID = "12345678-1234-4abc-8def-123456789abc";
const FRESH_EVENT_ID = "87654321-4321-5abc-8def-123456789abc";
const SQLITE_CREATED_AT = "2026-10-24 10:24:01";
const MIGRATED_CREATED_AT = "2026-10-24T10:24:01.000000Z";

function localRow(overrides: Partial<LocalHookEventRow> = {}): LocalHookEventRow {
  return {
    event_id: 1,
    event_uuid: MIGRATED_EVENT_ID,
    event_version: 1,
    machine_id: MACHINE_ID,
    machine_sequence: "0000000000000000007",
    session_id: "session",
    seq: 1,
    type: "choice",
    category: "decision",
    data: "SQLite",
    priority: 1,
    source_hook: "PostToolUse",
    prev_event_id: null,
    processed_at: null,
    created_at: SQLITE_CREATED_AT,
    delivery_state: "claimed",
    delivery_generation: 0,
    delivery_attempts: 1,
    delivery_owner: null,
    delivery_claimed_at: null,
    delivery_next_attempt_at: SQLITE_CREATED_AT,
    delivery_last_error: null,
    remote_inbox_id: null,
    quarantine_reason: null,
    acknowledged_at: null,
    remote_pruned_at: null,
    delivery_updated_at: SQLITE_CREATED_AT,
    ...overrides,
  };
}

function freshRow(): LocalHookEventRow {
  return localRow({
    event_id: 2,
    event_uuid: FRESH_EVENT_ID,
    machine_sequence: "0000000000000000008",
    seq: 2,
    data: "fresh",
    created_at: "2026-10-24 10:30:00",
  });
}

/** The inbox row exactly as the migration copy writes it. */
function migratedInboxRow(
  row: LocalHookEventRow,
  overrides: Record<string, unknown> = {},
): QueryResultRow {
  return {
    inbox_id: "41",
    project_id: PROJECT_ID,
    machine_id: MACHINE_ID,
    event_id: row.event_uuid,
    event_version: row.event_version,
    machine_sequence: String(BigInt(row.machine_sequence)),
    event_type: row.type,
    payload: {
      sessionId: row.session_id,
      sessionSequence: row.seq,
      category: row.category,
      data: row.data,
      priority: row.priority,
      sourceHook: row.source_hook,
      createdAt: MIGRATED_CREATED_AT,
    },
    status: "pending",
    attempt_count: 0,
    received_at: "2026-10-24T10:24:01.000Z",
    next_attempt_at: "2026-10-24T10:24:01.000Z",
    claimed_at: null,
    claimed_by: null,
    applied_at: null,
    quarantined_at: null,
    quarantine_reason: null,
    ...overrides,
  };
}

function queryResult(rows: QueryResultRow[], rowCount = rows.length): QueryResult<QueryResultRow> {
  return { command: "", rowCount, oid: 0, fields: [], rows };
}

/** An in-memory inbox honoring ON CONFLICT DO NOTHING and ordered readback. */
function inbox(seed: QueryResultRow[]): {
  readonly executor: PostgreSqlPassiveEventRepositoryExecutor;
  readonly rows: Map<string, QueryResultRow>;
} {
  const rows = new Map(seed.map((row) => [String(row.event_id), row]));
  let nextInboxId = 100;
  const query = vi.fn(async (config: QueryConfig<unknown[]>) => {
    if (config.text.includes("INSERT INTO lcm.passive_event_inbox")) {
      const values = config.values as string[];
      if (rows.has(values[2])) return queryResult([], 0);
      rows.set(values[2], {
        ...migratedInboxRow(localRow()),
        inbox_id: String(nextInboxId++),
        machine_id: values[1],
        event_id: values[2],
        event_version: values[3],
        machine_sequence: values[4],
        event_type: values[5],
        payload: JSON.parse(values[6]),
      });
      return queryResult([], 1);
    }
    if (config.text.includes("WITH ORDINALITY")) {
      const ids = (config.values as unknown[])[2] as string[];
      return queryResult(ids.flatMap((id) => rows.get(id) ?? []));
    }
    return queryResult([]);
  });
  const scope = {
    transactionScope: "active" as const,
    query,
    savepoint: vi.fn(async (
      callback: (executor: PostgreSqlQueryExecutor) => Promise<unknown>,
    ) => callback(scope)),
  };
  const transaction = vi.fn(async (
    callback: (executor: PostgreSqlTransactionScopeExecutor) => Promise<unknown>,
  ) => callback(scope));
  return {
    executor: { query, transaction } as unknown as PostgreSqlPassiveEventRepositoryExecutor,
    rows,
  };
}

function lease(): PostgreSqlFencedLease {
  return {
    projectId: PROJECT_ID,
    machineId: MACHINE_ID,
    resourceType: "passive-events",
    resourceKey: MACHINE_ID,
    processId: "worker",
    operation: "replicate",
    fencingToken: 7n,
    acquiredAt: "2026-10-24T10:30:00.000Z",
    renewedAt: "2026-10-24T10:30:00.000Z",
    expiresAt: "2026-10-24T10:31:00.000Z",
    releasedAt: null,
  };
}

function harness(
  seed: QueryResultRow[],
  claimed: LocalHookEventRow[],
  awaiting: LocalHookEventRow[] = [],
) {
  const store = inbox(seed);
  const remote = new PostgreSqlPassiveEventRepository(store.executor, PROJECT_ID, MACHINE_ID);
  // Lease and claim traffic is coordination, not event comparison.
  vi.spyOn(remote, "acquireDrainLease").mockResolvedValue(lease());
  vi.spyOn(remote, "renewDrainLease").mockResolvedValue(lease());
  vi.spyOn(remote, "releaseDrainLease").mockResolvedValue(lease());
  vi.spyOn(remote, "claimEvents").mockResolvedValue([]);
  const local = {
    claimDeliveries: vi.fn().mockResolvedValue(claimed),
    markReplicated: vi.fn().mockResolvedValue(true),
    markDeliveryRetry: vi.fn().mockResolvedValue(true),
    markDeliveryQuarantined: vi.fn().mockResolvedValue(true),
    listAwaitingRemote: vi.fn().mockResolvedValue(awaiting),
    markAcknowledged: vi.fn().mockResolvedValue(true),
    markQuarantined: vi.fn().mockResolvedValue(true),
    requeueReplicated: vi.fn().mockResolvedValue(true),
    listAcknowledgedForRemotePrune: vi.fn().mockResolvedValue([]),
    markRemotePruned: vi.fn().mockResolvedValue(true),
  } as unknown as LocalHookOutboxRepository & Record<string, ReturnType<typeof vi.fn>>;
  const errors: unknown[] = [];
  const worker = new PassiveEventReplicationWorker({
    local,
    remote,
    applyEvent: vi.fn(async () => undefined),
    now: () => Date.parse("2026-10-24T10:30:00.000Z"),
    random: () => 0.5,
    onError: (error) => { errors.push(error); },
  }, { processId: "worker", retryBaseMs: 1, retryMaxMs: 10, batchSize: 10 });
  return { store, remote, local, worker, errors };
}

describe("a pending event retained across a cutover (#1693)", () => {
  it.each([
    ["without a previous event id", null],
    ["with a previous event id", 5],
  ])("is delivered once by the first replication pass %s", async (_label, previous) => {
    const migrated = localRow({ prev_event_id: previous });
    const fresh = freshRow();
    const { store, local, worker } = harness([migratedInboxRow(migrated)], [migrated, fresh]);

    const result = await worker.runOnce();

    expect(result).toMatchObject({ uploaded: 2, retried: 0, quarantined: 0 });
    expect(local.markDeliveryRetry).not.toHaveBeenCalled();
    expect(local.markReplicated).toHaveBeenCalledTimes(2);
    expect(local.markReplicated).toHaveBeenCalledWith(MIGRATED_EVENT_ID, "worker:local", 41n);
    expect(local.markReplicated).toHaveBeenCalledWith(FRESH_EVENT_ID, "worker:local", 100n);
    // Exactly once: the migrated inbox row is kept as copied, and the fresh
    // event is the only row the pass added.
    expect([...store.rows.keys()]).toEqual([MIGRATED_EVENT_ID, FRESH_EVENT_ID]);
    expect(store.rows.get(MIGRATED_EVENT_ID)?.payload).toEqual(
      migratedInboxRow(migrated).payload,
    );
  });

  it("acknowledges the local row once the migrated inbox row is applied", async () => {
    const migrated = localRow({ prev_event_id: 5, delivery_state: "replicated", remote_inbox_id: "41" });
    const applied = migratedInboxRow(migrated, {
      status: "applied",
      applied_at: "2026-10-24T10:31:00.000Z",
    });
    const { local, worker } = harness([applied], [], [migrated]);

    const result = await worker.runOnce();

    expect(result.acknowledged).toBe(1);
    expect(local.markAcknowledged).toHaveBeenCalledWith(MIGRATED_EVENT_ID, 41n);
  });

  it("still collides when both sides carry a different previous event id", async () => {
    const migrated = localRow({ prev_event_id: 5 });
    const stored = migratedInboxRow(migrated);
    (stored.payload as Record<string, unknown>).previousEventId = 3;
    const { local, worker } = harness([stored], [migrated]);

    const result = await worker.runOnce();

    expect(result).toMatchObject({ uploaded: 0, retried: 1 });
    expect(local.markReplicated).not.toHaveBeenCalled();
  });

  it.each([
    ["data", { data: "different" }],
    ["instant", { created_at: "2026-10-24 10:24:02" }],
    ["category", { category: "other" }],
  ])("still collides when the %s differs", async (_label, override) => {
    const migrated = localRow(override);
    const stored = migratedInboxRow(localRow());
    const { local, worker } = harness([stored], [migrated]);

    const result = await worker.runOnce();

    expect(result).toMatchObject({ uploaded: 0, retried: 1 });
    expect(local.markReplicated).not.toHaveBeenCalled();
    expect(local.markDeliveryRetry).toHaveBeenCalledOnce();
  });
});
