import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
  PostgreSqlRuntime,
  type PostgreSqlRuntimeDependencies,
} from "../../src/storage/postgresql/runtime.js";
import {
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
  type PostgreSqlBackendPublicationAcquireInput,
} from "../../src/storage/postgresql/publication-guard.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  settings,
  withPostgreSqlTestDatabase,
} from "./harness.js";

type WireClient = PoolClient & {
  readonly connection: {
    readonly stream: {
      destroy(error?: Error): void;
      pause(): void;
    };
  };
};

interface PublicationScope {
  readonly machineId: string;
  readonly projectId: string;
}

interface LostCommitAckState {
  backendPid: number | undefined;
  backendTerminated: boolean;
  clientErrorListenerInstalled: boolean;
  clientErrorListenerRemoved: boolean;
  commitRejected: boolean;
  injectionStarted: boolean;
  remoteCommitObserved: boolean;
  runtimeConnections: number;
}

interface LostCommitAckHarness {
  readonly assertExpectedClientError: () => Promise<void>;
  readonly dependencies: PostgreSqlRuntimeDependencies;
  readonly disposeClientErrorListener: () => void;
  readonly injectionSettled: Promise<void>;
}

interface LostCommitAckSeams {
  readonly clientErrorTimeoutMs: number;
  readonly createPool: (config: PoolConfig) => Pool;
  readonly observeCommit: () => Promise<void>;
  readonly terminateBackend: (backendPid: number) => Promise<boolean>;
}

interface LostCommitAckInjection {
  readonly dispatchCommit: () => Promise<QueryResult<QueryResultRow>>;
  readonly observeCommit: () => Promise<void>;
  readonly reportInjectionSettled: () => void;
  readonly state: LostCommitAckState;
  readonly stream: WireClient["connection"]["stream"];
  readonly terminateBackend: (backendPid: number) => Promise<boolean>;
}

async function grantCoordinationRuntimePrivileges(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "docs", "postgresql-runtime-coordination-grants.sql"),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, {
    domain: "coordination",
    operation: "grantPublicationGuardRuntimePrivileges",
  });
}

async function createPublicationScope(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<PublicationScope> {
  const project = await database.migrator.query<{ project_id: string }>({
    text: `INSERT INTO lcm.projects (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING project_id`,
    values: [createHash("sha256").update(label).digest("hex"), label],
  }, { domain: "identity", operation: "createPublicationGuardProject" });
  const machine = await database.migrator.query<{ machine_id: string }>({
    text: `INSERT INTO lcm.machines (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING machine_id`,
    values: [
      `machine:${createHash("sha256").update(`${label}:machine`).digest("hex")}`,
      `${label} machine`,
    ],
  }, { domain: "identity", operation: "createPublicationGuardMachine" });
  return {
    machineId: machine.rows[0].machine_id,
    projectId: project.rows[0].project_id,
  };
}

function acquisition(
  scope: PublicationScope,
  publicationId: string,
): PostgreSqlBackendPublicationAcquireInput {
  return {
    ...scope,
    publicationId,
    targetBackend: "postgresql",
    evidenceSha256: createHash("sha256").update(publicationId).digest("hex"),
    ttlMs: 60_000,
  };
}

function queryResult<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

async function waitForAdvisoryWaiter(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const waiting = await database.migrator.query<{ count: string }>({
      text: `SELECT COUNT(*)::pg_catalog.text AS count
             FROM pg_catalog.pg_locks AS lock
             WHERE lock.locktype = 'advisory'
               AND NOT lock.granted
               AND lock.database = (
                 SELECT oid
                 FROM pg_catalog.pg_database
                 WHERE datname = pg_catalog.current_database()
               )`,
    }, { domain: "coordination", operation: "waitForCompetingPublisher" });
    if (waiting.rows[0].count !== "0") return;
    await database.migrator.query({
      text: "SELECT pg_catalog.pg_sleep(0.02)",
    }, { domain: "coordination", operation: "waitForCompetingPublisher" });
  }
  throw new Error("competing publisher did not reach the advisory lock");
}

