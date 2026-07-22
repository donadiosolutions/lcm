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
  "57P01",
  "57P02",
  "57P03",
]);

type PostgreSqlDriverError = Error & { code?: unknown };

export function isRetryablePostgreSqlError(error: unknown): boolean {
  const code = (error as PostgreSqlDriverError | undefined)?.code;
  return typeof code === "string" && RETRYABLE_SQLSTATES.has(code);
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
