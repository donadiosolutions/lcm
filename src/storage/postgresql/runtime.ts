import { Client, Pool, Query, type ClientConfig, type PoolClient, type PoolConfig, type QueryConfig, type QueryResult, type QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlConnectionSettings,
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlRuntimeHealth,
} from "./contracts.js";
import { buildPostgreSqlClientConfig } from "./client-config.js";
import { normalizePostgreSqlError } from "./errors.js";

export interface PostgreSqlRuntimeDependencies {
  readonly createPool: (config: PoolConfig) => Pool;
  readonly createClient: (config: ClientConfig) => Client;
  readonly buildConfig: typeof buildPostgreSqlClientConfig;
}

export const POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES: PostgreSqlRuntimeDependencies = {
  createPool: (config) => new Pool(config),
  createClient: (config) => new Client(config),
  buildConfig: buildPostgreSqlClientConfig,
};

type HealthRow = {
  server_version_num: number;
  timezone: string;
  role: string;
  tls: boolean;
};

type BackendPidRow = { pid: number };
type CancelRow = { cancelled: boolean };

function aborted(context: PostgreSqlOperationContext): StorageOperationError {
  return new StorageOperationError(
    "STORAGE_OPERATION_FAILED",
    "postgresql",
    context.projectId,
    context.domain,
    context.operation,
  );
}

function abortCause(): Error {
  return new Error("postgresql query aborted");
}

async function ignoreCancellationFailure(cancellation: Promise<void>): Promise<void> {
  try {
    await cancellation;
  } catch {
    // The target connection is destroyed by the caller after abort.
  }
}

export class PostgreSqlRuntime implements PostgreSqlQueryExecutor {
  private readonly clientConfig: ClientConfig;
  private readonly pool: Pool;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private poolFailed = false;

  constructor(
    private readonly settings: PostgreSqlConnectionSettings,
    private readonly dependencies: PostgreSqlRuntimeDependencies = POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
  ) {
    this.clientConfig = dependencies.buildConfig(settings);
    this.pool = dependencies.createPool({
      ...this.clientConfig,
      max: settings.poolMax,
      idleTimeoutMillis: settings.idleTimeoutMs,
    });
    this.pool.on("error", () => { this.poolFailed = true; });
  }

