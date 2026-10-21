import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  readBackendMaintenanceJournal,
  type BackendMaintenanceJournal,
} from "../../src/storage/backend-publication.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import {
  prepareCutoverSet,
  resolveCutoverSetCandidate,
  CutoverSetPrepareError,
  type CutoverSetPrepareOperations,
} from "../../src/migration/cutover-set-prepare.js";
import { CutoverSetCaptureError, type CutoverSetMemberAuthorityResolution } from "../../src/migration/cutover-set.js";
import { MigrationIdentityError } from "../../src/migration/generation-identity.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { MigrationProtocolError } from "../../src/migration/protocol.js";
import { performMigrationAbortCommand } from "../../src/migration/cli-abort.js";
import { MigrationVerificationStoreError } from "../../src/migration/verification-store.js";
import { MigrationVerificationDriverError } from "../../src/migration/verify-generation.js";
import { MachineIdentityFileError } from "../../src/machine-identity.js";
import { SET_HOME_MACHINE, setHomeCoordinator } from "../fixtures/cutover-set-home.js";
import { createFixtureManifest } from "./existing-fixtures.js";
import {
  blockedAtFirstGenesis, candidateSetId, fakeOps, heldJournal, makeEnv, memberIds, prepareInput, targetConfig, type Env, type FakeOps,
} from "../fixtures/cutover-set-prepare.js";

const HASH = "a".repeat(64);

async function fresh(ops: FakeOps, overrides: Parameters<typeof prepareInput>[3] = {}, count = 2) {
  const env = await makeEnv(count);
  const setId = await candidateSetId(env);
  const result = await prepareCutoverSet(prepareInput(env, setId, overrides, ops));
  return { env, setId, result };
}

describe("journal resolution refusals", () => {
  it("refuses a publication in the slot and an unreadable journal, for the preparation and the preview", async () => {
    const env = await makeEnv();
    for (const [observation, expected] of [
      [{ kind: "publication", publicationId: "p", phase: "prepared" }, { reason: "publication-occupies-slot" }],
      [{ kind: "unresolvable", evidence: "journal-malformed-journal" }, { reason: "journal-unresolvable", evidence: "journal-malformed-journal" }],
    ] as const) {
      const ops = { observeJournal: () => observation as never };
      expect(await prepareCutoverSet(prepareInput(env, "any", {}, ops))).toEqual({ status: "refuse", ...expected, setId: null, identityMutation: [] });
      expect(await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig(), _operationsForTesting: ops }))
        .toEqual({ status: "refuse", ...expected });
    }
  }, 60000);

  it("refuses to prepare beside a single-generation hold", async () => {
    const env = await makeEnv();
    await setHomeCoordinator(env.homeDir).enterMaintenance({
      publicationId: "single-publication", generationId: "single-generation", sourceSelectionSha256: HASH,
      queueEvidenceSha256: HASH, roster: [{ machineId: SET_HOME_MACHINE, queueCutoff: null, evidenceSha256: HASH }],
    });
    const expected = { reason: "cutover-set-single-generation-held", evidence: "single-generation" };
    expect(await prepareCutoverSet(prepareInput(env, "any"))).toEqual({ status: "refuse", ...expected, setId: null, identityMutation: [] });
    expect(await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() })).toEqual({ status: "refuse", ...expected });
  }, 60000);

  it("refuses a live set that is not the confirmed one, and a phase the preparation does not own", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    expect(await prepareCutoverSet(prepareInput(env, "another-set"))).toEqual({
      status: "refuse", reason: "confirmation-generation-moved", setId, identityMutation: [],
    });
    const prepared: BackendMaintenanceJournal = { ...heldJournal(env), phase: "selection-prepared" };
    const ops = { observeJournal: () => ({ kind: "hold", journal: prepared }) as never };
    expect(await prepareCutoverSet(prepareInput(env, setId, {}, ops))).toEqual({
      status: "refuse", reason: "hold-phase-unsupported", evidence: "selection-prepared", setId, identityMutation: [],
    });
    expect(await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig(), _operationsForTesting: ops }))
      .toEqual({ status: "refuse", reason: "hold-phase-unsupported", evidence: "selection-prepared" });
  }, 60000);

  it("previews a live hold with its durable set and members", async () => {
    const env = await makeEnv();
    const { setId, ids } = await blockedAtFirstGenesis(env);
    const members = ids.map((generationId, index) => ({ physicalProjectId: env.projects[index]!.id, generationId }));
    expect(await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() }))
      .toEqual({ status: "candidate", disposition: "continue-held", setId, members });
    const entering: BackendMaintenanceJournal = { ...heldJournal(env), phase: "maintenance-entering" };
    expect(await resolveCutoverSetCandidate({
      homeDir: env.homeDir, targetConfig: targetConfig(), _operationsForTesting: { observeJournal: () => ({ kind: "hold", journal: entering }) as never },
    })).toEqual({ status: "candidate", disposition: "recover-entering", setId, members });
  }, 60000);
});