async function waitForCommittedPublication(
  admin: PostgreSqlRuntime,
  input: PostgreSqlBackendPublicationAcquireInput,
  expectedReleased: boolean,
  expectedFencingToken?: bigint,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await admin.query<{
      fencing_token: string;
      publication_id: string;
      released: boolean;
    }>({
      text: `SELECT owner_process_id AS publication_id,
                    fencing_token::pg_catalog.text AS fencing_token,
                    released_at IS NOT NULL AS released
             FROM lcm.fenced_leases
             WHERE project_id = $1::pg_catalog.uuid
               AND resource_type = $2::pg_catalog.text
               AND resource_key = $3::pg_catalog.text`,
      values: [
        input.projectId,
        POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
        POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
      ],
    }, { domain: "coordination", operation: "observeCommittedPublication" });
    const row = observed.rows[0];
    if (
      row?.publication_id === input.publicationId
      && row.released === expectedReleased
      && (
        expectedFencingToken === undefined
        || row.fencing_token === expectedFencingToken.toString()
      )
    ) return;
    await admin.query({ text: "SELECT pg_catalog.pg_sleep(0.01)" }, {
      domain: "coordination",
      operation: "observeCommittedPublication",
    });
  }
  throw new Error("publication commit was not observable before acknowledgement loss");
}

async function waitForExpiredPublication(
  runtime: PostgreSqlRuntime,
  database: PostgreSqlTestDatabase,
  input: PostgreSqlBackendPublicationAcquireInput,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await runtime.backendPublicationGuard().read(input);
    if (observed?.databaseExpired === true) return;
    await database.migrator.query({
      text: "SELECT pg_catalog.pg_sleep(0.01)",
    }, { domain: "coordination", operation: "waitForPublicationExpiry" });
  }
  throw new Error("publication did not expire according to the database clock");
}

async function injectLostCommitAcknowledgement(
  injection: LostCommitAckInjection,
): Promise<QueryResult<QueryResultRow>> {
  injection.state.injectionStarted = true;
  let streamDestroyed = false;
  const destroyStream = (): void => {
    if (streamDestroyed) return;
    streamDestroyed = true;
    injection.stream.destroy();
  };
  try {
    injection.stream.pause();
    const commitOutcome = injection.dispatchCommit().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await injection.observeCommit();
    injection.state.remoteCommitObserved = true;
    const backendPid = injection.state.backendPid;
    if (backendPid === undefined) {
      throw new Error("COMMIT interception did not capture a backend PID");
    }
    injection.state.backendTerminated = await injection.terminateBackend(
      backendPid,
    );
    destroyStream();
    const outcome = await commitOutcome;
    if (outcome.status === "fulfilled") {
      throw new Error("COMMIT acknowledgement remained visible after termination");
    }
    injection.state.commitRejected = true;
    throw outcome.error;
  } finally {
    try {
      destroyStream();
    } finally {
      injection.reportInjectionSettled();
    }
  }
}

