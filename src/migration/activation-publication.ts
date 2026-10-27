import { join } from "node:path";
import {
  backendPublicationDirectory,
  backendPublicationMaterialContent,
  isTerminalBackendMaintenancePhase,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  type BackendMaintenanceJournal,
  type BackendPublicationJournal,
  type BackendPublicationLockToken,
  type BackendPublicationPhase,
  type BackendPublicationRecoveryMaterial,
  type PrepareBackendPublicationInput,
  type RecoverPendingOptions,
} from "../storage/backend-publication.js";
import type { StorageBackendName } from "../storage/contracts.js";
import {
  assertPrivateDirectory,
  openPrivateDirectory,
  readBoundedRegularFileWithStat,
  type BoundedFileResult,
  type PrivateDirectoryHandle,
} from "../security-files.js";
import { attributeNullableRead } from "./activation-absence.js";
import {
  assertActivationLeaseFence,
  type ActivationLeaseAssertResult,
  type ActivationLeasePublicationGuard,
  type ActivationLeaseTargetBackend,
} from "./activation-lease.js";
import {
  readActivationArtifact,
  ActivationArtifactPresenceUnresolvableError,
  ActivationArtifactIdentityMismatchError,
  type ActivationArtifactProjectRecord,
  type ActivationArtifactRecoveryMaterial,
} from "./activation-artifact-store.js";

