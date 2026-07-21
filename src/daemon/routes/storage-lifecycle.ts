import type { ProjectIdentity } from "../../project-map.js";
import type { ProjectStorage, StorageBackendFactory } from "../../storage/index.js";

interface AsyncClosable {
  close(): Promise<void>;
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
  project: AsyncClosable | undefined,
  ownedFactory: AsyncClosable | undefined,
): Promise<void> {
  await Promise.all([
    settleClose(project),
    settleClose(ownedFactory),
  ]);
}

/** Open a project only when it already exists in the selected backend. */
export async function openExistingProject(
  factory: StorageBackendFactory,
  identity: ProjectIdentity,
): Promise<ProjectStorage | null> {
  if (!await factory.projectExists(identity)) return null;
  return factory.openProject(identity);
}
