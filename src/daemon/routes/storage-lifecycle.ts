import type {
  ProjectStorage,
  StorageBackendFactory,
  StorageIdentityContext,
} from "../../storage/index.js";
import { StorageOperationError } from "../../storage/errors.js";
import { UnavailablePostgreSqlStorageBackendFactory } from "../../storage/factory.js";
import {
  stagedPostgreSqlUnavailablePayload,
  type StagedPostgreSqlUnavailableResponse,
} from "../staged-postgresql.js";

interface AsyncClosable {
  close(): Promise<void> | void;
}

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
