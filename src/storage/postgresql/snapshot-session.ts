import { randomUUID } from "node:crypto";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type { PostgreSqlQueryExecutor, PostgreSqlQueryOptions } from "./contracts.js";
import { isPostgreSqlConnectionError, normalizePostgreSqlError } from "./errors.js";

export interface PostgreSqlSnapshotOptions {
  readonly projectId: string;
  readonly signal?: AbortSignal;
}

export interface PostgreSqlSnapshotIdentity {
  /** A process-local lifetime identifier; it cannot reopen a source snapshot. */
  readonly sessionId: string;
  readonly backendPid: number;
  readonly projectId: string;
}

/** Internal connection transport supplied by the admitted PostgreSQL runtime. */
export interface PostgreSqlSnapshotTransport extends PostgreSqlQueryExecutor {
  rollback(): Promise<void>;
  release(destroy: boolean): void;
}

/** A single checked-out backend, retained until terminal rollback or disconnect. */
export class PostgreSqlSnapshotSession implements PostgreSqlQueryExecutor {
  private readonly cancellation = new AbortController();
  private readonly context: PostgreSqlQueryOptions;
  private queue = Promise.resolve();
  private closed = false;
  private destroy = false;
  private closePromise: Promise<void> | undefined;
  private snapshotIdentity!: PostgreSqlSnapshotIdentity;
  private readonly onAbort = (): void => {
    void this.close().catch(() => undefined);
  };

  private constructor(
    private readonly transport: PostgreSqlSnapshotTransport,
    private readonly options: PostgreSqlSnapshotOptions,
  ) {
    this.context = { domain: "transaction", operation: "snapshot", projectId: options.projectId };
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted) this.onAbort();
  }

  static async open(
    transport: PostgreSqlSnapshotTransport,
    options: PostgreSqlSnapshotOptions,
  ): Promise<PostgreSqlSnapshotSession> {
    const session = new PostgreSqlSnapshotSession(transport, options);
    try {
      await session.query({ text: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" }, session.context);
      const result = await session.query<{ pid: number }>({
        text: "SELECT pg_catalog.pg_backend_pid() AS pid",
      }, session.context);
      const pid = result.rows[0]?.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("invalid snapshot backend identity");
      }
      session.snapshotIdentity = Object.freeze({
        sessionId: randomUUID(), backendPid: pid, projectId: options.projectId,
      });
      session.assertOpen();
      return session;
    } catch (error) {
      await session.close().catch(() => undefined);
      throw normalizePostgreSqlError(error, session.context);
    }
  }

  get identity(): PostgreSqlSnapshotIdentity {
    return this.snapshotIdentity;
  }

  async query<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    this.assertOpen();
    const effectiveOptions = {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, this.cancellation.signal])
        : this.cancellation.signal,
    };
    const execute = this.queue.then(async () => {
      this.assertOpen();
      try {
        return await this.transport.query<R, I>(config, effectiveOptions);
      } catch (error) {
        this.destroy ||= effectiveOptions.signal.aborted || isPostgreSqlConnectionError(error);
        // Do not await close inside the queue it must drain.
        void this.close().catch(() => undefined);
        throw normalizePostgreSqlError(error, { ...options, projectId: this.options.projectId });
      }
    });
    this.queue = execute.then(() => undefined, () => undefined);
    return execute;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.options.signal?.removeEventListener("abort", this.onAbort);
    this.cancellation.abort();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    await this.queue;
    try {
      // Aborted or broken connections must never return to the pool. Disconnect
      // rolls back even when cancellation failed and a query is still pending.
      if (!this.destroy) await this.transport.rollback();
    } catch (error) {
      this.destroy = true;
      throw normalizePostgreSqlError(error, this.context);
    } finally {
      try {
        this.transport.release(this.destroy);
      } catch (error) {
        throw normalizePostgreSqlError(error, this.context);
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageOperationError(
        "STORAGE_CLOSED", "postgresql", this.options.projectId, "transaction", "snapshot",
      );
    }
  }
}
