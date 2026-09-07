import type { StorageBackend } from "../daemon/config.js";
import {
  BackendPublicationJournalError,
  assertBackendPublicationConsumerAccess,
  backendPublicationHomeForConfigPath,
  withBackendPublicationConsumerLock,
  withBackendPublicationConsumerLockAsync,
} from "./backend-publication.js";

export type StorageBackendSelection = {
  backend: StorageBackend;
  homeDir?: string;
};

export type SelectedStorageBackend = { backend: StorageBackend };

export class StorageBackendUnavailableError extends Error {
  constructor(backend: "postgresql") {
    super(`This operation is not available for the ${backend} storage backend.`);
    this.name = "StorageBackendUnavailableError";
  }
}

function publicationError(
  reason: BackendPublicationJournalError["reason"],
  message: string,
): never {
  throw new BackendPublicationJournalError(reason, message);
}

/** Run a short synchronous backend-publication admission check. */
export function withStorageBackendConsumerLock<T>(
  homeDir: string | undefined,
  callback: (lockToken: object) => T,
): T {
  return withBackendPublicationConsumerLock(homeDir, callback);
}

/** Run a short asynchronous backend-publication admission check. */
export async function withStorageBackendConsumerLockAsync<T>(
  homeDir: string | undefined,
  callback: (lockToken: object) => Promise<T> | T,
): Promise<T> {
  return withBackendPublicationConsumerLockAsync(homeDir, callback);
}

/** Authenticate the selected backend against durable publication state. */
export function assertStorageBackendPublication(
  config: StorageBackendSelection,
  lockToken?: object,
): void {
  return assertBackendPublicationConsumerAccess({
    backend: config.backend,
    homeDir: config.homeDir,
    lockToken,
  });
}

/** Select the configured implementation after the caller's required preflight. */
export function selectStorageBackend(config: StorageBackendSelection): SelectedStorageBackend {
  assertStorageBackendPublication(config);
  return { backend: config.backend };
}

/** Select storage using the publication scope authenticated by a canonical config path. */
export function selectStorageBackendForConfig(
  configPath: string,
  config: StorageBackendSelection,
): SelectedStorageBackend {
  const homeDir = backendPublicationHomeForConfigPath(configPath);
  if (homeDir === undefined) {
    return publicationError("unsafe-storage", "storage selection requires the canonical LCM configuration path");
  }
  return selectStorageBackend({ ...config, homeDir });
}
