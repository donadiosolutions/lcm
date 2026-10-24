import {
  BackendPublicationCoordinator,
  backendPublicationCanonicalSha256,
  isTerminalBackendMaintenancePhase,
  readBackendMaintenanceJournal,
  type BackendMaintenanceJournal,
} from "../storage/backend-publication.js";
import { observeMigrationMaintenanceJournal } from "./journal-observation.js";
import {
  completePendingMigrationAbort,
  performMigrationAbort,
  classifyMigrationAbortRefusal,
  abortManifestGenerationIds,
} from "./abort.js";
import { admitExistingMigrationCommand, refuseUnlessConfirmed } from "./cli-existing.js";
import {
  refuseUnlessRouted,
  resolveExistingMigrationGeneration,
  type ExistingGenerationInput,
} from "./existing-generation.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { classifyMigrationRecovery, MigrationProtocolError } from "./protocol.js";
import { maintenanceOnlyDriver } from "./apply.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, withMigrationBoundary } from "./boundary.js";

/**
 * The `abort` command's CLI orchestration (section 3): observes the live
 * journal, mints the abort's own compare-and-swap evidence, drives the
 * single recovery-classifying `performMigrationAbort` operation, then
 * satisfies section 5.1's exit-0 postcondition -- "journal terminal and
 * manifest settled, both read back" -- by re-reading durable state rather
 * than trusting the operation's own return value.
 *
 * `abortEvidenceSha256`'s preimage (plan-v2's own named open question) is
 * `{version: 1, kind: "migration-abort-cli-request", generationId,
 * checksumSha256}`: a deterministic digest over the exact journal state
 * this invocation observed, following the same canonical-hashing
 * convention as `migrationQueueEvidenceSentinel`. Two different abort
 * invocations against the same journal state produce the same evidence
 * (idempotent, matching `performMigrationAbort`'s own idempotence); a
 * changed journal state produces different evidence.
 */

export type MigrationAbortCommandOutcome =
  | Readonly<{
    status: "ok";
    generationId: string;
    journalPhase: string;
    manifestPhase: string | null;
    /** False for `--dry-run` and for an idempotent repeat that found both writes already made. */
    applied: boolean;
  }>
  | Readonly<{
    status: "refuse";
    reason: string;
    evidence?: string;
    /** The live journal's generation, so a confirmation refusal tells the operator what to confirm. */
    generationId?: string;
    /** Present (true) only when a durable write preceded this refusal (round-1 A-2). */
    applied?: true;
    /** The command the router names as the way forward, when it names one. */
    next?: string | null;
  }>;

export type MigrationAbortCommandOperations = Readonly<{
  observeJournal: typeof observeMigrationMaintenanceJournal;
  performAbort: typeof performMigrationAbort;
  readJournal: typeof readBackendMaintenanceJournal;
  completePending: typeof completePendingMigrationAbort;
  admit: typeof admitExistingMigrationCommand;
}>;

function manifestProtocolEvidence(error: unknown): string {
  return error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error";
}

