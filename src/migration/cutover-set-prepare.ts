import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedPostgreSqlConfig } from "../daemon/config.js";
import { MachineIdentityFileError, requireMachineIdentity } from "../machine-identity.js";
import { PrivateMutationLockContentionError } from "../private-mutation-lock.js";
import { readProjectMapCanonicalPath } from "../project-map.js";
import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  backendMaintenanceQueueEvidenceSentinel,
  isTerminalBackendMaintenancePhase,
  readBackendMaintenanceJournal,
  resolveBackendMaintenanceGenerationBinding,
  withBackendPublicationAppendBarrierAsync,
  type BackendMaintenanceJournal,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import { connectionSettings } from "../storage/postgresql/factory.js";
import { abortSetMemberGenerationIds, classifyMigrationAbortGate } from "./abort.js";
import { maintenanceOnlyDriver } from "./apply.js";
import {
  performMigrationApplyGenesisAndCopy,
  performMigrationGenesisDryRun,
} from "./apply-genesis-copy.js";
import type { MigrationCopyTestingDependencies } from "./batch-copy.js";
import { unexpectedFailureEvidence } from "./boundary.js";
import {
  buildVerificationInputs,
  readVerifiedEvidence,
  type VerifyRefusal,
} from "./cli-verify.js";
import {
  resolveMigrationExpectedIdentity,
  type MigrationIdentityEffect,
} from "./cli-preflight.js";
import {
  buildCutoverSetManifest,
  CutoverSetCaptureError,
  type CutoverSetMemberAuthorityOutcome,
} from "./cutover-set.js";
import {
  classifyMigrationCandidateOccupancy,
  computeCutoverSetBase,
  computeMigrationGenerationBase,
  DEFAULT_MAX_PROBE_ORDINAL,
  generationIdBelongsToBase,
  MigrationIdentityError,
  nonSecretPostgreSqlTargetCoordinates,
  resolveConfirmedMigrationGenerationId,
  resolveMigrationGenerationId,
  type NonSecretPostgreSqlTarget,
} from "./generation-identity.js";
import {
  classifyEnteringRecoveryFailure,
  classifyHoldEntryFailure,
  type MigrationEnteringRecoveryOutcome,
} from "./hold-entry.js";
import { observeMigrationMaintenanceJournal } from "./journal-observation.js";
import {
  authenticateSqliteMigrationSource,
  authenticateSqliteMigrationSourceBytes,
  captureAuthenticatedSqliteMigrationSource,
  resolveCutoverSetMemberAuthorities,
} from "./maintenance.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { MigrationProtocolError, type MigrationManifest } from "./protocol.js";
import { inspectAuthenticatedSqliteMigrationSnapshot } from "./queue-evidence.js";
import { classifySqliteSnapshotArtifact } from "./sqlite-snapshot.js";
import {
  completePendingMigrationVerification,
  MigrationVerificationDriverError,
  verifyMigrationGeneration,
} from "./verify-generation.js";
import { MigrationVerificationReportStore, MigrationVerificationStoreError } from "./verification-store.js";

/**
 * Preparing a cutover set under one maintenance hold (#1548).
 *
 * The hold comes first and covers everything: one set-wide
 * maintenance-and-quiescence write, then — member by member, in manifest
 * order, each step rereading the journal and that member's own binding view
 * — capture, genesis, copy and verification. Another member's evidence is
 * never inferred; a member's durable state (snapshot, manifest, pending
 * effect) decides where a call resumes, so a verified member is validated
 * and skipped, never copied again. The first blocked member stops the
 * preparation with the hold and every member's evidence preserved.
 *
 * Outcomes, by where a failure can occur:
 *
 * | Failure | Result |
 * | --- | --- |
 * | journal slot, hold, abort gate, confirmation, target fence, builder refusal, identity, occupancy, hold entry | refuse (nothing of the set is held unless it already was) |
 * | capture, snapshot, binding, genesis, copy, verification of one member | blocked at that member (the hold stays; calling again resumes) |
 * | anything unclassified | thrown; identity writes made before it are carried on CutoverSetPrepareError |
 *
 * There is no CLI for this yet; #1551 exposes it.
 */

export type CutoverSetPrepareOperations = Readonly<{
  observeJournal: typeof observeMigrationMaintenanceJournal;
  readJournal: typeof readBackendMaintenanceJournal;
  requireMachine: typeof requireMachineIdentity;
  resolveAuthorities: typeof resolveCutoverSetMemberAuthorities;
  resolveGenerationId: typeof resolveMigrationGenerationId;
  resolveConfirmedGenerationId: typeof resolveConfirmedMigrationGenerationId;
  classifyOccupancy: typeof classifyMigrationCandidateOccupancy;
  readCanonicalPath: typeof readProjectMapCanonicalPath;
  classifySnapshot: typeof classifySqliteSnapshotArtifact;
  inspectSnapshot: typeof inspectAuthenticatedSqliteMigrationSnapshot;
  authenticateSource: typeof authenticateSqliteMigrationSource;
  authenticateSourceBytes: typeof authenticateSqliteMigrationSourceBytes;
  captureSource: typeof captureAuthenticatedSqliteMigrationSource;
  completePendingVerification: typeof completePendingMigrationVerification;
  readVerified: typeof readVerifiedEvidence;
}>;

