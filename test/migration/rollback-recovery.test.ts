/**
 * #626 F11: a rollback whose maintenance selection was already attempted recovers through the REAL fenced-session
 * opener and the REAL recovery admission (no stand-in for either), over the real coordinator, journals and
 * stores. Only the PostgreSQL row (a stateful lease stand-in with the guard's own acquire semantics) and the
 * census reads are faked; the first-open quiescence is a stand-in only for the first attempt, which the strict
 * checkActivationWriterQuiescence legitimately handles elsewhere.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { openSqlitePortableSource, sqlitePortableFileSha256 } from "../../src/storage/sqlite/portable-source.js";
import {
  BackendPublicationCoordinator,
  backendPublicationCanonicalSha256,
  backendPublicationDirectory,
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationLockToken,
  type BackendPublicationPhase,
} from "../../src/storage/backend-publication.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../src/storage/postgresql/publication-remote-guard.js";
import { createBackendPublicationDriver } from "../../src/storage/backend-publication-driver.js";
import { PostgreSqlBackendPublicationGuardError } from "../../src/storage/postgresql/publication-guard.js";
import { PORTABLE_RECORD_DOMAIN_ORDER, canonicalJson, canonicalSha256 } from "../../src/storage/portable-record.js";
import type { ActivationLeasePublicationGuard } from "../../src/migration/activation-lease.js";
import { checkActivationWriterQuiescence } from "../../src/migration/activation-quiescence.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  type MigrationManifest,
} from "../../src/migration/protocol.js";
import {
  migrationActivationEvidenceDirectory,
  readMigrationActivationEvidence,
  recordMigrationActivationAttempt,
  recordMigrationActivationEpoch,
  recordMigrationActivationWitness,
} from "../../src/migration/activation-evidence-store.js";
import {
  recordMigrationSelectionBinding,
  recordMigrationWitnessBinding,
  resolveMigrationWitnessBindings,
} from "../../src/migration/generation-binding-store.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import {
  deriveRollbackAuthorityArtifactId,
  deriveRollbackPublicationId,
  readOwnPublicationSourceFromMaterial,
  readProjectMapForRollback,
  readRollbackAuthorityArtifact,
  runMigrationRollback,
  writeRollbackAuthorityArtifact,
  type RunMigrationRollbackDependencies,
  type RunMigrationRollbackInput,
} from "../../src/migration/rollback.js";
import { DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES, resolveMigrationRollbackContext } from "../../src/migration/rollback-inputs.js";
import {
  DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
  checkRollbackRecoveryAdmission,
  openRollbackFencedSession,
  type RollbackSessionDependencies,
  type RollbackSessionTarget,
} from "../../src/migration/rollback-session.js";
import { buildMigrationCanonicalDelta, buildMigrationCensusVector } from "../../src/migration/verify-generation.js";
import {
  FIXTURE_LOCAL_PROJECT_ID as LOCAL,
  FIXTURE_REMOTE_PROJECT_ID as REMOTE,
  activationPublicationMaterial,
  publicationMaterial,
  rollbackFixtureCoordinator,
  rollbackPublicationMaterial,
  workingPublicationDriver,
} from "../fixtures/backend-publication-driver.js";
import {
  driftCanonicalDelta,
  fixtureActivationScenario,
  fixtureDestinationIdentity,
  fixtureRollbackWitness,
} from "../fixtures/migration-activation-records.js";

const GEN = "gen-recovery";
// UUIDv7: the production remote-guard provider (shared-lease tests below) normalizes the machine id as one.
const MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";
const OTHER_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ff";
const capturedAt = "2026-09-06T00:00:00.000Z";
const PUBLICATION_ID = deriveRollbackPublicationId(GEN);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-recovery-"));
  mkdirSync(join(dir, ".lcm"), { mode: 0o700 });
  dirs.push(dir);
  return dir;
}

type LeaseRow = {
  projectId: string; machineId: string; publicationId: string; targetBackend: "sqlite"; evidenceSha256: string;
  fencingToken: bigint; acquiredAt: string; renewedAt: string; expiresAt: string; releasedAt: string | null; databaseExpired: boolean;
};

/**
 * The lcm.fenced_leases row with the real guard's acquire semantics (publication-guard.ts acquire): an unreleased
 * row of another tuple is a publication-conflict; an unreleased row of the same tuple is returned as it is, unless
 * the database expired it (fence-expired without a token, taken over by compare-and-swap on expectedFencingToken);
 * a released row is replaced by a fresh fencing token, and a token against a released row is a fence-mismatch.
 */
function leaseStandIn() {
  const state: { row: LeaseRow | null } = { row: null };
  const calls: string[] = [];
  let nextToken = 1n;
  const guard = {
    async acquire(
      input: Omit<LeaseRow, "fencingToken" | "acquiredAt" | "renewedAt" | "expiresAt" | "releasedAt" | "databaseExpired"> & {
        expectedFencingToken?: bigint;
      },
    ) {
      calls.push("acquire");
      const failure = (reason: "publication-conflict" | "fence-expired" | "fence-mismatch") =>
        new PostgreSqlBackendPublicationGuardError(input.projectId, "acquireBackendPublication", reason);
      const current = state.row;
      if (current !== null && current.releasedAt === null) {
        if (
          current.machineId !== input.machineId || current.publicationId !== input.publicationId
          || current.targetBackend !== input.targetBackend || current.evidenceSha256 !== input.evidenceSha256
        ) throw failure("publication-conflict");
        if (input.expectedFencingToken !== undefined && current.fencingToken !== input.expectedFencingToken) throw failure("fence-mismatch");
        if (!current.databaseExpired) return current;
        if (input.expectedFencingToken === undefined) throw failure("fence-expired");
      } else if (current !== null && input.expectedFencingToken !== undefined) {
        throw failure("fence-mismatch");
      }
      state.row = {
        projectId: input.projectId, machineId: input.machineId, publicationId: input.publicationId,
        targetBackend: input.targetBackend, evidenceSha256: input.evidenceSha256, fencingToken: nextToken++,
        acquiredAt: capturedAt, renewedAt: capturedAt, expiresAt: "2999-01-01T00:00:00.000Z", releasedAt: null, databaseExpired: false,
      };
      return state.row;
    },
    async renew() { calls.push("renew"); return state.row!; },
    async read() { calls.push("read"); return state.row; },
    async release() { calls.push("release"); state.row = { ...state.row!, releasedAt: capturedAt }; return state.row; },
  } as unknown as ActivationLeasePublicationGuard;
  return { guard, state, calls };
}

const destinationIdentity = fixtureDestinationIdentity("recovery");
const census = PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
  domain, recordCount: 0, prefixSha256: "a".repeat(64), terminalIdentitySha256: null,
}));
const baseline = buildMigrationCanonicalDelta(census);
const baselineCensus = buildMigrationCensusVector(census);

