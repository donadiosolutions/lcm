import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { runPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import type { PostgreSqlConnectionSettings } from "../../src/storage/postgresql/contracts.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  createPostgreSqlTestDatabase,
  harnessEnvironment,
  settings,
  type PostgreSqlTestDatabase,
} from "./harness.js";

const MANAGED_EXTENSIONS = ["pg_trgm", "unaccent", "pgcrypto"] as const;
const MANAGED_FUNCTIONS = [
  "public.digest(bytea, text)",
  "public.digest(text, text)",
  "public.similarity(text, text)",
  "public.similarity_op(text, text)",
] as const;
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

export type ManagedAclForm = "explicit" | "null";

export type ManagedProviderDatabase = Readonly<{
  database: PostgreSqlTestDatabase;
  admin: PostgreSqlRuntime;
  adminName: string;
  transferName: string;
  runtimeName: string;
  transfer: PostgreSqlConnectionSettings;
  runtime: PostgreSqlConnectionSettings;
  aclForm: ManagedAclForm;
}>;

async function setManagedFunctionAclForm(
  database: PostgreSqlTestDatabase,
  aclForm: ManagedAclForm,
): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
  try {
    await administrator.query({
      text: `UPDATE pg_catalog.pg_proc
             SET proacl = CASE WHEN $1::pg_catalog.text OPERATOR(pg_catalog.=) 'null'
               THEN NULL
               ELSE pg_catalog.acldefault('f', proowner)
             END
             WHERE oid OPERATOR(pg_catalog.=) ANY($2::pg_catalog.regprocedure[])`,
      values: [aclForm, [...MANAGED_FUNCTIONS]],
    }, { domain: "factory", operation: "setManagedFunctionAclForm" });
  } finally {
    await administrator.close();
  }
}

function roleSettings(
  database: PostgreSqlTestDatabase,
  role: string,
  password: string,
): PostgreSqlConnectionSettings {
  const url = new URL(database.adminUrl);
  url.username = role;
  url.password = password;
  return settings(url.toString());
}

function referenceSql(script: string, role: string): string {
  return readFileSync(
    join(process.cwd(), "src/storage/postgresql/reference", script),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', `"${role}"`)
    .replaceAll(':"lcm_transfer_role"', `"${role}"`);
}

export async function applyManagedRuntimeGrants(
  fixture: ManagedProviderDatabase,
  role: "transfer" | "runtime",
): Promise<void> {
  const roleName = role === "transfer" ? fixture.transferName : fixture.runtimeName;
  for (const script of RUNTIME_GRANT_SCRIPTS) {
    await fixture.admin.query({ text: referenceSql(script, roleName) }, {
      domain: "factory",
      operation: `applyManagedRuntimeGrants:${script}`,
    });
  }
  if (role === "transfer") {
    await fixture.admin.query({
      text: referenceSql("postgresql-transfer-grants.sql", roleName),
    }, { domain: "factory", operation: "applyManagedTransferGrants" });
  }
  if (fixture.aclForm === "null") {
    await setManagedFunctionAclForm(fixture.database, fixture.aclForm);
  }
}

export async function assertManagedFunctionAclShape(
  fixture: ManagedProviderDatabase,
): Promise<void> {
  const result = await fixture.database.migrator.query<{
    function_identity: string;
    raw_acl_is_null: boolean;
    owner_name: string;
    grantee_name: string;
    grantor_name: string;
    privilege_type: string;
    is_grantable: boolean;
  }>({
    text: `SELECT pg_catalog.concat(
                    namespace.nspname, '.', procedure.proname, '(',
                    pg_catalog.pg_get_function_identity_arguments(procedure.oid), ')'
                  ) AS function_identity,
                  procedure.proacl IS NULL AS raw_acl_is_null,
                  pg_catalog.pg_get_userbyid(procedure.proowner)::pg_catalog.text AS owner_name,
                  COALESCE(grantee.rolname, 'PUBLIC')::pg_catalog.text AS grantee_name,
                  pg_catalog.pg_get_userbyid(privilege.grantor)::pg_catalog.text AS grantor_name,
                  privilege.privilege_type,
                  privilege.is_grantable::pg_catalog.bool AS is_grantable
           FROM pg_catalog.pg_proc AS procedure
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid OPERATOR(pg_catalog.=) procedure.pronamespace
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
           ) AS privilege
           LEFT JOIN pg_catalog.pg_roles AS grantee
             ON grantee.oid OPERATOR(pg_catalog.=) privilege.grantee
           WHERE procedure.oid OPERATOR(pg_catalog.=) ANY($1::pg_catalog.regprocedure[])
           ORDER BY function_identity, grantee_name`,
    values: [[...MANAGED_FUNCTIONS]],
  }, { domain: "factory", operation: "assertManagedFunctionAclShape" });

  expect(result.rows).toHaveLength(MANAGED_FUNCTIONS.length * 2);
  for (const functionIdentity of MANAGED_FUNCTIONS) {
    const rows = result.rows.filter((row) => row.function_identity === functionIdentity);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.grantee_name).sort()).toEqual([
      "PUBLIC",
      rows[0]!.owner_name,
    ].sort());
    for (const row of rows) {
      expect(row.raw_acl_is_null).toBe(fixture.aclForm === "null");
      expect(row.grantor_name).toBe(row.owner_name);
      expect(row.privilege_type).toBe("EXECUTE");
      expect(row.is_grantable).toBe(false);
      expect(row.grantee_name).not.toBe(fixture.transferName);
      expect(row.grantee_name).not.toBe(fixture.runtimeName);
    }
  }
}

