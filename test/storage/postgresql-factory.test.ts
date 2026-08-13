import { describe, expect, it } from "vitest";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import type { ResolvedPostgreSqlConfig } from "../../src/daemon/config.js";
import type {
  BackendPublicationJournal,
  BackendPublicationLockToken,
  BackendPublicationStateWitness,
} from "../../src/storage/backend-publication.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import type { ProjectStorage } from "../../src/storage/contracts.js";
import {
  createPostgreSqlStorageBackendFactory,
  createPostgreSqlStorageBackendFactoryForTesting,
  FactorySignalExecutor,
  type PostgreSqlFactoryDependencies,
} from "../../src/storage/postgresql/factory.js";
import type {
  PostgreSqlQueryOptions,
  PostgreSqlRuntimeHealth,
  PostgreSqlTransactionOptions,
  PostgreSqlTransactionScopeExecutor,
} from "../../src/storage/postgresql/index.js";
import type { RemoteProject } from "../../src/storage/postgresql/identity-repository.js";
import { PostgreSqlProjectStorage } from "../../src/storage/postgresql/project-storage.js";

const PROJECT_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const MACHINE_ID = "0195d250-0000-7000-8000-000000000002";
const SELECTED_PATH = "/repo/selected";
const NORMALIZED_PATH = "/repo/canonical";

const config: ResolvedPostgreSqlConfig = {
  backend: "postgresql",
  postgresql: {
    poolMax: 5,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    statementTimeoutMs: 60_000,
    migrationRole: "lcm_migrator",
    url: "postgresql://runtime:canary-password@db.example/lcm",
    caFile: "/private/canary-ca.pem",
  },
};

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

const healthy: PostgreSqlRuntimeHealth = {
  status: "healthy",
  backend: "postgresql",
  serverMajorVersion: 18,
  serverEncoding: "UTF8",
  tls: true,
  timezone: "UTC",
  role: "lcm_runtime",
};

const state: BackendPublicationStateWitness = Object.freeze({
  config: Object.freeze({
    presence: "absent",
    rawSha256: null,
    semanticSha256: null,
    byteLength: 0,
    mode: null,
    uid: null,
    gid: null,
    nlink: null,
    dev: null,
    ino: null,
    parentDev: null,
    parentIno: null,
  }),
  projectMap: Object.freeze({
    presence: "absent",
    rawSha256: null,
    semanticSha256: null,
    byteLength: 0,
    mode: null,
    uid: null,
    gid: null,
    nlink: null,
    dev: null,
    ino: null,
    parentDev: null,
    parentIno: null,
  }),
});

const journal = Object.freeze({
  phase: "completed",
  targetBackend: "postgresql",
  checksumSha256: "a".repeat(64),
}) as BackendPublicationJournal;

const identity: StorageIdentityContext = {
  id: PROJECT_ID,
  localProjectId: "b".repeat(64),
  canonical: "/repo/main",
  remoteProjectId: PROJECT_ID,
  machineId: MACHINE_ID,
  selectedPath: SELECTED_PATH,
};

const remoteProject: RemoteProject = {
  projectId: PROJECT_ID,
  displayName: "Project",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  aliases: [{
    machineId: MACHINE_ID,
    path: SELECTED_PATH,
    normalizedPath: NORMALIZED_PATH,
    linkedAt: "2026-01-01T00:00:00.000Z",
  }],
};

class FakeRuntime {
  readonly transactions: PostgreSqlTransactionOptions[] = [];
  closeAttempts = 0;
  healthResult: PostgreSqlRuntimeHealth = healthy;
  closeFailure: Error | undefined;
  project: RemoteProject | null = remoteProject;

  health(): Promise<PostgreSqlRuntimeHealth> {
    return Promise.resolve(this.healthResult);
  }

  query<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    _config: QueryConfig<I>,
    _options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    const rows = this.project === null
      ? []
      : [{
        project_id: this.project.projectId,
        display_name: this.project.displayName,
        created_at: this.project.createdAt,
        updated_at: this.project.updatedAt,
        machine_id: this.project.aliases[0]?.machineId ?? null,
        path: this.project.aliases[0]?.path ?? null,
        normalized_path: this.project.aliases[0]?.normalizedPath ?? null,
        linked_at: this.project.aliases[0]?.linkedAt ?? null,
      }];
    return Promise.resolve(result(rows as R[]));
  }

  async transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions,
  ): Promise<T> {
    this.transactions.push(options);
    return callback({
      transactionScope: "active",
      query: this.query.bind(this),
      savepoint: async (savepointCallback) => savepointCallback({
        query: this.query.bind(this),
      }),
    });
  }

  close(): Promise<void> {
    this.closeAttempts += 1;
    return this.closeFailure === undefined
      ? Promise.resolve()
      : Promise.reject(this.closeFailure);
  }
}

