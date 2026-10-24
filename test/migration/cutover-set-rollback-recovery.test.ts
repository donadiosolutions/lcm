import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lcmHomeDir } from "../../src/runtime-paths.js";
import {
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  type BackendPublicationObserver,
} from "../../src/storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../../src/storage/backend-publication-driver.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../src/storage/postgresql/publication-remote-guard.js";
import { readCutoverSetRollbackRecords } from "../../src/migration/cutover-set-rollback-store.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import type { CutoverSetRollbackDependencies, CutoverSetRollbackResumePoint } from "../../src/migration/cutover-set-rollback.js";
import { MACHINE, cleanupRoots } from "./cutover-set-activate-fixture.js";
import { expectNotMixed, expectRolledBack, rollbackFixture, type RollbackFixture } from "./cutover-set-rollback-fixture.js";

/**
 * The crash/resume matrix (#1550 D8): after a crash at every durable
 * boundary of the set rollback the effective home is complete-PostgreSQL,
 * complete-SQLite or explicitly unresolved (never mixed), no member replays
 * meanwhile, and the next call resumes from durable state to rolled-back
 * without a second artifact, checkpoint, selection or publication.
 */

vi.setConfig({ testTimeout: 180_000 });
afterEach(cleanupRoots);

type Expectation = Readonly<{
  resumedFrom: CutoverSetRollbackResumePoint;
  /** The effective home right after the crash. */
  home: "postgresql" | "sqlite" | "unresolved";
  hold?: "held" | "selection-prepared" | "selection-completed" | "none";
  checkpoint?: boolean;
  pendingActivation?: readonly number[];
}>;

async function crashAt(f: RollbackFixture, point: string, overrides: Partial<CutoverSetRollbackDependencies> = {}): Promise<void> {
  await expect(f.run({ ...overrides, crashPoint: (p) => { if (p === point) throw new Error("crash at " + point); } })).rejects.toThrow("crash at " + point);
  expectNotMixed(f);
}

function effective(f: RollbackFixture): "postgresql" | "sqlite" | "unresolved" {
  const config = JSON.parse(readFileSync(join(lcmHomeDir(f.homeDir), "config.json"), "utf8")) as { storage: { backend: string } };
  const v2 = readBackendMaintenanceJournal(f.homeDir) === null ? readBackendPublicationJournal(f.homeDir) : null;
  if (v2 !== null && v2.phase !== "completed" && v2.phase !== "aborted") return "unresolved";
  return config.storage.backend === "sqlite" ? "sqlite" : "postgresql";
}

function expectNoReplay(f: RollbackFixture): void {
  const records = readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId });
  for (const [index, member] of f.members.entries()) {
    const witnesses = [f.activation.deps.identity.sealedWitnessSha256];
    if (records.state === "resolved" && records.selection !== null) witnesses.push(records.selection.members[index]!.witnessChecksumSha256);
    for (const witness of witnesses) {
      expect(() => assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: member.generationId, evidenceSha256: witness }))
        .toThrow(expect.objectContaining({ name: "BackendPublicationJournalError" }));
    }
  }
}

