import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setConfigValue } from "../config-manager.js";
import { loadDaemonConfig, type ResolvedStorageConfig } from "../daemon/config.js";
import { requireMachineIdentity } from "../machine-identity.js";
import {
  foldProjectMapEntriesLocked,
  type ProjectMap,
  type ProjectMapEntry,
  withProjectMapReconciliationLock,
} from "../project-map.js";
import {
  configPath,
  daemonPidPath,
  lcmHomeDir,
  projectsDir,
} from "../runtime-paths.js";
import {
  copyRegularFilePrivateExclusive,
  readBoundedRegularFile,
} from "../security-files.js";
import { createStorageBackendFactory } from "./factory.js";
import {
  MIGRATION_DEFAULT_BATCH_SIZE,
  MIGRATION_DEFAULT_SAMPLE_SIZE,
  MIGRATION_MANIFEST_VERSION,
  canonicalJson,
  createMigrationGeneration,
  ensureMigrationProjectDirectory,
  fingerprintMigrationFileSync,
  generationRelativePath,
  listMigrationManifests,
  manifestSha256,
  migrationGenerationPaths,
  migrationProjectPaths,
  readMigrationManifest,
  readPublicationJournal,
  sameMigrationFingerprint,
  sha256Canonical,
  sha256Text,
  writeMigrationCheckpoint,
  writeMigrationManifest,
  writeMigrationReport,
  writePublicationJournal,
  type MigrationDeliveryGate,
  type MigrationFileFingerprint,
  type MigrationInstallationCoverage,
  type MigrationManifest,
  type MigrationProjectState,
  type MigrationPublicationJournal,
  type MigrationStatus,
  type MigrationTableCheckpoint,
  type MigrationVerificationReport,
  type PublicationPhase,
} from "./migration-manifest.js";
import {
  PostgreSqlMigrationAdapter,
  POSTGRESQL_MIGRATION_SCHEMA_MANIFEST_SHA256,
  type PostgreSqlMigrationFence,
  type PostgreSqlMigrationIdentity,
  type PostgreSqlMigrationRuntime,
} from "./postgresql/migration-adapter.js";
import { PostgreSqlWorkCoordinator } from "./postgresql/coordination.js";
import { loadPostgreSqlMigrations } from "./postgresql/migrations.js";
import { PostgreSqlRuntime } from "./postgresql/runtime.js";
import {
  SQLITE_MIGRATION_SCHEMA_MANIFEST_SHA256,
  SQLITE_MIGRATION_TABLES,
  SqliteMigrationReader,
  SqliteMigrationWriter,
  createSqliteMigrationSnapshot,
  lastCanonicalKey,
  type MigrationTableInventory,
} from "./sqlite/migration-adapter.js";
import type { StorageBackendFactory, StorageHealth } from "./contracts.js";

const LOCAL_PROJECT_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONFIG_MAX_BYTES = 4 * 1024 * 1024;
const LEASE_TTL_MS = 5 * 60 * 1_000;
const MIGRATION_OPERATION = "reversible-storage-migration";

export type MigrationOperation = "plan" | "dry-run" | "apply" | "resume" | "verify" | "report" | "activate" | "rollback";
export type MigrationCrashPoint =
  | "after-prepare"
  | "after-commit-journal"
  | "after-map"
  | "after-filesystem"
  | "after-config";

export interface ProjectMigrationResult {
  readonly operation: MigrationOperation;
  readonly generationId: string;
  readonly status: MigrationStatus;
  readonly ready: boolean;
  readonly blockers: readonly string[];
  readonly projects: readonly {
    readonly localProjectId: string;
    readonly remoteProjectId: string;
    readonly status: MigrationStatus;
  }[];
}

interface MigrationRuntime extends PostgreSqlMigrationRuntime {
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
}

export interface ProjectMigrationDependencies {
  readonly now: () => Date;
  readonly createRuntime: (settings: Extract<ResolvedStorageConfig, { backend: "postgresql" }>["postgresql"]) => MigrationRuntime;
  readonly createFactory: (storage: ResolvedStorageConfig) => StorageBackendFactory;
  readonly processAlive: (pid: number) => boolean;
  readonly copyPrivate: typeof copyRegularFilePrivateExclusive;
  readonly publishBackend: typeof setConfigValue;
  readonly renameDurably: typeof durableRename;
  readonly crash?: (point: MigrationCrashPoint) => void;
}

export interface ProjectMigrationOptions {
  readonly homeDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly batchSize?: number;
  readonly sampleSize?: number;
  readonly progress?: (message: string) => void;
  /** @internal Deterministic dependency seams for migration protocol tests. */
  readonly _dependenciesForTesting?: Partial<ProjectMigrationDependencies>;
}

const DEFAULT_DEPENDENCIES: ProjectMigrationDependencies = {
  now: () => new Date(),
  createRuntime: (settings) => new PostgreSqlRuntime(settings),
  createFactory: createStorageBackendFactory,
  processAlive: (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  },
  copyPrivate: copyRegularFilePrivateExclusive,
  publishBackend: setConfigValue,
  renameDurably: durableRename,
};

const PROTOCOL = {
  stableResume: "immutable-snapshot-offset-v1",
  integerEncoding: "decimal-tagged-v1",
  idempotentWrites: "exact-readback-v1",
  deterministicSampling: "sha256-key-v1",
  uncertainCommit: "authoritative-remote-readback-v1",
  activationReadiness: "factory-health-existing-projects-v1",
} as const;

function dependencies(options: ProjectMigrationOptions): ProjectMigrationDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...options._dependenciesForTesting };
}

function actualHome(options: ProjectMigrationOptions): string {
  return resolve(options.homeDir ?? homedir());
}

function timestamp(deps: ProjectMigrationDependencies): string {
  return deps.now().toISOString();
}

function positiveOption(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 100_000) throw new Error(`${field} must be between 1 and 100000`);
  return result;
}

function sanitizedId(value: string): string {
  return value.slice(0, 12);
}

function sanitizedFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "migration operation failed";
  return message
    .replaceAll(/postgresql:\/\/[^\s]+/giu, "postgresql://<redacted>")
    .replaceAll(/(?:\/[\w.@+-]+){2,}/gu, "<path>")
    .slice(0, 512);
}

function progress(options: ProjectMigrationOptions, projectId: string, action: string): void {
  options.progress?.(`project:${sanitizedId(projectId)} ${action}`);
}

function emptyDigest(): string {
  return sha256Text("");
}

function emptyOperationalEvidence() {
  return {
    payloadMinimized: true as const,
    originalMainArchive: null,
    originalWalArchive: null,
    nativeTranscriptSidecar: null,
    passiveEventSidecar: null,
    checkpointSidecar: null,
  };
}

function schemaContract() {
  const migrations = loadPostgreSqlMigrations().map(({ id, sha256 }) => ({ id, sha256 }));
  return {
    sha256: sha256Canonical({
      sqlite: SQLITE_MIGRATION_SCHEMA_MANIFEST_SHA256,
      postgresql: POSTGRESQL_MIGRATION_SCHEMA_MANIFEST_SHA256,
      migrations,
    }),
    migrations,
  };
}

function projectDatabasePath(home: string, localProjectId: string): string {
  return join(projectsDir(home), localProjectId, "db.sqlite");
}

