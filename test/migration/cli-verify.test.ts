import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { performMigrationVerifyCommand, type MigrationVerifyCommandOperations } from "../../src/migration/cli-verify.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import { migrationWitnessSha256 } from "../../src/migration/activation-witness.js";
import { migrationCopyTargetGeneration } from "../../src/migration/copy-source.js";
import { MigrationProjectMapWitnessError } from "../../src/migration/project-map-witness.js";
import { MIGRATION_MISMATCH_CLASSES } from "../../src/migration/verification-report.js";
import { MigrationVerificationReportStore } from "../../src/migration/verification-store.js";
import { migrationVerificationEffectId } from "../../src/migration/verify-generation.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { beginMigrationEffect, completeMigrationEffect, MigrationProtocolError } from "../../src/migration/protocol.js";
import { MigrationVerificationStoreError } from "../../src/migration/verification-store.js";
import { completePendingMigrationVerification, MigrationVerificationDriverError } from "../../src/migration/verify-generation.js";
import { admitExistingMigrationCommand } from "../../src/migration/cli-existing.js";
import {
  createFixtureManifest,
  FIXTURE_GENERATION,
  fixtureVerificationReport,
  heldFixtureJournal,
  makeFixtureHome,
  persistFixtureReport,
  removeFixtureHomes,
  snapshotHome,
} from "./existing-fixtures.js";

const roots: string[] = [];
afterEach(() => removeFixtureHomes(roots));

const complete = async () => ({ state: "complete" as const, witness: {} as never });
const resolution = { _operationsForTesting: { classifySnapshot: complete } };

/** A held journal plus a manifest pending verify-generation over a persisted, eligible report. */
async function pendingVerification(overrides: { destinationIdentitySha256?: string; destinationSystemIdentifier?: string | null; pendingEffectId?: string } = {}) {
  const home = makeFixtureHome(roots);
  await heldFixtureJournal(home);
  const report = fixtureVerificationReport();
  persistFixtureReport(home, report);
  createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied", { pending: "verify-generation", report, ...overrides });
  return { home, report };
}