function setup() {
  const homeDir = tempHome();
  // The live files the rollback's publication observes as its source (the fixture driver witnesses these bytes).
  const sourceFiles = rollbackPublicationMaterial().source;
  for (const [name, file] of [["config.json", sourceFiles.config], ["map.json", sourceFiles.projectMap]] as const) {
    if (file.presence === "present") writeFileSync(join(homeDir, ".lcm", name), file.content, { mode: 0o600 });
  }
  const lease = leaseStandIn();
  let observed = census;
  const target: RollbackSessionTarget = {
    settings: { poolMax: 5 } as never, expectedOwner: "owner",
    expectedIdentity: { id: REMOTE } as never, localProjectId: LOCAL, remoteProjectId: REMOTE, machineId: MACHINE,
  };
  // The first open stays a stand-in; the recovery open uses the default (real) admission.
  const sessionDependencies: RollbackSessionDependencies = {
    ...DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
    createRuntime: () => ({
      backendPublicationGuard: () => lease.guard,
      openReadOnlySnapshot: async () => ({ close: async () => undefined }),
      close: async () => undefined,
    }) as never,
    verifyRuntimeSchema: async () => undefined,
    assertReadOnlyGuard: async () => undefined,
    captureDestinationIdentity: async () => destinationIdentity,
    captureDestinationSchemaWitness: async () => undefined as never,
    readFencedDestinationCensus: async () => ({ census: observed }) as never,
    checkQuiescence: async () => ({
      status: "satisfied", reason: "quiescence-observed", detail: "test barrier",
      quiescenceFence: { version: 1, kind: "lcm-activation-writer-quiescence-v1", payload: "{}", evidenceSha256: "a".repeat(64) },
    }),
  };
  const store = new MigrationManifestStore({ homeDir });
  let manifest: MigrationManifest = store.create(createMigrationManifest({
    generationId: GEN,
    source: { version: 1, backend: "sqlite", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt },
    destination: { version: 1, backend: "postgresql", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt },
    parentGenerationId: null, preservedSourceGenerationId: GEN, createdAt: capturedAt,
  }));
  const step = (kind: string, extra: Record<string, unknown> = {}): void => {
    manifest = store.update(GEN, manifest.checksumSha256, (current) => beginMigrationEffect(current, {
      kind: kind as never, effectId: kind, inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
    manifest = store.update(GEN, manifest.checksumSha256, (current) => completeMigrationEffect(current, {
      effectId: kind, completedAt: capturedAt, ...extra,
    }));
  };
  step("verify-dry-run", { report: { kind: "dry-run", reportId: "r1", reportSha256: "b".repeat(64), createdAt: capturedAt } });
  step("copy-batch", { checkpoint: { domain: "conversations", ordinal: 1, recordCount: 1, sourceCheckpointSha256: "c".repeat(64), destinationCommitSha256: "d".repeat(64) } });
  step("complete-copy");
  step("verify-generation", {
    report: { kind: "verification", reportId: "r2", reportSha256: "b".repeat(64), createdAt: capturedAt },
    activationEligible: true,
  });
  const scenario = fixtureActivationScenario({
    generationId: GEN, destinationIdentity, censusVector: baselineCensus, canonicalDeltaBaseline: baseline,
  });
  recordMigrationActivationEpoch({ homeDir, epoch: scenario.epoch });
  recordMigrationActivationAttempt({ homeDir, generationId: GEN, attempt: scenario.attempt });
  recordMigrationActivationWitness({ homeDir, generationId: GEN, witness: scenario.witness });
  recordMigrationWitnessBinding({ homeDir, generationId: GEN, binding: scenario.witnessBinding });
  recordMigrationSelectionBinding({ homeDir, generationId: GEN, binding: scenario.selection });

  const input: RunMigrationRollbackInput = {
    homeDir, generationId: GEN, canonicalPath: join(homeDir, "live.sqlite"),
    projectIdentity: { scope: "shared", projectId: REMOTE } as never, localProjectId: LOCAL,
    sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64),
    roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "7".repeat(64) }],
  };
  const opens: Array<{ recovery: boolean }> = [];
  /** The coordinator publishes through the in-memory driver; its completion releases the lease row, as the real remote guard does. */
  const coordinator = (): BackendPublicationCoordinator => {
    const real = rollbackFixtureCoordinator(homeDir);
    const resume = real.resume.bind(real);
    real.resume = async (...args) => {
      const journal = await resume(...args);
      if (lease.state.row !== null && lease.state.row.releasedAt === null) await lease.guard.release({} as never);
      return journal;
    };
    return real;
  };
  /**
   * The real coordinator over the in-memory publication driver and the PRODUCTION PostgreSQL remote-guard provider,
   * both bound to the very lease row the session acquires: the coordinator adopts, takes over and releases the
   * session's lease exactly as it does against PostgreSQL. crashAt throws once the journal is durably at that
   * phase (or right after the remote release, before the journal records it).
   */
  const sharedLeaseCoordinator = (
    crashAt?: BackendPublicationPhase | "after-release" | "before-material-seal" | "after-material-seal",
    options: { failAfterPhaseWrite?: { phase: BackendPublicationPhase; failure: () => void }; fileBacked?: boolean } = {},
  ): BackendPublicationCoordinator => {
    let armed = crashAt !== undefined;
    let injected = false;
    const remoteGuard = createPostgreSqlBackendPublicationRemoteGuard({ guard: lease.guard as never, machineId: MACHINE, ttlMs: 15 * 60 * 1000 });
    return new BackendPublicationCoordinator({
      homeDir,
      // fileBacked: the production driver over the live .lcm/config.json and .lcm/map.json, which really publishes
      // the sqlite files and really restores the sources on an abort (the in-memory driver restores nothing).
      driver: options.fileBacked === true
        ? createBackendPublicationDriver({ remoteGuard: { mode: "delegated", provider: remoteGuard } })
        : { ...workingPublicationDriver(rollbackPublicationMaterial()), ...remoteGuard },
      observer: (event) => {
        if (
          options.failAfterPhaseWrite !== undefined && !injected && event === "after-journal-write"
          && readBackendPublicationJournal(homeDir)?.phase === options.failAfterPhaseWrite.phase
        ) {
          injected = true;
          options.failAfterPhaseWrite.failure();
        }
        if (!armed) return;
        const hit = crashAt === "after-release" || crashAt === "before-material-seal" || crashAt === "after-material-seal"
          ? event === crashAt
          : event === "after-journal-write" && readBackendPublicationJournal(homeDir)?.phase === crashAt;
        if (!hit) return;
        armed = false;
        throw new Error("crash at " + crashAt);
      },
    });
  };
  const dependencies = (coordinatorUsed: BackendPublicationCoordinator, extra: Partial<RunMigrationRollbackDependencies> = {},
    sessionOverrides: Partial<RollbackSessionDependencies> = {}): RunMigrationRollbackDependencies => ({
    coordinator: coordinatorUsed,
    openFencedSession: async (request) => {
      opens.push({ recovery: request.recovery === true });
      return openRollbackFencedSession(request, target, { ...sessionDependencies, ...sessionOverrides });
    },
    readProjectMap: () => ({ [LOCAL]: { canonical: "/covered", aliases: [], remoteProjectId: REMOTE } }),
    readRetainedMaterial: () => ({
      status: "present", journal: { publicationId: "publication-1", sourceBackend: "sqlite", targetBackend: "postgresql" },
      material: activationPublicationMaterial(),
    }) as never,
    composePublication: (request) => ({
      sourceBackend: "postgresql", targetBackend: "sqlite", material: rollbackPublicationMaterial(), projects: request.bindings,
    }) as never,
    ...extra,
  });
  return {
    homeDir, lease, input, store, opens, coordinator, sharedLeaseCoordinator, dependencies, target, sessionDependencies,
    setObserved(next: typeof census) { observed = next; },
    pending: () => store.read(GEN).pendingEffect,
  };
}

function crashBeforeCompleteSelection(coordinator: BackendPublicationCoordinator): BackendPublicationCoordinator {
  coordinator.completeMaintenanceSelection = async () => { throw new Error("crash before completeMaintenanceSelection"); };
  return coordinator;
}

/** The writer's canonical bytes for an evidence record, and a lone scratch of one planted as an interrupted write leaves it (#1808). */
const evidenceWire = (record: unknown): string => canonicalJson({ version: 1, generationId: GEN, record }) + "\n";
function evidenceScratchPath(homeDir: string, witness: { checksumSha256: string }, hex = "0123abcd"): string {
  return join(migrationActivationEvidenceDirectory(homeDir, GEN), ".witness-" + witness.checksumSha256 + ".json." + hex + ".tmp");
}
function plantEvidenceScratch(homeDir: string, witness: { checksumSha256: string }, content = evidenceWire(witness)): string {
  const path = evidenceScratchPath(homeDir, witness);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}
/** The rollback witness the fixture's baseline destination mints (pre-write), or a drifted post-write one. */
function storedRollbackWitness(homeDir: string, drift?: number) {
  const stored = readMigrationActivationEvidence({ homeDir, generationId: GEN });
  if (stored.state !== "resolved") throw new Error("expected resolved evidence");
  const [epoch] = stored.epochs;
  const [attempt] = stored.attempts;
  return drift === undefined
    ? fixtureRollbackWitness({ epoch: epoch!, attempt: attempt!, postEpochDelta: baseline, postEpochCensus: baselineCensus, rollbackMode: "pre-write" })
    : fixtureRollbackWitness({
      epoch: epoch!, attempt: attempt!, postEpochDelta: driftCanonicalDelta(baseline, drift), postEpochCensus: null, rollbackMode: "post-write",
    });
}

const DRIFTED = census.map((entry, index) => (index === 0 ? { ...entry, recordCount: 7, prefixSha256: "e".repeat(64) } : entry));

describe("recovery of a rollback through the real session opener and recovery admission (F11)", () => {
  it("completes a prepared selection: the recovery open is admitted, revalidates and keeps one lease", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(crashBeforeCompleteSelection(t.coordinator()))))
      .rejects.toThrow("crash before completeMaintenanceSelection");
    expect(readBackendMaintenanceJournal(t.homeDir)?.phase).toBe("selection-prepared");
    expect(t.lease.state.row?.releasedAt).toBeNull();

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.coordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }]);
    expect(t.lease.calls.filter((call) => call === "release")).toHaveLength(1);
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "completed", publicationId: PUBLICATION_ID });
  });

  it("refuses a prepared selection whose destination changed meanwhile and keeps the lease held", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(crashBeforeCompleteSelection(t.coordinator()))))
      .rejects.toThrow("crash before completeMaintenanceSelection");
    t.setObserved(DRIFTED);
    const before = t.store.read(GEN).checksumSha256;

    await expect(runMigrationRollback(t.input, t.dependencies(t.coordinator()))).rejects.toThrow();

    expect(t.lease.state.row?.releasedAt).toBeNull();
    expect(t.lease.calls).not.toContain("release");
    expect(t.store.read(GEN).checksumSha256).toBe(before);
    expect(readBackendMaintenanceJournal(t.homeDir)?.phase).toBe("selection-prepared");
  });

  it("completes a completed selection (crash before the binding is written) under a recovery open", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.coordinator(), {
      recordSelectionBinding: () => { throw new Error("crash after selection-completed, before the binding"); },
    }))).rejects.toThrow("crash after selection-completed");
    expect(readBackendMaintenanceJournal(t.homeDir)?.phase).toBe("selection-completed");
    expect(t.lease.state.row?.releasedAt).toBeNull();

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.coordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens.map((open) => open.recovery)).toEqual([false, true]);
  });

  it("finishes the coordinator's own non-terminal publication under a recovery open", async () => {
    const t = setup();
    const crashing = t.coordinator();
    const prepare = crashing.prepare.bind(crashing);
    crashing.prepare = async (...args) => {
      await prepare(...args);
      throw new Error("crash right after prepare");
    };
    await expect(runMigrationRollback(t.input, t.dependencies(crashing))).rejects.toThrow("crash right after prepare");
    expect(readBackendMaintenanceJournal(t.homeDir)).toBeNull();
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "prepared", publicationId: PUBLICATION_ID });
    expect(t.lease.state.row?.releasedAt).toBeNull();

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.coordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens.map((open) => open.recovery)).toEqual([false, true]);
  });

  it("keeps the lease when the recovery open itself is refused", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(crashBeforeCompleteSelection(t.coordinator()))))
      .rejects.toThrow("crash before completeMaintenanceSelection");

    await expect(runMigrationRollback(t.input, t.dependencies(t.coordinator(), {}, {
      checkRecoveryAdmission: async () => ({ status: "unsatisfied", detail: "refused", quiescenceFence: null }),
    }))).rejects.toMatchObject({ reason: "quiescence-unsatisfied" });

    expect(t.lease.state.row?.releasedAt).toBeNull();
    expect(t.lease.calls).not.toContain("release");
  });

  it("the strict first-open quiescence still refuses every phase after maintenance-held", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(crashBeforeCompleteSelection(t.coordinator()))))
      .rejects.toThrow("crash before completeMaintenanceSelection");
    const result = await withBackendPublicationAppendBarrierAsync(t.homeDir, (token) => checkActivationWriterQuiescence({ homeDir: t.homeDir, lockToken: token }));
    expect(result).toMatchObject({ status: "unsatisfied", reason: "maintenance-not-held" });
  });
});

