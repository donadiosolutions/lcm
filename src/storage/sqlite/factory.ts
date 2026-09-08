import type { ProjectIdentity } from "../../project-map.js";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
import {
  createMachineIdentity,
  readMachineIdentity,
  type MachineIdentity,
  type StoredMachineIdentity,
} from "../../machine-identity.js";
import { LocalHookEventSequenceAllocator } from "../local-hook-event-sequence.js";
import {
  adoptMigrationReceiptEpoch,
  assertMigrationReceiptEpochParticipant,
} from "../../migration/receipts.js";
import { SQLiteLocalHookOutboxFactory } from "../local-hook-outbox.js";
import {
  assertBackendPublicationConsumerAccess,
  withBackendPublicationAppendBarrierAsync,
  withBackendPublicationConsumerLock,
  type BackendPublicationAppendBarrierOptions,
} from "../backend-publication.js";

type OwnedProjectConnection = {
  dbPath: string;
  db: ReturnType<typeof getLcmConnection>;
  closePromise?: Promise<void>;
  releaseCommitted: boolean;
};

export class SqliteStorageBackendFactory implements StorageBackendFactory {
  readonly backend = "sqlite" as const;
  readonly capabilities: StorageCapabilities = sqliteStorageCapabilities("unknown");
  private readonly projects = new Set<SqliteProjectStorage>();
  private readonly knownProjects = new Map<string, { id: string; dbPath: string }>();
  private readonly ownedConnections = new Set<OwnedProjectConnection>();
  private readonly pendingOpens = new Set<Promise<void>>();
  private readonly pendingHealth = new Set<Promise<void>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: {
    resolveProject?: (identity: ProjectIdentity) => { id: string; dbPath: string };
    detectFeatures?: (db: ReturnType<typeof getLcmConnection>) => LcmDbFeatures;
    /** @internal Deterministic physical-close admission seams. */
    _appendBarrierOptions?: BackendPublicationAppendBarrierOptions;
    /** @internal Intended identity used only by migration enrollment. */
    _migrationEnrollmentIdentity?: MachineIdentity;
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
    let ownedConnection: OwnedProjectConnection | undefined;
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
      await this.releaseOwnedConnectionsForPath(dbPath, publicationLockToken);
      throwIfAborted(signal);
      const sourceHome = sqliteProjectHomeDir(paths.dbPath);
      if (sourceHome !== undefined && this.options._migrationEnrollmentIdentity !== undefined) {
        this.enrollmentMachineIdentity(sourceHome, publicationLockToken);
      }
      db = sourceHome === undefined
        ? (createIfMissing ? getLcmConnection(paths.dbPath) : getExistingLcmConnection(paths.dbPath) ?? undefined)
        : withBackendPublicationConsumerLock(sourceHome, (token) => {
          assertBackendPublicationConsumerAccess({ homeDir: sourceHome, backend: "sqlite", lockToken: token });
          return createIfMissing ? getLcmConnection(paths.dbPath) : getExistingLcmConnection(paths.dbPath) ?? undefined;
        }, { lockToken: publicationLockToken });
      if (!db) return null;
      ownedConnection = { dbPath: paths.dbPath, db, releaseCommitted: false };
      throwIfAborted(signal);
      const executor = sqliteExecutorFor(
        db,
        paths.id,
        () => { invalidateLcmConnection(paths.dbPath, db!); },
      );
      const admission = {
        homeDir: sqliteProjectHomeDir(paths.dbPath),
        ...(this.options._appendBarrierOptions === undefined
          ? {}
          : { _appendBarrierOptions: this.options._appendBarrierOptions }),
        ...(publicationLockToken === undefined ? {} : { lockToken: publicationLockToken }),
      };
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
        }, admission);
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
      const homeDir = admission.homeDir;
      if (homeDir !== undefined) {
        const machine = this.enrollmentMachineIdentity(homeDir, publicationLockToken);
        if (machine?.machineId !== null && machine?.machineId !== undefined) {
          await withBackendPublicationAppendBarrierAsync(homeDir, async (token) => {
            assertBackendPublicationConsumerAccess({ homeDir, backend: "sqlite", lockToken: token });
            const admittedMachine = this.enrollmentMachineIdentity(homeDir, token);
            if (admittedMachine?.machineId !== machine.machineId) {
              throw new Error("SQLite migration enrollment identity changed before preparation");
            }
            const outboxFactory = new SQLiteLocalHookOutboxFactory();
            try {
              await outboxFactory.open(join(homeDir, ".lcm", "events", `${paths.id}.db`), {}, token);
            } finally {
              await outboxFactory.close();
            }
            const allocator = new LocalHookEventSequenceAllocator(
              join(homeDir, ".lcm", "events", ".machine-sequence.sqlite"),
            );
            try {
              const firstMachineSequence = allocator.peekNextSequence().toString().padStart(19, "0");
              const currentMachine = this.enrollmentMachineIdentity(homeDir, token);
              if (currentMachine?.machineId !== admittedMachine.machineId) {
                throw new Error("SQLite migration enrollment identity changed before epoch adoption");
              }
              assertMigrationReceiptEpochParticipant(
                db!,
                paths.id,
                admittedMachine.machineId,
              );
              adoptMigrationReceiptEpoch(db!, {
                projectId: paths.id,
                machineId: admittedMachine.machineId,
                epochId: randomUUID(),
                firstMachineSequence,
                establishedAt: `${new Date().toISOString().slice(0, -1)}000Z`,
              });
            } finally {
              allocator.close();
            }
          }, publicationLockToken);
        }
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
        admission,
      );
      ownedConnection = undefined;
      this.projects.add(storage);
      throwIfAborted(signal);
      this.assertOpen(identity, operation);
      this.knownProjects.set(`${paths.id}\0${paths.dbPath}`, { id: paths.id, dbPath: paths.dbPath });
      return storage;
    } catch (error) {
      if (storage) {
        try {
          await storage.close(publicationLockToken);
        } catch {
          // Preserve the primary open failure.
        }
      } else if (ownedConnection) {
        try {
          await this.releaseOwnedConnection(ownedConnection, publicationLockToken);
        } catch {
          // Preserve the primary open failure; factory close owns the retry.
        }
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
    let finishHealth!: () => void;
    const pendingHealth = new Promise<void>(resolve => { finishHealth = resolve; });
    this.pendingHealth.add(pendingHealth);
    try {
      return await this.healthOnce();
    } finally {
      this.pendingHealth.delete(pendingHealth);
      finishHealth();
    }
  }

  private async healthOnce(): Promise<StorageHealth> {
    if (this.closed) return { status: "closed", backend: "sqlite" };
    await Promise.all([...this.pendingOpens]);
    if (this.closed) return { status: "closed", backend: "sqlite" };
    const activeProjectIds = new Set([...this.projects].map((project) => project.projectId));
    const idleProjects = [...this.knownProjects.values()].filter(
      (project) => !activeProjectIds.has(project.id),
    );
    const projectHealth = await Promise.all([
      ...[...this.projects].map((project) => project.healthWithFreshAdmission()),
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
    let ownedConnection: OwnedProjectConnection | undefined;
    let candidate: StorageHealth;
    try {
      await this.releaseOwnedConnectionsForPath(project.dbPath);
      const homeDir = sqliteProjectHomeDir(project.dbPath);
      db = homeDir === undefined
        ? getExistingLcmConnection(project.dbPath) ?? undefined
        : withBackendPublicationConsumerLock(homeDir, (token) => {
          assertBackendPublicationConsumerAccess({ homeDir, backend: "sqlite", lockToken: token });
          return getExistingLcmConnection(project.dbPath) ?? undefined;
        });
      if (!db) {
        throw new StorageOperationError(
          "STORAGE_OPERATION_FAILED",
          "sqlite",
          project.id,
          "factory",
          "health",
        );
      }
      ownedConnection = { dbPath: project.dbPath, db, releaseCommitted: false };
      this.ownedConnections.add(ownedConnection);
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
      }, { homeDir });
      candidate = { status: "healthy", backend: "sqlite", projectId: project.id };
    } catch (error) {
      candidate = {
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
    }
    if (ownedConnection) {
      try {
        await this.releaseOwnedConnection(ownedConnection);
      } catch (error) {
        if (candidate.status !== "unavailable") {
          candidate = {
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
        }
      }
    }
    return candidate;
  }

  close(publicationLockToken?: BackendPublicationLockToken): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const attempt = Promise.allSettled([
      ...this.pendingOpens,
      ...this.pendingHealth,
    ]).then(async () => {
      const outcomes = await Promise.allSettled([
        ...[...this.projects].map((project) => project.close(publicationLockToken)),
        ...[...this.ownedConnections].map((connection) => (
          this.releaseOwnedConnection(connection, publicationLockToken)
        )),
      ]);
      const failures = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
        .map(outcome => outcome.reason as unknown);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "SQLite project factory close failed");
      }
    });
    this.closePromise = attempt.catch((error: unknown): never => {
      this.closePromise = undefined;
      throw error;
    });
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

  private async releaseOwnedConnectionsForPath(
    dbPath: string,
    publicationLockToken?: BackendPublicationLockToken,
  ): Promise<void> {
    const retained = [...this.ownedConnections].filter(connection => connection.dbPath === dbPath);
    const outcomes = await Promise.allSettled(
      retained.map(connection => this.releaseOwnedConnection(connection, publicationLockToken)),
    );
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      .map(outcome => outcome.reason as unknown);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "SQLite retained connection cleanup failed");
    }
  }

  private enrollmentMachineIdentity(
    homeDir: string,
    publicationLockToken?: BackendPublicationLockToken,
  ): StoredMachineIdentity | null {
    const intended = this.options._migrationEnrollmentIdentity;
    if (intended === undefined) return readMachineIdentity(homeDir);
    if (publicationLockToken === undefined) {
      throw new Error("SQLite migration enrollment identity requires a live publication token");
    }
    assertBackendPublicationConsumerAccess({
      homeDir,
      backend: "sqlite",
      lockToken: publicationLockToken,
    });
    const current = readMachineIdentity(homeDir);
    if (
      current === null
      || current.identityKey !== intended.identityKey
      || (current.machineId !== null && current.machineId !== intended.machineId)
    ) {
      throw new Error("SQLite migration enrollment identity does not match machine.json");
    }
    const validated = createMachineIdentity(
      current,
      intended.machineId,
      intended.displayName,
    );
    if (
      intended.version !== validated.version
      || intended.machineId !== validated.machineId
      || intended.displayName !== validated.displayName
    ) {
      throw new Error("SQLite migration enrollment identity is invalid");
    }
    return validated;
  }

  private async releaseOwnedConnection(
    connection: OwnedProjectConnection,
    publicationLockToken?: BackendPublicationLockToken,
  ): Promise<void> {
    if (connection.closePromise) return connection.closePromise;
    const attempt = closeProjectConnection(
        connection.dbPath,
        connection.db,
        publicationLockToken,
        this.options._appendBarrierOptions,
        () => {
          connection.releaseCommitted = true;
          this.ownedConnections.delete(connection);
        },
      );
    connection.closePromise = attempt.catch((error: unknown): never => {
      if (!connection.releaseCommitted) {
        connection.closePromise = undefined;
        this.ownedConnections.add(connection);
        if (this.closed) this.closePromise = undefined;
      }
      throw error;
    });
    return connection.closePromise;
  }
}

function sqliteProjectHomeDir(dbPath: string): string | undefined {
  const projectDirectory = dirname(resolve(dbPath));
  const projectsDirectory = dirname(projectDirectory);
  const lcmDirectory = dirname(projectsDirectory);
  return basename(projectsDirectory) === "projects" && basename(lcmDirectory) === ".lcm"
    ? dirname(lcmDirectory)
    : undefined;
}

async function closeProjectConnection(
  dbPath: string,
  db: ReturnType<typeof getLcmConnection>,
  publicationLockToken: BackendPublicationLockToken | undefined,
  appendBarrierOptions: BackendPublicationAppendBarrierOptions | undefined,
  onCommit: () => void,
): Promise<void> {
  const release = (): void => {
    closeLcmConnection(dbPath, db);
    onCommit();
  };
  const homeDir = sqliteProjectHomeDir(dbPath);
  if (homeDir === undefined) {
    release();
    return;
  }
  await withBackendPublicationAppendBarrierAsync(
    homeDir,
    release,
    publicationLockToken,
    { contentionWaitMs: 5_000, ...appendBarrierOptions },
  );
}
