import { normalizeUuidV7 } from "../../machine-identity.js";
import type { BackendPublicationRemoteGuardProvider } from "../backend-publication-driver.js";
import type {
  BackendPublicationFenceRecord,
  BackendPublicationRemoteContext,
} from "../backend-publication.js";
import {
  PostgreSqlBackendPublicationGuardError,
  type PostgreSqlBackendPublicationFence,
  type PostgreSqlBackendPublicationGuard,
} from "./publication-guard.js";

// Mirrors publication-guard.ts's MAX_PUBLICATION_TTL_MS. The guard does not
// export its validators; a parity test pins both bounds against the real
// guard so they cannot drift apart.
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The slice of {@link PostgreSqlBackendPublicationGuard} this provider calls.
 * A real guard (for example `PostgreSqlRuntime#backendPublicationGuard()`)
 * satisfies it directly.
 */
export type PostgreSqlBackendPublicationRemoteGuardPort = Pick<
  PostgreSqlBackendPublicationGuard,
  "acquire" | "read" | "release"
> & Partial<Pick<PostgreSqlBackendPublicationGuard, "readForReleaseReconciliation">>;

export type CreatePostgreSqlBackendPublicationRemoteGuardOptions = Readonly<{
  guard: PostgreSqlBackendPublicationRemoteGuardPort;
  /** This machine's PostgreSQL machine id (a UUIDv7). */
  machineId: string;
  /** Lease lifetime for an acquisition or takeover, in milliseconds. */
  ttlMs: number;
}>;

function assertOptions(options: CreatePostgreSqlBackendPublicationRemoteGuardOptions): string {
  const guard: unknown = options?.guard;
  if (guard === null || typeof guard !== "object") {
    throw new TypeError("backend publication remote guard requires a guard object");
  }
  for (const method of ["acquire", "read", "release"] as const) {
    if (typeof (guard as Record<string, unknown>)[method] !== "function") {
      throw new TypeError(
        `backend publication remote guard guard is missing required method: ${method}`,
      );
    }
  }
  const machineId = typeof options.machineId === "string"
    ? normalizeUuidV7(options.machineId)
    : null;
  if (machineId === null) {
    throw new TypeError("backend publication remote guard machineId must be a UUIDv7");
  }
  const ttlMs: unknown = options.ttlMs;
  if (
    typeof ttlMs !== "number"
    || !Number.isSafeInteger(ttlMs)
    || ttlMs <= 0
    || ttlMs > MAX_TTL_MS
  ) {
    throw new TypeError(
      `backend publication remote guard ttlMs must be an integer from 1 to ${MAX_TTL_MS}`,
    );
  }
  return machineId;
}

function toFenceRecord(fence: PostgreSqlBackendPublicationFence): BackendPublicationFenceRecord {
  return { ...fence, fencingToken: fence.fencingToken.toString() };
}

function identityOf(context: BackendPublicationRemoteContext) {
  return {
    projectId: context.project.remoteProjectId,
    targetBackend: context.journal.targetBackend,
    evidenceSha256: context.project.evidenceSha256,
  };
}

/**
 * Production {@link BackendPublicationRemoteGuardProvider} over the
 * PostgreSQL fenced publication lease.
 *
 * The consumer (migration activation or rollback) acquires and renews the
 * lease for each project before it drives the coordinator, so the
 * coordinator normally finds an active fence already and only adopts it.
 * This provider never renews. It acquires only when the coordinator asks
 * for it:
 *
 * - no row, or a released row (of any generation, including one that named
 *   another target backend or evidence): the guard inserts or replaces it;
 * - an unexpired row of this exact generation (machine, publication, target
 *   backend and evidence): the guard returns it unchanged, which adopts the
 *   caller's lease;
 * - an expired, unreleased row of this exact generation: the provider reads
 *   the row and passes that row's own token as the guard's
 *   `expectedFencingToken`, taking over our own lapsed generation. The token
 *   in the journal is never used, because the authoritative row decides
 *   whether a takeover is allowed and which token it must name;
 * - an unreleased row of any other generation: the guard refuses with
 *   `publication-conflict` and the error propagates, so the coordinator
 *   fails closed.
 *
 * While acquiring, a row that names another target backend or evidence is a
 * different generation, not a failed read: it is treated as no usable
 * own-generation row, so a released one is replaced and an unreleased one
 * ends in the guard's `publication-conflict`. The same mismatch propagates
 * when the coordinator reads for release, except through the reconciliation
 * read described below.
 *
 * A row that another machine holds, is still active and names this
 * publication, target backend and evidence is refused by this provider, so a
 * foreign fence is never journalled as ours. An inactive foreign row is
 * returned unchanged. Only a RELEASED one can then be reclaimed, because
 * `guard.acquire` replaces a released row; an expired but unreleased foreign
 * row ends in the guard's `publication-conflict`, and the coordinator fails
 * closed.
 *
 * When the guard offers `readForReleaseReconciliation`, the provider also
 * declares `readRemoteGuardForReleaseReconciliation`. It
 * returns the project's row whichever generation it names (including another
 * target backend or evidence) without refusing a foreign machine, and the
 * coordinator uses it only to finish its own release: a row of another
 * identity with a strictly greater fencing token proves the persisted fence
 * was released before a later publication rebound the row. The guard rebinds
 * only released rows and always assigns a greater token, which is what makes
 * that inference sound. A guard without the method leaves the capability
 * absent and the coordinator keeps failing closed.
 */
