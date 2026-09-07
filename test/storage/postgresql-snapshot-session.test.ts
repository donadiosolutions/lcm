import type { Client, Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { PostgreSqlSnapshotSession, type PostgreSqlSnapshotOptions } from "../../src/storage/postgresql/snapshot-session.js";
import type { PostgreSqlQueryOptions } from "../../src/storage/postgresql/contracts.js";

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
function fixture(handler: (text: string) => Promise<QueryResult<QueryResultRow>> = async () => result(), backendPid: unknown = 1234) {
  const statements: string[] = [];
  let active: { callback: (error: Error | null, value?: QueryResult<QueryResultRow>) => void } | undefined;
  const query = vi.fn((input: string | { text: string; callback?: (error: Error | null, value?: QueryResult<QueryResultRow>) => void }) => {
    const text = typeof input === "string" ? input : input.text;
    statements.push(text);
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
  const connect = vi.fn(async () => ({ query, release }) as unknown as PoolClient);
  const end = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => {
    active?.callback(new Error("cancelled private query"));
    return result([{ cancelled: true }]);
  });
  const runtime = new PostgreSqlRuntime({
    url: "postgresql://secret", caFile: "/unused", poolMax: 2,
    connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100,
  }, {
    buildConfig: () => ({ ssl: true }),
    createPool: () => ({ connect, end, on: vi.fn() }) as unknown as Pool,
    createClient: () => ({ connect: async () => undefined, query: cancel, end: async () => undefined }) as unknown as Client,
  });
  return { runtime, query, connect, release, end, cancel, statements };
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
    gate.resolve({ query: f.query, release: f.release } as unknown as PoolClient);
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
      return { query: f.query, release: f.release } as unknown as PoolClient;
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

});
