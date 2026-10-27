import { describe, expect, it } from "vitest";
import { performMigrationApplyThroughCapture } from "../../src/migration/apply.js";
import { resolveMigrationApplyCandidate } from "../../src/migration/candidate.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { createMigrationManifest } from "../../src/migration/protocol.js";
import { readBackendMaintenanceJournal } from "../../src/storage/backend-publication.js";
import { SET_ID } from "../fixtures/cutover-set.js";
import { enterSetHold, setHome, setHomeCoordinator } from "../fixtures/cutover-set-home.js";

const CREATED_AT = "2026-08-12T12:00:00.000Z";

/** A home whose set hold was aborted, leaving member 1's manifest unsettled (an interrupted set abort). */
async function abortedSetWithUnsettledMember() {
  const { homeDir, projects } = await setHome();
  const { held } = await enterSetHold(homeDir);
  await setHomeCoordinator(homeDir).abortMaintenance({
    expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: "c".repeat(64),
  });
  return { homeDir, projects, held };
}

function createMemberManifest(homeDir: string, generationId: string): void {
  new MigrationManifestStore({ homeDir }).create(createMigrationManifest({
    generationId,
    source: { version: 1, backend: "sqlite", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt: CREATED_AT },
    destination: { version: 1, backend: "postgresql", identitySha256: "4".repeat(64), schemaSha256: "5".repeat(64), contentSha256: "6".repeat(64), capturedAt: CREATED_AT },
    parentGenerationId: null, preservedSourceGenerationId: generationId, createdAt: CREATED_AT,
  }));
}

describe("the abort gate over a terminal cutover-set journal", () => {
  it("lets a fresh single-generation apply and its preview pass while every member manifest is absent", async () => {
    const { homeDir, projects } = await abortedSetWithUnsettledMember();
    expect(readBackendMaintenanceJournal(homeDir)!.generationId).toBe(SET_ID);
    const candidate = await resolveMigrationApplyCandidate({ cwd: projects[0]!.cwd, homeDir, base: "gate-base" });
    expect(candidate).toEqual({ status: "candidate", disposition: "fresh", generationId: "gate-base-0" });
  });

  it("refuses apply and its preview while any member manifest is unsettled, naming the member", async () => {
    const { homeDir, projects } = await abortedSetWithUnsettledMember();
    createMemberManifest(homeDir, "member-generation-2");
    expect(await resolveMigrationApplyCandidate({ cwd: projects[0]!.cwd, homeDir, base: "gate-base" }))
      .toEqual({ status: "refuse", reason: "abort-or-resume-required", evidence: "member-generation-2:manifest-ready" });
    expect(await performMigrationApplyThroughCapture({
      cwd: projects[0]!.cwd, homeDir, base: "gate-base", confirmGenerationId: "gate-base-0",
    })).toEqual({ status: "refuse", reason: "abort-or-resume-required", evidence: "member-generation-2:manifest-ready" });
  });

  it("refuses with unresolvable evidence when a member manifest cannot be probed", async () => {
    const { homeDir, projects } = await abortedSetWithUnsettledMember();
    const unreadable = { probeManifestPresence: () => ({ status: "unresolvable", reason: "internal-error" }) } as unknown as MigrationManifestStore;
    expect(await resolveMigrationApplyCandidate({ cwd: projects[0]!.cwd, homeDir, base: "gate-base", manifestStore: unreadable }))
      .toEqual({ status: "refuse", reason: "abort-gate-unresolvable", evidence: "member-generation-1:manifest-internal-error" });
    expect(await performMigrationApplyThroughCapture({
      cwd: projects[0]!.cwd, homeDir, base: "gate-base", confirmGenerationId: "gate-base-0", manifestStore: unreadable,
    })).toEqual({ status: "refuse", reason: "abort-gate-unresolvable", evidence: "member-generation-1:manifest-internal-error" });
  });
});