export type CutoverSetPrepareInput = Readonly<{
  homeDir: string;
  /** The set id the operator confirmed from {@link resolveCutoverSetCandidate}; compared before any write. */
  confirmSetId: string;
  /** The one resolved target every member copies to; never reread from disk during a preparation. */
  targetConfig: ResolvedPostgreSqlConfig;
  maxRecords: number;
  maxBytes: number;
  ownerProcessId?: string;
  maxProbeOrdinal?: number;
  leaseTtlMs?: number;
  now?: Date;
  signal?: AbortSignal;
  /** The maintenance-only coordinator by default. */
  coordinator?: BackendPublicationCoordinator;
  manifestStore?: MigrationManifestStore;
  reportStore?: MigrationVerificationReportStore;
  /** @internal The existing per-copy interruption seam, threaded to every member's copy. */
  copyTesting?: MigrationCopyTestingDependencies;
  /** @internal Deterministic failure-injection seam for tests only. */
  _operationsForTesting?: Partial<CutoverSetPrepareOperations>;
}>;

export type CutoverSetMemberState = "verified" | "blocked" | "pending";

export type CutoverSetPrepareMember = Readonly<{
  physicalProjectId: string;
  generationId: string;
  state: CutoverSetMemberState;
  reason?: string;
  evidence?: string;
}>;

/** What the identity step wrote for one member, attributed per member. */
export type CutoverSetIdentityMutation = Readonly<{
  physicalProjectId: string;
  effects: readonly MigrationIdentityEffect[];
}>;

export type CutoverSetPrepareResult =
  | Readonly<{
    status: "prepared";
    setId: string;
    members: readonly CutoverSetPrepareMember[];
    identityMutation: readonly CutoverSetIdentityMutation[];
  }>
  | Readonly<{
    status: "blocked";
    setId: string;
    members: readonly CutoverSetPrepareMember[];
    reason: string;
    evidence?: string;
    blockedProject: string;
    identityMutation: readonly CutoverSetIdentityMutation[];
  }>
  | Readonly<{
    status: "refuse";
    reason: string;
    evidence?: string;
    projects?: readonly string[];
    /** Null when the refusal precedes knowing the set id. */
    setId: string | null;
    identityMutation: readonly CutoverSetIdentityMutation[];
  }>;

export type CutoverSetCandidateDisposition = "fresh" | "recover-entering" | "continue-held";

export type CutoverSetCandidateResolution =
  | Readonly<{
    status: "candidate";
    disposition: CutoverSetCandidateDisposition;
    setId: string;
    members: readonly Readonly<{ physicalProjectId: string; generationId: string }>[];
  }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string; projects?: readonly string[] }>;

export type CutoverSetCandidateInput = Readonly<{
  homeDir: string;
  targetConfig: ResolvedPostgreSqlConfig;
  maxProbeOrdinal?: number;
  manifestStore?: MigrationManifestStore;
  /** @internal Deterministic failure-injection seam for tests only. */
  _operationsForTesting?: Partial<CutoverSetPrepareOperations>;
}>;

/**
 * An unclassified failure after the identity step already wrote for some
 * members: the writes are not lost with the error.
 */
export class CutoverSetPrepareError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly identityMutation: readonly CutoverSetIdentityMutation[],
  ) {
    super("cutover set preparation failed after identity writes");
    this.name = "CutoverSetPrepareError";
  }
}

class Refused extends Error {
  constructor(
    readonly reason: string,
    readonly detail: Readonly<{ evidence?: string | undefined; projects?: readonly string[] | undefined; setId?: string | undefined }> = {},
  ) {
    super(reason);
  }
}

class MemberBlocked extends Error {
  constructor(readonly reason: string, readonly evidence?: string | undefined) {
    super(reason);
  }
}

type Authenticated = Extract<CutoverSetMemberAuthorityOutcome, { status: "authenticated" }>;
type MemberRef = Readonly<{ physicalProjectId: string; generationId: string }>;
type HeldMember = MemberRef & Readonly<{ sourceSelectionSha256: string }>;

type Context = Readonly<{
  homeDir: string;
  targetConfig: ResolvedPostgreSqlConfig;
  coordinates: NonSecretPostgreSqlTarget;
  machineId: string;
  maxProbeOrdinal: number;
  manifestStore: MigrationManifestStore;
  ops: Partial<CutoverSetPrepareOperations>;
}>;

const UNALLOCATED_SET_ID = "cutover-set-unallocated";

function byProject(left: { physicalProjectId: string }, right: { physicalProjectId: string }): number {
  return left.physicalProjectId.localeCompare(right.physicalProjectId, "en");
}

function prepareContext(input: Readonly<{
  homeDir: string;
  targetConfig: ResolvedPostgreSqlConfig;
  maxProbeOrdinal?: number | undefined;
  manifestStore?: MigrationManifestStore | undefined;
  _operationsForTesting?: Partial<CutoverSetPrepareOperations> | undefined;
}>): Context {
  const ops = input._operationsForTesting ?? {};
  let coordinates: NonSecretPostgreSqlTarget;
  try {
    coordinates = nonSecretPostgreSqlTargetCoordinates(input.targetConfig.postgresql.url);
  } catch (error) {
    // Only a MigrationIdentityError is a known refusal; anything else is an unclassified defect.
    if (!(error instanceof MigrationIdentityError)) throw error;
    throw new Refused(`generation-${error.reason}`, { evidence: error.evidence ?? undefined });
  }
  let machineId: string;
  try {
    machineId = (ops.requireMachine ?? requireMachineIdentity)(input.homeDir).machineId;
  } catch (error) {
    if (!(error instanceof MachineIdentityFileError)) throw error;
    throw new Refused("machine-identity-unregistered");
  }
  return {
    homeDir: input.homeDir,
    targetConfig: input.targetConfig,
    coordinates,
    machineId,
    maxProbeOrdinal: input.maxProbeOrdinal ?? DEFAULT_MAX_PROBE_ORDINAL,
    manifestStore: input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir }),
    ops,
  };
}

