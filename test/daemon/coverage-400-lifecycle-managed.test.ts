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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __lifecycleTestUtils,
  ensureDaemon,
  restartDaemon,
  type EnsureDaemonOptions,
} from "../../src/daemon/lifecycle.js";
import { ensureAuthToken } from "../../src/daemon/auth.js";
import {
  managedDaemonPath,
  managedDaemonPathForStableLaunch,
} from "../../src/daemon/managed-path.js";
import {
  managedLaunchEnvironmentDigest,
  type Supervisor,
  type SupervisorObservation,
  type SupervisorSpec,
} from "../../src/daemon/supervisor.js";
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

function staleObservation(
  spec: SupervisorSpec,
  extra: Record<string, unknown> = {},
): SupervisorObservation {
  return {
    kind: "registered-stale-config",
    reason: "metadata-mismatch",
    marker: spec.marker,
    scopeDigest: spec.scopeDigest,
    stateRoot: spec.stateRoot,
    name: spec.name,
    port: spec.port,
    nonce: spec.nonce,
    executable: spec.executable,
    args: JSON.stringify(spec.args),
    cwd: spec.cwd ?? "",
    entrypoint: spec.entrypoint,
    runtimeDigest: spec.runtimeDigest,
    storageBackend: spec.storageBackend,
    credentialDirectory: spec.credentialDirectory,
    credentialFiles: spec.credentialFiles,
    managerPid: 4242,
    ...extra,
  } as SupervisorObservation;
}

