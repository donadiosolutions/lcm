import { homedir } from "node:os";
import type { ResolvedStorageConfig } from "../daemon/config.js";
import type { StorageBackendFactory } from "./contracts.js";
import { assertStorageBackendPublication } from "./backend.js";
import { createPostgreSqlStorageBackendFactoryWithHome } from "./postgresql/factory.js";
import { SqliteStorageBackendFactory } from "./sqlite/factory.js";
import type { BackendPublicationLockToken } from "./backend-publication.js";

export async function createStorageBackendFactory(
  config: ResolvedStorageConfig,
  homeDir?: string,
  publicationCheck: (
    config: { backend: ResolvedStorageConfig["backend"]; homeDir?: string },
    publicationLockToken?: BackendPublicationLockToken,
  ) => void = assertStorageBackendPublication,
  publicationLockToken?: BackendPublicationLockToken,
): Promise<StorageBackendFactory> {
  const effectiveHome = homeDir ?? homedir();
  publicationCheck({ backend: config.backend, homeDir: effectiveHome }, publicationLockToken);
  return config.backend === "postgresql"
    ? createPostgreSqlStorageBackendFactoryWithHome(config, effectiveHome)
    : new SqliteStorageBackendFactory();
}
