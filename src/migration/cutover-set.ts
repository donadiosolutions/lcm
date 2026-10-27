import {
  backendCutoverSetEntryRoster,
  backendCutoverSetJournalCapacity,
  backendCutoverSetManifestSha256,
  backendCutoverSetQueueEvidenceSha256,
  backendMaintenanceQueueEvidenceSentinel,
  parseBackendCutoverSetManifest,
  type BackendCutoverSet,
  type BackendCutoverSetManifest,
  type BackendCutoverSetMember,
  type EnterBackendMaintenanceInput,
} from "../storage/backend-publication.js";
import type { StoredDataProjectEnumerationReason } from "./activation-coverage.js";
import type { AuthenticatedSqliteSnapshotAuthority } from "./sqlite-snapshot.js";

/**
 * The cutover-set contract (#1547): one versioned manifest naming every
 * project with stored data in a home, the all-or-nothing refusal rules, and
 * the pure selection decision later children enforce. Nothing here performs
 * I/O; the strict manifest validator lives in storage and is shared.
 */

export type CutoverSetManifest = BackendCutoverSetManifest;
export type CutoverSetMember = BackendCutoverSetMember;
export {
  parseBackendCutoverSetManifest as parseCutoverSetManifest,
  backendCutoverSetManifestSha256 as cutoverSetManifestSha256,
} from "../storage/backend-publication.js";

export type CutoverSetBuildRefusalReason =
  | "cutover-set-enumeration-unresolvable"
  | "cutover-set-single-project"
  | "cutover-set-uncovered-member"
  | "cutover-set-member-unverifiable"
  | "cutover-set-incomplete"
  | "cutover-set-unknown-member"
  | "cutover-set-member-not-local"
  | "cutover-set-machine-mismatch"
  | "cutover-set-duplicate-generation"
  | "cutover-set-too-large";

export type CutoverSetCaptureRefusalReason =
  | "cutover-set-enumeration-unresolvable"
  | "cutover-set-membership-drift"
  | "cutover-set-member-unbound";

export type CutoverSetSelectionRefusalReason =
  | "cutover-set-member-evidence-stale"
  | "cutover-set-member-evidence-drifted"
  | "cutover-set-member-evidence-unverifiable"
  | "cutover-set-member-evidence-absent"
  | "cutover-set-evidence-extra-member"
  | "cutover-set-evidence-duplicate-member"
  | "cutover-set-evidence-identity-mismatch";

export type CutoverSetRefusalReason =
  | CutoverSetBuildRefusalReason
  | CutoverSetCaptureRefusalReason
  | CutoverSetSelectionRefusalReason;

/** A member capture refusal with a closed reason; callers never parse the message. */
export class CutoverSetCaptureError extends Error {
  constructor(
    readonly reason: CutoverSetCaptureRefusalReason,
    detail: string,
    readonly projects: readonly string[] = [],
  ) {
    super(`${reason}: ${detail}`);
    this.name = "CutoverSetCaptureError";
  }
}

/** The pre-entry authority outcome for one stored-data project. */
export type CutoverSetMemberAuthorityOutcome = Readonly<
  | { physicalProjectId: string; status: "authenticated"; authority: AuthenticatedSqliteSnapshotAuthority }
  | { physicalProjectId: string; status: "uncovered"; detail: string }
  | { physicalProjectId: string; status: "unverifiable"; detail: string }
>;

export type CutoverSetMemberAuthorityResolution = Readonly<
  | { status: "resolved"; outcomes: readonly CutoverSetMemberAuthorityOutcome[] }
  | { status: "unresolvable"; reason: StoredDataProjectEnumerationReason; detail: string }
>;

/** The `enterMaintenance` input of a set hold: unbound sentinel bindings and set-derived top-level fields. */
export type CutoverSetMaintenanceEntry = Readonly<
  Pick<EnterBackendMaintenanceInput, "publicationId" | "generationId" | "sourceSelectionSha256" | "queueEvidenceSha256" | "roster">
  & { cutoverSet: BackendCutoverSet }
>;

export function cutoverSetMaintenanceEntry(manifest: CutoverSetManifest): CutoverSetMaintenanceEntry {
  const sourceSelectionSha256 = backendCutoverSetManifestSha256(manifest);
  const bindings = manifest.members.map((member) => {
    const sentinel = backendMaintenanceQueueEvidenceSentinel({
      generationId: member.generationId,
      sourceSelectionSha256: member.sourceSelectionSha256,
    });
    return {
      generationId: member.generationId,
      queueEvidenceSha256: sentinel,
      roster: [{ machineId: manifest.machineId, queueCutoff: null, evidenceSha256: sentinel }],
    };
  });
  return {
    publicationId: manifest.setId,
    generationId: manifest.setId,
    sourceSelectionSha256,
    queueEvidenceSha256: backendCutoverSetQueueEvidenceSha256(bindings),
    roster: backendCutoverSetEntryRoster(manifest),
    cutoverSet: { manifest, bindings },
  };
}

