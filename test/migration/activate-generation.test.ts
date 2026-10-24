import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigValidationError, DEFAULT_DAEMON_PORT, readDaemonConfigSnapshot } from "../../src/daemon/config.js";
import { ensurePendingMachineIdentity, finalizeMachineIdentity } from "../../src/machine-identity.js";
import { clearProjectMapCache, hashProjectPath, normalizeProjectPath, projectMapPath } from "../../src/project-map.js";
import { configPath, lcmHomeDir, projectsDir } from "../../src/runtime-paths.js";
import {
  BackendPublicationCoordinator,
  backendPublicationDirectory,
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  type BackendPublicationDriver,
  type BackendPublicationObserver,
} from "../../src/storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../../src/storage/backend-publication-driver.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import type { PostgreSqlConnectionSettings, PostgreSqlRuntimeHealth } from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlBackendPublicationGuardError,
  type PostgreSqlBackendPublicationAcquireInput,
  type PostgreSqlBackendPublicationFence,
  type PostgreSqlBackendPublicationMutationInput,
} from "../../src/storage/postgresql/publication-guard.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../src/storage/postgresql/publication-remote-guard.js";
import { PostgreSqlRuntimeReadinessError, type PostgreSqlRuntimeReadiness } from "../../src/storage/postgresql/runtime-readiness.js";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";
import { StorageOperationError } from "../../src/storage/errors.js";
import { PORTABLE_RECORD_DOMAIN_ORDER, PortableStreamError, type PortableDomain } from "../../src/storage/portable-record.js";
import {
  MIGRATION_ACTIVATION_LEASE_CLEANUP_TIMEOUT_MS,
  MigrationActivationError,
  createMigrationActivationDependencies,
  previewMigrationActivation,
  runMigrationActivation,
  type MigrationActivationDependencies,
  type MigrationActivationEvidenceSeam,
  type MigrationActivationInput,
  type MigrationActivationOrdinaryRuntime,
  type MigrationActivationOutcome,
  type MigrationActivationTransferRuntime,
} from "../../src/migration/activate-generation.js";
import {
  ActivationArtifactIdentityMismatchError,
  ActivationArtifactPresenceUnresolvableError,
  activationArtifactDirectory,
  activationArtifactPath,
  activationGenerationLinkPath,
  readActivationGenerationLink,
  recordActivationGenerationLink,
} from "../../src/migration/activation-artifact-store.js";
import {
  MigrationActivationEvidenceRefusalError,
  readMigrationActivationEvidence,
  recordMigrationActivationAttempt,
  recordMigrationActivationEpoch,
  recordMigrationActivationWitness,
} from "../../src/migration/activation-evidence-store.js";
import type { ActivationLeasePublicationGuard } from "../../src/migration/activation-lease.js";
import { deriveActivationPublicationId } from "../../src/migration/activation-publication-id.js";
import { MigrationActivationReportError, migrationActivationReportDirectory, readMigrationActivationReport } from "../../src/migration/activation-report.js";
import {
  migrationWitnessSha256,
  type MigrationActivationAttempt,
  type MigrationActivationEpoch,
  type MigrationActivationWitness,
} from "../../src/migration/activation-witness.js";
import { migrationCopyTargetGeneration } from "../../src/migration/copy-source.js";
import {
  recordMigrationSelectionBinding,
  recordMigrationWitnessBinding,
  resolveMigrationWitnessBindings,
  type MigrationWitnessResolution,
} from "../../src/migration/generation-binding-store.js";
import { MigrationManifestStore, migrationManifestRevisionPath } from "../../src/migration/manifest-store.js";
import { MigrationProjectMapWitnessError, computeMigrationProjectMapWitnessSha256 } from "../../src/migration/project-map-witness.js";
import {
  MigrationProtocolError,
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  type MigrationManifest,
  type MigrationStorageWitness,
} from "../../src/migration/protocol.js";
import { checkMigrationTargetHealth, type MigrationTargetHealthResult } from "../../src/migration/target-health.js";
import {
  MIGRATION_MISMATCH_CLASSES,
  MIGRATION_PUBLIC_PROBE_ORDER,
  createMigrationVerificationReport,
  type CreateMigrationVerificationReportInput,
  type MigrationVerificationReport,
} from "../../src/migration/verification-report.js";
import { MigrationVerificationReportStore } from "../../src/migration/verification-store.js";
import {
  buildMigrationCanonicalDelta,
  buildMigrationCensusVector,
  type MigrationVerificationDomainCensus,
} from "../../src/migration/verify-generation.js";

// ---------------------------------------------------------------------------
// Fixture: a real home with real stores, a real coordinator over the real
// #1433 driver and the real PostgreSQL remote-guard provider, over an
// in-memory PostgreSQL lease guard; the real #626 evidence store, binding
// resolver and census builders (wrapped only for inspection and
// deterministic fault injection); fake PostgreSQL runtimes for health,
// identity, copy binding and the destination census rows.
// ---------------------------------------------------------------------------

const GENERATION = "generation-1";
const MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";
const REMOTE = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const EVIDENCE = "e".repeat(64);
const DEST_IDENTITY = "d".repeat(64);
const SYSTEM_ID = "712345";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const SETTINGS: PostgreSqlConnectionSettings = {
  url: "postgresql://unused", caFile: "/dev/null", poolMax: 1, connectionTimeoutMs: 1000, idleTimeoutMs: 1000, statementTimeoutMs: 1000,
};
/** What the (fake) transfer verifier admits; the activation role holds the transfer profile (plan-v7.2 B1). */
const READINESS: PostgreSqlRuntimeReadiness = {
  currentMigrationIds: [], expectedOwner: "lcm_migrator", runtimeRole: "lcm", managedObjectCount: 0, definitionObjectCount: 0, privilegeManifestVersion: 1,
};

const roots: string[] = [];
afterEach(() => {
  clearProjectMapCache();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function domainVector<T>(build: (domain: PortableDomain, index: number) => T): T[] {
  return PORTABLE_RECORD_DOMAIN_ORDER.map(build);
}

/** The destination census the fake snapshot reads; the real builders derive
 * the report's census vector and canonical delta from the same rows. */
function domainCensus(seed: string): MigrationVerificationDomainCensus[] {
  return domainVector((domain, index) => ({
    domain, recordCount: index, prefixSha256: migrationWitnessSha256([seed, domain]), terminalIdentitySha256: migrationWitnessSha256(["delta", domain]),
  }));
}

function witness(backend: MigrationStorageWitness["backend"], capturedAt: string): MigrationStorageWitness {
  const base = { version: 1 as const, backend, identitySha256: backend === "postgresql" ? DEST_IDENTITY : HASH_A, schemaSha256: HASH_B, contentSha256: HASH_C, capturedAt };
  return backend === "postgresql" ? { ...base, systemIdentifier: SYSTEM_ID } : base;
}

/** In-memory PostgreSQL lease guard mirroring publication-guard.ts's acquire /
 * renew / release / read rules closely enough for the orchestrator, the
 * drive and the real remote-guard provider. */
class FakeLeaseGuard implements ActivationLeasePublicationGuard {
  readonly rows = new Map<string, PostgreSqlBackendPublicationFence>();
  nextToken = 1n;
  readonly calls: string[] = [];
  expireNext = false;

  private error(projectId: string, operation: string, reason: PostgreSqlBackendPublicationGuardError["reason"]): never {
    throw new PostgreSqlBackendPublicationGuardError(projectId, operation, reason);
  }

  /** The real runtime refuses an aborted signal before it connects or queries (runtime.ts acquire / query). */
  private admit(operation: string, signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new Error("fake guard " + operation + " refused an aborted signal: " + String((signal.reason as Error).message ?? signal.reason));
  }

  seed(fence: Partial<PostgreSqlBackendPublicationFence> & { projectId: string }): void {
    this.rows.set(fence.projectId, {
      machineId: MACHINE, publicationId: "other", targetBackend: "postgresql", evidenceSha256: EVIDENCE,
      fencingToken: this.nextToken++, acquiredAt: "2026-10-16T00:00:00.000Z", renewedAt: "2026-10-16T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z", releasedAt: null, databaseExpired: false, ...fence,
    });
  }

  expire(projectId: string): void {
    const row = this.rows.get(projectId);
    if (row !== undefined) this.rows.set(projectId, { ...row, databaseExpired: true });
  }

  async acquire(input: PostgreSqlBackendPublicationAcquireInput): Promise<PostgreSqlBackendPublicationFence> {
    this.calls.push("acquire");
    this.admit("acquire", input.signal);
    const current = this.rows.get(input.projectId);
    if (current !== undefined) {
      const same = current.machineId === input.machineId && current.publicationId === input.publicationId
        && current.targetBackend === input.targetBackend && current.evidenceSha256 === input.evidenceSha256;
      if (current.releasedAt === null) {
        if (!same) this.error(input.projectId, "acquire", "publication-conflict");
        if (input.expectedFencingToken !== undefined && current.fencingToken !== input.expectedFencingToken) this.error(input.projectId, "acquire", "fence-mismatch");
        if (!current.databaseExpired) return current;
        if (input.expectedFencingToken === undefined) this.error(input.projectId, "acquire", "fence-expired");
      } else if (input.expectedFencingToken !== undefined) {
        this.error(input.projectId, "acquire", "fence-mismatch");
      }
    }
    const fence: PostgreSqlBackendPublicationFence = {
      projectId: input.projectId, machineId: input.machineId, publicationId: input.publicationId, targetBackend: input.targetBackend,
      evidenceSha256: input.evidenceSha256, fencingToken: this.nextToken++, acquiredAt: "2026-10-16T00:00:00.000Z",
      renewedAt: "2026-10-16T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z", releasedAt: null, databaseExpired: false,
    };
    this.rows.set(input.projectId, fence);
    return fence;
  }

  async renew(input: PostgreSqlBackendPublicationMutationInput & { ttlMs: number }): Promise<PostgreSqlBackendPublicationFence> {
    this.calls.push("renew");
    this.admit("renew", input.signal);
    const current = this.rows.get(input.projectId);
    if (this.expireNext && current !== undefined) { this.expireNext = false; this.rows.set(input.projectId, { ...current, databaseExpired: true }); }
    const row = this.rows.get(input.projectId);
    if (row === undefined || row.releasedAt !== null || row.databaseExpired || row.fencingToken !== input.fencingToken
      || row.publicationId !== input.publicationId || row.evidenceSha256 !== input.evidenceSha256) {
      this.error(input.projectId, "renew", "fence-mismatch");
    }
    const renewed = { ...row, renewedAt: "2026-10-16T00:00:01.000Z" };
    this.rows.set(input.projectId, renewed);
    return renewed;
  }

  async release(input: PostgreSqlBackendPublicationMutationInput): Promise<PostgreSqlBackendPublicationFence> {
    this.calls.push("release");
    this.admit("release", input.signal);
    const row = this.rows.get(input.projectId);
    // The real UPDATE requires an unexpired, unreleased row under the caller's token.
    if (row === undefined || row.fencingToken !== input.fencingToken || row.releasedAt !== null || row.databaseExpired) {
      this.error(input.projectId, "release", "fence-mismatch");
    }
    const released = { ...row, releasedAt: "2026-10-16T00:00:02.000Z" };
    this.rows.set(input.projectId, released);
    return released;
  }

  async read(input: Pick<PostgreSqlBackendPublicationMutationInput, "projectId" | "targetBackend" | "evidenceSha256" | "signal">): Promise<PostgreSqlBackendPublicationFence | null> {
    this.calls.push("read");
    this.admit("read", input.signal);
    const row = this.rows.get(input.projectId);
    if (row === undefined) return null;
    if (row.targetBackend !== input.targetBackend || row.evidenceSha256 !== input.evidenceSha256) this.error(input.projectId, "read", "fence-mismatch");
    return row;
  }
}

type EvidenceSeam = MigrationActivationEvidenceSeam & Readonly<{
  epochs: ReadonlyMap<string, MigrationActivationEpoch>;
  attempts: ReadonlyMap<string, MigrationActivationAttempt>;
  witnesses: ReadonlyMap<string, MigrationActivationWitness>;
}> & { failNext: "epoch" | "read" | null };

/** The real #626 evidence store under the fixture home. The Map views read
 * the store back through the real reader; failNext injects the two rows the
 * real store cannot be driven into deterministically (a refused first write
 * and an unresolvable read). */
function evidenceStore(homeDir: string): EvidenceSeam {
  const stored = () => {
    const read = readMigrationActivationEvidence({ homeDir, generationId: GENERATION });
    return read.state === "resolved" ? read : { epochs: [], attempts: [], witnesses: [] };
  };
  const seam: EvidenceSeam = {
    failNext: null,
    get epochs() { return new Map(stored().epochs.map((epoch) => [epoch.epochId, epoch])); },
    get attempts() { return new Map(stored().attempts.map((attempt) => [attempt.attemptId, attempt])); },
    get witnesses() { return new Map(stored().witnesses.map((witness) => [witness.checksumSha256, witness])); },
    recordMigrationActivationEpoch(input) {
      if (seam.failNext === "epoch") { seam.failNext = null; throw new MigrationActivationEvidenceRefusalError("evidence-unresolvable", "injected"); }
      recordMigrationActivationEpoch(input);
    },
    recordMigrationActivationAttempt,
    recordMigrationActivationWitness,
    readMigrationActivationEvidence(input) {
      if (seam.failNext === "read") { seam.failNext = null; return { state: "unresolvable", reason: "injected" }; }
      return readMigrationActivationEvidence(input);
    },
  };
  return seam;
}

/** The real binding writers and the real #626 resolver; resolveOverride
 * substitutes one resolution for fault injection. */
function bindingStore() {
  const bindings: MigrationActivationDependencies["bindings"] & { resolveOverride: MigrationWitnessResolution | null } = {
    resolveOverride: null,
    recordMigrationWitnessBinding,
    recordMigrationSelectionBinding,
    resolveMigrationWitnessBindings: (input) => bindings.resolveOverride ?? resolveMigrationWitnessBindings(input),
  };
  return bindings;
}

type Fixture = Readonly<{
  homeDir: string;
  canonical: string;
  localProjectId: string;
  publicationId: string;
  guard: FakeLeaseGuard;
  evidence: EvidenceSeam;
  bindings: ReturnType<typeof bindingStore>;
  report: MigrationVerificationReport;
  manifestStore: MigrationManifestStore;
  deps: MigrationActivationDependencies & { health: MigrationTargetHealthResult[]; identity: { sealedWitnessSha256: string; systemIdentifier: string }; transferRows: Array<{ run_id: unknown; state: unknown }>; destinationCensus: MigrationVerificationDomainCensus[] };
  input: MigrationActivationInput;
  run: (overrides?: Partial<MigrationActivationDependencies>) => Promise<MigrationActivationOutcome>;
  coordinator: (observer?: BackendPublicationObserver) => BackendPublicationCoordinator;
}>;

function registerMachine(homeDir: string): void {
  const pending = ensurePendingMachineIdentity("Test Machine", homeDir).identity;
  finalizeMachineIdentity(pending, MACHINE, "Test Machine", homeDir);
}

/** Drive a genesis manifest through the legal effects to verified + eligible. */
function driveToVerified(store: MigrationManifestStore, generationId: string, report: MigrationVerificationReport): MigrationManifest {
  const at = (n: number) => "2026-10-16T12:00:" + String(n).padStart(2, "0") + ".000Z";
  let manifest = store.read(generationId);
  const effect = (kind: Parameters<typeof beginMigrationEffect>[1]["kind"], complete: Omit<Parameters<typeof completeMigrationEffect>[1], "effectId" | "completedAt">, n: number) => {
    manifest = store.update(generationId, manifest.checksumSha256, (m) => beginMigrationEffect(m, { effectId: kind + "-1", kind, inputSha256: HASH_A, startedAt: at(n) }));
    manifest = store.update(generationId, manifest.checksumSha256, (m) => completeMigrationEffect(m, { effectId: kind + "-1", completedAt: at(n + 1), ...complete }));
  };
  effect("verify-dry-run", { report: { kind: "dry-run", reportId: "dry-run-1", reportSha256: HASH_B, createdAt: at(1) } }, 1);
  effect("copy-batch", { checkpoint: { domain: "messages", ordinal: 1, recordCount: 1, sourceCheckpointSha256: HASH_A, destinationCommitSha256: HASH_B } }, 3);
  effect("complete-copy", {}, 5);
  effect("verify-generation", { report: { kind: "verification", reportId: report.reportId, reportSha256: report.reportSha256, createdAt: at(7) }, activationEligible: true }, 7);
  return manifest;
}

function buildReport(homeDir: string, localProjectId: string, overrides: Partial<CreateMigrationVerificationReportInput> = {}): MigrationVerificationReport {
  const projectMapWitnessSha256 = computeMigrationProjectMapWitnessSha256({ homeDir, localProjectId, remoteProjectId: REMOTE, mode: "pre-publication" });
  return createMigrationVerificationReport({
    generationId: GENERATION,
    targetGenerationId: migrationCopyTargetGeneration(GENERATION),
    bindingSha256: EVIDENCE,
    manifestRevision: 4,
    manifestChecksumSha256: HASH_B,
    sourceWitness: { version: 1, identitySha256: HASH_A, schemaSha256: HASH_B, contentSha256: HASH_C },
    destinationIdentity: { version: 1, sealedWitnessSha256: DEST_IDENTITY, systemIdentifier: SYSTEM_ID },
    destinationSchemaWitness: { version: 1, migrationsSha256: HASH_A, searchConfigurationSha256: HASH_B, collationSha256: HASH_C, sequenceStateSha256: HASH_A },
    projectMapWitnessSha256,
    queueClassificationWitness: { version: 1, queueCutoff: "0000000000000000001", queueSetSha256: HASH_A, receiptSetSha256: HASH_B, epochChecksumSha256: HASH_C },
    censusVector: buildMigrationCensusVector(domainCensus("census")),
    canonicalDelta: buildMigrationCanonicalDelta(domainCensus("census")),
    classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({ class: mismatchClass, ran: true })),
    sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: HASH_A },
    publicProbeSha256: migrationWitnessSha256(["probe"]),
    publicProbeCoverage: MIGRATION_PUBLIC_PROBE_ORDER.map((probe) => ({ probe, ran: true })),
    mismatches: [],
    mismatchTotals: [],
    ...overrides,
  });
}

