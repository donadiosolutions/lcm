import { expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedPostgreSqlConfig } from "../../src/daemon/config.js";
import { ensurePendingMachineIdentity, finalizeMachineIdentity } from "../../src/machine-identity.js";
import { clearProjectMapCache, hashProjectPath, normalizeProjectPath, projectMapPath } from "../../src/project-map.js";
import { lcmHomeDir, projectsDir } from "../../src/runtime-paths.js";
import {
  BackendPublicationCoordinator,
  backendPublicationJournalPath,
  backendPublicationCanonicalSha256,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  rebindBackendMaintenanceCutoff,
  resolveBackendMaintenanceGenerationBinding,
  withBackendPublicationAppendBarrierAsync,
  type BackendMaintenanceJournal,
  type BackendPublicationObserver,
} from "../../src/storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../../src/storage/backend-publication-driver.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import type { PostgreSqlRuntimeHealth } from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlBackendPublicationGuardError,
  type PostgreSqlBackendPublicationAcquireInput,
  type PostgreSqlBackendPublicationFence,
  type PostgreSqlBackendPublicationMutationInput,
} from "../../src/storage/postgresql/publication-guard.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../src/storage/postgresql/publication-remote-guard.js";
import type { PostgreSqlRuntimeReadiness } from "../../src/storage/postgresql/runtime-readiness.js";
import { PORTABLE_RECORD_DOMAIN_ORDER, type PortableDomain } from "../../src/storage/portable-record.js";
import {
  createMigrationActivationDependencies,
  type MigrationActivationOrdinaryRuntime,
  type MigrationActivationTransferRuntime,
} from "../../src/migration/activate-generation.js";
import { readActivationGenerationLink } from "../../src/migration/activation-artifact-store.js";
import { readMigrationActivationEvidence } from "../../src/migration/activation-evidence-store.js";
import type { ActivationLeasePublicationGuard } from "../../src/migration/activation-lease.js";
import { readMigrationActivationReport } from "../../src/migration/activation-report.js";
import { migrationWitnessSha256 } from "../../src/migration/activation-witness.js";
import { migrationCopyTargetGeneration } from "../../src/migration/copy-source.js";
import {
  activateCutoverSet,
  createCutoverSetActivateDependencies,
  type CutoverSetActivateDependencies,
  type CutoverSetActivateInput,
  type CutoverSetActivateResult,
} from "../../src/migration/cutover-set-activate.js";
import { readCutoverSetActivationRecords } from "../../src/migration/cutover-set-activation-store.js";
import { cutoverSetMaintenanceEntry, type CutoverSetManifest } from "../../src/migration/cutover-set.js";
import { computeCutoverSetBase, computeMigrationGenerationBase, nonSecretPostgreSqlTargetCoordinates } from "../../src/migration/generation-identity.js";
import { resolveMigrationWitnessBindings } from "../../src/migration/generation-binding-store.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { computeMigrationProjectMapWitnessSha256 } from "../../src/migration/project-map-witness.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  type MigrationManifest,
  type MigrationStorageWitness,
} from "../../src/migration/protocol.js";
import type { MigrationTargetHealthResult } from "../../src/migration/target-health.js";
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

/**
 * A real two-project (optionally three) SQLite home prepared as a held set:
 * real manifest, report, evidence, binding, artifact and set record stores,
 * a real coordinator over the real driver and the real PostgreSQL remote
 * guard provider over an in-memory lease guard; fake PostgreSQL runtimes for
 * health, identity, copy bindings and destination census rows; the held
 * snapshot inspection and the destination identity resolution are stubbed
 * from the live journal and the fixture's remote ids.
 */

export const MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";
export const REMOTES = ["018f22c4-6d2a-7f10-8a4c-6b8d3e5f9001", "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9002", "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9003"] as const;
export const DEST_IDENTITY = "d".repeat(64);
export const SYSTEM_ID = "712345";
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);
export const TARGET_URL = "postgresql://lcm@db.example.test:5432/lcm";
export const READINESS: PostgreSqlRuntimeReadiness = {
  currentMigrationIds: [], expectedOwner: "lcm_migrator", runtimeRole: "lcm", managedObjectCount: 0, definitionObjectCount: 0, privilegeManifestVersion: 1,
};
export const TARGET_CONFIG = {
  backend: "postgresql",
  postgresql: {
    url: TARGET_URL, caFile: "/dev/null", poolMax: 1, connectionTimeoutMs: 1000, idleTimeoutMs: 1000, statementTimeoutMs: 1000,
    snapshotIdleTimeoutMs: 1000, migrationRole: "lcm_migrator",
  },
} as unknown as ResolvedPostgreSqlConfig;

