import { describe, expect, it } from "vitest";
import {
  assertBackendPublicationConsumerAccess,
  readBackendMaintenanceJournal,
  resolveBackendMaintenanceGenerationBinding,
  type BackendMaintenanceJournal,
  type BackendPublicationJournalError,
} from "../../src/storage/backend-publication.js";
import { prepareCutoverSet, resolveCutoverSetCandidate, type CutoverSetPrepareResult } from "../../src/migration/cutover-set-prepare.js";
import { inspectAuthenticatedSqliteMigrationSnapshot } from "../../src/migration/queue-evidence.js";
import { classifySqliteSnapshotArtifact } from "../../src/migration/sqlite-snapshot.js";
import { createFixtureManifest, fixtureVerificationReport, persistFixtureReport, type FixtureStage } from "./existing-fixtures.js";
import {
  blockedAtFirstGenesis, candidateSetId, fakeOps, heldJournal, makeEnv, memberIds, prepareInput, targetConfig,
} from "../fixtures/cutover-set-prepare.js";

function expectBlocked(result: CutoverSetPrepareResult, reason: string, project?: string): Extract<CutoverSetPrepareResult, { status: "blocked" }> {
  expect(result).toMatchObject({ status: "blocked", reason });
  const blocked = result as Extract<CutoverSetPrepareResult, { status: "blocked" }>;
  if (project !== undefined) expect(blocked.blockedProject).toBe(project);
  return blocked;
}

