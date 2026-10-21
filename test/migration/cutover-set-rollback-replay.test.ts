import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lcmHomeDir } from "../../src/runtime-paths.js";
import { projectMapPath, clearProjectMapCache } from "../../src/project-map.js";
import { backendPublicationJournalPath, readBackendMaintenanceJournal, readBackendPublicationJournal } from "../../src/storage/backend-publication.js";
import { performMigrationAbort } from "../../src/migration/abort.js";
import { prepareCutoverSet, resolveCutoverSetCandidate } from "../../src/migration/cutover-set-prepare.js";
import { activationArtifactPath } from "../../src/migration/activation-artifact-store.js";
import { readCutoverSetActivationRecords } from "../../src/migration/cutover-set-activation-store.js";
import { migrationCutoverSetRollbackDirectory, readCutoverSetRollbackRecords } from "../../src/migration/cutover-set-rollback-store.js";
import { migrationSelectionBindingPath, recordMigrationSelectionBinding } from "../../src/migration/generation-binding-store.js";
import { deriveRollbackPublicationId } from "../../src/migration/rollback.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { MACHINE, cleanupRoots, expectActivated } from "./cutover-set-activate-fixture.js";
import { expectRolledBack, rollbackFixture, writeConfig, type RollbackFixture } from "./cutover-set-rollback-fixture.js";

/**
 * Replay authority across a set rollback (#1550 C3, D7) and the mutual
 * exclusion of the forward paths (D7, C4): a rollback commitment fences every
 * member's old activation evidence immediately; nothing is admitted until the
 * reverse publication completes; afterwards only the member's rollback witness
 * admits sqlite; the forward activation, preparation and abort refuse a
 * committed or held set rollback without touching it.
 */

vi.setConfig({ testTimeout: 120_000 });
afterEach(cleanupRoots);

function activationWitness(f: RollbackFixture, index: number): string {
  const records = readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.originalSetId });
  if (records.state !== "resolved" || records.selection === null) throw new Error("activation records missing");
  return records.selection.members[index]!.witnessChecksumSha256;
}

function rollbackWitness(f: RollbackFixture, index: number): string | null {
  const records = readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId });
  if (records.state !== "resolved" || records.selection === null) return null;
  return records.selection.members[index]!.witnessChecksumSha256;
}

function activationEpoch(f: RollbackFixture, index: number): Readonly<{ epochId: string; attemptId: string }> {
  const records = readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.originalSetId });
  if (records.state !== "resolved" || records.selection === null) throw new Error("activation records missing");
  return records.selection.members[index]!;
}

const refused = (f: RollbackFixture, index: number, evidence: string, detail?: string) =>
  expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: f.members[index]!.generationId, evidenceSha256: evidence }))
    .toThrow(expect.objectContaining({ reason: "unresolved-publication", ...(detail === undefined ? {} : { message: expect.stringContaining(detail) }) }));
const admitted = (f: RollbackFixture, index: number, evidence: string, backend: string) =>
  expect(assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: f.members[index]!.generationId, evidenceSha256: evidence })).toEqual({ backend, disposition: "selected" });

async function crashAt(f: RollbackFixture, point: string): Promise<void> {
  await expect(f.run({ crashPoint: (p) => { if (p === point) throw new Error("crash at " + point); } })).rejects.toThrow("crash at " + point);
}

