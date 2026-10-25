import { configPath } from "../runtime-paths.js";
import { BackendPublicationJournalError } from "../storage/backend-publication.js";
import { enumerateStoredDataProjectHashes } from "./activation-coverage.js";
import type { ActivationPublicationStatus } from "./activation-publication.js";
import { readProjectMapSnapshot } from "../project-map.js";
import type { MigrationActivationInterruptionCause } from "./activate-generation.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, unexpectedFailureEvidence, withMigrationBoundary } from "./boundary.js";
import { performMigrationAbortCommand } from "./cli-abort.js";
import { DEFAULT_MIGRATION_APPLY_MAX_BYTES, DEFAULT_MIGRATION_APPLY_MAX_RECORDS } from "./cli-apply.js";
import { combineCutoverRestart, CUTOVER_RESTART_REASONS, observeCutoverRestart } from "./cli-cutover.js";
import { ACTIVATE_NEXT_AFTER_SUCCESS } from "./cli-activate.js";
import { refuseUnlessBackendConfirmed, refuseUnlessConfirmed } from "./cli-existing.js";
import {
  admitsResume,
  closedToken,
  journalSections,
  nextForRoute,
  observeSet,
  observedRows,
  selectSet,
  SET_CONFIRMATION_REASONS,
  setRowsEvidence,
  setSections,
  setWriteFingerprint,
  type SetEvidenceRow,
  type SetObservation,
  type SetObservationOperations,
  type SetRoute,
} from "./cli-cutover-set-state.js";
import { classifyMigrationDaemonPresence } from "./daemon-presence.js";
import { observeMigrationMaintenanceJournal } from "./journal-observation.js";
import { activateCutoverSet, type CutoverSetActivateResult, type CutoverSetActivationRefusalReason } from "./cutover-set-activate.js";
import {
  prepareCutoverSet,
  resolveCutoverSetCandidate,
  type CutoverSetPrepareResult,
} from "./cutover-set-prepare.js";
import {
  rollbackCutoverSet,
  type CutoverSetRollbackBlockedReason,
  type CutoverSetRollbackInterruptionCause,
  type CutoverSetRollbackRefusalReason,
  type CutoverSetRollbackResult,
} from "./cutover-set-rollback.js";
import type { MigrationEnvelopeRestart, MigrationEvidence } from "./envelope.js";
import type { MigrationExitClassName } from "./exit-classes.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { MIGRATION_REFUSAL_REASONS } from "./refusal-mapping.js";
import { dryRunAuthenticatedSqliteMigrationSource } from "./maintenance.js";
import { resolveMigrationTargetConfig } from "./target-config.js";
import { verifyMigrationTargetReachability } from "./target-reachability.js";
import type { ResolvedPostgreSqlConfig } from "../daemon/config.js";

/**
 * The `--set` mode of the nine `lcm migration` commands (#1551): thin
 * adapters over the cutover-set services (#1548-#1550), the shared set state
 * and the existing v1 envelope. No adapter re-implements a service algorithm:
 * it resolves the explicit selector and confirmations, reads the shared route,
 * invokes the one owning service once, and maps the closed result onto the
 * shared set refusal buckets with the member evidence flattened into scalar
 * keys. Exit 6 is emitted only when the durable state, read again after the
 * service returned, still admits the same owning service.
 */

export type MigrationSetOutcome =
  | Readonly<{
    status: "ok";
    generationId: string | null;
    manifestPhase: string | null;
    applied: boolean;
    next: string | null;
    evidence: MigrationEvidence;
    restart?: MigrationEnvelopeRestart | null;
  }>
  | Readonly<{
    status: "refuse";
    reason: string;
    /** A closed detail marker, never a message. */
    evidence?: string;
    generationId?: string | null;
    manifestPhase?: string | null;
    applied?: boolean;
    next?: string | null;
    sections?: MigrationEvidence;
    restart?: MigrationEnvelopeRestart | null;
  }>;

export type MigrationSetOperations = Readonly<{
  resolveTargetConfig: typeof resolveMigrationTargetConfig;
  classifyPresence: typeof classifyMigrationDaemonPresence;
  verifyReachability: typeof verifyMigrationTargetReachability;
  resolveCandidate: typeof resolveCutoverSetCandidate;
  prepare: typeof prepareCutoverSet;
  activate: typeof activateCutoverSet;
  rollback: typeof rollbackCutoverSet;
  abortCommand: typeof performMigrationAbortCommand;
  enumerate: typeof enumerateStoredDataProjectHashes;
  readMapSnapshot: typeof readProjectMapSnapshot;
  dryRunSource: typeof dryRunAuthenticatedSqliteMigrationSource;
  observeRestart: typeof observeCutoverRestart;
  combineRestart: typeof combineCutoverRestart;
  observeJournal: typeof observeMigrationMaintenanceJournal;
  observation: Partial<SetObservationOperations>;
}>;

const DEFAULT_OPERATIONS: MigrationSetOperations = {
  resolveTargetConfig: resolveMigrationTargetConfig,
  classifyPresence: classifyMigrationDaemonPresence,
  verifyReachability: verifyMigrationTargetReachability,
  resolveCandidate: resolveCutoverSetCandidate,
  prepare: prepareCutoverSet,
  activate: activateCutoverSet,
  rollback: rollbackCutoverSet,
  abortCommand: performMigrationAbortCommand,
  enumerate: enumerateStoredDataProjectHashes,
  readMapSnapshot: readProjectMapSnapshot,
  dryRunSource: dryRunAuthenticatedSqliteMigrationSource,
  observeRestart: observeCutoverRestart,
  combineRestart: combineCutoverRestart,
  observeJournal: observeMigrationMaintenanceJournal,
  observation: {},
};

/** Every injectable operation resolved once, so no call site carries its own fallback. */
function resolveOperations(ops: Partial<MigrationSetOperations> | undefined): MigrationSetOperations {
  return { ...DEFAULT_OPERATIONS, ...ops };
}

type Ops = MigrationSetOperations;
type Bucket = "precondition" | "contention" | "evidence" | "incomplete" | "operator";

const BUCKET_REASONS: Readonly<Record<Bucket, string>> = Object.freeze({
  precondition: "set-refused-precondition",
  contention: "set-refused-contention",
  evidence: "set-refused-evidence",
  incomplete: "set-incomplete",
  operator: "set-operator-required",
});

const EXIT_CLASS_BUCKETS: Readonly<Partial<Record<MigrationExitClassName, Bucket>>> = {
  "refused-precondition": "precondition",
  "refused-contention": "contention",
  "refused-evidence": "evidence",
  "failed-operator-required": "operator",
};

// ---------------------------------------------------------------------------
// The closed service vocabularies, each keyed by its exported union.
// ---------------------------------------------------------------------------

