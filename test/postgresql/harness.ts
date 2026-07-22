import { randomBytes } from "node:crypto";
import type { QueryResultRow } from "pg";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { runPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import type {
  PostgreSqlConnectionSettings,
  PostgreSqlTestDatabaseLease,
} from "../../src/storage/postgresql/contracts.js";

const REQUIRED_ENV = [
  "LCM_TEST_POSTGRES_RUN_ID",
  "LCM_TEST_POSTGRES_CONTROL_DATABASE",
  "LCM_TEST_POSTGRES_ADMIN_URL",
  "LCM_TEST_POSTGRES_MIGRATOR_URL",
  "LCM_TEST_POSTGRES_RUNTIME_URL",
  "LCM_TEST_POSTGRES_CA_FILE",
  "LCM_TEST_POSTGRES_WRONG_CA_FILE",
  "LCM_TEST_POSTGRES_WRONG_HOST",
] as const;

type HarnessEnvironment = Record<(typeof REQUIRED_ENV)[number], string>;

type GuardRow = QueryResultRow & {
  server_version_num: number;
  role: string;
  run_id: string;
  database_name: string;
  runtime_role: string;
};

function environment(): HarnessEnvironment {
  const values = {} as HarnessEnvironment;
  for (const key of REQUIRED_ENV) {
    const value = process.env[key];
    if (!value) throw new Error(`missing PostgreSQL harness value ${key}`);
    values[key] = value;
  }
  return values;
}

export function settings(
  url: string,
  overrides: Partial<Omit<PostgreSqlConnectionSettings, "url" | "caFile">> & { caFile?: string } = {},
): PostgreSqlConnectionSettings {
  const env = environment();
  return {
    url,
    caFile: overrides.caFile ?? env.LCM_TEST_POSTGRES_CA_FILE,
    poolMax: overrides.poolMax ?? 4,
    connectionTimeoutMs: overrides.connectionTimeoutMs ?? 2_000,
    idleTimeoutMs: overrides.idleTimeoutMs ?? 1_000,
    statementTimeoutMs: overrides.statementTimeoutMs ?? 5_000,
  };
}

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function safeIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error("unsafe PostgreSQL test identifier");
  return `"${value}"`;
}

function runtimeFor(url: string, overrides = {}): PostgreSqlRuntime {
  return new PostgreSqlRuntime(settings(url, overrides));
}

export async function assertHarnessReady(): Promise<void> {
  const env = environment();
  const migrator = runtimeFor(env.LCM_TEST_POSTGRES_MIGRATOR_URL);
  const runtime = runtimeFor(env.LCM_TEST_POSTGRES_RUNTIME_URL);
  try {
    const [migratorHealth, runtimeHealth] = await Promise.all([migrator.health(), runtime.health()]);
    if (migratorHealth.status !== "healthy" || migratorHealth.role !== "lcm_test_migrator") {
      throw new Error(`migrator readiness failed: ${JSON.stringify(migratorHealth)}`);
    }
    if (runtimeHealth.status !== "healthy" || runtimeHealth.role !== "lcm_test_runtime") {
      throw new Error(`runtime readiness failed: ${JSON.stringify(runtimeHealth)}`);
    }
    await runPostgreSqlMigrations(migrator);
    const assertions = await migrator.query<GuardRow>({
      text: `SELECT current_setting('server_version_num')::integer AS server_version_num,
                    current_user AS role,
                    sentinel.run_id,
                    sentinel.database_name,
                    sentinel.runtime_role
             FROM public.__lcm_test_run_sentinel AS sentinel`,
    }, { domain: "factory", operation: "harnessReadiness" });
    const row = assertions.rows[0];
    if (
      Math.floor(row.server_version_num / 10_000) !== 18
      || row.role !== "lcm_test_migrator"
      || row.run_id !== env.LCM_TEST_POSTGRES_RUN_ID
      || row.database_name !== env.LCM_TEST_POSTGRES_CONTROL_DATABASE
      || row.runtime_role !== "lcm_test_runtime"
    ) throw new Error("harness sentinel readiness failed");
    const extensions = await migrator.query<{ extname: string }>({
      text: `SELECT extname FROM pg_extension
             WHERE extname = ANY($1::text[])
             ORDER BY extname`,
      values: [["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"]],
    }, { domain: "factory", operation: "harnessExtensions" });
    if (extensions.rowCount !== 4) throw new Error("harness extension readiness failed");
  } finally {
    await Promise.allSettled([migrator.close(), runtime.close()]);
  }
}

export interface PostgreSqlTestDatabase extends PostgreSqlTestDatabaseLease {
  readonly name: string;
  readonly adminUrl: string;
  readonly migratorUrl: string;
  readonly runtimeUrl: string;
  readonly migrator: PostgreSqlRuntime;
  readonly runtime: PostgreSqlRuntime;
  drop(): Promise<void>;
}

