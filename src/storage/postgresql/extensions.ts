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
};

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function remediation(
  name: RequiredExtensionName,
  status: PostgreSqlExtensionStatus["status"],
  defaultVersion: string | null,
  requiredSchema: PostgreSqlExtensionStatus["requiredSchema"],
  relocatable: boolean | null,
): string | null {
  if (status === "current") return null;
  if (status === "outdated") {
    return `ALTER EXTENSION "${name}" UPDATE TO ${quoteLiteral(defaultVersion as string)};`;
  }
  if (status === "wrong-namespace") {
    return relocatable === true
      ? `ALTER EXTENSION "${name}" SET SCHEMA ${quoteIdentifier(requiredSchema)};`
      : `Extension "${name}" must be reinstalled in schema ${quoteIdentifier(requiredSchema)} because its installed version is not relocatable.`;
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
  const available = row !== undefined && defaultVersion !== null;
  const status: PostgreSqlExtensionStatus["status"] = !available
    ? "unavailable"
    : installedVersion === null
      ? "uninstalled"
      : installedSchema !== requiredSchema
        ? "wrong-namespace"
        : installedVersion === defaultVersion
          ? "current"
          : "outdated";
  return {
    name,
    available,
    defaultVersion,
    installedVersion,
    requiredSchema,
    installedSchema,
    relocatable,
    status,
    remediation: remediation(name, status, defaultVersion, requiredSchema, relocatable),
  };
}

export function areRequiredPostgreSqlExtensionsReady(
  extensions: readonly PostgreSqlExtensionStatus[],
): boolean {
  return extensions.length === REQUIRED_POSTGRESQL_EXTENSIONS.length
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
    text: `SELECT available.name::text,
                  available.default_version,
                  available.installed_version,
                  namespace.nspname::text AS installed_schema,
                  installed_version.relocatable
           FROM pg_available_extensions AS available
           LEFT JOIN pg_extension AS installed
             ON installed.extname = available.name
           LEFT JOIN pg_namespace AS namespace
             ON namespace.oid = installed.extnamespace
           LEFT JOIN pg_available_extension_versions AS installed_version
             ON installed_version.name = available.name
            AND installed_version.version = available.installed_version
            AND installed_version.installed
           WHERE available.name = ANY($1::text[])
           ORDER BY available.name`,
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
