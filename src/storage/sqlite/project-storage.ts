import { AsyncLocalStorage } from "node:async_hooks";
import {
  assertBackendPublicationConsumerAccess,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationLockToken,
} from "../backend-publication.js";
import { SqliteNativeTranscriptRepository } from "./native-transcript-repository.js";
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
import type { SqliteOperationAdmission } from "./executor.js";
import { assertSqliteReady, SqliteReadinessRollbackError } from "./health.js";
import {
  createSqliteRepositories,
  createSqliteRepositoryStores,
  type SqliteRepositoryStores,
  type RepositoryInvoker,
} from "./repositories.js";

export class SqliteProjectStorage implements ProjectStorage {
  readonly backend = "sqlite" as const;
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

  private readonly operationAdmission = new AsyncLocalStorage<SqliteOperationAdmission>();
  private readonly stores: SqliteRepositoryStores;
  private closeState: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;
  private releaseCommitted = false;

  constructor(
    readonly projectId: string,
    private readonly dbPath: string,
    db: DatabaseSync,
    private readonly executor: SqliteExecutor,
    readonly capabilities: StorageCapabilities,
    private readonly onClose: (storage: SqliteProjectStorage) => void,
    private readonly admission?: SqliteOperationAdmission,
  ) {
    this.stores = createSqliteRepositoryStores(db, {
      fts5Available: capabilities.nativeFullTextSearch === "available",
    });
    const invoke: RepositoryInvoker = async (domain, operation, callback, atomic) => {
      this.assertOpen(domain, operation);
      return atomic
        ? this.executor.runAtomic(domain, operation, callback, this.operationAdmission.getStore() ?? this.admission)
        : this.executor.run(domain, operation, callback, this.operationAdmission.getStore() ?? this.admission);
    };
    this.nativeTranscripts = Object.freeze({
      machineId: "local",
      repository: new SqliteNativeTranscriptRepository(db, projectId, invoke),
    });
    const repositories = createSqliteRepositories(this.stores, this.projectId, invoke);
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

  /** Use the caller's live token only for this handle's current operation. */
  withPublicationAdmission<T>(
    lockToken: BackendPublicationLockToken,
    callback: () => T,
  ): T {
    if (this.admission?.homeDir !== undefined) {
      assertBackendPublicationConsumerAccess({
        homeDir: this.admission.homeDir, backend: "sqlite", lockToken,
      });
    }
    return this.operationAdmission.run({ ...this.admission, lockToken }, callback);
  }

  async transaction<T>(
    callback: (repositories: TransactionRepositories) => Promise<T>,
  ): Promise<T> {
    this.assertOpen("transaction", "transaction");
    return this.executor.transaction(async (token): Promise<T> => {
      const repositories = createSqliteRepositories(
        this.stores,
        this.projectId,
        (domain, operation, operationCallback, atomic) =>
          atomic
            ? this.executor.runAtomicScoped(token, domain, operation, operationCallback)
            : this.executor.runScoped(token, domain, operation, operationCallback),
      );
      return callback(repositories);
    }, this.operationAdmission.getStore() ?? this.admission);
  }

  /** Factory probes may outlive the publication scope that opened this handle. */
  healthWithFreshAdmission(): Promise<StorageHealth> {
    return this.operationAdmission.run({ homeDir: this.admission?.homeDir }, () => this.health());
  }

  async health(): Promise<StorageHealth> {
    if (this.closeState !== "open") {
      return { status: "closed", backend: "sqlite", projectId: this.projectId };
    }
    let candidate: StorageHealth;
    try {
      await this.executor.run("factory", "health", () => {
        try {
          assertSqliteReady(this.stores.db, this.projectId);
        } catch (error) {
          if (error instanceof SqliteReadinessRollbackError) {
            this.executor.poison();
          }
          throw error;
        }
      }, this.operationAdmission.getStore() ?? this.admission);
      candidate = { status: "healthy", backend: "sqlite", projectId: this.projectId };
    } catch (error) {
      const normalized = normalizeStorageError(error, {
        backend: "sqlite",
        projectId: this.projectId,
        domain: "factory",
        operation: "health",
      });
      candidate = {
        status: "unavailable",
        backend: "sqlite",
        projectId: this.projectId,
        error: normalized,
      };
    }
    if (this.closeState !== "open") {
      return { status: "closed", backend: "sqlite", projectId: this.projectId };
    }
    return candidate;
  }

  close(publicationLockToken?: BackendPublicationLockToken): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeState = "closing";
    const currentAdmission = this.operationAdmission.getStore();
    const currentLockToken = publicationLockToken ?? currentAdmission?.lockToken;
    const appendBarrierOptions = currentAdmission?._appendBarrierOptions
      ?? this.admission?._appendBarrierOptions;
    const release = (): void => {
      closeLcmConnection(this.dbPath, this.stores.db);
      this.releaseCommitted = true;
    };
    const admittedRelease = async (): Promise<void> => {
      try {
        if (this.admission?.homeDir === undefined) {
          release();
          return;
        }
        await withBackendPublicationAppendBarrierAsync(
          this.admission.homeDir,
          release,
          currentLockToken,
          { contentionWaitMs: 5_000, ...appendBarrierOptions },
        );
      } catch (error) {
        if (this.releaseCommitted) throw error;
        throw new StorageOperationError(
          "STORAGE_OPERATION_FAILED",
          "sqlite",
          this.projectId,
          "factory",
          "close",
          { retryable: true },
        );
      }
    };
    const attempt = this.closeOnce(admittedRelease);
    this.closePromise = attempt.catch((error: unknown): never => {
      if (this.releaseCommitted) {
        this.closeState = "closed";
      } else {
        this.closeState = "open";
        this.closePromise = undefined;
      }
      throw error;
    });
    return this.closePromise;
  }

  private async closeOnce(admittedRelease: () => Promise<void>): Promise<void> {
    let hasFailure = false;
    let failure: unknown;
    try {
      await this.executor.runCleanup("factory", "close", admittedRelease);
    } catch (error) {
      hasFailure = true;
      failure = error;
    }
    if (this.releaseCommitted) {
      this.closeState = "closed";
      try {
        this.onClose(this);
      } catch (error) {
        if (!hasFailure) {
          hasFailure = true;
          failure = error;
        } else {
          failure = new AggregateError(
            [failure, error],
            "SQLite project close committed but cleanup failed",
            { cause: failure },
          );
        }
      }
    }
    if (hasFailure) throw failure;
  }

  private assertOpen(domain: Parameters<SqliteExecutor["run"]>[0], operation: string): void {
    if (this.closeState === "open") return;
    throw new StorageOperationError("STORAGE_CLOSED", "sqlite", this.projectId, domain, operation);
  }
}
