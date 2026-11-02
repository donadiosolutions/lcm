import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyMigrationTargetReachability } from "../../src/migration/target-reachability.js";
import { runPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import { verifyPostgreSqlRuntimeSchema } from "../../src/storage/postgresql/runtime-readiness.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  assertHarnessReady,
  settings,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";
import { grantPortablePostgreSql } from "./portable-fixture.js";

beforeAll(assertHarnessReady);

const MANAGED_EXTENSIONS = ["pg_trgm", "unaccent", "pgcrypto"] as const;

async function assertManagedExtensionShape(executor: PostgreSqlRuntime): Promise<void> {
  const extensions = await executor.query<{
    extname: string;
    owner: string;
    owner_is_superuser: boolean;
  }>({
    text: `SELECT extension.extname::pg_catalog.text AS extname,
                  owner.rolname::pg_catalog.text AS owner,
                  owner.rolsuper AS owner_is_superuser
           FROM pg_catalog.pg_extension AS extension
           JOIN pg_catalog.pg_roles AS owner
             ON owner.oid OPERATOR(pg_catalog.=) extension.extowner
           WHERE extension.extname OPERATOR(pg_catalog.=) ANY($1::pg_catalog.text[])
           ORDER BY extension.extname`,
    values: [[...MANAGED_EXTENSIONS]],
  }, { domain: "factory", operation: "inspectManagedExtensionOwners" });
  expect(extensions.rows).toEqual([
    { extname: "pg_trgm", owner: "lcm_test_migrator", owner_is_superuser: false },
    { extname: "pgcrypto", owner: "lcm_test_migrator", owner_is_superuser: false },
    { extname: "unaccent", owner: "lcm_test_migrator", owner_is_superuser: false },
  ]);

  const members = await executor.query<{
    member_count: number;
    bootstrap_owned_count: number;
  }>({
    text: `WITH managed_extensions AS (
             SELECT oid
             FROM pg_catalog.pg_extension
             WHERE extname OPERATOR(pg_catalog.=) ANY($1::pg_catalog.text[])
           ), owner_bearing_members AS (
             SELECT procedure.proowner AS owner_oid
             FROM pg_catalog.pg_depend AS dependency
             JOIN managed_extensions
               ON managed_extensions.oid OPERATOR(pg_catalog.=) dependency.refobjid
             JOIN pg_catalog.pg_proc AS procedure
               ON dependency.classid OPERATOR(pg_catalog.=)
                    pg_catalog.to_regclass('pg_catalog.pg_proc')
              AND procedure.oid OPERATOR(pg_catalog.=) dependency.objid
             WHERE dependency.deptype OPERATOR(pg_catalog.=) 'e'
             UNION ALL
             SELECT catalog_operator.oprowner
             FROM pg_catalog.pg_depend AS dependency
             JOIN managed_extensions
               ON managed_extensions.oid OPERATOR(pg_catalog.=) dependency.refobjid
             JOIN pg_catalog.pg_operator AS catalog_operator
               ON dependency.classid OPERATOR(pg_catalog.=)
                    pg_catalog.to_regclass('pg_catalog.pg_operator')
              AND catalog_operator.oid OPERATOR(pg_catalog.=) dependency.objid
             WHERE dependency.deptype OPERATOR(pg_catalog.=) 'e'
             UNION ALL
             SELECT operator_class.opcowner
             FROM pg_catalog.pg_depend AS dependency
             JOIN managed_extensions
               ON managed_extensions.oid OPERATOR(pg_catalog.=) dependency.refobjid
             JOIN pg_catalog.pg_opclass AS operator_class
               ON dependency.classid OPERATOR(pg_catalog.=)
                    pg_catalog.to_regclass('pg_catalog.pg_opclass')
              AND operator_class.oid OPERATOR(pg_catalog.=) dependency.objid
             WHERE dependency.deptype OPERATOR(pg_catalog.=) 'e'
             UNION ALL
             SELECT operator_family.opfowner
             FROM pg_catalog.pg_depend AS dependency
             JOIN managed_extensions
               ON managed_extensions.oid OPERATOR(pg_catalog.=) dependency.refobjid
             JOIN pg_catalog.pg_opfamily AS operator_family
               ON dependency.classid OPERATOR(pg_catalog.=)
                    pg_catalog.to_regclass('pg_catalog.pg_opfamily')
              AND operator_family.oid OPERATOR(pg_catalog.=) dependency.objid
             WHERE dependency.deptype OPERATOR(pg_catalog.=) 'e'
           )
           SELECT pg_catalog.count(*)::pg_catalog.int4 AS member_count,
                  pg_catalog.count(*) FILTER (
                    WHERE owner_oid OPERATOR(pg_catalog.=) 10::pg_catalog.oid
                  )::pg_catalog.int4 AS bootstrap_owned_count
           FROM owner_bearing_members`,
    values: [[...MANAGED_EXTENSIONS]],
  }, { domain: "factory", operation: "inspectManagedExtensionMemberOwners" });
  expect(members.rows[0]?.member_count).toBeGreaterThan(0);
  expect(members.rows[0]?.bootstrap_owned_count).toBe(members.rows[0]?.member_count);
}

async function withManagedExtensionDatabase(
  label: string,
  callback: (database: PostgreSqlTestDatabase) => Promise<void>,
): Promise<void> {
  await withPostgreSqlTestDatabase(label, async (database) => {
    for (const extension of MANAGED_EXTENSIONS) {
      await database.migrator.query({
        text: `CREATE EXTENSION ${extension} WITH SCHEMA public`,
      }, { domain: "factory", operation: `createManagedExtension:${extension}` });
    }
    await runPostgreSqlMigrations(database.migrator);
    await grantPortablePostgreSql(database);
    await assertManagedExtensionShape(database.runtime);
    await callback(database);
  }, {
    runMigrations: false,
    omitExtensions: MANAGED_EXTENSIONS,
  });
}

function errorCauseChain(error: unknown): string {
  const diagnostics: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      const details = current as Error & {
        readonly operation?: unknown;
        readonly sqlState?: unknown;
      };
      diagnostics.push([
        `${current.name}: ${current.message}`,
        typeof details.operation === "string" ? `operation=${details.operation}` : undefined,
        typeof details.sqlState === "string" ? `sqlState=${details.sqlState}` : undefined,
      ].filter((value) => value !== undefined).join(" "));
      current = current.cause;
    } else {
      diagnostics.push(String(current));
      break;
    }
  }
  return diagnostics.join(" <- ");
}

