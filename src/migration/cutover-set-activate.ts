import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { ResolvedPostgreSqlConfig } from "../daemon/config.js";
import { MachineIdentityFileError } from "../machine-identity.js";
import { readProjectMapCanonicalPath } from "../project-map.js";
import { daemonPidPath, lcmHomeDir } from "../runtime-paths.js";
import {
  backendCutoverSetJournalCapacity,
  backendCutoverSetManifestSha256,
  backendCutoverSetSelectionSha256,
  backendMaintenanceQueueEvidenceSentinel,
  resolveBackendMaintenanceGenerationBinding,
  type BackendCutoverSetManifest,
  type BackendCutoverSetSelection,
  type BackendCutoverSetSelectionMember,
  type BackendMaintenanceJournal,
  type BackendPublicationJournal,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import type { ComposeBackendPublicationMaterialResult } from "../storage/backend-publication-material.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import { StorageOperationError } from "../storage/errors.js";
import { PortableStreamError } from "../storage/portable-record.js";
import type { PostgreSqlConnectionSettings, PostgreSqlQueryExecutor } from "../storage/postgresql/contracts.js";
import { connectionSettings } from "../storage/postgresql/factory.js";
import {
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
} from "../storage/postgresql/publication-guard.js";
import {
  APPLIED_IN_FLIGHT_PHASES,
  createMigrationActivationDependencies,
  digestsMatch,
  discoverMigrationActivationRoles,
  MigrationActivationError,
  type MigrationActivationDependencies,
  type MigrationActivationInterruptionCause,
  type MigrationActivationInterruptionStep,
  type MigrationActivationOrdinaryRuntime,
  type MigrationActivationRole,
  type MigrationActivationRefusalReason,
  type MigrationActivationRefusalStep,
  type MigrationActivationSnapshot,
  recoveryFileDigests,
  type MigrationActivationTriState,
} from "./activate-generation.js";
import {
  ActivationArtifactIdentityMismatchError,
  ActivationArtifactPresenceUnresolvableError,
  ActivationArtifactValidationError,
  ActivationGenerationLinkConflictError,
  computeActivationArtifactIdentityDigest,
  type ActivationArtifactRecoveryMaterial,
  type ActivationGenerationLink,
} from "./activation-artifact-store.js";
import {
  acquireActivationLease,
  releaseActivationLease,
  renewActivationLease,
  resolveActivationLeaseFence,
  takeoverActivationLease,
  type ActivationLeaseFence,
  type ActivationLeasePublicationGuard,
  type ActivationLeaseReleaseResult,
  type ActivationLeaseRenewResult,
} from "./activation-lease.js";
import type { ActivationPublicationResult, ActivationPublicationStatus } from "./activation-publication.js";
import { checkCutoverSetActivationWriterQuiescence, type ActivationQuiescenceResult } from "./activation-quiescence.js";
import {
  createMigrationActivationReport,
  migrationActivationReportReference,
  MigrationActivationReportError,
  probeMigrationActivationReportPresence,
  type MigrationActivationReportPersistResult,
} from "./activation-report.js";
import type { ActivationRestartCheckResult } from "./activation-restart-check.js";
import { MigrationActivationEvidenceRefusalError, type MigrationActivationEvidenceResolution } from "./activation-evidence-store.js";
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
} from "./activation-witness.js";
import { resolveMigrationExpectedIdentity } from "./cli-preflight.js";
import type { MigrationCopyBindingReadResult } from "./copy-binding-reader.js";
import {
  decideCutoverSetSelection,
  type CutoverSetMemberEvidence,
  type CutoverSetRefusalReason,
  type CutoverSetSelectionFailure,
} from "./cutover-set.js";
import {
  createCutoverSetActivationCheckpoint,
  readCutoverSetActivationRecords,
  recordCutoverSetActivationCheckpoint,
  recordCutoverSetActivationSelection,
  type CutoverSetActivationCheckpoint,
  type CutoverSetActivationRecords,
} from "./cutover-set-activation-store.js";
import { readCutoverSetRollbackRecords } from "./cutover-set-rollback-store.js";
import {
  computeMigrationGenerationBase,
  DEFAULT_MAX_PROBE_ORDINAL,
  generationIdBelongsToBase,
  nonSecretPostgreSqlTargetCoordinates,
  type NonSecretPostgreSqlTarget,
} from "./generation-identity.js";
import type { MigrationWitnessResolution } from "./generation-binding-store.js";
import { resolveCutoverSetMemberAuthorities } from "./maintenance.js";
import { MigrationProjectMapWitnessError } from "./project-map-witness.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  MigrationProtocolError,
  type MigrationManifest,
  type MigrationReportReference,
} from "./protocol.js";
import { inspectAuthenticatedSqliteMigrationSnapshot } from "./queue-evidence.js";
import { classifyMigrationTargetFailure, type MigrationTargetHealthResult } from "./target-health.js";
import type { MigrationVerificationReport } from "./verification-report.js";
import { MigrationVerificationStoreError } from "./verification-store.js";
import { assertDestinationIdentityMatches } from "./verify-generation.js";

/**
 * Activating a cutover set through one publication (#1549).
 *
 * One entry point, activateCutoverSet, for the fresh activation of a
 * prepared set and for the recovery of an interrupted one. It composes the
 * single-generation activation's primitives (plan-v2 D1) around the set
 * contract: one retained append barrier spans every check, every member
 * effect, the one selection and the one publication (D2); every member is
 * revalidated independently before the first effect and the whole set is
 * refused on any stale, drifted or unverifiable member through
 * decideCutoverSetSelection; the checkpoint record (D3) freezes every
 * member's verified revision and copy binding before any manifest moves;
 * each member then gets its own activation effects, epoch, attempt and
 * witness in manifest order (D5); the frozen selection tuple (D4) is
 * written before the journal's selection phases and adopted on retry; the
 * existing multi-project publication driver runs exactly once with every
 * project; and post-publication bookkeeping settles each member from its
 * own evidence (C4). runMigrationActivation is never called for a member:
 * it would select and publish that member alone.
 *
 * Entry routing (C1) classifies the live journal slot and the stored set
 * records before choosing a path:
 *
 * | Live slot | Records | Route |
 * | --- | --- | --- |
 * | own set v3 entering | any | refused cutover-set-not-held (finish preparation) |
 * | own set v3 held | none or checkpoint | pre-selection: revalidate, checkpoint, member effects, freeze, select, publish |
 * | own set v3 held | checkpoint + selection | pre-selection with the frozen tuple adopted |
 * | own set v3 selection-prepared / -completed | selection | complete the same tuple, repair member bindings, drive once |
 * | own set v3 aborted | any | refused cutover-set-aborted; a checkpoint never revives a set |
 * | own v2 (publicationId = set id) | selection | existing publication dispatch, then settle members |
 * | foreign v3 / v2, or empty | selection, all members settled | activated from member evidence |
 * | empty | selection, all members pending, no reports | the v3-archive-before-first-v2-write crash: fresh-prepare the frozen artifact |
 * | foreign / empty | selection, mixed members | interrupted; never republish |
 * | foreign / empty | checkpoint only | interrupted; the hold is gone |
 * | foreign / empty | none | refused maintenance-not-held |
 *
 * No CLI reaches this service until #1551; set rollback belongs to #1550.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export type CutoverSetActivationRefusalReason =
  | MigrationActivationRefusalReason
  | CutoverSetRefusalReason
  | "cutover-set-not-held"
  | "cutover-set-aborted"
  | "cutover-set-confirmation-mismatch"
  | "cutover-set-authority-drifted"
  | "cutover-set-target-changed"
  | "cutover-set-member-unmapped"
  | "cutover-set-member-identity"
  | "cutover-set-rollback-committed"
  | "machine-identity-unregistered"
  | "cancelled";

export type CutoverSetActivationResumePoint =
  | "fresh"
  | "pre-selection"
  | "selection-frozen"
  | "selection-prepared"
  | "selection-completed"
  | "publication-journal"
  | "slot-replaced"
  | "settled-active";

/** A member's last observed state, in manifest order, on every result. */
export type CutoverSetActivationMemberResult = Readonly<{
  physicalProjectId: string;
  generationId: string;
  /** The durable manifest phase last read for the member, or unknown. */
  manifest: "verified" | "activating" | "active" | "other" | "unknown";
  /** The selection-gate evidence state when the gate ran for this member. */
  evidence: CutoverSetMemberEvidence["state"] | "absent" | null;
  reason: string | null;
  detail: string | null;
  /** The member's fenced lease token after a takeover in this call (its row's token advanced past the frozen attempt's), else null. */
  successorFencingToken: string | null;
}>;

export type CutoverSetActivateResult =
  | Readonly<{
    status: "activated";
    setId: string;
    publicationId: string;
    members: readonly CutoverSetActivationMemberResult[];
    restart: ActivationRestartCheckResult;
    resumedFrom: CutoverSetActivationResumePoint;
  }>
  | Readonly<{
    status: "refused";
    setId: string;
    step: MigrationActivationRefusalStep;
    reason: CutoverSetActivationRefusalReason;
    detail: string;
    /** Every failing member the selection gate named, when the gate ran. */
    failures: readonly CutoverSetSelectionFailure[];
    members: readonly CutoverSetActivationMemberResult[];
    effectBegun: false;
  }>
  | Readonly<{
    status: "interrupted";
    setId: string;
    publicationId: string;
    step: MigrationActivationInterruptionStep;
    cause: MigrationActivationInterruptionCause;
    detail: string;
    effectBegun: boolean;
    applied: MigrationActivationTriState;
    members: readonly CutoverSetActivationMemberResult[];
  }>
  | Readonly<{
    status: "publication-failed";
    setId: string;
    publicationId: string;
    publication: ActivationPublicationResult;
    members: readonly CutoverSetActivationMemberResult[];
  }>
  | Readonly<{
    status: "post-publication-unhealthy";
    setId: string;
    publicationId: string;
    health: MigrationTargetHealthResult;
    restart: ActivationRestartCheckResult;
    members: readonly CutoverSetActivationMemberResult[];
  }>;

// ---------------------------------------------------------------------------
// Input and dependency seams
// ---------------------------------------------------------------------------

export type CutoverSetActivateInput = Readonly<{
  homeDir: string;
  /** The held set id the operator confirmed; compared before any read of a member. */
  confirmSetId: string;
  /** The one resolved target every member was copied to; its migration role is the activation role (#627). */
  targetConfig: ResolvedPostgreSqlConfig;
  /** The daemon runtime role used by S5, S6 and S15. */
  ordinarySettings: PostgreSqlConnectionSettings;
  maxProbeOrdinal?: number;
  signal?: AbortSignal;
  now?: () => Date;
}>;

/** The single-generation activation's dependencies plus the set-specific seams. */
export type CutoverSetActivateDependencies = MigrationActivationDependencies & Readonly<{
  resolveAuthorities: typeof resolveCutoverSetMemberAuthorities;
  readCanonicalPath: typeof readProjectMapCanonicalPath;
  resolveExpectedIdentity: typeof resolveMigrationExpectedIdentity;
  inspectSnapshot: typeof inspectAuthenticatedSqliteMigrationSnapshot;
  checkSetQuiescence: typeof checkCutoverSetActivationWriterQuiescence;
  readRecords: typeof readCutoverSetActivationRecords;
  recordCheckpoint: typeof recordCutoverSetActivationCheckpoint;
  recordSelection: typeof recordCutoverSetActivationSelection;
  probeReportPresence: typeof probeMigrationActivationReportPresence;
}>;