describe("terminal set holds", () => {
  it("allocates a different set once a member's earlier generation is occupied, and refuses the old confirmation", async () => {
    const env = await makeEnv();
    const { setId, ids } = await blockedAtFirstGenesis(env);
    expect(await performMigrationAbortCommand({ homeDir: env.homeDir, confirmGenerationId: setId })).toMatchObject({ status: "ok" });
    const preview = await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() });
    expect(preview).toMatchObject({ status: "candidate", disposition: "fresh" });
    if (preview.status !== "candidate") return;
    // Member A's captured snapshot occupies its first generation, so its ordinal advanced and the set moved.
    expect(preview.members[0]!.generationId).toBe(ids[0]!.replace(/-0$/u, "-1"));
    expect(preview.members[1]!.generationId).toBe(ids[1]);
    expect(preview.setId).not.toBe(setId);
    expect(await prepareCutoverSet(prepareInput(env, setId))).toEqual({
      status: "refuse", reason: "confirmation-generation-moved", setId: preview.setId, identityMutation: [],
    });
    expect(env.calls).toEqual([]);
    const result = await prepareCutoverSet(prepareInput(env, preview.setId));
    expect(result.status).toBe("prepared");
  }, 90000);

  it("refuses a fresh set while an earlier set's member manifest is unsettled, naming the member", async () => {
    const env = await makeEnv();
    const { setId, ids } = await blockedAtFirstGenesis(env);
    await setHomeCoordinator(env.homeDir).abortMaintenance({
      expectedChecksumSha256: heldJournal(env).checksumSha256, sourceSelectionSha256: heldJournal(env).sourceSelectionSha256, abortEvidenceSha256: HASH,
    });
    createFixtureManifest(env.store, "planned", { generationId: ids[1]! });
    const expected = { reason: "abort-or-resume-required", evidence: ids[1] + ":manifest-ready" };
    expect(await prepareCutoverSet(prepareInput(env, setId))).toEqual({ status: "refuse", ...expected, setId: null, identityMutation: [] });
    expect(await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() })).toEqual({ status: "refuse", ...expected });
    const unreadable = { probeManifestPresence: () => ({ status: "unresolvable", reason: "internal-error" }) } as unknown as MigrationManifestStore;
    expect(await prepareCutoverSet(prepareInput(env, setId, { manifestStore: unreadable }))).toEqual({
      status: "refuse", reason: "abort-gate-unresolvable", evidence: ids[0] + ":manifest-internal-error", setId: null, identityMutation: [],
    });
  }, 60000);
});

