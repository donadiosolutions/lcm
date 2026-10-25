/**
 * The production activation against a real PostgreSQL 18 database (#625,
 * plan-v7.1 phase 4, plan-v7.2 decision B): runMigrationActivation over
 * createMigrationActivationDependencies, with nothing substituted. The
 * installation is a real SQLite home holding stored data for exactly one
 * project; the generation reaches "verified" and activation-eligible through
 * the same real authenticated copy (runSqliteMigrationCopy) and verification
 * (verifyMigrationGeneration) the migration-verification e2e proves, with the
 * real pre-publication project-map witness recorded in the report so S5 and
 * S16 recompute it rather than trust a placeholder.
 *
 * The activation then runs through every production boundary: the real
 * append barrier, the real lease on lcm.fenced_leases through the ordinary
 * runtime's publication guard, the real quiescence and coverage checks over
 * the home, the real target health, a real census over a fresh read-only
 * transfer snapshot, the real artifact, link, #626 evidence and binding
 * stores, the real coordinator over the production driver and the PostgreSQL
 * remote guard, and the real restart admission. The assertions read the
 * durable state back through the public readers (#626's
 * readMigrationActivationEvidence and resolveMigrationWitnessBindings
 * included), and a second call settles idempotently from that state.
 *
 * One refusal row is included: a second project with stored data makes the
 * single-project G8 verdict refuse "uncovered-projects" (#1544 owns the
 * multi-project cutover); with that project removed the same generation then
 * activates, proving the refusal left no effect behind. The refusal also
 * releases its S2 lease row on lcm.fenced_leases, proven by a different
 * generation acquiring the project through the real guard in between; a run
 * cancelled through its own signal after S2 is proven to do the same (the
 * cleanup runs under its own signal, Bug #1641).
 *
 * A second case crashes the real coordinator right after it journals
 * "released", removes the released fence row, and proves the retry drives the
 * journal to completed: the release tail needs no own fence (plan-v7 A3).
 *
 * Role topology follows #1607: distinct per-run runtime and transfer login
 * roles receive the real reference grant scripts. S2/S6/S15 use the runtime
 * role and admit the discovered transfer role as one canonical peer; S0/S7
 * use the transfer role and admit the discovered runtime role reciprocally.
 * The harness's baseline lcm_test_runtime grant stays revoked except for the
 * explicit third-grantee refusal assertion. The final assertions revoke the
 * transfer role's grants and prove ordinary no-peer daemon readiness passes.
 *
 * The activation runs without the daemon's storage secrets: the harness
 * forbids LCM_POSTGRES_URL and LCM_POSTGRES_CA_FILE in the runner
 * environment and this test asserts their absence, so the S15 and
 * settled-active restart verdicts prove that the production port read does
 * not resolve the daemon config's secrets after the publication selected
 * postgresql (candidate round 1, S1).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  verifyPostgreSqlRuntimeSchema,
} from "../../src/storage/postgresql/runtime-readiness.js";
import type { PostgreSqlConnectionSettings } from "../../src/storage/postgresql/contracts.js";
import { readBackendMaintenanceJournal, readBackendPublicationJournal, type BackendPublicationObserver } from "../../src/storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../../src/storage/backend-publication-driver.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../src/storage/postgresql/publication-remote-guard.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { clearProjectMapCache, projectMapPath } from "../../src/project-map.js";
import { projectsDir } from "../../src/runtime-paths.js";
import { MIGRATION_ACTIVATION_LEASE_TTL_MS, createMigrationActivationDependencies, previewMigrationActivation, runMigrationActivation, type MigrationActivationDependencies } from "../../src/migration/activate-generation.js";
import { readActivationGenerationLink } from "../../src/migration/activation-artifact-store.js";
import { readMigrationActivationEvidence } from "../../src/migration/activation-evidence-store.js";
import { acquireActivationLease, releaseActivationLease } from "../../src/migration/activation-lease.js";
import { deriveActivationPublicationId } from "../../src/migration/activation-publication-id.js";
import { readMigrationActivationReport } from "../../src/migration/activation-report.js";
import { resolveMigrationWitnessBindings } from "../../src/migration/generation-binding-store.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { checkMigrationTargetHealth } from "../../src/migration/target-health.js";
import { EXPECTED_OWNER, RUNTIME_ROLE, TRANSFER_ROLE, GENERATION_ID, readProjectMapFile, readConfigBackend, provisionActivationRole, grantRuntimeActivationRole, dropActivationRole, prepareVerifiedInstallation } from "./migration-activation-fixture.js";

beforeAll(assertHarnessReady);

/** The project's only publication lease row reads back released, and a different
 * generation acquires (then releases) it through the real guard: acquire never
 * displaces an unreleased row of another generation, so this is the proof that
 * an abandoned run freed the project. */
