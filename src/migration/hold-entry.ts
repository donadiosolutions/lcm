import {
  backendMaintenanceQueueEvidenceSentinel,
  BackendPublicationJournalError,
  type BackendMaintenanceJournal,
  type BackendMaintenanceRosterEntry,
} from "../storage/backend-publication.js";
import { PrivateMutationLockContentionError } from "../private-mutation-lock.js";

/**
 * Section 4.4's unbound sentinel and single-entry roster construction, and
 * the classification the section 4.5 `recover-entering` disposition needs
 * once it actually calls `enterMaintenance` again.
 */

/**
 * The canonical digest over an explicit unbound sentinel body, domain-
 * separated by canonical shape from the real queue-evidence preimage
 * (`{version: 1, sourceSelectionSha256, roles}`, `sqlite-snapshot.ts:1052-1060`).
 * This is the honest claim (section 4.4): the two shapes are distinguishable
 * by construction, not "provably distinguishable" in a stronger
 * probabilistic sense that nothing here relies on.
 *
 * Fixed at entry and never recomputed on a continuation (section 2.3
 * consequence 3): a continuation compares the journal's *current*
 * `queueEvidenceSha256` against this same entry-time sentinel only to
 * decide whether the rebind has run yet, never to reconstruct evidence.
 */
export function migrationQueueEvidenceSentinel(input: Readonly<{
  generationId: string;
  sourceSelectionSha256: string;
}>): string {
  return backendMaintenanceQueueEvidenceSentinel(input);
}

/**
 * The single-entry roster `enterMaintenance` requires (capture refuses
 * unless `roster.length === 1` with a matching `machineId` and a local
 * project scope). `queueCutoff` is constructed `null`, which is a rule, not
 * an accident: section 9's confirmation fence uses its null-to-non-null
 * transition as an independent observation, and section 4.4's sentinel
 * pairs with it as the other side.
 */
export function migrationEntryRoster(input: Readonly<{
  machineId: string;
  sentinelEvidenceSha256: string;
}>): readonly BackendMaintenanceRosterEntry[] {
  return [{
    machineId: input.machineId,
    queueCutoff: null,
    evidenceSha256: input.sentinelEvidenceSha256,
  }];
}

/**
 * How `apply` must classify a failure from re-invoking `enterMaintenance`
 * during `maintenance-entering` recovery (section 4.5's `recover-entering`).
 * Every throw is classified by its actual reason, never by the fact that it
 * threw: collapsing every throw into one refusal class would tell an
 * operator to `abort` in response to contention or an unattributable
 * storage failure, which is the wrong remedy for both.
 */
export type MigrationEnteringRecoveryOutcome =
  | Readonly<{ status: "recovered"; journal: BackendMaintenanceJournal }>
  | Readonly<{ status: "refuse"; class: "precondition"; evidence: string }>
  | Readonly<{ status: "refuse"; class: "contention"; evidence: string }>
  | Readonly<{ status: "refuse"; class: "evidence"; evidence: string }>;

/**
 * Only `unexpected-state` reflects a genuine precondition mismatch (the
 * entering journal itself does not match the recovery request, or its
 * checkpoint is no longer current) — the actual case section 4.5 names.
 * Every other `BackendPublicationJournalError` reason reaching here
 * (`unresolved-publication` from a journal that changed underneath this
 * call, `unsafe-storage` or `malformed-journal` from the directory read
 * inside `enterMaintenance`, or anything else) is not a clean "your request
 * did not match" answer, and is classified as unresolvable evidence rather
 * than asserted as a precondition mismatch it cannot actually establish.
 * A reason this function does not recognise is exit 5, never exit 2: an
 * unclassifiable failure is precisely the case that must not be asserted as
 * a conclusion.
 */
export function classifyEnteringRecoveryFailure(error: unknown): MigrationEnteringRecoveryOutcome {
  if (error instanceof PrivateMutationLockContentionError) {
    return { status: "refuse", class: "contention", evidence: "lock-contention" };
  }
  if (error instanceof BackendPublicationJournalError) {
    if (error.reason === "unexpected-state") {
      return { status: "refuse", class: "precondition", evidence: "journal-unexpected-state" };
    }
    return { status: "refuse", class: "evidence", evidence: `journal-${error.reason}` };
  }
  return { status: "refuse", class: "evidence", evidence: "journal-internal-error" };
}

/**
 * How `apply` classifies a failure from the *fresh* `enterMaintenance` call
 * (round-1 B-5/A-11). Like `classifyEnteringRecoveryFailure` it classifies by
 * the actual reason rather than by the fact that something threw:
 *
 * - lock contention: another actor holds the publication lock; retry.
 * - `unresolved-publication`: a v2 publication (or another maintenance hold)
 *   occupies the journal slot. This is not ours to abort, so its remedy must
 *   not name `abort`.
 * - `unexpected-state`: the journal moved under the compare-and-swap.
 * - everything else (`unsafe-storage`, `malformed-journal`, checksum and
 *   evidence failures, an unrecognised error): unresolvable evidence.
 */
export type MigrationHoldEntryFailureClass = "contention" | "slot-occupied" | "precondition" | "evidence";

export function classifyHoldEntryFailure(error: unknown): Readonly<{ class: MigrationHoldEntryFailureClass; evidence: string }> {
  if (error instanceof PrivateMutationLockContentionError) {
    return { class: "contention", evidence: "lock-contention" };
  }
  if (error instanceof BackendPublicationJournalError) {
    if (error.reason === "unresolved-publication") {
      return { class: "slot-occupied", evidence: "journal-unresolved-publication" };
    }
    if (error.reason === "unexpected-state") {
      return { class: "precondition", evidence: "journal-unexpected-state" };
    }
    return { class: "evidence", evidence: `journal-${error.reason}` };
  }
  return { class: "evidence", evidence: "journal-internal-error" };
}

/**
 * The section 9 operative test for whether the rebind has run against a
 * held journal: equal to the sentinel before capture, different after,
 * with `roster[0].queueCutoff` moving null to non-null as the independent
 * second side. Both sides must agree; either alone is not conclusive
 * (a journal could in principle have a non-null `queueCutoff` for an
 * unrelated reason, or a digest mismatch from corruption rather than a
 * genuine rebind, so this only reports "rebind occurred" when both move
 * together).
 */
export function hasMigrationQueueEvidenceRebindOccurred(input: Readonly<{
  journal: BackendMaintenanceJournal;
  sentinel: string;
}>): boolean {
  const { journal, sentinel } = input;
  const digestMoved = journal.queueEvidenceSha256 !== sentinel;
  const cutoffMoved = journal.roster.length === 1 && journal.roster[0]!.queueCutoff !== null;
  return digestMoved && cutoffMoved;
}
