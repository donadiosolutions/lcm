import { MigrationManifestStore } from "./manifest-store.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, withMigrationBoundary } from "./boundary.js";
import {
  MigrationRollbackError,
  runMigrationRollbackFromHome,
  type MigrationRollbackErrorReason,
} from "./rollback-inputs.js";
import {
  admitExistingMigrationCommand,
  refuseUnlessBackendConfirmed,
  refuseUnlessConfirmed,
} from "./cli-existing.js";
import {
  manifestMovedSince,
  observeCutoverRestart,
  type MigrationCutoverCommandOutcome,
  type MigrationCutoverRestartOperations,
} from "./cli-cutover.js";
import type { MigrationEvidence } from "./envelope.js";
import type { ExistingGenerationInput } from "./existing-generation.js";

/**
 * The `rollback` command's CLI orchestration (plan-v5 Part B (4), plan-v6.1
 * B2 and A-P0-2, plan-v6.2). It owns router row 12 and is allowed at rows 10,
 * 13 and 24, and it adds no eligibility rule, mode or fence of its own: it
 * calls `runMigrationRollbackFromHome`, which re-enters every interrupted
 * state and decides eligibility, mode and the remote-binding refusal itself.
 *
 * **A14.** Rollback refuses while any other project is remotely bound,
 * because the backend selection is global. That refusal arrives as
 * `not-eligible` or `drift`; this command neither pre-checks nor softens it.
 *
 * **Fences.** `--confirm-generation` and `--confirm-backend`, which must
 * equal `manifest.source.backend` ("sqlite"). The manifest invariant makes
 * that the only legal literal, so the fence confirms intent and does not
 * detect a wrong direction.
 *
 * **Exit 0** only when the call returned, for the confirmed id, a manifest at
 * `rolled-back` with nothing pending, and that reads back from disk; and the
 * sqlite restart cell of plan-v4 section 7 is satisfied (a stale live daemon
 * is exit 8, an unresolvable verdict or a contradiction exit 5). The call has
 * no restart field and no status, so neither is assumed. A normal return at
 * any other phase is the abandoned `publish-rollback` (the manifest went
 * back to verified or active with an abandonment report): exit 2, no restart
 * check, run `rollback` again.
 *
 * **Thrown errors.** The seven `MigrationRollbackError` reasons are a closed
 * table (a record keyed by the exported list); any other error is the
 * boundary's `unexpected-failure` (exit 5).
 *
 * **--dry-run** is the read-only route and manifest read. #626 offers no
 * preview and this command must not call the entry point to discover a mode,
 * so it says what it did not evaluate and never exits 0.
 */

export type MigrationRollbackCommandOutcome = MigrationCutoverCommandOutcome;

export type MigrationRollbackCommandOperations = Readonly<{
  admit: typeof admitExistingMigrationCommand;
  run: typeof runMigrationRollbackFromHome;
  restart: Partial<MigrationCutoverRestartOperations>;
}>;

export type MigrationRollbackCommandInput = Readonly<{
  homeDir: string;
  generation?: string;
  confirmGenerationId?: string;
  confirmBackend?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  manifestStore?: MigrationManifestStore;
  /** @internal Test-only seam into the generation resolver. */
  _resolution?: Pick<ExistingGenerationInput, "_operationsForTesting"> | undefined;
  /** @internal Deterministic failure-injection seam for tests only. */
  _operationsForTesting?: Partial<MigrationRollbackCommandOperations>;
}>;

export function performMigrationRollbackCommand(input: MigrationRollbackCommandInput): Promise<MigrationRollbackCommandOutcome> {
  return withMigrationBoundary(
    () => runMigrationRollbackCommand(input),
    // An unclassified throw cannot rule out that rollback had begun an effect.
    (evidence) => ({ status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence, applied: true }),
  );
}

type ErrorClass = "precondition" | "contention" | "evidence";

/** Plan-v6.1 B2: every reason of `MIGRATION_ROLLBACK_ERROR_REASONS` has exactly one class. */
const ERROR_CLASSES = {
  "not-eligible": "precondition",
  unresolvable: "evidence",
  "lease-lost": "contention",
  "quiescence-unsatisfied": "precondition",
  drift: "evidence",
  "input-unresolvable": "evidence",
  "unexpected-state": "evidence",
} as const satisfies Record<MigrationRollbackErrorReason, ErrorClass>;

/** What the dry run reports it did not evaluate (plan-v5 Part B (4)). */
const ROLLBACK_NOT_EVALUATED = "eligibility,mode,quiescence,lease,drift,remote-binding,restart";

