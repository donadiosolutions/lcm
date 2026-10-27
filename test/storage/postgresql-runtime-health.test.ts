import { describe, expect, it, vi } from "vitest";
import { StorageOperationError } from "../../src/storage/errors.js";
import { loadPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import type { PostgreSqlQueryExecutor } from "../../src/storage/postgresql/contracts.js";
import { readPostgreSqlMigrationLedger, readPostgreSqlQueueHealth } from "../../src/storage/postgresql/runtime-health.js";

const projectId = "01912345-1234-7123-8123-123456789abc";
function executor(rows: unknown[]) {
  const query = vi.fn(async () => ({ rows }));
  return { query, executor: { query } as unknown as PostgreSqlQueryExecutor };
}
const queueRow = (overrides: Record<string, unknown> = {}) =>
  ({ candidate_count: "3", claimed: "1", quarantined: "1", replay_lag_seconds: "12.5", ...overrides });

describe("PostgreSQL migration ledger read", () => {
  it("bounds the ordered read by the packaged count plus a sentinel and returns packaged IDs", async () => {
    const { query, executor: db } = executor([{ id: "0001_a", checksum_sha256: "a" }]);
    const signal = new AbortController().signal;
    const result = await readPostgreSqlMigrationLedger(db, signal);
    const packaged = loadPostgreSqlMigrations();
    expect(result.expected).toEqual(packaged.map(({ id, sha256 }) => ({ id, sha256 })));
    expect(result.rows).toEqual([{ id: "0001_a", checksum_sha256: "a" }]);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      { text: "SELECT id, checksum_sha256 FROM lcm.schema_migrations ORDER BY id LIMIT $1::pg_catalog.int4", values: [packaged.length + 1] },
      { domain: "factory", operation: "diagnosticMigrationHistory", signal },
    );
    expect(query.mock.calls[0]![1]).not.toHaveProperty("projectId");
    expect(query.mock.calls[0]![1]).not.toHaveProperty("projectIds");
  });
  it("uses an injected packaged list and refuses an aborted caller without querying", async () => {
    const { query, executor: db } = executor([]);
    const loader = vi.fn(() => [{ id: "0001_x", sha256: "x" }] as never);
    const result = await readPostgreSqlMigrationLedger(db, undefined, loader);
    expect(result.expected).toEqual([{ id: "0001_x", sha256: "x" }]);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ values: [2] }), expect.anything());
    const controller = new AbortController();
    controller.abort();
    await expect(readPostgreSqlMigrationLedger(db, controller.signal, loader)).rejects.toBeInstanceOf(StorageOperationError);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("discards a result that completes after cancellation", async () => {
    const controller = new AbortController();
    const query = vi.fn(async () => { controller.abort(); return { rows: [] }; });
    await expect(readPostgreSqlMigrationLedger({ query } as unknown as PostgreSqlQueryExecutor, controller.signal))
      .rejects.toMatchObject({ operation: "diagnosticMigrationHistory" });
  });
});

describe("PostgreSQL queue health read", () => {
  it("aggregates without a project predicate and carries no project metadata", async () => {
    const { query, executor: db } = executor([queueRow()]);
    const signal = new AbortController().signal;
    expect(await readPostgreSqlQueueHealth(db, signal)).toEqual({ capReached: false, claimed: "1", quarantined: "1", lagSeconds: "12.5" });
    const [config, options] = query.mock.calls[0] as unknown as [{ text: string; values: unknown[] }, Record<string, unknown>];
    expect(config.values).toEqual([4097]);
    expect(config.text).not.toContain("$2");
    expect(config.text).toContain("MATERIALIZED");
    expect(config.text).toContain("pg_catalog.clock_timestamp()");
    expect(config.text).toContain("ORDER BY inbox_id LIMIT $1::pg_catalog.int4");
    expect(options).toEqual({ domain: "factory", operation: "diagnosticQueue", signal });
  });
  it("binds the admitted selected UUID and never passes project options", async () => {
    const { query, executor: db } = executor([queueRow({ replay_lag_seconds: null })]);
    const result = await readPostgreSqlQueueHealth(db, undefined, projectId.toUpperCase());
    expect(result.lagSeconds).toBeNull();
    const [config, options] = query.mock.calls[0] as unknown as [{ text: string; values: unknown[] }, Record<string, unknown>];
    expect(config.values).toEqual([4097, projectId]);
    expect(config.text).toContain("project_id OPERATOR(pg_catalog.=) $2::pg_catalog.uuid");
    expect(options).not.toHaveProperty("projectId");
    expect(options).not.toHaveProperty("projectIds");
  });
  it("reports the sentinel row as a reached cap", async () => {
    expect((await readPostgreSqlQueueHealth(executor([queueRow({ candidate_count: "4096" })]).executor)).capReached).toBe(false);
    expect((await readPostgreSqlQueueHealth(executor([queueRow({ candidate_count: "4097" })]).executor)).capReached).toBe(true);
  });
  it.each([
    ["invalid selected ID", [queueRow()], undefined, "not-a-uuid"],
    ["no row", [], undefined, undefined],
    ["two rows", [queueRow(), queueRow()], undefined, undefined],
    ["non-text count", [queueRow({ candidate_count: 3 })], undefined, undefined],
    ["malformed count", [queueRow({ candidate_count: "-1" })], undefined, undefined],
    ["missing row fields", [{}], undefined, undefined],
  ])("rejects %s", async (_name, rows, _unused, selected) => {
    const { executor: db } = executor(rows);
    await expect(readPostgreSqlQueueHealth(db, undefined, selected)).rejects.toBeInstanceOf(StorageOperationError);
  });
  it("refuses an aborted caller and a result completing after cancellation", async () => {
    const { query, executor: db } = executor([queueRow()]);
    const controller = new AbortController();
    controller.abort();
    await expect(readPostgreSqlQueueHealth(db, controller.signal)).rejects.toMatchObject({ operation: "diagnosticQueue" });
    expect(query).not.toHaveBeenCalled();
    const late = new AbortController();
    const lateQuery = vi.fn(async () => { late.abort(); return { rows: [queueRow()] }; });
    await expect(readPostgreSqlQueueHealth({ query: lateQuery } as unknown as PostgreSqlQueryExecutor, late.signal)).rejects.toBeInstanceOf(StorageOperationError);
  });
});