type Entry =
  | Readonly<{ kind: "fresh" }>
  | Readonly<{ kind: "set"; journal: BackendMaintenanceJournal }>;

/** Journal resolution shared by the preview and the preparation: every refusal that precedes a decision. */
function classifyEntry(ctx: Context): Entry {
  const observation = (ctx.ops.observeJournal ?? observeMigrationMaintenanceJournal)({ homeDir: ctx.homeDir });
  if (observation.kind === "publication") throw new Refused("publication-occupies-slot");
  if (observation.kind === "unresolvable") throw new Refused("journal-unresolvable", { evidence: observation.evidence });
  if (observation.kind === "absent") return { kind: "fresh" };
  const { journal } = observation;
  if (isTerminalBackendMaintenancePhase(journal.phase)) {
    // The set-aware abort gate: a terminal set names its members' manifests, never its own id.
    const gate = classifyMigrationAbortGate({
      journalTerminal: true,
      generationId: journal.generationId,
      generationIds: abortSetMemberGenerationIds(journal),
      manifestStore: ctx.manifestStore,
    });
    if (gate.status === "unresolvable") throw new Refused("abort-gate-unresolvable", { evidence: gate.evidence });
    if (gate.status === "incomplete-pair") throw new Refused("abort-or-resume-required", { evidence: gate.evidence });
    return { kind: "fresh" };
  }
  if (journal.cutoverSet === undefined) {
    throw new Refused("cutover-set-single-generation-held", { evidence: journal.generationId });
  }
  // #1550 (C4): a postgresql-origin set hold is a rollback in progress, never forward preparation to resume.
  if (journal.sourceBackend !== "sqlite") {
    throw new Refused("cutover-set-rollback-held", { evidence: journal.generationId });
  }
  return { kind: "set", journal };
}

async function allocate(
  ctx: Context,
  token: BackendPublicationLockToken,
  base: string,
  confirmed: boolean,
): Promise<string> {
  const request = {
    base,
    homeDir: ctx.homeDir,
    lockToken: token,
    manifestStore: ctx.manifestStore,
    maxProbeOrdinal: ctx.maxProbeOrdinal,
  };
  try {
    if (!confirmed) return (await (ctx.ops.resolveGenerationId ?? resolveMigrationGenerationId)(request)).generationId;
    const resolution = await (ctx.ops.resolveConfirmedGenerationId ?? resolveConfirmedMigrationGenerationId)(request);
    if (resolution.status === "refuse") {
      throw new Refused(`generation-${resolution.reason}`, { evidence: resolution.evidence });
    }
    return resolution.generationId;
  } catch (error) {
    // The identity helpers throw their typed error for bound and classification failures.
    if (!(error instanceof MigrationIdentityError)) throw error;
    throw new Refused(`generation-${error.reason}`, { evidence: error.evidence ?? undefined });
  }
}

type FreshPlan = Readonly<{
  setId: string;
  outcomes: readonly Authenticated[];
  ids: ReadonlyMap<string, string>;
  built: Extract<ReturnType<typeof buildCutoverSetManifest>, { status: "built" }>;
}>;

/**
 * The fresh allocation, shared by the preview and the preparation (C2, C3, C9):
 * authorities, member ids from each member's own single-generation base, the
 * set id from the base over those (project, generation) pairs, and a
 * provisional pure build that surfaces every builder refusal before anything
 * is written.
 */
async function planFresh(ctx: Context, token: BackendPublicationLockToken, confirmed: boolean): Promise<FreshPlan> {
  // Both callers precede the confirmation comparison, so the lookup publishes nothing (#1670); the
  // post-confirmation rebuild in enterFresh still resolves and publishes normally.
  const resolution = (ctx.ops.resolveAuthorities ?? resolveCutoverSetMemberAuthorities)({
    homeDir: ctx.homeDir,
    lockToken: token,
    suppressMetadataBackfill: true,
  });
  const outcomes = resolution.status === "resolved" ? [...resolution.outcomes].sort(byProject) : [];
  const authenticated = outcomes.filter((outcome): outcome is Authenticated => outcome.status === "authenticated");
  const ids = new Map<string, string>();
  for (const outcome of authenticated) {
    const base = computeMigrationGenerationBase({
      physicalProjectId: outcome.physicalProjectId,
      canonicalPath: resolve(outcome.authority.canonicalPath),
      target: ctx.coordinates,
    });
    ids.set(outcome.physicalProjectId, await allocate(ctx, token, base, confirmed));
  }
  // A set that the builder will refuse anyway (fewer than two projects, or an outcome that is not authenticated)
  // has no members to name, so its id stays unallocated.
  const complete = resolution.status === "resolved" && authenticated.length === outcomes.length && outcomes.length >= 2;
  const setId = complete
    ? await allocate(ctx, token, computeCutoverSetBase({
      target: ctx.coordinates,
      members: authenticated.map((outcome) => ({ physicalProjectId: outcome.physicalProjectId, generationId: ids.get(outcome.physicalProjectId)! })),
    }), confirmed)
    : UNALLOCATED_SET_ID;
  const built = buildCutoverSetManifest({ setId, machineId: ctx.machineId, resolution, generationIds: ids });
  if (built.status === "refused") {
    throw new Refused(built.reason, { evidence: built.detail, projects: built.projects });
  }
  return { setId, outcomes: authenticated, ids, built };
}

