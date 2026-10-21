/**
 * Tests for src/migration/rollback.ts's runMigrationRollback orchestration
 * (plan-v2 section 5's twelve steps).
 *
 * SCOPE, stated honestly. This file exercises the orchestration logic --
 * recovery classification, maintenance entry/exit, the prepare-rollback
 * and publish-rollback effect lifecycle, report persistence, and binding
 * writes -- against a REAL BackendPublicationCoordinator and a REAL
 * MigrationManifestStore, using injected FAKES only for the boundaries
 * runMigrationRollback itself takes as required dependencies (Boundaries
 * A, B, D, D2, E, F). It does not exercise a live PostgreSQL fenced
 * session (Boundary F's real implementation does not exist on this
 * branch -- see rollback.ts's module doc); RollbackFencedSession is
 * faked here to a SQLite-backed PortableRecordStream, exactly the same
 * discipline rollback-generation.test.ts already uses for
 * buildRollbackGeneration.
 *
 * This is NOT the full plan-v2 section 7 mandatory test list. In
 * particular it does not include a PG18-sourced drift test (no real
 * PostgreSQL harness is exercised here at all) or the full red-proof
 * mutation matrix that list requires; see this item's status report for
 * the explicit list of what remains.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, chmodSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  openSqlitePortableSource,
  sqlitePortableFileSha256,
} from "../../src/storage/sqlite/portable-source.js";
import { createPortableRecordStream, type PortableRecordStream } from "../../src/storage/portable-record-stream.js";
import { canonicalSha256, PORTABLE_RECORD_SCHEMA_SHA256 } from "../../src/storage/portable-record.js";
import {
  BackendPublicationCoordinator,
  assertBackendPublicationConsumerAccess,
  backendPublicationCanonicalSha256,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationConsumerLockAsync,
  backendPublicationJournalPath,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { createMigrationActivationWitness } from "../../src/migration/activation-witness.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  migrationActivationEvidenceDirectory,
  readMigrationActivationEvidence,
  recordMigrationActivationAttempt,
  recordMigrationActivationEpoch,
  recordMigrationActivationWitness,
} from "../../src/migration/activation-evidence-store.js";
import {
  MigrationBindingUnresolvableError,
  migrationGenerationBindingDirectory,
  recordMigrationSelectionBinding,
  recordMigrationWitnessBinding,
  resolveMigrationWitnessBindings,
} from "../../src/migration/generation-binding-store.js";
import { originalRollbackPreemption, readRollbackPreemptionRecord } from "../../src/migration/rollback-install.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { deriveActivationPublicationId } from "../../src/migration/activation-publication-id.js";
import {
  FIXTURE_LOCAL_PROJECT_ID,
  FIXTURE_REMOTE_PROJECT_ID,
  activationPublicationMaterial,
  publicationMaterial,
  rollbackFixtureCoordinator,
  rollbackPublicationMaterial,
  workingPublicationDriver,
} from "../fixtures/backend-publication-driver.js";
import { clearProjectMapCache, projectMapPath } from "../../src/project-map.js";
import {
  createMigrationManifest,
  beginMigrationEffect,
  completeMigrationEffect,
  type MigrationManifest,
  type MigrationStorageWitness,
} from "../../src/migration/protocol.js";
import {
  runMigrationRollback,
  readRollbackReport,
  RollbackOrchestrationError,
  deriveRollbackPublicationId,
  deriveRollbackReportId,
  deriveRollbackPrepareInputSha256,
  writeRollbackAuthorityArtifact,
  writeRollbackReport,
  deriveRollbackAuthorityArtifactId,
  readRollbackAuthorityArtifact,
  readBackendPublicationOperabilityFact,
  readOwnPublicationSourceFromMaterial,
  rollbackGenerationBuildBase,
  type RunMigrationRollbackDependencies,
  type RollbackFencedSession,
  type MigrationSelectionBindingRecorder,
  type MigrationWitnessBindingRecorder,
} from "../../src/migration/rollback.js";
import {
  fixtureActivationScenario,
  fixtureActivationWitness,
  fixtureAttempt,
  fixtureBindingsAbsent,
  fixtureBindingsUnresolvable,
  fixtureCanonicalDelta,
  fixtureCensusVector,
  fixtureDestinationIdentity,
  fixtureEpoch,
  fixtureEvidenceAbsent,
} from "../fixtures/migration-activation-records.js";

/**
 * PR #1556 thread 4307516130: a refused rollback aborts a maintenance window whose source is PostgreSQL. The
 * real consumer admission and replay admission must keep answering PostgreSQL for that aborted window, never
 * the activation-only "abort selects SQLite" reading. Replay admission answers from the generation's selection
 * bindings first (plan-v3.2 A15): a generation that was never activated has none, so its abort evidence is
 * admitted as a PostgreSQL source-abort; a generation with its activation binding answers PostgreSQL for the
 * activation witness and refuses the abort evidence outright.
 */
function expectAbortedWindowKeepsPostgreSql(homeDir: string, generationId: string, bound: "never-activated" | "activated"): void {
  const maintenance = readBackendMaintenanceJournal(homeDir)!;
  expect(maintenance).toMatchObject({ phase: "maintenance-aborted", sourceBackend: "postgresql" });
  expect(() => assertBackendPublicationConsumerAccess({ backend: "postgresql", homeDir })).not.toThrow();
  expect(() => assertBackendPublicationConsumerAccess({ backend: "sqlite", homeDir }))
    .toThrow(expect.objectContaining({ reason: "backend-mismatch" }));
  const abortEvidenceSha256 = maintenance.abortEvidenceSha256!;
  if (bound === "never-activated") {
    expect(assertMigrationReplayAdmission({ homeDir, generationId, evidenceSha256: abortEvidenceSha256 }))
      .toEqual({ backend: "postgresql", disposition: "source-abort" });
    return;
  }
  const bindings = resolveMigrationWitnessBindings({ homeDir, generationId });
  expect(bindings.state).toBe("resolved");
  const activation = (bindings as Extract<typeof bindings, { state: "resolved" }>).selections.at(-1)!;
  expect(activation.kind).toBe("activation");
  expect(assertMigrationReplayAdmission({ homeDir, generationId, evidenceSha256: activation.witnessChecksumSha256 }))
    .toEqual({ backend: "postgresql", disposition: "selected" });
  expect(() => assertMigrationReplayAdmission({ homeDir, generationId, evidenceSha256: abortEvidenceSha256 }))
    .toThrow(expect.objectContaining({ reason: "unresolved-publication" }));
}

/** A project map whose only remote binding is the covered project (plan-v3.2 A14). */
const COVERED_REMOTE_PROJECT_ID = FIXTURE_REMOTE_PROJECT_ID;

/** What an authoritative rollback persists of the activation's retained publication (plan-v3.1 A8). */
const PUBLICATION_SOURCE = {
  publicationId: "publication-1",
  sourceBackend: "sqlite" as const,
  sourceProjectEntry: { localProjectId: FIXTURE_LOCAL_PROJECT_ID, remoteProjectId: null },
  sourceConfigSha256: "a".repeat(64),
  sourceProjectMapSha256: "b".repeat(64),
};
function coveredOnlyProjectMap(localProjectId: string): ReturnType<NonNullable<RunMigrationRollbackDependencies["readProjectMap"]>> {
  return { [localProjectId]: { canonical: "/covered", aliases: [], remoteProjectId: COVERED_REMOTE_PROJECT_ID } };
}

/**
 * The activation's retained publication, as readRetainedBackendPublicationMaterial reports it for the default
 * scenario's activation selection binding (publication-1).
 */
function retainedActivationPublication(
  publicationId = "publication-1",
): ReturnType<NonNullable<RunMigrationRollbackDependencies["readRetainedMaterial"]>> {
  return {
    status: "present",
    journal: { publicationId, sourceBackend: "sqlite", targetBackend: "postgresql" } as never,
    material: activationPublicationMaterial(),
  };
}

/** The composer's result for the rollback fixture: the rollback material for exactly the bindings asked for. */
const composeRollbackPublication: NonNullable<RunMigrationRollbackDependencies["composePublication"]> = (composeInput) => ({
  sourceBackend: "postgresql",
  targetBackend: composeInput.targetBackend,
  material: rollbackPublicationMaterial(),
  projects: composeInput.bindings,
});

/**
 * runMigrationRollback over the covered project (the fixtures' fixed 64-hex id) as the sole remotely bound
 * project, with the activation's retained publication, the rollback publication composer and the evidence
 * store's witness writer stubbed, unless a test says otherwise.
 */
function runRollback(
  input: Parameters<typeof runMigrationRollback>[0],
  deps: RunMigrationRollbackDependencies,
): ReturnType<typeof runMigrationRollback> {
  return runMigrationRollback({ ...input, localProjectId: FIXTURE_LOCAL_PROJECT_ID }, {
    readProjectMap: () => coveredOnlyProjectMap(FIXTURE_LOCAL_PROJECT_ID),
    readRetainedMaterial: () => retainedActivationPublication(),
    composePublication: composeRollbackPublication,
    recordActivationWitness: () => undefined,
    ...deps,
  });
}

// Post-write cases build, verify and install real SQLite generations; under
// coverage instrumentation that exceeds the 5s default.
vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-orch-home-"));
  mkdirSync(join(dir, ".lcm"), { mode: 0o700 });
  dirs.push(dir);
  return dir;
}

const identity = { scope: "local" as const, projectId: "a".repeat(64) };
const facts = { machines: [{ identityKey: "local-machine", machineId: null }], aliases: [] };
const capturedAt = "2026-09-06T00:00:00.000Z";
const sourceCapturedAt = "2026-09-06T00:00:00.000000Z";

function sqliteFixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-orch-src-"));
  dirs.push(dir);
  const path = join(dir, "source.db");
  const db = new DatabaseSync(path);
  try { runLcmMigrations(db, { fts5Available: false }); } finally { db.close(); }
  chmodSync(path, 0o600);
  return { dir, path };
}

async function sqliteSourceStream(): Promise<PortableRecordStream> {
  const file = sqliteFixture();
  return createPortableRecordStream(await openSqlitePortableSource({
    databasePath: file.path,
    scratchParent: file.dir,
    projectIdentity: identity,
    identityFacts: facts,
    expectedFileSha256: sqlitePortableFileSha256(file.path),
    expectedFactsSha256: canonicalSha256(facts),
    capturedAt: sourceCapturedAt,
    capturedSidecars: {
      events: { absent: true, evidenceSha256: "f".repeat(64) },
      instructions: { absent: true, evidenceSha256: "e".repeat(64) },
    },
  }));
}

function unexpectedDriver(): BackendPublicationDriver {
  const unexpected = async (): Promise<never> => {
    throw new Error("driver must not run: this orchestration never calls project-map/config publication");
  };
  return {
    observeLocalState: unexpected,
    publishProjectMap: unexpected,
    publishConfig: unexpected,
    restoreConfig: unexpected,
    restoreProjectMap: unexpected,
  };
}

function coordinatorFor(homeDir: string): BackendPublicationCoordinator {
  return rollbackFixtureCoordinator(homeDir);
}

/** Binding store and evidence store both authoritatively empty: nothing was ever activated. */
function absentDeps() {
  return {
    resolveWitnessBindings: () => fixtureBindingsAbsent,
    resolveActivationEvidence: () => fixtureEvidenceAbsent,
  } as const;
}

/** The stores as one published activation leaves them, with the full records its selection names. */
function authoritativeDeps(scenario: ReturnType<typeof fixtureActivationScenario>) {
  return {
    resolveWitnessBindings: () => scenario.bindings,
    resolveActivationEvidence: () => scenario.evidence,
    resolveAuthoritativeContext: async () => scenario.context,
  } as const;
}

// ---------------------------------------------------------------------------
// donadiosolutions/lcm#1432 disagreement-refusal tests: a REAL completed
// postgresql BackendPublicationJournal, constructed via a fake driver
// (no live PostgreSQL, no network) so the "live side" of the
// operability-fact disagreement check can be independently corrupted
// with a genuinely resolvable "present" fact, not merely a fabricated
// artifact. Mirrors test/backend-publication.test.ts's own
// material()/makeDriver()/prepare()+resume() pattern -- deliberately NOT
// imported from that file (test files do not share fixtures across
// modules in this repo) but faithful to the same construction.
// ---------------------------------------------------------------------------

/**
 * Drives a REAL BackendPublicationCoordinator through prepare()+resume()
 * against a fake (in-memory) driver, landing a genuine version-2
 * BackendPublicationJournal at phase "completed", targetBackend
 * "postgresql", in the live slot -- exactly the state
 * readBackendPublicationOperabilityFact resolves as "present". No
 * maintenance journal is ever touched, so this never collides with the
 * rollback orchestration's own enterMaintenance in the same homeDir.
 */
async function establishCompletedPostgresqlPublication(homeDir: string): Promise<void> {
  const materialInput = publicationMaterial();
  const driver = workingPublicationDriver(materialInput);
  const pub = new BackendPublicationCoordinator({ homeDir, driver });
  await pub.prepare({
    publicationId: "disagreement-fixture-publication",
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    material: materialInput,
    projects: [{ localProjectId: "local-project", remoteProjectId: "remote-project", evidenceSha256: "a".repeat(64) }],
    now: new Date(capturedAt),
  });
  await pub.resume();
}

function storageWitness(backend: "sqlite" | "postgresql", seed: string): MigrationStorageWitness {
  return {
    version: 1,
    backend,
    identitySha256: seed.repeat(64).slice(0, 64),
    schemaSha256: "2".repeat(64),
    contentSha256: "3".repeat(64),
    capturedAt,
  };
}

