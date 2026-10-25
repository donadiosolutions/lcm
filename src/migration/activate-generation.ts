import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DEFAULT_DAEMON_PORT, parseStoredConfig, readDaemonConfigRawSnapshot } from "../daemon/config.js";
import { MachineIdentityFileError, requireMachineIdentity } from "../machine-identity.js";
import { configPath, daemonPidPath, lcmHomeDir } from "../runtime-paths.js";
import { PRIVATE_FILE_MODE, readBoundedRegularFileWithStat } from "../security-files.js";
import {
  backendPublicationCanonicalSha256,
  backendPublicationConfigSha256,
  backendPublicationProjectMapSha256,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationAppendBarrierAsync,
  type BackendMaintenanceJournal,
  type BackendPublicationJournal,
  type BackendPublicationLockToken,
  type BackendPublicationRecoveryFile,
  type CompleteBackendMaintenanceSelectionInput,
  type PrepareBackendMaintenanceSelectionInput,
  type PrepareBackendPublicationInput,
  type RecoverPendingOptions,
} from "../storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../storage/backend-publication-driver.js";
import {
  composeBackendPublicationMaterial,
  type ComposeBackendPublicationMaterialInput,
  type ComposeBackendPublicationMaterialResult,
} from "../storage/backend-publication-material.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import { StorageOperationError } from "../storage/errors.js";
import { PortableStreamError } from "../storage/portable-record.js";
import type { PostgreSqlConnectionSettings, PostgreSqlQueryExecutor, PostgreSqlRuntimeHealth } from "../storage/postgresql/contracts.js";
import {
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
  PostgreSqlBackendPublicationGuardError,
} from "../storage/postgresql/publication-guard.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../storage/postgresql/publication-remote-guard.js";
import { PostgreSqlRuntime } from "../storage/postgresql/runtime.js";
import {
  verifyPostgreSqlRuntimeSchema,
  verifyPostgreSqlTransferSchema,
  type PostgreSqlRuntimeReadiness,
  type PostgreSqlRuntimeReadinessOptions,
} from "../storage/postgresql/runtime-readiness.js";
import type { PostgreSqlSnapshotSession } from "../storage/postgresql/snapshot-session.js";
import {
  ActivationArtifactIdentityMismatchError,
  ActivationArtifactPresenceUnresolvableError,
  ActivationArtifactValidationError,
  ActivationGenerationLinkConflictError,
  computeActivationArtifactIdentityDigest,
  publishActivationArtifact,
  readActivationArtifact,
  readActivationGenerationLink,
  recordActivationGenerationLink,
  type ActivationArtifactRecoveryMaterial,
  type ActivationGenerationLink,
  type ActivationGenerationLinkReadResult,
  type ActivationGenerationLinkRecordResult,
} from "./activation-artifact-store.js";
import {
  checkActivationProjectCoverage,
  enumerateStoredDataProjectHashes,
  evaluateActivationSingleProjectCoverage,
  type ActivationCoverageResult,
  type StoredDataProjectEnumeration,
} from "./activation-coverage.js";
import {
  acquireActivationLease,
  releaseActivationLease,
  renewActivationLease,
  resolveActivationLeaseFence,
  takeoverActivationLease,
  type ActivationLeaseAcquireResult,
  type ActivationLeaseFence,
  type ActivationLeasePublicationGuard,
  type ActivationLeaseRenewResult,
  type ActivationLeaseReleaseResult,
  type ActivationLeaseTakeoverResult,
} from "./activation-lease.js";
import {
  driveActivationPublication,
  type ActivationPublicationCoordinator,
  type ActivationPublicationResult,
} from "./activation-publication.js";
import { deriveActivationPublicationId } from "./activation-publication-id.js";
import { checkActivationWriterQuiescence, type ActivationQuiescenceResult } from "./activation-quiescence.js";
import {
  createMigrationActivationReport,
  persistMigrationActivationReport,
  readMigrationActivationReport,
  migrationActivationReportReference,
  MigrationActivationReportError,
  type MigrationActivationReport,
  type MigrationActivationReportPersistResult,
  type MigrationActivationReportReadResult,
} from "./activation-report.js";
import { checkActivationRestartAdmission, type ActivationRestartCheckResult } from "./activation-restart-check.js";
import {
  MigrationActivationEvidenceRefusalError,
  readMigrationActivationEvidence,
  recordMigrationActivationAttempt,
  recordMigrationActivationEpoch,
  recordMigrationActivationWitness,
  type MigrationActivationEvidenceResolution,
} from "./activation-evidence-store.js";
import {
  createMigrationActivationAttempt,
  createMigrationActivationEpoch,
  createMigrationActivationWitness,
  createMigrationQuiescenceFence,
  migrationCensusVectorsEqual,
  migrationWitnessSha256,
  type MigrationActivationAttempt,
  type MigrationActivationEpoch,
  type MigrationActivationWitness,
  type MigrationCanonicalDelta,
  type MigrationCensusVector,
  type MigrationDestinationIdentity,
  type MigrationSelectionAuthority,
} from "./activation-witness.js";
import { readMigrationCopyBindingSha256, type MigrationCopyBindingReadResult } from "./copy-binding-reader.js";
import {
  recordMigrationSelectionBinding,
  recordMigrationWitnessBinding,
  resolveMigrationWitnessBindings,
  type MigrationSelectionBinding,
  type MigrationWitnessBinding,
  type MigrationWitnessResolution,
} from "./generation-binding-store.js";
import { MigrationManifestStore, migrationManifestRevisionPath, migrationManifestGenerationDirectory } from "./manifest-store.js";
import {
  computeMigrationProjectMapWitnessSha256,
  MigrationProjectMapWitnessError,
  type ComputeMigrationProjectMapWitnessInput,
} from "./project-map-witness.js";
import {
  beginMigrationEffect,
  classifyMigrationRecovery,
  completeMigrationEffect,
  parseMigrationManifest,
  MigrationProtocolError,
  type MigrationManifest,
  type MigrationReportReference,
} from "./protocol.js";
import { checkMigrationTargetHealth, classifyMigrationTargetFailure, type MigrationTargetHealthResult, type MigrationTargetHealthRuntime } from "./target-health.js";
import type { MigrationVerificationReport } from "./verification-report.js";
import { MigrationVerificationReportStore, MigrationVerificationStoreError } from "./verification-store.js";
import {
  assertDestinationIdentityMatches,
  buildMigrationCanonicalDelta,
  buildMigrationCensusVector,
  captureDestinationIdentity,
  readFencedDestinationCensus,
  type MigrationVerificationDomainCensus,
} from "./verify-generation.js";

/**
 * The migration activation orchestrator (#625, plan-v7.1): one entry point
 * for a fresh activation and for crash recovery, runMigrationActivation.
 * It classifies durable state first (step C; an absent manifest is refused
 * before the append barrier, which would create the LCM home, and the machine
 * identity is read only once an ordinary runtime is about to open), enters the
 * matching row of plan-v5 section 7, and runs the S0-S16 sequence under one retained
 * append-barrier token (I5), publishing the version-2 backend selection
 * for exactly one verified generation.
 *
 * Reading guide (the normative text is plan-v7 + the plan-review-2
 * synthesis amendments 1-5 + owner rulings R1-R4; every binding below cites
 * its source so a reader can check it rather than trust this comment):
 *
 * - Closed vocabularies: outcomes (activated | refused | interrupted |
 *   publication-failed | post-publication-unhealthy), refusal reasons
 *   (plan-v6 section 1 G1 plus v7.1), interruption causes (A7). Only
 *   MigrationActivationError {invalid-input | unexpected-state} is thrown,
 *   for a programming error or a state the classifier cannot name; every
 *   I/O failure and typed sibling error is mapped to an outcome. Unknown
 *   errors rethrow.
 * - Step C (synthesis section 5): manifest (classifyMigrationRecovery), G6
 *   link, artifact, v3 journal, v2 journal, #626 evidence, binding store,
 *   and the lease row only as classification. Contradictions are
 *   state-unresolvable. Settled active with an authenticated stored G5
 *   report returns activated from durable state with a fresh read-only
 *   restart verdict; settled active without it is interrupted
 *   report-unresolvable at S16. The restart verdict is an observation:
 *   the daemon port comes from the stored config without resolving the
 *   daemon's storage secrets (the published selection is postgresql, and
 *   the activation process need not carry LCM_POSTGRES_URL / CA_FILE), and
 *   a failure to observe (unreadable config, probe error) is reported as
 *   the restart module's own unresolvable / health-unreachable result,
 *   never thrown, at S15 and on settled-active alike.
 * - S0 (fresh only): publicationId = deriveActivationPublicationId;
 *   evidenceSha256 read back from lcm.transfer_runs (A5) on a transfer
 *   session that is opened, used once and closed before S2.
 * - S1 one withBackendPublicationAppendBarrierAsync callback spans S1-S16.
 * - S2 lease per project with A2 continuation (renew; stale-token -> second
 *   renew with the returned token; expired -> CAS takeover which mints a
 *   NEW attempt pre-selection; post-selection takeover never mints an
 *   attempt and returns successorFencingToken on the outcome only).
 *   ttlMs is MIGRATION_ACTIVATION_LEASE_TTL_MS; renewed after S7, before
 *   S12 and before S13b.
 * - The S2 lease is released again when the run ends without this
 *   activation having begun a durable effect: every refusal after S2 and
 *   every S9 begin failure or thrown error for which an authenticated
 *   manifest readback proves nothing was written (headPositivelyUnbegun;
 *   a begin that committed and then threw keeps its lease). See
 *   releaseAbandonedLease. acquireActivationLease never displaces an
 *   unreleased row of another generation, expired or not, so a refused run
 *   that kept its row would block every other generation of the project
 *   for good. The release is best effort: a failure never changes the
 *   outcome vocabulary (a refusal or S9 interruption carries it appended to
 *   its detail, a thrown error is rethrown unchanged), and a same-generation
 *   re-run reacquires or takes over a row that was left behind and ends it
 *   the same way. It runs under its own bounded signal
 *   (deps.leaseCleanupTimeoutMs), so a run cancelled through input.signal
 *   still frees its row. Once an effect has begun the row is kept:
 *   the generation is committed to roll forward on the next call (A2
 *   reacquire / takeover) and the coordinator's own release phase frees it.
 * - S3 quiescence, S4 coverage then G8, S4b (amendment 1) compose material
 *   and freeze the verified manifest's revision/checksum IN MEMORY; the
 *   link is written only after the artifact at S11.
 * - Before S2, the live ordinary destination identity is rebound and both
 *   sessions prove distinct current_user/session_user role identities. S5
 *   then retains report freshness and pre-publication projectMapWitness.
 * - S6 G7 health runs on the ordinary runtime profile while admitting the
 *   discovered transfer role as one caller-scoped peer. S7 census runs on a
 *   NEW transfer snapshot after transfer-profile admission with the ordinary
 *   role as its peer (amendment 4). S8: every class ran, mismatch totals
 *   zero, recomputed census equals the report's.
 * - S9/S10 prepare-activation (inputSha256 = sha(epochId)) and
 *   publish-activation begin. S11 artifact -> link -> epoch -> attempt ->
 *   witness -> witness binding (mandatory order, plan-v6 section 7).
 * - S12 v3 selection (prepare/complete/skip by phase). S13a selection
 *   binding BEFORE any prepare() (A13). S13b drive (amendment 3, in
 *   activation-publication.ts). S15 health + restart (R1). S16 readback,
 *   post-publication projectMapWitness, G5 report, completeMigrationEffect.
 * - applied / reportStored (amendment 2) are evidence-derived, never
 *   step-derived; see classifyApplied below.
 *
 * The #626 evidence store, witness-binding resolver and census builders
 * are wired at exactly one point, createMigrationActivationDependencies;
 * the dependency seams below group them for deterministic fault injection.
 * A maintenance journal entered from any backend other than sqlite is a
 * rollback window (#626): foreign state at every read site, reported with
 * the existing maintenance-not-held / journal-unexpected vocabulary.
 */

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

export type MigrationActivationRefusalStep = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8";

export type MigrationActivationInterruptionStep =
  | "S9" | "S10" | "S11" | "S12" | "S13a" | "S13b" | "S15" | "S16";

export type MigrationActivationRefusalReason =
  | "manifest-absent"
  | "manifest-not-eligible"
  | "manifest-unresolvable"
  | "pending-effect-foreign"
  | "maintenance-not-held"
  | "maintenance-unresolvable"
  | "lease-conflict"
  | "lease-unresolvable"
  | "quiescence-unsatisfied"
  | "quiescence-unresolvable"
  | "coverage-unsatisfied"
  | "coverage-unresolvable"
  | "uncovered-projects"
  | "verification-stale"
  | "verification-unresolvable"
  | "identity-drift"
  | "project-map-drift"
  | "target-unhealthy"
  | "target-unresolvable"
  | "census-drift"
  | "class-coverage-incomplete"
  | "verification-mismatch"
  | "evidence-unresolvable"
  | "state-unresolvable";

export type MigrationActivationInterruptionCause =
  | "lease-lost"
  | "lease-unresolvable"
  | "evidence-conflict"
  | "evidence-unresolvable"
  | "binding-conflict"
  | "binding-unresolvable"
  | "link-conflict"
  | "artifact-identity-mismatch"
  | "artifact-unresolvable"
  | "journal-unexpected"
  | "readback-mismatch"
  | "project-map-drift"
  | "report-conflict"
  | "report-unresolvable"
  | "state-unresolvable";

export type MigrationActivationTriState = "no" | "yes" | "unknown";

/** The live config and project map digests an interruption's `applied` readback compares against witnesses. */
export type MigrationActivationSelectionDigests = Readonly<{ configSha256: string; projectMapSha256: string }>;

/** {generationId, publicationId?, manifestRevision?}: fields only when evidenced (amendment 2). */
export type MigrationActivationIdentity = Readonly<{
  generationId: string;
  publicationId?: string;
  manifestRevision?: number;
}>;

export type MigrationActivationResumePoint =
  | "fresh"
  | "prepare-activation-pending"
  | "activating-no-effect"
  | "publish-pending-before-artifact"
  | "publish-pending-after-link"
  | "selection-prepared"
  | "selection-completed-unbound"
  | "selection-completed-bound"
  | "publication-journal"
  | "settled-active";