export async function revokeManagedTransferProfile(
  fixture: ManagedProviderDatabase,
): Promise<void> {
  const administrator = new PostgreSqlRuntime({
    ...fixture.transfer,
    url: fixture.database.adminUrl,
  });
  try {
    await administrator.query({ text: `DROP OWNED BY ${fixture.transferName}` }, {
      domain: "factory",
      operation: "revokeManagedTransferProfile",
    });
  } finally {
    await administrator.close();
  }
}

async function createManagedProviderShape(
  database: PostgreSqlTestDatabase,
  aclForm: ManagedAclForm,
  names: Readonly<{ admin: string; transfer: string; runtime: string }>,
  passwords: Readonly<{ admin: string; transfer: string; runtime: string }>,
): Promise<ManagedProviderDatabase> {
  const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
  const control = new PostgreSqlRuntime(settings(harnessEnvironment().LCM_TEST_POSTGRES_ADMIN_URL));
  let admin: PostgreSqlRuntime | undefined;
  try {
    for (const [role, password] of [
      [names.admin, passwords.admin],
      [names.transfer, passwords.transfer],
      [names.runtime, passwords.runtime],
    ] as const) {
      await control.query({ text: `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER` }, {
        domain: "factory",
        operation: "createManagedProviderRole",
      });
    }
    await control.query({ text: `GRANT lcm_test_migrator TO ${names.admin}` }, {
      domain: "factory",
      operation: "grantManagedAdminMembership",
    });
    await administrator.query({
      text: `GRANT CONNECT, CREATE ON DATABASE "${database.name}" TO ${names.admin};
             GRANT CONNECT ON DATABASE "${database.name}" TO ${names.transfer}, ${names.runtime};
             GRANT CREATE ON SCHEMA public TO ${names.admin}`,
    }, { domain: "factory", operation: "grantManagedProviderSetup" });

    admin = new PostgreSqlRuntime(roleSettings(database, names.admin, passwords.admin));
    try {
      for (const extension of MANAGED_EXTENSIONS) {
        await admin.query({ text: `CREATE EXTENSION ${extension} WITH SCHEMA public` }, {
          domain: "factory",
          operation: `createManagedExtension:${extension}`,
        });
      }
    } finally {
      await administrator.query({
        text: `REVOKE CREATE ON DATABASE "${database.name}" FROM ${names.admin};
               REVOKE CREATE ON SCHEMA public FROM ${names.admin}`,
      }, { domain: "factory", operation: "revokeManagedProviderSetup" });
    }

    await setManagedFunctionAclForm(database, aclForm);
    await runPostgreSqlMigrations(database.migrator);

    const fixture = {
      database,
      admin,
      adminName: names.admin,
      transferName: names.transfer,
      runtimeName: names.runtime,
      transfer: roleSettings(database, names.transfer, passwords.transfer),
      runtime: roleSettings(database, names.runtime, passwords.runtime),
      aclForm,
    } satisfies ManagedProviderDatabase;
    await applyManagedRuntimeGrants(fixture, "transfer");
    return fixture;
  } catch (error) {
    await admin?.close().catch(() => undefined);
    throw error;
  } finally {
    await Promise.allSettled([administrator.close(), control.close()]);
  }
}

export async function withManagedProviderDatabase<T>(
  label: string,
  aclForm: ManagedAclForm,
  callback: (fixture: ManagedProviderDatabase) => Promise<T>,
): Promise<T> {
  const suffix = randomBytes(6).toString("hex");
  const names = {
    admin: `lcm_1857_admin_${suffix}`,
    transfer: `lcm_1857_transfer_${suffix}`,
    runtime: `lcm_1857_runtime_${suffix}`,
  } as const;
  const passwords = {
    admin: randomBytes(18).toString("hex"),
    transfer: randomBytes(18).toString("hex"),
    runtime: randomBytes(18).toString("hex"),
  } as const;
  const database = await createPostgreSqlTestDatabase(label, {
    runMigrations: false,
    omitExtensions: MANAGED_EXTENSIONS,
  });
  const control = new PostgreSqlRuntime(settings(harnessEnvironment().LCM_TEST_POSTGRES_ADMIN_URL));
  let fixture: ManagedProviderDatabase | undefined;
  let callbackResult: T | undefined;
  let callbackCompleted = false;
  try {
    fixture = await createManagedProviderShape(database, aclForm, names, passwords);
    callbackResult = await callback(fixture);
    callbackCompleted = true;
  } finally {
    await fixture?.admin.close().catch(() => undefined);
    const existingBeforeDrop = await control.query<{ rolname: string }>({
      text: "SELECT rolname::pg_catalog.text AS rolname FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) ANY($1::pg_catalog.text[])",
      values: [[names.admin, names.transfer, names.runtime]],
    }, { domain: "factory", operation: "inspectManagedProviderRoles" });
    if (existingBeforeDrop.rows.some((row) => row.rolname === names.admin)) {
      await control.query({ text: `REVOKE lcm_test_migrator FROM ${names.admin}` }, {
        domain: "factory",
        operation: "revokeManagedAdminMembership",
      });
    }
    await database.drop();
    for (const role of existingBeforeDrop.rows.map((row) => row.rolname)) {
      await control.query({ text: `DROP ROLE ${role}` }, {
        domain: "factory",
        operation: "dropManagedProviderRole",
      });
    }
    await control.close();
  }
  if (!callbackCompleted) throw new Error("managed provider callback did not complete");
  return callbackResult as T;
}
