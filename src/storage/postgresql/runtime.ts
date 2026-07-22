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
      if (client) {
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
      if (serverMajorVersion !== 18 || row.tls !== true || row.timezone.toUpperCase() !== "UTC") {
        throw new StorageOperationError(
          "STORAGE_INITIALIZATION_FAILED",
          "postgresql",
          undefined,
          "factory",
          "health",
        );
      }
      return {
        status: wasPoolFailed ? "degraded" : "healthy",
        backend: "postgresql",
        serverMajorVersion,
        tls: row.tls,
        timezone: row.timezone,
        role: row.role,
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
    return new Promise<QueryResult<R>>((resolve, reject) => {
      let settled = false;
      let cancellationFailed = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const query = new Query<R, I>(config, (error, result) => {
        if (error) finish(() => reject(error));
        else finish(() => resolve(result as QueryResult<R>));
      });
      const onAbort = (): void => {
        void this.cancelBackend(pid).catch(() => {
          cancellationFailed = true;
        }).finally(() => {
          if (cancellationFailed) finish(() => reject(aborted(options)));
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      client.query(query);
    });
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