/** Drives a fresh manifest all the way to phase "verified" via the ordinary forward-migration effect sequence, matching protocol.ts's legalEffect chain. */
function manifestAtVerified(store: MigrationManifestStore, generationId: string): MigrationManifest {
  let m = store.create(createMigrationManifest({
    generationId,
    source: storageWitness("sqlite", "1"),
    destination: storageWitness("postgresql", "4"),
    parentGenerationId: null,
    preservedSourceGenerationId: generationId,
    createdAt: capturedAt,
  }));
  const step = (kind: string, extra: Record<string, unknown> = {}) => {
    m = store.update(generationId, m.checksumSha256, (current) => beginMigrationEffect(current, {
      kind: kind as never, effectId: kind, inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
    m = store.update(generationId, m.checksumSha256, (current) => completeMigrationEffect(current, {
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
  return m;
}

function fakeSession(input: Readonly<{
  resourceType?: string;
  resourceKey?: string;
  observations: readonly Readonly<{
    destinationIdentity: ReturnType<typeof fixtureDestinationIdentity>;
    postEpochDelta: ReturnType<typeof fixtureCanonicalDelta>;
    postEpochCensus: ReturnType<typeof fixtureCensusVector> | null;
  }>[];
  source: () => Promise<PortableRecordStream>;
  /** What the export snapshot reports; defaults to the first observation's delta and a fixed census. */
  exportEvidence?: Readonly<{ canonicalDelta: ReturnType<typeof fixtureCanonicalDelta>; censusVector: ReturnType<typeof fixtureCensusVector> }>;
  /** The census a requireCensus readback reports; defaults to the export census. */
  requiredCensus?: ReturnType<typeof fixtureCensusVector>;
}>): RollbackFencedSession {
  let call = 0;
  const exportEvidence = input.exportEvidence ?? {
    canonicalDelta: input.observations[0]!.postEpochDelta,
    censusVector: fixtureCensusVector("fake-export-census"),
  };
  return {
    selectionAuthority: {
      version: 1,
      resourceType: input.resourceType ?? "sqlite-generation",
      resourceKey: input.resourceKey ?? "gen",
      fencingToken: "fence-1",
      ownerProcessId: "proc-1",
    },
    quiescenceFenceEvidenceSha256: "q".repeat(64),
    async renew(): Promise<void> {},
    markCoordinatorAcquired(): void {},
    async captureReadback(request) {
      const observed = input.observations[Math.min(call, input.observations.length - 1)]!;
      call += 1;
      const census = observed.postEpochCensus
        ?? (request.requireCensus === true ? (input.requiredCensus ?? exportEvidence.censusVector) : null);
      return {
        observedPortableRecordSchemaSha256: census === null ? "irrelevant" : PORTABLE_RECORD_SCHEMA_SHA256,
        destinationIdentity: observed.destinationIdentity,
        postEpochDelta: observed.postEpochDelta,
        postEpochCensus: census,
      };
    },
    async openPortableSource() {
      return { stream: await input.source(), ...exportEvidence };
    },
    async closeKeepingLease(): Promise<void> {},
    async release(): Promise<void> {},
    computeRollbackTerminalEvidenceSha256(evidence): string {
      if (evidence.epoch === null || evidence.attempt === null) {
        return canonicalSha256(["test-terminal-evidence-v1", evidence]);
      }
      // The same witness the orchestration mints from the same records.
      return createMigrationActivationWitness({
        kind: "rollback", epoch: evidence.epoch, attempt: evidence.attempt,
        postEpochDelta: evidence.observation.postEpochDelta!, postEpochCensus: evidence.observation.postEpochCensus,
        rollbackMode: evidence.mode,
      }).checksumSha256;
    },
  };
}

/**
 * An authoritative activation of generationId whose destination is unchanged since its epoch (pre-write): the
 * stores' dependencies, a session observing the baseline and the authority artifact a rollback of it persists.
 */
function preWriteActivation(generationId: string) {
  const destinationIdentity = fixtureDestinationIdentity("d");
  const baseline = fixtureCanonicalDelta("baseline");
  const census = fixtureCensusVector("census");
  const scenario = fixtureActivationScenario({ generationId, destinationIdentity, censusVector: census, canonicalDeltaBaseline: baseline });
  return {
    scenario,
    deps: authoritativeDeps(scenario),
    session: async (): Promise<RollbackFencedSession> => fakeSession({
      observations: [{ destinationIdentity, postEpochDelta: baseline, postEpochCensus: census }],
      source: sqliteSourceStream,
    }),
    artifact: () => ({
      version: 2 as const, generationId, operabilityFactState: "authoritatively-absent" as const,
      operabilityFactValueSha256: null, epochId: scenario.selection.epochId, attemptId: scenario.selection.attemptId,
      publication: PUBLICATION_SOURCE,
    }),
  };
}

const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const ROSTER = [{ machineId: MACHINE_ID, queueCutoff: null, evidenceSha256: "7".repeat(64) }];

describe("runMigrationRollback", () => {
  it("refuses immediately when the generation is already settled at a terminal, non-active phase", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    let m = manifestAtVerified(store, "gen-settled");
    m = store.update("gen-settled", m.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "prepare-rollback", effectId: "pr", inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
    m = store.update("gen-settled", m.checksumSha256, (c) => completeMigrationEffect(c, { effectId: "pr", completedAt: capturedAt }));
    m = store.update("gen-settled", m.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "publish-rollback", effectId: "pub", inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
    m = store.update("gen-settled", m.checksumSha256, (c) => completeMigrationEffect(c, {
      effectId: "pub", completedAt: capturedAt,
      report: { kind: "rollback", reportId: "r3", reportSha256: "b".repeat(64), createdAt: capturedAt },
      rollbackMode: "pre-write",
    }));
    expect(m.phase).toBe("rolled-back");

    await expect(runRollback({

      homeDir, generationId: "gen-settled", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => { throw new Error("must not open a session for a settled generation"); },
    })).rejects.toMatchObject({ name: "RollbackOrchestrationError", reason: "unexpected-state" });
  });

  it("refuses before any durable change when witness-binding resolution is unresolvable, entering no maintenance", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-refuse");

    await expect(runRollback({
      homeDir, generationId: "gen-refuse", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => fixtureBindingsUnresolvable("simulated read failure"),
      resolveActivationEvidence: () => fixtureEvidenceAbsent,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => { throw new Error("must not open a session when authority is refused"); },
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
    });

    // Breakable independently: the positive control below (an absent binding store
    // instead of an unresolvable one, same everything else) reaches maintenance and a
    // different failure point, proving this assertion is not vacuously true.
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
  });

it("refuses a generation that was never activated before any durable change (an absent binding store is the generation's own, not a read failure)", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-control");

    await expect(runRollback({
      homeDir, generationId: "gen-control", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => { throw new Error("must not open a session for an unactivated generation"); },
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
      message: expect.stringContaining("never completed an activation"),
    });

    // Unlike the unresolvable case above, this is the authority's own answer; either way nothing is written.
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    expect(readRollbackAuthorityArtifact(homeDir, "gen-control")).toBeNull();
    const manifest = new MigrationManifestStore({ homeDir }).read("gen-control");
    expect(manifest.phase).toBe("verified");
    expect(manifest.pendingEffect).toBeNull();
  });

  it("F3: a failing directory flush after the install leaves the maintenance held and no selection prepared", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-sync-fail");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const coordinator = coordinatorFor(homeDir);
    const prepare = vi.spyOn(coordinator, "prepareMaintenanceSelection");

    await expect(runRollback({
      homeDir, generationId: "gen-sync-fail", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-post",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity, censusVector: fixtureCensusVector("census"), canonicalDeltaBaseline: fixtureCanonicalDelta("baseline"),
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      syncDirectory: () => { throw new Error("EIO: directory sync failed"); },
      openFencedSession: async () => fakeSession({
        observations: [{
          destinationIdentity, postEpochDelta: fixtureCanonicalDelta("changed"), postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    })).rejects.toThrow("flushed");

    expect(prepare).not.toHaveBeenCalled();
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    expect(new MigrationManifestStore({ homeDir }).read("gen-sync-fail").pendingEffect?.kind).toBe("publish-rollback");
  });

  it("post-write: builds, installs, materializes, publishes, and reports, ending at phase rolled-back", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-post");
    const canonicalPath = join(homeDir, "live.sqlite");
    const selectionBindings: unknown[] = [];
    const witnessBindings: unknown[] = [];
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("baseline");

    const outcome = await runRollback({
      homeDir, generationId: "gen-post", canonicalPath,
      projectIdentity: identity, localProjectId: "local-post",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: destinationIdentity, censusVector: fixtureCensusVector("census"), canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: (input) => { selectionBindings.push(input.binding); },
      recordWitnessBinding: (input) => { witnessBindings.push(input.binding); },
      openFencedSession: async () => fakeSession({
        observations: [{
          destinationIdentity,
          // Deliberately different from the baseline -- classifyMigrationRollbackMode
          // returns "post-write" as soon as the deltas differ, on the delta axis
          // alone, independent of the census.
          postEpochDelta: fixtureCanonicalDelta("changed"),
          postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    });

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.mode).toBe("post-write");
    expect(outcome.report!.eligibility).toBe("post-write");

    // Breakable independently: the report on disk is a fresh read, not
    // the in-memory return value.
    const reread = readRollbackReport(homeDir, "gen-post", outcome.report!.reportId);
    expect(reread).not.toBeNull();
    expect(reread!.checksumSha256).toBe(outcome.report!.checksumSha256);

    expect(selectionBindings).toHaveLength(1);
    expect(witnessBindings).toHaveLength(1);
    expect((selectionBindings[0] as { kind: string }).kind).toBe("rollback");
    expect((witnessBindings[0] as { kind: string }).kind).toBe("rollback");

    // The coordinator's own publication archived the terminal maintenance journal out of the live slot and
    // completed: the sqlite config and project map are published, and the report carries the sealed digest.
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    const publication = readBackendPublicationJournal(homeDir);
    expect(publication).toMatchObject({
      phase: "completed", publicationId: deriveRollbackPublicationId("gen-post"),
      sourceBackend: "postgresql", targetBackend: "sqlite",
    });
    expect(outcome.report!.sealedPublicationMaterialDigestSha256).toBe(publication!.recoveryReference!.sealSha256);

    const installed = new DatabaseSync(canonicalPath, { readOnly: true });
    try {
      const row = installed.prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'portable_archive_%'",
      ).get() as { n: number };
      expect(row.n).toBeGreaterThan(0);
    } finally {
      installed.close();
    }
  });

  it("aborts maintenance cleanly when eligibility refuses after maintenance is already entered", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-refuse-late");
    const destinationIdentity = fixtureDestinationIdentity("d");

    await expect(runRollback({
      homeDir, generationId: "gen-refuse-late", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      // A destination identity that will NOT match the observation below --
      // the identity gate refuses before any durable change other than the
      // maintenance entry itself.
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: fixtureDestinationIdentity("different"),
        canonicalDeltaBaseline: fixtureCanonicalDelta("baseline"),
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => fakeSession({
        observations: [{
          destinationIdentity,
          postEpochDelta: fixtureCanonicalDelta("changed"),
          postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    })).rejects.toMatchObject({ name: "RollbackOrchestrationError", reason: "not-eligible" });

   const maintenance = readBackendMaintenanceJournal(homeDir);
   expect(maintenance?.phase).toBe("maintenance-aborted");
   // The real consumer and replay admission stay on PostgreSQL after the refusal (step-4 readback abort site).
   expectAbortedWindowKeepsPostgreSql(homeDir, "gen-refuse-late", "never-activated");
 });

  it("refuses as a racing post-activation write when step 10's revalidation observes a mode change from step 9's, leaving the generation preserved and unreferenced", async () => {
    // A pre-write decision at step 9 (delta matches baseline, census
    // matches) followed by a DIFFERENT observation at step 10 (delta now
    // drifted, simulating a write that landed inside the fenced window
    // between the two readbacks). Breakable independently: the positive
    // control below (identical setup, but the second observation equals
    // the first) completes successfully instead of refusing, proving this
    // refusal comes from the mismatch and not from the fixture shape.
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-race");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("race-baseline");
    const census = fixtureCensusVector("race-census");

    await expect(runRollback({
      homeDir, generationId: "gen-race", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: destinationIdentity, censusVector: census, canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => fakeSession({
        observations: [
          {
            destinationIdentity, postEpochDelta: baseline, postEpochCensus: census,
          },
          {
            destinationIdentity, postEpochDelta: fixtureCanonicalDelta("race-write-landed"), postEpochCensus: null,
          },
        ],
        source: sqliteSourceStream,
      }),
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "drift",
      message: expect.stringContaining("revalidation observed mode"),
    });

    const manifest = new MigrationManifestStore({ homeDir }).read("gen-race");
    expect(manifest.phase).toBe("rolling-back");
    expect(manifest.pendingEffect).toBeNull();
  });

  it("positive control for the race test above: an unchanged second observation completes as pre-write instead of refusing", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-race-control");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("race-control-baseline");
    const census = fixtureCensusVector("race-control-census");
    const observation = {
      destinationIdentity, postEpochDelta: baseline, postEpochCensus: census,
    };

    const outcome = await runRollback({
      homeDir, generationId: "gen-race-control", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: destinationIdentity, censusVector: census, canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => fakeSession({ observations: [observation, observation], source: sqliteSourceStream }),
    });
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
  });

  it("takeover-and-retry: resolves the epoch/attempt via the BOUND attempt only, never the unbound one, even though both are present as witnesses", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-takeover");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baselineBound = fixtureCanonicalDelta("bound-baseline");
    const censusBound = fixtureCensusVector("bound-census");
    const baselineUnboundWrong = fixtureCanonicalDelta("unbound-wrong-baseline");
    const selectionBindings: unknown[] = [];
    const witnessBindings: unknown[] = [];
    const resolveAuthoritativeContextCalls: string[] = [];

    // Two attempts share one epoch after a takeover: the old attempt was
    // superseded and never selected (a witness only); the new attempt is
    // the one an actual selection was published against. Both witnesses are
    // recorded in both stores -- only the new attempt has a selection.
    const epoch = fixtureEpoch({ generationId: "gen-takeover", seed: "takeover", destinationIdentity, censusVector: censusBound });
    const attemptOld = fixtureAttempt({ epoch, seed: "old", canonicalDeltaBaseline: baselineUnboundWrong });
    const attemptNew = fixtureAttempt({ epoch, seed: "new", canonicalDeltaBaseline: baselineBound });
    const witnessOld = fixtureActivationWitness(epoch, attemptOld);
    const witnessNew = fixtureActivationWitness(epoch, attemptNew);
    const bindingFor = (attempt: typeof attemptOld, witness: typeof witnessOld, manifestRevision: number) => ({
      kind: "activation" as const, epochId: epoch.epochId, attemptId: attempt.attemptId,
      manifestRevision, witnessChecksumSha256: witness.checksumSha256,
    });
    const resolution = {
      state: "resolved" as const,
      witnesses: [bindingFor(attemptOld, witnessOld, 1), bindingFor(attemptNew, witnessNew, 2)],
      selections: [{ ...bindingFor(attemptNew, witnessNew, 2), publicationId: "pub-new" }],
    };

    const outcome = await runRollback({
      homeDir, generationId: "gen-takeover", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      readRetainedMaterial: () => retainedActivationPublication("pub-new"),
      resolveWitnessBindings: () => resolution,
      resolveActivationEvidence: () => ({
        state: "resolved", epochs: [epoch], attempts: [attemptOld, attemptNew], witnesses: [witnessOld, witnessNew],
      }),
      recordSelectionBinding: (input) => { selectionBindings.push(input.binding); },
      recordWitnessBinding: (input) => { witnessBindings.push(input.binding); },
      resolveAuthoritativeContext: async (input) => {
        resolveAuthoritativeContextCalls.push(input.attemptId);
        // If this were ever reached with the unbound attempt, its
        // mismatching baseline makes the wrong-attempt path diverge
        // (post-write here vs. pre-write below) rather than silently
        // agreeing with the correct path's outcome.
        return { epoch, attempt: input.attemptId === attemptNew.attemptId ? attemptNew : attemptOld, witness: null };
      },
      openFencedSession: async () => fakeSession({
        observations: [{
          destinationIdentity, postEpochDelta: baselineBound, postEpochCensus: censusBound,
        }],
        source: sqliteSourceStream,
      }),
    });

    expect(resolveAuthoritativeContextCalls).toEqual([attemptNew.attemptId]);
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    expect(selectionBindings).toHaveLength(1);
    expect(witnessBindings).toHaveLength(1);
    expect((selectionBindings[0] as { attemptId: string }).attemptId).toBe(attemptNew.attemptId);
    expect((witnessBindings[0] as { attemptId: string }).attemptId).toBe(attemptNew.attemptId);
   expect(existsSync(join(homeDir, "live.sqlite"))).toBe(false);
 });

  // donadiosolutions/lcm#1432. Three separate crash-and-resume tests,
  // one per named boundary plan-v2 section 7 requires interruption
  // recovery for: (1) maintenance entered but prepare-rollback never
  // begun, (2) prepare-rollback begun but not completed, (3) prepare-
  // rollback completed (continueAfterPrepareRollback's own domain --
  // this is the crash the withdrawn predecessor test targeted). All
  // three previously failed because readBackendPublicationOperabilityFact
  // observes the still-held maintenance journal on any retry and
  // answers "unresolvable", which resolveActivationAuthority turns into
  // a permanent refusal; (1) and (2) additionally failed because
  // enterMaintenance itself refuses to re-enter an already-held
  // journal. Each test reconstructs its crash point precisely (manual
  // state construction for (1)/(2), a REAL crash via a throwing fake
  // session for (3)) against a REAL BackendPublicationCoordinator and
  // MigrationManifestStore, then retries and asserts success.

  it("resumes after a crash between step 2 and step 7: maintenance is held, no prepare-rollback effect was ever begun (donadiosolutions/lcm#1432)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-resume-2-7");
    const activation = preWriteActivation("gen-resume-2-7");
    const canonicalPath = join(homeDir, "live.sqlite");
    const coordinator = coordinatorFor(homeDir);

    // Simulates the crash: step 2 (enterMaintenance) durably succeeded
    // and the durable rollback-authority artifact was persisted (both
    // steps runMigrationRollback performs before entering the retained
    // token window), then the process died before step 3 ever opened a
    // session -- so the manifest is untouched, still phase "verified"
    // with no pending effect, exactly like a manifest that was NEVER
    // attempted. classifyMigrationRecovery cannot tell these apart; only
    // the durable maintenance journal and artifact can.
    const publicationId = deriveRollbackPublicationId("gen-resume-2-7");
    await coordinator.enterMaintenance({
      publicationId, generationId: "gen-resume-2-7",
      sourceBackend: "postgresql", sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
      now: new Date(capturedAt),
    });
    writeRollbackAuthorityArtifact(homeDir, activation.artifact());
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");

    const outcome = await runRollback({
      homeDir, generationId: "gen-resume-2-7", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      ...activation.deps,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: activation.session,
    });

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.eligibility).toBe("pre-write");
    expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "completed", targetBackend: "sqlite" });
  });

  it("resumes after a crash between step 7's begin and step 8's complete: prepare-rollback is pending (donadiosolutions/lcm#1432)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    const verified = manifestAtVerified(store, "gen-resume-7-8");
    const activation = preWriteActivation("gen-resume-7-8");
    const canonicalPath = join(homeDir, "live.sqlite");
    const coordinator = coordinatorFor(homeDir);

    const publicationId = deriveRollbackPublicationId("gen-resume-7-8");
    await coordinator.enterMaintenance({
      publicationId, generationId: "gen-resume-7-8",
      sourceBackend: "postgresql", sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
      now: new Date(capturedAt),
    });
    writeRollbackAuthorityArtifact(homeDir, activation.artifact());
    // Simulates the crash: step 7's begin durably succeeded (the SAME
    // deterministic prepareInputSha256 runMigrationRollback itself would
    // compute for this manifest state and fakeSession's default
    // resourceType/resourceKey), then the process died before step 8's
    // complete. classifyMigrationRecovery reads this as "resume" (a
    // pending, retry-idempotent prepare-rollback).
    const prepareInputSha256 = deriveRollbackPrepareInputSha256({
      generationId: "gen-resume-7-8", manifestRevision: verified.revision, manifestChecksumSha256: verified.checksumSha256,
      epochId: activation.scenario.selection.epochId, resourceType: "sqlite-generation", resourceKey: "gen",
    });
    const prepareEffectId = "rollback-prepare-" + prepareInputSha256;
    const withPending = store.update("gen-resume-7-8", verified.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "prepare-rollback", effectId: prepareEffectId, inputSha256: prepareInputSha256, startedAt: capturedAt,
    }));
    expect(withPending.pendingEffect?.kind).toBe("prepare-rollback");
    expect(withPending.phase).toBe("verified");

    const outcome = await runRollback({
      homeDir, generationId: "gen-resume-7-8", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      ...activation.deps,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: activation.session,
    });

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
  });

  it("resumes after a crash between step 8 and step 9 via continueAfterPrepareRollback (donadiosolutions/lcm#1432, the predecessor's withdrawn test)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-resume-8-9");
    const activation = preWriteActivation("gen-resume-8-9");
    const canonicalPath = join(homeDir, "live.sqlite");
    const coordinator = coordinatorFor(homeDir);

    // The FIRST call runs for real through step 8 (prepare-rollback
    // durably completes) and then crashes for real at step 10's renew(),
    // inside runPostPrepareSequence -- no manual state reconstruction.
    const crashingSession = await activation.session();
    crashingSession.renew = async () => { throw new Error("simulated crash after step 8"); };

    await expect(runRollback({
      homeDir, generationId: "gen-resume-8-9", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      ...activation.deps,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => crashingSession,
    })).rejects.toThrow("simulated crash after step 8");

    const midManifest = new MigrationManifestStore({ homeDir }).read("gen-resume-8-9");
    expect(midManifest.phase).toBe("rolling-back");
    expect(midManifest.pendingEffect).toBeNull();
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    expect(readRollbackAuthorityArtifact(homeDir, "gen-resume-8-9")).not.toBeNull();

    // The SECOND call is a fresh process: classifyMigrationRecovery
    // reads "ready" at phase "rolling-back" and routes to
    // continueAfterPrepareRollback, which must recover the operability
    // fact and authority from the durable artifact rather than
    // re-deriving them live (the maintenance journal still holds the
    // slot, so a live re-read would still answer "unresolvable").
    const outcome = await runRollback({
      homeDir, generationId: "gen-resume-8-9", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      ...activation.deps,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: activation.session,
    });

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.eligibility).toBe("pre-write");
  });

 it("abandons a pending publish-rollback effect back to the sealed returnPhase when the resumed readback contradicts its terminal evidence", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    const verified = manifestAtVerified(store, "gen-abandon");
    const activation = preWriteActivation("gen-abandon");
    const coordinator = coordinatorFor(homeDir);

    const publicationId = deriveRollbackPublicationId("gen-abandon");
    await coordinator.enterMaintenance({
      publicationId, generationId: "gen-abandon",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
      now: new Date(capturedAt),
    });
    const prepareInputSha256 = deriveRollbackPrepareInputSha256({
      generationId: "gen-abandon", manifestRevision: verified.revision, manifestChecksumSha256: verified.checksumSha256,
      epochId: activation.scenario.selection.epochId, resourceType: "sqlite-generation", resourceKey: "gen",
    });
    const prepareEffectId = "rollback-prepare-" + prepareInputSha256;
    let m = store.update("gen-abandon", verified.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "prepare-rollback", effectId: prepareEffectId, inputSha256: prepareInputSha256, startedAt: capturedAt,
    }));
    m = store.update("gen-abandon", m.checksumSha256, (c) => completeMigrationEffect(c, { effectId: prepareEffectId, completedAt: capturedAt }));
    // Simulates a crash mid step-11, after publish-rollback began but
    // before the maintenance selection ever reached selection-completed
    // -- the maintenance journal is still at "maintenance-held" from the
    // enterMaintenance call above.
    m = store.update("gen-abandon", m.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "publish-rollback", effectId: "pub-abandon", inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
    expect(m.phase).toBe("rolling-back");
    expect(m.pendingEffect?.kind).toBe("publish-rollback");
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    writeRollbackAuthorityArtifact(homeDir, activation.artifact());

    // The held maintenance resumes in place; the fresh readback's terminal evidence is not the pending
    // effect's ("a".repeat(64)), a contradiction, so the effect is abandoned and the maintenance aborted.
    const outcome = await runRollback({
      homeDir, generationId: "gen-abandon", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      ...activation.deps,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: activation.session,
    });

    expect(outcome).toMatchObject({ report: { kind: "abandonment" } });
    expect(outcome.manifest.phase).toBe("verified");
    expect(outcome.manifest.rollbackLineage.returnPhase).toBeNull();
    expect(outcome.manifest.pendingEffect).toBeNull();
    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.kind).toBe("abandonment");
    expect(outcome.report!.reason).toContain("no longer reproduces the pending publish-rollback's terminal evidence");
    const maintenance = readBackendMaintenanceJournal(homeDir);
    expect(maintenance?.phase).toBe("maintenance-aborted");
  });

  // donadiosolutions/lcm#1432, plan-v2 section 10 red-proof requirement.
  // "the artifact's recorded fact disagrees with a resolvable live read
  // must produce a refusal" -- proven with BOTH sides independently
  // corruptible, for BOTH comparisons resolveRollbackOperabilityFact and
  // assertAuthorityAgreesWithArtifact perform: the operability fact
  // VALUE, and the resolved AUTHORITY. One shared baseline (agreement,
  // succeeds) plus four mutations, each corrupting exactly one side of
  // exactly one comparison. The "live fact" mutation uses a REAL
  // completed postgresql BackendPublicationJournal (via a fake driver,
  // no network) rather than a fabricated value, so that side is a
  // genuine production code path, not another hand-set fixture.

  it("disagreement baseline: artifact and a resolvable live read agree on both the operability fact and the authority -- succeeds (positive control)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-agree");
    const activation = preWriteActivation("gen-agree");
    const canonicalPath = join(homeDir, "live.sqlite");
    writeRollbackAuthorityArtifact(homeDir, activation.artifact());
    const outcome = await runRollback({
      homeDir, generationId: "gen-agree", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...activation.deps,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: activation.session,
    });
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(readRollbackAuthorityArtifact(homeDir, "gen-agree")).not.toBeNull();
  });

  it("disagreement mutation (artifact side, operability fact): artifact records present, a resolvable live read finds authoritatively-absent -- refuses", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-fact-artifact-wrong");
    writeRollbackAuthorityArtifact(homeDir, {
      version: 2,
      generationId: "gen-fact-artifact-wrong",
      operabilityFactState: "present",
      operabilityFactValueSha256: "e".repeat(64),
      epochId: "epoch-1",
      attemptId: "attempt-1",
      publication: PUBLICATION_SOURCE,
    });
    await expect(runRollback({
      homeDir, generationId: "gen-fact-artifact-wrong", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => { throw new Error("must not open a session: refusal happens before maintenance"); },
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
      message: expect.stringContaining("disagrees with the durable rollback-authority artifact"),
    });
  });

  it("disagreement mutation (live side, operability fact): artifact records authoritatively-absent, a resolvable live read finds a REAL completed postgresql publication -- refuses", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-fact-live-wrong");
    writeRollbackAuthorityArtifact(homeDir, {
      version: 2,
      generationId: "gen-fact-live-wrong",
      operabilityFactState: "authoritatively-absent",
      operabilityFactValueSha256: null,
      epochId: "epoch-1",
      attemptId: "attempt-1",
      publication: PUBLICATION_SOURCE,
    });
    await establishCompletedPostgresqlPublication(homeDir);
    const live = await readBackendPublicationOperabilityFact({ homeDir });
    expect(live.state).toBe("present");

    await expect(runRollback({
      homeDir, generationId: "gen-fact-live-wrong", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => { throw new Error("must not open a session: refusal happens before maintenance"); },
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
      message: expect.stringContaining("disagrees with the durable rollback-authority artifact"),
    });
  });

  it("disagreement mutation (artifact side, authority): artifact records an authoritative epoch/attempt, a fresh Boundary A read resolves unactivated -- refuses as never activated", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-authority-artifact-wrong");
    writeRollbackAuthorityArtifact(homeDir, {
      version: 2,
      generationId: "gen-authority-artifact-wrong",
      operabilityFactState: "authoritatively-absent",
      operabilityFactValueSha256: null,
      epochId: "epoch-1",
      attemptId: "attempt-1",
      publication: PUBLICATION_SOURCE,
    });
    await expect(runRollback({
      homeDir, generationId: "gen-authority-artifact-wrong", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => { throw new Error("must not open a session: refusal happens before maintenance"); },
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
      message: expect.stringContaining("never completed an activation"),
    });
  });

  it("disagreement mutation (authority epoch or attempt, each alone): an authoritative artifact naming another epoch or another attempt than the fresh read -- refuses", async () => {
    const fresh = fixtureActivationScenario();
    for (const [label, epochId, attemptId] of [
      ["epoch only", "another-epoch", fresh.selection.attemptId],
      ["attempt only", fresh.selection.epochId, "another-attempt"],
    ] as const) {
      const homeDir = tempHome();
      const store = new MigrationManifestStore({ homeDir });
      manifestAtVerified(store, "gen-authority-" + label.replace(" ", "-"));
      writeRollbackAuthorityArtifact(homeDir, {
        version: 2,
        generationId: "gen-authority-" + label.replace(" ", "-"),
        operabilityFactState: "authoritatively-absent",
        operabilityFactValueSha256: null,
        epochId,
        attemptId,
        publication: PUBLICATION_SOURCE,
      });
      await expect(runRollback({
        homeDir, generationId: "gen-authority-" + label.replace(" ", "-"), canonicalPath: join(homeDir, "live.sqlite"),
        projectIdentity: identity, localProjectId: "local-1",
        sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
      }, {
        coordinator: coordinatorFor(homeDir),
        ...authoritativeDeps(fresh),
        recordSelectionBinding: () => undefined,
        recordWitnessBinding: () => undefined,
        resolveAuthoritativeContext: async () => { throw new Error("must not resolve authoritative context: refusal happens before this call"); },
        openFencedSession: async () => { throw new Error("must not open a session: refusal happens before maintenance"); },
      }), label).rejects.toMatchObject({
        name: "RollbackOrchestrationError",
        reason: "unexpected-state",
        message: expect.stringContaining("freshly resolved authority disagrees with the durable rollback-authority artifact"),
      });
    }
  });

  // plan-v2 section 7: interruption "between install and config" must
  // resume to exactly one authoritative selection. Config/project-map
  // publication is not implemented on this branch (see this file's own
  // module doc and runPostPrepareSequence's step 11 comment), so the
  // nearest real boundary after install is the maintenance-selection
  // flip completing. A crash there leaves NO pending effect (publish-
  // rollback's begin is step 12, strictly after the flip completes), so
  // classifyMigrationRecovery routes a retry back through
  // continueAfterPrepareRollback -- the SAME resume path already
  // covered above, exercised here specifically in post-write mode so a
  // retry rebuilds/reinstalls the generation rather than skipping it.
  // Plan-v3.2 A16a begins publish-rollback before the install, so this crash leaves a pending effect; the
  // A9 resume table resumes it in place: the readback reproduces the pending evidence, the generation is
  // rebuilt (the install is idempotent with readback) and the publication completes.
  // F6: only a refusal before the install contradicts a pending effect. A14's re-check runs after the install, so
  // a transient failure of it on the resume path must leave the effect pending and the maintenance held.
  it("F6: a post-install refusal on the resume path leaves the effect pending and aborts nothing", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-f6");
    const canonicalPath = join(homeDir, "live.sqlite");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("f6-baseline");
    const coordinator = coordinatorFor(homeDir);
    const realPrepare = coordinator.prepareMaintenanceSelection.bind(coordinator);
    let calls = 0;
    coordinator.prepareMaintenanceSelection = (async (...args: Parameters<typeof realPrepare>) => {
      calls += 1;
      if (calls === 1) throw new Error("simulated crash after install");
      return realPrepare(...args);
    }) as typeof coordinator.prepareMaintenanceSelection;
    const abort = vi.spyOn(coordinator, "abortMaintenance");
    const deps: RunMigrationRollbackDependencies = {
      coordinator,
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity, censusVector: fixtureCensusVector("census-f6"), canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => fakeSession({
        observations: [{
          destinationIdentity, postEpochDelta: fixtureCanonicalDelta("f6-changed"), postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    };
    const run = {
      homeDir, generationId: "gen-f6", canonicalPath,
      projectIdentity: identity, localProjectId: "local-f6",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    };
    await expect(runRollback(run, deps)).rejects.toThrow("simulated crash after install");
    expect(existsSync(canonicalPath)).toBe(true);
    const pending = new MigrationManifestStore({ homeDir }).read("gen-f6");
    expect(pending.pendingEffect?.kind).toBe("publish-rollback");

    await expect(runRollback(run, {
      ...deps,
      readProjectMap: () => { throw new Error("project map transiently unreadable"); },
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("project-map-unreadable") });

    const after = new MigrationManifestStore({ homeDir }).read("gen-f6");
    expect(after.checksumSha256).toBe(pending.checksumSha256);
    expect(after.pendingEffect).toEqual(pending.pendingEffect);
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    expect(abort).not.toHaveBeenCalled();
  });

  it("resumes in place after a crash between install and the maintenance-selection flip (post-write)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-install-config");
    const canonicalPath = join(homeDir, "live.sqlite");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("install-config-baseline");
    const coordinator = coordinatorFor(homeDir);
    const realPrepareMaintenanceSelection = coordinator.prepareMaintenanceSelection.bind(coordinator);
    let prepareCalls = 0;
    coordinator.prepareMaintenanceSelection = (async (...args: Parameters<typeof realPrepareMaintenanceSelection>) => {
      prepareCalls += 1;
      if (prepareCalls === 1) throw new Error("simulated crash after install, before the maintenance-selection flip");
      return realPrepareMaintenanceSelection(...args);
    }) as typeof coordinator.prepareMaintenanceSelection;

    const deps: RunMigrationRollbackDependencies = {
      coordinator,
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: destinationIdentity, censusVector: fixtureCensusVector("census-ic"), canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => fakeSession({
        observations: [{
          destinationIdentity,
          postEpochDelta: fixtureCanonicalDelta("install-config-changed"),
          postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    };

    await expect(runRollback({
      homeDir, generationId: "gen-install-config", canonicalPath,
      projectIdentity: identity, localProjectId: "local-ic",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, deps)).rejects.toThrow("simulated crash after install, before the maintenance-selection flip");
    expect(prepareCalls).toBe(1);

    // Install already happened before the simulated crash: the
    // canonical database is real, installed, verified content -- not
    // an empty file a naive resume might mint.
    expect(existsSync(canonicalPath)).toBe(true);
    const installed = new DatabaseSync(canonicalPath, { readOnly: true });
    try {
      const row = installed.prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'portable_archive_%'",
      ).get() as { n: number };
      expect(row.n).toBeGreaterThan(0);
    } finally {
      installed.close();
    }

    const midManifest = new MigrationManifestStore({ homeDir }).read("gen-install-config");
    expect(midManifest.phase).toBe("rolling-back");
    expect(midManifest.pendingEffect?.kind).toBe("publish-rollback");
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");

    const outcome = await runRollback({
      homeDir, generationId: "gen-install-config", canonicalPath,
      projectIdentity: identity, localProjectId: "local-ic",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, deps);

   expect(outcome.manifest.phase).toBe("rolled-back");
   expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
   expect(prepareCalls).toBe(2);
   expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "completed", targetBackend: "sqlite" });

    // The retry's build target must be a FRESH physical generation, not
    // a reuse of the crashed attempt's -- plan-v2 section 4: "crash
    // recovery creates a NEW generation under the already-sealed
    // prepare-rollback", the incomplete one "quarantined read-only at
    // 0400, never deleted". Both attempt directories must exist:
    // deriving the retry's ordinal from the durable filesystem state
    // must never overwrite, delete or otherwise touch the first
    // attempt's evidence.
    const buildRoot = join(homeDir, ".lcm", "migration-rollback-generations");
    const buildEntries = readdirSync(buildRoot).filter((name) => name.startsWith("gen-install-config-rb"));
    // The resume runs at the pending effect's later manifest revision, so its target is named for that revision.
    expect(buildEntries).toHaveLength(2);
    expect(new Set(buildEntries).size).toBe(2);
    for (const entry of buildEntries) expect(existsSync(join(buildRoot, entry, "witness.json"))).toBe(true);
  });

  // PR #1556 thread 4308518705: a crash between the install's move-aside rename and its completion. The retry
  // builds under the next manifest revision, in a different directory, and must still find and finish the
  // crashed attempt's preserved pre-rollback database through the durable move-aside record.
  it("finishes a crashed move-aside on the retry: the preserved pre-rollback database ends read-only, verified and recorded (post-write)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-move-aside-crash");
    const canonicalPath = join(homeDir, "live.sqlite");
    const live = new DatabaseSync(canonicalPath);
    try {
      runLcmMigrations(live, { fts5Available: false });
      live.exec("INSERT INTO conversations(conversation_id,session_id,title,created_at,updated_at) VALUES (1,'s','pre-rollback-live-row','2026-09-06 00:00:00','2026-09-06 00:00:00')");
    } finally {
      live.close();
    }
    chmodSync(canonicalPath, 0o600);
    const destinationIdentity = fixtureDestinationIdentity("d");
    const deps: RunMigrationRollbackDependencies = {
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity, censusVector: fixtureCensusVector("census-mac"), canonicalDeltaBaseline: fixtureCanonicalDelta("mac-baseline"),
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => fakeSession({
        observations: [{ destinationIdentity, postEpochDelta: fixtureCanonicalDelta("mac-changed"), postEpochCensus: null }],
        source: sqliteSourceStream,
      }),
    };
    const run = () => runRollback({
      homeDir, generationId: "gen-move-aside-crash", canonicalPath,
      projectIdentity: identity, localProjectId: "local-mac",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, deps);

    // The process dies right after the real move-aside rename, before the chmod, the flush and the after-witness.
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const realRenameSync = nodeFs.renameSync as (from: string, to: string) => void;
    nodeFs.renameSync = ((from: string, to: string) => {
      realRenameSync(from, to);
      if (to.endsWith("preempted-canonical.sqlite")) throw new Error("simulated crash right after the move-aside rename");
    });
    syncBuiltinESMExports();
    try {
      await expect(run()).rejects.toThrow("simulated crash right after the move-aside rename");
    } finally {
      nodeFs.renameSync = realRenameSync;
      syncBuiltinESMExports();
    }
    expect(existsSync(canonicalPath)).toBe(false);
    const crashedRecord = readRollbackPreemptionRecord(homeDir, "gen-move-aside-crash")!;
    expect(crashedRecord).toMatchObject({ canonicalPath, moves: [{ after: null }] });
    const crashed = crashedRecord.moves[0]!;
    expect(statSync(crashed.preemptedPath).mode & 0o777).toBe(0o600);
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");

    const outcome = await run();
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
    const finishedRecord = readRollbackPreemptionRecord(homeDir, "gen-move-aside-crash")!;
    expect(finishedRecord.moves).toHaveLength(1);
    const finished = originalRollbackPreemption(finishedRecord)!;
    expect(finished.preemptedPath).toBe(crashed.preemptedPath);
    expect(finished.after).toMatchObject({ sha256: crashed.before.sha256, mode: 0o400 });
    expect(statSync(crashed.preemptedPath).mode & 0o777).toBe(0o400);
    const preserved = new DatabaseSync(crashed.preemptedPath, { readOnly: true });
    try {
      expect(preserved.prepare("SELECT title FROM conversations").all()).toEqual([{ title: "pre-rollback-live-row" }]);
    } finally {
      preserved.close();
    }
    // The retry's own build directory holds no second preserved file: the canonical path was absent when it installed.
    const buildRoot = join(homeDir, ".lcm", "migration-rollback-generations");
    const attempts = readdirSync(buildRoot).filter((name) => name.startsWith("gen-move-aside-crash-rb"));
    expect(attempts).toHaveLength(2);
    expect(attempts.map((entry) => existsSync(join(buildRoot, entry, "preempted-canonical.sqlite"))).sort()).toEqual([false, true]);
  });

  // Red-first: the enumeration must REFUSE when the read fails, never
 // silently return ordinal 1 (which would collide with the existing
 // attempt's evidence). Proven by making the build root exist but be
 // unreadable by this process (wrong mode), then showing the retry
 // refuses with a distinguishable reason rather than quietly minting a
 // colliding build target.
  it("refuses rather than defaulting to ordinal 1 when the build-attempt enumeration cannot read the existing evidence", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-enum-refuse");
    const canonicalPath = join(homeDir, "live.sqlite");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("enum-refuse-baseline");
    const coordinator = coordinatorFor(homeDir);

    const buildRoot = join(homeDir, ".lcm", "migration-rollback-generations");
    mkdirSync(buildRoot, { mode: 0o700 });
    mkdirSync(join(buildRoot, "gen-enum-refuse-rb10-1"), { mode: 0o700 });
    chmodSync(buildRoot, 0o000);

    let observed: unknown;
    try {
      await runRollback({
        homeDir, generationId: "gen-enum-refuse", canonicalPath,
        projectIdentity: identity, localProjectId: "local-enum",
        sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
      }, {
        coordinator,
        ...authoritativeDeps(fixtureActivationScenario({
          destinationIdentity: destinationIdentity, censusVector: fixtureCensusVector("census-enum"), canonicalDeltaBaseline: baseline,
        })),
        recordSelectionBinding: () => undefined,
        recordWitnessBinding: () => undefined,
        openFencedSession: async () => fakeSession({
          observations: [{
            destinationIdentity,
            postEpochDelta: fixtureCanonicalDelta("enum-refuse-changed"),
            postEpochCensus: null,
          }],
          source: sqliteSourceStream,
        }),
      });
    } catch (error) {
      observed = error;
    } finally {
      chmodSync(buildRoot, 0o700);
    }

    // Confirm this is genuinely the enumeration's own refusal, not an
    // unrelated failure with the same shape: match the EXACT wrapped
    // message highestRollbackGenerationBuildAttempt produces (never a
    // bare error-type check, which a different EACCES-raising path
    // nearby could satisfy just as well and prove nothing).
    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toContain(
      "could not enumerate existing rollback generation build attempts",
    );

    // Breakable independently: the SAME scenario with the root left
    // readable (its correct 0o700 mode) proceeds past enumeration
    // instead of refusing -- proving THIS refusal is caused by the
    // unreadable root, not by something else in the fixture.
    const readableHomeDir = tempHome();
    const readableStore = new MigrationManifestStore({ homeDir: readableHomeDir });
    manifestAtVerified(readableStore, "gen-enum-control");
    const readableCoordinator = coordinatorFor(readableHomeDir);
    const readableOutcome = await runRollback({
      homeDir: readableHomeDir, generationId: "gen-enum-control", canonicalPath: join(readableHomeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-enum-control",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: readableCoordinator,
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: destinationIdentity, censusVector: fixtureCensusVector("census-enum-control"), canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => fakeSession({
        observations: [{
          destinationIdentity,
          postEpochDelta: fixtureCanonicalDelta("enum-refuse-changed"),
          postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    });
   expect(readableOutcome.manifest.phase).toBe("rolled-back");
 });
});

// donadiosolutions/lcm#1431, coordinator-seam-FROZEN.md section 17's
// crash window: "between the moment a selection completes and the
// moment its binding is durably written, selections is missing the
// binding that authority actually rests on." Section 17's obligation:
// a consumer concludes nothing from that absence while an unresolved
// publish effect exists for that generation, and recovery re-derives
// and rewrites the binding from the authoritative readback, which the
// writer's idempotency rule makes safe.
describe("donadiosolutions/lcm#1431: selection-completes-but-binding-not-yet-written", () => {
  describe("publication recovery and the resume table (plan-v3.2 A16, plan-v3.1 A9)", () => {
    const GEN = "gen-a16";
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("a16-baseline");
    const census = fixtureCensusVector("a16-census");
    const scenarioFor = (generationId: string) => fixtureActivationScenario({
      generationId, destinationIdentity, censusVector: census, canonicalDeltaBaseline: baseline,
      publicationId: deriveActivationPublicationId(generationId),
    });
    const unchangedSession = async () => fakeSession({
      observations: [{
        destinationIdentity, postEpochDelta: baseline, postEpochCensus: census,
      }],
      source: sqliteSourceStream,
    });
    const RUN = (homeDir: string, generationId = GEN) => ({
      homeDir, generationId, canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-a16",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    });
    /** The verified manifest and the activation's records in the REAL evidence and binding stores. */
    function prepareAuthoritative(homeDir: string, generationId = GEN) {
      manifestAtVerified(new MigrationManifestStore({ homeDir }), generationId);
      const scenario = scenarioFor(generationId);
      recordMigrationActivationEpoch({ homeDir, epoch: scenario.epoch });
      recordMigrationActivationAttempt({ homeDir, generationId, attempt: scenario.attempt });
      recordMigrationActivationWitness({ homeDir, generationId, witness: scenario.witness });
      recordMigrationWitnessBinding({ homeDir, generationId, binding: scenario.witnessBinding });
      recordMigrationSelectionBinding({ homeDir, generationId, binding: scenario.selection });
      return scenario;
    }
    /** Real stores and real recorders throughout; a coordinator, a session and overrides vary. The retained
     * publication names the derived activation publication id the scenario's binding carries. */
    const depsFor = (homeDir: string, extra: Partial<RunMigrationRollbackDependencies> = {}): RunMigrationRollbackDependencies => ({
      coordinator: coordinatorFor(homeDir),
      recordActivationWitness: recordMigrationActivationWitness,
      openFencedSession: unchangedSession,
      readRetainedMaterial: () => retainedActivationPublication(deriveActivationPublicationId(GEN)),
      ...extra,
    });
    const realUnlinkSync = (createRequire(import.meta.url)("node:fs") as { unlinkSync: (p: string) => void }).unlinkSync;
    type Method = "prepare" | "resume" | "prepareMaintenanceSelection" | "completeMaintenanceSelection";
    /** The method completes durably and then the process "dies". */
    function crashAfter(coordinator: BackendPublicationCoordinator, method: Method): BackendPublicationCoordinator {
      const target = coordinator as unknown as Record<Method, (...args: unknown[]) => Promise<unknown>>;
      const real = target[method].bind(coordinator);
      target[method] = async (...args: unknown[]) => {
        await real(...args);
        throw new Error("simulated crash right after " + method);
      };
      return coordinator;
    }
    /** The process "dies" before the method does anything. */
    function crashBefore(coordinator: BackendPublicationCoordinator, method: Method): BackendPublicationCoordinator {
      (coordinator as unknown as Record<Method, () => Promise<never>>)[method] = async () => {
        throw new Error("simulated crash right before " + method);
      };
      return coordinator;
    }
    const pendingPublish = (homeDir: string, generationId = GEN) => new MigrationManifestStore({ homeDir }).read(generationId).pendingEffect;
    const rollbackBinding = (homeDir: string, generationId = GEN) => {
      const resolved = resolveMigrationWitnessBindings({ homeDir, generationId });
      return resolved.state === "resolved" ? resolved.selections.find((selection) => selection.kind === "rollback") : undefined;
    };

    it("records the binding right after the selection completes and before the coordinator's publication, report and completion", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      const events: string[] = [];
      const coordinator = coordinatorFor(homeDir);
      for (const method of ["completeMaintenanceSelection", "prepare", "resume"] as const) {
        const real = coordinator[method].bind(coordinator) as (...args: unknown[]) => Promise<unknown>;
        (coordinator as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
          const result = await real(...args);
          events.push(method);
          return result;
        };
      }
      const session = await unchangedSession();
      const acquired = vi.spyOn(session, "markCoordinatorAcquired");
      let revisionAtBinding = 0;
      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, {
        coordinator,
        openFencedSession: async () => session,
        recordSelectionBinding: (input) => {
          events.push("binding");
          const manifest = new MigrationManifestStore({ homeDir }).read(GEN);
          revisionAtBinding = manifest.revision;
          expect(manifest.pendingEffect?.kind).toBe("publish-rollback");
          expect(input.binding.manifestRevision).toBe(manifest.revision);
          expect(existsSync(join(homeDir, ".lcm", "migration-reports", GEN))).toBe(false);
        },
      }));
      expect(events).toEqual(["completeMaintenanceSelection", "binding", "prepare", "resume"]);
      expect(acquired).toHaveBeenCalledTimes(1);
      expect(outcome.manifest.phase).toBe("rolled-back");
      expect(outcome.report!.selectionBindingManifestRevision).toBe(revisionAtBinding);
      expect(outcome.report!.sealedPublicationMaterialDigestSha256)
        .toBe(readBackendPublicationJournal(homeDir)!.recoveryReference!.sealSha256);
    });

    it("does not let a failing session release mask the failure that preceded it", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      const session = await unchangedSession();
      session.release = async () => { throw new Error("release failed too"); };
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        coordinator: crashBefore(coordinatorFor(homeDir), "resume"), openFencedSession: async () => session,
      }))).rejects.toThrow("simulated crash right before resume");
    });

    it("reports a session release that fails after a successful publication", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      const session = await unchangedSession();
      session.release = async () => { throw new Error("release failed"); };
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { openFencedSession: async () => session })))
        .rejects.toThrow("release failed");
    });

    it("keeps PostgreSQL selected for the real consumer and replay admission when the step-4 readback of an activated, bound generation refuses", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: async () => fakeSession({
          observations: [{
            destinationIdentity: fixtureDestinationIdentity("swapped"), postEpochDelta: baseline, postEpochCensus: census,
          }],
          source: sqliteSourceStream,
        }),
      }))).rejects.toMatchObject({ name: "RollbackOrchestrationError", reason: "not-eligible", message: expect.stringContaining("destination identity") });
      expect(new MigrationManifestStore({ homeDir }).read(GEN).phase).toBe("verified");
      expect(rollbackBinding(homeDir)).toBeUndefined();
      // Step-4 readback abort site, generation activated and bound: the binding answers replay admission.
      expectAbortedWindowKeepsPostgreSql(homeDir, GEN, "activated");
    });

    it("does not adopt a held window of this attempt whose recorded source backend is not PostgreSQL (E14)", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      // A prior attempt of this very rollback entered maintenance and died before opening its session.
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: async () => { throw new Error("simulated crash right after enterMaintenance"); },
      }))).rejects.toThrow("simulated crash right after enterMaintenance");
      const held = readBackendMaintenanceJournal(homeDir)!;
      expect(held).toMatchObject({ phase: "maintenance-held", sourceBackend: "postgresql" });
      // Every field this attempt supplies matches, except the window was entered from SQLite.
      const journalPath = backendPublicationJournalPath(homeDir);
      const { checksumSha256: _checksum, ...body } = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
      const foreign = { ...body, sourceBackend: "sqlite" };
      writeFileSync(journalPath, JSON.stringify({ ...foreign, checksumSha256: backendPublicationCanonicalSha256(foreign) }), { mode: 0o600 });
      const bytes = readFileSync(journalPath);

      await expect(runRollback(RUN(homeDir), depsFor(homeDir)))
        .rejects.toMatchObject({ reason: "unresolved-publication", message: expect.stringContaining("already exists") });
      expect(readFileSync(journalPath)).toEqual(bytes);
      expect(new MigrationManifestStore({ homeDir }).read(GEN).phase).toBe("verified");
    });

    it("converges after a crash inside the real binding writer between link and unlink: the retry through the entry reuses the binding", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
      nodeFs.unlinkSync = ((path: string) => {
        if (/\.selection-rollback\.binding\.[0-9a-f]+\.tmp$/u.test(path)) throw Object.assign(new Error("simulated crash after link"), { code: "EIO" });
        return realUnlinkSync(path);
      });
      syncBuiltinESMExports();
      try {
        await expect(runRollback(RUN(homeDir), depsFor(homeDir))).rejects.toThrow("simulated crash after link");
      } finally {
        nodeFs.unlinkSync = realUnlinkSync;
        syncBuiltinESMExports();
      }
      const bindingDirectory = migrationGenerationBindingDirectory(homeDir, GEN);
      const published = join(bindingDirectory, "selection-rollback.binding");
      expect(statSync(published).nlink).toBe(2);
      const crashed = new MigrationManifestStore({ homeDir }).read(GEN);
      expect(crashed.pendingEffect?.kind).toBe("publish-rollback");
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-completed");
      // Nothing in memory survives: a fresh coordinator and a fresh call, through the same entry.
      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir));

      expect(outcome.manifest.phase).toBe("rolled-back");
      expect(outcome.report).toMatchObject({
        kind: "rollback", epochId: scenarioFor(GEN).epoch.epochId, attemptId: scenarioFor(GEN).attempt.attemptId,
      });
      expect(statSync(published).nlink).toBe(1);
      expect(readdirSync(bindingDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(rollbackBinding(homeDir)).toMatchObject({ manifestRevision: crashed.revision });
      expect(assertMigrationReplayAdmission({ homeDir, generationId: GEN, evidenceSha256: rollbackBinding(homeDir)!.witnessChecksumSha256 }))
        .toEqual({ backend: "sqlite", disposition: "selected" });
    });

    it("row 4: completes a prepared selection with the stored evidence, then finishes the publication", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash right before completeMaintenanceSelection");
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
      expect(rollbackBinding(homeDir)).toBeUndefined();

      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir));

      expect(outcome.manifest.phase).toBe("rolled-back");
      expect(rollbackBinding(homeDir)).toBeDefined();
      expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "completed", targetBackend: "sqlite" });
    });


    // ---- F1 (plan-v3.2 A-01, P0): the lease outlives a failure after the selection was attempted, and recovery
    // revalidates against a fresh fenced session before completing a prepared selection.
    /** A session whose lease disposition is observable. */
    const watched = async (base: () => Promise<RollbackFencedSession> = unchangedSession) => {
      const session = await base();
      const calls: string[] = [];
      const release = session.release.bind(session);
      const keep = session.closeKeepingLease.bind(session);
      session.release = async () => { calls.push("release"); await release(); };
      session.closeKeepingLease = async () => { calls.push("closeKeepingLease"); await keep(); };
      return { session, calls };
    };
    const changedSession = (observation: Partial<{
      postEpochDelta: ReturnType<typeof fixtureCanonicalDelta>;
      postEpochCensus: ReturnType<typeof fixtureCensusVector> | null;
      destinationIdentity: typeof destinationIdentity;
    }>) => async () => fakeSession({
      observations: [{
        destinationIdentity, postEpochDelta: baseline, postEpochCensus: census, ...observation,
      }],
      source: sqliteSourceStream,
    });

    it("F1: a failure in completeMaintenanceSelection keeps the lease and only closes owned resources", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      const { session, calls } = await watched();
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: async () => session,
        coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection"),
      }))).rejects.toThrow("simulated crash right before completeMaintenanceSelection");
      expect(calls).toEqual(["closeKeepingLease"]);
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
    });

    it("F1: a failure in prepareMaintenanceSelection itself also keeps the lease (the selection may be durable)", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      const { session, calls } = await watched();
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: async () => session,
        coordinator: crashBefore(coordinatorFor(homeDir), "prepareMaintenanceSelection"),
      }))).rejects.toThrow("simulated crash right before prepareMaintenanceSelection");
      expect(calls).toEqual(["closeKeepingLease"]);
    });

    it("F1: a lease close that fails after a failed body never masks the original failure", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      const session = await unchangedSession();
      session.closeKeepingLease = async () => { throw new Error("the lease close failed too"); };
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: async () => session,
        coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection"),
      }))).rejects.toThrow("simulated crash right before completeMaintenanceSelection");
    });

    it("F1: a failure before the selection was attempted still releases the lease", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      const { session, calls } = await watched();
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: async () => session,
        recordActivationWitness: () => { throw new Error("witness store unwritable"); },
      }))).rejects.toThrow("witness store unwritable");
      expect(calls).toEqual(["release"]);
    });

    it("F1: a failure during the coordinator's publication keeps the lease too", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      const { session, calls } = await watched();
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: async () => session,
        coordinator: crashBefore(coordinatorFor(homeDir), "prepare"),
      }))).rejects.toThrow("simulated crash right before prepare");
      expect(calls).toEqual(["closeKeepingLease"]);
    });

    it("F1: retry of a prepared selection never completes a stale pre-write decision when the delta changed meanwhile", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      const before = new MigrationManifestStore({ homeDir }).read(GEN);
      const maintenanceBefore = readBackendMaintenanceJournal(homeDir);
      const coordinator = coordinatorFor(homeDir);
      const complete = vi.spyOn(coordinator, "completeMaintenanceSelection");

      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        coordinator, openFencedSession: changedSession({ postEpochDelta: fixtureCanonicalDelta("a16-written-meanwhile"), postEpochCensus: null }),
      }))).rejects.toMatchObject({ reason: "drift", message: expect.stringContaining("terminal evidence") });

      expect(complete).not.toHaveBeenCalled();
      expect(readBackendMaintenanceJournal(homeDir)).toEqual(maintenanceBefore);
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
      const after = new MigrationManifestStore({ homeDir }).read(GEN);
      expect(after.checksumSha256).toBe(before.checksumSha256);
      expect(after.pendingEffect).toEqual(before.pendingEffect);
    });

    it("F1: a census-only change with an equal delta also refuses the prepared selection", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: changedSession({ postEpochCensus: fixtureCensusVector("a16-census-changed") }),
      }))).rejects.toMatchObject({ reason: "drift" });
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
    });

    it("F1: a prepared selection is refused with the fresh refusal when the destination identity changed", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: changedSession({ destinationIdentity: fixtureDestinationIdentity("another-cluster") }),
      }))).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("destination identity") });
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
    });

    it("F1: a prepared selection is refused when the mode flipped, even if the session's evidence hash did not see it", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: async () => {
          const session = await changedSession({ postEpochDelta: fixtureCanonicalDelta("a16-written-meanwhile"), postEpochCensus: null })();
          const real = session.computeRollbackTerminalEvidenceSha256.bind(session);
          // The evidence the original pre-write decision hashed, whatever the fresh readback says.
          session.computeRollbackTerminalEvidenceSha256 = (evidence) => real({
            ...evidence, mode: "pre-write", observation: { ...evidence.observation, postEpochDelta: baseline, postEpochCensus: census },
          });
          return session;
        },
      }))).rejects.toMatchObject({ reason: "drift" });
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
    });

    it("F1: a prepared selection is refused when the evidence hash no longer reproduces although the mode is unchanged", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: async () => {
          const session = await unchangedSession();
          session.computeRollbackTerminalEvidenceSha256 = () => "f".repeat(64);
          return session;
        },
      }))).rejects.toMatchObject({ reason: "drift" });
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
    });

    it("F1: the recovery session keeps the lease when its own revalidation refuses", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      const { session, calls } = await watched(changedSession({ postEpochDelta: fixtureCanonicalDelta("a16-written-meanwhile"), postEpochCensus: null }));
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { openFencedSession: async () => session })))
        .rejects.toMatchObject({ reason: "drift" });
      expect(calls).toEqual(["closeKeepingLease"]);
    });

    describe("a prepared post-write selection", () => {
      const written = fixtureCanonicalDelta("a16-written");
      const postWriteSession = (delta = written) => async () => fakeSession({
        observations: [{
          destinationIdentity, postEpochDelta: delta, postEpochCensus: null,
        }],
        source: sqliteSourceStream,
        exportEvidence: { canonicalDelta: written, censusVector: census },
      });
      const preparedPostWrite = async (homeDir: string) => {
        prepareAuthoritative(homeDir);
        await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
          openFencedSession: postWriteSession(),
          coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection"),
        }))).rejects.toThrow("simulated crash");
        expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
      };

      it("F1: recovery asks the fresh readback for the census and completes it", async () => {
        const homeDir = tempHome();
        await preparedPostWrite(homeDir);
        const requests: Array<boolean | undefined> = [];
        const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, {
          openFencedSession: async () => {
            const session = await postWriteSession()();
            const real = session.captureReadback.bind(session);
            session.captureReadback = async (request) => { requests.push(request.requireCensus); return real(request); };
            return session;
          },
        }));
        expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
        expect(requests).toEqual([true]);
      });

      it("F1: recovery refuses when the destination was written again meanwhile (same mode, other evidence)", async () => {
        const homeDir = tempHome();
        await preparedPostWrite(homeDir);
        await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
          openFencedSession: postWriteSession(fixtureCanonicalDelta("a16-written-again")),
        }))).rejects.toMatchObject({ reason: "drift" });
        expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
      });
    });


    it("F1: a prepared selection whose authority no longer resolves is refused, not completed", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        resolveWitnessBindings: () => fixtureBindingsUnresolvable("binding store unreadable"),
      }))).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("no longer resolves") });
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
    });

    it("F1: recovery of a prepared selection opens a fresh fenced session and a lease held by anyone else refuses", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      const before = new MigrationManifestStore({ homeDir }).read(GEN);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: async () => { throw new Error("lease-unavailable: held by another publication"); },
      }))).rejects.toThrow("lease-unavailable");
      expect(new MigrationManifestStore({ homeDir }).read(GEN).checksumSha256).toBe(before.checksumSha256);
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
    });

    it("F1: recovery of a completed selection takes the coordinator's publication under a fresh session", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      const opened = vi.fn(unchangedSession);
      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, { openFencedSession: opened }));
      expect(opened).toHaveBeenCalledTimes(1);
      expect(outcome.manifest.phase).toBe("rolled-back");
    });

    it("F1: a completed selection is final: a changed destination no longer matters", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, {
        openFencedSession: changedSession({ postEpochDelta: fixtureCanonicalDelta("a16-after-final"), postEpochCensus: null }),
      }));
      expect(outcome.manifest.phase).toBe("rolled-back");
    });

