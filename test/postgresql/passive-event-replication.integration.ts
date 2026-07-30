import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PassiveEventReplicationWorker,
} from "../../src/daemon/passive-event-replication.js";
import {
  SQLiteLocalHookOutboxFactory,
  type LocalHookOutboxRepository,
} from "../../src/storage/local-hook-outbox.js";
import {
  PostgreSqlPassiveEventRepository,
} from "../../src/storage/postgresql/passive-event-repository.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const CRASH_POINTS = [
  "after-insert",
  "after-apply",
  "after-local-ack",
  "after-remote-prune",
] as const;

async function grantPassiveEventRuntimePrivileges(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "docs", "postgresql-runtime-coordination-grants.sql"),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, {
    domain: "passive-events",
    operation: "grantPassiveEventReplicationPrivileges",
  });
}

async function createProject(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<string> {
  const result = await database.migrator.query<{ project_id: string }>({
    text: `INSERT INTO lcm.projects(identity_key, display_name)
           VALUES($1, $2)
           RETURNING project_id`,
    values: [createHash("sha256").update(label).digest("hex"), label],
  }, { domain: "passive-events", operation: "createReplicationProject" });
  return result.rows[0].project_id;
}

async function createMachine(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<string> {
  const result = await database.migrator.query<{ machine_id: string }>({
    text: `INSERT INTO lcm.machines(identity_key, display_name)
           VALUES($1, $2)
           RETURNING machine_id`,
    values: [
      `machine:${createHash("sha256").update(label).digest("hex")}`,
      label,
    ],
  }, { domain: "passive-events", operation: "createReplicationMachine" });
  return result.rows[0].machine_id;
}

async function insertLocalEvents(
  local: LocalHookOutboxRepository,
  prefix: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await local.insertEvent(`${prefix}-session`, {
      type: "choice",
      category: "decision",
      data: `${prefix}-${index}`,
      priority: 1,
    }, "PostToolUse");
  }
}

function clearCapturedMachineIdentity(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("UPDATE events SET machine_id = NULL");
  } finally {
    database.close();
  }
}

function worker(
  local: LocalHookOutboxRepository,
  remote: PostgreSqlPassiveEventRepository,
  processId: string,
): PassiveEventReplicationWorker {
  return new PassiveEventReplicationWorker({
    local,
    remote,
    applyEvent: async (executor, event) => {
      await executor.query({
        text: `INSERT INTO public.passive_event_effects(event_id, machine_id)
               VALUES($1, $2)
               ON CONFLICT(event_id) DO NOTHING`,
        values: [event.eventId, event.machineId],
      }, {
        domain: "passive-events",
        operation: "applyReplicationEffect",
        projectId: remote.projectId,
        machineId: event.machineId,
      });
    },
    random: () => 0.5,
  }, {
    processId,
    batchSize: 2,
    staleClaimMs: 50,
    leaseTtlMs: 1_000,
    retryBaseMs: 1,
    retryMaxMs: 10,
    retryJitterRatio: 0,
    quarantineAfterAttempts: 3,
  });
}

async function driveUntilPruned(
  replication: PassiveEventReplicationWorker,
  local: LocalHookOutboxRepository,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await replication.runOnce();
    const rows = await local.getUnprocessed(500);
    if (
      rows.length === count
      && rows.every((row) =>
        row.delivery_state === "acknowledged"
        && row.remote_pruned_at !== null)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("passive-event replication did not reach a pruned checkpoint");
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    if (!child.kill("SIGKILL")) resolve();
  });
}

