import {
  backendPublicationCanonicalSha256,
  isTerminalBackendMaintenancePhase,
  type BackendMaintenanceJournal,
} from "../storage/backend-publication.js";
import { unexpectedFailureEvidence } from "./boundary.js";
import { readVerifiedEvidence } from "./cli-verify.js";
import { readCutoverSetActivationRecords, type CutoverSetActivationRecords } from "./cutover-set-activation-store.js";
import {
  deriveCutoverSetRollbackSetId,
  readCutoverSetRollbackRecords,
  type CutoverSetRollbackRecords,
} from "./cutover-set-rollback-store.js";
import type { MigrationEvidence } from "./envelope.js";
import { observeMigrationMaintenanceJournal, type MigrationJournalObservation } from "./journal-observation.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { classifyMigrationRecovery } from "./protocol.js";
import { classifySqliteSnapshotArtifact } from "./sqlite-snapshot.js";
import { MigrationVerificationReportStore } from "./verification-store.js";

/**
 * The small read-only state the `--set` commands share (#1551): the selected
 * aggregate id, the live journal, the two aggregate record stores and the
 * member manifests and snapshots, and the one routing decision derived from
 * them. Nothing here writes, takes a lease or lock the readers do not take,
 * scans a store, or invokes a service; the services stay the authority for
 * every mutation. A route names the service that owns the observed state, and
 * an observation that cannot be read is `unresolvable`, never absence.
 */

/** The aggregate id grammar the set services validate. */
const SET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type SetSelection =
  | Readonly<{ status: "selected"; setId: string }>
  | Readonly<{ status: "refuse"; reason: "set-generation-required" | "set-generation-invalid" }>;

/** The explicit original set id; an existing-set command never infers it from a store scan. */
export function selectSet(generation: string | undefined): SetSelection {
  if (generation === undefined) return { status: "refuse", reason: "set-generation-required" };
  if (!SET_ID_PATTERN.test(generation)) return { status: "refuse", reason: "set-generation-invalid" };
  return { status: "selected", setId: generation };
}

export const SET_CONFIRMATION_REASONS = Object.freeze({
  missing: "set-confirmation-missing",
  moved: "set-confirmation-moved",
});

export type SetMember = Readonly<{
  index: number;
  physicalProjectId: string | null;
  generationId: string;
  /** The manifest phase, or absent / unresolvable. */
  manifest: string;
  pending: string | null;
  revision: number | null;
  /** The manifest is settled (active, rolled-back or aborted with nothing pending). */
  settled: boolean;
  /** Observed only while a forward hold prepares the set. */
  snapshot: string | null;
  /** Verified, nothing pending and an eligible persisted report. */
  eligible: boolean;
  /** A closed marker when the member's own evidence could not be read; null for any legitimate state. */
  evidenceFailure: string | null;
}>;

export type SetRoute =
  /** No journal and no record names the set. */
  | "unknown"
  | "unresolvable"
  /** A forward hold whose members still need preparation. */
  | "prepare"
  /** A forward hold with every member verified; activation admits it. */
  | "prepared"
  /** Activation records (and no rollback) exist: activation or its settlement owns the set. */
  | "activate"
  /** A rollback commitment exists. */
  | "rollback"
  /** An aborted forward hold with unsettled members. */
  | "abort"
  | "settled-activated"
  | "settled-rolled-back"
  | "settled-aborted"
  | "single-generation-held"
  | "foreign"
  /** The id names a rollback hold or publication, not an original set. */
  | "reverse-id"
  | "contradiction";

export type SetPrepareBlock = Readonly<{
  reason: string;
  bucket: "precondition" | "evidence";
}>;

export type SetObservation = Readonly<{
  setId: string;
  rollbackSetId: string;
  journal: MigrationJournalObservation;
  activation: CutoverSetActivationRecords;
  rollback: CutoverSetRollbackRecords;
  members: readonly SetMember[];
  route: SetRoute;
  /** Why a preparation cannot continue, when the observed members prove it. */
  prepareBlock: SetPrepareBlock | null;
}>;

