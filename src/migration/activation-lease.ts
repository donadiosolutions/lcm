import {
  PostgreSqlBackendPublicationGuardError,
  type PostgreSqlBackendPublicationAcquireInput,
  type PostgreSqlBackendPublicationFence,
  type PostgreSqlBackendPublicationMutationInput,
  type PostgreSqlBackendPublicationTarget,
} from "../storage/postgresql/publication-guard.js";
import { PostgreSqlStorageOperationError } from "../storage/postgresql/errors.js";
import {
  attributeNullableReadAsync,
  type NullableReadClassification,
  type NullableReadOutcome,
} from "./activation-absence.js";

/**
 * The PostgreSQL publication-lease lifecycle for migration activation.
 *
 * Backend selection is configured per LCM home and installation, not per
 * project, but the fencing primitive underneath it
 * (PostgreSqlBackendPublicationGuard, backed by lcm.fenced_leases) is
 * project-scoped by construction -- every one of its queries filters on
 * project_id (see publication-guard.ts's lockLeaseSql/selectLeaseSql).
 * Activation therefore holds one lease per covered project, never one
 * lease for the installation; every function in this module operates on
 * exactly one project per call, and a caller covering N projects calls
 * these functions N times (mirroring the per-project loop
 * BackendPublicationCoordinator#acquireAll itself uses in
 * ../storage/backend-publication.ts).
 *
 * Mint before acquire. The publicationId and each project's
 * evidenceSha256 are decided before any lease exists (see
 * activation-artifact-store.ts's publishActivationArtifact, whose
 * identity digest deliberately excludes publicationId so a crash-and-
 * retry recomputes the same artifact identity and recovers the same
 * publicationId). This module never mints either value itself; every
 * input here consumes them as already-decided identity, exactly as
 * PostgreSqlBackendPublicationGuard's own inputs do.
 *
 * Acquire vs. renew vs. takeover -- three different preconditions, never
 * collapsed into one. Confirmed by reading
 * PostgreSqlBackendPublicationGuard#acquire/#renew/#release directly
 * (publication-guard.ts) rather than assumed:
 *
 * - acquireActivationLease (guard.acquire(), no expectedFencingToken): a
 *   fresh lease, or an idempotent no-op reacquire of this exact
 *   generation's own still-unexpired lease. It never revives an expired
 *   lease (the guard throws "fence-expired" for that) and it always
 *   refuses a differently-identified, unreleased row regardless of that
 *   row's expiry ("publication-conflict") -- an unreleased row answers a
 *   conflict to any other generation; expiry never makes it free.
 * - renewActivationLease (guard.renew()): requires the exact fencingToken
 *   already known to the caller AND an unexpired, unreleased row (the
 *   guard's own UPDATE ... WHERE requires `released_at IS NULL AND
 *   expires_at > statement_timestamp()`). It cannot revive an expired
 *   lease under any circumstance; the guard folds every mismatch (no row,
 *   wrong generation, released, expired, or a stale token) into one
 *   generic "fence-mismatch", so this function reads the row back and
 *   attributes exactly which one applies rather than reporting a single
 *   undifferentiated failure.
 * - takeoverActivationLease (guard.acquire() WITH expectedFencingToken):
 *   the only path that can revive an expired, unreleased lease, and only
 *   for the *same* generation (matching machineId, publicationId,
 *   targetBackend and evidenceSha256) -- a different generation is always
 *   "publication-conflict" no matter what token is supplied. The
 *   compare-and-swap is PostgreSQL's own: the guard's UPDATE carries
 *   `WHERE ... AND fencing_token = $8` evaluated atomically under the
 *   row lock the same transaction already took with `SELECT ... FOR
 *   UPDATE`. See this module's own report to the owner for the full
 *   lifetime analysis of what that compare-and-swap does and does not
 *   guarantee across the caller's own await boundaries.
 *
 * Assert, never re-acquire, at publication time.
 * assertActivationLeaseFence reads the current row and compares it
 * against exactly the fields BackendPublicationCoordinator's own private
 * assertFence function compares (confirmed by reading assertFence in
 * ../storage/backend-publication.ts): publicationId, targetBackend,
 * evidenceSha256, and projectId. It deliberately does NOT compare
 * machineId (assertFence never reads it) and does NOT compare the
 * fencingToken's *value* against any expectation (assertFence only
 * validates that the token's string form is a well-formed non-negative
 * integer; this module's guard-typed fencingToken is already a bigint by
 * construction, so that shape check is redundant here and is not
 * reimplemented -- see the module's report for why this was verified
 * rather than assumed). This function never calls guard.acquire(); a
 * caller that needs to acquire must call acquireActivationLease or
 * takeoverActivationLease explicitly.
 *
 * Release belongs to the publication, not to this module, except for one
 * carve-out. See releaseActivationLease's own doc comment for the exact,
 * narrow reason a release surface exists here at all.
 *
 * Nullable reads. The fenced-lease row read
 * (PostgreSqlBackendPublicationGuard#read) is the one this module routes
 * through activation-absence.ts's attributeNullableReadAsync: a read that
 * completed and found no row is "absent" (safe to acquire fresh); a read
 * that could not be completed at all -- insufficient privilege, a
 * connection failure, or a statement timeout, none of which are Node
 * filesystem errno codes -- is "unresolvable" and this module refuses to
 * report absence for it. See classifyPostgreSqlFenceReadFailure below for
 * the exact PostgreSQL-specific mapping and the reasoning behind each
 * branch.
 */

