import type { QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlExtensionStatus,
  PostgreSqlQueryExecutor,
} from "./contracts.js";

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
  preloaded: boolean | null;
};

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
): PostgreSqlExtensionStatus {
  const defaultVersion = row?.default_version ?? null;
  const installedVersion = row?.installed_version ?? null;
  const requiredSchema = REQUIRED_POSTGRESQL_EXTENSION_SCHEMAS[name];
  const installedSchema = row?.installed_schema ?? null;
  const relocatable = row?.relocatable ?? null;
  const preloadRequired = name === "pg_stat_statements";
  const preloaded = preloadRequired ? row?.preloaded ?? null : null;
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
  const result = await executor.query<ExtensionRow, [readonly RequiredExtensionName[]]>({
    text: `WITH required(name) AS (
             SELECT pg_catalog.unnest($1::text[])
           )
           SELECT required.name,
                  available.default_version,
                  installed.extversion::text AS installed_version,
                  namespace.nspname::text AS installed_schema,
                  installed_version.relocatable,
                  CASE WHEN required.name = 'pg_stat_statements'
                    THEN EXISTS (
                      SELECT 1
                      FROM pg_catalog.pg_get_loaded_modules() AS loaded
                      WHERE loaded.module_name = 'pg_stat_statements'
                         OR loaded.file_name ~ '(^|/)pg_stat_statements([.][^/]*)?$'
                    )
                    ELSE NULL
                  END AS preloaded
           FROM required
           LEFT JOIN pg_catalog.pg_available_extensions AS available
             ON available.name = required.name
           LEFT JOIN pg_catalog.pg_extension AS installed
             ON installed.extname = required.name
           LEFT JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid = installed.extnamespace
           LEFT JOIN pg_catalog.pg_available_extension_versions AS installed_version
             ON installed_version.name = required.name
            AND installed_version.version = installed.extversion
            AND installed_version.installed
           ORDER BY required.name`,
    values: [REQUIRED_POSTGRESQL_EXTENSIONS],
  }, {
    domain: "factory",
    operation: options.operation ?? "inspectRequiredExtensions",
    signal: options.signal,
  });
  const rows = new Map(result.rows.map((row) => [row.name, row]));
  return REQUIRED_POSTGRESQL_EXTENSIONS.map((name) => extensionStatus(name, rows.get(name)));
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