/** Preparation's reasons are open strings, so the known ones are listed; the single-generation table covers the inherited ones. */
const PREPARE_REASON_BUCKETS: Readonly<Record<string, Bucket>> = {
  "cutover-set-single-project": "precondition",
  "cutover-set-uncovered-member": "precondition",
  "cutover-set-incomplete": "precondition",
  "cutover-set-unknown-member": "precondition",
  "cutover-set-member-not-local": "precondition",
  "cutover-set-machine-mismatch": "precondition",
  "cutover-set-duplicate-generation": "precondition",
  "cutover-set-too-large": "precondition",
  "cutover-set-single-generation-held": "precondition",
  "cutover-set-rollback-held": "precondition",
  "cutover-set-target-changed": "precondition",
  "hold-phase-unsupported": "precondition",
  "abort-or-resume-required": "precondition",
  "machine-identity-unregistered": "precondition",
  "member-snapshot-partial": "precondition",
  "publication-occupies-slot": "contention",
  "generation-occupied-since-probe": "contention",
  "capture-contention": "contention",
  "capture-failed": "operator",
  "capture-unresolvable": "evidence",
  "cutover-set-enumeration-unresolvable": "evidence",
  "cutover-set-member-unverifiable": "evidence",
  "cutover-set-membership-drift": "evidence",
  "cutover-set-member-unbound": "evidence",
  "cutover-set-authority-changed": "evidence",
  "cutover-set-authority-drifted": "evidence",
  "cutover-set-member-unmapped": "evidence",
  "project-map-unresolvable": "evidence",
  "journal-unresolvable": "evidence",
  "abort-gate-unresolvable": "evidence",
  "generation-unresolvable-since-probe": "evidence",
  "hold-entry-readback-mismatch": "evidence",
  "member-identity-mismatch": "evidence",
  "member-snapshot-tampered": "evidence",
  "member-snapshot-absent": "evidence",
  "member-snapshot-unresolvable": "evidence",
  "member-binding-drifted": "evidence",
  "member-authority-drifted": "evidence",
  "member-unbound": "evidence",
  "member-state-unexpected": "evidence",
  "member-verification-failed": "evidence",
  "manifest-unresolvable": "evidence",
  "hold-not-held": "evidence",
  cancelled: "incomplete",
};

/** Every reason a member row may carry; any other service string is shown as unrecognized, never copied. */
function knownReasons(): ReadonlySet<string> {
  return new Set([
    ...Object.keys(PREPARE_REASON_BUCKETS),
    ...Object.keys(ACTIVATION_REFUSAL_BUCKETS),
    ...Object.keys(ROLLBACK_REFUSAL_BUCKETS),
    ...Object.keys(ROLLBACK_BLOCKED_BUCKETS),
    ...MIGRATION_REFUSAL_REASONS.map((entry) => entry.reason),
  ]);
}

function rowReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) return null;
  return KNOWN_REASONS.has(reason) ? reason : "unrecognized";
}

/** An inherited single-generation reason classifies by its table entry; anything else is evidence, undisclosed. */
function serviceBucket(reason: string): Readonly<{ bucket: Bucket; known: boolean }> {
  const own = PREPARE_REASON_BUCKETS[reason];
  if (own !== undefined && Object.hasOwn(PREPARE_REASON_BUCKETS, reason)) return { bucket: own, known: true };
  const inherited = MIGRATION_REFUSAL_REASONS.find((entry) => entry.reason === reason);
  const bucket = inherited === undefined ? undefined : EXIT_CLASS_BUCKETS[inherited.exitClass];
  return bucket === undefined ? { bucket: "evidence", known: false } : { bucket, known: true };
}

const ACTIVATION_REFUSAL_BUCKETS = {
  "manifest-absent": "precondition",
  "manifest-not-eligible": "precondition",
  "manifest-unresolvable": "evidence",
  "pending-effect-foreign": "precondition",
  "maintenance-not-held": "precondition",
  "maintenance-unresolvable": "evidence",
  "lease-conflict": "contention",
  "lease-unresolvable": "evidence",
  "quiescence-unsatisfied": "precondition",
  "quiescence-unresolvable": "evidence",
  "coverage-unsatisfied": "precondition",
  "coverage-unresolvable": "evidence",
  "uncovered-projects": "precondition",
  "verification-stale": "precondition",
  "verification-unresolvable": "evidence",
  "identity-drift": "precondition",
  "project-map-drift": "precondition",
  "target-unhealthy": "precondition",
  "target-unresolvable": "evidence",
  "census-drift": "precondition",
  "class-coverage-incomplete": "precondition",
  "verification-mismatch": "precondition",
  "evidence-unresolvable": "evidence",
  "state-unresolvable": "evidence",
  "cutover-set-enumeration-unresolvable": "evidence",
  "cutover-set-single-project": "precondition",
  "cutover-set-uncovered-member": "precondition",
  "cutover-set-member-unverifiable": "evidence",
  "cutover-set-incomplete": "precondition",
  "cutover-set-unknown-member": "precondition",
  "cutover-set-member-not-local": "precondition",
  "cutover-set-machine-mismatch": "precondition",
  "cutover-set-duplicate-generation": "precondition",
  "cutover-set-too-large": "precondition",
  "cutover-set-membership-drift": "evidence",
  "cutover-set-member-unbound": "evidence",
  "cutover-set-member-evidence-stale": "precondition",
  "cutover-set-member-evidence-drifted": "evidence",
  "cutover-set-member-evidence-unverifiable": "evidence",
  "cutover-set-member-evidence-absent": "evidence",
  "cutover-set-evidence-extra-member": "evidence",
  "cutover-set-evidence-duplicate-member": "evidence",
  "cutover-set-evidence-identity-mismatch": "evidence",
  "cutover-set-not-held": "precondition",
  "cutover-set-aborted": "precondition",
  "cutover-set-confirmation-mismatch": "precondition",
  "cutover-set-authority-drifted": "evidence",
  "cutover-set-target-changed": "precondition",
  "cutover-set-member-unmapped": "evidence",
  "cutover-set-member-identity": "evidence",
  "cutover-set-rollback-committed": "precondition",
  "machine-identity-unregistered": "precondition",
  cancelled: "precondition",
} as const satisfies Record<CutoverSetActivationRefusalReason, Bucket>;

/** Only a lost lease can be retried; every other cause is evidence unless the durable state says otherwise. */
const ACTIVATION_INTERRUPTION_BUCKETS = {
  "lease-lost": "contention",
  "lease-unresolvable": "evidence",
  "evidence-conflict": "evidence",
  "evidence-unresolvable": "evidence",
  "binding-conflict": "evidence",
  "binding-unresolvable": "evidence",
  "link-conflict": "evidence",
  "artifact-identity-mismatch": "evidence",
  "artifact-unresolvable": "evidence",
  "journal-unexpected": "evidence",
  "readback-mismatch": "evidence",
  "project-map-drift": "evidence",
  "report-conflict": "evidence",
  "report-unresolvable": "evidence",
  "state-unresolvable": "evidence",
} as const satisfies Record<MigrationActivationInterruptionCause, Bucket>;

const PUBLICATION_STATUS_BUCKETS = {
  completed: "evidence",
  aborted: "evidence",
  "publication-collision": "evidence",
  "fence-unsatisfied": "contention",
  "fence-unresolvable": "evidence",
  "artifact-missing": "evidence",
  "artifact-unresolvable": "evidence",
  "artifact-identity-mismatch": "evidence",
  "duplicate-publication-input": "evidence",
  "publication-unresolvable": "evidence",
  "maintenance-in-flight": "evidence",
} as const satisfies Record<ActivationPublicationStatus, Bucket>;

const ROLLBACK_REFUSAL_BUCKETS = {
  "activation-not-selected": "precondition",
  "activation-not-completed": "precondition",
  "activation-not-live": "precondition",
  "activation-unresolvable": "evidence",
  "cutover-set-too-large": "precondition",
  "machine-identity-unregistered": "precondition",
  "maintenance-held-by-other": "contention",
  "member-not-active": "precondition",
  "member-evidence-missing": "evidence",
  "member-link-mismatch": "evidence",
  "member-snapshot-mismatch": "evidence",
  "project-coverage-drift": "evidence",
  "target-unreachable": "evidence",
  "target-identity-drift": "evidence",
  cancelled: "precondition",
} as const satisfies Record<CutoverSetRollbackRefusalReason, Bucket>;

