import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PostgreSqlPassiveEventRepository,
} from "../../src/storage/postgresql/passive-event-repository.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const MAX_POSTGRESQL_BIGINT = 9_223_372_036_854_775_807n;

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
    operation: "grantPassiveEventRuntimePrivileges",
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
  }, { domain: "passive-events", operation: "createPassiveEventProject" });
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
  }, { domain: "passive-events", operation: "createPassiveEventMachine" });
  return result.rows[0].machine_id;
}

function input(
  machineId: string,
  eventId: string,
  machineSequence: bigint,
  data: string,
) {
  return {
    machineId,
    eventId,
    eventVersion: 1,
    machineSequence,
    eventType: "choice",
    payload: {
      sessionId: "session",
      sessionSequence: Number(machineSequence % 100n),
      category: "decision",
      data,
      priority: 1,
      sourceHook: "PostToolUse",
      previousEventId: null,
      createdAt: "2026-07-29 12:00:00",
    },
  } as const;
}

describe("PostgreSQL 18 passive-event repository", () => {
  it("inserts exact-bigint envelopes idempotently and fails closed on collisions", async () => {
    await withPostgreSqlTestDatabase("passive-insert", async (database) => {
      await grantPassiveEventRuntimePrivileges(database);
      const projectId = await createProject(database, "Passive insert project");
      const otherProjectId = await createProject(database, "Passive insert other project");
      const machineId = await createMachine(database, "Passive insert machine");
      const eventId = "12345678-1234-4abc-8def-123456789abc";
      const repository = new PostgreSqlPassiveEventRepository(
        database.runtime,
        projectId,
        machineId,
      );
      const envelope = input(
        machineId,
        eventId,
        MAX_POSTGRESQL_BIGINT,
        "SQLite",
      );

      const [inserted] = await repository.insertEvents([envelope]);
      expect(inserted).toMatchObject({
        projectId,
        machineId,
        eventId,
        machineSequence: MAX_POSTGRESQL_BIGINT,
        status: "pending",
      });
      const [duplicate] = await repository.insertEvents([envelope]);
      expect(duplicate.inboxId).toBe(inserted.inboxId);
      await expect(repository.insertEvents([{
        ...envelope,
        payload: { ...envelope.payload, data: "PostgreSQL" },
      }])).rejects.toMatchObject({
        name: "PostgreSqlPassiveEventDataError",
        field: "idempotency_collision",
        eventId,
      });
      await expect(repository.insertEvents([
        input(
          machineId,
          "87654321-4321-5abc-8def-123456789abc",
          MAX_POSTGRESQL_BIGINT,
          "sequence collision",
        ),
      ])).rejects.toMatchObject({
        name: "PostgreSqlPassiveEventDataError",
        field: "idempotency_readback",
      });

      const otherProject = new PostgreSqlPassiveEventRepository(
        database.runtime,
        otherProjectId,
        machineId,
      );
      await expect(otherProject.readEvent({ machineId, eventId }))
        .resolves.toBeNull();
    });
  });

  it("commits an effect with applied, rolls failures back, and transitions exact claims", async () => {
    await withPostgreSqlTestDatabase("passive-complete", async (database) => {
      await grantPassiveEventRuntimePrivileges(database);
      const projectId = await createProject(database, "Passive complete project");
      const firstMachine = await createMachine(database, "Passive complete machine A");
      const secondMachine = await createMachine(database, "Passive complete machine B");
      await database.migrator.query({
        text: `CREATE TABLE public.passive_event_effects(
                 event_id uuid PRIMARY KEY,
                 payload jsonb NOT NULL
               );
               REVOKE ALL ON public.passive_event_effects FROM PUBLIC;
               GRANT INSERT, SELECT ON public.passive_event_effects
               TO lcm_test_runtime`,
      }, { domain: "passive-events", operation: "createPassiveEventEffects" });
      const repository = new PostgreSqlPassiveEventRepository(
        database.runtime,
        projectId,
        firstMachine,
      );
      const firstId = "12345678-1234-4abc-8def-123456789abc";
      const secondId = "87654321-4321-5abc-8def-123456789abc";
      const otherId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      await repository.insertEvents([
        input(firstMachine, firstId, 1n, "first"),
        input(firstMachine, secondId, 2n, "second"),
      ]);
      await new PostgreSqlPassiveEventRepository(
        database.runtime,
        projectId,
        secondMachine,
      ).insertEvents([
        input(secondMachine, otherId, 1n, "other machine"),
      ]);
      const lease = await repository.acquireDrainLease("worker", 30_000);
      expect(lease).not.toBeNull();
      const claims = await repository.claimEvents({
        claimOwner: `worker:${lease!.fencingToken.toString()}`,
        limit: 10,
        staleClaimMs: 1_000,
      });
      expect(claims.map(({ machineId, machineSequence }) => ({
        machineId,
        machineSequence,
      }))).toEqual([
        { machineId: firstMachine, machineSequence: 1n },
        { machineId: secondMachine, machineSequence: 1n },
      ]);

      const firstClaim = claims.find(({ machineId }) => machineId === firstMachine)!;
      await expect(repository.completeApplied({
        claim: firstClaim,
        processId: "worker",
        fencingToken: lease!.fencingToken,
      }, async (transaction, claimed) => {
        await transaction.query({
          text: `INSERT INTO public.passive_event_effects(event_id, payload)
                 VALUES($1, $2::pg_catalog.jsonb)`,
          values: [claimed.eventId, JSON.stringify(claimed.payload)],
        }, {
          domain: "passive-events",
          operation: "applyPassiveEventEffect",
          projectId,
          machineId: firstMachine,
        });
        return "committed";
      })).resolves.toMatchObject({
        result: "committed",
        event: { status: "applied", eventId: firstId },
      });
      const effect = await database.migrator.query<{ count: string }>({
        text: `SELECT COUNT(*)::pg_catalog.text AS count
               FROM public.passive_event_effects
               WHERE event_id = $1`,
        values: [firstId],
      }, { domain: "passive-events", operation: "verifyPassiveEventEffect" });
      expect(effect.rows[0].count).toBe("1");

      const otherClaim = claims.find(({ machineId }) => machineId === secondMachine)!;
      await repository.quarantine({
        claim: otherClaim,
        processId: "worker",
        fencingToken: lease!.fencingToken,
        reason: "poison",
      });

      const [secondClaim] = await repository.claimEvents({
        claimOwner: `worker:${lease!.fencingToken.toString()}`,
        limit: 10,
        staleClaimMs: 1_000,
      });
      expect(secondClaim.eventId).toBe(secondId);
      await expect(repository.completeApplied({
        claim: secondClaim,
        processId: "worker",
        fencingToken: lease!.fencingToken,
      }, async (transaction, claimed) => {
        await transaction.query({
          text: `INSERT INTO public.passive_event_effects(event_id, payload)
                 VALUES($1, $2::pg_catalog.jsonb)`,
          values: [claimed.eventId, JSON.stringify(claimed.payload)],
        }, {
          domain: "passive-events",
          operation: "applyThenRejectPassiveEvent",
          projectId,
          machineId: firstMachine,
        });
        throw new Error("injected apply failure");
      })).rejects.toBeDefined();
      const rolledBack = await database.migrator.query<{
        effect_count: string;
        status: string;
      }>({
        text: `SELECT
                 (
                   SELECT COUNT(*)::pg_catalog.text
                   FROM public.passive_event_effects
                   WHERE event_id = $2
                 ) AS effect_count,
                 status
               FROM lcm.passive_event_inbox
               WHERE project_id = $1
                 AND event_id = $2`,
        values: [projectId, secondId],
      }, { domain: "passive-events", operation: "verifyPassiveEventRollback" });
      expect(rolledBack.rows[0]).toEqual({
        effect_count: "0",
        status: "claimed",
      });
      await expect(repository.scheduleRetry({
        claim: secondClaim,
        processId: "worker",
        fencingToken: lease!.fencingToken,
        delayMs: 1,
      })).resolves.toMatchObject({ status: "retry" });
      await expect(repository.replayQuarantined({
        machineId: secondMachine,
        eventId: otherId,
      })).resolves.toMatchObject({ status: "pending" });
      await repository.releaseDrainLease("worker", lease!.fencingToken);
    });
  });

  it("prunes only exact applied rows and preserves nonterminal, quarantined, and foreign rows", async () => {
    await withPostgreSqlTestDatabase("passive-prune", async (database) => {
      await grantPassiveEventRuntimePrivileges(database);
      const projectId = await createProject(database, "Passive prune project");
      const foreignProjectId = await createProject(database, "Passive prune foreign project");
      const machineId = await createMachine(database, "Passive prune machine");
      const foreignMachineId = await createMachine(database, "Passive prune foreign machine");
      const repository = new PostgreSqlPassiveEventRepository(
        database.runtime,
        projectId,
        machineId,
      );
      const ids = {
        applied: "11111111-1111-4111-8111-111111111111",
        pending: "22222222-2222-4222-8222-222222222222",
        retry: "33333333-3333-4333-8333-333333333333",
        quarantined: "44444444-4444-4444-8444-444444444444",
        foreign: "55555555-5555-4555-8555-555555555555",
      } as const;
      const own = await repository.insertEvents([
        input(machineId, ids.applied, 1n, "applied"),
        input(machineId, ids.pending, 2n, "pending"),
        input(machineId, ids.retry, 3n, "retry"),
        input(machineId, ids.quarantined, 4n, "quarantined"),
      ]);
      const [foreign] = await new PostgreSqlPassiveEventRepository(
        database.runtime,
        foreignProjectId,
        foreignMachineId,
      ).insertEvents([
        input(foreignMachineId, ids.foreign, 1n, "foreign"),
      ]);
      await database.migrator.query({
        text: `UPDATE lcm.passive_event_inbox
               SET status = CASE event_id
                     WHEN $2::pg_catalog.uuid THEN 'applied'
                     WHEN $3::pg_catalog.uuid THEN 'retry'
                     WHEN $4::pg_catalog.uuid THEN 'quarantined'
                     ELSE status
                   END,
                   applied_at = CASE
                     WHEN event_id = $2 THEN pg_catalog.statement_timestamp()
                     ELSE NULL
                   END,
                   next_attempt_at = CASE
                     WHEN event_id = $3
                       THEN pg_catalog.statement_timestamp() + interval '1 minute'
                     ELSE next_attempt_at
                   END,
                   quarantined_at = CASE
                     WHEN event_id = $4 THEN pg_catalog.statement_timestamp()
                     ELSE NULL
                   END,
                   quarantine_reason = CASE
                     WHEN event_id = $4 THEN 'poison'
                     ELSE NULL
                   END
               WHERE project_id = $1`,
        values: [
          projectId,
          ids.applied,
          ids.retry,
          ids.quarantined,
        ],
      }, { domain: "passive-events", operation: "seedPassiveEventPruneStates" });
      await database.migrator.query({
        text: `UPDATE lcm.passive_event_inbox
               SET status = 'applied',
                   applied_at = pg_catalog.statement_timestamp()
               WHERE project_id = $1
                 AND event_id = $2`,
        values: [foreignProjectId, ids.foreign],
      }, { domain: "passive-events", operation: "seedForeignAppliedEvent" });

      const byId = new Map(own.map((event) => [event.eventId, event]));
      await expect(repository.pruneApplied([
        {
          machineId,
          eventId: ids.applied,
          inboxId: byId.get(ids.applied)!.inboxId,
        },
        {
          machineId,
          eventId: ids.pending,
          inboxId: byId.get(ids.pending)!.inboxId,
        },
        {
          machineId,
          eventId: ids.retry,
          inboxId: byId.get(ids.retry)!.inboxId,
        },
        {
          machineId,
          eventId: ids.quarantined,
          inboxId: byId.get(ids.quarantined)!.inboxId,
        },
        {
          machineId: foreignMachineId,
          eventId: ids.foreign,
          inboxId: foreign.inboxId,
        },
      ])).resolves.toBe(1n);

      const remaining = await database.migrator.query<{
        project_id: string;
        event_id: string;
        status: string;
      }>({
        text: `SELECT project_id, event_id, status
               FROM lcm.passive_event_inbox
               ORDER BY project_id, event_id`,
      }, { domain: "passive-events", operation: "verifyExactPassiveEventPrune" });
      expect(remaining.rows).toEqual(expect.arrayContaining([
        { project_id: projectId, event_id: ids.pending, status: "pending" },
        { project_id: projectId, event_id: ids.retry, status: "retry" },
        { project_id: projectId, event_id: ids.quarantined, status: "quarantined" },
        { project_id: foreignProjectId, event_id: ids.foreign, status: "applied" },
      ]));
      expect(remaining.rows.some(({ event_id }) => event_id === ids.applied))
        .toBe(false);
    });
  });
});
