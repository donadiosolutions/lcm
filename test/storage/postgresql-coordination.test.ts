import type {
  QueryConfig,
  QueryResult,
  QueryResultRow,
} from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlQueryOptions,
  PostgreSqlTransactionScopeExecutor,
} from "../../src/storage/postgresql/contracts.js";
import {
  derivePostgreSqlAdvisoryLockName,
  PostgreSqlCoordinationDataError,
  type PostgreSqlCoordinationExecutor,
  PostgreSqlCoordinationOperationError,
  PostgreSqlLeaseFenceError,
  PostgreSqlWorkCoordinator,
} from "../../src/storage/postgresql/coordination.js";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";
import { StorageOperationError } from "../../src/storage/errors.js";

const projectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const machineId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
const otherMachineId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9022";
const eventId = "218f22c4-6d2a-4f10-8a4c-6b8d3e5f9023";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

type QueryImplementation = (
  config: QueryConfig<unknown[]>,
  options: PostgreSqlQueryOptions,
) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>;

function rootExecutor(implementation: QueryImplementation): {
  readonly executor: PostgreSqlCoordinationExecutor;
  readonly query: ReturnType<typeof vi.fn>;
  readonly transaction: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(implementation);
  const transaction = vi.fn(async (
    callback: Parameters<PostgreSqlCoordinationExecutor["transaction"]>[0],
  ) => callback({
    transactionScope: "active",
    query,
    savepoint: async (inner) => inner({ query }),
  }));
  return {
    executor: { query, transaction },
    query,
    transaction,
  };
}

function scopedExecutor(implementation: QueryImplementation): {
  readonly executor: PostgreSqlTransactionScopeExecutor;
  readonly query: ReturnType<typeof vi.fn>;
  readonly savepoint: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(implementation);
  const savepoint = vi.fn(async (
    callback: Parameters<PostgreSqlTransactionScopeExecutor["savepoint"]>[0],
  ) => callback({ query }));
  return {
    executor: {
      transactionScope: "active",
      query,
      savepoint,
    },
    query,
    savepoint,
  };
}

const leaseRow = {
  project_id: projectId,
  resource_type: "conversation",
  resource_key: "41",
  owner_machine_id: machineId,
  owner_process_id: "worker-1",
  operation: "compact",
  fencing_token: "9007199254740993",
  acquired_at: new Date("2026-07-29T10:00:00.000Z"),
  renewed_at: "2026-07-29T10:00:01.000Z",
  expires_at: "2026-07-29T10:01:01.000Z",
  released_at: null,
};

const eventRow = {
  inbox_id: "9007199254740994",
  project_id: projectId,
  machine_id: otherMachineId,
  event_id: eventId,
  event_version: 1,
  machine_sequence: 0n,
  event_type: "prompt",
  payload: { content: "scrubbed" },
  attempt_count: 2,
  received_at: new Date("2026-07-29T10:00:00.000Z"),
  next_attempt_at: "2026-07-29T10:00:01.000Z",
  claimed_at: "2026-07-29T10:00:02.000Z",
  claimed_by: "drain-1",
};

function coordinator(
  implementation: QueryImplementation,
): ReturnType<typeof rootExecutor> & { readonly repository: PostgreSqlWorkCoordinator } {
  const harness = rootExecutor(implementation);
  return {
    ...harness,
    repository: new PostgreSqlWorkCoordinator(
      harness.executor,
      projectId,
      machineId,
    ),
  };
}