export type ActivationLeaseTargetBackend = PostgreSqlBackendPublicationTarget;
export type ActivationLeaseFence = PostgreSqlBackendPublicationFence;

/**
 * The narrow surface this module actually calls on
 * PostgreSqlBackendPublicationGuard: acquire, renew, release and read.
 * A real PostgreSqlBackendPublicationGuard instance (e.g.
 * PostgreSqlRuntime#backendPublicationGuard()) already satisfies this
 * interface structurally, so callers pass it directly; tests inject a
 * plain object instead of constructing a full guard with a fake
 * PostgreSqlBackendPublicationControlExecutor underneath it.
 */
export interface ActivationLeasePublicationGuard {
  acquire(input: PostgreSqlBackendPublicationAcquireInput): Promise<PostgreSqlBackendPublicationFence>;
  renew(
    input: PostgreSqlBackendPublicationMutationInput & Readonly<{ ttlMs: number }>,
  ): Promise<PostgreSqlBackendPublicationFence>;
  release(input: PostgreSqlBackendPublicationMutationInput): Promise<PostgreSqlBackendPublicationFence>;
  read(
    input: Pick<PostgreSqlBackendPublicationMutationInput, "projectId" | "targetBackend" | "evidenceSha256" | "signal">,
    operation?: string,
  ): Promise<PostgreSqlBackendPublicationFence | null>;
}

/**
 * Classify a caught error from a fenced-lease row read against the
 * PostgreSQL-specific vocabulary for "the read could not be completed",
 * as distinct from Node filesystem errno codes -- activation-absence.ts's
 * default classifier (classifyNodeFsAbsence) does not apply here:
 * PostgreSQL failures never carry ENOENT/EACCES. Every mapping below is a
 * judgment about this exact call site (a single, non-transactional
 * SELECT against lcm.fenced_leases via
 * PostgreSqlBackendPublicationGuard#read), confirmed by reading
 * ../storage/postgresql/errors.ts and runtime.ts's queryDirect rather
 * than assumed, and is deliberately narrow rather than an attempt at an
 * exhaustive PostgreSQL error taxonomy:
 *
 * - sqlState "42501" (insufficient_privilege): the connected role could
 *   not SELECT lcm.fenced_leases. This is a definite, attributable
 *   "could not look", never "absent".
 * - error.retryable === true: PostgreSqlStorageOperationError already
 *   computes this at construction, from the *original* unwrapped error,
 *   via isRetryablePostgreSqlError (see ../storage/postgresql/errors.ts).
 *   That helper's own definition of "retryable" already covers every
 *   SQLSTATE class 08 connection exception, the three admin/crash/
 *   cannot-connect-now termination codes (57P01/57P02/57P03),
 *   serialization failure, deadlock and too-many-connections
 *   (40001/40P01/53300), and raw transport failures (ECONNREFUSED,
 *   ETIMEDOUT, etc.) or known driver disconnect messages that never carry
 *   a SQLSTATE at all. Reusing that existing definition here -- rather
 *   than re-deriving a parallel list -- means this classifier never
 *   drifts from what the rest of the codebase already calls retryable.
 *   All of these mean the read could not be completed, never that the
 *   row is confirmed absent.
 * - sqlState "57014" (query_canceled): NOT covered by .retryable in this
 *   codebase's existing classification (RETRYABLE_SQLSTATES in
 *   errors.ts lists only 40001/40P01/53300). This read runs as a single
 *   statement under the connection's configured statement_timeout with
 *   no other cancellation source anywhere in this call path, so a
 *   query_canceled observed here is attributed to that timeout. This is
 *   a judgment about this specific call site, not a universal decoding
 *   of 57014 (the same SQLSTATE also covers an operator's manual
 *   pg_cancel_backend, which this module has no way to distinguish from
 *   a timeout and does not attempt to).
 *
 * Anything else -- including an error that is not a
 * PostgreSqlStorageOperationError at all, such as
 * PostgreSqlBackendPublicationGuardError's own "invalid-row" or
 * "invalid-input" reasons (which signal corrupt stored data or a caller
 * bug, never an inability to read) -- is left unrecognized here and
 * propagates unchanged, per attributeNullableReadAsync's contract.
 */