function projectEventPath(home: string, localProjectId: string): string {
  return join(lcmHomeDir(home), "events", `${localProjectId}.db`);
}

function projectHasStoredData(home: string, localProjectId: string): boolean {
  return existsSync(projectDatabasePath(home, localProjectId)) || existsSync(projectEventPath(home, localProjectId));
}

function artifactIdentity(kind: "event-sidecar" | "project-database", path: string, root: string, localProjectId: string) {
  return {
    kind,
    relativePath: relative(root, path),
    localProjectId,
    identitySha256: sha256Canonical({ kind, relativePath: relative(root, path), localProjectId }),
  } as const;
}

function installationCoverage(home: string, map: ProjectMap, checkedAt: string): MigrationInstallationCoverage {
  const lcRoot = lcmHomeDir(home);
  const known = new Set(Object.keys(map));
  const inventory: MigrationInstallationCoverage["inventory"][number][] = [{
    kind: "project-map",
    relativePath: "map.json",
    localProjectId: null,
    identitySha256: sha256Canonical(map),
  }];
  const orphanArtifacts: string[] = [];
  const projectsRoot = projectsDir(home);
  if (existsSync(projectsRoot)) {
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !LOCAL_PROJECT_PATTERN.test(entry.name)) continue;
      const path = join(projectsRoot, entry.name, "db.sqlite");
      if (!existsSync(path)) continue;
      inventory.push(artifactIdentity("project-database", path, lcRoot, entry.name));
      if (!known.has(entry.name)) orphanArtifacts.push(relative(lcRoot, path));
    }
  }
  const eventsRoot = join(lcRoot, "events");
  if (existsSync(eventsRoot)) {
    for (const entry of readdirSync(eventsRoot, { withFileTypes: true })) {
      const match = entry.isFile() ? /^([a-f0-9]{64})\.db$/u.exec(entry.name) : null;
      if (!match) continue;
      const localProjectId = match[1]!;
      const path = join(eventsRoot, entry.name);
      inventory.push(artifactIdentity("event-sidecar", path, lcRoot, localProjectId));
      if (!known.has(localProjectId)) orphanArtifacts.push(relative(lcRoot, path));
    }
  }
  inventory.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const activeLocalProjectIds = Object.keys(map).filter((hash) => projectHasStoredData(home, hash)).sort();
  return {
    inventorySha256: sha256Canonical(inventory),
    projectMapSha256: sha256Canonical(map),
    inventory,
    activeLocalProjectIds,
    representedLocalProjectIds: [...activeLocalProjectIds],
    orphanArtifacts: orphanArtifacts.sort(),
    complete: orphanArtifacts.length === 0,
    checkedAt,
  };
}

function projectIdentity(localProjectId: string, entry: ProjectMapEntry) {
  if (!entry.remoteProjectId || !UUID_V7_PATTERN.test(entry.remoteProjectId)) {
    throw new Error(`project:${sanitizedId(localProjectId)} has no compatible PostgreSQL binding`);
  }
  return {
    localProjectId,
    canonicalPath: resolve(entry.canonical),
    aliases: [...new Set([entry.canonical, ...entry.aliases].map((path) => resolve(path)))].sort(),
    remoteProjectId: entry.remoteProjectId.toLowerCase(),
  };
}

function plannedProject(localProjectId: string, entry: ProjectMapEntry): MigrationProjectState {
  return {
    identity: projectIdentity(localProjectId, entry),
    status: "planned",
    sourceFingerprint: null,
    snapshot: null,
    quiescence: null,
    tables: SQLITE_MIGRATION_TABLES.map(({ name }) => ({ table: name, copiedRows: 0, sourceRows: 0, sourceSha256: emptyDigest() })),
    delivery: null,
    operationalEvidence: emptyOperationalEvidence(),
  };
}

function result(operation: MigrationOperation, manifest: MigrationManifest, blockers: readonly string[] = []): ProjectMigrationResult {
  return {
    operation,
    generationId: manifest.generationId,
    status: manifest.status,
    ready: blockers.length === 0 && ["verified", "active", "rolled-back"].includes(manifest.status),
    blockers,
    projects: manifest.projects.map(({ identity, status }) => ({
      localProjectId: identity.localProjectId,
      remoteProjectId: identity.remoteProjectId,
      status,
    })),
  };
}

function reportFor(manifest: MigrationManifest, blockers: readonly string[] = []): MigrationVerificationReport {
  return {
    version: MIGRATION_MANIFEST_VERSION,
    generationId: manifest.generationId,
    generatedAt: manifest.updatedAt,
    status: manifest.status,
    ready: blockers.length === 0 && manifest.status === "verified",
    blockers,
    projects: manifest.projects.map(({ identity, status, tables }) => ({
      localProjectId: identity.localProjectId,
      remoteProjectId: identity.remoteProjectId,
      verified: status === "verified" || status === "active" || status === "rolled-back",
      tables,
    })),
  };
}

function persist(manifest: MigrationManifest, options: ProjectMigrationOptions, blockers: readonly string[] = []): void {
  writeMigrationManifest(manifest, actualHome(options));
  writeMigrationCheckpoint(manifest, actualHome(options));
  writeMigrationReport(reportFor(manifest, blockers), actualHome(options));
}

function updateProject(manifest: MigrationManifest, localProjectId: string, next: MigrationProjectState, deps: ProjectMigrationDependencies): MigrationManifest {
  return {
    ...manifest,
    updatedAt: timestamp(deps),
    projects: manifest.projects.map((entry) => entry.identity.localProjectId === localProjectId ? next : entry),
  };
}

function updateStatus(manifest: MigrationManifest, status: MigrationStatus, deps: ProjectMigrationDependencies): MigrationManifest {
  return { ...manifest, status, updatedAt: timestamp(deps) };
}

function postgresStorage(options: ProjectMigrationOptions): Extract<ResolvedStorageConfig, { backend: "postgresql" }> {
  const config = loadDaemonConfig(configPath(actualHome(options)), { storage: { backend: "postgresql" } }, options.env);
  return config.storage as Extract<ResolvedStorageConfig, { backend: "postgresql" }>;
}

async function openMigrationRuntime(options: ProjectMigrationOptions, deps: ProjectMigrationDependencies): Promise<MigrationRuntime> {
  const runtime = deps.createRuntime(postgresStorage(options).postgresql);
  const health = await runtime.health();
  if (health.status !== "healthy") {
    try { await runtime.close(); } catch { /* preserve the health failure */ }
    throw new Error("PostgreSQL migration runtime is not terminal healthy");
  }
  return runtime;
}

function pgIdentity(project: MigrationProjectState, machineId: string): PostgreSqlMigrationIdentity {
  return {
    localProjectId: project.identity.localProjectId,
    remoteProjectId: project.identity.remoteProjectId,
    machineId,
    aliases: project.identity.aliases,
  };
}

async function verifySchemaHistory(adapter: PostgreSqlMigrationAdapter): Promise<void> {
  const expected = schemaContract().migrations;
  const actual = await adapter.schemaHistory();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("PostgreSQL migration registry or checksum does not match the packaged 0001-0005 history");
}

