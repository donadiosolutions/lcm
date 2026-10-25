import type { BackendMaintenancePhase, BackendPublicationPhase } from "../storage/backend-publication.js";
import type { MigrationEffectKind, MigrationPhase } from "./protocol.js";
import { deriveRollbackPublicationId } from "./rollback.js";

/**
 * Owner rulings recorded here (owner ruling R7/R8, plan-v5 amendment):
 *
 * - R7: `abort` is allowed at row 19 (planned, nothing pending), row 21 only
 *   when nothing is pending, and row 22, so that abort stays an exit from
 *   every hold whose manifest side it can settle while verify's fresh path
 *   waits for #625. With a pending copy effect (row 21), a pending dry-run
 *   (row 20) or a pending verification (row 23) abort stays a non-owner and
 *   exits 6, naming resume (or verify for row 23).
 * - R8: `abort` is allowed at row 5 (journal already `maintenance-aborted`,
 *   manifest absent or aborted) as a read-only confirmation: the command
 *   performs no write, exits 0 and reports `applied: false` with read-back
 *   evidence of the settled pair (plan-v2 section 4.6, finding PA-6).
 *
 * - R9: `verify` is allowed at row 24 (held, `verified`, nothing pending) as
 *   a read-back-only action, so that re-running it is the idempotent
 *   confirmation from persisted evidence plan-v4 section 5 step 2 specifies
 *   ("verified, no pending: exit 0"), instead of exit 7. It writes nothing.
 * - R10: row 6 (journal aborted, pending `abort`) is completed by
 *   `completePendingMigrationAbort`, which shares its effect id and
 *   completion formulas with `performMigrationAbort`.
 *
 * Plan-v5 Part B (1): the one pure router for an explicit existing
 * generation. It is shared by every existing-generation command (as the
 * owner check), by `resume` (which executes only the cells it owns) and by
 * `report` (as `nextAction`), so the three can never disagree. Fresh
 * `plan`, `apply` and `dry-run` keep the candidate resolver and never come
 * through here.
 *
 * It reads nothing and writes nothing: every observation is an input. Rows
 * are evaluated top to bottom and the first match wins; an unknown phase,
 * pending kind, snapshot class or link status throws, which the command
 * boundary maps to exit 5. Cells the protocol cannot create map to a
 * contradiction row (5), never to two rows.
 */

export type MigrationRouteCommand = "apply" | "resume" | "verify" | "activate" | "rollback" | "abort" | "report";
export type MigrationRoutePrimary = "none" | Exclude<MigrationRouteCommand, "report">;

export type MigrationRouteJournal =
  | Readonly<{ kind: "unresolvable" }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "hold"; phase: BackendMaintenancePhase; generationId: string }>
  | Readonly<{ kind: "publication"; publicationId: string; phase: BackendPublicationPhase }>;

export type MigrationRouteManifest =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unresolvable" }>
  | Readonly<{ kind: "present"; phase: MigrationPhase; pending: MigrationEffectKind | null }>;

export type MigrationRouteSnapshot = "absent" | "partial" | "complete" | "replaced" | "tampered" | "unresolvable";

export type MigrationRouteLink =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unresolvable" }>
  | Readonly<{ kind: "present"; publicationId: string }>;

export type MigrationRouteInput = Readonly<{
  journal: MigrationRouteJournal;
  resolvedGenerationId: string;
  manifest: MigrationRouteManifest;
  snapshot: MigrationRouteSnapshot;
  link: MigrationRouteLink;
}>;

export type MigrationRouteExit = 2 | 4 | 5 | 6 | 7;

export type MigrationRoute = Readonly<{
  /** The single mutation owner of this cell. */
  primary: MigrationRoutePrimary;
  /** Who else may run this cell. `report` is always allowed to read and never to mutate. */
  allowed: readonly Exclude<MigrationRouteCommand, "report">[];
  /** The exit a command outside `primary` and `allowed` gets. */
  exitIfRefused: MigrationRouteExit;
  /** Which row of the plan-v5 table matched (1-25). */
  row: number;
  /** What an operator should run next, for `report` and for refusal remedies. */
  nextAction: MigrationRoutePrimary | "report";
}>;