function memberRefs(journal: BackendMaintenanceJournal): readonly HeldMember[] {
  return journal.cutoverSet!.manifest.members;
}

export async function resolveCutoverSetCandidate(input: CutoverSetCandidateInput): Promise<CutoverSetCandidateResolution> {
  try {
    const ctx = prepareContext(input);
    const entry = classifyEntry(ctx);
    if (entry.kind === "set") {
      const { journal } = entry;
      if (journal.phase !== "maintenance-entering" && journal.phase !== "maintenance-held") {
        throw new Refused("hold-phase-unsupported", { evidence: journal.phase });
      }
      return {
        status: "candidate",
        disposition: journal.phase === "maintenance-entering" ? "recover-entering" : "continue-held",
        setId: journal.generationId,
        members: memberRefs(journal).map(({ physicalProjectId, generationId }) => ({ physicalProjectId, generationId })),
      };
    }
    const plan = await withBackendPublicationAppendBarrierAsync(ctx.homeDir, (token) => planFresh(ctx, token, false));
    return {
      status: "candidate",
      disposition: "fresh",
      setId: plan.setId,
      members: plan.built.manifest.members.map(({ physicalProjectId, generationId }) => ({ physicalProjectId, generationId })),
    };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return {
      status: "refuse",
      reason: error.reason,
      ...(error.detail.evidence === undefined ? {} : { evidence: error.detail.evidence }),
      ...(error.detail.projects === undefined ? {} : { projects: error.detail.projects }),
    };
  }
}

type Effects = Map<string, MigrationIdentityEffect[]>;

function mutationOf(effects: Effects): readonly CutoverSetIdentityMutation[] {
  return [...effects].map(([physicalProjectId, list]) => ({ physicalProjectId, effects: [...list] }));
}

export async function prepareCutoverSet(input: CutoverSetPrepareInput): Promise<CutoverSetPrepareResult> {
  const effects: Effects = new Map();
  try {
    return await run(input, effects);
  } catch (error) {
    if (error instanceof Refused) {
      return {
        status: "refuse",
        reason: error.reason,
        ...(error.detail.evidence === undefined ? {} : { evidence: error.detail.evidence }),
        ...(error.detail.projects === undefined ? {} : { projects: error.detail.projects }),
        setId: error.detail.setId ?? null,
        identityMutation: mutationOf(effects),
      };
    }
    if (effects.size > 0) throw new CutoverSetPrepareError(error, mutationOf(effects));
    throw error;
  }
}

async function run(input: CutoverSetPrepareInput, effects: Effects): Promise<CutoverSetPrepareResult> {
  const ctx = prepareContext(input);
  const coordinator = input.coordinator
    ?? new BackendPublicationCoordinator({ homeDir: input.homeDir, driver: maintenanceOnlyDriver() });
  const entry = classifyEntry(ctx);
  if (entry.kind === "fresh") {
    const entered = await withBackendPublicationAppendBarrierAsync(input.homeDir, (token) =>
      enterFresh(input, ctx, coordinator, effects, token));
    return runMembers(input, ctx, entered.journal, entered.identities, entered.paths, effects);
  }
  const { journal } = entry;
  const setId = journal.generationId;
  if (setId !== input.confirmSetId) throw new Refused("confirmation-generation-moved", { setId });
  if (journal.phase !== "maintenance-entering" && journal.phase !== "maintenance-held") {
    throw new Refused("hold-phase-unsupported", { evidence: journal.phase, setId });
  }
  const paths = persistedPaths(ctx, journal);
  assertTargetFamily(ctx, journal, paths);
  const identities = await resolveHeldIdentities(ctx, journal, paths);
  let held = journal;
  if (journal.phase === "maintenance-entering") {
    try {
      held = await coordinator.enterMaintenance({
        publicationId: journal.publicationId,
        generationId: journal.generationId,
        sourceSelectionSha256: journal.sourceSelectionSha256,
        queueEvidenceSha256: journal.queueEvidenceSha256,
        roster: journal.roster,
        cutoverSet: journal.cutoverSet!,
        sourceBackend: journal.sourceBackend,
        // The compare-and-swap input carried from the observation, never a fresh read.
        expectedChecksumSha256: journal.checksumSha256,
      });
    } catch (error) {
      const classified = classifyEnteringRecoveryFailure(error) as Extract<MigrationEnteringRecoveryOutcome, { status: "refuse" }>;
      throw new Refused(`entering-recovery-${classified.class}`, { evidence: classified.evidence, setId });
    }
    if (held.phase !== "maintenance-held") throw new Refused("hold-entry-readback-mismatch", { setId });
  }
  return runMembers(input, ctx, held, identities, paths, effects);
}

