import { homedir } from "node:os";
import { isAbsolute, posix, win32 } from "node:path";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import type { ResolvedPostgreSqlConfig } from "../../daemon/config.js";
import { normalizeUuidV7 } from "../../machine-identity.js";
import { normalizeProjectPath } from "../../project-map.js";
import {
  backendPublicationCanonicalSha256,
  captureBackendPublicationState,
  readBackendPublicationJournal,
  type BackendPublicationLockToken,
} from "../backend-publication.js";
import {
  assertStorageBackendPublication,
  withStorageBackendConsumerLockAsync,
} from "../backend.js";
import type {
  ProjectStorage,
  StorageBackendFactory,
  StorageHealth,
  StorageIdentityContext,
} from "../contracts.js";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlConnectionSettings,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlRuntimeHealth,
  PostgreSqlTransactionOptions,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";
import {
  PostgreSqlIdentityRepository,
  type PostgreSqlIdentityExecutor,
  type RemoteProject,
} from "./identity-repository.js";
import {
  POSTGRESQL_STORAGE_CAPABILITIES,
  PostgreSqlProjectStorage,
  type PostgreSqlProjectStorageRuntime,
} from "./project-storage.js";
import { PostgreSqlRuntime } from "./runtime.js";
import {
  verifyPostgreSqlRuntimeSchema,
  type PostgreSqlRuntimeReadiness,
} from "./runtime-readiness.js";

const LOCAL_PROJECT_ID_PATTERN = /^[0-9a-f]{64}$/u;

export interface PostgreSqlFactoryRuntime
extends PostgreSqlProjectStorageRuntime {
  health(): Promise<PostgreSqlRuntimeHealth>;
  close(): Promise<void>;
}

/** Narrow dependency seam for deterministic factory lifecycle tests. */
export interface PostgreSqlFactoryDependencies {
  createRuntime(settings: PostgreSqlConnectionSettings): PostgreSqlFactoryRuntime;
  createProjectStorage?(
    runtime: PostgreSqlProjectStorageRuntime,
    projectId: string,
    machineId: string,
    onClose: (storage: ProjectStorage) => void | Promise<void>,
  ): ProjectStorage;
  verifyRuntimeSchema(
    executor: PostgreSqlQueryExecutor,
    options: { readonly expectedOwner: string; readonly signal?: AbortSignal },
  ): Promise<PostgreSqlRuntimeReadiness>;
  withConsumerLock<T>(
    homeDir: string | undefined,
    callback: (token: BackendPublicationLockToken) => Promise<T> | T,
  ): Promise<T>;
  assertPublication(
    selection: { backend: "postgresql"; homeDir?: string },
    token?: BackendPublicationLockToken,
  ): void;
  readJournal(homeDir?: string): ReturnType<typeof readBackendPublicationJournal>;
  captureState(homeDir?: string): ReturnType<typeof captureBackendPublicationState>;
  normalizePath(path: string): string;
}

const DEFAULT_POSTGRESQL_FACTORY_DEPENDENCIES: PostgreSqlFactoryDependencies = {
  createRuntime: (settings) => new PostgreSqlRuntime(settings),
  verifyRuntimeSchema: verifyPostgreSqlRuntimeSchema,
  withConsumerLock: withStorageBackendConsumerLockAsync,
  assertPublication: assertStorageBackendPublication,
  readJournal: readBackendPublicationJournal,
  captureState: captureBackendPublicationState,
  normalizePath: normalizeProjectPath,
};

type PublicationWitness = Readonly<{
  journalChecksum: string;
  journalPhase: "completed";
  targetBackend: "postgresql";
  stateSha256: string;
}>;

function initializationError(
  projectId: string | undefined,
  operation: string,
): StorageOperationError {
  return new StorageOperationError(
    "STORAGE_INITIALIZATION_FAILED",
    "postgresql",
    projectId,
    "factory",
    operation,
  );
}

function operationError(operation: string): StorageOperationError {
  return new StorageOperationError(
    "STORAGE_OPERATION_FAILED",
    "postgresql",
    undefined,
    "factory",
    operation,
  );
}

function safeFactoryError(
  error: unknown,
  projectId: string | undefined,
  operation: string,
): StorageOperationError {
  return error instanceof StorageOperationError && error.code === "STORAGE_CLOSED"
    ? new StorageOperationError(
        "STORAGE_CLOSED",
        "postgresql",
        projectId,
        "factory",
        operation,
      )
    : initializationError(projectId, operation);
}

