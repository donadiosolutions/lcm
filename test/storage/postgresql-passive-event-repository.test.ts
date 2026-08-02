import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import type {
  PostgreSqlPassiveEventClaim,
  PostgreSqlFencedLease,
} from "../../src/storage/postgresql/coordination.js";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlTransactionScopeExecutor,
} from "../../src/storage/postgresql/contracts.js";

const coordination = vi.hoisted(() => ({
  claim: vi.fn(),
  diagnostics: vi.fn(),
  acquire: vi.fn(),
  renew: vi.fn(),
  release: vi.fn(),
  assertFence: vi.fn(),
}));

vi.mock("../../src/storage/postgresql/coordination.js", () => ({
  PostgreSqlWorkCoordinator: class {
    readonly projectId: string;
    readonly machineId: string;

    constructor(_executor: unknown, projectId: string, machineId: string) {
      this.projectId = projectId.toLowerCase();
      this.machineId = machineId.toLowerCase();
    }

    claimPassiveEvents(input: unknown): unknown {
      return coordination.claim(input);
    }

    getCoordinationDiagnostics(): unknown {
      return coordination.diagnostics();
    }

    acquireLease(input: unknown): unknown {
      return coordination.acquire(input);
    }

    renewLease(input: unknown): unknown {
      return coordination.renew(input);
    }

    releaseLease(input: unknown): unknown {
      return coordination.release(input);
    }

    assertLeaseFence(input: unknown): unknown {
      return coordination.assertFence(input);
    }
  },
}));

import {
  PostgreSqlPassiveEventDataError,
  PostgreSqlPassiveEventRepository,
  type PostgreSqlPassiveEventRecord,
  type PostgreSqlPassiveEventRepositoryExecutor,
} from "../../src/storage/postgresql/passive-event-repository.js";

const PROJECT_ID = "0195d250-0000-7000-8000-000000000001";
const MACHINE_ID = "0195d250-0000-7000-8000-000000000002";
const OTHER_MACHINE_ID = "0195d250-0000-7000-8000-000000000003";
const EVENT_ID = "12345678-1234-4abc-8def-123456789abc";
const SECOND_EVENT_ID = "87654321-4321-5abc-8def-123456789abc";
const MAX_POSTGRESQL_BIGINT = 9_223_372_036_854_775_807n;

type QueryHandler = (
  config: QueryConfig<unknown[]>,
  options: PostgreSqlQueryOptions,
) => Promise<QueryResult<QueryResultRow>>;

function queryResult<R extends QueryResultRow>(
  rows: R[],
  rowCount = rows.length,
): QueryResult<R> {
  return {
    command: "",
    rowCount,
    oid: 0,
    fields: [],
    rows,
  };
}

function eventRow(
  overrides: Partial<Record<keyof PostgreSqlPassiveEventRecord | "inbox_id"
  | "project_id" | "machine_id" | "event_id" | "event_version"
  | "machine_sequence" | "event_type" | "attempt_count" | "received_at"
  | "next_attempt_at" | "claimed_at" | "claimed_by" | "applied_at"
  | "quarantined_at" | "quarantine_reason", unknown>> = {},
): QueryResultRow {
  return {
    inbox_id: "41",
    project_id: PROJECT_ID,
    machine_id: MACHINE_ID,
    event_id: EVENT_ID,
    event_version: 1,
    machine_sequence: "9223372036854775807",
    event_type: "choice",
    payload: { nested: { beta: 2, alpha: 1 }, sessionId: "session" },
    status: "pending",
    attempt_count: 0,
    received_at: "2026-07-29T12:00:00.000Z",
    next_attempt_at: "2026-07-29T12:00:00.000Z",
    claimed_at: null,
    claimed_by: null,
    applied_at: null,
    quarantined_at: null,
    quarantine_reason: null,
    ...overrides,
  };
}

