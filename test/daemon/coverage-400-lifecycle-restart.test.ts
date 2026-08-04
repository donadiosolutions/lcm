import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureDaemon as ensureDaemonProduction,
  restartDaemon as restartDaemonProduction,
} from "../../src/daemon/lifecycle.js";
import {
  createDaemonLifecycleTestScope,
  type DaemonLifecycleHermeticTestSeams,
  type DaemonLifecycleTestScope,
} from "../../src/daemon/lifecycle-scope.js";

type EnsureDaemonOptions = Parameters<typeof ensureDaemonProduction>[0];
type RestartDaemonOptions = Parameters<typeof restartDaemonProduction>[0];
type FetchOverride = NonNullable<EnsureDaemonOptions["_fetchOverride"]>;
type SpawnOverride = NonNullable<EnsureDaemonOptions["_spawnOverride"]>;
type SpawnSyncOverride = NonNullable<EnsureDaemonOptions["_spawnSyncOverride"]>;
type Supervisor = NonNullable<EnsureDaemonOptions["_supervisorOverride"]>;
type SupervisorSpec = Parameters<Supervisor["probe"]>[0];

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(prefix = "lcm-coverage-restart-"): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function writePid(rootPath: string, pid: number): string {
  const path = join(rootPath, "daemon.pid");
  writeFileSync(path, String(pid), { mode: 0o600 });
  return path;
}

function writeProc(rootPath: string, pid: number, parentPid = 1, command = "node lcm daemon start --foreground"): void {
  const dir = join(rootPath, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status"), `Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t${parentPid}\n`);
  writeFileSync(join(dir, "cmdline"), command.replaceAll(" ", "\0"));
}

function hermetic(options: EnsureDaemonOptions): EnsureDaemonOptions {
  const stateDir = dirname(options.pidFilePath);
  const seams: DaemonLifecycleHermeticTestSeams = {
    homeDir: stateDir,
    runtimeDir: join(stateDir, ".runtime"),
    stateDir,
    credentialDir: join(stateDir, ".credentials"),
    procRoot: options._procRoot === "/proc" ? join(stateDir, ".proc") : options._procRoot ?? join(stateDir, ".proc"),
    platform: options._platform ?? "linux",
    uid: options._uid ?? 1000,
    environment: {},
    fetch: options._fetchOverride ?? (vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride),
    spawn: options._spawnOverride ?? (vi.fn(() => ({ pid: undefined, once: vi.fn().mockReturnThis(), unref: vi.fn() })) as unknown as SpawnOverride),
    spawnSync: options._spawnSyncOverride ?? (vi.fn(() => ({ status: 1, stdout: "", stderr: "offline" })) as unknown as SpawnSyncOverride),
    stopUnit: vi.fn(),
    killProcess: options._killOverride ?? vi.fn(),
    isProcessAlive: options._isProcessAliveOverride ?? (() => false),
    sleep: options._sleepOverride ?? (async () => undefined),
    realpath: options._realpathOverride ?? (path => path),
  };
  for (const directory of [seams.homeDir, seams.runtimeDir, seams.credentialDir, seams.procRoot]) mkdirSync(directory, { recursive: true });
  return { ...options, _hermeticTestSeams: seams };
}

function ensure(options: EnsureDaemonOptions): ReturnType<typeof ensureDaemonProduction> {
  return ensureDaemonProduction(hermetic(options));
}

function restart(options: RestartDaemonOptions): ReturnType<typeof restartDaemonProduction> {
  return restartDaemonProduction(hermetic(options));
}

function baseOptions(rootPath: string): EnsureDaemonOptions {
  return {
    port: 19_999,
    pidFilePath: join(rootPath, "daemon.pid"),
    spawnTimeoutMs: 100,
    expectedVersion: "1.0.0",
    expectedEntrypoint: "/lcm",
    _platform: "linux",
    _monotonicNowOverride: () => 0,
    _sleepOverride: async () => undefined,
    _skipSpawn: true,
  };
}

function health(pid: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "ok", version: "1.0.0", pid, storageBackend: "sqlite", entrypoint: "/lcm", ...extra };
}

function diagnosticsFetch(...bodies: readonly unknown[]): FetchOverride {
  let index = 0;
  return vi.fn(async (url: string): Promise<Response> => {
    if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
    const body = bodies[Math.min(index++, bodies.length - 1)];
    return response(body ?? health(20));
  }) as unknown as FetchOverride;
}

function unavailableSupervisor(reason: string = "manager-unavailable"): Supervisor {
  return {
    probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "unavailable" as const, reason, name: spec.name })),
    start: vi.fn(),
    stopAndStart: vi.fn(),
    stopAndAwaitAbsent: vi.fn(),
  } as unknown as Supervisor;
}

function managedSupervisor(
  observation: (spec: SupervisorSpec, call: number) => Record<string, unknown>,
  startResult: Record<string, unknown> = { kind: "systemd-user", managerPid: 200 },
): { supervisor: Supervisor; probe: ReturnType<typeof vi.fn>; stopAndStart: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> } {
  let call = 0;
  const probe = vi.fn(async (spec: SupervisorSpec) => observation(spec, ++call));
  const start = vi.fn(async () => startResult);
  const stopAndStart = vi.fn(async () => startResult);
  return {
    supervisor: { probe, start, stopAndStart, stopAndAwaitAbsent: vi.fn() } as unknown as Supervisor,
    probe,
    stopAndStart,
    start,
  };
}