describe("fresh preparation refusals", () => {
  it("refuses a home that is not a set, and an uncovered stored-data project, naming the projects", async () => {
    const single = await makeEnv(1);
    const preview = await resolveCutoverSetCandidate({ homeDir: single.homeDir, targetConfig: targetConfig() });
    expect(preview).toEqual({
      status: "refuse", reason: "cutover-set-single-project", evidence: "1 stored-data project(s); use the single-generation path",
      projects: [single.projects[0]!.id],
    });
    expect(await prepareCutoverSet(prepareInput(single, "any"))).toMatchObject({ status: "refuse", reason: "cutover-set-single-project", setId: null });

    const env = await makeEnv();
    const orphan = "f".repeat(64);
    mkdirSync(join(env.homeDir, ".lcm", "projects", orphan), { recursive: true, mode: 0o700 });
    writeFileSync(join(env.homeDir, ".lcm", "projects", orphan, "db.sqlite"), "");
    expect(await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() }))
      .toMatchObject({ status: "refuse", reason: "cutover-set-uncovered-member", projects: [orphan] });
  }, 60000);

  it("refuses an unresolvable enumeration", async () => {
    const env = await makeEnv();
    const ops = { resolveAuthorities: () => ({ status: "unresolvable", reason: "events-directory-unresolvable", detail: "EACCES" }) as CutoverSetMemberAuthorityResolution };
    expect(await prepareCutoverSet(prepareInput(env, "any", {}, ops))).toMatchObject({
      status: "refuse", reason: "cutover-set-enumeration-unresolvable", evidence: "events-directory-unresolvable: EACCES", projects: [], setId: null,
    });
  }, 60000);

  it("converts the identity helpers' typed failures into generation refusals and lets anything else escape", async () => {
    const env = await makeEnv();
    const typed = new MigrationIdentityError("probe-bound-exceeded", "bound", "max-0");
    const refuse = (error: unknown) => ({ resolveGenerationId: async () => { throw error; } });
    expect(await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig(), _operationsForTesting: refuse(typed) }))
      .toEqual({ status: "refuse", reason: "generation-probe-bound-exceeded", evidence: "max-0" });
    expect(await resolveCutoverSetCandidate({
      homeDir: env.homeDir, targetConfig: targetConfig(), _operationsForTesting: refuse(new MigrationIdentityError("occupancy-refused", "x")),
    })).toEqual({ status: "refuse", reason: "generation-occupancy-refused" });
    await expect(resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig(), _operationsForTesting: refuse(new Error("boom")) }))
      .rejects.toThrow("boom");
    for (const [resolution, expected] of [
      [{ status: "refuse", reason: "occupied-since-probe" }, { reason: "generation-occupied-since-probe" }],
      [{ status: "refuse", reason: "unresolvable-since-probe", evidence: "snapshot-tampered" }, { reason: "generation-unresolvable-since-probe", evidence: "snapshot-tampered" }],
    ] as const) {
      expect(await prepareCutoverSet(prepareInput(env, "any", {}, { resolveConfirmedGenerationId: async () => resolution as never })))
        .toEqual({ status: "refuse", ...expected, setId: null, identityMutation: [] });
    }
    expect(env.calls).toEqual([]);
  }, 60000);

  it("refuses an unusable target and an unregistered machine, and lets unclassified failures escape", async () => {
    const env = await makeEnv();
    const withUrl = (url: string) => ({ ...targetConfig(), postgresql: { ...targetConfig().postgresql, url } }) as ReturnType<typeof targetConfig>;
    expect(await prepareCutoverSet(prepareInput(env, "any", { targetConfig: withUrl("not a url") })))
      .toMatchObject({ status: "refuse", reason: "generation-invalid-input", setId: null });
    await expect(prepareCutoverSet(prepareInput(env, "any", { targetConfig: withUrl("postgresql://h/%E0%A4%A") }))).rejects.toThrow(URIError);
    expect(await prepareCutoverSet(prepareInput(env, "any", {}, { requireMachine: () => { throw new MachineIdentityFileError("missing", "register"); } })))
      .toMatchObject({ status: "refuse", reason: "machine-identity-unregistered", setId: null });
    await expect(prepareCutoverSet(prepareInput(env, "any", {}, { requireMachine: () => { throw new Error("disk"); } }))).rejects.toThrow("disk");
  }, 60000);

  it("refuses a moved confirmation before any identity is written", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    expect(await prepareCutoverSet(prepareInput(env, "stale-set"))).toEqual({
      status: "refuse", reason: "confirmation-generation-moved", setId, identityMutation: [],
    });
    expect(env.calls).toEqual([]);
    expect(readBackendMaintenanceJournal(env.homeDir)).toBeNull();
  }, 60000);

  it("attributes identity effects per member when a later identity refuses or does not match", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const real = fakeOps(env).resolveIdentity!;
    let calls = 0;
    const refused = await prepareCutoverSet(prepareInput(env, setId, {}, {
      resolveIdentity: async (input) => {
        calls += 1;
        return calls === 2 ? { status: "refuse", reason: "destination-project-conflict" } : real(input);
      },
    }));
    expect(refused).toEqual({
      status: "refuse", reason: "destination-project-conflict", projects: [env.projects[1]!.id], setId,
      identityMutation: [
        { physicalProjectId: env.projects[0]!.id, effects: [{ stage: "local", outcome: "reused" }, { stage: "destination", outcome: "created" }] },
        { physicalProjectId: env.projects[1]!.id, effects: [] },
      ],
    });
    expect(readBackendMaintenanceJournal(env.homeDir)).toBeNull();
    const mismatched = await prepareCutoverSet(prepareInput(env, setId, {}, {
      resolveIdentity: async (input) => {
        const resolved = await real(input);
        return resolved.status === "resolved" ? { ...resolved, expectedIdentity: { ...resolved.expectedIdentity, localProjectId: "other" } } : resolved;
      },
    }));
    expect(mismatched).toMatchObject({ status: "refuse", reason: "member-identity-mismatch", projects: [env.projects[0]!.id], setId });
  }, 60000);

  it("refuses when the authenticated sources changed under the mints, and when the rebuilt set is refused", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const { resolveCutoverSetMemberAuthorities } = await import("../../src/migration/maintenance.js");
    const withSecond = (second: (real: CutoverSetMemberAuthorityResolution) => CutoverSetMemberAuthorityResolution) => {
      let calls = 0;
      return { resolveAuthorities: ((input: Parameters<typeof resolveCutoverSetMemberAuthorities>[0]) => {
        calls += 1;
        const real = resolveCutoverSetMemberAuthorities(input);
        return calls === 1 ? real : second(real);
      }) as CutoverSetPrepareOperations["resolveAuthorities"] };
    };
    const ids = env.projects.map((project) => project.id);
    const changed = await prepareCutoverSet(prepareInput(env, setId, {}, withSecond((real) => ({
      status: "resolved",
      outcomes: (real as Extract<typeof real, { status: "resolved" }>).outcomes.map((outcome, index) => index === 0 && outcome.status === "authenticated"
        ? { ...outcome, authority: { ...outcome.authority, canonicalPath: "/elsewhere" } } : outcome),
    }))));
    expect(changed).toMatchObject({ status: "refuse", reason: "cutover-set-authority-changed", projects: ids, setId });
    // Both members' identity effects survive the refusal.
    expect(changed.status === "refuse" && changed.identityMutation.length).toBe(2);
    expect(await prepareCutoverSet(prepareInput(env, setId, {}, withSecond(() => ({ status: "unresolvable", reason: "events-directory-unresolvable", detail: "EACCES" })))))
      .toMatchObject({ status: "refuse", reason: "cutover-set-authority-changed" });
    const shared = await prepareCutoverSet(prepareInput(env, setId, {}, withSecond((real) => ({
      status: "resolved",
      outcomes: (real as Extract<typeof real, { status: "resolved" }>).outcomes.map((outcome, index) => index === 0 && outcome.status === "authenticated"
        ? { ...outcome, authority: { ...outcome.authority, projectIdentity: { scope: "shared", projectId: "remote" } } } : outcome),
    }))));
    expect(shared).toMatchObject({ status: "refuse", reason: "cutover-set-member-not-local", projects: [ids[0]], setId });
    expect(readBackendMaintenanceJournal(env.homeDir)).toBeNull();
      }, 90000);

  it("refuses a generation that became occupied or unclassifiable before entry", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    for (const [occupancy, expected] of [
      [{ status: "occupied" }, { reason: "generation-occupied-since-probe" }],
      [{ status: "refuse", evidence: "snapshot-tampered" }, { reason: "generation-unresolvable-since-probe", evidence: "snapshot-tampered" }],
    ] as const) {
      const result = await prepareCutoverSet(prepareInput(env, setId, {}, { classifyOccupancy: async () => occupancy as never }));
      expect(result).toMatchObject({ status: "refuse", ...expected, setId });
    }
    expect(readBackendMaintenanceJournal(env.homeDir)).toBeNull();
  }, 60000);

  it.each([
    ["contention", new PrivateMutationLockContentionError("busy"), { reason: "hold-entry-contention", evidence: "lock-contention" }],
    ["a slot occupant", new BackendPublicationJournalError("unresolved-publication", "occupied"), { reason: "hold-entry-slot-occupied", evidence: "journal-unresolved-publication" }],
  ])("classifies a failed hold entry: %s", async (_name, error, expected) => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const coordinator = { enterMaintenance: async () => { throw error; } } as unknown as BackendPublicationCoordinator;
    expect(await prepareCutoverSet(prepareInput(env, setId, { coordinator }))).toMatchObject({ status: "refuse", ...expected, setId });
  }, 60000);

  it("refuses a hold entry whose readback is not held", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const coordinator = { enterMaintenance: async (entry: object) => ({ ...entry, phase: "maintenance-entering" }) } as unknown as BackendPublicationCoordinator;
    expect(await prepareCutoverSet(prepareInput(env, setId, { coordinator }))).toMatchObject({ status: "refuse", reason: "hold-entry-readback-mismatch", setId });
  }, 60000);

  it("carries identity writes on an unclassified failure, and rethrows one that follows none", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const { resolveCutoverSetMemberAuthorities } = await import("../../src/migration/maintenance.js");
    let calls = 0;
    const error = await prepareCutoverSet(prepareInput(env, setId, {}, {
      resolveAuthorities: (input) => {
        calls += 1;
        if (calls === 2) throw new Error("disk went away");
        return resolveCutoverSetMemberAuthorities(input);
      },
    })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CutoverSetPrepareError);
    const wrapped = error as CutoverSetPrepareError;
    expect((wrapped.cause as Error).message).toBe("disk went away");
    expect(wrapped.identityMutation).toHaveLength(2);
    await expect(prepareCutoverSet(prepareInput(env, setId, {}, { resolveAuthorities: () => { throw new Error("early"); } })))
      .rejects.toThrow("early");
  }, 60000);
});