/**
 * #626 E1 (round-3 S3-1). The session and the coordinator drive ONE lease row. A recovery that meets the
 * coordinator's journal at released -- the coordinator released the fence and durably said so, and resumes by
 * finalizing without another release -- must not acquire a fence of its own: the real guard replaces a released
 * row with a fresh token that nothing would ever release, and guarded PostgreSQL writers refuse while any
 * unreleased row exists. Every earlier forward phase keeps its fence-driving recovery session (the coordinator
 * adopts or supersedes it and releases it); released and the abort phases finish through the coordinator alone.
 */
describe("recovery across the coordinator's lease handoff (E1): one lease row shared by the session and the coordinator", () => {
  const acquires = (t: ReturnType<typeof setup>) => t.lease.calls.filter((call) => call === "acquire").length;

  it("finishes a publication crashed at released without acquiring another fence, and settles with the one lease released", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("released")))).rejects.toThrow("crash at released");
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "released", publicationId: PUBLICATION_ID });
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: capturedAt });
    const acquiredBefore = acquires(t);

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "completed", publicationId: PUBLICATION_ID });
    // No recovery session was opened and no row was acquired: the released row of the first attempt is the only one.
    expect(t.opens).toEqual([{ recovery: false }]);
    expect(acquires(t)).toBe(acquiredBefore);
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: capturedAt });

    // Settled: a further call reports the same outcome with the lease still released.
    const again = await runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator()));
    expect(again.manifest.phase).toBe("rolled-back");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: capturedAt });
  });

  it.each([
    ["prepared", 1n],
    ["guarded", 1n],
    ["config-published", 1n],
    ["releasing", 1n],
    // The remote release landed but the journal still says releasing: the released row is superseded by the
    // recovery session's fresh token, which the coordinator's release phase then releases.
    ["after-release", 2n],
  ] as const)("finishes a publication crashed at %s under a recovery session whose fence the coordinator releases", async (crashAt, finalToken) => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator(crashAt)))).rejects.toThrow("crash at " + crashAt);
    expect(readBackendPublicationJournal(t.homeDir)?.phase).toBe(crashAt === "after-release" ? "releasing" : crashAt);

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }]);
    expect(t.lease.state.row).toMatchObject({ fencingToken: finalToken, releasedAt: capturedAt });
  });

  it("refuses a released journal that does not record a released fence, instead of settling over it", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("released")))).rejects.toThrow("crash at released");
    const journalPath = backendPublicationJournalPath(t.homeDir);
    const { checksumSha256: _checksum, ...body } = JSON.parse(readFileSync(journalPath, "utf8"));
    body.projects[0].fence.releasedAt = null;
    writeFileSync(journalPath, JSON.stringify({ ...body, checksumSha256: backendPublicationCanonicalSha256(body) }));
    const before = t.store.read(GEN).checksumSha256;

    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator())))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("released fence") });

    expect(t.opens).toEqual([{ recovery: false }]);
    expect(t.store.read(GEN).checksumSha256).toBe(before);
    expect(readBackendPublicationJournal(t.homeDir)?.phase).toBe("released");
  });

  it("E4: refuses a journal under this rollback's id that is not its composition before resuming it", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("prepared")))).rejects.toThrow("crash at prepared");
    const journalPath = backendPublicationJournalPath(t.homeDir);
    const { checksumSha256: _checksum, ...body } = JSON.parse(readFileSync(journalPath, "utf8"));
    // A forward-shaped (sqlite -> postgresql) publication planted under the rollback's publicationId.
    body.sourceBackend = "sqlite";
    body.targetBackend = "postgresql";
    writeFileSync(journalPath, JSON.stringify({ ...body, checksumSha256: backendPublicationCanonicalSha256(body) }));
    const before = t.store.read(GEN).checksumSha256;

    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator())))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("not its composition") });

    // Nothing was resumed or settled; the recovery session kept the lease.
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "prepared", targetBackend: "postgresql" });
    expect(t.store.read(GEN).checksumSha256).toBe(before);
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
  });
});

/**
 * #626 E6 (escalation review AESC-01). The coordinator's prepare() writes the journal at preparing, seals the
 * material, then records prepared with the recovery reference. A crash in either window leaves this rollback's
 * own journal at preparing with recoveryReference null -- material absent or sealed. The authenticated material
 * reader refuses such a journal by design, so every input read must recognize it first and read the live files
 * (nothing was published yet), and the publication step must finish it through the coordinator: resume
 * authenticates sealed material; for absent material the coordinator's own preparing -> aborted exit is taken and
 * the publication is composed and prepared again, under the same retained barrier and the same recovery session,
 * whose original lease the coordinator adopts and releases exactly once.
 */
describe("recovery of a publication crashed while preparing (E6): unsealed journal, material absent or sealed", () => {
  beforeEach(() => {
    vi.stubEnv("LCM_POSTGRES_URL", "postgresql://user:secret@example/db");
    const caFile = join(tempHome(), "ca.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\n", { mode: 0o600 });
    vi.stubEnv("LCM_POSTGRES_CA_FILE", caFile);
    vi.stubEnv("LCM_POSTGRES_MIGRATION_ROLE", "lcm_owner");
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  const expectLiveSource = (t: ReturnType<typeof setup>) => {
    expect(readOwnPublicationSourceFromMaterial(t.homeDir, PUBLICATION_ID, LOCAL)).toMatchObject({
      storage: { backend: "postgresql" }, projectMap: { [LOCAL]: { remoteProjectId: REMOTE } },
    });
  };
  const releases = (t: ReturnType<typeof setup>) => t.lease.calls.filter((call) => call === "release").length;
  const acquires = (t: ReturnType<typeof setup>) => t.lease.calls.filter((call) => call === "acquire").length;
  const counting = (coordinator: BackendPublicationCoordinator) => {
    const counts = { abort: 0, resume: 0, prepare: 0 };
    for (const method of ["abort", "resume", "prepare"] as const) {
      const real = (coordinator[method] as (...args: unknown[]) => Promise<unknown>).bind(coordinator);
      (coordinator as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => { counts[method]++; return real(...args); };
    }
    return { coordinator, counts };
  };
  const expectSettled = (t: ReturnType<typeof setup>) => {
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "completed", publicationId: PUBLICATION_ID });
    expect(t.pending()).toBeNull();
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: capturedAt });
    // Every acquire adopted the one active row (the stand-in returns it, as the real guard does): token 1 throughout.
    expect(acquires(t)).toBe(t.opens.length);
    expect(releases(t)).toBe(1);
    const bindings = resolveMigrationWitnessBindings({ homeDir: t.homeDir, generationId: GEN });
    const rollback = bindings.state === "resolved" ? bindings.selections.find((selection) => selection.kind === "rollback") : undefined;
    expect(assertMigrationReplayAdmission({ homeDir: t.homeDir, generationId: GEN, evidenceSha256: rollback!.witnessChecksumSha256 }))
      .toEqual({ backend: "sqlite", disposition: "selected" });
  };

  it.each(["before-material-seal", "after-material-seal"] as const)("crash at %s: the retry resolves its inputs from the live files and settles under the original lease", async (crashAt) => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator(crashAt)))).rejects.toThrow("crash at " + crashAt);
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "preparing", publicationId: PUBLICATION_ID, recoveryReference: null });
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
    // The production input resolver reads this journal too: it must not refuse, and it reads the live files the
    // journal witnessed (nothing was published from it).
    expectLiveSource(t);

    const { coordinator, counts } = counting(t.sharedLeaseCoordinator());
    const outcome = await runMigrationRollback(t.input, t.dependencies(coordinator));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }]);
    // Sealed material is authenticated and driven forward by resume alone; absent material (established before any
    // coordinator call) takes the coordinator's preparing -> aborted exit once, then is composed, prepared and resumed.
    expect(counts).toEqual(crashAt === "after-material-seal" ? { abort: 0, resume: 1, prepare: 0 } : { abort: 1, resume: 1, prepare: 1 });
    expectSettled(t);
  });

  it("crash between the missing-material abort and the second prepare: the aborted unsealed journal is admitted and prepared again", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("before-material-seal")))).rejects.toThrow("crash at before-material-seal");
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("aborted")))).rejects.toThrow("crash at aborted");
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "aborted", publicationId: PUBLICATION_ID, recoveryReference: null });
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
    // E7: the aborted unsealed journal reads like the preparing one -- the live files it witnessed.
    expectLiveSource(t);

    const { coordinator, counts } = counting(t.sharedLeaseCoordinator());
    const outcome = await runMigrationRollback(t.input, t.dependencies(coordinator));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }, { recovery: true }]);
    expect(counts).toEqual({ abort: 0, resume: 1, prepare: 1 });
    expectSettled(t);
  });

  it("the input reader recognizes only this rollback's own unsealed composition and still refuses any other unreferenced journal", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("after-material-seal")))).rejects.toThrow("crash at after-material-seal");
    expectLiveSource(t);
    // Same journal, another covered project: not this rollback's composition, so the authenticated reader decides.
    expect(() => readOwnPublicationSourceFromMaterial(t.homeDir, PUBLICATION_ID, "d".repeat(64)))
      .toThrow(expect.objectContaining({ reason: "publication-evidence-missing" }));
    // A forward-shaped (sqlite -> postgresql) unsealed journal under the rollback's id: not its composition either.
    const journalPath = backendPublicationJournalPath(t.homeDir);
    const { checksumSha256: _checksum, ...body } = JSON.parse(readFileSync(journalPath, "utf8"));
    body.sourceBackend = "sqlite";
    body.targetBackend = "postgresql";
    writeFileSync(journalPath, JSON.stringify({ ...body, checksumSha256: backendPublicationCanonicalSha256(body) }));
    expect(() => readOwnPublicationSourceFromMaterial(t.homeDir, PUBLICATION_ID, LOCAL))
      .toThrow(expect.objectContaining({ reason: "publication-evidence-missing" }));
  });

  it("refuses live files that no longer match what the unsealed journal witnessed, keeping everything as it is", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("before-material-seal")))).rejects.toThrow("crash at before-material-seal");
    writeFileSync(join(t.homeDir, ".lcm", "map.json"), JSON.stringify({ [LOCAL]: { canonical: "/elsewhere", aliases: [], remoteProjectId: REMOTE } }), { mode: 0o600 });

    expect(() => readOwnPublicationSourceFromMaterial(t.homeDir, PUBLICATION_ID, LOCAL))
      .toThrow(expect.objectContaining({ reason: "unexpected-state", message: expect.stringContaining("live project map is not the one") }));
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator())))
      .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("project-map-unreadable") });
    expect(t.opens).toEqual([{ recovery: false }]);
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "preparing", recoveryReference: null });
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
  });

  it("a resume failure on a sealed journal propagates untouched, with nothing aborted and the lease kept", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("after-material-seal")))).rejects.toThrow("crash at after-material-seal");
    const { coordinator, counts } = counting(t.sharedLeaseCoordinator());
    coordinator.resume = async () => { throw new Error("EACCES-like failure reading the material"); };

    await expect(runMigrationRollback(t.input, t.dependencies(coordinator))).rejects.toThrow("EACCES-like failure reading the material");

    expect(counts.abort).toBe(0);
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "preparing", recoveryReference: null });
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
  });

  it("refuses to prepare again when the missing-material abort does not land on the unsealed aborted journal", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("before-material-seal")))).rejects.toThrow("crash at before-material-seal");
    const { coordinator, counts } = counting(t.sharedLeaseCoordinator());
    const abort = coordinator.abort.bind(coordinator);
    coordinator.abort = async (...args) => {
      const journal = await abort(...args);
      return { ...journal, recoveryReference: { relativePath: PUBLICATION_ID + ".material", sealSha256: "f".repeat(64), byteLength: 1 } };
    };

    await expect(runMigrationRollback(t.input, t.dependencies(coordinator)))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("did not abort as a missing-material publication") });

    expect(counts.prepare).toBe(0);
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
  });

  it("E7: a retry starting from the aborted unsealed journal, through the PRODUCTION readers, reaches admission and prepares again", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("before-material-seal")))).rejects.toThrow("crash at before-material-seal");
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("aborted")))).rejects.toThrow("crash at aborted");
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "aborted", publicationId: PUBLICATION_ID, recoveryReference: null });
    // The durable input resolver's reader and the orchestration's map reader both resolve the live source.
    expectLiveSource(t);
    const { coordinator, counts } = counting(t.sharedLeaseCoordinator());

    // No fixture project-map port: the orchestration's sole-project check reads through the production readers.
    const outcome = await runMigrationRollback(t.input, t.dependencies(coordinator, { readProjectMap: readProjectMapForRollback }));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }, { recovery: true }]);
    expect(counts).toEqual({ abort: 0, resume: 1, prepare: 1 });
    expectSettled(t);
  });

  it("E8: a material file missing transiently after the prepared checkpoint propagates without any abort; restoring it lets a retry finish forward", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("after-material-seal")))).rejects.toThrow("crash at after-material-seal");
    const materialPath = join(backendPublicationDirectory(t.homeDir), PUBLICATION_ID + ".material");
    const hidden = materialPath + ".hidden";
    // The retry authenticates the sealed material and records prepared; the file then vanishes (a real ENOENT at
    // the coordinator's next material read, after forward progress), so this is not a missing-material journal.
    const { coordinator, counts } = counting(t.sharedLeaseCoordinator(undefined, {
      failAfterPhaseWrite: { phase: "prepared", failure: () => renameSync(materialPath, hidden) },
    }));
    await expect(runMigrationRollback(t.input, t.dependencies(coordinator))).rejects.toMatchObject({ code: "ENOENT" });
    expect(counts.abort).toBe(0);
    const journal = readBackendPublicationJournal(t.homeDir)!;
    expect(["prepared", "acquiring", "guarded"]).toContain(journal.phase);
    expect(journal.recoveryReference).not.toBeNull();
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });

    renameSync(hidden, materialPath);
    const { coordinator: again, counts: later } = counting(t.sharedLeaseCoordinator());
    const outcome = await runMigrationRollback(t.input, t.dependencies(again));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(later).toEqual({ abort: 0, resume: 1, prepare: 0 });
    expectSettled(t);
  });

  it("E8: an ENOENT raised right after the prepared checkpoint, with the material present, propagates without any abort and a retry finishes forward", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("after-material-seal")))).rejects.toThrow("crash at after-material-seal");
    const { coordinator, counts } = counting(t.sharedLeaseCoordinator(undefined, {
      failAfterPhaseWrite: { phase: "prepared", failure: () => { throw Object.assign(new Error("injected ENOENT after prepared"), { code: "ENOENT" }); } },
    }));
    await expect(runMigrationRollback(t.input, t.dependencies(coordinator))).rejects.toThrow("injected ENOENT after prepared");
    expect(counts.abort).toBe(0);
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "prepared", recoveryReference: expect.objectContaining({ sealSha256: expect.any(String) }) });
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expectSettled(t);
  });
});