describe("replay across a set rollback", () => {
  it("admits postgresql before the commitment, refuses everything from the checkpoint to the completed reverse publication, then admits only the rollback witness", async () => {
    const f = await rollbackFixture();
    admitted(f, 0, activationWitness(f, 0), "postgresql");
    await crashAt(f, "after-artifact");
    // An orphan artifact is no commitment.
    admitted(f, 0, activationWitness(f, 0), "postgresql");
    await crashAt(f, "after-checkpoint");
    // The checkpoint fences the old evidence while the activation publication is still live and the manifests active.
    expect(readBackendPublicationJournal(f.homeDir)).toMatchObject({ phase: "completed", publicationId: f.originalSetId });
    refused(f, 0, activationWitness(f, 0), "selection is not frozen");
    refused(f, 1, activationWitness(f, 1));
    for (const point of ["after-hold", "after-prepare-complete:" + f.members[0]!.generationId, "after-install-record:" + f.members[1]!.generationId, "after-selection-frozen"]) {
      await crashAt(f, point);
      refused(f, 0, activationWitness(f, 0));
      const witness = rollbackWitness(f, 0);
      if (witness !== null) refused(f, 0, witness);
    }
    await crashAt(f, "after-selection-completed");
    refused(f, 0, rollbackWitness(f, 0)!);
    // A linked set member carrying a bare (single-generation shaped) rollback binding still resolves through the
    // aggregate: the commitment decides before any binding is consulted, so the bare index admits nothing.
    const bare = f.members[0]!;
    recordMigrationSelectionBinding({
      homeDir: f.homeDir, generationId: bare.generationId,
      binding: {
        kind: "rollback", epochId: activationEpoch(f, 0).epochId, attemptId: activationEpoch(f, 0).attemptId,
        manifestRevision: f.activation.manifestStore.read(bare.generationId).revision, witnessChecksumSha256: rollbackWitness(f, 0)!,
        publicationId: deriveRollbackPublicationId(bare.generationId),
      },
    });
    refused(f, 0, rollbackWitness(f, 0)!);
    rmSync(migrationSelectionBindingPath(f.homeDir, bare.generationId, "rollback"));
    await crashAt(f, "after-prepare");
    refused(f, 0, rollbackWitness(f, 0)!, "reverse publication is at phase prepared");
    refused(f, 1, activationWitness(f, 1), "not the member's rollback witness");
    await crashAt(f, "after-drive");
    // The completed reverse publication admits every member's rollback witness through the aggregate, even with reports pending.
    expect(readBackendPublicationJournal(f.homeDir)).toMatchObject({ phase: "completed", publicationId: f.setId });
    admitted(f, 0, rollbackWitness(f, 0)!, "sqlite");
    admitted(f, 1, rollbackWitness(f, 1)!, "sqlite");
    refused(f, 0, activationWitness(f, 0), "not the member's rollback witness");
    expectRolledBack(f, await f.run(), "publication-journal");
    admitted(f, 1, rollbackWitness(f, 1)!, "sqlite");
    refused(f, 1, activationWitness(f, 1));
  });

  it("falls back to member evidence under a later hold only when every member is rolled back and sqlite is selected", async () => {
    const f = await rollbackFixture();
    expectRolledBack(f, await f.run(), "fresh");
    const witness = rollbackWitness(f, 0)!;
    await f.activation.coordinator().enterMaintenance({
      publicationId: "later-generation", generationId: "later-generation", sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "b".repeat(64) }], now: new Date("2026-10-22T00:00:00.000Z"),
    });
    expect(readBackendMaintenanceJournal(f.homeDir)).toMatchObject({ generationId: "later-generation" });
    admitted(f, 0, witness, "sqlite");
    refused(f, 0, activationWitness(f, 0));
    // A later postgresql selection, or a rebound member, refuses the old rollback replay.
    writeConfig(f.homeDir, "postgresql");
    refused(f, 0, witness, "selects postgresql");
    writeConfig(f.homeDir, "sqlite");
    const map = JSON.parse(readFileSync(projectMapPath(f.homeDir), "utf8")) as Record<string, Record<string, unknown>>;
    const rebound = { ...map, [f.members[1]!.localProjectId]: { ...map[f.members[1]!.localProjectId], remoteProjectId: f.members[1]!.remoteProjectId } };
    writeFileSync(projectMapPath(f.homeDir), JSON.stringify(rebound) + "\n", { mode: 0o600 });
    clearProjectMapCache();
    refused(f, 0, witness, "still bound to a destination project");
    writeFileSync(projectMapPath(f.homeDir), JSON.stringify(map) + "\n", { mode: 0o600 });
    clearProjectMapCache();
    admitted(f, 0, witness, "sqlite");
  });

  it("refuses under a later hold while a member is not rolled back, and refuses unresolvable or tampered rollback records", async () => {
    const f = await rollbackFixture();
    await crashAt(f, "after-complete:" + f.members[0]!.generationId);
    await f.activation.coordinator().enterMaintenance({
      publicationId: "later-generation", generationId: "later-generation", sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "b".repeat(64) }], now: new Date("2026-10-22T00:00:00.000Z"),
    });
    refused(f, 0, rollbackWitness(f, 0)!, f.members[1]!.generationId + " is at phase rolling-back");
    const directory = migrationCutoverSetRollbackDirectory(f.homeDir, f.originalSetId);
    const checkpoint = readFileSync(join(directory, "checkpoint.json"));
    writeFileSync(join(directory, "checkpoint.json"), "{}\n", { mode: 0o600 });
    refused(f, 0, rollbackWitness(f, 0) ?? activationWitness(f, 0), "rollback commitment cannot be resolved");
    writeFileSync(join(directory, "checkpoint.json"), checkpoint, { mode: 0o600 });
  });

  it("refuses a linked member whose rollback store vanished, and keeps the single-generation answer for an unrelated generation", async () => {
    const f = await rollbackFixture();
    expectRolledBack(f, await f.run(), "fresh");
    const witness = rollbackWitness(f, 0)!;
    const directory = migrationCutoverSetRollbackDirectory(f.homeDir, f.originalSetId);
    // The whole rollback store gone: the member's link still names the set, whose rollback commitment is now positively
    // absent, so its surviving aggregate rollback binding indexes nothing and admits nothing (D7.5).
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
    refused(f, 0, witness, "commitment is absent");
    refused(f, 0, activationWitness(f, 0));
    expect(readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId })).toEqual({ state: "authoritatively-absent" });
    // An unrelated generation keeps the single-generation answer through its own rollback binding.
    recordMigrationSelectionBinding({
      homeDir: f.homeDir, generationId: "other-generation",
      binding: { kind: "rollback", epochId: "e".repeat(64), attemptId: "a".repeat(64), manifestRevision: 3, witnessChecksumSha256: "c".repeat(64), publicationId: (await import("../../src/migration/rollback.js")).deriveRollbackPublicationId("other-generation") },
    });
    expect(assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: "other-generation", evidenceSha256: "c".repeat(64) })).toEqual({ backend: "sqlite", disposition: "selected" });
  });

  it("refuses the member-evidence fallback when a report is missing or names another witness", async () => {
    const f = await rollbackFixture();
    expectRolledBack(f, await f.run(), "fresh");
    const witness = rollbackWitness(f, 0)!;
    await f.activation.coordinator().enterMaintenance({
      publicationId: "later-generation", generationId: "later-generation", sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "b".repeat(64) }], now: new Date("2026-10-22T00:00:00.000Z"),
    });
    const manifest = f.activation.manifestStore.read(f.members[1]!.generationId);
    const ref = manifest.reports.filter((report) => report.kind === "rollback").at(-1)!;
    const path = join(lcmHomeDir(f.homeDir), "migration-reports", f.members[1]!.generationId, ref.reportId + ".json");
    const content = readFileSync(path);
    chmodSync(path, 0o600);
    writeFileSync(path, content.toString("utf8").replace(/"mode":"[a-z-]+"/u, '"mode":"none"'));
    chmodSync(path, 0o400);
    refused(f, 0, witness, "rollback report cannot be read");
    chmodSync(path, 0o600);
    writeFileSync(path, content);
    chmodSync(path, 0o400);
    admitted(f, 0, witness, "sqlite");
  });

  it("refuses an aborted rollback hold, a reverse publication whose artifact is unresolvable, absent or not covered, and a member-evidence fallback whose manifest, report or installation cannot be trusted", async () => {
    const f = await rollbackFixture();
    await crashAt(f, "after-selection-frozen");
    const held = readBackendMaintenanceJournal(f.homeDir)!;
    await f.activation.coordinator().abortMaintenance({ expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: "e".repeat(64) });
    refused(f, 0, rollbackWitness(f, 0)!, "rollback hold is at phase maintenance-aborted");
    const g = await rollbackFixture();
    await crashAt(g, "after-drive");
    const witness = rollbackWitness(g, 0)!;
    const projects = (JSON.parse(readFileSync(backendPublicationJournalPath(g.homeDir), "utf8")) as { projects: unknown[] }).projects;
    g.activation.rewriteJournal((payload) => { payload.projects = projects.slice(0, 1); });
    refused(g, 0, witness, "does not cover exactly the reverse artifact's projects");
    g.activation.rewriteJournal((payload) => { payload.projects = projects; });
    admitted(g, 0, witness, "sqlite");
    const rollbackRecords = readCutoverSetRollbackRecords({ homeDir: g.homeDir, originalSetId: g.originalSetId });
    if (rollbackRecords.state !== "resolved") throw new Error("rollback records missing");
    const artifact = activationArtifactPath(g.homeDir, rollbackRecords.checkpoint.identityDigest);
    const sealed = readFileSync(artifact);
    const mode = statSync(artifact).mode & 0o777;
    chmodSync(artifact, 0o600);
    writeFileSync(artifact, "not an artifact\n");
    chmodSync(artifact, mode);
    refused(g, 0, witness, "reverse artifact is unresolvable");
    renameSync(artifact, artifact + ".away");
    refused(g, 0, witness, "reverse artifact is absent");
    renameSync(artifact + ".away", artifact);
    chmodSync(artifact, 0o600);
    writeFileSync(artifact, sealed);
    chmodSync(artifact, mode);
    admitted(g, 0, witness, "sqlite");
    const h = await rollbackFixture();
    expectRolledBack(h, await h.run(), "fresh");
    const own = rollbackWitness(h, 0)!;
    await h.activation.coordinator().enterMaintenance({
      publicationId: "later-generation", generationId: "later-generation", sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "b".repeat(64) }], now: new Date("2026-10-22T00:00:00.000Z"),
    });
    admitted(h, 0, own, "sqlite");
    const generation = join(lcmHomeDir(h.homeDir), "migrations", h.members[1]!.generationId);
    const generationMode = statSync(generation).mode & 0o777;
    chmodSync(generation, 0);
    refused(h, 0, own, "manifest cannot be read");
    chmodSync(generation, generationMode);
    // Member 1's report path carrying member 0's (self-consistent) report names another witness.
    const reportPath = (index: number) => {
      const manifest = h.activation.manifestStore.read(h.members[index]!.generationId);
      const ref = manifest.reports.filter((report) => report.kind === "rollback").at(-1)!;
      return join(lcmHomeDir(h.homeDir), "migration-reports", h.members[index]!.generationId, ref.reportId + ".json");
    };
    const original = readFileSync(reportPath(1));
    chmodSync(reportPath(1), 0o600);
    writeFileSync(reportPath(1), readFileSync(reportPath(0)));
    chmodSync(reportPath(1), 0o400);
    refused(h, 0, own, "does not name its frozen witness");
    chmodSync(reportPath(1), 0o600);
    writeFileSync(reportPath(1), original);
    chmodSync(reportPath(1), 0o400);
    admitted(h, 0, own, "sqlite");
    const config = join(lcmHomeDir(h.homeDir), "config.json");
    writeFileSync(config, "{}\n", { mode: 0o600 });
    refused(h, 0, own, "the configuration selects , not the restored sqlite installation");
    chmodSync(config, 0o200);
    refused(h, 0, own, "selected installation cannot be read");
    chmodSync(config, 0o600);
    writeConfig(h.homeDir, "sqlite");
    admitted(h, 0, own, "sqlite");
  });
});