export function classifyPostgreSqlFenceReadFailure(error: unknown): NullableReadClassification | undefined {
  if (!(error instanceof PostgreSqlStorageOperationError)) return undefined;
  if (error.sqlState === "42501") {
    return {
      kind: "unresolvable",
      cause: "insufficient-privilege",
      detail: "postgresql denied the fenced-lease read with sqlstate 42501 (insufficient_privilege); "
        + "permission was denied, so absence cannot be concluded",
    };
  }
  if (error.retryable) {
    return {
      kind: "unresolvable",
      cause: "connection-failure",
      detail: `the fenced-lease read could not be completed: ${error.message}`,
    };
  }
  if (error.sqlState === "57014") {
    return {
      kind: "unresolvable",
      cause: "statement-timeout",
      detail: "the fenced-lease read was canceled with sqlstate 57014 (query_canceled), attributed here "
        + "to the connection's statement_timeout for this call site",
    };
  }
  return undefined;
}

function fenceReadWhenNull(projectId: string, targetBackend: ActivationLeaseTargetBackend): Readonly<{ cause: string; detail: string }> {
  return {
    cause: "not-found",
    detail: `no fenced-lease row exists for project ${projectId} under target backend ${targetBackend}`,
  };
}

export type ActivationLeaseReadInput = Readonly<{
  projectId: string;
  targetBackend: ActivationLeaseTargetBackend;
  evidenceSha256: string;
  signal?: AbortSignal;
}>;

/**
 * Read the current fenced-lease row for one project, attributed through
 * activation-absence.ts so a successful read that found nothing is never
 * conflated with a read that could not be completed. This is the primitive
 * both assertActivationLeaseFence and every mutation wrapper's own
 * failure-diagnosis path in this module are built on; there is exactly one
 * place in this module that calls guard.read().
 *
 * One sharp edge, verified at source rather than assumed: guard.read()
 * itself validates the returned row's targetBackend and evidenceSha256
 * against exactly the values passed in input (see exactFence in
 * publication-guard.ts), and THROWS PostgreSqlBackendPublicationGuardError
 * ("invalid-row") instead of returning a non-matching row -- it never
 * returns a "present" fence whose targetBackend or evidenceSha256 differs
 * from what this call asked for. A caller that already knows those two
 * fields are correct for the row it expects (the common case) is
 * unaffected. A caller that needs to tolerate a stored row belonging to a
 * genuinely different generation -- including one that differs
 * specifically in targetBackend or evidenceSha256, not just machineId or
 * publicationId -- must use resolveActivationLeaseFence below instead,
 * which catches exactly that throw.
 */
export async function readActivationLeaseFence(
  guard: ActivationLeasePublicationGuard,
  input: ActivationLeaseReadInput,
): Promise<NullableReadOutcome<ActivationLeaseFence>> {
  return attributeNullableReadAsync(() => guard.read(input), {
    whenNull: fenceReadWhenNull(input.projectId, input.targetBackend),
    classifyError: classifyPostgreSqlFenceReadFailure,
  });
}

/** Outcome of resolveActivationLeaseFence: present, absent, unresolvable,
 * or a stored row that exists but cannot be trusted as matching the
 * caller's expected targetBackend/evidenceSha256 identity. See
 * resolveActivationLeaseFence's own doc comment for why "identity-mismatch"
 * is a fourth, distinct outcome rather than being folded into "present"
 * (with a mismatched fence) or "unresolvable". */
export type ActivationLeaseFenceResolution =
  | Readonly<{ kind: "present"; fence: ActivationLeaseFence }>
  | Readonly<{ kind: "absent"; detail: string }>
  | Readonly<{ kind: "identity-mismatch"; detail: string }>
  | Readonly<{ kind: "unresolvable"; detail: string }>;