it("F1: a prepared selection is refused, and left prepared, once the stores no longer show the authoritative activation", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { resolveWitnessBindings: () => fixtureBindingsAbsent })))
        .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("unactivated but a rollback is in progress") });
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
    });


    it("row 5: finishes a completed selection from the stored rollback witness, with the authority's epoch, attempt and mode", async () => {
      const homeDir = tempHome();
      const scenario = prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash right after completeMaintenanceSelection");
      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir));
      expect(outcome.manifest.phase).toBe("rolled-back");
      expect(outcome.report).toMatchObject({
        epochId: scenario.epoch.epochId, attemptId: scenario.attempt.attemptId, mode: "pre-write", eligibility: "pre-write",
      });
      expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    });

    it("row 5: refuses a pending effect whose rollback witness is not stored", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      const evidence = readMigrationActivationEvidence({ homeDir, generationId: GEN });
      const rollbackWitness = (evidence as { witnesses: readonly { kind: string; checksumSha256: string }[] }).witnesses
        .find((witness) => witness.kind === "rollback")!;
      realUnlinkSync(join(migrationActivationEvidenceDirectory(homeDir, GEN), "witness-" + rollbackWitness.checksumSha256 + ".json"));
      await expect(runRollback(RUN(homeDir), depsFor(homeDir)))
        .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("no stored rollback witness") });
    });

    it("row 5: refuses when the evidence store holds no rollback witness at all", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { resolveActivationEvidence: () => fixtureEvidenceAbsent })))
        .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("no stored rollback witness") });
    });

    it("row 5: takes the mode from the stored rollback witness whose checksum the pending effect names, not another rollback witness", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      const stored = readMigrationActivationEvidence({ homeDir, generationId: GEN });
      if (stored.state !== "resolved") throw new Error("expected the evidence store to resolve");
      const real = stored.witnesses.find((witness) => witness.kind === "rollback")!;
      const decoy = { ...real, checksumSha256: "d".repeat(64), rollbackMode: "post-write" as const };
      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, {
        resolveActivationEvidence: () => ({ ...stored, witnesses: [decoy, ...stored.witnesses] }),
      }));
      expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    });

    it("row 5: a stored witness that carries the pending effect's checksum but is not a rollback witness is not its mode source", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      const stored = readMigrationActivationEvidence({ homeDir, generationId: GEN });
      if (stored.state !== "resolved") throw new Error("expected the evidence store to resolve");
      const witnesses = stored.witnesses.map((witness) => (witness.kind === "rollback" ? { ...witness, kind: "activation" as const } : witness));
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { resolveActivationEvidence: () => ({ ...stored, witnesses }) })))
        .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("no stored rollback witness") });
    });

    describe("row 1: the maintenance is still held with the effect pending", () => {
      async function heldWithPending(homeDir: string): Promise<void> {
        prepareAuthoritative(homeDir);
        await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "prepareMaintenanceSelection") })))
          .rejects.toThrow("simulated crash right before prepareMaintenanceSelection");
        expect(pendingPublish(homeDir)?.kind).toBe("publish-rollback");
        expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
      }

      it("abandons when the authority no longer resolves", async () => {
        const homeDir = tempHome();
        await heldWithPending(homeDir);
        const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, { resolveWitnessBindings: () => fixtureBindingsUnresolvable("the binding store was lost") }));
        expect(outcome.manifest.phase).toBe("verified");
        expect(outcome.report).toMatchObject({ kind: "abandonment", reason: expect.stringContaining("the authority no longer resolves") });
        expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-aborted");
      });

      it("abandons when the fresh readback refuses eligibility", async () => {
        const homeDir = tempHome();
        await heldWithPending(homeDir);
        const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, {
          openFencedSession: async () => fakeSession({
            observations: [{
              destinationIdentity: fixtureDestinationIdentity("swapped"), postEpochDelta: baseline, postEpochCensus: census,
            }],
            source: sqliteSourceStream,
          }),
        }));
        expect(outcome.manifest.phase).toBe("verified");
        expect(outcome.report).toMatchObject({ kind: "abandonment", reason: expect.stringContaining("destination identity") });
        expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-aborted");
        // The real consumer and replay admission stay on PostgreSQL after the abandonment (recovery abort site).
        expectAbortedWindowKeepsPostgreSql(homeDir, GEN, "activated");
      });

      it("leaves the effect pending and the maintenance held when the readback fails for any other reason", async () => {
        const homeDir = tempHome();
        await heldWithPending(homeDir);
        await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
          openFencedSession: async () => {
            const session = await unchangedSession();
            session.captureReadback = async () => { throw new Error("a transient readback failure"); };
            return session;
          },
        }))).rejects.toThrow("a transient readback failure");
        expect(pendingPublish(homeDir)?.kind).toBe("publish-rollback");
        expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
      });
    });

    it("row 6: resumes a coordinator publication that our own prepare left prepared, the journal archived, under a fresh session", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "prepare") })))
        .rejects.toThrow("simulated crash right after prepare");
      expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
      expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "prepared" });
      const session = await unchangedSession();
      const opened = vi.fn(async () => session);

      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, { openFencedSession: opened }));

      expect(opened).toHaveBeenCalledTimes(1);
      expect(outcome.manifest.phase).toBe("rolled-back");
      expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "completed", targetBackend: "sqlite" });
      expect(assertMigrationReplayAdmission({ homeDir, generationId: GEN, evidenceSha256: rollbackBinding(homeDir)!.witnessChecksumSha256 }))
        .toEqual({ backend: "sqlite", disposition: "selected" });
    });

    it("row 6: resumes through the coordinator after a crash mid-publication (the map is published, the config is not)", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      const base = workingPublicationDriver(rollbackPublicationMaterial());
      let failed = false;
      const driver = {
        ...base,
        publishConfig: async (...args: Parameters<typeof base.publishConfig>) => {
          if (!failed) { failed = true; throw new Error("simulated crash before the config publish"); }
          return base.publishConfig(...args);
        },
      };
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: new BackendPublicationCoordinator({ homeDir, driver }) })))
        .rejects.toThrow("simulated crash before the config publish");
      expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: expect.not.stringMatching(/^(completed|aborted)$/u) });

      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: new BackendPublicationCoordinator({ homeDir, driver }) }));

      expect(outcome.manifest.phase).toBe("rolled-back");
      expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "completed" });
    });

    it("row 7: verifies a completed coordinator publication without resuming or composing again", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "resume") })))
        .rejects.toThrow("simulated crash right after resume");
      const completed = readBackendPublicationJournal(homeDir)!;
      expect(completed.phase).toBe("completed");
      const coordinator = coordinatorFor(homeDir);
      const resume = vi.spyOn(coordinator, "resume");
      const prepare = vi.spyOn(coordinator, "prepare");
      const compose = vi.fn(composeRollbackPublication);

      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, { coordinator, composePublication: compose }));

      expect(outcome.manifest.phase).toBe("rolled-back");
      expect(resume).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(compose).not.toHaveBeenCalled();
      expect(outcome.report!.sealedPublicationMaterialDigestSha256).toBe(completed.recoveryReference!.sealSha256);
    });

    it("row 6: refuses a coordinator publication of this rollback whose selection binding is missing", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "prepare") })))
        .rejects.toThrow("simulated crash");
      realUnlinkSync(join(migrationGenerationBindingDirectory(homeDir, GEN), "selection-rollback.binding"));
      await expect(runRollback(RUN(homeDir), depsFor(homeDir)))
        .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("without the selection binding that must precede it") });
    });

    it("refuses a pending effect whose maintenance journal another publication archived after the selection binding was recorded", async () => {
      const homeDir = tempHome();
      const scenario = prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      const pending = pendingPublish(homeDir)!;
      recordMigrationSelectionBinding({
        homeDir, generationId: GEN,
        binding: {
          kind: "rollback", epochId: scenario.epoch.epochId, attemptId: scenario.attempt.attemptId,
          manifestRevision: new MigrationManifestStore({ homeDir }).read(GEN).revision,
          witnessChecksumSha256: pending.inputSha256, publicationId: deriveRollbackPublicationId(GEN),
        },
      });
      // Someone else's publication replaces the terminal maintenance journal in the live slot.
      await establishCompletedPostgresqlPublication(homeDir);
      expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
      await expect(runRollback(RUN(homeDir), depsFor(homeDir)))
        .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("archived by another publication") });
    });

    it("abandons a pending effect when another publication archived the journal before any binding was recorded", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      await establishCompletedPostgresqlPublication(homeDir);
      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir));
      expect(outcome.manifest.phase).toBe("verified");
      expect(outcome.report).toMatchObject({ kind: "abandonment", selectionBindingManifestRevision: null });
    });

    it("F5: an unresolvable binding store refuses the no-journal fallthrough and changes nothing", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      await establishCompletedPostgresqlPublication(homeDir);
      const store = new MigrationManifestStore({ homeDir });
      const before = store.read(GEN);
      const reportsBefore = readRollbackReport(homeDir, GEN, deriveRollbackReportId({ generationId: GEN, effectId: before.pendingEffect!.effectId, kind: "abandonment" }));
      const coordinator = coordinatorFor(homeDir);
      const abort = vi.spyOn(coordinator, "abortMaintenance");

      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        coordinator, resolveWitnessBindings: () => fixtureBindingsUnresolvable("binding directory unreadable"),
      }))).rejects.toThrow(MigrationBindingUnresolvableError);

      const after = store.read(GEN);
      expect(after.checksumSha256).toBe(before.checksumSha256);
      expect(after.pendingEffect).toEqual(before.pendingEffect);
      expect(after.phase).toBe(before.phase);
      expect(reportsBefore).toBeNull();
      expect(readRollbackReport(homeDir, GEN, deriveRollbackReportId({ generationId: GEN, effectId: before.pendingEffect!.effectId, kind: "abandonment" }))).toBeNull();
      expect(abort).not.toHaveBeenCalled();
      expect(rollbackBinding(homeDir)).toBeUndefined();
    });

    it("F5: an unresolvable binding store also refuses a coordinator publication in the slot, without finishing it", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "prepare") })))
        .rejects.toThrow("simulated crash");
      const before = new MigrationManifestStore({ homeDir }).read(GEN);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        resolveWitnessBindings: () => fixtureBindingsUnresolvable("binding directory unreadable"),
      }))).rejects.toThrow(MigrationBindingUnresolvableError);
      expect(new MigrationManifestStore({ homeDir }).read(GEN).checksumSha256).toBe(before.checksumSha256);
    });

    it("abandons a pending effect whose maintenance was aborted, without aborting it again", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashBefore(coordinatorFor(homeDir), "prepareMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      const coordinator = coordinatorFor(homeDir);
      await coordinator.abortMaintenance({
        expectedChecksumSha256: readBackendMaintenanceJournal(homeDir)!.checksumSha256,
        sourceSelectionSha256: "5".repeat(64), abortEvidenceSha256: "8".repeat(64),
      });
      const abort = vi.spyOn(coordinator, "abortMaintenance");
      const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, { coordinator }));
      expect(abort).not.toHaveBeenCalled();
      expect(outcome.report?.kind).toBe("abandonment");
      expect(outcome.manifest.phase).toBe("verified");
    });

    it("refuses a pending effect whose artifact is gone", async () => {
      const homeDir = tempHome();
      prepareAuthoritative(homeDir);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, { coordinator: crashAfter(coordinatorFor(homeDir), "completeMaintenanceSelection") })))
        .rejects.toThrow("simulated crash");
      realUnlinkSync(join(homeDir, ".lcm", "migration-rollback-authority", deriveRollbackAuthorityArtifactId(GEN) + ".json"));
      await expect(runRollback(RUN(homeDir), depsFor(homeDir)))
        .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("rollback authority artifact") });
    });

    describe("terminal recovery of a missing binding at rolled-back", () => {
      /** A completed rollback whose selection binding never reached the store. */
      async function rolledBackWithoutBinding(homeDir: string) {
        prepareAuthoritative(homeDir);
        const attempted: Parameters<MigrationSelectionBindingRecorder>[0][] = [];
        const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, {
          recordSelectionBinding: (input) => { attempted.push(input); },
        }));
        expect(outcome.manifest.phase).toBe("rolled-back");
        expect(rollbackBinding(homeDir)).toBeUndefined();
        return { outcome, attempted };
      }

      it("rewrites the exact binding the fresh path attempted, through the entry, and is idempotent", async () => {
        const homeDir = tempHome();
        const { outcome, attempted } = await rolledBackWithoutBinding(homeDir);
        const recovered = await runRollback(RUN(homeDir), depsFor(homeDir));
        expect(recovered.manifest).toEqual(outcome.manifest);
        expect(recovered.report).toEqual(outcome.report);
        expect(rollbackBinding(homeDir)).toEqual(attempted[0]!.binding);
        await expect(runRollback(RUN(homeDir), depsFor(homeDir))).resolves.toMatchObject({ manifest: outcome.manifest });
        expect(rollbackBinding(homeDir)).toEqual(attempted[0]!.binding);
      });

      it("refuses when the rollback report or the rollback authority artifact cannot be read", async () => {
        const noReport = tempHome();
        const first = await rolledBackWithoutBinding(noReport);
        realUnlinkSync(join(noReport, ".lcm", "migration-reports", GEN, first.outcome.report!.reportId + ".json"));
        await expect(runRollback(RUN(noReport), depsFor(noReport)))
          .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("rollback report cannot be read") });

        const noArtifact = tempHome();
        await rolledBackWithoutBinding(noArtifact);
        realUnlinkSync(join(noArtifact, ".lcm", "migration-rollback-authority", deriveRollbackAuthorityArtifactId(GEN) + ".json"));
        await expect(runRollback(RUN(noArtifact), depsFor(noArtifact)))
          .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("authority artifact is absent") });
      });

      it("refuses when the report names another epoch or attempt than the authority artifact", async () => {
        for (const field of ["epochId", "attemptId"] as const) {
          const homeDir = tempHome();
          await rolledBackWithoutBinding(homeDir);
          const artifact = readRollbackAuthorityArtifact(homeDir, GEN)!;
          const { checksumSha256: _checksum, ...body } = artifact;
          realUnlinkSync(join(homeDir, ".lcm", "migration-rollback-authority", deriveRollbackAuthorityArtifactId(GEN) + ".json"));
          writeRollbackAuthorityArtifact(homeDir, { ...body, [field]: "another-" + field });
          await expect(runRollback(RUN(homeDir), depsFor(homeDir)))
            .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("does not agree") });
        }
      });

      it("refuses a report whose effect id is not the rollback publish effect of a terminal evidence digest", async () => {
        const homeDir = tempHome();
        prepareAuthoritative(homeDir);
        const scenario = scenarioFor(GEN);
        const store = new MigrationManifestStore({ homeDir });
        let m = store.read(GEN);
        m = store.update(GEN, m.checksumSha256, (c) => beginMigrationEffect(c, {
          kind: "prepare-rollback", effectId: "prepare-rollback", inputSha256: "7".repeat(64), startedAt: capturedAt,
        }));
        m = store.update(GEN, m.checksumSha256, (c) => completeMigrationEffect(c, { effectId: "prepare-rollback", completedAt: capturedAt }));
        writeRollbackAuthorityArtifact(homeDir, {
          version: 2, generationId: GEN, operabilityFactState: "authoritatively-absent", operabilityFactValueSha256: null,
          epochId: scenario.epoch.epochId, attemptId: scenario.attempt.attemptId,
          publication: PUBLICATION_SOURCE,
        });
        // An effect id that is not "rollback-publish-" plus the terminal evidence digest.
        const effectId = "rollback-publish-not-a-digest";
        m = store.update(GEN, m.checksumSha256, (c) => beginMigrationEffect(c, {
          kind: "publish-rollback", effectId, inputSha256: "7".repeat(64), startedAt: capturedAt,
        }));
        const report = writeRollbackReport(homeDir, {
          version: 1, reportId: deriveRollbackReportId({ generationId: GEN, effectId, kind: "rollback" }),
          generationId: GEN, effectId, kind: "rollback", eligibility: "post-write", mode: "post-write",
          epochId: scenario.epoch.epochId, attemptId: scenario.attempt.attemptId,
          sealedPublicationMaterialDigestSha256: null, reason: null, selectionBindingManifestRevision: m.revision,
        });
        store.update(GEN, m.checksumSha256, (c) => completeMigrationEffect(c, {
          effectId, completedAt: capturedAt,
          report: { kind: "rollback", reportId: report.reportId, reportSha256: report.checksumSha256, createdAt: capturedAt },
          rollbackMode: "post-write",
        }));
        await expect(runRollback(RUN(homeDir), depsFor(homeDir)))
          .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("does not agree with the rollback authority artifact") });
      });

      it("refuses a stored binding revision that the manifest history contradicts", async () => {
        const homeDir = tempHome();
        prepareAuthoritative(homeDir);
        const scenario = scenarioFor(GEN);
        const store = new MigrationManifestStore({ homeDir });
        let m = store.read(GEN);
        const step = (kind: string, extra: Record<string, unknown> = {}) => {
          m = store.update(GEN, m.checksumSha256, (c) => beginMigrationEffect(c, {
            kind: kind as never, effectId: kind === "publish-rollback" ? "rollback-publish-" + "7".repeat(64) : kind,
            inputSha256: "7".repeat(64), startedAt: capturedAt,
          }));
          m = store.update(GEN, m.checksumSha256, (c) => completeMigrationEffect(c, {
            effectId: c.pendingEffect!.effectId, completedAt: capturedAt, ...extra,
          }));
        };
        step("prepare-rollback");
        writeRollbackAuthorityArtifact(homeDir, {
          version: 2, generationId: GEN, operabilityFactState: "authoritatively-absent", operabilityFactValueSha256: null,
          epochId: scenario.epoch.epochId, attemptId: scenario.attempt.attemptId,
          publication: PUBLICATION_SOURCE,
        });
        const effectId = "rollback-publish-" + "7".repeat(64);
        m = store.update(GEN, m.checksumSha256, (c) => beginMigrationEffect(c, {
          kind: "publish-rollback", effectId, inputSha256: "7".repeat(64), startedAt: capturedAt,
        }));
        const report = writeRollbackReport(homeDir, {
          version: 1, reportId: deriveRollbackReportId({ generationId: GEN, effectId, kind: "rollback" }),
          generationId: GEN, effectId, kind: "rollback", eligibility: "post-write", mode: "post-write",
          epochId: scenario.epoch.epochId, attemptId: scenario.attempt.attemptId,
          sealedPublicationMaterialDigestSha256: null, reason: null, selectionBindingManifestRevision: 9999,
        });
        store.update(GEN, m.checksumSha256, (c) => completeMigrationEffect(c, {
          effectId, completedAt: capturedAt,
          report: { kind: "rollback", reportId: report.reportId, reportSha256: report.checksumSha256, createdAt: capturedAt },
          rollbackMode: "post-write",
        }));
        await expect(runRollback(RUN(homeDir), depsFor(homeDir)))
          .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("does not match the manifest history") });
      });
    });
  });
});

