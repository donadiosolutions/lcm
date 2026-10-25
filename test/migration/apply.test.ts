import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  performMigrationApplyThroughCapture,
  maintenanceOnlyDriver,
  MIGRATION_DRIVER_NOT_INVOKED_MESSAGE,
  type MigrationApplyIdentityResolver,
  type MigrationApplyIdentityStep,
} from "../../src/migration/apply.js";
import { resolveMigrationExpectedIdentity } from "../../src/migration/cli-preflight.js";
import { resolveMigrationApplyCandidate } from "../../src/migration/candidate.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import {
  captureAuthenticatedSqliteMigrationSource,
  prepareSqliteMigrationEnrollment,
  authenticateSqliteMigrationSource,
  type SqliteMigrationEnrollmentInput,
} from "../../src/migration/maintenance.js";
import { classifySqliteSnapshotArtifact } from "../../src/migration/sqlite-snapshot.js";
import { computeMigrationGenerationBase, MigrationIdentityError } from "../../src/migration/generation-identity.js";
import { migrationEntryRoster, migrationQueueEvidenceSentinel } from "../../src/migration/hold-entry.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { createMigrationManifest } from "../../src/migration/protocol.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import * as identityApi from "../../src/machine-identity.js";
import { readFileSync, writeFileSync as writeFileSyncFs } from "node:fs";
import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  backendPublicationCanonicalSha256,
  backendPublicationJournalPath,
  backendPublicationMaterialWitness,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  type BackendPublicationDriver,
  type BackendMaintenanceJournal,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
} from "../../src/storage/backend-publication.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { clearProjectMapCache, projectMapPath, readProjectMapIdentity } from "../../src/project-map.js";
import type { IdentityRepository } from "../../src/identity-service.js";

/**
 * Calls the real entry point with the confirmed generation id defaulting to
 * the first candidate ordinal, the id a fresh project's `plan` would print.
 * Tests that act on a later generation pass their own.
 */
function capture(
  input: Omit<Parameters<typeof performMigrationApplyThroughCapture>[0], "confirmGenerationId"> & { confirmGenerationId?: string },
): ReturnType<typeof performMigrationApplyThroughCapture> {
  return performMigrationApplyThroughCapture({ confirmGenerationId: `${input.base}-0`, ...input });
}

const roots: string[] = [];
const REGISTERED_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
  clearProjectMapCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-apply-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

/**
 * Replicates test/migration/maintenance.test.ts's enrollmentFixture: a real
 * project directory, a real (mocked-remote-only) machine enrollment, and a
 * real base identity computed the way apply's own caller would compute it.
 * The remote identity session is the only mocked boundary; everything local
 * (project map, machine identity file, config resolution, maintenance
 * journal, snapshot capture) is the real production code path.
 */
