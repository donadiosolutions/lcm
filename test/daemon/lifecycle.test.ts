import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAuthToken } from "../../src/daemon/auth.js";
import { loadDaemonConfig, parseDaemonConfig } from "../../src/daemon/config.js";
import { ensureDaemon, findUserSystemdPid, readProcessParentPid, restartDaemon } from "../../src/daemon/lifecycle.js";
import { createDaemon } from "../../src/daemon/server.js";

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
  it("fails closed without inspecting or mutating PID state when the expected version is unknown", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-unknown-version-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    const fetchMock = vi.fn();
    const killMock = vi.fn();
    const listenerMock = vi.fn();

    await expect(ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "",
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _listeningPortsOverride: listenerMock,
    })).resolves.toMatchObject({ connected: false, spawned: false, warning: expect.stringContaining("version is unknown") });

    expect(readFileSync(pidFile, "utf-8")).toBe("4242");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
    expect(listenerMock).not.toHaveBeenCalled();
  });
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
    writeFileSync(pidFile, String(process.pid));

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
  }, 10_000);

  it("accepts an authenticated staged PostgreSQL daemon with sanitized 503 readiness", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-staged-postgresql-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    const fetchMock = vi.fn().mockImplementation(async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      if (url.endsWith("/health")) {
        if (!init?.headers) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: "ok",
              version: "1.2.3",
              storageBackend: "postgresql",
              uptime: 10,
              pid: 4242,
            }),
          } as Response;
        }
        return {
          ok: false,
          status: 503,
          json: async () => ({
            status: "unavailable",
            version: "1.2.3",
            storageBackend: "postgresql",
            uptime: 10,
            pid: 4242,
            storage: {
              status: "unavailable",
              error: {
                code: "STORAGE_INITIALIZATION_FAILED",
                backend: "postgresql",
                domain: "factory",
                operation: "health",
              },
            },
          }),
        } as Response;
      }
      return {
        ok: false,
        status: 503,
        json: async () => ({
          code: "STORAGE_BACKEND_STAGED",
          error: "human-readable wording is not an authentication contract",
          storageBackend: "postgresql",
        }),
      } as Response;
    });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({ connected: true, spawned: false, pid: 4242 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:19999/health",
      { signal: expect.any(AbortSignal) },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:19999/health",
      {
        headers: { Authorization: "Bearer local-token" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it.each([
    ["missing code", {
      error: "pool stats is unavailable while PostgreSQL storage repositories are staged",
      storageBackend: "postgresql",
    }],
    ["wrong code", {
      code: "OTHER",
      error: "pool stats is unavailable while PostgreSQL storage repositories are staged",
      storageBackend: "postgresql",
    }],
    ["wrong backend", {
      code: "STORAGE_BACKEND_STAGED",
      error: "pool stats is unavailable while PostgreSQL storage repositories are staged",
      storageBackend: "sqlite",
    }],
  ])("rejects staged PostgreSQL access with %s", async (_case, accessBody) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-staged-access-invalid-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    const fetchMock = vi.fn().mockImplementation(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        return {
          ok: false,
          status: 503,
          json: async () => ({
            status: "unavailable",
            version: "1.2.3",
            storageBackend: "postgresql",
            uptime: 10,
            pid: 4242,
            storage: {
              status: "unavailable",
              error: {
                code: "STORAGE_INITIALIZATION_FAILED",
                backend: "postgresql",
                domain: "factory",
                operation: "health",
              },
            },
          }),
        } as Response;
      }
      return {
        ok: false,
        status: 503,
        json: async () => accessBody,
      } as Response;
    });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
      _sleepOverride: async (): Promise<void> => {},
    });

    expect(result.connected).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/stats/pool")))
      .toBe(true);
  });

  it("rejects malformed staged PostgreSQL 503 readiness", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-malformed-postgresql-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        status: "unavailable",
        version: "1.2.3",
        storageBackend: "postgresql",
        pid: 4242,
        storage: { status: "unavailable", error: { code: "wrong" } },
      }),
    } as Response);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result.connected).toBe(false);
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/health"))).toBe(true);
  });

  it("rejects a non-object 503 health response", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-non-object-health-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => null,
    } as Response);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedStorageBackend: "postgresql",
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
    });

    expect(result.connected).toBe(false);
  });

  it("does not connect when health passes but authenticated routes reject the local token", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-auth-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(pidFile, "4242");
    writeFileSync(tokenFile, "local-token");

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok", version: "1.2.3", uptime: 100, pid: 4242 }),
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
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result.connected).toBe(false);
    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://127.0.0.1:19999/health", expect.objectContaining({
      headers: { Authorization: "Bearer local-token" },
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    {
      name: "health PID differs from the PID file",
      healthPid: 9999,
      healthVersion: "1.2.3",
      storageBackend: "sqlite",
      listenerPorts: [19999],
    },
    {
      name: "PID-file process does not own the configured listener",
      healthPid: 4242,
      healthVersion: "1.2.3",
      storageBackend: "sqlite",
      listenerPorts: [18888],
    },
    {
      name: "the public version is unexpected",
      healthPid: 4242,
      healthVersion: "9.9.9",
      storageBackend: "sqlite",
      listenerPorts: [19999],
    },
    {
      name: "the public backend identity is invalid",
      healthPid: 4242,
      healthVersion: "1.2.3",
      storageBackend: "invalid",
      listenerPorts: [19999],
    },
  ])("does not transmit the token when $name", async ({
    healthPid,
    healthVersion,
    storageBackend,
    listenerPorts,
  }) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-identity-reject-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "must-not-leak");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ok",
        version: healthVersion,
        storageBackend,
        pid: healthPid,
      }),
    } as Response);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => listenerPorts,
    });

    expect(result.connected).toBe(false);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).not.toHaveProperty("headers");
    }
  });

  it("reuses the healthy daemon access probe on the existing-daemon fast path", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-access-probe-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const tokenFile = join(tempDir, "daemon.token");
    writeFileSync(pidFile, "4242");
    writeFileSync(tokenFile, "local-token");

    const mockFetch = vi.fn().mockImplementation(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", version: "1.2.3", uptime: 100, pid: 4242 }) } as Response;
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
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result.connected).toBe(true);
    expect(mockFetch.mock.calls.filter(([url]: [unknown, ...unknown[]]): boolean => String(url).endsWith("/stats/pool"))).toHaveLength(1);
  });

  it("fails closed when the authenticated pool diagnostic throws", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-pool-diagnostic-error-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({
            status: "ok",
            version: "1.2.3",
            storageBackend: "sqlite",
            pid: 4242,
          }),
        } as Response;
      }
      expect(init?.headers).toEqual({ Authorization: "Bearer local-token" });
      throw new Error("pool diagnostic failed");
    });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result.connected).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/health"))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/stats/pool"))).toHaveLength(1);
  });

  it.each([false, true])(
    "rejects a healthy same-version SQLite daemon when PostgreSQL is selected (process removes PID file: %s)",
    async (processRemovesPidFile): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-storage-mismatch-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    const caFile = join(tempDir, "postgres-ca.crt");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    writeFileSync(caFile, "trusted-ca");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    const effectiveConfig = parseDaemonConfig("{}", { storage: { backend: "postgresql" } }, {
      LCM_POSTGRES_URL: "postgresql://user:secret@db.example.com/lcm",
      LCM_POSTGRES_CA_FILE: caFile,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", version: "1.2.3", storageBackend: "sqlite", pid: 200 }),
        } as Response;
      }
      expect(init?.headers).toEqual({ Authorization: "Bearer local-token" });
      return { ok: true, json: async () => ({}) } as Response;
    });
    let alive = true;
    const killMock = vi.fn((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") {
        alive = false;
        if (processRemovesPidFile) rmSync(pidFile);
      }
    });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedStorageBackend: effectiveConfig.storage.backend,
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => alive,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result.connected).toBe(false);
    expect(killMock).toHaveBeenCalledWith(200, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(200, "SIGKILL");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/stats/pool"))).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
    },
  );

  it("does not terminate a backend-mismatched daemon when local-token authentication fails", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-storage-mismatch-auth-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "wrong-token");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", version: "1.2.3", storageBackend: "sqlite", pid: 200 }),
        } as Response;
      }
      expect(init?.headers).toEqual({ Authorization: "Bearer wrong-token" });
      return { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) } as Response;
    });
    const killMock = vi.fn();
    const spawnMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _killOverride: killMock,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      warning: "daemon reuse or replacement was blocked because the storage-backend mismatch could not be authenticated or terminated safely; verify the local daemon token, stop the existing daemon if necessary, and retry",
    });
    expect(fetchMock.mock.calls.some(([, options]) =>
      (options as RequestInit | undefined)?.headers !== undefined)).toBe(true);
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
  });

  it("reuses an authenticated daemon with the same packaged-runtime digest", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-runtime-digest-match-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    const runtimeDigest = "a".repeat(64);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({
            status: "ok",
            version: "1.4.2",
            storageBackend: "sqlite",
            pid: 200,
            ...(init?.headers ? { runtimeDigest } : {}),
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ totalConnections: 0 }) } as Response;
    });
    const killMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.4.2",
      expectedStorageBackend: "sqlite",
      expectedRuntimeDigest: runtimeDigest,
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({ connected: true, spawned: false, pid: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(killMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["mismatched", "b".repeat(64)],
  ] as const)(
    "replaces an authenticated likely LCM daemon with a %s packaged-runtime digest",
    async (_case, reportedRuntimeDigest): Promise<void> => {
      const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-runtime-digest-replace-"));
      tempDirs.push(tempDir);
      const procRoot = join(tempDir, "proc");
      mkdirSync(procRoot);
      const pidFile = join(tempDir, "daemon.pid");
      writeFileSync(pidFile, "200");
      writeFileSync(join(tempDir, "daemon.token"), "local-token");
      writeProcEntry(
        procRoot,
        200,
        "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n",
        "node lcm daemon start --foreground",
      );
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        if (url.endsWith("/health")) {
          return {
            ok: true,
            json: async () => ({
              status: "ok",
              version: "1.4.2",
              storageBackend: "sqlite",
              pid: 200,
              ...(init?.headers && reportedRuntimeDigest
                ? { runtimeDigest: reportedRuntimeDigest }
                : {}),
            }),
          } as Response;
        }
        return { ok: true, json: async () => ({ totalConnections: 0 }) } as Response;
      });
      let alive = true;
      const killMock = vi.fn(() => {
        alive = false;
      });

      const result = await ensureDaemon({
        port: 19999,
        pidFilePath: pidFile,
        spawnTimeoutMs: 100,
        expectedVersion: "1.4.2",
        expectedStorageBackend: "sqlite",
        expectedRuntimeDigest: "a".repeat(64),
        _skipSpawn: true,
        _fetchOverride: fetchMock as FetchOverride,
        _killOverride: killMock,
        _sleepOverride: async (): Promise<void> => {},
        _isProcessAliveOverride: (): boolean => alive,
        _procRoot: procRoot,
        _listeningPortsOverride: (): number[] => [19999],
      });

      expect(result).toMatchObject({ connected: false, spawned: false });
      expect(killMock).toHaveBeenCalledWith(200, "SIGTERM");
      expect(existsSync(pidFile)).toBe(false);
    },
  );

  it("preserves a digest-mismatched PID when authenticated health is unavailable", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-runtime-digest-auth-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "wrong-token");
    writeProcEntry(
      procRoot,
      200,
      "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n",
      "node lcm daemon start --foreground",
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (!url.endsWith("/health")) {
        return { ok: false, status: 401 } as Response;
      }
      if (init?.headers) return { ok: false, status: 401 } as Response;
      return {
        ok: true,
        json: async () => ({
          status: "ok",
          version: "1.4.2",
          storageBackend: "sqlite",
          pid: 200,
        }),
      } as Response;
    });
    const killMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.4.2",
      expectedStorageBackend: "sqlite",
      expectedRuntimeDigest: "a".repeat(64),
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      warning: expect.stringContaining("packaged-runtime digest mismatch"),
    });
    expect(killMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
  });

  it("preserves an authenticated unrelated process on a packaged-runtime digest mismatch", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-runtime-digest-unrelated-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    writeProcEntry(
      procRoot,
      200,
      "Name:\tsleep\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n",
      "sleep 1000",
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({
            status: "ok",
            version: "1.4.2",
            storageBackend: "sqlite",
            pid: 200,
            ...(init?.headers ? { runtimeDigest: "b".repeat(64) } : {}),
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ totalConnections: 0 }) } as Response;
    });
    const killMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.4.2",
      expectedStorageBackend: "sqlite",
      expectedRuntimeDigest: "a".repeat(64),
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      warning: expect.stringContaining("packaged-runtime digest mismatch"),
    });
    expect(killMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
  });

  it("defaults to the captured packaged entrypoint when replacing a same-version daemon", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-entrypoint-mismatch-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    writeProcEntry(
      procRoot,
      200,
      "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n",
      "node\0/home/user/.claude/plugins/cache/lcm/1.4.1/lcm.mjs\0daemon\0start\0--foreground\0",
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", version: "1.4.1", storageBackend: "sqlite", pid: 200 }),
        } as Response;
      }
      expect(init?.headers).toEqual({ Authorization: "Bearer local-token" });
      return { ok: true, json: async () => ({}) } as Response;
    });
    let alive = true;
    const killMock = vi.fn(() => {
      alive = false;
    });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.4.1",
      expectedStorageBackend: "sqlite",
      _packagedEntrypointOverride: "/opt/npm/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => alive,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result.connected).toBe(false);
    expect(killMock).toHaveBeenCalledWith(200, "SIGTERM");
    expect(existsSync(pidFile)).toBe(false);
  });

  it.each(["darwin", "win32"] as const)(
    "accepts a matching health-reported entrypoint on %s without procfs",
    async (platform): Promise<void> => {
      const tempDir = mkdtempSync(join(tmpdir(), `lcm-lifecycle-${platform}-entrypoint-`));
      tempDirs.push(tempDir);
      const pidFile = join(tempDir, "daemon.pid");
      const runtimePath = platform === "win32"
        ? "C:\\npm\\node_modules\\@donadiosolutions\\lcm\\dist\\lcm.mjs"
        : "/opt/npm/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs";
      writeFileSync(pidFile, "200");
      writeFileSync(join(tempDir, "daemon.token"), "local-token");
      const fetchMock = vi.fn(async (url: string): Promise<Response> => {
        if (url.endsWith("/health")) {
          return {
            ok: true,
            json: async () => ({
              status: "ok",
              version: "1.4.1",
              storageBackend: "sqlite",
              pid: 200,
              entrypoint: runtimePath,
            }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      });

      const result = await ensureDaemon({
        port: 19999,
        pidFilePath: pidFile,
        spawnTimeoutMs: 100,
        expectedVersion: "1.4.1",
        expectedStorageBackend: "sqlite",
        expectedEntrypoint: runtimePath,
        _platform: platform,
        _procRoot: join(tempDir, "missing-proc"),
        _fetchOverride: fetchMock as FetchOverride,
        _isProcessAliveOverride: (): boolean => true,
        _listeningPortsOverride: (): number[] => [19999],
      });

      expect(result).toMatchObject({ connected: true, spawned: false, pid: 200 });
    },
  );

  it.each([
    {
      platform: "linux" as const,
      reported: "/home/alice/.npm-global/bin/lcm",
      expected: "/home/alice/.npm-global/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
      canonical: "/home/alice/.npm-global/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
    },
    {
      platform: "darwin" as const,
      reported: "/opt/homebrew/bin/lcm",
      expected: "/opt/homebrew/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
      canonical: "/opt/homebrew/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
    },
    {
      platform: "win32" as const,
      reported: "C:\\Users\\Alice\\AppData\\Roaming\\npm\\lcm.cmd",
      expected: "c:\\users\\alice\\appdata\\roaming\\npm\\node_modules\\@donadiosolutions\\lcm\\dist\\lcm.mjs",
      canonical: "C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\@donadiosolutions\\lcm\\dist\\lcm.mjs",
    },
  ])(
    "reuses a $platform daemon when npm shim and runtime entrypoints resolve identically",
    async ({ platform, reported, expected, canonical }): Promise<void> => {
      const tempDir = mkdtempSync(join(tmpdir(), `lcm-lifecycle-${platform}-symlink-entrypoint-`));
      tempDirs.push(tempDir);
      const pidFile = join(tempDir, "daemon.pid");
      writeFileSync(pidFile, "200");
      writeFileSync(join(tempDir, "daemon.token"), "local-token");
      const fetchMock = vi.fn(async (url: string): Promise<Response> => url.endsWith("/health")
        ? {
            ok: true,
            json: async () => ({
              status: "ok",
              version: "1.4.1",
              storageBackend: "sqlite",
              pid: 200,
              entrypoint: reported,
            }),
          } as Response
        : { ok: true, json: async () => ({}) } as Response);
      const realpathMock = vi.fn((path: string): string => {
        if (path === reported || path === expected) return canonical;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      });
      const killMock = vi.fn();

      const result = await ensureDaemon({
        port: 19999,
        pidFilePath: pidFile,
        spawnTimeoutMs: 100,
        expectedVersion: "1.4.1",
        expectedStorageBackend: "sqlite",
        expectedEntrypoint: expected,
        _platform: platform,
        _fetchOverride: fetchMock as FetchOverride,
        _realpathOverride: realpathMock,
        _killOverride: killMock,
        _isProcessAliveOverride: (): boolean => true,
        _listeningPortsOverride: (): number[] => [19999],
      });

      expect(result).toMatchObject({ connected: true, spawned: false, pid: 200 });
      expect(realpathMock).toHaveBeenCalledWith(reported);
      expect(realpathMock).toHaveBeenCalledWith(expected);
      expect(killMock).not.toHaveBeenCalled();
    },
  );

  it("fails closed when a legacy Linux daemon entrypoint cannot be read", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-unreadable-entrypoint-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    const fetchMock = vi.fn(async (url: string): Promise<Response> => url.endsWith("/health")
      ? {
          ok: true,
          json: async () => ({
            status: "ok", version: "1.4.1", storageBackend: "sqlite", pid: 200,
          }),
        } as Response
      : { ok: true, json: async () => ({}) } as Response);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.4.1",
      expectedStorageBackend: "sqlite",
      expectedEntrypoint: "/opt/npm/lcm.mjs",
      _platform: "linux",
      _procRoot: join(tempDir, "missing-proc"),
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({ connected: false, spawned: false, warning: expect.any(String) });
  });

  it("does not terminate an unauthenticated daemon when version and backend both mismatch", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-combined-mismatch-auth-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "wrong-token");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    const fetchMock = vi.fn(async (url: string): Promise<Response> => url.endsWith("/health")
      ? { ok: true, json: async () => ({ status: "ok", version: "1.0.0", storageBackend: "sqlite", pid: 200 }) } as Response
      : { ok: false, status: 401 } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "2.0.0",
      expectedStorageBackend: "postgresql",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _killOverride: killMock,
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({ connected: false, spawned: false, warning: expect.stringContaining("storage-backend mismatch") });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/stats/pool"))).toBe(false);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).not.toHaveProperty("headers");
    }
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
  });

  it("does not terminate a replacement PID installed during backend-mismatch authentication", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-storage-mismatch-race-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    writeProcEntry(procRoot, 201, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", version: "1.2.3", storageBackend: "sqlite", pid: 200 }),
        } as Response;
      }
      writeFileSync(pidFile, "201");
      return { ok: true, json: async () => ({ totalConnections: 0 }) } as Response;
    });
    const killMock = vi.fn();
    const spawnMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _killOverride: killMock,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      warning: "daemon reuse or replacement was blocked because the storage-backend mismatch could not be authenticated or terminated safely; verify the local daemon token, stop the existing daemon if necessary, and retry",
    });
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("201");
  });

  it("does not terminate a backend-mismatched listener whose PID is not an LCM daemon", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-storage-mismatch-process-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node unrelated-server.js");
    const fetchMock = vi.fn(async (url: string): Promise<Response> => url.endsWith("/health")
      ? { ok: true, json: async () => ({ status: "ok", version: "1.2.3", storageBackend: "sqlite", pid: 200 }) } as Response
      : { ok: true, json: async () => ({ totalConnections: 0 }) } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _killOverride: killMock,
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      warning: "daemon reuse or replacement was blocked because the storage-backend mismatch could not be authenticated or terminated safely; verify the local daemon token, stop the existing daemon if necessary, and retry",
    });
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
  });

  it("signals only the authenticated PID when the PID file changes during termination", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-storage-mismatch-signal-race-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    writeProcEntry(procRoot, 201, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    let healthChecks = 0;
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      if (!url.endsWith("/health")) {
        return { ok: true, json: async () => ({ totalConnections: 0 }) } as Response;
      }
      healthChecks += 1;
      return {
        ok: true,
        json: async () => healthChecks <= 2
          ? { status: "ok", version: "1.2.3", storageBackend: "sqlite", pid: 200 }
          : { status: "ok", version: "1.2.3", storageBackend: "postgresql", pid: 201 },
      } as Response;
    });
    let authenticatedPidAlive = true;
    const killMock = vi.fn((pid: number): void => {
      expect(pid).toBe(200);
      authenticatedPidAlive = false;
      writeFileSync(pidFile, "201");
    });
    const spawnMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _killOverride: killMock,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (pid: number): boolean => pid === 200 ? authenticatedPidAlive : true,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({ connected: true, spawned: false, pid: 201 });
    expect(result.warning).toBeUndefined();
    expect(killMock).toHaveBeenCalled();
    expect(killMock.mock.calls.every(([pid]) => pid === 200)).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("201");
  });

  it.each([
    { name: "connects once delayed health becomes available", delayedHealthAvailable: true },
    { name: "returns safely when health remains unavailable", delayedHealthAvailable: false },
  ])("preserves a concurrent replacement and $name", async ({ delayedHealthAvailable }): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-storage-mismatch-replacement-wait-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    writeProcEntry(procRoot, 201, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    let monotonicMs = 0;
    let healthChecks = 0;
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      if (!url.endsWith("/health")) {
        return { ok: true, json: async () => ({ totalConnections: 0 }) } as Response;
      }
      healthChecks += 1;
      if (healthChecks <= 2) {
        return {
          ok: true,
          json: async () => ({ status: "ok", version: "1.2.3", storageBackend: "sqlite", pid: 200 }),
        } as Response;
      }
      if (delayedHealthAvailable && healthChecks >= 3) {
        return {
          ok: true,
          json: async () => ({ status: "ok", version: "1.2.3", storageBackend: "postgresql", pid: 201 }),
        } as Response;
      }
      return { ok: false } as Response;
    });
    let authenticatedPidAlive = true;
    const killMock = vi.fn((pid: number): void => {
      expect(pid).toBe(200);
      authenticatedPidAlive = false;
      writeFileSync(pidFile, "201");
    });
    const spawnMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 1200,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _killOverride: killMock,
      _sleepOverride: async (durationMs: number): Promise<void> => { monotonicMs += durationMs; },
      _isProcessAliveOverride: (pid: number): boolean => pid === 200 ? authenticatedPidAlive : true,
      _monotonicNowOverride: (): number => monotonicMs,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({
      connected: delayedHealthAvailable,
      spawned: false,
      ...(delayedHealthAvailable ? { pid: 201 } : {}),
    });
    expect(result.warning).toBeUndefined();
    expect(healthChecks).toBe(delayedHealthAvailable ? 4 : 5);
    expect(killMock).toHaveBeenCalled();
    expect(killMock.mock.calls.every(([pid]) => pid === 200)).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("201");
  });

  it("preserves a concurrent replacement discovered during the Step 2 retry", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-storage-mismatch-step-two-replacement-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    writeProcEntry(procRoot, 201, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    let monotonicMs = 0;
    let healthChecks = 0;
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      if (!url.endsWith("/health")) {
        return { ok: true, json: async () => ({ totalConnections: 0 }) } as Response;
      }
      healthChecks += 1;
      if (healthChecks === 1) return { ok: false } as Response;
      if (healthChecks === 2 || healthChecks === 3) {
        return {
          ok: true,
          json: async () => ({ status: "ok", version: "1.2.3", storageBackend: "sqlite", pid: 200 }),
        } as Response;
      }
      monotonicMs = 2000;
      return { ok: false } as Response;
    });
    let authenticatedPidAlive = true;
    const killMock = vi.fn((pid: number): void => {
      expect(pid).toBe(200);
      authenticatedPidAlive = false;
      writeFileSync(pidFile, "201");
    });
    const spawnMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 2000,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _killOverride: killMock,
      _sleepOverride: async (durationMs: number): Promise<void> => { monotonicMs += durationMs; },
      _isProcessAliveOverride: (pid: number): boolean => pid === 200 ? authenticatedPidAlive : true,
      _monotonicNowOverride: (): number => monotonicMs,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(result.warning).toBeUndefined();
    expect(healthChecks).toBe(4);
    expect(killMock).toHaveBeenCalledOnce();
    expect(killMock.mock.calls.every(([pid]) => pid === 200)).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("201");
  });

  it.each([
    { name: "SIGTERM failure", throwOn: "SIGTERM" as const, expectedSignals: 1 },
    { name: "SIGKILL failure", throwOn: "SIGKILL" as const, expectedSignals: 2 },
    { name: "survival after both signals", throwOn: undefined, expectedSignals: 2 },
  ])("blocks replacement and preserves the PID after $name", async ({ throwOn, expectedSignals }): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-storage-mismatch-termination-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    const fetchMock = vi.fn(async (url: string): Promise<Response> => url.endsWith("/health")
      ? { ok: true, json: async () => ({ status: "ok", version: "1.2.3", storageBackend: "sqlite", pid: 200 }) } as Response
      : { ok: true, json: async () => ({ totalConnections: 0 }) } as Response);
    const killMock = vi.fn((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === throwOn) throw new Error(`${String(signal)} failed`);
    });
    const spawnMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _killOverride: killMock,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({ connected: false, spawned: false, warning: expect.stringContaining("terminated safely") });
    expect(killMock).toHaveBeenCalledTimes(expectedSignals);
    expect(killMock.mock.calls.every(([pid]) => pid === 200)).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
  });

  it("preserves a live PID when retry authentication rejects a backend mismatch", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-storage-mismatch-retry-auth-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "wrong-token");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok", version: "1.2.3", storageBackend: "sqlite", pid: 200 }),
      } as Response)
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _killOverride: killMock,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      warning: "daemon reuse or replacement was blocked because the storage-backend mismatch could not be authenticated or terminated safely; verify the local daemon token, stop the existing daemon if necessary, and retry",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
  });

  it("preserves a live PID when retry authentication rejects combined version and backend mismatches", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-combined-mismatch-retry-auth-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "wrong-token");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok", version: "1.0.0", storageBackend: "sqlite", pid: 200 }),
      } as Response)
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "2.0.0",
      expectedStorageBackend: "postgresql",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _killOverride: killMock,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({ connected: false, spawned: false, warning: expect.stringContaining("storage-backend mismatch") });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
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
        return { ok: true, json: async () => ({ status: "ok", version: "0.0.0", uptime: 100, pid: 200 }) } as Response;
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
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result.connected).toBe(false);
    expect(killMock).toHaveBeenCalledWith(200, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(200, "SIGKILL");
    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith("/stats/pool"))).toBe(false);
  });

  it("does not assume access when the local token file is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-missing-token-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok", version: "1.2.3", uptime: 100, pid: 4242 }),
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
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
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

  it.each(["version", "deadline", "access", "digest"] as const)(
    "rejects a spawned daemon at the %s verification boundary",
    async (boundary): Promise<void> => {
      const tempDir = mkdtempSync(join(tmpdir(), `lcm-lifecycle-spawn-${boundary}-`));
      tempDirs.push(tempDir);
      const pidFile = join(tempDir, "daemon.pid");
      let monotonicMs = 0;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        if (fetchMock.mock.calls.length === 1) return { ok: false } as Response;
        if (url.endsWith("/health")) {
          return {
            ok: true,
            json: async () => {
              if (boundary === "deadline") monotonicMs = 100;
              return {
                status: "ok",
                version: boundary === "version" ? "0.0.0" : "1.2.3",
                pid: 4242,
                ...(boundary === "digest" && init?.headers
                  ? { runtimeDigest: "b".repeat(64) }
                  : {}),
              };
            },
          } as Response;
        }
        return boundary === "digest"
          ? { ok: true, status: 200 } as Response
          : { ok: false, status: 401 } as Response;
      });
      const spawnMock = vi.fn(() => {
        writeFileSync(pidFile, "4242");
        return makeSpawnChild(4242);
      });

      const result = await ensureDaemon({
        port: 19999,
        pidFilePath: pidFile,
        spawnTimeoutMs: 100,
        expectedVersion: "1.2.3",
        expectedRuntimeDigest: boundary === "digest" ? "a".repeat(64) : undefined,
        _fetchOverride: fetchMock as FetchOverride,
        _spawnOverride: spawnMock as unknown as SpawnOverride,
        _isProcessAliveOverride: (): boolean => true,
        _listeningPortsOverride: (): number[] => [19999],
        _monotonicNowOverride: (): number => monotonicMs,
        _sleepOverride: async (durationMs: number): Promise<void> => { monotonicMs += durationMs; },
      });

      expect(result).toMatchObject({ connected: false, spawned: true });
    },
  );

  it("does not terminate an unverified PID-file process on version mismatch", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-version-unverified-pid-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    let monotonicMs = 0;
    const killMock = vi.fn();
    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _platform: "linux",
      _procRoot: join(tempDir, "missing-proc"),
      _fetchOverride: vi.fn(async () => ({
        ok: true,
        json: async () => {
          monotonicMs = 100;
          return { status: "ok", version: "0.0.0", pid: 4242 };
        },
      })) as FetchOverride,
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
      _killOverride: killMock,
      _monotonicNowOverride: (): number => monotonicMs,
      _skipSpawn: true,
    });

    expect(result.connected).toBe(false);
    expect(killMock).not.toHaveBeenCalled();
  });

  it("starts via user systemd when parent enforcement is requested on Linux", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-systemd-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const runtimeBaseDir = userRuntimeBaseDir();
    let oldCredentialDir: string | undefined;
    if (runtimeBaseDir !== undefined) {
      oldCredentialDir = mkdtempSync(join(runtimeBaseDir, "lcm-systemd-credentials-old-"));
      tempDirs.push(oldCredentialDir);
      writeFileSync(join(oldCredentialDir, "ANTHROPIC_API_KEY"), "old");
      const oldDate = new Date(Date.now() - 20 * 60 * 1000);
      utimesSync(oldCredentialDir, oldDate, oldDate);
    }
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const spawnMock = vi.fn();
    const originalProvider = process.env.LCM_SUMMARY_PROVIDER;
    const originalSummaryApiKey = process.env.LCM_SUMMARY_API_KEY;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    const originalPostgresUrl = process.env.LCM_POSTGRES_URL;
    const originalPostgresCaFile = process.env.LCM_POSTGRES_CA_FILE;
    const originalUnrelated = process.env.UNRELATED_DAEMON_VALUE;
    const originalPath = process.env.PATH;
    process.env.LCM_SUMMARY_PROVIDER = "anthropic";
    if (runtimeBaseDir === undefined) {
      delete process.env.LCM_SUMMARY_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.LCM_POSTGRES_URL;
    } else {
      process.env.LCM_SUMMARY_API_KEY = "sk-lcm-test";
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.LCM_POSTGRES_URL = "postgresql://user:postgres-secret@db.example.com/lcm";
    }
    process.env.LCM_POSTGRES_CA_FILE = "/etc/ssl/certs/postgres-ca.crt";
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
      const expectedEnvironment = [
        "--setenv=PATH=/path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "--setenv=LCM_POSTGRES_CA_FILE=/etc/ssl/certs/postgres-ca.crt",
        "--setenv=LCM_SUMMARY_PROVIDER=anthropic",
      ];
      if (runtimeBaseDir !== undefined) {
        expectedEnvironment.push("--setenv=LCM_SYSTEMD_CRED_IDS=ANTHROPIC_API_KEY,LCM_POSTGRES_URL,LCM_SUMMARY_API_KEY");
      }
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "systemd-run",
        expect.arrayContaining([
          "--user",
          "--collect",
          "--no-block",
          ...expectedEnvironment,
          "node",
          "/path/lcm.js",
          "daemon",
          "start",
          "--foreground",
        ]),
        expect.objectContaining({ encoding: "utf-8", timeout: 100 }),
      );
      const systemdArgs = spawnSyncMock.mock.calls[0][1] as string[];
      if (runtimeBaseDir === undefined) {
        expect(systemdArgs).not.toContain(
          "--setenv=LCM_SYSTEMD_CRED_IDS=ANTHROPIC_API_KEY,LCM_POSTGRES_URL,LCM_SUMMARY_API_KEY",
        );
      }
      const joinedArgs = systemdArgs.join("\n");
      expect(joinedArgs).not.toContain("sk-test");
      expect(joinedArgs).not.toContain("sk-lcm-test");
      expect(joinedArgs).not.toContain("postgres-secret");
      expect(systemdArgs).not.toContain("--setenv=UNRELATED_DAEMON_VALUE=ignored");
      expect(systemdArgs).not.toContain("--setenv=PATH=/opt/lcm-test/bin:/usr/bin");
      const credentialArgs = systemdArgs.filter((arg) => arg.startsWith("--property=LoadCredential="));
      expect(credentialArgs).toEqual(runtimeBaseDir === undefined ? [] : [
        expect.stringContaining("ANTHROPIC_API_KEY:"),
        expect.stringContaining("LCM_POSTGRES_URL:"),
        expect.stringContaining("LCM_SUMMARY_API_KEY:"),
      ]);
      for (const arg of credentialArgs) {
        const [, credentialPath] = arg.split(":", 2);
        expect(existsSync(credentialPath)).toBe(false);
        expect(existsSync(dirname(credentialPath))).toBe(false);
      }
      if (oldCredentialDir !== undefined) expect(existsSync(oldCredentialDir)).toBe(false);
    } finally {
      if (originalProvider === undefined) delete process.env.LCM_SUMMARY_PROVIDER;
      else process.env.LCM_SUMMARY_PROVIDER = originalProvider;
      if (originalSummaryApiKey === undefined) delete process.env.LCM_SUMMARY_API_KEY;
      else process.env.LCM_SUMMARY_API_KEY = originalSummaryApiKey;
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalApiKey;
      if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      if (originalPostgresUrl === undefined) delete process.env.LCM_POSTGRES_URL;
      else process.env.LCM_POSTGRES_URL = originalPostgresUrl;
      if (originalPostgresCaFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE;
      else process.env.LCM_POSTGRES_CA_FILE = originalPostgresCaFile;
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

  it.each([
    ["stderr", { status: 1, stdout: "", stderr: "" }],
    ["stdout", { status: 1, stdout: "", stderr: "" }],
    ["error", { status: null, stdout: "", stderr: "", error: new Error("") }],
  ] as const)("sanitizes and bounds raw systemd %s diagnostics", async (field, baseResult) => {
    const tempDir = mkdtempSync(join(tmpdir(), `lcm-lifecycle-systemd-${field}-`));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const rawDetail = [
      "Authorization: Bearer systemd-bearer-secret",
      "Authorization: Basic systemd-basic-secret",
      "opaque-systemd-token-value",
      "postgresql://user:systemd-url-secret@example.com/db?sslmode=disable",
      `\u001b[31mENOENT\n${"x".repeat(800)}`,
    ].join("\n");
    const systemdResult = {
      ...baseResult,
      [field]: field === "error" ? new Error(rawDetail) : rawDetail,
    };
    const spawnSyncMock = vi.fn().mockReturnValue(systemdResult);
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

    expect(result.warning).not.toContain("systemd-bearer-secret");
    expect(result.warning).not.toContain("systemd-basic-secret");
    expect(result.warning).not.toContain("opaque-systemd-token-value");
    expect(result.warning).not.toContain("systemd-url-secret");
    expect(result.warning).not.toContain("Authorization");
    expect(result.warning).not.toContain("sslmode");
    expect(result.warning).not.toContain("\u001b");
    expect(result.warning).not.toContain("\n");
    expect(result.warning).toContain("executable or resource unavailable");
    expect(result.warning).toContain("code ENOENT");
    expect(result.warning!.length).toBeLessThan(300);
  });

  it("sanitizes a detached-spawn error before displaying it", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-detached-sanitize-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const rawDetail = [
      "Authorization: Bearer detached-bearer-secret",
      "Authorization: Basic detached-basic-secret",
      "opaque-detached-token-value",
      "https://user:detached-url-secret@example.com/path?token=secret",
      `\u001b[31mEACCES\n${"x".repeat(800)}`,
    ].join("\n");
    const child: SpawnChildMock = {
      pid: undefined,
      unref: vi.fn(),
      once: vi.fn((_event: string, handler: (err: Error) => void) => {
        handler(new Error(rawDetail));
        return child;
      }),
    };

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      spawnCommand: "missing-lcm",
      spawnArgs: ["daemon", "start"],
      _skipHealthWait: true,
      _spawnOverride: vi.fn().mockReturnValue(child) as unknown as SpawnOverride,
    });

    expect(result.warning).not.toContain("detached-bearer-secret");
    expect(result.warning).not.toContain("detached-basic-secret");
    expect(result.warning).not.toContain("opaque-detached-token-value");
    expect(result.warning).not.toContain("detached-url-secret");
    expect(result.warning).not.toContain("Authorization");
    expect(result.warning).not.toContain("token=secret");
    expect(result.warning).not.toContain("\u001b");
    expect(result.warning).not.toContain("\n");
    expect(result.warning).toContain("permission denied");
    expect(result.warning).toContain("code EACCES");
    expect(result.warning!.length).toBeLessThan(160);
  });

  it("allows a recognized detached-spawn error code but suppresses its message", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-detached-code-"));
    tempDirs.push(tempDir);
    const error = new Error("Authorization: Bearer code-path-secret") as NodeJS.ErrnoException;
    error.code = "EADDRINUSE";
    const child: SpawnChildMock = {
      pid: undefined,
      unref: vi.fn(),
      once: vi.fn((_event: string, handler: (err: Error) => void) => {
        handler(error);
        return child;
      }),
    };

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: join(tempDir, "daemon.pid"),
      spawnTimeoutMs: 100,
      _skipHealthWait: true,
      _spawnOverride: vi.fn().mockReturnValue(child) as unknown as SpawnOverride,
    });

    expect(result.warning).toContain("process reported a failure; code EADDRINUSE");
    expect(result.warning).not.toContain("code-path-secret");
  });

  it("suppresses non-string detached-spawn failures", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-detached-object-"));
    tempDirs.push(tempDir);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: join(tempDir, "daemon.pid"),
      spawnTimeoutMs: 100,
      _skipHealthWait: true,
      _spawnOverride: vi.fn(() => {
        throw { authorization: "Bearer object-secret" };
      }) as unknown as SpawnOverride,
    });

    expect(result.warning).toContain("detached spawn error: process reported a failure");
    expect(result.warning).not.toContain("object-secret");
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
    expect(result.warning).toContain("detached spawn failed (detached spawn error: executable or resource unavailable; code ENOENT)");
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
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 200 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 200 }) } as Response)
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
      _listeningPortsOverride: (): number[] => [19999],
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _skipHealthWait: true,
    });

    expect(result.restartedForParent).toBe(true);
    expect(result.startMethod).toBe("systemd-user");
    expect(killMock).toHaveBeenCalledWith(200, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(200, "SIGKILL");
  });

  it("does not signal a replacement PID when wrong-parent identity changes before termination", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-wrong-parent-race-"));
    tempDirs.push(tempDir);
    const procRoot = join(tempDir, "proc");
    mkdirSync(procRoot);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    writeFileSync(pidFile, "200");
    writeProcEntry(procRoot, 100, "Name:\tsystemd\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "/usr/lib/systemd/systemd --user");
    writeProcEntry(procRoot, 200, "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n", "node lcm daemon start --foreground");
    const listenerPorts = vi.fn()
      .mockReturnValueOnce([19999])
      .mockReturnValueOnce([19999])
      .mockReturnValue([]);
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
      _fetchOverride: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 200 }) } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 200 }) } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ totalConnections: 0 }) } as Response) as FetchOverride,
      _killOverride: killMock,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: listenerPorts,
      _skipSpawn: true,
    });

    expect(result.connected).toBe(false);
    expect(listenerPorts).toHaveBeenCalledTimes(3);
    expect(killMock).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 200 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 200 }) } as Response)
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
      _listeningPortsOverride: (): number[] => [19999],
      _skipSpawn: true,
    });

    expect(result.connected).toBe(true);
    expect(result.warning).toContain("user systemd manager unavailable");
    expect(result.pid).toBe(200);
  });

  it("fails closed without sending the token when the PID file is missing", async () => {
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

    expect(result.connected).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 200 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 200 }) } as Response)
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
      _listeningPortsOverride: (): number[] => [19999],
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

    expect(result.connected).toBe(false);
    expect(result.restartedForParent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledOnce();
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

  it("does not connect when health wait returns a daemon with a mismatched storage backend", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-health-storage-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "1.2.3", storageBackend: "sqlite", pid: 4242, uptime: 100 }),
      } as Response);
    const spawnMock = vi.fn().mockImplementation(() => {
      writeFileSync(pidFile, "4242");
      return makeSpawnChild(4242);
    });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 600,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _fetchOverride: mockFetch as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result.connected).toBe(false);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["a stale", "/old/plugin-cache/lcm.mjs"],
    ["an unavailable legacy", undefined],
  ] as const)(
    "does not connect when health wait reports %s entrypoint",
    async (_label, entrypoint) => {
      const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-health-entrypoint-"));
      tempDirs.push(tempDir);
      const pidFile = join(tempDir, "daemon.pid");
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false } as Response)
        .mockResolvedValue({
          ok: true,
          json: async () => ({
            status: "ok",
            version: "1.4.1",
            storageBackend: "sqlite",
            pid: 4242,
            ...(entrypoint === undefined ? {} : { entrypoint }),
          }),
        } as Response);
      const spawnMock = vi.fn().mockImplementation(() => {
        writeFileSync(pidFile, "4242");
        return makeSpawnChild(4242);
      });

      const result = await ensureDaemon({
        port: 19999,
        pidFilePath: pidFile,
        spawnTimeoutMs: 100,
        expectedVersion: "1.4.1",
        expectedStorageBackend: "sqlite",
        expectedEntrypoint: "/opt/npm/lcm.mjs",
        _platform: "darwin",
        _fetchOverride: mockFetch as FetchOverride,
        _spawnOverride: spawnMock as unknown as SpawnOverride,
        _isProcessAliveOverride: () => true,
        _listeningPortsOverride: (): number[] => [19999],
      });

      expect(result.connected).toBe(false);
      expect(spawnMock).toHaveBeenCalledOnce();
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2_147_483_648])(
    "rejects invalid spawn timeout %s before inspecting or spawning",
    async (spawnTimeoutMs: number): Promise<void> => {
      const fetchMock = vi.fn();
      const spawnMock = vi.fn();
      const isAliveMock = vi.fn((): boolean => true);
      const killMock = vi.fn();
      const sleepMock = vi.fn(async (_durationMs: number): Promise<void> => {});
      await expect(ensureDaemon({
        port: 19999,
        pidFilePath: "/unused/daemon.pid",
        spawnTimeoutMs,
        _fetchOverride: fetchMock as FetchOverride,
        _spawnOverride: spawnMock as unknown as SpawnOverride,
        _isProcessAliveOverride: isAliveMock,
        _killOverride: killMock,
        _sleepOverride: sleepMock,
      })).rejects.toThrow(new RangeError("spawnTimeoutMs must be between 0 and 2147483647"));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(isAliveMock).not.toHaveBeenCalled();
      expect(killMock).not.toHaveBeenCalled();
      expect(sleepMock).not.toHaveBeenCalled();
    },
  );

  it("accepts a zero timeout but performs no startup side effects", async (): Promise<void> => {
    const fetchMock = vi.fn();
    const spawnMock = vi.fn();
    const isAliveMock = vi.fn((): boolean => true);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: "/unused/daemon.pid",
      spawnTimeoutMs: 0,
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _isProcessAliveOverride: isAliveMock,
      _monotonicNowOverride: (): number => 0,
    });

    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(isAliveMock).not.toHaveBeenCalled();
  });

  it("rejects a negative spawn timeout before inspecting or spawning", async (): Promise<void> => {
    const fetchMock = vi.fn();
    const spawnMock = vi.fn();
    await expect(ensureDaemon({
      port: 19999,
      pidFilePath: "/unused/daemon.pid",
      spawnTimeoutMs: -1,
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
    })).rejects.toThrow(new RangeError("spawnTimeoutMs must be between 0 and 2147483647"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("uses a monotonic spawn deadline and bounds the final health-wait sleep", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-monotonic-"));
    tempDirs.push(tempDir);
    let monotonicMs = 0;
    const sleepDurations: number[] = [];
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(-1_000_000_000);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response);

    try {
      const result = await ensureDaemon({
        port: 19999,
        pidFilePath: join(tempDir, "daemon.pid"),
        spawnTimeoutMs: 350,
        _fetchOverride: fetchMock as FetchOverride,
        _spawnOverride: vi.fn().mockReturnValue(makeSpawnChild(12345)) as unknown as SpawnOverride,
        _monotonicNowOverride: (): number => monotonicMs,
        _sleepOverride: async (durationMs: number): Promise<void> => {
          sleepDurations.push(durationMs);
          monotonicMs += durationMs;
        },
      });

      expect(result).toMatchObject({ connected: false, spawned: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleepDurations).toEqual([300, 50]);
    } finally {
      wallClock.mockRestore();
    }
  });

  it("does not sleep when a health request consumes the remaining spawn deadline", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-deadline-"));
    tempDirs.push(tempDir);
    let monotonicMs = 0;
    let fetchCalls = 0;
    const fetchMock = vi.fn(async (): Promise<Response> => {
      fetchCalls++;
      if (fetchCalls === 2) {
        monotonicMs = 350;
        return { ok: true, json: async (): Promise<{ status: string }> => ({ status: "ok" }) } as Response;
      }
      return { ok: false } as Response;
    });
    const sleepMock = vi.fn(async (): Promise<void> => {});

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: join(tempDir, "daemon.pid"),
      spawnTimeoutMs: 350,
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: vi.fn().mockReturnValue(makeSpawnChild(12345)) as unknown as SpawnOverride,
      _monotonicNowOverride: (): number => monotonicMs,
      _sleepOverride: sleepMock,
    });

    expect(result).toMatchObject({ connected: false, spawned: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("aborts a hanging health request at the remaining monotonic deadline and clears its timer", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-hanging-health-"));
    tempDirs.push(tempDir);
    let monotonicMs = 0;
    let fetchCalls = 0;
    let healthSignal: AbortSignal | undefined;
    let signalWasInitiallyAborted: boolean | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchCalls++;
      healthSignal = init?.signal ?? undefined;
      signalWasInitiallyAborted = healthSignal?.aborted;
      return new Promise<Response>((
        _resolve: (value: Response | PromiseLike<Response>) => void,
      ): void => {});
    });
    const timerHandle = 123 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutMock = vi.fn((callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
      queueMicrotask((): void => {
        monotonicMs += delayMs;
        callback();
      });
      return timerHandle;
    });
    const clearTimeoutMock = vi.fn((_timeout: ReturnType<typeof setTimeout>): void => {});
    const sleepMock = vi.fn(async (_durationMs: number): Promise<void> => {});

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: join(tempDir, "daemon.pid"),
      spawnTimeoutMs: 350,
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: vi.fn().mockReturnValue(makeSpawnChild(12345)) as unknown as SpawnOverride,
      _monotonicNowOverride: (): number => monotonicMs,
      _setTimeoutOverride: setTimeoutMock,
      _clearTimeoutOverride: clearTimeoutMock,
      _sleepOverride: sleepMock,
    });

    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 350);
    expect(signalWasInitiallyAborted).toBe(false);
    expect(healthSignal?.aborted).toBe(true);
    expect(clearTimeoutMock).toHaveBeenCalledWith(timerHandle);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("aborts a hanging access check at the remaining monotonic deadline and clears both request timers", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-hanging-access-"));
    tempDirs.push(tempDir);
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    writeFileSync(join(tempDir, "daemon.pid"), "4242");
    let monotonicMs = 0;
    let fetchCalls = 0;
    let accessSignal: AbortSignal | undefined;
    let accessSignalWasInitiallyAborted: boolean | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return { ok: true, json: async (): Promise<{ status: string; version: string; pid: number }> => ({ status: "ok", version: "1.2.3", pid: 4242 }) } as Response;
      }
      accessSignal = init?.signal ?? undefined;
      accessSignalWasInitiallyAborted = accessSignal?.aborted;
      return new Promise<Response>((
        _resolve: (value: Response | PromiseLike<Response>) => void,
      ): void => {});
    });
    const healthTimer = 201 as unknown as ReturnType<typeof setTimeout>;
    const accessTimer = 202 as unknown as ReturnType<typeof setTimeout>;
    let timerCalls = 0;
    const setTimeoutMock = vi.fn((callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
      timerCalls++;
      if (timerCalls === 2) {
        queueMicrotask((): void => {
          monotonicMs += delayMs;
          callback();
        });
        return accessTimer;
      }
      return healthTimer;
    });
    const clearTimeoutMock = vi.fn((_timeout: ReturnType<typeof setTimeout>): void => {});
    const sleepMock = vi.fn(async (_durationMs: number): Promise<void> => {});

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: join(tempDir, "daemon.pid"),
      spawnTimeoutMs: 350,
      expectedVersion: "1.2.3",
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: vi.fn().mockReturnValue(makeSpawnChild(12345)) as unknown as SpawnOverride,
      _monotonicNowOverride: (): number => monotonicMs,
      _setTimeoutOverride: setTimeoutMock,
      _clearTimeoutOverride: clearTimeoutMock,
      _sleepOverride: sleepMock,
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setTimeoutMock).toHaveBeenNthCalledWith(1, expect.any(Function), 350);
    expect(setTimeoutMock).toHaveBeenNthCalledWith(2, expect.any(Function), 350);
    expect(accessSignalWasInitiallyAborted).toBe(false);
    expect(accessSignal?.aborted).toBe(true);
    expect(clearTimeoutMock).toHaveBeenCalledWith(healthTimer);
    expect(clearTimeoutMock).toHaveBeenCalledWith(accessTimer);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("aborts a hanging PID retry health probe at the remaining deadline without spawning", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-hanging-pid-retry-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "12345");
    let monotonicMs = 0;
    let fetchCalls = 0;
    let retrySignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchCalls++;
      if (fetchCalls === 1) return { ok: false } as Response;
      retrySignal = init?.signal ?? undefined;
      return new Promise<Response>((
        _resolve: (value: Response | PromiseLike<Response>) => void,
      ): void => {});
    });
    const initialTimer = 301 as unknown as ReturnType<typeof setTimeout>;
    const retryTimer = 302 as unknown as ReturnType<typeof setTimeout>;
    let timerCalls = 0;
    const setTimeoutMock = vi.fn((callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
      timerCalls++;
      if (timerCalls === 2) {
        queueMicrotask((): void => {
          monotonicMs += delayMs;
          callback();
        });
        return retryTimer;
      }
      return initialTimer;
    });
    const clearTimeoutMock = vi.fn((_timeout: ReturnType<typeof setTimeout>): void => {});
    const sleepMock = vi.fn(async (_durationMs: number): Promise<void> => {});
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(12345));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 350,
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _isProcessAliveOverride: (): boolean => true,
      _monotonicNowOverride: (): number => monotonicMs,
      _setTimeoutOverride: setTimeoutMock,
      _clearTimeoutOverride: clearTimeoutMock,
      _sleepOverride: sleepMock,
    });

    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(350);
    expect(retrySignal?.aborted).toBe(true);
    expect(clearTimeoutMock).toHaveBeenCalledWith(initialTimer);
    expect(clearTimeoutMock).toHaveBeenCalledWith(retryTimer);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips the initial access probe when health consumes the operation deadline", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-initial-access-deadline-"));
    tempDirs.push(tempDir);
    let monotonicMs = 0;
    const fetchMock = vi.fn(async (): Promise<Response> => ({
      ok: true,
      json: async (): Promise<{ status: string }> => {
        monotonicMs = 350;
        return { status: "ok" };
      },
    } as Response));
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(12345));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: join(tempDir, "daemon.pid"),
      spawnTimeoutMs: 350,
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _monotonicNowOverride: (): number => monotonicMs,
    });

    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips the pool diagnostic when authenticated health consumes the operation deadline", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-authenticated-health-deadline-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    let monotonicMs = 0;
    let healthCalls = 0;
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      expect(url).toContain("/health");
      healthCalls++;
      return {
        ok: true,
        json: async () => {
          if (healthCalls === 2) monotonicMs = 350;
          return {
            status: "ok",
            version: "1.2.3",
            storageBackend: "sqlite",
            pid: 4242,
          };
        },
      } as Response;
    });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 350,
      expectedVersion: "1.2.3",
      _skipSpawn: true,
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: (): number[] => [19999],
      _monotonicNowOverride: (): number => monotonicMs,
    });

    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips PID sleep and retry health when the initial probe consumes the deadline", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-pid-health-deadline-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "12345");
    let monotonicMs = 0;
    const fetchMock = vi.fn(async (): Promise<Response> => {
      monotonicMs = 350;
      return { ok: false } as Response;
    });
    const sleepMock = vi.fn(async (_durationMs: number): Promise<void> => {});
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(12345));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 350,
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _isProcessAliveOverride: (): boolean => true,
      _monotonicNowOverride: (): number => monotonicMs,
      _sleepOverride: sleepMock,
    });

    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips PID retry access when retry health consumes the operation deadline", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-pid-access-deadline-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "12345");
    let monotonicMs = 0;
    let fetchCalls = 0;
    const fetchMock = vi.fn(async (): Promise<Response> => {
      fetchCalls++;
      if (fetchCalls === 1) return { ok: false } as Response;
      return {
        ok: true,
        json: async (): Promise<{ status: string }> => {
          monotonicMs = 350;
          return { status: "ok" };
        },
      } as Response;
    });
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(12345));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 350,
      _fetchOverride: fetchMock as FetchOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _isProcessAliveOverride: (): boolean => true,
      _monotonicNowOverride: (): number => monotonicMs,
      _sleepOverride: async (_durationMs: number): Promise<void> => {},
    });

    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).not.toHaveBeenCalled();
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
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid spawn timeout %s before validation, inspection, or signaling",
    async (spawnTimeoutMs: number): Promise<void> => {
      const validateBeforeRestart = vi.fn();
      const fetchMock = vi.fn();
      const killMock = vi.fn();
      const ensureMock = vi.fn();

      await expect(restartDaemon({
        port: 19999,
        pidFilePath: "/unused/daemon.pid",
        spawnTimeoutMs,
        validateBeforeRestart,
        _fetchOverride: fetchMock as FetchOverride,
        _killOverride: killMock,
        _ensureDaemonOverride: ensureMock,
      })).rejects.toThrow(new RangeError("spawnTimeoutMs must be between 0 and 2147483647"));

      expect(validateBeforeRestart).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(killMock).not.toHaveBeenCalled();
      expect(ensureMock).not.toHaveBeenCalled();
    },
  );

  it("validates before stopping a verified running daemon and starts with the new port", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-running-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
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

  it("refuses an older non-Linux daemon before sending the token", async () => {
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

    await expect(restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "2.0.0",
      _platform: "darwin",
      _fetchOverride: fetchMock as FetchOverride,
      _listeningPortsOverride: (): number[] => [19999],
      _isProcessAliveOverride: () => alive,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _ensureDaemonOverride: ensureMock,
    })).rejects.toThrow("not a verified LCM daemon");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("refuses a restart with an unrecognized public storage backend before sending the token", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-invalid-backend-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "must-not-leak");
    const killMock = vi.fn();
    const ensureMock = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ok",
        version: "1.2.3",
        storageBackend: "unrecognized",
        pid: 4242,
      }),
    } as Response);

    await expect(restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _platform: "darwin",
      _fetchOverride: fetchMock as FetchOverride,
      _listeningPortsOverride: (): number[] => [19999],
      _isProcessAliveOverride: (): boolean => true,
      _killOverride: killMock,
      _ensureDaemonOverride: ensureMock,
    })).rejects.toThrow("not a verified LCM daemon");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("headers");
    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("stops an authenticated old backend and starts the replacement with the target backend", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-storage-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    let alive = true;
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", version: "1.2.3", storageBackend: "sqlite", pid: 4242 }),
        } as Response;
      }
      expect(init?.headers).toEqual({ Authorization: "Bearer local-token" });
      return { ok: true, json: async () => ({ totalConnections: 0 }) } as Response;
    });
    const killMock = vi.fn(() => { alive = false; });
    const ensureMock = vi.fn(async (options: EnsureDaemonOptions) => ({
      connected: true,
      port: options.port,
      spawned: true,
    }));

    const result = await restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedStorageBackend: "postgresql",
      _platform: "darwin",
      _fetchOverride: fetchMock as FetchOverride,
      _listeningPortsOverride: (): number[] => [19999],
      _isProcessAliveOverride: () => alive,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _ensureDaemonOverride: ensureMock,
    });

    expect(result).toMatchObject({ connected: true, restarted: true, stoppedPid: 4242 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(killMock).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({
      expectedStorageBackend: "postgresql",
    }));
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
      _listeningPortsOverride: (): number[] => [19999],
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _isProcessAliveOverride: () => true,
      _killOverride: killMock,
      _ensureDaemonOverride: ensureMock,
    })).rejects.toThrow("not a verified LCM daemon");

    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("bounds restart identity probes by the caller's monotonic deadline", async (): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-deadline-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    let monotonicMs = 0;
    let healthSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      healthSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const timer = 701 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutMock = vi.fn((callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
      queueMicrotask(() => { monotonicMs += delayMs; callback(); });
      return timer;
    });
    const clearTimeoutMock = vi.fn();

    await expect(restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _platform: "darwin",
      _fetchOverride: fetchMock as FetchOverride,
      _listeningPortsOverride: (): number[] => [19999],
      _isProcessAliveOverride: (): boolean => true,
      _monotonicNowOverride: (): number => monotonicMs,
      _setTimeoutOverride: setTimeoutMock,
      _clearTimeoutOverride: clearTimeoutMock,
    })).rejects.toThrow("not a verified LCM daemon");

    expect(healthSignal?.aborted).toBe(true);
    expect(clearTimeoutMock).toHaveBeenCalledWith(timer);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["health", "access"] as const)("refuses restart when the %s verification deadline is exhausted", async (boundary): Promise<void> => {
    const tempDir = mkdtempSync(join(tmpdir(), `lcm-lifecycle-restart-${boundary}-expired-`));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "4242");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    let monotonicCalls = 0;
    const fetchMock = vi.fn(async (): Promise<Response> => ({
      ok: true,
      json: async () => ({ status: "ok", version: "1.2.3", pid: 4242 }),
    } as Response));

    await expect(restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _platform: "darwin",
      _fetchOverride: fetchMock as FetchOverride,
      _listeningPortsOverride: (): number[] => [19999],
      _isProcessAliveOverride: (): boolean => true,
      _monotonicNowOverride: (): number => {
        monotonicCalls++;
        if (boundary === "health") return monotonicCalls === 1 ? 0 : 100;
        return monotonicCalls >= 3 ? 100 : 0;
      },
    })).rejects.toThrow("not a verified LCM daemon");

    expect(fetchMock).toHaveBeenCalledTimes(boundary === "health" ? 0 : 1);
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

  it("refuses an older non-Linux daemon without a health PID before sending the token", async () => {
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

    await expect(restartDaemon({
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
    })).rejects.toThrow("not a verified LCM daemon");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-p", "4242", "-iTCP", "-sTCP:LISTEN", "-Fn"],
      expect.objectContaining({ encoding: "utf-8", timeout: 1000, maxBuffer: 64 * 1024 }),
    );
    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("does not probe an old non-Linux listener after the configured port changes", async () => {
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

    await expect(restartDaemon({
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
    })).rejects.toThrow("not a verified LCM daemon");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
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
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    let alive = true;
    const killMock = vi.fn(() => { alive = false; });
    const fetchMock = vi.fn().mockImplementation(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", version: "1.2.3", pid: 4242 }) } as Response;
      }
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
      _platform: "linux",
      _procRoot: procRoot,
      expectedVersion: "1.2.3",
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: () => alive,
      _listeningPortsOverride: (): number[] => [19999],
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _ensureDaemonOverride: ensureMock,
    });

    expect(result.restarted).toBe(true);
    expect(killMock).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