export type SetObservationOperations = Readonly<{
  observeJournal: typeof observeMigrationMaintenanceJournal;
  readActivation: typeof readCutoverSetActivationRecords;
  readRollback: typeof readCutoverSetRollbackRecords;
  classifySnapshot: typeof classifySqliteSnapshotArtifact;
  readVerified: typeof readVerifiedEvidence;
}>;

export type SetObservationInput = Readonly<{
  homeDir: string;
  setId: string;
  manifestStore?: MigrationManifestStore;
  reportStore?: MigrationVerificationReportStore;
  _operationsForTesting?: Partial<SetObservationOperations>;
}>;

type Relation =
  | "none" | "forward" | "reverse-hold" | "rollback" | "single" | "foreign"
  | "publication-forward" | "publication-rollback" | "publication-foreign";

function relationOf(journal: MigrationJournalObservation, setId: string, rollbackSetId: string): Relation {
  if (journal.kind === "absent" || journal.kind === "unresolvable") return "none";
  if (journal.kind === "publication") {
    if (journal.publicationId === setId) return "publication-forward";
    return journal.publicationId === rollbackSetId ? "publication-rollback" : "publication-foreign";
  }
  const { journal: hold } = journal;
  if (hold.cutoverSet === undefined) return "single";
  if (hold.cutoverSet.manifest.setId === setId) return hold.sourceBackend === "sqlite" ? "forward" : "reverse-hold";
  return hold.cutoverSet.manifest.setId === rollbackSetId ? "rollback" : "foreign";
}

function memberRefs(
  hold: BackendMaintenanceJournal | null,
  activation: CutoverSetActivationRecords,
  rollback: CutoverSetRollbackRecords,
): readonly Readonly<{ physicalProjectId: string; generationId: string }>[] {
  if (hold !== null) return hold.cutoverSet!.manifest.members;
  if (activation.state === "resolved") return activation.checkpoint.members;
  if (rollback.state === "resolved") return rollback.checkpoint.members;
  return [];
}

async function observeMember(
  input: SetObservationInput,
  ops: Partial<SetObservationOperations>,
  store: MigrationManifestStore,
  reportStore: MigrationVerificationReportStore,
  ref: Readonly<{ physicalProjectId: string; generationId: string }>,
  index: number,
  withSnapshot: boolean,
): Promise<SetMember> {
  const { generationId } = ref;
  let manifest = "absent";
  let pending: string | null = null;
  let revision: number | null = null;
  let settled = false;
  try {
    const presence = store.probeManifestPresence(generationId);
    if (presence.status === "unresolvable") {
      manifest = "unresolvable";
    } else if (presence.status === "present") {
      const head = store.read(generationId);
      manifest = head.phase;
      pending = head.pendingEffect?.kind ?? null;
      revision = head.revision;
      settled = classifyMigrationRecovery(head).action === "settled";
    }
  } catch {
    manifest = "unresolvable";
  }
  let snapshot: string | null = null;
  if (withSnapshot) {
    try {
      snapshot = (await (ops.classifySnapshot ?? classifySqliteSnapshotArtifact)(generationId, { homeDir: input.homeDir })).state;
    } catch {
      snapshot = "unresolvable";
    }
  }
  let eligible = false;
  if (manifest === "verified" && pending === null) {
    try {
      eligible = (ops.readVerified ?? readVerifiedEvidence)(generationId, store, reportStore, null).status === "verified";
    } catch {
      eligible = false;
    }
  }
  // A verified manifest always names an eligible persisted report, so a refusal reading it is lost evidence.
  const evidenceFailure = manifest === "unresolvable" ? "manifest-unresolvable"
    : snapshot === "unresolvable" ? "snapshot-unresolvable"
      : manifest === "verified" && pending === null && !eligible ? "verification-evidence" : null;
  return { index, physicalProjectId: ref.physicalProjectId, generationId, manifest, pending, revision, settled, snapshot, eligible, evidenceFailure };
}

