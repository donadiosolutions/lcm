import { describe, expect, it, vi } from "vitest";
import type {
  LocalHookEventRow,
  LocalHookOutboxRepository,
} from "../../src/storage/local-hook-outbox.js";
import {
  PostgreSqlPassiveEventDataError,
  type PostgreSqlPassiveEventRecord,
  type PostgreSqlPassiveEventRepository,
} from "../../src/storage/postgresql/passive-event-repository.js";
import type {
  PostgreSqlFencedLease,
  PostgreSqlPassiveEventClaim,
} from "../../src/storage/postgresql/coordination.js";
import type { PostgreSqlQueryExecutor } from "../../src/storage/postgresql/contracts.js";
import {
  PASSIVE_EVENT_REPLICATION_DEFAULTS,
  PassiveEventReplicationWorker,
  type PassiveEventReplicationDependencies,
  type PassiveEventReplicationOptions,
} from "../../src/daemon/passive-event-replication.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";

const PROJECT_ID = "0195d250-0000-7000-8000-000000000001";
const MACHINE_ID = "0195d250-0000-7000-8000-000000000002";
const EVENT_ID = "12345678-1234-4abc-8def-123456789abc";

function localRow(overrides: Partial<LocalHookEventRow> = {}): LocalHookEventRow {
  return {
    event_id: 1,
    event_uuid: EVENT_ID,
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
    created_at: "2026-07-29 12:00:00",
    delivery_state: "pending",
    delivery_generation: 0,
    delivery_attempts: 1,
    delivery_owner: null,
    delivery_claimed_at: null,
    delivery_next_attempt_at: "2026-07-29 12:00:00",
    delivery_last_error: null,
    remote_inbox_id: null,
    quarantine_reason: null,
    acknowledged_at: null,
    remote_pruned_at: null,
    delivery_updated_at: "2026-07-29 12:00:00",
    ...overrides,
  };
}

function remoteRecord(
  overrides: Partial<PostgreSqlPassiveEventRecord> = {},
): PostgreSqlPassiveEventRecord {
  return {
    inboxId: 41n,
    projectId: PROJECT_ID,
    machineId: MACHINE_ID,
    eventId: EVENT_ID,
    eventVersion: 1,
    machineSequence: 7n,
    eventType: "choice",
    payload: {
      sessionId: "session",
      sessionSequence: 1,
      category: "decision",
      data: "SQLite",
      priority: 1,
      sourceHook: "PostToolUse",
      previousEventId: null,
      createdAt: "2026-07-29 12:00:00",
    },
    status: "pending",
    attemptCount: 0,
    receivedAt: "2026-07-29T12:00:00.000Z",
    nextAttemptAt: "2026-07-29T12:00:00.000Z",
    claimedAt: null,
    claimedBy: null,
    appliedAt: null,
    quarantinedAt: null,
    quarantineReason: null,
    ...overrides,
  };
}

function claim(
  overrides: Partial<PostgreSqlPassiveEventClaim> = {},
): PostgreSqlPassiveEventClaim {
  return {
    inboxId: 41n,
    projectId: PROJECT_ID,
    machineId: MACHINE_ID,
    eventId: EVENT_ID,
    eventVersion: 1,
    machineSequence: 7n,
    eventType: "choice",
    payload: { sessionId: "session" },
    attemptCount: 1,
    receivedAt: "2026-07-29T12:00:00.000Z",
    nextAttemptAt: "2026-07-29T12:00:00.000Z",
    claimedAt: "2026-07-29T12:00:01.000Z",
    claimedBy: "worker:7",
    ...overrides,
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
    acquiredAt: "2026-07-29T12:00:00.000Z",
    renewedAt: "2026-07-29T12:00:00.000Z",
    expiresAt: "2026-07-29T12:01:00.000Z",
    releasedAt: null,
  };
}