/**
 * #1555. This rollback's own publication, aborted by something other than this rollback: either the abort stopped
 * part-way (aborting .. abort-releasing) or it finished (aborted, with the sealed material it restored from). The
 * coordinator's abort restores the source files, releases the fence it recorded and consumes the material, so the
 * re-run finishes the abort through the coordinator alone, proves the restored source and the authority again,
 * and then publishes forward under a recovery session on the lease. A drift or a refusal there leaves the effect
 * pending, the slot aborted and the lease held. Real session opener, real recovery admission, real coordinator over
 * the production driver on real files (fileBacked) where the abort has to restore them.
 */
describe("an externally aborted rollback publication (#1555)", () => {
  beforeEach(() => {
    vi.stubEnv("LCM_POSTGRES_URL", "postgresql://user:secret@example/db");
    const caFile = join(tempHome(), "ca.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\n", { mode: 0o600 });
    vi.stubEnv("LCM_POSTGRES_CA_FILE", caFile);
    vi.stubEnv("LCM_POSTGRES_MIGRATION_ROLE", "lcm_owner");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  type Fixture = ReturnType<typeof setup>;
  const acquires = (t: Fixture) => t.lease.calls.filter((call) => call === "acquire").length;
  const FILE_BACKED = { fileBacked: true } as const;
  const crashFirstRun = async (t: Fixture, crashAt: BackendPublicationPhase, options: { fileBacked?: boolean } = {}) => {
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator(crashAt, options)))).rejects.toThrow("crash at " + crashAt);
    expect(t.pending()?.kind).toBe("publish-rollback");
  };
  /** Records the coordinator calls in the lease stand-in's own ordered call list. */
  const traced = (t: Fixture, coordinator: BackendPublicationCoordinator): BackendPublicationCoordinator => {
    for (const method of ["abort", "prepare", "resume"] as const) {
      const real = (coordinator[method] as (...args: unknown[]) => Promise<unknown>).bind(coordinator);
      (coordinator as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        t.lease.calls.push("coordinator:" + method);
        try { return await real(...args); } finally { t.lease.calls.push("coordinator:" + method + ":done"); }
      };
    }
    return coordinator;
  };
  const rewriteJournal = (homeDir: string, mutate: (body: any) => void): void => {
    const journalPath = backendPublicationJournalPath(homeDir);
    const { checksumSha256: _checksum, ...body } = JSON.parse(readFileSync(journalPath, "utf8"));
    mutate(body);
    writeFileSync(journalPath, JSON.stringify({ ...body, checksumSha256: backendPublicationCanonicalSha256(body) }));
  };
  const fileText = (file: unknown) => Buffer.from((file as { content: Uint8Array }).content).toString();
  const sourceConfig = () => fileText(rollbackPublicationMaterial().source.config);
  const targetConfig = () => fileText(rollbackPublicationMaterial().target.config);
  const sourceMap = () => fileText(rollbackPublicationMaterial().source.projectMap);
  const targetMap = () => fileText(rollbackPublicationMaterial().target.projectMap);
  const liveConfig = (t: Fixture) => readFileSync(join(t.homeDir, ".lcm", "config.json"), "utf8");
  const liveMap = (t: Fixture) => readFileSync(join(t.homeDir, ".lcm", "map.json"), "utf8");
  const expectReconciled = (t: Fixture, outcome: Awaited<ReturnType<typeof runMigrationRollback>>, finalToken: bigint) => {
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.reports.some((report) => report.kind === "rollback")).toBe(true);
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "completed", publicationId: PUBLICATION_ID });
    expect(t.pending()).toBeNull();
    expect(t.lease.state.row).toMatchObject({ fencingToken: finalToken, releasedAt: capturedAt });
    const bindings = resolveMigrationWitnessBindings({ homeDir: t.homeDir, generationId: GEN });
    const rollback = bindings.state === "resolved" ? bindings.selections.find((selection) => selection.kind === "rollback") : undefined;
    expect(assertMigrationReplayAdmission({ homeDir: t.homeDir, generationId: GEN, evidenceSha256: rollback!.witnessChecksumSha256 }))
      .toEqual({ backend: "sqlite", disposition: "selected" });
  };
  /** The abort finished (and its recorded fence released) before the first recovery acquire. */
  const expectAbortBeforeAcquire = (t: Fixture, since: number) => {
    const events = t.lease.calls.slice(since);
    expect(events.indexOf("coordinator:abort:done")).toBeGreaterThan(-1);
    expect(events.indexOf("coordinator:abort:done")).toBeLessThan(events.indexOf("acquire"));
  };
  const materialPath = (t: Fixture) => join(backendPublicationDirectory(t.homeDir), PUBLICATION_ID + ".material");

  it("T1: a publication aborted before it acquired a fence reconciles forward: the original lease row is adopted and released", async () => {
    const t = setup();
    await crashFirstRun(t, "prepared");
    await traced(t, t.sharedLeaseCoordinator()).abort();
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({
      phase: "aborted", recoveryReference: expect.objectContaining({ sealSha256: expect.any(String) }),
      projects: [expect.objectContaining({ fence: null })],
    });
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
    const since = t.lease.calls.length;

    const outcome = await runMigrationRollback(t.input, t.dependencies(traced(t, t.sharedLeaseCoordinator())));

    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }]);
    // A null fence is not released by the coordinator's abort; the recovery session adopts the very same row.
    expect(acquires(t)).toBe(2);
    expect(t.lease.calls.slice(since).filter((call) => call === "coordinator:abort")).toHaveLength(0);
    expect(t.lease.calls.slice(since).filter((call) => call === "coordinator:prepare")).toHaveLength(1);
    expectReconciled(t, outcome, 1n);
  });

  it("T1p: the same with the activation's completed postgresql publication retained before the rollback began (an operability-present artifact)", async () => {
    const t = setup();
    const activation = publicationMaterial();
    const activationCoordinator = new BackendPublicationCoordinator({ homeDir: t.homeDir, driver: workingPublicationDriver(activation) });
    await activationCoordinator.prepare({
      publicationId: "activation-publication", sourceBackend: "sqlite", targetBackend: "postgresql", material: activation,
      projects: [{ localProjectId: LOCAL, remoteProjectId: REMOTE, evidenceSha256: "a".repeat(64) }], now: new Date(capturedAt),
    });
    await activationCoordinator.resume();
    await crashFirstRun(t, "prepared");
    expect(readRollbackAuthorityArtifact(t.homeDir, GEN)).toMatchObject({ operabilityFactState: "present" });
    await t.sharedLeaseCoordinator().abort();

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator()));

    expectReconciled(t, outcome, 1n);
  });

  it("T2: an abort after the sqlite files were published restores the sources and releases the recorded fence; the re-run takes a successor lease", async () => {
    const t = setup();
    await crashFirstRun(t, "config-published", FILE_BACKED);
    expect(liveConfig(t)).toBe(targetConfig());
    await traced(t, t.sharedLeaseCoordinator(undefined, FILE_BACKED)).abort();
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "aborted", recoveryReference: expect.anything() });
    expect(liveConfig(t)).toBe(sourceConfig());
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: capturedAt });
    const since = t.lease.calls.length;

    const outcome = await runMigrationRollback(t.input, t.dependencies(traced(t, t.sharedLeaseCoordinator(undefined, FILE_BACKED))));

    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }]);
    expect(t.lease.calls.slice(since)[0]).toBe("acquire");
    expect(liveConfig(t)).toBe(targetConfig());
    expectReconciled(t, outcome, 2n);
  });

  it("T3: a destination that no longer reproduces the pending evidence refuses with the effect pending, the slot aborted and the lease held, on every retry", async () => {
    const t = setup();
    await crashFirstRun(t, "config-published", FILE_BACKED);
    await t.sharedLeaseCoordinator(undefined, FILE_BACKED).abort();
    t.setObserved(DRIFTED);
    const manifestBefore = t.store.read(GEN).checksumSha256;
    const journalBefore = readFileSync(backendPublicationJournalPath(t.homeDir), "utf8");

    for (const attempt of [1, 2]) {
      const since = t.lease.calls.length;
      const counts = { prepare: 0, resume: 0 };
      const coordinator = t.sharedLeaseCoordinator(undefined, FILE_BACKED);
      for (const method of ["prepare", "resume"] as const) {
        const real = (coordinator[method] as (...args: unknown[]) => Promise<unknown>).bind(coordinator);
        (coordinator as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => { counts[method]++; return real(...args); };
      }
      await expect(runMigrationRollback(t.input, t.dependencies(coordinator))).rejects.toMatchObject({ reason: "drift" });
      expect(counts).toEqual({ prepare: 0, resume: 0 });
      expect(t.lease.calls.slice(since)).not.toContain("release");
      expect(t.lease.state.row).toMatchObject({ fencingToken: 2n, releasedAt: null });
      expect(t.store.read(GEN).checksumSha256).toBe(manifestBefore);
      expect(t.pending()?.kind).toBe("publish-rollback");
      expect(readFileSync(backendPublicationJournalPath(t.homeDir), "utf8")).toBe(journalBefore);
      expect(liveConfig(t)).toBe(sourceConfig());
      expect(attempt).toBeGreaterThan(0);
    }
  });

  /**
   * A post-write rollback: the destination already differs from the activation baseline by its record count, so the
   * first run stores a post-write rollback witness that carries the census. A census that differs only in its prefix
   * digest keeps the canonical delta (record counts and terminal identities) and the mode, and changes only the
   * census the witness is sealed over.
   */
  const WRITTEN = census.map((entry, index) => (index === 0 ? { ...entry, recordCount: 7 } : entry));
  const WRITTEN_OTHER_PREFIX = WRITTEN.map((entry, index) => (index === 0 ? { ...entry, prefixSha256: "f".repeat(64) } : entry));
  /** The post-write export of the first run: a real (empty) sqlite source whose census is the written one. */
  const postWriteSession: Partial<RollbackSessionDependencies> = {
    createPortableSource: (async () => {
      const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-recovery-src-"));
      dirs.push(dir);
      const path = join(dir, "source.db");
      const db = new DatabaseSync(path);
      try { runLcmMigrations(db, { fts5Available: false }); } finally { db.close(); }
      chmodSync(path, 0o600);
      const facts = { machines: [{ identityKey: "local-machine", machineId: null }], aliases: [], sourceLocalProjectId: LOCAL };
      return openSqlitePortableSource({
        databasePath: path, scratchParent: dir, projectIdentity: { scope: "shared", projectId: REMOTE } as never,
        identityFacts: facts, sourceLocalProjectId: LOCAL,
        expectedFileSha256: sqlitePortableFileSha256(path), expectedFactsSha256: canonicalSha256(facts),
        capturedAt: "2026-09-06T00:00:00.000000Z",
        capturedSidecars: {
          events: { absent: true, evidenceSha256: "f".repeat(64) },
          instructions: { absent: true, evidenceSha256: "e".repeat(64) },
        },
      });
    }) as never,
    readDomainCensus: ((_source: unknown, domain: string) => WRITTEN.find((entry) => entry.domain === domain)!) as never,
  };
  /** The first run of a post-write rollback, crashed once both sqlite files are published, then aborted by someone else. */
  const abortedPostWriteRollback = async (t: Fixture) => {
    t.setObserved(WRITTEN);
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("config-published", FILE_BACKED), {}, postWriteSession)))
      .rejects.toThrow("crash at config-published");
    expect(t.pending()?.kind).toBe("publish-rollback");
    const evidence = readMigrationActivationEvidence({ homeDir: t.homeDir, generationId: GEN });
    const witness = evidence.state === "resolved"
      ? evidence.witnesses.find((candidate) => candidate.kind === "rollback" && candidate.checksumSha256 === t.pending()?.inputSha256)
      : undefined;
    expect(witness).toMatchObject({ rollbackMode: "post-write", postEpochCensus: expect.anything() });
    await t.sharedLeaseCoordinator(undefined, FILE_BACKED).abort();
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "aborted", recoveryReference: expect.anything() });
    expect(liveConfig(t)).toBe(sourceConfig());
  };

  it("T3p: a post-write rollback whose destination still reproduces its census completes after the external abort", async () => {
    const t = setup();
    await abortedPostWriteRollback(t);

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator(undefined, FILE_BACKED), {}, postWriteSession));

    expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
    expectReconciled(t, outcome, 2n);
    expect(liveConfig(t)).toBe(targetConfig());
  }, 60_000);

  it("T3p: a post-write destination whose census changed only in its prefix digest refuses with drift on every retry, changing nothing", async () => {
    const t = setup();
    await abortedPostWriteRollback(t);
    // Same record counts and terminal identities, hence the same canonical delta and the same mode: only the census differs.
    expect(buildMigrationCanonicalDelta(WRITTEN_OTHER_PREFIX)).toEqual(buildMigrationCanonicalDelta(WRITTEN));
    expect(buildMigrationCensusVector(WRITTEN_OTHER_PREFIX)).not.toEqual(buildMigrationCensusVector(WRITTEN));
    t.setObserved(WRITTEN_OTHER_PREFIX);
    const manifestBefore = t.store.read(GEN).checksumSha256;
    const journalBefore = readFileSync(backendPublicationJournalPath(t.homeDir), "utf8");

    for (const attempt of [1, 2]) {
      const since = t.lease.calls.length;
      const counts = { prepare: 0, resume: 0 };
      const coordinator = t.sharedLeaseCoordinator(undefined, FILE_BACKED);
      for (const method of ["prepare", "resume"] as const) {
        const real = (coordinator[method] as (...args: unknown[]) => Promise<unknown>).bind(coordinator);
        (coordinator as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => { counts[method]++; return real(...args); };
      }
      await expect(runMigrationRollback(t.input, t.dependencies(coordinator, {}, postWriteSession)))
        .rejects.toMatchObject({ reason: "drift" });
      expect(counts, "attempt " + attempt).toEqual({ prepare: 0, resume: 0 });
      expect(t.lease.calls.slice(since)).not.toContain("release");
      expect(t.lease.state.row).toMatchObject({ fencingToken: 2n, releasedAt: null });
      expect(t.store.read(GEN).checksumSha256).toBe(manifestBefore);
      expect(t.pending()?.kind).toBe("publish-rollback");
      expect(readFileSync(backendPublicationJournalPath(t.homeDir), "utf8")).toBe(journalBefore);
      expect(liveConfig(t)).toBe(sourceConfig());
    }
  }, 60_000);

  /**
   * The forward run publishes the sqlite configuration and the unbound project map through the production driver,
   * then the abort restores both sources and stops at abort-releasing (its fence still recorded). Only the
   * material-absent variant removes the sealed material, which the coordinator's own cleanup would have done right
   * before the aborted checkpoint; the test plays that part.
   */
  const abortStoppedAfterRestore = async (t: Fixture, variant: "material-present" | "material-absent") => {
    await crashFirstRun(t, "config-published", FILE_BACKED);
    expect(liveConfig(t)).toBe(targetConfig());
    expect(liveMap(t)).toBe(targetMap());
    await expect(t.sharedLeaseCoordinator("abort-releasing", FILE_BACKED).abort()).rejects.toThrow("crash at abort-releasing");
    expect(readBackendPublicationJournal(t.homeDir)?.phase).toBe("abort-releasing");
    expect(liveConfig(t)).toBe(sourceConfig());
    expect(liveMap(t)).toBe(sourceMap());
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
    if (variant === "material-absent") unlinkSync(materialPath(t));
  };

  it.each(["material-present", "material-absent"] as const)("T4: an abort stopped at abort-releasing (%s) is finished through the coordinator alone, then reconciled", async (variant) => {
    const t = setup();
    await abortStoppedAfterRestore(t, variant);
    if (variant === "material-absent") {
      expect(readOwnPublicationSourceFromMaterial(t.homeDir, PUBLICATION_ID, LOCAL)).toMatchObject({ projectMap: { [LOCAL]: { remoteProjectId: REMOTE } } });
    }
    const since = t.lease.calls.length;

    const outcome = await runMigrationRollback(t.input, t.dependencies(traced(t, t.sharedLeaseCoordinator(undefined, FILE_BACKED))));

    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }]);
    expect(t.lease.calls.slice(since).filter((call) => call === "coordinator:abort")).toHaveLength(1);
    expectAbortBeforeAcquire(t, since);
    expectReconciled(t, outcome, 2n);
    // The re-prepared publication published both sqlite files again.
    expect(liveConfig(t)).toBe(targetConfig());
    expect(liveMap(t)).toBe(targetMap());
  });

  it("T4: the production input resolver reads the live files of an abort stopped after its material was consumed, and refuses files that differ", async () => {
    const t = setup();
    await abortStoppedAfterRestore(t, "material-absent");
    await expect(resolveWithRealOwnSourceReader(t)).resolves.toMatchObject({ input: { localProjectId: LOCAL }, target: { remoteProjectId: REMOTE } });

    writeFileSync(join(t.homeDir, ".lcm", "config.json"), '{"storage":{"backend":"sqlite"}}', { mode: 0o600 });
    await expect(resolveWithRealOwnSourceReader(t))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("live configuration is not the one") });
    expect(readBackendPublicationJournal(t.homeDir)?.phase).toBe("abort-releasing");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
  });

  it.each(["config", "map"] as const)("the production input resolver refuses a sealed aborted publication whose live %s was rewritten, leaving journal, effect and lease untouched", async (file) => {
    const t = setup();
    await crashFirstRun(t, "prepared");
    await t.sharedLeaseCoordinator().abort();
    await expect(resolveWithRealOwnSourceReader(t)).resolves.toMatchObject({ input: { localProjectId: LOCAL } });
    writeFileSync(
      join(t.homeDir, ".lcm", file === "config" ? "config.json" : "map.json"),
      file === "config" ? '{"storage":{"backend":"sqlite"}}' : JSON.stringify({ [LOCAL]: { canonical: "/elsewhere", aliases: [], remoteProjectId: REMOTE } }),
      { mode: 0o600 },
    );
    const journalBefore = readFileSync(backendPublicationJournalPath(t.homeDir), "utf8");
    const manifestBefore = t.store.read(GEN).checksumSha256;

    await expect(resolveWithRealOwnSourceReader(t))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining(file === "config" ? "live configuration is not the one" : "live project map is not the one") });
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator())))
      .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("project-map-unreadable") });

    expect(readFileSync(backendPublicationJournalPath(t.homeDir), "utf8")).toBe(journalBefore);
    expect(t.store.read(GEN).checksumSha256).toBe(manifestBefore);
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
    expect(t.opens).toEqual([{ recovery: false }]);
  });

  it("the source reader recognizes only this rollback's composition after an abort: another covered project reads as no source", async () => {
    const t = setup();
    await crashFirstRun(t, "prepared");
    await t.sharedLeaseCoordinator().abort();
    expect(readOwnPublicationSourceFromMaterial(t.homeDir, PUBLICATION_ID, "d".repeat(64))).toBeNull();
    expect(readOwnPublicationSourceFromMaterial(t.homeDir, PUBLICATION_ID, LOCAL)).not.toBeNull();
  });

  it("T5: a sealed aborted journal that is not this composition is refused untouched, before any session", async () => {
    const t = setup();
    await crashFirstRun(t, "prepared");
    await t.sharedLeaseCoordinator().abort();
    rewriteJournal(t.homeDir, (body) => { body.sourceBackend = "sqlite"; body.targetBackend = "postgresql"; });
    const journalBefore = readFileSync(backendPublicationJournalPath(t.homeDir), "utf8");

    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator())))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("not its composition") });

    expect(readFileSync(backendPublicationJournalPath(t.homeDir), "utf8")).toBe(journalBefore);
    expect(t.opens).toEqual([{ recovery: false }]);
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
  });

  it("T5: an abort-path journal that is not this composition is refused without calling the coordinator's abort", async () => {
    const t = setup();
    await crashFirstRun(t, "guarded");
    await expect(t.sharedLeaseCoordinator("abort-releasing").abort()).rejects.toThrow("crash at abort-releasing");
    rewriteJournal(t.homeDir, (body) => { body.sourceBackend = "sqlite"; body.targetBackend = "postgresql"; });
    const coordinator = traced(t, t.sharedLeaseCoordinator());

    await expect(runMigrationRollback(t.input, t.dependencies(coordinator)))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("not its composition") });

    expect(t.lease.calls).not.toContain("coordinator:abort");
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "abort-releasing", sourceBackend: "sqlite" });
    expect(t.opens).toEqual([{ recovery: false }]);
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
  });

  it.each([
    ["id", (body: any) => { body.publicationId = "another-publication"; }],
    ["phase", (body: any) => { body.phase = "abort-releasing"; }],
    ["reference", (body: any) => { body.recoveryReference = null; }],
    ["composition", (body: any) => { body.projects[0].evidenceSha256 = "0".repeat(64); }],
  ] as const)("an abort that does not settle as this rollback's aborted, referenced journal refuses before any session (%s)", async (_name, change) => {
    const t = setup();
    await crashFirstRun(t, "guarded");
    await expect(t.sharedLeaseCoordinator("abort-releasing").abort()).rejects.toThrow("crash at abort-releasing");
    const coordinator = t.sharedLeaseCoordinator();
    const abort = coordinator.abort.bind(coordinator);
    coordinator.abort = async (...args) => {
      const journal = await abort(...args);
      rewriteJournal(t.homeDir, change);
      return journal;
    };

    await expect(runMigrationRollback(t.input, t.dependencies(coordinator))).rejects.toMatchObject({ reason: "unexpected-state" });

    expect(t.opens).toEqual([{ recovery: false }]);
    expect(t.pending()?.kind).toBe("publish-rollback");
  });

  it("a slot that is empty after the abort refuses before any session", async () => {
    const t = setup();
    await crashFirstRun(t, "guarded");
    await expect(t.sharedLeaseCoordinator("abort-releasing").abort()).rejects.toThrow("crash at abort-releasing");
    const coordinator = t.sharedLeaseCoordinator();
    const abort = coordinator.abort.bind(coordinator);
    coordinator.abort = async (...args) => {
      const journal = await abort(...args);
      unlinkSync(backendPublicationJournalPath(t.homeDir));
      return journal;
    };

    await expect(runMigrationRollback(t.input, t.dependencies(coordinator)))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("did not settle as an aborted publication") });
    expect(t.opens).toEqual([{ recovery: false }]);
  });

  it("an aborted journal that still records an unreleased fence refuses before any session", async () => {
    const t = setup();
    await crashFirstRun(t, "guarded");
    await t.sharedLeaseCoordinator().abort();
    rewriteJournal(t.homeDir, (body) => { body.projects[0].fence.releasedAt = null; });

    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator())))
      .rejects.toMatchObject({ reason: "unexpected-state" });
    expect(t.opens).toEqual([{ recovery: false }]);
  });

  it("T6: the recovery session takes over this rollback's own expired lease and refuses a foreign unreleased one", async () => {
    const own = setup();
    await crashFirstRun(own, "prepared");
    await own.sharedLeaseCoordinator().abort();
    own.lease.state.row = { ...own.lease.state.row!, databaseExpired: true };
    const outcome = await runMigrationRollback(own.input, own.dependencies(own.sharedLeaseCoordinator()));
    expectReconciled(own, outcome, 2n);

    const foreign = setup();
    await crashFirstRun(foreign, "prepared");
    await foreign.sharedLeaseCoordinator().abort();
    foreign.lease.state.row = { ...foreign.lease.state.row!, publicationId: "another-publication" };
    await expect(runMigrationRollback(foreign.input, foreign.dependencies(foreign.sharedLeaseCoordinator())))
      .rejects.toMatchObject({ reason: "lease-unavailable" });
    expect(foreign.lease.state.row).toMatchObject({ publicationId: "another-publication", releasedAt: null });
    expect(foreign.pending()?.kind).toBe("publish-rollback");
  });

  it("C3 negative controls: an authority that disagrees with the artifact, an unresolvable live read and a missing artifact are not substituted", async () => {
    const artifactPath = (t: Fixture) => join(t.homeDir, ".lcm", "migration-rollback-authority", deriveRollbackAuthorityArtifactId(GEN) + ".json");
    const scenarios: ReadonlyArray<readonly [string, (t: Fixture) => void, Record<string, unknown>]> = [
      ["epoch", (t) => {
        const artifact = readRollbackAuthorityArtifact(t.homeDir, GEN)!;
        const { checksumSha256: _checksum, ...body } = artifact;
        unlinkSync(artifactPath(t));
        writeRollbackAuthorityArtifact(t.homeDir, { ...body, epochId: "another-epoch" });
      }, { reason: "unexpected-state", message: expect.stringContaining("disagrees with the durable rollback-authority artifact") }],
      ["unresolvable", (t) => { writeFileSync(backendPublicationJournalPath(t.homeDir), "{"); }, { reason: "not-eligible", message: expect.stringContaining("authority no longer resolves") }],
      ["artifact", (t) => { unlinkSync(artifactPath(t)); }, {
        reason: "unexpected-state", message: expect.stringContaining("its durable rollback authority artifact is absent"),
      }],
    ];
    for (const [, tamper, expected] of scenarios) {
      const t = setup();
      await crashFirstRun(t, "prepared");
      await t.sharedLeaseCoordinator().abort();
      const dependencies = t.dependencies(t.sharedLeaseCoordinator());
      const open = dependencies.openFencedSession;
      dependencies.openFencedSession = async (request) => {
        const session = await open(request);
        tamper(t);
        return session;
      };

      await expect(runMigrationRollback(t.input, dependencies)).rejects.toMatchObject(expected);

      expect(t.pending()?.kind).toBe("publish-rollback");
      expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
    }
  });

  it("C4: a sealed aborted journal reaching the publication step without a session is refused before anything is composed", async () => {
    const t = setup();
    await crashFirstRun(t, "released");
    const counts = { prepare: 0, resume: 0, abort: 0 };
    const coordinator = t.sharedLeaseCoordinator();
    for (const method of ["prepare", "resume", "abort"] as const) {
      const real = (coordinator[method] as (...args: unknown[]) => Promise<unknown>).bind(coordinator);
      (coordinator as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => { counts[method]++; return real(...args); };
    }
    const dependencies = t.dependencies(coordinator, {
      recordSelectionBinding: (request) => {
        // The slot turns into a sealed aborted journal between the released-row checks and the publication step.
        rewriteJournal(t.homeDir, (body) => { body.phase = "aborted"; });
        return recordMigrationSelectionBinding(request);
      },
    });

    await expect(runMigrationRollback(t.input, dependencies))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("only be composed again under a recovery session") });

    expect(counts).toEqual({ prepare: 0, resume: 0, abort: 0 });
    expect(t.pending()?.kind).toBe("publish-rollback");
  });

  /** resolveMigrationRollbackContext over stubbed manifest/snapshot/machine readers and the REAL own-publication-source reader. */
  function resolveWithRealOwnSourceReader(t: Fixture) {
    return resolveMigrationRollbackContext({ homeDir: t.homeDir, generationId: GEN }, {
      readManifest: () => ({ rollbackLineage: { preservedSourceGenerationId: "preserved" } }) as never,
      inspectSnapshot: (async () => ({
        artifact: {
          sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), sourceByteWitnessSha256: "7".repeat(64),
          authority: { physicalProjectId: LOCAL, projectDbPath: join(t.homeDir, "live.sqlite"), machineIdentity: { identityKey: "key", machineId: MACHINE } },
        },
        receiptReference: { queueCutoff: null },
      })) as never,
      requireMachineIdentity: (() => ({ machineId: MACHINE })) as never,
      readStorageConfig: () => { throw new Error("the live configuration must not be read"); },
      readProjectMap: (() => { throw new Error("the live project map must not be read"); }) as never,
      resolveIdentity: ((_config: unknown, local: { id: string; canonical: string; remoteProjectId: string }, _home: string, selectedPath: string) => ({
        id: local.remoteProjectId, canonical: local.canonical, remoteProjectId: local.remoteProjectId, machineId: MACHINE,
        selectedPath, localProjectId: local.id,
      })) as never,
      readOwnPublicationSource: DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES.readOwnPublicationSource,
    });
  }
});


