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
    join(
      process.cwd(),
      "src/storage/postgresql/reference/postgresql-runtime-coordination-grants.sql",
    ),
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
  batchSize = 2,
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
    batchSize,
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

  it("applies a machine's whole ready backlog in a single pass (#1530)", async () => {
    await withPostgreSqlTestDatabase("passive-single-pass", async (database) => {
      await grantPassiveEventRuntimePrivileges(database);
      const projectId = await createProject(database, "Passive single pass project");
      const machineId = await createMachine(database, "Passive single pass machine");
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
      }, { domain: "passive-events", operation: "createSinglePassEffects" });
      const directory = mkdtempSync(join(tmpdir(), "lcm-passive-single-pass-"));
      const factory = new SQLiteLocalHookOutboxFactory();
      try {
        const path = join(directory, "events.db");
        const local = await factory.open(path);
        await insertLocalEvents(local, "pass", 4);
        clearCapturedMachineIdentity(path);
        const remote = new PostgreSqlPassiveEventRepository(
          database.runtime,
          projectId,
          machineId,
        );
        // The real prune deletes applied inbox rows, so the status that each
        // row had when it was pruned is the only proof of the applied state.
        const prunedStatuses: string[] = [];
        const prune = remote.pruneApplied.bind(remote);
        remote.pruneApplied = async (keys, signal) => {
          const records = await remote.readEvents(
            keys.map((key) => ({ machineId: key.machineId, eventId: key.eventId })),
            signal,
          );
          prunedStatuses.push(...records.map((record) => record.status));
          return prune(keys, signal);
        };

        // One run only: a driver that repeats runs would hide the defect.
        const result = await worker(local, remote, "replication-single", 10).runOnce();

        expect(result).toMatchObject({
          uploaded: 4,
          applied: 4,
          acknowledged: 4,
          pruned: 4,
        });
        expect(prunedStatuses).toEqual(["applied", "applied", "applied", "applied"]);
        const rows = await local.getUnprocessed(500);
        expect(rows).toHaveLength(4);
        expect(rows.every((row) =>
          row.delivery_state === "acknowledged" && row.remote_pruned_at !== null))
          .toBe(true);
        const effects = await database.migrator.query<{ data: string }>({
          text: `SELECT inbox.payload->>'data' AS data
                 FROM public.passive_event_effects AS effect
                 JOIN (
                   SELECT event_id, payload
                   FROM jsonb_to_recordset($1::pg_catalog.jsonb)
                     AS input(event_id uuid, payload jsonb)
                 ) AS inbox ON inbox.event_id = effect.event_id
                 ORDER BY effect.effect_id`,
          values: [JSON.stringify(rows.map((row) => ({
            event_id: row.event_uuid,
            payload: { data: row.data },
          })))],
        }, { domain: "passive-events", operation: "verifySinglePassOrder" });
        expect(effects.rows.map((row) => row.data))
          .toEqual(Array.from({ length: 4 }, (_, index) => `pass-${String(index)}`));
        const inbox = await database.migrator.query<{ remaining: string }>({
          text: `SELECT count(*)::pg_catalog.text AS remaining
                 FROM lcm.passive_event_inbox WHERE project_id = $1`,
          values: [projectId],
        }, { domain: "passive-events", operation: "verifySinglePassInbox" });
        expect(inbox.rows[0].remaining).toBe("0");
      } finally {
        await Promise.allSettled([factory.close()]);
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

  it("moves rows that still await a previous project to the new one after a relink", async () => {
    await withPostgreSqlTestDatabase("passive-relink", async (database) => {
      await grantPassiveEventRuntimePrivileges(database);
      const oldProjectId = await createProject(database, "Passive relink old project");
      const newProjectId = await createProject(database, "Passive relink new project");
      const machineId = await createMachine(database, "Passive relink machine");
      await database.migrator.query({
        text: `CREATE TABLE public.passive_event_effects(
                 event_id uuid PRIMARY KEY,
                 machine_id uuid NOT NULL
               );
               REVOKE ALL ON public.passive_event_effects FROM PUBLIC;
               GRANT INSERT, SELECT ON public.passive_event_effects
               TO lcm_test_runtime`,
      }, { domain: "passive-events", operation: "createRelinkEffects" });
      const inboxRows = async (projectId: string): Promise<number> => {
        const result = await database.migrator.query<{ count: string }>({
          text: `SELECT COUNT(*)::pg_catalog.text AS count
                 FROM lcm.passive_event_inbox WHERE project_id = $1`,
          values: [projectId],
        }, { domain: "passive-events", operation: "countRelinkInbox" });
        return Number(result.rows[0].count);
      };
      const directory = mkdtempSync(join(tmpdir(), "lcm-passive-relink-"));
      const factory = new SQLiteLocalHookOutboxFactory();
      try {
        const path = join(directory, "events.db");
        const local = await factory.open(path);
        await insertLocalEvents(local, "relink", 3);
        clearCapturedMachineIdentity(path);
        const oldRemote = new PostgreSqlPassiveEventRepository(
          database.runtime,
          oldProjectId,
          machineId,
        );
        const newRemote = new PostgreSqlPassiveEventRepository(
          database.runtime,
          newProjectId,
          machineId,
        );

        // The previous project receives every row and never applies any.
        const abandoned = new Proxy(oldRemote, {
          get: (target, property) => {
            if (property === "claimEvents") return async () => [];
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const beforeRelink = worker(local, abandoned, "replication-old");
        await beforeRelink.runOnce();
        await beforeRelink.runOnce();
        expect((await local.getUnprocessed(500)).map((row) => row.delivery_state))
          .toEqual(["replicated", "replicated", "replicated"]);
        expect(await inboxRows(oldProjectId)).toBe(3);

        // The relinked pass withdraws two copies and crashes before the local
        // transition: the rows stay replicated and absent from every project.
        const crashing = new Proxy(local, {
          get: (target, property) => {
            if (property === "requeueReplicated") {
              return async () => { throw new Error("injected crash before requeue"); };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        await expect(worker(crashing, newRemote, "replication-new").runOnce())
          .rejects.toThrow("injected crash before requeue");
        expect(await inboxRows(oldProjectId)).toBe(1);
        expect((await local.getUnprocessed(500)).map((row) => row.delivery_state))
          .toEqual(["replicated", "replicated", "replicated"]);

        // A later pass re-queues what is absent everywhere, withdraws the
        // last copy, and delivers all rows to the new project.
        await driveUntilPruned(worker(local, newRemote, "replication-new"), local, 3);
        expect(await inboxRows(oldProjectId)).toBe(0);
        expect(await inboxRows(newProjectId)).toBe(0);
        const effects = await database.migrator.query<{ count: string }>({
          text: "SELECT COUNT(*)::pg_catalog.text AS count FROM public.passive_event_effects",
        }, { domain: "passive-events", operation: "countRelinkEffects" });
        expect(effects.rows[0].count).toBe("3");
      } finally {
        await factory.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("delivers pending events copied by a cutover exactly once (#1693)", async () => {
    await withPostgreSqlTestDatabase("passive-cutover-copy", async (database) => {
      await grantPassiveEventRuntimePrivileges(database);
      const projectId = await createProject(database, "Passive cutover project");
      const machineId = await createMachine(database, "Passive cutover machine");
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
      }, { domain: "passive-events", operation: "createCutoverEffects" });
      const directory = mkdtempSync(join(tmpdir(), "lcm-passive-cutover-"));
      const factory = new SQLiteLocalHookOutboxFactory();
      try {
        const path = join(directory, "events.db");
        const local = await factory.open(path);
        await insertLocalEvents(local, "cutover", 3);
        const [plain, chained, fresh] = await local.getUnprocessed(500);
        // The second event carries a machine-local previous event id, as
        // promote-events leaves on a pending row that never attempted delivery.
        await local.setPrevEventId(chained.event_id, plain.event_id);
        clearCapturedMachineIdentity(path);

        // The migration copy writes these two inbox rows in the portable
        // envelope: an ISO createdAt and no previousEventId.
        const copied = new Map<string, string>();
        for (const row of [plain, chained]) {
          const createdAt = `${row.created_at.replace(" ", "T")}.000000Z`;
          const inserted = await database.migrator.query<{ inbox_id: string }>({
            text: `INSERT INTO lcm.passive_event_inbox(
                     project_id, machine_id, event_id, event_version,
                     machine_sequence, event_type, payload, status,
                     received_at, next_attempt_at
                   ) VALUES($1, $2, $3, $4, $5::pg_catalog.int8, $6,
                            $7::pg_catalog.jsonb, 'pending',
                            $8::pg_catalog.timestamptz, $8::pg_catalog.timestamptz)
                   RETURNING inbox_id::pg_catalog.text`,
            values: [
              projectId,
              machineId,
              row.event_uuid,
              row.event_version,
              row.machine_sequence,
              row.type,
              JSON.stringify({
                sessionId: row.session_id,
                category: row.category,
                data: row.data,
                sourceHook: row.source_hook,
                createdAt,
                sessionSequence: row.seq,
                priority: row.priority,
              }),
              createdAt,
            ],
          }, { domain: "passive-events", operation: "copyCutoverInboxRow" });
          copied.set(row.event_uuid, inserted.rows[0].inbox_id);
        }
        expect(plain.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);

        const remote = new PostgreSqlPassiveEventRepository(
          database.runtime,
          projectId,
          machineId,
        );
        // The real prune deletes applied inbox rows, so the rows seen at
        // prune time prove which inbox row served each event.
        const pruned: Array<{ eventId: string; inboxId: string; createdAt: unknown }> = [];
        const prune = remote.pruneApplied.bind(remote);
        remote.pruneApplied = async (keys, signal) => {
          const records = await remote.readEvents(
            keys.map((key) => ({ machineId: key.machineId, eventId: key.eventId })),
            signal,
          );
          pruned.push(...records.map((record) => ({
            eventId: record.eventId,
            inboxId: record.inboxId.toString(),
            createdAt: record.payload.createdAt,
          })));
          return prune(keys, signal);
        };

        const result = await worker(local, remote, "replication-cutover", 10).runOnce();

        expect(result).toMatchObject({
          uploaded: 3,
          retried: 0,
          quarantined: 0,
          applied: 3,
          acknowledged: 3,
          pruned: 3,
        });
        const rows = await local.getUnprocessed(500);
        expect(rows).toHaveLength(3);
        expect(rows.every((row) =>
          row.delivery_state === "acknowledged" && row.remote_pruned_at !== null))
          .toBe(true);
        // Each event was served by exactly one inbox row, and the copied rows
        // kept the inbox ids and portable payload the migration gave them.
        expect(pruned).toHaveLength(3);
        for (const row of [plain, chained]) {
          expect(pruned.filter((entry) => entry.eventId === row.event_uuid)).toEqual([{
            eventId: row.event_uuid,
            inboxId: copied.get(row.event_uuid),
            createdAt: `${row.created_at.replace(" ", "T")}.000000Z`,
          }]);
        }
        expect(pruned.filter((entry) => entry.eventId === fresh.event_uuid))
          .toHaveLength(1);
        const effects = await database.migrator.query<{ event_id: string }>({
          text: "SELECT event_id::pg_catalog.text AS event_id FROM public.passive_event_effects",
        }, { domain: "passive-events", operation: "countCutoverEffects" });
        expect(effects.rows.map((row) => row.event_id).sort()).toEqual(
          [plain, chained, fresh].map((row) => row.event_uuid).sort(),
        );
        const remaining = await database.migrator.query<{ count: string }>({
          text: "SELECT COUNT(*)::pg_catalog.text AS count FROM lcm.passive_event_inbox",
        }, { domain: "passive-events", operation: "countCutoverInbox" });
        expect(remaining.rows[0].count).toBe("0");
      } finally {
        await factory.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