/**
 * Resolve the fenced-lease row for one project, tolerating a stored row
 * that belongs to a different generation instead of letting
 * PostgreSqlBackendPublicationGuard#read's own internal validation throw
 * uncaught.
 *
 * Verified at source: PostgreSqlBackendPublicationGuard#read's SQL only
 * filters by project_id/resource_type/resource_key -- it does not filter
 * by targetBackend or evidenceSha256 at the database level, since those
 * two fields are encoded inside the row's own `operation` text column,
 * not separate columns. The row it fetches is then passed through
 * exactFence, which throws PostgreSqlBackendPublicationGuardError
 * ("invalid-row") when the row's decoded targetBackend or evidenceSha256
 * does not match the caller's input, rather than returning that differing
 * row for inspection. A different-generation conflict that happens to
 * differ in targetBackend or evidenceSha256 (as opposed to machineId or
 * publicationId, neither of which read() validates at all) therefore
 * surfaces as a thrown exception from read() itself, not as an
 * attributable "present" outcome a caller could compare against its own
 * expected identity. This function is what makes that survivable for
 * renewActivationLease, releaseActivationLease and
 * assertActivationLeaseFence: it catches exactly that "invalid-row" throw
 * and reports it as "identity-mismatch".
 *
 * This is deliberately imprecise in one way that is disclosed rather than
 * hidden: exactFence's "invalid-row" reason is also used for genuinely
 * corrupt stored row data (an unparseable owner_machine_id, a malformed
 * operation identity string, and so on -- see storedFenceFromRow in
 * publication-guard.ts), and nothing in the thrown error distinguishes
 * "this row belongs to a different generation" from "this row's data is
 * corrupt". Both are reported here as "identity-mismatch", because both
 * mean the same thing to this function's callers: the stored row cannot
 * be trusted as the caller's own generation's fence.
 */
export async function resolveActivationLeaseFence(
  guard: ActivationLeasePublicationGuard,
  input: ActivationLeaseReadInput,
): Promise<ActivationLeaseFenceResolution> {
  try {
    const outcome = await readActivationLeaseFence(guard, input);
    if (outcome.kind === "present") return { kind: "present", fence: outcome.value };
    if (outcome.kind === "absent") return { kind: "absent", detail: outcome.detail };
    return { kind: "unresolvable", detail: outcome.detail };
  } catch (error) {
    if (error instanceof PostgreSqlBackendPublicationGuardError && error.reason === "invalid-row") {
      return {
        kind: "identity-mismatch",
        detail: `a fenced-lease row exists for project ${input.projectId} but does not match the expected `
          + `target backend (${input.targetBackend}) and/or evidence digest; PostgreSqlBackendPublicationGuard`
          + "#read refuses to return a non-matching row for inspection, so this cannot be distinguished from "
          + "corrupt stored row data",
      };
    }
    throw error;
  }
}

export type ActivationLeaseAcquireInput = Omit<PostgreSqlBackendPublicationAcquireInput, "expectedFencingToken">;

export type ActivationLeaseAcquireResult =
  | Readonly<{ status: "acquired"; fence: ActivationLeaseFence }>
  | Readonly<{ status: "conflict"; detail: string }>
  | Readonly<{ status: "expired-needs-takeover"; detail: string }>
  | Readonly<{ status: "unresolvable"; detail: string }>;

/**
 * Acquire (or idempotently reacquire this exact generation's own
 * still-unexpired) lease for one project. Never revives an expired lease
 * -- see takeoverActivationLease for that path -- and never displaces a
 * differently-identified, unreleased row regardless of its expiry.
 */
export async function acquireActivationLease(
  guard: ActivationLeasePublicationGuard,
  input: ActivationLeaseAcquireInput,
): Promise<ActivationLeaseAcquireResult> {
  try {
    const fence = await guard.acquire(input);
    return { status: "acquired", fence };
  } catch (error) {
    if (error instanceof PostgreSqlBackendPublicationGuardError) {
      if (error.reason === "publication-conflict") {
        return {
          status: "conflict",
          detail: `project ${input.projectId} is actively held by a different publication generation`,
        };
      }
      if (error.reason === "fence-expired") {
        return {
          status: "expired-needs-takeover",
          detail: `project ${input.projectId} has an expired, unreleased lease for this exact generation; `
            + "ordinary acquire cannot revive it -- read the fence and call takeoverActivationLease with its "
            + "fencingToken",
        };
      }
      if (error.reason === "readback-mismatch") {
        return {
          status: "unresolvable",
          detail: `the acquire commit outcome for project ${input.projectId} is ambiguous and readback did `
            + "not confirm it",
        };
      }
    }
    throw error;
  }
}

