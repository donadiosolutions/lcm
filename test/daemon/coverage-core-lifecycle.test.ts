import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAuthToken } from "../../src/daemon/auth.js";
import { __lifecycleTestUtils, ensureDaemon, findUserSystemdPid, readProcessParentPid, restartDaemon } from "../../src/daemon/lifecycle.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "lcm-core-life-")); dirs.push(d); return d; };
const proc = (root: string, pid: number, status: string, command?: string) => {
  const dir = join(root, String(pid)); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status"), status);
  if (command !== undefined) writeFileSync(join(dir, "cmdline"), command.replaceAll(" ", "\0"));
};
const fetchHealthy = (pid?: number) => vi.fn(async (url: string) => url.endsWith("/health")
  ? { ok: true, json: async () => ({ status: "ok", version: "1", pid }) }
  : { ok: true, json: async () => ({}) });

describe("lifecycle procfs and parent warnings", () => {
  it("covers internal platform parsing, parent equality, warning fallback, and environment shaping", () => {
    const many = Array.from({ length: 40 }, (_, index) => `n127.0.0.1:${1000 + index}`).join("\n");
    const spawnSync = vi.fn(() => ({ status: 0, stdout: many }));
    expect(__lifecycleTestUtils.findListeningTcpPorts(1, "linux", spawnSync as never)).toHaveLength(32);
    expect(spawnSync).toHaveBeenCalledWith("lsof", expect.any(Array), expect.any(Object));
    expect(__lifecycleTestUtils.findListeningTcpPorts(1, "darwin", vi.fn(() => ({ status: 1, stdout: "" })) as never)).toEqual([]);
    expect(__lifecycleTestUtils.findListeningTcpPorts(1, "win32", vi.fn() as never)).toEqual([]);

    expect(__lifecycleTestUtils.parentInvariantWarning({ satisfies: false, available: true, reason: "wrong-parent" })).toBe("daemon parent invariant is not verified");
    expect(__lifecycleTestUtils.systemdDaemonSetenvArgs({ PATH: "/bin", LCM_MODE: "x", OTHER: "y", OPENAI_API_KEY: "secret", EMPTY: undefined }, [])).toEqual([
      "--setenv=LCM_MODE=x", "--setenv=PATH=/bin",
    ]);
    expect(__lifecycleTestUtils.systemdDaemonSetenvArgs({ PATH: "/bin" }, ["OPENAI_API_KEY"])).toContain("--setenv=LCM_SYSTEMD_CRED_IDS=OPENAI_API_KEY");
    expect(__lifecycleTestUtils.systemdRunProcessEnv({ PATH: "/bin", TOKEN: "secret", SAFE: "yes" })).toEqual({ PATH: "/bin", SAFE: "yes" });
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
  });

  it.each([
    ["dead", false, "node lcm daemon start --foreground", "PPid:\t1\n", "not running"],
    ["wrong", true, "node other", "PPid:\t1\n", "not an LCM daemon"],
    ["parent", true, "node lcm daemon start --foreground", "Uid:\t1000\n", "parent could not be read"],
  ])("returns an authenticated warning for %s PID metadata", async (_name, alive, command, daemonStatus, warning) => {
    const dir = temp(); const procRoot = join(dir, "proc"); mkdirSync(procRoot);
    const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "20"); ensureAuthToken(join(dir, "daemon.token"));
    proc(procRoot, 10, "Uid:\t1000\nPPid:\t1\n", "systemd --user");
    proc(procRoot, 20, daemonStatus, command);
    const result = await ensureDaemon({
      port: 1, pidFilePath: pidPath, spawnTimeoutMs: 1, enforceUserManagerParent: true,
      _platform: "linux", _procRoot: procRoot, _uid: 1000, _fetchOverride: fetchHealthy(20) as never,
      _isProcessAliveOverride: () => alive, _skipSpawn: true,
    });
    expect(result.connected).toBe(true);
    expect(result.warning).toContain(warning);
  });

  it("handles an unavailable current uid and a missing daemon cmdline", async () => {
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(undefined as never);
    expect(findUserSystemdPid({ procRoot: temp() })).toBeNull();
    getuid.mockRestore();

    const dir = temp(); const procRoot = join(dir, "proc"); mkdirSync(procRoot);
    const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "31"); ensureAuthToken(join(dir, "daemon.token"));
    proc(procRoot, 31, "Uid:\t1000\nPPid:\t1\n");
    const result = await ensureDaemon({
      port: 1, pidFilePath: pidPath, spawnTimeoutMs: 1, enforceUserManagerParent: true,
      _platform: "linux", _procRoot: procRoot, _uid: 1000, _fetchOverride: fetchHealthy(31) as never,
      _isProcessAliveOverride: () => true, _skipSpawn: true,
    });
    expect(result.warning).toContain("not an LCM daemon");
  });
});

