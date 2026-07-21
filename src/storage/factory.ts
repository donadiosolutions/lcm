import type { ResolvedStorageConfig } from "../daemon/config.js";
import type { StorageBackendFactory } from "./contracts.js";
import { StorageBackendUnavailableError } from "./backend.js";
import { SqliteStorageBackendFactory } from "./sqlite/factory.js";

export function createStorageBackendFactory(
  config: ResolvedStorageConfig,
): StorageBackendFactory {
  if (config.backend === "postgresql") {
    throw new StorageBackendUnavailableError(config.backend);
  }
  return new SqliteStorageBackendFactory();
}