function readDeliveryGate(path: string, checkedAt: string): MigrationDeliveryGate {
  if (!existsSync(path)) return { blockingOutbox: 0, quarantined: 0, checkedAt };
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    const rows = db.prepare("SELECT delivery_state, count(*) AS count FROM events GROUP BY delivery_state").all() as Array<{ delivery_state?: unknown; count?: unknown }>;
    let blockingOutbox = 0;
    let quarantined = 0;
    for (const row of rows) {
      const count = typeof row.count === "number" && Number.isSafeInteger(row.count) ? row.count : -1;
      if (count < 0 || typeof row.delivery_state !== "string") throw new Error("local outbox diagnostics are invalid");
      if (["pending", "claimed", "retry", "replicated"].includes(row.delivery_state)) blockingOutbox += count;
      if (row.delivery_state === "quarantined") quarantined += count;
    }
    return { blockingOutbox, quarantined, checkedAt };
  } finally { db.close(); }
}

function daemonStopped(home: string, deps: ProjectMigrationDependencies): boolean {
  const path = daemonPidPath(home);
  if (!existsSync(path)) return true;
  const value = readBoundedRegularFile(path, { allowedRoot: lcmHomeDir(home), maxBytes: 64 }).trim();
  if (!/^\d+$/u.test(value)) return false;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 && !deps.processAlive(pid);
}

function sourceFingerprint(project: MigrationProjectState, home: string) {
  const path = projectDatabasePath(home, project.identity.localProjectId);
  if (!existsSync(path)) return { main: null, wal: null };
  return {
    main: fingerprintMigrationFileSync(path, dirname(path)),
    wal: existsSync(`${path}-wal`) ? fingerprintMigrationFileSync(`${path}-wal`, dirname(path)) : null,
  };
}

function currentSourceMatches(project: MigrationProjectState, home: string): boolean {
  if (project.sourceFingerprint === null) return !existsSync(projectDatabasePath(home, project.identity.localProjectId));
  const current = sourceFingerprint(project, home);
  return current.main !== null
    && sameMigrationFingerprint(current.main, project.sourceFingerprint.main)
    && sameMigrationFingerprint(current.wal, project.sourceFingerprint.wal);
}

function archiveOriginal(project: MigrationProjectState, generationId: string, home: string, deps: ProjectMigrationDependencies): MigrationProjectState {
  if (project.sourceFingerprint === null) return project;
  const source = projectDatabasePath(home, project.identity.localProjectId);
  const paths = ensureMigrationProjectDirectory(generationId, project.identity.localProjectId, home);
  const copyAndVerify = (from: string, to: string, expected: MigrationFileFingerprint): MigrationFileFingerprint => {
    deps.copyPrivate(from, to, { allowedRoot: dirname(from) });
    const actual = fingerprintMigrationFileSync(to, paths.directory);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error("retained SQLite archive does not match the preserved source bytes");
    return actual;
  };
  const originalMainArchive = copyAndVerify(source, paths.originalMainArchive, project.sourceFingerprint.main);
  const originalWalArchive = project.sourceFingerprint.wal === null
    ? null
    : copyAndVerify(`${source}-wal`, paths.originalWalArchive, project.sourceFingerprint.wal);
  return {
    ...project,
    operationalEvidence: { ...project.operationalEvidence, originalMainArchive, originalWalArchive },
  };
}

function assertManifestContract(manifest: MigrationManifest): void {
  if (manifest.schemaManifestSha256 !== schemaContract().sha256) throw new Error("migration schema or manifest checksum changed");
  if (!manifest.coverage.complete || manifest.coverage.orphanArtifacts.length > 0) throw new Error("installation coverage contains orphan local storage artifacts");
}

export function planProjectMigration(options: ProjectMigrationOptions = {}): ProjectMigrationResult {
  const deps = dependencies(options);
  const home = actualHome(options);
  const now = timestamp(deps);
  const manifest = withProjectMapReconciliationLock((map) => {
    const coverage = installationCoverage(home, map, now);
    if (!coverage.complete) throw new Error(`orphan local storage artifacts block planning (${coverage.orphanArtifacts.length})`);
    if (coverage.activeLocalProjectIds.length === 0) throw new Error("no local project data is available to migrate");
    const paths = createMigrationGeneration(home);
    const projects = coverage.activeLocalProjectIds.map((hash) => plannedProject(hash, map[hash]!));
    const value: MigrationManifest = {
      version: MIGRATION_MANIFEST_VERSION,
      generationId: basename(paths.directory),
      direction: "sqlite-to-postgresql",
      status: "planned",
      createdAt: now,
      updatedAt: now,
      batchSize: positiveOption(options.batchSize, MIGRATION_DEFAULT_BATCH_SIZE, "batchSize"),
      sampleSize: positiveOption(options.sampleSize, MIGRATION_DEFAULT_SAMPLE_SIZE, "sampleSize"),
      coverage,
      sourceBackend: "sqlite",
      destinationBackend: "postgresql",
      schemaManifestSha256: schemaContract().sha256,
      protocol: PROTOCOL,
      projects,
    };
    persist(value, options);
    return value;
  }, home);
  return result("plan", manifest, ["dry-run required before apply"]);
}

function emptySnapshot(path: string): MigrationTableInventory[] {
  const writer = new SqliteMigrationWriter(path);
  try { writer.checkpointAndClose(); }
  catch (error) { writer.close(); throw error; }
  const reader = new SqliteMigrationReader(path);
  try { return reader.inventory(); } finally { reader.close(); }
}

export async function dryRunProjectMigration(generationId: string, options: ProjectMigrationOptions = {}): Promise<ProjectMigrationResult> {
  const deps = dependencies(options);
  const home = actualHome(options);
  let manifest = readMigrationManifest(generationId, home);
  if (manifest.status !== "planned") throw new Error("dry-run requires a newly planned generation");
  assertManifestContract(manifest);
  const machine = requireMachineIdentity(home);
  const runtime = await openMigrationRuntime(options, deps);
  try {
    let schemaChecked = false;
    for (const project of manifest.projects) {
      progress(options, project.identity.localProjectId, "dry-run");
      const adapter = new PostgreSqlMigrationAdapter(runtime, pgIdentity(project, machine.machineId));
      if (!schemaChecked) { await verifySchemaHistory(adapter); schemaChecked = true; }
      await adapter.assertEmptyDestination();
      await adapter.verifyAliases();
      const paths = ensureMigrationProjectDirectory(generationId, project.identity.localProjectId, home);
      const sourcePath = projectDatabasePath(home, project.identity.localProjectId);
      const snapshot = existsSync(sourcePath)
        ? await createSqliteMigrationSnapshot(sourcePath, paths.sourceSnapshot)
        : null;
      const tables = snapshot?.tables ?? emptySnapshot(paths.sourceSnapshot);
      const snapshotFile = fingerprintMigrationFileSync(paths.sourceSnapshot, paths.directory);
      const checkedAt = timestamp(deps);
      const logicalRows = tables.reduce((sum, table) => sum + table.rows, 0);
      const delivery = readDeliveryGate(projectEventPath(home, project.identity.localProjectId), checkedAt);
      if (delivery.blockingOutbox > 0 || delivery.quarantined > 0) throw new Error(`project:${sanitizedId(project.identity.localProjectId)} has blocking local outbox state`);
      const next: MigrationProjectState = {
        ...project,
        status: "dry-run-verified",
        sourceFingerprint: snapshot?.sourceFingerprint ?? null,
        snapshot: {
          relativePath: generationRelativePath(generationId, paths.sourceSnapshot, home),
          file: snapshotFile,
          schemaSha256: snapshot?.sourceFingerprint.schemaSha256 ?? sha256Canonical(tables),
          logicalRows,
          logicalSha256: sha256Canonical(tables),
          createdAt: checkedAt,
        },
        tables: tables.map(({ table, rows, sha256 }) => ({ table, copiedRows: 0, sourceRows: rows, sourceSha256: sha256 })),
        delivery,
      };
      manifest = updateProject(manifest, project.identity.localProjectId, next, deps);
      persist(manifest, options);
    }
    manifest = { ...updateStatus(manifest, "dry-run-verified", deps), dryRunVerifiedAt: timestamp(deps) };
    persist(manifest, options);
    return result("dry-run", manifest);
  } catch (error) {
    manifest = { ...updateStatus(manifest, "failed", deps), failure: sanitizedFailure(error) };
    persist(manifest, options, [manifest.failure!]);
    throw error;
  } finally {
    await runtime.close();
  }
}