describe("resume refusals on a live hold", () => {
  it("refuses a different target before any identity is resolved or member touched", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    const result = await prepareCutoverSet(prepareInput(env, setId, { targetConfig: targetConfig("other.example") }));
    expect(result).toEqual({
      status: "refuse", reason: "cutover-set-target-changed", projects: env.projects.map((project) => project.id), setId, identityMutation: [],
    });
    expect(env.calls).toEqual([]);
    // A set id outside the base family of its own members is refused with no member named.
    const crafted: BackendMaintenanceJournal = { ...heldJournal(env), generationId: "crafted-set" };
    const ops = { observeJournal: () => ({ kind: "hold", journal: crafted }) as never };
    expect(await prepareCutoverSet(prepareInput(env, "crafted-set", {}, ops))).toEqual({
      status: "refuse", reason: "cutover-set-target-changed", projects: [], setId: "crafted-set", identityMutation: [],
    });
  }, 60000);

  it("refuses a member whose persisted map entry is missing or unreadable", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    expect(await prepareCutoverSet(prepareInput(env, setId, {}, { readCanonicalPath: () => null })))
      .toEqual({ status: "refuse", reason: "cutover-set-member-unmapped", projects: [env.projects[0]!.id], setId, identityMutation: [] });
    expect(await prepareCutoverSet(prepareInput(env, setId, {}, { readCanonicalPath: () => { throw new TypeError("bad map"); } })))
      .toEqual({ status: "refuse", reason: "project-map-unresolvable", evidence: "TypeError", setId, identityMutation: [] });
  }, 60000);

  it("refuses when a held member's identity is not resolvable or names another project", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    expect(await prepareCutoverSet(prepareInput(env, setId, {}, {
      resolveIdentity: async () => ({ status: "refuse", reason: "destination-project-absent" }),
    }))).toEqual({ status: "refuse", reason: "destination-project-absent", projects: [env.projects[0]!.id], setId, identityMutation: [] });
    const real = fakeOps(env).resolveIdentity!;
    expect(await prepareCutoverSet(prepareInput(env, setId, {}, {
      resolveIdentity: async (input) => {
        const resolved = await real(input);
        return resolved.status === "resolved" ? { ...resolved, expectedIdentity: { ...resolved.expectedIdentity, localProjectId: "other" } } : resolved;
      },
    }))).toMatchObject({ status: "refuse", reason: "member-identity-mismatch", projects: [env.projects[0]!.id], setId });
  }, 60000);

  it("recovers an entering hold with the journal's own fields and the observed checksum, then continues", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    const held = heldJournal(env);
    const entering: BackendMaintenanceJournal = { ...held, phase: "maintenance-entering", checksumSha256: "e".repeat(64) };
    const requests: unknown[] = [];
    const coordinator = { enterMaintenance: async (request: unknown, token?: unknown) => { requests.push([request, token]); return held; } } as unknown as BackendPublicationCoordinator;
    const ops = { observeJournal: () => ({ kind: "hold", journal: entering }) as never };
    const result = await prepareCutoverSet(prepareInput(env, setId, { coordinator }, ops));
    expect(result.status).toBe("prepared");
    expect(requests).toEqual([[{
      publicationId: held.publicationId, generationId: held.generationId, sourceSelectionSha256: held.sourceSelectionSha256,
      queueEvidenceSha256: held.queueEvidenceSha256, roster: held.roster, cutoverSet: held.cutoverSet, sourceBackend: "sqlite",
      expectedChecksumSha256: "e".repeat(64),
    }, undefined]]);
  }, 60000);

  it.each([
    ["a moved checkpoint", new BackendPublicationJournalError("unexpected-state", "moved"), { reason: "entering-recovery-precondition", evidence: "journal-unexpected-state" }],
    ["contention", new PrivateMutationLockContentionError("busy"), { reason: "entering-recovery-contention", evidence: "lock-contention" }],
    ["unattributable evidence", new BackendPublicationJournalError("malformed-journal", "bad"), { reason: "entering-recovery-evidence", evidence: "journal-malformed-journal" }],
  ])("classifies a failed entering recovery: %s", async (_name, error, expected) => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    const entering: BackendMaintenanceJournal = { ...heldJournal(env), phase: "maintenance-entering" };
    const coordinator = { enterMaintenance: async () => { throw error; } } as unknown as BackendPublicationCoordinator;
    const ops = { observeJournal: () => ({ kind: "hold", journal: entering }) as never };
    expect(await prepareCutoverSet(prepareInput(env, setId, { coordinator }, ops))).toEqual({ status: "refuse", ...expected, setId, identityMutation: [] });
  }, 60000);

  it("refuses an entering recovery whose readback is not held", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    const entering: BackendMaintenanceJournal = { ...heldJournal(env), phase: "maintenance-entering" };
    const coordinator = { enterMaintenance: async () => entering } as unknown as BackendPublicationCoordinator;
    const ops = { observeJournal: () => ({ kind: "hold", journal: entering }) as never };
    expect(await prepareCutoverSet(prepareInput(env, setId, { coordinator }, ops)))
      .toEqual({ status: "refuse", reason: "hold-entry-readback-mismatch", setId, identityMutation: [] });
  }, 60000);
});

