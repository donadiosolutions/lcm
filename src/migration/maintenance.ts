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
import { resolveMigrationWitnessBindings, type MigrationSelectionBinding } from "./generation-binding-store.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { MigrationProtocolError, type MigrationManifest } from "./protocol.js";
import { lcmHomeDir } from "../runtime-paths.js";
import { readBoundedRegularFileWithStat } from "../security-files.js";
import { assertStorageBackendPublication } from "../storage/backend.js";
import {
  backendPublicationCanonicalSha256,
  BackendPublicationJournalError,
  isTerminalBackendMaintenancePhase,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  rebindBackendMaintenanceCutoff,
  resolveBackendMaintenanceGenerationBinding,
  withBackendPublicationAppendBarrierAsync,
  withBackendPublicationConsumerLock,
  type BackendMaintenanceJournal,
  type BackendPublicationJournal,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import type { StorageBackendName } from "../storage/contracts.js";
import {
  captureSqliteSnapshotArtifact,
  authenticateSqliteSnapshotCaptureBinding,
  authenticateSqliteSnapshotSourceBytes,
  classifySqliteSnapshotArtifact,
  dryRunSqliteSnapshotArtifact,
  inspectSqliteSnapshotArtifact,
  preflightSqliteSnapshotCapture,
  preflightSqliteSnapshotDryRun,
  type AuthenticatedSqliteSnapshotAuthority,
  type SqliteSnapshotArtifactWitness,
  type SqliteSnapshotClassification,
  type SqliteSnapshotDryRun,
  type SqliteSnapshotDryRunOptions,
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
import { enumerateStoredDataProjectHashes } from "./activation-coverage.js";
import {
  CutoverSetCaptureError,
  type CutoverSetMemberAuthorityOutcome,
  type CutoverSetMemberAuthorityResolution,
} from "./cutover-set.js";
import {
  resolveCutoverSetActivationSelection,
  type CutoverSetActivationSelectionResolution,
} from "./cutover-set-activation-store.js";
import {
  resolveCutoverSetRollbackCommitment,
  type CutoverSetRollbackCommitmentResolution,
} from "./cutover-set-rollback-store.js";
import { readActivationArtifact } from "./activation-artifact-store.js";
import { deriveActivationPublicationId } from "./activation-publication-id.js";
import { readRollbackReport } from "./rollback.js";
import { readMigrationActivationReport } from "./activation-report.js";

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

/**
 * The per-project authority outcomes for a cutover set (#1547): every
 * stored-data project, from the locked enumeration, is authenticated through
 * its project-map canonical path or reported uncovered / unverifiable. There
 * is no by-hash authenticator, so no project is omitted or bypassed.
 */
export function resolveCutoverSetMemberAuthorities(input: Readonly<{
  homeDir: string;
  lockToken: BackendPublicationLockToken;
}>): CutoverSetMemberAuthorityResolution {
  const enumeration = enumerateStoredDataProjectHashes({
    homeDir: input.homeDir,
    publicationLockToken: input.lockToken,
  });
  if (enumeration.status === "unresolvable") {
    return { status: "unresolvable", reason: enumeration.reason, detail: enumeration.detail };
  }
  const map = readProjectMapSnapshot(input.homeDir, input.lockToken);
  const outcomes = enumeration.projectHashes.map((physicalProjectId): CutoverSetMemberAuthorityOutcome => {
    const entry = map[physicalProjectId];
    if (entry === undefined) {
      return { physicalProjectId, status: "uncovered", detail: "the project map has no entry for this project" };
    }
    let authority: AuthenticatedSqliteSnapshotAuthority;
    try {
      authority = authenticateSqliteMigrationSource(entry.canonical, input.homeDir, input.lockToken);
    } catch (error) {
      return { physicalProjectId, status: "unverifiable", detail: (error as Error).message };
    }
    if (authority.physicalProjectId !== physicalProjectId) {
      return { physicalProjectId, status: "uncovered", detail: "canonical path authenticates a different project" };
    }
    return { physicalProjectId, status: "authenticated", authority };
  });
  return { status: "resolved", outcomes };
}

export async function captureAuthenticatedSqliteMigrationSource(
  authority: AuthenticatedSqliteSnapshotAuthority,
  options: SqliteSnapshotOptions,
): Promise<AuthenticatedSqliteMigrationSnapshot> {
  assertAuthenticatedAuthority(authority);
  preflightSqliteSnapshotCapture(authority, options);
  const expected = canonicalJson(authority);
  return withBackendPublicationAppendBarrierAsync(options.homeDir, async (token) => {
    let captureOptions = options;
    const revalidate = (): void => {
      const current = authenticateSqliteMigrationSource(authority.canonicalPath, options.homeDir, token);
      const journal = readBackendMaintenanceJournal(options.homeDir);
      const view = resolveBackendMaintenanceGenerationBinding(journal, options.generationId);
      if (journal?.cutoverSet !== undefined && journal.phase === "maintenance-held"
        && (view === null || view.sourceSelectionSha256 !== authority.sourceSelectionSha256)) {
        throw new CutoverSetCaptureError(
          "cutover-set-member-unbound",
          "the requested generation is not a member of the held set for this source authority",
        );
      }
      if (canonicalJson(current) !== expected
        || authenticatedAuthorities.get(current) !== authenticatedAuthorities.get(authority) || journal?.phase !== "maintenance-held"
        || view === null || view.checksumSha256 !== captureOptions.maintenanceChecksumSha256) {
        throw new Error("SQLite migration source authority changed before seal");
      }
    };
    revalidate();
    const held = readBackendMaintenanceJournal(options.homeDir)!;
    if (held.cutoverSet !== undefined) {
      // Membership is the exact stored-data set under the barrier; a project that gained or lost data
      // since entry drifts the set. Enumeration may reconcile the project map, so authority is revalidated.
      const enumeration = enumerateStoredDataProjectHashes({ homeDir: options.homeDir, publicationLockToken: token });
      if (enumeration.status === "unresolvable") {
        throw new CutoverSetCaptureError(
          "cutover-set-enumeration-unresolvable",
          `${enumeration.reason}: ${enumeration.detail}`,
        );
      }
      const members = held.cutoverSet.manifest.members.map((member) => member.physicalProjectId);
      if (canonicalJson(enumeration.projectHashes) !== canonicalJson(members)) {
        throw new CutoverSetCaptureError(
          "cutover-set-membership-drift",
          "the stored-data projects differ from the held set members",
          [...new Set([...members, ...enumeration.projectHashes])].filter((hash) =>
            members.includes(hash) !== enumeration.projectHashes.includes(hash)).sort(),
        );
      }
      revalidate();
    }
    const existing = await classifySqliteSnapshotArtifact(options.generationId, options);
    if (existing.state === "absent") {
      const maintenance = resolveBackendMaintenanceGenerationBinding(
        readBackendMaintenanceJournal(options.homeDir)!,
        options.generationId,
      )!;
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
      captureOptions = {
        ...options,
        expectedSourceBytes: binding.expectedSourceBytes,
        maintenanceChecksumSha256: resolveBackendMaintenanceGenerationBinding(bound, options.generationId)!.checksumSha256,
      };
    }
    const artifact = await captureSqliteSnapshotArtifact(authority, { ...captureOptions, lockToken: token });
    revalidate();
    const maintenance = resolveBackendMaintenanceGenerationBinding(
      readBackendMaintenanceJournal(options.homeDir)!,
      options.generationId,
    )!;
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
  options: Pick<SqliteSnapshotDryRunOptions, "_operationsForTesting"> = {},
): Promise<SqliteSnapshotDryRun> {
  const snapshotOptions: SqliteSnapshotDryRunOptions = {
    homeDir,
    ...(options._operationsForTesting === undefined
      ? {}
      : { _operationsForTesting: options._operationsForTesting }),
  };
  preflightSqliteSnapshotDryRun(snapshotOptions);
  const authority = authenticateSqliteMigrationSource(cwd, homeDir);
  return dryRunSqliteSnapshotArtifact(authority, snapshotOptions);
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

/**
 * True only for a valid manifest at phase rolled-back. rolled-back is a terminal phase, and the manifest
 * validation refuses a terminal phase with a pending effect (protocol.ts), so a valid rolled-back manifest has
 * none. A generation with no manifest at all is not manifest-backed (false); a manifest that is present but
 * cannot be read or validated refuses.
 */
function rolledBackWithoutPendingEffect(homeDir: string, generationId: string): boolean {
  try {
    const manifest = new MigrationManifestStore({ homeDir }).read(generationId);
    return manifest.phase === "rolled-back";
  } catch (error) {
    if (error instanceof MigrationProtocolError && error.message === "migration manifest head is absent") return false;
    throw new BackendPublicationJournalError(
      "unresolved-publication",
      "migration manifest cannot be read: " + (error as Error).message,
    );
  }
}

/**
 * Whether a replayed terminal `evidenceSha256` of a generation is an authoritative terminal state, and
 * which backend it selects. Decided from durable authority in this order (plan-v3.2 A15): a live
 * non-terminal maintenance of the generation refuses; the generation's selection bindings decide (the
 * last by manifest revision: activation selects postgresql, rollback selects sqlite); with no selection
 * recorded, a migration manifest at rolled-back refuses (no supported path leaves one without its selection
 * binding, and the replayed evidence could not be compared to anything); the generation's own terminal
 * maintenance journal, if the coordinator has not yet archived it, decides as before; everything else refuses.
 * Unresolvable bindings and an unreadable manifest refuse. Between the coordinator's archival of the
 * maintenance journal and the manifest's completion, admission refuses until the resume completes.
 */
export function assertMigrationReplayAdmission(input: Readonly<{
  homeDir: string;
  generationId: string;
  evidenceSha256: string;
}>): Readonly<{
  backend: StorageBackendName;
  disposition: "selected" | "source-abort";
}> {
  const journal = readBackendMaintenanceJournal(input.homeDir);
  // 0. A live, non-terminal cutover-set hold fences replay for every generation before any historical
  // selection binding is consulted: a member's old binding must not admit replay under an unsettled set.
  if (journal?.cutoverSet !== undefined && !isTerminalBackendMaintenancePhase(journal.phase)) {
    throw new BackendPublicationJournalError(
      "unresolved-publication",
      "migration maintenance has no authoritative terminal replay state",
    );
  }
  // 0b (#1549). A set at selection-completed is an aggregate target intent without a completed
  // publication: the handoff is fenced for every generation, including historical bindings, until the
  // coordinator archives this journal under the set's version-2 publication.
  if (journal?.cutoverSet !== undefined && journal.phase === "selection-completed") {
    throw new BackendPublicationJournalError(
      "unresolved-publication",
      "migration maintenance has no authoritative terminal replay state",
    );
  }
  const live = journal !== null && journal.generationId === input.generationId ? journal : null;
  // 1. A live, non-terminal maintenance of this generation: its selection is still pending.
  if (live !== null && !isTerminalBackendMaintenancePhase(live.phase)) {
    throw new BackendPublicationJournalError(
      "unresolved-publication",
      "migration maintenance has no authoritative terminal replay state",
    );
  }
  // 2. The recorded selection bindings, the last by manifest revision deciding. The live maintenance slot
  // is archived by the coordinator's next publication, so the bindings are the durable authority.
  const bindings = resolveMigrationWitnessBindings({ homeDir: input.homeDir, generationId: input.generationId });
  if (bindings.state === "unresolvable") {
    throw new BackendPublicationJournalError(
      "unresolved-publication",
      "migration selection bindings cannot be resolved: " + bindings.reason,
    );
  }
  // 1b (#1550, C3). A set member's rollback commitment, located from its own activation link, decides before any
  // binding: from the checkpoint on, the member's old activation evidence is fenced, and only the completed reverse
  // publication (or, later, the members' own rolled-back evidence under the selected sqlite installation) admits
  // the member's rollback witness. Positive absence falls through; an unresolvable commitment refuses.
  const commitment = resolveCutoverSetRollbackCommitment({ homeDir: input.homeDir, generationId: input.generationId });
  if (commitment.state === "unresolvable") {
    throw new BackendPublicationJournalError("unresolved-publication", "cutover-set rollback commitment cannot be resolved: " + commitment.reason);
  }
  if (commitment.state === "resolved") return assertCutoverSetRollbackReplayAdmission(input, commitment, journal);
  if (bindings.state === "resolved" && bindings.selections.length > 0) {
    const last = bindings.selections[bindings.selections.length - 1]!;
    if (last.witnessChecksumSha256 !== input.evidenceSha256) {
      throw new BackendPublicationJournalError(
        "unresolved-publication",
        "migration maintenance has no authoritative terminal replay state",
      );
    }
    if (last.kind === "rollback" && commitment.cause === "no-rollback") {
      // #1550 (D7.5). A set member (its link names a set publication) whose rollback binding survives without
      // the commitment it indexes admits nothing; the bare rollback -> sqlite answer stays the unlinked
      // single-generation rollback's alone.
      replayRefusal("the member's rollback binding indexes a set rollback whose commitment is absent: " + commitment.detail);
    }
    if (last.kind === "activation" && last.publicationId !== deriveActivationPublicationId(input.generationId)) {
      // #1549 (F2). A single-generation activation always names deriveActivationPublicationId(generationId);
      // any other activation publication id is a set publication, and a set member's binding is only an
      // index: the aggregate decides, and a missing or single-generation link refuses rather than admitting
      // the bare index (a missing link cannot prove legacy provenance).
      const aggregate = resolveCutoverSetActivationSelection({
        homeDir: input.homeDir, generationId: input.generationId, publicationId: last.publicationId,
      });
      return assertCutoverSetReplayAdmission(input, last, journal, aggregate);
    }
    return { backend: last.kind === "activation" ? "postgresql" : "sqlite", disposition: "selected" };
  }
  // 3. No selection binding is readable although the manifest is rolled back. The rollback records its selection
  // binding before its publication is prepared and before the manifest completes, and a generation that never
  // activated is refused before anything is written, so no supported path produces this state; admitting it would
  // route on evidence nothing here can be compared to. It refuses; re-running the rollback restores the binding
  // from the rollback report (recoverRolledBackAuthority), after which the binding decides as in step 2.
  if (rolledBackWithoutPendingEffect(input.homeDir, input.generationId)) {
    throw new BackendPublicationJournalError(
      "unexpected-state",
      "migration manifest is rolled back but records no selection binding; re-run the rollback to restore it",
    );
  }
  // 4. The terminal maintenance journal of this generation, not yet archived.
  const journalForGeneration = live;
  if (journalForGeneration === null) {
    throw new BackendPublicationJournalError(
      "unexpected-state",
      "migration replay evidence does not match a terminal maintenance generation",
    );
  }
  if (
    journalForGeneration.phase === "selection-completed"
    && journalForGeneration.targetBackend !== null
    && journalForGeneration.terminalEvidenceSha256 === input.evidenceSha256
  ) {
    return { backend: journalForGeneration.targetBackend, disposition: "selected" };
  }
  if (
    journalForGeneration.phase === "maintenance-aborted"
    && journalForGeneration.abortEvidenceSha256 === input.evidenceSha256
  ) {
    return { backend: journalForGeneration.sourceBackend, disposition: "source-abort" };
  }
  // 5. Anything else refuses.
  throw new BackendPublicationJournalError(
    "unresolved-publication",
    "migration maintenance has no authoritative terminal replay state",
  );
}

function replayRefusal(detail: string): never {
  throw new BackendPublicationJournalError("unresolved-publication", "cutover-set replay is not admitted: " + detail);
}

/**
 * Set member replay (#1549, plan-v2 C2). The member's activation selection
 * binding names a set publication (its id is not the generation's own
 * single-generation id), so the binding is an index only: the authenticated
 * aggregate (checkpoint, frozen selection, this member's row and the exact
 * artifact) must agree with it, and then the live slot decides. The set's
 * own completed version-2 publication admits when its project coverage is
 * exactly the artifact's; its own non-completed or aborted publication
 * refuses every member. When the slot is absent, foreign or occupied by a
 * later maintenance journal, only the member's active manifest and its
 * authenticated activation report naming this set publication, identity
 * digest and witness admit; a report-only activating member refuses. No
 * archived journal is read and no store is scanned.
 */
function assertCutoverSetReplayAdmission(
  input: Readonly<{ homeDir: string; generationId: string; evidenceSha256: string }>,
  binding: MigrationSelectionBinding,
  maintenance: BackendMaintenanceJournal | null,
  aggregate: CutoverSetActivationSelectionResolution,
): Readonly<{ backend: StorageBackendName; disposition: "selected" }> {
  if (aggregate.state !== "resolved") {
    replayRefusal(aggregate.state === "absent" ? aggregate.detail : aggregate.reason);
  }
  const member = aggregate.member;
  if (
    member.witnessChecksumSha256 !== input.evidenceSha256
    || member.epochId !== binding.epochId
    || member.attemptId !== binding.attemptId
    || member.epochManifestRevision !== binding.manifestRevision
  ) {
    replayRefusal("the member's selection binding does not restate its row of the set selection");
  }
  // The version-3 reader returns null for a version-2 journal; the version-2 reader refuses a live
  // version-3 one, so the slot is read as a publication only when no maintenance journal occupies it.
  const publication: BackendPublicationJournal | null = maintenance === null ? readBackendPublicationJournal(input.homeDir) : null;
  if (publication !== null && publication.publicationId === aggregate.setId) {
    if (publication.phase !== "completed") {
      replayRefusal("the set publication is at phase " + publication.phase + ", not completed");
    }
    const rows = aggregate.artifact.projects;
    const covered = publication.projects.length === rows.length && publication.projects.every((project, index) => {
      const expected = rows[index]!;
      return project.localProjectId === expected.localProjectId
        && project.remoteProjectId === expected.remoteProjectId
        && project.evidenceSha256 === expected.evidenceSha256;
    });
    if (!covered) replayRefusal("the completed set publication does not cover exactly the set artifact's projects");
    return { backend: "postgresql", disposition: "selected" };
  }
  let manifest: MigrationManifest;
  try {
    manifest = new MigrationManifestStore({ homeDir: input.homeDir }).read(input.generationId);
  } catch (error) {
    replayRefusal("the member manifest cannot be read: " + (error as Error).message);
  }
  if (manifest.phase !== "active") {
    replayRefusal("the member manifest is at phase " + manifest.phase + " and no completed set publication occupies the slot");
  }
  const reports = manifest.reports.filter((report) => report.kind === "activation");
  const reference = reports[reports.length - 1]!;
  const read = readMigrationActivationReport({ homeDir: input.homeDir, generationId: input.generationId, reportSha256: reference.reportSha256 });
  if (read.state !== "resolved") replayRefusal("the member's activation report is " + read.state + ": " + read.detail);
  const body = read.report.body;
  const named = canonicalJson({
    publicationId: body.publicationId, identityDigest: body.identityDigest, witnessChecksumSha256: body.witnessChecksumSha256,
    epochId: body.epochId, attemptId: body.attemptId,
  });
  const expected = canonicalJson({
    publicationId: aggregate.setId, identityDigest: aggregate.selection.identityDigest, witnessChecksumSha256: input.evidenceSha256,
    epochId: member.epochId, attemptId: member.attemptId,
  });
  if (named !== expected) {
    replayRefusal("the member's activation report does not name this set publication, identity digest and witness");
  }
  return { backend: "postgresql", disposition: "selected" };
}

/**
 * Set member replay under a rollback commitment (#1550, C3). The commitment
 * (the rollback checkpoint found from the member's activation link) fences
 * every member's old activation evidence at once. Until the rollback's
 * selection is frozen nothing is admitted. The frozen tuple's row for the
 * member must carry the presented evidence (its rollback witness; the old
 * activation witness never matches). Then the live slot decides: the
 * rollback hold at any phase refuses; the rollback's own completed reverse
 * publication admits when it covers exactly the reverse artifact's projects;
 * its own non-completed or aborted publication refuses. When the slot is
 * absent, foreign or a later hold, every member must be rolled back with the
 * rollback report of its frozen witness and the currently selected
 * installation must be sqlite with every member unbound; then sqlite is
 * admitted. No archived journal is read and no store is scanned.
 */
function rollbackReplayRefusal(detail: string): never {
  throw new BackendPublicationJournalError("unresolved-publication", "cutover-set rollback replay is not admitted: " + detail);
}

function assertCutoverSetRollbackReplayAdmission(
  input: Readonly<{ homeDir: string; generationId: string; evidenceSha256: string }>,
  commitment: Extract<CutoverSetRollbackCommitmentResolution, { state: "resolved" }>,
  maintenance: BackendMaintenanceJournal | null,
): Readonly<{ backend: "sqlite"; disposition: "selected" }> {
  const { checkpoint, selection } = commitment.records;
  if (selection === null) rollbackReplayRefusal("set " + commitment.originalSetId + " is committed to roll back and its selection is not frozen");
  const row = selection.members.find((candidate) => candidate.generationId === input.generationId);
  if (row === undefined || row.witnessChecksumSha256 !== input.evidenceSha256) {
    rollbackReplayRefusal("the presented evidence is not the member's rollback witness");
  }
  if (maintenance !== null && maintenance.generationId === checkpoint.setId) {
    rollbackReplayRefusal("the rollback hold is at phase " + maintenance.phase + "; the reverse publication has not completed");
  }
  const publication: BackendPublicationJournal | null = maintenance === null ? readBackendPublicationJournal(input.homeDir) : null;
  if (publication !== null && publication.publicationId === checkpoint.setId) {
    if (publication.phase !== "completed") rollbackReplayRefusal("the reverse publication is at phase " + publication.phase + ", not completed");
    let artifact;
    try {
      artifact = readActivationArtifact({ homeDir: input.homeDir, identityDigest: checkpoint.identityDigest });
    } catch (error) {
      rollbackReplayRefusal("the reverse artifact is unresolvable: " + (error as Error).message);
    }
    if (artifact === null || artifact.publicationId !== checkpoint.setId) rollbackReplayRefusal("the reverse artifact is absent or sealed under another publication");
    const rows = artifact.projects;
    const covered = publication.projects.length === rows.length && publication.projects.every((project, index) => {
      const expected = rows[index]!;
      return project.localProjectId === expected.localProjectId && project.remoteProjectId === expected.remoteProjectId && project.evidenceSha256 === expected.evidenceSha256;
    });
    if (!covered) rollbackReplayRefusal("the completed reverse publication does not cover exactly the reverse artifact's projects");
    return { backend: "sqlite", disposition: "selected" };
  }
  const store = new MigrationManifestStore({ homeDir: input.homeDir });
  for (const member of selection.members) {
    let manifest: MigrationManifest;
    try {
      manifest = store.read(member.generationId);
    } catch (error) {
      rollbackReplayRefusal("member " + member.generationId + "'s manifest cannot be read: " + (error as Error).message);
    }
    if (manifest.phase !== "rolled-back" || manifest.rollbackLineage.mode !== member.mode) {
      rollbackReplayRefusal("member " + member.generationId + " is at phase " + manifest.phase + " and no completed reverse publication occupies the slot");
    }
    const reference = [...manifest.reports].reverse().find((candidate) => candidate.kind === "rollback")!;
    let report;
    try {
      report = readRollbackReport(input.homeDir, member.generationId, reference.reportId);
    } catch (error) {
      rollbackReplayRefusal("member " + member.generationId + "'s rollback report cannot be read: " + (error as Error).message);
    }
    if (report === null || report.checksumSha256 !== reference.reportSha256 || report.effectId !== "rollback-publish-" + member.witnessChecksumSha256
      || report.epochId !== member.epochId || report.attemptId !== member.attemptId || report.mode !== member.mode) {
      rollbackReplayRefusal("member " + member.generationId + "'s rollback report does not name its frozen witness, epoch, attempt and mode");
    }
  }
  let backend: string;
  let map: ReturnType<typeof readProjectMapSnapshot>;
  try {
    // The configuration as the daemon reads and parses it (the service's completion readback uses the same reader).
    backend = readDaemonConfigSnapshot(join(lcmHomeDir(input.homeDir), "config.json")).config.storage.backend;
    map = withBackendPublicationConsumerLock(input.homeDir, (token) => readProjectMapSnapshot(input.homeDir, token), { allowUnresolved: true });
  } catch (error) {
    rollbackReplayRefusal("the selected installation cannot be read: " + (error as Error).message);
  }
  if (backend !== "sqlite") rollbackReplayRefusal("the configuration selects " + backend + ", not the restored sqlite installation");
  for (const member of selection.members) {
    const entry = map[member.physicalProjectId];
    if (entry === undefined || entry.remoteProjectId !== undefined) rollbackReplayRefusal("member " + member.generationId + " is still bound to a destination project");
  }
  return { backend: "sqlite", disposition: "selected" };
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
