import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { clearProjectMapCache, projectMapPath } from "../../src/project-map.js";
import { readBackendMaintenanceJournal, readBackendPublicationJournal } from "../../src/storage/backend-publication.js";
import { MigrationActivationError } from "../../src/migration/activate-generation.js";
import { readCutoverSetActivationRecords } from "../../src/migration/cutover-set-activation-store.js";
import { performMigrationAbortCommand } from "../../src/migration/cli-abort.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { MigrationVerificationStoreError } from "../../src/migration/verification-store.js";
import { MIGRATION_MISMATCH_CLASSES } from "../../src/migration/verification-report.js";
import { cutoverSetMaintenanceEntry } from "../../src/migration/cutover-set.js";
import { backendCutoverSetJournalCapacity } from "../../src/storage/backend-publication.js";
import { MigrationProjectMapWitnessError } from "../../src/migration/project-map-witness.js";
import { activateCutoverSet } from "../../src/migration/cutover-set-activate.js";
import {
  HASH_A,
  REMOTES,
  TARGET_CONFIG,
  cleanupRoots,
  domainCensus,
  expectActivated,
  expectAllOld,
  expectNoEffects,
  fixture,
} from "./cutover-set-activate-fixture.js";

afterEach(cleanupRoots);

describe("activateCutoverSet: one publication for every member", () => {
  it("validates every member before the first effect, then checkpoints, selects once and publishes once", async () => {
    const f = await fixture();
    const compose = vi.fn(f.deps.composeMaterial);
    const outcome = await f.run({ composeMaterial: compose });
    expectActivated(f, outcome, "fresh");
    expect(compose).toHaveBeenCalledTimes(1);
    expect(compose.mock.calls[0]![0].bindings.map((b) => b.localProjectId)).toEqual(f.members.map((m) => m.localProjectId));
    expect(f.deps.prepareCalls).toBe(1);
    if (outcome.status !== "activated") return;
    expect(outcome.successorFencingToken).toBeNull();
    expect(outcome.members.map((member) => member.manifest)).toEqual(["active", "active"]);
    // Every remote guard row carried its own copy binding under the shared publication id.
    for (const member of f.members) {
      expect(f.guard.rows.get(member.remoteProjectId)).toMatchObject({ publicationId: f.setId, evidenceSha256: member.copyBindingSha256 });
    }
    // The checkpoint froze each member's verified revision and the selection names the stored witnesses.
    const records = readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId });
    expect(records).toMatchObject({ state: "resolved" });
    if (records.state !== "resolved") return;
    expect(records.checkpoint.members.map((row) => row.epochManifestRevision)).toEqual([8, 8]);
    expect(records.selection!.checkpointSha256).toBe(records.checkpoint.checksumSha256);
    // Replay admission routes every member to postgresql through the aggregate, never a bare index.
    for (const row of records.selection!.members) {
      expect(assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
        .toEqual({ backend: "postgresql", disposition: "selected" });
      expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: row.generationId, evidenceSha256: HASH_A })).toThrow();
    }
    // A sibling's witness never admits a member.
    const [first, second] = records.selection!.members as [typeof records.selection.members[number], typeof records.selection.members[number]];
    expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: first.generationId, evidenceSha256: second.witnessChecksumSha256 })).toThrow();
  });

  it("returns activated from durable state on a second call without composing, preparing or publishing again", async () => {
    const f = await fixture();
    expect((await f.run()).status).toBe("activated");
    const compose = vi.fn(f.deps.composeMaterial);
    const second = await f.run({ composeMaterial: compose, createCoordinator: () => { throw new Error("must not construct a coordinator"); } });
    expectActivated(f, second, "settled-active");
    expect(compose).not.toHaveBeenCalled();
    expect(f.deps.prepareCalls).toBe(1);
  });

  it("activates a three-member set with one artifact covering all three projects", async () => {
    const f = await fixture({ members: 3 });
    const outcome = await f.run();
    expectActivated(f, outcome, "fresh");
    expect(readBackendPublicationJournal(f.homeDir)?.projects).toHaveLength(3);
  });

  it("rejects invalid input before touching anything", async () => {
    const f = await fixture();
    for (const bad of [null, { ...f.input, homeDir: "" }, { ...f.input, confirmSetId: "../x" }, { ...f.input, targetConfig: null }, { ...f.input, targetConfig: { postgresql: { migrationRole: "" } } }]) {
      await expect(activateCutoverSet(bad as never, f.deps)).rejects.toBeInstanceOf(MigrationActivationError);
    }
    await expect(activateCutoverSet({ ...f.input, targetConfig: { ...TARGET_CONFIG, postgresql: { ...TARGET_CONFIG.postgresql, url: "not a url" } } }, f.deps))
      .rejects.toMatchObject({ reason: "invalid-input", message: expect.stringContaining("target") });
    expectNoEffects(f);
  });
});

