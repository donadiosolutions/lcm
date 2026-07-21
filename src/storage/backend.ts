import type { ResolvedStorageConfig } from "../daemon/config.js";

export type SelectedStorageBackend = { backend: "sqlite" };

export class StorageBackendUnavailableError extends Error {
  constructor(backend: "postgresql") {
    super(`The ${backend} storage backend is not available in this release; use storage.backend \"sqlite\" until PostgreSQL repository support lands.`);
    this.name = "StorageBackendUnavailableError";
  }
}

/** Select the configured implementation only after configuration and TLS preflight succeed. */
export function selectStorageBackend(config: ResolvedStorageConfig): SelectedStorageBackend {
  if (config.backend === "postgresql") throw new StorageBackendUnavailableError(config.backend);
  return { backend: "sqlite" };
}
