import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import type { QueryResultRow } from "pg";
import {
  PostgreSqlRuntime,
  POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
} from "../../src/storage/postgresql/runtime.js";
import {
  REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION,
  runPostgreSqlMigrations,
} from "../../src/storage/postgresql/migrations.js";
import { normalizePostgreSqlError } from "../../src/storage/postgresql/errors.js";
import {
  REQUIRED_POSTGRESQL_EXTENSIONS,
  REQUIRED_POSTGRESQL_EXTENSION_SCHEMAS,
} from "../../src/storage/postgresql/extensions.js";
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

export type HarnessEnvironment = Record<(typeof REQUIRED_ENV)[number], string>;

type GuardRow = QueryResultRow & {
  server_version_num: number;
  role: string;
  tls: boolean;
  run_id: string;
  database_name: string;
  runtime_role: string;
};

type ExtensionRow = QueryResultRow & {
  extname: string;
  default_version: string | null;
  installed_version: string | null;
  schema_name: string;
};

const HARNESS_ROLES = {
  admin: "lcm_harness_admin",
  migrator: "lcm_test_migrator",
  runtime: "lcm_test_runtime",
} as const;

const FORBIDDEN_ENV = [
  "LCM_POSTGRES_URL",
  "LCM_POSTGRES_CA_FILE",
] as const;

function harnessConfigurationError(reason: string): Error {
  return new Error(`invalid PostgreSQL harness environment: ${reason}`);
}

function requiredEnvironment(source: NodeJS.ProcessEnv): HarnessEnvironment {
  const values = {} as HarnessEnvironment;
  for (const key of REQUIRED_ENV) {
    const value = source[key];
    if (!value) throw new Error(`missing PostgreSQL harness value ${key}`);
    values[key] = value;
  }
  return values;
}

function decodedUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw harnessConfigurationError("connection URL");
  }
}

interface HarnessUrl {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

function validatedHarnessUrl(
  value: string,
  expectedUser: string,
  expectedDatabase: string,
  expectedHost: string,
  expectedPort: number,
): HarnessUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw harnessConfigurationError("connection URL");
  }
  const port = Number(url.port);
  const user = decodedUrlComponent(url.username);
  const password = decodedUrlComponent(url.password);
  const database = decodedUrlComponent(url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname);
  if (
    url.protocol !== "postgresql:"
    || !value.toLowerCase().startsWith("postgresql://")
    || url.hostname !== expectedHost
    || url.port === ""
    || port !== expectedPort
    || user !== expectedUser
    || password === ""
    || database !== expectedDatabase
    || database.includes("/")
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw harnessConfigurationError("connection URL");
  }
  return { host: url.hostname, port, user, password, database };
}

export function validateHarnessEnvironment(source: NodeJS.ProcessEnv): HarnessEnvironment {
  for (const key of FORBIDDEN_ENV) {
    if (source[key] !== undefined) throw harnessConfigurationError("ambient PostgreSQL configuration");
  }
  if (Object.keys(source).some((key) => /^PG[A-Z0-9_]*$/u.test(key))) {
    throw harnessConfigurationError("ambient PostgreSQL configuration");
  }

  const env = requiredEnvironment(source);
  if (!/^[0-9a-f]{32}$/u.test(env.LCM_TEST_POSTGRES_RUN_ID)) {
    throw harnessConfigurationError("run identity");
  }
  const shortRunId = env.LCM_TEST_POSTGRES_RUN_ID.slice(0, 20);
  const expectedControlDatabase = `lcm_harness_${shortRunId}`;
  if (env.LCM_TEST_POSTGRES_CONTROL_DATABASE !== expectedControlDatabase) {
    throw harnessConfigurationError("control database identity");
  }

  const innerCi = source.LCM_TEST_POSTGRES_INNER_CI === "true";
  if (source.LCM_TEST_POSTGRES_INNER_CI !== undefined && !innerCi) {
    throw harnessConfigurationError("execution mode");
  }
  const expectedHost = innerCi ? `lcm-pg-${shortRunId}.test` : "127.0.0.1";
  const expectedPort = innerCi ? 5432 : undefined;
  const urls = [
    [env.LCM_TEST_POSTGRES_ADMIN_URL, HARNESS_ROLES.admin],
    [env.LCM_TEST_POSTGRES_MIGRATOR_URL, HARNESS_ROLES.migrator],
    [env.LCM_TEST_POSTGRES_RUNTIME_URL, HARNESS_ROLES.runtime],
  ] as const;
  const parsed = urls.map(([url, role]) => {
    let candidate: URL;
    try {
      candidate = new URL(url);
    } catch {
      throw harnessConfigurationError("connection URL");
    }
    const port = Number(candidate.port);
    if (
      candidate.port === ""
      || (!innerCi && (port === 5432 || !Number.isInteger(port) || port < 1 || port > 65_535))
    ) {
      throw harnessConfigurationError("connection target");
    }
    return validatedHarnessUrl(
      url,
      role,
      expectedControlDatabase,
      expectedHost,
      expectedPort ?? port,
    );
  });
  if (
    new Set(parsed.map(({ host, port, database }) => `${host}:${port}/${database}`)).size !== 1
    || new Set(parsed.map(({ password }) => password)).size !== parsed.length
  ) {
    throw harnessConfigurationError("connection identity");
  }

  if (
    !isAbsolute(env.LCM_TEST_POSTGRES_CA_FILE)
    || !isAbsolute(env.LCM_TEST_POSTGRES_WRONG_CA_FILE)
    || env.LCM_TEST_POSTGRES_CA_FILE === env.LCM_TEST_POSTGRES_WRONG_CA_FILE
  ) {
    throw harnessConfigurationError("certificate inputs");
  }
  const expectedWrongHost = innerCi ? `lcm-pg-wrong-${shortRunId}.test` : "localhost";
  if (env.LCM_TEST_POSTGRES_WRONG_HOST !== expectedWrongHost) {
    throw harnessConfigurationError("certificate identity fixture");
  }
  return env;
}

