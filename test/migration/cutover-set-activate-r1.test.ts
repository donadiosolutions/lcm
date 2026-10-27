import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import {
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationAppendBarrierAsync,
} from "../../src/storage/backend-publication.js";
import { readCutoverSetActivationRecords } from "../../src/migration/cutover-set-activation-store.js";
import { activationGenerationLinkPath } from "../../src/migration/activation-artifact-store.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import type { ActivationPublicationStatus } from "../../src/migration/activation-publication.js";
import { cleanupRoots, expectActivated, expectAllNew, expectAllOld, fixture, type Fixture } from "./cutover-set-activate-fixture.js";

afterEach(cleanupRoots);

function records(f: Fixture) {
  const read = readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId });
  if (read.state !== "resolved") throw new Error("records not resolved: " + JSON.stringify(read));
  return read;
}

async function crashAt(f: Fixture, point: string): Promise<void> {
  await expect(f.run({ crashPoint: (p) => { if (p === point) throw new Error("crash at " + point); } })).rejects.toThrow("crash at " + point);
}

/** Replace every member's row with an active row of this set carrying the member's copy binding (the coordinator released the real ones). */
function seedActiveSetRows(f: Fixture): void {
  for (const member of f.members) {
    f.guard.rows.delete(member.remoteProjectId);
    f.guard.seed({ projectId: member.remoteProjectId, publicationId: f.setId, evidenceSha256: member.copyBindingSha256 });
  }
}

describe("round 1 F1: empty-slot routing authenticates report absence", () => {
  it("a member whose report is written is never all-pending: the empty slot interrupts without a drive or a prepare, even with matching active fences", async () => {
    const f = await fixture();
    const [a] = f.members;
    await crashAt(f, "after-report:" + a!.generationId);
    rmSync(backendPublicationJournalPath(f.homeDir));
    expect(readBackendMaintenanceJournal(f.homeDir)).toBeNull();
    expect(readBackendPublicationJournal(f.homeDir)).toBeNull();
    seedActiveSetRows(f);
    const drive = vi.fn(f.deps.drive);
    const prepares = f.deps.prepareCalls;
    const outcome = await f.run({ drive });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S13b", cause: "state-unresolvable", detail: expect.stringContaining("mixed") });
    expect(drive).not.toHaveBeenCalled();
    expect(f.deps.prepareCalls).toBe(prepares);
    // The selection and A's report survive for the operator; nothing was republished.
    expect(records(f).selection).not.toBeNull();
    expect(f.manifestStore.read(a!.generationId).phase).toBe("activating");
  });

  it("a report directory that cannot be authenticated is not positively absent: the empty slot interrupts instead of preparing fresh", async () => {
    const f = await fixture();
    await crashAt(f, "after-selection-completed");
    rmSync(backendPublicationJournalPath(f.homeDir));
    const drive = vi.fn(f.deps.drive);
    const outcome = await f.run({
      drive,
      probeReportPresence: (input) => ({ state: "unresolvable", reason: "directory-unauthenticated", detail: "injected for " + input.generationId }),
    });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S13b", cause: "state-unresolvable", detail: expect.stringContaining("mixed") });
    expect(drive).not.toHaveBeenCalled();
    expectAllOld(f);
    // Once the store answers, the legitimate pre-report recovery row still prepares the frozen artifact fresh.
    expectActivated(f, await f.run(), "slot-replaced");
  });
});

describe("round 1 F2: a set member's binding is only an index", () => {
  it("own aborted v2 with one member's link deleted: that member and its siblings refuse replay", async () => {
    const f = await fixture();
    const crashing = f.coordinator((event) => { if (event === "before-material-seal") throw new Error("crash before seal"); });
    await expect(f.run({ createCoordinator: () => crashing })).rejects.toThrow("crash before seal");
    await withBackendPublicationAppendBarrierAsync(f.homeDir, async (token) => { await f.coordinator().abort(token); });
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("aborted");
    const selection = records(f).selection!;
    const [unlinked, ...siblings] = selection.members;
    rmSync(activationGenerationLinkPath(f.homeDir, unlinked!.generationId));
    for (const row of [unlinked!, ...siblings]) {
      expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
        .toThrow(expect.objectContaining({ reason: "unresolved-publication" }));
    }
  });

  it("a completed set whose slot was archived by a later publication: a deleted link refuses that member", async () => {
    const f = await fixture();
    expectActivated(f, await f.run(), "fresh");
    const selection = records(f).selection!;
    const [a, b] = selection.members;
    rmSync(activationGenerationLinkPath(f.homeDir, a!.generationId));
    expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: a!.generationId, evidenceSha256: a!.witnessChecksumSha256 }))
      .toThrow(expect.objectContaining({ reason: "unresolved-publication", message: expect.stringContaining("link") }));
    expect(assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: b!.generationId, evidenceSha256: b!.witnessChecksumSha256 }))
      .toEqual({ backend: "postgresql", disposition: "selected" });
    // The slot now belongs to a later hold: the deleted link still refuses while the linked sibling replays from its active manifest.
    rmSync(backendPublicationJournalPath(f.homeDir));
    expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: a!.generationId, evidenceSha256: a!.witnessChecksumSha256 }))
      .toThrow(expect.objectContaining({ reason: "unresolved-publication", message: expect.stringContaining("link") }));
    expect(assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: b!.generationId, evidenceSha256: b!.witnessChecksumSha256 }))
      .toEqual({ backend: "postgresql", disposition: "selected" });
  });
});

