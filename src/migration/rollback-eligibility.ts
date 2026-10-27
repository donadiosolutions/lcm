/**
 * Pure rollback-eligibility decision logic for item #626.
 *
 * Everything this module decides is a function of values the caller already
 * fetched: the binding-store resolution, the activation-evidence-store
 * resolution, the operability fact, a live readback, and the fully parsed
 * epoch and attempt records. It performs no I/O. The records and their
 * parsers are activation-witness.ts's, the binding types are
 * generation-binding-store.ts's, and the evidence types are
 * activation-evidence-store.ts's; this file defines none of them, derives no
 * identity and computes no checksum.
 *
 * The one boundary that stays an input is the operability fact (Boundary C,
 * coordinator-seam-FROZEN.md v6 sections 15-16). Its production reader lives
 * beside rollback.ts's orchestration, where the "read before prepare()"
 * ordering constraint section 16 requires is enforced, and is passed in
 * already resolved so this module keeps its no-I/O invariant.
 */

import { PORTABLE_RECORD_SCHEMA_SHA256 } from "../storage/portable-record.js";
import {
  classifyMigrationRollbackMode,
  migrationCanonicalDeltaChanged,
  type MigrationActivationAttempt,
  type MigrationActivationEpoch,
  type MigrationCanonicalDelta,
  type MigrationCensusVector,
  type MigrationDestinationIdentity,
} from "./activation-witness.js";
import type {
  MigrationActivationEvidenceResolution,
  RollbackAuthoritativeContext,
} from "./activation-evidence-store.js";
import type {
  MigrationSelectionBinding,
  MigrationWitnessBinding,
  MigrationWitnessResolution,
} from "./generation-binding-store.js";

export type {
  MigrationSelectionBinding,
  MigrationWitnessBinding,
  MigrationWitnessResolution,
  MigrationActivationEvidenceResolution,
  RollbackAuthoritativeContext,
};

/**
 * Boundary A. The production implementation is
 * generation-binding-store.ts's resolveMigrationWitnessBindings; the
 * "authoritatively-absent" branch is produced only by a positively
 * authenticated read finding nothing, and "unresolvable" covers every other
 * failure to read authoritatively. This module never collapses the two --
 * see {@link resolveActivationAuthority}.
 */
export type MigrationWitnessResolver = (
  input: Readonly<{ homeDir: string; generationId: string }>,
) => MigrationWitnessResolution;

/**
 * The activation evidence store read (activation-evidence-store.ts's
 * readMigrationActivationEvidence), with the same three-valued contract as
 * {@link MigrationWitnessResolver}.
 */
export type ActivationEvidenceResolver = (
  input: Readonly<{ homeDir: string; generationId: string }>,
) => MigrationActivationEvidenceResolution;

// ---------------------------------------------------------------------------
// Rollback mode classification: an adapter over activation-witness.ts's
// classifyMigrationRollbackMode, which throws instead of returning a
// refusal.
// ---------------------------------------------------------------------------

export type RollbackModeClassification =
  | Readonly<{ mode: "pre-write" }>
  | Readonly<{ mode: "post-write" }>
  | Readonly<{ mode: "refused"; reason: string }>;

/**
 * Maps exactly the classifier's two precondition throws to a refusal, by
 * checking those preconditions BEFORE calling it: the attempt must belong to
 * the epoch, and once the delta shows no change a census must be present
 * (equality of deltas is inconclusive; "pre-write" authorises discarding the
 * destination and is unreachable without a census). With the preconditions
 * established, every throw from the classifier propagates unchanged -- a
 * malformed record is a defect to surface, never a refusal to absorb.
 * Refusal never falls through to a post-write answer.
 */
export function classifyRollbackEligibilityMode(input: Readonly<{
  epoch: MigrationActivationEpoch;
  attempt: MigrationActivationAttempt;
  postEpochDelta: MigrationCanonicalDelta;
  postEpochCensus: MigrationCensusVector | null;
}>): RollbackModeClassification {
  if (input.attempt.epochId !== input.epoch.epochId) {
    return { mode: "refused", reason: "the activation attempt does not belong to the authoritative epoch" };
  }
  if (
    input.postEpochCensus === null
    && !migrationCanonicalDeltaChanged(input.postEpochDelta, input.attempt.canonicalDeltaBaseline)
  ) {
    return { mode: "refused", reason: "canonical delta is unchanged and no census was supplied" };
  }
  return { mode: classifyMigrationRollbackMode(input) };
}

// ---------------------------------------------------------------------------
// coordinator-seam-FROZEN.md v6 section 16 (adds to section 15). The
// operability fact for a PostgreSQL destination: whether a version-2
// backend publication journal sits in the live slot at phase "completed"
// targeting "postgresql" -- the fact that makes the destination operable,
// compared as a value rather than inferred from ordering or timing.
// Boundary C. #626 owns the production reader; this module consumes only the
// already-resolved value.
// ---------------------------------------------------------------------------

export type OperabilityFactResolution =
  | Readonly<{ state: "present"; valueSha256: string }>
  | Readonly<{ state: "authoritatively-absent" }>
  | Readonly<{ state: "unresolvable"; reason: string }>;

