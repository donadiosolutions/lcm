import type { QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlExtensionStatus,
  PostgreSqlQueryExecutor,
} from "./contracts.js";
import { PostgreSqlStorageOperationError } from "./errors.js";

export const REQUIRED_POSTGRESQL_EXTENSIONS = [
  "pg_stat_statements",
  "pg_trgm",
  "pgcrypto",
  "unaccent",
] as const satisfies readonly PostgreSqlExtensionStatus["name"][];

type RequiredExtensionName = (typeof REQUIRED_POSTGRESQL_EXTENSIONS)[number];

export const REQUIRED_POSTGRESQL_EXTENSION_SCHEMAS = {
  pg_stat_statements: "public",
  pg_trgm: "public",
  pgcrypto: "public",
  unaccent: "public",
} as const satisfies Record<RequiredExtensionName, PostgreSqlExtensionStatus["requiredSchema"]>;

type ExtensionRow = QueryResultRow & {
  name: string;
  default_version: string | null;
  installed_version: string | null;
  installed_schema: string | null;
  relocatable: boolean | null;
};

type PgStatStatementsProbeRow = QueryResultRow & {
  stats_reset: Date | string | null;
};

async function inspectRequiredPostgreSqlExtensionCatalog(
  executor: PostgreSqlQueryExecutor,
  options: { readonly operation: string; readonly signal?: AbortSignal },
): Promise<Map<string, ExtensionRow>> {
  const result = await executor.query<ExtensionRow, [readonly RequiredExtensionName[]]>({
    text: `WITH required(name) AS (
             SELECT pg_catalog.unnest($1::text[])
           )
           SELECT required.name,
                  available.default_version,
                  installed.extversion::text AS installed_version,
                  namespace.nspname::text AS installed_schema,
                  installed_version.relocatable
           FROM required
           LEFT JOIN pg_catalog.pg_available_extensions AS available
             ON available.name OPERATOR(pg_catalog.=) required.name
           LEFT JOIN pg_catalog.pg_extension AS installed
             ON installed.extname OPERATOR(pg_catalog.=) required.name
           LEFT JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid OPERATOR(pg_catalog.=) installed.extnamespace
           LEFT JOIN pg_catalog.pg_available_extension_versions AS installed_version
             ON installed_version.name OPERATOR(pg_catalog.=) required.name
            AND installed_version.version OPERATOR(pg_catalog.=) installed.extversion
            AND installed_version.installed
           ORDER BY required.name`,
    values: [REQUIRED_POSTGRESQL_EXTENSIONS],
  }, {
    domain: "factory",
    operation: options.operation,
    signal: options.signal,
  });
  return new Map(result.rows.map((row) => [row.name, row]));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function remediation(
  name: RequiredExtensionName,
  status: PostgreSqlExtensionStatus["status"],
  requiredSchema: PostgreSqlExtensionStatus["requiredSchema"],
  relocatable: boolean | null,
): string | null {
  if (status === "current") return null;
  if (status === "version-mismatch") {
    return `Extension "${name}" has different installed and server-default versions. Use a provider-supported extension version-management path to align them, then rerun readiness checks.`;
  }
  if (status === "wrong-namespace") {
    return relocatable === true
      ? `ALTER EXTENSION "${name}" SET SCHEMA ${quoteIdentifier(requiredSchema)};`
      : `Extension "${name}" must be reinstalled in schema ${quoteIdentifier(requiredSchema)} because its installed version is not relocatable.`;
  }
  if (status === "not-preloaded") {
    return `Add "${name}" to shared_preload_libraries and restart PostgreSQL.`;
  }
  if (status === "installed-unavailable") {
    return `Restore extension "${name}" control files for the installed version on the PostgreSQL server, then rerun readiness checks.`;
  }
  const create = `CREATE EXTENSION "${name}" WITH SCHEMA ${quoteIdentifier(requiredSchema)};`;
  return status === "unavailable"
    ? `Install extension "${name}" on the PostgreSQL server, then run ${create}`
    : create;
}

function extensionStatus(
  name: RequiredExtensionName,
  row: ExtensionRow | undefined,
  pgStatStatementsPreloaded: boolean | null,
): PostgreSqlExtensionStatus {
  const defaultVersion = row?.default_version ?? null;
  const installedVersion = row?.installed_version ?? null;
  const requiredSchema = REQUIRED_POSTGRESQL_EXTENSION_SCHEMAS[name];
  const installedSchema = row?.installed_schema ?? null;
  const relocatable = row?.relocatable ?? null;
  const preloadRequired = name === "pg_stat_statements";
  const preloaded = preloadRequired ? pgStatStatementsPreloaded : null;
  const available = defaultVersion !== null;
  const status: PostgreSqlExtensionStatus["status"] = !available
    ? installedVersion === null
      ? "unavailable"
      : "installed-unavailable"
    : installedVersion === null
      ? "uninstalled"
      : installedSchema !== requiredSchema
        ? "wrong-namespace"
        : installedVersion !== defaultVersion
          ? "version-mismatch"
          : preloadRequired && preloaded !== true
            ? "not-preloaded"
            : "current";
  return {
    name,
    available,
    defaultVersion,
    installedVersion,
    requiredSchema,
    installedSchema,
    relocatable,
    preloadRequired,
    preloaded,
    status,
    remediation: remediation(
      name,
      status,
      requiredSchema,
      relocatable,
    ),
  };
}

async function probePgStatStatements(
  executor: PostgreSqlQueryExecutor,
  options: { readonly operation?: string; readonly signal?: AbortSignal },
): Promise<boolean> {
  try {
    await executor.query<PgStatStatementsProbeRow>({
      text: "SELECT stats_reset FROM public.pg_stat_statements_info",
    }, {
      domain: "factory",
      operation: options.operation ?? "probePgStatStatements",
      signal: options.signal,
    });
    return true;
  } catch (error) {
    if (error instanceof PostgreSqlStorageOperationError && error.sqlState === "55000") {
      return false;
    }
    throw error;
  }
}

export function areRequiredPostgreSqlExtensionsReady(
  extensions: readonly PostgreSqlExtensionStatus[],
): boolean {
  const names = new Set(extensions.map((extension) => extension.name));
  return extensions.length === REQUIRED_POSTGRESQL_EXTENSIONS.length
    && names.size === REQUIRED_POSTGRESQL_EXTENSIONS.length
    && REQUIRED_POSTGRESQL_EXTENSIONS.every((name) => names.has(name))
    && extensions.every((extension) => extension.status === "current");
}

export class PostgreSqlExtensionPreflightError extends StorageOperationError {
  constructor(
    readonly extensions: readonly PostgreSqlExtensionStatus[],
    operation: string,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      operation,
    );
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), extensions: this.extensions };
  }
}

