import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveMigrationHoldContinuation,
  type MigrationHoldCandidate,
} from "../../src/migration/hold-continuation.js";
import {
  BackendPublicationCoordinator,
  backendPublicationCanonicalSha256,
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  withBackendPublicationAppendBarrierAsync,
  rebindBackendMaintenanceCutoff,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";

const roots: string[] = [];
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const OTHER_MACHINE_ID = "018f0b5d-9999-4abc-8def-1234567890ab";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-hold-continuation-"));
  roots.push(home);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  return home;
}

function coordinatorFor(home: string): BackendPublicationCoordinator {
  const unexpected: BackendPublicationDriver["observeLocalState"] = async () => {
    throw new Error("v2 driver must not run for maintenance");
  };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected,
    publishProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
    publishConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
    restoreConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
    restoreProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
  };
  return new BackendPublicationCoordinator({ homeDir: home, driver });
}

function rewriteJournal(home: string, mutate: (journal: Record<string, unknown>) => Record<string, unknown>): void {
  const path = backendPublicationJournalPath(home);
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const next = mutate(current);
  const { checksumSha256: _checksum, ...payload } = next;
  writeFileSync(path, `${JSON.stringify({ ...payload, checksumSha256: backendPublicationCanonicalSha256(payload) })}\n`, { mode: 0o600 });
}

async function heldJournal(home: string): Promise<BackendMaintenanceJournal> {
  return coordinatorFor(home).enterMaintenance({
    publicationId: "maintenance-publication",
    generationId: "maintenance-generation",
    sourceSelectionSha256: "a".repeat(64),
    queueEvidenceSha256: "b".repeat(64),
    roster: [{ machineId: MACHINE_ID, queueCutoff: null, evidenceSha256: "a".repeat(64) }],
  });
}

function candidateFor(journal: BackendMaintenanceJournal, overrides: Partial<MigrationHoldCandidate> = {}): MigrationHoldCandidate {
  return {
    publicationId: journal.publicationId,
    generationId: journal.generationId,
    sourceSelectionSha256: journal.sourceSelectionSha256,
    machineId: journal.roster[0]!.machineId,
    ...overrides,
  };
}

describe("resolveMigrationHoldContinuation (section 4.5 continuation)", () => {
  it("routes maintenance-entering to recover-entering regardless of candidate content (the full comparison belongs to enterMaintenance itself)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    rewriteJournal(home, (journal) => ({ ...journal, phase: "maintenance-entering" }));
    const entering = readBackendMaintenanceJournal(home)!;
    expect(entering.phase).toBe("maintenance-entering");
    const result = resolveMigrationHoldContinuation({
      journal: entering,
      candidate: candidateFor(held, { sourceSelectionSha256: "totally-unrelated-value-should-not-matter" }),
    });
    expect(result).toEqual({ action: "recover-entering", observedChecksumSha256: entering.checksumSha256 });
  });

  it("continues a held journal after a real rebind moved queueEvidenceSha256, roster[0].queueCutoff and roster[0].evidenceSha256, because none of those are stable fields (red: comparing any of them would wrongly refuse a live, correct hold)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const rebound = await withBackendPublicationAppendBarrierAsync(home, async (token) =>
      rebindBackendMaintenanceCutoff({
        homeDir: home,
        expectedChecksumSha256: held.checksumSha256,
        generationId: held.generationId,
        sourceSelectionSha256: held.sourceSelectionSha256,
        queueEvidenceSha256: "c".repeat(64),
        roster: [{ machineId: MACHINE_ID, queueCutoff: "0000000000000000123", evidenceSha256: "c".repeat(64) }],
      }, token));
    // Positive control: confirm the rebind actually moved the three fields
    // section 2.3 consequence 2 names, so this test cannot pass by accident.
    expect(rebound.queueEvidenceSha256).not.toBe(held.queueEvidenceSha256);
    expect(rebound.roster[0]!.queueCutoff).not.toBe(held.roster[0]!.queueCutoff);
    expect(rebound.roster[0]!.evidenceSha256).not.toBe(held.roster[0]!.evidenceSha256);
    expect(rebound.publicationId).toBe(held.publicationId);
    expect(rebound.generationId).toBe(held.generationId);
    expect(rebound.sourceSelectionSha256).toBe(held.sourceSelectionSha256);

    const result = resolveMigrationHoldContinuation({ journal: rebound, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "continue-held", observedChecksumSha256: rebound.checksumSha256 });
  });

  it("refuses a genuinely different selection against a real held journal (red: this must not be confused with the rebind-drift case above)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = resolveMigrationHoldContinuation({
      journal: held,
      candidate: candidateFor(held, { sourceSelectionSha256: "f".repeat(64) }),
    });
    expect(result).toEqual({ action: "refuse", reason: "mismatched-hold" });
  });

  it("refuses a held journal held by a different machine", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = resolveMigrationHoldContinuation({
      journal: held,
      candidate: candidateFor(held, { machineId: OTHER_MACHINE_ID }),
    });
    expect(result).toEqual({ action: "refuse", reason: "mismatched-hold" });
  });

  it("refuses a held journal with a different publicationId", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = resolveMigrationHoldContinuation({
      journal: held,
      candidate: candidateFor(held, { publicationId: "a-different-publication" }),
    });
    expect(result).toEqual({ action: "refuse", reason: "mismatched-hold" });
  });

  it("refuses a held journal with a different generationId", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = resolveMigrationHoldContinuation({
      journal: held,
      candidate: candidateFor(held, { generationId: "a-different-generation" }),
    });
    expect(result).toEqual({ action: "refuse", reason: "mismatched-hold" });
  });

  it("refuses a held journal whose roster has grown past one entry", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const multiRoster: BackendMaintenanceJournal = {
      ...held,
      roster: [...held.roster, { machineId: OTHER_MACHINE_ID, queueCutoff: null, evidenceSha256: "a".repeat(64) }],
    };
    const result = resolveMigrationHoldContinuation({ journal: multiRoster, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "refuse", reason: "mismatched-hold" });
  });

  it("continues a held journal whose candidate matches on every stable field", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = resolveMigrationHoldContinuation({ journal: held, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "continue-held", observedChecksumSha256: held.checksumSha256 });
  });

  it("routes selection-prepared to resume-required", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const prepared = await coordinatorFor(home).prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256,
      generationId: held.generationId,
      targetBackend: "postgresql",
      terminalEvidenceSha256: "c".repeat(64),
    });
    expect(prepared.phase).toBe("selection-prepared");
    const result = resolveMigrationHoldContinuation({ journal: prepared, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "refuse", reason: "resume-required" });
  });

  it("routes a terminal selection-completed journal to probe-fresh", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const prepared = await coordinatorFor(home).prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256,
      generationId: held.generationId,
      targetBackend: "postgresql",
      terminalEvidenceSha256: "c".repeat(64),
    });
    const completed = await coordinatorFor(home).completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256,
      generationId: prepared.generationId,
      terminalEvidenceSha256: prepared.terminalEvidenceSha256!,
    });
    expect(completed.phase).toBe("selection-completed");
    const result = resolveMigrationHoldContinuation({ journal: completed, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "probe-fresh" });
  });

  it("routes a terminal maintenance-aborted journal to probe-fresh", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const aborted = await coordinatorFor(home).abortMaintenance({
      expectedChecksumSha256: held.checksumSha256,
      sourceSelectionSha256: held.sourceSelectionSha256,
      abortEvidenceSha256: "c".repeat(64),
    });
    expect(aborted.phase).toBe("maintenance-aborted");
    const result = resolveMigrationHoldContinuation({ journal: aborted, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "probe-fresh" });
  });

  it("throws rather than silently starting a fresh cutover for a phase outside the closed union (the exhaustiveness guard, exercised only by deliberately bypassing the type system the way a genuinely new phase value would arrive at runtime)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const unrecognised = { ...held, phase: "a-future-phase-not-yet-invented" as unknown as BackendMaintenanceJournal["phase"] };
    expect(() => resolveMigrationHoldContinuation({ journal: unrecognised, candidate: candidateFor(held) }))
      .toThrow(/unreachable migration maintenance phase/u);
  });
});

