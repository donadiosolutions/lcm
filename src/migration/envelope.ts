import type { MigrationCommandName, MigrationExitCode, MigrationExitClassName } from "./exit-classes.js";
import { migrationExitClassForName } from "./exit-classes.js";

/**
 * Section 10's JSON contract: eleven fields, identical across commands,
 * frozen in name, type and presence for schemaVersion 1. An addition
 * requires a schemaVersion bump — this module resolves plan-v1's
 * contradiction ("additions allowed" vs "exact key set pinned") in favour
 * of the pin, per plan-v2's own decision, because a stable contract is the
 * point.
 *
 * `outcome` is exactly the section 5 exit-class name (never a separate,
 * looser vocabulary invented for the envelope) so "outcome and exitCode are
 * asserted to agree for every class" is checkable as a single equality:
 * `migrationExitClassForName(outcome).code === exitCode`.
 */

export type MigrationEnvelopeRefusal = Readonly<{
  /**
   * A closed vocabulary string, defined per command by that command's own
   * wiring — never a caught error's raw `message`, driver text or cause
   * (`bin/lcm.ts:4307-4308`'s rule).
   */
  reason: string;
  /** Static remedy text. Never interpolates the reason, a message, or any
   * other dynamic value — a remedy that carries a mutable message is
   * exactly the defect this field exists to prevent. */
  remedy: string;
}>;

/** Section 6's three-valued restart verifier answer, carried unmodified. */
export type MigrationEnvelopeRestart = Readonly<{
  answer: "satisfied" | "unsatisfied" | "unresolvable";
  presence: "running" | "absent" | "unresolvable";
}>;

/**
 * The closed, pinned, non-path, non-secret evidence shape (section 10):
 * ids, digests, phases, counts, timestamps and booleans only. Never a raw
 * path, URL or driver message — the migration authority carries absolute
 * `canonicalPath`, `projectDbPath` and aliases that must never reach this
 * object, including on an exit-0 (happy) path, which is exactly where an
 * unreviewed `...authority` spread would leak them.
 */
export type MigrationEvidenceValue = string | number | boolean | null;
export type MigrationEvidence = Readonly<Record<string, MigrationEvidenceValue>>;

export type MigrationEnvelope = Readonly<{
  schemaVersion: 1;
  command: MigrationCommandName;
  outcome: MigrationExitClassName;
  exitCode: MigrationExitCode;
  generation: string | null;
  manifestPhase: string | null;
  applied: boolean;
  next: string | null;
  evidence: MigrationEvidence;
  refusal: MigrationEnvelopeRefusal | null;
  restart: MigrationEnvelopeRestart | null;
}>;

export class MigrationEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationEnvelopeError";
  }
}

/**
 * An absolute POSIX or Windows path, or a URL carrying embedded
 * credentials. Matched conservatively (a few false positives — refusing a
 * legitimate value that merely starts with a slash — are the safe
 * direction; a false negative that lets a real path through is not).
 */
const ABSOLUTE_PATH_PATTERN = /^(\/[^\s]*|[A-Za-z]:\\[^\s]*|\\\\[^\s]+)$/u;
const CREDENTIALED_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*:[^/\s@]*@/iu;
/** A closed evidence value is short: ids, digests and phases are, by
 * construction, bounded (a sha256 hex digest is 64 characters; this bound
 * is deliberately generous above that so it never becomes the thing a
 * legitimate digest-based value trips over). */
const MAX_EVIDENCE_STRING_LENGTH = 256;

function assertSanitizedEvidenceValue(key: string, value: MigrationEvidenceValue): void {
  if (typeof value !== "string") return;
  if (ABSOLUTE_PATH_PATTERN.test(value)) {
    throw new MigrationEnvelopeError(`migration evidence field "${key}" looks like an absolute path and was refused rather than emitted`);
  }
  if (CREDENTIALED_URL_PATTERN.test(value)) {
    throw new MigrationEnvelopeError(`migration evidence field "${key}" looks like a credentialed URL and was refused rather than emitted`);
  }
  if (value.length > MAX_EVIDENCE_STRING_LENGTH) {
    throw new MigrationEnvelopeError(`migration evidence field "${key}" exceeds the closed-evidence length bound and was refused rather than emitted`);
  }
}

/**
 * Section 10: "Sanitization covers evidence, not only refusal." Every
 * value is checked, including on an exit-0 path — this function is called
 * unconditionally by `buildMigrationEnvelope`, not only when `refusal` is
 * present. Refuses (throws) rather than silently redacting, because a
 * silently redacted field is a value the operator believes exists and does
 * not — the same absence-shaped defect this whole item is built against.
 */
export function sanitizeMigrationEvidence(evidence: MigrationEvidence): MigrationEvidence {
  const keys = Object.keys(evidence).sort();
  const sanitized: Record<string, MigrationEvidenceValue> = {};
  for (const key of keys) {
    const value = evidence[key]!;
    assertSanitizedEvidenceValue(key, value);
    sanitized[key] = value;
  }
  return Object.freeze(sanitized);
}

export type BuildMigrationEnvelopeInput = Readonly<{
  command: MigrationCommandName;
  outcome: MigrationExitClassName;
  exitCode: MigrationExitCode;
  generation?: string | null;
  manifestPhase?: string | null;
  applied: boolean;
  next?: string | null;
  evidence?: MigrationEvidence;
  refusal?: MigrationEnvelopeRefusal | null;
  restart?: MigrationEnvelopeRestart | null;
}>;

/**
 * Builds one section 10 envelope. Asserts `outcome`/`exitCode` agreement
 * (a construction-time invariant, not something a consumer must re-check)
 * and runs `evidence` through sanitization unconditionally.
 */
export function buildMigrationEnvelope(input: BuildMigrationEnvelopeInput): MigrationEnvelope {
  const exitClass = migrationExitClassForName(input.outcome);
  if (exitClass.code !== input.exitCode) {
    throw new MigrationEnvelopeError(
      `migration envelope outcome "${input.outcome}" (code ${exitClass.code}) does not agree with exitCode ${input.exitCode}`,
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    command: input.command,
    outcome: input.outcome,
    exitCode: input.exitCode,
    generation: input.generation ?? null,
    manifestPhase: input.manifestPhase ?? null,
    applied: input.applied,
    next: input.next ?? null,
    evidence: sanitizeMigrationEvidence(input.evidence ?? {}),
    refusal: input.refusal ?? null,
    restart: input.restart ?? null,
  });
}

/**
 * The exact, frozen key order section 10 lists them in
 * (`{schemaVersion, command, outcome, exitCode, generation, manifestPhase,
 * applied, next, evidence, refusal, restart}`). Serialization always
 * rebuilds the object in this order rather than trusting property
 * insertion order on whatever object `buildMigrationEnvelope` produced, so
 * a caller cannot accidentally change stdout's byte layout by changing the
 * order fields were assigned upstream.
 */
const ENVELOPE_KEY_ORDER: readonly (keyof MigrationEnvelope)[] = [
  "schemaVersion", "command", "outcome", "exitCode", "generation",
  "manifestPhase", "applied", "next", "evidence", "refusal", "restart",
];

/**
 * Section 10: "stdout carries exactly one document, written once, at the
 * end." This function only ever serializes; it never writes to any stream
 * itself, so the single-write discipline lives entirely at the CLI call
 * site, where it is one call, not something this module could weaken by
 * being called twice.
 */
export function serializeMigrationEnvelope(envelope: MigrationEnvelope): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEY_ORDER) {
    ordered[key] = envelope[key];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
