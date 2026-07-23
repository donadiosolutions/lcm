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
  closeAttempts: [] as string[],
  databaseAdminCloseFailure: undefined as Error | undefined,
  dropAttempts: 0,
  dropGate: undefined as Deferred | undefined,
  events: [] as string[],
  operations: [] as string[],
  runMigrations: vi.fn(async () => ({ applied: [] })),
}));

vi.mock("../../src/storage/postgresql/migrations.js", () => ({
  runPostgreSqlMigrations: mocks.runMigrations,
}));

vi.mock("../../src/storage/postgresql/runtime.js", () => ({
  PostgreSqlRuntime: vi.fn(function PostgreSqlRuntime(
    settings: { url: string },
  ) {
    const url = new URL(settings.url);
    const instance = `${url.username}@${url.pathname.slice(1)}`;
    return {
      close: vi.fn(async () => {
        mocks.closeAttempts.push(instance);
        mocks.events.push(`close:${instance}`);
        if (
          mocks.databaseAdminCloseFailure
          && url.username === "admin"
          && url.pathname !== "/lcm_control"
        ) {
          const failure = mocks.databaseAdminCloseFailure;
          mocks.databaseAdminCloseFailure = undefined;
          throw failure;
        }
      }),
      query: vi.fn(async (
        _query: unknown,
        context: { operation?: string } = {},
      ) => {
        const operation = context.operation ?? "unknown";
        mocks.operations.push(operation);
        mocks.events.push(`query:${operation}`);
        if (operation === "verifyDropSentinel") {
          const databaseName = new URL(settings.url).pathname.slice(1);
          return {
            command: "SELECT",
            fields: [],
            oid: 0,
            rowCount: 1,
            rows: [{
              server_version_num: 180_000,
              role: "lcm_harness_admin",
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

import { createPostgreSqlTestDatabase } from "./harness.js";

const ENVIRONMENT = {
  LCM_TEST_POSTGRES_RUN_ID: "0123456789abcdef0123456789abcdef",
  LCM_TEST_POSTGRES_CONTROL_DATABASE: "lcm_control",
  LCM_TEST_POSTGRES_ADMIN_URL: "postgresql://admin:secret@postgres/lcm_control",
  LCM_TEST_POSTGRES_MIGRATOR_URL: "postgresql://migrator:secret@postgres/lcm_control",
  LCM_TEST_POSTGRES_RUNTIME_URL: "postgresql://runtime:secret@postgres/lcm_control",
  LCM_TEST_POSTGRES_CA_FILE: "/tmp/postgresql-test-ca.pem",
  LCM_TEST_POSTGRES_WRONG_CA_FILE: "/tmp/postgresql-test-wrong-ca.pem",
  LCM_TEST_POSTGRES_WRONG_HOST: "wrong-host",
} as const;

beforeEach(() => {
  for (const [key, value] of Object.entries(ENVIRONMENT)) vi.stubEnv(key, value);
  mocks.closeAttempts.length = 0;
  mocks.databaseAdminCloseFailure = undefined;
  mocks.dropAttempts = 0;
  mocks.dropGate = undefined;
  mocks.events.length = 0;
  mocks.operations.length = 0;
  mocks.runMigrations.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PostgreSQL test database lease", () => {
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
    expect(mocks.closeAttempts.filter((instance) => instance.startsWith("admin@lcm_t_"))).toHaveLength(2);
    expect(mocks.closeAttempts.filter((instance) => instance.startsWith("migrator@lcm_t_"))).toHaveLength(1);
    expect(mocks.closeAttempts.filter((instance) => instance.startsWith("runtime@lcm_t_"))).toHaveLength(1);
    expect(mocks.closeAttempts.filter((instance) => instance === "admin@lcm_control")).toHaveLength(2);

    const databaseAdminClose = mocks.events.findIndex((event) => event.startsWith("close:admin@lcm_t_"));
    const migratorClose = mocks.events.findIndex((event) => event.startsWith("close:migrator@lcm_t_"));
    const sentinelGuard = mocks.events.indexOf("query:verifyDropSentinel");
    const databaseDrop = mocks.events.indexOf("query:dropTestDatabase");
    expect(databaseAdminClose).toBeGreaterThanOrEqual(0);
    expect(migratorClose).toBeGreaterThan(databaseAdminClose);
    expect(sentinelGuard).toBeGreaterThan(migratorClose);
    expect(databaseDrop).toBeGreaterThan(sentinelGuard);
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