function enrollmentFixture() {
  const homeDir = home();
  const cwd = join(homeDir, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const local = localProjectIdentity(cwd, homeDir);
  const projectDir = join(homeDir, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(homeDir, ".lcm", "events"), { mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
  const request: SqliteMigrationEnrollmentInput = {
    cwd,
    homeDir,
    targetConfig: {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://unused.invalid/lcm",
        caFile: "/unused",
        migrationRole: "unused",
        poolMax: 1,
        connectionTimeoutMs: 100,
        idleTimeoutMs: 100,
        statementTimeoutMs: 100,
      },
    },
  };
  const registered = () => {
    const pending = identityApi.readMachineIdentity(homeDir)!;
    return { machineId: REGISTERED_MACHINE, identityKey: pending.identityKey, displayName: pending.displayName };
  };
  const repository = {
    registerMachine: vi.fn(async () => registered()),
    recoverMachine: vi.fn(async () => registered()),
  };
  const close = vi.fn(async () => undefined);
  const openIdentitySession = vi.fn(async () => ({ repository: repository as unknown as IdentityRepository, close }));
  return { homeDir, cwd, local, projectDir, request, openIdentitySession };
}

function coordinatorFor(homeDir: string): BackendPublicationCoordinator {
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
  return new BackendPublicationCoordinator({ homeDir, driver });
}

function recoveryFile(content: string): BackendPublicationRecoveryFile {
  return {
    presence: "present",
    content: Buffer.from(content),
    mode: 0o600,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    nlink: "1",
    dev: "1",
    ino: "2",
    parentDev: "3",
    parentIno: "4",
  };
}

/**
 * Writes a durable v2 publication journal and stops there, reusing the
 * technique from journal-observation.test.ts: prepare() writes the journal
 * via the driver's observeLocalState alone, before it authenticates
 * material, so a driver that only implements observeLocalState is enough
 * for a real on-disk v2 journal; the deliberately inconsistent material
 * makes prepare() throw right after, which this fixture expects and
 * swallows because only the durable journal write matters here.
 */
async function writeV2PublicationFixture(home: string): Promise<void> {
  const materialInput: BackendPublicationRecoveryMaterial = {
    source: { config: recoveryFile('{"backend":"sqlite"}'), projectMap: recoveryFile('{"projects":[]}') },
    target: { config: recoveryFile('{"backend":"postgresql"}'), projectMap: recoveryFile('{"projects":["remote"]}') },
  };
  const targetWitness = backendPublicationMaterialWitness({ source: materialInput.target, target: materialInput.target });
  const driver: BackendPublicationDriver = {
    observeLocalState: async () => targetWitness,
    publishProjectMap: async () => { throw new Error("must not run in this fixture"); },
    acquireRemoteGuard: async () => { throw new Error("must not run in this fixture"); },
    readRemoteGuard: async () => { throw new Error("must not run in this fixture"); },
    releaseRemoteGuard: async () => { throw new Error("must not run in this fixture"); },
    publishConfig: async () => { throw new Error("must not run in this fixture"); },
    restoreConfig: async () => { throw new Error("must not run in this fixture"); },
    restoreProjectMap: async () => { throw new Error("must not run in this fixture"); },
  };
  const coordinator = new BackendPublicationCoordinator({ homeDir: home, driver });
  try {
    await coordinator.prepare({
      publicationId: "publication-1",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: materialInput,
      projects: [{ localProjectId: "local-project", remoteProjectId: "remote-project", evidenceSha256: "a".repeat(64) }],
      now: new Date("2026-08-06T12:00:00.000Z"),
    });
    throw new Error("fixture expected prepare() to fail after the journal write");
  } catch (error) {
    if (error instanceof Error && error.message === "fixture expected prepare() to fail after the journal write") throw error;
  }
}

function manifestWitness(sha: string, backend: "sqlite" | "postgresql" = "sqlite") {
  return {
    version: 1 as const, backend, identitySha256: sha, schemaSha256: sha,
    contentSha256: sha, capturedAt: "2026-08-12T12:00:00.000Z",
  };
}

/** Refuses enterMaintenance outright, for a fresh (no-existing-journal) call. */
class RefusingEnterMaintenanceCoordinator extends BackendPublicationCoordinator {
  override async enterMaintenance(): Promise<BackendMaintenanceJournal> {
    throw new BackendPublicationJournalError("unresolved-publication", "injected: enterMaintenance refused");
  }
}

/** Real enterMaintenance, but the readback this test observes is corrupted to a non-held phase. */
class MismatchedReadbackCoordinator extends BackendPublicationCoordinator {
  override async enterMaintenance(
    input: Parameters<BackendPublicationCoordinator["enterMaintenance"]>[0],
    lockToken?: Parameters<BackendPublicationCoordinator["enterMaintenance"]>[1],
  ): Promise<BackendMaintenanceJournal> {
    const real = await super.enterMaintenance(input, lockToken);
    return { ...real, phase: "selection-prepared" };
  }
}

async function enrolled() {
  const fixture = enrollmentFixture();
  await prepareSqliteMigrationEnrollment(fixture.request, { openIdentitySession: fixture.openIdentitySession });
  const base = computeMigrationGenerationBase({
    physicalProjectId: fixture.local.id,
    canonicalPath: fixture.local.canonical,
    target: { host: "db.example", port: 5432, database: "appdb" },
  });
  return { ...fixture, base };
}

describe("performMigrationApplyThroughCapture, real pipeline (checkpoint: capture reachable end to end)", () => {
  it("captures a fresh generation for real: real project, real machine enrollment, real hold, real snapshot capture", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(result.status).toBe("captured");
    if (result.status !== "captured") throw new Error("unreachable");
    expect(result.generationId).toBe(`${fixture.base}-0`);

    // Positive control: the snapshot really is complete on disk, not just a
    // claim in the returned object.
    const classification = await classifySqliteSnapshotArtifact(result.generationId, { homeDir: fixture.homeDir });
    expect(classification.state).toBe("complete");

    const journal = readBackendMaintenanceJournal(fixture.homeDir)!;
    expect(journal.phase).toBe("maintenance-held");
    expect(journal.generationId).toBe(result.generationId);
  });

  it("the cutover-collision regression (section 11 test 5), against the real capture pipeline as required: completing generation 0 and aborting it, then applying again, mints a distinct generation and a real second capture succeeds (red: a resolver that never advances, or a resolver tested only against a hand-built fixture, cannot prove this)", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);

    const first = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(first.status).toBe("captured");
    if (first.status !== "captured") throw new Error("unreachable");
    expect(first.generationId).toBe(`${fixture.base}-0`);

    const heldAfterFirst = readBackendMaintenanceJournal(fixture.homeDir)!;
    await coordinator.abortMaintenance({
      expectedChecksumSha256: heldAfterFirst.checksumSha256,
      sourceSelectionSha256: heldAfterFirst.sourceSelectionSha256,
      abortEvidenceSha256: "c".repeat(64),
    });
    const abortedJournal = readBackendMaintenanceJournal(fixture.homeDir)!;
    expect(abortedJournal.phase).toBe("maintenance-aborted");

    const second = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      confirmGenerationId: `${fixture.base}-1`,
    });
    expect(second.status).toBe("captured");
    if (second.status !== "captured") throw new Error("unreachable");
    expect(second.generationId).toBe(`${fixture.base}-1`);
    expect(second.generationId).not.toBe(first.generationId);

    // Positive control: the first generation's real, complete snapshot is
    // still there, untouched — nothing was deleted or reused.
    const firstClassification = await classifySqliteSnapshotArtifact(first.generationId, { homeDir: fixture.homeDir });
    expect(firstClassification.state).toBe("complete");
    const secondClassification = await classifySqliteSnapshotArtifact(second.generationId, { homeDir: fixture.homeDir });
    expect(secondClassification.state).toBe("complete");
  });

  it("re-applying against an already-held, already-captured journal is idempotent: continue-held, no new generation, the same real capture result", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const first = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(first.status).toBe("captured");
    const second = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(second.status).toBe("captured");
    if (first.status !== "captured" || second.status !== "captured") throw new Error("unreachable");
    // The whole result is deliberately not compared with toEqual: capture's
    // own revalidate() rebinds queueEvidenceSha256 and roster[0].queueCutoff
    // on the journal it just wrote to (section 4.4/section 9's sentinel to
    // real-evidence transition), which changes the journal's checksum
    // between the first apply and the second observation of it. That
    // checksum movement is the rebind working as designed, not drift in
    // capture's own idempotent output, so generationId and the snapshot
    // witness are compared directly instead.
    expect(second.generationId).toBe(first.generationId);
    expect(second.snapshot).toEqual(first.snapshot);
  });

  it("continues a real held journal recovered from maintenance-entering rather than refusing unresolved-publication (the A-1 regression, against the real pipeline)", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);

    // Simulate a crash between the entering and held durable writes for the
    // *first* generation this project ever cutovers to — the only crash
    // window enterMaintenance's own recovery comparison exists for. This is
    // deliberately built without ever calling apply() first: a real
    // maintenance-entering journal can only be observed before any capture
    // has succeeded, because capture itself requires the "maintenance-held"
    // phase as a precondition, so a genuinely held-then-entering journal (as
    // if a completed capture's binding were rewound) cannot occur in
    // production and would not be evidence of anything this item needs to
    // prove.
    const generationId = `${fixture.base}-0`;
    const authority = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir);
    const sentinel = migrationQueueEvidenceSentinel({ generationId, sourceSelectionSha256: authority.sourceSelectionSha256 });
    const roster = migrationEntryRoster({ machineId: authority.machineIdentity.machineId, sentinelEvidenceSha256: sentinel });
    const held = await coordinator.enterMaintenance({
      publicationId: generationId,
      generationId,
      sourceSelectionSha256: authority.sourceSelectionSha256,
      queueEvidenceSha256: sentinel,
      roster,
    });
    expect(held.phase).toBe("maintenance-held");

    const path = backendPublicationJournalPath(fixture.homeDir);
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { checksumSha256: _checksum, ...payload } = current;
    writeFileSyncFs(path, `${JSON.stringify({ ...payload, phase: "maintenance-entering", checksumSha256: backendPublicationCanonicalSha256({ ...payload, phase: "maintenance-entering" }) })}\n`, { mode: 0o600 });
    expect(readBackendMaintenanceJournal(fixture.homeDir)!.phase).toBe("maintenance-entering");

    // This test could not have gone red against plan-v1's design, which
    // refused unresolved-publication on exactly this state.
    const second = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(second.status).toBe("captured");
    if (second.status !== "captured") throw new Error("unreachable");
    expect(second.generationId).toBe(generationId);
    const recovered = readBackendMaintenanceJournal(fixture.homeDir)!;
    expect(recovered.phase).toBe("maintenance-held");

    // Positive control: the real capture actually ran and produced a
    // complete snapshot, not just a claim in the returned object.
    const classification = await classifySqliteSnapshotArtifact(generationId, { homeDir: fixture.homeDir });
    expect(classification.state).toBe("complete");
  });
});

