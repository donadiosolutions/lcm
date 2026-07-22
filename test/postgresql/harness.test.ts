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
  dropAttempts: 0,
  dropGate: undefined as Deferred | undefined,
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
    return {
      close: vi.fn(async () => undefined),
      query: vi.fn(async (
        _query: unknown,
        context: { operation?: string } = {},
      ) => {
        const operation = context.operation ?? "unknown";
        mocks.operations.push(operation);
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
  mocks.dropAttempts = 0;
  mocks.dropGate = undefined;
  mocks.operations.length = 0;
  mocks.runMigrations.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PostgreSQL test database lease", () => {
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
});