function prepareBlockOf(members: readonly SetMember[]): SetPrepareBlock | null {
  const blocks: SetPrepareBlock[] = [];
  for (const member of members) {
    if (member.manifest === "unresolvable") blocks.push({ reason: "manifest-unresolvable", bucket: "evidence" });
    if (member.snapshot === "unresolvable") blocks.push({ reason: "member-snapshot-unresolvable", bucket: "evidence" });
    if (member.snapshot === "tampered") blocks.push({ reason: "member-snapshot-tampered", bucket: "evidence" });
    if (member.snapshot === "partial" || member.snapshot === "replaced") {
      blocks.push({ reason: "member-snapshot-partial", bucket: "precondition" });
    }
    // A manifest beside an absent snapshot is unresumable evidence (capture precedes genesis).
    if (member.snapshot === "absent" && member.manifest !== "absent" && member.manifest !== "unresolvable") {
      blocks.push({ reason: "member-snapshot-absent", bucket: "evidence" });
    }
  }
  return blocks.find((block) => block.bucket === "evidence") ?? blocks[0] ?? null;
}

function decideRoute(
  relation: Relation,
  journal: MigrationJournalObservation,
  activation: CutoverSetActivationRecords,
  rollback: CutoverSetRollbackRecords,
  members: readonly SetMember[],
): SetRoute {
  if (journal.kind === "unresolvable" || activation.state === "unresolvable" || rollback.state === "unresolvable") {
    return "unresolvable";
  }
  if (members.some((member) => member.manifest === "unresolvable") && relation !== "forward") return "unresolvable";
  const all = (phase: string): boolean => members.length > 0 && members.every((member) => member.manifest === phase && member.pending === null);
  // A settlement is terminal only with the frozen selection that produced it.
  if (rollback.state === "resolved") {
    if (all("rolled-back")) return rollback.selection === null ? "contradiction" : "settled-rolled-back";
    return "rollback";
  }
  if (activation.state === "resolved") {
    if (relation === "rollback" || relation === "publication-rollback") return "contradiction";
    if (all("active")) return activation.selection === null ? "contradiction" : "settled-activated";
    return "activate";
  }
  // The set id names a rollback hold or publication (the reverse id), never the original set.
  if (relation === "reverse-hold" || relation === "publication-forward") return "reverse-id";
  if (relation === "forward") {
    const hold = (journal as Extract<MigrationJournalObservation, { kind: "hold" }>).journal;
    if (hold.phase === "maintenance-entering") return "prepare";
    if (hold.phase === "maintenance-held") {
      return members.length > 0 && members.every((member) => member.eligible && member.snapshot === "complete")
        ? "prepared" : "prepare";
    }
    if (hold.phase === "maintenance-aborted") {
      return members.every((member) => member.manifest === "absent" || (member.settled && member.pending === null))
        ? "settled-aborted" : "abort";
    }
    return "contradiction";
  }
  if (relation === "single") return "single-generation-held";
  if (relation === "rollback" || relation === "publication-rollback") return "contradiction";
  if (relation === "foreign" || relation === "publication-foreign") return "foreign";
  return "unknown";
}

