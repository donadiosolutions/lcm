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

interface AsyncClosable {
  close(): Promise<void> | void;
}

export const STORAGE_IDENTITY_REQUIRED_ERROR_CODE = "STORAGE_IDENTITY_REQUIRED" as const;

export type StorageIdentityRequiredResponse = {
  readonly code: typeof STORAGE_IDENTITY_REQUIRED_ERROR_CODE;
  readonly error: string;
  readonly storageBackend: "postgresql";
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
    !(factory instanceof UnavailablePostgreSqlStorageBackendFactory)
    || !(error instanceof StorageOperationError)
  ) {
    return null;
  }
  return stagedPostgreSqlUnavailablePayload(operation);
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
    error: error.message,
    storageBackend: "postgresql",
  };
}