export type MigrationActivationOutcome =
  | Readonly<{
    status: "activated";
    identity: Required<MigrationActivationIdentity>;
    report: MigrationReportReference;
    restart: ActivationRestartCheckResult;
    resumedFrom: MigrationActivationResumePoint;
    /** A post-selection takeover's advanced fencing token (A2), when one happened. */
    successorFencingToken: string | null;
  }>
  | Readonly<{
    status: "refused";
    step: MigrationActivationRefusalStep;
    reason: MigrationActivationRefusalReason;
    detail: string;
    effectBegun: false;
  }>
  | Readonly<{
    status: "interrupted";
    step: MigrationActivationInterruptionStep;
    cause: MigrationActivationInterruptionCause;
    detail: string;
    effectBegun: boolean;
    applied: MigrationActivationTriState;
    reportStored: MigrationActivationTriState;
    identity: MigrationActivationIdentity;
  }>
  | Readonly<{
    status: "publication-failed";
    publication: ActivationPublicationResult;
    identity: MigrationActivationIdentity;
  }>
  | Readonly<{
    status: "post-publication-unhealthy";
    health: MigrationTargetHealthResult;
    restart: ActivationRestartCheckResult;
    identity: MigrationActivationIdentity;
  }>;

export class MigrationActivationError extends Error {
  constructor(readonly reason: "invalid-input" | "unexpected-state", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationActivationError";
  }
}

/** plan-v7.1 A2: 15 minutes. One census or publication stretch must finish
 * within it; expiry is recovered by takeover on the next call, never silently. */
export const MIGRATION_ACTIVATION_LEASE_TTL_MS = 15 * 60 * 1000;

/** The bound on the best-effort pre-effect lease cleanup (one release, or a
 * takeover and a release), which runs under its own signal so a cancelled
 * run still frees its row (Bug #1641). */
export const MIGRATION_ACTIVATION_LEASE_CLEANUP_TIMEOUT_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// Input and dependency seams
// ---------------------------------------------------------------------------

export type MigrationActivationInput = Readonly<{
  homeDir: string;
  generationId: string;
  /** Transfer-role settings (A5 copy-binding read and the S7 census). S7
   * admits the live ordinary role as its one caller-scoped canonical peer. */
  transferSettings: PostgreSqlConnectionSettings;
  /** Daemon runtime-role settings for the S2 lease guard and S6/S15 health.
   * Health uses runtime admission with the live transfer role as its one
   * caller-scoped canonical peer. The two sessions must name distinct roles
   * on the same sealed destination before any ordinary-runtime effect. */
  ordinarySettings: PostgreSqlConnectionSettings;
  /** The destination project identity #627 resolved for verify: id, canonical,
   * remoteProjectId (PostgreSQL UUIDv7) and localProjectId (project hash).
   * The UUIDv7 form is guaranteed upstream, not assumed here: the identity
   * repository mints remote project ids with pg_catalog.uuidv7()
   * (src/storage/postgresql/identity-repository.ts) and project-map.ts admits
   * only a normalizeUuidV7 value as a stored binding; the copy-binding reader
   * and the project-map witness re-validate it with the same normalizer. */
  expectedIdentity: StorageIdentityContext;
  /** The migration role the destination schema is owned by (amendment 4). */
  expectedOwner: string;
  signal?: AbortSignal;
  now?: () => Date;
}>;

/** The subset of PostgreSqlRuntime the ordinary role uses. */
export type MigrationActivationOrdinaryRuntime = MigrationTargetHealthRuntime & Readonly<{
  backendPublicationGuard(): ActivationLeasePublicationGuard;
  close(): Promise<void>;
}>;

/** The subset of PostgreSqlRuntime the transfer role uses. */
export type MigrationActivationTransferRuntime = PostgreSqlQueryExecutor & Readonly<{
  openReadOnlySnapshot(input: Readonly<{ projectId: string; signal?: AbortSignal }>): Promise<MigrationActivationSnapshot>;
  close(): Promise<void>;
}>;

export type MigrationActivationSnapshot = PostgreSqlQueryExecutor & Readonly<{
  close(): Promise<void>;
}>;

export type MigrationActivationRoleIdentityRead = Readonly<{
  currentUser: string;
  sessionUser: string;
  oid: string;
  tls: boolean;
}>;

/** The coordinator surface this module drives: maintenance selection plus
 * the drive's own interface. A real BackendPublicationCoordinator satisfies it. */
export interface MigrationActivationCoordinator extends ActivationPublicationCoordinator {
  prepareMaintenanceSelection(
    input: PrepareBackendMaintenanceSelectionInput,
    lockToken: BackendPublicationLockToken,
  ): Promise<BackendMaintenanceJournal>;
  completeMaintenanceSelection(
    input: CompleteBackendMaintenanceSelectionInput,
    lockToken: BackendPublicationLockToken,
  ): Promise<BackendMaintenanceJournal>;
}

/** The #626 activation evidence store (activation-evidence-store.ts). The
 * writers refuse with MigrationActivationEvidenceRefusalError, recognised
 * by instanceof. */
export interface MigrationActivationEvidenceSeam {
  recordMigrationActivationEpoch(input: Readonly<{ homeDir: string; epoch: MigrationActivationEpoch }>): void;
  recordMigrationActivationAttempt(
    input: Readonly<{ homeDir: string; generationId: string; attempt: MigrationActivationAttempt }>,
  ): void;
  recordMigrationActivationWitness(
    input: Readonly<{ homeDir: string; generationId: string; witness: MigrationActivationWitness }>,
  ): void;
  readMigrationActivationEvidence(
    input: Readonly<{ homeDir: string; generationId: string }>,
  ): MigrationActivationEvidenceResolution;
}

/** The generation binding store writers plus the #626 resolver. */
export interface MigrationActivationBindingSeam {
  recordMigrationWitnessBinding: typeof recordMigrationWitnessBinding;
  recordMigrationSelectionBinding: typeof recordMigrationSelectionBinding;
  resolveMigrationWitnessBindings(
    input: Readonly<{ homeDir: string; generationId: string }>,
  ): MigrationWitnessResolution;
}

/** The verification census builders (verify-generation.ts, A10). */
export interface MigrationActivationCensusSeam {
  buildMigrationCensusVector(domains: readonly MigrationVerificationDomainCensus[]): MigrationCensusVector;
  buildMigrationCanonicalDelta(domains: readonly MigrationVerificationDomainCensus[]): MigrationCanonicalDelta;
}

/** Deterministic injection points for crash-row tests: throw inside to
 * simulate a crash exactly after the named durable step. Production leaves
 * it undefined. */
export type MigrationActivationCrashPoint = (point: string) => void;

export interface MigrationActivationDependencies {
  readonly manifestStore: Pick<MigrationManifestStore, "read" | "update">;
  /** The immutable revision file named by (revision, checksum); lineage walk on re-entry only. */
  readonly readManifestRevision: typeof readMigrationManifestRevision;
  readonly readVerificationReport: (generationId: string, reportSha256: string) => MigrationVerificationReport;
  readonly createOrdinaryRuntime: (settings: PostgreSqlConnectionSettings) => MigrationActivationOrdinaryRuntime;
  readonly createTransferRuntime: (settings: PostgreSqlConnectionSettings) => MigrationActivationTransferRuntime;
  readonly readRoleIdentity: (
    executor: PostgreSqlQueryExecutor,
    signal?: AbortSignal,
  ) => Promise<MigrationActivationRoleIdentityRead>;
  /** Runtime-profile admission used by S6/S15 with the discovered transfer
   * role as the one caller-scoped peer. */
  readonly verifyRuntimeSchema: (
    executor: PostgreSqlQueryExecutor,
    options: PostgreSqlRuntimeReadinessOptions,
  ) => Promise<PostgreSqlRuntimeReadiness>;
  /** Transfer-profile admission used by S7 with the discovered runtime role
   * as the one caller-scoped peer. */
  readonly verifyTransferSchema: (
    executor: PostgreSqlQueryExecutor,
    options: PostgreSqlRuntimeReadinessOptions,
  ) => Promise<PostgreSqlRuntimeReadiness>;
  readonly checkTargetHealth: typeof checkMigrationTargetHealth;
  readonly readCopyBinding: typeof readMigrationCopyBindingSha256;
  readonly captureDestinationIdentity: (
    executor: PostgreSqlQueryExecutor, projectId: string, signal?: AbortSignal,
  ) => Promise<MigrationDestinationIdentity>;
  readonly readDestinationCensus: (
    session: MigrationActivationSnapshot,
    input: Readonly<{
      settings: PostgreSqlConnectionSettings; expectedOwner: string; expectedIdentity: StorageIdentityContext;
      scratchParent: string; signal?: AbortSignal;
    }>,
  ) => Promise<Readonly<{ census: readonly MigrationVerificationDomainCensus[] }>>;
  /** Allocates S7's census scratch directory (default: mkdtemp under the LCM
   * home). Called only at S7, so refusals before it never touch the disk. */
  readonly allocateScratch: (homeDir: string) => string;
  readonly census: MigrationActivationCensusSeam;
  readonly withAppendBarrier: typeof withBackendPublicationAppendBarrierAsync;
  readonly checkQuiescence: typeof checkActivationWriterQuiescence;
  readonly checkCoverage: typeof checkActivationProjectCoverage;
  readonly enumerateStoredData: typeof enumerateStoredDataProjectHashes;
  readonly computeProjectMapWitness: (input: ComputeMigrationProjectMapWitnessInput) => string;
  readonly composeMaterial: (input: ComposeBackendPublicationMaterialInput) => ComposeBackendPublicationMaterialResult;
  readonly publishArtifact: typeof publishActivationArtifact;
  readonly readArtifact: typeof readActivationArtifact;
  readonly recordLink: (
    input: Readonly<{
      homeDir: string; generationId: string; publicationId: string; identityDigest: string;
      epochManifestRevision: number; epochManifestChecksumSha256: string;
    }>,
  ) => ActivationGenerationLinkRecordResult;
  readonly readLink: (input: Readonly<{ homeDir: string; generationId: string }>) => ActivationGenerationLinkReadResult;
  readonly evidence: MigrationActivationEvidenceSeam;
  readonly bindings: MigrationActivationBindingSeam;
  readonly createCoordinator: (
    input: Readonly<{ homeDir: string; guard: ActivationLeasePublicationGuard; machineId: string }>,
  ) => MigrationActivationCoordinator;
  readonly drive: typeof driveActivationPublication;
  readonly readMaintenanceJournal: (homeDir: string) => BackendMaintenanceJournal | null;
  readonly readPublicationJournal: (homeDir: string) => BackendPublicationJournal | null;
  /** The live selection: sha256 of the config bytes and the canonical project map digest (the journal's witness convention). */
  readonly readSelectionDigests: (homeDir: string) => MigrationActivationSelectionDigests;
  readonly persistReport: typeof persistMigrationActivationReport;
  readonly readReport: typeof readMigrationActivationReport;
  readonly machineId: (homeDir: string) => string;
  readonly daemonPort: (homeDir: string) => number;
  readonly checkRestart: typeof checkActivationRestartAdmission;
  readonly leaseTtlMs: number;
  /** Deadline for releaseAbandonedLease's own signal; finite, never the caller's. */
  readonly leaseCleanupTimeoutMs: number;
  readonly crashPoint?: MigrationActivationCrashPoint;
}

/**
 * Production dependencies for one home. Every boundary is built here and
 * nowhere else; the CLI never touches a coordinator, guard or runtime. The
 * #626 evidence store, binding resolver and census builders are wired here
 * and only here. Dependencies are a structural injection seam for tests.
 */
export function createMigrationActivationDependencies(
  input: Readonly<{ homeDir: string }>,
): MigrationActivationDependencies {
  const verificationStore = new MigrationVerificationReportStore({ homeDir: input.homeDir });
  return {
    manifestStore: new MigrationManifestStore({ homeDir: input.homeDir }),
    readManifestRevision: readMigrationManifestRevision,
    readVerificationReport: (generationId, reportSha256) => verificationStore.read(generationId, reportSha256),
    createOrdinaryRuntime: (settings) => new PostgreSqlRuntime(settings),
    createTransferRuntime: (settings) => new PostgreSqlRuntime(settings) as unknown as MigrationActivationTransferRuntime,
    readRoleIdentity: async (executor, signal) => {
      const result = await executor.query<{
        readonly current_user_name: string;
        readonly session_user_name: string;
        readonly role_oid: string;
        readonly tls: boolean;
      }>({
        text: `SELECT CURRENT_USER::pg_catalog.text AS current_user_name,
                      SESSION_USER::pg_catalog.text AS session_user_name,
                      role.oid::pg_catalog.text AS role_oid,
                      COALESCE((
                        SELECT ssl
                        FROM pg_catalog.pg_stat_ssl
                        WHERE pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
                      ), false) AS tls
               FROM pg_catalog.pg_roles AS role
               WHERE role.rolname OPERATOR(pg_catalog.=) CURRENT_USER`,
      }, {
        domain: "factory",
        operation: "readMigrationActivationRoleIdentity",
        ...(signal === undefined ? {} : { signal }),
      });
      const row = result.rows[0];
      return {
        currentUser: row?.current_user_name ?? "",
        sessionUser: row?.session_user_name ?? "",
        oid: row?.role_oid ?? "",
        tls: row?.tls ?? false,
      };
    },
    verifyRuntimeSchema: (executor, options) => verifyPostgreSqlRuntimeSchema(executor, options),
    verifyTransferSchema: (executor, options) => verifyPostgreSqlTransferSchema(executor, options),
    checkTargetHealth: checkMigrationTargetHealth,
    readCopyBinding: readMigrationCopyBindingSha256,
    captureDestinationIdentity,
    readDestinationCensus: (session, census) => readFencedDestinationCensus(session as unknown as PostgreSqlSnapshotSession, census),
    census: { buildMigrationCensusVector, buildMigrationCanonicalDelta },
    withAppendBarrier: withBackendPublicationAppendBarrierAsync,
    checkQuiescence: checkActivationWriterQuiescence,
    checkCoverage: checkActivationProjectCoverage,
    enumerateStoredData: enumerateStoredDataProjectHashes,
    computeProjectMapWitness: (witness) => computeMigrationProjectMapWitnessSha256(witness),
    composeMaterial: composeBackendPublicationMaterial,
    publishArtifact: publishActivationArtifact,
    readArtifact: readActivationArtifact,
    recordLink: (link) => recordActivationGenerationLink(link),
    readLink: (link) => readActivationGenerationLink(link),
    evidence: {
      recordMigrationActivationEpoch,
      recordMigrationActivationAttempt,
      recordMigrationActivationWitness,
      readMigrationActivationEvidence,
    },
    bindings: {
      recordMigrationWitnessBinding,
      recordMigrationSelectionBinding,
      resolveMigrationWitnessBindings,
    },
    createCoordinator: ({ homeDir, guard, machineId }) => createBackendPublicationCoordinator({
      homeDir,
      remoteGuard: {
        mode: "delegated",
        provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId, ttlMs: MIGRATION_ACTIVATION_LEASE_TTL_MS }),
      },
    }),
    drive: driveActivationPublication,
    readMaintenanceJournal: (homeDir) => readBackendMaintenanceJournal(homeDir),
    readPublicationJournal: (homeDir) => readBackendPublicationJournal(homeDir),
    readSelectionDigests: (homeDir) => ({
      configSha256: backendPublicationConfigSha256(homeDir),
      projectMapSha256: backendPublicationProjectMapSha256(homeDir),
    }),
    persistReport: persistMigrationActivationReport,
    readReport: readMigrationActivationReport,
    machineId: (homeDir) => requireMachineIdentity(homeDir).machineId,
    allocateScratch: (home) => mkdtempSync(join(lcmHomeDir(home), "activation-scratch-")),
    daemonPort: storedDaemonPort,
    checkRestart: checkActivationRestartAdmission,
    leaseTtlMs: MIGRATION_ACTIVATION_LEASE_TTL_MS,
    leaseCleanupTimeoutMs: MIGRATION_ACTIVATION_LEASE_CLEANUP_TIMEOUT_MS,
  };
}