// Plan-v3 section 1/3 and amendment A1: with no resolver overrides, the
// orchestration reads the real binding store and the real activation
// evidence store. Each refusal below corrupts exactly one of the three
// observations (evidence store, binding store, operability fact) and is
// paired with a control that leaves them all consistent.
describe("runMigrationRollback against the real binding and evidence stores", () => {
  const RUN = (homeDir: string, generationId: string) => ({
    homeDir, generationId, canonicalPath: join(homeDir, "live.sqlite"),
    projectIdentity: identity, localProjectId: "local-1",
    sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
  });
  const destinationIdentity = fixtureDestinationIdentity("d");
  const neverOpens = async (): Promise<RollbackFencedSession> => {
    throw new Error("must not open a session: refusal happens before maintenance");
  };
  const unchangedSession = (): Promise<RollbackFencedSession> => Promise.resolve(fakeSession({
    observations: [{
      destinationIdentity,
      postEpochDelta: fixtureCanonicalDelta("real-baseline"),
      postEpochCensus: fixtureCensusVector("real-census"),
    }],
    source: sqliteSourceStream,
  }));

  /** Records one activation exactly as the ordering contract says an activation driver does. */
  function recordActivation(homeDir: string, generationId: string, published: boolean) {
    const scenario = fixtureActivationScenario({
      generationId, destinationIdentity,
      censusVector: fixtureCensusVector("real-census"),
      canonicalDeltaBaseline: fixtureCanonicalDelta("real-baseline"),
    });
    recordMigrationActivationEpoch({ homeDir, epoch: scenario.epoch });
    recordMigrationActivationAttempt({ homeDir, generationId, attempt: scenario.attempt });
    recordMigrationActivationWitness({ homeDir, generationId, witness: scenario.witness });
    recordMigrationWitnessBinding({ homeDir, generationId, binding: scenario.witnessBinding });
    if (published) recordMigrationSelectionBinding({ homeDir, generationId, binding: scenario.selection });
    return scenario;
  }

  const plantJunk = (directory: string): void => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "junk.txt"), "stray", { mode: 0o600 });
  };

  it("rolls back a published activation end to end with every default in place, recording the rollback bindings in the real store", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-real");
    const scenario = recordActivation(homeDir, "gen-real", true);

    const outcome = await runRollback(RUN(homeDir, "gen-real"), {
      coordinator: coordinatorFor(homeDir),
      openFencedSession: unchangedSession,
    });

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    expect(outcome.report).toMatchObject({
      eligibility: "pre-write", epochId: scenario.epoch.epochId, attemptId: scenario.attempt.attemptId,
    });
    const bindings = resolveMigrationWitnessBindings({ homeDir, generationId: "gen-real" });
    if (bindings.state !== "resolved") throw new Error("expected the real binding store to resolve");
    expect(bindings.selections.map((entry) => entry.kind).sort()).toEqual(["activation", "rollback"]);
    expect(bindings.witnesses.map((entry) => entry.kind).sort()).toEqual(["activation", "rollback"]);
    const rollbackSelection = bindings.selections.find((entry) => entry.kind === "rollback")!;
    expect(rollbackSelection).toMatchObject({
      epochId: scenario.epoch.epochId,
      attemptId: scenario.attempt.attemptId,
      publicationId: deriveRollbackPublicationId("gen-real"),
    });
  });