async function expectReadinessFailure(
  database: PostgreSqlTestDatabase,
  operation: string,
): Promise<void> {
  const failure = await verifyPostgreSqlRuntimeSchema(database.runtime, {
    expectedOwner: "lcm_test_migrator",
  }).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    reason: "extension-preflight",
    operation,
  });
}

describe("trusted extension members owned by the bootstrap superuser", () => {
  it("accepts the managed PostgreSQL owner shape through readiness and migration reachability", async () => {
    await withManagedExtensionDatabase("trusted-owner-pass", async (database) => {
      await expect(verifyPostgreSqlRuntimeSchema(database.runtime, {
        expectedOwner: "lcm_test_migrator",
      })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
      await grantPortablePostgreSql(database, { transfer: true });
      await expect(verifyMigrationTargetReachability({
        settings: settings(database.runtimeUrl),
        expectedOwner: "lcm_test_migrator",
      })).resolves.toEqual({ status: "verified" });
    });
  }, 60_000);

  it.each([
    {
      label: "required function",
      mutation: "ALTER FUNCTION public.digest(text, text) OWNER TO lcm_test_runtime",
      operation: "inspectRequiredExtensionFunctions",
      checkReachability: true,
    },
    {
      label: "required similarity operator",
      mutation: "ALTER OPERATOR public.% (text, text) OWNER TO lcm_test_runtime",
      operation: "inspectRequiredExtensionOperator",
      checkReachability: false,
    },
    {
      label: "GIN operator class",
      mutation: "ALTER OPERATOR CLASS public.gin_trgm_ops USING gin OWNER TO lcm_test_runtime",
      operation: "inspectRequiredGinTrgmOperatorClass",
      checkReachability: false,
    },
    {
      label: "GIN operator family",
      mutation: "ALTER OPERATOR FAMILY public.gin_trgm_ops USING gin OWNER TO lcm_test_runtime",
      operation: "inspectRequiredGinTrgmOperatorClass",
      checkReachability: false,
    },
    {
      label: "direct GIN operator mapping",
      mutation: "ALTER OPERATOR public.%> (text, text) OWNER TO lcm_test_runtime",
      operation: "inspectRequiredGinTrgmOperators",
      checkReachability: false,
    },
    {
      label: "indirect GIN operator",
      mutation: "ALTER OPERATOR public.<% (text, text) OWNER TO lcm_test_runtime",
      operation: "inspectRequiredGinTrgmIndirectOperators",
      checkReachability: false,
    },
  ])("rejects a $label owned by another non-bootstrap role", async ({
    label,
    mutation,
    operation,
    checkReachability,
  }) => {
    await withManagedExtensionDatabase(`foreign-owner-${label}`, async (database) => {
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await administrator.query({ text: mutation }, {
          domain: "factory",
          operation: "changeExtensionMemberOwner",
        });
      } finally {
        await administrator.close();
      }

      await expectReadinessFailure(database, operation);
      if (checkReachability) {
        await grantPortablePostgreSql(database, { transfer: true });
        await expect(verifyMigrationTargetReachability({
          settings: settings(database.runtimeUrl),
          expectedOwner: "lcm_test_migrator",
        })).resolves.toEqual({
          status: "refuse",
          reason: "migration-target-verification-failed",
          evidence: `readiness-extension-preflight:${operation}`,
        });
      }
    });
  }, 60_000);

  it("rejects a bootstrap-owned member when the extension owner is another superuser", async () => {
    await withManagedExtensionDatabase("superuser-extension-owner", async (database) => {
      const role = `lcm_1839_${randomBytes(6).toString("hex")}`;
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await administrator.query({ text: `CREATE ROLE ${role} NOLOGIN SUPERUSER` }, {
          domain: "factory",
          operation: "createAlternateExtensionOwner",
        });
        await administrator.query({
          text: `UPDATE pg_catalog.pg_extension
                 SET extowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
                 WHERE extname = 'pg_trgm'`,
          values: [role],
        }, { domain: "factory", operation: "setAlternateExtensionOwner" });
        await expectReadinessFailure(database, "inspectRequiredExtensionFunctions");
      } finally {
        try {
          await administrator.query({
            text: `UPDATE pg_catalog.pg_extension
                   SET extowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'lcm_test_migrator')
                   WHERE extname = 'pg_trgm'`,
          }, { domain: "factory", operation: "restoreManagedExtensionOwner" });
          await administrator.query({ text: `DROP ROLE IF EXISTS ${role}` }, {
            domain: "factory",
            operation: "dropAlternateExtensionOwner",
          });
        } finally {
          await administrator.close();
        }
      }
    });
  }, 60_000);

  it("rejects the managed owner shape when the installed extension version is untrusted", async () => {
    await withManagedExtensionDatabase("untrusted-version", async (database) => {
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
      const suffix = randomBytes(8).toString("hex");
      const parent = `/tmp/lcm-1839-${suffix}`;
      const controlFile = `${parent}/extension/pg_trgm.control`;
      let fileCreated = false;
      let settingChanged = false;
      let freshRuntime: PostgreSqlRuntime | undefined;
      try {
        await administrator.query({
          text: "CREATE TABLE public.__lcm_1839_sharedir (path pg_catalog.text NOT NULL)",
        }, { domain: "factory", operation: "createSharedirProbe" });
        await administrator.query({
          text: "COPY public.__lcm_1839_sharedir FROM PROGRAM 'pg_config --sharedir'",
        }, { domain: "factory", operation: "readSharedirFromProgram" });
        const sharedirResult = await administrator.query<{ path: string }>({
          text: "SELECT path FROM public.__lcm_1839_sharedir",
        }, { domain: "factory", operation: "inspectSharedirProbe" });
        await administrator.query({
          text: "DROP TABLE public.__lcm_1839_sharedir",
        }, { domain: "factory", operation: "dropSharedirProbe" });
        const sharedir = sharedirResult.rows[0]?.path;
        if (typeof sharedir !== "string" || !/^\/[A-Za-z0-9_./-]+$/u.test(sharedir)) {
          throw new Error("PostgreSQL sharedir probe returned an unsafe path");
        }
        await administrator.query({
          text: `COPY (SELECT ''::pg_catalog.text) TO PROGRAM 'mkdir -p ${parent}/extension'`,
        }, { domain: "factory", operation: "createPrivateExtensionDirectory" });
        const stockControl = await administrator.query<{ control: string }>({
          text: "SELECT pg_catalog.pg_read_file($1)::pg_catalog.text AS control",
          values: [`${sharedir}/extension/pg_trgm.control`],
        }, { domain: "factory", operation: "readStockExtensionControl" });
        const original = stockControl.rows[0]?.control;
        if (typeof original !== "string" || !/^trusted\s*=\s*true\s*$/mu.test(original)) {
          throw new Error("stock pg_trgm control file is not trusted");
        }
        const untrusted = original
          .replace(/^trusted\s*=\s*true\s*$/mu, "trusted = false")
          .replace(/^directory\s*=.*$/gmu, "")
          + `\ndirectory = '${sharedir}/extension'\n`;
        const encodedControl = Buffer.from(untrusted, "utf8").toString("base64");
        await administrator.query({
          text: `COPY (SELECT '${encodedControl}'::pg_catalog.text) TO PROGRAM
                   'base64 --decode > ${controlFile}'`,
        }, { domain: "factory", operation: "writePrivateExtensionControl" });
        fileCreated = true;
        await administrator.query({
          text: `ALTER DATABASE "${database.name}" SET extension_control_path = '${parent}:$system'`,
        }, { domain: "factory", operation: "setPrivateExtensionControlPath" });
        settingChanged = true;

        await database.runtime.close();
        freshRuntime = new PostgreSqlRuntime(settings(database.runtimeUrl));
        const versions = await freshRuntime.query<{ version: string; trusted: boolean }>({
          text: `SELECT available.version::pg_catalog.text AS version,
                        available.trusted
                 FROM pg_catalog.pg_available_extension_versions AS available
                 JOIN pg_catalog.pg_extension AS installed
                   ON installed.extname OPERATOR(pg_catalog.=) available.name
                  AND installed.extversion OPERATOR(pg_catalog.=) available.version
                 WHERE installed.extname OPERATOR(pg_catalog.=) 'pg_trgm'`,
        }, { domain: "factory", operation: "inspectUntrustedInstalledVersion" });
        expect(versions.rows).toEqual([{ version: expect.any(String), trusted: false }]);
        const extensionStatuses = await freshRuntime.query<{
          extname: string;
          current: boolean;
        }>({
          text: `SELECT installed.extname::pg_catalog.text AS extname,
                        installed.extversion OPERATOR(pg_catalog.=) available.default_version
                          AND namespace.nspname OPERATOR(pg_catalog.=) 'public' AS current
                 FROM pg_catalog.pg_extension AS installed
                 JOIN pg_catalog.pg_available_extensions AS available
                   ON available.name OPERATOR(pg_catalog.=) installed.extname
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid OPERATOR(pg_catalog.=) installed.extnamespace
                 WHERE installed.extname OPERATOR(pg_catalog.=) ANY($1::pg_catalog.text[])
                 ORDER BY installed.extname`,
          values: [["pg_stat_statements", ...MANAGED_EXTENSIONS]],
        }, { domain: "factory", operation: "inspectCurrentExtensionStatuses" });
        expect(extensionStatuses.rows).toEqual([
          { extname: "pg_stat_statements", current: true },
          { extname: "pg_trgm", current: true },
          { extname: "pgcrypto", current: true },
          { extname: "unaccent", current: true },
        ]);
        await assertManagedExtensionShape(freshRuntime);
        const failure = await verifyPostgreSqlRuntimeSchema(freshRuntime, {
          expectedOwner: "lcm_test_migrator",
        }).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          reason: "extension-preflight",
          operation: "inspectRequiredExtensionFunctions",
        });
      } finally {
        await freshRuntime?.close();
        try {
          if (settingChanged) {
            await administrator.query({
              text: `ALTER DATABASE "${database.name}" RESET extension_control_path`,
            }, { domain: "factory", operation: "resetPrivateExtensionControlPath" });
          }
          if (fileCreated) {
            await administrator.query({
              text: `COPY (SELECT ''::pg_catalog.text) TO PROGRAM
                       'unlink ${controlFile} && rmdir ${parent}/extension && rmdir ${parent}'`,
            }, { domain: "factory", operation: "removePrivateExtensionControl" });
          }
        } finally {
          await administrator.close();
        }
      }
    });
  }, 60_000);

  it("cannot manufacture bootstrap ownership for a migrator-owned object", async () => {
    await withPostgreSqlTestDatabase("bootstrap-owner-spoof", async (database) => {
      for (const extension of MANAGED_EXTENSIONS) {
        await database.migrator.query({
          text: `CREATE EXTENSION ${extension} WITH SCHEMA public`,
        }, { domain: "factory", operation: `createManagedExtension:${extension}` });
      }
      await assertManagedExtensionShape(database.migrator);
      try {
        await database.migrator.query({
          text: "CREATE SCHEMA lcm_1839_probe",
        }, { domain: "factory", operation: "createMigratorOwnedSchema" });
        await database.migrator.query({
          text: `CREATE FUNCTION lcm_1839_probe.lcm_1839_owned_function()
                 RETURNS pg_catalog.int4
                 LANGUAGE sql
                 IMMUTABLE
                 AS 'SELECT 1'`,
        }, { domain: "factory", operation: "createMigratorOwnedFunction" });
      } catch (error) {
        throw new Error(`N4 fixture setup failed: ${errorCauseChain(error)}`, { cause: error });
      }
      await expect(database.migrator.query<{ owner: string }>({
        text: `SELECT pg_catalog.pg_get_userbyid(procedure.proowner)::pg_catalog.text AS owner
               FROM pg_catalog.pg_proc AS procedure
               WHERE procedure.oid OPERATOR(pg_catalog.=)
                     'lcm_1839_probe.lcm_1839_owned_function()'::pg_catalog.regprocedure`,
      }, { domain: "factory", operation: "inspectInitialMigratorOwnedFunction" })).resolves.toMatchObject({
        rows: [{ owner: "lcm_test_migrator" }],
      });
      const bootstrap = await database.migrator.query<{ role_name: string; can_set: boolean }>({
        text: `SELECT role.rolname::pg_catalog.text AS role_name,
                      pg_catalog.pg_has_role(CURRENT_USER, role.oid, 'SET') AS can_set
               FROM pg_catalog.pg_roles AS role
               WHERE role.oid OPERATOR(pg_catalog.=) 10::pg_catalog.oid`,
      }, { domain: "factory", operation: "inspectBootstrapRoleAccess" });
      expect(bootstrap.rows).toEqual([{ role_name: expect.any(String), can_set: false }]);
      const bootstrapRole = bootstrap.rows[0]?.role_name;
      if (typeof bootstrapRole !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(bootstrapRole)) {
        throw new Error("bootstrap role has an unsafe identifier");
      }
      await expect(database.migrator.query({
        text: `ALTER FUNCTION lcm_1839_probe.lcm_1839_owned_function()
               OWNER TO "${bootstrapRole}"`,
      }, { domain: "factory", operation: "spoofBootstrapFunctionOwner" })).rejects.toBeDefined();
      await expect(database.migrator.query<{ owner: string }>({
        text: `SELECT pg_catalog.pg_get_userbyid(procedure.proowner)::pg_catalog.text AS owner
               FROM pg_catalog.pg_proc AS procedure
               WHERE procedure.oid OPERATOR(pg_catalog.=)
                     'lcm_1839_probe.lcm_1839_owned_function()'::pg_catalog.regprocedure`,
      }, { domain: "factory", operation: "inspectMigratorOwnedFunction" })).resolves.toMatchObject({
        rows: [{ owner: "lcm_test_migrator" }],
      });
    }, {
      runMigrations: false,
      omitExtensions: MANAGED_EXTENSIONS,
    });
  }, 60_000);

  it("cannot detach a bootstrap-owned extension member as the non-superuser extension owner", async () => {
    await withManagedExtensionDatabase("extension-member-detach", async (database) => {
      await expect(database.migrator.query({
        text: "ALTER EXTENSION pgcrypto DROP FUNCTION public.digest(text, text)",
      }, { domain: "factory", operation: "detachBootstrapOwnedExtensionMember" }))
        .rejects.toBeDefined();
      await expect(verifyPostgreSqlRuntimeSchema(database.runtime, {
        expectedOwner: "lcm_test_migrator",
      })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
    });
  }, 60_000);
});