export type MigrationAbortCommandInput = Readonly<{
  homeDir: string;
  /**
   * The generation id of the live journal this invocation intends to abort
   * (plan section 9: `abort` confirms `--confirm-generation` against the
   * live journal's own generation id). Compared before anything is written.
   */
  confirmGenerationId?: string;
  /**
   * The explicit `--generation`. Absent means the journal's own generation:
   * abort acts on the journal, live or already terminal, so an idempotent
   * repeat needs no flag.
   */
  generation?: string;
  /** Run every read and classification, then stop before the first durable write. */
  dryRun?: boolean;
  /** @internal Test-only seam into the generation resolver. */
  _resolution?: Pick<ExistingGenerationInput, "manifestStore" | "_operationsForTesting">;
  coordinator?: BackendPublicationCoordinator;
  manifestStore?: MigrationManifestStore;
  now?: Date;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`.
   */
  _operationsForTesting?: Partial<MigrationAbortCommandOperations>;
}>;

export function performMigrationAbortCommand(input: MigrationAbortCommandInput): Promise<MigrationAbortCommandOutcome> {
  return withMigrationBoundary(
    () => runMigrationAbortCommand(input),
    // An unclassified throw cannot rule out that the journal or manifest write
    // had already happened, so applied is reported true.
    (evidence) => ({ status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence, applied: true }),
  );
}

async function runMigrationAbortCommand(input: MigrationAbortCommandInput): Promise<MigrationAbortCommandOutcome> {
  const observeJournal = input._operationsForTesting?.observeJournal ?? observeMigrationMaintenanceJournal;
  const performAbort = input._operationsForTesting?.performAbort ?? performMigrationAbort;
  const readJournal = input._operationsForTesting?.readJournal ?? readBackendMaintenanceJournal;
  const completePending = input._operationsForTesting?.completePending ?? completePendingMigrationAbort;
  const admit = input._operationsForTesting?.admit ?? admitExistingMigrationCommand;
  const coordinator = input.coordinator
    ?? new BackendPublicationCoordinator({ homeDir: input.homeDir, driver: maintenanceOnlyDriver() });
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });

  const observation = observeJournal({ homeDir: input.homeDir });
  if (observation.kind === "publication") {
    return { status: "refuse", reason: "publication-occupies-slot" };
  }
  if (observation.kind === "unresolvable") {
    return { status: "refuse", reason: "journal-unresolvable", evidence: observation.evidence };
  }
  if (observation.kind === "absent") {
    // Nothing to abort at all -- a distinct fact from an existing journal
    // in a non-abortable phase, which classifyMigrationAbortRefusal covers.
    return { status: "refuse", reason: "abort-nothing-to-abort" };
  }

  const journal: BackendMaintenanceJournal = observation.journal;

  // Plan-v5 Part B (1): the router decides whether abort may act on this
  // cell. The journal observed above is the one it routes, so the two reads
  // cannot disagree. Abort acts on the journal, so an omitted --generation
  // means the journal's own generation, live or already terminal.
  const admission = await admit({
    command: "abort",
    homeDir: input.homeDir,
    generation: input.generation ?? journal.generationId,
    resolution: {
      manifestStore: input._resolution?.manifestStore ?? store,
      _operationsForTesting: { ...input._resolution?._operationsForTesting, observeJournal: () => observation },
    },
  });
  if (admission.status === "refuse") return admission;
  const { context } = admission;

  // A terminal journal belongs to the generation that wrote it. A live hold
  // of another generation is router row 4, where abort is the owner and acts
  // on that live hold.
  if (isTerminalBackendMaintenancePhase(journal.phase) && context.generationId !== journal.generationId) {
    return { status: "refuse", reason: "abort-other-generation", generationId: journal.generationId };
  }

  // Section 9's fence: the token is compared against the generation of the
  // journal this invocation just observed, before any write. A missing and a
  // mismatched token are distinct facts with distinct reasons.
  const unconfirmed = refuseUnlessConfirmed({
    expectedGenerationId: journal.generationId,
    confirmGenerationId: input.confirmGenerationId,
    reasons: { missing: "abort-confirmation-missing", moved: "abort-confirmation-moved" },
  });
  if (unconfirmed !== null) return unconfirmed;

  const readback = (applied: boolean): MigrationAbortCommandOutcome =>
    readbackSettledAbort({ homeDir: input.homeDir, journal, store, readJournal, applied });

  // Row 5 (owner ruling R8): the journal is already maintenance-aborted and
  // the manifest is absent or aborted. Abort is a read-only confirmation:
  // nothing is written, and the settled pair is read back.
  // A set journal never has a manifest of its own, so row 5 is no evidence
  // about its members: it converges them before the readback (#1548 C8).
  if (context.route.row === 5 && journal.cutoverSet === undefined) return readback(false);

  // Row 6 (owner ruling R10): the journal is aborted and the manifest carries
  // the abort effect an earlier run began. Complete that carried effect; the
  // journal is never aborted a second time.
  if (context.route.row === 6) {
    const completion = completePending({
      homeDir: input.homeDir, journal, manifestStore: store, ...(input.dryRun === true ? { dryRun: true } : {}),
    });
    return finishAbort({ result: completion, journal, readback });
  }

  const result = await performAbort({
    homeDir: input.homeDir,
    coordinator,
    journal,
    abortEvidenceSha256: backendPublicationCanonicalSha256({
      version: 1,
      kind: "migration-abort-cli-request",
      generationId: journal.generationId,
      checksumSha256: journal.checksumSha256,
    }),
    manifestStore: store,
    now: input.now,
    dryRun: input.dryRun,
  });
  const outcome = finishAbort({ result, journal, readback });
  // A pending effect that appeared after the first route is classified again.
  // Only a single generation is re-routed: a set refusal names a member, and a
  // set journal has no manifest of its own to route.
  if (
    outcome.status === "refuse" && outcome.reason === "abort-manifest-needs-resume"
    && journal.cutoverSet === undefined
  ) {
    return rerouteLatePendingEffect({
      homeDir: input.homeDir, journal, outcome, observeJournal,
      manifestStore: input._resolution?.manifestStore ?? store,
      operations: input._resolution?._operationsForTesting,
    });
  }
  return outcome;
}

/**
 * Re-routes the journal's own generation (not the explicitly named one, which
 * router row 4 admits while abort acts on the live hold) from a fresh journal
 * observation, so the refusal names resume only when resume may run the late
 * effect and otherwise carries the router's own refusal.
 */
async function rerouteLatePendingEffect(input: Readonly<{
  homeDir: string;
  journal: BackendMaintenanceJournal;
  outcome: Extract<MigrationAbortCommandOutcome, { status: "refuse" }>;
  observeJournal: typeof observeMigrationMaintenanceJournal;
  manifestStore: MigrationManifestStore;
  operations: ExistingGenerationInput["_operationsForTesting"];
}>): Promise<MigrationAbortCommandOutcome> {
  const { journal, outcome } = input;
  const resolution = await resolveExistingMigrationGeneration({
    homeDir: input.homeDir,
    generation: journal.generationId,
    manifestStore: input.manifestStore,
    _operationsForTesting: { ...input.operations, observeJournal: input.observeJournal },
  });
  if (resolution.status === "refuse") return resolution;
  const { route } = resolution.context;
  if (refuseUnlessRouted("resume", route) === null) return outcome;
  const applied = outcome.applied === true ? { applied: true as const } : {};
  const refused = refuseUnlessRouted("abort", route);
  if (refused !== null) {
    return {
      status: "refuse", reason: refused.reason, evidence: outcome.evidence,
      generationId: journal.generationId, next: refused.next, ...applied,
    };
  }
  return {
    status: "refuse", reason: "abort-journal-moved", evidence: outcome.evidence,
    generationId: journal.generationId, ...applied,
  };
}

function finishAbort(input: Readonly<{
  result: Awaited<ReturnType<typeof performMigrationAbort>>;
  journal: BackendMaintenanceJournal;
  readback: (applied: boolean) => MigrationAbortCommandOutcome;
}>): MigrationAbortCommandOutcome {
  const { result, journal } = input;
  if (result.status === "refuse") {
    const classified = classifyMigrationAbortRefusal(result.evidence);
    return {
      status: "refuse",
      reason: classified.reason,
      // The reason is classified from the bare evidence; a set refusal then names the member it concerns.
      evidence: result.member === undefined ? result.evidence : `${result.member}:${result.evidence}`,
      ...(result.mutated ? { applied: true as const } : {}),
      // A pending copy effect that began after routing is resume's: abort names it.
      ...(classified.reason === "abort-manifest-needs-resume" ? { next: "resume" } : {}),
    };
  }
  if (result.status === "dry-run") {
    // Nothing was written, so there is nothing to read back: report the state
    // the real run would act on.
    return {
      status: "ok",
      generationId: journal.generationId,
      journalPhase: journal.phase,
      manifestPhase: null,
      applied: false,
    };
  }
  // Section 5.1's exit-0 postcondition: read back, never trust the
  // operation's own "completed" claim as the readback itself. A readback
  // refusal follows the operation's writes, so it carries their `applied`.
  return input.readback(result.mutated);
}

function readbackSettledAbort(input: Readonly<{
  homeDir: string;
  journal: BackendMaintenanceJournal;
  store: MigrationManifestStore;
  readJournal: typeof readBackendMaintenanceJournal;
  applied: boolean;
}>): MigrationAbortCommandOutcome {
  const { journal, store, applied } = input;
  const readbackRefusal = (reason: string, evidence?: string): MigrationAbortCommandOutcome => ({
    status: "refuse",
    reason,
    ...(evidence === undefined ? {} : { evidence }),
    ...(applied ? { applied: true as const } : {}),
  });
  const finalJournal = input.readJournal(input.homeDir);
  // The postcondition is this generation's aborted journal, read back. Any
  // other terminal journal (a later generation that entered and settled
  // between the write and this read, or a completed selection) is not
  // evidence that this abort took effect.
  if (finalJournal === null || finalJournal.phase !== "maintenance-aborted" || finalJournal.generationId !== journal.generationId) {
    return readbackRefusal("abort-readback-mismatch");
  }

  // Every generation the journal settles (its own, or each set member) must be
  // absent or settled with no pending effect.
  const phases = new Set<string>();
  for (const generationId of abortManifestGenerationIds(journal)) {
    const presence = store.probeManifestPresence(generationId);
    if (presence.status === "unresolvable") {
      return readbackRefusal("abort-unresolvable", `manifest-${presence.reason}`);
    }
    // Genuinely absent is a legitimate terminal state (aborted before
    // capture ever reached genesis), not a readback failure.
    if (presence.status === "absent") continue;
    let manifest;
    try {
      manifest = store.read(generationId);
    } catch (error) {
      return readbackRefusal("abort-unresolvable", manifestProtocolEvidence(error));
    }
    const recovery = classifyMigrationRecovery(manifest);
    if (recovery.action !== "settled") {
      // performMigrationAbort itself would not have reported "completed"
      // with an unsettled manifest, so this is a genuine readback
      // disagreement rather than an expected state.
      return readbackRefusal("abort-readback-mismatch");
    }
    phases.add(recovery.phase);
  }
  return {
    status: "ok",
    generationId: journal.generationId,
    journalPhase: finalJournal.phase,
    manifestPhase: phases.size === 0 ? null : [...phases].sort().join(","),
    applied,
  };
}