function connectionSettings(
  config: ResolvedPostgreSqlConfig,
): PostgreSqlConnectionSettings {
  return {
    url: config.postgresql.url,
    caFile: config.postgresql.caFile,
    poolMax: config.postgresql.poolMax,
    connectionTimeoutMs: config.postgresql.connectionTimeoutMs,
    idleTimeoutMs: config.postgresql.idleTimeoutMs,
    statementTimeoutMs: config.postgresql.statementTimeoutMs,
  };
}

function exactUuidV7(value: unknown): value is string {
  return typeof value === "string"
    && normalizeUuidV7(value) === value;
}

function validPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !/[\0-\x1f\x7f]/u.test(value)
    && isAbsolute(value);
}

function validPortableAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !/[\0-\x1f\x7f]/u.test(value)
    && (posix.isAbsolute(value) || win32.isAbsolute(value));
}

function assertIdentity(
  identity: StorageIdentityContext,
  operation: string,
): asserts identity is StorageIdentityContext & {
  readonly localProjectId: string;
  readonly machineId: string;
  readonly remoteProjectId: string;
  readonly selectedPath: string;
} {
  if (
    !exactUuidV7(identity.id)
    || !exactUuidV7(identity.remoteProjectId)
    || !exactUuidV7(identity.machineId)
    || identity.remoteProjectId !== identity.id
    || typeof identity.localProjectId !== "string"
    || !LOCAL_PROJECT_ID_PATTERN.test(identity.localProjectId)
    || !validPath(identity.selectedPath)
  ) {
    throw initializationError(
      typeof identity.id === "string" ? identity.id : undefined,
      operation,
    );
  }
}

function assertRemoteIdentity(
  remote: RemoteProject,
  identity: StorageIdentityContext & {
    readonly machineId: string;
    readonly remoteProjectId: string;
    readonly selectedPath: string;
  },
  expectedNormalizedPath: string,
  operation: string,
): void {
  if (!exactUuidV7(remote.projectId) || remote.projectId !== identity.id) {
    throw initializationError(identity.id, operation);
  }
  const exactAliases = new Set<string>();
  const normalizedByPath = new Map<string, string>();
  const pathByNormalized = new Map<string, string>();
  let matchingAliases = 0;
  for (const alias of remote.aliases) {
    const validAliasPath = alias.machineId === identity.machineId
      ? validPath
      : validPortableAbsolutePath;
    if (
      !exactUuidV7(alias.machineId)
      || !validAliasPath(alias.path)
      || !validAliasPath(alias.normalizedPath)
    ) {
      throw initializationError(identity.id, operation);
    }
    const exactKey = `${alias.machineId}\0${alias.path}\0${alias.normalizedPath}`;
    const pathKey = `${alias.machineId}\0${alias.path}`;
    const normalizedKey = `${alias.machineId}\0${alias.normalizedPath}`;
    if (
      exactAliases.has(exactKey)
      || (
        normalizedByPath.has(pathKey)
        && normalizedByPath.get(pathKey) !== alias.normalizedPath
      )
      || (
        pathByNormalized.has(normalizedKey)
        && pathByNormalized.get(normalizedKey) !== alias.path
      )
    ) {
      throw initializationError(identity.id, operation);
    }
    exactAliases.add(exactKey);
    normalizedByPath.set(pathKey, alias.normalizedPath);
    pathByNormalized.set(normalizedKey, alias.path);
    if (
      alias.machineId === identity.machineId
      && alias.path === identity.selectedPath
      && alias.normalizedPath === expectedNormalizedPath
    ) {
      matchingAliases += 1;
    }
  }
  if (matchingAliases !== 1) {
    throw initializationError(identity.id, operation);
  }
}

function sanitizedRuntimeHealth(
  health: PostgreSqlRuntimeHealth,
): StorageHealth {
  if (health.status === "healthy" || health.status === "degraded") {
    return { status: health.status, backend: "postgresql" };
  }
  return {
    status: "unavailable",
    backend: "postgresql",
    error: initializationError(undefined, "health"),
  };
}

export class FactorySignalExecutor implements PostgreSqlIdentityExecutor {
  constructor(
    private readonly runtime: PostgreSqlFactoryRuntime,
    private readonly signal: AbortSignal,
  ) {}

  query<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    return this.runtime.query<R, I>(config, {
      ...options,
      signal: this.signal,
    });
  }

  transaction<T>(
    callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions & { readonly domain: "identity" },
  ): Promise<T> {
    return this.runtime.transaction(callback, {
      ...options,
      signal: this.signal,
    });
  }
}

