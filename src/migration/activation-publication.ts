import {
  type BackendPublicationJournal,
  type BackendPublicationLockToken,
  type BackendPublicationRecoveryMaterial,
  type PrepareBackendPublicationInput,
  type RecoverPendingOptions,
} from "../storage/backend-publication.js";
import type { StorageBackendName } from "../storage/contracts.js";
import {
  assertActivationLeaseFence,
  type ActivationLeaseAssertResult,
  type ActivationLeasePublicationGuard,
  type ActivationLeaseTargetBackend,
} from "./activation-lease.js";
import {
  readActivationArtifact,
  ActivationArtifactPresenceUnresolvableError,
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
 * never calls coordinator.abort() and never implements a release path of
 * its own. BackendPublicationCoordinator#resume's own phase machine
 * (#resumeUnlocked in backend-publication.ts) already frees every
 * project's remote fence via #releaseAll before a journal can reach its
 * completed phase, and a terminal journal that still carried an active
 * fence would be refused outright by that same machine's own invariants.
 * Adding a second release path here would only contend with the one the
 * coordinator already runs.
 *
 * Dispatch resume versus a fresh prepare correctly. This function never
 * calls prepare() a second time on top of a publication that is already in
 * flight. It always calls coordinator.recoverPending first, with a resume
 * disposition: verified at source, recoverPending reads the one on-disk
 * publication journal this coordinator tracks and returns null only when
 * none exists, driving anything it does find to completion (or through an
 * in-progress abort) instead. A null result, or a result whose
 * publicationId does not match this call's own (a leftover terminal
 * journal from an unrelated prior generation -- see
 * BackendPublicationCoordinator#prepare's own existing-journal handling,
 * which archives exactly that shape before creating a fresh one), is what
 * triggers this function's own fresh prepare-then-resume dispatch. A
 * mismatched non-terminal journal is a genuine collision this function
 * refuses rather than silently driving forward on another generation's
 * behalf; see ActivationPublicationStatus's publication-collision member.
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
}>;

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
  | "artifact-identity-mismatch";

/** Attributed dispatch result. journal is populated whenever the
 * coordinator was actually invoked and returned one (including a
 * publication-collision journal belonging to the colliding generation,
 * included for the caller's own diagnosis); fenceChecks always carries
 * every project's individual lease assertion, regardless of outcome. */
export type ActivationPublicationResult = Readonly<{
  status: ActivationPublicationStatus;
  detail: string;
  journal: BackendPublicationJournal | null;
  fenceChecks: readonly ActivationPublicationFenceCheck[];
}>;

function buildResult(
  status: ActivationPublicationStatus,
  detail: string,
  journal: BackendPublicationJournal | null,
  fenceChecks: readonly ActivationPublicationFenceCheck[],
): ActivationPublicationResult {
  return Object.freeze({ status, detail, journal, fenceChecks: Object.freeze([...fenceChecks]) });
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
function sameProjectCoverage(
  artifactProjects: readonly ActivationArtifactProjectRecord[],
  inputProjects: readonly ActivationPublicationProjectInput[],
): boolean {
  if (artifactProjects.length !== inputProjects.length) return false;
  const artifactKeys = new Set(artifactProjects.map(projectCoverageKey));
  return inputProjects.every((project) => artifactKeys.has(projectCoverageKey(project)));
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

  const fenceChecks: ActivationPublicationFenceCheck[] = [];
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

  // Every covered project's fence was independently confirmed active and
  // matching immediately above -- but see the module doc comment's
  // lifetime analysis: that confirmation does not survive the awaits
  // below, and the coordinator's own acquireAll step independently
  // re-checks the same fences at the moment it actually consumes them.
  const recovered = await coordinator.recoverPending({ disposition: "resume" }, input.lockToken);
  if (recovered !== null && recovered.publicationId === input.publicationId) {
    return buildResult(
      recovered.phase === "aborted" ? "aborted" : "completed",
      "the existing backend publication journal for " + recovered.publicationId + " was driven to phase " +
        recovered.phase,
      recovered,
      fenceChecks,
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

  // No journal for this publicationId exists: either recoverPending found
  // nothing at all, or it found (and left alone) a terminal journal
  // belonging to an unrelated prior generation -- prepare() below reads
  // and archives that terminal journal itself before creating a fresh
  // one, exactly as the coordinator's own prepare() already does for any
  // terminal existing journal. This is a fresh dispatch, never a second
  // prepare() on top of one already in flight: recoverPending above
  // already proved there is no such in-flight journal for this
  // publicationId.
  let artifact: ActivationArtifactRecoveryMaterial | null;
  try {
    artifact = readArtifact({ homeDir: input.homeDir, identityDigest: input.identityDigest });
  } catch (error) {
    if (error instanceof ActivationArtifactPresenceUnresolvableError) {
      return buildResult("artifact-unresolvable", error.message, null, fenceChecks);
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
      resumed.phase,
    resumed,
    fenceChecks,
  );
}
