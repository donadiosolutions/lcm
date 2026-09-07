import { describe, expect, it, vi } from "vitest";
import type { PostgreSqlQueryExecutor } from "../../src/storage/postgresql/contracts.js";
import { readPostgreSqlDiagnosticMetrics } from "../../src/storage/postgresql/diagnostics.js";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";

const PROJECT = "019ce627-88da-7000-8000-000000000001";
const OTHER = "019ce627-88da-7000-8000-000000000002";
const ROW = {
  conversations: "3", compacted_conversations: "2", messages: "9", summaries: "4",
  max_depth: 2, raw_tokens: "120", summary_tokens: "30", promoted_count: "5",
  built_in: "7", global: "2", project: "1", memories_surfaced: "4", memories_acted_upon: "2",
};
function fixture(projects: unknown[] = [{ project_id: PROJECT }, { project_id: OTHER }], rows: unknown[] = [ROW]) {
  const query = vi.fn().mockResolvedValueOnce({ rows: projects }).mockResolvedValueOnce({ rows });
  return { query, executor: { query } as unknown as PostgreSqlQueryExecutor };
}

describe("PostgreSQL diagnostic numeric reader", () => {
  it("returns only allowlisted numeric statistics using bound admitted UUIDs and projectless SELECTs", async () => {
    const { query, executor } = fixture();
    const signal = new AbortController().signal;
    expect(await readPostgreSqlDiagnosticMetrics(executor, signal)).toEqual({
      projects: 2, conversations: 3, compactedConversations: 2, messages: 9, summaries: 4,
      maxDepth: 2, rawTokens: 120, summaryTokens: 30, ratio: 4, promotedCount: 5,
      redactionCounts: { builtIn: 7, global: 2, project: 1, total: 10 },
      recallStats: { memoriesSurfaced: 4, memoriesActedUpon: 2, recallPrecision: 50 },
    });
    expect(query).toHaveBeenCalledTimes(2);
    for (const [config, options] of query.mock.calls) {
      expect(config.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT|SET)\b/u);
      expect(options).toEqual({ domain: "factory", operation: expect.any(String), signal });
    }
    expect(query.mock.calls[0][0].text).toMatch(/SELECT project_id FROM lcm.projects/u);
    expect(query.mock.calls[1][0].values).toEqual([[PROJECT, OTHER]]);
    expect(query.mock.calls[1][0].text).toContain("$1::pg_catalog.uuid[]");
  });

  it("scopes a selected project and ignores unexpected content fields", async () => {
    const { query, executor } = fixture(undefined, [{ ...ROW, content: "SECRET", error: "SECRET" }]);
    const metrics = await readPostgreSqlDiagnosticMetrics(executor, undefined, PROJECT.toUpperCase());
    expect(metrics.projects).toBe(1);
    expect(query.mock.calls[1][0].values).toEqual([[PROJECT]]);
    expect(JSON.stringify(metrics)).not.toContain("SECRET");
  });

  it.each(["invalid", "019ce627-88da-7000-8000-000000000003"])("rejects unadmitted selection %s", async (selection) => {
    const { query, executor } = fixture();
    await expect(readPostgreSqlDiagnosticMetrics(executor, undefined, selection)).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(query.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it.each([{ projects: [] }, { projects: [{ project_id: "private path" }] }, { projects: [{ project_id: PROJECT }, { project_id: PROJECT }] }])("does not turn malformed admission into zeros: %j", async ({ projects }) => {
    const { executor } = fixture(projects, projects.length ? [ROW] : [{ ...ROW, conversations: "0", compacted_conversations: "0", messages: "0", summaries: "0", max_depth: 0, raw_tokens: "0", summary_tokens: "0", promoted_count: "0", built_in: "0", global: "0", project: "0", memories_surfaced: "0", memories_acted_upon: "0" }]);
    if (projects.length) await expect(readPostgreSqlDiagnosticMetrics(executor)).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    else expect(await readPostgreSqlDiagnosticMetrics(executor)).toMatchObject({ projects: 0, ratio: 0, recallStats: { recallPrecision: null } });
  });

  it.each([undefined, null, -1, "-1", "NaN", "1e2", "9007199254740992", {}, 1.5])("rejects malformed or unsafe counters %j", async (value) => {
    await expect(readPostgreSqlDiagnosticMetrics(fixture(undefined, [{ ...ROW, messages: value }]).executor)).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
  });

  it("rejects missing aggregate rows and retains trusted permission errors internally", async () => {
    await expect(readPostgreSqlDiagnosticMetrics(fixture(undefined, []).executor)).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    const error = new PostgreSqlStorageOperationError("STORAGE_OPERATION_FAILED", { domain: "factory", operation: "diagnostics" }, "42501", false);
    const executor = { query: vi.fn().mockRejectedValue(error) } as unknown as PostgreSqlQueryExecutor;
    await expect(readPostgreSqlDiagnosticMetrics(executor)).rejects.toBe(error);
  });

  it("rejects non-string admitted identities", async () => {
    await expect(readPostgreSqlDiagnosticMetrics(fixture([{ project_id: null }]).executor)).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
  });

  it.each([1, 2])("discards results if cancellation occurs during query %s", async (abortOnQuery) => {
    const controller = new AbortController();
    let calls = 0;
    const query = vi.fn(async () => {
      calls++;
      if (calls === abortOnQuery) controller.abort();
      return { rows: calls === 1 ? [{ project_id: PROJECT }] : [ROW] };
    });
    await expect(readPostgreSqlDiagnosticMetrics({ query } as unknown as PostgreSqlQueryExecutor, controller.signal)).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(query).toHaveBeenCalledTimes(abortOnQuery);
  });

  it("does not query after cancellation", async () => {
    const { executor, query } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(readPostgreSqlDiagnosticMetrics(executor, controller.signal)).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(query).not.toHaveBeenCalled();
  });
});
