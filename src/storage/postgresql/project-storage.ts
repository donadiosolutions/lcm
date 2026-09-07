import { PostgreSqlNativeTranscriptRepository } from "./native-transcript-repository.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import type {
  ProjectRepositories,
  ProjectStorage,
  StorageCapabilities,
  StorageDomain,
  StorageHealth,
  TransactionRepositories,
} from "../contracts.js";
import { normalizeStorageError, StorageOperationError } from "../errors.js";
import {
  PostgreSqlConversationRepository,
  type PostgreSqlConversationExecutor,
} from "./conversation-repository.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlTransactionOptions,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";
import {
  PostgreSqlLexicalSearchRepository,
  type PostgreSqlLexicalSearchExecutor,
  type PostgreSqlLexicalSearchScopedExecutor,
} from "./lexical-search-repository.js";
import {
  PostgreSqlCoordinationRepository,
  PostgreSqlPromotedMemoryRepository,
  PostgreSqlRecallRepository,
  PostgreSqlRedactionAdminRepository,
  type PostgreSqlMemoryExecutor,
  type PostgreSqlMemoryScopedExecutor,
} from "./memory-repositories.js";
import type {
  PostgreSqlCoordinationExecutor,
} from "./coordination.js";
import {
  PostgreSqlContextRepository,
  PostgreSqlLargeFileRepository,
  PostgreSqlSummaryRepository,
  type PostgreSqlSummaryContextExecutor,
  type PostgreSqlSummaryContextScopedExecutor,
} from "./summary-context-repositories.js";

export const POSTGRESQL_STORAGE_CAPABILITIES: StorageCapabilities = Object.freeze({
  transactions: true,
  lexicalSearch: true,
  regexSearch: true,
  nativeFullTextSearch: "available",
  coordination: "distributed",
});

export interface PostgreSqlProjectStorageRuntime extends PostgreSqlQueryExecutor {
  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions,
  ): Promise<T>;
}

type PostgreSqlRepositoryRootExecutor =
  & PostgreSqlConversationExecutor
  & PostgreSqlSummaryContextExecutor
  & PostgreSqlMemoryExecutor
  & PostgreSqlLexicalSearchExecutor
  & PostgreSqlCoordinationExecutor;

type PostgreSqlRepositoryScopedExecutor =
  & PostgreSqlSummaryContextScopedExecutor
  & PostgreSqlMemoryScopedExecutor
  & PostgreSqlLexicalSearchScopedExecutor;

type TransactionContext = {
  readonly storage: PostgreSqlProjectStorage;
};

const transactionContext = new AsyncLocalStorage<TransactionContext>();

type BoundSignal = {
  readonly signal: AbortSignal;
  dispose(): void;
};

function bindAbortSignals(
  facadeSignal: AbortSignal,
  operationSignal: AbortSignal | undefined,
): BoundSignal {
  if (operationSignal === undefined || operationSignal === facadeSignal) {
    return { signal: facadeSignal, dispose: () => undefined };
  }
  const controller = new AbortController();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    facadeSignal.removeEventListener("abort", abort);
    operationSignal.removeEventListener("abort", abort);
  };
  const abort = (): void => {
    controller.abort();
    dispose();
  };
  if (facadeSignal.aborted || operationSignal.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => undefined };
  }
  facadeSignal.addEventListener("abort", abort, { once: true });
  operationSignal.addEventListener("abort", abort, { once: true });
  if (facadeSignal.aborted || operationSignal.aborted) abort();
  return { signal: controller.signal, dispose };
}

function settleWithDisposal<T>(
  promise: Promise<T>,
  dispose: () => void,
): Promise<T> {
  return promise.then(
    (value) => {
      dispose();
      return value;
    },
    (error: unknown) => {
      dispose();
      throw error;
    },
  );
}

class SignalBoundRootExecutor implements PostgreSqlRepositoryRootExecutor {
  constructor(
    private readonly runtime: PostgreSqlProjectStorageRuntime,
    private readonly storage: PostgreSqlProjectStorage,
    private readonly signal: AbortSignal,
  ) {}