/**
 * The token-gated step that drives a version-2 backend publication for
 * migration activation: the last leg of the activation pipeline, run after
 * a caller has already acquired this generation's PostgreSQL fenced leases
 * (activation-lease.ts) and durably sealed the recovery-material artifact
 * those leases were acquired for (activation-artifact-store.ts).
 *
 * Retained token, never re-acquired. This function requires an already-
 * active BackendPublicationLockToken as input rather than acquiring one
 * itself -- the same discipline activation-quiescence.ts's
 * checkActivationWriterQuiescence already established for the append-
 * barrier token. Verified at source: BackendPublicationCoordinator#locked
 * (backend-publication.ts) skips its own withBackendPublicationLockAsync
 * file-lock acquisition entirely whenever a lockToken is supplied, calling
 * the operation directly after only asserting the token is still active
 * for this root. A caller that already holds that same file lock (the
 * single .lcm.backend-publication.lock flock shared by every consumer,
 * append-barrier and coordinator entry point in that module) and then
 * invokes a coordinator method without forwarding its token would force
 * that method down the withBackendPublicationLockAsync path instead --
 * which blocks acquiring a flock its own caller already holds. That is a
 * process deadlocking against itself, and it is why every coordinator call
 * this module makes -- prepare, resume, and recoverPending alike, forward
 * path and recovery entry point alike -- forwards the exact same token.
 *
 * Assert, never re-acquire, the PostgreSQL fenced lease. Before touching
 * the coordinator at all, this function calls activation-lease.ts's
 * assertActivationLeaseFence once per covered project, using the exact
 * publicationId/targetBackend/evidenceSha256 identity the caller already
 * decided when it acquired those leases. It never calls
 * acquireActivationLease or takeoverActivationLease itself: by the time
 * this step runs, the leases already exist, and reacquiring here would
 * duplicate -- and could race -- whatever already-running lease lifecycle
 * acquired them. See the result type's own doc comment for the exact
 * reach of that assertion.
 *
 * Recovery reads bytes back, never recomputes. Every fresh prepare() this
 * function drives is built from readActivationArtifact's durably persisted
 * bytes -- source config, source project map, target config, target
 * project map, and the exact projects list -- keyed by the caller-supplied
 * identityDigest, never from independently re-observing those files or
 * re-deriving their witnesses. After a process restart the live files may
 * legitimately differ from what was captured when the artifact was
 * sealed; recomputing and hoping the recomputed value still matches is the
 * same failure activation-artifact-store.ts's own module doc comment
 * warns against for a moving identity. The identityDigest itself is also
 * never recomputed here -- it is an opaque caller-supplied lookup key into
 * the artifact store, and this module has no access to the raw file bytes
 * a recomputation would need anyway.
 *
 * Release belongs to the publication, never to this step. This function
 * never implements a release path of its own. BackendPublicationCoordinator
 * #resume's own phase machine (#resumeUnlocked in backend-publication.ts)
 * already frees every project's remote fence via #releaseAll before a
 * journal can reach its completed phase, and a terminal journal that still
 * carried an active fence would be refused outright by that same machine's
 * own invariants. Adding a second release path here would only contend
 * with the one the coordinator already runs.
 *
 * One controlled abort, and only one (plan-v7.1 amendment 3 / A1). The
 * coordinator's prepare() writes the "preparing" journal, then seals the
 * material file, then checkpoints "prepared" with the recovery reference.
 * A crash between the first two leaves a journal whose recoveryReference
 * is null and whose material file is positively absent. That journal can
 * never be resumed (there is no material to authenticate) and must not be
 * driven to a reported abort either: nothing was published, and the same
 * publicationId must be prepared again from the artifact (a fresh id would
 * break the S0 identity chain; see activation-artifact-store.ts). This
 * function therefore calls coordinator.abort(lockToken) for exactly that
 * shape -- the coordinator's own pre-seal branch transitions it straight
 * to "aborted" without restoring anything -- and then prepares again with
 * the same publicationId. A crash after that abort and before the
 * re-prepare leaves the single re-preparable "aborted" shape: recovery
 * reference null, material positively absent, no published config or
 * project-map witness, and the same identity as the artifact. Every other
 * "aborted" journal (an operator abort, or any abort after sealing or
 * publishing) is reported as aborted and never re-prepared. The predicate
 * uses only fields the journal already carries; there is no abort-reason
 * column.
 *
 * A "preparing" journal whose material IS present is the post-seal crash:
 * the coordinator can authenticate it (a null recovery reference skips the
 * digest check), so before resuming this function additionally compares
 * the sealed bytes, byte for byte, against the artifact's own copy
 * (backendPublicationMaterialContent of the artifact's material under this
 * publicationId). Equal -> resume; different -> artifact-identity-mismatch,
 * never a resume of material this activation did not seal.
 *
 * Dispatch (every row below is this publicationId's identity-matching
 * journal, or no journal at all; see steps 2-3 for the other cases):
 *
 * | version-2 journal | action |
 * | --- | --- |
 * | absent, or a terminal journal of another publication (prepare() archives it) | fresh prepare from the artifact, then resume |
 * | preparing, recoveryReference null, material positively absent | fence precheck; abort under the token; fresh prepare with the same publicationId |
 * | preparing, recoveryReference null, material present | fence precheck; sealed bytes equal the artifact -> recoverPending resume; differ -> artifact-identity-mismatch |
 * | aborted, recoveryReference null, material positively absent, no publish witness recorded | fence precheck; fresh prepare with the same publicationId (prepare archives the aborted journal) |
 * | any other aborted | reported as aborted; never re-prepared |
 * | aborting, config-restoring, map-restoring, abort-releasing | recoverPending (the coordinator completes the abort and reconciles fences itself); reported as aborted; no fence precheck |
 * | prepared, acquiring, guarded, map-publishing, map-published, config-publishing, config-published | fence precheck; recoverPending resume |
 * | releasing, released | recoverPending resume with NO fence precheck (plan-v7 A3: the fences are being or have been released; the coordinator still reconciles an expired unreleased fence inside release) |
 * | completed | reported as completed; nothing is driven |
 *
 * A material read that fails for any reason other than a positive ENOENT
 * under the authenticated publication directory is artifact-unresolvable;
 * absence is never guessed. The order is:
 *
 * 1. A repeated localProjectId or remoteProjectId is refused
 *    (duplicate-publication-input) before any I/O.
 * 2. Unlocked read-only peeks: the maintenance journal first, and the
 *    version-2 publication journal only when there is no maintenance
 *    journal. A peek that throws is publication-unresolvable.
 * 3. A non-terminal version-3 maintenance journal is maintenance-in-flight;
 *    the coordinator is not called. A non-terminal version-2 journal of a
 *    different publicationId is publication-collision, returned with that
 *    journal; recoverPending is not called and the other generation is
 *    never driven forward. A version-2 journal of this publicationId whose
 *    sourceBackend, targetBackend or covered projects (localProjectId,
 *    remoteProjectId, evidenceSha256) differ from the input is also
 *    publication-collision, returned with that journal, whatever its
 *    phase: a publicationId alone does not make a journal this
 *    publication's, and a reused id is another generation's journal that
 *    is neither resumed nor reported as this call's result.
 * 4. Lease fences are asserted for every project, except for the rows the
 *    table above marks as having no precheck: a terminal journal (its
 *    fences are already released), the release tail, and the abort family
 *    (the coordinator releases those fences itself as it completes the
 *    abort; a precheck here would refuse a half-released abort forever).
 * 5. A version-2 journal of this publicationId that passes the identity
 *    check is dispatched per the table. Where recoverPending runs, the
 *    journal it returns is held to the same identity check: a same-id
 *    journal that no longer matches is publication-collision, not this
 *    call's result.
 * 6. Every other case (no journal, a terminal version-3 maintenance
 *    journal, or a terminal journal of another publicationId) is a fresh
 *    prepare then resume under the same lockToken. recoverPending is not
 *    called; prepare archives a terminal journal itself.
 *
 * What this does and does not guarantee, stated plainly rather than left
 * to be assumed (the lifetime question: what is checked once here that
 * could change before it is relied on):
 *
 * - Each project's fence assertion above is a single point-in-time read
 *   with no lock, exactly as assertActivationLeaseFence's own doc comment
 *   already states. It establishes, at the moment it runs, that the
 *   fenced-lease row this generation acquired is still active and
 *   matching. It does not hold that fence steady across the awaits this
 *   function performs afterward (recoverPending, prepare, resume all
 *   suspend on real I/O). Between this function's own assertion and the
 *   coordinator's internal use of the same fence, the row could expire or
 *   be taken over by a different generation entirely -- this function has
 *   no mechanism to prevent that and does not claim one.
 * - The real enforcement boundary for that fence is not this function's
 *   pre-flight assertion; it is the coordinator's own private acquireAll
 *   step's own independent readRemoteGuard-then-assertFence call,
 *   performed at the moment it actually consumes the fence to transition
 *   a project into its guarded phase. This function's own assertion
 *   exists to fail fast and attributably before ever touching the
 *   coordinator, not to hold anything the coordinator would otherwise
 *   have to re-check -- and it does re-check, independently, every time.
 * - The BackendPublicationLockToken itself is validated fresh on every
 *   single coordinator call this function makes, so this function does
 *   not need to -- and does not -- independently track whether the token
 *   is still active between its own calls. A caller that revokes the
 *   token while this function's promise is still in flight will see the
 *   next coordinator call this function makes fail closed, not silently
 *   bypass the token check.
 */
