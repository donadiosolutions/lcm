import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, rmSync } from "node:fs";
import {
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationAppendBarrierAsync,
} from "../../src/storage/backend-publication.js";
import { readCutoverSetActivationRecords, migrationCutoverSetActivationDirectory } from "../../src/migration/cutover-set-activation-store.js";
import { readActivationGenerationLink } from "../../src/migration/activation-artifact-store.js";
import { migrationActivationReportDirectory } from "../../src/migration/activation-report.js";
import { readMigrationActivationEvidence } from "../../src/migration/activation-evidence-store.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { performMigrationAbortCommand } from "../../src/migration/cli-abort.js";
import { MigrationProjectMapWitnessError } from "../../src/migration/project-map-witness.js";
import { PostgreSqlBackendPublicationGuardError } from "../../src/storage/postgresql/publication-guard.js";
import { migrationSelectionBindingPath } from "../../src/migration/generation-binding-store.js";
import {
  HASH_A,
  cleanupRoots,
  effectiveHome,
  expectActivated,
  expectAllNew,
  expectAllOld,
  fixture,
  type Fixture,
} from "./cutover-set-activate-fixture.js";

afterEach(cleanupRoots);

/** The effective home never shows one project on each backend. */
function expectNotMixed(f: Fixture): void {
  const home = effectiveHome(f);
  const bound = home.bound.filter(Boolean).length;
  expect(bound === 0 || bound === f.members.length).toBe(true);
  if (home.backend === "postgresql") expect(bound).toBe(f.members.length);
  if (bound === 0) expect(home.backend).toBe("sqlite");
}

function records(f: Fixture) {
  const read = readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId });
  if (read.state !== "resolved") throw new Error("records not resolved: " + JSON.stringify(read));
  return read;
}

async function crashThenResume(f: Fixture, point: string, resumedFrom: string, between?: () => void | Promise<void>) {
  await expect(f.run({ crashPoint: (p) => { if (p === point) throw new Error("crash at " + point); } })).rejects.toThrow("crash at " + point);
  expectNotMixed(f);
  await between?.();
  const outcome = await f.run();
  expectActivated(f, outcome, resumedFrom);
  return outcome;
}

