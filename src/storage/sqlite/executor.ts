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

export function sqliteExecutorFor(
  db: DatabaseSync,
  projectId: string,
  onPoison: () => void,
): SqliteExecutor {
  const existing = executors.get(db);
  if (existing) return existing;
  const executor = new SqliteExecutor(db, projectId, onPoison);
  executors.set(db, executor);
  return executor;
}

export class SqliteExecutor {
  private tail: Promise<void> = Promise.resolve();
  private readonly activeTokens = new Set<symbol>();
  private readonly failedTokens = new Set<symbol>();
  private savepointOrdinal = 0;
  private poisoned = false;

  constructor(
    private readonly db: DatabaseSync,
    readonly projectId: string,
    private readonly onPoison?: () => void,
  ) {}

  poison(): void {
    if (this.poisoned) return;
    this.poisoned = true;
    this.onPoison?.();
  }

  async run<T>(domain: StorageDomain, operation: string, callback: () => T | Promise<T>): Promise<T> {
    const active = transactionContext.getStore();
    if (active) {
      throw new StorageOperationError(
        "STORAGE_TRANSACTION_SCOPE",
        "sqlite",
        this.projectId,
        domain,
        operation,
      );
    }
    this.assertUsable(domain, operation);
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
    this.assertUsable(domain, operation);
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

  async runAtomic<T>(
    domain: StorageDomain,
    operation: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const active = transactionContext.getStore();
    if (active) {
      throw new StorageOperationError(
        "STORAGE_TRANSACTION_SCOPE",
        "sqlite",
        this.projectId,
        domain,
        operation,
      );
    }
    this.assertUsable(domain, operation);
    return this.enqueue(domain, operation, () => this.atomicRoot(callback));
  }

  async runAtomicScoped<T>(
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
    this.assertUsable(domain, operation);
    const savepoint = `lcm_atomic_${this.savepointOrdinal++}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = await callback();
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        this.failedTokens.add(token);
        this.poison();
      }
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
    this.assertUsable("transaction", "transaction");

    return this.enqueue("transaction", "transaction", async () => {
      const token = Symbol("sqlite-transaction");
      this.db.exec("BEGIN IMMEDIATE");
      this.activeTokens.add(token);
      try {
        const result = await transactionContext.run(
          { executor: this, token },
          async (): Promise<T> => callback(token),
        );
        if (this.failedTokens.has(token)) {
          throw new StorageOperationError(
            "STORAGE_OPERATION_FAILED",
            "sqlite",
            this.projectId,
            "transaction",
            "transaction",
          );
        }
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the original, already-sanitized transaction failure, but
          // permanently fence and evict the handle left in an unknown state.
          this.poison();
        }
        throw error;
      } finally {
        this.activeTokens.delete(token);
        this.failedTokens.delete(token);
      }
    });
  }

  async runCleanup<T>(
    domain: StorageDomain,
    operation: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    if (transactionContext.getStore()) {
      throw new StorageOperationError(
        "STORAGE_TRANSACTION_SCOPE",
        "sqlite",
        this.projectId,
        domain,
        operation,
      );
    }
    return this.enqueue(domain, operation, callback, true);
  }

  private assertUsable(domain: StorageDomain, operation: string): void {
    if (!this.poisoned) return;
    throw new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "sqlite",
      this.projectId,
      domain,
      operation,
    );
  }

  private async atomicRoot<T>(callback: () => T | Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        this.poison();
      }
      throw error;
    }
  }

  private async enqueue<T>(
    domain: StorageDomain,
    operation: string,
    callback: () => T | Promise<T>,
    allowPoisoned = false,
  ): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve): void => { release = resolve; });
    this.tail = previous.then((): Promise<void> => current);
    await previous;
    try {
      // Re-check after waiting: a readiness probe ahead of this operation may
      // have poisoned and evicted the shared handle while this call was queued.
      if (!allowPoisoned) this.assertUsable(domain, operation);
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