function claimedEventRow(
  overrides: Parameters<typeof eventRow>[0] = {},
): QueryResultRow {
  return eventRow({
    machine_sequence: "7",
    payload: { sessionId: "session" },
    status: "claimed",
    attempt_count: 1,
    claimed_at: "2026-07-29T12:00:01.000Z",
    claimed_by: "worker:7",
    ...overrides,
  });
}

function claim(overrides: Partial<PostgreSqlPassiveEventClaim> = {}): PostgreSqlPassiveEventClaim {
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

function executors(handler: QueryHandler): {
  root: PostgreSqlPassiveEventRepositoryExecutor;
  scope: PostgreSqlTransactionScopeExecutor;
  query: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  savepoint: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (
    config: QueryConfig<unknown[]>,
    options: PostgreSqlQueryOptions,
  ) => {
    if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
      return queryResult([]);
    }
    return handler(config, options);
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
    root: { query, transaction } as unknown as PostgreSqlPassiveEventRepositoryExecutor,
    scope,
    query,
    transaction,
    savepoint: scope.savepoint,
  };
}

function repository(handler: QueryHandler): {
  repository: PostgreSqlPassiveEventRepository;
  execution: ReturnType<typeof executors>;
} {
  const execution = executors(handler);
  return {
    repository: new PostgreSqlPassiveEventRepository(
      execution.root,
      PROJECT_ID,
      MACHINE_ID,
    ),
    execution,
  };
}

function expectDataError(field: string): {
  name: string;
  field: string;
  code: string;
} {
  return {
    name: "PostgreSqlPassiveEventDataError",
    field,
    code: "STORAGE_OPERATION_FAILED",
  };
}

describe("PostgreSqlPassiveEventRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coordination.claim.mockResolvedValue([]);
    coordination.diagnostics.mockResolvedValue({ queue: {}, leases: {} });
    coordination.acquire.mockResolvedValue(lease());
    coordination.renew.mockResolvedValue(lease());
    coordination.release.mockResolvedValue({ ...lease(), releasedAt: "2026-07-29T12:00:02.000Z" });
    coordination.assertFence.mockResolvedValue({ fencingToken: 7n });
  });

  it("delegates #90 claims, diagnostics, and the exact drain lease namespace", async () => {
    const { repository: subject } = repository(async () => queryResult([]));
    const signal = new AbortController().signal;
    await expect(subject.claimEvents({
      claimOwner: "worker",
      limit: 3,
      staleClaimMs: 1_000,
      signal,
    })).resolves.toEqual([]);
    await expect(subject.getDiagnostics()).resolves.toEqual({ queue: {}, leases: {} });
    await subject.acquireDrainLease("worker", 30_000, signal);
    await subject.renewDrainLease("worker", 7n, 30_000, signal);
    await subject.releaseDrainLease("worker", 7n, signal);

    expect(coordination.acquire).toHaveBeenCalledWith({
      resourceType: "passive-events",
      resourceKey: MACHINE_ID,
      processId: "worker",
      operation: "replicate",
      ttlMs: 30_000,
      signal,
    });
    expect(coordination.renew).toHaveBeenCalledWith({
      resourceType: "passive-events",
      resourceKey: MACHINE_ID,
      processId: "worker",
      operation: "replicate",
      fencingToken: 7n,
      ttlMs: 30_000,
      signal,
    });
    expect(coordination.release).toHaveBeenCalledWith({
      resourceType: "passive-events",
      resourceKey: MACHINE_ID,
      processId: "worker",
      operation: "replicate",
      fencingToken: 7n,
      signal,
    });
  });

  it("inserts a bounded batch and proves idempotency through ordered readback", async () => {
    const rows = [
      eventRow(),
      eventRow({
        inbox_id: "42",
        event_id: SECOND_EVENT_ID,
        machine_sequence: "8",
        payload: { sessionId: "second" },
      }),
    ];
    rows[0].payload = {
      nested: { beta: 2, alpha: 1 },
      sessionId: "session",
      values: [null, true, 4],
    };
    const { repository: subject, execution } = repository(async (config, options) => {
      expect(options).toMatchObject({
        domain: "passive-events",
        operation: "insertEvents",
        projectId: PROJECT_ID,
        machineId: MACHINE_ID,
      });
      if (config.text.includes("INSERT INTO lcm.passive_event_inbox")) {
        return queryResult([], 1);
      }
      expect(config.text).toContain("WITH ORDINALITY");
      return queryResult(rows);
    });

    const records = await subject.insertEvents([
      {
        machineId: MACHINE_ID,
        eventId: EVENT_ID,
        eventVersion: 1,
        machineSequence: MAX_POSTGRESQL_BIGINT,
        eventType: "choice",
        payload: {
          sessionId: "session",
          nested: { alpha: 1, beta: 2 },
          values: [null, true, 4],
        },
      },
      {
        machineId: MACHINE_ID,
        eventId: SECOND_EVENT_ID,
        eventVersion: 1,
        machineSequence: 8n,
        eventType: "choice",
        payload: { sessionId: "second" },
      },
    ]);

    expect(records.map((record) => record.eventId)).toEqual([EVENT_ID, SECOND_EVENT_ID]);
    expect(records[0].machineSequence).toBe(MAX_POSTGRESQL_BIGINT);
    expect(execution.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "coordination",
      machineId: MACHINE_ID,
      operation: "insertEvents",
      projectId: PROJECT_ID,
      transactionMode: "read-committed-read-write",
    });
    const insertCalls = execution.query.mock.calls.filter(
      ([config]) => config.text.includes("INSERT INTO lcm.passive_event_inbox"),
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][0].values?.[4]).toBe(MAX_POSTGRESQL_BIGINT.toString());
    expect(insertCalls[0][0].values?.[6]).toBe(
      JSON.stringify({
        sessionId: "session",
        nested: { alpha: 1, beta: 2 },
        values: [null, true, 4],
      }),
    );
  });

  it("rejects invalid batches, machine ownership, bigint overflow, and non-JSON payloads", async () => {
    const { repository: subject, execution } = repository(async () => queryResult([]));
    const valid = {
      machineId: MACHINE_ID,
      eventId: EVENT_ID,
      eventVersion: 1,
      machineSequence: 1n,
      eventType: "choice",
      payload: { sessionId: "session", validPair: "\ud83d\ude80" },
    };
    await expect(subject.insertEvents([])).rejects.toThrow("1-500");
    await expect(subject.insertEvents(Array.from({ length: 501 }, () => valid)))
      .rejects.toThrow("1-500");
    await expect(subject.insertEvents([valid, valid]))
      .rejects.toMatchObject(expectDataError("duplicate_batch_event_id"));
    await expect(subject.insertEvents([{ ...valid, machineId: OTHER_MACHINE_ID }]))
      .rejects.toMatchObject(expectDataError("machine_id"));
    await expect(subject.insertEvents([{
      ...valid,
      machineSequence: MAX_POSTGRESQL_BIGINT + 1n,
    }])).rejects.toMatchObject(expectDataError("machine_sequence"));
    await expect(subject.insertEvents([{
      ...valid,
      eventVersion: 2_147_483_648,
    }])).rejects.toMatchObject(expectDataError("event_version"));
    await expect(subject.insertEvents([{
      ...valid,
      payload: { missing: undefined },
    } as never])).rejects.toMatchObject(expectDataError("payload"));
    for (const invalidText of ["contains\0nul", "\ud800", "\udc00"]) {
      await expect(subject.insertEvents([{
        ...valid,
        eventType: invalidText,
      }])).rejects.toMatchObject(expectDataError("event_type"));
      await expect(subject.insertEvents([{
        ...valid,
        payload: { invalidText },
      }])).rejects.toMatchObject(expectDataError("payload"));
      await expect(subject.insertEvents([{
        ...valid,
        payload: { [invalidText]: "value" },
      }])).rejects.toMatchObject(expectDataError("payload"));
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(subject.insertEvents([{
      ...valid,
      payload: cyclic,
    } as never])).rejects.toMatchObject(expectDataError("payload"));
    for (const payload of [
      { invalid: Number.NaN },
      { invalid: Number.POSITIVE_INFINITY },
      { invalid: new Date("2026-07-29T12:00:00.000Z") },
    ]) {
      await expect(subject.insertEvents([{
        ...valid,
        payload,
      } as never])).rejects.toMatchObject(expectDataError("payload"));
    }
    expect(execution.transaction).not.toHaveBeenCalled();
  });

  it("fails closed on missing or colliding idempotency readback", async () => {
    const input = {
      machineId: MACHINE_ID,
      eventId: EVENT_ID,
      eventVersion: 1,
      machineSequence: 1n,
      eventType: "choice",
      payload: { sessionId: "session" },
    };
    const missing = repository(async (config) =>
      config.text.includes("INSERT INTO") ? queryResult([], 1) : queryResult([]));
    await expect(missing.repository.insertEvents([input]))
      .rejects.toMatchObject({
        ...expectDataError("idempotency_readback"),
        eventId: EVENT_ID,
      });

    const collision = repository(async (config) =>
      config.text.includes("INSERT INTO")
        ? queryResult([], 0)
        : queryResult([eventRow({ machine_sequence: "2" })]));
    await expect(collision.repository.insertEvents([input]))
      .rejects.toMatchObject(expectDataError("idempotency_collision"));

    const partialReadback = repository(async (config) =>
      config.text.includes("INSERT INTO")
        ? queryResult([], 0)
        : queryResult([eventRow({
          machine_sequence: "1",
          payload: { sessionId: "session" },
        })]));
    await expect(partialReadback.repository.insertEvents([
      input,
      {
        ...input,
        eventId: SECOND_EVENT_ID,
        machineSequence: 2n,
      },
    ])).rejects.toMatchObject({
      ...expectDataError("idempotency_readback"),
      eventId: SECOND_EVENT_ID,
    });

    const duplicateReadback = repository(async (config) =>
      config.text.includes("INSERT INTO")
        ? queryResult([], 0)
        : queryResult([
          eventRow({
            machine_sequence: "1",
            payload: { sessionId: "session" },
          }),
          eventRow({
            machine_sequence: "1",
            payload: { sessionId: "session" },
          }),
        ]));
    await expect(duplicateReadback.repository.insertEvents([
      input,
      {
        ...input,
        eventId: SECOND_EVENT_ID,
        machineSequence: 2n,
      },
    ])).rejects.toMatchObject({
      ...expectDataError("idempotency_readback"),
      eventId: SECOND_EVENT_ID,
    });
  });

  it.each([
    ["event_id", { event_id: null }],
    ["event_id", { event_id: "not-a-uuid" }],
    ["project_id", { project_id: OTHER_MACHINE_ID }],
    ["machine_id", { machine_id: EVENT_ID }],
    ["inbox_id", { inbox_id: null }],
    ["inbox_id", { inbox_id: (MAX_POSTGRESQL_BIGINT + 1n).toString() }],
    ["event_version", { event_version: "invalid" }],
    ["event_version", { event_version: Number.MAX_SAFE_INTEGER + 1 }],
    ["received_at", { received_at: 41 }],
    ["received_at", { received_at: "not-a-date" }],
    ["payload", { payload: [] }],
    ["payload", { payload: { invalid: Number.NaN } }],
    ["payload", { payload: { invalid: new Date("2026-07-29T12:00:00.000Z") } }],
    ["status", { status: "lost" }],
    ["status_timestamps", { status: "pending", claimed_at: "2026-07-29", claimed_by: "owner" }],
  ])("validates authoritative readback field %s", async (field, override) => {
    const { repository: subject } = repository(async () =>
      queryResult([eventRow(override)]));
    await expect(subject.readEvent({ machineId: MACHINE_ID, eventId: EVENT_ID }))
      .rejects.toMatchObject(expectDataError(field));
  });

  it("parses safe numeric and decimal fields from driver-compatible rows", async () => {
    const { repository: subject } = repository(async () => queryResult([eventRow({
      inbox_id: 41,
      event_version: "1",
      attempt_count: "0",
      payload: { values: [null, true, 4] },
    })]));
    await expect(subject.readEvent({ machineId: MACHINE_ID, eventId: EVENT_ID }))
      .resolves.toMatchObject({
        inboxId: 41n,
        eventVersion: 1,
        attemptCount: 0,
        payload: { values: [null, true, 4] },
      });
  });

  it("returns null when exact event readback is absent", async () => {
    const { repository: subject } = repository(async () => queryResult([]));
    await expect(subject.readEvent({ machineId: MACHINE_ID, eventId: EVENT_ID }))
      .resolves.toBeNull();
  });

  it("parses claimed, applied, and quarantined timestamp invariants", async () => {
    const rows = [
      eventRow({
        status: "claimed",
        claimed_at: new Date("2026-07-29T12:00:01.000Z"),
        claimed_by: "worker",
      }),
      eventRow({
        inbox_id: "42",
        event_id: SECOND_EVENT_ID,
        status: "applied",
        applied_at: "2026-07-29T12:00:02.000Z",
      }),
      eventRow({
        inbox_id: "43",
        event_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        status: "quarantined",
        quarantined_at: "2026-07-29T12:00:03.000Z",
        quarantine_reason: "poison",
      }),
    ];
    const { repository: subject, execution } = repository(async () => queryResult(rows));
    const records = await subject.readEvents(rows.map((row) => ({
      machineId: MACHINE_ID,
      eventId: String(row.event_id),
    })));
    expect(records.map((record) => record.status))
      .toEqual(["claimed", "applied", "quarantined"]);
    expect(records[0].claimedAt).toBe("2026-07-29T12:00:01.000Z");
    const readback = execution.query.mock.calls.find(
      ([config]) => config.text.includes("WITH ORDINALITY AS requested"),
    )?.[0];
    expect(readback?.text).toContain(`JOIN ROWS FROM (
               pg_catalog.unnest($2::pg_catalog.uuid[]),
               pg_catalog.unnest($3::pg_catalog.uuid[])
             ) WITH ORDINALITY`);
  });

  it("commits the effect and applied transition in the same fenced transaction", async () => {
    const order: string[] = [];
    coordination.assertFence.mockImplementation(async () => {
      order.push("fence");
      return { fencingToken: 7n };
    });
    const { repository: subject } = repository(async (config) => {
      if (config.text.includes("SELECT event.*")) {
        order.push("claim");
        return queryResult([claimedEventRow()]);
      }
      if (config.text.includes("SELECT effect")) {
        order.push("effect");
        return queryResult([{ effect: 1 }]);
      }
      if (config.text.includes("SET status = 'applied'")) {
        order.push("applied");
        return queryResult([eventRow({
          status: "applied",
          applied_at: "2026-07-29T12:00:02.000Z",
        })]);
      }
      throw new Error(`unexpected query: ${config.text}`);
    });
    const apply = vi.fn(async (executor: PostgreSqlQueryExecutor) => {
      await executor.query(
        { text: "SELECT effect" },
        { domain: "passive-events", operation: "effect" },
      );
      return "done";
    });
    const completed = await subject.completeApplied({
      claim: claim(),
      processId: "worker",
      fencingToken: 7n,
    }, apply);

    expect(completed.result).toBe("done");
    expect(completed.event.status).toBe("applied");
    expect(order).toEqual(["fence", "claim", "effect", "applied"]);
    expect(coordination.assertFence).toHaveBeenCalledWith({
      resourceType: "passive-events",
      resourceKey: MACHINE_ID,
      processId: "worker",
      operation: "replicate",
      fencingToken: 7n,
      signal: undefined,
    });
  });

  it("fails closed when the claimed row or transition cardinality changes", async () => {
    const absent = repository(async (config) =>
      config.text.includes("SELECT event.*")
        ? queryResult([])
        : queryResult([eventRow()]));
    await expect(absent.repository.completeApplied({
      claim: claim(),
      processId: "worker",
      fencingToken: 7n,
    }, async () => undefined)).rejects.toMatchObject(expectDataError("claimed_row"));

    const lost = repository(async (config) =>
      config.text.includes("SELECT event.*")
        ? queryResult([claimedEventRow()])
        : queryResult([]));
    await expect(lost.repository.completeApplied({
      claim: claim(),
      processId: "worker",
      fencingToken: 7n,
    }, async () => undefined)).rejects.toMatchObject(expectDataError("claimed_transition"));

    await expect(lost.repository.scheduleRetry({
      claim: claim(),
      processId: "worker",
      fencingToken: 7n,
      delayMs: 1,
    })).rejects.toMatchObject(expectDataError("claimed_transition"));
  });

  it("revalidates the complete locked claim snapshot before applying an effect", async () => {
    const apply = vi.fn(async () => undefined);
    const mismatched = repository(async () => queryResult([claimedEventRow()]));
    await expect(mismatched.repository.completeApplied({
      claim: claim({ payload: { sessionId: "forged" } }),
      processId: "worker",
      fencingToken: 7n,
    }, apply)).rejects.toMatchObject(expectDataError("claimed_snapshot"));
    expect(apply).not.toHaveBeenCalled();

    const wrongProject = repository(async () => queryResult([claimedEventRow()]));
    await expect(wrongProject.repository.completeApplied({
      claim: claim({ projectId: OTHER_MACHINE_ID }),
      processId: "worker",
      fencingToken: 7n,
    }, apply)).rejects.toMatchObject(expectDataError("project_id"));
    expect(wrongProject.execution.query.mock.calls.some(
      ([config]) => config.text.includes("SELECT event.*"),
    )).toBe(false);

    const impossibleState = repository(async () => queryResult([eventRow()]));
    await expect(impossibleState.repository.completeApplied({
      claim: claim(),
      processId: "worker",
      fencingToken: 7n,
    }, apply)).rejects.toMatchObject(expectDataError("claimed_row"));
    expect(apply).not.toHaveBeenCalled();
  });

  it("schedules retry and quarantine through fenced claimed transitions", async () => {
    const { repository: subject, execution } = repository(async (config) => {
      if (config.text.includes("SELECT event.*")) {
        return queryResult([claimedEventRow()]);
      }
      if (config.text.includes("status = 'retry'")) {
        return queryResult([eventRow({ status: "retry", attempt_count: 2 })]);
      }
      if (config.text.includes("status = 'quarantined'")) {
        return queryResult([eventRow({
          status: "quarantined",
          quarantined_at: "2026-07-29T12:00:03.000Z",
          quarantine_reason: "poison",
        })]);
      }
      throw new Error(`unexpected query: ${config.text}`);
    });
    await expect(subject.scheduleRetry({
      claim: claim(),
      processId: "worker",
      fencingToken: 7n,
      delayMs: -1,
    })).rejects.toThrow("non-negative");
    await expect(subject.scheduleRetry({
      claim: claim(),
      processId: "worker",
      fencingToken: 7n,
      delayMs: 250,
    })).resolves.toMatchObject({ status: "retry" });
    await expect(subject.quarantine({
      claim: claim(),
      processId: "worker",
      fencingToken: 7n,
      reason: " ",
    })).rejects.toMatchObject(expectDataError("quarantine_reason"));
    await expect(subject.quarantine({
      claim: claim(),
      processId: "worker",
      fencingToken: 7n,
      reason: "poison",
    })).resolves.toMatchObject({ status: "quarantined" });
    const retryUpdate = execution.query.mock.calls.find(
      ([config]) => config.text.includes("status = 'retry'"),
    );
    expect(retryUpdate?.[0].values?.at(-1)).toBe(250);
  });

  it("replays one exact quarantine and detects impossible cardinality", async () => {
    let rows = [eventRow()];
    const { repository: subject } = repository(async () => queryResult(rows));
    await expect(subject.replayQuarantined({
      machineId: MACHINE_ID,
      eventId: EVENT_ID,
    })).resolves.toMatchObject({ status: "pending" });
    rows = [];
    await expect(subject.replayQuarantined({
      machineId: MACHINE_ID,
      eventId: EVENT_ID,
    })).resolves.toBeNull();
    rows = [eventRow(), eventRow()];
    await expect(subject.replayQuarantined({
      machineId: MACHINE_ID,
      eventId: EVENT_ID,
    })).rejects.toMatchObject(expectDataError("replay_cardinality"));
  });

  it("lists bounded quarantines and prunes only exact applied identities", async () => {
    const quarantined = eventRow({
      status: "quarantined",
      quarantined_at: "2026-07-29T12:00:03.000Z",
      quarantine_reason: "poison",
    });
    const { repository: subject, execution } = repository(async (config) => {
      if (config.text.startsWith("SELECT *")) return queryResult([quarantined]);
      if (config.text.includes("DELETE FROM")) {
        return queryResult([], config.values?.[3] === EVENT_ID ? 1 : 0);
      }
      throw new Error(`unexpected query: ${config.text}`);
    });
    await expect(subject.listQuarantined(0)).rejects.toThrow("between 1 and 500");
    await expect(subject.listQuarantined(501)).rejects.toThrow("between 1 and 500");
    await expect(subject.listQuarantined(10))
      .resolves.toEqual([expect.objectContaining({ status: "quarantined" })]);
    await expect(subject.pruneApplied([
      { machineId: MACHINE_ID, eventId: EVENT_ID, inboxId: 41n },
      { machineId: OTHER_MACHINE_ID, eventId: SECOND_EVENT_ID, inboxId: 42n },
    ])).resolves.toBe(1n);
    expect(execution.query.mock.calls.find(
      ([config]) => config.text.includes("DELETE FROM"),
    )?.[0].text).toContain("status = 'applied'");

    const nullableCount = repository(async (config) => {
      if (config.text.includes("DELETE FROM")) {
        return { ...queryResult([]), rowCount: null };
      }
      return queryResult([]);
    });
    await expect(nullableCount.repository.pruneApplied([
      { machineId: MACHINE_ID, eventId: EVENT_ID, inboxId: 41n },
    ])).resolves.toBe(0n);
  });

  it("uses a savepoint inside an active transaction and rejects ambiguous scope", async () => {
    const active = executors(async () => queryResult([]));
    const nested = new PostgreSqlPassiveEventRepository(
      active.scope,
      PROJECT_ID,
      MACHINE_ID,
    );
    await expect(nested.replayQuarantined({
      machineId: MACHINE_ID,
      eventId: EVENT_ID,
    })).resolves.toBeNull();
    expect(active.savepoint).toHaveBeenCalledOnce();

    const signal = new AbortController().signal;
    const transactional = repository(async () => queryResult([]));
    await expect(transactional.repository.replayQuarantined({
      machineId: MACHINE_ID,
      eventId: EVENT_ID,
    }, signal)).resolves.toBeNull();
    expect(transactional.execution.transaction.mock.calls[0]?.[1])
      .toMatchObject({ signal });

    const invalid = new PostgreSqlPassiveEventRepository(
      { query: vi.fn() } as unknown as PostgreSqlPassiveEventRepositoryExecutor,
      PROJECT_ID,
      MACHINE_ID,
    );
    await expect(invalid.replayQuarantined({
      machineId: MACHINE_ID,
      eventId: EVENT_ID,
    })).rejects.toMatchObject({
      code: "STORAGE_TRANSACTION_SCOPE",
      domain: "passive-events",
      operation: "replayQuarantined",
    });
  });

  it("exposes structured data errors for operator diagnostics", () => {
    const error = new PostgreSqlPassiveEventDataError(
      PROJECT_ID,
      "payload",
      EVENT_ID,
    );
    expect(error).toMatchObject({
      name: "PostgreSqlPassiveEventDataError",
      field: "payload",
      eventId: EVENT_ID,
      projectId: PROJECT_ID,
    });
  });
});
