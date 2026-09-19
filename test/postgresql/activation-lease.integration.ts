import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import type { PostgreSqlBackendPublicationGuard } from "../../src/storage/postgresql/publication-guard.js";
import {
  acquireActivationLease,
  assertActivationLeaseFence,
  readActivationLeaseFence,
  releaseActivationLease,
  renewActivationLease,
  takeoverActivationLease,
} from "../../src/migration/activation-lease.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const EVIDENCE = "c".repeat(64);

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

interface ProjectFixture {
  readonly guard: PostgreSqlBackendPublicationGuard;
  readonly projectId: string;
  readonly machineId: string;
  readonly publicationId: string;
}

async function registerProject(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<ProjectFixture> {
  const repository = new PostgreSqlIdentityRepository(database.migrator);
  const machine = await repository.registerMachine(
    `machine:${"a".repeat(64)}`,
    `Machine ${label}`,
  );
  const project = await repository.createProject({
    machineId: machine.machineId,
    displayName: `Activation lease ${label}`,
    path: `/work/${label}`,
    normalizedPath: `/work/${label}`,
  });
  return {
    guard: database.runtime.backendPublicationGuard(),
    projectId: project.projectId,
    machineId: machine.machineId,
    publicationId: `publication-${label}`,
  };
}

describe("activation-lease against real PostgreSQL", () => {
  it("acquires a lease per covered project, each genuinely independent of the others", async () => {
    await withPostgreSqlTestDatabase("activation-lease-per-project", async (database) => {
      await grantCoordinationRuntimePrivileges(database);
      const first = await registerProject(database, "first");
      const second = await registerProject(database, "second");

      const acquiredFirst = await acquireActivationLease(first.guard, {
        projectId: first.projectId,
        machineId: first.machineId,
        publicationId: first.publicationId,
        targetBackend: "postgresql",
        evidenceSha256: EVIDENCE,
        ttlMs: 60_000,
      });
      expect(acquiredFirst.status).toBe("acquired");

      const acquiredSecond = await acquireActivationLease(second.guard, {
        projectId: second.projectId,
        machineId: second.machineId,
        publicationId: second.publicationId,
        targetBackend: "postgresql",
        evidenceSha256: EVIDENCE,
        ttlMs: 60_000,
      });
      expect(acquiredSecond.status).toBe("acquired");
      if (acquiredFirst.status !== "acquired" || acquiredSecond.status !== "acquired") throw new Error("unreachable");

      // Genuine independence: releasing the first project's lease must not
      // touch the second project's row at all.
      const releasedFirst = await releaseActivationLease(first.guard, {
        projectId: first.projectId,
        machineId: first.machineId,
        publicationId: first.publicationId,
        targetBackend: "postgresql",
        evidenceSha256: EVIDENCE,
        fencingToken: acquiredFirst.fence.fencingToken,
      });
      expect(releasedFirst.status).toBe("released");

      const secondStillActive = await assertActivationLeaseFence(second.guard, {
        projectId: second.projectId,
        publicationId: second.publicationId,
        targetBackend: "postgresql",
        evidenceSha256: EVIDENCE,
      });
      expect(secondStillActive.status).toBe("satisfied");
    });
  });

  it(
    "refuses ordinary renewal of an expired-unreleased lease, repeatedly, "
      + "and only a fencing-token takeover revives it",
    async () => {
      await withPostgreSqlTestDatabase("activation-lease-expiry-takeover", async (database) => {
        await grantCoordinationRuntimePrivileges(database);
        const project = await registerProject(database, "expiry");
        const identity = {
          projectId: project.projectId,
          machineId: project.machineId,
          publicationId: project.publicationId,
          targetBackend: "postgresql" as const,
          evidenceSha256: EVIDENCE,
        };

        const acquired = await acquireActivationLease(project.guard, { ...identity, ttlMs: 50 });
        expect(acquired.status).toBe("acquired");
        if (acquired.status !== "acquired") throw new Error("unreachable");

        // Wait past the 50ms TTL so the row is genuinely expired-but-unreleased
        // according to the authoritative PostgreSQL clock, not this process's.
        await delay(750);
        const expiredRead = await readActivationLeaseFence(project.guard, identity);
        expect(expiredRead).toMatchObject({ kind: "present", value: { databaseExpired: true, releasedAt: null } });

        // Negative: plain renewal never revives an expired lease.
        const firstRenewAttempt = await renewActivationLease(project.guard, {
          ...identity,
          fencingToken: acquired.fence.fencingToken,
          ttlMs: 60_000,
        });
        expect(firstRenewAttempt).toMatchObject({ status: "expired", fence: { fencingToken: acquired.fence.fencingToken } });

        // Negative, repeated: calling plain renewal again changes nothing.
        const secondRenewAttempt = await renewActivationLease(project.guard, {
          ...identity,
          fencingToken: acquired.fence.fencingToken,
          ttlMs: 60_000,
        });
        expect(secondRenewAttempt).toMatchObject({ status: "expired" });
        const stillExpired = await readActivationLeaseFence(project.guard, identity);
        expect(stillExpired).toMatchObject({ kind: "present", value: { databaseExpired: true, releasedAt: null } });

        // Positive: the compare-and-swap takeover using the expired fence's
        // own token succeeds where plain renewal could not.
        if (firstRenewAttempt.status !== "expired") throw new Error("unreachable");
        const takenOver = await takeoverActivationLease(project.guard, {
          ...identity,
          ttlMs: 60_000,
          expectedFencingToken: firstRenewAttempt.fence.fencingToken,
        });
        expect(takenOver.status).toBe("took-over");
        if (takenOver.status !== "took-over") throw new Error("unreachable");
        expect(takenOver.fence.fencingToken).toBeGreaterThan(acquired.fence.fencingToken);
        expect(takenOver.fence.databaseExpired).toBe(false);

        // Negative: the exact same expired token can never be swapped again.
        const staleTakeover = await takeoverActivationLease(project.guard, {
          ...identity,
          ttlMs: 60_000,
          expectedFencingToken: firstRenewAttempt.fence.fencingToken,
        });
        expect(staleTakeover.status).toBe("token-mismatch");

        // Ordinary renewal now succeeds normally with the fresh token.
        const renewedAfterTakeover = await renewActivationLease(project.guard, {
          ...identity,
          fencingToken: takenOver.fence.fencingToken,
          ttlMs: 60_000,
        });
        expect(renewedAfterTakeover.status).toBe("renewed");
      });
    },
  );

  it("asserts a fence matching exactly on publicationId/targetBackend/evidenceSha256/projectId, and refuses a differing one", async () => {
    await withPostgreSqlTestDatabase("activation-lease-assert-fields", async (database) => {
      await grantCoordinationRuntimePrivileges(database);
      const project = await registerProject(database, "assert");
      const identity = {
        projectId: project.projectId,
        publicationId: project.publicationId,
        targetBackend: "postgresql" as const,
        evidenceSha256: EVIDENCE,
      };
      const acquired = await acquireActivationLease(project.guard, { ...identity, machineId: project.machineId, ttlMs: 60_000 });
      expect(acquired.status).toBe("acquired");

      await expect(assertActivationLeaseFence(project.guard, identity)).resolves.toMatchObject({
        status: "satisfied",
        reason: "fence-active-and-matching",
      });

      await expect(assertActivationLeaseFence(project.guard, { ...identity, publicationId: "different-publication" }))
        .resolves.toMatchObject({ status: "unsatisfied", reason: "fence-identity-mismatch" });
      await expect(assertActivationLeaseFence(project.guard, { ...identity, evidenceSha256: "f".repeat(64) }))
        .resolves.toMatchObject({ status: "unsatisfied", reason: "fence-identity-mismatch" });
      await expect(assertActivationLeaseFence(project.guard, { ...identity, targetBackend: "sqlite" }))
        .resolves.toMatchObject({ status: "unsatisfied", reason: "fence-identity-mismatch" });

      const otherProject = await registerProject(database, "assert-other-project");
      await expect(assertActivationLeaseFence(otherProject.guard, { ...identity, projectId: otherProject.projectId }))
        .resolves.toMatchObject({ status: "unsatisfied", reason: "fence-absent" });
    });
  });

  it(
    "refuses to conclude absence when a fenced-lease read is permission-denied, "
      + "where a naive try/catch would wrongly report absence",
    async () => {
      await withPostgreSqlTestDatabase("activation-lease-permission-denied", async (database) => {
        await grantCoordinationRuntimePrivileges(database);
        const project = await registerProject(database, "denied");
        const identity = {
          projectId: project.projectId,
          machineId: project.machineId,
          publicationId: project.publicationId,
          targetBackend: "postgresql" as const,
          evidenceSha256: EVIDENCE,
        };
        const acquired = await acquireActivationLease(project.guard, { ...identity, ttlMs: 60_000 });
        expect(acquired.status).toBe("acquired");

        await database.migrator.query(
          { text: "REVOKE SELECT ON lcm.fenced_leases FROM lcm_test_runtime" },
          { domain: "coordination", operation: "revokeFencedLeaseSelect" },
        );

        const readInput = {
          projectId: identity.projectId,
          targetBackend: identity.targetBackend,
          evidenceSha256: identity.evidenceSha256,
        };

        // The attributed read refuses to conclude absence.
        const attributed = await readActivationLeaseFence(project.guard, readInput);
        expect(attributed).toMatchObject({ kind: "unresolvable", cause: "insufficient-privilege" });

        // The higher-level assertion surfaces the same refusal, not
        // "fence-absent".
        const asserted = await assertActivationLeaseFence(project.guard, {
          projectId: identity.projectId,
          publicationId: identity.publicationId,
          targetBackend: identity.targetBackend,
          evidenceSha256: identity.evidenceSha256,
        });
        expect(asserted).toMatchObject({ status: "unresolvable", reason: "fence-read-unresolvable" });

        // Naive baseline, run against the exact same denied condition: a
        // bare try/catch that collapses every error to null wrongly
        // concludes "no lease exists" for a read that was actually refused.
        const naiveRead = async (): Promise<unknown> => {
          try {
            return await project.guard.read(readInput);
          } catch {
            return null;
          }
        };
        await expect(naiveRead()).resolves.toBeNull();
      });
    },
  );
});