export function createCutoverSetActivateDependencies(input: Readonly<{ homeDir: string }>): CutoverSetActivateDependencies {
  return {
    ...createMigrationActivationDependencies(input),
    allocateScratch: (home) => mkdtempSync(join(lcmHomeDir(home), "cutover-set-activation-scratch-")),
    resolveAuthorities: resolveCutoverSetMemberAuthorities,
    readCanonicalPath: readProjectMapCanonicalPath,
    resolveExpectedIdentity: resolveMigrationExpectedIdentity,
    inspectSnapshot: inspectAuthenticatedSqliteMigrationSnapshot,
    checkSetQuiescence: checkCutoverSetActivationWriterQuiescence,
    readRecords: readCutoverSetActivationRecords,
    recordCheckpoint: recordCutoverSetActivationCheckpoint,
    recordSelection: recordCutoverSetActivationSelection,
    probeReportPresence: probeMigrationActivationReportPresence,
  };
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

/** The same effect ids and input digest the single-generation orchestrator derives from an epoch. */
const PREPARE_EFFECT_PREFIX = "prepare-activation-";
const PUBLISH_EFFECT_PREFIX = "publish-activation-";
const SET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function effectIds(epochId: string): { prepare: string; publish: string; inputSha256: string } {
  return { prepare: PREPARE_EFFECT_PREFIX + epochId, publish: PUBLISH_EFFECT_PREFIX + epochId, inputSha256: sha256Hex(epochId) };
}

type EpochManifestPair = Readonly<{ epochManifestRevision: number; epochManifestChecksumSha256: string }>;

type Member = {
  readonly physicalProjectId: string;
  readonly generationId: string;
  readonly sourceSelectionSha256: string;
  canonicalPath: string;
  remoteProjectId: string;
  identity: StorageIdentityContext | null;
  heldMemberChecksumSha256: string | null;
  manifest: MigrationManifest | null;
  report: MigrationVerificationReport | null;
  verificationRef: MigrationReportReference | null;
  pair: EpochManifestPair | null;
  copyBindingSha256: string | null;
  link: ActivationGenerationLink | null;
  fence: ActivationLeaseFence | null;
  quiescence: ActivationQuiescenceResult | null;
  censusVector: MigrationCensusVector | null;
  canonicalDelta: MigrationCanonicalDelta | null;
  epoch: MigrationActivationEpoch | null;
  attempt: MigrationActivationAttempt | null;
  witness: MigrationActivationWitness | null;
  /** The selection row adopted from a frozen tuple, when one exists. */
  frozen: BackendCutoverSetSelectionMember | null;
  evidence: CutoverSetMemberEvidence["state"] | "absent" | null;
  reason: string | null;
  detail: string | null;
  successorFencingToken: string | null;
};

type Context = {
  readonly input: CutoverSetActivateInput;
  readonly deps: CutoverSetActivateDependencies;
  readonly homeDir: string;
  readonly setId: string;
  readonly transferSettings: PostgreSqlConnectionSettings;
  readonly ordinarySettings: PostgreSqlConnectionSettings;
  readonly expectedOwner: string;
  readonly coordinates: NonSecretPostgreSqlTarget;
  readonly maxProbeOrdinal: number;
  readonly now: () => Date;
  machineId: string;
  token: BackendPublicationLockToken;
  manifest: BackendCutoverSetManifest | null;
  members: Member[];
  journal: BackendMaintenanceJournal | null;
  records: Extract<CutoverSetActivationRecords, { state: "resolved" }> | null;
  checkpoint: CutoverSetActivationCheckpoint | null;
  selection: BackendCutoverSetSelection | null;
  artifact: ActivationArtifactRecoveryMaterial | null;
  material: ComposeBackendPublicationMaterialResult | null;
  identityDigest: string | null;
  ordinary: MigrationActivationOrdinaryRuntime | null;
  guard: ActivationLeasePublicationGuard | null;
  coordinator: ReturnType<MigrationActivationDependencies["createCoordinator"]> | null;
  ordinaryRole: MigrationActivationRole | null;
  transferRole: MigrationActivationRole | null;
  effectBegun: boolean;
  resumedFrom: CutoverSetActivationResumePoint;
};

type Exit = Readonly<{ exit: CutoverSetActivateResult }>;
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

function memberResults(ctx: Context): readonly CutoverSetActivationMemberResult[] {
  return ctx.members.map((member) => ({
    physicalProjectId: member.physicalProjectId,
    generationId: member.generationId,
    manifest: member.manifest === null ? "unknown"
      : member.manifest.phase === "verified" || member.manifest.phase === "activating" || member.manifest.phase === "active"
        ? member.manifest.phase : "other",
    evidence: member.evidence,
    reason: member.reason,
    detail: member.detail,
    successorFencingToken: member.successorFencingToken,
  }));
}

const ROLL_FORWARD_CAUSES: Partial<Record<string, MigrationActivationInterruptionCause>> = {
  "lease-conflict": "lease-lost",
  "lease-unresolvable": "lease-unresolvable",
  "project-map-drift": "project-map-drift",
};

/** A refusal before any effect of this set; once a member effect exists the same failure is an interruption. */
function refused(
  ctx: Context,
  step: MigrationActivationRefusalStep,
  reason: CutoverSetActivationRefusalReason,
  detail: string,
  failures: readonly CutoverSetSelectionFailure[] = [],
): Exit {
  if (ctx.effectBegun) {
    return interrupted(ctx, "S9", ROLL_FORWARD_CAUSES[reason] ?? "state-unresolvable", step + " " + reason + " on roll-forward: " + detail);
  }
  return { exit: { status: "refused", setId: ctx.setId, step, reason, detail, failures, members: memberResults(ctx), effectBegun: false } };
}

/** The own journal records the config as published: yes needs the live selection to match it. */
const APPLIED_YES_PHASES: readonly BackendPublicationJournal["phase"][] = ["config-published", "releasing", "released", "completed"];

/** "no" only when the live selection still equals the set's pre-publication source witness; otherwise "unknown". */
function classifyAgainstSource(ctx: Context): MigrationActivationTriState {
  // The witness enters the context at compose or at the stored artifact load;
  // an interruption before either has no source proof.
  const source = ctx.material?.material.source ?? ctx.artifact?.source;
  if (source === undefined) return "unknown";
  const witness = recoveryFileDigests(source.config, source.projectMap);
  return digestsMatch(ctx.deps.readSelectionDigests(ctx.homeDir), witness.configSha256, witness.projectMapSha256) ? "no" : "unknown";
}

/**
 * applied is evidence-derived: the journal phase says what was attempted, and
 * an independent readback of the live config and project map must agree
 * before it is reported (the single-generation rules of activate-generation.ts).
 * Everything else, including any readback failure, is unknown. Never throws.
 */
function classifyApplied(ctx: Context): MigrationActivationTriState {
  try {
    const maintenance = ctx.deps.readMaintenanceJournal(ctx.homeDir);
    if (maintenance !== null) return maintenance.sourceBackend === "sqlite" ? classifyAgainstSource(ctx) : "unknown";
    const journal = ctx.deps.readPublicationJournal(ctx.homeDir);
    if (journal === null || journal.publicationId !== ctx.setId) return classifyAgainstSource(ctx);
    if (APPLIED_IN_FLIGHT_PHASES.includes(journal.phase)) return "unknown";
    const live = ctx.deps.readSelectionDigests(ctx.homeDir);
    if (APPLIED_YES_PHASES.includes(journal.phase)) {
      const { publishedConfigSha256, publishedProjectMapSha256 } = journal;
      return publishedConfigSha256 !== null && publishedProjectMapSha256 !== null && digestsMatch(live, publishedConfigSha256, publishedProjectMapSha256) ? "yes" : "unknown";
    }
    return digestsMatch(live, journal.expectedConfigSha256, journal.expectedProjectMapSha256) ? "no" : "unknown";
  } catch {
    return "unknown";
  }
}

function interrupted(
  ctx: Context,
  step: MigrationActivationInterruptionStep,
  cause: MigrationActivationInterruptionCause,
  detail: string,
): Exit {
  return {
    exit: {
      status: "interrupted", setId: ctx.setId, publicationId: ctx.setId, step, cause, detail,
      effectBegun: ctx.effectBegun, applied: classifyApplied(ctx), members: memberResults(ctx),
    },
  };
}

/** A member-attributed detail. */
function at(member: Member, detail: string): string {
  return member.generationId + ": " + detail;
}


// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function validateInput(input: CutoverSetActivateInput): void {
  if (
    typeof input !== "object" || input === null
    || typeof input.homeDir !== "string" || input.homeDir.length === 0
    || typeof input.confirmSetId !== "string" || !SET_ID_PATTERN.test(input.confirmSetId)
    || typeof input.targetConfig !== "object" || input.targetConfig === null
    || typeof input.targetConfig.postgresql !== "object" || input.targetConfig.postgresql === null
    || typeof input.ordinarySettings !== "object" || input.ordinarySettings === null
    || typeof input.targetConfig.postgresql.migrationRole !== "string" || input.targetConfig.postgresql.migrationRole.length === 0
  ) {
    throw new MigrationActivationError("invalid-input", "cutover-set activation input is invalid");
  }
}

/**
 * Activate (or recover the activation of) a prepared cutover set. See the
 * module doc comment for the routing table and the sources of every rule.
 */
export async function activateCutoverSet(
  input: CutoverSetActivateInput,
  dependencies?: Partial<CutoverSetActivateDependencies>,
): Promise<CutoverSetActivateResult> {
  validateInput(input);
  const deps: CutoverSetActivateDependencies = { ...createCutoverSetActivateDependencies({ homeDir: input.homeDir }), ...dependencies };
  let coordinates: NonSecretPostgreSqlTarget;
  try {
    coordinates = nonSecretPostgreSqlTargetCoordinates(input.targetConfig.postgresql.url);
  } catch (error) {
    // The coordinates helper refuses only through its typed MigrationIdentityError.
    throw new MigrationActivationError("invalid-input", "cutover-set activation target is invalid: " + (error as Error).message);
  }
  const ctx: Context = {
    input, deps, homeDir: input.homeDir, setId: input.confirmSetId,
    transferSettings: connectionSettings(input.targetConfig), ordinarySettings: input.ordinarySettings,
    expectedOwner: input.targetConfig.postgresql.migrationRole,
    coordinates, maxProbeOrdinal: input.maxProbeOrdinal ?? DEFAULT_MAX_PROBE_ORDINAL,
    now: input.now ?? (() => new Date()),
    machineId: "", token: {} as BackendPublicationLockToken, manifest: null, members: [], journal: null, records: null,
    checkpoint: null, selection: null, artifact: null, material: null, identityDigest: null,
    ordinary: null, guard: null, coordinator: null, ordinaryRole: null, transferRole: null,
    effectBegun: false, resumedFrom: "fresh",
  };
  // The append barrier itself refuses a maintenance-entering journal, so that
  // row of the routing table is classified before the barrier (as the
  // preparation classifies its entry); every other row is read again under it.
  const entering = classifyEnteringBeforeBarrier(ctx);
  if (entering !== null) return entering;
  return await deps.withAppendBarrier(input.homeDir, async (token) => {
    ctx.token = token;
    try {
      return await withPreEffectLeasesReleased(ctx, await runUnderBarrier(ctx));
    } catch (error) {
      // Best effort, only when readback proves no member effect began: the original error is the outcome.
      if (ctx.guard !== null && headsPositivelyUnbegun(ctx)) await releaseAcquiredLeases(ctx);
      throw error;
    } finally {
      if (ctx.ordinary !== null) await ctx.ordinary.close();
    }
  });
}

function classifyEnteringBeforeBarrier(ctx: Context): CutoverSetActivateResult | null {
  let journal: BackendMaintenanceJournal | null;
  try {
    journal = ctx.deps.readMaintenanceJournal(ctx.homeDir);
  } catch (error) {
    return refused(ctx, "S0", "maintenance-unresolvable", "a backend journal could not be read: " + (error as Error).message).exit;
  }
  if (journal === null || journal.phase !== "maintenance-entering") return null;
  if (journal.cutoverSet === undefined || journal.generationId !== ctx.setId) {
    return refused(ctx, "S3", "maintenance-not-held", "the maintenance journal is entering for " + journal.generationId).exit;
  }
  return refused(ctx, "S3", "cutover-set-not-held", "the set is still entering maintenance; finish its preparation first").exit;
}

