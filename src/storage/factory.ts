import type { ResolvedStorageConfig } from "../daemon/config.js";
import type {
  ProjectStorage,
  StorageBackendFactory,
  StorageCapabilities,
  StorageHealth,
  StorageIdentityContext,
} from "./contracts.js";
import { StorageOperationError } from "./errors.js";
import {
  assertBackendPublicationConsumerAccess,
  withBackendPublicationConsumerLock,
} from "./backend-publication.js";
import { SqliteStorageBackendFactory } from "./sqlite/factory.js";

const unavailablePostgreSqlCapabilities: StorageCapabilities = Object.freeze({
  transactions: false,
  lexicalSearch: false,
  regexSearch: false,
  nativeFullTextSearch: "unavailable",
  coordination: "distributed",
});

/**
 * Staged daemon boundary for PostgreSQL identity support.
 *
 * Domain repositories are intentionally unavailable until PostgreSQL storage
 * parity lands. Keeping this as a factory lets routes resolve and validate
 * their machine/project identity before failing safely at the storage seam.
 */
export class UnavailablePostgreSqlStorageBackendFactory implements StorageBackendFactory {
  readonly backend = "postgresql" as const;
  readonly capabilities = unavailablePostgreSqlCapabilities;
  private closed = false;

  projectExists(identity: StorageIdentityContext): Promise<boolean> {
    return Promise.reject(this.unavailable(identity, "projectExists"));
  }

  openExistingProject(identity: StorageIdentityContext): Promise<ProjectStorage | null> {
    return Promise.reject(this.unavailable(identity, "openExistingProject"));
  }

  openProject(identity: StorageIdentityContext): Promise<ProjectStorage> {
    return Promise.reject(this.unavailable(identity, "openProject"));
  }

  health(): Promise<StorageHealth> {
    if (this.closed) return Promise.resolve({ status: "closed", backend: "postgresql" });
    return Promise.resolve({
      status: "unavailable",
      backend: "postgresql",
      error: new StorageOperationError(
        "STORAGE_INITIALIZATION_FAILED",
        "postgresql",
        undefined,
        "factory",
        "health",
      ),
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private unavailable(identity: StorageIdentityContext, operation: string): StorageOperationError {
    return new StorageOperationError(
      this.closed ? "STORAGE_CLOSED" : "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      identity.id,
      "factory",
      operation,
    );
  }
}

export function createStorageBackendFactory(
  config: ResolvedStorageConfig,
): StorageBackendFactory {
  return withBackendPublicationConsumerLock(undefined, () => {
    assertBackendPublicationConsumerAccess({ backend: config.backend });
    if (config.backend === "postgresql") {
      return new UnavailablePostgreSqlStorageBackendFactory();
    }
    return new SqliteStorageBackendFactory();
  });
}
