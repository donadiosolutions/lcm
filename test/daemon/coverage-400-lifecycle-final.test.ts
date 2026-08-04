import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __lifecycleTestUtils,
  ensureDaemon,
  restartDaemon,
  type EnsureDaemonOptions,
} from "../../src/daemon/lifecycle.js";
import type {
  DaemonLifecycleHermeticTestSeams,
  DaemonLifecycleTestDependencies,
  DaemonLifecycleTestScope,
} from "../../src/daemon/lifecycle-scope.js";
import { createDaemonLifecycleTestScope } from "../../src/daemon/lifecycle-scope.js";
import type { Supervisor, SupervisorObservation, SupervisorSpec } from "../../src/daemon/supervisor.js";
import { RUNTIME_DIGEST } from "../../src/daemon/version.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type ResponseLike = { ok?: boolean; status?: number; json: () => Promise<unknown> };
type Fixture = {
  root: string;
  stateDir: string;
  runtimeDir: string;
  credentialDir: string;
  procRoot: string;
  pidPath: string;
  tokenPath: string;
  port: number;
  seams: DaemonLifecycleHermeticTestSeams;
};

function root(prefix = "lcm-400-final-"): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function response(body: unknown, status = 200): ResponseLike {
  return { ok: status >= 200 && status <= 299, status, json: async () => body };
}

function health(pid: number, extra: Record<string, unknown> = {}): ResponseLike {
  return response({
    status: "ok",
    version: "1",
    storageBackend: "sqlite",
    runtimeDigest: RUNTIME_DIGEST,
    entrypoint: "/entrypoint.mjs",
    pid,
    ...extra,
  });
}

function fixture(options: {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  spawn?: typeof import("node:child_process").spawn;
  spawnSync?: typeof import("node:child_process").spawnSync;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  realpath?: (path: string) => string;
} = {}): Fixture {
  const dir = root();
  const stateDir = join(dir, "state");
  const runtimeDir = join(dir, "runtime");
  const credentialDir = join(dir, "credentials");
  const procRoot = join(dir, "proc");
  for (const path of [stateDir, runtimeDir, credentialDir, procRoot]) mkdirSync(path, { recursive: true });
  chmodSync(stateDir, 0o700);
  chmodSync(credentialDir, 0o700);
  const seams: DaemonLifecycleHermeticTestSeams = {
    homeDir: dir,
    runtimeDir,
    stateDir,
    credentialDir,
    procRoot,
    platform: options.platform ?? "linux",
    uid: 1000,
    environment: options.environment ?? {},
    fetch: options.fetch ?? (vi.fn(async () => response({}, 503)) as never),
    spawn: options.spawn ?? (vi.fn(() => ({ pid: undefined, once: vi.fn().mockReturnThis(), unref: vi.fn() })) as never),
    spawnSync: options.spawnSync ?? (vi.fn(() => ({ status: 1, stdout: "", stderr: "" })) as never),
    stopUnit: vi.fn(),
    killProcess: options.killProcess ?? vi.fn(),
    isProcessAlive: options.isAlive ?? (() => false),
    sleep: options.sleep ?? (async () => undefined),
    realpath: options.realpath ?? ((path: string) => path),
  };
  return {
    root: dir,
    stateDir,
    runtimeDir,
    credentialDir,
    procRoot,
    pidPath: join(stateDir, "daemon.pid"),
    tokenPath: join(stateDir, "daemon.token"),
    port: 43_201,
    seams,
  };
}

function baseOptions(f: Fixture, extra: Partial<EnsureDaemonOptions> = {}): EnsureDaemonOptions {
  return {
    port: f.port,
    pidFilePath: f.pidPath,
    spawnTimeoutMs: 100,
    expectedVersion: "1",
    expectedEntrypoint: "/entrypoint.mjs",
    expectedRuntimeDigest: RUNTIME_DIGEST,
    _hermeticTestSeams: f.seams,
    _skipSpawn: true,
    ...extra,
  };
}

function manager(
  observation: (spec: SupervisorSpec, call: number) => SupervisorObservation,
  startPid = 42,
  onStart: () => void = () => undefined,
): { supervisor: Supervisor; probe: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stopAndStart: ReturnType<typeof vi.fn> } {
  let calls = 0;
  const probe = vi.fn(async (spec: SupervisorSpec) => observation(spec, ++calls));
  const start = vi.fn(async (spec: SupervisorSpec) => {
    onStart();
    return {
      kind: spec.kind,
      name: spec.name,
      scopeDigest: spec.scopeDigest,
      port: spec.port,
      nonce: spec.nonce,
      managerPid: startPid,
    };
  });
  const stopAndStart = vi.fn(start);
  return {
    supervisor: { probe, start, stopAndStart, stopAndAwaitAbsent: vi.fn() },
    probe,
    start,
    stopAndStart,
  } as unknown as { supervisor: Supervisor; probe: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stopAndStart: ReturnType<typeof vi.fn> };
}

