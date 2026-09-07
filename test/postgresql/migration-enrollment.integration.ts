import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { prepareSqliteMigrationEnrollment } from "../../src/migration/maintenance.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import {
  assertHarnessReady,
  withPostgreSqlTestDatabase,
  type PostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

async function grantIdentityRuntimePrivileges(database: PostgreSqlTestDatabase): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "src/storage/postgresql/reference/postgresql-runtime-identity-grants.sql"),
    "utf8",
  );
  await database.migrator.query({
    text: template.split("\n").filter((line) => !line.startsWith("\\")).join("\n")
      .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"'),
  }, { domain: "identity", operation: "grantMigrationEnrollmentIdentity" });
}

describe("SQLite migration enrollment against PostgreSQL 18", () => {
  it("keeps SQLite selected while registering and adopting a receipt epoch", async () => {
    await withPostgreSqlTestDatabase("migration-enrollment", async (database) => {
      await grantIdentityRuntimePrivileges(database);
      const root = mkdtempSync(join(tmpdir(), "lcm-pg-migration-enrollment-"));
      try {
        const lcm = join(root, ".lcm");
        const cwd = join(root, "project");
        mkdirSync(cwd, { mode: 0o700 });
        mkdirSync(lcm, { mode: 0o700 });
        chmodSync(lcm, 0o700);
        const local = localProjectIdentity(cwd, root);
        const projectDir = join(lcm, "projects", local.id);
        mkdirSync(projectDir, { recursive: true, mode: 0o700 });
        mkdirSync(join(lcm, "events"), { mode: 0o700 });
        writeFileSync(join(projectDir, "meta.json"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
        const repository = new PostgreSqlIdentityRepository(database.runtime);
        const result = await prepareSqliteMigrationEnrollment({
          cwd,
          homeDir: root,
          targetConfig: {
            backend: "postgresql",
            postgresql: {
              url: "postgresql://unused.invalid/lcm",
              poolMax: 1,
              connectionTimeoutMs: 100,
              idleTimeoutMs: 100,
              statementTimeoutMs: 100,
            },
          },
          displayName: "Migration enrollment",
        }, {
          openIdentitySession: async () => ({ repository, close: async () => undefined }),
        });

        await expect(repository.recoverMachine(result.identity.machineId)).resolves.toMatchObject({
          machineId: result.identity.machineId,
          identityKey: result.identity.identityKey,
        });
        const source = new DatabaseSync(join(projectDir, "db.sqlite"), { readOnly: true });
        expect(source.prepare(`
          SELECT machine_id, first_machine_sequence
          FROM migration_receipt_v1_epochs
        `).get()).toEqual({
          machine_id: result.identity.machineId,
          first_machine_sequence: "0000000000000000000",
        });
        source.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