/**
 * Boundary C. #626 owns the production implementation: read the live
 * `BackendPublicationJournal` (never the maintenance journal, and never by
 * delegating to `assertBackendPublicationConsumerAccess` or
 * `PostgreSqlStorageBackendFactory.capturePublicationWitness`, both of
 * which throw identically for "the journal names a different backend" and
 * for "the read itself failed" -- exactly the collapsed absence this
 * boundary exists to avoid) under the backend-publication consumer lock,
 * and classify three-valued:
 *
 *  - `present`: the read succeeded and the journal is non-null, phase
 *    `completed`, `targetBackend` `postgresql`. `valueSha256` is
 *    `backendPublicationCanonicalSha256` over the same four-field witness
 *    shape the factory computes (`journalChecksum`, `journalPhase`,
 *    `targetBackend`, `stateSha256` from `captureBackendPublicationState`),
 *    so both consumers of this fact compare identical bytes.
 *  - `authoritatively-absent`: the read succeeded and the journal is null,
 *    or its phase or target is not that exact combination.
 *  - `unresolvable`: the read itself did not succeed (lock contention,
 *    unsafe storage, an unreadable or malformed journal, including the
 *    in-progress-maintenance case where the live slot currently holds a
 *    maintenance journal instead of a publication journal).
 *
 * MUST be read during eligibility, before this item's own `prepare()` runs
 * (plan-v2 section 5 step 7): `prepare()` archives the live publication
 * slot out of the live position, so a read taken afterward observes the
 * rollback's own publication rather than the fact being asked about.
 */
export type OperabilityFactResolver = (
  input: Readonly<{ homeDir: string }>,
) => Promise<OperabilityFactResolution>;

// ---------------------------------------------------------------------------
// Section 12 (epoch absence, one direction only) as amended by section 14
// (witnesses/selections split), sections 15-16 (the operability fact) and
// plan-v3.1 amendment A1 (the activation evidence store). Pure: takes
// already-resolved values, never performs a read itself.
// ---------------------------------------------------------------------------

export type ActivationAuthority =
  | Readonly<{ status: "unactivated" }>
  | Readonly<{ status: "authoritative"; selection: MigrationSelectionBinding }>
  | Readonly<{ status: "refused"; reason: string }>;

/** The only authority a rollback acts on: an unactivated generation is refused before any rollback step. */
export type AuthoritativeActivation = Extract<ActivationAuthority, Readonly<{ status: "authoritative" }>>;

function refuse(reason: string): ActivationAuthority {
  return { status: "refused", reason };
}

/**
 * Decides activation authority from three independent observations -- E, the
 * activation evidence store; S, the binding store; O, the operability fact --
 * per plan-v3.1 amendment A1 (coordinator-seam-FROZEN.md section 12 is
 * normative). `unactivated` is reachable only when all three agree; every
 * disagreement refuses, and corrupting any one of them alone refuses. In
 * order:
 *
 *  1. Any of E, S or O unresolvable -- refuse, regardless of the others.
 *     Each is a read failure and none licenses any conclusion.
 *  2. E authoritatively absent, with an activation selection or any witness
 *     binding in S -- refuse: a binding without its evidence.
 *  3. An activation selection in S (E resolved) -- authoritative, but only
 *     if the evidence store holds the witness the selection names, the
 *     attempt it names, and the epoch both name, and they agree with each
 *     other; any missing or disagreeing record refuses. The attempt the
 *     witness names is the one classified against, not whichever attempt is
 *     newest.
 *  4. No activation selection, operability fact present -- refuse,
 *     "published but unbound". NEVER `unactivated`: the destination is
 *     already operable under postgresql and the binding simply has not been
 *     durably written yet.
 *  5. No activation selection, operability fact authoritatively absent --
 *     `unactivated`. This covers both "never activated" (E absent, no
 *     witness) and "witnessed but unpublished" (E holds an epoch, S may hold
 *     witnesses): no selection was ever published.
 *
 * No branch collapses `authoritatively-absent` and `unresolvable` for any of
 * the three readers. Every refusal names which reader and which of its
 * states produced it, so a consumer (#627, an operator) does not have to
 * re-derive the attribution from a bare failure.
 */
