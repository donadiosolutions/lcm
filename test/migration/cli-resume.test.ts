import { afterEach, describe, expect, it, vi } from "vitest";
import { performMigrationResumeCommand, type MigrationResumeCommandOperations } from "../../src/migration/cli-resume.js";
import { admitExistingMigrationCommand } from "../../src/migration/cli-existing.js";
import { DEFAULT_MIGRATION_APPLY_MAX_BYTES, DEFAULT_MIGRATION_APPLY_MAX_RECORDS } from "../../src/migration/cli-apply.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { beginMigrationEffect, completeMigrationEffect, MigrationProtocolError } from "../../src/migration/protocol.js";
import { MachineIdentityFileError } from "../../src/machine-identity.js";
import { backendPublicationJournalPath, readBackendMaintenanceJournal } from "../../src/storage/backend-publication.js";
import { readFileSync } from "node:fs";
import {
  createFixtureManifest,
  FIXTURE_AT,
  FIXTURE_GENERATION,
  fixtureVerificationReport,
  heldFixtureJournal,
  makeFixtureHome,
  maintenanceCoordinator,
  persistFixtureReport,
  removeFixtureHomes,
  snapshotHome,
  type FixtureManifestOptions,
  type FixtureStage,
} from "./existing-fixtures.js";
import { performMigrationAbort } from "../../src/migration/abort.js";
import type { MigrationEffectKind } from "../../src/migration/protocol.js";

const roots: string[] = [];
afterEach(() => removeFixtureHomes(roots));

const complete = async () => ({ state: "complete" as const, witness: {} as never });
const resolution = { _operationsForTesting: { classifySnapshot: complete } };
const HASH = "a".repeat(64);
const SETTINGS = {
  url: "postgresql://user:password@db.example.com:5432/lcm", caFile: "/unused", migrationRole: "lcm_migrator",
  poolMax: 4, connectionTimeoutMs: 1000, idleTimeoutMs: 1000, statementTimeoutMs: 1000,
};
const CONFIG = { backend: "postgresql" as const, postgresql: SETTINGS };
const IDENTITY = {
  id: "remote-project-1", localProjectId: "local-1", canonical: "/tmp/project", remoteProjectId: "remote-project-1",
  machineId: "018f0b5d-1234-4abc-8def-1234567890ab", selectedPath: "/tmp/project",
};

/** Destination-side seams that resolve everything and let the test supply the cell's callee. */
function destinationOps(overrides: Partial<MigrationResumeCommandOperations> = {}): Partial<MigrationResumeCommandOperations> {
  return {
    resolveTargetConfig: () => ({ status: "resolved", config: CONFIG }),
    requireMachine: () => ({ machineId: IDENTITY.machineId }) as never,
    resolveIdentity: async () => ({ status: "resolved", expectedIdentity: IDENTITY }),
    ...overrides,
  };
}

/** A genesis dry-run that really begins (unless carried) and completes the verify-dry-run effect on the real manifest. */
function realisticGenesis(store: MigrationManifestStore): MigrationResumeCommandOperations["genesisDryRun"] {
  return async (input) => {
    let manifest = store.read(input.generationId);
    if (manifest.pendingEffect === null) {
      manifest = store.update(input.generationId, manifest.checksumSha256, (current) =>
        beginMigrationEffect(current, { kind: "verify-dry-run", effectId: "dry-run-effect", inputSha256: HASH, startedAt: FIXTURE_AT }));
    }
    const effectId = manifest.pendingEffect!.effectId;
    store.update(input.generationId, manifest.checksumSha256, (current) => completeMigrationEffect(current, {
      effectId, completedAt: FIXTURE_AT, report: { kind: "dry-run", reportId: effectId, reportSha256: HASH, createdAt: FIXTURE_AT },
    }));
    return { status: "ready" };
  };
}

async function held(stage: FixtureStage | null, options: { pending?: MigrationEffectKind; manifest?: FixtureManifestOptions } = {}) {
  const home = makeFixtureHome(roots);
  const journal = await heldFixtureJournal(home);
  const store = new MigrationManifestStore({ homeDir: home });
  if (stage !== null) createFixtureManifest(store, stage, { ...(options.pending === undefined ? {} : { pending: options.pending }), ...options.manifest });
  return { home, journal, store };
}

const run = (home: string, extra: Partial<Parameters<typeof performMigrationResumeCommand>[0]> = {}) =>
  performMigrationResumeCommand({
    cwd: "/tmp/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution, ...extra,
  });