describe("performMigrationApplyThroughCapture, refusal paths and their red-first proofs", () => {
  async function capturedFixture() {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const first = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    if (first.status !== "captured") throw new Error("fixture setup expected a successful first capture");
    return { fixture, coordinator, first };
  }

  it("refuses publication-occupies-slot when a real v2 publication journal occupies the slot, never treating it as absent", async () => {
    const fixture = await enrolled();
    await writeV2PublicationFixture(fixture.homeDir);
    expect(readBackendPublicationJournal(fixture.homeDir)).toMatchObject({ phase: "preparing" });
    expect(readBackendMaintenanceJournal(fixture.homeDir)).toBeNull();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
    });
    expect(result).toEqual({ status: "refuse", reason: "publication-occupies-slot" });
  });

  it("refuses journal-unresolvable when the maintenance journal itself cannot be read (a corrupted v3 journal), never treating it as absent", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    await coordinator.enterMaintenance({
      publicationId: `${fixture.base}-0`, generationId: `${fixture.base}-0`,
      sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: "018f0b5d-1234-4abc-8def-1234567890ab", queueCutoff: null, evidenceSha256: "a".repeat(64) }],
    });
    const path = backendPublicationJournalPath(fixture.homeDir);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.checksumSha256 = "f".repeat(64);
    writeFileSyncFs(path, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
    });
    expect(result).toEqual({ status: "refuse", reason: "journal-unresolvable", evidence: "journal-checksum-mismatch" });
  });

  it("refuses generation-occupied-since-probe when the injected resolver reports the layer-2 re-check found the candidate occupied (proves apply propagates the resolver's own refusal rather than swallowing it)", async () => {
    const fixture = await enrolled();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      _operationsForTesting: { resolveGenerationId: async () => ({ status: "refuse", reason: "occupied-since-probe" }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-occupied-since-probe", evidence: undefined });
  });

  it("refuses generation-unresolvable-since-probe when the injected resolver reports the layer-2 re-check itself could not be established, carrying the resolver's evidence", async () => {
    const fixture = await enrolled();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      _operationsForTesting: { resolveGenerationId: async () => ({ status: "refuse", reason: "unresolvable-since-probe", evidence: "manifest-internal-error" }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-unresolvable-since-probe", evidence: "manifest-internal-error" });
  });

  it("catches a thrown MigrationIdentityError('probe-bound-exceeded') from resolveGenerationId and converts it into generation-probe-bound-exceeded, never letting it escape as an uncaught exception (red-first: before the catch was added, this exact scenario rejected with the raw MigrationIdentityError instead of resolving to a refuse result)", async () => {
    const fixture = await enrolled();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      _operationsForTesting: {
        resolveGenerationId: async () => {
          throw new MigrationIdentityError("probe-bound-exceeded", "test probe bound exceeded", "max-9999");
        },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-probe-bound-exceeded", evidence: "max-9999" });
  });

  it("catches a thrown MigrationIdentityError('identifier-bound-exceeded') and converts it into generation-identifier-bound-exceeded", async () => {
    const fixture = await enrolled();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      _operationsForTesting: {
        resolveGenerationId: async () => {
          throw new MigrationIdentityError("identifier-bound-exceeded", "test identifier bound exceeded", "ordinal-3");
        },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-identifier-bound-exceeded", evidence: "ordinal-3" });
  });

  it("catches a thrown MigrationIdentityError('occupancy-refused') and converts it into generation-occupancy-refused, carrying the underlying evidence", async () => {
    const fixture = await enrolled();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      _operationsForTesting: {
        resolveGenerationId: async () => {
          throw new MigrationIdentityError("occupancy-refused", "test occupancy refused", "snapshot-snapshot-io");
        },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-occupancy-refused", evidence: "snapshot-snapshot-io" });
  });

  it("catches a thrown MigrationIdentityError('invalid-input') with a null evidence and converts the null to undefined, matching the envelope's optional-evidence shape", async () => {
    const fixture = await enrolled();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      _operationsForTesting: {
        resolveGenerationId: async () => {
          throw new MigrationIdentityError("invalid-input", "test invalid input", null);
        },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-invalid-input", evidence: undefined });
  });

  it("re-throws a thrown error that is not a MigrationIdentityError, never misclassifying an unrecognised failure as a generation refusal (red: broadening the instanceof check to Error would swallow this and wrongly report a generation refusal)", async () => {
    const fixture = await enrolled();
    const outcome = capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      _operationsForTesting: {
        resolveGenerationId: async () => {
          throw new Error("an unrelated, unrecognised failure");
        },
      },
    });
    await expect(outcome).rejects.toThrow("an unrelated, unrecognised failure");
  });

  it("refuses multi-machine-installation for a shared (remote-mapped) project identity, never silently fencing it (#625's D-625-4)", async () => {
    const fixture = await enrolled();
    closeLcmConnection();
    writeFileSync(projectMapPath(fixture.homeDir), JSON.stringify({
      [fixture.local.id]: { canonical: fixture.cwd, aliases: [], remoteProjectId: REGISTERED_MACHINE },
    }), { mode: 0o600 });
    clearProjectMapCache();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
    });
    expect(result).toEqual({ status: "refuse", reason: "multi-machine-installation" });
  });

  it("refuses hold-entry-slot-occupied (exit 4, no abort remedy) when a fresh enterMaintenance call throws unresolved-publication, carrying the journal failure's own reason as evidence", async () => {
    const fixture = await enrolled();
    const driver: BackendPublicationDriver = {
      observeLocalState: async () => { throw new Error("v2 driver must not run for maintenance"); },
      publishProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
      publishConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
      restoreConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
      restoreProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
    };
    const coordinator = new RefusingEnterMaintenanceCoordinator({ homeDir: fixture.homeDir, driver });
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(result).toEqual({ status: "refuse", reason: "hold-entry-slot-occupied", evidence: "journal-unresolved-publication" });
  });

  it("refuses hold-entry-readback-mismatch on a fresh hold when the write's own readback does not show maintenance-held (a write is not evidence of its own effect)", async () => {
    const fixture = await enrolled();
    const driver: BackendPublicationDriver = {
      observeLocalState: async () => { throw new Error("v2 driver must not run for maintenance"); },
      publishProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
      publishConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
      restoreConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
      restoreProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
    };
    const coordinator = new MismatchedReadbackCoordinator({ homeDir: fixture.homeDir, driver });
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(result).toEqual({ status: "refuse", reason: "hold-entry-readback-mismatch" });
  });

  it("refuses hold-entry-readback-mismatch on entering recovery when the write's own readback does not show maintenance-held", async () => {
    const fixture = await enrolled();
    const driver: BackendPublicationDriver = {
      observeLocalState: async () => { throw new Error("v2 driver must not run for maintenance"); },
      publishProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
      publishConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
      restoreConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
      restoreProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
    };
    const realCoordinator = new BackendPublicationCoordinator({ homeDir: fixture.homeDir, driver });
    const generationId = `${fixture.base}-0`;
    const authority = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir);
    const sentinel = migrationQueueEvidenceSentinel({ generationId, sourceSelectionSha256: authority.sourceSelectionSha256 });
    const roster = migrationEntryRoster({ machineId: authority.machineIdentity.machineId, sentinelEvidenceSha256: sentinel });
    await realCoordinator.enterMaintenance({
      publicationId: generationId, generationId, sourceSelectionSha256: authority.sourceSelectionSha256,
      queueEvidenceSha256: sentinel, roster,
    });
    const path = backendPublicationJournalPath(fixture.homeDir);
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { checksumSha256: _checksum, ...payload } = current;
    writeFileSyncFs(path, `${JSON.stringify({ ...payload, phase: "maintenance-entering", checksumSha256: backendPublicationCanonicalSha256({ ...payload, phase: "maintenance-entering" }) })}\n`, { mode: 0o600 });

    const mismatchedCoordinator = new MismatchedReadbackCoordinator({ homeDir: fixture.homeDir, driver });
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: mismatchedCoordinator,
    });
    expect(result).toEqual({ status: "refuse", reason: "hold-entry-readback-mismatch" });
  });

  it("refuses capture-failed when the source database is missing at capture time, carrying the real error's name as evidence", async () => {
    const fixture = await enrolled();
    closeLcmConnection();
    const dbPath = join(fixture.homeDir, ".lcm", "projects", fixture.local.id, "db.sqlite");
    rmSync(dbPath, { force: true });
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
    });
    expect(result.status).toBe("refuse");
    if (result.status !== "refuse") throw new Error("unreachable");
    expect(result.reason).toBe("capture-failed");
    expect(result.evidence).toBeTruthy();
  });

  it("refuses continuation-resume-required when the live journal is selection-prepared, never probing past it (resume owns that state)", async () => {
    const { fixture, coordinator, first } = await capturedFixture();
    const heldJournal = readBackendMaintenanceJournal(fixture.homeDir)!;
    await coordinator.prepareMaintenanceSelection({
      expectedChecksumSha256: heldJournal.checksumSha256,
      terminalEvidenceSha256: "e".repeat(64),
      generationId: first.generationId,
      targetBackend: "postgresql",
    });
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(result).toEqual({ status: "refuse", reason: "continuation-resume-required" });
  });

  it("refuses continuation-mismatched-hold when the held journal's sourceSelectionSha256 no longer matches the live local authority (red: corrupting only this field, nothing else, is what this comparison exists to catch)", async () => {
    const { fixture, coordinator } = await capturedFixture();
    const path = backendPublicationJournalPath(fixture.homeDir);
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { checksumSha256: _checksum, ...payload } = current;
    const corrupted = { ...payload, sourceSelectionSha256: "9".repeat(64) };
    writeFileSyncFs(path, `${JSON.stringify({ ...corrupted, checksumSha256: backendPublicationCanonicalSha256(corrupted) })}\n`, { mode: 0o600 });
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(result).toEqual({ status: "refuse", reason: "continuation-mismatched-hold" });
  });

  it("refuses abort-or-resume-required when a terminal journal's generation has a present but unsettled manifest (section 4.6's abort gate, red: this is the exact disagreement it exists to catch)", async () => {
    const { fixture, coordinator, first } = await capturedFixture();
    const manifestStore = new MigrationManifestStore({ homeDir: fixture.homeDir });
    manifestStore.create(createMigrationManifest({
      generationId: first.generationId,
      source: manifestWitness("1".repeat(64)),
      destination: manifestWitness("2".repeat(64), "postgresql"),
      parentGenerationId: null,
      preservedSourceGenerationId: first.generationId,
      createdAt: "2026-08-12T12:00:00.000Z",
    }));
    const heldJournal = readBackendMaintenanceJournal(fixture.homeDir)!;
    await coordinator.abortMaintenance({
      expectedChecksumSha256: heldJournal.checksumSha256,
      sourceSelectionSha256: heldJournal.sourceSelectionSha256,
      abortEvidenceSha256: "c".repeat(64),
    });
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator, manifestStore,
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-or-resume-required", evidence: "manifest-ready" });
  });

  it("refuses abort-gate-unresolvable when the manifest presence probe itself cannot be established for a terminal journal", async () => {
    const { fixture, coordinator } = await capturedFixture();
    const heldJournal = readBackendMaintenanceJournal(fixture.homeDir)!;
    await coordinator.abortMaintenance({
      expectedChecksumSha256: heldJournal.checksumSha256,
      sourceSelectionSha256: heldJournal.sourceSelectionSha256,
      abortEvidenceSha256: "c".repeat(64),
    });
    const migrations = join(fixture.homeDir, ".lcm", "migrations");
    mkdirSync(migrations, { recursive: true, mode: 0o700 });
    chmodSync(migrations, 0o755);
    let result;
    try {
      result = await capture({
        cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      });
    } finally {
      chmodSync(migrations, 0o700);
    }
    expect(result).toEqual({ status: "refuse", reason: "abort-gate-unresolvable", evidence: "manifest-internal-error" });
  });

  it("refuses entering-recovery-precondition when the carried checksum no longer matches the live entering journal (section 4.9 exposure 2, red: proves the CAS input is actually compared, not re-read)", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const generationId = `${fixture.base}-0`;
    const authority = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir);
    const sentinel = migrationQueueEvidenceSentinel({ generationId, sourceSelectionSha256: authority.sourceSelectionSha256 });
    const roster = migrationEntryRoster({ machineId: authority.machineIdentity.machineId, sentinelEvidenceSha256: sentinel });
    await coordinator.enterMaintenance({
      publicationId: generationId, generationId, sourceSelectionSha256: authority.sourceSelectionSha256,
      queueEvidenceSha256: sentinel, roster,
    });
    const path = backendPublicationJournalPath(fixture.homeDir);
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { checksumSha256: _checksum, ...payload } = current;
    writeFileSyncFs(path, `${JSON.stringify({ ...payload, phase: "maintenance-entering", checksumSha256: backendPublicationCanonicalSha256({ ...payload, phase: "maintenance-entering" }) })}\n`, { mode: 0o600 });

    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      _operationsForTesting: {
        resolveHoldContinuation: (resolveInput) => resolveInput.journal.phase === "maintenance-entering"
          ? { action: "recover-entering", observedChecksumSha256: "0".repeat(64) }
          : { action: "refuse", reason: "mismatched-hold" },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "entering-recovery-precondition", evidence: "journal-unexpected-state" });
  });

  it("refuses entering-recovery-unclassified when the injected classifier reports a status this function does not recognise (type-level guard, proven by the seam rather than a real journal that cannot exist)", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const generationId = `${fixture.base}-0`;
    const authority = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir);
    const sentinel = migrationQueueEvidenceSentinel({ generationId, sourceSelectionSha256: authority.sourceSelectionSha256 });
    const roster = migrationEntryRoster({ machineId: authority.machineIdentity.machineId, sentinelEvidenceSha256: sentinel });
    const held = await coordinator.enterMaintenance({
      publicationId: generationId, generationId, sourceSelectionSha256: authority.sourceSelectionSha256,
      queueEvidenceSha256: sentinel, roster,
    });
    const path = backendPublicationJournalPath(fixture.homeDir);
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { checksumSha256: _checksum, ...payload } = current;
    writeFileSyncFs(path, `${JSON.stringify({ ...payload, phase: "maintenance-entering", checksumSha256: backendPublicationCanonicalSha256({ ...payload, phase: "maintenance-entering" }) })}\n`, { mode: 0o600 });

    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      _operationsForTesting: {
        // Force enterMaintenance's recovery comparison to throw (a wrong
        // carried checksum), so the catch block actually runs and the
        // injected classifier's unrecognised status is what this test
        // exercises — without a throw, the recovery would simply succeed
        // and the classifier would never be consulted at all.
        resolveHoldContinuation: () => ({ action: "recover-entering", observedChecksumSha256: "0".repeat(64) }),
        classifyEnteringFailure: () => ({ status: "recovered", journal: held }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "entering-recovery-unclassified" });
  });

  it("refuses continuation-unclassified from the maintenance-entering dispatch when the injected resolver reports a disposition other than recover-entering for that phase (type-level guard)", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    await coordinator.enterMaintenance({
      publicationId: `${fixture.base}-0`, generationId: `${fixture.base}-0`,
      sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: "018f0b5d-1234-4abc-8def-1234567890ab", queueCutoff: null, evidenceSha256: "a".repeat(64) }],
    });
    const path = backendPublicationJournalPath(fixture.homeDir);
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { checksumSha256: _checksum, ...payload } = current;
    writeFileSyncFs(path, `${JSON.stringify({ ...payload, phase: "maintenance-entering", checksumSha256: backendPublicationCanonicalSha256({ ...payload, phase: "maintenance-entering" }) })}\n`, { mode: 0o600 });

    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      _operationsForTesting: {
        resolveHoldContinuation: () => ({ action: "continue-held", observedChecksumSha256: "a".repeat(64) }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "continuation-unclassified" });
  });

  it("refuses continuation-unclassified from inside the barrier when the injected resolver reports recover-entering for a non-entering phase (type-level guard)", async () => {
    const { fixture, coordinator } = await capturedFixture();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      _operationsForTesting: {
        resolveHoldContinuation: () => ({ action: "recover-entering", observedChecksumSha256: "a".repeat(64) }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "continuation-unclassified" });
  });

  it("constructs its own maintenance-only coordinator and manifest store when neither is provided, and still completes a real fresh capture", async () => {
    const fixture = await enrolled();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
    });
    expect(result.status).toBe("captured");
    if (result.status !== "captured") throw new Error("unreachable");
    expect(result.generationId).toBe(`${fixture.base}-0`);
  });

  it("refuses hold-entry-evidence with journal-internal-error evidence when enterMaintenance throws something other than a BackendPublicationJournalError (proves classifyHoldEntryFailure's fallback, not just its typed branches)", async () => {
    const fixture = await enrolled();
    class ThrowsGenericErrorCoordinator extends BackendPublicationCoordinator {
      override async enterMaintenance(): Promise<BackendMaintenanceJournal> {
        throw new Error("injected: not a BackendPublicationJournalError");
      }
    }
    const driver: BackendPublicationDriver = {
      observeLocalState: async () => { throw new Error("v2 driver must not run for maintenance"); },
      publishProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
      publishConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
      restoreConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
      restoreProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
    };
    const coordinator = new ThrowsGenericErrorCoordinator({ homeDir: fixture.homeDir, driver });
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
    });
    expect(result).toEqual({ status: "refuse", reason: "hold-entry-evidence", evidence: "journal-internal-error" });
  });

  it("refuses capture-failed with unknown-capture-failure evidence when the injected capture step throws a non-Error value, proving the ternary's other side rather than assuming it", async () => {
    const { fixture, coordinator } = await capturedFixture();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      _operationsForTesting: {
        captureSource: async () => { throw "not-an-error-instance"; },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "capture-failed", evidence: "unknown-capture-failure" });
  });

  it("builds the maintenance-entering candidate defensively when a journal observation reports an empty roster, never crashing on journal.roster[0] (injected: readBackendMaintenanceJournal itself already refuses an empty roster as malformed-journal, so this shape cannot reach apply.ts from any real on-disk state — verified empirically — and this defensive fallback is proven by the seam rather than by a real journal that cannot exist)", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const fabricated: BackendMaintenanceJournal = {
      version: 3, publicationId: `${fixture.base}-0`, sourceBackend: "sqlite", targetBackend: null,
      phase: "maintenance-entering", createdAt: "2026-08-12T12:00:00.000Z", updatedAt: "2026-08-12T12:00:00.000Z",
      generationId: `${fixture.base}-0`, sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [], selectedGenerationId: null, terminalEvidenceSha256: null, abortEvidenceSha256: null,
      checksumSha256: "c".repeat(64),
    };
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: fabricated }),
        resolveHoldContinuation: (resolveInput) => {
          expect(resolveInput.candidate.machineId).toBe("");
          return { action: "recover-entering", observedChecksumSha256: fabricated.checksumSha256 };
        },
      },
    });
    // The recovery itself still fails (the fabricated checksum cannot match
    // anything real), which is expected and irrelevant to what this test
    // proves: that building the candidate did not throw on the empty roster.
    expect(result.status).toBe("refuse");
  });
});