async function enterFresh(
  input: CutoverSetPrepareInput,
  ctx: Context,
  coordinator: BackendPublicationCoordinator,
  effects: Effects,
  token: BackendPublicationLockToken,
): Promise<Readonly<{
  journal: BackendMaintenanceJournal;
  identities: ReadonlyMap<string, StorageIdentityContext>;
  paths: ReadonlyMap<string, string>;
}>> {
  const plan = await planFresh(ctx, token, true);
  const { setId } = plan;
  // Confirmation precedes every write, local or destination (C2).
  if (setId !== input.confirmSetId) throw new Refused("confirmation-generation-moved", { setId });
  const identities = new Map<string, StorageIdentityContext>();
  const paths = new Map<string, string>();
  for (const outcome of plan.outcomes) {
    const { physicalProjectId } = outcome;
    const list: MigrationIdentityEffect[] = [];
    effects.set(physicalProjectId, list);
    const identity = await resolveMigrationExpectedIdentity({
      preflight: { targetConfig: ctx.targetConfig, machineId: ctx.machineId, candidate: { disposition: "fresh" } },
      cwd: outcome.authority.canonicalPath,
      homeDir: ctx.homeDir,
      publicationLockToken: token,
      observe: (effect) => { list.push(effect); },
    });
    if (identity.status === "refuse") {
      throw new Refused(identity.reason, { evidence: identity.evidence, projects: [physicalProjectId], setId });
    }
    if (identity.expectedIdentity.localProjectId !== physicalProjectId) {
      throw new Refused("member-identity-mismatch", { projects: [physicalProjectId], setId });
    }
    identities.set(physicalProjectId, identity.expectedIdentity);
    paths.set(physicalProjectId, resolve(outcome.authority.canonicalPath));
  }
  // The mints may have changed the map: the hold binds what is authenticated now, for the same projects and paths.
  const again = (ctx.ops.resolveAuthorities ?? resolveCutoverSetMemberAuthorities)({ homeDir: ctx.homeDir, lockToken: token });
  const signature = (outcomes: readonly CutoverSetMemberAuthorityOutcome[]) => outcomes
    .map((outcome) => outcome.status === "authenticated"
      ? `${outcome.physicalProjectId}\u0000${resolve(outcome.authority.canonicalPath)}`
      : `${outcome.physicalProjectId}\u0000${outcome.status}`)
    .sort();
  if (again.status !== "resolved" || signature(again.outcomes).join("\n") !== signature(plan.outcomes).join("\n")) {
    throw new Refused("cutover-set-authority-changed", { projects: [...plan.ids.keys()], setId });
  }
  const rebuilt = buildCutoverSetManifest({ setId, machineId: ctx.machineId, resolution: again, generationIds: plan.ids });
  if (rebuilt.status === "refused") {
    throw new Refused(rebuilt.reason, { evidence: rebuilt.detail, projects: rebuilt.projects, setId });
  }
  // Every selected id must still be free immediately before the single entry write.
  for (const generationId of [...plan.ids.values(), setId]) {
    const occupancy = await (ctx.ops.classifyOccupancy ?? classifyMigrationCandidateOccupancy)({
      generationId, homeDir: ctx.homeDir, lockToken: token, manifestStore: ctx.manifestStore,
    });
    if (occupancy.status === "occupied") {
      throw new Refused("generation-occupied-since-probe", { evidence: generationId, setId });
    }
    if (occupancy.status === "refuse") {
      throw new Refused("generation-unresolvable-since-probe", { evidence: occupancy.evidence, setId });
    }
  }
  let held: BackendMaintenanceJournal;
  try {
    held = await coordinator.enterMaintenance({ ...rebuilt.entry, now: input.now }, token);
  } catch (error) {
    const failure = classifyHoldEntryFailure(error);
    throw new Refused(`hold-entry-${failure.class}`, { evidence: failure.evidence, setId });
  }
  // A write is not evidence of its own effect.
  if (held.phase !== "maintenance-held") throw new Refused("hold-entry-readback-mismatch", { setId });
  return { journal: held, identities, paths };
}

/** The persisted canonical path of every held member, from a strict lock-free read (C5). */
function persistedPaths(ctx: Context, journal: BackendMaintenanceJournal): ReadonlyMap<string, string> {
  const setId = journal.generationId;
  const paths = new Map<string, string>();
  for (const member of memberRefs(journal)) {
    let path: string | null;
    try {
      path = (ctx.ops.readCanonicalPath ?? readProjectMapCanonicalPath)({ homeDir: ctx.homeDir, hash: member.physicalProjectId });
    } catch (error) {
      throw new Refused("project-map-unresolvable", { evidence: unexpectedFailureEvidence(error), setId });
    }
    if (path === null) throw new Refused("cutover-set-member-unmapped", { projects: [member.physicalProjectId], setId });
    paths.set(member.physicalProjectId, resolve(path));
  }
  return paths;
}

/**
 * The resume target fence (C4): every held member id must belong to the
 * family its own base yields under the supplied target and its persisted
 * path, and so must the set id. A different target would otherwise copy
 * the not-yet-started members somewhere the verified ones are not.
 */