export type ActivationLeaseIdentity = Readonly<{
  projectId: string;
  machineId: string;
  publicationId: string;
  targetBackend: ActivationLeaseTargetBackend;
  evidenceSha256: string;
}>;

/**
 * Whether a resolved "present" fence belongs to this exact caller's
 * generation. Compares publicationId and machineId only -- see below for
 * why targetBackend and evidenceSha256 were removed from this comparison
 * rather than kept as defensive belt-and-suspenders checks.
 *
 * Verified at source, not assumed: this function is only ever reached
 * from within resolveActivationLeaseFence's "present" branch (both call
 * sites below call resolveActivationLeaseFence first and return early on
 * every other outcome). resolveActivationLeaseFence's fence comes from
 * guard.read(), and the real PostgreSqlBackendPublicationGuard#read
 * (publication-guard.ts) validates its row through
 * exactFence(row, { projectId, targetBackend, evidenceSha256 }, operation)
 * -- deliberately omitting exactFence's optional expected.machineId and
 * expected.publicationId parameters. exactFence's own check fails the row
 * when fence.targetBackend does not match, when fence.evidenceSha256 does
 * not match, or (only when that expected field is passed) when machineId
 * or publicationId do not match; with the latter two never passed by
 * read(), it can throw "invalid-row" (surfaced by
 * resolveActivationLeaseFence as "identity-mismatch", and handled by both
 * of this function's callers *before* sameGeneration ever runs) only for a
 * targetBackend or evidenceSha256 mismatch. It can never return a
 * "present" fence whose targetBackend or evidenceSha256 differ from the
 * caller's own input -- by the time this function runs, those two fields
 * are already guaranteed to match. machineId and publicationId are the
 * only fields read()'s exactFence call never validates, so they are the
 * only two fields left for this function to check.
 *
 * This was previously a four-field comparison. The targetBackend and
 * evidenceSha256 clauses were reachable in this module's unit tests only
 * through a fake guard whose read() returned a "present" fence with a
 * differing targetBackend or evidenceSha256 -- a shape the real guard's
 * read() can never produce, since it throws first. Production code kept
 * alive only by a fake that does not reproduce its real collaborator's
 * behaviour is the same untested-wrapper problem this repository's
 * no-exclusions coverage rule exists to prevent, approached from the
 * opposite direction, so those two clauses (and the branches they added)
 * were removed rather than defended with a misbehaving fixture.
 *
 * This is unrelated to PostgreSqlBackendPublicationGuard#acquire's own,
 * separate internal sameGeneration check (see acquire's local variable of
 * the same name in publication-guard.ts): that check reads the competing
 * row through the more permissive storedFenceFromRow, not exactFence, and
 * so genuinely can observe a targetBackend/evidenceSha256 mismatch there.
 * That is a different call path with a different validator and is
 * unaffected by this change.
 *
 * Issue #1419 tracks the real guard folding an identity mismatch and a
 * corrupted stored row into one indistinguishable thrown "invalid-row"
 * error. If that is ever narrowed so read() can return a non-matching row
 * instead of throwing, this function's reachability analysis -- and its
 * test coverage -- will need to be revisited.
 */
function sameGeneration(fence: ActivationLeaseFence, identity: ActivationLeaseIdentity): boolean {
  return fence.publicationId === identity.publicationId
    && fence.machineId === identity.machineId;
}

export type ActivationLeaseRenewInput = PostgreSqlBackendPublicationMutationInput & Readonly<{ ttlMs: number }>;

export type ActivationLeaseRenewResult =
  | Readonly<{ status: "renewed"; fence: ActivationLeaseFence }>
  | Readonly<{ status: "not-found"; detail: string }>
  | Readonly<{ status: "conflict"; detail: string }>
  | Readonly<{ status: "released"; detail: string; fence: ActivationLeaseFence }>
  | Readonly<{ status: "expired"; detail: string; fence: ActivationLeaseFence }>
  | Readonly<{ status: "stale-token"; detail: string; fence: ActivationLeaseFence }>
  | Readonly<{ status: "unresolvable"; detail: string }>;

/**
 * Ordinary renewal. Requires the caller's exact known fencingToken AND an
 * unexpired, unreleased row; it can never revive an expired lease (see the
 * module doc comment). The guard folds every WHERE-clause miss into one
 * generic "fence-mismatch"; this function reads the row back and
 * attributes exactly which of five distinct causes applies -- no row,
 * a different generation, an already-released row, an expired row (needs
 * takeoverActivationLease), or a stale caller-held token (needs a fresh
 * renewActivationLease call with the current token) -- rather than
 * reporting one undifferentiated failure.
 */