/** build-failed, install-failed and cancelled are incomplete only when the rollback route still admits the service. */
const ROLLBACK_BLOCKED_BUCKETS = {
  "lease-conflict": "contention",
  "lease-unresolvable": "evidence",
  "lease-lost": "contention",
  "quiescence-unsatisfied": "precondition",
  "not-eligible": "precondition",
  "revalidation-drift": "evidence",
  "pending-evidence-drift": "evidence",
  "preserved-source-mismatch": "evidence",
  "build-quarantined": "evidence",
  "build-failed": "incomplete",
  "install-failed": "incomplete",
  "install-mismatch": "evidence",
  "target-unreachable": "evidence",
  cancelled: "incomplete",
} as const satisfies Record<CutoverSetRollbackBlockedReason, Bucket>;

const ROLLBACK_INTERRUPTION_BUCKETS = {
  "state-unresolvable": "evidence",
  "evidence-conflict": "evidence",
  "evidence-unresolvable": "evidence",
  "journal-unexpected": "evidence",
  "hold-aborted": "operator",
  "hold-gone": "operator",
  "artifact-unresolvable": "evidence",
  "artifact-mismatch": "evidence",
  "publication-aborted": "incomplete",
  "publication-mismatch": "evidence",
  "readback-mismatch": "evidence",
  "lease-lost": "contention",
} as const satisfies Record<CutoverSetRollbackInterruptionCause, Bucket>;

const KNOWN_REASONS = knownReasons();

/** A table lookup that fails closed on an unknown runtime value (the type check covers the declared unions). */
function closedBucket<T extends string>(kind: string, table: Readonly<Record<T, Bucket>>, value: unknown): Bucket {
  if (typeof value !== "string" || !Object.hasOwn(table, value)) {
    throw new Error(`cutover set service returned an unknown ${kind}`);
  }
  return table[value as T];
}

// ---------------------------------------------------------------------------
// Shared outcome helpers
// ---------------------------------------------------------------------------

function refuse(
  reason: string,
  rest: Omit<Extract<MigrationSetOutcome, { status: "refuse" }>, "status" | "reason"> = {},
): MigrationSetOutcome {
  return { status: "refuse", reason, ...rest };
}

function projectSections(projects: readonly string[] | undefined): MigrationEvidence {
  const evidence: Record<string, string> = {};
  [...(projects ?? [])].sort().forEach((project, index) => { evidence[`failure.${String(index)}.projectId`] = project; });
  return evidence;
}

/** A service refusal in its shared bucket; the closed reason and the owning command stay in the evidence. */
function serviceRefusal(args: Readonly<{
  command: "plan" | "prepare" | "activate" | "rollback" | "abort" | "dry-run" | "verify" | "resume" | "report";
  reason: string;
  bucket?: Bucket;
  /** Whether the reason belongs to a closed vocabulary; by default an explicit bucket vouches for it. */
  known?: boolean;
  setId?: string | null;
  projects?: readonly string[];
  applied?: boolean;
  next?: string | null;
  sections?: MigrationEvidence;
}>): MigrationSetOutcome {
  const classified = serviceBucket(args.reason);
  const known = args.known ?? (args.bucket !== undefined || classified.known);
  if (args.reason === "confirmation-generation-moved") {
    return refuse(SET_CONFIRMATION_REASONS.moved, { generationId: args.setId, next: "plan --set" });
  }
  // plan and dry-run cannot emit the mutation classes (frozen contract): fold them into evidence.
  const requested = args.bucket ?? classified.bucket;
  const readOnly = args.command === "plan" || args.command === "dry-run";
  const bucket = readOnly && (requested === "operator" || requested === "incomplete") ? "evidence" : requested;
  return refuse(BUCKET_REASONS[bucket], {
    generationId: args.setId ?? null,
    ...(args.applied === true ? { applied: true } : {}),
    next: args.next ?? null,
    sections: {
      scope: "cutover-set",
      serviceCommand: args.command,
      serviceReason: known ? args.reason : "unrecognized",
      ...projectSections(args.projects),
      ...args.sections,
    },
  });
}

function commonPhase(rows: readonly SetEvidenceRow[]): string | null {
  const states = new Set(rows.map((row) => row.state));
  return states.size === 1 ? [...states][0]! : null;
}

/** True when a durable write by this invocation is proven or cannot be excluded; the flag says which. */
function writeObservation(
  before: string,
  after: string,
  signal: boolean,
  uncertain = false,
): Readonly<{ applied: boolean; unresolvable: boolean }> {
  if (before === "unresolvable" || after === "unresolvable") return { applied: true, unresolvable: true };
  if (signal || before !== after) return { applied: true, unresolvable: false };
  // Nothing observed moved, but the step may have written outside what the fingerprint covers.
  return { applied: uncertain, unresolvable: uncertain };
}

function writeSections(observed: Readonly<{ unresolvable: boolean }>): MigrationEvidence {
  return observed.unresolvable ? { writeObservation: "unresolvable" } : {};
}

function manifestStoreOf(homeDir: string): MigrationManifestStore {
  return new MigrationManifestStore({ homeDir });
}

// ---------------------------------------------------------------------------
// Target preflight shared by plan and apply (C5): config, presence, reachability.
// ---------------------------------------------------------------------------

type TargetPreflight =
  | Readonly<{ status: "ready"; config: ResolvedPostgreSqlConfig; presence: Readonly<{ present: boolean; backend: string | null }> }>
  | Readonly<{ status: "refuse"; outcome: MigrationSetOutcome }>;

async function targetPreflight(homeDir: string, ops: Ops): Promise<TargetPreflight> {
  const target = ops.resolveTargetConfig(configPath(homeDir));
  if (target.status === "refuse") {
    return { status: "refuse", outcome: refuse(target.reason, { ...(target.evidence === undefined ? {} : { evidence: target.evidence }) }) };
  }
  const presence = await ops.classifyPresence({ homeDir });
  if (presence.status === "unresolvable") {
    return { status: "refuse", outcome: refuse("daemon-presence-unresolvable", { evidence: presence.evidence }) };
  }
  const verification = await ops.verifyReachability({
    settings: target.config.postgresql, expectedOwner: target.config.postgresql.migrationRole,
  });
  if (verification.status === "refuse") {
    return { status: "refuse", outcome: refuse(verification.reason, { ...(verification.evidence === undefined ? {} : { evidence: verification.evidence }) }) };
  }
  return {
    status: "ready",
    config: target.config,
    presence: presence.status === "present"
      ? { present: true, backend: presence.storageBackend }
      : { present: false, backend: null },
  };
}

function presenceSections(presence: Readonly<{ present: boolean; backend: string | null }>): MigrationEvidence {
  return { daemonPresent: presence.present, ...(presence.backend === null ? {} : { daemonStorageBackend: presence.backend }) };
}

function boundary(run: () => Promise<MigrationSetOutcome>): Promise<MigrationSetOutcome> {
  // An unclassified throw cannot rule out that a service had already written.
  return withMigrationBoundary(run, (evidence) => ({
    status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence, applied: true,
    sections: { scope: "cutover-set", writeObservation: "unresolvable" },
  }));
}

function readBoundary(run: () => Promise<MigrationSetOutcome>): Promise<MigrationSetOutcome> {
  return withMigrationBoundary(run, (evidence) => ({ status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence }));
}

// ---------------------------------------------------------------------------
// plan --set
// ---------------------------------------------------------------------------

type CandidateOk = Extract<Awaited<ReturnType<typeof resolveCutoverSetCandidate>>, { status: "candidate" }>;

