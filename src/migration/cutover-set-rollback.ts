import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDaemonConfig, readDaemonConfigSnapshot, resolveDaemonConfigEnv, type ResolvedStorageConfig } from "../daemon/config.js";
import { MachineIdentityFileError, requireMachineIdentity } from "../machine-identity.js";
import { parseProjectMap, type ProjectMap } from "../project-map.js";
import { lcmHomeDir } from "../runtime-paths.js";
import {
  BackendPublicationJournalError,
  backendCutoverSetManifestSha256,
  backendCutoverSetRollbackJournalCapacity,
  backendCutoverSetRollbackSelectionSha256,
  backendMaintenanceQueueEvidenceSentinel,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  rebindBackendMaintenanceCutoff,
  resolveBackendMaintenanceGenerationBinding,
  withBackendPublicationAppendBarrierAsync,
  type BackendCutoverSetManifest,
  type BackendCutoverSetRollbackSelection,
  type BackendCutoverSetRollbackSelectionMember,
  type BackendMaintenanceJournal,
  type BackendPublicationCoordinator,
  type BackendPublicationJournal,
  type BackendPublicationLockToken,
  type BackendPublicationRecoveryFile,
} from "../storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../storage/backend-publication-driver.js";
import { composeBackendPublicationMaterial } from "../storage/backend-publication-material.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import { resolveStorageIdentityContext } from "../storage/identity-context.js";
import { canonicalJson } from "../storage/portable-record.js";
import { createPortableRecordStream } from "../storage/portable-record-stream.js";
import type { PostgreSqlConnectionSettings } from "../storage/postgresql/contracts.js";
import { connectionSettings } from "../storage/postgresql/factory.js";
import {
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
} from "../storage/postgresql/publication-guard.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../storage/postgresql/publication-remote-guard.js";
import { verifyPostgreSqlRuntimeSchema } from "../storage/postgresql/runtime-readiness.js";
import {
  computeActivationArtifactIdentityDigest,
  publishActivationArtifact,
  readActivationArtifact,
  readActivationGenerationLink,
  type ActivationArtifactRecoveryMaterial,
} from "./activation-artifact-store.js";
import type { ActivationLeasePublicationGuard } from "./activation-lease.js";
import {
  createMigrationActivationReport,
  migrationActivationReportReference,
  persistMigrationActivationReport,
} from "./activation-report.js";
import {
  readMigrationActivationEvidence,
  recordMigrationActivationWitness,
  resolveRollbackAuthoritativeContext,
  type RollbackAuthoritativeContext,
} from "./activation-evidence-store.js";
import {
  createMigrationActivationWitness,
  migrationCanonicalDeltaChanged,
  migrationCensusVectorsEqual,
  migrationWitnessSha256,
} from "./activation-witness.js";
import { derivePreservedSqliteSource } from "./copy-source.js";
import { cutoverSetMaintenanceEntry } from "./cutover-set.js";
import { readCutoverSetActivationRecords, type CutoverSetActivationCheckpointMember, type CutoverSetActivationRecords } from "./cutover-set-activation-store.js";
import {
  createCutoverSetRollbackCheckpoint,
  createCutoverSetRollbackInstallRecord,
  deriveCutoverSetRollbackSetId,
  readCutoverSetRollbackRecords,
  recordCutoverSetRollbackCheckpoint,
  recordCutoverSetRollbackInstall,
  recordCutoverSetRollbackSelection,
  type CutoverSetRollbackCheckpoint,
  type CutoverSetRollbackInstallRecord,
  type CutoverSetRollbackRecords,
} from "./cutover-set-rollback-store.js";
import {
  recordMigrationSelectionBinding,
  recordMigrationWitnessBinding,
  resolveMigrationWitnessBindings,
} from "./generation-binding-store.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { computeMigrationProjectMapWitnessSha256 } from "./project-map-witness.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  MigrationProtocolError,
  type MigrationManifest,
} from "./protocol.js";
import { inspectAuthenticatedSqliteMigrationSnapshot, type AuthenticatedSqliteMigrationSnapshot } from "./queue-evidence.js";
import { evaluateRollbackEligibility, type RollbackEligibilityObservation } from "./rollback-eligibility.js";
import { buildRollbackGeneration, type RollbackGenerationOutcome } from "./rollback-generation.js";
import { installRollbackGeneration, streamSha256 } from "./rollback-install.js";
import { materializeRollbackSidecars } from "./rollback-sidecars.js";
import {
  DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
  ROLLBACK_LEASE_RENEWAL_INTERVAL_MS,
  ROLLBACK_LEASE_TTL_MS,
  RollbackSessionError,
  openCutoverSetRollbackFencedSession,
  type CutoverSetRollbackMemberSession,
  type RollbackSessionDependencies,
  type RollbackSessionRuntime,
  type RollbackSessionTarget,
} from "./rollback-session.js";
import {
  MAX_ROLLBACK_GENERATION_BUILD_ATTEMPT_ENTRIES,
  deriveRollbackPrepareInputSha256,
  deriveRollbackProjectEvidenceSha256,
  deriveRollbackReportId,
  highestRollbackGenerationBuildAttempt,
  readBackendPublicationOperabilityFact,
  readProjectMapForRollback,
  readRollbackReport,
  rollbackGenerationBuildBase,
  writeRollbackReport,
  type RollbackExportSource,
} from "./rollback.js";
import { MigrationVerificationReportStore } from "./verification-store.js";

/**
 * Rolling a cutover set back into new SQLite generations (#1550).
 *
 * One entry point, rollbackCutoverSet, for the fresh rollback of an
 * activated set and for the recovery of an interrupted one. It composes the
 * single-generation rollback's primitives (plan-v2 D1) around the set
 * contract: one retained append barrier spans every check, every member
 * effect, the one selection and the one reverse publication; every member
 * is classified independently (pre-write or post-write) under one
 * PostgreSQL-origin hold (D4); every member gets a NEW physical SQLite
 * generation, built from its fenced PostgreSQL export (post-write) or from
 * its authenticated preserved snapshot (pre-write, C1), verified, installed
 * at its canonical database path and completed with its sidecars (D5); the
 * thin reverse tuple (D6, C2) is frozen once after every member is installed
 * and the one reverse publication unbinds every member and restores sqlite
 * (D6); each original member manifest settles to rolled-back from its own
 * evidence. A blocked member blocks the whole set and preserves every
 * source, candidate and record (D5). runMigrationRollback is never called
 * for a member: it would publish that member alone.
 *
 * Commitment (D3, C5): pending activation effects of a completed activation
 * are settled first; the reverse artifact and the rollback checkpoint are
 * then written under the barrier, before the rollback hold archives the
 * completed activation publication. From the checkpoint on, every member's
 * old activation evidence is fenced for replay (C3) and every later failure
 * is a blocked member or an interruption that keeps the hold and the
 * evidence, never a refusal claiming nothing happened.
 *
 * Entry routing (D2) classifies the live journal slot and the stored
 * activation and rollback records before choosing a path:
 *
 * | Live slot | Rollback records | Route |
 * | --- | --- | --- |
 * | original completed activation v2 (target postgresql) | none | fresh: revalidate, settle, artifact, checkpoint, hold, member work, freeze, select, publish |
 * | original completed activation v2 | checkpoint | the crash before the hold: the exact same hold is entered, then as above |
 * | original activation v3 (any phase) or non-completed v2 | none | refused activation-not-completed |
 * | own rollback v3 entering | checkpoint | the exact entering CAS is recovered before the barrier, then held |
 * | own rollback v3 held | checkpoint | resume: bind missing member cutoffs, classify, prepare, build, revalidate, install, freeze, select |
 * | own rollback v3 selection-prepared / -completed | selection | adopt the frozen tuple, revalidate, finish the selection, bindings, one publication |
 * | own rollback v3 maintenance-aborted | any | interrupted hold-aborted: evidence kept, no automatic restart |
 * | own rollback v2 (any phase) | selection | resume or verify the one publication, then settle members |
 * | foreign v3 / v2, or empty | selection, all members rolled back | rolled-back from member evidence and the selected sqlite installation |
 * | foreign / empty | selection, members mixed | interrupted; never republished |
 * | foreign / empty | checkpoint only | interrupted; the hold is gone |
 * | foreign / empty | none | refused activation-not-live |
 *
 * No CLI reaches this service until #1551.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export type CutoverSetRollbackRefusalReason =
  | "activation-not-selected"
  | "activation-not-completed"
  | "activation-not-live"
  | "activation-unresolvable"
  | "cutover-set-too-large"
  | "machine-identity-unregistered"
  | "maintenance-held-by-other"
  | "member-not-active"
  | "member-evidence-missing"
  | "member-link-mismatch"
  | "member-snapshot-mismatch"
  | "project-coverage-drift"
  | "target-unreachable"
  | "target-identity-drift"
  | "cancelled";

export type CutoverSetRollbackBlockedReason =
  | "lease-conflict"
  | "lease-unresolvable"
  | "lease-lost"
  | "quiescence-unsatisfied"
  | "not-eligible"
  | "revalidation-drift"
  | "pending-evidence-drift"
  | "preserved-source-mismatch"
  | "build-quarantined"
  | "build-failed"
  | "install-failed"
  | "install-mismatch"
  | "target-unreachable"
  | "cancelled";

export type CutoverSetRollbackInterruptionCause =
  | "state-unresolvable"
  | "evidence-conflict"
  | "evidence-unresolvable"
  | "journal-unexpected"
  | "hold-aborted"
  | "hold-gone"
  | "artifact-unresolvable"
  | "artifact-mismatch"
  | "publication-aborted"
  | "publication-mismatch"
  | "readback-mismatch"
  | "lease-lost";

export type CutoverSetRollbackStep =
  | "records" | "slot" | "members" | "settlement" | "target" | "artifact" | "checkpoint" | "hold" | "cutoffs" | "sessions"
  | "classify" | "prepare" | "build" | "revalidate" | "install" | "freeze" | "selection" | "publication" | "completion";

export type CutoverSetRollbackResumePoint =
  | "fresh" | "before-hold" | "held" | "selection-frozen" | "selection-prepared" | "selection-completed" | "publication-journal" | "settled";

export type CutoverSetRollbackMemberResult = Readonly<{
  physicalProjectId: string;
  /** The ORIGINAL member generation. */
  generationId: string;
  remoteProjectId: string | null;
  /** The durable manifest phase last read for the member, or unknown. */
  manifest: string;
  mode: "pre-write" | "post-write" | null;
  /** The new physical SQLite generation installed for the member, once known. */
  installedGenerationId: string | null;
  reason: string | null;
  detail: string | null;
}>;

export type CutoverSetRollbackResult =
  | Readonly<{
    status: "rolled-back";
    originalSetId: string;
    setId: string;
    publicationId: string;
    members: readonly CutoverSetRollbackMemberResult[];
    resumedFrom: CutoverSetRollbackResumePoint;
  }>
  | Readonly<{
    status: "refused";
    originalSetId: string;
    setId: string;
    step: CutoverSetRollbackStep;
    reason: CutoverSetRollbackRefusalReason;
    detail: string;
    members: readonly CutoverSetRollbackMemberResult[];
    effectBegun: false;
  }>
  | Readonly<{
    status: "blocked";
    originalSetId: string;
    setId: string;
    step: CutoverSetRollbackStep;
    /** The member that blocked the set. */
    member: string;
    reason: CutoverSetRollbackBlockedReason;
    detail: string;
    members: readonly CutoverSetRollbackMemberResult[];
  }>
  | Readonly<{
    status: "interrupted";
    originalSetId: string;
    setId: string;
    step: CutoverSetRollbackStep;
    cause: CutoverSetRollbackInterruptionCause;
    detail: string;
    effectBegun: boolean;
    members: readonly CutoverSetRollbackMemberResult[];
  }>;

// ---------------------------------------------------------------------------
// Input and dependency seams
// ---------------------------------------------------------------------------

export type CutoverSetRollbackInput = Readonly<{
  homeDir: string;
  /** The ORIGINAL activated set id the operator confirmed. */
  confirmSetId: string;
  scratchParent?: string;
  signal?: AbortSignal;
  now?: () => Date;
}>;

export type CutoverSetRollbackCrashPoint = (point: string) => void;

