import { describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import {
  applyReplicatedPassiveEvent,
  createPassiveEventReplicationPass,
  buildReplicationModules,
  loadReplicationModules,
  type PassiveEventReplicationImports,
  type PassiveEventReplicationModules,
} from "../../src/daemon/passive-event-replication-pass.js";

type Modules = PassiveEventReplicationModules;

function sqliteConfig() {
  return loadDaemonConfig("/nonexistent", { daemon: { port: 0 }, llm: { provider: "disabled" } });
}

function postgresConfig() {
  const config = sqliteConfig();
  return {
    ...config,
    storage: {
      backend: "postgresql",
      postgresql: { url: "postgresql://example.test/lcm" },
    },
  } as unknown as ReturnType<typeof sqliteConfig>;
}

function modules(overrides: Partial<Modules> = {}): { modules: Modules; runtime: { health: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }; factory: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } } {
  const runtime = {
    health: vi.fn().mockResolvedValue({ status: "healthy" }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const factory = {
    open: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    runtime,
    factory,
    modules: {
      ensureWorktreeProjectReconciled: vi.fn(),
      resolveProjectIdentity: vi.fn().mockReturnValue({ remoteProjectId: "project-uuid" }),
      requireMachineIdentity: vi.fn().mockReturnValue({ machineId: "machine-uuid" }),
      eventsDbPath: vi.fn().mockReturnValue("/events/project.db"),
      createRuntime: vi.fn().mockReturnValue(runtime),
      createOutboxFactory: vi.fn().mockReturnValue(factory),
      createRepository: vi.fn().mockReturnValue({}),
      ...overrides,
    } as unknown as Modules,
  };
}

const summary = {
  leaseAcquired: true,
  uploaded: 3,
  applied: 2,
  retried: 1,
  quarantined: 0,
  acknowledged: 2,
  pruned: 1,
};

describe("passive-event replication pass", () => {
  it("documents the applied transition as the terminal remote outcome", async () => {
    // #1398 tracks whether a real remote-side effect was ever intended.
    await expect(applyReplicatedPassiveEvent()).resolves.toBeUndefined();
  });

  it("binds imported namespaces to the seams the pass calls", () => {
    const PostgreSqlRuntime = vi.fn();
    const SQLiteLocalHookOutboxFactory = vi.fn();
    const PostgreSqlPassiveEventRepository = vi.fn();
    const imported = {
      projectMap: { resolveProjectIdentity: vi.fn() },
      reconciliation: { ensureWorktreeProjectReconciled: vi.fn() },
      identity: { requireMachineIdentity: vi.fn() },
      paths: { eventsDbPath: vi.fn() },
      runtime: { PostgreSqlRuntime },
      outbox: { SQLiteLocalHookOutboxFactory },
      repository: { PostgreSqlPassiveEventRepository },
    } as unknown as PassiveEventReplicationImports;

    const bound = buildReplicationModules(imported);
    expect(bound.resolveProjectIdentity).toBe(imported.projectMap.resolveProjectIdentity);
    expect(bound.ensureWorktreeProjectReconciled)
      .toBe(imported.reconciliation.ensureWorktreeProjectReconciled);
    expect(bound.requireMachineIdentity).toBe(imported.identity.requireMachineIdentity);
    expect(bound.eventsDbPath).toBe(imported.paths.eventsDbPath);

    const settings = { url: "postgresql://example.test/lcm" } as never;
    expect(bound.createRuntime(settings)).toBeInstanceOf(PostgreSqlRuntime);
    expect(PostgreSqlRuntime).toHaveBeenCalledWith(settings);
    expect(bound.createOutboxFactory()).toBeInstanceOf(SQLiteLocalHookOutboxFactory);

    const executor = {} as never;
    expect(bound.createRepository(executor, "project-uuid", "machine-uuid"))
      .toBeInstanceOf(PostgreSqlPassiveEventRepository);
    expect(PostgreSqlPassiveEventRepository)
      .toHaveBeenCalledWith(executor, "project-uuid", "machine-uuid");
  });

  it("loads the real PostgreSQL namespaces on demand", async () => {
    // Only a replicating daemon ever reaches this import.
    const loaded = await loadReplicationModules();
    expect(typeof loaded.resolveProjectIdentity).toBe("function");
    expect(typeof loaded.ensureWorktreeProjectReconciled).toBe("function");
    expect(typeof loaded.requireMachineIdentity).toBe("function");
    expect(typeof loaded.eventsDbPath).toBe("function");
    expect(typeof loaded.createRuntime).toBe("function");
    expect(typeof loaded.createRepository).toBe("function");
    const factory = loaded.createOutboxFactory();
    try {
      expect(factory).toBeDefined();
    } finally {
      await factory.close();
    }
  });

  it("skips a SQLite daemon without loading any PostgreSQL module", async () => {
    const loadModules = vi.fn();
    const pass = createPassiveEventReplicationPass(sqliteConfig(), {
      processId: "lcm-daemon:test",
      loadModules,
    });
    await expect(pass.run("/proj")).resolves.toBeNull();
    expect(loadModules).not.toHaveBeenCalled();
    await expect(pass.close()).resolves.toBeUndefined();
  });

  it("reports a module load failure and skips", async () => {
    const failure = new Error("module load failed");
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: vi.fn().mockRejectedValue(failure),
      onError,
    });
    await expect(pass.run("/proj")).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("falls back to the hook error log when no reporter is supplied", async () => {
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: vi.fn().mockRejectedValue(new Error("module load failed")),
    });
    // The default reporter must contain its own failures like the injected one.
    await expect(pass.run("/proj")).resolves.toBeNull();
  });

  it("reports a missing machine identity and skips before resolving the project", async () => {
    const failure = new Error("machine identity is not registered");
    const harness = modules({
      requireMachineIdentity: vi.fn(() => { throw failure; }),
    });
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj")).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(harness.modules.ensureWorktreeProjectReconciled).not.toHaveBeenCalled();
    expect(harness.modules.createRuntime).not.toHaveBeenCalled();
  });

  it("skips an unbound project quietly without opening a connection", async () => {
    const harness = modules({
      resolveProjectIdentity: vi.fn().mockReturnValue({ remoteProjectId: null }),
    });
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj")).resolves.toBeNull();
    // Reconciliation runs first so a linked worktree resolves canonically.
    expect(harness.modules.ensureWorktreeProjectReconciled).toHaveBeenCalledWith("/proj");
    expect(harness.modules.createRuntime).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("treats an absent remote project id as unbound", async () => {
    const harness = modules({ resolveProjectIdentity: vi.fn().mockReturnValue({}) });
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
    });
    await expect(pass.run("/proj")).resolves.toBeNull();
    expect(harness.modules.createRuntime).not.toHaveBeenCalled();
  });

  it("refuses to claim a lease against unhealthy storage", async () => {
    const failure = new Error("connection refused");
    const harness = modules();
    harness.runtime.health.mockResolvedValue({ status: "unavailable", error: failure });
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj")).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(harness.factory.open).not.toHaveBeenCalled();
  });

  it("reports unhealthy storage that offers no error", async () => {
    const harness = modules();
    harness.runtime.health.mockResolvedValue({ status: "unavailable" });
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj")).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "PostgreSQL passive-event storage is unavailable",
    }));
  });

  it("drains a bound project and reuses its runtime across passes", async () => {
    const harness = modules();
    const runOnce = vi.fn().mockResolvedValue(summary);
    const createWorker = vi.fn().mockReturnValue({ runOnce });
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:instance",
      loadModules: async () => harness.modules,
      createWorker,
    });
    const signal = new AbortController().signal;

    await expect(pass.run("/proj", signal)).resolves.toEqual(summary);
    await expect(pass.run("/proj", signal)).resolves.toEqual(summary);

    // One connection and one outbox factory serve every pass.
    expect(harness.modules.createRuntime).toHaveBeenCalledTimes(1);
    expect(harness.modules.createOutboxFactory).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledWith(signal);
    expect(createWorker).toHaveBeenCalledWith(
      expect.objectContaining({ applyEvent: applyReplicatedPassiveEvent }),
      "lcm-daemon:instance",
    );
    expect(harness.modules.createRepository).toHaveBeenCalledWith(
      harness.runtime,
      "project-uuid",
      "machine-uuid",
    );

    await pass.close();
    expect(harness.runtime.close).toHaveBeenCalledTimes(1);
    expect(harness.factory.close).toHaveBeenCalledTimes(1);
  });

  it("builds a real worker when no factory is injected", async () => {
    const local = {};
    const remote = { acquireDrainLease: vi.fn().mockResolvedValue(null) };
    const harness = modules({ createRepository: vi.fn().mockReturnValue(remote) });
    harness.factory.open.mockResolvedValue(local);
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:real",
      loadModules: async () => harness.modules,
    });

    // No lease is available, so the shipped worker returns an empty summary.
    await expect(pass.run("/proj")).resolves.toMatchObject({
      leaseAcquired: false,
      uploaded: 0,
      pruned: 0,
    });
    expect(remote.acquireDrainLease).toHaveBeenCalledWith("lcm-daemon:real", 30_000, undefined);
  });

  it("reports a drain failure and skips the project", async () => {
    const failure = new Error("outbox is locked");
    const harness = modules();
    harness.factory.open.mockRejectedValue(failure);
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj")).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("never lets a failing diagnostic displace replication work", async () => {
    const harness = modules({ resolveProjectIdentity: vi.fn(() => { throw new Error("boom"); }) });
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError: () => { throw new Error("diagnostic failed"); },
    });
    await expect(pass.run("/proj")).resolves.toBeNull();
  });

  it("closes without a session and reports a failing close", async () => {
    const idle = createPassiveEventReplicationPass(postgresConfig(), { processId: "lcm-daemon:test" });
    await expect(idle.close()).resolves.toBeUndefined();

    const failure = new Error("close failed");
    const harness = modules();
    harness.runtime.close.mockRejectedValue(failure);
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
      createWorker: () => ({ runOnce: vi.fn().mockResolvedValue(summary) }),
    });
    await pass.run("/proj");
    await expect(pass.close()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);

    // A closed pass reopens cleanly rather than reusing a dead connection.
    await pass.run("/proj");
    expect(harness.modules.createRuntime).toHaveBeenCalledTimes(2);
  });
});
