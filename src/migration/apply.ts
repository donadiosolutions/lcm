import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  isTerminalBackendMaintenancePhase,
  readBackendMaintenanceJournal,
  withBackendPublicationAppendBarrierAsync,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import {
  authenticateSqliteMigrationSource,
  authenticateSqliteMigrationSourceBytes,
  captureAuthenticatedSqliteMigrationSource,
} from "./maintenance.js";
import { observeMigrationMaintenanceJournal } from "./journal-observation.js";
import {
  resolveMigrationHoldContinuation,
  type MigrationHoldCandidate,
  type MigrationHoldDisposition,
} from "./hold-continuation.js";
import { resolveConfirmedMigrationGenerationId, MigrationIdentityError } from "./generation-identity.js";
import {
  classifyEnteringRecoveryFailure,
  classifyHoldEntryFailure,
  migrationEntryRoster,
  migrationQueueEvidenceSentinel,
} from "./hold-entry.js";
import { classifySqliteSnapshotArtifact } from "./sqlite-snapshot.js";
import { PrivateMutationLockContentionError } from "../private-mutation-lock.js";
import { abortSetMemberGenerationIds, classifyMigrationAbortGate } from "./abort.js";
import { MigrationManifestStore } from "./manifest-store.js";
import type { AuthenticatedSqliteMigrationSnapshot } from "./queue-evidence.js";
import type { MigrationExpectedIdentityResult } from "./cli-preflight.js";
import type { StorageIdentityContext } from "../storage/contracts.js";

/**
 * The section 4.2-4.8 entry point through capture: journal resolution
 * (4.2), the hold and its two continuation predicates (4.4-4.5), the
 * section 4.6 abort gate on a terminal journal, the occupancy probe and its
 * section 4.9 layers when a fresh candidate is needed, and capture itself.
 * This item calls migration services; it does not reimplement them
 * (section 1) — capture, the hold and the coordinator are all #622/#621's
 * own production code.
 *
 * Manifest genesis and copy are not yet wired here; this function's
 * contract ends at a durable, classified-complete snapshot.
 *
 * **Two plan deviations, both verified empirically before landing and
 * reported to the owner.**
 *
 * First: section 4.8 names `withBackendPublicationRetainedAppendAdmissionAsync`
 * as the single acquisition path for the whole span. Calling it here throws
 * `unresolved-publication` as soon as this function's own `enterMaintenance`
 * call succeeds, because `withBackendPublicationConsumerLockAsync` (which the
 * retained-admission path delegates to) calls
 * `assertBackendPublicationConsumerAccessUnlocked` both **before and after**
 * the wrapped callback — correct for its actual only caller, a queue-append
 * *consumer* that must stay refused on both sides of a maintenance
 * transition, but incompatible with being the maintenance *establisher*
 * itself, whose whole job is to create the exact state the post-callback
 * check refuses. `withBackendPublicationAppendBarrierAsync` (the function
 * `captureAuthenticatedSqliteMigrationSource` and
 * `rebindBackendMaintenanceCutoff` already use internally) has no such
 * check and is used here instead; it still provides the single retained
 * token `rebindBackendMaintenanceCutoff` requires for the span it wraps.
 *
 * Second: `withBackendPublicationAppendBarrierAsync` itself refuses
 * ("backend maintenance is not ready for local append") whenever a live
 * journal exists in any phase except `maintenance-held`,
 * `selection-prepared`, `selection-completed` or `maintenance-aborted` —
 * `maintenance-entering` is not in that allowlist, because the barrier is
 * built for local-append participants, not for the maintenance establisher
 * recovering its own entering write. That allowlist is also, separately,
 * exactly the four phases in which an ordinary unauthenticated project-map
 * read is blocked by `assertBackendPublicationConsumerAccessUnlocked`
 * except for the two terminal ones — concretely, `maintenance-held` blocks
 * an unauthenticated `authenticateSqliteMigrationSource` call just as much
 * as it is barrier-admissible, so building the continuation candidate for a
 * held journal needs the barrier's token too, not just capture. This module
 * therefore branches on phase **once**: `maintenance-entering` is handled
 * entirely outside any barrier (no candidate read is needed for it at all —
 * `resolveMigrationHoldContinuation` ignores the candidate for this phase
 * and always recovers), then `coordinator.enterMaintenance` recovery runs
 * on the coordinator's own internal `#locked` mutex (no barrier token
 * required, exactly as for a fresh call before any barrier exists), and
 * only afterward does it acquire the append barrier, to wrap capture alone.
 * Every other hold phase acquires the barrier immediately and classifies
 * the journal from inside it, using an authenticated, tokened read. This
 * does not reopen the section 4.9 exposure-1 window: that exposure is about
 * the occupancy probe and the fresh hold it feeds, and a `recover-entering`
 * disposition has no occupancy probe at all — the generation id is already
 * fixed by the existing journal. The gap between the unbarriered recovery
 * write and the barriered capture is covered the same way every other
 * cross-write gap in this module is: capture's own `revalidate()` re-reads
 * the journal and refuses if it moved.
 */

