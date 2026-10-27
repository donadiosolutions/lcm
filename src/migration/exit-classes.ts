/**
 * Section 5's closed, numbered exit-class vocabulary and section 5.1's
 * per-command postcondition/refusal mapping, as one exported constant each
 * so both `bin/lcm.ts` and the section 12 runbook conformance test consume
 * the exact same closed set. Neither table is duplicated in prose anywhere
 * else this item owns; a reader who wants the vocabulary reads this file.
 *
 * Codes are never reused for a different class (section 5). This module
 * defines the vocabulary and the per-command contract; it does not itself
 * classify any specific refusal reason string — that mapping lives at each
 * command's own CLI wiring, where the concrete reason strings a command's
 * underlying operation can actually produce are enumerable and testable
 * against real behaviour, not guessed at here in the abstract.
 */

export type MigrationExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type MigrationExitClassName =
  | "ok"
  | "usage"
  | "refused-precondition"
  | "refused-confirmation"
  | "refused-contention"
  | "refused-evidence"
  | "incomplete-recoverable"
  | "failed-operator-required"
  | "restart-required";

export type MigrationExitClass = Readonly<{
  code: MigrationExitCode;
  name: MigrationExitClassName;
  description: string;
}>;

/**
 * Section 5's table, verbatim. Order is the table's own order; `code` is
 * also each entry's index, asserted by this module's own tests rather than
 * assumed from array position.
 */
export const MIGRATION_EXIT_CLASSES: readonly MigrationExitClass[] = Object.freeze([
  Object.freeze({
    code: 0, name: "ok",
    description: "Completed and its named postcondition was positively read back.",
  }),
  Object.freeze({
    code: 1, name: "usage",
    description: "Malformed invocation. Never reaches a storage seam.",
  }),
  Object.freeze({
    code: 2, name: "refused-precondition",
    description: "State does not admit this operation. Remedy names the command that does.",
  }),
  Object.freeze({
    code: 3, name: "refused-confirmation",
    description: "A mutating boundary was not confirmed.",
  }),
  Object.freeze({
    code: 4, name: "refused-contention",
    description: "Another actor holds the lock, barrier or lease.",
  }),
  Object.freeze({
    code: 5, name: "refused-evidence",
    description: "Evidence is absent, unattributable, or failed its comparison.",
  }),
  Object.freeze({
    code: 6, name: "incomplete-recoverable",
    description: "Durably begun, not terminal, and resume can finish it.",
  }),
  Object.freeze({
    code: 7, name: "failed-operator-required",
    description: "No automatic path resolves this.",
  }),
  Object.freeze({
    code: 8, name: "restart-required",
    description: "Durable state correct; a live daemon holds a stale startup backend, so the cutover is not reportable as successful.",
  }),
] satisfies MigrationExitClass[]);

const CLASS_BY_CODE: ReadonlyMap<MigrationExitCode, MigrationExitClass> = new Map(
  MIGRATION_EXIT_CLASSES.map((entry) => [entry.code, entry]),
);
const CLASS_BY_NAME: ReadonlyMap<MigrationExitClassName, MigrationExitClass> = new Map(
  MIGRATION_EXIT_CLASSES.map((entry) => [entry.name, entry]),
);

export function migrationExitClassForCode(code: MigrationExitCode): MigrationExitClass {
  const found = CLASS_BY_CODE.get(code);
  if (found === undefined) throw new Error(`unknown migration exit code: ${code as number}`);
  return found;
}

export function migrationExitClassForName(name: MigrationExitClassName): MigrationExitClass {
  const found = CLASS_BY_NAME.get(name);
  if (found === undefined) throw new Error(`unknown migration exit class name: ${name}`);
  return found;
}

/**
 * All nine commands issue #627's contract names. `status: "implemented"`
 * means the command is registered in `bin/lcm.ts` and has its own tests
 * (the runbook conformance test checks the registration in both directions).
 * All nine are implemented: `plan`, `dry-run`, `apply`, `resume`, `verify`,
 * `report`, `abort`, `activate` and `rollback`. `outline` remains in the type
 * for a command that is named before it is registered; none is outline now.
 */
export type MigrationCommandName =
  | "plan" | "dry-run" | "apply" | "resume" | "verify"
  | "report" | "activate" | "rollback" | "abort";

