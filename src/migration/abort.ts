import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  backendPublicationCanonicalSha256,
  isTerminalBackendMaintenancePhase,
  type BackendMaintenanceJournal,
} from "../storage/backend-publication.js";
import {
  MigrationManifestStore,
} from "./manifest-store.js";
import {
  beginMigrationEffect,
  classifyMigrationRecovery,
  completeMigrationEffect,
  MigrationProtocolError,
  type MigrationManifest,
} from "./protocol.js";

/**
 * Section 4.6's abort gate and the `abort` operation itself. `abortMaintenance`
 * terminalizes the journal and does not touch the manifest; the manifest's
 * own `abort` effect is a separate write. This module treats `abort` as one
 * recovery-classifying operation that completes whichever of the two writes
 * is missing, never as two independent writes a caller could interleave with
 * something else.
 */

function journalFailureEvidence(error: unknown): string {
  if (error instanceof BackendPublicationJournalError) return `journal-${error.reason}`;
  return "journal-internal-error";
}

export type MigrationAbortGateStatus =
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "incomplete-pair"; evidence: string }>
  | Readonly<{ status: "unresolvable"; evidence: string }>;

/**
 * `apply` never probes for a fresh candidate while the journal and manifest
 * disagree (section 4.6). A non-terminal journal is not this gate's concern
 * at all: only a terminal journal (the one case `resolveMigrationHoldContinuation`
 * routes to `probe-fresh`) needs its manifest checked before probing is safe.
 *
 * A manifest that is genuinely absent is not a disagreement: it means
 * genesis never ran for this generation, which is a legitimate terminal
 * state (e.g. aborted before capture). Only a manifest that is *present but
 * not settled* is the dangerous case that must refuse and name `abort`.
 */
export function classifyMigrationAbortGate(input: Readonly<{
  journalTerminal: boolean;
  generationId: string;
  /**
   * A terminal cutover-set journal names no manifest of its own: its set id
   * is never a generation. The member generations are consulted instead, in
   * manifest order, and a refusal names the member in its evidence (#1548).
   */
  generationIds?: readonly string[] | undefined;
  manifestStore: MigrationManifestStore;
}>): MigrationAbortGateStatus {
  if (!input.journalTerminal) return { status: "ready" };
  const members = input.generationIds;
  for (const generationId of members ?? [input.generationId]) {
    const member = classifyMigrationAbortGateManifest(generationId, input.manifestStore);
    if (member.status !== "ready") {
      return members === undefined ? member : { ...member, evidence: `${generationId}:${member.evidence}` };
    }
  }
  return { status: "ready" };
}

function classifyMigrationAbortGateManifest(
  generationId: string,
  manifestStore: MigrationManifestStore,
): MigrationAbortGateStatus {
  const presence = manifestStore.probeManifestPresence(generationId);
  if (presence.status === "unresolvable") {
    return { status: "unresolvable", evidence: `manifest-${presence.reason}` };
  }
  if (presence.status === "absent") return { status: "ready" };
  let manifest: MigrationManifest;
  try {
    manifest = manifestStore.read(generationId);
  } catch (error) {
    return {
      status: "unresolvable",
      evidence: error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error",
    };
  }
  const recovery = classifyMigrationRecovery(manifest);
  if (recovery.action === "settled") return { status: "ready" };
  return { status: "incomplete-pair", evidence: `manifest-${recovery.action}` };
}

/**
 * The member generations a cutover-set journal's abort settles, in manifest
 * order; `undefined` for a single-generation journal, which settles only its
 * own generation.
 */
export function abortSetMemberGenerationIds(journal: BackendMaintenanceJournal): readonly string[] | undefined {
  return journal.cutoverSet?.manifest.members.map((member) => member.generationId);
}

/** Every generation whose manifest the journal's abort must settle. */
export function abortManifestGenerationIds(journal: BackendMaintenanceJournal): readonly string[] {
  return abortSetMemberGenerationIds(journal) ?? [journal.generationId];
}

export type MigrationAbortResult =
  /** `mutated` is false for an idempotent repeat that found both writes already made. */
  | Readonly<{ status: "completed"; mutated: boolean }>
  | Readonly<{ status: "dry-run" }>
  /**
   * `mutated` reports whether a durable write (the journal termination or
   * either manifest write) was made before this refusal, so a caller never
   * has to guess whether state moved (round-1 A-2).
   */
  | Readonly<{
    status: "refuse";
    evidence: string;
    mutated: boolean;
    /** The failing member generation of a cutover-set abort; absent for journal-wide failures and single generations. */
    member?: string;
  }>;

function abortEffectId(generationId: string): string {
  return backendPublicationCanonicalSha256({ kind: "migration-abort-effect", generationId });
}

