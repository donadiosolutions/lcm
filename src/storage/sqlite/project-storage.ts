import type { DatabaseSync } from "node:sqlite";
import { closeLcmConnection } from "../../db/connection.js";
import type {
  ProjectRepositories,
  ProjectStorage,
  StorageCapabilities,
  StorageHealth,
  TransactionRepositories,
} from "../contracts.js";
import { normalizeStorageError, StorageOperationError } from "../errors.js";
import { SqliteExecutor } from "./executor.js";
import { assertSqliteReady } from "./health.js";
import {
  createSqliteRepositories,
  createSqliteRepositoryStores,
  type SqliteRepositoryStores,
} from "./repositories.js";

export class SqliteProjectStorage implements ProjectStorage {
  readonly backend = "sqlite" as const;
  readonly conversations: ProjectRepositories["conversations"];
  readonly summaries: ProjectRepositories["summaries"];
  readonly context: ProjectRepositories["context"];
  readonly largeFiles: ProjectRepositories["largeFiles"];
  readonly promotedMemory: ProjectRepositories["promotedMemory"];
  readonly recall: ProjectRepositories["recall"];
  readonly redactionAdmin: ProjectRepositories["redactionAdmin"];
  readonly lexicalSearch: ProjectRepositories["lexicalSearch"];
  readonly coordination: ProjectRepositories["coordination"];

  private readonly stores: SqliteRepositoryStores;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    readonly projectId: string,
    private readonly dbPath: string,
    db: DatabaseSync,
    private readonly executor: SqliteExecutor,
    readonly capabilities: StorageCapabilities,
    private readonly onClose: (storage: SqliteProjectStorage) => void,
  ) {
    this.stores = createSqliteRepositoryStores(db, {
      fts5Available: capabilities.nativeFullTextSearch === "available",
    });
    const repositories = createSqliteRepositories(
      this.stores,
      this.projectId,
      async (domain, operation, callback) => {
        this.assertOpen(domain, operation);
        return this.executor.run(domain, operation, callback);
      },
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
    return this.executor.transaction(async (token): Promise<T> => {
      const repositories = createSqliteRepositories(
        this.stores,
        this.projectId,
        (domain, operation, operationCallback) =>
          this.executor.runScoped(token, domain, operation, operationCallback),
      );
      return callback(repositories);
    });
  }

  async health(): Promise<StorageHealth> {
    if (this.closed) {
      return { status: "closed", backend: "sqlite", projectId: this.projectId };
    }
    try {
      await this.executor.run("factory", "health", () => {
        assertSqliteReady(this.stores.db, this.projectId);
      });
      return { status: "healthy", backend: "sqlite", projectId: this.projectId };
    } catch (error) {
      const normalized = normalizeStorageError(error, {
        backend: "sqlite",
        projectId: this.projectId,
        domain: "factory",
        operation: "health",
      });
      return {
        status: "unavailable",
        backend: "sqlite",
        projectId: this.projectId,
        error: normalized,
      };
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const attempt = this.executor
      .run("factory", "close", () => closeLcmConnection(this.dbPath))
      .then((): void => this.onClose(this));
    this.closePromise = attempt.catch((error: unknown): never => {
      this.closed = false;
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  private assertOpen(domain: Parameters<SqliteExecutor["run"]>[0], operation: string): void {
    if (!this.closed) return;
    throw new StorageOperationError("STORAGE_CLOSED", "sqlite", this.projectId, domain, operation);
  }
}
