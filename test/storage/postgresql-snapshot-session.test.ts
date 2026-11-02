import { EventEmitter } from "node:events";
import type { Client, Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  DEFAULT_SNAPSHOT_IDLE_TIMEOUT_MS,
  PostgreSqlSnapshotSession,
  type PostgreSqlSnapshotOptions,
} from "../../src/storage/postgresql/snapshot-session.js";
import type { PostgreSqlConnectionSettings, PostgreSqlQueryOptions } from "../../src/storage/postgresql/contracts.js";

const options = { domain: "transaction", operation: "snapshot", projectId: "project" } as const;
function result(rows: QueryResultRow[] = []): QueryResult<QueryResultRow> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(
  handler: (text: string) => Promise<QueryResult<QueryResultRow>> = async () => result(),
  backendPid: unknown = 1234,
  settingsOverrides: Partial<Omit<PostgreSqlConnectionSettings, "url" | "caFile">> = {},
) {
  const statements: string[] = [];
  const configs: { text: string; values?: unknown[] }[] = [];
  let active: { callback: (error: Error | null, value?: QueryResult<QueryResultRow>) => void } | undefined;
  const query = vi.fn((input: string | {
    text: string;
    values?: unknown[];
    callback?: (error: Error | null, value?: QueryResult<QueryResultRow>) => void;
  }) => {
    const text = typeof input === "string" ? input : input.text;
    const values = typeof input === "object" ? input.values : undefined;
    statements.push(text);
    configs.push({ text, values });
    const execute = text.includes("pg_backend_pid") ? Promise.resolve(result([{ pid: backendPid }])) : handler(text);
    if (typeof input === "object" && input.callback) {
      const callback = input.callback;
      active = { callback };
      void execute.then((value) => callback(null, value), (error: Error) => callback(error));
      return input;
    }
    return execute;
  });
  const release = vi.fn();
  // A real EventEmitter, not a plain object, so the transport's
  // client.on("error", ...)/removeListener("error", ...) calls behave
  // exactly like the real pg PoolClient (which extends EventEmitter).
  // Shared across connect() calls in one fixture: sequential sessions on
  // the same fixture register and deregister their own listener on it,
  // exactly like reopening a session on the same recycled backend would.
  const clientEvents = new EventEmitter();
  const connect = vi.fn(async () => Object.assign(clientEvents, { query, release }) as unknown as PoolClient);
  const emitClientError = (error: unknown): void => { clientEvents.emit("error", error); };
  const end = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => {
    active?.callback(new Error("cancelled private query"));
    return result([{ cancelled: true }]);
  });
  const runtime = new PostgreSqlRuntime({
    url: "postgresql://secret", caFile: "/unused", poolMax: 2,
    connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100,
    ...settingsOverrides,
  }, {
    buildConfig: () => ({ ssl: true }),
    createPool: () => ({ connect, end, on: vi.fn() }) as unknown as Pool,
    createClient: () => ({ connect: async () => undefined, query: cancel, end: async () => undefined }) as unknown as Client,
  });
  return { runtime, query, connect, release, end, cancel, statements, configs, clientEvents, emitClientError };
}

