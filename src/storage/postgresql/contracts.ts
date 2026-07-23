import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import type { StorageDomain, StorageHealth } from "../contracts.js";

export interface PostgreSqlConnectionSettings {
  readonly url: string;
  readonly caFile: string;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface PostgreSqlOperationContext {
  readonly domain: StorageDomain;
  readonly operation: string;
  readonly projectId?: string;
}

export interface PostgreSqlQueryOptions extends PostgreSqlOperationContext {
  readonly signal?: AbortSignal;
}

export interface PostgreSqlQueryExecutor {
  query<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>>;
}

export interface PostgreSqlMigration {
  readonly id: string;
  readonly filename: string;
  readonly sha256: string;
  readonly sql: string;
}

export interface PostgreSqlMigrationResult {
  readonly applied: readonly string[];
  readonly current: readonly string[];
}

export type PostgreSqlExtensionReadiness =
  | "current"
  | "installed-unavailable"
  | "not-preloaded"
  | "unavailable"
  | "uninstalled"
  | "version-mismatch"
  | "wrong-namespace";

export interface PostgreSqlExtensionStatus {
  readonly name: "pg_stat_statements" | "pg_trgm" | "pgcrypto" | "unaccent";
  readonly available: boolean;
  readonly defaultVersion: string | null;
  readonly installedVersion: string | null;
  readonly requiredSchema: "public";
  readonly installedSchema: string | null;
  readonly relocatable: boolean | null;
  readonly preloadRequired: boolean;
  readonly preloaded: boolean | null;
  readonly status: PostgreSqlExtensionReadiness;
  readonly remediation: string | null;
}

export interface PostgreSqlSearchConfigurationStatus {
  readonly name: "lcm.search_v1";
  readonly expectedSha256: string;
  readonly actualSha256: string | null;
  readonly objectCount: number;
  readonly ownershipReady: boolean;
  readonly ready: boolean;
}

export interface PostgreSqlRuntimeHealth extends StorageHealth {
  readonly backend: "postgresql";
  readonly serverMajorVersion?: number | null;
  readonly tls?: boolean;
  readonly timezone?: string;
  readonly role?: string;
  readonly extensions?: readonly PostgreSqlExtensionStatus[];
  readonly searchConfiguration?: PostgreSqlSearchConfigurationStatus;
}

export interface PostgreSqlTestDatabaseSentinel {
  readonly runId: string;
  readonly databaseName: string;
  readonly expectedRole: string;
}

export interface PostgreSqlTestDatabaseLease {
  readonly sentinel: PostgreSqlTestDatabaseSentinel;
  readonly adminUrl: string;
  readonly migratorUrl: string;
  readonly runtimeUrl: string;
  drop(): Promise<void>;
}
