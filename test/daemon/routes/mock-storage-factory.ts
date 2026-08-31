import type {
  ProjectStorage,
  StorageBackendFactory,
} from "../../../src/storage/index.js";
import { StorageOperationError } from "../../../src/storage/errors.js";

type MockStorageFactoryOptions = {
  projectExists?: StorageBackendFactory["projectExists"];
  openProject: StorageBackendFactory["openProject"];
  close?: StorageBackendFactory["close"];
};

/** Build a structurally complete storage factory around route-focused repository mocks. */
export function makeMockStorageFactory(options: MockStorageFactoryOptions): StorageBackendFactory {
  const projectExists = options.projectExists ?? (async () => true);
  return {
    backend: "sqlite",
    capabilities: {
      transactions: true,
      lexicalSearch: true,
      regexSearch: true,
      nativeFullTextSearch: "available",
      coordination: "local",
    },
    projectExists,
    openExistingProject: async (identity, token, signal) =>
      await projectExists(identity, token) ? options.openProject(identity, token, signal) : null,
    openProject: options.openProject,
    health: async () => ({ status: "healthy", backend: "sqlite" }),
    close: options.close ?? (async () => undefined),
  };
}

/** Test-only replacement for the removed staged PostgreSQL factory. */
export function makeStagedPostgreSqlStorageFactory(): StorageBackendFactory {
  let closed = false;
  const failure = (identity: { id?: string }, operation: string): StorageOperationError =>
    new StorageOperationError(
      closed ? "STORAGE_CLOSED" : "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      identity.id,
      "factory",
      operation,
    );
  return {
    backend: "postgresql",
    capabilities: {
      transactions: false,
      lexicalSearch: false,
      regexSearch: false,
      nativeFullTextSearch: "unavailable",
      coordination: "distributed",
    },
    projectExists: async identity => { throw failure(identity, "projectExists"); },
    openExistingProject: async identity => { throw failure(identity, "openExistingProject"); },
    openProject: async identity => { throw failure(identity, "openProject"); },
    health: async () => closed
      ? { status: "closed", backend: "postgresql" }
      : {
          status: "unavailable",
          backend: "postgresql",
          error: failure({}, "health"),
        },
    close: async () => { closed = true; },
  };
}