export function resolveActivationAuthority(input: Readonly<{
  resolution: MigrationWitnessResolution;
  evidence: MigrationActivationEvidenceResolution;
  operabilityFact: OperabilityFactResolution;
}>): ActivationAuthority {
  const { resolution, evidence, operabilityFact } = input;

  if (operabilityFact.state === "unresolvable") {
    return refuse(`operability-fact:unresolvable: ${operabilityFact.reason}`);
  }
  if (resolution.state === "unresolvable") {
    return refuse(`witness-resolution:unresolvable: ${resolution.reason}`);
  }
  if (evidence.state === "unresolvable") {
    return refuse(`activation-evidence:unresolvable: ${evidence.reason}`);
  }

  const selections = resolution.state === "resolved" ? resolution.selections : [];
  const witnessBindings = resolution.state === "resolved" ? resolution.witnesses : [];
  const activationSelections = selections.filter((selection) => selection.kind === "activation");
  const selection = activationSelections[activationSelections.length - 1];

  if (evidence.state === "authoritatively-absent" && (selection !== undefined || witnessBindings.length > 0)) {
    return refuse(
      "activation-evidence:authoritatively-absent: a binding exists without its evidence record",
    );
  }

  if (selection !== undefined) {
    // evidence.state is "resolved" here: the absent case with a selection
    // refused above.
    const stored = evidence as Extract<MigrationActivationEvidenceResolution, { state: "resolved" }>;
    const witness = stored.witnesses.find((candidate) => candidate.checksumSha256 === selection.witnessChecksumSha256);
    if (witness === undefined) {
      return refuse("activation-evidence:witness-missing: the selected witness is not in the evidence store");
    }
    const attempt = stored.attempts.find((candidate) => candidate.attemptId === witness.attemptId);
    if (attempt === undefined) {
      return refuse("activation-evidence:attempt-missing: the selected witness's attempt is not in the evidence store");
    }
    const epoch = stored.epochs.find((candidate) => candidate.epochId === witness.epochId);
    if (epoch === undefined) {
      return refuse("activation-evidence:epoch-missing: the selected witness's epoch is not in the evidence store");
    }
    if (
      witness.kind !== selection.kind
      || witness.epochId !== selection.epochId
      || witness.attemptId !== selection.attemptId
      || attempt.epochId !== epoch.epochId
    ) {
      return refuse(
        "activation-evidence:mismatch: the selection, its witness, attempt and epoch do not name each other",
      );
    }
    return { status: "authoritative", selection };
  }

  if (operabilityFact.state === "present") {
    return refuse(
      "operability-fact:published-but-unbound: destination is operable under postgresql "
        + "but no activation selection binding is bound yet",
    );
  }

  return { status: "unactivated" };
}

// ---------------------------------------------------------------------------
// Full eligibility decision. Combines the authority resolution above with
// the identity gate, schema-bound census comparability, and the classifier
// adapter, in the order plan-v2 section 1 mandates: identity first and
// separately (refusing before any durable change), then the delta (which
// may only ever conclude change), then the census (the only witness that
// may conclude cleanliness).
// ---------------------------------------------------------------------------

/** A single dedicated-snapshot readback, per plan-v2 section 5 step 4/10. */
export type RollbackEligibilityObservation = Readonly<{
  /** The schema this observation's census was computed under. */
  observedPortableRecordSchemaSha256: string;
  /** Fresh destination identity read in the same dedicated snapshot. */
  destinationIdentity: MigrationDestinationIdentity;
  /** Fresh canonical delta read in the same dedicated snapshot. */
  postEpochDelta: MigrationCanonicalDelta;
  /** Fresh census, present only when the delta was found equal to the baseline. */
  postEpochCensus: MigrationCensusVector | null;
}>;

export type RollbackEligibilityDecision =
  | Readonly<{ eligibility: "pre-write"; mode: "pre-write" }>
  | Readonly<{ eligibility: "post-write"; mode: "post-write" }>
  | Readonly<{ eligibility: "refused"; reason: string }>;

function sameDestinationIdentity(left: MigrationDestinationIdentity, right: MigrationDestinationIdentity): boolean {
  return left.sealedWitnessSha256 === right.sealedWitnessSha256
    && left.systemIdentifier === right.systemIdentifier;
}

export function evaluateRollbackEligibility(input: Readonly<{
  /** The full records of the authoritative activation being unwound. */
  authoritativeContext: RollbackAuthoritativeContext;
  observation: RollbackEligibilityObservation;
}>): RollbackEligibilityDecision {
  const { authoritativeContext, observation } = input;

  // Identity gate first and separately, refusing before any durable change
  // and before the classifier is ever consulted.
  if (!sameDestinationIdentity(authoritativeContext.epoch.destinationIdentity, observation.destinationIdentity)) {
    return { eligibility: "refused", reason: "destination identity does not match the authoritative epoch" };
  }

  // Census comparability is schema-bound: compare the schema first and
  // refuse with a distinct reason rather than falling to post-write, since
  // a new-schema destination is not proof of a write.
  if (
    observation.postEpochCensus !== null
    && observation.observedPortableRecordSchemaSha256 !== PORTABLE_RECORD_SCHEMA_SHA256
  ) {
    return { eligibility: "refused", reason: "observed census schema is not comparable to the frozen portable record schema" };
  }

  const classification = classifyRollbackEligibilityMode({
    epoch: authoritativeContext.epoch,
    attempt: authoritativeContext.attempt,
    postEpochDelta: observation.postEpochDelta,
    postEpochCensus: observation.postEpochCensus,
  });

  if (classification.mode === "refused") return { eligibility: "refused", reason: classification.reason };
  if (classification.mode === "pre-write") return { eligibility: "pre-write", mode: "pre-write" };
  return { eligibility: "post-write", mode: "post-write" };
}
