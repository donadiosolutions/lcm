import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { readCutoverSetActivationRecords } from "../../src/migration/cutover-set-activation-store.js";
import { cleanupRoots, fixture } from "./cutover-set-activate-fixture.js";

/**
 * The replay admission compares a member's stored activation report to the
 * aggregate selection. The report store is create-only and the manifest
 * chain immutable, so a report that disagrees with the aggregate can only be
 * produced by tampering; the reader is mocked here to return one.
 */
const tamper = vi.hoisted(() => ({ epochId: null as string | null }));
vi.mock("../../src/migration/activation-report.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/migration/activation-report.js")>();
  return {
    ...actual,
    readMigrationActivationReport: (input: Parameters<typeof actual.readMigrationActivationReport>[0]) => {
      const read = actual.readMigrationActivationReport(input);
      if (tamper.epochId === null || read.state !== "resolved") return read;
      return { ...read, report: { ...read.report, body: { ...read.report.body, epochId: tamper.epochId } } };
    },
  };
});

afterEach(() => { tamper.epochId = null; cleanupRoots(); });

describe("set replay admission with a report that does not restate the aggregate", () => {
  it("refuses the member once the slot no longer holds the set's completed publication", async () => {
    const f = await fixture();
    expect((await f.run()).status).toBe("activated");
    const records = readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId });
    if (records.state !== "resolved" || records.selection === null) throw new Error("unreachable");
    const row = records.selection.members[0]!;
    await f.coordinator().enterMaintenance({
      publicationId: "migration-generation-9", generationId: "generation-9", sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "a".repeat(64),
      roster: [{ machineId: f.manifest.machineId, queueCutoff: null, evidenceSha256: "a".repeat(64) }], sourceBackend: "postgresql",
    });
    expect(assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
      .toEqual({ backend: "postgresql", disposition: "selected" });
    tamper.epochId = "f".repeat(64);
    expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
      .toThrow(expect.objectContaining({ reason: "unresolved-publication", message: expect.stringContaining("does not name this set publication") }));
  });
});

