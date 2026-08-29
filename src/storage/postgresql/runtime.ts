import { AsyncLocalStorage } from "node:async_hooks";
import { Client, Pool, Query, type ClientConfig, type PoolClient, type PoolConfig, type QueryConfig, type QueryResult, type QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlConnectionSettings,
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlRuntimeHealth,
  PostgreSqlTransactionOptions,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";
import { buildPostgreSqlClientConfig } from "./client-config.js";
import {
  isPostgreSqlConnectionError,
  normalizePostgreSqlError,
  PostgreSqlStorageOperationError,
  PostgreSqlCommitOutcomeUnknownError,
} from "./errors.js";
import {
  areRequiredPostgreSqlExtensionsReady,
  inspectRequiredPostgreSqlExtensions,
  PostgreSqlExtensionPreflightError,
} from "./extensions.js";
import {
  PostgreSqlServerEncodingPreflightError,
  REQUIRED_POSTGRESQL_SERVER_ENCODING,
  REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION,
  sanitizePostgreSqlServerEncoding,
} from "./migrations.js";
import {
  inspectPostgreSqlSearchConfiguration,
  PostgreSqlSearchConfigurationPreflightError,
} from "./search-configuration.js";
import {
  acquirePostgreSqlProjectMutationGuard,
  acquirePostgreSqlProjectPublicationLock,
  PostgreSqlBackendPublicationGuard,
  type PostgreSqlBackendPublicationControlExecutor,
} from "./publication-guard.js";

export interface PostgreSqlRuntimeDependencies {
  readonly createPool: (config: PoolConfig) => Pool;
  readonly createClient: (config: ClientConfig) => Client;
  readonly buildConfig: typeof buildPostgreSqlClientConfig;
  /** Missing project admission fails closed; the default always provides it. */
  readonly acquireMutationGuard?: typeof acquirePostgreSqlProjectMutationGuard;
  /** Missing publication admission fails closed; the default always provides it. */
  readonly acquirePublicationLock?: typeof acquirePostgreSqlProjectPublicationLock;
}

export const POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES: PostgreSqlRuntimeDependencies = {
  createPool: (config) => new Pool(config),
  createClient: (config) => new Client(config),
  buildConfig: buildPostgreSqlClientConfig,
  acquireMutationGuard: acquirePostgreSqlProjectMutationGuard,
  acquirePublicationLock: acquirePostgreSqlProjectPublicationLock,
};

const DEFAULT_POSTGRESQL_TRANSACTION_CONTEXT = {
  domain: "transaction",
  operation: "transaction",
} as const satisfies PostgreSqlOperationContext;

const savepointExecutionContext = new AsyncLocalStorage<object>();

type HealthRow = {
  server_encoding: unknown;
  server_version_num: unknown;
  timezone: string;
  role: string;
  tls: boolean;
};

type BackendPidRow = { pid: number };
type CancelRow = { cancelled: boolean };

function sanitizeServerMajorVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.floor(value / 10_000)
    : null;
}

function contextProjectId(
  context: PostgreSqlOperationContext,
): string | undefined {
  return context.projectId ?? context.projectIds?.[0];
}

function transactionScopeError(
  context: PostgreSqlOperationContext,
  fallbackProjectId?: string,
): StorageOperationError {
  return new StorageOperationError(
    "STORAGE_TRANSACTION_SCOPE",
    "postgresql",
    contextProjectId(context) ?? fallbackProjectId,
    context.domain,
    context.operation,
  );
}

function normalizedProjectScope(
  context: PostgreSqlOperationContext,
): readonly string[] {
  const singleton = context.projectId === undefined
    ? undefined
    : typeof context.projectId === "string" && context.projectId.length > 0
      ? context.projectId.toLowerCase()
      : undefined;
  if (context.projectId !== undefined && singleton === undefined) {
    throw transactionScopeError(context);
  }
  if (context.projectIds === undefined) {
    return singleton === undefined ? [] : [singleton];
  }
  if (!Array.isArray(context.projectIds)) throw transactionScopeError(context);
  const projectIds = context.projectIds.map((projectId) => {
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw transactionScopeError(context);
    }
    return projectId.toLowerCase();
  });
  if (projectIds.some((projectId, index) => (
    index > 0 && projectIds[index - 1]! >= projectId
  ))) {
    throw transactionScopeError(context);
  }
  if (
    singleton !== undefined
    && (projectIds.length !== 1 || projectIds[0] !== singleton)
  ) {
    throw transactionScopeError(context);
  }
  return projectIds;
}