describe("rollbackCutoverSet crash matrix", () => {
  const points: ReadonlyArray<readonly [string, Expectation]> = [
    ["after-settle-report:A", { resumedFrom: "fresh", home: "postgresql", hold: "none", checkpoint: false, pendingActivation: [0, 1] }],
    ["after-settle-complete:A", { resumedFrom: "fresh", home: "postgresql", hold: "none", checkpoint: false, pendingActivation: [0, 1] }],
    ["after-settle-complete:B", { resumedFrom: "fresh", home: "postgresql", hold: "none", checkpoint: false, pendingActivation: [1] }],
    ["after-artifact", { resumedFrom: "fresh", home: "postgresql", hold: "none", checkpoint: false }],
    ["after-checkpoint", { resumedFrom: "before-hold", home: "postgresql", hold: "none", checkpoint: true }],
    ["after-hold", { resumedFrom: "held", home: "postgresql", hold: "held", checkpoint: true }],
    ["after-bind:A", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-bind:B", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-classify", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-prepare-begin:A", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-prepare-complete:A", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-prepare-complete:B", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-build:A", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-build:B", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-witness:A", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-publish-begin:A", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-publish-begin:B", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-install:A", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-sidecars:A", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-install-record:A", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-install-record:B", { resumedFrom: "held", home: "postgresql", hold: "held" }],
    ["after-selection-frozen", { resumedFrom: "selection-frozen", home: "postgresql", hold: "held" }],
    ["after-selection-prepared", { resumedFrom: "selection-prepared", home: "postgresql", hold: "selection-prepared" }],
    ["after-selection-completed", { resumedFrom: "selection-completed", home: "postgresql", hold: "selection-completed" }],
    ["after-selection-binding:A", { resumedFrom: "selection-completed", home: "postgresql", hold: "selection-completed" }],
    ["after-prepare", { resumedFrom: "publication-journal", home: "unresolved", hold: "none" }],
    ["after-drive", { resumedFrom: "publication-journal", home: "sqlite", hold: "none" }],
    ["after-report:A", { resumedFrom: "publication-journal", home: "sqlite", hold: "none" }],
    ["after-complete:A", { resumedFrom: "publication-journal", home: "sqlite", hold: "none" }],
    ["after-report:B", { resumedFrom: "publication-journal", home: "sqlite", hold: "none" }],
  ];

  for (const [name, expectation] of points) {
    it("resumes to rolled-back after a crash " + name, async () => {
      const f = await rollbackFixture({ pendingActivation: expectation.pendingActivation });
      const point = name.replace(/:A$/u, ":" + f.members[0]!.generationId).replace(/:B$/u, ":" + f.members[1]!.generationId);
      await crashAt(f, point);
      expect(effective(f)).toBe(expectation.home);
      if (expectation.hold !== undefined) {
        const v3 = readBackendMaintenanceJournal(f.homeDir);
        if (expectation.hold === "none") expect(v3).toBeNull();
        else expect(v3).toMatchObject({ phase: expectation.hold === "held" ? "maintenance-held" : expectation.hold, generationId: f.setId, sourceBackend: "postgresql" });
      }
      if (expectation.checkpoint !== undefined) {
        const records = readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId });
        expect(records.state).toBe(expectation.checkpoint ? "resolved" : "authoritatively-absent");
      }
      if (expectation.home !== "sqlite") expectNoReplay(f);
      const outcome = await f.run();
      expectRolledBack(f, outcome, expectation.resumedFrom);
      expect(f.deps.prepareCalls).toBe(1);
      // Every original canonical database is preserved exactly once, read-only, beside its installed candidate.
      const records = readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId });
      if (records.state !== "resolved") throw new Error("records missing");
      for (const member of f.members) {
        const install = records.installs.get(member.generationId)!;
        expect(install.preemption!.beforeSha256).toBe(install.preemption!.afterSha256);
      }
      // Idempotent: a third call settles from durable state.
      expectRolledBack(f, await f.run(), "settled");
      expect(f.deps.prepareCalls).toBe(1);
    });
  }

  it("resumes the reverse publication after the coordinator crashed with the map published and the config not", async () => {
    const f = await rollbackFixture();
    let crashed = false;
    const crashingCoordinator: CutoverSetRollbackDependencies["createCoordinator"] = ({ homeDir, guard, machineId }) => {
      const observer: BackendPublicationObserver = (event) => {
        if (crashed || event !== "after-journal-write") return;
        if (readBackendPublicationJournal(homeDir)?.phase === "map-published") { crashed = true; throw new Error("crash at map-published"); }
      };
      return createBackendPublicationCoordinator({
        homeDir, observer, remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId, ttlMs: 60_000 }) },
      });
    };
    await expect(f.run({ createCoordinator: crashingCoordinator })).rejects.toThrow("crash at map-published");
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("map-published");
    expect(effective(f)).toBe("unresolved");
    expectNoReplay(f);
    expect(MACHINE).toBe(f.activation.manifest.machineId);
    const outcome = await f.run();
    expectRolledBack(f, outcome, "publication-journal");
  });

  it("settles from member evidence once a later hold replaced the completed reverse journal, and never republishes a mixed set", async () => {
    const later = (f: RollbackFixture) => f.activation.coordinator().enterMaintenance({
      publicationId: "later-generation", generationId: "later-generation", sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "b".repeat(64) }], now: new Date("2026-10-22T00:00:00.000Z"),
    });
    const done = await rollbackFixture();
    expectRolledBack(done, await done.run(), "fresh");
    await later(done);
    expect(readBackendMaintenanceJournal(done.homeDir)).toMatchObject({ phase: "maintenance-held", generationId: "later-generation" });
    const settled = await done.run();
    expect(settled, JSON.stringify(settled)).toMatchObject({ status: "rolled-back", resumedFrom: "settled" });
    expect(done.deps.prepareCalls).toBe(1);
    // A rolled-back A beside a pending B under a foreign hold is interrupted, never republished.
    const f = await rollbackFixture();
    await crashAt(f, "after-complete:" + f.members[0]!.generationId);
    await later(f);
    const outcome = await f.run();
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "interrupted", step: "completion", cause: "state-unresolvable", detail: expect.stringContaining(f.members[1]!.generationId + " is not rolled back"),
    });
    expect(f.deps.prepareCalls).toBe(1);
  });
});

