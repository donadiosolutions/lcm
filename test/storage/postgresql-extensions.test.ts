import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";
import {
  areRequiredPostgreSqlExtensionsReady,
  assertRequiredPostgreSqlExtensionsReady,
  inspectRequiredPostgreSqlExtensions,
  PostgreSqlExtensionPreflightError,
  REQUIRED_POSTGRESQL_EXTENSIONS,
} from "../../src/storage/postgresql/extensions.js";

type ExtensionRow = QueryResultRow & {
  name: string;
  default_version: string | null;
  installed_version: string | null;
  installed_schema: string | null;
  relocatable: boolean | null;
  preloaded: boolean | null;
};

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function executor(rows: ExtensionRow[]) {
  const query = vi.fn(async <R extends QueryResultRow>(
    _config: unknown,
    _options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> => result(rows as unknown as R[]));
  return { query } satisfies PostgreSqlQueryExecutor;
}

const CURRENT_ROWS: ExtensionRow[] = REQUIRED_POSTGRESQL_EXTENSIONS.map((name) => ({
  name,
  default_version: "1.0",
  installed_version: "1.0",
  installed_schema: "public",
  relocatable: true,
  preloaded: name === "pg_stat_statements" ? true : null,
}));

describe("PostgreSQL required extension preflight", () => {
  it("uses an exact allowlist and returns current status in deterministic order", async () => {
    expect(REQUIRED_POSTGRESQL_EXTENSIONS).toEqual([
      "pg_stat_statements",
      "pg_trgm",
      "pgcrypto",
      "unaccent",
    ]);
    const seam = executor([...CURRENT_ROWS].reverse());
    const statuses = await inspectRequiredPostgreSqlExtensions(seam);
    expect(statuses).toEqual(REQUIRED_POSTGRESQL_EXTENSIONS.map((name) => ({
        name,
        available: true,
        defaultVersion: "1.0",
        installedVersion: "1.0",
        requiredSchema: "public",
        installedSchema: "public",
        relocatable: true,
        preloadRequired: name === "pg_stat_statements",
        preloaded: name === "pg_stat_statements" ? true : null,
        status: "current",
        remediation: null,
      })));
    expect(areRequiredPostgreSqlExtensionsReady(statuses)).toBe(true);
    expect(seam.query).toHaveBeenCalledWith({
      text: expect.stringMatching(/FROM required[\s\S]+LEFT JOIN pg_catalog\.pg_available_extensions[\s\S]+LEFT JOIN pg_catalog\.pg_extension[\s\S]+LEFT JOIN pg_catalog\.pg_namespace[\s\S]+LEFT JOIN pg_catalog\.pg_available_extension_versions/u),
      values: [REQUIRED_POSTGRESQL_EXTENSIONS],
    }, {
      domain: "factory",
      operation: "inspectRequiredExtensions",
      signal: undefined,
    });
  });

  it("requires each current extension name exactly once", async () => {
    const statuses = await inspectRequiredPostgreSqlExtensions(executor(CURRENT_ROWS));
    expect(areRequiredPostgreSqlExtensionsReady(statuses)).toBe(true);
    expect(areRequiredPostgreSqlExtensionsReady(statuses.slice(1))).toBe(false);
    expect(areRequiredPostgreSqlExtensionsReady([
      statuses[0]!,
      statuses[1]!,
      statuses[2]!,
      statuses[2]!,
    ])).toBe(false);
    expect(areRequiredPostgreSqlExtensionsReady([...statuses, statuses[0]!])).toBe(false);
  });

  it("reports unavailable, uninstalled, and outdated extensions with sanitized guidance", async () => {
    const unsafeVersion = "1.3'; DROP EXTENSION pg_trgm; --";
    const seam = executor([
      { name: "pg_trgm", default_version: "1.6", installed_version: null, installed_schema: null, relocatable: null, preloaded: null },
      { name: "pgcrypto", default_version: unsafeVersion, installed_version: "1.2", installed_schema: "public", relocatable: true, preloaded: null },
      { name: "unaccent", default_version: null, installed_version: null, installed_schema: null, relocatable: null, preloaded: null },
      { name: "not_required", default_version: "9", installed_version: "9", installed_schema: "private", relocatable: true, preloaded: null },
    ]);
    const signal = new AbortController().signal;
    const statuses = await inspectRequiredPostgreSqlExtensions(seam, {
      operation: "customInspection",
      signal,
    });

    expect(statuses).toEqual([
      {
        name: "pg_stat_statements",
        available: false,
        defaultVersion: null,
        installedVersion: null,
        requiredSchema: "public",
        installedSchema: null,
        relocatable: null,
        preloadRequired: true,
        preloaded: null,
        status: "unavailable",
        remediation: "Install extension \"pg_stat_statements\" on the PostgreSQL server, then run CREATE EXTENSION \"pg_stat_statements\" WITH SCHEMA \"public\";",
      },
      {
        name: "pg_trgm",
        available: true,
        defaultVersion: "1.6",
        installedVersion: null,
        requiredSchema: "public",
        installedSchema: null,
        relocatable: null,
        preloadRequired: false,
        preloaded: null,
        status: "uninstalled",
        remediation: "CREATE EXTENSION \"pg_trgm\" WITH SCHEMA \"public\";",
      },
      {
        name: "pgcrypto",
        available: true,
        defaultVersion: unsafeVersion,
        installedVersion: "1.2",
        requiredSchema: "public",
        installedSchema: "public",
        relocatable: true,
        preloadRequired: false,
        preloaded: null,
        status: "outdated",
        remediation: "ALTER EXTENSION \"pgcrypto\" UPDATE TO '1.3''; DROP EXTENSION pg_trgm; --';",
      },
      {
        name: "unaccent",
        available: false,
        defaultVersion: null,
        installedVersion: null,
        requiredSchema: "public",
        installedSchema: null,
        relocatable: null,
        preloadRequired: false,
        preloaded: null,
        status: "unavailable",
        remediation: "Install extension \"unaccent\" on the PostgreSQL server, then run CREATE EXTENSION \"unaccent\" WITH SCHEMA \"public\";",
      },
    ]);
    expect(seam.query).toHaveBeenCalledWith(expect.any(Object), {
      domain: "factory",
      operation: "customInspection",
      signal,
    });
    expect(areRequiredPostgreSqlExtensionsReady(statuses)).toBe(false);
    expect(areRequiredPostgreSqlExtensionsReady(statuses.slice(1))).toBe(false);
  });

  it("preserves catalog data when installed extension control files are unavailable", async () => {
    const installedVersion = "1.3'; SELECT private_data; --";
    const seam = executor(CURRENT_ROWS.map((row) => row.name === "pgcrypto"
      ? {
        ...row,
        default_version: null,
        installed_version: installedVersion,
        relocatable: null,
      }
      : row));

    const statuses = await inspectRequiredPostgreSqlExtensions(seam);
    const pgcrypto = statuses.find((extension) => extension.name === "pgcrypto");
    expect(pgcrypto).toEqual({
      name: "pgcrypto",
      available: false,
      defaultVersion: null,
      installedVersion,
      requiredSchema: "public",
      installedSchema: "public",
      relocatable: null,
      preloadRequired: false,
      preloaded: null,
      status: "installed-unavailable",
      remediation: "Restore extension \"pgcrypto\" control files for installed version '1.3''; SELECT private_data; --' on the PostgreSQL server, then rerun readiness checks.",
    });
    expect(pgcrypto?.remediation).not.toContain("CREATE EXTENSION");
    expect(areRequiredPostgreSqlExtensionsReady(statuses)).toBe(false);
  });

  it("requires pg_stat_statements to be configured and functionally loaded", async () => {
    const seam = executor(CURRENT_ROWS.map((row) => row.name === "pg_stat_statements"
      ? { ...row, preloaded: false }
      : row));

    const statuses = await inspectRequiredPostgreSqlExtensions(seam);
    expect(statuses[0]).toMatchObject({
      name: "pg_stat_statements",
      preloadRequired: true,
      preloaded: false,
      status: "not-preloaded",
      remediation: "Add \"pg_stat_statements\" to shared_preload_libraries and restart PostgreSQL.",
    });
    expect(areRequiredPostgreSqlExtensionsReady(statuses)).toBe(false);
    expect(seam.query.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringContaining("pg_get_loaded_modules"),
    });

    await expect(assertRequiredPostgreSqlExtensionsReady(executor(
      CURRENT_ROWS.map((row) => row.name === "pg_stat_statements"
        ? { ...row, preloaded: false }
        : row),
    ))).rejects.toMatchObject({
      extensions: expect.arrayContaining([
        expect.objectContaining({ name: "pg_stat_statements", status: "not-preloaded" }),
      ]),
    });
  });

  it("rejects wrong namespaces with relocatable and non-relocatable remediation", async () => {
    const seam = executor(CURRENT_ROWS.map((row) => {
      if (row.name === "pg_trgm") return { ...row, installed_schema: "search", relocatable: true };
      if (row.name === "pg_stat_statements") {
        return { ...row, installed_schema: "monitoring", relocatable: false };
      }
      return row;
    }));

    const statuses = await inspectRequiredPostgreSqlExtensions(seam);
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "pg_trgm",
        installedSchema: "search",
        requiredSchema: "public",
        relocatable: true,
        status: "wrong-namespace",
        remediation: "ALTER EXTENSION \"pg_trgm\" SET SCHEMA \"public\";",
      }),
      expect.objectContaining({
        name: "pg_stat_statements",
        installedSchema: "monitoring",
        requiredSchema: "public",
        relocatable: false,
        status: "wrong-namespace",
        remediation: "Extension \"pg_stat_statements\" must be reinstalled in schema \"public\" because its installed version is not relocatable.",
      }),
    ]));
    expect(areRequiredPostgreSqlExtensionsReady(statuses)).toBe(false);
    expect(seam.query.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringMatching(/pg_extension[\s\S]+pg_namespace/u),
    });
  });

  it("accepts current extensions and rejects other states with serializable diagnostics", async () => {
    const current = executor(CURRENT_ROWS);
    const statuses = await assertRequiredPostgreSqlExtensionsReady(current);
    expect(areRequiredPostgreSqlExtensionsReady(statuses)).toBe(true);

    const unavailable = executor(CURRENT_ROWS.slice(1));
    let failure: unknown;
    try {
      await assertRequiredPostgreSqlExtensionsReady(unavailable, { operation: "migrationPreflight" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PostgreSqlExtensionPreflightError);
    expect(failure).toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      backend: "postgresql",
      domain: "factory",
      operation: "migrationPreflight",
      extensions: expect.arrayContaining([
        expect.objectContaining({ name: "pg_stat_statements", status: "unavailable" }),
      ]),
    });
    expect((failure as PostgreSqlExtensionPreflightError).toJSON()).toMatchObject({
      operation: "migrationPreflight",
      extensions: expect.arrayContaining([
        expect.objectContaining({ remediation: expect.stringContaining("CREATE EXTENSION") }),
      ]),
    });
  });
});