/** Every read the shared route needs, in one lock-free pass; a failed read is unresolvable, never absence. */
export async function observeSet(input: SetObservationInput): Promise<SetObservation> {
  const ops = input._operationsForTesting ?? {};
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const reportStore = input.reportStore ?? new MigrationVerificationReportStore({ homeDir: input.homeDir });
  const rollbackSetId = deriveCutoverSetRollbackSetId(input.setId);
  const journal = (ops.observeJournal ?? observeMigrationMaintenanceJournal)({ homeDir: input.homeDir });
  const unresolvable = (error: unknown): { state: "unresolvable"; reason: string } =>
    ({ state: "unresolvable", reason: unexpectedFailureEvidence(error) });
  let activation: CutoverSetActivationRecords;
  try {
    activation = (ops.readActivation ?? readCutoverSetActivationRecords)({ homeDir: input.homeDir, setId: input.setId });
  } catch (error) {
    activation = unresolvable(error);
  }
  let rollback: CutoverSetRollbackRecords;
  try {
    rollback = (ops.readRollback ?? readCutoverSetRollbackRecords)({ homeDir: input.homeDir, originalSetId: input.setId });
  } catch (error) {
    rollback = unresolvable(error);
  }
  const relation = relationOf(journal, input.setId, rollbackSetId);
  const hold = relation === "forward" ? (journal as Extract<MigrationJournalObservation, { kind: "hold" }>).journal : null;
  const withSnapshot = hold !== null && !isTerminalBackendMaintenancePhase(hold.phase);
  const members = await Promise.all(memberRefs(hold, activation, rollback).map((ref, index) =>
    observeMember(input, ops, store, reportStore, ref, index, withSnapshot)));
  return {
    setId: input.setId,
    rollbackSetId,
    journal,
    activation,
    rollback,
    members,
    route: decideRoute(relation, journal, activation, rollback, members),
    prepareBlock: withSnapshot ? prepareBlockOf(members) : null,
  };
}

/** The command that owns each route, as the `next` an operator should run. */
export function nextForRoute(route: SetRoute): string | null {
  switch (route) {
    case "prepare": case "activate": case "rollback": case "abort": return "resume --set";
    case "prepared": return "activate --set";
    case "settled-aborted": case "unknown": return "plan --set";
    default: return null;
  }
}

const CLOSED_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/** A service-supplied token is emitted only when it is a short closed identifier; anything else never discloses. */
export function closedToken(value: string | null | undefined): string {
  return typeof value === "string" && CLOSED_TOKEN.test(value) ? value : "unrecognized";
}

/** One flattened row. Indexes are in manifest order; the envelope sorts keys lexically, so consumers sort them numerically. */
export type SetEvidenceRow = Readonly<{
  projectId?: string | null;
  generationId?: string | null;
  state: string;
  pending?: string | null;
  snapshot?: string | null;
  reason?: string | null;
  mode?: string | null;
  installedGenerationId?: string | null;
}>;

export function setRowsEvidence(rows: readonly SetEvidenceRow[]): MigrationEvidence {
  const evidence: Record<string, string | number | boolean | null> = {};
  rows.forEach((row, index) => {
    const key = (field: string): string => `member.${String(index)}.${field}`;
    if (row.projectId !== undefined && row.projectId !== null) evidence[key("projectId")] = row.projectId;
    if (row.generationId !== undefined && row.generationId !== null) evidence[key("generationId")] = row.generationId;
    evidence[key("state")] = row.state;
    if (row.pending !== undefined && row.pending !== null) evidence[key("pending")] = row.pending;
    if (row.snapshot !== undefined && row.snapshot !== null) evidence[key("snapshot")] = row.snapshot;
    if (row.reason !== undefined && row.reason !== null) evidence[key("reason")] = closedToken(row.reason);
    if (row.mode !== undefined && row.mode !== null) evidence[key("mode")] = row.mode;
    if (row.installedGenerationId !== undefined && row.installedGenerationId !== null) {
      evidence[key("installedGenerationId")] = row.installedGenerationId;
    }
  });
  return evidence;
}

/** The observed members as evidence rows. */
export function observedRows(observation: SetObservation): readonly SetEvidenceRow[] {
  return observation.members.map((member) => ({
    projectId: member.physicalProjectId,
    generationId: member.generationId,
    state: member.manifest,
    pending: member.pending,
    snapshot: member.snapshot,
    reason: member.evidenceFailure,
  }));
}

/**
 * Whether the durable state read after a service returned still admits that
 * same service to continue, which is what exit 6 claims. A record naming the
 * service is not enough: the journal slot must still hold the set's own live
 * (not aborted) hold, or its own publication carrying the frozen selection.
 * A hold in a selection phase counts only with that selection too: both
 * services answer it with state-unresolvable when the record is absent.
 * This under-claims where admission cannot be shown without mirroring the
 * service's slot table; the service stays the authority for every mutation.
 */
