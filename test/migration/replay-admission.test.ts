/**
 * Replay admission routes from durable authority (plan-v3.2 A15). Every case
 * drives a REAL BackendPublicationCoordinator through a maintenance selection
 * and then through the coordinator's own archival of the terminal maintenance
 * journal (a later publication prepare), so the live slot no longer answers;
 * the real replay-admission API is then read with nothing but files on disk.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackendPublicationCoordinator,
  readBackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { deriveActivationPublicationId } from "../../src/migration/activation-publication-id.js";
import {
  migrationGenerationBindingDirectory,
  recordMigrationSelectionBinding,
} from "../../src/migration/generation-binding-store.js";
import { MigrationManifestStore, migrationManifestGenerationDirectory } from "../../src/migration/manifest-store.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  type MigrationStorageWitness,
} from "../../src/migration/protocol.js";
import { publicationMaterial, workingPublicationDriver } from "../fixtures/backend-publication-driver.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const GENERATION_ID = "generation-1";
const AT = "2026-09-06T00:00:00.000Z";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-replay-admission-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function maintenanceCoordinator(homeDir: string): BackendPublicationCoordinator {
  const unexpected = async (): Promise<never> => { throw new Error("the publication driver must not run for maintenance"); };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected, publishProjectMap: unexpected, publishConfig: unexpected,
    restoreConfig: unexpected, restoreProjectMap: unexpected,
  };
  return new BackendPublicationCoordinator({ homeDir, driver });
}

/** Enters maintenance and selects `backend` with `evidence`, completing the selection. */
async function selectBackend(homeDir: string, backend: "postgresql" | "sqlite", evidence: string, generationId = GENERATION_ID) {
  const coordinator = maintenanceCoordinator(homeDir);
  const held = await coordinator.enterMaintenance({
    publicationId: "publication-" + backend,
    generationId,
    sourceSelectionSha256: HASH_A,
    queueEvidenceSha256: HASH_B,
    roster: [{ machineId: MACHINE_ID, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A }],
    now: new Date(AT),
  });
  const prepared = await coordinator.prepareMaintenanceSelection({
    expectedChecksumSha256: held.checksumSha256, generationId, targetBackend: backend, terminalEvidenceSha256: evidence,
  });
  await coordinator.completeMaintenanceSelection({
    expectedChecksumSha256: prepared.checksumSha256, generationId, terminalEvidenceSha256: evidence,
  });
}

/** The coordinator's own archival: a later publication prepare moves the terminal maintenance journal out of the live slot. */
async function archiveMaintenanceJournal(homeDir: string): Promise<void> {
  const material = publicationMaterial();
  const pub = new BackendPublicationCoordinator({ homeDir, driver: workingPublicationDriver(material) });
  await pub.prepare({
    publicationId: "later-publication",
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    material,
    projects: [{ localProjectId: "local-project", remoteProjectId: "remote-project", evidenceSha256: HASH_C }],
    now: new Date(AT),
  });
  expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
}

function recordSelection(homeDir: string, kind: "activation" | "rollback", evidence: string, manifestRevision: number): void {
  recordMigrationSelectionBinding({
    homeDir, generationId: GENERATION_ID,
    binding: {
      kind, epochId: "epoch-1", attemptId: "attempt-1", manifestRevision,
      witnessChecksumSha256: evidence, publicationId: kind === "activation" ? deriveActivationPublicationId(GENERATION_ID) : "publication-" + kind,
    },
  });
}

function witness(backend: "sqlite" | "postgresql"): MigrationStorageWitness {
  return { version: 1, backend, identitySha256: (backend === "sqlite" ? "1" : "4").repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt: AT };
}

/**
 * A manifest driven to phase rolled-back (or, with `complete` false, left with the publish effect pending; with
 * `stopAt` "prepared", left at rolling-back between the two effects, with none pending).
 */
function manifestRolledBack(homeDir: string, complete = true, stopAt: "published" | "prepared" = "published"): void {
  const store = new MigrationManifestStore({ homeDir });
  let m = store.create(createMigrationManifest({
    generationId: GENERATION_ID, source: witness("sqlite"), destination: witness("postgresql"), parentGenerationId: null,
    preservedSourceGenerationId: GENERATION_ID, createdAt: AT,
  }));
  const step = (kind: string, completion: Record<string, unknown> = {}, finish = true) => {
    m = store.update(GENERATION_ID, m.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: kind as never, effectId: kind, inputSha256: HASH_A, startedAt: AT,
    }));
    if (finish) m = store.update(GENERATION_ID, m.checksumSha256, (c) => completeMigrationEffect(c, { effectId: kind, completedAt: AT, ...completion }));
  };
  step("verify-dry-run", { report: { kind: "dry-run", reportId: "r1", reportSha256: HASH_B, createdAt: AT } });
  step("copy-batch", { checkpoint: { domain: "conversations", ordinal: 1, recordCount: 1, sourceCheckpointSha256: HASH_C, destinationCommitSha256: HASH_A } });
  step("complete-copy");
  step("verify-generation", { report: { kind: "verification", reportId: "r2", reportSha256: HASH_B, createdAt: AT }, activationEligible: true });
  step("prepare-rollback");
  if (stopAt === "prepared") return;
  step("publish-rollback", {
    report: { kind: "rollback", reportId: "r3", reportSha256: HASH_B, createdAt: AT }, rollbackMode: "pre-write",
  }, complete);
}

const replay = (homeDir: string, evidenceSha256: string) =>
  assertMigrationReplayAdmission({ homeDir, generationId: GENERATION_ID, evidenceSha256 });