it("refuses a never-activated generation with every default in place, writing nothing", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-never");
    await expect(runRollback(RUN(homeDir, "gen-never"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("never completed an activation") });
    expect(resolveMigrationWitnessBindings({ homeDir, generationId: "gen-never" }))
      .toEqual({ state: "authoritatively-absent" });
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    expect(readRollbackAuthorityArtifact(homeDir, "gen-never")).toBeNull();
  });

it("refuses witnessed-but-unpublished as never activated: an epoch and witness are stored, no selection, destination not operable", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-unpublished");
    recordActivation(homeDir, "gen-unpublished", false);
    await expect(runRollback(RUN(homeDir, "gen-unpublished"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("never completed an activation") });
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    expect(readRollbackAuthorityArtifact(homeDir, "gen-unpublished")).toBeNull();
  });

  it("refuses a witnessed-but-unpublished generation once the destination is operable (published but unbound)", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-operable");
    recordActivation(homeDir, "gen-operable", false);
    await establishCompletedPostgresqlPublication(homeDir);
    await expect(runRollback(RUN(homeDir, "gen-operable"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("published-but-unbound") });
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
  });

  it("refuses when only the evidence store is corrupted, before any maintenance", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-bad-evidence");
    recordActivation(homeDir, "gen-bad-evidence", true);
    plantJunk(migrationActivationEvidenceDirectory(homeDir, "gen-bad-evidence"));
    await expect(runRollback(RUN(homeDir, "gen-bad-evidence"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("activation-evidence:unresolvable") });
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
  });

  it("refuses when only the binding store is corrupted, before any maintenance", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-bad-bindings");
    recordActivation(homeDir, "gen-bad-bindings", true);
    plantJunk(migrationGenerationBindingDirectory(homeDir, "gen-bad-bindings"));
    await expect(runRollback(RUN(homeDir, "gen-bad-bindings"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("witness-resolution:unresolvable") });
  });

  it("refuses a selection binding whose evidence records are gone (evidence store absent), never unactivated", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-no-evidence");
    const scenario = fixtureActivationScenario({ generationId: "gen-no-evidence" });
    recordMigrationWitnessBinding({ homeDir, generationId: "gen-no-evidence", binding: scenario.witnessBinding });
    recordMigrationSelectionBinding({ homeDir, generationId: "gen-no-evidence", binding: scenario.selection });
    await expect(runRollback(RUN(homeDir, "gen-no-evidence"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("binding exists without its evidence record") });
  });

  it("refuses an unactivated generation when only the evidence store is corrupted", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-unactivated-bad");
    plantJunk(migrationActivationEvidenceDirectory(homeDir, "gen-unactivated-bad"));
    await expect(runRollback(RUN(homeDir, "gen-unactivated-bad"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("activation-evidence:unresolvable") });
  });

  it("refuses to continue a prepared rollback when the evidence store was corrupted after the crash", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-continue-bad");
    recordActivation(homeDir, "gen-continue-bad", true);
    const coordinator = coordinatorFor(homeDir);
    const crashing = await unchangedSession();
    crashing.renew = async () => { throw new Error("simulated crash after step 8"); };
    await expect(runRollback(RUN(homeDir, "gen-continue-bad"), {
      coordinator, openFencedSession: async () => crashing,
    })).rejects.toThrow("simulated crash after step 8");

    plantJunk(migrationActivationEvidenceDirectory(homeDir, "gen-continue-bad"));
    await expect(runRollback(RUN(homeDir, "gen-continue-bad"), {
      coordinator, openFencedSession: neverOpens,
    })).rejects.toMatchObject({
      reason: "unexpected-state",
      message: expect.stringContaining("authority resolution now refuses: activation-evidence:unresolvable"),
    });
  });

  it("refuses when the authoritative context cannot be fetched for a selection the stores agree on", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-no-context");
    recordActivation(homeDir, "gen-no-context", true);
    await expect(runRollback(RUN(homeDir, "gen-no-context"), {
      coordinator: coordinatorFor(homeDir),
      resolveAuthoritativeContext: async () => null,
      openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("could not be fetched") });
  });

  it("refuses to continue a prepared rollback when the authoritative context can no longer be fetched", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-continue-no-context");
    recordActivation(homeDir, "gen-continue-no-context", true);
    const coordinator = coordinatorFor(homeDir);
    const crashing = await unchangedSession();
    crashing.renew = async () => { throw new Error("simulated crash after step 8"); };
    await expect(runRollback(RUN(homeDir, "gen-continue-no-context"), {
      coordinator, openFencedSession: async () => crashing,
    })).rejects.toThrow("simulated crash after step 8");
    await expect(runRollback(RUN(homeDir, "gen-continue-no-context"), {
      coordinator, resolveAuthoritativeContext: async () => null, openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("could not be fetched") });
  });
});


