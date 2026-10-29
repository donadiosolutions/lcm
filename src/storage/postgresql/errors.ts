import { StorageOperationError } from "../errors.js";
import type { PostgreSqlOperationContext } from "./contracts.js";

const RETRYABLE_SQLSTATES = new Set([
  "40001",
  "40P01",
  "53300",
]);

const CONNECTION_TERMINATION_SQLSTATES = new Set([
  "57P01",
  "57P02",
  "57P03",
]);

/**
 * Sessions killed by idle_in_transaction_session_timeout (25P03) are FATAL
 * and dead, exactly like a transport-level connection loss, but 25P03 is
 * class 25 ("Invalid Transaction State"), not 08 ("Connection Exception"),
 * so it is deliberately kept out of {@link CONNECTION_TERMINATION_SQLSTATES}.
 * Folding it in there would widen {@link isRetryablePostgreSqlError} and the
 * runtime's destroy decisions across the whole PostgreSQL layer, retrying a
 * FATAL idle-kill as if it were transient like ECONNRESET. That is the
 * wrong blast radius. It is used only by the narrower snapshot-local
 * predicate below.
 */
const SNAPSHOT_TERMINATION_SQLSTATES = new Set([
  "25P03",
  ...CONNECTION_TERMINATION_SQLSTATES,
]);

const RETRYABLE_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

const RETRYABLE_DRIVER_MESSAGES = new Set([
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly",
  "Query read timeout",
  "timeout exceeded when trying to connect",
  "timeout expired",
]);

type PostgreSqlDriverError = Error & { code?: unknown };

export class PostgreSqlStorageOperationError extends StorageOperationError {
  readonly machineId: string | undefined;

  constructor(
    code: "STORAGE_INITIALIZATION_FAILED" | "STORAGE_OPERATION_FAILED",
    context: PostgreSqlOperationContext,
    readonly sqlState: string | null,
    retryable: boolean,
  ) {
    super(code, "postgresql", context.projectId, context.domain, context.operation, { retryable });
    this.machineId = context.machineId;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      sqlState: this.sqlState,
      ...(this.machineId === undefined
        ? {}
        : { machineId: this.machineId }),
    };
  }
}

/**
 * A transport failure observed after COMMIT was sent. The server may have
 * committed successfully, so callers must reconcile through an authoritative
 * read before retrying a non-idempotent operation.
 */
export class PostgreSqlCommitOutcomeUnknownError extends StorageOperationError {
  readonly machineId: string | undefined;

  constructor(context: PostgreSqlOperationContext) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      context.projectId,
      context.domain,
      context.operation,
    );
    this.name = "PostgreSqlCommitOutcomeUnknownError";
    this.machineId = context.machineId;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      ...(this.machineId === undefined
        ? {}
        : { machineId: this.machineId }),
    };
  }
}

/**
 * Closed reason for a refused pool observation. A counter that is a number
 * but not an exact non-negative safe integer is out of range; a missing or
 * non-numeric counter is unavailable. The counter itself is never carried.
 */
export type PostgreSqlDiagnosticPoolRejection = "out-of-range" | "unavailable";

/** Thrown by the pool observation boundary; carries only the closed reason. */
export class PostgreSqlDiagnosticPoolError extends StorageOperationError {
  constructor(readonly reason: PostgreSqlDiagnosticPoolRejection) {
    super("STORAGE_OPERATION_FAILED", "postgresql", undefined, "factory", "poolDiagnostics");
  }
}

export function sanitizeSqlState(error: unknown): string | null {
  const code = (error as PostgreSqlDriverError | undefined)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : null;
}

export function isPostgreSqlConnectionError(error: unknown): boolean {
  const candidate = error as PostgreSqlDriverError | undefined;
  const code = candidate?.code;
  if (typeof code === "string" && (
    (code.length === 5 && code.startsWith("08"))
    || CONNECTION_TERMINATION_SQLSTATES.has(code)
    || RETRYABLE_TRANSPORT_CODES.has(code)
  )) {
    return true;
  }
  return error instanceof Error && RETRYABLE_DRIVER_MESSAGES.has(error.message);
}

