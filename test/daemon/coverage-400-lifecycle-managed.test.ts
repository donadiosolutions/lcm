import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
import { ensureAuthToken } from "../../src/daemon/auth.js";
import type { Supervisor, SupervisorObservation, SupervisorSpec } from "../../src/daemon/supervisor.js";
import {
  createDaemonLifecycleTestScope,
  type DaemonLifecycleHermeticTestSeams,
  type DaemonLifecycleTestDependencies,
  type DaemonLifecycleTestScope,
} from "../../src/daemon/lifecycle-scope.js";
import { RUNTIME_DIGEST } from "../../src/daemon/version.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Fixture = {
  root: string;
  stateDir: string;
  pidPath: string;
  tokenPath: string;
  port: number;
  seams: DaemonLifecycleHermeticTestSeams;
  supervisor: Supervisor;
  probe: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stopAndStart: ReturnType<typeof vi.fn>;
  stopAndAwaitAbsent: ReturnType<typeof vi.fn>;
  isAlive: ReturnType<typeof vi.fn>;
};

type ScopedFixture = Fixture & { scope: DaemonLifecycleTestScope };

type FixtureOptions = {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  spawnSync?: typeof import("node:child_process").spawnSync;
  realpath?: (path: string) => string;
  spawn?: typeof import("node:child_process").spawn;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => void;
};

function response(body: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status <= 299, status, json: async () => body };
}

function sequenceFetch(
  values: readonly (ReturnType<typeof response> | Error)[],
): typeof globalThis.fetch {
  let index = 0;
  return vi.fn(async () => {
    const value = values[Math.min(index++, values.length - 1)];
    if (value instanceof Error) throw value;
    return value!;
  }) as never;
}

