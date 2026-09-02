import { describe, expect, it } from "vitest";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import {
  PostgreSqlProjectStorage,
  type PostgreSqlProjectStorageRuntime,
  type PostgreSqlQueryOptions,
  type PostgreSqlTransactionOptions,
  type PostgreSqlTransactionScopeExecutor,
} from "../../src/storage/postgresql/index.js";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";

const PROJECT_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const MACHINE_ID = "0195d250-0000-7000-8000-000000000002";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

class FakeTransactionScope implements PostgreSqlTransactionScopeExecutor {
  readonly transactionScope = "active" as const;
  readonly querySignals: AbortSignal[] = [];
  readonly savepointSignals: AbortSignal[] = [];

  constructor(
    private readonly queryImplementation: <R extends QueryResultRow>(
      config: QueryConfig,
      options: PostgreSqlQueryOptions,
    ) => Promise<QueryResult<R>> = async () => result<R>([]),
  ) {}

  query<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    if (options.signal) this.querySignals.push(options.signal);
    return this.queryImplementation<R>(config, options);
  }

  async savepoint<T>(
    callback: (savepoint: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlQueryOptions,
  ): Promise<T> {
    if (options.signal) this.savepointSignals.push(options.signal);
    return callback(this);
  }
}

class FakeRuntime implements PostgreSqlProjectStorageRuntime {
  readonly transactions: PostgreSqlTransactionOptions[] = [];
  readonly transactionScopes: FakeTransactionScope[] = [];
  readonly queryConfigs: QueryConfig[] = [];
  readonly queryOptions: PostgreSqlQueryOptions[] = [];

  constructor(
    private readonly queryImplementation: <R extends QueryResultRow>(
      config: QueryConfig,
      options: PostgreSqlQueryOptions,
    ) => Promise<QueryResult<R>> = async () => result<R>([]),
  ) {}

  query<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    this.queryConfigs.push(config);
    this.queryOptions.push(options);
    return this.queryImplementation<R>(config, options);
  }

  async transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions,
  ): Promise<T> {
    this.transactions.push(options);
    const scope = new FakeTransactionScope(this.queryImplementation);
    this.transactionScopes.push(scope);
    return callback(scope);
  }
}