export type CutoverSetRollbackDependencies = Readonly<{
  machineId: (homeDir: string) => string;
  readActivationRecords: typeof readCutoverSetActivationRecords;
  readRollbackRecords: typeof readCutoverSetRollbackRecords;
  recordCheckpoint: typeof recordCutoverSetRollbackCheckpoint;
  recordInstall: typeof recordCutoverSetRollbackInstall;
  recordSelection: typeof recordCutoverSetRollbackSelection;
  readArtifact: typeof readActivationArtifact;
  publishArtifact: typeof publishActivationArtifact;
  composeMaterial: typeof composeBackendPublicationMaterial;
  readOperabilityFact: typeof readBackendPublicationOperabilityFact;
  readMaintenanceJournal: (homeDir: string) => BackendMaintenanceJournal | null;
  readPublicationJournal: (homeDir: string) => BackendPublicationJournal | null;
  withAppendBarrier: typeof withBackendPublicationAppendBarrierAsync;
  manifestStore: MigrationManifestStore;
  readVerificationReport: (generationId: string, reportSha256: string) => ReturnType<MigrationVerificationReportStore["read"]>;
  readLink: typeof readActivationGenerationLink;
  resolveAuthoritativeContext: typeof resolveRollbackAuthoritativeContext;
  readActivationEvidence: typeof readMigrationActivationEvidence;
  recordActivationWitness: typeof recordMigrationActivationWitness;
  recordWitnessBinding: typeof recordMigrationWitnessBinding;
  recordSelectionBinding: typeof recordMigrationSelectionBinding;
  resolveWitnessBindings: typeof resolveMigrationWitnessBindings;
  inspectSnapshot: typeof inspectAuthenticatedSqliteMigrationSnapshot;
  derivePreservedSource: typeof derivePreservedSqliteSource;
  readProjectMap: (homeDir: string, token: BackendPublicationLockToken) => ProjectMap;
  readStorageConfig: (homeDir: string) => ResolvedStorageConfig;
  /** The storage configuration sealed in the reverse artifact's source configuration file. */
  parseSealedStorageConfig: (content: Uint8Array) => ResolvedStorageConfig;
  resolveIdentity: typeof resolveStorageIdentityContext;
  computeProjectMapWitness: typeof computeMigrationProjectMapWitnessSha256;
  persistActivationReport: typeof persistMigrationActivationReport;
  createRuntime: (settings: PostgreSqlConnectionSettings) => RollbackSessionRuntime;
  verifyRuntimeSchema: typeof verifyPostgreSqlRuntimeSchema;
  openMemberSession: typeof openCutoverSetRollbackFencedSession;
  sessionDependencies: RollbackSessionDependencies;
  createCoordinator: (input: Readonly<{ homeDir: string; guard: ActivationLeasePublicationGuard; machineId: string }>) => BackendPublicationCoordinator;
  buildGeneration: typeof buildRollbackGeneration;
  installGeneration: typeof installRollbackGeneration;
  materializeSidecars: typeof materializeRollbackSidecars;
  highestBuildAttempt: typeof highestRollbackGenerationBuildAttempt;
  createStream: typeof createPortableRecordStream;
  writeReport: typeof writeRollbackReport;
  readReport: typeof readRollbackReport;
  renewalIntervalMs: number;
  leaseCleanupTimeoutMs: number;
  crashPoint?: CutoverSetRollbackCrashPoint;
}>;

export function createCutoverSetRollbackDependencies(input: Readonly<{ homeDir: string }>): CutoverSetRollbackDependencies {
  const verificationStore = new MigrationVerificationReportStore({ homeDir: input.homeDir });
  return {
    machineId: (homeDir) => requireMachineIdentity(homeDir).machineId,
    readActivationRecords: readCutoverSetActivationRecords,
    readRollbackRecords: readCutoverSetRollbackRecords,
    recordCheckpoint: recordCutoverSetRollbackCheckpoint,
    recordInstall: recordCutoverSetRollbackInstall,
    recordSelection: recordCutoverSetRollbackSelection,
    readArtifact: readActivationArtifact,
    publishArtifact: publishActivationArtifact,
    composeMaterial: composeBackendPublicationMaterial,
    readOperabilityFact: readBackendPublicationOperabilityFact,
    readMaintenanceJournal: (homeDir) => readBackendMaintenanceJournal(homeDir),
    readPublicationJournal: (homeDir) => readBackendPublicationJournal(homeDir),
    withAppendBarrier: withBackendPublicationAppendBarrierAsync,
    manifestStore: new MigrationManifestStore({ homeDir: input.homeDir }),
    readVerificationReport: (generationId, reportSha256) => verificationStore.read(generationId, reportSha256),
    readLink: readActivationGenerationLink,
    resolveAuthoritativeContext: resolveRollbackAuthoritativeContext,
    readActivationEvidence: readMigrationActivationEvidence,
    recordActivationWitness: recordMigrationActivationWitness,
    recordWitnessBinding: recordMigrationWitnessBinding,
    recordSelectionBinding: recordMigrationSelectionBinding,
    resolveWitnessBindings: resolveMigrationWitnessBindings,
    inspectSnapshot: inspectAuthenticatedSqliteMigrationSnapshot,
    derivePreservedSource: derivePreservedSqliteSource,
    readProjectMap: (homeDir, token) => readProjectMapForRollback(homeDir, token),
    readStorageConfig: (homeDir) => readDaemonConfigSnapshot(join(homeDir, ".lcm", "config.json")).config.storage,
    parseSealedStorageConfig: (content) => parseDaemonConfig(new TextDecoder("utf-8", { fatal: true }).decode(content), undefined, resolveDaemonConfigEnv()).storage,
    resolveIdentity: resolveStorageIdentityContext,
    computeProjectMapWitness: computeMigrationProjectMapWitnessSha256,
    persistActivationReport: persistMigrationActivationReport,
    createRuntime: (settings) => DEFAULT_ROLLBACK_SESSION_DEPENDENCIES.createRuntime(settings),
    verifyRuntimeSchema: verifyPostgreSqlRuntimeSchema,
    openMemberSession: openCutoverSetRollbackFencedSession,
    sessionDependencies: DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
    createCoordinator: ({ homeDir, guard, machineId }) => createBackendPublicationCoordinator({
      homeDir,
      remoteGuard: {
        mode: "delegated",
        provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId, ttlMs: ROLLBACK_LEASE_TTL_MS }),
      },
    }),
    buildGeneration: buildRollbackGeneration,
    installGeneration: installRollbackGeneration,
    materializeSidecars: materializeRollbackSidecars,
    highestBuildAttempt: highestRollbackGenerationBuildAttempt,
    createStream: createPortableRecordStream,
    writeReport: writeRollbackReport,
    readReport: readRollbackReport,
    renewalIntervalMs: ROLLBACK_LEASE_RENEWAL_INTERVAL_MS,
    leaseCleanupTimeoutMs: 30_000,
  };
}


// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

const SET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PUBLISH_EFFECT_PREFIX = "rollback-publish-";
const PREPARE_EFFECT_PREFIX = "rollback-prepare-";

type Member = {
  readonly index: number;
  readonly physicalProjectId: string;
  readonly generationId: string;
  readonly sourceSelectionSha256: string;
  readonly activationRow: CutoverSetActivationCheckpointMember;
  readonly selectionRow: { epochId: string; attemptId: string; witnessChecksumSha256: string };
  remoteProjectId: string;
  canonicalPath: string;
  identity: StorageIdentityContext | null;
  manifest: MigrationManifest | null;
  snapshot: AuthenticatedSqliteMigrationSnapshot | null;
  authority: RollbackAuthoritativeContext | null;
  evidenceSha256: string;
  /** The settled active head the prepare input derives from (frozen in the checkpoint). */
  head: { manifestRevision: number; manifestChecksumSha256: string } | null;
  session: CutoverSetRollbackMemberSession | null;
  mode: "pre-write" | "post-write" | null;
  built: Extract<RollbackGenerationOutcome, { state: "verified" }> | null;
  exportEvidence: Pick<RollbackExportSource, "canonicalDelta" | "censusVector"> | null;
  terminalEvidenceSha256: string | null;
  install: CutoverSetRollbackInstallRecord | null;
  frozen: BackendCutoverSetRollbackSelectionMember | null;
  reason: string | null;
  detail: string | null;
};

type SetKeeper = Readonly<{
  signal: AbortSignal;
  /** Renew every open member lease now, serially; throws the first failure (which also aborts the signal). */
  sweep(): Promise<void>;
  assertFenced(): void;
  stop(): Promise<void>;
}>;

type Context = {
  readonly input: CutoverSetRollbackInput;
  readonly deps: CutoverSetRollbackDependencies;
  readonly homeDir: string;
  readonly originalSetId: string;
  readonly setId: string;
  readonly now: () => Date;
  readonly scratchParent: string;
  machineId: string;
  token: BackendPublicationLockToken;
  activation: Extract<CutoverSetActivationRecords, { state: "resolved" }> & { selection: NonNullable<Extract<CutoverSetActivationRecords, { state: "resolved" }>["selection"]> } | null;
  manifest: BackendCutoverSetManifest | null;
  members: Member[];
  rollback: Extract<CutoverSetRollbackRecords, { state: "resolved" }> | null;
  checkpoint: CutoverSetRollbackCheckpoint | null;
  selection: BackendCutoverSetRollbackSelection | null;
  artifact: ActivationArtifactRecoveryMaterial | null;
  activationArtifact: ActivationArtifactRecoveryMaterial | null;
  storage: Extract<ResolvedStorageConfig, { backend: "postgresql" }> | null;
  runtime: RollbackSessionRuntime | null;
  guard: ActivationLeasePublicationGuard | null;
  coordinator: BackendPublicationCoordinator | null;
  keeper: SetKeeper | null;
  effectBegun: boolean;
  resumedFrom: CutoverSetRollbackResumePoint;
};

type Exit = Readonly<{ exit: CutoverSetRollbackResult }>;
type Step<T> = Readonly<{ exit?: undefined; value: T }> | Exit;

function ok<T>(value: T): Step<T> {
  return { value };
}

function isExit<T>(step: Step<T>): step is Exit {
  return step.exit !== undefined;
}

function crash(ctx: Context, point: string): void {
  ctx.deps.crashPoint?.(point);
}

