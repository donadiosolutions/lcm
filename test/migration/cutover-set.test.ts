import { describe, expect, it } from "vitest";
import {
  CutoverSetCaptureError,
  buildCutoverSetManifest,
  cutoverSetMaintenanceEntry,
  cutoverSetManifestSha256,
  decideCutoverSetSelection,
  parseCutoverSetManifest,
  type CutoverSetMemberAuthorityResolution,
  type CutoverSetMemberEvidence,
} from "../../src/migration/cutover-set.js";
import { backendCutoverSetJournalCapacity } from "../../src/storage/backend-publication.js";
import {
  SET_ID,
  SET_MACHINE_ID,
  authenticated,
  fakeAuthority,
  generationIds,
  projectHash,
  setManifest,
} from "../fixtures/cutover-set.js";

function resolved(...outcomes: CutoverSetMemberAuthorityResolution extends infer R
  ? R extends { outcomes: infer O } ? O extends readonly (infer T)[] ? T[] : never : never : never) {
  return { status: "resolved", outcomes } as const;
}

function build(overrides: Partial<Parameters<typeof buildCutoverSetManifest>[0]> = {}) {
  return buildCutoverSetManifest({
    setId: SET_ID,
    machineId: SET_MACHINE_ID,
    resolution: resolved(authenticated(2), authenticated(1), authenticated(3)),
    generationIds: generationIds(3),
    ...overrides,
  });
}