export type ActivationPublicationProjectInput = Readonly<{
  localProjectId: string;
  remoteProjectId: string;
  evidenceSha256: string;
}>;

/**
 * The narrow surface this module actually calls on
 * BackendPublicationCoordinator: recoverPending, prepare and resume, each
 * with a required lockToken. A real BackendPublicationCoordinator instance
 * already satisfies this interface structurally (its own lockToken
 * parameters are optional, and a function accepting an optional parameter
 * is assignable wherever that parameter is required), so callers pass it
 * directly; tests inject a plain object instead of constructing a real
 * coordinator with a fake BackendPublicationDriver underneath it.
 */
export interface ActivationPublicationCoordinator {
  recoverPending(
    options: RecoverPendingOptions,
    lockToken: BackendPublicationLockToken,
  ): Promise<BackendPublicationJournal | null>;
  prepare(
    input: PrepareBackendPublicationInput,
    lockToken: BackendPublicationLockToken,
  ): Promise<BackendPublicationJournal>;
  resume(lockToken: BackendPublicationLockToken): Promise<BackendPublicationJournal>;
  /** Used for exactly one shape: a "preparing" journal with no recovery
   * reference and no material file (see the module doc comment). */
  abort(lockToken: BackendPublicationLockToken): Promise<BackendPublicationJournal>;
}

export type ActivationPublicationInput = Readonly<{
  homeDir?: string;
  /** The exact token of an already-active backend-publication lock,
   * acquired by the caller (e.g. via withBackendPublicationConsumerLockAsync)
   * before calling this function. This module never acquires that lock
   * itself -- see the module doc comment for why. */
  lockToken: BackendPublicationLockToken;
  /** The publicationId already decided when this generation's PostgreSQL
   * fenced leases were acquired (activation-lease.ts). Never minted here. */
  publicationId: string;
  sourceBackend: StorageBackendName;
  targetBackend: ActivationLeaseTargetBackend;
  /** Store key for the durably persisted recovery-material record
   * (activation-artifact-store.ts's publishActivationArtifact) this
   * function reads from for a fresh prepare(), rather than re-observing
   * the world. Never recomputed by this function. */
  identityDigest: string;
  /** The projects covered by this publication. Used only to assert each
   * project's already-acquired fenced lease before dispatch; the actual
   * projects list handed to a fresh prepare() comes from the artifact
   * record itself, not from this array. */
  projects: readonly ActivationPublicationProjectInput[];
  now?: Date;
  signal?: AbortSignal;
}>;

