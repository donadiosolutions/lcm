import { MigrationManifestStore } from "./manifest-store.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, withMigrationBoundary } from "./boundary.js";
import {
  MigrationActivationError,
  previewMigrationActivation,
  runMigrationActivation,
  type MigrationActivationInterruptionCause,
  type MigrationActivationInterruptionStep,
  type MigrationActivationOutcome,
  type MigrationActivationRefusalReason,
  type MigrationActivationRefusalStep,
  type MigrationActivationTriState,
} from "./activate-generation.js";
import type { ActivationPublicationStatus } from "./activation-publication.js";
import {
  ConfigValidationError,
  resolvePostgreSqlStorageSettings,
} from "../daemon/config.js";
import { connectionSettings } from "../storage/postgresql/factory.js";
import type { PostgreSqlConnectionSettings } from "../storage/postgresql/contracts.js";
import { resolveMigrationDestination } from "./cli-destination.js";
import {
  admitExistingMigrationCommand,
  refuseUnlessBackendConfirmed,
  refuseUnlessConfirmed,
} from "./cli-existing.js";
import {
  combineCutoverRestart,
  CUTOVER_RESTART_REASONS,
  manifestMovedSince,
  type MigrationCutoverCommandOutcome,
} from "./cli-cutover.js";
import { classifyMigrationDaemonPresence } from "./daemon-presence.js";
import type { MigrationEvidence } from "./envelope.js";
import type { ExistingGenerationInput } from "./existing-generation.js";

/**
 * The `activate` command's CLI orchestration (plan-v5 Part B, plan-v6.1 B1
 * and plan-v6.2). It owns router rows 11 and 24 and the settled re-entry at
 * row 10, and it adds no migration algorithm: it supplies the inputs
 * `runMigrationActivation` asks for and maps the closed outcome it returns.
 *
 * **Inputs, none invented.** Verify's destination resolution supplies the
 * transfer role. Activate additionally resolves `LCM_POSTGRES_RUNTIME_URL`
 * through the same strict PostgreSQL validator, while reusing the resolved
 * CA and tuning settings, for the ordinary daemon-runtime connection. The
 * secret is never an argument, output field, or config.json value.
 *
 * **Fences.** `--confirm-generation` (the resolved id) and
 * `--confirm-backend`, which must equal `manifest.destination.backend`
 * ("postgresql"); the manifest invariant makes that the only legal literal,
 * so the fence confirms intent and does not detect a wrong direction.
 *
 * **Outcome mapping** is a closed table. Each vocabulary is a record keyed by
 * the exported union, so an addition upstream fails the type check; at run
 * time an unknown status, reason, step or cause throws, which the boundary
 * reports as the closed `unexpected-failure` (exit 5). Nothing a throw
 * produces is ever success or exit 6.
 *
 * **Exit 0** requires the identity the call returned to equal the confirmed
 * id, the manifest to read back `active` with nothing pending, and the
 * plan-v4 section 7 restart cell (verdict satisfied, daemon absent or on the
 * selected backend). A stale live daemon is exit 8; an unresolvable verdict
 * or a contradiction is exit 5.
 *
 * **Grants.** The runtime grants exist before activation. After success, the
 * operator's one remaining privilege step is revoking the transfer grants
 * (or dropping that role), then handing `LCM_POSTGRES_URL` to the proven
 * runtime role before starting the daemon.
 */

export type MigrationActivateCommandOutcome = MigrationCutoverCommandOutcome;

export type MigrationActivateCommandOperations = Readonly<{
  admit: typeof admitExistingMigrationCommand;
  resolveDestination: typeof resolveMigrationDestination;
  resolveRuntimeSettings: typeof resolveMigrationActivationRuntimeSettings;
  run: typeof runMigrationActivation;
  preview: typeof previewMigrationActivation;
  classifyPresence: typeof classifyMigrationDaemonPresence;
}>;

export type MigrationActivationRuntimeSettingsResolution =
  | Readonly<{ status: "resolved"; settings: PostgreSqlConnectionSettings }>
  | Readonly<{ status: "refuse"; reason: "activation-runtime-target-missing" }>;

export function resolveMigrationActivationRuntimeSettings(input: Readonly<{
  transferSettings: PostgreSqlConnectionSettings;
  expectedOwner: string;
  env?: Record<string, string | undefined>;
}>): MigrationActivationRuntimeSettingsResolution {
  const env = input.env ?? process.env;
  try {
    const postgresql = resolvePostgreSqlStorageSettings({
      postgresql: {
        caFile: input.transferSettings.caFile,
        migrationRole: input.expectedOwner,
        poolMax: input.transferSettings.poolMax,
        connectionTimeoutMs: input.transferSettings.connectionTimeoutMs,
        idleTimeoutMs: input.transferSettings.idleTimeoutMs,
        statementTimeoutMs: input.transferSettings.statementTimeoutMs,
        ...(input.transferSettings.snapshotIdleTimeoutMs === undefined
          ? {}
          : { snapshotIdleTimeoutMs: input.transferSettings.snapshotIdleTimeoutMs }),
      },
    }, {
      LCM_POSTGRES_URL: env.LCM_POSTGRES_RUNTIME_URL,
    });
    return {
      status: "resolved",
      settings: connectionSettings({ backend: "postgresql", postgresql }),
    };
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return { status: "refuse", reason: "activation-runtime-target-missing" };
    }
    throw error;
  }
}