// Refusal, recovery and I/O paths of rollback.ts that the happy-path and
// real-store tests above do not reach. recoverPendingPublishRollback is
// deliberately not exercised here: plan-v3.1 amendment A9 rewrites it.
describe("rollback.ts refusal, recovery and I/O paths", () => {
  const RUN = (homeDir: string, generationId: string, extra: Record<string, unknown> = {}) => ({
    homeDir, generationId, canonicalPath: join(homeDir, "live.sqlite"),
    projectIdentity: identity, localProjectId: "local-1",
    sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    ...extra,
  });
  const destinationIdentity = fixtureDestinationIdentity("d");
  const baseline = fixtureCanonicalDelta("paths-baseline");
  const census = fixtureCensusVector("paths-census");
  const witnessSha = storageWitness("postgresql", "4").identitySha256;
  const neverOpens = async (): Promise<RollbackFencedSession> => {
    throw new Error("must not open a session");
  };
  const scenarioFor = (generationId: string) => fixtureActivationScenario({
    generationId, destinationIdentity, censusVector: census, canonicalDeltaBaseline: baseline,
  });
  const unchanged = { destinationIdentity, postEpochDelta: baseline, postEpochCensus: census };
  const sessionOf = (...observations: Parameters<typeof fakeSession>[0]["observations"][number][]) => async () =>
    fakeSession({ observations, source: sqliteSourceStream });
  const unactivatedSession = sessionOf({
    destinationIdentity, postEpochDelta: fixtureCanonicalDelta("delta"), postEpochCensus: null,
  });

  function manifestAtActive(store: MigrationManifestStore, generationId: string): MigrationManifest {
    let m = manifestAtVerified(store, generationId);
    const step = (kind: string, completion: Record<string, unknown>) => {
      m = store.update(generationId, m.checksumSha256, (current) => beginMigrationEffect(current, {
        kind: kind as never, effectId: kind, inputSha256: "a".repeat(64), startedAt: capturedAt,
      }));
      m = store.update(generationId, m.checksumSha256, (current) => completeMigrationEffect(current, {
        effectId: kind, completedAt: capturedAt, ...completion,
      }));
    };
    step("prepare-activation", {});
    step("publish-activation", { report: { kind: "activation", reportId: "r-act", reportSha256: "b".repeat(64), createdAt: capturedAt } });
    return m;
  }

  it("rolls back from phase active (a settled manifest with no pending effect)", async () => {
    const homeDir = tempHome();
    const m = manifestAtActive(new MigrationManifestStore({ homeDir }), "gen-active");
    expect(m.phase).toBe("active");
    const outcome = await runRollback(RUN(homeDir, "gen-active"), {
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(scenarioFor("gen-active")),
      recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
      openFencedSession: sessionOf(unchanged),
    });
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.returnPhase).toBe("active");
  });

  describe("the operability fact", () => {
    it("records a present fact in the authority artifact when the destination is operable and a selection is bound", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-operable-bound");
      await establishCompletedPostgresqlPublication(homeDir);
      const live = await readBackendPublicationOperabilityFact({ homeDir });
      await runRollback(RUN(homeDir, "gen-operable-bound"), {
        coordinator: coordinatorFor(homeDir),
        ...authoritativeDeps(scenarioFor("gen-operable-bound")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
        openFencedSession: sessionOf(unchanged),
      });
      expect(readRollbackAuthorityArtifact(homeDir, "gen-operable-bound")).toMatchObject({
        operabilityFactState: "present",
        operabilityFactValueSha256: live.state === "present" ? live.valueSha256 : null,
        });
    });

    it("continues a prepared rollback from a present fact recorded in the artifact while maintenance holds the live slot", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-operable-continue");
      await establishCompletedPostgresqlPublication(homeDir);
      const coordinator = coordinatorFor(homeDir);
      const deps = {
        ...authoritativeDeps(scenarioFor("gen-operable-continue")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
      };
      const crashing = fakeSession({ observations: [unchanged], source: sqliteSourceStream });
      crashing.renew = async () => { throw new Error("simulated crash after step 8"); };
      await expect(runRollback(RUN(homeDir, "gen-operable-continue"), {
        coordinator, ...deps, openFencedSession: async () => crashing,
      })).rejects.toThrow("simulated crash after step 8");
      const outcome = await runRollback(RUN(homeDir, "gen-operable-continue"), {
        coordinator, ...deps, openFencedSession: sessionOf(unchanged),
      });
      expect(outcome.manifest.phase).toBe("rolled-back");
    });

    it("refuses when maintenance holds the live slot and no durable artifact exists to recover the fact from", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-foreign-maintenance");
      await coordinatorFor(homeDir).enterMaintenance({
        publicationId: "some-other-publication", generationId: "some-other-generation",
        sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
        now: new Date(capturedAt),
      });
      await expect(runRollback(RUN(homeDir, "gen-foreign-maintenance"), {
        coordinator: coordinatorFor(homeDir), ...absentDeps(), openFencedSession: neverOpens,
      })).rejects.toMatchObject({
        reason: "not-eligible",
        message: expect.stringContaining("no durable rollback-authority artifact exists"),
      });
    });

    it("refuses on an unresolvable fact whose cause is not the expected maintenance hold (consumer lock contention)", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-lock");
      await withBackendPublicationConsumerLockAsync(homeDir, async () => {
        await expect(runRollback(RUN(homeDir, "gen-lock"), {
          coordinator: coordinatorFor(homeDir), ...absentDeps(), openFencedSession: neverOpens,
        })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("operability-fact:unresolvable") });
      });
    });

    it("accepts a live present fact that agrees with the artifact's recorded value, and refuses one that does not", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-fact-agree");
      await establishCompletedPostgresqlPublication(homeDir);
      const artifact = (valueSha256: string) => ({
        version: 2 as const, generationId: "gen-fact-agree", operabilityFactState: "present" as const,
        operabilityFactValueSha256: valueSha256, epochId: scenarioFor("gen-fact-agree").epoch.epochId, attemptId: scenarioFor("gen-fact-agree").attempt.attemptId,
        publication: PUBLICATION_SOURCE,
      });
      const deps = {
        coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-fact-agree")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
      };
      writeRollbackAuthorityArtifact(homeDir, artifact("0".repeat(64)));
      await expect(runRollback(RUN(homeDir, "gen-fact-agree"), { ...deps, openFencedSession: neverOpens }))
        .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("disagrees with the durable") });

      const agreeHome = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir: agreeHome }), "gen-fact-agree");
      await establishCompletedPostgresqlPublication(agreeHome);
      const agreeLive = await readBackendPublicationOperabilityFact({ homeDir: agreeHome });
      if (agreeLive.state !== "present") throw new Error("expected a present fact");
      writeRollbackAuthorityArtifact(agreeHome, artifact(agreeLive.valueSha256));
      const outcome = await runRollback(RUN(agreeHome, "gen-fact-agree"), {
        ...deps, coordinator: coordinatorFor(agreeHome), openFencedSession: sessionOf(unchanged),
      });
      expect(outcome.manifest.phase).toBe("rolled-back");
    });
  });

  describe("the authority artifact and the report store", () => {
    const body = (generationId: string, epochId: string) => ({
      version: 2 as const, generationId, operabilityFactState: "authoritatively-absent" as const,
      operabilityFactValueSha256: null, epochId, attemptId: epochId, publication: PUBLICATION_SOURCE,
    });
    const artifactPath = (homeDir: string, generationId: string) =>
      join(homeDir, ".lcm", "migration-rollback-authority", deriveRollbackAuthorityArtifactId(generationId) + ".json");

    it("reuses an identical artifact and refuses a different one under the same generation", () => {
      const homeDir = tempHome();
      const first = writeRollbackAuthorityArtifact(homeDir, body("gen-artifact", "d".repeat(64)));
      expect(writeRollbackAuthorityArtifact(homeDir, body("gen-artifact", "d".repeat(64)))).toEqual(first);
      expect(() => writeRollbackAuthorityArtifact(homeDir, body("gen-artifact", "e".repeat(64)))).toThrow();
    });

    it("reports an artifact that cannot be read for a reason other than absence", () => {
      const homeDir = tempHome();
      mkdirSync(artifactPath(homeDir, "gen-artifact-dir"), { recursive: true, mode: 0o700 });
      expect(() => readRollbackAuthorityArtifact(homeDir, "gen-artifact-dir")).toThrow();
    });

    it("refuses an artifact whose checksum does not match its content", () => {
      const homeDir = tempHome();
      writeRollbackAuthorityArtifact(homeDir, body("gen-artifact-sum", "d".repeat(64)));
      const path = artifactPath(homeDir, "gen-artifact-sum");
      chmodSync(path, 0o600);
      writeFileSync(path, readFileSync(path, "utf8").replace("authoritatively-absent", "present"), { mode: 0o400 });
      chmodSync(path, 0o400);
      expect(() => readRollbackAuthorityArtifact(homeDir, "gen-artifact-sum")).toThrow(/checksum/);
    });

    const reportBody = (reason: string | null) => ({
      version: 1 as const, reportId: "report-1", generationId: "gen-report", effectId: "effect-1",
      kind: "abandonment" as const, eligibility: null, mode: null, epochId: null, attemptId: null,
      sealedPublicationMaterialDigestSha256: null, reason,
    });
    const reportFile = (homeDir: string) => join(homeDir, ".lcm", "migration-reports", "gen-report", "report-1.json");

    it("returns null for a report that was never written", () => {
      expect(readRollbackReport(tempHome(), "gen-report", "report-1")).toBeNull();
    });

    it("reuses an identical report and refuses a different one under the same report id", () => {
      const homeDir = tempHome();
      const first = writeRollbackReport(homeDir, reportBody("one"));
      expect(writeRollbackReport(homeDir, reportBody("one"))).toEqual(first);
      expect(() => writeRollbackReport(homeDir, reportBody("two"))).toThrow();
    });

    it("reports a report that cannot be read for a reason other than absence", () => {
      const homeDir = tempHome();
      mkdirSync(reportFile(homeDir), { recursive: true, mode: 0o700 });
      expect(() => readRollbackReport(homeDir, "gen-report", "report-1")).toThrow();
    });

    it("refuses a report whose checksum does not match its content", () => {
      const homeDir = tempHome();
      writeRollbackReport(homeDir, reportBody("one"));
      chmodSync(reportFile(homeDir), 0o600);
      writeFileSync(reportFile(homeDir), readFileSync(reportFile(homeDir), "utf8").replace("one", "two"), { mode: 0o400 });
      chmodSync(reportFile(homeDir), 0o400);
      expect(() => readRollbackReport(homeDir, "gen-report", "report-1")).toThrow(/checksum/);
    });
  });

  describe("publishing a manifest successor", () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it("converges when an update landed durably but reported failure, for a successor with and without a pending effect", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-landed");
      const real = MigrationManifestStore.prototype.update;
      let calls = 0;
      vi.spyOn(MigrationManifestStore.prototype, "update").mockImplementation(function (this: MigrationManifestStore, ...args: Parameters<typeof real>) {
        calls += 1;
        const result = real.apply(this, args);
        // The first two updates (begin prepare-rollback, complete it) land and then fail.
        if (calls <= 2) throw new Error("simulated failure after the update landed");
        return result;
      });
      const outcome = await runRollback(RUN(homeDir, "gen-landed"), {
        coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-landed")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
        openFencedSession: sessionOf(unchanged),
      });
      expect(outcome.manifest.phase).toBe("rolled-back");
    });

    it("rethrows when an update failed and the manifest does not hold the successor", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-not-landed");
      vi.spyOn(MigrationManifestStore.prototype, "update").mockImplementation(() => {
        throw new Error("simulated failure before the update landed");
      });
      await expect(runRollback(RUN(homeDir, "gen-not-landed"), {
        coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-not-landed")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
        openFencedSession: sessionOf(unchanged),
      })).rejects.toThrow("simulated failure before the update landed");
    });
  });

  it("compares maintenance rosters independently of order, adopting a held maintenance only when every field matches", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-roster");
    const second = "018f0b5d-1234-4abc-8def-1234567890ac";
    const rosterOf = (...ids: string[]) => ids.map((machineId) => ({ machineId, queueCutoff: null, evidenceSha256: "7".repeat(64) }));
    const coordinator = coordinatorFor(homeDir);
    await coordinator.enterMaintenance({
      publicationId: deriveRollbackPublicationId("gen-roster"), generationId: "gen-roster",
      sourceBackend: "postgresql", sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64),
      roster: rosterOf(MACHINE_ID, second), now: new Date(capturedAt),
    });
    writeRollbackAuthorityArtifact(homeDir, {
      version: 2, generationId: "gen-roster", operabilityFactState: "authoritatively-absent",
      operabilityFactValueSha256: null, epochId: scenarioFor("gen-roster").selection.epochId, attemptId: scenarioFor("gen-roster").selection.attemptId,
      publication: PUBLICATION_SOURCE,
    });
    // Same machines in the opposite order, plus a repeated id so every comparison outcome is reached: not the held roster.
    await expect(runRollback(RUN(homeDir, "gen-roster", { roster: rosterOf(second, MACHINE_ID, MACHINE_ID) }), {
      coordinator, ...authoritativeDeps(scenarioFor("gen-roster")), openFencedSession: neverOpens,
    })).rejects.toThrow();
    // The held roster in the opposite order is adopted.
    const outcome = await runRollback(RUN(homeDir, "gen-roster", { roster: rosterOf(second, MACHINE_ID) }), {
      coordinator, ...authoritativeDeps(scenarioFor("gen-roster")),
      recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
      openFencedSession: sessionOf(unchanged),
    });
    expect(outcome.manifest.phase).toBe("rolled-back");
  });

  it("refuses to resume a pending prepare-rollback begun with a different input", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    const verified = manifestAtVerified(store, "gen-wrong-pending");
    store.update("gen-wrong-pending", verified.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "prepare-rollback", effectId: "rollback-prepare-other", inputSha256: "9".repeat(64), startedAt: capturedAt,
    }));
    await expect(runRollback(RUN(homeDir, "gen-wrong-pending"), {
      coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-wrong-pending")), openFencedSession: sessionOf(unchanged),
    })).rejects.toMatchObject({ reason: "unexpected-state" });
  });

  describe("the post-write build", () => {
    const postWrite = { ...unchanged, postEpochDelta: fixtureCanonicalDelta("paths-changed"), postEpochCensus: null };

    it("quarantines a failed build and refuses rather than installing it", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-quarantine");
      const failing = async (): Promise<PortableRecordStream> => {
        const real = await sqliteSourceStream();
        return {
          describe: () => real.describe(),
          readBatch: () => { throw new Error("simulated source failure"); },
          verify: (checkpoint) => real.verify(checkpoint),
          close: () => real.close(),
        };
      };
      await expect(runRollback(RUN(homeDir, "gen-quarantine"), {
        coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-quarantine")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
        openFencedSession: async () => fakeSession({ observations: [postWrite], source: failing }),
      })).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("was quarantined") });
      expect(existsSync(join(homeDir, "live.sqlite"))).toBe(false);
    });


    describe("build-to-revalidation equality (plan-v3.1 A6)", () => {
      const refuseDeps = (homeDir: string, generationId: string, session: RollbackFencedSession, recorded: unknown[]) => ({
        coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor(generationId)),
        recordSelectionBinding: (call: { binding: unknown }) => { recorded.push(call.binding); },
        recordWitnessBinding: (call: { binding: unknown }) => { recorded.push(call.binding); },
        openFencedSession: async () => session,
      });
      const expectNothingInstalledOrSelected = (homeDir: string, recorded: unknown[]) => {
        expect(existsSync(join(homeDir, "live.sqlite"))).toBe(false);
        expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
        expect(recorded).toEqual([]);
      };

      it("refuses an unfenced write between build and revalidation that leaves the mode at post-write, installing and selecting nothing", async () => {
        const homeDir = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-a6-delta");
        const recorded: unknown[] = [];
        // Step 4 and the export snapshot see one delta; step 10 sees another that is still not the baseline.
        const session = fakeSession({
          observations: [postWrite, { ...postWrite, postEpochDelta: fixtureCanonicalDelta("paths-changed-again") }],
          source: sqliteSourceStream,
          exportEvidence: { canonicalDelta: postWrite.postEpochDelta, censusVector: census },
        });
        await expect(runRollback(RUN(homeDir, "gen-a6-delta"), refuseDeps(homeDir, "gen-a6-delta", session, recorded)))
          .rejects.toMatchObject({ reason: "drift", message: expect.stringContaining("canonical delta differs") });
        expectNothingInstalledOrSelected(homeDir, recorded);
      });

      it("refuses a census that differs from the export snapshot's even when the delta is identical", async () => {
        const homeDir = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-a6-census");
        const recorded: unknown[] = [];
        const session = fakeSession({
          observations: [postWrite], source: sqliteSourceStream,
          exportEvidence: { canonicalDelta: postWrite.postEpochDelta, censusVector: census },
          requiredCensus: fixtureCensusVector("a-different-census"),
        });
        await expect(runRollback(RUN(homeDir, "gen-a6-census"), refuseDeps(homeDir, "gen-a6-census", session, recorded)))
          .rejects.toMatchObject({ reason: "drift", message: expect.stringContaining("census differs") });
        expectNothingInstalledOrSelected(homeDir, recorded);
      });

      it("refuses when the revalidation snapshot did not capture a census at all", async () => {
        const homeDir = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-a6-missing");
        const recorded: unknown[] = [];
        const session = fakeSession({
          observations: [postWrite], source: sqliteSourceStream,
          exportEvidence: { canonicalDelta: postWrite.postEpochDelta, censusVector: census },
        });
        const real = session.captureReadback.bind(session);
        let calls = 0;
        session.captureReadback = async (request) => {
          calls += 1;
          const observation = await real(request);
          return calls === 1 ? observation : { ...observation, postEpochCensus: null };
        };
        await expect(runRollback(RUN(homeDir, "gen-a6-missing"), refuseDeps(homeDir, "gen-a6-missing", session, recorded)))
          .rejects.toMatchObject({ reason: "drift", message: expect.stringContaining("census differs") });
        expectNothingInstalledOrSelected(homeDir, recorded);
      });

      it("control: the same run completes when revalidation reproduces the export snapshot's delta and census", async () => {
        const homeDir = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-a6-control");
        const recorded: unknown[] = [];
        const session = fakeSession({
          observations: [postWrite], source: sqliteSourceStream,
          exportEvidence: { canonicalDelta: postWrite.postEpochDelta, censusVector: census },
          requiredCensus: census,
        });
        const outcome = await runRollback(RUN(homeDir, "gen-a6-control"), refuseDeps(homeDir, "gen-a6-control", session, recorded));
        expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
        expect(recorded).toHaveLength(2);
      });

      it("asks step 10 for the census only on a post-write rollback, and records the export evidence in the build's witness", async () => {
        const homeDir = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-a6-plumbing");
        const requests: Array<{ requireCensus?: boolean }> = [];
        const session = fakeSession({ observations: [postWrite], source: sqliteSourceStream });
        const real = session.captureReadback.bind(session);
        session.captureReadback = async (request) => { requests.push(request); return real(request); };
        const outcome = await runRollback(RUN(homeDir, "gen-a6-plumbing"), {
          coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-a6-plumbing")),
          recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
          openFencedSession: async () => session,
        });
        expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
        expect(requests.map((request) => request.requireCensus)).toEqual([undefined, true]);
        const buildRoot = join(homeDir, ".lcm", "migration-rollback-generations");
        const built = readdirSync(buildRoot).find((name) => name.startsWith("gen-a6-plumbing-rb"))!;
        const witness = JSON.parse(readFileSync(join(buildRoot, built, "witness.json"), "utf8")) as {
          exportEvidence: { canonicalDelta: unknown; censusVector: unknown } | null;
        };
        expect(witness.exportEvidence).toEqual({
          canonicalDelta: postWrite.postEpochDelta,
          censusVector: fixtureCensusVector("fake-export-census"),
        });

        const preHome = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir: preHome }), "gen-a6-pre");
        const preRequests: Array<{ requireCensus?: boolean }> = [];
        const preSession = fakeSession({ observations: [unchanged], source: sqliteSourceStream });
        const preReal = preSession.captureReadback.bind(preSession);
        preSession.captureReadback = async (request) => { preRequests.push(request); return preReal(request); };
        await runRollback(RUN(preHome, "gen-a6-pre"), {
          coordinator: coordinatorFor(preHome), ...authoritativeDeps(scenarioFor("gen-a6-pre")),
          recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
          openFencedSession: async () => preSession,
        });
        expect(preRequests.map((request) => request.requireCensus)).toEqual([undefined, false]);
      });
    });

    it("counts only this generation and revision's well-formed attempt directories, and refuses an oversized build root", async () => {
      const homeDir = tempHome();
      const store = new MigrationManifestStore({ homeDir });
      manifestAtVerified(store, "gen-enum");
      const buildRoot = join(homeDir, ".lcm", "migration-rollback-generations");
      mkdirSync(buildRoot, { mode: 0o700 });
      for (const name of ["unrelated", "gen-enum-rb10-notanumber", "gen-enum-rb10-99999999999999999999"]) {
        mkdirSync(join(buildRoot, name), { mode: 0o700 });
      }
      const deps = {
        coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-enum")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
        openFencedSession: async () => fakeSession({ observations: [postWrite], source: sqliteSourceStream }),
      };
      await expect(runRollback(RUN(homeDir, "gen-enum", { _maxBuildAttemptEntries: 2 }), deps))
        .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("more entries than") });
      const outcome = await runRollback(RUN(homeDir, "gen-enum"), deps);
      expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
    });
  });

  it("refuses with the revalidation's own reason when step 10 finds a different destination identity", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-revalidate");
    await expect(runRollback(RUN(homeDir, "gen-revalidate"), {
      coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-revalidate")),
      recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
      openFencedSession: sessionOf(unchanged, { ...unchanged, destinationIdentity: fixtureDestinationIdentity("swapped") }),
    })).rejects.toMatchObject({
      reason: "not-eligible",
      message: expect.stringContaining("destination identity does not match the authoritative epoch"),
    });
  });

  it("refuses at step 11 when the held maintenance journal has vanished from the live slot", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-journal-gone");
    const session = fakeSession({ observations: [unchanged], source: sqliteSourceStream });
    session.renew = async () => { unlinkSync(backendPublicationJournalPath(homeDir)); };
    await expect(runRollback(RUN(homeDir, "gen-journal-gone"), {
      coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-journal-gone")),
      recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
      openFencedSession: async () => session,
    })).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("unexpectedly absent") });
  });

  it("refuses to continue a prepared rollback when the destination identity changed after the crash", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-continue-refused");
    const coordinator = coordinatorFor(homeDir);
    const deps = {
      ...authoritativeDeps(scenarioFor("gen-continue-refused")),
      recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
    };
    const crashing = fakeSession({ observations: [unchanged], source: sqliteSourceStream });
    crashing.renew = async () => { throw new Error("simulated crash after step 8"); };
    await expect(runRollback(RUN(homeDir, "gen-continue-refused"), {
      coordinator, ...deps, openFencedSession: async () => crashing,
    })).rejects.toThrow("simulated crash after step 8");
    await expect(runRollback(RUN(homeDir, "gen-continue-refused"), {
      coordinator, ...deps,
      openFencedSession: sessionOf({ ...unchanged, destinationIdentity: fixtureDestinationIdentity("swapped") }),
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("destination identity") });
  });
});