export type ActivationPublicationDependencies = Readonly<{
  /** Override the artifact reader. Defaults to readActivationArtifact.
   * Exists so this module's own defensive artifact-missing and
   * artifact-identity-mismatch branches can be exercised with a genuine,
   * deterministic fixture instead of durably writing and then corrupting
   * a real artifact file for every test. */
  readArtifact?: (
    input: Readonly<{ homeDir?: string; identityDigest: string }>,
  ) => ActivationArtifactRecoveryMaterial | null;
  /** Override the read-only version-3 maintenance journal peek. Defaults to
   * readBackendMaintenanceJournal. It returns null both for no journal and
   * for a valid version-2 journal. */
  readMaintenanceJournal?: (homeDir?: string) => BackendMaintenanceJournal | null;
  /** Override the read-only version-2 publication journal peek. Defaults to
   * readBackendPublicationJournal. */
  readPublicationJournal?: (homeDir?: string) => BackendPublicationJournal | null;
  /** Override the attributed presence read of the sealed material file.
   * Defaults to readSealedMaterialContent (ENOENT under the authenticated
   * publication directory is the only positive absence). */
  readSealedMaterial?: (homeDir: string | undefined, publicationId: string) => SealedMaterialRead;
}>;

/** One attributed read of the coordinator's sealed material file. */
export type SealedMaterialRead = Readonly<
  | { kind: "present"; content: string }
  | { kind: "absent" }
  | { kind: "unresolvable"; detail: string }
>;

/** Which dispatch row ran (see the module doc comment's table). null when
 * the call refused before any dispatch. */
export type ActivationPublicationDispatch =
  | "fresh-prepare"
  | "resume"
  /** A "preparing" journal whose material is present: sealed bytes are
   * compared against the artifact before the resume. */
  | "resume-after-material-check"
  | "release-tail"
  | "abort-completion"
  | "controlled-abort-then-prepare"
  | "reprepare-aborted"
  | "terminal-report";

export type ActivationPublicationFenceCheck = Readonly<{
  localProjectId: string;
  remoteProjectId: string;
  assertion: ActivationLeaseAssertResult;
}>;

export type ActivationPublicationStatus =
  | "completed"
  | "aborted"
  | "publication-collision"
  | "fence-unsatisfied"
  | "fence-unresolvable"
  | "artifact-missing"
  | "artifact-unresolvable"
  | "artifact-identity-mismatch"
  | "duplicate-publication-input"
  | "publication-unresolvable"
  | "maintenance-in-flight";

/** Attributed dispatch result. journal is set when the coordinator returned
 * one (completed or aborted) and for a publication-collision, where it is
 * the colliding journal for the caller's diagnosis: either another
 * generation's in-flight journal, or a journal that reuses this
 * publicationId with a different sourceBackend, targetBackend or project
 * coverage. It is null for duplicate-publication-input, publication-unresolvable,
 * maintenance-in-flight and the fence and artifact refusals. fenceChecks
 * lists one lease assertion per project only when the lease loop ran. It is
 * empty for the refusals that precede it (duplicate-publication-input,
 * publication-unresolvable, maintenance-in-flight and a peeked
 * publication-collision) and when a terminal journal of this
 * publicationId is reported without assertions. */
export type ActivationPublicationResult = Readonly<{
  status: ActivationPublicationStatus;
  detail: string;
  journal: BackendPublicationJournal | null;
  fenceChecks: readonly ActivationPublicationFenceCheck[];
  dispatch: ActivationPublicationDispatch | null;
}>;

function buildResult(
  status: ActivationPublicationStatus,
  detail: string,
  journal: BackendPublicationJournal | null,
  fenceChecks: readonly ActivationPublicationFenceCheck[],
  dispatch: ActivationPublicationDispatch | null = null,
): ActivationPublicationResult {
  return Object.freeze({ status, detail, journal, fenceChecks: Object.freeze([...fenceChecks]), dispatch });
}

/** backend-publication.ts's MAX_MATERIAL_BYTES: the bound the coordinator
 * itself seals and authenticates material under. */
const MAX_SEALED_MATERIAL_BYTES = 8 * 1024 * 1024;

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * Read the sealed material file the coordinator's prepare() writes for a
 * publication, attributed: present with its exact bytes, positively absent
 * (ENOENT under the authenticated publication directory), or unresolvable
 * for anything else -- an unauthenticated or changed directory, a
 * permission denial, a multi-link or wrong-mode file, or an error this
 * reader does not recognize. Absence is the only outcome that licenses a
 * controlled abort or a re-prepare, so it is never guessed.
 */