function harness(): {
  runtime: FakeRuntime;
  dependencies: PostgreSqlFactoryDependencies;
  events: string[];
} {
  const runtime = new FakeRuntime();
  const events: string[] = [];
  const dependencies: PostgreSqlFactoryDependencies = {
    createRuntime: () => runtime,
    verifyRuntimeSchema: async (_executor, options) => {
      events.push(`readiness:${options.expectedOwner}`);
      return Object.freeze({
        currentMigrationIds: Object.freeze(["0001"]),
        expectedOwner: options.expectedOwner,
        runtimeRole: "lcm_runtime",
        managedObjectCount: 1,
        definitionObjectCount: 1,
        privilegeManifestVersion: 1,
      });
    },
    withConsumerLock: async (_homeDir, callback) => {
      events.push("lock");
      return callback({} as BackendPublicationLockToken);
    },
    assertPublication: (_selection, _token) => { events.push("assert"); },
    readJournal: () => journal,
    captureState: () => state,
    normalizePath: () => NORMALIZED_PATH,
  };
  return { runtime, dependencies, events };
}

describe("PostgreSQL storage backend factory", () => {
  it("binds the factory abort signal to identity transactions", async () => {
    const runtime = new FakeRuntime();
    const signal = new AbortController().signal;
    const executor = new FactorySignalExecutor(runtime, signal);

    await executor.transaction(async () => "ok", {
      domain: "identity",
      operation: "transaction-seam",
      projectId: PROJECT_ID,
    });

    expect(runtime.transactions).toEqual([{
      domain: "identity",
      operation: "transaction-seam",
      projectId: PROJECT_ID,
      signal,
    }]);
  });

  it("eagerly proves health and runtime readiness from a cloned config", async () => {
    const { runtime, dependencies, events } = harness();
    let captured: unknown;
    dependencies.createRuntime = (settings) => {
      captured = settings;
      return runtime;
    };

    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    expect(captured).toEqual({
      url: config.postgresql.url,
      caFile: config.postgresql.caFile,
      poolMax: config.postgresql.poolMax,
      connectionTimeoutMs: config.postgresql.connectionTimeoutMs,
      idleTimeoutMs: config.postgresql.idleTimeoutMs,
      statementTimeoutMs: config.postgresql.statementTimeoutMs,
    });
    expect(captured).not.toBe(config.postgresql);
    expect(events).toEqual(["readiness:lcm_migrator"]);
    expect(factory).toMatchObject({
      backend: "postgresql",
      capabilities: {
        transactions: true,
        lexicalSearch: true,
        regexSearch: true,
        nativeFullTextSearch: "available",
        coordination: "distributed",
      },
    });
    expect(Object.isFrozen(factory.capabilities)).toBe(true);
    expect(createPostgreSqlStorageBackendFactory.length).toBe(1);

    const storage = await factory.openProject(identity);
    expect(storage).toBeInstanceOf(PostgreSqlProjectStorage);
    await storage.close();
  });

  it("closes the pool on non-healthy or readiness initialization failures", async () => {
    for (const health of [
      { status: "degraded", backend: "postgresql" as const },
      { status: "unavailable", backend: "postgresql" as const },
    ]) {
      const { runtime, dependencies } = harness();
      runtime.healthResult = health;
      await expect(createPostgreSqlStorageBackendFactoryForTesting(
        config,
        "/home/operator",
        dependencies,
      )).rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
      expect(runtime.closeAttempts).toBe(1);
    }

    const { runtime, dependencies } = harness();
    dependencies.verifyRuntimeSchema = async () => { throw new Error("raw readiness canary"); };
    await expect(createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    )).rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
    expect(runtime.closeAttempts).toBe(1);

    const constructorFailure = harness();
    constructorFailure.dependencies.createRuntime = () => {
      throw new Error("constructor canary");
    };
    await expect(createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      constructorFailure.dependencies,
    )).rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
  });

  it("uses two short local admissions around remote identity work", async () => {
    const { dependencies, events } = harness();
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    expect(await factory.projectExists(identity)).toBe(true);
    expect(events).toEqual([
      "readiness:lcm_migrator",
      "lock", "assert",
      "lock", "assert",
    ]);
  });

  it("reuses a supplied live publication token before and after PostgreSQL I/O", async () => {
    const { dependencies, events } = harness();
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );
    const token = {} as BackendPublicationLockToken;

    const storage = await factory.openExistingProject(identity, token);

    expect(storage).not.toBeNull();
    expect(events).toEqual([
      "readiness:lcm_migrator",
      "assert", "assert",
    ]);
    await storage?.close();
  });

  it("returns null only for an authenticated absent remote project", async () => {
    const { runtime, dependencies } = harness();
    runtime.project = null;
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    await expect(factory.projectExists(identity)).resolves.toBe(false);
    await expect(factory.openExistingProject(identity)).resolves.toBeNull();
    await expect(factory.openProject(identity)).rejects.toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      operation: "openProject",
    });
  });

  it("fails safely for invalid identity or an inexact remote alias binding", async () => {
    const invalidIdentities: StorageIdentityContext[] = [
      { ...identity, selectedPath: undefined },
      { ...identity, id: PROJECT_ID.toUpperCase() },
      { ...identity, remoteProjectId: MACHINE_ID },
      { ...identity, machineId: MACHINE_ID.toUpperCase() },
      { ...identity, id: undefined } as unknown as StorageIdentityContext,
    ];
    for (const invalid of invalidIdentities) {
      const { dependencies } = harness();
      const factory = await createPostgreSqlStorageBackendFactoryForTesting(
        config,
        "/home/operator",
        dependencies,
      );
      await expect(factory.projectExists(invalid)).rejects.toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
      });
    }

    for (const project of [
      { ...remoteProject, projectId: MACHINE_ID },
      { ...remoteProject, aliases: [{ ...remoteProject.aliases[0]!, machineId: PROJECT_ID }] },
      { ...remoteProject, aliases: [{ ...remoteProject.aliases[0]!, path: "/other" }] },
      { ...remoteProject, aliases: [{ ...remoteProject.aliases[0]!, normalizedPath: "/other" }] },
      { ...remoteProject, aliases: [...remoteProject.aliases, remoteProject.aliases[0]!] },
    ]) {
      const { runtime, dependencies } = harness();
      runtime.project = project;
      runtime.query = async () => result(project.aliases.map((alias) => ({
        project_id: project.projectId,
        display_name: project.displayName,
        created_at: project.createdAt,
        updated_at: project.updatedAt,
        machine_id: alias.machineId,
        path: alias.path,
        normalized_path: alias.normalizedPath,
        linked_at: alias.linkedAt,
      })));
      const factory = await createPostgreSqlStorageBackendFactoryForTesting(
        config,
        "/home/operator",
        dependencies,
      );
      await expect(factory.projectExists(identity)).rejects.toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
      });
    }
  });

  it("rejects malformed remote alias values and contradictory alias shapes", async () => {
    const invalidAliases = [
      { ...remoteProject.aliases[0]!, machineId: "not-a-uuid" },
      { ...remoteProject.aliases[0]!, path: "relative" },
      { ...remoteProject.aliases[0]!, normalizedPath: "relative" },
      { ...remoteProject.aliases[0]!, path: "/same", normalizedPath: "/one" },
      { ...remoteProject.aliases[0]!, path: "/same", normalizedPath: "/two" },
      { ...remoteProject.aliases[0]!, path: "/one", normalizedPath: "/same" },
      { ...remoteProject.aliases[0]!, path: "/two", normalizedPath: "/same" },
    ];
    for (const aliases of [
      [invalidAliases[0]!],
      [invalidAliases[1]!],
      [invalidAliases[2]!],
      [invalidAliases[3]!, invalidAliases[4]!],
      [invalidAliases[5]!, invalidAliases[6]!],
    ]) {
      const { runtime, dependencies } = harness();
      runtime.query = async () => result(aliases.map((alias) => ({
        project_id: PROJECT_ID,
        display_name: "Project",
        created_at: remoteProject.createdAt,
        updated_at: remoteProject.updatedAt,
        machine_id: alias.machineId,
        path: alias.path,
        normalized_path: alias.normalizedPath,
        linked_at: alias.linkedAt,
      })));
      const factory = await createPostgreSqlStorageBackendFactoryForTesting(
        config,
        "/home/operator",
        dependencies,
      );
      await expect(factory.projectExists(identity)).rejects.toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
      });
    }
  });

  it("rejects journal or state drift before returning a facade", async () => {
    const { dependencies } = harness();
    let captureCount = 0;
    dependencies.captureState = () => {
      captureCount += 1;
      return captureCount === 1
        ? state
        : { ...state, config: { ...state.config, byteLength: 1 } } as BackendPublicationStateWitness;
    };
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    await expect(factory.openExistingProject(identity)).rejects.toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
    });
  });

  it("rejects missing or non-terminal PostgreSQL publication evidence", async () => {
    for (const publicationJournal of [
      null,
      { ...journal, phase: "aborted" },
      { ...journal, targetBackend: "sqlite" },
    ]) {
      const { dependencies } = harness();
      dependencies.readJournal = () => publicationJournal as BackendPublicationJournal | null;
      const factory = await createPostgreSqlStorageBackendFactoryForTesting(
        config,
        "/home/operator",
        dependencies,
      );
      await expect(factory.projectExists(identity)).rejects.toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
      });
    }
  });

  it("reports sanitized runtime health while open", async () => {
    const { runtime, dependencies } = harness();
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );
    runtime.healthResult = { status: "degraded", backend: "postgresql" };
    await expect(factory.health()).resolves.toEqual({
      status: "degraded",
      backend: "postgresql",
    });
    runtime.healthResult = { status: "unavailable", backend: "postgresql" };
    await expect(factory.health()).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "STORAGE_INITIALIZATION_FAILED" },
    });
    runtime.health = async () => { throw new Error("private health"); };
    await expect(factory.health()).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "STORAGE_INITIALIZATION_FAILED" },
    });
  });

  it("reports healthy state and exercises the identity transaction adapter", async () => {
    const { runtime, dependencies } = harness();
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );
    await expect(factory.health()).resolves.toEqual({
      status: "healthy",
      backend: "postgresql",
    });

    const storage = await factory.openProject(identity);
    await storage.transaction(async (repositories) => {
      await repositories.promotedMemory.deleteById("not-a-uuid");
    });
    expect(runtime.transactions).not.toHaveLength(0);
    await storage.close();
  });

  it("retries factory close when a test project facade close fails", async () => {
    const { runtime, dependencies } = harness();
    let projectCloseAttempts = 0;
    const project = {
      close: () => {
        projectCloseAttempts += 1;
        return projectCloseAttempts === 1
          ? Promise.reject(new Error("project close"))
          : Promise.resolve();
      },
    } as unknown as ProjectStorage;
    dependencies.createProjectStorage = () => project;
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );
    await factory.openProject(identity);

    await expect(factory.close()).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
    expect(runtime.closeAttempts).toBe(1);
    await factory.close();
    expect(projectCloseAttempts).toBe(2);
    expect(runtime.closeAttempts).toBe(2);
  });

  it("rejects use after close and exercises the one-argument public seam", async () => {
    const invalid = { backend: "sqlite" } as unknown as ResolvedPostgreSqlConfig;
    await expect(createPostgreSqlStorageBackendFactoryForTesting(
      invalid,
      "/home/operator",
      harness().dependencies,
    )).rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });

    const { dependencies } = harness();
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );
    await factory.close();
    await expect(factory.projectExists(identity)).rejects.toMatchObject({
      code: "STORAGE_CLOSED",
      operation: "projectExists",
    });
    await expect(factory.health()).resolves.toEqual({
      status: "closed",
      backend: "postgresql",
    });

    await expect(createPostgreSqlStorageBackendFactory(config)).rejects.toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
    });
  });

  it("waits for pending opens, closes projects, and retries runtime close", async () => {
    const { runtime, dependencies } = harness();
    let releaseIdentity!: () => void;
    const gate = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    const originalQuery = runtime.query.bind(runtime);
    runtime.query = async (...args) => {
      await gate;
      return originalQuery(...args);
    };
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );
    const opening = factory.openProject(identity);
    const health = factory.health();
    const close = factory.close();
    releaseIdentity();
    await expect(opening).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
    await expect(health).resolves.toMatchObject({ status: "closed" });
    await close;
    expect(runtime.closeAttempts).toBe(1);
    await factory.close();
    expect(runtime.closeAttempts).toBe(1);

    const retryHarness = harness();
    const retryFactory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      retryHarness.dependencies,
    );
    retryHarness.runtime.closeFailure = new Error("private close");
    await expect(retryFactory.close()).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      operation: "close",
    });
    retryHarness.runtime.closeFailure = undefined;
    await retryFactory.close();
    expect(retryHarness.runtime.closeAttempts).toBe(2);
  });

  it("keeps serialized errors free of configuration and driver canaries", async () => {
    const { runtime, dependencies } = harness();
    runtime.query = async () => { throw new Error("SELECT password canary-password /private/canary-ca.pem"); };
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    const error = await factory.openProject(identity).catch((caught: unknown) => caught);
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("canary-password");
    expect(serialized).not.toContain("canary-ca.pem");
    expect(serialized).not.toContain("SELECT");
  });
});
