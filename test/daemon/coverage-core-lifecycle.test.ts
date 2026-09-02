import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAuthToken } from "../../src/daemon/auth.js";
import {
  __lifecycleTestUtils,
  ensureDaemon as ensureDaemonProduction,
  findUserSystemdPid,
  readProcessParentPid,
  restartDaemon as restartDaemonProduction,
} from "../../src/daemon/lifecycle.js";
import type { DaemonLifecycleHermeticTestSeams } from "../../src/daemon/lifecycle-scope.js";

const dirs: string[] = [];
type EnsureDaemonOptions = Parameters<typeof ensureDaemonProduction>[0];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "lcm-core-life-")); dirs.push(d); return d; };
const proc = (root: string, pid: number, status: string, command?: string) => {
  const dir = join(root, String(pid)); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status"), status);
  if (command !== undefined) writeFileSync(join(dir, "cmdline"), command.replaceAll(" ", "\0"));
};
const fetchHealthy = (
  pid?: number,
  identity: Readonly<{ entrypoint?: string; runtimeDigest?: string }> = {},
) => vi.fn(async (url: string) => url.endsWith("/health")
  ? {
      ok: true,
      json: async () => ({
        status: "ok",
        version: "1",
        pid,
        ...(identity.entrypoint === undefined
          ? {}
          : { entrypoint: identity.entrypoint }),
        ...(identity.runtimeDigest === undefined
          ? {}
          : { runtimeDigest: identity.runtimeDigest }),
      }),
    }
  : { ok: true, json: async () => ({}) });

function unavailableSupervisor(): EnsureDaemonOptions["_supervisorOverride"] {
  return {
    probe: vi.fn(async (spec: { name: string }) => ({
      kind: "unavailable" as const,
      reason: "manager-unavailable" as const,
      name: spec.name,
    })),
    start: vi.fn(),
    stopAndStart: vi.fn(),
    stopAndAwaitAbsent: vi.fn(),
  } as never;
}