describe("PostgreSqlProjectStorage", () => {
  it("aborts and awaits a coordination repository operation with project and machine identity", async () => {
    let queryObserved!: () => void;
    const observed = new Promise<void>((resolve) => { queryObserved = resolve; });
    let operationRejected!: (error: unknown) => void;
    const runtime = new FakeRuntime(async (_config, options) => {
      queryObserved();
      await new Promise<never>((_resolve, reject) => {
        operationRejected = reject;
        options.signal?.addEventListener("abort", () => {
          reject(new PostgreSqlStorageOperationError(
            "STORAGE_OPERATION_FAILED",
            {
              domain: options.domain,
              operation: options.operation,
              projectId: options.projectId,
              machineId: options.machineId,
            },
            null,
            false,
          ));
        }, { once: true });
      });
    });
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );
    const operation = storage.coordination.getSessionIngest("session-secret");
    await observed;
    const closing = storage.close();
    await expect(operation).rejects.toMatchObject({
      projectId: PROJECT_ID,
      domain: "coordination",
      operation: "getSessionIngest",
      machineId: MACHINE_ID,
      sqlState: null,
      retryable: false,
    });
    await expect(closing).resolves.toBeUndefined();
    expect(runtime.queryConfigs).toHaveLength(1);
    expect(runtime.queryOptions[0]).toMatchObject({
      domain: "coordination",
      operation: "getSessionIngest",
      projectId: PROJECT_ID,
      machineId: MACHINE_ID,
      signal: expect.any(AbortSignal),
    });
    const serialized = JSON.stringify(await operation.catch((error) => error));
    expect(Object.keys(JSON.parse(serialized)).sort()).toEqual([
      "backend",
      "code",
      "domain",
      "machineId",
      "message",
      "name",
      "operation",
      "projectId",
      "retryable",
      "sqlState",
    ]);
    for (const canary of [
      "session-secret",
      "SELECT ingest_key",
      "private driver cancellation",
      "postgres://private",
      "10.0.0.8",
      "bound-resource",
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(operationRejected).toBeDefined();
  });

  it("composes the complete public project repository facade", async () => {
    const runtime = new FakeRuntime();
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );

    const repositoryKeys = [
      "conversations",
      "summaries",
      "context",
      "largeFiles",
      "promotedMemory",
      "recall",
      "redactionAdmin",
      "lexicalSearch",
      "coordination",
    ] as const;
    const rootRepositories = repositoryKeys.map((key) => storage[key]);

    expect(rootRepositories.every(Boolean)).toBe(true);
    expect(new Set(rootRepositories).size).toBe(repositoryKeys.length);
    expect(storage).toMatchObject({
      backend: "postgresql",
      projectId: PROJECT_ID,
      machineId: MACHINE_ID,
      capabilities: {
        transactions: true,
        lexicalSearch: true,
        regexSearch: true,
        nativeFullTextSearch: "available",
        coordination: "distributed",
      },
    });
    expect(Object.isFrozen(storage.capabilities)).toBe(true);

    await storage.transaction(async (repositories) => {
      const scopedRepositories = repositoryKeys.map((key) => repositories[key]);
      expect(scopedRepositories.every(Boolean)).toBe(true);
      expect(new Set(scopedRepositories).size).toBe(repositoryKeys.length);
      expect(scopedRepositories.every((repository, index) => (
        repository !== rootRepositories[index]
      ))).toBe(true);
    });
    expect(runtime.transactions).toEqual([{
      domain: "transaction",
      operation: "transaction",
      projectId: PROJECT_ID,
      signal: expect.any(AbortSignal),
      transactionMode: "read-committed-read-write",
    }]);
  });

  it("revokes retained repositories and rejects nested or root-scope reuse", async () => {
    const runtime = new FakeRuntime();
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );
    let retained!: Parameters<Parameters<typeof storage.transaction>[0]>[0];

    await storage.transaction(async (repositories) => {
      retained = repositories;
      await expect(storage.conversations.listConversations())
        .rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
      await expect(storage.transaction(async () => undefined))
        .rejects.toMatchObject({ code: "STORAGE_NESTED_TRANSACTION" });
      expect(await repositories.conversations.listConversations()).toEqual([]);
      await expect(storage.close())
        .rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
    });

    await expect(retained.conversations.listConversations())
      .rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
  });

  it("allows sibling root work while fencing cross-project transactions", async () => {
    const first = new PostgreSqlProjectStorage(
      new FakeRuntime(),
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );
    const sibling = new PostgreSqlProjectStorage(
      new FakeRuntime(),
      "0195d250-0000-7000-8000-000000000004",
      MACHINE_ID,
      () => undefined,
    );

    await first.transaction(async () => {
      await expect(sibling.conversations.listConversations()).resolves.toEqual([]);
      await expect(sibling.health()).resolves.toMatchObject({ status: "healthy" });
      await expect(sibling.transaction(async () => undefined))
        .rejects.toMatchObject({ code: "STORAGE_NESTED_TRANSACTION" });
      await expect(sibling.close()).resolves.toBeUndefined();
    });
  });

  it("shares one scoped executor identity across each repository family", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runtime = new FakeRuntime(async (config) => {
      if (config.text.includes("ORDER BY created_at, conversation_id")) {
        events.push("conversation-start");
        await firstBlocked;
        events.push("conversation-end");
      } else if (config.text.includes("session_id = $2")) {
        events.push("second-conversation");
      }
      return result([]);
    });
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );

    await storage.transaction(async (repositories) => {
      const first = repositories.conversations.listConversations();
      const second = repositories.conversations.getConversationBySessionId(
        "session-a",
      );
      await Promise.resolve();
      expect(events).toEqual(["conversation-start"]);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual([
        "conversation-start",
        "conversation-end",
        "second-conversation",
      ]);
    });
  });

  it("forwards savepoints through a shared revocable scoped wrapper", async () => {
    const runtime = new FakeRuntime();
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );

    await storage.transaction(async (repositories) => {
      await Promise.all([
        repositories.largeFiles.insertLargeFile({
          fileId: "missing-a",
          conversationId: 41,
          storageUri: "local:a",
        }),
        repositories.promotedMemory.deleteById(
          "0195d250-0000-7000-8000-000000000003",
        ),
        repositories.lexicalSearch.searchMessages({
          query: "needle",
          mode: "regex",
        }),
      ]);
    }).catch(() => undefined);

    expect(runtime.transactionScopes[0]?.savepointSignals.length).toBeGreaterThan(0);
  });

  it("reports project health and sanitizes query failures", async () => {
    const healthy = new PostgreSqlProjectStorage(
      new FakeRuntime(),
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );
    expect(await healthy.health()).toEqual({
      status: "healthy",
      backend: "postgresql",
      projectId: PROJECT_ID,
    });

    const failed = new PostgreSqlProjectStorage(
      new FakeRuntime(async () => { throw new Error("postgres://secret@db/raw sql"); }),
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );
    const health = await failed.health();
    expect(health).toMatchObject({
      status: "unavailable",
      backend: "postgresql",
      projectId: PROJECT_ID,
      error: {
        code: "STORAGE_OPERATION_FAILED",
        domain: "factory",
        operation: "health",
      },
    });
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  it("dominates a successful health probe when close begins", async () => {
    let releaseQuery!: () => void;
    let probeEntered!: () => void;
    const queryReleased = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const entered = new Promise<void>((resolve) => { probeEntered = resolve; });
    let onCloseCalls = 0;
    const runtime = new FakeRuntime(async () => {
      probeEntered();
      await queryReleased;
      return result([]);
    });
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => { onCloseCalls += 1; },
    );

    const health = storage.health();
    await entered;
    const firstClose = storage.close();
    expect(storage.close()).toBe(firstClose);
    expect(runtime.queryConfigs).toEqual([{ text: "SELECT 1" }]);
    expect(runtime.queryOptions).toHaveLength(1);
    expect(runtime.queryOptions[0]).toMatchObject({
      domain: "factory",
      operation: "health",
      projectId: PROJECT_ID,
      signal: expect.any(AbortSignal),
    });
    expect(runtime.queryOptions[0]?.signal?.aborted).toBe(true);
    let closeSettled = false;
    void firstClose.finally(() => { closeSettled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(onCloseCalls).toBe(0);

    releaseQuery();
    await expect(health).resolves.toEqual({
      status: "closed",
      backend: "postgresql",
      projectId: PROJECT_ID,
    });
    await firstClose;
    expect(onCloseCalls).toBe(1);
  });

  it("dominates a sanitized health rejection when close begins", async () => {
    let releaseQuery!: () => void;
    let probeEntered!: () => void;
    const queryReleased = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const entered = new Promise<void>((resolve) => { probeEntered = resolve; });
    let onCloseCalls = 0;
    const runtime = new FakeRuntime(async () => {
      probeEntered();
      await queryReleased;
      throw new Error("private query detail");
    });
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => { onCloseCalls += 1; },
    );

    const health = storage.health();
    await entered;
    const firstClose = storage.close();
    expect(storage.close()).toBe(firstClose);
    expect(runtime.queryConfigs).toEqual([{ text: "SELECT 1" }]);
    expect(runtime.queryOptions).toHaveLength(1);
    expect(runtime.queryOptions[0]).toMatchObject({
      domain: "factory",
      operation: "health",
      projectId: PROJECT_ID,
      signal: expect.any(AbortSignal),
    });
    expect(runtime.queryOptions[0]?.signal?.aborted).toBe(true);
    let closeSettled = false;
    void firstClose.finally(() => { closeSettled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(onCloseCalls).toBe(0);

    releaseQuery();
    await expect(health).resolves.toEqual({
      status: "closed",
      backend: "postgresql",
      projectId: PROJECT_ID,
    });
    await firstClose;
    expect(onCloseCalls).toBe(1);
  });

  it("waits for an abort-aware health probe before returning closed", async () => {
    let releaseRejection!: () => void;
    let probeEntered!: () => void;
    let abortObserved!: () => void;
    const rejectionReleased = new Promise<void>((resolve) => { releaseRejection = resolve; });
    const entered = new Promise<void>((resolve) => { probeEntered = resolve; });
    const aborted = new Promise<void>((resolve) => { abortObserved = resolve; });
    let onCloseCalls = 0;
    const runtime = new FakeRuntime(async (_config, options) => {
      probeEntered();
      options.signal?.addEventListener("abort", () => { abortObserved(); }, { once: true });
      await rejectionReleased;
      throw new Error("private abort detail");
    });
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => { onCloseCalls += 1; },
    );

    const health = storage.health();
    await entered;
    const firstClose = storage.close();
    expect(storage.close()).toBe(firstClose);
    await aborted;
    expect(runtime.queryConfigs).toEqual([{ text: "SELECT 1" }]);
    expect(runtime.queryOptions).toHaveLength(1);
    expect(runtime.queryOptions[0]).toMatchObject({
      domain: "factory",
      operation: "health",
      projectId: PROJECT_ID,
      signal: expect.any(AbortSignal),
    });
    expect(runtime.queryOptions[0]?.signal?.aborted).toBe(true);
    let closeSettled = false;
    void firstClose.finally(() => { closeSettled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(onCloseCalls).toBe(0);

    releaseRejection();
    await expect(health).resolves.toEqual({
      status: "closed",
      backend: "postgresql",
      projectId: PROJECT_ID,
    });
    await firstClose;
    expect(onCloseCalls).toBe(1);
  });

  it("aborts and awaits only its own work before unregistering", async () => {
    let resolveFirst!: () => void;
    let observedSignal: AbortSignal | undefined;
    const firstQuery = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const runtime = new FakeRuntime(async (_config, options) => {
      observedSignal = options.signal;
      await firstQuery;
      return result([]);
    });
    let unregisterAttempts = 0;
    let failUnregister = true;
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => {
        unregisterAttempts += 1;
        if (failUnregister) throw new Error("private unregister failure");
      },
    );
    const sibling = new PostgreSqlProjectStorage(
      new FakeRuntime(),
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );
    const operation = storage.conversations.listConversations();
    await Promise.resolve();

    const firstClose = storage.close();
    expect(observedSignal?.aborted).toBe(true);
    let closeSettled = false;
    void firstClose.finally(() => { closeSettled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    resolveFirst();
    await operation;
    await expect(firstClose).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      domain: "factory",
      operation: "close",
    });
    expect(unregisterAttempts).toBe(1);
    expect(await storage.health()).toMatchObject({ status: "closed" });
    expect(await sibling.health()).toMatchObject({ status: "healthy" });
    await expect(storage.conversations.listConversations())
      .rejects.toMatchObject({ code: "STORAGE_CLOSED" });

    failUnregister = false;
    const retry = storage.close();
    expect(storage.close()).toBe(retry);
    await retry;
    expect(unregisterAttempts).toBe(2);
    await sibling.close();
  });

  it("combines and disposes operation signals on success and failure", async () => {
    const operation = new AbortController();
    const runtime = new FakeRuntime();
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );

    await runtime.query({ text: "SELECT 1" }, {
      domain: "factory",
      operation: "direct-control",
      signal: operation.signal,
    });
    await storage.transaction(async (repositories) => {
      await repositories.conversations.listConversations();
    });
    expect(runtime.transactions[0]?.signal).toBeInstanceOf(AbortSignal);
    await expect(storage.summaries.getSummary("summary-a")).resolves.toBeNull();

    const failing = new PostgreSqlProjectStorage(
      new FakeRuntime(() => { throw new Error("private"); }),
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );
    await expect(failing.conversations.listConversations()).rejects.toThrow("private");
  });

  it("normalizes synchronous executor failures at every wrapper boundary", async () => {
    const rootTransactionFailure = new PostgreSqlProjectStorage({
      query: () => Promise.resolve(result([])),
      transaction: () => { throw new Error("root transaction"); },
    }, PROJECT_ID, MACHINE_ID, () => undefined);
    await expect(rootTransactionFailure.transaction(async () => undefined))
      .rejects.toThrow("root transaction");

    const queryScope: PostgreSqlTransactionScopeExecutor = {
      transactionScope: "active",
      query: () => { throw new Error("scoped query"); },
      savepoint: async (callback) => callback({
        query: () => Promise.resolve(result([])),
      }),
    };
    const scopedQueryFailure = new PostgreSqlProjectStorage({
      query: () => Promise.resolve(result([])),
      transaction: (callback) => callback(queryScope),
    }, PROJECT_ID, MACHINE_ID, () => undefined);
    await scopedQueryFailure.transaction(async (repositories) => {
      await expect(repositories.conversations.listConversations())
        .rejects.toThrow("scoped query");
    });

    const savepointScope: PostgreSqlTransactionScopeExecutor = {
      transactionScope: "active",
      query: () => Promise.resolve(result([])),
      savepoint: () => { throw new Error("scoped savepoint"); },
    };
    const scopedSavepointFailure = new PostgreSqlProjectStorage({
      query: () => Promise.resolve(result([])),
      transaction: (callback) => callback(savepointScope),
    }, PROJECT_ID, MACHINE_ID, () => undefined);
    await scopedSavepointFailure.transaction(async (repositories) => {
      await expect(repositories.largeFiles.insertLargeFile({
        fileId: "file-a",
        conversationId: 41,
        storageUri: "local:a",
      })).rejects.toBeDefined();
    });

    const innerQueryScope: PostgreSqlTransactionScopeExecutor = {
      transactionScope: "active",
      query: () => Promise.resolve(result([])),
      savepoint: async (callback) => callback({
        query: () => { throw new Error("inner query"); },
      }),
    };
    const innerQueryFailure = new PostgreSqlProjectStorage({
      query: () => Promise.resolve(result([])),
      transaction: (callback) => callback(innerQueryScope),
    }, PROJECT_ID, MACHINE_ID, () => undefined);
    await innerQueryFailure.transaction(async (repositories) => {
      await expect(repositories.largeFiles.insertLargeFile({
        fileId: "file-b",
        conversationId: 42,
        storageUri: "local:b",
      })).rejects.toBeDefined();
      await expect(repositories.lexicalSearch.searchMessages({
        query: "needle",
        mode: "regex",
      })).rejects.toBeDefined();
    });
  });

  it("combines repository signals and disposes them for every outcome", async () => {
    const runtime = new FakeRuntime(async () => result([]));
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );
    const operation = new AbortController();

    await storage.coordination.acquireLease({
      resourceType: "test",
      resourceKey: "success",
      processId: "pid",
      operation: "lease",
      ttlMs: 1000,
      signal: operation.signal,
    });
    expect(runtime.transactions.at(-1)?.signal).not.toBe(operation.signal);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await storage.coordination.acquireLease({
      resourceType: "test",
      resourceKey: "aborted",
      processId: "pid",
      operation: "lease",
      ttlMs: 1000,
      signal: alreadyAborted.signal,
    });
    expect(runtime.transactions.at(-1)?.signal?.aborted).toBe(true);

    let rejectQuery!: (error: Error) => void;
    const failedQuery = new Promise<QueryResult<QueryResultRow>>((_, reject) => {
      rejectQuery = reject;
    });
    const failingRuntime = new FakeRuntime(async () => failedQuery);
    const failingStorage = new PostgreSqlProjectStorage(
      failingRuntime,
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );
    const failedOperation = failingStorage.coordination.acquireLease({
      resourceType: "test",
      resourceKey: "failure",
      processId: "pid",
      operation: "lease",
      ttlMs: 1000,
      signal: operation.signal,
    });
    rejectQuery(new Error("private"));
    await expect(failedOperation).rejects.toBeDefined();
  });

  it("aborts combined operation signals and tolerates repeated disposal", async () => {
    let resolveQuery!: () => void;
    let combined!: AbortSignal;
    const pending = new Promise<void>((resolve) => { resolveQuery = resolve; });
    const runtime = new FakeRuntime(async (_config, options) => {
      combined = options.signal!;
      await pending;
      return result([]);
    });
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );
    const operation = new AbortController();
    const lease = storage.coordination.acquireLease({
      resourceType: "test",
      resourceKey: "abort",
      processId: "pid",
      operation: "lease",
      ttlMs: 1000,
      signal: operation.signal,
    });
    await Promise.resolve();
    operation.abort();
    expect(combined.aborted).toBe(true);
    operation.abort();
    resolveQuery();
    await lease;
  });

  it("closes the abort-listener installation race", async () => {
    const operation = new AbortController();
    const addEventListener = operation.signal.addEventListener
      .bind(operation.signal);
    Object.defineProperty(operation.signal, "addEventListener", {
      configurable: true,
      value: (...args: Parameters<AbortSignal["addEventListener"]>): void => {
        addEventListener(...args);
        operation.abort();
      },
    });
    const runtime = new FakeRuntime();
    const storage = new PostgreSqlProjectStorage(
      runtime,
      PROJECT_ID,
      MACHINE_ID,
      () => undefined,
    );

    await storage.coordination.acquireLease({
      resourceType: "test",
      resourceKey: "listener-race",
      processId: "pid",
      operation: "lease",
      ttlMs: 1000,
      signal: operation.signal,
    });
    expect(runtime.transactions.at(-1)?.signal?.aborted).toBe(true);
  });
});
