import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyEnteringRecoveryFailure,
  classifyHoldEntryFailure,
  hasMigrationQueueEvidenceRebindOccurred,
  migrationEntryRoster,
  migrationQueueEvidenceSentinel,
} from "../../src/migration/hold-entry.js";
import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  rebindBackendMaintenanceCutoff,
  withBackendPublicationAppendBarrierAsync,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";

const roots: string[] = [];
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-hold-entry-"));
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

describe("migrationQueueEvidenceSentinel and migrationEntryRoster", () => {
  it("is deterministic and changes independently with generationId or sourceSelectionSha256", () => {
    const base = { generationId: "generation-1", sourceSelectionSha256: "a".repeat(64) };
    expect(migrationQueueEvidenceSentinel(base)).toBe(migrationQueueEvidenceSentinel({ ...base }));
    expect(migrationQueueEvidenceSentinel({ ...base, generationId: "generation-2" }))
      .not.toBe(migrationQueueEvidenceSentinel(base));
    expect(migrationQueueEvidenceSentinel({ ...base, sourceSelectionSha256: "b".repeat(64) }))
      .not.toBe(migrationQueueEvidenceSentinel(base));
  });

  it("builds a single-entry roster with queueCutoff constructed null", () => {
    const roster = migrationEntryRoster({ machineId: MACHINE_ID, sentinelEvidenceSha256: "a".repeat(64) });
    expect(roster).toEqual([{ machineId: MACHINE_ID, queueCutoff: null, evidenceSha256: "a".repeat(64) }]);
  });
});

describe("the section 9 sentinel/queueCutoff operative test, against a real hold and a real rebind", () => {
  it("holds the sentinel and null queueCutoff before capture, and both move together after a real rebind (red: proven below by breaking each side independently)", async () => {
    const home = makeHome();
    const generationId = "generation-1";
    const sourceSelectionSha256 = "a".repeat(64);
    const sentinel = migrationQueueEvidenceSentinel({ generationId, sourceSelectionSha256 });
    const roster = migrationEntryRoster({ machineId: MACHINE_ID, sentinelEvidenceSha256: sentinel });

    const held = await coordinatorFor(home).enterMaintenance({
      publicationId: "maintenance-publication",
      generationId,
      sourceSelectionSha256,
      queueEvidenceSha256: sentinel,
      roster,
    });
    expect(held.phase).toBe("maintenance-held");
    expect(held.queueEvidenceSha256).toBe(sentinel);
    expect(held.roster[0]!.queueCutoff).toBeNull();
    expect(hasMigrationQueueEvidenceRebindOccurred({ journal: held, sentinel })).toBe(false);

    const rebound = await withBackendPublicationAppendBarrierAsync(home, async (token) =>
      rebindBackendMaintenanceCutoff({
        homeDir: home,
        expectedChecksumSha256: held.checksumSha256,
        generationId,
        sourceSelectionSha256,
        queueEvidenceSha256: "c".repeat(64),
        roster: [{ machineId: MACHINE_ID, queueCutoff: "0000000000000000123", evidenceSha256: "c".repeat(64) }],
      }, token));
    expect(rebound.queueEvidenceSha256).not.toBe(sentinel);
    expect(rebound.roster[0]!.queueCutoff).not.toBeNull();
    expect(hasMigrationQueueEvidenceRebindOccurred({ journal: rebound, sentinel })).toBe(true);
  });

  it("does not report a rebind when only the digest side moved (red: a check that ORs the two sides instead of ANDing them would report true here)", async () => {
    const home = makeHome();
    const generationId = "generation-1";
    const sourceSelectionSha256 = "a".repeat(64);
    const sentinel = migrationQueueEvidenceSentinel({ generationId, sourceSelectionSha256 });
    const roster = migrationEntryRoster({ machineId: MACHINE_ID, sentinelEvidenceSha256: sentinel });
    const held = await coordinatorFor(home).enterMaintenance({
      publicationId: "maintenance-publication",
      generationId,
      sourceSelectionSha256,
      queueEvidenceSha256: sentinel,
      roster,
    });
    const digestOnlyMoved: BackendMaintenanceJournal = {
      ...held,
      queueEvidenceSha256: "d".repeat(64),
    };
    expect(digestOnlyMoved.roster[0]!.queueCutoff).toBeNull();
    expect(hasMigrationQueueEvidenceRebindOccurred({ journal: digestOnlyMoved, sentinel })).toBe(false);
  });

  it("does not report a rebind when only the queueCutoff side moved", async () => {
    const home = makeHome();
    const generationId = "generation-1";
    const sourceSelectionSha256 = "a".repeat(64);
    const sentinel = migrationQueueEvidenceSentinel({ generationId, sourceSelectionSha256 });
    const roster = migrationEntryRoster({ machineId: MACHINE_ID, sentinelEvidenceSha256: sentinel });
    const held = await coordinatorFor(home).enterMaintenance({
      publicationId: "maintenance-publication",
      generationId,
      sourceSelectionSha256,
      queueEvidenceSha256: sentinel,
      roster,
    });
    const cutoffOnlyMoved: BackendMaintenanceJournal = {
      ...held,
      roster: [{ ...held.roster[0]!, queueCutoff: "0000000000000000123" }],
    };
    expect(cutoffOnlyMoved.queueEvidenceSha256).toBe(sentinel);
    expect(hasMigrationQueueEvidenceRebindOccurred({ journal: cutoffOnlyMoved, sentinel })).toBe(false);
  });

  it("does not report a rebind when the roster has grown past one entry", async () => {
    const home = makeHome();
    const generationId = "generation-1";
    const sourceSelectionSha256 = "a".repeat(64);
    const sentinel = migrationQueueEvidenceSentinel({ generationId, sourceSelectionSha256 });
    const roster = migrationEntryRoster({ machineId: MACHINE_ID, sentinelEvidenceSha256: sentinel });
    const held = await coordinatorFor(home).enterMaintenance({
      publicationId: "maintenance-publication",
      generationId,
      sourceSelectionSha256,
      queueEvidenceSha256: sentinel,
      roster,
    });
    const multiRoster: BackendMaintenanceJournal = {
      ...held,
      queueEvidenceSha256: "d".repeat(64),
      roster: [
        { ...held.roster[0]!, queueCutoff: "0000000000000000123" },
        { machineId: "018f0b5d-9999-4abc-8def-1234567890ab", queueCutoff: "0000000000000000123", evidenceSha256: "d".repeat(64) },
      ],
    };
    expect(hasMigrationQueueEvidenceRebindOccurred({ journal: multiRoster, sentinel })).toBe(false);
  });
});

