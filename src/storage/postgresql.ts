import type { ResolvedPostgreSqlConfig } from "../daemon/config.js";
import type {
  ProjectStorage,
  StorageBackendFactory,
  StorageHealth,
  StorageIdentityContext,
} from "./contracts.js";
import {
  createPostgreSqlStorageBackendFactory as createFactory,
} from "./postgresql/factory.js";

/** Curated public factory contract for explicit PostgreSQL callers. */
export type PostgreSqlStorageBackendFactory = Omit<StorageBackendFactory, "backend"> & {
  readonly backend: "postgresql";
};

export type {
  ProjectStorage,
  ResolvedPostgreSqlConfig,
  StorageHealth,
  StorageIdentityContext,
};

/** Create one eagerly verified PostgreSQL project-storage factory. */
export function createPostgreSqlStorageBackendFactory(
  config: ResolvedPostgreSqlConfig,
): Promise<PostgreSqlStorageBackendFactory> {
  return createFactory(config);
}
