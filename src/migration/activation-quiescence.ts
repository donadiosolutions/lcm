import {
  readBackendMaintenanceJournal,
  resolveBackendMaintenanceGenerationBinding,
  withBackendPublicationRetainedAppendAdmissionAsync,
  BackendPublicationJournalError,
  type BackendMaintenanceJournal,
  type BackendMaintenanceRosterEntry,
  type BackendPublicationRetainedAppendAdmissionOptions,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import { readMachineIdentity } from "../machine-identity.js";
import { canonicalJson, canonicalSha256 } from "../storage/portable-record.js";
import {
  attributeNullableRead,
  attributeNullableValue,
  type NullableReadClassification,
} from "./activation-absence.js";

/**
 * Writer-quiescence refusal for backend-selection activation.
 *
* Before activating a completed migration's backend selection, the caller
* must be able to show that no local SQLite writer is mid-operation for
* this installation. This module answers that question as a point-in-time
 * check performed while the caller already holds the local append barrier
 * -- the same
* .local-hook-append.lock mutex that every local hook-outbox append
 * serializes through (see withBackendPublicationAppendBarrierAsync and
 * withBackendPublicationRetainedAppendAdmissionAsync in
* storage/backend-publication.ts). That barrier is itself the single
* shared chokepoint every local SQLite writer funnels through (see
* withLcmConnectionLock in db/connection.ts, which every local hook
* outbox append acquires before touching a database file).
*
 * checkActivationWriterQuiescence requires the caller to pass the exact
 * lockToken of an already-active local append barrier (acquired via
 * withBackendPublicationAppendBarrierAsync or
 * withBackendPublicationRetainedAppendAdmissionAsync before calling this
 * function). It reuses that authority through
 * withBackendPublicationRetainedAppendAdmissionAsync's fast reuse path --
 * it never independently re-acquires or re-validates maintenance
 * readiness, because that would perform a second, separately-timed
 * maintenance-journal read outside this module's own attribution.
*
 * What this check does and does not prove, stated plainly because the
 * reach here is easy to overclaim, and every claim below is also recorded
 * in the quiescenceFence payload on a successful check rather than kept
 * only in this comment:
 *
 * - It binds local SQLite writers that funnel through the single shared
 *   local-append-barrier chokepoint. While this function holds that
 *   barrier, no local hook-outbox append can be in progress or start.
 * - It is a point check, not a window guarantee: the barrier is held only
 *   for the duration of this call. The instant it returns and the barrier
 *   is released, a new local writer may begin. A caller that needs a
 *   guarantee across a longer window must hold the barrier itself across
 *   that window and pass its lockToken in.
 * - It does not bind a raw sqlite3 session opened outside this process, a
 *   writer belonging to a different LCM build, another machine, or a
 *   direct psql session against a PostgreSQL target. None of those
 *   writers pass through this process's in-memory barrier at all.
 * - It does not close admitted local outbox appends that are already
 *   enqueued: an enqueue is a permitted local operation by contract, not
 *   a writer this check needs to fence.
 * - The roster it accepts is single-machine only. A maintenance journal
 *   whose roster spans more than one machine is refused outright: there
 *   is no remote-fencing primitive in this codebase, so this module does
 *   not attempt to assert quiescence for a writer on a machine it cannot
 *   observe.
 *
 * On success the result carries a quiescenceFence: an opaque evidence
 * envelope a caller can seal into its own replayable evidence chain. Its
 * payload records the reach described above (never more), the temporal
 * bound (observedAt), and the maintenance generation the check ran
 * against, so a later reader can tell exactly what was proven and when.
 */

export type ActivationQuiescenceStatus = "satisfied" | "unsatisfied" | "unresolvable";

export type ActivationQuiescenceReason =
  | "quiescence-observed"
  | "maintenance-journal-absent"
  | "maintenance-journal-unresolvable"
  | "maintenance-not-held"
  | "cutover-set-unsupported"
  | "cutover-set-absent"
  | "cutover-set-member-unbound"
  | "roster-not-single-machine"
  | "machine-identity-unavailable"
  | "roster-row-absent";

const QUIESCENCE_ENVELOPE_VERSION = 1 as const;
const QUIESCENCE_ENVELOPE_KIND = "lcm-activation-writer-quiescence-v1" as const;

/** Reach this check can honestly claim. Recorded verbatim in every
 * successful envelope's payload so a later reader never has to trust a
 * comment; see the module doc comment above for the full explanation of
 * each entry. */
const QUIESCENCE_REACH = Object.freeze({
  scope: "local-sqlite-writers-through-shared-append-barrier",
  pointCheck: true,
  admitsAlreadyEnqueuedLocalOutboxAppends: true,
  excludes: Object.freeze([
    "a raw sqlite3 session opened outside this process",
    "a writer belonging to a different LCM build",
    "another machine",
    "a direct psql session against a PostgreSQL target",
  ]),
} as const);

/** Opaque evidence envelope produced by a satisfied quiescence check.
 * payload is canonical JSON, opaque to the consuming schema; evidenceSha256
 * is a canonical digest over { version, kind, payload }. */
export type ActivationQuiescenceEvidenceEnvelope = Readonly<{
  version: typeof QUIESCENCE_ENVELOPE_VERSION;
  kind: typeof QUIESCENCE_ENVELOPE_KIND;
  payload: string;
  evidenceSha256: string;
}>;

/** Attributed three-valued verification result. Never collapse to boolean. */
export type ActivationQuiescenceResult = Readonly<{
  status: ActivationQuiescenceStatus;
  reason: ActivationQuiescenceReason;
  /** Human-readable attribution for the status; always populated. */
  detail: string;
  /** Populated only when status is "satisfied"; null otherwise. */
  quiescenceFence: ActivationQuiescenceEvidenceEnvelope | null;
}>;

export type ActivationQuiescenceInput = Readonly<{
  homeDir?: string;
  /** Required. The exact token of an already-active local append barrier,
   * acquired by the caller via withBackendPublicationAppendBarrierAsync or
   * withBackendPublicationRetainedAppendAdmissionAsync before calling this
   * function. This module never acquires that authority itself. */
  lockToken: BackendPublicationLockToken;
  /** Forwarded to the retained-admission reuse call. */
  admissionOptions?: BackendPublicationRetainedAppendAdmissionOptions;
}>;

export type ActivationQuiescenceDependencies = Readonly<{
  /** Override the current-time source used for the payload's temporal
   * bound (observedAt). Defaults to () => new Date(). */
  now?: () => Date;
  /** Override the maintenance-journal reader. Defaults to
   * readBackendMaintenanceJournal. The real reader already fails closed
   * for every non-ENOENT failure by throwing BackendPublicationJournalError
   * (never a different error type), so this override exists purely to
   * exercise this module's own defensive "unrecognized error propagates"
   * branch in classifyMaintenanceJournalRead -- a genuine fixture cannot
   * reach that branch through the real reader; see the test suite for the
   * explicit note on why injection is used there instead of a real fixture. */
  readMaintenanceJournal?: (homeDir?: string) => BackendMaintenanceJournal | null;
}>;

/** The set entry point's input: the member generation whose own binding view is fenced. */
export type CutoverSetActivationQuiescenceInput = ActivationQuiescenceInput & Readonly<{
  generationId: string;
}>;

function buildResult(
  status: ActivationQuiescenceStatus,
  reason: ActivationQuiescenceReason,
  detail: string,
  quiescenceFence: ActivationQuiescenceEvidenceEnvelope | null,
): ActivationQuiescenceResult {
  return Object.freeze({ status, reason, detail, quiescenceFence });
}

/**
 * Normalize an optional homeDir for the canonical-JSON payload, which
 * cannot encode undefined. Exported as a small pure function specifically
 * so its undefined-input branch can be unit-tested directly: exercising it
 * through the full check would require operating against the real ambient
 * home directory (the process's own homedir()), which this module's tests
 * must never do.
 */
export function normalizeHomeDirForPayload(homeDir: string | undefined): string | null {
  return homeDir ?? null;
}

/**
 * readBackendMaintenanceJournal already fails closed for anything other
 * than a genuinely missing journal (it throws BackendPublicationJournalError
 * for every other failure, including an unreadable file), so this
 * classifier only needs to recognize that error type. Any other thrown
 * error is a bug this module did not anticipate and must not attribute.
 */
function classifyMaintenanceJournalRead(error: unknown): NullableReadClassification | undefined {
  if (error instanceof BackendPublicationJournalError) {
    return {
      kind: "unresolvable",
      cause: `journal-${error.reason}`,
      detail: error.message,
    };
  }
  return undefined;
}

type QuiescencePayload = Readonly<{
  version: 1;
  homeDir: string | null;
  machineId: string;
  observedAt: string;
  generationId: string;
  maintenanceChecksumSha256: string;
  rosterRow: Readonly<{
    queueCutoff: string | null;
    evidenceSha256: string;
  }>;
  reach: typeof QUIESCENCE_REACH;
}>;

function sealQuiescenceEnvelope(payload: QuiescencePayload): ActivationQuiescenceEvidenceEnvelope {
  const canonicalPayload = canonicalJson(payload);
  const evidenceSha256 = canonicalSha256({
    version: QUIESCENCE_ENVELOPE_VERSION,
    kind: QUIESCENCE_ENVELOPE_KIND,
    payload: canonicalPayload,
  });
  return Object.freeze({
    version: QUIESCENCE_ENVELOPE_VERSION,
    kind: QUIESCENCE_ENVELOPE_KIND,
    payload: canonicalPayload,
    evidenceSha256,
  });
}

type HeldJournalRead =
  | Readonly<{ kind: "held"; journal: BackendMaintenanceJournal }>
  | Readonly<{ kind: "result"; result: ActivationQuiescenceResult }>;

/** The journal read and the held-phase check both entry points share, attributed identically. */
function readHeldJournal(
  homeDir: string | undefined,
  readMaintenanceJournal: (homeDir?: string) => BackendMaintenanceJournal | null,
): HeldJournalRead {
  const journalOutcome = attributeNullableRead(
    () => readMaintenanceJournal(homeDir),
    {
      whenNull: {
        cause: "not-found",
        detail: "no backend maintenance journal exists for this installation",
      },
      classifyError: classifyMaintenanceJournalRead,
    },
  );
  if (journalOutcome.kind === "unresolvable") {
    return { kind: "result", result: buildResult("unresolvable", "maintenance-journal-unresolvable", journalOutcome.detail, null) };
  }
  if (journalOutcome.kind === "absent") {
    return { kind: "result", result: buildResult("unsatisfied", "maintenance-journal-absent", journalOutcome.detail, null) };
  }
  const journal: BackendMaintenanceJournal = journalOutcome.value;

  if (journal.phase !== "maintenance-held") {
    return { kind: "result", result: buildResult(
      "unsatisfied",
      "maintenance-not-held",
      `the maintenance journal is in phase ${journal.phase}; writer quiescence is only attributable while maintenance is held (phase maintenance-held)`,
      null,
    ) };
  }
  return { kind: "held", journal };
}

type MachineIdRead =
  | Readonly<{ kind: "machine"; machineId: string }>
  | Readonly<{ kind: "result"; result: ActivationQuiescenceResult }>;

/** This machine's registered identity, attributed identically for both entry points. */
function readRegisteredMachineId(homeDir: string | undefined): MachineIdRead {
  const identityOutcome = attributeNullableRead(
    () => readMachineIdentity(homeDir),
    {
      whenNull: {
        cause: "not-registered",
        detail: "this machine has no registered machine identity",
      },
    },
  );
  if (identityOutcome.kind === "unresolvable") {
    return { kind: "result", result: buildResult("unresolvable", "machine-identity-unavailable", identityOutcome.detail, null) };
  }
  if (identityOutcome.kind === "absent") {
    return { kind: "result", result: buildResult("unresolvable", "machine-identity-unavailable", identityOutcome.detail, null) };
  }
  if (identityOutcome.value.machineId === null) {
    return { kind: "result", result: buildResult(
      "unresolvable",
      "machine-identity-unavailable",
      "this machine's identity registration is still pending; quiescence cannot be attributed to an unregistered machine",
      null,
    ) };
  }
  return { kind: "machine", machineId: identityOutcome.value.machineId };
}

/**
 * Assert local writer quiescence for the current installation and, on
 * success, seal a replayable quiescenceFence. See the module doc comment
 * above for the exact, deliberately limited reach of this assertion.
 */
export async function checkActivationWriterQuiescence(
  input: ActivationQuiescenceInput,
  dependencies: ActivationQuiescenceDependencies = {},
): Promise<ActivationQuiescenceResult> {
  const now = dependencies.now ?? ((): Date => new Date());
  const readMaintenanceJournal = dependencies.readMaintenanceJournal ?? readBackendMaintenanceJournal;
  return withBackendPublicationRetainedAppendAdmissionAsync(input.homeDir, (): ActivationQuiescenceResult => {
    const observedAt = now().toISOString();

    const held = readHeldJournal(input.homeDir, readMaintenanceJournal);
    if (held.kind === "result") return held.result;
    const journal = held.journal;

    if (journal.cutoverSet !== undefined) {
      return buildResult(
        "unsatisfied",
        "cutover-set-unsupported",
        "the maintenance journal binds a cutover set; set-aware writer quiescence is not defined yet, so this single-generation check refuses",
        null,
      );
    }

    if (journal.roster.length !== 1) {
      return buildResult(
        "unsatisfied",
        "roster-not-single-machine",
        `maintenance roster covers ${journal.roster.length} machine(s); this check only fences the local machine and refuses a multi-machine roster outright`,
        null,
      );
    }

    const machine = readRegisteredMachineId(input.homeDir);
    if (machine.kind === "result") return machine.result;
    const machineId: string = machine.machineId;

    const rosterRowOutcome = attributeNullableValue(
      journal.roster.find((row: BackendMaintenanceRosterEntry) => row.machineId === machineId),
      {
        cause: "not-in-roster",
        detail: `the maintenance roster does not cover this machine (${machineId})`,
      },
    );
    if (rosterRowOutcome.kind === "absent") {
      return buildResult("unsatisfied", "roster-row-absent", rosterRowOutcome.detail, null);
    }
    const rosterRow = rosterRowOutcome.value;

    const payload: QuiescencePayload = {
      version: 1,
      homeDir: normalizeHomeDirForPayload(input.homeDir),
      machineId,
      observedAt,
      generationId: journal.generationId,
      maintenanceChecksumSha256: journal.checksumSha256,
      rosterRow: { queueCutoff: rosterRow.queueCutoff, evidenceSha256: rosterRow.evidenceSha256 },
      reach: QUIESCENCE_REACH,
    };
    const quiescenceFence = sealQuiescenceEnvelope(payload);

    return buildResult(
      "satisfied",
      "quiescence-observed",
      `no local writer is active for machine ${machineId} under maintenance generation ${journal.generationId}`,
      quiescenceFence,
    );
  }, input.lockToken, input.admissionOptions);
}

/**
 * The set-aware counterpart (#1549): the same bounded point check over the
 * same shared append barrier, attributed to ONE member of the held cutover
 * set from that member's own binding view. The envelope names the member
 * generation, the member's held binding digest (not the aggregate journal
 * checksum) and the member's own captured cutoff row; the set's immutable
 * entry sentinel roster is never offered as a member cutoff, so a member
 * that was not captured under the hold is refused rather than fenced. The
 * single-generation check above is untouched: a set journal still refuses
 * there with cutover-set-unsupported.
 */
export async function checkCutoverSetActivationWriterQuiescence(
  input: CutoverSetActivationQuiescenceInput,
  dependencies: ActivationQuiescenceDependencies = {},
): Promise<ActivationQuiescenceResult> {
  const now = dependencies.now ?? ((): Date => new Date());
  const readMaintenanceJournal = dependencies.readMaintenanceJournal ?? readBackendMaintenanceJournal;
  return withBackendPublicationRetainedAppendAdmissionAsync(input.homeDir, (): ActivationQuiescenceResult => {
    const observedAt = now().toISOString();

    const held = readHeldJournal(input.homeDir, readMaintenanceJournal);
    if (held.kind === "result") return held.result;
    const journal = held.journal;

    if (journal.cutoverSet === undefined) {
      return buildResult(
        "unsatisfied",
        "cutover-set-absent",
        "the maintenance journal binds a single generation, not a cutover set; use the single-generation check",
        null,
      );
    }
    const view = resolveBackendMaintenanceGenerationBinding(journal, input.generationId);
    if (view === null) {
      return buildResult(
        "unsatisfied",
        "cutover-set-member-unbound",
        `generation ${input.generationId} is not a member of the held cutover set ${journal.generationId}`,
        null,
      );
    }

    const machine = readRegisteredMachineId(input.homeDir);
    if (machine.kind === "result") return machine.result;
    const machineId: string = machine.machineId;

    // A set member's roster is exactly one row of the set's machine (the set
    // parser refuses anything else), so only its machine and cutoff decide.
    const rosterRowOutcome = attributeNullableValue(
      view.roster.find((row: BackendMaintenanceRosterEntry) => row.machineId === machineId),
      {
        cause: "not-in-roster",
        detail: `the member's roster does not cover this machine (${machineId})`,
      },
    );
    if (rosterRowOutcome.kind === "absent") {
      return buildResult("unsatisfied", "roster-row-absent", rosterRowOutcome.detail, null);
    }
    const rosterRow = rosterRowOutcome.value;
    if (rosterRow.queueCutoff === null) {
      return buildResult(
        "unsatisfied",
        "cutover-set-member-unbound",
        `generation ${input.generationId} still carries the set's entry sentinel; it was not captured under this hold`,
        null,
      );
    }

    const payload: QuiescencePayload = {
      version: 1,
      homeDir: normalizeHomeDirForPayload(input.homeDir),
      machineId,
      observedAt,
      generationId: view.generationId,
      maintenanceChecksumSha256: view.checksumSha256,
      rosterRow: { queueCutoff: rosterRow.queueCutoff, evidenceSha256: rosterRow.evidenceSha256 },
      reach: QUIESCENCE_REACH,
    };
    const quiescenceFence = sealQuiescenceEnvelope(payload);

    return buildResult(
      "satisfied",
      "quiescence-observed",
      `no local writer is active for machine ${machineId} under cutover-set member generation ${view.generationId}`,
      quiescenceFence,
    );
  }, input.lockToken, input.admissionOptions);
}

