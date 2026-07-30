import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  derivePostgreSqlAdvisoryLockName,
} from "../../src/storage/postgresql/coordination.js";
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
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      child.off("error", onError);
      callback();
    };
    const onExit = (): void => {
      settle(resolve);
    };
    const onError = (error: Error & { code?: string }): void => {
      if (
        error.code === "ESRCH"
        || child.exitCode !== null
        || child.signalCode !== null
      ) {
        settle(resolve);
      } else {
        settle(() => reject(error));
      }
    };
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) {
      settle(resolve);
      return;
    }
    try {
      const signaled = child.kill("SIGKILL");
      if (
        !signaled
        && (child.exitCode !== null || child.signalCode !== null)
      ) {
        settle(resolve);
      } else if (!signaled) {
        setImmediate(() => settle(resolve));
      }
    } catch (error) {
      if (
        (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ESRCH"
        )
        || child.exitCode !== null
        || child.signalCode !== null
      ) {
        settle(resolve);
      } else {
        settle(() => reject(error));
      }
    }
  });
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
        inbox_insert_columns: string[];
        inbox_update_columns: string[];
        inbox_truncate: boolean;
        inbox_sequence_usage: boolean;
        inbox_sequence_select: boolean;
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
                 ARRAY(
                   SELECT column_name::pg_catalog.text
                   FROM information_schema.columns
                   WHERE table_schema = 'lcm'
                     AND table_name = 'passive_event_inbox'
                     AND has_column_privilege(
                       'lcm_test_runtime',
                       'lcm.passive_event_inbox',
                       column_name,
                       'INSERT'
                     )
                   ORDER BY ordinal_position
                 ) AS inbox_insert_columns,
                 ARRAY(
                   SELECT column_name::pg_catalog.text
                   FROM information_schema.columns
                   WHERE table_schema = 'lcm'
                     AND table_name = 'passive_event_inbox'
                     AND has_column_privilege(
                       'lcm_test_runtime',
                       'lcm.passive_event_inbox',
                       column_name,
                       'UPDATE'
                     )
                   ORDER BY ordinal_position
                 ) AS inbox_update_columns,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.passive_event_inbox', 'TRUNCATE'
                 ) AS inbox_truncate,
                 has_sequence_privilege(
                   'lcm_test_runtime',
                   'lcm.passive_event_inbox_inbox_id_seq',
                   'USAGE'
                 ) AS inbox_sequence_usage,
                 has_sequence_privilege(
                   'lcm_test_runtime',
                   'lcm.passive_event_inbox_inbox_id_seq',
                   'SELECT'
                 ) AS inbox_sequence_select`,
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
        inbox_delete: true,
        inbox_insert: false,
        inbox_update: false,
        inbox_insert_columns: [
          "project_id",
          "machine_id",
          "event_id",
          "event_version",
          "machine_sequence",
          "event_type",
          "payload",
        ],
        inbox_update_columns: [
          "status",
          "attempt_count",
          "next_attempt_at",
          "claimed_at",
          "claimed_by",
          "applied_at",
          "quarantined_at",
          "quarantine_reason",
        ],
        inbox_truncate: false,
        inbox_sequence_usage: true,
        inbox_sequence_select: false,
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
          retryable: false,
        });
        expect(JSON.stringify(cancellationError)).not.toContain(
          "shared-resource",
        );

        await expect(contender.transaction(async (transaction) => {
          await transaction.query({
            text: `SELECT pg_catalog.set_config(
                            'lock_timeout',
                            $1::pg_catalog.text,
                            true
                          )`,
            values: ["3s"],
          }, {
            domain: "coordination",
            operation: "setRecoverableLockTimeout",
            projectId: scope.projectId,
          });
          const scoped = new PostgreSqlCoordinationRepository(
            transaction,
            scope.projectId,
            scope.machineIds[1],
          );
          const recoverableError = await scoped.acquireTransactionLock({
            resourceType: "crash-fixture",
            resourceKey: "shared-resource",
            operation: "recoverable-timeout",
            timeoutMs: 75,
          }).catch((error: unknown) => error);
          expect(recoverableError).toMatchObject({
            backend: "postgresql",
            projectId: scope.projectId,
            machineId: scope.machineIds[1],
            operation: "recoverable-timeout",
          });
          const restored = await transaction.query<{ setting: string }>({
            text: `SELECT pg_catalog.current_setting(
                            'lock_timeout'
                          ) AS setting`,
          }, {
            domain: "coordination",
            operation: "inspectRestoredLockTimeout",
            projectId: scope.projectId,
          });
          expect(restored.rows[0].setting).toBe("3s");
        }, {
          domain: "coordination",
          operation: "recoverAfterLockTimeout",
          projectId: scope.projectId,
        })).resolves.toBeUndefined();

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
          retryable: true,
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

  it("isolates concurrent lock timeouts within one live transaction", async () => {
    await withPostgreSqlTestDatabase("coord-lock-timeout-fifo", async (
      database,
    ) => {
      await grantCoordinationRuntimePrivileges(database);
      const scope = await createScope(database, "Coordination timeout FIFO");
      const blocker = runtime(database);
      const contender = runtime(database);
      let reportReady!: () => void;
      let reportFailure!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        reportReady = resolve;
        reportFailure = reject;
      });
      const hold = blocker.transaction(async (transaction) => {
        await transaction.query({
          text: `SELECT pg_catalog.pg_advisory_xact_lock(
                          pg_catalog.hashtextextended(
                            lock_name,
                            0
                          )
                        )
                 FROM unnest($1::pg_catalog.text[]) AS candidate(lock_name)`,
          values: [[
            derivePostgreSqlAdvisoryLockName(
              scope.projectId,
              "timeout-fifo",
              "first",
            ),
            derivePostgreSqlAdvisoryLockName(
              scope.projectId,
              "timeout-fifo",
              "second",
            ),
          ]],
        }, {
          domain: "coordination",
          operation: "holdTimeoutFifoLock",
          projectId: scope.projectId,
        });
        reportReady();
        await transaction.query({
          text: "SELECT pg_catalog.pg_sleep(0.7)",
        }, {
          domain: "coordination",
          operation: "holdTimeoutFifoLock",
          projectId: scope.projectId,
        });
      }, {
        domain: "coordination",
        operation: "holdTimeoutFifoLock",
        projectId: scope.projectId,
      }).catch((error: unknown) => {
        reportFailure(error);
        throw error;
      });
      try {
        await ready;
        const outcome = await contender.transaction(async (transaction) => {
          await transaction.query({
            text: `SELECT pg_catalog.set_config(
                            'lock_timeout',
                            '2s',
                            true
                          )`,
          }, {
            domain: "coordination",
            operation: "configurePriorLockTimeout",
            projectId: scope.projectId,
          });
          const first = new PostgreSqlCoordinationRepository(
            transaction,
            scope.projectId,
            scope.machineIds[0],
          );
          const second = new PostgreSqlCoordinationRepository(
            transaction,
            scope.projectId,
            scope.machineIds[1],
          );
          const attempts = await Promise.allSettled([
            first.acquireTransactionLock({
              resourceType: "timeout-fifo",
              resourceKey: "first",
              operation: "short-timeout",
              timeoutMs: 100,
            }),
            second.acquireTransactionLock({
              resourceType: "timeout-fifo",
              resourceKey: "second",
              operation: "long-timeout",
              timeoutMs: 1_000,
            }),
          ]);
          const restored = await transaction.query<{ setting: string }>({
            text: `SELECT pg_catalog.current_setting(
                            'lock_timeout'
                          ) AS setting`,
          }, {
            domain: "coordination",
            operation: "inspectRestoredLockTimeout",
            projectId: scope.projectId,
          });
          return {
            attempts,
            restoredSetting: restored.rows[0].setting,
          };
        }, {
          domain: "coordination",
          operation: "exerciseConcurrentLockTimeouts",
          projectId: scope.projectId,
        });
        expect(outcome.attempts[0]).toMatchObject({
          status: "rejected",
          reason: {
            backend: "postgresql",
            machineId: scope.machineIds[0],
            operation: "short-timeout",
            retryable: true,
          },
        });
        expect(outcome.attempts[1]).toMatchObject({
          status: "fulfilled",
          value: {
            machineId: scope.machineIds[1],
            operation: "long-timeout",
          },
        });
        expect(outcome.restoredSetting).toBe("2s");
        await hold;
      } finally {
        await Promise.allSettled([
          hold,
          blocker.close(),
          contender.close(),
        ]);
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

  it("evaluates lease clocks only after blocking database waits", async () => {
    await withPostgreSqlTestDatabase("coord-lease-lock-clock", async (
      database,
    ) => {
      await grantCoordinationRuntimePrivileges(database);
      const scope = await createScope(database, "Coordination lock clock");
      const ownerRuntime = runtime(database);
      const fenceRuntime = runtime(database);
      const takeoverRuntime = runtime(database);
      const blockerRuntime = runtime(database);
      const owner = new PostgreSqlCoordinationRepository(
        ownerRuntime,
        scope.projectId,
        scope.machineIds[0],
      );
      const takeover = new PostgreSqlCoordinationRepository(
        takeoverRuntime,
        scope.projectId,
        scope.machineIds[1],
      );
      try {
        let reportInserted!: () => void;
        let reportInsertFailure!: (error: unknown) => void;
        const conflictingRowInserted = new Promise<void>((resolve, reject) => {
          reportInserted = resolve;
          reportInsertFailure = reject;
        });
        let beforeRollback!: Date;
        const conflictingInsert = blockerRuntime.transaction(async (
          transaction,
        ) => {
          await transaction.query({
            text: `INSERT INTO lcm.fenced_leases (
                     project_id,
                     resource_type,
                     resource_key,
                     owner_machine_id,
                     owner_process_id,
                     operation,
                     expires_at
                   )
                   VALUES (
                     $1, 'conversation', 'insert-clock', $2,
                     'blocker', 'compact',
                     pg_catalog.statement_timestamp() + interval '1 second'
                   )`,
            values: [scope.projectId, scope.machineIds[2]],
          }, {
            domain: "coordination",
            operation: "holdConflictingLeaseInsert",
            projectId: scope.projectId,
          });
          reportInserted();
          await transaction.query({
            text: "SELECT pg_catalog.pg_sleep(0.25)",
          }, {
            domain: "coordination",
            operation: "holdConflictingLeaseInsert",
            projectId: scope.projectId,
          });
          const observed = await transaction.query<{ observed_at: Date }>({
            text: "SELECT pg_catalog.clock_timestamp() AS observed_at",
          }, {
            domain: "coordination",
            operation: "observeLeaseInsertRollback",
            projectId: scope.projectId,
          });
          beforeRollback = observed.rows[0].observed_at;
          throw new Error("roll back the conflicting lease fixture");
        }, {
          domain: "coordination",
          operation: "holdConflictingLeaseInsert",
          projectId: scope.projectId,
        }).catch((error: unknown) => {
          reportInsertFailure(error);
        });
        await conflictingRowInserted;
        const delayedAcquisition = takeover.acquireLease({
          resourceType: "conversation",
          resourceKey: "insert-clock",
          processId: "successor",
          operation: "compact",
          ttlMs: 1_000,
        });
        await conflictingInsert;
        const insertedAfterWait = await delayedAcquisition;
        expect(insertedAfterWait).not.toBeNull();
        expect(new Date(insertedAfterWait!.acquiredAt).getTime())
          .toBeGreaterThanOrEqual(beforeRollback.getTime());
        expect(
          new Date(insertedAfterWait!.expiresAt).getTime()
            - new Date(insertedAfterWait!.acquiredAt).getTime(),
        ).toBe(1_000);

        const lease = await owner.acquireLease({
          resourceType: "conversation",
          resourceKey: "lock-clock",
          processId: "owner",
          operation: "compact",
          ttlMs: 2_000,
        });
        expect(lease).not.toBeNull();

        let reportLocked!: () => void;
        let reportLockFailure!: (error: unknown) => void;
        const rowLocked = new Promise<void>((resolve, reject) => {
          reportLocked = resolve;
          reportLockFailure = reject;
        });
        const blocker = blockerRuntime.transaction(async (transaction) => {
          await transaction.query({
            text: `SELECT 1
                   FROM lcm.fenced_leases
                   WHERE project_id = $1
                     AND resource_type = 'conversation'
                     AND resource_key = 'lock-clock'
                   FOR UPDATE`,
            values: [scope.projectId],
          }, {
            domain: "coordination",
            operation: "holdLeasePastExpiry",
            projectId: scope.projectId,
          });
          reportLocked();
          await transaction.query({
            text: "SELECT pg_catalog.pg_sleep(2.2)",
          }, {
            domain: "coordination",
            operation: "holdLeasePastExpiry",
            projectId: scope.projectId,
          });
        }, {
          domain: "coordination",
          operation: "holdLeasePastExpiry",
          projectId: scope.projectId,
        }).catch((error: unknown) => {
          reportLockFailure(error);
          throw error;
        });
        await rowLocked;
        const started = await database.migrator.query<{ observed_at: Date }>({
          text: "SELECT pg_catalog.clock_timestamp() AS observed_at",
        }, { domain: "coordination", operation: "inspectPreExpiryStart" });
        expect(started.rows[0].observed_at.getTime()).toBeLessThan(
          new Date(lease!.expiresAt).getTime(),
        );

        const renewal = owner.renewLease({
          resourceType: "conversation",
          resourceKey: "lock-clock",
          processId: "owner",
          operation: "compact",
          fencingToken: lease!.fencingToken,
          ttlMs: 2_000,
        });
        const fence = fenceRuntime.transaction(async (transaction) => {
          const scoped = new PostgreSqlCoordinationRepository(
            transaction,
            scope.projectId,
            scope.machineIds[0],
          );
          return scoped.assertLeaseFence({
            resourceType: "conversation",
            resourceKey: "lock-clock",
            processId: "owner",
            operation: "compact",
            fencingToken: lease!.fencingToken,
          });
        }, {
          domain: "coordination",
          operation: "validateFenceAfterLockWait",
          projectId: scope.projectId,
        }).then(
          (value) => ({ succeeded: true as const, value }),
          (error: unknown) => ({ succeeded: false as const, error }),
        );
        const successor = takeover.acquireLease({
          resourceType: "conversation",
          resourceKey: "lock-clock",
          processId: "successor",
          operation: "compact",
          ttlMs: 2_000,
        });

        await blocker;
        await expect(renewal).resolves.toBeNull();
        const fenceOutcome = await fence;
        expect(fenceOutcome.succeeded).toBe(false);
        if (fenceOutcome.succeeded) {
          throw new Error("expired fence unexpectedly remained valid");
        }
        expect(fenceOutcome.error).toMatchObject({
          backend: "postgresql",
          projectId: scope.projectId,
          operation: "assertLeaseFence",
        });
        await expect(successor).resolves.toMatchObject({
          machineId: scope.machineIds[1],
          fencingToken: expect.any(BigInt),
        });
        const successorLease = await successor;
        expect(successorLease!.fencingToken).toBeGreaterThan(
          lease!.fencingToken,
        );
      } finally {
        await Promise.allSettled([
          ownerRuntime.close(),
          fenceRuntime.close(),
          takeoverRuntime.close(),
          blockerRuntime.close(),
        ]);
      }
    });
  });

  it("timestamps claims after a table-lock wait before stale recovery", async () => {
    await withPostgreSqlTestDatabase("coord-claim-lock-clock", async (
      database,
    ) => {
      await grantCoordinationRuntimePrivileges(database);
      const scope = await createScope(database, "Coordination claim clock");
      const inboxId = await seedPassiveEvent(database, {
        projectId: scope.projectId,
        machineId: scope.machineIds[0],
        machineSequence: 0n,
      });
      const claimerRuntime = runtime(database);
      const reclaimerRuntime = runtime(database);
      const claimer = new PostgreSqlCoordinationRepository(
        claimerRuntime,
        scope.projectId,
        scope.machineIds[1],
      );
      const reclaimer = new PostgreSqlCoordinationRepository(
        reclaimerRuntime,
        scope.projectId,
        scope.machineIds[2],
      );
      await Promise.all([
        claimer.getCoordinationDiagnostics(),
        reclaimer.getCoordinationDiagnostics(),
      ]);
      let reportLocked!: () => void;
      let reportLockFailure!: (error: unknown) => void;
      const tableLocked = new Promise<void>((resolve, reject) => {
        reportLocked = resolve;
        reportLockFailure = reject;
      });
      const blocker = database.migrator.transaction(async (transaction) => {
        await transaction.query({
          text: `LOCK TABLE lcm.passive_event_inbox
                 IN ACCESS EXCLUSIVE MODE`,
        }, { domain: "coordination", operation: "holdInboxTable" });
        reportLocked();
        await transaction.query({
          text: "SELECT pg_catalog.pg_sleep(1.25)",
        }, { domain: "coordination", operation: "holdInboxTable" });
        const observed = await transaction.query<{ observed_at: Date }>({
          text: "SELECT pg_catalog.clock_timestamp() AS observed_at",
        }, { domain: "coordination", operation: "observeInboxUnlock" });
        return observed.rows[0].observed_at;
      }, {
        domain: "coordination",
        operation: "holdInboxTable",
        projectId: scope.projectId,
      }).catch((error: unknown) => {
        reportLockFailure(error);
        throw error;
      });
      try {
        await tableLocked;
        let claimSettled = false;
        const claim = claimer.claimPassiveEvents({
          claimOwner: "blocked-claimer",
          limit: 1,
          staleClaimMs: 1_000,
        }).then(
          (claims) => {
            claimSettled = true;
            return claims;
          },
          (error: unknown) => {
            claimSettled = true;
            throw error;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(claimSettled).toBe(false);
        const blockedUntil = await blocker;
        const claims = await claim;
        expect(claims).toMatchObject([{
          inboxId,
          claimedBy: "blocked-claimer",
          attemptCount: 1,
        }]);
        expect(new Date(claims[0].claimedAt).getTime()).toBeGreaterThanOrEqual(
          blockedUntil.getTime(),
        );
        await expect(reclaimer.claimPassiveEvents({
          claimOwner: "premature-reclaimer",
          limit: 1,
          staleClaimMs: 1_000,
        })).resolves.toEqual([]);
      } finally {
        await Promise.allSettled([
          blocker,
          claimerRuntime.close(),
          reclaimerRuntime.close(),
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