describe("section 4.9's second exposure: the observed checksum must be carried, never re-read, at the point of use", () => {
  it("carrying the observed checksum into enterMaintenance's recovery refuses once the journal has moved; re-reading instead of carrying would wrongly succeed on the moved state (red-first, both directions shown)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    rewriteJournal(home, (journal) => ({ ...journal, phase: "maintenance-entering" }));
    const entering = readBackendMaintenanceJournal(home)!;

    const disposition = resolveMigrationHoldContinuation({
      journal: entering,
      candidate: candidateFor(held),
    });
    expect(disposition).toEqual({ action: "recover-entering", observedChecksumSha256: entering.checksumSha256 });

    // The journal moves between observation and use: updatedAt changes, so
    // the checksum changes, while every field enterMaintenance's own
    // recovery comparison checks (publicationId, generationId,
    // sourceSelectionSha256, queueEvidenceSha256, roster) stays identical.
    // This models a second legitimate writer touching the journal in the
    // gap, not a corruption.
    rewriteJournal(home, (journal) => ({ ...journal, updatedAt: "2026-08-12T13:00:00.000Z" }));
    const moved = readBackendMaintenanceJournal(home)!;
    expect(moved.checksumSha256).not.toBe(entering.checksumSha256);
    expect(moved.publicationId).toBe(entering.publicationId);
    expect(moved.generationId).toBe(entering.generationId);
    expect(moved.sourceSelectionSha256).toBe(entering.sourceSelectionSha256);
    expect(moved.queueEvidenceSha256).toBe(entering.queueEvidenceSha256);
    expect(moved.roster).toEqual(entering.roster);

    // Carried: refuses, because the CAS input no longer matches what is on
    // disk. This is the correct, required behaviour.
    await expect(coordinatorFor(home).enterMaintenance({
      publicationId: held.publicationId,
      generationId: held.generationId,
      sourceSelectionSha256: held.sourceSelectionSha256,
      queueEvidenceSha256: held.queueEvidenceSha256,
      roster: held.roster,
      expectedChecksumSha256: disposition.observedChecksumSha256,
    })).rejects.toMatchObject({ reason: "unexpected-state" });

    // Positive control confirming the journal is genuinely still at
    // maintenance-entering and untouched by the refused call above.
    expect(readBackendMaintenanceJournal(home)!.checksumSha256).toBe(moved.checksumSha256);

    // Re-read instead of carried: this is the defect the plan names. Using
    // a freshly re-read checksum as the CAS input always agrees with
    // whatever is currently on disk, so it wrongly succeeds even though the
    // state moved between observation and use.
    const reReadChecksum = readBackendMaintenanceJournal(home)!.checksumSha256;
    const recovered = await coordinatorFor(home).enterMaintenance({
      publicationId: held.publicationId,
      generationId: held.generationId,
      sourceSelectionSha256: held.sourceSelectionSha256,
      queueEvidenceSha256: held.queueEvidenceSha256,
      roster: held.roster,
      expectedChecksumSha256: reReadChecksum,
    });
    expect(recovered.phase).toBe("maintenance-held");
  });
});