export const roots: string[] = [];
export function cleanupRoots(): void {
  clearProjectMapCache();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

function domainVector<T>(build: (domain: PortableDomain, index: number) => T): T[] {
  return PORTABLE_RECORD_DOMAIN_ORDER.map(build);
}

export function domainCensus(seed: string): MigrationVerificationDomainCensus[] {
  return domainVector((domain, index) => ({
    domain, recordCount: index, prefixSha256: migrationWitnessSha256([seed, domain]), terminalIdentitySha256: migrationWitnessSha256(["delta", domain]),
  }));
}

function witness(backend: MigrationStorageWitness["backend"], capturedAt: string): MigrationStorageWitness {
  const base = { version: 1 as const, backend, identitySha256: backend === "postgresql" ? DEST_IDENTITY : HASH_A, schemaSha256: HASH_B, contentSha256: HASH_C, capturedAt };
  return backend === "postgresql" ? { ...base, systemIdentifier: SYSTEM_ID } : base;
}

/** In-memory PostgreSQL lease guard mirroring publication-guard.ts's rules (one row per project). */
export class FakeLeaseGuard implements ActivationLeasePublicationGuard {
  readonly rows = new Map<string, PostgreSqlBackendPublicationFence>();
  nextToken = 1n;
  readonly calls: string[] = [];
  expireNextFor: string | null = null;

  private error(projectId: string, operation: string, reason: PostgreSqlBackendPublicationGuardError["reason"]): never {
    throw new PostgreSqlBackendPublicationGuardError(projectId, operation, reason);
  }

  private admit(operation: string, signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new Error("fake guard " + operation + " refused an aborted signal");
  }

  seed(fence: Partial<PostgreSqlBackendPublicationFence> & { projectId: string }): void {
    this.rows.set(fence.projectId, {
      machineId: MACHINE, publicationId: "other", targetBackend: "postgresql", evidenceSha256: HASH_A,
      fencingToken: this.nextToken++, acquiredAt: "2026-10-16T00:00:00.000Z", renewedAt: "2026-10-16T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z", releasedAt: null, databaseExpired: false, ...fence,
    });
  }

  expire(projectId: string): void {
    const row = this.rows.get(projectId);
    if (row !== undefined) this.rows.set(projectId, { ...row, databaseExpired: true });
  }

  async acquire(input: PostgreSqlBackendPublicationAcquireInput): Promise<PostgreSqlBackendPublicationFence> {
    this.calls.push("acquire:" + input.projectId);
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
    this.calls.push("renew:" + input.projectId);
    this.admit("renew", input.signal);
    const current = this.rows.get(input.projectId);
    if (this.expireNextFor === input.projectId && current !== undefined) { this.expireNextFor = null; this.rows.set(input.projectId, { ...current, databaseExpired: true }); }
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
    this.calls.push("release:" + input.projectId);
    this.admit("release", input.signal);
    const row = this.rows.get(input.projectId);
    if (row === undefined || row.fencingToken !== input.fencingToken || row.releasedAt !== null || row.databaseExpired) {
      this.error(input.projectId, "release", "fence-mismatch");
    }
    const released = { ...row, releasedAt: "2026-10-16T00:00:02.000Z" };
    this.rows.set(input.projectId, released);
    return released;
  }

  async read(input: Pick<PostgreSqlBackendPublicationMutationInput, "projectId" | "targetBackend" | "evidenceSha256" | "signal">): Promise<PostgreSqlBackendPublicationFence | null> {
    this.calls.push("read:" + input.projectId);
    this.admit("read", input.signal);
    const row = this.rows.get(input.projectId);
    if (row === undefined) return null;
    if (row.targetBackend !== input.targetBackend || row.evidenceSha256 !== input.evidenceSha256) this.error(input.projectId, "read", "fence-mismatch");
    return row;
  }
}

export type FixtureMember = Readonly<{
  index: number;
  cwd: string;
  canonical: string;
  localProjectId: string;
  remoteProjectId: string;
  generationId: string;
  copyBindingSha256: string;
  report: MigrationVerificationReport;
}>;

export type Fixture = Readonly<{
  homeDir: string;
  setId: string;
  manifest: CutoverSetManifest;
  members: readonly FixtureMember[];
  guard: FakeLeaseGuard;
  manifestStore: MigrationManifestStore;
  deps: CutoverSetActivateDependencies & {
    health: MigrationTargetHealthResult[];
    identity: { sealedWitnessSha256: string; systemIdentifier: string };
    transferRows: Map<string, Array<{ run_id: unknown; state: unknown }>>;
    destinationCensus: Map<string, MigrationVerificationDomainCensus[]>;
    snapshotChecksumOverride: Map<string, string>;
    identityOverride: Map<string, StorageIdentityContext | { status: "refuse"; reason: string }>;
    sourceSelectionOverride: Map<string, string>;
    prepareCalls: number;
  };
  input: CutoverSetActivateInput;
  run: (overrides?: Partial<CutoverSetActivateDependencies>) => Promise<CutoverSetActivateResult>;
  coordinator: (observer?: BackendPublicationObserver) => BackendPublicationCoordinator;
  journal: () => BackendMaintenanceJournal | null;
  /** Rewrite the maintenance journal in place with a recomputed checksum. */
  rewriteJournal: (edit: (payload: Record<string, any>) => void) => void;
}>;

function registerMachine(homeDir: string): void {
  const pending = ensurePendingMachineIdentity("Test Machine", homeDir).identity;
  finalizeMachineIdentity(pending, MACHINE, "Test Machine", homeDir);
}

/** Drive a genesis manifest through the legal effects to verified + eligible. */
export function driveToVerified(store: MigrationManifestStore, generationId: string, report: MigrationVerificationReport, stopAt?: "copied"): MigrationManifest {
  const at = (n: number) => "2026-10-16T12:00:" + String(n).padStart(2, "0") + ".000Z";
  let manifest = store.read(generationId);
  const effect = (kind: Parameters<typeof beginMigrationEffect>[1]["kind"], complete: Omit<Parameters<typeof completeMigrationEffect>[1], "effectId" | "completedAt">, n: number) => {
    manifest = store.update(generationId, manifest.checksumSha256, (m) => beginMigrationEffect(m, { effectId: kind + "-1", kind, inputSha256: HASH_A, startedAt: at(n) }));
    manifest = store.update(generationId, manifest.checksumSha256, (m) => completeMigrationEffect(m, { effectId: kind + "-1", completedAt: at(n + 1), ...complete }));
  };
  effect("verify-dry-run", { report: { kind: "dry-run", reportId: "dry-run-1", reportSha256: HASH_B, createdAt: at(1) } }, 1);
  effect("copy-batch", { checkpoint: { domain: "messages", ordinal: 1, recordCount: 1, sourceCheckpointSha256: HASH_A, destinationCommitSha256: HASH_B } }, 3);
  effect("complete-copy", {}, 5);
  if (stopAt === "copied") return manifest;
  effect("verify-generation", { report: { kind: "verification", reportId: report.reportId, reportSha256: report.reportSha256, createdAt: at(7) }, activationEligible: true }, 7);
  return manifest;
}

export function buildReport(homeDir: string, generationId: string, localProjectId: string, remoteProjectId: string, evidence: string, overrides: Partial<CreateMigrationVerificationReportInput> = {}): MigrationVerificationReport {
  const projectMapWitnessSha256 = computeMigrationProjectMapWitnessSha256({ homeDir, localProjectId, remoteProjectId, mode: "pre-publication" });
  return createMigrationVerificationReport({
    generationId,
    targetGenerationId: migrationCopyTargetGeneration(generationId),
    bindingSha256: evidence,
    manifestRevision: 4,
    manifestChecksumSha256: HASH_B,
    sourceWitness: { version: 1, identitySha256: HASH_A, schemaSha256: HASH_B, contentSha256: HASH_C },
    destinationIdentity: { version: 1, sealedWitnessSha256: DEST_IDENTITY, systemIdentifier: SYSTEM_ID },
    destinationSchemaWitness: { version: 1, migrationsSha256: HASH_A, searchConfigurationSha256: HASH_B, collationSha256: HASH_C, sequenceStateSha256: HASH_A },
    projectMapWitnessSha256,
    queueClassificationWitness: { version: 1, queueCutoff: "0000000000000000001", queueSetSha256: HASH_A, receiptSetSha256: HASH_B, epochChecksumSha256: HASH_C },
    censusVector: buildMigrationCensusVector(domainCensus("census-" + localProjectId.slice(0, 4))),
    canonicalDelta: buildMigrationCanonicalDelta(domainCensus("census-" + localProjectId.slice(0, 4))),
    classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({ class: mismatchClass, ran: true })),
    sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: HASH_A },
    publicProbeSha256: migrationWitnessSha256(["probe"]),
    publicProbeCoverage: MIGRATION_PUBLIC_PROBE_ORDER.map((probe) => ({ probe, ran: true })),
    mismatches: [],
    mismatchTotals: [],
    ...overrides,
  });
}