function parserShapedStaleObservation(
  spec: SupervisorSpec,
  extra: Record<string, unknown> = {},
): SupervisorObservation {
  const { managerPid, ...parsed } = staleObservation(spec, extra);
  void managerPid;
  return parsed;
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

function deadlineClock(limit = 8, end = 1_000): () => number {
  let calls = 0;
  return () => calls++ < limit ? 0 : end;
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
  it("caps manager commands for long spawn windows while retaining the full lifecycle deadline", async () => {
    const managerSpawn = vi.fn(() => ({ status: 1, stdout: "", stderr: "Unit is not-found" }));
    const scoped = createScopedFixture({
      fetch: vi.fn(async () => { throw new Error("offline"); }) as never,
      spawnSync: managerSpawn as never,
    });
    await expect(ensureDaemon({
      port: scoped.port,
      pidFilePath: scoped.pidPath,
      spawnTimeoutMs: 120_000,
      enforceUserManagerParent: true,
      _testScope: scoped.scope,
      _skipSpawn: true,
      _monotonicNowOverride: () => 0,
    })).resolves.toMatchObject({ refusalReason: "absent" });
    expect(managerSpawn).toHaveBeenCalledOnce();
    expect(managerSpawn.mock.calls[0]?.[2]).toMatchObject({ timeout: 60_000 });

    const restartSpawn = vi.fn(() => ({ status: 1, stdout: "", stderr: "Unit is not-found" }));
    const restartScoped = createScopedFixture({
      fetch: vi.fn(async () => { throw new Error("offline"); }) as never,
      spawnSync: restartSpawn as never,
    });
    await expect(restartDaemon({
      port: restartScoped.port,
      pidFilePath: restartScoped.pidPath,
      spawnTimeoutMs: 120_000,
      enforceUserManagerParent: true,
      _testScope: restartScoped.scope,
      _skipSpawn: true,
      _monotonicNowOverride: () => 0,
    })).resolves.toMatchObject({ refusalReason: "absent", restarted: false });
    expect(restartSpawn).toHaveBeenCalledOnce();
    expect(restartSpawn.mock.calls[0]?.[2]).toMatchObject({ timeout: 60_000 });

    const fixture = createFixture({ fetch: sequenceFetch([new Error("offline")]) });
    let operationDeadline: number | undefined;
    fixture.probe
      .mockImplementationOnce(async (value: SupervisorSpec) => observation(value, "absent"))
      .mockImplementation(async (value: SupervisorSpec) => observation(value, "registered-running-valid", { managerPid: 4242 }));
    fixture.start.mockImplementationOnce(async (
      value: SupervisorSpec,
      operation?: { readonly deadline?: number },
    ) => {
      operationDeadline = operation?.deadline;
      return {
        kind: value.kind,
        name: value.name,
        scopeDigest: value.scopeDigest,
        port: value.port,
        nonce: value.nonce,
        managerPid: 4242,
      };
    });
    await expect(ensureDaemon(optionsFor(fixture, {
      spawnTimeoutMs: 120_000,
      _skipHealthWait: true,
      _monotonicNowOverride: () => 0,
    }))).resolves.toMatchObject({ spawned: true, startMethod: "systemd-user" });
    expect(operationDeadline).toBe(120_000);
    expect(fixture.probe).toHaveBeenNthCalledWith(1, expect.anything(), { deadline: 120_000 });
    expect(fixture.probe).toHaveBeenNthCalledWith(2, expect.anything(), { deadline: 120_000 });
  });

  it("anchors ensure admission to canonical state rather than caller cwd", async () => {
    const fixture = createFixture({
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
      environment: { PATH: "/ambient/bin" },
    });
    const callerHome = homedir();
    const projectCwd = join(fixture.root, "project");
    const spawnCommand = "/usr/bin/node";
    const spawnArgs = [
      join(callerHome, ".local", "lib", "node_modules", "@donadiosolutions", "lcm", "dist", "lcm.mjs"),
      "daemon",
      "start",
      "--foreground",
    ];
    let callerCwd = callerHome;
    vi.spyOn(process, "cwd").mockImplementation(() => callerCwd);
    const probed: SupervisorSpec[] = [];
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => {
      probed.push(spec);
      return observation(spec, "absent");
    });
    const options = optionsFor(fixture, {
      spawnCommand,
      spawnArgs,
      _skipSpawn: true,
    });

    await ensureDaemon(options);
    callerCwd = projectCwd;
    await ensureDaemon(options);

    expect(probed).toHaveLength(2);
    expect(probed[0]?.stateRoot).toBe(probed[1]?.stateRoot);
    expect(probed[0]?.scopeDigest).toBe(probed[1]?.scopeDigest);
    expect(probed[0]?.launchEnvironment?.PATH).toBe(probed[1]?.launchEnvironment?.PATH);
    expect(probed[0]?.launchEnvironment?.PATH).toContain(join(callerHome, ".local", "bin"));
    const digest = (spec: SupervisorSpec): string => managedLaunchEnvironmentDigest(
      spec,
      spec.kind,
      fixture.seams.uid,
      spec.launchEnvironment ?? {},
    );
    expect(digest(probed[0]!)).toBe(digest(probed[1]!));
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("uses the authenticated packaged entrypoint for default manager identity args", async () => {
    const fixture = createFixture({
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
    });
    const packagedEntrypoint = "/opt/lcm/dist/lcm.mjs";
    const probed: SupervisorSpec[] = [];
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => {
      probed.push(spec);
      return observation(spec, "absent");
    });
    await ensureDaemon(optionsFor(fixture, {
      expectedEntrypoint: undefined,
      _packagedEntrypointOverride: packagedEntrypoint,
      _skipSpawn: true,
    }));

    expect(probed).toHaveLength(1);
    expect(probed[0]?.entrypoint).toBe(packagedEntrypoint);
    expect(probed[0]?.args[0]).toBe(packagedEntrypoint);
    expect(probed[0]?.launchEnvironment?.PATH).toBe(
      managedDaemonPathForStableLaunch(
        process.execPath,
        [packagedEntrypoint, "daemon", "start", "--foreground"],
        fixture.stateDir,
      ),
    );
  });

  it("retains the stable launch environment while adopting an observed manager spec", async () => {
    const fixture = createFixture({
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
      environment: { PATH: "/ambient/bin" },
    });
    const spawnCommand = "/usr/bin/node";
    const spawnArgs = ["/work/project/.codex/plugins/cache/lcm/1.4.0/lcm.mjs", "daemon", "start", "--foreground"];
    const probed: SupervisorSpec[] = [];
    fixture.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => {
        probed.push(spec);
        return staleObservation(spec, { nonce: "prior-launch" });
      })
      .mockImplementationOnce(async (spec: SupervisorSpec) => {
        probed.push(spec);
        return observation(spec, "registered-not-running-valid", { terminal: "inactive" });
      });

    await expect(ensureDaemon(optionsFor(fixture, {
      spawnCommand,
      spawnArgs,
      _skipSpawn: true,
    }))).resolves.toMatchObject({ refusalReason: "not-running" });

    expect(probed).toHaveLength(2);
    expect(probed[1]?.launchEnvironment).toEqual(probed[0]?.launchEnvironment);
    expect(probed[1]?.launchEnvironment?.PATH).toBe(
      managedDaemonPathForStableLaunch(spawnCommand, spawnArgs, fixture.stateDir),
    );
  });

  it.each([
    ["linux", "systemd-user"],
    ["darwin", "launchd-user"],
  ] as const)("projects the trusted synthesized PATH into the managed %s launch", async (platform, method) => {
    const fixture = createFixture({
      platform,
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
      environment: {
        PATH: "/ambient/bin",
        LCM_SUMMARY_PROVIDER: "codex-process",
        OPENAI_API_KEY: "ambient-secret",
      },
    });
    const spawnCommand = "/usr/bin/node";
    const spawnArgs = ["/opt/lcm/bin/lcm.mjs", "daemon", "start", "--foreground"];
    await ensureDaemon(optionsFor(fixture, {
      _skipHealthWait: true,
      spawnCommand,
      spawnArgs,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as never,
    }));

    const started = fixture.start.mock.calls[0]?.[0] as SupervisorSpec | undefined;
    expect(started?.kind).toBe(method);
    expect(started?.launchEnvironment).toMatchObject({
      PATH: managedDaemonPath(spawnCommand, spawnArgs),
      LCM_SUMMARY_PROVIDER: "codex-process",
    });
    expect(started?.launchEnvironment?.PATH).not.toBe("/ambient/bin");
    expect(JSON.stringify(started?.launchEnvironment)).not.toContain("ambient-secret");
  });

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
      .mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
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

  it("adopts an existing no-credential running job through its observed nonce", async () => {
    const fixture = createFixture({
      isAlive: () => true,
      environment: { LCM_POSTGRES_CA_FILE: "/etc/lcm/ca.crt" },
      fetch: sequenceFetch([healthy(4242), healthy(4242), response({}, 200)]),
    });
    let calls = 0;
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => {
      calls += 1;
      if (calls === 1) {
        return {
          kind: "registered-stale-config",
          reason: "metadata-mismatch",
          marker: spec.marker,
          scopeDigest: spec.scopeDigest,
          stateRoot: spec.stateRoot,
          name: spec.name,
          port: spec.port,
          nonce: "existing-launch-nonce",
          executable: spec.executable,
          args: JSON.stringify(spec.args),
          cwd: "",
          entrypoint: spec.entrypoint,
          runtimeDigest: spec.runtimeDigest,
          storageBackend: spec.storageBackend,
          postgresCaFile: spec.postgresCaFile,
          managerPid: 4242,
        };
      }
      return observation(spec, "registered-running-valid", { managerPid: 4242 });
    });
    writeFileSync(fixture.pidPath, "4242");
    writeFileSync(fixture.tokenPath, "managed-token", { mode: 0o600 });

    const adoptionResult = await ensureDaemon(optionsFor(fixture, {
      _supervisorNonceOverride: () => "new-launch-nonce",
    }));
    expect(adoptionResult).toMatchObject({ connected: true, spawned: false, pid: 4242 });
    expect(calls).toBe(4);
  });

  it("adopts the same running manager across independent fresh candidate nonces", async () => {
    const priorNonce = "persisted-running-nonce";
    const fixture = createFixture({
      isAlive: () => true,
      fetch: sequenceFetch([
        healthy(4242), healthy(4242), response({}, 200),
        healthy(4242), healthy(4242), response({}, 200),
      ]),
    });
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => {
      const result = {
        ...staleObservation(spec, { nonce: priorNonce }),
        kind: "registered-running-valid",
      } as SupervisorObservation;
      return result;
    });
    writeFileSync(fixture.pidPath, "4242");
    writeFileSync(fixture.tokenPath, "managed-token", { mode: 0o600 });

    const first = await ensureDaemon(optionsFor(fixture, {
      _supervisorNonceOverride: () => "fresh-candidate-one",
    }));
    writeFileSync(fixture.pidPath, "4242");
    const second = await ensureDaemon(optionsFor(fixture, {
      _supervisorNonceOverride: () => "fresh-candidate-two",
    }));

    expect(first).toMatchObject({ connected: true, spawned: false, pid: 4242 });
    expect(second).toMatchObject({ connected: true, spawned: false, pid: 4242 });
    expect(fixture.probe.mock.calls.map(([spec]) => (spec as SupervisorSpec).nonce)).toEqual([
      "fresh-candidate-one", priorNonce, priorNonce, priorNonce,
      "fresh-candidate-two", priorNonce, priorNonce, priorNonce,
    ]);
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.stopAndStart).not.toHaveBeenCalled();
  });

  it.each([
    ["linux", "systemd-user"],
    ["darwin", "launchd-user"],
  ] as const)("reuses a healthy credential-bearing %s job after one-shot cleanup", async (platform, method) => {
    const persistedNonce = "persisted-credential-nonce";
    const fetch = sequenceFetch([healthy(4242), healthy(4242), response({}, 200)]);
    const fixture = createFixture({ platform, fetch, isAlive: () => true });
    const credentialDirectory = join(fixture.stateDir, "credentials", `${persistedNonce}-0123456789abcdef`);
    const credentialFile = join(credentialDirectory, "OPENAI_API_KEY");
    mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
    chmodSync(credentialDirectory, 0o700);
    writeFileSync(credentialFile, "deleted-secret", { mode: 0o600 });
    rmSync(credentialDirectory, { recursive: true, force: true });
    const observed: SupervisorSpec[] = [];
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => {
      observed.push(spec);
      return observed.length === 1
        ? staleObservation(spec, {
            nonce: persistedNonce,
            credentialDirectory,
            credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
          })
        : observation(spec, "registered-running-valid", { managerPid: 4242 });
    });
    writeFileSync(fixture.pidPath, "4242");
    writeFileSync(fixture.tokenPath, "managed-token", { mode: 0o600 });

    const result = await ensureDaemon(optionsFor(fixture, {
      _platform: platform,
      _supervisorNonceOverride: () => "new-ordinary-nonce",
    }));

    expect(result).toMatchObject({ connected: true, spawned: false, startMethod: method, pid: 4242 });
    expect(observed[0]?.credentialDirectory).toBeUndefined();
    expect(observed).toHaveLength(4);
    expect(observed.slice(1).every(spec => spec.nonce === persistedNonce && spec.credentialDirectory === credentialDirectory && spec.credentialFiles?.[0]?.path === credentialFile)).toBe(true);
    expect(observed[1]).toMatchObject({
      nonce: persistedNonce,
      credentialDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: credentialFile }],
    });
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.stopAndStart).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(existsSync(credentialDirectory)).toBe(false);
  });

  it.each(["linux", "darwin"] as const)("refuses %s credential metadata before mutation", async (platform) => {
    const cases: readonly ((directory: string, root: string) => Record<string, unknown>)[] = [
      directory => ({ credentialDirectory: directory }),
      directory => ({ credentialDirectory: directory, credentialFiles: [] }),
      directory => ({ credentialDirectory: directory, credentialFiles: [undefined] }),
      directory => ({ credentialDirectory: directory, credentialFiles: [null] }),
      (directory, root) => {
        const outsideDirectory = join(root, "outside", directory.slice(directory.lastIndexOf("/") + 1));
        return { credentialDirectory: outsideDirectory, credentialFiles: [{ name: "OPENAI_API_KEY", path: join(outsideDirectory, "OPENAI_API_KEY") }] };
      },
      (directory, root) => ({ credentialDirectory: directory, credentialFiles: [{ name: "OPENAI_API_KEY", path: join(root, "foreign", "OPENAI_API_KEY") }] }),
      directory => ({ credentialDirectory: directory, credentialFiles: [{ name: "EVIL", path: join(directory, "EVIL") }] }),
      directory => ({ credentialDirectory: directory, credentialFiles: [{ name: "OPENAI_API_KEY", path: join(directory, "OPENAI_API_KEY") }, { name: "OPENAI_API_KEY", path: join(directory, "OPENAI_API_KEY") }] }),
      directory => {
        const longDirectory = `${directory}${"x".repeat(4100)}`;
        return { credentialDirectory: longDirectory, credentialFiles: [{ name: "OPENAI_API_KEY", path: join(longDirectory, "OPENAI_API_KEY") }] };
      },
    ];
    for (const makeMetadata of cases) {
      const fixture = createFixture({ platform });
      const credentialDirectory = join(fixture.stateDir, "credentials", "persisted-credential-nonce-0123456789abcdef");
      fixture.probe.mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec, {
        nonce: "persisted-credential-nonce",
        ...makeMetadata(credentialDirectory, fixture.root),
      }));
      await expect(ensureDaemon(optionsFor(fixture, { _platform: platform, _skipSpawn: true }))).resolves.toMatchObject({
        connected: false,
        spawned: false,
        refusalReason: "stale-config",
      });
      expect(fixture.probe).toHaveBeenCalledOnce();
      expect(fixture.start).not.toHaveBeenCalled();
      expect(fixture.stopAndStart).not.toHaveBeenCalled();
      expect(fixture.stopAndAwaitAbsent).not.toHaveBeenCalled();
      expect(fixture.seams.fetch).not.toHaveBeenCalled();
    }

    const foreignManager = createFixture({ platform });
    const credentialDirectory = join(foreignManager.root, "manager-credentials", "persisted-credential-nonce-0123456789abcdef");
    foreignManager.probe.mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec, {
      name: "foreign-manager",
      credentialDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: join(credentialDirectory, "OPENAI_API_KEY") }],
    }));
    await expect(ensureDaemon(optionsFor(foreignManager, { _platform: platform, _skipSpawn: true }))).resolves.toMatchObject({ refusalReason: "stale-config" });
    expect(foreignManager.start).not.toHaveBeenCalled();
    expect(foreignManager.stopAndStart).not.toHaveBeenCalled();

    const terminal = createFixture({ platform });
    const terminalDirectory = join(terminal.stateDir, "credentials", "terminal-credential-nonce-0123456789abcdef");
    terminal.probe.mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec, {
      managerPid: undefined,
      nonce: "terminal-credential-nonce",
      credentialDirectory: terminalDirectory,
      credentialFiles: [{ name: "OPENAI_API_KEY", path: join(terminalDirectory, "OPENAI_API_KEY") }],
    }));
    await expect(ensureDaemon(optionsFor(terminal, { _platform: platform, _skipSpawn: true }))).resolves.toMatchObject({ refusalReason: "stale-config" });
    expect(terminal.probe).toHaveBeenCalledOnce();
    expect(terminal.start).not.toHaveBeenCalled();
    expect(terminal.stopAndStart).not.toHaveBeenCalled();

    const terminalRace = createFixture({ platform, isAlive: () => false });
    const raceDirectory = join(terminalRace.stateDir, "credentials", "running-credential-nonce-0123456789abcdef");
    terminalRace.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec, {
        managerPid: 4242,
        nonce: "running-credential-nonce",
        credentialDirectory: raceDirectory,
        credentialFiles: [{ name: "OPENAI_API_KEY", path: join(raceDirectory, "OPENAI_API_KEY") }],
      }))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-not-running-valid", { terminal: "inactive" }));
    await expect(ensureDaemon(optionsFor(terminalRace, { _platform: platform, _skipSpawn: true }))).resolves.toMatchObject({ refusalReason: "stale-config" });
    expect(terminalRace.probe).toHaveBeenCalledTimes(2);
    expect(terminalRace.start).not.toHaveBeenCalled();
    expect(terminalRace.stopAndStart).not.toHaveBeenCalled();
  });

  it("recreates a terminal job through its prior nonce after exact no-live-PID proof", async () => {
    const priorNonce = "existing-terminal-nonce";
    const currentNonce = "new-terminal-nonce";
    const fixture = createFixture({ isAlive: () => false });
    const probes: SupervisorSpec[] = [];
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => {
      probes.push(spec);
      if (probes.length === 1) return parserShapedStaleObservation(spec, { nonce: priorNonce });
      if (probes.length === 2) return observation(spec, "registered-not-running-valid", { terminal: "inactive" });
      return observation(spec, "registered-running-valid", { managerPid: 4242 });
    });

    const result = await ensureDaemon(optionsFor(fixture, {
      _supervisorNonceOverride: () => currentNonce,
      _skipHealthWait: true,
    }));

    expect(result).toMatchObject({ spawned: true, startMethod: "systemd-user", pid: 4242 });
    expect(probes.map(({ nonce }) => nonce)).toEqual([currentNonce, priorNonce, priorNonce]);
    expect(fixture.stopAndStart).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: priorNonce }),
      { deadline: 100 },
    );
  });

  it("refuses prior-nonce terminal adoption when the observed port is stale", async () => {
    const fixture = createFixture({
      isAlive: () => false,
      environment: { OPENAI_API_KEY: "stale-port-secret" },
    });
    const priorNonce = "existing-stale-port-nonce";
    const currentNonce = "new-stale-port-nonce";
    writeFileSync(fixture.pidPath, "4242");
    writeFileSync(fixture.tokenPath, "preserved-token", { mode: 0o600 });
    let probeCalls = 0;
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => {
      probeCalls += 1;
      if (probeCalls === 1) {
        return staleObservation(spec, {
          nonce: priorNonce,
          port: fixture.port - 1,
        });
      }
      if (probeCalls === 2) return observation(spec, "registered-not-running-valid", { terminal: "inactive" });
      return observation(spec, "registered-running-valid", { managerPid: 4242 });
    });
    const credentialRoot = join(fixture.stateDir, "credentials");
    const preservedCredentialDirectory = join(credentialRoot, "preserved");
    mkdirSync(credentialRoot, { recursive: true });
    chmodSync(credentialRoot, 0o700);
    mkdirSync(preservedCredentialDirectory, { recursive: true });
    chmodSync(preservedCredentialDirectory, 0o700);
    const beforeCredentialEntries = readdirSync(credentialRoot);
    const beforePid = readFileSync(fixture.pidPath, "utf8");
    const beforeToken = readFileSync(fixture.tokenPath, "utf8");

    await expect(ensureDaemon(optionsFor(fixture, {
      _supervisorNonceOverride: () => currentNonce,
      _skipHealthWait: true,
    }))).resolves.toMatchObject({
      refusalReason: "stale-config",
      spawned: false,
    });

    expect(fixture.probe).toHaveBeenCalledOnce();
    expect(fixture.stopAndStart).not.toHaveBeenCalled();
    expect(fixture.stopAndAwaitAbsent).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.seams.spawn).not.toHaveBeenCalled();
    expect(fixture.seams.stopUnit).not.toHaveBeenCalled();
    expect(fixture.seams.killProcess).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidPath)).toBe(true);
    expect(readFileSync(fixture.pidPath, "utf8")).toBe(beforePid);
    expect(readFileSync(fixture.tokenPath, "utf8")).toBe(beforeToken);
    expect(readdirSync(credentialRoot)).toEqual(beforeCredentialEntries);
    expect(existsSync(preservedCredentialDirectory)).toBe(true);
  });

  it("refuses prior-nonce terminal adoption on invalid metadata or live PID evidence", async () => {
    const invalidMetadata = createFixture({ isAlive: () => false });
    invalidMetadata.probe.mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec, {
      nonce: "existing-invalid-metadata-nonce",
      args: "[1]",
    }));
    await expect(ensureDaemon(optionsFor(invalidMetadata, {
      _supervisorNonceOverride: () => "new-invalid-metadata-nonce",
      _skipSpawn: true,
    }))).resolves.toMatchObject({ refusalReason: "stale-config" });
    expect(invalidMetadata.stopAndStart).not.toHaveBeenCalled();

    const livePid = createFixture({ isAlive: () => true });
    writeFileSync(livePid.pidPath, "4242");
    livePid.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec, { nonce: "existing-live-pid-nonce" }))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-not-running-valid", { terminal: "inactive" }));
    await expect(ensureDaemon(optionsFor(livePid, {
      _supervisorNonceOverride: () => "new-live-pid-nonce",
    }))).resolves.toMatchObject({ refusalReason: "not-running" });
    expect(livePid.stopAndStart).not.toHaveBeenCalled();
  });

  it("rejects malformed observed launch metadata and unreconstructable specs", async () => {
    for (const args of ["{", "{}", "[1]"]) {
      const fixture = createFixture();
      fixture.probe.mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec, { args }));
      await expect(ensureDaemon(optionsFor(fixture, { _skipSpawn: true }))).resolves.toMatchObject({
        refusalReason: "stale-config",
      });
    }

    const invalidNonce = createFixture();
    invalidNonce.probe.mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec, { nonce: "invalid nonce" }));
    await expect(ensureDaemon(optionsFor(invalidNonce, { _skipSpawn: true }))).resolves.toMatchObject({
      refusalReason: "stale-config",
    });

    const reprobeStale = createFixture();
    reprobeStale.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec))
      .mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec));
    await expect(ensureDaemon(optionsFor(reprobeStale, { _skipSpawn: true }))).resolves.toMatchObject({
      refusalReason: "stale-config",
    });
  });

  it("covers credential-bearing observed identity matching and fail-closed mismatches", async () => {
    const matching = createFixture({
      isAlive: () => true,
      fetch: sequenceFetch([healthy(4242), healthy(4242), response({}, 200)]),
    });
    const credentialDirectory = join(matching.root, "credentials", "launch");
    const credentialFile = { name: "api-key", path: join(credentialDirectory, "api-key") };
    matching.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec))
      .mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    writeFileSync(matching.pidPath, "4242");
    writeFileSync(matching.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(matching, {
      _skipSpawn: true,
      _supervisorCredentialDirectoryOverride: credentialDirectory,
      _supervisorCredentialFilesOverride: [credentialFile],
    }))).resolves.toMatchObject({ connected: true, spawned: false, pid: 4242 });

    const directoryOnly = createFixture({ isAlive: () => true, fetch: sequenceFetch([new Error("offline")]) });
    directoryOnly.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec))
      .mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    writeFileSync(directoryOnly.pidPath, "4242");
    await expect(ensureDaemon(optionsFor(directoryOnly, {
      _skipSpawn: true,
      _supervisorCredentialDirectoryOverride: join(directoryOnly.root, "credentials", "launch"),
    }))).resolves.toMatchObject({ refusalReason: "live-no-response" });

    const mismatches: readonly Record<string, unknown>[] = [
      { credentialDirectory: join(matching.root, "credentials", "foreign") },
      { credentialFiles: [] },
      { credentialFiles: [{ name: "other", path: credentialFile.path }] },
      { credentialFiles: [{ name: credentialFile.name, path: join(matching.root, "credentials", "other") }] },
      { credentialFiles: [undefined] },
    ];
    for (const mismatch of mismatches) {
      const fixture = createFixture();
      fixture.probe.mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec, mismatch));
      await expect(ensureDaemon(optionsFor(fixture, {
        _skipSpawn: true,
        _supervisorCredentialDirectoryOverride: join(fixture.root, "credentials", "launch"),
        _supervisorCredentialFilesOverride: [{ name: "api-key", path: join(fixture.root, "credentials", "launch", "api-key") }],
      }))).resolves.toMatchObject({ refusalReason: "stale-config" });
    }
  });

  it("covers optional metadata omission, explicit runtime identity, and stale reprobe refusal", async () => {
    const runtimeDigest = "a".repeat(64);
    const fixture = createFixture({
      isAlive: () => true,
      fetch: sequenceFetch([
        healthy(4242, "/tmp/lcm-daemon-entrypoint.mjs", { runtimeDigest }),
        healthy(4242, "/tmp/lcm-daemon-entrypoint.mjs", { runtimeDigest }),
        response({}, 200),
      ]),
    });
    fixture.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => staleObservation(spec))
      .mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    writeFileSync(fixture.pidPath, "4242");
    writeFileSync(fixture.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(fixture, {
      expectedEntrypoint: undefined,
      expectedRuntimeDigest: runtimeDigest,
      _skipSpawn: true,
    }))).resolves.toMatchObject({ connected: true, spawned: false, pid: 4242 });
  });

  it("re-probes the exact staged launch spec after manager start", async () => {
    const fixture = createFixture({
      environment: { OPENAI_API_KEY: "staged-secret" },
      fetch: sequenceFetch([new Error("offline")]),
    });
    const observed: SupervisorSpec[] = [];
    fixture.probe.mockImplementation(async (spec: SupervisorSpec) => {
      observed.push(spec);
      return observed.length === 1
        ? observation(spec, "absent")
        : observation(spec, "registered-running-valid", { managerPid: 4242 });
    });
    const result = await ensureDaemon(optionsFor(fixture, {
      _skipHealthWait: true,
      _supervisorNonceOverride: () => "deterministic-launch-nonce",
    }));
    expect(result).toMatchObject({ connected: false, spawned: true, pid: 4242 });
    expect(observed).toHaveLength(2);
    expect(observed[0]?.credentialDirectory).toBeUndefined();
    expect(observed[1]?.credentialDirectory).toBeDefined();
    expect(fixture.start).toHaveBeenCalledWith(expect.objectContaining({
      nonce: "deterministic-launch-nonce",
      credentialDirectory: observed[1]?.credentialDirectory,
      credentialFiles: observed[1]?.credentialFiles,
    }), { deadline: 100 });
  });

  it("erases operation-owned staged credentials only after authenticated admission", async () => {
    const fixture = createFixture({
      environment: { OPENAI_API_KEY: "admitted-secret" },
      isAlive: () => true,
      fetch: sequenceFetch([new Error("pre-start offline"), healthy(4242), healthy(4242), response({}, 200)]),
    });
    fixture.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    writeFileSync(fixture.tokenPath, "managed-token", { mode: 0o600 });

    await expect(ensureDaemon(optionsFor(fixture))).resolves.toMatchObject({
      connected: true,
      spawned: true,
      startMethod: "systemd-user",
    });
    const stagedDirectory = (fixture.start.mock.calls[0]?.[0] as SupervisorSpec).credentialDirectory;
    expect(stagedDirectory).toBeDefined();
    expect(existsSync(stagedDirectory!)).toBe(false);
  });

  it("refuses running managers on no response, probe races, invalid responses, or failed auth", async () => {
    const ordinary = createFixture({ fetch: sequenceFetch([new Error("offline")]), isAlive: () => true });
    const ordinarySleep = vi.fn(async () => undefined);
    setRunningProbe(ordinary);
    await expect(ensureDaemon(optionsFor(ordinary, { _sleepOverride: ordinarySleep }))).resolves.toMatchObject({
      refusalReason: "live-no-response",
    });
    expect(ordinarySleep).not.toHaveBeenCalled();

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

  it("waits for an authorized replacement to publish PID and health, while fencing manager drift", async () => {
    const preAdmissionDrift = createFixture({
      fetch: sequenceFetch([new Error("replacement is still booting")]),
      isAlive: () => true,
    });
    preAdmissionDrift.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 5253 }));
    await expect(ensureDaemon(optionsFor(preAdmissionDrift, {
      _managedOperationAuthorized: true,
      _managedOperationManagerPid: 5252,
      _supervisorNonceOverride: () => "replacement-nonce",
    }))).resolves.toMatchObject({ refusalReason: "ambiguous" });
    expect(preAdmissionDrift.stopAndAwaitAbsent).not.toHaveBeenCalled();

    let now = 0;
    let replacement!: Fixture;
    const sleep = vi.fn(async () => {
      now += 1;
      writeFileSync(replacement.pidPath, "5252");
    });
    replacement = createFixture({
      fetch: sequenceFetch([new Error("replacement is still booting"), healthy(5252), healthy(5252), response({}, 200)]),
      isAlive: (pid) => pid === 5252,
      sleep,
    });
    replacement.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 5252 }));
    writeFileSync(replacement.tokenPath, "replacement-token", { mode: 0o600 });

    const replacementResult = await ensureDaemon(optionsFor(replacement, {
      _managedOperationAuthorized: true,
      _managedOperationManagerPid: 5252,
      _supervisorNonceOverride: () => "replacement-nonce",
      _monotonicNowOverride: () => now,
      _sleepOverride: sleep,
    }));
    expect(replacementResult).toMatchObject({ connected: true, pid: 5252 });
    expect(sleep).toHaveBeenCalledOnce();
    expect(replacement.stopAndAwaitAbsent).not.toHaveBeenCalled();
    expect(replacement.probe.mock.calls).toHaveLength(4);
    expect(replacement.probe.mock.calls.every(([spec]) => (spec as SupervisorSpec).nonce === "replacement-nonce")).toBe(true);

    let driftProbeCalls = 0;
    const drift = createFixture({
      fetch: sequenceFetch([new Error("replacement is still booting")]),
      isAlive: () => true,
    });
    drift.probe.mockImplementation(async (spec: SupervisorSpec) => {
      driftProbeCalls += 1;
      return observation(spec, "registered-running-valid", { managerPid: driftProbeCalls === 1 ? 5252 : 5253 });
    });
    await expect(ensureDaemon(optionsFor(drift, {
      _managedOperationAuthorized: true,
      _managedOperationManagerPid: 5252,
      _supervisorNonceOverride: () => "replacement-nonce",
      _sleepOverride: vi.fn(async () => undefined),
    }))).resolves.toMatchObject({ refusalReason: "ambiguous" });
    expect(drift.stopAndAwaitAbsent).not.toHaveBeenCalled();

    let finalDriftProbeCalls = 0;
    const finalDrift = createFixture({
      fetch: sequenceFetch([new Error("replacement is still booting"), new Error("replacement is still booting")]),
      isAlive: () => true,
    });
    finalDrift.probe.mockImplementation(async (spec: SupervisorSpec) => {
      finalDriftProbeCalls += 1;
      return observation(spec, "registered-running-valid", { managerPid: finalDriftProbeCalls < 3 ? 5252 : 5253 });
    });
    await expect(ensureDaemon(optionsFor(finalDrift, {
      _managedOperationAuthorized: true,
      _managedOperationManagerPid: 5252,
      _supervisorNonceOverride: () => "replacement-nonce",
    }))).resolves.toMatchObject({ refusalReason: "ambiguous" });
    expect(finalDrift.stopAndAwaitAbsent).not.toHaveBeenCalled();

    let admissionDriftProbeCalls = 0;
    const admissionDrift = createFixture({
      fetch: sequenceFetch([healthy(5252)]),
      isAlive: () => true,
    });
    admissionDrift.probe.mockImplementation(async (spec: SupervisorSpec) => {
      admissionDriftProbeCalls += 1;
      return observation(spec, "registered-running-valid", { managerPid: admissionDriftProbeCalls === 1 ? 5252 : 5253 });
    });
    await expect(ensureDaemon(optionsFor(admissionDrift, {
      _managedOperationAuthorized: true,
      _managedOperationManagerPid: 5252,
      _supervisorNonceOverride: () => "replacement-nonce",
    }))).resolves.toMatchObject({ refusalReason: "ambiguous" });
    expect(admissionDrift.stopAndAwaitAbsent).not.toHaveBeenCalled();

    const admissionProbeFailure = createFixture({
      fetch: sequenceFetch([new Error("replacement is still booting")]),
      isAlive: () => true,
    });
    admissionProbeFailure.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 5252 }))
      .mockRejectedValue(new Error("manager probe failed"));
    await expect(ensureDaemon(optionsFor(admissionProbeFailure, {
      _managedOperationAuthorized: true,
      _managedOperationManagerPid: 5252,
      _supervisorNonceOverride: () => "replacement-nonce",
    }))).resolves.toMatchObject({ refusalReason: "ambiguous" });
    expect(admissionProbeFailure.stopAndAwaitAbsent).not.toHaveBeenCalled();

    const finalProbeFailure = createFixture({
      fetch: sequenceFetch([new Error("replacement is still booting"), new Error("replacement is still booting")]),
      isAlive: () => true,
    });
    finalProbeFailure.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 5252 }))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 5252 }))
      .mockRejectedValue(new Error("manager probe failed"));
    await expect(ensureDaemon(optionsFor(finalProbeFailure, {
      _managedOperationAuthorized: true,
      _managedOperationManagerPid: 5252,
      _supervisorNonceOverride: () => "replacement-nonce",
    }))).resolves.toMatchObject({ refusalReason: "ambiguous" });
    expect(finalProbeFailure.stopAndAwaitAbsent).not.toHaveBeenCalled();

    for (const mode of ["before-wait", "after-wait"] as const) {
      let clockReads = 0;
      const timeout = createFixture({
        fetch: sequenceFetch([new Error("replacement is still booting")]),
        isAlive: () => true,
      });
      timeout.probe.mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 5252 }));
      await expect(ensureDaemon(optionsFor(timeout, {
        _managedOperationAuthorized: true,
        _managedOperationManagerPid: 5252,
        _supervisorNonceOverride: () => "replacement-nonce",
        _monotonicNowOverride: () => {
          clockReads += 1;
          return mode === "before-wait" ? (clockReads === 3 ? 1_000 : 0) : (clockReads >= 4 ? 1_000 : 0);
        },
      }))).resolves.toMatchObject({ refusalReason: "startup-failure" });
      expect(timeout.stopAndAwaitAbsent).toHaveBeenCalledOnce();
    }
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

    const afterAuthentication = createFixture({
      fetch: sequenceFetch([healthy(4242), healthy(4242), response({}, 200)]),
      isAlive: () => true,
    });
    let admissionProbes = 0;
    afterAuthentication.probe.mockImplementation(async (spec: SupervisorSpec) => {
      admissionProbes += 1;
      return admissionProbes === 3
        ? observation(spec, "registered-running-valid", { managerPid: 4242, scopeDigest: "foreign-after-auth" })
        : observation(spec, "registered-running-valid", { managerPid: 4242 });
    });
    writeFileSync(afterAuthentication.pidPath, "4242");
    writeFileSync(afterAuthentication.tokenPath, "managed-token", { mode: 0o600 });
    const afterAuthenticationResult = await ensureDaemon(optionsFor(afterAuthentication));
    expect(afterAuthenticationResult).toMatchObject({ refusalReason: "ambiguous" });
    expect(admissionProbes).toBe(3);
  });

  it("covers authenticated manager final-probe failure and null daemon admission", async () => {
    const finalProbeFailure = createFixture({
      isAlive: () => true,
      fetch: sequenceFetch([healthy(4242), healthy(4242), response({}, 200)]),
    });
    finalProbeFailure.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }))
      .mockRejectedValueOnce(new Error("final manager probe failed"));
    writeFileSync(finalProbeFailure.pidPath, "4242");
    writeFileSync(finalProbeFailure.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(finalProbeFailure))).resolves.toMatchObject({
      refusalReason: "ambiguous",
      pid: 4242,
    });

    const nullAdmission = createFixture({
      isAlive: () => true,
      fetch: sequenceFetch([
        healthy(4242),
        healthy(4242, "/foreign-entrypoint.mjs"),
        response({}, 200),
      ]),
    });
    setRunningProbe(nullAdmission);
    writeFileSync(nullAdmission.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(nullAdmission))).resolves.toMatchObject({
      refusalReason: "response-invalid",
      pid: 4242,
    });
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
      .mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    writeFileSync(fixture.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(fixture))).resolves.toMatchObject({
      connected: true,
      spawned: true,
      pid: 4242,
      startMethod: "systemd-user",
    });
  });

  it("covers post-start authenticated reprobe races, rejected admission, and cleanup failure", async () => {
    const finalProbeFailure = createFixture({
      isAlive: () => true,
      fetch: sequenceFetch([new Error("pre-start offline"), healthy(4242), healthy(4242), response({}, 200)]),
    });
    finalProbeFailure.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }))
      .mockRejectedValueOnce(new Error("post-admission probe failed"));
    writeFileSync(finalProbeFailure.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(finalProbeFailure, {
      _skipHealthWait: false,
      _monotonicNowOverride: () => 0,
    }))).resolves.toMatchObject({ refusalReason: "ambiguous", spawned: true, pid: 4242 });

    const identityRace = createFixture({
      isAlive: () => true,
      fetch: sequenceFetch([new Error("pre-start offline"), healthy(4242), healthy(4242), response({}, 200)]),
    });
    identityRace.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }))
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242, scopeDigest: "foreign-after-auth" }));
    writeFileSync(identityRace.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(identityRace, {
      _skipHealthWait: false,
      _monotonicNowOverride: () => 0,
    }))).resolves.toMatchObject({ refusalReason: "ambiguous", spawned: true, pid: 4242 });

    const rejectedAdmission = createFixture({
      isAlive: () => true,
      fetch: sequenceFetch([
        new Error("pre-start offline"),
        healthy(4242),
        healthy(4242, "/foreign-entrypoint.mjs"),
        response({}, 200),
      ]),
    });
    rejectedAdmission.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    writeFileSync(rejectedAdmission.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(rejectedAdmission, {
      _skipHealthWait: false,
      _monotonicNowOverride: deadlineClock(),
    }))).resolves.toMatchObject({ refusalReason: "startup-failure", spawned: true, pid: 4242 });

    const cleanupFailure = createFixture({
      environment: { OPENAI_API_KEY: "cleanup-secret" },
      isAlive: () => true,
      fetch: sequenceFetch([new Error("pre-start offline"), healthy(4242), healthy(4242), response({}, 200)]),
    });
    cleanupFailure.start.mockImplementation(async (spec: SupervisorSpec) => {
      writeFileSync(cleanupFailure.pidPath, "4242");
      mkdirSync(join(spec.credentialDirectory!, "LCM_SUMMARY_API_KEY"));
      return {
        kind: spec.kind,
        name: spec.name,
        scopeDigest: spec.scopeDigest,
        port: spec.port,
        nonce: spec.nonce,
        managerPid: 4242,
      };
    });
    cleanupFailure.probe
      .mockImplementationOnce(async (spec: SupervisorSpec) => observation(spec, "absent"))
      .mockImplementation(async (spec: SupervisorSpec) => observation(spec, "registered-running-valid", { managerPid: 4242 }));
    writeFileSync(cleanupFailure.tokenPath, "managed-token", { mode: 0o600 });
    await expect(ensureDaemon(optionsFor(cleanupFailure, {
      _skipHealthWait: false,
      _monotonicNowOverride: () => 0,
    }))).rejects.toThrow("managed credential file failed validation");
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