describe("activateCutoverSet: whole-set refusals before any effect", () => {
  it("refuses when no set is held, when the hold belongs to another set, and when the slot holds a publication", async () => {
    const unheld = await fixture({ held: false });
    expect(await unheld.run()).toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held", effectBegun: false });
    expectNoEffects(unheld);
    const moved = await fixture();
    expect(await activateCutoverSet({ ...moved.input, confirmSetId: "cutover-set-other" }, moved.deps))
      .toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held", detail: expect.stringContaining(moved.setId) });
    expectNoEffects(moved);
    // A completed foreign publication in the slot: the set is simply not held.
    const published = await fixture();
    expect((await published.run()).status).toBe("activated");
    const again = await fixture();
    expect(await activateCutoverSet({ ...published.input, confirmSetId: again.setId }, published.deps))
      .toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held", detail: expect.stringContaining("publication") });
    const unregistered = await fixture();
    const { MachineIdentityFileError } = await import("../../src/machine-identity.js");
    expect(await unregistered.run({ machineId: () => { throw new MachineIdentityFileError("missing", "injected"); } }))
      .toMatchObject({ status: "refused", step: "S0", reason: "machine-identity-unregistered" });
    await expect(unregistered.run({ machineId: () => { throw new Error("other"); } })).rejects.toThrow("other");
    expect(await unregistered.run({ readMaintenanceJournal: () => { throw new Error("injected journal read"); } }))
      .toMatchObject({ status: "refused", step: "S0", reason: "maintenance-unresolvable" });
  });

  it("refuses an aborted set even when a checkpoint exists, and an entering set", async () => {
    const f = await fixture();
    await expect(f.run({ crashPoint: (point) => { if (point === "after-checkpoint") throw new Error("boom"); } })).rejects.toThrow("boom");
    expect(readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId })).toMatchObject({ state: "resolved", selection: null });
    // No member effect began, so the abort settles the members and releases the hold.
    expect(await performMigrationAbortCommand({ homeDir: f.homeDir, confirmGenerationId: f.setId })).toMatchObject({ status: "ok", journalPhase: "maintenance-aborted" });
    expect(await f.run()).toMatchObject({ status: "refused", step: "S3", reason: "cutover-set-aborted", effectBegun: false });
    expectAllOld(f);
    const entering = await fixture();
    entering.rewriteJournal((payload) => { payload.phase = "maintenance-entering"; });
    expect(await entering.run()).toMatchObject({ status: "refused", step: "S3", reason: "cutover-set-not-held" });
    const rollback = await fixture();
    rollback.rewriteJournal((payload) => { payload.sourceBackend = "postgresql"; });
    expect(await rollback.run()).toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held", detail: expect.stringContaining("postgresql") });
  });

  it("refuses membership drift, authority drift, unverifiable and unresolvable enumerations", async () => {
    const f = await fixture();
    const base = f.deps.resolveAuthorities({ homeDir: f.homeDir, lockToken: {} });
    if (base.status !== "resolved") throw new Error("unreachable");
    expect(await f.run({ resolveAuthorities: () => ({ status: "unresolvable", reason: "projects-directory-unreadable", detail: "injected" }) }))
      .toMatchObject({ status: "refused", step: "S4", reason: "cutover-set-enumeration-unresolvable" });
    expect(await f.run({ resolveAuthorities: () => ({ status: "resolved", outcomes: [base.outcomes[0]!, { physicalProjectId: f.members[1]!.localProjectId, status: "unverifiable", detail: "x" }] }) }))
      .toMatchObject({ status: "refused", step: "S4", reason: "cutover-set-member-unverifiable" });
    expect(await f.run({ resolveAuthorities: () => ({ status: "resolved", outcomes: [...base.outcomes, { ...base.outcomes[0]!, physicalProjectId: HASH_A }] }) }))
      .toMatchObject({ status: "refused", step: "S4", reason: "cutover-set-membership-drift", detail: expect.stringContaining(HASH_A) });
    f.deps.sourceSelectionOverride.set(f.members[1]!.localProjectId, HASH_A);
    expect(await f.run()).toMatchObject({ status: "refused", step: "S4", reason: "cutover-set-authority-drifted", detail: expect.stringContaining(f.members[1]!.localProjectId) });
    f.deps.sourceSelectionOverride.clear();
    const extra = await fixture({ extraProjectWithData: true });
    expect(await extra.run()).toMatchObject({ status: "refused", step: "S4", reason: "cutover-set-membership-drift" });
    expectNoEffects(extra);
    expectNoEffects(f);
  });

  it("refuses coverage failures through the real coverage check and a changed inventory after reconciliation", async () => {
    const f = await fixture();
    expect(await f.run({ checkCoverage: () => ({ status: "unsatisfied", reason: "uncovered-projects", detail: "injected", uncovered: [] }) as never }))
      .toMatchObject({ status: "refused", step: "S4", reason: "coverage-unsatisfied" });
    expect(await f.run({ checkCoverage: () => ({ status: "unresolvable", reason: "projects-directory-unreadable", detail: "injected", uncovered: [] }) as never }))
      .toMatchObject({ status: "refused", step: "S4", reason: "coverage-unresolvable" });
    expect(await f.run({ enumerateStoredData: () => ({ status: "unresolvable", reason: "projects-directory-unreadable", detail: "injected" }) as never }))
      .toMatchObject({ status: "refused", step: "S4", reason: "coverage-unresolvable" });
    expect(await f.run({ enumerateStoredData: () => ({ status: "resolved", projectHashes: [f.members[0]!.localProjectId] }) as never }))
      .toMatchObject({ status: "refused", step: "S4", reason: "cutover-set-membership-drift", detail: expect.stringContaining("reconciliation") });
    expectNoEffects(f);
  });

  it("refuses a legacy held set that cannot fit its selection before any effect, which stays abortable", async () => {
    const LIMIT = 1024 * 1024;
    const hex = "f".repeat(64);
    const f = await fixture();
    const manifestOf = (size: number) => ({
      version: 1 as const, setId: f.setId, machineId: f.manifest.machineId, members: Array.from({ length: size }, (_, index) => ({
        physicalProjectId: (index + 1).toString(16).padStart(64, "0"), generationId: "member-generation-" + String(index + 1), sourceSelectionSha256: (index + 0x1000).toString(16).padStart(64, "0"),
      })),
    });
    const abortWorstBytes = (manifest: ReturnType<typeof manifestOf>) => Buffer.byteLength(JSON.stringify({
      version: 3, publicationId: manifest.setId, sourceBackend: "postgresql", targetBackend: null, phase: "maintenance-aborted",
      createdAt: "+275760-09-13T00:00:00.000Z", updatedAt: "+275760-09-13T00:00:00.000Z", generationId: manifest.setId,
      sourceSelectionSha256: hex, queueEvidenceSha256: hex, roster: [{ machineId: manifest.machineId, queueCutoff: null, evidenceSha256: hex }],
      selectedGenerationId: null, terminalEvidenceSha256: null, abortEvidenceSha256: hex,
      cutoverSet: { manifest, bindings: manifest.members.map((m) => ({ generationId: m.generationId, queueEvidenceSha256: hex, roster: [{ machineId: manifest.machineId, queueCutoff: "9223372036854775807", evidenceSha256: hex }] })) },
      checksumSha256: hex,
    })) + 1;
    let low = 2;
    let high = 3000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (abortWorstBytes(manifestOf(mid)) <= LIMIT) low = mid; else high = mid - 1;
    }
    const entry = cutoverSetMaintenanceEntry(manifestOf(low));
    expect(backendCutoverSetJournalCapacity(entry.cutoverSet).worstCaseBytes).toBeGreaterThan(LIMIT);
    f.rewriteJournal((payload) => {
      payload.cutoverSet = entry.cutoverSet;
      payload.sourceSelectionSha256 = entry.sourceSelectionSha256;
      payload.queueEvidenceSha256 = entry.queueEvidenceSha256;
      payload.roster = entry.roster;
    });
    const legacy = f.journal()!;
    expect(await f.run()).toMatchObject({ status: "refused", step: "S0", reason: "cutover-set-too-large", effectBegun: false });
    expect(f.journal()).toEqual(legacy);
    expect(readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId })).toEqual({ state: "authoritatively-absent" });
    const aborted = await f.coordinator().abortMaintenance({ expectedChecksumSha256: legacy.checksumSha256, sourceSelectionSha256: legacy.sourceSelectionSha256, abortEvidenceSha256: HASH_A });
    expect(aborted.phase).toBe("maintenance-aborted");
  }, 120_000);
});

