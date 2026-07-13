import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { ensureDaemon, findUserSystemdPid, readProcessParentPid, restartDaemon } from "../../src/daemon/lifecycle.js";

const tempDirs: string[] = [];
type EnsureDaemonOptions = Parameters<typeof ensureDaemon>[0];
type FetchOverride = NonNullable<EnsureDaemonOptions["_fetchOverride"]>;
type SpawnOverride = NonNullable<EnsureDaemonOptions["_spawnOverride"]>;
type SpawnSyncOverride = NonNullable<EnsureDaemonOptions["_spawnSyncOverride"]>;
type SpawnChildMock = {
  pid: number | undefined;
  unref: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
};

function makeSpawnChild(pid: number | undefined): SpawnChildMock {
  const child: SpawnChildMock = {
    pid,
    unref: vi.fn(),
    once: vi.fn(),
  };
  child.once.mockReturnValue(child);
  return child;
}

function userRuntimeBaseDir(): string | undefined {
  if (typeof process.getuid !== "function") return undefined;
  const baseDir = `/run/user/${process.getuid()}`;
  try {
    if (!existsSync(baseDir)) return undefined;
    const probeDir = mkdtempSync(join(baseDir, "lcm-lifecycle-probe-"));
    rmSync(probeDir, { recursive: true, force: true });
    return baseDir;
  } catch {
    return undefined;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeProcEntry(procRoot: string, pid: number, status: string, cmdline: string): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status"), status);
  writeFileSync(join(dir, "cmdline"), cmdline.replaceAll(" ", "\0"));
}

describe("ensureDaemon", () => {
  it("finds the current user systemd manager and process parent from procfs", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-proc-"));
    tempDirs.push(tempDir);

    writeProcEntry(tempDir, 100, "Name:\tsystemd\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "/usr/lib/systemd/systemd --user --deserialize=10");
    writeProcEntry(tempDir, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t100\n", "node lcm daemon start --foreground");
    writeProcEntry(tempDir, 300, "Name:\tsystemd\nUid:\t1001\t1001\t1001\t1001\nPPid:\t1\n", "/usr/lib/systemd/systemd --user");

    expect(findUserSystemdPid({ procRoot: tempDir, uid: 1000 })).toBe(100);
    expect(readProcessParentPid(200, tempDir)).toBe(100);

    rmSync(join(tempDir, "100"), { recursive: true, force: true });
    expect(findUserSystemdPid({ procRoot: tempDir, uid: 1000 })).toBe(100);
  });

  it("returns null when procfs status data is unavailable", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-missing-proc-"));
    tempDirs.push(tempDir);

    expect(readProcessParentPid(999, tempDir)).toBeNull();
    expect(findUserSystemdPid({ procRoot: join(tempDir, "missing"), uid: 1000 })).toBeNull();
    expect(findUserSystemdPid({ procRoot: tempDir, uid: 1000 })).toBeNull();
  });

  it("connects to existing healthy daemon", async () => {
    const { createDaemon } = await import("../../src/daemon/server.js");
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    const { ensureAuthToken } = await import("../../src/daemon/auth.js");
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    ensureAuthToken(tokenFile);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.daemon.idleTimeoutMs = 0;
    const daemon = await createDaemon(config, { tokenPath: tokenFile });
    const port = daemon.address().port;

    try {
      const result = await ensureDaemon({
        port,
        pidFilePath: pidFile,
        spawnTimeoutMs: 5000,
        _skipSpawn: true,
      });
      expect(result.connected).toBe(true);
      expect(result.port).toBe(port);
      expect(result.spawned).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it("does not connect when health passes but authenticated routes reject the local token", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-auth-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(tokenFile, "local-token");

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok", version: "1.2.3", uptime: 100 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: "unauthorized" }),
      } as Response);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _skipSpawn: true,
      _fetchOverride: mockFetch as FetchOverride,
    });

    expect(result.connected).toBe(false);
    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://127.0.0.1:19999/stats/pool", {
      headers: { Authorization: "Bearer local-token" },
    });
  });

  it("reuses the healthy daemon access probe on the existing-daemon fast path", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-access-probe-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(tokenFile, "local-token");

    const mockFetch = vi.fn().mockImplementation(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", version: "1.2.3", uptime: 100 }) } as Response;
      }
      if (url.endsWith("/stats/pool")) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      return { ok: false, json: async () => ({ error: "unexpected" }) } as Response;
    });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _skipSpawn: true,
      _fetchOverride: mockFetch as FetchOverride,
    });

    expect(result.connected).toBe(true);
    expect(mockFetch.mock.calls.filter(([url]: [unknown, ...unknown[]]): boolean => String(url).endsWith("/stats/pool"))).toHaveLength(1);
  });

  it("terminates a PID-file daemon when retry health reports the wrong version", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-retry-version-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(pidFile, "200");
    writeFileSync(tokenFile, "local-token");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");

    let healthCalls = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        healthCalls += 1;
        if (healthCalls === 1) return { ok: false, json: async () => ({ error: "not ready" }) } as Response;
        return { ok: true, json: async () => ({ status: "ok", version: "0.0.0", uptime: 100 }) } as Response;
      }
      if (url.endsWith("/stats/pool")) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      return { ok: false, json: async () => ({ error: "unexpected" }) } as Response;
    });
    const killMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _skipSpawn: true,
      _fetchOverride: mockFetch as FetchOverride,
      _killOverride: killMock,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: procRoot,
    });

    expect(result.connected).toBe(false);
    expect(killMock).toHaveBeenCalledWith(200, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(200, "SIGKILL");
  });

  it("does not assume access when the local token file is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-missing-token-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok", version: "1.2.3", uptime: 100 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: "unauthorized" }),
      } as Response);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _skipSpawn: true,
      _fetchOverride: mockFetch as FetchOverride,
    });

    expect(result.connected).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not report spawned daemon connected when an occupied port still rejects the local token", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-auth-spawn-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(tokenFile, "local-token");

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/stats/pool")) {
        return { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) } as Response;
      }
      return { ok: true, json: async () => ({ status: "ok", version: "1.2.3", uptime: 100 }) } as Response;
    });
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(12345));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _fetchOverride: mockFetch as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
    });

    expect(result.connected).toBe(false);
    expect(result.spawned).toBe(true);
    expect(spawnMock).toHaveBeenCalled();
  });

  it("starts via user systemd when parent enforcement is requested on Linux", async (context: TestContext): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-systemd-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const runtimeBaseDir = userRuntimeBaseDir();
    if (runtimeBaseDir === undefined) {
      context.skip();
      return;
    }
    const oldCredentialDir = mkdtempSync(join(runtimeBaseDir, "lcm-systemd-credentials-old-"));
    tempDirs.push(oldCredentialDir);
    writeFileSync(join(oldCredentialDir, "ANTHROPIC_API_KEY"), "old");
    const oldDate = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(oldCredentialDir, oldDate, oldDate);
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const spawnMock = vi.fn();
    const originalProvider = process.env.LCM_SUMMARY_PROVIDER;
    const originalSummaryApiKey = process.env.LCM_SUMMARY_API_KEY;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    const originalUnrelated = process.env.UNRELATED_DAEMON_VALUE;
    const originalPath = process.env.PATH;
    process.env.LCM_SUMMARY_PROVIDER = "anthropic";
    process.env.LCM_SUMMARY_API_KEY = "sk-lcm-test";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.OPENAI_API_KEY;
    process.env.UNRELATED_DAEMON_VALUE = "ignored";
    process.env.PATH = "/opt/lcm-test/bin:/usr/bin";

    try {
      const result = await ensureDaemon({
        port: 19999,
        pidFilePath: pidFile,
        spawnTimeoutMs: 100,
        spawnCommand: "node",
        spawnArgs: ["/path/lcm.js", "daemon", "start", "--foreground"],
        enforceUserManagerParent: true,
        _platform: "linux",
        _skipHealthWait: true,
        _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
        _spawnOverride: spawnMock as unknown as SpawnOverride,
      });

      expect(result.startMethod).toBe("systemd-user");
      expect(spawnMock).not.toHaveBeenCalled();
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "systemd-run",
        expect.arrayContaining([
          "--user",
          "--collect",
          "--no-block",
          "--setenv=PATH=/opt/lcm-test/bin:/usr/bin",
          "--setenv=LCM_SUMMARY_PROVIDER=anthropic",
          "--setenv=LCM_SYSTEMD_CRED_IDS=ANTHROPIC_API_KEY,LCM_SUMMARY_API_KEY",
          "node",
          "/path/lcm.js",
          "daemon",
          "start",
          "--foreground",
        ]),
        expect.objectContaining({ encoding: "utf-8", timeout: 100 }),
      );
      const systemdArgs = spawnSyncMock.mock.calls[0][1] as string[];
      const joinedArgs = systemdArgs.join("\n");
      expect(joinedArgs).not.toContain("sk-test");
      expect(joinedArgs).not.toContain("sk-lcm-test");
      expect(systemdArgs).not.toContain("--setenv=UNRELATED_DAEMON_VALUE=ignored");
      const credentialArgs = systemdArgs.filter((arg) => arg.startsWith("--property=LoadCredential="));
      expect(credentialArgs).toEqual([
        expect.stringContaining("ANTHROPIC_API_KEY:"),
        expect.stringContaining("LCM_SUMMARY_API_KEY:"),
      ]);
      for (const arg of credentialArgs) {
        const [, credentialPath] = arg.split(":", 2);
        expect(existsSync(credentialPath)).toBe(false);
        expect(existsSync(dirname(credentialPath))).toBe(false);
      }
      expect(existsSync(oldCredentialDir)).toBe(false);
    } finally {
      if (originalProvider === undefined) delete process.env.LCM_SUMMARY_PROVIDER;
      else process.env.LCM_SUMMARY_PROVIDER = originalProvider;
      if (originalSummaryApiKey === undefined) delete process.env.LCM_SUMMARY_API_KEY;
      else process.env.LCM_SUMMARY_API_KEY = originalSummaryApiKey;
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalApiKey;
      if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      if (originalUnrelated === undefined) delete process.env.UNRELATED_DAEMON_VALUE;
      else process.env.UNRELATED_DAEMON_VALUE = originalUnrelated;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("falls back to detached spawn with a Linux parent-invariant warning when systemd-run fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-systemd-fallback-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "No medium found" });
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(12345));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      spawnCommand: "node",
      spawnArgs: ["/path/lcm.js", "daemon", "start", "--foreground"],
      enforceUserManagerParent: true,
      _platform: "linux",
      _skipHealthWait: true,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
    });

    expect(result.startMethod).toBe("detached-spawn");
    expect(result.warning).toContain("daemon parent invariant is not satisfied");
    expect(spawnMock).toHaveBeenCalled();
  });

  it("surfaces detached spawn errors without throwing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-spawn-error-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const child: SpawnChildMock = {
      pid: undefined,
      unref: vi.fn(),
      once: vi.fn((_event: string, handler: (err: Error) => void) => {
        handler(new Error("spawn ENOENT"));
        return child;
      }),
    };
    const spawnMock = vi.fn().mockReturnValue(child);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      spawnCommand: "missing-lcm",
      spawnArgs: ["daemon", "start"],
      _skipHealthWait: true,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
    });

    expect(result.connected).toBe(false);
    expect(result.warning).toContain("detached spawn failed (spawn ENOENT)");
    expect(child.once).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.unref).toHaveBeenCalled();
  });

  it("kills and restarts an authenticated daemon with the wrong Linux parent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-wrong-parent-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(tokenFile, "local-token");
    writeFileSync(pidFile, "200");
    writeProcEntry(procRoot, 100, "Name:\tsystemd\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "/usr/lib/systemd/systemd --user");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response);
    const killMock = vi.fn();
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      enforceUserManagerParent: true,
      _platform: "linux",
      _procRoot: procRoot,
      _uid: 1000,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _isProcessAliveOverride: () => true,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _skipHealthWait: true,
    });

    expect(result.restartedForParent).toBe(true);
    expect(result.startMethod).toBe("systemd-user");
    expect(killMock).toHaveBeenCalledWith(200, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(200, "SIGKILL");
  });

  it("accepts a daemon with a warning when user systemd cannot be found", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-no-systemd-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(tokenFile, "local-token");
    writeFileSync(pidFile, "200");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      enforceUserManagerParent: true,
      _platform: "linux",
      _procRoot: procRoot,
      _uid: 1000,
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: () => true,
      _skipSpawn: true,
    });

    expect(result.connected).toBe(true);
    expect(result.warning).toContain("user systemd manager unavailable");
    expect(result.pid).toBe(200);
  });

  it("accepts an authenticated daemon with a warning when the PID file is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-no-pid-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(tokenFile, "local-token");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response);
    const spawnSyncMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      enforceUserManagerParent: true,
      _platform: "linux",
      _procRoot: procRoot,
      _uid: 1000,
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: () => true,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _skipSpawn: true,
    });

    expect(result.connected).toBe(true);
    expect(result.warning).toContain("daemon PID file missing");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("retries a live PID file process and restarts it when the parent is wrong", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-pid-retry-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(tokenFile, "local-token");
    writeFileSync(pidFile, "200");
    writeProcEntry(procRoot, 100, "Name:\tsystemd\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "/usr/lib/systemd/systemd --user");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response);
    const killMock = vi.fn();
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      enforceUserManagerParent: true,
      _platform: "linux",
      _procRoot: procRoot,
      _uid: 1000,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _isProcessAliveOverride: () => true,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _skipHealthWait: true,
    });

    expect(result.restartedForParent).toBe(true);
    expect(result.startMethod).toBe("systemd-user");
    expect(killMock).toHaveBeenCalledWith(200, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(200, "SIGKILL");
  });

  it("does not kill an unrelated live process from a stale PID file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-stale-unrelated-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(tokenFile, "local-token");
    writeFileSync(pidFile, "200");
    writeProcEntry(procRoot, 100, "Name:\tsystemd\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "/usr/lib/systemd/systemd --user");
    writeProcEntry(procRoot, 200, "Name:\tsleep\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "sleep 1000");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response);
    const killMock = vi.fn();
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      enforceUserManagerParent: true,
      _platform: "linux",
      _procRoot: procRoot,
      _uid: 1000,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _isProcessAliveOverride: () => true,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _skipHealthWait: true,
    });

    expect(result.connected).toBe(true);
    expect(result.restartedForParent).toBe(false);
    expect(result.startMethod).toBe("existing");
    expect(result.warning).toContain("daemon PID 200 is not an LCM daemon");
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("does not kill an unrelated PID-file process during version mismatch repair", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-version-stale-pid-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(tokenFile, "local-token");
    writeFileSync(pidFile, "200");
    writeProcEntry(procRoot, 200, "Name:\tsleep\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "sleep 1000");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "0.0.1" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response);
    const killMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      enforceUserManagerParent: true,
      _platform: "linux",
      _procRoot: procRoot,
      _uid: 1000,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _isProcessAliveOverride: () => true,
      _skipSpawn: true,
    });

    expect(result.connected).toBe(false);
    expect(killMock).not.toHaveBeenCalled();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("treats access check failures as unavailable", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-access-error-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(tokenFile, "local-token");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3" }) } as Response)
      .mockRejectedValueOnce(new Error("connection reset"));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
    });

    expect(result.connected).toBe(false);
  });

  it("does not accept an unversioned daemon when an expected version is required", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-missing-version-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(tokenFile, "local-token");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
    });

    expect(result.connected).toBe(false);
  });

  it("returns connected=false when daemon is not running and spawn is skipped", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-no-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 1000,
      _skipSpawn: true,
    });
    expect(result.connected).toBe(false);
  });

  it("cleans up stale PID file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-stale-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "99999999");

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 1000,
      _skipSpawn: true,
    });

    expect(result.connected).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("detects version mismatch and returns not connected when spawn skipped", async () => {
    const { createDaemon } = await import("../../src/daemon/server.js");
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.daemon.idleTimeoutMs = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-ver-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");

    try {
      const result = await ensureDaemon({
        port,
        pidFilePath: pidFile,
        spawnTimeoutMs: 1000,
        expectedVersion: "99.99.99", // doesn't match running daemon
        _skipSpawn: true,
      });
      // With _skipSpawn, it kills old daemon but can't spawn new → connected=false
      expect(result.connected).toBe(false);
    } finally {
      // daemon may have been killed by version mismatch logic
      try { await daemon.stop(); } catch { /* may already be stopped */ }
    }
  });

  it("does not connect when health wait returns a daemon with mismatched version", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-healthver-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    // Stale PID — process.kill will fail silently
    writeFileSync(pidFile, "9999999");

    // Simulate an old wrong-version daemon that is permanently running (always answers health)
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok", version: "0.0.0", uptime: 100 }),
    } as Response);

    // Spawn override does nothing (simulates new process failing to bind occupied port)
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(undefined));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 600,
      expectedVersion: "99.99.99",
      _fetchOverride: mockFetch as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
    });

    // Must NOT connect to the daemon that answered with wrong version
    expect(result.connected).toBe(false);
  });

  it("spawns a caller-specified command instead of process.argv[1] when provided", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-spawn-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(12345));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      spawnCommand: "lcm",
      spawnArgs: ["daemon", "start"],
      _skipHealthWait: true,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
    });

    expect(result.connected).toBe(false);
    expect(result.spawned).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "lcm",
      ["daemon", "start"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });
});

