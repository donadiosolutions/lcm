import type {
  ProjectStorage,
  StorageBackendFactory,
  StorageIdentityContext,
  StorageBackendName,
} from "../../storage/index.js";
import { createStorageBackendFactory } from "../../storage/index.js";
import type { DaemonConfig } from "../config.js";
import { projectIdentity } from "../project.js";
import type { RouteExecutionContext } from "../server.js";
import { StorageOperationError } from "../../storage/errors.js";
import { StorageIdentityConfigurationError } from "../../storage/identity-context.js";
import { MachineIdentityFileError } from "../../machine-identity.js";
import {
  stagedPostgreSqlUnavailablePayload,
  type StagedPostgreSqlUnavailableResponse,
} from "../staged-postgresql.js";
import { sanitizeError } from "../safe-error.js";
import type { BackendPublicationLockToken } from "../../storage/backend-publication.js";

interface AsyncClosable {
  close(): Promise<void> | void;
}

export const STORAGE_IDENTITY_REQUIRED_ERROR_CODE = "STORAGE_IDENTITY_REQUIRED" as const;

export type StorageIdentityRequiredResponse = {
  readonly code: typeof STORAGE_IDENTITY_REQUIRED_ERROR_CODE;
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
}>;

export type ProjectStorageOperation<T> = (
  storage: ProjectStorage,
  signal: AbortSignal,
) => Promise<T> | T;

async function settleClose(resource: AsyncClosable | undefined): Promise<void> {
  if (!resource) return;
  try {
    await resource.close();
  } catch {
    // Route cleanup is best-effort. Operation errors determine the response.
  }
}

/** Close request-scoped storage without leaking or changing an emitted response. */
export async function closeRouteStorage(
  ...resources: Array<AsyncClosable | undefined>
): Promise<void> {
  await Promise.all(resources.map(settleClose));
}

/** Open a project only when it already exists in the selected backend. */
export async function openExistingProject(
  factory: StorageBackendFactory,
  identity: StorageIdentityContext,
  publicationLockToken?: BackendPublicationLockToken,
): Promise<ProjectStorage | null> {
  return factory.openExistingProject(identity, publicationLockToken);
}

/**
 * Resolve, open, use, and close one project-storage scope.
 *
 * Mutating routes pass their operation-scoped publication callback. Read routes
 * deliberately omit it so identity/open/operation/close stay on the existing
 * assertion-only path and do not acquire a new interprocess consumer lock.
 */
export async function withProjectStorage<T>(
  request: ProjectStorageRequest,
  operation: ProjectStorageOperation<T>,
): Promise<T | null> {
  const signal = request.context?.signal ?? new AbortController().signal;
  let activeFactory = request.factory;
  let ownedFactory: StorageBackendFactory | undefined;

  const run = async (publicationLockToken?: BackendPublicationLockToken): Promise<T | null> => {
    if (activeFactory === undefined) {
      activeFactory = await createStorageBackendFactory(
        request.config.storage,
        undefined,
        undefined,
        publicationLockToken,
      );
      ownedFactory = activeFactory;
    }

    const identity = projectIdentity(
      request.cwd,
      request.config.storage,
      publicationLockToken,
    );
    let project: ProjectStorage | undefined;
    let projectClose: Promise<void> | undefined;
    const closeProject = (): Promise<void> => {
      projectClose ??= closeRouteStorage(project);
      return projectClose;
    };
    const onAbort = (): void => {
      void closeProject();
    };

    try {
      project = request.mode === "existing"
        ? await openExistingProject(activeFactory, identity, publicationLockToken) ?? undefined
        : await activeFactory.openProject(identity, publicationLockToken);
      if (project === undefined) return null;

      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        if (request.mode === "create") {
          throw Object.assign(new Error("request cancelled"), { name: "AbortError" });
        }
        return null;
      }
      return await operation(project, signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await closeProject();
    }
  };

  try {
    if (request.context?.withPublicationAdmission !== undefined) {
      return await request.context.withPublicationAdmission(run);
    }
    return await run(request.context?.publicationLockToken);
  } finally {
    // An owned factory is closed only after the admission callback has
    // returned, so project cleanup and publication revalidation complete first.
    await closeRouteStorage(ownedFactory);
  }
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
  if (
    !(error instanceof StorageIdentityConfigurationError)
    && !(error instanceof MachineIdentityFileError)
  ) {
    return null;
  }
  return {
    code: STORAGE_IDENTITY_REQUIRED_ERROR_CODE,
    error: error instanceof MachineIdentityFileError
      ? "Machine identity is unavailable. Run `lcm machine show` for recovery guidance."
      : sanitizeError(error.message),
    storageBackend: "postgresql",
  };
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
