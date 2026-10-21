import { afterEach, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BackendPublicationJournalError,
  backendCutoverSetSelectionSha256,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  rebindBackendMaintenanceCutoff,
  resolveBackendMaintenanceGenerationBinding,
  withBackendPublicationAppendBarrierAsync,
  type BackendCutoverSetSelection,
} from "../../src/storage/backend-publication.js";
import { PostgreSqlBackendPublicationGuardError } from "../../src/storage/postgresql/publication-guard.js";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";
import { activateCutoverSet } from "../../src/migration/cutover-set-activate.js";
import {
  CutoverSetActivationRecordError,
  createCutoverSetActivationCheckpoint,
  migrationCutoverSetActivationDirectory,
  readCutoverSetActivationRecords,
  recordCutoverSetActivationCheckpoint,
} from "../../src/migration/cutover-set-activation-store.js";
import {
  ActivationArtifactIdentityMismatchError,
  ActivationArtifactPresenceUnresolvableError,
  ActivationArtifactValidationError,
  ActivationGenerationLinkConflictError,
  publishActivationArtifact,
  readActivationArtifact,
  recordActivationGenerationLink,
} from "../../src/migration/activation-artifact-store.js";
import { MigrationActivationEvidenceRefusalError } from "../../src/migration/activation-evidence-store.js";
import { MigrationBindingConflictError, MigrationBindingUnresolvableError, recordMigrationSelectionBinding } from "../../src/migration/generation-binding-store.js";
import { MigrationProtocolError, beginMigrationEffect, type MigrationManifest } from "../../src/migration/protocol.js";
import { MigrationVerificationDriverError } from "../../src/migration/verify-generation.js";
import { cleanupRoots, expectActivated, expectAllNew, expectAllOld, fixture, type Fixture, HASH_A, MACHINE, REMOTES } from "./cutover-set-activate-fixture.js";

afterEach(cleanupRoots);

function records(f: Fixture) {
  const read = readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId });
  if (read.state !== "resolved") throw new Error("records not resolved: " + JSON.stringify(read));
  return read;
}

async function crashAt(f: Fixture, point: string): Promise<void> {
  await expect(f.run({ crashPoint: (p) => { if (p === point) throw new Error("crash at " + point); } })).rejects.toThrow("crash at " + point);
}

/** A manifest store whose read or update is replaced on the n-th call matching the generation. */
function manifestStoreWith(f: Fixture, override: { read?: (manifest: MigrationManifest, generationId: string, call: number) => MigrationManifest; update?: (generationId: string, call: number) => void }) {
  const store = f.manifestStore;
  let reads = 0;
  let updates = 0;
  return {
    read: (id: string) => { const manifest = store.read(id); reads += 1; return override.read === undefined ? manifest : override.read(manifest, id, reads); },
    update: (id: string, checksum: string, fn: (m: MigrationManifest) => MigrationManifest) => { updates += 1; override.update?.(id, updates); return store.update(id, checksum, fn); },
  };
}

function storageError(sqlState: string, retryable: boolean): PostgreSqlStorageOperationError {
  return new PostgreSqlStorageOperationError("STORAGE_OPERATION_FAILED", { domain: "factory", operation: "injected" }, sqlState, retryable);
}

describe("activateCutoverSet faults: entry, records and journals", () => {
  it("uses the wall clock when no clock is supplied, and refuses a single-generation entering journal", async () => {
    const f = await fixture();
    const outcome = await activateCutoverSet({ homeDir: f.homeDir, confirmSetId: f.setId, targetConfig: f.input.targetConfig }, f.deps);
    expect(outcome.status).toBe("activated");
    const single = await fixture({ held: false });
    await single.coordinator().enterMaintenance({
      publicationId: "migration-generation-1", generationId: "generation-1", sourceSelectionSha256: HASH_A, queueEvidenceSha256: HASH_A,
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: HASH_A }], now: new Date("2026-10-16T12:30:00.000Z"),
    });
    single.rewriteJournal((payload) => { payload.phase = "maintenance-entering"; });
    expect(await single.run()).toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held", detail: expect.stringContaining("entering for generation-1") });
  });

  it("interrupts on unresolvable records, on a journal that cannot be read under the barrier, and on a checkpoint of another manifest", async () => {
    const f = await fixture();
    await crashAt(f, "after-checkpoint");
    const directory = migrationCutoverSetActivationDirectory(f.homeDir, f.setId);
    writeFileSync(join(directory, "checkpoint.json"), "{}\n", { mode: 0o600 });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", detail: expect.stringContaining("records are unresolvable") });
    rmSync(directory, { recursive: true });
    const checkpoint = createCutoverSetActivationCheckpoint({
      setId: f.setId, manifest: { ...f.manifest, members: [f.manifest.members[1]!, { ...f.manifest.members[0]!, physicalProjectId: "f".repeat(64) }] },
      heldJournalChecksumSha256: HASH_A, publicationId: f.setId, identityDigest: HASH_A,
      members: [f.manifest.members[1]!, { ...f.manifest.members[0]!, physicalProjectId: "f".repeat(64) }].map((member, index) => ({
        physicalProjectId: member.physicalProjectId, generationId: member.generationId, remoteProjectId: REMOTES[index]!, heldMemberChecksumSha256: HASH_A,
        copyBindingSha256: HASH_A, epochManifestRevision: 8, epochManifestChecksumSha256: HASH_A, verificationReportSha256: HASH_A,
      })),
    });
    recordCutoverSetActivationCheckpoint({ homeDir: f.homeDir, checkpoint });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S9", cause: "evidence-conflict", detail: expect.stringContaining("manifest differs") });
    rmSync(directory, { recursive: true });
    let reads = 0;
    const journal = f.deps.readMaintenanceJournal;
    expect(await f.run({ readMaintenanceJournal: (homeDir) => { reads += 1; if (reads === 2) throw new Error("injected under barrier"); return journal(homeDir); } }))
      .toMatchObject({ status: "refused", step: "S0", reason: "maintenance-unresolvable", detail: expect.stringContaining("injected under barrier") });
    await crashAt(f, "after-checkpoint");
    reads = 0;
    expect(await f.run({ readMaintenanceJournal: (homeDir) => { reads += 1; if (reads === 2) throw new Error("injected under barrier"); return journal(homeDir); } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", applied: "no" });
  });

  it("classifies applied from the journals when an interruption is reported", async () => {
    const f = await fixture();
    await crashAt(f, "after-selection-completed");
    const journal = f.deps.readMaintenanceJournal;
    let reads = 0;
    // The journal read inside classifyApplied throws: applied is unknown.
    expect(await f.run({ readMaintenanceJournal: (homeDir) => { reads += 1; if (reads > 2) throw new Error("later read"); return journal(homeDir); }, readArtifact: () => null }))
      .toMatchObject({ status: "interrupted", applied: "unknown" });
    // A live publication of another id, and an in-flight own publication.
    expect(await f.run({ readArtifact: () => null, readMaintenanceJournal: () => null, readPublicationJournal: () => ({ publicationId: "other", phase: "completed" }) as never }))
      .toMatchObject({ status: "interrupted", applied: "no" });
    expect(await f.run({ readArtifact: () => null, readMaintenanceJournal: () => null, readPublicationJournal: () => ({ publicationId: f.setId, phase: "map-published" }) as never }))
      .toMatchObject({ status: "interrupted", applied: "unknown" });
  });

  it("a checkpoint whose hold is gone: the slot holding nothing, a foreign hold or a foreign publication all interrupt", async () => {
    const f = await fixture();
    await crashAt(f, "after-checkpoint");
    const { performMigrationAbortCommand } = await import("../../src/migration/cli-abort.js");
    expect(await performMigrationAbortCommand({ homeDir: f.homeDir, confirmGenerationId: f.setId })).toMatchObject({ status: "ok" });
    await f.coordinator().enterMaintenance({
      publicationId: "migration-generation-9", generationId: "generation-9", sourceSelectionSha256: HASH_A, queueEvidenceSha256: HASH_A,
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: HASH_A }], now: new Date("2026-10-16T12:30:00.000Z"),
    });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("maintenance generation-9") });
    const { backendPublicationJournalPath } = await import("../../src/storage/backend-publication.js");
    rmSync(backendPublicationJournalPath(f.homeDir));
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("holds nothing") });
    // A foreign completed publication: another set's checkpoint stored under its own id while this home's slot is a completed publication.
    const g = await fixture();
    expect((await g.run()).status).toBe("activated");
    const foreignSetId = "cutover-set-two";
    const manifest = { ...g.manifest, setId: foreignSetId };
    recordCutoverSetActivationCheckpoint({ homeDir: g.homeDir, checkpoint: createCutoverSetActivationCheckpoint({
      setId: foreignSetId, manifest, heldJournalChecksumSha256: HASH_A, publicationId: foreignSetId, identityDigest: HASH_A,
      members: manifest.members.map((member, index) => ({
        physicalProjectId: member.physicalProjectId, generationId: member.generationId, remoteProjectId: REMOTES[index]!, heldMemberChecksumSha256: HASH_A,
        copyBindingSha256: HASH_A, epochManifestRevision: 8, epochManifestChecksumSha256: HASH_A, verificationReportSha256: HASH_A,
      })),
    }) });
    expect(await activateCutoverSet({ ...g.input, confirmSetId: foreignSetId }, g.deps)).toMatchObject({ status: "interrupted", step: "S12", detail: expect.stringContaining("publication " + g.setId) });
  });

  it("a slot that is not this set's with a frozen selection: a lost fence interrupts, an empty slot with mixed members interrupts", async () => {
    const f = await fixture();
    await crashAt(f, "after-selection-completed");
    const { backendPublicationJournalPath } = await import("../../src/storage/backend-publication.js");
    rmSync(backendPublicationJournalPath(f.homeDir));
    f.guard.rows.delete(f.members[0]!.remoteProjectId);
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost" });
    const g = await fixture();
    await crashAt(g, "after-complete:" + g.members[0]!.generationId);
    rmSync(backendPublicationJournalPath(g.homeDir));
    expect(await g.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "state-unresolvable", detail: expect.stringContaining("empty") });
  });
});