describe("member blocks", () => {
  it("blocks at a cancelled preparation before touching the next member", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    const result = await prepareCutoverSet(prepareInput(env, setId, { signal: AbortSignal.abort() }));
    expect(result).toMatchObject({ status: "blocked", reason: "cancelled", blockedProject: env.projects[0]!.id });
    expect(env.calls.filter((call) => !call.startsWith("identity"))).toEqual([]);
  }, 60000);

  it.each([
    ["no journal", () => null, "hold-not-held", "absent"],
    ["a terminal journal", (held: BackendMaintenanceJournal) => ({ ...held, phase: "maintenance-aborted" }), "hold-not-held", "maintenance-aborted"],
    ["another set", (held: BackendMaintenanceJournal) => ({ ...held, cutoverSet: { ...held.cutoverSet!, manifest: { ...held.cutoverSet!.manifest, setId: "other-set" } } }), "hold-not-held", "maintenance-held"],
    ["a single-generation hold", (held: BackendMaintenanceJournal) => ({ ...held, cutoverSet: undefined }), "hold-not-held", "maintenance-held"],
    ["a set that lost the member", (held: BackendMaintenanceJournal) => ({ ...held, cutoverSet: { ...held.cutoverSet!, manifest: { ...held.cutoverSet!.manifest, members: [] } } }), "member-unbound", undefined],
  ])("blocks when the journal reads back as %s", async (_name, change, reason, evidence) => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    const held = heldJournal(env);
    const result = await prepareCutoverSet(prepareInput(env, setId, {}, { readJournal: () => change(held) as never }));
    expect(result).toMatchObject({ status: "blocked", reason, ...(evidence === undefined ? {} : { evidence }) });
  }, 60000);

  it("blocks on a member manifest that cannot be established or read, and lets other failures escape", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    const store = (overrides: object) => ({ ...overrides }) as unknown as MigrationManifestStore;
    expect(await prepareCutoverSet(prepareInput(env, setId, {
      manifestStore: store({ probeManifestPresence: () => ({ status: "unresolvable", reason: "internal-error" }) }),
    }))).toMatchObject({ status: "blocked", reason: "manifest-unresolvable", evidence: "manifest-internal-error" });
    expect(await prepareCutoverSet(prepareInput(env, setId, {
      manifestStore: store({ probeManifestPresence: () => ({ status: "present" }), read: () => { throw new MigrationProtocolError("checksum-mismatch", "damaged"); } }),
    }))).toMatchObject({ status: "blocked", reason: "manifest-unresolvable", evidence: "manifest-checksum-mismatch" });
    await expect(prepareCutoverSet(prepareInput(env, setId, {
      manifestStore: store({ probeManifestPresence: () => ({ status: "present" }), read: () => { throw new Error("disk"); } }),
    }))).rejects.toThrow("disk");
  }, 60000);

  it("blocks on a manifest that cannot be read back after genesis", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    let reads = 0;
    const proxy = new Proxy(env.store, {
      get: (target, property) => {
        if (property === "read") {
          return (id: string) => {
            reads += 1;
            if (reads === 1) throw new MigrationProtocolError("checksum-mismatch", "damaged");
            return target.read(id);
          };
        }
        const value = (target as never)[property] as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect(await prepareCutoverSet(prepareInput(env, setId, { manifestStore: proxy }))).toMatchObject({
      status: "blocked", reason: "manifest-unresolvable", evidence: "manifest-checksum-mismatch",
    });
  }, 60000);

  it.each([
    ["classifies as unusable", { classifySnapshot: async () => { throw new Error("io"); } }, "member-snapshot-unresolvable", "Error"],
    ["is partial", { classifySnapshot: async () => ({ state: "partial" }) }, "member-snapshot-partial", "snapshot-partial"],
    ["was replaced", { classifySnapshot: async () => ({ state: "replaced" }) }, "member-snapshot-partial", "snapshot-replaced"],
    ["is tampered", { classifySnapshot: async () => ({ state: "tampered" }) }, "member-snapshot-tampered", "snapshot-tampered"],
  ])("blocks a member whose snapshot %s", async (_name, ops, reason, evidence) => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    expect(await prepareCutoverSet(prepareInput(env, setId, {}, ops as never))).toMatchObject({ status: "blocked", reason, evidence });
  }, 60000);

  it.each([
    ["a membership drift", new CutoverSetCaptureError("cutover-set-membership-drift", "drift", ["p1", "p2"]), "cutover-set-membership-drift", "p1,p2"],
    ["an unbound request", new CutoverSetCaptureError("cutover-set-member-unbound", "unbound"), "cutover-set-member-unbound", undefined],
    ["contention", new PrivateMutationLockContentionError("busy"), "capture-contention", "lock-contention"],
    ["a publication slot occupant", new BackendPublicationJournalError("unresolved-publication", "occupied"), "capture-contention", "journal-unresolved-publication"],
    ["another journal failure", new BackendPublicationJournalError("malformed-journal", "bad"), "capture-unresolvable", "journal-malformed-journal"],
    ["an unclassified failure", new TypeError("odd"), "capture-failed", "TypeError"],
  ])("blocks a capture that fails with %s, with the hold intact", async (_name, error, reason, evidence) => {
    const { env, result } = await fresh({ captureSource: async () => { throw error; } });
    expect(result).toMatchObject({ status: "blocked", reason, ...(evidence === undefined ? {} : { evidence }) });
    expect(heldJournal(env).phase).toBe("maintenance-held");
    expect(env.store.probeManifestPresence(memberIds(env)[0]!)).toEqual({ status: "absent" });
  }, 60000);

  it("blocks a capture that did not rebind the member's queue evidence", async () => {
    const { result } = await fresh({ captureSource: async () => undefined as never });
    expect(result).toMatchObject({ status: "blocked", reason: "capture-failed", evidence: "queue-evidence-not-rebound" });
  }, 60000);

  it.each([
    ["another project", (authority: object) => ({ ...authority, physicalProjectId: "p" })],
    ["another source selection", (authority: object) => ({ ...authority, sourceSelectionSha256: HASH })],
  ])("blocks a member whose source authenticates as %s", async (_name, change) => {
    const { authenticateSqliteMigrationSource } = await import("../../src/migration/maintenance.js");
    const { result } = await fresh({ authenticateSource: ((...args: Parameters<typeof authenticateSqliteMigrationSource>) => change(authenticateSqliteMigrationSource(...args))) as never });
    expect(result).toMatchObject({ status: "blocked", reason: "member-authority-drifted" });
  }, 60000);

  it.each([
    ["an unreadable seal", () => { throw new Error("io"); }, "member-snapshot-unresolvable"],
    ["another binding checksum", (sealed: { artifact: object }) => ({ ...sealed, artifact: { ...sealed.artifact, maintenanceChecksumSha256: HASH } }), "member-binding-drifted"],
    ["another project", (sealed: { artifact: { authority: object } }) => ({ ...sealed, artifact: { ...sealed.artifact, authority: { ...sealed.artifact.authority, physicalProjectId: "p" } } }), "member-binding-drifted"],
    ["another source selection", (sealed: { artifact: object }) => ({ ...sealed, artifact: { ...sealed.artifact, sourceSelectionSha256: HASH } }), "member-binding-drifted"],
  ])("blocks a member with %s", async (_name, change, reason) => {
    const { inspectAuthenticatedSqliteMigrationSnapshot } = await import("../../src/migration/queue-evidence.js");
    const { result } = await fresh({ inspectSnapshot: (async (...args: Parameters<typeof inspectAuthenticatedSqliteMigrationSnapshot>) =>
      (change as (sealed: unknown) => unknown)(await inspectAuthenticatedSqliteMigrationSnapshot(...args))) as never });
    expect(result).toMatchObject({ status: "blocked", reason });
  }, 60000);

  it("blocks when the copy refuses", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const ids = (await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() }) as { members: { generationId: string }[] }).members.map((m) => m.generationId);
    env.failCopy.add(ids[0]!);
    expect(await prepareCutoverSet(prepareInput(env, setId))).toMatchObject({ status: "blocked", reason: "copy-failed", evidence: "Error" });
    expect(env.store.read(ids[0]!).phase).toBe("dry-run-verified");
  }, 60000);
});