describe("activateCutoverSet: per-member refusals name every failing member", () => {
  it("refuses a member whose manifest is absent, not eligible or pending a foreign effect", async () => {
    const absent = await fixture({ noManifest: 1 });
    expect(await absent.run()).toMatchObject({
      status: "refused", step: "S5", reason: "cutover-set-member-evidence-absent",
      failures: [{ generationId: absent.members[1]!.generationId, reason: "cutover-set-member-evidence-absent" }],
      members: [expect.objectContaining({ evidence: null }), expect.objectContaining({ evidence: "absent", reason: "manifest-absent" })],
    });
    const copied = await fixture({ notVerified: 0 });
    expect(await copied.run()).toMatchObject({
      status: "refused", reason: "cutover-set-member-evidence-stale",
      members: [expect.objectContaining({ evidence: "stale", reason: "manifest-not-eligible" }), expect.objectContaining({ evidence: null })],
    });
    expectAllOld(copied);
  });

  it("gathers independently failing members instead of stopping at the first", async () => {
    const f = await fixture({ members: 3 });
    f.deps.snapshotChecksumOverride.set(f.members[0]!.generationId, HASH_A);
    f.deps.identityOverride.set(f.members[2]!.localProjectId, { status: "refuse", reason: "destination-project-absent" });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-drifted" });
    if (outcome.status !== "refused") return;
    expect(outcome.failures.map((failure) => [failure.generationId, failure.reason])).toEqual([
      [f.members[0]!.generationId, "cutover-set-member-evidence-drifted"],
      [f.members[2]!.generationId, "cutover-set-member-evidence-unverifiable"],
    ]);
    expect(outcome.members.map((member) => member.reason)).toEqual(["member-binding-drifted", null, "destination-project-absent"]);
    expectNoEffects(f);
  });

  it("refuses an uncaptured member, a member whose persisted identity names another project, and an unmapped member", async () => {
    const uncaptured = await fixture({ uncaptured: 1 });
    expect(await uncaptured.run()).toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-absent", members: [expect.anything(), expect.objectContaining({ reason: "cutover-set-member-unbound" })] });
    const f = await fixture();
    f.deps.identityOverride.set(f.members[0]!.localProjectId, { id: REMOTES[2], remoteProjectId: REMOTES[2], localProjectId: HASH_A, machineId: "x", canonical: "/x", selectedPath: "/x" } as never);
    expect(await f.run()).toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-drifted", members: [expect.objectContaining({ reason: "cutover-set-member-identity" }), expect.anything()] });
    f.deps.identityOverride.clear();
    expect(await f.run({ readCanonicalPath: ({ hash }) => (hash === f.members[1]!.localProjectId ? null : f.members[0]!.canonical) }))
      .toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-unverifiable", members: [expect.anything(), expect.objectContaining({ reason: "cutover-set-member-unmapped" })] });
    expect(await f.run({ readCanonicalPath: () => { throw new Error("injected map read"); } }))
      .toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-unverifiable", members: [expect.objectContaining({ detail: expect.stringContaining("injected map read") }), expect.anything()] });
    expect(await f.run({ inspectSnapshot: async () => { throw new Error("injected snapshot"); } }))
      .toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-unverifiable", members: [expect.objectContaining({ reason: "verification-unresolvable" }), expect.anything()] });
    expectNoEffects(f);
  });

  it("refuses a target change: a member id outside the family of its path and the supplied target", async () => {
    const f = await fixture();
    const { activateCutoverSet } = await import("../../src/migration/cutover-set-activate.js");
    const other = { ...TARGET_CONFIG, postgresql: { ...TARGET_CONFIG.postgresql, url: "postgresql://lcm@elsewhere.example.test:5432/lcm" } } as typeof TARGET_CONFIG;
    expect(await activateCutoverSet({ ...f.input, targetConfig: other }, f.deps))
      .toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-drifted", members: [expect.objectContaining({ reason: "cutover-set-target-changed" }), expect.objectContaining({ reason: "cutover-set-target-changed" })] });
    expectNoEffects(f);
  });

  it("refuses stale or unreadable verification evidence and a drifted project map", async () => {
    const f = await fixture();
    expect(await f.run({ readVerificationReport: (generationId, sha) => {
      if (generationId === f.members[1]!.generationId) throw new MigrationVerificationStoreError("unreadable", "injected");
      return f.deps.readVerificationReport(generationId, sha);
    } })).toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-unverifiable", members: [expect.anything(), expect.objectContaining({ reason: "verification-unresolvable" })] });
    expect(await f.run({ readVerificationReport: (generationId, sha) => {
      const report = f.deps.readVerificationReport(generationId, sha);
      return generationId === f.members[0]!.generationId ? { ...report, reportId: "other" } : report;
    } })).toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-stale", members: [expect.objectContaining({ reason: "verification-stale" }), expect.anything()] });
    const map = JSON.parse(readFileSync(projectMapPath(f.homeDir), "utf8")) as Record<string, { canonical: string; aliases: string[]; remoteProjectId?: string }>;
    map[f.members[0]!.localProjectId]!.remoteProjectId = REMOTES[2];
    writeFileSync(projectMapPath(f.homeDir), JSON.stringify(map) + "\n", { mode: 0o600 });
    clearProjectMapCache();
    expect(await f.run()).toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-drifted", members: [expect.objectContaining({ reason: "project-map-drift" }), expect.anything()] });
    delete map[f.members[0]!.localProjectId]!.remoteProjectId;
    map[f.members[1]!.localProjectId]!.canonical = "/moved/elsewhere";
    writeFileSync(projectMapPath(f.homeDir), JSON.stringify(map) + "\n", { mode: 0o600 });
    clearProjectMapCache();
    // A moved canonical path leaves the member's generation family before the witness is even compared.
    expect(await f.run()).toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-drifted", members: [expect.anything(), expect.objectContaining({ reason: "cutover-set-target-changed" })] });
    map[f.members[1]!.localProjectId]!.canonical = f.members[1]!.canonical;
    writeFileSync(projectMapPath(f.homeDir), JSON.stringify(map) + "\n", { mode: 0o600 });
    clearProjectMapCache();
    expect(await f.run({ computeProjectMapWitness: (request) => request.localProjectId === f.members[1]!.localProjectId ? HASH_A : f.deps.computeProjectMapWitness(request) }))
      .toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-drifted", members: [expect.anything(), expect.objectContaining({ reason: "project-map-drift", detail: expect.stringContaining("differs") })] });
    expect(await f.run({ computeProjectMapWitness: () => { throw new MigrationProjectMapWitnessError("project-map-unresolvable", "injected"); } }))
      .toMatchObject({ status: "refused", reason: "cutover-set-member-evidence-unverifiable", members: [expect.objectContaining({ reason: "state-unresolvable" }), expect.objectContaining({ reason: "state-unresolvable" })] });
    await expect(f.run({ computeProjectMapWitness: () => { throw new Error("not a witness error"); } })).rejects.toThrow("not a witness error");
    expectNoEffects(f);
  });

  it("refuses an unreadable copy binding, identity drift, a lease conflict and quiescence failures, releasing every acquired lease", async () => {
    const f = await fixture();
    f.deps.transferRows.set(f.members[1]!.remoteProjectId, []);
    expect(await f.run()).toMatchObject({ status: "refused", step: "S0", reason: "cutover-set-member-evidence-unverifiable", members: [expect.anything(), expect.objectContaining({ reason: "verification-unresolvable" })] });
    f.deps.transferRows.set(f.members[1]!.remoteProjectId, [{ run_id: "migration-copy-" + f.members[1]!.copyBindingSha256, state: "completed" }]);
    f.deps.identity.sealedWitnessSha256 = "f".repeat(64);
    expect(await f.run()).toMatchObject({ status: "refused", step: "S0", reason: "cutover-set-member-evidence-drifted", members: [expect.objectContaining({ reason: "identity-drift" }), expect.objectContaining({ reason: "identity-drift" })] });
    f.deps.identity.sealedWitnessSha256 = "d".repeat(64);
    f.guard.seed({ projectId: f.members[1]!.remoteProjectId, publicationId: "someone-else" });
    const conflict = await f.run();
    expect(conflict).toMatchObject({ status: "refused", step: "S2", reason: "cutover-set-member-evidence-unverifiable", members: [expect.anything(), expect.objectContaining({ reason: "lease-conflict" })] });
    // The first member's lease was acquired and released again; the foreign row is untouched.
    expect(f.guard.rows.get(f.members[0]!.remoteProjectId)?.releasedAt).not.toBeNull();
    expect(f.guard.rows.get(f.members[1]!.remoteProjectId)).toMatchObject({ publicationId: "someone-else", releasedAt: null });
    f.guard.rows.delete(f.members[1]!.remoteProjectId);
    expect(await f.run({ checkSetQuiescence: async (request) => request.generationId === f.members[0]!.generationId
      ? { status: "unresolvable", reason: "machine-identity-unavailable", detail: "injected", quiescenceFence: null }
      : f.deps.checkSetQuiescence(request) }))
      .toMatchObject({ status: "refused", step: "S3", reason: "cutover-set-member-evidence-unverifiable", members: [expect.objectContaining({ reason: "quiescence-unresolvable" }), expect.anything()] });
    expect(await f.run({ checkSetQuiescence: async () => ({ status: "unsatisfied", reason: "roster-row-absent", detail: "injected", quiescenceFence: null }) }))
      .toMatchObject({ status: "refused", step: "S3", reason: "cutover-set-member-evidence-unverifiable", members: [expect.objectContaining({ reason: "quiescence-unsatisfied" }), expect.objectContaining({ reason: "quiescence-unsatisfied" })] });
    expect(await f.run({ checkSetQuiescence: async () => ({ status: "unsatisfied", reason: "maintenance-not-held", detail: "injected", quiescenceFence: null }) }))
      .toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held" });
    expect(await f.run({ checkSetQuiescence: async () => ({ status: "unresolvable", reason: "maintenance-journal-unresolvable", detail: "injected", quiescenceFence: null }) }))
      .toMatchObject({ status: "refused", step: "S3", reason: "maintenance-unresolvable" });
    expectNoEffects(f);
  });

  it("refuses target health, census drift, incomplete class coverage, mismatches and S7 target failures", async () => {
    const f = await fixture();
    f.deps.health.push({ status: "unhealthy", reason: "schema-mismatch", detail: "injected" } as never);
    expect(await f.run()).toMatchObject({ status: "refused", step: "S6", reason: "target-unhealthy" });
    f.deps.health.push({ status: "unresolvable", reason: "health-unreachable", detail: "injected" } as never);
    expect(await f.run()).toMatchObject({ status: "refused", step: "S6", reason: "target-unresolvable" });
    f.deps.destinationCensus.set(f.members[1]!.remoteProjectId, domainCensus("changed"));
    expect(await f.run()).toMatchObject({ status: "refused", step: "S8", reason: "cutover-set-member-evidence-stale", members: [expect.anything(), expect.objectContaining({ reason: "census-drift" })] });
    f.deps.destinationCensus.set(f.members[1]!.remoteProjectId, domainCensus("census-" + f.members[1]!.localProjectId.slice(0, 4)));
    // A stored report derives its eligibility from its coverage, so the S8 class and mismatch checks are reached through the reader seam.
    expect(await f.run({ readVerificationReport: (generationId, sha) => {
      const report = f.deps.readVerificationReport(generationId, sha);
      return generationId === f.members[0]!.generationId
        ? { ...report, body: { ...report.body, classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass, index) => ({ class: mismatchClass, ran: index !== 0 })) } }
        : report;
    } })).toMatchObject({ status: "refused", step: "S8", reason: "cutover-set-member-evidence-stale", members: [expect.objectContaining({ reason: "class-coverage-incomplete" }), expect.anything()] });
    expect(await f.run({ readVerificationReport: (generationId, sha) => {
      const report = f.deps.readVerificationReport(generationId, sha);
      return generationId === f.members[1]!.generationId ? { ...report, mismatchTotals: [{ class: "missing-row", count: 1 }] as never } : report;
    } })).toMatchObject({ status: "refused", step: "S8", reason: "cutover-set-member-evidence-stale", members: [expect.anything(), expect.objectContaining({ reason: "verification-mismatch" })] });
    const { PostgreSqlStorageOperationError } = await import("../../src/storage/postgresql/errors.js");
    expect(await f.run({ destinationCensus: undefined, readDestinationCensus: async (_s, census) => {
      if (census.expectedIdentity.remoteProjectId === f.members[0]!.remoteProjectId) throw new PostgreSqlStorageOperationError("factory", "readFencedDestinationCensus", "unavailable", "injected");
      return { census: f.deps.destinationCensus.get(census.expectedIdentity.remoteProjectId!)! };
    } } as never)).toMatchObject({ status: "refused", step: "S8", reason: "cutover-set-member-evidence-unverifiable", members: [expect.objectContaining({ reason: expect.stringMatching(/^target-/) }), expect.anything()] });
    expect(await f.run({ verifyTransferSchema: async () => { throw new PostgreSqlStorageOperationError("factory", "verify", "unavailable", "injected"); } }))
      .toMatchObject({ status: "refused", step: "S8", reason: "cutover-set-member-evidence-unverifiable" });
    await expect(f.run({ verifyTransferSchema: async () => { throw new Error("not a storage error"); } })).rejects.toThrow("not a storage error");
    const controller = new AbortController();
    controller.abort();
    const { activateCutoverSet } = await import("../../src/migration/cutover-set-activate.js");
    const cancelled = await activateCutoverSet({ ...f.input, signal: controller.signal }, { ...f.deps, destinationCensus: undefined } as never).catch((error: Error) => error);
    expect(cancelled).toBeInstanceOf(Error);
    expectAllOld(f);
    for (const member of f.members) expect(f.manifestStore.read(member.generationId).phase).toBe("verified");
  });
});

describe("activateCutoverSet: slot readers keep their boundary at the selection phases (C7)", () => {
  it("a set at selection-completed refuses replay for every member and the abort gate refuses the set", async () => {
    const f = await fixture();
    await expect(f.run({ crashPoint: (point) => { if (point === "after-selection-completed") throw new Error("boom"); } })).rejects.toThrow("boom");
    expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("selection-completed");
    const records = readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId });
    if (records.state !== "resolved" || records.selection === null) throw new Error("unreachable");
    for (const row of records.selection.members) {
      expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
        .toThrow(expect.objectContaining({ reason: "unresolved-publication" }));
    }
    // Pending activation effects refuse the abort rather than deleting activation evidence.
    expect(await performMigrationAbortCommand({ homeDir: f.homeDir, confirmGenerationId: f.setId })).toMatchObject({ status: "refuse" });
    expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("selection-completed");
    expectAllOld(f);
    // The resume completes the same frozen selection and publication.
    expectActivated(f, await f.run(), "selection-completed");
  });
});