describe("round 1 F3: publication-failed is reserved for a confirmed abort", () => {
  it.each<[ActivationPublicationStatus, string]>([
    ["fence-unsatisfied", "lease-lost"],
    ["publication-collision", "journal-unexpected"],
  ])("a %s driver result interrupts at S13b as %s, keeps the selection and completes no member; the retry succeeds", async (status, cause) => {
    const f = await fixture();
    let inject = true;
    const drive = f.deps.drive;
    const outcome = await f.run({ drive: async (guard, coordinator, input) => {
      if (!inject) return drive(guard, coordinator, input);
      inject = false;
      return { status, detail: "injected " + status, journal: null, fenceChecks: [], dispatch: null };
    } });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S13b", cause, detail: expect.stringContaining("injected " + status) });
    expect(records(f).selection).not.toBeNull();
    for (const member of f.members) expect(f.manifestStore.read(member.generationId).phase).toBe("activating");
    expectAllOld(f);
    expectActivated(f, await f.run(), "selection-completed");
  });

  it.each<[ActivationPublicationStatus, string]>([
    ["fence-unresolvable", "lease-unresolvable"],
    ["artifact-missing", "artifact-unresolvable"],
    ["artifact-unresolvable", "artifact-unresolvable"],
    ["artifact-identity-mismatch", "artifact-identity-mismatch"],
    ["duplicate-publication-input", "journal-unexpected"],
    ["publication-unresolvable", "state-unresolvable"],
    ["maintenance-in-flight", "journal-unexpected"],
  ])("a %s driver result interrupts at S13b as %s", async (status, cause) => {
    const f = await fixture();
    const outcome = await f.run({ drive: async () => ({ status, detail: "injected", journal: null, fenceChecks: [], dispatch: null }) });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S13b", cause, effectBegun: true, detail: expect.stringContaining(status) });
    expect(records(f).selection).not.toBeNull();
  });
});

describe("round 1 F4: successor tokens are attributed per member", () => {
  it("two rows taken over after the freeze report their distinct tokens on their own members; a settled retry reports none", async () => {
    const f = await fixture();
    await crashAt(f, "after-selection-frozen");
    for (const member of f.members) f.guard.expire(member.remoteProjectId);
    const outcome = await f.run();
    expectActivated(f, outcome, "selection-frozen");
    if (outcome.status !== "activated") return;
    const tokens = outcome.members.map((member) => member.successorFencingToken);
    expect(tokens.every((token) => typeof token === "string")).toBe(true);
    expect(new Set(tokens).size).toBe(f.members.length);
    for (const [index, member] of f.members.entries()) {
      expect(outcome.members[index]).toMatchObject({ generationId: member.generationId, successorFencingToken: f.guard.rows.get(member.remoteProjectId)!.fencingToken.toString(10) });
    }
    const settled = await f.run();
    expect(settled).toMatchObject({ status: "activated", resumedFrom: "settled-active" });
    if (settled.status === "activated") expect(settled.members.every((member) => member.successorFencingToken === null)).toBe(true);
    expectAllNew(f);
  });

  it("a takeover during the lease continuation after the selection is attributed to that member only", async () => {
    const f = await fixture();
    const [a, b] = f.members;
    await crashAt(f, "after-selection-completed");
    f.guard.expireNextFor = a!.remoteProjectId;
    const outcome = await f.run();
    expectActivated(f, outcome, "selection-completed");
    if (outcome.status !== "activated") return;
    expect(outcome.members[0]).toMatchObject({ generationId: a!.generationId, successorFencingToken: f.guard.rows.get(a!.remoteProjectId)!.fencingToken.toString(10) });
    expect(outcome.members[1]).toMatchObject({ generationId: b!.generationId, successorFencingToken: null });
  });
});

describe("round 1 F7: the lease span names every failing member", () => {
  it("two members that conflict at acquire are both reported, no effect begins, and the lease acquired in between is released", async () => {
    const f = await fixture({ members: 3 });
    const [a, b, c] = f.members;
    f.guard.seed({ projectId: a!.remoteProjectId, publicationId: "stranger-a" });
    f.guard.seed({ projectId: c!.remoteProjectId, publicationId: "stranger-c" });
    const outcome = await f.run();
    expect(outcome).toMatchObject({
      status: "refused", step: "S2", reason: "cutover-set-member-evidence-unverifiable", effectBegun: false,
      members: [
        expect.objectContaining({ generationId: a!.generationId, reason: "lease-conflict" }),
        expect.objectContaining({ generationId: b!.generationId, reason: null }),
        expect.objectContaining({ generationId: c!.generationId, reason: "lease-conflict" }),
      ],
    });
    if (outcome.status === "refused") expect(outcome.failures.map((failure) => failure.generationId).sort()).toEqual([a!.generationId, c!.generationId].sort());
    expect(f.guard.rows.get(b!.remoteProjectId)).toMatchObject({ publicationId: f.setId, releasedAt: expect.any(String) });
    expect(f.guard.rows.get(a!.remoteProjectId)).toMatchObject({ publicationId: "stranger-a", releasedAt: null });
    expect(f.guard.rows.get(c!.remoteProjectId)).toMatchObject({ publicationId: "stranger-c", releasedAt: null });
    for (const member of f.members) expect(f.manifestStore.read(member.generationId).phase).toBe("verified");
    expect(readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId })).toEqual({ state: "authoritatively-absent" });
  });
});