function candidateSections(candidate: CandidateOk): MigrationEvidence {
  return {
    scope: "cutover-set",
    setId: candidate.setId,
    memberCount: candidate.members.length,
    disposition: candidate.disposition,
    ...setRowsEvidence(candidate.members.map((member) => ({
      projectId: member.physicalProjectId, generationId: member.generationId, state: "candidate",
    }))),
  };
}

export type MigrationSetPlanInput = Readonly<{ homeDir: string; _operationsForTesting?: Partial<MigrationSetOperations> }>;

export function performSetPlan(input: MigrationSetPlanInput): Promise<MigrationSetOutcome> {
  return readBoundary(async () => {
    const ops = resolveOperations(input._operationsForTesting);
    const preflight = await targetPreflight(input.homeDir, ops);
    if (preflight.status === "refuse") return preflight.outcome;
    const candidate = await ops.resolveCandidate({
      homeDir: input.homeDir, targetConfig: preflight.config,
    });
    if (candidate.status === "refuse") {
      return serviceRefusal({ command: "plan", reason: candidate.reason, projects: candidate.projects });
    }
    return {
      status: "ok", generationId: candidate.setId, manifestPhase: null, applied: false, next: "apply --set",
      evidence: { ...candidateSections(candidate), ...presenceSections(preflight.presence) },
    };
  });
}

// ---------------------------------------------------------------------------
// dry-run --set: source-only, with no target, no service and no write (C4).
// ---------------------------------------------------------------------------

export type MigrationSetDryRunInput = MigrationSetPlanInput;

function journalFailureBucket(error: unknown): Bucket {
  return error instanceof BackendPublicationJournalError && error.reason === "unresolved-publication" ? "contention" : "evidence";
}

export function performSetDryRun(input: MigrationSetDryRunInput): Promise<MigrationSetOutcome> {
  return readBoundary(async () => {
    const ops = resolveOperations(input._operationsForTesting);
    let projectHashes: readonly string[];
    let canonicalPaths: ReadonlyMap<string, string>;
    try {
      const enumeration = ops.enumerate({ homeDir: input.homeDir, suppressMetadataBackfill: true });
      if (enumeration.status === "unresolvable") {
        return serviceRefusal({ command: "dry-run", reason: "cutover-set-enumeration-unresolvable" });
      }
      projectHashes = [...enumeration.projectHashes].sort();
      const map = ops.readMapSnapshot(input.homeDir);
      canonicalPaths = new Map(projectHashes.flatMap((hash) => map[hash] === undefined ? [] : [[hash, map[hash]!.canonical] as const]));
    } catch (error) {
      // Existing consumer admission is authoritative: its refusal is classified, never bypassed.
      return serviceRefusal({ command: "dry-run", reason: "journal-unresolvable", bucket: journalFailureBucket(error) });
    }
    if (projectHashes.length < 2) {
      return serviceRefusal({ command: "dry-run", reason: "cutover-set-single-project" });
    }
    const unmapped = projectHashes.filter((hash) => !canonicalPaths.has(hash));
    if (unmapped.length > 0) {
      return serviceRefusal({ command: "dry-run", reason: "cutover-set-uncovered-member", projects: unmapped });
    }
    const rows: Record<string, string | number> = {};
    for (const [index, hash] of projectHashes.entries()) {
      let result: Awaited<ReturnType<typeof dryRunAuthenticatedSqliteMigrationSource>>;
      try {
        result = await ops.dryRunSource(canonicalPaths.get(hash)!, input.homeDir);
      } catch (error) {
        return refuse("dry-run-failed", {
          evidence: unexpectedFailureEvidence(error),
          sections: { scope: "cutover-set", memberCount: projectHashes.length, ...projectSections([hash]) },
        });
      }
      const key = (field: string): string => `member.${String(index)}.${field}`;
      rows[key("projectId")] = hash;
      rows[key("state")] = "source-checked";
      rows[key("sourceSelectionSha256")] = result.sourceSelectionSha256;
      rows[key("sourceByteWitnessSha256")] = result.sourceByteWitnessSha256;
      rows[key("checksumSha256")] = result.checksumSha256;
      rows[key("roleCount")] = result.roles.length;
      rows[key("inspectedAt")] = result.inspectedAt;
    }
    return {
      status: "ok", generationId: null, manifestPhase: null, applied: false, next: "plan --set",
      evidence: { scope: "cutover-set", memberCount: projectHashes.length, ...rows },
    };
  });
}

// ---------------------------------------------------------------------------
// apply --set (prepare the whole set) and the preparation result mapping.
// ---------------------------------------------------------------------------

export type MigrationSetApplyInput = Readonly<{
  homeDir: string;
  confirmGenerationId?: string;
  dryRun?: boolean;
  maxRecords?: number;
  maxBytes?: number;
  _operationsForTesting?: Partial<MigrationSetOperations>;
}>;

function observationOf(input: Readonly<{ homeDir: string; setId: string; ops: Ops }>): Promise<SetObservation> {
  return observeSet({ homeDir: input.homeDir, setId: input.setId, _operationsForTesting: input.ops.observation });
}

function fingerprintOf(homeDir: string, setId: string, generationIds: readonly string[], ops: Ops): Promise<string> {
  return setWriteFingerprint({ homeDir, setId, generationIds }, ops.observation);
}

function preparationRows(result: CutoverSetPrepareResult): readonly SetEvidenceRow[] {
  if (result.status === "refuse") return [];
  return result.members.map((member) => ({
    projectId: member.physicalProjectId, generationId: member.generationId, state: member.state, reason: rowReason(member.reason),
  }));
}

async function mapPrepare(args: Readonly<{
  homeDir: string;
  result: CutoverSetPrepareResult;
  before: string;
  generationIds: readonly string[];
  setId: string;
  ops: Ops;
}>): Promise<MigrationSetOutcome> {
  const { result, homeDir, ops } = args;
  const setId = result.setId ?? args.setId;
  const effects = result.identityMutation.flatMap((entry) => entry.effects);
  const signal = effects.some((effect) => effect.outcome === "persisted" || effect.outcome === "created");
  const after = await fingerprintOf(homeDir, setId, args.generationIds, ops);
  const written = writeObservation(args.before, after, signal);
  const rows = preparationRows(result);
  const base: MigrationEvidence = { scope: "cutover-set", setId, memberCount: rows.length, ...setRowsEvidence(rows), ...writeSections(written) };
  if (result.status === "refuse") {
    return serviceRefusal({
      command: "prepare", reason: result.reason, setId, projects: result.projects, applied: written.applied, sections: base,
    });
  }
  if (result.status === "blocked") {
    const classified = serviceBucket(result.reason);
    let bucket = classified.bucket;
    if (bucket === "incomplete") {
      bucket = await admitted(homeDir, setId, ops, "prepare") ? "incomplete" : "evidence";
    }
    return serviceRefusal({
      command: "prepare", reason: result.reason, bucket, known: classified.known, setId, applied: written.applied,
      next: bucket === "incomplete" || bucket === "contention" ? "resume --set" : bucket === "precondition" ? "abort --set" : null,
      sections: { ...base, blockedProjectId: result.blockedProject },
    });
  }
  // prepared: the postcondition is read back, never trusted from the result.
  const observed = await observationOf({ homeDir, setId, ops });
  if (observed.route !== "prepared") {
    return serviceRefusal({
      command: "prepare", reason: "readback-mismatch", bucket: "evidence", setId, applied: true,
      sections: { ...base, ...setSections(observed), ...setRowsEvidence(observedRows(observed)) },
    });
  }
  const readRows = observedRows(observed);
  return {
    status: "ok", generationId: setId, manifestPhase: commonPhase(readRows), applied: written.applied, next: "activate --set",
    evidence: { ...setSections(observed), ...setRowsEvidence(readRows), ...writeSections(written) },
  };
}