describe("member verification failures", () => {
  it("blocks on refused verification inputs, with and without evidence", async () => {
    const { result: first } = await fresh({ buildVerificationInputs: async () => ({ status: "refuse", reason: "verify-project-map-drift", generationId: "g" }) });
    expect(first).toMatchObject({ status: "blocked", reason: "member-verification-failed", evidence: "verify-project-map-drift" });
    const { result: second } = await fresh({ buildVerificationInputs: async () => ({ status: "refuse", reason: "verify-destination-drift", generationId: "g", evidence: "system-identifier-absent" }) });
    expect(second).toMatchObject({ status: "blocked", reason: "member-verification-failed", evidence: "verify-destination-drift:system-identifier-absent" });
  }, 90000);

  it.each([
    ["contention", new PrivateMutationLockContentionError("busy"), "verify-contention"],
    ["a lease that is unavailable", new MigrationVerificationDriverError("lease-unavailable", "x"), "verify-contention"],
    ["a lease that was lost", new MigrationVerificationDriverError("lease-lost", "x"), "verify-contention"],
    ["destination drift", new MigrationVerificationDriverError("destination-drift", "x"), "verify-destination-drift"],
    ["a manifest failure", new MigrationProtocolError("checksum-mismatch", "x"), "manifest-checksum-mismatch"],
    ["a report store failure", new MigrationVerificationStoreError("report-missing" as never, "x"), "report-report-missing"],
  ])("blocks a verification that fails with %s", async (_name, error, evidence) => {
    const { result } = await fresh({ verify: async () => { throw error; } });
    expect(result).toMatchObject({ status: "blocked", reason: "member-verification-failed", evidence });
  }, 90000);

  it("lets an unclassified verification failure escape and removes its scratch directory", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    let scratch = "";
    // The mints preceded the failure, so their effects ride on the wrapper.
    const error = await prepareCutoverSet(prepareInput(env, setId, {}, { verify: async (input) => { scratch = input.scratchParent; throw new Error("boom"); } }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CutoverSetPrepareError);
    expect(((error as CutoverSetPrepareError).cause as Error).message).toBe("boom");
    const { existsSync } = await import("node:fs");
    expect(scratch).not.toBe("");
    expect(existsSync(scratch)).toBe(false);
  }, 90000);

  it("blocks an eligible-looking verification whose persisted evidence does not read back", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const fake = fakeOps(env);
    const ops = { verify: async (input: Parameters<NonNullable<typeof fake.verify>>[0]) => {
      const result = await fake.verify!(input);
      // The report claims eligibility but the manifest never completed verification.
      return result;
    }, readVerified: () => ({ status: "refuse", reason: "verify-readback-mismatch", generationId: "g", evidence: "report-not-eligible" }) as never };
    expect(await prepareCutoverSet(prepareInput(env, setId, {}, ops))).toMatchObject({
      status: "blocked", reason: "member-verification-failed", evidence: "verify-readback-mismatch:report-not-eligible",
    });
  }, 90000);

  it.each([
    ["a persisted-evidence conflict", new MigrationVerificationDriverError("report-identity-conflict", "x"), "verify-report-identity-conflict"],
    ["a manifest failure", new MigrationProtocolError("checksum-mismatch", "x"), "manifest-checksum-mismatch"],
  ])("blocks a pending verification that fails with %s", async (_name, error, evidence) => {
    const env = await makeEnv();
    const { setId, ids } = await blockedAtFirstGenesis(env);
    createFixtureManifest(env.store, "copied", { generationId: ids[0]!, pending: "verify-generation" });
    expect(await prepareCutoverSet(prepareInput(env, setId, {}, { completePendingVerification: () => { throw error; } })))
      .toMatchObject({ status: "blocked", reason: "member-verification-failed", evidence });
  }, 60000);

  it("blocks a pending verification that has nothing to complete, and lets an unclassified failure escape", async () => {
    const env = await makeEnv();
    const { setId, ids } = await blockedAtFirstGenesis(env);
    createFixtureManifest(env.store, "copied", { generationId: ids[0]!, pending: "verify-generation" });
    expect(await prepareCutoverSet(prepareInput(env, setId, {}, { completePendingVerification: () => null })))
      .toMatchObject({ status: "blocked", reason: "member-verification-failed", evidence: expect.stringContaining("verify-readback-mismatch") });
    await expect(prepareCutoverSet(prepareInput(env, setId, {}, { completePendingVerification: () => { throw new Error("boom"); } }))).rejects.toThrow("boom");
  }, 60000);
});


