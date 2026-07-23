import { beforeAll, describe, expect, it } from "vitest";
import {
  inspectRequiredPostgreSqlExtensions,
  PostgreSqlExtensionPreflightError,
} from "../../src/storage/postgresql/extensions.js";
import { runPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import {
  assertHarnessReady,
  createPostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

describe("PostgreSQL extension readiness", () => {
  it("verifies pg_stat_statements is configured and loaded before reporting current", async () => {
    await withPostgreSqlTestDatabase("extension-preload", async (database) => {
      const statuses = await inspectRequiredPostgreSqlExtensions(database.migrator);
      expect(statuses).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "pg_stat_statements",
          preloadRequired: true,
          preloaded: true,
          status: "current",
          remediation: null,
        }),
      ]));
      await expect(database.runtime.health()).resolves.toMatchObject({
        status: "healthy",
        extensions: expect.arrayContaining([
          expect.objectContaining({
            name: "pg_stat_statements",
            preloaded: true,
            status: "current",
          }),
        ]),
      });
    });
  });

  it("blocks migrations before LCM schema creation when a parity extension is missing", async () => {
    const database = await createPostgreSqlTestDatabase("missing-extension", {
      omitExtensions: ["unaccent"],
      runMigrations: false,
    });

    try {
      await expect(inspectRequiredPostgreSqlExtensions(database.migrator)).resolves
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            name: "unaccent",
            available: true,
            installedVersion: null,
            status: "uninstalled",
            remediation: "CREATE EXTENSION \"unaccent\" WITH SCHEMA \"public\";",
          }),
        ]));

      const failure = await runPostgreSqlMigrations(database.migrator)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PostgreSqlExtensionPreflightError);
      expect(failure).toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
        operation: "preflightRequiredExtensions",
        extensions: expect.arrayContaining([
          expect.objectContaining({ name: "unaccent", status: "uninstalled" }),
        ]),
      });

      const schema = await database.migrator.query<{ schema_name: string | null }>({
        text: "SELECT to_regnamespace('lcm')::text AS schema_name",
      }, { domain: "factory", operation: "verifyMissingExtensionRollback" });
      expect(schema.rows).toEqual([{ schema_name: null }]);
    } finally {
      await database.drop();
    }
  });

  it("blocks a current relocatable extension installed outside its required namespace", async () => {
    const database = await createPostgreSqlTestDatabase("extension-schema", {
      extensionSchemas: { unaccent: "lcm_test_extensions" },
      runMigrations: false,
    });

    try {
      const statuses = await inspectRequiredPostgreSqlExtensions(database.migrator);
      const unaccent = statuses.find((extension) => extension.name === "unaccent");
      expect(unaccent).toMatchObject({
        available: true,
        installedSchema: "lcm_test_extensions",
        requiredSchema: "public",
        relocatable: true,
        status: "wrong-namespace",
        remediation: "ALTER EXTENSION \"unaccent\" SET SCHEMA \"public\";",
      });
      expect(unaccent?.installedVersion).toBe(unaccent?.defaultVersion);

      const failure = await runPostgreSqlMigrations(database.migrator)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PostgreSqlExtensionPreflightError);
      expect(failure).toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
        operation: "preflightRequiredExtensions",
        extensions: expect.arrayContaining([
          expect.objectContaining({
            name: "unaccent",
            installedSchema: "lcm_test_extensions",
            requiredSchema: "public",
            status: "wrong-namespace",
          }),
        ]),
      });

      const schema = await database.migrator.query<{ schema_name: string | null }>({
        text: "SELECT to_regnamespace('lcm')::text AS schema_name",
      }, { domain: "factory", operation: "verifyWrongExtensionNamespaceRollback" });
      expect(schema.rows).toEqual([{ schema_name: null }]);
    } finally {
      await database.drop();
    }
  });
});