export async function renewActivationLease(
  guard: ActivationLeasePublicationGuard,
  input: ActivationLeaseRenewInput,
): Promise<ActivationLeaseRenewResult> {
  try {
    const fence = await guard.renew(input);
    return { status: "renewed", fence };
  } catch (error) {
    if (!(error instanceof PostgreSqlBackendPublicationGuardError) || error.reason !== "fence-mismatch") {
      throw error;
    }
    const resolution = await resolveActivationLeaseFence(guard, input);
    if (resolution.kind === "unresolvable") {
      return { status: "unresolvable", detail: resolution.detail };
    }
    if (resolution.kind === "absent") {
      return {
        status: "not-found",
        detail: `renew failed and no fenced-lease row exists for project ${input.projectId}; acquire before `
          + "renewing",
      };
    }
    if (resolution.kind === "identity-mismatch") {
      return { status: "conflict", detail: resolution.detail };
    }
    const fence = resolution.fence;
    if (!sameGeneration(fence, input)) {
      return {
        status: "conflict",
        detail: `renew failed because project ${input.projectId} is held by a different publication generation`,
      };
    }
    if (fence.releasedAt !== null) {
      return {
        status: "released",
        detail: `renew failed because the lease for project ${input.projectId} has already been released; `
          + "acquire a fresh generation instead",
        fence,
      };
    }
    if (fence.databaseExpired) {
      return {
        status: "expired",
        detail: `renew failed because the lease for project ${input.projectId} expired without being `
          + `released; ordinary renewal cannot revive it -- call takeoverActivationLease with fencingToken `
          + `${fence.fencingToken}`,
        fence,
      };
    }
    if (fence.fencingToken !== input.fencingToken) {
      return {
        status: "stale-token",
        detail: `renew failed because the caller's known fencingToken ${input.fencingToken} is stale; the `
          + `lease is active under fencingToken ${fence.fencingToken} -- retry renewActivationLease with the `
          + "fresh token",
        fence,
      };
    }
    return {
      status: "unresolvable",
      detail: `renew failed for project ${input.projectId} but an immediate readback shows an active, `
        + "matching, identical-token fence; this is an unattributable race between the mutation and the "
        + "readback, not a stable state this module will guess about",
    };
  }
}

export type ActivationLeaseTakeoverInput = PostgreSqlBackendPublicationAcquireInput & Readonly<{
  /**
   * The fencingToken read from the current, expired-unreleased row (e.g.
   * via readActivationLeaseFence, or the fence carried on
   * renewActivationLease's "expired" result). This is the
   * compare-and-swap comparand: PostgreSQL, not this module, guarantees
   * the takeover only succeeds if the row's fencing_token still equals
   * this value at the moment the guard's UPDATE...WHERE is evaluated
   * under the row lock its own transaction already holds. See this
   * module's report to the owner for the full lifetime analysis of the
   * interval between reading this token and this call.
   */
  expectedFencingToken: bigint;
}>;

export type ActivationLeaseTakeoverResult =
  | Readonly<{ status: "took-over"; fence: ActivationLeaseFence }>
  | Readonly<{ status: "conflict"; detail: string }>
  | Readonly<{ status: "token-mismatch"; detail: string }>
  | Readonly<{ status: "unresolvable"; detail: string }>;

/**
 * Compare-and-swap takeover of an expired, unreleased lease for this
 * exact generation. Only the same generation can ever take over its own
 * expired lease -- a different generation is always "publication-conflict"
 * regardless of the token supplied (verified at source in
 * PostgreSqlBackendPublicationGuard#acquire's sameGeneration branch).
 * When the row is not actually expired, PostgreSQL still applies the
 * comparison: a matching token on an unexpired row is accepted as a
 * successful no-op ("took-over" with the unchanged fence, not a fresh
 * generation bump), while a mismatched token is refused exactly as it
 * would be if the row were expired.
 */