async function runUnderBarrier(ctx: Context): Promise<CutoverSetActivateResult> {
  try {
    ctx.machineId = ctx.deps.machineId(ctx.homeDir);
  } catch (error) {
    if (error instanceof MachineIdentityFileError) return refused(ctx, "S0", "machine-identity-unregistered", error.message).exit;
    // A filesystem error reading the identity file is unresolvable state; anything else is not a classified condition.
    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") {
      return refused(ctx, "S0", "state-unresolvable", "the machine identity could not be resolved: " + error.message).exit;
    }
    throw error;
  }
  const records = ctx.deps.readRecords({ homeDir: ctx.homeDir, setId: ctx.setId });
  if (records.state === "unresolvable") {
    return interrupted(ctx, "S9", "state-unresolvable", "the set activation records are unresolvable: " + records.reason).exit;
  }
  // #1550 (D7): a rollback commitment for this set (its checkpoint, at any later state) fences the activation
  // for good: nothing is adopted, re-driven or reported as activated after a rollback begins.
  const rollback = readCutoverSetRollbackRecords({ homeDir: ctx.homeDir, originalSetId: ctx.setId });
  if (rollback.state !== "authoritatively-absent") {
    return refused(ctx, "S0", "cutover-set-rollback-committed", rollback.state === "resolved"
      ? "the set is committed to a rollback (checkpoint " + rollback.checkpoint.checksumSha256 + "); it is never republished"
      : "the set rollback records are unresolvable: " + rollback.reason).exit;
  }
  ctx.records = records.state === "resolved" ? records : null;
  ctx.checkpoint = ctx.records?.checkpoint ?? null;
  ctx.selection = ctx.records?.selection ?? null;
  ctx.identityDigest = ctx.checkpoint?.identityDigest ?? null;
  // A checkpoint means a member effect may exist: every later refusal is a roll-forward interruption.
  ctx.effectBegun = ctx.checkpoint !== null;
  let v3: BackendMaintenanceJournal | null;
  let v2: BackendPublicationJournal | null = null;
  try {
    v3 = ctx.deps.readMaintenanceJournal(ctx.homeDir);
    if (v3 === null) v2 = ctx.deps.readPublicationJournal(ctx.homeDir);
  } catch (error) {
    return ctx.checkpoint !== null
      ? interrupted(ctx, "S12", "journal-unexpected", "a backend journal could not be read: " + (error as Error).message).exit
      : refused(ctx, "S0", "maintenance-unresolvable", "a backend journal could not be read: " + (error as Error).message).exit;
  }
  ctx.journal = v3;
  const ownV3 = v3 !== null && v3.cutoverSet !== undefined && v3.generationId === ctx.setId ? v3 : null;
  const ownV2 = v2 !== null && v2.publicationId === ctx.setId ? v2 : null;
  const manifest = ownV3?.cutoverSet!.manifest ?? ctx.checkpoint?.manifest ?? null;
  if (manifest !== null) {
    ctx.manifest = manifest;
    ctx.members = manifest.members.map((member): Member => ({
      physicalProjectId: member.physicalProjectId, generationId: member.generationId, sourceSelectionSha256: member.sourceSelectionSha256,
      canonicalPath: "", remoteProjectId: "", identity: null, heldMemberChecksumSha256: null, manifest: null, report: null,
      verificationRef: null, pair: null, copyBindingSha256: null, link: null, fence: null, quiescence: null, censusVector: null,
      canonicalDelta: null, epoch: null, attempt: null, witness: null, frozen: null, evidence: null, reason: null, detail: null,
      successorFencingToken: null,
    }));
  }
  if (ownV3 !== null) {
    if (ownV3.sourceBackend !== "sqlite") {
      return refused(ctx, "S3", "maintenance-not-held", "the set hold was entered from " + ownV3.sourceBackend + ", not from sqlite").exit;
    }
    // The store already proves the checkpoint's set id; its manifest must be the held one.
    if (ctx.checkpoint !== null && backendCutoverSetManifestSha256(ctx.checkpoint.manifest) !== backendCutoverSetManifestSha256(ownV3.cutoverSet!.manifest)) {
      return interrupted(ctx, "S9", "evidence-conflict", "the stored checkpoint's manifest differs from the held set manifest").exit;
    }
    switch (ownV3.phase) {
      case "maintenance-aborted":
        // A checkpoint never revives an aborted set: the abort settled every member before any member effect.
        ctx.effectBegun = false;
        return refused(ctx, "S3", "cutover-set-aborted", "the set hold was aborted; a stored checkpoint never revives it").exit;
      case "maintenance-held":
        return preSelection(ctx, ownV3);
      default:
        return postSelection(ctx, ownV3, null);
    }
  }
  if (ownV2 !== null) {
    if (ctx.selection === null) {
      return interrupted(ctx, "S12", "state-unresolvable", "a publication exists for this set but no frozen selection is stored").exit;
    }
    return postSelection(ctx, null, ownV2);
  }
  // The slot is empty or belongs to another publication or hold.
  if (ctx.selection === null) {
    if (ctx.checkpoint !== null) {
      return interrupted(ctx, "S12", "journal-unexpected", "the set hold is gone before its selection was frozen; the slot holds "
        + (v3 === null ? v2 === null ? "nothing" : "publication " + v2.publicationId : "maintenance " + v3.generationId)).exit;
    }
    return refused(ctx, "S3", "maintenance-not-held", v3 === null
      ? v2 === null ? "no maintenance journal is held for this set" : "the journal slot holds publication " + v2.publicationId + " at phase " + v2.phase
      : "the maintenance journal is held for " + v3.generationId + " at phase " + v3.phase).exit;
  }
  const settled = await classifySettlement(ctx);
  if (isExit(settled)) return settled.exit;
  if (settled.value === "all-active") return settledActive(ctx, "settled-active");
  if (settled.value === "all-pending" && v3 === null && v2 === null) {
    // C1: the terminal v3 was archived by prepare() and the crash hit before the first version-2 write.
    ctx.resumedFrom = "slot-replaced";
    const fences = await resolveMemberFences(ctx, null);
    if (fences !== null) return fences.exit;
    return finishAfterSelection(ctx, null);
  }
  return interrupted(ctx, "S13b", "state-unresolvable", "the set's journal slot is " + (v3 === null && v2 === null ? "empty" : "occupied by another publication or hold")
    + " and its members are " + settled.value + "; nothing is republished").exit;
}

// ---------------------------------------------------------------------------
// Member manifests, reports and links
// ---------------------------------------------------------------------------

function isManifestAbsent(error: unknown): boolean {
  return error instanceof MigrationProtocolError && error.reason === "unexpected-state" && /head is absent/u.test(error.message);
}

/** The newest report reference of one kind; protocol.ts's cross-field invariants guarantee presence for a verified or active manifest. */
function latestReport(manifest: MigrationManifest, kind: MigrationReportReference["kind"]): MigrationReportReference {
  const matching = manifest.reports.filter((report) => report.kind === kind);
  return matching[matching.length - 1]!;
}

type ManifestRead =
  | Readonly<{ kind: "read"; manifest: MigrationManifest }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unresolvable"; detail: string }>;

function readMemberManifest(ctx: Context, member: Member): ManifestRead {
  try {
    const manifest = ctx.deps.manifestStore.read(member.generationId);
    member.manifest = manifest;
    return { kind: "read", manifest };
  } catch (error) {
    if (isManifestAbsent(error)) return { kind: "absent" };
    if (error instanceof MigrationProtocolError) return { kind: "unresolvable", detail: error.message };
    throw error;
  }
}

/** Read and authenticate the member's eligible verification report against its manifest reference. */
function readMemberVerification(ctx: Context, member: Member, expectedSha256: string | null): string | null {
  const ref = latestReport(member.manifest!, "verification");
  if (expectedSha256 !== null && ref.reportSha256 !== expectedSha256) return "the manifest's verification report is not the checkpointed one";
  let report: MigrationVerificationReport;
  try {
    report = ctx.deps.readVerificationReport(member.generationId, ref.reportSha256);
  } catch (error) {
    if (error instanceof MigrationVerificationStoreError) return "the verification report could not be read: " + error.message;
    throw error;
  }
  if (report.reportId !== ref.reportId || report.reportSha256 !== ref.reportSha256) return "the stored verification report does not match the manifest's reference";
  if (!report.activationEligible) return "the verification report is not activation-eligible";
  member.report = report;
  member.verificationRef = ref;
  return null;
}

/** The epoch of a member is derived from its frozen verified revision and its report alone. */
function epochFor(member: Member): MigrationActivationEpoch {
  const body = member.report!.body;
  return createMigrationActivationEpoch({
    generationId: member.generationId,
    manifestRevision: member.pair!.epochManifestRevision,
    manifestChecksumSha256: member.pair!.epochManifestChecksumSha256,
    verificationReportId: member.report!.reportId,
    verificationReportSha256: member.report!.reportSha256,
    projectMapWitnessSha256: body.projectMapWitnessSha256,
    queueClassificationWitnessSha256: migrationWitnessSha256(body.queueClassificationWitness),
    destinationIdentity: body.destinationIdentity,
    censusVector: body.censusVector,
    schemaWitness: body.destinationSchemaWitness,
  });
}

function attemptFor(ctx: Context, member: Member): MigrationActivationAttempt {
  const envelope = member.quiescence!.quiescenceFence!;
  return createMigrationActivationAttempt({
    epochId: member.epoch!.epochId,
    selectionAuthority: {
      version: 1,
      resourceType: POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
      resourceKey: POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
      fencingToken: member.fence!.fencingToken.toString(10),
      ownerProcessId: ctx.setId,
    },
    canonicalDeltaBaseline: member.canonicalDelta!,
    activationRecomputedCensus: member.censusVector!,
    intraActivationWatermark: null,
    quiescenceFence: createMigrationQuiescenceFence({ kind: envelope.kind, payload: envelope.payload }),
  });
}

function witnessFor(member: Member): MigrationActivationWitness {
  return createMigrationActivationWitness({
    kind: "activation", epoch: member.epoch!, attempt: member.attempt!, postEpochDelta: null, postEpochCensus: null, rollbackMode: null,
  });
}

function projectBinding(member: Member): { localProjectId: string; remoteProjectId: string; evidenceSha256: string } {
  return { localProjectId: member.physicalProjectId, remoteProjectId: member.remoteProjectId, evidenceSha256: member.copyBindingSha256! };
}

/** Read the member's generation link: absent, ours (shared publication and digest) or foreign. */
function readMemberLink(ctx: Context, member: Member): string | null {
  const link = ctx.deps.readLink({ homeDir: ctx.homeDir, generationId: member.generationId });
  if (link.state === "unresolvable") return "the generation link is unresolvable: " + link.detail;
  if (link.state === "authoritatively-absent") return null;
  if (link.link.publicationId !== ctx.setId) return "the generation link names publication " + link.link.publicationId;
  if (ctx.identityDigest !== null && link.link.identityDigest !== ctx.identityDigest) return "the generation link names another artifact";
  if (member.pair !== null && (link.link.epochManifestRevision !== member.pair.epochManifestRevision
    || link.link.epochManifestChecksumSha256 !== member.pair.epochManifestChecksumSha256)) {
    return "the generation link carries another frozen manifest revision";
  }
  member.link = link.link;
  return null;
}

function openOrdinary(ctx: Context): void {
  ctx.ordinary = ctx.deps.createOrdinaryRuntime(ctx.ordinarySettings);
  ctx.guard = ctx.ordinary.backendPublicationGuard();
  ctx.coordinator = ctx.deps.createCoordinator({ homeDir: ctx.homeDir, guard: ctx.guard, machineId: ctx.machineId });
}

async function discoverActivationRoles(ctx: Context): Promise<Exit | null> {
  const discovery = await discoverMigrationActivationRoles({
    ordinary: ctx.ordinary!,
    transferSettings: ctx.transferSettings,
    createTransferRuntime: ctx.deps.createTransferRuntime,
    readRoleIdentity: ctx.deps.readRoleIdentity,
    signal: ctx.input.signal,
  });
  if (discovery.status !== "resolved") {
    return refused(
      ctx,
      "S6",
      discovery.status === "unhealthy" ? "target-unhealthy" : "target-unresolvable",
      discovery.detail,
    );
  }
  ctx.ordinaryRole = discovery.ordinaryRole;
  ctx.transferRole = discovery.transferRole;
  return null;
}

// ---------------------------------------------------------------------------
// Leases (one per remote project, all under publicationId = set id)
// ---------------------------------------------------------------------------

function leaseBase(ctx: Context, member: Member) {
  return {
    projectId: member.remoteProjectId, machineId: ctx.machineId, publicationId: ctx.setId,
    targetBackend: "postgresql" as const, evidenceSha256: member.copyBindingSha256!,
  };
}

async function acquireMemberLease(ctx: Context, member: Member): Promise<string | null> {
  const base = { ...leaseBase(ctx, member), ttlMs: ctx.deps.leaseTtlMs, signal: ctx.input.signal };
  const acquired = await acquireActivationLease(ctx.guard!, base);
  if (acquired.status === "acquired") { member.fence = acquired.fence; return null; }
  if (acquired.status !== "expired-needs-takeover") return acquired.status === "conflict" ? "lease-conflict: " + acquired.detail : "lease-unresolvable: " + acquired.detail;
  const current = await ctx.guard!.read({ projectId: member.remoteProjectId, targetBackend: "postgresql", evidenceSha256: member.copyBindingSha256!, signal: ctx.input.signal });
  if (current === null) return "lease-unresolvable: the expired lease row vanished before takeover";
  const took = await takeoverActivationLease(ctx.guard!, { ...base, expectedFencingToken: current.fencingToken });
  if (took.status === "took-over") { member.fence = took.fence; return null; }
  return took.status === "conflict" ? "lease-conflict: " + took.detail : "lease-unresolvable: " + took.detail;
}

