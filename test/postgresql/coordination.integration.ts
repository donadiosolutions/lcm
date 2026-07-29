import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PostgreSqlCoordinationRepository,
} from "../../src/storage/postgresql/memory-repositories.js";
import { runPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  settings,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

interface CoordinationScope {
  readonly projectId: string;
  readonly machineIds: readonly [string, string, string, string];
}

interface CrashFixtureReady {
  readonly type: "ready";
  readonly fencingToken: string;
}

async function grantCoordinationRuntimePrivileges(
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
    domain: "coordination",
    operation: "grantCoordinationRuntimePrivileges",
  });
}

async function createProject(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<string> {
  const result = await database.migrator.query<{ project_id: string }>({
    text: `INSERT INTO lcm.projects (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING project_id`,
    values: [createHash("sha256").update(label).digest("hex"), label],
  }, { domain: "identity", operation: "createCoordinationTestProject" });
  return result.rows[0].project_id;
}

async function createMachine(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<string> {
  const result = await database.migrator.query<{ machine_id: string }>({
    text: `INSERT INTO lcm.machines (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING machine_id`,
    values: [
      `machine:${createHash("sha256").update(label).digest("hex")}`,
      label,
    ],
  }, { domain: "identity", operation: "createCoordinationTestMachine" });
  return result.rows[0].machine_id;
}

async function createScope(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<CoordinationScope> {
  return {
    projectId: await createProject(database, label),
    machineIds: [
      await createMachine(database, `${label} machine A`),
      await createMachine(database, `${label} machine B`),
      await createMachine(database, `${label} machine C`),
      await createMachine(database, `${label} machine D`),
    ],
  };
}

async function seedPassiveEvent(
  database: PostgreSqlTestDatabase,
  input: {
    readonly projectId: string;
    readonly machineId: string;
    readonly machineSequence: bigint;
    readonly status?: "pending" | "retry";
    readonly ready?: boolean;
  },
): Promise<bigint> {
  const ready = input.ready ?? true;
  const result = await database.migrator.query<{ inbox_id: string }>({
    text: `INSERT INTO lcm.passive_event_inbox (
             project_id, machine_id, event_id, event_version,
             machine_sequence, event_type, payload, status,
             received_at, next_attempt_at
           )
           VALUES (
             $1, $2, uuidv7(), 1, $3::pg_catalog.int8,
             'coordination-test', '{"scrubbed":true}'::pg_catalog.jsonb,
             $4,
             pg_catalog.statement_timestamp() - interval '2 minutes',
             pg_catalog.statement_timestamp()
               + CASE WHEN $5 THEN interval '-1 minute'
                      ELSE interval '1 minute' END
           )
           RETURNING inbox_id::pg_catalog.text`,
    values: [
      input.projectId,
      input.machineId,
      input.machineSequence.toString(),
      input.status ?? "pending",
      ready,
    ],
  }, { domain: "coordination", operation: "seedPassiveEvent" });
  return BigInt(result.rows[0].inbox_id);
}

async function applyClaimedEvents(
  database: PostgreSqlTestDatabase,
  inboxIds: readonly bigint[],
): Promise<void> {
  await database.migrator.query({
    text: `UPDATE lcm.passive_event_inbox
           SET status = 'applied',
               claimed_at = NULL,
               claimed_by = NULL,
               applied_at = GREATEST(
                 pg_catalog.statement_timestamp(),
                 received_at
               )
           WHERE inbox_id = ANY($1::pg_catalog.int8[])`,
    values: [inboxIds.map(String)],
  }, { domain: "coordination", operation: "applyClaimedEvents" });
}

function runtime(database: PostgreSqlTestDatabase): PostgreSqlRuntime {
  return new PostgreSqlRuntime(settings(database.runtimeUrl));
}

async function waitForCrashFixture(
  child: ChildProcess,
): Promise<CrashFixtureReady> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("coordination crash fixture readiness timed out"));
    }, 5_000);
    const settle = (callback: () => void): void => {
      clearTimeout(timeout);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      callback();
    };
    child.once("message", (message: unknown) => {
      if (
        typeof message === "object"
        && message !== null
        && "type" in message
        && message.type === "ready"
        && "fencingToken" in message
        && typeof message.fencingToken === "string"
      ) {
        settle(() => resolve(message as unknown as CrashFixtureReady));
      } else {
        settle(() => reject(new Error(
          "coordination crash fixture failed before readiness",
        )));
      }
    });
    child.once("error", () => {
      settle(() => reject(new Error("coordination crash fixture failed")));
    });
    child.once("exit", () => {
      settle(() => reject(new Error(
        "coordination crash fixture exited before readiness",
      )));
    });
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

