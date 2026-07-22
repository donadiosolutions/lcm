import type {
  Client,
  Pool,
  PoolClient,
  Query,
  QueryResult,
  QueryResultRow,
} from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlConnectionSettings,
  PostgreSqlQueryExecutor,
} from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlRuntime,
  POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
  type PostgreSqlRuntimeDependencies,
} from "../../src/storage/postgresql/runtime.js";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

const SETTINGS: PostgreSqlConnectionSettings = {
  url: "postgresql://user:password@db.example/lcm",
  caFile: "/secure/ca.pem",
  poolMax: 2,
  connectionTimeoutMs: 100,
  idleTimeoutMs: 200,
  statementTimeoutMs: 300,
};

type QueryCallback = (error: Error | null, value?: QueryResult<QueryResultRow>) => void;
type QueryWithCallback = Query<QueryResultRow, unknown[]> & { callback: QueryCallback };

function fixtures(queryImplementation?: (input: unknown) => unknown) {
  let poolError: (() => void) | undefined;
  const release = vi.fn();
  const query = vi.fn((input: unknown) => queryImplementation?.(input) ?? result([]));
  const poolClient = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => poolClient);
  const end = vi.fn(async () => undefined);
  const pool = {
    connect,
    end,
    on: vi.fn((_event: string, listener: () => void) => { poolError = listener; }),
  } as unknown as Pool;
  const cancelQuery = vi.fn(async () => result([{ cancelled: true }]));
  const cancelEnd = vi.fn(async () => undefined);
  const cancelClient = {
    connect: vi.fn(async () => undefined),
    query: cancelQuery,
    end: cancelEnd,
  } as unknown as Client;
  const buildConfig = vi.fn(() => ({ host: "db.example", ssl: true }));
  const dependencies: PostgreSqlRuntimeDependencies = {
    createPool: vi.fn(() => pool),
    createClient: vi.fn(() => cancelClient),
    buildConfig,
  };
  const runtime = new PostgreSqlRuntime(SETTINGS, dependencies);
  return {
    runtime,
    dependencies,
    pool,
    poolClient,
    connect,
    end,
    query,
    release,
    cancelClient,
    cancelQuery,
    cancelEnd,
    failPool: () => poolError?.(),
  };
}