async function runMigrationRollbackCommand(input: MigrationRollbackCommandInput): Promise<MigrationRollbackCommandOutcome> {
  const ops = input._operationsForTesting;
  const manifestStore = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });

  const admission = await (ops?.admit ?? admitExistingMigrationCommand)({
    command: "rollback",
    homeDir: input.homeDir,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    resolution: { manifestStore, ...input._resolution },
  });
  if (admission.status === "refuse") return admission;
  const { context } = admission;
  const generationId = context.generationId;
  // Every cell rollback is admitted at (rows 10, 12, 13, 24) has a manifest.
  const manifest = context.manifest!;

  const unconfirmed = refuseUnlessConfirmed({ expectedGenerationId: generationId, confirmGenerationId: input.confirmGenerationId });
  if (unconfirmed !== null) return unconfirmed;
  const backendUnconfirmed = refuseUnlessBackendConfirmed({
    expectedBackend: manifest.source.backend, confirmBackend: input.confirmBackend, generationId,
  });
  if (backendUnconfirmed !== null) return backendUnconfirmed;

  if (input.dryRun === true) {
    // Route and manifest only. No eligibility, mode or quiescence is evaluated, so nothing is predicted.
    return {
      status: "refuse", reason: "rollback-dry-run-not-predictive", generationId, next: "rollback (drop --dry-run to run it)",
      sections: {
        cell: context.route.row, manifestPhase: manifest.phase, pendingEffect: manifest.pendingEffect?.kind ?? null,
        predictive: false, notEvaluated: ROLLBACK_NOT_EVALUATED,
      },
    };
  }

  let result;
  try {
    result = await (ops?.run ?? runMigrationRollbackFromHome)({
      homeDir: input.homeDir, generationId, ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (error instanceof MigrationRollbackError) {
      if (!Object.hasOwn(ERROR_CLASSES, error.reason)) throw error;
      const errorClass = ERROR_CLASSES[error.reason];
      return {
        status: "refuse",
        reason: errorClass === "contention" ? "rollback-contention" : `rollback-refused-${errorClass}`,
        generationId, sections: { cell: context.route.row, rollbackReason: error.reason },
        ...(manifestMovedSince(manifestStore, generationId, manifest.revision) ? { applied: true as const } : {}),
      };
    }
    throw error;
  }

  const returned = result.manifest;
  if (returned.generationId !== generationId) {
    return { status: "refuse", reason: "rollback-readback-mismatch", evidence: "generation-mismatch", generationId, applied: true };
  }
  const settled = returned.phase === "rolled-back" && returned.pendingEffect === null;
  if (!settled) {
    // The abandoned publish-rollback: the manifest went back to its return phase with an abandonment report.
    if (result.report?.kind === "abandonment") {
      return {
        status: "refuse", reason: "rollback-abandoned", generationId, applied: true, next: "rollback",
        sections: {
          cell: context.route.row, manifestPhase: returned.phase, abandonmentReportId: result.report.reportId,
          abandonmentReportSha256: result.report.checksumSha256,
        },
      };
    }
    return { status: "refuse", reason: "rollback-readback-mismatch", evidence: `manifest-${returned.phase}`, generationId, applied: true };
  }
  // The returned manifest is not enough: it must read back from disk.
  try {
    const head = manifestStore.read(generationId);
    if (head.phase !== "rolled-back" || head.pendingEffect !== null) {
      return { status: "refuse", reason: "rollback-readback-mismatch", evidence: `manifest-${head.phase}`, generationId, applied: true };
    }
  } catch {
    return { status: "refuse", reason: "rollback-readback-mismatch", evidence: "manifest-unreadable", generationId, applied: true };
  }

  const applied = !(manifest.phase === "rolled-back" && manifest.pendingEffect === null && returned.revision === manifest.revision);
  const restart = await observeCutoverRestart({
    homeDir: input.homeDir, selected: "sqlite", ...(ops?.restart === undefined ? {} : { operations: ops.restart }),
  });
  const evidence: MigrationEvidence = {
    cell: context.route.row,
    manifestRevision: returned.revision,
    rollbackMode: result.report?.mode ?? returned.rollbackLineage.mode,
    rollbackEligibility: result.report?.eligibility ?? null,
    ...(result.report === null ? {} : { reportId: result.report.reportId, reportSha256: result.report.checksumSha256 }),
    ...restart.evidence,
  };
  if (restart.reason !== undefined) {
    return {
      status: "refuse", reason: restart.reason, generationId, ...(applied ? { applied: true as const } : {}),
      sections: evidence, restart: restart.restart,
    };
  }
  return { status: "ok", generationId, manifestPhase: "rolled-back", applied, next: "report", evidence, restart: restart.restart };
}