describe("checkRollbackRecoveryAdmission", () => {
  const request = (homeDir: string, token: BackendPublicationLockToken, overrides: Partial<Parameters<typeof checkRollbackRecoveryAdmission>[0]> = {}) => ({
    homeDir, lockToken: token, generationId: GEN, publicationId: PUBLICATION_ID, machineId: MACHINE, ...overrides,
  });
  const check = (homeDir: string, overrides: Partial<Parameters<typeof checkRollbackRecoveryAdmission>[0]> = {}) =>
    withBackendPublicationAppendBarrierAsync(homeDir, (token) => checkRollbackRecoveryAdmission(request(homeDir, token, overrides)));

  /** A maintenance journal brought to the named phase by the real coordinator. */
  async function maintenanceAt(
    homeDir: string,
    phase: "maintenance-held" | "selection-prepared" | "selection-completed",
    options: { generationId?: string; publicationId?: string; roster?: Array<{ machineId: string; queueCutoff: null; evidenceSha256: string }>; target?: "sqlite" | "postgresql" } = {},
  ): Promise<void> {
    const coordinator = rollbackFixtureCoordinator(homeDir);
    const generationId = options.generationId ?? GEN;
    await withBackendPublicationAppendBarrierAsync(homeDir, async (token) => {
      const held = await coordinator.enterMaintenance({
        publicationId: options.publicationId ?? PUBLICATION_ID, generationId,
        sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64),
        roster: options.roster ?? [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "7".repeat(64) }],
      }, token);
      if (phase === "maintenance-held") return;
      const prepared = await coordinator.prepareMaintenanceSelection({
        expectedChecksumSha256: held.checksumSha256, generationId, targetBackend: options.target ?? "sqlite",
        terminalEvidenceSha256: "8".repeat(64),
      }, token);
      if (phase === "selection-prepared") return;
      await coordinator.completeMaintenanceSelection({
        expectedChecksumSha256: prepared.checksumSha256, generationId, terminalEvidenceSha256: "8".repeat(64),
      }, token);
    });
  }

  /** A publication journal in the live slot, at the named phase. */
  async function publicationAt(homeDir: string, publicationId: string, phase: "prepared" | "completed" | "aborted"): Promise<void> {
    const material = publicationMaterial();
    const coordinator = new BackendPublicationCoordinator({ homeDir, driver: workingPublicationDriver(material) });
    await coordinator.prepare({
      publicationId, sourceBackend: "sqlite", targetBackend: "postgresql", material,
      projects: [{ localProjectId: LOCAL, remoteProjectId: REMOTE, evidenceSha256: "a".repeat(64) }],
      now: new Date(capturedAt),
    });
    if (phase === "completed") await coordinator.resume();
    if (phase === "aborted") await coordinator.abort();
  }

  it.each(["selection-prepared", "selection-completed"] as const)("admits this rollback's own maintenance at %s", async (phase) => {
    const homeDir = tempHome();
    await maintenanceAt(homeDir, phase);
    const result = await check(homeDir);
    expect(result).toMatchObject({ status: "satisfied", quiescenceFence: { kind: "lcm-rollback-recovery-admission-v1" } });
    expect(JSON.parse(result.quiescenceFence!.payload)).toMatchObject({
      journal: "maintenance", phase, generationId: GEN, publicationId: PUBLICATION_ID, machineId: MACHINE,
    });
  });

  it("refuses a freshly held maintenance (that is the strict first-open path)", async () => {
    const homeDir = tempHome();
    await maintenanceAt(homeDir, "maintenance-held");
    expect(await check(homeDir)).toMatchObject({ status: "unsatisfied", quiescenceFence: null });
  });

  it("refuses a maintenance of another generation", async () => {
    const homeDir = tempHome();
    await maintenanceAt(homeDir, "selection-prepared", { generationId: "gen-other" });
    expect(await check(homeDir)).toMatchObject({ status: "unsatisfied" });
  });

  it("refuses a maintenance of another publication id", async () => {
    const homeDir = tempHome();
    await maintenanceAt(homeDir, "selection-prepared", { publicationId: "another-publication" });
    expect(await check(homeDir)).toMatchObject({ status: "unsatisfied" });
  });

  it("refuses a maintenance that selects another backend", async () => {
    const homeDir = tempHome();
    await maintenanceAt(homeDir, "selection-prepared", { target: "postgresql" });
    expect(await check(homeDir)).toMatchObject({ status: "unsatisfied" });
  });

  it("refuses a roster that is not this machine alone", async () => {
    const other = tempHome();
    await maintenanceAt(other, "selection-prepared", { roster: [{ machineId: OTHER_MACHINE, queueCutoff: null, evidenceSha256: "7".repeat(64) }] });
    expect(await check(other)).toMatchObject({ status: "unsatisfied", detail: expect.stringContaining("roster") });

    const several = tempHome();
    await maintenanceAt(several, "selection-prepared", { roster: [
      { machineId: MACHINE, queueCutoff: null, evidenceSha256: "7".repeat(64) },
      { machineId: OTHER_MACHINE, queueCutoff: null, evidenceSha256: "7".repeat(64) },
    ] });
    expect(await check(several)).toMatchObject({ status: "unsatisfied", detail: expect.stringContaining("roster") });
  });

  it("admits this rollback's own non-terminal publication once the maintenance was archived", async () => {
    const homeDir = tempHome();
    await publicationAt(homeDir, PUBLICATION_ID, "prepared");
    expect(existsSync(join(homeDir, ".lcm"))).toBe(true);
    const result = await check(homeDir);
    expect(result).toMatchObject({ status: "satisfied" });
    expect(JSON.parse(result.quiescenceFence!.payload)).toMatchObject({ journal: "publication", phase: "prepared" });
  });

  it("admits this rollback's own publication aborted after it sealed its material (#1555)", async () => {
    const homeDir = tempHome();
    await publicationAt(homeDir, PUBLICATION_ID, "aborted");
    expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "aborted", recoveryReference: expect.objectContaining({ sealSha256: expect.any(String) }) });
    const result = await check(homeDir);
    expect(result).toMatchObject({ status: "satisfied" });
    expect(JSON.parse(result.quiescenceFence!.payload)).toMatchObject({ journal: "publication", phase: "aborted" });
  });

  it("refuses a completed publication of this rollback, another publication, an aborted one of another id, and an empty slot", async () => {
    const homeDir = tempHome();
    await publicationAt(homeDir, PUBLICATION_ID, "completed");
    expect(await check(homeDir)).toMatchObject({ status: "unsatisfied" });
    const abortedForeign = tempHome();
    await publicationAt(abortedForeign, "another-publication", "aborted");
    expect(await check(abortedForeign)).toMatchObject({ status: "unsatisfied" });
    const foreign = tempHome();
    await publicationAt(foreign, "another-publication", "prepared");
    expect(await check(foreign)).toMatchObject({ status: "unsatisfied" });
    expect(await check(tempHome())).toMatchObject({ status: "unsatisfied" });
  });

  it("E6: admits this rollback's own publication the coordinator aborted from preparing without ever sealing material", async () => {
    const homeDir = tempHome();
    const material = publicationMaterial();
    const crashing = new BackendPublicationCoordinator({
      homeDir, driver: workingPublicationDriver(material),
      observer: (event) => { if (event === "before-material-seal") throw new Error("crash before the seal"); },
    });
    await expect(crashing.prepare({
      publicationId: PUBLICATION_ID, sourceBackend: "postgresql", targetBackend: "sqlite", material,
      projects: [{ localProjectId: LOCAL, remoteProjectId: REMOTE, evidenceSha256: "a".repeat(64) }],
    })).rejects.toThrow("crash before the seal");
    expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "preparing", recoveryReference: null });
    expect(await check(homeDir)).toMatchObject({ status: "satisfied" });

    await new BackendPublicationCoordinator({ homeDir, driver: workingPublicationDriver(material) }).abort();
    expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "aborted", recoveryReference: null });
    const result = await check(homeDir);
    expect(result).toMatchObject({ status: "satisfied" });
    expect(JSON.parse(result.quiescenceFence!.payload)).toMatchObject({ journal: "publication", phase: "aborted" });
  });
});