export type BuildCutoverSetInput = Readonly<{
  setId: string;
  machineId: string;
  resolution: CutoverSetMemberAuthorityResolution;
  /** The generation id allocated to each stored-data project (allocation is the caller's). */
  generationIds: ReadonlyMap<string, string>;
}>;

export type CutoverSetBuildResult = Readonly<
  | {
    status: "built";
    manifest: CutoverSetManifest;
    manifestSha256: string;
    entry: CutoverSetMaintenanceEntry;
  }
  | {
    status: "refused";
    reason: CutoverSetBuildRefusalReason;
    detail: string;
    /** Every project the refusal names, sorted. */
    projects: readonly string[];
  }
>;

function refused(
  reason: CutoverSetBuildRefusalReason,
  detail: string,
  projects: readonly string[],
): CutoverSetBuildResult {
  return { status: "refused", reason, detail, projects: [...projects].sort() };
}

/**
 * Build the manifest from the exact stored-data project set and the
 * per-project authority outcomes, or refuse the whole set. A home with fewer
 * than two stored-data projects is not a set. Malformed identifiers throw.
 */
export function buildCutoverSetManifest(input: BuildCutoverSetInput): CutoverSetBuildResult {
  const { resolution } = input;
  if (resolution.status === "unresolvable") {
    return refused("cutover-set-enumeration-unresolvable", `${resolution.reason}: ${resolution.detail}`, []);
  }
  const outcomes = [...resolution.outcomes].sort((left, right) =>
    left.physicalProjectId < right.physicalProjectId ? -1 : 1);
  const hashes = outcomes.map((outcome) => outcome.physicalProjectId);
  if (outcomes.length < 2) {
    return refused(
      "cutover-set-single-project",
      `${outcomes.length} stored-data project(s); use the single-generation path`,
      hashes,
    );
  }
  // An authenticated outcome whose authority names another project is uncovered: it must never be built
  // into a member under the wrong project.
  const uncovered = outcomes.flatMap((outcome) => {
    if (outcome.status === "uncovered") return [{ project: outcome.physicalProjectId, detail: outcome.detail }];
    return outcome.status === "authenticated" && outcome.authority.physicalProjectId !== outcome.physicalProjectId
      ? [{ project: outcome.physicalProjectId, detail: `authority belongs to project ${outcome.authority.physicalProjectId}` }]
      : [];
  });
  if (uncovered.length > 0) {
    return refused(
      "cutover-set-uncovered-member",
      uncovered.map(({ project, detail }) => `${project} (${detail})`).join("; "),
      uncovered.map(({ project }) => project),
    );
  }
  const unverifiable = outcomes.flatMap((outcome) => outcome.status === "unverifiable" ? [outcome] : []);
  if (unverifiable.length > 0) {
    return refused(
      "cutover-set-member-unverifiable",
      unverifiable.map((outcome) => `${outcome.physicalProjectId} (${outcome.detail})`).join("; "),
      unverifiable.map((outcome) => outcome.physicalProjectId),
    );
  }
  const authorities = outcomes.map((outcome) =>
    (outcome as Extract<CutoverSetMemberAuthorityOutcome, { status: "authenticated" }>).authority);
  const unassigned = hashes.filter((hash) => !input.generationIds.has(hash));
  if (unassigned.length > 0) {
    return refused("cutover-set-incomplete", "stored-data projects have no member generation", unassigned);
  }
  const unknown = [...input.generationIds.keys()].filter((hash) => !hashes.includes(hash));
  if (unknown.length > 0) {
    return refused("cutover-set-unknown-member", "members name projects without stored data", unknown);
  }
  const shared = outcomes.filter((_, index) => authorities[index]!.projectIdentity.scope !== "local");
  if (shared.length > 0) {
    return refused(
      "cutover-set-member-not-local",
      "members have a shared (multi-machine) project identity",
      shared.map((outcome) => outcome.physicalProjectId),
    );
  }
  const foreign = outcomes.filter((_, index) => authorities[index]!.machineIdentity.machineId !== input.machineId);
  if (foreign.length > 0) {
    return refused(
      "cutover-set-machine-mismatch",
      "member authorities belong to a different machine than the set",
      foreign.map((outcome) => outcome.physicalProjectId),
    );
  }
  const duplicated = hashes.filter((hash) => {
    const generationId = input.generationIds.get(hash)!;
    return generationId === input.setId || hashes.some((other) =>
      other !== hash && input.generationIds.get(other) === generationId);
  });
  if (duplicated.length > 0) {
    return refused(
      "cutover-set-duplicate-generation",
      "members share a generation id with another member or the set",
      duplicated,
    );
  }
  const manifest = parseBackendCutoverSetManifest({
    version: 1,
    setId: input.setId,
    machineId: input.machineId,
    members: outcomes.map((outcome, index): CutoverSetMember => ({
      physicalProjectId: outcome.physicalProjectId,
      generationId: input.generationIds.get(outcome.physicalProjectId)!,
      sourceSelectionSha256: authorities[index]!.sourceSelectionSha256,
    })),
  });
  const entry = cutoverSetMaintenanceEntry(manifest);
  const capacity = backendCutoverSetJournalCapacity(entry.cutoverSet);
  if (capacity.worstCaseBytes > capacity.limitBytes) {
    return refused(
      "cutover-set-too-large",
      `the set journal could reach ${capacity.worstCaseBytes} bytes; the readable limit is ${capacity.limitBytes}`,
      hashes,
    );
  }
  return { status: "built", manifest, manifestSha256: entry.sourceSelectionSha256, entry };
}