async function expectProjectAcquirableByAnotherGeneration(
  db: PostgreSqlTestDatabase, deps: MigrationActivationDependencies, home: string, remoteProjectId: string, runtimeSettings: PostgreSqlConnectionSettings,
): Promise<void> {
  const leases = await db.migrator.query<{ released: boolean }>({
    text: "SELECT released_at IS NOT NULL AS released FROM lcm.fenced_leases "
      + "WHERE project_id = $1 AND operation LIKE 'backend-publication:postgresql:%'",
    values: [remoteProjectId],
  }, { domain: "factory", operation: "activationIntegration" });
  expect(leases.rows).toEqual([{ released: true }]);
  const otherRuntime = deps.createOrdinaryRuntime(runtimeSettings);
  try {
    const guard = otherRuntime.backendPublicationGuard();
    const otherGeneration = {
      projectId: remoteProjectId, machineId: deps.machineId(home),
      publicationId: deriveActivationPublicationId("other-generation"), targetBackend: "postgresql" as const,
      evidenceSha256: "d".repeat(64),
    };
    const acquired = await acquireActivationLease(guard, { ...otherGeneration, ttlMs: 60_000 });
    expect(acquired.status, acquired.status === "acquired" ? "" : acquired.detail).toBe("acquired");
    if (acquired.status !== "acquired") return;
    expect(await releaseActivationLease(guard, { ...otherGeneration, fencingToken: acquired.fence.fencingToken })).toMatchObject({ status: "released" });
  } finally {
    await otherRuntime.close();
  }
}