describe("maintenanceOnlyDriver (the default coordinator's v2 driver, which must never actually run)", () => {
  it("refuses to run any of its five methods, proving \"must not run\" is enforced rather than merely documented", async () => {
    const driver = maintenanceOnlyDriver();
    for (const method of [
      driver.observeLocalState, driver.publishProjectMap, driver.publishConfig,
      driver.restoreConfig, driver.restoreProjectMap,
    ] as ReadonlyArray<() => Promise<unknown>>) {
      await expect(method()).rejects.toThrow(MIGRATION_DRIVER_NOT_INVOKED_MESSAGE);
    }
  });
});
describe("performMigrationApplyThroughCapture, round-1 fixes (A-3/B-2, A-7, B-5, A-9, A-15)", () => {
  function occupy(homeDir: string, generationId: string): void {
    new MigrationManifestStore({ homeDir }).create(createMigrationManifest({
      generationId,
      source: manifestWitness("1".repeat(64)),
      destination: manifestWitness("2".repeat(64), "postgresql"),
      parentGenerationId: null,
      preservedSourceGenerationId: generationId,
      createdAt: "2026-08-12T12:00:00.000Z",
    }));
  }

  /**
   * Fails the real capture after its registration is durable, leaving a real
   * partial generation. The first two project copies are the source-byte
   * sampling and the private inspection that precede registration, so the
   * third one (the artifact capture itself) throws.
   */
  function partialCaptureObserver() {
    let projectCopies = 0;
    return {
      observe: (boundary: string, _path: string, role: string | null) => {
        if (boundary === "after-source-copy" && role === "project") {
          projectCopies += 1;
          if (projectCopies === 3) throw new Error("injected capture failure");
        }
      },
    };
  }

  it("A-3/B-2: refuses confirmation-generation-moved, writing nothing, when a real occupier takes the confirmed candidate after the preflight and before capture", async () => {
    const fixture = await enrolled();
    const confirmed = `${fixture.base}-0`;
    // The preflight's view of the world: the candidate is free.
    const preview = await resolveMigrationApplyCandidate({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base });
    expect(preview).toMatchObject({ status: "candidate", generationId: confirmed });
    // A real same-host actor then occupies the confirmed candidate.
    occupy(fixture.homeDir, confirmed);

    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      confirmGenerationId: confirmed,
    });

    // Before the fix the re-probe silently advanced and captured the -1
    // generation the operator never confirmed.
    expect(result).toEqual({ status: "refuse", reason: "confirmation-generation-moved" });
    expect(readBackendMaintenanceJournal(fixture.homeDir)).toBeNull();
    expect((await classifySqliteSnapshotArtifact(`${fixture.base}-1`, { homeDir: fixture.homeDir })).state).toBe("absent");
  });

  it("A-3/B-2 positive control: confirming the id the world now offers captures exactly that generation", async () => {
    const fixture = await enrolled();
    occupy(fixture.homeDir, `${fixture.base}-0`);
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      confirmGenerationId: `${fixture.base}-1`,
    });
    expect(result).toMatchObject({ status: "captured", generationId: `${fixture.base}-1` });
  });

  it("A-3/B-2: a live hold on a different generation than the confirmed one refuses before anything is written", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const first = await capture({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator });
    expect(first.status).toBe("captured");
    const journalBefore = readFileSync(backendPublicationJournalPath(fixture.homeDir));

    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      confirmGenerationId: `${fixture.base}-7`,
    });

    expect(result).toEqual({ status: "refuse", reason: "confirmation-generation-moved" });
    expect(readFileSync(backendPublicationJournalPath(fixture.homeDir)).equals(journalBefore)).toBe(true);
  });

  it("A-7: a real held journal whose snapshot is partial routes to continuation-partial-snapshot (exit 2, abort), not capture-failed", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const failed = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      _operationsForTesting: {
        captureSource: (authority, options) => captureAuthenticatedSqliteMigrationSource(authority, {
          ...options,
          _operationsForTesting: partialCaptureObserver(),
        }),
      },
    });
    expect(failed).toMatchObject({ status: "refuse", reason: "capture-failed" });
    const generationId = `${fixture.base}-0`;
    // Positive controls: the state really is held + partial.
    expect(readBackendMaintenanceJournal(fixture.homeDir)!.phase).toBe("maintenance-held");
    expect((await classifySqliteSnapshotArtifact(generationId, { homeDir: fixture.homeDir })).state).toBe("partial");

    const result = await capture({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator });

    expect(result).toEqual({ status: "refuse", reason: "continuation-partial-snapshot", evidence: "snapshot-partial" });
  });

  it("A-7: a held journal whose snapshot is replaced routes the same way", async () => {
    const { fixture, coordinator, first } = await (async () => {
      const f = await enrolled();
      const c = coordinatorFor(f.homeDir);
      const r = await capture({ cwd: f.cwd, homeDir: f.homeDir, base: f.base, coordinator: c });
      if (r.status !== "captured") throw new Error("fixture setup expected a successful first capture");
      return { fixture: f, coordinator: c, first: r };
    })();
    const generations = join(fixture.homeDir, ".lcm", "migration-snapshots", "generations");
    renameSync(join(generations, first.generationId), join(generations, `${first.generationId}.original`));
    mkdirSync(join(generations, first.generationId), { mode: 0o700 });
    expect((await classifySqliteSnapshotArtifact(first.generationId, { homeDir: fixture.homeDir })).state).toBe("replaced");

    const result = await capture({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator });

    expect(result).toEqual({ status: "refuse", reason: "continuation-partial-snapshot", evidence: "snapshot-replaced" });
  });

  it("A-7 (plan section 8): a held journal whose snapshot is tampered refuses continuation-snapshot-tampered (exit 5) and never retries capture over it", async () => {
    const { fixture, coordinator, first } = await (async () => {
      const f = await enrolled();
      const c = coordinatorFor(f.homeDir);
      const r = await capture({ cwd: f.cwd, homeDir: f.homeDir, base: f.base, coordinator: c });
      if (r.status !== "captured") throw new Error("fixture setup expected a successful first capture");
      return { fixture: f, coordinator: c, first: r };
    })();
    rmSync(join(fixture.homeDir, ".lcm", "migration-snapshots", "registrations", `${first.generationId}.intent.json`));
    expect((await classifySqliteSnapshotArtifact(first.generationId, { homeDir: fixture.homeDir })).state).toBe("tampered");

    const result = await capture({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator });

    expect(result).toEqual({ status: "refuse", reason: "continuation-snapshot-tampered", evidence: "snapshot-tampered" });
  });

  it("A-7: a non-Error classification failure is reported with the unknown-snapshot-failure evidence", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const first = await capture({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator });
    expect(first.status).toBe("captured");
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      _operationsForTesting: { classifySnapshot: async () => { throw "not-an-error-object"; } },
    });
    expect(result).toEqual({ status: "refuse", reason: "snapshot-unresolvable", evidence: "unknown-snapshot-failure" });
  });

  it("A-7: a held journal whose snapshot cannot be classified refuses snapshot-unresolvable rather than guessing (deterministic injection: a real classification failure needs an unsupported platform)", async () => {
    const { fixture, coordinator } = await (async () => {
      const f = await enrolled();
      const c = coordinatorFor(f.homeDir);
      const r = await capture({ cwd: f.cwd, homeDir: f.homeDir, base: f.base, coordinator: c });
      if (r.status !== "captured") throw new Error("fixture setup expected a successful first capture");
      return { fixture: f, coordinator: c };
    })();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      _operationsForTesting: { classifySnapshot: async () => { throw new TypeError("injected classification failure"); } },
    });
    expect(result).toEqual({ status: "refuse", reason: "snapshot-unresolvable", evidence: "TypeError" });
  });

  class ThrowingEnterCoordinator extends BackendPublicationCoordinator {
    constructor(homeDir: string, private readonly failure: Error) {
      super({ homeDir, driver: maintenanceOnlyDriver() });
    }
    override async enterMaintenance(): Promise<BackendMaintenanceJournal> {
      throw this.failure;
    }
  }

  it.each([
    ["lock contention", new PrivateMutationLockContentionError("contended"), "hold-entry-contention", "lock-contention"],
    ["a moved journal (CAS mismatch)", new BackendPublicationJournalError("unexpected-state", "moved"), "hold-entry-precondition", "journal-unexpected-state"],
    ["unsafe storage", new BackendPublicationJournalError("unsafe-storage", "unsafe"), "hold-entry-evidence", "journal-unsafe-storage"],
    ["a malformed journal", new BackendPublicationJournalError("malformed-journal", "bad"), "hold-entry-evidence", "journal-malformed-journal"],
  ])("B-5: hold entry failing on %s is classified by its reason", async (_name, failure, reason, evidence) => {
    const fixture = await enrolled();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      coordinator: new ThrowingEnterCoordinator(fixture.homeDir, failure),
    });
    expect(result).toEqual({ status: "refuse", reason, evidence });
  });

  /** Records the hold it was asked to enter, then fails like a write that died between the two journal writes. */
  class RecordingThrowingEnterCoordinator extends BackendPublicationCoordinator {
    entered: Parameters<BackendPublicationCoordinator["enterMaintenance"]>[0] | undefined;
    constructor(homeDir: string, private readonly failure: Error) {
      super({ homeDir, driver: maintenanceOnlyDriver() });
    }
    override async enterMaintenance(input: Parameters<BackendPublicationCoordinator["enterMaintenance"]>[0]): Promise<BackendMaintenanceJournal> {
      this.entered = input;
      throw this.failure;
    }
  }

  /** The live journal as a failed entry could leave it, bound to the hold the coordinator was just asked for. */
  const liveJournalFor = (
    coordinator: RecordingThrowingEnterCoordinator,
    overrides: Partial<BackendMaintenanceJournal>,
  ): BackendMaintenanceJournal => ({
    generationId: coordinator.entered!.generationId,
    sourceSelectionSha256: coordinator.entered!.sourceSelectionSha256,
    queueEvidenceSha256: coordinator.entered!.queueEvidenceSha256,
    phase: "maintenance-entering",
    ...overrides,
  }) as BackendMaintenanceJournal;

  it.each([
    ["a maintenance-entering journal bound to this hold", { phase: "maintenance-entering" as const }, true],
    ["a maintenance-held journal bound to this hold", { phase: "maintenance-held" as const }, true],
    ["a journal of another generation", { generationId: "generation-other" }, false],
    ["a terminal journal bound to this hold", { phase: "maintenance-aborted" as const }, false],
    ["a journal with another source selection", { sourceSelectionSha256: "f".repeat(64) }, false],
    ["a journal with other queue evidence", { queueEvidenceSha256: "e".repeat(64) }, false],
  ])("a failed fresh hold entry reports applied only when the live journal is this hold (%s)", async (_name, overrides, applied) => {
    const fixture = await enrolled();
    const coordinator = new RecordingThrowingEnterCoordinator(fixture.homeDir, new PrivateMutationLockContentionError("contended"));
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      _operationsForTesting: { readJournal: () => liveJournalFor(coordinator, overrides) },
    });
    expect(result).toStrictEqual({
      status: "refuse", reason: "hold-entry-contention", evidence: "lock-contention", ...(applied ? { applied: true } : {}),
    });
  });

  it("a failed fresh hold entry reports applied when the journal cannot be read back, and none when the slot is empty", async () => {
    const fixture = await enrolled();
    const unreadable = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      coordinator: new RecordingThrowingEnterCoordinator(fixture.homeDir, new BackendPublicationJournalError("unsafe-storage", "unsafe")),
      _operationsForTesting: { readJournal: () => { throw new Error("unreadable"); } },
    });
    expect(unreadable).toStrictEqual({ status: "refuse", reason: "hold-entry-evidence", evidence: "journal-unsafe-storage", applied: true });
    const empty = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      coordinator: new RecordingThrowingEnterCoordinator(fixture.homeDir, new PrivateMutationLockContentionError("contended")),
      _operationsForTesting: { readJournal: () => null },
    });
    expect(empty).toStrictEqual({ status: "refuse", reason: "hold-entry-contention", evidence: "lock-contention" });
  });

  it("a hold entry that writes the journal and then fails is reported applied from the real journal on disk", async () => {
    const fixture = await enrolled();
    class WriteThenFailCoordinator extends BackendPublicationCoordinator {
      override async enterMaintenance(input: Parameters<BackendPublicationCoordinator["enterMaintenance"]>[0], lockToken?: Parameters<BackendPublicationCoordinator["enterMaintenance"]>[1]): Promise<BackendMaintenanceJournal> {
        await super.enterMaintenance(input, lockToken);
        throw new PrivateMutationLockContentionError("contended");
      }
    }
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      coordinator: new WriteThenFailCoordinator({ homeDir: fixture.homeDir, driver: maintenanceOnlyDriver() }),
    });
    expect(result).toStrictEqual({ status: "refuse", reason: "hold-entry-contention", evidence: "lock-contention", applied: true });
    expect(readBackendMaintenanceJournal(fixture.homeDir)).toMatchObject({ phase: "maintenance-held" });
  });

  it.each([
    ["lock contention", new PrivateMutationLockContentionError("contended"), "capture-contention", "lock-contention"],
    ["an unresolved publication", new BackendPublicationJournalError("unresolved-publication", "held"), "capture-contention", "journal-unresolved-publication"],
    ["a journal checksum failure", new BackendPublicationJournalError("checksum-mismatch", "bad"), "capture-unresolvable", "journal-checksum-mismatch"],
    ["a plain capture failure", new Error("boom"), "capture-failed", "Error"],
  ])("A-9: capture failing on %s is classified by its reason", async (_name, failure, reason, evidence) => {
    const fixture = await enrolled();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      _operationsForTesting: { captureSource: async () => { throw failure; } },
    });
    expect(result).toEqual({ status: "refuse", reason, evidence });
  });

  it("A-9 positive control: a real SqliteSnapshotError stays capture-failed (exit 7)", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      _operationsForTesting: {
        captureSource: (authority, options) => captureAuthenticatedSqliteMigrationSource(authority, {
          ...options,
          _operationsForTesting: partialCaptureObserver(),
        }),
      },
    });
    expect(result).toMatchObject({ status: "refuse", reason: "capture-failed" });
  });

  it("A-15: a capture that reports success without the journal's queue evidence having been rebound is refused with distinct evidence", async () => {
    const fixture = await enrolled();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      _operationsForTesting: { captureSource: async () => ({}) as never },
    });
    expect(result).toEqual({ status: "refuse", reason: "capture-failed", evidence: "queue-evidence-not-rebound" });
  });
});

