import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { loadPostgreSqlMigrations, runPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import type { PostgreSqlMigration } from "../../src/storage/postgresql/contracts.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  assertHarnessReady,
  createPostgreSqlTestDatabase,
  settings,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

function migration(id: string, sql: string): PostgreSqlMigration {
  return {
    id,
    filename: `${id}.sql`,
    sql,
    sha256: createHash("sha256").update(sql).digest("hex"),
  };
}

const ledgerSql = `CREATE SCHEMA IF NOT EXISTS lcm;
CREATE TABLE IF NOT EXISTS lcm.schema_migrations (
  id text PRIMARY KEY,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
);`;

describe("PostgreSQL migrations and database isolation", () => {
  it("applies empty, repeated, and concurrent migration runs deterministically", async () => {
    await withPostgreSqlTestDatabase("migration-concurrency", async (database) => {
      await expect(runPostgreSqlMigrations(database.migrator)).resolves.toMatchObject({ applied: [] });
      const second = new PostgreSqlRuntime(settings(database.migratorUrl));
      try {
        const [firstResult, secondResult] = await Promise.all([
          runPostgreSqlMigrations(database.migrator),
          runPostgreSqlMigrations(second),
        ]);
        expect(firstResult.applied).toEqual([]);
        expect(secondResult.applied).toEqual([]);
      } finally {
        await second.close();
      }
    });
  });

  it("rejects checksum drift and rolls back a failed pending migration", async () => {
    await withPostgreSqlTestDatabase("migration-drift", async (database) => {
      const baseline = migration("0001_migration_ledger", ledgerSql);
      await expect(runPostgreSqlMigrations(database.migrator, { migrations: [baseline] }))
        .rejects.toMatchObject({ operation: "verifyMigrationHistory" });

      const current = await database.migrator.query<{ checksum_sha256: string }>({
        text: "SELECT checksum_sha256 FROM lcm.schema_migrations WHERE id = $1",
        values: ["0001_migration_ledger"],
      }, { domain: "factory", operation: "readChecksum" });
      const exactBaseline: PostgreSqlMigration = {
        ...baseline,
        sha256: current.rows[0].checksum_sha256,
        sql: await import("node:fs").then(({ readFileSync }) => readFileSync(
          new URL("../../src/storage/postgresql/migrations/0001_migration_ledger.sql", import.meta.url),
          "utf8",
        )),
      };
      const failing = migration("0002_failure", "CREATE TABLE lcm.rollback_probe (id integer); SELECT missing_column FROM missing_table;");
      await expect(runPostgreSqlMigrations(database.migrator, { migrations: [exactBaseline, failing] }))
        .rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{ exists: boolean }>({
        text: "SELECT to_regclass('lcm.rollback_probe') IS NOT NULL AS exists",
      }, { domain: "factory", operation: "verifyRollback" })).resolves.toMatchObject({ rows: [{ exists: false }] });
    });
  });

  it("creates isolated databases concurrently and blocks an insufficient runtime role", async () => {
    const databases = await Promise.all([
      createPostgreSqlTestDatabase("parallel-a"),
      createPostgreSqlTestDatabase("parallel-b"),
      createPostgreSqlTestDatabase("parallel-c"),
    ]);
    try {
      expect(new Set(databases.map((database) => database.name)).size).toBe(3);
      await Promise.all(databases.map(async (database) => {
        const forbidden = migration("0002_runtime_forbidden", "CREATE TABLE lcm.runtime_forbidden (id integer);");
        await expect(runPostgreSqlMigrations(database.runtime, {
          migrations: [...loadPostgreSqlMigrations(), forbidden],
        })).rejects.toMatchObject({ backend: "postgresql" });
      }));
    } finally {
      await Promise.all(databases.map(async (database) => database.drop()));
    }
  });

  it("fails closed when the run sentinel no longer matches", async () => {
    const database = await createPostgreSqlTestDatabase("sentinel-guard");
    const admin = new PostgreSqlRuntime(settings(database.adminUrl));
    try {
      await admin.query({
        text: "UPDATE public.__lcm_test_run_sentinel SET run_id = 'mismatched'",
      }, { domain: "factory", operation: "corruptSentinel" });
      await expect(database.drop()).rejects.toThrow("refusing to drop");
      await admin.query({
        text: "UPDATE public.__lcm_test_run_sentinel SET run_id = $1",
        values: [process.env.LCM_TEST_POSTGRES_RUN_ID],
      }, { domain: "factory", operation: "repairSentinel" });
    } finally {
      await admin.close();
      await database.drop();
    }
  });
});