describe("PostgreSQL 18 cross-machine coordination", () => {
  it("admits only the reviewed least-privilege coordination grants", async () => {
    await withPostgreSqlTestDatabase("coord-grants", async (database) => {
      const scope = await createScope(database, "Coordination grants");
      const repository = new PostgreSqlCoordinationRepository(
        database.runtime,
        scope.projectId,
        scope.machineIds[0],
      );
      await expect(repository.getCoordinationDiagnostics()).rejects
        .toMatchObject({
          backend: "postgresql",
          domain: "coordination",
          operation: "getCoordinationDiagnostics",
          projectId: scope.projectId,
        });

      await grantCoordinationRuntimePrivileges(database);
      await expect(repository.acquireLease({
        resourceType: "grant-check",
        resourceKey: "one",
        processId: "worker",
        operation: "inspect",
        ttlMs: 1_000,
      })).resolves.toMatchObject({ fencingToken: expect.any(BigInt) });

      const privileges = await database.migrator.query<{
        schema_usage: boolean;
        schema_create: boolean;
        lease_select: boolean;
        lease_delete: boolean;
        lease_insert: boolean;
        lease_project_insert: boolean;
        lease_acquired_insert: boolean;
        lease_update: boolean;
        lease_token_update: boolean;
        lease_project_update: boolean;
        lease_truncate: boolean;
        lease_sequence_usage: boolean;
        lease_sequence_select: boolean;
        inbox_select: boolean;
        inbox_delete: boolean;
        inbox_insert: boolean;
        inbox_update: boolean;
        inbox_status_update: boolean;
        inbox_payload_update: boolean;
        inbox_truncate: boolean;
        inbox_sequence_usage: boolean;
      }>({
        text: `SELECT
                 has_schema_privilege(
                   'lcm_test_runtime', 'lcm', 'USAGE'
                 ) AS schema_usage,
                 has_schema_privilege(
                   'lcm_test_runtime', 'lcm', 'CREATE'
                 ) AS schema_create,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.fenced_leases', 'SELECT'
                 ) AS lease_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.fenced_leases', 'DELETE'
                 ) AS lease_delete,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.fenced_leases', 'INSERT'
                 ) AS lease_insert,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.fenced_leases',
                   'project_id', 'INSERT'
                 ) AS lease_project_insert,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.fenced_leases',
                   'acquired_at', 'INSERT'
                 ) AS lease_acquired_insert,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.fenced_leases', 'UPDATE'
                 ) AS lease_update,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.fenced_leases',
                   'fencing_token', 'UPDATE'
                 ) AS lease_token_update,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.fenced_leases',
                   'project_id', 'UPDATE'
                 ) AS lease_project_update,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.fenced_leases', 'TRUNCATE'
                 ) AS lease_truncate,
                 has_sequence_privilege(
                   'lcm_test_runtime',
                   'lcm.fenced_leases_fencing_token_seq',
                   'USAGE'
                 ) AS lease_sequence_usage,
                 has_sequence_privilege(
                   'lcm_test_runtime',
                   'lcm.fenced_leases_fencing_token_seq',
                   'SELECT'
                 ) AS lease_sequence_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.passive_event_inbox', 'SELECT'
                 ) AS inbox_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.passive_event_inbox', 'DELETE'
                 ) AS inbox_delete,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.passive_event_inbox', 'INSERT'
                 ) AS inbox_insert,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.passive_event_inbox', 'UPDATE'
                 ) AS inbox_update,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.passive_event_inbox',
                   'status', 'UPDATE'
                 ) AS inbox_status_update,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.passive_event_inbox',
                   'payload', 'UPDATE'
                 ) AS inbox_payload_update,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.passive_event_inbox', 'TRUNCATE'
                 ) AS inbox_truncate,
                 has_sequence_privilege(
                   'lcm_test_runtime',
                   'lcm.passive_event_inbox_inbox_id_seq',
                   'USAGE'
                 ) AS inbox_sequence_usage`,
      }, { domain: "coordination", operation: "inspectCoordinationGrants" });
      expect(privileges.rows[0]).toEqual({
        schema_usage: true,
        schema_create: false,
        lease_select: true,
        lease_delete: true,
        lease_insert: false,
        lease_project_insert: true,
        lease_acquired_insert: false,
        lease_update: false,
        lease_token_update: true,
        lease_project_update: false,
        lease_truncate: false,
        lease_sequence_usage: true,
        lease_sequence_select: false,
        inbox_select: true,
        inbox_delete: false,
        inbox_insert: false,
        inbox_update: false,
        inbox_status_update: true,
        inbox_payload_update: false,
        inbox_truncate: false,
        inbox_sequence_usage: false,
      });
      await expect(runPostgreSqlMigrations(database.migrator)).resolves
        .toMatchObject({ applied: [] });
    });
  });

  it("releases transaction locks on crash and bounds cancellation and timeout", async () => {
    await withPostgreSqlTestDatabase("coord-crash", async (database) => {
      await grantCoordinationRuntimePrivileges(database);
      const scope = await createScope(database, "Coordination crash");
      const otherProjectId = await createProject(
        database,
        "Coordination crash unrelated project",
      );
      const contender = runtime(database);
      const child = fork(
        join(
          process.cwd(),
          "test",
          "postgresql",
          "fixtures",
          "coordination-crash-worker.mjs",
        ),
        [],
        {
          env: {
            ...process.env,
            LCM_COORDINATION_FIXTURE_URL: database.runtimeUrl,
            LCM_COORDINATION_FIXTURE_PROJECT_ID: scope.projectId,
            LCM_COORDINATION_FIXTURE_MACHINE_ID: scope.machineIds[0],
            LCM_COORDINATION_FIXTURE_RESOURCE_KEY: "shared-resource",
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      try {
        const ready = await waitForCrashFixture(child);
        const repository = new PostgreSqlCoordinationRepository(
          contender,
          scope.projectId,
          scope.machineIds[1],
        );
        const abort = new AbortController();
        const cancelled = contender.transaction(async (transaction) => {
          const scoped = new PostgreSqlCoordinationRepository(
            transaction,
            scope.projectId,
            scope.machineIds[1],
          );
          await scoped.acquireTransactionLock({
            resourceType: "crash-fixture",
            resourceKey: "shared-resource",
            operation: "cancelled-contender",
            timeoutMs: 4_000,
            signal: abort.signal,
          });
        }, {
          domain: "coordination",
          operation: "cancelledContender",
          projectId: scope.projectId,
          signal: abort.signal,
        });
        setTimeout(() => abort.abort(), 50);
        const cancellationError = await cancelled.catch(
          (error: unknown) => error,
        );
        expect(cancellationError).toMatchObject({
          backend: "postgresql",
          projectId: scope.projectId,
          machineId: scope.machineIds[1],
          operation: "cancelled-contender",
        });
        expect(JSON.stringify(cancellationError)).not.toContain(
          "shared-resource",
        );

        await expect(contender.transaction(async (transaction) => {
          const scoped = new PostgreSqlCoordinationRepository(
            transaction,
            scope.projectId,
            scope.machineIds[1],
          );
          await scoped.acquireTransactionLock({
            resourceType: "crash-fixture",
            resourceKey: "shared-resource",
            operation: "timed-contender",
            timeoutMs: 100,
          });
        }, {
          domain: "coordination",
          operation: "timedContender",
          projectId: scope.projectId,
        })).rejects.toMatchObject({
          backend: "postgresql",
          projectId: scope.projectId,
          machineId: scope.machineIds[1],
          operation: "timed-contender",
        });

        await expect(contender.transaction(async (transaction) => {
          const unrelated = new PostgreSqlCoordinationRepository(
            transaction,
            otherProjectId,
            scope.machineIds[1],
          );
          await unrelated.acquireTransactionLock({
            resourceType: "crash-fixture",
            resourceKey: "shared-resource",
            operation: "unrelated-project",
            timeoutMs: 100,
          });
        }, {
          domain: "coordination",
          operation: "unrelatedProject",
          projectId: otherProjectId,
        })).resolves.toBeUndefined();

        await expect(repository.acquireLease({
          resourceType: "crash-fixture",
          resourceKey: "shared-resource",
          processId: "successor",
          operation: "coordinate",
          ttlMs: 1_000,
        })).resolves.toBeNull();

        await terminateChild(child);
        await expect(contender.transaction(async (transaction) => {
          const scoped = new PostgreSqlCoordinationRepository(
            transaction,
            scope.projectId,
            scope.machineIds[1],
          );
          await scoped.acquireTransactionLock({
            resourceType: "crash-fixture",
            resourceKey: "shared-resource",
            operation: "post-crash",
            timeoutMs: 250,
          });
        }, {
          domain: "coordination",
          operation: "postCrash",
          projectId: scope.projectId,
        })).resolves.toBeUndefined();

        await database.migrator.query({
          text: "SELECT pg_catalog.pg_sleep(1.25)",
        }, { domain: "coordination", operation: "waitForLeaseExpiry" });
        const successor = await repository.acquireLease({
          resourceType: "crash-fixture",
          resourceKey: "shared-resource",
          processId: "successor",
          operation: "coordinate",
          ttlMs: 1_000,
        });
        expect(successor?.fencingToken).toBeGreaterThan(
          BigInt(ready.fencingToken),
        );

        const retainedLocks = await database.migrator.query<{ count: string }>({
          text: `SELECT COUNT(*)::pg_catalog.text AS count
                 FROM pg_catalog.pg_locks AS lock
                 WHERE lock.locktype = 'advisory'
                   AND lock.database = (
                     SELECT oid
                     FROM pg_catalog.pg_database
                     WHERE datname = pg_catalog.current_database()
                   )`,
        }, { domain: "coordination", operation: "inspectAdvisoryLocks" });
        expect(retainedLocks.rows[0].count).toBe("0");
      } finally {
        await terminateChild(child);
        await contender.close();
      }
    });
  });

  it("fences leases through takeover, protected writes, and cleanup", async () => {
    await withPostgreSqlTestDatabase("coord-leases", async (database) => {
      await grantCoordinationRuntimePrivileges(database);
      const scope = await createScope(database, "Coordination leases");
      const otherProjectId = await createProject(
        database,
        "Coordination leases other project",
      );
      const firstRuntime = runtime(database);
      const secondRuntime = runtime(database);
      const first = new PostgreSqlCoordinationRepository(
        firstRuntime,
        scope.projectId,
        scope.machineIds[0],
      );
      const second = new PostgreSqlCoordinationRepository(
        secondRuntime,
        scope.projectId,
        scope.machineIds[1],
      );
      try {
        const before = await database.migrator.query<{ observed_at: Date }>({
          text: "SELECT pg_catalog.clock_timestamp() AS observed_at",
        }, { domain: "coordination", operation: "leaseClockBefore" });
        const attempts = await Promise.all([
          first.acquireLease({
            resourceType: "conversation",
            resourceKey: "shared",
            processId: "first",
            operation: "compact",
            ttlMs: 1_000,
          }),
          second.acquireLease({
            resourceType: "conversation",
            resourceKey: "shared",
            processId: "second",
            operation: "compact",
            ttlMs: 1_000,
          }),
        ]);
        const after = await database.migrator.query<{ observed_at: Date }>({
          text: "SELECT pg_catalog.clock_timestamp() AS observed_at",
        }, { domain: "coordination", operation: "leaseClockAfter" });
        const winnerIndex = attempts.findIndex((lease) => lease !== null);
        expect(attempts.filter((lease) => lease !== null)).toHaveLength(1);
        const winner = attempts[winnerIndex]!;
        expect(new Date(winner.acquiredAt).getTime()).toBeGreaterThanOrEqual(
          before.rows[0].observed_at.getTime(),
        );
        expect(new Date(winner.acquiredAt).getTime()).toBeLessThanOrEqual(
          after.rows[0].observed_at.getTime(),
        );
        expect(
          new Date(winner.expiresAt).getTime()
            - new Date(winner.acquiredAt).getTime(),
        ).toBe(1_000);

        const winnerRuntime = winnerIndex === 0 ? firstRuntime : secondRuntime;
        const loserRuntime = winnerIndex === 0 ? secondRuntime : firstRuntime;
        const winnerMachineId = scope.machineIds[winnerIndex];
        const loserMachineId = scope.machineIds[winnerIndex === 0 ? 1 : 0];
        const winnerProcessId = winnerIndex === 0 ? "first" : "second";
        const loserProcessId = winnerIndex === 0 ? "second" : "first";
        const winnerRepository = winnerIndex === 0 ? first : second;
        await expect(winnerRepository.listLeases(10)).resolves.toMatchObject([
          { resourceKey: "shared", state: "active" },
        ]);
        const loser = new PostgreSqlCoordinationRepository(
          loserRuntime,
          scope.projectId,
          loserMachineId,
        );
        await winnerRuntime.close();
        await expect(loser.acquireLease({
          resourceType: "conversation",
          resourceKey: "shared",
          processId: loserProcessId,
          operation: "compact",
          ttlMs: 1_000,
        })).resolves.toBeNull();
        await database.migrator.query({
          text: "SELECT pg_catalog.pg_sleep(1.1)",
        }, { domain: "coordination", operation: "waitForTakeover" });
        await expect(loser.listLeases(10)).resolves.toMatchObject([
          { resourceKey: "shared", state: "expired" },
        ]);
        const successor = await loser.acquireLease({
          resourceType: "conversation",
          resourceKey: "shared",
          processId: loserProcessId,
          operation: "compact",
          ttlMs: 1_000,
        });
        expect(successor?.fencingToken).toBeGreaterThan(winner.fencingToken);

        const staleRuntime = runtime(database);
        const stale = new PostgreSqlCoordinationRepository(
          staleRuntime,
          scope.projectId,
          winnerMachineId,
        );
        try {
          await expect(stale.renewLease({
            resourceType: "conversation",
            resourceKey: "shared",
            processId: winnerProcessId,
            operation: "compact",
            fencingToken: winner.fencingToken,
            ttlMs: 1_000,
          })).resolves.toBeNull();
          await expect(stale.releaseLease({
            resourceType: "conversation",
            resourceKey: "shared",
            processId: winnerProcessId,
            operation: "compact",
            fencingToken: winner.fencingToken,
          })).resolves.toBeNull();

          const protectedInboxId = await seedPassiveEvent(database, {
            projectId: scope.projectId,
            machineId: scope.machineIds[2],
            machineSequence: 0n,
          });
          const externalResult = 7;
          await expect(staleRuntime.transaction(async (transaction) => {
            const scoped = new PostgreSqlCoordinationRepository(
              transaction,
              scope.projectId,
              winnerMachineId,
            );
            await scoped.assertLeaseFence({
              resourceType: "conversation",
              resourceKey: "shared",
              processId: winnerProcessId,
              operation: "compact",
              fencingToken: winner.fencingToken,
            });
            await transaction.query({
              text: `UPDATE lcm.passive_event_inbox
                     SET attempt_count = $2
                     WHERE project_id = $1 AND inbox_id = $3`,
              values: [
                scope.projectId,
                externalResult,
                protectedInboxId.toString(),
              ],
            }, {
              domain: "coordination",
              operation: "writeStaleExternalResult",
              projectId: scope.projectId,
            });
          }, {
            domain: "coordination",
            operation: "commitStaleExternalResult",
            projectId: scope.projectId,
          })).rejects.toMatchObject({
            backend: "postgresql",
            projectId: scope.projectId,
          });
          const untouched = await database.migrator.query<{
            attempt_count: number;
          }>({
            text: `SELECT attempt_count
                   FROM lcm.passive_event_inbox
                   WHERE inbox_id = $1`,
            values: [protectedInboxId.toString()],
          }, { domain: "coordination", operation: "inspectDiscardedResult" });
          expect(untouched.rows[0].attempt_count).toBe(0);
        } finally {
          await staleRuntime.close();
        }

        await loserRuntime.transaction(async (transaction) => {
          const scoped = new PostgreSqlCoordinationRepository(
            transaction,
            scope.projectId,
            loserMachineId,
          );
          await scoped.assertLeaseFence({
            resourceType: "conversation",
            resourceKey: "shared",
            processId: loserProcessId,
            operation: "compact",
            fencingToken: successor!.fencingToken,
          });
          await transaction.query({
            text: `UPDATE lcm.passive_event_inbox
                   SET attempt_count = 7
                   WHERE project_id = $1 AND machine_id = $2`,
            values: [scope.projectId, scope.machineIds[2]],
          }, {
            domain: "coordination",
            operation: "writeCurrentExternalResult",
            projectId: scope.projectId,
          });
        }, {
          domain: "coordination",
          operation: "commitCurrentExternalResult",
          projectId: scope.projectId,
        });

        const renewed = await loser.renewLease({
          resourceType: "conversation",
          resourceKey: "shared",
          processId: loserProcessId,
          operation: "compact",
          fencingToken: successor!.fencingToken,
          ttlMs: 1_000,
        });
        expect(renewed?.fencingToken).toBe(successor?.fencingToken);
        const released = await loser.releaseLease({
          resourceType: "conversation",
          resourceKey: "shared",
          processId: loserProcessId,
          operation: "compact",
          fencingToken: successor!.fencingToken,
        });
        expect(released?.releasedAt).not.toBeNull();
        await expect(loser.listLeases(10)).resolves.toMatchObject([
          { resourceKey: "shared", state: "released" },
        ]);
        const releasedSuccessor = await loser.acquireLease({
          resourceType: "conversation",
          resourceKey: "shared",
          processId: "released-successor",
          operation: "compact",
          ttlMs: 1_000,
        });
        expect(releasedSuccessor?.fencingToken).toBeGreaterThan(
          successor!.fencingToken,
        );
        await expect(loser.releaseLease({
          resourceType: "conversation",
          resourceKey: "shared",
          processId: "released-successor",
          operation: "compact",
          fencingToken: releasedSuccessor!.fencingToken,
        })).resolves.toMatchObject({
          fencingToken: releasedSuccessor!.fencingToken,
          releasedAt: expect.any(String),
        });

        const other = new PostgreSqlCoordinationRepository(
          loserRuntime,
          otherProjectId,
          scope.machineIds[3],
        );
        await expect(other.acquireLease({
          resourceType: "conversation",
          resourceKey: "other-project",
          processId: "other",
          operation: "compact",
          ttlMs: 1_000,
        })).resolves.not.toBeNull();
        const diagnostics = await loser.getCoordinationDiagnostics();
        expect(diagnostics.leases.released).toBe(1n);
        expect(diagnostics.leases.active).toBe(0n);

        await database.migrator.query({
          text: `UPDATE lcm.fenced_leases
                 SET acquired_at =
                       pg_catalog.statement_timestamp() - interval '4 seconds',
                     renewed_at =
                       pg_catalog.statement_timestamp() - interval '3 seconds',
                     expires_at =
                       pg_catalog.statement_timestamp() - interval '2 seconds',
                     released_at =
                       pg_catalog.statement_timestamp() - interval '1 second'
                 WHERE project_id = $1
                   AND resource_type = 'conversation'
                   AND resource_key = 'shared'`,
          values: [scope.projectId],
        }, { domain: "coordination", operation: "ageReleasedLease" });
        await expect(loser.cleanupLeases({
          retentionMs: 500,
          limit: 1,
        })).resolves.toEqual({
          projectId: scope.projectId,
          deletedCount: 1n,
        });
        const replacement = await loser.acquireLease({
          resourceType: "conversation",
          resourceKey: "shared",
          processId: loserProcessId,
          operation: "compact",
          ttlMs: 1_000,
        });
        expect(replacement?.fencingToken).toBeGreaterThan(
          releasedSuccessor!.fencingToken,
        );
      } finally {
        await Promise.allSettled([
          firstRuntime.close(),
          secondRuntime.close(),
        ]);
      }
    });
  });

  it("claims fair machine heads without duplicates or reordering", async () => {
    await withPostgreSqlTestDatabase("coord-queue", async (database) => {
      await grantCoordinationRuntimePrivileges(database);
      const scope = await createScope(database, "Coordination queue");
      const otherProjectId = await createProject(
        database,
        "Coordination queue other project",
      );
      const firstA = await seedPassiveEvent(database, {
        projectId: scope.projectId,
        machineId: scope.machineIds[0],
        machineSequence: 0n,
      });
      const secondA = await seedPassiveEvent(database, {
        projectId: scope.projectId,
        machineId: scope.machineIds[0],
        machineSequence: 1n,
      });
      const firstB = await seedPassiveEvent(database, {
        projectId: scope.projectId,
        machineId: scope.machineIds[1],
        machineSequence: 0n,
      });
      const retryC = await seedPassiveEvent(database, {
        projectId: scope.projectId,
        machineId: scope.machineIds[2],
        machineSequence: 0n,
        status: "retry",
        ready: false,
      });
      await seedPassiveEvent(database, {
        projectId: otherProjectId,
        machineId: scope.machineIds[3],
        machineSequence: 0n,
      });
      const firstRuntime = runtime(database);
      const secondRuntime = runtime(database);
      const first = new PostgreSqlCoordinationRepository(
        firstRuntime,
        scope.projectId,
        scope.machineIds[2],
      );
      const second = new PostgreSqlCoordinationRepository(
        secondRuntime,
        scope.projectId,
        scope.machineIds[3],
      );
      try {
        let releaseHead!: () => void;
        const held = new Promise<void>((resolve) => {
          releaseHead = resolve;
        });
        let headLocked!: () => void;
        const locked = new Promise<void>((resolve) => {
          headLocked = resolve;
        });
        const lockHead = database.migrator.transaction(async (transaction) => {
          await transaction.query({
            text: `SELECT inbox_id
                   FROM lcm.passive_event_inbox
                   WHERE inbox_id = $1
                   FOR UPDATE`,
            values: [firstA.toString()],
          }, { domain: "coordination", operation: "holdMachineHead" });
          headLocked();
          await held;
        }, {
          domain: "coordination",
          operation: "holdMachineHeadTransaction",
          projectId: scope.projectId,
        });
        await locked;
        const parallel = await first.claimPassiveEvents({
          claimOwner: "worker-parallel",
          limit: 4,
          staleClaimMs: 30_000,
        });
        expect(parallel.map((claim) => claim.inboxId)).toEqual([firstB]);
        releaseHead();
        await lockHead;

        const batches = await Promise.all([
          first.claimPassiveEvents({
            claimOwner: "worker-a",
            limit: 4,
            staleClaimMs: 30_000,
          }),
          second.claimPassiveEvents({
            claimOwner: "worker-b",
            limit: 4,
            staleClaimMs: 30_000,
          }),
        ]);
        const claimed = batches.flat();
        expect(claimed.map((claim) => claim.inboxId)).toEqual([firstA]);
        expect(new Set([
          ...parallel.map((claim) => claim.inboxId.toString()),
          ...claimed.map((claim) => claim.inboxId.toString()),
        ]).size).toBe(2);
        expect([
          ...parallel,
          ...claimed,
        ].some((claim) => claim.inboxId === secondA)).toBe(false);
        expect([
          ...parallel,
          ...claimed,
        ].some((claim) => claim.projectId === otherProjectId)).toBe(false);

        await applyClaimedEvents(database, [firstA, firstB]);
        const next = await first.claimPassiveEvents({
          claimOwner: "worker-next",
          limit: 4,
          staleClaimMs: 30_000,
        });
        expect(next.map((claim) => claim.inboxId)).toEqual([secondA]);

        await database.migrator.query({
          text: `UPDATE lcm.passive_event_inbox
                 SET claimed_at =
                       pg_catalog.statement_timestamp() - interval '1 minute'
                 WHERE inbox_id = $1`,
          values: [secondA.toString()],
        }, { domain: "coordination", operation: "makeClaimStale" });
        const recovered = await second.claimPassiveEvents({
          claimOwner: "worker-recovery",
          limit: 1,
          staleClaimMs: 1_000,
        });
        expect(recovered).toMatchObject([{
          inboxId: secondA,
          claimedBy: "worker-recovery",
          attemptCount: 2,
        }]);

        await database.migrator.query({
          text: `UPDATE lcm.passive_event_inbox
                 SET next_attempt_at =
                       pg_catalog.statement_timestamp() - interval '1 minute'
                 WHERE inbox_id = $1`,
          values: [retryC.toString()],
        }, { domain: "coordination", operation: "makeRetryReady" });
        const readyRetry = await first.claimPassiveEvents({
          claimOwner: "worker-retry",
          limit: 1,
          staleClaimMs: 30_000,
        });
        expect(readyRetry.map((claim) => claim.inboxId)).toEqual([retryC]);
        expect(readyRetry[0]?.attemptCount).toBe(1);

        const rowCounts = await database.migrator.query<{
          inbox_id: string;
          attempt_count: number;
        }>({
          text: `SELECT inbox_id::pg_catalog.text, attempt_count
                 FROM lcm.passive_event_inbox
                 WHERE inbox_id = ANY($1::pg_catalog.int8[])
                 ORDER BY inbox_id`,
          values: [[firstA, firstB, secondA, retryC].map(String)],
        }, { domain: "coordination", operation: "inspectClaimAttempts" });
        expect(new Map(
          rowCounts.rows.map((row) => [
            BigInt(row.inbox_id),
            row.attempt_count,
          ]),
        )).toEqual(new Map([
          [firstA, 1],
          [firstB, 1],
          [secondA, 2],
          [retryC, 1],
        ]));
      } finally {
        await Promise.allSettled([
          firstRuntime.close(),
          secondRuntime.close(),
        ]);
      }
    });
  });
});
