import type { BackendMaintenanceJournal } from "../storage/backend-publication.js";

/**
 * Section 4.5's continuation resolution, with the two match predicates kept
 * distinct because the rebind moves fields (section 2.3 consequence 2):
 * conflating them would copy a comparison that is correct for
 * `maintenance-entering` and wrong for `maintenance-held`.
 */

export type MigrationHoldCandidate = Readonly<{
  publicationId: string;
  generationId: string;
  sourceSelectionSha256: string;
  machineId: string;
}>;

export type MigrationHoldDisposition =
  | Readonly<{ action: "recover-entering"; observedChecksumSha256: string }>
  | Readonly<{ action: "continue-held"; observedChecksumSha256: string }>
  | Readonly<{ action: "refuse"; reason: "mismatched-hold" }>
  | Readonly<{ action: "refuse"; reason: "resume-required" }>
  | Readonly<{ action: "probe-fresh" }>;

/**
 * The `maintenance-held` match: stable fields only — `publicationId`,
 * `generationId`, `sourceSelectionSha256`, `roster[0].machineId` — plus a
 * single-entry roster. Never `queueEvidenceSha256`, `roster[0].queueCutoff`
 * or `roster[0].evidenceSha256`: `rebindBackendMaintenanceCutoff` moves all
 * three (section 2.3 consequence 2), so a live, correct, already-rebound hold
 * would otherwise be refused as mismatched.
 */
function matchesHeldStableFields(
  journal: BackendMaintenanceJournal,
  candidate: MigrationHoldCandidate,
): boolean {
  return journal.phase === "maintenance-held"
    && journal.publicationId === candidate.publicationId
    && journal.generationId === candidate.generationId
    && journal.sourceSelectionSha256 === candidate.sourceSelectionSha256
    && journal.roster.length === 1
    && journal.roster[0]!.machineId === candidate.machineId;
}

/**
 * Routes an existing v3 maintenance journal to the action `apply` takes
 * next. This function never mutates the journal and never calls
 * `enterMaintenance` itself:
 *
 * - `maintenance-entering`: the full comparison including
 *   `queueEvidenceSha256` and canonical roster is `enterMaintenance`'s own
 *   recovery comparison (the rebind has not run yet, so those fields are
 *   still identity, not post-rebind state). This item does not duplicate
 *   that comparison; the caller re-invokes `enterMaintenance` with its
 *   intended input and lets the coordinator's own comparison run. A mismatch
 *   surfaces there as `unexpected-state`, which the caller maps to the same
 *   `mismatched-hold` refusal named here.
 * - `maintenance-held`: the stable-fields match above decides directly,
 *   because `enterMaintenance` cannot be called again on a held journal at
 *   all (`maintenance-held` is not in its existing-journal allowlist) —
 *   this is the section 2.4 / A-1 defect plan-v1 shipped.
 * - `selection-prepared`: not this item's state; `resume` owns it.
 * - `selection-completed` or `maintenance-aborted` (named explicitly, not
 *   inferred as "whatever is left"): probe for a fresh candidate, subject
 *   to the section 4.6 abort gate, which this function does not itself
 *   apply. A phase this function does not recognise is not silently routed
 *   here — `BackendMaintenancePhase` is exhausted below, so adding a phase
 *   without updating this function fails to compile rather than starting a
 *   fresh cutover on an unrecognised state.
 *
 * Section 4.9's second exposure: this journal is mutable, and the
 * classification above is a snapshot of it taken at one moment. Both
 * actionable dispositions (`recover-entering`, `continue-held`) carry the
 * exact `checksumSha256` this function observed, so the caller can pass it
 * on as the compare-and-swap input to whatever it calls next
 * (`enterMaintenance`'s `expectedChecksumSha256` for a recovered entering
 * journal; capture's `maintenanceChecksumSha256`, which `revalidate` already
 * compares, for a continued hold) — never re-read at the point of use. A
 * re-read would silently turn a compare-and-swap into a read-modify-write:
 * the journal could move between this classification and the caller's next
 * step, and a freshly re-read checksum would agree with whatever it moved
 * to, defeating the comparison it exists to make.
 */
export function resolveMigrationHoldContinuation(input: Readonly<{
  journal: BackendMaintenanceJournal;
  candidate: MigrationHoldCandidate;
}>): MigrationHoldDisposition {
  const { journal, candidate } = input;
  if (journal.phase === "maintenance-entering") {
    return { action: "recover-entering", observedChecksumSha256: journal.checksumSha256 };
  }
  if (journal.phase === "maintenance-held") {
    if (matchesHeldStableFields(journal, candidate)) {
      return { action: "continue-held", observedChecksumSha256: journal.checksumSha256 };
    }
    return { action: "refuse", reason: "mismatched-hold" };
  }
  if (journal.phase === "selection-prepared") {
    return { action: "refuse", reason: "resume-required" };
  }
  if (journal.phase === "selection-completed" || journal.phase === "maintenance-aborted") {
    return { action: "probe-fresh" };
  }
  // Exhaustiveness guard, not a residual default: a future phase added to
  // BackendMaintenancePhase must fail to compile here rather than silently
  // falling through to probe-fresh, which is the one disposition that
  // starts a fresh cutover. Concluding "not one of the phases I named,
  // therefore terminal" would be an inference from absence, not a positive
  // observation.
  const exhaustive: never = journal.phase;
  throw new Error(`unreachable migration maintenance phase: ${exhaustive as string}`);
}
