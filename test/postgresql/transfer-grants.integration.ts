import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  verifyPostgreSqlRuntimeSchema,
  verifyPostgreSqlTransferSchema,
} from "../../src/storage/postgresql/runtime-readiness.js";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from "./harness.js";

beforeAll(assertHarnessReady);

const RUNTIME_GRANT_SCRIPTS = [
  "postgresql-runtime-readiness-grants.sql",
  "postgresql-runtime-identity-grants.sql",
  "postgresql-runtime-conversation-grants.sql",
  "postgresql-runtime-summary-context-grants.sql",
  "postgresql-runtime-memory-grants.sql",
  "postgresql-runtime-search-grants.sql",
  "postgresql-runtime-coordination-grants.sql",
  "postgresql-runtime-transcript-grants.sql",
] as const;

async function applyGrantScript(administrator: PostgreSqlRuntime, filename: string): Promise<void> {
  const sql = readFileSync(join(
    process.cwd(), "src/storage/postgresql/reference", filename,
  ), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await administrator.query({ text: sql }, { domain: "factory", operation: "applyTransferGrants" });
}

describe("PostgreSQL 18 canonical transfer grants", () => {
  it("admits the exact transfer profile and rejects missing or excessive ledger privileges", async () => {
    await withPostgreSqlTestDatabase("transfer-grants", async (database) => {
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
      const options = { expectedOwner: "lcm_test_migrator" };
      const queryOptions = { domain: "factory", operation: "inspectTransferGrants" } as const;
      try {
        for (const script of RUNTIME_GRANT_SCRIPTS) await applyGrantScript(administrator, script);
        await expect(verifyPostgreSqlRuntimeSchema(database.runtime, options))
          .resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
        await expect(verifyPostgreSqlTransferSchema(database.runtime, options))
          .rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });

        await applyGrantScript(administrator, "postgresql-transfer-grants.sql");
        await expect(runPostgreSqlMigrations(database.migrator)).resolves.toMatchObject({ applied: [] });
        await expect(verifyPostgreSqlTransferSchema(database.runtime, options))
          .resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
        await expect(verifyPostgreSqlRuntimeSchema(database.runtime, options))
          .rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });

        const privileges = await database.runtime.query<{
          table_name: string;
          can_select: boolean;
          can_insert: boolean;
          can_update: boolean;
          can_delete: boolean;
          can_truncate: boolean;
        }>({
          text: `SELECT table_name,
                   has_table_privilege(current_user, 'lcm.' || table_name, 'SELECT') AS can_select,
                   has_table_privilege(current_user, 'lcm.' || table_name, 'INSERT') AS can_insert,
                   has_table_privilege(current_user, 'lcm.' || table_name, 'UPDATE') AS can_update,
                   has_table_privilege(current_user, 'lcm.' || table_name, 'DELETE') AS can_delete,
                   has_table_privilege(current_user, 'lcm.' || table_name, 'TRUNCATE') AS can_truncate
                 FROM unnest(ARRAY['transfer_batches', 'transfer_identities', 'transfer_runs']) AS table_name
                 ORDER BY table_name`,
        }, queryOptions);
        expect(privileges.rows).toEqual([
          { table_name: "transfer_batches", can_select: true, can_insert: true, can_update: false, can_delete: false, can_truncate: false },
          { table_name: "transfer_identities", can_select: true, can_insert: true, can_update: false, can_delete: false, can_truncate: false },
          { table_name: "transfer_runs", can_select: true, can_insert: true, can_update: false, can_delete: false, can_truncate: false },
        ]);
        const columns = await database.runtime.query<{ column_name: string; can_update: boolean }>({
          text: `SELECT column_name,
                   has_column_privilege(current_user, 'lcm.transfer_runs', column_name, 'UPDATE') AS can_update
                 FROM unnest(ARRAY['checkpoint_bytes', 'checkpoint_sha256', 'current_domain', 'manifest_bytes', 'state']) AS column_name
                 ORDER BY column_name`,
        }, queryOptions);
        expect(columns.rows).toEqual([
          { column_name: "checkpoint_bytes", can_update: true },
          { column_name: "checkpoint_sha256", can_update: true },
          { column_name: "current_domain", can_update: true },
          { column_name: "manifest_bytes", can_update: false },
          { column_name: "state", can_update: true },
        ]);
        for (const table of ["transfer_runs", "transfer_batches", "transfer_identities"]) {
          await expect(database.runtime.query({ text: `DELETE FROM lcm.${table}` }, queryOptions))
            .rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED", sqlState: "42501" });
        }

        await administrator.query({
          text: "REVOKE UPDATE (checkpoint_sha256) ON lcm.transfer_runs FROM lcm_test_runtime",
        }, queryOptions);
        await expect(verifyPostgreSqlTransferSchema(database.runtime, options))
          .rejects.toMatchObject({ reason: "acl-shape" });
        await applyGrantScript(administrator, "postgresql-transfer-grants.sql");
        await expect(verifyPostgreSqlTransferSchema(database.runtime, options))
          .resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });

        await administrator.query({
          text: "GRANT UPDATE ON lcm.transfer_batches TO lcm_test_runtime",
        }, queryOptions);
        await expect(verifyPostgreSqlTransferSchema(database.runtime, options))
          .rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
      } finally {
        await administrator.close();
      }
    });
  });
});