function sha256Hex(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function memberResults(ctx: Context): readonly CutoverSetRollbackMemberResult[] {
  return ctx.members.map((member) => ({
    physicalProjectId: member.physicalProjectId,
    generationId: member.generationId,
    remoteProjectId: member.remoteProjectId === "" ? null : member.remoteProjectId,
    manifest: member.manifest?.phase ?? "unknown",
    mode: member.mode,
    installedGenerationId: member.install?.installedGenerationId ?? member.built?.generationId ?? null,
    reason: member.reason,
    detail: member.detail,
  }));
}

/** A refusal before any durable rollback state; once the checkpoint exists the same failure is an interruption. */
function refused(ctx: Context, step: CutoverSetRollbackStep, reason: CutoverSetRollbackRefusalReason, detail: string): Exit {
  if (ctx.effectBegun) return interrupted(ctx, step, "state-unresolvable", reason + " on roll-forward: " + detail);
  return { exit: { status: "refused", originalSetId: ctx.originalSetId, setId: ctx.setId, step, reason, detail, members: memberResults(ctx), effectBegun: false } };
}

function blocked(ctx: Context, step: CutoverSetRollbackStep, member: Member, reason: CutoverSetRollbackBlockedReason, detail: string): Exit {
  member.reason = reason;
  member.detail = detail;
  return { exit: { status: "blocked", originalSetId: ctx.originalSetId, setId: ctx.setId, step, member: member.generationId, reason, detail, members: memberResults(ctx) } };
}

function interrupted(ctx: Context, step: CutoverSetRollbackStep, cause: CutoverSetRollbackInterruptionCause, detail: string): Exit {
  return { exit: { status: "interrupted", originalSetId: ctx.originalSetId, setId: ctx.setId, step, cause, detail, effectBegun: ctx.effectBegun, members: memberResults(ctx) } };
}

function at(member: Member, detail: string): string {
  return member.generationId + ": " + detail;
}

function sessionFailure(error: unknown): Readonly<{ reason: CutoverSetRollbackBlockedReason; detail: string }> {
  if (error instanceof RollbackSessionError) {
    if (error.reason === "lease-unavailable") return { reason: "lease-conflict", detail: error.message };
    if (error.reason === "lease-lost" || error.reason === "quiescence-unsatisfied") return { reason: error.reason, detail: error.message };
    return { reason: "lease-unresolvable", detail: error.message };
  }
  if (error instanceof Error && error.name === "AbortError") return { reason: "cancelled", detail: error.message };
  return { reason: "target-unreachable", detail: error instanceof Error ? error.message : String(error) };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function validateInput(input: CutoverSetRollbackInput): void {
  if (
    typeof input !== "object" || input === null
    || typeof input.homeDir !== "string" || input.homeDir.length === 0
    || typeof input.confirmSetId !== "string" || !SET_ID_PATTERN.test(input.confirmSetId)
  ) {
    throw new BackendPublicationJournalError("invalid-input", "cutover-set rollback input is invalid");
  }
}

/**
 * Roll back (or recover the rollback of) an activated cutover set. See the
 * module doc comment for the routing table and the sources of every rule.
 */
export async function rollbackCutoverSet(
  input: CutoverSetRollbackInput,
  dependencies?: Partial<CutoverSetRollbackDependencies>,
): Promise<CutoverSetRollbackResult> {
  validateInput(input);
  const deps: CutoverSetRollbackDependencies = { ...createCutoverSetRollbackDependencies({ homeDir: input.homeDir }), ...dependencies };
  const scratchParent = mkdtempSync(join(input.scratchParent ?? lcmHomeDir(input.homeDir), "cutover-set-rollback-scratch-"));
  const ctx: Context = {
    input, deps, homeDir: input.homeDir, originalSetId: input.confirmSetId, setId: deriveCutoverSetRollbackSetId(input.confirmSetId),
    now: input.now ?? (() => new Date()), scratchParent,
    machineId: "", token: {} as BackendPublicationLockToken, activation: null, manifest: null, members: [], rollback: null,
    checkpoint: null, selection: null, artifact: null, activationArtifact: null, storage: null, runtime: null, guard: null,
    coordinator: null, keeper: null, effectBegun: false, resumedFrom: "fresh",
  };
  try {
    const entering = await recoverEnteringBeforeBarrier(ctx);
    if (entering !== null) return entering;
    return await deps.withAppendBarrier(input.homeDir, async (token) => {
      ctx.token = token;
      try {
        return await withPreEffectLeasesReleased(ctx, await runUnderBarrier(ctx));
      } finally {
        await closeResources(ctx);
      }
    });
  } finally {
    rmSync(scratchParent, { recursive: true, force: true });
  }
}

/**
 * The append barrier refuses a maintenance-entering journal, so the own
 * entering row of the routing table is recovered before it: the exact
 * entering CAS input is replayed through enterMaintenance (which only
 * completes its own entering journal) and the call proceeds to the barrier.
 */
async function recoverEnteringBeforeBarrier(ctx: Context): Promise<CutoverSetRollbackResult | null> {
  let journal: BackendMaintenanceJournal | null;
  try {
    journal = ctx.deps.readMaintenanceJournal(ctx.homeDir);
  } catch (error) {
    return refused(ctx, "slot", "activation-unresolvable", "a backend journal could not be read: " + (error as Error).message).exit;
  }
  if (journal === null || journal.phase !== "maintenance-entering") return null;
  if (journal.cutoverSet === undefined || journal.generationId !== ctx.setId) {
    return refused(ctx, "slot", "maintenance-held-by-other", "the maintenance journal is entering for " + journal.generationId).exit;
  }
  const records = ctx.deps.readRollbackRecords({ homeDir: ctx.homeDir, originalSetId: ctx.originalSetId });
  if (records.state !== "resolved") {
    ctx.effectBegun = true;
    return interrupted(ctx, "hold", "state-unresolvable", "the rollback hold is entering but its checkpoint is " + records.state).exit;
  }
  ctx.effectBegun = true;
  if (backendCutoverSetManifestSha256(journal.cutoverSet.manifest) !== backendCutoverSetManifestSha256(records.checkpoint.manifest)) {
    return interrupted(ctx, "hold", "journal-unexpected", "the entering rollback hold does not carry the checkpointed manifest").exit;
  }
  const runtime = ctx.deps.createRuntime(connectionSettings(await storageForCheckpoint(ctx, records.checkpoint)));
  try {
    const coordinator = ctx.deps.createCoordinator({ homeDir: ctx.homeDir, guard: runtime.backendPublicationGuard(), machineId: ctx.deps.machineId(ctx.homeDir) });
    await coordinator.enterMaintenance({
      ...cutoverSetMaintenanceEntry(records.checkpoint.manifest), sourceBackend: "postgresql",
      now: new Date(journal.createdAt), expectedChecksumSha256: journal.checksumSha256,
    });
  } catch (error) {
    if (error instanceof BackendPublicationJournalError) return interrupted(ctx, "hold", "journal-unexpected", "the entering rollback hold could not be completed: " + error.message).exit;
    throw error;
  } finally {
    await runtime.close();
  }
  return null;
}

/** The PostgreSQL configuration the rollback runs against: the live one before the checkpoint, the sealed source after it. */
async function storageForCheckpoint(ctx: Context, checkpoint: CutoverSetRollbackCheckpoint): Promise<Extract<ResolvedStorageConfig, { backend: "postgresql" }>> {
  const artifact = ctx.deps.readArtifact({ homeDir: ctx.homeDir, identityDigest: checkpoint.identityDigest });
  if (artifact === null || artifact.source.config.presence !== "present") {
    throw new BackendPublicationJournalError("publication-evidence-missing", "the rollback checkpoint's reverse artifact is absent or sealed no source configuration");
  }
  const storage = ctx.deps.parseSealedStorageConfig(artifact.source.config.content);
  if (storage.backend !== "postgresql") {
    throw new BackendPublicationJournalError("unexpected-state", "the reverse artifact's source configuration does not select postgresql");
  }
  return storage;
}

async function closeResources(ctx: Context): Promise<void> {
  if (ctx.keeper !== null) await ctx.keeper.stop().catch(() => undefined);
  for (const member of ctx.members) {
    if (member.session !== null) await member.session.closeKeepingLease().catch(() => undefined);
    member.session = null;
  }
  if (ctx.runtime !== null) await ctx.runtime.close().catch(() => undefined);
  ctx.runtime = null;
}

/** True only when every member head is still its active manifest with no pending effect (no member effect of ours exists). */
function headsPositivelyUnbegun(ctx: Context): boolean {
  try {
    return ctx.members.length > 0 && ctx.members.every((member) => {
      const head = ctx.deps.manifestStore.read(member.generationId);
      return head.phase === "active" && head.pendingEffect === null;
    });
  } catch {
    return false;
  }
}

/**
 * A refusal or a blocked set whose member heads are positively unbegun
 * releases every lease this call acquired (bounded, best effort, own
 * signal): an unreleased row would bar every guarded writer of that project
 * while nothing of the rollback moved. Once any member effect exists the
 * rows are kept for the roll-forward. Release failures ride the detail.
 */
async function withPreEffectLeasesReleased(ctx: Context, outcome: CutoverSetRollbackResult): Promise<CutoverSetRollbackResult> {
  const releasable = (outcome.status === "refused" || outcome.status === "blocked") && headsPositivelyUnbegun(ctx);
  if (!releasable) return outcome;
  if (ctx.keeper !== null) { await ctx.keeper.stop().catch(() => undefined); ctx.keeper = null; }
  const failures: string[] = [];
  for (const member of ctx.members) {
    if (member.session === null) continue;
    try {
      await member.session.release();
    } catch (error) {
      failures.push(at(member, (error as Error).message));
    }
    member.session = null;
  }
  if (failures.length === 0) return outcome;
  return { ...outcome, detail: outcome.detail + "; rollback leases were not released: " + failures.join("; ") };
}

// ---------------------------------------------------------------------------
// Routing under the barrier
// ---------------------------------------------------------------------------

function newMember(ctx: Context, index: number, row: CutoverSetActivationCheckpointMember): Member {
  const selectionRow = ctx.activation!.selection.members[index]!;
  const checkpointRow = ctx.checkpoint?.members[index] ?? null;
  return {
    index, physicalProjectId: row.physicalProjectId, generationId: row.generationId, sourceSelectionSha256: ctx.activation!.checkpoint.manifest.members[index]!.sourceSelectionSha256,
    activationRow: row, selectionRow: { epochId: selectionRow.epochId, attemptId: selectionRow.attemptId, witnessChecksumSha256: selectionRow.witnessChecksumSha256 },
    remoteProjectId: checkpointRow?.remoteProjectId ?? row.remoteProjectId, canonicalPath: join(lcmHomeDir(ctx.homeDir), "projects", row.physicalProjectId, "db.sqlite"),
    identity: null, manifest: null, snapshot: null, authority: null,
    evidenceSha256: deriveRollbackProjectEvidenceSha256({ generationId: row.generationId, publicationId: ctx.setId, localProjectId: row.physicalProjectId, remoteProjectId: row.remoteProjectId }),
    head: checkpointRow === null ? null : { manifestRevision: checkpointRow.manifestRevision, manifestChecksumSha256: checkpointRow.manifestChecksumSha256 },
    session: null, mode: null, built: null, exportEvidence: null, terminalEvidenceSha256: null,
    install: ctx.rollback?.installs.get(row.generationId) ?? null,
    frozen: ctx.selection?.members[index] ?? null, reason: null, detail: null,
  };
}

async function runUnderBarrier(ctx: Context): Promise<CutoverSetRollbackResult> {
  try {
    ctx.machineId = ctx.deps.machineId(ctx.homeDir);
  } catch (error) {
    if (!(error instanceof MachineIdentityFileError)) throw error;
    return refused(ctx, "records", "machine-identity-unregistered", error.message).exit;
  }
  const activation = ctx.deps.readActivationRecords({ homeDir: ctx.homeDir, setId: ctx.originalSetId });
  if (activation.state === "unresolvable") return refused(ctx, "records", "activation-unresolvable", "the set activation records are unresolvable: " + activation.reason).exit;
  if (activation.state === "authoritatively-absent" || activation.selection === null) {
    return refused(ctx, "records", "activation-not-selected", "no frozen activation selection is stored for set " + ctx.originalSetId).exit;
  }
  ctx.activation = { ...activation, selection: activation.selection };
  ctx.manifest = { ...activation.checkpoint.manifest, setId: ctx.setId };
  const rollback = ctx.deps.readRollbackRecords({ homeDir: ctx.homeDir, originalSetId: ctx.originalSetId });
  if (rollback.state === "unresolvable") {
    ctx.effectBegun = true;
    return interrupted(ctx, "records", "state-unresolvable", "the set rollback records are unresolvable: " + rollback.reason).exit;
  }
  ctx.rollback = rollback.state === "resolved" ? rollback : null;
  ctx.checkpoint = ctx.rollback?.checkpoint ?? null;
  ctx.selection = ctx.rollback?.selection ?? null;
  ctx.effectBegun = ctx.checkpoint !== null;
  if (ctx.checkpoint !== null && (
    ctx.checkpoint.originalCheckpointSha256 !== activation.checkpoint.checksumSha256
    || ctx.checkpoint.originalSelectionSha256 !== activation.selection.checksumSha256
    || backendCutoverSetManifestSha256(ctx.checkpoint.manifest) !== backendCutoverSetManifestSha256(ctx.manifest)
  )) {
    return interrupted(ctx, "records", "evidence-conflict", "the rollback checkpoint does not descend from the stored activation records").exit;
  }
  ctx.members = activation.checkpoint.members.map((row, index) => newMember(ctx, index, row));
  const capacity = backendCutoverSetRollbackJournalCapacity(cutoverSetMaintenanceEntry(ctx.manifest).cutoverSet, ctx.originalSetId);
  if (capacity.worstCaseBytes > capacity.limitBytes) {
    return refused(ctx, "records", "cutover-set-too-large", "the rollback hold journal could reach " + capacity.worstCaseBytes
      + " bytes with its selection; the readable limit is " + capacity.limitBytes).exit;
  }
  let v3: BackendMaintenanceJournal | null;
  let v2: BackendPublicationJournal | null = null;
  try {
    v3 = ctx.deps.readMaintenanceJournal(ctx.homeDir);
    if (v3 === null) v2 = ctx.deps.readPublicationJournal(ctx.homeDir);
  } catch (error) {
    return refused(ctx, "slot", "activation-unresolvable", "a backend journal could not be read: " + (error as Error).message).exit;
  }
  if (v3 !== null) {
    const own = v3.cutoverSet !== undefined && v3.generationId === ctx.setId;
    if (!own) {
      return refused(ctx, "slot", v3.generationId === ctx.originalSetId ? "activation-not-completed" : "maintenance-held-by-other",
        "the maintenance journal is held for " + v3.generationId + " at phase " + v3.phase).exit;
    }
    if (ctx.checkpoint === null) return interrupted(ctx, "slot", "state-unresolvable", "the rollback hold exists but no rollback checkpoint is stored").exit;
    if (v3.sourceBackend !== "postgresql" || backendCutoverSetManifestSha256(v3.cutoverSet!.manifest) !== backendCutoverSetManifestSha256(ctx.manifest)) {
      return interrupted(ctx, "slot", "journal-unexpected", "the rollback hold is not the postgresql-origin hold of the checkpointed manifest").exit;
    }
    switch (v3.phase) {
      case "maintenance-aborted":
        return interrupted(ctx, "slot", "hold-aborted", "the rollback hold was aborted; its checkpoint, sources and candidates are preserved and nothing restarts automatically").exit;
      case "maintenance-held":
        ctx.resumedFrom = ctx.selection === null ? "held" : "selection-frozen";
        return preSelection(ctx, v3);
      default:
        return postSelection(ctx, v3, null);
    }
  }
  if (v2 !== null && v2.publicationId === ctx.setId) {
    if (ctx.selection === null) return interrupted(ctx, "slot", "state-unresolvable", "a rollback publication exists for this set but no frozen rollback selection is stored").exit;
    return postSelection(ctx, null, v2);
  }
  if (v2 !== null && v2.publicationId === ctx.originalSetId) {
    if (v2.phase !== "completed" || v2.targetBackend !== "postgresql") {
      return refused(ctx, "slot", "activation-not-completed", "the set activation publication is at phase " + v2.phase + " targeting " + String(v2.targetBackend)).exit;
    }
    if (ctx.selection !== null) return interrupted(ctx, "slot", "journal-unexpected", "a frozen rollback selection exists while the activation publication is still live").exit;
    if (ctx.checkpoint !== null && ctx.checkpoint.activationJournalChecksumSha256 !== v2.checksumSha256) {
      return interrupted(ctx, "slot", "evidence-conflict", "the live activation publication is not the one the rollback checkpoint recorded").exit;
    }
    ctx.resumedFrom = ctx.checkpoint === null ? "fresh" : "before-hold";
    return preHold(ctx, v2);
  }
  // The slot is empty or belongs to another publication.
  if (ctx.selection !== null) return settledFromRecords(ctx, v2);
  if (ctx.checkpoint !== null) {
    return interrupted(ctx, "slot", "hold-gone", "the rollback hold is gone before its selection was frozen; the slot holds "
      + (v2 === null ? "nothing" : "publication " + v2.publicationId)).exit;
  }
  return refused(ctx, "slot", "activation-not-live", v2 === null ? "no publication journal is live for this set" : "the journal slot holds publication " + v2.publicationId + " at phase " + v2.phase).exit;
}


// ---------------------------------------------------------------------------
// Members: durable state, evidence and identity (D2, C4, C10)
// ---------------------------------------------------------------------------

type ManifestExpectation = "pre-hold" | "held" | "frozen";

function isManifestAbsent(error: unknown): boolean {
  return error instanceof MigrationProtocolError && error.reason === "unexpected-state" && /head is absent/u.test(error.message);
}

function readMemberManifest(ctx: Context, member: Member): Step<MigrationManifest> {
  try {
    member.manifest = ctx.deps.manifestStore.read(member.generationId);
    return ok(member.manifest);
  } catch (error) {
    if (isManifestAbsent(error)) return refused(ctx, "members", "member-not-active", at(member, "no migration manifest exists"));
    if (error instanceof MigrationProtocolError) return refused(ctx, "members", "member-not-active", at(member, "the manifest cannot be read: " + error.message));
    throw error;
  }
}

/** The pending or completed publish-rollback effect id of a member: its terminal evidence is the rollback witness. */
function publishEffectId(witnessChecksumSha256: string): string {
  return PUBLISH_EFFECT_PREFIX + witnessChecksumSha256;
}

/**
 * The manifest phases a member may be at for each expectation: before the
 * hold, active (or activating with this set's pending publish-activation to
 * settle); under the hold, active, prepare-rollback pending, rolling-back
 * with or without a pending publish-rollback; with a frozen selection,
 * rolling-back with the frozen witness's pending publish-rollback, or
 * rolled-back.
 */
function classifyMemberManifest(ctx: Context, member: Member, expectation: ManifestExpectation, manifest: MigrationManifest): Exit | null {
  const pending = manifest.pendingEffect;
  const activationPublish = "publish-activation-" + member.selectionRow.epochId;
  if (expectation === "pre-hold") {
    if (manifest.phase === "active" && pending === null) return null;
    if (manifest.phase === "activating" && pending?.kind === "publish-activation" && pending.effectId === activationPublish) return null;
    return refused(ctx, "members", "member-not-active", at(member, "the manifest is at phase " + manifest.phase + (pending === null ? "" : " with pending " + pending.kind)));
  }
  if (manifest.phase === "active" && pending === null) return expectation === "held" ? null : interrupted(ctx, "members", "state-unresolvable", at(member, "the manifest is active under a frozen selection"));
  if (manifest.phase === "active" && pending?.kind === "prepare-rollback") return expectation === "held" ? null : interrupted(ctx, "members", "state-unresolvable", at(member, "prepare-rollback is pending under a frozen selection"));
  if (manifest.phase === "rolling-back" && pending === null) return expectation === "held" ? null : interrupted(ctx, "members", "state-unresolvable", at(member, "no publish-rollback is pending under a frozen selection"));
  if (manifest.phase === "rolling-back" && pending?.kind === "publish-rollback") {
    if (expectation === "frozen" && pending.effectId !== publishEffectId(member.frozen!.witnessChecksumSha256)) {
      return interrupted(ctx, "members", "evidence-conflict", at(member, "the pending publish-rollback is not the frozen witness's"));
    }
    return null;
  }
  if (manifest.phase === "rolled-back") {
    if (expectation === "frozen" && manifest.rollbackLineage.mode === member.frozen!.mode) return null;
    return interrupted(ctx, "members", "state-unresolvable", at(member, "the manifest is already rolled back" + (expectation === "frozen" ? " in mode " + String(manifest.rollbackLineage.mode) : " under an unfrozen rollback")));
  }
  return interrupted(ctx, "members", "state-unresolvable", at(member, "the manifest is at phase " + manifest.phase + (pending === null ? "" : " with pending " + pending.kind) + " under a rollback commitment"));
}

/** The member's activation link must name the original set publication and its artifact. */
function checkMemberLink(ctx: Context, member: Member): Exit | null {
  const link = ctx.deps.readLink({ homeDir: ctx.homeDir, generationId: member.generationId });
  if (link.state === "unresolvable") return refused(ctx, "members", "member-link-mismatch", at(member, "the generation link is unresolvable: " + link.detail));
  if (link.state === "authoritatively-absent") return refused(ctx, "members", "member-link-mismatch", at(member, "no generation link records the set publication"));
  if (link.link.publicationId !== ctx.originalSetId || link.link.identityDigest !== ctx.activation!.selection.identityDigest
    || link.link.epochManifestRevision !== member.activationRow.epochManifestRevision
    || link.link.epochManifestChecksumSha256 !== member.activationRow.epochManifestChecksumSha256) {
    return refused(ctx, "members", "member-link-mismatch", at(member, "the generation link does not name the set activation and its frozen manifest revision"));
  }
  return null;
}

/** The activation epoch, attempt and witness the set selection froze for the member (the authority the rollback unwinds). */
async function resolveMemberAuthority(ctx: Context, member: Member): Promise<Exit | null> {
  let authority: RollbackAuthoritativeContext | null;
  try {
    authority = await ctx.deps.resolveAuthoritativeContext({
      homeDir: ctx.homeDir, generationId: member.generationId, epochId: member.selectionRow.epochId,
      attemptId: member.selectionRow.attemptId, witnessChecksumSha256: member.selectionRow.witnessChecksumSha256,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "MigrationActivationEvidenceRefusalError") {
      return refused(ctx, "members", "member-evidence-missing", at(member, error.message));
    }
    throw error;
  }
  if (authority === null || authority.witness === null || authority.witness.kind !== "activation") {
    return refused(ctx, "members", "member-evidence-missing", at(member, "the frozen activation epoch, attempt and witness are not stored"));
  }
  member.authority = authority;
  return null;
}

/** The preserved snapshot, authenticated against the forward held binding the activation checkpoint froze (C10/C4). */
async function inspectMemberSnapshot(ctx: Context, member: Member): Promise<Exit | null> {
  let snapshot: AuthenticatedSqliteMigrationSnapshot;
  try {
    snapshot = await ctx.deps.inspectSnapshot(member.generationId, ctx.homeDir);
  } catch (error) {
    return refused(ctx, "members", "member-snapshot-mismatch", at(member, "the preserved snapshot could not be authenticated: " + (error as Error).message));
  }
  const artifact = snapshot.artifact;
  if (artifact.authority.physicalProjectId !== member.physicalProjectId || artifact.sourceSelectionSha256 !== member.sourceSelectionSha256
    || artifact.maintenanceChecksumSha256 !== member.activationRow.heldMemberChecksumSha256
    || artifact.authority.machineIdentity.machineId !== ctx.machineId || artifact.authority.projectDbPath !== member.canonicalPath) {
    return refused(ctx, "members", "member-snapshot-mismatch", at(member, "the preserved snapshot does not carry this member's forward held binding, project, machine and database path"));
  }
  const row = ctx.checkpoint?.members[member.index] ?? null;
  if (row !== null && (row.snapshotChecksumSha256 !== snapshot.checksumSha256 || row.queueEvidenceSha256 !== artifact.queueEvidenceSha256
    || row.queueCutoff !== snapshot.receiptReference.queueCutoff || row.sourceByteWitnessSha256 !== artifact.sourceByteWitnessSha256)) {
    return interrupted(ctx, "members", "evidence-conflict", at(member, "the preserved snapshot differs from the checkpointed one"));
  }
  member.snapshot = snapshot;
  return null;
}

/** The project map must bind exactly the members to their activation remotes; no other remote binding may exist (D2). */
function checkProjectCoverage(ctx: Context, map: ProjectMap): Exit | null {
  const bound = Object.entries(map).filter(([, entry]) => entry.remoteProjectId !== undefined).map(([hash]) => hash).sort();
  const expected = ctx.members.map((member) => member.physicalProjectId).sort();
  if (bound.length !== expected.length || bound.some((hash, index) => hash !== expected[index])) {
    return refused(ctx, "members", "project-coverage-drift", "the remotely bound projects are not exactly the set's members: " + bound.join(", "));
  }
  for (const member of ctx.members) {
    const entry = map[member.physicalProjectId]!;
    if (entry.remoteProjectId !== member.activationRow.remoteProjectId) {
      return refused(ctx, "members", "project-coverage-drift", at(member, "the project map binds another destination project"));
    }
    member.remoteProjectId = entry.remoteProjectId;
    member.identity = ctx.deps.resolveIdentity(ctx.storage!, { id: member.physicalProjectId, canonical: entry.canonical, remoteProjectId: entry.remoteProjectId }, ctx.homeDir, entry.canonical);
  }
  return null;
}

/** The project map as the rollback reads it: live before the checkpoint, the sealed reverse source after it. */
function projectMapForRollback(ctx: Context): ProjectMap {
  if (ctx.artifact !== null && ctx.artifact.source.projectMap.presence === "present") {
    return parseProjectMap(new TextDecoder("utf-8", { fatal: true }).decode(ctx.artifact.source.projectMap.content));
  }
  return ctx.deps.readProjectMap(ctx.homeDir, ctx.token);
}

/** The storage configuration: live before the checkpoint, the sealed reverse source after it; must select postgresql. */
async function resolveStorage(ctx: Context): Promise<Exit | null> {
  if (ctx.checkpoint !== null) {
    try {
      ctx.storage = await storageForCheckpoint(ctx, ctx.checkpoint);
    } catch (error) {
      if (error instanceof BackendPublicationJournalError) return interrupted(ctx, "artifact", "artifact-unresolvable", error.message);
      throw error;
    }
    return null;
  }
  const storage = ctx.deps.readStorageConfig(ctx.homeDir);
  if (storage.backend !== "postgresql") return refused(ctx, "target", "activation-not-completed", "the configuration selects " + storage.backend + ", not postgresql");
  ctx.storage = storage;
  return null;
}

/** Every member's durable state, link, authority, snapshot, map binding and identity, in manifest order. */
async function resolveMembers(ctx: Context, expectation: ManifestExpectation): Promise<Exit | null> {
  const storage = await resolveStorage(ctx);
  if (storage !== null) return storage;
  if (ctx.checkpoint !== null) {
    const artifact = readCheckpointedArtifact(ctx);
    if (artifact !== null) return artifact;
  }
  const coverage = checkProjectCoverage(ctx, projectMapForRollback(ctx));
  if (coverage !== null) return coverage;
  for (const member of ctx.members) {
    const read = readMemberManifest(ctx, member);
    if (isExit(read)) return read;
    const classified = classifyMemberManifest(ctx, member, expectation, read.value);
    if (classified !== null) return classified;
    const link = checkMemberLink(ctx, member);
    if (link !== null) return link;
    const authority = await resolveMemberAuthority(ctx, member);
    if (authority !== null) return authority;
    const snapshot = await inspectMemberSnapshot(ctx, member);
    if (snapshot !== null) return snapshot;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settlement of pending activation effects (C5) and the commitment (D3)
// ---------------------------------------------------------------------------

function artifactCoversMembers(ctx: Context, artifact: ActivationArtifactRecoveryMaterial, publicationId: string, evidence: (member: Member) => string): boolean {
  return artifact.publicationId === publicationId
    && artifact.projects.length === ctx.members.length
    && artifact.projects.every((row, index) => {
      const member = ctx.members[index]!;
      return row.localProjectId === member.physicalProjectId && row.remoteProjectId === member.activationRow.remoteProjectId && row.evidenceSha256 === evidence(member);
    });
}

function readCheckpointedArtifact(ctx: Context): Exit | null {
  let artifact: ActivationArtifactRecoveryMaterial | null;
  try {
    artifact = ctx.deps.readArtifact({ homeDir: ctx.homeDir, identityDigest: ctx.checkpoint!.identityDigest });
  } catch (error) {
    return interrupted(ctx, "artifact", "artifact-unresolvable", (error as Error).message);
  }
  if (artifact === null) return interrupted(ctx, "artifact", "artifact-unresolvable", "the checkpointed reverse artifact is absent");
  if (!artifactCoversMembers(ctx, artifact, ctx.setId, (member) => member.evidenceSha256)) {
    return interrupted(ctx, "artifact", "artifact-mismatch", "the checkpointed reverse artifact does not cover exactly the set's members");
  }
  ctx.artifact = artifact;
  return null;
}

/** The activation's own artifact, read while its completed publication is still live. */
function readActivationArtifactForSet(ctx: Context): Exit | null {
  let artifact: ActivationArtifactRecoveryMaterial | null;
  try {
    artifact = ctx.deps.readArtifact({ homeDir: ctx.homeDir, identityDigest: ctx.activation!.selection.identityDigest });
  } catch (error) {
    return refused(ctx, "members", "activation-unresolvable", "the activation artifact is unresolvable: " + (error as Error).message);
  }
  if (artifact === null || !artifactCoversMembers(ctx, artifact, ctx.originalSetId, (member) => member.activationRow.copyBindingSha256)) {
    return refused(ctx, "members", "activation-unresolvable", "the activation artifact is absent or does not cover exactly the set's members");
  }
  ctx.activationArtifact = artifact;
  return null;
}

/**
 * C5: finish the local bookkeeping of a member whose publish-activation is
 * still pending under the completed activation publication, exactly as the
 * activation would have: the post-publication map witness, the deterministic
 * activation report and the effect's completion. No session, no health.
 */
function settleActivationMember(ctx: Context, member: Member): Exit | null {
  const manifest = member.manifest!;
  if (manifest.phase !== "activating") return null;
  const report = ctx.deps.readVerificationReport(member.generationId, member.activationRow.verificationReportSha256);
  const bindings = ctx.deps.resolveWitnessBindings({ homeDir: ctx.homeDir, generationId: member.generationId });
  if (bindings.state !== "resolved" || !bindings.selections.some((selection) => selection.kind === "activation" && selection.publicationId === ctx.originalSetId)) {
    return refused(ctx, "settlement", "member-evidence-missing", at(member, "the activation selection binding is not resolved"));
  }
  const post = ctx.deps.computeProjectMapWitness({
    homeDir: ctx.homeDir, localProjectId: member.physicalProjectId, remoteProjectId: member.remoteProjectId, mode: "post-publication", publicationLockToken: ctx.token,
  });
  if (post !== report.body.projectMapWitnessSha256) {
    return refused(ctx, "settlement", "project-coverage-drift", at(member, "the post-publication project map witness differs from the verified witness"));
  }
  const pending = manifest.pendingEffect!;
  const persisted = ctx.deps.persistActivationReport({
    homeDir: ctx.homeDir, generationId: member.generationId,
    report: createMigrationActivationReport({
      generationId: member.generationId, epochId: member.selectionRow.epochId, attemptId: member.selectionRow.attemptId,
      witnessChecksumSha256: member.selectionRow.witnessChecksumSha256, publicationId: ctx.originalSetId, identityDigest: ctx.activation!.selection.identityDigest,
      manifestRevisionAtComplete: manifest.revision, postPublicationProjectMapWitnessSha256: post, createdAt: pending.startedAt,
    }),
  });
  crash(ctx, "after-settle-report:" + member.generationId);
  member.manifest = ctx.deps.manifestStore.update(member.generationId, manifest.checksumSha256, (head) =>
    completeMigrationEffect(head, { effectId: pending.effectId, completedAt: ctx.now().toISOString(), report: migrationActivationReportReference(persisted.report) }));
  crash(ctx, "after-settle-complete:" + member.generationId);
  return null;
}

/** A live, cheap reachability and identity proof against the one target before anything durable (C9). */
async function probeTarget(ctx: Context): Promise<Exit | null> {
  try {
    ctx.runtime = ctx.deps.createRuntime(connectionSettings(ctx.storage!));
    await ctx.deps.verifyRuntimeSchema(ctx.runtime, { expectedOwner: ctx.storage!.postgresql.migrationRole, signal: ctx.input.signal });
    for (const member of ctx.members) {
      const live = await ctx.deps.sessionDependencies.captureDestinationIdentity(ctx.runtime, member.remoteProjectId, ctx.input.signal);
      const epoch = member.authority!.epoch.destinationIdentity;
      if (live.sealedWitnessSha256 !== epoch.sealedWitnessSha256 || live.systemIdentifier !== epoch.systemIdentifier) {
        return refused(ctx, "target", "target-identity-drift", at(member, "the live destination identity does not match the activation epoch"));
      }
    }
  } catch (error) {
    return refused(ctx, "target", "target-unreachable", (error as Error).message);
  }
  ctx.guard = ctx.runtime.backendPublicationGuard();
  ctx.coordinator = ctx.deps.createCoordinator({ homeDir: ctx.homeDir, guard: ctx.guard, machineId: ctx.machineId });
  return null;
}

/** The fresh path (and the crash before the hold): members, settlement, artifact, checkpoint, hold. */
async function preHold(ctx: Context, activationJournal: BackendPublicationJournal): Promise<CutoverSetRollbackResult> {
  const members = await resolveMembers(ctx, "pre-hold");
  if (members !== null) return members.exit;
  const activationArtifact = readActivationArtifactForSet(ctx);
  if (activationArtifact !== null) return activationArtifact.exit;
  const covered = activationJournal.projects.length === ctx.activationArtifact!.projects.length && activationJournal.projects.every((project, index) => {
    const row = ctx.activationArtifact!.projects[index]!;
    return project.localProjectId === row.localProjectId && project.remoteProjectId === row.remoteProjectId && project.evidenceSha256 === row.evidenceSha256;
  });
  if (!covered) return refused(ctx, "slot", "activation-not-completed", "the completed activation publication does not cover exactly the set artifact's projects").exit;
  for (const member of ctx.members) {
    const settled = settleActivationMember(ctx, member);
    if (settled !== null) return settled.exit;
    member.head = { manifestRevision: member.manifest!.revision, manifestChecksumSha256: member.manifest!.checksumSha256 };
    const row = ctx.checkpoint?.members[member.index] ?? null;
    if (row !== null && (row.manifestRevision !== member.head.manifestRevision || row.manifestChecksumSha256 !== member.head.manifestChecksumSha256)) {
      return interrupted(ctx, "settlement", "evidence-conflict", at(member, "the settled active head is not the checkpointed one")).exit;
    }
  }
  const target = await probeTarget(ctx);
  if (target !== null) return target.exit;
  if (ctx.input.signal?.aborted === true) return refused(ctx, "artifact", "cancelled", "the rollback was cancelled before its commitment").exit;
  if (ctx.checkpoint === null) {
    const fact = await ctx.deps.readOperabilityFact({ homeDir: ctx.homeDir, lockToken: ctx.token });
    if (fact.state !== "present") {
      return refused(ctx, "slot", "activation-not-completed", "the operability fact is " + fact.state + (fact.state === "unresolvable" ? ": " + fact.reason : "")).exit;
    }
    const bindings = ctx.members.map((member) => ({ localProjectId: member.physicalProjectId, remoteProjectId: member.remoteProjectId, evidenceSha256: member.evidenceSha256 }));
    const composed = ctx.deps.composeMaterial({ homeDir: ctx.homeDir, targetBackend: "sqlite", bindings });
    const identityDigest = computeActivationArtifactIdentityDigest({ source: composed.material.source, target: composed.material.target, projects: bindings });
    let existing: ActivationArtifactRecoveryMaterial | null;
    try {
      existing = ctx.deps.readArtifact({ homeDir: ctx.homeDir, identityDigest });
    } catch (error) {
      return refused(ctx, "artifact", "activation-unresolvable", (error as Error).message).exit;
    }
    if (existing !== null && !artifactCoversMembers(ctx, existing, ctx.setId, (member) => member.evidenceSha256)) {
      return refused(ctx, "artifact", "activation-unresolvable", "an artifact under the recomputed identity digest was sealed under another publication").exit;
    }
    ctx.artifact = existing ?? ctx.deps.publishArtifact({
      homeDir: ctx.homeDir,
      material: { version: 1, publicationId: ctx.setId, source: composed.material.source, target: composed.material.target, projects: bindings },
    }).material;
    crash(ctx, "after-artifact");
    const checkpoint = createCutoverSetRollbackCheckpoint({
      originalSetId: ctx.originalSetId, setId: ctx.setId, manifest: ctx.manifest!, publicationId: ctx.setId,
      originalCheckpointSha256: ctx.activation!.checkpoint.checksumSha256, originalSelectionSha256: ctx.activation!.selection.checksumSha256,
      activationIdentityDigest: ctx.activation!.selection.identityDigest, activationJournalChecksumSha256: activationJournal.checksumSha256,
      operabilityFactValueSha256: fact.valueSha256, identityDigest,
      members: ctx.members.map((member) => ({
        physicalProjectId: member.physicalProjectId, generationId: member.generationId, remoteProjectId: member.remoteProjectId,
        heldMemberChecksumSha256: member.activationRow.heldMemberChecksumSha256, snapshotChecksumSha256: member.snapshot!.checksumSha256,
        sourceSelectionSha256: member.sourceSelectionSha256, queueEvidenceSha256: member.snapshot!.artifact.queueEvidenceSha256,
        queueCutoff: member.snapshot!.receiptReference.queueCutoff, sourceByteWitnessSha256: member.snapshot!.artifact.sourceByteWitnessSha256,
        epochId: member.selectionRow.epochId, attemptId: member.selectionRow.attemptId, activationWitnessChecksumSha256: member.selectionRow.witnessChecksumSha256,
        manifestRevision: member.head!.manifestRevision, manifestChecksumSha256: member.head!.manifestChecksumSha256, evidenceSha256: member.evidenceSha256,
      })),
    });
    try {
      ctx.deps.recordCheckpoint({ homeDir: ctx.homeDir, checkpoint });
    } catch (error) {
      return refused(ctx, "checkpoint", "activation-unresolvable", "the rollback checkpoint could not be recorded: " + (error as Error).message).exit;
    }
    ctx.checkpoint = checkpoint;
    ctx.effectBegun = true;
    crash(ctx, "after-checkpoint");
  }
  let held: BackendMaintenanceJournal;
  try {
    held = await ctx.coordinator!.enterMaintenance({ ...cutoverSetMaintenanceEntry(ctx.manifest!), sourceBackend: "postgresql", now: ctx.now() }, ctx.token);
  } catch (error) {
    if (error instanceof BackendPublicationJournalError) return interrupted(ctx, "hold", "journal-unexpected", "the rollback hold could not be entered: " + error.message).exit;
    throw error;
  }
  crash(ctx, "after-hold");
  return preSelection(ctx, held, true);
}


// ---------------------------------------------------------------------------
// Sessions and the one set-wide renewal keeper (D4, C8)
// ---------------------------------------------------------------------------

/**
 * One bounded, abortable keeper for the whole set: every open member lease
 * is renewed serially on a fixed cadence while any member's long read runs,
 * and on demand around each costly step. The first renewal failure is
 * recorded, aborts the keeper's signal (which every member session received
 * as its own, so a read in flight stops) and is rethrown by the next sweep or
 * assertion. Renewals never overlap. With a single-connection pool the
 * periodic renewal is inert (the pool could only wait for the read in
 * flight), as for the single-generation session; explicit sweeps still run.
 */
function startSetKeeper(ctx: Context): SetKeeper {
  const controller = new AbortController();
  const external = ctx.input.signal;
  const onExternalAbort = (): void => controller.abort(external?.reason);
  if (external?.aborted) controller.abort(external.reason);
  else external?.addEventListener("abort", onExternalAbort, { once: true });
  let failure: unknown;
  let pending: Promise<void> | null = null;
  const sweepOnce = async (): Promise<void> => {
    for (const member of ctx.members) {
      if (member.session === null) continue;
      await member.session.renew();
    }
  };
  const sweep = (): Promise<void> => {
    if (pending !== null) return pending;
    if (failure !== undefined) return Promise.reject(failure);
    pending = sweepOnce().then(
      () => { pending = null; },
      (error: unknown) => {
        pending = null;
        failure = error;
        clearInterval(timer);
        controller.abort(error);
        throw error;
      },
    );
    return pending;
  };
  const periodic = ctx.storage!.postgresql.poolMax > 1;
  const timer = setInterval(() => { if (periodic) void sweep().catch(() => undefined); }, ctx.deps.renewalIntervalMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    sweep,
    assertFenced: () => { if (failure !== undefined) throw failure; },
    stop: async () => {
      clearInterval(timer);
      external?.removeEventListener("abort", onExternalAbort);
      if (pending !== null) await pending.catch(() => undefined);
    },
  };
}

function memberTarget(ctx: Context, member: Member): RollbackSessionTarget {
  return {
    settings: connectionSettings(ctx.storage!), expectedOwner: ctx.storage!.postgresql.migrationRole, expectedIdentity: member.identity!,
    localProjectId: member.physicalProjectId, remoteProjectId: member.remoteProjectId, machineId: ctx.machineId,
  };
}

/** Open every member's fenced session in manifest order (lease, then set quiescence or recovery admission); the keeper spans them. */
async function openSessions(ctx: Context, recovery: boolean): Promise<Exit | null> {
  if (ctx.keeper === null) ctx.keeper = startSetKeeper(ctx);
  for (const member of ctx.members) {
    if (member.session !== null || member.manifest!.phase === "rolled-back") continue;
    try {
      member.session = await ctx.deps.openMemberSession({
        homeDir: ctx.homeDir, lockToken: ctx.token, generationId: member.generationId, publicationId: ctx.setId, runtime: ctx.runtime!,
        scratchParent: ctx.scratchParent, signal: ctx.keeper.signal, ...(recovery ? { recovery: true as const } : {}),
      }, memberTarget(ctx, member), ctx.deps.sessionDependencies);
    } catch (error) {
      const failure = sessionFailure(error);
      return blocked(ctx, "sessions", member, failure.reason, failure.detail);
    }
  }
  return null;
}

/** Renew every lease now; a failure blocks the set at the current member. */
async function sweepLeases(ctx: Context, step: CutoverSetRollbackStep, member: Member): Promise<Exit | null> {
  try {
    await ctx.keeper!.sweep();
  } catch (error) {
    const failure = sessionFailure(error);
    return blocked(ctx, step, member, failure.reason === "lease-conflict" ? "lease-lost" : failure.reason, failure.detail);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pre-selection under the hold: cutoffs, classification, prepare, build,
// revalidation, install, freeze, selection (D4, D5, D6)
// ---------------------------------------------------------------------------

/**
 * C4: bind each member's rollback cutoff from its authenticated preserved
 * snapshot (the receipt's cutoff and the source byte witness the forward
 * capture bound, which the set binding carries as both its queue evidence and
 * its roster evidence), or adopt an already bound one exactly.
 */
function bindCutoffs(ctx: Context, held: BackendMaintenanceJournal): Step<BackendMaintenanceJournal> {
  let journal = held;
  for (const member of ctx.members) {
    const view = resolveBackendMaintenanceGenerationBinding(journal, member.generationId)!;
    const sentinel = backendMaintenanceQueueEvidenceSentinel({ generationId: member.generationId, sourceSelectionSha256: member.sourceSelectionSha256 });
    const artifact = member.snapshot!.artifact;
    const roster = [{ machineId: ctx.machineId, queueCutoff: member.snapshot!.receiptReference.queueCutoff, evidenceSha256: artifact.sourceByteWitnessSha256 }];
    if (view.queueEvidenceSha256 !== sentinel) {
      if (view.queueEvidenceSha256 !== artifact.sourceByteWitnessSha256 || canonicalJson(view.roster) !== canonicalJson(roster)) {
        return interrupted(ctx, "cutoffs", "evidence-conflict", at(member, "the bound rollback cutoff is not the preserved snapshot's"));
      }
      continue;
    }
    try {
      journal = rebindBackendMaintenanceCutoff({
        homeDir: ctx.homeDir, expectedChecksumSha256: view.checksumSha256, generationId: member.generationId,
        sourceSelectionSha256: member.sourceSelectionSha256, queueEvidenceSha256: artifact.sourceByteWitnessSha256, roster,
      }, ctx.token);
    } catch (error) {
      if (error instanceof BackendPublicationJournalError) return interrupted(ctx, "cutoffs", "journal-unexpected", at(member, error.message));
      throw error;
    }
    crash(ctx, "after-bind:" + member.generationId);
  }
  return ok(journal);
}

/** The pending publish-rollback's stored rollback witness: its mode is the member's mode, never inferred. */
function pendingWitnessMode(ctx: Context, member: Member): Step<"pre-write" | "post-write" | null> {
  const pending = member.manifest!.pendingEffect;
  if (pending?.kind !== "publish-rollback") return ok(null);
  const evidence = ctx.deps.readActivationEvidence({ homeDir: ctx.homeDir, generationId: member.generationId });
  const witness = evidence.state === "resolved"
    ? evidence.witnesses.find((candidate) => candidate.kind === "rollback" && candidate.checksumSha256 === pending.inputSha256) ?? null
    : null;
  if (witness === null) return interrupted(ctx, "classify", "evidence-unresolvable", at(member, "the pending publish-rollback has no stored rollback witness"));
  member.terminalEvidenceSha256 = pending.inputSha256;
  return ok(witness.rollbackMode!);
}

async function classifyMembers(ctx: Context): Promise<Exit | null> {
  for (const member of ctx.members) {
    if (ctx.input.signal?.aborted === true) return blocked(ctx, "classify", member, "cancelled", "the rollback was cancelled before the member's readback");
    const stored = pendingWitnessMode(ctx, member);
    if (isExit(stored)) return stored;
    let observation: RollbackEligibilityObservation;
    try {
      observation = await member.session!.captureReadback({ canonicalDeltaBaseline: member.authority!.attempt.canonicalDeltaBaseline });
    } catch (error) {
      const failure = sessionFailure(error);
      return blocked(ctx, "classify", member, failure.reason, failure.detail);
    }
    const decision = evaluateRollbackEligibility({ authoritativeContext: member.authority!, observation });
    if (decision.eligibility === "refused") return blocked(ctx, "classify", member, "not-eligible", decision.reason);
    if (stored.value !== null && stored.value !== decision.mode) {
      return blocked(ctx, "classify", member, "pending-evidence-drift", "the readback classifies " + decision.mode + " where the pending publish-rollback was sealed as " + stored.value);
    }
    member.mode = decision.mode;
    const swept = await sweepLeases(ctx, "classify", member);
    if (swept !== null) return swept;
  }
  crash(ctx, "after-classify");
  return null;
}

/** Steps 7 and 8 for one member: begin prepare-rollback with the deterministic input frozen in the checkpoint, then complete it. */
function prepareMember(ctx: Context, member: Member): Exit | null {
  let manifest = member.manifest!;
  if (manifest.phase !== "active") return null;
  const inputSha256 = deriveRollbackPrepareInputSha256({
    generationId: member.generationId, manifestRevision: member.head!.manifestRevision, manifestChecksumSha256: member.head!.manifestChecksumSha256,
    epochId: member.selectionRow.epochId, resourceType: POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE, resourceKey: POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
  });
  const effectId = PREPARE_EFFECT_PREFIX + inputSha256;
  try {
    if (manifest.pendingEffect === null) {
      if (manifest.revision !== member.head!.manifestRevision || manifest.checksumSha256 !== member.head!.manifestChecksumSha256) {
        return interrupted(ctx, "prepare", "evidence-conflict", at(member, "the active head is not the checkpointed one"));
      }
      manifest = ctx.deps.manifestStore.update(member.generationId, manifest.checksumSha256, (head) =>
        beginMigrationEffect(head, { effectId, kind: "prepare-rollback", inputSha256, startedAt: ctx.now().toISOString() }));
      crash(ctx, "after-prepare-begin:" + member.generationId);
    } else if (manifest.pendingEffect.kind !== "prepare-rollback" || manifest.pendingEffect.inputSha256 !== inputSha256) {
      return interrupted(ctx, "prepare", "evidence-conflict", at(member, "the pending prepare-rollback does not carry this rollback's deterministic input"));
    }
    manifest = ctx.deps.manifestStore.update(member.generationId, manifest.checksumSha256, (head) =>
      completeMigrationEffect(head, { effectId: manifest.pendingEffect!.effectId, completedAt: ctx.now().toISOString() }));
    crash(ctx, "after-prepare-complete:" + member.generationId);
  } catch (error) {
    if (error instanceof MigrationProtocolError) return interrupted(ctx, "prepare", "state-unresolvable", at(member, "prepare-rollback could not be driven: " + error.message));
    throw error;
  }
  member.manifest = manifest;
  return null;
}

function exportEvidenceSha256(evidence: Pick<RollbackExportSource, "canonicalDelta" | "censusVector">): string {
  return migrationWitnessSha256({ canonicalDelta: evidence.canonicalDelta, censusVector: evidence.censusVector });
}

function fileWitness(path: string): Readonly<{ sha256: string; size: string }> {
  const size = statSync(path, { bigint: true }).size;
  return { sha256: streamSha256(path, Number(size)), size: size.toString(10) };
}

/** An installation record authenticates when the canonical database still is the post-sidecar database it witnessed. */
function installRecordAuthenticates(member: Member): string | null {
  const record = member.install!;
  if (record.canonicalPath !== member.canonicalPath) return "the installation record names another canonical path";
  let witness: Readonly<{ sha256: string; size: string }>;
  try {
    witness = fileWitness(member.canonicalPath);
  } catch (error) {
    return "the canonical database cannot be read: " + (error as Error).message;
  }
  if (witness.sha256 !== record.database.sha256 || witness.size !== record.database.size) return "the canonical database is not the installed, sidecar-complete database the record witnessed";
  return null;
}

/** Step 9 for one member: build a fresh verified candidate from its fenced export (post-write) or its preserved snapshot (pre-write, C1). */
async function buildMember(ctx: Context, member: Member): Promise<Exit | null> {
  if (member.install !== null) {
    const failure = installRecordAuthenticates(member);
    if (failure !== null) return blocked(ctx, "build", member, "install-mismatch", failure);
    member.mode = member.install.mode;
    return null;
  }
  let stream: Awaited<ReturnType<typeof ctx.deps.createStream>>;
  let exportEvidence: Pick<RollbackExportSource, "canonicalDelta" | "censusVector"> | undefined;
  try {
    if (member.mode === "post-write") {
      const exported = await member.session!.openPortableSource();
      stream = exported.stream;
      exportEvidence = { canonicalDelta: exported.canonicalDelta, censusVector: exported.censusVector };
    } else {
      const preserved = ctx.deps.derivePreservedSource(member.snapshot!, member.identity!, ctx.homeDir);
      const expected = member.manifest!.source;
      const derived = preserved.sourceWitness;
      if (derived.identitySha256 !== expected.identitySha256 || derived.schemaSha256 !== expected.schemaSha256
        || derived.contentSha256 !== expected.contentSha256 || derived.capturedAt !== expected.capturedAt) {
        return blocked(ctx, "build", member, "preserved-source-mismatch", "the preserved snapshot's source witness is not the member manifest's verified source");
      }
      stream = await ctx.deps.createStream(await preserved.open({ scratchParent: ctx.scratchParent, signal: ctx.keeper!.signal }));
    }
  } catch (error) {
    const failure = sessionFailure(error);
    return blocked(ctx, "build", member, failure.reason === "target-unreachable" ? "build-failed" : failure.reason, failure.detail);
  }
  let outcome: RollbackGenerationOutcome;
  try {
    const revision = member.manifest!.revision;
    const ordinal = ctx.deps.highestBuildAttempt(ctx.homeDir, member.generationId, revision, MAX_ROLLBACK_GENERATION_BUILD_ATTEMPT_ENTRIES) + 1;
    outcome = await ctx.deps.buildGeneration({
      homeDir: ctx.homeDir, generationId: rollbackGenerationBuildBase(member.generationId) + "-rb" + String(revision) + "-" + String(ordinal),
      projectIdentity: { scope: "shared", projectId: member.remoteProjectId }, source: stream,
      ...(exportEvidence === undefined ? {} : { exportEvidence }), scratchParent: ctx.scratchParent, signal: ctx.keeper!.signal,
    });
  } catch (error) {
    await stream.close().catch(() => undefined);
    return blocked(ctx, "build", member, "build-failed", (error as Error).message);
  }
  if (outcome.state === "quarantined") return blocked(ctx, "build", member, "build-quarantined", outcome.reason + " (" + outcome.generationId + " is preserved read-only)");
  member.built = outcome;
  member.exportEvidence = exportEvidence ?? null;
  crash(ctx, "after-build:" + member.generationId);
  return null;
}

/** Step 10 for one member: a fresh readback must reproduce the mode (and, post-write, the export's delta and census), then the witness. */
async function revalidateMember(ctx: Context, member: Member): Promise<Exit | null> {
  const swept = await sweepLeases(ctx, "revalidate", member);
  if (swept !== null) return swept;
  let observation: RollbackEligibilityObservation;
  try {
    observation = await member.session!.captureReadback({ canonicalDeltaBaseline: member.authority!.attempt.canonicalDeltaBaseline, requireCensus: member.mode === "post-write" });
  } catch (error) {
    const failure = sessionFailure(error);
    return blocked(ctx, "revalidate", member, failure.reason, failure.detail);
  }
  const decision = evaluateRollbackEligibility({ authoritativeContext: member.authority!, observation });
  if (decision.eligibility === "refused") return blocked(ctx, "revalidate", member, "revalidation-drift", decision.reason);
  if (decision.mode !== member.mode) return blocked(ctx, "revalidate", member, "revalidation-drift", "revalidation observed mode " + decision.mode + " where classification observed " + String(member.mode));
  if (member.exportEvidence !== null) {
    if (migrationCanonicalDeltaChanged(member.exportEvidence.canonicalDelta, observation.postEpochDelta)) {
      return blocked(ctx, "revalidate", member, "revalidation-drift", "the destination changed between the export snapshot and revalidation (canonical delta differs)");
    }
    if (observation.postEpochCensus === null || !migrationCensusVectorsEqual(member.exportEvidence.censusVector, observation.postEpochCensus)) {
      return blocked(ctx, "revalidate", member, "revalidation-drift", "the destination changed between the export snapshot and revalidation (census differs)");
    }
  }
  const witness = createMigrationActivationWitness({
    kind: "rollback", epoch: member.authority!.epoch, attempt: member.authority!.attempt,
    postEpochDelta: observation.postEpochDelta, postEpochCensus: observation.postEpochCensus, rollbackMode: decision.mode,
  });
  const sealed = member.session!.computeRollbackTerminalEvidenceSha256({ epoch: member.authority!.epoch, attempt: member.authority!.attempt, observation, mode: decision.mode });
  if (sealed !== witness.checksumSha256) return interrupted(ctx, "revalidate", "evidence-conflict", at(member, "the session's terminal evidence is not the rollback witness minted from the same records"));
  const manifest = member.manifest!;
  if (manifest.pendingEffect !== null) {
    if (manifest.pendingEffect.inputSha256 !== witness.checksumSha256) {
      return blocked(ctx, "revalidate", member, "pending-evidence-drift", "the readback no longer reproduces the pending publish-rollback's terminal evidence");
    }
    member.terminalEvidenceSha256 = witness.checksumSha256;
    return null;
  }
  try {
    ctx.deps.recordActivationWitness({ homeDir: ctx.homeDir, generationId: member.generationId, witness });
    ctx.deps.recordWitnessBinding({
      homeDir: ctx.homeDir, generationId: member.generationId,
      binding: { kind: "rollback", epochId: member.selectionRow.epochId, attemptId: member.selectionRow.attemptId, manifestRevision: manifest.revision, witnessChecksumSha256: witness.checksumSha256 },
    });
    crash(ctx, "after-witness:" + member.generationId);
    member.manifest = ctx.deps.manifestStore.update(member.generationId, manifest.checksumSha256, (head) =>
      beginMigrationEffect(head, { effectId: publishEffectId(witness.checksumSha256), kind: "publish-rollback", inputSha256: witness.checksumSha256, startedAt: ctx.now().toISOString() }));
    crash(ctx, "after-publish-begin:" + member.generationId);
  } catch (error) {
    if (error instanceof Error && (error.name === "MigrationBindingConflictError" || error.name === "MigrationActivationEvidenceRefusalError" || error instanceof MigrationProtocolError)) {
      return interrupted(ctx, "revalidate", "evidence-conflict", at(member, error.message));
    }
    throw error;
  }
  member.terminalEvidenceSha256 = witness.checksumSha256;
  return null;
}

/** Step 11 for one member: install the verified candidate at the canonical path, materialize its sidecars, record the installation. */
function installMember(ctx: Context, member: Member): Exit | null {
  if (member.install !== null) return null;
  const built = member.built!;
  let outcome: ReturnType<typeof installRollbackGeneration>;
  let sidecars: ReturnType<typeof materializeRollbackSidecars>;
  try {
    outcome = ctx.deps.installGeneration({
      homeDir: ctx.homeDir, generationId: built.generationId, rollbackGenerationId: member.generationId, canonicalPath: member.canonicalPath, verifiedDatabasePath: built.databasePath,
    });
    crash(ctx, "after-install:" + member.generationId);
    sidecars = ctx.deps.materializeSidecars({ homeDir: ctx.homeDir, databasePath: outcome.canonicalPath, localProjectId: member.physicalProjectId, machineId: ctx.machineId });
    crash(ctx, "after-sidecars:" + member.generationId);
  } catch (error) {
    return blocked(ctx, "install", member, "install-failed", (error as Error).message);
  }
  const record = createCutoverSetRollbackInstallRecord({
    originalSetId: ctx.originalSetId, setId: ctx.setId, generationId: member.generationId, installedGenerationId: built.generationId, mode: member.mode!,
    buildWitnessChecksumSha256: built.witness.checksumSha256, buildManifestSha256: built.manifestSha256, buildContentSha256: built.contentSha256,
    exportEvidenceSha256: member.exportEvidence === null ? null : exportEvidenceSha256(member.exportEvidence), canonicalPath: outcome.canonicalPath,
    database: fileWitness(outcome.canonicalPath),
    preemption: outcome.preempted === null ? null : { path: outcome.preempted.path, beforeSha256: outcome.preempted.before.sha256, afterSha256: outcome.preempted.after.sha256 },
    sidecars: {
      sessionInstructionsMaterialized: sidecars.sessionInstructionsMaterialized, passiveEventsMaterialized: sidecars.passiveEventsMaterialized,
      passiveEventsPreservedPending: sidecars.passiveEventsPreservedPending, reconciledUpTo: sidecars.reconciledUpTo,
    },
  });
  try {
    ctx.deps.recordInstall({ homeDir: ctx.homeDir, record });
  } catch (error) {
    return interrupted(ctx, "install", "evidence-conflict", at(member, (error as Error).message));
  }
  member.install = record;
  crash(ctx, "after-install-record:" + member.generationId);
  return null;
}

function buildSelection(ctx: Context): BackendCutoverSetRollbackSelection {
  const body = {
    version: 1 as const, kind: "cutover-set-rollback-selection" as const, setId: ctx.setId, manifestSha256: backendCutoverSetManifestSha256(ctx.manifest!),
    publicationId: ctx.setId, originalSetId: ctx.originalSetId, originalSelectionSha256: ctx.activation!.selection.checksumSha256,
    checkpointSha256: ctx.checkpoint!.checksumSha256, identityDigest: ctx.checkpoint!.identityDigest, sourceBackend: "postgresql" as const, targetBackend: "sqlite" as const,
    members: ctx.members.map((member): BackendCutoverSetRollbackSelectionMember => ({
      physicalProjectId: member.physicalProjectId, generationId: member.generationId, remoteProjectId: member.remoteProjectId, mode: member.mode!,
      epochId: member.selectionRow.epochId, attemptId: member.selectionRow.attemptId, witnessChecksumSha256: member.terminalEvidenceSha256!,
      installEvidenceSha256: member.install!.checksumSha256,
    })),
  };
  return { ...body, checksumSha256: backendCutoverSetRollbackSelectionSha256(body) };
}

async function preSelection(ctx: Context, held: BackendMaintenanceJournal, membersResolved = false): Promise<CutoverSetRollbackResult> {
  if (!membersResolved) {
    const members = await resolveMembers(ctx, "held");
    if (members !== null) return members.exit;
    const target = await probeTarget(ctx);
    if (target !== null) return target.exit;
  }
  if (ctx.selection !== null) {
    // The crash between the frozen tuple and the journal's selection phases: adopt, never rebuild.
    const adopted = adoptFrozenSelection(ctx);
    if (adopted !== null) return adopted.exit;
    const selected = await stepSelection(ctx, held);
    if (isExit(selected)) return selected.exit;
    return finishAfterSelection(ctx, null);
  }
  const bound = bindCutoffs(ctx, held);
  if (isExit(bound)) return bound.exit;
  const sessions = await openSessions(ctx, false);
  if (sessions !== null) return sessions.exit;
  const classified = await classifyMembers(ctx);
  if (classified !== null) return classified.exit;
  for (const member of ctx.members) {
    const prepared = prepareMember(ctx, member);
    if (prepared !== null) return prepared.exit;
  }
  for (const member of ctx.members) {
    if (ctx.input.signal?.aborted === true) return blocked(ctx, "build", member, "cancelled", "the rollback was cancelled before the member's build").exit;
    const built = await buildMember(ctx, member);
    if (built !== null) return built.exit;
  }
  for (const member of ctx.members) {
    const revalidated = await revalidateMember(ctx, member);
    if (revalidated !== null) return revalidated.exit;
  }
  for (const member of ctx.members) {
    const swept = await sweepLeases(ctx, "install", member);
    if (swept !== null) return swept.exit;
    const installed = installMember(ctx, member);
    if (installed !== null) return installed.exit;
  }
  const selection = buildSelection(ctx);
  try {
    ctx.deps.recordSelection({ homeDir: ctx.homeDir, selection });
  } catch (error) {
    return interrupted(ctx, "freeze", "evidence-conflict", (error as Error).message).exit;
  }
  ctx.selection = selection;
  for (const member of ctx.members) member.frozen = selection.members[member.index]!;
  crash(ctx, "after-selection-frozen");
  const selected = await stepSelection(ctx, bound.value);
  if (isExit(selected)) return selected.exit;
  return finishAfterSelection(ctx, null);
}

/** Adopt the frozen tuple for every member: its mode, witness and authenticated installation record; nothing is rebuilt. */
function adoptFrozenSelection(ctx: Context): Exit | null {
  for (const member of ctx.members) {
    member.frozen = ctx.selection!.members[member.index]!;
    member.mode = member.frozen.mode;
    member.terminalEvidenceSha256 = member.frozen.witnessChecksumSha256;
    member.install = ctx.rollback!.installs.get(member.generationId)!;
    const classified = classifyMemberManifest(ctx, member, "frozen", member.manifest!);
    if (classified !== null) return classified;
    const failure = installRecordAuthenticates(member);
    if (failure !== null) return interrupted(ctx, "install", "readback-mismatch", at(member, failure));
  }
  return null;
}

async function stepSelection(ctx: Context, current: BackendMaintenanceJournal): Promise<Step<BackendMaintenanceJournal>> {
  let journal = current;
  const selection = ctx.selection!;
  try {
    if (journal.phase === "maintenance-held") {
      journal = await ctx.coordinator!.prepareMaintenanceSelection({
        expectedChecksumSha256: journal.checksumSha256, generationId: ctx.setId, targetBackend: "sqlite",
        terminalEvidenceSha256: selection.checksumSha256, cutoverSetSelection: selection,
      }, ctx.token);
      crash(ctx, "after-selection-prepared");
    }
    if (journal.phase === "selection-prepared") {
      if (journal.terminalEvidenceSha256 !== selection.checksumSha256) return interrupted(ctx, "selection", "journal-unexpected", "the prepared selection carries another tuple's checksum");
      journal = await ctx.coordinator!.completeMaintenanceSelection(
        { expectedChecksumSha256: journal.checksumSha256, generationId: ctx.setId, terminalEvidenceSha256: selection.checksumSha256 }, ctx.token,
      );
      crash(ctx, "after-selection-completed");
    }
  } catch (error) {
    if (error instanceof BackendPublicationJournalError) return interrupted(ctx, "selection", "journal-unexpected", error.message);
    throw error;
  }
  if (journal.phase !== "selection-completed" || journal.terminalEvidenceSha256 !== selection.checksumSha256) {
    return interrupted(ctx, "selection", "journal-unexpected", "the maintenance journal is at phase " + journal.phase + " and is not this rollback's completed selection");
  }
  return ok(journal);
}

/** Resume at or after the journal's selection phases, or from this rollback's own version-2 publication. */
async function postSelection(ctx: Context, v3: BackendMaintenanceJournal | null, ownV2: BackendPublicationJournal | null): Promise<CutoverSetRollbackResult> {
  if (ctx.selection === null) return interrupted(ctx, "selection", "state-unresolvable", "a selection exists for this rollback but no frozen rollback selection is stored").exit;
  if (v3 !== null && v3.cutoverSet!.selection?.checksumSha256 !== ctx.selection.checksumSha256) {
    return interrupted(ctx, "selection", "journal-unexpected", "the journal's selection tuple is not the frozen one").exit;
  }
  ctx.resumedFrom = ownV2 !== null ? "publication-journal" : v3!.phase === "selection-prepared" ? "selection-prepared" : "selection-completed";
  const members = await resolveMembers(ctx, "frozen");
  if (members !== null) return members.exit;
  const adopted = adoptFrozenSelection(ctx);
  if (adopted !== null) return adopted.exit;
  if (ctx.members.every((member) => member.manifest!.phase === "rolled-back") && (ownV2 === null || ownV2.phase === "completed")) {
    return settledFromRecords(ctx, ownV2);
  }
  const target = await probeTarget(ctx);
  if (target !== null) return target.exit;
  // A recovery session per pending member while the coordinator still drives the fence (or the selection is not yet completed).
  const needsSessions = ownV2 === null || FENCE_DRIVING_PHASES.has(ownV2.phase) || isAbortedUnsealed(ownV2);
  if (needsSessions) {
    const sessions = await openSessions(ctx, true);
    if (sessions !== null) return sessions.exit;
  }
  if (v3 !== null && v3.phase === "selection-prepared") {
    // F1: a prepared selection is completed only if a fresh readback still reproduces every frozen witness.
    for (const member of ctx.members) {
      if (member.manifest!.phase === "rolled-back") continue;
      const revalidated = await revalidateFrozenMember(ctx, member);
      if (revalidated !== null) return revalidated.exit;
    }
    const selected = await stepSelection(ctx, v3);
    if (isExit(selected)) return selected.exit;
  }
  return finishAfterSelection(ctx, ownV2);
}

/** A frozen member's fresh readback must reproduce its frozen witness exactly; a contradiction blocks and leaves everything as it is. */
async function revalidateFrozenMember(ctx: Context, member: Member): Promise<Exit | null> {
  let observation: RollbackEligibilityObservation;
  try {
    observation = await member.session!.captureReadback({ canonicalDeltaBaseline: member.authority!.attempt.canonicalDeltaBaseline, requireCensus: member.mode === "post-write" });
  } catch (error) {
    const failure = sessionFailure(error);
    return blocked(ctx, "revalidate", member, failure.reason, failure.detail);
  }
  const decision = evaluateRollbackEligibility({ authoritativeContext: member.authority!, observation });
  if (decision.eligibility === "refused") return blocked(ctx, "revalidate", member, "revalidation-drift", decision.reason);
  const evidence = member.session!.computeRollbackTerminalEvidenceSha256({ epoch: member.authority!.epoch, attempt: member.authority!.attempt, observation, mode: decision.mode });
  if (decision.mode !== member.mode || evidence !== member.terminalEvidenceSha256) {
    return blocked(ctx, "revalidate", member, "pending-evidence-drift", "the destination no longer reproduces the frozen witness; the prepared selection is not completed");
  }
  return null;
}


// ---------------------------------------------------------------------------
// Post-selection: member bindings, the one reverse publication, settlement (D6)
// ---------------------------------------------------------------------------

/** The coordinator phases at which the reverse publication still drives the members' fences on its forward path. */
const FENCE_DRIVING_PHASES: ReadonlySet<BackendPublicationJournal["phase"]> = new Set([
  "preparing", "prepared", "acquiring", "guarded", "map-publishing", "map-published", "config-publishing", "config-published", "releasing",
]);
const ABORT_PATH_PHASES: ReadonlySet<BackendPublicationJournal["phase"]> = new Set(["aborting", "config-restoring", "map-restoring", "abort-releasing"]);

/** The coordinator's missing-material exit: aborted straight from preparing, nothing sealed, published or fenced (E6). */
function isAbortedUnsealed(journal: BackendPublicationJournal): boolean {
  return journal.phase === "aborted" && journal.recoveryReference === null;
}

/** Whether a journal under the rollback's id is the reverse composition: postgresql -> sqlite over exactly the artifact's projects. */
function journalIsReverseComposition(ctx: Context, journal: BackendPublicationJournal): boolean {
  const rows = ctx.artifact!.projects;
  return journal.publicationId === ctx.setId && journal.sourceBackend === "postgresql" && journal.targetBackend === "sqlite"
    && journal.projects.length === rows.length
    && journal.projects.every((project, index) => {
      const row = rows[index]!;
      return project.localProjectId === row.localProjectId && project.remoteProjectId === row.remoteProjectId && project.evidenceSha256 === row.evidenceSha256;
    });
}

function fileSha256(file: BackendPublicationRecoveryFile): string | null {
  return file.presence === "present" ? sha256Hex(file.content) : null;
}

/**
 * C7: the sealed reverse material is authoritative. Before a fresh prepare
 * (or a re-prepare after an abort) the live source must equal the sealed
 * source byte for byte and the composition from it must reproduce the sealed
 * target and the exact project array; drift refuses, nothing is regenerated.
 */
function assertLiveSourceEqualsSealed(ctx: Context): Exit | null {
  const artifact = ctx.artifact!;
  let composed: ReturnType<typeof composeBackendPublicationMaterial>;
  try {
    composed = ctx.deps.composeMaterial({ homeDir: ctx.homeDir, targetBackend: "sqlite", bindings: artifact.projects });
  } catch (error) {
    return interrupted(ctx, "publication", "publication-mismatch", "the live source cannot be composed into the reverse publication: " + (error as Error).message);
  }
  if (
    composed.sourceBackend !== "postgresql"
    || fileSha256(composed.material.source.config) !== fileSha256(artifact.source.config)
    || fileSha256(composed.material.source.projectMap) !== fileSha256(artifact.source.projectMap)
    || fileSha256(composed.material.target.config) !== fileSha256(artifact.target.config)
    || fileSha256(composed.material.target.projectMap) !== fileSha256(artifact.target.projectMap)
    || canonicalJson(composed.projects as unknown as Record<string, unknown>[]) !== canonicalJson(artifact.projects as unknown as Record<string, unknown>[])
  ) {
    return interrupted(ctx, "publication", "publication-mismatch", "the live source, the composed target or the project array differs from the sealed reverse material");
  }
  return null;
}

/**
 * Drive the one reverse publication to completion and return its sealed
 * material digest. Never prepares a second time over a live journal of this
 * rollback: it is resumed (or, completed, verified). The coordinator's
 * missing-material exit (preparing without sealed material, or aborted
 * without a reference) is settled and the publication prepared again; a
 * journal aborted after it sealed its material (something else aborted it)
 * has its abort finished through the coordinator alone, its restored source
 * proven equal to the sealed source, and is then prepared again under the
 * recovery sessions. Any other composition under the rollback's id refuses.
 */
async function publishReverse(ctx: Context, ownV2: BackendPublicationJournal | null): Promise<Step<string>> {
  let journal: BackendPublicationJournal | null = ownV2;
  if (journal !== null) {
    if (!journalIsReverseComposition(ctx, journal)) return interrupted(ctx, "publication", "publication-mismatch", "the publication in the live slot carries this rollback's id but is not its reverse composition");
    if (ABORT_PATH_PHASES.has(journal.phase)) {
      try {
        journal = await ctx.coordinator!.abort(ctx.token);
      } catch (error) {
        if (error instanceof BackendPublicationJournalError) return interrupted(ctx, "publication", "journal-unexpected", "the aborting reverse publication could not be settled: " + error.message);
        throw error;
      }
      crash(ctx, "after-abort-settled");
    }
    if (journal.phase === "aborted") {
      if (journal.recoveryReference !== null && journal.projects.some((project) => project.fence !== null && project.fence.releasedAt === null)) {
        return interrupted(ctx, "publication", "publication-aborted", "the aborted reverse publication records an unreleased fence");
      }
      journal = null;
    } else if (journal.phase === "preparing" && journal.recoveryReference === null) {
      // E6/E8: prepare() died before sealing the material; the coordinator's own exit for this state is the missing-material abort.
      try {
        const aborted = await ctx.coordinator!.abort(ctx.token);
        if (!isAbortedUnsealed(aborted)) return interrupted(ctx, "publication", "journal-unexpected", "the unsealed reverse publication did not abort as a missing-material publication");
      } catch (error) {
        if (error instanceof BackendPublicationJournalError) return interrupted(ctx, "publication", "journal-unexpected", error.message);
        throw error;
      }
      journal = null;
    }
  }
  try {
    if (journal === null) {
      const equal = assertLiveSourceEqualsSealed(ctx);
      if (equal !== null) return equal;
      const artifact = ctx.artifact!;
      journal = await ctx.coordinator!.prepare({
        publicationId: ctx.setId, sourceBackend: "postgresql", targetBackend: "sqlite",
        material: { source: artifact.source, target: artifact.target }, projects: artifact.projects,
      }, ctx.token);
      crash(ctx, "after-prepare");
    }
    if (journal.phase !== "completed") {
      for (const member of ctx.members) member.session?.markCoordinatorAcquired();
      journal = await ctx.coordinator!.resume(ctx.token);
    }
  } catch (error) {
    if (error instanceof BackendPublicationJournalError) return interrupted(ctx, "publication", "journal-unexpected", error.message);
    throw error;
  }
  crash(ctx, "after-drive");
  if (journal.phase === "aborted") return interrupted(ctx, "publication", "publication-aborted", "the reverse publication was aborted by the coordinator; the next call settles it");
  if (journal.phase !== "completed" || !journalIsReverseComposition(ctx, journal) || journal.recoveryReference === null) {
    return interrupted(ctx, "publication", "publication-mismatch", "the reverse publication did not complete as composed");
  }
  return ok(journal.recoveryReference.sealSha256);
}

/** The member's rollback selection binding: an index onto the aggregate tuple under the shared reverse publication id. */
function recordMemberSelectionBinding(ctx: Context, member: Member): Exit | null {
  try {
    ctx.deps.recordSelectionBinding({
      homeDir: ctx.homeDir, generationId: member.generationId,
      binding: {
        kind: "rollback", epochId: member.selectionRow.epochId, attemptId: member.selectionRow.attemptId,
        manifestRevision: member.manifest!.revision, witnessChecksumSha256: member.terminalEvidenceSha256!, publicationId: ctx.setId,
      },
    });
    crash(ctx, "after-selection-binding:" + member.generationId);
  } catch (error) {
    if (error instanceof Error && error.name === "MigrationBindingConflictError") return interrupted(ctx, "completion", "evidence-conflict", at(member, error.message));
    if (error instanceof Error && error.name === "MigrationBindingUnresolvableError") return interrupted(ctx, "completion", "evidence-unresolvable", at(member, error.message));
    throw error;
  }
  return null;
}

/** The deterministic rollback report and the publish-rollback completion of one member; an already rolled-back member is verified. */
function settleMember(ctx: Context, member: Member, sealedDigest: string): Exit | null {
  const manifest = ctx.deps.manifestStore.read(member.generationId);
  member.manifest = manifest;
  if (manifest.phase === "rolled-back") return verifyRolledBackMember(ctx, member);
  const pending = manifest.pendingEffect;
  if (manifest.phase !== "rolling-back" || pending?.kind !== "publish-rollback" || pending.effectId !== publishEffectId(member.terminalEvidenceSha256!)) {
    return interrupted(ctx, "completion", "readback-mismatch", at(member, "the manifest is not rolling back with this rollback's pending publish-rollback"));
  }
  const failure = installRecordAuthenticates(member);
  if (failure !== null) return interrupted(ctx, "completion", "readback-mismatch", at(member, failure));
  let report: ReturnType<typeof writeRollbackReport>;
  try {
    report = ctx.deps.writeReport(ctx.homeDir, {
      version: 1, reportId: deriveRollbackReportId({ generationId: member.generationId, effectId: pending.effectId, kind: "rollback" }),
      generationId: member.generationId, effectId: pending.effectId, kind: "rollback", eligibility: member.mode!, mode: member.mode!,
      epochId: member.selectionRow.epochId, attemptId: member.selectionRow.attemptId, sealedPublicationMaterialDigestSha256: sealedDigest,
      reason: null, selectionBindingManifestRevision: manifest.revision,
    });
    crash(ctx, "after-report:" + member.generationId);
  } catch (error) {
    return interrupted(ctx, "completion", "evidence-conflict", at(member, "the rollback report could not be written: " + (error as Error).message));
  }
  try {
    member.manifest = ctx.deps.manifestStore.update(member.generationId, manifest.checksumSha256, (head) =>
      completeMigrationEffect(head, {
        effectId: pending.effectId, completedAt: ctx.now().toISOString(),
        report: { kind: "rollback", reportId: report.reportId, reportSha256: report.checksumSha256, createdAt: ctx.now().toISOString() }, rollbackMode: member.mode!,
      }));
    crash(ctx, "after-complete:" + member.generationId);
  } catch (error) {
    if (error instanceof MigrationProtocolError) return interrupted(ctx, "completion", "state-unresolvable", at(member, "publish-rollback could not be completed: " + error.message));
    throw error;
  }
  return null;
}

/** An already rolled-back member authenticates against its frozen row: mode, the rollback report of the frozen witness's effect, its installation. */
function verifyRolledBackMember(ctx: Context, member: Member): Exit | null {
  const manifest = member.manifest!;
  if (manifest.rollbackLineage.mode !== member.mode) return interrupted(ctx, "completion", "readback-mismatch", at(member, "the rolled-back mode is not the frozen one"));
  const reference = [...manifest.reports].reverse().find((candidate) => candidate.kind === "rollback");
  if (reference === undefined) return interrupted(ctx, "completion", "readback-mismatch", at(member, "no rollback report is referenced"));
  let report: ReturnType<typeof readRollbackReport>;
  try {
    report = ctx.deps.readReport(ctx.homeDir, member.generationId, reference.reportId);
  } catch (error) {
    return interrupted(ctx, "completion", "evidence-unresolvable", at(member, "the rollback report cannot be read: " + (error as Error).message));
  }
  if (report === null || report.checksumSha256 !== reference.reportSha256 || report.effectId !== publishEffectId(member.terminalEvidenceSha256!)
    || report.kind !== "rollback" || report.mode !== member.mode || report.epochId !== member.selectionRow.epochId || report.attemptId !== member.selectionRow.attemptId) {
    return interrupted(ctx, "completion", "readback-mismatch", at(member, "the rollback report does not name the frozen witness, mode, epoch and attempt"));
  }
  const failure = installRecordAuthenticates(member);
  if (failure !== null) return interrupted(ctx, "completion", "readback-mismatch", at(member, failure));
  return null;
}

async function finishAfterSelection(ctx: Context, ownV2: BackendPublicationJournal | null): Promise<CutoverSetRollbackResult> {
  for (const member of ctx.members) {
    if (member.manifest!.phase === "rolled-back") continue;
    const bound = recordMemberSelectionBinding(ctx, member);
    if (bound !== null) return bound.exit;
  }
  const published = await publishReverse(ctx, ownV2);
  if (isExit(published)) return published.exit;
  const completed = ctx.deps.readPublicationJournal(ctx.homeDir);
  if (completed === null || completed.publicationId !== ctx.setId || completed.phase !== "completed") {
    return interrupted(ctx, "completion", "readback-mismatch", "the publication journal is not this rollback's completed journal").exit;
  }
  const selected = assertSqliteSelected(ctx);
  if (selected !== null) return selected.exit;
  for (const member of ctx.members) {
    const settled = settleMember(ctx, member, published.value);
    if (settled !== null) return settled.exit;
  }
  return { status: "rolled-back", originalSetId: ctx.originalSetId, setId: ctx.setId, publicationId: ctx.setId, members: memberResults(ctx), resumedFrom: ctx.resumedFrom };
}

/** The currently selected installation is sqlite with every member unbound (the reverse publication's target, read from the live files). */
function assertSqliteSelected(ctx: Context): Exit | null {
  let storage: ResolvedStorageConfig;
  let map: ProjectMap;
  try {
    storage = ctx.deps.readStorageConfig(ctx.homeDir);
    map = ctx.deps.readProjectMap(ctx.homeDir, ctx.token);
  } catch (error) {
    return interrupted(ctx, "completion", "readback-mismatch", "the selected installation cannot be read: " + (error as Error).message);
  }
  if (storage.backend !== "sqlite") return interrupted(ctx, "completion", "readback-mismatch", "the configuration selects " + storage.backend + " after the reverse publication");
  for (const member of ctx.members) {
    const entry = map[member.physicalProjectId];
    if (entry === undefined || entry.remoteProjectId !== undefined) return interrupted(ctx, "completion", "readback-mismatch", at(member, "the project map still binds the member or lost its entry"));
  }
  return null;
}

/**
 * With a frozen selection and a slot that is not this rollback's live
 * publication (or its completed one): rolled back only when every member is
 * rolled back with the report of its frozen witness and its authenticated
 * installation, and the currently selected installation is sqlite with every
 * member unbound; anything else is an interruption that republishes nothing.
 */
async function settledFromRecords(ctx: Context, v2: BackendPublicationJournal | null): Promise<CutoverSetRollbackResult> {
  if (ctx.members.some((member) => member.manifest === null)) {
    const members = await resolveMembers(ctx, "frozen");
    if (members !== null) return members.exit;
    const adopted = adoptFrozenSelection(ctx);
    if (adopted !== null) return adopted.exit;
  }
  const pending = ctx.members.filter((member) => member.manifest!.phase !== "rolled-back");
  if (pending.length > 0) {
    return interrupted(ctx, "completion", "state-unresolvable", "the rollback's journal slot is " + (v2 === null ? "empty" : v2.publicationId === ctx.setId ? "its own completed publication" : "occupied by publication " + v2.publicationId)
      + " and " + pending.map((member) => member.generationId).join(", ") + " " + (pending.length === 1 ? "is" : "are") + " not rolled back; nothing is republished").exit;
  }
  for (const member of ctx.members) {
    const verified = verifyRolledBackMember(ctx, member);
    if (verified !== null) return verified.exit;
  }
  const selected = assertSqliteSelected(ctx);
  if (selected !== null) return selected.exit;
  ctx.resumedFrom = "settled";
  return { status: "rolled-back", originalSetId: ctx.originalSetId, setId: ctx.setId, publicationId: ctx.setId, members: memberResults(ctx), resumedFrom: "settled" };
}