describe("the forward paths refuse a committed or held set rollback", () => {
  it("activateCutoverSet refuses a set with a rollback checkpoint and never republishes it", async () => {
    const f = await rollbackFixture();
    await crashAt(f, "after-checkpoint");
    const outcome = await f.activation.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S0", reason: "cutover-set-rollback-committed", effectBegun: false });
    expect(readBackendPublicationJournal(f.homeDir)).toMatchObject({ phase: "completed", publicationId: f.originalSetId });
    await crashAt(f, "after-selection-completed");
    expect(await f.activation.run()).toMatchObject({ status: "refused", reason: "cutover-set-rollback-committed" });
    expect(readBackendMaintenanceJournal(f.homeDir)).toMatchObject({ phase: "selection-completed", generationId: f.setId });
    expectRolledBack(f, await f.run(), "selection-completed");
    expect(await f.activation.run()).toMatchObject({ status: "refused", reason: "cutover-set-rollback-committed" });
    const directory = migrationCutoverSetRollbackDirectory(f.homeDir, f.originalSetId);
    writeFileSync(join(directory, "checkpoint.json"), "{}\n", { mode: 0o600 });
    expect(await f.activation.run()).toMatchObject({ status: "refused", reason: "cutover-set-rollback-committed", detail: expect.stringContaining("unresolvable") });
  });

  it("the migration abort refuses the postgresql-origin rollback hold before any write", async () => {
    const f = await rollbackFixture();
    await crashAt(f, "after-prepare-complete:" + f.members[0]!.generationId);
    const journal = readBackendMaintenanceJournal(f.homeDir)!;
    expect(journal).toMatchObject({ phase: "maintenance-held", sourceBackend: "postgresql", generationId: f.setId });
    const outcome = await performMigrationAbort({ homeDir: f.homeDir, coordinator: f.activation.coordinator(), journal, abortEvidenceSha256: "d".repeat(64) });
    expect(outcome).toEqual({ status: "refuse", evidence: "journal-rollback-hold", mutated: false });
    expect(readBackendMaintenanceJournal(f.homeDir)).toEqual(journal);
    expect(f.activation.manifestStore.read(f.members[0]!.generationId).phase).toBe("rolling-back");
    expectRolledBack(f, await f.run(), "held");
  });

  it("the set preparation refuses a postgresql-origin set hold as a rollback in progress", async () => {
    const f = await rollbackFixture();
    await crashAt(f, "after-hold");
    const candidate = await resolveCutoverSetCandidate({ homeDir: f.homeDir, targetConfig: f.activation.input.targetConfig });
    expect(candidate).toMatchObject({ status: "refuse", reason: "cutover-set-rollback-held", evidence: f.setId });
    const prepared = await prepareCutoverSet({ homeDir: f.homeDir, confirmSetId: f.setId, targetConfig: f.activation.input.targetConfig, maxRecords: 10, maxBytes: 1024 });
    expect(prepared).toMatchObject({ status: "refuse", reason: "cutover-set-rollback-held" });
    expect(readBackendMaintenanceJournal(f.homeDir)).toMatchObject({ phase: "maintenance-held", sourceBackend: "postgresql" });
    expectRolledBack(f, await f.run(), "held");
    expect(expectActivated).toBeDefined();
  });
});

