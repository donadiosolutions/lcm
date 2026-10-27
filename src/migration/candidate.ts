import {
  withBackendPublicationAppendBarrierAsync,
  type BackendMaintenanceJournal,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import { authenticateSqliteMigrationSource } from "./maintenance.js";
import { observeMigrationMaintenanceJournal } from "./journal-observation.js";
import {
  resolveMigrationHoldContinuation,
  type MigrationHoldCandidate,
} from "./hold-continuation.js";
import { resolveMigrationGenerationId, MigrationIdentityError } from "./generation-identity.js";
import { abortSetMemberGenerationIds, classifyMigrationAbortGate } from "./abort.js";
import { MigrationManifestStore } from "./manifest-store.js";

/**
 * Section 9's genesis repair: `plan` must be able to compute, without
 * mutating anything, the exact generation id `apply` would act on if
 * invoked right now, so a later `apply --confirm-generation <id>` has
 * something concrete to compare against.
 *
 * This module is deliberately the *only* place that implements the preview
 * decision tree, and it is built by calling apply's own underlying
 * primitives (`observeMigrationMaintenanceJournal`,
 * `resolveMigrationHoldContinuation`, `classifyMigrationAbortGate`,
 * `resolveMigrationGenerationId`) rather than re-deriving their logic, for
 * the same reason section 1 gives for apply itself: a second
 * implementation of one decision is a second thing that can drift from the
 * first. The one place this module cannot literally *call*
 * `performMigrationApplyThroughCapture` is that apply's function durably
 * writes (`enterMaintenance`, capture) as soon as it reaches a decision;
 * this module stops one step earlier, at the same decision, before any
 * write happens. Test coverage includes an equivalence assertion that
 * feeds an identical fixture through both this module and
 * `performMigrationApplyThroughCapture` and asserts they resolve the same
 * generation id, so the two paths agreeing is tested, not merely intended.
 *
 * Never calls `coordinator.enterMaintenance`, `captureAuthenticatedSqliteMigrationSource`,
 * or any other durable write. A caller that needs the real (mutating)
 * resolution must use `performMigrationApplyThroughCapture` instead; this
 * module answers only "what would happen next", never "make it happen".
 */

export type MigrationApplyCandidateDisposition = "fresh" | "recover-entering" | "continue-held";

export type MigrationApplyCandidateResolution =
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>
  | Readonly<{ status: "candidate"; disposition: MigrationApplyCandidateDisposition; generationId: string }>;

export type MigrationApplyCandidateOperations = Readonly<{
  observeJournal: typeof observeMigrationMaintenanceJournal;
  resolveHoldContinuation: typeof resolveMigrationHoldContinuation;
  resolveGenerationId: typeof resolveMigrationGenerationId;
}>;

export type MigrationApplyCandidateInput = Readonly<{
  cwd: string;
  homeDir: string;
  base: string;
  maxProbeOrdinal?: number;
  manifestStore?: MigrationManifestStore;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`.
   */
  _operationsForTesting?: Partial<MigrationApplyCandidateOperations>;
}>;

async function resolveFreshCandidateUnderToken(
  input: MigrationApplyCandidateInput,
  manifestStore: MigrationManifestStore,
  resolveGenerationId: typeof resolveMigrationGenerationId,
  token: BackendPublicationLockToken,
): Promise<MigrationApplyCandidateResolution> {
  try {
    const resolution = await resolveGenerationId({
      base: input.base,
      homeDir: input.homeDir,
      lockToken: token,
      manifestStore,
      maxProbeOrdinal: input.maxProbeOrdinal,
    });
    return { status: "candidate", disposition: "fresh", generationId: resolution.generationId };
  } catch (error) {
    // Same conversion apply.ts's freshCutoverUnderBarrier applies to its
    // own resolveConfirmedMigrationGenerationId call: a thrown
    // MigrationIdentityError becomes a generation-<reason> refusal rather
    // than an uncaught exception, and any other throw still propagates
    // rather than being misclassified as a generation refusal.
    if (!(error instanceof MigrationIdentityError)) throw error;
    return { status: "refuse", reason: `generation-${error.reason}`, evidence: error.evidence ?? undefined };
  }
}

/**
 * Section 9's preview resolution. Never durably writes; acquires the
 * append barrier only to obtain the live, verified lock token
 * `resolveMigrationGenerationId`'s occupancy classification requires
 * (section 4.9 exposure 1, layer 1), exactly as apply's own continuation
 * and fresh-cutover paths already do for reads.
 */
export async function resolveMigrationApplyCandidate(
  input: MigrationApplyCandidateInput,
): Promise<MigrationApplyCandidateResolution> {
  const manifestStore = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const observeJournal = input._operationsForTesting?.observeJournal ?? observeMigrationMaintenanceJournal;
  const resolveHoldContinuation = input._operationsForTesting?.resolveHoldContinuation ?? resolveMigrationHoldContinuation;
  const resolveGenerationId = input._operationsForTesting?.resolveGenerationId ?? resolveMigrationGenerationId;

  const observation = observeJournal({ homeDir: input.homeDir });
  if (observation.kind === "publication") {
    return { status: "refuse", reason: "publication-occupies-slot" };
  }
  if (observation.kind === "unresolvable") {
    return { status: "refuse", reason: "journal-unresolvable", evidence: observation.evidence };
  }

  if (observation.kind === "absent") {
    return withBackendPublicationAppendBarrierAsync(
      input.homeDir,
      (token) => resolveFreshCandidateUnderToken(input, manifestStore, resolveGenerationId, token),
    );
  }

  const journal: BackendMaintenanceJournal = observation.journal;

  if (journal.phase === "maintenance-entering") {
    // Mirrors apply's own treatment exactly: resolveMigrationHoldContinuation
    // ignores the candidate for this phase and always recovers the same
    // generation id unconditionally, with no occupancy probe involved.
    return { status: "candidate", disposition: "recover-entering", generationId: journal.generationId };
  }

  return withBackendPublicationAppendBarrierAsync(input.homeDir, async (token) => {
    const authority = authenticateSqliteMigrationSource(input.cwd, input.homeDir, token);
    const candidate: MigrationHoldCandidate = {
      publicationId: journal.publicationId,
      generationId: journal.generationId,
      sourceSelectionSha256: authority.sourceSelectionSha256,
      machineId: authority.machineIdentity.machineId,
    };
    const disposition = resolveHoldContinuation({ journal, candidate });
    if (disposition.action === "continue-held") {
      return { status: "candidate", disposition: "continue-held", generationId: journal.generationId };
    }
    if (disposition.action === "refuse") {
      return { status: "refuse", reason: `continuation-${disposition.reason}` };
    }
    if (disposition.action === "probe-fresh") {
      // Section 4.6: the same abort gate apply itself applies before ever
      // probing for a fresh candidate past a terminal journal.
      const gate = classifyMigrationAbortGate({
        journalTerminal: true,
        generationId: journal.generationId,
        generationIds: abortSetMemberGenerationIds(journal),
        manifestStore,
      });
      if (gate.status === "unresolvable") {
        return { status: "refuse", reason: "abort-gate-unresolvable", evidence: gate.evidence };
      }
      if (gate.status === "incomplete-pair") {
        return { status: "refuse", reason: "abort-or-resume-required", evidence: gate.evidence };
      }
      return resolveFreshCandidateUnderToken(input, manifestStore, resolveGenerationId, token);
    }
    // disposition.action === "recover-entering" here is unreachable: this
    // branch only ever runs for a journal phase other than
    // "maintenance-entering" (handled above, before any barrier is
    // acquired), and resolveMigrationHoldContinuation only returns
    // "recover-entering" for that exact phase. Kept as a type-level guard,
    // provable by the _operationsForTesting seam, not a runtime claim.
    return { status: "refuse", reason: "continuation-unclassified" };
  });
}