export type FixtureOptions = Readonly<{
  members?: number;
  /** Skip the set hold entirely (no journal). */
  held?: boolean;
  /** Leave this member's binding at its entry sentinel (not captured). */
  uncaptured?: number;
  /** Leave this member's manifest at copied with an ineligible report. */
  notVerified?: number;
  /** Do not create this member's manifest at all. */
  noManifest?: number;
  /** Add a project directory with data that is not a member. */
  extraProjectWithData?: boolean;
  /** Report overrides per member index. */
  reportOverrides?: Record<number, Partial<CreateMigrationVerificationReportInput>>;
}>;

export async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const count = options.members ?? 2;
  const homeDir = mkdtempSync(join(tmpdir(), "lcm-cutover-set-activate-"));
  roots.push(homeDir);
  mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
  writeFileSync(join(lcmHomeDir(homeDir), "config.json"), JSON.stringify({ storage: { backend: "sqlite" }, daemon: { port: 4321 } }) + "\n", { mode: 0o600 });
  const coordinates = nonSecretPostgreSqlTargetCoordinates(TARGET_URL);
  const raw = Array.from({ length: count }, (_, index) => {
    const cwd = join(homeDir, "repo-" + String(index + 1));
    mkdirSync(cwd, { mode: 0o700 });
    const canonical = normalizeProjectPath(cwd);
    const localProjectId = hashProjectPath(canonical);
    return { index, cwd, canonical, localProjectId };
  }).sort((left, right) => (left.localProjectId < right.localProjectId ? -1 : 1));
  const map: Record<string, unknown> = {};
  for (const project of raw) map[project.localProjectId] = { canonical: project.canonical, aliases: [] };
  if (options.extraProjectWithData) {
    mkdirSync(join(projectsDir(homeDir), HASH_B), { recursive: true, mode: 0o700 });
    writeFileSync(join(projectsDir(homeDir), HASH_B, "db.sqlite"), "sqlite", { mode: 0o600 });
    map[HASH_B] = { canonical: "/repos/other", aliases: [] };
  }
  writeFileSync(projectMapPath(homeDir), JSON.stringify(map) + "\n", { mode: 0o600 });
  clearProjectMapCache();
  registerMachine(homeDir);
  const manifestStore = new MigrationManifestStore({ homeDir });
  const reportStore = new MigrationVerificationReportStore({ homeDir });
  const members: FixtureMember[] = raw.map((project, position) => {
    mkdirSync(join(projectsDir(homeDir), project.localProjectId), { recursive: true, mode: 0o700 });
    writeFileSync(join(projectsDir(homeDir), project.localProjectId, "db.sqlite"), "sqlite", { mode: 0o600 });
    const remoteProjectId = REMOTES[position]!;
    const generationId = computeMigrationGenerationBase({ physicalProjectId: project.localProjectId, canonicalPath: project.canonical, target: coordinates }) + "-1";
    const copyBindingSha256 = migrationWitnessSha256(["copy-binding", project.localProjectId]);
    const report = buildReport(homeDir, generationId, project.localProjectId, remoteProjectId, copyBindingSha256, {
      ...(options.notVerified === position ? { activationEligible: false } : {}),
      ...(options.reportOverrides?.[position] ?? {}),
    });
    reportStore.persist(generationId, report);
    if (options.noManifest !== position) {
      manifestStore.create(createMigrationManifest({
        generationId,
        source: witness("sqlite", "2026-10-16T11:00:00.000Z"),
        destination: witness("postgresql", "2026-10-16T11:00:01.000Z"),
        parentGenerationId: null,
        preservedSourceGenerationId: "source-generation-" + String(position + 1),
        createdAt: "2026-10-16T11:00:00.000Z",
      }));
      driveToVerified(manifestStore, generationId, report, options.notVerified === position ? "copied" : undefined);
    }
    return { index: position, cwd: project.cwd, canonical: project.canonical, localProjectId: project.localProjectId, remoteProjectId, generationId, copyBindingSha256, report };
  });
  const sourceSelection = (member: FixtureMember) => migrationWitnessSha256(["source-selection", member.localProjectId]);
  const manifestMembers = members.map((member) => ({ physicalProjectId: member.localProjectId, generationId: member.generationId, sourceSelectionSha256: sourceSelection(member) }));
  const setId = computeCutoverSetBase({ target: coordinates, members: manifestMembers.map(({ physicalProjectId, generationId }) => ({ physicalProjectId, generationId })) }) + "-1";
  const manifest: CutoverSetManifest = { version: 1, setId, machineId: MACHINE, members: manifestMembers };

  const guard = new FakeLeaseGuard();
  const coordinator = (observer?: BackendPublicationObserver) => createBackendPublicationCoordinator({
    homeDir, observer,
    remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId: MACHINE, ttlMs: 60_000 }) },
  });
  if (options.held !== false) {
    await coordinator().enterMaintenance({ ...cutoverSetMaintenanceEntry(manifest), now: new Date("2026-10-16T12:30:00.000Z") });
    for (const [position, member] of members.entries()) {
      if (options.uncaptured === position) continue;
      await withBackendPublicationAppendBarrierAsync(homeDir, async (token) => {
        const journal = readBackendMaintenanceJournal(homeDir)!;
        const view = resolveBackendMaintenanceGenerationBinding(journal, member.generationId)!;
        rebindBackendMaintenanceCutoff({
          homeDir, expectedChecksumSha256: view.checksumSha256, generationId: member.generationId, sourceSelectionSha256: view.sourceSelectionSha256,
          queueEvidenceSha256: migrationWitnessSha256(["queue", member.localProjectId]),
          roster: [{ machineId: MACHINE, queueCutoff: "000000000000000000" + String(position + 1), evidenceSha256: migrationWitnessSha256(["queue", member.localProjectId]) }],
        }, token);
      });
    }
  }

  const health: MigrationTargetHealthResult[] = [];
  const identity = { sealedWitnessSha256: DEST_IDENTITY, systemIdentifier: SYSTEM_ID };
  const transferRows = new Map(members.map((member) => [member.remoteProjectId, [{ run_id: "migration-copy-" + member.copyBindingSha256, state: "completed" }]]));
  const destinationCensus = new Map(members.map((member) => [member.remoteProjectId, domainCensus("census-" + member.localProjectId.slice(0, 4))]));
  const snapshotChecksumOverride = new Map<string, string>();
  const identityOverride = new Map<string, StorageIdentityContext | { status: "refuse"; reason: string }>();
  const sourceSelectionOverride = new Map<string, string>();
  const ordinary = (): MigrationActivationOrdinaryRuntime => ({
    health: async (): Promise<PostgreSqlRuntimeHealth> => ({ status: "healthy", backend: "postgresql" }),
    query: (async () => ({ rows: [] })) as unknown as MigrationActivationOrdinaryRuntime["query"],
    backendPublicationGuard: () => guard,
    close: async () => undefined,
  });
  const transfer = (): MigrationActivationTransferRuntime => ({
    query: (async (query: { values?: unknown[] }) => ({ rows: transferRows.get(String(query.values?.[0])) ?? [] })) as unknown as MigrationActivationTransferRuntime["query"],
    openReadOnlySnapshot: async () => ({ query: (async () => ({ rows: [] })) as unknown as MigrationActivationTransferRuntime["query"], close: async () => undefined }),
    close: async () => undefined,
  });
  const base = createCutoverSetActivateDependencies({ homeDir });
  const single = createMigrationActivationDependencies({ homeDir });
  void single;
  const deps: Fixture["deps"] = {
    ...base,
    health, identity, transferRows, destinationCensus, snapshotChecksumOverride, identityOverride, sourceSelectionOverride, prepareCalls: 0,
    createOrdinaryRuntime: ordinary,
    createTransferRuntime: transfer,
    verifyTransferSchema: async () => READINESS,
    checkTargetHealth: async () => health.shift() ?? ({ status: "healthy", readiness: READINESS }),
    captureDestinationIdentity: async () => ({ version: 1, ...identity }),
    readDestinationCensus: async (_session, census) => ({ census: destinationCensus.get(census.expectedIdentity.remoteProjectId!)! }),
    createCoordinator: () => {
      const real = coordinator();
      const prepare = real.prepare.bind(real);
      real.prepare = (async (input: Parameters<typeof prepare>[0], token: Parameters<typeof prepare>[1]) => { deps.prepareCalls += 1; return prepare(input, token); }) as typeof real.prepare;
      return real;
    },
    machineId: () => MACHINE,
    daemonPort: () => 4321,
    checkRestart: async () => ({ status: "satisfied", reason: "no-pid-file", detail: "fake", pid: null, observedBackend: null, selectedBackend: "postgresql" }),
    leaseTtlMs: 60_000,
    resolveAuthorities: () => ({
      status: "resolved",
      outcomes: members.map((member) => ({
        physicalProjectId: member.localProjectId, status: "authenticated",
        authority: { physicalProjectId: member.localProjectId, canonicalPath: member.canonical, sourceSelectionSha256: sourceSelectionOverride.get(member.localProjectId) ?? sourceSelection(member) } as never,
      })),
    }),
    resolveExpectedIdentity: async (request) => {
      const member = members.find((candidate) => candidate.canonical === normalizeProjectPath(request.cwd))!;
      const override = identityOverride.get(member.localProjectId);
      if (override !== undefined && "status" in override) return { status: "refuse", reason: override.reason };
      const expectedIdentity: StorageIdentityContext = override ?? { id: member.remoteProjectId, remoteProjectId: member.remoteProjectId, localProjectId: member.localProjectId, machineId: MACHINE, canonical: member.canonical, selectedPath: member.canonical } as StorageIdentityContext;
      return { status: "resolved", expectedIdentity, effects: { localProject: "reused", destinationProject: "reused" } };
    },
    inspectSnapshot: async (generationId) => {
      const member = members.find((candidate) => candidate.generationId === generationId)!;
      const view = resolveBackendMaintenanceGenerationBinding(readBackendMaintenanceJournal(homeDir), generationId);
      return {
        artifact: {
          maintenanceChecksumSha256: snapshotChecksumOverride.get(generationId) ?? view?.checksumSha256 ?? "0".repeat(64),
          authority: { physicalProjectId: member.localProjectId },
          sourceSelectionSha256: sourceSelection(member),
        },
      } as unknown as Awaited<ReturnType<CutoverSetActivateDependencies["inspectSnapshot"]>>;
    },
  };
  const input: CutoverSetActivateInput = { homeDir, confirmSetId: setId, targetConfig: TARGET_CONFIG, now: () => new Date("2026-10-16T13:00:00.000Z") };
  const rewriteJournal = (edit: (payload: Record<string, any>) => void): void => {
    const { checksumSha256: _checksum, ...payload } = JSON.parse(readFileSync(backendPublicationJournalPath(homeDir), "utf8")) as Record<string, any>;
    edit(payload);
    writeFileSync(backendPublicationJournalPath(homeDir), JSON.stringify({ ...payload, checksumSha256: backendPublicationCanonicalSha256(payload) }) + "\n", { mode: 0o600 });
  };
  return {
    homeDir, setId, manifest, members, guard, manifestStore, deps, input,
    run: (overrides = {}) => activateCutoverSet(input, { ...deps, ...overrides }),
    coordinator,
    journal: () => readBackendMaintenanceJournal(homeDir),
    rewriteJournal,
  };
}