export type MigrationCommandContract = Readonly<{
  command: MigrationCommandName;
  status: "implemented" | "outline";
  /** What exit 0 reads back and positively confirms; never "nothing threw". */
  exitZeroPostcondition: string;
  /** The closed set of exit classes this command can legitimately emit. */
  canEmit: readonly MigrationExitCode[];
}>;

/** Section 5.1's table, verbatim, for all nine named commands. */
export const MIGRATION_COMMAND_CONTRACTS: readonly MigrationCommandContract[] = Object.freeze([
  Object.freeze({
    command: "plan", status: "implemented",
    exitZeroPostcondition: "Every precondition read succeeded and the emitted evidence is complete, including a positively established daemon presence answer and a computed candidate id.",
    canEmit: [0, 1, 2, 4, 5] as const,
  }),
  Object.freeze({
    command: "dry-run", status: "implemented",
    exitZeroPostcondition: "The dry-run completed and its result was read back.",
    canEmit: [0, 1, 2, 4, 5] as const,
  }),
  Object.freeze({
    command: "apply", status: "implemented",
    exitZeroPostcondition: "Journal re-read at the expected phase and checksum; snapshot classifies complete; manifest head reads at the expected phase.",
    canEmit: [0, 1, 2, 3, 4, 5, 6, 7] as const,
  }),
  Object.freeze({
    command: "resume", status: "implemented",
    exitZeroPostcondition: "The router cell it executed reached its next durable checkpoint, and the manifest was read back at it. With --dry-run, the cell was named and nothing was run or predicted.",
    canEmit: [0, 1, 2, 3, 4, 5, 6, 7, 8] as const,
  }),
  Object.freeze({
    command: "verify", status: "implemented",
    exitZeroPostcondition: "The manifest reads verified with nothing pending and its verification report reference names a persisted, activation-eligible report. A verified generation is confirmed from that persisted evidence without writing. With --dry-run, the computation found an eligible report and persisted nothing.",
    canEmit: [0, 1, 2, 3, 4, 5, 7] as const,
  }),
  Object.freeze({
    command: "report", status: "implemented",
    exitZeroPostcondition: "Every reader was read without taking any lock, and no contradiction was found.",
    canEmit: [0, 1, 2, 4, 5, 8] as const,
  }),
  Object.freeze({
    command: "activate", status: "implemented",
    exitZeroPostcondition: "The call returned the confirmed generation's identity, the manifest reads active with nothing pending, and the restart matrix cell is satisfied (verdict satisfied, daemon absent or on the selected backend). --dry-run never exits 0.",
    canEmit: [0, 1, 2, 3, 4, 5, 6, 7, 8] as const,
  }),
  Object.freeze({
    command: "rollback", status: "implemented",
    exitZeroPostcondition: "The manifest reads rolled-back with nothing pending for the confirmed generation, read back from disk, and the sqlite restart matrix cell is satisfied. --dry-run never exits 0.",
    canEmit: [0, 1, 2, 3, 4, 5, 6, 7, 8] as const,
  }),
  Object.freeze({
    command: "abort", status: "implemented",
    exitZeroPostcondition: "Journal terminal and manifest settled, both read back. Repeating it against a settled pair writes nothing and reads the pair back again.",
    canEmit: [0, 1, 2, 3, 4, 5, 6, 7] as const,
  }),
] satisfies MigrationCommandContract[]);

const CONTRACT_BY_COMMAND: ReadonlyMap<MigrationCommandName, MigrationCommandContract> = new Map(
  MIGRATION_COMMAND_CONTRACTS.map((entry) => [entry.command, entry]),
);

export function migrationCommandContract(command: MigrationCommandName): MigrationCommandContract {
  const found = CONTRACT_BY_COMMAND.get(command);
  if (found === undefined) throw new Error(`unknown migration command: ${command}`);
  return found;
}

/**
 * Section 5: "Exit 6 requires that resume can actually finish; a held hold
 * with partial snapshots is immutable and unresumable, so it is exit 2 with
 * remedy abort, never exit 6." This is a standing constraint on every
 * command's own classification logic, not something this module can check
 * mechanically for an arbitrary refusal — it names the rule so a reviewer
 * (and the runbook) can hold implementers to it, and every implemented
 * command's own refusal mapping is required to justify any exit-6 use
 * against this sentence specifically.
 */
export const EXIT_SIX_REQUIRES_GENUINE_RESUMABILITY =
  "exit 6 is legal only when resume can genuinely finish the state; an immutable, unresumable state (e.g. a held hold with a partial or replaced snapshot) is exit 2 naming abort, never exit 6.";
