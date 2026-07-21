import type { StorageBackendName, StorageDomain } from "./contracts.js";

export type StorageErrorCode =
  | "STORAGE_CLOSED"
  | "STORAGE_INITIALIZATION_FAILED"
  | "STORAGE_OPERATION_FAILED"
  | "STORAGE_UNSUPPORTED_CAPABILITY"
  | "STORAGE_NESTED_TRANSACTION"
  | "STORAGE_TRANSACTION_SCOPE";

export interface StorageErrorContext {
  backend: StorageBackendName;
  projectId?: string;
  domain: StorageDomain;
  operation: string;
}

function safeMessage(code: StorageErrorCode, context: StorageErrorContext): string {
  const project = context.projectId ? ` for project ${context.projectId}` : "";
  switch (code) {
    case "STORAGE_CLOSED": return `${context.backend} storage is closed${project}`;
    case "STORAGE_UNSUPPORTED_CAPABILITY": return `${context.backend} storage does not support ${context.operation}${project}`;
    case "STORAGE_NESTED_TRANSACTION": return `nested ${context.backend} storage transactions are not supported${project}`;
    case "STORAGE_TRANSACTION_SCOPE": return `use the transaction-scoped repositories inside the active transaction${project}`;
    case "STORAGE_INITIALIZATION_FAILED": return `${context.backend} storage initialization failed${project}`;
    case "STORAGE_OPERATION_FAILED": return `${context.backend} ${context.domain} operation failed${project}`;
  }
}

/** A deliberately cause-free error safe for diagnostics and API responses. */
export class StorageOperationError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: StorageErrorCode,
    readonly backend: StorageBackendName,
    readonly projectId: string | undefined,
    readonly domain: StorageDomain,
    readonly operation: string,
    options?: { retryable?: boolean },
  ) {
    const context = { backend, projectId, domain, operation };
    super(safeMessage(code, context));
    this.name = "StorageOperationError";
    this.retryable = options?.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      backend: this.backend,
      projectId: this.projectId,
      domain: this.domain,
      operation: this.operation,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

export function normalizeStorageError(
  error: unknown,
  context: StorageErrorContext,
  code: StorageErrorCode = "STORAGE_OPERATION_FAILED",
): StorageOperationError {
  if (error instanceof StorageOperationError) return error;
  return new StorageOperationError(code, context.backend, context.projectId, context.domain, context.operation);
}