  async query<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    this.assertOpen(options);
    let client: PoolClient | undefined;
    let destroy = false;
    try {
      client = await this.acquire(options);
      const result = await this.queryClient<R, I>(client, config, options);
      this.poolFailed = false;
      return result;
    } catch (error) {
      destroy = options.signal?.aborted === true;
      throw normalizePostgreSqlError(error, options);
    } finally {
      client?.release(destroy);
    }
  }

  async transaction<T>(
    callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>,
    options: PostgreSqlOperationContext & { signal?: AbortSignal },
  ): Promise<T> {
    this.assertOpen(options);
    let client: PoolClient | undefined;
    let destroy = false;
    try {
      client = await this.acquire(options);
      await client.query("BEGIN");
      const transaction: PostgreSqlQueryExecutor = {
        query: async <R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
          config: QueryConfig<I>,
          queryOptions: PostgreSqlQueryOptions,
        ) => {
          const effectiveOptions = { ...queryOptions, signal: queryOptions.signal ?? options.signal };
          try {
            return await this.queryClient<R, I>(client!, config, effectiveOptions);
          } catch (error) {
            if (effectiveOptions.signal?.aborted) destroy = true;
            throw error;
          }
        },
      };
      const result = await callback(transaction);
      await client.query("COMMIT");
      this.poolFailed = false;
      return result;
    } catch (error) {
      if (client && !destroy && options.signal?.aborted !== true) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroy = true;
        }
      }
      if (options.signal?.aborted) destroy = true;
      throw normalizePostgreSqlError(error, options);
    } finally {
      client?.release(destroy);
    }
  }

  async health(): Promise<PostgreSqlRuntimeHealth> {
    if (this.closed) return { status: "closed", backend: "postgresql" };
    const wasPoolFailed = this.poolFailed;
    try {
      const result = await this.query<HealthRow>({
        text: `SELECT current_setting('server_version_num')::integer AS server_version_num,
                      current_setting('TimeZone') AS timezone,
                      current_user AS role,
                      COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS tls`,
      }, { domain: "factory", operation: "health" });
      const row = result.rows[0];
      const serverMajorVersion = Math.floor(row.server_version_num / 10_000);
      const diagnostics = {
        serverMajorVersion,
        tls: row.tls,
        timezone: row.timezone,
        role: row.role,
      };
      if (serverMajorVersion !== 18 || row.tls !== true || row.timezone.toUpperCase() !== "UTC") {
        return {
          status: "unavailable",
          backend: "postgresql",
          ...diagnostics,
          error: new StorageOperationError(
            "STORAGE_INITIALIZATION_FAILED",
            "postgresql",
            undefined,
            "factory",
            "health",
          ),
        };
      }
      return {
        status: wasPoolFailed ? "degraded" : "healthy",
        backend: "postgresql",
        ...diagnostics,
      };
    } catch (error) {
      return {
        status: "unavailable",
        backend: "postgresql",
        error: normalizePostgreSqlError(error, { domain: "factory", operation: "health" }, "STORAGE_INITIALIZATION_FAILED"),
      };
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.pool.end().catch((error: unknown): never => {
      this.closed = false;
      this.closePromise = undefined;
      throw normalizePostgreSqlError(error, { domain: "factory", operation: "close" });
    });
    return this.closePromise;
  }

  private assertOpen(context: PostgreSqlOperationContext): void {
    if (!this.closed) return;
    throw new StorageOperationError("STORAGE_CLOSED", "postgresql", context.projectId, context.domain, context.operation);
  }

  private async acquire(context: PostgreSqlOperationContext & { signal?: AbortSignal }): Promise<PoolClient> {
    if (context.signal?.aborted) throw aborted(context);
    return this.pool.connect();
  }

  private async queryClient<
    R extends QueryResultRow = QueryResultRow,
    I extends unknown[] = unknown[],
  >(
    client: PoolClient,
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    const signal = options.signal;
    if (!signal) return client.query<R, I>(config);
    if (signal.aborted) throw aborted(options);
    const pidResult = await client.query<BackendPidRow>({ text: "SELECT pg_backend_pid() AS pid" });
    const pid = pidResult.rows[0].pid;
    if (signal.aborted) throw aborted(options);

    type QueryOutcome = { error: Error | null; result?: QueryResult<R> };
    let cancellation: Promise<void> | undefined;
    let observeAbort!: () => void;
    const abortObserved = new Promise<void>((resolve) => { observeAbort = resolve; });
    const onAbort = (): void => {
      cancellation ??= this.cancelBackend(pid);
      observeAbort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      await ignoreCancellationFailure(cancellation!);
      signal.removeEventListener("abort", onAbort);
      throw abortCause();
    }

    const queryOutcome = new Promise<QueryOutcome>((resolve) => {
      const query = new Query<R, I>(config, (error, result) => {
        resolve({ error: error ?? null, result: result as QueryResult<R> | undefined });
      });
      client.query(query);
    });

    try {
      const first = await Promise.race([
        queryOutcome.then((outcome) => ({ kind: "query" as const, outcome })),
        abortObserved.then(() => ({ kind: "abort" as const })),
      ]);
      if (first.kind === "query") {
        if (signal.aborted || cancellation) {
          if (!cancellation) onAbort();
          await ignoreCancellationFailure(cancellation!);
          throw abortCause();
        }
        if (first.outcome.error) throw first.outcome.error;
        return first.outcome.result!;
      }

      try {
        await cancellation!;
      } catch {
        // The caller destroys the checked-out connection when it observes the
        // aborted signal, so a failed cancellation cannot leave the query live.
        throw abortCause();
      }
      await queryOutcome;
      throw abortCause();
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async cancelBackend(pid: number): Promise<void> {
    const client = this.dependencies.createClient(this.clientConfig);
    try {
      await client.connect();
      const result = await client.query<CancelRow>({
        text: "SELECT pg_cancel_backend($1) AS cancelled",
        values: [pid],
      });
      if (result.rows[0]?.cancelled !== true) throw new Error("cancel rejected");
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