export type MigrationActivateCommandInput = Readonly<{
  cwd: string;
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
  _operationsForTesting?: Partial<MigrationActivateCommandOperations>;
}>;

export function performMigrationActivateCommand(input: MigrationActivateCommandInput): Promise<MigrationActivateCommandOutcome> {
  return withMigrationBoundary(
    () => runMigrationActivateCommand(input),
    // An unclassified throw cannot rule out that activation had begun an effect.
    (evidence) => ({ status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence, applied: true }),
  );
}

// ---------------------------------------------------------------------------
// The closed vocabularies, keyed by #625's exported unions.
// ---------------------------------------------------------------------------

type RefusalClass = "precondition" | "contention" | "evidence" | "resume-if-owned";

/**
 * Plan-v6.1 B1 and plan-v6.2 B-P2-1. Every reason has exactly one class. The
 * nine `*-unresolvable` reasons are evidence (exit 5); a refusal is never
 * exit 0. `pending-effect-foreign` is exit 6 only when the router says
 * `resume` owns the pending effect, and exit 2 otherwise.
 */
const REFUSAL_CLASSES = {
  "manifest-absent": "precondition",
  "manifest-not-eligible": "precondition",
  "manifest-unresolvable": "evidence",
  "pending-effect-foreign": "resume-if-owned",
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
} as const satisfies Record<MigrationActivationRefusalReason, RefusalClass>;

const REFUSAL_STEPS = {
  S0: true, S1: true, S2: true, S3: true, S4: true, S5: true, S6: true, S7: true, S8: true,
} as const satisfies Record<MigrationActivationRefusalStep, true>;

/** The closed set; there is no S14. */
const INTERRUPTION_STEPS = {
  S9: true, S10: true, S11: true, S12: true, S13a: true, S13b: true, S15: true, S16: true,
} as const satisfies Record<MigrationActivationInterruptionStep, true>;

const INTERRUPTION_CAUSES = {
  "lease-lost": true,
  "lease-unresolvable": true,
  "evidence-conflict": true,
  "evidence-unresolvable": true,
  "binding-conflict": true,
  "binding-unresolvable": true,
  "link-conflict": true,
  "artifact-identity-mismatch": true,
  "artifact-unresolvable": true,
  "journal-unexpected": true,
  "readback-mismatch": true,
  "project-map-drift": true,
  "report-conflict": true,
  "report-unresolvable": true,
  "state-unresolvable": true,
} as const satisfies Record<MigrationActivationInterruptionCause, true>;

const TRI_STATES = { no: true, yes: true, unknown: true } as const satisfies Record<MigrationActivationTriState, true>;

const PUBLICATION_STATUSES = {
  completed: true,
  aborted: true,
  "publication-collision": true,
  "fence-unsatisfied": true,
  "fence-unresolvable": true,
  "artifact-missing": true,
  "artifact-unresolvable": true,
  "artifact-identity-mismatch": true,
  "duplicate-publication-input": true,
  "publication-unresolvable": true,
  "maintenance-in-flight": true,
} as const satisfies Record<ActivationPublicationStatus, true>;

function closed<T extends string>(kind: string, table: Readonly<Record<T, unknown>>, value: unknown): T {
  if (typeof value !== "string" || !Object.hasOwn(table, value)) {
    throw new Error(`migration activation returned an unknown ${kind}`);
  }
  return value as T;
}

/**
 * The best-effort pre-effect lease cleanup appends this marker to a
 * refusal's or an interruption's detail when the release failed. Only the
 * fact that it appears is rendered, never the failure text, and a release is
 * never claimed otherwise: it is best effort.
 */
const LEASE_RELEASE_FAILURE_MARKER = "; the activation lease was not released: ";

function leaseEvidence(detail: string): MigrationEvidence {
  return detail.includes(LEASE_RELEASE_FAILURE_MARKER) ? { leaseReleaseFailed: true } : {};
}

// ---------------------------------------------------------------------------

/** The next command after `activate` succeeds, and the operator step it must not skip. */
export const ACTIVATE_NEXT_AFTER_SUCCESS = "revoke-transfer-grants-then-start-daemon";