describe("PostgreSQL work coordination", () => {
  it("derives trigger-compatible deterministic project lock names", () => {
    expect(
      derivePostgreSqlAdvisoryLockName(
        projectId.toUpperCase(),
        "conversation",
        "session-a",
      ),
    ).toBe(
      `${projectId}:conversation:` +
      "fa57a52dbf08190218529730a3e99db6946c6c29220fb6e0551e21598b0b05db",
    );
    expect(
      derivePostgreSqlAdvisoryLockName(
        projectId,
        "redaction-counters",
      ),
    ).toBe(`${projectId}:redaction-counters`);
    expect(
      derivePostgreSqlAdvisoryLockName(projectId, "queue", "a:b"),
    ).not.toBe(
      derivePostgreSqlAdvisoryLockName(projectId, "queue", "a") + ":b",
    );
  });

  it("rejects invalid constructor identities without database access", () => {
    const db = rootExecutor(() => result([]));
    expect(() => new PostgreSqlWorkCoordinator(
      db.executor,
      "not-a-uuid",
      machineId,
    )).toThrow(PostgreSqlCoordinationDataError);
    expect(() => new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      "018f22c4-6d2a-6f10-8a4c-6b8d3e5f9021",
    )).toThrow(PostgreSqlCoordinationDataError);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("takes only a transaction advisory lock and restores lock_timeout", async () => {
    const signal = new AbortController().signal;
    const db = scopedExecutor((config, options) => {
      expect(options).toMatchObject({
        domain: "coordination",
        operation: "compact",
        projectId,
      });
      if (config.values?.[0] === "2s") {
        expect(options).not.toHaveProperty("signal");
      } else {
        expect(options.signal).toBe(signal);
      }
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "READ COMMITTED" }]);
      }
      if (config.text.includes("current_setting('lock_timeout')")) {
        return result([{ setting: "2s" }]);
      }
      return result([]);
    });
    const repository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    const lock = await repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "41",
      operation: "compact",
      timeoutMs: 750,
      signal,
    });

    const lockName = derivePostgreSqlAdvisoryLockName(
      projectId,
      "conversation",
      "41",
    );
    expect(lock).toEqual({
      projectId,
      machineId,
      resourceType: "conversation",
      resourceKey: "41",
      operation: "compact",
      lockName,
    });
    expect(db.query).toHaveBeenCalledTimes(5);
    expect(db.query.mock.calls[2][0]).toMatchObject({ values: ["750ms"] });
    expect(db.query.mock.calls[3][0]).toMatchObject({ values: [lockName] });
    expect(db.query.mock.calls[3][0].text).toContain(
      "pg_advisory_xact_lock",
    );
    expect(db.query.mock.calls[3][0].text).not.toMatch(
      /pg_advisory_lock\(/u,
    );
    expect(db.query.mock.calls[4][0]).toMatchObject({ values: ["2s"] });
    expect(db.savepoint).toHaveBeenCalledOnce();
  });

  it("serializes concurrent lock-timeout lifecycles per transaction", async () => {
    const events: string[] = [];
    let setting = "7s";
    let reportFirstLock!: () => void;
    let releaseFirstLock!: () => void;
    const firstLockStarted = new Promise<void>((resolve) => {
      reportFirstLock = resolve;
    });
    const firstLockReleased = new Promise<void>((resolve) => {
      releaseFirstLock = resolve;
    });
    const db = scopedExecutor(async (config, options) => {
      if (config.text.includes("transaction_isolation")) {
        events.push(`${options.operation}:isolation`);
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("current_setting('lock_timeout')")) {
        events.push(`${options.operation}:read:${setting}`);
        return result([{ setting }]);
      }
      if (config.text.includes("set_config")) {
        setting = String(config.values?.[0]);
        events.push(`${options.operation}:set:${setting}`);
        return result([]);
      }
      if (config.text.includes("pg_advisory_xact_lock")) {
        events.push(`${options.operation}:lock:${setting}`);
        if (options.operation === "first-lock") {
          reportFirstLock();
          await firstLockReleased;
        }
        return result([]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const firstRepository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    const secondRepository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    const first = firstRepository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "first",
      operation: "first-lock",
      timeoutMs: 40,
    });
    await firstLockStarted;
    const second = secondRepository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "second",
      operation: "second-lock",
      timeoutMs: 900,
    });
    await Promise.resolve();
    expect(events.some((event) => event.startsWith("second-lock:"))).toBe(
      false,
    );
    releaseFirstLock();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(events).toEqual([
      "first-lock:isolation",
      "first-lock:read:7s",
      "first-lock:set:40ms",
      "first-lock:lock:40ms",
      "first-lock:set:7s",
      "second-lock:isolation",
      "second-lock:read:7s",
      "second-lock:set:900ms",
      "second-lock:lock:900ms",
      "second-lock:set:7s",
    ]);
    expect(setting).toBe("7s");
  });

  it("cancels queued lock lifecycles without releasing later callers", async () => {
    let reportFirstLock!: () => void;
    let releaseFirstLock!: () => void;
    const firstLockStarted = new Promise<void>((resolve) => {
      reportFirstLock = resolve;
    });
    const firstLockReleased = new Promise<void>((resolve) => {
      releaseFirstLock = resolve;
    });
    const queriedOperations: string[] = [];
    const db = scopedExecutor(async (config, options) => {
      queriedOperations.push(options.operation);
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("current_setting('lock_timeout')")) {
        return result([{ setting: "0" }]);
      }
      if (
        config.text.includes("pg_advisory_xact_lock")
        && options.operation === "first-lock"
      ) {
        reportFirstLock();
        await firstLockReleased;
        throw new Error("first lock failed");
      }
      return result([]);
    });
    const repository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    const first = repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "first",
      operation: "first-lock",
      timeoutMs: 100,
    });
    await firstLockStarted;
    const cancellation = new AbortController();
    const cancelled = repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "cancelled",
      operation: "cancelled-lock",
      timeoutMs: 100,
      signal: cancellation.signal,
    });
    await Promise.resolve();
    cancellation.abort();
    await expect(cancelled).rejects.toMatchObject({
      machineId,
      operation: "cancelled-lock",
      retryable: false,
    });
    const later = repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "later",
      operation: "later-lock",
      timeoutMs: 100,
    });
    await Promise.resolve();
    expect(queriedOperations).not.toContain("cancelled-lock");
    expect(queriedOperations).not.toContain("later-lock");
    releaseFirstLock();
    await expect(first).rejects.toMatchObject({
      machineId,
      operation: "first-lock",
      retryable: false,
    });
    await expect(later).resolves.toMatchObject({ operation: "later-lock" });

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "already-cancelled",
      operation: "already-cancelled-lock",
      timeoutMs: 100,
      signal: alreadyCancelled.signal,
    })).rejects.toMatchObject({
      machineId,
      operation: "already-cancelled-lock",
      retryable: false,
    });
    expect(queriedOperations).not.toContain("already-cancelled-lock");
  });

  it("requires transaction scope for locks and final fence checks", async () => {
    const { repository } = coordinator(() => result([]));
    await expect(repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "41",
      operation: "compact",
      timeoutMs: 100,
    })).rejects.toMatchObject({
      code: "STORAGE_TRANSACTION_SCOPE",
      projectId,
      domain: "coordination",
    });
    await expect(repository.assertLeaseFence({
      resourceType: "conversation",
      resourceKey: "41",
      processId: "worker-1",
      operation: "compact",
      fencingToken: 1n,
    })).rejects.toBeInstanceOf(StorageOperationError);
  });

  it.each([
    [{ resourceType: "", resourceKey: "41", operation: "compact", timeoutMs: 1 }, "resource_type"],
    [{ resourceType: "bad:namespace", resourceKey: "41", operation: "compact", timeoutMs: 1 }, "resource_type"],
    [{ resourceType: "conversation", resourceKey: "", operation: "compact", timeoutMs: 1 }, "resource_key"],
    [{ resourceType: "conversation", resourceKey: "41", operation: "", timeoutMs: 1 }, "operation"],
    [{ resourceType: "conversation", resourceKey: "41", operation: "compact", timeoutMs: 0 }, "timeout_ms"],
    [{ resourceType: "conversation", resourceKey: "41", operation: "compact", timeoutMs: Number.NaN }, "timeout_ms"],
  ] as const)("rejects invalid transaction-lock input %#", async (input, field) => {
    const db = scopedExecutor(() => result([]));
    const repository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    await expect(repository.acquireTransactionLock(input)).rejects.toMatchObject({
      field,
      machineId,
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    ["nul\u0000", "resource_key"],
    ["unpaired-high-\ud800", "resource_key"],
    ["unpaired-low-\udfff", "resource_key"],
  ])("rejects unsafe PostgreSQL text input %#", async (resourceKey, field) => {
    const db = scopedExecutor(() => result([]));
    const repository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    await expect(repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey,
      operation: "compact",
      timeoutMs: 100,
    })).rejects.toMatchObject({ field, machineId });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("accepts valid surrogate pairs in advisory-lock resource keys", async () => {
    const db = scopedExecutor((config) => {
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("current_setting('lock_timeout')")) {
        return result([{ setting: "0" }]);
      }
      return result([]);
    });
    const repository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    const resourceKey = "emoji-\ud83d\ude00";
    await expect(repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey,
      operation: "compact",
      timeoutMs: 100,
    })).resolves.toMatchObject({
      lockName: derivePostgreSqlAdvisoryLockName(
        projectId,
        "conversation",
        resourceKey,
      ),
    });
  });

  it("fails closed for malformed or stronger transaction isolation", async () => {
    for (const transactionIsolation of [null, "repeatable read"]) {
      const db = scopedExecutor((config) => config.text.includes(
        "transaction_isolation",
      )
        ? result([{ transaction_isolation: transactionIsolation }])
        : result([]));
      const repository = new PostgreSqlWorkCoordinator(
        db.executor,
        projectId,
        machineId,
      );
      await expect(repository.acquireTransactionLock({
        resourceType: "conversation",
        resourceKey: "41",
        operation: "compact",
        timeoutMs: 100,
      })).rejects.toMatchObject({ field: "transaction_isolation" });
    }
  });

  it("fails closed for malformed lock-timeout readback", async () => {
    const db = scopedExecutor((config) => {
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      return result([{ setting: null }]);
    });
    const repository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    await expect(repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "41",
      operation: "compact",
      timeoutMs: 100,
    })).rejects.toMatchObject({ field: "lock_timeout" });
  });

  it.each([
    [new Error("driver detail"), false],
    [
      new StorageOperationError(
        "STORAGE_OPERATION_FAILED",
        "postgresql",
        projectId,
        "coordination",
        "compact",
        { retryable: true },
      ),
      true,
    ],
    [
      new PostgreSqlStorageOperationError(
        "STORAGE_OPERATION_FAILED",
        {
          domain: "coordination",
          operation: "compact",
          projectId,
          machineId,
        },
        "55P03",
        false,
      ),
      true,
    ],
    [
      new PostgreSqlStorageOperationError(
        "STORAGE_OPERATION_FAILED",
        {
          domain: "coordination",
          operation: "compact",
          projectId,
          machineId,
        },
        "57014",
        false,
      ),
      false,
    ],
    [
      new PostgreSqlStorageOperationError(
        "STORAGE_OPERATION_FAILED",
        {
          domain: "coordination",
          operation: "compact",
          projectId,
          machineId,
        },
        "22023",
        false,
      ),
      false,
    ],
  ])("sanitizes lock failures with machine context %#", async (
    failure,
    retryable,
  ) => {
    const db = scopedExecutor((config) => {
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("current_setting('lock_timeout')")) {
        return result([{ setting: "0" }]);
      }
      if (config.text.includes("pg_advisory_xact_lock")) throw failure;
      return result([]);
    });
    const repository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    const error = await repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "secret-resource",
      operation: "compact",
      timeoutMs: 100,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PostgreSqlCoordinationOperationError);
    if (!(error instanceof PostgreSqlCoordinationOperationError)) {
      throw new Error("expected sanitized coordination operation error");
    }
    expect(error.toJSON()).toMatchObject({
      projectId,
      machineId,
      operation: "compact",
      retryable,
    });
    expect(JSON.stringify(error)).not.toContain("secret-resource");
    expect(JSON.stringify(error)).not.toContain("driver detail");
    expect(db.query.mock.calls.at(-1)?.[0]).toMatchObject({ values: ["0"] });
  });

  it("preserves lock failures when timeout restoration also fails", async () => {
    const lockFailure = new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "coordination",
      "compact",
      { retryable: true },
    );
    const db = scopedExecutor((config) => {
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("current_setting('lock_timeout')")) {
        return result([{ setting: "3s" }]);
      }
      if (config.text.includes("pg_advisory_xact_lock")) throw lockFailure;
      if (config.values?.[0] === "3s") {
        throw new Error("restore detail");
      }
      return result([]);
    });
    const repository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    await expect(repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "secret-resource",
      operation: "compact",
      timeoutMs: 100,
    })).rejects.toMatchObject({
      machineId,
      retryable: true,
    });
    expect(db.query.mock.calls.at(-1)?.[0]).toMatchObject({ values: ["3s"] });
  });

  it("sanitizes timeout restoration failures after lock acquisition", async () => {
    const db = scopedExecutor((config) => {
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("current_setting('lock_timeout')")) {
        return result([{ setting: "4s" }]);
      }
      if (config.values?.[0] === "4s") {
        throw new StorageOperationError(
          "STORAGE_OPERATION_FAILED",
          "postgresql",
          projectId,
          "coordination",
          "compact",
          { retryable: true },
        );
      }
      return result([]);
    });
    const repository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    await expect(repository.acquireTransactionLock({
      resourceType: "conversation",
      resourceKey: "secret-resource",
      operation: "compact",
      timeoutMs: 100,
    })).rejects.toMatchObject({
      machineId,
      retryable: true,
    });
    expect(db.query.mock.calls.at(-1)?.[0]).toMatchObject({ values: ["4s"] });
  });

  it("acquires, renews, and releases exact bigint fenced leases", async () => {
    const db = coordinator((config, options) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        return result([]);
      }
      if (config.text.includes("SELECT 1 AS locked")) {
        return options.operation === "acquireLease"
          ? result([])
          : result([{ locked: 1 }]);
      }
      if (config.text.includes("INSERT INTO lcm.fenced_leases")) {
        return result([leaseRow]);
      }
      if (config.text.includes("SET acquired_at")) {
        return result([leaseRow]);
      }
      if (config.text.includes("SET renewed_at")) {
        return result([{
          ...leaseRow,
          renewed_at: "2026-07-29T10:00:02.000Z",
          expires_at: "2026-07-29T10:01:02.000Z",
        }]);
      }
      if (config.text.includes("SET released_at")) {
        return result([{
          ...leaseRow,
          released_at: "2026-07-29T10:00:03.000Z",
        }]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });

    const acquired = await db.repository.acquireLease({
      resourceType: "conversation",
      resourceKey: "41",
      processId: "worker-1",
      operation: "compact",
      ttlMs: 60_000,
    });
    expect(acquired).toEqual({
      projectId,
      resourceType: "conversation",
      resourceKey: "41",
      machineId,
      processId: "worker-1",
      operation: "compact",
      fencingToken: 9007199254740993n,
      acquiredAt: "2026-07-29T10:00:00.000Z",
      renewedAt: "2026-07-29T10:00:01.000Z",
      expiresAt: "2026-07-29T10:01:01.000Z",
      releasedAt: null,
    });
    const acquireQuery = db.query.mock.calls.find(
      ([config]) => config.text.includes("INSERT INTO lcm.fenced_leases"),
    )?.[0];
    expect(acquireQuery.text).toContain("DO NOTHING");
    expect(acquireQuery.text).toContain("statement_timestamp()");
    expect(acquireQuery.values).toEqual([
      projectId,
      "conversation",
      "41",
      machineId,
      "worker-1",
      "compact",
      60_000,
    ]);

    const renewed = await db.repository.renewLease({
      resourceType: "conversation",
      resourceKey: "41",
      processId: "worker-1",
      operation: "compact",
      fencingToken: acquired!.fencingToken,
      ttlMs: 60_000,
    });
    expect(renewed?.renewedAt).toBe("2026-07-29T10:00:02.000Z");

    const released = await db.repository.releaseLease({
      resourceType: "conversation",
      resourceKey: "41",
      processId: "worker-1",
      operation: "compact",
      fencingToken: acquired!.fencingToken,
    });
    expect(released?.releasedAt).toBe("2026-07-29T10:00:03.000Z");
    expect(db.transaction).toHaveBeenCalledTimes(3);
  });

  it("takes over only after locking an existing lease row", async () => {
    const db = coordinator((config) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        return result([]);
      }
      if (config.text.includes("SELECT 1 AS locked")) {
        return result([{ locked: 1 }]);
      }
      if (config.text.includes("SET owner_machine_id")) {
        return result([leaseRow]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(db.repository.acquireLease({
      resourceType: "conversation",
      resourceKey: "41",
      processId: "worker-1",
      operation: "compact",
      ttlMs: 60_000,
    })).resolves.toMatchObject({ fencingToken: 9007199254740993n });
    expect(db.query.mock.calls[1][0].text).toContain("FOR UPDATE");
    expect(db.query.mock.calls[2][0].text).toContain(
      "expires_at <= pg_catalog.statement_timestamp()",
    );
    expect(db.query.mock.calls[2][0].text).toContain(
      "fencing_token = DEFAULT",
    );
  });

  it("fails closed for malformed lease acquisition write shapes", async () => {
    const input = {
      resourceType: "conversation",
      resourceKey: "41",
      processId: "worker-1",
      operation: "compact",
      ttlMs: 60_000,
    };
    const duplicateInsert = coordinator((config) => {
      if (config.text.includes("SELECT 1 AS locked")) return result([]);
      if (config.text.includes("INSERT INTO lcm.fenced_leases")) {
        return result([leaseRow, leaseRow]);
      }
      return result([]);
    });
    await expect(
      duplicateInsert.repository.acquireLease(input),
    ).rejects.toMatchObject({ field: "inserted_lease" });

    const missingRefresh = coordinator((config) => {
      if (config.text.includes("SELECT 1 AS locked")) return result([]);
      if (config.text.includes("INSERT INTO lcm.fenced_leases")) {
        return result([leaseRow]);
      }
      return result([]);
    });
    await expect(
      missingRefresh.repository.acquireLease(input),
    ).rejects.toMatchObject({ field: "inserted_lease" });

    const duplicateTakeover = coordinator((config) => {
      if (config.text.includes("SELECT 1 AS locked")) {
        return result([{ locked: 1 }]);
      }
      if (config.text.includes("SET owner_machine_id")) {
        return result([leaseRow, leaseRow]);
      }
      return result([]);
    });
    await expect(
      duplicateTakeover.repository.acquireLease(input),
    ).rejects.toMatchObject({ field: "lease" });

    const activeLease = coordinator((config) =>
      config.text.includes("SELECT 1 AS locked")
        ? result([{ locked: 1 }])
        : result([]));
    await expect(
      activeLease.repository.acquireLease(input),
    ).resolves.toBeNull();
  });

  it("fails closed if an exact lease lock returns duplicate rows", async () => {
    const db = coordinator((config) =>
      config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
        ? result([])
        : result([{ locked: 1 }, { locked: 1 }]));
    await expect(db.repository.acquireLease({
      resourceType: "conversation",
      resourceKey: "41",
      processId: "worker-1",
      operation: "compact",
      ttlMs: 60_000,
    })).rejects.toMatchObject({ field: "lease_lock", machineId });
  });

  it("returns null when acquire, renew, or release loses ownership", async () => {
    let renewalLockAttempts = 0;
    const db = coordinator((config, options) => {
      if (
        config.text.includes("SELECT 1 AS locked")
        && options.operation === "renewLease"
      ) {
        renewalLockAttempts += 1;
        return renewalLockAttempts === 1
          ? result([])
          : result([{ locked: 1 }]);
      }
      return result([]);
    });
    await expect(db.repository.acquireLease({
      resourceType: "summary",
      resourceKey: "s1",
      processId: "worker",
      operation: "promote",
      ttlMs: 1,
    })).resolves.toBeNull();
    await expect(db.repository.renewLease({
      resourceType: "summary",
      resourceKey: "s1",
      processId: "worker",
      operation: "promote",
      fencingToken: 1n,
      ttlMs: 1,
    })).resolves.toBeNull();
    await expect(db.repository.renewLease({
      resourceType: "summary",
      resourceKey: "s1",
      processId: "worker",
      operation: "promote",
      fencingToken: 1n,
      ttlMs: 1,
    })).resolves.toBeNull();
    await expect(db.repository.releaseLease({
      resourceType: "summary",
      resourceKey: "s1",
      processId: "worker",
      operation: "promote",
      fencingToken: 1n,
    })).resolves.toBeNull();
  });

  it.each([
    [{ resourceType: "", resourceKey: "key", processId: "p", operation: "o", ttlMs: 1 }, "resource_type"],
    [{ resourceType: "type", resourceKey: "", processId: "p", operation: "o", ttlMs: 1 }, "resource_key"],
    [{ resourceType: "type", resourceKey: "key", processId: "", operation: "o", ttlMs: 1 }, "owner_process_id"],
    [{ resourceType: "type", resourceKey: "key", processId: "p", operation: "", ttlMs: 1 }, "lease_operation"],
    [{ resourceType: "type", resourceKey: "key", processId: "p", operation: "o", ttlMs: 0 }, "ttl_ms"],
  ] as const)("validates every lease acquisition field %#", async (input, field) => {
    const db = coordinator(() => result([]));
    await expect(db.repository.acquireLease(input)).rejects.toMatchObject({
      field,
      machineId,
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each([
    [{ resourceType: "", resourceKey: "key", processId: "p", operation: "o", fencingToken: 1n }, "resource_type"],
    [{ resourceType: "type", resourceKey: "key", processId: "", operation: "o", fencingToken: 1n }, "owner_process_id"],
    [{ resourceType: "type", resourceKey: "key", processId: "p", operation: "", fencingToken: 1n }, "lease_operation"],
    [{ resourceType: "type", resourceKey: "key", processId: "p", operation: "o", fencingToken: 0n }, "fencing_token"],
  ] as const)("validates every lease mutation field %#", async (input, field) => {
    const db = coordinator(() => result([]));
    await expect(db.repository.releaseLease(input)).rejects.toMatchObject({
      field,
      machineId,
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("keeps the exact fence row locked inside an active transaction", async () => {
    const signal = new AbortController().signal;
    const db = scopedExecutor((config, options) => {
      expect(options.signal).toBe(signal);
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("SELECT 1 AS locked")) {
        return result([{ locked: 1 }]);
      }
      return result([{
        fencing_token: "9007199254740993",
        validated_at: "2026-07-29T10:00:02.000Z",
      }]);
    });
    const repository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    await expect(repository.assertLeaseFence({
      resourceType: "conversation",
      resourceKey: "41",
      processId: "worker-1",
      operation: "compact",
      fencingToken: 9007199254740993n,
      signal,
    })).resolves.toEqual({
      projectId,
      machineId,
      resourceType: "conversation",
      resourceKey: "41",
      processId: "worker-1",
      operation: "compact",
      fencingToken: 9007199254740993n,
      validatedAt: "2026-07-29T10:00:02.000Z",
    });
    expect(db.query.mock.calls[1][0].text).toContain("FOR UPDATE");
    expect(db.query.mock.calls[2][0].text).toContain(
      "statement_timestamp() AS validated_at",
    );
    expect(db.query.mock.calls[2][0].text).toContain("FOR UPDATE");
    expect(db.savepoint).not.toHaveBeenCalled();
  });

  it("rejects missing and mismatched final fences safely", async () => {
    for (const rows of [[], [{ fencing_token: "2" }]]) {
      const db = scopedExecutor((config) =>
        config.text.includes("transaction_isolation")
          ? result([{ transaction_isolation: "read committed" }])
          : config.text.includes("SELECT 1 AS locked")
            ? result([{ locked: 1 }])
            : result(rows));
      const repository = new PostgreSqlWorkCoordinator(
        db.executor,
        projectId,
        machineId,
      );
      await expect(repository.assertLeaseFence({
        resourceType: "conversation",
        resourceKey: "41",
        processId: "worker-1",
        operation: "compact",
        fencingToken: 1n,
      })).rejects.toBeInstanceOf(PostgreSqlLeaseFenceError);
    }
    const missing = scopedExecutor((config) =>
      config.text.includes("transaction_isolation")
        ? result([{ transaction_isolation: "read committed" }])
        : result([]));
    await expect(new PostgreSqlWorkCoordinator(
      missing.executor,
      projectId,
      machineId,
    ).assertLeaseFence({
      resourceType: "conversation",
      resourceKey: "41",
      processId: "worker-1",
      operation: "compact",
      fencingToken: 1n,
    })).rejects.toBeInstanceOf(PostgreSqlLeaseFenceError);
  });

  it("lists active, expired, and released lease diagnostics", async () => {
    const db = coordinator((config) => {
      if (config.text.includes("FROM lcm.fenced_leases")) {
        return result([
          { ...leaseRow, state: "active" },
          { ...leaseRow, resource_key: "42", state: "expired" },
          {
            ...leaseRow,
            resource_key: "43",
            released_at: "2026-07-29T10:00:03.000Z",
            state: "released",
          },
        ]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const diagnostics = await db.repository.listLeases(3);
    expect(diagnostics.map((lease) => lease.state)).toEqual([
      "active",
      "expired",
      "released",
    ]);
    expect(db.query.mock.calls[0][0]).toMatchObject({
      values: [projectId, 3],
    });
  });

  it("rejects malformed lease states and invalid diagnostic limits", async () => {
    const malformed = coordinator(() => result([
      { ...leaseRow, state: "unknown" },
    ]));
    await expect(malformed.repository.listLeases(1)).rejects.toMatchObject({
      field: "state",
    });
    await expect(malformed.repository.listLeases(0)).rejects.toMatchObject({
      field: "limit",
    });
  });

  it("cleans only a bounded retained lease batch and returns bigint counts", async () => {
    const db = coordinator((config) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        return result([]);
      }
      expect(config.text).toContain("FOR UPDATE SKIP LOCKED");
      expect(config.text).not.toContain("TRUNCATE");
      return result([{ count: "9007199254740993" }]);
    });
    await expect(db.repository.cleanupLeases({
      retentionMs: 30_000,
      limit: 50,
    })).resolves.toEqual({
      projectId,
      deletedCount: 9007199254740993n,
    });
    expect(db.query.mock.calls[1][0]).toMatchObject({
      values: [projectId, 30_000, 50],
    });
  });

  it.each([
    [{ retentionMs: 0, limit: 1 }, "retention_ms"],
    [{ retentionMs: 1, limit: 0 }, "limit"],
  ] as const)("validates lease cleanup input %#", async (input, field) => {
    const db = coordinator(() => result([]));
    await expect(db.repository.cleanupLeases(input)).rejects.toMatchObject({
      field,
    });
  });

  it("claims one ordered queue head per machine with stale recovery", async () => {
    const signal = new AbortController().signal;
    const db = coordinator((config, options) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        return result([]);
      }
      expect(options.signal).toBe(signal);
      expect(config.text).toContain("FOR UPDATE OF event SKIP LOCKED");
      expect(config.text).toContain("NOT EXISTS");
      expect(config.text).toContain("earlier.machine_sequence <");
      expect(config.text).toContain("event.status = 'claimed'");
      return result([eventRow]);
    });
    const claims = await db.repository.claimPassiveEvents({
      claimOwner: "drain-1",
      limit: 10,
      staleClaimMs: 30_000,
      signal,
    });
    expect(claims).toEqual([{
      inboxId: 9007199254740994n,
      projectId,
      machineId: otherMachineId,
      eventId,
      eventVersion: 1,
      machineSequence: 0n,
      eventType: "prompt",
      payload: { content: "scrubbed" },
      attemptCount: 2,
      receivedAt: "2026-07-29T10:00:00.000Z",
      nextAttemptAt: "2026-07-29T10:00:01.000Z",
      claimedAt: "2026-07-29T10:00:02.000Z",
      claimedBy: "drain-1",
    }]);
    expect(db.query.mock.calls[1][0]).toMatchObject({
      values: [projectId, "drain-1", 10, 30_000],
    });
  });

  it("returns an empty queue batch without inventing work", async () => {
    const db = coordinator((config) =>
      config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
        ? result([])
        : result([]));
    await expect(db.repository.claimPassiveEvents({
      claimOwner: "drain",
      limit: 1,
      staleClaimMs: 1,
    })).resolves.toEqual([]);
  });

  it.each([
    [{ claimOwner: "", limit: 1, staleClaimMs: 1 }, "claim_owner"],
    [{ claimOwner: "drain", limit: 0, staleClaimMs: 1 }, "limit"],
    [{ claimOwner: "drain", limit: 1, staleClaimMs: 0 }, "stale_claim_ms"],
  ] as const)("validates passive-event claim input %#", async (input, field) => {
    const db = coordinator(() => result([]));
    await expect(db.repository.claimPassiveEvents(input)).rejects.toMatchObject({
      field,
    });
  });

  it.each([
    [{ ...eventRow, event_version: "1" }, "event_version"],
    [{ ...eventRow, attempt_count: "1" }, "attempt_count"],
    [{ ...eventRow, event_version: 0 }, "event_version"],
    [{ ...eventRow, attempt_count: -1 }, "attempt_count"],
    [{ ...eventRow, inbox_id: 1 }, "inbox_id"],
    [{ ...eventRow, received_at: null }, "received_at"],
    [{ ...eventRow, received_at: "not-a-timestamp" }, "received_at"],
    [{ ...eventRow, payload: [] }, "payload"],
  ])("fails closed for malformed passive-event row %#", async (row, field) => {
    const db = coordinator((config) =>
      config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
        ? result([])
        : result([row]));
    await expect(db.repository.claimPassiveEvents({
      claimOwner: "drain",
      limit: 1,
      staleClaimMs: 1,
    })).rejects.toMatchObject({ field, machineId: otherMachineId });
  });

  it("returns project-scoped lease and queue diagnostics with exact counts", async () => {
    const db = coordinator(() => result([{
      active_leases: "1",
      expired_leases: 2n,
      released_leases: "3",
      oldest_active_expiry_at: new Date("2026-07-29T10:01:00.000Z"),
      pending_events: "4",
      claimed_events: "5",
      retry_events: "6",
      applied_events: "7",
      quarantined_events: "8",
      oldest_ready_at: null,
      oldest_claimed_at: "2026-07-29T10:00:00.000Z",
    }]));
    await expect(db.repository.getCoordinationDiagnostics()).resolves.toEqual({
      leases: {
        active: 1n,
        expired: 2n,
        released: 3n,
        oldestActiveExpiryAt: "2026-07-29T10:01:00.000Z",
      },
      queue: {
        pending: 4n,
        claimed: 5n,
        retry: 6n,
        applied: 7n,
        quarantined: 8n,
        oldestReadyAt: null,
        oldestClaimedAt: "2026-07-29T10:00:00.000Z",
      },
    });
    expect(db.query.mock.calls[0][0]).toMatchObject({ values: [projectId] });
  });

  it("fails closed unless diagnostics return exactly one aggregate row", async () => {
    for (const rows of [[], [{}, {}]]) {
      const db = coordinator(() => result(rows));
      await expect(
        db.repository.getCoordinationDiagnostics(),
      ).rejects.toMatchObject({ field: "diagnostics" });
    }
  });

  it("uses the active savepoint for composable lease work", async () => {
    const db = scopedExecutor((config) => {
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("INSERT INTO lcm.fenced_leases")) {
        return result([leaseRow]);
      }
      if (config.text.includes("SET acquired_at")) {
        return result([leaseRow]);
      }
      return result([]);
    });
    const repository = new PostgreSqlWorkCoordinator(
      db.executor,
      projectId,
      machineId,
    );
    await expect(repository.acquireLease({
      resourceType: "conversation",
      resourceKey: "41",
      processId: "worker-1",
      operation: "compact",
      ttlMs: 100,
    })).resolves.toMatchObject({ fencingToken: 9007199254740993n });
    expect(db.savepoint).toHaveBeenCalledOnce();
  });

  it("serializes coordination errors without raw resource values", () => {
    const error = new PostgreSqlCoordinationDataError(
      projectId,
      "acquireLease",
      "resource_key",
      machineId,
    );
    expect(error.toJSON()).toEqual({
      name: "PostgreSqlCoordinationDataError",
      code: "STORAGE_OPERATION_FAILED",
      backend: "postgresql",
      projectId,
      domain: "coordination",
      operation: "acquireLease",
      retryable: false,
      message: `postgresql coordination operation failed for project ${projectId}`,
      field: "resource_key",
      machineId,
    });
    expect(new PostgreSqlCoordinationDataError(
      projectId,
      "construct",
      "project_id",
    ).toJSON()).not.toHaveProperty("machineId");
    expect(new PostgreSqlLeaseFenceError(
      projectId,
      machineId,
      9007199254740993n,
      "assertLeaseFence",
    ).toJSON()).toMatchObject({
      machineId,
      fencingToken: "9007199254740993",
    });
    expect(new PostgreSqlCoordinationOperationError(
      projectId,
      machineId,
      "lock",
      true,
    ).toJSON()).toMatchObject({
      machineId,
      operation: "lock",
      retryable: true,
    });
  });
});