export function readSealedMaterialContent(homeDir: string | undefined, publicationId: string): SealedMaterialRead {
  const directory = backendPublicationDirectory(homeDir);
  const expectedUid = currentUid();
  let handle: PrivateDirectoryHandle;
  try {
    handle = openPrivateDirectory(directory, { expectedUid });
  } catch (error) {
    return { kind: "unresolvable", detail: "the backend publication directory cannot be authenticated: " + (error as Error).message };
  }
  try {
    let outcome;
    try {
      outcome = attributeNullableRead<BoundedFileResult>(() => readBoundedRegularFileWithStat(
        join(directory, publicationId + ".material"),
        {
          allowedRoot: directory,
          maxBytes: MAX_SEALED_MATERIAL_BYTES,
          expectedUid,
          allowedModes: [0o600],
          requireSingleLink: true,
        },
      ));
    } catch (error) {
      return { kind: "unresolvable", detail: "the sealed material could not be read: " + (error as Error).message };
    }
    if (outcome.kind === "unresolvable") {
      return { kind: "unresolvable", detail: "the sealed material could not be read: " + outcome.detail };
    }
    try {
      assertPrivateDirectory(handle, directory, handle.witness, expectedUid);
    } catch (error) {
      return { kind: "unresolvable", detail: "the backend publication directory changed during the read: " + (error as Error).message };
    }
    return outcome.kind === "absent" ? { kind: "absent" } : { kind: "present", content: outcome.value.content };
  } finally {
    handle.close();
  }
}

const RELEASE_TAIL_PHASES: readonly BackendPublicationPhase[] = ["releasing", "released"];
const ABORT_FAMILY_PHASES: readonly BackendPublicationPhase[] = ["aborting", "config-restoring", "map-restoring", "abort-releasing"];

/** The journal-field half of the single re-preparable aborted shape (see
 * the module doc comment): no recovery reference and no publish witness.
 * The other half, a positively absent material file, is read only when
 * this half holds, so an operator abort (reference present, or a publish
 * witness recorded) is reported without touching the material. */
function isPreSealAbortedCandidate(journal: BackendPublicationJournal): boolean {
  return journal.phase === "aborted"
    && journal.recoveryReference === null
    && journal.publishedConfigSha256 === null
    && journal.publishedProjectMapSha256 === null;
}

function projectCoverageKey(
  project: Readonly<{ localProjectId: string; remoteProjectId: string; evidenceSha256: string }>,
): string {
  return JSON.stringify([project.localProjectId, project.remoteProjectId, project.evidenceSha256]);
}

/**
 * Whether the artifact's own projects list covers exactly the same
 * projects (by localProjectId, remoteProjectId and evidenceSha256) as the
 * caller's input -- the set this function just finished asserting fenced
 * leases for. A mismatch here means the artifact this identityDigest
 * resolves to does not correspond to the leases this call actually
 * confirmed, which is a caller-wiring bug this function refuses rather
 * than silently publishing an unrelated project set.
 */
function hasDuplicateProject(projects: readonly ActivationPublicationProjectInput[]): boolean {
  return new Set(projects.map((project) => project.localProjectId)).size !== projects.length
    || new Set(projects.map((project) => project.remoteProjectId)).size !== projects.length;
}

function sameProjectCoverage(
  artifactProjects: readonly ActivationArtifactProjectRecord[],
  inputProjects: readonly ActivationPublicationProjectInput[],
): boolean {
  if (artifactProjects.length !== inputProjects.length) return false;
  const artifactKeys = new Set(artifactProjects.map(projectCoverageKey));
  return inputProjects.every((project) => artifactKeys.has(projectCoverageKey(project)));
}

/**
 * Why a journal carrying this call's publicationId is nevertheless not this
 * publication's journal, or null when it is. A publicationId is only a
 * caller-chosen string; the journal is this publication's only when its
 * sourceBackend, targetBackend and covered projects also agree with the
 * input. A journal that reuses the id for a different migration must not
 * be resumed (recoverPending would drive that other journal forward) and
 * its terminal phase must not be reported as this call's outcome.
 */
function journalIdentityMismatch(
  journal: BackendPublicationJournal,
  input: ActivationPublicationInput,
): string | null {
  if (journal.sourceBackend !== input.sourceBackend) {
    return "sourceBackend " + journal.sourceBackend + " rather than " + input.sourceBackend;
  }
  if (journal.targetBackend !== input.targetBackend) {
    return "targetBackend " + journal.targetBackend + " rather than " + input.targetBackend;
  }
  if (!sameProjectCoverage(journal.projects, input.projects)) {
    return "a different set of covered projects than this call's fenced leases";
  }
  return null;
}