export function performSetApply(input: MigrationSetApplyInput): Promise<MigrationSetOutcome> {
  return boundary(async () => {
    const ops = resolveOperations(input._operationsForTesting);
    const preflight = await targetPreflight(input.homeDir, ops);
    if (preflight.status === "refuse") return preflight.outcome;
    const candidate = await ops.resolveCandidate({
      homeDir: input.homeDir, targetConfig: preflight.config,
    });
    if (candidate.status === "refuse") {
      return serviceRefusal({ command: "prepare", reason: candidate.reason, projects: candidate.projects });
    }
    const sections = { ...candidateSections(candidate), ...presenceSections(preflight.presence) };
    const unconfirmed = refuseUnlessConfirmed({
      expectedGenerationId: candidate.setId, confirmGenerationId: input.confirmGenerationId, reasons: SET_CONFIRMATION_REASONS,
    });
    if (unconfirmed !== null) return refuse(unconfirmed.reason, { generationId: unconfirmed.generationId, sections, next: "apply --set" });
    if (input.dryRun === true) {
      return {
        status: "ok", generationId: candidate.setId, manifestPhase: null, applied: false,
        next: "apply --set (drop --dry-run to prepare for real)", evidence: sections,
      };
    }
    const generationIds = candidate.members.map((member) => member.generationId);
    const before = await fingerprintOf(input.homeDir, candidate.setId, generationIds, ops);
    const result = await ops.prepare({
      homeDir: input.homeDir,
      confirmSetId: candidate.setId,
      targetConfig: preflight.config,
      maxRecords: input.maxRecords ?? DEFAULT_MIGRATION_APPLY_MAX_RECORDS,
      maxBytes: input.maxBytes ?? DEFAULT_MIGRATION_APPLY_MAX_BYTES,
    });
    return mapPrepare({ homeDir: input.homeDir, result, before, generationIds, setId: candidate.setId, ops });
  });
}

// ---------------------------------------------------------------------------
// Activation and rollback result mapping
// ---------------------------------------------------------------------------

function activationRows(result: Exclude<CutoverSetActivateResult, never>): readonly SetEvidenceRow[] {
  return result.members.map((member) => ({
    projectId: member.physicalProjectId, generationId: member.generationId, state: member.manifest, reason: rowReason(member.reason),
  }));
}

function rollbackRows(result: CutoverSetRollbackResult): readonly SetEvidenceRow[] {
  return result.members.map((member) => ({
    projectId: member.physicalProjectId, generationId: member.generationId, state: member.manifest,
    reason: rowReason(member.reason), mode: member.mode, installedGenerationId: member.installedGenerationId,
  }));
}

/** Exit 6 needs the durable state, read again, to admit the same service (see admitsResume). */
async function admitted(homeDir: string, setId: string, ops: Ops, service: "prepare" | "activate" | "rollback"): Promise<boolean> {
  return admitsResume(await observationOf({ homeDir, setId, ops }), service);
}

/**
 * Rollback steps that write outside what the fingerprint observes: the reverse artifact, candidates, installed
 * databases, and completion (member selection bindings and rollback reports precede the manifest update).
 */
const UNFENCED_ROLLBACK_STEPS: ReadonlySet<string> = new Set(["artifact", "build", "install", "completion"]);

async function mapActivate(args: Readonly<{
  homeDir: string;
  result: CutoverSetActivateResult;
  before: string;
  generationIds: readonly string[];
  setId: string;
  ops: Ops;
}>): Promise<MigrationSetOutcome> {
  const { result, homeDir, setId, ops } = args;
  const status: string = result.status;
  if (status !== "activated" && status !== "refused" && status !== "interrupted" && status !== "publication-failed" && status !== "post-publication-unhealthy") {
    throw new Error("cutover set activation returned an unknown status");
  }
  const after = await fingerprintOf(homeDir, setId, args.generationIds, ops);
  const rows = activationRows(result);
  const rowSections = setRowsEvidence(rows);
  const common = { scope: "cutover-set", setId, memberCount: rows.length, ...rowSections };

  if (result.status === "refused") {
    const bucket = closedBucket("refusal reason", ACTIVATION_REFUSAL_BUCKETS, result.reason);
    if (result.reason === "cutover-set-confirmation-mismatch") {
      return refuse(SET_CONFIRMATION_REASONS.moved, { generationId: setId, sections: common });
    }
    const failures: Record<string, string> = {};
    result.failures.forEach((failure, index) => {
      failures[`failure.${String(index)}.projectId`] = failure.physicalProjectId;
      failures[`failure.${String(index)}.reason`] = closedToken(failure.reason);
    });
    const sections = { ...common, serviceStep: result.step, ...failures };
    return serviceRefusal({ command: "activate", reason: result.reason, bucket, setId, sections });
  }

  // Every non-refused outcome may have written; a settled idempotent re-entry is the one proven read-only case.
  const signal = result.status === "interrupted" ? result.effectBegun
    : result.status === "activated" ? result.resumedFrom !== "settled-active" : true;
  const written = writeObservation(args.before, after, signal);
  const writeEvidence = writeSections(written);

  if (result.status === "interrupted") {
    let bucket = closedBucket("interruption cause", ACTIVATION_INTERRUPTION_BUCKETS, result.cause);
    if (!result.effectBegun) {
      // Nothing durable began, so the manifest and records are as they were.
      return serviceRefusal({
        command: "activate", reason: result.cause, bucket, setId, applied: written.applied,
        sections: { ...common, serviceStep: result.step, serviceCause: result.cause, effectBegun: false, ...writeEvidence },
      });
    }
    if (result.cause === "lease-lost" && await admitted(homeDir, setId, ops, "activate")) bucket = "incomplete";
    return refuse(BUCKET_REASONS[bucket], {
      generationId: setId, applied: true, next: bucket === "incomplete" ? "resume --set" : null,
      sections: {
        ...common, serviceCommand: "activate", serviceStep: result.step, serviceCause: result.cause,
        effectBegun: true, selectionApplied: result.applied, ...writeEvidence,
      },
    });
  }

  if (result.status === "publication-failed") {
    const bucket = closedBucket("publication status", PUBLICATION_STATUS_BUCKETS, result.publication.status);
    return refuse(BUCKET_REASONS[bucket], {
      generationId: setId, applied: true,
      sections: { ...common, serviceCommand: "activate", servicePublicationStatus: result.publication.status, ...writeEvidence },
    });
  }

  if (result.status === "post-publication-unhealthy") {
    const combined = await ops.combineRestart({ homeDir, verdict: result.restart, selected: "postgresql" });
    return refuse(BUCKET_REASONS.evidence, {
      generationId: setId, applied: true, next: "resume --set", restart: combined.restart,
      sections: {
        ...common, serviceCommand: "activate", selectionApplied: "yes", healthStatus: result.health.status,
        ...(result.health.status === "healthy" ? {} : { healthReason: closedToken(result.health.reason) }),
        ...combined.evidence,
      },
    });
  }

  // activated: every member must read back active, with the selection recorded.
  const observed = await observationOf({ homeDir, setId, ops });
  const readBack = observed.route === "settled-activated" && observed.activation.state === "resolved" && observed.activation.selection !== null;
  if (!readBack) {
    return serviceRefusal({
      command: "activate", reason: "readback-mismatch", bucket: "evidence", setId, applied: true,
      sections: { ...common, ...setSections(observed), ...setRowsEvidence(observedRows(observed)) },
    });
  }
  const restart = await ops.combineRestart({ homeDir, verdict: result.restart, selected: "postgresql" });
  const applied = written.applied;
  const evidence: MigrationEvidence = {
    ...setSections(observed), ...setRowsEvidence(observedRows(observed)), publicationId: result.publicationId,
    resumedFrom: result.resumedFrom, grantSwap: "required-before-daemon-start", ...restart.evidence, ...writeEvidence,
  };
  if (restart.reason !== undefined) {
    return refuse(restart.reason, {
      generationId: setId, ...(applied ? { applied: true } : {}),
      next: restart.reason === CUTOVER_RESTART_REASONS.required ? ACTIVATE_NEXT_AFTER_SUCCESS : "report --set",
      sections: evidence, restart: restart.restart,
    });
  }
  return {
    status: "ok", generationId: setId, manifestPhase: "active", applied, next: ACTIVATE_NEXT_AFTER_SUCCESS, evidence, restart: restart.restart,
  };
}