describe("optional inputs and remaining branches", () => {
  it("threads the optional inputs to every member's copy and verification", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const fake = fakeOps(env);
    const copyInputs: Parameters<NonNullable<typeof fake.genesisAndCopy>>[0][] = [];
    const verifyInputs: Parameters<NonNullable<typeof fake.verify>>[0][] = [];
    const inputLeases: (number | undefined)[] = [];
    const controller = new AbortController();
    const testing = { observe: async () => undefined };
    const now = new Date("2026-10-20T12:00:00.000Z");
    const result = await prepareCutoverSet(prepareInput(env, setId, {
      ownerProcessId: undefined, leaseTtlMs: 1234, signal: controller.signal, now, copyTesting: testing,
    }, {
      genesisAndCopy: async (input) => { copyInputs.push(input); return fake.genesisAndCopy(input); },
      buildVerificationInputs: async (input) => { inputLeases.push(input.leaseTtlMs); return fake.buildVerificationInputs(input); },
      verify: async (input) => { verifyInputs.push(input); return fake.verify(input); },
    }));
    expect(result.status).toBe("prepared");
    expect(copyInputs.map((input) => [input.leaseTtlMs, input.signal, input.now, input.testing, typeof input.ownerProcessId]))
      .toEqual([[1234, controller.signal, now, testing, "string"], [1234, controller.signal, now, testing, "string"]]);
    expect(inputLeases).toEqual([1234, 1234]);
    expect(verifyInputs.map((input) => input.signal)).toEqual([controller.signal, controller.signal]);
  }, 90000);

  it("reports a clean but incompletely covered verification as such", async () => {
    const { result } = await fresh({ verify: async () => ({ report: { activationEligible: false, clean: true } as never, outcome: "clean", effectId: "x", inputSha256: "y" }) });
    expect(result).toMatchObject({ status: "blocked", reason: "member-verification-failed", evidence: "coverage-incomplete" });
  }, 90000);

  it("refuses when a member stopped being authenticated under the mints", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const { resolveCutoverSetMemberAuthorities } = await import("../../src/migration/maintenance.js");
    let calls = 0;
    const result = await prepareCutoverSet(prepareInput(env, setId, {}, {
      resolveAuthorities: (input) => {
        calls += 1;
        const real = resolveCutoverSetMemberAuthorities(input);
        return calls === 1 || real.status !== "resolved" ? real : {
          status: "resolved",
          outcomes: real.outcomes.map((outcome, index) => index === 0
            ? { physicalProjectId: outcome.physicalProjectId, status: "unverifiable" as const, detail: "metadata" } : outcome),
        };
      },
    }));
    expect(result).toMatchObject({ status: "refuse", reason: "cutover-set-authority-changed", setId });
  }, 90000);

  it("lets an unclassified manifest failure after genesis escape", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    const proxy = new Proxy(env.store, {
      get: (target, property) => {
        if (property === "read") return () => { throw new Error("late"); };
        const value = (target as never)[property] as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(prepareCutoverSet(prepareInput(env, setId, { manifestStore: proxy }))).rejects.toThrow("late");
  }, 60000);
});