describe("verify row 23: completes the pending verify-generation effect from persisted evidence alone", () => {
  it("completes with no destination, project map, lease or identity at all, and reads the result back before exiting 0", async () => {
    const { home, report } = await pendingVerification();
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
    });
    expect(result).toEqual({
      status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "verified", applied: true, next: "activate",
      evidence: {
        reportId: report.reportId, reportSha256: report.reportSha256, activationEligible: true,
        cell: 23, coordinationEffects: "none",
      },
    });
    const manifest = new MigrationManifestStore({ homeDir: home }).read(FIXTURE_GENERATION);
    expect(manifest.phase).toBe("verified");
    expect(manifest.pendingEffect).toBeNull();
    expect(manifest.reports.find((entry) => entry.kind === "verification")?.reportSha256).toBe(report.reportSha256);
  });

  it("a second run lands on the verified cell and confirms from persisted evidence without writing", async () => {
    const { home, report } = await pendingVerification();
    await performMigrationVerifyCommand({ cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    const before = snapshotHome(home);
    const second = await performMigrationVerifyCommand({ cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(second).toMatchObject({
      status: "ok", manifestPhase: "verified", applied: false,
      evidence: { reportSha256: report.reportSha256, activationEligible: true, cell: 24 },
    });
    expect(snapshotHome(home)).toEqual(before);
  });

  it("a corrupted pending effect id refuses report-identity-conflict (exit 5) and writes nothing", async () => {
    // The pending effect carries an id that does not name the persisted report.
    const { home } = await pendingVerification({ pendingEffectId: "verify-generation-" + "0".repeat(64) });
    const before = snapshotHome(home);
    const result = await performMigrationVerifyCommand({ cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-report-identity-conflict", generationId: FIXTURE_GENERATION });
    expect(snapshotHome(home)).toEqual(before);
  });

  it("a manifest whose sealed destination differs from the persisted report's refuses verify-destination-drift and writes nothing", async () => {
    const { home } = await pendingVerification({ destinationIdentitySha256: "9".repeat(64) });
    const before = snapshotHome(home);
    const result = await performMigrationVerifyCommand({ cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-destination-drift", generationId: FIXTURE_GENERATION });
    expect(snapshotHome(home)).toEqual(before);
  });

  it("a manifest that never recorded the destination system identifier refuses verify-destination-drift", async () => {
    const { home } = await pendingVerification({ destinationSystemIdentifier: null });
    const result = await performMigrationVerifyCommand({ cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-destination-drift", generationId: FIXTURE_GENERATION });
  });

  it("a persisted report that was never activation-eligible refuses report-identity-conflict", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const dirty = fixtureVerificationReport(FIXTURE_GENERATION, {
      mismatches: [{ domain: "messages", class: "count", identitySha256: "a".repeat(64) }],
      mismatchTotals: [{ domain: "messages", class: "count", count: 1 }],
    });
    persistFixtureReport(home, dirty);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied", { pending: "verify-generation", report: dirty });
    const result = await performMigrationVerifyCommand({ cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-report-identity-conflict", generationId: FIXTURE_GENERATION });
  });

  it("a missing persisted report is unresolvable evidence (exit 5), never a recomputation", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const report = fixtureVerificationReport();
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied", { pending: "verify-generation", report });
    const result = await performMigrationVerifyCommand({ cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-report-unresolvable", evidence: "report-absent", generationId: FIXTURE_GENERATION });
  });

  it("--dry-run is route-only: it reports the pending effect, predicts nothing, and writes nothing", async () => {
    const { home } = await pendingVerification();
    const before = snapshotHome(home);
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, dryRun: true, _resolution: resolution,
    });
    expect(result).toEqual({
      status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "copied", applied: false, next: "verify (drop --dry-run to complete)",
      evidence: { cell: 23, predictive: false, pendingEffect: "verify-generation", coordinationEffects: "none" },
    });
    expect(snapshotHome(home)).toEqual(before);
  });
});

describe("verify row 24: an idempotent confirmation from persisted evidence", () => {
  async function verified() {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const report = fixtureVerificationReport();
    persistFixtureReport(home, report);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified", { report });
    return { home, report };
  }

  it("confirms the verified generation, writes nothing, and ignores --dry-run as the same read-only answer", async () => {
    const { home, report } = await verified();
    const before = snapshotHome(home);
    for (const dryRun of [false, true]) {
      const result = await performMigrationVerifyCommand({
        cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, dryRun, _resolution: resolution,
      });
      expect(result).toEqual({
        status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "verified", applied: false, next: "activate",
        evidence: { reportId: report.reportId, reportSha256: report.reportSha256, activationEligible: true, cell: 24, coordinationEffects: "none" },
      });
    }
    expect(snapshotHome(home)).toEqual(before);
  });

  it("refuses verify-report-unresolvable when the persisted report the manifest names is gone", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified", { report: fixtureVerificationReport() });
    const result = await performMigrationVerifyCommand({ cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toMatchObject({ status: "refuse", reason: "verify-report-unresolvable", evidence: "report-absent" });
  });

  it("refuses verify-readback-mismatch when the manifest names a report that is not activation-eligible", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const dirty = fixtureVerificationReport(FIXTURE_GENERATION, {
      mismatches: [{ domain: "messages", class: "count", identitySha256: "a".repeat(64) }],
      mismatchTotals: [{ domain: "messages", class: "count", count: 1 }],
    });
    persistFixtureReport(home, dirty);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified", { report: dirty });
    const result = await performMigrationVerifyCommand({ cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-readback-mismatch", evidence: "report-not-eligible", generationId: FIXTURE_GENERATION });
  });
});

describe("verify row 22: the fresh computation (plan-v4 section 5), every input read from an existing source", () => {
  const H = (c: string): string => c.repeat(64);
  const IDENTITY = {
    id: "0190aaaa-0000-7000-8000-000000000001", remoteProjectId: "0190aaaa-0000-7000-8000-000000000001",
    localProjectId: H("a"), machineId: "m-1", canonical: "/work/project", selectedPath: "/work/project",
  };
  const SETTINGS = { url: "postgresql://t", caFile: "/ca.pem", poolMax: 1, connectionTimeoutMs: 1, idleTimeoutMs: 1, statementTimeoutMs: 1, snapshotIdleTimeoutMs: 1 };
  const RECEIPT = {
    version: 1, projectId: "p", machineId: "m-1", epochId: "e", firstMachineSequence: "1", epochChecksumSha256: H("1"),
    receiptSchemaSha256: H("2"), receiptSetSha256: H("3"), queueCutoff: "0000000000000000007", queueSetSha256: H("4"),
    sourceArtifactSha256: H("5"), maintenanceChecksumSha256: H("6"),
  };

  async function copied(options: Parameters<typeof createFixtureManifest>[2] = {}) {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const manifest = createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied", options);
    return { home, manifest };
  }

  /** Stands in for the driver's persist, begin and complete, with the real stores. */
  function fakeVerify(home: string, report = fixtureVerificationReport()) {
    return vi.fn(async (_input: unknown) => {
      const store = new MigrationManifestStore({ homeDir: home });
      new MigrationVerificationReportStore({ homeDir: home }).persist(FIXTURE_GENERATION, report);
      const effectId = migrationVerificationEffectId(report.reportSha256);
      const begun = store.update(FIXTURE_GENERATION, store.read(FIXTURE_GENERATION).checksumSha256, (current) =>
        beginMigrationEffect(current, { kind: "verify-generation", effectId, inputSha256: report.reportSha256, startedAt: "2026-08-12T12:00:00.000Z" }));
      store.update(FIXTURE_GENERATION, begun.checksumSha256, (current) => completeMigrationEffect(current, {
        effectId, completedAt: "2026-08-12T12:00:00.000Z", activationEligible: true,
        report: { kind: "verification", reportId: report.reportId, reportSha256: report.reportSha256, createdAt: "2026-08-12T12:00:00.000Z" },
      }));
      return { report, outcome: "clean" as const, effectId, inputSha256: report.reportSha256 };
    });
  }

  function ops(overrides: Partial<MigrationVerifyCommandOperations> = {}): Partial<MigrationVerifyCommandOperations> {
    return {
      resolveDestination: async () => ({ status: "resolved", settings: SETTINGS, expectedOwner: "lcm_migration", expectedIdentity: IDENTITY }),
      inspectSnapshot: async () => ({ receiptReference: RECEIPT }) as never,
      computeProjectMapWitness: () => H("f"),
      mintOwnerProcessId: () => "owner-process",
      ...overrides,
    };
  }

  const run = (home: string, extra: Partial<Parameters<typeof performMigrationVerifyCommand>[0]> = {}) =>
    performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution, ...extra,
    });

  it("passes the driver every input from its source, runs it, reads the verified manifest back, and exits 0", async () => {
    const { home, manifest } = await copied();
    const verify = fakeVerify(home);
    const witness = vi.fn(() => H("f"));
    let scratch = "";
    const result = await run(home, {
      _operationsForTesting: ops({
        verify: async (input) => { scratch = input.scratchParent; expect(existsSync(scratch)).toBe(true); return verify(input); },
        computeProjectMapWitness: witness,
      }),
    });
    expect(result).toMatchObject({
      status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "verified", applied: true, next: "activate",
      evidence: { cell: 22, activationEligible: true, coordinationEffects: "verification-lease,source-append-barrier" },
    });
    expect(existsSync(scratch)).toBe(false);
    // Read under the source append barrier's token, as the activation reads the same witness.
    expect(witness).toHaveBeenCalledWith({
      homeDir: home, localProjectId: IDENTITY.localProjectId, remoteProjectId: IDENTITY.remoteProjectId, mode: "pre-publication",
      publicationLockToken: expect.anything(),
    });
    expect(verify.mock.calls[0]![0]).toEqual({
      generationId: FIXTURE_GENERATION,
      targetGenerationId: migrationCopyTargetGeneration(FIXTURE_GENERATION),
      homeDir: home,
      expectedIdentity: IDENTITY,
      destinationSettings: SETTINGS,
      expectedOwner: "lcm_migration",
      ownerProcessId: "owner-process",
      scratchParent: scratch,
      leaseTtlMs: 300_000,
      manifestRevision: manifest.revision,
      manifestChecksumSha256: manifest.checksumSha256,
      destinationMigrationsSha256: manifest.destination.schemaSha256,
      expectedDestinationIdentitySha256: manifest.destination.identitySha256,
      expectedSystemIdentifier: "712345",
      projectMapWitnessSha256: H("f"),
      // The five-field projection of the thirteen-field receipt reference.
      queueClassificationWitness: {
        version: 1, queueCutoff: RECEIPT.queueCutoff, queueSetSha256: RECEIPT.queueSetSha256,
        receiptSetSha256: RECEIPT.receiptSetSha256, epochChecksumSha256: RECEIPT.epochChecksumSha256,
      },
      sampleParameters: {
        version: 1, strideOrdinal: 1, sampleCount: 0,
        seedBasisSha256: migrationWitnessSha256(["lcm-migration-verify-seed-v1", FIXTURE_GENERATION, manifest.destination.identitySha256]),
      },
    });
  });

  it("honours --lease-ttl-ms and mints a fresh owner process id when none is injected", async () => {
    const { home } = await copied();
    const verify = fakeVerify(home);
    await run(home, { leaseTtlMs: 1234, _operationsForTesting: ops({ verify, mintOwnerProcessId: undefined }) });
    const input = verify.mock.calls[0]![0] as { leaseTtlMs: number; ownerProcessId: string };
    expect(input.leaseTtlMs).toBe(1234);
    expect(input.ownerProcessId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("--dry-run runs the read-only computation, persists nothing, and reports the would-be outcome with the R5 effects", async () => {
    const { home } = await copied();
    const before = snapshotHome(home);
    const verify = vi.fn();
    const inspect = vi.fn(async () => fixtureVerificationReport());
    const result = await run(home, { dryRun: true, _operationsForTesting: ops({ verify, inspect }) });
    expect(result).toMatchObject({
      status: "ok", manifestPhase: "copied", applied: false,
      evidence: { cell: 22, wouldBe: "clean", activationEligible: true, coordinationEffects: "verification-lease,source-append-barrier" },
    });
    expect(verify).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(snapshotHome(home)).toEqual(before);
  });

  it.each([
    ["mismatches", { mismatches: [{ domain: "messages", class: "count", identitySha256: H("a") }], mismatchTotals: [{ domain: "messages", class: "count", count: 1 }] }],
    ["coverage-incomplete", { classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass, index) => ({ class: mismatchClass, ran: index !== 0 })) }],
  ])("a non-eligible report (%s) refuses verify-not-eligible: applied on a real run (the report is kept), not applied on --dry-run", async (evidence, overrides) => {
    const { home } = await copied();
    const report = fixtureVerificationReport(FIXTURE_GENERATION, overrides as never);
    const real = await run(home, { _operationsForTesting: ops({ verify: async () => ({ report, outcome: "mismatches", effectId: "e", inputSha256: report.reportSha256 }) as never }) });
    expect(real).toEqual({ status: "refuse", reason: "verify-not-eligible", generationId: FIXTURE_GENERATION, evidence, applied: true });
    const dry = await run(home, { dryRun: true, _operationsForTesting: ops({ inspect: async () => report }) });
    expect(dry).toEqual({ status: "refuse", reason: "verify-not-eligible", generationId: FIXTURE_GENERATION, evidence });
  });

  it("refuses verify-readback-mismatch (applied) when the call claims success but the manifest still reads copied", async () => {
    const { home } = await copied();
    const report = fixtureVerificationReport();
    const result = await run(home, { _operationsForTesting: ops({ verify: async () => ({ report, outcome: "clean", effectId: "e", inputSha256: report.reportSha256 }) }) });
    expect(result).toEqual({ status: "refuse", reason: "verify-readback-mismatch", evidence: "manifest-copied", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("refuses verify-destination-drift for a manifest that never recorded the cluster identifier, before touching anything", async () => {
    const { home } = await copied({ destinationSystemIdentifier: null });
    const resolveDestination = vi.fn();
    const result = await run(home, { _operationsForTesting: ops({ resolveDestination }) });
    expect(result).toEqual({ status: "refuse", reason: "verify-destination-drift", generationId: FIXTURE_GENERATION, evidence: "system-identifier-absent" });
    expect(resolveDestination).not.toHaveBeenCalled();
  });

  it("passes a destination refusal through with its evidence, and writes nothing", async () => {
    const { home } = await copied();
    const before = snapshotHome(home);
    const result = await run(home, {
      _operationsForTesting: ops({ resolveDestination: async () => ({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" }) }),
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error", generationId: FIXTURE_GENERATION });
    expect(snapshotHome(home)).toEqual(before);
  });

  it("refuses verify-invalid-input if a resolved identity somehow lacks its project ids", async () => {
    const { home } = await copied();
    const result = await run(home, {
      _operationsForTesting: ops({ resolveDestination: async () => ({ status: "resolved", settings: SETTINGS, expectedOwner: "o", expectedIdentity: { ...IDENTITY, localProjectId: undefined } }) }),
    });
    expect(result).toEqual({ status: "refuse", reason: "verify-invalid-input", generationId: FIXTURE_GENERATION, evidence: "identity-incomplete" });
  });

  it("refuses snapshot-unresolvable when the authenticated snapshot cannot be read", async () => {
    const { home } = await copied();
    const result = await run(home, { _operationsForTesting: ops({ inspectSnapshot: async () => { throw new Error("tampered /secret/path"); } }) });
    expect(result).toEqual({ status: "refuse", reason: "snapshot-unresolvable", generationId: FIXTURE_GENERATION });
  });

  it.each([
    ["project-map-drift", "verify-project-map-drift"],
    ["project-map-unresolvable", "verify-project-map-unresolvable"],
    ["invalid-input", "verify-invalid-input"],
  ] as const)("maps the project-map witness failure %s to %s", async (witnessReason, reason) => {
    const { home } = await copied();
    const result = await run(home, {
      _operationsForTesting: ops({ computeProjectMapWitness: () => { throw new MigrationProjectMapWitnessError(witnessReason, "x"); } }),
    });
    expect(result).toEqual({ status: "refuse", reason, generationId: FIXTURE_GENERATION });
  });

  it("a contended source append barrier while reading the witness is verify-contention (exit 4)", async () => {
    const { home } = await copied();
    const result = await run(home, { _operationsForTesting: ops({ computeProjectMapWitness: () => { throw new PrivateMutationLockContentionError("busy"); } }) });
    expect(result).toEqual({ status: "refuse", reason: "verify-contention", generationId: FIXTURE_GENERATION });
  });

  it("lets an unrecognised witness failure reach the boundary", async () => {
    const { home } = await copied();
    const result = await run(home, { _operationsForTesting: ops({ computeProjectMapWitness: () => { throw new TypeError("boom"); } }) });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "TypeError", applied: true });
  });

  describe("typed failures of the computation map to the closed table (and the scratch directory is always removed)", () => {
    const cases: ReadonlyArray<readonly [string, () => Error, string, string | undefined, boolean]> = [
      ["the lease is held elsewhere", () => new MigrationVerificationDriverError("lease-unavailable", "x"), "verify-contention", undefined, false],
      ["the lease was lost", () => new MigrationVerificationDriverError("lease-lost", "x"), "verify-contention", undefined, false],
      ["the source append barrier is contended", () => new PrivateMutationLockContentionError("busy"), "verify-contention", undefined, false],
      ["the destination drifted", () => new MigrationVerificationDriverError("destination-drift", "x"), "verify-destination-drift", undefined, false],
      ["the driver reports an invalid input", () => new MigrationVerificationDriverError("invalid-input", "x"), "verify-invalid-input", undefined, false],
      ["a report conflicts", () => new MigrationVerificationDriverError("report-identity-conflict", "x"), "verify-report-identity-conflict", undefined, true],
      ["the manifest store fails", () => new MigrationProtocolError("checksum-mismatch", "x"), "manifest-unresolvable", "manifest-checksum-mismatch", true],
      ["the report store fails", () => new MigrationVerificationStoreError("malformed-record", "x"), "verify-report-unresolvable", "report-malformed-record", true],
    ];
    it.each(cases)("%s", async (_name, make, reason, evidence, applied) => {
      const { home } = await copied();
      let scratch = "";
      const failing = async (input: { scratchParent: string }): Promise<never> => { scratch = input.scratchParent; throw make(); };
      const real = await run(home, { _operationsForTesting: ops({ verify: failing as never }) });
      expect(real).toEqual({
        status: "refuse", reason, generationId: FIXTURE_GENERATION,
        ...(evidence === undefined ? {} : { evidence }), ...(applied ? { applied: true } : {}),
      });
      expect(existsSync(scratch)).toBe(false);
      // The dry run persists nothing, so it never claims a write.
      const dry = await run(home, { dryRun: true, _operationsForTesting: ops({ inspect: failing as never }) });
      expect(dry).toEqual({ status: "refuse", reason, generationId: FIXTURE_GENERATION, ...(evidence === undefined ? {} : { evidence }) });
      expect(existsSync(scratch)).toBe(false);
    });

    it("an unrecognised failure reaches the boundary on both the real and the dry-run path", async () => {
      const { home } = await copied();
      const boom = async (): Promise<never> => { throw new RangeError("boom"); };
      expect(await run(home, { _operationsForTesting: ops({ verify: boom }) }))
        .toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "RangeError", applied: true });
      expect(await run(home, { dryRun: true, _operationsForTesting: ops({ inspect: boom }) }))
        .toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "RangeError", applied: true });
    });
  });

  it("uses the real resolvers when none are injected: each unmet source refuses in its own closed reason", async () => {
    const { home } = await copied();
    // No config at all: the real destination resolution refuses before anything else is read.
    expect(await run(home)).toMatchObject({ status: "refuse", reason: "migration-target-missing", generationId: FIXTURE_GENERATION });
    // The real snapshot reader finds no captured snapshot in this home.
    expect(await run(home, { _operationsForTesting: { resolveDestination: ops().resolveDestination! } }))
      .toEqual({ status: "refuse", reason: "snapshot-unresolvable", generationId: FIXTURE_GENERATION });
    // The real witness, read under the barrier token, finds no project-map entry for the local project.
    expect(await run(home, { _operationsForTesting: { resolveDestination: ops().resolveDestination!, inspectSnapshot: ops().inspectSnapshot! } }))
      .toEqual({ status: "refuse", reason: "verify-project-map-drift", generationId: FIXTURE_GENERATION });
  });

  it("calls the real driver entry points when none are injected (they refuse here: no PostgreSQL, no snapshot)", async () => {
    const { home } = await copied();
    const base = ops();
    const real = { resolveDestination: base.resolveDestination!, inspectSnapshot: base.inspectSnapshot!, computeProjectMapWitness: base.computeProjectMapWitness! };
    const dry = await run(home, { dryRun: true, _operationsForTesting: real });
    expect(dry.status).toBe("refuse");
    const wet = await run(home, { _operationsForTesting: real });
    expect(wet.status).toBe("refuse");
  });

  it("a missing or mismatched --confirm-generation refuses at the fence before any destination work", async () => {
    const { home } = await copied();
    const resolveDestination = vi.fn();
    const result = await run(home, { confirmGenerationId: undefined, _operationsForTesting: ops({ resolveDestination }) });
    expect(result).toEqual({ status: "refuse", reason: "existing-confirmation-missing", generationId: FIXTURE_GENERATION });
    expect(resolveDestination).not.toHaveBeenCalled();
  });
});

describe("verify admission and the fence", () => {
  it("names the owner of a cell it does not own (exit 2) and writes nothing", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "planned");
    const before = snapshotHome(home);
    const result = await performMigrationVerifyCommand({ cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "route-not-owner", generationId: FIXTURE_GENERATION, next: "resume" });
    expect(snapshotHome(home)).toEqual(before);
  });

  it.each([
    ["a missing token", undefined, "existing-confirmation-missing"],
    ["a mismatched token", "generation-2", "existing-confirmation-moved"],
  ])("%s refuses at the fence (exit 3), never reaches the completion, and leaves the home byte-identical", async (_name, token, reason) => {
    const { home } = await pendingVerification();
    const before = snapshotHome(home);
    const completePending = vi.fn();
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: token, _resolution: resolution, _operationsForTesting: { completePending },
    });
    expect(result).toEqual({ status: "refuse", reason, generationId: FIXTURE_GENERATION });
    expect(completePending).not.toHaveBeenCalled();
    expect(snapshotHome(home)).toEqual(before);
  });

  it("passes a resolver refusal through unchanged (no live hold and no --generation)", async () => {
    const home = makeFixtureHome(roots);
    const result = await performMigrationVerifyCommand({ cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION });
    expect(result).toEqual({ status: "refuse", reason: "generation-required" });
  });

  it("resolves an explicit --generation", async () => {
    const { home } = await pendingVerification();
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, generation: FIXTURE_GENERATION, confirmGenerationId: FIXTURE_GENERATION, dryRun: true, _resolution: resolution,
    });
    expect(result).toMatchObject({ status: "ok", applied: false });
  });

  it("fails loudly, never guessing, if the router ever admits verify at a cell it does not handle", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "planned");
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION,
      _operationsForTesting: {
        admit: async (input) => {
          const admitted = await admitExistingMigrationCommand({ ...input, command: "resume", resolution: { ...input.resolution, ...resolution } });
          return admitted;
        },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "Error", applied: true });
  });
});

describe("verify error mapping and the read-back", () => {
  async function ready() {
    return pendingVerification();
  }

  it("refuses verify-readback-mismatch (applied) when the call claims success but the manifest does not read back verified", async () => {
    const { home, report } = await ready();
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { completePending: () => ({ report, outcome: "clean", effectId: "e", inputSha256: report.reportSha256 }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "verify-readback-mismatch", evidence: "manifest-copied", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("refuses verify-readback-mismatch when the verified manifest names a different report than the call returned", async () => {
    const { home } = await ready();
    const other = fixtureVerificationReport(FIXTURE_GENERATION, { manifestRevision: 9 });
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      // Complete for real, then claim a different report was the result.
      _operationsForTesting: {
        completePending: (input) => ({ ...completePendingMigrationVerification(input)!, report: other }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "verify-readback-mismatch", evidence: "report-reference-mismatch", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("refuses verify-readback-mismatch (pending-effect-moved, nothing applied) when the driver finds nothing pending", async () => {
    const { home } = await ready();
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { completePending: () => null },
    });
    expect(result).toEqual({ status: "refuse", reason: "verify-readback-mismatch", evidence: "pending-effect-moved", generationId: FIXTURE_GENERATION });
  });

  it.each([
    ["a protocol failure", new MigrationProtocolError("unexpected-state", "x"), "manifest-unresolvable", "manifest-unexpected-state"],
    ["a report-store failure", new MigrationVerificationStoreError("malformed-record", "x"), "verify-report-unresolvable", "report-malformed-record"],
  ])("maps %s to its closed refusal", async (_name, failure, reason, evidence) => {
    const { home } = await ready();
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { completePending: () => { throw failure; } },
    });
    expect(result).toEqual({ status: "refuse", reason, evidence, generationId: FIXTURE_GENERATION });
  });

  it.each(["report-identity-conflict", "destination-drift", "invalid-input"] as const)("maps the driver's %s to its closed verify refusal", async (driverReason) => {
    const { home } = await ready();
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { completePending: () => { throw new MigrationVerificationDriverError(driverReason, "x"); } },
    });
    expect(result).toEqual({ status: "refuse", reason: `verify-${driverReason}`, generationId: FIXTURE_GENERATION });
  });

  it("maps a driver reason this build cannot produce to the boundary's unexpected-failure rather than inventing a class", async () => {
    const { home } = await ready();
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { completePending: () => { throw new MigrationVerificationDriverError("lease-lost", "x"); } },
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "MigrationVerificationDriverError", applied: true });
  });

  it("lets an unrecognised failure while reading the evidence back reach the boundary, reporting applied", async () => {
    const { home, report } = await ready();
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      reportStore: { read: () => { throw new TypeError("boom"); } } as never,
      _operationsForTesting: { completePending: (input) => completePendingMigrationVerification(input) ?? { report } as never },
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "TypeError", applied: true });
  });

  it("maps a protocol or store failure while reading the evidence back to its closed refusal", async () => {
    const { home, report } = await ready();
    const result = await performMigrationVerifyCommand({
      cwd: "/work/project", homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      // The resolver reads the manifest once; every later read (the read-back) fails.
      manifestStore: (() => {
        const real = new MigrationManifestStore({ homeDir: home });
        let reads = 0;
        return new Proxy(real, {
          get(target, property, receiver) {
            if (property === "read") {
              return (generationId: string) => {
                reads += 1;
                if (reads > 1) throw new MigrationProtocolError("malformed-manifest", "x");
                return target.read(generationId);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        });
      })(),
      _operationsForTesting: { completePending: () => ({ report, outcome: "clean", effectId: "e", inputSha256: report.reportSha256 }) },
    });
    expect(result).toMatchObject({ status: "refuse", reason: "manifest-unresolvable", evidence: "manifest-malformed-manifest", applied: true });
  });
});