export class PostgreSqlStorageBackendFactory implements StorageBackendFactory {
  readonly backend = "postgresql" as const;
  readonly capabilities = POSTGRESQL_STORAGE_CAPABILITIES;

  private readonly projects = new Set<ProjectStorage>();
  private readonly pendingOperations = new Set<Promise<void>>();
  private readonly abortController = new AbortController();
  private readonly identities: PostgreSqlIdentityRepository;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly runtime: PostgreSqlFactoryRuntime,
    private readonly homeDir: string,
    private readonly dependencies: PostgreSqlFactoryDependencies,
  ) {
    this.identities = new PostgreSqlIdentityRepository(
      new FactorySignalExecutor(runtime, this.abortController.signal),
    );
  }

  projectExists(
    identity: StorageIdentityContext,
    publicationLockToken?: BackendPublicationLockToken,
  ): Promise<boolean> {
    return this.runProjectOperation(identity, "projectExists", publicationLockToken)
      .then((remote) => remote !== null);
  }

  openExistingProject(
    identity: StorageIdentityContext,
    publicationLockToken?: BackendPublicationLockToken,
  ): Promise<ProjectStorage | null> {
    return this.openResolvedProject(identity, "openExistingProject", publicationLockToken);
  }

  async openProject(
    identity: StorageIdentityContext,
    publicationLockToken?: BackendPublicationLockToken,
  ): Promise<ProjectStorage> {
    const storage = await this.openResolvedProject(
      identity,
      "openProject",
      publicationLockToken,
    );
    if (storage === null) throw initializationError(identity.id, "openProject");
    return storage;
  }

  async health(): Promise<StorageHealth> {
    if (this.closed) return { status: "closed", backend: "postgresql" };
    while (!this.closed && this.pendingOperations.size > 0) {
      await Promise.all([...this.pendingOperations]);
    }
    if (this.closed) return { status: "closed", backend: "postgresql" };
    try {
      return sanitizedRuntimeHealth(await this.runtime.health());
    } catch {
      return {
        status: "unavailable",
        backend: "postgresql",
        error: initializationError(undefined, "health"),
      };
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.abortController.abort();
    const attempt = this.closeAttempt();
    this.closePromise = attempt.catch((): never => {
      this.closePromise = undefined;
      throw operationError("close");
    });
    return this.closePromise;
  }

  private openResolvedProject(
    identity: StorageIdentityContext,
    operation: "openExistingProject" | "openProject",
    publicationLockToken?: BackendPublicationLockToken,
  ): Promise<ProjectStorage | null> {
    const work = this.openResolvedProjectAttempt(
      identity,
      operation,
      publicationLockToken,
    );
    const settled = work.then(() => undefined, () => undefined);
    this.pendingOperations.add(settled);
    void settled.then(() => { this.pendingOperations.delete(settled); });
    return work;
  }

  private async openResolvedProjectAttempt(
    identity: StorageIdentityContext,
    operation: "openExistingProject" | "openProject",
    publicationLockToken?: BackendPublicationLockToken,
  ): Promise<ProjectStorage | null> {
    const remote = await this.runProjectOperation(
      identity,
      operation,
      publicationLockToken,
    );
    if (remote === null) return null;
    this.assertOpen(identity.id, operation);
    const onClose = (closed: ProjectStorage): void => {
      this.projects.delete(closed);
    };
    const storage = this.dependencies.createProjectStorage === undefined
      ? new PostgreSqlProjectStorage(
          this.runtime,
          remote.projectId,
          identity.machineId!,
          onClose,
        )
      : this.dependencies.createProjectStorage(
          this.runtime,
          remote.projectId,
          identity.machineId!,
          onClose,
        );
    try {
      this.assertOpen(identity.id, operation);
      this.projects.add(storage);
      return storage;
    } catch (error) {
      try {
        await storage.close();
      } catch {
        // Preserve the sanitized admission failure as the primary error.
      }
      throw safeFactoryError(error, identity.id, operation);
    }
  }

  private runProjectOperation(
    identity: StorageIdentityContext,
    operation: "projectExists" | "openExistingProject" | "openProject",
    publicationLockToken?: BackendPublicationLockToken,
  ): Promise<RemoteProject | null> {
    try {
      this.assertOpen(identity.id, operation);
    } catch (error) {
      return Promise.reject(error);
    }
    const work = (async (): Promise<RemoteProject | null> => {
      try {
        assertIdentity(identity, operation);
        this.assertOpen(identity.id, operation);
        const before = publicationLockToken === undefined
          ? await this.capturePublicationWitness()
          : this.assertPublicationToken(publicationLockToken);
        this.assertOpen(identity.id, operation);
        const expectedNormalizedPath = this.dependencies.normalizePath(
          identity.selectedPath,
        );
        const remote = await this.identities.getProject(identity.id);
        if (remote !== null) {
          assertRemoteIdentity(
            remote,
            identity,
            expectedNormalizedPath,
            operation,
          );
        }
        if (publicationLockToken === undefined) {
          const after = await this.capturePublicationWitness();
          if (backendPublicationCanonicalSha256(before)
              !== backendPublicationCanonicalSha256(after)) {
            throw initializationError(identity.id, operation);
          }
        } else {
          this.assertPublicationToken(publicationLockToken);
        }
        this.assertOpen(identity.id, operation);
        return remote;
      } catch (error) {
        throw safeFactoryError(error, identity.id, operation);
      }
    })();
    const settled = work.then(() => undefined, () => undefined);
    this.pendingOperations.add(settled);
    void settled.then(() => { this.pendingOperations.delete(settled); });
    return work;
  }

  private async capturePublicationWitness(): Promise<PublicationWitness> {
    return this.dependencies.withConsumerLock(this.homeDir, (token) => {
      this.dependencies.assertPublication({
        backend: "postgresql",
        homeDir: this.homeDir,
      }, token);
      const journal = this.dependencies.readJournal(this.homeDir);
      if (
        journal === null
        || journal.phase !== "completed"
        || journal.targetBackend !== "postgresql"
      ) {
        throw initializationError(undefined, "publicationAdmission");
      }
      return Object.freeze({
        journalChecksum: journal.checksumSha256,
        journalPhase: journal.phase,
        targetBackend: journal.targetBackend,
        stateSha256: backendPublicationCanonicalSha256(
          this.dependencies.captureState(this.homeDir),
        ),
      });
    });
  }

  private assertPublicationToken(token: BackendPublicationLockToken): undefined {
    this.dependencies.assertPublication({
      backend: "postgresql",
      homeDir: this.homeDir,
    }, token);
    return undefined;
  }

  private async closeAttempt(): Promise<void> {
    await Promise.all([...this.pendingOperations]);
    const projectResults = await Promise.allSettled(
      [...this.projects].map((project) => project.close()),
    );
    let runtimeFailure: unknown;
    try {
      await this.runtime.close();
    } catch (error) {
      runtimeFailure = error;
    }
    if (
      runtimeFailure !== undefined
      || projectResults.some((result) => result.status === "rejected")
    ) {
      throw operationError("close");
    }
  }

  private assertOpen(projectId: string | undefined, operation: string): void {
    if (!this.closed) return;
    throw new StorageOperationError(
      "STORAGE_CLOSED",
      "postgresql",
      projectId,
      "factory",
      operation,
    );
  }
}