describe("the held-authority fence (F1)", () => {
  type Resolve = CutoverSetPrepareOperations["resolveAuthorities"];
  const viaReal = async (mutate: (real: Awaited<ReturnType<Resolve>>) => ReturnType<Resolve>): Promise<{ resolveAuthorities: Resolve; tokens: unknown[] }> => {
    const { resolveCutoverSetMemberAuthorities } = await import("../../src/migration/maintenance.js");
    const tokens: unknown[] = [];
    return {
      tokens,
      resolveAuthorities: ((input: Parameters<Resolve>[0]) => {
        tokens.push(input.lockToken);
        return mutate(resolveCutoverSetMemberAuthorities(input));
      }) as Resolve,
    };
  };
  const outcomesOf = (real: Awaited<ReturnType<Resolve>>) =>
    (real as Extract<typeof real, { status: "resolved" }>).outcomes;

  /** A verified (complete snapshot, verified manifest), B blocked before any manifest: resumable. */
  async function verifiedThenResumable() {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const ids = (await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() }) as { members: { generationId: string }[] }).members.map((m) => m.generationId);
    env.failDryRun.add(ids[1]!);
    expect((await prepareCutoverSet(prepareInput(env, setId))).status).toBe("blocked");
    env.failDryRun.clear();
    env.calls.length = 0;
    return { env, setId, ids };
  }
  const memberCalls = (env: Env) => env.calls.filter((call) => !call.startsWith("identity"));

  it("refuses a changed source selection before any member work, even for a verified member", async () => {
    const { env, setId, ids } = await verifiedThenResumable();
    const before = env.store.read(ids[0]!);
    const { resolveAuthorities } = await viaReal((real) => ({
      status: "resolved",
      outcomes: outcomesOf(real).map((outcome, index) => index === 0 && outcome.status === "authenticated"
        ? { ...outcome, authority: { ...outcome.authority, sourceSelectionSha256: HASH } } : outcome),
    }));
    const result = await prepareCutoverSet(prepareInput(env, setId, {}, { resolveAuthorities }));
    expect(result).toEqual({
      status: "refuse", reason: "cutover-set-authority-drifted", projects: [env.projects[0]!.id], setId, identityMutation: [],
    });
    expect(memberCalls(env)).toEqual([]);
    expect(env.store.read(ids[0]!)).toEqual(before);
    expect(env.store.probeManifestPresence(ids[1]!)).toEqual({ status: "absent" });
  }, 90000);

  it.each([
    ["an extra stored-data project", (outcomes: ReturnType<typeof outcomesOf>) =>
      [...outcomes, { ...outcomes[0]!, physicalProjectId: "e".repeat(64) }], "e".repeat(64)],
    ["a missing stored-data project", (outcomes: ReturnType<typeof outcomesOf>) => outcomes.slice(1), null],
  ])("refuses %s before any member work, with every snapshot complete", async (_name, change, extra) => {
    const { env, setId, ids } = await verifiedThenResumable();
    const { resolveAuthorities } = await viaReal((real) => ({ status: "resolved", outcomes: change(outcomesOf(real)) }));
    const result = await prepareCutoverSet(prepareInput(env, setId, {}, { resolveAuthorities }));
    expect(result).toMatchObject({
      status: "refuse", reason: "cutover-set-membership-drift", projects: [extra ?? env.projects[0]!.id], setId,
    });
    expect(memberCalls(env)).toEqual([]);
    expect(env.store.read(ids[0]!).phase).toBe("verified");
  }, 90000);

  it.each([
    ["an unresolvable enumeration", () => ({ status: "unresolvable", reason: "events-directory-unresolvable", detail: "EACCES" }) as never,
      { reason: "cutover-set-enumeration-unresolvable", evidence: "events-directory-unresolvable: EACCES" }],
    ["an uncovered project", (real: Awaited<ReturnType<Resolve>>) => ({
      status: "resolved",
      outcomes: outcomesOf(real).map((outcome, index) => index === 1
        ? { physicalProjectId: outcome.physicalProjectId, status: "uncovered", detail: "no entry" } : outcome),
    }) as never, { reason: "cutover-set-member-unverifiable" }],
    ["an unverifiable project", (real: Awaited<ReturnType<Resolve>>) => ({
      status: "resolved",
      outcomes: outcomesOf(real).map((outcome, index) => index === 0
        ? { physicalProjectId: outcome.physicalProjectId, status: "unverifiable", detail: "metadata" } : outcome),
    }) as never, { reason: "cutover-set-member-unverifiable" }],
  ])("refuses %s without starting any member", async (_name, mutate, expected) => {
    const { env, setId } = await verifiedThenResumable();
    const { resolveAuthorities } = await viaReal(mutate);
    const result = await prepareCutoverSet(prepareInput(env, setId, {}, { resolveAuthorities }));
    expect(result).toMatchObject({ status: "refuse", ...expected, setId });
    expect(memberCalls(env)).toEqual([]);
  }, 90000);

  it("enumerates under a token after an entering recovery reaches held, and refuses drift before member work", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    const held = heldJournal(env);
    const order: string[] = [];
    const entering: BackendMaintenanceJournal = { ...held, phase: "maintenance-entering", checksumSha256: "e".repeat(64) };
    const coordinator = { enterMaintenance: async () => { order.push("recover"); return held; } } as unknown as BackendPublicationCoordinator;
    const { resolveAuthorities, tokens } = await viaReal((real) => {
      order.push("enumerate");
      return { status: "resolved", outcomes: outcomesOf(real).slice(1) };
    });
    const result = await prepareCutoverSet(prepareInput(env, setId, { coordinator }, {
      observeJournal: () => ({ kind: "hold", journal: entering }) as never, resolveAuthorities,
    }));
    expect(order).toEqual(["recover", "enumerate"]);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toBeDefined();
    expect(result).toMatchObject({ status: "refuse", reason: "cutover-set-membership-drift", setId });
    expect(memberCalls(env)).toEqual([]);
  }, 90000);

  it("never enumerates when the entering recovery itself is refused", async () => {
    const env = await makeEnv();
    const { setId } = await blockedAtFirstGenesis(env);
    const entering: BackendMaintenanceJournal = { ...heldJournal(env), phase: "maintenance-entering" };
    const coordinator = { enterMaintenance: async () => { throw new BackendPublicationJournalError("unexpected-state", "moved"); } } as unknown as BackendPublicationCoordinator;
    const { resolveAuthorities, tokens } = await viaReal((real) => real);
    expect(await prepareCutoverSet(prepareInput(env, setId, { coordinator }, {
      observeJournal: () => ({ kind: "hold", journal: entering }) as never, resolveAuthorities,
    }))).toMatchObject({ status: "refuse", reason: "entering-recovery-precondition" });
    expect(tokens).toEqual([]);
  }, 90000);

  it("enumerates under a token on an unchanged resume and still skips the verified member untouched", async () => {
    const { env, setId, ids } = await verifiedThenResumable();
    const before = env.store.read(ids[0]!);
    const { resolveAuthorities, tokens } = await viaReal((real) => real);
    const result = await prepareCutoverSet(prepareInput(env, setId, {}, { resolveAuthorities }));
    expect(result.status).toBe("prepared");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toBeDefined();
    expect(env.store.read(ids[0]!)).toEqual(before);
    expect(memberCalls(env).some((call) => call.includes(ids[0]!))).toBe(false);
  }, 90000);
});