export function createPostgreSqlBackendPublicationRemoteGuard(
  options: CreatePostgreSqlBackendPublicationRemoteGuardOptions,
): BackendPublicationRemoteGuardProvider {
  const machineId = assertOptions(options);
  const { guard, ttlMs } = options;

  // The only foreign row that is refused is one the coordinator would accept
  // as this publication's active fence: active, and naming this publication,
  // target backend and evidence. An inactive or differently-identified row is
  // returned unchanged so the coordinator can reclaim or reject it itself.
  const refuseForeignMachine = (
    fence: PostgreSqlBackendPublicationFence,
    context: BackendPublicationRemoteContext,
  ): void => {
    if (
      fence.machineId !== machineId
      && fence.releasedAt === null
      && !fence.databaseExpired
      && fence.publicationId === context.journal.publicationId
      && fence.targetBackend === context.journal.targetBackend
      && fence.evidenceSha256 === context.project.evidenceSha256
    ) {
      throw new PostgreSqlBackendPublicationGuardError(
        fence.projectId,
        "backendPublicationRemoteGuard",
        "publication-conflict",
      );
    }
  };

  // guard.read reports fence-mismatch for a decodable row that names another
  // target backend or evidence. When acquiring, that row is a different
  // generation, not a failure of the read: a released one is replaced by
  // guard.acquire and an unreleased one makes guard.acquire refuse with
  // publication-conflict. Any other error still propagates.
  const readForAcquire = async (
    context: BackendPublicationRemoteContext,
  ): Promise<PostgreSqlBackendPublicationFence | null> => {
    try {
      return await guard.read(identityOf(context));
    } catch (error) {
      if (
        error instanceof PostgreSqlBackendPublicationGuardError
        && error.reason === "fence-mismatch"
      ) {
        return null;
      }
      throw error;
    }
  };

  const isOwnGeneration = (
    fence: PostgreSqlBackendPublicationFence,
    context: BackendPublicationRemoteContext,
  ): boolean => fence.machineId === machineId
    && fence.publicationId === context.journal.publicationId
    && fence.targetBackend === context.journal.targetBackend
    && fence.evidenceSha256 === context.project.evidenceSha256;

  const reconcile = guard.readForReleaseReconciliation?.bind(guard);

  return {
    ...(reconcile === undefined ? {} : {
      async readRemoteGuardForReleaseReconciliation(context: BackendPublicationRemoteContext) {
        const fence = await reconcile({ projectId: context.project.remoteProjectId });
        return fence === null ? null : toFenceRecord(fence);
      },
    }),

    async readRemoteGuard(context, operation) {
      const fence = operation === "acquire"
        ? await readForAcquire(context)
        : await guard.read(identityOf(context));
      if (fence === null) return null;
      refuseForeignMachine(fence, context);
      return toFenceRecord(fence);
    },

    async acquireRemoteGuard(context) {
      const identity = identityOf(context);
      const row = await readForAcquire(context);
      if (row !== null) refuseForeignMachine(row, context);
      const takeover = row !== null
        && row.releasedAt === null
        && row.databaseExpired
        && isOwnGeneration(row, context);
      const fence = await guard.acquire({
        ...identity,
        machineId,
        publicationId: context.journal.publicationId,
        ttlMs,
        ...(takeover ? { expectedFencingToken: row.fencingToken } : {}),
      });
      refuseForeignMachine(fence, context);
      return toFenceRecord(fence);
    },

    async releaseRemoteGuard(context) {
      await guard.release({
        ...identityOf(context),
        machineId,
        publicationId: context.journal.publicationId,
        fencingToken: BigInt(context.fence.fencingToken),
      });
    },
  };
}