export async function createPostgreSqlTestDatabase(label: string): Promise<PostgreSqlTestDatabase> {
  const env = environment();
  const normalizedLabel = label.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 12) || "case";
  const worker = (process.env.VITEST_POOL_ID ?? "0").replace(/[^0-9]/gu, "").slice(0, 3) || "0";
  const name = `lcm_t_${env.LCM_TEST_POSTGRES_RUN_ID.slice(0, 12)}_${worker}_${normalizedLabel}_${randomBytes(4).toString("hex")}`.slice(0, 63);
  const identifier = safeIdentifier(name);
  const admin = runtimeFor(env.LCM_TEST_POSTGRES_ADMIN_URL);
  const adminUrl = databaseUrl(env.LCM_TEST_POSTGRES_ADMIN_URL, name);
  const migratorUrl = databaseUrl(env.LCM_TEST_POSTGRES_MIGRATOR_URL, name);
  const runtimeUrl = databaseUrl(env.LCM_TEST_POSTGRES_RUNTIME_URL, name);
  try {
    await admin.query({ text: `CREATE DATABASE ${identifier} OWNER lcm_test_migrator TEMPLATE template0` }, {
      domain: "factory",
      operation: "createTestDatabase",
    });
  } finally {
    await admin.close();
  }

  const databaseAdmin = runtimeFor(adminUrl);
  const migrator = runtimeFor(migratorUrl);
  const runtime = runtimeFor(runtimeUrl);
  try {
    for (const extension of ["pg_trgm", "unaccent", "pgcrypto", "pg_stat_statements"] as const) {
      await databaseAdmin.query({ text: `CREATE EXTENSION ${extension}` }, {
        domain: "factory",
        operation: "createTestExtension",
      });
    }
    await databaseAdmin.query({
      text: `CREATE TABLE public.__lcm_test_run_sentinel (
               run_id text PRIMARY KEY,
               database_name text NOT NULL,
               runtime_role text NOT NULL CHECK (runtime_role = 'lcm_test_runtime')
             )`,
    }, { domain: "factory", operation: "createTestSentinel" });
    await databaseAdmin.query({
      text: `INSERT INTO public.__lcm_test_run_sentinel (run_id, database_name, runtime_role)
             VALUES ($1, $2, 'lcm_test_runtime')`,
      values: [env.LCM_TEST_POSTGRES_RUN_ID, name],
    }, { domain: "factory", operation: "writeTestSentinel" });
    await databaseAdmin.query({
      text: `REVOKE ALL ON public.__lcm_test_run_sentinel FROM PUBLIC;
             GRANT SELECT ON public.__lcm_test_run_sentinel TO lcm_test_migrator, lcm_test_runtime`,
    }, { domain: "factory", operation: "protectTestSentinel" });
    await runPostgreSqlMigrations(migrator);
    await migrator.query({
      text: `GRANT USAGE ON SCHEMA lcm TO lcm_test_runtime;
             GRANT SELECT ON lcm.schema_migrations TO lcm_test_runtime`,
    }, { domain: "factory", operation: "grantRuntimeBaseline" });
  } catch (error) {
    await Promise.allSettled([databaseAdmin.close(), migrator.close(), runtime.close()]);
    throw error;
  }
  await databaseAdmin.close();

  let dropped = false;
  return {
    name,
    sentinel: {
      runId: env.LCM_TEST_POSTGRES_RUN_ID,
      databaseName: name,
      expectedRole: "lcm_test_runtime",
    },
    adminUrl,
    migratorUrl,
    runtimeUrl,
    migrator,
    runtime,
    async drop(): Promise<void> {
      if (dropped) return;
      await Promise.allSettled([migrator.close(), runtime.close()]);
      const guard = runtimeFor(adminUrl);
      try {
        const result = await guard.query<GuardRow>({
          text: `SELECT current_setting('server_version_num')::integer AS server_version_num,
                        current_user AS role,
                        sentinel.run_id,
                        sentinel.database_name,
                        sentinel.runtime_role
                 FROM public.__lcm_test_run_sentinel AS sentinel`,
        }, { domain: "factory", operation: "verifyDropSentinel" });
        const row = result.rows[0];
        if (
          !name.startsWith(`lcm_t_${env.LCM_TEST_POSTGRES_RUN_ID.slice(0, 12)}_`)
          || Math.floor(row.server_version_num / 10_000) !== 18
          || row.role !== "lcm_harness_admin"
          || row.run_id !== env.LCM_TEST_POSTGRES_RUN_ID
          || row.database_name !== name
          || row.runtime_role !== "lcm_test_runtime"
        ) throw new Error("refusing to drop an unowned PostgreSQL test database");
      } finally {
        await guard.close();
      }
      const control = runtimeFor(env.LCM_TEST_POSTGRES_ADMIN_URL);
      try {
        await control.query({
          text: "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          values: [name],
        }, { domain: "factory", operation: "drainTestDatabase" });
        await control.query({ text: `DROP DATABASE ${identifier}` }, {
          domain: "factory",
          operation: "dropTestDatabase",
        });
        dropped = true;
      } finally {
        await control.close();
      }
    },
  };
}

export async function withPostgreSqlTestDatabase<T>(
  label: string,
  callback: (database: PostgreSqlTestDatabase) => Promise<T>,
): Promise<T> {
  const database = await createPostgreSqlTestDatabase(label);
  try {
    return await callback(database);
  } finally {
    await database.drop();
  }
}

export function harnessEnvironment(): HarnessEnvironment {
  return environment();
}