it("activates a real verified SQLite copy through the production dependencies: refused while a second project holds data, then activated, published, evidenced and idempotent", async () => {
  await withPostgreSqlTestDatabase("migration-activation-e2e", async (db) => {
    const home = mkdtempSync(join(tmpdir(), "migration-activation-e2e-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    // No daemon secrets: the restart verdict's port read must not need them
    // once the publication has selected postgresql (see the module comment).
    expect(process.env.LCM_POSTGRES_URL).toBeUndefined();
    expect(process.env.LCM_POSTGRES_CA_FILE).toBeUndefined();
    try {
      // Inside the cleanup scope: a failure after CREATE ROLE still drops the role.
      const roles = await provisionActivationRole(db);
      const installation = await prepareVerifiedInstallation(db, home, roles.transfer, roles.runtime);
      await grantRuntimeActivationRole(db, roles.transfer);
      const publicationId = deriveActivationPublicationId(GENERATION_ID);
      const deps = createMigrationActivationDependencies({ homeDir: home });

      const before = await previewMigrationActivation({ homeDir: home, generationId: GENERATION_ID });
      expect(before.predictive).toBe(false);
      expect(before.checks.find((check) => check.name === "resume-point")).toMatchObject({ status: "ok", detail: "fresh" });
      expect(before.checks.find((check) => check.name === "maintenance-journal")).toMatchObject({ status: "ok" });

      // A run cancelled through its own signal after S2 (Bug #1641): the real
      // runtime refuses an aborted signal before it connects or queries, so the
      // cleanup must release the real lease row under its own signal, leaving
      // the project acquirable by a different generation.
      const controller = new AbortController();
      await expect(runMigrationActivation({ ...installation.input, signal: controller.signal }, {
        ...deps,
        readDestinationCensus: async () => { controller.abort(new Error("cancelled by the caller")); throw controller.signal.reason; },
      })).rejects.toThrow("cancelled by the caller");
      await expectProjectAcquirableByAnotherGeneration(db, deps, home, installation.remoteProjectId, roles.runtime);

      // A second project with stored data: G8's single-project verdict refuses
      // (#1544 owns the multi-project cutover). Nothing durable is touched.
      const otherHash = "f".repeat(64);
      mkdirSync(join(projectsDir(home), otherHash), { recursive: true, mode: 0o700 });
      writeFileSync(join(projectsDir(home), otherHash, "db.sqlite"), "sqlite", { mode: 0o600 });
      const map = readProjectMapFile(home);
      writeFileSync(projectMapPath(home), JSON.stringify({ ...map, [otherHash]: { canonical: join(home, "other"), aliases: [] } }) + "\n", { mode: 0o600 });
      clearProjectMapCache();
      const refused = await runMigrationActivation(installation.input, deps);
      expect(refused.status, JSON.stringify(refused)).toBe("refused");
      expect(refused).toMatchObject({ status: "refused", step: "S4", reason: "uncovered-projects", effectBegun: false });
      expect(new MigrationManifestStore({ homeDir: home }).read(GENERATION_ID).phase).toBe("verified");
      expect(readActivationGenerationLink({ homeDir: home, generationId: GENERATION_ID }).state).toBe("authoritatively-absent");
      expect(readMigrationActivationEvidence({ homeDir: home, generationId: GENERATION_ID })).toEqual({ state: "authoritatively-absent" });
      expect(readConfigBackend(home)).toBe("sqlite");
      // The refused run released its S2 lease row (PR #1628 review).
      await expectProjectAcquirableByAnotherGeneration(db, deps, home, installation.remoteProjectId, roles.runtime);
      rmSync(join(projectsDir(home), otherHash), { recursive: true });
      writeFileSync(projectMapPath(home), JSON.stringify(map) + "\n", { mode: 0o600 });
      clearProjectMapCache();

      // A real third grantee holding a transfer-canonical column privilege is
      // refused by the OID-bound schema fingerprint while the canonical
      // transfer peer is explicitly admitted.
      await db.migrator.query(
        { text: "GRANT SELECT (project_id) ON TABLE lcm.message_parts TO lcm_test_runtime" },
        { domain: "factory", operation: "activationIntegrationThirdGrantee" },
      );
      const thirdGranteeProbe = new PostgreSqlRuntime(roles.runtime);
      try {
        await expect(verifyPostgreSqlRuntimeSchema(thirdGranteeProbe, {
          expectedOwner: EXPECTED_OWNER,
          admittedPeer: { role: TRANSFER_ROLE },
        })).rejects.toMatchObject({ reason: "schema-fingerprint" });
      } finally {
        await thirdGranteeProbe.close();
        await db.migrator.query(
          { text: "REVOKE SELECT (project_id) ON TABLE lcm.message_parts FROM lcm_test_runtime" },
          { domain: "factory", operation: "activationIntegrationThirdGranteeCleanup" },
        );
      }

      const runtimeAdmissions: string[] = [];
      const transferAdmissions: string[] = [];
      const auditedDeps: MigrationActivationDependencies = {
        ...deps,
        verifyRuntimeSchema: async (executor, options) => {
          const readiness = await deps.verifyRuntimeSchema(executor, options);
          runtimeAdmissions.push(readiness.runtimeRole);
          return readiness;
        },
        verifyTransferSchema: async (executor, options) => {
          const readiness = await deps.verifyTransferSchema(executor, options);
          transferAdmissions.push(readiness.runtimeRole);
          return readiness;
        },
      };
      const outcome = await runMigrationActivation(installation.input, auditedDeps);
      expect(outcome.status, JSON.stringify(outcome)).toBe("activated");
      expect(outcome).toMatchObject({
        status: "activated", resumedFrom: "fresh", successorFencingToken: null,
        identity: { generationId: GENERATION_ID, publicationId },
        restart: { status: "satisfied" },
      });
      if (outcome.status !== "activated") return;
      expect(runtimeAdmissions).toEqual([RUNTIME_ROLE, RUNTIME_ROLE]);
      expect(transferAdmissions).toEqual([TRANSFER_ROLE]);

      // The version-3 selection became the completed version-2 publication of postgresql.
      expect(readBackendMaintenanceJournal(home)).toBeNull();
      expect(readBackendPublicationJournal(home)).toMatchObject({
        phase: "completed", publicationId, sourceBackend: "sqlite", targetBackend: "postgresql",
      });
      expect(readConfigBackend(home)).toBe("postgresql");
      expect(readProjectMapFile(home)[installation.localProjectId]!.remoteProjectId).toBe(installation.remoteProjectId);
      const manifest = new MigrationManifestStore({ homeDir: home }).read(GENERATION_ID);
      expect(manifest).toMatchObject({ phase: "active", pendingEffect: null, revision: outcome.identity.manifestRevision });
      expect(manifest.reports.some((report) => report.kind === "activation" && report.reportSha256 === outcome.report.reportSha256)).toBe(true);

      // The activation report, stored and readable, names the stored evidence chain.
      const stored = readMigrationActivationReport({ homeDir: home, generationId: GENERATION_ID, reportSha256: outcome.report.reportSha256 });
      expect(stored.state).toBe("resolved");
      if (stored.state !== "resolved") return;
      expect(stored.report.body).toMatchObject({ generationId: GENERATION_ID, publicationId, manifestRevisionAtComplete: expect.any(Number) });

      // The generation link resolves to the sealed artifact under this publication.
      const link = readActivationGenerationLink({ homeDir: home, generationId: GENERATION_ID });
      expect(link).toMatchObject({ state: "resolved", link: { publicationId, identityDigest: stored.report.body.identityDigest } });

      // #626 evidence readback: one epoch, one attempt, one witness, and the
      // reader itself re-mints the witness from its stored pair (a witness
      // that does not reproduce makes the store unresolvable).
      const evidence = readMigrationActivationEvidence({ homeDir: home, generationId: GENERATION_ID });
      expect(evidence.state).toBe("resolved");
      if (evidence.state !== "resolved") return;
      expect(evidence.epochs).toHaveLength(1);
      expect(evidence.attempts).toHaveLength(1);
      expect(evidence.witnesses).toHaveLength(1);
      expect(evidence.epochs[0]!.epochId).toBe(stored.report.body.epochId);
      expect(evidence.attempts[0]).toMatchObject({ attemptId: stored.report.body.attemptId, epochId: stored.report.body.epochId });
      expect(evidence.witnesses[0]).toMatchObject({ kind: "activation", checksumSha256: stored.report.body.witnessChecksumSha256, attemptId: stored.report.body.attemptId });

      // #626 binding resolution: the activation's witness binding and selection binding.
      const bindings = resolveMigrationWitnessBindings({ homeDir: home, generationId: GENERATION_ID });
      expect(bindings).toMatchObject({
        state: "resolved",
        witnesses: [{ kind: "activation", witnessChecksumSha256: stored.report.body.witnessChecksumSha256 }],
        selections: [{ kind: "activation", publicationId, witnessChecksumSha256: stored.report.body.witnessChecksumSha256 }],
      });

      // Runtime health passes with the canonical transfer peer admitted, but
      // ordinary daemon readiness remains strict until that peer is revoked.
      const runtime = new PostgreSqlRuntime(roles.runtime);
      try {
        expect(await checkMigrationTargetHealth(
          { runtime, expectedOwner: EXPECTED_OWNER },
          { verifyRuntimeSchema: (executor, options) => verifyPostgreSqlRuntimeSchema(executor, {
            ...options,
            admittedPeer: { role: TRANSFER_ROLE },
          }) },
        )).toMatchObject({ status: "healthy", readiness: { runtimeRole: RUNTIME_ROLE, expectedOwner: EXPECTED_OWNER } });
        expect(await checkMigrationTargetHealth({ runtime, expectedOwner: EXPECTED_OWNER }))
          .toMatchObject({ status: "unhealthy", reason: "schema-mismatch" });
      } finally {
        await runtime.close();
      }

      const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
      try {
        await administrator.query(
          { text: "DROP OWNED BY " + TRANSFER_ROLE },
          { domain: "factory", operation: "activationIntegrationRevokeTransfer" },
        );
      } finally {
        await administrator.close();
      }
      const daemonRuntime = new PostgreSqlRuntime(roles.runtime);
      try {
        expect(await checkMigrationTargetHealth({
          runtime: daemonRuntime,
          expectedOwner: EXPECTED_OWNER,
        })).toMatchObject({
          status: "healthy",
          readiness: { runtimeRole: RUNTIME_ROLE },
        });
      } finally {
        await daemonRuntime.close();
      }
      // The activation's fenced lease on the project was taken and released by the drive's release phase.
      const leases = await db.migrator.query<{ operation: string; released: boolean }>({
        text: "SELECT operation, released_at IS NOT NULL AS released FROM lcm.fenced_leases "
          + "WHERE project_id = $1 AND operation LIKE 'backend-publication:postgresql:%'",
        values: [installation.remoteProjectId],
      }, { domain: "factory", operation: "activationIntegration" });
      expect(leases.rows.length).toBeGreaterThanOrEqual(1);
      expect(leases.rows.every((row) => row.released)).toBe(true);

      // A second call settles from durable state: same report, nothing re-driven.
      const settled = await runMigrationActivation(installation.input, deps);
      expect(settled).toMatchObject({ status: "activated", resumedFrom: "settled-active", identity: outcome.identity, report: outcome.report });
      const after = await previewMigrationActivation({ homeDir: home, generationId: GENERATION_ID });
      expect(after.checks.find((check) => check.name === "resume-point")).toMatchObject({ status: "ok", detail: "settled-active" });
      expect(after.checks.find((check) => check.name === "publication-journal")).toMatchObject({ status: "ok", detail: expect.stringContaining("(this generation)") });
    } finally {
      closeLcmConnection();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      await dropActivationRole(db);
    }
  });
}, 240_000);

/** The production coordinator with an observer that throws right after the
 * journal is written at the given version-2 phase: a crash in the release
 * tail, reproduced on the real coordinator and the real guard. */
function coordinatorCrashingAt(phase: string, home: string): MigrationActivationDependencies["createCoordinator"] {
  let crashed = false;
  const observer: BackendPublicationObserver = (event) => {
    if (crashed || event !== "after-journal-write") return;
    if (readBackendPublicationJournal(home)?.phase === phase) { crashed = true; throw new Error("injected coordinator crash at " + phase); }
  };
  return ({ homeDir, guard, machineId }) => createBackendPublicationCoordinator({
    homeDir,
    observer,
    remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId, ttlMs: MIGRATION_ACTIVATION_LEASE_TTL_MS }) },
  });
}