async function fixture(options: { held?: boolean; rosterMachine?: string; extraProjectWithData?: boolean } = {}): Promise<Fixture> {
  const homeDir = mkdtempSync(join(tmpdir(), "lcm-activate-generation-"));
  roots.push(homeDir);
  mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
  const cwd = join(homeDir, "repo");
  mkdirSync(cwd, { mode: 0o700 });
  const canonical = normalizeProjectPath(cwd);
  const localProjectId = hashProjectPath(canonical);
  writeFileSync(join(lcmHomeDir(homeDir), "config.json"), JSON.stringify({ storage: { backend: "sqlite" }, daemon: { port: 4321 } }) + "\n", { mode: 0o600 });
  writeFileSync(projectMapPath(homeDir), JSON.stringify({ [localProjectId]: { canonical, aliases: [] } }) + "\n", { mode: 0o600 });
  clearProjectMapCache();
  mkdirSync(join(projectsDir(homeDir), localProjectId), { recursive: true, mode: 0o700 });
  writeFileSync(join(projectsDir(homeDir), localProjectId, "db.sqlite"), "sqlite", { mode: 0o600 });
  if (options.extraProjectWithData) {
    mkdirSync(join(projectsDir(homeDir), HASH_B), { recursive: true, mode: 0o700 });
    writeFileSync(join(projectsDir(homeDir), HASH_B, "db.sqlite"), "sqlite", { mode: 0o600 });
    const map = JSON.parse(readFileSync(projectMapPath(homeDir), "utf8")) as Record<string, unknown>;
    map[HASH_B] = { canonical: "/repos/other", aliases: [] };
    writeFileSync(projectMapPath(homeDir), JSON.stringify(map) + "\n", { mode: 0o600 });
    clearProjectMapCache();
  }
  registerMachine(homeDir);

  const report = buildReport(homeDir, localProjectId);
  new MigrationVerificationReportStore({ homeDir }).persist(GENERATION, report);
  const manifestStore = new MigrationManifestStore({ homeDir });
  manifestStore.create(createMigrationManifest({
    generationId: GENERATION,
    source: witness("sqlite", "2026-10-16T11:00:00.000Z"),
    destination: witness("postgresql", "2026-10-16T11:00:01.000Z"),
    parentGenerationId: null,
    preservedSourceGenerationId: "source-generation-1",
    createdAt: "2026-10-16T11:00:00.000Z",
  }));
  driveToVerified(manifestStore, GENERATION, report);

  const publicationId = deriveActivationPublicationId(GENERATION);
  const guard = new FakeLeaseGuard();
  const coordinator = (observer?: BackendPublicationObserver) => createBackendPublicationCoordinator({
    homeDir,
    observer,
    remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId: MACHINE, ttlMs: 60_000 }) },
  });
  if (options.held !== false) {
    await coordinator().enterMaintenance({
      publicationId,
      generationId: GENERATION,
      sourceSelectionSha256: HASH_A,
      queueEvidenceSha256: HASH_B,
      roster: [{ machineId: options.rosterMachine ?? MACHINE, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A }],
      now: new Date("2026-10-16T12:30:00.000Z"),
    });
  }

  const evidence = evidenceStore(homeDir);
  const bindings = bindingStore();
  const health: MigrationTargetHealthResult[] = [];
  const identity = { sealedWitnessSha256: DEST_IDENTITY, systemIdentifier: SYSTEM_ID };
  const transferRows: Array<{ run_id: unknown; state: unknown }> = [{ run_id: "migration-copy-" + EVIDENCE, state: "completed" }];
  const ordinary = (): MigrationActivationOrdinaryRuntime => ({
    health: async (): Promise<PostgreSqlRuntimeHealth> => ({ status: "healthy", backend: "postgresql" }),
    query: (async () => ({ rows: [] })) as unknown as MigrationActivationOrdinaryRuntime["query"],
    backendPublicationGuard: () => guard,
    close: async () => undefined,
  });
  const transfer = (): MigrationActivationTransferRuntime => ({
    query: (async () => ({ rows: transferRows })) as unknown as MigrationActivationTransferRuntime["query"],
    openReadOnlySnapshot: async () => ({ query: (async () => ({ rows: [] })) as unknown as MigrationActivationTransferRuntime["query"], close: async () => undefined }),
    close: async () => undefined,
  });
  const base = createMigrationActivationDependencies({ homeDir });
  const deps: Fixture["deps"] = {
    ...base,
    health,
    identity,
    transferRows,
    destinationCensus: domainCensus("census"),
    createOrdinaryRuntime: ordinary,
    createTransferRuntime: transfer,
    verifyTransferSchema: async () => READINESS,
    checkTargetHealth: async () => health.shift() ?? ({ status: "healthy", readiness: READINESS }),
    captureDestinationIdentity: async () => ({ version: 1, ...identity }),
    readDestinationCensus: async () => ({ census: deps.destinationCensus }),
    evidence,
    bindings,
    createCoordinator: () => coordinator(),
    machineId: () => MACHINE,
    daemonPort: () => 4321,
    checkRestart: async () => ({ status: "satisfied", reason: "no-pid-file", detail: "fake", pid: null, observedBackend: null, selectedBackend: "postgresql" }),
    leaseTtlMs: 60_000,
  };
  const input: MigrationActivationInput = {
    homeDir,
    generationId: GENERATION,
    transferSettings: SETTINGS,
    ordinarySettings: SETTINGS,
    expectedIdentity: { id: REMOTE, canonical, remoteProjectId: REMOTE, localProjectId, machineId: MACHINE } as StorageIdentityContext,
    expectedOwner: "lcm_migrator",
    now: () => new Date("2026-10-16T13:00:00.000Z"),
  };
  return {
    homeDir, canonical, localProjectId, publicationId, guard, evidence, bindings, report, manifestStore, deps, input,
    run: (overrides = {}) => runMigrationActivation(input, { ...deps, ...overrides }),
    coordinator,
  };
}

function expectActivated(f: Fixture, outcome: MigrationActivationOutcome, resumedFrom: string): void {
  expect(outcome.status).toBe("activated");
  if (outcome.status !== "activated") return;
  expect(outcome.resumedFrom).toBe(resumedFrom);
  expect(outcome.identity).toEqual({ generationId: GENERATION, publicationId: f.publicationId, manifestRevision: expect.any(Number) });
  expect(outcome.report.kind).toBe("activation");
  const manifest = f.manifestStore.read(GENERATION);
  expect(manifest.phase).toBe("active");
  expect(manifest.pendingEffect).toBeNull();
  expect(manifest.reports.some((r) => r.kind === "activation" && r.reportSha256 === outcome.report.reportSha256)).toBe(true);
  const config = JSON.parse(readFileSync(join(lcmHomeDir(f.homeDir), "config.json"), "utf8")) as { storage: { backend: string } };
  expect(config.storage.backend).toBe("postgresql");
  const map = JSON.parse(readFileSync(projectMapPath(f.homeDir), "utf8")) as Record<string, { remoteProjectId?: string }>;
  expect(map[f.localProjectId]!.remoteProjectId).toBe(REMOTE);
  expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("completed");
  expect(readBackendMaintenanceJournal(f.homeDir)).toBeNull();
  const link = readActivationGenerationLink({ homeDir: f.homeDir, generationId: GENERATION });
  expect(link).toMatchObject({ state: "resolved", link: { publicationId: f.publicationId } });
  expect(f.evidence.epochs.size).toBe(1);
  expect(f.evidence.witnesses.size).toBeGreaterThanOrEqual(1);
  expect(f.bindings.resolveMigrationWitnessBindings({ homeDir: f.homeDir, generationId: GENERATION })).toMatchObject({ state: "resolved" });
  expect(readdirSync(migrationActivationReportDirectory(f.homeDir, GENERATION))).toHaveLength(1);
}


describe("runMigrationActivation: fresh activation end to end", () => {
  it("activates a verified generation: artifact -> link -> evidence -> selection -> binding -> publication -> report -> active", async () => {
    const f = await fixture();
    const outcome = await f.run();
    expectActivated(f, outcome, "fresh");
    if (outcome.status !== "activated") return;
    expect(outcome.successorFencingToken).toBeNull();
    expect(outcome.restart.status).toBe("satisfied");
    // The lease was acquired by S2, reused by the coordinator (same generation) and released by S13's release phase.
    expect(f.guard.calls.filter((c) => c === "acquire").length).toBeGreaterThanOrEqual(1);
    expect([...f.guard.rows.values()][0]!.releasedAt).not.toBeNull();
    // The link carries the verified manifest pair frozen before S9.
    const link = readActivationGenerationLink({ homeDir: f.homeDir, generationId: GENERATION });
    expect(link).toMatchObject({ state: "resolved", link: { epochManifestRevision: 8 } });
    expect(statSync(activationGenerationLinkPath(f.homeDir, GENERATION)).mode & 0o777).toBe(0o600);
  });

  it("returns activated from durable state on a second call (settled active), without driving anything", async () => {
    const f = await fixture();
    const first = await f.run();
    expect(first.status).toBe("activated");
    const compose = vi.fn(f.deps.composeMaterial);
    const second = await f.run({ composeMaterial: compose, createCoordinator: () => { throw new Error("must not construct a coordinator"); } });
    expect(second).toMatchObject({ status: "activated", resumedFrom: "settled-active", identity: { publicationId: f.publicationId } });
    expect(compose).not.toHaveBeenCalled();
    if (first.status === "activated" && second.status === "activated") expect(second.report).toEqual(first.report);
  });

  it("settled active with the stored report removed is interrupted report-unresolvable at S16 with reportStored no", async () => {
    const f = await fixture();
    await f.run();
    rmSync(migrationActivationReportDirectory(f.homeDir, GENERATION), { recursive: true });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "interrupted", step: "S16", cause: "report-unresolvable", reportStored: "no", applied: "yes", effectBegun: true });
  });
});

describe("runMigrationActivation: refusals (no effect begun)", () => {
  it("refuses manifest-absent for an unknown generation", async () => {
    const f = await fixture();
    const outcome = await runMigrationActivation({ ...f.input, generationId: "generation-9" }, f.deps);
    expect(outcome).toMatchObject({ status: "refused", step: "S0", reason: "manifest-absent", effectBegun: false });
  });

  it("refuses maintenance-not-held when no maintenance journal is held", async () => {
    const f = await fixture({ held: false });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held" });
    expect(f.manifestStore.read(GENERATION).phase).toBe("verified");
  });

  it("refuses lease-conflict when another publication actively holds the project's lease", async () => {
    const f = await fixture();
    f.guard.seed({ projectId: REMOTE, publicationId: "someone-else" });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S2", reason: "lease-conflict" });
  });

  it("refuses quiescence-unsatisfied through the real quiescence check when the roster does not cover this machine", async () => {
    const f = await fixture({ rosterMachine: "018f0b5d-1234-7abc-8def-000000000099" });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S3", reason: "quiescence-unsatisfied" });
  });

  it("refuses uncovered-projects (G8) through the real coverage enumeration when another project holds data", async () => {
    const f = await fixture({ extraProjectWithData: true });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S4", reason: "uncovered-projects" });
    expect((outcome as { detail: string }).detail).toContain(HASH_B);
  });

  it("refuses identity-drift at S0 when the live destination identity differs from the sealed manifest", async () => {
    const f = await fixture();
    f.deps.identity.sealedWitnessSha256 = "f".repeat(64);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S0", reason: "identity-drift" });
  });

  it("refuses verification-unresolvable at S0 when the copy binding cannot be read back", async () => {
    const f = await fixture();
    f.deps.transferRows.splice(0);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S0", reason: "verification-unresolvable" });
    expect((outcome as { detail: string }).detail).toContain("no-run");
  });

  it("refuses project-map-drift at S5 when the map is bound to another remote", async () => {
    const f = await fixture();
    const map = JSON.parse(readFileSync(projectMapPath(f.homeDir), "utf8")) as Record<string, Record<string, unknown>>;
    map[f.localProjectId]!.remoteProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9099";
    writeFileSync(projectMapPath(f.homeDir), JSON.stringify(map) + "\n", { mode: 0o600 });
    clearProjectMapCache();
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S5", reason: "project-map-drift" });
  });

  it.each([
    ["unhealthy", "target-unhealthy"],
    ["unresolvable", "target-unresolvable"],
  ] as const)("refuses %s target health at S6", async (status, reason) => {
    const f = await fixture();
    f.deps.health.push({ status, reason: status === "unhealthy" ? "schema-mismatch" : "connection-failed", detail: "fake", sqlState: null } as MigrationTargetHealthResult);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S6", reason });
    expect(f.manifestStore.read(GENERATION).phase).toBe("verified");
    // Ordinary refusal after coverage: no link, no artifact; a later rerun succeeds (amendment 1).
    expect(readActivationGenerationLink({ homeDir: f.homeDir, generationId: GENERATION }).state).toBe("authoritatively-absent");
    expectActivated(f, await f.run(), "fresh");
  });

  it("refuses census-drift at S8 when the recomputed census differs from the report", async () => {
    const f = await fixture();
    f.deps.destinationCensus = domainCensus("drifted");
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S8", reason: "census-drift" });
  });

  it("S6 admits the activation role through the transfer verifier (plan-v7.2 B2): a transfer-profile refusal is target-unhealthy before any effect", async () => {
    const f = await fixture();
    const executors: unknown[] = [];
    const outcome = await f.run({
      checkTargetHealth: checkMigrationTargetHealth,
      verifyTransferSchema: async (executor) => { executors.push(executor); throw new PostgreSqlRuntimeReadinessError("acl-shape", "inspectSchemaAcl"); },
    });
    expect(outcome).toMatchObject({ status: "refused", step: "S6", reason: "target-unhealthy", effectBegun: false });
    if (outcome.status !== "refused") return;
    expect(outcome.detail).toContain("schema-mismatch");
    expect(outcome.detail).toContain("acl-shape");
    // Exactly one admission ran, on the ordinary runtime (the one with the lease guard), not on a transfer runtime.
    expect(executors).toHaveLength(1);
    expect((executors[0] as MigrationActivationOrdinaryRuntime).backendPublicationGuard).toBeTypeOf("function");
    expect(f.manifestStore.read(GENERATION).phase).toBe("verified");
    expect(readActivationGenerationLink({ homeDir: f.homeDir, generationId: GENERATION }).state).toBe("authoritatively-absent");
  });
});


/** Run once with a crash injected at the named point, assert it threw, then
 * run again cleanly and assert the activation converges. */
async function crashThenResume(f: Fixture, point: string, expectResumedFrom: string, between?: () => void) {
  const crashPoint = (observed: string): void => { if (observed === point) throw new Error("injected crash at " + point); };
  await expect(f.run({ crashPoint })).rejects.toThrow("injected crash at " + point);
  between?.();
  const outcome = await f.run();
  expectActivated(f, outcome, expectResumedFrom);
  return outcome;
}

describe("runMigrationActivation: crash rows (plan-v5 section 7 / synthesis amendments), resumed by the same entry point", () => {
  it("S9 begun: prepare-activation pending -> retry-idempotent complete, then the rest", async () => {
    const f = await fixture();
    await crashThenResume(f, "after-prepare-begin", "prepare-activation-pending");
  });

  it("S9 complete, S10 not begun: activating with no pending effect -> re-begin publish-activation", async () => {
    const f = await fixture();
    await crashThenResume(f, "after-prepare-complete", "activating-no-effect");
  });

  it("S10 begun, nothing durable yet: recompose from the verified manifest lineage (no link, no artifact)", async () => {
    const f = await fixture();
    const outcome = await crashThenResume(f, "after-publish-begin", "publish-pending-before-artifact", () => {
      expect(readActivationGenerationLink({ homeDir: f.homeDir, generationId: GENERATION }).state).toBe("authoritatively-absent");
      expect(f.manifestStore.read(GENERATION)).toMatchObject({ phase: "activating", pendingEffect: { kind: "publish-activation" } });
    });
    // The pair came from the lineage walk, not the activating head.
    const link = readActivationGenerationLink({ homeDir: f.homeDir, generationId: GENERATION });
    expect(link).toMatchObject({ state: "resolved", link: { epochManifestRevision: 8 } });
    void outcome;
  });

  it("orphan artifact (crash after the artifact, before the link): reused byte-identically, never recomposed into a second artifact", async () => {
    const f = await fixture();
    const publishArtifact = vi.fn(f.deps.publishArtifact);
    await expect(f.run({ crashPoint: (p) => { if (p === "after-artifact") throw new Error("boom"); } })).rejects.toThrow("boom");
    expect(readActivationGenerationLink({ homeDir: f.homeDir, generationId: GENERATION }).state).toBe("authoritatively-absent");
    const outcome = await f.run({ publishArtifact });
    expectActivated(f, outcome, "publish-pending-before-artifact");
    expect(publishArtifact).not.toHaveBeenCalled();
    expect(readdirSync(join(lcmHomeDir(f.homeDir), "migration-activation-material")).filter((n) => n.endsWith(".material"))).toHaveLength(1);
  });

  it("link written, evidence not: everything comes from link + artifact (compose never called)", async () => {
    const f = await fixture();
    const composeMaterial = vi.fn(f.deps.composeMaterial);
    await expect(f.run({ crashPoint: (p) => { if (p === "after-link") throw new Error("boom"); } })).rejects.toThrow("boom");
    const outcome = await f.run({ composeMaterial });
    expectActivated(f, outcome, "publish-pending-after-link");
    expect(composeMaterial).not.toHaveBeenCalled();
  });

  it.each(["after-epoch", "after-attempt", "after-witness", "after-witness-binding"])(
    "witnessed but unpublished (crash %s): with an unchanged observation the evidence is reused byte-identically",
    async (point) => {
      const f = await fixture();
      await crashThenResume(f, point, "publish-pending-after-link");
      expect(f.evidence.epochs.size).toBe(1);
      expect(f.evidence.attempts.size).toBe(1);
    },
  );

  it("witnessed but unpublished with a moving clock: the pre-selection re-entry mints a NEW attempt (every attempt is recorded) and the selection carries the latest witness", async () => {
    const f = await fixture();
    let tick = 0;
    const now = () => new Date(Date.parse("2026-10-16T13:00:00.000Z") + (tick++) * 1000);
    const input = { ...f.input, now };
    await expect(runMigrationActivation(input, { ...f.deps, crashPoint: (p) => { if (p === "after-witness-binding") throw new Error("boom"); } })).rejects.toThrow("boom");
    const outcome = await runMigrationActivation(input, f.deps);
    expectActivated(f, outcome, "publish-pending-after-link");
    expect(f.evidence.epochs.size).toBe(1);
    expect(f.evidence.attempts.size).toBe(2);
    const bindings = f.bindings.resolveMigrationWitnessBindings({ homeDir: f.homeDir, generationId: GENERATION });
    expect(bindings.state).toBe("resolved");
    if (bindings.state !== "resolved") return;
    expect(bindings.witnesses).toHaveLength(2);
    expect([...f.evidence.witnesses.keys()]).toContain(bindings.selections[0]!.witnessChecksumSha256);
  });

  it("S12 selection-prepared: finish the selection, then S13a", async () => {
    const f = await fixture();
    await crashThenResume(f, "after-selection-prepared", "selection-prepared", () => {
      expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("selection-prepared");
    });
    expect(f.evidence.attempts.size).toBe(1);
  });

  it("S12 selection-completed without a binding: S13a before any prepare()", async () => {
    const f = await fixture();
    const prepare = vi.fn();
    await crashThenResume(f, "after-selection-completed", "selection-completed-unbound", () => {
      expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("selection-completed");
      expect(f.bindings.resolveMigrationWitnessBindings({ homeDir: f.homeDir, generationId: GENERATION })).toMatchObject({ state: "resolved", selections: [] });
    });
    void prepare;
  });

  it("S13a binding written, drive not run: reuse the binding and drive", async () => {
    const f = await fixture();
    await crashThenResume(f, "after-selection-binding", "selection-completed-unbound");
  });

  it("S13b mid-publication (coordinator crash at config-published): the drive resumes the version-2 journal", async () => {
    const f = await fixture();
    let crashed = false;
    const crashing = f.coordinator((event) => {
      if (crashed || event !== "after-journal-write") return;
      if (readBackendPublicationJournal(f.homeDir)?.phase === "config-published") { crashed = true; throw new Error("injected coordinator crash"); }
    });
    await expect(f.run({ createCoordinator: () => crashing })).rejects.toThrow("injected coordinator crash");
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("config-published");
    const outcome = await f.run();
    expectActivated(f, outcome, "publication-journal");
  });

  it("S13b complete, S15/S16 not run: the completed journal is reported, no second drive, then S15/S16", async () => {
    const f = await fixture();
    const outcome = await crashThenResume(f, "after-drive", "publication-journal", () => {
      expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("completed");
      expect(f.manifestStore.read(GENERATION).phase).toBe("activating");
    });
    void outcome;
  });

  it("S16 report written, effect not completed: the stored report is reused byte-identically", async () => {
    const f = await fixture();
    const persistReport = vi.fn(f.deps.persistReport);
    await expect(f.run({ crashPoint: (p) => { if (p === "after-report") throw new Error("boom"); } })).rejects.toThrow("boom");
    expect(readdirSync(migrationActivationReportDirectory(f.homeDir, GENERATION))).toHaveLength(1);
    const outcome = await f.run({ persistReport });
    expectActivated(f, outcome, "publication-journal");
    expect(persistReport).toHaveBeenCalledTimes(1);
    expect(persistReport.mock.results[0]!.value).toMatchObject({ outcome: "reused" });
  });
});