function assertTargetFamily(ctx: Context, journal: BackendMaintenanceJournal, paths: ReadonlyMap<string, string>): void {
  const members = memberRefs(journal);
  const moved = members.filter((member) => !generationIdBelongsToBase(
    computeMigrationGenerationBase({
      physicalProjectId: member.physicalProjectId, canonicalPath: paths.get(member.physicalProjectId)!, target: ctx.coordinates,
    }),
    member.generationId,
    ctx.maxProbeOrdinal,
  ));
  const setBase = computeCutoverSetBase({ target: ctx.coordinates, members });
  if (moved.length > 0 || !generationIdBelongsToBase(setBase, journal.generationId, ctx.maxProbeOrdinal)) {
    throw new Refused("cutover-set-target-changed", {
      projects: moved.map((member) => member.physicalProjectId), setId: journal.generationId,
    });
  }
}

async function resolveHeldIdentities(
  ctx: Context,
  journal: BackendMaintenanceJournal,
  paths: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, StorageIdentityContext>> {
  const identities = new Map<string, StorageIdentityContext>();
  for (const member of memberRefs(journal)) {
    // A live hold mints nothing: the local entry must be persisted and the destination project must exist.
    const identity = await resolveMigrationExpectedIdentity({
      preflight: { targetConfig: ctx.targetConfig, machineId: ctx.machineId, candidate: { disposition: "continue-held" } },
      cwd: paths.get(member.physicalProjectId)!,
      homeDir: ctx.homeDir,
    });
    if (identity.status === "refuse") {
      throw new Refused(identity.reason, { evidence: identity.evidence, projects: [member.physicalProjectId], setId: journal.generationId });
    }
    if (identity.expectedIdentity.localProjectId !== member.physicalProjectId) {
      throw new Refused("member-identity-mismatch", { projects: [member.physicalProjectId], setId: journal.generationId });
    }
    identities.set(member.physicalProjectId, identity.expectedIdentity);
  }
  return identities;
}

async function runMembers(
  input: CutoverSetPrepareInput,
  ctx: Context,
  journal: BackendMaintenanceJournal,
  identities: ReadonlyMap<string, StorageIdentityContext>,
  paths: ReadonlyMap<string, string>,
  effects: Effects,
): Promise<CutoverSetPrepareResult> {
  const setId = journal.generationId;
  const members = memberRefs(journal);
  await assertHeldAuthorities(ctx, journal);
  const reports: CutoverSetPrepareMember[] = members.map(({ physicalProjectId, generationId }) =>
    ({ physicalProjectId, generationId, state: "pending" }));
  for (const [index, member] of members.entries()) {
    try {
      if (input.signal?.aborted === true) throw new MemberBlocked("cancelled");
      await prepareMember(input, ctx, setId, member, identities.get(member.physicalProjectId)!, paths.get(member.physicalProjectId)!);
    } catch (error) {
      if (!(error instanceof MemberBlocked)) throw error;
      reports[index] = {
        physicalProjectId: member.physicalProjectId, generationId: member.generationId, state: "blocked",
        reason: error.reason, ...(error.evidence === undefined ? {} : { evidence: error.evidence }),
      };
      // Later members are not started; no other member's evidence is touched.
      return {
        status: "blocked", setId, members: reports, reason: error.reason,
        ...(error.evidence === undefined ? {} : { evidence: error.evidence }),
        blockedProject: member.physicalProjectId, identityMutation: mutationOf(effects),
      };
    }
    reports[index] = { physicalProjectId: member.physicalProjectId, generationId: member.generationId, state: "verified" };
  }
  return { status: "prepared", setId, members: reports, identityMutation: mutationOf(effects) };
}

/**
 * The held-authority fence (C5): once the hold is held - freshly entered,
 * resumed, or recovered from entering, never while entering - and before any
 * member work (capture, genesis, copy, verification, verified skip), one
 * append-barrier span enumerates and authenticates every stored-data project.
 * The set must be exactly the held members and each authority's source
 * selection must be the one the hold bound. Nothing is recaptured and no
 * source bytes are recomputed; a refusal leaves the hold and all evidence.
 */
async function assertHeldAuthorities(ctx: Context, journal: BackendMaintenanceJournal): Promise<void> {
  const setId = journal.generationId;
  const resolution = await withBackendPublicationAppendBarrierAsync(ctx.homeDir, async (token) =>
    (ctx.ops.resolveAuthorities ?? resolveCutoverSetMemberAuthorities)({ homeDir: ctx.homeDir, lockToken: token }));
  if (resolution.status === "unresolvable") {
    throw new Refused("cutover-set-enumeration-unresolvable", { evidence: `${resolution.reason}: ${resolution.detail}`, setId });
  }
  const unusable = resolution.outcomes.filter((outcome) => outcome.status !== "authenticated");
  if (unusable.length > 0) {
    throw new Refused("cutover-set-member-unverifiable", {
      evidence: unusable.map((outcome) => `${outcome.physicalProjectId} (${outcome.status})`).join("; "),
      projects: unusable.map((outcome) => outcome.physicalProjectId).sort(),
      setId,
    });
  }
  const authenticated = resolution.outcomes as readonly Authenticated[];
  const held = new Map(memberRefs(journal).map((member) => [member.physicalProjectId, member.sourceSelectionSha256]));
  const present = new Set(authenticated.map((outcome) => outcome.physicalProjectId));
  const drifted = [...new Set([...held.keys(), ...present])].filter((id) => held.has(id) !== present.has(id)).sort();
  if (drifted.length > 0) throw new Refused("cutover-set-membership-drift", { projects: drifted, setId });
  const moved = authenticated
    .filter((outcome) => outcome.authority.sourceSelectionSha256 !== held.get(outcome.physicalProjectId))
    .map((outcome) => outcome.physicalProjectId).sort();
  if (moved.length > 0) throw new Refused("cutover-set-authority-drifted", { projects: moved, setId });
}

function captureFailure(error: unknown): MemberBlocked {
  if (error instanceof MemberBlocked) return error;
  if (error instanceof CutoverSetCaptureError) {
    return new MemberBlocked(error.reason, error.projects.length === 0 ? undefined : error.projects.join(","));
  }
  if (error instanceof PrivateMutationLockContentionError) return new MemberBlocked("capture-contention", "lock-contention");
  if (error instanceof BackendPublicationJournalError) {
    return error.reason === "unresolved-publication"
      ? new MemberBlocked("capture-contention", "journal-unresolved-publication")
      : new MemberBlocked("capture-unresolvable", `journal-${error.reason}`);
  }
  return new MemberBlocked("capture-failed", unexpectedFailureEvidence(error));
}

function verificationFailure(error: unknown): MemberBlocked {
  if (error instanceof PrivateMutationLockContentionError) return new MemberBlocked("member-verification-failed", "verify-contention");
  if (error instanceof MigrationVerificationDriverError) {
    return new MemberBlocked("member-verification-failed",
      error.reason === "lease-unavailable" || error.reason === "lease-lost" ? "verify-contention" : `verify-${error.reason}`);
  }
  if (error instanceof MigrationProtocolError) return new MemberBlocked("member-verification-failed", `manifest-${error.reason}`);
  if (error instanceof MigrationVerificationStoreError) return new MemberBlocked("member-verification-failed", `report-${error.reason}`);
  throw error;
}

function refusalEvidence(refusal: VerifyRefusal): string {
  return refusal.evidence === undefined ? refusal.reason : `${refusal.reason}:${refusal.evidence}`;
}

/** One member's capture, genesis, copy and verification under the held set; throws MemberBlocked. */
async function prepareMember(
  input: CutoverSetPrepareInput,
  ctx: Context,
  setId: string,
  member: HeldMember,
  identity: StorageIdentityContext,
  path: string,
): Promise<void> {
  const { homeDir, ops, manifestStore } = ctx;
  const generationId = member.generationId;
  const view = () => {
    const journal = (ops.readJournal ?? readBackendMaintenanceJournal)(homeDir);
    if (journal?.phase !== "maintenance-held" || journal.cutoverSet?.manifest.setId !== setId) {
      throw new MemberBlocked("hold-not-held", journal?.phase ?? "absent");
    }
    const bound = resolveBackendMaintenanceGenerationBinding(journal, generationId);
    if (bound === null) throw new MemberBlocked("member-unbound");
    return bound;
  };
  view();

  const presence = manifestStore.probeManifestPresence(generationId);
  if (presence.status === "unresolvable") throw new MemberBlocked("manifest-unresolvable", `manifest-${presence.reason}`);
  let manifest: MigrationManifest | null = null;
  if (presence.status === "present") {
    try {
      manifest = manifestStore.read(generationId);
    } catch (error) {
      if (!(error instanceof MigrationProtocolError)) throw error;
      throw new MemberBlocked("manifest-unresolvable", `manifest-${error.reason}`);
    }
  }

  let state: Awaited<ReturnType<typeof classifySqliteSnapshotArtifact>>["state"];
  try {
    state = (await (ops.classifySnapshot ?? classifySqliteSnapshotArtifact)(generationId, { homeDir })).state;
  } catch (error) {
    throw new MemberBlocked("member-snapshot-unresolvable", unexpectedFailureEvidence(error));
  }
  if (state === "partial" || state === "replaced") throw new MemberBlocked("member-snapshot-partial", `snapshot-${state}`);
  if (state === "tampered") throw new MemberBlocked("member-snapshot-tampered", "snapshot-tampered");
  if (state === "absent") {
    // Capture-before-genesis (section 4.7): a manifest beside an absent snapshot is unresumable evidence.
    if (manifest !== null) throw new MemberBlocked("member-snapshot-absent", `manifest-${manifest.phase}`);
    try {
      await withBackendPublicationAppendBarrierAsync(homeDir, async (token) => {
        const current = view();
        const authority = (ops.authenticateSource ?? authenticateSqliteMigrationSource)(path, homeDir, token);
        if (authority.physicalProjectId !== member.physicalProjectId
          || authority.sourceSelectionSha256 !== member.sourceSelectionSha256) {
          throw new MemberBlocked("member-authority-drifted");
        }
        const expectedSourceBytes = await (ops.authenticateSourceBytes ?? authenticateSqliteMigrationSourceBytes)(authority, { homeDir, lockToken: token });
        await (ops.captureSource ?? captureAuthenticatedSqliteMigrationSource)(authority, {
          homeDir, generationId, maintenanceChecksumSha256: current.checksumSha256, expectedSourceBytes, lockToken: token,
        });
      });
    } catch (error) {
      throw captureFailure(error);
    }
  }

  // The capture must have rebound this member's queue evidence off its entry sentinel, and the sealed snapshot
  // must carry this member's current binding (never the aggregate journal's, never a sibling's).
  const bound = view();
  if (bound.queueEvidenceSha256 === backendMaintenanceQueueEvidenceSentinel({ generationId, sourceSelectionSha256: member.sourceSelectionSha256 })) {
    throw new MemberBlocked("capture-failed", "queue-evidence-not-rebound");
  }
  let sealed: Awaited<ReturnType<typeof inspectAuthenticatedSqliteMigrationSnapshot>>;
  try {
    sealed = await (ops.inspectSnapshot ?? inspectAuthenticatedSqliteMigrationSnapshot)(generationId, homeDir);
  } catch (error) {
    throw new MemberBlocked("member-snapshot-unresolvable", unexpectedFailureEvidence(error));
  }
  if (sealed.artifact.maintenanceChecksumSha256 !== bound.checksumSha256
    || sealed.artifact.authority.physicalProjectId !== member.physicalProjectId
    || sealed.artifact.sourceSelectionSha256 !== member.sourceSelectionSha256) {
    throw new MemberBlocked("member-binding-drifted");
  }

  const settings = connectionSettings(ctx.targetConfig);
  const expectedOwner = ctx.targetConfig.postgresql.migrationRole;
  const genesisInput = {
    homeDir, generationId, maintenanceChecksumSha256: bound.checksumSha256, settings, expectedOwner, expectedIdentity: identity,
    ownerProcessId: input.ownerProcessId ?? randomUUID(), maxRecords: input.maxRecords, maxBytes: input.maxBytes,
    manifestStore,
    ...(input.leaseTtlMs === undefined ? {} : { leaseTtlMs: input.leaseTtlMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.copyTesting === undefined ? {} : { testing: input.copyTesting }),
  };
  const reread = (): MigrationManifest => {
    try {
      return manifestStore.read(generationId);
    } catch (error) {
      if (!(error instanceof MigrationProtocolError)) throw error;
      throw new MemberBlocked("manifest-unresolvable", `manifest-${error.reason}`);
    }
  };

  // Genesis and the dry-run effect, from an absent manifest or either planned window (C6).
  if (manifest === null || (manifest.phase === "planned"
    && (manifest.pendingEffect === null || manifest.pendingEffect.kind === "verify-dry-run"))) {
    const carried = manifest?.pendingEffect ?? null;
    const dryRun = await performMigrationGenesisDryRun({
      ...genesisInput,
      ...(carried === null ? {} : { carriedEffectId: carried.effectId }),
    });
    if (dryRun.status === "refuse") throw new MemberBlocked(dryRun.reason, dryRun.evidence);
    manifest = reread();
  }
  if (manifest.phase === "dry-run-verified" || manifest.phase === "copying") {
    const copied = await performMigrationApplyGenesisAndCopy(genesisInput);
    if (copied.status === "refuse") throw new MemberBlocked(copied.reason, copied.evidence);
    manifest = reread();
  }

  const reportStore = input.reportStore ?? new MigrationVerificationReportStore({ homeDir });
  const readVerified = (expectedReportSha256: string | null) => {
    const confirmed = (ops.readVerified ?? readVerifiedEvidence)(generationId, manifestStore, reportStore, expectedReportSha256);
    if (confirmed.status !== "verified") throw new MemberBlocked("member-verification-failed", refusalEvidence(confirmed));
  };
  const pending = manifest.pendingEffect;
  if (manifest.phase === "verified" && pending === null) {
    // A verified member is validated and skipped: no capture, copy or verification input is constructed.
    readVerified(null);
    return;
  }
  if (manifest.phase !== "copied" || (pending !== null && pending.kind !== "verify-generation")) {
    throw new MemberBlocked("member-state-unexpected", pending === null ? `manifest-${manifest.phase}`
      : `manifest-${manifest.phase}:pending-${pending.kind}`);
  }
  if (pending !== null) {
    // A crash after verification began: finish from persisted evidence, never reopening the destination.
    let completed: ReturnType<typeof completePendingMigrationVerification>;
    try {
      completed = (ops.completePendingVerification ?? completePendingMigrationVerification)({ homeDir, generationId });
    } catch (error) {
      throw verificationFailure(error);
    }
    readVerified(completed === null ? null : completed.report.reportSha256);
    return;
  }
  const inputs = await buildVerificationInputs({
    homeDir, generationId, manifest, destination: { settings, expectedOwner, expectedIdentity: identity },
    ...(input.leaseTtlMs === undefined ? {} : { leaseTtlMs: input.leaseTtlMs }), ops: undefined,
  });
  if (inputs.status === "refuse") throw new MemberBlocked("member-verification-failed", refusalEvidence(inputs));
  const scratchParent = mkdtempSync(join(tmpdir(), "lcm-migration-set-verify-"));
  try {
    let result: Awaited<ReturnType<typeof verifyMigrationGeneration>>;
    try {
      result = await verifyMigrationGeneration({
        ...inputs.input, scratchParent, ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      throw verificationFailure(error);
    }
    if (!result.report.activationEligible) {
      // The report is persisted as the member's evidence; the manifest stays copied and the set stays held.
      throw new MemberBlocked("member-verification-failed", result.report.clean ? "coverage-incomplete" : "mismatches");
    }
    readVerified(result.report.reportSha256);
  } finally {
    rmSync(scratchParent, { recursive: true });
  }
}