type LeaseContinuation =
  | Readonly<{ kind: "renewed"; fence: ActivationLeaseFence }>
  | Readonly<{ kind: "took-over"; fence: ActivationLeaseFence }>
  | Readonly<{ kind: "lost"; detail: string }>
  | Readonly<{ kind: "unresolvable"; detail: string }>;

async function continueMemberLease(ctx: Context, member: Member): Promise<LeaseContinuation> {
  const mutation = { ...leaseBase(ctx, member), signal: ctx.input.signal };
  let renewed: ActivationLeaseRenewResult = await renewActivationLease(ctx.guard!, { ...mutation, fencingToken: member.fence!.fencingToken, ttlMs: ctx.deps.leaseTtlMs });
  if (renewed.status === "stale-token") {
    renewed = await renewActivationLease(ctx.guard!, { ...mutation, fencingToken: renewed.fence.fencingToken, ttlMs: ctx.deps.leaseTtlMs });
  }
  if (renewed.status === "renewed") return { kind: "renewed", fence: renewed.fence };
  if (renewed.status === "expired") {
    const took = await takeoverActivationLease(ctx.guard!, { ...mutation, ttlMs: ctx.deps.leaseTtlMs, expectedFencingToken: renewed.fence.fencingToken });
    if (took.status === "took-over") return { kind: "took-over", fence: took.fence };
    return { kind: took.status === "unresolvable" ? "unresolvable" : "lost", detail: took.detail };
  }
  return { kind: renewed.status === "unresolvable" ? "unresolvable" : "lost", detail: renewed.detail };
}

/** Renew (or take over) every acquired lease; a takeover is reported per member for the caller to handle. */
async function continueAllLeases(ctx: Context): Promise<Step<readonly Member[]>> {
  const tookOver: Member[] = [];
  for (const member of ctx.members) {
    const continued = await continueMemberLease(ctx, member);
    if (continued.kind === "lost" || continued.kind === "unresolvable") {
      return refused(ctx, "S8", continued.kind === "lost" ? "lease-conflict" : "lease-unresolvable", at(member, continued.detail));
    }
    member.fence = continued.fence;
    if (continued.kind === "took-over") tookOver.push(member);
  }
  return ok(tookOver);
}

