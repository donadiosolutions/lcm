import type { MigrationCommandName } from "./exit-classes.js";
import { migrationExitClassForName, migrationExitClassForCode } from "./exit-classes.js";
import { migrationRefusalMapping } from "./refusal-mapping.js";
import {
  buildMigrationEnvelope,
  type MigrationEnvelope,
  type MigrationEnvelopeRestart,
  type MigrationEvidence,
} from "./envelope.js";
import type { MigrationPlanOutcome } from "./cli-plan.js";
import type { MigrationApplyDaemonPresence } from "./cli-apply.js";
import type { MigrationDryRunOutcome } from "./cli-dry-run.js";
import { migrationDryRunEvidence } from "./cli-dry-run.js";
import type { MigrationApplyOutcome } from "./cli-apply.js";
import type { MigrationAbortCommandOutcome } from "./cli-abort.js";
import type { MigrationVerifyCommandOutcome } from "./cli-verify.js";
import type { MigrationResumeCommandOutcome } from "./cli-resume.js";
import type { MigrationReportOutcome } from "./cli-report.js";
import type { MigrationCutoverCommandOutcome } from "./cli-cutover.js";
import type { MigrationSetOutcome } from "./cli-cutover-set.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, unexpectedFailureEvidence } from "./boundary.js";

/**
 * The single place every migration command's own outcome type is turned
 * into section 10's envelope. Deliberately separate from `bin/lcm.ts`'s
 * Commander wiring so every branch here is unit-testable without
 * constructing a real CLI invocation -- the CLI action handlers become
 * thin glue: call the orchestration function, call the matching
 * `render*` function here, write the result, set `process.exitCode`.
 *
 * A refusal reason not present in `MIGRATION_REFUSAL_REASONS` throws
 * (via `migrationRefusalMapping`) rather than silently defaulting an exit
 * class -- an unclassified refusal reaching this layer is a defect in the
 * table, not something to paper over with a guessed code.
 */

/**
 * The known set of `apply`'s own refusal reasons that occur strictly
 * after a durable write in this invocation: the hold entry's own readback
 * (`hold-entry-readback-mismatch` follows a successful
 * `enterMaintenance`), every capture failure (`capture-*`, which run
 * only once the hold is taken), and every genesis/copy-stage failure
 * (`genesis-*`, `snapshot-unresolvable`, `capture-incomplete`,
 * `manifest-unresolvable`, `copy-failed`), which only run after capture.
 * Every other apply refusal reason (preflight, confirmation fence, journal
 * resolution, a failed hold entry) occurs before any durable mutation in
 * this invocation. `applied` in the envelope reports this distinction so
 * an operator reading a failed `apply` knows whether state moved.
 */
const APPLY_REASONS_WITH_DURABLE_MUTATION: ReadonlySet<string> = new Set([
  // An unclassified throw cannot rule out an earlier write in this invocation.
  "unexpected-failure",
  "hold-entry-readback-mismatch",
  "capture-failed",
  "capture-contention",
  "capture-unresolvable",
  "snapshot-unresolvable",
  "capture-incomplete",
  "manifest-unresolvable",
  "genesis-inspection-failed",
  "genesis-create-failed",
  "genesis-dry-run-begin-failed",
  "genesis-dry-run-complete-failed",
  "copy-failed",
]);

function refusalEnvelope(input: Readonly<{
  command: MigrationCommandName;
  reason: string;
  evidenceDetail?: string;
  applied: boolean;
  generation?: string | null;
  manifestPhase?: string | null;
  /** The command the router names as the way forward, when it names one. */
  next?: string | null;
  /** Everything a read-only command managed to read before it refused. */
  sections?: MigrationEvidence;
  restart?: MigrationEnvelopeRestart | null;
}>): MigrationEnvelope {
  const mapping = migrationRefusalMapping(input.reason);
  const evidence: MigrationEvidence = {
    ...input.sections,
    ...(input.evidenceDetail === undefined ? {} : { detail: input.evidenceDetail }),
  };
  return buildMigrationEnvelope({
    command: input.command,
    outcome: mapping.exitClass,
    exitCode: migrationExitClassForName(mapping.exitClass).code,
    generation: input.generation ?? null,
    manifestPhase: input.manifestPhase ?? null,
    applied: input.applied,
    next: input.next ?? null,
    evidence,
    refusal: { reason: input.reason, remedy: mapping.remedy },
    restart: input.restart ?? null,
  });
}

