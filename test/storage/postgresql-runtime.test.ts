import type {
  Client,
  Pool,
  PoolClient,
  Query,
  QueryResult,
  QueryResultRow,
} from "pg";
import { describe, expect, it, vi } from "vitest";
import { StorageOperationError } from "../../src/storage/errors.js";
import type {
  PostgreSqlConnectionSettings,
  PostgreSqlQueryExecutor,
} from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlRuntime,
  POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
  type PostgreSqlRuntimeDependencies,
} from "../../src/storage/postgresql/runtime.js";
import {
  PostgreSqlServerEncodingPreflightError,
  REQUIRED_POSTGRESQL_SERVER_ENCODING,
  REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION,
} from "../../src/storage/postgresql/migrations.js";
import { POSTGRESQL_SEARCH_CONFIGURATION_SHA256 } from "../../src/storage/postgresql/search-configuration.js";

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

interface HealthFixtureRow {
  readonly server_encoding: unknown;
  readonly server_version_num: unknown;
  readonly timezone: string;
  readonly role: string;
  readonly tls: boolean;
}

const HEALTHY_ROW: HealthFixtureRow = {
  server_encoding: "UTF8",
  server_version_num: 180004,
  timezone: "UTC",
  role: "runtime",
  tls: true,
};

const CURRENT_EXTENSION_ROWS = [
  "pg_stat_statements",
  "pg_trgm",
  "pgcrypto",
  "unaccent",
].map((name) => ({
  name,
  default_version: "1.0",
  installed_version: "1.0",
  installed_schema: "public",
  relocatable: true,
  preloaded: name === "pg_stat_statements" ? true : null,
}));

function isExtensionInspection(input: unknown): boolean {
  return typeof input === "object"
    && input !== null
    && "text" in input
    && typeof input.text === "string"
    && input.text.includes("pg_available_extensions");
}

function isSearchConfigurationInspection(input: unknown): boolean {
  return typeof input === "object"
    && input !== null
    && "text" in input
    && typeof input.text === "string"
    && input.text.includes("pg_ts_config_map");
}