async function releaseLease(
  coordinator: PostgreSqlWorkCoordinator,
  fence: PostgreSqlMigrationFence,
  primaryError: unknown,
): Promise<void> {
  try { await coordinator.releaseLease(fence); }
  catch (error) { if (primaryError === undefined) throw error; }
}

async function copyForward(generationId: string, resume: boolean, options: ProjectMigrationOptions): Promise<ProjectMigrationResult> {
  const deps = dependencies(options);
  const home = actualHome(options);
  let manifest = readMigrationManifest(generationId, home);
  const copiedAnything = manifest.projects.some((project) => project.tables.some(({ copiedRows }) => copiedRows > 0));
  if (resume) {
    if (!(manifest.status === "applying" || (manifest.status === "failed" && copiedAnything))) throw new Error("resume requires an interrupted compatible apply generation");
  } else if (manifest.status !== "dry-run-verified") {
    throw new Error("apply requires a successful dry-run for this exact generation");
  }
  assertManifestContract(manifest);
  if (!daemonStopped(home, deps)) throw new Error("migration apply requires the LCM daemon to be stopped");
  const machine = requireMachineIdentity(home);
  const runtime = await openMigrationRuntime(options, deps);
  try {
    manifest = updateStatus(manifest, "applying", deps);
    persist(manifest, options);
    for (const currentProject of manifest.projects) {
      let project = currentProject;
      if (!currentSourceMatches(project, home)) throw new Error(`project:${sanitizedId(project.identity.localProjectId)} source fingerprint changed after dry-run`);
      project = archiveOriginal(project, generationId, home, deps);
      const sourceNow = sourceFingerprint(project, home);
      project = {
        ...project,
        status: "applying",
        quiescence: {
          daemonStopped: true,
          verifiedAt: timestamp(deps),
          sourceMainSha256: sourceNow.main?.sha256 ?? emptyDigest(),
          sourceWalSha256: sourceNow.wal?.sha256 ?? null,
        },
      };
      manifest = updateProject(manifest, project.identity.localProjectId, project, deps);
      persist(manifest, options);
      const adapter = new PostgreSqlMigrationAdapter(runtime, pgIdentity(project, machine.machineId));
      const coordinator = new PostgreSqlWorkCoordinator(runtime, project.identity.remoteProjectId, machine.machineId);
      const processId = `migration-${process.pid}-${generationId}`;
      const lease = await coordinator.acquireLease({
        resourceType: "storage-migration",
        resourceKey: generationId,
        processId,
        operation: MIGRATION_OPERATION,
        ttlMs: LEASE_TTL_MS,
      });
      if (!lease) throw new Error(`project:${sanitizedId(project.identity.localProjectId)} migration lease is held by another writer`);
      const fence: PostgreSqlMigrationFence = {
        resourceType: lease.resourceType,
        resourceKey: lease.resourceKey,
        processId,
        operation: MIGRATION_OPERATION,
        fencingToken: lease.fencingToken,
      };
      let primaryError: unknown;
      const snapshotPath = migrationProjectPaths(generationId, project.identity.localProjectId, home).sourceSnapshot;
      const reader = new SqliteMigrationReader(snapshotPath);
      try {
        for (const table of project.tables) {
          let checkpoint = table;
          while (checkpoint.copiedRows < checkpoint.sourceRows) {
            await coordinator.renewLease({ ...fence, ttlMs: LEASE_TTL_MS });
            const rows = reader.readBatch(checkpoint.table, checkpoint.copiedRows, manifest.batchSize);
            if (rows.length === 0) throw new Error(`source snapshot ended early in ${checkpoint.table}`);
            const batch = await adapter.writeBatch(checkpoint.table, rows, fence);
            checkpoint = {
              ...checkpoint,
              copiedRows: checkpoint.copiedRows + rows.length,
              lastKey: lastCanonicalKey(rows.at(-1)!),
              lastBatchSha256: sha256Canonical(rows),
              remoteFencingToken: fence.fencingToken.toString(),
              remoteOutcome: batch.uncertainCommitRecovered ? "readback-verified" : "committed",
            };
            project = { ...project, tables: project.tables.map((entry) => entry.table === checkpoint.table ? checkpoint : entry) };
            manifest = updateProject(manifest, project.identity.localProjectId, project, deps);
            persist(manifest, options);
          }
        }
        await adapter.repairSharedSequences(fence);
      } catch (error) { primaryError = error; throw error; }
      finally {
        reader.close();
        await releaseLease(coordinator, fence, primaryError);
      }
      project = { ...project, status: "applied", appliedAt: timestamp(deps) };
      manifest = updateProject(manifest, project.identity.localProjectId, project, deps);
      persist(manifest, options);
    }
    manifest = { ...updateStatus(manifest, "applied", deps), appliedAt: timestamp(deps) };
    persist(manifest, options);
  } catch (error) {
    manifest = { ...updateStatus(manifest, "failed", deps), failure: sanitizedFailure(error) };
    persist(manifest, options, [manifest.failure!]);
    throw error;
  } finally { await runtime.close(); }
  return result(resume ? "resume" : "apply", manifest, ["verification required before activation"]);
}

export function applyProjectMigration(generationId: string, options: ProjectMigrationOptions = {}): Promise<ProjectMigrationResult> {
  return copyForward(generationId, false, options);
}

export function resumeProjectMigration(generationId: string, options: ProjectMigrationOptions = {}): Promise<ProjectMigrationResult> {
  return copyForward(generationId, true, options);
}

function inventoriesEqual(source: readonly MigrationTableCheckpoint[], destination: readonly MigrationTableInventory[]): boolean {
  return source.length === destination.length && source.every((table, index) => {
    const actual = destination[index];
    return actual?.table === table.table && actual.rows === table.sourceRows && actual.sha256 === table.sourceSha256;
  });
}

