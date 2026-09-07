import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readDaemonConfigSnapshot, type ResolvedStorageConfig } from "../daemon/config.js";
import { localProjectIdentity } from "../daemon/project.js";
import {
  ensurePendingMachineIdentity,
  createMachineIdentity,
  finalizeMachineIdentity,
  MachineIdentityRegistrationChangedError,
  recoverMachineIdentity,
  requireMachineIdentity,
  readMachineIdentity,
  type MachineIdentity,
} from "../machine-identity.js";
import { projectMapPath, readProjectMapSnapshot } from "../project-map.js";
import { lcmHomeDir } from "../runtime-paths.js";
import { readBoundedRegularFileWithStat } from "../security-files.js";
import { assertStorageBackendPublication } from "../storage/backend.js";
import {
  backendPublicationCanonicalSha256,
  BackendPublicationJournalError,
  readBackendMaintenanceJournal,
  rebindBackendMaintenanceCutoff,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import type { StorageBackendName } from "../storage/contracts.js";
import {
  captureSqliteSnapshotArtifact,
  authenticateSqliteSnapshotCaptureBinding,
  validateSourceByteWitness,
  authenticateSqliteSnapshotSourceBytes,
  classifySqliteSnapshotArtifact,
  dryRunSqliteSnapshotArtifact,
  inspectSqliteSnapshotArtifact,
  type AuthenticatedSqliteSnapshotAuthority,
  type SqliteSnapshotArtifactWitness,
  type SqliteSnapshotClassification,
  type SqliteSnapshotDryRun,
  type SqliteSnapshotOptions,
  type SqliteSnapshotSourceByteOptions,
  type SqliteSnapshotSourceByteWitness,
} from "./sqlite-snapshot.js";
import { eventsDir, eventSequenceDbPath } from "../db/events-path.js";
import { SqliteStorageBackendFactory } from "../storage/sqlite/factory.js";
import {
  openPostgreSqlIdentitySession,
  type IdentityRepository,
} from "../identity-service.js";

import {
  withMigrationQueueEvidence, sealMigrationQueueEvidence,
  type AuthenticatedSqliteMigrationSnapshot,
} from "./queue-evidence.js";
import { canonicalJson } from "../storage/portable-record.js";

type PostgreSqlConfig = Extract<ResolvedStorageConfig, { backend: "postgresql" }>;

export type SqliteMigrationEnrollmentInput = Readonly<{
  cwd: string;
  homeDir: string;
  targetConfig: PostgreSqlConfig;
  displayName?: string;
}>;

export type SqliteMigrationEnrollmentResult = Readonly<{
  identity: MachineIdentity;
  physicalProjectId: string;
  sourceSelectionSha256: string;
}>;

type IdentitySession = Readonly<{
  repository: IdentityRepository;
  close(): Promise<void>;
}>;

export type SqliteMigrationEnrollmentDependencies = Readonly<{
  /** @internal Isolated PostgreSQL harness seam; publication admission remains real. */
  openIdentitySession?: (config: PostgreSqlConfig) => Promise<IdentitySession>;
}>;

const authenticatedAuthorities = new WeakMap<object, string>();

function digestFile(path: string, allowedRoot: string): string {
  const value = readBoundedRegularFileWithStat(path, {
    allowedRoot,
    maxBytes: 4 * 1024 * 1024,
    expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
    allowedModes: [0o400, 0o600],
    requireSingleLink: true,
  });
  return backendPublicationCanonicalSha256({
    rawSha256: createHash("sha256").update(value.content).digest("hex"),
    dev: value.dev,
    ino: value.ino,
    parentDev: value.parentDev,
    parentIno: value.parentIno,
  });
}

export function authenticateSqliteMigrationSource(
  cwd: string,
  homeDir: string,
  publicationLockToken?: BackendPublicationLockToken,
): AuthenticatedSqliteSnapshotAuthority {
  const configuration = readDaemonConfigSnapshot(join(homeDir, ".lcm", "config.json"));
  if (configuration.config.storage.backend !== "sqlite") throw new Error("SQLite migration requires SQLite to remain selected");
  const local = localProjectIdentity(cwd, homeDir);
  const map = readProjectMapSnapshot(homeDir, publicationLockToken);
  const entry = map[local.id];
  const canonicalPath = resolve(entry?.canonical ?? local.canonical);
  const aliases = [...new Set((entry?.aliases ?? []).map((path) => resolve(path)))]
    .filter((path) => path !== canonicalPath)
    .sort();
  const machineIdentity = requireMachineIdentity(homeDir);
  const lcm = lcmHomeDir(homeDir);
  const projectDir = join(lcm, "projects", local.id);
  const projectDbPath = join(projectDir, "db.sqlite");
  const passivePath = join(eventsDir(homeDir), `${local.id}.db`);
  const body: Omit<AuthenticatedSqliteSnapshotAuthority, "sourceSelectionSha256"> = {
    version: 1,
    physicalProjectId: local.id,
    projectIdentity: entry?.remoteProjectId === undefined
      ? { scope: "local", projectId: local.id }
      : { scope: "shared", projectId: entry.remoteProjectId },
    canonicalPath,
    aliases,
    projectDbPath,
    passiveEventsDbPath: existsSync(passivePath) ? passivePath : null,
    machineSequenceDbPath: eventSequenceDbPath(homeDir),
    machineIdentity: {
      identityKey: machineIdentity.identityKey,
      machineId: machineIdentity.machineId,
    },
    machineIdentitySha256: backendPublicationCanonicalSha256(machineIdentity),
    projectMapSha256: existsSync(projectMapPath(homeDir))
      ? digestFile(projectMapPath(homeDir), lcm)
      : backendPublicationCanonicalSha256({ state: "absent" }),
    projectMapEntrySha256: backendPublicationCanonicalSha256(entry ?? {
      canonical: canonicalPath,
      aliases: [],
    }),
    projectMetadataSha256: digestFile(join(projectDir, "meta.json"), projectDir),
  };
  const authority = Object.freeze({
    ...body,
    sourceSelectionSha256: backendPublicationCanonicalSha256(body),
  });
  authenticatedAuthorities.set(authority, backendPublicationCanonicalSha256(configuration.witness));
  return authority;
}

function assertAuthenticatedAuthority(
  authority: AuthenticatedSqliteSnapshotAuthority,
): void {
  if (!authenticatedAuthorities.has(authority)) {
    throw new Error("SQLite snapshot authority was not authenticated by migration preparation");
  }
}

export async function captureAuthenticatedSqliteMigrationSource(
  authority: AuthenticatedSqliteSnapshotAuthority,
  options: SqliteSnapshotOptions,
): Promise<AuthenticatedSqliteMigrationSnapshot> {
  assertAuthenticatedAuthority(authority);
  validateSourceByteWitness(options.expectedSourceBytes, authority);
  const expected = canonicalJson(authority);
  return withBackendPublicationAppendBarrierAsync(options.homeDir, async (token) => {
    let captureOptions = options;
    const revalidate = (): void => {
      const current = authenticateSqliteMigrationSource(authority.canonicalPath, options.homeDir, token);
      const journal = readBackendMaintenanceJournal(options.homeDir);
      if (canonicalJson(current) !== expected
        || authenticatedAuthorities.get(current) !== authenticatedAuthorities.get(authority) || journal?.phase !== "maintenance-held"
        || journal.checksumSha256 !== captureOptions.maintenanceChecksumSha256
        || journal.generationId !== options.generationId) {
        throw new Error("SQLite migration source authority changed before seal");
      }
    };
    revalidate();
    const existing = await classifySqliteSnapshotArtifact(options.generationId, options);
    if (existing.state === "absent") {
      const maintenance = readBackendMaintenanceJournal(options.homeDir)!;
      if (maintenance.sourceSelectionSha256 !== authority.sourceSelectionSha256) {
        throw new Error("SQLite migration capture request does not match held binding");
      }
      if (authority.projectIdentity.scope !== "local" || maintenance.roster.length !== 1
        || maintenance.roster[0]!.machineId !== authority.machineIdentity.machineId) {
        throw new Error("migration participant authority is incomplete or disconnected");
      }
      const binding = await authenticateSqliteSnapshotCaptureBinding(authority, { ...options, lockToken: token });
      revalidate();
      // A failed/partial/replaced generation is immutable evidence. Check again
      // after private sampling, before any durable journal change.
      if ((await classifySqliteSnapshotArtifact(options.generationId, options)).state !== "absent") {
        throw new Error("SQLite migration generation appeared before capture binding");
      }
      const bound = rebindBackendMaintenanceCutoff({
        homeDir: options.homeDir, expectedChecksumSha256: captureOptions.maintenanceChecksumSha256,
        generationId: options.generationId, sourceSelectionSha256: authority.sourceSelectionSha256,
        queueEvidenceSha256: binding.expectedSourceBytes.checksumSha256,
        roster: [{ machineId: authority.machineIdentity.machineId, queueCutoff: binding.queueCutoff,
          evidenceSha256: binding.expectedSourceBytes.checksumSha256 }],
      }, token);
      captureOptions = { ...options, expectedSourceBytes: binding.expectedSourceBytes, maintenanceChecksumSha256: bound.checksumSha256 };
    }
    const artifact = await captureSqliteSnapshotArtifact(authority, { ...captureOptions, lockToken: token });
    revalidate();
    const maintenance = readBackendMaintenanceJournal(options.homeDir)!;
    const result = await withMigrationQueueEvidence(options.homeDir, artifact, maintenance, (reference, records) =>
      sealMigrationQueueEvidence(options.homeDir, artifact, reference, records, revalidate));
    revalidate();
    return result;
  }, options.lockToken);
}

export async function authenticateSqliteMigrationSourceBytes(
  authority: AuthenticatedSqliteSnapshotAuthority,
  options: SqliteSnapshotSourceByteOptions,
): Promise<SqliteSnapshotSourceByteWitness> {
  assertAuthenticatedAuthority(authority);
  return authenticateSqliteSnapshotSourceBytes(authority, options);
}

export async function dryRunAuthenticatedSqliteMigrationSource(
  cwd: string,
  homeDir: string,
): Promise<SqliteSnapshotDryRun> {
  const authority = authenticateSqliteMigrationSource(cwd, homeDir);
  return dryRunSqliteSnapshotArtifact(authority, { homeDir });
}

export function classifyImmutableSqliteSnapshot(
  generationId: string,
  homeDir: string,
): Promise<SqliteSnapshotClassification> {
  return classifySqliteSnapshotArtifact(generationId, { homeDir });
}

export function inspectImmutableSqliteSnapshot(
  generationId: string,
  homeDir: string,
): Promise<SqliteSnapshotArtifactWitness> {
  return inspectSqliteSnapshotArtifact(generationId, { homeDir });
}

export function assertMigrationReplayAdmission(input: Readonly<{
  homeDir: string;
  generationId: string;
  evidenceSha256: string;
}>): Readonly<{
  backend: StorageBackendName;
  disposition: "selected" | "source-abort";
}> {
  const journal = readBackendMaintenanceJournal(input.homeDir);
  if (
    journal === null
    || journal.generationId !== input.generationId
  ) {
    throw new BackendPublicationJournalError(
      "unexpected-state",
      "migration replay evidence does not match a terminal maintenance generation",
    );
  }
  if (
    journal.phase === "selection-completed"
    && journal.targetBackend !== null
    && journal.terminalEvidenceSha256 === input.evidenceSha256
  ) {
    return { backend: journal.targetBackend, disposition: "selected" };
  }
  if (journal.phase === "maintenance-aborted" && journal.abortEvidenceSha256 === input.evidenceSha256) {
    return { backend: "sqlite", disposition: "source-abort" };
  }
  throw new BackendPublicationJournalError(
    "unresolved-publication",
    "migration maintenance has no authoritative terminal replay state",
  );
}

type StaticSourceSelection = Readonly<{
  version: 1;
  backend: "sqlite";
  physicalProjectId: string;
  canonicalPath: string;
  projectDbPath: string;
  projectMapSha256: string;
  projectMetadataSha256: string;
  configSha256: string;
}>;

function staticSourceSelection(
  cwd: string,
  homeDir: string,
  publicationLockToken?: BackendPublicationLockToken,
): StaticSourceSelection {
  const configuration = readDaemonConfigSnapshot(join(homeDir, ".lcm", "config.json"));
  if (configuration.config.storage.backend !== "sqlite") throw new Error("SQLite migration requires SQLite to remain selected");
  const local = localProjectIdentity(cwd, homeDir);
  const projectDir = join(lcmHomeDir(homeDir), "projects", local.id);
  const metadata = readBoundedRegularFileWithStat(join(projectDir, "meta.json"), {
    allowedRoot: projectDir,
    maxBytes: 1024 * 1024,
    expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
    allowedModes: [0o600],
    requireSingleLink: true,
  });
  const projectMap = readProjectMapSnapshot(homeDir, publicationLockToken);
  return {
    version: 1,
    backend: "sqlite",
    configSha256: backendPublicationCanonicalSha256(configuration.witness),
    physicalProjectId: local.id,
    canonicalPath: local.canonical,
    projectDbPath: join(projectDir, "db.sqlite"),
    projectMapSha256: backendPublicationCanonicalSha256(projectMap),
    projectMetadataSha256: backendPublicationCanonicalSha256({
      rawSha256: createHash("sha256").update(metadata.content).digest("hex"),
      dev: metadata.dev,
      ino: metadata.ino,
      parentDev: metadata.parentDev,
      parentIno: metadata.parentIno,
    }),
  };
}

/**
 * Enroll a SQLite source for forward receipt enforcement without selecting the
 * PostgreSQL target. Remote I/O runs without the publication lock; exact local
 * selection evidence is re-read before any machine finalization or epoch open.
 */
export async function prepareSqliteMigrationEnrollment(
  input: SqliteMigrationEnrollmentInput,
  dependencyOverrides: SqliteMigrationEnrollmentDependencies = {},
): Promise<SqliteMigrationEnrollmentResult> {
  assertStorageBackendPublication({ backend: "sqlite", homeDir: input.homeDir });
  const before = staticSourceSelection(input.cwd, input.homeDir);
  const pending = ensurePendingMachineIdentity(input.displayName, input.homeDir);
  const openIdentitySession = dependencyOverrides.openIdentitySession
    ?? openPostgreSqlIdentitySession;
  const session = await openIdentitySession(input.targetConfig);
  let registered: Awaited<ReturnType<IdentityRepository["registerMachine"]>>;
  try {
    registered = await session.repository.registerMachine(
      pending.identity.identityKey,
      input.displayName ?? pending.identity.displayName,
    );
    const readback = await session.repository.recoverMachine(registered.machineId);
    if (readback.machineId !== registered.machineId || readback.identityKey !== pending.identity.identityKey) {
      throw new Error("SQLite migration remote machine readback did not match enrollment");
    }
    registered = readback;
  } finally {
    try { await session.close(); } catch { /* preserve remote outcome */ }
  }
  assertStorageBackendPublication({ backend: "sqlite", homeDir: input.homeDir });
  const afterRemote = staticSourceSelection(input.cwd, input.homeDir);
  if (backendPublicationCanonicalSha256(before) !== backendPublicationCanonicalSha256(afterRemote)) {
    throw new Error("SQLite migration source selection changed during machine enrollment");
  }
  const intendedIdentity = createMachineIdentity(
    pending.identity,
    registered.machineId,
    registered.displayName,
  );
  const assertEnrollmentIdentity = (identity: MachineIdentity): void => {
    const current = readMachineIdentity(input.homeDir);
    if (
      current === null
      || current.identityKey !== identity.identityKey
      || (current.machineId !== null && current.machineId !== identity.machineId)
    ) {
      throw new Error("SQLite migration machine identity changed before receipt adoption");
    }
  };
  const adopt = async (
    identity: MachineIdentity,
    token: BackendPublicationLockToken,
  ): Promise<void> => {
    const finalSelection = staticSourceSelection(input.cwd, input.homeDir, token);
    if (backendPublicationCanonicalSha256(before) !== backendPublicationCanonicalSha256(finalSelection)) {
      throw new Error("SQLite migration source selection changed before receipt adoption");
    }
    assertEnrollmentIdentity(identity);
    const factory = new SqliteStorageBackendFactory({
      resolveProject: () => ({ id: before.physicalProjectId, dbPath: before.projectDbPath }),
      _migrationEnrollmentIdentity: identity,
    });
    try {
      const project = await factory.openProject({
        id: before.physicalProjectId,
        canonical: before.canonicalPath,
      }, token);
      await project.close();
    } finally {
      await factory.close();
    }
    const afterAdoption = staticSourceSelection(input.cwd, input.homeDir, token);
    if (backendPublicationCanonicalSha256(before) !== backendPublicationCanonicalSha256(afterAdoption)) {
      throw new Error("SQLite migration source selection changed before identity publication");
    }
    assertEnrollmentIdentity(identity);
  };
  let identity: MachineIdentity | undefined;
  try {
    await withBackendPublicationAppendBarrierAsync(input.homeDir, async (token) => {
      assertStorageBackendPublication({ backend: "sqlite", homeDir: input.homeDir }, token);
      const selection = staticSourceSelection(input.cwd, input.homeDir, token);
      if (backendPublicationCanonicalSha256(before) !== backendPublicationCanonicalSha256(selection)) {
        throw new Error("SQLite migration source selection changed before finalization");
      }
      await adopt(intendedIdentity, token);
      identity = finalizeMachineIdentity(
        pending.identity,
        registered.machineId,
        registered.displayName,
        input.homeDir,
      );
    });
  } catch (error) {
    if (!(error instanceof MachineIdentityRegistrationChangedError)) throw error;
    const recoverySession = await openIdentitySession(input.targetConfig);
    try {
      const authoritative = await recoverySession.repository.recoverMachine(registered.machineId);
      if (
        authoritative.machineId !== registered.machineId
        || authoritative.identityKey !== pending.identity.identityKey
      ) throw error;
      const recovered = {
        version: 1,
        identityKey: authoritative.identityKey,
        machineId: authoritative.machineId,
        displayName: authoritative.displayName,
      } as const;
      await withBackendPublicationAppendBarrierAsync(input.homeDir, async (token) => {
        assertStorageBackendPublication({ backend: "sqlite", homeDir: input.homeDir }, token);
        const selection = staticSourceSelection(input.cwd, input.homeDir, token);
        if (backendPublicationCanonicalSha256(before) !== backendPublicationCanonicalSha256(selection)) {
          throw new Error("SQLite migration source selection changed before recovery");
        }
        const localIdentity = readMachineIdentity(input.homeDir);
        if (localIdentity?.identityKey !== pending.identity.identityKey
          || (localIdentity.machineId !== null && localIdentity.machineId !== registered.machineId)) throw error;
        await adopt(recovered, token);
        identity = recoverMachineIdentity(recovered, {
          homeDir: input.homeDir,
          force: true,
        }).identity;
      });
    } finally {
      try { await recoverySession.close(); } catch { /* preserve recovery result */ }
    }
  }
  if (identity === undefined) throw new Error("SQLite migration machine enrollment did not complete");
  return {
    identity,
    physicalProjectId: before.physicalProjectId,
    sourceSelectionSha256: backendPublicationCanonicalSha256({
      ...before,
      machineIdentity: identity,
    }),
  };
}