function observation(
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

function healthy(
  pid: number,
  entrypoint = "/tmp/lcm-daemon-entrypoint.mjs",
  extra: Record<string, unknown> = {},
): ReturnType<typeof response> {
  return response({
    status: "ok",
    version: "1",
    storageBackend: "sqlite",
    runtimeDigest: RUNTIME_DIGEST,
    pid,
    entrypoint,
    ...extra,
  });
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "lcm-400-managed-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const runtimeDir = join(root, "runtime");
  const credentialDir = join(root, "credentials");
  const procRoot = join(root, "proc");
  for (const path of [stateDir, runtimeDir, credentialDir, procRoot]) mkdirSync(path, { recursive: true });
  chmodSync(stateDir, 0o700);
  chmodSync(credentialDir, 0o700);
  const pidPath = join(stateDir, "daemon.pid");
  const tokenPath = join(stateDir, "daemon.token");
  const port = 43_201;
  const probe = vi.fn(async (spec: SupervisorSpec) => observation(spec, "absent"));
  const start = vi.fn(async (spec: SupervisorSpec) => {
    writeFileSync(pidPath, "4242");
    return {
      kind: spec.kind,
      name: spec.name,
      scopeDigest: spec.scopeDigest,
      port: spec.port,
      nonce: spec.nonce,
      managerPid: 4242,
    };
  });
  const stopAndStart = vi.fn(start);
  const stopAndAwaitAbsent = vi.fn(async () => undefined);
  const isAlive = vi.fn(options.isAlive ?? (() => false));
  const seams: DaemonLifecycleHermeticTestSeams = {
    homeDir: root,
    runtimeDir,
    stateDir,
    credentialDir,
    procRoot,
    platform: options.platform ?? "linux",
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    environment: options.environment ?? {},
    fetch: options.fetch ?? (vi.fn(async () => response({}, 200)) as never),
    spawn: options.spawn ?? (vi.fn(() => ({ pid: undefined, once: vi.fn().mockReturnThis(), unref: vi.fn() })) as never),
    spawnSync: options.spawnSync ?? (vi.fn(() => ({ status: 1, stdout: "", stderr: "" })) as never),
    stopUnit: vi.fn(),
    killProcess: options.killProcess ?? vi.fn(),
    isProcessAlive: isAlive,
    sleep: options.sleep ?? (async () => undefined),
    realpath: options.realpath ?? ((path: string) => path),
  };
  return {
    root,
    stateDir,
    pidPath,
    tokenPath,
    port,
    seams,
    supervisor: { probe, start, stopAndStart, stopAndAwaitAbsent },
    probe,
    start,
    stopAndStart,
    stopAndAwaitAbsent,
    isAlive,
  };
}

function createScopedFixture(
  options: FixtureOptions = {},
): ScopedFixture {
  const fixture = createFixture(options);
  const homeDir = join(fixture.root, "scope-home");
  const runtimeDir = join(homeDir, "runtime");
  const stateDir = join(homeDir, ".lcm");
  const credentialDir = join(homeDir, "credentials");
  const entrypoint = join(runtimeDir, "owned-daemon.mjs");
  for (const path of [runtimeDir, stateDir, credentialDir]) mkdirSync(path, { recursive: true });
  chmodSync(stateDir, 0o700);
  chmodSync(credentialDir, 0o700);
  writeFileSync(entrypoint, "setTimeout(() => {}, 60_000);\n");
  const dependencies: DaemonLifecycleTestDependencies = {
    fetch: options.fetch ?? fixture.seams.fetch,
    spawn: options.spawn ?? fixture.seams.spawn,
    spawnSync: options.spawnSync ?? fixture.seams.spawnSync,
    stopUnit: fixture.seams.stopUnit,
    killProcess: options.killProcess ?? fixture.seams.killProcess,
    isProcessAlive: fixture.isAlive,
    sleep: options.sleep ?? fixture.seams.sleep,
  };
  const scope = createDaemonLifecycleTestScope({
    ownerId: "managed-coverage",
    homeDir,
    runtimeDir,
    stateDir,
    credentialDir,
    entrypoint,
    dependencies,
  });
  return {
    ...fixture,
    pidPath: join(stateDir, "daemon.pid"),
    tokenPath: join(stateDir, "daemon.token"),
    scope,
  };
}

function optionsFor(
  fixture: Fixture,
  extra: Partial<EnsureDaemonOptions> = {},
): EnsureDaemonOptions {
  return {
    port: fixture.port,
    pidFilePath: fixture.pidPath,
    spawnTimeoutMs: 100,
    expectedVersion: "1",
    expectedEntrypoint: "/tmp/lcm-daemon-entrypoint.mjs",
    expectedRuntimeDigest: RUNTIME_DIGEST,
    enforceUserManagerParent: true,
    _platform: fixture.seams.platform,
    _hermeticTestSeams: fixture.seams,
    _supervisorOverride: fixture.supervisor,
    _monotonicNowOverride: () => 0,
    _listeningPortsOverride: () => [fixture.port],
    ...extra,
  };
}

function setRunningProbe(fixture: Fixture, pid = 4242): void {
  fixture.probe.mockImplementation(async (spec: SupervisorSpec) => observation(
    spec,
    "registered-running-valid",
    { managerPid: pid },
  ));
  writeFileSync(fixture.pidPath, String(pid));
}

describe("issue 400 lifecycle managed preparation and utility boundaries", () => {
  it("classifies manager platforms, process diagnostics, and malformed command runners", async () => {
    const fixture = createFixture({ platform: "freebsd" });
    await expect(ensureDaemon(optionsFor(fixture, { _skipSpawn: true }))).resolves.toMatchObject({
      connected: false,
      spawned: false,
    });
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: "malformed", stdout: null, stderr: null })
      .mockImplementationOnce(() => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); })
      .mockImplementationOnce(() => { throw Object.assign(new Error("no executable"), { code: "ENOENT" }); });
    const dependencies = __lifecycleTestUtils.resolveLifecycleDependencies({
      port: 1,
      pidFilePath: fixture.pidPath,
      spawnTimeoutMs: 1,
      _spawnSyncOverride: spawnSync as never,
      _managerTransportEnvironmentOverride: {},
    });
    const runner = __lifecycleTestUtils.supervisorCommandRunner(dependencies, {
      port: 1,
      pidFilePath: fixture.pidPath,
      spawnTimeoutMs: 1,
    });
    expect(runner("systemctl", [], { timeoutMs: 1 })).toMatchObject({ code: null, stdout: "", stderr: "" });
    expect(runner("systemctl", [], { timeoutMs: 1 })).toMatchObject({ code: null, timedOut: true });
    expect(runner("systemctl", [], { timeoutMs: 1 })).toMatchObject({ code: 127, stderr: "ENOENT" });

    const diagnostic = __lifecycleTestUtils.supervisorCommandRunner(
      __lifecycleTestUtils.resolveLifecycleDependencies({
        port: 1,
        pidFilePath: fixture.pidPath,
        spawnTimeoutMs: 1,
        _spawnSyncOverride: vi.fn(() => ({ status: 1, stdout: "", stderr: "EACCES" })) as never,
      }),
      { port: 1, pidFilePath: fixture.pidPath, spawnTimeoutMs: 1 },
    );
    expect(diagnostic("systemctl", [], { timeoutMs: 1 })).toMatchObject({ code: 1 });
    expect(__lifecycleTestUtils.lifecycleUnitName(
      { port: 1, pidFilePath: fixture.pidPath, spawnTimeoutMs: 1, _platform: "freebsd", enforceUserManagerParent: true },
      42,
      7,
    )).toBe("lcm-daemon-42-7");
  });

  it("handles credential staging write failures and cleanup validation failures", async () => {
    const fixture = createFixture({
      environment: { OPENAI_API_KEY: "x".repeat(1_048_577) },
      fetch: sequenceFetch([new Error("offline")]),
    });
    fixture.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    fixture.start.mockImplementationOnce(async (spec: SupervisorSpec) => ({
      kind: spec.kind,
      name: spec.name,
      scopeDigest: spec.scopeDigest,
      port: spec.port,
      nonce: spec.nonce,
      managerPid: 4242,
    }));
    await expect(ensureDaemon(optionsFor(fixture, { _skipHealthWait: true }))).resolves.toMatchObject({
      connected: false,
      spawned: false,
      refusalReason: "startup-failure",
    });
    expect(fixture.start).not.toHaveBeenCalled();

    const cleanupFixture = createFixture({
      environment: { OPENAI_API_KEY: "secret" },
      fetch: sequenceFetch([new Error("offline")]),
    });
    cleanupFixture.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "ambiguous", { reason: "state-conflict" }));
    await expect(ensureDaemon(optionsFor(cleanupFixture, { _skipHealthWait: true }))).resolves.toMatchObject({
      connected: false,
      refusalReason: "ambiguous",
    });
    expect(cleanupFixture.stopAndAwaitAbsent).not.toHaveBeenCalled();
  });

  it("covers scoped token errors and safe manager transport filtering", async () => {
    const fixture = createFixture();
    const invalidToken = join(fixture.stateDir, "daemon.token");
    mkdirSync(invalidToken);
    await expect(ensureDaemon(optionsFor(fixture, { _skipSpawn: true }))).resolves.toMatchObject({
      connected: false,
    });

    const transportRoot = mkdtempSync(join(tmpdir(), "lcm-400-transport-"));
    roots.push(transportRoot);
    const validRuntime = join(transportRoot, "runtime");
    mkdirSync(validRuntime, { recursive: true });
    const fileRuntime = join(transportRoot, "runtime-file");
    writeFileSync(fileRuntime, "not-a-directory");
    const opts: EnsureDaemonOptions = {
      port: 1,
      pidFilePath: join(transportRoot, "daemon.pid"),
      spawnTimeoutMs: 1,
      _managerTransportEnvironmentOverride: {
        XDG_RUNTIME_DIR: join(transportRoot, "missing-runtime"),
        DBUS_SESSION_BUS_ADDRESS: "http://unsafe",
        PATH: "/usr/bin",
      },
    };
    expect(__lifecycleTestUtils.managerTransportEnvironment(
      opts,
      __lifecycleTestUtils.resolveLifecycleDependencies(opts),
    )).toEqual({ PATH: "/usr/bin" });
    expect(__lifecycleTestUtils.managerTransportEnvironment(
      {
        ...opts,
        _managerTransportEnvironmentOverride: { XDG_RUNTIME_DIR: fileRuntime },
      },
      __lifecycleTestUtils.resolveLifecycleDependencies(opts),
    )).toEqual({});
    expect(__lifecycleTestUtils.managerTransportEnvironment(
      {
        ...opts,
        _managerTransportEnvironmentOverride: {
          XDG_RUNTIME_DIR: validRuntime,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
          LC_ALL: "C",
        },
      },
      __lifecycleTestUtils.resolveLifecycleDependencies(opts),
    )).toEqual({
      XDG_RUNTIME_DIR: validRuntime,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      LC_ALL: "C",
    });
  });

  it("fails closed when an owned token becomes a directory during authentication", async () => {
    const fixture = createScopedFixture();
    writeFileSync(fixture.pidPath, "4242");
    writeFileSync(fixture.tokenPath, "initial-token", { mode: 0o600 });
    const fetch = vi.fn(async () => {
      return response({
        status: "ok",
        version: "1",
        storageBackend: "sqlite",
        runtimeDigest: RUNTIME_DIGEST,
        pid: 4242,
        ownerId: fixture.scope.ownerId,
        entrypoint: fixture.scope.entrypoint,
      });
    });
    const scope = createDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: { ...fixture.scope.dependencies, fetch: fetch as never, isProcessAlive: () => true },
    });
    const supervisor: Supervisor = {
      probe: vi.fn(async (spec: SupervisorSpec) => observation(spec, "absent")),
      start: vi.fn(),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(),
    } as never;
    await expect(ensureDaemon({
      port: fixture.port,
      pidFilePath: fixture.pidPath,
      spawnTimeoutMs: 100,
      expectedVersion: "1",
      expectedEntrypoint: scope.entrypoint,
      expectedRuntimeDigest: RUNTIME_DIGEST,
      enforceUserManagerParent: false,
      _platform: "linux",
      _testScope: scope,
      _supervisorOverride: supervisor,
      _listeningPortsOverride: () => {
        rmSync(fixture.tokenPath, { force: true });
        mkdirSync(fixture.tokenPath);
        return [fixture.port];
      },
      _isProcessAliveOverride: () => true,
      _skipSpawn: true,
    })).rejects.toThrow("unsafe daemon lifecycle token read");
  });

  it("exercises the scoped ensure-token error after an entrypoint state race", async () => {
    const fixture = createScopedFixture({ fetch: sequenceFetch([new Error("offline")]) });
    const spawnArgs = [fixture.scope.entrypoint];
    Object.defineProperty(spawnArgs, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        mkdirSync(fixture.tokenPath);
        return fixture.scope.entrypoint;
      },
    });
    await expect(ensureDaemon({
      port: fixture.port,
      pidFilePath: fixture.pidPath,
      spawnTimeoutMs: 100,
      expectedVersion: "1",
      expectedEntrypoint: fixture.scope.entrypoint,
      enforceUserManagerParent: false,
      _platform: "linux",
      _testScope: fixture.scope,
      spawnArgs,
      _skipHealthWait: true,
    })).rejects.toThrow("unsafe daemon lifecycle token access");
  });
});