describe("performMigrationApplyThroughCapture, the identity step inside the span (Codex PR #1653 P2: no mint before the span's own refusals)", () => {
  const IDENTITY = {
    id: "remote-project-1", localProjectId: "local-1", canonical: "/tmp/project", remoteProjectId: "remote-project-1",
    machineId: REGISTERED_MACHINE, selectedPath: "/tmp/project",
  };
  function recorder(result: Awaited<ReturnType<MigrationApplyIdentityResolver>> = { status: "resolved", expectedIdentity: IDENTITY }) {
    const calls: MigrationApplyIdentityStep[] = [];
    const resolve: MigrationApplyIdentityResolver = async (step) => { calls.push(step); return result; };
    return { calls, resolve };
  }
  function occupy(homeDir: string, generationId: string): void {
    new MigrationManifestStore({ homeDir }).create(createMigrationManifest({
      generationId,
      source: manifestWitness("1".repeat(64)),
      destination: manifestWitness("2".repeat(64), "postgresql"),
      parentGenerationId: null,
      preservedSourceGenerationId: generationId,
      createdAt: "2026-08-12T12:00:00.000Z",
    }));
  }
  class ThrowingEnterCoordinator extends BackendPublicationCoordinator {
    constructor(homeDir: string, private readonly failure: Error) {
      super({ homeDir, driver: maintenanceOnlyDriver() });
    }
    override async enterMaintenance(): Promise<BackendMaintenanceJournal> {
      throw this.failure;
    }
  }

  it("a moved confirmed candidate (real occupier) refuses before the identity step ever runs", async () => {
    const fixture = await enrolled();
    const confirmed = `${fixture.base}-0`;
    occupy(fixture.homeDir, confirmed);
    const identity = recorder();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      confirmGenerationId: confirmed, resolveExpectedIdentity: identity.resolve,
    });
    expect(result).toEqual({ status: "refuse", reason: "confirmation-generation-moved" });
    expect(identity.calls).toEqual([]);
    expect(readProjectMapIdentity({ homeDir: fixture.homeDir, cwd: fixture.cwd })).toBeNull();
  });

  it("a failed hold entry refuses after the fresh identity step ran exactly once under the span's token, so the caller can report the mint", async () => {
    const fixture = await enrolled();
    const identity = recorder();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base,
      coordinator: new ThrowingEnterCoordinator(fixture.homeDir, new PrivateMutationLockContentionError("contended")),
      resolveExpectedIdentity: identity.resolve,
    });
    expect(result).toEqual({ status: "refuse", reason: "hold-entry-contention", evidence: "lock-contention" });
    expect(identity.calls.map((call) => call.path)).toEqual(["fresh"]);
    expect(identity.calls[0]).toMatchObject({ path: "fresh", token: expect.any(Object) });
  });

  it("a fresh identity refusal is the span's own refusal, before any hold is written", async () => {
    const fixture = await enrolled();
    const identity = recorder({ status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "post-conflict-reread-absent" });
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      resolveExpectedIdentity: identity.resolve,
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "post-conflict-reread-absent" });
    expect(readBackendMaintenanceJournal(fixture.homeDir)).toBeNull();
    const bare = recorder({ status: "refuse", reason: "local-identity-not-persisted" });
    expect(await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      resolveExpectedIdentity: bare.resolve,
    })).toEqual({ status: "refuse", reason: "local-identity-not-persisted" });
  });

  it("a shared-scope project refuses multi-machine-installation before the identity step runs: no destination project is resolved or created and the project map is untouched (#1689)", async () => {
    const fixture = await enrolled();
    closeLcmConnection();
    const sharedMap = JSON.stringify({
      [fixture.local.id]: { canonical: fixture.cwd, aliases: [], remoteProjectId: REGISTERED_MACHINE },
    });
    writeFileSync(projectMapPath(fixture.homeDir), sharedMap, { mode: 0o600 });
    clearProjectMapCache();
    const identity = recorder();
    const resolveTargetIdentity = vi.fn(async () => ({ status: "resolved" as const, projectId: "minted-project" }));
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      resolveExpectedIdentity: async (step) => {
        await identity.resolve(step);
        return resolveMigrationExpectedIdentity({
          preflight: {
            targetConfig: fixture.request.targetConfig, machineId: REGISTERED_MACHINE,
            candidate: { disposition: "fresh" },
          },
          cwd: fixture.cwd, homeDir: fixture.homeDir, ...(step.path === "fresh" ? { publicationLockToken: step.token } : {}),
          _operationsForTesting: { createIdentityRuntime: () => ({ close: async () => undefined }) as never, resolveTargetIdentity },
        });
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "multi-machine-installation" });
    expect(identity.calls).toEqual([]);
    expect(resolveTargetIdentity).not.toHaveBeenCalled();
    expect(readFileSync(projectMapPath(fixture.homeDir), "utf8")).toBe(sharedMap);
    expect(readBackendMaintenanceJournal(fixture.homeDir)).toBeNull();
  });

  it("a project bound to a destination while the identity step runs is still refused multi-machine-installation after it, before any hold (defence in depth)", async () => {
    const fixture = await enrolled();
    closeLcmConnection();
    const identity = recorder();
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      resolveExpectedIdentity: async (step) => {
        await identity.resolve(step);
        writeFileSync(projectMapPath(fixture.homeDir), JSON.stringify({
          [fixture.local.id]: { canonical: fixture.cwd, aliases: [], remoteProjectId: REGISTERED_MACHINE },
        }), { mode: 0o600 });
        clearProjectMapCache();
        return { status: "resolved", expectedIdentity: IDENTITY };
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "multi-machine-installation" });
    expect(identity.calls.map((call) => call.path)).toEqual(["fresh"]);
    expect(readBackendMaintenanceJournal(fixture.homeDir)).toBeNull();
  });

  it("a local project reaches the fresh identity step exactly once (control for the shared-scope pre-check)", async () => {
    const fixture = await enrolled();
    const identity = recorder({ status: "refuse", reason: "local-identity-not-persisted" });
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      resolveExpectedIdentity: identity.resolve,
    });
    expect(result).toEqual({ status: "refuse", reason: "local-identity-not-persisted" });
    expect(identity.calls.map((call) => call.path)).toEqual(["fresh"]);
  });

  it("the real fresh mint runs under the barrier token: the map entry appears, the hold and capture bind to the minted selection, and the captured outcome carries the identity", async () => {
    const fixture = await enrolled();
    expect(readProjectMapIdentity({ homeDir: fixture.homeDir, cwd: fixture.cwd })).toBeNull();
    const beforeMint = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir).sourceSelectionSha256;
    const resolveTargetIdentity = vi.fn(async () => ({ status: "resolved" as const, projectId: "minted-project" }));
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator: coordinatorFor(fixture.homeDir),
      resolveExpectedIdentity: (step) => resolveMigrationExpectedIdentity({
        preflight: {
          targetConfig: fixture.request.targetConfig, machineId: REGISTERED_MACHINE,
          candidate: { disposition: step.path === "fresh" ? "fresh" : "continue-held" },
        },
        cwd: fixture.cwd, homeDir: fixture.homeDir, ...(step.path === "fresh" ? { publicationLockToken: step.token } : {}),
        _operationsForTesting: { createIdentityRuntime: () => ({ close: async () => undefined }) as never, resolveTargetIdentity },
      }),
    });
    expect(result).toMatchObject({ status: "captured", generationId: `${fixture.base}-0`, expectedIdentity: { id: "minted-project", localProjectId: fixture.local.id, canonical: fixture.local.canonical } });
    const persisted = readProjectMapIdentity({ homeDir: fixture.homeDir, cwd: fixture.cwd });
    expect(persisted).toMatchObject({ id: fixture.local.id, canonical: fixture.local.canonical });
    expect(resolveTargetIdentity).toHaveBeenCalledOnce();
    // The hold's source selection is the minted map's, not the unmapped
    // one the preflight-era read computed; capture itself re-authenticated
    // under the token and verified the journal against that selection.
    const journal = readBackendMaintenanceJournal(fixture.homeDir)!;
    expect(journal.sourceSelectionSha256).not.toBe(beforeMint);
    expect(journal.generationId).toBe(`${fixture.base}-0`);
    expect((await classifySqliteSnapshotArtifact(journal.generationId, { homeDir: fixture.homeDir })).state).toBe("complete");
  });

  it("a held continuation runs the read-only identity step inside its barrier and carries its answer; its refusal stops before capture", async () => {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const first = await capture({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator });
    expect(first).toMatchObject({ status: "captured" });
    expect(first).not.toHaveProperty("expectedIdentity");
    const identity = recorder();
    const again = await capture({ cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator, resolveExpectedIdentity: identity.resolve });
    expect(again).toMatchObject({ status: "captured", generationId: `${fixture.base}-0`, expectedIdentity: IDENTITY });
    expect(identity.calls.map((call) => call.path)).toEqual(["held"]);
    const refused = recorder({ status: "refuse", reason: "destination-project-absent" });
    const captureSource = vi.fn(captureAuthenticatedSqliteMigrationSource);
    expect(await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator, resolveExpectedIdentity: refused.resolve,
      _operationsForTesting: { captureSource },
    })).toEqual({ status: "refuse", reason: "destination-project-absent" });
    expect(captureSource).not.toHaveBeenCalled();
  });
});