async function runMigrationActivateCommand(input: MigrationActivateCommandInput): Promise<MigrationActivateCommandOutcome> {
  const ops = input._operationsForTesting;
  const manifestStore = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });

  const admission = await (ops?.admit ?? admitExistingMigrationCommand)({
    command: "activate",
    homeDir: input.homeDir,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    resolution: { manifestStore, ...input._resolution },
  });
  if (admission.status === "refuse") return admission;
  const { context } = admission;
  const generationId = context.generationId;
  // Every cell activate is admitted at (rows 10, 11, 24) has a manifest.
  const manifest = context.manifest!;

  const unconfirmed = refuseUnlessConfirmed({ expectedGenerationId: generationId, confirmGenerationId: input.confirmGenerationId });
  if (unconfirmed !== null) return unconfirmed;
  const backendUnconfirmed = refuseUnlessBackendConfirmed({
    expectedBackend: manifest.destination.backend, confirmBackend: input.confirmBackend, generationId,
  });
  if (backendUnconfirmed !== null) return backendUnconfirmed;

  if (input.dryRun === true) return previewOutcome(input, ops, generationId, context.route.row);

  const destination = await (ops?.resolveDestination ?? resolveMigrationDestination)({ cwd: input.cwd, homeDir: input.homeDir });
  if (destination.status === "refuse") {
    return {
      status: "refuse", reason: destination.reason, generationId,
      ...(destination.evidence === undefined ? {} : { evidence: destination.evidence }),
    };
  }
  const runtime = (ops?.resolveRuntimeSettings ?? resolveMigrationActivationRuntimeSettings)({
    transferSettings: destination.settings,
    expectedOwner: destination.expectedOwner,
  });
  if (runtime.status === "refuse") {
    return { status: "refuse", reason: runtime.reason, generationId };
  }

  let outcome: MigrationActivationOutcome;
  try {
    outcome = await (ops?.run ?? runMigrationActivation)({
      homeDir: input.homeDir,
      generationId,
      transferSettings: destination.settings,
      ordinarySettings: runtime.settings,
      expectedIdentity: destination.expectedIdentity,
      expectedOwner: destination.expectedOwner,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (error instanceof MigrationActivationError) {
      return {
        status: "refuse",
        reason: error.reason === "invalid-input" ? "activation-invalid-input" : "activation-unexpected-state",
        generationId,
        ...(manifestMovedSince(manifestStore, generationId, manifest.revision) ? { applied: true as const } : {}),
      };
    }
    // Anything else is unclassified: the boundary reports it as unexpected-failure (exit 5).
    throw error;
  }
  return mapActivationOutcome({ input, ops, generationId, outcome, manifestStore, row: context.route.row });
}

async function previewOutcome(
  input: MigrationActivateCommandInput,
  ops: Partial<MigrationActivateCommandOperations> | undefined,
  generationId: string,
  row: number,
): Promise<MigrationActivateCommandOutcome> {
  const preview = await (ops?.preview ?? previewMigrationActivation)({ homeDir: input.homeDir, generationId });
  // The preview never evaluates the checks that decide an activation (plan-v7 A11),
  // so it can never answer yes: it lists what it read and what it did not.
  const sections: Record<string, string | number | boolean | null> = {
    cell: row, predictive: preview.predictive, notEvaluated: preview.notEvaluated.join(","),
  };
  for (const check of preview.checks) sections[`check.${check.name}`] = check.status;
  return {
    status: "refuse", reason: "activation-dry-run-not-predictive", generationId, next: "activate (drop --dry-run to run it)", sections,
  };
}

async function mapActivationOutcome(args: Readonly<{
  input: MigrationActivateCommandInput;
  ops: Partial<MigrationActivateCommandOperations> | undefined;
  generationId: string;
  outcome: MigrationActivationOutcome;
  manifestStore: MigrationManifestStore;
  row: number;
}>): Promise<MigrationActivateCommandOutcome> {
  const { input, ops, generationId, outcome, manifestStore, row } = args;
  const status: string = outcome.status;

  if (outcome.status === "refused") {
    const step = closed("refusal step", REFUSAL_STEPS, outcome.step);
    const reason = closed("refusal reason", REFUSAL_CLASSES, outcome.reason);
    if ((outcome.effectBegun as boolean) !== false) throw new Error("migration activation refused after beginning an effect");
    const sections: MigrationEvidence = {
      cell: row, activationStep: step, activationReason: reason, effectBegun: false, ...leaseEvidence(outcome.detail),
    };
    const refusalClass = REFUSAL_CLASSES[reason];
    let cliReason: string;
    if (refusalClass === "resume-if-owned") {
      // Resume owns a foreign pending effect only if the router, asked again, says so.
      const again = await (ops?.admit ?? admitExistingMigrationCommand)({
        command: "activate", homeDir: input.homeDir, generation: generationId,
        resolution: { manifestStore, ...input._resolution },
      });
      cliReason = again.status === "refuse" && again.reason === "route-resume-required"
        ? "activation-refused-resume" : "activation-refused-precondition";
    } else {
      cliReason = `activation-refused-${refusalClass}`;
    }
    return { status: "refuse", reason: cliReason, generationId, sections };
  }

  if (status !== "activated" && status !== "interrupted" && status !== "publication-failed" && status !== "post-publication-unhealthy") {
    throw new Error("migration activation returned an unknown status");
  }
  // Every non-refused outcome carries the identity it evidenced; it must be this generation's.
  const identity = (outcome as Exclude<MigrationActivationOutcome, { status: "refused" }>).identity;
  if (identity.generationId !== generationId) {
    return { status: "refuse", reason: "activation-identity-mismatch", generationId, applied: true, sections: { cell: row, outcome: status } };
  }
  const identitySections: MigrationEvidence = {
    ...(identity.publicationId === undefined ? {} : { publicationId: identity.publicationId }),
    ...(identity.manifestRevision === undefined ? {} : { manifestRevision: identity.manifestRevision }),
  };

  if (outcome.status === "interrupted") {
    const step = closed("interruption step", INTERRUPTION_STEPS, outcome.step);
    const cause = closed("interruption cause", INTERRUPTION_CAUSES, outcome.cause);
    const applied = closed("applied state", TRI_STATES, outcome.applied);
    const reportStored = closed("report-stored state", TRI_STATES, outcome.reportStored);
    const sections: MigrationEvidence = {
      cell: row, activationStep: step, activationCause: cause, effectBegun: outcome.effectBegun,
      activationApplied: applied, activationReportStored: reportStored, ...identitySections, ...leaseEvidence(outcome.detail),
    };
    // The flag is the evidence; the step label is never inferred from (plan-v6.1 A-P0-1).
    return outcome.effectBegun
      ? { status: "refuse", reason: "activation-interrupted", generationId, applied: true, next: "activate", sections }
      : { status: "refuse", reason: "activation-not-begun", generationId, next: "activate", sections };
  }

  if (outcome.status === "publication-failed") {
    const publication = closed("publication status", PUBLICATION_STATUSES, outcome.publication.status);
    return {
      status: "refuse", reason: "activation-publication-failed", generationId, applied: true,
      sections: { cell: row, publicationStatus: publication, ...identitySections },
    };
  }

  if (outcome.status === "post-publication-unhealthy") {
    const combined = await combineCutoverRestart({
      homeDir: input.homeDir, verdict: outcome.restart, selected: "postgresql",
      classifyPresence: ops?.classifyPresence,
    });
    return {
      status: "refuse", reason: "activation-post-publication-unhealthy", generationId, applied: true,
      next: "activate", restart: combined.restart,
      sections: {
        cell: row, healthStatus: outcome.health.status,
        ...(outcome.health.status === "healthy" ? {} : { healthReason: outcome.health.reason }),
        ...combined.evidence, ...identitySections,
      },
    };
  }

  // activated: the manifest must read back active, then the restart cell must be satisfied.
  const applied = outcome.resumedFrom !== "settled-active";
  try {
    const head = manifestStore.read(generationId);
    if (head.phase !== "active" || head.pendingEffect !== null) {
      return {
        status: "refuse", reason: "activation-readback-mismatch", evidence: `manifest-${head.phase}`,
        generationId, applied: true,
      };
    }
  } catch {
    return { status: "refuse", reason: "activation-readback-mismatch", evidence: "manifest-unreadable", generationId, applied: true };
  }
  const restart = await combineCutoverRestart({
    homeDir: input.homeDir, verdict: outcome.restart, selected: "postgresql", classifyPresence: ops?.classifyPresence,
  });
  const evidence: MigrationEvidence = {
    cell: row,
    ...identitySections,
    reportId: outcome.report.reportId,
    reportSha256: outcome.report.reportSha256,
    resumedFrom: outcome.resumedFrom,
    successorFencingTokenAdvanced: outcome.successorFencingToken !== null,
    transferGrantRevocation: "required-before-daemon-start",
    ...restart.evidence,
  };
  if (restart.reason !== undefined) {
    return {
      status: "refuse", reason: restart.reason, generationId, ...(applied ? { applied: true as const } : {}),
      // Transfer-grant revocation and daemon start fix only a positively observed stale daemon.
      next: restart.reason === CUTOVER_RESTART_REASONS.required ? ACTIVATE_NEXT_AFTER_SUCCESS : "report",
      sections: evidence, restart: restart.restart,
    };
  }
  return {
    status: "ok", generationId, manifestPhase: "active", applied, next: ACTIVATE_NEXT_AFTER_SUCCESS, evidence, restart: restart.restart,
  };
}
