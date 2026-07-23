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
    const database = await createPostgreSqlTestDatabase("migration-concurrency", { runMigrations: false });
    try {
      await database.migrator.query({
        text: `CREATE SCHEMA lcm;
               CREATE TABLE lcm.operator_owned_metadata (key text PRIMARY KEY);
               INSERT INTO lcm.operator_owned_metadata (key) VALUES ('preserve-me')`,
      }, { domain: "factory", operation: "seedPreexistingSchema" });
      const second = new PostgreSqlRuntime(settings(database.migratorUrl));
      try {
        const [firstResult, secondResult] = await Promise.all([
          runPostgreSqlMigrations(database.migrator),
          runPostgreSqlMigrations(second),
        ]);
        expect([firstResult.applied, secondResult.applied].sort((left, right) => right.length - left.length))
          .toEqual([["0001_migration_ledger", "0002_schema_baseline"], []]);
        await expect(database.migrator.query<{ key: string }>({
          text: "SELECT key FROM lcm.operator_owned_metadata",
        }, { domain: "factory", operation: "verifyPreexistingSchema" }))
          .resolves.toMatchObject({ rows: [{ key: "preserve-me" }] });
        await expect(runPostgreSqlMigrations(database.migrator)).resolves.toMatchObject({ applied: [] });
      } finally {
        await second.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("rolls back the complete pending set and a migration whose ledger insert fails", async () => {
    const database = await createPostgreSqlTestDatabase("migration-atomic", { runMigrations: false });
    try {
      const baseline = migration("0001_atomic_ledger", ledgerSql);
      const successful = migration("0002_atomic_probe", "CREATE TABLE lcm.pending_set_probe (id integer PRIMARY KEY);");
      const failing = migration("0003_atomic_failure", "CREATE TABLE lcm.pending_failure_probe (id integer); SELECT missing FROM absent;");
      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [baseline, successful, failing],
      })).rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{ ledger: boolean; probe: boolean }>({
        text: `SELECT to_regclass('lcm.schema_migrations') IS NOT NULL AS ledger,
                      to_regclass('lcm.pending_set_probe') IS NOT NULL AS probe`,
      }, { domain: "factory", operation: "verifyPendingSetRollback" }))
        .resolves.toMatchObject({ rows: [{ ledger: false, probe: false }] });

      const ledgerFailure = migration("0001_ledger_failure", `CREATE SCHEMA lcm;
        CREATE TABLE lcm.schema_migrations (
          id text PRIMARY KEY CHECK (id <> '0001_ledger_failure'),
          checksum_sha256 text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
        );
        CREATE TABLE lcm.ledger_failure_probe (id integer PRIMARY KEY);`);
      await expect(runPostgreSqlMigrations(database.migrator, { migrations: [ledgerFailure] }))
        .rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{ ledger: boolean; probe: boolean }>({
        text: `SELECT to_regclass('lcm.schema_migrations') IS NOT NULL AS ledger,
                      to_regclass('lcm.ledger_failure_probe') IS NOT NULL AS probe`,
      }, { domain: "factory", operation: "verifyLedgerInsertRollback" }))
        .resolves.toMatchObject({ rows: [{ ledger: false, probe: false }] });
    } finally {
      await database.drop();
    }
  });

  it("pins native built-ins under a hostile ambient search path and restores it after rollback", async () => {
    const database = await createPostgreSqlTestDatabase("migration-search-path", {
      runMigrations: false,
    });
    try {
      await database.migrator.query({
        text: `CREATE SCHEMA hostile_builtins;
               CREATE FUNCTION hostile_builtins.current_setting(setting_name text)
               RETURNS text LANGUAGE sql IMMUTABLE RETURN '190000';
               CREATE FUNCTION hostile_builtins.uuidv7()
               RETURNS uuid LANGUAGE sql IMMUTABLE
               RETURN '6ba7b810-9dad-41d1-80b4-00c04fd430c8'::uuid;
               CREATE FUNCTION hostile_builtins.btrim(input text)
               RETURNS text LANGUAGE sql IMMUTABLE RETURN '';
               SET search_path = hostile_builtins, pg_catalog, public`,
      }, { domain: "factory", operation: "installHostileMigrationBuiltins" });

      const failing = migration(
        "0002_hostile_failure",
        "CREATE TABLE lcm.hostile_rollback_probe (id integer); SELECT missing FROM absent;",
      );
      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [migration("0001_hostile_ledger", ledgerSql), failing],
      })).rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{ exists: boolean }>({
        text: "SELECT pg_catalog.to_regclass('lcm.hostile_rollback_probe') IS NOT NULL AS exists",
      }, { domain: "factory", operation: "verifyHostileMigrationRollback" }))
        .resolves.toMatchObject({ rows: [{ exists: false }] });

      const rollbackSearchPath = await database.migrator.query<{ search_path: string }>({
        text: "SHOW search_path",
      }, { domain: "factory", operation: "verifyRollbackSearchPath" });
      expect(rollbackSearchPath.rows).toEqual([{
        search_path: "hostile_builtins, pg_catalog, public",
      }]);

      await runPostgreSqlMigrations(database.migrator);
      const inserted = await database.migrator.query<{ machine_version: number }>({
        text: `INSERT INTO lcm.machines (identity_key)
               VALUES ('native-builtins')
               RETURNING pg_catalog.uuid_extract_version(machine_id) AS machine_version`,
      }, { domain: "factory", operation: "verifyNativeMigrationBuiltins" });
      expect(inserted.rows).toEqual([{ machine_version: 7 }]);

      const committedSearchPath = await database.migrator.query<{ search_path: string }>({
        text: "SHOW search_path",
      }, { domain: "factory", operation: "verifyCommittedSearchPath" });
      expect(committedSearchPath.rows).toEqual([{
        search_path: "hostile_builtins, pg_catalog, public",
      }]);
    } finally {
      await database.drop();
    }
  });

  it("rejects a non-UTF8 database before DDL and reports runtime incompatibility", async () => {
    const database = await createPostgreSqlTestDatabase("migration-latin1", {
      runMigrations: false,
      serverEncoding: "LATIN1",
    });
    try {
      await expect(runPostgreSqlMigrations(database.migrator)).rejects.toMatchObject({
        operation: "preflightServerEncoding",
        remediation:
          "Create or restore the LCM database with server_encoding UTF8, then rerun readiness.",
        requiredServerEncoding: "UTF8",
        serverEncoding: "LATIN1",
      });
      await expect(database.runtime.health()).resolves.toMatchObject({
        status: "unavailable",
        serverEncoding: "LATIN1",
        error: {
          operation: "health",
          requiredServerEncoding: "UTF8",
          serverEncoding: "LATIN1",
        },
      });
      await expect(database.migrator.query<{ schema_exists: boolean }>({
        text: `SELECT EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_namespace
                 WHERE nspname OPERATOR(pg_catalog.=) 'lcm'
               ) AS schema_exists`,
      }, { domain: "factory", operation: "verifyEncodingPreflightNoDdl" }))
        .resolves.toMatchObject({ rows: [{ schema_exists: false }] });
    } finally {
      await database.drop();
    }
  });

  it("fails closed on a colliding operator function without replacing it", async () => {
    const database = await createPostgreSqlTestDatabase("function-collision", { runMigrations: false });
    try {
      await database.migrator.query({
        text: `CREATE SCHEMA lcm;
               CREATE FUNCTION lcm.normalize_search_text(input text) RETURNS text
               LANGUAGE sql IMMUTABLE RETURN 'operator:' || input`,
      }, { domain: "factory", operation: "seedFunctionCollision" });
      await expect(runPostgreSqlMigrations(database.migrator)).rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{ behavior: string; domain_table: boolean }>({
        text: `SELECT lcm.normalize_search_text('value') AS behavior,
                      to_regclass('lcm.machines') IS NOT NULL AS domain_table`,
      }, { domain: "factory", operation: "verifyFunctionCollisionRollback" }))
        .resolves.toMatchObject({ rows: [{ behavior: "operator:value", domain_table: false }] });
    } finally {
      await database.drop();
    }
  });

  it("preserves PUBLIC privileges on unknown pre-existing schema objects", async () => {
    const database = await createPostgreSqlTestDatabase("unknown-acls", { runMigrations: false });
    try {
      await database.migrator.query({
        text: `CREATE SCHEMA lcm;
               CREATE TABLE lcm.operator_table (id integer);
               CREATE SEQUENCE lcm.operator_sequence;
               CREATE FUNCTION lcm.operator_function() RETURNS integer LANGUAGE sql IMMUTABLE RETURN 1;
               GRANT SELECT ON lcm.operator_table TO PUBLIC;
               GRANT USAGE ON SEQUENCE lcm.operator_sequence TO PUBLIC;
               GRANT EXECUTE ON FUNCTION lcm.operator_function() TO PUBLIC`,
      }, { domain: "factory", operation: "seedUnknownAcls" });
      await runPostgreSqlMigrations(database.migrator);
      await expect(database.migrator.query<{
        unknown_table: boolean;
        unknown_sequence: boolean;
        unknown_function: boolean;
        owned_table: boolean;
        owned_sequence: boolean;
        owned_function: boolean;
      }>({
        text: `SELECT
          has_table_privilege('public', 'lcm.operator_table', 'SELECT') AS unknown_table,
          has_sequence_privilege('public', 'lcm.operator_sequence', 'USAGE') AS unknown_sequence,
          has_function_privilege('public', 'lcm.operator_function()', 'EXECUTE') AS unknown_function,
          has_table_privilege('public', 'lcm.messages', 'SELECT') AS owned_table,
          has_sequence_privilege('public', 'lcm.messages_message_id_seq', 'USAGE') AS owned_sequence,
          has_function_privilege('public', 'lcm.normalize_search_text(text)', 'EXECUTE') AS owned_function`,
      }, { domain: "factory", operation: "verifyScopedRevokes" })).resolves.toMatchObject({ rows: [{
        unknown_table: true,
        unknown_sequence: true,
        unknown_function: true,
        owned_table: false,
        owned_sequence: false,
        owned_function: false,
      }] });
    } finally {
      await database.drop();
    }
  });

  it("fails before owned DDL when a pre-existing lcm schema grants PUBLIC CREATE", async () => {
    const database = await createPostgreSqlTestDatabase("public-schema-create", { runMigrations: false });
    try {
      await database.migrator.query({
        text: `CREATE SCHEMA lcm;
               CREATE TABLE lcm.operator_table (value text);
               INSERT INTO lcm.operator_table VALUES ('preserve-me');
               GRANT CREATE ON SCHEMA lcm TO PUBLIC`,
      }, { domain: "factory", operation: "seedPublicSchemaCreate" });
      await expect(runPostgreSqlMigrations(database.migrator)).rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{
        public_create: boolean;
        value: string;
        owned_table: boolean;
        ledger: boolean;
      }>({
        text: `SELECT has_schema_privilege('public', 'lcm', 'CREATE') AS public_create,
                      (SELECT value FROM lcm.operator_table) AS value,
                      to_regclass('lcm.machines') IS NOT NULL AS owned_table,
                      to_regclass('lcm.schema_migrations') IS NOT NULL AS ledger`,
      }, { domain: "factory", operation: "verifyPublicSchemaCreateRollback" })).resolves.toMatchObject({ rows: [{
        public_create: true,
        value: "preserve-me",
        owned_table: false,
        ledger: false,
      }] });
    } finally {
      await database.drop();
    }
  });

  it("rechecks PUBLIC CREATE drift before a repeated run or later migration", async () => {
    await withPostgreSqlTestDatabase("public-schema-create-drift", async (database) => {
      await database.migrator.query({
        text: "GRANT CREATE ON SCHEMA lcm TO PUBLIC",
      }, { domain: "factory", operation: "driftPublicSchemaCreate" });
      const later = migration(
        "0003_public_acl_probe",
        "CREATE TABLE lcm.public_acl_probe (id integer PRIMARY KEY);",
      );

      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [...loadPostgreSqlMigrations(), later],
      })).rejects.toMatchObject({
        operation: "preflightSchemaAcl",
        publicCreate: true,
        remediation: "REVOKE CREATE ON SCHEMA \"lcm\" FROM PUBLIC;",
        schemaExists: true,
        schemaName: "lcm",
      });
      await expect(database.migrator.query<{
        applied_count: string;
        probe_exists: boolean;
        public_create: boolean;
      }>({
        text: `SELECT
                 (SELECT count(*)::text FROM lcm.schema_migrations) AS applied_count,
                 pg_catalog.to_regclass('lcm.public_acl_probe') IS NOT NULL AS probe_exists,
                 pg_catalog.has_schema_privilege('public', 'lcm', 'CREATE')
                   AS public_create`,
      }, { domain: "factory", operation: "verifyRecurringPublicAclRollback" }))
        .resolves.toMatchObject({
          rows: [{
            applied_count: "2",
            probe_exists: false,
            public_create: true,
          }],
        });
    });
  });

  it("rejects an administrator-owned schema despite delegated migrator CREATE", async () => {
    const database = await createPostgreSqlTestDatabase("schema-owner", { runMigrations: false });
    const admin = new PostgreSqlRuntime(settings(database.adminUrl));
    try {
      await admin.query({
        text: `CREATE SCHEMA lcm AUTHORIZATION lcm_harness_admin;
               CREATE TABLE lcm.operator_table (value text);
               INSERT INTO lcm.operator_table VALUES ('preserve-me');
               GRANT USAGE, CREATE ON SCHEMA lcm TO lcm_test_migrator`,
      }, { domain: "factory", operation: "seedAdminOwnedSchema" });

      await expect(runPostgreSqlMigrations(database.migrator)).rejects.toMatchObject({
        backend: "postgresql",
        operation: "preflightSchemaOwnership",
        schemaExists: true,
        ownedByMigrator: false,
        requiredOwner: "lcm_test_migrator",
        remediation: "Transfer ownership of schema \"lcm\" and its LCM-owned objects to PostgreSQL role \"lcm_test_migrator\", then rerun migrations.",
      });
      await expect(admin.query<{
        admin_owned: boolean;
        migrator_create: boolean;
        value: string;
        ledger: boolean;
        owned_table: boolean;
      }>({
        text: `SELECT
          namespace.nspowner = 'lcm_harness_admin'::regrole AS admin_owned,
          has_schema_privilege('lcm_test_migrator', 'lcm', 'CREATE') AS migrator_create,
          (SELECT value FROM lcm.operator_table) AS value,
          to_regclass('lcm.schema_migrations') IS NOT NULL AS ledger,
          to_regclass('lcm.machines') IS NOT NULL AS owned_table
        FROM pg_catalog.pg_namespace AS namespace
        WHERE namespace.nspname = 'lcm'`,
      }, { domain: "factory", operation: "verifyAdminOwnedSchemaPreserved" }))
        .resolves.toMatchObject({ rows: [{
          admin_owned: true,
          migrator_create: true,
          value: "preserve-me",
          ledger: false,
          owned_table: false,
        }] });
    } finally {
      try {
        await admin.close();
      } finally {
        await database.drop();
      }
    }
  });

  it("rechecks ownership of every managed object class while ignoring unknown objects", async () => {
    await withPostgreSqlTestDatabase("managed-owner-drift", async (database) => {
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      const later = migration(
        "0003_managed_owner_probe",
        "CREATE TABLE lcm.managed_owner_probe (id integer PRIMARY KEY);",
      );
      try {
        await admin.query({
          text: `CREATE TABLE lcm.operator_admin_owned (value text);
                 ALTER TABLE lcm.operator_admin_owned OWNER TO lcm_harness_admin`,
        }, { domain: "factory", operation: "seedUnknownAdminOwnedObject" });
        await expect(runPostgreSqlMigrations(database.migrator))
          .resolves.toMatchObject({ applied: [] });

        const drifts = [
          {
            label: "table",
            apply: "ALTER TABLE lcm.messages OWNER TO lcm_harness_admin",
            restore: "ALTER TABLE lcm.messages OWNER TO lcm_test_migrator",
          },
          {
            label: "sequence",
            apply: "ALTER TABLE lcm.fenced_leases OWNER TO lcm_harness_admin",
            restore: "ALTER TABLE lcm.fenced_leases OWNER TO lcm_test_migrator",
          },
          {
            label: "normalization function",
            apply:
              "ALTER FUNCTION lcm.normalize_search_text(text) OWNER TO lcm_harness_admin",
            restore:
              "ALTER FUNCTION lcm.normalize_search_text(text) OWNER TO lcm_test_migrator",
          },
          {
            label: "trigger function",
            apply:
              "ALTER FUNCTION lcm.enforce_summary_id_uniqueness() OWNER TO lcm_harness_admin",
            restore:
              "ALTER FUNCTION lcm.enforce_summary_id_uniqueness() OWNER TO lcm_test_migrator",
          },
          {
            label: "dictionary",
            apply:
              "ALTER TEXT SEARCH DICTIONARY lcm.simple_v1 OWNER TO lcm_harness_admin",
            restore:
              "ALTER TEXT SEARCH DICTIONARY lcm.simple_v1 OWNER TO lcm_test_migrator",
          },
          {
            label: "configuration",
            apply:
              "ALTER TEXT SEARCH CONFIGURATION lcm.search_v1 OWNER TO lcm_harness_admin",
            restore:
              "ALTER TEXT SEARCH CONFIGURATION lcm.search_v1 OWNER TO lcm_test_migrator",
          },
        ] as const;

        for (const drift of drifts) {
          await admin.query({ text: drift.apply }, {
            domain: "factory",
            operation: `driftManagedOwner:${drift.label}`,
          });
          try {
            const failure = await runPostgreSqlMigrations(database.migrator, {
              migrations: [...loadPostgreSqlMigrations(), later],
            }).catch((error: unknown) => error);
            expect(failure).toMatchObject({
              existingObjectCount: 35,
              operation: "preflightManagedObjectOwnership",
              requiredOwner: "lcm_test_migrator",
              schemaName: "lcm",
            });
            expect((failure as { unownedObjectCount?: number }).unownedObjectCount)
              .toBeGreaterThan(0);
          } finally {
            await admin.query({ text: drift.restore }, {
              domain: "factory",
              operation: `restoreManagedOwner:${drift.label}`,
            });
          }
          await expect(runPostgreSqlMigrations(database.migrator))
            .resolves.toMatchObject({ applied: [] });
        }

        await expect(database.migrator.query<{
          applied_count: string;
          operator_preserved: boolean;
          probe_exists: boolean;
        }>({
          text: `SELECT
                   (SELECT pg_catalog.count(*)::pg_catalog.text
                    FROM lcm.schema_migrations) AS applied_count,
                   pg_catalog.to_regclass('lcm.operator_admin_owned') IS NOT NULL
                     AS operator_preserved,
                   pg_catalog.to_regclass('lcm.managed_owner_probe') IS NOT NULL
                     AS probe_exists`,
        }, { domain: "factory", operation: "verifyManagedOwnerRollback" }))
          .resolves.toMatchObject({
            rows: [{
              applied_count: "2",
              operator_preserved: true,
              probe_exists: false,
            }],
          });
      } finally {
        await admin.close();
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

  it("deduplicates concurrent and repeated database drops", async () => {
    const database = await createPostgreSqlTestDatabase("drop-concurrency");

    const first = database.drop();
    const concurrent = database.drop();
    expect(concurrent).toBe(first);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([undefined, undefined]);

    const repeated = database.drop();
    expect(repeated).toBe(first);
    await expect(repeated).resolves.toBeUndefined();
  });

  it("deduplicates a failed guarded drop and permits a deliberate retry", async () => {
    const database = await createPostgreSqlTestDatabase("sentinel-guard");
    const admin = new PostgreSqlRuntime(settings(database.adminUrl));
    try {
      await admin.query({
        text: "UPDATE public.__lcm_test_run_sentinel SET run_id = 'mismatched'",
      }, { domain: "factory", operation: "corruptSentinel" });
      const failed = database.drop();
      const concurrentFailure = database.drop();
      expect(concurrentFailure).toBe(failed);
      await expect(failed).rejects.toThrow("refusing to drop");
      await admin.query({
        text: "UPDATE public.__lcm_test_run_sentinel SET run_id = $1",
        values: [process.env.LCM_TEST_POSTGRES_RUN_ID],
      }, { domain: "factory", operation: "repairSentinel" });
      const retry = database.drop();
      expect(retry).not.toBe(failed);
      expect(database.drop()).toBe(retry);
      await expect(retry).resolves.toBeUndefined();
    } finally {
      await admin.close();
      await database.drop();
    }
  });
});
