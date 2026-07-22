import type { ProjectIdentity } from "../../project-map.js";
import type { ProjectStorage, StorageBackendFactory } from "../../storage/index.js";

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
  identity: ProjectIdentity,
): Promise<ProjectStorage | null> {
  return factory.openExistingProject(identity);
}
