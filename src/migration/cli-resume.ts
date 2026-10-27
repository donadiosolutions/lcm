import { randomUUID } from "node:crypto";
import { configPath } from "../runtime-paths.js";
import { MachineIdentityFileError, requireMachineIdentity } from "../machine-identity.js";
import { resolveMigrationExpectedIdentity } from "./cli-preflight.js";
import { admitExistingMigrationCommand, refuseUnlessConfirmed } from "./cli-existing.js";
import { performMigrationAbortCommand } from "./cli-abort.js";
import { completePendingVerificationCell } from "./cli-verify.js";
import { DEFAULT_MIGRATION_APPLY_MAX_BYTES, DEFAULT_MIGRATION_APPLY_MAX_RECORDS } from "./cli-apply.js";
import { performMigrationGenesisDryRun } from "./apply-genesis-copy.js";
import { runSqliteMigrationCopy } from "./batch-copy.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { performMigrationActivateCommand } from "./cli-activate.js";
import { performMigrationRollbackCommand } from "./cli-rollback.js";
import type { MigrationCutoverCommandOutcome } from "./cli-cutover.js";
import { MigrationProtocolError } from "./protocol.js";
import { completePendingMigrationVerification } from "./verify-generation.js";
import { MigrationVerificationReportStore } from "./verification-store.js";
import { resolveMigrationTargetConfig } from "./target-config.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, unexpectedFailureEvidence, withMigrationBoundary } from "./boundary.js";
import type { MigrationEnvelopeRestart, MigrationEvidence } from "./envelope.js";
import type { ExistingGenerationInput } from "./existing-generation.js";

/**
 * The `resume` command's CLI orchestration (plan-v5 Part B (1), `resume` and
 * its `--dry-run`). It executes only the cells the router gives it, and each
 * through the callee the router names; it never chains from one cell into the
 * next, so a resumed generation stops at the next durable checkpoint:
 *
 * - **Row 19** (held, `planned`, nothing pending) and **row 20** (pending
 *   `verify-dry-run`): `performMigrationGenesisDryRun`, which contacts the
 *   destination and returns before the copy. Row 20 completes the carried
 *   effect id only; a different id writes nothing.
 * - **Row 21** (`dry-run-verified` or `copying`, or a pending copy effect):
 *   `runSqliteMigrationCopy` only, stopping at `copied`.
 * - **Row 23** (pending `verify-generation`): the persisted-report completion
 *   `verify` also uses; no destination is contacted.
 * - **Row 6** (journal aborted, pending `abort`): the abort command's carried
 *   effect completion; the journal is not aborted again.
 * - **Rows 11 and 12** (activation and rollback re-entry) call the same
 *   callees as `activate` and `rollback`: this command's
 *   `--confirm-generation` is the fence, and the backend literal is taken
 *   from the manifest (the re-entry of a begun cutover needs no second
 *   confirmation of a direction the manifest already fixes). Their outcomes,
 *   including the restart observation and the grant-swap instruction, come
 *   back unchanged.
 *
 * `--dry-run` is route-only: it names the cell and does not call genesis,
 * copy, verify, activate, rollback or abort. It claims no would-be migration
 * result (`predictive: false`), takes no lease or barrier, and writes nothing.
 *
 * The destination identity is the held one (plan-v5 Part B (3)): the persisted
 * local identity and a SELECT of the destination project. Resume never mints.
 */

export type MigrationResumeCommandOutcome =
  | Readonly<{
    status: "ok";
    generationId: string;
    manifestPhase: string | null;
    applied: boolean;
    next: string | null;
    evidence: MigrationEvidence;
    restart?: MigrationEnvelopeRestart | null;
  }>
  | Readonly<{
    status: "refuse";
    reason: string;
    evidence?: string;
    generationId?: string;
    next?: string | null;
    /** True only when a durable write preceded this refusal. */
    applied?: true;
    /** Everything a cutover callee read or was told before it refused. */
    sections?: MigrationEvidence;
    restart?: MigrationEnvelopeRestart | null;
  }>;

export type MigrationResumeCommandOperations = Readonly<{
  admit: typeof admitExistingMigrationCommand;
  resolveTargetConfig: typeof resolveMigrationTargetConfig;
  requireMachine: typeof requireMachineIdentity;
  resolveIdentity: typeof resolveMigrationExpectedIdentity;
  genesisDryRun: typeof performMigrationGenesisDryRun;
  copy: typeof runSqliteMigrationCopy;
  completePendingVerification: typeof completePendingMigrationVerification;
  abort: typeof performMigrationAbortCommand;
  activate: typeof performMigrationActivateCommand;
  rollback: typeof performMigrationRollbackCommand;
  mintOwnerProcessId: () => string;
}>;

