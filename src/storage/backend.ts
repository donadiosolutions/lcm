import type { StorageBackend } from "../daemon/config.js";
import {
  assertBackendPublicationConsumerAccess,
  withBackendPublicationConsumerLock,
} from "./backend-publication.js";

export type StorageBackendSelection = { backend: StorageBackend };

export type SelectedStorageBackend = { backend: "sqlite" };

export class StorageBackendUnavailableError extends Error {
  constructor(backend: "postgresql") {
    super(`The ${backend} storage backend is not available in this release; use storage.backend \"sqlite\" until PostgreSQL repository support lands.`);
    this.name = "StorageBackendUnavailableError";
  }
}

/** Select the configured implementation after the caller's required preflight. */
export function selectStorageBackend(config: StorageBackendSelection): SelectedStorageBackend {
  return withBackendPublicationConsumerLock(undefined, () => {
    assertBackendPublicationConsumerAccess({ backend: config.backend });
    if (config.backend === "postgresql") throw new StorageBackendUnavailableError(config.backend);
    return { backend: "sqlite" };
  });
}
