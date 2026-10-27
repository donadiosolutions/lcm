import { randomUUID } from "node:crypto";
import {
  resolveMigrationExpectedIdentity,
  resolveMigrationPreflight,
  type MigrationIdentityEffect,
  type MigrationIdentityPreview,
  type MigrationPreflightResult,
  migrationIdentityPreview,
} from "./cli-preflight.js";
import {
  performMigrationApplyThroughCapture,
  type MigrationApplyThroughCaptureOutcome,
} from "./apply.js";
import {
  performMigrationApplyGenesisAndCopy,
  type MigrationApplyGenesisAndCopyOutcome,
} from "./apply-genesis-copy.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { MigrationProtocolError } from "./protocol.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, withMigrationBoundary } from "./boundary.js";
import type { MigrationDaemonPresence } from "./daemon-presence.js";
import type { BackendPublicationCoordinator } from "../storage/backend-publication.js";

/**
 * The `apply` command's CLI orchestration (section 3): the entry point.
 * Composes, in order: the same shared preflight `plan` uses (never a
 * second implementation -- see `cli-preflight.ts`'s own module doc), the
 * section 9 confirmation fence, capture through the hold
 * (`performMigrationApplyThroughCapture`), and manifest genesis and copy
 * (`performMigrationApplyGenesisAndCopy`) with the three ownership
 * parameters settled and proven in this candidate's own history:
 * `expectedOwner` from the resolved target's `migrationRole`,
 * `expectedIdentity` from the shared preflight's own
 * `resolveStorageIdentityContext` call (never re-derived), and
 * `ownerProcessId` as a fresh `randomUUID()` minted once per invocation
 * (proven independent of resume via a real-PostgreSQL interrupt-and-resume
 * test using three genuinely distinct owner ids across its three legs).
 *
 * **Section 9's genesis-and-two-observation fence.** The operator-supplied
 * `confirmGenerationId` (what `plan` printed at an earlier moment) and the
 * freshly re-run preflight's candidate id (what is true now) are two
 * independent observations in time, not two implementations of one
 * predicate -- corrupt either side (a stale token, or a state change
 * between `plan` and `apply`) and the fence still catches it. A missing
 * token refuses like any other missing confirmation; a moved candidate
 * refuses distinctly. Neither check is skipped or weakened by the other:
 * `performMigrationApplyThroughCapture`'s own internal
 * `resolveConfirmedMigrationGenerationId` layer-2 recheck, and capture's
 * own post-sampling reclassification, both still run underneath this
 * fence, unconditionally -- the fence guards against an operator acting on
 * a stale id; it does not, and must not, replace the independent defences
 * against a race the fence itself cannot see.
 *
 * `--dry-run` (section 9) stops after the fence, before any hold is taken:
 * the envelope reports the confirmed candidate with `applied: false`,
 * proved not to reach a mutating seam because `performMigrationApplyThroughCapture`
 * is never called on that path.
 *
 * **The identity step runs inside the capture span** (plan-v5 Part B (3)).
 * For a fresh generation the span mints the local map entry and the
 * destination project only after its own re-check of the confirmed
 * candidate, so `confirmation-generation-moved` never leaves identity
 * behind. The refusals that can still follow a mint (a failed hold entry,
 * a capture, genesis or copy failure, or an unclassified throw) carry what
 * the step actually did at each of its write boundaries: the envelope then
 * reports `applied: true` with `localProject` and `destinationProject`
 * evidence. A minted local entry is reused by the next `apply`; a
 * destination is reused only when the evidence says `created` or `exists`,
 * and is created then when it says `not-created` or `unknown`.
 */

export const DEFAULT_MIGRATION_APPLY_MAX_RECORDS = 500;
export const DEFAULT_MIGRATION_APPLY_MAX_BYTES = 16 * 1024 * 1024;

/** The two presence answers that reach an ok outcome; `unresolvable` refuses upstream. */
export type MigrationApplyDaemonPresence = Extract<
  MigrationDaemonPresence,
  { status: "present" } | { status: "authoritatively-absent" }
>;

export type MigrationApplyOutcome =
  | Readonly<{
    status: "ok";
    generationId: string;
    applied: boolean;
    phase?: string;
    /** The preflight's daemon-presence answer, carried into the exit-0 evidence (round-1 A-8). */
    daemonPresence: MigrationApplyDaemonPresence;
    /** Present only for `--dry-run`: what apply would mint, reported without minting it. */
    identityPreview?: MigrationIdentityPreview;
  }>
  | Readonly<{
    status: "refuse";
    reason: string;
    evidence?: string;
    /** Set when the identity step already wrote durably before this refusal. */
    applied?: boolean;
    /** What the identity step left behind, whenever it ran on the fresh path. */
    identity?: MigrationApplyIdentityMutation;
  }>;