function lostCommitAckDependencies(
  admin: PostgreSqlRuntime,
  input: PostgreSqlBackendPublicationAcquireInput,
  state: LostCommitAckState,
  expectedReleased: boolean,
  expectedFencingToken?: bigint,
  seams: Partial<LostCommitAckSeams> = {},
): LostCommitAckHarness {
  let reportInjectionSettled!: () => void;
  const injectionSettled = new Promise<void>((resolve) => {
    reportInjectionSettled = resolve;
  });
  const clientErrors: unknown[] = [];
  let reportClientError!: () => void;
  const clientErrorObserved = new Promise<void>((resolve) => {
    reportClientError = resolve;
  });
  let errorClient: PoolClient | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  let clientErrorAssertion: Promise<void> | undefined;
  const removeClientErrorListener = (): void => {
    if (!errorClient || !errorListener || state.clientErrorListenerRemoved) return;
    errorClient.off("error", errorListener);
    state.clientErrorListenerRemoved = true;
  };
  const assertExpectedClientError = (): Promise<void> => {
    clientErrorAssertion ??= (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await injectionSettled;
        await Promise.race([
          clientErrorObserved,
          new Promise<void>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error("lost-COMMIT-ack client error was not observed"));
            }, seams.clientErrorTimeoutMs ?? 1_000);
          }),
        ]);
        if (!state.clientErrorListenerInstalled) {
          throw new Error("lost-COMMIT-ack client error listener was not installed");
        }
        if (clientErrors.length !== 1) {
          throw new Error(
            `lost-COMMIT-ack expected one client error, observed ${clientErrors.length}`,
          );
        }
        const error = clientErrors[0];
        if (
          !(error instanceof Error)
          || error.message !== "Connection terminated unexpectedly"
        ) {
          throw new Error("lost-COMMIT-ack observed an unexpected client error");
        }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        removeClientErrorListener();
      }
    })();
    return clientErrorAssertion;
  };
  const dependencies: PostgreSqlRuntimeDependencies = {
    ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
    createPool: (config) => {
      const pool = seams.createPool?.(config) ?? new Pool(config);
      const connect = pool.connect.bind(pool);
      let interceptCommit = true;
      Object.defineProperty(pool, "connect", {
        configurable: true,
        value: async (): Promise<PoolClient> => {
          const client = await connect();
          state.runtimeConnections += 1;
          if (!interceptCommit) return client;
          try {
            const originalQuery = client.query.bind(client) as (
              query: string | QueryConfig<unknown[]>,
            ) => Promise<QueryResult<QueryResultRow>>;
            const pid = await originalQuery(
              "SELECT pg_catalog.pg_backend_pid() AS pid",
            );
            const backendPid = (pid.rows[0] as { pid?: unknown } | undefined)?.pid;
            if (
              typeof backendPid !== "number"
              || !Number.isSafeInteger(backendPid)
              || backendPid <= 0
            ) {
              throw new Error("COMMIT interception received an invalid backend PID");
            }
            state.backendPid = backendPid;
            const stream = (client as WireClient).connection.stream;
            const observeClientError = (error: Error): void => {
              clientErrors.push(error);
              reportClientError();
            };
            client.on("error", observeClientError);
            errorClient = client;
            errorListener = observeClientError;
            state.clientErrorListenerInstalled = true;
            Object.defineProperty(client, "query", {
              configurable: true,
              value: (
                query: string | QueryConfig<unknown[]>,
              ): Promise<QueryResult<QueryResultRow>> => {
                if (query !== "COMMIT") return originalQuery(query);
                return injectLostCommitAcknowledgement({
                  dispatchCommit: () => originalQuery(query),
                  observeCommit: seams.observeCommit ?? (() => (
                    waitForCommittedPublication(
                      admin,
                      input,
                      expectedReleased,
                      expectedFencingToken,
                    )
                  )),
                  reportInjectionSettled,
                  state,
                  stream,
                  terminateBackend: seams.terminateBackend ?? (async (pidValue) => {
                    const terminated = await admin.query<{ terminated: boolean }>({
                      text: "SELECT pg_catalog.pg_terminate_backend($1) AS terminated",
                      values: [pidValue],
                    }, { domain: "coordination", operation: "terminateCommitBackend" });
                    return terminated.rows[0]?.terminated === true;
                  }),
                });
              },
            });
            interceptCommit = false;
            return client;
          } catch (error) {
            removeClientErrorListener();
            try {
              client.release(true);
            } catch {
              // Preserve the setup failure after making checkout reuse impossible.
            }
            throw error;
          }
        },
      });
      return pool;
    },
  };
  return {
    assertExpectedClientError,
    dependencies,
    disposeClientErrorListener: removeClientErrorListener,
    injectionSettled,
  };
}

