import type {
  ProjectStorage,
  StorageBackendFactory,
  StorageIdentityContext,
  StorageBackendName,
} from "../../storage/index.js";
import { createStorageBackendFactory } from "../../storage/index.js";
import type { DaemonConfig } from "../config.js";
import { projectIdentity } from "../project.js";
import type { RouteExecutionContext, RoutePublicationAdmission } from "../server.js";
import { StorageOperationError, normalizeStorageError } from "../../storage/errors.js";
import {
  STORAGE_IDENTITY_REQUIRED_ERROR_CODE,
  STORAGE_IDENTITY_REQUIRED_MACHINE_REASON,
  STORAGE_IDENTITY_REQUIRED_UNBOUND_REASON,
  StorageIdentityConfigurationError,
  type StorageIdentityRequiredReason,
} from "../../storage/identity-context.js";
import { MachineIdentityFileError } from "../../machine-identity.js";
import {
  stagedPostgreSqlUnavailablePayload,
  type StagedPostgreSqlUnavailableResponse,
} from "../staged-postgresql.js";
import { sanitizeError } from "../safe-error.js";
import {
  BackendPublicationJournalError,
  type BackendPublicationLockToken,
} from "../../storage/backend-publication.js";
import { createAbortError, isAbortError } from "../cancellation.js";
import { PrivateMutationLockContentionError } from "../../private-mutation-lock.js";
import { isPublicationWitnessContention } from "../../storage/postgresql/factory.js";

interface AsyncClosable {
  close(publicationLockToken?: BackendPublicationLockToken): Promise<void> | void;
}

export {
  STORAGE_IDENTITY_REQUIRED_ERROR_CODE,
  STORAGE_IDENTITY_REQUIRED_MACHINE_REASON,
  STORAGE_IDENTITY_REQUIRED_UNBOUND_REASON,
  type StorageIdentityRequiredReason,
} from "../../storage/identity-context.js";

export type StorageIdentityRequiredResponse = {
  readonly code: typeof STORAGE_IDENTITY_REQUIRED_ERROR_CODE;
  readonly reason: StorageIdentityRequiredReason;
  readonly error: string;
  readonly storageBackend: "postgresql";
};

export type StorageRouteFailureResponse =
  | {
      readonly status: 409;
      readonly body: StorageIdentityRequiredResponse;
    }
  | {
      readonly status: 503;
      readonly body: Record<string, unknown>;
    };

export type ProjectStorageRequest = Readonly<{
  readonly config: DaemonConfig;
  readonly cwd: string;
  readonly factory?: StorageBackendFactory;
  readonly context?: RouteExecutionContext;
  readonly mode: "create" | "existing";
  readonly expectedIdentity?: StorageIdentityContext & { readonly localProjectId: string };
  /** Optional non-revocable work that must settle before storage closes. */
  readonly beforeClose?: () => Promise<void>;
}>;

type ReleasePermit = Readonly<{ release: () => void }>;

/** Keep the route's public cancellation response stable across AbortSignal reasons. */
function createRouteAbortError(): ReturnType<typeof createAbortError> {
  return createAbortError(new Error("request cancelled"));
}

function throwIfRouteAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createRouteAbortError();
}

/** Keep request-scoped resources open until every acquired commit releases. */
export function createCommitCloseBarrier(): Readonly<{
  acquire: (operation: () => ReleasePermit) => ReleasePermit;
  waitForZero: () => Promise<void>;
}> {
  let active = 0;
  const waiters: Array<() => void> = [];
  const releaseSlot = (): void => {
    active -= 1;
    if (active !== 0) return;
    for (const resolve of waiters.splice(0)) resolve();
  };
  return {
    acquire: (operation): ReleasePermit => {
      // Reserve before acquisition: the operation may synchronously latch
      // cancellation before it returns the non-revocable permit.
      active += 1;
      let permit: ReleasePermit;
      try {
        permit = operation();
      } catch (error) {
        releaseSlot();
        throw error;
      }
      let released = false;
      return {
        release: (): void => {
          if (released) return;
          released = true;
          try {
            permit.release();
          } finally {
            releaseSlot();
          }
        },
      };
    },
    waitForZero: (): Promise<void> => active === 0
      ? Promise.resolve()
      : new Promise(resolve => waiters.push(resolve)),
  };
}

export type ProjectStorageOperation<T> = (
  storage: ProjectStorage,
  signal: AbortSignal,
  publicationLockToken?: BackendPublicationLockToken,
) => Promise<T> | T;

