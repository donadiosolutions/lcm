import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  assertHarnessReady,
  settings,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

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
});
