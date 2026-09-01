import type { ProjectIdentity } from "../../project-map.js";
import { projectPaths, ensureProjectDir } from "../../daemon/project.js";
import {
  getExistingLcmConnection,
  getLcmConnection,
  closeLcmConnection,
  invalidateLcmConnection,
  inspectExistingLcmDatabasePath,
} from "../../db/connection.js";
import { getLcmDbFeatures, type LcmDbFeatures } from "../../db/features.js";
import { runLcmMigrations } from "../../db/migration.js";
import type {
  ProjectStorage,
  StorageBackendFactory,
  StorageCapabilities,
  StorageHealth,
} from "../contracts.js";
import { sqliteStorageCapabilities } from "../capabilities.js";
import { normalizeStorageError, StorageOperationError } from "../errors.js";
import { sqliteExecutorFor } from "./executor.js";
import { assertSqliteReady, SqliteReadinessRollbackError } from "./health.js";
import { SqliteProjectStorage } from "./project-storage.js";
import type { BackendPublicationLockToken } from "../backend-publication.js";
import { throwIfAborted } from "../../daemon/cancellation.js";

export class SqliteStorageBackendFactory implements StorageBackendFactory {
  readonly backend = "sqlite" as const;
  readonly capabilities: StorageCapabilities = sqliteStorageCapabilities("unknown");
  private readonly projects = new Set<SqliteProjectStorage>();
  private readonly knownProjects = new Map<string, { id: string; dbPath: string }>();
  private readonly pendingOpens = new Set<Promise<void>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: {
    resolveProject?: (identity: ProjectIdentity) => { id: string; dbPath: string };
    detectFeatures?: (db: ReturnType<typeof getLcmConnection>) => LcmDbFeatures;
  } = {}) {}

  async projectExists(
    identity: ProjectIdentity,
    publicationLockToken?: BackendPublicationLockToken,
  ): Promise<boolean> {
    this.assertOpen(identity, "projectExists");
    try {
      const paths = this.resolveProject(identity, publicationLockToken);
      this.assertIdentity(identity, paths.id, "projectExists");
      return inspectExistingLcmDatabasePath(paths.dbPath) !== null;
    } catch (error) {
      throw normalizeStorageError(
        error,
        { backend: "sqlite", projectId: identity.id, domain: "factory", operation: "projectExists" },
        "STORAGE_INITIALIZATION_FAILED",
      );
    }
  }

  async openProject(
    identity: ProjectIdentity,
    publicationLockToken?: BackendPublicationLockToken,
    signal?: AbortSignal,
  ): Promise<ProjectStorage> {
    return (await this.openResolvedProject(identity, "openProject", true, publicationLockToken, signal))!;
  }

  async openExistingProject(
    identity: ProjectIdentity,
    publicationLockToken?: BackendPublicationLockToken,
    signal?: AbortSignal,
  ): Promise<ProjectStorage | null> {
    return this.openResolvedProject(identity, "openExistingProject", false, publicationLockToken, signal);
  }

  private async openResolvedProject(
    identity: ProjectIdentity,
    operation: "openProject" | "openExistingProject",
    createIfMissing: boolean,
    publicationLockToken?: BackendPublicationLockToken,
    signal?: AbortSignal,
  ): Promise<ProjectStorage | null> {
    this.assertOpen(identity, operation);
    throwIfAborted(signal);
    let finishOpen!: () => void;
    const pendingOpen = new Promise<void>((resolve): void => { finishOpen = resolve; });
    this.pendingOpens.add(pendingOpen);
    let dbPath: string | undefined;
    let db: ReturnType<typeof getLcmConnection> | undefined;
    let storage: SqliteProjectStorage | undefined;
    try {
      throwIfAborted(signal);
      const paths = this.resolveProject(identity, publicationLockToken);
      this.assertIdentity(identity, paths.id, operation);
      if (createIfMissing && !this.options.resolveProject) {
        throwIfAborted(signal);
        ensureProjectDir(identity.canonical, publicationLockToken);
      }
      dbPath = paths.dbPath;
      throwIfAborted(signal);
      db = createIfMissing
        ? getLcmConnection(paths.dbPath)
        : getExistingLcmConnection(paths.dbPath) ?? undefined;
      if (!db) return null;
      throwIfAborted(signal);
      const executor = sqliteExecutorFor(
        db,
        paths.id,
        () => { invalidateLcmConnection(paths.dbPath, db!); },
      );
      let features: LcmDbFeatures;
      try {
        features = await executor.run("factory", operation, () => {
          throwIfAborted(signal);
          if (this.closed) this.assertOpen(identity, operation);
          const detected = (this.options.detectFeatures ?? getLcmDbFeatures)(db!);
          throwIfAborted(signal);
          if (this.closed) this.assertOpen(identity, operation);
          runLcmMigrations(db!, detected);
          return detected;
        });
      } catch (error) {
        if (error instanceof StorageOperationError && error.code === "STORAGE_CLOSED") {
          throw error;
        }
        throw new StorageOperationError(
          "STORAGE_INITIALIZATION_FAILED",
          "sqlite",
          identity.id,
          "factory",
          operation,
        );
      }
      this.assertOpen(identity, operation);
      throwIfAborted(signal);
      storage = new SqliteProjectStorage(
        paths.id,
        paths.dbPath,
        db,
        executor,
        sqliteStorageCapabilities(features.fts5Available),
        (closed): void => { this.projects.delete(closed); },
      );
      throwIfAborted(signal);
      this.assertOpen(identity, operation);
      this.projects.add(storage);
      this.knownProjects.set(`${paths.id}\0${paths.dbPath}`, { id: paths.id, dbPath: paths.dbPath });
      return storage;
    } catch (error) {
      if (storage) {
        try {
          await storage.close();
        } catch {
          // Preserve the primary open failure.
        }
      } else if (db && dbPath) {
        closeLcmConnection(dbPath, db);
      }
      throw normalizeStorageError(
        error,
        { backend: "sqlite", projectId: identity.id, domain: "factory", operation },
        "STORAGE_INITIALIZATION_FAILED",
      );
    } finally {
      this.pendingOpens.delete(pendingOpen);
      finishOpen();
    }
  }

  async health(): Promise<StorageHealth> {
    if (this.closed) return { status: "closed", backend: "sqlite" };
    await Promise.all([...this.pendingOpens]);
    if (this.closed) return { status: "closed", backend: "sqlite" };
    const activeProjectIds = new Set([...this.projects].map((project) => project.projectId));
    const idleProjects = [...this.knownProjects.values()].filter(
      (project) => !activeProjectIds.has(project.id),
    );
    const projectHealth = await Promise.all([
      ...[...this.projects].map((project) => project.health()),
      ...idleProjects.map((project) => this.probeKnownProject(project)),
    ]);
    if (this.closed) return { status: "closed", backend: "sqlite" };
    const unavailable = projectHealth.find((health) => health.status === "unavailable");
    if (!unavailable) return { status: "healthy", backend: "sqlite" };
    return {
      status: "unavailable",
      backend: "sqlite",
      error: unavailable.error,
    };
  }

  private async probeKnownProject(project: { id: string; dbPath: string }): Promise<StorageHealth> {
    let db: ReturnType<typeof getLcmConnection> | undefined;
    try {
      db = getExistingLcmConnection(project.dbPath) ?? undefined;
      if (!db) {
        throw new StorageOperationError(
          "STORAGE_OPERATION_FAILED",
          "sqlite",
          project.id,
          "factory",
          "health",
        );
      }
      const executor = sqliteExecutorFor(
        db,
        project.id,
        () => { invalidateLcmConnection(project.dbPath, db!); },
      );
      await executor.run("factory", "health", () => {
        try {
          assertSqliteReady(db!, project.id);
        } catch (error) {
          if (error instanceof SqliteReadinessRollbackError) {
            executor.poison();
          }
          throw error;
        }
      });
      return { status: "healthy", backend: "sqlite", projectId: project.id };
    } catch (error) {
      return {
        status: "unavailable",
        backend: "sqlite",
        projectId: project.id,
        error: normalizeStorageError(error, {
          backend: "sqlite",
          projectId: project.id,
          domain: "factory",
          operation: "health",
        }),
      };
    } finally {
      if (db) closeLcmConnection(project.dbPath, db);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.allSettled([...this.pendingOpens])
      .then(() => Promise.allSettled(
        [...this.projects].map(async (project) => project.close()),
      ))
      .then(() => undefined);
    return this.closePromise;
  }

  private assertOpen(identity: ProjectIdentity, operation: string): void {
    if (!this.closed) return;
    throw new StorageOperationError("STORAGE_CLOSED", "sqlite", identity.id, "factory", operation);
  }

  private resolveProject(
    identity: ProjectIdentity,
    publicationLockToken?: BackendPublicationLockToken,
  ): { id: string; dbPath: string } {
    return this.options.resolveProject?.(identity)
      ?? projectPaths(identity.canonical, publicationLockToken);
  }

  private assertIdentity(identity: ProjectIdentity, resolvedId: string, operation: string): void {
    if (resolvedId === identity.id) return;
    throw new StorageOperationError(
      "STORAGE_INITIALIZATION_FAILED",
      "sqlite",
      identity.id,
      "factory",
      operation,
    );
  }
}
