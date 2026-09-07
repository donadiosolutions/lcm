import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ResolvedStorageConfig } from "../daemon/config.js";
import { localProjectIdentity } from "../daemon/project.js";
import {
  ensurePendingMachineIdentity,
  finalizeMachineIdentity,
  MachineIdentityRegistrationChangedError,
  recoverMachineIdentity,
  requireMachineIdentity,
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
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import type { StorageBackendName } from "../storage/contracts.js";
import {
  captureSqliteSnapshotArtifact,
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

const authenticatedAuthorities = new WeakSet<object>();

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
  authenticatedAuthorities.add(authority);
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
): Promise<SqliteSnapshotArtifactWitness> {
  assertAuthenticatedAuthority(authority);
  return captureSqliteSnapshotArtifact(authority, options);
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
}>;

function staticSourceSelection(
  cwd: string,
  homeDir: string,
  publicationLockToken?: BackendPublicationLockToken,
): StaticSourceSelection {
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
  } finally {
    try { await session.close(); } catch { /* preserve remote outcome */ }
  }
  assertStorageBackendPublication({ backend: "sqlite", homeDir: input.homeDir });
  const afterRemote = staticSourceSelection(input.cwd, input.homeDir);
  if (backendPublicationCanonicalSha256(before) !== backendPublicationCanonicalSha256(afterRemote)) {
    throw new Error("SQLite migration source selection changed during machine enrollment");
  }
  const adopt = async (
    identity: MachineIdentity,
    token: BackendPublicationLockToken,
  ): Promise<void> => {
    const finalSelection = staticSourceSelection(input.cwd, input.homeDir, token);
    if (backendPublicationCanonicalSha256(before) !== backendPublicationCanonicalSha256(finalSelection)) {
      throw new Error("SQLite migration source selection changed before receipt adoption");
    }
    const authenticatedIdentity = requireMachineIdentity(input.homeDir);
    if (authenticatedIdentity.machineId !== identity.machineId) {
      throw new Error("SQLite migration machine identity changed before receipt adoption");
    }
    const factory = new SqliteStorageBackendFactory({
      resolveProject: () => ({ id: before.physicalProjectId, dbPath: before.projectDbPath }),
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
  };
  let identity: MachineIdentity | undefined;
  try {
    await withBackendPublicationAppendBarrierAsync(input.homeDir, async (token) => {
      identity = finalizeMachineIdentity(
        pending.identity,
        registered.machineId,
        registered.displayName,
        input.homeDir,
      );
      await adopt(identity, token);
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
        identity = recoverMachineIdentity(recovered, {
          homeDir: input.homeDir,
          force: true,
        }).identity;
        await adopt(identity, token);
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