describe("issue 400 managed ensure admission matrix", () => {
  it.each([
    ["manager timeout", "manager-timeout", "manager-unavailable"],
    ["stale configuration", "registered-stale-config", "stale-config"],
    ["invalid collision", "registered-invalid-collision", "invalid-collision"],
    ["ambiguous state", "ambiguous", "ambiguous"],
  ] as const)("refuses %s without detached fallback", async (_name, kind, refusalReason) => {
    const fixture = createFixture();
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => kind === "manager-timeout"
      ? observation(spec, "unavailable", { reason: "manager-timeout" })
      : observation(spec, kind));
    await expect(ensureDaemon(optionsFor(fixture))).resolves.toMatchObject({
      connected: false,
      spawned: false,
      refusalReason,
    });
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.seams.spawn).not.toHaveBeenCalled();
  });

  it("allows only initial manager-not-found compatibility and then blocks fallback", async () => {
    const fixture = createFixture();
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "unavailable", { reason: "manager-not-found" }));
    await expect(ensureDaemon(optionsFor(fixture, { _suppressDetachedFallback: true }))).resolves.toMatchObject({
      connected: false,
      refusalReason: "manager-unavailable",
    });
  });

  it("handles registered not-running jobs, live PID collisions, and explicit starts", async () => {
    const live = createFixture({ isAlive: () => true });
    writeFileSync(live.pidPath, "4242");
    live.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-not-running-valid", { terminal: "failed" }));
    await expect(ensureDaemon(optionsFor(live))).resolves.toMatchObject({
      refusalReason: "not-running",
    });

    const skipped = createFixture({ isAlive: () => false });
    skipped.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-not-running-valid", { terminal: "inactive" }));
    await expect(ensureDaemon(optionsFor(skipped, { _skipSpawn: true }))).resolves.toMatchObject({
      refusalReason: "not-running",
    });

    const started = createFixture({ isAlive: () => false });
    started.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-not-running-valid", { terminal: "inactive" }))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    await expect(ensureDaemon(optionsFor(started, { _skipHealthWait: true }))).resolves.toMatchObject({
      connected: false,
      spawned: true,
      startMethod: "systemd-user",
      pid: 4242,
    });
    expect(started.start).toHaveBeenCalledOnce();
  });

  it("handles absent collision observations and no-spawn decisions", async () => {
    const responseCollision = createFixture({
      fetch: sequenceFetch([healthy(4242)]),
    });
    responseCollision.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "absent"));
    await expect(ensureDaemon(optionsFor(responseCollision))).resolves.toMatchObject({
      refusalReason: "invalid-collision",
    });

    const timeoutCollision = createFixture({
      fetch: sequenceFetch([new Error("header timeout")]),
    });
    timeoutCollision.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "absent"));
    await expect(ensureDaemon(optionsFor(timeoutCollision, { _skipSpawn: true }))).resolves.toMatchObject({
      refusalReason: "absent",
    });

    const stalePid = createFixture({ isAlive: () => true });
    writeFileSync(stalePid.pidPath, "4242");
    stalePid.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "absent"));
    await expect(ensureDaemon(optionsFor(stalePid, { _skipSpawn: true }))).resolves.toMatchObject({
      refusalReason: "invalid-collision",
    });

    const expired = createFixture({ fetch: sequenceFetch([new Error("offline")]) });
    expired.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "absent"));
    await expect(ensureDaemon(optionsFor(expired, {
      spawnTimeoutMs: 0,
      _monotonicNowOverride: () => 0,
    }))).resolves.toMatchObject({ refusalReason: "absent" });
  });

  it("returns interrupted results after managed probe and before managed start", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => {
      controller.abort();
      return observation(spec, "absent");
    });
    await expect(ensureDaemon(optionsFor(fixture, { _abortSignal: controller.signal }))).resolves.toMatchObject({
      connected: false,
      spawned: false,
      warning: "daemon lifecycle was interrupted before startup",
    });
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("admits a registered running manager after endpoint and token authentication", async () => {
    const fixture = createFixture({
      fetch: sequenceFetch([
        healthy(4242),
        healthy(4242),
        response({}, 200),
      ]),
      isAlive: () => true,
    });
    setRunningProbe(fixture);
    writeFileSync(fixture.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(fixture))).resolves.toMatchObject({
      connected: true,
      spawned: false,
      startMethod: "systemd-user",
      pid: 4242,
    });
  });

  it("refuses running managers on no response, probe races, invalid responses, or failed auth", async () => {
    const noResponse = createFixture({ fetch: sequenceFetch([new Error("offline")]), isAlive: () => true });
    setRunningProbe(noResponse);
    noResponse.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }))
      .mockRejectedValueOnce(new Error("probe race"));
    await expect(ensureDaemon(optionsFor(noResponse))).resolves.toMatchObject({ refusalReason: "ambiguous" });

    const changed = createFixture({ fetch: sequenceFetch([new Error("offline")]), isAlive: () => true });
    setRunningProbe(changed);
    changed.probe.mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 9999 }));
    await expect(ensureDaemon(optionsFor(changed))).resolves.toMatchObject({ refusalReason: "ambiguous" });

    const invalid = createFixture({ fetch: sequenceFetch([response("broken")]), isAlive: () => true });
    setRunningProbe(invalid);
    await expect(ensureDaemon(optionsFor(invalid))).resolves.toMatchObject({ refusalReason: "response-invalid" });

    const unauthenticated = createFixture({
      fetch: sequenceFetch([healthy(4242), healthy(4242), response({}, 403)]),
      isAlive: () => true,
    });
    setRunningProbe(unauthenticated);
    writeFileSync(unauthenticated.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(unauthenticated))).resolves.toMatchObject({ refusalReason: "response-auth-failure" });
  });

  it("refuses running managers when re-probe or identity admission fails", async () => {
    const reprobe = createFixture({ fetch: sequenceFetch([healthy(4242)]), isAlive: () => true });
    setRunningProbe(reprobe);
    reprobe.probe.mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }))
      .mockRejectedValueOnce(new Error("reprobe failed"));
    await expect(ensureDaemon(optionsFor(reprobe))).resolves.toMatchObject({ refusalReason: "ambiguous" });

    const foreign = createFixture({ fetch: sequenceFetch([healthy(4242)]), isAlive: () => true });
    setRunningProbe(foreign);
    foreign.probe.mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242, scopeDigest: "foreign" }));
    await expect(ensureDaemon(optionsFor(foreign))).resolves.toMatchObject({ refusalReason: "invalid-collision" });

    const unknownStorage = createFixture({ fetch: sequenceFetch([healthy(4242, "/tmp/lcm-daemon-entrypoint.mjs", { storageBackend: "unknown" })]), isAlive: () => true });
    setRunningProbe(unknownStorage);
    await expect(ensureDaemon(optionsFor(unknownStorage))).resolves.toMatchObject({ refusalReason: "response-invalid" });
  });

  it("rejects manager endpoint metadata and owner identity mismatches", async () => {
    const metadata = createFixture({ fetch: sequenceFetch([healthy(4242)]), isAlive: () => true });
    setRunningProbe(metadata);
    metadata.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-not-running-valid", { terminal: "inactive" }));
    await expect(ensureDaemon(optionsFor(metadata))).resolves.toMatchObject({ refusalReason: "invalid-collision" });

    const endpoint = createFixture({ fetch: sequenceFetch([healthy(9999)]), isAlive: () => true });
    setRunningProbe(endpoint);
    await expect(ensureDaemon(optionsFor(endpoint))).resolves.toMatchObject({ refusalReason: "invalid-collision" });

    const noListener = createFixture({ fetch: sequenceFetch([healthy(4242)]), isAlive: () => true });
    setRunningProbe(noListener);
    await expect(ensureDaemon(optionsFor(noListener, {
      _listeningPortsOverride: () => [],
    }))).resolves.toMatchObject({ refusalReason: "invalid-collision" });

    const dynamic = createFixture({ fetch: sequenceFetch([healthy(4242)]), isAlive: () => true });
    writeFileSync(dynamic.pidPath, "4242");
    let dynamicProbeCalls = 0;
    dynamic.probe.mockImplementation(async (spec: SupervisorSpec) => {
      dynamicProbeCalls += 1;
      if (dynamicProbeCalls === 1) return observation(spec, "registered-running-valid", { managerPid: 4242 });
      let scopeReads = 0;
      return {
        kind: "registered-running-valid",
        managerPid: 4242,
        name: spec.name,
        get scopeDigest() {
          scopeReads += 1;
          return scopeReads === 1 ? spec.scopeDigest : "foreign-scope";
        },
        nonce: spec.nonce,
      } as SupervisorObservation;
    });
    await expect(ensureDaemon(optionsFor(dynamic))).resolves.toMatchObject({ refusalReason: "invalid-collision" });

    const ownerFixture = createScopedFixture({ fetch: sequenceFetch([
      healthy(4242, "/tmp/lcm-daemon-entrypoint.mjs", { ownerId: "foreign-owner" }),
      healthy(4242, "/tmp/lcm-daemon-entrypoint.mjs", { ownerId: "foreign-owner" }),
      response({}, 200),
    ]) });
    writeFileSync(ownerFixture.pidPath, "4242");
    writeFileSync(ownerFixture.tokenPath, "owner-token", { mode: 0o600 });
    ownerFixture.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    const ownerOptions: EnsureDaemonOptions = {
      port: ownerFixture.port,
      pidFilePath: ownerFixture.pidPath,
      spawnTimeoutMs: 100,
      expectedVersion: "1",
      expectedEntrypoint: ownerFixture.scope.entrypoint,
      expectedRuntimeDigest: RUNTIME_DIGEST,
      enforceUserManagerParent: false,
      _platform: "linux",
      _testScope: ownerFixture.scope,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [ownerFixture.port],
      _skipSpawn: true,
    };
    await expect(ensureDaemon(ownerOptions)).resolves.toMatchObject({ connected: false, spawned: false });
  });
});

