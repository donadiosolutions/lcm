import { describe, expect, it, vi } from "vitest";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import type { ResolvedPostgreSqlConfig } from "../../src/daemon/config.js";
import type {
  BackendPublicationJournal,
  BackendPublicationLockToken,
  BackendPublicationStateWitness,
} from "../../src/storage/backend-publication.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import type { ProjectStorage } from "../../src/storage/contracts.js";
import { StorageOperationError } from "../../src/storage/errors.js";
import {
  createPostgreSqlStorageBackendFactoryForTesting,
  createPostgreSqlStorageBackendFactoryWithHome,
  FactorySignalExecutor,
  type PostgreSqlFactoryDependencies,
} from "../../src/storage/postgresql/factory.js";
import { createPostgreSqlStorageBackendFactory } from "../../src/storage/postgresql.js";
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
  queryGate: Promise<void> | undefined;
  observedSignals: AbortSignal[] = [];

  health(): Promise<PostgreSqlRuntimeHealth> {
    return Promise.resolve(this.healthResult);
  }

  async query<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    _config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    this.observedSignals.push(options.signal);
    await this.queryGate;
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

  it("reports only optional diagnostic pool telemetry from its borrowed runtime", async () => {
    const { runtime, dependencies } = harness();
    const factory = await createPostgreSqlStorageBackendFactoryWithHome(config, "/home/operator", dependencies);
    expect(factory.getDiagnosticPool()).toBeUndefined();
    const pool = { configuredMax: 5, total: 2, idle: 1, waiting: 0, failed: false };
    Object.assign(runtime, { poolDiagnostics: () => pool });
    expect(factory.getDiagnosticPool()).toEqual(pool);
    await factory.close();
  });

  it("eagerly proves health and runtime readiness from a cloned config", async () => {
    const { runtime, dependencies, events } = harness();
    let captured: unknown;
    dependencies.createRuntime = (settings) => {
      captured = settings;
      return runtime;
    };

    const factory = await createPostgreSqlStorageBackendFactoryWithHome(
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
    expect(createPostgreSqlStorageBackendFactoryForTesting)
      .toBe(createPostgreSqlStorageBackendFactoryWithHome);
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

  it("accepts portable absolute aliases owned by foreign machines", async () => {
    const foreignMachineId = "0195d250-0000-7000-8000-000000000003";
    const aliases = [
      remoteProject.aliases[0]!,
      {
        ...remoteProject.aliases[0]!,
        machineId: foreignMachineId,
        path: "C:\\work\\repo",
        normalizedPath: "C:\\work\\repo",
      },
      {
        ...remoteProject.aliases[0]!,
        machineId: foreignMachineId,
        path: "\\\\server\\share\\repo",
        normalizedPath: "\\\\server\\share\\repo",
      },
    ];
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

    await expect(factory.projectExists(identity)).resolves.toBe(true);
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

  it("classifies caller cancellation after pending identity I/O and permits a later reopen", async () => {
    const { runtime, dependencies } = harness();
    let release!: () => void;
    runtime.queryGate = new Promise<void>(resolve => { release = resolve; });
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(config, "/home/operator", dependencies);
    const controller = new AbortController();
    const pending = factory.openExistingProject(identity, undefined, controller.signal);
    await vi.waitFor(() => expect(runtime.observedSignals).toHaveLength(1));
    controller.abort("disconnect");
    expect(runtime.observedSignals[0]?.aborted).toBe(true);
    expect(runtime.observedSignals[0]).not.toBe(controller.signal);
    release();
    await expect(pending).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED", operation: "openExistingProject" });
    expect(runtime.observedSignals[0]).toBeDefined();
    expect(runtime.observedSignals[0]).not.toBe(controller.signal);
    runtime.queryGate = undefined;
    await expect(factory.openExistingProject(identity)).resolves.not.toBeNull();
    await factory.close();
  });

  it("gives factory shutdown precedence over caller cancellation for a pending open", async () => {
    for (const abortCallerFirst of [true, false]) {
      const { runtime, dependencies } = harness();
      let release!: () => void;
      runtime.queryGate = new Promise<void>(resolve => { release = resolve; });
      const factory = await createPostgreSqlStorageBackendFactoryForTesting(config, "/home/operator", dependencies);
      const controller = new AbortController();
      const pending = factory.openExistingProject(identity, undefined, controller.signal);
      if (abortCallerFirst) controller.abort();
      const closing = factory.close();
      if (!abortCallerFirst) controller.abort();
      release();
      await expect(pending).rejects.toMatchObject({ code: "STORAGE_CLOSED", operation: "openExistingProject" });
      await expect(closing).resolves.toBeUndefined();
    }
  });

  it("closes a facade once when cancellation arrives after remote identity resolution", async () => {
    const { runtime, dependencies } = harness();
    const controller = new AbortController();
    let closeCalls = 0;
    const project = { close: async () => { closeCalls += 1; } } as unknown as ProjectStorage;
    let factory!: Awaited<ReturnType<typeof createPostgreSqlStorageBackendFactoryForTesting>>;
    dependencies.createProjectStorage = () => {
      controller.abort();
      return project;
    };
    factory = await createPostgreSqlStorageBackendFactoryForTesting(config, "/home/operator", dependencies);
    await expect(factory.openExistingProject(identity, undefined, controller.signal))
      .rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED", operation: "openExistingProject" });
    expect(closeCalls).toBe(1);
    await factory.close();
  });

  it("rejects a pre-entry caller abort without touching publication or facade state", async () => {
    const { dependencies, events } = harness();
    const controller = new AbortController();
    controller.abort("private pre-entry canary");
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const createProjectStorage = vi.fn(() => ({ close: vi.fn() } as unknown as ProjectStorage));
    dependencies.createProjectStorage = createProjectStorage;
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    const error = await factory.openProject(identity, undefined, controller.signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      backend: "postgresql",
      projectId: undefined,
      domain: "factory",
      operation: "openProject",
    });
    expect(JSON.stringify(error)).not.toContain("private pre-entry canary");
    expect(events).toEqual(["readiness:lcm_migrator"]);
    expect(createProjectStorage).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();
    expect(removeListener).not.toHaveBeenCalled();
    await expect(factory.close()).resolves.toBeUndefined();
    addListener.mockRestore();
    removeListener.mockRestore();
  });

  it("fences caller cancellation after the initial publication witness", async () => {
    const { dependencies, events } = harness();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let captureCalls = 0;
    dependencies.captureState = () => {
      captureCalls += 1;
      controller.abort("private initial-witness canary");
      return state;
    };
    const createProjectStorage = vi.fn(() => ({ close: vi.fn() } as unknown as ProjectStorage));
    dependencies.createProjectStorage = createProjectStorage;
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    const error = await factory.openProject(identity, undefined, controller.signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      backend: "postgresql",
      projectId: undefined,
      domain: "factory",
      operation: "openProject",
    });
    expect(JSON.stringify(error)).not.toContain("private initial-witness canary");
    expect(captureCalls).toBe(1);
    expect(events).toEqual(["readiness:lcm_migrator", "lock", "assert"]);
    expect(createProjectStorage).not.toHaveBeenCalled();
    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
    await expect(factory.close()).resolves.toBeUndefined();
    addListener.mockRestore();
    removeListener.mockRestore();
  });

  it("fences caller cancellation after the second publication witness", async () => {
    const { runtime, dependencies, events } = harness();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let captureCalls = 0;
    dependencies.captureState = () => {
      captureCalls += 1;
      if (captureCalls === 2) controller.abort("private second-witness canary");
      return state;
    };
    const createProjectStorage = vi.fn(() => ({ close: vi.fn() } as unknown as ProjectStorage));
    dependencies.createProjectStorage = createProjectStorage;
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    const error = await factory.openProject(identity, undefined, controller.signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      backend: "postgresql",
      projectId: undefined,
      domain: "factory",
      operation: "openProject",
    });
    expect(JSON.stringify(error)).not.toContain("private second-witness canary");
    expect(captureCalls).toBe(2);
    expect(runtime.observedSignals).toHaveLength(1);
    expect(events).toEqual([
      "readiness:lcm_migrator",
      "lock", "assert",
      "lock", "assert",
    ]);
    expect(createProjectStorage).not.toHaveBeenCalled();
    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
    await expect(factory.close()).resolves.toBeUndefined();
    addListener.mockRestore();
    removeListener.mockRestore();
  });

  it("fences caller cancellation at the final token publication return", async () => {
    const { runtime, dependencies, events } = harness();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let publicationAssertions = 0;
    dependencies.assertPublication = () => {
      publicationAssertions += 1;
      events.push("assert");
      if (publicationAssertions === 2) controller.abort("private final-token canary");
    };
    const createProjectStorage = vi.fn(() => ({ close: vi.fn() } as unknown as ProjectStorage));
    dependencies.createProjectStorage = createProjectStorage;
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    const error = await factory.openProject(
      identity,
      {} as BackendPublicationLockToken,
      controller.signal,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      backend: "postgresql",
      projectId: undefined,
      domain: "factory",
      operation: "openProject",
    });
    expect(JSON.stringify(error)).not.toContain("private final-token canary");
    expect(publicationAssertions).toBe(2);
    expect(runtime.observedSignals).toHaveLength(1);
    expect(events).toEqual(["readiness:lcm_migrator", "assert", "assert"]);
    expect(createProjectStorage).not.toHaveBeenCalled();
    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
    await expect(factory.close()).resolves.toBeUndefined();
    addListener.mockRestore();
    removeListener.mockRestore();
  });

  it("rebuilds a cause-free closed publication failure with current identity", async () => {
    const { runtime, dependencies, events } = harness();
    dependencies.assertPublication = (_selection, _token) => {
      events.push("assert");
      throw new StorageOperationError(
        "STORAGE_CLOSED",
        "postgresql",
        "injected-project",
        "publication",
        "injected-operation",
      );
    };
    const createProjectStorage = vi.fn(() => ({ close: vi.fn() } as unknown as ProjectStorage));
    dependencies.createProjectStorage = createProjectStorage;
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    const error = await factory.openProject(identity).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "STORAGE_CLOSED",
      backend: "postgresql",
      projectId: PROJECT_ID,
      domain: "factory",
      operation: "openProject",
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("injected-project");
    expect(serialized).not.toContain("injected-operation");
    expect(serialized).not.toContain("publication");
    expect(events).toEqual(["readiness:lcm_migrator", "lock", "assert"]);
    expect(runtime.observedSignals).toHaveLength(0);
    expect(createProjectStorage).not.toHaveBeenCalled();
    await expect(factory.close()).resolves.toBeUndefined();
    expect(runtime.closeAttempts).toBe(1);
  });

  it("fences caller cancellation between the run and facade phases", async () => {
    const { runtime, dependencies, events } = harness();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let publicationAssertions = 0;
    let getterArmed = false;
    let getterQueued = false;
    let abortObserved = false;
    const signal = new Proxy(controller.signal, {
      get(target, property, receiver) {
        if (property === "aborted") {
          if (getterArmed && !getterQueued) {
            getterQueued = true;
            queueMicrotask(() => {
              controller.abort("private post-run abort canary");
              abortObserved = controller.signal.aborted;
            });
          }
          return target.aborted;
        }
        if (property === "addEventListener" || property === "removeEventListener") {
          const method = Reflect.get(target, property, target) as (...args: never[]) => unknown;
          return method.bind(target);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as AbortSignal;
    dependencies.assertPublication = (_selection, _token) => {
      publicationAssertions += 1;
      events.push("assert");
      if (publicationAssertions === 2) getterArmed = true;
    };
    const createProjectStorage = vi.fn(() => ({ close: vi.fn() } as unknown as ProjectStorage));
    dependencies.createProjectStorage = createProjectStorage;
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );
    const token = {} as BackendPublicationLockToken;

    const error = await factory.openProject(identity, token, signal)
      .catch((caught: unknown) => caught);

    expect(getterArmed).toBe(true);
    expect(getterQueued).toBe(true);
    expect(abortObserved).toBe(true);
    expect(publicationAssertions).toBe(2);
    expect(events).toEqual(["readiness:lcm_migrator", "assert", "assert"]);
    expect(runtime.observedSignals).toHaveLength(1);
    expect(createProjectStorage).not.toHaveBeenCalled();
    expect(error).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      backend: "postgresql",
      projectId: undefined,
      domain: "factory",
      operation: "openProject",
    });
    expect(JSON.stringify(error)).not.toContain("post-run abort canary");
    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();

    getterArmed = false;
    const secondController = new AbortController();
    const storage = await factory.openProject(identity, token, secondController.signal);
    expect(storage).not.toBeNull();
    await storage?.close();
    await expect(factory.close()).resolves.toBeUndefined();
    addListener.mockRestore();
    removeListener.mockRestore();
  });

  it("sanitizes a generic post-facade publication failure and closes the facade once", async () => {
    const { runtime, dependencies } = harness();
    let facadeConstructed = false;
    let fenceFailureInjected = false;
    let abortedReads = 0;
    const controller = new AbortController();
    const signal = new Proxy(controller.signal, {
      get(target, property, receiver) {
        if (property === "aborted") {
          abortedReads += 1;
          if (facadeConstructed && !fenceFailureInjected) {
            fenceFailureInjected = true;
            throw new Error("private post-facade fence canary");
          }
          return false;
        }
        if (property === "addEventListener" || property === "removeEventListener") {
          const method = Reflect.get(target, property, target) as (...args: never[]) => unknown;
          return method.bind(target);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as AbortSignal;
    const close = vi.fn(async () => undefined);
    const project = { close } as unknown as ProjectStorage;
    dependencies.createProjectStorage = () => {
      facadeConstructed = true;
      return project;
    };
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    const error = await factory.openProject(identity, undefined, signal)
      .catch((caught: unknown) => caught);

    expect(facadeConstructed).toBe(true);
    expect(fenceFailureInjected).toBe(true);
    expect(abortedReads).toBeGreaterThanOrEqual(2);
    expect(close).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      backend: "postgresql",
      projectId: PROJECT_ID,
      operation: "openProject",
    });
    expect(JSON.stringify(error)).not.toContain("private post-facade fence canary");
    expect(error).not.toMatchObject({ code: "STORAGE_CLOSED" });
    await expect(factory.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
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

  it("reports closed when health settles after factory shutdown begins", async () => {
    const outcomes: Array<{
      name: string;
      settle: (resolve: (value: PostgreSqlRuntimeHealth) => void,
        reject: (reason: unknown) => void) => void;
    }> = [
      {
        name: "healthy",
        settle: (resolve) => resolve(healthy),
      },
      {
        name: "unavailable",
        settle: (resolve) => resolve({ status: "unavailable", backend: "postgresql" }),
      },
      {
        name: "rejected",
        settle: (_resolve, reject) => reject(new Error("private health detail")),
      },
    ];

    for (const outcome of outcomes) {
      const { runtime, dependencies, events } = harness();
      const factory = await createPostgreSqlStorageBackendFactoryForTesting(
        config,
        "/home/operator",
        dependencies,
      );
      events.length = 0;
      let settleHealth!: (value: PostgreSqlRuntimeHealth) => void;
      let rejectHealth!: (reason: unknown) => void;
      const healthProbe = new Promise<PostgreSqlRuntimeHealth>((resolve, reject) => {
        settleHealth = resolve;
        rejectHealth = reject;
      });
      let probeStarted!: () => void;
      const probeEntered = new Promise<void>((resolve) => {
        probeStarted = resolve;
      });
      let runtimeHealthCalls = 0;
      runtime.health = () => {
        runtimeHealthCalls += 1;
        events.push("health-start");
        probeStarted();
        return healthProbe;
      };
      runtime.close = async () => {
        runtime.closeAttempts += 1;
        events.push("runtime-close");
      };

      const health = factory.health();
      await probeEntered;
      await factory.close();
      events.push("close-complete");
      outcome.settle(settleHealth, rejectHealth);
      const result = await health;
      events.push("health-complete");

      expect(result).toEqual({ status: "closed", backend: "postgresql" });
      expect(runtimeHealthCalls).toBe(1);
      expect(runtime.closeAttempts).toBe(1);
      expect(events).toEqual([
        "health-start",
        "runtime-close",
        "close-complete",
        "health-complete",
      ]);
      expect(outcome.name).toMatch(/healthy|unavailable|rejected/u);
    }
  });

  it("waits only for the pending-operation snapshot present when health starts", async () => {
    const { runtime, dependencies } = harness();
    let releaseFirstOpen!: () => void;
    let releaseLaterOpen!: () => void;
    const firstOpenGate = new Promise<void>((resolve) => {
      releaseFirstOpen = resolve;
    });
    const laterOpenGate = new Promise<void>((resolve) => {
      releaseLaterOpen = resolve;
    });
    const originalQuery = runtime.query.bind(runtime);
    let queryCount = 0;
    runtime.query = async (...args) => {
      queryCount += 1;
      await (queryCount === 1 ? firstOpenGate : laterOpenGate);
      return originalQuery(...args);
    };
    const factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );
    const originalHealth = runtime.health.bind(runtime);
    let runtimeHealthCalls = 0;
    runtime.healthResult = { status: "unavailable", backend: "postgresql" };
    runtime.health = () => {
      runtimeHealthCalls += 1;
      return originalHealth();
    };

    const firstOpening = factory.openProject(identity);
    const health = factory.health();
    const laterOpening = factory.openProject(identity);
    const healthCallsBeforeFirstOpenSettled = runtimeHealthCalls;
    releaseFirstOpen();
    const firstStorage = await firstOpening;
    await Promise.resolve();
    const healthCallsBeforeLaterOpenSettled = runtimeHealthCalls;
    releaseLaterOpen();
    const laterStorage = await laterOpening;
    const healthResult = await health;
    await firstStorage.close();
    await laterStorage.close();
    await factory.close();

    expect({
      healthCallsBeforeFirstOpenSettled,
      healthCallsBeforeLaterOpenSettled,
      healthResult,
      queryCount,
      runtimeHealthCalls,
    }).toEqual({
      healthCallsBeforeFirstOpenSettled: 0,
      healthCallsBeforeLaterOpenSettled: 1,
      healthResult: {
        status: "unavailable",
        backend: "postgresql",
        error: expect.objectContaining({ code: "STORAGE_INITIALIZATION_FAILED" }),
      },
      queryCount: 2,
      runtimeHealthCalls: 1,
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

  it("closes a facade exactly once when shutdown reenters facade construction", async () => {
    const { runtime, dependencies } = harness();
    let factory!: Awaited<ReturnType<typeof createPostgreSqlStorageBackendFactoryForTesting>>;
    let factoryClose!: Promise<void>;
    let projectCloseAttempts = 0;
    const project = {
      close: () => {
        projectCloseAttempts += 1;
        return Promise.resolve();
      },
    } as unknown as ProjectStorage;
    dependencies.createProjectStorage = () => {
      factoryClose = factory.close();
      return project;
    };
    factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    await expect(factory.openProject(identity)).rejects.toMatchObject({
      code: "STORAGE_CLOSED",
      operation: "openProject",
    });
    await expect(factoryClose).resolves.toBeUndefined();
    expect(projectCloseAttempts).toBe(1);
    expect(runtime.closeAttempts).toBe(1);
  });

  it("preserves the primary closed error when unregistered facade cleanup rejects", async () => {
    const { runtime, dependencies } = harness();
    let factory!: Awaited<ReturnType<typeof createPostgreSqlStorageBackendFactoryForTesting>>;
    let factoryClose!: Promise<void>;
    const project = {
      close: () => Promise.reject(new Error("private facade close detail")),
    } as unknown as ProjectStorage;
    dependencies.createProjectStorage = () => {
      factoryClose = factory.close();
      return project;
    };
    factory = await createPostgreSqlStorageBackendFactoryForTesting(
      config,
      "/home/operator",
      dependencies,
    );

    const error = await factory.openProject(identity).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "STORAGE_CLOSED", operation: "openProject" });
    expect(JSON.stringify(error)).not.toContain("private facade close detail");
    await expect(factoryClose).resolves.toBeUndefined();
    expect(runtime.closeAttempts).toBe(1);
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