describe("runMigrationActivation: lease continuation (A2)", () => {
  it("renews after S7, before S12 and before S13b", async () => {
    const f = await fixture();
    await f.run();
    expect(f.guard.calls.filter((c) => c === "renew").length).toBeGreaterThanOrEqual(3);
  });

  it("an expired lease before S12 is taken over and mints a NEW attempt recorded before the selection", async () => {
    const f = await fixture();
    let renews = 0;
    const renew = f.guard.renew.bind(f.guard);
    f.guard.renew = async (input) => {
      renews += 1;
      if (renews === 2) f.guard.expire(input.projectId); // the renew before S12
      return renew(input);
    };
    const outcome = await f.run();
    expectActivated(f, outcome, "fresh");
    expect(f.evidence.attempts.size).toBe(2);
    expect(f.evidence.witnesses.size).toBe(2);
    // The selection carries the second attempt's witness.
    const selection = f.bindings.resolveMigrationWitnessBindings({ homeDir: f.homeDir, generationId: GENERATION });
    expect(selection).toMatchObject({ state: "resolved" });
  });

  it("an expired lease after the selection is taken over without a new attempt and reports successorFencingToken", async () => {
    const f = await fixture();
    await expect(f.run({ crashPoint: (p) => { if (p === "after-selection-binding") throw new Error("boom"); } })).rejects.toThrow("boom");
    f.guard.expire(REMOTE);
    const before = [...f.guard.rows.values()][0]!.fencingToken;
    const outcome = await f.run();
    expectActivated(f, outcome, "selection-completed-unbound");
    if (outcome.status !== "activated") return;
    expect(outcome.successorFencingToken).not.toBeNull();
    expect(BigInt(outcome.successorFencingToken!)).toBeGreaterThan(before);
    expect(f.evidence.attempts.size).toBe(1);
  });

  it("a released lease after the selection is interrupted lease-lost at S13b", async () => {
    const f = await fixture();
    await expect(f.run({ crashPoint: (p) => { if (p === "after-selection-binding") throw new Error("boom"); } })).rejects.toThrow("boom");
    const row = [...f.guard.rows.values()][0]!;
    f.guard.rows.set(REMOTE, { ...row, releasedAt: "2026-10-16T13:00:00.000Z" });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost", effectBegun: true, applied: "no" });
  });
});


/** Stop the fixture at a durable point by crashing there, so a later test can
 * poke at the state the next call will classify. */
async function stopAt(f: Fixture, point: string): Promise<void> {
  await expect(f.run({ crashPoint: (p) => { if (p === point) throw new Error("stop at " + point); } })).rejects.toThrow("stop at " + point);
}