describe("prepareCutoverSet: one hold, then every member", () => {
  it("holds before any snapshot, prepares and verifies every member, and keeps both members' evidence valid", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    expect(readBackendMaintenanceJournal(env.homeDir)).toBeNull();
    const snapshotsAtMint: string[] = [];
    const journalAtMint: (BackendMaintenanceJournal | null)[] = [];
    let aView: ReturnType<typeof resolveBackendMaintenanceGenerationBinding> = null;
    let consumerFenceAtA = "";
    const result = await prepareCutoverSet(prepareInput(env, setId, {}, {
      resolveIdentity: async (input) => {
        journalAtMint.push(readBackendMaintenanceJournal(env.homeDir));
        return fakeOps(env).resolveIdentity!(input);
      },
      genesisDryRun: async (input) => {
        const ids = memberIds(env);
        if (input.generationId === ids[0]) {
          // Member A is captured; member B's snapshot does not exist yet and the hold fences every writer.
          snapshotsAtMint.push((await classifySqliteSnapshotArtifact(ids[1]!, { homeDir: env.homeDir })).state);
          try { assertBackendPublicationConsumerAccess({ homeDir: env.homeDir }); } catch (error) { consumerFenceAtA = (error as BackendPublicationJournalError).reason; }
        } else {
          aView = resolveBackendMaintenanceGenerationBinding(readBackendMaintenanceJournal(env.homeDir), ids[0]!);
        }
        return fakeOps(env).genesisDryRun!(input);
      },
    }));
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") return;
    expect(result.setId).toBe(setId);
    expect(result.members.map((member) => member.state)).toEqual(["verified", "verified"]);
    expect(result.identityMutation.map((entry) => entry.effects)).toEqual([
      [{ stage: "local", outcome: "reused" }, { stage: "destination", outcome: "created" }],
      [{ stage: "local", outcome: "reused" }, { stage: "destination", outcome: "created" }],
    ]);
    // No hold or snapshot existed when identities were minted.
    expect(journalAtMint).toEqual([null, null]);
    // Member B had no snapshot while member A was being prepared, and the hold fenced consumers.
    expect(snapshotsAtMint).toEqual(["absent"]);
    expect(consumerFenceAtA).toBe("unresolved-publication");
    const journal = heldJournal(env);
    expect(journal.phase).toBe("maintenance-held");
    const ids = memberIds(env);
    for (const id of ids) expect(env.store.read(id).phase).toBe("verified");
    // Both members' witnesses and queue cutoffs stay valid under the same hold.
    const finalA = resolveBackendMaintenanceGenerationBinding(journal, ids[0]!)!;
    expect(aView!.checksumSha256).toBe(finalA.checksumSha256);
    expect(aView!.roster).toEqual(finalA.roster);
    for (const id of ids) {
      const view = resolveBackendMaintenanceGenerationBinding(journal, id)!;
      const sealed = await inspectAuthenticatedSqliteMigrationSnapshot(id, env.homeDir);
      expect(sealed.artifact.maintenanceChecksumSha256).toBe(view.checksumSha256);
      expect(sealed.receiptReference.queueCutoff).toBe(view.roster[0]!.queueCutoff);
    }
    expect(env.calls.filter((call) => !call.startsWith("identity"))).toEqual([
      "dry-run:" + ids[0], "copy:" + ids[0], "inputs:" + ids[0], "verify:" + ids[0],
      "dry-run:" + ids[1], "copy:" + ids[1], "inputs:" + ids[1], "verify:" + ids[1],
    ]);
  }, 60000);

  it("resumes an interrupted preparation per member without re-copying a verified one", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const ids = (await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() }) as { members: { generationId: string }[] }).members.map((member) => member.generationId);
    env.failDryRun.add(ids[1]!);
    const first = await prepareCutoverSet(prepareInput(env, setId));
    const blocked = expectBlocked(first, "genesis-inspection-failed", env.projects[1]!.id);
    expect(blocked.members.map((member) => member.state)).toEqual(["verified", "blocked"]);
    const before = env.store.read(ids[0]!);
    const journalBefore = heldJournal(env);
    env.calls.length = 0;
    env.failDryRun.clear();

    const resumed = await prepareCutoverSet(prepareInput(env, setId));
    expect(resumed.status).toBe("prepared");
    // Member A is validated and skipped: nothing was constructed or run for it, and its manifest did not move.
    expect(env.calls.filter((call) => !call.startsWith("identity"))).toEqual([
      "dry-run:" + ids[1], "copy:" + ids[1], "inputs:" + ids[1], "verify:" + ids[1],
    ]);
    expect(env.store.read(ids[0]!)).toEqual(before);
    expect(resolveBackendMaintenanceGenerationBinding(heldJournal(env), ids[0]!)).toEqual(resolveBackendMaintenanceGenerationBinding(journalBefore, ids[0]!));
    // Held identities are resolved without minting.
    expect(env.calls.filter((call) => call.startsWith("identity")).every((call) => call.endsWith(":continue-held"))).toBe(true);
  }, 60000);

  it("blocks the set at a member whose verification is ineligible and starts no later member", async () => {
    const env = await makeEnv();
    const setId = await candidateSetId(env);
    const ids = (await resolveCutoverSetCandidate({ homeDir: env.homeDir, targetConfig: targetConfig() }) as { members: { generationId: string }[] }).members.map((member) => member.generationId);
    env.ineligible.add(ids[0]!);
    const result = await prepareCutoverSet(prepareInput(env, setId));
    const blocked = expectBlocked(result, "member-verification-failed", env.projects[0]!.id);
    expect(blocked.evidence).toBe("mismatches");
    expect(blocked.members.map((member) => member.state)).toEqual(["blocked", "pending"]);
    expect(env.store.read(ids[0]!).phase).toBe("copied");
    expect(env.calls.some((call) => call.includes(ids[1]!))).toBe(false);
    expect(heldJournal(env).phase).toBe("maintenance-held");
    expect(env.store.probeManifestPresence(ids[1]!)).toEqual({ status: "absent" });
  }, 60000);
});