export async function verifyProjectMigration(generationId: string, options: ProjectMigrationOptions = {}): Promise<ProjectMigrationResult> {
  const deps = dependencies(options);
  const home = actualHome(options);
  let manifest = readMigrationManifest(generationId, home);
  if (manifest.status !== "applied" && manifest.status !== "verified") throw new Error("verify requires a completed apply generation");
  assertManifestContract(manifest);
  const machine = requireMachineIdentity(home);
  const runtime = await openMigrationRuntime(options, deps);
  try {
    for (const currentProject of manifest.projects) {
      if (!currentSourceMatches(currentProject, home)) throw new Error(`project:${sanitizedId(currentProject.identity.localProjectId)} preserved source fingerprint changed`);
      const adapter = new PostgreSqlMigrationAdapter(runtime, pgIdentity(currentProject, machine.machineId));
      await verifySchemaHistory(adapter);
      await adapter.verifyAliases();
      await adapter.verifyRelationalIntegrity();
      const inventory = await adapter.inventory();
      if (!inventoriesEqual(currentProject.tables, inventory)) throw new Error(`project:${sanitizedId(currentProject.identity.localProjectId)} canonical count or digest mismatch`);
      const reader = new SqliteMigrationReader(migrationProjectPaths(generationId, currentProject.identity.localProjectId, home).sourceSnapshot);
      try {
        for (const table of currentProject.tables) {
          const sourceSample = reader.sample(table.table, manifest.sampleSize);
          const destinationSample = await adapter.sample(table.table, manifest.sampleSize);
          if (canonicalJson(sourceSample) !== canonicalJson(destinationSample)) throw new Error(`project:${sanitizedId(currentProject.identity.localProjectId)} deterministic sample mismatch in ${table.table}`);
        }
      } finally { reader.close(); }
      const verifiedAt = timestamp(deps);
      const project: MigrationProjectState = {
        ...currentProject,
        status: "verified",
        verifiedAt,
        tables: currentProject.tables.map((table, index) => ({
          ...table,
          destinationRows: inventory[index]!.rows,
          destinationSha256: inventory[index]!.sha256,
          verifiedAt,
        })),
      };
      manifest = updateProject(manifest, project.identity.localProjectId, project, deps);
      persist(manifest, options);
    }
    manifest = { ...updateStatus(manifest, "verified", deps), verifiedAt: timestamp(deps) };
    persist(manifest, options);
    return result("verify", manifest);
  } catch (error) {
    manifest = { ...updateStatus(manifest, "failed", deps), failure: sanitizedFailure(error) };
    persist(manifest, options, [manifest.failure!]);
    throw error;
  } finally { await runtime.close(); }
}

function configContent(home: string): string {
  const path = configPath(home);
  return existsSync(path) ? readBoundedRegularFile(path, { allowedRoot: lcmHomeDir(home), maxBytes: CONFIG_MAX_BYTES }) : "{}";
}

function configSha256(home: string): string {
  return sha256Text(configContent(home));
}

function backendFromConfig(home: string, options: ProjectMigrationOptions): "sqlite" | "postgresql" {
  return loadDaemonConfig(configPath(home), undefined, options.env).storage.backend;
}

function expectedMapEntry(map: ProjectMap, project: MigrationProjectState): ProjectMapEntry {
  const entry = map[project.identity.localProjectId];
  if (!entry) throw new Error(`project:${sanitizedId(project.identity.localProjectId)} disappeared from the project map`);
  if (resolve(entry.canonical) !== project.identity.canonicalPath || entry.remoteProjectId !== project.identity.remoteProjectId || sha256Canonical([...new Set([entry.canonical, ...entry.aliases].map((path) => resolve(path)))].sort()) !== sha256Canonical(project.identity.aliases)) {
    throw new Error(`project:${sanitizedId(project.identity.localProjectId)} project-map identity changed`);
  }
  return entry;
}

async function activationBlockers(manifest: MigrationManifest, options: ProjectMigrationOptions, deps: ProjectMigrationDependencies): Promise<string[]> {
  const home = actualHome(options);
  const blockers: string[] = [];
  if (manifest.status !== "verified") blockers.push("generation is not terminal verified");
  if (!daemonStopped(home, deps)) blockers.push("LCM daemon is not stopped");
  if (manifest.schemaManifestSha256 !== schemaContract().sha256) blockers.push("schema or manifest checksum changed");
  try {
    withProjectMapReconciliationLock((map) => {
      const current = installationCoverage(home, map, timestamp(deps));
      if (!current.complete) blockers.push("installation coverage contains orphan local storage artifacts");
      if (current.inventorySha256 !== manifest.coverage.inventorySha256 || current.projectMapSha256 !== manifest.coverage.projectMapSha256 || canonicalJson(current.activeLocalProjectIds) !== canonicalJson(manifest.coverage.activeLocalProjectIds)) {
        blockers.push("installation-wide project coverage changed after planning");
      }
      for (const project of manifest.projects) expectedMapEntry(map, project);
    }, home);
  } catch (error) {
    blockers.push(sanitizedFailure(error));
  }
  for (const project of manifest.projects) {
    if (project.status !== "verified") blockers.push(`project:${sanitizedId(project.identity.localProjectId)} is not verified`);
    if (!currentSourceMatches(project, home)) blockers.push(`project:${sanitizedId(project.identity.localProjectId)} source fingerprint changed`);
    const gate = readDeliveryGate(projectEventPath(home, project.identity.localProjectId), timestamp(deps));
    if (gate.blockingOutbox > 0 || gate.quarantined > 0) blockers.push(`project:${sanitizedId(project.identity.localProjectId)} local delivery is not quiescent`);
  }
  const storage = postgresStorage(options);
  const factory = deps.createFactory(storage);
  let factoryFailure: unknown;
  try {
    const health = await factory.health();
    if (health.status !== "healthy") blockers.push("live PostgreSQL storage factory is not terminal healthy");
    if (health.status === "healthy") {
      const machine = requireMachineIdentity(home);
      for (const project of manifest.projects) {
        const exists = await factory.projectExists({
          id: project.identity.remoteProjectId,
          localProjectId: project.identity.localProjectId,
          remoteProjectId: project.identity.remoteProjectId,
          canonical: project.identity.canonicalPath,
          machineId: machine.machineId,
        });
        if (!exists) blockers.push(`project:${sanitizedId(project.identity.localProjectId)} is not usable through the live PostgreSQL factory`);
      }
    }
  } catch (error) { factoryFailure = error; blockers.push("live PostgreSQL storage factory behavioral check failed"); }
  finally {
    try { await factory.close(); }
    catch (error) { if (factoryFailure === undefined) blockers.push("live PostgreSQL storage factory did not close cleanly"); }
  }
  return blockers;
}

function journalProjects(manifest: MigrationManifest) {
  const digest = manifestSha256(manifest);
  return manifest.projects.map((project) => ({
    generationId: manifest.generationId,
    localProjectId: project.identity.localProjectId,
    remoteProjectId: project.identity.remoteProjectId,
    sourceFingerprintSha256: sha256Canonical(project.sourceFingerprint),
    manifestSha256: digest,
    expectedCanonicalPath: project.identity.canonicalPath,
    expectedAliasesSha256: sha256Canonical(project.identity.aliases),
    published: false,
  }));
}