/**
 * The completion evidence of the manifest's `abort` effect, the single
 * formula both `performMigrationAbort` and `completePendingMigrationAbort`
 * use, so a completion by either is byte-identical.
 */
function abortCompletion(
  generationId: string,
  effectId: string,
  abortEvidenceSha256: string,
  completedAt: string,
): Parameters<typeof completeMigrationEffect>[1] {
  return {
    effectId,
    completedAt,
    report: {
      kind: "abort",
      reportId: backendPublicationCanonicalSha256({ kind: "migration-abort-report-id", generationId, effectId }),
      reportSha256: backendPublicationCanonicalSha256({
        version: 1,
        kind: "migration-abort-report",
        generationId,
        abortEvidenceSha256,
        completedAt,
      }),
      createdAt: completedAt,
    },
  };
}

function manifestFailureEvidence(error: unknown): string {
  return error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error";
}

/**
 * Completes whichever of the two writes (journal termination, manifest
 * settlement) is missing, and is idempotent under repetition: calling this
 * again once both are already settled observes that and reports `completed`
 * without attempting either write again.
 *
 * **Classify, then mutate (round-1 A-1).** Every read and the manifest's
 * recovery classification happen before the first durable write. A manifest
 * whose pending copy effect only `resume` can settle is refused while the
 * journal is still untouched: terminalizing the journal first would strand a
 * terminal journal beside a manifest no registered command can settle.
 *
 * `abortEvidenceSha256` and `sourceSelectionSha256` for the journal-side
 * write come from the caller's confirmed evidence, never re-derived here
 * (section 4.6: `abort` confirms against the live journal's own values).
 *
 * This item's scope stops at the copy-phase manifest effects it owns
 * (section 13's "implementable now" list: `planned` through `verified`).
 * A manifest with a pending retry-idempotent or readback-pending effect is
 * refused rather than resumed or abandoned here — completing an in-flight
 * copy effect is `resume`'s router (section 8), and `abandonMigrationEffect`
 * only applies to activation/rollback effects, neither of which this
 * candidate implements.
 */
export type MigrationAbortOperations = Readonly<{
  beginEffect: typeof beginMigrationEffect;
  completeEffect: typeof completeMigrationEffect;
}>;

