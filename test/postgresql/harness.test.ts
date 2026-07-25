import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  caFailureFile: undefined as string | undefined,
  closeAttempts: [] as string[],
  databaseAdminCloseFailure: undefined as Error | undefined,
  dropAttempts: 0,
  dropGate: undefined as Deferred | undefined,
  events: [] as string[],
  extensionOverrides: {} as Partial<{
    default_version: string | null;
    installed_version: string | null;
    schema_name: string;
  }>,
  guardOverrides: {} as Partial<{
    server_version_num: number;
    role: string;
    tls: boolean;
    run_id: string;
    database_name: string;
    runtime_role: string;
  }>,
  operations: [] as string[],
  queryFailureOperation: undefined as string | undefined,
  queryConfigs: [] as Array<{ text?: string; values?: unknown[] }>,
  runMigrations: vi.fn(async () => {
    mocks.events.push("migrations");
    return { applied: [] };
  }),
}));

vi.mock("../../src/storage/postgresql/migrations.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/storage/postgresql/migrations.js")>(),
  runPostgreSqlMigrations: mocks.runMigrations,
}));

vi.mock("../../src/storage/postgresql/runtime.js", () => ({
  PostgreSqlRuntime: vi.fn(function PostgreSqlRuntime(
    settings: { caFile: string; url: string },
  ) {
    if (settings.caFile === mocks.caFailureFile) {
      throw new Error("PostgreSQL TLS configuration failed");
    }
    const url = new URL(settings.url);
    const instance = `${url.username}@${url.pathname.slice(1)}`;
    return {
      close: vi.fn(async () => {
        mocks.closeAttempts.push(instance);
        mocks.events.push(`close:${instance}`);
        if (
          mocks.databaseAdminCloseFailure
          && url.username === "lcm_harness_admin"
          && url.pathname !== `/${CONTROL_DATABASE}`
        ) {
          const failure = mocks.databaseAdminCloseFailure;
          mocks.databaseAdminCloseFailure = undefined;
          throw failure;
        }
      }),
      health: vi.fn(async () => ({
        status: "healthy",
        role: url.username,
      })),
      query: vi.fn(async (
        query: { text?: string; values?: unknown[] },
        context: { operation?: string } = {},
      ) => {
        const operation = context.operation ?? "unknown";
        mocks.operations.push(operation);
        mocks.events.push(`query:${operation}`);
        mocks.queryConfigs.push(query);
        if (mocks.queryFailureOperation === operation) {
          mocks.queryFailureOperation = undefined;
          throw new Error(`injected ${operation} failure`);
        }
        if (operation === "harnessOwnershipPreflight") {
          return {
            command: "SELECT", fields: [], oid: 0, rowCount: 1,
            rows: [{
              server_version_num: REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION * 10_000,
              role: url.username,
              tls: true,
              run_id: process.env.LCM_TEST_POSTGRES_RUN_ID,
              database_name: process.env.LCM_TEST_POSTGRES_CONTROL_DATABASE,
              runtime_role: "lcm_test_runtime",
              ...mocks.guardOverrides,
            }],
          };
        }
        if (operation === "harnessExtensionsPreflight") {
          const names = query.values?.[0] as string[];
          return {
            command: "SELECT", fields: [], oid: 0, rowCount: names.length,
            rows: names.map((extname) => ({
              extname,
              default_version: "1.0",
              installed_version: "1.0",
              schema_name: "public",
              ...mocks.extensionOverrides,
            })),
          };
        }
        if (operation === "harnessPgStatStatementsPreflight") {
          return {
            command: "SELECT", fields: [], oid: 0, rowCount: 1,
            rows: [{ stats_reset: null }],
          };
        }
        if (operation === "verifyDropSentinel") {
          const databaseName = new URL(settings.url).pathname.slice(1);
          return {
            command: "SELECT",
            fields: [],
            oid: 0,
            rowCount: 1,
            rows: [{
              server_version_num: REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION * 10_000,
              role: "lcm_harness_admin",
              tls: true,
              run_id: process.env.LCM_TEST_POSTGRES_RUN_ID,
              database_name: databaseName,
              runtime_role: "lcm_test_runtime",
            }],
          };
        }
        if (operation === "dropTestDatabase") {
          mocks.dropAttempts += 1;
          await mocks.dropGate?.promise;
        }
        return { command: "SELECT", fields: [], oid: 0, rowCount: 0, rows: [] };
      }),
    };
  }),
}));