describe("issue 400 managed start, cleanup, deadline, and process seams", () => {
  it("covers manager start exceptions, re-probe failures, identity races, and skip-health results", async () => {
    const startFailure = createFixture({ fetch: sequenceFetch([new Error("offline")]) });
    startFailure.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "absent"));
    startFailure.start.mockRejectedValueOnce(new Error("manager start failed"));
    await expect(ensureDaemon(optionsFor(startFailure))).resolves.toMatchObject({ refusalReason: "startup-failure" });

    const reprobeFailure = createFixture({ fetch: sequenceFetch([new Error("offline")]) });
    reprobeFailure.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockRejectedValueOnce(new Error("post-start probe failed"));
    await expect(ensureDaemon(optionsFor(reprobeFailure))).resolves.toMatchObject({ refusalReason: "startup-failure", spawned: true });

    const identityRace = createFixture({ fetch: sequenceFetch([new Error("offline")]) });
    identityRace.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 9999 }));
    await expect(ensureDaemon(optionsFor(identityRace))).resolves.toMatchObject({ refusalReason: "ambiguous", spawned: true });

    const skipped = createFixture({ fetch: sequenceFetch([new Error("offline")]) });
    skipped.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    await expect(ensureDaemon(optionsFor(skipped, { _skipHealthWait: true }))).resolves.toMatchObject({
      connected: false,
      spawned: true,
      pid: 4242,
      startMethod: "systemd-user",
    });
  });

  it("covers managed startup abort and health admission retry/timeout", async () => {
    const controller = new AbortController();
    const aborted = createFixture({ fetch: sequenceFetch([new Error("offline")]) });
    aborted.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementationOnce(async (spec: SupervisorSpec) => {
        controller.abort();
        return observation(spec, "registered-running-valid", { managerPid: 4242 });
      });
    await expect(ensureDaemon(optionsFor(aborted, { _abortSignal: controller.signal }))).resolves.toMatchObject({
      connected: false,
      spawned: true,
      warning: "daemon lifecycle was interrupted",
    });

    let now = 0;
    const timeout = createFixture({
      fetch: sequenceFetch([new Error("offline"), response({ status: "wrong" }), new Error("offline")]),
      sleep: async () => { now = 1_000; },
    });
    timeout.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    await expect(ensureDaemon(optionsFor(timeout, {
      _skipHealthWait: false,
      _monotonicNowOverride: () => now,
    }))).resolves.toMatchObject({ refusalReason: "startup-failure", spawned: true });
  });

  it("preserves staged credentials when owned manager absence cleanup is refused", async () => {
    let now = 0;
    let staged: SupervisorSpec | undefined;
    const fixture = createFixture({
      environment: { OPENAI_API_KEY: "staged-secret" },
      fetch: sequenceFetch([new Error("offline")]),
      sleep: async () => { now = 1_000; },
    });
    fixture.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    fixture.start.mockImplementationOnce(async (spec: SupervisorSpec) => {
      staged = spec;
      writeFileSync(fixture.pidPath, "4242");
      return {
        kind: spec.kind,
        name: spec.name,
        scopeDigest: spec.scopeDigest,
        port: spec.port,
        nonce: spec.nonce,
        managerPid: 4242,
      };
    });
    const cleanupRefusal = new Error("manager absence refused");
    fixture.stopAndAwaitAbsent.mockRejectedValueOnce(cleanupRefusal);

    await expect(ensureDaemon(optionsFor(fixture, {
      _skipHealthWait: false,
      _monotonicNowOverride: () => now,
    }))).rejects.toBe(cleanupRefusal);

    expect(fixture.stopAndAwaitAbsent).toHaveBeenCalledOnce();
    expect(staged?.credentialDirectory).toBeDefined();
    const credentialDirectory = staged!.credentialDirectory!;
    const credentialFile = join(credentialDirectory, "OPENAI_API_KEY");
    expect(fixture.stopAndAwaitAbsent).toHaveBeenCalledWith(expect.objectContaining({
      credentialDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
    }));
    expect(existsSync(credentialDirectory)).toBe(true);
    expect(readdirSync(credentialDirectory)).toEqual(["OPENAI_API_KEY"]);
    expect(readFileSync(credentialFile, "utf8")).toBe("staged-secret");
    expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
  });

  it("covers deadline abort/timeout callbacks and platform process-command paths", async () => {
    const timeoutHandle = { id: "timeout" } as never;
    let timeoutCallback: (() => void) | undefined;
    const clearTimeoutFn = vi.fn();
    const setTimeoutFn = vi.fn((callback: () => void) => {
      timeoutCallback = callback;
      return timeoutHandle;
    });
    const abortingFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        timeoutCallback?.();
      });
      return response({ status: "ok" });
    });
    const fixture = createFixture({ fetch: abortingFetch as never });
    await expect(ensureDaemon(optionsFor(fixture, {
      _platform: "freebsd",
      enforceUserManagerParent: false,
      _skipSpawn: true,
      _setTimeoutOverride: setTimeoutFn,
      _clearTimeoutOverride: clearTimeoutFn,
    }))).resolves.toMatchObject({ connected: false });
    expect(clearTimeoutFn).toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    const abortedFixture = createFixture({ fetch: vi.fn(async (_url: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted?.();
      return response({ status: "ok" });
    }) as never });
    await expect(ensureDaemon(optionsFor(abortedFixture, {
      enforceUserManagerParent: false,
      _abortSignal: controller.signal,
    }))).resolves.toMatchObject({ connected: false });

    const darwin = createFixture({ platform: "darwin" });
    const darwinRunner = vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground", stderr: "" }));
    expect(__lifecycleTestUtils.resolveLifecycleDependencies({
      port: 1,
      pidFilePath: darwin.pidPath,
      spawnTimeoutMs: 1,
      _platform: "darwin",
      _spawnSyncOverride: darwinRunner as never,
    })).toBeDefined();
    const winRunner = vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground", stderr: "" }));
    await expect(ensureDaemon(optionsFor(darwin, {
      enforceUserManagerParent: false,
      _skipSpawn: true,
      _platform: "darwin",
      _spawnSyncOverride: winRunner as never,
    }))).resolves.toMatchObject({ connected: false });
    expect(__lifecycleTestUtils.resolveLifecycleDependencies({
      port: 1,
      pidFilePath: darwin.pidPath,
      spawnTimeoutMs: 1,
      _platform: "win32",
      _windowsPowerShellPathOverride: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    } as EnsureDaemonOptions)).toBeDefined();
  });

  it("preserves busy owned daemons and blocks authenticated termination races", async () => {
    const busy = createFixture({
      fetch: sequenceFetch([new Error("offline")]),
      isAlive: () => true,
    });
    writeFileSync(busy.pidPath, "4242");
    await expect(ensureDaemon(optionsFor(busy, {
      enforceUserManagerParent: false,
      _skipSpawn: true,
    }))).resolves.toMatchObject({
      connected: false,
      refusalReason: "detached-no-response",
      pid: 4242,
    });

    const mismatch = createFixture({
      fetch: sequenceFetch([healthy(4242, "/tmp/lcm-daemon-entrypoint.mjs", { version: "2" })]),
      isAlive: () => true,
    });
    writeFileSync(mismatch.pidPath, "4242");
    await expect(ensureDaemon(optionsFor(mismatch, {
      enforceUserManagerParent: false,
      expectedVersion: "1",
      _skipSpawn: true,
      _listeningPortsOverride: () => [mismatch.port],
    }))).resolves.toMatchObject({ connected: false });
  });

  it("admits a successful managed start after health, storage, and access checks", async () => {
    const fixture = createFixture({ isAlive: () => true, fetch: sequenceFetch([
      new Error("pre-start offline"),
      healthy(4242),
      healthy(4242),
      response({}, 200),
    ]) });
    fixture.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    writeFileSync(fixture.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(fixture))).resolves.toMatchObject({
      connected: true,
      spawned: true,
      pid: 4242,
      startMethod: "systemd-user",
    });
  });

  it("bounds authenticated diagnostics on timeout and caller abort", async () => {
    const timed = createFixture({
      isAlive: () => true,
      fetch: sequenceFetch([healthy(4242), healthy(4242), response({}, 200)]),
    });
    setRunningProbe(timed);
    writeFileSync(timed.tokenPath, "timed-token", { mode: 0o600 });
    let timerCalls = 0;
    const setTimeoutFn = vi.fn((callback: () => void) => {
      timerCalls += 1;
      if (timerCalls === 5) callback();
      return {} as ReturnType<typeof setTimeout>;
    });
    await expect(ensureDaemon(optionsFor(timed, {
      _setTimeoutOverride: setTimeoutFn,
      _clearTimeoutOverride: vi.fn(),
    }))).resolves.toMatchObject({ connected: false, refusalReason: "response-auth-failure" });

    const controller = new AbortController();
    const aborted = createFixture({
      isAlive: () => true,
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/stats/pool")) {
          controller.abort();
          return await new Promise<never>(() => undefined);
        }
        return healthy(4242);
      }) as never,
    });
    setRunningProbe(aborted);
    writeFileSync(aborted.tokenPath, "abort-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(aborted, { _abortSignal: controller.signal }))).resolves.toMatchObject({
      connected: false,
      refusalReason: "response-auth-failure",
    });

    const preAborted = createFixture({
      isAlive: () => true,
      fetch: sequenceFetch([healthy(4242), healthy(4242), response({}, 200)]),
    });
    setRunningProbe(preAborted);
    writeFileSync(preAborted.tokenPath, "pre-abort-token", { mode: 0o600 });
    const preAbortSignal = {
      get aborted(): boolean {
        return (new Error().stack ?? "").includes("runWithDeadline");
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    await expect(ensureDaemon(optionsFor(preAborted, { _abortSignal: preAbortSignal }))).resolves.toMatchObject({
      connected: false,
      refusalReason: "response-auth-failure",
    });
  });

  it("refuses construction failures and probe exceptions, including authorized cleanup no-ops", async () => {
    const badExecutable = createFixture();
    await expect(ensureDaemon(optionsFor(badExecutable, {
      spawnCommand: "relative-node",
      _managedOperationAuthorized: true,
    }))).resolves.toMatchObject({ refusalReason: "ambiguous" });

    const badCanonical = createFixture({ realpath: () => { throw new Error("canonicalization failed"); } });
    await expect(ensureDaemon(optionsFor(badCanonical))).resolves.toMatchObject({ refusalReason: "ambiguous" });

    const badSpec = createFixture();
    await expect(ensureDaemon(optionsFor(badSpec, {
      expectedRuntimeDigest: "invalid",
    }))).resolves.toMatchObject({ refusalReason: "ambiguous" });

    const probeFailure = createFixture();
    probeFailure.probe.mockRejectedValueOnce(new Error("probe failed"));
    await expect(ensureDaemon(optionsFor(probeFailure))).resolves.toMatchObject({ refusalReason: "ambiguous" });

    const cleanupNoop = createFixture();
    cleanupNoop.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-stale-config", { reason: "metadata-mismatch" }));
    await expect(ensureDaemon(optionsFor(cleanupNoop, {
      _managedOperationAuthorized: true,
      _skipHealthWait: true,
    }))).resolves.toMatchObject({ refusalReason: "stale-config" });
  });

  it("covers expired managed health deadlines and an early startup abort seam", async () => {
    const expired = createFixture();
    expired.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    await expect(ensureDaemon(optionsFor(expired, {
      spawnTimeoutMs: 0,
      _monotonicNowOverride: () => 1,
    }))).resolves.toMatchObject({ refusalReason: "startup-failure" });

    let reads = 0;
    const abortSignal = {
      get aborted(): boolean {
        reads += 1;
        return reads >= 3;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const earlyAbort = createFixture({ fetch: sequenceFetch([new Error("offline")]) });
    earlyAbort.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "absent"));
    await expect(ensureDaemon(optionsFor(earlyAbort, {
      _abortSignal: abortSignal,
    }))).resolves.toMatchObject({ warning: "daemon lifecycle was interrupted before startup" });
  });

  it("rejects an exact no-live-PID proof when the PID leaf changes between reads", async () => {
    const fixture = createFixture({ fetch: sequenceFetch([new Error("offline")]) });
    writeFileSync(fixture.pidPath, "4242");
    let firstRead = true;
    const isAlive = vi.fn(() => {
      if (firstRead) {
        firstRead = false;
        writeFileSync(fixture.pidPath, "4343");
      }
      return false;
    });
    fixture.isAlive.mockImplementation(isAlive);
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "absent"));
    await expect(ensureDaemon(optionsFor(fixture))).resolves.toMatchObject({
      refusalReason: "invalid-collision",
      spawned: false,
    });
  });

  it("observes an interruption exactly at managed-start admission", async () => {
    const fixture = createFixture({ fetch: sequenceFetch([new Error("offline")]) });
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "absent"));
    const abortSignal = {
      get aborted(): boolean {
        return (new Error().stack ?? "").includes("startManagedDaemon");
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    await expect(ensureDaemon(optionsFor(fixture, { _abortSignal: abortSignal }))).resolves.toMatchObject({
      connected: false,
      spawned: false,
      warning: "daemon lifecycle was interrupted before startup",
    });
  });

  it("preserves busy PID state and revalidates listeners before returning it", async () => {
    const fixture = createFixture({
      platform: "linux",
      isAlive: () => true,
      fetch: sequenceFetch([response({ status: "not-ok" }), new Error("retry offline")]),
    });
    writeFileSync(fixture.pidPath, "4242");
    mkdirSync(join(fixture.seams.procRoot, "4242"), { recursive: true });
    writeFileSync(join(fixture.seams.procRoot, "4242", "cmdline"), "node\0lcm\0daemon\0start\0");
    const busyResult = await ensureDaemon(optionsFor(fixture, {
      enforceUserManagerParent: false,
      _skipSpawn: true,
    }));
    expect(busyResult).toMatchObject({ pid: 4242, spawned: false });

    const revalidated = createFixture({
      platform: "linux",
      isAlive: () => true,
      fetch: sequenceFetch([response({ status: "not-ok" }), new Error("retry offline")]),
    });
    writeFileSync(revalidated.pidPath, "4242");
    mkdirSync(join(revalidated.seams.procRoot, "4242"), { recursive: true });
    writeFileSync(join(revalidated.seams.procRoot, "4242", "cmdline"), "node\0lcm\0daemon\0start\0");
    let listenerCalls = 0;
    await expect(ensureDaemon(optionsFor(revalidated, {
      enforceUserManagerParent: false,
      _skipSpawn: true,
      _listeningPortsOverride: () => (++listenerCalls === 1 ? [revalidated.port] : []),
    }))).resolves.toMatchObject({ connected: false, spawned: false });
  });
});