describe("restartDaemon", () => {
  it("validates before stopping a verified running daemon and starts with the new port", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-running-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    let alive = true;
    const order: string[] = [];
    const killMock = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      order.push(String(signal));
      alive = false;
    });
    const ensureMock = vi.fn(async (options: EnsureDaemonOptions) => {
      order.push(`ensure:${options.port}`);
      return { connected: true, port: options.port, spawned: true };
    });

    const result = await restartDaemon({
      port: 4545,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      validateBeforeRestart: () => { order.push("validate"); },
      _isProcessAliveOverride: () => alive,
      _isManagedProcessOverride: () => true,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _ensureDaemonOverride: ensureMock,
    });

    expect(order).toEqual(["validate", "SIGTERM", "ensure:4545"]);
    expect(result).toMatchObject({ connected: true, port: 4545, restarted: true, stoppedPid: 4242 });
    expect(existsSync(pidFile)).toBe(false);
  });

  it("starts when the PID file is absent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-absent-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const ensureMock = vi.fn(async (options: EnsureDaemonOptions) => ({
      connected: true,
      port: options.port,
      spawned: true,
    }));

    const result = await restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      _ensureDaemonOverride: ensureMock,
    });

    expect(result).toMatchObject({ connected: true, spawned: true, restarted: false });
    expect(ensureMock).toHaveBeenCalledOnce();
  });

  it("refuses to claim a restart when a daemon is reachable without a verified PID", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-unverified-existing-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const ensureMock = vi.fn(async (options: EnsureDaemonOptions) => ({
      connected: true,
      port: options.port,
      spawned: false,
    }));

    await expect(restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      _ensureDaemonOverride: ensureMock,
    })).rejects.toThrow("no verified daemon PID was available");
  });

  it("cleans a stale PID file before starting", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-stale-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    const ensureMock = vi.fn(async (options: EnsureDaemonOptions) => ({
      connected: false,
      port: options.port,
      spawned: true,
    }));

    const result = await restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      _isProcessAliveOverride: () => false,
      _ensureDaemonOverride: ensureMock,
    });

    expect(result.restarted).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
    expect(ensureMock).toHaveBeenCalledOnce();
  });

  it("restarts an older non-Linux daemon after matching its authenticated health PID", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-darwin-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    let alive = true;
    const killMock = vi.fn(() => { alive = false; });
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", version: "1.0.0", pid: 4242 }) } as Response;
      }
      expect(init?.headers).toEqual({ Authorization: "Bearer local-token" });
      return { ok: true, json: async () => ({}) } as Response;
    });
    const ensureMock = vi.fn(async (options: EnsureDaemonOptions) => ({
      connected: true,
      port: options.port,
      spawned: true,
    }));

    const result = await restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "2.0.0",
      _platform: "darwin",
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: () => alive,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _ensureDaemonOverride: ensureMock,
    });

    expect(result).toMatchObject({ connected: true, restarted: true, stoppedPid: 4242 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(killMock).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: "2.0.0" }));
  });

  it("refuses a non-Linux restart when protected-route authentication fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-darwin-auth-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    const killMock = vi.fn();
    const ensureMock = vi.fn();
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "" });
    const fetchMock = vi.fn().mockImplementation(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 4242 }) } as Response;
      }
      return { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) } as Response;
    });

    await expect(restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _platform: "darwin",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _isProcessAliveOverride: () => true,
      _killOverride: killMock,
      _ensureDaemonOverride: ensureMock,
    })).rejects.toThrow("not a verified LCM daemon");

    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("refuses to signal a reused non-Linux PID that does not own the authenticated daemon", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-darwin-pid-mismatch-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    const killMock = vi.fn();
    const ensureMock = vi.fn();
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "" });
    const fetchMock = vi.fn().mockImplementation(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 9999 }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    await expect(restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      _platform: "darwin",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _isProcessAliveOverride: () => true,
      _killOverride: killMock,
      _ensureDaemonOverride: ensureMock,
    })).rejects.toThrow("not a verified LCM daemon");

    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("binds an older non-Linux daemon without a health PID to its owned listener", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-darwin-legacy-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    let alive = true;
    const killMock = vi.fn(() => { alive = false; });
    const fetchMock = vi.fn().mockImplementation(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", version: "1.0.0" }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    const spawnSyncMock = vi.fn().mockReturnValue({
      status: 0,
      stdout: "p4242\nn127.0.0.1:19999 (LISTEN)\n",
      stderr: "",
    });
    const ensureMock = vi.fn(async (options: EnsureDaemonOptions) => ({
      connected: true,
      port: options.port,
      spawned: true,
    }));

    const result = await restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "2.0.0",
      _platform: "darwin",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _isProcessAliveOverride: () => alive,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _ensureDaemonOverride: ensureMock,
    });

    expect(result.restarted).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-p", "4242", "-iTCP", "-sTCP:LISTEN", "-Fn"],
      expect.objectContaining({ encoding: "utf-8", timeout: 1000, maxBuffer: 64 * 1024 }),
    );
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: "2.0.0" }));
  });

  it("restarts a non-Linux daemon on its owned old listener after the configured port changes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-darwin-port-change-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    let alive = true;
    const killMock = vi.fn(() => { alive = false; });
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit): Promise<Response> => {
      const parsed = new URL(url);
      if (parsed.port === "20000") throw new Error("new port is not listening yet");
      if (parsed.pathname === "/health") {
        return { ok: true, json: async () => ({ status: "ok", version: "1.0.0", pid: 4242 }) } as Response;
      }
      expect(parsed.port).toBe("19999");
      expect(init?.headers).toEqual({ Authorization: "Bearer local-token" });
      return { ok: true, json: async () => ({}) } as Response;
    });
    const spawnSyncMock = vi.fn().mockReturnValue({
      status: 0,
      stdout: "p4242\nn127.0.0.1:19999\n",
      stderr: "",
    });
    const ensureMock = vi.fn(async (options: EnsureDaemonOptions) => ({
      connected: true,
      port: options.port,
      spawned: true,
    }));

    const result = await restartDaemon({
      port: 20000,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "2.0.0",
      _platform: "darwin",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _isProcessAliveOverride: () => alive,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _ensureDaemonOverride: ensureMock,
    });

    expect(result).toMatchObject({ restarted: true, stoppedPid: 4242, port: 20000 });
    expect(killMock).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ port: 20000, expectedVersion: "2.0.0" }));
  });

  it("refuses a legacy non-Linux daemon when the authenticated port is not owned by the pidfile PID", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-darwin-listener-mismatch-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    const killMock = vi.fn();
    const ensureMock = vi.fn();
    const fetchMock = vi.fn().mockImplementation(async (url: string): Promise<Response> => {
      const parsed = new URL(url);
      if (parsed.port === "19999") {
        return { ok: true, json: async () => ({ status: "ok", version: "1.0.0" }) } as Response;
      }
      throw new Error("pidfile process listener is not an LCM daemon");
    });
    const spawnSyncMock = vi.fn().mockReturnValue({
      status: 0,
      stdout: "p4242\nn127.0.0.1:18888\n",
      stderr: "",
    });

    await expect(restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      _platform: "darwin",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _isProcessAliveOverride: () => true,
      _killOverride: killMock,
      _ensureDaemonOverride: ensureMock,
    })).rejects.toThrow("not a verified LCM daemon");

    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("retains procfs identity verification on Linux", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-linux-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    writeProcEntry(procRoot, 4242, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    let alive = true;
    const killMock = vi.fn(() => { alive = false; });
    const fetchMock = vi.fn();
    const ensureMock = vi.fn(async (options: EnsureDaemonOptions) => ({
      connected: true,
      port: options.port,
      spawned: true,
    }));

    const result = await restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      _platform: "linux",
      _procRoot: procRoot,
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: () => alive,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _ensureDaemonOverride: ensureMock,
    });

    expect(result.restarted).toBe(true);
    expect(killMock).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to signal or start when a live PID is not a verified daemon", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-refuse-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    const killMock = vi.fn();
    const ensureMock = vi.fn();

    await expect(restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      _isProcessAliveOverride: () => true,
      _isManagedProcessOverride: () => false,
      _killOverride: killMock,
      _ensureDaemonOverride: ensureMock,
    })).rejects.toThrow("not a verified LCM daemon");

    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("4242");
  });

  it("does not signal or start when pre-restart validation fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-validation-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    const killMock = vi.fn();
    const ensureMock = vi.fn();

    await expect(restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      validateBeforeRestart: () => { throw new Error("invalid config"); },
      _isProcessAliveOverride: () => true,
      _isManagedProcessOverride: () => true,
      _killOverride: killMock,
      _ensureDaemonOverride: ensureMock,
    })).rejects.toThrow("invalid config");

    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });
});