import { REQUIRED_POSTGRESQL_EXTENSIONS } from "../../src/storage/postgresql/extensions.js";
import { REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION } from "../../src/storage/postgresql/migrations.js";
import {
  assertHarnessReady,
  createPostgreSqlTestDatabase,
  validateHarnessEnvironment,
} from "./harness.js";

const RUN_ID = "0123456789abcdef0123456789abcdef";
const SHORT_RUN_ID = RUN_ID.slice(0, 20);
const CONTROL_DATABASE = `lcm_harness_${SHORT_RUN_ID}`;
const POSTGRES_HOST = `lcm-pg-${SHORT_RUN_ID}.test`;
const ENVIRONMENT = {
  LCM_TEST_POSTGRES_RUN_ID: RUN_ID,
  LCM_TEST_POSTGRES_CONTROL_DATABASE: CONTROL_DATABASE,
  LCM_TEST_POSTGRES_ADMIN_URL: `postgresql://lcm_harness_admin:admin-secret@${POSTGRES_HOST}:5432/${CONTROL_DATABASE}`,
  LCM_TEST_POSTGRES_MIGRATOR_URL: `postgresql://lcm_test_migrator:migrator-secret@${POSTGRES_HOST}:5432/${CONTROL_DATABASE}`,
  LCM_TEST_POSTGRES_RUNTIME_URL: `postgresql://lcm_test_runtime:runtime-secret@${POSTGRES_HOST}:5432/${CONTROL_DATABASE}`,
  LCM_TEST_POSTGRES_CA_FILE: "/tmp/postgresql-test-ca.pem",
  LCM_TEST_POSTGRES_WRONG_CA_FILE: "/tmp/postgresql-test-wrong-ca.pem",
  LCM_TEST_POSTGRES_WRONG_HOST: `lcm-pg-wrong-${SHORT_RUN_ID}.test`,
  LCM_TEST_POSTGRES_INNER_CI: "true",
} as const;