function testScopeFixture(prefix = "scope-"): { root: string; scope: DaemonLifecycleTestScope } {
  const dir = root(`lcm-coverage-restart-${prefix}`);
  const homeDir = join(dir, "home");
  const runtimeDir = join(homeDir, "runtime");
  const stateDir = join(homeDir, ".lcm");
  const credentialDir = join(homeDir, "credentials");
  const entrypoint = join(runtimeDir, "daemon.mjs");
  for (const path of [homeDir, runtimeDir, stateDir, credentialDir]) mkdirSync(path, { recursive: true });
  writeFileSync(entrypoint, "setTimeout(() => {}, 60_000);\n");
  const dependencies = {
    fetch: vi.fn().mockRejectedValue(new Error("offline")),
    spawn: vi.fn(() => ({
      pid: undefined,
      once: vi.fn().mockReturnThis(),
      unref: vi.fn(),
    })),
    spawnSync: vi.fn(),
    stopUnit: vi.fn(),
    killProcess: vi.fn(),
    isProcessAlive: vi.fn(() => false),
    sleep: vi.fn(async () => undefined),
  };
  return {
    root: dir,
    scope: createDaemonLifecycleTestScope({
      ownerId: "coverage-restart",
      homeDir,
      runtimeDir,
      stateDir,
      credentialDir,
      entrypoint,
      dependencies,
    }),
  };
}