describe("activateCutoverSet: crash at every boundary resumes to all-old or all-new (D6)", () => {
  it("before the checkpoint: the orphan artifact is reused byte-identically and nothing moved", async () => {
    const f = await fixture();
    const publish = vi.fn(f.deps.publishArtifact);
    await expect(f.run({ crashPoint: (p) => { if (p === "after-artifact") throw new Error("crash at after-artifact"); } })).rejects.toThrow();
    expectAllOld(f);
    for (const member of f.members) expect(f.manifestStore.read(member.generationId).phase).toBe("verified");
    expect(readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId })).toEqual({ state: "authoritatively-absent" });
    // The pre-effect leases were released by the thrown-error path.
    for (const member of f.members) expect(f.guard.rows.get(member.remoteProjectId)?.releasedAt).not.toBeNull();
    const outcome = await f.run({ publishArtifact: publish });
    expectActivated(f, outcome, "fresh");
    expect(publish).not.toHaveBeenCalled();
  });

  it("after the checkpoint and before any member effect: resumes pre-selection with the same artifact, releasing then reacquiring leases", async () => {
    const f = await fixture();
    const compose = vi.fn(f.deps.composeMaterial);
    await crashThenResume(f, "after-checkpoint", "pre-selection", () => {
      for (const member of f.members) expect(f.manifestStore.read(member.generationId).phase).toBe("verified");
      expect(records(f).selection).toBeNull();
      for (const member of f.members) expect(f.guard.rows.get(member.remoteProjectId)?.releasedAt).not.toBeNull();
    });
    expect(compose).not.toHaveBeenCalled();
  });

  for (const point of ["after-prepare-begin", "after-prepare-complete", "after-publish-begin", "after-link", "after-epoch", "after-attempt", "after-witness", "after-witness-binding"]) {
    it("member A at " + point + " with B untouched: B keeps its frozen revision and A keeps its begun effect", async () => {
      const f = await fixture();
      const [a, b] = f.members as [Fixture["members"][number], Fixture["members"][number]];
      const compose = vi.fn(f.deps.composeMaterial);
      await crashThenResume(f, point + ":" + a.generationId, "pre-selection", () => {
        expect(f.manifestStore.read(b.generationId).phase).toBe("verified");
        expect(["verified", "activating"]).toContain(f.manifestStore.read(a.generationId).phase);
        expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("maintenance-held");
        // A's lease is kept for the roll-forward once its effect began.
        expect(f.guard.rows.get(a.remoteProjectId)?.releasedAt).toBeNull();
      });
      expect(compose).not.toHaveBeenCalled();
    });
    it("member B at " + point + " with A fully evidenced: no second artifact, link or attempt", async () => {
      const f = await fixture();
      const [a, b] = f.members as [Fixture["members"][number], Fixture["members"][number]];
      await crashThenResume(f, point + ":" + b.generationId, "pre-selection", () => {
        expect(f.manifestStore.read(a.generationId).phase).toBe("activating");
        const link = readActivationGenerationLink({ homeDir: f.homeDir, generationId: a.generationId });
        expect(link.state).toBe("resolved");
      });
      const evidence = readMigrationActivationEvidence({ homeDir: f.homeDir, generationId: a.generationId });
      if (evidence.state === "resolved") expect(evidence.attempts).toHaveLength(1);
    });
  }

  it("after the frozen selection, before selection-prepared: the frozen attempts are adopted, not re-minted", async () => {
    const f = await fixture();
    const outcome = await crashThenResume(f, "after-selection-frozen", "selection-frozen", () => {
      expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("maintenance-held");
      expect(records(f).selection).not.toBeNull();
    });
    void outcome;
    const selection = records(f).selection!;
    for (const member of f.members) {
      const evidence = readMigrationActivationEvidence({ homeDir: f.homeDir, generationId: member.generationId });
      if (evidence.state !== "resolved") throw new Error("unreachable");
      expect(evidence.attempts.map((attempt) => attempt.attemptId)).toEqual([selection.members.find((row) => row.generationId === member.generationId)!.attemptId]);
    }
  });

  it("selection-prepared: the same tuple is completed", async () => {
    const f = await fixture();
    await crashThenResume(f, "after-selection-prepared", "selection-prepared", () => {
      const journal = readBackendMaintenanceJournal(f.homeDir)!;
      expect(journal.phase).toBe("selection-prepared");
      expect(journal.cutoverSet!.selection).toEqual(records(f).selection);
      expectAllOld(f);
    });
  });

  it("selection-completed with no binding and with only A's binding: indexes are repaired from the aggregate and one drive runs", async () => {
    const f = await fixture();
    await crashThenResume(f, "after-selection-completed", "selection-completed", () => {
      expectAllOld(f);
      expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("selection-completed");
    });
    expect(f.deps.prepareCalls).toBe(1);
    const g = await fixture();
    const [a] = g.members;
    await crashThenResume(g, "after-selection-binding:" + a!.generationId, "selection-completed", () => {
      expect(readdirSync(migrationCutoverSetActivationDirectory(g.homeDir, g.setId)).sort()).toEqual(["checkpoint.json", "selection.json"]);
    });
    expect(g.deps.prepareCalls).toBe(1);
  });

  it("the coordinator crashes mid-publication (map published, config not): the version-2 journal resumes, never a second prepare", async () => {
    const f = await fixture();
    let crashed = false;
    const crashing = f.coordinator((event) => {
      if (crashed || event !== "after-journal-write") return;
      if (readBackendPublicationJournal(f.homeDir)?.phase === "map-published") { crashed = true; throw new Error("injected coordinator crash"); }
    });
    await expect(f.run({ createCoordinator: () => crashing })).rejects.toThrow("injected coordinator crash");
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("map-published");
    expectNotMixed(f);
    // Ordinary consumers see an unresolved publication, never a half-published pair.
    for (const member of f.members) {
      expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: member.generationId, evidenceSha256: records(f).selection!.members.find((r) => r.generationId === member.generationId)!.witnessChecksumSha256 }))
        .toThrow(expect.objectContaining({ reason: "unresolved-publication" }));
    }
    const outcome = await f.run();
    expectActivated(f, outcome, "publication-journal");
    // The one prepare ran inside the crashing coordinator; the resume prepared nothing.
    expect(f.deps.prepareCalls).toBe(0);
  });

  it("the publication completed, no member settled: the completed journal is reported, both members settle without republishing", async () => {
    const f = await fixture();
    await crashThenResume(f, "after-drive", "publication-journal", () => {
      expectAllNew(f);
      for (const member of f.members) expect(f.manifestStore.read(member.generationId).phase).toBe("activating");
    });
    expect(f.deps.prepareCalls).toBe(1);
  });

  it("A active, B pending (crash after A's completion): B settles, A authenticates and skips", async () => {
    const f = await fixture();
    const [a, b] = f.members as [Fixture["members"][number], Fixture["members"][number]];
    const persist = vi.fn(f.deps.persistReport);
    await crashThenResume(f, "after-complete:" + a.generationId, "publication-journal", () => {
      expect(f.manifestStore.read(a.generationId).phase).toBe("active");
      expect(f.manifestStore.read(b.generationId).phase).toBe("activating");
      expectAllNew(f);
      // A already replays as postgresql through its report; B is still unresolved.
      const selection = records(f).selection!;
      expect(assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: a.generationId, evidenceSha256: selection.members[0]!.witnessChecksumSha256 })).toEqual({ backend: "postgresql", disposition: "selected" });
    });
    void persist;
  });

  it("A's report written, effect not completed: the report is reused byte-identically", async () => {
    const f = await fixture();
    const [a] = f.members;
    const persist = vi.fn(f.deps.persistReport);
    await expect(f.run({ crashPoint: (p) => { if (p === "after-report:" + a!.generationId) throw new Error("boom"); } })).rejects.toThrow("boom");
    expect(readdirSync(migrationActivationReportDirectory(f.homeDir, a!.generationId))).toHaveLength(1);
    expectActivated(f, await f.run({ persistReport: persist }), "publication-journal");
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.results[0]!.value).toMatchObject({ outcome: "reused" });
  });

  it("an empty slot after the selection (the terminal v3 gone before any version-2 write): the frozen artifact is prepared fresh", async () => {
    const f = await fixture();
    await expect(f.run({ crashPoint: (p) => { if (p === "after-selection-completed") throw new Error("boom"); } })).rejects.toThrow("boom");
    // The coordinator replaces the journal atomically, so the empty slot is simulated by removing the archived terminal journal.
    rmSync(backendPublicationJournalPath(f.homeDir));
    expect(readBackendMaintenanceJournal(f.homeDir)).toBeNull();
    expect(readBackendPublicationJournal(f.homeDir)).toBeNull();
    expectAllOld(f);
    const outcome = await f.run();
    if (outcome.status !== "activated") throw new Error(JSON.stringify(outcome, null, 1));
    expectActivated(f, outcome, "slot-replaced");
    expect(f.deps.prepareCalls).toBe(1);
  });
});