describe("buildCutoverSetManifest", () => {
  const swapped = (projectIndex: number, authorityIndex: number) => ({
    physicalProjectId: projectHash(projectIndex),
    status: "authenticated" as const,
    authority: fakeAuthority(authorityIndex),
  });

  it("names every stored-data project sorted by project, with a stable digest", () => {
    const result = build();
    expect(result.status).toBe("built");
    if (result.status !== "built") return;
    expect(result.manifest).toEqual(setManifest(3));
    expect(result.manifestSha256).toBe(cutoverSetManifestSha256(result.manifest));
    const again = build({ resolution: resolved(authenticated(3), authenticated(1), authenticated(2)) });
    expect(again).toEqual(result);
    expect(parseCutoverSetManifest(JSON.parse(JSON.stringify(result.manifest)))).toEqual(result.manifest);
  });

  it("derives the set-entry input with unbound sentinel member bindings", () => {
    const result = build();
    if (result.status !== "built") throw new Error("expected built");
    const { entry } = result;
    expect(entry).toEqual(cutoverSetMaintenanceEntry(result.manifest));
    expect(entry.publicationId).toBe(SET_ID);
    expect(entry.generationId).toBe(SET_ID);
    expect(entry.sourceSelectionSha256).toBe(result.manifestSha256);
    expect(entry.roster).toHaveLength(1);
    expect(entry.roster[0]).toMatchObject({ machineId: SET_MACHINE_ID, queueCutoff: null });
    expect(entry.cutoverSet.bindings.map((binding) => binding.generationId))
      .toEqual(result.manifest.members.map((member) => member.generationId));
    for (const binding of entry.cutoverSet.bindings) {
      expect(binding.roster).toEqual([{
        machineId: SET_MACHINE_ID, queueCutoff: null, evidenceSha256: binding.queueEvidenceSha256,
      }]);
    }
  });

  it("refuses an unresolvable enumeration with its own reason", () => {
    expect(build({ resolution: { status: "unresolvable", reason: "projects-directory-unresolvable", detail: "EACCES" } }))
      .toMatchObject({ status: "refused", reason: "cutover-set-enumeration-unresolvable", projects: [] });
  });

  it.each([0, 1])("does not treat %i stored-data project(s) as a set", (count) => {
    const outcomes = Array.from({ length: count }, (_, index) => authenticated(index + 1));
    expect(build({ resolution: resolved(...outcomes), generationIds: generationIds(count) }))
      .toMatchObject({ status: "refused", reason: "cutover-set-single-project", projects: outcomes.map((o) => o.physicalProjectId) });
  });

  it("refuses the whole set listing every uncovered or unverifiable project", () => {
    const uncovered = build({
      resolution: resolved(
        authenticated(1),
        { physicalProjectId: projectHash(3), status: "uncovered", detail: "no map entry" },
        { physicalProjectId: projectHash(2), status: "uncovered", detail: "other project" },
      ),
    });
    expect(uncovered).toMatchObject({
      status: "refused",
      reason: "cutover-set-uncovered-member",
      projects: [projectHash(2), projectHash(3)],
    });
    expect(uncovered.status === "refused" && uncovered.detail).toContain("no map entry");
    expect(build({
      resolution: resolved(
        authenticated(1),
        { physicalProjectId: projectHash(2), status: "unverifiable", detail: "meta.json unreadable" },
        authenticated(3),
      ),
    })).toMatchObject({ reason: "cutover-set-member-unverifiable", projects: [projectHash(2)] });
  });

  it("refuses an authenticated outcome whose authority names another project", () => {
    const result = build({ resolution: resolved(authenticated(1), swapped(2, 3), authenticated(3)) });
    expect(result).toMatchObject({
      status: "refused", reason: "cutover-set-uncovered-member", projects: [projectHash(2)],
    });
    expect(result.status === "refused" && result.detail).toContain(projectHash(3));
  });

  it("lists every mismatched authority and uncovered project sorted", () => {
    expect(build({
      resolution: resolved(
        swapped(3, 1),
        { physicalProjectId: projectHash(2), status: "uncovered", detail: "no map entry" },
        swapped(1, 3),
      ),
    })).toMatchObject({
      status: "refused", reason: "cutover-set-uncovered-member",
      projects: [projectHash(1), projectHash(2), projectHash(3)],
    });
  });

  it("refuses a stored-data project without a member generation", () => {
    const ids = generationIds(3);
    ids.delete(projectHash(2));
    expect(build({ generationIds: ids })).toMatchObject({ reason: "cutover-set-incomplete", projects: [projectHash(2)] });
  });

  it("refuses a member for a project without stored data", () => {
    const ids = generationIds(3);
    ids.set(projectHash(9), "member-generation-9");
    expect(build({ generationIds: ids })).toMatchObject({ reason: "cutover-set-unknown-member", projects: [projectHash(9)] });
  });

  it("refuses a shared project identity and a foreign machine", () => {
    expect(build({
      resolution: resolved(
        authenticated(1),
        authenticated(2, { projectIdentity: { scope: "shared", projectId: "remote" } }),
        authenticated(3),
      ),
    })).toMatchObject({ reason: "cutover-set-member-not-local", projects: [projectHash(2)] });
    expect(build({
      resolution: resolved(
        authenticated(1),
        authenticated(2),
        authenticated(3, { machineIdentity: { identityKey: "key", machineId: "018f0b5d-9999-7abc-8def-1234567890ab" } }),
      ),
    })).toMatchObject({ reason: "cutover-set-machine-mismatch", projects: [projectHash(3)] });
  });

  it("refuses shared generation ids and a member reusing the set id", () => {
    const shared = generationIds(3);
    shared.set(projectHash(3), "member-generation-1");
    expect(build({ generationIds: shared }))
      .toMatchObject({ reason: "cutover-set-duplicate-generation", projects: [projectHash(1), projectHash(3)] });
    const reused = generationIds(3);
    reused.set(projectHash(2), SET_ID);
    expect(build({ generationIds: reused }))
      .toMatchObject({ reason: "cutover-set-duplicate-generation", projects: [projectHash(2)] });
  });

  it("throws on a malformed set identifier", () => {
    expect(() => build({ setId: "not a valid id" })).toThrow(/manifest is malformed/);
  });

  it("refuses a set whose journal could not stay readable", () => {
    const count = 3000;
    const outcomes = Array.from({ length: count }, (_, index) => authenticated(index + 1));
    const result = build({ resolution: resolved(...outcomes), generationIds: generationIds(count) });
    expect(result).toMatchObject({ status: "refused", reason: "cutover-set-too-large" });
    const small = build();
    if (small.status !== "built") throw new Error("expected built");
    const capacity = backendCutoverSetJournalCapacity(small.entry.cutoverSet);
    expect(capacity.worstCaseBytes).toBeLessThan(capacity.limitBytes);
  });
});