function environment(): HarnessEnvironment {
  return validateHarnessEnvironment(process.env);
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

function runtimeFor(
  url: string,
  overrides: Parameters<typeof settings>[1] = {},
  startupSearchPath?: string,
): PostgreSqlRuntime {
  const connectionSettings = settings(url, overrides);
  if (startupSearchPath === undefined) return new PostgreSqlRuntime(connectionSettings);
  return new PostgreSqlRuntime(connectionSettings, {
    ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
    buildConfig: (currentSettings) => ({
      ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES.buildConfig(currentSettings),
      options: `-c timezone=UTC -c search_path=${startupSearchPath}`,
    }),
  });
}

function assertGuardRow(
  row: GuardRow | undefined,
  expectedRole: string,
  expectedDatabase: string,
  env: HarnessEnvironment,
): void {
  if (
    row === undefined
    || Math.floor(row.server_version_num / 10_000) !== REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION
    || row.role !== expectedRole
    || row.tls !== true
    || row.run_id !== env.LCM_TEST_POSTGRES_RUN_ID
    || row.database_name !== expectedDatabase
    || row.runtime_role !== HARNESS_ROLES.runtime
  ) {
    throw new Error("PostgreSQL harness ownership preflight failed");
  }
}

async function assertControlDatabaseOwnership(env: HarnessEnvironment): Promise<void> {
  const connections = [
    [runtimeFor(env.LCM_TEST_POSTGRES_ADMIN_URL), HARNESS_ROLES.admin],
    [runtimeFor(env.LCM_TEST_POSTGRES_MIGRATOR_URL), HARNESS_ROLES.migrator],
    [runtimeFor(env.LCM_TEST_POSTGRES_RUNTIME_URL), HARNESS_ROLES.runtime],
  ] as const;
  try {
    for (const [connection, expectedRole] of connections) {
      const assertions = await connection.query<GuardRow>({
        text: `SELECT pg_catalog.current_setting('server_version_num')::integer AS server_version_num,
                      CURRENT_USER::text AS role,
                      COALESCE((
                        SELECT ssl
                        FROM pg_catalog.pg_stat_ssl
                        WHERE pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
                      ), false) AS tls,
                      sentinel.run_id,
                      sentinel.database_name,
                      sentinel.runtime_role
               FROM public.__lcm_test_run_sentinel AS sentinel`,
      }, { domain: "factory", operation: "harnessOwnershipPreflight" });
      assertGuardRow(
        assertions.rowCount === 1 ? assertions.rows[0] : undefined,
        expectedRole,
        env.LCM_TEST_POSTGRES_CONTROL_DATABASE,
        env,
      );
    }

    const migrator = connections[1][0];
    const requiredExtensions = [...REQUIRED_POSTGRESQL_EXTENSIONS];
    const extensions = await migrator.query<ExtensionRow>({
      text: `SELECT extension.extname::text AS extname,
                    available.default_version,
                    extension.extversion::text AS installed_version,
                    namespace.nspname::text AS schema_name
             FROM pg_catalog.pg_extension AS extension
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) extension.extnamespace
             JOIN pg_catalog.pg_available_extensions AS available
               ON available.name OPERATOR(pg_catalog.=) extension.extname
             WHERE extension.extname OPERATOR(pg_catalog.=) ANY($1::text[])
             ORDER BY extension.extname`,
      values: [requiredExtensions],
    }, { domain: "factory", operation: "harnessExtensionsPreflight" });
    const readyExtensions = new Set(
      extensions.rows
        .filter((row) => (
          row.default_version !== null
          && row.installed_version === row.default_version
          && row.schema_name === REQUIRED_POSTGRESQL_EXTENSION_SCHEMAS[row.extname as keyof typeof REQUIRED_POSTGRESQL_EXTENSION_SCHEMAS]
        ))
        .map((row) => row.extname),
    );
    if (
      extensions.rowCount !== requiredExtensions.length
      || requiredExtensions.some((extension) => !readyExtensions.has(extension))
    ) {
      throw new Error("PostgreSQL harness extension preflight failed");
    }
    const pgStatStatements = await migrator.query({
      text: "SELECT stats_reset FROM public.pg_stat_statements_info",
    }, { domain: "factory", operation: "harnessPgStatStatementsPreflight" });
    if (pgStatStatements.rowCount !== 1) {
      throw new Error("PostgreSQL harness pg_stat_statements preflight failed");
    }
  } finally {
    await Promise.allSettled(connections.map(([connection]) => connection.close()));
  }
}

export async function assertHarnessReady(): Promise<void> {
  const env = environment();
  await assertControlDatabaseOwnership(env);
  const migrator = runtimeFor(env.LCM_TEST_POSTGRES_MIGRATOR_URL);
  const runtime = runtimeFor(env.LCM_TEST_POSTGRES_RUNTIME_URL);
  try {
    await runPostgreSqlMigrations(migrator);
    const [migratorHealth, runtimeHealth] = await Promise.all([migrator.health(), runtime.health()]);
    if (migratorHealth.status !== "healthy" || migratorHealth.role !== "lcm_test_migrator") {
      throw new Error("PostgreSQL harness migrator readiness failed");
    }
    if (runtimeHealth.status !== "healthy" || runtimeHealth.role !== "lcm_test_runtime") {
      throw new Error("PostgreSQL harness runtime readiness failed");
    }
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

export interface PostgreSqlTestDatabaseOptions {
  /** Test-only fault injection. Every production-like lease installs all parity extensions. */
  readonly omitExtensions?: readonly (typeof REQUIRED_POSTGRESQL_EXTENSIONS)[number][];
  /** Test-only fault injection for installing selected extensions outside their required namespace. */
  readonly extensionSchemas?: Partial<Record<(typeof REQUIRED_POSTGRESQL_EXTENSIONS)[number], string>>;
  /** Test-only fault injection for exercising readiness before any LCM DDL. */
  readonly runMigrations?: boolean;
  /** Test-only connection search path for proving setup DDL is schema-qualified. */
  readonly adminSearchPath?: string;
  /** Test-only database encoding for readiness rejection coverage. */
  readonly serverEncoding?: "UTF8" | "LATIN1";
  /** Test-only database default used to exercise repository isolation fences. */
  readonly defaultTransactionIsolation?: "READ COMMITTED" | "REPEATABLE READ";
}

export async function createPostgreSqlTestDatabase(
  label: string,
  options: PostgreSqlTestDatabaseOptions = {},
): Promise<PostgreSqlTestDatabase> {
  const env = environment();
  await assertControlDatabaseOwnership(env);
  const normalizedLabel = label.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 12) || "case";
  const worker = (process.env.VITEST_POOL_ID ?? "0").replace(/[^0-9]/gu, "").slice(0, 3) || "0";
  const name = `lcm_t_${env.LCM_TEST_POSTGRES_RUN_ID.slice(0, 12)}_${worker}_${normalizedLabel}_${randomBytes(4).toString("hex")}`.slice(0, 63);
  const identifier = safeIdentifier(name);
  const admin = runtimeFor(env.LCM_TEST_POSTGRES_ADMIN_URL);
  const adminUrl = databaseUrl(env.LCM_TEST_POSTGRES_ADMIN_URL, name);
  const adminSearchPath = options.adminSearchPath
    ?.split(",")
    .map((schema) => schema.trim())
    .map((schema) => {
      safeIdentifier(schema);
      return schema;
    })
    .join(",");
  const migratorUrl = databaseUrl(env.LCM_TEST_POSTGRES_MIGRATOR_URL, name);
  const runtimeUrl = databaseUrl(env.LCM_TEST_POSTGRES_RUNTIME_URL, name);
  const serverEncoding = options.serverEncoding ?? "UTF8";
  const localeClause = serverEncoding === "LATIN1"
    ? " LC_COLLATE 'C' LC_CTYPE 'C'"
    : "";
  try {
    await admin.query({
      text: `CREATE DATABASE ${identifier} OWNER lcm_test_migrator TEMPLATE template0 ENCODING '${serverEncoding}'${localeClause}`,
    }, {
      domain: "factory",
      operation: "createTestDatabase",
    });
  } finally {
    await admin.close();
  }

  const databaseAdmin = runtimeFor(adminUrl, {}, adminSearchPath);
  const migrator = runtimeFor(migratorUrl);
  const runtime = runtimeFor(runtimeUrl);
  let databaseAdminClosePromise: Promise<void> | undefined;
  const closeDatabaseAdmin = (): Promise<void> => {
    databaseAdminClosePromise ??= databaseAdmin.close();
    return databaseAdminClosePromise;
  };
  let dropPromise: Promise<void> | undefined;
  const dropDatabase = async (): Promise<void> => {
    await Promise.allSettled([migrator.close(), runtime.close()]);
    const currentEnvironment = environment();
    if (REQUIRED_ENV.some((key) => currentEnvironment[key] !== env[key])) {
      throw new Error("refusing PostgreSQL harness cleanup after environment drift");
    }
    await assertControlDatabaseOwnership(currentEnvironment);
    const guard = runtimeFor(adminUrl);
    try {
      const result = await guard.query<GuardRow>({
        text: `SELECT current_setting('server_version_num')::integer AS server_version_num,
                      current_user AS role,
                      COALESCE((
                        SELECT ssl
                        FROM pg_catalog.pg_stat_ssl
                        WHERE pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
                      ), false) AS tls,
                      sentinel.run_id,
                      sentinel.database_name,
                      sentinel.runtime_role
               FROM public.__lcm_test_run_sentinel AS sentinel`,
      }, { domain: "factory", operation: "verifyDropSentinel" });
      const row = result.rowCount === 1 ? result.rows[0] : undefined;
      if (
        !name.startsWith(`lcm_t_${env.LCM_TEST_POSTGRES_RUN_ID.slice(0, 12)}_`)
        || row === undefined
        || Math.floor(row.server_version_num / 10_000) !== REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION
        || row.role !== "lcm_harness_admin"
        || row.tls !== true
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
    } finally {
      await control.close();
    }
  };
  const dropOwnedDatabase = (): Promise<void> => {
    dropPromise ??= dropDatabase().catch((error: unknown) => {
      dropPromise = undefined;
      throw error;
    });
    return dropPromise;
  };
  try {
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

    const omittedExtensions = new Set(options.omitExtensions ?? []);
    const createdExtensionSchemas = new Set<string>();
    for (const extension of REQUIRED_POSTGRESQL_EXTENSIONS) {
      if (omittedExtensions.has(extension)) continue;
      const requestedSchema = options.extensionSchemas?.[extension]
        ?? REQUIRED_POSTGRESQL_EXTENSION_SCHEMAS[extension];
      const schema = safeIdentifier(requestedSchema);
      if (requestedSchema !== "public" && !createdExtensionSchemas.has(schema)) {
        await databaseAdmin.query({ text: `CREATE SCHEMA ${schema}` }, {
          domain: "factory",
          operation: "createTestExtensionSchema",
        });
        createdExtensionSchemas.add(schema);
      }
      const extensionIdentifier = safeIdentifier(extension);
      await databaseAdmin.query({
        text: `CREATE EXTENSION ${extensionIdentifier} WITH SCHEMA ${schema}`,
      }, {
        domain: "factory",
        operation: "createTestExtension",
      });
    }
    if (options.runMigrations !== false) {
      await runPostgreSqlMigrations(migrator);
      await migrator.query({
        text: "GRANT USAGE ON SCHEMA lcm TO lcm_test_runtime",
      }, { domain: "factory", operation: "grantRuntimeBaseline" });
    }
    if (options.defaultTransactionIsolation !== undefined) {
      const isolation = options.defaultTransactionIsolation === "REPEATABLE READ"
        ? "repeatable read"
        : "read committed";
      await databaseAdmin.query({
        text: `ALTER DATABASE ${identifier} SET default_transaction_isolation = '${isolation}'`,
      }, {
        domain: "factory",
        operation: "setDefaultTransactionIsolation",
      });
    }
    await closeDatabaseAdmin();
  } catch (error) {
    await Promise.allSettled([closeDatabaseAdmin(), dropOwnedDatabase()]);
    throw normalizePostgreSqlError(error, { domain: "factory", operation: "createTestDatabase" });
  }
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
    drop(): Promise<void> {
      return dropOwnedDatabase();
    },
  };
}

export async function withPostgreSqlTestDatabase<T>(
  label: string,
  callback: (database: PostgreSqlTestDatabase) => Promise<T>,
  options: PostgreSqlTestDatabaseOptions = {},
): Promise<T> {
  const database = await createPostgreSqlTestDatabase(label, options);
  try {
    return await callback(database);
  } finally {
    await database.drop();
  }
}

export function harnessEnvironment(): HarnessEnvironment {
  return environment();
}