  query<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    this.storage.assertRootOperation(options.domain, options.operation);
    const bound = bindAbortSignals(this.signal, options.signal);
    try {
      return settleWithDisposal(
        this.storage.track(() => this.runtime.query<R, I>(config, {
          ...options,
          signal: bound.signal,
        })),
        bound.dispose,
      );
    } catch (error) {
      bound.dispose();
      throw error;
    }
  }

  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions & {
      readonly domain: "conversations";
      readonly projectId: string;
    },
  ): Promise<T>;
  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions & {
      readonly projectId: string;
    },
  ): Promise<T>;
  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions & {
      readonly domain: "promoted-memory" | "recall" | "redaction-admin" | "coordination";
      readonly projectId: string;
    },
  ): Promise<T>;
  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlOperationContext & {
      readonly domain: "lexical-search";
      readonly projectId: string;
    },
  ): Promise<T>;
  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions & {
      readonly domain: "coordination";
      readonly projectId: string;
      readonly machineId: string;
    },
  ): Promise<T>;
  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions,
  ): Promise<T> {
    this.storage.assertRootOperation(options.domain, options.operation);
    const bound = bindAbortSignals(this.signal, options.signal);
    try {
      return settleWithDisposal(
        this.storage.track(() => this.runtime.transaction(callback, {
          ...options,
          signal: bound.signal,
        })),
        bound.dispose,
      );
    } catch (error) {
      bound.dispose();
      throw error;
    }
  }
}

class RevocableQueryExecutor implements PostgreSqlQueryExecutor {
  constructor(
    private readonly executor: PostgreSqlQueryExecutor,
    protected readonly storage: PostgreSqlProjectStorage,
    protected readonly signal: AbortSignal,
    private readonly isActive: () => boolean,
  ) {}

  query<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    this.assertActive(options);
    const bound = bindAbortSignals(this.signal, options.signal);
    try {
      return settleWithDisposal(
        this.executor.query<R, I>(config, { ...options, signal: bound.signal }),
        bound.dispose,
      );
    } catch (error) {
      bound.dispose();
      throw error;
    }
  }

  protected assertActive(options: PostgreSqlOperationContext): void {
    if (this.isActive()) return;
    throw new StorageOperationError(
      "STORAGE_TRANSACTION_SCOPE",
      "postgresql",
      this.storage.projectId,
      options.domain,
      options.operation,
    );
  }
}

class RevocableScopedExecutor
extends RevocableQueryExecutor
implements PostgreSqlRepositoryScopedExecutor {
  readonly transactionScope = "active" as const;

  constructor(
    private readonly scoped: PostgreSqlTransactionScopeExecutor,
    storage: PostgreSqlProjectStorage,
    signal: AbortSignal,
    private readonly state: { active: boolean } = { active: true },
  ) {
    super(scoped, storage, signal, () => state.active);
  }

  revoke(): void {
    this.state.active = false;
  }

  savepoint<T>(
    callback: (savepoint: PostgreSqlQueryExecutor) => Promise<T>,
    options: PostgreSqlQueryOptions,
  ): Promise<T> {
    this.assertActive(options);
    const bound = bindAbortSignals(this.signal, options.signal);
    return settleWithDisposal(
      Promise.resolve().then(() => this.scoped.savepoint(
        (savepoint) => callback(new RevocableQueryExecutor(
          savepoint,
          this.storage,
          this.signal,
          () => this.state.active,
        )),
        { ...options, signal: bound.signal },
      )),
      bound.dispose,
    );
  }
}

function createRepositories(
  executor: PostgreSqlRepositoryRootExecutor | PostgreSqlRepositoryScopedExecutor,
  projectId: string,
  machineId: string,
  signal: AbortSignal,
): ProjectRepositories {
  return Object.freeze({
    conversations: new PostgreSqlConversationRepository(executor, projectId),
    summaries: new PostgreSqlSummaryRepository(executor, projectId, { signal }),
    context: new PostgreSqlContextRepository(executor, projectId, { signal }),
    largeFiles: new PostgreSqlLargeFileRepository(executor, projectId, { signal }),
    promotedMemory: new PostgreSqlPromotedMemoryRepository(executor, projectId),
    recall: new PostgreSqlRecallRepository(executor, projectId),
    redactionAdmin: new PostgreSqlRedactionAdminRepository(executor, projectId),
    lexicalSearch: new PostgreSqlLexicalSearchRepository(executor, projectId),
    coordination: new PostgreSqlCoordinationRepository(executor, projectId, machineId),
  });
}

export class PostgreSqlProjectStorage implements ProjectStorage {
  readonly backend = "postgresql" as const;
  readonly capabilities = POSTGRESQL_STORAGE_CAPABILITIES;
  readonly nativeTranscripts: NonNullable<ProjectStorage["nativeTranscripts"]>;
  readonly conversations: ProjectRepositories["conversations"];
  readonly summaries: ProjectRepositories["summaries"];
  readonly context: ProjectRepositories["context"];
  readonly largeFiles: ProjectRepositories["largeFiles"];
  readonly promotedMemory: ProjectRepositories["promotedMemory"];
  readonly recall: ProjectRepositories["recall"];
  readonly redactionAdmin: ProjectRepositories["redactionAdmin"];
  readonly lexicalSearch: ProjectRepositories["lexicalSearch"];
  readonly coordination: ProjectRepositories["coordination"];

