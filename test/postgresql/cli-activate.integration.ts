import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { assertHarnessReady, withPostgreSqlTestDatabase } from "./harness.js";
import {
  GENERATION_ID,
  dropActivationRole,
  grantRuntimeActivationRole,
  prepareVerifiedInstallation,
  provisionActivationRole,
  readConfigBackend,
  readProjectMapFile,
} from "./migration-activation-fixture.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { performMigrationActivateCommand } from "../../src/migration/cli-activate.js";
import { performMigrationReportCommand } from "../../src/migration/cli-report.js";
import { performMigrationRollbackCommand } from "../../src/migration/cli-rollback.js";
import { performMigrationVerifyCommand } from "../../src/migration/cli-verify.js";
import { renderMigrationActivateEnvelope } from "../../src/migration/cli-render.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { readBackendMaintenanceJournal } from "../../src/storage/backend-publication.js";

beforeAll(assertHarnessReady);

/**
 * `lcm migration verify`, `activate`, `report` and `rollback --dry-run` through the CLI
 * commands against real PostgreSQL, with nothing seamed: the real SQLite
 * installation, the real copy, distinct canonical transfer and runtime roles, the
 * real configuration resolution (the destination secrets arrive as the
 * operator supplies them, through the environment, and are never written to
 * config.json), the real held identity, the real project-map witness, the
 * real verification lease, and #625's real production activation.
 *
 * The installation stops after the copy; the CLI verifies it (fresh, router
 * row 22) and activates it (row 24), and the report then reads the activation
 * and rollback evidence back through the lock-free readers.
 */