/** Private executions still running on each caller-supplied (shared) factory. */
const sharedFactoryExecutions = new WeakMap<StorageBackendFactory, Set<Promise<void>>>();

/**
 * Resolve once every `withProjectStorage` execution on this shared factory has
 * finished its private open, operation and project close. A route's public
 * promise may reject early on abort while its private open is still pending, so
 * the owner of the factory waits here before closing it. Never rejects.
 */
export async function settleProjectStorageExecutions(factory: StorageBackendFactory): Promise<void> {
  let pending = sharedFactoryExecutions.get(factory);
  while (pending !== undefined && pending.size > 0) {
    await Promise.all(pending);
    pending = sharedFactoryExecutions.get(factory);
  }
}

/**
 * A read prefix failure that the daemon's own publication work may have caused:
 * publication-lock contention from factory creation, identity, or the open, or
 * the open's initialization failure marked as publication-witness contention.
 * Other initialization failures (database outage, timeout, identity mismatch)
 * and construction failures never qualify.
 */
function isContendedReadPrefixFailure(error: unknown, openStage: boolean): boolean {
  return error instanceof PrivateMutationLockContentionError
    || (openStage && isPublicationWitnessContention(error));
}

export function sameStorageIdentity(
  expected: StorageIdentityContext & { readonly localProjectId: string },
  actual: StorageIdentityContext & { readonly localProjectId: string },
): boolean {
  // selectedPath may name a different verified alias for the same project.
  // machineId authenticates the caller rather than selecting project storage;
  // backend identity resolution validates it independently.
  return expected.id === actual.id
    && expected.localProjectId === actual.localProjectId
    && expected.canonical === actual.canonical
    && expected.remoteProjectId === actual.remoteProjectId;
}

async function settleClose(
  resource: AsyncClosable | undefined,
  publicationLockToken?: BackendPublicationLockToken,
): Promise<void> {
  if (!resource) return;
  try {
    await resource.close(publicationLockToken);
  } catch {
    // Route cleanup is best-effort. Operation errors determine the response.
  }
}

/** Close request-scoped storage without leaking or changing an emitted response. */
export async function closeRouteStorage(
  ...resources: Array<AsyncClosable | undefined>
): Promise<void> {
  await Promise.all(resources.map(resource => settleClose(resource)));
}

/** Open a project only when it already exists in the selected backend. */
export async function openExistingProject(
  factory: StorageBackendFactory,
  identity: StorageIdentityContext,
  publicationLockToken?: BackendPublicationLockToken,
  signal?: AbortSignal,
): Promise<ProjectStorage | null> {
  return factory.openExistingProject(identity, publicationLockToken, signal);
}

/** Resolve early mutator identity under the same admission used by its storage work. */
export async function admittedProjectIdentity(
  cwd: string,
  storage: DaemonConfig["storage"],
  context?: RouteExecutionContext,
): Promise<ReturnType<typeof projectIdentity>> {
  const resolveIdentity = (token = context?.publicationLockToken) => projectIdentity(cwd, storage, token);
  return context?.withPublicationAdmission === undefined
    ? resolveIdentity()
    : context.withPublicationAdmission(resolveIdentity, context.signal);
}

/**
 * Resolve, open, use, and close one project-storage scope.
 *
 * Mutating routes pass their operation-scoped publication callback. Read routes
 * deliberately omit it so identity/open/operation/close stay on the existing
 * path; their identity resolution may still acquire a synchronous consumer lock.
 */