describe("runMigrationRollback: only the covered project may be remotely bound (A14)", () => {
  const RUN = (homeDir: string, generationId: string, extra: Record<string, unknown> = {}) => ({
    homeDir, generationId, canonicalPath: join(homeDir, "live.sqlite"),
    projectIdentity: identity, localProjectId: "local-1",
    sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    ...extra,
  });
  const remote = (suffix: string): string => "01990000-0000-7000-8000-0000000000" + suffix;
  const bound = (suffix: string) => ({ canonical: "/p-" + suffix, aliases: [], remoteProjectId: remote(suffix) });
  const localOnly = { canonical: "/local-only", aliases: [] };
  const destinationIdentity = fixtureDestinationIdentity("d");
  const a14Scenario = fixtureActivationScenario({
    destinationIdentity, censusVector: fixtureCensusVector("a14"), canonicalDeltaBaseline: fixtureCanonicalDelta("a14"),
  });
  const unchangedSession = async (): Promise<RollbackFencedSession> => fakeSession({
    observations: [{
      destinationIdentity, postEpochDelta: fixtureCanonicalDelta("a14"), postEpochCensus: fixtureCensusVector("a14"),
    }],
    source: sqliteSourceStream,
  });
  const neverOpens = async (): Promise<RollbackFencedSession> => {
    throw new Error("must not open a session: refusal happens before maintenance");
  };
  const deps = (homeDir: string, map: () => ReturnType<typeof coveredOnlyProjectMap>, open = neverOpens) => ({
    coordinator: coordinatorFor(homeDir),
    ...authoritativeDeps(a14Scenario),
    readProjectMap: map,
    readRetainedMaterial: () => retainedActivationPublication(),
    composePublication: composeRollbackPublication,
    recordActivationWitness: () => undefined,
    recordSelectionBinding: () => undefined,
    recordWitnessBinding: () => undefined,
    openFencedSession: open,
  });

  function expectNothingDurable(homeDir: string, generationId: string): void {
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    expect(readRollbackAuthorityArtifact(homeDir, generationId)).toBeNull();
    const manifest = new MigrationManifestStore({ homeDir }).read(generationId);
    expect(manifest.phase).toBe("verified");
    expect(manifest.pendingEffect).toBeNull();
  }

  it("refuses two remotely bound projects before any durable change", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-two");
    await expect(runMigrationRollback(RUN(homeDir, "gen-two"), deps(homeDir, () => ({
      "local-1": bound("01"), "other-hash": bound("02"),
    })))).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
      message: expect.stringContaining("multiple-remote-projects"),
    });
    expectNothingDurable(homeDir, "gen-two");
  });

  it("is not blocked by a second, unbound (local-only) entry (positive control)", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-local-only");
    const outcome = await runMigrationRollback(
      RUN(homeDir, "gen-local-only", { projectIdentity: { scope: "shared", projectId: remote("01") }, localProjectId: FIXTURE_LOCAL_PROJECT_ID }),
      deps(homeDir, () => ({ [FIXTURE_LOCAL_PROJECT_ID]: bound("01"), "other-hash": localOnly }), unchangedSession));
    expect(outcome.manifest.phase).toBe("rolled-back");
  });

  it("refuses when the project map does not bind the covered project, even if no other project is bound", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-unbound");
    for (const map of [{ "local-1": localOnly }, {}, { "other-hash": bound("02") }]) {
      await expect(runMigrationRollback(RUN(homeDir, "gen-unbound"), deps(homeDir, () => map)))
        .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringMatching(/covered-project-unbound.*lcm migration abort/u) });
    }
    expectNothingDurable(homeDir, "gen-unbound");
  });

  it("refuses when the map binds the covered project to a different PostgreSQL project than the rollback covers", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-mismatch");
    await expect(runMigrationRollback(
      RUN(homeDir, "gen-mismatch", { projectIdentity: { scope: "shared", projectId: remote("09") } }),
      deps(homeDir, () => ({ "local-1": bound("01") })),
    )).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("covered-project-mismatch") });
    expectNothingDurable(homeDir, "gen-mismatch");
  });

  it("refuses when the project map cannot be read", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-unreadable");
    await expect(runMigrationRollback(RUN(homeDir, "gen-unreadable"), deps(homeDir, () => {
      throw new Error("simulated map failure");
    }))).rejects.toMatchObject({
      reason: "not-eligible",
      message: expect.stringMatching(/project-map-unreadable.*simulated map failure/su),
    });
    expectNothingDurable(homeDir, "gen-unreadable");
  });

  it("reads the real project map file: a corrupted map refuses and two bound entries refuse", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-real-map");
    const run = () => runMigrationRollback(RUN(homeDir, "gen-real-map", { localProjectId: "a".repeat(64) }), {
      coordinator: coordinatorFor(homeDir), ...absentDeps(),
      recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined, openFencedSession: neverOpens,
    });
    const hash = (character: string): string => character.repeat(64);
    clearProjectMapCache();
    writeFileSync(projectMapPath(homeDir), "{not json", { mode: 0o600 });
    await expect(run()).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("project-map-unreadable") });
    clearProjectMapCache();
    writeFileSync(projectMapPath(homeDir), JSON.stringify({
      [hash("a")]: bound("01"), [hash("b")]: bound("02"),
    }), { mode: 0o600 });
    await expect(run()).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("multiple-remote-projects") });
    expectNothingDurable(homeDir, "gen-real-map");
  });

  it("re-checks under the retained token and refuses before the selection flip when a second project became bound", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-recheck");
    let reads = 0;
    const tokens: unknown[] = [];
    await expect(runMigrationRollback(
      RUN(homeDir, "gen-recheck", { localProjectId: FIXTURE_LOCAL_PROJECT_ID }),
      deps(homeDir, ((_home?: string, token?: unknown) => {
        reads += 1;
        tokens.push(token);
        return reads === 1
          ? { [FIXTURE_LOCAL_PROJECT_ID]: bound("01") }
          : { [FIXTURE_LOCAL_PROJECT_ID]: bound("01"), "other-hash": bound("02") };
      }) as never, unchangedSession),
    )).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("multiple-remote-projects") });
    expect(reads).toBe(2);
    expect(tokens[0]).toBeUndefined();
    expect(tokens[1]).toBeDefined();
    // Maintenance is held, but the selection was never prepared: both projects stay on PostgreSQL.
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    expect(readBackendMaintenanceJournal(homeDir)?.targetBackend ?? null).toBeNull();
  });
});


