import { afterEach, describe, expect, it, vi } from "vitest";
import { readBackendMaintenanceJournal } from "../../src/storage/backend-publication.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { readMigrationManifestRevision } from "../../src/migration/activate-generation.js";
import { rollbackCutoverSet } from "../../src/migration/cutover-set-rollback.js";
import { cleanupRoots } from "./cutover-set-activate-fixture.js";
import { expectRolledBack, rollbackFixture } from "./cutover-set-rollback-fixture.js";

vi.setConfig({ testTimeout: 120_000 });
afterEach(cleanupRoots);

describe("rollbackCutoverSet", () => {
  it("rolls an activated two-project set back into new SQLite generations through one reverse publication", async () => {
    const f = await rollbackFixture();
    const outcome = await f.run();
    expectRolledBack(f, outcome, "fresh");
    expect(f.deps.prepareCalls).toBe(1);
    expect(f.runtime.closes).toBe(1);
    expect(readBackendMaintenanceJournal(f.homeDir)).toBeNull();
    // The original activation witnesses no longer admit replay.
    for (const [index, member] of f.members.entries()) {
      const row = f.activation.deps;
      void row;
      const activationWitness = (await import("../../src/migration/cutover-set-activation-store.js")).readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.originalSetId });
      if (activationWitness.state !== "resolved" || activationWitness.selection === null) throw new Error("activation records missing");
      expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: member.generationId, evidenceSha256: activationWitness.selection.members[index]!.witnessChecksumSha256 }))
        .toThrow(expect.objectContaining({ reason: "unresolved-publication" }));
    }
    // A second call settles from durable state without a second publication.
    const again = await f.run();
    expectRolledBack(f, again, "settled");
    expect(f.deps.prepareCalls).toBe(1);
  });

  it("completes every member when the clock advances between the rollback report timestamp and the completion", async () => {
    const f = await rollbackFixture();
    let step = -1;
    const now = (): Date => new Date(Date.parse("2026-10-21T10:00:00.000Z") + ++step);
    const outcome = await rollbackCutoverSet({ ...f.input, now }, f.deps);
    expectRolledBack(f, outcome, "fresh");
    for (const member of f.members) {
      const head = f.activation.manifestStore.read(member.generationId);
      const predecessor = readMigrationManifestRevision({ homeDir: f.homeDir, generationId: member.generationId, revision: head.revision - 1, checksumSha256: head.previousManifestSha256! });
      expect(predecessor.pendingEffect?.kind).toBe("publish-rollback");
      const createdAt = Date.parse(head.reports.filter((report) => report.kind === "rollback").at(-1)!.createdAt);
      expect(Date.parse(predecessor.pendingEffect!.startedAt)).toBeLessThanOrEqual(createdAt);
      expect(createdAt).toBeLessThanOrEqual(Date.parse(head.updatedAt));
    }
  });
});