async function mapRollback(args: Readonly<{
  homeDir: string;
  result: CutoverSetRollbackResult;
  before: string;
  generationIds: readonly string[];
  setId: string;
  ops: Ops;
}>): Promise<MigrationSetOutcome> {
  const { result, homeDir, setId, ops } = args;
  const status: string = result.status;
  if (status !== "rolled-back" && status !== "refused" && status !== "blocked" && status !== "interrupted") {
    throw new Error("cutover set rollback returned an unknown status");
  }
  const rows = rollbackRows(result);
  const common: MigrationEvidence = {
    scope: "cutover-set", setId, rollbackSetId: result.setId, memberCount: rows.length, ...setRowsEvidence(rows),
  };
  if (result.status === "refused") {
    const bucket = closedBucket("refusal reason", ROLLBACK_REFUSAL_BUCKETS, result.reason);
    if (result.step !== "checkpoint") {
      return serviceRefusal({ command: "rollback", reason: result.reason, bucket, setId, sections: { ...common, serviceStep: result.step } });
    }
    // The checkpoint step can durably write member records before it refuses: report that write.
    const refusedWrite = writeObservation(args.before, await fingerprintOf(homeDir, setId, args.generationIds, ops), false);
    return serviceRefusal({
      command: "rollback", reason: result.reason, bucket, setId, applied: refusedWrite.applied,
      sections: { ...common, serviceStep: result.step, ...writeSections(refusedWrite) },
    });
  }
  const after = await fingerprintOf(homeDir, setId, args.generationIds, ops);
  const signal = result.status === "rolled-back" && result.resumedFrom !== "settled";
  const uncertain = result.status !== "rolled-back" && UNFENCED_ROLLBACK_STEPS.has(result.step);
  const written = writeObservation(args.before, after, signal, uncertain);
  const writeEvidence = writeSections(written);
  if (result.status === "blocked") {
    let bucket = closedBucket("blocked reason", ROLLBACK_BLOCKED_BUCKETS, result.reason);
    if (bucket === "incomplete" && !(await admitted(homeDir, setId, ops, "rollback"))) bucket = "evidence";
    return refuse(BUCKET_REASONS[bucket], {
      generationId: setId, applied: written.applied, next: bucket === "incomplete" ? "resume --set" : null,
      sections: {
        ...common, serviceCommand: "rollback", serviceStep: result.step, serviceReason: result.reason,
        blockedProjectId: result.member, ...writeEvidence,
      },
    });
  }
  if (result.status === "interrupted") {
    let bucket = closedBucket("interruption cause", ROLLBACK_INTERRUPTION_BUCKETS, result.cause);
    if (bucket === "incomplete" && !(await admitted(homeDir, setId, ops, "rollback"))) bucket = "evidence";
    return refuse(BUCKET_REASONS[bucket], {
      generationId: setId, applied: written.applied, next: bucket === "incomplete" ? "resume --set" : null,
      sections: {
        ...common, serviceCommand: "rollback", serviceStep: result.step, serviceCause: result.cause,
        effectBegun: result.effectBegun, ...writeEvidence,
      },
    });
  }
  const observed = await observationOf({ homeDir, setId, ops });
  if (observed.route !== "settled-rolled-back") {
    return serviceRefusal({
      command: "rollback", reason: "readback-mismatch", bucket: "evidence", setId, applied: true,
      sections: { ...common, ...setSections(observed), ...setRowsEvidence(observedRows(observed)) },
    });
  }
  const restart = await ops.observeRestart({ homeDir, selected: "sqlite" });
  const applied = written.applied;
  const evidence: MigrationEvidence = {
    ...common, publicationId: result.publicationId, resumedFrom: result.resumedFrom, ...restart.evidence, ...writeEvidence,
  };
  if (restart.reason !== undefined) {
    return refuse(restart.reason, {
      generationId: setId, ...(applied ? { applied: true } : {}), next: "report --set", sections: evidence, restart: restart.restart,
    });
  }
  return { status: "ok", generationId: setId, manifestPhase: "rolled-back", applied, next: "report --set", evidence, restart: restart.restart };
}

// ---------------------------------------------------------------------------
// Existing-set commands: shared selector, confirmation and route admission.
// ---------------------------------------------------------------------------

type Admitted =
  | Readonly<{ status: "admitted"; setId: string; observation: SetObservation }>
  | Readonly<{ status: "refuse"; outcome: MigrationSetOutcome }>;

function routeRefusal(command: "verify" | "resume" | "activate" | "rollback" | "report", observation: SetObservation): MigrationSetOutcome {
  const { setId, route } = observation;
  const sections = { ...setSections(observation), ...journalSections(observation.journal), ...setRowsEvidence(observedRows(observation)) };
  const next = nextForRoute(route);
  switch (route) {
    case "unknown":
      return refuse("generation-unknown", { generationId: setId, sections, next });
    case "reverse-id":
      return refuse("set-original-generation-required", { generationId: setId, sections });
    case "unresolvable":
      return serviceRefusal({ command, reason: "route-unresolvable", bucket: "evidence", setId, sections });
    case "contradiction":
      return serviceRefusal({ command, reason: "route-contradiction", bucket: "evidence", setId, sections });
    case "foreign":
      return serviceRefusal({ command, reason: "foreign-slot", bucket: "precondition", setId, sections });
    case "single-generation-held":
      return serviceRefusal({ command, reason: "cutover-set-single-generation-held", bucket: "precondition", setId, sections, next: "resume" });
    default:
      return serviceRefusal({ command, reason: `route-${route}`, bucket: "precondition", setId, sections, next });
  }
}

/** Selector, then confirmations, then the read-only route. Nothing here writes. */
async function admitExistingSet(args: Readonly<{
  command: "verify" | "resume" | "activate" | "rollback";
  homeDir: string;
  generation: string | undefined;
  confirmGenerationId: string | undefined;
  confirmBackend?: Readonly<{ expected: string; value: string | undefined }>;
  ops: Ops;
  /** Routes the command may proceed from; any other observed route is refused with its owner named. */
  admittedRoutes: readonly SetRoute[];
}>): Promise<Admitted> {
  const selection = selectSet(args.generation);
  if (selection.status === "refuse") return { status: "refuse", outcome: refuse(selection.reason) };
  const { setId } = selection;
  const unconfirmed = refuseUnlessConfirmed({
    expectedGenerationId: setId, confirmGenerationId: args.confirmGenerationId, reasons: SET_CONFIRMATION_REASONS,
  });
  if (unconfirmed !== null) {
    return { status: "refuse", outcome: refuse(unconfirmed.reason, { generationId: setId, sections: { scope: "cutover-set", setId } }) };
  }
  if (args.confirmBackend !== undefined) {
    const backend = refuseUnlessBackendConfirmed({
      expectedBackend: args.confirmBackend.expected, confirmBackend: args.confirmBackend.value, generationId: setId,
    });
    if (backend !== null) {
      return { status: "refuse", outcome: refuse(backend.reason, { generationId: setId, sections: { scope: "cutover-set", setId } }) };
    }
  }
  const observation = await observationOf({ homeDir: args.homeDir, setId, ops: args.ops });
  if (!args.admittedRoutes.includes(observation.route)) {
    return { status: "refuse", outcome: routeRefusal(args.command, observation) };
  }
  return { status: "admitted", setId, observation };
}

