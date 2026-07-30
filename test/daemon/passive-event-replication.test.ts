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
      claimEvents: vi.fn().mockResolvedValue([claimed]),
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
    expect(remote.renewDrainLease).toHaveBeenCalledTimes(2);
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
      claimEvents: vi.fn().mockResolvedValue([future]),
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
      claimEvents: vi.fn().mockResolvedValue([future]),
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
      claimEvents: vi.fn().mockResolvedValue([claimed]),
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
      claimEvents: vi.fn().mockResolvedValue([claimed]),
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
      claimEvents: vi.fn().mockResolvedValue([claimed]),
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
});