const HOLD_PHASES: readonly BackendMaintenancePhase[] = [
  "maintenance-entering", "maintenance-held", "selection-prepared", "selection-completed", "maintenance-aborted",
];
const PUBLICATION_PHASES: readonly BackendPublicationPhase[] = [
  "preparing", "prepared", "acquiring", "guarded", "map-publishing", "map-published",
  "config-publishing", "config-published", "releasing", "released", "aborting",
  "config-restoring", "map-restoring", "abort-releasing", "aborted", "completed",
];
const MANIFEST_PHASES: readonly MigrationPhase[] = [
  "planned", "dry-run-verified", "copying", "copied", "verified", "activating", "active",
  "rolling-back", "rolled-back", "aborted",
];
const EFFECT_KINDS: readonly MigrationEffectKind[] = [
  "verify-dry-run", "copy-batch", "complete-copy", "verify-generation", "prepare-activation",
  "publish-activation", "prepare-rollback", "publish-rollback", "abort",
];
const SNAPSHOTS: readonly MigrationRouteSnapshot[] = ["absent", "partial", "complete", "replaced", "tampered", "unresolvable"];
const LINK_KINDS: readonly string[] = ["absent", "unresolvable", "present"];
const ABORTABLE_PHASES: readonly MigrationPhase[] = ["planned", "dry-run-verified", "copying", "copied", "verified"];

function assertKnown<T extends string>(kind: string, value: unknown, known: readonly T[]): asserts value is T {
  if (!known.includes(value as T)) throw new Error(`unknown migration route ${kind}: ${String(value)}`);
}

function validate(input: MigrationRouteInput): void {
  const { journal, manifest, link } = input;
  assertKnown("journal kind", journal.kind, ["unresolvable", "absent", "hold", "publication"]);
  if (journal.kind === "hold") assertKnown("hold phase", journal.phase, HOLD_PHASES);
  if (journal.kind === "publication") assertKnown("publication phase", journal.phase, PUBLICATION_PHASES);
  assertKnown("manifest kind", manifest.kind, ["absent", "unresolvable", "present"]);
  if (manifest.kind === "present") {
    assertKnown("manifest phase", manifest.phase, MANIFEST_PHASES);
    if (manifest.pending !== null) assertKnown("pending effect kind", manifest.pending, EFFECT_KINDS);
  }
  assertKnown("snapshot class", input.snapshot, SNAPSHOTS);
  assertKnown("link status", link.kind, LINK_KINDS);
}

type Allowed = readonly Exclude<MigrationRouteCommand, "report">[];

type Row = Readonly<{
  row: number;
  matches: (input: MigrationRouteInput) => boolean;
  primary: MigrationRoutePrimary;
  allowed: Allowed | ((input: MigrationRouteInput) => Allowed);
  nextAction?: MigrationRoutePrimary | "report";
  /** The refusal for a command outside primary and allowed. */
  exit: (input: MigrationRouteInput) => MigrationRouteExit;
}>;

function fixed(code: MigrationRouteExit): Row["exit"] {
  return () => code;
}

function isOwnPublication(input: MigrationRouteInput): boolean {
  return input.journal.kind === "publication"
    && input.link.kind === "present"
    && input.link.publicationId === input.journal.publicationId;
}

/** A rollback leaves its own publication in the slot; the activation link never names it. */
function isRollbackPublication(input: MigrationRouteInput): boolean {
  return input.journal.kind === "publication"
    && input.journal.publicationId === deriveRollbackPublicationId(input.resolvedGenerationId);
}

function publicationInFlight(input: MigrationRouteInput): boolean {
  return input.journal.kind === "publication"
    && input.journal.phase !== "completed" && input.journal.phase !== "aborted";
}

function hold(input: MigrationRouteInput): Extract<MigrationRouteJournal, { kind: "hold" }> | null {
  return input.journal.kind === "hold" ? input.journal : null;
}

function holdPhaseIn(input: MigrationRouteInput, phases: readonly BackendMaintenancePhase[]): boolean {
  const journal = hold(input);
  return journal !== null && phases.includes(journal.phase);
}

function holdMatches(input: MigrationRouteInput, phases: readonly BackendMaintenancePhase[]): boolean {
  const journal = hold(input);
  return journal !== null && phases.includes(journal.phase) && journal.generationId === input.resolvedGenerationId;
}

function present(input: MigrationRouteInput): Extract<MigrationRouteManifest, { kind: "present" }> | null {
  return input.manifest.kind === "present" ? input.manifest : null;
}