function okEnvelope(input: Readonly<{
  command: MigrationCommandName;
  applied: boolean;
  generation?: string | null;
  manifestPhase?: string | null;
  next?: string | null;
  evidence: MigrationEvidence;
  restart?: MigrationEnvelopeRestart | null;
}>): MigrationEnvelope {
  return buildMigrationEnvelope({
    command: input.command,
    outcome: "ok",
    exitCode: migrationExitClassForCode(0).code,
    generation: input.generation ?? null,
    manifestPhase: input.manifestPhase ?? null,
    applied: input.applied,
    next: input.next ?? null,
    evidence: input.evidence,
    refusal: null,
    restart: input.restart ?? null,
  });
}

/** Both plan and apply record the daemon-presence answer in their exit-0 evidence (plan section 7, round-1 A-8). */
function daemonPresenceEvidence(
  presence: MigrationApplyDaemonPresence,
): MigrationEvidence {
  return {
    daemonPresent: presence.status === "present",
    ...(presence.status === "present" ? { daemonStorageBackend: presence.storageBackend } : {}),
  };
}

export function renderMigrationPlanEnvelope(outcome: MigrationPlanOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command: "plan", reason: outcome.reason, evidenceDetail: outcome.evidence, applied: false,
    });
  }
  return okEnvelope({
    command: "plan",
    applied: false,
    generation: outcome.generationId,
    next: "apply",
    evidence: {
      disposition: outcome.disposition,
      ...daemonPresenceEvidence(outcome.daemonPresence),
      ...outcome.identityPreview,
    },
  });
}

export function renderMigrationDryRunEnvelope(outcome: MigrationDryRunOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command: "dry-run", reason: outcome.reason, evidenceDetail: outcome.evidence, applied: false,
    });
  }
  return okEnvelope({
    command: "dry-run",
    applied: false,
    evidence: migrationDryRunEvidence(outcome.dryRun),
  });
}

export function renderMigrationApplyEnvelope(outcome: MigrationApplyOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command: "apply",
      reason: outcome.reason,
      evidenceDetail: outcome.evidence,
      // A refusal after the identity step wrote says so itself; every other
      // apply refusal is classified by its reason.
      applied: outcome.applied ?? APPLY_REASONS_WITH_DURABLE_MUTATION.has(outcome.reason),
      sections: outcome.identity,
    });
  }
  return okEnvelope({
    command: "apply",
    applied: outcome.applied,
    generation: outcome.generationId,
    manifestPhase: outcome.phase ?? null,
    next: outcome.applied ? null : "apply (drop --dry-run to copy for real)",
    evidence: { ...daemonPresenceEvidence(outcome.daemonPresence), ...outcome.identityPreview },
  });
}

/**
 * The envelope for a failure that happened while rendering an outcome (an
 * unmapped reason, or evidence the sanitizer refused to emit). Rendering is
 * the one step the orchestration-level boundary cannot cover, and it must
 * still print exactly one document under `--json`. Only the error's name
 * reaches the evidence.
 */
const READ_ONLY_MIGRATION_COMMANDS: ReadonlySet<MigrationCommandName> = new Set<MigrationCommandName>(["plan", "dry-run", "report"]);

export function renderMigrationUnexpectedFailureEnvelope(command: MigrationCommandName, error: unknown): MigrationEnvelope {
  return refusalEnvelope({
    command,
    reason: MIGRATION_UNEXPECTED_FAILURE_REASON,
    evidenceDetail: unexpectedFailureEvidence(error),
    // The read-only commands cannot have written anything: plan, dry-run
    // and report. Every other command may have, and the failure cannot
    // rule it out.
    applied: !READ_ONLY_MIGRATION_COMMANDS.has(command),
  });
}