function crash(deps: ProjectMigrationDependencies, point: MigrationCrashPoint): void {
  deps.crash?.(point);
}

function writeJournalPhase(journal: MigrationPublicationJournal, phase: PublicationPhase, options: ProjectMigrationOptions, deps: ProjectMigrationDependencies): MigrationPublicationJournal {
  const next = { ...journal, phase, updatedAt: timestamp(deps) };
  writePublicationJournal(journal.generationId, next, actualHome(options));
  return next;
}

function publishActivation(manifest: MigrationManifest, options: ProjectMigrationOptions, deps: ProjectMigrationDependencies): void {
  const home = actualHome(options);
  withProjectMapReconciliationLock((map) => {
    for (const project of manifest.projects) {
      expectedMapEntry(map, project);
      if (!currentSourceMatches(project, home)) throw new Error(`project:${sanitizedId(project.identity.localProjectId)} changed during activation`);
    }
    let journal = readPublicationJournal(manifest.generationId, home);
    if (journal && journal.operation !== "activate") throw new Error("publication journal operation does not match activation");
    if (journal?.phase === "completed") return;
    if (!journal) {
      const now = timestamp(deps);
      journal = {
        version: MIGRATION_MANIFEST_VERSION,
        generationId: manifest.generationId,
        operation: "activate",
        phase: "prepare",
        createdAt: now,
        updatedAt: now,
        expectedBackend: "sqlite",
        targetBackend: "postgresql",
        expectedConfigSha256: configSha256(home),
        projects: journalProjects(manifest),
      };
      writePublicationJournal(manifest.generationId, journal, home);
      crash(deps, "after-prepare");
    }
    const backend = backendFromConfig(home, options);
    if (backend === "sqlite" && configSha256(home) !== journal.expectedConfigSha256) throw new Error("configuration changed during activation publication");
    journal = writeJournalPhase(journal, "commit", options, deps);
    crash(deps, "after-commit-journal");
    for (const project of manifest.projects) {
      foldProjectMapEntriesLocked({
        targetHash: project.identity.localProjectId,
        canonical: project.identity.canonicalPath,
        sourceHashes: [project.identity.localProjectId],
        aliases: project.identity.aliases,
        expectedRemoteProjectId: project.identity.remoteProjectId,
        homeDir: home,
      });
    }
    crash(deps, "after-map");
    if (backend === "sqlite") {
      deps.publishBackend({ configPath: configPath(home), path: "storage.backend", value: "postgresql", env: options.env });
    }
    if (backendFromConfig(home, options) !== "postgresql") throw new Error("activation failed to publish the PostgreSQL backend");
    const publishedConfigSha256 = configSha256(home);
    if (journal.publishedConfigSha256 && journal.publishedConfigSha256 !== publishedConfigSha256) throw new Error("published PostgreSQL configuration changed during activation recovery");
    journal = writeJournalPhase({ ...journal, publishedConfigSha256 }, "recovery", options, deps);
    crash(deps, "after-config");
    writeJournalPhase(journal, "completed", options, deps);
  }, home);
}

export async function activateProjectMigration(generationId: string, options: ProjectMigrationOptions = {}): Promise<ProjectMigrationResult> {
  const deps = dependencies(options);
  let manifest = readMigrationManifest(generationId, actualHome(options));
  assertManifestContract(manifest);
  if (manifest.status === "active") {
    const journal = readPublicationJournal(generationId, actualHome(options));
    if (journal?.operation !== "activate" || journal.phase !== "completed") throw new Error("active migration generation has no completed activation journal");
    return result("activate", manifest);
  }
  const blockers = await activationBlockers(manifest, options, deps);
  if (blockers.length > 0) {
    persist(manifest, options, blockers);
    return result("activate", manifest, blockers);
  }
  publishActivation(manifest, options, deps);
  const activatedAt = timestamp(deps);
  manifest = {
    ...updateStatus(manifest, "active", deps),
    activatedAt,
    projects: manifest.projects.map((project) => ({ ...project, status: "active", activatedAt })),
  };
  persist(manifest, options);
  return result("activate", manifest);
}

function preWriteRollback(manifest: MigrationManifest, options: ProjectMigrationOptions, deps: ProjectMigrationDependencies): MigrationManifest {
  if (manifest.projects.some((project) => project.tables.some(({ copiedRows }) => copiedRows > 0))) throw new Error("pre-write rollback is unavailable after remote writes");
  const home = actualHome(options);
  if (backendFromConfig(home, options) !== "sqlite") throw new Error("pre-write rollback expected the global SQLite backend");
  let journal = readPublicationJournal(manifest.generationId, home);
  if (journal && journal.operation !== "pre-write-rollback") throw new Error("publication journal operation does not match pre-write rollback");
  if (!journal) {
    const now = timestamp(deps);
    journal = {
      version: MIGRATION_MANIFEST_VERSION,
      generationId: manifest.generationId,
      operation: "pre-write-rollback",
      phase: "prepare",
      createdAt: now,
      updatedAt: now,
      expectedBackend: "sqlite",
      targetBackend: "sqlite",
      expectedConfigSha256: configSha256(home),
      projects: journalProjects(manifest),
    };
    writePublicationJournal(manifest.generationId, journal, home);
    crash(deps, "after-prepare");
  }
  if (journal.phase === "completed") return {
    ...updateStatus(manifest, "rolled-back", deps),
    projects: manifest.projects.map((project) => ({ ...project, status: "rolled-back", verifiedAt: project.verifiedAt ?? timestamp(deps) })),
  };
  journal = writeJournalPhase(journal, "commit", options, deps);
  crash(deps, "after-commit-journal");
  if (configSha256(home) !== journal.expectedConfigSha256) throw new Error("configuration changed during pre-write rollback");
  journal = writeJournalPhase({ ...journal, publishedConfigSha256: journal.expectedConfigSha256 }, "recovery", options, deps);
  writeJournalPhase(journal, "completed", options, deps);
  const rolledBackAt = timestamp(deps);
  return {
    ...updateStatus(manifest, "rolled-back", deps),
    projects: manifest.projects.map((project) => ({ ...project, status: "rolled-back", verifiedAt: project.verifiedAt ?? rolledBackAt })),
  };
}