async function runCrashFixture(
  database: PostgreSqlTestDatabase,
  input: {
    readonly crashPoint: (typeof CRASH_POINTS)[number];
    readonly projectId: string;
    readonly machineId: string;
    readonly outboxPath: string;
    readonly processId: string;
  },
): Promise<void> {
  const child = fork(
    join(
      process.cwd(),
      "test",
      "postgresql",
      "fixtures",
      "passive-event-replication-crash-worker.mjs",
    ),
    [],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LCM_PASSIVE_EVENT_CRASH_POINT: input.crashPoint,
        LCM_PASSIVE_EVENT_FIXTURE_URL: database.runtimeUrl,
        LCM_PASSIVE_EVENT_FIXTURE_PROJECT_ID: input.projectId,
        LCM_PASSIVE_EVENT_FIXTURE_MACHINE_ID: input.machineId,
        LCM_PASSIVE_EVENT_FIXTURE_OUTBOX_PATH: input.outboxPath,
        LCM_PASSIVE_EVENT_FIXTURE_PROCESS_ID: input.processId,
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let reachedCrashPoint = false;
      const timeout = setTimeout(() => {
        reject(new Error(`passive-event ${input.crashPoint} fixture timed out`));
      }, 10_000);
      const settle = (callback: () => void): void => {
        clearTimeout(timeout);
        child.removeAllListeners("message");
        child.removeAllListeners("error");
        child.removeAllListeners("exit");
        callback();
      };
      child.on("message", (message: unknown) => {
        if (
          typeof message === "object"
          && message !== null
          && "type" in message
          && message.type === "crashing"
          && "crashPoint" in message
          && message.crashPoint === input.crashPoint
        ) {
          reachedCrashPoint = true;
        } else {
          settle(() => reject(new Error(
            `passive-event ${input.crashPoint} fixture failed`,
          )));
        }
      });
      child.once("error", (error) => {
        settle(() => reject(error));
      });
      child.once("exit", (_code, signal) => {
        if (reachedCrashPoint && signal === "SIGKILL") {
          settle(resolve);
        } else {
          settle(() => reject(new Error(
            `passive-event ${input.crashPoint} fixture exited unexpectedly`,
          )));
        }
      });
    });
  } finally {
    await terminateChild(child);
  }
}