async function releaseMemberLease(ctx: Context, member: Member): Promise<string | null> {
  const mutation = { ...leaseBase(ctx, member), signal: AbortSignal.timeout(ctx.deps.leaseCleanupTimeoutMs) };
  try {
    let released: ActivationLeaseReleaseResult = await releaseActivationLease(ctx.guard!, { ...mutation, fencingToken: member.fence!.fencingToken });
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

/** Release every lease this call acquired (bounded, best effort, own signal); the failures ride the detail. */
async function releaseAcquiredLeases(ctx: Context): Promise<string | null> {
  const failures: string[] = [];
  for (const member of ctx.members) {
    if (member.fence === null) continue;
    const failure = await releaseMemberLease(ctx, member);
    if (failure !== null) failures.push(at(member, failure));
    member.fence = null;
  }
  return failures.length === 0 ? null : failures.join("; ");
}

/** True only when every member head is still its verified manifest with no pending effect (nothing of ours was written). */
function headsPositivelyUnbegun(ctx: Context): boolean {
  try {
    return ctx.members.every((member) => {
      const head = ctx.deps.manifestStore.read(member.generationId);
      return head.phase === "verified" && head.pendingEffect === null;
    });
  } catch {
    return false;
  }
}

/**
 * A refusal releases every lease this call acquired, and so does an
 * interruption whose member heads are positively unbegun (a checkpointed set
 * none of whose manifests moved): an unreleased row would block every other
 * publication of that project for good, and the next call of this set
 * reacquires or takes over its rows. Once a member effect exists the rows
 * are kept for the roll-forward. Failures ride the detail, never the status.
 */
async function withPreEffectLeasesReleased(ctx: Context, outcome: CutoverSetActivateResult): Promise<CutoverSetActivateResult> {
  if (ctx.guard === null) return outcome;
  const releasable = outcome.status === "refused" || (outcome.status === "interrupted" && headsPositivelyUnbegun(ctx));
  if (!releasable) return outcome;
  const failure = await releaseAcquiredLeases(ctx);
  if (failure === null) return outcome;
  return { ...outcome, detail: outcome.detail + "; activation leases were not released: " + failure };
}


// ---------------------------------------------------------------------------
// Pre-selection: independent member revalidation (D2), then the selection gate
// ---------------------------------------------------------------------------

/** Record one member's failed check; the member's remaining checks of that span are skipped, other members continue. */
function fail(member: Member, state: Exclude<Member["evidence"], null>, reason: string, detail: string): void {
  member.evidence = state;
  member.reason = reason;
  member.detail = detail;
}

/** decideCutoverSetSelection over the members' states; a refusal names every failing member. */
function gate(ctx: Context, step: MigrationActivationRefusalStep): Exit | null {
  const rows: CutoverSetMemberEvidence[] = [];
  for (const member of ctx.members) {
    if (member.evidence === "absent") continue;
    rows.push({ physicalProjectId: member.physicalProjectId, generationId: member.generationId, state: member.evidence ?? "current" });
  }
  const decision = decideCutoverSetSelection(ctx.manifest!, rows);
  if (decision.status === "eligible") return null;
  const detail = ctx.members
    .filter((member) => member.evidence !== null)
    .map((member) => member.generationId + " (" + member.reason + "): " + member.detail)
    .join("; ");
  return refused(ctx, step, decision.reason, detail, decision.failures);
}

type TargetFailure = Readonly<{ reason: string; detail: string }>;

/** A destination identity check: null when it matches, else a drift or a target failure to record on the member. */
type IdentityOutcome = Readonly<{ kind: "drift"; detail: string }> | Readonly<{ kind: "target"; failure: TargetFailure }> | null;

async function identityCheck(ctx: Context, member: Member, executor: PostgreSqlQueryExecutor, step: string): Promise<IdentityOutcome> {
  let live: MigrationDestinationIdentity;
  try {
    live = await ctx.deps.captureDestinationIdentity(executor, member.remoteProjectId, ctx.input.signal);
    assertDestinationIdentityMatches(
      live,
      {
        expectedDestinationIdentitySha256: member.manifest!.destination.identitySha256,
        expectedSystemIdentifier: member.report!.body.destinationIdentity.systemIdentifier,
      },
      member.manifest!.destination.identitySha256,
      member.manifest!.destination.systemIdentifier,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "MigrationVerificationDriverError") {
      return { kind: "drift", detail: "the live destination identity does not match the sealed manifest: " + error.message };
    }
    return { kind: "target", failure: targetFailure(error, step + " destination identity query") };
  }
  if (live.sealedWitnessSha256 !== member.report!.body.destinationIdentity.sealedWitnessSha256) {
    return { kind: "drift", detail: "the live destination identity does not match the verification report" };
  }
  return null;
}

/** Record an identity outcome on the member; true when the member failed. */
function recordIdentity(member: Member, outcome: IdentityOutcome): boolean {
  if (outcome === null) return false;
  if (outcome.kind === "drift") fail(member, "drifted", "identity-drift", outcome.detail);
  else fail(member, "unverifiable", outcome.failure.reason, outcome.failure.detail);
  return true;
}

/**
 * A target failure observed by S0, S5 or S7: the StorageOperationError
 * family, attributed exactly as S6 attributes the same failures. The
 * PostgreSQL portable source normalizes a storage failure to
 * PortableStreamError("source-unavailable") carrying the storage error as its
 * cause; that wrapper alone is unwrapped. Cancellation and every other error
 * are thrown.
 */
function targetFailure(error: unknown, stage: string): TargetFailure {
  const failure = error instanceof PortableStreamError && error.code === "source-unavailable" ? error.cause : error;
  if (!(failure instanceof StorageOperationError)) throw error;
  const attributed = classifyMigrationTargetFailure(failure, stage);
  return { reason: attributed.status === "unhealthy" ? "target-unhealthy" : "target-unresolvable", detail: attributed.reason + ": " + attributed.detail };
}

/** S7 for one member: a new transfer snapshot of that member's destination project, after the transfer schema check. */
async function memberCensus(ctx: Context, member: Member): Promise<void> {
  const transfer = ctx.deps.createTransferRuntime(ctx.transferSettings);
  try {
    let session: MigrationActivationSnapshot;
    try {
      await ctx.deps.verifyTransferSchema(transfer, {
        expectedOwner: ctx.expectedOwner,
        signal: ctx.input.signal,
        admittedPeer: { role: ctx.ordinaryRole!.role },
      });
      session = await transfer.openReadOnlySnapshot({ projectId: member.identity!.id, signal: ctx.input.signal });
    } catch (error) {
      const failure = targetFailure(error, "S7 transfer schema check and snapshot open");
      fail(member, "unverifiable", failure.reason, failure.detail);
      return;
    }
    try {
      if (recordIdentity(member, await identityCheck(ctx, member, session, "S7"))) return;
      let scratchParent: string;
      try {
        scratchParent = ctx.deps.allocateScratch(ctx.homeDir);
      } catch (error) {
        fail(member, "unverifiable", "state-unresolvable", "the census scratch directory could not be allocated: " + (error as Error).message);
        return;
      }
      let read: Awaited<ReturnType<MigrationActivationDependencies["readDestinationCensus"]>>;
      try {
        read = await ctx.deps.readDestinationCensus(session, {
          settings: ctx.transferSettings, expectedOwner: ctx.expectedOwner, expectedIdentity: member.identity!,
          scratchParent, signal: ctx.input.signal,
        });
      } catch (error) {
        const failure = targetFailure(error, "S7 census read");
        fail(member, "unverifiable", failure.reason, failure.detail);
        return;
      } finally {
        rmSync(scratchParent, { recursive: true, force: true });
      }
      member.censusVector = ctx.deps.census.buildMigrationCensusVector(read.census);
      member.canonicalDelta = ctx.deps.census.buildMigrationCanonicalDelta(read.census);
    } finally {
      await session.close();
    }
  } finally {
    await transfer.close();
  }
  const body = member.report!.body;
  if (!body.classCoverage.every((entry) => entry.ran)) {
    fail(member, "stale", "class-coverage-incomplete", "a reconciliation class did not run in the verification report");
  } else if (member.report!.mismatchTotals.length !== 0) {
    fail(member, "stale", "verification-mismatch", "the verification report records mismatches");
  } else if (!migrationCensusVectorsEqual(member.censusVector!, body.censusVector)) {
    fail(member, "stale", "census-drift", "the recomputed destination census differs from the verification report's census");
  }
}

/** The member's own classification on the pre-selection path: its manifest, report, frozen pair and link. */
function classifyMemberDurableState(ctx: Context, member: Member): Exit | null {
  const row = ctx.checkpoint?.members.find((candidate) => candidate.generationId === member.generationId) ?? null;
  const read = readMemberManifest(ctx, member);
  if (read.kind === "absent") { fail(member, "absent", "manifest-absent", "no migration manifest exists"); return null; }
  if (read.kind === "unresolvable") { fail(member, "unverifiable", "manifest-unresolvable", read.detail); return null; }
  const manifest = read.manifest;
  const pending = manifest.pendingEffect;
  if (row === null) {
    // Fresh: only a verified head with nothing pending is this set's to activate.
    if (manifest.phase !== "verified" || pending !== null) {
      fail(member, "stale", pending !== null ? "pending-effect-foreign" : "manifest-not-eligible",
        "the manifest is at phase " + manifest.phase + (pending === null ? "" : " with pending " + pending.kind));
      return null;
    }
  } else if (manifest.phase === "verified" && pending === null) {
    if (manifest.revision !== row.epochManifestRevision || manifest.checksumSha256 !== row.epochManifestChecksumSha256) {
      return interrupted(ctx, "S9", "evidence-conflict", at(member, "the verified manifest is not the checkpointed revision"));
    }
  } else if (manifest.phase === "activating" || (manifest.phase === "verified" && pending?.kind === "prepare-activation")) {
    if (pending !== null && pending.kind !== "prepare-activation" && pending.kind !== "publish-activation") {
      return interrupted(ctx, "S9", "state-unresolvable", at(member, "the pending effect " + pending.kind + " is not an activation effect"));
    }
  } else {
    return interrupted(ctx, "S9", "state-unresolvable", at(member, "the manifest is at phase " + manifest.phase + " under a checkpointed set"));
  }
  const verification = readMemberVerification(ctx, member, row?.verificationReportSha256 ?? null);
  if (verification !== null) {
    fail(member, verification.includes("could not be read") ? "unverifiable" : "stale",
      verification.includes("could not be read") ? "verification-unresolvable" : "verification-stale", verification);
    return null;
  }
  member.pair = row === null
    ? { epochManifestRevision: manifest.revision, epochManifestChecksumSha256: manifest.checksumSha256 }
    : { epochManifestRevision: row.epochManifestRevision, epochManifestChecksumSha256: row.epochManifestChecksumSha256 };
  const link = readMemberLink(ctx, member);
  if (link !== null) {
    if (row !== null) return interrupted(ctx, "S11", "link-conflict", at(member, link));
    fail(member, "unverifiable", "state-unresolvable", link);
    return null;
  }
  if (row === null && member.link !== null) {
    fail(member, "unverifiable", "state-unresolvable", "a generation link already names this set publication before any checkpoint");
    return null;
  }
  let witness: string;
  try {
    witness = ctx.deps.computeProjectMapWitness({
      homeDir: ctx.homeDir, localProjectId: member.physicalProjectId, remoteProjectId: member.remoteProjectId,
      mode: "pre-publication", publicationLockToken: ctx.token,
    });
  } catch (error) {
    if (!(error instanceof MigrationProjectMapWitnessError)) throw error;
    fail(member, error.reason === "project-map-drift" ? "drifted" : "unverifiable", error.reason === "project-map-drift" ? "project-map-drift" : "state-unresolvable", error.message);
    return null;
  }
  if (witness !== member.report!.body.projectMapWitnessSha256) {
    fail(member, "drifted", "project-map-drift", "the pre-publication project map witness differs from the verification report's");
  }
  return null;
}

async function preSelection(ctx: Context, held: BackendMaintenanceJournal): Promise<CutoverSetActivateResult> {
  ctx.resumedFrom = ctx.checkpoint === null ? "fresh" : ctx.selection === null ? "pre-selection" : "selection-frozen";
  const capacity = backendCutoverSetJournalCapacity(held.cutoverSet!);
  if (capacity.worstCaseBytes > capacity.limitBytes) {
    return refused(ctx, "S0", "cutover-set-too-large", "the set journal could reach " + capacity.worstCaseBytes
      + " bytes with its selection; the readable limit is " + capacity.limitBytes + "; the set stays held and abortable").exit;
  }
  // D2.2: the held-authority proof, under the retained token.
  const resolution = ctx.deps.resolveAuthorities({ homeDir: ctx.homeDir, lockToken: ctx.token });
  if (resolution.status === "unresolvable") {
    return refused(ctx, "S4", "cutover-set-enumeration-unresolvable", resolution.reason + ": " + resolution.detail).exit;
  }
  const unusable = resolution.outcomes.filter((outcome) => outcome.status !== "authenticated");
  if (unusable.length > 0) {
    return refused(ctx, "S4", "cutover-set-member-unverifiable", unusable.map((outcome) => outcome.physicalProjectId + " (" + outcome.status + ")").join("; ")).exit;
  }
  const heldIds = new Map(ctx.members.map((member) => [member.physicalProjectId, member.sourceSelectionSha256]));
  const present = new Set(resolution.outcomes.map((outcome) => outcome.physicalProjectId));
  const drifted = [...new Set([...heldIds.keys(), ...present])].filter((id) => heldIds.has(id) !== present.has(id)).sort();
  if (drifted.length > 0) return refused(ctx, "S4", "cutover-set-membership-drift", "stored-data projects differ from the held members: " + drifted.join(", ")).exit;
  const moved = resolution.outcomes
    .filter((outcome) => outcome.status === "authenticated" && outcome.authority.sourceSelectionSha256 !== heldIds.get(outcome.physicalProjectId))
    .map((outcome) => outcome.physicalProjectId).sort();
  if (moved.length > 0) return refused(ctx, "S4", "cutover-set-authority-drifted", "source selection differs from the held member for: " + moved.join(", ")).exit;
  // D2.3: coverage once (it may reconcile the map), then the exact set again.
  const coverage = ctx.deps.checkCoverage({ homeDir: ctx.homeDir, publicationLockToken: ctx.token });
  if (coverage.status === "unsatisfied") return refused(ctx, "S4", "coverage-unsatisfied", coverage.detail).exit;
  if (coverage.status === "unresolvable") return refused(ctx, "S4", "coverage-unresolvable", coverage.detail).exit;
  const inventory = ctx.deps.enumerateStoredData({ homeDir: ctx.homeDir, publicationLockToken: ctx.token });
  if (inventory.status === "unresolvable") return refused(ctx, "S4", "coverage-unresolvable", inventory.detail).exit;
  const after = [...inventory.projectHashes].sort();
  const expected = [...heldIds.keys()].sort();
  if (after.length !== expected.length || after.some((hash, index) => hash !== expected[index])) {
    return refused(ctx, "S4", "cutover-set-membership-drift", "stored-data projects changed during coverage reconciliation").exit;
  }
  // D2.4 and D2.7 (local part): paths, identities, target family, held binding, snapshot, manifest, report, link, map witness.
  for (const member of ctx.members) {
    const row = ctx.checkpoint?.members.find((candidate) => candidate.generationId === member.generationId) ?? null;
    let path: string | null;
    try {
      path = ctx.deps.readCanonicalPath({ homeDir: ctx.homeDir, hash: member.physicalProjectId });
    } catch (error) {
      fail(member, "unverifiable", "state-unresolvable", "the persisted canonical path could not be read: " + (error as Error).message);
      continue;
    }
    if (path === null) { fail(member, "unverifiable", "cutover-set-member-unmapped", "the project map has no persisted entry"); continue; }
    member.canonicalPath = path;
    const base = computeMigrationGenerationBase({ physicalProjectId: member.physicalProjectId, canonicalPath: path, target: ctx.coordinates });
    if (!generationIdBelongsToBase(base, member.generationId, ctx.maxProbeOrdinal)) {
      fail(member, "drifted", "cutover-set-target-changed", "the member generation does not belong to the family of its project, path and the supplied target");
      continue;
    }
    const identity = await ctx.deps.resolveExpectedIdentity({
      preflight: { targetConfig: ctx.input.targetConfig, machineId: ctx.machineId, candidate: { disposition: "continue-held" } },
      cwd: path, homeDir: ctx.homeDir,
    });
    if (identity.status === "refuse") { fail(member, "unverifiable", identity.reason, identity.evidence ?? identity.reason); continue; }
    if (identity.expectedIdentity.localProjectId !== member.physicalProjectId) {
      fail(member, "drifted", "cutover-set-member-identity", "the persisted identity names project " + identity.expectedIdentity.localProjectId);
      continue;
    }
    member.identity = identity.expectedIdentity;
    member.remoteProjectId = identity.expectedIdentity.remoteProjectId!;
    if (row !== null && row.remoteProjectId !== member.remoteProjectId) {
      return interrupted(ctx, "S9", "evidence-conflict", at(member, "the destination project differs from the checkpointed one")).exit;
    }
    const view = resolveBackendMaintenanceGenerationBinding(held, member.generationId)!;
    member.heldMemberChecksumSha256 = view.checksumSha256;
    if (row !== null && row.heldMemberChecksumSha256 !== view.checksumSha256) {
      return interrupted(ctx, "S9", "evidence-conflict", at(member, "the held member binding differs from the checkpointed one")).exit;
    }
    if (view.queueEvidenceSha256 === backendMaintenanceQueueEvidenceSentinel({ generationId: member.generationId, sourceSelectionSha256: member.sourceSelectionSha256 })) {
      fail(member, "absent", "cutover-set-member-unbound", "the member was never captured under this hold");
      continue;
    }
    let sealed: Awaited<ReturnType<typeof inspectAuthenticatedSqliteMigrationSnapshot>>;
    try {
      sealed = await ctx.deps.inspectSnapshot(member.generationId, ctx.homeDir);
    } catch (error) {
      fail(member, "unverifiable", "verification-unresolvable", "the sealed snapshot could not be authenticated: " + (error as Error).message);
      continue;
    }
    if (sealed.artifact.maintenanceChecksumSha256 !== view.checksumSha256
      || sealed.artifact.authority.physicalProjectId !== member.physicalProjectId
      || sealed.artifact.sourceSelectionSha256 !== member.sourceSelectionSha256) {
      fail(member, "drifted", "member-binding-drifted", "the sealed snapshot does not carry this member's held binding");
      continue;
    }
    const classified = classifyMemberDurableState(ctx, member);
    if (classified !== null) return classified.exit;
  }
  const local = gate(ctx, "S5");
  if (local !== null) return local.exit;
  openOrdinary(ctx);
  // S5 binds the daemon runtime session before any member lease can be
  // written. Role discovery then supplies the reciprocal S6/S7 peers once.
  for (const member of ctx.members) {
    recordIdentity(member, await identityCheck(ctx, member, ctx.ordinary!, "S5"));
  }
  const identified = gate(ctx, "S5");
  if (identified !== null) return identified.exit;
  const roles = await discoverActivationRoles(ctx);
  if (roles !== null) return roles.exit;
  // S0 per member: the copy binding digest read back from the transfer ledger, on its own transfer session.
  for (const member of ctx.members) {
    const row = ctx.checkpoint?.members.find((candidate) => candidate.generationId === member.generationId) ?? null;
    const transfer = ctx.deps.createTransferRuntime(ctx.transferSettings);
    try {
      const read: MigrationCopyBindingReadResult = await ctx.deps.readCopyBinding({
        executor: transfer, projectId: member.remoteProjectId, generationId: member.generationId, signal: ctx.input.signal,
      });
      if (read.state === "unresolvable") {
        fail(member, "unverifiable", "verification-unresolvable", "the copy binding digest could not be read back (" + read.reason + "): " + read.detail);
        continue;
      }
      member.copyBindingSha256 = read.evidenceSha256;
      if (row !== null && row.copyBindingSha256 !== read.evidenceSha256) {
        return interrupted(ctx, "S9", "evidence-conflict", at(member, "the copy binding digest differs from the checkpointed one")).exit;
      }
      recordIdentity(member, await identityCheck(ctx, member, transfer, "S0"));
    } finally {
      await transfer.close();
    }
  }
  const bound = gate(ctx, "S0");
  if (bound !== null) return bound.exit;
  // S2: one lease per remote project, in manifest order, all under the set id. Every member is tried so the
  // refusal names each independently failing one (F7); the gate releases whatever was acquired.
  for (const member of ctx.members) {
    const failure = await acquireMemberLease(ctx, member);
    if (failure !== null) fail(member, "unverifiable", failure.startsWith("lease-conflict") ? "lease-conflict" : "lease-unresolvable", failure);
  }
  const leased = gate(ctx, "S2");
  if (leased !== null) return leased.exit;
  // S3: set-aware quiescence, one envelope per member from its own view.
  for (const member of ctx.members) {
    const quiescence = await ctx.deps.checkSetQuiescence({ homeDir: ctx.homeDir, lockToken: ctx.token, generationId: member.generationId }, { now: ctx.now });
    if (quiescence.status === "satisfied") { member.quiescence = quiescence; continue; }
    if (quiescence.reason === "maintenance-journal-absent" || quiescence.reason === "maintenance-not-held" || quiescence.reason === "cutover-set-absent") {
      return refused(ctx, "S3", "maintenance-not-held", quiescence.detail).exit;
    }
    if (quiescence.reason === "maintenance-journal-unresolvable") return refused(ctx, "S3", "maintenance-unresolvable", quiescence.detail).exit;
    fail(member, "unverifiable", quiescence.status === "unsatisfied" ? "quiescence-unsatisfied" : "quiescence-unresolvable", quiescence.detail);
  }
  const quiet = gate(ctx, "S3");
  if (quiet !== null) return quiet.exit;
  // S6: health once for the one target.
  const health = await observeHealth(ctx);
  if (health.status !== "healthy") {
    return refused(ctx, "S6", health.status === "unhealthy" ? "target-unhealthy" : "target-unresolvable", health.reason + ": " + health.detail).exit;
  }
  // S7/S8 per member, sequentially; every lease is renewed after each member's census.
  for (const member of ctx.members) {
    if (ctx.input.signal?.aborted === true) return refused(ctx, "S7", "cancelled", "the activation was cancelled before member " + member.generationId + "'s census").exit;
    await memberCensus(ctx, member);
    const renewed = await continueAllLeases(ctx);
    if (isExit(renewed)) return renewed.exit;
  }
  const eligible = gate(ctx, "S8");
  if (eligible !== null) return eligible.exit;
  return effects(ctx, held);
}

function observeHealth(ctx: Context): Promise<MigrationTargetHealthResult> {
  return ctx.deps.checkTargetHealth(
    { runtime: ctx.ordinary!, expectedOwner: ctx.expectedOwner, signal: ctx.input.signal },
    {
      verifyRuntimeSchema: (executor, options) => ctx.deps.verifyRuntimeSchema(executor, {
        ...options,
        admittedPeer: { role: ctx.transferRole!.role },
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// Artifact, checkpoint, member effects, freeze and selection (D3-D5)
// ---------------------------------------------------------------------------

function isArtifactReadRefusal(error: unknown): error is Error {
  return error instanceof ActivationArtifactPresenceUnresolvableError
    || error instanceof ActivationArtifactIdentityMismatchError
    || error instanceof ActivationArtifactValidationError;
}

function artifactCoversMembers(ctx: Context, artifact: ActivationArtifactRecoveryMaterial): boolean {
  return artifact.publicationId === ctx.setId
    && artifact.projects.length === ctx.members.length
    && artifact.projects.every((row, index) => {
      const member = ctx.members[index]!;
      return row.localProjectId === member.physicalProjectId && row.remoteProjectId === member.remoteProjectId && row.evidenceSha256 === member.copyBindingSha256;
    });
}

/** Read the artifact a checkpoint or frozen selection names; never recompose material after a checkpoint. */
function readCheckpointedArtifact(ctx: Context): Exit | null {
  let artifact: ActivationArtifactRecoveryMaterial | null;
  try {
    artifact = ctx.deps.readArtifact({ homeDir: ctx.homeDir, identityDigest: ctx.identityDigest! });
  } catch (error) {
    if (isArtifactReadRefusal(error)) return interrupted(ctx, "S11", "artifact-unresolvable", error.message);
    throw error;
  }
  if (artifact === null) return interrupted(ctx, "S11", "state-unresolvable", "the checkpointed artifact is absent");
  if (!artifactCoversMembers(ctx, artifact)) return interrupted(ctx, "S11", "artifact-identity-mismatch", "the checkpointed artifact does not cover exactly the set's members");
  ctx.artifact = artifact;
  return null;
}

function evidenceFailure(ctx: Context, step: MigrationActivationInterruptionStep, error: unknown, member: Member | null): Exit {
  const prefix = member === null ? "" : member.generationId + ": ";
  if (error instanceof MigrationActivationEvidenceRefusalError) {
    return interrupted(ctx, step, error.reason === "evidence-unresolvable" ? "evidence-unresolvable" : "evidence-conflict", prefix + error.message);
  }
  if (error instanceof Error && (error.name === "MigrationBindingConflictError" || error.name === "CutoverSetActivationRecordError")) {
    return interrupted(ctx, step, "evidence-conflict", prefix + error.message);
  }
  if (error instanceof Error && error.name === "MigrationBindingUnresolvableError") return interrupted(ctx, step, "evidence-unresolvable", prefix + error.message);
  throw error;
}

/** epoch -> attempt -> witness -> witness binding for one member, in the mandatory order; idempotent. */
function recordMemberEvidence(ctx: Context, member: Member, step: MigrationActivationInterruptionStep): Exit | null {
  try {
    ctx.deps.evidence.recordMigrationActivationEpoch({ homeDir: ctx.homeDir, epoch: member.epoch! });
    crash(ctx, "after-epoch:" + member.generationId);
    ctx.deps.evidence.recordMigrationActivationAttempt({ homeDir: ctx.homeDir, generationId: member.generationId, attempt: member.attempt!, nextWitness: member.witness! });
    crash(ctx, "after-attempt:" + member.generationId);
    ctx.deps.evidence.recordMigrationActivationWitness({ homeDir: ctx.homeDir, generationId: member.generationId, witness: member.witness! });
    crash(ctx, "after-witness:" + member.generationId);
    ctx.deps.bindings.recordMigrationWitnessBinding({
      homeDir: ctx.homeDir, generationId: member.generationId,
      binding: {
        kind: "activation", epochId: member.epoch!.epochId, attemptId: member.attempt!.attemptId,
        manifestRevision: member.pair!.epochManifestRevision, witnessChecksumSha256: member.witness!.checksumSha256,
      },
    });
    crash(ctx, "after-witness-binding:" + member.generationId);
  } catch (error) {
    return evidenceFailure(ctx, step, error, member);
  }
  return null;
}

/** Adopt the member's frozen attempt from the evidence store (D4: never a new attempt once frozen). */
function adoptMemberAttempt(ctx: Context, member: Member): Exit | null {
  let stored: MigrationActivationEvidenceResolution;
  try {
    stored = ctx.deps.evidence.readMigrationActivationEvidence({ homeDir: ctx.homeDir, generationId: member.generationId });
  } catch (error) {
    return interrupted(ctx, "S12", "evidence-unresolvable", at(member, (error as Error).message));
  }
  if (stored.state !== "resolved") {
    return interrupted(ctx, "S12", stored.state === "unresolvable" ? "evidence-unresolvable" : "state-unresolvable",
      at(member, stored.state === "unresolvable" ? stored.reason : "no activation evidence is stored for a frozen member"));
  }
  const witness = stored.witnesses.find((candidate) => candidate.checksumSha256 === member.frozen!.witnessChecksumSha256) ?? null;
  const attempt = witness === null ? null : stored.attempts.find((candidate) => candidate.attemptId === witness.attemptId) ?? null;
  const epoch = attempt === null ? null : stored.epochs.find((candidate) => candidate.epochId === attempt.epochId) ?? null;
  if (witness === null || attempt === null || epoch === null || attempt.attemptId !== member.frozen!.attemptId || epoch.epochId !== member.frozen!.epochId) {
    return interrupted(ctx, "S12", "state-unresolvable", at(member, "the frozen selection row does not name a stored epoch, attempt and witness"));
  }
  if (epochFor(member).epochId !== epoch.epochId) {
    return interrupted(ctx, "S12", "evidence-conflict", at(member, "the stored epoch is not the epoch the checkpoint and report derive"));
  }
  member.epoch = epoch;
  member.attempt = attempt;
  member.witness = witness;
  return null;
}

function buildSelection(ctx: Context): BackendCutoverSetSelection {
  const body = {
    version: 1 as const,
    kind: "cutover-set-selection" as const,
    checkpointSha256: ctx.checkpoint!.checksumSha256,
    setId: ctx.setId,
    manifestSha256: backendCutoverSetManifestSha256(ctx.manifest!),
    publicationId: ctx.setId,
    identityDigest: ctx.identityDigest!,
    sourceBackend: "sqlite" as const,
    targetBackend: "postgresql" as const,
    members: ctx.members.map((member): BackendCutoverSetSelectionMember => ({
      physicalProjectId: member.physicalProjectId, generationId: member.generationId, remoteProjectId: member.remoteProjectId,
      copyBindingSha256: member.copyBindingSha256!, epochId: member.epoch!.epochId, attemptId: member.attempt!.attemptId,
      epochManifestRevision: member.pair!.epochManifestRevision, epochManifestChecksumSha256: member.pair!.epochManifestChecksumSha256,
      witnessChecksumSha256: member.witness!.checksumSha256,
    })),
  };
  return { ...body, checksumSha256: backendCutoverSetSelectionSha256(body) };
}

async function effects(ctx: Context, held: BackendMaintenanceJournal): Promise<CutoverSetActivateResult> {
  // Artifact and checkpoint (D3): composed once before the first effect; never recomposed after the checkpoint.
  if (ctx.checkpoint === null) {
    const bindings = ctx.members.map(projectBinding);
    const composed = ctx.deps.composeMaterial({ homeDir: ctx.homeDir, targetBackend: "postgresql", bindings });
    ctx.material = composed;
    ctx.identityDigest = computeActivationArtifactIdentityDigest({ source: composed.material.source, target: composed.material.target, projects: bindings });
    let existing: ActivationArtifactRecoveryMaterial | null;
    try {
      existing = ctx.deps.readArtifact({ homeDir: ctx.homeDir, identityDigest: ctx.identityDigest });
    } catch (error) {
      if (isArtifactReadRefusal(error)) return refused(ctx, "S0", "state-unresolvable", error.message).exit;
      throw error;
    }
    if (existing !== null && !artifactCoversMembers(ctx, existing)) {
      // An orphan under the recomputed digest (no member effect has begun) that was sealed for another publication.
      return refused(ctx, "S0", "state-unresolvable", "an artifact under the recomputed identity digest was sealed under another publication").exit;
    }
    if (existing === null) {
      const published = ctx.deps.publishArtifact({
        homeDir: ctx.homeDir,
        material: { version: 1, publicationId: ctx.setId, source: composed.material.source, target: composed.material.target, projects: bindings },
      });
      if (published.identityDigest !== ctx.identityDigest) {
        return refused(ctx, "S0", "state-unresolvable", "the published artifact's identity digest differs from the composed digest").exit;
      }
      ctx.artifact = published.material;
    } else {
      ctx.artifact = existing;
    }
    crash(ctx, "after-artifact");
    const checkpoint = createCutoverSetActivationCheckpoint({
      setId: ctx.setId, manifest: ctx.manifest!, heldJournalChecksumSha256: held.checksumSha256, publicationId: ctx.setId, identityDigest: ctx.identityDigest,
      members: ctx.members.map((member) => ({
        physicalProjectId: member.physicalProjectId, generationId: member.generationId, remoteProjectId: member.remoteProjectId,
        heldMemberChecksumSha256: member.heldMemberChecksumSha256!, copyBindingSha256: member.copyBindingSha256!,
        epochManifestRevision: member.pair!.epochManifestRevision, epochManifestChecksumSha256: member.pair!.epochManifestChecksumSha256,
        verificationReportSha256: member.report!.reportSha256,
      })),
    });
    try {
      ctx.deps.recordCheckpoint({ homeDir: ctx.homeDir, checkpoint });
    } catch (error) {
      return evidenceFailure(ctx, "S9", error, null).exit;
    }
    ctx.checkpoint = checkpoint;
    ctx.effectBegun = true;
    crash(ctx, "after-checkpoint");
  } else {
    ctx.identityDigest = ctx.checkpoint.identityDigest;
    const artifact = readCheckpointedArtifact(ctx);
    if (artifact !== null) return artifact.exit;
  }
  // D5: per-member effects in manifest order; each member's evidence from its own view, never derived from a sibling's.
  for (const member of ctx.members) {
    member.frozen = ctx.selection?.members.find((candidate) => candidate.generationId === member.generationId) ?? null;
    member.epoch = epochFor(member);
    if (member.frozen !== null) {
      const adopted = adoptMemberAttempt(ctx, member);
      if (adopted !== null) return adopted.exit;
      // A frozen member whose lease was taken over at S2 of this call: the token may advance, never regress.
      if (member.fence!.fencingToken.toString(10) !== member.attempt!.selectionAuthority.fencingToken) {
        if (BigInt(member.fence!.fencingToken) < BigInt(member.attempt!.selectionAuthority.fencingToken)) {
          return interrupted(ctx, "S12", "lease-lost", at(member, "the fenced lease token regressed below the frozen selection authority")).exit;
        }
        member.successorFencingToken = member.fence!.fencingToken.toString(10);
      }
    } else {
      member.attempt = attemptFor(ctx, member);
      member.witness = witnessFor(member);
    }
    const begun = beginMemberEffects(ctx, member);
    if (begun !== null) return begun.exit;
    if (member.link === null) {
      try {
        const recorded = ctx.deps.recordLink({
          homeDir: ctx.homeDir, generationId: member.generationId, publicationId: ctx.setId, identityDigest: ctx.identityDigest!,
          epochManifestRevision: member.pair!.epochManifestRevision, epochManifestChecksumSha256: member.pair!.epochManifestChecksumSha256,
        });
        member.link = recorded.link;
        crash(ctx, "after-link:" + member.generationId);
      } catch (error) {
        if (error instanceof ActivationGenerationLinkConflictError) return interrupted(ctx, "S11", "link-conflict", at(member, error.message)).exit;
        if (error instanceof ActivationArtifactPresenceUnresolvableError) return interrupted(ctx, "S11", "artifact-unresolvable", at(member, error.message)).exit;
        throw error;
      }
    }
    const recorded = recordMemberEvidence(ctx, member, "S11");
    if (recorded !== null) return recorded.exit;
  }
  // Renew every lease before the freeze; an expired one is taken over, which mints a new attempt only while unfrozen.
  const renewed = await continueAllLeases(ctx);
  if (isExit(renewed)) return renewed.exit;
  for (const member of renewed.value) {
    if (member.frozen !== null) {
      if (BigInt(member.fence!.fencingToken) < BigInt(member.attempt!.selectionAuthority.fencingToken)) {
        return interrupted(ctx, "S12", "lease-lost", at(member, "the fenced lease token regressed below the frozen selection authority")).exit;
      }
      member.successorFencingToken = member.fence!.fencingToken.toString(10);
      continue;
    }
    member.attempt = attemptFor(ctx, member);
    member.witness = witnessFor(member);
    const rerecorded = recordMemberEvidence(ctx, member, "S12");
    if (rerecorded !== null) return rerecorded.exit;
  }
  // D4: freeze the selection from the actual stored witnesses, before the journal's selection phases.
  if (ctx.selection === null) {
    const selection = buildSelection(ctx);
    try {
      ctx.deps.recordSelection({ homeDir: ctx.homeDir, selection });
    } catch (error) {
      return evidenceFailure(ctx, "S12", error, null).exit;
    }
    ctx.selection = selection;
    for (const member of ctx.members) member.frozen = selection.members.find((candidate) => candidate.generationId === member.generationId)!;
    crash(ctx, "after-selection-frozen");
  }
  // S12: one set selection carrying the complete tuple.
  const selected = await stepSelection(ctx);
  if (isExit(selected)) return selected.exit;
  return finishAfterSelection(ctx, null);
}

/** S9 and S10 for one member: prepare-activation begin/complete and publish-activation begin, retry-idempotent. */
function beginMemberEffects(ctx: Context, member: Member): Exit | null {
  const ids = effectIds(member.epoch!.epochId);
  let manifest = member.manifest!;
  try {
    if (manifest.phase === "verified") {
      if (manifest.pendingEffect === null) {
        manifest = ctx.deps.manifestStore.update(member.generationId, manifest.checksumSha256, (head) =>
          beginMigrationEffect(head, { effectId: ids.prepare, kind: "prepare-activation", inputSha256: ids.inputSha256, startedAt: ctx.now().toISOString() }));
        crash(ctx, "after-prepare-begin:" + member.generationId);
      }
      if (manifest.pendingEffect?.kind !== "prepare-activation" || manifest.pendingEffect.effectId !== ids.prepare) {
        return interrupted(ctx, "S9", "state-unresolvable", at(member, "the pending effect is not this activation's prepare-activation"));
      }
      manifest = ctx.deps.manifestStore.update(member.generationId, manifest.checksumSha256, (head) =>
        completeMigrationEffect(head, { effectId: ids.prepare, completedAt: ctx.now().toISOString() }));
      crash(ctx, "after-prepare-complete:" + member.generationId);
    }
    if (manifest.pendingEffect === null) {
      manifest = ctx.deps.manifestStore.update(member.generationId, manifest.checksumSha256, (head) =>
        beginMigrationEffect(head, { effectId: ids.publish, kind: "publish-activation", inputSha256: ids.inputSha256, startedAt: ctx.now().toISOString() }));
      crash(ctx, "after-publish-begin:" + member.generationId);
    }
  } catch (error) {
    if (error instanceof MigrationProtocolError) return interrupted(ctx, "S9", "state-unresolvable", at(member, "the activation effects could not be driven: " + error.message));
    throw error;
  }
  if (manifest.pendingEffect?.kind !== "publish-activation" || manifest.pendingEffect.effectId !== ids.publish) {
    return interrupted(ctx, "S10", "state-unresolvable", at(member, "the pending effect is not this activation's publish-activation"));
  }
  member.manifest = manifest;
  return null;
}

async function stepSelection(ctx: Context): Promise<Step<BackendMaintenanceJournal>> {
  let journal: BackendMaintenanceJournal | null;
  try {
    journal = ctx.deps.readMaintenanceJournal(ctx.homeDir);
  } catch (error) {
    return interrupted(ctx, "S12", "journal-unexpected", "the maintenance journal could not be read: " + (error as Error).message);
  }
  if (journal === null || journal.cutoverSet === undefined || journal.generationId !== ctx.setId || journal.sourceBackend !== "sqlite") {
    return interrupted(ctx, "S12", "journal-unexpected", journal === null ? "no maintenance journal exists" : "the maintenance journal is not this set's sqlite hold");
  }
  const selection = ctx.selection!;
  try {
    if (journal.phase === "maintenance-held") {
      journal = await ctx.coordinator!.prepareMaintenanceSelection(
        {
          expectedChecksumSha256: journal.checksumSha256, generationId: ctx.setId, targetBackend: "postgresql",
          terminalEvidenceSha256: selection.checksumSha256, cutoverSetSelection: selection,
        },
        ctx.token,
      );
      crash(ctx, "after-selection-prepared");
    }
    // Reached at selection-prepared: freshly prepared above, or resumed there. Completion compares the
    // CAS checksum, the set id and the tuple's checksum again, so any other phase refuses through it.
    if (journal.terminalEvidenceSha256 !== selection.checksumSha256) {
      return interrupted(ctx, "S12", "journal-unexpected", "the prepared selection carries another tuple's checksum");
    }
    journal = await ctx.coordinator!.completeMaintenanceSelection(
      { expectedChecksumSha256: journal.checksumSha256, generationId: ctx.setId, terminalEvidenceSha256: selection.checksumSha256 },
      ctx.token,
    );
    crash(ctx, "after-selection-completed");
  } catch (error) {
    if (error instanceof Error && error.name === "BackendPublicationJournalError") return interrupted(ctx, "S12", "journal-unexpected", error.message);
    throw error;
  }
  if (journal.phase !== "selection-completed") return interrupted(ctx, "S12", "journal-unexpected", "the maintenance journal is at phase " + journal.phase);
  return ok(journal);
}


// ---------------------------------------------------------------------------
// Post-selection: bindings, one drive, health, per-member settlement (C4)
// ---------------------------------------------------------------------------

const NO_OWN_FENCE_PHASES: ReadonlySet<BackendPublicationJournal["phase"]> = new Set([
  "releasing", "released", "completed", "aborting", "config-restoring", "map-restoring", "abort-releasing", "aborted",
]);
const SUCCESSOR_ROW_PHASES: ReadonlySet<BackendPublicationJournal["phase"]> = new Set(["released", "completed"]);
/** The release window (Bug #1651): see activate-generation.ts RELEASE_WINDOW_PHASES. */
const RELEASE_WINDOW_PHASES: ReadonlySet<BackendPublicationJournal["phase"]> = new Set(["releasing", "abort-releasing"]);

/** S13a for one member: its selection binding, an index onto the aggregate selection. */
function recordMemberSelectionBinding(ctx: Context, member: Member): Exit | null {
  try {
    ctx.deps.bindings.recordMigrationSelectionBinding({
      homeDir: ctx.homeDir, generationId: member.generationId,
      binding: {
        kind: "activation", epochId: member.epoch!.epochId, attemptId: member.attempt!.attemptId,
        manifestRevision: member.pair!.epochManifestRevision, witnessChecksumSha256: member.witness!.checksumSha256, publicationId: ctx.setId,
      },
    });
    crash(ctx, "after-selection-binding:" + member.generationId);
  } catch (error) {
    if (error instanceof Error && error.name === "MigrationBindingConflictError") return interrupted(ctx, "S13a", "binding-conflict", at(member, error.message));
    if (error instanceof Error && error.name === "MigrationBindingUnresolvableError") return interrupted(ctx, "S13a", "binding-unresolvable", at(member, error.message));
    throw error;
  }
  return null;
}

async function restartVerdict(ctx: Context): Promise<ActivationRestartCheckResult> {
  try {
    return await ctx.deps.checkRestart({ selectedBackend: "postgresql", pidFilePath: daemonPidPath(ctx.homeDir), port: ctx.deps.daemonPort(ctx.homeDir) });
  } catch (error) {
    return Object.freeze({
      status: "unresolvable", reason: "health-unreachable",
      detail: "the restart check could not observe the daemon: " + (error as Error).message,
      pid: null, observedBackend: null, selectedBackend: "postgresql",
    });
  }
}

async function finishAfterSelection(ctx: Context, ownV2: BackendPublicationJournal | null): Promise<CutoverSetActivateResult> {
  for (const member of ctx.members) {
    if (member.manifest?.phase === "active") continue;
    const bound = recordMemberSelectionBinding(ctx, member);
    if (bound !== null) return bound.exit;
  }
  // S13b: lease continuation for every member unless the coordinator owns the fences for this version-2 phase
  // (A3). Without an own version-2 journal the slot holds this set's selection-completed journal and every
  // member's fence was acquired or resolved by this call.
  const coordinatorOwnsFences = ownV2 !== null && NO_OWN_FENCE_PHASES.has(ownV2.phase);
  if (!coordinatorOwnsFences) {
    for (const member of ctx.members) {
      const continued = await continueMemberLease(ctx, member);
      if (continued.kind === "lost" || continued.kind === "unresolvable") {
        return interrupted(ctx, "S13b", continued.kind === "lost" ? "lease-lost" : "lease-unresolvable", at(member, continued.detail)).exit;
      }
      if (continued.kind === "took-over") {
        if (BigInt(continued.fence.fencingToken) < BigInt(member.attempt!.selectionAuthority.fencingToken)) {
          return interrupted(ctx, "S13b", "lease-lost", at(member, "the fenced lease token regressed below the recorded selection authority")).exit;
        }
        member.successorFencingToken = continued.fence.fencingToken.toString(10);
      }
      member.fence = continued.fence;
    }
  }
  const result = await ctx.deps.drive(ctx.guard!, ctx.coordinator!, {
    homeDir: ctx.homeDir, lockToken: ctx.token, publicationId: ctx.setId, sourceBackend: "sqlite", targetBackend: "postgresql",
    identityDigest: ctx.identityDigest!, projects: ctx.artifact!.projects, signal: ctx.input.signal,
  });
  crash(ctx, "after-drive");
  if (result.status === "aborted") {
    return { status: "publication-failed", setId: ctx.setId, publicationId: ctx.setId, publication: result, members: memberResults(ctx) };
  }
  if (result.status !== "completed") {
    // C4 (F3): only a confirmed abort is publication-failed. Any other driver outcome left the selection, the member
    // evidence and the journal as they were; the next call resumes from them.
    return interrupted(ctx, "S13b", DRIVE_INTERRUPTION_CAUSES[result.status], "the publication driver returned " + result.status + ": " + result.detail).exit;
  }
  // S15: observed once for the home, never refused; an unhealthy target stops before any member report or completion (C4).
  const health = await observeHealth(ctx);
  const restart = await restartVerdict(ctx);
  if (health.status !== "healthy") {
    return { status: "post-publication-unhealthy", setId: ctx.setId, publicationId: ctx.setId, health, restart, members: memberResults(ctx) };
  }
  // S16: the completed publication is read back once, then each member settles from its own evidence.
  let completed: BackendPublicationJournal | null;
  try {
    completed = ctx.deps.readPublicationJournal(ctx.homeDir);
  } catch (error) {
    return interrupted(ctx, "S16", "readback-mismatch", "the publication journal could not be re-read: " + (error as Error).message).exit;
  }
  if (completed === null || completed.publicationId !== ctx.setId || completed.phase !== "completed") {
    return interrupted(ctx, "S16", "readback-mismatch", "the publication journal is not this set's completed journal").exit;
  }
  for (const member of ctx.members) {
    const settled = settleMember(ctx, member);
    if (settled !== null) return settled.exit;
  }
  return {
    status: "activated", setId: ctx.setId, publicationId: ctx.setId, members: memberResults(ctx), restart,
    resumedFrom: ctx.resumedFrom,
  };
}

/** How each non-terminal driver outcome is attributed when the set's publication did not complete or abort (F3). */
const DRIVE_INTERRUPTION_CAUSES: Record<Exclude<ActivationPublicationStatus, "completed" | "aborted">, MigrationActivationInterruptionCause> = {
  "fence-unsatisfied": "lease-lost",
  "fence-unresolvable": "lease-unresolvable",
  "publication-collision": "journal-unexpected",
  "artifact-missing": "artifact-unresolvable",
  "artifact-unresolvable": "artifact-unresolvable",
  "artifact-identity-mismatch": "artifact-identity-mismatch",
  "duplicate-publication-input": "journal-unexpected",
  "publication-unresolvable": "state-unresolvable",
  "maintenance-in-flight": "journal-unexpected",
};

/** Whether a member's active manifest carries an authenticated activation report of this set's publication and witness. */
function activeReportAuthenticates(ctx: Context, member: Member, witnessChecksumSha256: string): string | null {
  const ref = latestReport(member.manifest!, "activation");
  const read = ctx.deps.readReport({ homeDir: ctx.homeDir, generationId: member.generationId, reportSha256: ref.reportSha256 });
  if (read.state !== "resolved") return "the stored activation report is " + read.state + ": " + read.detail;
  const body = read.report.body;
  if (body.publicationId !== ctx.setId || body.identityDigest !== ctx.identityDigest || body.witnessChecksumSha256 !== witnessChecksumSha256) {
    return "the stored activation report does not name this set publication, identity digest and witness";
  }
  return null;
}

/** S16 for one member: readback, post-publication witness, deterministic report, effect completion; already-active members authenticate and skip. */
function settleMember(ctx: Context, member: Member): Exit | null {
  const read = readMemberManifest(ctx, member);
  if (read.kind !== "read") return interrupted(ctx, "S16", "state-unresolvable", at(member, "the manifest could not be re-read"));
  const manifest = read.manifest;
  // An already-active member was authenticated against its report when the frozen selection was adopted.
  if (manifest.phase === "active") return null;
  const ids = effectIds(member.epoch!.epochId);
  if (manifest.phase !== "activating" || manifest.pendingEffect?.kind !== "publish-activation" || manifest.pendingEffect.effectId !== ids.publish) {
    return interrupted(ctx, "S16", "readback-mismatch", at(member, "the manifest is not activating with this activation's pending publish-activation"));
  }
  let bindings: MigrationWitnessResolution;
  try {
    bindings = ctx.deps.bindings.resolveMigrationWitnessBindings({ homeDir: ctx.homeDir, generationId: member.generationId });
  } catch (error) {
    return interrupted(ctx, "S16", "binding-unresolvable", at(member, (error as Error).message));
  }
  if (bindings.state !== "resolved" || !bindings.selections.some((selection) => selection.kind === "activation" && selection.publicationId === ctx.setId)) {
    return interrupted(ctx, "S16", "readback-mismatch", at(member, "the selection binding for this activation is not resolved"));
  }
  let post: string;
  try {
    post = ctx.deps.computeProjectMapWitness({
      homeDir: ctx.homeDir, localProjectId: member.physicalProjectId, remoteProjectId: member.remoteProjectId, mode: "post-publication", publicationLockToken: ctx.token,
    });
  } catch (error) {
    if (!(error instanceof MigrationProjectMapWitnessError)) throw error;
    return interrupted(ctx, "S16", error.reason === "project-map-drift" ? "project-map-drift" : "state-unresolvable", at(member, error.message));
  }
  if (post !== member.report!.body.projectMapWitnessSha256) {
    return interrupted(ctx, "S16", "project-map-drift", at(member, "the post-publication project map witness differs from the verified witness"));
  }
  const report = createMigrationActivationReport({
    generationId: member.generationId, epochId: member.epoch!.epochId, attemptId: member.attempt!.attemptId,
    witnessChecksumSha256: member.witness!.checksumSha256, publicationId: ctx.setId, identityDigest: ctx.identityDigest!,
    manifestRevisionAtComplete: manifest.revision, postPublicationProjectMapWitnessSha256: post, createdAt: manifest.pendingEffect.startedAt,
  });
  let persisted: MigrationActivationReportPersistResult;
  try {
    persisted = ctx.deps.persistReport({ homeDir: ctx.homeDir, generationId: member.generationId, report });
    crash(ctx, "after-report:" + member.generationId);
  } catch (error) {
    if (error instanceof MigrationActivationReportError) {
      return interrupted(ctx, "S16", error.reason === "identity-conflict" ? "report-conflict" : "report-unresolvable", at(member, error.message));
    }
    throw error;
  }
  const reference = migrationActivationReportReference(persisted.report);
  try {
    member.manifest = ctx.deps.manifestStore.update(member.generationId, manifest.checksumSha256, (head) =>
      completeMigrationEffect(head, { effectId: ids.publish, completedAt: ctx.now().toISOString(), report: reference }));
    crash(ctx, "after-complete:" + member.generationId);
  } catch (error) {
    if (error instanceof MigrationProtocolError) return interrupted(ctx, "S16", "state-unresolvable", at(member, "publish-activation could not be completed: " + error.message));
    throw error;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recovery after the selection was frozen (C1 rows)
// ---------------------------------------------------------------------------

/**
 * Adopt the frozen tuple for every member: the checkpointed revision, report
 * and copy binding, the shared artifact, the member's own stored epoch,
 * attempt and witness, its generation link and its durable manifest state
 * (pending publish-activation of this epoch, or active with a report of this
 * set). Nothing is composed or minted here.
 */
async function adoptFrozenSelection(ctx: Context): Promise<Step<true>> {
  const selection = ctx.selection!;
  const checkpoint = ctx.checkpoint!;
  ctx.identityDigest = selection.identityDigest;
  for (const member of ctx.members) {
    const row = checkpoint.members.find((candidate) => candidate.generationId === member.generationId)!;
    member.frozen = selection.members.find((candidate) => candidate.generationId === member.generationId)!;
    member.remoteProjectId = row.remoteProjectId;
    member.copyBindingSha256 = row.copyBindingSha256;
    member.pair = { epochManifestRevision: row.epochManifestRevision, epochManifestChecksumSha256: row.epochManifestChecksumSha256 };
  }
  const artifact = readCheckpointedArtifact(ctx);
  if (artifact !== null) return artifact;
  for (const member of ctx.members) {
    const row = checkpoint.members.find((candidate) => candidate.generationId === member.generationId)!;
    const read = readMemberManifest(ctx, member);
    if (read.kind !== "read") return interrupted(ctx, "S16", "state-unresolvable", at(member, read.kind === "absent" ? "the manifest is absent" : read.detail));
    const verification = readMemberVerification(ctx, member, row.verificationReportSha256);
    if (verification !== null) return interrupted(ctx, "S16", "state-unresolvable", at(member, verification));
    const link = readMemberLink(ctx, member);
    if (link !== null) return interrupted(ctx, "S11", "link-conflict", at(member, link));
    if (member.link === null) return interrupted(ctx, "S11", "state-unresolvable", at(member, "no generation link records the set publication"));
    const adopted = adoptMemberAttempt(ctx, member);
    if (adopted !== null) return adopted;
    const manifest = read.manifest;
    const ids = effectIds(member.epoch!.epochId);
    if (manifest.phase === "active") {
      const failure = activeReportAuthenticates(ctx, member, member.witness!.checksumSha256);
      if (failure !== null) return interrupted(ctx, "S16", "report-conflict", at(member, failure));
      continue;
    }
    if (manifest.phase !== "activating" || manifest.pendingEffect?.kind !== "publish-activation" || manifest.pendingEffect.effectId !== ids.publish) {
      return interrupted(ctx, "S10", "state-unresolvable", at(member, "the frozen selection names a member that is not activating with its pending publish-activation"));
    }
  }
  return ok(true);
}

/** Resume at or after the journal's selection phases, or from this set's own version-2 publication. */
async function postSelection(ctx: Context, v3: BackendMaintenanceJournal | null, ownV2: BackendPublicationJournal | null): Promise<CutoverSetActivateResult> {
  if (ctx.selection === null) {
    return interrupted(ctx, "S12", "state-unresolvable", "a selection exists for this set but no frozen selection tuple is stored").exit;
  }
  if (v3 !== null && v3.cutoverSet!.selection?.checksumSha256 !== ctx.selection.checksumSha256) {
    return interrupted(ctx, "S12", "journal-unexpected", "the journal's selection tuple is not the frozen one").exit;
  }
  ctx.resumedFrom = ownV2 !== null ? "publication-journal" : v3!.phase === "selection-prepared" ? "selection-prepared" : "selection-completed";
  const adopted = await adoptFrozenSelection(ctx);
  if (isExit(adopted)) return adopted.exit;
  if (ctx.members.every((member) => member.manifest!.phase === "active") && (ownV2 === null || ownV2.phase === "completed")) {
    return settledActive(ctx, "settled-active");
  }
  const fences = await resolveMemberFences(ctx, ownV2);
  if (fences !== null) return fences.exit;
  if (ownV2 === null && v3!.phase === "selection-prepared") {
    const selected = await stepSelection(ctx);
    if (isExit(selected)) return selected.exit;
  }
  return finishAfterSelection(ctx, ownV2);
}

/**
 * Re-read each pending member's lease row to continue from: the row this
 * set holds, positively no row (lost unless the coordinator owns the fences
 * for this publication phase), or a row of another publication (lost unless
 * this publication already released its own or is finishing that release).
 * Never acquires or takes over.
 */
async function resolveMemberFences(ctx: Context, ownV2: BackendPublicationJournal | null): Promise<Exit | null> {
  openOrdinary(ctx);
  for (const member of ctx.members) {
    if (member.manifest!.phase === "active") continue;
    recordIdentity(member, await identityCheck(ctx, member, ctx.ordinary!, "S5"));
  }
  const identified = gate(ctx, "S5");
  if (identified !== null) return identified;
  const roles = await discoverActivationRoles(ctx);
  if (roles !== null) return roles;
  for (const member of ctx.members) {
    if (member.manifest!.phase === "active") continue;
    const resolved = await resolveActivationLeaseFence(ctx.guard!, {
      projectId: member.remoteProjectId, targetBackend: "postgresql", evidenceSha256: member.copyBindingSha256!, signal: ctx.input.signal,
    });
    if (resolved.kind === "unresolvable") return interrupted(ctx, "S13b", "lease-unresolvable", at(member, resolved.detail));
    const foreign = resolved.kind === "identity-mismatch" || (resolved.kind === "present" && resolved.fence.publicationId !== ctx.setId);
    if (resolved.kind === "present" && !foreign) { member.fence = resolved.fence; continue; }
    const corrupt = resolved.kind === "identity-mismatch" && resolved.corrupt === true;
    const admitted = ownV2 !== null && (foreign
      ? SUCCESSOR_ROW_PHASES.has(ownV2.phase) || (RELEASE_WINDOW_PHASES.has(ownV2.phase) && !corrupt)
      : NO_OWN_FENCE_PHASES.has(ownV2.phase));
    if (!admitted) {
      return interrupted(ctx, "S13b", "lease-lost", at(member, foreign ? "the fenced lease row names another publication" : "no fenced lease row exists for this member"));
    }
  }
  return null;
}

/** With a frozen selection and a slot that is not this set's: are the members all settled, all pending, or mixed? */
async function classifySettlement(ctx: Context): Promise<Step<"all-active" | "all-pending" | "mixed">> {
  const adopted = await adoptFrozenSelection(ctx);
  if (isExit(adopted)) return adopted;
  let active = 0;
  let pending = 0;
  for (const member of ctx.members) {
    if (member.manifest!.phase === "active") { active += 1; continue; }
    // A pending member with any stored activation report is report-only state: not positively unpublished. Only an
    // authenticated, positively absent report directory counts as pending; a present directory or one that cannot
    // be authenticated is mixed state (F1).
    const presence = ctx.deps.probeReportPresence({ homeDir: ctx.homeDir, generationId: member.generationId });
    if (presence.state === "authoritatively-absent") pending += 1;
  }
  if (active === ctx.members.length) return ok("all-active");
  if (pending === ctx.members.length) return ok("all-pending");
  return ok("mixed");
}

async function settledActive(ctx: Context, resumedFrom: CutoverSetActivationResumePoint): Promise<CutoverSetActivateResult> {
  ctx.effectBegun = true;
  ctx.resumedFrom = resumedFrom;
  const restart = await restartVerdict(ctx);
  return { status: "activated", setId: ctx.setId, publicationId: ctx.setId, members: memberResults(ctx), restart, resumedFrom };
}

