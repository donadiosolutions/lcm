import type { ProjectIdentity } from "../../project-map.js";
import { existsSync } from "node:fs";
import { projectPaths, ensureProjectDir } from "../../daemon/project.js";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
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
import { SqliteProjectStorage } from "./project-storage.js";

export class SqliteStorageBackendFactory implements StorageBackendFactory {
  readonly backend = "sqlite" as const;
  readonly capabilities: StorageCapabilities = sqliteStorageCapabilities("unknown");
  private readonly projects = new Set<SqliteProjectStorage>();
  private readonly pendingOpens = new Set<Promise<void>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: {
    resolveProject?: (identity: ProjectIdentity) => { id: string; dbPath: string };
    detectFeatures?: (db: ReturnType<typeof getLcmConnection>) => LcmDbFeatures;
  } = {}) {}

  async projectExists(identity: ProjectIdentity): Promise<boolean> {
    this.assertOpen(identity, "projectExists");
    try {
      const paths = this.resolveProject(identity);
      this.assertIdentity(identity, paths.id, "projectExists");
      return existsSync(paths.dbPath);
    } catch (error) {
      throw normalizeStorageError(
        error,
        { backend: "sqlite", projectId: identity.id, domain: "factory", operation: "projectExists" },
        "STORAGE_INITIALIZATION_FAILED",
      );
    }
  }

  async openProject(identity: ProjectIdentity): Promise<ProjectStorage> {
    this.assertOpen(identity, "openProject");
    let finishOpen!: () => void;
    const pendingOpen = new Promise<void>((resolve): void => { finishOpen = resolve; });
    this.pendingOpens.add(pendingOpen);
    let dbPath: string | undefined;
    let db: ReturnType<typeof getLcmConnection> | undefined;
    try {
      const paths = this.resolveProject(identity);
      this.assertIdentity(identity, paths.id, "openProject");
      if (!this.options.resolveProject) ensureProjectDir(identity.canonical);
      dbPath = paths.dbPath;
      db = getLcmConnection(paths.dbPath);
      const executor = sqliteExecutorFor(db, paths.id);
      let features: LcmDbFeatures;
      try {
        features = await executor.run("factory", "openProject", () => {
          const detected = (this.options.detectFeatures ?? getLcmDbFeatures)(db!);
          runLcmMigrations(db!, detected);
          return detected;
        });
      } catch {
        throw new StorageOperationError(
          "STORAGE_INITIALIZATION_FAILED",
          "sqlite",
          identity.id,
          "factory",
          "openProject",
        );
      }
      this.assertOpen(identity, "openProject");
      const storage = new SqliteProjectStorage(
        paths.id,
        paths.dbPath,
        db,
        executor,
        sqliteStorageCapabilities(features.fts5Available),
        (closed): void => { this.projects.delete(closed); },
      );
      this.projects.add(storage);
      return storage;
    } catch (error) {
      if (db && dbPath) closeLcmConnection(dbPath);
      throw normalizeStorageError(
        error,
        { backend: "sqlite", projectId: identity.id, domain: "factory", operation: "openProject" },
        "STORAGE_INITIALIZATION_FAILED",
      );
    } finally {
      this.pendingOpens.delete(pendingOpen);
      finishOpen();
    }
  }

  async health(): Promise<StorageHealth> {
    return { status: this.closed ? "closed" : "healthy", backend: "sqlite" };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.all([...this.pendingOpens])
      .then(() => Promise.all([...this.projects].map((project) => project.close())))
      .then(() => undefined);
    return this.closePromise;
  }

  private assertOpen(identity: ProjectIdentity, operation: string): void {
    if (!this.closed) return;
    throw new StorageOperationError("STORAGE_CLOSED", "sqlite", identity.id, "factory", operation);
  }

  private resolveProject(identity: ProjectIdentity): { id: string; dbPath: string } {
    return this.options.resolveProject?.(identity) ?? projectPaths(identity.canonical);
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
