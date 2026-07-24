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
  "timeout exceeded when trying to connect",
  "timeout expired",
]);

type PostgreSqlDriverError = Error & { code?: unknown };

export class PostgreSqlStorageOperationError extends StorageOperationError {
  constructor(
    code: "STORAGE_INITIALIZATION_FAILED" | "STORAGE_OPERATION_FAILED",
    context: PostgreSqlOperationContext,
    readonly sqlState: string | null,
    retryable: boolean,
  ) {
    super(code, "postgresql", context.projectId, context.domain, context.operation, { retryable });
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), sqlState: this.sqlState };
  }
}

/**
 * A transport failure observed after COMMIT was sent. The server may have
 * committed successfully, so callers must reconcile through an authoritative
 * read before retrying a non-idempotent operation.
 */
export class PostgreSqlCommitOutcomeUnknownError extends StorageOperationError {
  constructor(context: PostgreSqlOperationContext) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      context.projectId,
      context.domain,
      context.operation,
    );
    this.name = "PostgreSqlCommitOutcomeUnknownError";
  }
}

function sanitizeSqlState(error: unknown): string | null {
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