async function settleLostCommitAckHarness(
  harness: LostCommitAckHarness | undefined,
  state: LostCommitAckState,
  closures: readonly (() => Promise<void>)[],
): Promise<void> {
  const failures: unknown[] = [];
  if (state.injectionStarted && harness) {
    try {
      await harness.assertExpectedClientError();
    } catch (error) {
      failures.push(error);
    }
  } else {
    harness?.disposeClientErrorListener();
  }
  const closeOutcomes = await Promise.allSettled(closures.map((close) => close()));
  for (const outcome of closeOutcomes) {
    if (outcome.status === "rejected") failures.push(outcome.reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "lost-COMMIT-ack cleanup failed");
  }
}

describe("lost-COMMIT-ack integration helper", () => {
  it.each(["query", "row"] as const)(
    "releases its checked-out client after backend-PID %s failure",
    async (failurePhase) => {
      const failure = new Error("backend PID query failed");
      const query = vi.fn((sql: string | QueryConfig<unknown[]>) => {
        expect(sql).toBe("SELECT pg_catalog.pg_backend_pid() AS pid");
        return failurePhase === "query"
          ? Promise.reject(failure)
          : Promise.resolve(queryResult([]));
      });
      const release = vi.fn();
      const client = { query, release } as unknown as PoolClient;
      const closePool = vi.fn(async () => undefined);
      const pool = {
        connect: vi.fn(async () => client),
        end: closePool,
        on: vi.fn(),
      } as unknown as Pool;
      const closeAdmin = vi.fn(async () => undefined);
      const admin = { close: closeAdmin } as unknown as PostgreSqlRuntime;
      const state: LostCommitAckState = {
        backendPid: undefined,
        backendTerminated: false,
        clientErrorListenerInstalled: false,
        clientErrorListenerRemoved: false,
        commitRejected: false,
        injectionStarted: false,
        remoteCommitObserved: false,
        runtimeConnections: 0,
      };
      const input = acquisition({
        machineId: "018f0000-0000-7000-8000-000000000002",
        projectId: "018f0000-0000-7000-8000-000000000001",
      }, `helper-pid-${failurePhase}`);
      const lostAck = lostCommitAckDependencies(
        admin,
        input,
        state,
        false,
        undefined,
        { createPool: () => pool },
      );
      const runtime = new PostgreSqlRuntime({
        url: "postgresql://runtime:unused@localhost/lcm_helper",
        caFile: "/unused",
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
      }, {
        ...lostAck.dependencies,
        buildConfig: () => ({}),
      });
      const callback = vi.fn(async () => undefined);

      await expect(runtime.transaction(callback, {
        domain: "transaction",
        operation: `helper-pid-${failurePhase}`,
      })).rejects.toMatchObject({
        code: "STORAGE_OPERATION_FAILED",
        operation: `helper-pid-${failurePhase}`,
      });
      await expect(Promise.all([runtime.close(), admin.close()]))
        .resolves.toEqual([undefined, undefined]);

      expect(callback).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(true);
      expect(state.injectionStarted).toBe(false);
      expect(closePool).toHaveBeenCalledOnce();
      expect(closeAdmin).toHaveBeenCalledOnce();
    },
  );

  it.each(["dispatch", "observation", "termination"] as const)(
    "settles injection and runtime closures after %s failure",
    async (failurePhase) => {
      const failure = new Error(`${failurePhase} failed`);
      const state: LostCommitAckState = {
        backendPid: undefined,
        backendTerminated: false,
        clientErrorListenerInstalled: false,
        clientErrorListenerRemoved: false,
        commitRejected: false,
        injectionStarted: false,
        remoteCommitObserved: false,
        runtimeConnections: 0,
      };
      const commitFailure = Object.assign(
        new Error("intercepted COMMIT connection closed"),
        { code: "08006" },
      );
      let rejectCommit!: (error: unknown) => void;
      const pendingCommit = new Promise<QueryResult<QueryResultRow>>(
        (_resolve, reject) => {
          rejectCommit = reject;
        },
      );
      let commitDispatched = false;
      let streamDestroyed = false;
      const originalQuery = vi.fn((query: string | QueryConfig<unknown[]>) => {
        if (query === "SELECT pg_catalog.pg_backend_pid() AS pid") {
          return Promise.resolve(queryResult([{ pid: 41 }]));
        }
        if (streamDestroyed) return Promise.reject(commitFailure);
        if (query === "COMMIT") {
          if (failurePhase === "dispatch") throw failure;
          commitDispatched = true;
          return pendingCommit;
        }
        return Promise.resolve(queryResult([]));
      });
      const clientEvents = new EventEmitter();
      const pause = vi.fn(() => {
        expect(state.clientErrorListenerInstalled).toBe(true);
        expect(clientEvents.listenerCount("error")).toBe(1);
      });
      const destroy = vi.fn(() => {
        streamDestroyed = true;
        if (commitDispatched) rejectCommit(commitFailure);
        clientEvents.emit("error", new Error("Connection terminated unexpectedly"));
      });
      const release = vi.fn();
      const client = Object.assign(clientEvents, {
        connection: { stream: { destroy, pause } },
        query: originalQuery,
        release,
      }) as unknown as WireClient;
      const closePool = vi.fn(async () => undefined);
      const pool = {
        connect: vi.fn(async () => client),
        end: closePool,
        on: vi.fn(),
      } as unknown as Pool;
      const closeAdmin = vi.fn(async () => undefined);
      const admin = { close: closeAdmin } as unknown as PostgreSqlRuntime;
      const observeCommit = vi.fn(async () => {
        if (failurePhase === "observation") throw failure;
      });
      const terminateBackend = vi.fn(async () => {
        if (failurePhase === "termination") throw failure;
        return true;
      });
      const input = acquisition({
        machineId: "018f0000-0000-7000-8000-000000000002",
        projectId: "018f0000-0000-7000-8000-000000000001",
      }, `helper-${failurePhase}`);
      const lostAck = lostCommitAckDependencies(
        admin,
        input,
        state,
        false,
        undefined,
        {
          createPool: () => pool,
          observeCommit,
          terminateBackend,
        },
      );
      const runtime = new PostgreSqlRuntime({
        url: "postgresql://runtime:unused@localhost/lcm_helper",
        caFile: "/unused",
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
      }, {
        ...lostAck.dependencies,
        buildConfig: () => ({}),
      });

      const operation = runtime.transaction(async () => undefined, {
        domain: "transaction",
        operation: `helper-${failurePhase}`,
      });
      await expect(operation).rejects.toMatchObject({
        code: "STORAGE_OPERATION_FAILED",
        operation: `helper-${failurePhase}`,
      });
      await expect(lostAck.injectionSettled).resolves.toBeUndefined();
      try {
        await expect(lostAck.assertExpectedClientError()).resolves.toBeUndefined();
      } finally {
        await expect(Promise.all([runtime.close(), admin.close()]))
          .resolves.toEqual([undefined, undefined]);
      }

      expect(state.injectionStarted).toBe(true);
      expect(state.clientErrorListenerInstalled).toBe(true);
      expect(state.clientErrorListenerRemoved).toBe(true);
      expect(clientEvents.listenerCount("error")).toBe(0);
      expect(pause).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith(true);
      expect(closePool).toHaveBeenCalledOnce();
      expect(closeAdmin).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["missing", "lost-COMMIT-ack client error was not observed"],
    ["extra", "lost-COMMIT-ack expected one client error, observed 2"],
    ["unexpected", "lost-COMMIT-ack observed an unexpected client error"],
  ] as const)(
    "rejects a %s client-error observation and still removes its listener",
    async (eventCase, expectedMessage) => {
      const operationFailure = new Error("observation failed");
      const commitFailure = Object.assign(
        new Error("intercepted COMMIT connection closed"),
        { code: "08006" },
      );
      let rejectCommit!: (error: unknown) => void;
      const pendingCommit = new Promise<QueryResult<QueryResultRow>>(
        (_resolve, reject) => {
          rejectCommit = reject;
        },
      );
      let streamDestroyed = false;
      const originalQuery = vi.fn((query: string | QueryConfig<unknown[]>) => {
        if (query === "SELECT pg_catalog.pg_backend_pid() AS pid") {
          return Promise.resolve(queryResult([{ pid: 41 }]));
        }
        if (streamDestroyed) return Promise.reject(commitFailure);
        if (query === "COMMIT") return pendingCommit;
        return Promise.resolve(queryResult([]));
      });
      const clientEvents = new EventEmitter();
      const destroy = vi.fn(() => {
        streamDestroyed = true;
        rejectCommit(commitFailure);
        if (eventCase === "missing") return;
        clientEvents.emit("error", new Error(
          eventCase === "unexpected"
            ? "unexpected client failure"
            : "Connection terminated unexpectedly",
        ));
        if (eventCase === "extra") {
          clientEvents.emit("error", new Error("Connection terminated unexpectedly"));
        }
      });
      const release = vi.fn();
      const client = Object.assign(clientEvents, {
        connection: { stream: { destroy, pause: vi.fn() } },
        query: originalQuery,
        release,
      }) as unknown as WireClient;
      const closePool = vi.fn(async () => undefined);
      const pool = {
        connect: vi.fn(async () => client),
        end: closePool,
        on: vi.fn(),
      } as unknown as Pool;
      const closeAdmin = vi.fn(async () => undefined);
      const admin = { close: closeAdmin } as unknown as PostgreSqlRuntime;
      const state: LostCommitAckState = {
        backendPid: undefined,
        backendTerminated: false,
        clientErrorListenerInstalled: false,
        clientErrorListenerRemoved: false,
        commitRejected: false,
        injectionStarted: false,
        remoteCommitObserved: false,
        runtimeConnections: 0,
      };
      const input = acquisition({
        machineId: "018f0000-0000-7000-8000-000000000002",
        projectId: "018f0000-0000-7000-8000-000000000001",
      }, `helper-client-error-${eventCase}`);
      const lostAck = lostCommitAckDependencies(
        admin,
        input,
        state,
        false,
        undefined,
        {
          clientErrorTimeoutMs: 10,
          createPool: () => pool,
          observeCommit: async () => { throw operationFailure; },
        },
      );
      const runtime = new PostgreSqlRuntime({
        url: "postgresql://runtime:unused@localhost/lcm_helper",
        caFile: "/unused",
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
      }, {
        ...lostAck.dependencies,
        buildConfig: () => ({}),
      });

      await expect(runtime.transaction(async () => undefined, {
        domain: "transaction",
        operation: `helper-client-error-${eventCase}`,
      })).rejects.toMatchObject({
        code: "STORAGE_OPERATION_FAILED",
        operation: `helper-client-error-${eventCase}`,
      });
      try {
        await expect(lostAck.assertExpectedClientError())
          .rejects.toThrow(expectedMessage);
      } finally {
        await expect(Promise.all([runtime.close(), admin.close()]))
          .resolves.toEqual([undefined, undefined]);
      }

      expect(state.clientErrorListenerInstalled).toBe(true);
      expect(state.clientErrorListenerRemoved).toBe(true);
      expect(clientEvents.listenerCount("error")).toBe(0);
      expect(release).toHaveBeenCalledWith(true);
      expect(closePool).toHaveBeenCalledOnce();
      expect(closeAdmin).toHaveBeenCalledOnce();
    },
  );
});