export type MigrationResumeCommandInput = Readonly<{
  cwd: string;
  homeDir: string;
  generation?: string;
  confirmGenerationId?: string;
  dryRun?: boolean;
  maxRecords?: number;
  maxBytes?: number;
  now?: Date;
  manifestStore?: MigrationManifestStore;
  /** @internal Test-only seam into the generation resolver. */
  _resolution?: Pick<ExistingGenerationInput, "_operationsForTesting">;
  /** @internal Deterministic failure-injection seam for tests only. */
  _operationsForTesting?: Partial<MigrationResumeCommandOperations>;
}>;

export function performMigrationResumeCommand(input: MigrationResumeCommandInput): Promise<MigrationResumeCommandOutcome> {
  return withMigrationBoundary(
    () => runMigrationResumeCommand(input),
    // An unclassified throw cannot rule out that a checkpoint had been written.
    (evidence) => ({ status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence, applied: true }),
  );
}

async function runMigrationResumeCommand(input: MigrationResumeCommandInput): Promise<MigrationResumeCommandOutcome> {
  const ops = input._operationsForTesting;
  const admit = ops?.admit ?? admitExistingMigrationCommand;
  const manifestStore = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const reportStore = new MigrationVerificationReportStore({ homeDir: input.homeDir });

  const admission = await admit({
    command: "resume",
    homeDir: input.homeDir,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    resolution: { manifestStore, ...input._resolution },
  });
  if (admission.status === "refuse") return admission;
  const { context } = admission;
  const generationId = context.generationId;
  const row = context.route.row;

  const unconfirmed = refuseUnlessConfirmed({ expectedGenerationId: generationId, confirmGenerationId: input.confirmGenerationId });
  if (unconfirmed !== null) return unconfirmed;

  if (input.dryRun === true) {
    return {
      status: "ok", generationId, manifestPhase: context.manifest!.phase, applied: false,
      next: "resume (drop --dry-run to run this cell)",
      evidence: { cell: row, primary: context.route.primary, predictive: false, coordinationEffects: "none" },
    };
  }

  if (row === 11 || row === 12) {
    const cutover: MigrationCutoverCommandOutcome = row === 11
      ? await (ops?.activate ?? performMigrationActivateCommand)({
        cwd: input.cwd, homeDir: input.homeDir, generation: generationId, confirmGenerationId: generationId,
        confirmBackend: context.manifest!.destination.backend, manifestStore, _resolution: input._resolution,
      })
      : await (ops?.rollback ?? performMigrationRollbackCommand)({
        homeDir: input.homeDir, generation: generationId, confirmGenerationId: generationId,
        confirmBackend: context.manifest!.source.backend, manifestStore, _resolution: input._resolution,
      });
    return cutover;
  }

  if (row === 23) {
    return completePendingVerificationCell({
      homeDir: input.homeDir, generationId, manifestStore, reportStore,
      completePending: ops?.completePendingVerification ?? completePendingMigrationVerification,
    });
  }

  if (row === 6) {
    const abort = await (ops?.abort ?? performMigrationAbortCommand)({
      homeDir: input.homeDir, generation: generationId, confirmGenerationId: generationId, manifestStore,
      ...(input._resolution === undefined ? {} : { _resolution: input._resolution }),
    });
    if (abort.status === "refuse") return abort;
    return {
      status: "ok", generationId: abort.generationId, manifestPhase: abort.manifestPhase, applied: abort.applied,
      next: "apply", evidence: { cell: 6, journalPhase: abort.journalPhase },
    };
  }

  // Rows 19, 20 and 21 reach the destination.
  return runDestinationCell({ input, ops, context, manifestStore });
}