describe("ensureDaemon restart and terminal coverage", () => {
  it("revalidates and terminates an authenticated daemon with a wrong Linux parent", async () => {
    const dir = root();
    const procRoot = join(dir, "proc");
    mkdirSync(procRoot, { recursive: true });
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    writeProc(procRoot, 10, 1, "systemd --user");
    writeProc(procRoot, 20, 11);
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const fetch = diagnosticsFetch(health(20), health(20));
    const result = await ensure({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _procRoot: procRoot,
      _uid: 1000,
      _isProcessAliveOverride: () => alive,
      _killOverride: kill,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(kill).toHaveBeenCalledWith(20, "SIGTERM");
    expect(result.connected).toBe(false);
  });

  it("blocks an unauthenticated retry with a storage mismatch", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    let healthCalls = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/stats/pool")) return response({ error: "denied" }, 401);
      healthCalls += 1;
      if (healthCalls === 1) return response({ status: "warming", version: "1.0.0", pid: 999 });
      if (init?.headers) return response({ error: "denied" }, 401);
      return response(health(20, { storageBackend: "postgresql" }));
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(result.warning).toContain("storage-backend mismatch");
  });

  it("accepts a recognized retry endpoint after an initial PID collision", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    const fetch = diagnosticsFetch({ status: "warming", version: "1.0.0", pid: 999 }, health(20), health(20));
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result).toMatchObject({ connected: true, spawned: false, pid: 20, startMethod: "existing" });
  });

  it("preserves a busy Darwin PID after bounded health failure", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    const ps = vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground\n", stderr: "" }));
    const result = await ensure({
      ...baseOptions(dir),
      _platform: "darwin",
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _spawnSyncOverride: ps as unknown as SpawnSyncOverride,
      _fetchOverride: vi.fn(async (url: string) => url.endsWith("/health")
      ? response({ status: "warming", version: "1.0.0", pid: 999 })
        : response({ error: "no" }, 503)) as unknown as FetchOverride,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result).toMatchObject({ connected: false, spawned: false, pid: 20 });
    expect(result.warning).toContain("still owns configured port");
  });

  it("returns an ambiguous refusal when PID liveness cannot be rechecked", async () => {
    const dir = root();
    writePid(dir, 20);
    const alive = vi.fn()
      .mockReturnValueOnce(false)
      .mockImplementation(() => { throw new Error("liveness unavailable"); });
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: alive,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result).toMatchObject({ connected: false, refusalReason: "ambiguous", pid: 20 });
    expect(existsSync(join(dir, "daemon.pid"))).toBe(true);
  });

  it("returns a concurrent-replacement result when the PID file changes", async () => {
    const dir = root();
    writePid(dir, 20);
    const alive = vi.fn(() => false);
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        writePid(dir, 21);
        return response(health(999));
      }
      return response({});
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: alive,
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result.connected).toBe(false);
  });

  it("waits for a replacement PID after authenticated mismatch repair", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    let nowCalls = 0;
    let alive = true;
    let killed = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
      if (init?.headers) return response(health(20));
      if (killed) return response(health(21));
      if (url.endsWith("/health")) return response(killed ? health(21) : health(20));
      return response({});
    }) as unknown as FetchOverride;
    const kill = vi.fn(() => {
      killed = true;
      alive = false;
      writePid(dir, 21);
    });
    const result = await ensure({
      ...baseOptions(dir),
      expectedVersion: "2.0.0",
      _platform: "darwin",
      _isProcessAliveOverride: (pid) => pid === 20 ? alive : true,
      _killOverride: kill,
      _listeningPortsOverride: () => [19_999],
      _spawnSyncOverride: vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground\n", stderr: "" })) as unknown as SpawnSyncOverride,
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
      _monotonicNowOverride: () => nowCalls++ < 8 ? 0 : 200,
    });
    expect(kill).toHaveBeenCalledWith(20, "SIGTERM");
    expect(result.connected).toBe(false);
  });

  it("waits for a replacement PID from the retry mismatch path", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    let healthCalls = 0;
    let alive = true;
    const fetch = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
      healthCalls += 1;
      if (healthCalls === 1) return response({ status: "warming" });
      return response(health(20));
    }) as unknown as FetchOverride;
    const kill = vi.fn(() => {
      alive = false;
      writePid(dir, 21);
    });
    const result = await ensure({
      ...baseOptions(dir),
      expectedVersion: "2.0.0",
      _platform: "darwin",
      _isProcessAliveOverride: (pid) => pid === 20 && alive,
      _killOverride: kill,
      _listeningPortsOverride: () => [19_999],
      _spawnSyncOverride: vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground\n", stderr: "" })) as unknown as SpawnSyncOverride,
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(kill).toHaveBeenCalledWith(20, "SIGTERM");
    expect(result.connected).toBe(false);
  });

  it("waits on a PID replacement after an invalid retry response", async () => {
    const dir = root();
    writePid(dir, 20);
    let changed = false;
    const fetch = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        if (!changed) {
          changed = true;
          writePid(dir, 21);
          return response({ status: "warming" });
        }
        return response({}, 503);
      }
      return response({});
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: (pid) => pid === 20,
      _listeningPortsOverride: () => [],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result.connected).toBe(false);
  });

  it("waits on a PID replacement observed after the retry response", async () => {
    const dir = root();
    writePid(dir, 20);
    let calls = 0;
    const fetch = vi.fn(async (url: string): Promise<Response> => {
      if (!url.endsWith("/health")) return response({});
      calls += 1;
      if (calls === 1) return response({ status: "warming" });
      writePid(dir, 21);
      return response({}, 503);
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: (pid) => pid === 20,
      _listeningPortsOverride: () => [],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result.connected).toBe(false);
  });

  it("waits for a PID replacement discovered after stale-state inspection", async () => {
    const dir = root();
    writePid(dir, 20);
    let aliveCalls = 0;
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: (pid) => {
        aliveCalls += 1;
        if (aliveCalls === 1) writePid(dir, 21);
        return false && pid === 20;
      },
      _fetchOverride: vi.fn().mockResolvedValue(response({ status: "warming" })) as unknown as FetchOverride,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result.connected).toBe(false);
  });

  it("rethrows an observable scoped-state error from the retry cleanup fence", async () => {
    const dir = root();
    const pidPath = writePid(dir, 20);
    const external = join(root(), "external.pid");
    writeFileSync(external, "20");
    let firstAliveCheck = true;
    const result = ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: () => {
        if (firstAliveCheck) {
          firstAliveCheck = false;
          unlinkSync(pidPath);
          symlinkSync(external, pidPath);
        }
        return true;
      },
      _fetchOverride: vi.fn().mockResolvedValue(response({ status: "warming" })) as unknown as FetchOverride,
    });
    await expect(result).rejects.toThrow("PID state is not a canonical owned file");
  });

  it("cleans a scoped PID when its retry health cannot be authenticated", async () => {
    const fixture = testScopeFixture("retry-auth-");
    const pidPath = writePid(fixture.scope.stateDir, 20);
    let healthCalls = 0;
    const fetch = fixture.scope.dependencies.fetch as unknown as ReturnType<typeof vi.fn>;
    const alive = fixture.scope.dependencies.isProcessAlive as unknown as ReturnType<typeof vi.fn>;
    const sleep = fixture.scope.dependencies.sleep as unknown as ReturnType<typeof vi.fn>;
    fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
      healthCalls += 1;
      return healthCalls === 1 ? response({ status: "warming" }) : response(health(20));
    });
    alive.mockReturnValue(true);
    sleep.mockResolvedValue(undefined);
    const result = await ensureDaemonProduction({
      port: 19_999,
      pidFilePath: pidPath,
      spawnTimeoutMs: 100,
      _platform: "linux",
      _testScope: fixture.scope,
      _listeningPortsOverride: () => [19_999],
      _monotonicNowOverride: () => 0,
      _skipSpawn: true,
    });
    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(result.warning).toContain("runtime-identity mismatch");
    expect(existsSync(pidPath)).toBe(false);
  });

  it("signals a parent-owned PID after an invalid retry health response", async () => {
    const dir = root();
    const procRoot = join(dir, "proc");
    mkdirSync(procRoot, { recursive: true });
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    writeProc(procRoot, 10, 1, "systemd --user");
    writeProc(procRoot, 20, 10);
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    let healthCalls = 0;
    const fetch = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        healthCalls += 1;
        return healthCalls === 1 ? response({ status: "warming" }) : response({}, 503);
      }
      return response({});
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _procRoot: procRoot,
      _uid: 1000,
      _isProcessAliveOverride: () => alive,
      _killOverride: kill,
      _listeningPortsOverride: () => [],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(kill).toHaveBeenCalledWith(20, "SIGTERM");
    expect(result.connected).toBe(false);
  });

  it("cleans detached spawn state when an abort races the no-health result", async () => {
    const dir = root();
    const controller = new AbortController();
    const child = { pid: 321, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    const spawn = vi.fn(() => {
      queueMicrotask(() => controller.abort());
      return child;
    }) as unknown as SpawnOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _skipSpawn: false,
      _abortSignal: controller.signal,
      _spawnOverride: spawn,
      _fetchOverride: vi.fn(() => new Promise<Response>(() => undefined)) as unknown as FetchOverride,
    });
    expect(result).toMatchObject({ connected: false, spawned: true, warning: "daemon lifecycle was interrupted" });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("refuses detached fallback after a manager operation became unavailable", async () => {
    const dir = root();
    const result = await ensure({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _suppressDetachedFallback: true,
      _supervisorOverride: unavailableSupervisor("manager-unavailable"),
    });
    expect(result).toMatchObject({ connected: false, refusalReason: "manager-unavailable" });
  });

  it("accepts a detached spawn health response after writing its PID", async () => {
    const dir = root();
    const child = { pid: 321, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    const fetch = diagnosticsFetch(
      health(321, { runtimeDigest: "a".repeat(64) }),
      health(321, { runtimeDigest: "a".repeat(64) }),
    );
    const result = await ensure({
      ...baseOptions(dir),
      _skipSpawn: false,
      expectedRuntimeDigest: "a".repeat(64),
      _spawnOverride: vi.fn(() => child) as unknown as SpawnOverride,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
    });
    expect(result).toMatchObject({ connected: true, spawned: true, startMethod: "detached-spawn", pid: 321 });
  });

  it("cleans every owned test-scope resource after a detached test start", async () => {
    const fixture = testScopeFixture("detached-cleanup-");
    const pidPath = join(fixture.scope.stateDir, "daemon.pid");
    const child = { pid: 321, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    let alive = true;
    const spawn = fixture.scope.dependencies.spawn as unknown as ReturnType<typeof vi.fn>;
    const kill = fixture.scope.dependencies.killProcess as unknown as ReturnType<typeof vi.fn>;
    const isAlive = fixture.scope.dependencies.isProcessAlive as unknown as ReturnType<typeof vi.fn>;
    spawn.mockReturnValue(child);
    kill.mockImplementation(() => { alive = false; });
    isAlive.mockImplementation(() => alive);
    const result = await ensureDaemonProduction({
      port: 19_999,
      pidFilePath: pidPath,
      spawnTimeoutMs: 100,
      _platform: "linux",
      _testScope: fixture.scope,
      _skipHealthWait: true,
    });
    expect(result).toMatchObject({ connected: false, spawned: true });
    expect(kill).toHaveBeenCalledWith(321, "SIGTERM");
    expect(existsSync(fixture.scope.runtimeDir)).toBe(false);
    expect(existsSync(fixture.scope.credentialDir)).toBe(false);
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
  });

  it("runs abort cleanup when a scope is interrupted immediately after spawn", async () => {
    const fixture = testScopeFixture("abort-after-spawn-");
    const pidPath = join(fixture.scope.stateDir, "daemon.pid");
    const child = { pid: 322, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    const spawn = fixture.scope.dependencies.spawn as unknown as ReturnType<typeof vi.fn>;
    spawn.mockReturnValue(child);
    let reads = 0;
    const signal = {
      get aborted(): boolean {
        reads += 1;
        return reads >= 4;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const result = await ensureDaemonProduction({
      port: 19_999,
      pidFilePath: pidPath,
      spawnTimeoutMs: 100,
      _platform: "linux",
      _testScope: fixture.scope,
      _abortSignal: signal,
      _skipHealthWait: true,
    });
    expect(result.warning).toBe("daemon lifecycle was interrupted");
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("settles and reports an abort cleanup rejection through the catch fence", async () => {
    const fixture = testScopeFixture("abort-cleanup-error-");
    const pidPath = join(fixture.scope.stateDir, "daemon.pid");
    const child = { pid: 323, once: vi.fn(), unref: vi.fn() };
    child.once.mockImplementation(() => {
      rmSync(fixture.scope.runtimeDir, { recursive: true, force: true });
      mkdirSync(fixture.scope.runtimeDir, { recursive: true });
      return child;
    });
    const spawn = fixture.scope.dependencies.spawn as unknown as ReturnType<typeof vi.fn>;
    spawn.mockReturnValue(child);
    let reads = 0;
    const signal = {
      get aborted(): boolean {
        reads += 1;
        return reads >= 4;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    await expect(ensureDaemonProduction({
      port: 19_999,
      pidFilePath: pidPath,
      spawnTimeoutMs: 100,
      _platform: "linux",
      _testScope: fixture.scope,
      _abortSignal: signal,
      _skipHealthWait: true,
    })).rejects.toThrow("state paths changed");
  });

  it("observes an abort between stale PID handling and detached spawn", async () => {
    const dir = root();
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      throw new Error("offline");
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _skipSpawn: false,
      _abortSignal: controller.signal,
      _fetchOverride: fetch,
    });
    expect(result.warning).toContain("interrupted before startup");
  });

  it("rejects a Vitest worker spawn entrypoint before registration", async () => {
    const dir = root();
    const originalArg = process.argv[1];
    process.argv[1] = "/tmp/lcm-cli.mjs";
    try {
      const result = await ensureDaemonProduction({
        port: 19_999,
        pidFilePath: join(dir, "daemon.pid"),
        spawnTimeoutMs: 100,
        _platform: "linux",
        _packagedEntrypointOverride: "/lcm",
        spawnArgs: ["/tmp/node_modules/vitest/dist/workers/run.js"],
        _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride,
        _monotonicNowOverride: () => 0,
      });
      expect(result.warning).toContain("refusing to register a Vitest worker");
    } finally {
      process.argv[1] = originalArg;
    }
  });

  it("creates the production token before an unscoped detached spawn", async () => {
    const dir = root();
    const child = { pid: 654, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    const originalArg = process.argv[1];
    process.argv[1] = "/tmp/lcm-cli.mjs";
    try {
      const result = await ensureDaemonProduction({
        port: 19_999,
        pidFilePath: join(dir, "daemon.pid"),
        spawnTimeoutMs: 100,
        _platform: "linux",
        _packagedEntrypointOverride: "/lcm",
        _skipHealthWait: true,
        _spawnOverride: vi.fn(() => child) as unknown as SpawnOverride,
        _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride,
        _monotonicNowOverride: () => 0,
      });
      expect(result).toMatchObject({ spawned: true, startMethod: "detached-spawn" });
      expect(existsSync(join(dir, "daemon.token"))).toBe(true);
    } finally {
      process.argv[1] = originalArg;
    }
  });
});

describe("managed restart refusal and repair coverage", () => {
  it.each([
    ["relative executable", { spawnCommand: "lcm" }],
    ["non-string argument", { spawnArgs: ["/tmp/lcm", 42] as unknown as string[] }],
  ])("refuses %s before manager probing", async (_name, extra) => {
    const dir = root();
    const probe = vi.fn();
    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      ...extra,
      _supervisorOverride: { probe, start: vi.fn(), stopAndStart: vi.fn(), stopAndAwaitAbsent: vi.fn() } as unknown as Supervisor,
    });
    expect(result).toMatchObject({ restarted: false, refusalReason: "ambiguous" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses a non-canonical manager state root", async () => {
    const dir = root();
    const probe = vi.fn();
    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _realpathOverride: () => { throw new Error("realpath unavailable"); },
      _supervisorOverride: { probe, start: vi.fn(), stopAndStart: vi.fn(), stopAndAwaitAbsent: vi.fn() } as unknown as Supervisor,
    });
    expect(result.refusalReason).toBe("ambiguous");
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses an invalid manager specification before probing", async () => {
    const dir = root();
    const probe = vi.fn();
    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      expectedRuntimeDigest: "not-a-digest",
      _supervisorOverride: { probe, start: vi.fn(), stopAndStart: vi.fn(), stopAndAwaitAbsent: vi.fn() } as unknown as Supervisor,
    });
    expect(result.refusalReason).toBe("ambiguous");
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    ["linux", "manager-unavailable"],
    ["linux", "manager-not-found"],
    ["darwin", "manager-unavailable"],
    ["darwin", "manager-not-found"],
  ] as const)("falls through %s restart when the selected manager preflight is %s", async (platform, reason) => {
    const dir = root(`issue-515-${platform}-${reason}-`);
    const pidPath = writePid(dir, 4242);
    const tokenPath = join(dir, "daemon.token");
    writeFileSync(tokenPath, "local-token", { mode: 0o600 });
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const ensureMock = vi.fn(async () => ({ connected: false, port: 19_999, spawned: false }));
    const supervisor = {
      probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "unavailable" as const, reason, name: spec.name })),
      start: vi.fn(),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(),
    } as unknown as Supervisor;

    const result = await restart({
      ...baseOptions(dir),
      _platform: platform,
      enforceUserManagerParent: true,
      _isProcessAliveOverride: () => alive,
      _isManagedProcessOverride: () => true,
      _killOverride: kill,
      _ensureDaemonOverride: ensureMock,
      _supervisorOverride: supervisor,
    });

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      restarted: true,
      stoppedPid: 4242,
    });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.stopAndStart).not.toHaveBeenCalled();
    expect(supervisor.stopAndAwaitAbsent).not.toHaveBeenCalled();
    expect(existsSync(pidPath)).toBe(false);
    expect(readFileSync(tokenPath, "utf8")).toBe("local-token");
  });

  it("uses the detached path only after authenticated legacy identity proof", async () => {
    const dir = root("issue-400-authenticated-detached-");
    const procRoot = join(dir, "proc");
    const pidPath = writePid(dir, 4242);
    writeFileSync(join(dir, "daemon.token"), "local-token", { mode: 0o600 });
    writeProc(procRoot, 4242);
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const ensureMock = vi.fn(async () => ({
      connected: false,
      port: 19_999,
      spawned: true,
      startMethod: "detached-spawn" as const,
    }));
    const supervisor = unavailableSupervisor("manager-unavailable");

    const result = await restart({
      ...baseOptions(dir),
      _procRoot: procRoot,
      enforceUserManagerParent: true,
      _isProcessAliveOverride: () => alive,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: diagnosticsFetch(health(4242), health(4242)),
      _killOverride: kill,
      _ensureDaemonOverride: ensureMock,
      _supervisorOverride: supervisor,
    });

    expect(result).toMatchObject({ restarted: true, stoppedPid: 4242, spawned: true, startMethod: "detached-spawn" });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(existsSync(pidPath)).toBe(false);
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.stopAndStart).not.toHaveBeenCalled();
  });

  it.each([
    ["no response", vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride],
    ["unverified PID", diagnosticsFetch(health(999), health(999))],
  ])("refuses detached fallback for %s before signaling", async (_case, fetch) => {
    const dir = root("issue-400-detached-refusal-");
    const pidPath = writePid(dir, 4242);
    writeFileSync(join(dir, "daemon.token"), "local-token", { mode: 0o600 });
    const kill = vi.fn();
    const ensureMock = vi.fn();
    const supervisor = unavailableSupervisor("manager-unavailable");

    await expect(restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _killOverride: kill,
      _ensureDaemonOverride: ensureMock,
      _supervisorOverride: supervisor,
    })).rejects.toThrow("not a verified LCM daemon");
    expect(kill).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
    expect(existsSync(pidPath)).toBe(true);
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.stopAndStart).not.toHaveBeenCalled();
  });

  it("refuses a selected-manager ambiguous preflight before legacy recovery", async () => {
    const dir = root("issue-515-ambiguous-");
    const pidPath = writePid(dir, 4242);
    const kill = vi.fn();
    const ensureMock = vi.fn();
    const supervisor = {
      probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "ambiguous" as const, reason: "state-conflict" as const, name: spec.name })),
      start: vi.fn(),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(),
    } as unknown as Supervisor;

    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _isProcessAliveOverride: () => true,
      _isManagedProcessOverride: () => true,
      _killOverride: kill,
      _ensureDaemonOverride: ensureMock,
      _supervisorOverride: supervisor,
    });

    expect(result).toMatchObject({ connected: false, spawned: false, restarted: false, refusalReason: "ambiguous" });
    expect(kill).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.stopAndStart).not.toHaveBeenCalled();
    expect(supervisor.stopAndAwaitAbsent).not.toHaveBeenCalled();
    expect(readFileSync(pidPath, "utf8")).toBe("4242");
  });

  it("retains legacy detached restart compatibility when no manager is selected", async () => {
    const dir = root("issue-515-detached-compatibility-");
    writePid(dir, 4242);
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const ensureMock = vi.fn(async () => ({ connected: false, port: 19_999, spawned: false }));

    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: false,
      _isProcessAliveOverride: () => alive,
      _isManagedProcessOverride: () => true,
      _killOverride: kill,
      _ensureDaemonOverride: ensureMock,
    });

    expect(result).toMatchObject({ restarted: true, stoppedPid: 4242 });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, "daemon.pid"))).toBe(false);
  });

  it("maps probe failures, collisions, ambiguous state, and unavailable manager reasons", async () => {
    const cases: readonly [string, Record<string, unknown>, string | undefined][] = [
      ["probe failure", { probe: vi.fn().mockRejectedValue(new Error("probe")) }, "ambiguous"],
      ["collision", { probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "registered-invalid-collision", reason: "foreign-job", name: spec.name })) }, "invalid-collision"],
      ["ambiguous", { probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "ambiguous", reason: "state-conflict", name: spec.name })) }, "ambiguous"],
      ["manager error", { probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "unavailable", reason: "metadata-mismatch", name: spec.name })) }, "manager-unavailable"],
    ];
    for (const [, supervisor, refusalReason] of cases) {
      const dir = root();
      const result = await restart({ ...baseOptions(dir), enforceUserManagerParent: true, _supervisorOverride: supervisor as unknown as Supervisor });
      expect(result.refusalReason).toBe(refusalReason);
    }
    const dir = root();
    const fallback = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _supervisorOverride: unavailableSupervisor("manager-unavailable"),
      _ensureDaemonOverride: vi.fn(async () => ({ connected: false, port: 19_999, spawned: false })),
    });
    expect(fallback.restarted).toBe(false);
  });

  it("repairs stale registrations and propagates the normal CLI packaged entrypoint", async () => {
    const dir = root();
    const stopAndStart = vi.fn(async () => ({ kind: "systemd-user", managerPid: 200 }));
    const managed = managedSupervisor((spec) => ({
      kind: "registered-stale-config",
      reason: "metadata-mismatch",
      scopeDigest: spec.scopeDigest,
      name: spec.name,
    }), { kind: "systemd-user", managerPid: 200 });
    managed.stopAndStart.mockImplementation(stopAndStart);
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19_999, spawned: false }));
    const result = await restart({ ...baseOptions(dir), expectedEntrypoint: undefined, _packagedEntrypointOverride: "/packaged-lcm", enforceUserManagerParent: true, _supervisorOverride: managed.supervisor, _ensureDaemonOverride: ensureMock });
    expect(result).toMatchObject({ restarted: true, connected: true });
    expect(stopAndStart).toHaveBeenCalledOnce();
    expect(managed.probe).toHaveBeenCalledWith(expect.objectContaining({ entrypoint: "/packaged-lcm" }));
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ expectedEntrypoint: "/packaged-lcm" }));

    const mismatch = managedSupervisor((spec) => ({ kind: "registered-stale-config", reason: "metadata-mismatch", scopeDigest: "foreign", name: spec.name }));
    const refused = await restart({ ...baseOptions(root()), enforceUserManagerParent: true, _supervisorOverride: mismatch.supervisor });
    expect(refused.refusalReason).toBe("invalid-collision");

    const failed = managedSupervisor((spec) => ({ kind: "registered-stale-config", reason: "metadata-mismatch", scopeDigest: spec.scopeDigest, name: spec.name }));
    failed.stopAndStart.mockRejectedValue(new Error("stop/start"));
    const failure = await restart({ ...baseOptions(root()), enforceUserManagerParent: true, _supervisorOverride: failed.supervisor });
    expect(failure.refusalReason).toBe("startup-failure");
  });

  it("handles absent and terminal manager jobs with exact PID proof", async () => {
    for (const kind of ["absent", "registered-not-running-valid"] as const) {
      const dir = root();
      const managed = managedSupervisor((spec) => ({ kind, ...(kind === "registered-not-running-valid" ? { terminal: "inactive" } : {}), name: spec.name }));
      const skipped = await restart({ ...baseOptions(dir), enforceUserManagerParent: true, _skipSpawn: true, _supervisorOverride: managed.supervisor });
      expect(skipped.refusalReason).toBe(kind === "absent" ? "absent" : "not-running");
      expect(managed.start).not.toHaveBeenCalled();
    }
    const startDir = root();
    const startManaged = managedSupervisor((spec) => ({ kind: "absent", name: spec.name }), { kind: "systemd-user", managerPid: 201 });
    const ensured = vi.fn(async () => ({ connected: false, port: 19_999, spawned: true }));
    const started = await restart({ ...baseOptions(startDir), enforceUserManagerParent: true, _skipSpawn: false, _supervisorOverride: startManaged.supervisor, _ensureDaemonOverride: ensured });
    expect(started.restarted).toBe(true);
    expect(ensured).toHaveBeenCalledOnce();

    const changingDir = root();
    writePid(changingDir, 200);
    const changing = managedSupervisor((spec) => ({ kind: "absent", name: spec.name }));
    const changingResult = await restart({
      ...baseOptions(changingDir),
      enforceUserManagerParent: true,
      _supervisorOverride: changing.supervisor,
      _isProcessAliveOverride: () => {
        writePid(changingDir, 201);
        return false;
      },
    });
    expect(changingResult.refusalReason).toBe("not-running");

    const unsafeDir = root();
    const externalPid = join(root(), "external.pid");
    writeFileSync(externalPid, "200");
    symlinkSync(externalPid, join(unsafeDir, "daemon.pid"));
    const unsafe = managedSupervisor((spec) => ({ kind: "absent", name: spec.name }));
    const unsafeResult = await restart({ ...baseOptions(unsafeDir), enforceUserManagerParent: true, _supervisorOverride: unsafe.supervisor });
    expect(unsafeResult.warning).toContain("outside its state root");
    const dir = root();
    writePid(dir, 200);
    const live = managedSupervisor((spec) => ({ kind: "registered-not-running-valid", terminal: "failed", name: spec.name }));
    const refused = await restart({ ...baseOptions(dir), enforceUserManagerParent: true, _supervisorOverride: live.supervisor, _isProcessAliveOverride: () => true });
    expect(refused.refusalReason).toBe("not-running");
  });

  it("revalidates live manager endpoints for no-response and response branches", async () => {
    const make = (fetch: FetchOverride, extra: Record<string, unknown> = {}) => {
      const dir = root();
      writePid(dir, 200);
      writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
      const managed = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }));
      return restart({ ...baseOptions(dir), enforceUserManagerParent: true, _supervisorOverride: managed.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: fetch, ...extra });
    };
    const noResponse = await make(vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride);
    expect(noResponse.refusalReason).toBe("live-no-response");

    const noPidDir = root();
    const noPidSupervisor = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }));
    const noPid = await restart({ ...baseOptions(noPidDir), enforceUserManagerParent: true, _supervisorOverride: noPidSupervisor.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride });
    expect(noPid.refusalReason).toBe("live-no-response");

    const reprobe = managedSupervisor((spec, call) => call === 1
      ? { kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }
      : { kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name });
    reprobe.probe.mockImplementationOnce(async (spec: SupervisorSpec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name })).mockImplementationOnce(async () => { throw new Error("reprobe"); });
    const reprobeDir = root();
    writePid(reprobeDir, 200);
    const reprobeResult = await restart({ ...baseOptions(reprobeDir), enforceUserManagerParent: true, _supervisorOverride: reprobe.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride });
    expect(reprobeResult.refusalReason).toBe("live-no-response");

    const invalid = await make(vi.fn().mockResolvedValue(response({}, 500)) as unknown as FetchOverride);
    expect(invalid.refusalReason).toBe("response-invalid");
    const unknownBackend = await make(vi.fn().mockResolvedValue(response(health(200, { storageBackend: "oracle" }))) as unknown as FetchOverride);
    expect(unknownBackend.refusalReason).toBe("response-invalid");
    const authFailure = await make(vi.fn(async (url: string) => url.endsWith("/health")
      ? response(health(200))
      : response({ error: "unauthorized" }, 401)) as unknown as FetchOverride);
    expect(authFailure.refusalReason).toBe("response-auth-failure");

    const runtimeMismatch = await make(diagnosticsFetch(health(200, { runtimeDigest: "b".repeat(64) }), health(200, { runtimeDigest: "b".repeat(64) })), { expectedRuntimeDigest: "a".repeat(64) });
    expect(runtimeMismatch.refusalReason).toBe("response-invalid");
  });

  it("uses manager repair for responsive runtime mismatch and handles changed identity", async () => {
    const dir = root();
    writePid(dir, 200);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    const managed = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }), { kind: "systemd-user", managerPid: 201 });
    const fetch = diagnosticsFetch(
      health(200, { entrypoint: "/expected", runtimeDigest: "b".repeat(64) }),
      health(200, { entrypoint: "/expected", runtimeDigest: "b".repeat(64) }),
    );
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19_999, spawned: false }));
    const repaired = await restart({ ...baseOptions(dir), enforceUserManagerParent: true, expectedVersion: "2.0.0", expectedEntrypoint: "/expected", expectedRuntimeDigest: "b".repeat(64), spawnCommand: process.execPath, spawnArgs: ["/lcm", "daemon", "start", "--foreground"], _supervisorOverride: managed.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: fetch, _ensureDaemonOverride: ensureMock });
    expect(repaired.restarted).toBe(true);
    expect(managed.stopAndStart).toHaveBeenCalledOnce();

    const changed = managedSupervisor((spec, call) => call === 1
      ? { kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }
      : { kind: "ambiguous", reason: "state-conflict", name: spec.name });
    const changedDir = root();
    writePid(changedDir, 200);
    writeFileSync(join(changedDir, "daemon.token"), "token", { mode: 0o600 });
    const refused = await restart({ ...baseOptions(changedDir), enforceUserManagerParent: true, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: diagnosticsFetch(health(200), health(200)), _supervisorOverride: changed.supervisor });
    expect(refused.refusalReason).toBe("ambiguous");
  });

  it("covers manager health deadline, endpoint collision, and stop/start failure", async () => {
    const expiredDir = root();
    writePid(expiredDir, 200);
    const expired = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }));
    let monotonicCalls = 0;
    const timeout = await restart({ ...baseOptions(expiredDir), enforceUserManagerParent: true, _monotonicNowOverride: () => monotonicCalls++ === 0 ? 0 : 100, _supervisorOverride: expired.supervisor, _isProcessAliveOverride: () => true });
    expect(timeout.refusalReason).toBe("response-timeout");

    const collisionDir = root();
    writePid(collisionDir, 200);
    const collision = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }));
    const collisionResult = await restart({ ...baseOptions(collisionDir), enforceUserManagerParent: true, _supervisorOverride: collision.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [], _fetchOverride: diagnosticsFetch(health(999)) });
    expect(collisionResult.refusalReason).toBe("invalid-collision");

    const failedDir = root();
    writePid(failedDir, 200);
    const failed = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }));
    failed.stopAndStart.mockRejectedValue(new Error("manager stop"));
    const failure = await restart({ ...baseOptions(failedDir), enforceUserManagerParent: true, _supervisorOverride: failed.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride });
    expect(failure.refusalReason).toBe("startup-failure");
  });
});