function isCopyEffect(pending: MigrationEffectKind | null): boolean {
  return pending === "copy-batch" || pending === "complete-copy";
}

const ENTERING_OR_HELD: readonly BackendMaintenancePhase[] = ["maintenance-entering", "maintenance-held"];
const BROKEN_SNAPSHOT: readonly MigrationRouteSnapshot[] = ["partial", "replaced", "tampered"];

const ROWS: readonly Row[] = [
  { row: 1, primary: "none", allowed: [], exit: fixed(5),
    matches: (i) => i.journal.kind === "unresolvable" || i.manifest.kind === "unresolvable"
      || i.snapshot === "unresolvable" || i.link.kind === "unresolvable" },
  { row: 2, primary: "none", allowed: [], exit: fixed(4),
    matches: (i) => i.journal.kind === "publication" && !isOwnPublication(i) && !isRollbackPublication(i) && publicationInFlight(i) },
  { row: 3, primary: "none", allowed: [], exit: fixed(5),
    matches: (i) => i.journal.kind === "publication" && !isOwnPublication(i) && !isRollbackPublication(i) },
  { row: 4, primary: "abort", allowed: [], exit: fixed(2),
    matches: (i) => holdPhaseIn(i, ENTERING_OR_HELD) && !holdMatches(i, ENTERING_OR_HELD) },
  { row: 5, primary: "none", allowed: ["apply", "abort"], exit: fixed(2), nextAction: "apply",
    matches: (i) => holdMatches(i, ["maintenance-aborted"])
      && (i.manifest.kind === "absent"
        || (present(i)?.phase === "aborted" && present(i)?.pending === null)) },
  { row: 6, primary: "abort", allowed: ["resume"], exit: fixed(6),
    matches: (i) => holdMatches(i, ["maintenance-aborted"]) && present(i)?.pending === "abort" },
  { row: 7, primary: "none", allowed: [], exit: fixed(7),
    matches: (i) => holdMatches(i, ["maintenance-aborted"])
      && ["verify-dry-run", "copy-batch", "complete-copy", "verify-generation"].includes(present(i)?.pending ?? "") },
  { row: 8, primary: "abort", allowed: [], exit: fixed(2),
    matches: (i) => holdMatches(i, ["maintenance-aborted"])
      && present(i) !== null && present(i)!.pending === null && ABORTABLE_PHASES.includes(present(i)!.phase) },
  { row: 9, primary: "none", allowed: [], exit: fixed(5),
    matches: (i) => holdPhaseIn(i, ["maintenance-aborted"]) },
  { row: 10, primary: "none", allowed: ["activate", "rollback"], exit: fixed(2), nextAction: "report",
    matches: (i) => isOwnPublication(i) && i.journal.kind === "publication" && i.journal.phase === "completed"
      && present(i)?.phase === "active" && present(i)?.pending === null },
  { row: 11, primary: "activate", allowed: ["resume"],
    exit: (i) => present(i)?.pending !== null ? 6 : 2,
    matches: (i) => ((isOwnPublication(i) && (publicationInFlight(i) || (i.journal.kind === "publication" && i.journal.phase === "aborted")))
        || holdPhaseIn(i, ["selection-prepared", "selection-completed"])
        // Activation begun before any selection (S9 to S11): SQLite is still authoritative and the hold is maintenance-held.
        || (holdMatches(i, ["maintenance-held"]) && i.snapshot === "complete" && present(i) !== null
          && ((present(i)!.phase === "verified" && present(i)!.pending === "prepare-activation")
            || (present(i)!.phase === "activating" && (present(i)!.pending === null || present(i)!.pending === "publish-activation"))))
        // The publication drive is done but the manifest has not settled to active (S13b done, S16 not).
        || (isOwnPublication(i) && i.journal.kind === "publication" && i.journal.phase === "completed"
          && present(i)?.phase === "activating" && present(i)?.pending === "publish-activation"))
      && present(i) !== null
      && ((present(i)!.phase === "verified" && present(i)!.pending === null)
        || present(i)!.phase === "activating"
        || present(i)!.pending === "prepare-activation" || present(i)!.pending === "publish-activation") },
  { row: 12, primary: "rollback", allowed: ["resume"],
    exit: fixed(6),
    matches: (i) => present(i) !== null
      && (present(i)!.phase === "rolling-back"
        || present(i)!.pending === "prepare-rollback" || present(i)!.pending === "publish-rollback") },
  { row: 13, primary: "none", allowed: ["rollback"], exit: fixed(2), nextAction: "report",
    matches: (i) => present(i)?.phase === "rolled-back" && present(i)?.pending === null },
  { row: 14, primary: "apply", allowed: ["abort"], exit: fixed(2),
    matches: (i) => holdMatches(i, ["maintenance-entering"]) && i.manifest.kind === "absent"
      && (i.snapshot === "absent" || i.snapshot === "complete") },
  { row: 15, primary: "apply", allowed: ["abort"], exit: fixed(2),
    matches: (i) => holdMatches(i, ["maintenance-held"]) && i.manifest.kind === "absent" && i.snapshot === "absent" },
  { row: 16, primary: "apply", allowed: ["abort"], exit: fixed(2),
    matches: (i) => holdMatches(i, ["maintenance-held"]) && i.manifest.kind === "absent" && i.snapshot === "complete" },
  { row: 17, primary: "abort", allowed: [], exit: fixed(2),
    matches: (i) => holdMatches(i, ENTERING_OR_HELD) && BROKEN_SNAPSHOT.includes(i.snapshot)
      && (i.manifest.kind === "absent"
        || (present(i)?.pending === null && ABORTABLE_PHASES.includes(present(i)!.phase))) },
  { row: 18, primary: "none", allowed: [], exit: fixed(7),
    matches: (i) => holdMatches(i, ENTERING_OR_HELD) && BROKEN_SNAPSHOT.includes(i.snapshot)
      && present(i) !== null && present(i)!.pending !== null && present(i)!.pending !== "abort" },
  { row: 19, primary: "resume", allowed: ["abort"], exit: fixed(2),
    matches: (i) => holdMatches(i, ["maintenance-held"]) && i.snapshot === "complete"
      && present(i)?.phase === "planned" && present(i)?.pending === null },
  { row: 20, primary: "resume", allowed: [], exit: fixed(6),
    matches: (i) => holdMatches(i, ["maintenance-held"]) && i.snapshot === "complete"
      && present(i)?.pending === "verify-dry-run" },
  { row: 21, primary: "resume", allowed: (i) => present(i)!.pending === null ? ["abort"] : [],
    exit: (i) => isCopyEffect(present(i)!.pending) ? 6 : 2,
    matches: (i) => holdMatches(i, ["maintenance-held"]) && i.snapshot === "complete" && present(i) !== null
      && ((present(i)!.pending === null && (present(i)!.phase === "dry-run-verified" || present(i)!.phase === "copying"))
        || isCopyEffect(present(i)!.pending)) },
  { row: 22, primary: "verify", allowed: ["abort"], exit: fixed(2),
    matches: (i) => holdMatches(i, ["maintenance-held"]) && i.snapshot === "complete"
      && present(i)?.phase === "copied" && present(i)?.pending === null },
  { row: 23, primary: "verify", allowed: ["resume"], exit: fixed(6),
    matches: (i) => holdMatches(i, ["maintenance-held"]) && present(i)?.pending === "verify-generation" },
  { row: 24, primary: "activate", allowed: ["rollback", "abort", "verify"],
    exit: fixed(2),
    matches: (i) => holdMatches(i, ["maintenance-held"]) && present(i)?.phase === "verified"
      && present(i)?.pending === null && i.snapshot === "complete" },
  { row: 25, primary: "none", allowed: [], exit: fixed(5), matches: () => true },
];

/** Every row whose condition holds, in table order. `route` returns the first. Exported for the totality test. */
export function matchingMigrationRouteRows(input: MigrationRouteInput): readonly number[] {
  validate(input);
  return ROWS.filter((row) => row.matches(input)).map((row) => row.row);
}

export function routeMigrationGeneration(input: MigrationRouteInput): MigrationRoute {
  validate(input);
  const row = ROWS.find((candidate) => candidate.matches(input))!;
  return Object.freeze({
    primary: row.primary,
    allowed: Object.freeze([...(typeof row.allowed === "function" ? row.allowed(input) : row.allowed)]),
    exitIfRefused: row.exit(input),
    row: row.row,
    nextAction: row.nextAction ?? row.primary,
  });
}