export async function takeoverActivationLease(
  guard: ActivationLeasePublicationGuard,
  input: ActivationLeaseTakeoverInput,
): Promise<ActivationLeaseTakeoverResult> {
  try {
    const fence = await guard.acquire(input);
    return { status: "took-over", fence };
  } catch (error) {
    if (error instanceof PostgreSqlBackendPublicationGuardError) {
      if (error.reason === "publication-conflict") {
        return {
          status: "conflict",
          detail: `takeover failed because project ${input.projectId} is held by a different publication `
            + "generation",
        };
      }
      if (error.reason === "fence-mismatch") {
        return {
          status: "token-mismatch",
          detail: `takeover failed: expectedFencingToken ${input.expectedFencingToken} for project `
            + `${input.projectId} no longer matches the current row (it moved, the row was released, or it `
            + "never existed) -- re-read the fence and retry with its current token",
        };
      }
      if (error.reason === "readback-mismatch") {
        return {
          status: "unresolvable",
          detail: `the takeover commit outcome for project ${input.projectId} is ambiguous and readback did `
            + "not confirm it",
        };
      }
    }
    throw error;
  }
}

export type ActivationLeaseReleaseInput = PostgreSqlBackendPublicationMutationInput;

export type ActivationLeaseReleaseResult =
  | Readonly<{ status: "released"; fence: ActivationLeaseFence }>
  | Readonly<{ status: "already-released"; fence: ActivationLeaseFence }>
  | Readonly<{ status: "not-found"; detail: string }>
  | Readonly<{ status: "conflict"; detail: string }>
  | Readonly<{ status: "expired"; detail: string; fence: ActivationLeaseFence }>
  | Readonly<{ status: "stale-token"; detail: string; fence: ActivationLeaseFence }>
  | Readonly<{ status: "unresolvable"; detail: string }>;

/**
 * Release exists in this module ONLY for the activation driver's own
 * abort-before-handoff path. Activation acquires these leases before it
 * ever invokes BackendPublicationCoordinator's acquiring phase; if
 * activation abandons the attempt before that phase starts, nothing else
 * in the codebase will ever free them. Verified at source: once
 * BackendPublicationCoordinator's own #acquireAll/#releaseAll
 * (../storage/backend-publication.ts) has observed a project's fence as
 * active, release is that phase's job -- #releaseAll frees every
 * project's fence (taking over an expired one first if needed) before the
 * journal reaches "released", and assertTerminalPublicationEvidence
 * refuses outright a terminal journal that still carries an active fence.
 *
 * Never call this once that handoff has happened: this module has no
 * visibility into whether it has, so that boundary is a caller discipline
 * this doc comment states rather than something this function can enforce
 * or detect.
 *
 * Also note what the guard's own release() precondition means operationally:
 * expiry is not release. release()'s UPDATE requires an unexpired row
 * (`expires_at > statement_timestamp()`), so an abort that discovers its
 * own lease already expired cannot release it directly -- it must call
 * takeoverActivationLease first (the same generation can always take over
 * its own expired lease) and release the resulting fresh fence afterward.
 */
export async function releaseActivationLease(
  guard: ActivationLeasePublicationGuard,
  input: ActivationLeaseReleaseInput,
): Promise<ActivationLeaseReleaseResult> {
  try {
    const fence = await guard.release(input);
    return { status: "released", fence };
  } catch (error) {
    if (!(error instanceof PostgreSqlBackendPublicationGuardError) || error.reason !== "fence-mismatch") {
      throw error;
    }
    const resolution = await resolveActivationLeaseFence(guard, input);
    if (resolution.kind === "unresolvable") {
      return { status: "unresolvable", detail: resolution.detail };
    }
    if (resolution.kind === "absent") {
      return {
        status: "not-found",
        detail: `release failed and no fenced-lease row exists for project ${input.projectId}`,
      };
    }
    if (resolution.kind === "identity-mismatch") {
      return {
        status: "conflict",
        detail: resolution.detail,
      };
    }
    const fence = resolution.fence;
    if (!sameGeneration(fence, input)) {
      return {
        status: "conflict",
        detail: `release failed because project ${input.projectId} is held by a different publication `
          + "generation",
      };
    }
    if (fence.releasedAt !== null) {
      if (fence.fencingToken === input.fencingToken) {
        // Idempotent: an earlier release already committed under this
        // exact token (e.g. this caller never observed a prior response).
        return { status: "already-released", fence };
      }
      return {
        status: "conflict",
        detail: `release failed because project ${input.projectId} was released under a different `
          + "fencingToken than the caller's",
      };
    }
    if (fence.databaseExpired) {
      return {
        status: "expired",
        detail: `release failed because the lease for project ${input.projectId} expired without being `
          + `released; the guard's own release() requires an unexpired row (expiry is not release) -- call `
          + `takeoverActivationLease with fencingToken ${fence.fencingToken} before releasing`,
        fence,
      };
    }
    return {
      status: "stale-token",
      detail: `release failed because the caller's known fencingToken ${input.fencingToken} is stale; the `
        + `lease is active under fencingToken ${fence.fencingToken}`,
      fence,
    };
  }
}