export function admitsResume(observation: SetObservation, service: "prepare" | "activate" | "rollback"): boolean {
  const { journal } = observation;
  const live = (id: string, phases: readonly string[]): boolean =>
    journal.kind === "hold" && journal.journal.cutoverSet?.manifest.setId === id && phases.includes(journal.journal.phase);
  const published = (id: string): boolean => journal.kind === "publication" && journal.publicationId === id;
  const selected = service === "activate"
    ? observation.activation.state === "resolved" && observation.activation.selection !== null
    : observation.rollback.state === "resolved" && observation.rollback.selection !== null;
  const selectionPhases = selected ? ["selection-prepared", "selection-completed"] : [];
  if (service === "prepare") return observation.route === "prepare" && observation.prepareBlock === null;
  if (service === "activate") {
    if (observation.route === "prepared") return true;
    return observation.route === "activate" && (
      live(observation.setId, ["maintenance-held", ...selectionPhases])
      || (published(observation.setId) && selected)
    );
  }
  return observation.route === "rollback" && (
    live(observation.rollbackSetId, ["maintenance-entering", "maintenance-held", ...selectionPhases])
    || (published(observation.rollbackSetId) && selected)
  );
}

export function journalSections(journal: MigrationJournalObservation): MigrationEvidence {
  if (journal.kind === "hold") return { journalKind: "hold", journalPhase: journal.journal.phase, journalGeneration: journal.journal.generationId };
  if (journal.kind === "publication") return { journalKind: "publication", journalPhase: journal.phase, journalGeneration: journal.publicationId };
  return { journalKind: journal.kind };
}

/** The evidence every set envelope carries: scope, ids, count and state. */
export function setSections(observation: SetObservation, extra: MigrationEvidence = {}): MigrationEvidence {
  return {
    scope: "cutover-set",
    setId: observation.setId,
    rollbackSetId: observation.rollbackSetId,
    memberCount: observation.members.length,
    setState: observation.route,
    ...extra,
  };
}

/**
 * A digest of everything a set command can move: the journal slot, the two
 * aggregate stores and the named members' manifest heads. A mutating command
 * compares it before and after; a read that cannot be made is "unresolvable",
 * and the caller then reports a write conservatively.
 */
export async function setWriteFingerprint(
  input: Readonly<{ homeDir: string; setId: string; generationIds: readonly string[]; manifestStore?: MigrationManifestStore }>,
  ops: Partial<SetObservationOperations> = {},
): Promise<string> {
  const observation = await observeSet({
    homeDir: input.homeDir,
    setId: input.setId,
    ...(input.manifestStore === undefined ? {} : { manifestStore: input.manifestStore }),
    _operationsForTesting: { ...ops, classifySnapshot: async () => ({ state: "absent" }), readVerified: () => ({ status: "refuse" } as never) },
  });
  if (observation.route === "unresolvable") return "unresolvable";
  const store = new MigrationManifestStore({ homeDir: input.homeDir });
  const heads = input.generationIds.map((generationId) => {
    try {
      const presence = store.probeManifestPresence(generationId);
      if (presence.status !== "present") return presence.status;
      return store.read(generationId).revision;
    } catch {
      return "unresolvable";
    }
  });
  if (heads.includes("unresolvable")) return "unresolvable";
  const journal = observation.journal;
  return backendPublicationCanonicalSha256({
    journal: journal.kind === "hold"
      ? { phase: journal.journal.phase, checksum: journal.journal.checksumSha256 }
      : journal.kind === "publication" ? { id: journal.publicationId, phase: journal.phase } : { kind: journal.kind },
    activation: observation.activation.state === "resolved"
      ? { checkpoint: observation.activation.checkpoint.checksumSha256, selected: observation.activation.selection !== null }
      : observation.activation.state,
    rollback: observation.rollback.state === "resolved"
      ? {
        checkpoint: observation.rollback.checkpoint.checksumSha256, installs: observation.rollback.installs.size,
        selected: observation.rollback.selection !== null,
      }
      : observation.rollback,
    heads,
  });
}