describe("performMigrationApplyThroughCapture, recover-entering runs the held identity read before promoting the hold (review 3A P1)", () => {
  async function enteringJournal() {
    const fixture = await enrolled();
    const coordinator = coordinatorFor(fixture.homeDir);
    const generationId = `${fixture.base}-0`;
    const authority = authenticateSqliteMigrationSource(fixture.cwd, fixture.homeDir);
    const sentinel = migrationQueueEvidenceSentinel({ generationId, sourceSelectionSha256: authority.sourceSelectionSha256 });
    const roster = migrationEntryRoster({ machineId: authority.machineIdentity.machineId, sentinelEvidenceSha256: sentinel });
    await coordinator.enterMaintenance({ publicationId: generationId, generationId, sourceSelectionSha256: authority.sourceSelectionSha256, queueEvidenceSha256: sentinel, roster });
    const path = backendPublicationJournalPath(fixture.homeDir);
    const { checksumSha256: _checksum, ...payload } = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSyncFs(path, `${JSON.stringify({ ...payload, phase: "maintenance-entering", checksumSha256: backendPublicationCanonicalSha256({ ...payload, phase: "maintenance-entering" }) })}\n`, { mode: 0o600 });
    expect(readBackendMaintenanceJournal(fixture.homeDir)!.phase).toBe("maintenance-entering");
    return { fixture, coordinator, generationId, before: readFileSync(path) };
  }

  it("a held identity refusal leaves the real entering journal untouched: no promotion to maintenance-held, the refusal is the resolver's own", async () => {
    const { fixture, coordinator, before } = await enteringJournal();
    const calls: MigrationApplyIdentityStep[] = [];
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      resolveExpectedIdentity: async (step) => { calls.push(step); return { status: "refuse", reason: "local-identity-not-persisted" }; },
    });
    expect(result).toEqual({ status: "refuse", reason: "local-identity-not-persisted" });
    expect(calls).toEqual([{ path: "held" }]);
    expect(readBackendMaintenanceJournal(fixture.homeDir)!.phase).toBe("maintenance-entering");
    expect(readFileSync(backendPublicationJournalPath(fixture.homeDir)).equals(before)).toBe(true);
  });

  it("a resolved held identity is read once, before the promotion, and carried into the recovered capture", async () => {
    const { fixture, coordinator, generationId } = await enteringJournal();
    const calls: string[] = [];
    const IDENTITY = { id: "r", localProjectId: "l", canonical: fixture.cwd, remoteProjectId: "r", machineId: REGISTERED_MACHINE, selectedPath: fixture.cwd };
    const result = await capture({
      cwd: fixture.cwd, homeDir: fixture.homeDir, base: fixture.base, coordinator,
      resolveExpectedIdentity: async (step) => { calls.push(`${step.path}:${readBackendMaintenanceJournal(fixture.homeDir)!.phase}`); return { status: "resolved", expectedIdentity: IDENTITY }; },
    });
    expect(result).toMatchObject({ status: "captured", generationId, expectedIdentity: IDENTITY });
    expect(calls).toEqual(["held:maintenance-entering"]);
    expect(readBackendMaintenanceJournal(fixture.homeDir)!.phase).toBe("maintenance-held");
  });
});
