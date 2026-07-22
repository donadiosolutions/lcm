import { beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  assertHarnessReady,
  harnessEnvironment,
  settings,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

describe("PostgreSQL 18 runtime", () => {
  it("uses verified TLS, exact major version, UTC, and the least-privilege role", async () => {
    await withPostgreSqlTestDatabase("runtime-health", async (database) => {
      await expect(database.runtime.health()).resolves.toMatchObject({
        status: "healthy",
        backend: "postgresql",
        serverMajorVersion: 18,
        tls: true,
        timezone: "UTC",
        role: "lcm_test_runtime",
      });
    });
  });

  it("rejects an untrusted CA and a hostname not present in the server certificate", async () => {
    const env = harnessEnvironment();
    const wrongCa = new PostgreSqlRuntime(settings(env.LCM_TEST_POSTGRES_RUNTIME_URL, {
      caFile: env.LCM_TEST_POSTGRES_WRONG_CA_FILE,
      connectionTimeoutMs: 1_000,
    }));
    const wrongHostUrl = new URL(env.LCM_TEST_POSTGRES_RUNTIME_URL);
    wrongHostUrl.hostname = env.LCM_TEST_POSTGRES_WRONG_HOST;
    const wrongHost = new PostgreSqlRuntime(settings(wrongHostUrl.toString(), { connectionTimeoutMs: 1_000 }));
    try {
      await expect(wrongCa.health()).resolves.toMatchObject({ status: "unavailable" });
      await expect(wrongHost.health()).resolves.toMatchObject({ status: "unavailable" });
    } finally {
      await Promise.allSettled([wrongCa.close(), wrongHost.close()]);
    }
  });

  it("bounds pool acquisition and server-side statement execution", async () => {
    await withPostgreSqlTestDatabase("timeouts", async (database) => {
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl, {
        poolMax: 1,
        connectionTimeoutMs: 100,
        statementTimeoutMs: 500,
      }));
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const transaction = runtime.transaction(async () => {
        entered();
        await held;
      }, { domain: "transaction", operation: "hold" });
      await started;
      await expect(runtime.query({ text: "SELECT 1" }, {
        domain: "factory",
        operation: "poolExhaustion",
      })).rejects.toMatchObject({ backend: "postgresql", operation: "poolExhaustion" });
      release();
      await transaction;
      await expect(runtime.query({ text: "SELECT pg_sleep(2)" }, {
        domain: "factory",
        operation: "statementTimeout",
      })).rejects.toMatchObject({ retryable: false });
      await runtime.close();
    });
  });

  it("cancels an active query without leaving an unusable pooled session", async () => {
    await withPostgreSqlTestDatabase("cancellation", async (database) => {
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl, { statementTimeoutMs: 5_000 }));
      const controller = new AbortController();
      const query = runtime.query({ text: "SELECT pg_sleep(5)" }, {
        domain: "factory",
        operation: "cancelQuery",
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      await expect(query).rejects.toMatchObject({ backend: "postgresql" });
      await expect(runtime.query<{ value: number }>({ text: "SELECT 1 AS value" }, {
        domain: "factory",
        operation: "afterCancellation",
      })).resolves.toMatchObject({ rows: [{ value: 1 }] });
      await runtime.close();
    });
  });

  it("reports and recovers from a disconnected idle pooled session", async () => {
    await withPostgreSqlTestDatabase("disconnect", async (database) => {
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        const target = await database.runtime.query<{ pid: number }>({
          text: "SELECT pg_backend_pid() AS pid",
        }, { domain: "factory", operation: "disconnectTarget" });
        await admin.query({
          text: "SELECT pg_terminate_backend($1)",
          values: [target.rows[0].pid],
        }, { domain: "factory", operation: "disconnectSession" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await expect(database.runtime.health()).resolves.toMatchObject({ status: "degraded" });
        await expect(database.runtime.health()).resolves.toMatchObject({ status: "healthy" });
      } finally {
        await admin.close();
      }
    });
  });
});
