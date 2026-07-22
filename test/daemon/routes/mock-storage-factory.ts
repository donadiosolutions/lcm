import type {
  ProjectStorage,
  StorageBackendFactory,
} from "../../../src/storage/index.js";

type MockStorageFactoryOptions = {
  projectExists?: StorageBackendFactory["projectExists"];
  openProject: (identity: Parameters<StorageBackendFactory["openProject"]>[0]) => Promise<ProjectStorage>;
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
    openExistingProject: async (identity) =>
      await projectExists(identity) ? options.openProject(identity) : null,
    openProject: options.openProject,
    health: async () => ({ status: "healthy", backend: "sqlite" }),
    close: options.close ?? (async () => undefined),
  };
}