/** The effective home selection: the config backend and every member's map binding; never one project on each backend. */
export function effectiveHome(f: Fixture): Readonly<{ backend: string; bound: readonly boolean[] }> {
  const config = JSON.parse(readFileSync(join(lcmHomeDir(f.homeDir), "config.json"), "utf8")) as { storage: { backend: string } };
  const map = JSON.parse(readFileSync(projectMapPath(f.homeDir), "utf8")) as Record<string, { remoteProjectId?: string }>;
  return { backend: config.storage.backend, bound: f.members.map((member) => map[member.localProjectId]?.remoteProjectId === member.remoteProjectId) };
}

export function expectAllOld(f: Fixture): void {
  const home = effectiveHome(f);
  expect(home.backend).toBe("sqlite");
  expect(home.bound.every((bound) => !bound)).toBe(true);
}

export function expectAllNew(f: Fixture): void {
  const home = effectiveHome(f);
  expect(home.backend).toBe("postgresql");
  expect(home.bound.every((bound) => bound)).toBe(true);
}

export function expectNoEffects(f: Fixture): void {
  for (const member of f.members) {
    const manifest = f.manifestStore.read(member.generationId);
    expect(manifest.phase).toBe("verified");
    expect(manifest.pendingEffect).toBeNull();
  }
  expectAllOld(f);
  expect(readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId })).toEqual({ state: "authoritatively-absent" });
  for (const row of f.guard.rows.values()) expect(row.releasedAt).not.toBeNull();
}

