import { beforeAll, describe, expect, it } from "vitest";
import {
  inspectRequiredPostgreSqlExtensions,
  PostgreSqlExtensionPreflightError,
  REQUIRED_POSTGRESQL_EXTENSIONS,
} from "../../src/storage/postgresql/extensions.js";
import { runPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import {
  assertHarnessReady,
  createPostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

describe("PostgreSQL extension readiness", () => {
  it("ignores hostile search_path relations that shadow extension catalogs", async () => {
    await withPostgreSqlTestDatabase("extension-search-path", async (database) => {
      const observation = await database.migrator.transaction(async (transaction) => {
        const setup = [
          ["createHostileCatalogSchema", "CREATE SCHEMA hostile_catalog"],
          [
            "shadowAvailableExtensions",
            `CREATE VIEW hostile_catalog.pg_available_extensions AS
               SELECT ''::name AS name, NULL::text AS default_version WHERE false`,
          ],
          [
            "shadowInstalledExtensions",
            `CREATE VIEW hostile_catalog.pg_extension AS
               SELECT ''::name AS extname, NULL::text AS extversion, NULL::oid AS extnamespace WHERE false`,
          ],
          [
            "shadowNamespaces",
            `CREATE VIEW hostile_catalog.pg_namespace AS
               SELECT NULL::oid AS oid, ''::name AS nspname WHERE false`,
          ],
          [
            "shadowAvailableExtensionVersions",
            `CREATE VIEW hostile_catalog.pg_available_extension_versions AS
               SELECT ''::name AS name, NULL::text AS version, false AS installed, false AS relocatable WHERE false`,
          ],
          ["setHostileCatalogSearchPath", "SET LOCAL search_path = hostile_catalog, pg_catalog, public"],
        ] as const;
        for (const [operation, text] of setup) {
          await transaction.query({ text }, { domain: "factory", operation });
        }

        const searchPath = await transaction.query<{ search_path: string }>({
          text: "SHOW search_path",
        }, { domain: "factory", operation: "verifyHostileCatalogSearchPath" });
        const statuses = await inspectRequiredPostgreSqlExtensions(transaction);
        return { searchPath: searchPath.rows, statuses };
      });

      expect(observation.searchPath).toEqual([{
        search_path: "hostile_catalog, pg_catalog, public",
      }]);
      expect(observation.statuses).toEqual(
        expect.arrayContaining(REQUIRED_POSTGRESQL_EXTENSIONS.map((name) => (
          expect.objectContaining({ name, status: "current" })
        ))),
      );
    });
  });

  it("ignores hostile matching-signature operators when required extensions are absent", async () => {
    const database = await createPostgreSqlTestDatabase("extension-operators", {
      omitExtensions: ["pg_stat_statements", "unaccent"],
      runMigrations: false,
    });

    try {
      const statuses = await database.migrator.transaction(async (transaction) => {
        await transaction.query({
          text: `CREATE SCHEMA hostile_operators;
                 CREATE FUNCTION hostile_operators.always_true_text(left_value text, right_value text)
                 RETURNS boolean LANGUAGE sql IMMUTABLE RETURN true;
                 CREATE FUNCTION hostile_operators.always_true_name(left_value name, right_value text)
                 RETURNS boolean LANGUAGE sql IMMUTABLE RETURN true;
                 CREATE FUNCTION hostile_operators.always_true_oid(left_value oid, right_value oid)
                 RETURNS boolean LANGUAGE sql IMMUTABLE RETURN true;
                 CREATE OPERATOR hostile_operators.= (
                   FUNCTION = hostile_operators.always_true_text,
                   LEFTARG = text,
                   RIGHTARG = text
                 );
                 CREATE OPERATOR hostile_operators.= (
                   FUNCTION = hostile_operators.always_true_name,
                   LEFTARG = name,
                   RIGHTARG = text
                 );
                 CREATE OPERATOR hostile_operators.= (
                   FUNCTION = hostile_operators.always_true_oid,
                   LEFTARG = oid,
                   RIGHTARG = oid
                 );
                 CREATE OPERATOR hostile_operators.~ (
                   FUNCTION = hostile_operators.always_true_text,
                   LEFTARG = text,
                   RIGHTARG = text
                 );
                 SET LOCAL search_path = hostile_operators, pg_catalog, public`,
        }, { domain: "factory", operation: "installHostileExtensionOperators" });
        return inspectRequiredPostgreSqlExtensions(transaction);
      });

      expect(statuses).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "pg_stat_statements",
          installedVersion: null,
          status: "uninstalled",
        }),
        expect.objectContaining({
          name: "unaccent",
          installedVersion: null,
          status: "uninstalled",
        }),
      ]));
      expect(statuses.filter(({ name }) => (
        name === "pg_stat_statements" || name === "unaccent"
      ))).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "current" }),
      ]));
    } finally {
      await database.drop();
    }
  });

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