describe("classifyEnteringRecoveryFailure (owner-requested: classify by reason, never by throw-or-not)", () => {
  it("classifies a genuine precondition mismatch (unexpected-state) as precondition, and nothing else as precondition (red: collapsing every reason to one class would pass this test for the wrong reason)", () => {
    const mismatch = new BackendPublicationJournalError("unexpected-state", "entering recovery does not match");
    expect(classifyEnteringRecoveryFailure(mismatch)).toEqual({
      status: "refuse", class: "precondition", evidence: "journal-unexpected-state",
    });
  });

  it("classifies lock contention as contention, distinctly from precondition and evidence", () => {
    const contention = new PrivateMutationLockContentionError("locked");
    expect(classifyEnteringRecoveryFailure(contention)).toEqual({
      status: "refuse", class: "contention", evidence: "lock-contention",
    });
  });

  it.each([
    "invalid-input",
    "unsafe-storage",
    "malformed-journal",
    "checksum-mismatch",
    "unresolved-publication",
    "publication-evidence-missing",
    "permit-mismatch",
    "backend-mismatch",
  ] as const)("classifies %s as unresolvable evidence, never as a precondition match (an unclassifiable reason must not become a conclusion)", (reason) => {
    const error = new BackendPublicationJournalError(reason, "injected");
    expect(classifyEnteringRecoveryFailure(error)).toEqual({
      status: "refuse", class: "evidence", evidence: `journal-${reason}`,
    });
  });

  it("classifies an unrecognised (non-BackendPublicationJournalError, non-contention) failure shape as internal-error evidence rather than as a precondition match", () => {
    expect(classifyEnteringRecoveryFailure(new Error("something else entirely"))).toEqual({
      status: "refuse", class: "evidence", evidence: "journal-internal-error",
    });
  });
});

describe("classifyHoldEntryFailure (round-1 B-5/A-11: the fresh hold entry is classified by reason)", () => {
  it("classifies lock contention as contention", () => {
    expect(classifyHoldEntryFailure(new PrivateMutationLockContentionError("held"))).toEqual({ class: "contention", evidence: "lock-contention" });
  });

  it("classifies unresolved-publication as an occupied slot, distinct from contention (a v2 publication is not ours to abort)", () => {
    expect(classifyHoldEntryFailure(new BackendPublicationJournalError("unresolved-publication", "x")))
      .toEqual({ class: "slot-occupied", evidence: "journal-unresolved-publication" });
  });

  it("classifies unexpected-state as a precondition, and nothing else as one", () => {
    expect(classifyHoldEntryFailure(new BackendPublicationJournalError("unexpected-state", "x")))
      .toEqual({ class: "precondition", evidence: "journal-unexpected-state" });
  });

  it.each(["unsafe-storage", "malformed-journal", "checksum-mismatch", "publication-evidence-missing", "invalid-input"] as const)(
    "classifies %s as unresolvable evidence",
    (reason) => {
      expect(classifyHoldEntryFailure(new BackendPublicationJournalError(reason, "x")))
        .toEqual({ class: "evidence", evidence: `journal-${reason}` });
    },
  );

  it("classifies an unrecognised failure shape as internal-error evidence", () => {
    expect(classifyHoldEntryFailure(new Error("boom"))).toEqual({ class: "evidence", evidence: "journal-internal-error" });
    expect(classifyHoldEntryFailure("not even an error")).toEqual({ class: "evidence", evidence: "journal-internal-error" });
  });
});