describe("activateCutoverSet faults: member classification", () => {
  it("manifest reads that are unresolvable or throw, foreign pending effects and ineligible reports", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    expect(await f.run({ manifestStore: manifestStoreWith(f, { read: (m, id) => { if (id === b!.generationId) throw new MigrationProtocolError("malformed-record", "injected"); return m; } }) }))
      .toMatchObject({ status: "refused", members: [expect.anything(), expect.objectContaining({ reason: "manifest-unresolvable" })] });
    await expect(f.run({ manifestStore: manifestStoreWith(f, { read: (_m, id) => { if (id === b!.generationId) throw new Error("not protocol"); return _m; } }) })).rejects.toThrow("not protocol");
    expect(await f.run({ readVerificationReport: (id, sha) => ({ ...f.deps.readVerificationReport(id, sha), activationEligible: id === a!.generationId ? false : true }) }))
      .toMatchObject({ status: "refused", members: [expect.objectContaining({ reason: "verification-stale", detail: expect.stringContaining("not activation-eligible") }), expect.anything()] });
    await expect(f.run({ readVerificationReport: () => { throw new Error("store exploded"); } })).rejects.toThrow("store exploded");
    const verified = f.manifestStore.read(a!.generationId);
    f.manifestStore.update(a!.generationId, verified.checksumSha256, (m) => beginMigrationEffect(m, { effectId: "foreign-1", kind: "prepare-activation", inputSha256: HASH_A, startedAt: "2026-10-16T13:00:00.000Z" }));
    expect(await f.run()).toMatchObject({ status: "refused", members: [expect.objectContaining({ reason: "pending-effect-foreign" }), expect.anything()] });
  });

  it("generation links that are unresolvable, foreign, of another artifact or revision, or present before any checkpoint", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    const link = f.deps.readLink;
    expect(await f.run({ readLink: (input) => input.generationId === b!.generationId ? { state: "unresolvable", reason: "malformed-record", detail: "injected" } : link(input) }))
      .toMatchObject({ status: "refused", members: [expect.anything(), expect.objectContaining({ reason: "state-unresolvable", detail: expect.stringContaining("injected") })] });
    recordActivationGenerationLink({ homeDir: f.homeDir, generationId: a!.generationId, publicationId: "someone-else", identityDigest: HASH_A, epochManifestRevision: 8, epochManifestChecksumSha256: HASH_A });
    expect(await f.run()).toMatchObject({ status: "refused", members: [expect.objectContaining({ detail: expect.stringContaining("names publication someone-else") }), expect.anything()] });
    const { activationGenerationLinkPath } = await import("../../src/migration/activation-artifact-store.js");
    rmSync(activationGenerationLinkPath(f.homeDir, a!.generationId));
    recordActivationGenerationLink({ homeDir: f.homeDir, generationId: a!.generationId, publicationId: f.setId, identityDigest: HASH_A, epochManifestRevision: 8, epochManifestChecksumSha256: HASH_A });
    expect(await f.run()).toMatchObject({ status: "refused", members: [expect.objectContaining({ detail: expect.stringContaining("another frozen manifest revision") }), expect.anything()] });
    const verified = f.manifestStore.read(a!.generationId);
    rmSync(activationGenerationLinkPath(f.homeDir, a!.generationId));
    recordActivationGenerationLink({ homeDir: f.homeDir, generationId: a!.generationId, publicationId: f.setId, identityDigest: HASH_A, epochManifestRevision: verified.revision, epochManifestChecksumSha256: verified.checksumSha256 });
    expect(await f.run()).toMatchObject({ status: "refused", members: [expect.objectContaining({ detail: expect.stringContaining("before any checkpoint") }), expect.anything()] });
    rmSync(activationGenerationLinkPath(f.homeDir, a!.generationId));
    // After a checkpoint, a link of another artifact interrupts.
    await crashAt(f, "after-checkpoint");
    recordActivationGenerationLink({ homeDir: f.homeDir, generationId: a!.generationId, publicationId: f.setId, identityDigest: "0".repeat(64), epochManifestRevision: verified.revision, epochManifestChecksumSha256: verified.checksumSha256 });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S11", cause: "link-conflict", detail: expect.stringContaining("another artifact") });
  });

  it("after a checkpoint, a member whose revision, pending effect, phase, remote, held binding, report or copy binding differs interrupts", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    await crashAt(f, "after-checkpoint");
    expect(await f.run({ manifestStore: manifestStoreWith(f, { read: (m, id) => (id === a!.generationId ? { ...m, revision: m.revision + 1 } : m) }) }))
      .toMatchObject({ status: "interrupted", step: "S9", cause: "evidence-conflict", detail: expect.stringContaining("checkpointed revision") });
    expect(await f.run({ manifestStore: manifestStoreWith(f, { read: (m, id) => (id === a!.generationId ? { ...m, phase: "activating", pendingEffect: { effectId: "x", kind: "copy-batch", inputSha256: HASH_A, startedAt: "2026-10-16T12:00:00.000Z" } } : m) }) }))
      .toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", detail: expect.stringContaining("not an activation effect") });
    expect(await f.run({ manifestStore: manifestStoreWith(f, { read: (m, id) => (id === a!.generationId ? { ...m, phase: "copied" } : m) }) }))
      .toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", detail: expect.stringContaining("under a checkpointed set") });
    expect(await f.run({ manifestStore: manifestStoreWith(f, { read: (m, id) => (id === b!.generationId ? { ...m, reports: m.reports.map((r) => (r.kind === "verification" ? { ...r, reportSha256: HASH_A } : r)) } : m) }) }))
      .toMatchObject({ status: "interrupted", step: "S9", detail: expect.stringContaining("not the checkpointed one") });
    f.deps.identityOverride.set(a!.localProjectId, { id: REMOTES[2], remoteProjectId: REMOTES[2], localProjectId: a!.localProjectId, machineId: MACHINE, canonical: a!.canonical, selectedPath: a!.canonical } as never);
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S9", cause: "evidence-conflict", detail: expect.stringContaining("destination project differs") });
    f.deps.identityOverride.clear();
    f.deps.transferRows.set(b!.remoteProjectId, [{ run_id: "migration-copy-" + HASH_A, state: "completed" }]);
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S9", cause: "evidence-conflict", detail: expect.stringContaining("copy binding digest differs") });
    f.deps.transferRows.set(b!.remoteProjectId, [{ run_id: "migration-copy-" + b!.copyBindingSha256, state: "completed" }]);
    await withBackendPublicationAppendBarrierAsync(f.homeDir, async (token) => {
      const journal = readBackendMaintenanceJournal(f.homeDir)!;
      const view = resolveBackendMaintenanceGenerationBinding(journal, b!.generationId)!;
      rebindBackendMaintenanceCutoff({
        homeDir: f.homeDir, expectedChecksumSha256: view.checksumSha256, generationId: b!.generationId, sourceSelectionSha256: view.sourceSelectionSha256,
        queueEvidenceSha256: HASH_A, roster: [{ machineId: MACHINE, queueCutoff: "0000000000000000009", evidenceSha256: HASH_A }],
      }, token);
    });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S9", cause: "evidence-conflict", detail: expect.stringContaining("held member binding differs") });
    expectAllOld(f);
  });

  it("identity checks: a report witness mismatch, a drift on the ordinary session, a drift on the census session, and an unknown capture error", async () => {
    const f = await fixture();
    const [a] = f.members;
    expect(await f.run({ readVerificationReport: (id, sha) => { const r = f.deps.readVerificationReport(id, sha); return id === a!.generationId ? { ...r, body: { ...r.body, destinationIdentity: { ...r.body.destinationIdentity, sealedWitnessSha256: HASH_A } } } : r; } }))
      .toMatchObject({ status: "refused", step: "S0", members: [expect.objectContaining({ reason: "identity-drift", detail: expect.stringContaining("verification report") }), expect.anything()] });
    let captures = 0;
    expect(await f.run({ captureDestinationIdentity: async () => { captures += 1; return captures === 3 ? { version: 1, sealedWitnessSha256: HASH_A, systemIdentifier: "712345" } : { version: 1, ...f.deps.identity }; } }))
      .toMatchObject({ status: "refused", step: "S5", members: [expect.objectContaining({ reason: "identity-drift" }), expect.anything()] });
    captures = 0;
    expect(await f.run({ captureDestinationIdentity: async () => { captures += 1; return captures === 6 ? { version: 1, sealedWitnessSha256: HASH_A, systemIdentifier: "712345" } : { version: 1, ...f.deps.identity }; } }))
      .toMatchObject({ status: "refused", step: "S8", members: [expect.anything(), expect.objectContaining({ reason: "identity-drift" })] });
    await expect(f.run({ captureDestinationIdentity: async () => { throw new Error("capture exploded"); } })).rejects.toThrow("capture exploded");
    void MigrationVerificationDriverError;
  });

  it("S7 target failures are attributed unhealthy or unresolvable per member, and cancellation refuses before a census", async () => {
    const f = await fixture();
    const [a] = f.members;
    expect(await f.run({ readDestinationCensus: async (s, census) => { if (census.expectedIdentity.remoteProjectId === a!.remoteProjectId) throw storageError("28000", false); return f.deps.readDestinationCensus(s, census); } }))
      .toMatchObject({ status: "refused", members: [expect.objectContaining({ reason: "target-unhealthy" }), expect.anything()] });
    expect(await f.run({ readDestinationCensus: async () => { throw storageError("08006", true); } }))
      .toMatchObject({ status: "refused", members: [expect.objectContaining({ reason: "target-unresolvable" }), expect.objectContaining({ reason: "target-unresolvable" })] });
    const controller = new AbortController();
    expect(await activateCutoverSet({ ...f.input, signal: controller.signal }, { ...f.deps, checkTargetHealth: async () => { controller.abort(); return { status: "healthy", readiness: undefined as never }; } }))
      .toMatchObject({ status: "refused", step: "S7", reason: "cancelled" });
  });
});