function managerObservation(
  spec: SupervisorSpec,
  kind: SupervisorObservation["kind"],
  extra: Record<string, unknown> = {},
): SupervisorObservation {
  return {
    kind,
    name: spec.name,
    scopeDigest: spec.scopeDigest,
    nonce: spec.nonce,
    ...extra,
  } as SupervisorObservation;
}

function healthFetch(values: readonly ResponseLike[]): typeof globalThis.fetch {
  let index = 0;
  return vi.fn(async (url: string) => {
    if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
    const value = values[Math.min(index++, values.length - 1)] ?? response({}, 503);
    return value as Response;
  }) as never;
}

function writeProcCommand(f: Fixture, pid: number, command = "node lcm daemon start --foreground"): void {
  const dir = join(f.procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cmdline"), command.replaceAll(" ", "\0"));
}

function writeProcStatus(f: Fixture, pid: number, parentPid: number): void {
  const dir = join(f.procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status"), `Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t${parentPid}\n`);
}

function writeLinuxListener(f: Fixture, pid: number, inode = "12345", port = f.port): void {
  const dir = join(f.procRoot, String(pid), "fd");
  mkdirSync(dir, { recursive: true });
  symlinkSync(`socket:[${inode}]`, join(dir, "0"));
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  mkdirSync(join(f.procRoot, "net"), { recursive: true });
  writeFileSync(join(f.procRoot, "net", "tcp"), `  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n  0: 0100007F:${portHex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000   100        0 ${inode} 1\n`);
  writeFileSync(join(f.procRoot, "net", "tcp6"), "header\n");
}

function scopedFixture(f: Fixture, ownerId = "final-scope"): { fixture: Fixture; scope: DaemonLifecycleTestScope } {
  const homeDir = join(f.root, "scope-home");
  const runtimeDir = join(homeDir, "runtime");
  const stateDir = join(homeDir, ".lcm");
  const credentialDir = join(homeDir, "credentials");
  const entrypoint = join(runtimeDir, "entrypoint.mjs");
  for (const path of [homeDir, runtimeDir, stateDir, credentialDir]) mkdirSync(path, { recursive: true });
  chmodSync(stateDir, 0o700);
  chmodSync(credentialDir, 0o700);
  writeFileSync(entrypoint, "setTimeout(() => {}, 60_000);\n");
  const dependencies: DaemonLifecycleTestDependencies = {
    fetch: f.seams.fetch,
    spawn: f.seams.spawn,
    spawnSync: f.seams.spawnSync,
    stopUnit: f.seams.stopUnit,
    killProcess: f.seams.killProcess,
    isProcessAlive: f.seams.isProcessAlive,
    sleep: f.seams.sleep,
  };
  const scope = createDaemonLifecycleTestScope({
    ownerId,
    homeDir,
    runtimeDir,
    stateDir,
    credentialDir,
    entrypoint,
    dependencies,
  });
  return {
    fixture: {
      ...f,
      stateDir,
      runtimeDir,
      credentialDir,
      pidPath: join(stateDir, "daemon.pid"),
      tokenPath: join(stateDir, "daemon.token"),
    },
    scope,
  };
}

describe("Epic 400 lifecycle final branch closure", () => {
  it("covers explicit manager command environments, empty tokens, and non-socket proc entries", async () => {
    const f = fixture({
      environment: { PATH: "/bin", XDG_RUNTIME_DIR: fTempDir() },
    });
    const run = __lifecycleTestUtils.supervisorCommandRunner(f.seams as never, baseOptions(f));
    const spawnSync = f.seams.spawnSync as ReturnType<typeof vi.fn>;
    run("manager", [], { timeoutMs: 10, env: { PATH: "/custom" } });
    expect(spawnSync).toHaveBeenCalledWith("manager", [], expect.objectContaining({ env: { PATH: "/custom" } }));

    const empty = fixture();
    writeFileSync(empty.tokenPath, "\n", { mode: 0o600 });
    const noHealth = await ensureDaemon(baseOptions(empty, { _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as never }));
    expect(noHealth.connected).toBe(false);

    const proc = fixture();
    const pid = 77;
    const fd = join(proc.procRoot, String(pid), "fd");
    mkdirSync(fd, { recursive: true });
    symlinkSync("pipe:[99]", join(fd, "0"));
    mkdirSync(join(proc.procRoot, "net"), { recursive: true });
    writeFileSync(join(proc.procRoot, "net", "tcp"), "header\n");
    writeFileSync(join(proc.procRoot, "net", "tcp6"), "header\n");
    expect(__lifecycleTestUtils.findListeningTcpPorts(pid, "linux", proc.seams.spawnSync, proc.procRoot)).toEqual([]);
  });

  it("covers normalized response status and ok accessors", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "warming" }),
    })) as unknown as typeof globalThis.fetch;
    const f = fixture({ fetch });
    const result = await ensureDaemon(baseOptions(f, { _skipSpawn: true, spawnTimeoutMs: 1 }));
    expect(result.connected).toBe(false);

    const falseOk = vi.fn(async () => ({
      ok: false,
      json: async () => ({ status: "warming" }),
    })) as unknown as typeof globalThis.fetch;
    const denied = fixture({ fetch: falseOk });
    const deniedResult = await ensureDaemon(baseOptions(denied, { _skipSpawn: true, spawnTimeoutMs: 1 }));
    expect(deniedResult.connected).toBe(false);
  });

  it("uses the test-scope manager environment and direct listener fallback", () => {
    const f = fixture({ environment: { PATH: "/bin" } });
    const scope = {
      ownerId: "final-scope",
      homeDir: f.root,
      runtimeDir: f.runtimeDir,
      stateDir: f.stateDir,
      credentialDir: f.credentialDir,
      entrypoint: join(f.runtimeDir, "entrypoint.mjs"),
      dependencies: {
        fetch: f.seams.fetch,
        spawn: f.seams.spawn,
        spawnSync: f.seams.spawnSync,
        stopUnit: f.seams.stopUnit,
        killProcess: f.seams.killProcess,
        isProcessAlive: f.seams.isProcessAlive,
        sleep: f.seams.sleep,
      },
    } as unknown as DaemonLifecycleTestScope;
    const opts = { ...baseOptions(f), _testScope: scope };
    const env = __lifecycleTestUtils.managerTransportEnvironment(opts, f.seams as never);
    expect(env.PATH).toBe(process.env.PATH);
    const run = __lifecycleTestUtils.supervisorCommandRunner(f.seams as never, opts);
    (f.seams.spawnSync as ReturnType<typeof vi.fn>).mockClear();
    run("manager", [], { timeoutMs: 10 });
    expect(f.seams.spawnSync).toHaveBeenCalled();

    const listener = fixture();
    const pid = 88;
    writeLinuxListener(listener, pid);
    expect(__lifecycleTestUtils.findListeningTcpPorts(pid, "linux", listener.seams.spawnSync, listener.procRoot, listener.port)).toEqual([listener.port]);
  });

  it("covers empty scoped tokens and endpoint listener fallbacks", async () => {
    let tokenEntrypoint = "";
    const tokenRoot = fixture({
      isAlive: () => true,
      fetch: vi.fn(async (url: string) => url.endsWith("/stats/pool")
        ? response({ totalConnections: 0 })
        : health(42, { ownerId: "token-owner", entrypoint: tokenEntrypoint })) as never,
    });
    const scoped = scopedFixture(tokenRoot, "token-owner");
    const sf = scoped.fixture;
    tokenEntrypoint = scoped.scope.entrypoint;
    writeFileSync(sf.pidPath, "42");
    writeFileSync(sf.tokenPath, "\n", { mode: 0o600 });
    const tokenBase = baseOptions(sf, { _skipSpawn: true, _listeningPortsOverride: () => [sf.port] });
    const { _hermeticTestSeams: _ignoredHermetic, expectedEntrypoint: _ignoredEntrypoint, ...tokenOptions } = tokenBase;
    const tokenResult = await ensureDaemon({ ...tokenOptions, _testScope: scoped.scope });
    expect(tokenResult.connected).toBe(false);

    const detached = fixture({
      isAlive: () => true,
      fetch: healthFetch([health(42), health(42), response({ totalConnections: 0 })]),
    });
    writeFileSync(detached.pidPath, "42");
    writeFileSync(detached.tokenPath, "token", { mode: 0o600 });
    writeProcCommand(detached, 42);
    writeLinuxListener(detached, 42);
    const detachedResult = await ensureDaemon(baseOptions(detached, { _skipSpawn: true }));
    expect(detachedResult.connected).toBe(true);

    const managed = fixture({
      isAlive: () => true,
      fetch: healthFetch([health(42), health(42), response({ totalConnections: 0 })]),
    });
    writeFileSync(managed.pidPath, "42");
    writeFileSync(managed.tokenPath, "token", { mode: 0o600 });
    writeProcCommand(managed, 42);
    writeLinuxListener(managed, 42);
    const supervisor = manager((spec) => managerObservation(spec, "registered-running-valid", { managerPid: 42 }));
    const managedResult = await ensureDaemon(baseOptions(managed, {
      enforceUserManagerParent: true,
      _supervisorOverride: supervisor.supervisor,
      _skipSpawn: true,
    }));
    expect(supervisor.probe).toHaveBeenCalled();
    expect(managedResult.connected).toBe(true);

    const explicit = fixture({
      isAlive: () => true,
      fetch: healthFetch([health(42), health(42), response({ totalConnections: 0 })]),
    });
    writeFileSync(explicit.pidPath, "42");
    writeFileSync(explicit.tokenPath, "token", { mode: 0o600 });
    const explicitSupervisor = manager((spec) => managerObservation(spec, "registered-running-valid", { managerPid: 42 }));
    const explicitResult = await ensureDaemon(baseOptions(explicit, {
      enforceUserManagerParent: true,
      _supervisorOverride: explicitSupervisor.supervisor,
      _listeningPortsOverride: () => [explicit.port],
      _skipSpawn: true,
    }));
    expect(explicitResult.connected).toBe(true);
  });

  it("covers manager endpoint and daemon-result race fallbacks", async () => {
    const f = fixture({
      isAlive: () => true,
      fetch: healthFetch([health(42), health(42), response({ totalConnections: 0 })]),
    });
    writeFileSync(f.pidPath, "42");
    writeFileSync(f.tokenPath, "token", { mode: 0o600 });
    writeProcCommand(f, 42);
    let listenerCalls = 0;
    const managed = manager((spec) => managerObservation(spec, "registered-running-valid", { managerPid: 42 }));
    const result = await ensureDaemon(baseOptions(f, {
      enforceUserManagerParent: true,
      _supervisorOverride: managed.supervisor,
      _skipSpawn: true,
      _listeningPortsOverride: () => (++listenerCalls === 1 ? [f.port] : []),
    }));
    expect(result.refusalReason).toBe("response-invalid");

    const restartRoot = fixture({
      isAlive: () => true,
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
    });
    writeFileSync(restartRoot.pidPath, "42");
    writeFileSync(restartRoot.tokenPath, "token", { mode: 0o600 });
    writeProcCommand(restartRoot, 42);
    writeLinuxListener(restartRoot, 42);
    const restartManager = manager((spec) => managerObservation(spec, "registered-running-valid", { managerPid: 42 }));
    const ensured = vi.fn(async () => ({ connected: false, port: restartRoot.port, spawned: false }));
    const restarted = await restartDaemon(baseOptions(restartRoot, {
      enforceUserManagerParent: true,
      _supervisorOverride: restartManager.supervisor,
      _ensureDaemonOverride: ensured,
    }));
    expect(restarted.restarted).toBe(true);
    expect(ensured).toHaveBeenCalledOnce();

    const noResponse = fixture({
      isAlive: () => true,
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
    });
    writeFileSync(noResponse.pidPath, "42");
    writeProcCommand(noResponse, 42);
    writeLinuxListener(noResponse, 42);
    const noResponseManager = manager((spec) => managerObservation(spec, "registered-running-valid", { managerPid: 42 }));
    const noResponseResult = await ensureDaemon(baseOptions(noResponse, {
      enforceUserManagerParent: true,
      _supervisorOverride: noResponseManager.supervisor,
      _skipSpawn: true,
    }));
    expect(noResponseResult.refusalReason).toBe("live-no-response");
  });

  it("covers retry deadline arms, authenticated retry races, and parent fences", async () => {
    const makeRetry = (extra: Partial<EnsureDaemonOptions> = {}, sleep: (ms: number) => Promise<void> = async () => undefined) => {
      let fetchCalls = 0;
      const f = fixture({
        isAlive: vi.fn((() => {
          let calls = 0;
          return () => calls++ === 0 ? false : true;
        })()),
        fetch: vi.fn(async () => {
          if (fetchCalls++ === 0) throw new Error("offline");
          return response({}, 503);
        }) as never,
        sleep,
      });
      writeFileSync(f.pidPath, "42");
      writeProcCommand(f, 42);
      return { f, options: baseOptions(f, { _skipSpawn: true, ...extra }) };
    };

    let slept = false;
    const timed = makeRetry({
      _monotonicNowOverride: () => 0,
    }, async () => { slept = true; });
    const timedResult = await ensureDaemon(timed.options);
    expect(timedResult.connected).toBe(false);
    expect(slept).toBe(true);

    let afterSleep = false;
    const noRetry = makeRetry({
      _listeningPortsOverride: () => [],
      _monotonicNowOverride: () => afterSleep ? 1_000 : 0,
    }, async () => { afterSleep = true; });
    const noRetryResult = await ensureDaemon(noRetry.options);
    expect(noRetryResult.connected).toBe(false);

    let noAuthCalls = 0;
    const noAuth = fixture({
      isAlive: vi.fn((() => {
        let calls = 0;
        return () => calls++ === 0 ? false : true;
      })()),
      fetch: vi.fn(async () => {
        if (noAuthCalls++ === 0) throw new Error("offline");
        return health(42);
      }) as never,
    });
    writeFileSync(noAuth.pidPath, "42");
    const noAuthResult = await ensureDaemon(baseOptions(noAuth, {
      _skipSpawn: true,
      _listeningPortsOverride: () => [noAuth.port],
    }));
    expect(noAuthResult.connected).toBe(false);

    let repairCalls = 0;
    let repairAlive = true;
    const repair = fixture({
      isAlive: (() => {
        let calls = 0;
        return () => calls++ === 0 ? false : repairAlive;
      })(),
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
        if (repairCalls++ === 0) throw new Error("offline");
        return health(42, { version: "2" });
      }) as never,
      killProcess: () => { repairAlive = false; },
    });
    writeFileSync(repair.pidPath, "42");
    writeFileSync(repair.tokenPath, "token", { mode: 0o600 });
    writeProcCommand(repair, 42);
    const repaired = await ensureDaemon(baseOptions(repair, {
      expectedVersion: "1",
      _skipSpawn: true,
      _listeningPortsOverride: () => [repair.port],
    }));
    expect(repaired.connected).toBe(false);

    let acceptedCalls = 0;
    const acceptedRace = fixture({
      isAlive: vi.fn((() => {
        let calls = 0;
        return () => calls++ === 0 ? false : true;
      })()),
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
        if (acceptedCalls++ === 0) throw new Error("offline");
        return acceptedCalls === 2 ? health(42) : health(42);
      }) as never,
    });
    writeFileSync(acceptedRace.pidPath, "42");
    writeFileSync(acceptedRace.tokenPath, "token", { mode: 0o600 });
    writeProcCommand(acceptedRace, 42);
    let acceptedListeners = 0;
    const acceptedRaceResult = await ensureDaemon(baseOptions(acceptedRace, {
      _skipSpawn: true,
      _listeningPortsOverride: () => (++acceptedListeners === 1 ? [acceptedRace.port] : []),
    }));
    expect(acceptedRaceResult.connected).toBe(false);

    let parentCalls = 0;
    const parent = fixture({
      isAlive: vi.fn((() => {
        let calls = 0;
        return () => calls++ === 0 ? false : true;
      })()),
      fetch: vi.fn(async () => {
        if (parentCalls++ === 0) throw new Error("offline");
        return health(42);
      }) as never,
    });
    writeFileSync(parent.pidPath, "42");
    writeProcCommand(parent, 42);
    writeProcStatus(parent, 42, 99);
    writeProcStatus(parent, 99, 1);
    writeProcCommand(parent, 99, "systemd --user");
    const parentResult = await ensureDaemon(baseOptions(parent, {
      enforceUserManagerParent: true,
      _skipSpawn: true,
    }));
    expect(parentResult.connected).toBe(false);

    const abortController = new AbortController();
    let abortedCalls = 0;
    const aborted = fixture({
      isAlive: () => true,
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
        if (abortedCalls++ === 0) return response(health(999));
        abortController.abort();
        return response({}, 503);
      }) as never,
    });
    writeFileSync(aborted.pidPath, "42");
    writeProcCommand(aborted, 42);
    const abortedResult = await ensureDaemon(baseOptions(aborted, {
      enforceUserManagerParent: true,
      _skipSpawn: true,
      _abortSignal: abortController.signal,
      _listeningPortsOverride: () => [],
    }));
    expect(abortedResult.connected).toBe(false);
  });

  it("covers managed-start acceptance rejection and all parent signal arms", async () => {
    let startHealthCalls = 0;
    const startRace = fixture({
      isAlive: () => true,
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
        if (startHealthCalls++ === 0) throw new Error("offline");
        return health(42);
      }) as never,
    });
    const startSupervisor = manager((spec, call) => call === 1
      ? managerObservation(spec, "absent")
      : managerObservation(spec, "registered-running-valid", { managerPid: 42 }),
      42,
      () => writeFileSync(startRace.pidPath, "42"));
    writeFileSync(startRace.tokenPath, "token", { mode: 0o600 });
    let startListeners = 0;
    const startResult = await ensureDaemon(baseOptions(startRace, {
      enforceUserManagerParent: true,
      _supervisorOverride: startSupervisor.supervisor,
      _skipSpawn: false,
      _listeningPortsOverride: () => (++startListeners === 1 ? [startRace.port] : []),
      _monotonicNowOverride: (() => {
        let calls = 0;
        return () => calls++ < 8 ? 0 : 1_000;
      })(),
    }));
    expect(startResult.refusalReason).toBe("startup-failure");

    const parentCase = async (listener: boolean, abort = false) => {
      let calls = 0;
      const controller = new AbortController();
      let alive = true;
      const f = fixture({
        isAlive: (() => {
          let reads = 0;
          return () => reads++ === 0 ? false : alive;
        })(),
        fetch: vi.fn(async () => {
          if (calls++ === 0) throw new Error("offline");
          return response(abort ? {} : health(42), abort ? 503 : 200);
        }) as never,
        sleep: async () => {
          if (abort) controller.abort();
        },
        killProcess: () => { alive = false; },
      });
      writeFileSync(f.pidPath, "42");
      writeProcCommand(f, 42);
      writeProcStatus(f, 42, 99);
      writeProcStatus(f, 99, 1);
      writeProcCommand(f, 99, "systemd --user");
      const result = await ensureDaemon(baseOptions(f, {
        enforceUserManagerParent: true,
        _skipSpawn: true,
        _abortSignal: abort ? controller.signal : undefined,
        _listeningPortsOverride: () => listener ? [f.port] : [],
      }));
      expect(result.connected).toBe(false);
    };
    await parentCase(true);
    await parentCase(false);
    await parentCase(true, true);
  });

  it("covers unscoped manager cleanup and zero-timeout supervisor defaults", async () => {
    const f = fixture({
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
    });
    const managed = manager((spec, call) => call === 1
      ? managerObservation(spec, "absent")
      : managerObservation(spec, "registered-running-valid", { managerPid: 42 }),
      42,
      () => writeFileSync(f.pidPath, "42"));
    const base = baseOptions(f, {
      enforceUserManagerParent: true,
      _supervisorOverride: managed.supervisor,
      _skipSpawn: false,
      _skipHealthWait: false,
      spawnTimeoutMs: 10,
      _spawnOverride: f.seams.spawn,
      _monotonicNowOverride: (() => {
        let calls = 0;
        return () => calls++ < 8 ? 0 : 1_000;
      })(),
    });
    const { _hermeticTestSeams: _ignoredHermetic, ...unscoped } = base;
    const originalArgv = process.argv[1];
    process.argv[1] = "/tmp/lcm-runner.mjs";
    const result = await ensureDaemon(unscoped);
    process.argv[1] = originalArgv;
    expect(result.spawned).toBe(true);
    expect(managed.start).toHaveBeenCalledOnce();
    expect(managed.supervisor.stopAndAwaitAbsent).toHaveBeenCalled();

    const defaultEnsure = fixture({
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
      spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })) as never,
    });
    const defaultResult = await ensureDaemon(baseOptions(defaultEnsure, {
      enforceUserManagerParent: true,
      _skipSpawn: true,
      spawnTimeoutMs: 0,
    }));
    expect(defaultResult.connected).toBe(false);

    const restartRoot = fixture({ spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })) as never });
    const restartManaged = manager((spec) => managerObservation(spec, "absent"));
    const restart = await restartDaemon(baseOptions(restartRoot, {
      enforceUserManagerParent: true,
      _supervisorOverride: restartManaged.supervisor,
      _skipSpawn: true,
      spawnTimeoutMs: 0,
    }));
    expect(restart.refusalReason).toBe("absent");
  });

  it("covers normal detached combined warnings and abort cleanup callback", async () => {
    const child = {
      pid: undefined,
      once: vi.fn((_event: string, callback: (error: Error) => void) => {
        callback(new Error("permission denied"));
        return child;
      }),
      unref: vi.fn(),
    };
    const fallback = fixture({
      spawn: vi.fn(() => child) as never,
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
    });
    const fallbackResult = await ensureDaemon(baseOptions(fallback, {
      enforceUserManagerParent: true,
      _supervisorOverride: manager((spec) => managerObservation(spec, "unavailable", { reason: "manager-unavailable" })).supervisor,
      _skipSpawn: false,
      _monotonicNowOverride: (() => {
        let calls = 0;
        return () => calls++ < 6 ? 0 : 1_000;
      })(),
    }));
    expect(fallbackResult.warning).toContain("; detached spawn failed");

    const controller = new AbortController();
    const abortChild = { pid: 42, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    const scopedRoot = fixture({
      spawn: vi.fn(() => {
        controller.abort();
        return abortChild;
      }) as never,
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
      isAlive: () => true,
    });
    const scoped = scopedFixture(scopedRoot, "abort-owner");
    const { _hermeticTestSeams: _ignoredHermetic, expectedEntrypoint: _ignoredEntrypoint, ...abortOptions } = baseOptions(scoped.fixture, {
      _skipSpawn: false,
      _skipHealthWait: true,
      _abortSignal: controller.signal,
    });
    const aborted = await ensureDaemon({ ...abortOptions, _testScope: scoped.scope });
    expect(aborted.warning).toBe("daemon lifecycle was interrupted");
  });

  it("covers managed pre-start timeout refusal and direct restart timeout fallback", async () => {
    const calls: SupervisorObservation[] = [];
    const f = fixture({
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => undefined),
      })) as never,
      isAlive: () => false,
    });
    const managed = manager((spec) => {
      const value = managerObservation(spec, "absent");
      calls.push(value);
      return value;
    });
    const result = await ensureDaemon(baseOptions(f, {
      enforceUserManagerParent: true,
      _supervisorOverride: managed.supervisor,
      spawnTimeoutMs: 1,
      _monotonicNowOverride: () => 0,
    }));
    expect(result.refusalReason).toBe("response-timeout");
    expect(calls).toHaveLength(1);

    const restartFixture = fixture({
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => undefined),
      })) as never,
      isAlive: () => true,
    });
    writeFileSync(restartFixture.pidPath, "42");
    const running = manager((spec) => managerObservation(spec, "registered-running-valid", { managerPid: 42 }));
    const restart = await restartDaemon(baseOptions(restartFixture, {
      enforceUserManagerParent: true,
      _supervisorOverride: running.supervisor,
      _listeningPortsOverride: () => [restartFixture.port],
      spawnTimeoutMs: 1,
      _monotonicNowOverride: () => 0,
    }));
    expect(restart.refusalReason).toBe("response-timeout");
  });

  it("covers managed start rejection, auth rejection, and identity race paths", async () => {
    let unknownHealthCalls = 0;
    const unknown = fixture({
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
        if (unknownHealthCalls++ === 0) throw new Error("offline");
        return health(42, { storageBackend: "mystery" });
      }) as never,
      isAlive: () => true,
    });
    const unknownManager = manager((spec, call) => call === 1
      ? managerObservation(spec, "absent")
      : managerObservation(spec, "registered-running-valid", { managerPid: 42 }),
      42,
      () => writeFileSync(unknown.pidPath, "42"));
    const unknownResult = await ensureDaemon(baseOptions(unknown, {
      enforceUserManagerParent: true,
      _supervisorOverride: unknownManager.supervisor,
      _skipSpawn: false,
      _listeningPortsOverride: () => [unknown.port],
      _monotonicNowOverride: (() => {
        let calls = 0;
        return () => calls++ < 8 ? 0 : 1_000;
      })(),
    }));
    expect(unknownManager.start).toHaveBeenCalled();
    expect(unknownHealthCalls).toBeGreaterThan(1);
    expect(unknownResult.refusalReason).toBe("startup-failure");

    let authHealthCalls = 0;
    const auth = fixture({
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/stats/pool")) return response({ error: "denied" }, 401);
        if (authHealthCalls++ === 0) throw new Error("offline");
        return health(42);
      }) as never,
      isAlive: () => true,
    });
    writeProcCommand(auth, 42);
    writeLinuxListener(auth, 42);
    const authManager = manager((spec, call) => call === 1
      ? managerObservation(spec, "absent")
      : managerObservation(spec, "registered-running-valid", { managerPid: 42 }),
      42,
      () => writeFileSync(auth.pidPath, "42"));
    const authResult = await ensureDaemon(baseOptions(auth, {
      enforceUserManagerParent: true,
      _supervisorOverride: authManager.supervisor,
      _skipSpawn: false,
      _monotonicNowOverride: (() => {
        let calls = 0;
        return () => calls++ < 8 ? 0 : 1_000;
      })(),
    }));
    expect(authResult.refusalReason).toBe("startup-failure");

    let raceHealthCalls = 0;
    const race = fixture({
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
        if (raceHealthCalls++ === 0) throw new Error("offline");
        return health(42);
      }) as never,
      isAlive: () => true,
    });
    let listenerCalls = 0;
    const raceManager = manager((spec, call) => call === 1
      ? managerObservation(spec, "absent")
      : managerObservation(spec, "registered-running-valid", { managerPid: 42 }),
      42,
      () => writeFileSync(race.pidPath, "42"));
    const raceResult = await ensureDaemon(baseOptions(race, {
      enforceUserManagerParent: true,
      _supervisorOverride: raceManager.supervisor,
      _skipSpawn: false,
      _listeningPortsOverride: () => (++listenerCalls < 2 ? [race.port] : []),
      _monotonicNowOverride: (() => {
        let calls = 0;
        return () => calls++ < 8 ? 0 : 1_000;
      })(),
    }));
    expect(raceResult.refusalReason).toBe("startup-failure");
  });

  it("covers scoped manager cleanup, retry timing, and listener-state race fences", async () => {
    const f = fixture({
      isAlive: () => true,
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
    });
    const scoped = scopedFixture(f);
    const sf = scoped.fixture;
    const scope = scoped.scope;
    const managed = manager((spec, call) => call === 1
      ? managerObservation(spec, "absent")
      : managerObservation(spec, "registered-running-valid", { managerPid: 42 }),
      42,
      () => writeFileSync(sf.pidPath, "42"));
    const scopedBase = baseOptions(sf, { _skipSpawn: false });
    const { _hermeticTestSeams: _ignoredHermetic, expectedEntrypoint: _ignoredEntrypoint, ...scopedOptions } = scopedBase;
    const result = await ensureDaemon({
      ...scopedOptions,
      _testScope: scope,
      enforceUserManagerParent: true,
      _supervisorOverride: managed.supervisor,
      _skipHealthWait: true,
      _monotonicNowOverride: (() => {
        let calls = 0;
        return () => calls++ < 8 ? 0 : 1_000;
      })(),
    });
    expect(result.spawned).toBe(true);
    expect(managed.start).toHaveBeenCalled();

    const retry = fixture({ isAlive: () => true });
    writeFileSync(retry.pidPath, "42");
    writeFileSync(retry.tokenPath, "token", { mode: 0o600 });
    writeProcCommand(retry, 42);
    let nowCalls = 0;
    const retryResult = await ensureDaemon(baseOptions(retry, {
      _skipSpawn: true,
      _supervisorOverride: manager((spec) => managerObservation(spec, "unavailable", { reason: "manager-unavailable" })).supervisor,
      _monotonicNowOverride: () => (++nowCalls < 4 ? 0 : 100),
    }));
    expect(retryResult.connected).toBe(false);

    const stateRace = fixture({ isAlive: () => true });
    writeFileSync(stateRace.pidPath, "42");
    writeFileSync(stateRace.tokenPath, "token", { mode: 0o600 });
    writeProcCommand(stateRace, 42);
    let listener = true;
    const stateResult = await ensureDaemon(baseOptions(stateRace, {
      _skipSpawn: true,
      _supervisorOverride: manager((spec) => managerObservation(spec, "unavailable", { reason: "manager-unavailable" })).supervisor,
      _listeningPortsOverride: () => listener ? [stateRace.port] : [],
      _fetchOverride: healthFetch([response({ status: "warming" })]),
      _killOverride: () => { listener = false; },
    }));
    expect(stateResult.connected).toBe(false);
  });

  it("covers detached combined warnings and test-scope owner mismatch", async () => {
    const child = {
      pid: undefined,
      once: vi.fn((_event: string, callback: (error: Error) => void) => {
        callback(new Error("permission denied"));
        return child;
      }),
      unref: vi.fn(),
    };
    const f = fixture({
      spawn: vi.fn(() => child) as never,
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
    });
    const result = await ensureDaemon(baseOptions(f, {
      enforceUserManagerParent: true,
      _supervisorOverride: manager((spec) => managerObservation(spec, "unavailable", { reason: "manager-unavailable" })).supervisor,
      _skipSpawn: false,
      _skipHealthWait: true,
    }));
    expect(result.warning).toContain("; detached spawn failed");

    const scopedRoot = fixture({ fetch: healthFetch([health(42, { ownerId: "foreign" })]) , isAlive: () => true });
    const scoped = scopedFixture(scopedRoot, "owned");
    const scopedState = scoped.fixture;
    writeFileSync(scopedState.pidPath, "42");
    writeFileSync(scopedState.tokenPath, "token", { mode: 0o600 });
    const scopedBase = baseOptions(scopedState, { _skipSpawn: true });
    const { _hermeticTestSeams: _ignoredHermetic, expectedEntrypoint: _ignoredEntrypoint, ...scopedOptions } = scopedBase;
    const mismatch = restartDaemon({
      ...scopedOptions,
      _testScope: scoped.scope,
      enforceUserManagerParent: false,
      _listeningPortsOverride: () => [scopedState.port],
    });
    await expect(mismatch).rejects.toThrow("Refusing to restart");
  });

  it("covers restart supervisor aliases, default construction, and stale dead PID proof", async () => {
    const alias = fixture();
    const aliasSupervisor = manager((spec) => managerObservation(spec, "absent")).supervisor;
    const aliasResult = await restartDaemon(baseOptions(alias, {
      enforceUserManagerParent: true,
      _supervisor: aliasSupervisor,
      spawnTimeoutMs: 0,
      _skipSpawn: true,
    }));
    expect(aliasResult.refusalReason).toBe("absent");

    const defaultFixture = fixture({
      spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })) as never,
    });
    const defaultResult = await restartDaemon(baseOptions(defaultFixture, {
      enforceUserManagerParent: true,
      spawnTimeoutMs: 0,
      _skipSpawn: true,
    }));
    expect(defaultResult.restarted).toBe(false);

    const stale = fixture({ isAlive: () => false });
    writeFileSync(stale.pidPath, "42");
    const staleManager = manager((spec) => managerObservation(spec, "registered-not-running-valid", { terminal: "failed" }));
    const staleResult = await restartDaemon(baseOptions(stale, {
      enforceUserManagerParent: true,
      _supervisorOverride: staleManager.supervisor,
      _skipSpawn: true,
    }));
    expect(staleResult.refusalReason).toBe("not-running");
  });
});

function fTempDir(): string {
  const dir = root("lcm-400-env-");
  mkdirSync(dir, { recursive: true });
  return dir;
}