  private readonly abortController = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly rootExecutor: SignalBoundRootExecutor;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly runtime: PostgreSqlProjectStorageRuntime,
    readonly projectId: string,
    readonly machineId: string,
    private readonly onClose: (
      storage: ProjectStorage,
    ) => void | Promise<void>,
  ) {
    this.rootExecutor = new SignalBoundRootExecutor(
      runtime,
      this,
      this.abortController.signal,
    );
    this.nativeTranscripts = Object.freeze({
      machineId,
      repository: new PostgreSqlNativeTranscriptRepository(this.rootExecutor, projectId),
    });
    const repositories = createRepositories(
      this.rootExecutor,
      projectId,
      machineId,
      this.abortController.signal,
    );
    this.conversations = repositories.conversations;
    this.summaries = repositories.summaries;
    this.context = repositories.context;
    this.largeFiles = repositories.largeFiles;
    this.promotedMemory = repositories.promotedMemory;
    this.recall = repositories.recall;
    this.redactionAdmin = repositories.redactionAdmin;
    this.lexicalSearch = repositories.lexicalSearch;
    this.coordination = repositories.coordination;
  }

  async transaction<T>(
    callback: (repositories: TransactionRepositories) => Promise<T>,
  ): Promise<T> {
    this.assertOpen("transaction", "transaction");
    if (transactionContext.getStore() !== undefined) {
      throw new StorageOperationError(
        "STORAGE_NESTED_TRANSACTION",
        "postgresql",
        this.projectId,
        "transaction",
        "transaction",
      );
    }
    return await this.rootExecutor.transaction(async (transaction) => {
      const scoped = new RevocableScopedExecutor(
        transaction,
        this,
        this.abortController.signal,
      );
      const repositories = createRepositories(
        scoped,
        this.projectId,
        this.machineId,
        this.abortController.signal,
      );
      try {
        return await transactionContext.run(
          { storage: this },
          () => callback(repositories),
        );
      } finally {
        scoped.revoke();
      }
    }, {
      domain: "transaction",
      operation: "transaction",
      projectId: this.projectId,
      signal: this.abortController.signal,
      transactionMode: "read-committed-read-write",
    });
  }

  async health(): Promise<StorageHealth> {
    if (this.closed) {
      return { status: "closed", backend: "postgresql", projectId: this.projectId };
    }
    let candidate: StorageHealth;
    try {
      await this.rootExecutor.query({ text: "SELECT 1" }, {
        domain: "factory",
        operation: "health",
        projectId: this.projectId,
      });
      candidate = { status: "healthy", backend: "postgresql", projectId: this.projectId };
    } catch (error) {
      candidate = {
        status: "unavailable",
        backend: "postgresql",
        projectId: this.projectId,
        error: normalizeStorageError(error, {
          backend: "postgresql",
          projectId: this.projectId,
          domain: "factory",
          operation: "health",
        }),
      };
    }
    if (this.closed) {
      return { status: "closed", backend: "postgresql", projectId: this.projectId };
    }
    return candidate;
  }

  close(): Promise<void> {
    if (transactionContext.getStore()?.storage === this) {
      return Promise.reject(new StorageOperationError(
        "STORAGE_TRANSACTION_SCOPE",
        "postgresql",
        this.projectId,
        "factory",
        "close",
      ));
    }
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.abortController.abort();
    const attempt = Promise.allSettled([...this.operations])
      .then(() => this.onClose(this))
      .then(() => undefined);
    this.closePromise = attempt.catch((error: unknown): never => {
      this.closePromise = undefined;
      throw normalizeStorageError(error, {
        backend: "postgresql",
        projectId: this.projectId,
        domain: "factory",
        operation: "close",
      });
    });
    return this.closePromise;
  }

  assertRootOperation(domain: StorageDomain, operation: string): void {
    this.assertOpen(domain, operation);
    if (transactionContext.getStore()?.storage !== this) return;
    throw new StorageOperationError(
      "STORAGE_TRANSACTION_SCOPE",
      "postgresql",
      this.projectId,
      domain,
      operation,
    );
  }

  track<T>(start: () => Promise<T>): Promise<T> {
    this.assertOpen("factory", "operation");
    const operation = start();
    this.operations.add(operation);
    const remove = (): void => { this.operations.delete(operation); };
    operation.then(remove, remove);
    return operation;
  }

  private assertOpen(domain: StorageDomain, operation: string): void {
    if (!this.closed) return;
    throw new StorageOperationError(
      "STORAGE_CLOSED",
      "postgresql",
      this.projectId,
      domain,
      operation,
    );
  }
}
