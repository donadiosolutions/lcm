import type {
  ProjectStorage,
  StorageBackendFactory,
  StorageIdentityContext,
} from "../../storage/index.js";
import { StorageOperationError } from "../../storage/errors.js";
import { UnavailablePostgreSqlStorageBackendFactory } from "../../storage/factory.js";
import { StorageIdentityConfigurationError } from "../../storage/identity-context.js";
import { MachineIdentityFileError } from "../../machine-identity.js";
import {
  stagedPostgreSqlUnavailablePayload,
  type StagedPostgreSqlUnavailableResponse,
} from "../staged-postgresql.js";
import { sanitizeError } from "../safe-error.js";

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
      readonly body: StagedPostgreSqlUnavailableResponse;
    };

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
): Promise<ProjectStorage | null> {
  return factory.openExistingProject(identity);
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
  return factory instanceof UnavailablePostgreSqlStorageBackendFactory
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
    error: sanitizeError(error.message),
    storageBackend: "postgresql",
  };
}

/**
 * Classify storage admission failures after a route has performed its normal
 * request validation. Identity failures take precedence because they happen
 * before the staged factory is opened.
 */
export function storageRouteFailureResponse(
  factory: StorageBackendFactory | undefined,
  error: unknown,
  operation: string,
): StorageRouteFailureResponse | null {
  const identityRequired = storageIdentityRequiredResponse(error);
  if (identityRequired) return { status: 409, body: identityRequired };
  const unavailable = stagedPostgreSqlUnavailableResponse(factory, error, operation);
  return unavailable ? { status: 503, body: unavailable } : null;
}