function namedError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("runMigrationActivation: classification refusals and interruptions", () => {
  it("refuses manifest-not-eligible for a generation that is still planned", async () => {
    const f = await fixture();
    f.manifestStore.create(createMigrationManifest({
      generationId: "generation-2", source: witness("sqlite", "2026-10-16T11:00:00.000Z"), destination: witness("postgresql", "2026-10-16T11:00:01.000Z"),
      parentGenerationId: null, preservedSourceGenerationId: "source-generation-2", createdAt: "2026-10-16T11:00:00.000Z",
    }));
    const outcome = await runMigrationActivation({ ...f.input, generationId: "generation-2" }, f.deps);
    expect(outcome).toMatchObject({ status: "refused", step: "S0", reason: "manifest-not-eligible" });
  });

  it("refuses manifest-not-eligible for a settled aborted generation and pending-effect-foreign for a pending abort", async () => {
    const f = await fixture();
    let manifest = f.manifestStore.read(GENERATION);
    manifest = f.manifestStore.update(GENERATION, manifest.checksumSha256, (m) => beginMigrationEffect(m, { effectId: "abort-1", kind: "abort", inputSha256: HASH_A, startedAt: "2026-10-16T12:59:00.000Z" }));
    expect(await f.run()).toMatchObject({ status: "refused", step: "S0", reason: "pending-effect-foreign" });
    f.manifestStore.update(GENERATION, manifest.checksumSha256, (m) => completeMigrationEffect(m, { effectId: "abort-1", completedAt: "2026-10-16T12:59:01.000Z", report: { kind: "abort", reportId: "abort-1", reportSha256: HASH_C, createdAt: "2026-10-16T12:59:01.000Z" } }));
    expect(await f.run()).toMatchObject({ status: "refused", step: "S0", reason: "manifest-not-eligible" });
  });

  it("refuses manifest-unresolvable when the manifest head is corrupt, and rethrows an unrecognized store error", async () => {
    const f = await fixture();
    const read = f.deps.manifestStore.read.bind(f.deps.manifestStore);
    const protocol = await import("../../src/migration/protocol.js");
    expect(await f.run({ manifestStore: { read: () => { throw new protocol.MigrationProtocolError("checksum-mismatch", "corrupt"); }, update: f.deps.manifestStore.update.bind(f.deps.manifestStore) } }))
      .toMatchObject({ status: "refused", step: "S0", reason: "manifest-unresolvable" });
    await expect(f.run({ manifestStore: { read: () => { throw new RangeError("raw"); }, update: f.deps.manifestStore.update.bind(f.deps.manifestStore) } })).rejects.toBeInstanceOf(RangeError);
    void read;
  });

  it("refuses verification-stale when the stored report is not eligible or does not match the reference, and verification-unresolvable when it cannot be read", async () => {
    const f = await fixture();
    const real = f.deps.readVerificationReport;
    expect(await f.run({ readVerificationReport: (g, sha) => ({ ...real(g, sha), activationEligible: false }) })).toMatchObject({ status: "refused", step: "S5", reason: "verification-stale" });
    expect(await f.run({ readVerificationReport: (g, sha) => ({ ...real(g, sha), reportId: "verify-generation-" + HASH_A }) })).toMatchObject({ status: "refused", step: "S5", reason: "verification-stale" });
    const { MigrationVerificationStoreError } = await import("../../src/migration/verification-store.js");
    expect(await f.run({ readVerificationReport: () => { throw new MigrationVerificationStoreError("absent", "gone"); } })).toMatchObject({ status: "refused", step: "S5", reason: "verification-unresolvable" });
    await expect(f.run({ readVerificationReport: () => { throw new RangeError("raw"); } })).rejects.toBeInstanceOf(RangeError);
  });

  it("refuses identity-drift when the live identity matches the manifest but not the report", async () => {
    const f = await fixture();
    const real = f.deps.readVerificationReport;
    const outcome = await f.run({ readVerificationReport: (g, sha) => { const r = real(g, sha); return { ...r, body: { ...r.body, destinationIdentity: { ...r.body.destinationIdentity, sealedWitnessSha256: "f".repeat(64) } } }; } });
    expect(outcome).toMatchObject({ status: "refused", step: "S0", reason: "identity-drift" });
  });

  it("refuses at S8 for a report whose classes did not all run or that records mismatches (injected past the parser)", async () => {
    const f = await fixture();
    const real = f.deps.readVerificationReport;
    expect(await f.run({ readVerificationReport: (g, sha) => { const r = real(g, sha); return { ...r, body: { ...r.body, classCoverage: r.body.classCoverage.map((e, i) => (i === 0 ? { ...e, ran: false } : e)) } }; } }))
      .toMatchObject({ status: "refused", step: "S8", reason: "class-coverage-incomplete" });
    expect(await f.run({ readVerificationReport: (g, sha) => ({ ...real(g, sha), mismatchTotals: [{ class: "missing", count: 1 } as never] }) }))
      .toMatchObject({ status: "refused", step: "S8", reason: "verification-mismatch" });
  });

  it("refuses maintenance-unresolvable / quiescence-unresolvable / coverage refusals through injected checks", async () => {
    const f = await fixture();
    expect(await f.run({ checkQuiescence: async () => ({ status: "unresolvable", reason: "maintenance-journal-unresolvable", detail: "x", quiescenceFence: null }) })).toMatchObject({ status: "refused", step: "S3", reason: "maintenance-unresolvable" });
    expect(await f.run({ checkQuiescence: async () => ({ status: "unresolvable", reason: "machine-identity-unavailable", detail: "x", quiescenceFence: null }) })).toMatchObject({ status: "refused", step: "S3", reason: "quiescence-unresolvable" });
    expect(await f.run({ checkCoverage: () => ({ status: "unsatisfied", reason: "uncovered-project-directories", detail: "x", coveredProjectCount: 0, uncoveredProjectDirectories: [] }) })).toMatchObject({ status: "refused", step: "S4", reason: "coverage-unsatisfied" });
    expect(await f.run({ checkCoverage: () => ({ status: "unresolvable", reason: "projects-directory-unresolvable", detail: "x", coveredProjectCount: 0, uncoveredProjectDirectories: [] }) })).toMatchObject({ status: "refused", step: "S4", reason: "coverage-unresolvable" });
    expect(await f.run({ enumerateStoredData: () => ({ status: "unresolvable", reason: "events-directory-unresolvable", detail: "x" }) })).toMatchObject({ status: "refused", step: "S4", reason: "coverage-unresolvable" });
  });

  it("refuses maintenance-not-held through the real quiescence check when the journal is held for another generation", async () => {
    const f = await fixture({ held: false });
    await f.coordinator().enterMaintenance({ publicationId: "other-pub", generationId: "generation-9", sourceSelectionSha256: HASH_A, queueEvidenceSha256: HASH_B, roster: [{ machineId: MACHINE, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A }] });
    expect(await f.run()).toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held" });
  });

  it("a maintenance window entered from postgresql (a #626 rollback) is foreign: refused before any effect, interrupted journal-unexpected after one", async () => {
    const f = await fixture({ held: false });
    await f.coordinator().enterMaintenance({ publicationId: f.publicationId, generationId: GENERATION, sourceBackend: "postgresql", sourceSelectionSha256: HASH_A, queueEvidenceSha256: HASH_B, roster: [{ machineId: MACHINE, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A }] });
    expect(readBackendMaintenanceJournal(f.homeDir)).toMatchObject({ phase: "maintenance-held", sourceBackend: "postgresql" });
    expect(await f.run()).toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held", effectBegun: false, detail: expect.stringContaining("entered from postgresql") });
    expect(f.manifestStore.read(GENERATION).phase).toBe("verified");
    // After the effect began (link recorded), the same window is an interruption whose applied column cannot be read from a rollback's journal.
    const g = await fixture();
    await stopAt(g, "after-link");
    const read = g.deps.readMaintenanceJournal;
    const foreign: MigrationActivationDependencies["readMaintenanceJournal"] = (h) => { const j = read(h); return j === null ? null : { ...j, sourceBackend: "postgresql" }; };
    expect(await g.run({ readMaintenanceJournal: foreign })).toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", effectBegun: true, applied: "unknown", detail: expect.stringContaining("rollback window") });
    // S12 re-reads the journal before selecting: a window that turned foreign in between is journal-unexpected too.
    const h = await fixture();
    let reads = 0;
    const read3 = h.deps.readMaintenanceJournal;
    expect(await h.run({ readMaintenanceJournal: (home) => { reads += 1; const j = read3(home); return reads === 2 && j !== null ? { ...j, sourceBackend: "postgresql" } : j; } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("rollback window") });
  });

  it("maps a project-map read failure to state-unresolvable (pre) and rethrows a non-witness error", async () => {
    const f = await fixture();
    const { MigrationProjectMapWitnessError } = await import("../../src/migration/project-map-witness.js");
    expect(await f.run({ computeProjectMapWitness: () => { throw new MigrationProjectMapWitnessError("project-map-unresolvable", "x"); } })).toMatchObject({ status: "refused", step: "S5", reason: "state-unresolvable" });
    await expect(f.run({ computeProjectMapWitness: () => { throw new RangeError("raw"); } })).rejects.toBeInstanceOf(RangeError);
  });

  it("refuses identity-drift at S7 when the destination identity changes between S0 and the census snapshot", async () => {
    const f = await fixture();
    let calls = 0;
    const outcome = await f.run({ captureDestinationIdentity: async () => ({ version: 1, sealedWitnessSha256: DEST_IDENTITY, systemIdentifier: calls++ < 2 ? SYSTEM_ID : "999" }) });
    expect(outcome).toMatchObject({ status: "refused", step: "S7", reason: "identity-drift" });
  });

  it("lets a census session close failure surface (never swallowed)", async () => {
    const f = await fixture();
    const transfer = f.deps.createTransferRuntime;
    await expect(f.run({ createTransferRuntime: (settings) => {
      const runtime = transfer(settings);
      return { ...runtime, openReadOnlySnapshot: async () => ({ query: runtime.query, close: async () => { throw new Error("close failed"); } }) };
    } })).rejects.toThrow("close failed");
  });

  it("S2: takes over an expired same-generation lease, refuses conflicts and unresolvable acquisitions", async () => {
    const f = await fixture();
    f.guard.seed({ projectId: REMOTE, publicationId: f.publicationId, databaseExpired: true });
    expectActivated(f, await f.run(), "fresh");
    const g = await fixture();
    g.guard.acquire = async (input) => { throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "readback-mismatch"); };
    expect(await g.run()).toMatchObject({ status: "refused", step: "S2", reason: "lease-unresolvable" });
    const h = await fixture();
    h.guard.seed({ projectId: REMOTE, publicationId: h.publicationId, databaseExpired: true });
    const acquire = h.guard.acquire.bind(h.guard);
    h.guard.acquire = async (input) => {
      if (input.expectedFencingToken !== undefined) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "publication-conflict");
      return acquire(input);
    };
    expect(await h.run()).toMatchObject({ status: "refused", step: "S2", reason: "lease-conflict" });
    const i = await fixture();
    i.guard.seed({ projectId: REMOTE, publicationId: i.publicationId, databaseExpired: true });
    const acquire2 = i.guard.acquire.bind(i.guard);
    i.guard.acquire = async (input) => {
      if (input.expectedFencingToken !== undefined) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "readback-mismatch");
      return acquire2(input);
    };
    expect(await i.run()).toMatchObject({ status: "refused", step: "S2", reason: "lease-unresolvable" });
    const j = await fixture();
    j.guard.seed({ projectId: REMOTE, publicationId: j.publicationId, databaseExpired: true });
    const read = j.guard.read.bind(j.guard);
    let reads = 0;
    j.guard.read = async (input) => (reads++ === 0 ? null : read(input));
    expect(await j.run()).toMatchObject({ status: "refused", step: "S2", reason: "lease-unresolvable" });
  });

  it("renew after S7: a stale caller token is renewed with the returned token; a vanished row refuses lease-conflict; an ambiguous renew refuses lease-unresolvable", async () => {
    const f = await fixture();
    const renew = f.guard.renew.bind(f.guard);
    let first = true;
    f.guard.renew = async (input) => {
      if (first) { first = false; const row = f.guard.rows.get(input.projectId)!; f.guard.rows.set(input.projectId, { ...row, fencingToken: row.fencingToken + 5n }); }
      return renew(input);
    };
    expectActivated(f, await f.run(), "fresh");
    const g = await fixture();
    g.guard.renew = async (input) => { g.guard.rows.delete(input.projectId); throw new PostgreSqlBackendPublicationGuardError(input.projectId, "renew", "fence-mismatch"); };
    expect(await g.run()).toMatchObject({ status: "refused", step: "S8", reason: "lease-conflict" });
    const h = await fixture();
    // fence-mismatch with an unchanged row: an unattributable race, reported unresolvable.
    h.guard.renew = async (input) => { throw new PostgreSqlBackendPublicationGuardError(input.projectId, "renew", "fence-mismatch"); };
    expect(await h.run()).toMatchObject({ status: "refused", step: "S8", reason: "lease-unresolvable" });
  });

  it("renew before S12: an expired lease whose takeover conflicts is interrupted lease-lost; an ambiguous one lease-unresolvable", async () => {
    const f = await fixture();
    let renews = 0;
    const renew = f.guard.renew.bind(f.guard);
    const acquire = f.guard.acquire.bind(f.guard);
    f.guard.renew = async (input) => { if (++renews === 2) f.guard.expire(input.projectId); return renew(input); };
    f.guard.acquire = async (input) => { if (input.expectedFencingToken !== undefined) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "publication-conflict"); return acquire(input); };
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "lease-lost", effectBegun: true, applied: "no" });
    const g = await fixture();
    let renews2 = 0;
    const renew2 = g.guard.renew.bind(g.guard);
    const acquire2 = g.guard.acquire.bind(g.guard);
    g.guard.renew = async (input) => { if (++renews2 === 2) g.guard.expire(input.projectId); return renew2(input); };
    g.guard.acquire = async (input) => { if (input.expectedFencingToken !== undefined) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "readback-mismatch"); return acquire2(input); };
    expect(await g.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "lease-unresolvable" });
  });

  it("post-selection: a successor whose token regressed, an unresolvable continuation, and a vanished row are interrupted at S13b", async () => {
    const f = await fixture();
    await stopAt(f, "after-selection-binding");
    const row = [...f.guard.rows.values()][0]!;
    f.guard.rows.set(REMOTE, { ...row, databaseExpired: true });
    const acquire = f.guard.acquire.bind(f.guard);
    f.guard.acquire = async (input) => ({ ...(await acquire(input)), fencingToken: 0n });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost" });
    const g = await fixture();
    await stopAt(g, "after-selection-binding");
    g.guard.renew = async (input) => { throw new PostgreSqlBackendPublicationGuardError(input.projectId, "renew", "fence-mismatch"); };
    expect(await g.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-unresolvable" });
  });

  it("re-entry after a selection with the lease row gone is interrupted lease-lost, unless the publication already completed", async () => {
    const f = await fixture();
    await stopAt(f, "after-selection-completed");
    f.guard.rows.clear();
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost" });
    const g = await fixture();
    await stopAt(g, "after-drive");
    g.guard.rows.clear();
    expectActivated(g, await g.run(), "publication-journal");
  });

  it("publication-failed carries the drive result and the identity", async () => {
    const f = await fixture();
    const outcome = await f.run({ drive: async () => ({ status: "aborted", detail: "injected", journal: null, fenceChecks: [], dispatch: "terminal-report" }) });
    expect(outcome).toMatchObject({ status: "publication-failed", publication: { status: "aborted" }, identity: { generationId: GENERATION, publicationId: f.publicationId } });
    expect(f.manifestStore.read(GENERATION).phase).toBe("activating");
  });

  it("post-publication-unhealthy at S15 keeps the new selection, returns the restart verdict and applied yes on re-entry", async () => {
    const f = await fixture();
    f.deps.health.push({ status: "healthy", readiness: READINESS });
    f.deps.health.push({ status: "unhealthy", reason: "schema-mismatch", detail: "fake", sqlState: null });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "post-publication-unhealthy", health: { status: "unhealthy" }, restart: { status: "satisfied" }, identity: { publicationId: f.publicationId } });
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("completed");
    expect(f.manifestStore.read(GENERATION).phase).toBe("activating");
    // The next call rolls forward through S15/S16 (I2: no automatic reversal).
    expectActivated(f, await f.run(), "publication-journal");
  });

  it("S15 admits through the transfer verifier too (plan-v7.2 B2): a transfer-profile refusal after publication is post-publication-unhealthy", async () => {
    const f = await fixture();
    let admissions = 0;
    const outcome = await f.run({
      checkTargetHealth: checkMigrationTargetHealth,
      // Admission 1 is S6, admission 2 is S7's own transfer schema check, admission 3 is S15.
      verifyTransferSchema: async () => {
        admissions += 1;
        if (admissions === 3) throw new PostgreSqlRuntimeReadinessError("effective-privilege", "inspectEffectivePrivileges");
        return READINESS;
      },
    });
    expect(admissions).toBe(3);
    expect(outcome).toMatchObject({
      status: "post-publication-unhealthy",
      health: { status: "unhealthy", reason: "schema-mismatch", detail: expect.stringContaining("effective-privilege") },
      restart: { status: "satisfied" },
      identity: { publicationId: f.publicationId },
    });
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("completed");
    expect(f.manifestStore.read(GENERATION).phase).toBe("activating");
    expectActivated(f, await f.run(), "publication-journal");
  });

  it("S11 interruptions: artifact digest mismatch, link conflict, artifact mismatch / unresolvable from the store", async () => {
    const f = await fixture();
    const publishArtifact = f.deps.publishArtifact;
    expect(await f.run({ publishArtifact: (i, d) => ({ ...publishArtifact(i, d), identityDigest: "0".repeat(64) }) })).toMatchObject({ status: "interrupted", step: "S11", cause: "artifact-identity-mismatch", applied: "no" });
    const g = await fixture();
    const { ActivationGenerationLinkConflictError, ActivationArtifactIdentityMismatchError, ActivationArtifactPresenceUnresolvableError } = await import("../../src/migration/activation-artifact-store.js");
    expect(await g.run({ recordLink: () => { throw new ActivationGenerationLinkConflictError("x"); } })).toMatchObject({ status: "interrupted", step: "S11", cause: "link-conflict" });
    const h = await fixture();
    expect(await h.run({ publishArtifact: () => { throw new ActivationArtifactIdentityMismatchError("x"); } })).toMatchObject({ status: "interrupted", step: "S11", cause: "artifact-identity-mismatch" });
    const i = await fixture();
    expect(await i.run({ publishArtifact: () => { throw new ActivationArtifactPresenceUnresolvableError("x"); } })).toMatchObject({ status: "interrupted", step: "S11", cause: "artifact-unresolvable" });
    const j = await fixture();
    await expect(j.run({ publishArtifact: () => { throw new RangeError("raw"); } })).rejects.toBeInstanceOf(RangeError);
  });

  it("S11 evidence interruptions: refusals and binding errors from the evidence and binding seams", async () => {
    const f = await fixture();
    f.evidence.failNext = "epoch";
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S11", cause: "evidence-unresolvable" });
    const g = await fixture();
    expect(await g.run({ evidence: { ...g.evidence, recordMigrationActivationAttempt: () => { throw namedError("MigrationBindingConflictError"); } } })).toMatchObject({ status: "interrupted", step: "S11", cause: "evidence-conflict" });
    const h = await fixture();
    expect(await h.run({ evidence: { ...h.evidence, recordMigrationActivationWitness: () => { throw namedError("MigrationBindingUnresolvableError"); } } })).toMatchObject({ status: "interrupted", step: "S11", cause: "evidence-unresolvable" });
    const i = await fixture();
    expect(await i.run({ evidence: { ...i.evidence, recordMigrationActivationWitness() { throw new MigrationActivationEvidenceRefusalError("witness-does-not-reproduce", "x"); } } })).toMatchObject({ status: "interrupted", step: "S11", cause: "evidence-conflict" });
    // A refusal recognised only by name is not the store's error: it escapes untyped.
    const n = await fixture();
    await expect(n.run({ evidence: { ...n.evidence, recordMigrationActivationWitness() { throw Object.assign(namedError("MigrationActivationEvidenceRefusalError"), { reason: "witness-does-not-reproduce" }); } } })).rejects.toMatchObject({ name: "MigrationActivationEvidenceRefusalError" });
    // The real store's own ordering refusal: an attempt whose epoch was never written.
    const o = await fixture();
    expect(await o.run({ evidence: { ...o.evidence, recordMigrationActivationEpoch: () => undefined } })).toMatchObject({ status: "interrupted", step: "S11", cause: "evidence-conflict", detail: expect.stringContaining("is not stored for this generation") });
    const j = await fixture();
    await expect(j.run({ evidence: { ...j.evidence, recordMigrationActivationEpoch: () => { throw new RangeError("raw"); } } })).rejects.toBeInstanceOf(RangeError);
    const k = await fixture();
    expect(await k.run({ bindings: { ...k.bindings, recordMigrationWitnessBinding: () => { throw namedError("MigrationBindingConflictError"); } } })).toMatchObject({ status: "interrupted", step: "S11", cause: "binding-conflict" });
    const l = await fixture();
    expect(await l.run({ bindings: { ...l.bindings, recordMigrationWitnessBinding: () => { throw namedError("MigrationBindingUnresolvableError"); } } })).toMatchObject({ status: "interrupted", step: "S11", cause: "binding-unresolvable" });
    const m = await fixture();
    await expect(m.run({ bindings: { ...m.bindings, recordMigrationWitnessBinding: () => { throw new RangeError("raw"); } } })).rejects.toBeInstanceOf(RangeError);
  });

  it("S13a binding interruptions", async () => {
    const f = await fixture();
    expect(await f.run({ bindings: { ...f.bindings, recordMigrationSelectionBinding: () => { throw namedError("MigrationBindingConflictError"); } } })).toMatchObject({ status: "interrupted", step: "S13a", cause: "binding-conflict", applied: "no" });
    const g = await fixture();
    expect(await g.run({ bindings: { ...g.bindings, recordMigrationSelectionBinding: () => { throw namedError("MigrationBindingUnresolvableError"); } } })).toMatchObject({ status: "interrupted", step: "S13a", cause: "binding-unresolvable" });
    const h = await fixture();
    await expect(h.run({ bindings: { ...h.bindings, recordMigrationSelectionBinding: () => { throw new RangeError("raw"); } } })).rejects.toBeInstanceOf(RangeError);
  });

  it("S12 journal-unexpected: unreadable journal, foreign generation, a prepared selection carrying another witness, coordinator refusals, and a stuck phase", async () => {
    const f = await fixture();
    const readMaintenanceJournal = f.deps.readMaintenanceJournal;
    let reads = 0;
    expect(await f.run({ readMaintenanceJournal: (h) => { reads += 1; if (reads === 2) throw new Error("journal read failed"); return readMaintenanceJournal(h); } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected" });
    const g = await fixture();
    let reads2 = 0;
    const read2 = g.deps.readMaintenanceJournal;
    expect(await g.run({ readMaintenanceJournal: (h) => { reads2 += 1; const j = read2(h); return reads2 === 2 && j !== null ? { ...j, generationId: "generation-9" } : j; } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected" });
    const h = await fixture();
    await stopAt(h, "after-selection-prepared");
    expect(await h.run({ evidence: { ...h.evidence, readMigrationActivationEvidence: () => ({ state: "resolved", epochs: [...h.evidence.epochs.values()], attempts: [...h.evidence.attempts.values()], witnesses: [] }) } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable" });
    const i = await fixture();
    const coordinator = i.coordinator();
    expect(await i.run({ createCoordinator: () => ({ ...spyCoordinator(coordinator), prepareMaintenanceSelection: async () => { throw namedError("BackendPublicationJournalError", "stale"); } }) }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected" });
    const j = await fixture();
    const coordinator2 = j.coordinator();
    expect(await j.run({ createCoordinator: () => ({ ...spyCoordinator(coordinator2), completeMaintenanceSelection: async (input, token) => ({ ...(await coordinator2.completeMaintenanceSelection(input, token)), phase: "selection-prepared" as const }) }) }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected" });
    const k = await fixture();
    const coordinator3 = k.coordinator();
    await expect(k.run({ createCoordinator: () => ({ ...spyCoordinator(coordinator3), prepareMaintenanceSelection: async () => { throw new RangeError("raw"); } }) })).rejects.toBeInstanceOf(RangeError);
  });

  it("S12 re-entry: a selection-prepared journal whose witness checksum differs from the adopted attempt is journal-unexpected", async () => {
    const f = await fixture();
    await stopAt(f, "after-selection-prepared");
    const read = f.deps.readMaintenanceJournal;
    let reads = 0;
    const outcome = await f.run({ readMaintenanceJournal: (h) => { reads += 1; const j = read(h); return reads >= 2 && j !== null ? { ...j, terminalEvidenceSha256: "0".repeat(64) } : j; } });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected" });
  });
});

function spyCoordinator(real: BackendPublicationCoordinator) {
  return {
    recoverPending: (o: Parameters<BackendPublicationCoordinator["recoverPending"]>[0], t: Parameters<BackendPublicationCoordinator["recoverPending"]>[1]) => real.recoverPending(o, t),
    prepare: (i: Parameters<BackendPublicationCoordinator["prepare"]>[0], t: Parameters<BackendPublicationCoordinator["prepare"]>[1]) => real.prepare(i, t),
    resume: (t: Parameters<BackendPublicationCoordinator["resume"]>[0]) => real.resume(t),
    abort: (t: Parameters<BackendPublicationCoordinator["abort"]>[0]) => real.abort(t),
    prepareMaintenanceSelection: (i: Parameters<BackendPublicationCoordinator["prepareMaintenanceSelection"]>[0], t: Parameters<BackendPublicationCoordinator["prepareMaintenanceSelection"]>[1]) => real.prepareMaintenanceSelection(i, t),
    completeMaintenanceSelection: (i: Parameters<BackendPublicationCoordinator["completeMaintenanceSelection"]>[0], t: Parameters<BackendPublicationCoordinator["completeMaintenanceSelection"]>[1]) => real.completeMaintenanceSelection(i, t),
  };
}


// ---------------------------------------------------------------------------
// Phase-3 coverage: input validation, defaults, the #626 wiring point, the
// evidence classifiers, lineage, every S16 readback row, re-entry adoption
// rows and the preview.
// ---------------------------------------------------------------------------

function corruptLink(f: Fixture): void {
  mkdirSync(activationArtifactDirectory(f.homeDir), { recursive: true, mode: 0o700 });
  writeFileSync(activationGenerationLinkPath(f.homeDir, GENERATION), "{garbage\n", { mode: 0o600 });
}

function countedStore(f: Fixture, override: { readAt?: [number, (m: MigrationManifest) => MigrationManifest | never]; updateAt?: [number, () => never] }): MigrationActivationDependencies["manifestStore"] {
  const store = f.manifestStore;
  let reads = 0;
  let updates = 0;
  return {
    read: (id) => { const m = store.read(id); reads += 1; return override.readAt !== undefined && reads === override.readAt[0] ? override.readAt[1](m) : m; },
    update: (id, checksum, fn) => { updates += 1; if (override.updateAt !== undefined && updates === override.updateAt[0]) override.updateAt[1](); return store.update(id, checksum, fn); },
  };
}

/** Crash the real coordinator right after it journals the given version-2 phase. */
async function crashCoordinatorAt(f: Fixture, phase: string): Promise<void> {
  let crashed = false;
  const crashing = f.coordinator((event) => {
    if (crashed || event !== "after-journal-write") return;
    if (readBackendPublicationJournal(f.homeDir)?.phase === phase) { crashed = true; throw new Error("injected coordinator crash at " + phase); }
  });
  await expect(f.run({ createCoordinator: () => crashing })).rejects.toThrow("injected coordinator crash at " + phase);
  expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe(phase);
}

describe("runMigrationActivation: input validation, production defaults and the #626 wiring point", () => {
  it("rejects invalid input with MigrationActivationError invalid-input before touching anything", async () => {
    const f = await fixture();
    const identity = f.input.expectedIdentity;
    const bad: unknown[] = [
      null,
      { ...f.input, homeDir: "" },
      { ...f.input, generationId: "../x" },
      { ...f.input, transferSettings: null },
      { ...f.input, ordinarySettings: null },
      { ...f.input, expectedIdentity: null },
      { ...f.input, expectedIdentity: { ...identity, id: 1 } },
      { ...f.input, expectedIdentity: { ...identity, remoteProjectId: 1 } },
      { ...f.input, expectedIdentity: { ...identity, localProjectId: 1 } },
      { ...f.input, expectedIdentity: { ...identity, localProjectId: "nope" } },
      { ...f.input, expectedOwner: "" },
    ];
    for (const input of bad) {
      await expect(runMigrationActivation(input as MigrationActivationInput, f.deps)).rejects.toMatchObject({ name: "MigrationActivationError", reason: "invalid-input" });
    }
    await expect(previewMigrationActivation(undefined as never, f.deps)).rejects.toMatchObject({ name: "MigrationActivationError", reason: "invalid-input" });
    await expect(previewMigrationActivation({ homeDir: "", generationId: GENERATION }, f.deps)).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(previewMigrationActivation({ homeDir: f.homeDir, generationId: "" }, f.deps)).rejects.toMatchObject({ reason: "invalid-input" });
    expect(f.manifestStore.read(GENERATION).phase).toBe("verified");
  });

  it("uses the wall clock when no clock is injected", async () => {
    const f = await fixture();
    const { now: _ignored, ...input } = f.input;
    void _ignored;
    expectActivated(f, await runMigrationActivation(input, f.deps), "fresh");
  });

  it("production defaults wire the real #626 evidence store, binding resolver and census builders, and activate through them", async () => {
    const f = await fixture();
    const deps = createMigrationActivationDependencies({ homeDir: f.homeDir });
    expect(deps.evidence).toEqual({ recordMigrationActivationEpoch, recordMigrationActivationAttempt, recordMigrationActivationWitness, readMigrationActivationEvidence });
    expect(deps.bindings).toEqual({ recordMigrationWitnessBinding, recordMigrationSelectionBinding, resolveMigrationWitnessBindings });
    expect(deps.census).toEqual({ buildMigrationCensusVector, buildMigrationCanonicalDelta });
    expect(deps.census.buildMigrationCensusVector(f.deps.destinationCensus)).toEqual(f.report.body.censusVector);
    expect(deps.census.buildMigrationCanonicalDelta(f.deps.destinationCensus)).toEqual(f.report.body.canonicalDelta);
    const outcome = await f.run({ evidence: deps.evidence, bindings: deps.bindings, census: deps.census });
    expectActivated(f, outcome, "fresh");
    if (outcome.status !== "activated") return;
    const evidence = readMigrationActivationEvidence({ homeDir: f.homeDir, generationId: GENERATION });
    expect(evidence).toMatchObject({ state: "resolved", epochs: [expect.anything()], attempts: [expect.anything()], witnesses: [expect.anything()] });
    if (evidence.state !== "resolved") return;
    const stored = readMigrationActivationReport({ homeDir: f.homeDir, generationId: GENERATION, reportSha256: outcome.report.reportSha256 });
    expect(stored).toMatchObject({ state: "resolved", report: { body: { witnessChecksumSha256: evidence.witnesses[0]!.checksumSha256, epochId: evidence.epochs[0]!.epochId, attemptId: evidence.attempts[0]!.attemptId } } });
    const bindings = resolveMigrationWitnessBindings({ homeDir: f.homeDir, generationId: GENERATION });
    expect(bindings).toMatchObject({ state: "resolved", selections: [{ kind: "activation", publicationId: f.publicationId, witnessChecksumSha256: evidence.witnesses[0]!.checksumSha256 }], witnesses: [{ kind: "activation", witnessChecksumSha256: evidence.witnesses[0]!.checksumSha256 }] });
  });

  it("production defaults build the real boundaries: stores, runtimes, coordinator, machine identity and daemon port", async () => {
    const f = await fixture({ held: false });
    const deps = createMigrationActivationDependencies({ homeDir: f.homeDir });
    expect(deps.readVerificationReport(GENERATION, f.report.reportSha256).reportSha256).toBe(f.report.reportSha256);
    expect(deps.machineId(f.homeDir)).toBe(MACHINE);
    expect(deps.daemonPort(f.homeDir)).toBe(4321);
    expect(deps.computeProjectMapWitness({ homeDir: f.homeDir, localProjectId: f.localProjectId, remoteProjectId: REMOTE, mode: "pre-publication" })).toBe(f.report.body.projectMapWitnessSha256);
    const caFile = join(f.homeDir, "ca.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n", { mode: 0o600 });
    const settings = { ...SETTINGS, url: "postgresql://lcm:secret@db.example.invalid:5432/lcm", caFile };
    const ordinary = deps.createOrdinaryRuntime(settings);
    expect(ordinary.backendPublicationGuard()).toBeDefined();
    await ordinary.close();
    const transfer = deps.createTransferRuntime(settings);
    await transfer.close();
    const failing = { query: async () => { throw new RangeError("no database"); } } as unknown as MigrationActivationTransferRuntime;
    await expect(deps.verifyTransferSchema(failing, { expectedOwner: "lcm_migrator" })).rejects.toBeInstanceOf(Error);
    // S6/S15 reach checkMigrationTargetHealth itself (whose own default stays the runtime verifier; see target-health.test.ts).
    expect(deps.checkTargetHealth).toBe(checkMigrationTargetHealth);
    const session = { query: async () => { throw new RangeError("no database"); }, close: async () => undefined } as never;
    await expect(deps.readDestinationCensus(session, { settings, expectedOwner: "lcm_migrator", expectedIdentity: f.input.expectedIdentity, scratchParent: f.homeDir })).rejects.toBeInstanceOf(Error);
    const coordinator = deps.createCoordinator({ homeDir: f.homeDir, guard: f.guard, machineId: MACHINE });
    expect(coordinator.prepareMaintenanceSelection).toBeTypeOf("function");
    expect(deps.leaseTtlMs).toBe(15 * 60 * 1000);
  });
});

describe("runMigrationActivation: the restart verdict observes without daemon secrets and never throws (candidate round 1, S1)", () => {
  const satisfied: MigrationActivationDependencies["checkRestart"] = async () =>
    ({ status: "satisfied", reason: "no-pid-file", detail: "fake", pid: null, observedBackend: null, selectedBackend: "postgresql" });

  it("the production daemon port is the stored port, read without resolving storage secrets, at S15 and on settled re-entry after the publication selected postgresql", async () => {
    const f = await fixture();
    // The activation process receives its connection settings as arguments; it carries no daemon secrets.
    vi.stubEnv("LCM_POSTGRES_URL", undefined);
    vi.stubEnv("LCM_POSTGRES_CA_FILE", undefined);
    const production = createMigrationActivationDependencies({ homeDir: f.homeDir });
    const ports: number[] = [];
    const checkRestart: MigrationActivationDependencies["checkRestart"] = async (input) => { ports.push(input.port); return satisfied(input); };
    const first = await f.run({ daemonPort: production.daemonPort, checkRestart });
    expectActivated(f, first, "fresh");
    // The published selection is postgresql: the full daemon config now demands the daemon's secrets ...
    expect(() => readDaemonConfigSnapshot(configPath(f.homeDir), {})).toThrow(ConfigValidationError);
    // ... and the restart verdict's port read does not.
    expect(production.daemonPort(f.homeDir)).toBe(4321);
    const second = await f.run({ daemonPort: production.daemonPort, checkRestart });
    expect(second).toMatchObject({ status: "activated", resumedFrom: "settled-active", restart: { status: "satisfied" } });
    expect(ports).toEqual([4321, 4321]);
  });

  it("the production daemon port is the default when the stored config or its daemon section is absent, and a malformed config is a thrown ConfigValidationError for the verdict to map", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-activate-generation-port-"));
    roots.push(homeDir);
    mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
    const production = createMigrationActivationDependencies({ homeDir });
    expect(production.daemonPort(homeDir)).toBe(DEFAULT_DAEMON_PORT);
    writeFileSync(configPath(homeDir), JSON.stringify({ storage: { backend: "postgresql" } }) + "\n", { mode: 0o600 });
    expect(production.daemonPort(homeDir)).toBe(DEFAULT_DAEMON_PORT);
    writeFileSync(configPath(homeDir), JSON.stringify({ storage: { backend: "postgresql" }, daemon: {} }) + "\n", { mode: 0o600 });
    expect(production.daemonPort(homeDir)).toBe(DEFAULT_DAEMON_PORT);
    writeFileSync(configPath(homeDir), "{", { mode: 0o600 });
    expect(() => production.daemonPort(homeDir)).toThrow(ConfigValidationError);
  });

  it("S15: a stored config that cannot be read after the publication yields activated with the restart module's unresolvable / health-unreachable row, never a throw", async () => {
    const f = await fixture();
    const production = createMigrationActivationDependencies({ homeDir: f.homeDir });
    const outcome = await f.run({
      daemonPort: production.daemonPort,
      checkRestart: production.checkRestart,
      // The publication is durable; the config is then unreadable before S15 looks for the port.
      crashPoint: (point) => { if (point === "after-drive") writeFileSync(configPath(f.homeDir), "{", { mode: 0o600 }); },
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe("activated");
    if (outcome.status !== "activated") return;
    expect(outcome.resumedFrom).toBe("fresh");
    expect(outcome.restart).toEqual({
      status: "unresolvable",
      reason: "health-unreachable",
      detail: expect.stringContaining("malformed JSON"),
      pid: null,
      observedBackend: null,
      selectedBackend: "postgresql",
    });
    expect(outcome.restart.detail).toMatch(/^the restart check could not observe the daemon: /u);
    const manifest = f.manifestStore.read(GENERATION);
    expect(manifest.phase).toBe("active");
    expect(manifest.reports.some((r) => r.kind === "activation" && r.reportSha256 === outcome.report.reportSha256)).toBe(true);
  });

  it("S15: a restart probe that throws is the same unresolvable row on the post-publication-unhealthy outcome", async () => {
    const f = await fixture();
    f.deps.health.push({ status: "healthy", readiness: READINESS });
    f.deps.health.push({ status: "unhealthy", reason: "schema-mismatch", detail: "fake", sqlState: null });
    const outcome = await f.run({ checkRestart: async () => { throw new Error("probe failed"); } });
    expect(outcome).toMatchObject({
      status: "post-publication-unhealthy",
      health: { status: "unhealthy" },
      restart: { status: "unresolvable", reason: "health-unreachable", detail: "the restart check could not observe the daemon: probe failed" },
    });
  });

  it("settled active: a stored config that cannot be read yields activated from durable state with the unresolvable restart row and the same report", async () => {
    const f = await fixture();
    const production = createMigrationActivationDependencies({ homeDir: f.homeDir });
    const first = await f.run({ daemonPort: production.daemonPort });
    expectActivated(f, first, "fresh");
    if (first.status !== "activated") return;
    writeFileSync(configPath(f.homeDir), "{", { mode: 0o600 });
    const second = await f.run({ daemonPort: production.daemonPort, checkRestart: production.checkRestart });
    expect(second).toMatchObject({
      status: "activated",
      resumedFrom: "settled-active",
      report: first.report,
      restart: { status: "unresolvable", reason: "health-unreachable", detail: expect.stringContaining("malformed JSON"), pid: null, observedBackend: null, selectedBackend: "postgresql" },
    });
  });
});

describe("runMigrationActivation: applied / reportStored classifiers (amendment 2)", () => {
  it("applied is no when no journal exists for a begun effect, unknown when the journal cannot be read, and unknown for a version-2 journal before config-published", async () => {
    const f = await fixture();
    await stopAt(f, "after-prepare-begin");
    rmSync(backendPublicationJournalPath(f.homeDir));
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", effectBegun: true, applied: "no" });
    const g = await fixture();
    await stopAt(g, "after-drive");
    expect(await g.run({ readPublicationJournal: () => { throw new Error("journal read failed"); } })).toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", effectBegun: true, applied: "unknown" });
    const h = await fixture();
    await crashCoordinatorAt(h, "prepared");
    const row = [...h.guard.rows.values()][0]!;
    h.guard.rows.set(REMOTE, { ...row, releasedAt: "2026-10-16T13:00:00.000Z" });
    expect(await h.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost", applied: "unknown" });
  });

  it("a journal that cannot be read before any effect refuses maintenance-unresolvable", async () => {
    const f = await fixture();
    expect(await f.run({ readMaintenanceJournal: () => { throw new Error("journal read failed"); } })).toMatchObject({ status: "refused", step: "S0", reason: "maintenance-unresolvable", effectBegun: false });
    expect(f.manifestStore.read(GENERATION).phase).toBe("verified");
  });

  it("reportStored before the report identity is known: unknown when the reader throws or is unresolvable or names an unattributed absence; no for an absent root", async () => {
    const { ActivationGenerationLinkConflictError: Conflict } = await import("../../src/migration/activation-artifact-store.js");
    const conflict = { recordLink: () => { throw new Conflict("x"); } };
    const f = await fixture();
    expect(await f.run({ ...conflict, readReport: () => { throw new Error("read failed"); } })).toMatchObject({ status: "interrupted", step: "S11", cause: "link-conflict", reportStored: "unknown" });
    expect(await f.run({ ...conflict, readReport: () => ({ state: "unresolvable", reason: "read-unresolvable", detail: "x" }) })).toMatchObject({ status: "interrupted", reportStored: "unknown" });
    expect(await f.run({ ...conflict, readReport: () => ({ state: "authoritatively-absent", detail: "nothing here" }) })).toMatchObject({ status: "interrupted", reportStored: "unknown" });
    expect(await f.run({ ...conflict, readReport: () => ({ state: "authoritatively-absent", detail: "the private LCM root /x does not exist" }) })).toMatchObject({ status: "interrupted", reportStored: "no" });
    expect(await f.run(conflict)).toMatchObject({ status: "interrupted", reportStored: "no" });
  });

  it("settled active whose stored report cannot be read is interrupted report-unresolvable with reportStored unknown", async () => {
    const f = await fixture();
    await f.run();
    expect(await f.run({ readReport: () => ({ state: "unresolvable", reason: "read-unresolvable", detail: "x" }) })).toMatchObject({ status: "interrupted", step: "S16", cause: "report-unresolvable", reportStored: "unknown", applied: "yes" });
  });
});

describe("runMigrationActivation: verified-manifest lineage on re-entry without a link (S4b)", () => {
  function revisionPath(f: Fixture, revision: number, checksumSha256: string): string {
    return migrationManifestRevisionPath({ generationId: GENERATION, revision, checksumSha256 }, f.homeDir);
  }

  it("an unreadable revision file on the lineage is interrupted state-unresolvable at S9", async () => {
    const f = await fixture();
    await stopAt(f, "after-publish-begin");
    const head = f.manifestStore.read(GENERATION);
    const previous = JSON.parse(readFileSync(revisionPath(f, head.revision - 1, head.previousManifestSha256!), "utf8")) as MigrationManifest;
    writeFileSync(revisionPath(f, previous.revision - 1, previous.previousManifestSha256!), "{not json\n", { mode: 0o600 });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", effectBegun: true, applied: "no" });
    expect(f.manifestStore.read(GENERATION)).toMatchObject({ phase: "activating", pendingEffect: { kind: "publish-activation" } });
  });

  it("a hop whose revision file does not authenticate against the successor's checksum is interrupted state-unresolvable at S9", async () => {
    const f = await fixture();
    await stopAt(f, "after-publish-begin");
    const head = f.manifestStore.read(GENERATION);
    const named = revisionPath(f, head.revision - 1, head.previousManifestSha256!);
    const previous = JSON.parse(readFileSync(named, "utf8")) as MigrationManifest;
    // The file the head names now holds the revision before it: it parses, but its checksum is not the one the head authenticates.
    writeFileSync(named, readFileSync(revisionPath(f, previous.revision - 1, previous.previousManifestSha256!)), { mode: 0o600 });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", detail: expect.stringContaining("does not authenticate") });
    const read = f.deps.readManifestRevision;
    expect(await f.run({ readManifestRevision: (i) => ({ ...read(i), generationId: "generation-9" }) })).toMatchObject({ status: "interrupted", step: "S9", detail: expect.stringContaining("does not authenticate") });
  });

  it("a chain that never reaches a verified manifest within the hop bound, or bottoms out at revision 0, is interrupted state-unresolvable at S9", async () => {
    const f = await fixture();
    await stopAt(f, "after-publish-begin");
    const read = f.deps.readManifestRevision;
    // The real chain is head (publish pending) -> activating -> verified+prepare pending -> verified: the bound is exactly spent.
    const neverVerified = (i: Parameters<typeof read>[0]) => { const m = read(i); return m.phase === "verified" && m.pendingEffect === null ? { ...m, phase: "activating" as const } : m; };
    expect(await f.run({ readManifestRevision: neverVerified })).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", detail: expect.stringContaining("within 3 hops") });
    const genesis = (i: Parameters<typeof read>[0]) => { const m = read(i); return m.phase === "verified" && m.pendingEffect === null ? { ...m, phase: "activating" as const, previousManifestSha256: null } : m; };
    expect(await f.run({ readManifestRevision: genesis })).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", detail: expect.stringContaining("within 3 hops") });
    expectActivated(f, await f.run(), "publish-pending-before-artifact");
  });
});

describe("runMigrationActivation: step C sub-state rows", () => {
  it("an unresolvable generation link refuses state-unresolvable before any effect and interrupts at S11 after one", async () => {
    const f = await fixture();
    corruptLink(f);
    expect(await f.run()).toMatchObject({ status: "refused", step: "S0", reason: "state-unresolvable", effectBegun: false });
    const g = await fixture();
    await stopAt(g, "after-prepare-begin");
    corruptLink(g);
    expect(await g.run()).toMatchObject({ status: "interrupted", step: "S11", cause: "state-unresolvable", effectBegun: true });
  });

  it("a generation link naming another publication is interrupted link-conflict at S11", async () => {
    const f = await fixture();
    recordActivationGenerationLink({ homeDir: f.homeDir, generationId: GENERATION, publicationId: deriveActivationPublicationId("generation-9"), identityDigest: "0".repeat(64), epochManifestRevision: 8, epochManifestChecksumSha256: HASH_A });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S11", cause: "link-conflict", applied: "no" });
  });

  it("a linked artifact that is absent or unresolvable is interrupted state-unresolvable at S11; a raw store error surfaces", async () => {
    const f = await fixture();
    await stopAt(f, "after-link");
    const link = readActivationGenerationLink({ homeDir: f.homeDir, generationId: GENERATION });
    if (link.state !== "resolved") throw new Error("link expected");
    writeFileSync(activationArtifactPath(f.homeDir, link.link.identityDigest), "{garbage\n", { mode: 0o600 });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S11", cause: "state-unresolvable", detail: expect.stringContaining("unresolvable") });
    rmSync(activationArtifactPath(f.homeDir, link.link.identityDigest));
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S11", cause: "state-unresolvable", detail: expect.stringContaining("absent") });
    expect(await f.run({ readArtifact: () => { throw new ActivationArtifactIdentityMismatchError("x"); } })).toMatchObject({ status: "interrupted", step: "S11", cause: "state-unresolvable" });
    await expect(f.run({ readArtifact: () => { throw new RangeError("raw"); } })).rejects.toBeInstanceOf(RangeError);
  });

  it("a selection without a generation link is interrupted state-unresolvable at S12", async () => {
    const f = await fixture();
    await stopAt(f, "after-selection-completed");
    rmSync(activationGenerationLinkPath(f.homeDir, GENERATION));
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable", effectBegun: true });
  });

  it("a selection whose manifest has no pending effect is foreign state: interrupted state-unresolvable at S10, never re-begun", async () => {
    const f = await fixture();
    await stopAt(f, "after-selection-completed");
    const head = f.manifestStore.read(GENERATION);
    // The real revision before publish-activation began: activating, no pending effect.
    const previous = JSON.parse(readFileSync(migrationManifestRevisionPath({ generationId: GENERATION, revision: head.revision - 1, checksumSha256: head.previousManifestSha256! }, f.homeDir), "utf8")) as MigrationManifest;
    expect(previous).toMatchObject({ phase: "activating", pendingEffect: null });
    expect(await f.run({ manifestStore: { read: () => previous, update: () => { throw new Error("must not update"); } } }))
      .toMatchObject({ status: "interrupted", step: "S10", cause: "state-unresolvable", effectBegun: true });
  });

  it("the orphan-artifact lookup at the recomputed digest: unresolvable refuses before any effect and interrupts after one; another publication's artifact is a mismatch", async () => {
    const f = await fixture();
    expect(await f.run({ readArtifact: () => { throw new ActivationArtifactPresenceUnresolvableError("x"); } })).toMatchObject({ status: "refused", step: "S0", reason: "state-unresolvable" });
    expect(await f.run({ readArtifact: () => { throw new ActivationArtifactIdentityMismatchError("x"); } })).toMatchObject({ status: "refused", step: "S0", reason: "state-unresolvable" });
    await expect(f.run({ readArtifact: () => { throw new RangeError("raw"); } })).rejects.toBeInstanceOf(RangeError);
    expect(await f.run({ readArtifact: () => ({ publicationId: "someone-else" } as never) })).toMatchObject({ status: "interrupted", step: "S11", cause: "artifact-identity-mismatch" });
    const g = await fixture();
    await stopAt(g, "after-prepare-begin");
    expect(await g.run({ readArtifact: () => { throw new ActivationArtifactPresenceUnresolvableError("x"); } })).toMatchObject({ status: "interrupted", step: "S11", cause: "artifact-unresolvable", effectBegun: true });
  });
});

describe("runMigrationActivation: refusal rows reached only through injected checks", () => {
  it("S3 maps an absent or not-held maintenance journal from the quiescence check to maintenance-not-held", async () => {
    const f = await fixture();
    expect(await f.run({ checkQuiescence: async () => ({ status: "unsatisfied", reason: "maintenance-not-held", detail: "x", quiescenceFence: null }) })).toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held" });
    expect(await f.run({ checkQuiescence: async () => ({ status: "unresolvable", reason: "maintenance-journal-absent", detail: "x", quiescenceFence: null }) })).toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held" });
  });

  it("S5 refuses project-map-drift when the recomputed pre-publication witness differs from the report, and identity-drift when the ordinary identity differs", async () => {
    const f = await fixture();
    expect(await f.run({ computeProjectMapWitness: () => "0".repeat(64) })).toMatchObject({ status: "refused", step: "S5", reason: "project-map-drift" });
    let calls = 0;
    expect(await f.run({ captureDestinationIdentity: async () => ({ version: 1, sealedWitnessSha256: DEST_IDENTITY, systemIdentifier: calls++ < 1 ? SYSTEM_ID : "999" }) })).toMatchObject({ status: "refused", step: "S5", reason: "identity-drift" });
    await expect(f.run({ captureDestinationIdentity: async () => { throw new RangeError("raw"); } })).rejects.toBeInstanceOf(RangeError);
  });

  it("S9 / S10: a foreign pending prepare or publish effect, and a protocol error from the store", async () => {
    const f = await fixture();
    const verified = f.manifestStore.read(GENERATION);
    f.manifestStore.update(GENERATION, verified.checksumSha256, (m) => beginMigrationEffect(m, { effectId: "prepare-activation-foreign", kind: "prepare-activation", inputSha256: HASH_A, startedAt: "2026-10-16T13:30:00.000Z" }));
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", effectBegun: true, applied: "no", detail: "the pending effect is not this activation's prepare-activation" });
    const g = await fixture();
    const unbegun = await g.run({ manifestStore: countedStore(g, { updateAt: [1, () => { throw new MigrationProtocolError("unexpected-state", "injected"); }] }) });
    expect(unbegun).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", effectBegun: false, applied: "no" });
    // The begin failed before writing: the head is still the verified manifest
    // with no pending effect, so the S2 lease was released (round-3 S1) and a
    // different generation can acquire the project.
    expect((unbegun as { detail: string }).detail).not.toContain("lease was not released");
    expect(g.manifestStore.read(GENERATION)).toMatchObject({ phase: "verified", pendingEffect: null });
    expect(g.guard.rows.get(REMOTE)!.releasedAt).not.toBeNull();
    await expect(g.guard.acquire({
      projectId: REMOTE, machineId: MACHINE, publicationId: "another-generation", targetBackend: "postgresql", evidenceSha256: "d".repeat(64), ttlMs: 60_000,
    })).resolves.toMatchObject({ publicationId: "another-generation", releasedAt: null });
    const h = await fixture();
    await stopAt(h, "after-prepare-complete");
    expect(await h.run({ manifestStore: countedStore(h, { updateAt: [1, () => { throw new MigrationProtocolError("unexpected-state", "injected"); }] }) })).toMatchObject({ status: "interrupted", step: "S10", cause: "state-unresolvable", effectBegun: true });
    const activating = h.manifestStore.read(GENERATION);
    h.manifestStore.update(GENERATION, activating.checksumSha256, (m) => beginMigrationEffect(m, { effectId: "publish-activation-foreign", kind: "publish-activation", inputSha256: HASH_A, startedAt: "2026-10-16T13:30:00.000Z" }));
    expect(await h.run()).toMatchObject({ status: "interrupted", step: "S10", cause: "state-unresolvable", effectBegun: true });
  });

  it("S12: a vanished journal is journal-unexpected; a journal already selection-completed is accepted idempotently", async () => {
    const f = await fixture();
    const read = f.deps.readMaintenanceJournal;
    let reads = 0;
    expect(await f.run({ readMaintenanceJournal: (h) => (++reads === 2 ? null : read(h)) })).toMatchObject({ status: "interrupted", step: "S12", cause: "journal-unexpected", detail: expect.stringContaining("no maintenance journal") });
    const g = await fixture();
    let reads2 = 0;
    const read2 = g.deps.readMaintenanceJournal;
    const outcome = await g.run({
      readMaintenanceJournal: (h) => { reads2 += 1; const j = read2(h); return reads2 >= 2 && j !== null ? { ...j, phase: "selection-completed" as const } : j; },
      drive: async () => ({ status: "aborted", detail: "injected", journal: null, fenceChecks: [], dispatch: null }),
    });
    expect(outcome).toMatchObject({ status: "publication-failed" });
  });

  it("a takeover before S12 whose re-recorded attempt is refused is interrupted at S12", async () => {
    const f = await fixture();
    let renews = 0;
    const renew = f.guard.renew.bind(f.guard);
    f.guard.renew = async (input) => { if (++renews === 2) f.guard.expire(input.projectId); return renew(input); };
    let attempts = 0;
    const recordAttempt = f.evidence.recordMigrationActivationAttempt;
    expect(await f.run({ evidence: { ...f.evidence, recordMigrationActivationAttempt: (i) => { if (++attempts === 2) throw namedError("MigrationBindingConflictError"); recordAttempt(i); } } }))
      .toMatchObject({ status: "interrupted", step: "S12", cause: "evidence-conflict" });
  });
});

describe("runMigrationActivation: S13b and S16 readback rows", () => {
  it("S13b: a publication journal that cannot be re-read is journal-unexpected", async () => {
    const f = await fixture();
    await crashCoordinatorAt(f, "prepared");
    const read = f.deps.readPublicationJournal;
    let reads = 0;
    expect(await f.run({ readPublicationJournal: (h) => { if (++reads === 2) throw new Error("journal read failed"); return read(h); } })).toMatchObject({ status: "interrupted", step: "S13b", cause: "journal-unexpected", applied: "unknown" });
  });

  it("S16: the manifest re-read fails or is not this activation's publish-activation", async () => {
    const f = await fixture();
    await stopAt(f, "after-drive");
    expect(await f.run({ manifestStore: countedStore(f, { readAt: [2, () => { throw new Error("re-read failed"); }] }) })).toMatchObject({ status: "interrupted", step: "S16", cause: "state-unresolvable", applied: "yes", reportStored: "no" });
    expect(await f.run({ manifestStore: countedStore(f, { readAt: [2, (m) => ({ ...m, phase: "verified" as const })] }) })).toMatchObject({ status: "interrupted", step: "S16", cause: "readback-mismatch" });
    expect(await f.run({ manifestStore: countedStore(f, { readAt: [2, (m) => ({ ...m, pendingEffect: { ...m.pendingEffect!, effectId: "publish-activation-other" } })] }) })).toMatchObject({ status: "interrupted", step: "S16", cause: "readback-mismatch" });
  });

  it("S16: the publication journal re-read fails or is not this publication's completed journal", async () => {
    const f = await fixture();
    await stopAt(f, "after-drive");
    const read = f.deps.readPublicationJournal;
    let reads = 0;
    expect(await f.run({ readPublicationJournal: (h) => { if (++reads === 3) throw new Error("re-read failed"); return read(h); } })).toMatchObject({ status: "interrupted", step: "S16", cause: "readback-mismatch", applied: "yes" });
    let reads2 = 0;
    expect(await f.run({ readPublicationJournal: (h) => { const j = read(h); return ++reads2 === 3 && j !== null ? { ...j, phase: "released" as const } : j; } })).toMatchObject({ status: "interrupted", step: "S16", cause: "readback-mismatch" });
  });

  it("S16: the selection binding cannot be resolved or does not name this activation", async () => {
    const f = await fixture();
    expect(await f.run({ bindings: { ...f.bindings, resolveMigrationWitnessBindings: () => { throw new Error("resolve failed"); } } })).toMatchObject({ status: "interrupted", step: "S16", cause: "binding-unresolvable", applied: "yes" });
    const g = await fixture();
    g.bindings.resolveOverride = { state: "authoritatively-absent" };
    expect(await g.run()).toMatchObject({ status: "interrupted", step: "S16", cause: "readback-mismatch" });
    const h = await fixture();
    h.bindings.resolveOverride = { state: "resolved", witnesses: [], selections: [] };
    expect(await h.run()).toMatchObject({ status: "interrupted", step: "S16", cause: "readback-mismatch" });
  });

  it("S16: the post-publication project map witness drifts, cannot be read, or differs from the verified witness", async () => {
    const f = await fixture();
    const real = f.deps.computeProjectMapWitness;
    const post = (behaviour: () => string) => (w: Parameters<typeof real>[0]) => (w.mode === "post-publication" ? behaviour() : real(w));
    expect(await f.run({ computeProjectMapWitness: post(() => { throw new MigrationProjectMapWitnessError("project-map-drift", "x", { drift: "unbound-after-publication" }); }) })).toMatchObject({ status: "interrupted", step: "S16", cause: "project-map-drift", applied: "yes" });
    expect(await f.run({ computeProjectMapWitness: post(() => { throw new MigrationProjectMapWitnessError("project-map-unresolvable", "x"); }) })).toMatchObject({ status: "interrupted", step: "S16", cause: "state-unresolvable" });
    expect(await f.run({ computeProjectMapWitness: post(() => "0".repeat(64)) })).toMatchObject({ status: "interrupted", step: "S16", cause: "project-map-drift" });
    expectActivated(f, await f.run(), "publication-journal");
  });

  it("S16: the report store refuses with a conflict or an unresolvable store, a raw error surfaces, and the completion update failing is state-unresolvable with reportStored yes", async () => {
    const f = await fixture();
    expect(await f.run({ persistReport: () => { throw new MigrationActivationReportError("identity-conflict", "x"); } })).toMatchObject({ status: "interrupted", step: "S16", cause: "report-conflict", applied: "yes", reportStored: "no" });
    expect(await f.run({ persistReport: () => { throw new MigrationActivationReportError("unresolvable", "x"); } })).toMatchObject({ status: "interrupted", step: "S16", cause: "report-unresolvable" });
    await expect(f.run({ persistReport: () => { throw new RangeError("raw"); } })).rejects.toBeInstanceOf(RangeError);
    expect(await f.run({ manifestStore: countedStore(f, { updateAt: [1, () => { throw new MigrationProtocolError("unexpected-state", "injected"); }] }) })).toMatchObject({ status: "interrupted", step: "S16", cause: "state-unresolvable", reportStored: "yes" });
    await expect(f.run({ manifestStore: countedStore(f, { updateAt: [1, () => { throw new RangeError("raw"); }] }) })).rejects.toBeInstanceOf(RangeError);
    expectActivated(f, await f.run(), "publication-journal");
  });
});

describe("runMigrationActivation: adopting the stored attempt on post-selection re-entry", () => {
  it("evidence that throws, is unresolvable or is absent", async () => {
    const f = await fixture();
    await stopAt(f, "after-selection-completed");
    expect(await f.run({ evidence: { ...f.evidence, readMigrationActivationEvidence: () => { throw new Error("read failed"); } } })).toMatchObject({ status: "interrupted", step: "S12", cause: "evidence-unresolvable" });
    f.evidence.failNext = "read";
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "evidence-unresolvable", detail: "injected" });
    expect(await f.run({ evidence: { ...f.evidence, readMigrationActivationEvidence: () => ({ state: "authoritatively-absent" }) } })).toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable" });
  });

  it("a witness whose attempt or epoch is not stored, and a stored epoch that is not the derived one", async () => {
    const f = await fixture();
    await stopAt(f, "after-selection-completed");
    const stored = () => ({ epochs: [...f.evidence.epochs.values()], attempts: [...f.evidence.attempts.values()], witnesses: [...f.evidence.witnesses.values()] });
    expect(await f.run({ evidence: { ...f.evidence, readMigrationActivationEvidence: () => ({ state: "resolved", ...stored(), attempts: [] }) } })).toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable" });
    expect(await f.run({ evidence: { ...f.evidence, readMigrationActivationEvidence: () => ({ state: "resolved", ...stored(), epochs: [] }) } })).toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable" });
    const s = stored();
    const foreign = { ...s, epochs: s.epochs.map((e) => ({ ...e, epochId: "018f0000-0000-7000-8000-000000000000" })), attempts: s.attempts.map((a) => ({ ...a, epochId: "018f0000-0000-7000-8000-000000000000" })) };
    expect(await f.run({ evidence: { ...f.evidence, readMigrationActivationEvidence: () => ({ state: "resolved", ...foreign }) } })).toMatchObject({ status: "interrupted", step: "S12", cause: "evidence-conflict" });
    expectActivated(f, await f.run(), "selection-completed-unbound");
  });

  it("a lease row naming another publication is lease-lost at S13b", async () => {
    const f = await fixture();
    await stopAt(f, "after-selection-completed");
    const row = [...f.guard.rows.values()][0]!;
    f.guard.rows.set(REMOTE, { ...row, publicationId: "someone-else" });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost", detail: expect.stringContaining("another publication") });
  });

  it("with a version-2 journal the witness checksum comes from the selection binding, else the witness binding; unresolved bindings interrupt", async () => {
    const f = await fixture();
    await crashCoordinatorAt(f, "prepared");
    expect(await f.run({ bindings: { ...f.bindings, resolveMigrationWitnessBindings: () => { throw new Error("resolve failed"); } } })).toMatchObject({ status: "interrupted", step: "S13a", cause: "binding-unresolvable" });
    f.bindings.resolveOverride = { state: "authoritatively-absent" };
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable" });
    f.bindings.resolveOverride = { state: "resolved", witnesses: [], selections: [] };
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S12", cause: "state-unresolvable" });
    const real = f.bindings.resolveMigrationWitnessBindings;
    f.bindings.resolveOverride = null;
    const resolved = real({ homeDir: f.homeDir, generationId: GENERATION });
    if (resolved.state !== "resolved") throw new Error("bindings expected");
    f.bindings.resolveOverride = { state: "resolved", witnesses: resolved.witnesses, selections: [] };
    // The witness binding names the attempt; the selection binding is then missing at S16's readback.
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S16", cause: "readback-mismatch" });
    f.bindings.resolveOverride = null;
    expectActivated(f, await f.run(), "publication-journal");
  });
});

describe("previewMigrationActivation (A11): non-predictive and read-only", () => {
  async function preview(f: Fixture, generationId = GENERATION, overrides: Partial<MigrationActivationDependencies> = {}) {
    const result = await previewMigrationActivation({ homeDir: f.homeDir, generationId }, { ...f.deps, ...overrides });
    expect(result.predictive).toBe(false);
    expect(result.notEvaluated).toEqual(["quiescence", "coverage", "g8", "lease", "health", "census"]);
    return Object.fromEntries(result.checks.map((check) => [check.name, check]));
  }

  it("describes an eligible verified generation with a held maintenance journal without writing anything", async () => {
    const f = await fixture();
    const before = f.manifestStore.read(GENERATION);
    const checks = await preview(f);
    expect(checks.manifest).toMatchObject({ status: "ok", detail: "phase verified, recovery ready" });
    expect(checks["resume-point"]).toMatchObject({ status: "ok", detail: "fresh" });
    expect(checks["verification-report"]).toMatchObject({ status: "ok" });
    expect(checks["maintenance-journal"]).toMatchObject({ status: "ok" });
    expect(checks["publication-journal"]).toMatchObject({ status: "ok", detail: "none while the maintenance journal is live" });
    expect(checks.link).toMatchObject({ status: "ok", detail: "absent" });
    expect(checks.artifact).toMatchObject({ status: "ok", detail: "not linked yet" });
    expect(checks.restart).toMatchObject({ status: "ok" });
    expect(f.manifestStore.read(GENERATION)).toEqual(before);
    expect(readActivationGenerationLink({ homeDir: f.homeDir, generationId: GENERATION }).state).toBe("authoritatively-absent");
  });

  it("classifies absent, unresolvable, ineligible and foreign-pending manifests and the resume point of each re-entry", async () => {
    const f = await fixture();
    expect((await preview(f, "generation-9")).manifest).toMatchObject({ status: "refuse" });
    expect((await preview(f, GENERATION, { manifestStore: { read: () => { throw new MigrationProtocolError("checksum-mismatch", "corrupt"); }, update: f.manifestStore.update.bind(f.manifestStore) } })).manifest).toMatchObject({ status: "unresolvable" });
    f.manifestStore.create(createMigrationManifest({
      generationId: "generation-2", source: witness("sqlite", "2026-10-16T11:00:00.000Z"), destination: witness("postgresql", "2026-10-16T11:00:01.000Z"),
      parentGenerationId: null, preservedSourceGenerationId: "source-generation-2", createdAt: "2026-10-16T11:00:00.000Z",
    }));
    const planned = await preview(f, "generation-2");
    expect(planned.manifest).toMatchObject({ status: "refuse" });
    expect(planned["verification-report"]).toMatchObject({ status: "refuse", detail: expect.stringContaining("not evaluated") });
    const g = await fixture();
    await stopAt(g, "after-prepare-begin");
    const prepare = await preview(g);
    expect(prepare.manifest).toMatchObject({ status: "ok", detail: expect.stringContaining("pending prepare-activation") });
    expect(prepare["resume-point"]).toMatchObject({ detail: "prepare-activation-pending" });
    const h = await fixture();
    await stopAt(h, "after-prepare-complete");
    expect((await preview(h))["resume-point"]).toMatchObject({ detail: "activating" });
    const i = await fixture();
    await i.run();
    const settled = await preview(i);
    expect(settled.manifest).toMatchObject({ status: "ok" });
    expect(settled["resume-point"]).toMatchObject({ detail: "settled-active" });
    expect(settled["maintenance-journal"]).toMatchObject({ status: "refuse", detail: "absent" });
    expect(settled["publication-journal"]).toMatchObject({ status: "ok", detail: expect.stringContaining("(this generation)") });
    const j = await fixture();
    const verified = j.manifestStore.read(GENERATION);
    j.manifestStore.update(GENERATION, verified.checksumSha256, (m) => beginMigrationEffect(m, { effectId: "abort-1", kind: "abort", inputSha256: HASH_A, startedAt: "2026-10-16T13:30:00.000Z" }));
    expect((await preview(j)).manifest).toMatchObject({ status: "refuse", detail: expect.stringContaining("pending abort") });
  });

  it("reports the verification report as ineligible or unresolvable", async () => {
    const f = await fixture();
    const real = f.deps.readVerificationReport;
    expect((await preview(f, GENERATION, { readVerificationReport: (g, sha) => ({ ...real(g, sha), activationEligible: false }) }))["verification-report"]).toMatchObject({ status: "refuse" });
    expect((await preview(f, GENERATION, { readVerificationReport: () => { throw new Error("gone"); } }))["verification-report"]).toMatchObject({ status: "unresolvable", detail: "gone" });
  });

  it("reports journals held for another generation, another publication's version-2 journal, and an unreadable journal", async () => {
    const f = await fixture({ held: false });
    const unheld = await preview(f);
    expect(unheld["maintenance-journal"]).toMatchObject({ status: "refuse", detail: "absent" });
    expect(unheld["publication-journal"]).toMatchObject({ status: "ok", detail: "absent" });
    await f.coordinator().enterMaintenance({ publicationId: "other-pub", generationId: "generation-9", sourceSelectionSha256: HASH_A, queueEvidenceSha256: HASH_B, roster: [{ machineId: MACHINE, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A }] });
    expect((await preview(f))["maintenance-journal"]).toMatchObject({ status: "refuse", detail: expect.stringContaining("generation-9") });
    const rollback = await fixture({ held: false });
    await rollback.coordinator().enterMaintenance({ publicationId: rollback.publicationId, generationId: GENERATION, sourceBackend: "postgresql", sourceSelectionSha256: HASH_A, queueEvidenceSha256: HASH_B, roster: [{ machineId: MACHINE, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A }] });
    expect((await preview(rollback))["maintenance-journal"]).toMatchObject({ status: "refuse", detail: expect.stringContaining("entered from postgresql") });
    const g = await fixture();
    await stopAt(g, "after-drive");
    const read = g.deps.readPublicationJournal;
    const other = await preview(g, GENERATION, { readPublicationJournal: (h) => { const j = read(h); return j === null ? null : { ...j, publicationId: "other-pub" }; } });
    expect(other["publication-journal"]).toMatchObject({ status: "ok", detail: expect.not.stringContaining("(this generation)") });
    const broken = await preview(g, GENERATION, { readMaintenanceJournal: () => { throw new Error("journal read failed"); } });
    expect(broken["maintenance-journal"]).toMatchObject({ status: "unresolvable", detail: "journal read failed" });
    expect(broken["publication-journal"]).toBeUndefined();
  });

  it("reports the link and the linked artifact", async () => {
    const f = await fixture();
    await stopAt(f, "after-link");
    const linked = await preview(f);
    expect(linked.link).toMatchObject({ status: "ok", detail: expect.stringContaining("resolved to digest") });
    expect(linked.artifact).toMatchObject({ status: "ok", detail: "present" });
    const link = readActivationGenerationLink({ homeDir: f.homeDir, generationId: GENERATION });
    if (link.state !== "resolved") throw new Error("link expected");
    writeFileSync(activationArtifactPath(f.homeDir, link.link.identityDigest), "{garbage\n", { mode: 0o600 });
    expect((await preview(f)).artifact).toMatchObject({ status: "unresolvable" });
    rmSync(activationArtifactPath(f.homeDir, link.link.identityDigest));
    expect((await preview(f)).artifact).toMatchObject({ status: "refuse", detail: "absent for the linked digest" });
    writeFileSync(activationGenerationLinkPath(f.homeDir, GENERATION), "{garbage\n", { mode: 0o600 });
    const broken = await preview(f);
    expect(broken.link).toMatchObject({ status: "unresolvable" });
    expect(broken.artifact).toMatchObject({ status: "ok", detail: "not linked yet" });
  });

  it("reports the restart verdict as refuse, unresolvable, or unresolvable when the probe throws", async () => {
    const f = await fixture();
    const verdict = (status: "satisfied" | "unsatisfied" | "unresolvable") => async () => ({ status, reason: "no-pid-file" as const, detail: "fake", pid: null, observedBackend: null, selectedBackend: "postgresql" as const });
    expect((await preview(f, GENERATION, { checkRestart: verdict("unsatisfied") })).restart).toMatchObject({ status: "refuse" });
    expect((await preview(f, GENERATION, { checkRestart: verdict("unresolvable") })).restart).toMatchObject({ status: "unresolvable" });
    expect((await preview(f, GENERATION, { checkRestart: async () => { throw new Error("probe failed"); } })).restart).toMatchObject({ status: "unresolvable", detail: "probe failed" });
  });
});


describe("runMigrationActivation: the S2 lease is released on every pre-effect exit (PR #1628 review, Codex P1)", () => {
  const row = (f: Fixture) => f.guard.rows.get(REMOTE)!;
  const releases = (f: Fixture) => f.guard.calls.filter((c) => c === "release").length;
  /** acquireActivationLease never displaces an unreleased row of another generation, so this is the proof that matters. */
  const anotherGenerationAcquires = (f: Fixture) => f.guard.acquire({
    projectId: REMOTE, machineId: MACHINE, publicationId: "another-generation", targetBackend: "postgresql", evidenceSha256: "d".repeat(64), ttlMs: 60_000,
  });

  it("a refusal after S2 (S4 uncovered-projects) releases the row and a different generation can acquire it; the refusal is unchanged", async () => {
    const f = await fixture({ extraProjectWithData: true });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S4", reason: "uncovered-projects", effectBegun: false });
    expect((outcome as { detail: string }).detail).not.toContain("lease was not released");
    expect(releases(f)).toBe(1);
    expect(row(f).releasedAt).not.toBeNull();
    await expect(anotherGenerationAcquires(f)).resolves.toMatchObject({ publicationId: "another-generation", releasedAt: null });
  });

  it.each([
    ["S6", async (f: Fixture) => { f.deps.health.push({ status: "unhealthy", reason: "schema-mismatch", detail: "fake", sqlState: null } as MigrationTargetHealthResult); }],
    ["S8", async (f: Fixture) => { f.deps.destinationCensus = domainCensus("drifted"); }],
  ] as const)("a refusal at %s releases the row", async (_step, arrange) => {
    const f = await fixture();
    await arrange(f);
    expect((await f.run()).status).toBe("refused");
    expect(row(f).releasedAt).not.toBeNull();
    await expect(anotherGenerationAcquires(f)).resolves.toMatchObject({ publicationId: "another-generation" });
  });

  it("a refusal before or at S2 releases nothing: there is no row of ours to release", async () => {
    const f = await fixture({ held: false });
    expect(await f.run()).toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held" });
    expect(releases(f)).toBe(0);
    expect(f.guard.rows.size).toBe(0);
    const g = await fixture();
    g.guard.seed({ projectId: REMOTE, publicationId: "someone-else" });
    expect(await g.run()).toMatchObject({ status: "refused", step: "S2", reason: "lease-conflict" });
    expect(releases(g)).toBe(0);
    expect(row(g)).toMatchObject({ publicationId: "someone-else", releasedAt: null });
  });

  it("an error thrown after S2 and before S9 is rethrown unchanged and the row is released", async () => {
    const f = await fixture();
    // S7's census read, after S2: the S0 identity read runs before any lease exists.
    await expect(f.run({ readDestinationCensus: async () => { throw new RangeError("raw"); } })).rejects.toBeInstanceOf(RangeError);
    expect(releases(f)).toBe(1);
    expect(row(f).releasedAt).not.toBeNull();
  });

  it("an error thrown once the effect began keeps the row for the roll-forward, which reacquires it", async () => {
    const f = await fixture();
    await stopAt(f, "after-prepare-begin");
    expect(releases(f)).toBe(0);
    expect(row(f).releasedAt).toBeNull();
    const token = row(f).fencingToken;
    const outcome = await f.run();
    expectActivated(f, outcome, "prepare-activation-pending");
    // The same row continued (no new token) until the coordinator's own release phase freed it.
    expect(f.bindings.resolveMigrationWitnessBindings({ homeDir: f.homeDir, generationId: GENERATION })).toMatchObject({ state: "resolved" });
    expect(row(f).fencingToken).toBe(token);
    expect(row(f).releasedAt).not.toBeNull();
  });

  it("an expired own row is taken over and then released (expiry is not release)", async () => {
    const f = await fixture();
    f.deps.destinationCensus = domainCensus("drifted");
    const release = f.guard.release.bind(f.guard);
    f.guard.release = async (input) => { f.guard.expire(input.projectId); f.guard.release = release; return release(input); };
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "refused", step: "S8", reason: "census-drift" });
    expect((outcome as { detail: string }).detail).not.toContain("lease was not released");
    expect(releases(f)).toBe(2);
    expect(row(f)).toMatchObject({ publicationId: f.publicationId, databaseExpired: false });
    expect(row(f).releasedAt).not.toBeNull();
  });

  it("a release failure never changes the refusal, it rides the detail: takeover conflict, stale token, guard error", async () => {
    const f = await fixture();
    f.deps.destinationCensus = domainCensus("drifted");
    const acquire = f.guard.acquire.bind(f.guard);
    f.guard.release = async (input) => { f.guard.expire(input.projectId); throw new PostgreSqlBackendPublicationGuardError(input.projectId, "release", "fence-mismatch"); };
    f.guard.acquire = async (input) => {
      if (input.expectedFencingToken !== undefined) throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "publication-conflict");
      return acquire(input);
    };
    const conflict = await f.run();
    expect(conflict).toMatchObject({ status: "refused", step: "S8", reason: "census-drift", effectBegun: false });
    expect((conflict as { detail: string }).detail).toMatch(/^the recomputed destination census differs .*; the activation lease was not released: .*different publication generation/u);

    const g = await fixture();
    g.deps.destinationCensus = domainCensus("drifted");
    g.guard.release = async (input) => {
      const current = g.guard.rows.get(input.projectId)!;
      g.guard.rows.set(input.projectId, { ...current, fencingToken: current.fencingToken + 7n });
      throw new PostgreSqlBackendPublicationGuardError(input.projectId, "release", "fence-mismatch");
    };
    const stale = await g.run();
    expect(stale).toMatchObject({ status: "refused", step: "S8", reason: "census-drift" });
    expect((stale as { detail: string }).detail).toContain("the activation lease was not released: release failed because the caller's known fencingToken");
    expect(row(g).releasedAt).toBeNull();

    const h = await fixture();
    h.deps.destinationCensus = domainCensus("drifted");
    h.guard.release = async () => { throw new Error("the lease connection dropped"); };
    const thrown = await h.run();
    expect(thrown).toMatchObject({ status: "refused", step: "S8", reason: "census-drift" });
    expect((thrown as { detail: string }).detail).toContain("the activation lease was not released: the lease connection dropped");
  });

  it("a row already released or vanished counts as released: S8 lost because the row was released, then the row deleted", async () => {
    const f = await fixture();
    const renew = f.guard.renew.bind(f.guard);
    f.guard.renew = async (input) => {
      const current = f.guard.rows.get(input.projectId)!;
      f.guard.rows.set(input.projectId, { ...current, releasedAt: "2026-10-16T00:00:01.500Z" });
      return renew(input);
    };
    const released = await f.run();
    expect(released).toMatchObject({ status: "refused", step: "S8", reason: "lease-conflict" });
    expect((released as { detail: string }).detail).not.toContain("lease was not released");

    const g = await fixture();
    g.deps.destinationCensus = domainCensus("drifted");
    g.guard.release = async (input) => { g.guard.rows.delete(input.projectId); throw new PostgreSqlBackendPublicationGuardError(input.projectId, "release", "fence-mismatch"); };
    const vanished = await g.run();
    expect(vanished).toMatchObject({ status: "refused", step: "S8", reason: "census-drift" });
    expect((vanished as { detail: string }).detail).not.toContain("lease was not released");
  });

  it("a release failure after a thrown error does not mask the error", async () => {
    const f = await fixture();
    f.guard.release = async () => { throw new Error("the lease connection dropped"); };
    await expect(f.run({ readDestinationCensus: async () => { throw new RangeError("raw"); } })).rejects.toBeInstanceOf(RangeError);
    expect(row(f).releasedAt).toBeNull();
  });
});

describe("runMigrationActivation: an S0-S8 re-check that fails on an effect-begun re-entry is an interruption (PR #1628 review, Codex P1)", () => {
  const row = (f: Fixture) => f.guard.rows.get(REMOTE)!;

  it("prepare-activation pending (S9 in flight): S4 uncovered-projects is interrupted S9 state-unresolvable, keeps the lease, and the next call converges", async () => {
    const f = await fixture();
    await stopAt(f, "after-prepare-begin");
    const outcome = await f.run({ enumerateStoredData: () => ({ status: "enumerated", projectHashes: [f.localProjectId, HASH_B] }) });
    expect(outcome).toMatchObject({
      status: "interrupted", step: "S9", cause: "state-unresolvable", effectBegun: true, applied: "no", reportStored: "no",
      identity: { generationId: GENERATION, publicationId: f.publicationId },
    });
    expect((outcome as { detail: string }).detail).toMatch(/^S4 uncovered-projects on roll-forward: /u);
    expect(row(f).releasedAt).toBeNull();
    expectActivated(f, await f.run(), "prepare-activation-pending");
  });

  it("activating with no pending effect (between S9 and S10): S6 unhealthy is interrupted S10", async () => {
    const f = await fixture();
    await stopAt(f, "after-prepare-complete");
    f.deps.health.push({ status: "unhealthy", reason: "schema-mismatch", detail: "fake", sqlState: null } as MigrationTargetHealthResult);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "interrupted", step: "S10", cause: "state-unresolvable", effectBegun: true, applied: "no" });
    expect((outcome as { detail: string }).detail).toContain("S6 target-unhealthy on roll-forward: schema-mismatch");
    expect(row(f).releasedAt).toBeNull();
    expectActivated(f, await f.run(), "activating-no-effect");
  });

  it("publish-activation pending (S11 in flight): the lease and project-map reasons map to their own causes", async () => {
    const f = await fixture();
    await stopAt(f, "after-link");
    const acquire = f.guard.acquire.bind(f.guard);
    f.guard.acquire = async (input) => { throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "publication-conflict"); };
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S11", cause: "lease-lost", effectBegun: true, detail: expect.stringMatching(/^S2 lease-conflict on roll-forward: /u) });
    f.guard.acquire = async (input) => { throw new PostgreSqlBackendPublicationGuardError(input.projectId, "acquire", "readback-mismatch"); };
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S11", cause: "lease-unresolvable", effectBegun: true });
    f.guard.acquire = acquire;
    expect(await f.run({ computeProjectMapWitness: () => "0".repeat(64) })).toMatchObject({ status: "interrupted", step: "S11", cause: "project-map-drift", effectBegun: true, detail: expect.stringMatching(/^S5 project-map-drift on roll-forward: /u) });
    expect(row(f).releasedAt).toBeNull();
    expectActivated(f, await f.run(), "publish-pending-after-link");
  });

  it("a durable prepare-activation effect under another effectId is an S9 interruption that keeps the row (an effect exists; PR #1628 review)", async () => {
    const f = await fixture();
    const verified = f.manifestStore.read(GENERATION);
    f.manifestStore.update(GENERATION, verified.checksumSha256, (m) => beginMigrationEffect(m, { effectId: "prepare-activation-foreign", kind: "prepare-activation", inputSha256: HASH_A, startedAt: "2026-10-16T13:30:00.000Z" }));
    const outcome = await f.run();
    expect(outcome).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", effectBegun: true, identity: { generationId: GENERATION, publicationId: f.publicationId } });
    expect((outcome as { detail: string }).detail).not.toContain("lease");
    expect(f.guard.calls.filter((c) => c === "release")).toHaveLength(0);
    expect(row(f)).toMatchObject({ publicationId: f.publicationId, releasedAt: null });
    // S10's own mismatch row already reports an interruption (see the S9 / S10 row above); the pending abort
    // effect at step C is still a refusal, taken before any lease exists.
  });
});

describe("runMigrationActivation: pre-effect lease cleanup is decided by manifest readback (candidate round 3, S1)", () => {
  const row = (f: Fixture) => f.guard.rows.get(REMOTE)!;
  const protocolFailure = () => { throw new MigrationProtocolError("unexpected-state", "injected"); };

  it("an S9 begin that commits and then throws keeps the lease although effectBegun never flipped, and the next call rolls forward", async () => {
    const f = await fixture();
    const store = f.manifestStore;
    let updates = 0;
    const commitThenThrow: MigrationActivationDependencies["manifestStore"] = {
      read: (id) => store.read(id),
      update: (id, checksum, fn) => { const updated = store.update(id, checksum, fn); if (++updates === 1) throw new Error("thrown after the begin committed"); return updated; },
    };
    await expect(f.run({ manifestStore: commitThenThrow })).rejects.toThrow("thrown after the begin committed");
    expect(f.manifestStore.read(GENERATION).pendingEffect).toMatchObject({ kind: "prepare-activation" });
    expect(f.guard.calls.filter((c) => c === "release")).toHaveLength(0);
    expect(row(f).releasedAt).toBeNull();
    const token = row(f).fencingToken;
    expectActivated(f, await f.run(), "prepare-activation-pending");
    expect(row(f).fencingToken).toBe(token);
  });

  it("a release failure after the unbegun S9 interruption rides its detail and preserves the outcome", async () => {
    const f = await fixture();
    f.guard.release = async () => { throw new Error("the lease connection dropped"); };
    const outcome = await f.run({ manifestStore: countedStore(f, { updateAt: [1, protocolFailure] }) });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", effectBegun: false, applied: "no" });
    expect((outcome as { detail: string }).detail).toMatch(/^prepare-activation could not be driven: injected; the activation lease was not released: the lease connection dropped$/u);
    expect(row(f).releasedAt).toBeNull();
  });

  it("a readback that fails after the begin failure keeps the lease (uncertain is not unbegun)", async () => {
    const f = await fixture();
    const store = f.manifestStore;
    let updates = 0;
    const unreadableAfterFailure: MigrationActivationDependencies["manifestStore"] = {
      read: (id) => { if (updates > 0) throw new MigrationProtocolError("unexpected-state", "readback failed"); return store.read(id); },
      update: () => { updates += 1; return protocolFailure(); },
    };
    const outcome = await f.run({ manifestStore: unreadableAfterFailure });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", effectBegun: false });
    expect((outcome as { detail: string }).detail).not.toContain("lease was not released");
    expect(f.guard.calls.filter((c) => c === "release")).toHaveLength(0);
    expect(row(f).releasedAt).toBeNull();
    // The same generation recovers by take-over on its next call.
    expectActivated(f, await f.run(), "fresh");
  });

  it("a throw after S9 completed keeps the lease by readback (the head is activating, not verified)", async () => {
    const f = await fixture();
    await stopAt(f, "after-prepare-complete");
    expect(f.manifestStore.read(GENERATION)).toMatchObject({ phase: "activating", pendingEffect: null });
    expect(f.guard.calls.filter((c) => c === "release")).toHaveLength(0);
    expect(row(f).releasedAt).toBeNull();
  });
});

describe("runMigrationActivation: pre-effect lease cleanup runs under its own bounded signal (PR #1628 review, Bug #1641)", () => {
  const row = (f: Fixture) => f.guard.rows.get(REMOTE)!;

  it("a run cancelled through input.signal during S7 still releases its row, and another generation can acquire", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const cancelled = runMigrationActivation({ ...f.input, signal: controller.signal }, {
      ...f.deps,
      // Cancel while the census is in flight; the census surfaces the abort like the real runtime would.
      readDestinationCensus: async () => { controller.abort(new Error("cancelled by the caller")); throw controller.signal.reason; },
    });
    await expect(cancelled).rejects.toThrow("cancelled by the caller");
    expect(f.guard.calls.filter((c) => c === "release")).toHaveLength(1);
    expect(row(f).releasedAt).not.toBeNull();
    await expect(f.guard.acquire({
      projectId: REMOTE, machineId: MACHINE, publicationId: "another-generation", targetBackend: "postgresql", evidenceSha256: "d".repeat(64), ttlMs: 60_000,
    })).resolves.toMatchObject({ publicationId: "another-generation", releasedAt: null });
  });

  it("the cleanup deadline is finite: a release that never answers is abandoned, the refusal reports it, nothing hangs", async () => {
    const f = await fixture();
    f.deps.destinationCensus = domainCensus("drifted");
    const signals: Array<AbortSignal | undefined> = [];
    f.guard.release = (input) => new Promise((_resolve, reject) => {
      signals.push(input.signal);
      input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
    });
    const outcome = await f.run({ leaseCleanupTimeoutMs: 20 });
    expect(outcome).toMatchObject({ status: "refused", step: "S8", reason: "census-drift" });
    expect((outcome as { detail: string }).detail).toMatch(/; the activation lease was not released: .*(timeout|timed out|TimeoutError)/iu);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[0]).not.toBe(f.input.signal);
    expect(row(f).releasedAt).toBeNull();
  });

  it("the production dependencies carry the exported cleanup deadline", () => {
    expect(createMigrationActivationDependencies({ homeDir: "/nonexistent" }).leaseCleanupTimeoutMs).toBe(MIGRATION_ACTIVATION_LEASE_CLEANUP_TIMEOUT_MS);
  });
});

describe("runMigrationActivation: S7 classifies target failures like S6 (PR #1628 review)", () => {
  const row = (f: Fixture) => f.guard.rows.get(REMOTE)!;
  const pgError = (sqlState: string | null, retryable = false) =>
    new PostgreSqlStorageOperationError("STORAGE_OPERATION_FAILED", { domain: "factory", operation: "openSnapshot" }, sqlState, retryable);
  const transferThrowing = (f: Fixture, error: unknown): MigrationActivationTransferRuntime => ({
    ...f.deps.createTransferRuntime(SETTINGS),
    openReadOnlySnapshot: async () => { throw error; },
  });

  it.each([
    ["a definite readiness mismatch", new PostgreSqlRuntimeReadinessError("acl-shape", "inspectSchemaAcl"), "target-unhealthy", /^schema-mismatch: S7 transfer schema check and snapshot open: .*acl-shape/u],
    ["readiness server-preflight", new PostgreSqlRuntimeReadinessError("server-preflight", "inspectServerReadiness"), "target-unresolvable", /^schema-check-indeterminate: /u],
  ] as const)("the transfer schema check failing with %s refuses S7 and releases the lease", async (_name, error, reason, detail) => {
    const f = await fixture();
    const outcome = await f.run({ verifyTransferSchema: async () => { throw error; } });
    expect(outcome).toMatchObject({ status: "refused", step: "S7", reason, effectBegun: false });
    expect((outcome as { detail: string }).detail).toMatch(detail);
    expect(row(f).releasedAt).not.toBeNull();
    expect(f.manifestStore.read(GENERATION).phase).toBe("verified");
  });

  it.each([
    ["a lost connection (SQLSTATE 08006)", pgError("08006"), "target-unresolvable", /^connection-failed: /u],
    ["a refused privilege (SQLSTATE 42501)", pgError("42501"), "target-unhealthy", /^insufficient-privilege: /u],
    ["a retryable driver error without SQLSTATE", pgError(null, true), "target-unresolvable", /^connection-failed: /u],
  ] as const)("the snapshot open failing with %s refuses S7", async (_name, error, reason, detail) => {
    const f = await fixture();
    const outcome = await f.run({ createTransferRuntime: () => transferThrowing(f, error) });
    expect(outcome).toMatchObject({ status: "refused", step: "S7", reason });
    expect((outcome as { detail: string }).detail).toMatch(detail);
    expect(row(f).releasedAt).not.toBeNull();
  });

  it("the census read failing with a storage error is attributed too: closed runtime unresolvable, other preflight facts unhealthy", async () => {
    const f = await fixture();
    const closed = await f.run({ readDestinationCensus: async () => { throw new StorageOperationError("STORAGE_CLOSED", "postgresql", undefined, "factory", "census"); } });
    expect(closed).toMatchObject({ status: "refused", step: "S7", reason: "target-unresolvable", detail: expect.stringMatching(/^runtime-closed: S7 census read: /u) });
    const g = await fixture();
    const preflight = await g.run({ readDestinationCensus: async () => { throw new StorageOperationError("STORAGE_INITIALIZATION_FAILED", "postgresql", undefined, "factory", "census"); } });
    expect(preflight).toMatchObject({ status: "refused", step: "S7", reason: "target-unhealthy", detail: expect.stringMatching(/^server-preflight: S7 census read: .*operation census/u) });
  });

  it("errors outside the storage family are not target conditions and are rethrown, from the open and from the read", async () => {
    const f = await fixture();
    await expect(f.run({ createTransferRuntime: () => transferThrowing(f, new RangeError("raw open")) })).rejects.toBeInstanceOf(RangeError);
    expect(row(f).releasedAt).not.toBeNull();
    const g = await fixture();
    await expect(g.run({ readDestinationCensus: async () => { throw new TypeError("raw read"); } })).rejects.toBeInstanceOf(TypeError);
    // A readiness error for an unacceptable expectedOwner is a programming error, thrown as the health check throws it.
    const h = await fixture();
    await expect(h.run({ verifyTransferSchema: async () => { throw new PostgreSqlRuntimeReadinessError("invalid-expected-owner", "inspectSchemaAcl"); } })).rejects.toMatchObject({ name: "MigrationTargetHealthError", reason: "invalid-input" });
  });

  it("on an effect-begun re-entry the S7 target failure is the roll-forward interruption and keeps the lease", async () => {
    const f = await fixture();
    await stopAt(f, "after-prepare-begin");
    const outcome = await f.run({ verifyTransferSchema: async () => { throw new PostgreSqlRuntimeReadinessError("acl-shape", "inspectSchemaAcl"); } });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", effectBegun: true, detail: expect.stringMatching(/^S7 target-unhealthy on roll-forward: schema-mismatch: /u) });
    expect(row(f).releasedAt).toBeNull();
    expectActivated(f, await f.run(), "prepare-activation-pending");
  });

  const portableUnavailable = (cause: unknown) => new PortableStreamError("source-unavailable", { cause });
  /** A captureDestinationIdentity that rejects on its nth call (0 = S0, 1 = S5, 2 = S7) and otherwise answers the sealed identity. */
  const identityFailingAt = (f: Fixture, nth: number, error: unknown) => {
    const answer = f.deps.captureDestinationIdentity;
    let calls = 0;
    return (...args: Parameters<typeof answer>) => (calls++ === nth ? Promise.reject(error) : answer(...args));
  };

  it.each([
    ["a lost connection (SQLSTATE 08006)", pgError("08006"), "target-unresolvable", /^connection-failed: S7 census read was lost/u],
    ["a refused privilege (SQLSTATE 42501)", pgError("42501"), "target-unhealthy", /^insufficient-privilege: S7 census read: /u],
  ] as const)("the production census reader's PortableStreamError(source-unavailable) wrapping %s is unwrapped and refuses S7", async (_name, cause, reason, detail) => {
    const f = await fixture();
    const outcome = await f.run({ readDestinationCensus: async () => { throw portableUnavailable(cause); } });
    expect(outcome).toMatchObject({ status: "refused", step: "S7", reason, effectBegun: false });
    expect((outcome as { detail: string }).detail).toMatch(detail);
    expect(row(f).releasedAt).not.toBeNull();
  });

  it("an effect-begun re-entry turns the unwrapped census failure into the roll-forward interruption and keeps the lease", async () => {
    const f = await fixture();
    await stopAt(f, "after-prepare-begin");
    const outcome = await f.run({ readDestinationCensus: async () => { throw portableUnavailable(pgError("08006")); } });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", effectBegun: true, detail: expect.stringMatching(/^S7 target-unresolvable on roll-forward: connection-failed: /u) });
    expect(row(f).releasedAt).toBeNull();
    expectActivated(f, await f.run(), "prepare-activation-pending");
  });

  it("a PortableStreamError that is not source-unavailable, or has no storage cause, is not a target condition and is rethrown", async () => {
    const f = await fixture();
    await expect(f.run({ readDestinationCensus: async () => { throw new PortableStreamError("source-invalid"); } })).rejects.toMatchObject({ name: "PortableStreamError", code: "source-invalid" });
    expect(row(f).releasedAt).not.toBeNull();
    const g = await fixture();
    await expect(g.run({ readDestinationCensus: async () => { throw portableUnavailable(new RangeError("raw cause")); } })).rejects.toMatchObject({ name: "PortableStreamError", code: "source-unavailable" });
    const h = await fixture();
    await expect(h.run({ readDestinationCensus: async () => { throw new PortableStreamError("source-unavailable"); } })).rejects.toMatchObject({ code: "source-unavailable" });
  });

  it("an aborted census read is a cancellation and rejects, even when the error carries a storage cause", async () => {
    const f = await fixture();
    await expect(f.run({ readDestinationCensus: async () => { throw new PortableStreamError("aborted", { cause: pgError("08006") }); } })).rejects.toMatchObject({ name: "PortableStreamError", code: "aborted" });
    expect(row(f).releasedAt).not.toBeNull();
    const g = await fixture();
    await stopAt(g, "after-prepare-begin");
    await expect(g.run({ readDestinationCensus: async () => { throw new PortableStreamError("aborted"); } })).rejects.toMatchObject({ code: "aborted" });
    expect(row(g).releasedAt).toBeNull();
  });

  it.each([
    ["S0", "a lost connection (SQLSTATE 08006)", 0, pgError("08006"), "target-unresolvable", /^connection-failed: S0 destination identity query was lost/u],
    ["S0", "a refused privilege (SQLSTATE 42501)", 0, pgError("42501"), "target-unhealthy", /^insufficient-privilege: S0 destination identity query: /u],
    ["S5", "a lost connection (SQLSTATE 08006)", 1, pgError("08006"), "target-unresolvable", /^connection-failed: S5 destination identity query was lost/u],
    ["S5", "a refused privilege (SQLSTATE 42501)", 1, pgError("42501"), "target-unhealthy", /^insufficient-privilege: S5 destination identity query: /u],
    ["S7", "a lost connection (SQLSTATE 08006)", 2, pgError("08006"), "target-unresolvable", /^connection-failed: S7 destination identity query was lost/u],
    ["S7", "a refused privilege (SQLSTATE 42501)", 2, pgError("42501"), "target-unhealthy", /^insufficient-privilege: S7 destination identity query: /u],
  ] as const)("the %s destination identity query failing with %s refuses that step and releases the pre-effect lease", async (step, _name, nth, error, reason, detail) => {
    const f = await fixture();
    const outcome = await f.run({ captureDestinationIdentity: identityFailingAt(f, nth, error) });
    expect(outcome).toMatchObject({ status: "refused", step, reason, effectBegun: false });
    expect((outcome as { detail: string }).detail).toMatch(detail);
    if (step !== "S0") expect(row(f).releasedAt).not.toBeNull();
    expect(f.manifestStore.read(GENERATION).phase).toBe("verified");
  });

  it.each([
    ["S5", 1],
    ["S7", 2],
  ] as const)("on an effect-begun re-entry the %s identity query failure is the roll-forward interruption and keeps the lease", async (step, nth) => {
    const f = await fixture();
    await stopAt(f, "after-prepare-begin");
    const outcome = await f.run({ captureDestinationIdentity: identityFailingAt(f, nth, pgError("08006")) });
    expect(outcome).toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", effectBegun: true, detail: expect.stringMatching(new RegExp("^" + step + " target-unresolvable on roll-forward: connection-failed: " + step + " destination identity query was lost", "u")) });
    expect(row(f).releasedAt).toBeNull();
    expectActivated(f, await f.run(), "prepare-activation-pending");
  });

  it("an identity query failing with a wrapped storage error is attributed, and with an unknown or aborted error is rethrown", async () => {
    const f = await fixture();
    expect(await f.run({ captureDestinationIdentity: identityFailingAt(f, 2, portableUnavailable(pgError("42501"))) })).toMatchObject({ status: "refused", step: "S7", reason: "target-unhealthy" });
    const g = await fixture();
    await expect(g.run({ captureDestinationIdentity: identityFailingAt(g, 2, new RangeError("raw")) })).rejects.toBeInstanceOf(RangeError);
    expect(row(g).releasedAt).not.toBeNull();
    const h = await fixture();
    await expect(h.run({ captureDestinationIdentity: identityFailingAt(h, 2, new PortableStreamError("aborted")) })).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("runMigrationActivation: the release tail and the abort family are driven without an own fence (PR #1628 review)", () => {
  const row = (f: Fixture) => f.guard.rows.get(REMOTE);
  const foreignRow = (f: Fixture, overrides: Partial<PostgreSqlBackendPublicationFence> = {}) => {
    f.guard.rows.delete(REMOTE);
    f.guard.seed({ projectId: REMOTE, publicationId: "another-publication", ...overrides });
  };

  it("crash at released with the fence row gone: the retry drives the journal to completed and activates", async () => {
    const f = await fixture();
    await crashCoordinatorAt(f, "released");
    expect(row(f)!.releasedAt).not.toBeNull();
    f.guard.rows.delete(REMOTE);
    const mutations = f.guard.calls.filter((c) => c !== "read").length;
    const outcome = await f.run();
    expectActivated(f, outcome, "publication-journal");
    if (outcome.status !== "activated") return;
    expect(outcome.successorFencingToken).toBeNull();
    // No lease continuation, acquire or release ran: the coordinator owns the fences in the release tail.
    expect(f.guard.calls.filter((c) => c !== "read")).toHaveLength(mutations);
    expect(row(f)).toBeUndefined();
  });

  it("crash at releasing with the fence already released (row kept): the retry completes the release tail and activates", async () => {
    const f = await fixture();
    await crashCoordinatorAt(f, "releasing");
    // The journal entered releasing before the fence was released; release it as the coordinator would have.
    const held = row(f)!;
    f.guard.rows.set(REMOTE, { ...held, releasedAt: "2026-10-16T13:00:05.000Z" });
    const renews = f.guard.calls.filter((c) => c === "renew").length;
    const outcome = await f.run();
    expectActivated(f, outcome, "publication-journal");
    expect(f.guard.calls.filter((c) => c === "renew")).toHaveLength(renews);
  });

  it("crash at releasing with the fence row gone: the orchestrator no longer stops at S13b; the coordinator, which must release that row, reports it", async () => {
    const f = await fixture();
    await crashCoordinatorAt(f, "releasing");
    f.guard.rows.delete(REMOTE);
    // Before the fix this was interrupted S13b lease-lost without ever reaching the drive.
    await expect(f.run()).rejects.toThrow("remote release evidence is missing");
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("releasing");
  });

  it("crash at released with a successor publication's row present (Bug #1651): the retry finishes locally and never touches that row", async () => {
    const f = await fixture();
    await crashCoordinatorAt(f, "released");
    // Another home acquired the released row for its own publication.
    foreignRow(f, { machineId: "018f0b5d-ffff-7abc-8def-1234567890ab" });
    const successor = { ...row(f)! };
    const mutations = f.guard.calls.filter((c) => c !== "read").length;
    const outcome = await f.run();
    expectActivated(f, outcome, "publication-journal");
    if (outcome.status !== "activated") return;
    expect(outcome.successorFencingToken).toBeNull();
    expect(f.guard.calls.filter((c) => c !== "read")).toHaveLength(mutations);
    expect(row(f)).toEqual(successor);
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("completed");
  });

  it("crash at completed with a successor publication's row present (Bug #1651): the retry settles the report and never touches that row", async () => {
    const f = await fixture();
    await crashCoordinatorAt(f, "completed");
    foreignRow(f, { evidenceSha256: "f".repeat(64) });
    const successor = { ...row(f)! };
    const mutations = f.guard.calls.filter((c) => c !== "read").length;
    const outcome = await f.run();
    expectActivated(f, outcome, "publication-journal");
    if (outcome.status !== "activated") return;
    expect(outcome.successorFencingToken).toBeNull();
    expect(f.guard.calls.filter((c) => c !== "read")).toHaveLength(mutations);
    expect(row(f)).toEqual(successor);
  });

  it("a fence of another publication or evidence digest stays lease-lost at releasing; an unattributable read is lease-unresolvable", async () => {
    const f = await fixture();
    await crashCoordinatorAt(f, "releasing");
    foreignRow(f);
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost", effectBegun: true, detail: "the fenced lease row names another publication" });
    foreignRow(f, { publicationId: f.publicationId, evidenceSha256: "d".repeat(64) });
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost", detail: expect.stringContaining("does not match the expected") });
    f.guard.read = async (input) => { throw new PostgreSqlStorageOperationError("STORAGE_OPERATION_FAILED", { domain: "factory", operation: "read" }, "08006", true); };
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-unresolvable" });
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("releasing");
  });
  it("the abort family is handled like the release tail: an absent own fence at abort-releasing reaches the drive without a lease continuation", async () => {
    const f = await fixture();
    await crashCoordinatorAt(f, "prepared");
    f.guard.rows.delete(REMOTE);
    const read = f.deps.readPublicationJournal;
    const unwinding = (h: string) => { const j = read(h); return j === null ? null : { ...j, phase: "abort-releasing" as const }; };
    const renews = f.guard.calls.filter((c) => c === "renew").length;
    const outcome = await f.run({
      readPublicationJournal: unwinding,
      drive: async () => ({ status: "aborted", detail: "unwound by the coordinator", journal: null, fenceChecks: [], dispatch: "abort-completion" }),
    });
    expect(outcome).toMatchObject({ status: "publication-failed", publication: { status: "aborted", dispatch: "abort-completion" } });
    expect(f.guard.calls.filter((c) => c === "renew")).toHaveLength(renews);
    // A foreign row in the same phase is still a lost lease.
    foreignRow(f);
    expect(await f.run({ readPublicationJournal: unwinding })).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost" });
    // Outside those phases (prepared), an absent row is still a lost lease.
    f.guard.rows.delete(REMOTE);
    expect(await f.run()).toMatchObject({ status: "interrupted", step: "S13b", cause: "lease-lost", detail: "no fenced lease row exists for this generation" });
  });
});