export function renderMigrationVerifyEnvelope(outcome: MigrationVerifyCommandOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command: "verify",
      reason: outcome.reason,
      evidenceDetail: outcome.evidence,
      applied: outcome.applied ?? false,
      generation: outcome.generationId,
      next: outcome.next,
    });
  }
  return okEnvelope({
    command: "verify",
    applied: outcome.applied,
    generation: outcome.generationId,
    manifestPhase: outcome.manifestPhase,
    next: outcome.next,
    evidence: outcome.evidence,
  });
}

export function renderMigrationResumeEnvelope(outcome: MigrationResumeCommandOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command: "resume",
      reason: outcome.reason,
      evidenceDetail: outcome.evidence,
      applied: outcome.applied ?? false,
      generation: outcome.generationId,
      next: outcome.next,
      sections: outcome.sections,
      restart: outcome.restart,
    });
  }
  return okEnvelope({
    command: "resume",
    applied: outcome.applied,
    generation: outcome.generationId,
    manifestPhase: outcome.manifestPhase,
    next: outcome.next,
    evidence: outcome.evidence,
    restart: outcome.restart,
  });
}

/** A report never writes, so `applied` is always false, and a non-zero exit still carries every section it read. */
export function renderMigrationReportEnvelope(outcome: MigrationReportOutcome): MigrationEnvelope {
  if (outcome.reason !== undefined) {
    return refusalEnvelope({
      command: "report",
      reason: outcome.reason,
      applied: false,
      generation: outcome.generationId,
      manifestPhase: outcome.manifestPhase,
      next: outcome.next,
      sections: outcome.evidence,
      restart: outcome.restart,
    });
  }
  return okEnvelope({
    command: "report",
    applied: false,
    generation: outcome.generationId,
    manifestPhase: outcome.manifestPhase,
    next: outcome.next,
    evidence: outcome.evidence,
    restart: outcome.restart,
  });
}

export function renderMigrationAbortEnvelope(outcome: MigrationAbortCommandOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command: "abort",
      reason: outcome.reason,
      evidenceDetail: outcome.evidence,
      applied: outcome.applied ?? false,
      generation: outcome.generationId,
      next: outcome.next,
    });
  }
  return okEnvelope({
    command: "abort",
    applied: outcome.applied,
    generation: outcome.generationId,
    manifestPhase: outcome.manifestPhase,
    evidence: { journalPhase: outcome.journalPhase },
  });
}


/** `activate` and `rollback` render identically: a refusal keeps every section the command read, and the restart observation. */
function renderCutoverEnvelope(command: "activate" | "rollback", outcome: MigrationCutoverCommandOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command,
      reason: outcome.reason,
      evidenceDetail: outcome.evidence,
      applied: outcome.applied ?? false,
      generation: outcome.generationId,
      next: outcome.next,
      sections: outcome.sections,
      restart: outcome.restart,
    });
  }
  return okEnvelope({
    command,
    applied: outcome.applied,
    generation: outcome.generationId,
    manifestPhase: outcome.manifestPhase,
    next: outcome.next,
    evidence: outcome.evidence,
    restart: outcome.restart,
  });
}

export function renderMigrationActivateEnvelope(outcome: MigrationCutoverCommandOutcome): MigrationEnvelope {
  return renderCutoverEnvelope("activate", outcome);
}

export function renderMigrationRollbackEnvelope(outcome: MigrationCutoverCommandOutcome): MigrationEnvelope {
  return renderCutoverEnvelope("rollback", outcome);
}

/**
 * Every `--set` command renders through the one envelope: the aggregate set
 * id is `generation`, the member rows are flat `member.<n>.*` evidence, and a
 * refusal keeps every section the command read.
 */
export function renderMigrationSetEnvelope(command: MigrationCommandName, outcome: MigrationSetOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command,
      reason: outcome.reason,
      evidenceDetail: outcome.evidence,
      applied: outcome.applied ?? false,
      generation: outcome.generationId ?? null,
      manifestPhase: outcome.manifestPhase ?? null,
      next: outcome.next ?? null,
      sections: outcome.sections,
      restart: outcome.restart,
    });
  }
  return okEnvelope({
    command,
    applied: outcome.applied,
    generation: outcome.generationId,
    manifestPhase: outcome.manifestPhase,
    next: outcome.next,
    evidence: outcome.evidence,
    restart: outcome.restart,
  });
}