export type CutoverSetMemberEvidenceState = "current" | "stale" | "drifted" | "unverifiable";

/** One member's selection evidence, keyed by both identities. A missing row is "absent". */
export type CutoverSetMemberEvidence = Readonly<{
  physicalProjectId: string;
  generationId: string;
  state: CutoverSetMemberEvidenceState;
}>;

export type CutoverSetSelectionFailure = Readonly<{
  physicalProjectId: string;
  generationId: string | null;
  reason: CutoverSetSelectionRefusalReason;
}>;

export type CutoverSetSelectionDecision = Readonly<
  | { status: "eligible" }
  | {
    status: "refused";
    /** The first failure's reason; `failures` lists every failing member deterministically. */
    reason: CutoverSetSelectionRefusalReason;
    failures: readonly CutoverSetSelectionFailure[];
  }
>;

const STATE_REASONS: Readonly<Record<Exclude<CutoverSetMemberEvidenceState, "current">, CutoverSetSelectionRefusalReason>> = {
  stale: "cutover-set-member-evidence-stale",
  drifted: "cutover-set-member-evidence-drifted",
  unverifiable: "cutover-set-member-evidence-unverifiable",
};

/**
 * Selection is eligible only when the evidence names exactly the manifest
 * members and every member's state is current. One member's evidence is never
 * inferred from another's. Failures list manifest members in manifest order,
 * then evidence for non-members sorted by project. (#1549 and #1550 enforce.)
 */
export function decideCutoverSetSelection(
  manifest: CutoverSetManifest,
  evidence: readonly CutoverSetMemberEvidence[],
): CutoverSetSelectionDecision {
  const byProject = new Map<string, CutoverSetMemberEvidence[]>();
  for (const row of evidence) byProject.set(row.physicalProjectId, [...(byProject.get(row.physicalProjectId) ?? []), row]);
  const failures: CutoverSetSelectionFailure[] = [];
  for (const member of manifest.members) {
    const rows = byProject.get(member.physicalProjectId) ?? [];
    const row = rows[0];
    const reason: CutoverSetSelectionRefusalReason | null = row === undefined
      ? "cutover-set-member-evidence-absent"
      : rows.length > 1
        ? "cutover-set-evidence-duplicate-member"
        : row.generationId !== member.generationId
          ? "cutover-set-evidence-identity-mismatch"
          : row.state === "current"
            ? null
            : STATE_REASONS[row.state] ?? "cutover-set-member-evidence-unverifiable";
    if (reason !== null) failures.push({ physicalProjectId: member.physicalProjectId, generationId: member.generationId, reason });
  }
  const memberIds = new Set(manifest.members.map((member) => member.physicalProjectId));
  for (const physicalProjectId of [...byProject.keys()].filter((id) => !memberIds.has(id)).sort()) {
    failures.push({ physicalProjectId, generationId: null, reason: "cutover-set-evidence-extra-member" });
  }
  const first = failures[0];
  return first === undefined ? { status: "eligible" } : { status: "refused", reason: first.reason, failures };
}
