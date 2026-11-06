import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlRuntime, POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES } from "../../src/storage/postgresql/runtime.js";
import { DEFAULT_SNAPSHOT_IDLE_TIMEOUT_MS } from "../../src/storage/postgresql/snapshot-session.js";
import {
  assertHarnessReady,
  settings,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";
import { postgreSqlUrlTarget, startRoundTripRelay } from "./round-trip-relay.js";

beforeAll(assertHarnessReady);

const context = { domain: "transaction", operation: "portableSnapshotFixture" } as const;

async function createFixture(database: PostgreSqlTestDatabase): Promise<string> {
  const project = await database.migrator.query<{ project_id: string }>({
    text: `INSERT INTO lcm.projects (identity_key, display_name)
           VALUES ($1, 'Portable snapshot') RETURNING project_id`,
    values: [createHash("sha256").update(database.name).digest("hex")],
  }, context);
  const projectId = project.rows[0].project_id;
  await database.migrator.query({
    text: `CREATE TABLE public.portable_snapshot_probe (
             project_id uuid PRIMARY KEY REFERENCES lcm.projects(project_id),
             value integer NOT NULL
           );
           GRANT SELECT, UPDATE ON public.portable_snapshot_probe TO lcm_test_runtime`,
  }, context);
  await database.migrator.query({
    text: "INSERT INTO public.portable_snapshot_probe VALUES ($1, 1)", values: [projectId],
  }, context);
  return projectId;
}

function readValue(projectId: string) {
  return {
    text: "SELECT value FROM public.portable_snapshot_probe WHERE project_id = $1",
    values: [projectId],
  };
}

describe("PostgreSQL 18 portable snapshot session", () => {
  it("retains one TLS backend and a stable readonly snapshot across concurrent commits", async () => {
    await withPostgreSqlTestDatabase("snapshot-visible", async (database) => {
      const projectId = await createFixture(database);
      const options = { ...context, projectId };
      const session = await database.runtime.openReadOnlySnapshot({ projectId });
      try {
        const identity = await session.query<{
          pid: number; isolation: string; readonly: string; tls: boolean;
        }>({
          text: `SELECT pg_catalog.pg_backend_pid() AS pid,
                   pg_catalog.current_setting('transaction_isolation') AS isolation,
                   pg_catalog.current_setting('transaction_read_only') AS readonly,
                   (SELECT ssl FROM pg_catalog.pg_stat_ssl
                    WHERE pid = pg_catalog.pg_backend_pid()) AS tls`,
        }, options);
        expect(identity.rows).toEqual([{
          pid: session.identity.backendPid, isolation: "repeatable read", readonly: "on", tls: true,
        }]);
        expect(session.identity.projectId).toBe(projectId);
        await expect(session.query(readValue(projectId), options)).resolves.toMatchObject({ rows: [{ value: 1 }] });
        await database.migrator.query({
          text: "UPDATE public.portable_snapshot_probe SET value = 2 WHERE project_id = $1",
          values: [projectId],
        }, context);
        await expect(database.runtime.query(readValue(projectId), context)).resolves.toMatchObject({ rows: [{ value: 2 }] });
        await expect(session.query(readValue(projectId), options)).resolves.toMatchObject({ rows: [{ value: 1 }] });
      } finally {
        await session.close();
      }
      const reopened = await database.runtime.openReadOnlySnapshot({ projectId });
      try {
        expect(reopened.identity.sessionId).not.toBe(session.identity.sessionId);
        await expect(reopened.query(readValue(projectId), options)).resolves.toMatchObject({ rows: [{ value: 2 }] });
      } finally {
        await reopened.close();
      }
      await expect(database.runtime.query({ text: "SHOW transaction_isolation" }, context))
        .resolves.toMatchObject({ rows: [{ transaction_isolation: "read committed" }] });
    });
  });

  it("opens in two exchanges and runs each read in one, without a PID probe", async () => {
    await withPostgreSqlTestDatabase("snapshot-exchanges", async (database) => {
      const projectId = await createFixture(database);
      const relay = await startRoundTripRelay(postgreSqlUrlTarget(database.runtimeUrl));
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl, { poolMax: 1 }), {
        ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
        // A frozen clock keeps the warmed connection below the idle-validation threshold.
        now: () => 0,
        buildConfig: (candidate) => ({
          ...POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES.buildConfig(candidate),
          host: "127.0.0.1",
          port: relay.port,
        }),
      });
      const exchanges = async (operation: () => Promise<unknown>): Promise<number> => {
        const before = relay.counts().turns;
        await operation();
        return relay.counts().turns - before;
      };
      try {
        await runtime.query({ text: "SELECT 1" }, context);
        let session!: Awaited<ReturnType<typeof runtime.openReadOnlySnapshot>>;
        // The fused opener with its identity witness, then the parameterized idle-timeout set_config.
        expect(await exchanges(async () => { session = await runtime.openReadOnlySnapshot({ projectId }); })).toBe(2);
        // Every read carries the session's cancellation signal and still needs no PID probe.
        expect(await exchanges(() => session.query(readValue(projectId), { ...context, projectId }))).toBe(1);
        expect(await exchanges(() => session.close())).toBe(1);
        expect(relay.counts().connections).toBe(1);
      } finally {
        await runtime.close();
        await relay.close();
      }
    });
  });

  it("refuses writes even with UPDATE privilege and rejects a different project scope", async () => {
    await withPostgreSqlTestDatabase("snapshot-readonly", async (database) => {
      const projectId = await createFixture(database);
      const session = await database.runtime.openReadOnlySnapshot({ projectId });
      try {
        await expect(session.query({
          text: "UPDATE public.portable_snapshot_probe SET value = 99 WHERE project_id = $1",
          values: [projectId],
        }, { ...context, projectId })).rejects.toMatchObject({ sqlState: "25006", projectId });
      } finally {
        await session.close();
      }
      await expect(database.runtime.query(readValue(projectId), context)).resolves.toMatchObject({ rows: [{ value: 1 }] });
      const scoped = await database.runtime.openReadOnlySnapshot({ projectId });
      try {
        await expect(scoped.query(readValue(projectId), {
          ...context, projectId: "00000000-0000-0000-0000-000000000000",
        })).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
      } finally {
        await scoped.close();
      }
    });
  });

  it("cancels a confirmed in-flight read, drops queued reads, and destroys the source backend", async () => {
    await withPostgreSqlTestDatabase("snapshot-abort", async (database) => {
      const projectId = await createFixture(database);
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
      const controller = new AbortController();
      const session = await database.runtime.openReadOnlySnapshot({ projectId, signal: controller.signal });
      const options = { ...context, projectId };
      try {
        const pending = session.query({ text: "SELECT pg_catalog.pg_sleep(20)" }, options);
        const rejected = expect(pending).rejects.toMatchObject({ backend: "postgresql", projectId });
        await expect.poll(async () => {
          const activity = await administrator.query<{ wait_event: string }>({
            text: "SELECT wait_event FROM pg_catalog.pg_stat_activity WHERE pid = $1",
            values: [session.identity.backendPid],
          }, context);
          return activity.rows[0]?.wait_event;
        }, { timeout: 2_000, interval: 10 }).toBe("PgSleep");
        const queued = session.query(readValue(projectId), options);
        const queuedRejected = expect(queued).rejects.toMatchObject({ code: "STORAGE_CLOSED", projectId });
        controller.abort(new Error("private fixture abort reason"));
        await Promise.all([rejected, queuedRejected]);
        await session.close();
        await expect.poll(async () => {
          const activity = await administrator.query({
            text: "SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = $1",
            values: [session.identity.backendPid],
          }, context);
          return activity.rows.length;
        }, { timeout: 2_000, interval: 10 }).toBe(0);
        await expect(database.runtime.query(readValue(projectId), context)).resolves.toMatchObject({ rows: [{ value: 1 }] });
      } finally {
        controller.abort();
        await session.close();
        await administrator.close();
      }
    });
  });

  it("bounds the snapshot's idle-in-transaction timeout independently of the connection-level statement-scale bound", async () => {
    await withPostgreSqlTestDatabase("snapshot-idle-timeout", async (database) => {
      const projectId = await createFixture(database);
      const options = { ...context, projectId };
      const session = await database.runtime.openReadOnlySnapshot({ projectId });
      try {
        // pg_settings.setting is the raw effective value in the GUC's base
        // unit (ms for this setting), unaffected by current_setting()'s
        // "nicest unit" pretty-printing (for example "5min"), so comparing
        // it as a plain integer cannot flake on display formatting.
        await expect(session.query<{ setting: string }>({
          text: "SELECT setting FROM pg_catalog.pg_settings WHERE name = 'idle_in_transaction_session_timeout'",
        }, options)).resolves.toMatchObject({
          rows: [{ setting: String(DEFAULT_SNAPSHOT_IDLE_TIMEOUT_MS) }],
        });
      } finally {
        await session.close();
      }
      // A fresh query config object: the driver's Query wrapper mutates a
      // config object it is given a callback through (attaching its own
      // callback onto it), so reusing the same object reference across two
      // separate query() calls corrupts the second call. Never share one.
      await expect(database.runtime.query<{ setting: string }>({
        text: "SELECT setting FROM pg_catalog.pg_settings WHERE name = 'idle_in_transaction_session_timeout'",
      }, context)).resolves.toMatchObject({ rows: [{ setting: "5000" }] });
    });
  });

  it("reverts the relaxed idle bound on the same pooled client after the snapshot closes", async () => {
    await withPostgreSqlTestDatabase("snapshot-idle-revert", async (database) => {
      const projectId = await createFixture(database);
      // A single-connection pool guarantees the post-close query below
      // reuses the exact physical backend the snapshot held, proving
      // is_local revert semantics rather than merely a fresh connection.
      const solo = new PostgreSqlRuntime(settings(database.runtimeUrl, { poolMax: 1 }));
      try {
        const session = await solo.openReadOnlySnapshot({ projectId });
        const backendPid = session.identity.backendPid;
        await session.close();
        // No projectId: this must take the plain queryDirect path on the
        // runtime's own pool, not the project-scoped mutation-guarded
        // transaction() path, so it actually reuses the recycled backend
        // instead of opening an unrelated read-write transaction.
        await expect(solo.query<{ pid: number; setting: string }>({
          text: `SELECT pg_catalog.pg_backend_pid() AS pid,
                   (SELECT setting FROM pg_catalog.pg_settings
                    WHERE name = 'idle_in_transaction_session_timeout') AS setting`,
        }, context)).resolves.toMatchObject({ rows: [{ pid: backendPid, setting: "5000" }] });
      } finally {
        await solo.close();
      }
    });
  });

  it("enforces a deliberately tiny snapshotIdleTimeoutMs bound per session, server-side, without an unhandled error", async () => {
    await withPostgreSqlTestDatabase("snapshot-idle-enforced", async (database) => {
      const projectId = await createFixture(database);
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
      const tiny = new PostgreSqlRuntime(settings(database.runtimeUrl, { snapshotIdleTimeoutMs: 200 }));
      try {
        const session = await tiny.openReadOnlySnapshot({ projectId });
        const backendPid = session.identity.backendPid;
        try {
          // idle_in_transaction_session_timeout is checked between
          // statements and fires with no query in flight, so it can never
          // be observed as a query rejection shape on a healthy driver;
          // the server actually terminating the backend is the real proof
          // of enforcement. Poll pg_stat_activity from an independent
          // administrator connection until the snapshot's backend is gone.
          await expect.poll(async () => {
            const activity = await administrator.query<{ pid: number }>({
              text: "SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = $1",
              values: [backendPid],
            }, context);
            return activity.rows.length;
          }, { timeout: 5_000, interval: 25 }).toBe(0);
          // The checkout's async-failure listener already observed the
          // FATAL and marked the session destroyed, so close() skips a
          // doomed ROLLBACK against the now-dead backend and resolves
          // cleanly instead of throwing or becoming an unhandled process
          // error.
          await expect(session.close()).resolves.toBeUndefined();
        } finally {
          await session.close().catch(() => undefined);
        }
      } finally {
        await tiny.close();
        await administrator.close();
      }
    });
  });
});