async function stageReverseDatabases(manifest: MigrationManifest, options: ProjectMigrationOptions, deps: ProjectMigrationDependencies): Promise<MigrationManifest> {
  const home = actualHome(options);
  if (!daemonStopped(home, deps)) throw new Error("post-write rollback requires the LCM daemon to be stopped");
  const machine = requireMachineIdentity(home);
  const runtime = await openMigrationRuntime(options, deps);
  let nextManifest = manifest;
  try {
    for (const currentProject of nextManifest.projects) {
      const paths = ensureMigrationProjectDirectory(manifest.generationId, currentProject.identity.localProjectId, home);
      if (currentProject.sourceFingerprint !== null) {
        const mainArchive = currentProject.operationalEvidence.originalMainArchive;
        if (mainArchive === null || !sameMigrationFingerprint(mainArchive, fingerprintMigrationFileSync(paths.originalMainArchive, paths.directory))) throw new Error(`project:${sanitizedId(currentProject.identity.localProjectId)} retained SQLite main archive is unavailable or changed`);
        const walArchive = currentProject.operationalEvidence.originalWalArchive;
        if (currentProject.sourceFingerprint.wal === null ? walArchive !== null : walArchive === null || !sameMigrationFingerprint(walArchive, fingerprintMigrationFileSync(paths.originalWalArchive, paths.directory))) throw new Error(`project:${sanitizedId(currentProject.identity.localProjectId)} retained SQLite WAL archive is unavailable or changed`);
      }
      const adapter = new PostgreSqlMigrationAdapter(runtime, pgIdentity(currentProject, machine.machineId));
      const coordinator = new PostgreSqlWorkCoordinator(runtime, currentProject.identity.remoteProjectId, machine.machineId);
      const processId = `reverse-migration-${process.pid}-${manifest.generationId}`;
      const lease = await coordinator.acquireLease({ resourceType: "storage-migration", resourceKey: manifest.generationId, processId, operation: MIGRATION_OPERATION, ttlMs: LEASE_TTL_MS });
      if (!lease) throw new Error(`project:${sanitizedId(currentProject.identity.localProjectId)} migration lease is held by another writer`);
      const fence: PostgreSqlMigrationFence = { resourceType: lease.resourceType, resourceKey: lease.resourceKey, processId, operation: MIGRATION_OPERATION, fencingToken: lease.fencingToken };
      let primaryError: unknown;
      try {
        await coordinator.assertLeaseFence(fence);
        const sourceInventory = await adapter.inventory();
        const sidecars = await adapter.exportOperationalSidecars(paths);
        let reuseStaged = false;
        if (existsSync(paths.reverseDatabase) && !existsSync(`${paths.reverseDatabase}-wal`)) {
          try {
            fingerprintMigrationFileSync(paths.reverseDatabase, paths.directory);
            const reader = new SqliteMigrationReader(paths.reverseDatabase);
            try { reuseStaged = canonicalJson(reader.inventory()) === canonicalJson(sourceInventory); }
            finally { reader.close(); }
          } catch { reuseStaged = false; }
        }
        if (!reuseStaged && existsSync(paths.reverseDatabase)) preserveInterruptedReverse(paths.reverseDatabase);
        if (!reuseStaged) {
          const writer = new SqliteMigrationWriter(paths.reverseDatabase);
          try {
            for (const table of sourceInventory) {
              for (let offset = 0; offset < table.rows; offset += nextManifest.batchSize) {
                await coordinator.renewLease({ ...fence, ttlMs: LEASE_TTL_MS });
                writer.writeBatch(table.table, await adapter.readBatch(table.table, offset, nextManifest.batchSize));
              }
            }
            const destination = writer.verify();
            if (canonicalJson(destination) !== canonicalJson(sourceInventory)) throw new Error(`project:${sanitizedId(currentProject.identity.localProjectId)} reverse SQLite digest mismatch`);
            writer.checkpointAndClose();
          } catch (error) { writer.close(); throw error; }
        }
        await coordinator.assertLeaseFence(fence);
        const finalSourceInventory = await adapter.inventory();
        if (canonicalJson(finalSourceInventory) !== canonicalJson(sourceInventory)) throw new Error(`project:${sanitizedId(currentProject.identity.localProjectId)} PostgreSQL source changed during reverse staging`);
        const verifiedAt = timestamp(deps);
        const project: MigrationProjectState = {
          ...currentProject,
          status: "rollback-ready",
          verifiedAt,
          tables: sourceInventory.map(({ table, rows, sha256 }) => ({ table, copiedRows: rows, sourceRows: rows, sourceSha256: sha256, destinationRows: rows, destinationSha256: sha256, verifiedAt })),
          operationalEvidence: { ...currentProject.operationalEvidence, ...sidecars },
        };
        nextManifest = updateProject(nextManifest, project.identity.localProjectId, project, deps);
        persist(nextManifest, options);
      } catch (error) { primaryError = error; throw error; }
      finally { await releaseLease(coordinator, fence, primaryError); }
    }
    return updateStatus(nextManifest, "rollback-ready", deps);
  } finally { await runtime.close(); }
}

