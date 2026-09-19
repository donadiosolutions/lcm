import { inspectExistingLcmDatabasePath } from "./db/connection.js";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadDaemonConfig } from "./daemon/config.js";
import { ensureProjectDirForIdentity, projectIdentity, projectPathsForIdentity } from "./daemon/project.js";
import {
  UnauthenticatedProjectIdentityError,
  hashProjectPath,
  isAuthenticatedProjectIdentity,
  normalizeProjectIdentityPath,
  readProjectMapSnapshot,
  resolveExistingProjectIdentity,
  resolveProjectIdentity,
} from "./project-map.js";
import { configPath, lcmHomeDir } from "./runtime-paths.js";
import { ensurePrivateDirectory, atomicWritePrivateFileExclusive } from "./security-files.js";
import { selectStorageBackendForConfig, assertStorageBackendPublication } from "./storage/backend.js";
import { withBackendPublicationConsumerLockAsync } from "./storage/backend-publication.js";
import type { ProjectStorage, StorageBackendFactory } from "./storage/contracts.js";
import { createStorageBackendFactory } from "./storage/factory.js";
import { resolveStorageIdentityContext } from "./storage/identity-context.js";
import { withPublicationAdmissionRetry, type PublicationConvergence } from "./storage/publication-convergence.js";
import { SqliteStorageBackendFactory } from "./storage/sqlite/factory.js";
import { ensureWorktreeProjectReconciled } from "./worktree-reconciliation.js";
import {
  assertProjectStorageIdentityActive,
  isAuthenticatedRetiredProjectIdentityFence,
} from "./worktree-reconciliation-fence.js";

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
  const outcome = await withPublicationAdmissionRetry(async () => {
    const configFile = configPath();
    const config = loadDaemonConfig(configFile);
    selectStorageBackendForConfig(configFile, config.storage);
    let admitted = false;
    try {
      const value = await withBackendPublicationConsumerLockAsync(undefined, async token => {
        // Admission may retry, but prepare/open/work/cleanup may already have effects.
        admitted = true;
        assertStorageBackendPublication(config.storage, token);
        const customBase = options._lcmBaseDir !== undefined && options._lcmBaseDir !== lcmHomeDir();
        if (customBase && config.storage.backend !== "sqlite") {
          throw new Error("Custom local storage paths are unavailable for PostgreSQL.");
        }
        let canonical = cwd;
        if (customBase) {
          try { canonical = realpathSync(cwd); } catch { /* Keep the established missing-path identity. */ }
        }
        if (!customBase) {
          // Classify a retired local project-identity fence before
          // reconciliation runs and before any backend-specific identity
          // resolution, independently of the selected storage backend.
          // Reconciliation itself can fail with a generic ENOTDIR error when
          // a sibling worktree source still targets the fenced path (it
          // tries to open the fence file as a directory), and a PostgreSQL
          // binding's remote-identity lookup can throw its own generic
          // unbound-project message before a later SQLite-only check would
          // run. Either failure would shadow this diagnostic, so classify
          // first. This preview stays read-only: a persisted binding is the
          // identity to authenticate, and an unmapped path is authenticated
          // against the identity it would derive, so a fence is diagnosed
          // without registering a project ahead of reconciliation.
          const persisted = resolveExistingProjectIdentity(cwd, token);
          const previewCanonical = normalizeProjectIdentityPath(cwd);
          const preReconciliationPreview = persisted
            ?? { id: hashProjectPath(previewCanonical), canonical: previewCanonical };
          assertProjectStorageIdentityActive(
            projectPathsForIdentity(preReconciliationPreview).dir,
            preReconciliationPreview.id,
          );
          ensureWorktreeProjectReconciled(cwd, undefined, { _publicationLockToken: token });
          // Re-check after reconciliation: a freshly reconciled or renewed
          // binding must still be validated, since reconciliation can mint
          // a new identity that the pre-check above never observed.
          const localPreview = resolveProjectIdentity(cwd, { _publicationLockToken: token });
          assertProjectStorageIdentityActive(projectPathsForIdentity(localPreview).dir, localPreview.id);
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
        if (customBase) {
          assertProjectStorageIdentityActive(paths.dir, localId);
        }
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
        let storage: ProjectStorage | null;
        try {
          storage = options.create && config.storage.backend === "sqlite"
            ? await factory.openProject(identity, token)
            : await factory.openExistingProject(identity, token);
          if (!storage) {
            if (config.storage.backend === "sqlite") throw new CliProjectStorageMissingError();
            throw new Error("The bound PostgreSQL project is unavailable.");
          }
        } catch (error) {
          try { await factory.close(token); } catch { /* Preserve the primary admission error. */ }
          throw error;
        }
        let failed = false;
        try {
          return await callback({ ...context, storage });
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          let closeFailed = false;
          try { await storage.close(token); } catch { closeFailed = true; }
          try { await factory.close(token); } catch { closeFailed = true; }
          if (!failed && closeFailed) throw new Error("LCM storage could not be closed.");
        }
      });
      return { succeeded: true as const, value };
    } catch (error) {
      if (!admitted) throw error;
      // Return admitted failures past the retry boundary, including post-check errors.
      return { succeeded: false as const, error };
    }
  }, options._publicationConvergence);
  if (!outcome.succeeded) throw outcome.error;
  return outcome.value;
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
      let existing: ReturnType<typeof resolveExistingProjectIdentity>;
      try {
        existing = resolveExistingProjectIdentity(entry.canonical, token);
      } catch (error) {
        // An entry whose key no local evidence authenticates is refused by
        // admission and reconciliation, so enumerating it would advertise a
        // project that cannot be opened. Skip it and keep the inventory whole
        // for every other project.
        if (error instanceof UnauthenticatedProjectIdentityError) continue;
        throw error;
      }
      const local = existing ?? { id, ...entry };
      // A successor-shaped identity resolves normally but is only openable
      // while its retained predecessor fence authenticates it. Enumerating an
      // unauthenticated one would advertise a project that admission and
      // reconciliation refuse.
      if (!isAuthenticatedProjectIdentity(local.id, resolve(local.canonical))) continue;
      if (local.id !== id && inspectExistingLcmDatabasePath(projectPathsForIdentity({id,canonical:entry.canonical}).dbPath) !== null) {
        throw new Error("Legacy worktree storage requires reconciliation before project enumeration.");
      }
      if (entry.remoteProjectId !== undefined && entry.remoteProjectId !== local.remoteProjectId) {
        throw new Error("Legacy worktree storage has a conflicting remote project binding.");
      }
      // Classify a retired local project-identity fence before any
      // backend-specific identity resolution runs. Under a PostgreSQL
      // config, resolveStorageIdentityContext throws its generic
      // unbound-project message for any entry without a remote binding,
      // including a fenced one; that would escape this loop and abort the
      // whole enumeration, so a fenced project would never reach the
      // per-project RetiredProjectIdentityError branch in the caller. A
      // fenced entry enumerates with its own local identity instead, which
      // keeps enumeration whole for every other project.
      const identity = isAuthenticatedRetiredProjectIdentityFence(projectPathsForIdentity(local).dir, local.id)
        ? local
        : resolveStorageIdentityContext(config.storage, local, undefined, local.canonical);
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