describe("prepareCutoverSet: durable member state decides where a call resumes", () => {
  const states: ReadonlyArray<readonly [string, FixtureStage, boolean, string[], string]> = [
    ["planned with nothing pending", "planned", false, ["dry-run", "copy", "inputs", "verify"], "verified"],
    ["dry-run verified", "dry-run-verified", false, ["copy", "inputs", "verify"], "verified"],
    ["copying", "copying", false, ["copy", "inputs", "verify"], "verified"],
    ["copied", "copied", false, ["inputs", "verify"], "verified"],
    ["verified", "verified", false, [], "verified"],
  ];
  it.each(states)("resumes a member that is %s", async (_name, stage, _pending, expectedCalls, finalPhase) => {
    const env = await makeEnv();
    const { setId, ids } = await blockedAtFirstGenesis(env);
    createFixtureManifest(env.store, stage, { generationId: ids[0]! });
    if (stage === "verified") persistFixtureReport(env.homeDir, fixtureVerificationReport(ids[0]!));
    const before = env.store.read(ids[0]!);
    const result = await prepareCutoverSet(prepareInput(env, setId));
    expect(result.status).toBe("prepared");
    const forFirst = env.calls.filter((call) => call.includes(ids[0]!)).map((call) => call.split(":")[0]!);
    expect(forFirst).toEqual(expectedCalls);
    expect(env.store.read(ids[0]!).phase).toBe(finalPhase);
    if (stage === "verified") expect(env.store.read(ids[0]!)).toEqual(before);
  }, 60000);

  it("completes a pending dry-run effect by its exact carried id", async () => {
    const env = await makeEnv();
    const { setId, ids } = await blockedAtFirstGenesis(env);
    createFixtureManifest(env.store, "planned", { generationId: ids[0]!, pending: "verify-dry-run" });
    const result = await prepareCutoverSet(prepareInput(env, setId));
    expect(result.status).toBe("prepared");
    expect(env.calls).toContain("dry-run:" + ids[0] + ":carried=verify-dry-run-effect");
  }, 60000);

  it("finishes a verification that began before a crash from persisted evidence, without copying or verifying again", async () => {
    const env = await makeEnv();
    const { setId, ids } = await blockedAtFirstGenesis(env);
    const report = fixtureVerificationReport(ids[0]!);
    persistFixtureReport(env.homeDir, report);
    createFixtureManifest(env.store, "copied", { generationId: ids[0]!, pending: "verify-generation", report });
    const result = await prepareCutoverSet(prepareInput(env, setId));
    expect(result.status).toBe("prepared");
    expect(env.calls.filter((call) => call.includes(ids[0]!))).toEqual([]);
    expect(env.store.read(ids[0]!).phase).toBe("verified");
  }, 60000);

  it.each([
    ["a copied member with another pending effect", "copied" as const, "abort" as const, "manifest-copied:pending-abort"],
    ["a verified member with a pending activation", "verified" as const, "prepare-activation" as const, "manifest-verified:pending-prepare-activation"],
  ])("blocks %s", async (_name, stage, pending, evidence) => {
    const env = await makeEnv();
    const { setId, ids } = await blockedAtFirstGenesis(env);
    createFixtureManifest(env.store, stage, { generationId: ids[0]!, pending });
    const result = await prepareCutoverSet(prepareInput(env, setId));
    expect(result).toMatchObject({ status: "blocked", reason: "member-state-unexpected", evidence });
  }, 60000);

  it("blocks a member whose manifest left the copy path", async () => {
    const env = await makeEnv();
    const { setId, ids } = await blockedAtFirstGenesis(env);
    createFixtureManifest(env.store, "active", { generationId: ids[0]! });
    expect(await prepareCutoverSet(prepareInput(env, setId))).toMatchObject({ status: "blocked", reason: "member-state-unexpected", evidence: "manifest-active" });
  }, 60000);

  it("blocks a member whose manifest exists beside an absent snapshot", async () => {
    const env = await makeEnv();
    const { setId, ids } = await blockedAtFirstGenesis(env);
    createFixtureManifest(env.store, "planned", { generationId: ids[1]! });
    // Member A (captured, no manifest) is prepared first, so member B's inconsistent state is reached.
    const result = await prepareCutoverSet(prepareInput(env, setId));
    expect(result).toMatchObject({ status: "blocked", reason: "member-snapshot-absent", evidence: "manifest-planned", blockedProject: env.projects[1]!.id });
  }, 60000);
});