describe("decideCutoverSetSelection", () => {
  const manifest = setManifest(3);
  const current = (index: number, state: CutoverSetMemberEvidence["state"] = "current"): CutoverSetMemberEvidence => ({
    physicalProjectId: projectHash(index),
    generationId: `member-generation-${index}`,
    state,
  });

  it("is eligible only for exactly the manifest members, all current", () => {
    expect(decideCutoverSetSelection(manifest, [current(3), current(1), current(2)])).toEqual({ status: "eligible" });
  });

  it.each(["stale", "drifted", "unverifiable"] as const)("refuses a %s member and lists it", (state) => {
    const decision = decideCutoverSetSelection(manifest, [current(1), current(2, state), current(3)]);
    expect(decision).toEqual({
      status: "refused",
      reason: `cutover-set-member-evidence-${state}`,
      failures: [{
        physicalProjectId: projectHash(2),
        generationId: "member-generation-2",
        reason: `cutover-set-member-evidence-${state}`,
      }],
    });
  });

  it("lists every failing member in manifest order, then non-members, without inferring evidence", () => {
    const decision = decideCutoverSetSelection(manifest, [
      current(3, "drifted"),
      current(9),
      current(1),
      current(1),
      { physicalProjectId: projectHash(8), generationId: "x", state: "current" },
      { ...current(2), generationId: "someone-elses-generation" },
    ]);
    expect(decision).toEqual({
      status: "refused",
      reason: "cutover-set-evidence-duplicate-member",
      failures: [
        { physicalProjectId: projectHash(1), generationId: "member-generation-1", reason: "cutover-set-evidence-duplicate-member" },
        { physicalProjectId: projectHash(2), generationId: "member-generation-2", reason: "cutover-set-evidence-identity-mismatch" },
        { physicalProjectId: projectHash(3), generationId: "member-generation-3", reason: "cutover-set-member-evidence-drifted" },
        { physicalProjectId: projectHash(8), generationId: null, reason: "cutover-set-evidence-extra-member" },
        { physicalProjectId: projectHash(9), generationId: null, reason: "cutover-set-evidence-extra-member" },
      ],
    });
  });

  it("treats a missing row as absent, never as the other members' state", () => {
    expect(decideCutoverSetSelection(manifest, [current(1), current(3)])).toMatchObject({
      reason: "cutover-set-member-evidence-absent",
      failures: [{ physicalProjectId: projectHash(2), generationId: "member-generation-2" }],
    });
    expect(decideCutoverSetSelection(manifest, [])).toMatchObject({
      failures: [{}, {}, {}],
    });
  });

  it("treats an unknown runtime state as unverifiable", () => {
    expect(decideCutoverSetSelection(manifest, [
      current(1), current(2), current(3, "bogus" as unknown as "stale"),
    ])).toMatchObject({ reason: "cutover-set-member-evidence-unverifiable" });
  });
});

describe("CutoverSetCaptureError", () => {
  it("carries a closed reason and the named projects", () => {
    const error = new CutoverSetCaptureError("cutover-set-membership-drift", "detail", [projectHash(1)]);
    expect(error).toMatchObject({
      name: "CutoverSetCaptureError",
      reason: "cutover-set-membership-drift",
      projects: [projectHash(1)],
      message: "cutover-set-membership-drift: detail",
    });
    expect(new CutoverSetCaptureError("cutover-set-member-unbound", "d").projects).toEqual([]);
  });
});