/**
 * The daemon's configured port from the validated stored config, without
 * applying defaults from the environment and without resolving storage
 * secrets: after the publication selects postgresql, the full daemon config
 * would demand LCM_POSTGRES_URL and LCM_POSTGRES_CA_FILE, which the
 * activation process does not carry (it receives its connection settings as
 * arguments). An absent config or daemon section means the default port.
 */
function storedDaemonPort(homeDir: string): number {
  const stored = parseStoredConfig(readDaemonConfigRawSnapshot(configPath(homeDir)).content);
  const daemon = stored.daemon as Readonly<{ port?: number }> | undefined;
  return daemon?.port ?? DEFAULT_DAEMON_PORT;
}


// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

type Exit = Readonly<{ exit: MigrationActivationOutcome }>;
type Step<T> = Readonly<{ exit?: undefined; value: T }> | Exit;

function ok<T>(value: T): Step<T> {
  return { value };
}

function isExit<T>(step: Step<T>): step is Exit {
  return step.exit !== undefined;
}

function refusal(
  step: MigrationActivationRefusalStep,
  reason: MigrationActivationRefusalReason,
  detail: string,
): Exit {
  return { exit: { status: "refused", step, reason, detail, effectBegun: false } };
}

/** Refusal reasons with a closed interruption cause of their own (A7); the rest are state-unresolvable. */
const ROLL_FORWARD_CAUSES: Partial<Record<MigrationActivationRefusalReason, MigrationActivationInterruptionCause>> = {
  "lease-conflict": "lease-lost",
  "lease-unresolvable": "lease-unresolvable",
  "project-map-drift": "project-map-drift",
};

/** The step the earlier run was in when it stopped, from the manifest step C
 * read: prepare-activation pending (S9), activating with no pending effect
 * (between S9 and S10) or publish-activation pending (S11). */
function inFlightStep(ctx: Context): MigrationActivationInterruptionStep {
  const pending = ctx.manifest.pendingEffect;
  if (pending === null) return "S10";
  return pending.kind === "prepare-activation" ? "S9" : "S11";
}

/**
 * A refusal names a precondition this activation failed before any effect
 * of its own, so the refused outcome has effectBegun false by contract
 * (plan-v7.1 interface). When the same S0-S8 re-check fails on a re-entry
 * whose effect already began (step C: manifest activating or a pending
 * activation effect), the run is an interrupted roll-forward instead: the
 * step in flight when the earlier run stopped, the nearest closed cause,
 * and the refusal step and reason kept in the detail. The lease is then
 * kept for the next call (see releaseAbandonedLease).
 */
function refused(
  ctx: Context,
  step: MigrationActivationRefusalStep,
  reason: MigrationActivationRefusalReason,
  detail: string,
): Exit {
  if (!ctx.effectBegun) return refusal(step, reason, detail);
  return interrupted(ctx, inFlightStep(ctx), ROLL_FORWARD_CAUSES[reason] ?? "state-unresolvable", step + " " + reason + " on roll-forward: " + detail);
}

const PREPARE_EFFECT_PREFIX = "prepare-activation-";
const PUBLISH_EFFECT_PREFIX = "publish-activation-";
const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROJECT_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_MANIFEST_REVISION_BYTES = 1024 * 1024;
/** prepare-activation (begin, complete) and publish-activation (begin): the
 * most hops between the verified manifest and any activating head. */
const MAX_LINEAGE_HOPS = 3;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Frozen from the VERIFIED manifest (amendment 1 / S-2); carried by the link. */
type EpochManifestPair = Readonly<{ epochManifestRevision: number; epochManifestChecksumSha256: string }>;

type ProjectBinding = Readonly<{ localProjectId: string; remoteProjectId: string; evidenceSha256: string }>;

type Context = {
  readonly input: MigrationActivationInput;
  readonly deps: MigrationActivationDependencies;
  readonly homeDir: string;
  readonly generationId: string;
  readonly publicationId: string;
  readonly localProjectId: string;
  readonly remoteProjectId: string;
  readonly now: () => Date;
  /** Null until resolveMachineId runs, immediately before openOrdinary; every
   * consumer (openOrdinary, S2 and the lease helpers) runs after it. */
  machineId: string | null;
  token: BackendPublicationLockToken;
  manifest: MigrationManifest;
  report: MigrationVerificationReport;
  verificationRef: MigrationReportReference;
  effectBegun: boolean;
  resumedFrom: MigrationActivationResumePoint;
  ordinary: MigrationActivationOrdinaryRuntime | null;
  ordinaryRole: Readonly<{ role: string; oid: string }> | null;
  transferRole: Readonly<{ role: string; oid: string }> | null;
  guard: ActivationLeasePublicationGuard | null;
  coordinator: MigrationActivationCoordinator | null;
  evidenceSha256: string | null;
  fence: ActivationLeaseFence | null;
  successorFencingToken: string | null;
  quiescence: ActivationQuiescenceResult | null;
  pair: EpochManifestPair | null;
  material: ComposeBackendPublicationMaterialResult | null;
  identityDigest: string | null;
  artifact: ActivationArtifactRecoveryMaterial | null;
  link: ActivationGenerationLink | null;
  censusVector: MigrationCensusVector | null;
  canonicalDelta: MigrationCanonicalDelta | null;
  epoch: MigrationActivationEpoch | null;
  attempt: MigrationActivationAttempt | null;
  witness: MigrationActivationWitness | null;
  pendingStartedAt: string | null;
};

function crash(ctx: Context, point: string): void {
  ctx.deps.crashPoint?.(point);
}

function projectBinding(ctx: Context): ProjectBinding {
  return { localProjectId: ctx.localProjectId, remoteProjectId: ctx.remoteProjectId, evidenceSha256: ctx.evidenceSha256! };
}

// ---------------------------------------------------------------------------
// Evidence for interruptions (amendment 2) and identity
// ---------------------------------------------------------------------------

/** The own journal records the config as published: yes needs the live selection to match it. */
const APPLIED_YES_PHASES: readonly BackendPublicationJournal["phase"][] = ["config-published", "releasing", "released", "completed"];
/** The write may be in flight: never proven either way, even when the live selection equals the source. */
const APPLIED_IN_FLIGHT_PHASES: readonly BackendPublicationJournal["phase"][] = ["map-publishing", "map-published", "config-publishing"];

function digestsMatch(live: MigrationActivationSelectionDigests, configSha256: string, projectMapSha256: string): boolean {
  return live.configSha256 === configSha256 && live.projectMapSha256 === projectMapSha256;
}

/** The digest of a recovery file under the journal convention: raw bytes for the config, canonical JSON for the map, {} when absent. */
function recoveryFileDigests(config: BackendPublicationRecoveryFile, projectMap: BackendPublicationRecoveryFile): MigrationActivationSelectionDigests {
  return {
    configSha256: createHash("sha256").update(config.presence === "present" ? config.content : "{}").digest("hex"),
    projectMapSha256: backendPublicationCanonicalSha256(
      projectMap.presence === "present" ? JSON.parse(Buffer.from(projectMap.content).toString("utf8")) : {},
    ),
  };
}

/** "no" only when the live selection still equals this activation's pre-publication source witness; otherwise "unknown". */
function classifyAgainstSource(ctx: Context): MigrationActivationTriState {
  // The witness enters the context at compose or at the stored artifact load;
  // an interruption before either has no source proof.
  const source = ctx.material?.material.source ?? ctx.artifact?.source;
  if (source === undefined) return "unknown";
  const witness = recoveryFileDigests(source.config, source.projectMap);
  return digestsMatch(ctx.deps.readSelectionDigests(ctx.homeDir), witness.configSha256, witness.projectMapSha256) ? "no" : "unknown";
}

/**
 * applied is evidence-derived (amendment 2): the journal phase says what was
 * attempted, and an independent readback of the live config and project map
 * must agree before it is reported. yes needs the published witnesses; no
 * needs the pre-publication witnesses (the journal's expected digests, or the
 * source material when the journal is absent, foreign or v3). Everything else,
 * including any readback failure, is unknown. Never throws.
 */
