import { StorageOperationError } from "../errors.js";
import type { PostgreSqlOperationContext } from "./contracts.js";

const RETRYABLE_SQLSTATES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "40001",
  "40P01",
  "53300",
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

export function isRetryablePostgreSqlError(error: unknown): boolean {
  const candidate = error as PostgreSqlDriverError | undefined;
  const code = candidate?.code;
  if (typeof code === "string" && (RETRYABLE_SQLSTATES.has(code) || RETRYABLE_TRANSPORT_CODES.has(code))) {
    return true;
  }
  return error instanceof Error && RETRYABLE_DRIVER_MESSAGES.has(error.message);
}

export function normalizePostgreSqlError(
  error: unknown,
  context: PostgreSqlOperationContext,
  code: "STORAGE_INITIALIZATION_FAILED" | "STORAGE_OPERATION_FAILED" = "STORAGE_OPERATION_FAILED",
): StorageOperationError {
  if (error instanceof StorageOperationError) return error;
  return new StorageOperationError(
    code,
    "postgresql",
    context.projectId,
    context.domain,
    context.operation,
    { retryable: isRetryablePostgreSqlError(error) },
  );
}