describe("PostgreSQL runtime", () => {
  it("provides the real pg pool and one-shot client constructors", async () => {
    const pool = POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES.createPool({ max: 1 });
    const client = POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES.createClient({});
    expect(pool).toBeDefined();
    expect(client).toBeDefined();
    await pool.end();
    await client.end();
  });

  it("constructs one bounded pool and runs parameterized queries", async () => {
    const f = fixtures(() => result([{ value: 1 }]));
    await expect(f.runtime.query<{ value: number }, [number]>({ text: "SELECT $1 AS value", values: [1] }, {
      projectId: "project", domain: "sessions", operation: "select",
    })).resolves.toMatchObject({ rows: [{ value: 1 }] });
    expect(f.dependencies.createPool).toHaveBeenCalledWith(expect.objectContaining({
      host: "db.example", max: 2, idleTimeoutMillis: 200,
    }));
    expect(f.release).toHaveBeenCalledWith(false);
  });

  it("normalizes acquisition and query failures and handles an already-aborted signal", async () => {
    const acquisition = fixtures();
    acquisition.connect.mockRejectedValueOnce(Object.assign(new Error("private"), { code: "08006" }));
    await expect(acquisition.runtime.query({ text: "SELECT 1" }, { domain: "factory", operation: "acquire" }))
      .rejects.toMatchObject({ retryable: true, operation: "acquire" });

    const failed = fixtures(() => { throw Object.assign(new Error("secret parameter"), { code: "23505" }); });
    await expect(failed.runtime.query({ text: "SELECT $1", values: ["secret"] }, {
      domain: "factory", operation: "query",
    })).rejects.toMatchObject({ retryable: false, operation: "query" });
    expect(failed.release).toHaveBeenCalledWith(false);

    const controller = new AbortController();
    controller.abort();
    await expect(failed.runtime.query({ text: "SELECT 1" }, {
      domain: "factory", operation: "aborted", signal: controller.signal,
    })).rejects.toMatchObject({ operation: "aborted" });
    expect(failed.connect).toHaveBeenCalledTimes(1);
  });

  it("destroys clients after connection failures but retains them after ordinary SQL errors", async () => {
    const disconnected = fixtures(() => {
      throw Object.assign(new Error("connection secret"), { code: "ECONNRESET" });
    });
    await expect(disconnected.runtime.query({ text: "SELECT 1" }, {
      domain: "factory", operation: "disconnect",
    })).rejects.toMatchObject({ operation: "disconnect", retryable: true });
    expect(disconnected.release).toHaveBeenCalledWith(true);

    const constraint = fixtures(() => {
      throw Object.assign(new Error("constraint secret"), { code: "23505" });
    });
    await expect(constraint.runtime.query({ text: "INSERT INTO values_table VALUES ($1)", values: [1] }, {
      domain: "factory", operation: "constraint",
    })).rejects.toMatchObject({ operation: "constraint", retryable: false });
    expect(constraint.release).toHaveBeenCalledWith(false);
  });

  it("commits successful transactions and rolls back failed transactions", async () => {
    const f = fixtures((input) => typeof input === "string" ? result([]) : result([{ value: 2 }]));
    await expect(f.runtime.transaction(async (transaction) => {
      const selected = await transaction.query<{ value: number }>({ text: "SELECT 2 AS value" }, {
        domain: "sessions", operation: "inside",
      });
      return selected.rows[0].value;
    }, { projectId: "project", domain: "transaction", operation: "commit" })).resolves.toBe(2);
    expect(f.query.mock.calls.map(([input]) => input)).toEqual(["BEGIN", { text: "SELECT 2 AS value" }, "COMMIT"]);
    expect(f.release).toHaveBeenCalledWith(false);

    const failed = fixtures((input) => typeof input === "string" ? result([]) : result([]));
    await expect(failed.runtime.transaction(async () => { throw new Error("callback secret"); }, {
      domain: "transaction", operation: "rollback",
    })).rejects.toMatchObject({ operation: "rollback" });
    expect(failed.query).toHaveBeenCalledWith("ROLLBACK");
    expect(failed.release).toHaveBeenCalledWith(false);

    const queryFailure = fixtures((input) => {
      if (typeof input === "string") return result([]);
      throw new Error("query failed");
    });
    await expect(queryFailure.runtime.transaction(
      (transaction) => transaction.query({ text: "SELECT broken" }, {
        projectId: "query-project",
        domain: "sessions",
        operation: "queryFailure",
      }),
      { domain: "transaction", operation: "outerQueryFailure" },
    )).rejects.toMatchObject({
      projectId: "query-project",
      domain: "sessions",
      operation: "queryFailure",
    });
    expect(queryFailure.query).toHaveBeenCalledWith("ROLLBACK");
    expect(queryFailure.release).toHaveBeenCalledWith(false);
  });

  it("rolls back and rejects when a callback catches a transaction query failure", async () => {
    const f = fixtures((input) => {
      if (typeof input === "string") return result([]);
      throw Object.assign(new Error("constraint secret"), { code: "23505" });
    });
    await expect(f.runtime.transaction(async (transaction) => {
      await transaction.query({ text: "INSERT INTO values_table VALUES ($1)", values: [1] }, {
        projectId: "query-project",
        domain: "sessions",
        operation: "caughtFailure",
      }).catch(() => undefined);
      return "must not resolve";
    }, { projectId: "outer-project", domain: "transaction", operation: "caughtFailureOuter" }))
      .rejects.toMatchObject({
        code: "STORAGE_OPERATION_FAILED",
        projectId: "query-project",
        domain: "sessions",
        operation: "caughtFailure",
        retryable: false,
      });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.release).toHaveBeenCalledWith(false);
  });

  it("rejects and does not commit when the transaction signal aborts after the callback", async () => {
    const controller = new AbortController();
    const f = fixtures((input) => typeof input === "string" ? result([]) : result([{ value: 1 }]));
    await expect(f.runtime.transaction(async () => {
      await Promise.resolve();
      controller.abort();
      return "must not resolve";
    }, {
      projectId: "project",
      domain: "transaction",
      operation: "abortBeforeCommit",
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      projectId: "project",
      operation: "abortBeforeCommit",
    });
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("destroys transaction clients after rollback failure or abort", async () => {
    const rollbackFailure = fixtures((input) => {
      if (input === "ROLLBACK") throw new Error("rollback failed");
      return result([]);
    });
    await expect(rollbackFailure.runtime.transaction(async () => { throw new Error("failure"); }, {
      domain: "transaction", operation: "rollbackFailure",
    })).rejects.toMatchObject({ operation: "rollbackFailure" });
    expect(rollbackFailure.release).toHaveBeenCalledWith(true);

    const aborted = fixtures();
    const controller = new AbortController();
    await expect(aborted.runtime.transaction(async () => {
      controller.abort();
      throw new Error("aborted");
    }, { domain: "transaction", operation: "abort", signal: controller.signal }))
      .rejects.toMatchObject({ operation: "abort" });
    expect(aborted.release).toHaveBeenCalledWith(true);

    const acquisition = fixtures();
    acquisition.connect.mockRejectedValueOnce(new Error("transaction acquisition failed"));
    await expect(acquisition.runtime.transaction(async () => undefined, {
      domain: "transaction", operation: "acquisitionFailure",
    })).rejects.toMatchObject({ operation: "acquisitionFailure" });
    expect(acquisition.release).not.toHaveBeenCalled();
  });

  it("destroys transaction clients after connection-level failures without attempting rollback", async () => {
    const f = fixtures((input) => {
      if (input === "BEGIN") return result([]);
      throw Object.assign(new Error("connection secret"), { code: "08006" });
    });
    await expect(f.runtime.transaction(
      (transaction) => transaction.query({ text: "SELECT 1" }, {
        domain: "transaction", operation: "disconnect",
      }),
      { domain: "transaction", operation: "outerDisconnect" },
    )).rejects.toMatchObject({ operation: "disconnect", retryable: true });
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("serializes abort-aware transaction queries so a queued abort cannot cancel its sibling", async () => {
    let firstTarget: QueryWithCallback | undefined;
    const firstSignal = new AbortController();
    const queuedSignal = new AbortController();
    const f = fixtures((input) => {
      if (input === "BEGIN") return result([]);
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 101 }]);
      }
      firstTarget = input as QueryWithCallback;
      return firstTarget;
    });
    const pending = f.runtime.transaction(async (transaction) => {
      const first = transaction.query({ text: "UPDATE first_table SET value = 1" }, {
        domain: "transaction", operation: "first", signal: firstSignal.signal,
      });
      const queued = transaction.query({ text: "UPDATE second_table SET value = 2" }, {
        domain: "transaction", operation: "queued", signal: queuedSignal.signal,
      });
      await vi.waitFor(() => expect(firstTarget).toBeDefined());
      queuedSignal.abort();
      await Promise.resolve();
      expect(f.cancelQuery).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalledWith(expect.objectContaining({ text: "UPDATE second_table SET value = 2" }));
      firstTarget?.callback(null, result([]));
      return Promise.all([first, queued]);
    }, { domain: "transaction", operation: "concurrent" });

    await expect(pending).rejects.toMatchObject({ operation: "queued" });
    expect(f.cancelQuery).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("destroys a transaction client when its signal aborts during acquisition", async () => {
    const controller = new AbortController();
    const callback = vi.fn(async () => undefined);
    const f = fixtures();
    f.connect.mockImplementationOnce(async () => {
      controller.abort();
      return f.poolClient;
    });

    await expect(f.runtime.transaction(callback, {
      domain: "transaction", operation: "abortDuringAcquire", signal: controller.signal,
    })).rejects.toMatchObject({ operation: "abortDuringAcquire" });
    expect(callback).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("fences retained transaction executors after the callback settles", async () => {
    const f = fixtures((input) => typeof input === "string" ? result([]) : result([{ value: 1 }]));
    let retained!: PostgreSqlQueryExecutor;
    await f.runtime.transaction(async (transaction) => {
      retained = transaction;
    }, { projectId: "outer-project", domain: "transaction", operation: "retain" });
    expect(f.query.mock.calls.map(([input]) => input)).toEqual(["BEGIN", "COMMIT"]);

    await expect(retained.query({ text: "SELECT 1" }, {
      projectId: "query-project", domain: "sessions", operation: "escaped",
    })).rejects.toMatchObject({
      code: "STORAGE_TRANSACTION_SCOPE",
      projectId: "query-project",
      domain: "sessions",
      operation: "escaped",
    });
    await expect(retained.query({ text: "SELECT 2" }, {
      domain: "transaction", operation: "escapedWithoutProject",
    })).rejects.toMatchObject({
      code: "STORAGE_TRANSACTION_SCOPE",
      projectId: "outer-project",
    });
    expect(f.query.mock.calls.map(([input]) => input)).toEqual(["BEGIN", "COMMIT"]);
  });

  it("fences queries queued behind a failed transaction query before they execute", async () => {
    const f = fixtures((input) => {
      if (typeof input === "string") return result([]);
      throw Object.assign(new Error("constraint secret"), { code: "23505" });
    });
    let withProject!: Promise<unknown>;
    let withoutProject!: Promise<unknown>;
    await expect(f.runtime.transaction(async (transaction) => {
      const failed = transaction.query({ text: "INSERT INTO first_table VALUES (1)" }, {
        domain: "transaction", operation: "failed",
      });
      withProject = transaction.query({ text: "SELECT 1" }, {
        projectId: "queued-project", domain: "sessions", operation: "queuedWithProject",
      });
      withoutProject = transaction.query({ text: "SELECT 2" }, {
        domain: "transaction", operation: "queuedWithoutProject",
      });
      void withProject.catch(() => undefined);
      void withoutProject.catch(() => undefined);
      return failed;
    }, { projectId: "outer-project", domain: "transaction", operation: "queueFailure" }))
      .rejects.toMatchObject({ operation: "failed" });

    await expect(withProject).rejects.toMatchObject({
      code: "STORAGE_TRANSACTION_SCOPE", projectId: "queued-project", operation: "queuedWithProject",
    });
    await expect(withoutProject).rejects.toMatchObject({
      code: "STORAGE_TRANSACTION_SCOPE", projectId: "outer-project", operation: "queuedWithoutProject",
    });
    expect(f.query).not.toHaveBeenCalledWith(expect.objectContaining({ text: "SELECT 1" }));
    expect(f.query).not.toHaveBeenCalledWith(expect.objectContaining({ text: "SELECT 2" }));
    expect(f.release).toHaveBeenCalledWith(false);
  });

  it("destroys a transaction client after a query-local abort", async () => {
    let target: QueryWithCallback | undefined;
    const f = fixtures((input) => {
      if (input === "BEGIN" || input === "ROLLBACK") return result([]);
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 88 }]);
      }
      target = input as QueryWithCallback;
      return target;
    });
    const controller = new AbortController();
    const pending = f.runtime.transaction(async (transaction) => {
      const query = transaction.query({ text: "SELECT pg_sleep(10)" }, {
        domain: "transaction",
        operation: "queryLocalAbort",
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(target).toBeDefined());
      controller.abort();
      await vi.waitFor(() => expect(f.cancelQuery).toHaveBeenCalled());
      target?.callback(Object.assign(new Error("cancelled"), { code: "57014" }));
      return query;
    }, { domain: "transaction", operation: "outerTransaction" });
    await expect(pending).rejects.toMatchObject({ operation: "queryLocalAbort" });
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("reports healthy, degraded, invalid, unavailable, and closed health", async () => {
    const healthyRow = { server_version_num: 180004, timezone: "UTC", role: "runtime", tls: true };
    const healthy = fixtures(() => result([healthyRow]));
    await expect(healthy.runtime.health()).resolves.toMatchObject({ status: "healthy", serverMajorVersion: 18 });
    healthy.failPool();
    await expect(healthy.runtime.health()).resolves.toMatchObject({ status: "degraded" });

    const wrongVersion = fixtures(() => result([{ ...healthyRow, server_version_num: 190000 }]));
    await expect(wrongVersion.runtime.health()).resolves.toMatchObject({
      status: "unavailable",
      serverMajorVersion: 19,
      tls: true,
      timezone: "UTC",
      role: "runtime",
      error: { code: "STORAGE_INITIALIZATION_FAILED" },
    });

    for (const row of [
      { ...healthyRow, tls: false },
      { ...healthyRow, timezone: "America/Sao_Paulo" },
    ]) {
      const invalid = fixtures(() => result([row]));
      await expect(invalid.runtime.health()).resolves.toMatchObject({
        status: "unavailable",
        serverMajorVersion: 18,
        tls: row.tls,
        timezone: row.timezone,
        role: "runtime",
        error: { code: "STORAGE_INITIALIZATION_FAILED" },
      });
    }
    const unavailable = fixtures(() => { throw new Error("password secret"); });
    await expect(unavailable.runtime.health()).resolves.toMatchObject({ status: "unavailable" });
    await healthy.runtime.close();
    await expect(healthy.runtime.health()).resolves.toEqual({ status: "closed", backend: "postgresql" });
  });

  it("closes idempotently, restores state after close failure, and rejects closed operations", async () => {
    const f = fixtures();
    const first = f.runtime.close();
    expect(f.runtime.close()).toBe(first);
    await first;
    await expect(f.runtime.query({ text: "SELECT 1" }, {
      projectId: "project", domain: "factory", operation: "afterClose",
    })).rejects.toMatchObject({ code: "STORAGE_CLOSED", projectId: "project" });

    const failing = fixtures();
    failing.end.mockRejectedValueOnce(new Error("close secret"));
    await expect(failing.runtime.close()).rejects.toMatchObject({ operation: "close" });
    await expect(failing.runtime.close()).resolves.toBeUndefined();
    expect(failing.end).toHaveBeenCalledTimes(2);
  });

  it("resolves an abort-aware query and removes its listener", async () => {
    const f = fixtures((input) => {
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 42 }]);
      }
      const query = input as QueryWithCallback;
      query.callback(null, result([{ value: 3 }]));
      query.callback(null, result([{ value: 4 }]));
      return query;
    });
    const controller = new AbortController();
    await expect(f.runtime.query<{ value: number }>({ text: "SELECT 3 AS value" }, {
      domain: "factory", operation: "signalSuccess", signal: controller.signal,
    })).resolves.toMatchObject({ rows: [{ value: 3 }] });
    controller.abort();
    expect(f.dependencies.createClient).not.toHaveBeenCalled();
  });

  it("rejects when a signal aborts immediately after pool acquisition", async () => {
    const controller = new AbortController();
    const f = fixtures();
    f.connect.mockImplementationOnce(async () => {
      controller.abort();
      return f.poolClient;
    });
    await expect(f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory", operation: "abortAfterAcquire", signal: controller.signal,
    })).rejects.toMatchObject({ operation: "abortAfterAcquire" });
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("rejects without starting the target query when aborted during backend PID lookup", async () => {
    const controller = new AbortController();
    const f = fixtures((input) => {
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        controller.abort();
        return result([{ pid: 72 }]);
      }
      throw new Error("target query must not start");
    });
    await expect(f.runtime.query({ text: "DELETE FROM sessions" }, {
      domain: "sessions", operation: "abortDuringPidLookup", signal: controller.signal,
    })).rejects.toMatchObject({ operation: "abortDuringPidLookup" });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.dependencies.createClient).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("rejects when abort occurs between the PID check and listener registration", async () => {
    let aborted = false;
    const signal = {
      get aborted() { return aborted; },
      addEventListener: vi.fn(() => { aborted = true; }),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const f = fixtures((input) => {
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 79 }]);
      }
      throw new Error("target query must not start");
    });

    await expect(f.runtime.query({ text: "SELECT pg_sleep(10)" }, {
      domain: "factory", operation: "abortBeforeListener", signal,
    })).rejects.toMatchObject({ operation: "abortBeforeListener" });
    expect(f.cancelQuery).toHaveBeenCalledWith({ text: "SELECT pg_cancel_backend($1) AS cancelled", values: [79] });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(signal.removeEventListener).toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("cancels an active backend and destroys the checked-out connection", async () => {
    let target: QueryWithCallback | undefined;
    const f = fixtures((input) => {
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 73 }]);
      }
      target = input as QueryWithCallback;
      return target;
    });
    const controller = new AbortController();
    const pending = f.runtime.query({ text: "SELECT pg_sleep(10)" }, {
      domain: "factory", operation: "cancel", signal: controller.signal,
    });
    await vi.waitFor(() => expect(target).toBeDefined());
    controller.abort();
    await vi.waitFor(() => expect(f.cancelQuery).toHaveBeenCalled());
    target?.callback(Object.assign(new Error("cancelled"), { code: "57014" }));
    await expect(pending).rejects.toMatchObject({ operation: "cancel" });
    expect(f.cancelQuery).toHaveBeenCalledWith({ text: "SELECT pg_cancel_backend($1) AS cancelled", values: [73] });
    expect(f.cancelEnd).toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("does not release or reuse the target connection while cancellation is pending", async () => {
    let target: QueryWithCallback | undefined;
    let finishCancellation!: (value: QueryResult<{ cancelled: boolean }>) => void;
    const f = fixtures((input) => {
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 74 }]);
      }
      target = input as QueryWithCallback;
      return target;
    });
    f.cancelQuery.mockImplementationOnce(() => new Promise((resolve) => { finishCancellation = resolve; }));
    const controller = new AbortController();
    const pending = f.runtime.query({ text: "SELECT pg_sleep(10)" }, {
      domain: "factory", operation: "lateCancel", signal: controller.signal,
    });
    await vi.waitFor(() => expect(target).toBeDefined());
    controller.abort();
    await vi.waitFor(() => expect(f.cancelQuery).toHaveBeenCalled());
    target?.callback(null, result([{ value: 1 }]));
    await Promise.resolve();
    expect(f.release).not.toHaveBeenCalled();

    finishCancellation(result([{ cancelled: true }]));
    await expect(pending).rejects.toMatchObject({ operation: "lateCancel" });
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("waits for cancellation when the query callback wins the microtask race", async () => {
    let finishCancellation!: (value: QueryResult<{ cancelled: boolean }>) => void;
    const controller = new AbortController();
    const f = fixtures((input) => {
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 76 }]);
      }
      const target = input as QueryWithCallback;
      target.callback(null, result([{ value: 1 }]));
      controller.abort();
      return target;
    });
    f.cancelQuery.mockImplementationOnce(() => new Promise((resolve) => { finishCancellation = resolve; }));
    const pending = f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory", operation: "callbackAbortRace", signal: controller.signal,
    });
    await vi.waitFor(() => expect(f.cancelQuery).toHaveBeenCalled());
    expect(f.release).not.toHaveBeenCalled();

    finishCancellation(result([{ cancelled: true }]));
    await expect(pending).rejects.toMatchObject({ operation: "callbackAbortRace" });
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("cancels defensively when abort state changes without event delivery", async () => {
    let abortChecks = 0;
    const signal = {
      get aborted() { abortChecks += 1; return abortChecks >= 5; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const f = fixtures((input) => {
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 77 }]);
      }
      const target = input as QueryWithCallback;
      target.callback(null, result([{ value: 1 }]));
      return target;
    });
    vi.mocked(f.cancelClient.connect).mockRejectedValueOnce(new Error("connect failed"));
    await expect(f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory", operation: "missedAbortEvent", signal,
    })).rejects.toMatchObject({ operation: "missedAbortEvent" });
    expect(f.dependencies.createClient).toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("preserves a driver failure when an abort-aware query fails before abort", async () => {
    const f = fixtures((input) => {
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 75 }]);
      }
      const target = input as QueryWithCallback;
      target.callback(Object.assign(new Error("driver secret"), { code: "53300" }));
      return target;
    });
    const controller = new AbortController();
    await expect(f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory", operation: "signalledFailure", signal: controller.signal,
    })).rejects.toMatchObject({ operation: "signalledFailure", retryable: true });
    expect(f.release).toHaveBeenCalledWith(false);
  });

  it.each(["rejected", "connect"])("fails closed when cancellation is %s", async (failure) => {
    let target: QueryWithCallback | undefined;
    const f = fixtures((input) => {
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) return result([{ pid: 91 }]);
      target = input as QueryWithCallback;
      return target;
    });
    if (failure === "rejected") f.cancelQuery.mockResolvedValueOnce(result([{ cancelled: false }]));
    else vi.mocked(f.cancelClient.connect).mockRejectedValueOnce(new Error("connect failed"));
    f.cancelEnd.mockRejectedValueOnce(new Error("end failed"));
    const controller = new AbortController();
    const pending = f.runtime.query({ text: "SELECT pg_sleep(10)" }, {
      domain: "factory", operation: "cancelFailure", signal: controller.signal,
    });
    await vi.waitFor(() => expect(target).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ operation: "cancelFailure" });
    expect(f.release).toHaveBeenCalledWith(true);
  });
});