describe("runMigrationRollback: recovery guards on settled and pending manifests", () => {
  const GEN = "gen-guards";
  const RUN = (homeDir: string) => ({
    homeDir, generationId: GEN, canonicalPath: join(homeDir, "live.sqlite"),
    projectIdentity: identity, localProjectId: "local-guards",
    sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
  });
  const deps = (homeDir: string): RunMigrationRollbackDependencies => ({
    coordinator: coordinatorFor(homeDir),
    ...absentDeps(),
    openFencedSession: async () => { throw new Error("must not open a session"); },
  });
  const writeAuthorityArtifact = (homeDir: string): void => {
    writeRollbackAuthorityArtifact(homeDir, {
      version: 2, generationId: GEN, operabilityFactState: "authoritatively-absent", operabilityFactValueSha256: null,
      epochId: "epoch-1", attemptId: "attempt-1", publication: PUBLICATION_SOURCE,
    });
  };
  const begin = (store: MigrationManifestStore, manifest: MigrationManifest, kind: string): MigrationManifest =>
    store.update(GEN, manifest.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: kind as never, effectId: kind, inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
  const complete = (store: MigrationManifestStore, manifest: MigrationManifest, kind: string, extra: Record<string, unknown>): MigrationManifest =>
    store.update(GEN, manifest.checksumSha256, (c) => completeMigrationEffect(c, { effectId: kind, completedAt: capturedAt, ...extra }));

  it("refuses a manifest settled at aborted", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    let m = manifestAtVerified(store, GEN);
    m = complete(store, begin(store, m, "abort"), "abort", {
      report: { kind: "abort", reportId: "r-abort", reportSha256: "b".repeat(64), createdAt: capturedAt },
    });
    expect(m.phase).toBe("aborted");
    await expect(runRollback(RUN(homeDir), deps(homeDir)))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("settled at phase aborted") });
  });

  it("refuses a pending irreversible effect that is not a publish-rollback", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    let m = manifestAtVerified(store, GEN);
    m = complete(store, begin(store, m, "prepare-activation"), "prepare-activation", {});
    m = begin(store, m, "publish-activation");
    expect(m.pendingEffect?.kind).toBe("publish-activation");
    await expect(runRollback(RUN(homeDir), deps(homeDir)))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("without a pending publish-rollback") });
  });

  it("refuses to continue a prepared rollback whose authority artifact is gone", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    const m = manifestAtVerified(store, GEN);
    complete(store, begin(store, m, "prepare-rollback"), "prepare-rollback", {});
    await expect(runRollback(RUN(homeDir), deps(homeDir)))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("authority artifact is absent") });
  });

  it("abandons a pending publish-rollback when no maintenance journal remains to reconcile", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    let m = manifestAtVerified(store, GEN);
    m = complete(store, begin(store, m, "prepare-rollback"), "prepare-rollback", {});
    begin(store, m, "publish-rollback");
    writeAuthorityArtifact(homeDir);
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    const outcome = await runRollback(RUN(homeDir), deps(homeDir));
    expect(outcome.manifest.phase).toBe("verified");
    expect(outcome.report).toMatchObject({ kind: "abandonment", epochId: null, attemptId: null });
  });

  it("builds the retry of a post-write rollback into the next ordinal when a crash left an earlier build (step 10)", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), GEN);
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("ordinal-baseline");
    const retryDeps = (renewCrash: boolean): RunMigrationRollbackDependencies => ({
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(fixtureActivationScenario({
        generationId: GEN, destinationIdentity, censusVector: fixtureCensusVector("ordinal-census"), canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => {
        const session = fakeSession({
          observations: [{
            destinationIdentity, postEpochDelta: fixtureCanonicalDelta("ordinal-changed"), postEpochCensus: null,
          }],
          source: sqliteSourceStream,
        });
        if (renewCrash) session.renew = async () => { throw new Error("simulated crash at step 10"); };
        return session;
      },
    });
    await expect(runRollback(RUN(homeDir), retryDeps(true))).rejects.toThrow("simulated crash at step 10");
    const outcome = await runRollback(RUN(homeDir), retryDeps(false));
    expect(outcome.manifest.phase).toBe("rolled-back");
    const builds = readdirSync(join(homeDir, ".lcm", "migration-rollback-generations")).filter((name) => name.startsWith(GEN + "-rb"));
    expect(builds.map((name) => name.slice(name.lastIndexOf("-") + 1)).sort()).toEqual(["1", "2"]);
  });

  /**
   * PR #1556 thread 4307516136: a generation id may be the full 128 characters the stores allow, so the build id
   * cannot append "-rb<revision>-<ordinal>" verbatim. The base is bounded deterministically, independent of the
   * revision and ordinal, so retries after a crash still find the earlier attempts of the same base.
   */
  describe("bounded build ids for long generation ids", () => {
    const LONG = "g".repeat(128);
    const BUDGET = 128 - ("-rb".length + 16 + "-".length + 16);

    it("keeps a base within the budget unchanged and bounds a longer one deterministically, distinctly and within the character set", () => {
      expect(rollbackGenerationBuildBase("g".repeat(BUDGET))).toBe("g".repeat(BUDGET));
      const bounded = rollbackGenerationBuildBase(LONG);
      expect(bounded).toHaveLength(BUDGET);
      expect(bounded).toBe(rollbackGenerationBuildBase(LONG));
      expect(bounded).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
      // Two ids that share every leading character differ by digest.
      expect(rollbackGenerationBuildBase("g".repeat(127) + "h")).not.toBe(bounded);
      expect(rollbackGenerationBuildBase("g".repeat(BUDGET + 1))).not.toBe(bounded);
      // The longest suffix the derivation reserves for still fits the limit.
      expect((bounded + "-rb" + "9".repeat(16) + "-" + "9".repeat(16)).length).toBe(128);
    });

    it("builds, crashes at step 10 and retries into the next ordinal with a 128-character generation id, every build id within the limit", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), LONG);
      const destinationIdentity = fixtureDestinationIdentity("d");
      const baseline = fixtureCanonicalDelta("long-baseline");
      const run = { ...RUN(homeDir), generationId: LONG };
      const retryDeps = (renewCrash: boolean): RunMigrationRollbackDependencies => ({
        coordinator: coordinatorFor(homeDir),
        ...authoritativeDeps(fixtureActivationScenario({
          generationId: LONG, destinationIdentity, censusVector: fixtureCensusVector("long-census"), canonicalDeltaBaseline: baseline,
        })),
        recordSelectionBinding: () => undefined,
        recordWitnessBinding: () => undefined,
        openFencedSession: async () => {
          const session = fakeSession({
            observations: [{
              destinationIdentity, postEpochDelta: fixtureCanonicalDelta("long-changed"), postEpochCensus: null,
            }],
            source: sqliteSourceStream,
          });
          if (renewCrash) session.renew = async () => { throw new Error("simulated crash at step 10"); };
          return session;
        },
      });
      await expect(runRollback(run, retryDeps(true))).rejects.toThrow("simulated crash at step 10");
      const outcome = await runRollback(run, retryDeps(false));
      expect(outcome.manifest.phase).toBe("rolled-back");
      const prefix = rollbackGenerationBuildBase(LONG) + "-rb";
      const builds = readdirSync(join(homeDir, ".lcm", "migration-rollback-generations")).filter((name) => name.startsWith(prefix));
      expect(builds.map((name) => name.slice(name.lastIndexOf("-") + 1)).sort()).toEqual(["1", "2"]);
      for (const name of builds) expect(name.length).toBeLessThanOrEqual(128);
    });
  });

  it("refuses to abandon a pending publish-rollback whose maintenance selection completed for another backend", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    let m = manifestAtVerified(store, GEN);
    m = complete(store, begin(store, m, "prepare-rollback"), "prepare-rollback", {});
    begin(store, m, "publish-rollback");
    writeAuthorityArtifact(homeDir);
    const coordinator = coordinatorFor(homeDir);
    const held = await coordinator.enterMaintenance({
      publicationId: deriveRollbackPublicationId(GEN), generationId: GEN, sourceSelectionSha256: "5".repeat(64),
      queueEvidenceSha256: "6".repeat(64), roster: ROSTER, now: new Date(capturedAt),
    });
    const prepared = await coordinator.prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: GEN, targetBackend: "postgresql", terminalEvidenceSha256: "9".repeat(64),
    });
    await coordinator.completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256, generationId: GEN, terminalEvidenceSha256: "9".repeat(64),
    });
    await expect(runRollback(RUN(homeDir), deps(homeDir)))
      .rejects.toMatchObject({ reason: "not-implemented", message: expect.stringContaining("re-selecting postgresql") });
  });

  it("refuses a prepared selection for this generation that carries other evidence than the pending effect", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    let m = manifestAtVerified(store, GEN);
    m = complete(store, begin(store, m, "prepare-rollback"), "prepare-rollback", {});
    begin(store, m, "publish-rollback");
    writeAuthorityArtifact(homeDir);
    const coordinator = coordinatorFor(homeDir);
    const held = await coordinator.enterMaintenance({
      publicationId: deriveRollbackPublicationId(GEN), generationId: GEN, sourceSelectionSha256: "5".repeat(64),
      queueEvidenceSha256: "6".repeat(64), roster: ROSTER, now: new Date(capturedAt),
    });
    await coordinator.prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: GEN, targetBackend: "sqlite", terminalEvidenceSha256: "9".repeat(64),
    });
    await expect(runRollback(RUN(homeDir), deps(homeDir)))
      .rejects.toMatchObject({ reason: "not-implemented", message: expect.stringContaining("different or ambiguous target") });
  });
});


describe("runMigrationRollback: the publication source and the coordinator's publication (plan-v3.1 A8, plan-v3.2 A16a)", () => {
  const GEN = "gen-a8";
  const destinationIdentity = fixtureDestinationIdentity("d");
  const baseline = fixtureCanonicalDelta("a8-baseline");
  const census = fixtureCensusVector("a8-census");
  const scenario = fixtureActivationScenario({ generationId: GEN, destinationIdentity, censusVector: census, canonicalDeltaBaseline: baseline });
  const RUN = (homeDir: string) => ({
    homeDir, generationId: GEN, canonicalPath: join(homeDir, "live.sqlite"),
    projectIdentity: identity, localProjectId: "local-a8",
    sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
  });
  const unchangedSession = async () => fakeSession({
    observations: [{
      destinationIdentity, postEpochDelta: baseline, postEpochCensus: census,
    }],
    source: sqliteSourceStream,
  });
  const neverOpens = async (): Promise<RollbackFencedSession> => { throw new Error("must not open a session"); };
  const depsFor = (homeDir: string, extra: Partial<RunMigrationRollbackDependencies> = {}): RunMigrationRollbackDependencies => ({
    coordinator: coordinatorFor(homeDir),
    ...authoritativeDeps(scenario),
    recordSelectionBinding: () => undefined,
    recordWitnessBinding: () => undefined,
    openFencedSession: unchangedSession,
    ...extra,
  });
  function nothingDurable(homeDir: string): void {
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    expect(readRollbackAuthorityArtifact(homeDir, GEN)).toBeNull();
    expect(new MigrationManifestStore({ homeDir }).read(GEN).phase).toBe("verified");
  }
  const sha = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
  const retainedWith = (mutate: (material: ReturnType<typeof activationPublicationMaterial>) => ReturnType<typeof activationPublicationMaterial>, journal: Record<string, unknown> = {}) => () => ({
    status: "present" as const,
    journal: { publicationId: "publication-1", sourceBackend: "sqlite", targetBackend: "postgresql", ...journal } as never,
    material: mutate(activationPublicationMaterial()),
  });

  it("persists only identities and digests of the retained publication, once, and a retry reads them back", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), GEN);
    const retained = vi.fn(() => retainedActivationPublication());
    await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
      readRetainedMaterial: retained, coordinator: (() => {
        const coordinator = coordinatorFor(homeDir);
        coordinator.prepareMaintenanceSelection = (async () => { throw new Error("simulated crash"); }) as typeof coordinator.prepareMaintenanceSelection;
        return coordinator;
      })(),
    }))).rejects.toThrow("simulated crash");
    const material = activationPublicationMaterial();
    const sourceConfig = material.source.config as Extract<typeof material.source.config, { presence: "present" }>;
    const sourceMap = material.source.projectMap as Extract<typeof material.source.projectMap, { presence: "present" }>;
    expect(readRollbackAuthorityArtifact(homeDir, GEN)).toMatchObject({
      version: 2,
      publication: {
        publicationId: "publication-1",
        sourceBackend: "sqlite",
        sourceProjectEntry: { localProjectId: FIXTURE_LOCAL_PROJECT_ID, remoteProjectId: null },
        sourceConfigSha256: sha(sourceConfig.content),
        sourceProjectMapSha256: sha(sourceMap.content),
      },
    });
    expect(retained).toHaveBeenCalledTimes(1);

    // Resume (the maintenance is held, the effect pending): the persisted copy is read back, never the retained one.
    retained.mockImplementation(() => { throw new Error("must not read the retained publication again"); });
    const outcome = await runRollback(RUN(homeDir), depsFor(homeDir, { readRetainedMaterial: retained }));
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(retained).toHaveBeenCalledTimes(1);
  });

  it("refuses before any durable change when the activation's publication is not retained", async () => {
    const absent = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir: absent }), GEN);
    await expect(runRollback(RUN(absent), depsFor(absent, {
      readRetainedMaterial: () => ({ status: "authoritatively-absent" }), openFencedSession: neverOpens,
    }))).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("retained-publication-absent") });
    nothingDurable(absent);

    const unresolvable = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir: unresolvable }), GEN);
    await expect(runRollback(RUN(unresolvable), depsFor(unresolvable, {
      readRetainedMaterial: () => ({ status: "unresolvable", reason: "the journal is unreadable" }), openFencedSession: neverOpens,
    }))).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("retained-publication-unresolvable: the journal is unreadable") });
    nothingDurable(unresolvable);
  });

  it("refuses a retained publication that is not the one the activation selection names, or does not target postgresql", async () => {
    for (const journal of [{ publicationId: "a-later-unrelated-publication" }, { targetBackend: "sqlite" }]) {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), GEN);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        readRetainedMaterial: retainedWith((material) => material, journal), openFencedSession: neverOpens,
      }))).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("retained-publication-mismatch") });
      nothingDurable(homeDir);
    }
  });

  it("refuses a retained publication whose pre-activation config or project map cannot give the covered project's entry", async () => {
    const absentFile = { presence: "absent" } as const;
    const mutations: ReadonlyArray<(material: ReturnType<typeof activationPublicationMaterial>) => ReturnType<typeof activationPublicationMaterial>> = [
      (material) => ({ ...material, source: { ...material.source, config: absentFile } }),
      (material) => ({ ...material, source: { ...material.source, projectMap: absentFile } }),
      (material) => ({ ...material, source: { ...material.source, projectMap: publicationMaterial().source.projectMap } }),
      (material) => ({ ...material, source: { ...material.source, projectMap: publicationMaterial().source.config } }),
      (material) => ({
        ...material,
        source: { ...material.source, projectMap: { ...(material.source.projectMap as object), content: Buffer.from("{}") } as never },
      }),
    ];
    for (const mutate of mutations) {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), GEN);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        readRetainedMaterial: retainedWith(mutate), openFencedSession: neverOpens,
      }))).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("retained-publication-source-unusable") });
      nothingDurable(homeDir);
    }
  });

  it("refuses to continue under a version-1 rollback authority artifact, and never rewrites it", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), GEN);
    writeRollbackAuthorityArtifact(homeDir, {
      version: 1, generationId: GEN, operabilityFactState: "authoritatively-absent", operabilityFactValueSha256: null,
      epochId: scenario.epoch.epochId, attemptId: scenario.attempt.attemptId,
    } as never);
    const before = readFileSync(join(homeDir, ".lcm", "migration-rollback-authority", deriveRollbackAuthorityArtifactId(GEN) + ".json"), "utf8");
    await expect(runRollback(RUN(homeDir), depsFor(homeDir, { openFencedSession: neverOpens })))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("version 1") });
    expect(readFileSync(join(homeDir, ".lcm", "migration-rollback-authority", deriveRollbackAuthorityArtifactId(GEN) + ".json"), "utf8")).toBe(before);
  });

  it("refuses a composed publication that does not restore the pre-activation backend and the covered project's entry", async () => {
    const rollbackMaterial = rollbackPublicationMaterial();
    const variants: ReadonlyArray<(composed: ReturnType<typeof composeRollbackPublication>) => unknown> = [
      (composed) => ({ ...composed, sourceBackend: "sqlite" }),
      (composed) => ({ ...composed, targetBackend: "postgresql" }),
      (composed) => ({ ...composed, projects: [{ ...composed.projects[0]!, evidenceSha256: "0".repeat(64) }] }),
      (composed) => ({ ...composed, material: activationPublicationMaterial() }),
      (composed) => ({ ...composed, material: { ...rollbackMaterial, target: { ...rollbackMaterial.target, projectMap: { presence: "absent" } } } }),
      (composed) => ({
        ...composed,
        material: { ...rollbackMaterial, target: { ...rollbackMaterial.target, projectMap: publicationMaterial().target.projectMap } },
      }),
    ];
    for (const variant of variants) {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), GEN);
      await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
        composePublication: ((input: Parameters<typeof composeRollbackPublication>[0]) => variant(composeRollbackPublication(input))) as never,
      }))).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("does not restore the pre-activation backend") });
      // The selection completed and the effect is pending, but nothing was published.
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-completed");
    }
  });

  it("refuses a coordinator publication that did not complete as composed, and one that was aborted", async () => {
    // Each field of the sealed journal is corrupted alone: every one must refuse by itself.
    const corruptions: ReadonlyArray<(journal: any) => unknown> = [
      (journal) => ({ ...journal, publicationId: "another-publication" }),
      (journal) => ({ ...journal, sourceBackend: "sqlite" }),
      (journal) => ({ ...journal, phase: "prepared" }),
      (journal) => ({ ...journal, targetBackend: "postgresql" }),
      (journal) => ({ ...journal, projects: [] }),
      (journal) => ({ ...journal, projects: [{ ...journal.projects[0], localProjectId: "another-local-project" }] }),
      (journal) => ({ ...journal, projects: [{ ...journal.projects[0], remoteProjectId: "another-remote-project" }] }),
      (journal) => ({ ...journal, projects: [{ ...journal.projects[0], evidenceSha256: "0".repeat(64) }] }),
      (journal) => ({ ...journal, recoveryReference: null }),
    ];
    for (const corrupt of corruptions) {
      const home = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir: home }), GEN);
      const coordinator = coordinatorFor(home);
      const realResume = coordinator.resume.bind(coordinator);
      coordinator.resume = (async (...args: Parameters<typeof realResume>) => corrupt(await realResume(...args))) as typeof coordinator.resume;
      await expect(runRollback(RUN(home), depsFor(home, { coordinator })))
        .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("did not complete as composed") });
    }

    const abortedHome = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir: abortedHome }), GEN);
    const preparing = coordinatorFor(abortedHome);
    const realPrepare = preparing.prepare.bind(preparing);
    preparing.prepare = (async (...args: Parameters<typeof realPrepare>) => {
      const journal = await realPrepare(...args);
      return { ...journal, phase: "aborted" };
    }) as typeof preparing.prepare;
    await expect(runRollback(RUN(abortedHome), depsFor(abortedHome, { coordinator: preparing })))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("was aborted") });
  });

  it("refuses when the session's terminal evidence is not the witness minted from the same records", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), GEN);
    await expect(runRollback(RUN(homeDir), depsFor(homeDir, {
      openFencedSession: async () => {
        const session = await unchangedSession();
        session.computeRollbackTerminalEvidenceSha256 = () => "e".repeat(64);
        return session;
      },
    }))).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("not the rollback witness") });
  });
});


describe("readOwnPublicationSourceFromMaterial: the rollback's sealed pre-publication source", () => {
  const ID = deriveRollbackPublicationId("gen-own-source");
  const projects = [{ localProjectId: FIXTURE_LOCAL_PROJECT_ID, remoteProjectId: FIXTURE_REMOTE_PROJECT_ID, evidenceSha256: "d".repeat(64) }];
  const coordinatorOver = (homeDir: string, material = rollbackPublicationMaterial()) =>
    new BackendPublicationCoordinator({ homeDir, driver: workingPublicationDriver(material) });
  const prepared = async (homeDir: string, publicationId: string, material = rollbackPublicationMaterial()) => {
    const coordinator = coordinatorOver(homeDir, material);
    await coordinator.prepare({ publicationId, sourceBackend: "postgresql", targetBackend: "sqlite", material, projects });
    return coordinator;
  };
  beforeEach(() => {
    vi.stubEnv("LCM_POSTGRES_URL", "postgresql://user:secret@example/db");
    const caFile = join(tempHome(), "ca.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\n", { mode: 0o600 });
    vi.stubEnv("LCM_POSTGRES_CA_FILE", caFile);
    vi.stubEnv("LCM_POSTGRES_MIGRATION_ROLE", "lcm_owner");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("is null when the slot holds no publication journal", () => {
    expect(readOwnPublicationSourceFromMaterial(tempHome(), ID, FIXTURE_LOCAL_PROJECT_ID)).toBeNull();
  });

  it("reads the sealed source configuration and project map of its own in-flight publication", async () => {
    const homeDir = tempHome();
    await prepared(homeDir, ID);
    // The live files could say anything now; only the sealed material is read.
    const source = readOwnPublicationSourceFromMaterial(homeDir, ID, FIXTURE_LOCAL_PROJECT_ID)!;
    expect(source.storage).toMatchObject({ backend: "postgresql", postgresql: { url: "postgresql://user:secret@example/db", caFile: expect.stringContaining("ca.pem") } });
    expect(source.projectMap[FIXTURE_LOCAL_PROJECT_ID]).toMatchObject({ remoteProjectId: FIXTURE_REMOTE_PROJECT_ID });
  });

  it("is null for another publication's journal", async () => {
    const homeDir = tempHome();
    await prepared(homeDir, ID);
    expect(readOwnPublicationSourceFromMaterial(homeDir, deriveRollbackPublicationId("another-generation"), FIXTURE_LOCAL_PROJECT_ID)).toBeNull();
  });

  it("reads the live files once its own publication was aborted, only as the journal witnessed them (#1555)", async () => {
    const homeDir = tempHome();
    const material = rollbackPublicationMaterial();
    for (const [name, file] of [["config.json", material.source.config], ["map.json", material.source.projectMap]] as const) {
      if (file.presence === "present") writeFileSync(join(homeDir, ".lcm", name), file.content, { mode: 0o600 });
    }
    const coordinator = await prepared(homeDir, ID);
    await coordinator.recoverPending({ disposition: "abort" });
    expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "aborted", recoveryReference: expect.anything() });
    expect(readOwnPublicationSourceFromMaterial(homeDir, ID, FIXTURE_LOCAL_PROJECT_ID)!.projectMap[FIXTURE_LOCAL_PROJECT_ID])
      .toMatchObject({ remoteProjectId: FIXTURE_REMOTE_PROJECT_ID });
    // Another covered project is not this rollback's composition: no source of its own.
    expect(readOwnPublicationSourceFromMaterial(homeDir, ID, "d".repeat(64))).toBeNull();

    writeFileSync(join(homeDir, ".lcm", "map.json"), "{}", { mode: 0o600 });
    expect(() => readOwnPublicationSourceFromMaterial(homeDir, ID, FIXTURE_LOCAL_PROJECT_ID))
      .toThrow(expect.objectContaining({ reason: "unexpected-state", message: expect.stringContaining("live project map is not the one") }));
  });

  it("refuses a sealed publication whose source project map was absent", async () => {
    const homeDir = tempHome();
    const material = rollbackPublicationMaterial();
    await prepared(homeDir, ID, { ...material, source: { ...material.source, projectMap: { presence: "absent" } } });
    expect(() => readOwnPublicationSourceFromMaterial(homeDir, ID, FIXTURE_LOCAL_PROJECT_ID))
      .toThrow(expect.objectContaining({ reason: "unexpected-state", message: expect.stringContaining("sealed no source file") }));
  });
});