/** Internal composition seam with an explicit home root and deterministic dependencies. */
export async function createPostgreSqlStorageBackendFactoryForTesting(
  config: ResolvedPostgreSqlConfig,
  homeDir: string,
  dependencies: PostgreSqlFactoryDependencies = DEFAULT_POSTGRESQL_FACTORY_DEPENDENCIES,
): Promise<PostgreSqlStorageBackendFactory> {
  if ((config as { backend?: unknown }).backend !== "postgresql") {
    throw initializationError(undefined, "createFactory");
  }
  let runtime: PostgreSqlFactoryRuntime | undefined;
  try {
    runtime = dependencies.createRuntime(connectionSettings(config));
    const health = await runtime.health();
    if (health.status !== "healthy") {
      throw initializationError(undefined, "createFactory");
    }
    await dependencies.verifyRuntimeSchema(runtime, {
      expectedOwner: config.postgresql.migrationRole,
    });
    return new PostgreSqlStorageBackendFactory(
      runtime,
      homeDir,
      dependencies,
    );
  } catch {
    if (runtime !== undefined) {
      try {
        await runtime.close();
      } catch {
        // The initialization error remains the only public failure.
      }
    }
    throw initializationError(undefined, "createFactory");
  }
}

export function createPostgreSqlStorageBackendFactory(
  config: ResolvedPostgreSqlConfig,
): Promise<PostgreSqlStorageBackendFactory> {
  return createPostgreSqlStorageBackendFactoryForTesting(config, homedir());
}
