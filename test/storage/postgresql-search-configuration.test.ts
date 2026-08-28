import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";
import {
  assertPostgreSqlSearchConfigurationReady,
  inspectPostgreSqlSearchConfiguration,
  POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
  PostgreSqlSearchConfigurationPreflightError,
} from "../../src/storage/postgresql/search-configuration.js";

function executor(row?: QueryResultRow) {
  const query = vi.fn(async <R extends QueryResultRow>(
    _config: unknown,
    _options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> => ({
    command: "SELECT",
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: row === undefined ? [] : [row as R],
  }));
  return { query } satisfies PostgreSqlQueryExecutor;
}

describe("PostgreSQL text-search configuration readiness", () => {
  it("accepts the exact owned PostgreSQL 18 catalog fingerprint", async () => {
    const seam = executor({
      actual_sha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
      object_count: "19",
      ownership_ready: true,
    });
    await expect(assertPostgreSqlSearchConfigurationReady(seam)).resolves.toEqual({
      name: "lcm.search_v1",
      expectedSha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
      actualSha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
      objectCount: 19,
      ownershipReady: true,
      ready: true,
    });
    expect(seam.query).toHaveBeenCalledWith({
      text: expect.stringContaining("pg_catalog.pg_ts_config_map"),
    }, {
      domain: "factory",
      operation: "preflightSearchConfiguration",
      signal: undefined,
    });
    const inspectionSql = seam.query.mock.calls[0]?.[0].text ?? "";
    expect(inspectionSql).toMatch(
      /runtime_deparser_settings\s+AS\s+MATERIALIZED\s*\(\s*SELECT\s+pg_catalog\.set_config\(\s*'search_path'\s*,\s*'pg_catalog, public'\s*,\s*true\s*\)\s+AS\s+search_path\s*,\s*pg_catalog\.set_config\(\s*'quote_all_identifiers'\s*,\s*'off'\s*,\s*true\s*\)\s+AS\s+quote_all_identifiers\s*\)/u,
    );
    expect(inspectionSql).toContain("CROSS JOIN runtime_deparser_settings AS settings");
    const functionDefinitionOffset = inspectionSql.indexOf("pg_catalog.pg_get_functiondef");
    expect(functionDefinitionOffset).toBeGreaterThanOrEqual(0);
    const functionGuardStart = inspectionSql.lastIndexOf("CASE", functionDefinitionOffset);
    const functionGuardEnd = inspectionSql.indexOf("END", functionDefinitionOffset);
    expect(functionGuardStart).toBeGreaterThanOrEqual(0);
    expect(functionGuardEnd).toBeGreaterThan(functionDefinitionOffset);
    const functionGuard = inspectionSql.slice(functionGuardStart, functionGuardEnd + 3);
    expect(functionGuard).toMatch(
      /settings\.search_path\s+OPERATOR\(pg_catalog\.=\)\s*'pg_catalog, public'/u,
    );
    expect(functionGuard).toMatch(
      /settings\.quote_all_identifiers\s+OPERATOR\(pg_catalog\.=\)\s*'off'/u,
    );
    expect(functionGuard).toMatch(/ELSE\s+NULL/u);
    for (const catalogField of [
      "cfgparser",
      "pg_catalog.pg_ts_config",
      "pg_catalog.pg_ts_dict",
      "dicttemplate",
      "dictinitoption",
      "pg_catalog.pg_get_functiondef",
      "normalize_search_text",
      "proargtypes",
      "function_owner",
      "function_security_invoker",
      "function_acl_ready",
      "function_config",
      "prosecdef",
      "proconfig",
      "pg_catalog.aclexplode",
      "pg_catalog.acldefault",
    ]) expect(inspectionSql).toContain(catalogField);
    expect(inspectionSql).toContain("pg_catalog.count(maptokentype) AS mapping_count");
    expect(inspectionSql).toContain("FILTER (WHERE maptokentype IS NOT NULL) AS mappings");
    expect(inspectionSql).toContain(
      "owner_privilege.grantee\n                                OPERATOR(pg_catalog.=) procedure.proowner",
    );
    expect(inspectionSql).toContain(
      "owner_privilege.grantor\n                                OPERATOR(pg_catalog.=) procedure.proowner",
    );
    expect(inspectionSql).toContain(
      "owner_privilege.privilege_type\n                                OPERATOR(pg_catalog.=) 'EXECUTE'",
    );
    expect(inspectionSql).toContain(
      "owner_privilege.is_grantable\n                                OPERATOR(pg_catalog.=) false",
    );
    expect(inspectionSql).toContain(
      "privilege.grantee OPERATOR(pg_catalog.=) 0::pg_catalog.oid",
    );
    expect(inspectionSql).toContain(
      "privilege.grantor\n                                OPERATOR(pg_catalog.<>) procedure.proowner",
    );
    expect(inspectionSql).toContain(
      "privilege.privilege_type\n                                OPERATOR(pg_catalog.<>) 'EXECUTE'",
    );
    expect(inspectionSql).toContain(
      "privilege.is_grantable\n                                OPERATOR(pg_catalog.<>) false",
    );

    const direct = executor({
      actual_sha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
      object_count: "19",
      ownership_ready: true,
    });
    await expect(inspectPostgreSqlSearchConfiguration(direct)).resolves
      .toMatchObject({ ready: true });
    expect(direct.query).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      operation: "inspectSearchConfiguration",
    }));
  });

  it.each([
    {
      label: "missing objects",
      row: { actual_sha256: null, object_count: "0", ownership_ready: null },
      expected: { actualSha256: null, objectCount: 0, ownershipReady: false },
    },
    {
      label: "missing catalog row",
      row: undefined,
      expected: { actualSha256: null, objectCount: 0, ownershipReady: false },
    },
    {
      label: "mapping drift",
      row: { actual_sha256: "0".repeat(64), object_count: "19", ownership_ready: true },
      expected: { actualSha256: "0".repeat(64), objectCount: 19, ownershipReady: true },
    },
    {
      label: "ownership drift",
      row: {
        actual_sha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
        object_count: "invalid",
        ownership_ready: false,
      },
      expected: {
        actualSha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
        objectCount: 0,
        ownershipReady: false,
      },
    },
    {
      label: "function ACL drift",
      row: {
        actual_sha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
        object_count: "19",
        ownership_ready: false,
      },
      expected: {
        actualSha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
        objectCount: 19,
        ownershipReady: false,
      },
    },
  ])("rejects $label with structured diagnostics", async ({ row, expected }) => {
    const seam = executor(row);
    const signal = new AbortController().signal;
    const status = await inspectPostgreSqlSearchConfiguration(seam, {
      operation: "customSearchInspection",
      signal,
    });
    expect(status).toMatchObject({ ...expected, ready: false });
    expect(seam.query).toHaveBeenCalledWith(expect.any(Object), {
      domain: "factory",
      operation: "customSearchInspection",
      signal,
    });

    let failure: unknown;
    try {
      await assertPostgreSqlSearchConfigurationReady(executor(row));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PostgreSqlSearchConfigurationPreflightError);
    expect((failure as PostgreSqlSearchConfigurationPreflightError).toJSON())
      .toMatchObject({
        operation: "preflightSearchConfiguration",
        searchConfiguration: { ...expected, ready: false },
      });
  });
});