describe("activateCutoverSet: lease continuation across members", () => {
  it("a lease expired before the freeze is taken over and that member's attempt is re-minted", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    // Expire A's row once every member's evidence is recorded, so the renew before the freeze takes it over.
    const outcome = await f.run({ crashPoint: (p) => { if (p === "after-witness-binding:" + b!.generationId) f.guard.expireNextFor = a!.remoteProjectId; } });
    expectActivated(f, outcome, "fresh");
    const evidence = readMigrationActivationEvidence({ homeDir: f.homeDir, generationId: a!.generationId });
    if (evidence.state !== "resolved") throw new Error("unreachable");
    expect(evidence.attempts.length).toBeGreaterThanOrEqual(2);
    expect(f.guard.calls.filter((call) => call === "acquire:" + a!.remoteProjectId).length).toBeGreaterThanOrEqual(2);
  });

  it("a lease expired after the freeze is taken over without touching the frozen attempts and reports the successor token", async () => {
    const f = await fixture();
    const [a] = f.members;
    await expect(f.run({ crashPoint: (p) => { if (p === "after-selection-frozen") throw new Error("boom"); } })).rejects.toThrow("boom");
    f.guard.expire(a!.remoteProjectId);
    const outcome = await f.run();
    expectActivated(f, outcome, "selection-frozen");
    if (outcome.status !== "activated") return;
    expect(outcome.successorFencingToken).not.toBeNull();
    const evidence = readMigrationActivationEvidence({ homeDir: f.homeDir, generationId: a!.generationId });
    if (evidence.state === "resolved") expect(evidence.attempts).toHaveLength(1);
  });

  it("a lease lost after the selection stops with lease-lost and keeps the selection", async () => {
    const f = await fixture();
    const [a] = f.members;
    await expect(f.run({ crashPoint: (p) => { if (p === "after-selection-completed") throw new Error("boom"); } })).rejects.toThrow("boom");
    f.guard.rows.delete(a!.remoteProjectId);
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost", effectBegun: true, applied: "no" });
    expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("selection-completed");
    f.guard.seed({ projectId: a!.remoteProjectId, publicationId: "stranger", evidenceSha256: a!.copyBindingSha256 });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost", detail: expect.stringContaining("another publication") });
    expectAllOld(f);
  });

  it("a crash at releasing with successor publications' rows present finishes without touching them; a corrupt row stays lease-lost (Bug #1651)", async () => {
    const f = await fixture();
    let crashed = false;
    const crashing = f.coordinator((event) => {
      if (crashed || event !== "after-journal-write") return;
      if (readBackendPublicationJournal(f.homeDir)?.phase === "releasing") { crashed = true; throw new Error("injected coordinator crash at releasing"); }
    });
    await expect(f.run({ createCoordinator: () => crashing })).rejects.toThrow("injected coordinator crash at releasing");
    // The remote releases committed; other homes then acquired every released row.
    for (const member of f.members) {
      f.guard.rows.delete(member.remoteProjectId);
      f.guard.seed({ projectId: member.remoteProjectId, publicationId: "another-publication" });
    }
    const successors = f.members.map((member) => ({ ...f.guard.rows.get(member.remoteProjectId)! }));
    const read = f.guard.read.bind(f.guard);
    f.guard.read = async () => { throw new PostgreSqlBackendPublicationGuardError(f.members[0]!.remoteProjectId, "read", "invalid-row"); };
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost" });
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("releasing");
    f.guard.read = read;
    const mutations = f.guard.calls.filter((call) => !call.startsWith("read:")).length;
    expect(await f.run()).toMatchObject({ status: "activated", resumedFrom: "publication-journal" });
    for (const member of f.members) expect(f.manifestStore.read(member.generationId).phase).toBe("active");
    expect(f.guard.calls.filter((call) => !call.startsWith("read:"))).toHaveLength(mutations);
    expect(f.members.map((member) => f.guard.rows.get(member.remoteProjectId))).toEqual(successors);
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("completed");
  });

  it("a lease lost before the freeze is a roll-forward interruption that keeps every member's evidence, and a lost lease before any effect is a refusal", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    const outcome = await f.run({ crashPoint: (p) => { if (p === "after-witness-binding:" + b!.generationId) f.guard.rows.delete(a!.remoteProjectId); } });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S9", cause: "lease-lost", effectBegun: true, detail: expect.stringContaining(a!.generationId) });
    expect(f.manifestStore.read(a!.generationId).phase).toBe("activating");
    expect(records(f).selection).toBeNull();
    expectActivated(f, await f.run(), "pre-selection");
    const g = await fixture();
    const [c] = g.members;
    expect(await g.run({ crashPoint: (p) => { if (p.startsWith("after-census-renew:")) return; }, readDestinationCensus: async (session, census) => { g.guard.rows.delete(c!.remoteProjectId); return g.deps.readDestinationCensus(session, census); } }))
      .toMatchObject({ status: "refused", step: "S8", reason: "lease-conflict", effectBegun: false });
    for (const member of g.members) expect(g.manifestStore.read(member.generationId).phase).toBe("verified");
  });
});