export async function performMigrationAbort(input: Readonly<{
  homeDir: string;
  coordinator: BackendPublicationCoordinator;
  journal: BackendMaintenanceJournal;
  abortEvidenceSha256: string;
  manifestStore?: MigrationManifestStore;
  now?: Date;
  /** Run every read and classification, then stop before the first write. */
  dryRun?: boolean;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`. `beginMigrationEffect`/`completeMigrationEffect` are
   * pure functions whose only documented failure mode is a typed
   * `MigrationProtocolError`; this default is never overridden in
   * production.
   */
  _operationsForTesting?: Partial<MigrationAbortOperations>;
}>): Promise<MigrationAbortResult> {
  const beginEffect = input._operationsForTesting?.beginEffect ?? beginMigrationEffect;
  const completeEffect = input._operationsForTesting?.completeEffect ?? completeMigrationEffect;
  let journal = input.journal;
  // #1550 (C4, D7): a postgresql-origin set hold is a set rollback in progress; the migration abort never touches
  // its journal or its members' rollback effects (no set rollback abort exists in #1550).
  if (journal.cutoverSet !== undefined && journal.sourceBackend === "postgresql") {
    return { status: "refuse", evidence: "journal-rollback-hold", mutated: false };
  }
  const journalNeedsWrite = !isTerminalBackendMaintenancePhase(journal.phase);
  if (journalNeedsWrite) {
    if (journal.phase !== "maintenance-held" && journal.phase !== "maintenance-entering") {
      return { status: "refuse", evidence: `journal-${journal.phase}`, mutated: false };
    }
  } else if (journal.phase !== "maintenance-aborted") {
    // selection-completed: a successful cutover, not an abort target.
    return { status: "refuse", evidence: `journal-${journal.phase}`, mutated: false };
  }

  // A set abort names the failing member; a single generation keeps its bare evidence byte-for-byte.
  const member = (generationId: string): { member?: string } =>
    input.journal.cutoverSet === undefined ? {} : { member: generationId };

  // Everything below up to the first write is read-only. A cutover-set
  // journal settles every member generation (#1548 C8): all of them are
  // classified before the first write, so one member that cannot be
  // settled refuses the whole abort with the journal untouched.
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const settling: { generationId: string; manifest: MigrationManifest; carried: boolean }[] = [];
  for (const generationId of abortManifestGenerationIds(journal)) {
    const presence = store.probeManifestPresence(generationId);
    if (presence.status === "unresolvable") {
      return { status: "refuse", evidence: `manifest-${presence.reason}`, mutated: false, ...member(generationId) };
    }
    if (presence.status === "absent") continue;
    let manifest: MigrationManifest;
    try {
      manifest = store.read(generationId);
    } catch (error) {
      return { status: "refuse", evidence: manifestFailureEvidence(error), mutated: false, ...member(generationId) };
    }
    const recovery = classifyMigrationRecovery(manifest);
    if (recovery.action === "settled") continue;
    if (recovery.action === "ready") {
      settling.push({ generationId, manifest, carried: false });
      continue;
    }
    // Only a set abort resumes a carried abort effect: the journal is already aborted, so the effect's
    // exact member id and aborted-journal input are what an uninterrupted run would have begun.
    const pending = manifest.pendingEffect!;
    if (journal.cutoverSet === undefined || journalNeedsWrite || pending.kind !== "abort") {
      return { status: "refuse", evidence: `manifest-${recovery.action}`, mutated: false, ...member(generationId) };
    }
    if (journal.abortEvidenceSha256 === null || pending.effectId !== abortEffectId(generationId)
      || pending.inputSha256 !== journal.checksumSha256) {
      return { status: "refuse", evidence: "carried-effect-mismatch", mutated: false, ...member(generationId) };
    }
    settling.push({ generationId, manifest, carried: true });
  }

  if (input.dryRun === true) return { status: "dry-run" };

  let mutated = false;
  if (journalNeedsWrite) {
    try {
      journal = await input.coordinator.abortMaintenance({
        expectedChecksumSha256: journal.checksumSha256,
        sourceSelectionSha256: journal.sourceSelectionSha256,
        abortEvidenceSha256: input.abortEvidenceSha256,
      });
      mutated = true;
    } catch (error) {
      return { status: "refuse", evidence: journalFailureEvidence(error), mutated: false };
    }
  }

  const now = (input.now ?? new Date()).toISOString();
  // Every completion seals to the aborted journal's persisted evidence: a retry's caller digests the
  // already-aborted journal, which an uninterrupted run never saw (Bug #1659; sets since #1548).
  const memberEvidence = journal.abortEvidenceSha256!;
  for (const { generationId, manifest, carried } of settling) {
    const effectId = abortEffectId(generationId);
    if (carried) {
      const pending = manifest.pendingEffect!;
      try {
        store.update(generationId, manifest.checksumSha256, (current) => completeEffect(
          current,
          abortCompletion(generationId, effectId, memberEvidence, pending.startedAt),
        ));
      } catch (error) {
        return { status: "refuse", evidence: manifestFailureEvidence(error), mutated, ...member(generationId) };
      }
      mutated = true;
      continue;
    }
    let begun: MigrationManifest;
    try {
      begun = beginEffect(manifest, {
        effectId,
        kind: "abort",
        inputSha256: journal.checksumSha256,
        startedAt: now,
      });
    } catch (error) {
      return { status: "refuse", evidence: manifestFailureEvidence(error), mutated, ...member(generationId) };
    }
    try {
      store.update(generationId, manifest.checksumSha256, () => begun);
    } catch (error) {
      return { status: "refuse", evidence: manifestFailureEvidence(error), mutated, ...member(generationId) };
    }
    mutated = true;
    let candidate: MigrationManifest;
    try {
      candidate = completeEffect(begun, abortCompletion(generationId, effectId, memberEvidence, now));
    } catch (error) {
      return { status: "refuse", evidence: manifestFailureEvidence(error), mutated, ...member(generationId) };
    }
    try {
      store.update(generationId, begun.checksumSha256, () => candidate);
    } catch (error) {
      return { status: "refuse", evidence: manifestFailureEvidence(error), mutated, ...member(generationId) };
    }
  }
  return { status: "completed", mutated };
}

/**
 * Completes an `abort` effect that an earlier invocation began and did not
 * finish (router row 6: the journal is already `maintenance-aborted` and the
 * manifest carries a pending `abort`). `performMigrationAbort` cannot do
 * this for a single generation: `classifyMigrationRecovery` calls the pending
 * effect `resume` and it refuses. It never touches the journal, so
 * `abortMaintenance` is not called again.
 *
 * The carried effect is checked against what `performMigrationAbort` would
 * have begun for this journal: the same effect id, and an input digest equal
 * to the aborted journal's checksum. The aborted journal's own
 * `abortEvidenceSha256` is the evidence the original completion used, and
 * the effect's `startedAt` is the `now` both of its writes used, so the
 * completion is byte-identical to an uninterrupted run. A mismatch writes
 * nothing.
 */
export function completePendingMigrationAbort(input: Readonly<{
  homeDir: string;
  journal: BackendMaintenanceJournal;
  manifestStore?: MigrationManifestStore;
  /** Make every check, then stop before the completing write. */
  dryRun?: boolean;
}>): MigrationAbortResult {
  const { journal } = input;
  const abortEvidenceSha256 = journal.abortEvidenceSha256;
  if (journal.phase !== "maintenance-aborted" || abortEvidenceSha256 === null) {
    return { status: "refuse", evidence: "carried-effect-mismatch", mutated: false };
  }
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  let manifest: MigrationManifest;
  try {
    manifest = store.read(journal.generationId);
  } catch (error) {
    return { status: "refuse", evidence: manifestFailureEvidence(error), mutated: false };
  }
  const pending = manifest.pendingEffect;
  if (pending === null || pending.kind !== "abort"
    || pending.effectId !== abortEffectId(journal.generationId)
    || pending.inputSha256 !== journal.checksumSha256) {
    return { status: "refuse", evidence: "carried-effect-mismatch", mutated: false };
  }
  if (input.dryRun === true) return { status: "dry-run" };
  try {
    store.update(journal.generationId, manifest.checksumSha256, (current) => completeMigrationEffect(
      current,
      abortCompletion(journal.generationId, pending.effectId, abortEvidenceSha256, pending.startedAt),
    ));
  } catch (error) {
    return { status: "refuse", evidence: manifestFailureEvidence(error), mutated: false };
  }
  return { status: "completed", mutated: true };
}

export type MigrationAbortRefusalClass = "precondition" | "unresumable" | "evidence";

export type MigrationAbortRefusalClassification = Readonly<{
  reason: string;
  class: MigrationAbortRefusalClass;
}>;

/**
 * Classifies `performMigrationAbort`'s flat `evidence` string by the actual
 * fact it represents, never by the mere fact that it refused. This mirrors
 * `classifyEnteringRecoveryFailure`'s discipline exactly, for the same
 * coordinator and largely the same underlying error family: only a reason
 * this function can positively attribute to a specific, source-verified
 * fact is classified as anything other than unresolvable evidence.
 *
 * Read directly at source, not guessed:
 *
 * - `journal-selection-prepared` / `journal-selection-completed`: the
 *   journal's own pre-check in `performMigrationAbort` for "not in an
 *   abortable phase at all" (`abort.ts`'s own two explicit
 *   `journal-${journal.phase}` refusals). A genuine, well-understood
 *   precondition: there is nothing to abort.
 * - `journal-unexpected-state`: `BackendPublicationCoordinator#abortMaintenance`'s
 *   own compare-and-swap check (`backend-publication.ts`'s `abortMaintenance`:
 *   phase, checksum or `sourceSelectionSha256` no longer match what the
 *   caller observed). The one `BackendPublicationJournalError` reason
 *   `abortMaintenance` itself asserts is a precondition mismatch, exactly as
 *   `classifyEnteringRecoveryFailure` treats the same reason from the same
 *   coordinator.
 * - `journal-invalid-input`: `abortMaintenance`'s own malformed-CAS-input
 *   check. The CLI constructed the compare-and-swap input itself, so this
 *   reflects an internal defect, never an operator-fixable precondition.
 * - `manifest-resume` / `manifest-readback`: `classifyMigrationRecovery`'s
 *   own explicit "a pending copy effect exists" answer (`protocol.ts`), not
 *   an error at all. The router sends an ordinary pending effect to resume
 *   before abort runs; this answer is the late case, where the effect began
 *   after the router read, and `resume` owns it (exit 6).
 * - Everything else (`journal-publication-evidence-missing`,
 *   `journal-unsafe-storage`, `journal-malformed-journal`,
 *   `journal-checksum-mismatch`, `journal-unresolved-publication`,
 *   `journal-permit-mismatch`, `journal-backend-mismatch`,
 *   `journal-internal-error`, every other `manifest-<protocol reason>`, and
 *   `manifest-internal-error`) is not a reason this function can positively
 *   attribute to a specific fact from `abort.ts`'s own call sites, so it is
 *   unresolvable evidence, never a guessed precondition or contention: an
 *   unclassifiable failure must not be asserted as a conclusion.
 */
export function classifyMigrationAbortRefusal(evidence: string): MigrationAbortRefusalClassification {
  if (evidence === "journal-selection-prepared" || evidence === "journal-selection-completed") {
    return { reason: "abort-wrong-phase", class: "precondition" };
  }
  if (evidence === "journal-unexpected-state") {
    return { reason: "abort-journal-moved", class: "precondition" };
  }
  if (evidence === "carried-effect-mismatch") {
    return { reason: "abort-carried-effect-mismatch", class: "evidence" };
  }
  if (evidence === "journal-invalid-input") {
    return { reason: "abort-invalid-input", class: "unresumable" };
  }
  if (evidence === "manifest-resume" || evidence === "manifest-readback") {
    return { reason: "abort-manifest-needs-resume", class: "unresumable" };
  }
  return { reason: "abort-unresolvable", class: "evidence" };
}