describe("PostgreSQL 18 backend-publication guard", () => {
  beforeAll(assertHarnessReady);

  it("serializes competing publishers and repeats recovery idempotently", async () => {
    await withPostgreSqlTestDatabase("publication-race", async (database) => {
      await grantCoordinationRuntimePrivileges(database);
      const scope = await createPublicationScope(database, "Publication race");
      let releaseWinner!: () => void;
      let reportWinnerLocked!: () => void;
      const winnerLocked = new Promise<void>((resolve) => {
        reportWinnerLocked = resolve;
      });
      const holdWinner = new Promise<void>((resolve) => {
        releaseWinner = resolve;
      });
      let holdFirstLock = true;
      const winner = new PostgreSqlRuntime(settings(database.runtimeUrl), {
        ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
        acquirePublicationLock: async (executor, projectId, options) => {
          await POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES.acquirePublicationLock(
            executor,
            projectId,
            options,
          );
          if (!holdFirstLock) return;
          holdFirstLock = false;
          reportWinnerLocked();
          await holdWinner;
        },
      });
      const loser = new PostgreSqlRuntime(settings(database.runtimeUrl));
      const winnerInput = acquisition(scope, "publication-race-winner");
      const loserInput = acquisition(scope, "publication-race-loser");
      try {
        const winningAcquire = winner.backendPublicationGuard().acquire(winnerInput);
        await winnerLocked;
        const losingAcquire = loser.backendPublicationGuard().acquire(loserInput);
        await waitForAdvisoryWaiter(database);
        releaseWinner();
        const winningFence = await winningAcquire;
        await expect(losingAcquire).rejects.toMatchObject({
          reason: "publication-conflict",
        });
        await expect(loser.backendPublicationGuard().read(winnerInput))
          .resolves.toEqual(winningFence);
        await expect(winner.backendPublicationGuard().acquire(winnerInput))
          .resolves.toEqual(winningFence);
        const released = await winner.backendPublicationGuard().release({
          ...winnerInput,
          fencingToken: winningFence.fencingToken,
        });
        expect(released.releasedAt).not.toBeNull();
        await expect(winner.backendPublicationGuard().release({
          ...winnerInput,
          fencingToken: winningFence.fencingToken,
        })).resolves.toEqual(released);
      } finally {
        releaseWinner();
        await Promise.all([winner.close(), loser.close()]);
      }
    });
  });

  it("recovers an acquired fence when COMMIT succeeds but its acknowledgement is lost", async () => {
    await withPostgreSqlTestDatabase("publication-ack", async (database) => {
      await grantCoordinationRuntimePrivileges(database);
      const scope = await createPublicationScope(database, "Publication ack loss");
      const input = acquisition(scope, "publication-commit-ack-loss");
      const state: LostCommitAckState = {
        backendPid: undefined,
        backendTerminated: false,
        clientErrorListenerInstalled: false,
        clientErrorListenerRemoved: false,
        commitRejected: false,
        injectionStarted: false,
        remoteCommitObserved: false,
        runtimeConnections: 0,
      };
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      const lostAck = lostCommitAckDependencies(admin, input, state, false);
      const runtime = new PostgreSqlRuntime(
        settings(database.runtimeUrl),
        lostAck.dependencies,
      );
      try {
        const fence = await runtime.backendPublicationGuard().acquire(input);
        await lostAck.assertExpectedClientError();
        expect(state).toMatchObject({
          backendPid: expect.any(Number),
          backendTerminated: true,
          clientErrorListenerInstalled: true,
          clientErrorListenerRemoved: true,
          commitRejected: true,
          injectionStarted: true,
          remoteCommitObserved: true,
        });
        expect(state.runtimeConnections).toBeGreaterThanOrEqual(2);
        expect(fence).toMatchObject({
          ...scope,
          publicationId: input.publicationId,
          evidenceSha256: input.evidenceSha256,
          releasedAt: null,
        });
        await expect(runtime.backendPublicationGuard().acquire(input))
          .resolves.toEqual(fence);
        await expect(runtime.backendPublicationGuard().release({
          ...input,
          fencingToken: fence.fencingToken,
        })).resolves.toMatchObject({ releasedAt: expect.any(String) });
      } finally {
        await settleLostCommitAckHarness(lostAck, state, [
          () => runtime.close(),
          () => admin.close(),
        ]);
      }
    });
  });

  it("recovers a released fence when COMMIT succeeds but its acknowledgement is lost", async () => {
    await withPostgreSqlTestDatabase("publication-release-ack", async (database) => {
      await grantCoordinationRuntimePrivileges(database);
      const scope = await createPublicationScope(
        database,
        "Publication release ack loss",
      );
      const input = acquisition(scope, "publication-release-commit-ack-loss");
      const state: LostCommitAckState = {
        backendPid: undefined,
        backendTerminated: false,
        clientErrorListenerInstalled: false,
        clientErrorListenerRemoved: false,
        commitRejected: false,
        injectionStarted: false,
        remoteCommitObserved: false,
        runtimeConnections: 0,
      };
      const stable = new PostgreSqlRuntime(settings(database.runtimeUrl));
      let admin: PostgreSqlRuntime | undefined;
      let runtime: PostgreSqlRuntime | undefined;
      let lostAck: LostCommitAckHarness | undefined;
      try {
        const fence = await stable.backendPublicationGuard().acquire(input);
        admin = new PostgreSqlRuntime(settings(database.adminUrl));
        lostAck = lostCommitAckDependencies(
          admin,
          input,
          state,
          true,
          fence.fencingToken,
        );
        runtime = new PostgreSqlRuntime(
          settings(database.runtimeUrl),
          lostAck.dependencies,
        );
        const released = await runtime.backendPublicationGuard().release({
          ...input,
          fencingToken: fence.fencingToken,
        });
        await lostAck.assertExpectedClientError();
        expect(state).toMatchObject({
          backendPid: expect.any(Number),
          backendTerminated: true,
          clientErrorListenerInstalled: true,
          clientErrorListenerRemoved: true,
          commitRejected: true,
          injectionStarted: true,
          remoteCommitObserved: true,
        });
        expect(state.runtimeConnections).toBeGreaterThanOrEqual(2);
        expect(released).toMatchObject({
          ...scope,
          publicationId: input.publicationId,
          evidenceSha256: input.evidenceSha256,
          fencingToken: fence.fencingToken,
          releasedAt: expect.any(String),
        });
        await expect(runtime.backendPublicationGuard().release({
          ...input,
          fencingToken: fence.fencingToken,
        })).resolves.toEqual(released);
        await expect(stable.backendPublicationGuard().read(input))
          .resolves.toEqual(released);
      } finally {
        await settleLostCommitAckHarness(lostAck, state, [
          () => stable.close(),
          ...(runtime ? [() => runtime.close()] : []),
          ...(admin ? [() => admin.close()] : []),
        ]);
      }
    });
  });

  it("reacquires an expired exact generation before releasing its successor fence", async () => {
    await withPostgreSqlTestDatabase("publication-expired-recovery", async (database) => {
      await grantCoordinationRuntimePrivileges(database);
      const scope = await createPublicationScope(
        database,
        "Publication expired recovery",
      );
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      const guard = runtime.backendPublicationGuard();
      const input = {
        ...acquisition(scope, "publication-expired-generation"),
        ttlMs: 25,
      };
      try {
        const expiredGeneration = await guard.acquire(input);
        await waitForExpiredPublication(runtime, database, input);
        const successor = await guard.acquire({
          ...input,
          ttlMs: 60_000,
          expectedFencingToken: expiredGeneration.fencingToken,
        });
        expect(successor).toMatchObject({
          ...scope,
          publicationId: input.publicationId,
          evidenceSha256: input.evidenceSha256,
          databaseExpired: false,
          releasedAt: null,
        });
        expect(successor.fencingToken).toBeGreaterThan(
          expiredGeneration.fencingToken,
        );
        await expect(guard.release({
          ...input,
          fencingToken: expiredGeneration.fencingToken,
        })).rejects.toMatchObject({ reason: "fence-mismatch" });
        const released = await guard.release({
          ...input,
          fencingToken: successor.fencingToken,
        });
        expect(released.releasedAt).toEqual(expect.any(String));
        await expect(guard.read(input)).resolves.toEqual(released);
      } finally {
        await runtime.close();
      }
    });
  });
});