describe("activateCutoverSet: post-publication semantics (C4)", () => {
  it("an unhealthy target after the publication returns post-publication-unhealthy before any member report, and the retry settles", async () => {
    const f = await fixture();
    f.deps.health.push({ status: "healthy", readiness: undefined as never }, { status: "unhealthy", reason: "schema-mismatch", detail: "after publication" } as never);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "post-publication-unhealthy", publicationId: f.setId, health: { status: "unhealthy" }, restart: { status: "satisfied" } });
    expectAllNew(f);
    for (const member of f.members) {
      expect(f.manifestStore.read(member.generationId).phase).toBe("activating");
      expect(() => readdirSync(migrationActivationReportDirectory(f.homeDir, member.generationId))).toThrow();
    }
    expectActivated(f, await f.run(), "publication-journal");
  });

  it("a post-publication map witness mismatch interrupts with the completed publication and selection kept", async () => {
    const f = await fixture();
    const [a, b] = f.members as [Fixture["members"][number], Fixture["members"][number]];
    const witness = f.deps.computeProjectMapWitness;
    const outcome = await f.run({ computeProjectMapWitness: (request) => request.mode === "post-publication" && request.localProjectId === b.localProjectId ? HASH_A : witness(request) });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S16", cause: "project-map-drift", applied: "yes", effectBegun: true, detail: expect.stringContaining(b.generationId) });
    expectAllNew(f);
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("completed");
    expect(f.manifestStore.read(a.generationId).phase).toBe("active");
    expect(f.manifestStore.read(b.generationId).phase).toBe("activating");
    expect(await f.run({ computeProjectMapWitness: (request) => request.mode === "post-publication" ? (() => { throw new MigrationProjectMapWitnessError("project-map-drift", "injected drift", { drift: "entry-absent" }); })() : witness(request) }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "project-map-drift" });
    expect(await f.run({ computeProjectMapWitness: (request) => request.mode === "post-publication" ? (() => { throw new MigrationProjectMapWitnessError("project-map-unresolvable", "injected"); })() : witness(request) }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "state-unresolvable" });
    expectActivated(f, await f.run(), "publication-journal");
  });

  it("a report conflict or an uncertain completion write keeps the new selection and reports it", async () => {
    const f = await fixture();
    const [a] = f.members;
    const persist = f.deps.persistReport;
    const { MigrationActivationReportError } = await import("../../src/migration/activation-report.js");
    expect(await f.run({ persistReport: (input) => { if (input.generationId === a!.generationId) throw new MigrationActivationReportError("identity-conflict", "injected"); return persist(input); } }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "report-conflict", applied: "yes" });
    expect(await f.run({ persistReport: (input) => { if (input.generationId === a!.generationId) throw new MigrationActivationReportError("unsafe-storage", "injected"); return persist(input); } }))
      .toMatchObject({ status: "interrupted", step: "S16", cause: "report-unresolvable" });
    expectAllNew(f);
    expectActivated(f, await f.run(), "publication-journal");
  });

  it("a confirmed aborted publication is publication-failed and every member replay stays unresolved despite its indexes", async () => {
    const f = await fixture();
    const drive = f.deps.drive;
    const outcome = await f.run({ drive: async (guard, coordinator, input) => {
      const real = await drive(guard, coordinator, input);
      return { ...real, status: "aborted", journal: { ...real.journal!, phase: "aborted" } } as never;
    } });
    expect(outcome).toMatchObject({ status: "publication-failed", publicationId: f.setId, publication: { status: "aborted" } });
  });

  it("a pre-seal crash, then the controlled abort shape: own aborted v2 refuses every member replay and the retry re-prepares safely", async () => {
    const f = await fixture();
    const crashing = f.coordinator((event) => { if (event === "before-material-seal") throw new Error("crash before seal"); });
    await expect(f.run({ createCoordinator: () => crashing })).rejects.toThrow("crash before seal");
    expect(readBackendPublicationJournal(f.homeDir)).toMatchObject({ phase: "preparing", recoveryReference: null });
    await withBackendPublicationAppendBarrierAsync(f.homeDir, async (token) => { await f.coordinator().abort(token); });
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("aborted");
    expectAllOld(f);
    const selection = records(f).selection!;
    for (const row of selection.members) {
      expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
        .toThrow(expect.objectContaining({ reason: "unresolved-publication", message: expect.stringContaining("aborted") }));
    }
    expectActivated(f, await f.run(), "publication-journal");
    // The first prepare ran inside the crashing coordinator; the retry re-prepared the aborted pre-seal shape once.
    expect(f.deps.prepareCalls).toBe(1);
  });
});