export const MIGRATION_DRIVER_NOT_INVOKED_MESSAGE = "the v2 publication driver must not run for a maintenance-only coordinator";

/**
 * @internal Exported only so a test can prove every method genuinely
 * refuses, rather than assuming it from the type. None of these methods
 * ever run in production: this coordinator is used purely for the
 * maintenance journal, never for v2 publication.
 */
export function maintenanceOnlyDriver(): BackendPublicationDriver {
  const unexpected = async (): Promise<never> => {
    throw new Error(MIGRATION_DRIVER_NOT_INVOKED_MESSAGE);
  };
  return {
    observeLocalState: unexpected,
    publishProjectMap: unexpected,
    publishConfig: unexpected,
    restoreConfig: unexpected,
    restoreProjectMap: unexpected,
  };
}


export type MigrationApplyThroughCaptureOutcome =
  | Readonly<{
    status: "captured";
    generationId: string;
    maintenanceChecksumSha256: string;
    snapshot: AuthenticatedSqliteMigrationSnapshot;
    /** The identity step's answer, present whenever `resolveExpectedIdentity` was given. */
    expectedIdentity?: StorageIdentityContext;
  }>
  | Readonly<{
    status: "refuse";
    reason: string;
    evidence?: string;
    /** Set only when a failed fresh hold entry demonstrably (or possibly) left its own journal write behind. */
    applied?: true;
  }>;

/**
 * Which span the identity step runs in: `fresh` mints (plan-v5 Part B (3)),
 * `held` only reads. The span decides, from the journal it actually found,
 * never the preflight's earlier disposition. Only the fresh step carries a
 * token: its mint reuses the barrier's admission. The held step is a
 * lock-free read (readProjectMapIdentity plus a SELECT) and runs on the
 * entering-recovery path before any barrier exists, so it has none.
 */
export type MigrationApplyIdentityPath = "fresh" | "held";
export type MigrationApplyIdentityStep =
  | Readonly<{ path: "fresh"; token: BackendPublicationLockToken }>
  | Readonly<{ path: "held" }>;
export type MigrationApplyIdentityResolver = (step: MigrationApplyIdentityStep) => Promise<MigrationExpectedIdentityResult>;

export type MigrationApplyOperations = Readonly<{
  resolveHoldContinuation: typeof resolveMigrationHoldContinuation;
  resolveGenerationId: typeof resolveConfirmedMigrationGenerationId;
  classifyEnteringFailure: typeof classifyEnteringRecoveryFailure;
  observeJournal: typeof observeMigrationMaintenanceJournal;
  captureSource: typeof captureAuthenticatedSqliteMigrationSource;
  classifySnapshot: typeof classifySqliteSnapshotArtifact;
  readJournal: typeof readBackendMaintenanceJournal;
}>;

