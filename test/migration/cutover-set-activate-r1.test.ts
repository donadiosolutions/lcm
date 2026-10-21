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
import { migrationActivationReportDirectory } from "../../src/migration/activation-report.js";
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