function snapshotScopedQueryOptions(
  context: PostgreSqlQueryOptions,
  admittedProjectIds: ReadonlySet<string>,
  fallbackProjectId?: string,
): PostgreSqlQueryOptions {
  if ("transactionMode" in context) {
    throw transactionScopeError(context, fallbackProjectId);
  }
  const requested = normalizedProjectScope(context);
  const projectless = requested.length === 0;
  const subset = requested.length > 0
    && requested.every((projectId) => admittedProjectIds.has(projectId));
  if (!projectless && !subset) {
    throw transactionScopeError(context, fallbackProjectId);
  }
  return {
    domain: context.domain,
    operation: context.operation,
    ...(context.projectId === undefined
      ? {}
      : { projectId: context.projectId.toLowerCase() }),
    ...(context.projectIds === undefined
      ? {}
      : { projectIds: Object.freeze([...requested]) }),
    ...(context.machineId === undefined ? {} : { machineId: context.machineId }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
}

function transactionSetupSql(
  options: PostgreSqlTransactionOptions,
  requiresAdmission: boolean,
): string | undefined {
  if (options.transactionMode === undefined && !requiresAdmission) return undefined;
  if (
    options.transactionMode !== undefined
    && options.transactionMode !== "read-committed-read-write"
  ) {
    throw transactionScopeError(options);
  }
  return "SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE";
}

function snapshotTransactionOptions(
  context: PostgreSqlTransactionOptions,
): { readonly options: PostgreSqlTransactionOptions; readonly projectIds: readonly string[] } {
  const projectIds = Object.freeze([...normalizedProjectScope(context)]);
  return {
    options: {
      domain: context.domain,
      operation: context.operation,
      ...(context.projectId === undefined
        ? {}
        : { projectId: context.projectId.toLowerCase() }),
      ...(context.projectIds === undefined ? {} : { projectIds }),
      ...(context.machineId === undefined ? {} : { machineId: context.machineId }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.transactionMode === undefined
        ? {}
        : { transactionMode: context.transactionMode }),
    },
    projectIds,
  };
}

function aborted(context: PostgreSqlOperationContext): StorageOperationError {
  const projectId = contextProjectId(context);
  return new PostgreSqlStorageOperationError(
    "STORAGE_OPERATION_FAILED",
    {
      ...context,
      ...(projectId === undefined ? {} : { projectId }),
    },
    null,
    false,
  );
}

function abortCause(): Error {
  return new Error("postgresql query aborted");
}

function combineAbortSignals(
  querySignal: AbortSignal | undefined,
  transactionSignal: AbortSignal | undefined,
): { readonly signal: AbortSignal | undefined; readonly dispose: () => void } {
  if (!querySignal) return { signal: transactionSignal, dispose: () => undefined };
  if (!transactionSignal || querySignal === transactionSignal) {
    return { signal: querySignal, dispose: () => undefined };
  }

  const controller = new AbortController();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    querySignal.removeEventListener("abort", onAbort);
    transactionSignal.removeEventListener("abort", onAbort);
  };
  const onAbort = (): void => {
    controller.abort();
    dispose();
  };
  if (querySignal.aborted || transactionSignal.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => undefined };
  }
  querySignal.addEventListener("abort", onAbort, { once: true });
  transactionSignal.addEventListener("abort", onAbort, { once: true });
  if (querySignal.aborted || transactionSignal.aborted) onAbort();
  return { signal: controller.signal, dispose };
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
    if (options.projectId !== undefined || options.projectIds !== undefined) {
      return this.transaction(
        (transaction) => transaction.query<R, I>(config, options),
        {
          ...options,
          transactionMode: "read-committed-read-write",
        },
      );
    }
    return this.queryDirect(config, options);
  }

  backendPublicationGuard(): PostgreSqlBackendPublicationGuard {
    const control: PostgreSqlBackendPublicationControlExecutor = {
      projectPublicationTransaction: this.projectPublicationTransaction.bind(this),
      projectPublicationReadback: this.projectPublicationReadback.bind(this),
    };
    return new PostgreSqlBackendPublicationGuard(control);
  }

  private projectPublicationReadback<
    R extends QueryResultRow = QueryResultRow,
    I extends unknown[] = unknown[],
  >(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    return this.queryDirect(config, options);
  }

  private async queryDirect<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
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
      destroy = options.signal?.aborted === true || isPostgreSqlConnectionError(error);
      throw normalizePostgreSqlError(error, options);
    } finally {
      client?.release(destroy);
    }
  }

  async transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions = DEFAULT_POSTGRESQL_TRANSACTION_CONTEXT,
  ): Promise<T> {
    return this.runTransaction(callback, options, false);
  }

  private projectPublicationTransaction<T>(
    projectId: string,
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions,
  ): Promise<T> {
    return this.runTransaction(
      callback,
      { ...options, projectId, projectIds: [projectId] },
      true,
    );
  }

  private async runTransaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    inputOptions: PostgreSqlTransactionOptions,
    publicationControl: boolean,
  ): Promise<T> {
    const snapshot = snapshotTransactionOptions(inputOptions);
    const options = snapshot.options;
    const declaredProjectIds = snapshot.projectIds;
    const admittedProjectIds = new Set(declaredProjectIds);
    const requiresAdmission = publicationControl || declaredProjectIds.length > 0;
    const admissionHook = publicationControl
      ? this.dependencies.acquirePublicationLock
      : this.dependencies.acquireMutationGuard;
    const machineContext = options.machineId === undefined
      ? {}
      : { machineId: options.machineId };
    if (requiresAdmission && admissionHook === undefined) {
      throw transactionScopeError(options, declaredProjectIds[0]);
    }
    const setupSql = transactionSetupSql(options, requiresAdmission);
    this.assertOpen(options);
    let client: PoolClient | undefined;
    let destroy = false;
    let commitAttempted = false;
    try {
      client = await this.acquire(options);
      if (options.signal?.aborted) {
        destroy = true;
        throw aborted(options);
      }
      await client.query("BEGIN");
      if (setupSql !== undefined) {
        await client.query({ text: setupSql });
      }
      if (options.signal?.aborted) {
        destroy = true;
        throw aborted(options);
      }
      let acceptingQueries = true;
      let transactionFailed = false;
      let transactionFailure: StorageOperationError | undefined;
      let savepointOrdinal = 0;
      let queryQueue = Promise.resolve();
      const savepointScopeToken = {};
      const scopeError = (
        queryOptions: PostgreSqlOperationContext,
      ): StorageOperationError => transactionScopeError(
        queryOptions,
        declaredProjectIds[0],
      );
      const recordFatalFailure = (
        error: unknown,
        failureOptions: PostgreSqlQueryOptions,
        forceDestroy = false,
      ): StorageOperationError => {
        const connectionFailure = isPostgreSqlConnectionError(error);
        if (
          forceDestroy
          || failureOptions.signal?.aborted === true
          || options.signal?.aborted === true
          || connectionFailure
        ) {
          destroy = true;
        }
        const normalized = normalizePostgreSqlError(error, failureOptions);
        transactionFailed = true;
        transactionFailure ??= normalized;
        return normalized;
      };
      const guardExecutor: PostgreSqlQueryExecutor = {
        query: async <R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
          config: QueryConfig<I>,
          queryOptions: PostgreSqlQueryOptions,
        ): Promise<QueryResult<R>> => {
          const combinedSignal = combineAbortSignals(queryOptions.signal, options.signal);
          const effectiveOptions = { ...queryOptions, signal: combinedSignal.signal };
          try {
            return await this.queryClient<R, I>(client!, config, effectiveOptions);
          } catch (error) {
            throw recordFatalFailure(error, effectiveOptions);
          } finally {
            combinedSignal.dispose();
          }
        },
      };
      if (publicationControl) {
        await this.dependencies.acquirePublicationLock!(
          guardExecutor,
          declaredProjectIds[0]!,
          {
            domain: options.domain,
            operation: options.operation,
            projectId: declaredProjectIds[0],
            projectIds: [declaredProjectIds[0]!],
            ...machineContext,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        );
      } else if (declaredProjectIds.length > 0) {
        for (const projectId of declaredProjectIds) {
          await this.dependencies.acquireMutationGuard!(
            guardExecutor,
            projectId,
            {
              domain: options.domain,
              operation: options.operation,
              projectId,
              projectIds: [projectId],
              ...machineContext,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
          );
        }
      }
      const scopedOptions = (
        queryOptions: PostgreSqlQueryOptions,
      ): PostgreSqlQueryOptions => snapshotScopedQueryOptions(
        queryOptions,
        admittedProjectIds,
        declaredProjectIds[0],
      );
      const transaction: PostgreSqlTransactionScopeExecutor = {
        transactionScope: "active",
        query: async <R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
          config: QueryConfig<I>,
          queryOptions: PostgreSqlQueryOptions,
        ) => {
          const scopedQueryOptions = scopedOptions(queryOptions);
          if (
            !acceptingQueries
            || transactionFailed
            || savepointExecutionContext.getStore() === savepointScopeToken
          ) {
            throw scopeError(scopedQueryOptions);
          }
          const execute = queryQueue.then(async () => {
            if (transactionFailed) {
              throw scopeError(scopedQueryOptions);
            }
            const combinedSignal = combineAbortSignals(scopedQueryOptions.signal, options.signal);
            const effectiveOptions = { ...scopedQueryOptions, signal: combinedSignal.signal };
            try {
              return await this.queryClient<R, I>(client!, config, effectiveOptions);
            } catch (error) {
              throw recordFatalFailure(error, effectiveOptions);
            } finally {
              combinedSignal.dispose();
            }
          });
          queryQueue = execute.then(() => undefined, () => undefined);
          return execute;
        },
        savepoint: async <R>(
          callback: (savepoint: PostgreSqlQueryExecutor) => Promise<R>,
          savepointOptions: PostgreSqlQueryOptions,
        ): Promise<R> => {
          const scopedSavepointOptions = scopedOptions(savepointOptions);
          if (
            !acceptingQueries
            || transactionFailed
            || savepointExecutionContext.getStore() === savepointScopeToken
          ) {
            throw scopeError(scopedSavepointOptions);
          }
          const execute = queryQueue.then(async () => {
            if (transactionFailed) {
              throw scopeError(scopedSavepointOptions);
            }
            if (scopedSavepointOptions.signal?.aborted || options.signal?.aborted) {
              const failure = aborted({
                ...scopedSavepointOptions,
                projectId: contextProjectId(scopedSavepointOptions)
                  ?? declaredProjectIds[0],
              });
              throw recordFatalFailure(failure, scopedSavepointOptions, true);
            }
            savepointOrdinal =
              (savepointOrdinal % Number.MAX_SAFE_INTEGER) + 1;
            const savepoint =
              `lcm_runtime_repository_${savepointOrdinal}`;
            try {
              try {
                await client!.query(`SAVEPOINT ${savepoint}`);
              } catch (error) {
                throw recordFatalFailure(error, scopedSavepointOptions);
              }

              let acceptingSavepointQueries = true;
              let savepointFailed = false;
              let savepointFailure: StorageOperationError | undefined;
              let savepointFailureRecoverable = false;
              let savepointQueryQueue = Promise.resolve();
              const inner: PostgreSqlQueryExecutor = {
                query: async <
                  QueryRow extends QueryResultRow = QueryResultRow,
                  QueryInput extends unknown[] = unknown[],
                >(
                  config: QueryConfig<QueryInput>,
                  queryOptions: PostgreSqlQueryOptions,
                  ): Promise<QueryResult<QueryRow>> => {
                  const scopedInnerOptions = scopedOptions(queryOptions);
                  if (!acceptingSavepointQueries || savepointFailed) {
                    throw scopeError(scopedInnerOptions);
                  }
                  const queryExecute = savepointQueryQueue.then(async () => {
                    if (savepointFailed) throw scopeError(scopedInnerOptions);
                    const savepointCombinedSignal = combineAbortSignals(
                      scopedInnerOptions.signal,
                      scopedSavepointOptions.signal,
                    );
                    const combinedSignal = combineAbortSignals(
                      savepointCombinedSignal.signal,
                      options.signal,
                    );
                    const effectiveOptions = {
                      ...scopedInnerOptions,
                      signal: combinedSignal.signal,
                    };
                    try {
                      return await this.queryClient<QueryRow, QueryInput>(
                        client!,
                        config,
                        effectiveOptions,
                      );
                    } catch (error) {
                      const connectionFailure =
                        isPostgreSqlConnectionError(error);
                      const queryAborted =
                        effectiveOptions.signal?.aborted === true;
                      const normalized = normalizePostgreSqlError(
                        error,
                        effectiveOptions,
                      );
                      savepointFailed = true;
                      savepointFailure ??= normalized;
                      savepointFailureRecoverable =
                        !queryAborted && !connectionFailure;
                      if (!savepointFailureRecoverable) {
                        recordFatalFailure(
                          normalized,
                          effectiveOptions,
                          queryAborted || connectionFailure,
                        );
                      }
                      throw normalized;
                    } finally {
                      combinedSignal.dispose();
                      savepointCombinedSignal.dispose();
                    }
                  });
                  savepointQueryQueue = queryExecute.then(
                    () => undefined,
                    () => undefined,
                  );
                  return queryExecute;
                },
              };
              let callbackOutcome!:
                | { readonly succeeded: true; readonly result: R }
                | { readonly succeeded: false; readonly error: unknown };
              try {
                callbackOutcome = {
                  succeeded: true,
                  result: await savepointExecutionContext.run(
                    savepointScopeToken,
                    () => callback(inner),
                  ),
                };
              } catch (error) {
                callbackOutcome = { succeeded: false, error };
              } finally {
                acceptingSavepointQueries = false;
              }
              await savepointQueryQueue;

              const rollbackSavepoint = async (
                original: unknown,
              ): Promise<never> => {
                if (scopedSavepointOptions.signal?.aborted || options.signal?.aborted) {
                  const failure = aborted({
                    ...scopedSavepointOptions,
                    projectId: contextProjectId(scopedSavepointOptions)
                      ?? declaredProjectIds[0],
                  });
                  throw recordFatalFailure(
                    failure,
                    scopedSavepointOptions,
                    true,
                  );
                }
                try {
                  await client!.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                  await client!.query(`RELEASE SAVEPOINT ${savepoint}`);
                } catch (error) {
                  recordFatalFailure(error, scopedSavepointOptions);
                  throw original;
                }
                throw original;
              };
              if (savepointFailure) {
                if (!savepointFailureRecoverable) throw savepointFailure;
                return rollbackSavepoint(savepointFailure);
              }
              if (!callbackOutcome.succeeded) {
                return rollbackSavepoint(callbackOutcome.error);
              }

              if (scopedSavepointOptions.signal?.aborted || options.signal?.aborted) {
                const failure = aborted({
                  ...scopedSavepointOptions,
                  projectId: contextProjectId(scopedSavepointOptions)
                    ?? declaredProjectIds[0],
                });
                throw recordFatalFailure(failure, scopedSavepointOptions, true);
              }
              try {
                await client!.query(`RELEASE SAVEPOINT ${savepoint}`);
              } catch (error) {
                throw recordFatalFailure(error, scopedSavepointOptions);
              }
              return callbackOutcome.result;
            } catch (error) {
              throw error;
            }
          });
          queryQueue = execute.then(() => undefined, () => undefined);
          return execute;
        },
      };
      let callbackOutcome!: { readonly succeeded: true; readonly result: T }
        | { readonly succeeded: false; readonly error: unknown };
      try {
        callbackOutcome = { succeeded: true, result: await callback(transaction) };
      } catch (error) {
        callbackOutcome = { succeeded: false, error };
      } finally {
        acceptingQueries = false;
      }
      await queryQueue;
      if (transactionFailure) throw transactionFailure;
      if (!callbackOutcome.succeeded) throw callbackOutcome.error;
      if (options.signal?.aborted) {
        destroy = true;
        throw aborted(options);
      }
      commitAttempted = true;
      await client.query("COMMIT");
      this.poolFailed = false;
      return callbackOutcome.result;
    } catch (error) {
      const connectionFailure = isPostgreSqlConnectionError(error);
      const commitOutcomeAmbiguous = commitAttempted && connectionFailure;
      if (options.signal?.aborted === true || connectionFailure) destroy = true;
      if (client && !destroy && options.signal?.aborted !== true) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroy = true;
        }
      }
      if (commitOutcomeAmbiguous) {
        throw new PostgreSqlCommitOutcomeUnknownError(options);
      }
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
        text: `SELECT pg_catalog.current_setting('server_version_num')::pg_catalog.int4
                        AS server_version_num,
                      pg_catalog.current_setting('server_encoding') AS server_encoding,
                      pg_catalog.current_setting('TimeZone') AS timezone,
                      CURRENT_USER AS role,
                      COALESCE((
                        SELECT ssl
                        FROM pg_catalog.pg_stat_ssl
                        WHERE pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
                      ), false) AS tls`,
      }, { domain: "factory", operation: "health" });
      const row = result.rows[0];
      const serverMajorVersion = sanitizeServerMajorVersion(row?.server_version_num);
      const serverEncoding = sanitizePostgreSqlServerEncoding(row?.server_encoding);
      const connectionDiagnostics = {
        serverMajorVersion,
        serverEncoding,
        tls: row?.tls,
        timezone: row?.timezone,
        role: row?.role,
      };
      if (serverMajorVersion !== REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION) {
        return {
          status: "unavailable",
          backend: "postgresql",
          ...connectionDiagnostics,
          error: new StorageOperationError(
            "STORAGE_INITIALIZATION_FAILED",
            "postgresql",
            undefined,
            "factory",
            "health",
          ),
        };
      }
      if (serverEncoding !== REQUIRED_POSTGRESQL_SERVER_ENCODING) {
        return {
          status: "unavailable",
          backend: "postgresql",
          ...connectionDiagnostics,
          error: new PostgreSqlServerEncodingPreflightError(serverEncoding, "health"),
        };
      }
      const extensions = await inspectRequiredPostgreSqlExtensions(this, {
        operation: "healthRequiredExtensions",
      });
      const runtimeReady = row?.tls === true
        && row.timezone.toUpperCase() === "UTC";
      const extensionsReady = areRequiredPostgreSqlExtensionsReady(extensions);
      if (!runtimeReady || !extensionsReady) {
        return {
          status: "unavailable",
          backend: "postgresql",
          ...connectionDiagnostics,
          extensions,
          error: runtimeReady
            ? new PostgreSqlExtensionPreflightError(extensions, "health")
            : new StorageOperationError(
              "STORAGE_INITIALIZATION_FAILED",
              "postgresql",
              undefined,
              "factory",
              "health",
              ),
        };
      }
      const searchConfiguration = await inspectPostgreSqlSearchConfiguration(this, {
        operation: "healthSearchConfiguration",
      });
      const diagnostics = {
        ...connectionDiagnostics,
        extensions,
        searchConfiguration,
      };
      if (!searchConfiguration.ready) {
        return {
          status: "unavailable",
          backend: "postgresql",
          ...diagnostics,
          error: new PostgreSqlSearchConfigurationPreflightError(searchConfiguration, "health"),
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
      this.closePromise = undefined;
      throw normalizePostgreSqlError(error, { domain: "factory", operation: "close" });
    });
    return this.closePromise;
  }

  private assertOpen(context: PostgreSqlOperationContext): void {
    if (!this.closed) return;
    throw new StorageOperationError(
      "STORAGE_CLOSED",
      "postgresql",
      contextProjectId(context),
      context.domain,
      context.operation,
    );
  }

  private async acquire(context: PostgreSqlOperationContext & { signal?: AbortSignal }): Promise<PoolClient> {
    const signal = context.signal;
    if (signal?.aborted) throw aborted(context);
    if (!signal) return this.pool.connect();

    type ConnectOutcome =
      | { readonly kind: "connected"; readonly client: PoolClient }
      | { readonly kind: "failed"; readonly error: unknown };
    const connectOutcome: Promise<ConnectOutcome> = Promise.resolve()
      .then(() => this.pool.connect())
      .then(
        (client) => ({ kind: "connected" as const, client }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
    let observeAbort!: () => void;
    const abortOutcome = new Promise<{ readonly kind: "aborted" }>((resolve) => {
      observeAbort = () => { resolve({ kind: "aborted" }); };
    });
    signal.addEventListener("abort", observeAbort, { once: true });
    if (signal.aborted) observeAbort();

    const outcome = await Promise.race([connectOutcome, abortOutcome]);
    signal.removeEventListener("abort", observeAbort);
    if (outcome.kind === "aborted") {
      void connectOutcome.then((lateOutcome) => {
        if (lateOutcome.kind !== "connected") return;
        try {
          lateOutcome.client.release(true);
        } catch {
          // The operation has already failed closed; a late client must never
          // surface credentials or create an unhandled rejection.
        }
      });
      throw aborted(context);
    }
    if (outcome.kind === "failed") {
      if (signal.aborted) throw aborted(context);
      throw outcome.error;
    }
    if (signal.aborted) {
      try {
        outcome.client.release(true);
      } finally {
        throw aborted(context);
      }
    }
    return outcome.client;
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
