export const STAGED_POSTGRESQL_ERROR_CODE = "STORAGE_BACKEND_STAGED" as const;

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