it("drives a publication that crashed at released, with its fence row gone, to completed on the retry (PR #1628 review: the release tail needs no own fence)", async () => {
  await withPostgreSqlTestDatabase("migration-activation-release-tail", async (db) => {
    const home = mkdtempSync(join(tmpdir(), "migration-activation-release-tail-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    try {
      const roles = await provisionActivationRole(db);
      const installation = await prepareVerifiedInstallation(db, home, roles.transfer, roles.runtime);
      await grantRuntimeActivationRole(db, roles.transfer);
      const publicationId = deriveActivationPublicationId(GENERATION_ID);
      const deps = createMigrationActivationDependencies({ homeDir: home });

      // Crash the real coordinator right after it journals "released": the
      // fences are released, the journal is one transition short of completed.
      await expect(runMigrationActivation(installation.input, { ...deps, createCoordinator: coordinatorCrashingAt("released", home) }))
        .rejects.toThrow("injected coordinator crash at released");
      expect(readBackendPublicationJournal(home)).toMatchObject({ phase: "released", publicationId });
      expect(readConfigBackend(home)).toBe("postgresql");

      // The released row is still there; remove it so the retry finds no row
      // of its own (the real guard keeps released rows, so a vanished row is
      // the only "absent" the orchestrator can meet on PostgreSQL).
      const removed = await db.migrator.query<{ count: string }>({
        text: "WITH removed AS (DELETE FROM lcm.fenced_leases WHERE project_id = $1 "
          + "AND operation LIKE 'backend-publication:postgresql:%' RETURNING 1) SELECT count(*)::text AS count FROM removed",
        values: [installation.remoteProjectId],
      }, { domain: "factory", operation: "activationIntegration" });
      expect(removed.rows).toEqual([{ count: "1" }]);

      // Before the fix this retry stopped at interrupted S13b lease-lost.
      const outcome = await runMigrationActivation(installation.input, deps);
      expect(outcome.status, JSON.stringify(outcome, (_key, value) => typeof value === "bigint" ? value.toString() : value)).toBe("activated");
      expect(outcome).toMatchObject({ status: "activated", resumedFrom: "publication-journal", successorFencingToken: null, identity: { generationId: GENERATION_ID, publicationId } });
      expect(readBackendPublicationJournal(home)).toMatchObject({ phase: "completed", publicationId });
      expect(new MigrationManifestStore({ homeDir: home }).read(GENERATION_ID)).toMatchObject({ phase: "active", pendingEffect: null });
      const leases = await db.migrator.query<{ count: string }>({
        text: "SELECT count(*)::text AS count FROM lcm.fenced_leases WHERE project_id = $1 AND operation LIKE 'backend-publication:postgresql:%'",
        values: [installation.remoteProjectId],
      }, { domain: "factory", operation: "activationIntegration" });
      expect(leases.rows).toEqual([{ count: "0" }]);
    } finally {
      closeLcmConnection();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      await dropActivationRole(db);
    }
  });
}, 240_000);
