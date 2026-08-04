import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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
type Fixture = { root: string; stateDir: string; runtimeDir: string; credentialDir: string; procRoot: string; pidPath: string; tokenPath: string; port: number; seams: DaemonLifecycleHermeticTestSeams };
type OwnOptions = { pid?: number; token?: string; listener?: boolean };
type FixtureOptions = { platform?: NodeJS.Platform; environment?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch; spawn?: typeof import("node:child_process").spawn; spawnSync?: typeof import("node:child_process").spawnSync; killProcess?: (pid: number, signal?: NodeJS.Signals | number) => void; isAlive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void>; realpath?: (path: string) => string };
type ManagerHarness = { supervisor: Supervisor; probe: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stopAndStart: ReturnType<typeof vi.fn> };
function root(prefix = "lcm-400-final-"): string { const value = mkdtempSync(join(tmpdir(), prefix)); roots.push(value); return value; }
function response(body: unknown, status = 200): ResponseLike { return { ok: status >= 200 && status <= 299, status, json: async () => body }; }
function health(pid: number, extra: Record<string, unknown> = {}): ResponseLike {
  return response({ status: "ok", version: "1", storageBackend: "sqlite", runtimeDigest: RUNTIME_DIGEST, entrypoint: "/entrypoint.mjs", pid, ...extra });
}
function fixture(options: FixtureOptions = {}): Fixture {
  const dir = root();
  const stateDir = join(dir, "state");
  const runtimeDir = join(dir, "runtime");
  const credentialDir = join(dir, "credentials");
  const procRoot = join(dir, "proc");
  for (const path of [stateDir, runtimeDir, credentialDir, procRoot]) mkdirSync(path, { recursive: true });
  chmodSync(stateDir, 0o700);
  chmodSync(credentialDir, 0o700);
  const seams: DaemonLifecycleHermeticTestSeams = {
    homeDir: dir, runtimeDir, stateDir, credentialDir, procRoot, platform: options.platform ?? "linux", uid: 1000,
    environment: options.environment ?? {}, fetch: options.fetch ?? (vi.fn(async () => response({}, 503)) as never),
    spawn: options.spawn ?? (vi.fn(() => ({ pid: undefined, once: vi.fn().mockReturnThis(), unref: vi.fn() })) as never),
    spawnSync: options.spawnSync ?? (vi.fn(() => ({ status: 1, stdout: "", stderr: "" })) as never), stopUnit: vi.fn(),
    killProcess: options.killProcess ?? vi.fn(), isProcessAlive: options.isAlive ?? (() => false),
    sleep: options.sleep ?? (async () => undefined), realpath: options.realpath ?? ((path: string) => path),
  };
  return { root: dir, stateDir, runtimeDir, credentialDir, procRoot, pidPath: join(stateDir, "daemon.pid"), tokenPath: join(stateDir, "daemon.token"), port: 43_201, seams };
}
function baseOptions(f: Fixture, extra: Partial<EnsureDaemonOptions> = {}): EnsureDaemonOptions {
  return { port: f.port, pidFilePath: f.pidPath, spawnTimeoutMs: 100, expectedVersion: "1", expectedEntrypoint: "/entrypoint.mjs", expectedRuntimeDigest: RUNTIME_DIGEST, _hermeticTestSeams: f.seams, _skipSpawn: true, ...extra };
}
function ensure(f: Fixture, extra: Partial<EnsureDaemonOptions> = {}) { return ensureDaemon(baseOptions(f, extra)); }
function managedEnsure(f: Fixture, supervisor: Supervisor, extra: Partial<EnsureDaemonOptions> = {}) { return ensure(f, { enforceUserManagerParent: true, _supervisorOverride: supervisor, ...extra }); }
function managedRestart(f: Fixture, supervisor: Supervisor, extra: Partial<EnsureDaemonOptions> = {}) { return restartDaemon(baseOptions(f, { enforceUserManagerParent: true, _supervisorOverride: supervisor, ...extra })); }
function withoutHermetic(options: EnsureDaemonOptions): EnsureDaemonOptions { const { _hermeticTestSeams: _ignoredHermetic, ...rest } = options; return rest; }
function manager(observation: (spec: SupervisorSpec, call: number) => SupervisorObservation, startPid = 42, onStart: () => void = () => undefined): ManagerHarness {
  let calls = 0;
  const probe = vi.fn(async (spec: SupervisorSpec) => observation(spec, ++calls));
  const start = vi.fn(async (spec: SupervisorSpec) => {
    onStart();
    return { kind: spec.kind, name: spec.name, scopeDigest: spec.scopeDigest, port: spec.port, nonce: spec.nonce, managerPid: startPid };
  });
  const stopAndStart = vi.fn(start);
  return { supervisor: { probe, start, stopAndStart, stopAndAwaitAbsent: vi.fn() }, probe, start, stopAndStart } as unknown as ManagerHarness;
}
function managerObservation(spec: SupervisorSpec, kind: SupervisorObservation["kind"], extra: Record<string, unknown> = {}): SupervisorObservation { return { kind, name: spec.name, scopeDigest: spec.scopeDigest, nonce: spec.nonce, ...extra } as SupervisorObservation; }
function deadlineClock(limit = 8, end = 1_000): () => number { let calls = 0; return () => calls++ < limit ? 0 : end; }
function unavailableManager(reason = "manager-unavailable"): Supervisor { return manager((spec) => managerObservation(spec, "unavailable", { reason })).supervisor; }
function startingManager(f: Fixture, token?: string): ReturnType<typeof manager> {
  return manager((spec, call) => call === 1 ? managerObservation(spec, "absent") : managerObservation(spec, "registered-running-valid", { managerPid: 42 }), 42, () => {
    writeFileSync(f.pidPath, "42");
    if (token !== undefined) writeFileSync(f.tokenPath, token, { mode: 0o600 });
  });
}
function healthFetch(values: readonly ResponseLike[]): typeof globalThis.fetch {
  let index = 0;
  return vi.fn(async (url: string) => url.endsWith("/stats/pool") ? response({ totalConnections: 0 }) : values[Math.min(index++, values.length - 1)] ?? response({}, 503)) as never;
}
function existingFixture(): Fixture { return ownedFixture({ isAlive: () => true, fetch: healthFetch([health(42), health(42), response({ totalConnections: 0 })]) }, { listener: true }); }
function offlineFixture(options: FixtureOptions = {}, ownOptions: OwnOptions = {}): Fixture { return ownedFixture({ fetch: vi.fn().mockRejectedValue(new Error("offline")) as never, ...options }, ownOptions); }
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
function nonSocketProc(f: Fixture, pid = 77): void { const fd = join(f.procRoot, String(pid), "fd"); mkdirSync(fd, { recursive: true }); symlinkSync("pipe:[99]", join(fd, "0")); mkdirSync(join(f.procRoot, "net"), { recursive: true }); writeFileSync(join(f.procRoot, "net", "tcp"), "header\n"); writeFileSync(join(f.procRoot, "net", "tcp6"), "header\n"); }
function writeLinuxListener(f: Fixture, pid: number, inode = "12345", port = f.port): void {
  const dir = join(f.procRoot, String(pid), "fd");
  mkdirSync(dir, { recursive: true });
  symlinkSync(`socket:[${inode}]`, join(dir, "0"));
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  mkdirSync(join(f.procRoot, "net"), { recursive: true });
  writeFileSync(join(f.procRoot, "net", "tcp"), `  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n  0: 0100007F:${portHex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000   100        0 ${inode} 1\n`);
  writeFileSync(join(f.procRoot, "net", "tcp6"), "header\n");
}
function own(f: Fixture, options: OwnOptions = {}): number {
  const pid = options.pid ?? 42;
  const token = Object.hasOwn(options, "token") ? options.token : "token";
  writeFileSync(f.pidPath, String(pid));
  if (token !== undefined) writeFileSync(f.tokenPath, token, { mode: 0o600 });
  writeProcCommand(f, pid);
  if (options.listener) writeLinuxListener(f, pid);
  return pid;
}
function ownedFixture(options: FixtureOptions = {}, ownOptions: OwnOptions = {}): Fixture { const f = fixture(options); own(f, ownOptions); return f; }
function writeParent(f: Fixture, token?: string): void {
  own(f, { token });
  writeProcStatus(f, 42, 99);
  writeProcStatus(f, 99, 1);
  writeProcCommand(f, 99, "systemd --user");
}
function wrongParent(f: Fixture): void { writeProcStatus(f, 42, 98); writeProcStatus(f, 98, 1); writeProcCommand(f, 98, "bash"); writeProcStatus(f, 99, 1); writeProcCommand(f, 99, "systemd --user"); }
function deadThenAlive(): () => boolean { let calls = 0; return () => calls++ === 0 ? false : true; }
function scopeDependencies(f: Fixture): DaemonLifecycleTestDependencies { return { fetch: f.seams.fetch, spawn: f.seams.spawn, spawnSync: f.seams.spawnSync, stopUnit: f.seams.stopUnit, killProcess: f.seams.killProcess, isProcessAlive: f.seams.isProcessAlive, sleep: f.seams.sleep }; }
function scopedOptions(f: Fixture, scope: DaemonLifecycleTestScope, extra: Partial<EnsureDaemonOptions> = {}): EnsureDaemonOptions { const { _hermeticTestSeams: _ignoredHermetic, expectedEntrypoint: _ignoredEntrypoint, ...rest } = baseOptions(f, extra); return { ...rest, _testScope: scope }; }
function failingChild() { const child = { pid: undefined, once: vi.fn((_event: string, callback: (error: Error) => void) => { callback(new Error("permission denied")); return child; }), unref: vi.fn() }; return child; }
async function parentFence(listener: boolean, abort = false): Promise<Awaited<ReturnType<typeof ensureDaemon>>> {
  let calls = 0;
  const controller = new AbortController();
  let alive = true;
  const f = fixture({
    isAlive: (() => { let reads = 0; return () => reads++ === 0 ? false : alive; })(),
    fetch: vi.fn(async () => calls++ === 0 ? Promise.reject(new Error("offline")) : response(abort ? {} : health(42), abort ? 503 : 200)) as never,
    sleep: async () => { if (abort) controller.abort(); },
    killProcess: () => { alive = false; },
  });
  writeParent(f);
  return ensure(f, { enforceUserManagerParent: true, _skipSpawn: true, _abortSignal: abort ? controller.signal : undefined, _listeningPortsOverride: () => listener ? [f.port] : [] });
}
function retryOptions(extra: Partial<EnsureDaemonOptions> = {}, sleep: (ms: number) => Promise<void> = async () => undefined): EnsureDaemonOptions {
  let calls = 0;
  const f = fixture({ isAlive: deadThenAlive(), fetch: vi.fn(async () => calls++ === 0 ? Promise.reject(new Error("offline")) : response({}, 503)) as never, sleep });
  own(f, { token: undefined });
  return baseOptions(f, { _skipSpawn: true, ...extra });
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
  const scope = createDaemonLifecycleTestScope({ ownerId, homeDir, runtimeDir, stateDir, credentialDir, entrypoint, dependencies: scopeDependencies(f) });
  return { fixture: { ...f, stateDir, runtimeDir, credentialDir, pidPath: join(stateDir, "daemon.pid"), tokenPath: join(stateDir, "daemon.token") }, scope };
}
describe("Epic 400 lifecycle final branch closure", () => {
  it("covers explicit manager command environments, empty tokens, and non-socket proc entries", async () => {
    const f = fixture({
      environment: { PATH: "/bin", XDG_RUNTIME_DIR: fTempDir() },
    });
    const run = __lifecycleTestUtils.supervisorCommandRunner(f.seams as never, baseOptions(f));
    run("manager", [], { timeoutMs: 10, env: { PATH: "/custom" } });
    const empty = fixture();
    writeFileSync(empty.tokenPath, "\n", { mode: 0o600 });
    await ensure(empty, { _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as never });
    const proc = fixture();
    nonSocketProc(proc);
    __lifecycleTestUtils.findListeningTcpPorts(77, "linux", proc.seams.spawnSync, proc.procRoot);
  });
  it("covers normalized response status and ok accessors", async () => {
    for (const ok of [true, false]) {
      const f = fixture({ fetch: vi.fn(async () => ({ ok, json: async () => ({ status: "warming" }) })) as never });
      await ensure(f, { _skipSpawn: true, spawnTimeoutMs: 1 });
    }
  });
  it("uses the test-scope manager environment and direct listener fallback", () => {
    const f = fixture({ environment: { PATH: "/bin" } });
    const scope = scopedFixture(f).scope;
    const opts = scopedOptions(f, scope);
    __lifecycleTestUtils.managerTransportEnvironment(opts, f.seams as never);
    const run = __lifecycleTestUtils.supervisorCommandRunner(f.seams as never, opts);
    (f.seams.spawnSync as ReturnType<typeof vi.fn>).mockClear();
    run("manager", [], { timeoutMs: 10 });
    const listener = fixture();
    const pid = 88;
    writeLinuxListener(listener, pid);
    __lifecycleTestUtils.findListeningTcpPorts(pid, "linux", listener.seams.spawnSync, listener.procRoot, listener.port);
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
    own(sf, { token: "\n" });
    const tokenBase = baseOptions(sf, { _skipSpawn: true, _listeningPortsOverride: () => [sf.port] });
    const { _hermeticTestSeams: _ignoredHermetic, expectedEntrypoint: _ignoredEntrypoint, ...tokenOptions } = tokenBase;
    await ensureDaemon({ ...tokenOptions, _testScope: scoped.scope });
    const detached = existingFixture();
    await ensure(detached, { _skipSpawn: true });
    const managed = existingFixture();
    const supervisor = manager((spec) => managerObservation(spec, "registered-running-valid", { managerPid: 42 }));
    await managedEnsure(managed, supervisor.supervisor, {
      _skipSpawn: true,
    });
  });
  it("covers manager endpoint and daemon-result race fallbacks", async () => {
    const f = existingFixture();
    let listenerCalls = 0;
    const managed = manager((spec) => managerObservation(spec, "registered-running-valid", { managerPid: 42 }));
    const result = await managedEnsure(f, managed.supervisor, {
      _skipSpawn: true,
      _listeningPortsOverride: () => (++listenerCalls === 1 ? [f.port] : []),
    });
    expect(result.refusalReason).toBe("ambiguous");
    const restartRoot = offlineFixture({ isAlive: () => true }, { listener: true });
    const restartManager = manager((spec) => managerObservation(spec, "registered-running-valid", { managerPid: 42 }));
    const ensured = vi.fn(async () => ({ connected: false, port: restartRoot.port, spawned: false }));
    const restarted = await managedRestart(restartRoot, restartManager.supervisor, {
      _ensureDaemonOverride: ensured,
    });
    expect(restarted.restarted).toBe(true);
    const noResponse = offlineFixture({ isAlive: () => true }, { token: undefined, listener: true });
    const noResponseManager = manager((spec) => managerObservation(spec, "registered-running-valid", { managerPid: 42 }));
    const noResponseResult = await managedEnsure(noResponse, noResponseManager.supervisor, {
      _skipSpawn: true,
    });
    expect(noResponseResult.refusalReason).toBe("live-no-response");
  });
  it("covers retry deadline arms, authenticated retry races, and parent fences", async () => {
    let slept = false;
    const timed = retryOptions({ _monotonicNowOverride: () => 0 }, async () => { slept = true; });
    await ensureDaemon(timed);
    expect(slept).toBe(true);
    let afterSleep = false;
    const noRetry = retryOptions({ _listeningPortsOverride: () => [], _monotonicNowOverride: () => afterSleep ? 1_000 : 0 }, async () => { afterSleep = true; });
    await ensureDaemon(noRetry);
    let noAuthCalls = 0;
    const noAuth = ownedFixture({
      isAlive: deadThenAlive(),
      fetch: vi.fn(async () => {
        if (noAuthCalls++ === 0) throw new Error("offline");
        return health(42);
      }) as never,
    }, { token: undefined });
    await ensure(noAuth, { _skipSpawn: true, _listeningPortsOverride: () => [noAuth.port] });
    let repairCalls = 0;
    let repairAlive = true;
    const repair = ownedFixture({
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
    await ensure(repair, { expectedVersion: "1", _skipSpawn: true, _listeningPortsOverride: () => [repair.port] });
    let acceptedCalls = 0;
    const acceptedRace = ownedFixture({
      isAlive: deadThenAlive(),
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
        if (acceptedCalls++ === 0) throw new Error("offline");
        return acceptedCalls === 2 ? health(42) : health(42);
      }) as never,
    });
    let acceptedListeners = 0;
    await ensure(acceptedRace, { _skipSpawn: true, _listeningPortsOverride: () => (++acceptedListeners === 1 ? [acceptedRace.port] : []) });
    let parentCalls = 0;
    const parent = fixture({ isAlive: vi.fn((() => { let calls = 0; return () => calls++ === 0 ? false : true; })()), fetch: vi.fn(async () => parentCalls++ === 0 ? Promise.reject(new Error("offline")) : health(42)) as never });
    writeParent(parent);
    await ensure(parent, { enforceUserManagerParent: true, _skipSpawn: true });
    const abortController = new AbortController();
    let abortedCalls = 0;
    const aborted = ownedFixture({ isAlive: () => true, fetch: vi.fn(async (url: string) => url.endsWith("/stats/pool") ? response({ totalConnections: 0 }) : abortedCalls++ === 0 ? response(health(999)) : (abortController.abort(), response({}, 503))) as never }, { token: undefined });
    await ensure(aborted, { enforceUserManagerParent: true, _skipSpawn: true, _abortSignal: abortController.signal, _listeningPortsOverride: () => [] });
    let retryCalls = 0;
    const wrong = ownedFixture({
      isAlive: deadThenAlive(),
      fetch: vi.fn(async (url: string) => url.endsWith("/stats/pool") ? response({ totalConnections: 0 }) : retryCalls++ === 0 ? Promise.reject(new Error("offline")) : health(42)) as never,
    }, { listener: true });
    wrongParent(wrong);
    await ensure(wrong, { enforceUserManagerParent: true, _supervisorOverride: unavailableManager(), _skipSpawn: true, _monotonicNowOverride: () => 0, _listeningPortsOverride: () => [wrong.port] });
    let invalidCalls = 0;
    let invalidListeners = 0;
    const invalid = ownedFixture({ isAlive: deadThenAlive(), fetch: vi.fn(async () => invalidCalls++ === 0 ? Promise.reject(new Error("offline")) : response({ status: "warming" })) as never }, { token: undefined, listener: true });
    wrongParent(invalid);
    await ensure(invalid, { enforceUserManagerParent: true, _supervisorOverride: unavailableManager(), _skipSpawn: true, _monotonicNowOverride: () => 0, _listeningPortsOverride: () => invalidListeners++ === 0 ? [] : [invalid.port] });
    let expiredNow = 0;
    const expired = ownedFixture({ isAlive: deadThenAlive(), fetch: vi.fn().mockRejectedValue(new Error("offline")) as never }, { token: undefined });
    await ensure(expired, { enforceUserManagerParent: true, _supervisorOverride: unavailableManager(), _skipSpawn: true, _monotonicNowOverride: () => expiredNow++ === 0 ? 0 : 1_000, _listeningPortsOverride: () => [] });
    const retryAbort = new AbortController();
    const abortedRetry = ownedFixture({ isAlive: () => true, fetch: vi.fn().mockResolvedValue(response({ status: "warming" })) as never, sleep: async () => { retryAbort.abort(); } }, { token: undefined });
    wrongParent(abortedRetry);
    let retryNow = 0;
    await ensure(abortedRetry, { enforceUserManagerParent: true, _supervisorOverride: unavailableManager(), _skipSpawn: true, _abortSignal: retryAbort.signal, _monotonicNowOverride: () => retryNow++ < 3 ? 0 : 1_000, _listeningPortsOverride: () => [] });
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
    const startSupervisor = startingManager(startRace);
    const startResult = await ensureDaemon(baseOptions(startRace, {
      enforceUserManagerParent: true,
      _supervisorOverride: startSupervisor.supervisor,
      _skipSpawn: false,
      _listeningPortsOverride: () => [startRace.port],
      _monotonicNowOverride: deadlineClock(),
    }));
    expect(startResult.refusalReason).toBe("startup-failure");
    for (const [listener, abort] of [[true, false], [false, false], [true, true]] as const) {
      expect((await parentFence(listener, abort)).connected).toBe(false);
    }
  });
  it("covers unscoped manager cleanup and zero-timeout supervisor defaults", async () => {
    const f = fixture({
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
    });
    const managed = startingManager(f);
    const base = baseOptions(f, {
      enforceUserManagerParent: true,
      _supervisorOverride: managed.supervisor,
      _skipSpawn: false,
      _skipHealthWait: false,
      spawnTimeoutMs: 10,
      _spawnOverride: f.seams.spawn,
      _monotonicNowOverride: deadlineClock(),
    });
    const unscoped = withoutHermetic(base);
    const originalArgv = process.argv[1];
    process.argv[1] = "/tmp/lcm-runner.mjs";
    await ensureDaemon(unscoped);
    process.argv[1] = originalArgv;
    const defaultEnsure = fixture({
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
      spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })) as never,
    });
    await ensure(defaultEnsure, {
      enforceUserManagerParent: true,
      _skipSpawn: true,
      spawnTimeoutMs: 0,
    });
    const restartRoot = fixture({ spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })) as never });
    const restartManaged = manager((spec) => managerObservation(spec, "absent"));
    const restart = await managedRestart(restartRoot, restartManaged.supervisor, {
      _skipSpawn: true,
      spawnTimeoutMs: 0,
    });
    expect(restart.refusalReason).toBe("absent");
  });
  it("covers normal detached combined warnings and abort cleanup callback", async () => {
    const child = failingChild();
    const fallback = fixture({
      spawn: vi.fn(() => child) as never,
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
    });
    const fallbackResult = await managedEnsure(fallback, unavailableManager(), {
      _skipSpawn: false,
      _monotonicNowOverride: deadlineClock(6),
    });
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
    await ensureDaemon(scopedOptions(scoped.fixture, scoped.scope, {
      _skipSpawn: false,
      _skipHealthWait: true,
      _abortSignal: controller.signal,
    }));
    const cleanupController = new AbortController();
    let cleanupAlive = true;
    let cleanupSleeps = 0;
    const cleanupChild = { pid: 42, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    const cleanupRoot = fixture({
      spawn: vi.fn(() => { cleanupController.abort(); return cleanupChild; }) as never,
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
      isAlive: () => cleanupAlive,
      killProcess: () => { cleanupAlive = false; },
      sleep: async () => { if (cleanupSleeps++ === 0) throw new Error("cleanup failed"); },
    });
    const cleanupScope = scopedFixture(cleanupRoot, "cleanup-failure");
    await expect(ensureDaemon(scopedOptions(cleanupScope.fixture, cleanupScope.scope, { _skipSpawn: false, _skipHealthWait: true, _abortSignal: cleanupController.signal }))).rejects.toThrow("cleanup failed");
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
    const result = await managedEnsure(f, managed.supervisor, {
      spawnTimeoutMs: 1,
      _monotonicNowOverride: () => 0,
    });
    expect(result.refusalReason).toBe("response-timeout");
    expect(calls).toHaveLength(1);
    const restartFixture = ownedFixture({
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => undefined),
      })) as never,
      isAlive: () => true,
    }, { token: undefined });
    const running = manager((spec) => managerObservation(spec, "registered-running-valid", { managerPid: 42 }));
    const restart = await managedRestart(restartFixture, running.supervisor, {
      _listeningPortsOverride: () => [restartFixture.port],
      spawnTimeoutMs: 1,
      _monotonicNowOverride: () => 0,
    });
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
    const unknownManager = startingManager(unknown);
    const unknownResult = await managedEnsure(unknown, unknownManager.supervisor, {
      _skipSpawn: false,
      _listeningPortsOverride: () => [unknown.port],
      _monotonicNowOverride: deadlineClock(),
    });
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
    const authManager = startingManager(auth);
    const authResult = await managedEnsure(auth, authManager.supervisor, {
      _skipSpawn: false,
      _monotonicNowOverride: deadlineClock(),
    });
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
    const raceManager = startingManager(race);
    const raceResult = await managedEnsure(race, raceManager.supervisor, {
      _skipSpawn: false,
      _listeningPortsOverride: () => (++listenerCalls < 2 ? [race.port] : []),
      _monotonicNowOverride: deadlineClock(),
    });
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
    const managed = startingManager(sf);
    const result = await ensureDaemon(scopedOptions(sf, scope, {
      enforceUserManagerParent: true,
      _supervisorOverride: managed.supervisor,
      _skipSpawn: false,
      _skipHealthWait: true,
      _monotonicNowOverride: deadlineClock(),
    }));
    expect(result.spawned).toBe(true);
    const retry = ownedFixture({ isAlive: () => true });
    let nowCalls = 0;
    await ensure(retry, {
      _skipSpawn: true,
      _supervisorOverride: unavailableManager(),
      _monotonicNowOverride: () => (++nowCalls < 4 ? 0 : 100),
    });
    const stateRace = ownedFixture({ isAlive: () => true });
    let listener = true;
    await ensure(stateRace, {
      _skipSpawn: true,
      _supervisorOverride: unavailableManager(),
      _listeningPortsOverride: () => listener ? [stateRace.port] : [],
      _fetchOverride: healthFetch([response({ status: "warming" })]),
      _killOverride: () => { listener = false; },
    });
  });
  it("covers detached combined warnings and test-scope owner mismatch", async () => {
    const child = failingChild();
    const f = fixture({
      spawn: vi.fn(() => child) as never,
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
    });
    await managedEnsure(f, unavailableManager(), {
      _skipSpawn: false,
      _skipHealthWait: true,
    });
    const scopedRoot = fixture({ fetch: healthFetch([health(42, { ownerId: "foreign" })]) , isAlive: () => true });
    const scoped = scopedFixture(scopedRoot, "owned");
    const scopedState = scoped.fixture;
    own(scopedState);
    const mismatch = restartDaemon(scopedOptions(scopedState, scoped.scope, {
      enforceUserManagerParent: false,
      _listeningPortsOverride: () => [scopedState.port],
    }));
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
    await restartDaemon(baseOptions(defaultFixture, {
      enforceUserManagerParent: true,
      spawnTimeoutMs: 0,
      _skipSpawn: true,
    }));
    const stale = ownedFixture({ isAlive: () => false }, { token: undefined });
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