describe("issue 400 lifecycle platform and diagnostic edge seams", () => {
  it("uses Darwin, Windows, unavailable, and throwing process command probes", async () => {
    const runRestart = async (
      platform: NodeJS.Platform,
      powerShell: string | null | undefined,
      runner: typeof import("node:child_process").spawnSync,
    ): Promise<unknown> => {
      let alive = true;
      const fetch = sequenceFetch([
        healthy(4242),
        healthy(4242),
        response({}, 200),
        healthy(4242),
        healthy(4242),
        response({}, 200),
      ]);
      const fixture = createFixture({
        platform,
        spawnSync: runner,
        fetch,
        isAlive: () => alive,
        killProcess: () => { alive = false; },
      });
      writeFileSync(fixture.pidPath, "4242");
      ensureAuthToken(fixture.tokenPath);
      return restartDaemon({
        ...optionsFor(fixture, {
        enforceUserManagerParent: false,
        _platform: platform,
        _windowsPowerShellPathOverride: powerShell,
        _ensureDaemonOverride: async () => ({ connected: false, port: fixture.port, spawned: true }),
        }),
      });
    };
    const darwin = createFixture({ platform: "darwin", spawnSync: vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground", stderr: "" })) as never });
    expect(darwin.seams.platform).toBe("darwin");
    await runRestart("darwin", undefined, darwin.seams.spawnSync);
    await runRestart("win32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground", stderr: "" })) as never);
    await expect(runRestart("win32", null, vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground", stderr: "" })) as never))
      .rejects.toThrow("not a verified LCM daemon");
    await expect(runRestart("darwin", undefined, vi.fn(() => { throw new Error("ps unavailable"); }) as never))
      .rejects.toThrow("not a verified LCM daemon");
    await expect(runRestart("darwin", undefined, vi.fn(() => ({ status: 0, stdout: "" })) as never))
      .rejects.toThrow("not a verified LCM daemon");
    await expect(runRestart("darwin", undefined, vi.fn(() => ({ status: 1, stdout: "" })) as never))
      .rejects.toThrow("not a verified LCM daemon");
  });

  it("normalizes hostile response status and ok accessors", async () => {
    const statusThrows = createFixture({
      fetch: vi.fn(async () => {
        const value = { json: async () => ({ status: "ok" }) } as Record<string, unknown>;
        Object.defineProperty(value, "status", { get: () => { throw new Error("status getter"); } });
        Object.defineProperty(value, "ok", { get: () => { throw new Error("ok getter"); } });
        return value;
      }) as never,
    });
    await expect(ensureDaemon(optionsFor(statusThrows, {
      enforceUserManagerParent: false,
      _skipSpawn: true,
    }))).resolves.toMatchObject({ connected: false });
    const falseOk = createFixture({
      fetch: vi.fn(async () => {
        const value = { json: async () => ({ status: "ok" }) } as Record<string, unknown>;
        Object.defineProperty(value, "status", { get: () => undefined });
        Object.defineProperty(value, "ok", { get: () => false });
        return value;
      }) as never,
    });
    await expect(ensureDaemon(optionsFor(falseOk, {
      enforceUserManagerParent: false,
      _skipSpawn: true,
    }))).resolves.toMatchObject({ connected: false });
  });

  it("classifies string detached errors and listener/process termination outcomes", async () => {
    const fixture = createFixture({
      platform: "linux",
      fetch: sequenceFetch([new Error("offline")]),
      spawn: vi.fn(() => { throw "EACCES"; }) as never,
    });
    await expect(ensureDaemon(optionsFor(fixture, {
      enforceUserManagerParent: false,
      _skipHealthWait: true,
    }))).resolves.toMatchObject({ warning: expect.stringContaining("permission denied") });

    const mismatch = createFixture({
      platform: "linux",
      isAlive: () => true,
      fetch: sequenceFetch([healthy(4242, "/tmp/lcm-daemon-entrypoint.mjs", { version: "2" })]),
    });
    writeFileSync(mismatch.pidPath, "4242");
    mkdirSync(join(mismatch.seams.procRoot, "4242"), { recursive: true });
    writeFileSync(join(mismatch.seams.procRoot, "4242", "cmdline"), "node\0lcm\0daemon\0start\0");
    let listenerCalls = 0;
    await expect(ensureDaemon(optionsFor(mismatch, {
      enforceUserManagerParent: false,
      _skipSpawn: true,
      _listeningPortsOverride: () => (++listenerCalls <= 2 ? [mismatch.port] : []),
    }))).resolves.toMatchObject({ connected: false });

    const secondRace = createFixture({
      platform: "linux",
      isAlive: () => true,
      fetch: sequenceFetch([healthy(4242, "/tmp/lcm-daemon-entrypoint.mjs", { version: "2" })]),
    });
    writeFileSync(secondRace.pidPath, "4242");
    mkdirSync(join(secondRace.seams.procRoot, "4242"), { recursive: true });
    writeFileSync(join(secondRace.seams.procRoot, "4242", "cmdline"), "node\0lcm\0daemon\0start\0");
    let secondCalls = 0;
    await expect(ensureDaemon(optionsFor(secondRace, {
      enforceUserManagerParent: false,
      _skipSpawn: true,
      _listeningPortsOverride: () => (++secondCalls <= 3 ? [secondRace.port] : []),
    }))).resolves.toMatchObject({ connected: false });

    let oldAlive = true;
    const replacement = createFixture({
      platform: "linux",
      isAlive: (pid) => pid === 4242 ? oldAlive : pid === 4343,
      fetch: sequenceFetch([
        healthy(4242, "/tmp/lcm-daemon-entrypoint.mjs", { version: "2" }),
        response("invalid-replacement"),
        healthy(4343),
        healthy(4343),
        response({}, 200),
      ]),
      killProcess: () => {
        oldAlive = false;
        writeFileSync(replacement.pidPath, "4343");
      },
    });
    writeFileSync(replacement.pidPath, "4242");
    writeFileSync(replacement.tokenPath, "replacement-token", { mode: 0o600 });
    mkdirSync(join(replacement.seams.procRoot, "4242"), { recursive: true });
    mkdirSync(join(replacement.seams.procRoot, "4343"), { recursive: true });
    writeFileSync(join(replacement.seams.procRoot, "4242", "cmdline"), "node\0lcm\0daemon\0start\0");
    writeFileSync(join(replacement.seams.procRoot, "4343", "cmdline"), "node\0lcm\0daemon\0start\0");
    await expect(ensureDaemon(optionsFor(replacement, {
      enforceUserManagerParent: false,
      _skipSpawn: true,
      _listeningPortsOverride: () => [replacement.port],
    }))).resolves.toMatchObject({ connected: true, pid: 4343 });

    for (const cutoff of [4, 5, 6, 7, 8]) {
      let aliveOld = true;
      let reads = 0;
      const bounded = createFixture({
        platform: "linux",
        isAlive: (pid) => pid === 4242 ? aliveOld : false,
        fetch: sequenceFetch([
          healthy(4242, "/tmp/lcm-daemon-entrypoint.mjs", { version: "2" }),
          response("invalid-replacement"),
        ]),
        killProcess: () => {
          aliveOld = false;
          writeFileSync(bounded.pidPath, "4343");
        },
      });
      writeFileSync(bounded.pidPath, "4242");
      mkdirSync(join(bounded.seams.procRoot, "4242"), { recursive: true });
      writeFileSync(join(bounded.seams.procRoot, "4242", "cmdline"), "node\0lcm\0daemon\0start\0");
      await ensureDaemon(optionsFor(bounded, {
        enforceUserManagerParent: false,
        _skipSpawn: true,
        _monotonicNowOverride: () => {
          reads += 1;
          return reads <= cutoff ? 0 : 1_000;
        },
      }));
    }

    let replacementNow = 0;
    let replacementFetchCalls = 0;
    let replacementOldAlive = true;
    const deadlineReplacement = createFixture({
      platform: "linux",
      isAlive: (pid) => pid === 4242 ? replacementOldAlive : pid === 4343,
      fetch: vi.fn(async () => {
        if (replacementFetchCalls++ === 0) {
          return healthy(4242, "/tmp/lcm-daemon-entrypoint.mjs", { version: "2" });
        }
        replacementNow = 1_000;
        return response("invalid-replacement");
      }) as never,
      killProcess: () => {
        replacementOldAlive = false;
        writeFileSync(deadlineReplacement.pidPath, "4343");
      },
    });
    writeFileSync(deadlineReplacement.pidPath, "4242");
    mkdirSync(join(deadlineReplacement.seams.procRoot, "4242"), { recursive: true });
    writeFileSync(join(deadlineReplacement.seams.procRoot, "4242", "cmdline"), "node\0lcm\0daemon\0start\0");
    await expect(ensureDaemon(optionsFor(deadlineReplacement, {
      enforceUserManagerParent: false,
      _skipSpawn: true,
      _monotonicNowOverride: () => replacementNow,
    }))).resolves.toMatchObject({ connected: false, spawned: false });
  });
});