describe("assertMigrationReplayAdmission routes from durable authority (A15)", () => {
  it("admits a published activation as postgresql after the coordinator archived the maintenance journal", async () => {
    const homeDir = home();
    await selectBackend(homeDir, "postgresql", HASH_A);
    recordSelection(homeDir, "activation", HASH_A, 5);
    await archiveMaintenanceJournal(homeDir);
    expect(replay(homeDir, HASH_A)).toEqual({ backend: "postgresql", disposition: "selected" });
    expect(() => replay(homeDir, HASH_B)).toThrow("no authoritative terminal");
  });

  it.each(["post-write", "pre-write"])("admits a %s rollback as sqlite, the later rollback selection deciding over the activation", async () => {
    const homeDir = home();
    recordSelection(homeDir, "activation", HASH_A, 5);
    await selectBackend(homeDir, "sqlite", HASH_B);
    recordSelection(homeDir, "rollback", HASH_B, 9);
    await archiveMaintenanceJournal(homeDir);
    expect(replay(homeDir, HASH_B)).toEqual({ backend: "sqlite", disposition: "selected" });
    // The activation's evidence is stale once the rollback selection is recorded.
    expect(() => replay(homeDir, HASH_A)).toThrow("no authoritative terminal");
  });

  it("falls back to the activation selection when the rollback selection was never recorded: the window A16a closes", async () => {
    const homeDir = home();
    recordSelection(homeDir, "activation", HASH_A, 5);
    await selectBackend(homeDir, "sqlite", HASH_B);
    await archiveMaintenanceJournal(homeDir);
    expect(() => replay(homeDir, HASH_B)).toThrow("no authoritative terminal");
    expect(replay(homeDir, HASH_A)).toEqual({ backend: "postgresql", disposition: "selected" });
  });

  it("refuses a rolled-back manifest with no selection binding (no supported path produces one; the rollback re-run restores the binding)", async () => {
    const homeDir = home();
    manifestRolledBack(homeDir);
    await selectBackend(homeDir, "sqlite", HASH_B);
    await archiveMaintenanceJournal(homeDir);
    for (const evidence of [HASH_B, HASH_A]) {
      expect(() => replay(homeDir, evidence)).toThrow(expect.objectContaining({
        reason: "unexpected-state", message: expect.stringContaining("records no selection binding"),
      }));
    }
  });

  it("refuses between archival and manifest completion: a pending publish effect is not rolled-back", async () => {
    const homeDir = home();
    manifestRolledBack(homeDir, false);
    await selectBackend(homeDir, "sqlite", HASH_B);
    await archiveMaintenanceJournal(homeDir);
    expect(() => replay(homeDir, HASH_B)).toThrow(/no authoritative terminal|does not match/u);
  });

  it("refuses a rolled-back-looking journal with no manifest and no bindings once archived", async () => {
    const homeDir = home();
    await selectBackend(homeDir, "sqlite", HASH_B);
    await archiveMaintenanceJournal(homeDir);
    expect(() => replay(homeDir, HASH_B)).toThrow("does not match a terminal maintenance generation");
  });

  it("refuses a manifest that is not at rolled-back even though no effect is pending (rolling-back between its effects)", async () => {
    const homeDir = home();
    manifestRolledBack(homeDir, true, "prepared");
    await selectBackend(homeDir, "sqlite", HASH_B);
    await archiveMaintenanceJournal(homeDir);
    expect(() => replay(homeDir, HASH_B)).toThrow("does not match a terminal maintenance generation");
  });

  it("decides from a selection-completed journal still in the live slot only for its own terminal evidence", async () => {
    const homeDir = home();
    await selectBackend(homeDir, "postgresql", HASH_A);
    expect(replay(homeDir, HASH_A)).toEqual({ backend: "postgresql", disposition: "selected" });
    expect(() => replay(homeDir, HASH_B)).toThrow("no authoritative terminal");
  });

  it("refuses while this generation's maintenance is live and non-terminal, whatever the durable record says", async () => {
    const homeDir = home();
    manifestRolledBack(homeDir);
    recordSelection(homeDir, "activation", HASH_A, 5);
    await maintenanceCoordinator(homeDir).enterMaintenance({
      publicationId: "publication-held", generationId: GENERATION_ID, sourceSelectionSha256: HASH_A,
      queueEvidenceSha256: HASH_B, roster: [{ machineId: MACHINE_ID, queueCutoff: null, evidenceSha256: HASH_A }], now: new Date(AT),
    });
    expect(() => replay(homeDir, HASH_A)).toThrow("no authoritative terminal");
  });

  it("refuses when the binding store cannot be resolved", async () => {
    const homeDir = home();
    manifestRolledBack(homeDir);
    recordSelection(homeDir, "activation", HASH_A, 5);
    writeFileSync(join(migrationGenerationBindingDirectory(homeDir, GENERATION_ID), "stray.txt"), "x", { mode: 0o600 });
    await selectBackend(homeDir, "sqlite", HASH_B);
    await archiveMaintenanceJournal(homeDir);
    expect(() => replay(homeDir, HASH_B)).toThrow("selection bindings cannot be resolved");
  });

  it("refuses when the manifest exists but cannot be read, with no bindings recorded", async () => {
    const homeDir = home();
    manifestRolledBack(homeDir);
    writeFileSync(join(migrationManifestGenerationDirectory(GENERATION_ID, homeDir), "head.json"), "{corrupt", { mode: 0o600 });
    await selectBackend(homeDir, "sqlite", HASH_B);
    await archiveMaintenanceJournal(homeDir);
    expect(() => replay(homeDir, HASH_B)).toThrow("migration manifest cannot be read");
  });
});