/**
 * Whether a five-character SQLSTATE, already known to be present, has the
 * shape of a genuine PostgreSQL connection termination or idle-in-
 * transaction kill (25P03, 08xxx, 57P01/57P02/57P03). Shared by the
 * snapshot-local predicate below and by
 * {@link PostgreSqlSnapshotSession}'s captured-diagnostic reattach, so an
 * out-of-band client 'error' event can only ever be reattached and
 * classified as a termination when its own code actually looks like one;
 * a hypothetical async event carrying an unrelated code (pg never emits
 * one on a client 'error' event in practice) is captured but not reattached.
 */
export function isPostgreSqlSnapshotTerminationSqlState(sqlState: string): boolean {
  return sqlState === "25P03"
    || (sqlState.length === 5 && sqlState.startsWith("08"))
    || CONNECTION_TERMINATION_SQLSTATES.has(sqlState);
}

/**
 * A narrower, snapshot-local predicate for the read-only snapshot session
 * only. Matches 25P03 (idle-in-transaction session kill), 08xxx (connection
 * exception), 57P01/57P02/57P03 (admin/crash shutdown) and the existing
 * transport codes/messages, reading either the raw pre-normalize driver
 * error or the sqlState already carried by a normalized
 * {@link PostgreSqlStorageOperationError}. Deliberately NOT the same set as
 * {@link isPostgreSqlConnectionError}: use this only at the two seams that
 * need it (snapshot session destroy-on-error, and the session arm of
 * portable-source close() tolerance), never for the general retry/destroy
 * decisions the wider helper feeds.
 */
export function isPostgreSqlSnapshotTerminationError(error: unknown): boolean {
  if (error instanceof PostgreSqlStorageOperationError) {
    const sqlState = error.sqlState;
    if (sqlState !== null) {
      return isPostgreSqlSnapshotTerminationSqlState(sqlState);
    }
    // idle_in_transaction_session_timeout fires while no statement is
    // running: the FATAL arrives on the driver's asynchronous 'error'
    // event, not on the promise the failing operation rejects with. A
    // message-only torn connection (for example "Connection terminated
    // unexpectedly") survives normalization with sqlState null and
    // retryable true (RETRYABLE_DRIVER_MESSAGES / transport codes); that
    // is the shape this branch tolerates. It does NOT cover "Client has
    // encountered a connection error and is not queryable" (sqlState
    // null, retryable false): that generic local rejection is exactly
    // what an ordinary dead-but-undiagnosed client also produces, so it
    // stays untolerated here unless the snapshot checkout's async-failure
    // listener already captured a real diagnostic and reattached it
    // (see PostgreSqlSnapshotSession), which gives it a real sqlState and
    // takes the branch above instead. retryable alone is not a sufficient
    // signal in general: a 40001 serialization failure is retryable too,
    // but it keeps its own sqlState and never reaches this branch.
    return error.retryable === true;
  }
  const candidate = error as PostgreSqlDriverError | undefined;
  const code = candidate?.code;
  if (typeof code === "string" && (
    (code.length === 5 && code.startsWith("08"))
    || SNAPSHOT_TERMINATION_SQLSTATES.has(code)
    || RETRYABLE_TRANSPORT_CODES.has(code)
  )) {
    return true;
  }
  return error instanceof Error && RETRYABLE_DRIVER_MESSAGES.has(error.message);
}

export function isRetryablePostgreSqlError(error: unknown): boolean {
  const code = (error as PostgreSqlDriverError | undefined)?.code;
  return isPostgreSqlConnectionError(error)
    || (typeof code === "string" && RETRYABLE_SQLSTATES.has(code));
}

export function normalizePostgreSqlError(
  error: unknown,
  context: PostgreSqlOperationContext,
  code: "STORAGE_INITIALIZATION_FAILED" | "STORAGE_OPERATION_FAILED" = "STORAGE_OPERATION_FAILED",
): StorageOperationError {
  if (error instanceof StorageOperationError) return error;
  return new PostgreSqlStorageOperationError(
    code,
    context,
    sanitizeSqlState(error),
    isRetryablePostgreSqlError(error),
  );
}