/**
 * What a fresh `apply`'s identity step left behind, from the effects the
 * step reported at each successful write boundary, never from the
 * preflight's earlier preview (a concurrent actor may have persisted or
 * created either in between, and the step then reuses it). A stage whose
 * boundary was never reached is `not-persisted` / `not-created` after a
 * classified refusal, which happens before that stage writes, and
 * `unknown` after a throw, which may have interrupted the write itself.
 */
export type MigrationApplyIdentityMutation = Readonly<{
  localProject: "minted" | "persisted" | "not-persisted" | "unknown";
  destinationProject: "created" | "exists" | "not-created" | "unknown";
}>;

/** The boundaries a fresh identity step has reported so far. */
export type MigrationApplyIdentityProgress = Readonly<{
  localProject?: "minted" | "persisted";
  destinationProject?: "created" | "exists";
}>;

export function recordMigrationIdentityEffect(
  progress: MigrationApplyIdentityProgress,
  effect: MigrationIdentityEffect,
): MigrationApplyIdentityProgress {
  return effect.stage === "local"
    ? { ...progress, localProject: effect.outcome === "persisted" ? "minted" : "persisted" }
    : { ...progress, destinationProject: effect.outcome === "created" ? "created" : "exists" };
}

export function migrationApplyIdentityMutation(
  progress: MigrationApplyIdentityProgress,
  ending: "returned" | "thrown",
): MigrationApplyIdentityMutation {
  return {
    localProject: progress.localProject ?? (ending === "returned" ? "not-persisted" : "unknown"),
    destinationProject: progress.destinationProject ?? (ending === "returned" ? "not-created" : "unknown"),
  };
}

type ApplyRefusal = Extract<MigrationApplyOutcome, { status: "refuse" }>;

/** A refusal after the identity step reports what the step wrote, and `applied` when it wrote at all. */
function withIdentityMutation(refusal: ApplyRefusal, mutation: MigrationApplyIdentityMutation | undefined): ApplyRefusal {
  if (mutation === undefined) return refusal;
  const wrote = mutation.localProject === "minted" || mutation.destinationProject === "created";
  return { ...refusal, ...(wrote ? { applied: true } : {}), identity: mutation };
}

/**
 * The fresh identity step's bookkeeping, shared between the span callback
 * and the boundary so a throw anywhere after the step began still reports
 * what the step had written by then.
 */
type IdentityBookkeeping = { started: boolean; progress: MigrationApplyIdentityProgress; mutation?: MigrationApplyIdentityMutation };

export type MigrationApplyOperations = Readonly<{
  performCapture: typeof performMigrationApplyThroughCapture;
  performGenesisAndCopy: typeof performMigrationApplyGenesisAndCopy;
  mintOwnerProcessId: () => string;
  resolveExpectedIdentity: typeof resolveMigrationExpectedIdentity;
}>;