function withHermeticLifecycleSeams(options: EnsureDaemonOptions): EnsureDaemonOptions {
  const stateDir = dirname(options.pidFilePath);
  const runtimeDir = join(stateDir, ".hermetic-runtime");
  const credentialDir = join(stateDir, ".hermetic-credentials");
  const procRoot = options._procRoot === "/proc"
    ? join(stateDir, ".hermetic-proc")
    : options._procRoot ?? join(stateDir, ".hermetic-proc");
  for (const directory of [stateDir, runtimeDir, credentialDir, procRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  const seams: DaemonLifecycleHermeticTestSeams = {
    homeDir: stateDir,
    runtimeDir,
    stateDir,
    credentialDir,
    procRoot,
    platform: options._platform ?? "linux",
    uid: options._uid ?? 1000,
    environment: {},
    fetch: options._fetchOverride
      ?? (vi.fn().mockRejectedValue(new Error("hermetic offline")) as never),
    spawn: options._spawnOverride
      ?? (vi.fn(() => ({ pid: undefined, once: vi.fn().mockReturnThis(), unref: vi.fn() })) as never),
    spawnSync: options._spawnSyncOverride
      ?? (vi.fn(() => ({ status: 1, stdout: "", stderr: "hermetic" })) as never),
    stopUnit: vi.fn(),
    killProcess: options._killOverride ?? vi.fn(),
    isProcessAlive: options._isProcessAliveOverride ?? (() => false),
    sleep: options._sleepOverride ?? (async () => undefined),
    realpath: options._realpathOverride ?? (path => path),
  };
  return { ...options, _hermeticTestSeams: seams };
}

function ensureDaemon(options: EnsureDaemonOptions): ReturnType<typeof ensureDaemonProduction> {
  return ensureDaemonProduction(withHermeticLifecycleSeams(options));
}

function restartDaemon(
  options: Parameters<typeof restartDaemonProduction>[0],
): ReturnType<typeof restartDaemonProduction> {
  return restartDaemonProduction(withHermeticLifecycleSeams(options));
}

describe("lifecycle procfs and parent warnings", () => {
  it("attempts every cleanup stage before aggregating multiple failures", async () => {
    const order: string[] = [];
    const first = new Error("unit cleanup failed");
    const second = new Error("state cleanup failed");
    await expect(__lifecycleTestUtils.runCleanupStages([
      async () => {
        order.push("unit");
        throw first;
      },
      () => {
        order.push("process");
      },
      async () => {
        order.push("state");
        throw second;
      },
    ])).rejects.toMatchObject({
      errors: [first, second],
      message: "daemon lifecycle cleanup failed",
    });
    expect(order).toEqual(["unit", "process", "state"]);
    await expect(__lifecycleTestUtils.sleep(0)).resolves.toBeUndefined();
    expect(__lifecycleTestUtils.isProcessAlive(process.pid)).toBe(true);
    expect(__lifecycleTestUtils.isProcessAlive(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("resolves complete scoped, hermetic, override, and production dependency sets", async () => {
    const root = temp();
    const pidFilePath = join(root, "daemon.pid");
    const production = __lifecycleTestUtils.resolveLifecycleDependencies({
      port: 1,
      pidFilePath,
      spawnTimeoutMs: 1,
    });
    expect(production).toMatchObject({
      environment: process.env,
      platform: process.platform,
      procRoot: "/proc",
      uid: undefined,
    });
    expect(Object.values(production).filter(value => typeof value === "function"))
      .toHaveLength(7);

    const overrides = {
      fetch: vi.fn() as never,
      spawn: vi.fn() as never,
      spawnSync: vi.fn() as never,
      killProcess: vi.fn(),
      isProcessAlive: vi.fn(),
      sleep: vi.fn(async () => undefined),
      realpath: vi.fn((path: string) => path),
    };
    expect(__lifecycleTestUtils.resolveLifecycleDependencies({
      port: 1,
      pidFilePath,
      spawnTimeoutMs: 1,
      _fetchOverride: overrides.fetch,
      _spawnOverride: overrides.spawn,
      _spawnSyncOverride: overrides.spawnSync,
      _killOverride: overrides.killProcess,
      _isProcessAliveOverride: overrides.isProcessAlive,
      _sleepOverride: overrides.sleep,
      _realpathOverride: overrides.realpath,
      _platform: "darwin",
      _procRoot: join(root, "proc"),
      _uid: 501,
    })).toMatchObject({
      ...overrides,
      platform: "darwin",
      procRoot: join(root, "proc"),
      uid: 501,
    });

    const hermeticOptions = withHermeticLifecycleSeams({
      port: 1,
      pidFilePath,
      spawnTimeoutMs: 1,
    });
    const hermetic = __lifecycleTestUtils.resolveLifecycleDependencies(hermeticOptions);
    expect(hermetic).toMatchObject({
      environment: hermeticOptions._hermeticTestSeams!.environment,
      fetch: hermeticOptions._hermeticTestSeams!.fetch,
      spawn: hermeticOptions._hermeticTestSeams!.spawn,
      spawnSync: hermeticOptions._hermeticTestSeams!.spawnSync,
      killProcess: hermeticOptions._hermeticTestSeams!.killProcess,
      isProcessAlive: hermeticOptions._hermeticTestSeams!.isProcessAlive,
      sleep: hermeticOptions._hermeticTestSeams!.sleep,
      realpath: hermeticOptions._hermeticTestSeams!.realpath,
      platform: hermeticOptions._hermeticTestSeams!.platform,
      procRoot: hermeticOptions._hermeticTestSeams!.procRoot,
      uid: hermeticOptions._hermeticTestSeams!.uid,
    });

    const scopedDependencies = {
      fetch: vi.fn() as never,
      spawn: vi.fn() as never,
      spawnSync: vi.fn() as never,
      killProcess: vi.fn(),
      isProcessAlive: vi.fn(),
      sleep: vi.fn(async () => undefined),
    };
    const scopedOptions = {
      port: 1,
      pidFilePath,
      spawnTimeoutMs: 1,
      _testScope: {
        ownerId: "owned",
        homeDir: join(root, "home"),
        runtimeDir: join(root, "home", "runtime"),
        unitPrefix: "lcm-test-daemon-owned-",
        dependencies: scopedDependencies,
      } as never,
    };
    const scoped = __lifecycleTestUtils.resolveLifecycleDependencies(scopedOptions);
    expect(scoped).toMatchObject(scopedDependencies);
    expect(__lifecycleTestUtils.lifecycleSpawnEnvironment(
      { port: 1, pidFilePath, spawnTimeoutMs: 1 },
      production,
    )).toMatchObject(process.env);
    expect(__lifecycleTestUtils.lifecycleSpawnEnvironment(
      hermeticOptions,
      hermetic,
    )).toMatchObject({
      HOME: hermeticOptions._hermeticTestSeams!.homeDir,
      USERPROFILE: hermeticOptions._hermeticTestSeams!.homeDir,
      XDG_RUNTIME_DIR: hermeticOptions._hermeticTestSeams!.runtimeDir,
    });
    expect(__lifecycleTestUtils.lifecycleSpawnEnvironment(
      scopedOptions,
      scoped,
    )).toMatchObject({
      HOME: scopedOptions._testScope.homeDir,
      USERPROFILE: scopedOptions._testScope.homeDir,
      XDG_RUNTIME_DIR: scopedOptions._testScope.runtimeDir,
      LCM_DAEMON_OWNER_ID: "owned",
    });

    const transportRoot = temp();
    const transportRuntime = join(transportRoot, "runtime");
    mkdirSync(transportRuntime);
    const spawnSync = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const transportOptions: EnsureDaemonOptions = {
      port: 1,
      pidFilePath,
      spawnTimeoutMs: 1,
      _spawnSyncOverride: spawnSync as never,
      _managerTransportEnvironmentOverride: {
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        XDG_RUNTIME_DIR: transportRuntime,
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        HOME: "/production/home",
        LCM_POSTGRES_URL: "postgresql://user:secret@example.invalid/lcm",
        OPENAI_API_KEY: "should-not-reach-manager",
      },
    };
    const transportDependencies = __lifecycleTestUtils.resolveLifecycleDependencies(transportOptions);
    const managerEnvironment = __lifecycleTestUtils.managerTransportEnvironment(
      transportOptions,
      transportDependencies,
    );
    expect(managerEnvironment).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      XDG_RUNTIME_DIR: transportRuntime,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    const controlRunner = __lifecycleTestUtils.supervisorCommandRunner(
      transportDependencies,
      transportOptions,
    );
    await controlRunner("systemctl", ["--user", "show", "lcm-test.service"], { timeoutMs: 1 });
    expect(spawnSync).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "show", "lcm-test.service"],
      expect.objectContaining({ env: managerEnvironment }),
    );
    expect(JSON.stringify(managerEnvironment)).not.toContain("production/home");
    expect(JSON.stringify(managerEnvironment)).not.toContain("LCM_POSTGRES_URL");
    expect(JSON.stringify(managerEnvironment)).not.toContain("should-not-reach-manager");
    expect(__lifecycleTestUtils.managerTransportEnvironment(
      {
        ...transportOptions,
        _managerTransportEnvironmentOverride: {
          XDG_RUNTIME_DIR: "relative-runtime",
          DBUS_SESSION_BUS_ADDRESS: "unsafe\naddress",
          PATH: "/usr/bin",
        },
      },
      transportDependencies,
    )).toEqual({ PATH: "/usr/bin" });

    expect(__lifecycleTestUtils.lifecycleUnitName(
      { port: 1, pidFilePath, spawnTimeoutMs: 1 },
      10,
      20,
    )).toBe("lcm-daemon-10-20");
    expect(__lifecycleTestUtils.lifecycleUnitName(
      hermeticOptions,
      10,
      20,
    )).toBe("lcm-test-daemon-hermetic-10-20");
    expect(__lifecycleTestUtils.lifecycleUnitName(
      {
        port: 1,
        pidFilePath,
        spawnTimeoutMs: 1,
        _testScope: scopedOptions._testScope,
      },
      10,
      20,
    )).toBe("lcm-test-daemon-owned-10-20");
  });

  it("covers internal platform parsing, parent equality, warning fallback, and environment shaping", () => {
    expect(__lifecycleTestUtils.healthVersionMatches(null, undefined)).toBe(false);
    expect(__lifecycleTestUtils.healthVersionMatches({ status: "ok", version: "" }, "")).toBe(false);
    expect(__lifecycleTestUtils.healthVersionMatches({ status: "ok", version: "1" }, "1")).toBe(true);
    expect(__lifecycleTestUtils.healthStorageBackendMatches(null, "sqlite")).toBe(true);
    expect(__lifecycleTestUtils.healthStorageBackendMatches({ status: "ok" }, "postgresql")).toBe(false);
    expect(__lifecycleTestUtils.healthStorageBackendMatches({ status: "ok", storageBackend: "postgresql" }, "postgresql")).toBe(true);
    expect(__lifecycleTestUtils.resolveWindowsNetstatPath(undefined, undefined)).toBeNull();
    expect(__lifecycleTestUtils.resolveWindowsNetstatPath("C:\\project", "relative", () => true)).toBeNull();
    const windowsFileExists = vi.fn((path: string) => path.startsWith("D:\\"));
    expect(__lifecycleTestUtils.resolveWindowsNetstatPath("C:\\Windows", " D:\\Windows\\ ", windowsFileExists)).toBe("D:\\Windows\\System32\\netstat.exe");
    expect(windowsFileExists).toHaveBeenCalledWith("C:\\Windows\\System32\\netstat.exe");
    expect(windowsFileExists).toHaveBeenCalledWith("D:\\Windows\\System32\\netstat.exe");
    const many = Array.from({ length: 40 }, (_, index) => `n127.0.0.1:${1000 + index}`).join("\n");
    const spawnSync = vi.fn(() => ({ status: 0, stdout: many }));
    expect(__lifecycleTestUtils.findListeningTcpPorts(1, "freebsd", spawnSync as never)).toHaveLength(32);
    expect(__lifecycleTestUtils.findListeningTcpPorts(1, "freebsd", spawnSync as never, "/proc", 1039)).toEqual([1039]);
    expect(spawnSync).toHaveBeenCalledWith("lsof", expect.any(Array), expect.any(Object));
    expect(__lifecycleTestUtils.findListeningTcpPorts(1, "freebsd", vi.fn(() => ({
      status: 0, stdout: "n127.0.0.2:3737\nn127.0.0.1:invalid\nn127.0.0.1:4545",
    })) as never)).toEqual([4545]);
    expect(__lifecycleTestUtils.findListeningTcpPorts(1, "darwin", vi.fn(() => ({ status: 1, stdout: "" })) as never)).toEqual([]);
    const win32Netstat = vi.fn(() => ({
      status: 0,
      stdout: [
        "malformed",
        "UDP 127.0.0.1:1111 *:* LISTENING 42",
        "TCP 127.0.0.1:2222 0.0.0.0:0 ESTABLISHED 42",
        "TCP invalid 0.0.0.0:0 LISTENING 42",
        "TCP 127.0.0.2:3333 0.0.0.0:0 LISTENING 42",
        "TCP 127.0.0.1:invalid 0.0.0.0:0 LISTENING 42",
        "TCP 127.0.0.1:3737 0.0.0.0:0 LISTENING 42",
        "TCP 127.0.0.1:4545 0.0.0.0:0 LISTENING 42",
        "TCP 127.0.0.1:4545 0.0.0.0:0 LISTENING 99",
      ].join("\n"),
    }));
    const trustedNetstat = "C:\\Windows\\System32\\netstat.exe";
    expect(__lifecycleTestUtils.findListeningTcpPorts(42, "win32", win32Netstat as never, "/proc", undefined, trustedNetstat)).toEqual([3737, 4545]);
    expect(win32Netstat).toHaveBeenCalledWith(trustedNetstat, ["-ano", "-p", "tcp"], expect.any(Object));
    expect(__lifecycleTestUtils.findListeningTcpPorts(42, "win32", win32Netstat as never, "/proc", 3737, trustedNetstat)).toEqual([3737]);
    expect(__lifecycleTestUtils.findListeningTcpPorts(42, "win32", vi.fn(() => ({ status: 1, stdout: "" })) as never, "/proc", undefined, trustedNetstat)).toEqual([]);
    expect(__lifecycleTestUtils.findListeningTcpPorts(42, "win32", vi.fn(() => { throw new Error("netstat failed"); }) as never, "/proc", undefined, trustedNetstat)).toEqual([]);
    const hijackedNetstat = vi.fn();
    expect(__lifecycleTestUtils.findListeningTcpPorts(42, "win32", hijackedNetstat as never, "/proc", undefined, null)).toEqual([]);
    expect(hijackedNetstat).not.toHaveBeenCalled();
    expect(__lifecycleTestUtils.resolveLinuxSsPath((path) => path === "/usr/sbin/ss")).toBe("/usr/sbin/ss");
    expect(__lifecycleTestUtils.resolveLinuxSsPath(() => false)).toBeNull();

    const linuxRoot = temp();
    mkdirSync(join(linuxRoot, "42", "fd"), { recursive: true });
    mkdirSync(join(linuxRoot, "net"), { recursive: true });
    symlinkSync("socket:[12345]", join(linuxRoot, "42", "fd", "7"));
    symlinkSync("socket:[67890]", join(linuxRoot, "42", "fd", "8"));
    writeFileSync(join(linuxRoot, "net", "tcp"), [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0AAA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000000000000001 100 0 0 10 0",
      "   1: 0200007F:0D05 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000002 100 0 0 10 0",
      "   2: 0100007F:     00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000003 100 0 0 10 0",
      "   3: 0100007F:0E99 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000004 100 0 0 10 0",
      "   4: 0100007F:11C1 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 67890 1 0000000000000005 100 0 0 10 0",
      "",
    ].join("\n"));
    expect(__lifecycleTestUtils.findListeningTcpPorts(42, "linux", vi.fn() as never, linuxRoot)).toEqual([3737, 4545]);
    expect(__lifecycleTestUtils.findListeningTcpPorts(42, "linux", vi.fn() as never, linuxRoot, 2730)).toEqual([]);
    expect(__lifecycleTestUtils.findListeningTcpPorts(42, "linux", vi.fn() as never, linuxRoot, 3333)).toEqual([]);
    expect(__lifecycleTestUtils.findListeningTcpPorts(42, "linux", vi.fn() as never, linuxRoot, 3737)).toEqual([3737]);
    expect(__lifecycleTestUtils.findListeningTcpPorts(42, "linux", vi.fn() as never, join(linuxRoot, "missing"))).toEqual([]);

    const cgroup = "/user.slice/user-1000.slice/user@1000.service/app.slice/lcm-daemon-0123456789abcdef0123.service";
    const cgroupSocketProbe = vi.fn(() => ({
      status: 0,
      stdout: `LISTEN 0 511 127.0.0.1:3737 0.0.0.0:* ino:12345 sk:1 cgroup:${cgroup} <->\n`,
      stderr: "",
    }));
    const findWithCgroup = __lifecycleTestUtils.findListeningTcpPorts as unknown as (
      pid: number,
      platform: NodeJS.Platform,
      spawnSyncImpl: typeof import("node:child_process").spawnSync,
      procRoot: string,
      targetPort: number,
      windowsNetstatPath: string | null,
      systemdControlGroup: string,
      linuxSsPath: string | null,
    ) => number[];
    const unreadableRoot = temp();
    mkdirSync(join(unreadableRoot, "42", "fd"), { recursive: true });
    writeFileSync(join(unreadableRoot, "42", "fd", "7"), "not a descriptor link");
    expect(findWithCgroup(42, "linux", cgroupSocketProbe as never, unreadableRoot, 3737, null, cgroup, "/usr/bin/ss")).toEqual([3737]);
    expect(cgroupSocketProbe).toHaveBeenCalledWith(
      "/usr/bin/ss",
      ["-H", "-ltnpe4", "sport = :3737"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );

    const mixedOwnership = vi.fn(() => ({
      status: 0,
      stdout: [
        `LISTEN 0 511 127.0.0.1:3737 0.0.0.0:* ino:12345 sk:1 cgroup:${cgroup} <->`,
        "LISTEN 0 511 127.0.0.1:3737 0.0.0.0:* ino:67890 sk:2 cgroup:/user.slice/foreign.service <->",
      ].join("\n"),
      stderr: "",
    }));
    expect(findWithCgroup(42, "linux", mixedOwnership as never, join(linuxRoot, "missing"), 3737, null, cgroup, "/usr/bin/ss")).toEqual([]);
    expect(findWithCgroup(42, "linux", vi.fn() as never, join(linuxRoot, "missing"), 3737, null, "relative", "/usr/bin/ss")).toEqual([]);
    expect(findWithCgroup(42, "linux", vi.fn() as never, join(linuxRoot, "missing"), 3737, null, cgroup, null)).toEqual([]);
    expect(findWithCgroup(42, "linux", vi.fn() as never, join(linuxRoot, "missing"), 0, null, cgroup, "/usr/bin/ss")).toEqual([]);
    expect(findWithCgroup(42, "linux", vi.fn() as never, join(linuxRoot, "missing"), 65_536, null, cgroup, "/usr/bin/ss")).toEqual([]);
    expect(findWithCgroup(42, "linux", vi.fn() as never, join(linuxRoot, "missing"), Number.NaN, null, cgroup, "/usr/bin/ss")).toEqual([]);
    expect(findWithCgroup(42, "linux", vi.fn() as never, join(linuxRoot, "missing"), 3737, null, "", "/usr/bin/ss")).toEqual([]);
    expect(findWithCgroup(42, "linux", vi.fn() as never, join(linuxRoot, "missing"), 3737, null, `/${"x".repeat(4 * 1024)}`, "/usr/bin/ss")).toEqual([]);

    for (const result of [
      { status: 1, stdout: "", stderr: "failed" },
      { status: 0, stdout: 1, stderr: "" },
      { status: 0, stdout: "ESTAB 0 0 127.0.0.1:3737 127.0.0.1:40000", stderr: "" },
      { status: 0, stdout: "LISTEN 0 511 127.0.0.1:3738 0.0.0.0:* cgroup:/foreign", stderr: "" },
      { status: 0, stdout: "LISTEN 0 511 127.0.0.1:3737 0.0.0.0:* ino:1", stderr: "" },
    ]) {
      expect(findWithCgroup(
        42,
        "linux",
        vi.fn(() => result) as never,
        join(linuxRoot, "missing"),
        3737,
        null,
        cgroup,
        "/usr/bin/ss",
      )).toEqual([]);
    }
    expect(findWithCgroup(
      42,
      "linux",
      vi.fn(() => { throw new Error("socket diagnostics failed"); }) as never,
      join(linuxRoot, "missing"),
      3737,
      null,
      cgroup,
      "/usr/bin/ss",
    )).toEqual([]);

    expect(__lifecycleTestUtils.parentInvariantWarning({ satisfies: false, available: false, reason: "missing-pid" })).toContain("PID file missing");
    expect(__lifecycleTestUtils.parentInvariantWarning({ satisfies: false, available: false, pid: 42, reason: "dead-pid" })).toContain("PID 42 is not running");
    expect(__lifecycleTestUtils.parentInvariantWarning({ satisfies: false, available: true, reason: "wrong-parent" })).toBe("daemon parent invariant is not verified");
  });

  it("covers malformed status fields, command reads, directory filtering, and cache hits", () => {
    const root = temp();
    writeFileSync(join(root, "file"), "x");
    mkdirSync(join(root, "abc"));
    proc(root, 1, "Uid:\tbad\nPPid:\tbad\n", "systemd --user");
    proc(root, 2, "Uid:\t1000\nPPid:\t-1\n", "other");
    proc(root, 3, "Uid:\t1000\nPPid:\t0\n", "systemd --user");
    expect(readProcessParentPid(1, root)).toBeNull();
    expect(readProcessParentPid(2, root)).toBeNull();
    expect(findUserSystemdPid({ procRoot: root, uid: 1000 })).toBe(3);
    expect(findUserSystemdPid({ procRoot: root, uid: 1000 })).toBe(3);
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    const getuid = vi.fn(() => 1000);
    Object.defineProperty(process, "getuid", { configurable: true, value: getuid });
    try {
      expect(findUserSystemdPid({ procRoot: root })).toBe(3);
      expect(getuid).toHaveBeenCalledOnce();
    } finally {
      if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
      else Reflect.deleteProperty(process, "getuid");
    }
    expect(findUserSystemdPid({ uid: 987_654 })).toBeNull();

    const noUidRoot = temp(); proc(noUidRoot, 90, "Name:\tsystemd\n", "systemd --user");
    expect(findUserSystemdPid({ procRoot: noUidRoot, uid: 1000 })).toBeNull();
  });

  it("uses the no-getuid fallback and recognizes a matching parent", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try { expect(findUserSystemdPid({ procRoot: temp() })).toBeNull(); }
    finally { if (descriptor) Object.defineProperty(process, "getuid", descriptor); }

    const root = temp(); const pidPath = join(root, "daemon.pid"); writeFileSync(pidPath, "20");
    proc(root, 10, "Uid:\t1000\nPPid:\t1\n", "systemd --user");
    proc(root, 20, "Uid:\t1000\nPPid:\t10\n", "node lcm daemon start --foreground");
    expect(__lifecycleTestUtils.inspectDaemonParent(pidPath, { procRoot: root, uid: 1000, isAlive: () => true })).toMatchObject({ satisfies: true, reason: undefined });
    expect(__lifecycleTestUtils.inspectDaemonParent(join(root, "missing.pid"), { procRoot: root, uid: 1000, isAlive: () => true })).toMatchObject({ available: false, reason: "missing-pid" });
    expect(__lifecycleTestUtils.inspectDaemonParent(pidPath, { procRoot: root, uid: 1000, isAlive: () => false })).toMatchObject({ available: false, reason: "dead-pid" });
  });

  it.each([
    ["dead", false, "node lcm daemon start --foreground", "PPid:\t1\n", false, undefined],
    ["wrong", true, "node other", "PPid:\t1\n", true, "not an LCM daemon"],
    ["parent", true, "node lcm daemon start --foreground", "Uid:\t1000\n", true, "parent could not be read"],
  ])("handles %s PID metadata after endpoint identity checks", async (_name, alive, command, daemonStatus, connected, warning) => {
    const dir = temp(); const procRoot = join(dir, "proc"); mkdirSync(procRoot);
    const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "20"); ensureAuthToken(join(dir, "daemon.token"));
    proc(procRoot, 10, "Uid:\t1000\nPPid:\t1\n", "systemd --user");
    proc(procRoot, 20, daemonStatus, command);
    const fetch = fetchHealthy(20);
    // observeHttpHealth owns a real wall-clock deadline not controlled by
    // _monotonicNowOverride, so pin performance.now for this 1 ms fixture.
    vi.spyOn(performance, "now").mockReturnValue(0);
    const result = await ensureDaemon({
      port: 1, pidFilePath: pidPath, spawnTimeoutMs: 1, enforceUserManagerParent: true,
      expectedVersion: "1",
      _platform: "linux", _procRoot: procRoot, _uid: 1000, _fetchOverride: fetch as never,
      _isProcessAliveOverride: () => alive, _listeningPortsOverride: () => [1], _skipSpawn: true,
      _monotonicNowOverride: (): number => 0,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result.connected).toBe(connected);
    if (warning) expect(result.warning).toContain(warning);
    else expect(result.warning).toBeUndefined();
    if (_name === "parent") {
      expect(fetch).toHaveBeenCalledTimes(3);
    }
  });

  it("handles an unavailable current uid and a missing daemon cmdline", async () => {
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(undefined as never);
    expect(findUserSystemdPid({ procRoot: temp() })).toBeNull();
    getuid.mockRestore();

    const dir = temp(); const procRoot = join(dir, "proc"); mkdirSync(procRoot);
    const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "31"); ensureAuthToken(join(dir, "daemon.token"));
    proc(procRoot, 31, "Uid:\t1000\nPPid:\t1\n");
    const runtimeIdentity = {
      entrypoint: "/fixture/lcm-daemon",
      runtimeDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    } as const;
    // observeHttpHealth owns a real wall-clock deadline not controlled by
    // _monotonicNowOverride, so pin performance.now for this 1 ms fixture.
    vi.spyOn(performance, "now").mockReturnValue(0);
    const result = await ensureDaemon({
      port: 1, pidFilePath: pidPath, spawnTimeoutMs: 1, enforceUserManagerParent: true,
      expectedVersion: "1", expectedEntrypoint: runtimeIdentity.entrypoint,
      expectedRuntimeDigest: runtimeIdentity.runtimeDigest,
      _platform: "linux", _procRoot: procRoot, _uid: 1000, _fetchOverride: fetchHealthy(31, runtimeIdentity) as never,
      _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [1], _skipSpawn: true,
      _monotonicNowOverride: (): number => 0,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result).toMatchObject({
      connected: true,
      warning: "daemon PID 31 is not an LCM daemon; daemon parent invariant is not verified",
    });
  });
});

describe("lifecycle spawn and restart failure boundaries", () => {
  it("covers early-dead and throwing termination paths", async () => {
    for (const mode of ["early", "term", "kill"] as const) {
      const dir = temp(); const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "22");
      const alive = mode === "early"
        ? vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
        : mode === "term"
          ? vi.fn().mockReturnValue(true)
          : vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
      const kill = vi.fn((_pid: number, signal?: string | number) => {
        if (mode === "term" || (mode === "kill" && signal === "SIGKILL")) throw new Error("kill");
      });
      const promise = restartDaemon({
        port: 4, pidFilePath: pidPath, spawnTimeoutMs: 1, _platform: "darwin", _isProcessAliveOverride: alive,
        _isManagedProcessOverride: () => true, _killOverride: kill as never, _sleepOverride: async () => {},
        _ensureDaemonOverride: async () => ({ connected: false, port: 4, spawned: true }),
      });
      if (mode === "term") await expect(promise).rejects.toThrow("Unable to stop");
      else await expect(promise).resolves.toMatchObject({ restarted: true, stoppedPid: 22 });
    }
  });

  it("uses an injected restart signal seam and covers the default signal delegate", async () => {
    const dir = temp(); const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "23");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    __lifecycleTestUtils.defaultKillProcess(22, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(22, "SIGTERM");
    const injectedKill = vi.fn();
    const alive = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    await restartDaemon({
      port: 5, pidFilePath: pidPath, spawnTimeoutMs: 1, _platform: "darwin", _isProcessAliveOverride: alive,
      _isManagedProcessOverride: () => true, _killOverride: injectedKill, _sleepOverride: async () => {},
      _ensureDaemonOverride: async () => ({ connected: false, port: 5, spawned: true }),
    });
    expect(injectedKill).toHaveBeenCalledWith(23, "SIGTERM");
  });

  it("uses the injected ensure kill function for a version mismatch", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const dir = temp(); const procRoot = join(dir, "proc"); mkdirSync(procRoot);
    const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "33"); ensureAuthToken(join(dir, "daemon.token"));
    proc(procRoot, 33, "Uid:\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    let aliveState = true;
    const kill = vi.fn(() => { aliveState = false; });
    const alive = vi.fn(() => aliveState);
    await ensureDaemon({
      port: 6, pidFilePath: pidPath, spawnTimeoutMs: 1, expectedVersion: "2", _procRoot: procRoot,
      _fetchOverride: fetchHealthy(33) as never, _isProcessAliveOverride: alive, _killOverride: kill,
      _listeningPortsOverride: () => [6], _sleepOverride: async () => {}, _skipSpawn: true,
    });
    expect(kill).toHaveBeenCalledWith(33, "SIGTERM");
  });

  it("covers failed health-wait daemon results", async () => {
    const dir = temp();
    const result = await ensureDaemon({
      port: 7, pidFilePath: join(dir, "daemon.pid"), spawnTimeoutMs: 1,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
      _spawnOverride: vi.fn(() => ({ pid: undefined, once: vi.fn(), unref: vi.fn() })) as never,
      _sleepOverride: async () => {},
    });
    expect(result.connected).toBe(false);
  });

  it("covers invalid PID data and the default detached spawn implementation", async () => {
    const dir = temp(); const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "0");
    await expect(ensureDaemon({ port: 7, pidFilePath: pidPath, spawnTimeoutMs: 1, _skipSpawn: true, _fetchOverride: vi.fn().mockRejectedValue(new Error("down")) })).resolves.toMatchObject({ connected: false });

    const spawned = await ensureDaemon({
      port: 7, pidFilePath: join(dir, "spawn.pid"), spawnTimeoutMs: 1, spawnCommand: join(dir, "does-not-exist"), spawnArgs: [],
      _monotonicNowOverride: (): number => 0,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("down")), _skipHealthWait: true,
    });
    expect(spawned.spawned).toBe(true);

    const errored = await ensureDaemon({
      port: 7, pidFilePath: join(dir, "error.pid"), spawnTimeoutMs: 1,
      enforceUserManagerParent: false,
      _monotonicNowOverride: (): number => 0,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
      _spawnOverride: vi.fn(() => { throw new Error("spawn error"); }) as never, _skipHealthWait: true,
    });
    expect(errored.warning).toContain("spawn error");
  });

  it("uses restart default proc, listener, and ensure implementations", async () => {
    const dir = temp();
    for (const platform of ["linux", "darwin"] as const) {
      const pidPath = join(dir, `${platform}.pid`); writeFileSync(pidPath, "999999");
      await expect(restartDaemon({
        port: 12, pidFilePath: pidPath, spawnTimeoutMs: 1, _platform: platform, _isProcessAliveOverride: () => true,
        _linuxSsPathOverride: null,
        _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
      })).rejects.toThrow("not a verified LCM daemon");
    }
    await expect(restartDaemon({
      port: 12, pidFilePath: join(dir, "missing.pid"), spawnTimeoutMs: 1, _skipSpawn: true,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
    })).resolves.toMatchObject({ restarted: false, connected: false });

    const zeroPid = join(dir, "zero.pid"); writeFileSync(zeroPid, "0");
    await expect(restartDaemon({
      port: 12, pidFilePath: zeroPid, spawnTimeoutMs: 1, _skipSpawn: true,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
    })).resolves.toMatchObject({ restarted: false });
  });

  it("accepts a daemon whose parent is the user systemd manager", async () => {
    const dir = temp(); const root = join(dir, "proc"); mkdirSync(root);
    const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "20"); ensureAuthToken(join(dir, "daemon.token"));
    proc(root, 10, "Uid:\t1000\nPPid:\t1\n", "systemd --user");
    proc(root, 20, "Uid:\t1000\nPPid:\t10\n", "node lcm daemon start --foreground");
    const result = await ensureDaemon({
      port: 13, pidFilePath: pidPath, spawnTimeoutMs: 1, _platform: "linux", enforceUserManagerParent: true,
      _procRoot: root, _uid: 1000, _isProcessAliveOverride: () => true, _fetchOverride: fetchHealthy(20) as never,
      _listeningPortsOverride: () => [13], _monotonicNowOverride: () => 0, expectedVersion: "1",
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result.connected).toBe(true); expect(result.warning).toBeUndefined();
  });

  it("handles retry access rejection and unavailable retry parent metadata", async () => {
    const accessDir = temp(); const accessPid = join(accessDir, "daemon.pid");
    writeFileSync(accessPid, "20"); ensureAuthToken(join(accessDir, "daemon.token"));
    const accessFetch = vi.fn()
      .mockRejectedValueOnce(new Error("initial down"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1", pid: 20 }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await expect(ensureDaemon({
      port: 14, pidFilePath: accessPid, spawnTimeoutMs: 1, _fetchOverride: accessFetch,
      expectedVersion: "1", _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [14],
      _sleepOverride: async () => {}, _monotonicNowOverride: () => 0, _skipSpawn: true,
    })).resolves.toMatchObject({ connected: false });

    const parentDir = temp(); const root = join(parentDir, "proc"); mkdirSync(root);
    const parentPid = join(parentDir, "daemon.pid"); writeFileSync(parentPid, "21"); ensureAuthToken(join(parentDir, "daemon.token"));
    proc(root, 21, "Uid:\t1000\nPPid:\t10\n", "node lcm daemon start --foreground");
    await expect(ensureDaemon({
      port: 15, pidFilePath: parentPid, spawnTimeoutMs: 1, _platform: "linux", enforceUserManagerParent: true,
      _procRoot: root, _uid: 1000, _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
      _isProcessAliveOverride: () => true, _sleepOverride: async () => {}, _skipSpawn: true,
    })).resolves.toMatchObject({ connected: false });
  });

  it("refuses detached offline recovery before a live PID retry", async () => {
    const dir = temp(); const pidPath = join(dir, "daemon.pid");
    writeFileSync(pidPath, "20"); ensureAuthToken(join(dir, "daemon.token"));
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("initial down"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1", pid: 20 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1", pid: 20 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await expect(ensureDaemon({
      port: 16, pidFilePath: pidPath, spawnTimeoutMs: 1, expectedVersion: "1",
      _fetchOverride: fetch, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [16],
      _sleepOverride: async () => {}, _monotonicNowOverride: () => 0, _skipSpawn: true,
    })).resolves.toMatchObject({ connected: false, spawned: false, pid: 20, refusalReason: "detached-no-response" });
  });

  it("keeps ambient credentials outside a hermetic systemd invocation", async () => {
    const dir = temp(); const oldKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = "secret";
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(999_999);
    try {
      const result = await ensureDaemon({
        port: 9, pidFilePath: join(dir, "daemon.pid"), spawnTimeoutMs: 1, _platform: "linux", enforceUserManagerParent: true,
        _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
        _spawnOverride: vi.fn(() => ({ pid: undefined, once: vi.fn(), unref: vi.fn() })) as never, _skipHealthWait: true,
        _monotonicNowOverride: (): number => 0,
        _assertBackendPublication: () => undefined,
      });
      expect(result.warning).not.toContain("credential setup failed");
    } finally {
      getuid.mockRestore();
      if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
    }
  });

  it("covers win32 listener bypass and lsof parsing failures", async () => {
    for (const platform of ["win32", "darwin"] as const) {
      const dir = temp(); const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "44"); ensureAuthToken(join(dir, "daemon.token"));
      const spawnSync = vi.fn(() => platform === "darwin"
        ? { status: 0, stdout: "junk\nn*:bad\nn127.0.0.1:0\nn127.0.0.1:70000\nn127.0.0.1:1234 (LISTEN)\n" }
        : { status: 1, stdout: "" });
      await expect(restartDaemon({
        port: 10, pidFilePath: pidPath, spawnTimeoutMs: 1, _platform: platform,
        _isProcessAliveOverride: () => true, _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
        _spawnSyncOverride: spawnSync as never, _ensureDaemonOverride: async () => ({ connected: false, port: 10, spawned: true }),
      })).rejects.toThrow("not a verified LCM daemon");
    }

    const dir = temp(); const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "45"); ensureAuthToken(join(dir, "daemon.token"));
    await expect(restartDaemon({
      port: 10, pidFilePath: pidPath, spawnTimeoutMs: 1, _platform: "darwin", _isProcessAliveOverride: () => true,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
      _spawnSyncOverride: vi.fn(() => { throw new Error("lsof missing"); }) as never,
      _ensureDaemonOverride: async () => ({ connected: false, port: 10, spawned: true }),
    })).rejects.toThrow("not a verified LCM daemon");
  });
});
