export const STAGED_POSTGRESQL_ERROR_CODE = "STORAGE_BACKEND_STAGED" as const;

export type StagedPostgreSqlHealthResponse = {
  readonly status?: string;
  readonly version?: string;
  readonly storageBackend?: string;
  readonly uptime?: number;
  readonly pid?: number;
  readonly storage?: {
    readonly status?: string;
    readonly error?: {
      readonly code?: string;
      readonly backend?: string;
      readonly domain?: string;
      readonly operation?: string;
    };
  };
};

export function isStagedPostgreSqlHealth(
  statusCode: number,
  health: StagedPostgreSqlHealthResponse | null | undefined,
): health is StagedPostgreSqlHealthResponse & {
  readonly storageBackend: "postgresql";
  readonly version: string;
  readonly uptime: number;
  readonly pid: number;
} {
  const error = health?.storage?.error;
  return statusCode === 503
    && health?.status === "unavailable"
    && health.storageBackend === "postgresql"
    && typeof health.version === "string"
    && typeof health.uptime === "number"
    && typeof health.pid === "number"
    && health.storage?.status === "unavailable"
    && error?.code === "STORAGE_INITIALIZATION_FAILED"
    && error.backend === "postgresql"
    && error.domain === "factory"
    && error.operation === "health";
}

export type StagedPostgreSqlUnavailableResponse = {
  readonly code: typeof STAGED_POSTGRESQL_ERROR_CODE;
  readonly error: string;
  readonly storageBackend: "postgresql";
};

export function stagedPostgreSqlUnavailablePayload(
  operation: string,
): StagedPostgreSqlUnavailableResponse {
  return {
    code: STAGED_POSTGRESQL_ERROR_CODE,
    error: `${operation} is unavailable while PostgreSQL storage repositories are staged`,
    storageBackend: "postgresql",
  };
}