export function expectActivated(f: Fixture, outcome: CutoverSetActivateResult, resumedFrom: string): void {
  expect(outcome.status).toBe("activated");
  if (outcome.status !== "activated") return;
  expect(outcome.resumedFrom).toBe(resumedFrom);
  expect(outcome).toMatchObject({ setId: f.setId, publicationId: f.setId });
  expectAllNew(f);
  const v2 = readBackendPublicationJournal(f.homeDir);
  expect(v2?.phase).toBe("completed");
  expect(v2?.publicationId).toBe(f.setId);
  expect(v2?.projects.map((project) => project.localProjectId)).toEqual(f.members.map((member) => member.localProjectId));
  expect(readBackendMaintenanceJournal(f.homeDir)).toBeNull();
  const records = readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId });
  expect(records.state).toBe("resolved");
  if (records.state !== "resolved") return;
  expect(records.selection).not.toBeNull();
  const digests = new Set<string>();
  for (const [index, member] of f.members.entries()) {
    const manifest = f.manifestStore.read(member.generationId);
    expect(manifest.phase).toBe("active");
    expect(manifest.pendingEffect).toBeNull();
    const link = readActivationGenerationLink({ homeDir: f.homeDir, generationId: member.generationId });
    expect(link).toMatchObject({ state: "resolved", link: { publicationId: f.setId } });
    if (link.state === "resolved") digests.add(link.link.identityDigest);
    const row = records.selection!.members[index]!;
    expect(row.generationId).toBe(member.generationId);
    const ref = manifest.reports.filter((report) => report.kind === "activation").at(-1)!;
    const report = readMigrationActivationReport({ homeDir: f.homeDir, generationId: member.generationId, reportSha256: ref.reportSha256 });
    expect(report).toMatchObject({ state: "resolved", report: { body: { publicationId: f.setId, epochId: row.epochId, attemptId: row.attemptId, witnessChecksumSha256: row.witnessChecksumSha256 } } });
    const bindings = resolveMigrationWitnessBindings({ homeDir: f.homeDir, generationId: member.generationId });
    expect(bindings).toMatchObject({ state: "resolved" });
    if (bindings.state === "resolved") expect(bindings.selections).toEqual([expect.objectContaining({ kind: "activation", publicationId: f.setId, witnessChecksumSha256: row.witnessChecksumSha256 })]);
    const evidence = readMigrationActivationEvidence({ homeDir: f.homeDir, generationId: member.generationId });
    expect(evidence).toMatchObject({ state: "resolved" });
    if (evidence.state === "resolved") expect(evidence.epochs.map((epoch) => epoch.epochId)).toEqual([row.epochId]);
  }
  expect(digests.size).toBe(1);
  expect([...digests][0]).toBe(records.selection!.identityDigest);
  for (const member of f.members) expect(f.guard.rows.get(member.remoteProjectId)?.releasedAt).not.toBeNull();
}