beforeEach(() => {
  for (const [key, value] of Object.entries(ENVIRONMENT)) vi.stubEnv(key, value);
  mocks.caFailureFile = undefined;
  mocks.closeAttempts.length = 0;
  mocks.databaseAdminCloseFailure = undefined;
  mocks.dropAttempts = 0;
  mocks.dropGate = undefined;
  mocks.events.length = 0;
  mocks.extensionOverrides = {};
  mocks.guardOverrides = {};
  mocks.operations.length = 0;
  mocks.queryFailureOperation = undefined;
  mocks.queryConfigs.length = 0;
  mocks.runMigrations.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PostgreSQL test database lease", () => {
  it("validates a generated inner-CI environment without mutating the source", () => {
    const source = { ...ENVIRONMENT };

    expect(validateHarnessEnvironment(source)).toEqual(
      Object.fromEntries(
        Object.entries(ENVIRONMENT).filter(([key]) => key !== "LCM_TEST_POSTGRES_INNER_CI"),
      ),
    );
    expect(source).toEqual(ENVIRONMENT);
  });

  it("validates a generated loopback environment on a random explicit port", () => {
    const local = {
      ...ENVIRONMENT,
      LCM_TEST_POSTGRES_ADMIN_URL: `postgresql://lcm_harness_admin:admin-secret@127.0.0.1:49152/${CONTROL_DATABASE}`,
      LCM_TEST_POSTGRES_MIGRATOR_URL: `postgresql://lcm_test_migrator:migrator-secret@127.0.0.1:49152/${CONTROL_DATABASE}`,
      LCM_TEST_POSTGRES_RUNTIME_URL: `postgresql://lcm_test_runtime:runtime-secret@127.0.0.1:49152/${CONTROL_DATABASE}`,
      LCM_TEST_POSTGRES_WRONG_HOST: "localhost",
      LCM_TEST_POSTGRES_INNER_CI: undefined,
    };

    expect(validateHarnessEnvironment(local)).toMatchObject({
      LCM_TEST_POSTGRES_RUN_ID: RUN_ID,
      LCM_TEST_POSTGRES_CONTROL_DATABASE: CONTROL_DATABASE,
    });
  });

  it.each([
    ["malformed run ID", { LCM_TEST_POSTGRES_RUN_ID: "not-a-run-id" }],
    ["uppercase run ID", { LCM_TEST_POSTGRES_RUN_ID: RUN_ID.toUpperCase() }],
    ["mismatched control database", { LCM_TEST_POSTGRES_CONTROL_DATABASE: "lcm_harness_other" }],
    ["wrong admin role", {
      LCM_TEST_POSTGRES_ADMIN_URL: `postgresql://postgres:admin-secret@${POSTGRES_HOST}:5432/${CONTROL_DATABASE}`,
    }],
    ["wrong migrator role", {
      LCM_TEST_POSTGRES_MIGRATOR_URL: `postgresql://postgres:migrator-secret@${POSTGRES_HOST}:5432/${CONTROL_DATABASE}`,
    }],
    ["wrong runtime role", {
      LCM_TEST_POSTGRES_RUNTIME_URL: `postgresql://postgres:runtime-secret@${POSTGRES_HOST}:5432/${CONTROL_DATABASE}`,
    }],
    ["wrong URL database", {
      LCM_TEST_POSTGRES_RUNTIME_URL: `postgresql://lcm_test_runtime:runtime-secret@${POSTGRES_HOST}:5432/postgres`,
    }],
    ["external host", {
      LCM_TEST_POSTGRES_RUNTIME_URL: `postgresql://lcm_test_runtime:runtime-secret@example.com:5432/${CONTROL_DATABASE}`,
    }],
    ["socket target", {
      LCM_TEST_POSTGRES_RUNTIME_URL: `postgresql:///var/run/postgresql/${CONTROL_DATABASE}`,
    }],
    ["query component", {
      LCM_TEST_POSTGRES_RUNTIME_URL: `${ENVIRONMENT.LCM_TEST_POSTGRES_RUNTIME_URL}?sslmode=disable`,
    }],
    ["relative CA path", { LCM_TEST_POSTGRES_CA_FILE: "private/ca.pem" }],
    ["reused wrong CA", {
      LCM_TEST_POSTGRES_WRONG_CA_FILE: ENVIRONMENT.LCM_TEST_POSTGRES_CA_FILE,
    }],
    ["wrong hostname fixture", { LCM_TEST_POSTGRES_WRONG_HOST: "wrong-host" }],
  ])("rejects %s with a sanitized diagnostic", (_label, override) => {
    const secret = "do-not-leak-this-secret";
    const source = { ...ENVIRONMENT, ...override };
    source.LCM_TEST_POSTGRES_RUNTIME_URL = source.LCM_TEST_POSTGRES_RUNTIME_URL
      .replace("runtime-secret", secret);

    expect(() => validateHarnessEnvironment(source)).toThrowError(
      /^invalid PostgreSQL harness environment:/u,
    );
    try {
      validateHarnessEnvironment(source);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(source.LCM_TEST_POSTGRES_CA_FILE);
    }
  });

  it.each([
    ["local default port", {
      LCM_TEST_POSTGRES_INNER_CI: undefined,
      LCM_TEST_POSTGRES_ADMIN_URL: `postgresql://lcm_harness_admin:admin-secret@127.0.0.1:5432/${CONTROL_DATABASE}`,
      LCM_TEST_POSTGRES_MIGRATOR_URL: `postgresql://lcm_test_migrator:migrator-secret@127.0.0.1:5432/${CONTROL_DATABASE}`,
      LCM_TEST_POSTGRES_RUNTIME_URL: `postgresql://lcm_test_runtime:runtime-secret@127.0.0.1:5432/${CONTROL_DATABASE}`,
      LCM_TEST_POSTGRES_WRONG_HOST: "localhost",
    }],
    ["CI alias outside the inner runner", { LCM_TEST_POSTGRES_INNER_CI: undefined }],
    ["loopback inside the CI runner", {
      LCM_TEST_POSTGRES_ADMIN_URL: `postgresql://lcm_harness_admin:admin-secret@127.0.0.1:49152/${CONTROL_DATABASE}`,
    }],
  ])("rejects %s", (_label, override) => {
    expect(() => validateHarnessEnvironment({ ...ENVIRONMENT, ...override }))
      .toThrow("invalid PostgreSQL harness environment");
  });

  it.each(["LCM_POSTGRES_URL", "LCM_POSTGRES_CA_FILE", "PGHOST", "PGPASSWORD"])(
    "rejects ambient %s configuration",
    (key) => {
      expect(() => validateHarnessEnvironment({ ...ENVIRONMENT, [key]: "" }))
        .toThrow("ambient PostgreSQL configuration");
    },
  );

  it("uses the authoritative required-extension set for readiness", async () => {
    await expect(assertHarnessReady()).resolves.toBeUndefined();

    const operationIndex = mocks.operations.indexOf("harnessExtensionsPreflight");
    expect(operationIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.queryConfigs[operationIndex]?.values).toEqual([
      [...REQUIRED_POSTGRESQL_EXTENSIONS],
    ]);
    expect(mocks.operations).toContain("harnessPgStatStatementsPreflight");
    expect(mocks.events.indexOf("migrations"))
      .toBeGreaterThan(mocks.events.indexOf("query:harnessPgStatStatementsPreflight"));
  });

  it.each([
    ["server version", { server_version_num: 17_0000 }],
    ["role", { role: "postgres" }],
    ["TLS", { tls: false }],
    ["run sentinel", { run_id: "fedcba9876543210fedcba9876543210" }],
    ["database sentinel", { database_name: "postgres" }],
    ["runtime sentinel", { runtime_role: "postgres" }],
  ])("refuses readiness before migrations on a mismatched %s", async (_label, override) => {
    mocks.guardOverrides = override;

    await expect(assertHarnessReady()).rejects.toThrow("ownership preflight failed");

    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("refuses database creation before CREATE DATABASE when ownership preflight fails", async () => {
    mocks.guardOverrides = { tls: false };

    await expect(createPostgreSqlTestDatabase("unsafe")).rejects
      .toThrow("ownership preflight failed");

    expect(mocks.operations).not.toContain("createTestDatabase");
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "server version",
      configure: () => { mocks.guardOverrides = { server_version_num: 17_0000 }; },
    },
    {
      label: "role",
      configure: () => { mocks.guardOverrides = { role: "postgres" }; },
    },
    {
      label: "TLS",
      configure: () => { mocks.guardOverrides = { tls: false }; },
    },
    {
      label: "run sentinel",
      configure: () => {
        mocks.guardOverrides = { run_id: "fedcba9876543210fedcba9876543210" };
      },
    },
    {
      label: "database sentinel",
      configure: () => { mocks.guardOverrides = { database_name: "postgres" }; },
    },
    {
      label: "runtime sentinel",
      configure: () => { mocks.guardOverrides = { runtime_role: "postgres" }; },
    },
    {
      label: "extensions",
      configure: () => { mocks.extensionOverrides = { installed_version: null }; },
    },
    {
      label: "pg_stat_statements",
      configure: () => { mocks.queryFailureOperation = "harnessPgStatStatementsPreflight"; },
    },
  ])("refuses DROP before target inspection when the control $label preflight fails", async ({
    configure,
  }) => {
    const database = await createPostgreSqlTestDatabase("drop-control-preflight");
    mocks.operations.length = 0;
    configure();

    await expect(database.drop()).rejects.toThrow();

    expect(mocks.operations).not.toContain("verifyDropSentinel");
    expect(mocks.operations).not.toContain("drainTestDatabase");
    expect(mocks.operations).not.toContain("dropTestDatabase");
  });

  it("refuses a wrong CA before migrations", async () => {
    const wrongCa = ENVIRONMENT.LCM_TEST_POSTGRES_WRONG_CA_FILE;
    vi.stubEnv("LCM_TEST_POSTGRES_CA_FILE", wrongCa);
    vi.stubEnv("LCM_TEST_POSTGRES_WRONG_CA_FILE", "/tmp/postgresql-test-unused-ca.pem");
    mocks.caFailureFile = wrongCa;

    await expect(assertHarnessReady()).rejects.toThrow("TLS configuration failed");

    expect(mocks.operations).toEqual([]);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("refuses a wrong hostname before migrations", async () => {
    vi.stubEnv(
      "LCM_TEST_POSTGRES_ADMIN_URL",
      ENVIRONMENT.LCM_TEST_POSTGRES_ADMIN_URL.replace(POSTGRES_HOST, "wrong-host.example"),
    );

    await expect(assertHarnessReady()).rejects.toThrow("invalid PostgreSQL harness environment");

    expect(mocks.operations).toEqual([]);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it.each(["harnessExtensionsPreflight", "harnessPgStatStatementsPreflight"])(
    "refuses readiness before migrations when %s fails",
    async (operation) => {
      mocks.queryFailureOperation = operation;

      await expect(assertHarnessReady()).rejects.toThrow();

      expect(mocks.runMigrations).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unavailable extension", { default_version: null }],
    ["uninstalled extension", { installed_version: null }],
    ["extension version mismatch", { installed_version: "0.9" }],
    ["extension namespace mismatch", { schema_name: "hostile" }],
  ])("refuses readiness before migrations for an %s", async (_label, override) => {
    mocks.extensionOverrides = override;

    await expect(assertHarnessReady()).rejects.toThrow("extension preflight failed");

    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("drops the owned database when the database admin close fails", async () => {
    const secret = "postgresql://admin:close-secret@postgres/private";
    mocks.databaseAdminCloseFailure = new Error(`injected close failure ${secret}`);

    const failure = await createPostgreSqlTestDatabase("close-failure").catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "StorageOperationError",
      backend: "postgresql",
      domain: "factory",
      operation: "createTestDatabase",
    });
    expect(String(failure)).not.toContain(secret);
    expect(mocks.dropAttempts).toBe(1);
    expect(mocks.operations.filter((operation) => operation === "verifyDropSentinel")).toHaveLength(1);
    expect(mocks.operations.filter((operation) => operation === "drainTestDatabase")).toHaveLength(1);
    expect(mocks.closeAttempts.filter((instance) => instance.startsWith("lcm_harness_admin@lcm_t_")))
      .toHaveLength(2);
    expect(mocks.closeAttempts.filter((instance) => instance.startsWith("lcm_test_migrator@lcm_t_")))
      .toHaveLength(1);
    expect(mocks.closeAttempts.filter((instance) => instance.startsWith("lcm_test_runtime@lcm_t_")))
      .toHaveLength(1);
    expect(mocks.closeAttempts.filter((instance) => instance === `lcm_harness_admin@${CONTROL_DATABASE}`))
      .toHaveLength(4);

    const databaseAdminClose = mocks.events.findIndex(
      (event) => event.startsWith("close:lcm_harness_admin@lcm_t_"),
    );
    const migratorClose = mocks.events.findIndex((event) => event.startsWith("close:lcm_test_migrator@lcm_t_"));
    const sentinelGuard = mocks.events.indexOf("query:verifyDropSentinel");
    const databaseDrop = mocks.events.indexOf("query:dropTestDatabase");
    expect(databaseAdminClose).toBeGreaterThanOrEqual(0);
    expect(migratorClose).toBeGreaterThan(databaseAdminClose);
    expect(sentinelGuard).toBeGreaterThan(migratorClose);
    expect(databaseDrop).toBeGreaterThan(sentinelGuard);
  });

  it("installs the ownership sentinel before fallible extension setup", async () => {
    mocks.queryFailureOperation = "createTestExtension";

    const failure = await createPostgreSqlTestDatabase("extension-failure")
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "StorageOperationError",
      backend: "postgresql",
      domain: "factory",
      operation: "createTestDatabase",
    });
    expect(mocks.dropAttempts).toBe(1);
    const protectSentinel = mocks.operations.indexOf("protectTestSentinel");
    const extensionSetup = mocks.operations.indexOf("createTestExtension");
    const sentinelGuard = mocks.operations.indexOf("verifyDropSentinel");
    expect(protectSentinel).toBeGreaterThanOrEqual(0);
    expect(extensionSetup).toBeGreaterThan(protectSentinel);
    expect(sentinelGuard).toBeGreaterThan(extensionSetup);
  });

  it("shares one in-flight and completed drop across concurrent callers", async () => {
    const database = await createPostgreSqlTestDatabase("concurrent-drop");
    const gate = deferred();
    mocks.dropGate = gate;

    const first = database.drop();
    const concurrent = database.drop();
    expect(concurrent).toBe(first);
    await vi.waitFor(() => expect(mocks.dropAttempts).toBe(1));

    gate.resolve();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([undefined, undefined]);
    expect(database.drop()).toBe(first);
    expect(mocks.operations.filter((operation) => operation === "drainTestDatabase")).toHaveLength(1);
    expect(mocks.dropAttempts).toBe(1);
  });

  it("refuses destructive cleanup after a valid harness environment drifts", async () => {
    const database = await createPostgreSqlTestDatabase("environment-drift");
    vi.stubEnv(
      "LCM_TEST_POSTGRES_ADMIN_URL",
      ENVIRONMENT.LCM_TEST_POSTGRES_ADMIN_URL.replace("admin-secret", "changed-admin-secret"),
    );

    await expect(database.drop()).rejects.toThrow("environment drift");

    expect(mocks.operations).not.toContain("verifyDropSentinel");
    expect(mocks.operations).not.toContain("drainTestDatabase");
    expect(mocks.operations).not.toContain("dropTestDatabase");
  });

  it("shares a failed drop and clears it for one explicit retry", async () => {
    const database = await createPostgreSqlTestDatabase("retry-drop");
    const failedGate = deferred();
    mocks.dropGate = failedGate;

    const first = database.drop();
    const concurrent = database.drop();
    expect(concurrent).toBe(first);
    await vi.waitFor(() => expect(mocks.dropAttempts).toBe(1));

    failedGate.reject(new Error("injected DROP failure"));
    await expect(first).rejects.toThrow("injected DROP failure");

    const retryGate = deferred();
    mocks.dropGate = retryGate;
    const retry = database.drop();
    expect(retry).not.toBe(first);
    expect(database.drop()).toBe(retry);
    await vi.waitFor(() => expect(mocks.dropAttempts).toBe(2));

    retryGate.resolve();
    await expect(retry).resolves.toBeUndefined();
    expect(mocks.operations.filter((operation) => operation === "drainTestDatabase")).toHaveLength(2);
  });

  it("creates a guarded unmigrated database with an intentionally omitted extension", async () => {
    const database = await createPostgreSqlTestDatabase("missing-extension", {
      omitExtensions: ["unaccent"],
      runMigrations: false,
    });

    expect(mocks.operations.filter((operation) => operation === "createTestExtension"))
      .toHaveLength(3);
    expect(mocks.operations).not.toContain("grantRuntimeBaseline");
    expect(mocks.runMigrations).not.toHaveBeenCalled();

    await expect(database.drop()).resolves.toBeUndefined();
    expect(mocks.operations.filter((operation) => operation === "verifyDropSentinel"))
      .toHaveLength(1);
  });

  it("creates one guarded custom namespace for selected extension fixtures", async () => {
    const database = await createPostgreSqlTestDatabase("extension-schema", {
      extensionSchemas: {
        pg_trgm: "lcm_test_extensions",
        unaccent: "lcm_test_extensions",
      },
      runMigrations: false,
    });

    expect(mocks.operations.filter((operation) => operation === "createTestExtensionSchema"))
      .toHaveLength(1);
    expect(mocks.operations.filter((operation) => operation === "createTestExtension"))
      .toHaveLength(4);
    expect(mocks.runMigrations).not.toHaveBeenCalled();

    await expect(database.drop()).resolves.toBeUndefined();
  });
});