const NOT_EVALUATED = "quiescence,coverage,lease,target-health,census,restart";

function previewRefusal(command: "verify" | "activate" | "rollback", observation: SetObservation, notEvaluated: string): MigrationSetOutcome {
  return refuse("set-preview-not-predictive", {
    generationId: observation.setId,
    next: `${command} --set (drop --dry-run to run it)`,
    sections: {
      ...setSections(observation), ...journalSections(observation.journal), ...setRowsEvidence(observedRows(observation)),
      predictive: false, notEvaluated,
    },
  });
}

// ---------------------------------------------------------------------------
// verify --set (persisted confirmation, C7)
// ---------------------------------------------------------------------------

export type MigrationSetExistingInput = Readonly<{
  homeDir: string;
  generation?: string;
  confirmGenerationId?: string;
  dryRun?: boolean;
  _operationsForTesting?: Partial<MigrationSetOperations>;
}>;

export function performSetVerify(input: MigrationSetExistingInput): Promise<MigrationSetOutcome> {
  return readBoundary(async () => {
    const ops = resolveOperations(input._operationsForTesting);
    const admission = await admitExistingSet({
      command: "verify", homeDir: input.homeDir, generation: input.generation, confirmGenerationId: input.confirmGenerationId,
      ops, admittedRoutes: ["prepared", "prepare"],
    });
    if (admission.status === "refuse") return admission.outcome;
    const { observation, setId } = admission;
    if (observation.route === "prepare") {
      return serviceRefusal({
        command: "verify", reason: "route-prepare", bucket: "precondition", setId, next: "resume --set",
        sections: { ...setSections(observation), ...setRowsEvidence(observedRows(observation)) },
      });
    }
    if (input.dryRun === true) return previewRefusal("verify", observation, "recomputation");
    return {
      status: "ok", generationId: setId, manifestPhase: "verified", applied: false, next: "activate --set",
      evidence: { ...setSections(observation), ...setRowsEvidence(observedRows(observation)) },
    };
  });
}

// ---------------------------------------------------------------------------
// activate --set / rollback --set
// ---------------------------------------------------------------------------

export type MigrationSetCutoverInput = MigrationSetExistingInput & Readonly<{ confirmBackend?: string }>;

function targetConfigOf(homeDir: string, ops: Ops): Readonly<{ status: "ready"; config: ResolvedPostgreSqlConfig }> | Readonly<{ status: "refuse"; outcome: MigrationSetOutcome }> {
  const target = ops.resolveTargetConfig(configPath(homeDir));
  if (target.status === "refuse") {
    return { status: "refuse", outcome: refuse(target.reason, { ...(target.evidence === undefined ? {} : { evidence: target.evidence }) }) };
  }
  return { status: "ready", config: target.config };
}

async function runActivation(homeDir: string, setId: string, observation: SetObservation, ops: Ops): Promise<MigrationSetOutcome> {
  const target = targetConfigOf(homeDir, ops);
  if (target.status === "refuse") return target.outcome;
  const generationIds = observation.members.map((member) => member.generationId);
  const before = await fingerprintOf(homeDir, setId, generationIds, ops);
  const result = await ops.activate({ homeDir, confirmSetId: setId, targetConfig: target.config });
  return mapActivate({ homeDir, result, before, generationIds, setId, ops });
}

async function runRollback(homeDir: string, setId: string, observation: SetObservation, ops: Ops): Promise<MigrationSetOutcome> {
  const generationIds = observation.members.map((member) => member.generationId);
  const before = await fingerprintOf(homeDir, setId, generationIds, ops);
  const result = await ops.rollback({ homeDir, confirmSetId: setId });
  return mapRollback({ homeDir, result, before, generationIds, setId, ops });
}

export function performSetActivate(input: MigrationSetCutoverInput): Promise<MigrationSetOutcome> {
  return boundary(async () => {
    const ops = resolveOperations(input._operationsForTesting);
    const admission = await admitExistingSet({
      command: "activate", homeDir: input.homeDir, generation: input.generation, confirmGenerationId: input.confirmGenerationId,
      confirmBackend: { expected: "postgresql", value: input.confirmBackend }, ops,
      admittedRoutes: ["prepared", "activate", "settled-activated"],
    });
    if (admission.status === "refuse") return admission.outcome;
    if (input.dryRun === true) return previewRefusal("activate", admission.observation, NOT_EVALUATED);
    return runActivation(input.homeDir, admission.setId, admission.observation, ops);
  });
}

export function performSetRollback(input: MigrationSetCutoverInput): Promise<MigrationSetOutcome> {
  return boundary(async () => {
    const ops = resolveOperations(input._operationsForTesting);
    const admission = await admitExistingSet({
      command: "rollback", homeDir: input.homeDir, generation: input.generation, confirmGenerationId: input.confirmGenerationId,
      confirmBackend: { expected: "sqlite", value: input.confirmBackend }, ops,
      admittedRoutes: ["rollback", "activate", "settled-activated", "settled-rolled-back"],
    });
    if (admission.status === "refuse") return admission.outcome;
    if (input.dryRun === true) {
      return previewRefusal("rollback", admission.observation, "eligibility,mode,quiescence,lease,drift,remote-bindings,restart");
    }
    return runRollback(input.homeDir, admission.setId, admission.observation, ops);
  });
}

// ---------------------------------------------------------------------------
// resume --set: drive exactly the one service the durable state admits (C3)
// ---------------------------------------------------------------------------

export type MigrationSetResumeInput = MigrationSetExistingInput & Readonly<{ maxRecords?: number; maxBytes?: number }>;

const RESUME_ROUTES: readonly SetRoute[] = [
  "prepare", "prepared", "activate", "rollback", "abort", "settled-activated", "settled-rolled-back", "settled-aborted",
];

export function performSetResume(input: MigrationSetResumeInput): Promise<MigrationSetOutcome> {
  return boundary(async () => {
    const ops = resolveOperations(input._operationsForTesting);
    const admission = await admitExistingSet({
      command: "resume", homeDir: input.homeDir, generation: input.generation, confirmGenerationId: input.confirmGenerationId,
      ops, admittedRoutes: RESUME_ROUTES,
    });
    if (admission.status === "refuse") return admission.outcome;
    const { observation, setId } = admission;
    const { route } = observation;
    const sections: MigrationEvidence = {
      ...setSections(observation), ...journalSections(observation.journal), ...setRowsEvidence(observedRows(observation)),
    };
    if (route === "prepare" && observation.prepareBlock !== null) {
      const { reason, bucket } = observation.prepareBlock;
      return serviceRefusal({
        command: "resume", reason, bucket, setId, sections, next: bucket === "precondition" ? "abort --set" : null,
      });
    }
    if (route === "prepared" || route === "settled-activated" || route === "settled-rolled-back" || route === "settled-aborted") {
      // Settled: nothing to run, and nothing is chained into a next operation.
      return { status: "ok", generationId: setId, manifestPhase: null, applied: false, next: nextForRoute(route) ?? "report --set", evidence: sections };
    }
    if (input.dryRun === true) {
      return {
        status: "ok", generationId: setId, manifestPhase: null, applied: false,
        next: `resume --set (the ${route} route would run; drop --dry-run)`, evidence: sections,
      };
    }
    if (route === "activate") return runActivation(input.homeDir, setId, observation, ops);
    if (route === "rollback") return runRollback(input.homeDir, setId, observation, ops);
    if (route === "abort") {
      return performSetAbort({
        homeDir: input.homeDir, generation: setId, confirmGenerationId: setId, _operationsForTesting: ops,
      });
    }
    const target = targetConfigOf(input.homeDir, ops);
    if (target.status === "refuse") return target.outcome;
    const generationIds = observation.members.map((member) => member.generationId);
    const before = await fingerprintOf(input.homeDir, setId, generationIds, ops);
    const result = await ops.prepare({
      homeDir: input.homeDir, confirmSetId: setId, targetConfig: target.config,
      maxRecords: input.maxRecords ?? DEFAULT_MIGRATION_APPLY_MAX_RECORDS,
      maxBytes: input.maxBytes ?? DEFAULT_MIGRATION_APPLY_MAX_BYTES,
    });
    return mapPrepare({ homeDir: input.homeDir, result, before, generationIds, setId, ops });
  });
}

