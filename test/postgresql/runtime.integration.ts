import { readFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { postgreSqlQueryDeadlineMs } from "../../src/storage/postgresql/client-config.js";
import {
  PostgreSqlRuntime,
  POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
} from "../../src/storage/postgresql/runtime.js";
import { verifyPostgreSqlRuntimeSchema } from "../../src/storage/postgresql/runtime-readiness.js";
import {
  assertHarnessReady,
  harnessEnvironment,
  type PostgreSqlTestDatabase,
  settings,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const REQUIRED_RUNTIME_GRANT_SCRIPTS = [
  "postgresql-runtime-readiness-grants.sql",
  "postgresql-runtime-identity-grants.sql",
  "postgresql-runtime-conversation-grants.sql",
  "postgresql-runtime-summary-context-grants.sql",
  "postgresql-runtime-memory-grants.sql",
  "postgresql-runtime-search-grants.sql",
  "postgresql-runtime-coordination-grants.sql",
] as const;

async function applyRuntimeGrantScripts(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
  try {
    for (const script of REQUIRED_RUNTIME_GRANT_SCRIPTS) {
      const template = readFileSync(
        join(process.cwd(), "src", "storage", "postgresql", "reference", script),
        "utf8",
      );
      const sql = template
        .split("\n")
        .filter((line) => !line.startsWith("\\"))
        .join("\n")
        .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
      await administrator.query({ text: sql }, {
        domain: "factory",
        operation: `applyRuntimeGrantScript:${script}`,
      });
    }
  } finally {
    await administrator.close();
  }
}

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

  it("ignores hostile health-catalog shadows in the ambient search path", async () => {
    await withPostgreSqlTestDatabase("runtime-hostile-health", async (database) => {
      await database.migrator.query({
        text: `CREATE SCHEMA hostile_health;
               CREATE FUNCTION hostile_health.current_setting(setting_name text)
               RETURNS text LANGUAGE sql IMMUTABLE
               RETURN CASE setting_name
                 WHEN 'server_version_num' THEN '170000'
                 WHEN 'TimeZone' THEN 'America/Sao_Paulo'
                 ELSE ''
               END;
               CREATE FUNCTION hostile_health.pg_backend_pid()
               RETURNS integer LANGUAGE sql IMMUTABLE RETURN 1;
               CREATE FUNCTION hostile_health.never_equal(left_value integer, right_value integer)
               RETURNS boolean LANGUAGE sql IMMUTABLE RETURN false;
               CREATE OPERATOR hostile_health.= (
                 FUNCTION = hostile_health.never_equal,
                 LEFTARG = integer,
                 RIGHTARG = integer
               );
               CREATE VIEW hostile_health.pg_stat_ssl AS
                 SELECT 1::integer AS pid, false AS ssl;
               GRANT USAGE ON SCHEMA hostile_health TO lcm_test_runtime;
               GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA hostile_health TO lcm_test_runtime;
               GRANT SELECT ON hostile_health.pg_stat_ssl TO lcm_test_runtime`,
      }, { domain: "factory", operation: "createHostileHealthCatalog" });
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl), {
        ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
        buildConfig: (connectionSettings) => ({
          ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES.buildConfig(connectionSettings),
          options: "-c timezone=UTC -c search_path=hostile_health,pg_catalog,public",
        }),
      });
      try {
        await expect(runtime.health()).resolves.toMatchObject({
          status: "healthy",
          backend: "postgresql",
          serverMajorVersion: 18,
          tls: true,
          timezone: "UTC",
          role: "lcm_test_runtime",
        });
      } finally {
        await runtime.close();
      }
    });
  });

  it("forces pg_catalog before public over a hostile database search path", async () => {
    await withPostgreSqlTestDatabase("runtime-search-path", async (database) => {
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await admin.query({
          text: `ALTER DATABASE "${database.name}" SET search_path = public, pg_catalog`,
        }, { domain: "factory", operation: "setHostileDatabaseSearchPath" });
        const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl));
        try {
          await expect(runtime.query<{ search_path: string }>({
            text: "SHOW search_path",
          }, { domain: "factory", operation: "readRuntimeSearchPath" })).resolves.toMatchObject({
            rows: [{ search_path: "pg_catalog,public" }],
          });
        } finally {
          await runtime.close();
        }
      } finally {
        try {
          await admin.query({
            text: `ALTER DATABASE "${database.name}" RESET search_path`,
          }, { domain: "factory", operation: "restoreDatabaseSearchPath" });
        } finally {
          await admin.close();
        }
      }
    });
  });

  it("pins runtime deparser settings without leaking hostile pooled GUCs", async () => {
    await withPostgreSqlTestDatabase("runtime-hostile-deparsers", async (database) => {
      await applyRuntimeGrantScripts(database);
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await administrator.query({
          text: "CREATE SCHEMA hostile_deparser",
        }, { domain: "factory", operation: "createHostileDeparserSchema" });
        await administrator.query({
          text: "GRANT USAGE ON SCHEMA hostile_deparser TO lcm_test_runtime",
        }, { domain: "factory", operation: "grantHostileDeparserSchema" });
      } finally {
        await administrator.close();
      }

      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl, { poolMax: 1 }), {
        ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
        buildConfig: (connectionSettings) => ({
          ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES.buildConfig(connectionSettings),
          options: "-c timezone=UTC -c search_path=hostile_deparser,pg_catalog,public -c quote_all_identifiers=on",
        }),
      });
      try {
        await expect(runtime.query<{ search_path: string }>({
          text: "SHOW search_path",
        }, { domain: "factory", operation: "readHostileDeparserSearchPathBeforeReadiness" })).resolves.toMatchObject({
          rows: [{ search_path: "hostile_deparser,pg_catalog,public" }],
        });
        await expect(runtime.query<{ quote_all_identifiers: string }>({
          text: "SHOW quote_all_identifiers",
        }, { domain: "factory", operation: "readHostileDeparserQuotingBeforeReadiness" })).resolves.toMatchObject({
          rows: [{ quote_all_identifiers: "on" }],
        });

        await expect(verifyPostgreSqlRuntimeSchema(runtime, {
          expectedOwner: "lcm_test_migrator",
        })).resolves.toMatchObject({
          runtimeRole: "lcm_test_runtime",
        });

        await expect(runtime.query<{ search_path: string }>({
          text: "SHOW search_path",
        }, { domain: "factory", operation: "readHostileDeparserSearchPathAfterReadiness" })).resolves.toMatchObject({
          rows: [{ search_path: "hostile_deparser,pg_catalog,public" }],
        });
        await expect(runtime.query<{ quote_all_identifiers: string }>({
          text: "SHOW quote_all_identifiers",
        }, { domain: "factory", operation: "readHostileDeparserQuotingAfterReadiness" })).resolves.toMatchObject({
          rows: [{ quote_all_identifiers: "on" }],
        });
      } finally {
        await runtime.close();
      }
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

  it("abandons a query on a connection that stops answering and recovers on a fresh connection", async () => {
    await withPostgreSqlTestDatabase("query-read-timeout", async (database) => {
      const target = new URL(database.runtimeUrl);
      const sockets = new Set<Socket>();
      let forwarding = true;
      const relay = createServer((downstream) => {
        const upstream = connect({
          host: target.hostname.replace(/^\[|\]$/gu, ""),
          port: target.port === "" ? 5432 : Number(target.port),
        });
        sockets.add(downstream);
        sockets.add(upstream);
        downstream.on("error", () => upstream.destroy());
        upstream.on("error", () => downstream.destroy());
        downstream.on("close", () => upstream.destroy());
        upstream.on("close", () => downstream.destroy());
        downstream.pipe(upstream);
        upstream.on("data", (chunk: Buffer) => { if (forwarding) downstream.write(chunk); });
      });
      await new Promise<void>((resolve) => { relay.listen(0, "127.0.0.1", resolve); });
      const relayPort = (relay.address() as { port: number }).port;
      const connectionSettings = settings(database.runtimeUrl, {
        poolMax: 1,
        connectionTimeoutMs: 1_000,
        statementTimeoutMs: 1_000,
      });
      // Only host and port move to the relay; certificate verification stays
      // bound to the URL host, so TLS is unchanged.
      const runtime = new PostgreSqlRuntime(connectionSettings, {
        ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
        buildConfig: (candidate) => ({
          ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES.buildConfig(candidate),
          host: "127.0.0.1",
          port: relayPort,
        }),
      });
      let watchdog: NodeJS.Timeout | undefined;
      try {
        const warm = await runtime.query<{ pid: number }>({ text: "SELECT pg_backend_pid() AS pid" }, {
          domain: "factory", operation: "warmRelay",
        });
        forwarding = false;
        const deadline = postgreSqlQueryDeadlineMs(connectionSettings);
        const started = Date.now();
        // A deadline regression leaves the query pending; the watchdog turns that into a
        // failed assertion so the cleanup below still runs.
        const expired = new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => { reject(new Error("query deadline watchdog expired")); }, 15_000);
        });
        await expect(Promise.race([runtime.query({ text: "SELECT 1" }, {
          domain: "factory", operation: "blackHole",
        }), expired])).rejects.toMatchObject({
          code: "STORAGE_OPERATION_FAILED",
          backend: "postgresql",
          operation: "blackHole",
          retryable: true,
          sqlState: null,
        });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(deadline - 250);
        expect(elapsed).toBeLessThan(15_000);
        forwarding = true;
        const fresh = await runtime.query<{ pid: number }>({ text: "SELECT pg_backend_pid() AS pid" }, {
          domain: "factory", operation: "afterBlackHole",
        });
        expect(fresh.rows[0].pid).not.toBe(warm.rows[0].pid);
      } finally {
        clearTimeout(watchdog);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => { relay.close(() => { resolve(); }); });
        await runtime.close();
      }
    });
  }, 30_000);

  it("fails an idle runtime transaction killed by the server with a handled storage error", async () => {
    await withPostgreSqlTestDatabase("transaction-idle-kill", async (database) => {
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl, { poolMax: 1 }));
      const context = { domain: "transaction", operation: "idleKill" } as const;
      const idleTimeoutMs = 200;
      try {
        // The relaxed bound is set inside the transaction itself so the test
        // does not depend on the harness role's configured idle timeout.
        // idle_in_transaction_session_timeout fires between statements with
        // no query in flight, so node-pg reports the FATAL on the checked-out
        // Client's 'error' event; without the checkout listener that is an
        // unhandled process-level error, which vitest reports as a failure.
        const outcome = await runtime.transaction(async (transaction) => {
          await transaction.query({
            text: `SET LOCAL idle_in_transaction_session_timeout = ${idleTimeoutMs}`,
          }, context);
          const pid = (await transaction.query<{ pid: number }>({
            text: "SELECT pg_catalog.pg_backend_pid() AS pid",
          }, context)).rows[0].pid;
          await expect.poll(async () => (await admin.query({
            text: "SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = $1",
            values: [pid],
          }, { domain: "factory", operation: "idleKillObserve" })).rows.length, {
            timeout: 2 * idleTimeoutMs,
            interval: 25,
          }).toBe(0);
          return transaction.query({ text: "SELECT 1" }, context);
        }).catch((caught: unknown) => caught);
        expect(outcome).toMatchObject({
          backend: "postgresql",
          code: "STORAGE_OPERATION_FAILED",
          operation: "idleKill",
        });
        // The dead client was destroyed, so the single-connection pool serves
        // the next operation from a fresh backend.
        await expect(runtime.query<{ value: number }>({ text: "SELECT 1 AS value" }, {
          domain: "factory",
          operation: "afterIdleKill",
        })).resolves.toMatchObject({ rows: [{ value: 1 }] });
      } finally {
        await runtime.close();
        await admin.close();
      }
    });
  });
});