describe("set replay admission (C2) and foreign slots", () => {
  it("after a later publication archived the completed set journal, members replay from their active manifests and reports", async () => {
    const f = await fixture();
    expectActivated(f, await f.run(), "fresh");
    const selection = records(f).selection!;
    // A later single-generation hold archives the terminal journal; the slot now belongs to another publication.
    await f.coordinator().enterMaintenance({
      publicationId: "migration-generation-9", generationId: "generation-9", sourceSelectionSha256: HASH_A, queueEvidenceSha256: HASH_A,
      roster: [{ machineId: f.manifest.machineId, queueCutoff: null, evidenceSha256: HASH_A }], sourceBackend: "postgresql",
    });
    for (const row of selection.members) {
      expect(assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
        .toEqual({ backend: "postgresql", disposition: "selected" });
    }
    // Activation under the foreign hold: all members are settled, so it reports activated without touching the slot.
    expect(await f.run()).toMatchObject({ status: "activated", resumedFrom: "settled-active" });
    expect(f.deps.prepareCalls).toBe(1);
    // A report that does not name this set refuses: remove A's report directory.
    rmSync(migrationActivationReportDirectory(f.homeDir, selection.members[0]!.generationId), { recursive: true });
    expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: selection.members[0]!.generationId, evidenceSha256: selection.members[0]!.witnessChecksumSha256 }))
      .toThrow(expect.objectContaining({ reason: "unresolved-publication", message: expect.stringContaining("activation report") }));
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S16", cause: "report-conflict" });
  });

  it("a bare selection index without the aggregate, a mismatched index and a missing selection record refuse", async () => {
    const f = await fixture();
    expectActivated(f, await f.run(), "fresh");
    const selection = records(f).selection!;
    const [a] = selection.members;
    const directory = migrationCutoverSetActivationDirectory(f.homeDir, f.setId);
    rmSync(directory + "/selection.json");
    expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: a!.generationId, evidenceSha256: a!.witnessChecksumSha256 }))
      .toThrow(expect.objectContaining({ reason: "unresolved-publication", message: expect.stringContaining("no frozen selection") }));
    expect(await f.run()).toMatchObject({ status: "interrupted", cause: "state-unresolvable" });
    rmSync(directory, { recursive: true });
    expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: a!.generationId, evidenceSha256: a!.witnessChecksumSha256 }))
      .toThrow(expect.objectContaining({ reason: "unresolved-publication", message: expect.stringContaining("no set activation checkpoint") }));
    // The set's own completed publication occupies the slot: without its frozen tuple the activation cannot adopt anything.
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable", detail: expect.stringContaining("no frozen selection") });
    // A selection binding that disagrees with the frozen row refuses as well.
    const g = await fixture();
    expectActivated(g, await g.run(), "fresh");
    const row = records(g).selection!.members[0]!;
    const path = migrationSelectionBindingPath(g.homeDir, row.generationId, "activation");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const stored = readFileSync(path, "utf8");
    writeFileSync(path, stored.replace(row.attemptId, "f".repeat(64)), { mode: 0o600 });
    expect(() => assertMigrationReplayAdmission({ homeDir: g.homeDir, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 })).toThrow();
  });

  it("a set hold refuses the single-generation activation of a member and the member's old evidence never admits replay", async () => {
    const f = await fixture();
    const { runMigrationActivation } = await import("../../src/migration/activate-generation.js");
    const [a] = f.members;
    const outcome = await runMigrationActivation({
      homeDir: f.homeDir, generationId: a!.generationId, transferSettings: f.deps.health as never, ordinarySettings: f.deps.health as never,
      expectedIdentity: { id: a!.remoteProjectId, remoteProjectId: a!.remoteProjectId, localProjectId: a!.localProjectId, machineId: f.manifest.machineId, canonical: a!.canonical } as never,
      expectedOwner: "lcm_migrator",
    }, { ...f.deps, createTransferRuntime: f.deps.createTransferRuntime });
    expect(outcome).toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held" });
    expectAllOld(f);
    for (const member of f.members) expect(f.manifestStore.read(member.generationId).phase).toBe("verified");
  });

  it("a foreign slot with mixed members interrupts and never republishes; an own v2 without the frozen tuple interrupts", async () => {
    const f = await fixture();
    const [a] = f.members;
    await expect(f.run({ crashPoint: (p) => { if (p === "after-complete:" + a!.generationId) throw new Error("boom"); } })).rejects.toThrow("boom");
    // Replace the slot with a foreign hold while B is still pending.
    await f.coordinator().enterMaintenance({
      publicationId: "migration-generation-9", generationId: "generation-9", sourceSelectionSha256: HASH_A, queueEvidenceSha256: HASH_A,
      roster: [{ machineId: f.manifest.machineId, queueCutoff: null, evidenceSha256: HASH_A }], sourceBackend: "postgresql",
    });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "state-unresolvable", detail: expect.stringContaining("mixed") });
    expect(f.deps.prepareCalls).toBe(1);
    const g = await fixture();
    await expect(g.run({ crashPoint: (p) => { if (p === "after-drive") throw new Error("boom"); } })).rejects.toThrow("boom");
    rmSync(migrationCutoverSetActivationDirectory(g.homeDir, g.setId) + "/selection.json");
    expect(await g.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable", detail: expect.stringContaining("no frozen selection") });
  });

  it("set abort refuses once member effects are pending, and a fresh refusal after a checkpoint keeps the hold abortable", async () => {
    const f = await fixture();
    const [a] = f.members;
    await expect(f.run({ crashPoint: (p) => { if (p === "after-publish-begin:" + a!.generationId) throw new Error("boom"); } })).rejects.toThrow("boom");
    expect(await performMigrationAbortCommand({ homeDir: f.homeDir, confirmGenerationId: f.setId })).toMatchObject({ status: "refuse" });
    expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("maintenance-held");
    // A later census drift on the roll-forward is an interruption, not a refusal, and keeps A's evidence and lease.
    const { domainCensus } = await import("./cutover-set-activate-fixture.js");
    f.deps.destinationCensus.set(f.members[1]!.remoteProjectId, domainCensus("changed"));
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S9", effectBegun: true, detail: expect.stringContaining("census-drift") });
    expect(f.guard.rows.get(a!.remoteProjectId)?.releasedAt).toBeNull();
    f.deps.destinationCensus.set(f.members[1]!.remoteProjectId, domainCensus("census-" + f.members[1]!.localProjectId.slice(0, 4)));
    expectActivated(f, await f.run(), "pre-selection");
  });
});

