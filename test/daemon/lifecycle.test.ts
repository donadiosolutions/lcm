import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAuthToken } from "../../src/daemon/auth.js";
import { loadDaemonConfig, parseDaemonConfig } from "../../src/daemon/config.js";
import {
  ensureDaemon as ensureDaemonProduction,
  findUserSystemdPid,
  readProcessParentPid,
  restartDaemon as restartDaemonProduction,
} from "../../src/daemon/lifecycle.js";
import type { DaemonLifecycleHermeticTestSeams } from "../../src/daemon/lifecycle-scope.js";
import { createDaemon } from "../../src/daemon/server.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";

const tempDirs: string[] = [];
type EnsureDaemonOptions = Parameters<typeof ensureDaemonProduction>[0];
type FetchOverride = NonNullable<EnsureDaemonOptions["_fetchOverride"]>;
type SpawnOverride = NonNullable<EnsureDaemonOptions["_spawnOverride"]>;
type SpawnSyncOverride = NonNullable<EnsureDaemonOptions["_spawnSyncOverride"]>;
type SpawnChildMock = {
  pid: number | undefined;
  unref: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
};
type ManagedSupervisorSpec = {
  kind: "systemd-user" | "launchd-user";
  stateRoot: string;
  nonce: string;
  credentialDirectory?: string;
  credentialFiles?: readonly { name: string; path: string }[];
};
type ManagedCredentialSnapshot = {
  stateRoot: string;
  nonce: string;
  credentialDirectory?: string;
  files: readonly { name: string; value: string; mode: number; path: string }[];
};
const testIdentity = {
  ownerId: "lifecycle-tests",
  entrypoint: "/lcm-tests/lifecycle-daemon.mjs",
} as const;
const TEST_RUNTIME_DIGEST = "a".repeat(64);

function makeSpawnChild(pid: number | undefined): SpawnChildMock {
  const child: SpawnChildMock = {
    pid,
    unref: vi.fn(),
    once: vi.fn(),
  };
  child.once.mockReturnValue(child);
  return child;
}

function makeHermeticPidFile(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  return join(root, "daemon.pid");
}

function snapshotManagedCredentials(spec: ManagedSupervisorSpec): ManagedCredentialSnapshot {
  return {
    stateRoot: spec.stateRoot,
    nonce: spec.nonce,
    credentialDirectory: spec.credentialDirectory,
    files: (spec.credentialFiles ?? []).map(file => ({
      ...file,
      value: readFileSync(file.path, "utf-8"),
      mode: statSync(file.path).mode & 0o777,
    })),
  };
}