export type MigrationApplyInput = Readonly<{
  cwd: string;
  homeDir: string;
  confirmGenerationId?: string;
  dryRun?: boolean;
  maxRecords?: number;
  maxBytes?: number;
  coordinator?: BackendPublicationCoordinator;
  manifestStore?: MigrationManifestStore;
  now?: Date;
  /**
   * Called once, before the confirmation fence and any write, when the
   * preflight observed a running daemon, so the operator hears about the
   * fenced consumer before the hold is taken (round-1 A-8).
   */
  onDaemonObserved?: (presence: Extract<MigrationDaemonPresence, { status: "present" }>) => void;
  /**
   * @internal Test-only escape hatch, matching `cli-plan.ts`'s own
   * convention, to reuse `resolveMigrationPreflight`'s injection seam
   * without duplicating its composition here.
   */
  _preflight?: () => Promise<MigrationPreflightResult>;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`.
   */
  _operationsForTesting?: Partial<MigrationApplyOperations>;
}>;

export function performMigrationApply(input: MigrationApplyInput): Promise<MigrationApplyOutcome> {
  const identity: IdentityBookkeeping = { started: false, progress: {} };
  return withMigrationBoundary(
    () => runMigrationApply(input, identity),
    (evidence) => withIdentityMutation(
      // A dry run never reaches a write, so its boundary fallback is not applied.
      { status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence, ...(input.dryRun === true ? { applied: false } : {}) },
      identity.mutation ?? (identity.started ? migrationApplyIdentityMutation(identity.progress, "thrown") : undefined),
    ),
  );
}

async function runMigrationApply(input: MigrationApplyInput, identity: IdentityBookkeeping): Promise<MigrationApplyOutcome> {
  const performCapture = input._operationsForTesting?.performCapture ?? performMigrationApplyThroughCapture;
  const performGenesisAndCopy = input._operationsForTesting?.performGenesisAndCopy ?? performMigrationApplyGenesisAndCopy;
  const mintOwnerProcessId = input._operationsForTesting?.mintOwnerProcessId ?? randomUUID;
  const resolveExpectedIdentity = input._operationsForTesting?.resolveExpectedIdentity ?? resolveMigrationExpectedIdentity;

  const runPreflight = input._preflight ?? (() => resolveMigrationPreflight({ cwd: input.cwd, homeDir: input.homeDir }));
  const preflight = await runPreflight();
  if (preflight.status === "refuse") {
    return preflight;
  }
  const daemonPresence = preflight.presence;
  if (daemonPresence.status === "present") input.onDaemonObserved?.(daemonPresence);

  // Section 9's confirmation fence: a missing token refuses like any other
  // missing confirmation; a moved candidate refuses distinctly. Neither is
  // a guess -- both reasons are already in refusal-mapping.ts's table.
  if (input.confirmGenerationId === undefined) {
    return { status: "refuse", reason: "confirmation-missing" };
  }
  if (input.confirmGenerationId !== preflight.candidate.generationId) {
    return { status: "refuse", reason: "confirmation-generation-moved" };
  }

  if (input.dryRun === true) {
    return {
      status: "ok", generationId: preflight.candidate.generationId, applied: false, daemonPresence,
      identityPreview: migrationIdentityPreview(preflight),
    };
  }

  // Past the fence, the capture span runs the identity step under its own
  // token, after its re-check of the confirmed candidate (plan-v5 Part B
  // (3)). The span names the path it actually found; a held journal only
  // reads. The fresh step reports each write boundary as it succeeds, so
  // every later refusal, and the boundary after a throw, reports what the
  // step actually did.
  const captureResult: MigrationApplyThroughCaptureOutcome = await performCapture({
    cwd: input.cwd,
    homeDir: input.homeDir,
    base: preflight.base,
    confirmGenerationId: input.confirmGenerationId,
    coordinator: input.coordinator,
    manifestStore: input.manifestStore,
    now: input.now,
    resolveExpectedIdentity: async (step) => {
      if (step.path === "held") {
        return resolveExpectedIdentity({
          preflight: { ...preflight, candidate: { disposition: "continue-held" } }, cwd: input.cwd, homeDir: input.homeDir,
        });
      }
      identity.started = true;
      const result = await resolveExpectedIdentity({
        preflight,
        cwd: input.cwd,
        homeDir: input.homeDir,
        publicationLockToken: step.token,
        observe: (effect) => { identity.progress = recordMigrationIdentityEffect(identity.progress, effect); },
      });
      identity.mutation = migrationApplyIdentityMutation(identity.progress, "returned");
      return result;
    },
  });
  if (captureResult.status === "refuse") {
    return withIdentityMutation(captureResult, identity.mutation);
  }
  const expectedIdentity = captureResult.expectedIdentity;
  if (expectedIdentity === undefined) {
    // The span never ran the identity step it was given. Unreachable through
    // the real span; refused rather than copying under an unknown identity.
    return withIdentityMutation({ status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence: "identity-not-resolved" }, identity.mutation);
  }

  const ownerProcessId = mintOwnerProcessId();
  const manifestStore = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const genesisCopyResult: MigrationApplyGenesisAndCopyOutcome = await performGenesisAndCopy({
    homeDir: input.homeDir,
    generationId: captureResult.generationId,
    maintenanceChecksumSha256: captureResult.maintenanceChecksumSha256,
    settings: preflight.targetConfig.postgresql,
    expectedOwner: preflight.targetConfig.postgresql.migrationRole,
    expectedIdentity,
    ownerProcessId,
    maxRecords: input.maxRecords ?? DEFAULT_MIGRATION_APPLY_MAX_RECORDS,
    maxBytes: input.maxBytes ?? DEFAULT_MIGRATION_APPLY_MAX_BYTES,
    manifestStore,
    now: input.now,
  });
  if (genesisCopyResult.status === "refuse") {
    return withIdentityMutation(genesisCopyResult, identity.mutation);
  }

  // Plan section 5.1 / round-1 A-16: the manifest head is read back, and the
  // phase the envelope reports is the one read, not the copy layer's own
  // return value.
  let head;
  try {
    head = manifestStore.read(captureResult.generationId);
  } catch (error) {
    return withIdentityMutation({
      status: "refuse",
      reason: "manifest-unresolvable",
      evidence: error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error",
    }, identity.mutation);
  }
  if (head.phase !== genesisCopyResult.result.phase) {
    return withIdentityMutation({ status: "refuse", reason: "copy-failed", evidence: "manifest-readback-mismatch" }, identity.mutation);
  }

  return {
    status: "ok",
    generationId: captureResult.generationId,
    applied: true,
    phase: head.phase,
    daemonPresence,
  };
}