describe("activateCutoverSet faults: leases", () => {
  it("acquire: unresolvable, a vanished expired row, and a takeover conflict", async () => {
    const f = await fixture();
    const [a] = f.members;
    const acquire = f.guard.acquire.bind(f.guard);
    f.guard.acquire = async (input) => { if (input.projectId === a!.remoteProjectId) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "readback-mismatch"); return acquire(input); };
    expect(await f.run()).toMatchObject({ status: "refused", step: "S2", members: [expect.objectContaining({ reason: "lease-unresolvable" }), expect.anything()] });
    f.guard.acquire = acquire;
    f.guard.seed({ projectId: a!.remoteProjectId, publicationId: f.setId, evidenceSha256: a!.copyBindingSha256, databaseExpired: true });
    const read = f.guard.read.bind(f.guard);
    f.guard.read = async (input) => { if (input.projectId === a!.remoteProjectId) { f.guard.read = read; return null; } return read(input); };
    expect(await f.run()).toMatchObject({ status: "refused", step: "S2", members: [expect.objectContaining({ reason: "lease-unresolvable", detail: expect.stringContaining("vanished") }), expect.anything()] });
    f.guard.seed({ projectId: a!.remoteProjectId, publicationId: f.setId, evidenceSha256: a!.copyBindingSha256, databaseExpired: true });
    f.guard.acquire = async (input) => { if (input.expectedFencingToken !== undefined) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "publication-conflict"); return acquire(input); };
    expect(await f.run()).toMatchObject({ status: "refused", step: "S2", members: [expect.objectContaining({ reason: "lease-conflict" }), expect.anything()] });
    f.guard.acquire = acquire;
    f.guard.rows.delete(a!.remoteProjectId);
    expectActivated(f, await f.run(), "fresh");
  });

  it("renew: a stale token is retried, a takeover that conflicts or cannot be attributed, and an unattributable renew", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    const renew = f.guard.renew.bind(f.guard);
    let bumped = false;
    f.guard.renew = async (input) => {
      if (!bumped && input.projectId === a!.remoteProjectId) { bumped = true; const row = f.guard.rows.get(a!.remoteProjectId)!; f.guard.rows.set(a!.remoteProjectId, { ...row, fencingToken: row.fencingToken + 1n }); }
      return renew(input);
    };
    expectActivated(f, await f.run(), "fresh");
    f.guard.renew = renew;
    const g = await fixture();
    const [c] = g.members;
    const gacquire = g.guard.acquire.bind(g.guard);
    g.guard.acquire = async (input) => { if (input.expectedFencingToken !== undefined) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "publication-conflict"); return gacquire(input); };
    g.guard.expireNextFor = c!.remoteProjectId;
    expect(await g.run()).toMatchObject({ status: "refused", step: "S8", reason: "lease-conflict" });
    g.guard.acquire = async (input) => { if (input.expectedFencingToken !== undefined) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "readback-mismatch"); return gacquire(input); };
    g.guard.rows.delete(c!.remoteProjectId);
    g.guard.rows.delete(g.members[1]!.remoteProjectId);
    g.guard.expireNextFor = c!.remoteProjectId;
    expect(await g.run()).toMatchObject({ status: "refused", step: "S8", reason: "lease-unresolvable" });
    g.guard.acquire = gacquire;
    const gread = g.guard.read.bind(g.guard);
    const grenew = g.guard.renew.bind(g.guard);
    g.guard.renew = async (input) => { if (input.projectId === b!.remoteProjectId || input.projectId === g.members[1]!.remoteProjectId) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "renew", "fence-mismatch"); return grenew(input); };
    g.guard.read = async (input) => { if (input.projectId === g.members[1]!.remoteProjectId) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "read", "invalid-row"); return gread(input); };
    for (const row of [...g.guard.rows.values()]) g.guard.rows.delete(row.projectId);
    expect(await g.run()).toMatchObject({ status: "refused", step: "S8", reason: "lease-conflict" });
  });

  it("release failures ride the refusal detail: expired rows are taken over and released, a failed takeover and a thrown release are reported", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    const { domainCensus } = await import("./cutover-set-activate-fixture.js");
    f.deps.destinationCensus.set(b!.remoteProjectId, domainCensus("changed"));
    const release = f.guard.release.bind(f.guard);
    let expiredOnce = false;
    f.guard.release = async (input) => { if (input.projectId === a!.remoteProjectId && !expiredOnce) { expiredOnce = true; f.guard.expire(a!.remoteProjectId); } return release(input); };
    const expired = await f.run();
    expect(expired).toMatchObject({ status: "refused", step: "S8" });
    expect(f.guard.rows.get(a!.remoteProjectId)?.releasedAt).not.toBeNull();
    f.guard.release = async (input) => { if (input.projectId === a!.remoteProjectId) throw new Error("release exploded"); return release(input); };
    expect(await f.run()).toMatchObject({ status: "refused", detail: expect.stringContaining("activation leases were not released") });
    f.guard.release = async (input) => { if (input.projectId === a!.remoteProjectId) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "release", "fence-mismatch"); return release(input); };
    f.guard.rows.delete(a!.remoteProjectId);
    f.guard.rows.delete(b!.remoteProjectId);
    const acquire = f.guard.acquire.bind(f.guard);
    f.guard.acquire = async (input) => { const fence = await acquire(input); if (input.projectId === a!.remoteProjectId) f.guard.rows.set(a!.remoteProjectId, { ...fence, databaseExpired: true }); return fence; };
    f.guard.read = async () => { throw new PostgreSqlBackendPublicationGuardError(a!.remoteProjectId, "read", "invalid-row"); };
    expect(await f.run()).toMatchObject({ status: "refused", detail: expect.stringContaining("not released") });
  });

  it("post-freeze: a regressed fence at acquire or renew is lease-lost, a renew takeover reports the successor token", async () => {
    const f = await fixture();
    const [a] = f.members;
    await crashAt(f, "after-selection-frozen");
    const frozen = records(f).selection!.members[0]!;
    void frozen;
    f.guard.rows.delete(a!.remoteProjectId);
    f.guard.seed({ projectId: a!.remoteProjectId, publicationId: f.setId, evidenceSha256: a!.copyBindingSha256, fencingToken: 0n });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "lease-lost", detail: expect.stringContaining("regressed") });
    f.guard.rows.delete(a!.remoteProjectId);
    const outcome = await f.run({ crashPoint: (p) => { if (p === "after-witness-binding:" + f.members[1]!.generationId) f.guard.expireNextFor = a!.remoteProjectId; } });
    expectActivated(f, outcome, "selection-frozen");
    if (outcome.status === "activated") expect(outcome.successorFencingToken).not.toBeNull();
    const g = await fixture();
    const [c] = g.members;
    await crashAt(g, "after-selection-frozen");
    const renew = g.guard.renew.bind(g.guard);
    g.guard.renew = async (input) => {
      if (input.projectId === c!.remoteProjectId) { const row = g.guard.rows.get(c!.remoteProjectId)!; g.guard.rows.set(c!.remoteProjectId, { ...row, databaseExpired: true, fencingToken: row.fencingToken }); g.guard.renew = renew; g.guard.nextToken = 0n; }
      return renew(input);
    };
    expect(await g.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "lease-lost", detail: expect.stringContaining("regressed") });
  });

  it("after the selection: a renew takeover reports the successor token, a regressed token and a lost renew interrupt", async () => {
    const f = await fixture();
    const [a] = f.members;
    await crashAt(f, "after-selection-completed");
    f.guard.expireNextFor = a!.remoteProjectId;
    const outcome = await f.run();
    expectActivated(f, outcome, "selection-completed");
    if (outcome.status === "activated") expect(outcome.successorFencingToken).not.toBeNull();
    const g = await fixture();
    const [c] = g.members;
    await crashAt(g, "after-selection-completed");
    const renew = g.guard.renew.bind(g.guard);
    g.guard.renew = async (input) => { if (input.projectId === c!.remoteProjectId) { g.guard.rows.delete(c!.remoteProjectId); } return renew(input); };
    expect(await g.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost" });
    g.guard.renew = renew;
    g.guard.seed({ projectId: c!.remoteProjectId, publicationId: g.setId, evidenceSha256: c!.copyBindingSha256, databaseExpired: true });
    g.guard.nextToken = 0n;
    expect(await g.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost", detail: expect.stringContaining("regressed") });
    const read = g.guard.read.bind(g.guard);
    g.guard.read = async (input) => { if (input.projectId === c!.remoteProjectId) throw storageError("08006", true); return read(input); };
    expect(await g.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-unresolvable" });
  });
});

describe("activateCutoverSet faults: artifact, checkpoint, evidence and selection writes", () => {
  it("artifact reads that refuse, an orphan of another publication, and a digest that does not reproduce", async () => {
    const orphaned = await fixture();
    const composed = orphaned.deps.composeMaterial({ homeDir: orphaned.homeDir, targetBackend: "postgresql", bindings: orphaned.members.map((m) => ({ localProjectId: m.localProjectId, remoteProjectId: m.remoteProjectId, evidenceSha256: m.copyBindingSha256 })) });
    publishActivationArtifact({ homeDir: orphaned.homeDir, material: { version: 1, publicationId: "other", source: composed.material.source, target: composed.material.target, projects: composed.projects } });
    expect(await orphaned.run()).toMatchObject({ status: "refused", step: "S0", reason: "state-unresolvable", detail: expect.stringContaining("another publication") });
    expectAllOld(orphaned);
    const f = await fixture();
    for (const error of [new ActivationArtifactPresenceUnresolvableError("injected"), new ActivationArtifactIdentityMismatchError("injected"), new ActivationArtifactValidationError("injected")]) {
      expect(await f.run({ readArtifact: () => { throw error; } })).toMatchObject({ status: "refused", step: "S0", reason: "state-unresolvable" });
    }
    await expect(f.run({ readArtifact: () => { throw new Error("raw"); } })).rejects.toThrow("raw");
    expect(await f.run({ publishArtifact: (input) => ({ ...f.deps.publishArtifact(input), identityDigest: HASH_A }) })).toMatchObject({ status: "refused", step: "S0", reason: "state-unresolvable", detail: expect.stringContaining("differs from the composed") });
    expectAllOld(f);
  });

  it("a checkpointed artifact that is unresolvable, absent, or covers other projects interrupts", async () => {
    const f = await fixture();
    await crashAt(f, "after-checkpoint");
    expect(await f.run({ readArtifact: () => { throw new ActivationArtifactPresenceUnresolvableError("injected"); } })).toMatchObject({ status: "interrupted", step: "S11", cause: "artifact-unresolvable" });
    await expect(f.run({ readArtifact: () => { throw new Error("raw"); } })).rejects.toThrow("raw");
    expect(await f.run({ readArtifact: () => null })).toMatchObject({ status: "interrupted", step: "S11", cause: "state-unresolvable", detail: expect.stringContaining("absent") });
    const artifact = readActivationArtifact({ homeDir: f.homeDir, identityDigest: records(f).checkpoint.identityDigest })!;
    expect(await f.run({ readArtifact: () => ({ ...artifact, projects: artifact.projects.slice(0, 1) }) })).toMatchObject({ status: "interrupted", step: "S11", cause: "artifact-identity-mismatch" });
    // The same checks after the freeze, through the adoption path.
    await crashAt(f, "after-selection-completed");
    expect(await f.run({ readArtifact: () => null })).toMatchObject({ status: "interrupted", step: "S11", cause: "state-unresolvable" });
  });

  it("checkpoint and selection records that conflict or cannot be written, and evidence writers that refuse", async () => {
    const f = await fixture();
    const other = createCutoverSetActivationCheckpoint({
      setId: f.setId, manifest: f.manifest, heldJournalChecksumSha256: HASH_A, publicationId: f.setId, identityDigest: HASH_A,
      members: f.manifest.members.map((member, index) => ({
        physicalProjectId: member.physicalProjectId, generationId: member.generationId, remoteProjectId: REMOTES[index]!, heldMemberChecksumSha256: HASH_A,
        copyBindingSha256: HASH_A, epochManifestRevision: 8, epochManifestChecksumSha256: HASH_A, verificationReportSha256: HASH_A,
      })),
    });
    expect(await f.run({ recordCheckpoint: () => { throw new MigrationBindingConflictError("injected conflict"); } })).toMatchObject({ status: "interrupted", step: "S9", cause: "evidence-conflict" });
    expect(await f.run({ recordCheckpoint: () => { throw new MigrationBindingUnresolvableError("injected unresolvable"); } })).toMatchObject({ status: "interrupted", step: "S9", cause: "evidence-unresolvable" });
    expect(await f.run({ recordCheckpoint: () => { throw new CutoverSetActivationRecordError("invalid-input", "injected record"); } })).toMatchObject({ status: "interrupted", step: "S9", cause: "evidence-conflict" });
    expect(await f.run({ recordCheckpoint: () => { throw new MigrationActivationEvidenceRefusalError("evidence-unresolvable", "injected"); } })).toMatchObject({ status: "interrupted", step: "S9", cause: "evidence-unresolvable" });
    await expect(f.run({ recordCheckpoint: () => { throw new Error("raw"); } })).rejects.toThrow("raw");
    void other;
    expect(await f.run({ recordSelection: () => { throw new CutoverSetActivationRecordError("selection-mismatch", "injected"); } })).toMatchObject({ status: "interrupted", step: "S12", cause: "evidence-conflict" });
    const g = await fixture();
    const [a] = g.members;
    const evidence = g.deps.evidence;
    expect(await g.run({ evidence: { ...evidence, recordMigrationActivationEpoch: (input) => { if (input.epoch.generationId === a!.generationId) throw new MigrationActivationEvidenceRefusalError("epoch-missing", "injected"); evidence.recordMigrationActivationEpoch(input); } } }))
      .toMatchObject({ status: "interrupted", step: "S11", cause: "evidence-conflict", detail: expect.stringContaining(a!.generationId) });
    expect(await g.run({ evidence: { ...evidence, recordMigrationActivationWitness: () => { throw new MigrationBindingUnresolvableError("injected"); } } }))
      .toMatchObject({ status: "interrupted", step: "S11", cause: "evidence-unresolvable" });
    const h = await fixture();
    expect(await h.run({ recordLink: () => { throw new ActivationGenerationLinkConflictError("injected link"); } })).toMatchObject({ status: "interrupted", step: "S11", cause: "link-conflict" });
    expect(await h.run({ recordLink: () => { throw new ActivationArtifactPresenceUnresolvableError("injected link"); } })).toMatchObject({ status: "interrupted", step: "S11", cause: "artifact-unresolvable" });
    await expect(h.run({ recordLink: () => { throw new Error("raw link"); } })).rejects.toThrow("raw link");
  });

  it("member effect writes: a foreign prepare effect, a protocol refusal, and a foreign publish effect", async () => {
    const f = await fixture();
    const [a] = f.members;
    const fstore = f.manifestStore;
    expect(await f.run({ manifestStore: { read: (id) => fstore.read(id), update: (id, checksum, fn) => { const next = fstore.update(id, checksum, fn); return id === a!.generationId && next.pendingEffect?.kind === "prepare-activation" ? { ...next, pendingEffect: { ...next.pendingEffect, effectId: "other" } } : next; } } }))
      .toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", detail: expect.stringContaining("not this activation's prepare-activation") });
    const g = await fixture();
    expect(await g.run({ manifestStore: manifestStoreWith(g, { update: (_id, call) => { if (call === 2) throw new MigrationProtocolError("unexpected-state", "injected"); } }) }))
      .toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", detail: expect.stringContaining("could not be driven") });
    await expect(g.run({ manifestStore: manifestStoreWith(g, { update: () => { throw new Error("raw update"); } }) })).rejects.toThrow("raw update");
    const h = await fixture();
    const store = h.manifestStore;
    expect(await h.run({ manifestStore: { read: (id) => store.read(id), update: (id, checksum, fn) => { const next = store.update(id, checksum, fn); return next.pendingEffect?.kind === "publish-activation" ? { ...next, pendingEffect: { ...next.pendingEffect, effectId: "other" } } : next; } } }))
      .toMatchObject({ status: "interrupted", step: "S10", cause: "state-unresolvable" });
  });

  it("adopting frozen attempts: evidence reads that throw, are unresolvable or absent, a missing witness, and a foreign epoch", async () => {
    const f = await fixture();
    const [a] = f.members;
    await crashAt(f, "after-selection-frozen");
    const evidence = f.deps.evidence;
    expect(await f.run({ evidence: { ...evidence, readMigrationActivationEvidence: () => { throw new Error("read exploded"); } } })).toMatchObject({ status: "interrupted", step: "S12", cause: "evidence-unresolvable" });
    expect(await f.run({ evidence: { ...evidence, readMigrationActivationEvidence: () => ({ state: "unresolvable", reason: "injected" }) } })).toMatchObject({ status: "interrupted", step: "S12", cause: "evidence-unresolvable" });
    expect(await f.run({ evidence: { ...evidence, readMigrationActivationEvidence: () => ({ state: "authoritatively-absent" }) } })).toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable" });
    expect(await f.run({ evidence: { ...evidence, readMigrationActivationEvidence: (input) => { const r = evidence.readMigrationActivationEvidence(input); return r.state === "resolved" ? { ...r, witnesses: [] } : r; } } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable", detail: expect.stringContaining("does not name a stored") });
    const report = f.deps.readVerificationReport;
    expect(await f.run({ readVerificationReport: (id, sha) => { const r = report(id, sha); return id === a!.generationId ? { ...r, body: { ...r.body, queueClassificationWitness: { ...r.body.queueClassificationWitness, queueCutoff: "0000000000000000002" } } } : r; } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "evidence-conflict", detail: expect.stringContaining("not the epoch") });
  });

  it("the set selection: a journal that cannot be read, another tuple at selection-prepared, a coordinator refusal and a phase that did not advance", async () => {
    const f = await fixture();
    const journal = f.deps.readMaintenanceJournal;
    let reads = 0;
    expect(await f.run({ readMaintenanceJournal: (homeDir) => { reads += 1; if (reads === 3) throw new Error("injected at S12"); return journal(homeDir); } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("injected at S12") });
    const g = await fixture();
    reads = 0;
    expect(await g.run({ readMaintenanceJournal: (homeDir) => { reads += 1; return reads === 3 ? null : journal(homeDir); } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("no maintenance journal") });
    const h = await fixture();
    const real = h.deps.createCoordinator;
    expect(await h.run({ createCoordinator: (input) => { const c = real(input); c.prepareMaintenanceSelection = async () => { throw new BackendPublicationJournalError("unexpected-state", "injected prepare"); }; return c; } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("injected prepare") });
    expect(await h.run({ createCoordinator: (input) => { const c = real(input); const complete = c.completeMaintenanceSelection.bind(c); c.completeMaintenanceSelection = async (i, t) => ({ ...(await complete(i, t)), phase: "selection-prepared" }); return c; } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("at phase selection-prepared") });
    const raw = await fixture();
    const rawReal = raw.deps.createCoordinator;
    await expect(raw.run({ createCoordinator: (input) => { const c = rawReal(input); c.completeMaintenanceSelection = async () => { throw new Error("raw complete"); }; return c; } })).rejects.toThrow("raw complete");
    const k = await fixture();
    await crashAt(k, "after-selection-prepared");
    const selection = records(k).selection!;
    const other: BackendCutoverSetSelection = { ...selection, checkpointSha256: HASH_A, checksumSha256: "" };
    const sealed = { ...other, checksumSha256: backendCutoverSetSelectionSha256(other) };
    k.rewriteJournal((payload) => { payload.cutoverSet.selection = sealed; payload.terminalEvidenceSha256 = sealed.checksumSha256; });
    expect(await k.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("not the frozen one") });
    rmSync(migrationCutoverSetActivationDirectory(k.homeDir, k.setId) + "/selection.json");
    expect(await k.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable", detail: expect.stringContaining("no frozen selection tuple") });
  });
});

describe("activateCutoverSet faults: bindings, drive and settlement", () => {
  it("selection bindings that conflict or cannot be written, and a restart verdict that cannot observe", async () => {
    const f = await fixture();
    const [a] = f.members;
    await crashAt(f, "after-selection-completed");
    recordMigrationSelectionBinding({ homeDir: f.homeDir, generationId: a!.generationId, binding: { kind: "activation", epochId: HASH_A, attemptId: HASH_A, manifestRevision: 8, witnessChecksumSha256: HASH_A, publicationId: "other" } });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13a", cause: "binding-conflict" });
    const g = await fixture();
    await crashAt(g, "after-selection-completed");
    expect(await g.run({ bindings: { ...g.deps.bindings, recordMigrationSelectionBinding: () => { throw new MigrationBindingUnresolvableError("injected"); } } })).toMatchObject({ status: "interrupted", step: "S13a", cause: "binding-unresolvable" });
    await expect(g.run({ bindings: { ...g.deps.bindings, recordMigrationSelectionBinding: () => { throw new Error("raw binding"); } } })).rejects.toThrow("raw binding");
    const outcome = await g.run({ checkRestart: async () => { throw new Error("no daemon"); } });
    expect(outcome).toMatchObject({ status: "activated", restart: { status: "unresolvable", reason: "health-unreachable" } });
  });

  it("after the drive: a publication journal that cannot be re-read or is not completed interrupts; member readbacks that disagree interrupt", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    const publication = f.deps.readPublicationJournal;
    let reads = 0;
    expect(await f.run({ readPublicationJournal: (homeDir) => { reads += 1; if (reads === 1) throw new Error("injected re-read"); return publication(homeDir); } }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "readback-mismatch", detail: expect.stringContaining("injected re-read") });
    expectAllNew(f);
    reads = 0;
    expect(await f.run({ readPublicationJournal: (homeDir) => { reads += 1; const real = publication(homeDir); return reads === 2 && real !== null ? { ...real, phase: "map-published" } : real; } }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "readback-mismatch", detail: expect.stringContaining("not this set's completed") });
    expect(await f.run({ manifestStore: manifestStoreWith(f, { read: (m, id, call) => (id === a!.generationId && call > 2 ? (() => { throw new MigrationProtocolError("malformed-record", "injected"); })() : m) }) }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "state-unresolvable", detail: expect.stringContaining("re-read") });
    expect(await f.run({ manifestStore: manifestStoreWith(f, { read: (m, id, call) => (id === b!.generationId && call > 2 ? { ...m, pendingEffect: { ...m.pendingEffect!, effectId: "other" } } : m) }) }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "readback-mismatch", detail: expect.stringContaining("pending publish-activation") });
    expect(await f.run({ bindings: { ...f.deps.bindings, resolveMigrationWitnessBindings: () => { throw new Error("bindings exploded"); } } })).toMatchObject({ status: "interrupted", step: "S16", cause: "binding-unresolvable" });
    expect(await f.run({ bindings: { ...f.deps.bindings, resolveMigrationWitnessBindings: () => ({ state: "resolved", witnesses: [], selections: [] }) } })).toMatchObject({ status: "interrupted", step: "S16", cause: "readback-mismatch", detail: expect.stringContaining("selection binding") });
    await expect(f.run({ computeProjectMapWitness: (r) => { if (r.mode === "post-publication") throw new Error("raw witness"); return f.deps.computeProjectMapWitness(r); } })).rejects.toThrow("raw witness");
    expect(await f.run({ manifestStore: manifestStoreWith(f, { update: () => { throw new MigrationProtocolError("unexpected-state", "injected complete"); } }) }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "state-unresolvable", detail: expect.stringContaining("could not be completed") });
    await expect(f.run({ manifestStore: manifestStoreWith(f, { update: () => { throw new Error("raw complete"); } }) })).rejects.toThrow("raw complete");
    expectActivated(f, await f.run(), "publication-journal");
    // An active member whose stored report names another publication is a report conflict.
    const read = f.deps.readReport;
    expect(await f.run({ readReport: (input) => { const r = read(input); return r.state === "resolved" ? { ...r, report: { ...r.report, body: { ...r.report.body, publicationId: "other" } } } : r; } }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "report-conflict" });
  });

  it("adopting the frozen selection after the publication: absent manifests, mismatched reports, missing links and members that are not activating interrupt", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    await crashAt(f, "after-drive");
    const store = f.manifestStore;
    expect(await f.run({ manifestStore: manifestStoreWith(f, { read: (_m, id) => { if (id === b!.generationId) throw new MigrationProtocolError("unexpected-state", "migration manifest head is absent"); return _m; } }) }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "state-unresolvable", detail: expect.stringContaining("absent") });
    expect(await f.run({ manifestStore: manifestStoreWith(f, { read: (_m, id) => { if (id === b!.generationId) throw new MigrationProtocolError("malformed-record", "injected"); return _m; } }) }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "state-unresolvable", detail: expect.stringContaining("injected") });
    expect(await f.run({ readVerificationReport: (id, sha) => ({ ...f.deps.readVerificationReport(id, sha), reportId: id === a!.generationId ? "other" : f.deps.readVerificationReport(id, sha).reportId }) }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "state-unresolvable", detail: expect.stringContaining("does not match") });
    const link = f.deps.readLink;
    expect(await f.run({ readLink: (input) => (input.generationId === a!.generationId ? { state: "authoritatively-absent", detail: "injected" } : link(input)) }))
      .toMatchObject({ status: "interrupted", step: "S11", cause: "state-unresolvable", detail: expect.stringContaining("no generation link") });
    expect(await f.run({ readLink: (input) => (input.generationId === a!.generationId ? { state: "unresolvable", reason: "malformed-record", detail: "injected" } : link(input)) }))
      .toMatchObject({ status: "interrupted", step: "S11", cause: "link-conflict" });
    expect(await f.run({ manifestStore: { read: (id) => { const m = store.read(id); return id === b!.generationId ? { ...m, phase: "verified", pendingEffect: null } : m; }, update: store.update.bind(store) } }))
      .toMatchObject({ status: "interrupted", step: "S10", cause: "state-unresolvable", detail: expect.stringContaining("not activating") });
    expectActivated(f, await f.run(), "publication-journal");
  });

  it("a stranger's row at a released or completed publication is admitted; an unresolvable row is not", async () => {
    const f = await fixture();
    const [a] = f.members;
    await crashAt(f, "after-drive");
    f.guard.rows.delete(a!.remoteProjectId);
    f.guard.seed({ projectId: a!.remoteProjectId, publicationId: "stranger", evidenceSha256: a!.copyBindingSha256 });
    expect(await f.run()).toMatchObject({ status: "activated", resumedFrom: "publication-journal" });
    expect(f.guard.rows.get(a!.remoteProjectId)).toMatchObject({ publicationId: "stranger", releasedAt: null });
    const g = await fixture();
    const [c] = g.members;
    await crashAt(g, "after-drive");
    const read = g.guard.read.bind(g.guard);
    g.guard.read = async (input) => { if (input.projectId === c!.remoteProjectId) throw storageError("08006", true); return read(input); };
    expect(await g.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-unresolvable" });
    expect(readBackendPublicationJournal(g.homeDir)?.phase).toBe("completed");
  });
});


describe("activateCutoverSet faults: remaining lease, selection and adoption branches", () => {
  it("acquire takeover that cannot be attributed, and a renew whose readback cannot be attributed", async () => {
    const f = await fixture();
    const [a] = f.members;
    const acquire = f.guard.acquire.bind(f.guard);
    f.guard.seed({ projectId: a!.remoteProjectId, publicationId: f.setId, evidenceSha256: a!.copyBindingSha256, databaseExpired: true });
    f.guard.acquire = async (input) => { if (input.expectedFencingToken !== undefined) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "readback-mismatch"); return acquire(input); };
    expect(await f.run()).toMatchObject({ status: "refused", step: "S2", members: [expect.objectContaining({ reason: "lease-unresolvable" }), expect.anything()] });
    f.guard.acquire = acquire;
    f.guard.rows.clear();
    const renew = f.guard.renew.bind(f.guard);
    const read = f.guard.read.bind(f.guard);
    f.guard.renew = async (input) => { if (input.projectId === a!.remoteProjectId) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "renew", "fence-mismatch"); return renew(input); };
    f.guard.read = async (input) => { if (input.projectId === a!.remoteProjectId) throw storageError("08006", true); return read(input); };
    expect(await f.run()).toMatchObject({ status: "refused", step: "S8", reason: "lease-unresolvable" });
    f.guard.renew = renew;
    f.guard.read = read;
    f.guard.rows.clear();
    // The same unattributable renew after the selection.
    await crashAt(f, "after-selection-completed");
    f.guard.renew = async (input) => { if (input.projectId === a!.remoteProjectId) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "renew", "fence-mismatch"); return renew(input); };
    let reads = 0;
    f.guard.read = async (input) => { reads += 1; if (input.projectId === a!.remoteProjectId && reads > 1) throw storageError("08006", true); return read(input); };
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-unresolvable" });
  });

  it("frozen attempts whose witness is stored without its attempt or epoch, and a post-publication adoption that cannot read evidence", async () => {
    const f = await fixture();
    await crashAt(f, "after-selection-frozen");
    const evidence = f.deps.evidence;
    expect(await f.run({ evidence: { ...evidence, readMigrationActivationEvidence: (input) => { const r = evidence.readMigrationActivationEvidence(input); return r.state === "resolved" ? { ...r, attempts: [] } : r; } } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable" });
    expect(await f.run({ evidence: { ...evidence, readMigrationActivationEvidence: (input) => { const r = evidence.readMigrationActivationEvidence(input); return r.state === "resolved" ? { ...r, epochs: [] } : r; } } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable" });
    const g = await fixture();
    await crashAt(g, "after-drive");
    expect(await g.run({ evidence: { ...g.deps.evidence, readMigrationActivationEvidence: () => ({ state: "unresolvable", reason: "injected" }) } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "evidence-unresolvable" });
  });

  it("a takeover before the freeze that regresses the token, or whose re-minted attempt cannot be recorded", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    await crashAt(f, "after-selection-frozen");
    expect(await f.run({ crashPoint: (p) => { if (p === "after-witness-binding:" + b!.generationId) { f.guard.expireNextFor = a!.remoteProjectId; f.guard.nextToken = 0n; } } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "lease-lost", detail: expect.stringContaining("regressed") });
    const g = await fixture();
    const [c, d] = g.members;
    let attempts = 0;
    const evidence = g.deps.evidence;
    expect(await g.run({
      crashPoint: (p) => { if (p === "after-witness-binding:" + d!.generationId) g.guard.expireNextFor = c!.remoteProjectId; },
      evidence: { ...evidence, recordMigrationActivationAttempt: (input) => { attempts += 1; if (attempts === 3) throw new MigrationActivationEvidenceRefusalError("evidence-unresolvable", "injected"); evidence.recordMigrationActivationAttempt(input); } },
    })).toMatchObject({ status: "interrupted", step: "S12", cause: "evidence-unresolvable" });
  });

  it("the set selection: a slot that holds another hold, a prepared journal carrying another tuple, and a completion refusal on resume", async () => {
    const f = await fixture();
    const journal = f.deps.readMaintenanceJournal;
    let reads = 0;
    expect(await f.run({ readMaintenanceJournal: (homeDir) => { reads += 1; const real = journal(homeDir); return reads === 3 && real !== null ? { ...real, cutoverSet: undefined, generationId: "generation-9" } : real; } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("not this set's sqlite hold") });
    const g = await fixture();
    const real = g.deps.createCoordinator;
    expect(await g.run({ createCoordinator: (input) => { const c = real(input); const prepare = c.prepareMaintenanceSelection.bind(c); c.prepareMaintenanceSelection = async (i, t) => ({ ...(await prepare(i, t)), terminalEvidenceSha256: HASH_A }); return c; } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("another tuple") });
    const h = await fixture();
    await crashAt(h, "after-selection-prepared");
    const hreal = h.deps.createCoordinator;
    expect(await h.run({ createCoordinator: (input) => { const c = hreal(input); c.completeMaintenanceSelection = async () => { throw new BackendPublicationJournalError("unexpected-state", "injected complete"); }; return c; } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("injected complete") });
    expectActivated(h, await h.run(), "selection-prepared");
  });

  it("an absent row at a completed publication is admitted because the coordinator released it", async () => {
    const f = await fixture();
    const [a] = f.members;
    await crashAt(f, "after-drive");
    f.guard.rows.delete(a!.remoteProjectId);
    expect(await f.run()).toMatchObject({ status: "activated", resumedFrom: "publication-journal" });
  });
});

describe("set replay admission faults (C2)", () => {
  it("refuses a linked member whose binding names a set while its link names its single-generation publication", async () => {
    const f = await fixture();
    const [a] = f.members;
    expect((await f.run()).status).toBe("activated");
    const selection = records(f).selection!;
    const { activationGenerationLinkPath } = await import("../../src/migration/activation-artifact-store.js");
    const { deriveActivationPublicationId } = await import("../../src/migration/activation-publication-id.js");
    rmSync(activationGenerationLinkPath(f.homeDir, a!.generationId));
    recordActivationGenerationLink({ homeDir: f.homeDir, generationId: a!.generationId, publicationId: deriveActivationPublicationId(a!.generationId), identityDigest: selection.identityDigest, epochManifestRevision: 8, epochManifestChecksumSha256: HASH_A });
    const { assertMigrationReplayAdmission } = await import("../../src/migration/maintenance.js");
    expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: a!.generationId, evidenceSha256: selection.members[0]!.witnessChecksumSha256 }))
      .toThrow(expect.objectContaining({ reason: "unresolved-publication", message: expect.stringContaining("single-generation") }));
  });

  it("refuses a completed set publication whose projects are not exactly the artifact's", async () => {
    const f = await fixture();
    expect((await f.run()).status).toBe("activated");
    const selection = records(f).selection!;
    const { backendPublicationJournalPath, backendPublicationCanonicalSha256 } = await import("../../src/storage/backend-publication.js");
    const { readFileSync, writeFileSync: write } = await import("node:fs");
    const { checksumSha256: _c, ...payload } = JSON.parse(readFileSync(backendPublicationJournalPath(f.homeDir), "utf8")) as Record<string, any>;
    payload.projects[0].evidenceSha256 = HASH_A;
    write(backendPublicationJournalPath(f.homeDir), JSON.stringify({ ...payload, checksumSha256: backendPublicationCanonicalSha256(payload) }) + "\n", { mode: 0o600 });
    const { assertMigrationReplayAdmission } = await import("../../src/migration/maintenance.js");
    expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: selection.members[0]!.generationId, evidenceSha256: selection.members[0]!.witnessChecksumSha256 }))
      .toThrow(expect.objectContaining({ reason: "unresolved-publication", message: expect.stringContaining("exactly the set artifact") }));
  });

  it("with a foreign slot, refuses a member whose manifest cannot be read or is still activating (report-only state)", async () => {
    const f = await fixture();
    const [a] = f.members;
    await crashAt(f, "after-complete:" + a!.generationId);
    const selection = records(f).selection!;
    await f.coordinator().enterMaintenance({
      publicationId: "migration-generation-9", generationId: "generation-9", sourceSelectionSha256: HASH_A, queueEvidenceSha256: HASH_A,
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: HASH_A }], sourceBackend: "postgresql",
    });
    const { assertMigrationReplayAdmission } = await import("../../src/migration/maintenance.js");
    const b = selection.members[1]!;
    expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: b.generationId, evidenceSha256: b.witnessChecksumSha256 }))
      .toThrow(expect.objectContaining({ reason: "unresolved-publication", message: expect.stringContaining("at phase activating") }));
    const { migrationManifestGenerationDirectory } = await import("../../src/migration/manifest-store.js");
    rmSync(migrationManifestGenerationDirectory(b.generationId, f.homeDir), { recursive: true });
    expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: b.generationId, evidenceSha256: b.witnessChecksumSha256 }))
      .toThrow(expect.objectContaining({ reason: "unresolved-publication", message: expect.stringContaining("manifest cannot be read") }));
  });
});


describe("activateCutoverSet faults: settlement classification and the selection completion guard", () => {
  it("a pending member that already holds a report, or whose report store cannot be probed, is mixed state under a foreign slot", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    await crashAt(f, "after-complete:" + a!.generationId);
    await crashAt(f, "after-report:" + b!.generationId);
    await f.coordinator().enterMaintenance({
      publicationId: "migration-generation-9", generationId: "generation-9", sourceSelectionSha256: HASH_A, queueEvidenceSha256: HASH_A,
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: HASH_A }], sourceBackend: "postgresql",
    });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "state-unresolvable", detail: expect.stringContaining("mixed") });
    const read = f.deps.readReport;
    expect(await f.run({ readReport: (input) => (input.reportSha256 === "0".repeat(64) ? { state: "unresolvable", reason: "read-unresolvable", detail: "injected" } : read(input)) }))
      .toMatchObject({ status: "interrupted", step: "S13b", cause: "state-unresolvable", detail: expect.stringContaining("mixed") });
    expectAllNew(f);
  });
});

