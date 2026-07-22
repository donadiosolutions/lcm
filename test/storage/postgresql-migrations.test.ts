import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlMigration,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";
import {
  loadPostgreSqlMigrations,
  runPostgreSqlMigrations,
} from "../../src/storage/postgresql/migrations.js";

function migration(id: string, sql = `SELECT '${id}'`): PostgreSqlMigration {
  return { id, filename: `${id}.sql`, sql, sha256: createHash("sha256").update(sql).digest("hex") };
}

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function executor(options: {
  ledger?: boolean;
  current?: Array<{ id: string; checksum_sha256: string }>;
  failOperation?: string;
} = {}) {
  const operations: string[] = [];
  const query = vi.fn(async <R extends QueryResultRow>(
    _config: unknown,
    context: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> => {
    operations.push(context.operation);
    if (context.operation === options.failOperation) throw new Error("private SQL failure");
    if (context.operation === "inspectMigrationLedger") return result([{ ledger_exists: options.ledger ?? false }] as unknown as R[]);
    if (context.operation === "readMigrations") return result((options.current ?? []) as unknown as R[]);
    return result([] as R[]);
  });
  const seam = {
    query,
    transaction: vi.fn(async <T>(callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>) => callback({ query })),
  };
  return { seam, operations };
}

describe("PostgreSQL migration runner", () => {
  it("loads the pinned artifact and rejects missing or drifted files", () => {
    expect(loadPostgreSqlMigrations()).toEqual([
      expect.objectContaining({ id: "0001_migration_ledger", sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
    ]);
    expect(() => loadPostgreSqlMigrations(() => { throw new Error("missing private path"); }))
      .toThrowError(expect.objectContaining({ operation: "loadMigrations" }));
    expect(() => loadPostgreSqlMigrations(() => "altered migration"))
      .toThrowError(expect.objectContaining({ operation: "verifyMigrationArtifact" }));
  });

  it.each([
    { migrations: [migration("bad")] },
    { migrations: [migration("0001_valid"), migration("0001_valid")] },
    { migrations: [migration("0002_later"), migration("0001_earlier")] },
    { migrations: [{ ...migration("0001_valid"), sha256: "0".repeat(64) }] },
  ])("rejects malformed migration manifests", async ({ migrations }) => {
    await expect(runPostgreSqlMigrations(executor().seam, { migrations }))
      .rejects.toMatchObject({ operation: "validateMigrations" });
  });

  it("applies and records pending migrations atomically with the signal", async () => {
    const fake = executor();
    const signal = new AbortController().signal;
    const migrations = [migration("0001_first"), migration("0002_second")];
    await expect(runPostgreSqlMigrations(fake.seam, { migrations, signal })).resolves.toEqual({
      applied: ["0001_first", "0002_second"],
      current: ["0001_first", "0002_second"],
    });
    expect(fake.operations).toEqual([
      "lockMigrations",
      "inspectMigrationLedger",
      "applyMigration:0001_first",
      "recordMigration",
      "applyMigration:0002_second",
      "recordMigration",
    ]);
    expect(fake.seam.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "factory", operation: "migrate", signal,
    });
  });

  it("accepts exact ordered history and applies only pending files", async () => {
    const migrations = [migration("0001_first"), migration("0002_second")];
    const fake = executor({ ledger: true, current: [{ id: migrations[0].id, checksum_sha256: migrations[0].sha256 }] });
    await expect(runPostgreSqlMigrations(fake.seam, { migrations })).resolves.toEqual({
      applied: ["0002_second"],
      current: ["0001_first", "0002_second"],
    });
    expect(fake.operations).toContain("readMigrations");
  });

  it.each([
    { current: [{ id: "0001_first", checksum_sha256: "x" }, { id: "0002_second", checksum_sha256: "x" }], migrations: [migration("0001_first")] },
    { current: [{ id: "0001_unknown", checksum_sha256: migration("0001_first").sha256 }], migrations: [migration("0001_first")] },
    { current: [{ id: "0001_first", checksum_sha256: "0".repeat(64) }], migrations: [migration("0001_first")] },
  ])("rejects unknown, excess, or checksum-drifted history", async ({ current, migrations }) => {
    await expect(runPostgreSqlMigrations(executor({ ledger: true, current }).seam, { migrations }))
      .rejects.toMatchObject({ operation: "verifyMigrationHistory" });
  });

  it("uses the packaged manifest by default and propagates transactional failures safely", async () => {
    const current = loadPostgreSqlMigrations().map(({ id, sha256 }) => ({ id, checksum_sha256: sha256 }));
    await expect(runPostgreSqlMigrations(executor({ ledger: true, current }).seam)).resolves.toMatchObject({ applied: [] });
    await expect(runPostgreSqlMigrations(executor({ failOperation: "lockMigrations" }).seam, { migrations: [] }))
      .rejects.toThrow("private SQL failure");
  });
});
