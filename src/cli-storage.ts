import { inspectExistingLcmDatabasePath } from "./db/connection.js";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { loadDaemonConfig } from "./daemon/config.js";
import { ensureProjectDirForIdentity, projectIdentity, projectPathsForIdentity } from "./daemon/project.js";
import { hashProjectPath, readProjectMapSnapshot, resolveExistingProjectIdentity } from "./project-map.js";
import { configPath, lcmHomeDir } from "./runtime-paths.js";
import { ensurePrivateDirectory, atomicWritePrivateFileExclusive } from "./security-files.js";
import { selectStorageBackendForConfig, assertStorageBackendPublication } from "./storage/backend.js";
import { withBackendPublicationConsumerLockAsync } from "./storage/backend-publication.js";
import type { ProjectStorage, StorageBackendFactory } from "./storage/contracts.js";
import { createStorageBackendFactory } from "./storage/factory.js";
import { resolveStorageIdentityContext } from "./storage/identity-context.js";
import { withPublicationAdmissionRetry, type PublicationConvergence } from "./storage/publication-convergence.js";
import { SqliteStorageBackendFactory } from "./storage/sqlite/factory.js";

export class CliProjectStorageMissingError extends Error {
  constructor() {
    super("No LCM storage found for this project.");
    this.name = "CliProjectStorageMissingError";
  }
}

export type CliProjectContext = Readonly<{
  project: { id: string; canonical: string; dir: string; dbPath: string };
  config: ReturnType<typeof loadDaemonConfig>;
}>;

export type CliProjectOptions = Readonly<{
  create?: boolean;
  _lcmBaseDir?: string;
  _publicationConvergence?: PublicationConvergence;
  prepare?: (context: CliProjectContext) => Promise<void>;
}>;

/** Open one configured project and release both handles on every outcome. */
export async function withCliProjectStorage<T>(
  cwd: string,
  options: CliProjectOptions,
  callback: (context: CliProjectContext & { storage: ProjectStorage }) => Promise<T>,
): Promise<T> {
  const opened = await withPublicationAdmissionRetry(() => {
    const configFile = configPath();
    const config = loadDaemonConfig(configFile);
    selectStorageBackendForConfig(configFile, config.storage);
    return withBackendPublicationConsumerLockAsync(undefined, async token => {
      assertStorageBackendPublication(config.storage, token);
      const customBase = options._lcmBaseDir !== undefined && options._lcmBaseDir !== lcmHomeDir();
      if (customBase && config.storage.backend !== "sqlite") {
        throw new Error("Custom local storage paths are unavailable for PostgreSQL.");
      }
      let canonical = cwd;
      if (customBase) {
        try { canonical = realpathSync(cwd); } catch { /* Keep the established missing-path identity. */ }
      }
      const identity = customBase
        ? { id: hashProjectPath(canonical), canonical }
        : projectIdentity(cwd, config.storage, token);
      const localId = "localProjectId" in identity ? identity.localProjectId : identity.id;
      const local = { id: localId, canonical: identity.canonical };
      const paths = customBase
        ? { ...local, dir: join(options._lcmBaseDir!, "projects", localId), dbPath: join(options._lcmBaseDir!, "projects", localId, "db.sqlite") }
        : projectPathsForIdentity(local);
      const project = { ...paths, id: identity.id };
      const context = { project, config };
      await options.prepare?.(context);
      if (options.create && config.storage.backend === "sqlite") {
        if (customBase) {
          ensurePrivateDirectory(options._lcmBaseDir!);
          ensurePrivateDirectory(join(options._lcmBaseDir!, "projects"));
          ensurePrivateDirectory(paths.dir);
          atomicWritePrivateFileExclusive(join(paths.dir, "meta.json"), JSON.stringify({ cwd: canonical }, null, 2) + "\n");
        } else {
          ensureProjectDirForIdentity(local);
        }
      }
      const factory: StorageBackendFactory = customBase
        ? new SqliteStorageBackendFactory({ resolveProject: () => ({ id: identity.id, dbPath: paths.dbPath }) })
        : await createStorageBackendFactory(config.storage, undefined, undefined, token);
      try {
        const storage = options.create && config.storage.backend === "sqlite"
          ? await factory.openProject(identity, token)
          : await factory.openExistingProject(identity, token);
        if (!storage) {
          if (config.storage.backend === "sqlite") throw new CliProjectStorageMissingError();
          throw new Error("The bound PostgreSQL project is unavailable.");
        }
        return { ...context, storage, factory };
      } catch (error) {
        try { await factory.close(); } catch { /* Preserve the primary admission error. */ }
        throw error;
      }
    });
  }, options._publicationConvergence);
  let failed = false;
  try {
    return await callback(opened);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let closeFailed = false;
    try { await opened.storage.close(); } catch { closeFailed = true; }
    try { await opened.factory.close(); } catch { closeFailed = true; }
    if (!failed && closeFailed) throw new Error("LCM storage could not be closed.");
  }
}

/** Enumerate authenticated local bindings, including entries without SQLite metadata. */
export async function listCliProjects(): Promise<Array<{ id: string; canonical: string; aliases: readonly string[] }>> {
  const configFile = configPath();
  const config = loadDaemonConfig(configFile);
  selectStorageBackendForConfig(configFile, config.storage);
  return withBackendPublicationConsumerLockAsync(undefined, async token => {
    assertStorageBackendPublication(config.storage, token);
    const map = readProjectMapSnapshot(undefined, token);
    const selected = new Map<string, { id: string; canonical: string; aliases: readonly string[] }>();
    for (const [id, entry] of Object.entries(map)) {
      const existing = resolveExistingProjectIdentity(entry.canonical, token);
      const local = existing ?? { id, ...entry };
      if (local.id !== id && inspectExistingLcmDatabasePath(projectPathsForIdentity({id,canonical:entry.canonical}).dbPath) !== null) {
        throw new Error("Legacy worktree storage requires reconciliation before project enumeration.");
      }
      if (entry.remoteProjectId !== undefined && entry.remoteProjectId !== local.remoteProjectId) {
        throw new Error("Legacy worktree storage has a conflicting remote project binding.");
      }
      const identity = resolveStorageIdentityContext(config.storage, local, undefined, local.canonical);
      const prior = selected.get(identity.id);
      selected.set(identity.id, {
        id: identity.id,
        canonical: prior?.canonical ?? local.canonical,
        aliases: [...new Set([...(prior?.aliases ?? []), entry.canonical, ...entry.aliases])],
      });
    }
    return [...selected.values()];
  });
}