async function runDestinationCell(args: Readonly<{
  input: MigrationResumeCommandInput;
  ops: Partial<MigrationResumeCommandOperations> | undefined;
  context: Extract<Awaited<ReturnType<typeof admitExistingMigrationCommand>>, { status: "admitted" }>["context"];
  manifestStore: MigrationManifestStore;
}>): Promise<MigrationResumeCommandOutcome> {
  const { input, ops, context, manifestStore } = args;
  const generationId = context.generationId;
  const row = context.route.row;
  const resolveTargetConfig = ops?.resolveTargetConfig ?? resolveMigrationTargetConfig;
  const requireMachine = ops?.requireMachine ?? requireMachineIdentity;
  const resolveIdentity = ops?.resolveIdentity ?? resolveMigrationExpectedIdentity;

  const target = resolveTargetConfig(configPath(input.homeDir));
  if (target.status === "refuse") {
    return { status: "refuse", reason: target.reason, evidence: target.evidence, generationId };
  }
  let machineId: string;
  try {
    machineId = requireMachine(input.homeDir).machineId;
  } catch (error) {
    if (error instanceof MachineIdentityFileError) {
      return { status: "refuse", reason: "machine-identity-unregistered", generationId };
    }
    throw error;
  }
  // The route admitted a held, matching journal at these rows, so the journal
  // observation is a hold and its checksum is the maintenance evidence. Any
  // other observation here is a defect in the router, never a state to guess.
  if (context.journal.kind !== "hold") throw new Error("resume was admitted at a destination cell without a hold");
  const journal = context.journal.journal;

  const identity = await resolveIdentity({
    preflight: { targetConfig: target.config, machineId, candidate: { disposition: "continue-held" } },
    cwd: input.cwd,
    homeDir: input.homeDir,
  });
  if (identity.status === "refuse") {
    return { status: "refuse", reason: identity.reason, ...(identity.evidence === undefined ? {} : { evidence: identity.evidence }), generationId };
  }

  const settings = target.config.postgresql;
  const maxRecords = input.maxRecords ?? DEFAULT_MIGRATION_APPLY_MAX_RECORDS;
  const maxBytes = input.maxBytes ?? DEFAULT_MIGRATION_APPLY_MAX_BYTES;
  const ownerProcessId = (ops?.mintOwnerProcessId ?? randomUUID)();

  if (row === 21) {
    let result;
    try {
      result = await (ops?.copy ?? runSqliteMigrationCopy)({
        generationId, homeDir: input.homeDir, settings, expectedOwner: settings.migrationRole,
        expectedIdentity: identity.expectedIdentity, ownerProcessId, maxRecords, maxBytes,
      });
    } catch (error) {
      return { status: "refuse", reason: "copy-failed", evidence: unexpectedFailureEvidence(error), generationId, applied: true };
    }
    const head = readHead(manifestStore, generationId);
    if (head.status === "refuse") return { ...head, applied: true };
    if (head.phase !== result.phase) {
      return { status: "refuse", reason: "copy-failed", evidence: "manifest-readback-mismatch", generationId, applied: true };
    }
    return {
      status: "ok", generationId, manifestPhase: head.phase, applied: true, next: "report", evidence: { cell: 21 },
    };
  }

  const pending = context.manifest?.pendingEffect ?? null;
  const outcome = await (ops?.genesisDryRun ?? performMigrationGenesisDryRun)({
    homeDir: input.homeDir, generationId, maintenanceChecksumSha256: journal.checksumSha256,
    settings, expectedOwner: settings.migrationRole, expectedIdentity: identity.expectedIdentity,
    ownerProcessId, maxRecords, maxBytes, manifestStore,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(pending === null ? {} : { carriedEffectId: pending.effectId }),
  });
  if (outcome.status === "refuse") {
    // Only a refusal after the effect began leaves a write behind.
    return {
      status: "refuse", reason: outcome.reason, generationId,
      ...(outcome.evidence === undefined ? {} : { evidence: outcome.evidence }),
      ...(outcome.reason === "genesis-dry-run-complete-failed" ? { applied: true as const } : {}),
    };
  }
  const head = readHead(manifestStore, generationId);
  if (head.status === "refuse") return { ...head, applied: true };
  if (head.phase !== "dry-run-verified" || head.pending !== null) {
    return { status: "refuse", reason: "resume-readback-mismatch", evidence: `manifest-${head.phase}`, generationId, applied: true };
  }
  return {
    status: "ok", generationId, manifestPhase: head.phase, applied: true, next: "resume", evidence: { cell: row },
  };
}

type ManifestHead =
  | Readonly<{ status: "head"; phase: string; pending: string | null }>
  | Readonly<{ status: "refuse"; reason: string; evidence: string; generationId: string }>;

function readHead(store: MigrationManifestStore, generationId: string): ManifestHead {
  try {
    const manifest = store.read(generationId);
    return { status: "head", phase: manifest.phase, pending: manifest.pendingEffect?.kind ?? null };
  } catch (error) {
    return {
      status: "refuse", reason: "manifest-unresolvable", generationId,
      evidence: error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error",
    };
  }
}