function localRepository(
  overrides: Partial<Record<keyof LocalHookOutboxRepository, unknown>> = {},
): LocalHookOutboxRepository & Record<string, ReturnType<typeof vi.fn>> {
  return {
    insertEvent: vi.fn(),
    getUnprocessed: vi.fn().mockResolvedValue([]),
    markProcessed: vi.fn(),
    pruneProcessed: vi.fn().mockResolvedValue(0),
    setPrevEventId: vi.fn(),
    getPatternReinforcement: vi.fn(),
    logHookError: vi.fn(),
    getHealthStats: vi.fn(),
    getRecentErrors: vi.fn(),
    pruneUnprocessed: vi.fn().mockResolvedValue({ pruned: 0 }),
    pruneErrorLog: vi.fn().mockResolvedValue(0),
    claimDeliveries: vi.fn().mockResolvedValue([]),
    markReplicated: vi.fn().mockResolvedValue(true),
    requeueReplicated: vi.fn().mockResolvedValue(true),
    markDeliveryRetry: vi.fn().mockResolvedValue(true),
    markDeliveryQuarantined: vi.fn().mockResolvedValue(true),
    listAwaitingRemote: vi.fn().mockResolvedValue([]),
    listQuarantined: vi.fn().mockResolvedValue([]),
    markAcknowledged: vi.fn().mockResolvedValue(true),
    markQuarantined: vi.fn().mockResolvedValue(true),
    replayQuarantined: vi.fn().mockResolvedValue(true),
    listAcknowledgedForRemotePrune: vi.fn().mockResolvedValue([]),
    markRemotePruned: vi.fn().mockResolvedValue(true),
    getDeliveryDiagnostics: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as LocalHookOutboxRepository & Record<string, ReturnType<typeof vi.fn>>;
}

function remoteRepository(
  overrides: Record<string, unknown> = {},
): PostgreSqlPassiveEventRepository & Record<string, ReturnType<typeof vi.fn>> {
  return {
    projectId: PROJECT_ID,
    machineId: MACHINE_ID,
    acquireDrainLease: vi.fn().mockResolvedValue(lease()),
    renewDrainLease: vi.fn().mockResolvedValue(lease()),
    releaseDrainLease: vi.fn().mockResolvedValue({ ...lease(), releasedAt: "2026-07-29T12:01:00.000Z" }),
    insertEvents: vi.fn().mockResolvedValue([]),
    readEvents: vi.fn().mockResolvedValue([]),
    readEvent: vi.fn().mockResolvedValue(null),
    claimEvents: vi.fn().mockResolvedValue([]),
    completeApplied: vi.fn(),
    scheduleRetry: vi.fn(),
    quarantine: vi.fn(),
    pruneApplied: vi.fn().mockResolvedValue(0n),
    releaseFromOtherProjects: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as PostgreSqlPassiveEventRepository & Record<string, ReturnType<typeof vi.fn>>;
}

function dependencies(
  local: LocalHookOutboxRepository,
  remote: PostgreSqlPassiveEventRepository,
  overrides: Partial<PassiveEventReplicationDependencies> = {},
): PassiveEventReplicationDependencies {
  return {
    local,
    remote,
    applyEvent: vi.fn(async () => undefined),
    now: () => Date.parse("2026-07-29T12:00:00.000Z"),
    random: () => 0.5,
    ...overrides,
  };
}

function worker(
  local: LocalHookOutboxRepository,
  remote: PostgreSqlPassiveEventRepository,
  dependencyOverrides: Partial<PassiveEventReplicationDependencies> = {},
  optionOverrides: Partial<PassiveEventReplicationOptions> = {},
): PassiveEventReplicationWorker {
  return new PassiveEventReplicationWorker(
    dependencies(local, remote, dependencyOverrides),
    {
      processId: "worker",
      ...optionOverrides,
    },
  );
}

type FakeInboxStatus = "pending" | "claimed" | "retry" | "applied" | "quarantined";

interface FakeInboxRow {
  readonly machineId: string;
  readonly machineSequence: bigint;
  readonly eventVersion: number;
  status: FakeInboxStatus;
}

/**
 * An in-memory inbox honouring the claim predecessor guard: a row is claimable
 * only while pending and only when every earlier row of its machine is applied
 * or quarantined, and one fetch yields at most one row per machine, the
 * earliest. completeApplied runs the effect and terminalizes the row, so a
 * successor becomes claimable only once the predecessor has been applied.
 */
function statefulInbox(
  rows: readonly FakeInboxRow[],
  options: { readonly failApply?: (row: FakeInboxRow) => boolean } = {},
) {
  const sorted = [...rows].sort((left, right) =>
    left.machineId === right.machineId
      ? Number(left.machineSequence - right.machineSequence)
      : left.machineId.localeCompare(right.machineId));
  const find = (c: PostgreSqlPassiveEventClaim): FakeInboxRow =>
    sorted.find(row =>
      row.machineId === c.machineId && row.machineSequence === c.machineSequence)!;
  const record = (row: FakeInboxRow) => remoteRecord({
    machineId: row.machineId,
    machineSequence: row.machineSequence,
    eventId: `event-${row.machineId}-${row.machineSequence.toString()}`,
    status: row.status,
    claimedBy: row.status === "claimed" ? "worker:7" : null,
  });
  const log = {
    limits: [] as number[],
    claimed: [] as string[],
    applied: [] as string[],
    retried: [] as string[],
  };
  const key = (row: FakeInboxRow): string =>
    `${row.machineId}:${row.machineSequence.toString()}`;
  const claimEvents = vi.fn(async ({ limit }: { limit: number }) => {
    log.limits.push(limit);
    const out: PostgreSqlPassiveEventClaim[] = [];
    const seen = new Set<string>();
    for (const row of sorted) {
      if (seen.has(row.machineId)) continue;
      if (row.status === "applied" || row.status === "quarantined") continue;
      seen.add(row.machineId);
      if (row.status !== "pending" || out.length >= limit) continue;
      row.status = "claimed";
      log.claimed.push(key(row));
      out.push(claim({
        machineId: row.machineId,
        machineSequence: row.machineSequence,
        eventVersion: row.eventVersion,
        eventId: `event-${row.machineId}-${row.machineSequence.toString()}`,
        inboxId: row.machineSequence,
      }));
    }
    return out;
  });
  const completeApplied = vi.fn(async (
    input: { claim: PostgreSqlPassiveEventClaim },
    effect: (executor: PostgreSqlQueryExecutor, c: PostgreSqlPassiveEventClaim) => Promise<void>,
  ) => {
    const row = find(input.claim);
    if (options.failApply?.(row)) throw new Error("effect rejected");
    await effect({} as PostgreSqlQueryExecutor, input.claim);
    row.status = "applied";
    log.applied.push(key(row));
    return { event: record(row), result: undefined };
  });
  const quarantine = vi.fn(async (input: { claim: PostgreSqlPassiveEventClaim }) => {
    const row = find(input.claim);
    row.status = "quarantined";
    return record(row);
  });
  const scheduleRetry = vi.fn(async (input: { claim: PostgreSqlPassiveEventClaim }) => {
    const row = find(input.claim);
    row.status = "retry";
    log.retried.push(key(row));
    return record(row);
  });
  const readEvent = vi.fn(async (input: { machineId: string; eventId: string }) => {
    const row = sorted.find(candidate =>
      candidate.machineId === input.machineId
      && `event-${candidate.machineId}-${candidate.machineSequence.toString()}` === input.eventId);
    return row === undefined ? null : record(row);
  });
  return { rows: sorted, log, claimEvents, completeApplied, quarantine, scheduleRetry, readEvent };
}

function inboxRows(machineId: string, count: number, from = 1): FakeInboxRow[] {
  return Array.from({ length: count }, (_, index) => ({
    machineId,
    machineSequence: BigInt(from + index),
    eventVersion: 1,
    status: "pending" as const,
  }));
}

function inboxRemote(
  inbox: ReturnType<typeof statefulInbox>,
  overrides: Record<string, unknown> = {},
) {
  return remoteRepository({
    claimEvents: inbox.claimEvents,
    completeApplied: inbox.completeApplied,
    quarantine: inbox.quarantine,
    scheduleRetry: inbox.scheduleRetry,
    readEvent: inbox.readEvent,
    ...overrides,
  });
}

const MACHINE_A = "0195d250-0000-7000-8000-00000000000a";
const MACHINE_B = "0195d250-0000-7000-8000-00000000000b";

describe("PassiveEventReplicationWorker", () => {
  it("runs the upload, fenced apply, acknowledgement, and exact prune handoff", async () => {
    const pending = localRow({ delivery_state: "claimed", delivery_owner: "worker:local" });
    const replicated = localRow({
      delivery_state: "replicated",
      remote_inbox_id: "41",
    });
    const acknowledged = localRow({
      delivery_state: "acknowledged",
      remote_inbox_id: "41",
      acknowledged_at: "2026-07-29 12:00:02",
    });
    const local = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([pending]),
      listAwaitingRemote: vi.fn().mockResolvedValue([replicated]),
      listAcknowledgedForRemotePrune: vi.fn().mockResolvedValue([acknowledged]),
    });
    const pendingRemote = remoteRecord();
    const appliedRemote = remoteRecord({
      status: "applied",
      appliedAt: "2026-07-29T12:00:02.000Z",
    });
    const claimed = claim();
    const remote = remoteRepository({
      insertEvents: vi.fn().mockResolvedValue([pendingRemote]),
      claimEvents: vi.fn().mockResolvedValueOnce([claimed]).mockResolvedValue([]),
      completeApplied: vi.fn().mockResolvedValue({
        event: appliedRemote,
        result: undefined,
      }),
      readEvents: vi.fn().mockResolvedValue([appliedRemote]),
      pruneApplied: vi.fn().mockResolvedValue(1n),
    });
    const applyEvent = vi.fn(async () => undefined);

    await expect(worker(local, remote, { applyEvent }).runOnce()).resolves.toEqual({
      leaseAcquired: true,
      uploaded: 1,
      applied: 1,
      retried: 0,
      quarantined: 0,
      acknowledged: 1,
      pruned: 1,
      backlog: false,
    });
    expect(local.claimDeliveries).toHaveBeenCalledWith({
      machineId: MACHINE_ID,
      claimOwner: "worker:local",
      limit: 100,
      staleClaimMs: 60_000,
    });
    expect(remote.insertEvents).toHaveBeenCalledWith([
      {
        machineId: MACHINE_ID,
        eventId: EVENT_ID,
        eventVersion: 1,
        machineSequence: 7n,
        eventType: "choice",
        payload: {
          sessionId: "session",
          sessionSequence: 1,
          category: "decision",
          data: "SQLite",
          priority: 1,
          sourceHook: "PostToolUse",
          previousEventId: null,
          createdAt: "2026-07-29 12:00:00",
        },
      },
    ], undefined);
    // Pre-claim, apply-time, and the renewal before the second (empty) fetch.
    expect(remote.renewDrainLease).toHaveBeenCalledTimes(3);
    expect(remote.claimEvents).toHaveBeenCalledTimes(2);
    expect(remote.completeApplied).toHaveBeenCalledWith({
      claim: claimed,
      processId: "worker",
      fencingToken: 7n,
      signal: undefined,
    }, applyEvent);
    expect(local.markReplicated).toHaveBeenCalledWith(EVENT_ID, "worker:local", 41n);
    expect(local.markAcknowledged).toHaveBeenCalledWith(EVENT_ID, 41n);
    expect(remote.pruneApplied).toHaveBeenCalledWith([
      { inboxId: 41n, machineId: MACHINE_ID, eventId: EVENT_ID },
    ], undefined);
    expect(local.markRemotePruned).toHaveBeenCalledWith(EVENT_ID);
    expect(remote.releaseDrainLease).toHaveBeenCalledWith("worker", 7n, undefined);
  });

  it("returns without touching queues when another process owns the lease", async () => {
    const local = localRepository();
    const remote = remoteRepository({
      acquireDrainLease: vi.fn().mockResolvedValue(null),
    });
    await expect(worker(local, remote).runOnce()).resolves.toEqual({
      leaseAcquired: false,
      uploaded: 0,
      applied: 0,
      retried: 0,
      quarantined: 0,
      acknowledged: 0,
      pruned: 0,
      backlog: false,
    });
    expect(local.claimDeliveries).not.toHaveBeenCalled();
    expect(remote.releaseDrainLease).not.toHaveBeenCalled();
  });

  it("coalesces overlapping runs onto one in-flight drain", async () => {
    let releaseAcquire!: (value: PostgreSqlFencedLease) => void;
    const acquire = new Promise<PostgreSqlFencedLease>((resolve) => {
      releaseAcquire = resolve;
    });
    const local = localRepository();
    const remote = remoteRepository({
      acquireDrainLease: vi.fn().mockReturnValue(acquire),
    });
    const subject = worker(local, remote);
    const first = subject.runOnce();
    const second = subject.runOnce();
    releaseAcquire(lease());
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ leaseAcquired: true }),
      expect.objectContaining({ leaseAcquired: true }),
    ]);
    expect(remote.acquireDrainLease).toHaveBeenCalledOnce();
  });

  it("uses authoritative readback after an uncertain insert commit", async () => {
    const pending = localRow({ delivery_state: "claimed", delivery_owner: "worker:local" });
    const local = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([pending]),
    });
    const remote = remoteRepository({
      insertEvents: vi.fn().mockRejectedValue(new Error("connection lost")),
      readEvents: vi.fn().mockResolvedValue([remoteRecord()]),
    });
    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
      uploaded: 1,
      retried: 0,
    });
    expect(local.markReplicated).toHaveBeenCalledWith(EVENT_ID, "worker:local", 41n);
    expect(local.markDeliveryRetry).not.toHaveBeenCalled();
  });

  it.each([
    ["readback outage", new Error("readback unavailable"), undefined],
    ["missing readback", undefined, []],
    ["mismatched readback", undefined, [remoteRecord({ eventType: "different" })]],
  ])("retries local delivery after %s", async (_label, readError, records) => {
    const pending = localRow({ delivery_state: "claimed", delivery_owner: "worker:local" });
    const local = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([pending]),
    });
    const readEvents = readError
      ? vi.fn().mockRejectedValue(readError)
      : vi.fn().mockResolvedValue(records);
    const remote = remoteRepository({
      insertEvents: vi.fn().mockRejectedValue(new Error("insert uncertain")),
      readEvents,
    });
    await expect(worker(local, remote, {
      now: () => Date.parse("2026-07-29T12:00:00.000Z"),
      random: () => 0.5,
    }).runOnce()).resolves.toMatchObject({
      uploaded: 0,
      retried: 1,
    });
    expect(local.markDeliveryRetry).toHaveBeenCalledWith(
      EVENT_ID,
      "worker:local",
      expect.any(String),
      "2026-07-29T12:00:01.000Z",
    );
  });

  it("quarantines only the exact deterministic envelope failure at the attempt boundary", async () => {
    const poison = localRow({
      delivery_state: "claimed",
      delivery_owner: "worker:local",
      delivery_attempts: 5,
    });
    const healthy = localRow({
      event_id: 2,
      event_uuid: "87654321-4321-5abc-8def-123456789abc",
      machine_sequence: "0000000000000000008",
      delivery_state: "claimed",
      delivery_owner: "worker:local",
      delivery_attempts: 5,
    });
    const local = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([poison, healthy]),
    });
    const collision = new PostgreSqlPassiveEventDataError(
      PROJECT_ID,
      "idempotency_collision",
      poison.event_uuid,
    );
    const remote = remoteRepository({
      insertEvents: vi.fn().mockRejectedValue(collision),
      readEvents: vi.fn().mockResolvedValue([]),
    });

    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
      uploaded: 0,
      retried: 1,
      quarantined: 1,
    });
    expect(local.markDeliveryQuarantined).toHaveBeenCalledWith(
      poison.event_uuid,
      "worker:local",
      "remote envelope validation failed: idempotency_collision",
    );
    expect(local.markDeliveryRetry).toHaveBeenCalledWith(
      healthy.event_uuid,
      "worker:local",
      expect.any(String),
      expect.any(String),
    );
  });

  it("adopts already-applied and quarantined insertion readback", async () => {
    const first = localRow({
      delivery_state: "claimed",
      delivery_owner: "worker:local",
    });
    const second = localRow({
      event_id: 2,
      event_uuid: "87654321-4321-5abc-8def-123456789abc",
      machine_sequence: "0000000000000000008",
      delivery_state: "claimed",
      delivery_owner: "worker:local",
    });
    const local = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([first, second]),
    });
    const remote = remoteRepository({
      insertEvents: vi.fn().mockResolvedValue([
        remoteRecord({
          status: "applied",
          appliedAt: "2026-07-29T12:00:02.000Z",
        }),
        remoteRecord({
          inboxId: 42n,
          eventId: second.event_uuid,
          machineSequence: 8n,
          status: "quarantined",
          quarantinedAt: "2026-07-29T12:00:02.000Z",
          quarantineReason: "poison",
        }),
      ]),
    });
    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
      uploaded: 2,
      acknowledged: 1,
      quarantined: 1,
    });
    expect(local.markAcknowledged).toHaveBeenCalledWith(EVENT_ID, 41n);
    expect(local.markQuarantined).toHaveBeenCalledWith(
      second.event_uuid,
      42n,
      "poison",
    );
  });

  it("retries every missing or mismatched normal insertion response", async () => {
    const first = localRow({
      delivery_state: "claimed",
      delivery_owner: "worker:local",
    });
    const second = localRow({
      event_id: 2,
      event_uuid: "87654321-4321-5abc-8def-123456789abc",
      machine_sequence: "0000000000000000008",
      delivery_state: "claimed",
      delivery_owner: "worker:local",
    });
    const local = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([first, second]),
      markDeliveryRetry: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    });
    const remote = remoteRepository({
      insertEvents: vi.fn().mockResolvedValue([
        remoteRecord({ eventType: "mismatched" }),
      ]),
    });

    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
      uploaded: 0,
      retried: 1,
    });
    expect(local.markDeliveryRetry).toHaveBeenCalledTimes(2);
    expect(local.markReplicated).not.toHaveBeenCalled();
  });

  it("does not double-count already-terminal insertion responses", async () => {
    const first = localRow({
      delivery_state: "claimed",
      delivery_owner: "worker:local",
    });
    const second = localRow({
      event_id: 2,
      event_uuid: "87654321-4321-5abc-8def-123456789abc",
      machine_sequence: "0000000000000000008",
      delivery_state: "claimed",
      delivery_owner: "worker:local",
    });
    const local = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([first, second]),
      markAcknowledged: vi.fn().mockResolvedValue(false),
      markQuarantined: vi.fn().mockResolvedValue(false),
    });
    const remote = remoteRepository({
      insertEvents: vi.fn().mockResolvedValue([
        remoteRecord({
          status: "applied",
          appliedAt: "2026-07-29T12:00:02.000Z",
        }),
        remoteRecord({
          inboxId: 42n,
          eventId: second.event_uuid,
          machineSequence: 8n,
          status: "quarantined",
          quarantinedAt: "2026-07-29T12:00:02.000Z",
        }),
      ]),
    });

    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
      uploaded: 2,
      acknowledged: 0,
      quarantined: 0,
    });
    expect(local.markQuarantined).toHaveBeenCalledWith(
      second.event_uuid,
      42n,
      "remote event quarantined",
    );
  });

  it("quarantines an unsupported local envelope before network insertion", async () => {
    const future = localRow({
      event_version: 2,
      delivery_state: "claimed",
      delivery_owner: "worker:local",
    });
    const local = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([future]),
    });
    const remote = remoteRepository();

    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
      uploaded: 0,
      quarantined: 1,
    });
    expect(local.markDeliveryQuarantined).toHaveBeenCalledWith(
      EVENT_ID,
      "worker:local",
      "unsupported local hook event envelope version 2",
    );
    expect(remote.insertEvents).not.toHaveBeenCalled();
  });

  it("does not count a raced unsupported-local transition", async () => {
    const future = localRow({
      event_version: 2,
      delivery_state: "claimed",
      delivery_owner: "worker:local",
    });
    const local = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([future]),
      markDeliveryQuarantined: vi.fn().mockResolvedValue(false),
    });

    await expect(worker(local, remoteRepository()).runOnce()).resolves.toMatchObject({
      quarantined: 0,
    });
  });

  it("quarantines an unsupported remote claim without applying its payload", async () => {
    const future = claim({ eventVersion: 2 });
    const local = localRepository();
    const remote = remoteRepository({
      claimEvents: vi.fn().mockResolvedValueOnce([future]).mockResolvedValue([]),
      quarantine: vi.fn().mockResolvedValue(remoteRecord({
        eventVersion: 2,
        status: "quarantined",
        quarantinedAt: "2026-07-29T12:00:02.000Z",
        quarantineReason: "unsupported",
      })),
    });

    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
      applied: 0,
      quarantined: 1,
    });
    expect(remote.quarantine).toHaveBeenCalledWith({
      claim: future,
      processId: "worker",
      fencingToken: 7n,
      reason: "unsupported local hook event envelope version 2",
      signal: undefined,
    });
    expect(remote.completeApplied).not.toHaveBeenCalled();
  });

  it("resolves an uncertain unsupported-version quarantine by readback", async () => {
    const future = claim({ eventVersion: 2 });
    const local = localRepository();
    const remote = remoteRepository({
      claimEvents: vi.fn().mockResolvedValueOnce([future]).mockResolvedValue([]),
      quarantine: vi.fn().mockRejectedValue(new Error("commit response lost")),
      readEvent: vi.fn().mockResolvedValue(remoteRecord({
        eventVersion: 2,
        status: "quarantined",
        quarantinedAt: "2026-07-29T12:00:02.000Z",
        quarantineReason: "unsupported",
      })),
    });

    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
      quarantined: 1,
    });
  });

  it("reports an unproven unsupported-version quarantine", async () => {
    const onError = vi.fn();
    const future = claim({ eventVersion: 2 });
    const remote = remoteRepository({
      claimEvents: vi.fn().mockResolvedValue([future]),
      quarantine: vi.fn().mockRejectedValue(new Error("quarantine failed")),
      readEvent: vi.fn().mockResolvedValue(remoteRecord({ status: "pending" })),
    });

    await expect(worker(localRepository(), remote, { onError }).runOnce())
      .resolves.toMatchObject({ quarantined: 0 });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "quarantine failed",
    }));
  });

  it("reports a failed unsupported-version quarantine readback", async () => {
    const onError = vi.fn();
    const future = claim({ eventVersion: 2 });
    const remote = remoteRepository({
      claimEvents: vi.fn().mockResolvedValue([future]),
      quarantine: vi.fn().mockRejectedValue(new Error("quarantine failed")),
      readEvent: vi.fn().mockRejectedValue(new Error("readback failed")),
    });

    await expect(worker(localRepository(), remote, { onError }).runOnce())
      .resolves.toMatchObject({ quarantined: 0 });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "readback failed",
    }));
  });

  it("treats applied readback as proof after an uncertain apply commit", async () => {
    const local = localRepository();
    const claimed = claim();
    const remote = remoteRepository({
      claimEvents: vi.fn().mockResolvedValueOnce([claimed]).mockResolvedValue([]),
      completeApplied: vi.fn().mockRejectedValue(new Error("commit response lost")),
      readEvent: vi.fn().mockResolvedValue(remoteRecord({
        status: "applied",
        appliedAt: "2026-07-29T12:00:02.000Z",
      })),
    });
    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
      applied: 1,
      retried: 0,
    });
    expect(remote.scheduleRetry).not.toHaveBeenCalled();
  });

  it("schedules deterministic remote retries while the exact claim remains", async () => {
    const local = localRepository();
    const claimed = claim({ attemptCount: 3 });
    const remote = remoteRepository({
      claimEvents: vi.fn().mockResolvedValue([claimed]),
      completeApplied: vi.fn().mockRejectedValue(new Error("effect rejected")),
      readEvent: vi.fn().mockResolvedValue(remoteRecord({
        status: "claimed",
        claimedAt: claimed.claimedAt,
        claimedBy: claimed.claimedBy,
      })),
      scheduleRetry: vi.fn().mockResolvedValue(remoteRecord({ status: "retry" })),
    });
    await expect(worker(local, remote, { random: () => 0 }).runOnce())
      .resolves.toMatchObject({ retried: 1 });
    expect(remote.scheduleRetry).toHaveBeenCalledWith({
      claim: claimed,
      processId: "worker",
      fencingToken: 7n,
      delayMs: 3_200,
      signal: undefined,
    });
  });

  it("derives stable production jitter from the exact event and attempt", async () => {
    const delays: number[] = [];
    for (let run = 0; run < 2; run += 1) {
      const local = localRepository();
      const claimed = claim({ attemptCount: 4 });
      const remote = remoteRepository({
        claimEvents: vi.fn().mockResolvedValue([claimed]),
        completeApplied: vi.fn().mockRejectedValue(new Error("effect rejected")),
        readEvent: vi.fn().mockResolvedValue(remoteRecord({
          status: "claimed",
          claimedAt: claimed.claimedAt,
          claimedBy: claimed.claimedBy,
        })),
        scheduleRetry: vi.fn().mockImplementation(async (input) => {
          delays.push(input.delayMs);
          return remoteRecord({ status: "retry" });
        }),
      });
      const configured = dependencies(local, remote);
      await new PassiveEventReplicationWorker({
        ...configured,
        random: undefined,
      }, { processId: "worker" }).runOnce();
    }
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBe(delays[1]);
    expect(delays[0]).toBeGreaterThanOrEqual(6_400);
    expect(delays[0]).toBeLessThanOrEqual(9_600);
  });

  it("quarantines a poison event at the configured attempt boundary", async () => {
    const local = localRepository();
    const claimed = claim({ attemptCount: 2 });
    const remote = remoteRepository({
      claimEvents: vi.fn().mockResolvedValueOnce([claimed]).mockResolvedValue([]),
      completeApplied: vi.fn().mockRejectedValue(
        new Error("password=hunter2 at /Users/alice/private.txt"),
      ),
      readEvent: vi.fn().mockResolvedValue(remoteRecord({
        status: "claimed",
        claimedAt: claimed.claimedAt,
        claimedBy: claimed.claimedBy,
      })),
      quarantine: vi.fn().mockResolvedValue(remoteRecord({
        status: "quarantined",
        quarantinedAt: "2026-07-29T12:00:02.000Z",
        quarantineReason: "redacted",
      })),
    });
    await expect(worker(local, remote, {}, { quarantineAfterAttempts: 2 }).runOnce())
      .resolves.toMatchObject({ quarantined: 1 });
    const reason = remote.quarantine.mock.calls[0][0].reason as string;
    expect(reason).not.toContain("hunter2");
    expect(reason).not.toContain("/Users/alice");
  });

  it("uses a bounded generic diagnostic for a non-Error poison failure", async () => {
    const claimed = claim({ attemptCount: 2 });
    const remote = remoteRepository({
      claimEvents: vi.fn().mockResolvedValueOnce([claimed]).mockResolvedValue([]),
      completeApplied: vi.fn().mockRejectedValue("effect failed"),
      readEvent: vi.fn().mockResolvedValue(remoteRecord({
        status: "claimed",
        claimedAt: claimed.claimedAt,
        claimedBy: claimed.claimedBy,
      })),
      quarantine: vi.fn().mockResolvedValue(remoteRecord({
        status: "quarantined",
        quarantinedAt: "2026-07-29T12:00:02.000Z",
        quarantineReason: "generic",
      })),
    });

    await expect(worker(
      localRepository(),
      remote,
      {},
      { quarantineAfterAttempts: 2 },
    ).runOnce()).resolves.toMatchObject({ quarantined: 1 });
    expect(remote.quarantine.mock.calls[0][0].reason)
      .toBe("passive event application failed");
  });

  it("reconciles terminal remote states without double-counting raced local transitions", async () => {
    const applied = localRow({
      delivery_state: "replicated",
      remote_inbox_id: "41",
    });
    const quarantined = localRow({
      event_id: 2,
      event_uuid: "87654321-4321-5abc-8def-123456789abc",
      machine_sequence: "0000000000000000008",
      delivery_state: "replicated",
      remote_inbox_id: "42",
    });
    const missing = localRow({
      event_id: 3,
      event_uuid: "aaaaaaaa-4321-5abc-8def-123456789abc",
      machine_sequence: "0000000000000000009",
      delivery_state: "replicated",
      remote_inbox_id: "43",
    });
    const pending = localRow({
      event_id: 4,
      event_uuid: "bbbbbbbb-4321-5abc-8def-123456789abc",
      machine_sequence: "0000000000000000010",
      delivery_state: "replicated",
      remote_inbox_id: "44",
    });
    const local = localRepository({
      listAwaitingRemote: vi.fn().mockResolvedValue([
        applied,
        quarantined,
        missing,
        pending,
      ]),
      markAcknowledged: vi.fn().mockResolvedValue(false),
      markQuarantined: vi.fn().mockResolvedValue(false),
    });
    const remote = remoteRepository({
      readEvents: vi.fn().mockResolvedValue([
        remoteRecord({
          status: "applied",
          appliedAt: "2026-07-29T12:00:02.000Z",
        }),
        remoteRecord({
          inboxId: 42n,
          eventId: quarantined.event_uuid,
          machineSequence: 8n,
          status: "quarantined",
          quarantinedAt: "2026-07-29T12:00:02.000Z",
        }),
        remoteRecord({
          inboxId: 44n,
          eventId: pending.event_uuid,
          machineSequence: 10n,
        }),
      ]),
    });

    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
      acknowledged: 0,
      quarantined: 0,
    });
    expect(local.markQuarantined).toHaveBeenCalledWith(
      quarantined.event_uuid,
      42n,
      "remote event quarantined",
    );
  });

  it("records an authoritative quarantined state during local reconciliation", async () => {
    const quarantined = localRow({
      delivery_state: "replicated",
      remote_inbox_id: "41",
    });
    const local = localRepository({
      listAwaitingRemote: vi.fn().mockResolvedValue([quarantined]),
    });
    const remote = remoteRepository({
      readEvents: vi.fn().mockResolvedValue([remoteRecord({
        status: "quarantined",
        quarantinedAt: "2026-07-29T12:00:02.000Z",
        quarantineReason: "poison",
      })]),
    });

    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
      quarantined: 1,
    });
    expect(local.markQuarantined).toHaveBeenCalledWith(EVENT_ID, 41n, "poison");
  });

  describe("rows replicated to a previous remote project (#1509)", () => {
    const SECOND = "87654321-4321-5abc-8def-123456789abc";
    const THIRD = "aaaaaaaa-4321-5abc-8def-123456789abc";
    const FOURTH = "bbbbbbbb-4321-5abc-8def-123456789abc";
    const FIFTH = "cccccccc-4321-5abc-8def-123456789abc";

    function replicatedRow(
      eventUuid: string,
      sequence: number,
      inboxId: number,
      overrides: Partial<LocalHookEventRow> = {},
    ): LocalHookEventRow {
      return localRow({
        event_id: sequence,
        event_uuid: eventUuid,
        machine_sequence: String(sequence).padStart(19, "0"),
        delivery_state: "replicated",
        remote_inbox_id: String(inboxId),
        ...overrides,
      });
    }

    it("asks the remote about exactly this machine's rows the bound project lacks", async () => {
      const absent = replicatedRow(SECOND, 8, 42);
      const present = replicatedRow(EVENT_ID, 7, 41);
      const foreign = replicatedRow(THIRD, 9, 43, {
        machine_id: "0195d250-0000-7000-8000-0000000000aa",
      });
      const mismatched = replicatedRow(FOURTH, 10, 44);
      const local = localRepository({
        listAwaitingRemote: vi.fn().mockResolvedValue([present, absent, foreign, mismatched]),
      });
      const remote = remoteRepository({
        readEvents: vi.fn().mockResolvedValue([
          remoteRecord(),
          // The bound project holds a different envelope for this row.
          remoteRecord({
            inboxId: 44n,
            eventId: FOURTH,
            machineSequence: 10n,
            payload: { sessionId: "other" },
          }),
        ]),
      });
      const signal = new AbortController().signal;

      await worker(local, remote).runOnce(signal);

      expect(remote.releaseFromOtherProjects).toHaveBeenCalledTimes(1);
      expect(remote.releaseFromOtherProjects).toHaveBeenCalledWith([
        {
          inboxId: 42n,
          machineId: MACHINE_ID,
          eventId: SECOND,
          eventVersion: 1,
          machineSequence: 8n,
          eventType: "choice",
          payload: {
            sessionId: "session",
            sessionSequence: 1,
            category: "decision",
            data: "SQLite",
            priority: 1,
            sourceHook: "PostToolUse",
            previousEventId: null,
            createdAt: "2026-07-29 12:00:00",
          },
        },
      ], { staleClaimMs: 60_000, signal });
      expect(local.requeueReplicated).not.toHaveBeenCalled();
    });

    it("does not ask the remote when the bound project holds every awaiting row", async () => {
      const local = localRepository({
        listAwaitingRemote: vi.fn().mockResolvedValue([replicatedRow(EVENT_ID, 7, 41)]),
      });
      const remote = remoteRepository({
        readEvents: vi.fn().mockResolvedValue([remoteRecord()]),
      });
      await worker(local, remote).runOnce();
      expect(remote.releaseFromOtherProjects).not.toHaveBeenCalled();
    });

    it("maps every outcome to exactly one local transition", async () => {
      const rows = [
        replicatedRow(EVENT_ID, 7, 41),
        replicatedRow(SECOND, 8, 42),
        replicatedRow(THIRD, 9, 43),
        replicatedRow(FOURTH, 10, 44),
        replicatedRow(FIFTH, 11, 45),
      ];
      const local = localRepository({
        listAwaitingRemote: vi.fn().mockResolvedValue(rows),
      });
      const remote = remoteRepository({
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: EVENT_ID, outcome: "absent" },
          { eventId: SECOND, outcome: "released" },
          { eventId: THIRD, outcome: "applied", inboxId: 43n },
          {
            eventId: FOURTH,
            outcome: "quarantined",
            inboxId: 44n,
            quarantineReason: "poison",
          },
          { eventId: FIFTH, outcome: "busy" },
        ]),
      });

      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
        acknowledged: 1,
        quarantined: 1,
        uploaded: 0,
      });
      expect(local.requeueReplicated.mock.calls).toEqual([
        [EVENT_ID, 41n],
        [SECOND, 42n],
      ]);
      expect(local.markAcknowledged.mock.calls).toEqual([[THIRD, 43n]]);
      expect(local.markQuarantined.mock.calls).toEqual([[FOURTH, 44n, "poison"]]);
    });

    it("leaves rows alone for a live claim, a bound copy, or no answer", async () => {
      const rows = [
        replicatedRow(EVENT_ID, 7, 41),
        replicatedRow(SECOND, 8, 42),
        replicatedRow(THIRD, 9, 43),
      ];
      const local = localRepository({
        listAwaitingRemote: vi.fn().mockResolvedValue(rows),
      });
      const onError = vi.fn();
      const answers: unknown[][] = [
        [
          { eventId: EVENT_ID, outcome: "busy" },
          { eventId: SECOND, outcome: "bound" },
        ],
        [],
        // An outcome for a key nobody asked about is never acted on.
        [{ eventId: FIFTH, outcome: "released" }, {
          eventId: FIFTH,
          outcome: "applied",
          inboxId: 45n,
        }],
      ];
      for (const answer of answers) {
        const remote = remoteRepository({
          releaseFromOtherProjects: vi.fn().mockResolvedValue(answer),
        });
        await worker(local, remote, { onError }).runOnce();
      }
      expect(local.requeueReplicated).not.toHaveBeenCalled();
      expect(local.markAcknowledged).not.toHaveBeenCalled();
      expect(local.markQuarantined).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it("does not count local transitions that raced", async () => {
      const local = localRepository({
        listAwaitingRemote: vi.fn().mockResolvedValue([
          replicatedRow(EVENT_ID, 7, 41),
          replicatedRow(SECOND, 8, 42),
          replicatedRow(THIRD, 9, 43),
        ]),
        requeueReplicated: vi.fn().mockResolvedValue(false),
        markAcknowledged: vi.fn().mockResolvedValue(false),
        markQuarantined: vi.fn().mockResolvedValue(false),
      });
      const remote = remoteRepository({
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: EVENT_ID, outcome: "released" },
          { eventId: SECOND, outcome: "applied", inboxId: 42n },
          { eventId: THIRD, outcome: "quarantined", inboxId: 43n, quarantineReason: "poison" },
        ]),
      });
      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
        acknowledged: 0,
        quarantined: 0,
      });
      expect(local.requeueReplicated).toHaveBeenCalledTimes(1);
      expect(local.markAcknowledged).toHaveBeenCalledTimes(1);
      expect(local.markQuarantined).toHaveBeenCalledTimes(1);
    });

    it("reports rows that differ from their copy elsewhere once and never moves them", async () => {
      const local = localRepository({
        listAwaitingRemote: vi.fn().mockResolvedValue([
          replicatedRow(EVENT_ID, 7, 41),
          replicatedRow(SECOND, 8, 42),
          replicatedRow(THIRD, 9, 43),
        ]),
      });
      const onError = vi.fn();
      const remote = remoteRepository({
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: EVENT_ID, outcome: "mismatch" },
          { eventId: SECOND, outcome: "mismatch" },
          { eventId: THIRD, outcome: "busy" },
        ]),
      });
      await worker(local, remote, { onError }).runOnce();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining(`${EVENT_ID}, ${SECOND}`),
      }));
      expect(local.requeueReplicated).not.toHaveBeenCalled();
      expect(local.markAcknowledged).not.toHaveBeenCalled();
      expect(local.markQuarantined).not.toHaveBeenCalled();
    });

    it("reports a failed recovery and still prunes", async () => {
      const failure = new Error("recovery unavailable");
      const acknowledged = replicatedRow(SECOND, 8, 42, {
        delivery_state: "acknowledged",
        acknowledged_at: "2026-07-29 12:00:02",
      });
      const local = localRepository({
        listAwaitingRemote: vi.fn().mockResolvedValue([replicatedRow(EVENT_ID, 7, 41)]),
        listAcknowledgedForRemotePrune: vi.fn().mockResolvedValue([acknowledged]),
      });
      const onError = vi.fn();
      const remote = remoteRepository({
        releaseFromOtherProjects: vi.fn().mockRejectedValue(failure),
        pruneApplied: vi.fn().mockResolvedValue(1n),
      });
      await expect(worker(local, remote, { onError }).runOnce()).resolves.toMatchObject({
        pruned: 1,
      });
      expect(onError).toHaveBeenCalledWith(failure);
      expect(local.requeueReplicated).not.toHaveBeenCalled();
    });
  });

  describe("a pending row whose earlier upload landed in another project (#1511)", () => {
    const ID = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const THRESHOLD = PASSIVE_EVENT_REPLICATION_DEFAULTS.quarantineAfterAttempts;

    function pendingRow(n: number, overrides: Partial<LocalHookEventRow> = {}): LocalHookEventRow {
      return localRow({
        event_id: n,
        event_uuid: ID(n),
        machine_sequence: String(n).padStart(19, "0"),
        delivery_state: "claimed",
        delivery_owner: "worker:local",
        ...overrides,
      });
    }

    function copy(n: number, overrides: Partial<PostgreSqlPassiveEventRecord> = {}) {
      return remoteRecord({
        inboxId: BigInt(100 + n),
        eventId: ID(n),
        machineSequence: BigInt(n),
        ...overrides,
      });
    }

    /** The first insert rolls back; the second one succeeds for whatever it is given. */
    function insertThenSucceed(firstMissing: number) {
      return vi.fn()
        .mockRejectedValueOnce(
          new PostgreSqlPassiveEventDataError(PROJECT_ID, "idempotency_readback", ID(firstMissing)),
        )
        .mockImplementation(async (inputs: ReadonlyArray<{ machineSequence: bigint }>) =>
          inputs.map(input => copy(Number(input.machineSequence))));
    }

    const idsOf = (calls: ReadonlyArray<ReadonlyArray<unknown>>): string[] =>
      calls.map(call => call[0] as string);

    const insertedIds = (remote: { insertEvents: ReturnType<typeof vi.fn> }, call: number): string[] =>
      remote.insertEvents.mock.calls[call][0].map((input: { eventId: string }) => input.eventId);

    it("settles every outcome of one batch and uploads the rest in the same pass", async () => {
      const rows = [
        pendingRow(1),
        pendingRow(2),
        pendingRow(3),
        pendingRow(4),
        pendingRow(5),
        pendingRow(6, { delivery_attempts: THRESHOLD }),
        pendingRow(7),
        pendingRow(8, { delivery_attempts: 1 }),
        pendingRow(9, { delivery_attempts: THRESHOLD }),
        pendingRow(10),
      ];
      const local = localRepository({ claimDeliveries: vi.fn().mockResolvedValue(rows) });
      const onError = vi.fn();
      const remote = remoteRepository({
        insertEvents: insertThenSucceed(2),
        // Only row 1 is visible in the bound project.
        readEvents: vi.fn().mockResolvedValue([copy(1)]),
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: ID(2), outcome: "absent" },
          { eventId: ID(3), outcome: "released" },
          { eventId: ID(4), outcome: "applied", inboxId: 104n },
          { eventId: ID(5), outcome: "quarantined", inboxId: 105n, quarantineReason: "poison" },
          { eventId: ID(6), outcome: "busy" },
          { eventId: ID(7), outcome: "bound" },
          { eventId: ID(8), outcome: "mismatch" },
          { eventId: ID(9), outcome: "mismatch" },
        ]),
      });
      const signal = new AbortController().signal;

      await expect(worker(local, remote, { onError }).runOnce(signal)).resolves.toMatchObject({
        uploaded: 3,
        acknowledged: 1,
        quarantined: 2,
        retried: 4,
      });

      // Release is asked about exactly the rows the bound project lacks, with
      // no recorded inbox id, and every remote call carries the pass signal.
      expect(remote.releaseFromOtherProjects).toHaveBeenCalledTimes(1);
      const [keys, options] = remote.releaseFromOtherProjects.mock.calls[0];
      expect(keys.map((key: { eventId: string }) => key.eventId))
        .toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10].map(ID));
      expect(keys.every((key: object) => !("inboxId" in key))).toBe(true);
      expect(keys[0]).toEqual({
        machineId: MACHINE_ID,
        eventId: ID(2),
        eventVersion: 1,
        machineSequence: 2n,
        eventType: "choice",
        payload: {
          sessionId: "session",
          sessionSequence: 1,
          category: "decision",
          data: "SQLite",
          priority: 1,
          sourceHook: "PostToolUse",
          previousEventId: null,
          createdAt: "2026-07-29 12:00:00",
        },
      });
      expect(options).toEqual({ staleClaimMs: 60_000, signal });
      // The one extra insert holds the visible, withdrawn, and absent rows in
      // their original order and nothing else.
      expect(remote.insertEvents).toHaveBeenCalledTimes(2);
      expect(insertedIds(remote, 1)).toEqual([1, 2, 3].map(ID));
      expect(remote.insertEvents.mock.calls[0][1]).toBe(signal);
      expect(remote.insertEvents.mock.calls[1][1]).toBe(signal);
      expect(remote.readEvents).toHaveBeenCalledTimes(1);
      expect(local.markReplicated.mock.calls).toEqual([
        [ID(1), "worker:local", 101n],
        [ID(2), "worker:local", 102n],
        [ID(3), "worker:local", 103n],
      ]);
      expect(local.markAcknowledged.mock.calls).toEqual([[ID(4), 104n]]);
      expect(local.markQuarantined.mock.calls).toEqual([[ID(5), 105n, "poison"]]);
      // A live claim, a bound copy, a young mismatch, and a row nobody
      // answered for stay queued; a mismatch at the boundary is quarantined.
      expect(idsOf(local.markDeliveryRetry.mock.calls)).toEqual([6, 7, 8, 10].map(ID));
      expect(local.markDeliveryQuarantined.mock.calls).toEqual([
        [ID(9), "worker:local", "remote copy in another project differs from the local row"],
      ]);
      expect(onError).toHaveBeenCalledTimes(1);
      const reported = onError.mock.calls[0][0] as Error;
      expect(reported.message).toContain(ID(8));
      expect(reported.message).toContain(ID(9));
    });

    it("inserts only the rows that remain visible when the others are settled", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
      });
      const remote = remoteRepository({
        insertEvents: insertThenSucceed(2),
        readEvents: vi.fn().mockResolvedValue([copy(1)]),
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: ID(2), outcome: "busy" },
        ]),
      });
      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
        uploaded: 1,
        retried: 1,
      });
      expect(insertedIds(remote, 1)).toEqual([ID(1)]);
    });

    it("does not insert again when no row remains to upload", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1)]),
      });
      const remote = remoteRepository({
        insertEvents: insertThenSucceed(1),
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: ID(1), outcome: "busy" },
        ]),
      });
      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
        uploaded: 0,
        retried: 1,
      });
      expect(remote.insertEvents).toHaveBeenCalledTimes(1);
    });

    it("inserts the whole batch again when the remote proves every row absent", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
      });
      const remote = remoteRepository({
        insertEvents: insertThenSucceed(1),
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: ID(1), outcome: "absent" },
          { eventId: ID(2), outcome: "absent" },
        ]),
      });
      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
        uploaded: 2,
        retried: 0,
      });
      expect(remote.insertEvents).toHaveBeenCalledTimes(2);
      expect(insertedIds(remote, 1)).toEqual([ID(1), ID(2)]);
    });

    it("asks only about the rows the bound project lacks after a differing row", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
      });
      const remote = remoteRepository({
        insertEvents: insertThenSucceed(1),
        readEvents: vi.fn().mockResolvedValue([copy(1, { eventType: "different" })]),
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: ID(2), outcome: "absent" },
        ]),
      });
      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
        uploaded: 1,
        retried: 1,
      });
      expect(remote.releaseFromOtherProjects).toHaveBeenCalledTimes(1);
      expect(remote.releaseFromOtherProjects.mock.calls[0][0].map(
        (key: { eventId: string }) => key.eventId,
      )).toEqual([ID(2)]);
      expect(remote.insertEvents).toHaveBeenCalledTimes(2);
      expect(insertedIds(remote, 1)).toEqual([ID(2)]);
    });

    it("asks nothing of other projects after a readback outage", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
      });
      const remote = remoteRepository({
        insertEvents: vi.fn().mockRejectedValue(new Error("insert failed")),
        readEvents: vi.fn().mockRejectedValue(new Error("readback unavailable")),
      });
      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
        uploaded: 0,
        retried: 2,
      });
      expect(remote.releaseFromOtherProjects).not.toHaveBeenCalled();
      expect(remote.insertEvents).toHaveBeenCalledTimes(1);
    });

    it("asks nothing of other projects when the readback holds every row", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
      });
      const remote = remoteRepository({
        insertEvents: vi.fn().mockRejectedValue(new Error("connection lost")),
        readEvents: vi.fn().mockResolvedValue([copy(1), copy(2)]),
      });
      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({ uploaded: 2 });
      expect(remote.releaseFromOtherProjects).not.toHaveBeenCalled();
      expect(remote.insertEvents).toHaveBeenCalledTimes(1);
    });

    it("falls back to retrying the whole batch when the recovery query fails", async () => {
      const failure = new Error("release unavailable");
      const onError = vi.fn();
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
      });
      const remote = remoteRepository({
        insertEvents: insertThenSucceed(2),
        readEvents: vi.fn().mockResolvedValue([copy(1)]),
        releaseFromOtherProjects: vi.fn().mockRejectedValue(failure),
      });
      await expect(worker(local, remote, { onError }).runOnce()).resolves.toMatchObject({
        uploaded: 0,
        retried: 2,
      });
      expect(onError).toHaveBeenCalledWith(failure);
      expect(remote.insertEvents).toHaveBeenCalledTimes(1);
    });

    it("retries rather than quarantines a row at the limit when the recovery query fails", async () => {
      const failure = new Error("release unavailable");
      const onError = vi.fn();
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([
          pendingRow(1, { delivery_attempts: THRESHOLD }),
        ]),
      });
      const remote = remoteRepository({
        // The failed insert names this very row, as a quarantine-worthy error would.
        insertEvents: insertThenSucceed(1),
        readEvents: vi.fn().mockResolvedValue([]),
        releaseFromOtherProjects: vi.fn().mockRejectedValue(failure),
      });
      await expect(worker(local, remote, { onError }).runOnce()).resolves.toMatchObject({
        uploaded: 0,
        retried: 1,
        quarantined: 0,
      });
      expect(local.markDeliveryRetry).toHaveBeenCalledTimes(1);
      expect(local.markDeliveryRetry).toHaveBeenCalledWith(
        ID(1),
        expect.any(String),
        "release unavailable",
        expect.any(String),
      );
      expect(local.markDeliveryQuarantined).not.toHaveBeenCalled();
      expect(remote.insertEvents).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls.filter(([error]) => error === failure)).toHaveLength(1);
    });

    it("acts on the first answer per row and reports a repeated one once", async () => {
      const onError = vi.fn();
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
      });
      const remote = remoteRepository({
        insertEvents: insertThenSucceed(1),
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: ID(1), outcome: "released" },
          { eventId: ID(1), outcome: "busy" },
          { eventId: ID(1), outcome: "busy" },
          { eventId: ID(99), outcome: "released" },
          { eventId: ID(2), outcome: "busy" },
        ]),
      });
      await expect(worker(local, remote, { onError }).runOnce()).resolves.toMatchObject({
        uploaded: 1,
        retried: 1,
      });
      expect(insertedIds(remote, 1)).toEqual([ID(1)]);
      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0][0] as Error).message).toContain(ID(1));
    });

    it("recovers only the rows of the extra insert when it fails too", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2), pendingRow(3)]),
      });
      const remote = remoteRepository({
        insertEvents: vi.fn().mockRejectedValue(new Error("insert failed")),
        readEvents: vi.fn()
          .mockResolvedValueOnce([copy(1)])
          .mockResolvedValueOnce([copy(1)]),
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: ID(2), outcome: "released" },
          { eventId: ID(3), outcome: "busy" },
        ]),
      });
      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
        uploaded: 0,
        retried: 3,
      });
      expect(idsOf(local.markDeliveryRetry.mock.calls)).toEqual([3, 1, 2].map(ID));
      // No second recovery and no third insert.
      expect(remote.releaseFromOtherProjects).toHaveBeenCalledTimes(1);
      expect(remote.insertEvents).toHaveBeenCalledTimes(2);
      expect(remote.readEvents.mock.calls[1][0]).toEqual([
        { machineId: MACHINE_ID, eventId: ID(1) },
        { machineId: MACHINE_ID, eventId: ID(2) },
      ]);
    });

    it("adopts the readback when the extra insert committed uncertainly", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
      });
      const remote = remoteRepository({
        insertEvents: vi.fn().mockRejectedValue(new Error("insert failed")),
        readEvents: vi.fn()
          .mockResolvedValueOnce([copy(1)])
          .mockResolvedValueOnce([copy(1), copy(2)]),
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: ID(2), outcome: "released" },
        ]),
      });
      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
        uploaded: 2,
        retried: 0,
      });
      expect(local.markReplicated.mock.calls.map(call => call[0])).toEqual([ID(1), ID(2)]);
    });

    it("retries the rows of the extra insert when their readback fails", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
      });
      const remote = remoteRepository({
        insertEvents: vi.fn().mockRejectedValue(new Error("insert failed")),
        readEvents: vi.fn()
          .mockResolvedValueOnce([copy(1)])
          .mockRejectedValueOnce(new Error("readback unavailable")),
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: ID(2), outcome: "released" },
        ]),
      });
      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
        uploaded: 0,
        retried: 2,
      });
    });

    it("does not count marks that raced and does not retry their rows", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([
          pendingRow(1),
          pendingRow(2),
          pendingRow(3),
          pendingRow(4, { delivery_attempts: THRESHOLD }),
          pendingRow(5),
          pendingRow(6, { delivery_attempts: 1 }),
        ]),
        markAcknowledged: vi.fn().mockResolvedValue(false),
        markQuarantined: vi.fn().mockResolvedValue(false),
        markDeliveryQuarantined: vi.fn().mockResolvedValue(false),
        markDeliveryRetry: vi.fn().mockResolvedValue(false),
      });
      const remote = remoteRepository({
        insertEvents: insertThenSucceed(1),
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: ID(1), outcome: "absent" },
          { eventId: ID(2), outcome: "applied", inboxId: 102n },
          { eventId: ID(3), outcome: "quarantined", inboxId: 103n, quarantineReason: "poison" },
          { eventId: ID(4), outcome: "mismatch" },
          { eventId: ID(5), outcome: "busy" },
          { eventId: ID(6), outcome: "mismatch" },
        ]),
      });
      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
        uploaded: 1,
        acknowledged: 0,
        quarantined: 0,
        retried: 0,
      });
      expect(insertedIds(remote, 1)).toEqual([ID(1)]);
      expect(idsOf(local.markDeliveryRetry.mock.calls)).toEqual([5, 6].map(ID));
    });

    it("does not insert again after a local mark throws", async () => {
      const failure = new Error("local store unavailable");
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
        markAcknowledged: vi.fn().mockRejectedValue(failure),
      });
      const remote = remoteRepository({
        insertEvents: insertThenSucceed(1),
        releaseFromOtherProjects: vi.fn().mockResolvedValue([
          { eventId: ID(1), outcome: "absent" },
          { eventId: ID(2), outcome: "applied", inboxId: 102n },
        ]),
      });
      await expect(worker(local, remote).runOnce()).rejects.toBe(failure);
      expect(remote.insertEvents).toHaveBeenCalledTimes(1);
    });

    describe("a row whose copy in the bound project differs (#1695)", () => {
      const collision = (n: number) =>
        new PostgreSqlPassiveEventDataError(PROJECT_ID, "idempotency_collision", ID(n));
      const differing = (n: number) => copy(n, { eventType: "different" });
      const collidingThenSucceed = (n: number) => vi.fn()
        .mockRejectedValueOnce(collision(n))
        .mockImplementation(async (inputs: ReadonlyArray<{ machineSequence: bigint }>) =>
          inputs.map(input => copy(Number(input.machineSequence))));

      it("retries it alone and uploads the rest of the batch in the same pass", async () => {
        const onError = vi.fn();
        const local = localRepository({
          claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
        });
        const remote = remoteRepository({
          insertEvents: collidingThenSucceed(1),
          readEvents: vi.fn().mockResolvedValue([differing(1)]),
          releaseFromOtherProjects: vi.fn().mockResolvedValue([
            { eventId: ID(2), outcome: "absent" },
          ]),
        });
        await expect(worker(local, remote, { onError }).runOnce()).resolves.toMatchObject({
          uploaded: 1,
          retried: 1,
          quarantined: 0,
        });
        expect(remote.insertEvents).toHaveBeenCalledTimes(2);
        expect(insertedIds(remote, 1)).toEqual([ID(2)]);
        expect(local.markReplicated.mock.calls).toEqual([[ID(2), "worker:local", 102n]]);
        expect(local.markDeliveryRetry.mock.calls).toEqual([[
          ID(1),
          "worker:local",
          "remote inbox copy differs from the local row",
          expect.any(String),
        ]]);
        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0][0] as Error).message).toContain(ID(1));
        expect((onError.mock.calls[0][0] as Error).message).not.toContain(ID(2));
      });

      it("quarantines it alone at the attempt boundary", async () => {
        const local = localRepository({
          claimDeliveries: vi.fn().mockResolvedValue([
            pendingRow(1, { delivery_attempts: THRESHOLD }),
            pendingRow(2),
          ]),
        });
        const remote = remoteRepository({
          insertEvents: collidingThenSucceed(1),
          readEvents: vi.fn().mockResolvedValue([differing(1)]),
          releaseFromOtherProjects: vi.fn().mockResolvedValue([
            { eventId: ID(2), outcome: "absent" },
          ]),
        });
        await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
          uploaded: 1,
          retried: 0,
          quarantined: 1,
        });
        expect(local.markDeliveryQuarantined.mock.calls).toEqual([
          [ID(1), "worker:local", "remote inbox copy differs from the local row"],
        ]);
        expect(local.markDeliveryRetry).not.toHaveBeenCalled();
        expect(insertedIds(remote, 1)).toEqual([ID(2)]);
      });

      it("settles every differing row and uploads nothing when all differ", async () => {
        const onError = vi.fn();
        const local = localRepository({
          claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
        });
        const remote = remoteRepository({
          insertEvents: collidingThenSucceed(1),
          readEvents: vi.fn().mockResolvedValue([differing(1), differing(2)]),
        });
        await expect(worker(local, remote, { onError }).runOnce()).resolves.toMatchObject({
          uploaded: 0,
          retried: 2,
        });
        expect(idsOf(local.markDeliveryRetry.mock.calls)).toEqual([1, 2].map(ID));
        expect(remote.releaseFromOtherProjects).not.toHaveBeenCalled();
        expect(remote.insertEvents).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledTimes(1);
        const message = (onError.mock.calls[0][0] as Error).message;
        expect(message).toContain(ID(1));
        expect(message).toContain(ID(2));
      });

      it("does not count a differing row whose local transition was lost", async () => {
        const local = localRepository({
          claimDeliveries: vi.fn().mockResolvedValue([
            pendingRow(1),
            pendingRow(2, { delivery_attempts: THRESHOLD }),
            pendingRow(3),
          ]),
          markDeliveryRetry: vi.fn().mockResolvedValue(false),
          markDeliveryQuarantined: vi.fn().mockResolvedValue(false),
        });
        const remote = remoteRepository({
          insertEvents: collidingThenSucceed(1),
          readEvents: vi.fn().mockResolvedValue([differing(1), differing(2), copy(3)]),
        });
        await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
          uploaded: 1,
          retried: 0,
          quarantined: 0,
        });
        expect(local.markDeliveryRetry).toHaveBeenCalledTimes(1);
        expect(local.markDeliveryQuarantined).toHaveBeenCalledTimes(1);
      });

      it("releases and inserts only the missing row of a mixed batch", async () => {
        const local = localRepository({
          claimDeliveries: vi.fn().mockResolvedValue([
            pendingRow(1),
            pendingRow(2),
            pendingRow(3),
          ]),
        });
        const remote = remoteRepository({
          insertEvents: collidingThenSucceed(1),
          readEvents: vi.fn().mockResolvedValue([differing(1), copy(2)]),
          releaseFromOtherProjects: vi.fn().mockResolvedValue([
            { eventId: ID(3), outcome: "absent" },
          ]),
        });
        await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
          uploaded: 2,
          retried: 1,
        });
        expect(remote.releaseFromOtherProjects.mock.calls[0][0].map(
          (key: { eventId: string }) => key.eventId,
        )).toEqual([ID(3)]);
        // The equal copy rides the one extra insert; the differing row never does.
        expect(insertedIds(remote, 1)).toEqual([ID(2), ID(3)]);
        expect(idsOf(local.markReplicated.mock.calls)).toEqual([ID(2), ID(3)]);
        expect(idsOf(local.markDeliveryRetry.mock.calls)).toEqual([ID(1)]);
      });

      it("settles the differing row once and the rest with the error when the recovery query fails", async () => {
        const failure = new Error("release unavailable");
        const onError = vi.fn();
        const local = localRepository({
          claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
        });
        const remote = remoteRepository({
          insertEvents: collidingThenSucceed(1),
          readEvents: vi.fn().mockResolvedValue([differing(1)]),
          releaseFromOtherProjects: vi.fn().mockRejectedValue(failure),
        });
        await expect(worker(local, remote, { onError }).runOnce()).resolves.toMatchObject({
          uploaded: 0,
          retried: 2,
        });
        expect(local.markDeliveryRetry.mock.calls).toEqual([
          [ID(1), "worker:local", "remote inbox copy differs from the local row", expect.any(String)],
          [ID(2), "worker:local", "release unavailable", expect.any(String)],
        ]);
        expect(remote.insertEvents).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(failure);
      });

      it("adopts the rows already in the bound project without asking elsewhere", async () => {
        const local = localRepository({
          claimDeliveries: vi.fn().mockResolvedValue([pendingRow(1), pendingRow(2)]),
        });
        const remote = remoteRepository({
          insertEvents: collidingThenSucceed(1),
          readEvents: vi.fn().mockResolvedValue([differing(1), copy(2)]),
        });
        await expect(worker(local, remote).runOnce()).resolves.toMatchObject({
          uploaded: 1,
          retried: 1,
        });
        expect(local.markReplicated.mock.calls).toEqual([[ID(2), "worker:local", 102n]]);
        expect(idsOf(local.markDeliveryRetry.mock.calls)).toEqual([ID(1)]);
        expect(remote.releaseFromOtherProjects).not.toHaveBeenCalled();
        expect(remote.insertEvents).toHaveBeenCalledTimes(1);
      });
    });
  });



  it.each([
    ["missing", null],
    ["different owner", remoteRecord({
      status: "claimed",
      claimedAt: "2026-07-29T12:00:01.000Z",
      claimedBy: "other",
    })],
  ])("does not transition a %s authoritative claim", async (_label, readback) => {
    const onError = vi.fn();
    const local = localRepository();
    const remote = remoteRepository({
      claimEvents: vi.fn().mockResolvedValue([claim()]),
      completeApplied: vi.fn().mockRejectedValue(new Error("effect failed")),
      readEvent: vi.fn().mockResolvedValue(readback),
    });
    await worker(local, remote, { onError }).runOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "effect failed" }));
    expect(remote.scheduleRetry).not.toHaveBeenCalled();
    expect(remote.quarantine).not.toHaveBeenCalled();
  });

  it("leaves a claim stale-recoverable when apply readback is unavailable", async () => {
    const onError = vi.fn();
    const local = localRepository();
    const remote = remoteRepository({
      claimEvents: vi.fn().mockResolvedValue([claim()]),
      completeApplied: vi.fn().mockRejectedValue(new Error("effect failed")),
      readEvent: vi.fn().mockRejectedValue(new Error("readback failed")),
    });
    await worker(local, remote, { onError }).runOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "readback failed" }));
    expect(remote.scheduleRetry).not.toHaveBeenCalled();
  });

  it("only records remote pruning after deletion or missing-row proof", async () => {
    const missing = localRow({
      delivery_state: "acknowledged",
      remote_inbox_id: "41",
      acknowledged_at: "2026-07-29 12:00:02",
    });
    const retained = localRow({
      event_id: 2,
      event_uuid: "87654321-4321-5abc-8def-123456789abc",
      machine_sequence: "0000000000000000008",
      delivery_state: "acknowledged",
      remote_inbox_id: "42",
      acknowledged_at: "2026-07-29 12:00:02",
    });
    const local = localRepository({
      listAcknowledgedForRemotePrune: vi.fn().mockResolvedValue([missing, retained]),
    });
    const remote = remoteRepository({
      pruneApplied: vi.fn().mockResolvedValue(1n),
      readEvents: vi.fn().mockResolvedValue([remoteRecord({
        inboxId: 42n,
        eventId: retained.event_uuid,
        machineSequence: 8n,
        status: "applied",
        appliedAt: "2026-07-29T12:00:02.000Z",
      })]),
    });
    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({ pruned: 1 });
    expect(local.markRemotePruned).toHaveBeenCalledOnce();
    expect(local.markRemotePruned).toHaveBeenCalledWith(missing.event_uuid);
  });

  it("recovers an uncertain prune commit through missing-row readback", async () => {
    const acknowledged = localRow({
      delivery_state: "acknowledged",
      remote_inbox_id: "41",
      acknowledged_at: "2026-07-29 12:00:02",
    });
    const onError = vi.fn();
    const local = localRepository({
      listAcknowledgedForRemotePrune: vi.fn().mockResolvedValue([acknowledged]),
    });
    const remote = remoteRepository({
      pruneApplied: vi.fn().mockRejectedValue(new Error("commit response lost")),
      readEvents: vi.fn().mockResolvedValue([]),
    });
    await expect(worker(local, remote, { onError }).runOnce())
      .resolves.toMatchObject({ pruned: 1 });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "commit response lost",
    }));
    expect(local.markRemotePruned).toHaveBeenCalledWith(EVENT_ID);
  });

  it("does not count a raced local prune checkpoint", async () => {
    const acknowledged = localRow({
      delivery_state: "acknowledged",
      remote_inbox_id: "41",
      acknowledged_at: "2026-07-29 12:00:02",
    });
    const local = localRepository({
      listAcknowledgedForRemotePrune: vi.fn().mockResolvedValue([acknowledged]),
      markRemotePruned: vi.fn().mockResolvedValue(false),
    });
    const remote = remoteRepository({
      pruneApplied: vi.fn().mockResolvedValue(1n),
    });

    await expect(worker(local, remote).runOnce()).resolves.toMatchObject({ pruned: 0 });
    expect(local.markRemotePruned).toHaveBeenCalledWith(EVENT_ID);
  });

  it("never records pruning after a mismatched or unavailable readback", async () => {
    const acknowledged = localRow({
      delivery_state: "acknowledged",
      remote_inbox_id: "41",
      acknowledged_at: "2026-07-29 12:00:02",
    });
    const local = localRepository({
      listAcknowledgedForRemotePrune: vi.fn().mockResolvedValue([acknowledged]),
    });
    const onError = vi.fn();
    const mismatch = remoteRepository({
      pruneApplied: vi.fn().mockResolvedValue(0n),
      readEvents: vi.fn().mockResolvedValue([remoteRecord({ inboxId: 99n })]),
    });
    await expect(worker(local, mismatch, { onError }).runOnce())
      .resolves.toMatchObject({ pruned: 0 });
    expect(local.markRemotePruned).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("readback mismatch"),
    }));

    onError.mockClear();
    const outage = remoteRepository({
      pruneApplied: vi.fn().mockResolvedValue(0n),
      readEvents: vi.fn().mockRejectedValue(new Error("readback unavailable")),
    });
    await expect(worker(local, outage, { onError }).runOnce())
      .resolves.toMatchObject({ pruned: 0 });
    expect(local.markRemotePruned).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "readback unavailable",
    }));

    for (const record of [
      remoteRecord({ status: "pending" }),
      remoteRecord({
        status: "quarantined",
        quarantinedAt: "2026-07-29T12:00:02.000Z",
        quarantineReason: "poison",
      }),
    ]) {
      onError.mockClear();
      const nonterminal = remoteRepository({
        pruneApplied: vi.fn().mockResolvedValue(0n),
        readEvents: vi.fn().mockResolvedValue([record]),
      });
      await expect(worker(local, nonterminal, { onError }).runOnce())
        .resolves.toMatchObject({ pruned: 0 });
      expect(local.markRemotePruned).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining(`is ${record.status}`),
      }));
    }
  });

  it("stops safely when drain lease renewal loses ownership", async () => {
    const onError = vi.fn();
    const local = localRepository();
    const remote = remoteRepository({
      renewDrainLease: vi.fn().mockResolvedValue(null),
    });
    await expect(worker(local, remote, { onError }).runOnce())
      .resolves.toMatchObject({ leaseAcquired: true, applied: 0 });
    expect(remote.claimEvents).not.toHaveBeenCalled();
    // Losing the lease before any claim skips reconcile and prune.
    expect(local.listAwaitingRemote).not.toHaveBeenCalled();
    expect(local.listAcknowledgedForRemotePrune).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "passive-event drain lease expired",
    }));
  });

  it("stops before applying the next claim when lease renewal loses ownership", async () => {
    const onError = vi.fn();
    const remote = remoteRepository({
      renewDrainLease: vi.fn()
        .mockResolvedValueOnce(lease())
        .mockResolvedValueOnce(null),
      claimEvents: vi.fn().mockResolvedValue([claim()]),
    });

    await expect(worker(localRepository(), remote, { onError }).runOnce())
      .resolves.toMatchObject({ applied: 0 });
    expect(remote.completeApplied).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "passive-event drain lease expired",
    }));
  });

  it("fails closed when local recovery state transitions race", async () => {
    const poison = localRow({
      delivery_state: "claimed",
      delivery_owner: "worker:local",
      delivery_attempts: 5,
    });
    const localPoison = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([poison]),
      markDeliveryQuarantined: vi.fn().mockResolvedValue(false),
    });
    const poisonError = new PostgreSqlPassiveEventDataError(
      PROJECT_ID,
      "idempotency_collision",
      poison.event_uuid,
    );
    const remotePoison = remoteRepository({
      insertEvents: vi.fn().mockRejectedValue(new Error("insert uncertain")),
      readEvents: vi.fn().mockRejectedValue(poisonError),
    });
    await expect(worker(localPoison, remotePoison).runOnce()).resolves.toMatchObject({
      retried: 0,
      quarantined: 0,
    });

    const retry = localRow({
      delivery_state: "claimed",
      delivery_owner: "worker:local",
    });
    const localRetry = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([retry]),
      markDeliveryRetry: vi.fn().mockResolvedValue(false),
    });
    const remoteRetry = remoteRepository({
      insertEvents: vi.fn().mockRejectedValue(new Error("insert uncertain")),
      readEvents: vi.fn().mockRejectedValue(17),
    });
    await expect(worker(localRetry, remoteRetry, {
      now: undefined,
    }).runOnce()).resolves.toMatchObject({
      retried: 0,
      quarantined: 0,
    });
    expect(localRetry.markDeliveryRetry.mock.calls[0][2]).toBe("17");
  });

  it("reports release failures without replacing a successful drain result", async () => {
    const onError = vi.fn();
    const local = localRepository();
    const remote = remoteRepository({
      releaseDrainLease: vi.fn().mockRejectedValue(new Error("release failed")),
    });
    await expect(worker(local, remote, { onError }).runOnce())
      .resolves.toMatchObject({ leaseAcquired: true });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "release failed",
    }));
  });

  it("attempts lease release independently after an operation is aborted", async () => {
    const controller = new AbortController();
    const local = localRepository();
    const remote = remoteRepository({
      renewDrainLease: vi.fn().mockImplementation(async (
        _processId: string,
        _fencingToken: bigint,
        _ttlMs: number,
        signal?: AbortSignal,
      ) => {
        controller.abort();
        signal?.throwIfAborted();
        throw new Error("expected abort");
      }),
    });

    await expect(worker(local, remote).runOnce(controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(remote.releaseDrainLease).toHaveBeenCalledWith(
      "worker",
      7n,
      undefined,
    );
  });

  it("does not let a diagnostics callback interrupt durable recovery", async () => {
    const onError = vi.fn().mockRejectedValue(new Error("diagnostics failed"));
    const local = localRepository();
    const remote = remoteRepository({
      releaseDrainLease: vi.fn().mockRejectedValue(new Error("release failed")),
    });

    await expect(worker(local, remote, { onError }).runOnce())
      .resolves.toMatchObject({ leaseAcquired: true });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "release failed",
    }));
  });

  it("validates every bounded worker option", () => {
    const local = localRepository();
    const remote = remoteRepository();
    const cases: Array<[Partial<PassiveEventReplicationOptions>, string]> = [
      [{ processId: " " }, "process ID"],
      [{ batchSize: 0 }, "batch size"],
      [{ batchSize: 501 }, "batch size"],
      [{ batchSize: 1.5 }, "batch size"],
      [{ staleClaimMs: -1 }, "stale claim"],
      [{ staleClaimMs: 0 }, "stale claim"],
      [{ leaseTtlMs: 0 }, "lease TTL"],
      [{ pollIntervalMs: 0 }, "poll interval"],
      [{ retryBaseMs: 0 }, "retry base"],
      [{ retryMaxMs: 0 }, "retry maximum"],
      [{ retryJitterRatio: -0.1 }, "jitter"],
      [{ retryJitterRatio: 1.1 }, "jitter"],
      [{ retryJitterRatio: Number.NaN }, "jitter"],
      [{ quarantineAfterAttempts: 0 }, "quarantine attempt"],
      [{ retryBaseMs: 2, retryMaxMs: 1 }, "must not exceed"],
    ];
    for (const [overrides, message] of cases) {
      expect(() => new PassiveEventReplicationWorker(
        dependencies(local, remote),
        { processId: "worker", ...overrides },
      )).toThrow(message);
    }
  });

  it("fails closed when the injected random source is invalid", async () => {
    const local = localRepository();
    const claimed = claim();
    const remote = remoteRepository({
      claimEvents: vi.fn().mockResolvedValue([claimed]),
      completeApplied: vi.fn().mockRejectedValue(new Error("effect failed")),
      readEvent: vi.fn().mockResolvedValue(remoteRecord({
        status: "claimed",
        claimedAt: claimed.claimedAt,
        claimedBy: claimed.claimedBy,
      })),
    });
    await expect(worker(local, remote, { random: () => 2 }).runOnce())
      .rejects.toThrow("random source");
  });

  it("starts once, reschedules after a run, and stops an outstanding timer", async () => {
    const callbacks: Array<() => void> = [];
    const timers: Array<{ unref: ReturnType<typeof vi.fn> }> = [];
    const setTimer = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      const timer = { unref: vi.fn() };
      timers.push(timer);
      return timer;
    }) as unknown as typeof setTimeout;
    const clearTimer = vi.fn() as unknown as typeof clearTimeout;
    const local = localRepository();
    const remote = remoteRepository();
    const subject = worker(local, remote, {
      setTimeout: setTimer,
      clearTimeout: clearTimer,
    });

    subject.start();
    subject.start();
    expect(setTimer).toHaveBeenCalledOnce();
    expect(timers[0].unref).toHaveBeenCalledOnce();
    callbacks[0]();
    await vi.waitFor(() => expect(setTimer).toHaveBeenCalledTimes(2));
    subject.stop();
    expect(clearTimer).toHaveBeenCalledWith(timers[1]);
    subject.stop();
    subject.start();
    expect(setTimer).toHaveBeenCalledTimes(2);
  });

  it("contains scheduled failures and honors stop from the diagnostics callback", async () => {
    const callbacks: Array<() => void> = [];
    const setTimer = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return { unref: vi.fn() };
    }) as unknown as typeof setTimeout;
    const remote = remoteRepository({
      acquireDrainLease: vi.fn().mockRejectedValue(new Error("scheduled failure")),
    });
    let subject!: PassiveEventReplicationWorker;
    const onError = vi.fn(() => {
      subject.stop();
    });
    subject = worker(localRepository(), remote, { setTimeout: setTimer, onError });

    subject.start();
    callbacks[0]();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "scheduled failure" }),
    ));
    expect(setTimer).toHaveBeenCalledOnce();
  });

  it("uses the no-op diagnostics default for scheduled failures", async () => {
    const callbacks: Array<() => void> = [];
    const setTimer = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return { unref: vi.fn() };
    }) as unknown as typeof setTimeout;
    const remote = remoteRepository({
      acquireDrainLease: vi.fn().mockRejectedValue(new Error("scheduled failure")),
    });
    const configured = dependencies(localRepository(), remote, {
      setTimeout: setTimer,
      onError: undefined,
    });
    const subject = new PassiveEventReplicationWorker(
      configured,
      { processId: "worker", pollIntervalMs: 1 },
    );

    subject.start();
    callbacks[0]();
    await vi.waitFor(() => expect(setTimer).toHaveBeenCalledTimes(2));
    subject.stop();
  });

  it("stopAndWait cancels scheduling and waits for the active run", async () => {
    let releaseAcquire!: (value: PostgreSqlFencedLease) => void;
    const acquire = new Promise<PostgreSqlFencedLease>((resolve) => {
      releaseAcquire = resolve;
    });
    const clearTimer = vi.fn() as unknown as typeof clearTimeout;
    const local = localRepository();
    const remote = remoteRepository({
      acquireDrainLease: vi.fn().mockReturnValue(acquire),
    });
    const subject = worker(local, remote, { clearTimeout: clearTimer });
    const active = subject.runOnce();
    const stopping = subject.stopAndWait();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseAcquire(lease());
    await active;
    await stopping;
    expect(stopped).toBe(true);
  });

  describe("backlog signal (#1764)", () => {
    const SECOND_ID = "22345678-1234-4abc-8def-123456789abc";

    it("is false when no capped read returned a full batch", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([localRow({ event_version: 999 })]),
        listAwaitingRemote: vi.fn().mockResolvedValue([localRow({ delivery_state: "replicated" })]),
        listAcknowledgedForRemotePrune: vi.fn().mockResolvedValue([
          localRow({ delivery_state: "acknowledged", remote_inbox_id: "41" }),
        ]),
      });
      const remote = remoteRepository({ pruneApplied: vi.fn().mockResolvedValue(1n) });

      await expect(worker(local, remote, {}, { batchSize: 2 }).runOnce())
        .resolves.toMatchObject({ leaseAcquired: true, backlog: false });
    });

    it("is true when the local delivery claim returns a full batch", async () => {
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([
          localRow({ event_version: 999 }),
          localRow({ event_uuid: SECOND_ID, event_version: 999 }),
        ]),
      });

      await expect(worker(local, remoteRepository(), {}, { batchSize: 2 }).runOnce())
        .resolves.toMatchObject({ quarantined: 2, backlog: true });
    });

    it("is true when the remote claim loop ends on its spent budget", async () => {
      const inbox = statefulInbox(inboxRows(MACHINE_ID, 3));

      await expect(worker(localRepository(), inboxRemote(inbox), {}, { batchSize: 2 }).runOnce())
        .resolves.toMatchObject({ applied: 2, backlog: true });
    });

    it("is true when reconciliation reads a full batch of awaiting rows", async () => {
      const local = localRepository({
        listAwaitingRemote: vi.fn().mockResolvedValue([localRow({ delivery_state: "replicated" })]),
      });

      await expect(worker(local, remoteRepository(), {}, { batchSize: 1 }).runOnce())
        .resolves.toMatchObject({ backlog: true });
    });

    it("is true when pruning reads a full batch of acknowledged rows", async () => {
      const local = localRepository({
        listAcknowledgedForRemotePrune: vi.fn().mockResolvedValue([
          localRow({ delivery_state: "acknowledged", remote_inbox_id: "41" }),
        ]),
      });
      const remote = remoteRepository({ pruneApplied: vi.fn().mockResolvedValue(1n) });

      await expect(worker(local, remote, {}, { batchSize: 1 }).runOnce())
        .resolves.toMatchObject({ pruned: 1, backlog: true });
    });
  });

  it("keeps the public defaults stable for operator documentation", () => {
    expect(PASSIVE_EVENT_REPLICATION_DEFAULTS).toEqual({
      batchSize: 100,
      staleClaimMs: 60_000,
      leaseTtlMs: 30_000,
      pollIntervalMs: 3_000,
      retryBaseMs: 1_000,
      retryMaxMs: 300_000,
      retryJitterRatio: 0.2,
      quarantineAfterAttempts: 5,
    });
  });

  it("admits each phase separately and releases between phases", async () => {
    // The daemon pass supplies this admission so hook appends can proceed
    // between replication phases. Every phase plus the lease acquisition
    // must run inside it, and only the cleanup release outside it: without
    // the boundaries a reverted worker runs everything unadmitted and this
    // records no admissions at all.
    const events: string[] = [];
    const admitPhase = async <T>(operation: () => Promise<T>): Promise<T> => {
      events.push("enter");
      try {
        return await operation();
      } finally {
        events.push("exit");
      }
    };
    const pending = localRow({ delivery_state: "claimed", delivery_owner: "worker:local" });
    const local = localRepository({
      claimDeliveries: vi.fn().mockImplementation(async () => {
        events.push("claimDeliveries");
        return [pending];
      }),
    });
    const claimed = claim();
    const remote = remoteRepository({
      acquireDrainLease: vi.fn().mockImplementation(async () => {
        events.push("acquireDrainLease");
        return lease();
      }),
      insertEvents: vi.fn().mockImplementation(async () => {
        events.push("insertEvents");
        return [remoteRecord()];
      }),
      renewDrainLease: vi.fn().mockImplementation(async () => {
        events.push("renewDrainLease");
        return lease();
      }),
      claimEvents: vi.fn().mockImplementation(async () => {
        events.push("claimEvents");
        return events.includes("completeApplied") ? [] : [claimed];
      }),
      completeApplied: vi.fn().mockImplementation(async () => {
        events.push("completeApplied");
        return { event: remoteRecord({ status: "applied" }), result: undefined };
      }),
      releaseDrainLease: vi.fn().mockImplementation(async () => {
        events.push("releaseDrainLease");
        return { ...lease(), releasedAt: "2026-07-29T12:01:00.000Z" };
      }),
    });

    await expect(worker(local, remote, { admitPhase }).runOnce()).resolves.toMatchObject({
      leaseAcquired: true,
      uploaded: 1,
      applied: 1,
    });

    // Lease acquisition, upload, renew, claim fetch, one apply, renew before
    // the next fetch, the empty fetch, reconcile, prune: nine admissions.
    expect(events.filter(event => event === "enter")).toHaveLength(9);
    // Every replication operation ran inside exactly one admission, and only
    // the cleanup lease release ran outside all of them.
    let depth = 0;
    for (const event of events) {
      if (event === "enter") depth += 1;
      else if (event === "exit") depth -= 1;
      else if (event === "releaseDrainLease") {
        expect(depth).toBe(0);
      } else {
        expect(depth).toBe(1);
      }
    }
    expect(depth).toBe(0);
    expect(events.indexOf("claimDeliveries")).toBeLessThan(events.indexOf("insertEvents"));
    expect(events.indexOf("insertEvents")).toBeLessThan(events.indexOf("claimEvents"));
    expect(events.indexOf("claimEvents")).toBeLessThan(events.indexOf("completeApplied"));
    // The renewal and the empty fetch that follow the apply are their own
    // admitted phases, in that order.
    expect(events.lastIndexOf("renewDrainLease"))
      .toBeGreaterThan(events.indexOf("completeApplied"));
    expect(events.lastIndexOf("claimEvents"))
      .toBeGreaterThan(events.lastIndexOf("renewDrainLease"));
    expect(events.filter(event => event === "claimEvents")).toHaveLength(2);
    expect(events[0]).toBe("enter");
    expect(events.indexOf("enter")).toBeLessThan(events.indexOf("acquireDrainLease"));
    expect(events.lastIndexOf("exit")).toBeLessThan(events.indexOf("releaseDrainLease"));
  });

  it("propagates a refused phase admission without running later phases", async () => {
    const refusal = new BackendPublicationJournalError("backend-mismatch", "publication moved on");
    let admissions = 0;
    const admitPhase = async <T>(operation: () => Promise<T>): Promise<T> => {
      admissions += 1;
      if (admissions > 1) throw refusal;
      return operation();
    };
    const pending = localRow({ delivery_state: "claimed", delivery_owner: "worker:local" });
    const local = localRepository({
      claimDeliveries: vi.fn().mockResolvedValue([pending]),
    });
    const remote = remoteRepository({
      insertEvents: vi.fn().mockResolvedValue([remoteRecord()]),
    });

    await expect(worker(local, remote, { admitPhase }).runOnce()).rejects.toBe(refusal);
    // The upload ran admitted; nothing after the refusal did, but the lease
    // still released through the worker finally.
    expect(remote.claimEvents).not.toHaveBeenCalled();
    expect(remote.releaseDrainLease).toHaveBeenCalledOnce();
  });

  it("refuses the drain lease acquisition when admission is already stale", async () => {
    // A publication switch that lands before the first phase must refuse
    // the lease acquisition itself: acquiring first would write a lease row
    // to a backend the daemon has already lost, then halt anyway (#1384).
    const refusal = new BackendPublicationJournalError("backend-mismatch", "publication moved on");
    const admitPhase = async <T>(): Promise<T> => {
      throw refusal;
    };
    const local = localRepository();
    const remote = remoteRepository();

    await expect(worker(local, remote, { admitPhase }).runOnce()).rejects.toBe(refusal);
    expect(remote.acquireDrainLease).not.toHaveBeenCalled();
    expect(remote.releaseDrainLease).not.toHaveBeenCalled();
  });

  it("accepts an apply callback with the transaction executor contract", async () => {
    const executor = { query: vi.fn() } as unknown as PostgreSqlQueryExecutor;
    const applyEvent = vi.fn(async (
      receivedExecutor: PostgreSqlQueryExecutor,
      receivedClaim: PostgreSqlPassiveEventClaim,
    ) => {
      expect(receivedExecutor).toBe(executor);
      expect(receivedClaim).toEqual(claim());
    });
    await dependencies(
      localRepository(),
      remoteRepository(),
      { applyEvent },
    ).applyEvent(executor, claim());
    expect(applyEvent).toHaveBeenCalledOnce();
  });

  describe("draining a machine's backlog in one pass (#1530)", () => {
    it("applies every ready event of one machine in sequence order in one run", async () => {
      const inbox = statefulInbox(inboxRows(MACHINE_ID, 3));
      const order: string[] = [];
      const applyEvent = vi.fn(async (_executor: PostgreSqlQueryExecutor, event: PostgreSqlPassiveEventClaim) => {
        order.push(event.machineSequence.toString());
      });
      const remote = inboxRemote(inbox);

      await expect(worker(localRepository(), remote, { applyEvent }).runOnce())
        .resolves.toMatchObject({ applied: 3, retried: 0, quarantined: 0 });
      expect(order).toEqual(["1", "2", "3"]);
      expect(inbox.log.applied).toEqual([1, 2, 3].map(n => `${MACHINE_ID}:${String(n)}`));
      // Each non-final fetch returns one row, and the empty terminator ends it.
      expect(inbox.log.limits).toEqual([100, 99, 98, 97]);
      expect(remote.releaseDrainLease).toHaveBeenCalledOnce();
    });

    it("stops claiming when the shared claimed-row budget is spent", async () => {
      const inbox = statefulInbox(inboxRows(MACHINE_ID, 3));
      const remote = inboxRemote(inbox);

      await expect(worker(localRepository(), remote, {}, { batchSize: 2 }).runOnce())
        .resolves.toMatchObject({ applied: 2 });
      expect(inbox.log.limits).toEqual([2, 1]);
      expect(inbox.log.claimed).toHaveLength(2);
      expect(inbox.rows.map(row => row.status)).toEqual(["applied", "applied", "pending"]);
    });

    it("shares one budget across machines and blocks only a stuck head's successor", async () => {
      const inbox = statefulInbox(
        [...inboxRows(MACHINE_A, 2), ...inboxRows(MACHINE_B, 2)],
        { failApply: row => row.machineId === MACHINE_A && row.machineSequence === 1n },
      );
      const remote = inboxRemote(inbox);

      await expect(worker(localRepository(), remote, {}, { batchSize: 4 }).runOnce())
        .resolves.toMatchObject({ applied: 2, retried: 1 });
      // Fetch 1 claims both heads (budget 4 -> 2); A1 retries, B1 applies,
      // so B2 is claimed by fetch 2 (budget 2 -> 1); A2 stays blocked behind
      // the retrying A1, and the third fetch ends the pass.
      expect(inbox.log.limits).toEqual([4, 2, 1]);
      expect(inbox.log.applied).toEqual([`${MACHINE_B}:1`, `${MACHINE_B}:2`]);
      expect(inbox.rows.map(row => row.status)).toEqual(["retry", "pending", "applied", "applied"]);
    });

    it("divides the budget between machines in fetch order", async () => {
      const inbox = statefulInbox([...inboxRows(MACHINE_A, 2), ...inboxRows(MACHINE_B, 2)]);

      await expect(worker(localRepository(), inboxRemote(inbox), {}, { batchSize: 3 }).runOnce())
        .resolves.toMatchObject({ applied: 3 });
      expect(inbox.log.limits).toEqual([3, 1]);
      expect(inbox.log.applied).toEqual([
        `${MACHINE_A}:1`,
        `${MACHINE_B}:1`,
        `${MACHINE_A}:2`,
      ]);
      expect(inbox.rows.at(-1)?.status).toBe("pending");
    });

    it("does not fetch again after a claim that is scheduled for retry", async () => {
      const inbox = statefulInbox(inboxRows(MACHINE_ID, 2), { failApply: () => true });
      const remote = inboxRemote(inbox);

      await expect(worker(localRepository(), remote).runOnce())
        .resolves.toMatchObject({ applied: 0, retried: 1 });
      expect(inbox.claimEvents).toHaveBeenCalledOnce();
      expect(remote.renewDrainLease).toHaveBeenCalledTimes(2);
    });

    it("does not count an upload-phase quarantine as claim progress", async () => {
      const inbox = statefulInbox(inboxRows(MACHINE_ID, 2), { failApply: () => true });
      const future = localRow({
        event_version: 2,
        delivery_state: "claimed",
        delivery_owner: "worker:local",
      });
      const local = localRepository({
        claimDeliveries: vi.fn().mockResolvedValue([future]),
      });

      await expect(worker(local, inboxRemote(inbox)).runOnce())
        .resolves.toMatchObject({ applied: 0, retried: 1, quarantined: 1 });
      expect(inbox.claimEvents).toHaveBeenCalledOnce();
    });

    it("does not fetch again after a failure that settles nothing", async () => {
      const onError = vi.fn();
      const inbox = statefulInbox(inboxRows(MACHINE_ID, 2), { failApply: () => true });
      const remote = inboxRemote(inbox, { readEvent: vi.fn().mockResolvedValue(null) });

      await expect(worker(localRepository(), remote, { onError }).runOnce())
        .resolves.toMatchObject({ applied: 0, retried: 0 });
      expect(inbox.claimEvents).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "effect rejected" }));
    });

    it("counts the quarantine of an unsupported head as progress for its successor", async () => {
      const rows = inboxRows(MACHINE_ID, 2);
      const inbox = statefulInbox([{ ...rows[0]!, eventVersion: 2 }, rows[1]!]);

      await expect(worker(localRepository(), inboxRemote(inbox)).runOnce())
        .resolves.toMatchObject({ applied: 1, quarantined: 1 });
      expect(inbox.rows.map(row => row.status)).toEqual(["quarantined", "applied"]);
      expect(inbox.completeApplied).toHaveBeenCalledOnce();
    });

    it("renews the lease before every further fetch and skips the fetch when it is lost", async () => {
      const inbox = statefulInbox(inboxRows(MACHINE_ID, 2));
      const local = localRepository();
      const remote = inboxRemote(inbox, {
        renewDrainLease: vi.fn()
          .mockResolvedValueOnce(lease())
          .mockResolvedValueOnce(lease())
          .mockResolvedValueOnce(null),
      });

      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({ applied: 1 });
      expect(inbox.claimEvents).toHaveBeenCalledOnce();
      expect(inbox.rows.map(row => row.status)).toEqual(["applied", "pending"]);
      expect(local.listAwaitingRemote).toHaveBeenCalledOnce();
      expect(local.listAcknowledgedForRemotePrune).toHaveBeenCalledOnce();
      expect(remote.releaseDrainLease).toHaveBeenCalledOnce();
    });

    it("stops fetching when the lease is lost while applying a later batch", async () => {
      const inbox = statefulInbox(inboxRows(MACHINE_ID, 3));
      const local = localRepository();
      const remote = inboxRemote(inbox, {
        renewDrainLease: vi.fn()
          .mockResolvedValueOnce(lease())
          .mockResolvedValueOnce(lease())
          .mockResolvedValueOnce(lease())
          .mockResolvedValueOnce(null),
      });

      await expect(worker(local, remote).runOnce()).resolves.toMatchObject({ applied: 1 });
      expect(inbox.claimEvents).toHaveBeenCalledTimes(2);
      expect(inbox.completeApplied).toHaveBeenCalledOnce();
      expect(local.listAwaitingRemote).toHaveBeenCalledOnce();
      expect(local.listAcknowledgedForRemotePrune).toHaveBeenCalledOnce();
    });

    it("propagates a refused admission on a later fetch without reconciling", async () => {
      const refusal = new BackendPublicationJournalError("backend-mismatch", "publication moved on");
      const inbox = statefulInbox(inboxRows(MACHINE_ID, 2));
      let admissions = 0;
      const admitPhase = async <T>(operation: () => Promise<T>): Promise<T> => {
        admissions += 1;
        // lease, upload, renew, fetch, apply, renew, then the second fetch.
        if (admissions === 7) throw refusal;
        return operation();
      };
      const local = localRepository();
      const remote = inboxRemote(inbox);

      await expect(worker(local, remote, { admitPhase }).runOnce()).rejects.toBe(refusal);
      expect(inbox.claimEvents).toHaveBeenCalledOnce();
      expect(local.listAwaitingRemote).not.toHaveBeenCalled();
      expect(local.listAcknowledgedForRemotePrune).not.toHaveBeenCalled();
      expect(remote.releaseDrainLease).toHaveBeenCalledOnce();
    });
  });
});