describe("resume rows 19 and 20: genesis and the dry-run effect, stopping before the copy", () => {
  it("row 19 (planned, nothing pending) begins and completes the dry-run effect and reads dry-run-verified back", async () => {
    const { home, journal, store } = await held("planned");
    const genesisDryRun = vi.fn(realisticGenesis(store));
    const result = await run(home, { now: new Date(FIXTURE_AT), _operationsForTesting: destinationOps({ genesisDryRun, mintOwnerProcessId: () => "owner-1" }) });
    expect(result).toEqual({
      status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "dry-run-verified", applied: true, next: "resume", evidence: { cell: 19 },
    });
    const call = genesisDryRun.mock.calls[0]![0];
    expect(call).toMatchObject({
      generationId: FIXTURE_GENERATION, maintenanceChecksumSha256: journal.checksumSha256, expectedOwner: "lcm_migrator",
      expectedIdentity: IDENTITY, ownerProcessId: "owner-1",
      maxRecords: DEFAULT_MIGRATION_APPLY_MAX_RECORDS, maxBytes: DEFAULT_MIGRATION_APPLY_MAX_BYTES,
    });
    expect(call.carriedEffectId).toBeUndefined();
    expect(call.now).toEqual(new Date(FIXTURE_AT));
    expect(store.read(FIXTURE_GENERATION).pendingEffect).toBeNull();
  });

  it("row 20 (pending verify-dry-run) carries that effect id and completes only it", async () => {
    const { home, store } = await held("planned", { pending: "verify-dry-run" });
    const genesisDryRun = vi.fn(realisticGenesis(store));
    const result = await run(home, { maxRecords: 7, maxBytes: 99, _operationsForTesting: destinationOps({ genesisDryRun }) });
    expect(result).toMatchObject({ status: "ok", manifestPhase: "dry-run-verified", applied: true, evidence: { cell: 20 } });
    expect(genesisDryRun.mock.calls[0]![0]).toMatchObject({ carriedEffectId: "verify-dry-run-effect", maxRecords: 7, maxBytes: 99 });
  });

  it("uses a fresh owner process id by default", async () => {
    const { home, store } = await held("planned");
    const genesisDryRun = vi.fn(realisticGenesis(store));
    await run(home, { _operationsForTesting: destinationOps({ genesisDryRun }) });
    expect(genesisDryRun.mock.calls[0]![0].ownerProcessId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("a mismatched carried effect is passed through exit-5 style and nothing is marked applied", async () => {
    const { home } = await held("planned", { pending: "verify-dry-run" });
    const result = await run(home, {
      _operationsForTesting: destinationOps({ genesisDryRun: async () => ({ status: "refuse", reason: "genesis-dry-run-effect-mismatch" }) }),
    });
    expect(result).toEqual({ status: "refuse", reason: "genesis-dry-run-effect-mismatch", generationId: FIXTURE_GENERATION });
  });

  it("a refusal after the effect began reports applied and carries the evidence", async () => {
    const { home } = await held("planned");
    const result = await run(home, {
      _operationsForTesting: destinationOps({ genesisDryRun: async () => ({ status: "refuse", reason: "genesis-dry-run-complete-failed", evidence: "manifest-unexpected-state" }) }),
    });
    expect(result).toEqual({ status: "refuse", reason: "genesis-dry-run-complete-failed", evidence: "manifest-unexpected-state", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("refuses resume-readback-mismatch when the call claims success but the manifest did not advance", async () => {
    const { home } = await held("planned");
    const result = await run(home, { _operationsForTesting: destinationOps({ genesisDryRun: async () => ({ status: "ready" }) }) });
    expect(result).toEqual({ status: "refuse", reason: "resume-readback-mismatch", evidence: "manifest-planned", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("refuses manifest-unresolvable when the read-back itself cannot read the manifest", async () => {
    const { home, store } = await held("planned");
    let reads = 0;
    const flaky = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "read") return (id: string) => { reads += 1; if (reads > 1) throw new MigrationProtocolError("malformed-manifest", "x"); return target.read(id); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await run(home, { manifestStore: flaky, _operationsForTesting: destinationOps({ genesisDryRun: realisticGenesis(store) }) });
    expect(result).toEqual({ status: "refuse", reason: "manifest-unresolvable", evidence: "manifest-malformed-manifest", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("reports manifest-internal-error for an unrecognised read-back failure", async () => {
    const { home, store } = await held("planned");
    let reads = 0;
    const flaky = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "read") return (id: string) => { reads += 1; if (reads > 1) throw new Error("boom"); return target.read(id); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await run(home, { manifestStore: flaky, _operationsForTesting: destinationOps({ genesisDryRun: realisticGenesis(store) }) });
    expect(result).toMatchObject({ status: "refuse", reason: "manifest-unresolvable", evidence: "manifest-internal-error", applied: true });
  });
});

describe("resume with the real callees (no seam for the cell's own work)", () => {
  it("row 19 reaches the real genesis dry-run, which refuses capture-incomplete here because no snapshot was captured", async () => {
    const { home } = await held("planned");
    const result = await run(home, { _operationsForTesting: destinationOps() });
    expect(result).toEqual({ status: "refuse", reason: "capture-incomplete", evidence: "snapshot-absent", generationId: FIXTURE_GENERATION });
  });

  it("row 21 reaches the real copy, which cannot open a source that was never captured and reports only the error's name", async () => {
    const { home } = await held("dry-run-verified");
    const result = await run(home, { _operationsForTesting: destinationOps() });
    expect(result).toEqual({ status: "refuse", reason: "copy-failed", evidence: "MigrationCopyError", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("resolves the real target configuration, which refuses here because none is configured", async () => {
    const { home } = await held("planned");
    const result = await run(home);
    expect(result).toMatchObject({ status: "refuse", generationId: FIXTURE_GENERATION, reason: expect.stringMatching(/^migration-target-/u) });
  });
});

describe("resume row 21: the copy only, stopping at copied", () => {
  /** A copy that finishes a `copying` manifest: the complete-copy effect, as the real one ends. */
  function finishingCopy(store: MigrationManifestStore): MigrationResumeCommandOperations["copy"] {
    return (async (input: { generationId: string }) => {
      const manifest = store.read(input.generationId);
      const begun = store.update(input.generationId, manifest.checksumSha256, (current) =>
        beginMigrationEffect(current, { kind: "complete-copy", effectId: "complete-copy-effect", inputSha256: HASH, startedAt: FIXTURE_AT }));
      store.update(input.generationId, begun.checksumSha256, (current) => completeMigrationEffect(current, { effectId: "complete-copy-effect", completedAt: FIXTURE_AT }));
      return { phase: "copied" };
    }) as never;
  }

  it("calls runSqliteMigrationCopy with the held identity and reads copied back", async () => {
    const { home, store } = await held("copying");
    const copy = vi.fn(finishingCopy(store));
    const genesisDryRun = vi.fn();
    const result = await run(home, { _operationsForTesting: destinationOps({ copy, genesisDryRun, mintOwnerProcessId: () => "owner-2" }) });
    expect(result).toEqual({ status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "copied", applied: true, next: "report", evidence: { cell: 21 } });
    expect(copy.mock.calls[0]![0]).toMatchObject({
      generationId: FIXTURE_GENERATION, homeDir: home, settings: SETTINGS, expectedOwner: "lcm_migrator",
      expectedIdentity: IDENTITY, ownerProcessId: "owner-2",
    });
    expect(genesisDryRun).not.toHaveBeenCalled();
  });

  it("a copy that throws is copy-failed, applied, with only the error's name", async () => {
    const { home } = await held("dry-run-verified");
    const result = await run(home, { _operationsForTesting: destinationOps({ copy: (async () => { throw new TypeError("boom /a/path"); }) as never }) });
    expect(result).toEqual({ status: "refuse", reason: "copy-failed", evidence: "TypeError", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("a copy whose phase the manifest does not show is copy-failed with the readback evidence", async () => {
    const { home } = await held("dry-run-verified");
    const result = await run(home, { _operationsForTesting: destinationOps({ copy: (async () => ({ phase: "copied" })) as never }) });
    expect(result).toEqual({ status: "refuse", reason: "copy-failed", evidence: "manifest-readback-mismatch", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("a manifest that cannot be read back after the copy is manifest-unresolvable, applied", async () => {
    const { home, store } = await held("dry-run-verified");
    let reads = 0;
    const flaky = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "read") return (id: string) => { reads += 1; if (reads > 1) throw new MigrationProtocolError("malformed-manifest", "x"); return target.read(id); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await run(home, { manifestStore: flaky, _operationsForTesting: destinationOps({ copy: (async () => ({ phase: "copied" })) as never }) });
    expect(result).toMatchObject({ status: "refuse", reason: "manifest-unresolvable", applied: true });
  });
});

/** A crash after the abort effect began: the journal is aborted and the manifest carries the real pending abort. */
async function crashedAfterAbortBegan() {
  const fixture = await held("copied");
  await performMigrationAbort({
    homeDir: fixture.home, coordinator: maintenanceCoordinator(fixture.home), journal: fixture.journal,
    abortEvidenceSha256: "c".repeat(64), manifestStore: fixture.store, now: new Date(FIXTURE_AT),
    _operationsForTesting: { completeEffect: () => { throw new MigrationProtocolError("unexpected-state", "crash before completion"); } },
  });
  return fixture;
}

describe("resume rows 23 and 6: the cells that never reach the destination", () => {
  it("row 23 completes the pending verification from persisted evidence without resolving any target", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const report = fixtureVerificationReport();
    persistFixtureReport(home, report);
    const store = new MigrationManifestStore({ homeDir: home });
    createFixtureManifest(store, "copied", { pending: "verify-generation", report });
    const resolveTargetConfig = vi.fn();
    const result = await run(home, { _operationsForTesting: { resolveTargetConfig } });
    expect(result).toMatchObject({ status: "ok", manifestPhase: "verified", applied: true, evidence: { cell: 23, reportSha256: report.reportSha256 } });
    expect(resolveTargetConfig).not.toHaveBeenCalled();
    expect(store.read(FIXTURE_GENERATION).phase).toBe("verified");
  });

  it("row 6 completes the carried abort effect and never aborts the journal again", async () => {
    const { home } = await crashedAfterAbortBegan();
    const journalBefore = readFileSync(backendPublicationJournalPath(home));
    // A terminal journal does not identify a generation: it must be named. No
    // seam is injected: the real journal, snapshot classification and abort run.
    const result = await performMigrationResumeCommand({
      cwd: "/tmp/project", homeDir: home, generation: FIXTURE_GENERATION, confirmGenerationId: FIXTURE_GENERATION,
    });
    expect(result).toEqual({
      status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "aborted", applied: true, next: "apply",
      evidence: { cell: 6, journalPhase: "maintenance-aborted" },
    });
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-aborted");
  });

  it("row 6 passes the abort command's refusal through", async () => {
    const { home } = await held("planned");
    const result = await run(home, {
      _operationsForTesting: { admit: async (input) => {
        const admitted = await admitExistingMigrationCommand(input);
        if (admitted.status !== "admitted") return admitted;
        return { status: "admitted", context: { ...admitted.context, route: { ...admitted.context.route, row: 6 } } };
      }, abort: async () => ({ status: "refuse", reason: "abort-carried-effect-mismatch" }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-carried-effect-mismatch" });
  });
});

describe("resume rows 11 and 12 call the same callees as activate and rollback", () => {
  async function selectionPrepared() {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified");
    const resolutionAtRow11 = { _operationsForTesting: {
      classifySnapshot: complete,
      observeJournal: () => ({ kind: "hold" as const, journal: { phase: "selection-prepared", generationId: FIXTURE_GENERATION } as never }),
    } };
    return { home, resolutionAtRow11 };
  }

  async function rollingBack() {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const verified = createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified");
    const store = { probeManifestPresence: () => ({ status: "present" as const }), read: () => ({ ...verified, phase: "rolling-back" }) } as unknown as MigrationManifestStore;
    return { home, store };
  }

  it("row 11 runs the activate command with this command's token and the manifest's backend, and returns its outcome unchanged", async () => {
    const { home, resolutionAtRow11 } = await selectionPrepared();
    const outcome = {
      status: "ok" as const, generationId: FIXTURE_GENERATION, manifestPhase: "active", applied: true, next: "revoke-transfer-grants-then-start-daemon",
      evidence: { transferGrantRevocation: "required-before-daemon-start" }, restart: { answer: "satisfied" as const, presence: "absent" as const },
    };
    const activate = vi.fn(async () => outcome);
    const rollback = vi.fn();
    const result = await run(home, { _resolution: resolutionAtRow11, _operationsForTesting: { activate, rollback } as never });
    expect(result).toBe(outcome);
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/project", homeDir: home, generation: FIXTURE_GENERATION, confirmGenerationId: FIXTURE_GENERATION, confirmBackend: "postgresql",
      _resolution: resolutionAtRow11,
    }));
    expect(rollback).not.toHaveBeenCalled();
  });

  it("row 12 runs the rollback command with the manifest's source backend, and returns its refusal with its sections and restart", async () => {
    const { home, store } = await rollingBack();
    const refusal = {
      status: "refuse" as const, reason: "cutover-restart-required", generationId: FIXTURE_GENERATION, applied: true as const,
      sections: { selectedBackend: "sqlite" }, restart: { answer: "unsatisfied" as const, presence: "running" as const },
    };
    const rollback = vi.fn(async () => refusal);
    const activate = vi.fn();
    const result = await run(home, { manifestStore: store, _operationsForTesting: { activate, rollback } as never });
    expect(result).toBe(refusal);
    expect(rollback).toHaveBeenCalledWith(expect.objectContaining({
      homeDir: home, generation: FIXTURE_GENERATION, confirmGenerationId: FIXTURE_GENERATION, confirmBackend: "sqlite", manifestStore: store,
    }));
    expect(activate).not.toHaveBeenCalled();
  });

  it("passes no resolution seam to the callee when none was given (rows 11 and 12 on the real resolver)", async () => {
    const { home, store } = await rollingBack();
    const rollback = vi.fn(async () => ({ status: "refuse" as const, reason: "rollback-refused-evidence" }));
    await performMigrationResumeCommand({
      cwd: "/tmp/project", homeDir: home, generation: FIXTURE_GENERATION, confirmGenerationId: FIXTURE_GENERATION, manifestStore: store,
      _resolution: { _operationsForTesting: { classifySnapshot: complete } }, _operationsForTesting: { rollback } as never,
    });
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it("uses the real activate and rollback commands when none are injected (an empty home has no target, and no capture)", async () => {
    const { home, resolutionAtRow11 } = await selectionPrepared();
    expect(await run(home, { _resolution: resolutionAtRow11 })).toMatchObject({ status: "refuse", reason: "migration-target-missing", generationId: FIXTURE_GENERATION });
    const { home: home12, store } = await rollingBack();
    expect(await run(home12, { manifestStore: store })).toMatchObject({ status: "refuse", generationId: FIXTURE_GENERATION });
  });

  it("the fence comes first: a missing token refuses before either callee runs", async () => {
    const { home, resolutionAtRow11 } = await selectionPrepared();
    const activate = vi.fn();
    const result = await run(home, { confirmGenerationId: undefined, _resolution: resolutionAtRow11, _operationsForTesting: { activate } as never });
    expect(result).toEqual({ status: "refuse", reason: "existing-confirmation-missing", generationId: FIXTURE_GENERATION });
    expect(activate).not.toHaveBeenCalled();
  });

  it("--dry-run is route-only at both rows: neither callee runs, nothing is predicted, nothing is written", async () => {
    const { home, resolutionAtRow11 } = await selectionPrepared();
    const before = snapshotHome(home);
    const spies = { activate: vi.fn(), rollback: vi.fn() };
    const result = await run(home, { dryRun: true, _resolution: resolutionAtRow11, _operationsForTesting: spies as never });
    expect(result).toMatchObject({ status: "ok", applied: false, evidence: { cell: 11, primary: "activate", predictive: false, coordinationEffects: "none" } });
    expect(spies.activate).not.toHaveBeenCalled();
    expect(snapshotHome(home)).toEqual(before);
    const { home: home12, store } = await rollingBack();
    const twelve = await run(home12, { dryRun: true, manifestStore: store, _operationsForTesting: spies as never });
    expect(twelve).toMatchObject({ status: "ok", applied: false, evidence: { cell: 12, primary: "rollback" } });
    expect(spies.rollback).not.toHaveBeenCalled();
  });
});

describe("resume --dry-run is route-only", () => {
  it.each<[string, () => Promise<{ home: string }>]>([
    ["row 19", () => held("planned")],
    ["row 20", () => held("planned", { pending: "verify-dry-run" })],
    ["row 21", () => held("copying")],
    ["row 23", async () => {
      const report = fixtureVerificationReport();
      const fixture = await held("copied", { pending: "verify-generation", manifest: { report } });
      persistFixtureReport(fixture.home, report);
      return fixture;
    }],
    ["row 6", () => crashedAfterAbortBegan()],
  ])("%s calls nothing, takes no coordination effect, claims no prediction and writes nothing", async (label, build) => {
    const { home } = await build();
    const before = snapshotHome(home);
    const spies = { resolveTargetConfig: vi.fn(), genesisDryRun: vi.fn(), copy: vi.fn(), abort: vi.fn(), completePendingVerification: vi.fn() };
    const result = await run(home, { generation: FIXTURE_GENERATION, dryRun: true, _operationsForTesting: spies as never });
    expect(result).toMatchObject({ status: "ok", applied: false, evidence: { predictive: false, coordinationEffects: "none" } });
    expect(label).toBeTruthy();
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(snapshotHome(home)).toEqual(before);
  });
});

describe("resume admission, the fence and destination preconditions", () => {
  it("names the owner of a cell it does not own (copied: verify) and writes nothing", async () => {
    const { home } = await held("copied");
    const before = snapshotHome(home);
    const result = await run(home);
    expect(result).toEqual({ status: "refuse", reason: "route-not-owner", generationId: FIXTURE_GENERATION, next: "verify" });
    expect(snapshotHome(home)).toEqual(before);
  });

  it.each([
    ["a missing token", undefined, "existing-confirmation-missing"],
    ["a mismatched token", "generation-2", "existing-confirmation-moved"],
  ])("%s refuses exit 3, calls no callee and leaves the home byte-identical", async (_name, token, reason) => {
    const { home } = await held("planned");
    const before = snapshotHome(home);
    const spies = { resolveTargetConfig: vi.fn(), genesisDryRun: vi.fn() };
    const result = await performMigrationResumeCommand({
      cwd: "/tmp/project", homeDir: home, confirmGenerationId: token, _resolution: resolution, _operationsForTesting: spies as never,
    });
    expect(result).toEqual({ status: "refuse", reason, generationId: FIXTURE_GENERATION });
    expect(spies.resolveTargetConfig).not.toHaveBeenCalled();
    expect(spies.genesisDryRun).not.toHaveBeenCalled();
    expect(snapshotHome(home)).toEqual(before);
  });

  it("passes a resolver refusal through", async () => {
    const home = makeFixtureHome(roots);
    expect(await performMigrationResumeCommand({ cwd: "/tmp", homeDir: home })).toEqual({ status: "refuse", reason: "generation-required" });
  });

  it("resolves an explicit --generation", async () => {
    const { home } = await held("planned");
    const result = await run(home, { generation: FIXTURE_GENERATION, dryRun: true });
    expect(result).toMatchObject({ status: "ok", applied: false });
  });

  it("passes a target-configuration refusal through before touching anything", async () => {
    const { home } = await held("planned");
    const genesisDryRun = vi.fn();
    const result = await run(home, {
      _operationsForTesting: { resolveTargetConfig: () => ({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" }), genesisDryRun },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error", generationId: FIXTURE_GENERATION });
    expect(genesisDryRun).not.toHaveBeenCalled();
  });

  it("refuses an unregistered machine, and lets any other failure reach the boundary", async () => {
    const { home } = await held("planned");
    const unregistered = await run(home, { _operationsForTesting: destinationOps({ requireMachine: () => { throw new MachineIdentityFileError("missing"); } }) });
    expect(unregistered).toEqual({ status: "refuse", reason: "machine-identity-unregistered", generationId: FIXTURE_GENERATION });
    const unexpected = await run(home, { _operationsForTesting: destinationOps({ requireMachine: () => { throw new TypeError("boom"); } }) });
    expect(unexpected).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "TypeError", applied: true });
  });

  it("passes a held-identity refusal through with its evidence and never mints", async () => {
    const { home } = await held("planned");
    const genesisDryRun = vi.fn();
    const resolveIdentity = vi.fn(async () => ({ status: "refuse" as const, reason: "destination-project-absent" }));
    const absent = await run(home, { _operationsForTesting: destinationOps({ resolveIdentity, genesisDryRun }) });
    expect(absent).toEqual({ status: "refuse", reason: "destination-project-absent", generationId: FIXTURE_GENERATION });
    expect(resolveIdentity.mock.calls[0]![0].preflight.candidate.disposition).toBe("continue-held");
    const withEvidence = await run(home, {
      _operationsForTesting: destinationOps({ resolveIdentity: async () => ({ status: "refuse", reason: "local-identity-unresolvable", evidence: "Error" }), genesisDryRun }),
    });
    expect(withEvidence).toEqual({ status: "refuse", reason: "local-identity-unresolvable", evidence: "Error", generationId: FIXTURE_GENERATION });
    expect(genesisDryRun).not.toHaveBeenCalled();
  });

  it("fails loudly if the router ever admits a destination cell without a hold", async () => {
    const { home } = await held("planned");
    const result = await run(home, {
      _operationsForTesting: destinationOps({ admit: async (input) => {
        const admitted = await admitExistingMigrationCommand(input);
        if (admitted.status !== "admitted") return admitted;
        return { status: "admitted", context: { ...admitted.context, journal: { kind: "absent" } } };
      } }),
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "Error", applied: true });
  });
});