function classifyApplied(ctx: Context): MigrationActivationTriState {
  try {
    // A live version-3 maintenance journal entered from sqlite means no
    // version-2 publication has been prepared for this generation. A window
    // entered from another backend is a rollback (#626) that superseded
    // whatever this activation published.
    const maintenance = ctx.deps.readMaintenanceJournal(ctx.homeDir);
    if (maintenance !== null) return isActivationMaintenance(maintenance) ? classifyAgainstSource(ctx) : "unknown";
    const journal = ctx.deps.readPublicationJournal(ctx.homeDir);
    if (journal === null || journal.publicationId !== ctx.publicationId) return classifyAgainstSource(ctx);
    if (APPLIED_IN_FLIGHT_PHASES.includes(journal.phase)) return "unknown";
    const live = ctx.deps.readSelectionDigests(ctx.homeDir);
    if (APPLIED_YES_PHASES.includes(journal.phase)) {
      const { publishedConfigSha256, publishedProjectMapSha256 } = journal;
      return publishedConfigSha256 !== null && publishedProjectMapSha256 !== null && digestsMatch(live, publishedConfigSha256, publishedProjectMapSha256) ? "yes" : "unknown";
    }
    // preparing through guarded and the abort family: no configuration or map
    // mutation is recorded before map-publishing, but the phase alone is not
    // proof, and a restore may be incomplete.
    return digestsMatch(live, journal.expectedConfigSha256, journal.expectedProjectMapSha256) ? "no" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * reportStored before the report identity is known: the per-generation
 * report directory positively absent is "no"; a directory that exists (some
 * report may be there) or an unreadable read is "unknown".
 */
function classifyReportStored(ctx: Context, reportSha256: string | null): MigrationActivationTriState {
  let read: MigrationActivationReportReadResult;
  try {
    read = ctx.deps.readReport({ homeDir: ctx.homeDir, generationId: ctx.generationId, reportSha256: reportSha256 ?? "0".repeat(64) });
  } catch {
    return "unknown";
  }
  if (read.state === "resolved") return "yes";
  if (read.state === "unresolvable") return "unknown";
  if (reportSha256 !== null) return "no";
  return read.detail.includes("directory") || read.detail.includes("private LCM root") ? "no" : "unknown";
}

/** The publicationId is deterministic and the manifest was read by step C,
 * so both are evidenced wherever an interruption can be reported. */
function identityOf(ctx: Context): MigrationActivationIdentity {
  return Object.freeze({ generationId: ctx.generationId, publicationId: ctx.publicationId, manifestRevision: ctx.manifest.revision });
}

function interrupted(
  ctx: Context,
  step: MigrationActivationInterruptionStep,
  cause: MigrationActivationInterruptionCause,
  detail: string,
  reportSha256: string | null = null,
): Exit {
  return {
    exit: {
      status: "interrupted",
      step,
      cause,
      detail,
      effectBegun: ctx.effectBegun,
      applied: classifyApplied(ctx),
      reportStored: classifyReportStored(ctx, reportSha256),
      identity: identityOf(ctx),
    },
  };
}

// ---------------------------------------------------------------------------
// Step C helpers: manifest, lineage, report
// ---------------------------------------------------------------------------

function isArtifactReadRefusal(error: unknown): error is Error {
  return error instanceof ActivationArtifactPresenceUnresolvableError
    || error instanceof ActivationArtifactIdentityMismatchError
    || error instanceof ActivationArtifactValidationError;
}

function isManifestAbsent(error: unknown): boolean {
  return error instanceof MigrationProtocolError && error.reason === "unexpected-state" && /head is absent/u.test(error.message);
}

function manifestAbsentRefusal(generationId: string): Exit {
  return refusal("S0", "manifest-absent", "no migration manifest exists for generation " + generationId);
}

function readManifest(ctx: Context): Step<MigrationManifest> {
  try {
    return ok(ctx.deps.manifestStore.read(ctx.generationId));
  } catch (error) {
    if (isManifestAbsent(error)) {
      return manifestAbsentRefusal(ctx.generationId);
    }
    if (error instanceof MigrationProtocolError) {
      return refused(ctx, "S0", "manifest-unresolvable", "the migration manifest could not be read: " + error.message);
    }
    throw error;
  }
}

/**
 * Walk the immutable revision files back from an activating head to the
 * VERIFIED manifest it descends from, authenticating each hop by the
 * successor's previousManifestSha256 (the revision path is keyed by that
 * checksum). Needed only when a crash between S9 and the link write lost
 * the in-memory S4b tuple; once the link exists its pair is authoritative.
 * A fresh call returns its verified head at hop 0, so every failure below
 * is on re-entry (an S9 or S10 effect has begun) and is an interruption.
 */
function readVerifiedLineage(ctx: Context, head: MigrationManifest): Step<MigrationManifest> {
  let current = head;
  for (let hop = 0; hop <= MAX_LINEAGE_HOPS; hop += 1) {
    if (current.phase === "verified" && current.pendingEffect === null) return ok(current);
    // A null predecessor is revision 0 (protocol.ts rejects one without the
    // other), which no activation chain reaches before its verified manifest.
    if (current.previousManifestSha256 === null || hop === MAX_LINEAGE_HOPS) break;
    let previous: MigrationManifest;
    try {
      previous = ctx.deps.readManifestRevision({
        homeDir: ctx.homeDir, generationId: ctx.generationId, revision: current.revision - 1, checksumSha256: current.previousManifestSha256,
      });
    } catch (error) {
      return interrupted(ctx, "S9", "state-unresolvable", "the verified manifest lineage could not be read: " + (error as Error).message);
    }
    if (previous.checksumSha256 !== current.previousManifestSha256 || previous.generationId !== ctx.generationId) {
      return interrupted(ctx, "S9", "state-unresolvable", "manifest revision " + (current.revision - 1) + " does not authenticate against its successor");
    }
    current = previous;
  }
  return interrupted(
    ctx,
    "S9",
    "state-unresolvable",
    "no verified manifest is reachable from revision " + head.revision + " within " + MAX_LINEAGE_HOPS + " hops",
  );
}

/** Default revision reader: the immutable per-revision file, bounded, private mode, parsed strictly. */
export function readMigrationManifestRevision(
  input: Readonly<{ homeDir: string; generationId: string; revision: number; checksumSha256: string }>,
): MigrationManifest {
  const path = migrationManifestRevisionPath(
    { generationId: input.generationId, revision: input.revision, checksumSha256: input.checksumSha256 },
    input.homeDir,
  );
  const file = readBoundedRegularFileWithStat(path, {
    allowedRoot: migrationManifestGenerationDirectory(input.generationId, input.homeDir),
    maxBytes: MAX_MANIFEST_REVISION_BYTES,
    allowedModes: [PRIVATE_FILE_MODE],
  });
  return parseMigrationManifest(JSON.parse(file.content.replace(/\n$/u, "")));
}

/**
 * The newest report reference of one kind. Callers use it only where
 * protocol.ts's cross-field invariants guarantee presence: an
 * activation-eligible manifest carries a verification report, and an active
 * manifest carries the activation report its completion required
 * (parseMigrationManifest refuses either shape without it), so the lookup
 * cannot come back empty for a parsed manifest.
 */
function latestReport(manifest: MigrationManifest, kind: MigrationReportReference["kind"]): MigrationReportReference {
  const matching = manifest.reports.filter((report) => report.kind === kind);
  return matching[matching.length - 1]!;
}

function readVerification(ctx: Context): Step<{ ref: MigrationReportReference; report: MigrationVerificationReport }> {
  const ref = latestReport(ctx.manifest, "verification");
  let report: MigrationVerificationReport;
  try {
    report = ctx.deps.readVerificationReport(ctx.generationId, ref.reportSha256);
  } catch (error) {
    if (error instanceof MigrationVerificationStoreError) {
      return refused(ctx, "S5", "verification-unresolvable", "the verification report could not be read: " + error.message);
    }
    throw error;
  }
  if (report.reportId !== ref.reportId || report.reportSha256 !== ref.reportSha256) {
    return refused(ctx, "S5", "verification-stale", "the stored verification report does not match the manifest's reference");
  }
  if (!report.activationEligible) {
    return refused(ctx, "S5", "verification-stale", "the verification report is not activation-eligible");
  }
  return ok({ ref, report });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function epochFor(ctx: Context, pair: EpochManifestPair): MigrationActivationEpoch {
  const body = ctx.report.body;
  return createMigrationActivationEpoch({
    generationId: ctx.generationId,
    manifestRevision: pair.epochManifestRevision,
    manifestChecksumSha256: pair.epochManifestChecksumSha256,
    verificationReportId: ctx.report.reportId,
    verificationReportSha256: ctx.report.reportSha256,
    projectMapWitnessSha256: body.projectMapWitnessSha256,
    // A4: the digest over the parsed report value, never a carried string.
    queueClassificationWitnessSha256: migrationWitnessSha256(body.queueClassificationWitness),
    destinationIdentity: body.destinationIdentity,
    censusVector: body.censusVector,
    schemaWitness: body.destinationSchemaWitness,
  });
}

function selectionAuthorityFor(ctx: Context, fence: ActivationLeaseFence): MigrationSelectionAuthority {
  // R2: resource coordinates are the guard's constants; the token is the
  // row token in decimal; ownerProcessId is the publicationId (row owner).
  return {
    version: 1,
    resourceType: POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
    resourceKey: POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
    fencingToken: fence.fencingToken.toString(10),
    ownerProcessId: ctx.publicationId,
  };
}

function attemptFor(ctx: Context): MigrationActivationAttempt {
  const envelope = ctx.quiescence!.quiescenceFence!;
  return createMigrationActivationAttempt({
    epochId: ctx.epoch!.epochId,
    selectionAuthority: selectionAuthorityFor(ctx, ctx.fence!),
    canonicalDeltaBaseline: ctx.canonicalDelta!,
    activationRecomputedCensus: ctx.censusVector!,
    intraActivationWatermark: null,
    quiescenceFence: createMigrationQuiescenceFence({ kind: envelope.kind, payload: envelope.payload }),
  });
}

function openOrdinary(ctx: Context): void {
  ctx.ordinary = ctx.deps.createOrdinaryRuntime(ctx.input.ordinarySettings);
  ctx.guard = ctx.ordinary.backendPublicationGuard();
  ctx.coordinator = ctx.deps.createCoordinator({ homeDir: ctx.homeDir, guard: ctx.guard, machineId: ctx.machineId! });
}

/**
 * The registered machine identity, read only once the run needs it (an
 * uninitialized home must still reach the S0 classification). An identity
 * the file cannot supply (unregistered, pending, malformed) or a filesystem
 * error from reading it is unresolvable state; anything else rethrows.
 */
function resolveMachineId(ctx: Context): Exit | null {
  try {
    ctx.machineId = ctx.deps.machineId(ctx.homeDir);
    return null;
  } catch (error) {
    if (error instanceof MachineIdentityFileError || (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string")) {
      return refused(ctx, "S0", "state-unresolvable", "the machine identity could not be resolved: " + error.message);
    }
    throw error;
  }
}

/** S0 (A5): evidenceSha256 from the completed transfer run, on its own
 * transfer session, opened and closed here, before S2 (amendment 4). */
async function stepCopyBinding(ctx: Context): Promise<Step<string>> {
  const transfer = ctx.deps.createTransferRuntime(ctx.input.transferSettings);
  try {
    const read: MigrationCopyBindingReadResult = await ctx.deps.readCopyBinding({
      executor: transfer, projectId: ctx.remoteProjectId, generationId: ctx.generationId, signal: ctx.input.signal,
    });
    if (read.state === "unresolvable") {
      return refused(ctx, "S0", "verification-unresolvable", "the copy binding digest could not be read back (" + read.reason + "): " + read.detail);
    }
    const identity = await identityCheck(ctx, transfer, "S0");
    if (isExit(identity)) return identity;
    return ok(read.evidenceSha256);
  } finally {
    await transfer.close();
  }
}

/** The live destination identity on one session: drift refuses at `step`; a
 * target failure refuses at `failureStep` (the ordinary runtime probe
 * attributes its failures to S6, the health step, while its drift is S5). */
async function identityCheck(
  ctx: Context,
  executor: PostgreSqlQueryExecutor,
  step: MigrationActivationRefusalStep,
  failureStep: MigrationActivationRefusalStep = step,
): Promise<Step<MigrationDestinationIdentity>> {
  let live: MigrationDestinationIdentity;
  try {
    live = await ctx.deps.captureDestinationIdentity(executor, ctx.remoteProjectId, ctx.input.signal);
    assertDestinationIdentityMatches(
      live,
      {
        expectedDestinationIdentitySha256: ctx.manifest.destination.identitySha256,
        expectedSystemIdentifier: ctx.report.body.destinationIdentity.systemIdentifier,
      },
      ctx.manifest.destination.identitySha256,
      ctx.manifest.destination.systemIdentifier,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "MigrationVerificationDriverError") {
      return refused(ctx, step, "identity-drift", "the live destination identity does not match the sealed manifest: " + error.message);
    }
    return targetFailure(ctx, error, failureStep, failureStep + " destination identity query");
  }
  if (live.sealedWitnessSha256 !== ctx.report.body.destinationIdentity.sealedWitnessSha256) {
    return refused(ctx, step, "identity-drift", "the live destination identity does not match the verification report");
  }
  return ok(live);
}

function validRoleIdentityRead(value: MigrationActivationRoleIdentityRead): boolean {
  return typeof value.currentUser === "string"
    && Buffer.byteLength(value.currentUser, "utf8") > 0
    && Buffer.byteLength(value.currentUser, "utf8") <= 63
    && typeof value.sessionUser === "string"
    && value.currentUser === value.sessionUser
    && typeof value.oid === "string"
    && /^[0-9]+$/u.test(value.oid)
    && value.tls === true;
}

async function discoverActivationRoles(ctx: Context): Promise<Step<true>> {
  const transfer = ctx.deps.createTransferRuntime(ctx.input.transferSettings);
  try {
    let ordinary: MigrationActivationRoleIdentityRead;
    let transferIdentity: MigrationActivationRoleIdentityRead;
    try {
      ordinary = await ctx.deps.readRoleIdentity(ctx.ordinary!, ctx.input.signal);
      transferIdentity = await ctx.deps.readRoleIdentity(transfer, ctx.input.signal);
    } catch (error) {
      if (error instanceof StorageOperationError) {
        const attributed = classifyMigrationTargetFailure(error, "activation role discovery");
        return refused(
          ctx,
          "S6",
          attributed.status === "unhealthy" ? "target-unhealthy" : "target-unresolvable",
          attributed.reason + ": activation role discovery failed",
        );
      }
      return refused(ctx, "S6", "target-unresolvable", "connection-failed: activation role discovery failed");
    }
    if (
      !validRoleIdentityRead(ordinary)
      || !validRoleIdentityRead(transferIdentity)
      || ordinary.oid === transferIdentity.oid
      || ordinary.currentUser === transferIdentity.currentUser
    ) {
      return refused(
        ctx,
        "S6",
        "target-unhealthy",
        "schema-mismatch: activation requires distinct unswitched runtime and transfer role sessions",
      );
    }
    ctx.ordinaryRole = { role: ordinary.currentUser, oid: ordinary.oid };
    ctx.transferRole = { role: transferIdentity.currentUser, oid: transferIdentity.oid };
    return ok(true);
  } finally {
    await transfer.close();
  }
}

async function prepareActivationSessions(ctx: Context): Promise<Step<true>> {
  const identity = await identityCheck(ctx, ctx.ordinary!, "S5", "S6");
  if (isExit(identity)) return identity;
  return discoverActivationRoles(ctx);
}

/** S2 fresh acquire (pre-selection). An expired same-generation row is taken over. */
async function stepLeaseAcquire(ctx: Context): Promise<Step<ActivationLeaseFence>> {
  const base = {
    projectId: ctx.remoteProjectId,
    machineId: ctx.machineId!,
    publicationId: ctx.publicationId,
    targetBackend: "postgresql" as const,
    evidenceSha256: ctx.evidenceSha256!,
    ttlMs: ctx.deps.leaseTtlMs,
    signal: ctx.input.signal,
  };
  const acquired: ActivationLeaseAcquireResult = await acquireActivationLease(ctx.guard!, base);
  if (acquired.status === "acquired") return ok(acquired.fence);
  if (acquired.status === "conflict") return refused(ctx, "S2", "lease-conflict", acquired.detail);
  if (acquired.status === "unresolvable") return refused(ctx, "S2", "lease-unresolvable", acquired.detail);
  let current: ActivationLeaseFence | null;
  try {
    current = await ctx.guard!.read({ projectId: ctx.remoteProjectId, targetBackend: "postgresql", evidenceSha256: ctx.evidenceSha256!, signal: ctx.input.signal });
  } catch (error) {
    // A decodable row naming another generation is a routine conflict; an undecodable row is data damage.
    if (error instanceof PostgreSqlBackendPublicationGuardError && error.reason === "fence-mismatch") {
      return refused(ctx, "S2", "lease-conflict", "the expired lease row was taken by a different publication generation before takeover");
    }
    if (error instanceof PostgreSqlBackendPublicationGuardError && error.reason === "invalid-row") {
      return refused(ctx, "S2", "lease-unresolvable", "the expired lease row is corrupt or ambiguous and cannot be attributed to any publication generation");
    }
    throw error;
  }
  if (current === null) return refused(ctx, "S2", "lease-unresolvable", "the expired lease row vanished before takeover");
  const took: ActivationLeaseTakeoverResult = await takeoverActivationLease(ctx.guard!, { ...base, expectedFencingToken: current.fencingToken });
  if (took.status === "took-over") return ok(took.fence);
  if (took.status === "conflict") return refused(ctx, "S2", "lease-conflict", took.detail);
  return refused(ctx, "S2", "lease-unresolvable", took.detail);
}

type LeaseContinuation =
  | Readonly<{ kind: "renewed"; fence: ActivationLeaseFence }>
  | Readonly<{ kind: "took-over"; fence: ActivationLeaseFence }>
  | Readonly<{ kind: "lost"; detail: string }>
  | Readonly<{ kind: "unresolvable"; detail: string }>;

/**
 * A2 continuation: renew; stale-token -> a second renew with the returned
 * token; expired -> CAS takeover (same generation, same machine, token may
 * advance). released / not-found / conflict are lost.
 */
async function continueLease(ctx: Context): Promise<LeaseContinuation> {
  const mutation = {
    projectId: ctx.remoteProjectId,
    machineId: ctx.machineId!,
    publicationId: ctx.publicationId,
    targetBackend: "postgresql" as const,
    evidenceSha256: ctx.evidenceSha256!,
    signal: ctx.input.signal,
  };
  let renewed: ActivationLeaseRenewResult = await renewActivationLease(ctx.guard!, { ...mutation, fencingToken: ctx.fence!.fencingToken, ttlMs: ctx.deps.leaseTtlMs });
  if (renewed.status === "stale-token") {
    renewed = await renewActivationLease(ctx.guard!, { ...mutation, fencingToken: renewed.fence.fencingToken, ttlMs: ctx.deps.leaseTtlMs });
  }
  if (renewed.status === "renewed") return { kind: "renewed", fence: renewed.fence };
  if (renewed.status === "expired") {
    const took = await takeoverActivationLease(ctx.guard!, { ...mutation, ttlMs: ctx.deps.leaseTtlMs, expectedFencingToken: renewed.fence.fencingToken });
    if (took.status === "took-over") return { kind: "took-over", fence: took.fence };
    if (took.status === "unresolvable") return { kind: "unresolvable", detail: took.detail };
    return { kind: "lost", detail: took.detail };
  }
  if (renewed.status === "unresolvable") return { kind: "unresolvable", detail: renewed.detail };
  return { kind: "lost", detail: renewed.detail };
}

type OwnFenceRead =
  | Readonly<{ kind: "own"; fence: ActivationLeaseFence }>
  | Readonly<{ kind: "absent"; detail: string }>
  | Readonly<{ kind: "foreign"; detail: string; corrupt: boolean }>
  | Readonly<{ kind: "unresolvable"; detail: string }>;

/** Re-read the lease row to continue from (re-entry): the row this
 * generation holds (released or not), positively no row, a row of another
 * publication or evidence digest (foreign: lease-lost except where
 * SUCCESSOR_ROW_PHASES admits it), or a read that cannot be attributed. */
async function readOwnFence(ctx: Context): Promise<OwnFenceRead> {
  const resolved = await resolveActivationLeaseFence(ctx.guard!, { projectId: ctx.remoteProjectId, targetBackend: "postgresql", evidenceSha256: ctx.evidenceSha256!, signal: ctx.input.signal });
  if (resolved.kind === "absent") return { kind: "absent", detail: "no fenced lease row exists for this generation" };
  if (resolved.kind === "identity-mismatch") return { kind: "foreign", detail: resolved.detail, corrupt: resolved.corrupt === true };
  if (resolved.kind === "unresolvable") return { kind: "unresolvable", detail: resolved.detail };
  if (resolved.fence.publicationId !== ctx.publicationId) return { kind: "foreign", detail: "the fenced lease row names another publication", corrupt: false };
  return { kind: "own", fence: resolved.fence };
}

/**
 * Version-2 journal phases the orchestrator drives without a live fence of
 * its own: the coordinator is releasing (or has released) the fences
 * itself, so the drive skips its fence precheck for them
 * (activation-publication.ts RELEASE_TAIL_PHASES / ABORT_FAMILY_PHASES,
 * plan-v7 A3) and the two terminal phases have released by design. An
 * absent own row is therefore not a lost lease here, and no lease
 * continuation runs before the drive.
 */
const NO_OWN_FENCE_PHASES: ReadonlySet<BackendPublicationJournal["phase"]> = new Set([
  "releasing", "released", "completed", "aborting", "config-restoring", "map-restoring", "abort-releasing", "aborted",
]);

/**
 * The subset of NO_OWN_FENCE_PHASES at which a row of another publication
 * is admitted as well (Bug #1651): this publication's row was released
 * before the journal reached released, so a successor publication (another
 * home) may legitimately have acquired the released row, and only local
 * authenticated finalization (released) or the terminal report (completed)
 * remains; neither the drive nor S16 renews, releases, acquires or takes
 * over that row.
 */
const SUCCESSOR_ROW_PHASES: ReadonlySet<BackendPublicationJournal["phase"]> = new Set(["released", "completed"]);

/**
 * The release window (Bug #1651): the remote release may already have
 * committed while the journal still reads releasing (or abort-releasing), so
 * a successor publication may hold the released row. A decodable foreign row
 * is admitted so the coordinator can finish its release tail, which is the
 * only proof that this publication's fence was released; the drive neither
 * renews, releases, acquires nor takes over that row. A corrupt or ambiguous
 * row is never admitted, and a coordinator whose guard cannot prove the
 * release still fails closed.
 */
const RELEASE_WINDOW_PHASES: ReadonlySet<BackendPublicationJournal["phase"]> = new Set(["releasing", "abort-releasing"]);

/**
 * Release the S2 lease of a run that ends before any durable effect (the
 * activation driver's own abort-before-handoff path, activation-lease.ts).
 * Expiry is not release: an expired own row is taken over first and the
 * fresh fence released (rollback-session.ts does the same). Returns null
 * when no live row of this generation remains (released, already released
 * or absent), otherwise the failure detail; never throws.
 *
 * The cleanup runs under its own bounded signal, never the caller's: a run
 * cancelled through input.signal reaches this path with that signal already
 * aborted, and the PostgreSQL runtime refuses an aborted signal before it
 * connects or queries, so inheriting it would cancel the cleanup itself and
 * leak the row (Bug #1641). The deadline is deps.leaseCleanupTimeoutMs.
 */
async function releaseAbandonedLease(ctx: Context): Promise<string | null> {
  const mutation = {
    projectId: ctx.remoteProjectId,
    machineId: ctx.machineId!,
    publicationId: ctx.publicationId,
    targetBackend: "postgresql" as const,
    evidenceSha256: ctx.evidenceSha256!,
    signal: AbortSignal.timeout(ctx.deps.leaseCleanupTimeoutMs),
  };
  try {
    let released: ActivationLeaseReleaseResult = await releaseActivationLease(ctx.guard!, { ...mutation, fencingToken: ctx.fence!.fencingToken });
    if (released.status === "expired") {
      const took = await takeoverActivationLease(ctx.guard!, { ...mutation, ttlMs: ctx.deps.leaseTtlMs, expectedFencingToken: released.fence.fencingToken });
      if (took.status !== "took-over") return took.detail;
      released = await releaseActivationLease(ctx.guard!, { ...mutation, fencingToken: took.fence.fencingToken });
    }
    if (released.status === "released" || released.status === "already-released" || released.status === "not-found") return null;
    return released.detail;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Authenticated manifest readback under the retained barrier, deciding
 * pre-effect lease cleanup where ctx.effectBegun cannot: that flag flips
 * only after an S9 update returns, so a begin that committed and then threw
 * leaves it false, and a begin that failed before writing returns an S9
 * interruption with effectBegun false. True only when the head is still the
 * verified manifest with no pending effect (nothing of ours was written);
 * an effect, another phase or a failed readback keeps the lease.
 */
function headPositivelyUnbegun(ctx: Context): boolean {
  try {
    const head = ctx.deps.manifestStore.read(ctx.generationId);
    return head.phase === "verified" && head.pendingEffect === null;
  } catch {
    return false;
  }
}

/** A refusal after S2 releases the lease, and so does an S9 interruption
 * whose begin positively did not write (headPositivelyUnbegun); a failure
 * to release rides the outcome's detail. */
async function withPreEffectLeaseReleased(ctx: Context, outcome: MigrationActivationOutcome): Promise<MigrationActivationOutcome> {
  if (ctx.fence === null) return outcome;
  const unbegunInterruption = outcome.status === "interrupted" && outcome.step === "S9" && !outcome.effectBegun && headPositivelyUnbegun(ctx);
  if (outcome.status !== "refused" && !unbegunInterruption) return outcome;
  const failure = await releaseAbandonedLease(ctx);
  if (failure === null) return outcome;
  return { ...outcome, detail: outcome.detail + "; the activation lease was not released: " + failure };
}

async function stepQuiescence(ctx: Context): Promise<Step<ActivationQuiescenceResult>> {
  const result = await ctx.deps.checkQuiescence({ homeDir: ctx.homeDir, lockToken: ctx.token }, { now: ctx.now });
  if (result.status === "satisfied") return ok(result);
  if (result.reason === "maintenance-journal-absent" || result.reason === "maintenance-not-held") {
    return refused(ctx, "S3", "maintenance-not-held", result.detail);
  }
  if (result.reason === "maintenance-journal-unresolvable") return refused(ctx, "S3", "maintenance-unresolvable", result.detail);
  return refused(ctx, "S3", result.status === "unsatisfied" ? "quiescence-unsatisfied" : "quiescence-unresolvable", result.detail);
}

function stepCoverage(ctx: Context): Step<ActivationCoverageResult> {
  const coverage = ctx.deps.checkCoverage({ homeDir: ctx.homeDir, publicationLockToken: ctx.token });
  if (coverage.status === "unsatisfied") return refused(ctx, "S4", "coverage-unsatisfied", coverage.detail);
  if (coverage.status === "unresolvable") return refused(ctx, "S4", "coverage-unresolvable", coverage.detail);
  const inventory: StoredDataProjectEnumeration = ctx.deps.enumerateStoredData({ homeDir: ctx.homeDir, publicationLockToken: ctx.token });
  if (inventory.status === "unresolvable") return refused(ctx, "S4", "coverage-unresolvable", inventory.detail);
  const verdict = evaluateActivationSingleProjectCoverage({ storedDataProjectHashes: inventory.projectHashes, localProjectId: ctx.localProjectId });
  if (verdict.status === "unsatisfied") return refused(ctx, "S4", "uncovered-projects", verdict.detail);
  return ok(coverage);
}

/** S4b: compose material and compute the identity digest, in memory. */
function stepCompose(ctx: Context): { material: ComposeBackendPublicationMaterialResult; identityDigest: string } {
  const material = ctx.deps.composeMaterial({ homeDir: ctx.homeDir, targetBackend: "postgresql", bindings: [projectBinding(ctx)] });
  const identityDigest = computeActivationArtifactIdentityDigest({
    source: material.material.source,
    target: material.material.target,
    projects: [projectBinding(ctx)],
  });
  return { material, identityDigest };
}

function projectMapWitness(ctx: Context, mode: "pre-publication" | "post-publication"): Step<string> {
  try {
    return ok(ctx.deps.computeProjectMapWitness({
      homeDir: ctx.homeDir,
      localProjectId: ctx.localProjectId,
      remoteProjectId: ctx.remoteProjectId,
      mode,
      publicationLockToken: ctx.token,
    }));
  } catch (error) {
    if (error instanceof MigrationProjectMapWitnessError) {
      if (mode === "pre-publication") {
        return refused(ctx, "S5", error.reason === "project-map-drift" ? "project-map-drift" : "state-unresolvable", error.message);
      }
      return interrupted(ctx, "S16", error.reason === "project-map-drift" ? "project-map-drift" : "state-unresolvable", error.message);
    }
    throw error;
  }
}

/** S6/S15: health runs on the daemon runtime role and admits only the live,
 * catalog-checked transfer role as its caller-scoped canonical peer. */
function observeHealth(ctx: Context): Promise<MigrationTargetHealthResult> {
  return ctx.deps.checkTargetHealth(
    { runtime: ctx.ordinary!, expectedOwner: ctx.input.expectedOwner, signal: ctx.input.signal },
    {
      verifyRuntimeSchema: (executor, options) => ctx.deps.verifyRuntimeSchema(executor, {
        ...options,
        admittedPeer: { role: ctx.transferRole!.role },
      }),
    },
  );
}

/** S6: refuse unless healthy. S15 observes without refusing (see finishAfterSelection). */
async function stepHealth(ctx: Context): Promise<Step<MigrationTargetHealthResult>> {
  const health = await observeHealth(ctx);
  if (health.status === "healthy") return ok(health);
  return refused(ctx, "S6", health.status === "unhealthy" ? "target-unhealthy" : "target-unresolvable", health.reason + ": " + health.detail);
}

/** A target failure observed at `step` (the S0, S5 and S7 destination
 * identity queries; the S7 transfer schema check, snapshot open and census
 * read): the StorageOperationError family, attributed exactly as S6
 * attributes the same failures, becomes the S6 refusal vocabulary
 * (target-unhealthy / target-unresolvable). The PostgreSQL portable source
 * normalizes a storage failure to PortableStreamError("source-unavailable")
 * carrying the storage error as its cause; that wrapper alone is unwrapped.
 * PortableStreamError "aborted" is a cancellation, not a target condition;
 * it and every other error are thrown. */
function targetFailure(ctx: Context, error: unknown, step: MigrationActivationRefusalStep, stage: string): Exit {
  const failure = error instanceof PortableStreamError && error.code === "source-unavailable" ? error.cause : error;
  if (!(failure instanceof StorageOperationError)) throw error;
  const attributed = classifyMigrationTargetFailure(failure, stage);
  return refused(ctx, step, attributed.status === "unhealthy" ? "target-unhealthy" : "target-unresolvable", attributed.reason + ": " + attributed.detail);
}

/** S7: a NEW transfer snapshot, after the transfer schema check (amendment 4).
 * Close failures still surface (plan-v7 S7); they are outside the attributed
 * stages. */
async function stepCensus(ctx: Context): Promise<Step<{ censusVector: MigrationCensusVector; canonicalDelta: MigrationCanonicalDelta }>> {
  const transfer = ctx.deps.createTransferRuntime(ctx.input.transferSettings);
  try {
    let session: MigrationActivationSnapshot;
    try {
      await ctx.deps.verifyTransferSchema(transfer, {
        expectedOwner: ctx.input.expectedOwner,
        signal: ctx.input.signal,
        admittedPeer: { role: ctx.ordinaryRole!.role },
      });
      session = await transfer.openReadOnlySnapshot({ projectId: ctx.input.expectedIdentity.id, signal: ctx.input.signal });
    } catch (error) {
      return targetFailure(ctx, error, "S7", "S7 transfer schema check and snapshot open");
    }
    try {
      const identity = await identityCheck(ctx, session, "S7");
      if (isExit(identity)) return identity;
      let scratchParent: string;
      try {
        scratchParent = ctx.deps.allocateScratch(ctx.homeDir);
      } catch (error) {
        return refused(ctx, "S7", "state-unresolvable", "the census scratch directory could not be allocated: " + (error as Error).message);
      }
      let read: Awaited<ReturnType<MigrationActivationDependencies["readDestinationCensus"]>>;
      try {
        read = await ctx.deps.readDestinationCensus(session, {
          settings: ctx.input.transferSettings,
          expectedOwner: ctx.input.expectedOwner,
          expectedIdentity: ctx.input.expectedIdentity,
          scratchParent,
          signal: ctx.input.signal,
        });
      } catch (error) {
        return targetFailure(ctx, error, "S7", "S7 census read");
      } finally {
        rmSync(scratchParent, { recursive: true, force: true });
      }
      return ok({
        censusVector: ctx.deps.census.buildMigrationCensusVector(read.census),
        canonicalDelta: ctx.deps.census.buildMigrationCanonicalDelta(read.census),
      });
    } finally {
      // Close failure surfaces (plan-v7 S7): never swallowed.
      await session.close();
    }
  } finally {
    await transfer.close();
  }
}

function stepEligibility(ctx: Context, recomputed: MigrationCensusVector): Step<true> {
  const body = ctx.report.body;
  if (!body.classCoverage.every((entry) => entry.ran)) {
    return refused(ctx, "S8", "class-coverage-incomplete", "a reconciliation class did not run in the verification report");
  }
  if (ctx.report.mismatchTotals.length !== 0) {
    return refused(ctx, "S8", "verification-mismatch", "the verification report records mismatches");
  }
  if (!migrationCensusVectorsEqual(recomputed, body.censusVector)) {
    return refused(ctx, "S8", "census-drift", "the recomputed destination census differs from the verification report's census");
  }
  return ok(true);
}

function effectIds(epochId: string): { prepare: string; publish: string; inputSha256: string } {
  return { prepare: PREPARE_EFFECT_PREFIX + epochId, publish: PUBLISH_EFFECT_PREFIX + epochId, inputSha256: sha256Hex(epochId) };
}

/** S9: prepare-activation begin + complete (retry-idempotent). */
function stepPrepareActivation(ctx: Context): Step<MigrationManifest> {
  const ids = effectIds(ctx.epoch!.epochId);
  let manifest = ctx.manifest;
  try {
    if (manifest.pendingEffect === null) {
      manifest = ctx.deps.manifestStore.update(ctx.generationId, manifest.checksumSha256, (current) =>
        beginMigrationEffect(current, { effectId: ids.prepare, kind: "prepare-activation", inputSha256: ids.inputSha256, startedAt: ctx.now().toISOString() }));
      ctx.effectBegun = true;
      crash(ctx, "after-prepare-begin");
    }
    if (manifest.pendingEffect?.kind !== "prepare-activation" || manifest.pendingEffect.effectId !== ids.prepare) {
      // A durable prepare-activation effect under another effectId: an
      // effect exists on this generation's manifest, so this is an
      // interruption that keeps the lease (as S10 reports its own mismatch),
      // never a refusal that would release the row under a pending effect.
      return interrupted(ctx, "S9", "state-unresolvable", "the pending effect is not this activation's prepare-activation");
    }
    manifest = ctx.deps.manifestStore.update(ctx.generationId, manifest.checksumSha256, (current) =>
      completeMigrationEffect(current, { effectId: ids.prepare, completedAt: ctx.now().toISOString() }));
    crash(ctx, "after-prepare-complete");
    return ok(manifest);
  } catch (error) {
    if (error instanceof MigrationProtocolError) {
      return interrupted(ctx, "S9", "state-unresolvable", "prepare-activation could not be driven: " + error.message);
    }
    throw error;
  }
}

/** S10: begin publish-activation; re-entry adopts a pending effect whose kind and deterministic id match. */
function stepBeginPublish(ctx: Context): Step<MigrationManifest> {
  const ids = effectIds(ctx.epoch!.epochId);
  let manifest = ctx.manifest;
  try {
    if (manifest.pendingEffect === null) {
      manifest = ctx.deps.manifestStore.update(ctx.generationId, manifest.checksumSha256, (current) =>
        beginMigrationEffect(current, { effectId: ids.publish, kind: "publish-activation", inputSha256: ids.inputSha256, startedAt: ctx.now().toISOString() }));
      crash(ctx, "after-publish-begin");
    }
  } catch (error) {
    if (error instanceof MigrationProtocolError) {
      return interrupted(ctx, "S10", "state-unresolvable", "publish-activation could not be begun: " + error.message);
    }
    throw error;
  }
  if (manifest.pendingEffect?.kind !== "publish-activation" || manifest.pendingEffect.effectId !== ids.publish) {
    return interrupted(ctx, "S10", "state-unresolvable", "the pending effect is not this activation's publish-activation");
  }
  ctx.effectBegun = true;
  ctx.pendingStartedAt = manifest.pendingEffect.startedAt;
  return ok(manifest);
}

/** S11: artifact -> link -> epoch -> attempt -> witness -> witness binding. */
function stepDurableEvidence(ctx: Context): Step<true> {
  const material = ctx.material!;
  try {
    if (ctx.artifact === null) {
      const published = ctx.deps.publishArtifact({
        homeDir: ctx.homeDir,
        material: {
          version: 1,
          publicationId: ctx.publicationId,
          source: material.material.source,
          target: material.material.target,
          projects: [projectBinding(ctx)],
        },
      });
      if (published.identityDigest !== ctx.identityDigest) {
        return interrupted(ctx, "S11", "artifact-identity-mismatch", "the published artifact's identity digest differs from the composed digest");
      }
      ctx.artifact = published.material;
      crash(ctx, "after-artifact");
    }
    if (ctx.link === null) {
      const recorded = ctx.deps.recordLink({
        homeDir: ctx.homeDir,
        generationId: ctx.generationId,
        publicationId: ctx.publicationId,
        identityDigest: ctx.identityDigest!,
        epochManifestRevision: ctx.pair!.epochManifestRevision,
        epochManifestChecksumSha256: ctx.pair!.epochManifestChecksumSha256,
      });
      ctx.link = recorded.link;
      crash(ctx, "after-link");
    }
  } catch (error) {
    if (error instanceof ActivationGenerationLinkConflictError) return interrupted(ctx, "S11", "link-conflict", error.message);
    if (error instanceof ActivationArtifactIdentityMismatchError) return interrupted(ctx, "S11", "artifact-identity-mismatch", error.message);
    if (error instanceof ActivationArtifactPresenceUnresolvableError) return interrupted(ctx, "S11", "artifact-unresolvable", error.message);
    throw error;
  }
  return recordEvidenceChain(ctx, "S11");
}

/** epoch -> attempt -> witness -> witness binding, in the mandatory order. Idempotent. */
function recordEvidenceChain(ctx: Context, step: MigrationActivationInterruptionStep): Step<true> {
  try {
    ctx.deps.evidence.recordMigrationActivationEpoch({ homeDir: ctx.homeDir, epoch: ctx.epoch! });
    crash(ctx, "after-epoch");
    ctx.deps.evidence.recordMigrationActivationAttempt({ homeDir: ctx.homeDir, generationId: ctx.generationId, attempt: ctx.attempt! });
    crash(ctx, "after-attempt");
    ctx.deps.evidence.recordMigrationActivationWitness({ homeDir: ctx.homeDir, generationId: ctx.generationId, witness: ctx.witness! });
    crash(ctx, "after-witness");
  } catch (error) {
    if (error instanceof MigrationActivationEvidenceRefusalError) {
      return interrupted(ctx, step, error.reason === "evidence-unresolvable" ? "evidence-unresolvable" : "evidence-conflict", error.message);
    }
    if (error instanceof Error && error.name === "MigrationBindingConflictError") return interrupted(ctx, step, "evidence-conflict", error.message);
    if (error instanceof Error && error.name === "MigrationBindingUnresolvableError") return interrupted(ctx, step, "evidence-unresolvable", error.message);
    throw error;
  }
  try {
    ctx.deps.bindings.recordMigrationWitnessBinding({
      homeDir: ctx.homeDir,
      generationId: ctx.generationId,
      binding: {
        kind: "activation",
        epochId: ctx.epoch!.epochId,
        attemptId: ctx.attempt!.attemptId,
        manifestRevision: ctx.pair!.epochManifestRevision,
        witnessChecksumSha256: ctx.witness!.checksumSha256,
      },
    });
    crash(ctx, "after-witness-binding");
  } catch (error) {
    if (error instanceof Error && error.name === "MigrationBindingConflictError") return interrupted(ctx, step, "binding-conflict", error.message);
    if (error instanceof Error && error.name === "MigrationBindingUnresolvableError") return interrupted(ctx, step, "binding-unresolvable", error.message);
    throw error;
  }
  return ok(true);
}

/** Only a window entered from sqlite belongs to an activation; a rollback
 * enters from postgresql (#626) and is foreign to this orchestrator. */
function isActivationMaintenance(journal: BackendMaintenanceJournal): boolean {
  return journal.sourceBackend === "sqlite";
}

function foreignMaintenanceDetail(journal: BackendMaintenanceJournal): string {
  return "the maintenance journal was entered from " + journal.sourceBackend + " for generation " + journal.generationId
    + " (a rollback window), not from sqlite";
}

/** S12: version-3 selection by phase. */
async function stepSelection(ctx: Context): Promise<Step<BackendMaintenanceJournal>> {
  let journal: BackendMaintenanceJournal | null;
  try {
    journal = ctx.deps.readMaintenanceJournal(ctx.homeDir);
  } catch (error) {
    return interrupted(ctx, "S12", "journal-unexpected", "the maintenance journal could not be read: " + (error as Error).message);
  }
  if (journal === null || journal.generationId !== ctx.generationId) {
    return interrupted(ctx, "S12", "journal-unexpected", journal === null ? "no maintenance journal exists" : "the maintenance journal names another generation");
  }
  if (!isActivationMaintenance(journal)) return interrupted(ctx, "S12", "journal-unexpected", foreignMaintenanceDetail(journal));
  const evidence = ctx.witness!.checksumSha256;
  try {
    if (journal.phase === "maintenance-held") {
      journal = await ctx.coordinator!.prepareMaintenanceSelection(
        { expectedChecksumSha256: journal.checksumSha256, generationId: ctx.generationId, targetBackend: "postgresql", terminalEvidenceSha256: evidence },
        ctx.token,
      );
      crash(ctx, "after-selection-prepared");
    }
    if (journal.phase === "selection-prepared") {
      if (journal.terminalEvidenceSha256 !== evidence) {
        return interrupted(ctx, "S12", "journal-unexpected", "the prepared selection carries another attempt's witness checksum");
      }
      journal = await ctx.coordinator!.completeMaintenanceSelection(
        { expectedChecksumSha256: journal.checksumSha256, generationId: ctx.generationId, terminalEvidenceSha256: evidence },
        ctx.token,
      );
      crash(ctx, "after-selection-completed");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "BackendPublicationJournalError") {
      return interrupted(ctx, "S12", "journal-unexpected", error.message);
    }
    throw error;
  }
  if (journal.phase !== "selection-completed") {
    return interrupted(ctx, "S12", "journal-unexpected", "the maintenance journal is at phase " + journal.phase);
  }
  return ok(journal);
}

/** S13a: the selection binding, before any prepare() (A13). */
function stepSelectionBinding(ctx: Context): Step<true> {
  try {
    ctx.deps.bindings.recordMigrationSelectionBinding({
      homeDir: ctx.homeDir,
      generationId: ctx.generationId,
      binding: {
        kind: "activation",
        epochId: ctx.epoch!.epochId,
        attemptId: ctx.attempt!.attemptId,
        manifestRevision: ctx.pair!.epochManifestRevision,
        witnessChecksumSha256: ctx.witness!.checksumSha256,
        publicationId: ctx.publicationId,
      },
    });
    crash(ctx, "after-selection-binding");
  } catch (error) {
    if (error instanceof Error && error.name === "MigrationBindingConflictError") return interrupted(ctx, "S13a", "binding-conflict", error.message);
    if (error instanceof Error && error.name === "MigrationBindingUnresolvableError") return interrupted(ctx, "S13a", "binding-unresolvable", error.message);
    throw error;
  }
  return ok(true);
}

/** S13b: lease continuation (A2 post-selection), then the drive. */
async function stepDrive(ctx: Context): Promise<Step<ActivationPublicationResult>> {
  let v2: BackendPublicationJournal | null = null;
  try {
    if (ctx.deps.readMaintenanceJournal(ctx.homeDir) === null) v2 = ctx.deps.readPublicationJournal(ctx.homeDir);
  } catch (error) {
    return interrupted(ctx, "S13b", "journal-unexpected", "the publication journal could not be read: " + (error as Error).message);
  }
  const coordinatorOwnsFences = v2 !== null && v2.publicationId === ctx.publicationId && NO_OWN_FENCE_PHASES.has(v2.phase);
  if (!coordinatorOwnsFences) {
    // A3: no lease acquire or takeover once the publication is releasing
    // (or unwinding); the coordinator reconciles its own fences there.
    const continued = await continueLease(ctx);
    if (continued.kind === "lost") return interrupted(ctx, "S13b", "lease-lost", continued.detail);
    if (continued.kind === "unresolvable") return interrupted(ctx, "S13b", "lease-unresolvable", continued.detail);
    if (continued.kind === "took-over") {
      // Post-selection successor: identity compared live-to-live by the
      // guard (same machine, same publication); the token may advance and
      // is reported on the outcome only, never written into the attempt.
      if (BigInt(continued.fence.fencingToken) < BigInt(ctx.attempt!.selectionAuthority.fencingToken)) {
        return interrupted(ctx, "S13b", "lease-lost", "the fenced lease token regressed below the recorded selection authority");
      }
      ctx.successorFencingToken = continued.fence.fencingToken.toString(10);
    }
    ctx.fence = continued.fence;
  }
  const result = await ctx.deps.drive(ctx.guard!, ctx.coordinator!, {
    homeDir: ctx.homeDir,
    lockToken: ctx.token,
    publicationId: ctx.publicationId,
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    identityDigest: ctx.identityDigest!,
    projects: ctx.artifact!.projects,
    signal: ctx.input.signal,
  });
  crash(ctx, "after-drive");
  if (result.status !== "completed") {
    return { exit: { status: "publication-failed", publication: result, identity: identityOf(ctx) } };
  }
  return ok(result);
}

/** S16: readback, post-publication witness, G5 report, completion. */
async function stepComplete(ctx: Context, restart: ActivationRestartCheckResult): Promise<Step<MigrationActivationOutcome>> {
  let manifest: MigrationManifest;
  try {
    manifest = ctx.deps.manifestStore.read(ctx.generationId);
  } catch (error) {
    return interrupted(ctx, "S16", "state-unresolvable", "the manifest could not be re-read: " + (error as Error).message);
  }
  const ids = effectIds(ctx.epoch!.epochId);
  if (manifest.phase !== "activating" || manifest.pendingEffect?.kind !== "publish-activation" || manifest.pendingEffect.effectId !== ids.publish) {
    return interrupted(ctx, "S16", "readback-mismatch", "the manifest is not activating with this activation's pending publish-activation");
  }
  ctx.manifest = manifest;
  let v2: BackendPublicationJournal | null;
  try {
    v2 = ctx.deps.readPublicationJournal(ctx.homeDir);
  } catch (error) {
    return interrupted(ctx, "S16", "readback-mismatch", "the publication journal could not be re-read: " + (error as Error).message);
  }
  if (v2 === null || v2.publicationId !== ctx.publicationId || v2.phase !== "completed") {
    return interrupted(ctx, "S16", "readback-mismatch", "the publication journal is not this publication's completed journal");
  }
  let bindings: MigrationWitnessResolution;
  try {
    bindings = ctx.deps.bindings.resolveMigrationWitnessBindings({ homeDir: ctx.homeDir, generationId: ctx.generationId });
  } catch (error) {
    return interrupted(ctx, "S16", "binding-unresolvable", (error as Error).message);
  }
  if (bindings.state !== "resolved" || !bindings.selections.some((selection) => selection.kind === "activation" && selection.publicationId === ctx.publicationId)) {
    return interrupted(ctx, "S16", "readback-mismatch", "the selection binding for this activation is not resolved");
  }
  const post = projectMapWitness(ctx, "post-publication");
  if (isExit(post)) return post;
  if (post.value !== ctx.report.body.projectMapWitnessSha256) {
    return interrupted(ctx, "S16", "project-map-drift", "the post-publication project map witness differs from the verified witness");
  }
  const report = createMigrationActivationReport({
    generationId: ctx.generationId,
    epochId: ctx.epoch!.epochId,
    attemptId: ctx.attempt!.attemptId,
    witnessChecksumSha256: ctx.witness!.checksumSha256,
    publicationId: ctx.publicationId,
    identityDigest: ctx.identityDigest!,
    manifestRevisionAtComplete: manifest.revision,
    postPublicationProjectMapWitnessSha256: post.value,
    createdAt: manifest.pendingEffect.startedAt,
  });
  let persisted: MigrationActivationReportPersistResult;
  try {
    persisted = ctx.deps.persistReport({ homeDir: ctx.homeDir, generationId: ctx.generationId, report });
    crash(ctx, "after-report");
  } catch (error) {
    if (error instanceof MigrationActivationReportError) {
      return interrupted(ctx, "S16", error.reason === "identity-conflict" ? "report-conflict" : "report-unresolvable", error.message, report.reportSha256);
    }
    throw error;
  }
  const reference = migrationActivationReportReference(persisted.report);
  let active: MigrationManifest;
  try {
    active = ctx.deps.manifestStore.update(ctx.generationId, manifest.checksumSha256, (current) =>
      completeMigrationEffect(current, { effectId: ids.publish, completedAt: ctx.now().toISOString(), report: reference }));
  } catch (error) {
    if (error instanceof MigrationProtocolError) {
      return interrupted(ctx, "S16", "state-unresolvable", "publish-activation could not be completed: " + error.message, report.reportSha256);
    }
    throw error;
  }
  return ok({
    status: "activated",
    identity: { generationId: ctx.generationId, publicationId: ctx.publicationId, manifestRevision: active.revision },
    report: reference,
    restart,
    resumedFrom: ctx.resumedFrom,
    successorFencingToken: ctx.successorFencingToken,
  });
}

async function restartVerdict(ctx: Context): Promise<ActivationRestartCheckResult> {
  try {
    return await ctx.deps.checkRestart({ selectedBackend: "postgresql", pidFilePath: daemonPidPath(ctx.homeDir), port: ctx.deps.daemonPort(ctx.homeDir) });
  } catch (error) {
    // The verdict observes; it never decides the outcome. A failure to look
    // (unreadable stored config, a probe that threw) is the restart module's
    // own "could not observe" row, exactly as the preview reports it.
    return Object.freeze({
      status: "unresolvable",
      reason: "health-unreachable",
      detail: "the restart check could not observe the daemon: " + (error as Error).message,
      pid: null,
      observedBackend: null,
      selectedBackend: "postgresql",
    });
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function validateInput(input: MigrationActivationInput): void {
  if (
    typeof input !== "object" || input === null
    || typeof input.homeDir !== "string" || input.homeDir.length === 0
    || typeof input.generationId !== "string" || !GENERATION_ID_PATTERN.test(input.generationId)
    || typeof input.transferSettings !== "object" || input.transferSettings === null
    || typeof input.ordinarySettings !== "object" || input.ordinarySettings === null
    || typeof input.expectedIdentity !== "object" || input.expectedIdentity === null
    || typeof input.expectedIdentity.id !== "string"
    || typeof input.expectedIdentity.remoteProjectId !== "string"
    || typeof input.expectedIdentity.localProjectId !== "string"
    || !PROJECT_HASH_PATTERN.test(input.expectedIdentity.localProjectId)
    || typeof input.expectedOwner !== "string" || input.expectedOwner.length === 0
  ) {
    throw new MigrationActivationError("invalid-input", "migration activation input is invalid");
  }
}

/**
 * Activate (or recover the activation of) one verified generation. See the
 * module doc comment for the sequence and the sources of every binding.
 */
export async function runMigrationActivation(
  input: MigrationActivationInput,
  dependencies?: Partial<MigrationActivationDependencies>,
): Promise<MigrationActivationOutcome> {
  validateInput(input);
  const deps: MigrationActivationDependencies = { ...createMigrationActivationDependencies({ homeDir: input.homeDir }), ...dependencies };
  const ctx: Context = {
    input,
    deps,
    homeDir: input.homeDir,
    generationId: input.generationId,
    publicationId: deriveActivationPublicationId(input.generationId),
    localProjectId: input.expectedIdentity.localProjectId!,
    remoteProjectId: input.expectedIdentity.remoteProjectId!,
    now: input.now ?? (() => new Date()),
    machineId: null,
    token: {} as BackendPublicationLockToken,
    manifest: null as unknown as MigrationManifest,
    report: null as unknown as MigrationVerificationReport,
    verificationRef: null as unknown as MigrationReportReference,
    effectBegun: false,
    resumedFrom: "fresh",
    ordinary: null, ordinaryRole: null, transferRole: null, guard: null, coordinator: null,
    evidenceSha256: null, fence: null, successorFencingToken: null, quiescence: null,
    pair: null, material: null, identityDigest: null, artifact: null, link: null,
    censusVector: null, canonicalDelta: null, epoch: null, attempt: null, witness: null, pendingStartedAt: null,
  };
  // The append barrier creates the LCM home, so an uninitialized home must be
  // classified before entering it. Only the absent case exits here; every
  // other read result is classified by the in-barrier read (step C).
  try {
    deps.manifestStore.read(input.generationId);
  } catch (error) {
    if (isManifestAbsent(error)) return manifestAbsentRefusal(input.generationId).exit;
  }
  return deps.withAppendBarrier(input.homeDir, async (token) => {
    ctx.token = token;
    try {
      return await withPreEffectLeaseReleased(ctx, await runUnderBarrier(ctx));
    } catch (error) {
      // Best effort, only when readback proves no effect began (a commit
      // that then threw keeps its lease): the original error is the outcome.
      if (ctx.fence !== null && headPositivelyUnbegun(ctx)) await releaseAbandonedLease(ctx);
      throw error;
    } finally {
      if (ctx.ordinary !== null) await ctx.ordinary.close();
    }
  });
}

async function runUnderBarrier(ctx: Context): Promise<MigrationActivationOutcome> {
  // --- C: manifest and verification report ---------------------------------
  const manifest = readManifest(ctx);
  if (isExit(manifest)) return manifest.exit;
  ctx.manifest = manifest.value;
  const recovery = classifyMigrationRecovery(ctx.manifest);
  if (recovery.action === "settled") {
    if (recovery.phase !== "active") return refused(ctx, "S0", "manifest-not-eligible", "the generation is settled at phase " + recovery.phase).exit;
    return settledActive(ctx);
  }
  if ((recovery.action === "resume" || recovery.action === "readback")
    && recovery.effect.kind !== "prepare-activation" && recovery.effect.kind !== "publish-activation") {
    return refused(ctx, "S0", "pending-effect-foreign", "the pending effect " + recovery.effect.kind + " is not an activation effect").exit;
  }
  if (recovery.action === "ready" && (ctx.manifest.phase !== "verified" && ctx.manifest.phase !== "activating")) {
    return refused(ctx, "S0", "manifest-not-eligible", "the manifest is at phase " + ctx.manifest.phase + ", not verified").exit;
  }
  // A verified or activating manifest is activation-eligible by protocol.ts's
  // own invariant (verify-generation completes only with activationEligible
  // true), so no separate eligibility check is needed here.
  ctx.effectBegun = ctx.manifest.phase === "activating" || ctx.manifest.pendingEffect !== null;
  const verification = readVerification(ctx);
  if (isExit(verification)) return verification.exit;
  ctx.report = verification.value.report;
  ctx.verificationRef = verification.value.ref;

  // --- C: durable sub-state -------------------------------------------------
  const link = ctx.deps.readLink({ homeDir: ctx.homeDir, generationId: ctx.generationId });
  if (link.state === "unresolvable") {
    return ctx.effectBegun
      ? interrupted(ctx, "S11", "state-unresolvable", "the generation link is unresolvable: " + link.detail).exit
      : refused(ctx, "S0", "state-unresolvable", "the generation link is unresolvable: " + link.detail).exit;
  }
  if (link.state === "resolved") {
    if (link.link.publicationId !== ctx.publicationId) {
      return interrupted(ctx, "S11", "link-conflict", "the generation link names publication " + link.link.publicationId).exit;
    }
    ctx.link = link.link;
    ctx.identityDigest = link.link.identityDigest;
    ctx.pair = { epochManifestRevision: link.link.epochManifestRevision, epochManifestChecksumSha256: link.link.epochManifestChecksumSha256 };
  }
  // The two journals share one file: the version-3 reader returns null for
  // a version-2 journal, and the version-2 reader refuses a version-3 one,
  // so the version-2 peek runs only when no maintenance journal is live
  // (the same order activation-publication.ts uses).
  let v3: BackendMaintenanceJournal | null;
  let v2: BackendPublicationJournal | null = null;
  try {
    v3 = ctx.deps.readMaintenanceJournal(ctx.homeDir);
    if (v3 === null) v2 = ctx.deps.readPublicationJournal(ctx.homeDir);
  } catch (error) {
    return ctx.effectBegun
      ? interrupted(ctx, "S12", "journal-unexpected", "a backend journal could not be read: " + (error as Error).message).exit
      : refused(ctx, "S0", "maintenance-unresolvable", "a backend journal could not be read: " + (error as Error).message).exit;
  }
  const ownV2 = v2 !== null && v2.publicationId === ctx.publicationId ? v2 : null;
  if (v3 !== null && !isActivationMaintenance(v3)) {
    const detail = foreignMaintenanceDetail(v3);
    return ctx.effectBegun ? interrupted(ctx, "S12", "journal-unexpected", detail).exit : refused(ctx, "S3", "maintenance-not-held", detail).exit;
  }

  // Link resolved: everything comes from link + artifact; compose is never called (A9).
  if (ctx.link !== null) {
    let artifact: ActivationArtifactRecoveryMaterial | null;
    try {
      artifact = ctx.deps.readArtifact({ homeDir: ctx.homeDir, identityDigest: ctx.identityDigest! });
    } catch (error) {
      // Validation covers a file under the digest that does not parse as
      // sealed material: present but not an artifact, hence unresolvable.
      if (isArtifactReadRefusal(error)) {
        return interrupted(ctx, "S11", "state-unresolvable", "the linked artifact is unresolvable: " + error.message).exit;
      }
      throw error;
    }
    if (artifact === null) return interrupted(ctx, "S11", "state-unresolvable", "the generation link names an artifact that is absent").exit;
    ctx.artifact = artifact;
    ctx.evidenceSha256 = artifact.projects[0]!.evidenceSha256;
  }

  const machine = resolveMachineId(ctx);
  if (machine !== null) return machine.exit;
  openOrdinary(ctx);

  // --- Post-selection re-entry (v2 journal, or v3 selection-prepared/completed) ---
  const postSelection = ownV2 !== null || (v3 !== null && v3.generationId === ctx.generationId
    && (v3.phase === "selection-prepared" || v3.phase === "selection-completed"));
  if (postSelection) {
    if (ctx.link === null) {
      return interrupted(ctx, "S12", "state-unresolvable", "a selection exists for this generation but no generation link records its publication").exit;
    }
    const adopted = adoptStoredAttempt(ctx, v3, ownV2);
    if (isExit(adopted)) return adopted.exit;
    ctx.resumedFrom = ownV2 !== null ? "publication-journal" : v3!.phase === "selection-prepared" ? "selection-prepared" : "selection-completed-unbound";
    const preparedSessions = await prepareActivationSessions(ctx);
    if (isExit(preparedSessions)) return preparedSessions.exit;
    const own = await readOwnFence(ctx);
    if (own.kind === "own") {
      ctx.fence = own.fence;
    } else if (own.kind === "unresolvable") {
      return interrupted(ctx, "S13b", "lease-unresolvable", own.detail).exit;
    } else if (!(ownV2 !== null && (own.kind === "foreign"
      ? SUCCESSOR_ROW_PHASES.has(ownV2.phase) || (RELEASE_WINDOW_PHASES.has(ownV2.phase) && !own.corrupt)
      : NO_OWN_FENCE_PHASES.has(ownV2.phase)))) {
      // An absent row is lost unless the coordinator owns the fences for
      // this phase (NO_OWN_FENCE_PHASES); a row of another publication is
      // lost unless this publication has already released its own
      // (SUCCESSOR_ROW_PHASES) or is finishing that release
      // (RELEASE_WINDOW_PHASES, decodable rows only). Otherwise ctx.fence
      // stays null and stepDrive continues without one, never touching a
      // successor's row.
      return interrupted(ctx, "S13b", "lease-lost", own.detail).exit;
    }
    // A selection is recorded only after S10 began publish-activation, and
    // the effect is completed only by S16 (which also settles the manifest
    // active), so a pending effect is a protocol invariant here; its absence
    // is foreign state, never re-begun.
    if (ctx.manifest.pendingEffect === null) {
      return interrupted(ctx, "S10", "state-unresolvable", "a selection exists for this generation but no publish-activation effect is pending").exit;
    }
    ctx.pendingStartedAt = ctx.manifest.pendingEffect.startedAt;
    if (ownV2 === null && v3!.phase === "selection-prepared") {
      const selected = await stepSelection(ctx);
      if (isExit(selected)) return selected.exit;
    }
    return finishAfterSelection(ctx);
  }

  // --- Pre-selection: fresh or re-entry before S12 --------------------------
  if (v3 === null || v3.generationId !== ctx.generationId || v3.phase !== "maintenance-held") {
    const detail = v3 === null ? "no maintenance journal is held for this generation" : "the maintenance journal is at phase " + v3.phase + " for generation " + v3.generationId;
    return ctx.effectBegun ? interrupted(ctx, "S12", "journal-unexpected", detail).exit : refused(ctx, "S3", "maintenance-not-held", detail).exit;
  }
  if (ctx.manifest.phase === "activating") {
    ctx.resumedFrom = ctx.link !== null ? "publish-pending-after-link"
      : ctx.manifest.pendingEffect === null ? "activating-no-effect" : "publish-pending-before-artifact";
  } else if (ctx.manifest.pendingEffect !== null) {
    ctx.resumedFrom = "prepare-activation-pending";
  }

  const preparedSessions = await prepareActivationSessions(ctx);
  if (isExit(preparedSessions)) return preparedSessions.exit;

  // S0: evidence digest (A5) unless the artifact already carries it.
  if (ctx.evidenceSha256 === null) {
    const evidence = await stepCopyBinding(ctx);
    if (isExit(evidence)) return evidence.exit;
    ctx.evidenceSha256 = evidence.value;
  }
  // S2
  const lease = await stepLeaseAcquire(ctx);
  if (isExit(lease)) return lease.exit;
  ctx.fence = lease.value;
  // S3
  const quiescence = await stepQuiescence(ctx);
  if (isExit(quiescence)) return quiescence.exit;
  ctx.quiescence = quiescence.value;
  // S4 + G8
  const coverage = stepCoverage(ctx);
  if (isExit(coverage)) return coverage.exit;
  // S4b: in-memory tuple (link absent) or the link's frozen tuple.
  if (ctx.pair === null) {
    // The VERIFIED manifest with no pending effect: the head itself on a
    // fresh call, otherwise reached through the authenticated revision chain.
    const verified = readVerifiedLineage(ctx, ctx.manifest);
    if (isExit(verified)) return verified.exit;
    ctx.pair = { epochManifestRevision: verified.value.revision, epochManifestChecksumSha256: verified.value.checksumSha256 };
  }
  // S5's project-map predicate runs before composing: the composer refuses a
  // map entry bound to another remote with an untyped error, while the
  // witness names the drift. The comparison against the report stays S5's.
  const pre = projectMapWitness(ctx, "pre-publication");
  if (isExit(pre)) return pre.exit;
  if (pre.value !== ctx.report.body.projectMapWitnessSha256) {
    return refused(ctx, "S5", "project-map-drift", "the pre-publication project map witness differs from the verification report's").exit;
  }
  if (ctx.link === null) {
    // No link means no version-2 journal of ours either (that pair is the
    // post-selection branch above), so the artifact is looked up by the
    // recomputed digest. A9: an orphan artifact (crash after the artifact,
    // before the link) is reused when byte-identical to the recompute; a
    // different artifact under the recomputed digest is a conflict the
    // store itself raises.
    const composed = stepCompose(ctx);
    ctx.material = composed.material;
    ctx.identityDigest = composed.identityDigest;
    try {
      ctx.artifact = ctx.deps.readArtifact({ homeDir: ctx.homeDir, identityDigest: ctx.identityDigest });
    } catch (error) {
      if (isArtifactReadRefusal(error)) {
        return ctx.effectBegun
          ? interrupted(ctx, "S11", "artifact-unresolvable", error.message).exit
          : refused(ctx, "S0", "state-unresolvable", error.message).exit;
      }
      throw error;
    }
    if (ctx.artifact !== null && ctx.artifact.publicationId !== ctx.publicationId) {
      return interrupted(ctx, "S11", "artifact-identity-mismatch", "an artifact under the recomputed digest was sealed under another publicationId").exit;
    }
  }
  // S5 destination identity was bound before S2; the project-map predicate
  // above is the remaining S5 check.
  // S6
  const health = await stepHealth(ctx);
  if (isExit(health)) return health.exit;
  // S7
  const census = await stepCensus(ctx);
  if (isExit(census)) return census.exit;
  ctx.censusVector = census.value.censusVector;
  ctx.canonicalDelta = census.value.canonicalDelta;
  // S8
  const eligible = stepEligibility(ctx, ctx.censusVector);
  if (isExit(eligible)) return eligible.exit;
  // Renew after S7.
  const renewedAfterCensus = await continueLease(ctx);
  if (renewedAfterCensus.kind === "lost") return refused(ctx, "S8", "lease-conflict", renewedAfterCensus.detail).exit;
  if (renewedAfterCensus.kind === "unresolvable") return refused(ctx, "S8", "lease-unresolvable", renewedAfterCensus.detail).exit;
  ctx.fence = renewedAfterCensus.fence;
  // Epoch, attempt, witness (attempt and witness are re-derived if the lease is taken over before S12).
  ctx.epoch = epochFor(ctx, ctx.pair);
  ctx.attempt = attemptFor(ctx);
  ctx.witness = createMigrationActivationWitness({ kind: "activation", epoch: ctx.epoch, attempt: ctx.attempt, postEpochDelta: null, postEpochCensus: null, rollbackMode: null });
  // S9
  if (ctx.manifest.phase === "verified") {
    const prepared = stepPrepareActivation(ctx);
    if (isExit(prepared)) return prepared.exit;
    ctx.manifest = prepared.value;
  }
  // S10
  const begun = stepBeginPublish(ctx);
  if (isExit(begun)) return begun.exit;
  ctx.manifest = begun.value;
  // S11
  const durable = stepDurableEvidence(ctx);
  if (isExit(durable)) return durable.exit;
  // Renew before S12; an expired lease is taken over, which mints a new attempt (plan-v6 section 7).
  const renewedBeforeSelection = await continueLease(ctx);
  if (renewedBeforeSelection.kind === "lost") return interrupted(ctx, "S12", "lease-lost", renewedBeforeSelection.detail).exit;
  if (renewedBeforeSelection.kind === "unresolvable") return interrupted(ctx, "S12", "lease-unresolvable", renewedBeforeSelection.detail).exit;
  ctx.fence = renewedBeforeSelection.fence;
  if (renewedBeforeSelection.kind === "took-over") {
    ctx.attempt = attemptFor(ctx);
    ctx.witness = createMigrationActivationWitness({ kind: "activation", epoch: ctx.epoch, attempt: ctx.attempt, postEpochDelta: null, postEpochCensus: null, rollbackMode: null });
    const rerecorded = recordEvidenceChain(ctx, "S12");
    if (isExit(rerecorded)) return rerecorded.exit;
  }
  // S12
  const selected = await stepSelection(ctx);
  if (isExit(selected)) return selected.exit;
  return finishAfterSelection(ctx);
}

/** S13a -> S13b -> S15 -> S16. */
async function finishAfterSelection(ctx: Context): Promise<MigrationActivationOutcome> {
  const bound = stepSelectionBinding(ctx);
  if (isExit(bound)) return bound.exit;
  const driven = await stepDrive(ctx);
  if (isExit(driven)) return driven.exit;
  // S15: health is observed, never refused here -- the publication is
  // durable, so a failure is reported with the restart verdict (I2: no
  // automatic reversal) and the next call rolls forward.
  const health = await observeHealth(ctx);
  const restart = await restartVerdict(ctx);
  if (health.status !== "healthy") {
    return { status: "post-publication-unhealthy", health, restart, identity: identityOf(ctx) };
  }
  const completed = await stepComplete(ctx, restart);
  if (isExit(completed)) return completed.exit;
  return completed.value;
}

/**
 * Re-entry after a selection exists: the attempt is the one whose witness
 * checksum the maintenance selection (or the completed publication's
 * binding) carries; never a new attempt (plan-v6 section 7).
 */
function adoptStoredAttempt(ctx: Context, v3: BackendMaintenanceJournal | null, ownV2: BackendPublicationJournal | null): Step<true> {
  let stored: MigrationActivationEvidenceResolution;
  try {
    stored = ctx.deps.evidence.readMigrationActivationEvidence({ homeDir: ctx.homeDir, generationId: ctx.generationId });
  } catch (error) {
    return interrupted(ctx, "S12", "evidence-unresolvable", (error as Error).message);
  }
  if (stored.state !== "resolved") {
    return interrupted(ctx, "S12", stored.state === "unresolvable" ? "evidence-unresolvable" : "state-unresolvable",
      stored.state === "unresolvable" ? stored.reason : "no activation evidence is stored for a generation whose selection exists");
  }
  let checksum: string | null = v3 !== null && v3.generationId === ctx.generationId ? v3.terminalEvidenceSha256 : null;
  if (checksum === null && ownV2 !== null) {
    let bindings: MigrationWitnessResolution;
    try {
      bindings = ctx.deps.bindings.resolveMigrationWitnessBindings({ homeDir: ctx.homeDir, generationId: ctx.generationId });
    } catch (error) {
      return interrupted(ctx, "S13a", "binding-unresolvable", (error as Error).message);
    }
    if (bindings.state === "resolved") {
      checksum = bindings.selections.find((selection) => selection.kind === "activation")?.witnessChecksumSha256
        ?? bindings.witnesses.find((witness) => witness.kind === "activation")?.witnessChecksumSha256 ?? null;
    }
  }
  const witness = checksum === null ? null : stored.witnesses.find((candidate) => candidate.checksumSha256 === checksum) ?? null;
  const attempt = witness === null ? null : stored.attempts.find((candidate) => candidate.attemptId === witness.attemptId) ?? null;
  const epoch = attempt === null ? null : stored.epochs.find((candidate) => candidate.epochId === attempt.epochId) ?? null;
  if (witness === null || attempt === null || epoch === null) {
    return interrupted(ctx, "S12", "state-unresolvable", "the selection's witness checksum does not name a stored epoch, attempt and witness");
  }
  const expectedEpoch = epochFor(ctx, ctx.pair!);
  if (expectedEpoch.epochId !== epoch.epochId) {
    return interrupted(ctx, "S12", "evidence-conflict", "the stored epoch is not the epoch this generation's link and report derive");
  }
  ctx.epoch = epoch;
  ctx.attempt = attempt;
  ctx.witness = witness;
  return ok(true);
}

/** Settled active (synthesis section 5): activated from durable state, or interrupted report-unresolvable. */
async function settledActive(ctx: Context): Promise<MigrationActivationOutcome> {
  ctx.effectBegun = true;
  ctx.resumedFrom = "settled-active";
  const ref = latestReport(ctx.manifest, "activation");
  const restart = await restartVerdict(ctx);
  const read = ctx.deps.readReport({ homeDir: ctx.homeDir, generationId: ctx.generationId, reportSha256: ref.reportSha256 });
  if (read.state === "authoritatively-absent") {
    return { ...interrupted(ctx, "S16", "report-unresolvable", "the stored activation report is absent: " + read.detail, ref.reportSha256).exit, reportStored: "no" } as MigrationActivationOutcome;
  }
  if (read.state === "unresolvable") {
    return { ...interrupted(ctx, "S16", "report-unresolvable", "the stored activation report cannot be read: " + read.detail, ref.reportSha256).exit, reportStored: "unknown" } as MigrationActivationOutcome;
  }
  const report: MigrationActivationReport = read.report;
  return {
    status: "activated",
    identity: { generationId: ctx.generationId, publicationId: report.body.publicationId, manifestRevision: ctx.manifest.revision },
    report: migrationActivationReportReference(report),
    restart,
    resumedFrom: "settled-active",
    successorFencingToken: null,
  };
}

// ---------------------------------------------------------------------------
// Preview (A11): non-predictive, no locks, no PostgreSQL, no writes
// ---------------------------------------------------------------------------

export type MigrationActivationPreviewCheck = Readonly<{
  name: "manifest" | "verification-report" | "resume-point" | "maintenance-journal" | "publication-journal" | "link" | "artifact" | "restart";
  status: "ok" | "refuse" | "unresolvable";
  detail: string;
}>;

export type MigrationActivationPreview = Readonly<{
  predictive: false;
  checks: readonly MigrationActivationPreviewCheck[];
  notEvaluated: readonly ["quiescence", "coverage", "g8", "lease", "health", "census"];
}>;

export async function previewMigrationActivation(
  input: Readonly<{ homeDir: string; generationId: string }>,
  dependencies?: Partial<MigrationActivationDependencies>,
): Promise<MigrationActivationPreview> {
  if (typeof input?.homeDir !== "string" || input.homeDir.length === 0 || !GENERATION_ID_PATTERN.test(String(input?.generationId))) {
    throw new MigrationActivationError("invalid-input", "migration activation preview input is invalid");
  }
  const deps: MigrationActivationDependencies = { ...createMigrationActivationDependencies({ homeDir: input.homeDir }), ...dependencies };
  const checks: MigrationActivationPreviewCheck[] = [];
  const publicationId = deriveActivationPublicationId(input.generationId);
  try {
    const manifest = deps.manifestStore.read(input.generationId);
    const recovery = classifyMigrationRecovery(manifest);
    // Mirrors runUnderBarrier's step C: a verified eligible or activating
    // manifest, or one settled active, unless a foreign effect is pending.
    const pending = manifest.pendingEffect;
    const foreignPending = pending !== null && pending.kind !== "prepare-activation" && pending.kind !== "publish-activation";
    const eligible = !foreignPending && ((manifest.phase === "verified" && manifest.activationEligible)
      || manifest.phase === "activating" || (recovery.action === "settled" && recovery.phase === "active"));
    checks.push({ name: "manifest", status: eligible ? "ok" : "refuse", detail: "phase " + manifest.phase + ", recovery " + recovery.action + (manifest.pendingEffect === null ? "" : ", pending " + manifest.pendingEffect.kind) });
    checks.push({
      name: "resume-point",
      status: "ok",
      detail: recovery.action === "settled" ? "settled-active" : manifest.phase === "activating" ? "activating" : manifest.pendingEffect === null ? "fresh" : "prepare-activation-pending",
    });
    if (!eligible) {
      checks.push({ name: "verification-report", status: "refuse", detail: "not evaluated: the manifest is not activation-eligible" });
    } else {
      try {
        const report = deps.readVerificationReport(input.generationId, latestReport(manifest, "verification").reportSha256);
        checks.push({ name: "verification-report", status: report.activationEligible ? "ok" : "refuse", detail: report.activationEligible ? "parsed, activation-eligible" : "parsed, not activation-eligible" });
      } catch (error) {
        checks.push({ name: "verification-report", status: "unresolvable", detail: (error as Error).message });
      }
    }
  } catch (error) {
    checks.push({ name: "manifest", status: isManifestAbsent(error) ? "refuse" : "unresolvable", detail: (error as Error).message });
  }
  try {
    const v3 = deps.readMaintenanceJournal(input.homeDir);
    checks.push({
      name: "maintenance-journal",
      status: v3 === null ? "refuse" : v3.generationId === input.generationId && isActivationMaintenance(v3) ? "ok" : "refuse",
      detail: v3 === null ? "absent" : "phase " + v3.phase + " for generation " + v3.generationId + " entered from " + v3.sourceBackend,
    });
    // Same shared-file rule as the orchestrator: the version-2 reader refuses a live version-3 journal.
    const v2 = v3 === null ? deps.readPublicationJournal(input.homeDir) : null;
    checks.push({
      name: "publication-journal",
      status: "ok",
      detail: v3 !== null ? "none while the maintenance journal is live" : v2 === null ? "absent" : "phase " + v2.phase + " for publication " + v2.publicationId + (v2.publicationId === publicationId ? " (this generation)" : ""),
    });
  } catch (error) {
    checks.push({ name: "maintenance-journal", status: "unresolvable", detail: (error as Error).message });
  }
  const link = deps.readLink({ homeDir: input.homeDir, generationId: input.generationId });
  checks.push({ name: "link", status: link.state === "unresolvable" ? "unresolvable" : "ok", detail: link.state === "resolved" ? "resolved to digest " + link.link.identityDigest : link.state === "unresolvable" ? link.reason + ": " + link.detail : "absent" });
  if (link.state === "resolved") {
    try {
      const artifact = deps.readArtifact({ homeDir: input.homeDir, identityDigest: link.link.identityDigest });
      checks.push({ name: "artifact", status: artifact === null ? "refuse" : "ok", detail: artifact === null ? "absent for the linked digest" : "present" });
    } catch (error) {
      checks.push({ name: "artifact", status: "unresolvable", detail: (error as Error).message });
    }
  } else {
    checks.push({ name: "artifact", status: "ok", detail: "not linked yet" });
  }
  try {
    const restart = await deps.checkRestart({ selectedBackend: "postgresql", pidFilePath: daemonPidPath(input.homeDir), port: deps.daemonPort(input.homeDir) });
    checks.push({ name: "restart", status: restart.status === "satisfied" ? "ok" : restart.status === "unsatisfied" ? "refuse" : "unresolvable", detail: restart.reason + ": " + restart.detail });
  } catch (error) {
    checks.push({ name: "restart", status: "unresolvable", detail: (error as Error).message });
  }
  return Object.freeze({
    predictive: false,
    checks: Object.freeze(checks),
    notEvaluated: ["quiescence", "coverage", "g8", "lease", "health", "census"] as const,
  });
}

