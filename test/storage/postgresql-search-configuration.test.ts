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
    for (const catalogField of [
      "cfgparser",
      "pg_catalog.pg_ts_config",
      "pg_catalog.pg_ts_dict",
      "dicttemplate",
      "dictinitoption",
    ]) expect(inspectionSql).toContain(catalogField);

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