// ---------------------------------------------------------------------------
// report --set: read-only aggregate status
// ---------------------------------------------------------------------------

export type MigrationSetReportInput = Readonly<{
  homeDir: string;
  generation?: string;
  _operationsForTesting?: Partial<MigrationSetOperations>;
}>;

const REPORT_RESTART_REASONS: Readonly<Record<string, string>> = {
  [CUTOVER_RESTART_REASONS.required]: "report-restart-required",
  [CUTOVER_RESTART_REASONS.contradiction]: "report-restart-contradiction",
  [CUTOVER_RESTART_REASONS.unresolvable]: "report-restart-unresolvable",
};

export function performSetReport(input: MigrationSetReportInput): Promise<MigrationSetOutcome> {
  return readBoundary(async () => {
    const ops = resolveOperations(input._operationsForTesting);
    const selection = selectSet(input.generation);
    if (selection.status === "refuse") return refuse(selection.reason);
    const observation = await observationOf({ homeDir: input.homeDir, setId: selection.setId, ops });
    const { route, setId } = observation;
    const evidence: MigrationEvidence = {
      ...setSections(observation),
      ...journalSections(observation.journal),
      activationRecords: observation.activation.state === "resolved" ? "present" : observation.activation.state === "unresolvable" ? "unresolvable" : "absent",
      activationSelection: observation.activation.state === "resolved" ? observation.activation.selection !== null : false,
      rollbackRecords: observation.rollback.state === "resolved" ? "present"
        : observation.rollback.state === "unresolvable" ? "unresolvable"
        : observation.rollback.cause === "checkpoint-incomplete" ? "incomplete" : "absent",
      rollbackSelection: observation.rollback.state === "resolved" ? observation.rollback.selection !== null : false,
      ...setRowsEvidence(observedRows(observation)),
    };
    const next = nextForRoute(route);
    if (route === "unknown") return refuse("generation-unknown", { generationId: setId, sections: evidence, next });
    if (route === "reverse-id") return refuse("set-original-generation-required", { generationId: setId, sections: evidence });
    if (route === "unresolvable") return refuse("report-evidence-unresolvable", { generationId: setId, sections: evidence });
    if (route === "contradiction") return refuse("route-contradiction", { generationId: setId, sections: evidence });
    if (route === "foreign") return refuse("route-foreign-publication", { generationId: setId, sections: evidence });
    if (route === "single-generation-held") {
      return serviceRefusal({ command: "report", reason: "cutover-set-single-generation-held", bucket: "precondition", setId, sections: evidence });
    }
    // Lost member evidence is a failure of the report itself, whatever the owner route is.
    if (observation.members.some((member) => member.evidenceFailure !== null)) {
      return refuse("report-evidence-unresolvable", { generationId: setId, next, sections: evidence });
    }
    let restart: MigrationEnvelopeRestart | null = null;
    let restartEvidence: MigrationEvidence = {};
    let restartReason: string | undefined;
    if (route === "settled-activated" || route === "settled-rolled-back") {
      const observed = await ops.observeRestart({
        homeDir: input.homeDir, selected: route === "settled-activated" ? "postgresql" : "sqlite",
      });
      restart = observed.restart;
      restartEvidence = observed.evidence;
      restartReason = observed.reason === undefined ? undefined : REPORT_RESTART_REASONS[observed.reason];
    }
    const manifestPhase = commonPhase(observedRows(observation));
    if (restartReason !== undefined) {
      return refuse(restartReason, { generationId: setId, manifestPhase, next, sections: { ...evidence, ...restartEvidence }, restart });
    }
    return {
      status: "ok", generationId: setId, manifestPhase, applied: false, next, evidence: { ...evidence, ...restartEvidence }, restart,
    };
  });
}

// ---------------------------------------------------------------------------
// abort --set: the legacy whole-set abort, scope-confirmed and enriched
// ---------------------------------------------------------------------------

export type MigrationSetAbortInput = Readonly<{
  homeDir: string;
  generation?: string;
  confirmGenerationId?: string;
  dryRun?: boolean;
  _operationsForTesting?: Partial<MigrationSetOperations>;
}>;

export function performSetAbort(input: MigrationSetAbortInput): Promise<MigrationSetOutcome> {
  return withMigrationBoundary(async () => {
    const ops = resolveOperations(input._operationsForTesting);
    const observed = ops.observeJournal({ homeDir: input.homeDir });
    if (observed.kind === "hold" && observed.journal.cutoverSet === undefined) {
      return serviceRefusal({ command: "abort", reason: "cutover-set-single-generation-held", bucket: "precondition", setId: observed.journal.generationId, next: "abort" });
    }
    const hold = observed.kind === "hold" ? observed.journal : null;
    const outcome = await ops.abortCommand({
      homeDir: input.homeDir,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      ...(input.confirmGenerationId === undefined ? {} : { confirmGenerationId: input.confirmGenerationId }),
      ...(input.dryRun === true ? { dryRun: true } : {}),
    });
    const store = manifestStoreOf(input.homeDir);
    // A set hold always names its members; a manifest that was never created is a legitimate settled state.
    const rows: SetEvidenceRow[] = (hold?.cutoverSet?.manifest.members ?? []).map((member) => {
      let state: string;
      try {
        const presence = store.probeManifestPresence(member.generationId);
        state = presence.status === "present" ? store.read(member.generationId).phase : presence.status;
      } catch {
        state = "unresolvable";
      }
      return { projectId: member.physicalProjectId, generationId: member.generationId, state };
    });
    const sections: MigrationEvidence = {
      scope: "cutover-set", ...(hold === null ? {} : { setId: hold.generationId }), memberCount: rows.length, ...setRowsEvidence(rows),
    };
    if (outcome.status === "refuse") {
      return {
        status: "refuse", reason: outcome.reason, ...(outcome.evidence === undefined ? {} : { evidence: outcome.evidence }),
        ...(outcome.generationId === undefined ? {} : { generationId: outcome.generationId }),
        ...(outcome.applied === true ? { applied: true } : {}),
        next: outcome.next === "resume" ? "resume --set" : (outcome.next ?? null), sections,
      };
    }
    return {
      status: "ok", generationId: outcome.generationId, manifestPhase: commonPhase(rows), applied: outcome.applied,
      next: outcome.applied ? "plan --set" : null,
      evidence: { ...sections, journalPhase: outcome.journalPhase },
    };
  }, (evidence) => ({
    status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence, applied: true,
    sections: { scope: "cutover-set", writeObservation: "unresolvable" },
  }));
}
