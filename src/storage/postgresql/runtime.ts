import { AsyncLocalStorage } from "node:async_hooks";
import { Client, Pool, Query, type ClientConfig, type PoolClient, type PoolConfig, type QueryConfig, type QueryResult, type QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlConnectionSettings,
  PostgreSqlDiagnosticPool,
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlRuntimeHealth,
  PostgreSqlTransactionOptions,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";
import {
  fusedBackendPid,
  PostgreSqlSnapshotSession,
  validBackendPid,
  type PostgreSqlSnapshotOptions,
} from "./snapshot-session.js";
import { buildPostgreSqlClientConfig, postgreSqlQueryDeadlineMs } from "./client-config.js";
import {
  isPostgreSqlConnectionError,
  isPostgreSqlSnapshotTerminationSqlState,
  normalizePostgreSqlError,
  PostgreSqlDiagnosticPoolError,
  PostgreSqlStorageOperationError,
  PostgreSqlCommitOutcomeUnknownError,
  sanitizeSqlState,
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
  /** Monotonic millisecond clock for idle-connection validation; defaults to performance.now. */
  readonly now?: () => number;
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

/**
 * A pooled connection released this long ago or longer is probed with
 * SELECT 1 at checkout. A reuse inside the window keeps the #1820 query
 * deadline as its only bound, so a hot pool pays no extra round trip. Not
 * configurable.
 */
const IDLE_VALIDATION_THRESHOLD_MS = 1_000;

function defaultNow(): number {
  return performance.now();
}

type HealthRow = {
  server_encoding: unknown;
  server_version_num: unknown;
  timezone: string;
  role: string;
  tls: boolean;
};

type BackendPidRow = { pid: number };
type CancelRow = { cancelled: boolean };

/**
 * The cancellation identity of one pinned backend, a transaction's or a
 * snapshot's. Signalled queries cancel this PID instead of probing for one;
 * the first probe of a transaction opened without it fills it in.
 */
interface BackendIdentity {
  pid: number | undefined;
}

/**
 * A backend PID that is not a positive safe integer. pg_cancel_backend must
 * never target it, so the query does not run and the connection that
 * reported it is discarded. It is not a connection error.
 */
class InvalidBackendPidError extends Error {
  constructor() {
    super("invalid backend identity");
  }
}

/**
 * Opens a moded or admitted transaction and reads its backend PID in one
 * value-free simple query. The isolation clause is exactly SET TRANSACTION
 * ISOLATION LEVEL READ COMMITTED, READ WRITE.
 */
const READ_COMMITTED_TRANSACTION_OPEN_SQL =
  "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE; SELECT pg_catalog.pg_backend_pid() AS pid";

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
  return READ_COMMITTED_TRANSACTION_OPEN_SQL;
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

/**
 * Checkout-scoped observer for a pooled client's asynchronous 'error' event.
 * idle_in_transaction_session_timeout (and a server shutdown) kills an idle
 * checked-out backend with a FATAL that node-pg emits on the Client rather
 * than on any query promise; with no listener that emit is an unhandled
 * process-level error. The state lives in this closure, never on the
 * PoolClient, and {@link detach} must run before the client is released so
 * the listener cannot linger on a client that returns to the pool.
 */
interface CheckoutAsyncFailureWatch {
  /** Whether the checked-out client emitted an asynchronous 'error'. */
  readonly failed: () => boolean;
  /** Whether the captured SQLSTATE is a connection termination (08xxx, 57P0x). */
  readonly terminated: () => boolean;
  /**
   * Gives a code-free normalized rejection the captured SQLSTATE, but only
   * when that code is a genuine connection termination or idle-in-transaction
   * kill (the same narrow gate as PostgreSqlSnapshotSession): the rejection
   * of a query on an already-dead client is a generic "not queryable" error
   * that carries no diagnostic of its own.
   */
  readonly reattach: (
    normalized: StorageOperationError,
    context: PostgreSqlOperationContext,
  ) => StorageOperationError;
  readonly detach: () => void;
}

function watchCheckoutAsyncFailure(client: PoolClient): CheckoutAsyncFailureWatch {
  let failed = false;
  let capturedSqlState: string | null = null;
  const onAsyncFailure = (error: unknown): void => {
    failed = true;
    capturedSqlState ??= sanitizeSqlState(error);
  };
  client.on("error", onAsyncFailure);
  return {
    failed: () => failed,
    terminated: () => capturedSqlState !== null && isPostgreSqlConnectionError({ code: capturedSqlState }),
    reattach: (normalized, context) => {
      if (
        capturedSqlState !== null
        && isPostgreSqlSnapshotTerminationSqlState(capturedSqlState)
        && normalized instanceof PostgreSqlStorageOperationError
        && normalized.sqlState === null
      ) {
        return new PostgreSqlStorageOperationError(
          normalized.code as "STORAGE_INITIALIZATION_FAILED" | "STORAGE_OPERATION_FAILED",
          context,
          capturedSqlState,
          true,
        );
      }
      return normalized;
    },
    detach: () => { client.removeListener("error", onAsyncFailure); },
  };
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

/** Reads and validates the PID of a backend whose identity is not known yet, recording it for reuse. */
async function probeBackendPid(client: PoolClient, identity: BackendIdentity | undefined): Promise<number> {
  const result = await client.query<BackendPidRow>({ text: "SELECT pg_backend_pid() AS pid" });
  const pid = validBackendPid(result.rows[0]?.pid);
  if (pid === undefined) throw new InvalidBackendPidError();
  if (identity !== undefined) identity.pid = pid;
  return pid;
}

/** A pool checkout with the observer that records its asynchronous 'error' events. */
interface Checkout {
  readonly client: PoolClient;
  readonly watch: CheckoutAsyncFailureWatch;
}

type ConnectOutcome =
  | ({ readonly kind: "connected" } & Checkout)
  | { readonly kind: "failed"; readonly error: unknown };

type ProbeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

type AbortRace<T> =
  | { readonly aborted: false; readonly value: T }
  | { readonly aborted: true };

/** The driver's own socket, reached through a narrow view of the client. */
type ClientWithStream = { readonly connection: { readonly stream: { destroy(): void } } };

async function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<AbortRace<T>> {
  if (!signal) return { aborted: false, value: await work };
  let observeAbort!: () => void;
  const abortOutcome = new Promise<{ readonly aborted: true }>((resolve) => {
    observeAbort = () => { resolve({ aborted: true }); };
  });
  signal.addEventListener("abort", observeAbort, { once: true });
  if (signal.aborted) observeAbort();
  try {
    return await Promise.race([
      work.then((value) => ({ aborted: false as const, value })),
      abortOutcome,
    ]);
  } finally {
    signal.removeEventListener("abort", observeAbort);
  }
}

/**
 * Makes the connection go away now. release(true) alone only starts a
 * graceful end() on the client, which never completes when the peer has gone
 * silent and would leak the socket, so the stream is destroyed first. The
 * error observer stays attached through the destroy and the release, and is
 * removed only once the client has left our hands.
 */
function discardCheckout({ client, watch }: Checkout): void {
  try {
    (client as unknown as ClientWithStream).connection.stream.destroy();
    client.release(true);
  } finally {
    watch.detach();
  }
}

function connectionLostError(): Error {
  return new Error("Connection terminated unexpectedly");
}

export class PostgreSqlRuntime implements PostgreSqlQueryExecutor {
  private readonly clientConfig: ClientConfig;
  private readonly pool: Pool;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private poolFailed = false;
  private readonly now: () => number;
  private readonly releasedAt = new WeakMap<PoolClient, number>();
  private readonly snapshots = new Set<PostgreSqlSnapshotSession>();

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
    this.now = dependencies.now ?? defaultNow;
    // A connection that returns healthy starts its idle clock; one released
    // with an error is destroyed by the pool and has no clock to keep.
    this.pool.on("release", (error: Error | undefined, client: PoolClient) => {
      if (error) this.releasedAt.delete(client);
      else this.releasedAt.set(client, this.now());
    });
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

  /** Open after factory/schema/project admission; never changes mutation mode. */
  async openReadOnlySnapshot(
    input: Omit<PostgreSqlSnapshotOptions, "snapshotIdleTimeoutMs">,
  ): Promise<PostgreSqlSnapshotSession> {
    const context = { ...input, domain: "transaction", operation: "snapshot" } as const;
    const projectIds = normalizedProjectScope(context);
    if (projectIds.length !== 1) throw transactionScopeError(context);
    const options = {
      projectId: projectIds[0]!,
      signal: input.signal,
      // Derived once from this runtime's own connection settings, never
      // from a per-call caller override. This is the single seam that
      // resolves an omitted snapshotIdleTimeoutMs to the definite fallback
      // the snapshot actually applies.
      snapshotIdleTimeoutMs: this.settings.snapshotIdleTimeoutMs,
    };
    this.assertOpen(context);
    const client = await this.acquire(context).catch((error: unknown): never => {
      throw normalizePostgreSqlError(error, context);
    });
    let session: PostgreSqlSnapshotSession | undefined;
    const admitted = new Set(projectIds);
    try {
      this.assertOpen(context);
    } catch (error) {
      try {
        client.release(true);
      } finally {
        throw error;
      }
    }
    // idle_in_transaction_session_timeout is checked between statements,
    // so the FATAL it produces on an idle snapshot ordinarily has no
    // in-flight query to reject; node-pg instead emits 'error' on the
    // checked-out Client. Scoped to this snapshot checkout only (see
    // issue #1424 for the wider gap on other checked-out clients): without
    // a listener that emit is an unhandled process-level error. Removed on
    // release so it never lingers on a client returned to the pool.
    //
    // forwardAsyncFailure is definitely assigned before any 'error' can be
    // delivered: PostgreSqlSnapshotSession.open constructs the session
    // synchronously and its constructor calls onAsyncFailure in the same
    // tick as the attach below, before open's first await. EventEmitter
    // delivery is synchronous as well, so no event can reach
    // onClientAsyncFailure while the variable is unassigned; there is no
    // pre-registration window and therefore no placeholder to fill it.
    // Attach and detach are unconditional for the same reason: the
    // session always registers in this runtime-driven flow, so a guard
    // around either would have a structurally unreachable arm.
    let forwardAsyncFailure!: (sqlState: string | null) => void;
    const onClientAsyncFailure = (error: unknown): void => { forwardAsyncFailure(sanitizeSqlState(error)); };
    client.on("error", onClientAsyncFailure);
    // The session registers its identity witness here once its raw opener
    // returns, so no snapshot query ever probes for a PID.
    const identity: BackendIdentity = { pid: undefined };
    session = await PostgreSqlSnapshotSession.open({
      query: <R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
        config: QueryConfig<I>, queryOptions: PostgreSqlQueryOptions,
      ) => this.queryClient<R, I>(
        client, config, snapshotScopedQueryOptions(queryOptions, admitted, options.projectId), identity,
      ),
      begin: (text) => client.query(text),
      registerBackendPid: (pid) => { identity.pid = pid; },
      rollback: async () => { await client.query("ROLLBACK"); },
      release: (destroy) => {
        client.removeListener("error", onClientAsyncFailure);
        if (session) this.snapshots.delete(session);
        client.release(destroy);
      },
      onAsyncFailure: (handler) => { forwardAsyncFailure = handler; },
    }, options);
    if (this.closed) {
      await session.close();
      this.assertOpen(context);
    }
    this.snapshots.add(session);
    return session;
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
    let watch: CheckoutAsyncFailureWatch | undefined;
    let destroy = false;
    try {
      client = await this.acquire(options);
      watch = watchCheckoutAsyncFailure(client);
      const result = await this.queryClient<R, I>(client, config, options);
      this.poolFailed = false;
      return result;
    } catch (error) {
      destroy = options.signal?.aborted === true
        || isPostgreSqlConnectionError(error)
        || error instanceof InvalidBackendPidError;
      const normalized = normalizePostgreSqlError(error, options);
      throw watch?.reattach(normalized, options) ?? normalized;
    } finally {
      watch?.detach();
      client?.release(destroy || watch?.failed() === true);
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
    let watch: CheckoutAsyncFailureWatch | undefined;
    let destroy = false;
    let commitAttempted = false;
    const identity: BackendIdentity = { pid: undefined };
    try {
      client = await this.acquire(options);
      watch = watchCheckoutAsyncFailure(client);
      if (options.signal?.aborted) {
        destroy = true;
        throw aborted(options);
      }
      // A moded or admitted transaction reads its backend PID in the same
      // exchange as BEGIN; a modeless one keeps plain BEGIN and reads the PID
      // at its first signalled query, where the per-query probe first ran.
      // Every signalled query then cancels that one PID, which needs one
      // server backend for the whole transaction: a direct connection, session
      // pooling, or any proxy that pins one server per transaction. Portable
      // migration already holds a session-level advisory lock, so it is not
      // transaction-pooler compatible today; this adds no pinning assumption.
      const opened: unknown = await client.query(setupSql ?? "BEGIN");
      if (options.signal?.aborted) {
        destroy = true;
        throw aborted(options);
      }
      if (setupSql !== undefined) {
        identity.pid = fusedBackendPid(opened);
        if (identity.pid === undefined) {
          destroy = true;
          throw new InvalidBackendPidError();
        }
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
          || error instanceof InvalidBackendPidError
        ) {
          destroy = true;
        }
        const normalized = watch!.reattach(
          normalizePostgreSqlError(error, failureOptions),
          failureOptions,
        );
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
            return await this.queryClient<R, I>(client!, config, effectiveOptions, identity);
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
              return await this.queryClient<R, I>(client!, config, effectiveOptions, identity);
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
                        identity,
                      );
                    } catch (error) {
                      const connectionFailure =
                        isPostgreSqlConnectionError(error);
                      const identityFailure = error instanceof InvalidBackendPidError;
                      const queryAborted =
                        effectiveOptions.signal?.aborted === true;
                      const normalized = watch!.reattach(
                        normalizePostgreSqlError(error, effectiveOptions),
                        effectiveOptions,
                      );
                      savepointFailed = true;
                      savepointFailure ??= normalized;
                      savepointFailureRecoverable =
                        !queryAborted && !connectionFailure && !identityFailure && !watch!.failed();
                      if (!savepointFailureRecoverable) {
                        recordFatalFailure(
                          normalized,
                          effectiveOptions,
                          queryAborted || connectionFailure || identityFailure,
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
      const commitOutcomeAmbiguous = commitAttempted
        && (connectionFailure || watch?.terminated() === true);
      if (
        options.signal?.aborted === true
        || connectionFailure
        || watch?.failed() === true
      ) destroy = true;
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
      const normalized = normalizePostgreSqlError(error, options);
      throw commitAttempted ? watch!.reattach(normalized, options) : normalized;
    } finally {
      watch?.detach();
      client?.release(destroy || watch?.failed() === true);
    }
  }

  poolDiagnostics(): PostgreSqlDiagnosticPool {
    const counts: unknown[] = [this.settings.poolMax, this.pool.totalCount, this.pool.idleCount, this.pool.waitingCount];
    // An established out-of-range number outranks a missing counter, matching the telemetry contract.
    const rejection = counts.some(value => typeof value === "number" && !(Number.isSafeInteger(value) && value >= 0)) ? "out-of-range"
      : counts.some(value => typeof value !== "number") ? "unavailable" : undefined;
    if (rejection !== undefined) throw new PostgreSqlDiagnosticPoolError(rejection);
    return {
      configuredMax: this.settings.poolMax,
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
      failed: this.poolFailed,
    };
  }

  async health(signal?: AbortSignal): Promise<PostgreSqlRuntimeHealth> {
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
      }, { domain: "factory", operation: "health", signal });
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
        signal,
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
        signal,
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
    this.closePromise = Promise.allSettled([...this.snapshots].map((session) => session.close()))
      .then(() => this.pool.end()).catch((error: unknown): never => {
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
    // A silently dead idle connection is found by a bounded SELECT 1 and
    // replaced; each failed checkout removes one connection from the pool, so
    // poolMax + 1 checkouts always reach a fresh connection.
    let staleBefore = Number.NEGATIVE_INFINITY;
    let probeTimedOut = false;
    for (let checkouts = 0; checkouts <= this.settings.poolMax; checkouts += 1) {
      if (signal?.aborted) throw aborted(context);
      const connecting = this.connectObserved();
      const connected = await raceAbort(connecting, signal);
      if (connected.aborted) {
        void connecting.then((lateOutcome) => {
          if (lateOutcome.kind !== "connected") return;
          try {
            discardCheckout(lateOutcome);
          } catch {
            // The operation has already failed closed; a late client must never
            // surface credentials or create an unhandled rejection.
          }
        });
        throw aborted(context);
      }
      const outcome = connected.value;
      if (outcome.kind === "failed") {
        if (signal?.aborted) throw aborted(context);
        throw outcome.error;
      }
      if (signal?.aborted) {
        discardCheckout(outcome);
        throw aborted(context);
      }
      const { client, watch } = outcome;
      const releasedAt = this.releasedAt.get(client);
      if (releasedAt === undefined) {
        watch.detach();
        return client;
      }
      if (releasedAt <= staleBefore) {
        discardCheckout(outcome);
        continue;
      }
      const probeStartedAt = this.now();
      if (probeStartedAt - releasedAt < IDLE_VALIDATION_THRESHOLD_MS) {
        watch.detach();
        return client;
      }
      if (probeTimedOut) {
        // One probe timeout per acquire: once it is spent, any other
        // connection old enough to need a probe is discarded unprobed.
        discardCheckout(outcome);
        continue;
      }
      const probing = this.probeIdleClient(client);
      const probed = await raceAbort(probing, signal);
      if (probed.aborted) {
        discardCheckout(outcome);
        throw aborted(context);
      }
      const asyncFailure = watch.failed();
      if (probed.value.ok && !asyncFailure) {
        watch.detach();
        return client;
      }
      discardCheckout(outcome);
      const failure = probed.value.ok ? undefined : probed.value.error;
      if (asyncFailure || (failure instanceof Error && failure.message === "Query read timeout")) {
        // Every connection idle since before this probe began is as suspect as
        // the one that just failed; connections released later are not.
        if (!signal?.aborted) staleBefore = Math.max(staleBefore, probeStartedAt);
        probeTimedOut = true;
      } else if (!isPostgreSqlConnectionError(failure)) {
        throw failure;
      }
    }
    throw connectionLostError();
  }

  /** Connects through the pool and observes the client's 'error' events from the moment it resolves. */
  private connectObserved(): Promise<ConnectOutcome> {
    return Promise.resolve()
      .then(() => this.pool.connect())
      .then(
        (client) => ({ kind: "connected" as const, client, watch: watchCheckoutAsyncFailure(client) }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
  }

  private probeIdleClient(client: PoolClient): Promise<ProbeOutcome> {
    const probe: QueryConfig & { query_timeout: number } = {
      text: "SELECT 1",
      query_timeout: Math.max(1, this.settings.connectionTimeoutMs),
    };
    return client.query(probe).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  }

  private async queryClient<
    R extends QueryResultRow = QueryResultRow,
    I extends unknown[] = unknown[],
  >(
    client: PoolClient,
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
    identity?: BackendIdentity,
  ): Promise<QueryResult<R>> {
    const signal = options.signal;
    // A text with several statements gets a deadline that never undercuts the
    // server's per-statement limit; single statements keep the connection default.
    const statements = 1 + (config.text.match(/;/gu)?.length ?? 0);
    const queryTimeout = statements > 1
      ? postgreSqlQueryDeadlineMs(this.settings, statements)
      : undefined;
    if (!signal) {
      if (queryTimeout === undefined) return client.query<R, I>(config);
      const bounded: QueryConfig<I> & { query_timeout: number } = { ...config, query_timeout: queryTimeout };
      return client.query<R, I>(bounded);
    }
    if (signal.aborted) throw aborted(options);
    const pid = identity?.pid ?? await probeBackendPid(client, identity);
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
      const query: Query<R, I> & { query_timeout?: number } = new Query<R, I>(config, (error, result) => {
        resolve({ error: error ?? null, result: result as QueryResult<R> | undefined });
      });
      if (queryTimeout !== undefined) query.query_timeout = queryTimeout;
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