it(
  "verifies a copied generation fresh, then activates it through distinct real transfer and runtime roles",
  async () => {
    await withPostgreSqlTestDatabase("cli-activate-roundtrip", async (db) => {
      const home = mkdtempSync(join(tmpdir(), "cli-activate-roundtrip-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      try {
        const roles = await provisionActivationRole(db);
        const installation = await prepareVerifiedInstallation(
          db,
          home,
          roles.transfer,
          roles.runtime,
          { stopAfterCopy: true },
        );
        const cwd = installation.cwd;
        const manifests = new MigrationManifestStore({ homeDir: home });
        expect(manifests.read(GENERATION_ID).phase).toBe("copied");
        // The operator supplies the destination as the environment; nothing is in config.json.
        vi.stubEnv("LCM_POSTGRES_URL", roles.transfer.url);
        vi.stubEnv("LCM_POSTGRES_CA_FILE", roles.transfer.caFile);
        const common = { cwd, homeDir: home, generation: GENERATION_ID, confirmGenerationId: GENERATION_ID };

        // report names verify.
        expect(await performMigrationReportCommand({ homeDir: home })).toMatchObject({
          next: "verify", evidence: { cell: 22, snapshot: "complete", activationLink: "absent", generationBinding: "absent", rollbackEvidence: "absent" },
        });

        // verify --dry-run computes against PostgreSQL, takes and releases the lease, and records nothing.
        const dry = await performMigrationVerifyCommand({ ...common, dryRun: true });
        expect(dry).toMatchObject({
          status: "ok", applied: false, manifestPhase: "copied",
          evidence: { cell: 22, wouldBe: "clean", activationEligible: true, coordinationEffects: "verification-lease,source-append-barrier" },
        });
        expect(manifests.read(GENERATION_ID).phase).toBe("copied");

        // A missing token refuses at the fence with the home untouched.
        expect(await performMigrationVerifyCommand({ ...common, confirmGenerationId: undefined })).toEqual({
          status: "refuse", reason: "existing-confirmation-missing", generationId: GENERATION_ID,
        });

        // verify (fresh): the manifest reads verified with an eligible report, and activate is next.
        const verified = await performMigrationVerifyCommand(common);
        expect(verified, JSON.stringify(verified)).toMatchObject({
          status: "ok", applied: true, manifestPhase: "verified", next: "activate",
          evidence: { cell: 22, activationEligible: true },
        });
        expect(manifests.read(GENERATION_ID)).toMatchObject({ phase: "verified", activationEligible: true, pendingEffect: null });
        // The second call is the idempotent confirmation (cell 24), writing nothing.
        expect(await performMigrationVerifyCommand(common)).toMatchObject({ status: "ok", applied: false, evidence: { cell: 24 } });

        await grantRuntimeActivationRole(db);

        expect(await performMigrationReportCommand({ homeDir: home })).toMatchObject({ next: "activate", evidence: { cell: 24 } });

        // Both fences refuse before anything runs.
        const activate = { ...common, confirmBackend: "postgresql" };
        expect(await performMigrationActivateCommand({ ...activate, confirmBackend: undefined })).toMatchObject({ reason: "backend-confirmation-missing" });
        expect(await performMigrationActivateCommand({ ...activate, confirmBackend: "sqlite" })).toMatchObject({ reason: "backend-confirmation-moved" });
        expect(manifests.read(GENERATION_ID).phase).toBe("verified");
        expect(readConfigBackend(home)).toBe("sqlite");

        // The preview reads the persisted state and can never say yes.
        const preview = await performMigrationActivateCommand({ ...activate, dryRun: true });
        expect(preview).toMatchObject({
          status: "refuse", reason: "activation-dry-run-not-predictive",
          sections: { predictive: false, "check.manifest": "ok", "check.maintenance-journal": "ok" },
        });
        expect(renderMigrationActivateEnvelope(preview).exitCode).toBe(5);
        expect(manifests.read(GENERATION_ID).phase).toBe("verified");

        // rollback --dry-run is the route and the manifest only, and never exit 0.
        expect(await performMigrationRollbackCommand({ homeDir: home, ...{ generation: GENERATION_ID, confirmGenerationId: GENERATION_ID }, confirmBackend: "sqlite", dryRun: true }))
          .toMatchObject({ status: "refuse", reason: "rollback-dry-run-not-predictive", sections: { cell: 24 } });

        expect(await performMigrationActivateCommand(activate)).toMatchObject({
          status: "refuse",
          reason: "activation-runtime-target-missing",
        });
        vi.stubEnv("LCM_POSTGRES_RUNTIME_URL", roles.runtime.url);

        // activate: transfer copy/census plus runtime lease and health.
        const activated = await performMigrationActivateCommand(activate);
        expect(activated, JSON.stringify(activated)).toMatchObject({
          status: "ok", generationId: GENERATION_ID, manifestPhase: "active", applied: true,
          next: "revoke-transfer-grants-then-start-daemon", restart: { answer: "satisfied", presence: "absent" },
          evidence: { transferGrantRevocation: "required-before-daemon-start", resumedFrom: "fresh", selectedBackend: "postgresql" },
        });
        const envelope = renderMigrationActivateEnvelope(activated);
        expect(envelope).toMatchObject({ command: "activate", exitCode: 0, outcome: "ok", next: "revoke-transfer-grants-then-start-daemon" });
        expect(manifests.read(GENERATION_ID)).toMatchObject({ phase: "active", pendingEffect: null });
        expect(readBackendMaintenanceJournal(home)).toBeNull();
        expect(readConfigBackend(home)).toBe("postgresql");
        expect(readProjectMapFile(home)[installation.localProjectId]!.remoteProjectId).toBe(installation.remoteProjectId);
        // The secrets never reached config.json.
        const storedConfig = readFileSync(join(home, ".lcm", "config.json"), "utf8");
        expect(storedConfig).not.toContain(roles.transfer.url);
        expect(storedConfig).not.toContain(roles.runtime.url);

        // Re-running settles from durable state: nothing is re-driven.
        expect(await performMigrationActivateCommand(activate)).toMatchObject({
          status: "ok", applied: false, evidence: { resumedFrom: "settled-active", cell: 10 },
        });

        // report reads every activation and rollback reader, lock-free, and the restart cell is satisfied.
        const report = await performMigrationReportCommand({ homeDir: home, generation: GENERATION_ID });
        expect(report.reason).toBeUndefined();
        expect(report).toMatchObject({
          next: "report", restart: { answer: "satisfied", presence: "absent" },
          evidence: {
            cell: 10, activationLink: "present", activationReport: "present", generationBinding: "present",
            rollbackEvidence: "present", activationEpochs: 1, activationAttempts: 1, activationWitnesses: 1,
            rollbackReport: "none", rollbackAuthority: "absent", selectedBackend: "postgresql",
          },
        });

        // rollback runs the production entry point against the configured role. The transfer role does not
        // pass the daemon's readiness (transfer grants remain), so it refuses closed and changes
        // nothing: the manifest stays active and no write is claimed.
        const rollback = await performMigrationRollbackCommand({
          homeDir: home, generation: GENERATION_ID, confirmGenerationId: GENERATION_ID, confirmBackend: "sqlite",
        });
        expect(rollback).toMatchObject({
          status: "refuse", reason: "rollback-refused-evidence", sections: { cell: 10, rollbackReason: "unexpected-state" },
        });
        expect(rollback).not.toHaveProperty("applied");
        expect(manifests.read(GENERATION_ID)).toMatchObject({ phase: "active", pendingEffect: null });
      } finally {
        closeLcmConnection();
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
        await dropActivationRole(db);
      }
    });
  },
  300_000,
);


it(
  "refuses a foreign publication lease before any write: a decodable row is exit 4 refused-contention, an undecodable row is exit 5 refused-evidence, and neither claims applied",
  async () => {
    await withPostgreSqlTestDatabase("cli-activate-lease", async (db) => {
      const home = mkdtempSync(join(tmpdir(), "cli-activate-lease-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      try {
        const transfer = await provisionActivationRole(db);
        const installation = await prepareVerifiedInstallation(db, home, transfer);
        vi.stubEnv("LCM_POSTGRES_URL", transfer.url);
        vi.stubEnv("LCM_POSTGRES_CA_FILE", transfer.caFile);
        const manifests = new MigrationManifestStore({ homeDir: home });
        const activate = { cwd: installation.cwd, homeDir: home, generation: GENERATION_ID, confirmGenerationId: GENERATION_ID, confirmBackend: "postgresql" };
        const seedForeign = (operation: string, publicationId: string) => db.migrator.query({
          text: "INSERT INTO lcm.fenced_leases (project_id, resource_type, resource_key, owner_machine_id, owner_process_id, operation, expires_at) "
            + "VALUES ($1, 'backend-publication', 'selection', $2, $3, $4, statement_timestamp() + interval '10 minutes') "
            + "ON CONFLICT (project_id, resource_type, resource_key) DO UPDATE SET owner_process_id = EXCLUDED.owner_process_id, operation = EXCLUDED.operation",
          values: [installation.remoteProjectId, installation.machineId, publicationId, operation],
        }, { domain: "factory", operation: "seedForeignPublicationLease" });
        const expectUntouched = () => {
          expect(manifests.read(GENERATION_ID)).toMatchObject({ phase: "verified", pendingEffect: null });
          expect(readConfigBackend(home)).toBe("sqlite");
        };

        // A decodable unreleased lease of another publication generation: the documented contention class.
        await seedForeign("backend-publication:postgresql:" + "f".repeat(64), "someone-else");
        const contended = await performMigrationActivateCommand(activate);
        expect(contended, JSON.stringify(contended)).toMatchObject({
          status: "refuse", reason: "activation-refused-contention", sections: { activationStep: "S2", activationReason: "lease-conflict", effectBegun: false },
        });
        expect(contended).not.toHaveProperty("applied");
        expect(renderMigrationActivateEnvelope(contended).exitCode).toBe(4);
        expectUntouched();

        // The same row with an operation the guard cannot decode (the #628 rehearsal shape): refused-evidence, not an unexpected failure.
        await seedForeign("rehearsal-contention", "rehearsal-competing-owner");
        const undecodable = await performMigrationActivateCommand(activate);
        expect(undecodable, JSON.stringify(undecodable)).toMatchObject({
          status: "refuse", reason: "activation-refused-evidence", sections: { activationStep: "S2", activationReason: "lease-unresolvable", effectBegun: false },
        });
        expect(undecodable).not.toHaveProperty("applied");
        expect(renderMigrationActivateEnvelope(undecodable).exitCode).toBe(5);
        expectUntouched();
      } finally {
        closeLcmConnection();
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
        await dropActivationRole(db);
      }
    });
  },
  300_000,
);
