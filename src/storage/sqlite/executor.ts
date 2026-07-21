import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { StorageDomain } from "../contracts.js";
import { normalizeStorageError, StorageOperationError } from "../errors.js";

type TransactionContext = {
  executor: SqliteExecutor;
  token: symbol;
};

const transactionContext = new AsyncLocalStorage<TransactionContext>();
const executors = new WeakMap<DatabaseSync, SqliteExecutor>();

export function sqliteExecutorFor(db: DatabaseSync, projectId: string): SqliteExecutor {
  const existing = executors.get(db);
  if (existing) return existing;
  const executor = new SqliteExecutor(db, projectId);
  executors.set(db, executor);
  return executor;
}

export class SqliteExecutor {
  private tail: Promise<void> = Promise.resolve();
  private readonly activeTokens = new Set<symbol>();

  constructor(
    private readonly db: DatabaseSync,
    readonly projectId: string,
  ) {}

  async run<T>(domain: StorageDomain, operation: string, callback: () => T | Promise<T>): Promise<T> {
    const active = transactionContext.getStore();
    if (active?.executor === this) {
      throw new StorageOperationError(
        "STORAGE_TRANSACTION_SCOPE",
        "sqlite",
        this.projectId,
        domain,
        operation,
      );
    }
    return this.enqueue(domain, operation, callback);
  }

  async runScoped<T>(
    token: symbol,
    domain: StorageDomain,
    operation: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const active = transactionContext.getStore();
    if (active?.executor !== this || active.token !== token || !this.activeTokens.has(token)) {
      throw new StorageOperationError(
        "STORAGE_TRANSACTION_SCOPE",
        "sqlite",
        this.projectId,
        domain,
        operation,
      );
    }
    try {
      return await callback();
    } catch (error) {
      throw normalizeStorageError(error, {
        backend: "sqlite",
        projectId: this.projectId,
        domain,
        operation,
      });
    }
  }

  async transaction<T>(callback: (token: symbol) => Promise<T>): Promise<T> {
    const active = transactionContext.getStore();
    if (active) {
      throw new StorageOperationError(
        "STORAGE_NESTED_TRANSACTION",
        "sqlite",
        this.projectId,
        "transaction",
        "transaction",
      );
    }

    return this.enqueue("transaction", "transaction", async () => {
      const token = Symbol("sqlite-transaction");
      this.db.exec("BEGIN IMMEDIATE");
      this.activeTokens.add(token);
      try {
        const result = await transactionContext.run(
          { executor: this, token },
          async (): Promise<T> => callback(token),
        );
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the original, already-sanitized transaction failure.
        }
        throw error;
      } finally {
        this.activeTokens.delete(token);
      }
    });
  }

  private async enqueue<T>(
    domain: StorageDomain,
    operation: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve): void => { release = resolve; });
    this.tail = previous.then((): Promise<void> => current);
    await previous;
    try {
      return await callback();
    } catch (error) {
      throw normalizeStorageError(error, {
        backend: "sqlite",
        projectId: this.projectId,
        domain,
        operation,
      });
    } finally {
      release();
    }
  }
}