export type MigrationApplyThroughCaptureInput = Readonly<{
  cwd: string;
  homeDir: string;
  base: string;
  /**
   * The generation id the operator confirmed (plan section 9). It is carried
   * to the point of use and compared against the generation this span is
   * about to act on, immediately before the first durable write, and never
   * re-derived (round-1 A-3/B-2): a candidate that moved since the
   * confirmation refuses `confirmation-generation-moved`.
   */
  confirmGenerationId: string;
  maxProbeOrdinal?: number;
  manifestStore?: MigrationManifestStore;
  now?: Date;
  coordinator?: BackendPublicationCoordinator;
  /**
   * The identity step (plan-v5 Part B (3)), run exactly once under the
   * span's own token before the first authenticated source read. On the
   * fresh path it runs only after the confirmed candidate was re-checked
   * against the live probe, so `confirmation-generation-moved` and every
   * journal-resolution refusal happen before anything is minted; the
   * authenticated read that follows then sees the minted map entry, which
   * is what the hold's source selection and capture's witness are bound to.
   * Its refusal is returned as this span's own. Absent, nothing is resolved
   * and the captured outcome carries no identity.
   */
  resolveExpectedIdentity?: MigrationApplyIdentityResolver;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/` (see `sqlite-snapshot.ts`, `maintenance.ts`,
   * `generation-identity.ts`). `resolveMigrationHoldContinuation`'s own
   * phase switch guarantees `maintenance-entering` always yields
   * `recover-entering` and every other hold phase never does; the two
   * defensive branches below that assume this exist purely as type-level
   * guards over a wider return type, and this seam is how they are proven
   * to actually refuse rather than silently mis-happening, without
   * inventing a real journal that cannot occur.
   */
  _operationsForTesting?: Partial<MigrationApplyOperations>;
}>;

type IdentityStep =
  | Readonly<{ status: "resolved"; expectedIdentity?: StorageIdentityContext }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

async function resolveIdentityUnderBarrier(
  input: MigrationApplyThroughCaptureInput,
  step: MigrationApplyIdentityStep,
): Promise<IdentityStep> {
  if (input.resolveExpectedIdentity === undefined) return { status: "resolved" };
  const identity = await input.resolveExpectedIdentity(step);
  if (identity.status === "refuse") {
    return { status: "refuse", reason: identity.reason, ...(identity.evidence === undefined ? {} : { evidence: identity.evidence }) };
  }
  return { status: "resolved", expectedIdentity: identity.expectedIdentity };
}

/**
 * The shared tail every disposition eventually reaches: authenticate under
 * the retained token, capture, and report. Never called on a journal that
 * has not just been durably confirmed `maintenance-held` by its caller —
 * this function does not itself write or verify the hold. A held caller
 * leaves `identity` undefined and the read-only identity step runs here;
 * the fresh path resolved (minted) before its hold and passes the answer.
 */
async function captureUnderBarrier(
  input: MigrationApplyThroughCaptureInput,
  generationId: string,
  maintenanceChecksumSha256: string,
  token: BackendPublicationLockToken,
  identity?: Extract<IdentityStep, { status: "resolved" }>,
): Promise<MigrationApplyThroughCaptureOutcome> {
  let resolved = identity;
  if (resolved === undefined) {
    const step = await resolveIdentityUnderBarrier(input, { path: "held" });
    if (step.status === "refuse") return step;
    resolved = step;
  }
  const expectedIdentity = resolved.expectedIdentity;
  try {
    const authority = authenticateSqliteMigrationSource(input.cwd, input.homeDir, token);
    const expectedSourceBytes = await authenticateSqliteMigrationSourceBytes(authority, {
      homeDir: input.homeDir,
      lockToken: token,
    });
    const captureSource = input._operationsForTesting?.captureSource ?? captureAuthenticatedSqliteMigrationSource;
    const snapshot = await captureSource(authority, {
      homeDir: input.homeDir,
      generationId,
      maintenanceChecksumSha256,
      expectedSourceBytes,
      lockToken: token,
    });
    // Plan section 4.4 / round-1 A-15: a successful capture is not evidence
    // that the queue evidence was rebound. Read the journal back and require
    // that its queue evidence moved off the entry sentinel. The roster
    // cutoff is deliberately not part of this check: an empty queue
    // legitimately rebinds to a null cutoff, which
    // hasMigrationQueueEvidenceRebindOccurred's both-sides test would call
    // "not rebound".
    const rebound = readBackendMaintenanceJournal(input.homeDir);
    const sentinel = migrationQueueEvidenceSentinel({
      generationId,
      sourceSelectionSha256: authority.sourceSelectionSha256,
    });
    if (rebound === null || rebound.queueEvidenceSha256 === sentinel) {
      return { status: "refuse", reason: "capture-failed", evidence: "queue-evidence-not-rebound" };
    }
    return {
      status: "captured", generationId, maintenanceChecksumSha256, snapshot,
      ...(expectedIdentity === undefined ? {} : { expectedIdentity }),
    };
  } catch (error) {
    // Round-1 A-9: classify by the actual failure, not by the fact that
    // something threw. Contention is a retry (exit 4), a journal failure
    // is unresolvable evidence (exit 5), and only capture's own failures
    // keep the operator-required class (exit 7).
    if (error instanceof PrivateMutationLockContentionError) {
      return { status: "refuse", reason: "capture-contention", evidence: "lock-contention" };
    }
    if (error instanceof BackendPublicationJournalError && error.reason === "unresolved-publication") {
      return { status: "refuse", reason: "capture-contention", evidence: "journal-unresolved-publication" };
    }
    if (error instanceof BackendPublicationJournalError) {
      return { status: "refuse", reason: "capture-unresolvable", evidence: `journal-${error.reason}` };
    }
    return {
      status: "refuse",
      reason: "capture-failed",
      evidence: error instanceof Error ? error.name : "unknown-capture-failure",
    };
  }
}

/**
 * Section 4.9 exposure 1's fenced span: acquire the retained token, probe
 * (with its immediate layer-2 re-check), take the hold, then capture — all
 * inside the one `withBackendPublicationAppendBarrierAsync` callback this
 * function is called from. Used both when no journal exists at all and when
 * an existing journal is terminal and the section 4.6 abort gate has
 * already confirmed the manifest agrees.
 */
async function freshCutoverUnderBarrier(
  input: MigrationApplyThroughCaptureInput,
  coordinator: BackendPublicationCoordinator,
  manifestStore: MigrationManifestStore,
  token: BackendPublicationLockToken,
): Promise<MigrationApplyThroughCaptureOutcome> {
  const resolveGenerationId = input._operationsForTesting?.resolveGenerationId ?? resolveConfirmedMigrationGenerationId;
  let resolution: Awaited<ReturnType<typeof resolveConfirmedMigrationGenerationId>>;
  try {
    resolution = await resolveGenerationId({
      base: input.base,
      homeDir: input.homeDir,
      lockToken: token,
      manifestStore,
      maxProbeOrdinal: input.maxProbeOrdinal,
    });
  } catch (error) {
    // resolveConfirmedMigrationGenerationId's own inner
    // resolveMigrationGenerationId throws MigrationIdentityError (never
    // returns a refuse result) for identifier-bound-exceeded,
    // probe-bound-exceeded, occupancy-refused and invalid-input, unlike
    // its own layer-2 recheck, which does return a refuse result. Left
    // uncaught, this would escape performMigrationApplyThroughCapture as
    // an unclassified exception, violating section 11 test 12's "every
    // exit path maps to one of the nine closed classes, none escape
    // uncaught". Converted here into the same generation-<reason> refuse
    // shape the layer-2 recheck already produces, so both paths reach the
    // CLI through one uniform vocabulary rather than two.
    if (!(error instanceof MigrationIdentityError)) throw error;
    const reason = `generation-${error.reason}`;
    return { status: "refuse", reason, evidence: error.evidence ?? undefined };
  }
  if (resolution.status === "refuse") {
    return { status: "refuse", reason: `generation-${resolution.reason}`, evidence: resolution.evidence };
  }
  // Round-1 A-3/B-2: the confirmed id is compared with the candidate this
  // span just re-probed, inside the span, immediately before the hold. A
  // concurrent same-host actor that occupied the confirmed candidate since
  // the preflight made the re-probe advance; that must refuse, not capture a
  // generation the operator never confirmed.
  if (resolution.generationId !== input.confirmGenerationId) {
    return { status: "refuse", reason: "confirmation-generation-moved" };
  }

  // Plan-v5 Part B (3): only now, with the confirmed candidate re-checked
  // and nothing else left to refuse before the hold needs the map, may the
  // identity be minted. The authenticated read below must see the minted
  // entry: the hold's source selection and capture's witness bind to it.
  const identity = await resolveIdentityUnderBarrier(input, { path: "fresh", token });
  if (identity.status === "refuse") return identity;

  const authority = authenticateSqliteMigrationSource(input.cwd, input.homeDir, token);
  if (authority.projectIdentity.scope !== "local") {
    // Section 4.4: a multi-machine installation is refused with a distinct
    // reason, not silently fenced (#625's D-625-4).
    return { status: "refuse", reason: "multi-machine-installation" };
  }
  const sentinel = migrationQueueEvidenceSentinel({
    generationId: resolution.generationId,
    sourceSelectionSha256: authority.sourceSelectionSha256,
  });
  const roster = migrationEntryRoster({
    machineId: authority.machineIdentity.machineId,
    sentinelEvidenceSha256: sentinel,
  });

  let heldJournal: BackendMaintenanceJournal;
  try {
    heldJournal = await coordinator.enterMaintenance({
      publicationId: resolution.generationId,
      generationId: resolution.generationId,
      sourceSelectionSha256: authority.sourceSelectionSha256,
      queueEvidenceSha256: sentinel,
      roster,
      now: input.now,
    }, token);
  } catch (error) {
    const failure = classifyHoldEntryFailure(error);
    const refusal = { status: "refuse" as const, reason: `hold-entry-${failure.class}`, evidence: failure.evidence };
    // enterMaintenance writes maintenance-entering before maintenance-held, so
    // a failure between the two leaves this invocation's own entering hold on
    // disk. The live journal is read back: a binding match, or a readback that
    // cannot answer, reports applied; a prior, foreign or terminal journal
    // is not a write of this invocation.
    return wroteOwnEnteringHold(input, resolution.generationId, authority.sourceSelectionSha256, sentinel)
      ? { ...refusal, applied: true as const }
      : refusal;
  }
  // Readback follows every write (section 4.4): a write is not evidence of
  // its own effect.
  if (heldJournal.phase !== "maintenance-held") {
    return { status: "refuse", reason: "hold-entry-readback-mismatch" };
  }

  return captureUnderBarrier(input, heldJournal.generationId, heldJournal.checksumSha256, token, identity);
}

function wroteOwnEnteringHold(
  input: MigrationApplyThroughCaptureInput,
  generationId: string,
  sourceSelectionSha256: string,
  queueEvidenceSha256: string,
): boolean {
  const readJournal = input._operationsForTesting?.readJournal ?? readBackendMaintenanceJournal;
  try {
    const live = readJournal(input.homeDir);
    return live !== null
      && live.generationId === generationId
      && (live.phase === "maintenance-entering" || live.phase === "maintenance-held")
      && live.sourceSelectionSha256 === sourceSelectionSha256
      && live.queueEvidenceSha256 === queueEvidenceSha256;
  } catch {
    return true;
  }
}

/**
 * The `maintenance-entering` disposition path, run entirely outside any
 * barrier (module doc above): recover the hold on the coordinator's own
 * lock, read back the result, then acquire the append barrier only to wrap
 * capture.
 */
async function recoverEnteringThenCapture(
  input: MigrationApplyThroughCaptureInput,
  coordinator: BackendPublicationCoordinator,
  journal: BackendMaintenanceJournal,
  observedChecksumSha256: string,
): Promise<MigrationApplyThroughCaptureOutcome> {
  const classifyEnteringFailure = input._operationsForTesting?.classifyEnteringFailure ?? classifyEnteringRecoveryFailure;
  // The held identity read is lock-free (readProjectMapIdentity, a SELECT)
  // and must answer before the entering journal is promoted: a refusal here
  // leaves the journal maintenance-entering, so the next apply recovers it
  // again instead of continuing a hold this invocation wrote and then
  // reported as not applied.
  const identity = await resolveIdentityUnderBarrier(input, { path: "held" });
  if (identity.status === "refuse") return identity;
  let heldJournal: BackendMaintenanceJournal;
  try {
    heldJournal = await coordinator.enterMaintenance({
      publicationId: journal.publicationId,
      generationId: journal.generationId,
      sourceSelectionSha256: journal.sourceSelectionSha256,
      queueEvidenceSha256: journal.queueEvidenceSha256,
      roster: journal.roster,
      // Section 4.9 exposure 2: the CAS input carried from the
      // observation, never a freshly re-read checksum.
      expectedChecksumSha256: observedChecksumSha256,
    });
  } catch (error) {
    const classification = classifyEnteringFailure(error);
    if (classification.status !== "refuse") {
      // classifyEnteringRecoveryFailure only ever classifies a thrown
      // error, so its "recovered" variant is unreachable from a catch
      // block; this is a type-level guard, not a claim it happens.
      return { status: "refuse", reason: "entering-recovery-unclassified" };
    }
    return { status: "refuse", reason: `entering-recovery-${classification.class}`, evidence: classification.evidence };
  }
  if (heldJournal.phase !== "maintenance-held") {
    return { status: "refuse", reason: "hold-entry-readback-mismatch" };
  }
  return withBackendPublicationAppendBarrierAsync(
    input.homeDir,
    (token) => captureUnderBarrier(input, heldJournal.generationId, heldJournal.checksumSha256, token, identity),
  );
}

/**
 * Routes every non-`refuse`, non-`recover-entering` disposition reached
 * from inside an already-acquired barrier: `probe-fresh` (subject to the
 * section 4.6 abort gate) or `continue-held`.
 */
async function continueUnderBarrier(
  input: MigrationApplyThroughCaptureInput,
  coordinator: BackendPublicationCoordinator,
  manifestStore: MigrationManifestStore,
  journal: BackendMaintenanceJournal,
  disposition: MigrationHoldDisposition,
  token: BackendPublicationLockToken,
): Promise<MigrationApplyThroughCaptureOutcome> {
  if (disposition.action === "probe-fresh") {
    // Section 4.6: apply never probes for a fresh candidate while the
    // journal and manifest disagree. A terminal journal whose generation
    // has no manifest, or one whose manifest is already settled, is not a
    // disagreement; only a present-but-unsettled manifest is, and that is
    // `abort`'s or `resume`'s concern, never probed past here.
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
    return freshCutoverUnderBarrier(input, coordinator, manifestStore, token);
  }
  if (disposition.action === "continue-held") {
    // Round-1 A-7 (plan section 8): a held journal whose snapshot is partial
    // or replaced is immutable, unresumable evidence. Route it to abort here,
    // as exit 2, rather than letting capture refuse snapshot-partial and be
    // reported as an operator-required failure (exit 7).
    let snapshot: Awaited<ReturnType<typeof classifySqliteSnapshotArtifact>>;
    try {
      const classifySnapshot = input._operationsForTesting?.classifySnapshot ?? classifySqliteSnapshotArtifact;
      snapshot = await classifySnapshot(journal.generationId, { homeDir: input.homeDir });
    } catch (error) {
      return {
        status: "refuse",
        reason: "snapshot-unresolvable",
        evidence: error instanceof Error ? error.name : "unknown-snapshot-failure",
      };
    }
    if (snapshot.state === "partial" || snapshot.state === "replaced") {
      return { status: "refuse", reason: "continuation-partial-snapshot", evidence: `snapshot-${snapshot.state}` };
    }
    if (snapshot.state === "tampered") {
      // Plan section 8: tampered evidence is exit 5, preserved, and never
      // something capture is allowed to retry over.
      return { status: "refuse", reason: "continuation-snapshot-tampered", evidence: "snapshot-tampered" };
    }
    return captureUnderBarrier(input, journal.generationId, disposition.observedChecksumSha256, token);
  }
  // disposition.action is "recover-entering" or "refuse" here, and both are
  // unreachable from this call site in production: this function only runs
  // for a journal phase other than "maintenance-entering" (the caller
  // routes that phase to recoverEnteringThenCapture instead, before any
  // barrier is acquired), and resolveMigrationHoldContinuation only returns
  // "recover-entering" for that exact phase; "refuse" is already handled by
  // the caller before this function is ever invoked. Kept as a type-level
  // guard, proven by the _operationsForTesting seam, not a runtime claim.
  return { status: "refuse", reason: "continuation-unclassified" };
}

export async function performMigrationApplyThroughCapture(
  input: MigrationApplyThroughCaptureInput,
): Promise<MigrationApplyThroughCaptureOutcome> {
  const coordinator = input.coordinator
    ?? new BackendPublicationCoordinator({ homeDir: input.homeDir, driver: maintenanceOnlyDriver() });
  const manifestStore = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const resolveHoldContinuation = input._operationsForTesting?.resolveHoldContinuation ?? resolveMigrationHoldContinuation;
  const observeJournal = input._operationsForTesting?.observeJournal ?? observeMigrationMaintenanceJournal;

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
      (token) => freshCutoverUnderBarrier(input, coordinator, manifestStore, token),
    );
  }

  const journal = observation.journal;

  // Round-1 A-3/B-2, for a live (non-terminal) journal: the generation it
  // names is fixed, so the confirmed id is compared with it before anything
  // below can write.
  if (!isTerminalBackendMaintenancePhase(journal.phase) && journal.generationId !== input.confirmGenerationId) {
    return { status: "refuse", reason: "confirmation-generation-moved" };
  }

  if (journal.phase === "maintenance-entering") {
    // No protected read is needed, and none is possible: the append barrier
    // does not admit this phase (module doc above), and
    // resolveMigrationHoldContinuation ignores the candidate for it anyway,
    // always recovering unconditionally. The candidate passed here is
    // therefore built entirely from the journal's own fields, never from a
    // fresh authenticated read.
    const candidate: MigrationHoldCandidate = {
      publicationId: journal.publicationId,
      generationId: journal.generationId,
      sourceSelectionSha256: journal.sourceSelectionSha256,
      machineId: journal.roster[0]?.machineId ?? "",
    };
    const disposition = resolveHoldContinuation({ journal, candidate });
    if (disposition.action !== "recover-entering") {
      // Unreachable for a real "maintenance-entering" journal (see the type
      // guard note on continueUnderBarrier); proven by the seam, not by a
      // constructed real journal that cannot exist.
      return { status: "refuse", reason: "continuation-unclassified" };
    }
    return recoverEnteringThenCapture(input, coordinator, journal, disposition.observedChecksumSha256);
  }

  // Every other hold phase (maintenance-held, selection-prepared,
  // selection-completed, maintenance-aborted) is in the append barrier's
  // phase allowlist, and for maintenance-held specifically, classifying it
  // needs an authenticated read that is itself blocked without a token
  // (assertBackendPublicationConsumerAccessUnlocked refuses any
  // unauthenticated project-map read while a non-terminal hold exists), so
  // the barrier is acquired first and classification runs inside it.
  //
  // Why acquiring the barrier succeeds while a hold exists (round-1 A-6,
  // traced and proven by "re-applying against an already-held ..." in
  // apply.test.ts): withBackendPublicationAppendBarrierAsync runs its
  // admission with allowUnresolved: true (backend-publication.ts, the
  // runAppendAdmissionAttempt mode), and withBackendPublicationConsumerLockAsync
  // guards both of its assertBackendPublicationConsumerAccessUnlocked calls
  // with !options.allowUnresolved, so the consumer-access refusal that
  // blocks an ordinary consumer is skipped; the barrier's own phase
  // allowlist then admits maintenance-held.
  return withBackendPublicationAppendBarrierAsync(input.homeDir, async (token) => {
    const authority = authenticateSqliteMigrationSource(input.cwd, input.homeDir, token);
    const candidate: MigrationHoldCandidate = {
      publicationId: journal.publicationId,
      generationId: journal.generationId,
      sourceSelectionSha256: authority.sourceSelectionSha256,
      machineId: authority.machineIdentity.machineId,
    };
    const disposition = resolveHoldContinuation({ journal, candidate });
    if (disposition.action === "refuse") {
      return { status: "refuse", reason: `continuation-${disposition.reason}` };
    }
    return continueUnderBarrier(input, coordinator, manifestStore, journal, disposition, token);
  });
}