function preserveInterruptedReverse(path: string): void {
  const token = randomUUID();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${path}${suffix}`;
    if (existsSync(candidate)) durableRename(candidate, `${path}.interrupted-${token}${suffix}`);
  }
}

function retainedCanonicalPath(canonical: string, generationId: string): string {
  return `${canonical}.preserved-${generationId}`;
}

function publishReverse(manifest: MigrationManifest, options: ProjectMigrationOptions, deps: ProjectMigrationDependencies): void {
  const home = actualHome(options);
  withProjectMapReconciliationLock((map) => {
    for (const project of manifest.projects) expectedMapEntry(map, project);
    let journal = readPublicationJournal(manifest.generationId, home);
    let priorPublicationJournalSha256: string | undefined;
    if (journal?.operation === "activate") {
      if (journal.phase !== "completed") throw new Error("activation publication must complete before post-write rollback");
      const generation = migrationGenerationPaths(manifest.generationId, home);
      const archive = join(generation.directory, "activation-publication-journal.json");
      deps.copyPrivate(generation.journal, archive, { allowedRoot: generation.directory });
      const current = fingerprintMigrationFileSync(generation.journal, generation.directory);
      const retained = fingerprintMigrationFileSync(archive, generation.directory);
      if (current.size !== retained.size || current.sha256 !== retained.sha256) throw new Error("retained activation publication journal diverges");
      priorPublicationJournalSha256 = retained.sha256;
      journal = null;
    }
    if (!journal && priorPublicationJournalSha256 === undefined) throw new Error("completed activation publication journal is required before post-write rollback");
    if (journal && journal.operation !== "post-write-rollback") throw new Error("publication journal operation does not match post-write rollback");
    if (journal?.phase === "completed") return;
    if (!journal) {
      const now = timestamp(deps);
      journal = {
        version: MIGRATION_MANIFEST_VERSION,
        generationId: manifest.generationId,
        operation: "post-write-rollback",
        phase: "prepare",
        createdAt: now,
        updatedAt: now,
        expectedBackend: "postgresql",
        targetBackend: "sqlite",
        expectedConfigSha256: configSha256(home),
        priorPublicationJournalSha256,
        projects: manifest.projects.map((project) => {
          const canonical = projectDatabasePath(home, project.identity.localProjectId);
          return {
            ...journalProjects(manifest).find(({ localProjectId }) => localProjectId === project.identity.localProjectId)!,
            stagedSqlitePath: migrationProjectPaths(manifest.generationId, project.identity.localProjectId, home).reverseDatabase,
            archivedMainPath: retainedCanonicalPath(canonical, manifest.generationId),
            archivedWalPath: retainedCanonicalPath(`${canonical}-wal`, manifest.generationId),
          };
        }),
      };
      writePublicationJournal(manifest.generationId, journal, home);
      crash(deps, "after-prepare");
    }
    const backend = backendFromConfig(home, options);
    if (backend === "postgresql" && configSha256(home) !== journal.expectedConfigSha256) throw new Error("configuration changed during rollback publication");
    journal = writeJournalPhase(journal, "commit", options, deps);
    crash(deps, "after-commit-journal");
    const published = [...journal.projects];
    for (const [index, state] of published.entries()) {
      if (state.published) continue;
      const canonical = projectDatabasePath(home, state.localProjectId);
      const staged = state.stagedSqlitePath!;
      const incoming = `${canonical}.incoming-${manifest.generationId}`;
      if (!existsSync(incoming)) {
        if (!deps.copyPrivate(staged, incoming, { allowedRoot: dirname(staged) })) {
          throw new Error(`project:${sanitizedId(state.localProjectId)} reverse staging path collided`);
        }
      }
      const stagedFingerprint = fingerprintMigrationFileSync(staged, dirname(staged));
      const incomingFingerprint = fingerprintMigrationFileSync(incoming, dirname(incoming));
      if (stagedFingerprint.size !== incomingFingerprint.size || stagedFingerprint.sha256 !== incomingFingerprint.sha256) {
        throw new Error(`project:${sanitizedId(state.localProjectId)} reverse incoming database diverged`);
      }
      if (existsSync(canonical) && !existsSync(state.archivedMainPath!)) {
        deps.renameDurably(canonical, state.archivedMainPath!);
      }
      if (existsSync(`${canonical}-wal`) && !existsSync(state.archivedWalPath!)) deps.renameDurably(`${canonical}-wal`, state.archivedWalPath!);
      if (!existsSync(canonical)) deps.renameDurably(incoming, canonical);
      if (!existsSync(canonical)) throw new Error(`project:${sanitizedId(state.localProjectId)} reverse database publication failed`);
      const publishedFingerprint = fingerprintMigrationFileSync(canonical, dirname(canonical));
      if (publishedFingerprint.size !== stagedFingerprint.size || publishedFingerprint.sha256 !== stagedFingerprint.sha256) {
        throw new Error(`project:${sanitizedId(state.localProjectId)} canonical reverse database diverged`);
      }
      published[index] = { ...state, published: true };
      journal = { ...journal, phase: "recovery", updatedAt: timestamp(deps), projects: published };
      writePublicationJournal(manifest.generationId, journal, home);
      crash(deps, "after-filesystem");
    }
    for (const project of manifest.projects) {
      foldProjectMapEntriesLocked({
        targetHash: project.identity.localProjectId,
        canonical: project.identity.canonicalPath,
        sourceHashes: [project.identity.localProjectId],
        aliases: project.identity.aliases,
        expectedRemoteProjectId: project.identity.remoteProjectId,
        homeDir: home,
      });
    }
    crash(deps, "after-map");
    if (backend === "postgresql") deps.publishBackend({ configPath: configPath(home), path: "storage.backend", value: "sqlite", env: options.env });
    if (backendFromConfig(home, options) !== "sqlite") throw new Error("rollback failed to publish the SQLite backend");
    const publishedConfigSha256 = configSha256(home);
    if (journal.publishedConfigSha256 && journal.publishedConfigSha256 !== publishedConfigSha256) throw new Error("published SQLite configuration changed during rollback recovery");
    journal = writeJournalPhase({ ...journal, publishedConfigSha256 }, "recovery", options, deps);
    crash(deps, "after-config");
    writeJournalPhase(journal, "completed", options, deps);
  }, home);
}

function durableRename(source: string, destination: string): void {
  renameSync(source, destination);
  const directory = openSync(dirname(destination), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export async function rollbackProjectMigration(generationId: string, options: ProjectMigrationOptions = {}): Promise<ProjectMigrationResult> {
  const deps = dependencies(options);
  let manifest = readMigrationManifest(generationId, actualHome(options));
  assertManifestContract(manifest);
  if (manifest.status === "rolled-back") {
    const completed = readPublicationJournal(generationId, actualHome(options));
    if (completed?.phase !== "completed" || (completed.operation !== "pre-write-rollback" && completed.operation !== "post-write-rollback")) throw new Error("rolled-back migration generation has no completed rollback journal");
    return result("rollback", manifest);
  }
  const remoteWrites = manifest.projects.some((project) => project.tables.some(({ copiedRows }) => copiedRows > 0));
  if (!remoteWrites) {
    manifest = preWriteRollback(manifest, options, deps);
    persist(manifest, options);
    return result("rollback", manifest);
  }
  const journal = readPublicationJournal(generationId, actualHome(options));
  const recoveringPublication = journal?.operation === "post-write-rollback";
  const backend = backendFromConfig(actualHome(options), options);
  if (backend !== "postgresql" && !(backend === "sqlite" && recoveringPublication)) throw new Error("post-write rollback requires the globally activated PostgreSQL backend");
  if (!recoveringPublication) {
    if (manifest.status !== "active" && manifest.status !== "rollback-ready") throw new Error("post-write rollback requires the active verified generation");
    withProjectMapReconciliationLock((map) => {
      const current = installationCoverage(actualHome(options), map, timestamp(deps));
      if (!current.complete || current.inventorySha256 !== manifest.coverage.inventorySha256 || current.projectMapSha256 !== manifest.coverage.projectMapSha256 || canonicalJson(current.activeLocalProjectIds) !== canonicalJson(manifest.coverage.activeLocalProjectIds)) throw new Error("installation-wide project coverage changed after activation");
      for (const project of manifest.projects) expectedMapEntry(map, project);
    }, actualHome(options));
    manifest = await stageReverseDatabases(manifest, options, deps);
    persist(manifest, options);
  }
  publishReverse(manifest, options, deps);
  manifest = {
    ...updateStatus(manifest, "rolled-back", deps),
    projects: manifest.projects.map((project) => ({ ...project, status: "rolled-back" })),
  };
  persist(manifest, options);
  return result("rollback", manifest);
}

export function reportProjectMigration(generationId: string, options: ProjectMigrationOptions = {}): ProjectMigrationResult {
  const manifest = readMigrationManifest(generationId, actualHome(options));
  const blockers = manifest.failure ? [manifest.failure] : [];
  return result("report", manifest, blockers);
}

export function listProjectMigrationReports(options: ProjectMigrationOptions = {}): ProjectMigrationResult[] {
  return listMigrationManifests(actualHome(options)).map((manifest) => result("report", manifest, manifest.failure ? [manifest.failure] : []));
}

export const PROJECT_MIGRATION_TEST_SEAMS = {
  activationBlockers,
  actualHome,
  archiveOriginal,
  artifactIdentity,
  assertManifestContract,
  backendFromConfig,
  configContent,
  configSha256,
  currentSourceMatches,
  daemonStopped,
  dependencies,
  durableRename,
  emptyDigest,
  emptyOperationalEvidence,
  emptySnapshot,
  expectedMapEntry,
  installationCoverage,
  inventoriesEqual,
  journalProjects,
  openMigrationRuntime,
  pgIdentity,
  positiveOption,
  preWriteRollback,
  preserveInterruptedReverse,
  progress,
  projectDatabasePath,
  projectEventPath,
  projectHasStoredData,
  projectIdentity,
  publishActivation,
  publishReverse,
  readDeliveryGate,
  releaseLease,
  reportFor,
  result,
  retainedCanonicalPath,
  sanitizedFailure,
  sanitizedId,
  schemaContract,
  sourceFingerprint,
  stageReverseDatabases,
  timestamp,
  updateProject,
  updateStatus,
  verifySchemaHistory,
  writeJournalPhase,
} as const;