export type ActivationLeaseAssertInput = Readonly<{
  projectId: string;
  publicationId: string;
  targetBackend: ActivationLeaseTargetBackend;
  evidenceSha256: string;
  signal?: AbortSignal;
}>;

export type ActivationLeaseAssertStatus = "satisfied" | "unsatisfied" | "unresolvable";

export type ActivationLeaseAssertReason =
  | "fence-active-and-matching"
  | "fence-absent"
  | "fence-identity-mismatch"
  | "fence-released"
  | "fence-expired"
  | "fence-read-unresolvable";

/** Attributed three-valued verification result, matching the convention
 * already established in activation-restart-check.ts, activation-
 * quiescence.ts, and activation-coverage.ts: never collapse this to a
 * boolean. */
export type ActivationLeaseAssertResult = Readonly<{
  status: ActivationLeaseAssertStatus;
  reason: ActivationLeaseAssertReason;
  /** Human-readable attribution for the status; always populated. */
  detail: string;
  /** The fence observed at read time, or null when none could be
   * attributed (absent, unresolvable, or a targetBackend/evidenceSha256
   * identity mismatch that PostgreSqlBackendPublicationGuard#read itself
   * refused to return -- see resolveActivationLeaseFence). Populated for
   * a publicationId mismatch or an inactive (released/expired) fence, since
   * those are only ever detected once a fence is already in hand. */
  fence: ActivationLeaseFence | null;
}>;

function buildAssertResult(
  status: ActivationLeaseAssertStatus,
  reason: ActivationLeaseAssertReason,
  detail: string,
  fence: ActivationLeaseFence | null,
): ActivationLeaseAssertResult {
  return Object.freeze({ status, reason, detail, fence });
}

/**
 * Assert -- never re-acquire -- that an active, matching fence is held for
 * one project at publication time. This is a single point-in-time read; it
 * holds no lock and provides no barrier across the caller's own
 * subsequent await points. See this module's report to the owner for the
 * full lifetime analysis of what a "satisfied" verdict does and does not
 * continue to guarantee after this function returns.
 *
 * Compares exactly the fields BackendPublicationCoordinator's own private
 * assertFence compares (../storage/backend-publication.ts): publicationId,
 * targetBackend, evidenceSha256, and projectId. Deliberately does not
 * compare machineId or the fencingToken's value, because assertFence
 * itself does not either -- see the module doc comment for why this was
 * verified at source rather than assumed.
 */
export async function assertActivationLeaseFence(
  guard: ActivationLeasePublicationGuard,
  input: ActivationLeaseAssertInput,
): Promise<ActivationLeaseAssertResult> {
  const resolution = await resolveActivationLeaseFence(guard, input);
  if (resolution.kind === "unresolvable") {
    return buildAssertResult("unresolvable", "fence-read-unresolvable", resolution.detail, null);
  }
  if (resolution.kind === "absent") {
    return buildAssertResult("unsatisfied", "fence-absent", resolution.detail, null);
  }
  if (resolution.kind === "identity-mismatch") {
    // resolveActivationLeaseFence already established that targetBackend
    // and/or evidenceSha256 (and/or, defensively, projectId) do not match
    // -- no fence object is obtainable in this branch at all (see its own
    // doc comment for why), so this result carries fence: null.
    return buildAssertResult("unsatisfied", "fence-identity-mismatch", resolution.detail, null);
  }
  const fence = resolution.fence;
  // Only publicationId remains to check here: resolveActivationLeaseFence's
  // "present" branch already guarantees targetBackend, evidenceSha256 and
  // projectId match (verified at source; see its doc comment).
  if (fence.publicationId !== input.publicationId) {
    return buildAssertResult(
      "unsatisfied",
      "fence-identity-mismatch",
      `the stored fence for project ${input.projectId} does not match the expected publication identity`,
      fence,
    );
  }
  if (fence.releasedAt !== null) {
    return buildAssertResult(
      "unsatisfied",
      "fence-released",
      `the fence for project ${input.projectId} has already been released`,
      fence,
    );
  }
  if (fence.databaseExpired) {
    return buildAssertResult(
      "unsatisfied",
      "fence-expired",
      `the fence for project ${input.projectId} has expired without being released`,
      fence,
    );
  }
  return buildAssertResult(
    "satisfied",
    "fence-active-and-matching",
    `an active, matching fence is held for project ${input.projectId}`,
    fence,
  );
}