describe("dedicated PostgreSQL snapshot session", () => {
  it("holds one readonly repeatable-read backend until idempotent rollback and release", async () => {
    const f = fixture();
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "PROJECT" });
    expect(session.identity).toMatchObject({ backendPid: 1234, projectId: "project" });
    expect(session.identity.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    await session.query({ text: "SELECT first" }, options);
    await session.query({ text: "SELECT second" }, options);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.statements).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(f.release).not.toHaveBeenCalled();
    await Promise.all([session.close(), session.close()]);
    expect(f.statements.filter((text) => text === "ROLLBACK")).toHaveLength(1);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    await expect(session.query({ text: "SELECT late" }, options)).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
    await f.runtime.close();
  });

  it("serializes concurrent reads and rejects queued work when close begins", async () => {
    const blocked = deferred<QueryResult<QueryResultRow>>();
    const started = deferred<void>();
    const f = fixture(async (text) => {
      if (text === "SELECT blocked") { started.resolve(); return blocked.promise; }
      return result();
    });
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    const first = session.query({ text: "SELECT blocked" }, options);
    const firstRejected = expect(first).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    await started.promise;
    const second = session.query({ text: "SELECT queued" }, options);
    const secondRejected = expect(second).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
    await session.close();
    await Promise.all([firstRejected, secondRejected]);
    expect(f.statements).not.toContain("SELECT queued");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    blocked.resolve(result());
    await f.runtime.close();
  });

  it("aborts an in-flight read and terminally releases the source", async () => {
    const started = deferred<void>();
    const f = fixture(async (text) => {
      if (text === "SELECT blocked") { started.resolve(); return new Promise(() => undefined); }
      return result();
    });
    const controller = new AbortController();
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project", signal: controller.signal });
    const pending = session.query({ text: "SELECT blocked" }, options);
    const rejected = expect(pending).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    await started.promise;
    controller.abort(new Error("private reason"));
    await rejected;
    await session.close();
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    await f.runtime.close();
  });

  it("closes an idle source when its lifetime signal aborts", async () => {
    const f = fixture();
    const controller = new AbortController();
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project", signal: controller.signal });
    controller.abort();
    await session.close();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    await f.runtime.close();
  });

  it("normalizes query failures and rolls back before releasing", async () => {
    const f = fixture(async (text) => {
      if (text === "SELECT broken") throw Object.assign(new Error("secret password"), { code: "22000" });
      return result();
    });
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    const error = await session.query({ text: "SELECT broken" }, options).catch((value: unknown) => value);
    expect(error).toMatchObject({ sqlState: "22000", projectId: "project" });
    expect(JSON.stringify(error)).not.toContain("secret");
    await session.close();
    expect(f.statements).toContain("ROLLBACK");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    await f.runtime.close();
  });

  it("destroys failed rollback connections and sanitizes close errors", async () => {
    const f = fixture(async (text) => {
      if (text === "ROLLBACK") throw new Error("private rollback error");
      return result();
    });
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    await expect(session.close()).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    await expect(session.close()).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    await f.runtime.close();
  });

  it("cleans up a failed BEGIN without exposing driver details", async () => {
    const f = fixture(async () => { throw new Error("secret begin failure"); });
    await expect(f.runtime.openReadOnlySnapshot({ projectId: "project" })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(f.release).toHaveBeenCalledTimes(1);
    await f.runtime.close();
  });

  it("refuses caller project widening and transaction-mode overrides", async () => {
    const f = fixture();
    for (const extra of [{ projectId: "elsewhere" }, { projectIds: ["elsewhere"] }, { transactionMode: "read-committed-read-write" }]) {
      const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
      await expect(session.query({ text: "SELECT forbidden" }, { ...options, ...extra } as PostgreSqlQueryOptions)).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
    }
    expect(f.statements).not.toContain("SELECT forbidden");
    await f.runtime.close();
  });

  it("runtime shutdown closes held sources before ending the pool", async () => {
    const f = fixture();
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    await f.runtime.close();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.end).toHaveBeenCalledTimes(1);
    await expect(session.query({ text: "SELECT late" }, options)).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
    await expect(f.runtime.openReadOnlySnapshot({ projectId: "project" })).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
  });

  it("rejects pre-aborted opens without acquiring a connection", async () => {
    const f = fixture();
    await expect(f.runtime.openReadOnlySnapshot({ projectId: "project", signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(f.connect).not.toHaveBeenCalled();
    await f.runtime.close();
  });

  it("rejects an absent project scope before connection acquisition", async () => {
    const f = fixture();
    await expect(f.runtime.openReadOnlySnapshot({} as PostgreSqlSnapshotOptions)).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
    expect(f.connect).not.toHaveBeenCalled();
    await f.runtime.close();
  });

  it.each([false, true])("releases a late connection while preserving shutdown errors (release failure: %s)", async (releaseFails) => {
    const f = fixture();
    const gate = deferred<PoolClient>();
    f.connect.mockImplementationOnce(() => gate.promise);
    const pending = f.runtime.openReadOnlySnapshot({ projectId: "project" });
    const rejected = expect(pending).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
    await f.runtime.close();
    if (releaseFails) f.release.mockImplementationOnce(() => { throw new Error("private late release failure"); });
    gate.resolve(Object.assign(new EventEmitter(), {
      query: f.query, release: f.release, connection: { stream: { destroy: vi.fn() } },
    }) as unknown as PoolClient);
    await rejected;
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("closes a snapshot whose initialization finishes after runtime shutdown", async () => {
    const begin = deferred<QueryResult<QueryResultRow>>();
    const started = deferred<void>();
    const f = fixture(async (text) => {
      if (text.startsWith("BEGIN")) { started.resolve(); return begin.promise; }
      return result();
    });
    const pending = f.runtime.openReadOnlySnapshot({ projectId: "project" });
    const rejected = expect(pending).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
    await started.promise;
    await f.runtime.close();
    begin.resolve(result());
    await rejected;
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("cleans up a source aborted between acquisition and session construction", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.connect.mockImplementationOnce(async () => {
      queueMicrotask(() => controller.abort());
      return Object.assign(new EventEmitter(), {
        query: f.query, release: f.release, connection: { stream: { destroy: vi.fn() } },
      }) as unknown as PoolClient;
    });
    await expect(f.runtime.openReadOnlySnapshot({ projectId: "project", signal: controller.signal })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(f.release).toHaveBeenCalledTimes(1);
    await f.runtime.close();
  });

  it("rejects invalid backend identity and releases the transaction", async () => {
    const f = fixture(undefined, -1);
    await expect(f.runtime.openReadOnlySnapshot({ projectId: "project" })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(f.statements).toContain("ROLLBACK");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    await f.runtime.close();
  });

  it("normalizes release failure without retrying release", async () => {
    const f = fixture();
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    f.release.mockImplementation(() => { throw new Error("private release failure"); });
    await expect(session.close()).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(f.release).toHaveBeenCalledTimes(1);
    await f.runtime.close();
  });

  it("observes failed cleanup after idle lifetime cancellation", async () => {
    const f = fixture(async (text) => {
      if (text === "ROLLBACK") throw new Error("private rollback failure");
      return result();
    });
    const controller = new AbortController();
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project", signal: controller.signal });
    controller.abort();
    await expect(session.close()).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    await f.runtime.close();
  });

  it("binds per-read cancellation and destroys even when backend cancellation fails", async () => {
    const started = deferred<void>();
    const f = fixture(async (text) => {
      if (text === "SELECT blocked") { started.resolve(); return new Promise(() => undefined); }
      return result();
    });
    f.cancel.mockRejectedValueOnce(new Error("private cancellation failure"));
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    const controller = new AbortController();
    const pending = session.query({ text: "SELECT blocked" }, { ...options, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    await started.promise;
    controller.abort();
    await rejected;
    await session.close();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.statements).not.toContain("ROLLBACK");
    await f.runtime.close();
  });


  it("releases transport without BEGIN when session construction is pre-aborted", async () => {
    const f = fixture();
    await expect(PostgreSqlSnapshotSession.open({
      query: f.query as never,
      rollback: async () => undefined,
      release: f.release,
    }, { projectId: "project", signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    await f.runtime.close();
  });

  it("serializes reads while open without losing results", async () => {
    const blocked = deferred<QueryResult<QueryResultRow>>();
    const started = deferred<void>();
    const f = fixture(async (text) => {
      if (text === "SELECT first") { started.resolve(); return blocked.promise; }
      return result([{ value: 2 }]);
    });
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    const first = session.query({ text: "SELECT first" }, options);
    await started.promise;
    const second = session.query({ text: "SELECT second" }, options);
    expect(f.statements).not.toContain("SELECT second");
    blocked.resolve(result([{ value: 1 }]));
    expect((await first).rows).toEqual([{ value: 1 }]);
    expect((await second).rows).toEqual([{ value: 2 }]);
    await session.close();
    await f.runtime.close();
  });

  it("never reuses source identity across reopened sessions on the same backend", async () => {
    const f = fixture();
    const first = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    await first.close();
    const second = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    expect(second.identity.backendPid).toBe(first.identity.backendPid);
    expect(second.identity.sessionId).not.toBe(first.identity.sessionId);
    await second.close();
    await f.runtime.close();
  });

  it("applies the default snapshotIdleTimeoutMs as SET LOCAL via parameterized set_config when unset", async () => {
    const f = fixture();
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    const setConfigCalls = f.configs.filter((call) => call.text.includes("idle_in_transaction_session_timeout"));
    expect(setConfigCalls).toHaveLength(1);
    expect(setConfigCalls[0]!.values).toEqual([`${DEFAULT_SNAPSHOT_IDLE_TIMEOUT_MS}ms`]);
    expect(setConfigCalls[0]!.text).toContain("set_config");
    expect(setConfigCalls[0]!.text).toContain("$1::pg_catalog.text");
    expect(setConfigCalls[0]!.text).toContain("true");
    expect(setConfigCalls[0]!.text).not.toContain(`${DEFAULT_SNAPSHOT_IDLE_TIMEOUT_MS}`);
    // set_config runs after BEGIN and before the backend-identity query.
    const beginIndex = f.statements.indexOf("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const setConfigIndex = f.statements.findIndex((text) => text.includes("idle_in_transaction_session_timeout"));
    // The exact identity-query text (distinct from queryClient's internal,
    // per-call cancellation-tracking "SELECT pg_backend_pid() AS pid" probe,
    // which lacks the pg_catalog. prefix and precedes every real query).
    const pidIndex = f.statements.indexOf("SELECT pg_catalog.pg_backend_pid() AS pid");
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(setConfigIndex).toBeGreaterThan(beginIndex);
    expect(pidIndex).toBeGreaterThan(setConfigIndex);
    await session.close();
    await f.runtime.close();
  });

  it("honors an explicit snapshotIdleTimeoutMs override from runtime settings", async () => {
    const f = fixture(undefined, 1234, { snapshotIdleTimeoutMs: 1_500 });
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    const setConfigCalls = f.configs.filter((call) => call.text.includes("idle_in_transaction_session_timeout"));
    expect(setConfigCalls).toHaveLength(1);
    expect(setConfigCalls[0]!.values).toEqual(["1500ms"]);
    await session.close();
    await f.runtime.close();
  });

  it.each([0, -1, 1.5, 3_600_001, Number.NaN, Number.POSITIVE_INFINITY])(
    "fails closed for invalid snapshotIdleTimeoutMs %s without ever opening the transaction",
    async (invalid) => {
      const f = fixture(undefined, 1234, { snapshotIdleTimeoutMs: invalid });
      await expect(f.runtime.openReadOnlySnapshot({ projectId: "project" }))
        .rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
      expect(f.statements).not.toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(f.statements.some((text) => text.includes("idle_in_transaction_session_timeout"))).toBe(false);
      await f.runtime.close();
    },
  );

  it("rejects snapshotIdleTimeoutMs of exactly 0, since PostgreSQL treats 0 as disabling the bound", async () => {
    const f = fixture(undefined, 1234, { snapshotIdleTimeoutMs: 0 });
    await expect(f.runtime.openReadOnlySnapshot({ projectId: "project" }))
      .rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
    await f.runtime.close();
  });

  it("fails closed when set_config itself fails, leaving no usable snapshot at the statement-scale bound", async () => {
    const f = fixture(async (text) => {
      if (text.includes("idle_in_transaction_session_timeout")) throw new Error("private set_config driver failure");
      return result();
    });
    await expect(f.runtime.openReadOnlySnapshot({ projectId: "project" }))
      .rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(f.statements).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(f.statements.some((text) => text.includes("idle_in_transaction_session_timeout"))).toBe(true);
    // The real identity query never runs; only queryClient's internal,
    // per-call cancellation-tracking probe (a different, shorter statement
    // lacking the pg_catalog. prefix) precedes BEGIN and set_config.
    expect(f.statements).not.toContain("SELECT pg_catalog.pg_backend_pid() AS pid");
    await f.runtime.close();
  });

  it("marks the session destroyed and skips ROLLBACK when a query fails with 25P03", async () => {
    const f = fixture(async (text) => {
      if (text === "SELECT idle-killed") throw Object.assign(new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" });
      return result();
    });
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    await expect(session.query({ text: "SELECT idle-killed" }, options))
      .rejects.toMatchObject({ sqlState: "25P03" });
    await session.close();
    expect(f.statements).not.toContain("ROLLBACK");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    await f.runtime.close();
  });

  it("captures an async client failure via the checkout listener and skips ROLLBACK on close", async () => {
    // idle_in_transaction_session_timeout fires with no query in flight: on
    // the real driver the FATAL arrives as an 'error' event on the checked-
    // out client, not as a query rejection. The runtime's checkout listener
    // must observe it, mark the session destroyed immediately, and never
    // let it become an unhandled process error.
    const f = fixture();
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    expect(f.clientEvents.listenerCount("error")).toBe(1);
    f.emitClientError(Object.assign(
      new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" },
    ));
    await session.close();
    expect(f.statements).not.toContain("ROLLBACK");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    await f.runtime.close();
  });

  it("reattaches the captured async sqlState to a later query that fails without one", async () => {
    const f = fixture(async (text) => {
      if (text === "SELECT after-kill") {
        throw new Error("Client has encountered a connection error and is not queryable");
      }
      return result();
    });
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    f.emitClientError(Object.assign(
      new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" },
    ));
    // The listener already marked the session destroyed; the driver's own
    // "not queryable" rejection for the next query carries no code at all,
    // but the session reattaches the earlier captured diagnostic so the
    // caller still sees the real, retryable failure instead of a generic
    // code-free one.
    await expect(session.query({ text: "SELECT after-kill" }, options))
      .rejects.toMatchObject({ sqlState: "25P03", retryable: true });
    await session.close();
    expect(f.statements).not.toContain("ROLLBACK");
    await f.runtime.close();
  });

  it("keeps the first captured sqlState across multiple async failures on the same session", async () => {
    const f = fixture(async (text) => {
      if (text === "SELECT late") throw new Error("Connection terminated unexpectedly");
      return result();
    });
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    f.emitClientError(Object.assign(
      new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" },
    ));
    // The socket-end message that typically follows the FATAL carries no
    // code; it must not overwrite the real diagnostic already captured.
    f.emitClientError(new Error("Connection terminated unexpectedly"));
    await expect(session.query({ text: "SELECT late" }, options))
      .rejects.toMatchObject({ sqlState: "25P03", retryable: true });
    await session.close();
    await f.runtime.close();
  });

  it("does not reattach a captured code that is not termination-shaped", async () => {
    // pg never actually emits a client 'error' event carrying an
    // unrelated code such as 40001 in practice (those are query-class
    // rejections, not out-of-band connection events), but the reattach
    // gate must still refuse to launder a hypothetical one into a false
    // termination diagnostic on a later, otherwise-undiagnosed rejection.
    const f = fixture(async (text) => {
      if (text === "SELECT late") throw new Error("Client has encountered a connection error and is not queryable");
      return result();
    });
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    f.emitClientError(Object.assign(new Error("serialization failure"), { code: "40001" }));
    const error = await session.query({ text: "SELECT late" }, options).catch((e: unknown) => e);
    expect(error).toMatchObject({ sqlState: null });
    await session.close();
    await f.runtime.close();
  });

  it("removes the async-failure listener from the client on release", async () => {
    const f = fixture();
    const session = await f.runtime.openReadOnlySnapshot({ projectId: "project" });
    expect(f.clientEvents.listenerCount("error")).toBe(1);
    await session.close();
    expect(f.clientEvents.listenerCount("error")).toBe(0);
    await f.runtime.close();
  });

});
