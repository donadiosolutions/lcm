import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PostgreSqlIdentityRepository,
} from "../../src/storage/postgresql/identity-repository.js";
import type {
  PostgreSqlBackendPublicationFence,
  PostgreSqlBackendPublicationMutationInput,
} from "../../src/storage/postgresql/publication-guard.js";
import {
  PostgreSqlBackendPublicationGuard,
} from "../../src/storage/postgresql/publication-guard.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  assertHarnessReady,
  settings,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const EVIDENCE = "b".repeat(64);
const TTL_MS = 1_000;

async function grantCoordinationRuntimePrivileges(
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
    domain: "coordination",
    operation: "grantPublicationRuntimePrivileges",
  });
}

async function publicationFixture(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<{
  readonly guard: PostgreSqlBackendPublicationGuard;
  readonly fence: PostgreSqlBackendPublicationFence;
  readonly mutation: PostgreSqlBackendPublicationMutationInput;
}> {
  await grantCoordinationRuntimePrivileges(database);
  const repository = new PostgreSqlIdentityRepository(database.migrator);
  const machine = await repository.registerMachine(
    `machine:${"a".repeat(64)}`,
    `Machine ${label}`,
  );
  const project = await repository.createProject({
    machineId: machine.machineId,
    displayName: `Publication ${label}`,
    path: `/work/${label}`,
    normalizedPath: `/work/${label}`,
  });
  const guard = database.runtime.backendPublicationGuard();
  const mutation = {
    projectId: project.projectId,
    machineId: machine.machineId,
    publicationId: `publication-${label}`,
    targetBackend: "postgresql" as const,
    evidenceSha256: EVIDENCE,
  };
  const fence = await guard.acquire({ ...mutation, ttlMs: TTL_MS });
  return { guard, fence, mutation: { ...mutation, fencingToken: fence.fencingToken } };
}

interface HeldPublicationRow {
  readonly started: Promise<void>;
  readonly release: () => void;
  readonly completion: Promise<void>;
}

function holdPublicationRow(
  database: PostgreSqlTestDatabase,
  projectId: string,
  operation: string,
): HeldPublicationRow {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
  const completion = database.migrator.transaction(async (transaction) => {
    await transaction.query({
      text: `SELECT 1
             FROM lcm.fenced_leases
             WHERE project_id = $1::pg_catalog.uuid
               AND resource_type = 'backend-publication'
               AND resource_key = 'selection'
             FOR UPDATE`,
      values: [projectId],
    }, { domain: "coordination", operation });
    markStarted();
    await releaseSignal;
  }, { domain: "coordination", operation });
  return { started, release, completion };
}

async function waitForPublicationWait(
  database: PostgreSqlTestDatabase,
  projectId: string,
): Promise<void> {
  const observer = new PostgreSqlRuntime(settings(database.adminUrl));
  const deadline = Date.now() + 4_000;
  try {
    while (Date.now() < deadline) {
      const result = await observer.query<{
        readonly expired: boolean;
        readonly waiting: boolean;
      }>({
        text: `SELECT pg_catalog.statement_timestamp() >= expires_at AS expired,
                      EXISTS (
                        SELECT 1
                        FROM pg_catalog.pg_stat_activity
                        WHERE datname = pg_catalog.current_database()
                          AND wait_event_type = 'Lock'
                          AND query LIKE '%fenced_leases%'
                      ) AS waiting
               FROM lcm.fenced_leases
               WHERE project_id = $1::pg_catalog.uuid
                 AND resource_type = 'backend-publication'
                 AND resource_key = 'selection'`,
        values: [projectId],
      }, { domain: "coordination", operation: "observePublicationWait" });
      const row = result.rows[0];
      if (row?.expired === true && row.waiting === true) return;
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    }
  } finally {
    await observer.close();
  }
  throw new Error("publication contender did not reach an expired row lock wait");
}

async function releaseHeldPublicationRow(
  holder: HeldPublicationRow,
): Promise<void> {
  holder.release();
  await holder.completion;
}

describe("PostgreSQL publication guard post-wait database time", () => {
  it("takes over an expired generation after waiting for its row lock", async () => {
    await withPostgreSqlTestDatabase("publication-acquire-wait", async (database) => {
      const fixture = await publicationFixture(database, "acquire-wait");
      const holder = holdPublicationRow(
        database,
        fixture.fence.projectId,
        "holdPublicationForAcquireWait",
      );
      await holder.started;
      const contender = fixture.guard.acquire({
        ...fixture.mutation,
        ttlMs: TTL_MS,
        expectedFencingToken: fixture.fence.fencingToken,
      });
      try {
        await waitForPublicationWait(database, fixture.fence.projectId);
        await releaseHeldPublicationRow(holder);
        const replaced = await contender;
        expect(replaced.fencingToken).toBeGreaterThan(fixture.fence.fencingToken);
        expect(replaced.databaseExpired).toBe(false);
      } finally {
        holder.release();
        await Promise.allSettled([holder.completion, contender]);
      }
    });
  });

  it("does not renew a lease that expires while its row lock is contended", async () => {
    await withPostgreSqlTestDatabase("publication-renew-wait", async (database) => {
      const fixture = await publicationFixture(database, "renew-wait");
      const holder = holdPublicationRow(
        database,
        fixture.fence.projectId,
        "holdPublicationForRenewWait",
      );
      await holder.started;
      const contender = fixture.guard.renew({ ...fixture.mutation, ttlMs: TTL_MS });
      try {
        await waitForPublicationWait(database, fixture.fence.projectId);
        await releaseHeldPublicationRow(holder);
        await expect(contender).rejects.toMatchObject({ reason: "fence-mismatch" });
        await expect(fixture.guard.read(fixture.mutation)).resolves.toMatchObject({
          releasedAt: null,
          databaseExpired: true,
        });
      } finally {
        holder.release();
        await Promise.allSettled([holder.completion, contender]);
      }
    });
  });

  it("does not release a lease that expires while its row lock is contended", async () => {
    await withPostgreSqlTestDatabase("publication-release-wait", async (database) => {
      const fixture = await publicationFixture(database, "release-wait");
      const holder = holdPublicationRow(
        database,
        fixture.fence.projectId,
        "holdPublicationForReleaseWait",
      );
      await holder.started;
      const contender = fixture.guard.release(fixture.mutation);
      try {
        await waitForPublicationWait(database, fixture.fence.projectId);
        await releaseHeldPublicationRow(holder);
        await expect(contender).rejects.toMatchObject({ reason: "fence-mismatch" });
        await expect(fixture.guard.read(fixture.mutation)).resolves.toMatchObject({
          releasedAt: null,
          databaseExpired: true,
        });
      } finally {
        holder.release();
        await Promise.allSettled([holder.completion, contender]);
      }
    });
  });
});