/**
 * #1808. A rollback interrupted inside its own rollback witness write leaves only the writer scratch of that witness
 * in the activation evidence store; the retry finishes exactly that write (single rollback: before the strict evidence
 * reads, in a short append barrier) and refuses anything it cannot prove. Real stores; only the injected witness
 * recorder plants the scratch and stops.
 */
describe("a rollback interrupted inside its rollback witness write (#1808)", () => {
  const strictRefusal = expect.stringContaining("activation-evidence:unresolvable");
  const artifactPath = (homeDir: string): string =>
    join(homeDir, ".lcm", "migration-rollback-authority", deriveRollbackAuthorityArtifactId(GEN) + ".json");
  const evidenceEntries = (homeDir: string): string[] => readdirSync(migrationActivationEvidenceDirectory(homeDir, GEN)).sort();
  const strictRead = (homeDir: string) => readMigrationActivationEvidence({ homeDir, generationId: GEN });

  /** The first run: stops inside the witness write, leaving the (optionally mutated) scratch of the witness it was writing. */
  const interrupted = (t: ReturnType<typeof setup>, mutate: (content: string) => string = (content) => content) =>
    t.dependencies(t.coordinator(), {
      recordActivationWitness: ({ witness }) => {
        plantEvidenceScratch(t.homeDir, witness, mutate(evidenceWire(witness)));
        throw new Error("crash inside the witness write");
      },
    });
  const interruptedRun = async (t: ReturnType<typeof setup>, mutate?: (content: string) => string): Promise<string> => {
    await expect(runMigrationRollback(t.input, interrupted(t, mutate))).rejects.toThrow("crash inside the witness write");
    const scratches = evidenceEntries(t.homeDir).filter((name) => name.endsWith(".tmp"));
    expect(scratches).toHaveLength(1);
    return join(migrationActivationEvidenceDirectory(t.homeDir, GEN), scratches[0]!);
  };
  /** Everything a refused recovery must leave as it found it. */
  const snapshot = (t: ReturnType<typeof setup>, scratch: string) => ({
    manifest: JSON.stringify(t.store.read(GEN)),
    maintenance: JSON.stringify(readBackendMaintenanceJournal(t.homeDir)),
    artifact: existsSync(artifactPath(t.homeDir)) ? readFileSync(artifactPath(t.homeDir), "utf8") : null,
    evidence: evidenceEntries(t.homeDir),
    scratch: readFileSync(scratch, "utf8"),
  });
  const rewriteMaintenance = (homeDir: string, mutate: (body: Record<string, unknown>) => void): void => {
    const journalPath = backendPublicationJournalPath(homeDir);
    const { checksumSha256: _checksum, ...journal } = JSON.parse(readFileSync(journalPath, "utf8"));
    mutate(journal);
    writeFileSync(journalPath, JSON.stringify({ ...journal, checksumSha256: backendPublicationCanonicalSha256(journal) }));
  };
  const replaceArtifact = (homeDir: string, change: Record<string, unknown>): void => {
    const { checksumSha256: _checksum, ...artifact } = readRollbackAuthorityArtifact(homeDir, GEN)!;
    unlinkSync(artifactPath(homeDir));
    writeRollbackAuthorityArtifact(homeDir, { ...artifact, ...change });
  };

  it("own resume: the retry finishes the interrupted witness write, completes the rollback and clears the scratch", async () => {
    const t = setup();
    const scratch = await interruptedRun(t);
    expect(t.store.read(GEN)).toMatchObject({ phase: "rolling-back", pendingEffect: null });
    expect(strictRead(t.homeDir)).toMatchObject({ state: "unresolvable" });

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.coordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(existsSync(scratch)).toBe(false);
    expect(strictRead(t.homeDir)).toMatchObject({ state: "resolved" });
    expect(evidenceEntries(t.homeDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readBackendMaintenanceJournal(t.homeDir)).toBeNull();
    expect((await runMigrationRollback(t.input, t.dependencies(t.coordinator()))).manifest.phase).toBe("rolled-back");
  });

  it("initial entry: a canonical rollback witness scratch left before the rollback begins is finished and the rollback completes", async () => {
    const t = setup();
    const scratch = plantEvidenceScratch(t.homeDir, storedRollbackWitness(t.homeDir));
    expect(strictRead(t.homeDir)).toMatchObject({ state: "unresolvable" });

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.coordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(existsSync(scratch)).toBe(false);
    expect(strictRead(t.homeDir)).toMatchObject({ state: "resolved" });
  });

  it("fresh entry with a scratch it cannot prove: refused as unresolvable with everything left as it was", async () => {
    const t = setup();
    const witness = storedRollbackWitness(t.homeDir);
    const scratch = plantEvidenceScratch(t.homeDir, witness, evidenceWire(witness) + " ");
    const before = snapshot(t, scratch);

    await expect(runMigrationRollback(t.input, t.dependencies(t.coordinator()))).rejects.toMatchObject({
      name: "RollbackOrchestrationError", reason: "not-eligible", message: strictRefusal,
    });

    expect(snapshot(t, scratch)).toEqual(before);
    expect(before.artifact).toBeNull();
    expect(before.maintenance).toBe("null");
  });

  it("own continuation with a scratch it cannot prove: refused as unresolvable with everything left as it was", async () => {
    const t = setup();
    const scratch = await interruptedRun(t, (content) => content + " ");
    const before = snapshot(t, scratch);
    expect(before.artifact).not.toBeNull();

    await expect(runMigrationRollback(t.input, t.dependencies(t.coordinator()))).rejects.toMatchObject({
      name: "RollbackOrchestrationError", reason: "unexpected-state",
      message: expect.stringMatching(/^continuing a prepared rollback: authority resolution now refuses: activation-evidence:unresolvable/u),
    });

    expect(snapshot(t, scratch)).toEqual(before);
  });

  it("fresh entry skips the recovery without an activation selection or when the artifact names another activation", async () => {
    const unbound = setup();
    const unboundScratch = plantEvidenceScratch(unbound.homeDir, storedRollbackWitness(unbound.homeDir));
    await expect(runMigrationRollback(unbound.input, unbound.dependencies(unbound.coordinator(), {
      resolveWitnessBindings: () => ({ state: "authoritatively-absent" }),
    }))).rejects.toMatchObject({ reason: "not-eligible", message: strictRefusal });
    expect(existsSync(unboundScratch)).toBe(true);

    const foreign = setup();
    const foreignScratch = plantEvidenceScratch(foreign.homeDir, storedRollbackWitness(foreign.homeDir));
    writeRollbackAuthorityArtifact(foreign.homeDir, {
      version: 2, generationId: GEN, operabilityFactState: "authoritatively-absent", operabilityFactValueSha256: null,
      epochId: "another-epoch", attemptId: "another-attempt",
      publication: {
        publicationId: "publication-1", sourceBackend: "sqlite", sourceProjectEntry: { localProjectId: LOCAL, remoteProjectId: REMOTE },
        sourceConfigSha256: "a".repeat(64), sourceProjectMapSha256: "b".repeat(64),
      },
    });
    await expect(runMigrationRollback(foreign.input, foreign.dependencies(foreign.coordinator())))
      .rejects.toMatchObject({ reason: "not-eligible", message: strictRefusal });
    expect(existsSync(foreignScratch)).toBe(true);
  });

  it("own continuation skips the recovery without the artifact or when it names another activation, keeping the existing refusal", async () => {
    const missing = setup();
    const missingScratch = await interruptedRun(missing);
    unlinkSync(artifactPath(missing.homeDir));
    await expect(runMigrationRollback(missing.input, missing.dependencies(missing.coordinator())))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("no durable rollback-authority artifact exists") });
    expect(existsSync(missingScratch)).toBe(true);

    const foreign = setup();
    const foreignScratch = await interruptedRun(foreign);
    replaceArtifact(foreign.homeDir, { epochId: "another-epoch" });
    await expect(runMigrationRollback(foreign.input, foreign.dependencies(foreign.coordinator())))
      .rejects.toMatchObject({ reason: "unexpected-state", message: strictRefusal });
    expect(existsSync(foreignScratch)).toBe(true);
  });

  it("a refusal of the short append barrier propagates before anything is recovered, leaving the scratch and the rollback state", async () => {
    const t = setup();
    const scratch = await interruptedRun(t);
    rewriteMaintenance(t.homeDir, (journal) => { journal.phase = "maintenance-entering"; });
    const before = snapshot(t, scratch);

    await expect(runMigrationRollback(t.input, t.dependencies(t.coordinator())))
      .rejects.toMatchObject({ message: expect.stringContaining("backend maintenance is not ready for local append") });

    expect(snapshot(t, scratch)).toEqual(before);
  });

  it("a pending publish-rollback stays strict: a qualifying extra rollback witness scratch is not published by the recovery of an aborted publication", async () => {
    vi.stubEnv("LCM_POSTGRES_URL", "postgresql://user:secret@example/db");
    try {
      const t = setup();
      await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("prepared")))).rejects.toThrow("crash at prepared");
      expect(t.pending()?.kind).toBe("publish-rollback");
      await t.sharedLeaseCoordinator().abort();
      const extra = storedRollbackWitness(t.homeDir, 1);
      const scratch = plantEvidenceScratch(t.homeDir, extra);
      const before = snapshot(t, scratch);

      await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator()))).rejects.toMatchObject({
        reason: "unexpected-state", message: expect.stringContaining("no stored rollback witness to take its mode from"),
      });

      expect(snapshot(t, scratch)).toEqual(before);
      expect(evidenceEntries(t.homeDir)).not.toContain("witness-" + extra.checksumSha256 + ".json");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