describe("lifecycle spawn and restart failure boundaries", () => {
  it("reports non-Error detached spawn failures and combines systemd warnings", async () => {
    const dir = temp();
    const result = await ensureDaemon({
      port: 2, pidFilePath: join(dir, "daemon.pid"), spawnTimeoutMs: 1, _platform: "linux",
      enforceUserManagerParent: true, _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
      _spawnSyncOverride: vi.fn(() => { throw "systemd"; }) as never,
      _spawnOverride: vi.fn(() => { throw "detached"; }) as never,
      _skipHealthWait: true,
    });
    expect(result.warning).toContain("systemd"); expect(result.warning).toContain("detached");
  });

  it.each([
    [{ status: 1, stderr: "stderr", stdout: "", error: undefined, signal: null }, "stderr"],
    [{ status: 1, stderr: Buffer.from("x"), stdout: "stdout", error: undefined, signal: null }, "stdout"],
    [{ status: 1, stderr: undefined, stdout: undefined, error: new Error("error"), signal: null }, "error"],
    [{ status: 1, stderr: undefined, stdout: undefined, error: undefined, signal: "SIGTERM" }, "signal SIGTERM"],
    [{ status: null, stderr: undefined, stdout: undefined, error: undefined, signal: null }, "exit status unknown"],
  ])("reports systemd-run detail from %#", async (spawnResult, detail) => {
    const dir = temp();
    const result = await ensureDaemon({
      port: 3, pidFilePath: join(dir, "daemon.pid"), spawnTimeoutMs: 1, _platform: "linux", enforceUserManagerParent: true,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("down")), _spawnSyncOverride: vi.fn(() => spawnResult) as never,
      _spawnOverride: vi.fn(() => ({ pid: undefined, once: vi.fn(), unref: vi.fn() })) as never, _skipHealthWait: true,
    });
    expect(result.warning).toContain(detail);
  });

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

  it("uses global process.kill and the default ensure override seams", async () => {
    const dir = temp(); const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "23");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const alive = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    await restartDaemon({
      port: 5, pidFilePath: pidPath, spawnTimeoutMs: 1, _platform: "darwin", _isProcessAliveOverride: alive,
      _isManagedProcessOverride: () => true, _sleepOverride: async () => {},
      _ensureDaemonOverride: async () => ({ connected: false, port: 5, spawned: true }),
    });
    expect(kill).toHaveBeenCalledWith(23, "SIGTERM");
  });

  it("uses the default ensure kill function for a version mismatch", async () => {
    const dir = temp(); const procRoot = join(dir, "proc"); mkdirSync(procRoot);
    const pidPath = join(dir, "daemon.pid"); writeFileSync(pidPath, "33"); ensureAuthToken(join(dir, "daemon.token"));
    proc(procRoot, 33, "Uid:\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const alive = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    await ensureDaemon({
      port: 6, pidFilePath: pidPath, spawnTimeoutMs: 1, expectedVersion: "2", _procRoot: procRoot,
      _fetchOverride: fetchHealthy(33) as never, _isProcessAliveOverride: alive, _sleepOverride: async () => {}, _skipSpawn: true,
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
      _fetchOverride: vi.fn().mockRejectedValue(new Error("down")), _skipHealthWait: true,
    });
    expect(spawned.spawned).toBe(true);

    const errored = await ensureDaemon({
      port: 7, pidFilePath: join(dir, "error.pid"), spawnTimeoutMs: 1,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
      _spawnOverride: vi.fn(() => { throw new Error("spawn error"); }) as never, _skipHealthWait: true,
    });
    expect(errored.warning).toContain("spawn error");
  });

  it("combines systemd and detached errors after health wait expires", async () => {
    const dir = temp();
    const child = { pid: undefined, unref: vi.fn(), once: vi.fn((_event: string, callback: (error: Error) => void) => { callback(new Error("async spawn")); }) };
    const result = await ensureDaemon({
      port: 11, pidFilePath: join(dir, "daemon.pid"), spawnTimeoutMs: 1, _platform: "linux", enforceUserManagerParent: true,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("down")), _spawnSyncOverride: vi.fn(() => ({ status: 1 })) as never,
      _spawnOverride: vi.fn(() => child) as never, _sleepOverride: async () => {},
    });
    expect(result.warning).toContain("async spawn");
  });

  it("uses restart default proc, listener, and ensure implementations", async () => {
    const dir = temp();
    for (const platform of ["linux", "darwin"] as const) {
      const pidPath = join(dir, `${platform}.pid`); writeFileSync(pidPath, "999999");
      await expect(restartDaemon({
        port: 12, pidFilePath: pidPath, spawnTimeoutMs: 1, _platform: platform, _isProcessAliveOverride: () => true,
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
    });
    expect(result.connected).toBe(true); expect(result.warning).toBeUndefined();
  });

  it("handles retry access rejection and unavailable retry parent metadata", async () => {
    const accessDir = temp(); const accessPid = join(accessDir, "daemon.pid");
    writeFileSync(accessPid, "20"); ensureAuthToken(join(accessDir, "daemon.token"));
    const accessFetch = vi.fn()
      .mockRejectedValueOnce(new Error("initial down"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok" }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await expect(ensureDaemon({
      port: 14, pidFilePath: accessPid, spawnTimeoutMs: 1, _fetchOverride: accessFetch,
      _isProcessAliveOverride: () => true, _sleepOverride: async () => {}, _skipSpawn: true,
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

  it("reports systemd credential setup errors when the user runtime directory is unavailable", async () => {
    const dir = temp(); const oldKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = "secret";
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(999_999);
    try {
      const result = await ensureDaemon({
        port: 9, pidFilePath: join(dir, "daemon.pid"), spawnTimeoutMs: 1, _platform: "linux", enforceUserManagerParent: true,
        _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
        _spawnOverride: vi.fn(() => ({ pid: undefined, once: vi.fn(), unref: vi.fn() })) as never, _skipHealthWait: true,
        _monotonicNowOverride: (): number => 0,
      });
      expect(result.warning).toContain("credential setup failed");
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