function healthFixtures(
  healthRow: HealthFixtureRow = HEALTHY_ROW,
  extensionRows = CURRENT_EXTENSION_ROWS,
  searchConfigurationRow: QueryResultRow = {
    actual_sha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
    object_count: "19",
    ownership_ready: true,
  },
) {
  return fixtures((input) => {
    if (isExtensionInspection(input)) return result(extensionRows);
    if (typeof input === "object" && input !== null && "text" in input && typeof input.text === "string") {
      if (input.text.includes("pg_stat_statements_info")) {
        const pgStatStatements = extensionRows.find(({ name }) => name === "pg_stat_statements");
        if (pgStatStatements?.preloaded === false) {
          throw Object.assign(new Error("private preload detail"), { code: "55000" });
        }
        return result([{ stats_reset: new Date() }]);
      }
      if (input.text.includes("pg_ts_config_map")) {
        return result([searchConfigurationRow]);
      }
    }
    return result([healthRow]);
  });
}

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
      expect(transaction.transactionScope).toBe("active");
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

  it("honors omitted transaction options across success and failure paths", async () => {
    const successful = fixtures((input) => typeof input === "string"
      ? result([])
      : result([{ value: 3 }]));
    await expect(successful.runtime.transaction(async (transaction) => {
      const selected = await transaction.query<{ value: number }>({ text: "SELECT 3 AS value" }, {
        domain: "sessions",
        operation: "insideDefaultTransaction",
      });
      return selected.rows[0].value;
    })).resolves.toBe(3);
    expect(successful.query.mock.calls.map(([input]) => input)).toEqual([
      "BEGIN",
      { text: "SELECT 3 AS value" },
      "COMMIT",
    ]);
    expect(successful.release).toHaveBeenCalledWith(false);

    const original = new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      undefined,
      "sessions",
      "originalCallbackFailure",
    );
    const failed = fixtures();
    await expect(failed.runtime.transaction(async () => { throw original; })).rejects.toBe(original);
    expect(failed.query).toHaveBeenCalledWith("ROLLBACK");
    expect(failed.release).toHaveBeenCalledWith(false);

    const acquisition = fixtures();
    acquisition.connect.mockRejectedValueOnce(new Error("transaction acquisition failed"));
    await expect(acquisition.runtime.transaction(async () => undefined)).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      domain: "transaction",
      operation: "transaction",
    });
    expect(acquisition.release).not.toHaveBeenCalled();

    const closed = fixtures();
    await closed.runtime.close();
    await expect(closed.runtime.transaction(async () => undefined)).rejects.toMatchObject({
      code: "STORAGE_CLOSED",
      domain: "transaction",
      operation: "transaction",
    });
    expect(closed.connect).not.toHaveBeenCalled();
  });

  it("marks connection loss during COMMIT as an ambiguous non-retryable outcome and destroys the client", async () => {
    const f = fixtures((input) => {
      if (input === "COMMIT") throw Object.assign(new Error("connection secret"), { code: "08006" });
      return result([]);
    });
    await expect(f.runtime.transaction(async () => "unknown outcome", {
      projectId: "project",
      domain: "transaction",
      operation: "ambiguousCommit",
    })).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      projectId: "project",
      domain: "transaction",
      operation: "ambiguousCommit",
      name: "PostgreSqlCommitOutcomeUnknownError",
      retryable: false,
    });
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it.each([
    ["serialization", "40001"],
    ["deadlock", "40P01"],
  ])("retains retryability for a definite %s failure during COMMIT", async (_failure, code) => {
    const f = fixtures((input) => {
      if (input === "COMMIT") throw Object.assign(new Error("database secret"), { code });
      return result([]);
    });
    await expect(f.runtime.transaction(async () => "not committed", {
      domain: "transaction",
      operation: "definiteCommitFailure",
    })).rejects.toMatchObject({
      operation: "definiteCommitFailure",
      retryable: true,
    });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.release).toHaveBeenCalledWith(false);
  });

  it("destroys an aborted transaction after BEGIN without invoking its callback", async () => {
    let finishBegin!: (value: QueryResult<QueryResultRow>) => void;
    const beginResult = new Promise<QueryResult<QueryResultRow>>((resolve) => { finishBegin = resolve; });
    const f = fixtures((input) => input === "BEGIN" ? beginResult : result([]));
    const controller = new AbortController();
    const callback = vi.fn(async () => "must not run");
    const pending = f.runtime.transaction(callback, {
      projectId: "project",
      domain: "transaction",
      operation: "abortAfterBegin",
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(f.query).toHaveBeenCalledWith("BEGIN"));
    controller.abort();
    finishBegin(result([]));

    await expect(pending).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      projectId: "project",
      operation: "abortAfterBegin",
    });
    expect(callback).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.release).toHaveBeenCalledWith(true);
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

  it("keeps a caught pg_stat_statements SQLSTATE 55000 fatal to the transaction", async () => {
    const f = fixtures((input) => {
      if (typeof input === "string") return result([]);
      throw Object.assign(new Error("must be loaded via shared_preload_libraries"), { code: "55000" });
    });
    await expect(f.runtime.transaction(async (transaction) => {
      await transaction.query({ text: "SELECT stats_reset FROM public.pg_stat_statements_info" }, {
        domain: "factory",
        operation: "caughtPgStatStatementsProbe",
      }).catch(() => undefined);
    })).rejects.toMatchObject({
      operation: "caughtPgStatStatementsProbe",
      sqlState: "55000",
    });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("drains successful unawaited queries and fences retained executors before committing", async () => {
    let finishQuery!: (value: QueryResult<QueryResultRow>) => void;
    const queryResult = new Promise<QueryResult<QueryResultRow>>((resolve) => { finishQuery = resolve; });
    const f = fixtures((input) => typeof input === "string" ? result([]) : queryResult);
    let retained!: PostgreSqlQueryExecutor;
    const pending = f.runtime.transaction(async (transaction) => {
      retained = transaction;
      void transaction.query({ text: "UPDATE values_table SET value = 2" }, {
        domain: "sessions",
        operation: "unawaitedSuccess",
      });
      return "committed";
    }, { projectId: "outer-project", domain: "transaction", operation: "drainSuccess" });

    await vi.waitFor(() => expect(f.query).toHaveBeenCalledWith({ text: "UPDATE values_table SET value = 2" }));
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.release).not.toHaveBeenCalled();
    await expect(retained.query({ text: "SELECT 1" }, {
      projectId: "retained-project",
      domain: "sessions",
      operation: "duringDrain",
    })).rejects.toMatchObject({
      code: "STORAGE_TRANSACTION_SCOPE",
      projectId: "retained-project",
      operation: "duringDrain",
    });

    finishQuery(result([]));
    await expect(pending).resolves.toBe("committed");
    expect(f.query.mock.calls.map(([input]) => input)).toEqual([
      "BEGIN",
      { text: "UPDATE values_table SET value = 2" },
      "COMMIT",
    ]);
    expect(f.release).toHaveBeenCalledWith(false);
  });

  it("drains unawaited queries before preserving a callback failure and rolling back", async () => {
    let finishQuery!: (value: QueryResult<QueryResultRow>) => void;
    const queryResult = new Promise<QueryResult<QueryResultRow>>((resolve) => { finishQuery = resolve; });
    const f = fixtures((input) => typeof input === "string" ? result([]) : queryResult);
    const pending = f.runtime.transaction(async (transaction) => {
      void transaction.query({ text: "UPDATE values_table SET value = 3" }, {
        domain: "sessions",
        operation: "unawaitedBeforeCallbackFailure",
      });
      throw new Error("callback secret");
    }, { domain: "transaction", operation: "callbackFailureAfterDrain" });

    await vi.waitFor(() => expect(f.query).toHaveBeenCalledWith({ text: "UPDATE values_table SET value = 3" }));
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(f.release).not.toHaveBeenCalled();
    finishQuery(result([]));

    await expect(pending).rejects.toMatchObject({ operation: "callbackFailureAfterDrain" });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.release).toHaveBeenCalledWith(false);
  });

  it("prefers an unawaited query failure over a concurrent callback failure", async () => {
    let failQuery!: (error: Error) => void;
    const queryResult = new Promise<QueryResult<QueryResultRow>>((_resolve, reject) => { failQuery = reject; });
    const f = fixtures((input) => typeof input === "string" ? result([]) : queryResult);
    const pending = f.runtime.transaction(async (transaction) => {
      void transaction.query({ text: "INSERT INTO values_table VALUES (4)" }, {
        projectId: "query-project",
        domain: "sessions",
        operation: "unawaitedFailure",
      }).catch(() => undefined);
      throw new Error("callback secret");
    }, { projectId: "outer-project", domain: "transaction", operation: "callbackFailure" });

    await vi.waitFor(() => expect(f.query).toHaveBeenCalledWith({ text: "INSERT INTO values_table VALUES (4)" }));
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    failQuery(Object.assign(new Error("constraint secret"), { code: "23505" }));

    await expect(pending).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      projectId: "query-project",
      domain: "sessions",
      operation: "unawaitedFailure",
      retryable: false,
    });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.release).toHaveBeenCalledWith(false);
  });

  it("destroys the client when an unawaited query disconnects after the callback fails", async () => {
    let failQuery!: (error: Error) => void;
    const queryResult = new Promise<QueryResult<QueryResultRow>>((_resolve, reject) => { failQuery = reject; });
    const f = fixtures((input) => typeof input === "string" ? result([]) : queryResult);
    const pending = f.runtime.transaction(async (transaction) => {
      void transaction.query({ text: "UPDATE values_table SET value = 5" }, {
        domain: "sessions",
        operation: "unawaitedDisconnect",
      }).catch(() => undefined);
      throw new Error("callback secret");
    }, { domain: "transaction", operation: "callbackFailure" });

    await vi.waitFor(() => expect(f.query).toHaveBeenCalledWith({ text: "UPDATE values_table SET value = 5" }));
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(f.release).not.toHaveBeenCalled();
    failQuery(Object.assign(new Error("connection secret"), { code: "08006" }));

    await expect(pending).rejects.toMatchObject({
      operation: "unawaitedDisconnect",
      retryable: true,
    });
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(f.query).not.toHaveBeenCalledWith("COMMIT");
    expect(f.release).toHaveBeenCalledWith(true);
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

  it("destroys a transaction client when abort state changes as acquisition settles", async () => {
    let abortChecks = 0;
    const signal = {
      get aborted() {
        abortChecks += 1;
        return abortChecks >= 3;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as AbortSignal;
    const callback = vi.fn(async () => undefined);
    const f = fixtures();

    await expect(f.runtime.transaction(callback, {
      domain: "transaction", operation: "abortAfterAcquire", signal,
    })).rejects.toMatchObject({ operation: "abortAfterAcquire", retryable: false });
    expect(callback).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("destroys a transaction client when abort state changes immediately after acquisition", async () => {
    let abortChecks = 0;
    const signal = {
      get aborted() {
        abortChecks += 1;
        return abortChecks >= 4;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const callback = vi.fn(async () => undefined);
    const f = fixtures();

    await expect(f.runtime.transaction(callback, {
      domain: "transaction", operation: "abortImmediatelyAfterAcquire", signal,
    })).rejects.toMatchObject({ operation: "abortImmediatelyAfterAcquire", retryable: false });
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

  it("destroys a transaction client after a query-local abort with omitted transaction options", async () => {
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
    });
    await expect(pending).rejects.toMatchObject({ operation: "queryLocalAbort" });
    expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it.each(["transaction", "query"] as const)(
    "cancels an active transaction query when its %s signal aborts with both signals present",
    async (abortedSignal) => {
      let target: QueryWithCallback | undefined;
      const f = fixtures((input) => {
        if (input === "BEGIN" || input === "ROLLBACK") return result([]);
        if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
          return result([{ pid: 89 }]);
        }
        target = input as QueryWithCallback;
        return target;
      });
      const transactionController = new AbortController();
      const queryController = new AbortController();
      const removeTransactionListener = vi.spyOn(transactionController.signal, "removeEventListener");
      const removeQueryListener = vi.spyOn(queryController.signal, "removeEventListener");
      const pending = f.runtime.transaction(async (transaction) => {
        const query = transaction.query({ text: "SELECT pg_sleep(10)" }, {
          domain: "transaction",
          operation: `${abortedSignal}SignalAbort`,
          signal: queryController.signal,
        });
        await vi.waitFor(() => expect(target).toBeDefined());
        if (abortedSignal === "transaction") transactionController.abort();
        else queryController.abort();
        await vi.waitFor(() => expect(f.cancelQuery).toHaveBeenCalled());
        target?.callback(Object.assign(new Error("cancelled"), { code: "57014" }));
        return query;
      }, {
        domain: "transaction",
        operation: "outerCombinedSignals",
        signal: transactionController.signal,
      });

      await expect(pending).rejects.toMatchObject({ operation: `${abortedSignal}SignalAbort` });
      expect(f.cancelQuery).toHaveBeenCalledWith({
        text: "SELECT pg_cancel_backend($1) AS cancelled",
        values: [89],
      });
      expect(f.query).not.toHaveBeenCalledWith("ROLLBACK");
      expect(f.release).toHaveBeenCalledWith(true);
      expect(removeTransactionListener).toHaveBeenCalled();
      expect(removeQueryListener).toHaveBeenCalled();
    },
  );

  it("removes composed listeners after a successful query and ignores later aborts", async () => {
    const transactionController = new AbortController();
    const queryController = new AbortController();
    const addTransactionListener = vi.spyOn(transactionController.signal, "addEventListener");
    const removeTransactionListener = vi.spyOn(transactionController.signal, "removeEventListener");
    const addQueryListener = vi.spyOn(queryController.signal, "addEventListener");
    const removeQueryListener = vi.spyOn(queryController.signal, "removeEventListener");
    const f = fixtures((input) => {
      if (typeof input === "string") return result([]);
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 90 }]);
      }
      const target = input as QueryWithCallback;
      target.callback(null, result([{ value: 1 }]));
      return target;
    });

    await expect(f.runtime.transaction(
      (transaction) => transaction.query({ text: "SELECT 1" }, {
        domain: "transaction", operation: "combinedSuccess", signal: queryController.signal,
      }),
      { domain: "transaction", operation: "outerCombinedSuccess", signal: transactionController.signal },
    )).resolves.toMatchObject({ rows: [{ value: 1 }] });

    expect(addQueryListener).toHaveBeenCalledOnce();
    expect(removeQueryListener).toHaveBeenCalledOnce();
    expect(addTransactionListener).toHaveBeenCalledTimes(2);
    expect(removeTransactionListener).toHaveBeenCalledTimes(2);
    transactionController.abort();
    queryController.abort();
    expect(f.dependencies.createClient).not.toHaveBeenCalled();
  });

  it("does not register composed listeners for an already-aborted query signal", async () => {
    const transactionController = new AbortController();
    const queryController = new AbortController();
    queryController.abort();
    const addQueryListener = vi.spyOn(queryController.signal, "addEventListener");
    const removeQueryListener = vi.spyOn(queryController.signal, "removeEventListener");
    const f = fixtures();

    await expect(f.runtime.transaction(
      (transaction) => transaction.query({ text: "SELECT 1" }, {
        domain: "transaction", operation: "alreadyAbortedLocal", signal: queryController.signal,
      }),
      { domain: "transaction", operation: "outerActive", signal: transactionController.signal },
    )).rejects.toMatchObject({ operation: "alreadyAbortedLocal", retryable: false });

    expect(addQueryListener).not.toHaveBeenCalled();
    expect(removeQueryListener).not.toHaveBeenCalled();
    expect(f.query.mock.calls.map(([input]) => input)).toEqual(["BEGIN"]);
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("observes an abort raced between composed-listener registration and the post-registration fence", async () => {
    let localAborted = false;
    const localSignal = {
      get aborted() { return localAborted; },
      addEventListener: vi.fn(() => { localAborted = true; }),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const transactionController = new AbortController();
    const f = fixtures();

    await expect(f.runtime.transaction(
      (transaction) => transaction.query({ text: "SELECT 1" }, {
        domain: "transaction", operation: "composedRegistrationRace", signal: localSignal,
      }),
      { domain: "transaction", operation: "outerRace", signal: transactionController.signal },
    )).rejects.toMatchObject({ operation: "composedRegistrationRace", retryable: false });

    expect(localSignal.addEventListener).toHaveBeenCalledOnce();
    expect(localSignal.removeEventListener).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.map(([input]) => input)).toEqual(["BEGIN"]);
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("reuses one signal without adding composition listeners", async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const f = fixtures((input) => {
      if (typeof input === "string") return result([]);
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 92 }]);
      }
      const target = input as QueryWithCallback;
      target.callback(null, result([]));
      return target;
    });

    await expect(f.runtime.transaction(
      (transaction) => transaction.query({ text: "SELECT 1" }, {
        domain: "transaction", operation: "sameSignal", signal: controller.signal,
      }),
      { domain: "transaction", operation: "outerSameSignal", signal: controller.signal },
    )).resolves.toMatchObject({ rows: [] });

    expect(addListener).toHaveBeenCalledTimes(2);
    expect(removeListener).toHaveBeenCalledTimes(2);
  });

  it("rejects a pre-aborted query signal when a transaction signal is also present", async () => {
    const transactionController = new AbortController();
    const queryController = new AbortController();
    queryController.abort();
    const f = fixtures((input) => typeof input === "string" ? result([]) : result([{ pid: 90 }]));

    await expect(f.runtime.transaction(
      (transaction) => transaction.query({ text: "SELECT pg_sleep(10)" }, {
        domain: "transaction",
        operation: "preAbortedCombinedSignal",
        signal: queryController.signal,
      }),
      {
        domain: "transaction",
        operation: "outerPreAbortedCombinedSignal",
        signal: transactionController.signal,
      },
    )).rejects.toMatchObject({ operation: "preAbortedCombinedSignal", retryable: false });
    expect(f.query.mock.calls.map(([input]) => input)).toEqual(["BEGIN"]);
    expect(f.cancelQuery).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("observes a query abort between combined-signal checks and listener registration", async () => {
    let abortChecks = 0;
    const querySignal = {
      get aborted() {
        abortChecks += 1;
        return abortChecks >= 2;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const transactionController = new AbortController();
    const f = fixtures((input) => typeof input === "string" ? result([]) : result([{ pid: 92 }]));

    await expect(f.runtime.transaction(
      (transaction) => transaction.query({ text: "SELECT pg_sleep(10)" }, {
        domain: "transaction",
        operation: "combinedSignalRegistrationRace",
        signal: querySignal,
      }),
      {
        domain: "transaction",
        operation: "outerCombinedSignalRegistrationRace",
        signal: transactionController.signal,
      },
    )).rejects.toMatchObject({ operation: "combinedSignalRegistrationRace", retryable: false });
    expect(querySignal.addEventListener).toHaveBeenCalled();
    expect(querySignal.removeEventListener).toHaveBeenCalled();
    expect(f.query.mock.calls.map(([input]) => input)).toEqual(["BEGIN"]);
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it("reports healthy, degraded, invalid, unavailable, and closed health", async () => {
    const healthy = healthFixtures();
    await expect(healthy.runtime.health()).resolves.toMatchObject({
      status: "healthy",
      serverEncoding: REQUIRED_POSTGRESQL_SERVER_ENCODING,
      serverMajorVersion: REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION,
      extensions: CURRENT_EXTENSION_ROWS.map(({ name }) => expect.objectContaining({ name, status: "current" })),
    });
    const healthSql = (healthy.query.mock.calls[0]?.[0] as { text?: string } | undefined)?.text ?? "";
    for (const catalogBinding of [
      "pg_catalog.current_setting('server_version_num')::pg_catalog.int4",
      "pg_catalog.current_setting('server_encoding')",
      "pg_catalog.current_setting('TimeZone')",
      "FROM pg_catalog.pg_stat_ssl",
      "OPERATOR(pg_catalog.=)",
      "pg_catalog.pg_backend_pid()",
    ]) expect(healthSql).toContain(catalogBinding);
    expect(healthy.query.mock.calls.filter(([input]) => isExtensionInspection(input))).toHaveLength(1);
    healthy.failPool();
    await expect(healthy.runtime.health()).resolves.toMatchObject({ status: "degraded" });

    for (const serverMajorVersion of [
      REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION - 1,
      REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION + 1,
    ]) {
      const wrongVersion = healthFixtures({
        ...HEALTHY_ROW,
        server_version_num: serverMajorVersion * 10_000,
      });
      const health = await wrongVersion.runtime.health();
      expect(health).toMatchObject({
        status: "unavailable",
        serverMajorVersion,
        tls: true,
        timezone: "UTC",
        role: "runtime",
        error: { code: "STORAGE_INITIALIZATION_FAILED" },
      });
      expect(health).not.toHaveProperty("extensions");
      expect(wrongVersion.query).toHaveBeenCalledTimes(1);
      expect(wrongVersion.query.mock.calls.some(([input]) => isExtensionInspection(input))).toBe(false);
    }

    for (const { value, expected } of [
      { value: "LATIN1", expected: "LATIN1" },
      { value: "UTF8\nprivate", expected: null },
      { value: 7, expected: null },
      { value: undefined, expected: null },
    ]) {
      const wrongEncoding = healthFixtures({
        ...HEALTHY_ROW,
        server_encoding: value,
      });
      const health = await wrongEncoding.runtime.health();
      expect(health).toMatchObject({
        status: "unavailable",
        serverEncoding: expected,
        error: {
          operation: "health",
          remediation:
            "Create or restore the LCM database with server_encoding UTF8, then rerun readiness.",
          requiredServerEncoding: "UTF8",
          serverEncoding: expected,
        },
      });
      expect(health.error).toBeInstanceOf(PostgreSqlServerEncodingPreflightError);
      expect(health).not.toHaveProperty("extensions");
      expect(wrongEncoding.query).toHaveBeenCalledTimes(1);
    }

    for (const row of [
      { ...HEALTHY_ROW, tls: false },
      { ...HEALTHY_ROW, timezone: "America/Sao_Paulo" },
    ]) {
      const invalid = healthFixtures(row);
      await expect(invalid.runtime.health()).resolves.toMatchObject({
        status: "unavailable",
        serverMajorVersion: REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION,
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

  it.each([
    { label: "text", serverVersionNumber: "180004" },
    { label: "negative", serverVersionNumber: -1 },
    { label: "fractional", serverVersionNumber: 180_004.5 },
    { label: "NaN", serverVersionNumber: Number.NaN },
    { label: "infinite", serverVersionNumber: Number.POSITIVE_INFINITY },
    { label: "missing", serverVersionNumber: undefined },
  ])("fails closed before extension inspection for a $label server version", async ({
    serverVersionNumber,
  }) => {
    const malformed = healthFixtures({
      ...HEALTHY_ROW,
      server_version_num: serverVersionNumber,
    });
    const health = await malformed.runtime.health();

    expect(health).toMatchObject({
      status: "unavailable",
      serverMajorVersion: null,
      tls: true,
      timezone: "UTC",
      role: "runtime",
      error: { code: "STORAGE_INITIALIZATION_FAILED" },
    });
    expect(health).not.toHaveProperty("extensions");
    expect(malformed.query).toHaveBeenCalledTimes(1);
    expect(malformed.query.mock.calls.some(([input]) => isExtensionInspection(input))).toBe(false);
  });

  it.each([
    {
      label: "unavailable",
      rows: CURRENT_EXTENSION_ROWS.filter(({ name }) => name !== "pgcrypto"),
      expected: { name: "pgcrypto", available: false, status: "unavailable" },
    },
    {
      label: "uninstalled",
      rows: CURRENT_EXTENSION_ROWS.map((row) => row.name === "pg_trgm"
        ? { ...row, installed_version: null, installed_schema: null, relocatable: null }
        : row),
      expected: {
        name: "pg_trgm",
        available: true,
        installedSchema: null,
        relocatable: null,
        status: "uninstalled",
      },
    },
    {
      label: "version mismatch",
      rows: CURRENT_EXTENSION_ROWS.map((row) => row.name === "unaccent"
        ? { ...row, installed_version: "0.9" }
        : row),
      expected: { name: "unaccent", available: true, status: "version-mismatch" },
    },
    {
      label: "installed but unavailable",
      rows: CURRENT_EXTENSION_ROWS.map((row) => row.name === "pgcrypto"
        ? { ...row, default_version: null, relocatable: null }
        : row),
      expected: {
        name: "pgcrypto",
        available: false,
        installedVersion: "1.0",
        installedSchema: "public",
        status: "installed-unavailable",
      },
    },
    {
      label: "not preloaded",
      rows: CURRENT_EXTENSION_ROWS.map((row) => row.name === "pg_stat_statements"
        ? { ...row, preloaded: false }
        : row),
      expected: {
        name: "pg_stat_statements",
        preloadRequired: true,
        preloaded: false,
        status: "not-preloaded",
      },
    },
    {
      label: "wrong namespace",
      rows: CURRENT_EXTENSION_ROWS.map((row) => row.name === "pgcrypto"
        ? { ...row, installed_schema: "search" }
        : row),
      expected: {
        name: "pgcrypto",
        installedSchema: "search",
        requiredSchema: "public",
        status: "wrong-namespace",
      },
    },
  ])("reports $label required extensions as unavailable readiness", async ({ rows, expected }) => {
    const runtime = healthFixtures(HEALTHY_ROW, rows);
    await expect(runtime.runtime.health()).resolves.toMatchObject({
      status: "unavailable",
      backend: "postgresql",
      extensions: expect.arrayContaining([expect.objectContaining(expected)]),
      error: {
        code: "STORAGE_INITIALIZATION_FAILED",
        operation: "health",
        extensions: expect.arrayContaining([expect.objectContaining(expected)]),
      },
    });
    const health = await runtime.runtime.health();
    expect(health).not.toHaveProperty("searchConfiguration");
    expect(runtime.query.mock.calls.some(([input]) => isSearchConfigurationInspection(input)))
      .toBe(false);
  });

  it("reports text-search catalog drift as unavailable readiness", async () => {
    const runtime = healthFixtures(HEALTHY_ROW, CURRENT_EXTENSION_ROWS, {
      actual_sha256: null,
      object_count: "18",
      ownership_ready: true,
    });
    await expect(runtime.runtime.health()).resolves.toMatchObject({
      status: "unavailable",
      backend: "postgresql",
      searchConfiguration: {
        objectCount: 18,
        ready: false,
      },
      error: {
        code: "STORAGE_INITIALIZATION_FAILED",
        operation: "health",
        searchConfiguration: {
          objectCount: 18,
          ready: false,
        },
      },
    });
  });

  it("closes idempotently and rejects closed operations", async () => {
    const f = fixtures();
    const first = f.runtime.close();
    expect(f.runtime.close()).toBe(first);
    await first;
    await expect(f.runtime.query({ text: "SELECT 1" }, {
      projectId: "project", domain: "factory", operation: "afterClose",
    })).rejects.toMatchObject({ code: "STORAGE_CLOSED", projectId: "project" });
    expect(f.runtime.close()).toBe(first);
    expect(f.end).toHaveBeenCalledTimes(1);
  });

  it("remains closed after shutdown failure while allowing an idempotent close retry", async () => {
    const failing = fixtures();
    let failInitialClose!: (error: Error) => void;
    const initialEnd = new Promise<void>((_resolve, reject) => { failInitialClose = reject; });
    failing.end.mockImplementationOnce(() => initialEnd);

    const initialClose = failing.runtime.close();
    expect(failing.runtime.close()).toBe(initialClose);
    await expect(failing.runtime.query({ text: "SELECT 1" }, {
      projectId: "project", domain: "factory", operation: "duringClose",
    })).rejects.toMatchObject({
      code: "STORAGE_CLOSED",
      projectId: "project",
      operation: "duringClose",
    });
    failInitialClose(new Error("close secret"));
    await expect(initialClose).rejects.toMatchObject({ operation: "close" });

    const callback = vi.fn(async () => undefined);
    await expect(failing.runtime.query({ text: "SELECT 1" }, {
      domain: "factory", operation: "afterCloseFailure",
    })).rejects.toMatchObject({ code: "STORAGE_CLOSED", operation: "afterCloseFailure" });
    await expect(failing.runtime.transaction(callback, {
      domain: "transaction", operation: "afterCloseFailure",
    })).rejects.toMatchObject({ code: "STORAGE_CLOSED", operation: "afterCloseFailure" });
    expect(callback).not.toHaveBeenCalled();
    await expect(failing.runtime.health()).resolves.toEqual({ status: "closed", backend: "postgresql" });
    expect(failing.connect).not.toHaveBeenCalled();

    const retry = failing.runtime.close();
    expect(retry).not.toBe(initialClose);
    expect(failing.runtime.close()).toBe(retry);
    await expect(retry).resolves.toBeUndefined();
    expect(failing.runtime.close()).toBe(retry);
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

  it("rejects promptly when acquisition is aborted and consumes a later rejection", async () => {
    const controller = new AbortController();
    const f = fixtures();
    let rejectConnect!: (reason?: unknown) => void;
    f.connect.mockReturnValueOnce(new Promise<PoolClient>((_resolve, reject) => {
      rejectConnect = reject;
    }));
    const query = f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory", operation: "abortDuringRejectedAcquire", signal: controller.signal,
    });
    const expectation = expect(query).rejects.toMatchObject({
      operation: "abortDuringRejectedAcquire", retryable: false,
    });
    controller.abort();
    await expectation;

    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      rejectConnect(Object.assign(new Error("timeout exceeded when trying to connect"), { code: "ETIMEDOUT" }));
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
    expect(f.release).not.toHaveBeenCalled();
  });

  it("preserves the original acquisition failure when a supplied signal remains active", async () => {
    const controller = new AbortController();
    const f = fixtures();
    f.connect.mockRejectedValueOnce(Object.assign(new Error("connection secret"), { code: "08006" }));

    await expect(f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory",
      operation: "signalledAcquireFailure",
      signal: controller.signal,
    })).rejects.toMatchObject({ operation: "signalledAcquireFailure", retryable: true });
    expect(f.release).not.toHaveBeenCalled();
  });

  it("prefers abort when abort state changes as an acquisition failure settles", async () => {
    let abortChecks = 0;
    const signal = {
      get aborted() {
        abortChecks += 1;
        return abortChecks >= 3;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const f = fixtures();
    f.connect.mockRejectedValueOnce(Object.assign(new Error("connection secret"), { code: "08006" }));

    await expect(f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory",
      operation: "abortAsAcquireFails",
      signal,
    })).rejects.toMatchObject({ operation: "abortAsAcquireFails", retryable: false });
    expect(f.release).not.toHaveBeenCalled();
  });

  it("observes abort state changing immediately after the acquisition listener is registered", async () => {
    let abortChecks = 0;
    const signal = {
      get aborted() {
        abortChecks += 1;
        return abortChecks >= 2;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const f = fixtures();
    let resolveConnect!: (client: PoolClient) => void;
    f.connect.mockReturnValueOnce(new Promise<PoolClient>((resolve) => {
      resolveConnect = resolve;
    }));

    await expect(f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory",
      operation: "abortAfterAcquireListener",
      signal,
    })).rejects.toMatchObject({ operation: "abortAfterAcquireListener", retryable: false });
    resolveConnect(f.poolClient);
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledWith(true));
    expect(f.query).not.toHaveBeenCalled();
  });

  it("rejects promptly when acquisition is aborted and destroys a client acquired later", async () => {
    const controller = new AbortController();
    const f = fixtures();
    let resolveConnect!: (client: PoolClient) => void;
    f.connect.mockReturnValueOnce(new Promise<PoolClient>((resolve) => {
      resolveConnect = resolve;
    }));
    const query = f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory", operation: "abortAfterAcquire", signal: controller.signal,
    });
    const expectation = expect(query).rejects.toMatchObject({ operation: "abortAfterAcquire", retryable: false });
    controller.abort();
    await expectation;
    expect(f.release).not.toHaveBeenCalled();

    resolveConnect(f.poolClient);
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledWith(true));
    expect(f.query).not.toHaveBeenCalled();
  });

  it("consumes a release failure from a client acquired after abort", async () => {
    const controller = new AbortController();
    const f = fixtures();
    let resolveConnect!: (client: PoolClient) => void;
    f.connect.mockReturnValueOnce(new Promise<PoolClient>((resolve) => { resolveConnect = resolve; }));
    f.release.mockImplementationOnce(() => { throw new Error("late release failed"); });
    const query = f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory", operation: "lateReleaseFailure", signal: controller.signal,
    });

    controller.abort();
    await expect(query).rejects.toMatchObject({ operation: "lateReleaseFailure", retryable: false });
    resolveConnect(f.poolClient);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(f.release).toHaveBeenCalledWith(true);
    expect(f.query).not.toHaveBeenCalled();
  });

  it("contains a late client release failure after an acquisition abort", async () => {
    const controller = new AbortController();
    const f = fixtures();
    let resolveConnect!: (client: PoolClient) => void;
    f.connect.mockReturnValueOnce(new Promise<PoolClient>((resolve) => {
      resolveConnect = resolve;
    }));
    f.release.mockImplementationOnce(() => { throw new Error("release secret"); });
    const pending = f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory",
      operation: "lateReleaseFailure",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ operation: "lateReleaseFailure", retryable: false });

    resolveConnect(f.poolClient);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(f.release).toHaveBeenCalledWith(true);
    expect(f.query).not.toHaveBeenCalled();
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
    let listenerRegistrations = 0;
    const signal = {
      get aborted() { return aborted; },
      addEventListener: vi.fn(() => {
        listenerRegistrations += 1;
        if (listenerRegistrations === 2) aborted = true;
      }),
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
      get aborted() { abortChecks += 1; return abortChecks >= 6; },
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

  it("starts cancellation when abort state changes as the target query callback settles", async () => {
    let aborted = false;
    const signal = {
      get aborted() { return aborted; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const f = fixtures((input) => {
      if (typeof input === "object" && input !== null && "text" in input && !("callback" in input)) {
        return result([{ pid: 78 }]);
      }
      const target = input as QueryWithCallback;
      aborted = true;
      target.callback(null, result([{ value: 1 }]));
      return target;
    });

    await expect(f.runtime.query({ text: "SELECT 1" }, {
      domain: "factory",
      operation: "callbackAbortStateRace",
      signal,
    })).rejects.toMatchObject({ operation: "callbackAbortStateRace", retryable: false });
    expect(f.cancelQuery).toHaveBeenCalledWith({
      text: "SELECT pg_cancel_backend($1) AS cancelled",
      values: [78],
    });
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