describe("PostgreSQL 18 passive-event replication", () => {
  it("drains bounded backlogs from independent machines without reordering effects", async () => {
    await withPostgreSqlTestDatabase("passive-drain", async (database) => {
      await grantPassiveEventRuntimePrivileges(database);
      const projectId = await createProject(database, "Passive drain project");
      const firstMachine = await createMachine(database, "Passive drain machine A");
      const secondMachine = await createMachine(database, "Passive drain machine B");
      await database.migrator.query({
        text: `CREATE TABLE public.passive_event_effects(
                 effect_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                 event_id uuid NOT NULL UNIQUE,
                 machine_id uuid NOT NULL
               );
               REVOKE ALL ON public.passive_event_effects FROM PUBLIC;
               GRANT INSERT, SELECT ON public.passive_event_effects
               TO lcm_test_runtime;
               GRANT USAGE ON SEQUENCE public.passive_event_effects_effect_id_seq
               TO lcm_test_runtime`,
      }, { domain: "passive-events", operation: "createReplicationEffects" });
      const directory = mkdtempSync(join(tmpdir(), "lcm-passive-drain-"));
      const firstFactory = new SQLiteLocalHookOutboxFactory();
      const secondFactory = new SQLiteLocalHookOutboxFactory();
      try {
        const firstPath = join(directory, "first", "events.db");
        const secondPath = join(directory, "second", "events.db");
        const firstLocal = await firstFactory.open(firstPath);
        const secondLocal = await secondFactory.open(secondPath);
        await insertLocalEvents(firstLocal, "first", 5);
        await insertLocalEvents(secondLocal, "second", 5);
        clearCapturedMachineIdentity(firstPath);
        clearCapturedMachineIdentity(secondPath);
        const first = worker(
          firstLocal,
          new PostgreSqlPassiveEventRepository(
            database.runtime,
            projectId,
            firstMachine,
          ),
          "replication-A",
        );
        const second = worker(
          secondLocal,
          new PostgreSqlPassiveEventRepository(
            database.runtime,
            projectId,
            secondMachine,
          ),
          "replication-B",
        );

        const [firstPass, secondPass] = await Promise.all([
          first.runOnce(),
          second.runOnce(),
        ]);
        expect(firstPass.uploaded).toBeLessThanOrEqual(2);
        expect(secondPass.uploaded).toBeLessThanOrEqual(2);
        await Promise.all([
          driveUntilPruned(first, firstLocal, 5),
          driveUntilPruned(second, secondLocal, 5),
        ]);

        const effects = await database.migrator.query<{
          machine_id: string;
          data: string;
          effect_id: string;
        }>({
          text: `SELECT
                   effect.machine_id,
                   inbox.payload->>'data' AS data,
                   effect.effect_id::pg_catalog.text
                 FROM public.passive_event_effects AS effect
                 JOIN (
                   SELECT event_id, payload
                   FROM jsonb_to_recordset($1::pg_catalog.jsonb)
                     AS input(event_id uuid, payload jsonb)
                 ) AS inbox ON inbox.event_id = effect.event_id
                 ORDER BY effect.effect_id`,
          values: [JSON.stringify([
            ...(await firstLocal.getUnprocessed(500)).map((row) => ({
              event_id: row.event_uuid,
              payload: { data: row.data },
            })),
            ...(await secondLocal.getUnprocessed(500)).map((row) => ({
              event_id: row.event_uuid,
              payload: { data: row.data },
            })),
          ])],
        }, { domain: "passive-events", operation: "verifyReplicationOrder" });
        expect(effects.rows).toHaveLength(10);
        for (const [machineId, prefix] of [
          [firstMachine, "first"],
          [secondMachine, "second"],
        ] as const) {
          expect(effects.rows
            .filter((row) => row.machine_id === machineId)
            .map((row) => row.data))
            .toEqual(Array.from({ length: 5 }, (_, index) => `${prefix}-${index}`));
        }
      } finally {
        await Promise.allSettled([firstFactory.close(), secondFactory.close()]);
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("recovers every uncertain-commit crash handoff before acknowledging and pruning", async () => {
    await withPostgreSqlTestDatabase("passive-crash", async (database) => {
      await grantPassiveEventRuntimePrivileges(database);
      const projectId = await createProject(database, "Passive crash project");
      const machineId = await createMachine(database, "Passive crash machine");
      await database.migrator.query({
        text: `CREATE TABLE public.passive_event_effects(
                 event_id uuid PRIMARY KEY,
                 machine_id uuid NOT NULL
               );
               REVOKE ALL ON public.passive_event_effects FROM PUBLIC;
               GRANT INSERT, SELECT ON public.passive_event_effects
               TO lcm_test_runtime`,
      }, { domain: "passive-events", operation: "createCrashEffects" });
      const directory = mkdtempSync(join(tmpdir(), "lcm-passive-crash-"));
      try {
        for (const [index, crashPoint] of CRASH_POINTS.entries()) {
          const outboxPath = join(directory, `events-${index}.db`);
          const seedFactory = new SQLiteLocalHookOutboxFactory();
          const seed = await seedFactory.open(outboxPath);
          await insertLocalEvents(seed, crashPoint, 1);
          await seedFactory.close();
          clearCapturedMachineIdentity(outboxPath);

          await runCrashFixture(database, {
            crashPoint,
            projectId,
            machineId,
            outboxPath,
            processId: `crash-${index}`,
          });

          const recoveryFactory = new SQLiteLocalHookOutboxFactory();
          const local = await recoveryFactory.open(outboxPath);
          const remote = new PostgreSqlPassiveEventRepository(
            database.runtime,
            projectId,
            machineId,
          );
          const recovery = worker(local, remote, `recovery-${index}`);
          try {
            await driveUntilPruned(recovery, local, 1);
            const [row] = await local.getUnprocessed(1);
            expect(row).toMatchObject({
              delivery_state: "acknowledged",
              remote_inbox_id: expect.any(String),
              remote_pruned_at: expect.any(String),
            });
            await expect(remote.readEvent({
              machineId,
              eventId: row.event_uuid,
            })).resolves.toBeNull();
            const effect = await database.migrator.query<{ count: string }>({
              text: `SELECT COUNT(*)::pg_catalog.text AS count
                     FROM public.passive_event_effects
                     WHERE event_id = $1`,
              values: [row.event_uuid],
            }, {
              domain: "passive-events",
              operation: "verifyCrashHandoffEffect",
            });
            expect(effect.rows[0].count).toBe("1");
          } finally {
            await recoveryFactory.close();
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