export async function inspectRequiredPostgreSqlExtensions(
  executor: PostgreSqlQueryExecutor,
  options: { readonly operation?: string; readonly signal?: AbortSignal } = {},
): Promise<readonly PostgreSqlExtensionStatus[]> {
  const rows = await inspectRequiredPostgreSqlExtensionCatalog(executor, {
    operation: options.operation ?? "inspectRequiredExtensions",
    signal: options.signal,
  });
  const pgStatStatements = rows.get("pg_stat_statements");
  const shouldProbe = pgStatStatements !== undefined
    && pgStatStatements.default_version !== null
    && pgStatStatements?.installed_version !== null
    && pgStatStatements.installed_version === pgStatStatements.default_version
    && pgStatStatements.installed_schema === REQUIRED_POSTGRESQL_EXTENSION_SCHEMAS.pg_stat_statements;
  const preloaded = shouldProbe
    ? await probePgStatStatements(executor, {
      operation: options.operation === undefined
        ? undefined
        : `${options.operation}:probePgStatStatements`,
      signal: options.signal,
    })
    : null;
  return REQUIRED_POSTGRESQL_EXTENSIONS.map((name) => (
    extensionStatus(name, rows.get(name), name === "pg_stat_statements" ? preloaded : null)
  ));
}

export async function assertRequiredPostgreSqlExtensionCatalogReady(
  executor: PostgreSqlQueryExecutor,
  options: {
    readonly operation?: string;
    readonly pgStatStatementsPreloaded: boolean;
    readonly signal?: AbortSignal;
  },
): Promise<readonly PostgreSqlExtensionStatus[]> {
  const operation = options.operation ?? "revalidateRequiredExtensionCatalog";
  const rows = await inspectRequiredPostgreSqlExtensionCatalog(executor, {
    operation,
    signal: options.signal,
  });
  const extensions = REQUIRED_POSTGRESQL_EXTENSIONS.map((name) => (
    extensionStatus(
      name,
      rows.get(name),
      name === "pg_stat_statements" ? options.pgStatStatementsPreloaded : null,
    )
  ));
  if (!areRequiredPostgreSqlExtensionsReady(extensions)) {
    throw new PostgreSqlExtensionPreflightError(extensions, operation);
  }
  return extensions;
}

export async function assertRequiredPostgreSqlExtensionsReady(
  executor: PostgreSqlQueryExecutor,
  options: { readonly operation?: string; readonly signal?: AbortSignal } = {},
): Promise<readonly PostgreSqlExtensionStatus[]> {
  const operation = options.operation ?? "preflightRequiredExtensions";
  const extensions = await inspectRequiredPostgreSqlExtensions(executor, { ...options, operation });
  if (!areRequiredPostgreSqlExtensionsReady(extensions)) {
    throw new PostgreSqlExtensionPreflightError(extensions, operation);
  }
  return extensions;
}
