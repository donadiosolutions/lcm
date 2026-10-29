import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import {
  migrationActivationEvidenceDirectory,
  readMigrationActivationEvidence,
  recordMigrationActivationWitness,
} from "../../src/migration/activation-evidence-store.js";
import { canonicalJson } from "../../src/storage/portable-record.js";
import { driftCanonicalDelta, fixtureRollbackWitness } from "../fixtures/migration-activation-records.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import type { CutoverSetRollbackDependencies, CutoverSetRollbackResumePoint } from "../../src/migration/cutover-set-rollback.js";
import { MACHINE, cleanupRoots, type FixtureMember } from "./cutover-set-activate-fixture.js";
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

/**
 * #1808. A set rollback interrupted inside one member's rollback witness write leaves only the writer scratch of that
 * witness in the member's activation evidence store. The retry finishes exactly that write (inside the set's own
 * append barrier, before the strict member authority read) when the store proves it, for a member that is not already
 * at a pending publish-rollback or under a frozen selection; any other leftover is refused as before.
 */
describe("rollbackCutoverSet interrupted inside a member's rollback witness write (#1808)", () => {
  const evidenceDirectory = (f: RollbackFixture, member: FixtureMember): string => migrationActivationEvidenceDirectory(f.homeDir, member.generationId);
  const wire = (member: FixtureMember, record: unknown): string => canonicalJson({ version: 1, generationId: member.generationId, record }) + "\n";
  const entries = (f: RollbackFixture, member: FixtureMember): string[] => readdirSync(evidenceDirectory(f, member)).sort();
  const scratchesOf = (f: RollbackFixture, member: FixtureMember): string[] => entries(f, member).filter((name) => name.endsWith(".tmp"));
  const plant = (f: RollbackFixture, member: FixtureMember, witness: { checksumSha256: string }, content = wire(member, witness)): string => {
    const path = join(evidenceDirectory(f, member), ".witness-" + witness.checksumSha256 + ".json.0123abcd.tmp");
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  };
  /** A canonical rollback witness of the member's activation, reproducible from its stored epoch and attempt. */
  function storedWitness(f: RollbackFixture, member: FixtureMember, mode: "pre-write" | "post-write" = "pre-write") {
    const stored = readMigrationActivationEvidence({ homeDir: f.homeDir, generationId: member.generationId });
    if (stored.state !== "resolved") throw new Error("expected resolved evidence");
    const epoch = stored.epochs[0]!;
    const attempt = stored.attempts[0]!;
    return fixtureRollbackWitness(mode === "pre-write"
      ? { epoch, attempt, postEpochDelta: attempt.canonicalDeltaBaseline, postEpochCensus: epoch.censusVector, rollbackMode: mode }
      : { epoch, attempt, postEpochDelta: driftCanonicalDelta(attempt.canonicalDeltaBaseline, 1), postEpochCensus: null, rollbackMode: mode });
  }
  /** A witness recorder that stops inside the write of one member, leaving the (optionally mutated) scratch of the witness it was writing. */
  const interruptedAt = (f: RollbackFixture, member: FixtureMember, mutate: (content: string) => string = (content) => content): Partial<CutoverSetRollbackDependencies> => ({
    recordActivationWitness: (input) => {
      if (input.generationId !== member.generationId) return recordMigrationActivationWitness(input);
      plant(f, member, input.witness, mutate(wire(member, input.witness)));
      throw new Error("crash inside the witness write");
    },
  });
  const interruptedRun = async (f: RollbackFixture, member: FixtureMember, mutate?: (content: string) => string): Promise<string> => {
    await expect(f.run(interruptedAt(f, member, mutate))).rejects.toThrow("crash inside the witness write");
    expectNotMixed(f);
    expect(scratchesOf(f, member)).toHaveLength(1);
    return join(evidenceDirectory(f, member), scratchesOf(f, member)[0]!);
  };
  /** Everything a refused recovery must leave as it found it. */
  const snapshot = (f: RollbackFixture, scratch: string) => ({
    manifests: f.members.map((member) => JSON.stringify(f.activation.manifestStore.read(member.generationId))),
    records: JSON.stringify(readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId })),
    maintenance: JSON.stringify(readBackendMaintenanceJournal(f.homeDir)),
    evidence: f.members.map((member) => entries(f, member)),
    scratch: readFileSync(scratch, "utf8"),
  });

  it("finishes a witness write interrupted under the held journal: the retry resumes from held and completes the set", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    const scratch = await interruptedRun(f, a!);
    expect(readBackendMaintenanceJournal(f.homeDir)).toMatchObject({ phase: "maintenance-held" });
    expect(readMigrationActivationEvidence({ homeDir: f.homeDir, generationId: a!.generationId })).toMatchObject({ state: "unresolvable" });

    const outcome = await f.run();

    expectRolledBack(f, outcome, "held");
    expect(existsSync(scratch)).toBe(false);
    expect(readMigrationActivationEvidence({ homeDir: f.homeDir, generationId: a!.generationId })).toMatchObject({ state: "resolved" });
    expect(f.deps.prepareCalls).toBe(1);
  });

  it("finishes the witness scratch of the second member the same way", async () => {
    const f = await rollbackFixture();
    const scratch = await interruptedRun(f, f.members[1]!);

    expectRolledBack(f, await f.run(), "held");
    expect(existsSync(scratch)).toBe(false);
  });

  it("initial entry: a canonical rollback witness scratch left before the set rollback begins is finished at the pre-hold read", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    const scratch = plant(f, a!, storedWitness(f, a!));
    expect(readMigrationActivationEvidence({ homeDir: f.homeDir, generationId: a!.generationId })).toMatchObject({ state: "unresolvable" });

    expectRolledBack(f, await f.run(), "fresh");

    expect(existsSync(scratch)).toBe(false);
  });

  it("a scratch it cannot prove is refused at the pre-hold read, with the checkpoint, journals and records untouched", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    const witness = storedWitness(f, a!);
    const scratch = plant(f, a!, witness, wire(a!, witness) + " ");
    const before = snapshot(f, scratch);

    const outcome = await f.run();

    expect(outcome).toMatchObject({ status: "refused", step: "members", reason: "member-evidence-missing" });
    expect(snapshot(f, scratch)).toEqual(before);
    expect(readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId }).state).toBe("authoritatively-absent");
  });

  it("a scratch it cannot prove is refused on a held retry as an interruption, keeping the checkpoint and the scratch", async () => {
    const f = await rollbackFixture();
    const scratch = await interruptedRun(f, f.members[0]!, (content) => content + " ");
    const before = snapshot(f, scratch);

    const outcome = await f.run();

    expect(outcome).toMatchObject({ status: "interrupted", step: "members", cause: "state-unresolvable", detail: expect.stringContaining("member-evidence-missing") });
    expect(snapshot(f, scratch)).toEqual(before);
    expect(readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId }).state).toBe("resolved");
  });

  it("a member with a pending publish-rollback stays strict under the held journal: a qualifying extra scratch is not published", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    await crashAt(f, "after-publish-begin:" + a!.generationId);
    expect(f.activation.manifestStore.read(a!.generationId).pendingEffect).toMatchObject({ kind: "publish-rollback" });
    const extra = storedWitness(f, a!, "post-write");
    const scratch = plant(f, a!, extra);
    const before = snapshot(f, scratch);

    const outcome = await f.run();

    expect(outcome).toMatchObject({ status: "interrupted", step: "members", cause: "state-unresolvable", detail: expect.stringContaining("member-evidence-missing") });
    expect(snapshot(f, scratch)).toEqual(before);
    expect(entries(f, a!)).not.toContain("witness-" + extra.checksumSha256 + ".json");
  });

  it("a member under the frozen selection stays strict: a qualifying extra scratch is not published", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    await crashAt(f, "after-selection-frozen");
    const scratch = plant(f, a!, storedWitness(f, a!, "post-write"));
    const before = snapshot(f, scratch);

    const outcome = await f.run();

    expect(outcome).toMatchObject({ status: "interrupted", step: "members", cause: "state-unresolvable", detail: expect.stringContaining("member-evidence-missing") });
    expect(snapshot(f, scratch)).toEqual(before);
  });

  it("a pending member stays strict with its stored evidence while another member's interrupted witness write is finished", async () => {
    const f = await rollbackFixture();
    const [a, b] = f.members;
    await crashAt(f, "after-publish-begin:" + a!.generationId);
    const scratch = await interruptedRun(f, b!);

    expectRolledBack(f, await f.run(), "held");

    expect(existsSync(scratch)).toBe(false);
    expect(f.deps.prepareCalls).toBe(1);
  });
});