function reusedIdCollisionDetail(origin: string, journal: BackendPublicationJournal, mismatch: string): string {
  return origin + " reuses publicationId " + journal.publicationId + " at phase " + journal.phase +
    " but names " + mismatch + "; it is another generation's journal, and this function refuses to resume it " +
    "or to report it as this publication's result";
}

/**
 * Drive a version-2 backend publication for migration activation to
 * completion (or a confirmed abort), under a single retained lock token.
 * See the module doc comment for the full contract, including exactly
 * what this function does and does not guarantee across its own await
 * boundaries.
 */
export async function driveActivationPublication(
  guard: ActivationLeasePublicationGuard,
  coordinator: ActivationPublicationCoordinator,
  input: ActivationPublicationInput,
  dependencies: ActivationPublicationDependencies = {},
): Promise<ActivationPublicationResult> {
  const readArtifact = dependencies.readArtifact ?? readActivationArtifact;
  const readMaintenanceJournal = dependencies.readMaintenanceJournal ?? readBackendMaintenanceJournal;
  const readPublicationJournal = dependencies.readPublicationJournal ?? readBackendPublicationJournal;
  const readSealedMaterial = dependencies.readSealedMaterial ?? readSealedMaterialContent;

  const fenceChecks: ActivationPublicationFenceCheck[] = [];

  // Caller-wiring refusal first, before any I/O: a repeated local or remote
  // project id (normalizeProjects rejects the same shape for the artifact).
  if (hasDuplicateProject(input.projects)) {
    return buildResult(
      "duplicate-publication-input",
      "the covered projects repeat a localProjectId or a remoteProjectId; each project must appear exactly once",
      null,
      fenceChecks,
    );
  }

  // Read-only peeks, unlocked: the journal file is single, and every path
  // below that mutates or reports success re-enters the coordinator under
  // the retained token, which asserts it. A stale peek therefore fails
  // closed (prepare refuses a non-terminal journal) rather than mutating.
  let maintenance: BackendMaintenanceJournal | null;
  let existing: BackendPublicationJournal | null = null;
  try {
    maintenance = readMaintenanceJournal(input.homeDir);
    if (maintenance === null) existing = readPublicationJournal(input.homeDir);
  } catch (error) {
    return buildResult(
      "publication-unresolvable",
      "the live backend publication journal could not be read: " + (error as Error).message,
      null,
      fenceChecks,
    );
  }
  if (maintenance !== null && !isTerminalBackendMaintenancePhase(maintenance.phase)) {
    return buildResult(
      "maintenance-in-flight",
      "the backend is held for migration maintenance (journal phase " + maintenance.phase + "); " +
        "version-2 publication can only follow a terminal maintenance phase (selection-completed or maintenance-aborted)",
      null,
      fenceChecks,
    );
  }
  const existingTerminal = existing !== null && (existing.phase === "completed" || existing.phase === "aborted");
  if (existing !== null && existing.publicationId !== input.publicationId && !existingTerminal) {
    return buildResult(
      "publication-collision",
      "an unrelated backend publication (" + existing.publicationId + ") is already in flight at phase " +
        existing.phase + "; this coordinator tracks exactly one publication journal at a time and " +
        "refuses to drive a different generation's journal forward",
      existing,
      fenceChecks,
    );
  }
  const sameIdJournal = existing !== null && existing.publicationId === input.publicationId ? existing : null;
  if (sameIdJournal !== null) {
    const mismatch = journalIdentityMismatch(sameIdJournal, input);
    if (mismatch !== null) {
      return buildResult(
        "publication-collision",
        reusedIdCollisionDetail("the live backend publication journal", sameIdJournal, mismatch),
        sameIdJournal,
        fenceChecks,
      );
    }
  }

  // Classify the same-id journal's phase into a dispatch row first (see the
  // module doc comment's table), because the row decides whether the fence
  // precheck runs at all.
  const phase = sameIdJournal?.phase ?? null;
  let sealed: SealedMaterialRead | null = null;
  const needsMaterialRead = sameIdJournal !== null && (
    (phase === "preparing" && sameIdJournal.recoveryReference === null)
    || isPreSealAbortedCandidate(sameIdJournal)
  );
  if (needsMaterialRead) {
    sealed = readSealedMaterial(input.homeDir, input.publicationId);
    if (sealed.kind === "unresolvable") {
      return buildResult(
        "artifact-unresolvable",
        "the sealed material for publication " + input.publicationId + " at journal phase " + phase +
          " could not be attributed as present or absent: " + sealed.detail,
        sameIdJournal,
        fenceChecks,
      );
    }
  }
  let row: ActivationPublicationDispatch;
  if (sameIdJournal === null) {
    row = "fresh-prepare";
  } else if (phase === "completed") {
    row = "terminal-report";
  } else if (phase === "aborted") {
    row = sealed !== null && sealed.kind === "absent" ? "reprepare-aborted" : "terminal-report";
  } else if (phase === "preparing" && sameIdJournal.recoveryReference === null) {
    row = sealed!.kind === "absent" ? "controlled-abort-then-prepare" : "resume-after-material-check";
  } else if (RELEASE_TAIL_PHASES.includes(phase!)) {
    row = "release-tail";
  } else if (ABORT_FAMILY_PHASES.includes(phase!)) {
    row = "abort-completion";
  } else {
    row = "resume";
  }

  if (row === "terminal-report") {
    return buildResult(
      phase === "aborted" ? "aborted" : "completed",
      "the existing backend publication journal for " + input.publicationId + " is already terminal at phase " +
        phase + (phase === "aborted" ? "; it is not the pre-seal shape and is never re-prepared" : ""),
      sameIdJournal,
      fenceChecks,
      row,
    );
  }

  // Fence precheck: every row that will acquire or consume this
  // generation's fences asserts them first. The release tail and the abort
  // family skip it (plan-v7 A3): their fences are being released by the
  // coordinator itself, which reconciles an expired unreleased fence inside
  // release, and a precheck would refuse a half-released journal forever.
  if (row !== "release-tail" && row !== "abort-completion") {
    for (const project of input.projects) {
      const assertion = await assertActivationLeaseFence(guard, {
        projectId: project.remoteProjectId,
        publicationId: input.publicationId,
        targetBackend: input.targetBackend,
        evidenceSha256: project.evidenceSha256,
        signal: input.signal,
      });
      fenceChecks.push({
        localProjectId: project.localProjectId,
        remoteProjectId: project.remoteProjectId,
        assertion,
      });
    }

    const unresolvable = fenceChecks.find((check) => check.assertion.status === "unresolvable");
    if (unresolvable !== undefined) {
      return buildResult(
        "fence-unresolvable",
        "the fenced lease for project " + unresolvable.remoteProjectId + " could not be attributed: " +
          unresolvable.assertion.detail,
        null,
        fenceChecks,
      );
    }
    const unsatisfied = fenceChecks.find((check) => check.assertion.status === "unsatisfied");
    if (unsatisfied !== undefined) {
      return buildResult(
        "fence-unsatisfied",
        "the fenced lease for project " + unsatisfied.remoteProjectId + " is not active and matching: " +
          unsatisfied.assertion.detail,
        null,
        fenceChecks,
      );
    }
  }

  // Every covered project's fence was independently confirmed active and
  // matching immediately above -- but see the module doc comment's
  // lifetime analysis: that confirmation does not survive the awaits
  // below, and the coordinator's own acquireAll step independently
  // re-checks the same fences at the moment it actually consumes them.
  if (row === "resume" || row === "release-tail" || row === "abort-completion") {
    const recovered = await coordinator.recoverPending({ disposition: "resume" }, input.lockToken);
    if (recovered !== null && recovered.publicationId === input.publicationId) {
      const mismatch = journalIdentityMismatch(recovered, input);
      if (mismatch !== null) {
        return buildResult(
          "publication-collision",
          reusedIdCollisionDetail("the backend publication journal recoverPending returned", recovered, mismatch),
          recovered,
          fenceChecks,
        );
      }
      return buildResult(
        recovered.phase === "aborted" ? "aborted" : "completed",
        "the existing backend publication journal for " + recovered.publicationId + " was driven to phase " +
          recovered.phase,
        recovered,
        fenceChecks,
        row,
      );
    }
    if (recovered !== null && recovered.phase !== "completed" && recovered.phase !== "aborted") {
      return buildResult(
        "publication-collision",
        "an unrelated backend publication (" + recovered.publicationId + ") is already in flight at phase " +
          recovered.phase + "; this coordinator tracks exactly one publication journal at a time and " +
          "refuses to drive a different generation's journal forward",
        recovered,
        fenceChecks,
      );
    }
    // The journal vanished (or another terminal one appeared) between the
    // peek and recoverPending: fall through to a fresh dispatch.
    row = "fresh-prepare";
  }

  // Fresh dispatch (and the two re-prepare rows): there is no live journal
  // of this publication, or only a terminal one that prepare() archives
  // itself before writing the new one (an unrelated terminal version-2
  // journal, a terminal selection-completed / maintenance-aborted
  // version-3 maintenance journal, or this publication's own pre-seal
  // aborted journal). Every prepare() is built from the artifact's bytes.
  let artifact: ActivationArtifactRecoveryMaterial | null;
  try {
    artifact = readArtifact({ homeDir: input.homeDir, identityDigest: input.identityDigest });
  } catch (error) {
    if (error instanceof ActivationArtifactPresenceUnresolvableError) {
      return buildResult("artifact-unresolvable", error.message, null, fenceChecks);
    }
    if (error instanceof ActivationArtifactIdentityMismatchError) {
      return buildResult("artifact-identity-mismatch", error.message, null, fenceChecks);
    }
    throw error;
  }
  if (artifact === null) {
    return buildResult(
      "artifact-missing",
      "no activation artifact is durably persisted at identity digest " + input.identityDigest + "; " +
        "publishActivationArtifact must seal the recovery material before this function can prepare a fresh publication",
      null,
      fenceChecks,
    );
  }
  if (artifact.publicationId !== input.publicationId) {
    return buildResult(
      "artifact-identity-mismatch",
      "the activation artifact at identity digest " + input.identityDigest + " was sealed under publicationId " +
        artifact.publicationId + ", which does not match this call's expected publicationId " +
        input.publicationId,
      null,
      fenceChecks,
    );
  }
  if (!sameProjectCoverage(artifact.projects, input.projects)) {
    return buildResult(
      "artifact-identity-mismatch",
      "the activation artifact at identity digest " + input.identityDigest + " covers a different set of " +
        "projects than the fenced leases this call just asserted",
      null,
      fenceChecks,
    );
  }

  const material: BackendPublicationRecoveryMaterial = { source: artifact.source, target: artifact.target };

  if (row === "resume-after-material-check") {
    // The post-seal "preparing" crash: the material file exists but the
    // journal never recorded its reference. The coordinator would
    // authenticate it on resume (a null reference skips the digest check),
    // so this function first proves the sealed bytes are this activation's
    // own: byte identity against the artifact's copy, never a resume of
    // material this activation did not seal.
    const expected = backendPublicationMaterialContent(artifact.publicationId, material);
    if (sealed!.kind !== "present" || sealed!.content !== expected) {
      return buildResult(
        "artifact-identity-mismatch",
        "the sealed material for publication " + input.publicationId + " (journal phase preparing, no recovery " +
          "reference) is not byte-identical to the activation artifact's recovery material; refusing to resume it",
        sameIdJournal,
        fenceChecks,
        row,
      );
    }
    const recovered = await coordinator.recoverPending({ disposition: "resume" }, input.lockToken);
    if (recovered === null || recovered.publicationId !== input.publicationId || journalIdentityMismatch(recovered, input) !== null) {
      return buildResult(
        "publication-collision",
        "the backend publication journal recoverPending returned after the sealed-material check is not this " +
          "publication's journal; refusing to report it as this publication's result",
        recovered,
        fenceChecks,
        row,
      );
    }
    return buildResult(
      recovered.phase === "aborted" ? "aborted" : "completed",
      "the sealed material matched the activation artifact and the existing backend publication journal for " +
        recovered.publicationId + " was driven to phase " + recovered.phase,
      recovered,
      fenceChecks,
      row,
    );
  }

  if (row === "controlled-abort-then-prepare") {
    // The pre-seal "preparing" crash: no reference, no material. The
    // coordinator's own pre-seal abort branch transitions it straight to
    // "aborted" (nothing to restore), after which prepare() archives that
    // terminal journal and seals fresh material under the SAME
    // publicationId. A crash between these two calls leaves the
    // re-preparable aborted shape the next call recognizes.
    const aborted = await coordinator.abort(input.lockToken);
    if (aborted.phase !== "aborted" || aborted.publicationId !== input.publicationId) {
      return buildResult(
        "publication-unresolvable",
        "the controlled pre-seal abort of publication " + input.publicationId + " did not reach phase aborted (" +
          aborted.publicationId + " at " + aborted.phase + "); refusing to re-prepare over it",
        aborted,
        fenceChecks,
        row,
      );
    }
  }

  await coordinator.prepare(
    {
      publicationId: artifact.publicationId,
      sourceBackend: input.sourceBackend,
      targetBackend: input.targetBackend,
      material,
      projects: artifact.projects,
      now: input.now,
    },
    input.lockToken,
  );
  const resumed = await coordinator.resume(input.lockToken);
  return buildResult(
    resumed.phase === "aborted" ? "aborted" : "completed",
    "a fresh backend publication journal for " + resumed.publicationId + " was prepared and driven to phase " +
      resumed.phase + (row === "fresh-prepare" ? "" : " (" + row + ")"),
    resumed,
    fenceChecks,
    row,
  );
}