function withHermeticLifecycleSeams(
  options: EnsureDaemonOptions,
  overrides: Partial<DaemonLifecycleHermeticTestSeams> = {},
): EnsureDaemonOptions {
  const stateDir = dirname(options.pidFilePath);
  const seams: DaemonLifecycleHermeticTestSeams = {
    homeDir: stateDir,
    runtimeDir: join(stateDir, ".hermetic-runtime"),
    stateDir,
    credentialDir: join(stateDir, ".hermetic-credentials"),
    procRoot: options._procRoot === "/proc"
      ? join(stateDir, ".hermetic-proc")
      : options._procRoot ?? join(stateDir, ".hermetic-proc"),
    platform: options._platform ?? "linux",
    uid: options._uid ?? 1000,
    environment: {},
    fetch: options._fetchOverride
      ?? (vi.fn().mockRejectedValue(new Error("hermetic offline")) as FetchOverride),
    spawn: options._spawnOverride
      ?? (vi.fn(() => makeSpawnChild(undefined)) as unknown as SpawnOverride),
    spawnSync: options._spawnSyncOverride
      ?? (vi.fn(() => ({ status: 1, stdout: "", stderr: "hermetic" })) as unknown as SpawnSyncOverride),
    stopUnit: vi.fn(),
    killProcess: options._killOverride ?? vi.fn(),
    isProcessAlive: options._isProcessAliveOverride ?? (() => false),
    sleep: options._sleepOverride ?? (async () => undefined),
    realpath: options._realpathOverride ?? (path => path),
    ...overrides,
  };
  for (const directory of [
    seams.homeDir,
    seams.runtimeDir,
    seams.stateDir,
    seams.credentialDir,
    seams.procRoot,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  return { ...options, _hermeticTestSeams: seams, _assertBackendPublication: () => undefined };
}

function ensureDaemon(
  options: EnsureDaemonOptions,
  overrides: Partial<DaemonLifecycleHermeticTestSeams> = {},
): ReturnType<typeof ensureDaemonProduction> {
  return ensureDaemonProduction(withHermeticLifecycleSeams(options, overrides));
}

function restartDaemon(
  options: Parameters<typeof restartDaemonProduction>[0],
  overrides: Partial<DaemonLifecycleHermeticTestSeams> = {},
): ReturnType<typeof restartDaemonProduction> {
  return restartDaemonProduction(withHermeticLifecycleSeams(options, overrides));
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

function createOwnedDaemonFixture(prefix: string, pid = 200): {
  pid: number;
  pidFile: string;
  procRoot: string;
  tokenFile: string;
} {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(tempDir);
  const procRoot = join(tempDir, "proc");
  mkdirSync(procRoot);
  const pidFile = join(tempDir, "daemon.pid");
  const tokenFile = join(tempDir, "daemon.token");
  writeFileSync(pidFile, String(pid));
  writeFileSync(tokenFile, "local-token");
  writeProcEntry(
    procRoot,
    pid,
    "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n",
    "node lcm daemon start --foreground",
  );
  return { pid, pidFile, procRoot, tokenFile };
}

describe("ensureDaemon", () => {
  it("refuses startup before inspecting PID state when publication admission is blocked", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-lifecycle-publication-"));
    tempDirs.push(home);
    const publicationDir = join(home, ".lcm", "backend-publication");
    mkdirSync(publicationDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(publicationDir, "journal.json"), "{", { mode: 0o600 });

    await expect(ensureDaemonProduction({
      port: 3737,
      pidFilePath: join(home, ".lcm", "daemon.pid"),
      spawnTimeoutMs: 1_000,
    })).rejects.toBeInstanceOf(BackendPublicationJournalError);
  });

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
    writeFileSync(pidFile, "4242");
    writeFileSync(tokenFile, "local-token");
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "ok",
            version: "1.2.3",
            storageBackend: "sqlite",
            pid: 4242,
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response;
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

    expect(result).toMatchObject({
      connected: true,
      port: 19999,
      spawned: false,
      pid: 4242,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

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
      LCM_POSTGRES_MIGRATION_ROLE: "lcm_test_migrator",
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
      warning: "daemon reuse or replacement was blocked because the runtime-identity mismatch (entrypoint or packaged-runtime digest) could not be authenticated or terminated safely; verify the local daemon token, stop the existing daemon if necessary, and retry",
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
      warning: "daemon reuse or replacement was blocked because the runtime-identity mismatch (entrypoint or packaged-runtime digest) could not be authenticated or terminated safely; verify the local daemon token, stop the existing daemon if necessary, and retry",
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

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      warning: "daemon reuse or replacement was blocked because the runtime-identity mismatch (entrypoint or packaged-runtime digest) could not be authenticated or terminated safely; verify the local daemon token, stop the existing daemon if necessary, and retry",
    });
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

  it("refuses offline recovery before the Step 2 retry", async (): Promise<void> => {
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

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "response-invalid" });
    expect(result.warning).toContain("refusing PID recovery");
    expect(healthChecks).toBe(1);
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
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

  it("refuses a live PID when the initial backend health response is invalid", async (): Promise<void> => {
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

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "response-invalid" });
    expect(result.warning).toContain("refusing PID recovery");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
  });

  it("refuses a live PID when the initial combined-mismatch health response is invalid", async (): Promise<void> => {
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

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "response-invalid" });
    expect(result.warning).toContain("refusing PID recovery");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
  });

  it("refuses a PID-file daemon when initial health is invalid", async (): Promise<void> => {
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

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "response-invalid" });
    expect(killMock).not.toHaveBeenCalled();
    expect(healthCalls).toBe(1);
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

  it("falls back to detached spawn only when the manager preflight is unavailable", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-systemd-fallback-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "No medium found" });
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(12345));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      spawnCommand: process.execPath,
      spawnArgs: ["/path/lcm.js", "daemon", "start", "--foreground"],
      enforceUserManagerParent: true,
      _platform: "linux",
      _skipHealthWait: true,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
    });

    expect(result.startMethod).toBe("detached-spawn");
    expect(result.warning).toContain("daemon parent invariant is not verified");
    expect(spawnMock).toHaveBeenCalled();
  });

  it.each([
    { platform: "linux" as const, manager: "systemctl", errorCode: "ENOENT", fallback: true },
    { platform: "linux" as const, manager: "systemctl", errorCode: "EACCES", fallback: false },
    { platform: "darwin" as const, manager: "launchctl", errorCode: "ENOENT", fallback: true },
    { platform: "darwin" as const, manager: "launchctl", errorCode: "EACCES", fallback: false },
  ])("classifies spawnSync $errorCode for $manager on $platform", async ({ platform, manager, errorCode, fallback }) => {
    const tempDir = mkdtempSync(join(tmpdir(), `lcm-lifecycle-manager-${platform}-${errorCode.toLowerCase()}-`));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const spawnSyncMock = vi.fn().mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error(`spawn ${manager} ${errorCode}`), { code: errorCode }),
    });
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(12345));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      spawnCommand: process.execPath,
      spawnArgs: ["/path/lcm.js", "daemon", "start", "--foreground"],
      enforceUserManagerParent: true,
      _platform: platform,
      _skipHealthWait: true,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
    });

    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(manager);
    if (fallback) {
      expect(result).toMatchObject({ connected: false, spawned: true, startMethod: "detached-spawn" });
      expect(result.warning).toContain("manager unavailable");
      expect(spawnMock).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "manager-unavailable" });
      expect(result.warning).toContain("manager-command-failed");
      expect(spawnMock).not.toHaveBeenCalled();
    }
  });

  it("treats a malformed manager command status as unavailable instead of success", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-malformed-manager-status-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const spawnSyncMock = vi.fn().mockReturnValue({
      status: "not-a-number",
      stdout: "",
      stderr: "",
    });
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(12345));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      spawnCommand: process.execPath,
      spawnArgs: ["/path/lcm.js", "daemon", "start", "--foreground"],
      enforceUserManagerParent: true,
      _platform: "linux",
      _skipHealthWait: true,
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
    });

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "manager-unavailable" });
    expect(spawnMock).not.toHaveBeenCalled();
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

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "ambiguous" });
    expect(result.warning).toContain("ambiguous state");
    expect(killMock).not.toHaveBeenCalled();
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
    const managerUnavailable = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" });

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
      _spawnSyncOverride: managerUnavailable as unknown as SpawnSyncOverride,
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
    const managerUnavailable = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" });

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
      _spawnSyncOverride: managerUnavailable as unknown as SpawnSyncOverride,
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
    expect(spawnSyncMock).toHaveBeenCalledOnce();
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

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "ambiguous" });
    expect(result.warning).toContain("ambiguous state");
    expect(killMock).not.toHaveBeenCalled();
  });

  it("refuses an exact live likely-LCM listener when health is unavailable", async (): Promise<void> => {
    const fixture = createOwnedDaemonFixture("lcm-lifecycle-busy-owned-");
    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn();
    const listenerPorts = vi.fn().mockReturnValue([19999]);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: fixture.procRoot,
      _listeningPortsOverride: listenerPorts,
    });

    expect(result).toMatchObject({ connected: false, port: 19999, spawned: false, pid: fixture.pid, refusalReason: "response-invalid" });
    expect(result.warning).toContain("refusing PID recovery");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listenerPorts).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("200");
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it.each([
    {
      platform: "darwin" as const,
      windowsPowerShellPath: undefined,
      command: "node /usr/local/bin/lcm daemon start --foreground",
    },
    {
      platform: "win32" as const,
      windowsPowerShellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      command: "\"C:\\Program Files\\nodejs\\node.exe\" C:\\lcm\\lcm.mjs daemon start --foreground",
    },
  ])("refuses a busy daemon on $platform before command identity inspection", async ({
    platform,
    windowsPowerShellPath,
    command,
  }): Promise<void> => {
    const fixture = createOwnedDaemonFixture(`lcm-lifecycle-busy-${platform}-`);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn();
    const listenerPorts = vi.fn().mockReturnValue([19999]);
    const processInspector = vi.fn((
      _executable: string,
      _args: string[],
      _options: Record<string, unknown>,
    ) => ({
      status: 0,
      stdout: command,
      stderr: "",
    }));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _platform: platform,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _spawnSyncOverride: processInspector as unknown as SpawnSyncOverride,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: listenerPorts,
      _windowsPowerShellPathOverride: windowsPowerShellPath,
    });

    expect(result).toMatchObject({ connected: false, spawned: false, pid: fixture.pid, refusalReason: "response-invalid" });
    expect(result.warning).toContain("refusing PID recovery");
    expect(processInspector).not.toHaveBeenCalled();
    expect(listenerPorts).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe(String(fixture.pid));
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it.each([
    { name: "an unrelated macOS command", platform: "darwin" as const, outcome: "unrelated" as const },
    { name: "a failed macOS inspection", platform: "darwin" as const, outcome: "throw" as const },
    { name: "a nonzero macOS inspection", platform: "darwin" as const, outcome: "nonzero" as const },
    { name: "a non-string macOS inspection", platform: "darwin" as const, outcome: "nonstring" as const },
    { name: "an empty macOS inspection", platform: "darwin" as const, outcome: "empty" as const },
    { name: "an unrelated Windows command", platform: "win32" as const, outcome: "unrelated" as const },
    { name: "a failed Windows inspection", platform: "win32" as const, outcome: "throw" as const },
    { name: "a missing trusted Windows inspector", platform: "win32" as const, outcome: "missing" as const },
    { name: "an unsupported platform", platform: "freebsd" as const, outcome: "unsupported" as const },
  ])("refuses busy replacement for $name", async ({
    platform,
    outcome,
  }): Promise<void> => {
    const fixture = createOwnedDaemonFixture(`lcm-lifecycle-busy-invalid-${platform}-`);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(undefined));
    const listenerPorts = vi.fn().mockReturnValue([19999]);
    const processInspector = vi.fn((
      _executable: string,
      _args: string[],
      _options: Record<string, unknown>,
    ): {
      status: number;
      stdout: unknown;
      stderr: string;
    } => {
      switch (outcome) {
        case "throw":
          throw new Error("process inspection failed");
        case "nonzero":
          return { status: 1, stdout: "", stderr: "failed" };
        case "nonstring":
          return { status: 0, stdout: Buffer.from("unexpected"), stderr: "" };
        case "empty":
          return { status: 0, stdout: "   ", stderr: "" };
        default:
          return { status: 0, stdout: "sleep 1000", stderr: "" };
      }
    });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 1000,
      expectedVersion: "1.2.3",
      _platform: platform,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _spawnSyncOverride: processInspector as unknown as SpawnSyncOverride,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => true,
      _listeningPortsOverride: listenerPorts,
      _windowsPowerShellPathOverride: platform === "win32" && outcome !== "missing"
        ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        : undefined,
      _skipHealthWait: true,
    });

    expect(result).toMatchObject({ connected: false, spawned: false, pid: fixture.pid, refusalReason: "response-invalid" });
    expect(result.warning).toContain("refusing PID recovery");
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(listenerPorts).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidFile)).toBe(true);
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
    expect(processInspector).not.toHaveBeenCalled();
  });

  it("refuses the exact busy daemon after the initial health response is invalid", async (): Promise<void> => {
    const fixture = createOwnedDaemonFixture("lcm-lifecycle-busy-deadline-");
    let monotonicMs = 0;
    const fetchMock = vi.fn(async (): Promise<Response> => {
      monotonicMs = 100;
      return { ok: false } as Response;
    });
    const killMock = vi.fn();
    const spawnMock = vi.fn();

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _isProcessAliveOverride: (): boolean => true,
      _monotonicNowOverride: (): number => monotonicMs,
      _procRoot: fixture.procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    });

    expect(result).toMatchObject({ connected: false, spawned: false, pid: fixture.pid, refusalReason: "response-invalid" });
    expect(result.warning).toContain("refusing PID recovery");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("200");
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("refuses repeated busy calls and reconnects only after health recovers", async (): Promise<void> => {
    const fixture = createOwnedDaemonFixture("lcm-lifecycle-busy-recovery-");
    let healthy = false;
    const health = {
      status: "ok",
      version: "1.2.3",
      storageBackend: "sqlite",
      pid: fixture.pid,
      entrypoint: "lcm",
      runtimeDigest: TEST_RUNTIME_DIGEST,
    };
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      if (!healthy) return { ok: false } as Response;
      return url.endsWith("/health")
        ? { ok: true, json: async () => health } as Response
        : { ok: true, json: async () => ({ totalConnections: 0 }) } as Response;
    });
    const killMock = vi.fn();
    const spawnMock = vi.fn();
    const options: EnsureDaemonOptions = {
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      expectedEntrypoint: "lcm",
      expectedRuntimeDigest: TEST_RUNTIME_DIGEST,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: fixture.procRoot,
      _listeningPortsOverride: (): number[] => [19999],
    };

    const first = await ensureDaemon(options);
    const second = await ensureDaemon(options);
    healthy = true;
    const recovered = await ensureDaemon(options);

    expect(first).toMatchObject({ connected: false, spawned: false, pid: fixture.pid, refusalReason: "response-invalid" });
    expect(second).toMatchObject({ connected: false, spawned: false, pid: fixture.pid, refusalReason: "response-invalid" });
    expect(recovered).toMatchObject({ connected: true, spawned: false, pid: fixture.pid });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("200");
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("does not preserve, clean, signal, or spawn during busy-state refusal", async (): Promise<void> => {
    const fixture = createOwnedDaemonFixture("lcm-lifecycle-busy-pid-race-");
    let monotonicMs = 0;
    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn();
    const listenerPorts = vi.fn()
      .mockReturnValueOnce([19999])
      .mockImplementationOnce((): number[] => {
        writeFileSync(fixture.pidFile, "201");
        return [19999];
      });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _sleepOverride: async (durationMs: number): Promise<void> => {
        monotonicMs += durationMs;
      },
      _isProcessAliveOverride: (): boolean => true,
      _monotonicNowOverride: (): number => monotonicMs,
      _procRoot: fixture.procRoot,
      _listeningPortsOverride: listenerPorts,
    });

    expect(result).toMatchObject({ connected: false, port: 19999, spawned: false, pid: fixture.pid, refusalReason: "response-invalid" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listenerPorts).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("200");
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("refuses replacement when the owned PID health response is invalid", async (): Promise<void> => {
    const fixture = createOwnedDaemonFixture("lcm-lifecycle-busy-listener-race-");
    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(undefined));
    const listenerPorts = vi.fn()
      .mockReturnValueOnce([19999])
      .mockReturnValueOnce([]);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => true,
      _procRoot: fixture.procRoot,
      _listeningPortsOverride: listenerPorts,
      _skipHealthWait: true,
    });

    expect(result).toMatchObject({ connected: false, spawned: false, pid: fixture.pid, refusalReason: "response-invalid" });
    expect(result.warning).toContain("refusing PID recovery");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listenerPorts).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidFile)).toBe(true);
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("refuses an exact wrong-parent likely-LCM PID when health is unavailable", async (): Promise<void> => {
    const fixture = createOwnedDaemonFixture("lcm-lifecycle-busy-wrong-parent-listener-");
    writeProcEntry(
      fixture.procRoot,
      100,
      "Name:\tsystemd\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n",
      "/usr/lib/systemd/systemd --user",
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn();
    const managerUnavailable = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" });
    const listenerPorts = vi.fn()
      .mockReturnValueOnce([19999])
      .mockReturnValue([]);
    let alive = true;
    killMock.mockImplementation((pid: number, signal?: NodeJS.Signals | number): void => {
      expect(pid).toBe(fixture.pid);
      expect(signal).toBe("SIGTERM");
      alive = false;
    });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      enforceUserManagerParent: true,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => alive,
      _platform: "linux",
      _procRoot: fixture.procRoot,
      _uid: 1000,
      _spawnSyncOverride: managerUnavailable as unknown as SpawnSyncOverride,
      _listeningPortsOverride: listenerPorts,
      _skipSpawn: true,
    });

    expect(result).toMatchObject({ connected: false, spawned: false, pid: fixture.pid, refusalReason: "response-invalid" });
    expect(result.warning).toContain("refusing PID recovery");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listenerPorts).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidFile)).toBe(true);
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("refuses exact wrong-parent recovery when health probing is interrupted", async (): Promise<void> => {
    const fixture = createOwnedDaemonFixture("lcm-lifecycle-busy-wrong-parent-abort-");
    writeProcEntry(
      fixture.procRoot,
      100,
      "Name:\tsystemd\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n",
      "/usr/lib/systemd/systemd --user",
    );
    const controller = new AbortController();
    const fetchMock = vi.fn(async (): Promise<Response> => {
      controller.abort();
      return { ok: false } as Response;
    });
    const killMock = vi.fn();
    let alive = true;
    killMock.mockImplementation((): void => {
      alive = false;
    });
    const managerUnavailable = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      enforceUserManagerParent: true,
      _abortSignal: controller.signal,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: (): boolean => alive,
      _platform: "linux",
      _procRoot: fixture.procRoot,
      _uid: 1000,
      _spawnSyncOverride: managerUnavailable as unknown as SpawnSyncOverride,
      _skipSpawn: true,
    });

    expect(result).toMatchObject({ connected: false, spawned: false, pid: fixture.pid, refusalReason: "detached-no-response" });
    expect(controller.signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(killMock).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidFile)).toBe(true);
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("refuses a concurrent replacement during wrong-parent health refusal", async (): Promise<void> => {
    const fixture = createOwnedDaemonFixture("lcm-lifecycle-busy-wrong-parent-pid-race-");
    writeProcEntry(
      fixture.procRoot,
      100,
      "Name:\tsystemd\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n",
      "/usr/lib/systemd/systemd --user",
    );
    let monotonicMs = 0;
    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn();
    const listenerPorts = vi.fn()
      .mockReturnValueOnce([19999])
      .mockReturnValueOnce([])
      .mockImplementationOnce((): number[] => {
        writeFileSync(fixture.pidFile, "201");
        return [];
      });
    const managerUnavailable = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      enforceUserManagerParent: true,
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _sleepOverride: async (durationMs: number): Promise<void> => {
        monotonicMs += durationMs;
      },
      _isProcessAliveOverride: (): boolean => true,
      _monotonicNowOverride: (): number => monotonicMs,
      _platform: "linux",
      _procRoot: fixture.procRoot,
      _uid: 1000,
      _spawnSyncOverride: managerUnavailable as unknown as SpawnSyncOverride,
      _listeningPortsOverride: listenerPorts,
    });

    expect(result).toMatchObject({ connected: false, port: 19999, spawned: false, pid: fixture.pid, refusalReason: "response-invalid" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listenerPorts).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("200");
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it.each([
    { name: "the PID dies", processCommand: "node lcm daemon start --foreground", aliveAfterRetry: false },
    { name: "the PID is not a likely LCM daemon", processCommand: "sleep 1000", aliveAfterRetry: true },
  ])("refuses fail-closed replacement when $name", async ({
    processCommand,
    aliveAfterRetry,
  }): Promise<void> => {
    const fixture = createOwnedDaemonFixture("lcm-lifecycle-busy-invalid-process-");
    writeProcEntry(
      fixture.procRoot,
      fixture.pid,
      "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n",
      processCommand,
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response);
    const killMock = vi.fn();
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(undefined));
    const isAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(aliveAfterRetry);
    const listenerPorts = vi.fn().mockReturnValue([19999]);

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.2.3",
      _fetchOverride: fetchMock as FetchOverride,
      _killOverride: killMock,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
      _sleepOverride: async (): Promise<void> => {},
      _isProcessAliveOverride: isAlive,
      _procRoot: fixture.procRoot,
      _listeningPortsOverride: listenerPorts,
      _skipHealthWait: true,
    });

    expect(result).toMatchObject({ connected: false, spawned: false, pid: fixture.pid, refusalReason: "response-invalid" });
    expect(result.warning).toContain("refusing PID recovery");
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidFile)).toBe(true);
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
    expect(listenerPorts).not.toHaveBeenCalled();
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

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "ambiguous" });
    expect(result.warning).toContain("ambiguous state");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(existsSync(pidFile)).toBe(true);
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
    expect(existsSync(pidFile)).toBe(true);
    expect(readFileSync(pidFile, "utf-8")).toBe("200");
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
        pidFilePath: makeHermeticPidFile("lcm-invalid-timeout-"),
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
      pidFilePath: makeHermeticPidFile("lcm-zero-timeout-"),
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
      pidFilePath: makeHermeticPidFile("lcm-negative-timeout-"),
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

    const requestClock = vi.spyOn(performance, "now").mockReturnValue(0);
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
    }).finally(() => requestClock.mockRestore());

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "response-timeout" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(setTimeoutMock).toHaveBeenNthCalledWith(1, expect.any(Function), 350);
    expect(setTimeoutMock).toHaveBeenNthCalledWith(2, expect.any(Function), 350);
    expect(accessSignalWasInitiallyAborted).toBeUndefined();
    expect(accessSignal).toBeUndefined();
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

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "response-invalid" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleepMock).not.toHaveBeenCalled();
    expect(retrySignal).toBeUndefined();
    expect(clearTimeoutMock).toHaveBeenCalledWith(initialTimer);
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

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "response-invalid" });
    expect(fetchMock).toHaveBeenCalledOnce();
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
        pidFilePath: makeHermeticPidFile("lcm-invalid-restart-timeout-"),
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
    const spawnSyncMock = vi.fn((command: string) => command === "/bin/ps"
      ? { status: 0, stdout: "node lcm daemon start --foreground\n", stderr: "" }
      : { status: 0, stdout: "", stderr: "" });
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
      _spawnSyncOverride: spawnSyncMock as unknown as SpawnSyncOverride,
      _listeningPortsOverride: (): number[] => [19999],
      _isProcessAliveOverride: () => alive,
      _killOverride: killMock,
      _sleepOverride: async () => {},
      _ensureDaemonOverride: ensureMock,
    });

    expect(result).toMatchObject({ connected: true, restarted: true, stoppedPid: 4242 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
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
    expect(fetchMock).toHaveBeenCalledTimes(6);
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

  it("probes a managed Linux supervisor before admitting a responsive endpoint", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-managed-admit-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    let spec: { scopeDigest: string; nonce: string; name: string } | undefined;
    const probe = vi.fn(async (candidate: typeof spec) => {
      spec = candidate!;
      return {
        kind: "registered-running-valid" as const,
        managerPid: 200,
        scopeDigest: candidate!.scopeDigest,
        nonce: candidate!.nonce,
        name: candidate!.name,
      };
    });
    const supervisor = { probe, start: vi.fn(), stopAndStart: vi.fn(), stopAndAwaitAbsent: vi.fn() };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", version: "1.4.2", pid: 200, entrypoint: "/bin/lcm", storageBackend: "sqlite" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", version: "1.4.2", pid: 200, entrypoint: "/bin/lcm", storageBackend: "sqlite" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalConnections: 0 }), { status: 200 }));

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "1.4.2",
      expectedEntrypoint: "/bin/lcm",
      enforceUserManagerParent: true,
      _platform: "linux",
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19999],
      _supervisorOverride: supervisor as never,
    });

    expect(result).toMatchObject({ connected: true, spawned: false, startMethod: "systemd-user", pid: 200 });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(spec).toBeDefined();
    expect(supervisor.start).not.toHaveBeenCalled();
  });

  it("refuses managed ensure recovery when a registered job gives no response", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-managed-offline-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    const supervisor = {
      probe: vi.fn(async (candidate: { scopeDigest: string; nonce: string; name: string }) => ({
        kind: "registered-running-valid" as const,
        managerPid: 200,
        scopeDigest: candidate.scopeDigest,
        nonce: candidate.nonce,
        name: candidate.name,
      })),
      start: vi.fn(),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(),
    };
    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      enforceUserManagerParent: true,
      _platform: "linux",
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19999],
      _supervisorOverride: supervisor as never,
    });

    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "live-no-response", pid: 200 });
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.stopAndStart).not.toHaveBeenCalled();
  });

  it.each([
    "manager-timeout",
    "manager-command-failed",
    "unsupported-platform",
    "metadata-missing",
    "metadata-mismatch",
    "foreign-job",
    "pid-missing",
    "pid-invalid",
    "state-conflict",
    "credential-invalid",
    "cleanup-failed",
  ] as const)("refuses detached fallback for unresolved manager preflight reason %s", async (reason) => {
    const tempDir = mkdtempSync(join(tmpdir(), `lcm-lifecycle-manager-${reason}-`));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const spawnMock = vi.fn().mockReturnValue(makeSpawnChild(12345));
    const supervisor = {
      probe: vi.fn(async () => ({ kind: "unavailable" as const, reason, name: "job" })),
      start: vi.fn(),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(),
    };
    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      enforceUserManagerParent: true,
      _platform: "linux",
      _skipHealthWait: true,
      _supervisorOverride: supervisor as never,
      _spawnOverride: spawnMock as unknown as SpawnOverride,
    });
    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "manager-unavailable" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(supervisor.start).not.toHaveBeenCalled();
  });

  it("starts an absent managed macOS job and reports launchd-user", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-managed-launchd-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    let calls = 0;
    let staged: ManagedCredentialSnapshot | undefined;
    const supervisor = {
      probe: vi.fn(async (candidate: { scopeDigest: string; nonce: string; name: string }) => {
        calls += 1;
        return calls === 1
          ? { kind: "absent" as const, name: candidate.name }
          : { kind: "registered-running-valid" as const, managerPid: 201, scopeDigest: candidate.scopeDigest, nonce: candidate.nonce, name: candidate.name };
      }),
      start: vi.fn(async (candidate: ManagedSupervisorSpec) => {
        staged = snapshotManagedCredentials(candidate);
        return { kind: "launchd-user" as const, name: "job", scopeDigest: "scope", port: 19999, nonce: "nonce", managerPid: 201 };
      }),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(),
    };
    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      enforceUserManagerParent: true,
      _platform: "darwin",
      _skipHealthWait: true,
      _supervisorOverride: supervisor as never,
      _isProcessAliveOverride: () => false,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride,
    }, {
      environment: {
        ANTHROPIC_API_KEY: "anthropic-value",
        OPENAI_API_KEY: "openai-value",
        LCM_SUMMARY_API_KEY: "summary-value",
        LCM_POSTGRES_URL: "postgres-value",
        UNRELATED_SECRET: "must-not-be-staged",
      },
    });

    expect(result).toMatchObject({ connected: false, spawned: true, startMethod: "launchd-user", pid: 201 });
    expect(supervisor.start).toHaveBeenCalledOnce();
    expect(supervisor.probe).toHaveBeenCalledTimes(2);
    expect(staged?.stateRoot).toBe(tempDir);
    expect(staged?.credentialDirectory).toBeDefined();
    expect(dirname(staged!.credentialDirectory!)).toBe(join(tempDir, "credentials"));
    expect(basename(staged!.credentialDirectory!)).toMatch(new RegExp(`^${staged!.nonce}-[a-f0-9]{16}$`, "u"));
    expect(staged?.files.map(file => ({ name: file.name, value: file.value, mode: file.mode }))).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "anthropic-value", mode: 0o600 },
      { name: "OPENAI_API_KEY", value: "openai-value", mode: 0o600 },
      { name: "LCM_SUMMARY_API_KEY", value: "summary-value", mode: 0o600 },
      { name: "LCM_POSTGRES_URL", value: "postgres-value", mode: 0o600 },
    ]);
  });

  it("removes staged launchd credentials after a non-admitted health timeout", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-managed-launchd-timeout-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    let registered = false;
    let monotonicMs = 0;
    let staged: ManagedCredentialSnapshot | undefined;
    const supervisor = {
      probe: vi.fn(async (candidate: { scopeDigest: string; nonce: string; name: string }) => registered
        ? {
            kind: "registered-running-valid" as const,
            managerPid: 201,
            scopeDigest: candidate.scopeDigest,
            nonce: candidate.nonce,
            name: candidate.name,
          }
        : { kind: "absent" as const, name: candidate.name }),
      start: vi.fn(async (candidate: ManagedSupervisorSpec) => {
        staged = snapshotManagedCredentials(candidate);
        registered = true;
        return {
          kind: "launchd-user" as const,
          name: candidate.name,
          scopeDigest: candidate.scopeDigest,
          port: 19_999,
          nonce: candidate.nonce,
          managerPid: 201,
        };
      }),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(async (candidate: ManagedSupervisorSpec) => {
        expect(candidate.credentialDirectory).toBe(staged?.credentialDirectory);
        registered = false;
      }),
    };
    const result = await ensureDaemon({
      port: 19_999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 5,
      expectedVersion: "1.4.2",
      enforceUserManagerParent: true,
      _platform: "darwin",
      _skipHealthWait: false,
      _supervisorOverride: supervisor as never,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride,
      _monotonicNowOverride: (): number => monotonicMs,
      _sleepOverride: async (durationMs: number): Promise<void> => { monotonicMs += durationMs; },
    }, {
      platform: "darwin",
      uid: 501,
      environment: {
        ANTHROPIC_API_KEY: "anthropic-value",
        OPENAI_API_KEY: "openai-value",
        LCM_SUMMARY_API_KEY: "summary-value",
        LCM_POSTGRES_URL: "postgres-value",
      },
    });

    expect(result).toMatchObject({
      connected: false,
      spawned: true,
      refusalReason: "startup-failure",
      startMethod: "launchd-user",
    });
    expect(supervisor.stopAndAwaitAbsent).toHaveBeenCalledOnce();
    expect(staged?.credentialDirectory).toBeDefined();
    expect(existsSync(staged!.credentialDirectory!)).toBe(false);
  });

  it("preserves staged launchd credentials when cleanup cannot prove manager absence", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-managed-launchd-cleanup-refused-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    let monotonicMs = 0;
    let calls = 0;
    let staged: ManagedCredentialSnapshot | undefined;
    const supervisor = {
      probe: vi.fn(async (candidate: { scopeDigest: string; nonce: string; name: string }) => {
        calls += 1;
        return calls === 1
          ? { kind: "absent" as const, name: candidate.name }
          : {
              kind: "registered-running-valid" as const,
              managerPid: 201,
              scopeDigest: candidate.scopeDigest,
              nonce: candidate.nonce,
              name: candidate.name,
            };
      }),
      start: vi.fn(async (candidate: ManagedSupervisorSpec) => {
        staged = snapshotManagedCredentials(candidate);
        writeFileSync(pidFile, "201");
        return {
          kind: "launchd-user" as const,
          name: candidate.name,
          scopeDigest: candidate.scopeDigest,
          port: 19_999,
          nonce: candidate.nonce,
          managerPid: 201,
        };
      }),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(async () => {
        throw new Error("absence proof refused");
      }),
    };

    await expect(ensureDaemon({
      port: 19_999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 5,
      expectedVersion: "1.4.2",
      enforceUserManagerParent: true,
      _platform: "darwin",
      _skipHealthWait: false,
      _supervisorOverride: supervisor as never,
      _isProcessAliveOverride: () => false,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride,
      _monotonicNowOverride: (): number => monotonicMs,
      _sleepOverride: async (durationMs: number): Promise<void> => { monotonicMs += durationMs; },
    }, {
      platform: "darwin",
      uid: 501,
      environment: { OPENAI_API_KEY: "unadmitted-secret" },
    })).resolves.toMatchObject({
      refusalReason: "startup-failure",
      spawned: true,
      pid: 201,
      startMethod: "launchd-user",
    });

    expect(supervisor.stopAndAwaitAbsent).toHaveBeenCalledOnce();
    expect(staged?.credentialDirectory).toBeDefined();
    expect(existsSync(staged!.credentialDirectory!)).toBe(true);
    expect(staged?.files.map(file => ({ name: file.name, value: file.value, mode: file.mode }))).toEqual([
      { name: "OPENAI_API_KEY", value: "unadmitted-secret", mode: 0o600 },
    ]);
    expect(readFileSync(staged!.files[0]!.path, "utf-8")).toBe("unadmitted-secret");
    expect(readFileSync(pidFile, "utf-8").trim()).toBe("201");
  });

  it.each([
    ["linux", "systemd-user"],
    ["darwin", "launchd-user"],
  ] as const)("recreates a terminal %s manager job only after an exact no-live-PID proof", async (platform, method) => {
    const tempDir = mkdtempSync(join(tmpdir(), `lcm-lifecycle-managed-terminal-${platform}-`));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "200");
    let calls = 0;
    const supervisor = {
      probe: vi.fn(async (candidate: { scopeDigest: string; nonce: string; name: string }) => {
        calls += 1;
        return calls === 1
          ? { kind: "registered-not-running-valid" as const, terminal: "inactive" as const, name: candidate.name }
          : { kind: "registered-running-valid" as const, managerPid: 201, scopeDigest: candidate.scopeDigest, nonce: candidate.nonce, name: candidate.name };
      }),
      start: vi.fn(),
      stopAndStart: vi.fn(async () => ({ kind: method, name: "job", scopeDigest: "scope", port: 19999, nonce: "nonce", managerPid: 201 })),
      stopAndAwaitAbsent: vi.fn(),
    };
    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      enforceUserManagerParent: true,
      _platform: platform,
      _skipHealthWait: true,
      _supervisorOverride: supervisor as never,
      _isProcessAliveOverride: () => false,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride,
    });

    expect(result).toMatchObject({ connected: false, spawned: true, startMethod: method, pid: 201 });
    expect(supervisor.stopAndStart).toHaveBeenCalledOnce();
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.probe).toHaveBeenCalledTimes(2);
  });

  it("uses manager stop/start for an explicit restart with no HTTP response", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-managed-restart-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "202");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    let calls = 0;
    let staged: ManagedCredentialSnapshot | undefined;
    const supervisor = {
      probe: vi.fn(async (candidate: { scopeDigest: string; nonce: string; name: string }) => {
        calls += 1;
        return { kind: "registered-running-valid" as const, managerPid: 202, scopeDigest: candidate.scopeDigest, nonce: candidate.nonce, name: candidate.name };
      }),
      start: vi.fn(),
      stopAndStart: vi.fn(async (candidate: ManagedSupervisorSpec) => {
        staged = snapshotManagedCredentials(candidate);
        return { kind: "systemd-user" as const, name: "job", scopeDigest: "scope", port: 19999, nonce: "nonce", managerPid: 202 };
      }),
      stopAndAwaitAbsent: vi.fn(),
    };
    let ensuredOptions: EnsureDaemonOptions | undefined;
    const ensureMock = vi.fn(async (options: EnsureDaemonOptions) => {
      ensuredOptions = options;
      return { connected: true, port: 19999, spawned: false, startMethod: "systemd-user" as const };
    });
    const result = await restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      enforceUserManagerParent: true,
      _platform: "linux",
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19999],
      _supervisorOverride: supervisor as never,
      _ensureDaemonOverride: ensureMock,
    }, {
      environment: {
        OPENAI_API_KEY: "restart-openai-value",
        LCM_SUMMARY_API_KEY: "restart-summary-value",
        UNRELATED_SECRET: "must-not-be-staged",
      },
    });

    expect(result).toMatchObject({ restarted: true, stoppedPid: 202 });
    expect(supervisor.stopAndStart).toHaveBeenCalledOnce();
    expect(calls).toBe(2);
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(ensuredOptions?._supervisorCredentialDirectoryOverride).toBe(staged?.credentialDirectory);
    expect(ensuredOptions?._supervisorCredentialFilesOverride).toEqual(staged?.files.map(({ name, path }) => ({ name, path })));
    expect(staged?.stateRoot).toBe(tempDir);
    expect(staged?.credentialDirectory).toBeDefined();
    expect(dirname(staged!.credentialDirectory!)).toBe(join(tempDir, "credentials"));
    expect(basename(staged!.credentialDirectory!)).toMatch(new RegExp(`^${staged!.nonce}-[a-f0-9]{16}$`, "u"));
    expect(staged?.files.map(file => ({ name: file.name, value: file.value, mode: file.mode }))).toEqual([
      { name: "OPENAI_API_KEY", value: "restart-openai-value", mode: 0o600 },
      { name: "LCM_SUMMARY_API_KEY", value: "restart-summary-value", mode: 0o600 },
    ]);
    expect(existsSync(staged!.credentialDirectory!)).toBe(false);
  });

  it("repairs an exact stale manager registration through explicit stop/start only", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-managed-stale-restart-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const stopAndStart = vi.fn(async () => ({
      kind: "systemd-user" as const,
      name: "job",
      scopeDigest: "scope",
      port: 19999,
      nonce: "nonce",
      managerPid: 404,
    }));
    let observedSpec: { scopeDigest: string; nonce: string; name: string } | undefined;
    const supervisor = {
      probe: vi.fn(async (candidate: typeof observedSpec) => {
        observedSpec = candidate!;
        return {
          kind: "registered-stale-config" as const,
          reason: "metadata-mismatch" as const,
          scopeDigest: candidate!.scopeDigest,
          nonce: candidate!.nonce,
          name: candidate!.name,
          port: 19998,
          executable: process.execPath,
          args: JSON.stringify(["/path/lcm.js", "daemon", "start", "--foreground"]),
          cwd: "",
        };
      }),
      start: vi.fn(),
      stopAndStart,
      stopAndAwaitAbsent: vi.fn(),
    };
    const killMock = vi.fn();
    const ensureMock = vi.fn(async () => ({
      connected: true,
      port: 19999,
      spawned: false,
      startMethod: "systemd-user" as const,
    }));
    const result = await restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      enforceUserManagerParent: true,
      _platform: "linux",
      spawnArgs: ["/path/lcm.js", "daemon", "start", "--foreground"],
      _supervisorOverride: supervisor as never,
      _ensureDaemonOverride: ensureMock,
      _killOverride: killMock,
      _isProcessAliveOverride: () => true,
    });
    expect(result).toMatchObject({ restarted: true, stoppedPid: undefined });
    expect(observedSpec).toBeDefined();
    expect(stopAndStart).toHaveBeenCalledOnce();
    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).toHaveBeenCalledOnce();
  });

  it("repairs an authenticated responsive version mismatch through the manager only", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-managed-version-restart-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "202");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    let spec: { scopeDigest: string; nonce: string; name: string } | undefined;
    const supervisor = {
      probe: vi.fn(async (candidate: typeof spec) => {
        spec = candidate!;
        return {
          kind: "registered-running-valid" as const,
          managerPid: 202,
          scopeDigest: candidate!.scopeDigest,
          nonce: candidate!.nonce,
          name: candidate!.name,
        };
      }),
      start: vi.fn(),
      stopAndStart: vi.fn(async () => ({ kind: "systemd-user" as const, name: "job", scopeDigest: "scope", port: 19999, nonce: "nonce", managerPid: 203 })),
      stopAndAwaitAbsent: vi.fn(),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", version: "1.0.0", pid: 202, storageBackend: "sqlite", entrypoint: "/bin/lcm" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", version: "1.0.0", pid: 202, storageBackend: "sqlite", entrypoint: "/bin/lcm" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalConnections: 0 }), { status: 200 }));
    const killMock = vi.fn();
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19999, spawned: false, startMethod: "systemd-user" as const }));
    const result = await restartDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      expectedVersion: "2.0.0",
      expectedEntrypoint: "/bin/lcm",
      enforceUserManagerParent: true,
      _platform: "linux",
      _fetchOverride: fetchMock as FetchOverride,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19999],
      _killOverride: killMock,
      _supervisorOverride: supervisor as never,
      _ensureDaemonOverride: ensureMock,
    });
    expect(result).toMatchObject({ restarted: true });
    expect(supervisor.stopAndStart).toHaveBeenCalledOnce();
    expect(killMock).not.toHaveBeenCalled();
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(spec).toBeDefined();
  });

  it.each([
    ["absent", { kind: "absent" as const }],
    ["registered-not-running-valid", { kind: "registered-not-running-valid" as const, terminal: "inactive" as const }],
  ] as const)("reports restarted=false when a manager %s job is started without a stop", async (_name, initialObservation) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-start-only-"));
    tempDirs.push(tempDir);
    const supervisor = {
      probe: vi.fn(async (candidate: { name: string }) => ({ ...initialObservation, name: candidate.name })),
      start: vi.fn(),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(),
    };
    const ensureMock = vi.fn(async () => ({
      connected: false,
      port: 19999,
      spawned: true,
      startMethod: "systemd-user" as const,
    }));

    const result = await restartDaemon({
      port: 19999,
      pidFilePath: join(tempDir, "daemon.pid"),
      spawnTimeoutMs: 100,
      enforceUserManagerParent: true,
      _platform: "linux",
      _supervisorOverride: supervisor as never,
      _ensureDaemonOverride: ensureMock,
    });

    expect(result).toMatchObject({ restarted: false, connected: false, spawned: true });
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.stopAndStart).not.toHaveBeenCalled();
  });

  it.each([
    ["linux", "stale-config", { kind: "registered-stale-config" as const, reason: "metadata-mismatch" as const }],
    ["linux", "running-valid", { kind: "registered-running-valid" as const, managerPid: 202 }],
    ["darwin", "running-valid", { kind: "registered-running-valid" as const, managerPid: 202 }],
  ] as const)(
    "removes staged credentials after successful authenticated restart admission (%s %s)",
    async (platform, _name, initialObservation) => {
      const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-credential-success-"));
      tempDirs.push(tempDir);
      writeFileSync(join(tempDir, "daemon.pid"), "202");
      writeFileSync(join(tempDir, "daemon.token"), "local-token");
      let staged: ManagedCredentialSnapshot | undefined;
      const probe = vi.fn(async (candidate: { scopeDigest: string; nonce: string; name: string }) => ({
        ...initialObservation,
        scopeDigest: candidate.scopeDigest,
        nonce: candidate.nonce,
        name: candidate.name,
        ...(initialObservation.kind === "registered-stale-config"
          ? { port: 19998, executable: process.execPath, args: JSON.stringify(["/path/lcm.js", "daemon", "start", "--foreground"]) }
          : {}),
      }));
      const stopAndStart = vi.fn(async (candidate: ManagedSupervisorSpec) => {
        staged = snapshotManagedCredentials(candidate);
        return { kind: candidate.kind, name: candidate.name, scopeDigest: candidate.scopeDigest, port: 19999, nonce: candidate.nonce, managerPid: 202 };
      });
      const method = platform === "darwin" ? "launchd-user" as const : "systemd-user" as const;
      const ensureMock = vi.fn(async () => ({ connected: true as const, port: 19999, spawned: false, startMethod: method }));
      const result = await restartDaemon({
        port: 19999,
        pidFilePath: join(tempDir, "daemon.pid"),
        spawnTimeoutMs: 100,
        enforceUserManagerParent: true,
        _platform: platform,
        spawnArgs: initialObservation.kind === "registered-stale-config" ? ["/path/lcm.js", "daemon", "start", "--foreground"] : undefined,
        _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride,
        _isProcessAliveOverride: () => true,
        _listeningPortsOverride: () => [19999],
        _supervisorOverride: { probe, start: vi.fn(), stopAndStart, stopAndAwaitAbsent: vi.fn() } as never,
        _ensureDaemonOverride: ensureMock,
      }, { environment: { OPENAI_API_KEY: "restart-openai", LCM_SUMMARY_API_KEY: "restart-summary", UNRELATED_SECRET: "must-not-be-staged" } });

      expect(result).toMatchObject({ restarted: true, connected: true });
      expect(stopAndStart).toHaveBeenCalledOnce();
      expect(ensureMock).toHaveBeenCalledOnce();
      expect(staged?.stateRoot).toBe(tempDir);
      expect(staged?.credentialDirectory).toBeDefined();
      expect(staged?.files.map(file => ({ name: file.name, value: file.value, mode: file.mode }))).toEqual([
        { name: "OPENAI_API_KEY", value: "restart-openai", mode: 0o600 },
        { name: "LCM_SUMMARY_API_KEY", value: "restart-summary", mode: 0o600 },
      ]);
      expect(existsSync(staged!.credentialDirectory!)).toBe(false);
    },
  );

  it.each([
    ["stale-config", { kind: "registered-stale-config" as const, reason: "metadata-mismatch" as const }],
    ["running-valid", { kind: "registered-running-valid" as const, managerPid: 202 }],
  ] as const)(
    "preserves staged launchd credentials when the manager stop/start throws (%s)",
    async (_name, initialObservation) => {
      const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-credential-throw-"));
      tempDirs.push(tempDir);
      writeFileSync(join(tempDir, "daemon.pid"), "202");
      writeFileSync(join(tempDir, "daemon.token"), "local-token");
      let staged: ManagedCredentialSnapshot | undefined;
      const probe = vi.fn(async (candidate: { scopeDigest: string; nonce: string; name: string }) => ({
        ...initialObservation,
        scopeDigest: candidate.scopeDigest,
        nonce: candidate.nonce,
        name: candidate.name,
        ...(initialObservation.kind === "registered-stale-config"
          ? { port: 19998, executable: process.execPath, args: JSON.stringify(["/path/lcm.js", "daemon", "start", "--foreground"]) }
          : {}),
      }));
      const stopAndStart = vi.fn(async (candidate: ManagedSupervisorSpec) => {
        staged = snapshotManagedCredentials(candidate);
        throw new Error("manager stop/start failed");
      });
      const ensureMock = vi.fn();
      const result = await restartDaemon({
        port: 19999,
        pidFilePath: join(tempDir, "daemon.pid"),
        spawnTimeoutMs: 100,
        enforceUserManagerParent: true,
        _platform: "linux",
        spawnArgs: initialObservation.kind === "registered-stale-config" ? ["/path/lcm.js", "daemon", "start", "--foreground"] : undefined,
        _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride,
        _isProcessAliveOverride: () => true,
        _listeningPortsOverride: () => [19999],
        _supervisorOverride: { probe, start: vi.fn(), stopAndStart, stopAndAwaitAbsent: vi.fn() } as never,
        _ensureDaemonOverride: ensureMock,
      }, { environment: { OPENAI_API_KEY: "evidence-openai" } });

      expect(result).toMatchObject({ restarted: false, connected: false, refusalReason: "startup-failure" });
      expect(stopAndStart).toHaveBeenCalledOnce();
      expect(ensureMock).not.toHaveBeenCalled();
      expect(staged?.credentialDirectory).toBeDefined();
      expect(existsSync(staged!.credentialDirectory!)).toBe(true);
      expect(staged?.files.map(file => ({ name: file.name, value: file.value }))).toEqual([
        { name: "OPENAI_API_KEY", value: "evidence-openai" },
      ]);
      for (const file of staged!.files) {
        expect(readFileSync(file.path, "utf-8")).toBe(file.value);
      }
    },
  );

  it("preserves staged launchd credentials when the post-start ensure is not admitted and cleanup is refused", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-credential-refusal-"));
      tempDirs.push(tempDir);
      writeFileSync(join(tempDir, "daemon.pid"), "202");
      writeFileSync(join(tempDir, "daemon.token"), "local-token");
      let staged: ManagedCredentialSnapshot | undefined;
      const probe = vi.fn(async (candidate: { scopeDigest: string; nonce: string; name: string }) => ({
        kind: "registered-running-valid" as const,
        managerPid: 202,
        scopeDigest: candidate.scopeDigest,
        nonce: candidate.nonce,
        name: candidate.name,
      }));
      const stopAndStart = vi.fn(async (candidate: ManagedSupervisorSpec) => {
        staged = snapshotManagedCredentials(candidate);
        return { kind: candidate.kind, name: candidate.name, scopeDigest: candidate.scopeDigest, port: 19999, nonce: candidate.nonce, managerPid: 202 };
      });
      // Real ensure terminal-cleans an unadmitted spawned restart before
      // return; only a refused manager absence proof preserves the evidence
      // (fail-closed), so this is the production-true unadmitted refusal seam.
      const stopAndAwaitAbsent = vi.fn(async () => { throw new Error("absence proof refused"); });
      const ensureResult = { connected: false, spawned: true, refusalReason: "startup-failure" as const };
      const ensureMock = vi.fn(async () => ensureResult);
      const result = await restartDaemon({
        port: 19999,
        pidFilePath: join(tempDir, "daemon.pid"),
        spawnTimeoutMs: 100,
        enforceUserManagerParent: true,
        _platform: "linux",
        _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride,
        _isProcessAliveOverride: () => true,
        _listeningPortsOverride: () => [19999],
        _supervisorOverride: { probe, start: vi.fn(), stopAndStart, stopAndAwaitAbsent } as never,
        _ensureDaemonOverride: ensureMock,
      }, { environment: { OPENAI_API_KEY: "unadmitted-secret" } });

      expect(result).toMatchObject(ensureResult);
      expect(stopAndStart).toHaveBeenCalledOnce();
      expect(ensureMock).toHaveBeenCalledOnce();
      expect(staged?.credentialDirectory).toBeDefined();
      expect(existsSync(staged!.credentialDirectory!)).toBe(true);
      for (const file of staged!.files) {
        expect(readFileSync(file.path, "utf-8")).toBe("unadmitted-secret");
      }
  });

  it.each([
    ["stale-config", { kind: "registered-stale-config" as const, reason: "metadata-mismatch" as const }],
    ["running-valid", { kind: "registered-running-valid" as const, managerPid: 202 }],
  ] as const)(
    "treats an already-absent staged credential directory as success (%s)",
    async (_name, initialObservation) => {
      const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-credential-consumed-"));
      tempDirs.push(tempDir);
      writeFileSync(join(tempDir, "daemon.pid"), "202");
      writeFileSync(join(tempDir, "daemon.token"), "local-token");
      let staged: ManagedCredentialSnapshot | undefined;
      let stagedDirectory = "";
      const probe = vi.fn(async (candidate: { scopeDigest: string; nonce: string; name: string }) => ({
        ...initialObservation,
        scopeDigest: candidate.scopeDigest,
        nonce: candidate.nonce,
        name: candidate.name,
        ...(initialObservation.kind === "registered-stale-config"
          ? { port: 19998, executable: process.execPath, args: JSON.stringify(["/path/lcm.js", "daemon", "start", "--foreground"]) }
          : {}),
      }));
      const stopAndStart = vi.fn(async (candidate: ManagedSupervisorSpec) => {
        staged = snapshotManagedCredentials(candidate);
        stagedDirectory = candidate.credentialDirectory!;
        rmSync(stagedDirectory, { recursive: true, force: true });
        return { kind: candidate.kind, name: candidate.name, scopeDigest: candidate.scopeDigest, port: 19999, nonce: candidate.nonce, managerPid: 202 };
      });
      const ensureMock = vi.fn(async () => ({ connected: true as const, port: 19999, spawned: false }));
      const result = await restartDaemon({
        port: 19999,
        pidFilePath: join(tempDir, "daemon.pid"),
        spawnTimeoutMs: 100,
        enforceUserManagerParent: true,
        _platform: "linux",
        spawnArgs: initialObservation.kind === "registered-stale-config" ? ["/path/lcm.js", "daemon", "start", "--foreground"] : undefined,
        _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride,
        _isProcessAliveOverride: () => true,
        _listeningPortsOverride: () => [19999],
        _supervisorOverride: { probe, start: vi.fn(), stopAndStart, stopAndAwaitAbsent: vi.fn() } as never,
        _ensureDaemonOverride: ensureMock,
      }, { environment: { OPENAI_API_KEY: "consumed-secret" } });

      expect(result).toMatchObject({ restarted: true, connected: true });
      expect(stagedDirectory).not.toBe("");
      expect(existsSync(stagedDirectory)).toBe(false);
      expect(staged?.files.map(file => ({ name: file.name, value: file.value }))).toEqual([
        { name: "OPENAI_API_KEY", value: "consumed-secret" },
      ]);
    },
  );

  it("stages each restart credential directory separately and leaves unrelated restart evidence untouched", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-credential-isolation-"));
    tempDirs.push(tempDir);
    writeFileSync(join(tempDir, "daemon.pid"), "202");
    writeFileSync(join(tempDir, "daemon.token"), "local-token");
    const probe = vi.fn(async (candidate: { scopeDigest: string; nonce: string; name: string }) => ({
      kind: "registered-running-valid" as const,
      managerPid: 202,
      scopeDigest: candidate.scopeDigest,
      nonce: candidate.nonce,
      name: candidate.name,
    }));
    const directories: string[] = [];
    const values: string[] = [];
    const stopAndStart = vi.fn(async (candidate: ManagedSupervisorSpec) => {
      const snapshot = snapshotManagedCredentials(candidate);
      directories.push(snapshot.credentialDirectory!);
      values.push(snapshot.files.map(file => file.value).join(","));
      return { kind: candidate.kind, name: candidate.name, scopeDigest: candidate.scopeDigest, port: 19999, nonce: candidate.nonce, managerPid: 202 };
    });
    const options = (value: string, spawned: boolean) => ({
      port: 19999,
      pidFilePath: join(tempDir, "daemon.pid"),
      spawnTimeoutMs: 100,
      enforceUserManagerParent: true,
      _platform: "linux" as const,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19999],
      _supervisorOverride: { probe, start: vi.fn(), stopAndStart, stopAndAwaitAbsent: vi.fn() } as never,
      _ensureDaemonOverride: vi.fn(async () => ({ connected: true as const, port: 19999, spawned })),
      environment: { OPENAI_API_KEY: value },
    });

    const first = await restartDaemon(options("first-secret", false), { environment: { OPENAI_API_KEY: "first-secret" } });
    expect(first).toMatchObject({ restarted: true, connected: true });
    expect(existsSync(directories[0]!)).toBe(false);
    mkdirSync(directories[0]!, { recursive: true });
    writeFileSync(join(directories[0]!, "OPENAI_API_KEY"), "preserved-evidence", { mode: 0o600 });

    const second = await restartDaemon(options("second-secret", true), { environment: { OPENAI_API_KEY: "second-secret" } });
    expect(second).toMatchObject({ restarted: true, connected: true });
    expect(directories).toHaveLength(2);
    expect(directories[0]).not.toBe(directories[1]);
    expect(basename(directories[0]!)).not.toBe(basename(directories[1]!));
    expect(values).toEqual(["first-secret", "second-secret"]);
    expect(existsSync(directories[1]!)).toBe(false);
    expect(existsSync(directories[0]!)).toBe(true);
    expect(readFileSync(join(directories[0]!, "OPENAI_API_KEY"), "utf-8")).toBe("preserved-evidence");
    expect(statSync(join(directories[0]!, "OPENAI_API_KEY")).mode & 0o777).toBe(0o600);
  });
});