export async function withProjectStorage<T>(
  request: ProjectStorageRequest,
  operation: ProjectStorageOperation<T>,
): Promise<T | null> {
  const context = request.context;
  const signal = context?.signal ?? new AbortController().signal;
  throwIfRouteAborted(signal);
  let activeFactory = request.factory;
  let ownedFactory: StorageBackendFactory | undefined;

  const state = { openPending: false };
  const createOwnedFactory = async (
    publicationLockToken?: BackendPublicationLockToken,
  ): Promise<StorageBackendFactory> => {
    activeFactory = await createStorageBackendFactory(
      request.config.storage,
      undefined,
      undefined,
      publicationLockToken,
    );
    ownedFactory = activeFactory;
    return activeFactory;
  };
  const run = async (publicationLockToken?: BackendPublicationLockToken): Promise<T | null> => {
    throwIfRouteAborted(signal);
    const factory = activeFactory ?? await createOwnedFactory(publicationLockToken);

    const identity = projectIdentity(
      request.cwd,
      request.config.storage,
      publicationLockToken,
    );
    let project: ProjectStorage | undefined;
    let projectClose: Promise<void> | undefined;
    const closeProject = (): Promise<void> => {
      projectClose ??= (async () => {
        await request.beforeClose?.();
        await settleClose(project, publicationLockToken);
      })();
      return projectClose;
    };
    const onAbort = (): void => {
      void closeProject();
    };

    try {
      if (request.expectedIdentity !== undefined
          && !sameStorageIdentity(request.expectedIdentity, identity)) {
        throw new BackendPublicationJournalError(
          "unexpected-state",
          "project storage identity changed during publication admission",
        );
      }
      state.openPending = true;
      try {
        project = request.mode === "existing"
          ? await openExistingProject(factory, identity, publicationLockToken, signal) ?? undefined
          : await factory.openProject(identity, publicationLockToken, signal);
      } finally {
        state.openPending = false;
      }
      throwIfRouteAborted(signal);
      if (project === undefined) return null;

      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        throw createRouteAbortError();
      }
      const result = await operation(project, signal, publicationLockToken);
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
      await closeProject();
    }
  };

  /**
   * PostgreSQL read path: the prefix first runs unadmitted, as every read does.
   * If the daemon's own publication work made it contend, the same prefix is
   * retried once inside a bounded admission. The operation and the close run
   * outside admission without a token.
   */
  const runRead = async (withReadAdmission: RoutePublicationAdmission): Promise<T | null> => {
    let project: ProjectStorage | undefined;
    let projectClose: Promise<void> | undefined;
    let setupComplete = false;
    let openStage = false;
    const closeProject = (runBeforeClose = true): Promise<void> => {
      projectClose ??= (async () => {
        if (runBeforeClose) await request.beforeClose?.();
        await settleClose(project);
      })();
      return projectClose;
    };
    const onAbort = (): void => {
      void closeProject();
    };
    const openPrefix = async (publicationLockToken?: BackendPublicationLockToken): Promise<void> => {
      openStage = false;
      throwIfRouteAborted(signal);
      const factory = activeFactory ?? await createOwnedFactory(publicationLockToken);
      const identity = projectIdentity(request.cwd, request.config.storage, publicationLockToken);
      setupComplete = true;
      if (request.expectedIdentity !== undefined
          && !sameStorageIdentity(request.expectedIdentity, identity)) {
        throw new BackendPublicationJournalError(
          "unexpected-state",
          "project storage identity changed during publication admission",
        );
      }
      openStage = true;
      state.openPending = true;
      try {
        project = request.mode === "existing"
          ? await openExistingProject(factory, identity, publicationLockToken, signal) ?? undefined
          : await factory.openProject(identity, publicationLockToken, signal);
      } finally {
        state.openPending = false;
      }
    };

    try {
      try {
        await openPrefix();
      } catch (error) {
        if (!isContendedReadPrefixFailure(error, openStage)) throw error;
        try {
          await withReadAdmission(openPrefix, signal);
        } catch (admissionError) {
          // The admission may reject after the prefix returned a project.
          if (project !== undefined) await closeProject(false);
          throw admissionError;
        }
      }
      throwIfRouteAborted(signal);
      if (project === undefined) return null;

      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        throw createRouteAbortError();
      }
      return await operation(project, signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (setupComplete) await closeProject();
    }
  };

  const withReadAdmission = context?.withPublicationAdmission === undefined
    && context?.publicationLockToken === undefined
    ? context?.withReadAdmission
    : undefined;
  const privateExecution = context?.withPublicationAdmission !== undefined
    ? context.withPublicationAdmission(run, signal)
    : withReadAdmission !== undefined
      ? runRead(withReadAdmission)
      : run(context?.publicationLockToken);
  // Attach observers immediately so a prompt public cancellation never leaves
  // a late open rejection unobserved.
  const observedExecution = privateExecution.then(
    value => value,
    error => { throw error; },
  );
  const settledExecution = observedExecution.finally(async () => {
    // An owned factory is closed only after admission release and all private
    // project cleanup have completed.
    await closeRouteStorage(ownedFactory);
  });
  if (request.factory !== undefined) {
    const executions = sharedFactoryExecutions.get(request.factory) ?? new Set<Promise<void>>();
    sharedFactoryExecutions.set(request.factory, executions);
    const tracked: Promise<void> = settledExecution
      .then(() => undefined, () => undefined)
      .then(() => { executions.delete(tracked); });
    executions.add(tracked);
  }
  if (request.context?.withPublicationAdmission === undefined
      && request.context?.publicationLockToken !== undefined) {
    return settledExecution;
  }
  return new Promise<T | null>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => {
      if (!state.openPending) return;
      settle(() => reject(createRouteAbortError()));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    settledExecution.then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

export function stagedPostgreSqlUnavailableResponse(
  factory: StorageBackendFactory | undefined,
  error: unknown,
  operation: string,
): StagedPostgreSqlUnavailableResponse | null {
  if (
    !(error instanceof StorageOperationError)
  ) {
    return null;
  }
  return stagedPostgreSqlFactoryUnavailableResponse(factory, operation);
}

export function stagedPostgreSqlFactoryUnavailableResponse(
  factory: StorageBackendFactory | undefined,
  operation: string,
): StagedPostgreSqlUnavailableResponse | null {
  const capabilities = factory?.capabilities;
  return factory?.backend === "postgresql"
    && capabilities?.transactions === false
    && capabilities.lexicalSearch === false
    && capabilities.regexSearch === false
    && capabilities.nativeFullTextSearch === "unavailable"
    && capabilities.coordination === "distributed"
    ? stagedPostgreSqlUnavailablePayload(operation)
    : null;
}

export function storageIdentityRequiredResponse(
  error: unknown,
): StorageIdentityRequiredResponse | null {
  if (error instanceof StorageIdentityConfigurationError) {
    return {
      code: STORAGE_IDENTITY_REQUIRED_ERROR_CODE,
      reason: STORAGE_IDENTITY_REQUIRED_UNBOUND_REASON,
      error: sanitizeError(error.message),
      storageBackend: "postgresql",
    };
  }
  if (error instanceof MachineIdentityFileError) {
    return {
      code: STORAGE_IDENTITY_REQUIRED_ERROR_CODE,
      reason: STORAGE_IDENTITY_REQUIRED_MACHINE_REASON,
      error: "Machine identity is unavailable. Run `lcm machine show` for recovery guidance.",
      storageBackend: "postgresql",
    };
  }
  return null;
}

/**
 * Classify storage admission failures after a route has performed its normal
 * request validation. Identity failures take precedence because they happen
 * before selected-backend storage is opened.
 */
export function storageRouteFailureResponse(
  selectedBackend: StorageBackendName,
  error: unknown,
  operation: string,
  legacyStagedFactory?: StorageBackendFactory,
): StorageRouteFailureResponse | null {
  const identityRequired = storageIdentityRequiredResponse(error);
  if (identityRequired) return { status: 409, body: identityRequired };

  // The optional factory exists only for the legacy staged PostgreSQL test
  // fixture. Production route classification is keyed by selectedBackend.
  const stagedUnavailable = selectedBackend !== "postgresql" || legacyStagedFactory === undefined
    ? null
    : stagedPostgreSqlUnavailableResponse(legacyStagedFactory, error, operation);
  if (stagedUnavailable) return { status: 503, body: stagedUnavailable };

  if (selectedBackend !== "postgresql" || !(error instanceof StorageOperationError)) return null;
  void operation;
  return { status: 503, body: error.toJSON() };
}

/**
 * Classify a failure that rejected a read route's project-storage scope.
 *
 * On PostgreSQL every such failure is a sanitized 503 rather than an empty
 * success body. Intentional cancellation and SQLite keep the route's existing
 * non-fatal handling.
 */
export function storageReadFailureResponse(
  selectedBackend: StorageBackendName,
  error: unknown,
  operation: string,
  legacyStagedFactory?: StorageBackendFactory,
): StorageRouteFailureResponse | null {
  const classified = storageRouteFailureResponse(selectedBackend, error, operation, legacyStagedFactory);
  if (classified) return classified;
  if (isAbortError(error) || selectedBackend !== "postgresql") return null;
  if (error instanceof PrivateMutationLockContentionError) {
    return {
      status: 503,
      body: new StorageOperationError(
        "STORAGE_OPERATION_FAILED",
        "postgresql",
        undefined,
        "identity",
        operation,
        { retryable: true },
      ).toJSON(),
    };
  }
  return {
    status: 503,
    body: normalizeStorageError(error, { backend: "postgresql", domain: "factory", operation }).toJSON(),
  };
}