describe("legacy restart and terminal cleanup coverage", () => {
  it("rejects conflicting and out-of-scope restart state", async () => {
    const fixture = testScopeFixture("conflict-");
    const conflictRoot = root();
    const conflictOptions = hermetic({ ...baseOptions(conflictRoot) });
    const conflict = await restartDaemonProduction({
      ...conflictOptions,
      _testScope: fixture.scope,
    });
    expect(conflict.warning).toContain("conflicts with hermetic");

    const outside = root();
    const outsideResult = await restartDaemonProduction({
      ...baseOptions(join(outside, "state")),
      _testScope: fixture.scope,
    });
    expect(outsideResult.warning).toContain("not exact canonical owned state");
  });

  it("refuses a scoped restart when its filesystem changes during validation", async () => {
    const fixture = testScopeFixture("validation-");
    const pidPath = join(fixture.scope.stateDir, "daemon.pid");
    const tokenPath = join(fixture.scope.stateDir, "daemon.token");
    const result = await restartDaemonProduction({
      port: 19_999,
      pidFilePath: pidPath,
      spawnTimeoutMs: 100,
      _testScope: fixture.scope,
      validateBeforeRestart: () => {
        renameSync(fixture.scope.stateDir, join(fixture.root, "state-before-validation"));
        mkdirSync(fixture.scope.stateDir);
      },
    });
    expect(result).toMatchObject({
      connected: false,
      port: 19_999,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle test state changed during restart validation",
    });
    expect(fixture.scope.dependencies.fetch).not.toHaveBeenCalled();
    expect(fixture.scope.dependencies.spawn).not.toHaveBeenCalled();
    expect(fixture.scope.dependencies.spawnSync).not.toHaveBeenCalled();
    expect(fixture.scope.dependencies.killProcess).not.toHaveBeenCalled();
    expect(tokenPath).toContain("daemon.token");
  });

  it("refuses a hermetic restart when state changes during validation", async () => {
    const dir = root();
    const result = await restart({
      ...baseOptions(dir),
      validateBeforeRestart: () => {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
      },
    });
    expect(result.warning).toContain("hermetic state changed during restart validation");
  });

  it("disables restart in an unscoped Vitest worker", async () => {
    const originalArg = process.argv[1];
    process.argv[1] = "/tmp/node_modules/vitest/dist/workers/run.js";
    try {
      const result = await restartDaemonProduction({
        port: 19_999,
        pidFilePath: join(root(), "daemon.pid"),
        spawnTimeoutMs: 100,
      });
      expect(result.warning).toContain("disabled for an unscoped Vitest worker");
    } finally {
      process.argv[1] = originalArg;
    }
  });

  it("returns a not-running refusal when the exact PID proof catches an unsafe replacement", async () => {
    const dir = root();
    const external = join(root(), "outside.pid");
    writeFileSync(external, "200");
    const supervisor = managedSupervisor((spec) => {
      symlinkSync(external, join(dir, "daemon.pid"));
      return { kind: "absent", name: spec.name };
    });
    const result = await restart({ ...baseOptions(dir), enforceUserManagerParent: true, _supervisorOverride: supervisor.supervisor });
    expect(result.refusalReason).toBe("not-running");
  });

  it("reports a legacy PID binding change before signaling", async () => {
    const dir = root();
    writePid(dir, 20);
    const ensureMock = vi.fn();
    const resultPromise = restart({
      ...baseOptions(dir),
      enforceUserManagerParent: false,
      _isManagedProcessOverride: () => {
        writePid(dir, 21);
        return true;
      },
      _isProcessAliveOverride: () => true,
      _ensureDaemonOverride: ensureMock,
    });
    await expect(resultPromise).rejects.toThrow("PID changed before restart signaling");
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("refuses a Darwin legacy PID whose ps identity changes before signaling", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    let psCalls = 0;
    const ps = vi.fn(() => ({
      status: 0,
      stdout: ++psCalls === 1 ? "node lcm daemon start --foreground\n" : "node unrelated\n",
      stderr: "",
    }));
    const fetch = diagnosticsFetch(health(20), health(20));
    const kill = vi.fn();
    await expect(restart({
      ...baseOptions(dir),
      enforceUserManagerParent: false,
      _platform: "darwin",
      _spawnSyncOverride: ps as unknown as SpawnSyncOverride,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _isProcessAliveOverride: () => true,
      _killOverride: kill,
    })).rejects.toThrow("identity changed before signaling");
    expect(kill).not.toHaveBeenCalled();
  });

  it("returns the interrupted result before signaling a verified legacy PID", async () => {
    const dir = root();
    writePid(dir, 20);
    const controller = new AbortController();
    const ensureMock = vi.fn(async () => ({ connected: false, port: 19_999, spawned: true }));
    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: false,
      _abortSignal: controller.signal,
      _isManagedProcessOverride: () => {
        controller.abort();
        return true;
      },
      _isProcessAliveOverride: () => true,
      _ensureDaemonOverride: ensureMock,
    });
    expect(result.restarted).toBe(false);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("revalidates Darwin ps identity immediately before signaling", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const ps = vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground\n", stderr: "" }));
    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: false,
      _platform: "darwin",
      _isProcessAliveOverride: () => alive,
      _spawnSyncOverride: ps as unknown as SpawnSyncOverride,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: diagnosticsFetch(health(20), health(20), health(20)),
      _killOverride: kill,
      _ensureDaemonOverride: vi.fn(async () => ({ connected: false, port: 19_999, spawned: true })),
      _sleepOverride: async () => undefined,
    });
    expect(result).toMatchObject({ restarted: true, stoppedPid: 20 });
    expect(kill).toHaveBeenCalledWith(20, "SIGTERM");
    expect(ps).toHaveBeenCalled();
  });

  it("rejects malformed restart seams and state mutation before validation", async () => {
    const dir = root();
    const malformedScope = await restart({ ...baseOptions(dir), _testScope: {} as never });
    expect(malformedScope.warning).toContain("test scope is incomplete");
    const malformedHermetic = await restartDaemonProduction({ ...baseOptions(root()), _hermeticTestSeams: {} as never });
    expect(malformedHermetic.warning).toContain("hermetic test seams are incomplete");
  });
});
