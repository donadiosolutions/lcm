import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import nodeFs, {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAuthToken } from "../../src/daemon/auth.js";
import { loadDaemonConfig, parseDaemonConfig } from "../../src/daemon/config.js";
import {
  __lifecycleTestUtils,
  ensureDaemon as ensureDaemonProduction,
  findUserSystemdPid,
  readProcessParentPid,
  restartDaemon as restartDaemonProduction,
} from "../../src/daemon/lifecycle.js";
import {
  createDaemonLifecycleTestScope,
  daemonLifecycleTestIdentityArgs,
  type DaemonLifecycleHermeticTestSeams,
} from "../../src/daemon/lifecycle-scope.js";
import { createDaemon } from "../../src/daemon/server.js";

const tempDirs: string[] = [];
const initialProcessArgv = [...process.argv];

function anchoredLeafMatches(path: string, canonicalPath: string): boolean {
  if (basename(path) !== basename(canonicalPath)) return false;
  try {
    return realpathSync(dirname(path)) === dirname(canonicalPath);
  } catch {
    return false;
  }
}

type EnsureDaemonOptions = Parameters<typeof ensureDaemonProduction>[0];
type EnsureDaemonResult = Awaited<ReturnType<typeof ensureDaemonProduction>>;
type RestartDaemonResult = Awaited<ReturnType<typeof restartDaemonProduction>>;
type FetchOverride = NonNullable<EnsureDaemonOptions["_fetchOverride"]>;
type SpawnOverride = NonNullable<EnsureDaemonOptions["_spawnOverride"]>;
type SpawnSyncOverride = NonNullable<EnsureDaemonOptions["_spawnSyncOverride"]>;
type RestartDaemonOptions = Parameters<typeof restartDaemonProduction>[0];
type RecoveryBoundaryOverride = NonNullable<
  RestartDaemonOptions["_offlineRecoveryBoundaryOverride"]
>;
type SpawnChildMock = {
  pid: number | undefined;
  unref: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
};
const testIdentity = {
  ownerId: "lifecycle-tests",
  entrypoint: "/lcm-tests/lifecycle-daemon.mjs",
} as const;

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

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...initialProcessArgv);
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

type OfflineRestartFixture = {
  pid: number;
  managerPid: number;
  root: string;
  pidFile: string;
  tokenFile: string;
  procRoot: string;
  procPidDir: string;
  entrypoint: string;
  systemdExecutable: string;
  runtimeDigest: string;
  listenerPorts: ReturnType<typeof vi.fn<(pid?: number) => number[]>>;
  killProcess: ReturnType<typeof vi.fn>;
  isAlive: ReturnType<typeof vi.fn<(pid: number) => boolean>>;
  ensureReplacement: ReturnType<typeof vi.fn>;
  healthFetch: ReturnType<typeof vi.fn>;
  removeProcess: () => void;
  setLoopbackListener: (present: boolean) => void;
  writeUserManager: (overrides?: {
    argv?: string[];
    executable?: string;
    startTime?: string;
    uid?: number;
  }) => void;
  writeProcess: (overrides?: {
    argv?: string[];
    executable?: string;
    pid?: number;
    startTime?: string;
    uid?: number;
  }) => void;
};

function createOfflineRestartFixture(
  prefix: string,
  pid = 4242,
): OfflineRestartFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  const procRoot = join(root, "proc");
  const procPidDir = join(procRoot, String(pid));
  const pidFile = join(root, "daemon.pid");
  const tokenFile = join(root, "daemon.token");
  const entrypoint = join(root, "lcm.mjs");
  const runtime = "console.log('run owned lcm runtime');\n";
  const runtimeDigest = createHash("sha256").update(runtime).digest("hex");
  writeFileSync(entrypoint, runtime);
  const managerPid = 3131;
  const systemdExecutable = join(root, "systemd");
  writeFileSync(systemdExecutable, "run-owned fake user manager\n");
  process.argv[1] = entrypoint;
  writeFileSync(pidFile, String(pid));
  chmodSync(pidFile, 0o644);
  writeFileSync(tokenFile, "local-token");
  chmodSync(tokenFile, 0o600);
  const procNetRoot = join(procRoot, "net");
  mkdirSync(procNetRoot, { recursive: true });
  const procNetHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";
  const setLoopbackListener = (present: boolean): void => {
    writeFileSync(join(procNetRoot, "tcp"), [
      procNetHeader,
      ...(present
        ? [`   0: 0100007F:4E1F 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${String(process.getuid())} 0 12345`]
        : []),
      "",
    ].join("\n"));
    writeFileSync(join(procNetRoot, "tcp6"), `${procNetHeader}\n`);
  };
  setLoopbackListener(false);
  let alive = true;
  let replacementAlive = false;
  const replacementPid = 5252;

  const writeUserManager = (overrides: {
    argv?: string[];
    executable?: string;
    startTime?: string;
    uid?: number;
  } = {}): void => {
    const managerDirectory = join(procRoot, String(managerPid));
    rmSync(managerDirectory, { recursive: true, force: true });
    mkdirSync(managerDirectory, { recursive: true });
    const argv = overrides.argv ?? [systemdExecutable, "--user"];
    const statFields = ["S", ...Array<string>(18).fill("0"), overrides.startTime ?? "313131"];
    writeFileSync(
      join(managerDirectory, "stat"),
      `${String(managerPid)} (systemd) ${statFields.join(" ")}\n`,
    );
    const uid = overrides.uid ?? process.getuid();
    writeFileSync(
      join(managerDirectory, "status"),
      `Name:\tsystemd\nUid:\t${String(uid)}\t${String(uid)}\t${String(uid)}\t${String(uid)}\nPPid:\t1\n`,
    );
    writeFileSync(join(managerDirectory, "cmdline"), `${argv.join("\0")}\0`);
    symlinkSync(overrides.executable ?? systemdExecutable, join(managerDirectory, "exe"));
  };
  writeUserManager();

  const writeProcess = (overrides: {
    argv?: string[];
    executable?: string;
    pid?: number;
    startTime?: string;
    uid?: number;
  } = {}): void => {
    const processPid = overrides.pid ?? pid;
    const processDirectory = join(procRoot, String(processPid));
    rmSync(processDirectory, { recursive: true, force: true });
    mkdirSync(processDirectory, { recursive: true });
    const argv = overrides.argv ?? [
      process.execPath,
      process.argv[1],
      "daemon",
      "start",
      "--foreground",
    ];
    const statFields = ["S", ...Array<string>(18).fill("0"), overrides.startTime ?? "123456"];
    writeFileSync(
      join(processDirectory, "stat"),
      `${String(processPid)} (node main) ${statFields.join(" ")}\n`,
    );
    writeFileSync(
      join(processDirectory, "status"),
      `Name:\tnode\nUid:\t${String(overrides.uid ?? process.getuid())}\t${String(overrides.uid ?? process.getuid())}\t${String(overrides.uid ?? process.getuid())}\t${String(overrides.uid ?? process.getuid())}\nPPid:\t${String(managerPid)}\n`,
    );
    writeFileSync(join(processDirectory, "cmdline"), `${argv.join("\0")}\0`);
    symlinkSync(overrides.executable ?? process.execPath, join(processDirectory, "exe"));
    if (processPid === pid) alive = true;
    if (processPid === replacementPid) {
      replacementAlive = true;
      const fdDirectory = join(processDirectory, "fd");
      mkdirSync(fdDirectory);
      symlinkSync("socket:[12345]", join(fdDirectory, "7"));
      setLoopbackListener(true);
    }
  };
  writeProcess();

  const removeProcess = (): void => {
    alive = false;
    rmSync(procPidDir, { recursive: true, force: true });
    setLoopbackListener(false);
  };
  const listenerPorts = vi.fn<(candidate?: number) => number[]>((candidate?: number) => (
    candidate === replacementPid
      ? (replacementAlive ? [19999] : [])
      : [19999]
  ));
  const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number): void => {
    if (signal === "SIGTERM") {
      removeProcess();
      rmSync(pidFile, { force: true });
    }
  });
  const isAlive = vi.fn<(processPid: number) => boolean>((processPid: number) => (
    (processPid === pid && alive) || (processPid === replacementPid && replacementAlive)
  ));
  const ensureReplacement = vi.fn(async () => {
    writeFileSync(pidFile, String(replacementPid));
    chmodSync(pidFile, 0o644);
    writeProcess({ pid: replacementPid, startTime: "654321" });
    return {
      connected: true,
      port: 19999,
      spawned: true,
      pid: replacementPid,
    };
  });
  const healthFetch = vi.fn(async (input: string | URL | Request) => {
    if (!replacementAlive) throw new Error("health connection failed");
    const url = String(input);
    if (url.endsWith("/stats/pool")) {
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "1.4.2",
        storageBackend: "sqlite",
        pid: replacementPid,
        entrypoint,
        runtimeDigest,
      }),
    } as Response;
  });

  return {
    pid,
    managerPid,
    root,
    pidFile,
    tokenFile,
    procRoot,
    procPidDir,
    entrypoint,
    systemdExecutable,
    runtimeDigest,
    listenerPorts,
    killProcess,
    isAlive,
    ensureReplacement,
    healthFetch,
    removeProcess,
    setLoopbackListener,
    writeUserManager,
    writeProcess,
  };
}

function offlineRestartOptions(
  fixture: OfflineRestartFixture,
  overrides: Partial<Parameters<typeof restartDaemonProduction>[0]> = {},
): Parameters<typeof restartDaemonProduction>[0] {
  return {
    port: 19999,
    pidFilePath: fixture.pidFile,
    spawnTimeoutMs: 100,
    expectedEntrypoint: fixture.entrypoint,
    expectedRuntimeDigest: fixture.runtimeDigest,
    _packagedEntrypointOverride: fixture.entrypoint,
    _platform: "linux",
    _procRoot: fixture.procRoot,
    _uid: process.getuid(),
    _realpathOverride: realpathSync,
    _fetchOverride: fixture.healthFetch,
    _listeningPortsOverride: fixture.listenerPorts,
    _isProcessAliveOverride: fixture.isAlive,
    _killOverride: fixture.killProcess,
    _sleepOverride: async () => {},
    _ensureDaemonOverride: fixture.ensureReplacement,
    ...overrides,
  };
}

function setOfflineOriginalListener(
  fixture: OfflineRestartFixture,
  socketInode = "12345",
): void {
  const fdDirectory = join(fixture.procPidDir, "fd");
  mkdirSync(fdDirectory, { recursive: true });
  const descriptorPath = join(fdDirectory, "7");
  rmSync(descriptorPath, { force: true });
  symlinkSync(`socket:[${socketInode}]`, descriptorPath);
  fixture.setLoopbackListener(true);
  if (socketInode !== "12345") {
    const tcpPath = join(fixture.procRoot, "net", "tcp");
    writeFileSync(
      tcpPath,
      readFileSync(tcpPath, "utf8").replace("12345", socketInode),
    );
  }
}

async function retainOfflineRecoveryRecord(
  fixture: OfflineRestartFixture,
): Promise<string> {
  await restartDaemon(offlineRestartOptions(fixture, {
    _offlineRecoveryBoundaryOverride: (phase: string): void => {
      if (phase === "after-recovery-backup-cleanup") {
        throw new Error("retain recovery record");
      }
    },
  })).catch(() => undefined);
  return join(fixture.root, ".daemon.pid.restart-recovery.json");
}

type OfflineEvidenceLeafSnapshot = Readonly<{
  changedAtMs: number;
  content: string;
  device: number;
  inode: number;
  links: number;
  mode: number;
  modifiedAtMs: number;
  size: number;
  uid: number;
}>;

function snapshotOfflineEvidenceLeaf(path: string): OfflineEvidenceLeafSnapshot | null {
  if (!existsSync(path)) return null;
  const stats = lstatSync(path);
  return Object.freeze({
    changedAtMs: stats.ctimeMs,
    content: readFileSync(path, "utf8"),
    device: stats.dev,
    inode: stats.ino,
    links: stats.nlink,
    mode: stats.mode,
    modifiedAtMs: stats.mtimeMs,
    size: stats.size,
    uid: stats.uid,
  });
}

function setOfflineLaunchPath(fixture: OfflineRestartFixture, launchPath: string): void {
  process.argv[1] = launchPath;
  fixture.writeProcess({
    argv: [process.execPath, launchPath, "daemon", "start", "--foreground"],
  });
}

function replaceLaunchSymlink(launchPath: string, target: string): void {
  unlinkSync(launchPath);
  symlinkSync(target, launchPath);
}

function driftOfflineStateFileTimestamp(path: string): {
  inode: number;
  size: number;
} {
  const before = statSync(path);
  utimesSync(path, before.atime, new Date(before.mtimeMs + 60_000));
  const after = statSync(path);
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).not.toBe(before.mtimeMs);
  return { inode: before.ino, size: before.size };
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

  it.each(["descriptor", "file-fsync", "parent-fsync", "open"] as const)(
    "refuses resumed signaling when durable record revalidation fails at %s",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-record-resume-${failure}-`);
      const recordPath = await retainOfflineRecoveryRecord(fixture);
      const wrongPath = join(fixture.root, "wrong-record-proof");
      writeFileSync(wrongPath, readFileSync(recordPath), { mode: 0o600 });
      let fsyncCalls = 0;

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecordOpenOverride: (path: string, flags: number, mode?: number): number => {
          if (failure === "open" && path === recordPath) throw new Error("record open denied");
          return failure === "descriptor" && path === recordPath
            ? openSync(wrongPath, constants.O_RDONLY | constants.O_NOFOLLOW)
            : openSync(path, flags, mode);
        },
        _offlineFsyncOverride: (descriptor: number): void => {
          fsyncCalls += 1;
          if (failure === "file-fsync" && fsyncCalls === 1) throw new Error("file fsync denied");
          if (failure === "parent-fsync" && fsyncCalls === 2) throw new Error("parent fsync denied");
          fsyncSync(descriptor);
        },
      }))).rejects.toThrow("could not be durably revalidated");

      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
      expect(existsSync(recordPath)).toBe(true);
    },
  );

  it("refuses a retained recovery record after launch evidence becomes unreadable", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-record-launch-unreadable-");
    const recordPath = await retainOfflineRecoveryRecord(fixture);
    unlinkSync(fixture.entrypoint);

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("recovery record does not match current configuration");

    expect(existsSync(recordPath)).toBe(true);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(false);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses a retained recovery record when the current UID is unavailable", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-record-no-resume-uid-");
    const recordPath = await retainOfflineRecoveryRecord(fixture);
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    const options = offlineRestartOptions(fixture, { _uid: undefined });
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      await expect(restartDaemonProduction(options))
        .rejects.toThrow("current UID is unavailable");
    } finally {
      if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
    }

    expect(existsSync(recordPath)).toBe(true);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(false);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

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
    const runtimeDir = join(tempDir, "runtime");
    const credentialDir = join(tempDir, "credentials");
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(credentialDir, { recursive: true });
    const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const spawnMock = vi.fn();
    const stopUnitMock = vi.fn(async () => undefined);
    const environment = {
      ANTHROPIC_API_KEY: "sk-test",
      LCM_POSTGRES_CA_FILE: "/etc/ssl/certs/postgres-ca.crt",
      LCM_POSTGRES_URL: "postgresql://user:postgres-secret@db.example.com/lcm",
      LCM_SUMMARY_API_KEY: "sk-lcm-test",
      LCM_SUMMARY_PROVIDER: "anthropic",
      PATH: "/opt/lcm-test/bin:/usr/bin",
      UNRELATED_DAEMON_VALUE: "ignored",
    };

    const result = await ensureDaemonProduction(withHermeticLifecycleSeams(
      {
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
      },
      { credentialDir, environment, runtimeDir, stopUnit: stopUnitMock },
    ));

    expect(result.startMethod).toBe("systemd-user");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "systemd-run",
      expect.arrayContaining([
        "--user",
        "--collect",
        "--no-block",
        `--setenv=HOME=${tempDir}`,
        `--setenv=USERPROFILE=${tempDir}`,
        `--setenv=XDG_RUNTIME_DIR=${runtimeDir}`,
        "--setenv=PATH=/path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "--setenv=LCM_POSTGRES_CA_FILE=/etc/ssl/certs/postgres-ca.crt",
        "--setenv=LCM_SUMMARY_PROVIDER=anthropic",
        "--setenv=LCM_SYSTEMD_CRED_IDS=ANTHROPIC_API_KEY,LCM_POSTGRES_URL,LCM_SUMMARY_API_KEY",
        "node",
        "/path/lcm.js",
        "daemon",
        "start",
        "--foreground",
      ]),
      expect.objectContaining({ encoding: "utf-8", timeout: 100 }),
    );
    const systemdArgs = spawnSyncMock.mock.calls[0][1] as string[];
    expect(systemdArgs.find(arg => arg.startsWith("--unit=")))
      .toMatch(/^--unit=lcm-test-daemon-hermetic-[0-9]+-[0-9]+$/u);
    expect(systemdArgs.find(arg => arg.startsWith("--unit=")))
      .not.toContain("--unit=lcm-daemon-");
    expect(stopUnitMock).toHaveBeenCalledExactlyOnceWith(
      systemdArgs.find(arg => arg.startsWith("--unit="))!.slice(7),
    );
    const joinedArgs = systemdArgs.join("\n");
    expect(joinedArgs).not.toContain("sk-test");
    expect(joinedArgs).not.toContain("sk-lcm-test");
    expect(joinedArgs).not.toContain("postgres-secret");
    expect(systemdArgs).not.toContain("--setenv=UNRELATED_DAEMON_VALUE=ignored");
    expect(systemdArgs).not.toContain("--setenv=PATH=/opt/lcm-test/bin:/usr/bin");
    const credentialArgs = systemdArgs.filter((arg) => arg.startsWith("--property=LoadCredential="));
    expect(credentialArgs).toEqual([
      expect.stringContaining("ANTHROPIC_API_KEY:"),
      expect.stringContaining("LCM_POSTGRES_URL:"),
      expect.stringContaining("LCM_SUMMARY_API_KEY:"),
    ]);
    for (const arg of credentialArgs) {
      const [, credentialPath] = arg.split(":", 2);
      expect(credentialPath.startsWith(`${credentialDir}/lcm-systemd-credentials-`)).toBe(true);
      expect(existsSync(credentialPath)).toBe(false);
      expect(existsSync(dirname(credentialPath))).toBe(false);
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

  it("preserves an exact live likely-LCM listener when bounded health attempts remain unavailable", async (): Promise<void> => {
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

    expect(result).toEqual({
      connected: false,
      port: 19999,
      spawned: false,
      pid: fixture.pid,
      warning: "daemon PID 200 still owns configured port 19999 but health remained unavailable after bounded retries; it may be busy, so it was preserved without signaling or replacement. Retry after the current operation completes; if it remains unavailable, inspect or explicitly stop the daemon before retrying",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(listenerPorts).toHaveBeenCalledTimes(2);
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("200");
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it.each([
    {
      platform: "darwin" as const,
      executable: "/bin/ps",
      windowsPowerShellPath: undefined,
      command: "node /usr/local/bin/lcm daemon start --foreground",
    },
    {
      platform: "win32" as const,
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      windowsPowerShellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      command: "\"C:\\Program Files\\nodejs\\node.exe\" C:\\lcm\\lcm.mjs daemon start --foreground",
    },
  ])("preserves a valid busy daemon on $platform using fail-closed command identity", async ({
    platform,
    executable,
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

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      pid: fixture.pid,
      warning: expect.stringContaining("health remained unavailable after bounded retries"),
    });
    expect(processInspector).toHaveBeenCalledTimes(4);
    for (const [actualExecutable, args, options] of processInspector.mock.calls) {
      expect(actualExecutable).toBe(executable);
      expect(options).toMatchObject({
        encoding: "utf-8",
        timeout: 1000,
        maxBuffer: 64 * 1024,
        shell: false,
        windowsHide: true,
      });
      if (platform === "darwin") {
        expect(args).toEqual(["-p", String(fixture.pid), "-o", "command="]);
      } else {
        expect(args).toEqual([
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          expect.stringMatching(new RegExp(`ProcessId = ${fixture.pid}\\b`, "u")),
        ]);
      }
    }
    expect(listenerPorts).toHaveBeenCalledTimes(2);
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
  ])("rejects busy preservation for $name", async ({
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

    expect(result).toMatchObject({ connected: false, spawned: true });
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(listenerPorts).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidFile)).toBe(false);
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
    if (outcome === "missing" || outcome === "unsupported") {
      expect(processInspector).not.toHaveBeenCalled();
    } else {
      expect(processInspector).toHaveBeenCalledOnce();
    }
  });

  it("preserves the exact busy daemon after the health deadline is exhausted", async (): Promise<void> => {
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

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      pid: fixture.pid,
      warning: expect.stringContaining("health remained unavailable after bounded retries"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("200");
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("preserves repeated busy calls and reconnects to the same PID when health recovers", async (): Promise<void> => {
    const fixture = createOwnedDaemonFixture("lcm-lifecycle-busy-recovery-");
    let healthy = false;
    const health = {
      status: "ok",
      version: "1.2.3",
      storageBackend: "sqlite",
      pid: fixture.pid,
      entrypoint: "lcm",
      runtimeDigest: "runtime-digest",
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
      expectedRuntimeDigest: "runtime-digest",
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

    expect(first).toMatchObject({ connected: false, spawned: false, pid: fixture.pid });
    expect(second).toMatchObject({ connected: false, spawned: false, pid: fixture.pid });
    expect(recovered).toMatchObject({ connected: true, spawned: false, pid: fixture.pid });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("200");
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("does not preserve, clean, signal, or spawn after the PID is concurrently replaced during busy-state revalidation", async (): Promise<void> => {
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

    expect(result).toEqual({ connected: false, port: 19999, spawned: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listenerPorts).toHaveBeenCalledTimes(2);
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("201");
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("retains fail-closed cleanup and replacement when the owned PID loses the configured listener", async (): Promise<void> => {
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

    expect(result).toMatchObject({ connected: false, spawned: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(listenerPorts).toHaveBeenCalledTimes(2);
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(existsSync(fixture.pidFile)).toBe(false);
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("terminates an exact wrong-parent likely-LCM PID after the configured listener is lost", async (): Promise<void> => {
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
      _listeningPortsOverride: listenerPorts,
      _skipSpawn: true,
    });

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(listenerPorts).toHaveBeenCalledTimes(3);
    expect(killMock).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidFile)).toBe(false);
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("retains exact wrong-parent termination when health probing is interrupted", async (): Promise<void> => {
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
      _skipSpawn: true,
    });

    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(controller.signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(killMock).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(existsSync(fixture.pidFile)).toBe(false);
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("preserves a concurrent replacement discovered while revalidating the missing listener before a wrong-parent signal", async (): Promise<void> => {
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
      _listeningPortsOverride: listenerPorts,
    });

    expect(result).toEqual({ connected: false, port: 19999, spawned: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listenerPorts).toHaveBeenCalledTimes(3);
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("201");
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it.each([
    { name: "the PID dies", processCommand: "node lcm daemon start --foreground", aliveAfterRetry: false },
    { name: "the PID is not a likely LCM daemon", processCommand: "sleep 1000", aliveAfterRetry: true },
  ])("retains fail-closed cleanup and replacement when $name", async ({
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

    expect(result).toMatchObject({ connected: false, spawned: true });
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(existsSync(fixture.pidFile)).toBe(false);
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
  it.each([
    ["tcp loopback", "tcp", "0100007F:4E1F", "0A", "listening"],
    ["tcp wildcard", "tcp", "00000000:4E1F", "0A", "listening"],
    ["tcp other address", "tcp", "0200007F:4E1F", "0A", "absent"],
    ["tcp wrong port", "tcp", "0100007F:4E20", "0A", "absent"],
    ["tcp non-listener", "tcp", "0100007F:4E1F", "01", "absent"],
    ["tcp malformed local", "tcp", "malformed", "0A", "unavailable"],
    ["tcp6 wildcard", "tcp6", "00000000000000000000000000000000:4E1F", "0A", "listening"],
    ["tcp6 mapped loopback", "tcp6", "0000000000000000FFFF00000100007F:4E1F", "0A", "listening"],
    ["tcp6 other address", "tcp6", "00000000000000000000000001000000:4E1F", "0A", "absent"],
  ] as const)(
    "classifies global Linux loopback listener state for %s",
    (
      _label: string,
      table: "tcp" | "tcp6",
      local: string,
      state: string,
      expected: "absent" | "listening" | "unavailable",
    ): void => {
      const root = mkdtempSync(join(tmpdir(), "lcm-loopback-listener-state-"));
      tempDirs.push(root);
      const netRoot = join(root, "net");
      mkdirSync(netRoot);
      const header = "sl local_address rem_address st";
      writeFileSync(join(netRoot, "tcp"), `${header}\n`);
      writeFileSync(join(netRoot, "tcp6"), `${header}\n`);
      writeFileSync(
        join(netRoot, table),
        `${header}\n0: ${local} 00000000:0000 ${state}\n`,
      );
      expect(__lifecycleTestUtils.linuxLoopbackListenerState(root, 19999)).toBe(expected);
    },
  );

  it.each([
    ["missing table", "missing"],
    ["malformed header", "header"],
    ["short row", "row"],
  ] as const)(
    "fails closed for %s in global Linux listener state",
    (_label: string, failure: "missing" | "header" | "row"): void => {
      const root = mkdtempSync(join(tmpdir(), "lcm-loopback-listener-failure-"));
      tempDirs.push(root);
      const netRoot = join(root, "net");
      mkdirSync(netRoot);
      const header = "sl local_address rem_address st";
      if (failure !== "missing") writeFileSync(join(netRoot, "tcp"), `${header}\n`);
      writeFileSync(join(netRoot, "tcp6"), `${header}\n`);
      if (failure === "header") writeFileSync(join(netRoot, "tcp"), "bad header\n");
      if (failure === "row") writeFileSync(join(netRoot, "tcp"), `${header}\nshort row\n`);
      expect(__lifecycleTestUtils.linuxLoopbackListenerState(root, 19999))
        .toBe("unavailable");
    },
  );

  it("accepts an exact npm-style symlink launch path for production offline recovery", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-launch-symlink-");
    const launchPath = join(fixture.root, "lcm");
    symlinkSync(fixture.entrypoint, launchPath);
    setOfflineLaunchPath(fixture, launchPath);

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .resolves.toMatchObject({
        connected: true,
        restarted: true,
        stoppedPid: fixture.pid,
      });

    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
  });

  it.each(["metadata drift", "close failure"] as const)(
    "refuses offline recovery when the direct proc-root descriptor has %s",
    async (failure: "metadata drift" | "close failure"): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-proc-root-${failure.replace(" ", "-")}-`);
      const originalFstat = nodeFs.fstatSync;
      const originalClose = nodeFs.closeSync;
      const leakedDescriptors: number[] = [];
      let procRootStats = 0;
      const descriptorPath = (descriptor: number): string | null => {
        try {
          return readlinkSync(`/proc/self/fd/${String(descriptor)}`);
        } catch {
          return null;
        }
      };
      try {
        if (failure === "metadata drift") {
          nodeFs.fstatSync = ((descriptor: number): Stats => {
            const stats = originalFstat(descriptor);
            if (descriptorPath(descriptor) !== fixture.procRoot || ++procRootStats !== 2) {
              return stats;
            }
            return {
              ...stats,
              ino: stats.ino + 1,
              isDirectory: (): boolean => true,
            } as Stats;
          }) as typeof nodeFs.fstatSync;
        } else {
          nodeFs.closeSync = ((descriptor: number): void => {
            if (descriptorPath(descriptor) === fixture.procRoot) {
              leakedDescriptors.push(descriptor);
              throw new Error("close failure");
            }
            originalClose(descriptor);
          }) as typeof nodeFs.closeSync;
        }
        syncBuiltinESMExports();

        await expect(restartDaemon(offlineRestartOptions(fixture)))
          .rejects.toThrow("not a verified LCM daemon");
        expect(fixture.killProcess).not.toHaveBeenCalled();
        expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      } finally {
        nodeFs.fstatSync = originalFstat;
        nodeFs.closeSync = originalClose;
        syncBuiltinESMExports();
        for (const descriptor of leakedDescriptors) originalClose(descriptor);
      }
    },
  );

  it.each([
    "relative",
    "absolute lexically noncanonical",
    "canonical inside-home symlink",
    "absolute lexically canonical nonexistent",
    "absolute physically canonical regular file",
  ] as const)(
    "refuses offline recovery for a %s direct proc-root path",
    async (
      variant:
        | "relative"
        | "absolute lexically noncanonical"
        | "canonical inside-home symlink"
        | "absolute lexically canonical nonexistent"
        | "absolute physically canonical regular file",
    ): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-proc-root-path-${variant.replaceAll(" ", "-")}-`,
      );
      const recoveryPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const lexicalAuxiliary = join(fixture.root, "lexical-auxiliary");
      const symlinkRoot = join(fixture.root, "proc-root-link");
      const symlinkTarget = join(fixture.root, "proc-root-target");
      const nonexistentRoot = join(fixture.root, "nonexistent-proc-root");
      const regularFileRoot = join(fixture.root, "regular-file-proc-root");
      const cleanupSymlinks: string[] = [];
      const cleanupFiles: string[] = [];
      const cleanupDirectories: string[] = [];
      const cleanupProofPaths: string[] = [];
      const originalOpenSync = nodeFs.openSync;
      const originalReadSync = nodeFs.readSync;
      const originalCloseSync = nodeFs.closeSync;
      const tokenDescriptors = new Set<number>();
      const pidBytesBefore = readFileSync(fixture.pidFile);
      const tokenBytesBefore = readFileSync(fixture.tokenFile);
      const pidProofBefore = lstatSync(fixture.pidFile);
      const tokenProofBefore = lstatSync(fixture.tokenFile);
      const hostFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("host fetch is forbidden in a proc-root guard test"),
      );
      const hostKill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("host signal is forbidden in a proc-root guard test");
      });
      const hostSpawn = vi.fn(() => makeSpawnChild(undefined)) as unknown as SpawnOverride;
      const hostSpawnSync = vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: "host spawn is forbidden in a proc-root guard test",
      })) as unknown as SpawnSyncOverride;
      const recoveryBoundary = vi.fn();
      const pidRename = vi.fn();
      const pidUnlink = vi.fn();
      const recoveryOpen = vi.fn();
      const recoveryUnlink = vi.fn();
      const recoveryBackupUnlink = vi.fn();
      let tokenContentReadCalls = 0;
      let hostFetchCalls = -1;
      let hostKillCalls = -1;
      let guardPathEvidenceUnchanged = true;
      let regularFileBytesBefore: Buffer | undefined;
      let regularFileProofBefore: Stats | undefined;
      let procRoot = "";
      let result: RestartDaemonResult | undefined;
      let restartError: unknown;

      expect(existsSync(recoveryPath)).toBe(false);
      expect(existsSync(quarantinePath)).toBe(false);

      try {
        if (variant === "relative") {
          procRoot = relative(process.cwd(), fixture.procRoot);
        } else if (variant === "absolute lexically noncanonical") {
          mkdirSync(lexicalAuxiliary);
          cleanupDirectories.push(lexicalAuxiliary);
          cleanupProofPaths.push(lexicalAuxiliary);
          procRoot = `${fixture.root}/./lexical-auxiliary/../proc`;
        } else if (variant === "canonical inside-home symlink") {
          mkdirSync(symlinkTarget);
          symlinkSync(symlinkTarget, symlinkRoot, "dir");
          cleanupSymlinks.push(symlinkRoot);
          cleanupDirectories.push(symlinkTarget);
          cleanupProofPaths.push(symlinkRoot, symlinkTarget);
          procRoot = symlinkRoot;
        } else if (variant === "absolute lexically canonical nonexistent") {
          cleanupDirectories.push(nonexistentRoot);
          cleanupProofPaths.push(nonexistentRoot);
          procRoot = nonexistentRoot;
        } else {
          writeFileSync(regularFileRoot, "run-owned non-directory proc root\n");
          regularFileBytesBefore = readFileSync(regularFileRoot);
          regularFileProofBefore = lstatSync(regularFileRoot);
          cleanupFiles.push(regularFileRoot);
          cleanupProofPaths.push(regularFileRoot);
          procRoot = regularFileRoot;
        }

        nodeFs.openSync = ((
          path: string | Buffer | URL,
          flags: string | number,
          mode?: string | number,
        ): number => {
          const descriptor = Reflect.apply(
            originalOpenSync,
            nodeFs,
            mode === undefined ? [path, flags] : [path, flags, mode],
          ) as number;
          if (String(path) === fixture.tokenFile) tokenDescriptors.add(descriptor);
          return descriptor;
        }) as typeof nodeFs.openSync;
        nodeFs.readSync = ((...args: unknown[]): number => {
          if (tokenDescriptors.has(args[0] as number)) tokenContentReadCalls += 1;
          return Reflect.apply(originalReadSync, nodeFs, args) as number;
        }) as typeof nodeFs.readSync;
        nodeFs.closeSync = ((descriptor: number): void => {
          try {
            originalCloseSync(descriptor);
          } finally {
            tokenDescriptors.delete(descriptor);
          }
        }) as typeof nodeFs.closeSync;
        syncBuiltinESMExports();

        try {
          result = await restartDaemonProduction(offlineRestartOptions(fixture, {
            _procRoot: procRoot,
            _spawnOverride: hostSpawn,
            _spawnSyncOverride: hostSpawnSync,
            _offlineRecoveryBoundaryOverride: recoveryBoundary,
            _offlinePidRenameOverride: pidRename as never,
            _offlinePidUnlinkOverride: pidUnlink as never,
            _offlineRecordOpenOverride: recoveryOpen as never,
            _offlineRecordUnlinkOverride: recoveryUnlink as never,
            _offlineRecoveryBackupUnlinkOverride: recoveryBackupUnlink as never,
          }));
        } catch (error) {
          restartError = error;
        }
      } finally {
        nodeFs.openSync = originalOpenSync;
        nodeFs.readSync = originalReadSync;
        nodeFs.closeSync = originalCloseSync;
        syncBuiltinESMExports();
        hostFetchCalls = hostFetch.mock.calls.length;
        hostKillCalls = hostKill.mock.calls.length;
        hostFetch.mockRestore();
        hostKill.mockRestore();
        if (variant === "absolute lexically canonical nonexistent") {
          try {
            lstatSync(nonexistentRoot);
            guardPathEvidenceUnchanged = false;
          } catch (error) {
            guardPathEvidenceUnchanged = (
              error as NodeJS.ErrnoException
            ).code === "ENOENT";
          }
        }
        if (variant === "absolute physically canonical regular file") {
          const regularFileProofAfter = lstatSync(regularFileRoot);
          guardPathEvidenceUnchanged = regularFileBytesBefore !== undefined
            && regularFileProofBefore !== undefined
            && readFileSync(regularFileRoot).equals(regularFileBytesBefore)
            && regularFileProofAfter.dev === regularFileProofBefore.dev
            && regularFileProofAfter.ino === regularFileProofBefore.ino
            && regularFileProofAfter.mode === regularFileProofBefore.mode
            && regularFileProofAfter.uid === regularFileProofBefore.uid
            && regularFileProofAfter.nlink === regularFileProofBefore.nlink
            && regularFileProofAfter.size === regularFileProofBefore.size
            && regularFileProofAfter.mtimeMs === regularFileProofBefore.mtimeMs
            && regularFileProofAfter.ctimeMs === regularFileProofBefore.ctimeMs;
        }
        for (const path of cleanupSymlinks) {
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        for (const path of cleanupFiles) {
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        for (const path of cleanupDirectories) {
          rmSync(path, { recursive: true, force: true });
        }
      }

      const cleanupProved = cleanupProofPaths.every((path: string): boolean => {
        try {
          lstatSync(path);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ENOENT";
        }
      });
      expect(cleanupProved).toBe(true);
      expect(guardPathEvidenceUnchanged).toBe(true);
      expect(result).toBeUndefined();
      expect(restartError).toEqual(expect.objectContaining({
        message: expect.stringContaining("not a verified LCM daemon"),
      }));
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(hostSpawn).not.toHaveBeenCalled();
      expect(hostSpawnSync).not.toHaveBeenCalled();
      expect(hostFetchCalls).toBe(0);
      expect(hostKillCalls).toBe(0);
      expect(recoveryBoundary).not.toHaveBeenCalled();
      expect(pidRename).not.toHaveBeenCalled();
      expect(pidUnlink).not.toHaveBeenCalled();
      expect(recoveryOpen).not.toHaveBeenCalled();
      expect(recoveryUnlink).not.toHaveBeenCalled();
      expect(recoveryBackupUnlink).not.toHaveBeenCalled();
      expect(tokenContentReadCalls).toBe(0);
      expect(readFileSync(fixture.pidFile)).toEqual(pidBytesBefore);
      expect(readFileSync(fixture.tokenFile)).toEqual(tokenBytesBefore);
      expect(lstatSync(fixture.pidFile)).toMatchObject({
        dev: pidProofBefore.dev,
        ino: pidProofBefore.ino,
        mode: pidProofBefore.mode,
        uid: pidProofBefore.uid,
        nlink: pidProofBefore.nlink,
        size: pidProofBefore.size,
        mtimeMs: pidProofBefore.mtimeMs,
        ctimeMs: pidProofBefore.ctimeMs,
      });
      expect(lstatSync(fixture.tokenFile)).toMatchObject({
        dev: tokenProofBefore.dev,
        ino: tokenProofBefore.ino,
        mode: tokenProofBefore.mode,
        uid: tokenProofBefore.uid,
        nlink: tokenProofBefore.nlink,
        size: tokenProofBefore.size,
        mtimeMs: tokenProofBefore.mtimeMs,
        ctimeMs: tokenProofBefore.ctimeMs,
      });
      expect(existsSync(recoveryPath)).toBe(false);
      expect(existsSync(quarantinePath)).toBe(false);
    },
  );

  it.each(["missing stat", "unsafe stat", "malformed stat", "invalid start"] as const)(
    "refuses a replacement whose direct birth proof has %s",
    async (failure: "missing stat" | "unsafe stat" | "malformed stat" | "invalid start"): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-replacement-${failure.replace(" ", "-")}-`);
      const ensureReplacement = fixture.ensureReplacement.getMockImplementation();
      expect(ensureReplacement).toBeDefined();
      fixture.ensureReplacement.mockImplementation(async () => {
        const result = await ensureReplacement!();
        const statPath = join(fixture.procRoot, "5252", "stat");
        if (failure === "missing stat") unlinkSync(statPath);
        if (failure === "unsafe stat") chmodSync(statPath, 0o666);
        if (failure === "malformed stat") writeFileSync(statPath, "malformed stat\n");
        if (failure === "invalid start") writeFileSync(statPath, "5252 (node) S\n");
        return result;
      });

      await expect(restartDaemon(offlineRestartOptions(fixture)))
        .resolves.toMatchObject({
          connected: false,
          restarted: false,
          stoppedPid: fixture.pid,
          warning: expect.stringContaining("replacement could not be independently authenticated"),
        });
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "unsafe birth metadata",
    "malformed birth stat",
    "invalid birth start",
    "manager birth drift",
    "launch disappears",
  ] as const)(
    "refuses a replacement whose callback-free direct proof has %s",
    async (scenario): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-direct-race-${scenario.replaceAll(" ", "-")}-`);
      const originalArgv = [...process.argv];
      const replacementStat = join(fixture.procRoot, "5252", "stat");
      const managerStat = join(fixture.procRoot, String(fixture.managerPid), "stat");
      try {
        await expect(restartDaemon(offlineRestartOptions(fixture, {
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase !== "before-terminal-restart-publication") return;
            if (scenario === "unsafe birth metadata") chmodSync(replacementStat, 0o666);
            if (scenario === "malformed birth stat") {
              writeFileSync(replacementStat, "malformed stat\n");
            }
            if (scenario === "invalid birth start") {
              writeFileSync(replacementStat, "5252 (node main) S 0 0 0\n");
            }
            if (scenario === "manager birth drift") {
              const managerValue = readFileSync(managerStat, "utf8").replace("313131", "313132");
              writeFileSync(managerStat, managerValue);
            }
            if (scenario === "launch disappears") {
              unlinkSync(join(fixture.procRoot, "5252", "cmdline"));
            }
          },
        })))
          .resolves.toMatchObject({
            connected: false,
            restarted: false,
            stoppedPid: fixture.pid,
            warning: expect.stringContaining("offline restart replacement is"),
          });
        expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
        expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
      } finally {
        process.argv.splice(0, process.argv.length, ...originalArgv);
      }
    },
  );

  it.each(["metadata drift", "blank token"] as const)(
    "refuses final replacement authentication after token %s",
    async (scenario: "metadata drift" | "blank token"): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-final-token-${scenario.replace(" ", "-")}-`);
      if (scenario === "blank token") writeFileSync(fixture.tokenFile, " \n", { mode: 0o600 });
      const originalRead = nodeFs.readSync;
      let tokenReadMutated = false;
      try {
        if (scenario === "metadata drift") {
          nodeFs.readSync = ((
            descriptor: number,
            buffer: NodeJS.ArrayBufferView,
            offset: number,
            length: number,
            position: number | null,
          ): number => {
            const bytesRead = originalRead(descriptor, buffer, offset, length, position);
            if (
              bytesRead > 0
              && !tokenReadMutated
              && readlinkSync(`/proc/self/fd/${String(descriptor)}`) === fixture.tokenFile
            ) {
              tokenReadMutated = true;
              chmodSync(fixture.tokenFile, 0o640);
            }
            return bytesRead;
          }) as typeof nodeFs.readSync;
          syncBuiltinESMExports();
        }

        await expect(restartDaemon(offlineRestartOptions(fixture)))
          .resolves.toMatchObject({
            connected: false,
            restarted: false,
            stoppedPid: fixture.pid,
            warning: expect.stringContaining("replacement"),
          });
        if (scenario === "metadata drift") expect(tokenReadMutated).toBe(true);
        expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
        expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
      } finally {
        nodeFs.readSync = originalRead;
        syncBuiltinESMExports();
        chmodSync(fixture.tokenFile, 0o600);
      }
    },
  );

  it("preserves recovery evidence when the stopped process directory becomes unreadable", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-stopped-directory-unreadable-");
    const originalLstat = nodeFs.lstatSync;
    let processRemoved = false;
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal !== "SIGTERM") return;
        fixture.removeProcess();
        processRemoved = true;
      },
    );
    try {
      nodeFs.lstatSync = ((path: string): Stats => {
        if (processRemoved && path === fixture.procPidDir) {
          const error = new Error("unreadable process directory") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalLstat(path);
      }) as typeof nodeFs.lstatSync;
      syncBuiltinESMExports();

      await expect(restartDaemon(offlineRestartOptions(fixture)))
        .rejects.toThrow("daemon identity changed before SIGKILL");
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
    } finally {
      nodeFs.lstatSync = originalLstat;
      syncBuiltinESMExports();
    }
  });

  it.each([
    "candidate parent one",
    "manager executable mismatch",
    "manager executable resolution",
    "unsafe process directory",
    "nonnumeric fd",
    "unreadable fd",
    "no socket fd",
    "malformed listener row",
    "malformed listener field",
    "foreign listener row",
    "wrong-uid listener row",
    "ipv4 wildcard listener",
    "ipv6 wildcard listener",
    "tcp6 mapped listener",
  ] as const)(
    "handles replacement direct parent/listener proof case %s",
    async (scenario): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-direct-${scenario.replaceAll(" ", "-")}-`);
      if (scenario === "manager executable mismatch") {
        fixture.writeUserManager({ executable: "/bin/sh" });
      }
      if (scenario === "manager executable resolution") {
        fixture.writeUserManager({
          argv: [join(fixture.root, "missing", "systemd"), "--user"],
          executable: "/bin/sh",
        });
      }
      const ensureReplacement = fixture.ensureReplacement.getMockImplementation();
      expect(ensureReplacement).toBeDefined();
      fixture.ensureReplacement.mockImplementation(async () => {
        const result = await ensureReplacement!();
        const replacementRoot = join(fixture.procRoot, "5252");
        const fdRoot = join(replacementRoot, "fd");
        const tcpPath = join(fixture.procRoot, "net", "tcp");
        const tcp6Path = join(fixture.procRoot, "net", "tcp6");
        if (scenario === "candidate parent one") {
          const statusPath = join(replacementRoot, "status");
          writeFileSync(statusPath, readFileSync(statusPath, "utf8").replace(/PPid:\t\d+/u, "PPid:\t1"));
        }
        if (scenario === "unsafe process directory") chmodSync(replacementRoot, 0o777);
        if (scenario === "nonnumeric fd") writeFileSync(join(fdRoot, "not-a-number"), "x");
        if (scenario === "unreadable fd") {
          unlinkSync(join(fdRoot, "7"));
          writeFileSync(join(fdRoot, "7"), "not a link");
        }
        if (scenario === "no socket fd") {
          unlinkSync(join(fdRoot, "7"));
          symlinkSync("pipe:[12345]", join(fdRoot, "7"));
        }
        if (scenario === "malformed listener row") {
          const header = readFileSync(tcpPath, "utf8").split("\n", 1)[0]!;
          writeFileSync(tcpPath, `${header}\nmalformed row\n`);
        }
        if (scenario === "malformed listener field") {
          const [header, listener] = readFileSync(tcpPath, "utf8").split("\n");
          const columns = listener!.trim().split(/\s+/u);
          columns[7] = "not-a-uid";
          writeFileSync(tcpPath, `${header}\n${columns.join(" ")}\n`);
        }
        if (scenario === "foreign listener row") {
          const [header, listener] = readFileSync(tcpPath, "utf8").split("\n");
          writeFileSync(tcpPath, `${header}\n${listener!.replace("12345", "99999")}\n${listener}\n`);
        }
        if (scenario === "wrong-uid listener row") {
          const [header, listener] = readFileSync(tcpPath, "utf8").split("\n");
          const columns = listener!.trim().split(/\s+/u);
          columns[7] = String(process.getuid() + 1);
          writeFileSync(tcpPath, `${header}\n${columns.join(" ")}\n`);
        }
        if (scenario === "ipv4 wildcard listener") {
          const [header, listener] = readFileSync(tcpPath, "utf8").split("\n");
          const wildcard = listener!
            .replace("0100007F", "00000000")
            .replace("12345", "99999");
          writeFileSync(tcpPath, `${header}\n${listener}\n${wildcard}\n`);
        }
        if (scenario === "ipv6 wildcard listener") {
          const [header, listener] = readFileSync(tcpPath, "utf8").split("\n");
          const wildcard = listener!
            .replace("0100007F", "00000000000000000000000000000000")
            .replace("12345", "99999");
          writeFileSync(tcp6Path, `${header}\n${wildcard}\n`);
        }
        if (scenario === "tcp6 mapped listener") {
          const [header, listener] = readFileSync(tcpPath, "utf8").split("\n");
          writeFileSync(tcpPath, `${header}\n`);
          writeFileSync(
            tcp6Path,
            `${header}\n${listener!.replace("0100007F", "0000000000000000FFFF00000100007F")}\n`,
          );
        }
        return result;
      });

      const result = await restartDaemon(offlineRestartOptions(fixture));
      const succeeds = scenario === "tcp6 mapped listener";
      expect(result).toMatchObject(succeeds
        ? { connected: true, restarted: true, stoppedPid: fixture.pid }
        : {
            connected: false,
            restarted: false,
            stoppedPid: fixture.pid,
            warning: expect.stringContaining("offline restart replacement is unavailable because"),
          });
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "parent status read",
    "listener inode",
    "wrong-uid listener row",
    "ipv4 wildcard listener",
    "ipv6 wildcard listener",
  ] as const)(
    "refuses terminal direct proof after %s failure",
    async (scenario): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-terminal-direct-${scenario.replaceAll(" ", "-")}-`);
      const replacementStatus = join(fixture.procRoot, "5252", "status");
      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase !== "before-terminal-restart-publication") return;
          if (scenario === "parent status read") {
            writeFileSync(replacementStatus, "malformed\n");
          } else {
            const tcpPath = join(fixture.procRoot, "net", "tcp");
            const [header, listener] = readFileSync(tcpPath, "utf8").split("\n");
            if (scenario === "listener inode") {
              const columns = listener!.trim().split(/\s+/u);
              columns[9] = "not-an-inode";
              writeFileSync(tcpPath, `${header}\n${columns.join(" ")}\n`);
            }
            if (scenario === "wrong-uid listener row") {
              const columns = listener!.trim().split(/\s+/u);
              columns[7] = String(process.getuid() + 1);
              writeFileSync(tcpPath, `${header}\n${columns.join(" ")}\n`);
            }
            if (scenario === "ipv4 wildcard listener") {
              const wildcard = listener!
                .replace("0100007F", "00000000")
                .replace("12345", "99999");
              writeFileSync(tcpPath, `${header}\n${listener}\n${wildcard}\n`);
            }
            if (scenario === "ipv6 wildcard listener") {
              const wildcard = listener!
                .replace("0100007F", "00000000000000000000000000000000")
                .replace("12345", "99999");
              writeFileSync(join(fixture.procRoot, "net", "tcp6"), `${header}\n${wildcard}\n`);
            }
          }
        },
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        stoppedPid: fixture.pid,
        warning: expect.stringContaining("terminal callback-free replacement"),
      });
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    },
  );

  it("refuses terminal publication when state changes after the first snapshot consumed it", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-concurrent-state-race-");
    const tcpPath = join(fixture.procRoot, "net", "tcp");
    const readyPath = join(fixture.root, "terminal-mutator-ready");
    let mutator: ReturnType<typeof spawn> | undefined;
    let mutatorExit: Promise<number | null> | undefined;

    try {
      const result = await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase !== "before-terminal-restart-publication") return;
          const [header, listener] = readFileSync(tcpPath, "utf8").split("\n");
          expect(header).toBeDefined();
          expect(listener).toBeDefined();
          writeFileSync(
            tcpPath,
            `${header!}\n${`${listener!}\n`.repeat(6_001)}`,
          );
          const oldAccess = new Date(946_684_800_000);
          const currentModification = statSync(tcpPath).mtime;
          utimesSync(tcpPath, oldAccess, currentModification);
          mutator = spawn(process.execPath, [
            "-e",
            [
              "const fs = require('node:fs');",
              "const [tcp, pidFile, ready] = process.argv.slice(1);",
              "const baseline = fs.statSync(tcp).atimeMs;",
              "fs.writeFileSync(ready, 'ready');",
              "const deadline = Date.now() + 5000;",
              "while (Date.now() < deadline) {",
              "  if (fs.statSync(tcp).atimeMs !== baseline) {",
              "    fs.writeFileSync(pidFile, '9999');",
              "    process.exit(0);",
              "  }",
              "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);",
              "}",
              "process.exit(2);",
            ].join("\n"),
            tcpPath,
            fixture.pidFile,
            readyPath,
          ], { stdio: "ignore" });
          mutatorExit = new Promise((resolve, reject) => {
            mutator!.once("error", reject);
            mutator!.once("exit", resolve);
          });
          const readyDeadline = Date.now() + 5_000;
          while (!existsSync(readyPath) && Date.now() < readyDeadline) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
          }
          if (!existsSync(readyPath)) throw new Error("terminal mutator did not become ready");
        },
      }));

      expect(await mutatorExit).toBe(0);
      expect(result).toMatchObject({
        connected: false,
        restarted: false,
        stoppedPid: fixture.pid,
        warning: expect.stringContaining("terminal callback-free replacement"),
      });
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("9999");
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    } finally {
      if (mutator !== undefined && mutator.exitCode === null) mutator.kill("SIGKILL");
      await mutatorExit?.catch(() => undefined);
    }
  }, 15_000);

  it("refuses a canonical-equivalent daemon alias that differs from the trusted launch path", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-alternate-launch-alias-");
    const trustedLaunchPath = join(fixture.root, "trusted-lcm");
    const alternateLaunchPath = join(fixture.root, "alternate-lcm");
    symlinkSync(fixture.entrypoint, trustedLaunchPath);
    symlinkSync(fixture.entrypoint, alternateLaunchPath);
    process.argv[1] = trustedLaunchPath;
    fixture.writeProcess({
      argv: [process.execPath, alternateLaunchPath, "daemon", "start", "--foreground"],
    });

    await expect(restartDaemonProduction(offlineRestartOptions(fixture)))
      .rejects.toThrow("not a verified LCM daemon");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "relative",
      prepare: (_fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        process.argv[1] = "relative-lcm.mjs";
        return {};
      },
    },
    {
      label: "missing",
      prepare: (_fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        process.argv.splice(1);
        return {};
      },
    },
    {
      label: "unreadable",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        const launchPath = join(fixture.root, "unreadable-lcm");
        symlinkSync(fixture.entrypoint, launchPath);
        setOfflineLaunchPath(fixture, launchPath);
        return {
          _realpathOverride: (path: string): string => {
            if (path === launchPath) throw new Error("launch evidence unreadable");
            return realpathSync(path);
          },
        };
      },
    },
  ])("refuses $label caller launch evidence", async ({
    prepare,
  }: {
    prepare: (
      fixture: OfflineRestartFixture,
    ) => Partial<Parameters<typeof restartDaemonProduction>[0]>;
  }): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-caller-launch-proof-");
    const overrides = prepare(fixture);

    await expect(restartDaemonProduction(offlineRestartOptions(fixture, overrides)))
      .rejects.toThrow("not a verified LCM daemon");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses caller launch evidence whose symlink target changes during initial capture", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-launch-capture-race-");
    const launchPath = join(fixture.root, "lcm");
    const alternateEntrypoint = join(fixture.root, "alternate-lcm.mjs");
    writeFileSync(alternateEntrypoint, readFileSync(fixture.entrypoint));
    symlinkSync(fixture.entrypoint, launchPath);
    setOfflineLaunchPath(fixture, launchPath);
    fixture.listenerPorts.mockImplementation((): number[] => {
      if (fixture.listenerPorts.mock.calls.length === 2) {
        replaceLaunchSymlink(launchPath, alternateEntrypoint);
      }
      return [19999];
    });

    await expect(restartDaemonProduction(offlineRestartOptions(fixture)))
      .rejects.toThrow("not a verified LCM daemon");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses caller launch evidence that disappears during initial capture", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-launch-disappears-");
    fixture.listenerPorts.mockImplementation((): number[] => {
      if (fixture.listenerPorts.mock.calls.length === 2) process.argv.splice(1);
      return [19999];
    });

    await expect(restartDaemonProduction(offlineRestartOptions(fixture)))
      .rejects.toThrow("not a verified LCM daemon");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses a relative caller launch path introduced during the final capture read", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-final-relative-launch-");
    const originalProcArgv = readFileSync(join(fixture.procPidDir, "cmdline"));
    fixture.listenerPorts.mockImplementation((): number[] => {
      if (fixture.listenerPorts.mock.calls.length === 2) process.argv[1] = "relative-lcm.mjs";
      return [19999];
    });

    await expect(restartDaemonProduction(offlineRestartOptions(fixture)))
      .rejects.toThrow("not a verified LCM daemon");

    expect(readFileSync(join(fixture.procPidDir, "cmdline"))).toEqual(originalProcArgv);
    expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses a canonical-equivalent caller alias introduced during the final capture read", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-final-alias-launch-");
    const originalLaunchPath = process.argv[1];
    const originalProcArgv = readFileSync(join(fixture.procPidDir, "cmdline"));
    const alternateLaunchPath = join(fixture.root, "alternate-lcm");
    symlinkSync(fixture.entrypoint, alternateLaunchPath);
    expect(realpathSync(alternateLaunchPath)).toBe(realpathSync(originalLaunchPath));
    fixture.listenerPorts.mockImplementation((): number[] => {
      if (fixture.listenerPorts.mock.calls.length === 2) process.argv[1] = alternateLaunchPath;
      return [19999];
    });

    await expect(restartDaemonProduction(offlineRestartOptions(fixture)))
      .rejects.toThrow("not a verified LCM daemon");

    expect(readFileSync(join(fixture.procPidDir, "cmdline"))).toEqual(originalProcArgv);
    expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses same-length daemon argv drift during the final initial-fingerprint reread", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-final-argv-drift-");
    const cmdlinePath = join(fixture.procPidDir, "cmdline");
    const recoveryPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const originalBytes = readFileSync(cmdlinePath);
    const originalStats = lstatSync(cmdlinePath);
    const originalPidBytes = readFileSync(fixture.pidFile);
    const originalTokenBytes = readFileSync(fixture.tokenFile);
    const originalArgv = originalBytes.toString("utf8").split("\0");
    const mutatedArgv = [...originalArgv];
    mutatedArgv[2] = "daemox";
    const mutatedBytes = Buffer.from(mutatedArgv.join("\0"), "utf8");
    const spawn = vi.fn(() => makeSpawnChild(5252)) as unknown as SpawnOverride;
    const recoveryBoundary = vi.fn();
    let mutationObserved = false;
    let restartError: unknown;
    let restoredBytes: Buffer | undefined;
    let restoredStats: Stats | undefined;

    expect(originalStats.isFile()).toBe(true);
    expect(originalStats.isSymbolicLink()).toBe(false);
    expect(originalArgv.at(-1)).toBe("");
    expect(originalArgv[2]).toBe("daemon");
    expect(mutatedArgv).toHaveLength(originalArgv.length);
    expect(mutatedBytes.byteLength).toBe(originalBytes.byteLength);
    expect(mutatedBytes.filter(byte => byte === 0)).toHaveLength(
      originalBytes.filter(byte => byte === 0).length,
    );
    expect(mutatedArgv[0]).toBe(originalArgv[0]);
    expect(mutatedArgv[1]).toBe(originalArgv[1]);
    expect(mutatedArgv.slice(3)).toEqual(originalArgv.slice(3));

    let processExecutableReads = 0;
    const realpath = (path: string): string => {
      if (path === join(fixture.procPidDir, "exe")) {
        processExecutableReads += 1;
      }
      if (processExecutableReads === 1 && !mutationObserved) {
        const beforeMutation = lstatSync(cmdlinePath);
        expect(readFileSync(cmdlinePath)).toEqual(originalBytes);
        expect(beforeMutation.ino).toBe(originalStats.ino);
        expect(beforeMutation.mode).toBe(originalStats.mode);
        writeFileSync(cmdlinePath, mutatedBytes);
        const afterMutation = lstatSync(cmdlinePath);
        expect(readFileSync(cmdlinePath)).toEqual(mutatedBytes);
        expect(afterMutation.ino).toBe(originalStats.ino);
        expect(afterMutation.mode).toBe(originalStats.mode);
        mutationObserved = true;
      }
      return realpathSync(path);
    };

    try {
      await restartDaemon(offlineRestartOptions(fixture, {
        _spawnOverride: spawn,
        _realpathOverride: realpath,
        _offlineRecoveryBoundaryOverride: recoveryBoundary,
      }));
    } catch (error) {
      restartError = error;
    } finally {
      writeFileSync(cmdlinePath, originalBytes);
      restoredBytes = readFileSync(cmdlinePath);
      restoredStats = lstatSync(cmdlinePath);
    }

    expect(restartError).toEqual(expect.any(Error));
    expect((restartError as Error).message).toContain(
      "complete offline identity could not be verified",
    );
    expect(mutationObserved).toBe(true);
    expect(fixture.listenerPorts).toHaveBeenCalledOnce();
    expect(restoredBytes).toEqual(originalBytes);
    expect(restoredStats?.ino).toBe(originalStats.ino);
    expect(restoredStats?.mode).toBe(originalStats.mode);
    expect(restoredStats?.isFile()).toBe(true);
    expect(restoredStats?.isSymbolicLink()).toBe(false);
    expect(realpathSync(cmdlinePath)).toBe(cmdlinePath);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(recoveryBoundary).not.toHaveBeenCalled();
    expect(existsSync(recoveryPath)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(false);
    expect(readFileSync(fixture.pidFile)).toEqual(originalPidBytes);
    expect(readFileSync(fixture.tokenFile)).toEqual(originalTokenBytes);
    expect(fixture.isAlive(fixture.pid)).toBe(true);
  });

  it("recovers an offline-verified Linux daemon after public health returns no HTTP response", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-success-");
    const result = await restartDaemon(offlineRestartOptions(fixture));

    expect(result).toMatchObject({
      connected: true,
      spawned: true,
      restarted: true,
      stoppedPid: fixture.pid,
      pid: 5252,
    });
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(false);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(false);
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("local-token");
  });

  it("normalizes legacy SQLite and retains replacement owner identity in final proof", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-legacy-health-");
    const fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      if (!existsSync(join(fixture.procRoot, "5252"))) throw new Error("daemon is wedged");
      if (String(input).endsWith("/stats/pool")) {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          version: "1.4.2",
          pid: 5252,
          ownerId: "replacement-owner",
          entrypoint: fixture.entrypoint,
          runtimeDigest: fixture.runtimeDigest,
        }),
      } as Response;
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _fetchOverride: fetch,
    }))).resolves.toMatchObject({ connected: true, restarted: true, pid: 5252 });
  });

  it("durably records offline recovery before signaling and blocks generic startup until explicit reconciliation", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-durable-record-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const opened: Array<{ path: string; flags: number; mode?: number }> = [];
    const fsync = vi.fn(fsyncSync);
    const boundary = vi.fn((phase: string): void => {
      if (phase === "after-record-create") throw new Error("simulated crash after record");
    });
    const genericEnsureOptions = withHermeticLifecycleSeams({
      port: 19999,
      pidFilePath: fixture.pidFile,
      spawnTimeoutMs: 100,
      _fetchOverride: fixture.healthFetch,
      _killOverride: fixture.killProcess,
      _listeningPortsOverride: fixture.listenerPorts,
      _isProcessAliveOverride: fixture.isAlive,
      _sleepOverride: async () => {},
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecordOpenOverride: (path: string, flags: number, mode?: number): number => {
        opened.push({ path, flags, mode });
        return openSync(path, flags, mode);
      },
      _offlineFsyncOverride: fsync,
      _offlineRecoveryBoundaryOverride: boundary,
    }))).rejects.toThrow("simulated crash after record");

    const recordStats = statSync(recordPath);
    const recordBytes = readFileSync(recordPath, "utf8");
    const record = JSON.parse(recordBytes) as {
      version: number;
      kind: string;
      pidFilePath: string;
      tokenFilePath: string;
      quarantinePath: string;
      fingerprint: { pid: number; processStartTime: string; entrypointDigest: string };
    };
    expect(recordStats.mode & 0o777).toBe(0o600);
    expect(recordStats.uid).toBe(process.getuid());
    expect(recordStats.nlink).toBe(1);
    expect(recordBytes.endsWith("\n")).toBe(true);
    expect(recordBytes).not.toContain("local-token");
    expect(record).toMatchObject({
      version: 1,
      kind: "lcm-offline-restart",
      pidFilePath: fixture.pidFile,
      tokenFilePath: fixture.tokenFile,
      quarantinePath: join(fixture.root, ".daemon.pid.restart-quarantine"),
      fingerprint: {
        pid: fixture.pid,
        processStartTime: "123456",
        entrypointDigest: fixture.runtimeDigest,
      },
    });
    const createdLeaves = opened.filter(({ flags }): boolean => (flags & constants.O_CREAT) !== 0);
    expect(createdLeaves.map(({ path }): string => path)).toEqual([
      join(fixture.root, ".daemon.pid.restart-quarantine"),
      recordPath,
    ]);
    for (const created of createdLeaves) {
      expect(created.mode).toBe(0o600);
      expect(created.flags & constants.O_EXCL).toBe(constants.O_EXCL);
      expect(created.flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(created.flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    }
    expect(readFileSync(join(fixture.root, ".daemon.pid.restart-quarantine"), "utf8"))
      .toBe(recordBytes);
    expect(fsync.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.killProcess).not.toHaveBeenCalled();

    const healthCalls = fixture.healthFetch.mock.calls.length;
    const guarded = await ensureDaemonProduction(genericEnsureOptions);
    expect(guarded).toMatchObject({
      connected: false,
      spawned: false,
      warning: expect.stringContaining("restart recovery is unresolved"),
    });
    expect(fixture.healthFetch).toHaveBeenCalledTimes(healthCalls);
    expect(fixture.killProcess).not.toHaveBeenCalled();

    await expect(restartDaemon(offlineRestartOptions(fixture))).resolves.toMatchObject({
      connected: true,
      restarted: true,
      stoppedPid: fixture.pid,
      pid: 5252,
    });
    expect(existsSync(recordPath)).toBe(false);
  });

  it("strictly validates every persisted recovery-record field and canonical encoding", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-record-schema-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-record-create") throw new Error("retain schema fixture");
      },
    })).catch(() => undefined);
    const recordBytes = readFileSync(recordPath, "utf8");
    const record = JSON.parse(recordBytes) as Record<string, any>;
    expect(__lifecycleTestUtils.isOfflineRecoveryRecord(record)).toBe(true);
    const mutations: Array<[string, (candidate: Record<string, any>) => void]> = [
      ["extra record key", candidate => { candidate.extra = true; }],
      ["renamed record key", candidate => { candidate.other = candidate.kind; delete candidate.kind; }],
      ["version", candidate => { candidate.version = 2; }],
      ["kind", candidate => { candidate.kind = "other"; }],
      ["PID path type", candidate => { candidate.pidFilePath = 1; }],
      ["PID path shape", candidate => { candidate.pidFilePath = "relative"; }],
      ["token path type", candidate => { candidate.tokenFilePath = 1; }],
      ["token path shape", candidate => { candidate.tokenFilePath = "relative"; }],
      ["quarantine path type", candidate => { candidate.quarantinePath = 1; }],
      ["quarantine path shape", candidate => { candidate.quarantinePath = "relative"; }],
      ["fingerprint null", candidate => { candidate.fingerprint = null; }],
      ["fingerprint extra key", candidate => { candidate.fingerprint.extra = true; }],
      ["PID type", candidate => { candidate.fingerprint.pid = "4242"; }],
      ["PID range", candidate => { candidate.fingerprint.pid = 0; }],
      ["UID type", candidate => { candidate.fingerprint.uid = "1000"; }],
      ["UID range", candidate => { candidate.fingerprint.uid = -1; }],
      ["birth type", candidate => { candidate.fingerprint.processStartTime = 1; }],
      ["birth empty", candidate => { candidate.fingerprint.processStartTime = ""; }],
      ["exec type", candidate => { candidate.fingerprint.execPath = 1; }],
      ["exec path", candidate => { candidate.fingerprint.execPath = "node"; }],
      ["executable type", candidate => { candidate.fingerprint.executable = 1; }],
      ["executable path", candidate => { candidate.fingerprint.executable = "node"; }],
      ["argv type", candidate => { candidate.fingerprint.argv = "node"; }],
      ["argv length", candidate => { candidate.fingerprint.argv = ["node"]; }],
      ["argv member", candidate => { candidate.fingerprint.argv[0] = 1; }],
      ["launch type", candidate => { candidate.fingerprint.launchPath = 1; }],
      ["launch path", candidate => { candidate.fingerprint.launchPath = "lcm.mjs"; }],
      ["entrypoint type", candidate => { candidate.fingerprint.entrypoint = 1; }],
      ["entrypoint path", candidate => { candidate.fingerprint.entrypoint = "lcm.mjs"; }],
      ["digest type", candidate => { candidate.fingerprint.entrypointDigest = 1; }],
      ["digest shape", candidate => { candidate.fingerprint.entrypointDigest = "bad"; }],
      ["directory null", candidate => { candidate.fingerprint.stateDirectory = null; }],
      ["directory extra key", candidate => { candidate.fingerprint.stateDirectory.extra = true; }],
      ["directory path type", candidate => { candidate.fingerprint.stateDirectory.path = 1; }],
      ["directory path shape", candidate => { candidate.fingerprint.stateDirectory.path = "relative"; }],
      ["directory number type", candidate => { candidate.fingerprint.stateDirectory.device = "1"; }],
      ["directory number range", candidate => { candidate.fingerprint.stateDirectory.device = -1; }],
      ["PID proof null", candidate => { candidate.fingerprint.pidFile = null; }],
      ["PID proof extra key", candidate => { candidate.fingerprint.pidFile.extra = true; }],
      ["PID proof path type", candidate => { candidate.fingerprint.pidFile.path = 1; }],
      ["PID proof path shape", candidate => { candidate.fingerprint.pidFile.path = "relative"; }],
      ["PID proof number type", candidate => { candidate.fingerprint.pidFile.device = "1"; }],
      ["PID proof number range", candidate => { candidate.fingerprint.pidFile.device = -1; }],
      ["PID proof content", candidate => { candidate.fingerprint.pidFile.content = 1; }],
      ["token proof null", candidate => { candidate.fingerprint.tokenFile = null; }],
      ["token proof content", candidate => { candidate.fingerprint.tokenFile.content = "secret"; }],
      ["listener type", candidate => { candidate.fingerprint.listenerPort = "19999"; }],
      ["listener low", candidate => { candidate.fingerprint.listenerPort = 0; }],
      ["listener high", candidate => { candidate.fingerprint.listenerPort = 65_536; }],
      ["owner", candidate => { candidate.fingerprint.ownerId = 1; }],
    ];
    for (const [label, mutate] of mutations) {
      const candidate = structuredClone(record) as Record<string, any>;
      mutate(candidate);
      expect(__lifecycleTestUtils.isOfflineRecoveryRecord(candidate), label).toBe(false);
    }
    expect(__lifecycleTestUtils.isOfflineRecoveryRecord(null)).toBe(false);
    const stringOwner = structuredClone(record) as Record<string, any>;
    stringOwner.fingerprint.ownerId = "owned-scope";
    expect(__lifecycleTestUtils.isOfflineRecoveryRecord(stringOwner)).toBe(false);
    stringOwner.fingerprint.argv.push(
      "--internal-lcm-test-daemon-owner",
      "owned-scope",
      "--internal-lcm-test-daemon-entrypoint",
      stringOwner.fingerprint.launchPath,
    );
    expect(__lifecycleTestUtils.isOfflineRecoveryRecord(stringOwner)).toBe(true);

    const readRoot = join(fixture.root, "record-read-cases");
    mkdirSync(readRoot);
    const readCase = (name: string, bytes: string, mode = 0o600): string => {
      const path = join(readRoot, name);
      writeFileSync(path, bytes, { mode });
      return path;
    };
    expect(__lifecycleTestUtils.readOfflineRecoveryRecord(
      join(readRoot, "absent"),
      process.getuid(),
    ).kind).toBe("absent");
    expect(__lifecycleTestUtils.readOfflineRecoveryRecord(
      readCase("empty", ""),
      process.getuid(),
    ).kind).toBe("invalid");
    expect(__lifecycleTestUtils.readOfflineRecoveryRecord(
      readCase("oversized", "x".repeat(65_537)),
      process.getuid(),
    ).kind).toBe("invalid");
    expect(__lifecycleTestUtils.readOfflineRecoveryRecord(
      readCase("malformed", "not-json\n"),
      process.getuid(),
    ).kind).toBe("invalid");
    expect(__lifecycleTestUtils.readOfflineRecoveryRecord(
      readCase("schema", "null\n"),
      process.getuid(),
    ).kind).toBe("invalid");
    expect(__lifecycleTestUtils.readOfflineRecoveryRecord(
      readCase("noncanonical", `${JSON.stringify(record, null, 2)}\n`),
      process.getuid(),
    ).kind).toBe("invalid");
    expect(__lifecycleTestUtils.readOfflineRecoveryRecord(
      readCase("canonical", recordBytes),
      process.getuid(),
    ).kind).toBe("valid");
    const linkedTarget = readCase("linked-target", recordBytes);
    const linkedRecord = join(readRoot, "linked-record");
    linkSync(linkedTarget, linkedRecord);
    expect(__lifecycleTestUtils.readOfflineRecoveryRecord(
      linkedRecord,
      process.getuid(),
    ).kind).toBe("invalid");
    expect(__lifecycleTestUtils.readOfflineRecoveryRecord(
      readCase("public-mode", recordBytes, 0o644),
      process.getuid(),
    ).kind).toBe("invalid");
  });

  it.each(["pid", "token"] as const)(
    "rejects actual FIFO, device, symlink, and hardlink %s reads without blocking",
    (leafKind): void => {
      const root = mkdtempSync(join(tmpdir(), `lcm-offline-special-${leafKind}-`));
      tempDirs.push(root);
      const regular = join(root, "regular");
      writeFileSync(regular, leafKind === "pid" ? "4242" : "local-token", { mode: 0o600 });
      const fifo = join(root, "fifo");
      const fifoResult = spawnSync("/usr/bin/mkfifo", [fifo], {
        encoding: "utf8",
        timeout: 1_000,
      });
      expect(fifoResult.status).toBe(0);
      const linked = join(root, "linked");
      symlinkSync(regular, linked);
      const hardlinked = join(root, "hardlinked");
      linkSync(regular, hardlinked);
      const candidates = [fifo, "/dev/null", linked, hardlinked];

      for (const path of candidates) {
        const expectedUid = statSync(path).uid;
        expect(__lifecycleTestUtils.readOfflineStateFileProof(
          path,
          expectedUid,
          {
            readContent: leafKind === "pid",
            requirePrivate: leafKind === "token",
            maxBytes: 64,
          },
        ), path).toBeNull();
      }
    },
  );

  it("treats an EPERM-style unreadable proc birth directory as ambiguous", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-birth-eperm-");
    await retainOfflineRecoveryRecord(fixture);
    fixture.killProcess.mockClear();
    chmodSync(fixture.procPidDir, 0o000);

    try {
      await expect(restartDaemon(offlineRestartOptions(fixture)))
        .rejects.toThrow("cannot prove original PID");

      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
    } finally {
      chmodSync(fixture.procPidDir, 0o700);
    }
  });

  it("re-establishes recovery-record durability on retry before signaling", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-record-fsync-retry-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineFsyncOverride: (): never => { throw new Error("fsync unavailable"); },
    }))).rejects.toThrow("could not create and durably authenticate");

    expect(existsSync(recordPath)).toBe(false);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(true);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    const order: string[] = [];
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number): void => {
      order.push(String(signal));
      fixture.killProcess(pid, signal);
    });
    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineFsyncOverride: (descriptor: number): void => {
        order.push("fsync");
        fsyncSync(descriptor);
      },
      _killOverride: kill,
    }))).resolves.toMatchObject({ connected: true, restarted: true, pid: 5252 });

    const termIndex = order.indexOf("SIGTERM");
    expect(termIndex).toBeGreaterThan(0);
    expect(order.slice(0, termIndex).every((entry: string): boolean => entry === "fsync"))
      .toBe(true);
    expect(kill).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(existsSync(recordPath)).toBe(false);
  });

  it.each([
    "parent-before",
    "quarantine-race",
    "short-write",
    "linked-descriptor",
    "file-fsync-parent-race",
    "parent-descriptor",
    "parent-fsync",
    "reopen-race",
    "open",
  ] as const)(
    "refuses recovery-record creation failure %s before signaling",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-record-create-${failure}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      let fsyncCalls = 0;
      const openRecord = (path: string, flags: number, mode?: number): number => {
        if (failure === "open" && path === recordPath) throw new Error("record open denied");
        if (failure === "parent-descriptor" && path === fixture.root) {
          return openSync(quarantinePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        }
        const descriptor = openSync(path, flags, mode);
        if (failure === "linked-descriptor" && path === recordPath) {
          linkSync(recordPath, join(fixture.root, "record-second-link"));
        }
        return descriptor;
      };
      if (failure === "quarantine-race") {
        fixture.listenerPorts.mockImplementation((): number[] => {
          if (fixture.listenerPorts.mock.calls.length === 2) {
            writeFileSync(join(fixture.root, ".daemon.pid.restart-quarantine"), "collision\n");
          }
          return [19999];
        });
      }
      const boundary = (phase: string): void => {
        if (failure === "parent-before" && phase === "before-record-create") {
          chmodSync(fixture.root, 0o777);
        }
      };
      const fsync = (descriptor: number): void => {
        fsyncCalls += 1;
        fsyncSync(descriptor);
        if (failure === "file-fsync-parent-race" && fsyncCalls === 1) {
          chmodSync(fixture.root, 0o777);
        }
        if (failure === "parent-fsync" && fsyncCalls === 2) {
          throw new Error("parent fsync denied");
        }
        if (failure === "reopen-race" && fsyncCalls === 2) {
          writeFileSync(recordPath, "{}\n");
        }
      };

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: boundary,
        _offlineRecordOpenOverride: openRecord,
        _offlineRecordWriteOverride: failure === "short-write"
          ? (): number => 0
          : undefined,
        _offlineFsyncOverride: fsync,
      }))).rejects.toThrow("could not create and durably authenticate");

      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
    },
  );

  it("rejects recovery-record creation when its parent changes after durability", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-record-parent-after-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const originalCloseSync = nodeFs.closeSync;
    let recordCreateOpened = false;
    let armedParentCloseCalls = 0;
    let parentChanged = false;
    nodeFs.closeSync = (descriptor: number): void => {
      let target: string | undefined;
      try {
        target = readlinkSync(`/proc/self/fd/${String(descriptor)}`);
      } catch {
        target = undefined;
      }
      originalCloseSync(descriptor);
      if (recordCreateOpened && target === fixture.root) {
        armedParentCloseCalls += 1;
        if (armedParentCloseCalls === 3) {
          parentChanged = true;
          chmodSync(fixture.root, 0o777);
        }
      }
    };
    syncBuiltinESMExports();

    try {
      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecordOpenOverride: (path: string, flags: number, mode?: number): number => {
          const descriptor = openSync(path, flags, mode);
          if (path === recordPath && (flags & constants.O_CREAT) !== 0) {
            recordCreateOpened = true;
          }
          return descriptor;
        },
      }))).rejects.toThrow("could not create and durably authenticate");
    } finally {
      chmodSync(fixture.root, 0o700);
      nodeFs.closeSync = originalCloseSync;
      syncBuiltinESMExports();
    }

    expect(parentChanged).toBe(true);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it.each(["recovery leaf", "recovery parent"] as const)(
    "fails closed when the %s descriptor cannot close",
    async (target: "recovery leaf" | "recovery parent"): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-${target.replace(" ", "-")}-close-`);
      const originalClose = nodeFs.closeSync;
      const tracked = new Set<number>();
      const leaked: number[] = [];
      let injected = false;
      try {
        nodeFs.closeSync = ((descriptor: number): void => {
          if (!injected && tracked.has(descriptor)) {
            injected = true;
            leaked.push(descriptor);
            throw new Error("descriptor close failed");
          }
          originalClose(descriptor);
        }) as typeof nodeFs.closeSync;
        syncBuiltinESMExports();

        await expect(restartDaemon(offlineRestartOptions(fixture, {
          _offlineRecordOpenOverride: (path: string, flags: number, mode?: number): number => {
            const descriptor = openSync(path, flags, mode);
            if (
              (target === "recovery leaf" && path.endsWith(".daemon.pid.restart-quarantine"))
              || (target === "recovery parent" && path === fixture.root)
            ) {
              tracked.add(descriptor);
            }
            return descriptor;
          },
        }))).rejects.toThrow("could not create and durably authenticate");
        expect(injected).toBe(true);
        expect(fixture.killProcess).not.toHaveBeenCalled();
        expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      } finally {
        nodeFs.closeSync = originalClose;
        syncBuiltinESMExports();
        for (const descriptor of leaked) originalClose(descriptor);
      }
    },
  );

  it("refuses signaling when the durable record revalidation descriptor cannot close", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-record-revalidation-close-");
    const recordPath = await retainOfflineRecoveryRecord(fixture);
    const originalClose = nodeFs.closeSync;
    const revalidationDescriptors = new Set<number>();
    const leakedDescriptors: number[] = [];
    let injected = false;
    try {
      nodeFs.closeSync = ((descriptor: number): void => {
        if (!injected && revalidationDescriptors.has(descriptor)) {
          injected = true;
          leakedDescriptors.push(descriptor);
          throw new Error("record revalidation close failed");
        }
        originalClose(descriptor);
      }) as typeof nodeFs.closeSync;
      syncBuiltinESMExports();

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecordOpenOverride: (path: string, flags: number, mode?: number): number => {
          const descriptor = openSync(path, flags, mode);
          if (
            path === recordPath
            && (flags & (constants.O_WRONLY | constants.O_RDWR)) === 0
          ) {
            revalidationDescriptors.add(descriptor);
          }
          return descriptor;
        },
      }))).rejects.toThrow("could not be durably revalidated");

      expect(injected).toBe(true);
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(existsSync(recordPath)).toBe(true);
    } finally {
      nodeFs.closeSync = originalClose;
      syncBuiltinESMExports();
      for (const descriptor of leakedDescriptors) originalClose(descriptor);
    }
  });

  it.each([
    ["record", "recovery record changed before backup cleanup"],
    ["backup", "quarantine is not the exact recovery backup"],
    ["unlink", "recovery backup cleanup was not durable"],
  ] as const)(
    "refuses signaling when initial recovery backup cleanup loses %s authority",
    async (failure, expectedWarning): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-initial-cleanup-${failure}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const backupPath = join(fixture.root, ".daemon.pid.restart-quarantine");

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase !== "after-record-create" || failure === "unlink") return;
          const path = failure === "record" ? recordPath : backupPath;
          const bytes = readFileSync(path, "utf8");
          writeFileSync(
            path,
            failure === "backup"
              ? bytes.replace('"listenerPort":19999', '"listenerPort":20000')
              : `${bytes} `,
          );
        },
        _offlineRecoveryBackupUnlinkOverride: failure === "unlink"
          ? (): never => { throw new Error("backup unlink denied"); }
          : undefined,
      }))).rejects.toThrow(expectedWarning);

      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it("rejects a retained valid recovery backup from a different operation", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-conflicting-valid-backup-");
    const backupPath = join(fixture.root, ".daemon.pid.restart-quarantine");
    await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-record-create") throw new Error("retain recovery pair");
      },
    })).catch(() => undefined);
    const backupBytes = readFileSync(backupPath, "utf8");
    writeFileSync(
      backupPath,
      backupBytes.replace('"listenerPort":19999', '"listenerPort":20000'),
    );
    fixture.killProcess.mockClear();
    fixture.ensureReplacement.mockClear();

    await expect(restartDaemon(offlineRestartOptions(fixture))).rejects.toThrow(
      "recovery record and quarantine roles conflict",
    );

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it.each(["malformed", "symlink", "hardlink", "mode", "quarantine"] as const)(
    "blocks generic ensure for a %s recovery-evidence leaf without inspection or mutation",
    async (kind: "malformed" | "symlink" | "hardlink" | "mode" | "quarantine"): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-restart-guard-${kind}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const targetPath = join(fixture.root, "record-target");
      writeFileSync(targetPath, "{}\n");
      chmodSync(targetPath, 0o600);
      if (kind === "quarantine") {
        writeFileSync(join(fixture.root, ".daemon.pid.restart-quarantine"), "unresolved\n");
      } else if (kind === "symlink") symlinkSync(targetPath, recordPath);
      else if (kind === "hardlink") linkSync(targetPath, recordPath);
      else {
        writeFileSync(recordPath, kind === "malformed" ? "not json\n" : "{}\n");
        chmodSync(recordPath, kind === "mode" ? 0o644 : 0o600);
      }
      const spawn = vi.fn(() => makeSpawnChild(7777)) as unknown as SpawnOverride;
      const healthCalls = fixture.healthFetch.mock.calls.length;

      await expect(ensureDaemon({
        port: 19999,
        pidFilePath: fixture.pidFile,
        spawnTimeoutMs: 100,
        _fetchOverride: fixture.healthFetch,
        _spawnOverride: spawn,
        _killOverride: fixture.killProcess,
        _listeningPortsOverride: fixture.listenerPorts,
        _isProcessAliveOverride: fixture.isAlive,
      })).resolves.toMatchObject({
        connected: false,
        spawned: false,
        warning: expect.stringContaining("restart recovery is unresolved"),
      });

      expect(fixture.healthFetch).toHaveBeenCalledTimes(healthCalls);
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
    },
  );

  it.each([
    "after-recovery-backup-create",
    "after-record-create",
    "before-recovery-backup-cleanup",
    "after-sigterm",
    "after-sigkill",
    "after-pid-quarantine",
    "after-replacement-readiness",
    "after-quarantine-cleanup",
    "before-final-backup-create",
    "after-final-backup-create",
    "before-record-cleanup",
    "after-record-cleanup",
    "before-final-backup-cleanup",
  ] as const)(
    "reconciles idempotently after a crash at %s",
    async (crashBoundary: string): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-restart-crash-${crashBoundary}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGKILL") fixture.removeProcess();
        },
      );
      let crashed = false;
      const boundary = vi.fn((phase: string): void => {
        if (!crashed && phase === crashBoundary) {
          crashed = true;
          throw new Error(`simulated crash at ${phase}`);
        }
      });

      await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: boundary,
      })).catch(() => undefined);

      expect(crashed).toBe(true);
      expect(existsSync(recordPath)).toBe(
        crashBoundary !== "after-recovery-backup-create"
        && crashBoundary !== "after-record-cleanup"
        && crashBoundary !== "before-final-backup-cleanup",
      );
      if (crashBoundary === "after-record-cleanup") {
        expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(true);
      }
      await expect(restartDaemon(offlineRestartOptions(fixture))).resolves.toMatchObject({
        connected: true,
        restarted: true,
        stoppedPid: fixture.pid,
        pid: 5252,
      });
      expect(existsSync(recordPath)).toBe(false);
      expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(false);
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
    },
  );

  it.each(["before-record-repair", "after-record-repair"] as const)(
    "reconciles a second invocation after a crash at %s",
    async (repairBoundary): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-repair-crash-${repairBoundary}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "after-recovery-backup-create") {
            throw new Error("retain sole backup before record creation");
          }
        },
      })).catch(() => undefined);
      expect(existsSync(recordPath)).toBe(false);
      expect(existsSync(quarantinePath)).toBe(true);
      fixture.killProcess.mockClear();
      fixture.ensureReplacement.mockClear();

      await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === repairBoundary) throw new Error(`crash at ${phase}`);
        },
      })).catch(() => undefined);

      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(existsSync(quarantinePath)).toBe(true);
      expect(existsSync(recordPath)).toBe(repairBoundary === "after-record-repair");
      await expect(restartDaemon(offlineRestartOptions(fixture))).resolves.toMatchObject({
        connected: true,
        restarted: true,
        pid: 5252,
      });
      expect(existsSync(recordPath)).toBe(false);
      expect(existsSync(quarantinePath)).toBe(false);
    },
  );

  it.each(["before-record-repair", "after-record-repair"] as const)(
    "stops without signal or spawn when aborted at %s",
    async (repairBoundary): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-repair-abort-${repairBoundary}-`);
      const controller = new AbortController();
      await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "after-recovery-backup-create") throw new Error("retain sole backup");
        },
      })).catch(() => undefined);
      fixture.killProcess.mockClear();
      fixture.ensureReplacement.mockClear();

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === repairBoundary) controller.abort();
        },
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("interrupted"),
      });
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(true);
    },
  );

  it("honors a preexisting abort before signaling a live daemon from durable recovery", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-resume-preaborted-stop-");
    await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-record-create") throw new Error("synthetic crash after record creation");
      },
    })).catch(() => undefined);
    fixture.killProcess.mockClear();
    fixture.ensureReplacement.mockClear();
    const controller = new AbortController();
    controller.abort();

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("interrupted during offline restart recovery"),
    });
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(true);
  });

  it.each(["success", "interrupted", "refused"] as const)(
    "reconciles a retained exact recovery backup after the original process is gone: %s",
    async (outcome): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-resume-backup-${outcome}-`);
      await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "after-record-create") {
            throw new Error("synthetic crash with exact record and backup");
          }
        },
      })).catch(() => undefined);
      fixture.removeProcess();
      fixture.killProcess.mockClear();
      fixture.ensureReplacement.mockClear();
      const controller = new AbortController();

      const restart = restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (outcome === "interrupted" && phase === "before-recovery-backup-cleanup") {
            controller.abort();
          }
        },
        _offlineRecoveryBackupUnlinkOverride: outcome === "refused"
          ? (): never => { throw new Error("synthetic retained-backup unlink refusal"); }
          : undefined,
      }));

      if (outcome === "refused") {
        await expect(restart).rejects.toThrow("recovery backup cleanup was not durable");
      } else {
        await expect(restart).resolves.toMatchObject(outcome === "success"
          ? { connected: true, restarted: true, pid: 5252 }
          : {
              connected: false,
              restarted: false,
              warning: expect.stringContaining("interrupted while reconciling recovery backup"),
            });
      }
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    },
  );

  it.each(["configuration", "durability"] as const)(
    "refuses sole-backup repair after %s proof fails",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-sole-backup-${failure}-`);
      await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "after-recovery-backup-create") {
            throw new Error("synthetic crash retaining the sole exact backup");
          }
        },
      })).catch(() => undefined);
      fixture.killProcess.mockClear();
      fixture.ensureReplacement.mockClear();

      await expect(restartDaemon(offlineRestartOptions(fixture, failure === "configuration"
        ? { expectedRuntimeDigest: "f".repeat(64) }
        : { _offlineFsyncOverride: (): never => { throw new Error("synthetic fsync failure"); } })))
        .rejects.toThrow(failure === "configuration"
          ? "recovery backup does not match current configuration"
          : "recovery backup is not durably authenticated");
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it.each(["unlink seam", "backup race", "anchored unlink"] as const)(
    "refuses invalid-record repair after %s failure",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-invalid-record-${failure.replace(" ", "-")}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "after-record-create") {
            throw new Error("synthetic crash retaining record and backup");
          }
        },
      })).catch(() => undefined);
      writeFileSync(recordPath, "invalid recovery record\n", { mode: 0o600 });
      fixture.killProcess.mockClear();
      fixture.ensureReplacement.mockClear();

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecordUnlinkOverride: failure === "unlink seam"
          ? (): never => { throw new Error("synthetic invalid-record unlink refusal"); }
          : failure === "backup race"
            ? (): void => {
                writeFileSync(quarantinePath, `${readFileSync(quarantinePath, "utf8")} `);
              }
            : undefined,
        _offlineProcSelfFdRootOverride: failure === "anchored unlink"
          ? join(fixture.root, "missing-proc-self-fd")
          : undefined,
      }))).rejects.toThrow("invalid recovery record cannot be repaired safely");
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(existsSync(quarantinePath)).toBe(true);
    },
  );

  it("preserves invalid record and exact backup when repair is interrupted after its unlink seam", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-invalid-record-repair-abort-");
    const controller = new AbortController();
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-record-create") throw new Error("retain exact recovery pair");
      },
    })).catch(() => undefined);
    writeFileSync(recordPath, "invalid recovery record\n", { mode: 0o600 });
    fixture.killProcess.mockClear();
    fixture.ensureReplacement.mockClear();
    const recordBefore = snapshotOfflineEvidenceLeaf(recordPath);
    const quarantineBefore = snapshotOfflineEvidenceLeaf(quarantinePath);
    const pidBefore = snapshotOfflineEvidenceLeaf(fixture.pidFile);
    const tokenBefore = snapshotOfflineEvidenceLeaf(fixture.tokenFile);
    let unlinkCalls = 0;

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
      _offlineRecordUnlinkOverride: (): void => {
        unlinkCalls += 1;
        controller.abort();
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("interrupted while reconciling durable offline restart evidence"),
    });

    expect(unlinkCalls).toBe(1);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(snapshotOfflineEvidenceLeaf(recordPath)).toEqual(recordBefore);
    expect(snapshotOfflineEvidenceLeaf(quarantinePath)).toEqual(quarantineBefore);
    expect(snapshotOfflineEvidenceLeaf(fixture.pidFile)).toEqual(pidBefore);
    expect(snapshotOfflineEvidenceLeaf(fixture.tokenFile)).toEqual(tokenBefore);
  });

  it("refuses record repair when its exact backup changes after the repair write", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-repair-post-write-backup-race-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-recovery-backup-create") {
          throw new Error("synthetic crash retaining the sole exact backup");
        }
      },
    })).catch(() => undefined);
    fixture.killProcess.mockClear();
    fixture.ensureReplacement.mockClear();

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-record-repair") {
          writeFileSync(quarantinePath, `${readFileSync(quarantinePath, "utf8")} `);
        }
      },
    }))).rejects.toThrow("recovery authority changed during record repair");
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses a durable recovery descriptor opened on the wrong owned leaf", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-durable-record-wrong-leaf-");
    const recordPath = await retainOfflineRecoveryRecord(fixture);
    fixture.killProcess.mockClear();
    fixture.ensureReplacement.mockClear();

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecordOpenOverride: (path: string, flags: number): number => (
        openSync(path === recordPath ? fixture.tokenFile : path, flags)
      ),
    }))).rejects.toThrow("recovery record could not be durably revalidated");
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it.each(["throw", "invalid"] as const)(
    "fails closed when exact recovery JSON reparsing returns %s",
    async (outcome): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-exact-json-${outcome}-`);
      let restoreParse = (): void => {};
      try {
        await expect(restartDaemon(offlineRestartOptions(fixture, {
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase !== "before-recovery-backup-cleanup") return;
            const parse = vi.spyOn(JSON, "parse");
            if (outcome === "throw") {
              parse.mockImplementationOnce(() => {
                throw new Error("synthetic exact recovery JSON failure");
              });
            } else {
              parse.mockReturnValueOnce({});
            }
            restoreParse = (): void => parse.mockRestore();
          },
        }))).rejects.toThrow("recovery backup cleanup was not durable");
      } finally {
        restoreParse();
      }
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it("refuses a relative launch path introduced at the final fingerprint read", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-launch-relative-hermetic-");
    let processExecutableReads = 0;

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _realpathOverride: (path: string): string => {
        if (path === join(fixture.procPidDir, "exe")) {
          processExecutableReads += 1;
          if (processExecutableReads === 1) process.argv[1] = "relative-lcm.mjs";
        }
        return realpathSync(path);
      },
    })))
      .rejects.toThrow("complete offline identity could not be verified");
    expect(fixture.listenerPorts).toHaveBeenCalledOnce();
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses when the original process dies during the initial complete fingerprint", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-initial-fingerprint-liveness-race-");
    let fingerprintLivenessReads = 0;
    const isAlive = (pid: number): boolean => {
      if (new Error().stack?.includes("captureOfflineRestartSignalProof") === true) {
        fingerprintLivenessReads += 1;
        if (fingerprintLivenessReads === 2) return false;
      }
      return fixture.isAlive(pid);
    };

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _isProcessAliveOverride: isAlive,
    }))).rejects.toThrow("complete offline identity could not be verified");

    expect(fingerprintLivenessReads).toBe(2);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses malformed canonical PID content while reconciling a gone original", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-reconcile-malformed-canonical-pid-");
    await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-record-create") throw new Error("synthetic recovery crash");
      },
    })).catch(() => undefined);
    fixture.removeProcess();
    writeFileSync(fixture.pidFile, "malformed-pid");
    fixture.killProcess.mockClear();
    fixture.ensureReplacement.mockClear();

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("unauthenticated or ambiguous replacement");
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses an unsafe decimal canonical PID while reconciling a gone original", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-reconcile-unsafe-canonical-pid-");
    await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-record-create") throw new Error("synthetic recovery crash");
      },
    })).catch(() => undefined);
    fixture.removeProcess();
    writeFileSync(fixture.pidFile, "99999999999999999999");
    fixture.killProcess.mockClear();
    fixture.ensureReplacement.mockClear();

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("unauthenticated or ambiguous replacement");
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it.each([
    "after-recovery-backup-create",
    "after-record-create",
    "before-recovery-backup-cleanup",
    "after-recovery-backup-cleanup",
    "before-sigterm-revalidation",
    "after-sigterm",
    "after-sigkill",
    "after-quarantine-cleanup",
    "before-final-backup-create",
    "after-final-backup-create",
    "before-final-backup-cleanup",
  ] as const)(
    "performs no further signal or spawn after abort at %s",
    async (abortBoundary): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-boundary-abort-${abortBoundary}-`);
      const controller = new AbortController();
      let signalCallsAtAbort: number | undefined;
      let spawnCallsAtAbort: number | undefined;

      if (abortBoundary === "after-quarantine-cleanup") {
        fixture.killProcess.mockImplementation(
          (_pid: number, signal?: NodeJS.Signals | number): void => {
            if (signal === "SIGTERM") fixture.removeProcess();
          },
        );
      } else if (abortBoundary === "after-sigkill") {
        fixture.killProcess.mockImplementation(
          (_pid: number, signal?: NodeJS.Signals | number): void => {
            if (signal === "SIGKILL") fixture.removeProcess();
          },
        );
      }

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase !== abortBoundary) return;
          signalCallsAtAbort = fixture.killProcess.mock.calls.length;
          spawnCallsAtAbort = fixture.ensureReplacement.mock.calls.length;
          controller.abort();
        },
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("interrupted"),
      });

      expect(signalCallsAtAbort).toBeDefined();
      expect(spawnCallsAtAbort).toBeDefined();
      expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtAbort!);
      expect(fixture.ensureReplacement).toHaveBeenCalledTimes(spawnCallsAtAbort!);
      expect(
        existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))
        || existsSync(join(fixture.root, ".daemon.pid.restart-quarantine")),
      ).toBe(true);
    },
  );

  it.each([
    "after-replacement-readiness",
    "before-quarantine-cleanup",
    "before-record-proof",
    "after-record-cleanup",
    "after-initial-stopped-fence",
    "before-pid-quarantine",
    "before-replacement-startup",
    "before-authorized-ensure",
  ] as const)(
    "stops at the exact offline recovery cancellation boundary %s",
    async (abortBoundary): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-exact-boundary-abort-${abortBoundary}-`,
      );
      const controller = new AbortController();
      let signalCallsAtAbort: number | undefined;
      let replacementCallsAtAbort: number | undefined;
      if (
        abortBoundary === "before-quarantine-cleanup"
        || abortBoundary === "before-pid-quarantine"
      ) {
        fixture.killProcess.mockImplementation(
          (_pid: number, signal?: NodeJS.Signals | number): void => {
            if (signal === "SIGKILL") fixture.removeProcess();
          },
        );
      }

      const result = await restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase !== abortBoundary) return;
          signalCallsAtAbort = fixture.killProcess.mock.calls.length;
          replacementCallsAtAbort = fixture.ensureReplacement.mock.calls.length;
          controller.abort();
        },
      }));

      expect(signalCallsAtAbort).toBeDefined();
      expect(replacementCallsAtAbort).toBeDefined();
      expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtAbort ?? -1);
      expect(fixture.ensureReplacement).toHaveBeenCalledTimes(replacementCallsAtAbort ?? -1);
      expect(result).toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("interrupted"),
      });
      expect(
        existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))
        || existsSync(join(fixture.root, ".daemon.pid.restart-quarantine")),
      ).toBe(true);
    },
  );

  it.each([
    ["after-finalize-candidate", "recovery finalization was interrupted"],
    ["before-quarantine-cleanup", "PID quarantine cleanup was interrupted"],
    ["after-quarantine-cleanup", "PID quarantine cleanup was interrupted"],
    ["before-final-backup-create", "recovery backup creation was interrupted"],
    ["after-final-backup-create", "recovery backup creation was interrupted"],
    ["before-record-proof", "recovery record cleanup was interrupted"],
    ["before-record-cleanup", "recovery record cleanup was interrupted"],
    ["after-record-cleanup", "recovery record cleanup was interrupted"],
    ["before-final-backup-cleanup", "final recovery cleanup was interrupted"],
  ] as const)(
    "preserves exact recovery evidence when cancellation arrives during the %s authenticated snapshot",
    async (abortPhase, expectedWarning): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-final-snapshot-abort-${abortPhase}-`,
      );
      const requiresOriginalQuarantine = abortPhase === "before-quarantine-cleanup"
        || abortPhase === "after-quarantine-cleanup";
      if (requiresOriginalQuarantine) {
        fixture.killProcess.mockImplementation(
          (_pid: number, signal?: NodeJS.Signals | number): void => {
            if (signal === "SIGKILL") fixture.removeProcess();
          },
        );
      }
      const controller = new AbortController();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      let armed = false;
      let abortDeliveries = 0;
      let signalCallsAtArm: number | undefined;
      let ensureCallsAtArm: number | undefined;
      let recordAtArm: OfflineEvidenceLeafSnapshot | null | undefined;
      let quarantineAtArm: OfflineEvidenceLeafSnapshot | null | undefined;
      let pidAtArm: OfflineEvidenceLeafSnapshot | null | undefined;
      let tokenAtArm: OfflineEvidenceLeafSnapshot | null | undefined;
      const armAbort = (): void => {
        if (armed) return;
        armed = true;
        signalCallsAtArm = fixture.killProcess.mock.calls.length;
        ensureCallsAtArm = fixture.ensureReplacement.mock.calls.length;
        recordAtArm = snapshotOfflineEvidenceLeaf(recordPath);
        quarantineAtArm = snapshotOfflineEvidenceLeaf(quarantinePath);
        pidAtArm = snapshotOfflineEvidenceLeaf(fixture.pidFile);
        tokenAtArm = snapshotOfflineEvidenceLeaf(fixture.tokenFile);
      };
      const fetch: FetchOverride = vi.fn(async (
        input: string | URL | Request,
      ): Promise<Response> => {
        const response = await fixture.healthFetch(input);
        if (armed && abortDeliveries === 0) {
          abortDeliveries += 1;
          controller.abort();
        }
        return response;
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _fetchOverride: fetch,
        _offlineRecoveryFinalizeOverride: abortPhase === "after-finalize-candidate"
          ? armAbort
          : undefined,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === abortPhase) armAbort();
        },
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining(expectedWarning),
      });

      expect(armed).toBe(true);
      expect(abortDeliveries).toBe(1);
      expect(signalCallsAtArm).toBeDefined();
      expect(ensureCallsAtArm).toBeDefined();
      expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtArm ?? -1);
      expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsAtArm ?? -1);
      expect(snapshotOfflineEvidenceLeaf(recordPath)).toEqual(recordAtArm);
      expect(snapshotOfflineEvidenceLeaf(quarantinePath)).toEqual(quarantineAtArm);
      expect(snapshotOfflineEvidenceLeaf(fixture.pidFile)).toEqual(pidAtArm);
      expect(snapshotOfflineEvidenceLeaf(fixture.tokenFile)).toEqual(tokenAtArm);
    },
  );

  it.each([
    ["PID quarantine", "PID quarantine cleanup was interrupted"],
    ["recovery record", "recovery record cleanup was interrupted"],
    ["final recovery backup", "final recovery cleanup was interrupted"],
  ] as const)(
    "preserves exact recovery evidence when cancellation arrives from the %s unlink seam",
    async (abortSeam, expectedWarning): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-final-unlink-seam-abort-${abortSeam.replaceAll(" ", "-")}-`,
      );
      if (abortSeam === "PID quarantine") {
        fixture.killProcess.mockImplementation(
          (_pid: number, signal?: NodeJS.Signals | number): void => {
            if (signal === "SIGKILL") fixture.removeProcess();
          },
        );
      }
      const controller = new AbortController();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      let backupUnlinkCalls = 0;
      let seamAbortCalls = 0;
      let signalCallsAtAbort: number | undefined;
      let ensureCallsAtAbort: number | undefined;
      let recordAtAbort: OfflineEvidenceLeafSnapshot | null | undefined;
      let quarantineAtAbort: OfflineEvidenceLeafSnapshot | null | undefined;
      let pidAtAbort: OfflineEvidenceLeafSnapshot | null | undefined;
      let tokenAtAbort: OfflineEvidenceLeafSnapshot | null | undefined;
      const abortFromSeam = (): void => {
        seamAbortCalls += 1;
        signalCallsAtAbort = fixture.killProcess.mock.calls.length;
        ensureCallsAtAbort = fixture.ensureReplacement.mock.calls.length;
        recordAtAbort = snapshotOfflineEvidenceLeaf(recordPath);
        quarantineAtAbort = snapshotOfflineEvidenceLeaf(quarantinePath);
        pidAtAbort = snapshotOfflineEvidenceLeaf(fixture.pidFile);
        tokenAtAbort = snapshotOfflineEvidenceLeaf(fixture.tokenFile);
        controller.abort();
      };
      const overrides: Partial<Parameters<typeof restartDaemonProduction>[0]> = {
        _abortSignal: controller.signal,
        _offlinePidUnlinkOverride: abortSeam === "PID quarantine"
          ? abortFromSeam
          : undefined,
        _offlineRecordUnlinkOverride: abortSeam === "recovery record"
          ? abortFromSeam
          : undefined,
        _offlineRecoveryBackupUnlinkOverride: abortSeam === "final recovery backup"
          ? (): void => {
              backupUnlinkCalls += 1;
              if (backupUnlinkCalls === 2) abortFromSeam();
            }
          : undefined,
      };

      await expect(restartDaemon(offlineRestartOptions(fixture, overrides))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining(expectedWarning),
      });

      expect(seamAbortCalls).toBe(1);
      expect(backupUnlinkCalls).toBe(abortSeam === "final recovery backup" ? 2 : 0);
      expect(signalCallsAtAbort).toBeDefined();
      expect(ensureCallsAtAbort).toBeDefined();
      expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtAbort ?? -1);
      expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsAtAbort ?? -1);
      expect(snapshotOfflineEvidenceLeaf(recordPath)).toEqual(recordAtAbort);
      expect(snapshotOfflineEvidenceLeaf(quarantinePath)).toEqual(quarantineAtAbort);
      expect(snapshotOfflineEvidenceLeaf(fixture.pidFile)).toEqual(pidAtAbort);
      expect(snapshotOfflineEvidenceLeaf(fixture.tokenFile)).toEqual(tokenAtAbort);
    },
  );

  it.each(["after-sigterm-wait", "after-sigkill-wait"] as const)(
    "performs no further signal or spawn after abort at %s",
    async (abortPoint): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-wait-abort-${abortPoint}-`);
      const controller = new AbortController();
      if (abortPoint === "after-sigkill-wait") {
        fixture.killProcess.mockImplementation((): void => {});
      }

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _sleepOverride: async (): Promise<void> => {
          const lastSignal = fixture.killProcess.mock.calls.at(-1)?.[1];
          if (
            (abortPoint === "after-sigterm-wait" && lastSignal === "SIGTERM")
            || (abortPoint === "after-sigkill-wait" && lastSignal === "SIGKILL")
          ) {
            controller.abort();
          }
        },
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("interrupted"),
      });

      expect(fixture.killProcess).toHaveBeenCalledTimes(
        abortPoint === "after-sigterm-wait" ? 1 : 2,
      );
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it.each(["unexpected leaf", "different PID"] as const)(
    "refuses %s PID state introduced after the initial stopped trust fence",
    async (replacement): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-post-stopped-fence-${replacement.replace(" ", "-")}-`,
      );
      const originalLstat = nodeFs.lstatSync;
      let unexpectedLeafObserved = false;
      let unexpectedLeafArmed = false;
      let armedPidLstats = 0;
      const lstat = replacement === "unexpected leaf"
        ? vi.spyOn(nodeFs, "lstatSync").mockImplementation((path): Stats => {
            if (String(path) === fixture.pidFile && unexpectedLeafArmed) {
              armedPidLstats += 1;
              if (armedPidLstats === 3) {
                unexpectedLeafObserved = true;
                return originalLstat(fixture.tokenFile);
              }
            }
            return originalLstat(path);
          })
        : undefined;
      if (lstat) syncBuiltinESMExports();

      try {
        await expect(restartDaemon(offlineRestartOptions(fixture, {
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "after-initial-stopped-fence") {
              if (replacement === "different PID") writeFileSync(fixture.pidFile, "9999");
              else unexpectedLeafArmed = true;
            }
          },
        }))).rejects.toThrow(replacement === "unexpected leaf"
          ? "PID state is not safely absent"
          : "PID state was concurrently replaced");
      } finally {
        lstat?.mockRestore();
        if (lstat) syncBuiltinESMExports();
      }

      expect(unexpectedLeafObserved).toBe(replacement === "unexpected leaf");
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    },
  );

  it("retains PID quarantine when cancellation arrives in its post-rename trust fence", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-post-rename-fence-abort-");
    const controller = new AbortController();
    let trustFenceStarts = 0;
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGKILL") fixture.removeProcess();
      },
    );

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase !== "before-stopped-trust-fence") return;
        trustFenceStarts += 1;
        if (trustFenceStarts === 3) controller.abort();
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("PID quarantine retained"),
    });

    expect(trustFenceStarts).toBe(3);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(true);
  });

  it("observes cancellation delivered as the original-gone proof completes", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-gone-proof-abort-");
    const controller = new AbortController();
    const originalLstat = nodeFs.lstatSync;
    let goneProofArmed = false;
    let abortDelivered = false;
    const lstat = vi.spyOn(nodeFs, "lstatSync").mockImplementation((path): Stats => {
      if (goneProofArmed && !abortDelivered && String(path) === fixture.procPidDir) {
        abortDelivered = true;
        controller.abort();
      }
      return originalLstat(path);
    });
    syncBuiltinESMExports();
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal !== "SIGTERM") return;
        fixture.removeProcess();
        goneProofArmed = true;
      },
    );

    try {
      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("interrupted during offline restart recovery"),
      });
    } finally {
      lstat.mockRestore();
      syncBuiltinESMExports();
    }

    expect(abortDelivered).toBe(true);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it.each([
    "after-original-gone-proof",
    "after-final-original-gone-proof",
    "before-stopped-fence-publication",
  ] as const)(
    "reports cancellation delivered during the stopped snapshot after %s",
    async (abortBoundary): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-stopped-snapshot-abort-${abortBoundary}-`,
      );
      const controller = new AbortController();
      let armed = false;
      let armedAbortReads = 0;
      const signal = new Proxy(controller.signal, {
        get: (target, property): unknown => {
          if (property === "aborted" && armed) {
            armedAbortReads += 1;
            if (armedAbortReads >= 2) {
              controller.abort();
              return true;
            }
            return false;
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: signal,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === abortBoundary && !armed) armed = true;
        },
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("interrupted during offline restart recovery"),
      });

      expect(armedAbortReads).toBeGreaterThanOrEqual(2);
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it.each([
    "after-final-original-gone-proof",
    "before-stopped-fence-publication",
  ] as const)(
    "refuses stopped evidence drift after %s",
    async (driftBoundary): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-stopped-snapshot-drift-${driftBoundary}-`,
      );
      let mutated = false;

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase !== driftBoundary || mutated) return;
          mutated = true;
          chmodSync(fixture.tokenFile, 0o640);
        },
      }))).rejects.toThrow("stopped daemon trust evidence changed");
      expect(mutated).toBe(true);
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it("reports cancellation delivered during trust-fence finalization recapture", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-trust-finalize-abort-");
    const controller = new AbortController();
    let armed = false;
    let armedAbortReads = 0;
    const signal = new Proxy(controller.signal, {
      get: (target, property): unknown => {
        if (property === "aborted" && armed) {
          armedAbortReads += 1;
          if (armedAbortReads >= 2) {
            controller.abort();
            return true;
          }
          return false;
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: signal,
      _offlineTrustFenceFinalizeOverride: (): void => {
        if (!armed) armed = true;
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("interrupted during offline restart recovery"),
    });
    expect(armedAbortReads).toBeGreaterThanOrEqual(2);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses a recovery record changed as the original-gone proof completes", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-gone-proof-record-race-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const originalLstat = nodeFs.lstatSync;
    let goneProofArmed = false;
    let mutated = false;
    const lstat = vi.spyOn(nodeFs, "lstatSync").mockImplementation((path): Stats => {
      if (goneProofArmed && !mutated && String(path) === fixture.procPidDir) {
        mutated = true;
        writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
      }
      return originalLstat(path);
    });
    syncBuiltinESMExports();
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal !== "SIGTERM") return;
        fixture.removeProcess();
        goneProofArmed = true;
      },
    );

    try {
      await expect(restartDaemon(offlineRestartOptions(fixture)))
        .rejects.toThrow("recovery record changed before stopped-state preparation");
    } finally {
      lstat.mockRestore();
      syncBuiltinESMExports();
    }

    expect(mutated).toBe(true);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it.each(["record", "quarantine"] as const)(
    "refuses a %s race immediately after the pre-rename trust fence",
    async (race): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-post-prerename-${race}-race-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const originalClose = nodeFs.closeSync;
      let trustFenceStarts = 0;
      let finalCaptureArmed = false;
      let recordCloses = 0;
      let raced = false;
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGKILL") fixture.removeProcess();
        },
      );
      const close = vi.spyOn(nodeFs, "closeSync").mockImplementation((descriptor): void => {
        let target: string | undefined;
        try {
          target = readlinkSync(`/proc/self/fd/${String(descriptor)}`);
        } catch {
          target = undefined;
        }
        originalClose(descriptor);
        if (!finalCaptureArmed || target !== recordPath || raced) return;
        recordCloses += 1;
        if (recordCloses !== 4) return;
        raced = true;
        if (race === "record") {
          writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
        } else {
          writeFileSync(quarantinePath, "occupied quarantine\n", { mode: 0o600 });
        }
      });
      syncBuiltinESMExports();

      try {
        await expect(restartDaemon(offlineRestartOptions(fixture, {
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-stopped-trust-fence") trustFenceStarts += 1;
            if (phase === "before-stopped-fence-publication" && trustFenceStarts === 2) {
              finalCaptureArmed = true;
            }
          },
        }))).rejects.toThrow(race === "record"
          ? "recovery record changed before PID quarantine"
          : "deterministic offline PID quarantine already exists");
      } finally {
        close.mockRestore();
        syncBuiltinESMExports();
      }

      expect(raced).toBe(true);
      expect(recordCloses).toBe(4);
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["after-sigterm", "offline restart recovery record changed after SIGTERM"],
    ["after-sigterm-wait", "offline restart recovery record changed after SIGTERM wait"],
    ["after-sigkill", "offline restart recovery record changed after SIGKILL"],
    ["after-sigkill-wait", "offline restart recovery record changed after SIGKILL wait"],
  ] as const)(
    "refuses further recovery after the record changes at %s",
    async (mutationPoint, expectedWarning): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-record-mutation-${mutationPoint}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const mutateRecord = (): void => {
        writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
      };
      if (mutationPoint.startsWith("after-sigkill")) {
        fixture.killProcess.mockImplementation((): void => {});
      }

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === mutationPoint) mutateRecord();
        },
        _sleepOverride: async (): Promise<void> => {
          const lastSignal = fixture.killProcess.mock.calls.at(-1)?.[1];
          if (
            (mutationPoint === "after-sigterm-wait" && lastSignal === "SIGTERM")
            || (mutationPoint === "after-sigkill-wait" && lastSignal === "SIGKILL")
          ) {
            mutateRecord();
          }
        },
      }))).rejects.toThrow(expectedWarning);

      expect(fixture.killProcess).toHaveBeenCalledTimes(
        mutationPoint.startsWith("after-sigkill") ? 2 : 1,
      );
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it("revalidates primary recovery authority after initial backup cleanup", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-recovery-authority-after-backup-cleanup-",
    );
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-recovery-backup-cleanup") {
          writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
        }
      },
    }))).rejects.toThrow("recovery authority changed after backup cleanup");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("revalidates recovery authority immediately before SIGKILL", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-recovery-authority-before-kill-",
    );
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const processStatPath = join(fixture.procPidDir, "stat");
    const originalRead = nodeFs.readSync;
    let mutated = false;
    fixture.killProcess.mockImplementation((): void => {});
    try {
      nodeFs.readSync = ((...args: Parameters<typeof nodeFs.readSync>): number => {
        const bytesRead = Reflect.apply(originalRead, nodeFs, args) as number;
        if (
          !mutated
          && new Error().stack?.includes("originalOfflineProcessIsGone") === true
          && readlinkSync(`/proc/self/fd/${String(args[0])}`) === processStatPath
        ) {
          mutated = true;
          writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
        }
        return bytesRead;
      }) as typeof nodeFs.readSync;
      syncBuiltinESMExports();

      await expect(restartDaemon(offlineRestartOptions(fixture)))
        .rejects.toThrow("recovery record changed before SIGKILL");
    } finally {
      nodeFs.readSync = originalRead;
      syncBuiltinESMExports();
    }

    expect(mutated).toBe(true);
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("removes quarantine before the authoritative recovery record", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-cleanup-order-");
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGKILL") fixture.removeProcess();
      },
    );
    const cleanupOrder: string[] = [];

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlinePidUnlinkOverride: (): void => {
        cleanupOrder.push("quarantine");
      },
      _offlineRecordUnlinkOverride: (): void => {
        cleanupOrder.push("record");
      },
    }))).resolves.toMatchObject({ connected: true, restarted: true, pid: 5252 });

    expect(cleanupOrder).toEqual(["quarantine", "record"]);
  });

  it("refuses anchored cleanup when proc-self-fd is unavailable", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-procfd-unavailable-");
    const missingProcFdRoot = join(fixture.root, "missing-proc-self-fd");

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineProcSelfFdRootOverride: missingProcFdRoot,
    }))).rejects.toThrow("recovery backup cleanup was not durable");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(true);
  });

  it("unlinks the held recovery inode with link count one-to-zero", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-held-leaf-nlink-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let heldDescriptor: number | undefined;
    let heldInode: number | undefined;
    try {
      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase !== "after-recovery-backup-create" || heldDescriptor !== undefined) return;
          heldDescriptor = openSync(
            quarantinePath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          const before = fstatSync(heldDescriptor);
          heldInode = before.ino;
          expect(before.nlink).toBe(1);
        },
      }))).resolves.toMatchObject({ connected: true, restarted: true, pid: 5252 });

      expect(heldDescriptor).toBeDefined();
      const after = fstatSync(heldDescriptor!);
      expect(after.ino).toBe(heldInode);
      expect(after.nlink).toBe(0);
      expect(existsSync(quarantinePath)).toBe(false);
    } finally {
      if (heldDescriptor !== undefined) closeSync(heldDescriptor);
    }
  });

  it("refuses a substituted quarantine inode before anchored unlink", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-anchored-substitution-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let substitutedInode: number | undefined;
    const boundary = vi.fn((phase: string): void => {
      if (phase !== "before-recovery-backup-cleanup") return;
      const replacement = join(fixture.root, "replacement-quarantine");
      writeFileSync(replacement, readFileSync(quarantinePath), { mode: 0o600 });
      substitutedInode = statSync(replacement).ino;
      renameSync(replacement, quarantinePath);
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: boundary,
    }))).rejects.toThrow("recovery backup cleanup was not durable");

    expect(boundary).toHaveBeenCalledWith("before-recovery-backup-cleanup");
    expect(statSync(quarantinePath).ino).toBe(substitutedInode);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses a canonical parent substitution before anchored unlink", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-anchored-parent-race-");
    const movedRoot = `${fixture.root}-held-parent`;
    tempDirs.push(movedRoot);
    const boundary = vi.fn((phase: string): void => {
      if (phase !== "before-recovery-backup-cleanup") return;
      renameSync(fixture.root, movedRoot);
      mkdirSync(fixture.root);
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: boundary,
    }))).rejects.toThrow("recovery backup cleanup was not durable");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(join(movedRoot, ".daemon.pid.restart-recovery.json"))).toBe(true);
    expect(existsSync(join(movedRoot, ".daemon.pid.restart-quarantine"))).toBe(true);
  });

  it.each(["restored", "indeterminate"] as const)(
    "publishes only an exact final recovery authority after final-Q fsync uncertainty: %s",
    async (outcome): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-final-q-fsync-${outcome}-`);
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      let finalCleanupArmed = false;
      let finalFsyncFailures = 0;
      const boundary = (phase: string): void => {
        if (phase === "before-final-backup-cleanup") finalCleanupArmed = true;
      };
      const fsync = (descriptor: number): void => {
        if (finalCleanupArmed && (outcome === "indeterminate" || finalFsyncFailures === 0)) {
          finalFsyncFailures += 1;
          throw new Error("final Q parent fsync unavailable");
        }
        fsyncSync(descriptor);
      };

      const result = await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: boundary,
        _offlineFsyncOverride: fsync,
      }));

      expect(finalFsyncFailures).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(false);
      if (outcome === "restored") {
        expect(result).toMatchObject({ connected: true, restarted: true, pid: 5252 });
        expect(result.warning).toContain("final cleanup durability");
        expect(result.warning).toContain("exact authenticated quarantine recovery backup");
        expect(existsSync(quarantinePath)).toBe(true);
        await expect(ensureDaemon(offlineRestartOptions(fixture)))
          .resolves.toMatchObject({
            connected: false,
            spawned: false,
            warning: expect.stringContaining("restart recovery is unresolved"),
          });
      } else {
        expect(result).toMatchObject({ connected: false, restarted: false, pid: 5252 });
        expect(result.warning).toContain("authority or durability is indeterminate");
        expect(result.warning).not.toContain("exact durable recovery authority remains");
      }
    },
  );

  it("does not run a replacement gate after exact final-Q unlink parent drift", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-q-parent-drift-");
    const movedRoot = `${fixture.root}-post-unlink-parent`;
    tempDirs.push(movedRoot);
    let finalCleanupArmed = false;
    let healthCallsAtDrift: number | undefined;
    const result = await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-final-backup-cleanup") finalCleanupArmed = true;
      },
      _offlineFsyncOverride: (descriptor: number): void => {
        fsyncSync(descriptor);
        if (!finalCleanupArmed) return;
        finalCleanupArmed = false;
        healthCallsAtDrift = fixture.healthFetch.mock.calls.length;
        renameSync(fixture.root, movedRoot);
        mkdirSync(fixture.root);
      },
    }));

    expect(result).toMatchObject({ connected: false, restarted: false, pid: 5252 });
    expect(result.warning).toContain("authority or durability is indeterminate");
    expect(healthCallsAtDrift).toBeDefined();
    expect(fixture.healthFetch).toHaveBeenCalledTimes(healthCallsAtDrift!);
  });

  it.each(["quarantine", "record"] as const)(
    "retries explicit reconciliation after %s cleanup fails",
    async (failedCleanup: "quarantine" | "record"): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-restart-retry-${failedCleanup}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGKILL") fixture.removeProcess();
        },
      );
      const first = await restartDaemon(offlineRestartOptions(fixture, failedCleanup === "quarantine"
        ? { _offlinePidUnlinkOverride: (): never => { throw new Error("quarantine denied"); } }
        : { _offlineRecordUnlinkOverride: (): never => { throw new Error("record denied"); } }));

      expect(first).toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("durable recovery authority remains"),
      });
      expect(existsSync(recordPath)).toBe(true);
      expect(existsSync(quarantinePath)).toBe(true);

      await expect(restartDaemon(offlineRestartOptions(fixture))).resolves.toMatchObject({
        connected: true,
        restarted: true,
        pid: 5252,
      });
      expect(existsSync(recordPath)).toBe(false);
      expect(existsSync(quarantinePath)).toBe(false);
    },
  );

  it("retries from the sole exact backup after final backup cleanup fails", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-final-backup-retry-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGKILL") fixture.removeProcess();
      },
    );
    let backupCleanupCalls = 0;

    const first = await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBackupUnlinkOverride: (): void => {
        backupCleanupCalls += 1;
        if (backupCleanupCalls === 2) throw new Error("final backup unlink denied");
      },
    }));

    expect(first).toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining(`durable recovery authority remains at ${quarantinePath}`),
    });
    expect(backupCleanupCalls).toBe(2);
    expect(existsSync(recordPath)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(true);

    await expect(restartDaemon(offlineRestartOptions(fixture))).resolves.toMatchObject({
      connected: true,
      restarted: true,
      pid: 5252,
    });
    expect(existsSync(recordPath)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(false);
  });

  it.each(["short-write", "descriptor", "open"] as const)(
    "retains the exact quarantine backup when record repair fails at %s",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-record-restore-${failure}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const backupPath = join(fixture.root, ".daemon.pid.restart-quarantine");
      await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "after-record-cleanup") throw new Error("retain backup authority");
        },
      })).catch(() => undefined);
      const backupBytes = readFileSync(backupPath, "utf8");
      expect(existsSync(recordPath)).toBe(false);
      fixture.killProcess.mockClear();
      fixture.ensureReplacement.mockClear();
      const secondLink = join(fixture.root, "restored-record-second-link");
      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecordOpenOverride: (path: string, flags: number, mode?: number): number => {
          if (path === recordPath && (flags & constants.O_CREAT) !== 0) {
            if (failure === "open") throw new Error("repair open denied");
            const descriptor = openSync(path, flags, mode);
            if (failure === "descriptor") linkSync(path, secondLink);
            return descriptor;
          }
          return openSync(path, flags, mode);
        },
        _offlineRecordWriteOverride: (descriptor: number, bytes: Uint8Array): number => {
          if (failure === "short-write") return 0;
          return writeSync(descriptor, bytes);
        },
      }))).rejects.toThrow("recovery record repair failed");

      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(readFileSync(backupPath, "utf8")).toBe(backupBytes);
    },
  );

  it("refuses a retained record changed immediately before resumed SIGTERM proof", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-resume-record-race-");
    const recordPath = await retainOfflineRecoveryRecord(fixture);
    const boundary = vi.fn((phase: string): void => {
      if (phase === "before-sigterm-revalidation") {
        writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
      }
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: boundary,
    }))).rejects.toThrow("recovery record changed before SIGTERM");

    expect(boundary).toHaveBeenCalledWith("before-sigterm-revalidation");
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses malformed quarantine evidence beside a valid retained record", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-resume-bad-quarantine-");
    const recordPath = await retainOfflineRecoveryRecord(fixture);
    symlinkSync(fixture.pidFile, join(fixture.root, ".daemon.pid.restart-quarantine"));

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("recovery record and quarantine roles conflict");

    expect(existsSync(recordPath)).toBe(true);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses an exact orphan original-PID quarantine without record authority", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-orphan-original-quarantine-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGTERM") fixture.removeProcess();
      },
    );
    await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-pid-quarantine") throw new Error("retain original quarantine");
      },
    })).catch(() => undefined);
    expect(readFileSync(quarantinePath, "utf8")).toBe(String(fixture.pid));
    rmSync(recordPath, { force: true });
    fixture.killProcess.mockClear();
    fixture.ensureReplacement.mockClear();

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("recovery evidence is missing or malformed");

    expect(readFileSync(quarantinePath, "utf8")).toBe(String(fixture.pid));
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses ambiguous live-original evidence beside a valid quarantine", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-resume-live-quarantine-");
    const recordPath = await retainOfflineRecoveryRecord(fixture);
    renameSync(fixture.pidFile, join(fixture.root, ".daemon.pid.restart-quarantine"));

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("recovery evidence is ambiguous while original PID");

    expect(existsSync(recordPath)).toBe(true);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("reports interruption while resumed recovery is revalidating SIGTERM", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-resume-stop-abort-");
    await retainOfflineRecoveryRecord(fixture);
    const controller = new AbortController();
    fixture.listenerPorts.mockImplementation((): number[] => {
      controller.abort();
      return [19999];
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("interrupted during offline restart recovery"),
    });

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it.each(["interrupted", "refused"] as const)(
    "handles a resumed stopped-state preparation that is %s",
    async (outcome): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-resume-prepare-${outcome}-`);
      await retainOfflineRecoveryRecord(fixture);
      fixture.removeProcess();
      unlinkSync(fixture.pidFile);
      const controller = new AbortController();
      const finalFence = vi.fn((): void => {
        if (outcome === "interrupted") controller.abort();
        else fixture.setLoopbackListener(true);
      });

      const operation = restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineTrustFenceFinalizeOverride: finalFence,
      }));
      if (outcome === "interrupted") {
        await expect(operation).resolves.toMatchObject({
          connected: false,
          restarted: false,
          warning: expect.stringContaining("interrupted during offline restart recovery"),
        });
      } else {
        await expect(operation).rejects.toThrow("stopped daemon trust evidence changed");
      }
      expect(finalFence).toHaveBeenCalledOnce();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it("refuses an unauthenticated candidate replacement during explicit reconciliation", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-resume-foreign-replacement-");
    await retainOfflineRecoveryRecord(fixture);
    fixture.removeProcess();
    writeFileSync(fixture.pidFile, "9999");

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("unauthenticated or ambiguous replacement");

    expect(readFileSync(fixture.pidFile, "utf8")).toBe("9999");
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it.each([
    "canonical-present",
    "abort-first-gone",
    "launch-unreadable",
    "launch-missing",
    "abort-final-gone",
    "listener-unavailable",
    "abort-publication",
    "untrusted-quarantine",
    "pre-absence-throw",
  ] as const)(
    "fails closed at stopped-state trust boundary %s",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-stopped-fence-${failure}-`);
      const controller = new AbortController();
      let stoppedFenceEntries = 0;
      const boundary = vi.fn((phase: string): void => {
        if (phase === "before-stopped-trust-fence") {
          stoppedFenceEntries += 1;
          if (failure === "canonical-present" && stoppedFenceEntries === 2) {
            writeFileSync(fixture.pidFile, "9999");
          }
        }
        if (phase === "after-original-gone-proof") {
          if (failure === "abort-first-gone") controller.abort();
          if (failure === "launch-unreadable") unlinkSync(fixture.entrypoint);
          if (failure === "launch-missing") process.argv[1] = undefined as never;
        }
        if (failure === "abort-final-gone" && phase === "after-final-original-gone-proof") {
          controller.abort();
        }
        if (failure === "abort-publication" && phase === "before-stopped-fence-publication") {
          controller.abort();
        }
        if (failure === "untrusted-quarantine" && phase === "after-initial-stopped-fence") {
          symlinkSync(fixture.tokenFile, join(fixture.root, ".daemon.pid.restart-quarantine"));
        }
      });
      const preAbsent = failure === "pre-absence-throw"
        ? (): never => { throw new Error("pre-absence race"); }
        : undefined;
      const finalListener = failure === "listener-unavailable"
        ? (): void => { rmSync(join(fixture.procRoot, "net", "tcp6")); }
        : undefined;

      const operation = restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineRecoveryBoundaryOverride: boundary,
        _offlinePreAbsentFenceOverride: preAbsent,
        _offlineTrustFenceFinalizeOverride: finalListener,
      }));
      if (failure.startsWith("abort")) {
        await expect(operation).resolves.toMatchObject({
          connected: false,
          restarted: false,
          warning: expect.stringContaining("interrupted"),
        });
      } else {
        await expect(operation).rejects.toThrow("Offline restart recovery refused");
      }

      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
    },
  );

  it.each(["ambiguous", "interrupted", "refused"] as const)(
    "reconciles a retained quarantine with an %s second stopped fence",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-retained-q-${failure}-`);
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGKILL") fixture.removeProcess();
        },
      );
      await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "after-pid-quarantine") throw new Error("retain quarantine");
        },
      })).catch(() => undefined);
      const controller = new AbortController();
      let stoppedFenceEntries = 0;
      const boundary = vi.fn((phase: string): void => {
        if (phase === "after-initial-stopped-fence" && failure === "ambiguous") {
          writeFileSync(fixture.pidFile, "9999");
        }
        if (phase === "before-stopped-trust-fence") {
          stoppedFenceEntries += 1;
          if (failure === "interrupted" && stoppedFenceEntries === 2) controller.abort();
          if (failure === "refused" && stoppedFenceEntries === 2) {
            writeFileSync(fixture.pidFile, "9999");
          }
        }
      });

      const operation = restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineRecoveryBoundaryOverride: boundary,
      }));
      if (failure === "interrupted") {
        await expect(operation).resolves.toMatchObject({
          connected: false,
          restarted: false,
          warning: expect.stringContaining("PID quarantine retained"),
        });
      } else if (failure === "ambiguous") {
        await expect(operation).rejects.toThrow("recovery evidence is ambiguous");
      } else {
        await expect(operation).rejects.toThrow("stopped daemon trust evidence is incomplete");
      }
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it.each(["record", "quarantine"] as const)(
    "refuses a %s race immediately before deterministic PID quarantine",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-pre-q-${failure}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGKILL") fixture.removeProcess();
        },
      );
      const boundary = vi.fn((phase: string): void => {
        if (phase !== "before-pid-quarantine") return;
        if (failure === "record") {
          writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
        } else {
          writeFileSync(join(fixture.root, ".daemon.pid.restart-quarantine"), "collision\n");
        }
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: boundary,
      }))).rejects.toThrow("stopped daemon trust evidence is incomplete");

      expect(boundary).toHaveBeenCalledWith("before-pid-quarantine");
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it("authorizes exactly one internal ensure after durable offline recovery", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-authorized-ensure-");
    const spawn = vi.fn(() => {
      void fixture.ensureReplacement();
      return makeSpawnChild(5252);
    }) as unknown as SpawnOverride;
    const boundary = vi.fn();

    const result = await restartDaemon(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnOverride: spawn,
      _spawnSyncOverride: vi.fn(() => ({ status: 1, stdout: "", stderr: "no systemd" })) as unknown as SpawnSyncOverride,
      _offlineRecoveryBoundaryOverride: boundary,
    }));
    expect(result.warning).toBeUndefined();
    expect(result).toMatchObject({
      connected: true,
      restarted: true,
      stoppedPid: fixture.pid,
      pid: 5252,
    });

    expect(boundary).toHaveBeenCalledWith("before-authorized-ensure");
    expect(spawn).toHaveBeenCalledOnce();
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(false);
  });

  it.each(["record", "pid", "token", "proc"] as const)(
    "preserves authorized recovery evidence after a %s mutation during parent inspection",
    async (mutation): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-authorized-parent-${mutation}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGTERM") fixture.removeProcess();
        },
      );
      const spawn = vi.fn(() => {
        void fixture.ensureReplacement();
        return makeSpawnChild(5252);
      }) as unknown as SpawnOverride;
      const runSystemd = vi.fn((): ReturnType<typeof spawnSync> => {
        void fixture.ensureReplacement();
        return { status: 0, signal: null, stdout: "", stderr: "", pid: 1, output: [] };
      }) as unknown as SpawnSyncOverride;
      let mutated = false;
      const boundary: RecoveryBoundaryOverride = (phase: string): void => {
        if (phase !== "during-authorized-parent-inspection" || mutated) return;
        mutated = true;
        if (mutation === "record") {
          writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
        } else if (mutation === "pid") {
          writeFileSync(fixture.pidFile, "9999");
        } else if (mutation === "token") {
          writeFileSync(fixture.tokenFile, "parent-race-token");
        } else {
          writeFileSync(
            join(fixture.procRoot, "5252", "cmdline"),
            `${process.execPath}\0${fixture.entrypoint}\0unrelated\0process\0`,
          );
        }
      };

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _ensureDaemonOverride: undefined,
        _spawnOverride: spawn,
        _spawnSyncOverride: runSystemd,
        _offlineRecoveryBoundaryOverride: boundary,
        enforceUserManagerParent: true,
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("replacement readiness failed"),
      });

      expect(mutated).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
      expect(runSystemd).toHaveBeenCalledOnce();
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
      expect(existsSync(recordPath)).toBe(true);
      expect(readFileSync(quarantinePath, "utf8")).toBe(String(fixture.pid));
      expect(readFileSync(fixture.pidFile, "utf8")).toBe(mutation === "pid" ? "9999" : "5252");
      expect(existsSync(fixture.tokenFile)).toBe(true);
    },
  );

  it.each(["pid", "listener"] as const)(
    "refuses authorized %s drift at the immediately-pre-publication boundary",
    async (drift): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-authorized-publish-${drift}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGTERM") fixture.removeProcess();
        },
      );
      const spawn = vi.fn(() => {
        void fixture.ensureReplacement();
        return makeSpawnChild(5252);
      }) as unknown as SpawnOverride;
      const runSystemd = vi.fn((): ReturnType<typeof spawnSync> => {
        void fixture.ensureReplacement();
        return { status: 0, signal: null, stdout: "", stderr: "", pid: 1, output: [] };
      }) as unknown as SpawnSyncOverride;
      let drifted = false;
      const boundary: RecoveryBoundaryOverride = (phase: string): void => {
        if (phase !== "before-authorized-connected-publication" || drifted) return;
        drifted = true;
        if (drift === "pid") writeFileSync(fixture.pidFile, "9999");
        else fixture.listenerPorts.mockReturnValue([]);
      };

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _ensureDaemonOverride: undefined,
        _spawnOverride: spawn,
        _spawnSyncOverride: runSystemd,
        _offlineRecoveryBoundaryOverride: boundary,
        enforceUserManagerParent: true,
      }))).resolves.toMatchObject({ connected: false, restarted: false });

      expect(drifted).toBe(true);
      expect(runSystemd).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
      expect(existsSync(recordPath)).toBe(true);
      expect(readFileSync(quarantinePath, "utf8")).toBe(String(fixture.pid));
      expect(readFileSync(fixture.pidFile, "utf8")).toBe(drift === "pid" ? "9999" : "5252");
    },
  );

  it.each(["dead", "reused", "unreadable", "non-lcm"] as const)(
    "preserves PID and recovery authority when the authorized candidate becomes %s after authentication awaits",
    async (candidateState): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-authorized-candidate-${candidateState}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const candidateProcDir = join(fixture.procRoot, "5252");
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGTERM") fixture.removeProcess();
        },
      );
      let candidateDead = false;
      let mutated = false;
      const spawn = vi.fn(() => {
        void fixture.ensureReplacement();
        return makeSpawnChild(5252);
      }) as unknown as SpawnOverride;
      const fetch = vi.fn(async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const response = await fixture.healthFetch(input);
        if (
          !mutated
          && init?.headers !== undefined
          && !String(input).endsWith("/stats/pool")
        ) {
          mutated = true;
          if (candidateState === "dead") candidateDead = true;
          if (candidateState === "reused") {
            fixture.writeProcess({ pid: 5252, startTime: "777777" });
          }
          if (candidateState === "unreadable") chmodSync(candidateProcDir, 0o000);
          if (candidateState === "non-lcm") {
            fixture.writeProcess({
              pid: 5252,
              startTime: "654321",
              argv: [process.execPath, fixture.entrypoint, "unrelated", "process"],
            });
          }
        }
        return response;
      });

      try {
        await expect(restartDaemon(offlineRestartOptions(fixture, {
          _ensureDaemonOverride: undefined,
          _spawnOverride: spawn,
          _fetchOverride: fetch,
          _isProcessAliveOverride: (pid: number): boolean => (
            pid === 5252 && candidateDead ? false : fixture.isAlive(pid)
          ),
        }))).resolves.toMatchObject({ connected: false, restarted: false });

        expect(mutated).toBe(true);
        expect(fetch.mock.calls.some((call): boolean => call[1]?.headers !== undefined)).toBe(true);
        expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
        expect(spawn).toHaveBeenCalledOnce();
        expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
        expect(existsSync(recordPath)).toBe(true);
        expect(readFileSync(quarantinePath, "utf8")).toBe(String(fixture.pid));
      } finally {
        if (candidateState === "unreadable" && existsSync(candidateProcDir)) {
          chmodSync(candidateProcDir, 0o700);
        }
      }
    },
  );

  it("starts an authorized replacement through successful user systemd", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-authorized-systemd-success-");
    const credentialDir = join(fixture.root, ".hermetic-credentials");
    const detachedSpawn = vi.fn(() => makeSpawnChild(5252)) as unknown as SpawnOverride;
    const stopUnit = vi.fn(async (): Promise<void> => undefined);
    let credentialSourcePath = "";
    const runSystemd = vi.fn((_command: string, args: readonly string[]): ReturnType<typeof spawnSync> => {
      const credentialArg = args.find((argument: string): boolean => (
        argument.startsWith("--property=LoadCredential=OPENAI_API_KEY:")
      ));
      credentialSourcePath = credentialArg?.split(":", 2)[1] ?? "";
      void fixture.ensureReplacement();
      return { status: 0, signal: null, stdout: "", stderr: "", pid: 1, output: [] };
    }) as unknown as SpawnSyncOverride;
    const boundaries: string[] = [];
    const boundary: RecoveryBoundaryOverride = (phase: string): void => {
      boundaries.push(phase);
    };

    const options = withHermeticLifecycleSeams(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnOverride: detachedSpawn,
      _spawnSyncOverride: runSystemd,
      _offlineRecoveryBoundaryOverride: boundary,
      enforceUserManagerParent: true,
    }), {
      environment: { OPENAI_API_KEY: "authorized-systemd-success-secret" },
      stopUnit,
    }) as RestartDaemonOptions;

    await expect(restartDaemonProduction(options)).resolves.toMatchObject({
      connected: true,
      restarted: true,
      startMethod: "systemd-user",
      pid: 5252,
    });

    expect(boundaries).toContain("after-systemd-credential-preparation");
    expect(boundaries).toContain("during-authorized-parent-inspection");
    expect(boundaries).toContain("before-authorized-connected-publication");
    expect(boundaries).toContain("before-authorized-credential-source-disposal");
    expect(boundaries).toContain("after-authorized-cleanup-before-final-publication");
    expect(runSystemd).toHaveBeenCalledOnce();
    expect(detachedSpawn).not.toHaveBeenCalled();
    expect(stopUnit).not.toHaveBeenCalled();
    expect(credentialSourcePath).not.toBe("");
    expect(existsSync(credentialSourcePath)).toBe(false);
    expect(existsSync(dirname(credentialSourcePath))).toBe(false);
    expect(readdirSync(credentialDir)).toEqual([]);
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
    expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
  });

  it("cleans only run-owned credentials when authorization drifts after credential preparation", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-authorized-systemd-drift-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const credentialDir = join(fixture.root, ".hermetic-credentials");
    const launchAlias = join(fixture.root, "authorized-launch-alias");
    symlinkSync(fixture.entrypoint, launchAlias);
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGTERM") fixture.removeProcess();
      },
    );
    const detachedSpawn = vi.fn(() => makeSpawnChild(5252)) as unknown as SpawnOverride;
    const runSystemd = vi.fn(() => ({
      status: 0,
      stdout: "",
      stderr: "",
    })) as unknown as SpawnSyncOverride;
    let credentialWasPrepared = false;
    let credentialSourceDir = "";
    let credentialSourcePath = "";
    let recordBefore = "";
    let quarantineBefore = "";
    const boundary: RecoveryBoundaryOverride = (phase: string): void => {
      if (phase !== "after-systemd-credential-preparation") return;
      const sources = readdirSync(credentialDir);
      credentialWasPrepared = sources.length === 1;
      credentialSourceDir = join(credentialDir, sources[0]!);
      credentialSourcePath = join(credentialSourceDir, "OPENAI_API_KEY");
      expect(existsSync(credentialSourcePath)).toBe(true);
      recordBefore = readFileSync(recordPath, "utf8");
      quarantineBefore = readFileSync(quarantinePath, "utf8");
      process.argv[1] = launchAlias;
    };
    const options = withHermeticLifecycleSeams(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnOverride: detachedSpawn,
      _spawnSyncOverride: runSystemd,
      _offlineRecoveryBoundaryOverride: boundary,
      enforceUserManagerParent: true,
    }), {
      environment: { OPENAI_API_KEY: "run-owned-systemd-secret" },
    }) as RestartDaemonOptions;

    await expect(restartDaemonProduction(options)).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("authorization changed before systemd startup"),
    });

    expect(credentialWasPrepared).toBe(true);
    expect(existsSync(credentialSourcePath)).toBe(false);
    expect(existsSync(credentialSourceDir)).toBe(false);
    expect(readdirSync(credentialDir)).toEqual([]);
    expect(runSystemd).not.toHaveBeenCalled();
    expect(detachedSpawn).not.toHaveBeenCalled();
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(existsSync(fixture.pidFile)).toBe(false);
    expect(readFileSync(recordPath, "utf8")).toBe(recordBefore);
    expect(readFileSync(quarantinePath, "utf8")).toBe(quarantineBefore);
    expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
  });

  it.each(["nonzero", "ambiguous"] as const)(
    "disposes authorized credential sources and refuses %s systemd without fallback",
    async (outcome): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-authorized-systemd-${outcome}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const credentialDir = join(fixture.root, ".hermetic-credentials");
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGTERM") fixture.removeProcess();
        },
      );
      const detachedSpawn = vi.fn(() => makeSpawnChild(5252)) as unknown as SpawnOverride;
      const stopUnit = vi.fn(async (): Promise<void> => undefined);
      let credentialSourcePath = "";
      const runSystemd = vi.fn((
        _command: string,
        args: readonly string[],
      ): ReturnType<typeof spawnSync> => {
        const credentialArg = args.find((argument: string): boolean => (
          argument.startsWith("--property=LoadCredential=OPENAI_API_KEY:")
        ));
        credentialSourcePath = credentialArg?.split(":", 2)[1] ?? "";
        if (outcome === "ambiguous") throw new Error("ambiguous systemd launch");
        return { status: 1, signal: null, stdout: "", stderr: "failed", pid: 1, output: [] };
      }) as unknown as SpawnSyncOverride;
      const boundaries: string[] = [];
      const boundary: RecoveryBoundaryOverride = (phase: string): void => {
        boundaries.push(phase);
      };
      const options = withHermeticLifecycleSeams(offlineRestartOptions(fixture, {
        _ensureDaemonOverride: undefined,
        _spawnOverride: detachedSpawn,
        _spawnSyncOverride: runSystemd,
        _offlineRecoveryBoundaryOverride: boundary,
        enforceUserManagerParent: true,
      }), {
        environment: { OPENAI_API_KEY: `authorized-systemd-${outcome}-secret` },
        stopUnit,
      }) as RestartDaemonOptions;

      await expect(restartDaemonProduction(options)).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("authorized recovery preserved without fallback"),
      });

      expect(runSystemd).toHaveBeenCalledOnce();
      expect(detachedSpawn).not.toHaveBeenCalled();
      expect(stopUnit).not.toHaveBeenCalled();
      expect(credentialSourcePath).not.toBe("");
      expect(existsSync(credentialSourcePath)).toBe(false);
      expect(existsSync(dirname(credentialSourcePath))).toBe(false);
      expect(readdirSync(credentialDir)).toEqual([]);
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
      expect(existsSync(fixture.pidFile)).toBe(false);
      expect(existsSync(recordPath)).toBe(true);
      expect(readFileSync(quarantinePath, "utf8")).toBe(String(fixture.pid));
      expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
      expect(boundaries).not.toContain("after-replacement-readiness");
    },
  );

  it("returns a bounded refusal when failed systemd credential disposal also fails", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-authorized-systemd-cleanup-failure-",
    );
    const credentialDir = join(fixture.root, ".hermetic-credentials");
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGTERM") fixture.removeProcess();
      },
    );
    const detachedSpawn = vi.fn(() => makeSpawnChild(5252)) as unknown as SpawnOverride;
    const runSystemd = vi.fn((): ReturnType<typeof spawnSync> => ({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "failed",
      pid: 1,
      output: [],
    })) as unknown as SpawnSyncOverride;
    let blockedCleanup = false;
    const options = withHermeticLifecycleSeams(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnOverride: detachedSpawn,
      _spawnSyncOverride: runSystemd,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase !== "before-authorized-credential-source-disposal" || blockedCleanup) return;
        blockedCleanup = true;
        chmodSync(credentialDir, 0o500);
      },
      enforceUserManagerParent: true,
    }), {
      environment: { OPENAI_API_KEY: "authorized-failed-systemd-cleanup-secret" },
    }) as RestartDaemonOptions;

    try {
      await expect(restartDaemonProduction(options)).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("credential-source cleanup failed"),
      });
    } finally {
      chmodSync(credentialDir, 0o700);
    }

    expect(blockedCleanup).toBe(true);
    expect(runSystemd).toHaveBeenCalledOnce();
    expect(detachedSpawn).not.toHaveBeenCalled();
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
  });

  it("refuses readiness when authorized credential-source disposal fails", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-authorized-credential-cleanup-failure-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const credentialDir = join(fixture.root, ".hermetic-credentials");
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGTERM") fixture.removeProcess();
      },
    );
    const detachedSpawn = vi.fn(() => makeSpawnChild(5252)) as unknown as SpawnOverride;
    let credentialSourcePath = "";
    const runSystemd = vi.fn((
      _command: string,
      args: readonly string[],
    ): ReturnType<typeof spawnSync> => {
      const credentialArg = args.find((argument: string): boolean => (
        argument.startsWith("--property=LoadCredential=OPENAI_API_KEY:")
      ));
      credentialSourcePath = credentialArg?.split(":", 2)[1] ?? "";
      void fixture.ensureReplacement();
      return { status: 0, signal: null, stdout: "", stderr: "", pid: 1, output: [] };
    }) as unknown as SpawnSyncOverride;
    const boundaries: string[] = [];
    let blockedCleanup = false;
    const boundary: RecoveryBoundaryOverride = (phase: string): void => {
      boundaries.push(phase);
      if (phase !== "before-authorized-credential-source-disposal" || blockedCleanup) return;
      blockedCleanup = true;
      chmodSync(credentialDir, 0o500);
    };
    const options = withHermeticLifecycleSeams(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnOverride: detachedSpawn,
      _spawnSyncOverride: runSystemd,
      _offlineRecoveryBoundaryOverride: boundary,
      enforceUserManagerParent: true,
    }), {
      environment: { OPENAI_API_KEY: "authorized-cleanup-failure-secret" },
    }) as RestartDaemonOptions;

    try {
      await expect(restartDaemonProduction(options)).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("credential-source cleanup failed"),
      });

      expect(blockedCleanup).toBe(true);
      expect(credentialSourcePath).not.toBe("");
      expect(existsSync(dirname(credentialSourcePath))).toBe(true);
      const credentialSourcePresent = existsSync(credentialSourcePath);
      expect(readdirSync(dirname(credentialSourcePath))).toEqual(
        credentialSourcePresent ? [basename(credentialSourcePath)] : [],
      );
      expect(runSystemd).toHaveBeenCalledOnce();
      expect(detachedSpawn).not.toHaveBeenCalled();
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
      expect(existsSync(recordPath)).toBe(true);
      expect(readFileSync(quarantinePath, "utf8")).toBe(String(fixture.pid));
      expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
      expect(boundaries).not.toContain("after-replacement-readiness");
    } finally {
      chmodSync(credentialDir, 0o700);
    }
  });

  it("rejects a queued PID mutation in the terminal authorized publication validator", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-authorized-terminal-microtask-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const credentialDir = join(fixture.root, ".hermetic-credentials");
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGTERM") fixture.removeProcess();
      },
    );
    const detachedSpawn = vi.fn(() => makeSpawnChild(5252)) as unknown as SpawnOverride;
    let credentialSourcePath = "";
    const runSystemd = vi.fn((
      _command: string,
      args: readonly string[],
    ): ReturnType<typeof spawnSync> => {
      const credentialArg = args.find((argument: string): boolean => (
        argument.startsWith("--property=LoadCredential=OPENAI_API_KEY:")
      ));
      credentialSourcePath = credentialArg?.split(":", 2)[1] ?? "";
      void fixture.ensureReplacement();
      return { status: 0, signal: null, stdout: "", stderr: "", pid: 1, output: [] };
    }) as unknown as SpawnSyncOverride;
    const boundaries: string[] = [];
    let queued = false;
    let recordBefore = "";
    let quarantineBefore = "";
    let tokenBefore = "";
    let signalCallsBefore = 0;
    const boundary: RecoveryBoundaryOverride = (phase: string): void => {
      boundaries.push(phase);
      if (phase !== "before-authorized-connected-publication" || queued) return;
      queued = true;
      recordBefore = readFileSync(recordPath, "utf8");
      quarantineBefore = readFileSync(quarantinePath, "utf8");
      tokenBefore = readFileSync(fixture.tokenFile, "utf8");
      signalCallsBefore = fixture.killProcess.mock.calls.length;
      queueMicrotask((): void => {
        writeFileSync(fixture.pidFile, "9999");
      });
    };
    const options = withHermeticLifecycleSeams(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnOverride: detachedSpawn,
      _spawnSyncOverride: runSystemd,
      _offlineRecoveryBoundaryOverride: boundary,
      enforceUserManagerParent: true,
    }), {
      environment: { OPENAI_API_KEY: "authorized-terminal-secret" },
    }) as RestartDaemonOptions;

    await expect(restartDaemonProduction(options)).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("not publishable"),
    });

    expect(queued).toBe(true);
    expect(boundaries).toContain("after-authorized-cleanup-before-final-publication");
    expect(boundaries).toContain("after-replacement-readiness");
    expect(runSystemd).toHaveBeenCalledOnce();
    expect(detachedSpawn).not.toHaveBeenCalled();
    expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsBefore);
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("9999");
    expect(readFileSync(recordPath, "utf8")).toBe(recordBefore);
    expect(readFileSync(quarantinePath, "utf8")).toBe(quarantineBefore);
    expect(readFileSync(fixture.tokenFile, "utf8")).toBe(tokenBefore);
    expect(credentialSourcePath).not.toBe("");
    expect(existsSync(credentialSourcePath)).toBe(false);
    expect(existsSync(dirname(credentialSourcePath))).toBe(false);
    expect(readdirSync(credentialDir)).toEqual([]);
  });

  it("refuses final publication when the last finalization liveness callback drifts physical state", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-last-callback-");
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGTERM") fixture.removeProcess();
      },
    );
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const candidateCmdlinePath = join(fixture.procRoot, "5252", "cmdline");
    const boundaries: string[] = [];
    let armed = false;
    let armedLivenessCalls = 0;
    let mutated = false;
    let quarantineBefore = "";
    let signalCallsBefore = 0;
    const boundary: RecoveryBoundaryOverride = (phase: string): void => {
      boundaries.push(phase);
      if (phase !== "before-final-backup-cleanup" || armed) return;
      armed = true;
      quarantineBefore = readFileSync(quarantinePath, "utf8");
      signalCallsBefore = fixture.killProcess.mock.calls.length;
    };
    const isAlive = vi.fn((pid: number): boolean => {
      if (armed && pid === 5252) {
        armedLivenessCalls += 1;
        if (armedLivenessCalls === 24) {
          mutated = true;
          writeFileSync(fixture.pidFile, "9999");
          writeFileSync(fixture.tokenFile, "replacement-token-drift");
          chmodSync(fixture.tokenFile, 0o600);
          writeFileSync(
            candidateCmdlinePath,
            `${process.execPath}\0${fixture.entrypoint}\0unrelated\0process\0`,
          );
        }
        return true;
      }
      return fixture.isAlive(pid);
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _isProcessAliveOverride: isAlive,
      _offlineRecoveryBoundaryOverride: boundary,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("terminal callback-free replacement"),
    });

    expect(mutated).toBe(true);
    expect(armedLivenessCalls).toBe(24);
    expect(boundaries).not.toContain("before-terminal-restart-publication");
    expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsBefore);
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("9999");
    expect(readFileSync(fixture.tokenFile, "utf8")).toBe("replacement-token-drift");
    expect(readFileSync(candidateCmdlinePath, "utf8")).toContain("unrelated\0process");
    expect(existsSync(recordPath)).toBe(false);
    expect(readFileSync(quarantinePath, "utf8")).toBe(quarantineBefore);
    await expect(ensureDaemon(offlineRestartOptions(fixture)))
      .resolves.toMatchObject({
        connected: false,
        spawned: false,
        warning: expect.stringContaining("restart recovery is unresolved"),
      });
  });

  it("refuses a terminal abort and durably restores the exact recovery backup", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-abort-");
    const controller = new AbortController();
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let exactRecoveryBytes = "";
    const boundary: RecoveryBoundaryOverride = (phase: string): void => {
      if (phase === "before-record-cleanup") {
        exactRecoveryBytes = readFileSync(recordPath, "utf8");
      }
      if (phase === "before-terminal-restart-publication") controller.abort();
    };

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
      _offlineRecoveryBoundaryOverride: boundary,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("interrupted at terminal restart publication"),
    });

    expect(existsSync(recordPath)).toBe(false);
    expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
  });

  it("observes an abort delivered while the terminal listener is being attached", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-attach-abort-");
    const controller = new AbortController();
    let terminalIntrinsicObserved = false;
    const signal = new Proxy(controller.signal, {
      get: (target, property): unknown => {
        if (typeof property === "symbol") terminalIntrinsicObserved = true;
        if (property === "aborted" && terminalIntrinsicObserved) {
          controller.abort();
          return true;
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: signal,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("interrupted at terminal restart publication"),
    });
    expect(terminalIntrinsicObserved).toBe(true);
  });

  it("fails closed when the terminal publication boundary throws", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-boundary-throw-");

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-terminal-restart-publication") {
          throw new Error("synthetic terminal publication failure");
        }
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("terminal restart publication boundary failed"),
    });
  });

  it.each([
    ["abort", "record"],
    ["abort", "indeterminate"],
    ["boundary", "record"],
    ["boundary", "indeterminate"],
  ] as const)(
    "reports %s terminal failure with %s authority",
    async (failure, authority): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-terminal-${failure}-${authority}-`,
      );
      const controller = new AbortController();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      let recoveryBytes = "";

      const result = await restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "before-record-cleanup") {
            recoveryBytes = readFileSync(recordPath, "utf8");
          }
          if (phase !== "before-terminal-restart-publication") return;
          if (authority === "record") {
            writeFileSync(recordPath, recoveryBytes, { mode: 0o600 });
          } else {
            mkdirSync(recordPath);
          }
          if (failure === "abort") controller.abort();
          else throw new Error("synthetic terminal boundary failure");
        },
      }));

      expect(recoveryBytes).not.toBe("");
      expect(result).toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining(failure === "abort"
          ? "interrupted at terminal restart publication"
          : "terminal restart publication boundary failed"),
      });
      expect(result.warning).toContain(authority === "record"
        ? `exact durable recovery authority remains at ${recordPath}`
        : "authority or durability is indeterminate");
    },
  );

  it("fails closed when the terminal abort listener cannot be detached", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-detach-failure-");
    const controller = new AbortController();
    const revocable = Proxy.revocable(controller.signal, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: revocable.proxy,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-terminal-restart-publication") revocable.revoke();
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("terminal restart publication boundary failed"),
    });
  });

  it("reports an exact current recovery record as terminal failure authority", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-current-record-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let exactRecoveryBytes = "";
    const boundary: RecoveryBoundaryOverride = (phase: string): void => {
      if (phase === "before-record-cleanup") {
        exactRecoveryBytes = readFileSync(recordPath, "utf8");
      }
      if (phase !== "before-terminal-restart-publication") return;
      writeFileSync(recordPath, exactRecoveryBytes, { mode: 0o600 });
      chmodSync(recordPath, 0o600);
      const recordDescriptor = openSync(recordPath, constants.O_RDONLY);
      try {
        fsyncSync(recordDescriptor);
      } finally {
        closeSync(recordDescriptor);
      }
      const stateDescriptor = openSync(
        fixture.root,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        fsyncSync(stateDescriptor);
      } finally {
        closeSync(stateDescriptor);
      }
    };

    const result = await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: boundary,
    }));

    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining(`exact durable recovery authority remains at ${recordPath}`),
    });
    expect(readFileSync(recordPath, "utf8")).toBe(exactRecoveryBytes);
    expect(existsSync(quarantinePath)).toBe(false);
  });

  it.each([
    ["short", (bytes: string): string => bytes.slice(0, -1)],
    ["long", (bytes: string): string => `${bytes} `],
    ["same-length mismatch", (bytes: string): string => (
      `${bytes.startsWith("{") ? "[" : "{"}${bytes.slice(1)}`
    )],
  ] as const)(
    "preserves a non-exact %s current recovery record as indeterminate authority",
    async (_label: string, mutate: (bytes: string) => string): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-terminal-current-record-invalid-");
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      let exactRecoveryBytes = "";
      let replacementBytes = "";
      let signalCallsBefore = 0;
      const boundary: RecoveryBoundaryOverride = (phase: string): void => {
        if (phase === "before-record-cleanup") {
          exactRecoveryBytes = readFileSync(recordPath, "utf8");
        }
        if (phase !== "before-terminal-restart-publication") return;
        replacementBytes = mutate(exactRecoveryBytes);
        writeFileSync(recordPath, replacementBytes, { mode: 0o600 });
        chmodSync(recordPath, 0o600);
        signalCallsBefore = fixture.killProcess.mock.calls.length;
      };

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: boundary,
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("authority or durability is indeterminate"),
      });

      expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsBefore);
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
      expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
      expect(readFileSync(recordPath, "utf8")).toBe(replacementBytes);
      expect(existsSync(quarantinePath)).toBe(false);
    },
  );

  it("reports authority indeterminate when terminal-proof backup restoration fails", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-restore-failure-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let terminalPhase = false;
    const boundary: RecoveryBoundaryOverride = (phase: string): void => {
      if (phase !== "before-terminal-restart-publication") return;
      terminalPhase = true;
      rmSync(join(fixture.procRoot, "5252", "fd"), { recursive: true, force: true });
      mkdirSync(quarantinePath);
    };

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: boundary,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("authority or durability is indeterminate"),
    });

    expect(terminalPhase).toBe(true);
    expect(existsSync(recordPath)).toBe(false);
    expect(lstatSync(quarantinePath).isDirectory()).toBe(true);
  });

  it("uses the captured terminal descriptor-close intrinsic", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-close-failure-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const originalCloseSync = nodeFs.closeSync;
    let terminalPhase = false;
    let stateRootCloseCalls = 0;
    let injectedCloseFailure = false;
    let result: RestartDaemonResult | undefined;
    const boundary: RecoveryBoundaryOverride = (phase: string): void => {
      if (phase === "before-record-cleanup") {
        expect(readFileSync(recordPath, "utf8")).not.toBe("");
      }
      if (phase !== "before-terminal-restart-publication") return;
      expect(existsSync(recordPath)).toBe(false);
      expect(existsSync(quarantinePath)).toBe(false);
      terminalPhase = true;
      nodeFs.closeSync = (descriptor: number): void => {
        let target: string | undefined;
        try {
          target = readlinkSync(`/proc/self/fd/${String(descriptor)}`);
        } catch {
          target = undefined;
        }
        originalCloseSync(descriptor);
        if (terminalPhase && target === fixture.root) {
          stateRootCloseCalls += 1;
          if (stateRootCloseCalls === 2) {
            injectedCloseFailure = true;
            throw new Error("synthetic terminal state-directory close failure");
          }
        }
      };
      syncBuiltinESMExports();
    };

    try {
      result = await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: boundary,
      }));
    } finally {
      nodeFs.closeSync = originalCloseSync;
      syncBuiltinESMExports();
    }

    expect(injectedCloseFailure).toBe(false);
    expect(stateRootCloseCalls).toBe(0);
    expect(result).toMatchObject({
      connected: true,
      restarted: true,
      pid: 5252,
    });
    expect(existsSync(recordPath)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(false);
  });

  it("contains a recovery-authority directory-proof close failure", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-final-authority-directory-close-failure-",
    );
    const originalCloseSync = nodeFs.closeSync;
    let armed = false;
    let injectedCloseFailure = false;
    let backupCleanupCalls = 0;
    nodeFs.closeSync = (descriptor: number): void => {
      let target: string | undefined;
      try {
        target = readlinkSync(`/proc/self/fd/${String(descriptor)}`);
      } catch {
        target = undefined;
      }
      originalCloseSync(descriptor);
      if (armed && !injectedCloseFailure && target === fixture.root) {
        injectedCloseFailure = true;
        throw new Error("synthetic recovery-authority directory close failure");
      }
    };
    syncBuiltinESMExports();

    let result: RestartDaemonResult | undefined;
    try {
      result = await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBackupUnlinkOverride: (path: string): void => {
          backupCleanupCalls += 1;
          if (backupCleanupCalls === 1) {
            expect(path).toBe(join(fixture.root, ".daemon.pid.restart-quarantine"));
            return;
          }
          throw new Error("retain final recovery backup");
        },
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "before-final-backup-cleanup") armed = true;
        },
      }));
    } finally {
      nodeFs.closeSync = originalCloseSync;
      syncBuiltinESMExports();
    }

    expect(injectedCloseFailure).toBe(true);
    expect(backupCleanupCalls).toBe(2);
    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("authority or durability is indeterminate"),
    });
  });

  it("never re-reads callback-origin readiness getters after terminal finalization", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-plain-result-");
    let terminalPhase = false;
    const accessCounts = new Map<string, number>();
    const read = <T>(field: string, value: T): T => {
      if (terminalPhase) throw new Error("callback-origin readiness getter reached terminal proof");
      accessCounts.set(field, (accessCounts.get(field) ?? 0) + 1);
      return value;
    };
    const callbackResult = Object.defineProperties({}, {
      connected: { enumerable: true, get: (): boolean => read("connected", true) },
      port: { enumerable: true, get: (): number => read("port", 19999) },
      spawned: { enumerable: true, get: (): boolean => read("spawned", true) },
      pid: { enumerable: true, get: (): number => read("pid", 5252) },
      parentPid: {
        enumerable: true,
        get: (): number => read("parentPid", fixture.managerPid),
      },
      userSystemdPid: {
        enumerable: true,
        get: (): number => read("userSystemdPid", fixture.managerPid),
      },
      restartedForParent: {
        enumerable: true,
        get: (): boolean => read("restartedForParent", true),
      },
      startMethod: {
        enumerable: true,
        get: (): "systemd-user" => read("startMethod", "systemd-user"),
      },
      warning: {
        enumerable: true,
        get: (): string => read("warning", "replacement ready warning"),
      },
    }) as EnsureDaemonResult;

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: async (): Promise<EnsureDaemonResult> => {
        await fixture.ensureReplacement();
        return callbackResult;
      },
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-terminal-restart-publication") terminalPhase = true;
      },
    }))).resolves.toMatchObject({
      connected: true,
      restarted: true,
      pid: 5252,
      parentPid: fixture.managerPid,
      userSystemdPid: fixture.managerPid,
      restartedForParent: true,
      startMethod: "systemd-user",
      warning: "replacement ready warning",
    });

    expect(terminalPhase).toBe(true);
    expect(Object.fromEntries(accessCounts)).toEqual({
      connected: 1,
      parentPid: 1,
      pid: 1,
      port: 1,
      restartedForParent: 1,
      spawned: 1,
      startMethod: 1,
      userSystemdPid: 1,
      warning: 1,
    });
  });

  it.each(["success", "terminal-proof-refusal"] as const)(
    "uses no mutable prototype, reflection, abort, or injected callback during literal restart %s",
    async (outcome): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-terminal-sentinels-${outcome}-`);
      const controller = new AbortController();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const arrayProperties: readonly (string | symbol)[] = [
        Symbol.iterator,
        "every",
        "sort",
        "includes",
        "find",
        "push",
        "toJSON",
      ];
      const stringProperties: readonly string[] = [
        "split",
        "includes",
        "slice",
        "lastIndexOf",
        "startsWith",
        "endsWith",
        "trim",
        "toUpperCase",
        "charCodeAt",
      ];
      const statsPrototype = Object.getPrototypeOf(statSync(fixture.root)) as object;
      const statsProperties: readonly string[] = ["isFile", "isDirectory"];
      const hashPrototype = Object.getPrototypeOf(createHash("sha256")) as object;
      const hashProperties: readonly string[] = ["update", "digest"];
      const abortPrototype = Object.getPrototypeOf(controller.signal) as object;
      const arrayDescriptors: Array<PropertyDescriptor | undefined> = [];
      const stringDescriptors: Array<PropertyDescriptor | undefined> = [];
      const statsDescriptors: Array<PropertyDescriptor | undefined> = [];
      const hashDescriptors: Array<PropertyDescriptor | undefined> = [];
      let descriptorIndex = 0;
      while (descriptorIndex < arrayProperties.length) {
        arrayDescriptors[descriptorIndex] = Object.getOwnPropertyDescriptor(
          Array.prototype,
          arrayProperties[descriptorIndex]!,
        );
        descriptorIndex += 1;
      }
      descriptorIndex = 0;
      while (descriptorIndex < stringProperties.length) {
        stringDescriptors[descriptorIndex] = Object.getOwnPropertyDescriptor(
          String.prototype,
          stringProperties[descriptorIndex]!,
        );
        descriptorIndex += 1;
      }
      descriptorIndex = 0;
      while (descriptorIndex < statsProperties.length) {
        statsDescriptors[descriptorIndex] = Object.getOwnPropertyDescriptor(
          statsPrototype,
          statsProperties[descriptorIndex]!,
        );
        descriptorIndex += 1;
      }
      descriptorIndex = 0;
      while (descriptorIndex < hashProperties.length) {
        hashDescriptors[descriptorIndex] = Object.getOwnPropertyDescriptor(
          hashPrototype,
          hashProperties[descriptorIndex]!,
        );
        descriptorIndex += 1;
      }
      const objectKeysDescriptor = Object.getOwnPropertyDescriptor(Object, "keys");
      const objectEntriesDescriptor = Object.getOwnPropertyDescriptor(Object, "entries");
      const objectValuesDescriptor = Object.getOwnPropertyDescriptor(Object, "values");
      const objectNamesDescriptor = Object.getOwnPropertyDescriptor(
        Object,
        "getOwnPropertyNames",
      );
      const objectSymbolsDescriptor = Object.getOwnPropertyDescriptor(
        Object,
        "getOwnPropertySymbols",
      );
      const reflectOwnKeysDescriptor = Object.getOwnPropertyDescriptor(Reflect, "ownKeys");
      const objectToJSONDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
      const abortedDescriptor = Object.getOwnPropertyDescriptor(abortPrototype, "aborted");
      const processArgvOneDescriptor = Object.getOwnPropertyDescriptor(process.argv, "1");
      const processExecPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
      let sentinelCalls = 0;
      let injectedCalls = 0;
      let terminalPhase = false;
      let sentinelsInstalled = false;
      let processArgvPoisoned = false;
      let processExecPathPoisoned = false;
      let exactRecoveryBytes = "";
      let signalCallsAtTerminal: number | undefined;
      let result: RestartDaemonResult | undefined;
      let restartError: unknown;
      const sentinel = (): never => {
        sentinelCalls += 1;
        throw new Error("mutable prototype or reflection callback reached terminal restart");
      };
      const injectedGuard = (): void => {
        if (!terminalPhase) return;
        injectedCalls += 1;
        throw new Error("injected lifecycle dependency reached terminal restart");
      };
      const installSentinels = (): void => {
        if (sentinelsInstalled) return;
        let index = 0;
        while (index < arrayProperties.length) {
          Object.defineProperty(Array.prototype, arrayProperties[index]!, {
            configurable: true,
            enumerable: false,
            writable: true,
            value: sentinel,
          });
          index += 1;
        }
        index = 0;
        while (index < stringProperties.length) {
          Object.defineProperty(String.prototype, stringProperties[index]!, {
            configurable: true,
            enumerable: false,
            writable: true,
            value: sentinel,
          });
          index += 1;
        }
        index = 0;
        while (index < statsProperties.length) {
          Object.defineProperty(statsPrototype, statsProperties[index]!, {
            configurable: true,
            enumerable: false,
            writable: true,
            value: sentinel,
          });
          index += 1;
        }
        index = 0;
        while (index < hashProperties.length) {
          Object.defineProperty(hashPrototype, hashProperties[index]!, {
            configurable: true,
            enumerable: false,
            writable: true,
            value: sentinel,
          });
          index += 1;
        }
        Object.defineProperty(Object, "keys", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: sentinel,
        });
        Object.defineProperty(Object, "entries", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: sentinel,
        });
        Object.defineProperty(Object, "values", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: sentinel,
        });
        Object.defineProperty(Object, "getOwnPropertyNames", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: sentinel,
        });
        Object.defineProperty(Object, "getOwnPropertySymbols", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: sentinel,
        });
        Object.defineProperty(Reflect, "ownKeys", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: sentinel,
        });
        Object.defineProperty(Object.prototype, "toJSON", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: sentinel,
        });
        Object.defineProperty(abortPrototype, "aborted", {
          configurable: true,
          enumerable: false,
          get: sentinel,
        });
        Object.defineProperty(process.argv, "1", {
          configurable: true,
          enumerable: processArgvOneDescriptor?.enumerable ?? true,
          get: sentinel,
          set: sentinel,
        });
        processArgvPoisoned = true;
        if (processExecPathDescriptor?.configurable === true) {
          Object.defineProperty(process, "execPath", {
            configurable: true,
            enumerable: processExecPathDescriptor.enumerable ?? true,
            get: sentinel,
            set: sentinel,
          });
          processExecPathPoisoned = true;
        }
        sentinelsInstalled = true;
      };

      try {
        result = await restartDaemon(offlineRestartOptions(fixture, {
          _abortSignal: controller.signal,
          _realpathOverride: (path: string): string => {
            injectedGuard();
            return realpathSync(path);
          },
          _listeningPortsOverride: (pid?: number): number[] => {
            injectedGuard();
            return fixture.listenerPorts(pid);
          },
          _isProcessAliveOverride: (pid: number): boolean => {
            injectedGuard();
            return fixture.isAlive(pid);
          },
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-record-cleanup") {
              exactRecoveryBytes = readFileSync(recordPath, "utf8");
            }
            if (phase !== "before-terminal-restart-publication") return;
            signalCallsAtTerminal = fixture.killProcess.mock.calls.length;
            if (outcome === "terminal-proof-refusal") {
              writeFileSync(join(fixture.procRoot, "5252", "status"), "malformed\n");
            }
            terminalPhase = true;
            installSentinels();
          },
        }));
      } catch (error) {
        restartError = error;
      } finally {
        if (processArgvOneDescriptor === undefined) {
          Reflect.deleteProperty(process.argv, "1");
        } else {
          Object.defineProperty(process.argv, "1", processArgvOneDescriptor);
        }
        if (processExecPathPoisoned) {
          Object.defineProperty(process, "execPath", processExecPathDescriptor!);
        }
        let index = 0;
        while (index < arrayProperties.length) {
          const descriptor = arrayDescriptors[index];
          if (descriptor === undefined) {
            Reflect.deleteProperty(Array.prototype, arrayProperties[index]!);
          } else {
            Object.defineProperty(Array.prototype, arrayProperties[index]!, descriptor);
          }
          index += 1;
        }
        index = 0;
        while (index < stringProperties.length) {
          const descriptor = stringDescriptors[index];
          if (descriptor === undefined) {
            Reflect.deleteProperty(String.prototype, stringProperties[index]!);
          } else {
            Object.defineProperty(String.prototype, stringProperties[index]!, descriptor);
          }
          index += 1;
        }
        index = 0;
        while (index < statsProperties.length) {
          const descriptor = statsDescriptors[index];
          if (descriptor === undefined) {
            Reflect.deleteProperty(statsPrototype, statsProperties[index]!);
          } else {
            Object.defineProperty(statsPrototype, statsProperties[index]!, descriptor);
          }
          index += 1;
        }
        index = 0;
        while (index < hashProperties.length) {
          const descriptor = hashDescriptors[index];
          if (descriptor === undefined) {
            Reflect.deleteProperty(hashPrototype, hashProperties[index]!);
          } else {
            Object.defineProperty(hashPrototype, hashProperties[index]!, descriptor);
          }
          index += 1;
        }
        if (objectKeysDescriptor === undefined) {
          Reflect.deleteProperty(Object, "keys");
        } else {
          Object.defineProperty(Object, "keys", objectKeysDescriptor);
        }
        if (objectEntriesDescriptor === undefined) {
          Reflect.deleteProperty(Object, "entries");
        } else {
          Object.defineProperty(Object, "entries", objectEntriesDescriptor);
        }
        if (objectValuesDescriptor === undefined) {
          Reflect.deleteProperty(Object, "values");
        } else {
          Object.defineProperty(Object, "values", objectValuesDescriptor);
        }
        if (objectNamesDescriptor === undefined) {
          Reflect.deleteProperty(Object, "getOwnPropertyNames");
        } else {
          Object.defineProperty(Object, "getOwnPropertyNames", objectNamesDescriptor);
        }
        if (objectSymbolsDescriptor === undefined) {
          Reflect.deleteProperty(Object, "getOwnPropertySymbols");
        } else {
          Object.defineProperty(Object, "getOwnPropertySymbols", objectSymbolsDescriptor);
        }
        if (reflectOwnKeysDescriptor === undefined) {
          Reflect.deleteProperty(Reflect, "ownKeys");
        } else {
          Object.defineProperty(Reflect, "ownKeys", reflectOwnKeysDescriptor);
        }
        if (objectToJSONDescriptor === undefined) {
          Reflect.deleteProperty(Object.prototype, "toJSON");
        } else {
          Object.defineProperty(Object.prototype, "toJSON", objectToJSONDescriptor);
        }
        if (abortedDescriptor === undefined) {
          Reflect.deleteProperty(abortPrototype, "aborted");
        } else {
          Object.defineProperty(abortPrototype, "aborted", abortedDescriptor);
        }
      }

      expect(sentinelsInstalled).toBe(true);
      expect(processArgvPoisoned).toBe(true);
      if (processExecPathDescriptor?.configurable === true) {
        expect(processExecPathPoisoned).toBe(true);
      }
      expect(sentinelCalls).toBe(0);
      expect(injectedCalls).toBe(0);
      if (outcome === "success") {
        expect(restartError).toBeUndefined();
        expect(result).toMatchObject({ connected: true, restarted: true, pid: 5252 });
        expect(existsSync(recordPath)).toBe(false);
        expect(existsSync(quarantinePath)).toBe(false);
      } else {
        expect(restartError).toBeUndefined();
        expect(result).toMatchObject({
          connected: false,
          restarted: false,
          pid: 5252,
          stoppedPid: fixture.pid,
          warning: expect.stringContaining("terminal callback-free replacement"),
        });
        expect(existsSync(recordPath)).toBe(false);
        expect(lstatSync(quarantinePath).isFile()).toBe(true);
        expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
        expect(result?.warning).toContain("exact durable recovery backup was restored");
        expect(signalCallsAtTerminal).toBeDefined();
        expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtTerminal ?? -1);
        expect(fixture.ensureReplacement).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("keeps every injected dependency guarded through the actual terminal return", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-builtins-only-");
    let terminalPhase = false;
    let reachedTerminalBoundary = false;
    let reachedFinalization = false;
    const guard = (): void => {
      if (terminalPhase) throw new Error("injected dependency reached terminal verifier");
    };
    const boundary: RecoveryBoundaryOverride = (phase: string): void => {
      guard();
      if (phase === "after-replacement-readiness") reachedFinalization = true;
      if (phase === "before-terminal-restart-publication") {
        reachedTerminalBoundary = true;
        terminalPhase = true;
      }
    };
    const spawn = vi.fn(() => {
      guard();
      void fixture.ensureReplacement();
      return makeSpawnChild(5252);
    }) as unknown as SpawnOverride;

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnOverride: spawn,
      _spawnSyncOverride: vi.fn(() => {
        guard();
        return { status: 1, stdout: "", stderr: "unused" };
      }) as unknown as SpawnSyncOverride,
      _fetchOverride: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        guard();
        return fixture.healthFetch(input, init);
      }),
      _isProcessAliveOverride: (pid: number): boolean => {
        guard();
        return fixture.isAlive(pid);
      },
      _realpathOverride: (path: string): string => {
        guard();
        return realpathSync(path);
      },
      _listeningPortsOverride: (pid?: number): number[] => {
        guard();
        return fixture.listenerPorts(pid);
      },
      _killOverride: (pid: number, signal?: NodeJS.Signals | number): void => {
        guard();
        fixture.killProcess(pid, signal);
      },
      _sleepOverride: async (): Promise<void> => {
        guard();
      },
      _offlineRecordOpenOverride: (path: string, flags: number, mode?: number): number => {
        guard();
        return openSync(path, flags, mode);
      },
      _offlineFsyncOverride: (descriptor: number): void => {
        guard();
        fsyncSync(descriptor);
      },
      _offlineRecordWriteOverride: (descriptor: number, bytes: Uint8Array): number => {
        guard();
        return writeSync(descriptor, bytes);
      },
      _offlinePidRenameOverride: (from: string, to: string): void => {
        guard();
        renameSync(from, to);
      },
      _offlinePidUnlinkOverride: (): void => {
        guard();
      },
      _offlineRecordUnlinkOverride: (): void => {
        guard();
      },
      _offlineRecoveryBackupUnlinkOverride: (): void => {
        guard();
      },
      _offlineRecoveryFinalizeOverride: guard,
      _offlineRecoveryBoundaryOverride: boundary,
    }))).resolves.toMatchObject({
      connected: true,
      restarted: true,
      pid: 5252,
    });

    expect(reachedTerminalBoundary).toBe(true);
    expect(reachedFinalization).toBe(true);
    expect(terminalPhase).toBe(true);
  });

  it.each([
    ["replacement", (fixture: OfflineRestartFixture): string => (
      join(fixture.procRoot, "5252", "cmdline")
    )],
    ["parent", (fixture: OfflineRestartFixture): string => (
      join(fixture.procRoot, String(fixture.managerPid), "cmdline")
    )],
  ] as const)(
    "accepts an exact positive-size %s cmdline proof in the frozen terminal seed",
    async (
      _label: string,
      pathFor: (fixture: OfflineRestartFixture) => string,
    ): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-terminal-positive-cmdline-");
      let observedSize = 0;

      const result = await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "before-terminal-restart-publication") {
            observedSize = statSync(pathFor(fixture)).size;
          }
        },
      }));

      expect(observedSize).toBeGreaterThan(0);
      expect(result).toMatchObject({ connected: true, restarted: true, pid: 5252 });
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
      expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
    },
  );

  it("refuses the frozen seed when invalid UTF-8 expands the replacement cmdline proof", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-invalid-utf8-cmdline-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const replacementCmdlinePath = join(fixture.procRoot, "5252", "cmdline");
    const originalExecPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
    const originalExecPath = process.execPath;
    const originalOpenSync = nodeFs.openSync;
    const originalReadSync = nodeFs.readSync;
    const originalCloseSync = nodeFs.closeSync;
    const replacementCharacter = "\uFFFD";
    const replacementCharacterBytes = Buffer.from(replacementCharacter, "utf8");
    const syntheticExecPath = join(fixture.root, `node-${replacementCharacter}`);
    const validReplacementCmdline = Buffer.from(
      `${syntheticExecPath}\0${fixture.entrypoint}\0daemon\0start\0--foreground\0`,
      "utf8",
    );
    const replacementCharacterOffset = validReplacementCmdline.indexOf(replacementCharacterBytes);
    const invalidReplacementCmdline = Buffer.concat([
      validReplacementCmdline.subarray(0, replacementCharacterOffset),
      Buffer.from([0xff]),
      validReplacementCmdline.subarray(replacementCharacterOffset + replacementCharacterBytes.length),
    ]);
    const lifecycleMutation = vi.fn();
    let backupCleanupCalls = 0;
    let finalCleanupPhase = false;
    let finalAccessObserved = false;
    let invalidBytesInstalled = false;
    const tokenDescriptors = new Set<number>();
    let tokenContentReadCalls = 0;
    let signalCallsAtRefusal: number | undefined;
    let spawnCallsAtRefusal: number | undefined;
    let tokenReadCallsAtRefusal: number | undefined;
    let lifecycleMutationCallsAtRefusal: number | undefined;
    let exactRecoveryBytes = "";
    let result: RestartDaemonResult | undefined;
    let restartError: unknown;

    writeFileSync(syntheticExecPath, "run-owned synthetic node executable\n");
    if (originalExecPathDescriptor === undefined || replacementCharacterOffset < 0) {
      throw new Error("test setup could not establish a synthetic replacement executable");
    }
    Object.defineProperty(process, "execPath", {
      ...originalExecPathDescriptor,
      value: syntheticExecPath,
    });
    fixture.writeProcess({
      executable: syntheticExecPath,
      argv: [syntheticExecPath, fixture.entrypoint, "daemon", "start", "--foreground"],
    });
    nodeFs.openSync = ((
      path: string | Buffer | URL,
      flags: string | number,
      mode?: string | number,
    ): number => {
      const descriptor = Reflect.apply(
        originalOpenSync,
        nodeFs,
        mode === undefined ? [path, flags] : [path, flags, mode],
      ) as number;
      if (String(path) === fixture.tokenFile) tokenDescriptors.add(descriptor);
      return descriptor;
    }) as typeof nodeFs.openSync;
    nodeFs.readSync = ((...args: unknown[]): number => {
      if (tokenDescriptors.has(args[0] as number)) tokenContentReadCalls += 1;
      return Reflect.apply(originalReadSync, nodeFs, args) as number;
    }) as typeof nodeFs.readSync;
    nodeFs.closeSync = ((descriptor: number): void => {
      try {
        originalCloseSync(descriptor);
      } finally {
        tokenDescriptors.delete(descriptor);
      }
    }) as typeof nodeFs.closeSync;
    syncBuiltinESMExports();

    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const response = await fixture.healthFetch(input);
      if (finalCleanupPhase && String(input).endsWith("/stats/pool")) {
        finalAccessObserved = true;
      }
      return response;
    });
    const isAlive = vi.fn((pid: number): boolean => {
      const alive = fixture.isAlive(pid);
      if (
        pid === 5252
        && finalCleanupPhase
        && finalAccessObserved
        && !invalidBytesInstalled
      ) {
        writeFileSync(replacementCmdlinePath, invalidReplacementCmdline);
        invalidBytesInstalled = true;
        signalCallsAtRefusal = fixture.killProcess.mock.calls.length;
        spawnCallsAtRefusal = fixture.ensureReplacement.mock.calls.length;
        tokenReadCallsAtRefusal = tokenContentReadCalls;
        lifecycleMutationCallsAtRefusal = lifecycleMutation.mock.calls.length;
      }
      return alive;
    });

    try {
      result = await restartDaemon(offlineRestartOptions(fixture, {
        _fetchOverride: fetch,
        _isProcessAliveOverride: isAlive,
        _offlinePidUnlinkOverride: (): void => {
          lifecycleMutation("pid-unlink");
        },
        _offlineRecordUnlinkOverride: (): void => {
          lifecycleMutation("record-unlink");
        },
        _offlineRecoveryBackupUnlinkOverride: (): void => {
          lifecycleMutation("backup-unlink");
          backupCleanupCalls += 1;
          if (backupCleanupCalls === 2) finalCleanupPhase = true;
        },
        _offlineRecoveryFinalizeOverride: (): void => {
          lifecycleMutation("finalize");
        },
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "before-record-cleanup") {
            exactRecoveryBytes = readFileSync(recordPath, "utf8");
          }
        },
      }));
    } catch (error) {
      restartError = error;
    } finally {
      nodeFs.openSync = originalOpenSync;
      nodeFs.readSync = originalReadSync;
      nodeFs.closeSync = originalCloseSync;
      syncBuiltinESMExports();
      Object.defineProperty(process, "execPath", originalExecPathDescriptor);
      fixture.writeProcess({
        pid: 5252,
        startTime: "654321",
        executable: originalExecPath,
        argv: [originalExecPath, fixture.entrypoint, "daemon", "start", "--foreground"],
      });
    }

    expect(restartError).toBeUndefined();
    expect(invalidBytesInstalled).toBe(true);
    expect(signalCallsAtRefusal).toBeDefined();
    expect(spawnCallsAtRefusal).toBeDefined();
    expect(tokenReadCallsAtRefusal).toBeDefined();
    expect(lifecycleMutationCallsAtRefusal).toBeDefined();
    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      pid: 5252,
      stoppedPid: fixture.pid,
      warning: expect.stringContaining("terminal callback-free replacement"),
    });
    expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtRefusal ?? -1);
    expect(fixture.ensureReplacement).toHaveBeenCalledTimes(spawnCallsAtRefusal ?? -1);
    expect(tokenContentReadCalls).toBe(tokenReadCallsAtRefusal);
    expect(lifecycleMutation).toHaveBeenCalledTimes(lifecycleMutationCallsAtRefusal ?? -1);
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
    expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
    expect(existsSync(recordPath)).toBe(false);
    expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
    expect(result?.warning).toContain("exact durable recovery backup was restored or preserved");
    expect(result?.warning).not.toContain("authority or durability is indeterminate");
  });

  it.each([
    ["replacement", "unsafe mode"],
    ["replacement", "hardlink"],
    ["parent", "unsafe mode"],
    ["parent", "hardlink"],
  ] as const)(
    "refuses the frozen seed when %s cmdline stable metadata has an %s",
    async (
      subject: "replacement" | "parent",
      fault: "unsafe mode" | "hardlink",
    ): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-terminal-cmdline-metadata-");
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const targetPid = subject === "replacement" ? 5252 : fixture.managerPid;
      const targetPath = join(fixture.procRoot, String(targetPid), "cmdline");
      const triggerPath = join(fixture.procRoot, String(fixture.managerPid), "exe");
      const auxiliaryPath = join(fixture.root, `${subject}-cmdline-hardlink`);
      const originalRealpathSync = nodeFs.realpathSync;
      const originalOpenSync = nodeFs.openSync;
      const originalReadSync = nodeFs.readSync;
      const originalCloseSync = nodeFs.closeSync;
      const tokenDescriptors = new Set<number>();
      const lifecycleMutation = vi.fn();
      let backupCleanupCalls = 0;
      let finalCleanupPhase = false;
      let finalAccessObserved = false;
      let finalIsAliveCalls = 0;
      let seedMutationArmedAt: number | undefined;
      let finalIsAliveCallsAtRefusal: number | undefined;
      let seedMutationArmed = false;
      let faultInstalled = false;
      let auxiliaryLinked = false;
      let tokenContentReadCalls = 0;
      let signalCallsAtRefusal: number | undefined;
      let spawnCallsAtRefusal: number | undefined;
      let tokenReadCallsAtRefusal: number | undefined;
      let lifecycleMutationCallsAtRefusal: number | undefined;
      let originalContent: Buffer | undefined;
      let originalMode: number | undefined;
      let originalInode: number | undefined;
      let originalLinks: number | undefined;
      let restoredContent: Buffer | undefined;
      let restoredMode: number | undefined;
      let restoredInode: number | undefined;
      let restoredLinks: number | undefined;
      let exactRecoveryBytes = "";
      let result: RestartDaemonResult | undefined;
      let restartError: unknown;

      nodeFs.openSync = ((
        path: string | Buffer | URL,
        flags: string | number,
        mode?: string | number,
      ): number => {
        const descriptor = Reflect.apply(
          originalOpenSync,
          nodeFs,
          mode === undefined ? [path, flags] : [path, flags, mode],
        ) as number;
        if (String(path) === fixture.tokenFile) tokenDescriptors.add(descriptor);
        return descriptor;
      }) as typeof nodeFs.openSync;
      nodeFs.readSync = ((...args: unknown[]): number => {
        if (tokenDescriptors.has(args[0] as number)) tokenContentReadCalls += 1;
        return Reflect.apply(originalReadSync, nodeFs, args) as number;
      }) as typeof nodeFs.readSync;
      nodeFs.closeSync = ((descriptor: number): void => {
        try {
          originalCloseSync(descriptor);
        } finally {
          tokenDescriptors.delete(descriptor);
        }
      }) as typeof nodeFs.closeSync;
      nodeFs.realpathSync = ((...args: unknown[]): string | Buffer => {
        const resolved = Reflect.apply(originalRealpathSync, nodeFs, args) as string | Buffer;
        if (seedMutationArmed && !faultInstalled && String(args[0]) === triggerPath) {
          const proof = lstatSync(targetPath);
          originalContent = readFileSync(targetPath);
          originalMode = proof.mode & 0o7777;
          originalInode = proof.ino;
          originalLinks = proof.nlink;
          if (fault === "unsafe mode") {
            chmodSync(targetPath, originalMode | 0o022);
          } else {
            linkSync(targetPath, auxiliaryPath);
            auxiliaryLinked = true;
          }
          faultInstalled = true;
          finalIsAliveCallsAtRefusal = finalIsAliveCalls;
          signalCallsAtRefusal = fixture.killProcess.mock.calls.length;
          spawnCallsAtRefusal = fixture.ensureReplacement.mock.calls.length;
          tokenReadCallsAtRefusal = tokenContentReadCalls;
          lifecycleMutationCallsAtRefusal = lifecycleMutation.mock.calls.length;
        }
        return resolved;
      }) as typeof nodeFs.realpathSync;
      syncBuiltinESMExports();

      const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
        const response = await fixture.healthFetch(input);
        if (finalCleanupPhase && String(input).endsWith("/stats/pool")) {
          finalAccessObserved = true;
        }
        return response;
      });
      const isAlive = vi.fn((pid: number): boolean => {
        const alive = fixture.isAlive(pid);
        if (pid === 5252 && finalCleanupPhase && finalAccessObserved) {
          finalIsAliveCalls += 1;
          if (finalIsAliveCalls === 2) {
            seedMutationArmed = true;
            seedMutationArmedAt = finalIsAliveCalls;
          }
        }
        return alive;
      });

      try {
        result = await restartDaemon(offlineRestartOptions(fixture, {
          _fetchOverride: fetch,
          _isProcessAliveOverride: isAlive,
          _offlinePidUnlinkOverride: (): void => {
            lifecycleMutation("pid-unlink");
          },
          _offlineRecordUnlinkOverride: (): void => {
            lifecycleMutation("record-unlink");
          },
          _offlineRecoveryBackupUnlinkOverride: (): void => {
            lifecycleMutation("backup-unlink");
            backupCleanupCalls += 1;
            if (backupCleanupCalls === 2) finalCleanupPhase = true;
          },
          _offlineRecoveryFinalizeOverride: (): void => {
            lifecycleMutation("finalize");
          },
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-record-cleanup") {
              exactRecoveryBytes = readFileSync(recordPath, "utf8");
            }
          },
        }));
      } catch (error) {
        restartError = error;
      } finally {
        if (fault === "unsafe mode" && originalMode !== undefined) {
          chmodSync(targetPath, originalMode);
        }
        if (auxiliaryLinked) unlinkSync(auxiliaryPath);
        nodeFs.openSync = originalOpenSync;
        nodeFs.readSync = originalReadSync;
        nodeFs.closeSync = originalCloseSync;
        nodeFs.realpathSync = originalRealpathSync;
        syncBuiltinESMExports();
        const restoredProof = lstatSync(targetPath);
        restoredContent = readFileSync(targetPath);
        restoredMode = restoredProof.mode & 0o7777;
        restoredInode = restoredProof.ino;
        restoredLinks = restoredProof.nlink;
      }

      expect(restartError).toBeUndefined();
      expect(seedMutationArmed).toBe(true);
      expect(seedMutationArmedAt).toBe(2);
      expect(finalIsAliveCallsAtRefusal).toBeGreaterThanOrEqual(2);
      expect(finalIsAliveCalls).toBeGreaterThanOrEqual(2);
      expect(faultInstalled).toBe(true);
      expect(originalContent).toBeDefined();
      expect(originalMode).toBeDefined();
      expect(originalInode).toBeDefined();
      expect(originalLinks).toBe(1);
      expect(restoredContent).toEqual(originalContent);
      expect(restoredMode).toBe(originalMode);
      expect(restoredInode).toBe(originalInode);
      expect(restoredLinks).toBe(1);
      expect(signalCallsAtRefusal).toBeDefined();
      expect(spawnCallsAtRefusal).toBeDefined();
      expect(tokenReadCallsAtRefusal).toBeDefined();
      expect(lifecycleMutationCallsAtRefusal).toBeDefined();
      expect(result).toMatchObject({
        connected: false,
        restarted: false,
        pid: 5252,
        stoppedPid: fixture.pid,
        warning: expect.stringContaining("terminal callback-free replacement"),
      });
      expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtRefusal ?? -1);
      expect(fixture.ensureReplacement).toHaveBeenCalledTimes(spawnCallsAtRefusal ?? -1);
      expect(tokenContentReadCalls).toBe(tokenReadCallsAtRefusal);
      expect(lifecycleMutation).toHaveBeenCalledTimes(lifecycleMutationCallsAtRefusal ?? -1);
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
      expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
      expect(existsSync(recordPath)).toBe(false);
      expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
      expect(result?.warning).toContain("exact durable recovery backup was restored or preserved");
      expect(result?.warning).not.toContain("authority or durability is indeterminate");
    },
  );

  it.each([
    ["substituted proc root", (fixture: OfflineRestartFixture): void => {
      renameSync(fixture.procRoot, `${fixture.procRoot}.replaced`);
      mkdirSync(fixture.procRoot);
    }],
    ["symlinked proc root", (fixture: OfflineRestartFixture): void => {
      const displaced = `${fixture.procRoot}.displaced`;
      renameSync(fixture.procRoot, displaced);
      symlinkSync(displaced, fixture.procRoot);
    }],
    ["substituted scope directory", (fixture: OfflineRestartFixture): void => {
      const runtimeDir = join(fixture.root, ".hermetic-runtime");
      rmSync(runtimeDir, { recursive: true, force: true });
      mkdirSync(runtimeDir);
    }],
    ["missing candidate stat", (fixture: OfflineRestartFixture): void => {
      unlinkSync(join(fixture.procRoot, "5252", "stat"));
    }],
    ["malformed candidate status", (fixture: OfflineRestartFixture): void => {
      writeFileSync(join(fixture.procRoot, "5252", "status"), "malformed\n");
    }],
    ["malformed candidate cmdline", (fixture: OfflineRestartFixture): void => {
      writeFileSync(join(fixture.procRoot, "5252", "cmdline"), "unterminated");
    }],
    ["same-length candidate cmdline mismatch", (fixture: OfflineRestartFixture): void => {
      const path = join(fixture.procRoot, "5252", "cmdline");
      const content = readFileSync(path);
      const replacement = Buffer.from(content);
      replacement[0] = replacement[0] === 120 ? 121 : 120;
      writeFileSync(path, replacement);
    }],
    ["long candidate cmdline", (fixture: OfflineRestartFixture): void => {
      const path = join(fixture.procRoot, "5252", "cmdline");
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("x")]));
    }],
    ["oversized candidate stat", (fixture: OfflineRestartFixture): void => {
      writeFileSync(join(fixture.procRoot, "5252", "stat"), Buffer.alloc(16 * 1024 + 1, 32));
    }],
    ["missing candidate executable", (fixture: OfflineRestartFixture): void => {
      unlinkSync(join(fixture.procRoot, "5252", "exe"));
    }],
    ["missing candidate fd directory", (fixture: OfflineRestartFixture): void => {
      rmSync(join(fixture.procRoot, "5252", "fd"), { recursive: true, force: true });
    }],
    ["missing tcp table", (fixture: OfflineRestartFixture): void => {
      unlinkSync(join(fixture.procRoot, "net", "tcp"));
    }],
    ["malformed tcp6 table", (fixture: OfflineRestartFixture): void => {
      writeFileSync(join(fixture.procRoot, "net", "tcp6"), "malformed\n");
    }],
    ["oversized tcp table", (fixture: OfflineRestartFixture): void => {
      writeFileSync(
        join(fixture.procRoot, "net", "tcp"),
        Buffer.alloc(1024 * 1024 + 1, 32),
      );
    }],
    ["missing configured listener", (fixture: OfflineRestartFixture): void => {
      fixture.setLoopbackListener(false);
    }],
    ["missing user manager", (fixture: OfflineRestartFixture): void => {
      rmSync(join(fixture.procRoot, String(fixture.managerPid)), {
        recursive: true,
        force: true,
      });
    }],
    ["malformed user manager argv", (fixture: OfflineRestartFixture): void => {
      writeFileSync(
        join(fixture.procRoot, String(fixture.managerPid), "cmdline"),
        `${fixture.systemdExecutable}\0--system\0`,
      );
    }],
    ["missing user manager executable", (fixture: OfflineRestartFixture): void => {
      unlinkSync(join(fixture.procRoot, String(fixture.managerPid), "exe"));
    }],
    ["raw launch path drift", (fixture: OfflineRestartFixture): void => {
      const alias = join(fixture.root, "terminal-launch-alias");
      symlinkSync(fixture.entrypoint, alias);
      writeFileSync(
        join(fixture.procRoot, "5252", "cmdline"),
        `${process.execPath}\0${alias}\0daemon\0start\0--foreground\0`,
      );
    }],
    ["runtime digest drift", (fixture: OfflineRestartFixture): void => {
      writeFileSync(fixture.entrypoint, "terminal runtime drift\n");
    }],
  ] as const)(
    "refuses terminal publication after %s",
    async (_label: string, mutate: (fixture: OfflineRestartFixture) => void): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-terminal-physical-drift-");
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const boundaries: string[] = [];
      let exactRecoveryBytes = "";
      let signalCallsBefore = 0;
      const boundary: RecoveryBoundaryOverride = (phase: string): void => {
        boundaries.push(phase);
        if (phase === "before-record-cleanup") {
          exactRecoveryBytes = readFileSync(recordPath, "utf8");
        }
        if (phase !== "before-terminal-restart-publication") return;
        expect(existsSync(recordPath)).toBe(false);
        expect(existsSync(quarantinePath)).toBe(false);
        signalCallsBefore = fixture.killProcess.mock.calls.length;
        mutate(fixture);
      };

      const result = await restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: boundary,
      }));
      expect(result).toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("terminal callback-free replacement"),
      });

      expect(boundaries).toContain("after-replacement-readiness");
      expect(boundaries).toContain("before-terminal-restart-publication");
      expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsBefore);
      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
      expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
      expect(existsSync(recordPath)).toBe(false);
      if (existsSync(quarantinePath)) {
        expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
      } else {
        expect(result.warning).toContain("authority or durability is indeterminate");
      }
    },
  );

  it.each([
    ["candidate stat", (fixture: OfflineRestartFixture): string => (
      join(fixture.procRoot, "5252", "stat")
    ), 16 * 1024],
    ["tcp table", (fixture: OfflineRestartFixture): string => (
      join(fixture.procRoot, "net", "tcp")
    ), 1024 * 1024],
  ] as const)(
    "accepts a complete parseable %s at the exact dynamic-reader limit",
    async (
      _label: string,
      pathFor: (fixture: OfflineRestartFixture) => string,
      maximumBytes: number,
    ): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-terminal-dynamic-max-");
      const boundary: RecoveryBoundaryOverride = (phase: string): void => {
        if (phase !== "before-terminal-restart-publication") return;
        const path = pathFor(fixture);
        const content = readFileSync(path);
        expect(content.length).toBeLessThan(maximumBytes);
        const complete = Buffer.alloc(maximumBytes, 32);
        content.copy(complete);
        writeFileSync(path, complete);
      };

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: boundary,
      }))).resolves.toMatchObject({
        connected: true,
        restarted: true,
        pid: 5252,
      });

      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
      expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
    },
  );

  it("refuses without token access when both recovery leaves disappear during authorized health", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-authorized-health-missing-leaves-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const spawn = vi.fn(() => {
      void fixture.ensureReplacement();
      return makeSpawnChild(5252);
    }) as unknown as SpawnOverride;
    let removed = false;
    const fetch = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const response = await fixture.healthFetch(input);
      if (
        !removed
        && existsSync(join(fixture.procRoot, "5252"))
        && !String(input).endsWith("/stats/pool")
        && init?.headers === undefined
      ) {
        removed = true;
        rmSync(recordPath, { force: true });
        rmSync(quarantinePath, { force: true });
      }
      return response;
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnOverride: spawn,
      _fetchOverride: fetch,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("replacement readiness failed"),
    });

    expect(removed).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.some((call): boolean => call[1]?.headers !== undefined)).toBe(false);
    expect(fetch.mock.calls.some((call): boolean => String(call[0]).endsWith("/stats/pool")))
      .toBe(false);
  });

  it.each(["pid", "listener"] as const)(
    "refuses a canonical %s race before authorized token authentication",
    async (race): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-authorized-preauth-${race}-`);
      const spawn = vi.fn(() => {
        void fixture.ensureReplacement();
        return makeSpawnChild(5252);
      }) as unknown as SpawnOverride;
      let raced = false;
      const fetch = vi.fn(async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const response = await fixture.healthFetch(input);
        if (
          !raced
          && existsSync(join(fixture.procRoot, "5252"))
          && !String(input).endsWith("/stats/pool")
          && init?.headers === undefined
        ) {
          raced = true;
          if (race === "pid") writeFileSync(fixture.pidFile, "9999");
          else fixture.listenerPorts.mockReturnValue([]);
        }
        return response;
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _ensureDaemonOverride: undefined,
        _spawnOverride: spawn,
        _fetchOverride: fetch,
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
      });

      expect(raced).toBe(true);
      expect(fetch.mock.calls.some((call): boolean => call[1]?.headers !== undefined)).toBe(false);
      expect(fetch.mock.calls.some((call): boolean => String(call[0]).endsWith("/stats/pool")))
        .toBe(false);
      expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
    },
  );

  it("refuses a complete candidate race after authenticated health and before access", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-authorized-postauth-race-");
    const spawn = vi.fn(() => {
      void fixture.ensureReplacement();
      return makeSpawnChild(5252);
    }) as unknown as SpawnOverride;
    let raced = false;
    const fetch = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const response = await fixture.healthFetch(input);
      if (
        !raced
        && !String(input).endsWith("/stats/pool")
        && init?.headers !== undefined
      ) {
        return {
          ...response,
          json: async (): Promise<unknown> => {
            const body = await response.json();
            raced = true;
            writeFileSync(fixture.pidFile, "9999");
            return body;
          },
        } as Response;
      }
      return response;
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnOverride: spawn,
      _fetchOverride: fetch,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
    });

    expect(raced).toBe(true);
    expect(fetch.mock.calls.some((call): boolean => call[1]?.headers !== undefined)).toBe(true);
    expect(fetch.mock.calls.some((call): boolean => String(call[0]).endsWith("/stats/pool")))
      .toBe(false);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
  });

  it.each(["before-startup", "invalid-authorization", "changed-authorization"] as const)(
    "fails closed when recovery evidence changes at internal ensure boundary %s",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-authorized-race-${failure}-`);
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const spawn = vi.fn(() => makeSpawnChild(5252)) as unknown as SpawnOverride;
      const boundary = vi.fn((phase: string): void => {
        if (failure === "before-startup" && phase === "before-replacement-startup") {
          writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
        }
        if (phase === "before-authorized-ensure") {
          if (failure === "invalid-authorization") writeFileSync(recordPath, "{}\n");
          if (failure === "changed-authorization") {
            const bytes = readFileSync(recordPath);
            writeFileSync(recordPath, bytes);
          }
        }
      });
      const operation = restartDaemon(offlineRestartOptions(fixture, {
        _ensureDaemonOverride: undefined,
        _spawnOverride: spawn,
        _offlineRecoveryBoundaryOverride: boundary,
      }));

      if (failure === "before-startup") {
        await expect(operation).rejects.toThrow("evidence changed before replacement startup");
      } else {
        await expect(operation).rejects.toThrow("final replacement-startup boundary");
      }
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(recordPath)).toBe(true);
    },
  );

  it("fails bounded replacement authentication when the final deadline is exhausted", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-deadline-");
    let monotonicCalls = 0;
    const monotonic = vi.fn((): number => {
      monotonicCalls += 1;
      return monotonicCalls <= 3 ? 0 : 1_000;
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _monotonicNowOverride: monotonic,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("replacement could not be independently authenticated"),
    });

    expect(monotonicCalls).toBeGreaterThanOrEqual(4);
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
  });

  it("accepts graceful daemon-owned PID removal before replacement readiness", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-graceful-self-unlink-");
    await expect(restartDaemon(offlineRestartOptions(fixture))).resolves.toMatchObject({
      connected: true,
      restarted: true,
      stoppedPid: fixture.pid,
      pid: 5252,
    });

    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
    expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
  });

  it.each([
    "token",
    "runtime",
    "launch",
    "parent",
    "listener",
    "listener-unreadable",
    "birth",
    "scope",
    "abort",
    "abort-realpath",
    "abort-after-birth",
  ] as const)(
    "refuses post-absence %s drift before graceful replacement",
    async (
      drift: "token" | "runtime" | "launch" | "parent" | "listener" | "listener-unreadable" | "birth" | "scope" | "abort" | "abort-realpath" | "abort-after-birth",
    ): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-self-unlink-fence-");
      const controller = new AbortController();
      const launchAlias = join(fixture.root, "alternate-launch");
      symlinkSync(fixture.entrypoint, launchAlias);
      let driftApplied = false;
      let abortDuringRealpath = false;
      const applyDrift = vi.fn((): void => {
        driftApplied = true;
        if (drift === "token") driftOfflineStateFileTimestamp(fixture.tokenFile);
        if (drift === "runtime") writeFileSync(fixture.entrypoint, "changed runtime\n");
        if (drift === "launch") process.argv[1] = launchAlias;
        if (drift === "parent" || drift === "scope") chmodSync(fixture.root, 0o777);
        if (drift === "listener") fixture.setLoopbackListener(true);
        if (drift === "listener-unreadable") rmSync(join(fixture.procRoot, "net", "tcp6"));
        if (drift === "birth") fixture.writeProcess();
        if (drift === "abort" || drift === "abort-after-birth") controller.abort();
        if (drift === "abort-realpath") abortDuringRealpath = true;
      });
      const options = offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlinePreAbsentFenceOverride: applyDrift,
        _realpathOverride: (path: string): string => {
          if (abortDuringRealpath) {
            controller.abort();
            throw new Error("abort during launch realpath");
          }
          return realpathSync(path);
        },
      });
      const operation = restartDaemon(options);

      if (drift === "abort" || drift === "abort-realpath" || drift === "abort-after-birth") {
        await expect(operation).resolves.toMatchObject({
          connected: false,
          restarted: false,
          warning: expect.stringContaining("interrupted during offline restart recovery"),
        });
      } else {
        await expect(operation).rejects.toThrow("Offline restart recovery refused");
      }

      expect(driftApplied).toBe(true);
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(existsSync(fixture.pidFile)).toBe(false);
    },
  );

  it("accepts a direct canonical current launch with current UID proof", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-production-shaped-");
    const previousEntrypoint = process.argv[1];
    process.argv[1] = fixture.entrypoint;
    try {
      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _uid: undefined,
      }))).resolves.toMatchObject({
        connected: true,
        restarted: true,
        stoppedPid: fixture.pid,
      });
    } finally {
      process.argv[1] = previousEntrypoint;
    }
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
  });

  it("refuses an accepted lifecycle scope substituted between stopped fences", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-scope-fence-");
    const homeDir = fixture.root;
    const runtimeDir = join(homeDir, "runtime");
    const stateDir = join(homeDir, ".lcm");
    const credentialDir = join(homeDir, "credentials");
    for (const directory of [runtimeDir, stateDir, credentialDir]) mkdirSync(directory);
    const pidPath = join(stateDir, "daemon.pid");
    const tokenPath = join(stateDir, "daemon.token");
    renameSync(fixture.pidFile, pidPath);
    renameSync(fixture.tokenFile, tokenPath);
    let alive = true;
    const fetch = vi.fn().mockRejectedValue(new Error("scoped daemon is wedged"));
    const spawnProcess = vi.fn();
    const runSystemd = vi.fn();
    const stopUnit = vi.fn();
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal !== "SIGTERM") return;
      alive = false;
      rmSync(fixture.procPidDir, { recursive: true, force: true });
      unlinkSync(pidPath);
    });
    const scope = createDaemonLifecycleTestScope({
      ownerId: "offline-scope-fence",
      homeDir,
      runtimeDir,
      stateDir,
      credentialDir,
      entrypoint: fixture.entrypoint,
      dependencies: {
        fetch: fetch as never,
        spawn: spawnProcess as never,
        spawnSync: runSystemd as never,
        stopUnit,
        killProcess,
        isProcessAlive: candidate => candidate === fixture.pid && alive,
        sleep: async () => undefined,
      },
    });
    fixture.writeProcess({
      argv: [
        process.execPath,
        scope.entrypoint,
        "daemon",
        "start",
        "--foreground",
        ...daemonLifecycleTestIdentityArgs(scope),
      ],
    });
    const movedStateDir = join(homeDir, ".lcm-substituted-original");
    const substituteScope = vi.fn((): void => {
      renameSync(stateDir, movedStateDir);
      mkdirSync(stateDir, { mode: 0o700 });
    });

    await expect(restartDaemonProduction(offlineRestartOptions(fixture, {
      pidFilePath: pidPath,
      _testScope: scope,
      _offlineScopedListenerStateOverride: (): "absent" => "absent",
      _offlinePreAbsentFenceOverride: substituteScope,
    }))).rejects.toThrow("Offline restart recovery refused");

    expect(substituteScope).toHaveBeenCalledOnce();
    expect(killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(join(movedStateDir, "daemon.token"), "utf8")).toBe("local-token");
    expect(readdirSync(stateDir)).toEqual([]);
    expect(stopUnit).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(runSystemd).not.toHaveBeenCalled();
  });

  it("refuses a hermetic proc root physically outside its snapshotted home before signaling", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-proc-outside-home-");
    const outsideContainer = mkdtempSync(join(tmpdir(), "lcm-offline-external-proc-"));
    tempDirs.push(outsideContainer);
    const outsideProcRoot = join(outsideContainer, "proc");
    renameSync(fixture.procRoot, outsideProcRoot);
    const options = withHermeticLifecycleSeams(offlineRestartOptions(fixture, {
      _procRoot: outsideProcRoot,
    }), {
      procRoot: outsideProcRoot,
    }) as RestartDaemonOptions;

    await expect(restartDaemonProduction(options)).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("hermetic test seams are incomplete or malformed"),
    });

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(false);
    expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
    expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
  });

  it("refuses production-shaped offline recovery when the current UID is unavailable", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-no-current-uid-");
    const previousEntrypoint = process.argv[1];
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    const options = offlineRestartOptions(fixture, { _uid: undefined });
    process.argv[1] = fixture.entrypoint;
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      await expect(restartDaemonProduction(options)).rejects.toThrow("not a verified LCM daemon");
    } finally {
      process.argv[1] = previousEntrypoint;
      if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
    }
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("proves offline listener ownership through run-owned Linux procfs", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-proc-listener-");
    const fdDir = join(fixture.procPidDir, "fd");
    const netDir = join(fixture.procRoot, "net");
    mkdirSync(fdDir);
    symlinkSync("socket:[12345]", join(fdDir, "7"));
    writeFileSync(join(netDir, "tcp"), [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:4E1F 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000001 100 0 0 10 0",
      "   1: 0200007F:4E20 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000000000000002 100 0 0 10 0",
      "",
    ].join("\n"));
    writeFileSync(join(netDir, "tcp6"), "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n");

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _listeningPortsOverride: undefined,
    }))).resolves.toMatchObject({
      connected: true,
      restarted: true,
      stoppedPid: fixture.pid,
    });
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
  });

  it("revalidates the complete fingerprint before escalating an offline restart to SIGKILL", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-kill-");
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });

    const result = await restartDaemon(offlineRestartOptions(fixture));

    expect(result.restarted).toBe(true);
    expect(fixture.killProcess.mock.calls).toEqual([
      [fixture.pid, "SIGTERM"],
      [fixture.pid, "SIGKILL"],
    ]);
    expect(fixture.listenerPorts.mock.calls.length).toBeGreaterThanOrEqual(7);
  });

  it.each([
    {
      label: "error status",
      response: { ok: false, status: 500, json: async () => ({}) },
    },
    {
      label: "malformed body",
      response: { ok: true, status: 200, json: async () => ({ status: 42 }) },
    },
    {
      label: "unreadable body",
      response: { ok: true, status: 200, json: async () => { throw new Error("bad json"); } },
    },
    {
      label: "unauthorized response",
      response: { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) },
    },
  ])("refuses offline recovery after any public HTTP response: $label", async ({ response }) => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-response-");

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _fetchOverride: vi.fn().mockResolvedValue(response as Response),
    }))).rejects.toThrow("not a verified LCM daemon");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe(String(fixture.pid));
  });

  it("refuses an online identity response when its owned token is missing", async () => {
    const fixture = createOfflineRestartFixture("lcm-online-restart-missing-token-");
    rmSync(fixture.tokenFile, { force: true });
    const fetch = vi.fn(async (): Promise<Response> => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "1.4.2",
        storageBackend: "sqlite",
        pid: fixture.pid,
        entrypoint: fixture.entrypoint,
        runtimeDigest: fixture.runtimeDigest,
      }),
    } as Response));

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _fetchOverride: fetch,
    }))).rejects.toThrow("not a verified LCM daemon");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.killProcess).not.toHaveBeenCalled();
  });

  it("refuses online restart when the access-probe deadline is exhausted", async () => {
    const fixture = createOfflineRestartFixture("lcm-online-restart-access-deadline-");
    let monotonicCalls = 0;
    const fetch = vi.fn(async (): Promise<Response> => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "1.4.2",
        storageBackend: "sqlite",
        pid: fixture.pid,
        entrypoint: fixture.entrypoint,
        runtimeDigest: fixture.runtimeDigest,
      }),
    } as Response));

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _fetchOverride: fetch,
      _monotonicNowOverride: (): number => {
        monotonicCalls += 1;
        return monotonicCalls >= 4 ? 100 : 0;
      },
    }))).rejects.toThrow("not a verified LCM daemon");
    expect(monotonicCalls).toBeGreaterThanOrEqual(4);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fixture.killProcess).not.toHaveBeenCalled();
  });

  it("refuses offline recovery when public identity is recognized but authentication fails", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-auth-");
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          version: "1.4.2",
          storageBackend: "sqlite",
          pid: fixture.pid,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: "unauthorized" }),
      } as Response);

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      expectedVersion: "1.4.2",
      _fetchOverride: fetch,
    }))).rejects.toThrow("not a verified LCM daemon");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fixture.killProcess).not.toHaveBeenCalled();
  });

  it("does not report an offline restart when replacement readiness fails", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-readiness-");
    fixture.ensureReplacement.mockResolvedValueOnce({
      connected: false,
      port: 19999,
      spawned: true,
      warning: "replacement unavailable",
    });

    await expect(restartDaemon(offlineRestartOptions(fixture))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      stoppedPid: fixture.pid,
      warning: expect.stringContaining("replacement readiness failed: replacement unavailable"),
    });
  });

  it("reports offline replacement readiness failure without an underlying warning", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-readiness-empty-");
    fixture.ensureReplacement.mockResolvedValueOnce({
      connected: false,
      port: 19999,
      spawned: true,
    });

    await expect(restartDaemon(offlineRestartOptions(fixture))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      stoppedPid: fixture.pid,
      warning: `offline restart stopped PID ${fixture.pid}, but replacement readiness failed`,
    });
  });

  it("refuses a connected offline replacement that omits its authenticated PID", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-readiness-missing-pid-");
    fixture.ensureReplacement.mockResolvedValueOnce({
      connected: true,
      port: 19999,
      spawned: true,
    });

    await expect(restartDaemon(offlineRestartOptions(fixture))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      stoppedPid: fixture.pid,
      warning: expect.stringContaining("recovery record or replacement PID is unavailable"),
    });
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
  });

  it("refuses terminal publication when readiness reports a different listener port", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-readiness-port-mismatch-");
    const ensureReplacement = fixture.ensureReplacement.getMockImplementation();
    if (!ensureReplacement) throw new Error("offline replacement implementation is unavailable");
    fixture.ensureReplacement.mockImplementationOnce(async () => ({
      ...await ensureReplacement(),
      port: 20000,
    }));

    await expect(restartDaemon(offlineRestartOptions(fixture))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("terminal callback-free replacement"),
    });
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
  });

  it("recognizes an exact backup before restoring authority for an unpublishable seed", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-seed-existing-backup-");
    const ensureReplacement = fixture.ensureReplacement.getMockImplementation();
    if (!ensureReplacement) throw new Error("offline replacement implementation is unavailable");
    fixture.ensureReplacement.mockImplementationOnce(async () => ({
      ...await ensureReplacement(),
      port: 20000,
    }));
    let finalCleanupArmed = false;
    let finalFsyncFailures = 0;

    const result = await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-final-backup-cleanup") finalCleanupArmed = true;
      },
      _offlineFsyncOverride: (descriptor: number): void => {
        if (finalCleanupArmed && finalFsyncFailures === 0) {
          finalFsyncFailures += 1;
          throw new Error("synthetic final backup durability uncertainty");
        }
        fsyncSync(descriptor);
      },
    }));

    expect(finalFsyncFailures).toBe(1);
    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("exact durable recovery backup"),
    });
  });

  it("refuses authority restoration when an untrusted marker appears during seed capture", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-seed-marker-race-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const replacementDirectory = join(fixture.procRoot, "5252");
    const replacementFd = join(fixture.procRoot, "5252", "fd");
    const originalOpen = nodeFs.openSync;
    let mutated = false;
    const open = vi.spyOn(nodeFs, "openSync").mockImplementation((path, flags, mode): number => {
      if (
        !mutated
        && String(path) === replacementDirectory
        && !existsSync(recordPath)
        && !existsSync(quarantinePath)
      ) {
        mutated = true;
        mkdirSync(recordPath);
        rmSync(replacementFd, { recursive: true, force: true });
      }
      return originalOpen(path, flags, mode);
    });
    syncBuiltinESMExports();
    let result: RestartDaemonResult;

    try {
      result = await restartDaemon(offlineRestartOptions(fixture));
    } finally {
      open.mockRestore();
      syncBuiltinESMExports();
    }

    expect(mutated).toBe(true);
    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("authority or durability is indeterminate"),
    });
    expect(lstatSync(recordPath).isDirectory()).toBe(true);
  });

  it.each([
    ["malformed birth stat", (fixture: OfflineRestartFixture): void => {
      writeFileSync(join(fixture.procRoot, "5252", "stat"), "5252 malformed\n");
    }],
    ["missing birth start", (fixture: OfflineRestartFixture): void => {
      writeFileSync(join(fixture.procRoot, "5252", "stat"), "5252 (node) S\n");
    }],
    ["missing candidate status", (fixture: OfflineRestartFixture): void => {
      unlinkSync(join(fixture.procRoot, "5252", "status"));
    }],
    ["missing parent field", (fixture: OfflineRestartFixture): void => {
      const uid = String(process.getuid());
      writeFileSync(
        join(fixture.procRoot, "5252", "status"),
        `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
      );
    }],
    ["missing parent executable", (fixture: OfflineRestartFixture): void => {
      unlinkSync(join(fixture.procRoot, String(fixture.managerPid), "exe"));
    }],
    ["malformed parent argv", (fixture: OfflineRestartFixture): void => {
      writeFileSync(
        join(fixture.procRoot, String(fixture.managerPid), "cmdline"),
        `${fixture.systemdExecutable}\0`,
      );
    }],
    ["unowned listener directory", (fixture: OfflineRestartFixture): void => {
      chmodSync(join(fixture.procRoot, "5252", "fd"), 0o777);
    }],
    ["unsafe tcp table", (fixture: OfflineRestartFixture): void => {
      chmodSync(join(fixture.procRoot, "net", "tcp"), 0o666);
    }],
    ["malformed tcp header", (fixture: OfflineRestartFixture): void => {
      writeFileSync(join(fixture.procRoot, "net", "tcp"), "malformed header\n");
    }],
    ["relative launch path", (): void => {
      process.argv[1] = "relative-lcm.mjs";
    }],
    ["missing candidate executable", (fixture: OfflineRestartFixture): void => {
      unlinkSync(join(fixture.procRoot, "5252", "exe"));
    }],
  ] as const)(
    "fails terminal seed capture after callback-free direct proof gets %s",
    async (_scenario, mutate): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-terminal-seed-direct-proof-");
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const replacementDirectory = join(fixture.procRoot, "5252");
      const originalOpen = nodeFs.openSync;
      let mutated = false;
      const open = vi.spyOn(nodeFs, "openSync").mockImplementation((path, flags, mode): number => {
        if (
          !mutated
          && String(path) === replacementDirectory
          && !existsSync(recordPath)
          && !existsSync(quarantinePath)
        ) {
          mutated = true;
          mutate(fixture);
        }
        return originalOpen(path, flags, mode);
      });
      syncBuiltinESMExports();
      let result: RestartDaemonResult;

      try {
        result = await restartDaemon(offlineRestartOptions(fixture));
      } finally {
        open.mockRestore();
        syncBuiltinESMExports();
      }

      expect(mutated).toBe(true);
      expect(result).toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("terminal callback-free replacement"),
      });
    },
  );

  it.each(["launch disappears", "raw launch alias"] as const)(
    "fails terminal seed capture when the %s after direct proof",
    async (scenario): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-terminal-seed-late-${scenario.replaceAll(" ", "-")}-`,
      );
      const parentCmdline = join(
        fixture.procRoot,
        String(fixture.managerPid),
        "cmdline",
      );
      const launchAlias = join(fixture.root, "late-terminal-launch-alias");
      if (scenario === "raw launch alias") symlinkSync(fixture.entrypoint, launchAlias);
      const originalClose = nodeFs.closeSync;
      let mutated = false;
      const close = vi.spyOn(nodeFs, "closeSync").mockImplementation((descriptor): void => {
        let target: string | undefined;
        try {
          target = readlinkSync(`/proc/self/fd/${String(descriptor)}`);
        } catch {
          target = undefined;
        }
        originalClose(descriptor);
        if (
          !mutated
          && target === parentCmdline
          && new Error().stack?.includes("captureTerminalRecoveryAuthoritySeed") === true
        ) {
          mutated = true;
          if (scenario === "launch disappears") unlinkSync(fixture.entrypoint);
          else process.argv[1] = launchAlias;
        }
      });
      syncBuiltinESMExports();
      let result: RestartDaemonResult;
      try {
        result = await restartDaemon(offlineRestartOptions(fixture));
      } finally {
        close.mockRestore();
        syncBuiltinESMExports();
      }

      expect(mutated).toBe(true);
      expect(result).toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("terminal callback-free replacement"),
      });
    },
  );

  it("refuses a parent birth drift during the final direct parent reread", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-parent-birth-race-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const parentStat = join(fixture.procRoot, String(fixture.managerPid), "stat");
    const originalClose = nodeFs.closeSync;
    let mutated = false;
    const close = vi.spyOn(nodeFs, "closeSync").mockImplementation((descriptor): void => {
      let target: string | undefined;
      try {
        target = readlinkSync(`/proc/self/fd/${String(descriptor)}`);
      } catch {
        target = undefined;
      }
      originalClose(descriptor);
      if (
        !mutated
        && target === parentStat
        && !existsSync(recordPath)
        && !existsSync(quarantinePath)
      ) {
        mutated = true;
        writeFileSync(parentStat, readFileSync(parentStat, "utf8").replace("313131", "313132"));
      }
    });
    syncBuiltinESMExports();
    let result: RestartDaemonResult;

    try {
      result = await restartDaemon(offlineRestartOptions(fixture));
    } finally {
      close.mockRestore();
      syncBuiltinESMExports();
    }

    expect(mutated).toBe(true);
    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("terminal callback-free replacement"),
    });
  });

  it("refuses replacement-fd ownership changed after direct candidate capture", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-fd-post-direct-race-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const replacementDirectory = join(fixture.procRoot, "5252");
    const replacementFd = join(replacementDirectory, "fd");
    const originalClose = nodeFs.closeSync;
    let processDirectoryCloses = 0;
    let mutated = false;
    const close = vi.spyOn(nodeFs, "closeSync").mockImplementation((descriptor): void => {
      let target: string | undefined;
      try {
        target = readlinkSync(`/proc/self/fd/${String(descriptor)}`);
      } catch {
        target = undefined;
      }
      originalClose(descriptor);
      if (
        target !== replacementDirectory
        || existsSync(recordPath)
        || existsSync(quarantinePath)
      ) return;
      processDirectoryCloses += 1;
      if (processDirectoryCloses === 2) {
        mutated = true;
        chmodSync(replacementFd, 0o777);
      }
    });
    syncBuiltinESMExports();
    let result: RestartDaemonResult;

    try {
      result = await restartDaemon(offlineRestartOptions(fixture));
    } finally {
      close.mockRestore();
      syncBuiltinESMExports();
    }

    expect(processDirectoryCloses).toBe(2);
    expect(mutated).toBe(true);
    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("terminal callback-free replacement"),
    });
  });

  it.each([
    [1, "replacement entrypoint proof"],
    [2, "scope entrypoint proof"],
  ] as const)(
    "refuses entrypoint drift after %s capture",
    async (mutationClose): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-terminal-entrypoint-close-${String(mutationClose)}-`,
      );
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const originalClose = nodeFs.closeSync;
      let entrypointCloses = 0;
      let mutated = false;
      const close = vi.spyOn(nodeFs, "closeSync").mockImplementation((descriptor): void => {
        let target: string | undefined;
        try {
          target = readlinkSync(`/proc/self/fd/${String(descriptor)}`);
        } catch {
          target = undefined;
        }
        originalClose(descriptor);
        if (
          target !== fixture.entrypoint
          || !existsSync(join(fixture.procRoot, "5252"))
          || existsSync(recordPath)
          || existsSync(quarantinePath)
        ) return;
        entrypointCloses += 1;
        if (entrypointCloses === mutationClose) {
          mutated = true;
          const content = readFileSync(fixture.entrypoint);
          const replacement = Buffer.from(content);
          replacement[0] = replacement[0] === 120 ? 121 : 120;
          writeFileSync(fixture.entrypoint, replacement);
        }
      });
      syncBuiltinESMExports();
      let result: RestartDaemonResult;

      try {
        result = await restartDaemon(offlineRestartOptions(fixture));
      } finally {
        close.mockRestore();
        syncBuiltinESMExports();
      }

      expect(entrypointCloses).toBeGreaterThanOrEqual(mutationClose);
      expect(mutated).toBe(true);
      expect(result).toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("terminal callback-free replacement"),
      });
    },
  );

  it("refuses final replacement publication when its public health probe has no response", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-health-no-response-");
    const fetch = vi.fn(async (): Promise<Response> => {
      throw new Error("synthetic no-response outcome");
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _fetchOverride: fetch,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("replacement could not be independently authenticated"),
    });
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalled();
  });

  it("refuses a replacement proof changed immediately after final public health", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-public-health-race-");
    const baseFetch = fixture.healthFetch.getMockImplementation();
    if (!baseFetch) throw new Error("offline fixture health implementation is unavailable");
    let mutated = false;
    const fetch = vi.fn(async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const response = await baseFetch(input);
      if (
        !mutated
        && existsSync(join(fixture.procRoot, "5252"))
        && !String(input).endsWith("/stats/pool")
      ) {
        mutated = true;
        chmodSync(fixture.tokenFile, 0o640);
      }
      return response;
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _fetchOverride: fetch,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("replacement could not be independently authenticated"),
    });
    expect(mutated).toBe(true);
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
  });

  it("refuses a quarantine role changed between final candidate captures", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-quarantine-kind-race-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let armed = false;
    let candidateListenerCalls = 0;
    let recoveryBytes = "";
    fixture.listenerPorts.mockImplementation((candidate?: number): number[] => {
      if (armed && candidate === 5252) {
        candidateListenerCalls += 1;
        if (candidateListenerCalls === 2) {
          writeFileSync(quarantinePath, recoveryBytes, { mode: 0o600 });
        }
      }
      return [19999];
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase !== "after-replacement-readiness") return;
        recoveryBytes = readFileSync(recordPath, "utf8");
        armed = true;
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("replacement could not be independently authenticated"),
    });
    expect(candidateListenerCalls).toBe(2);
    expect(readFileSync(quarantinePath, "utf8")).toBe(recoveryBytes);
  });

  it("observes cancellation at the first final authorized-candidate capture", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-candidate-abort-");
    const controller = new AbortController();
    let armed = false;
    let armedAbortReads = 0;
    const signal = new Proxy(controller.signal, {
      get: (target, property): unknown => {
        if (property === "aborted" && armed) {
          armedAbortReads += 1;
          if (armedAbortReads >= 2) {
            controller.abort();
            return true;
          }
          return false;
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: signal,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-replacement-readiness") armed = true;
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("recovery finalization was interrupted"),
    });
    expect(armedAbortReads).toBeGreaterThanOrEqual(2);
  });

  it("refuses cancellation observed by the final stopped-state validator", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-validate-stopped-abort-");
    const controller = new AbortController();
    let validatePhase = false;
    let validateAbortObserved = false;
    const signal = new Proxy(controller.signal, {
      get: (target, property): unknown => {
        if (
          property === "aborted"
          && validatePhase
          && new Error().stack?.includes("validateStopped") === true
        ) {
          validateAbortObserved = true;
          controller.abort();
          return true;
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: signal,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-authorized-ensure") validatePhase = true;
      },
    }))).rejects.toThrow("evidence changed at the final replacement-startup boundary");
    expect(validateAbortObserved).toBe(true);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it.each([
    [1, "daemon restart recovery authorization changed"],
    [2, "authorization changed immediately before replacement startup"],
    [3, "authorization changed at the final spawn boundary"],
  ] as const)(
    "refuses authorized startup when stopped-state validation %i changes",
    async (targetValidation, expectedWarning): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-authorized-stopped-validation-${String(targetValidation)}-`,
      );
      const controller = new AbortController();
      let ensureValidationReads = 0;
      const signal = new Proxy(controller.signal, {
        get: (target, property): unknown => {
          const stack = new Error().stack?.split("\n") ?? [];
          if (
            property === "aborted"
            && stack[2]?.includes("validateStopped") === true
            && stack.some(frame => frame.includes("ensureDaemonImpl"))
          ) {
            ensureValidationReads += 1;
            return ensureValidationReads === targetValidation;
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: signal,
        _ensureDaemonOverride: undefined,
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining(expectedWarning),
      });

      expect(ensureValidationReads).toBe(targetValidation);
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it.each([
    [1, "initial candidate validation", "replacement could not be independently authenticated"],
    [2, "pre-token candidate validation", "replacement could not be independently authenticated"],
    [3, "token-read candidate validation", "replacement could not be independently authenticated"],
    [4, "bound token-reader validation", "replacement could not be independently authenticated"],
    [5, "authenticated health candidate validation", "replacement could not be independently authenticated"],
    [6, "access candidate validation", "replacement could not be independently authenticated"],
    [7, "final authenticated candidate validation", "replacement could not be independently authenticated"],
    [8, "post-authentication candidate validation", "recovery evidence changed across finalization"],
  ] as const)(
    "refuses replacement drift during %s",
    async (mutationCall, _label, expectedWarning): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-final-candidate-call-${String(mutationCall)}-`);
      let armed = false;
      let candidateListenerCalls = 0;
      fixture.listenerPorts.mockImplementation((candidate?: number): number[] => {
        if (armed && candidate === 5252) {
          candidateListenerCalls += 1;
          if (candidateListenerCalls === mutationCall) chmodSync(fixture.tokenFile, 0o640);
        }
        return [19999];
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "after-replacement-readiness") armed = true;
        },
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining(expectedWarning),
      });
      expect(candidateListenerCalls).toBe(mutationCall);
    },
  );

  it("revalidates the authorized candidate after reading its bound token", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-authorized-candidate-token-read-race-",
    );
    const originalRead = nodeFs.readSync;
    let mutated = false;
    try {
      nodeFs.readSync = ((...args: Parameters<typeof nodeFs.readSync>): number => {
        const bytesRead = Reflect.apply(originalRead, nodeFs, args) as number;
        if (
          !mutated
          && new Error().stack?.includes("readTokenBoundToOfflineProof") === true
          && readlinkSync(`/proc/self/fd/${String(args[0])}`) === fixture.tokenFile
        ) {
          mutated = true;
          fixture.listenerPorts.mockReturnValue([]);
        }
        return bytesRead;
      }) as typeof nodeFs.readSync;
      syncBuiltinESMExports();

      await expect(restartDaemon(offlineRestartOptions(fixture))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("replacement could not be independently authenticated"),
      });
    } finally {
      nodeFs.readSync = originalRead;
      syncBuiltinESMExports();
    }

    expect(mutated).toBe(true);
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
  });

  it("refuses a candidate changed at the bound-token reader entry", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-authorized-bound-token-reader-race-",
    );
    const initialStackTraceLimit = Error.stackTraceLimit;
    let refusedAtTokenReader = false;
    const spawnReplacement = vi.fn(() => {
      void fixture.ensureReplacement();
      return makeSpawnChild(5252);
    }) as unknown as SpawnOverride;
    fixture.listenerPorts.mockImplementation((candidate?: number): number[] => {
      if (
        candidate === 5252
        && new Error().stack?.includes("readCandidateToken") === true
      ) {
        refusedAtTokenReader = true;
        return [];
      }
      return [19999];
    });

    try {
      Error.stackTraceLimit = 100;
      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _ensureDaemonOverride: undefined,
        _spawnOverride: spawnReplacement,
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("replacement readiness failed"),
      });
    } finally {
      Error.stackTraceLimit = initialStackTraceLimit;
    }

    expect(refusedAtTokenReader).toBe(true);
    expect(spawnReplacement).toHaveBeenCalledOnce();
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
  });

  it("revalidates the candidate after canonicalizing authenticated health", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-authorized-health-canonicalization-race-",
    );
    let mutated = false;
    let postAccessCandidateProof: "pending" | "first-listener" | "complete" | undefined;
    const spawnReplacement = vi.fn(() => {
      void fixture.ensureReplacement();
      return makeSpawnChild(5252);
    }) as unknown as SpawnOverride;
    fixture.listenerPorts.mockImplementation((candidate?: number): number[] => {
      if (candidate === 5252 && postAccessCandidateProof === "pending") {
        postAccessCandidateProof = "first-listener";
      } else if (candidate === 5252 && postAccessCandidateProof === "first-listener") {
        postAccessCandidateProof = "complete";
      }
      return [19999];
    });
    const fetchReplacement = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const response = await fixture.healthFetch(input);
      if (init?.headers !== undefined && String(input).endsWith("/stats/pool")) {
        postAccessCandidateProof = "pending";
      }
      return response;
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnOverride: spawnReplacement,
      _fetchOverride: fetchReplacement,
      _realpathOverride: (path: string): string => {
        const canonicalPath = realpathSync(path);
        if (
          !mutated
          && path === fixture.entrypoint
          && postAccessCandidateProof === "complete"
        ) {
          mutated = true;
          fixture.listenerPorts.mockReturnValue([]);
        }
        return canonicalPath;
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("replacement readiness failed"),
    });

    expect(mutated).toBe(true);
    expect(postAccessCandidateProof).toBe("complete");
    expect(spawnReplacement).toHaveBeenCalledOnce();
  });

  it("allows only the explicit wrong-parent outcome from authorized inspection", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-authorized-wrong-parent-outcome-",
    );
    const alternateManagerPid = 4141;
    let changedManager = false;
    const runSystemd = vi.fn((): ReturnType<typeof spawnSync> => {
      void fixture.ensureReplacement();
      return { status: 0, signal: null, stdout: "", stderr: "", pid: 1, output: [] };
    }) as unknown as SpawnSyncOverride;

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnSyncOverride: runSystemd,
      enforceUserManagerParent: true,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase !== "during-authorized-parent-inspection" || changedManager) return;
        changedManager = true;
        writeFileSync(
          join(fixture.procRoot, String(fixture.managerPid), "cmdline"),
          `${fixture.systemdExecutable}\0--system\0`,
        );
        const alternateDirectory = join(fixture.procRoot, String(alternateManagerPid));
        mkdirSync(alternateDirectory);
        const uid = String(process.getuid());
        writeFileSync(
          join(alternateDirectory, "status"),
          `Name:\tsystemd\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nPPid:\t1\n`,
        );
        writeFileSync(
          join(alternateDirectory, "cmdline"),
          `${fixture.systemdExecutable}\0--user\0`,
        );
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("replacement readiness failed"),
    });

    expect(changedManager).toBe(true);
    expect(runSystemd).toHaveBeenCalledOnce();
  });

  it("refuses an unexpected authorized parent outcome", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-authorized-unexpected-parent-outcome-",
    );
    let refusedParentBirth = false;
    const runSystemd = vi.fn((): ReturnType<typeof spawnSync> => {
      void fixture.ensureReplacement();
      return { status: 0, signal: null, stdout: "", stderr: "", pid: 1, output: [] };
    }) as unknown as SpawnSyncOverride;
    const result = await restartDaemon(offlineRestartOptions(fixture, {
      _ensureDaemonOverride: undefined,
      _spawnSyncOverride: runSystemd,
      enforceUserManagerParent: true,
      _offlineRecoveryBoundaryOverride: (phase): void => {
        if (phase !== "before-authorized-parent-inspection" || refusedParentBirth) return;
        refusedParentBirth = true;
        unlinkSync(join(fixture.procRoot, "5252", "stat"));
      },
    }));

    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("replacement readiness failed"),
    });
    expect(refusedParentBirth).toBe(true);
    expect(runSystemd).toHaveBeenCalledOnce();
  });

  it.each([
    ["after-quarantine-cleanup", "replacement evidence changed during quarantine cleanup"],
    ["before-final-backup-create", "replacement changed before backup creation"],
    ["after-final-backup-create", "replacement changed during backup creation"],
  ] as const)(
    "refuses replacement-state drift at finalization boundary %s",
    async (failureBoundary, expectedWarning): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-finalization-drift-${failureBoundary}-`,
      );
      if (failureBoundary === "after-quarantine-cleanup") {
        fixture.killProcess.mockImplementation(
          (_pid: number, signal?: NodeJS.Signals | number): void => {
            if (signal === "SIGKILL") fixture.removeProcess();
          },
        );
      }
      let mutated = false;

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase !== failureBoundary) return;
          mutated = true;
          chmodSync(fixture.tokenFile, 0o640);
        },
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining(expectedWarning),
      });
      expect(mutated).toBe(true);
      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    },
  );

  it("retains record authority when final recovery-backup creation fails", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-backup-create-failure-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let finalBackupArmed = false;

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-final-backup-create") finalBackupArmed = true;
      },
      _offlineRecordOpenOverride: (path: string, flags: number, mode?: number): number => {
        if (finalBackupArmed && path === quarantinePath) {
          throw new Error("synthetic final backup create failure");
        }
        return openSync(path, flags, mode);
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("recovery backup creation failed"),
    });
    expect(finalBackupArmed).toBe(true);
  });

  it("refuses replacement drift after the record-cleanup seam", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-record-cleanup-seam-drift-");
    let mutated = false;

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecordUnlinkOverride: (): void => {
        mutated = true;
        chmodSync(fixture.tokenFile, 0o640);
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("recovery record cleanup failed"),
    });
    expect(mutated).toBe(true);
  });

  it.each([
    ["backup", "recovery backup authority changed"],
    ["replacement", "replacement changed after record cleanup"],
  ] as const)(
    "refuses %s drift after exact record cleanup",
    async (drift, expectedWarning): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-after-record-cleanup-${drift}-`);
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase !== "after-record-cleanup") return;
          if (drift === "backup") {
            writeFileSync(quarantinePath, `${readFileSync(quarantinePath, "utf8")} `);
          } else {
            chmodSync(fixture.tokenFile, 0o640);
          }
        },
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining(expectedWarning),
      });
    },
  );

  it("refuses replacement drift after the final backup-cleanup seam", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-backup-seam-drift-");
    let backupCleanupCalls = 0;

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBackupUnlinkOverride: (): void => {
        backupCleanupCalls += 1;
        if (backupCleanupCalls === 2) chmodSync(fixture.tokenFile, 0o640);
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("final recovery backup cleanup failed"),
    });
    expect(backupCleanupCalls).toBe(2);
  });

  it("reports a refused final held-backup unlink with exact backup authority", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-held-backup-refusal-");
    const procFdRoot = join(fixture.root, "proc-self-fd");
    symlinkSync("/proc/self/fd", procFdRoot, "dir");
    let removedAnchor = false;

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineProcSelfFdRootOverride: procFdRoot,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase !== "before-final-backup-cleanup") return;
        unlinkSync(procFdRoot);
        removedAnchor = true;
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("anchored unlink proof failed before the syscall"),
    });
    expect(removedAnchor).toBe(true);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(true);
  });

  it("reports backup authority after exact record unlink loses durability", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-record-unlink-undurable-");
    let recordCleanupArmed = false;
    let injectedFsyncFailures = 0;

    const result = await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-record-cleanup") recordCleanupArmed = true;
      },
      _offlineFsyncOverride: (descriptor: number): void => {
        if (recordCleanupArmed && injectedFsyncFailures === 0) {
          injectedFsyncFailures += 1;
          throw new Error("synthetic record-unlink durability failure");
        }
        fsyncSync(descriptor);
      },
    }));

    expect(injectedFsyncFailures).toBe(1);
    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("exact durable recovery authority remains"),
    });
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(false);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(true);
  });

  it("refuses a final recovery backup changed by its cleanup seam", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-final-backup-content-race-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let backupCleanupCalls = 0;

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBackupUnlinkOverride: (): void => {
        backupCleanupCalls += 1;
        if (backupCleanupCalls === 2) {
          writeFileSync(quarantinePath, `${readFileSync(quarantinePath, "utf8")} `);
        }
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("final recovery backup cleanup failed"),
    });
    expect(backupCleanupCalls).toBe(2);
  });

  it("reports indeterminate authority when terminal seed backup restoration cannot open", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-terminal-seed-restore-open-failure-");
    const ensureReplacement = fixture.ensureReplacement.getMockImplementation();
    if (!ensureReplacement) throw new Error("offline replacement implementation is unavailable");
    fixture.ensureReplacement.mockImplementationOnce(async () => ({
      ...await ensureReplacement(),
      port: 20000,
    }));
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let restoreOpenRefused = false;
    let terminalRestoreArmed = false;

    const result = await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-final-backup-cleanup") terminalRestoreArmed = true;
      },
      _offlineRecordOpenOverride: (path: string, flags: number, mode?: number): number => {
        if (
          terminalRestoreArmed
          && path === quarantinePath
          && !existsSync(recordPath)
          && !existsSync(quarantinePath)
        ) {
          restoreOpenRefused = true;
          throw new Error("synthetic terminal-seed backup restoration refusal");
        }
        return openSync(path, flags, mode);
      },
    }));

    expect(restoreOpenRefused).toBe(true);
    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("authority or durability is indeterminate"),
    });
  });

  it("combines replacement and cleanup warnings after restored final-backup authority", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-combined-final-warning-");
    const ensureReplacement = fixture.ensureReplacement.getMockImplementation();
    if (!ensureReplacement) throw new Error("offline replacement implementation is unavailable");
    fixture.ensureReplacement.mockImplementationOnce(async () => ({
      ...await ensureReplacement(),
      warning: "synthetic replacement warning",
    }));
    let finalCleanupArmed = false;
    let finalFsyncFailures = 0;

    const result = await restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-final-backup-cleanup") finalCleanupArmed = true;
      },
      _offlineFsyncOverride: (descriptor: number): void => {
        if (finalCleanupArmed && finalFsyncFailures === 0) {
          finalFsyncFailures += 1;
          throw new Error("synthetic final-backup durability uncertainty");
        }
        fsyncSync(descriptor);
      },
    }));

    expect(result).toMatchObject({
      connected: true,
      restarted: true,
      warning: expect.stringContaining("synthetic replacement warning"),
    });
    expect(result.warning).toContain("final cleanup durability was uncertain");
  });

  it("checks cancellation before offline replacement startup", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-abort-before-replacement-");
    const controller = new AbortController();
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    const boundary = vi.fn((phase: string): void => {
      if (phase === "after-pid-quarantine") controller.abort();
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
      _offlineRecoveryBoundaryOverride: boundary,
    }))).resolves.toMatchObject({
      connected: false,
      spawned: false,
      restarted: false,
      warning: expect.stringContaining("interrupted during offline restart recovery"),
    });
    expect(boundary).toHaveBeenCalledWith("after-pid-quarantine");
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
  });

  it("does not publish restart success when cancellation arrives during replacement readiness", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-abort-success-publication-");
    const controller = new AbortController();
    fixture.ensureReplacement.mockImplementationOnce(async () => {
      controller.abort();
      return {
        connected: true,
        port: 19999,
        spawned: true,
        pid: 5252,
      };
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      stoppedPid: fixture.pid,
      warning: "daemon lifecycle was interrupted before restart success publication",
    });
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
  });

  it("preserves the daemon when offline restart is aborted before TERM", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-abort-term-");
    const controller = new AbortController();
    const listener = vi.fn((): number[] => {
      if (listener.mock.calls.length === 2) controller.abort();
      return [19999];
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
      _listeningPortsOverride: listener,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("interrupted"),
    });
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe(String(fixture.pid));
  });

  it("preserves the daemon when offline restart is aborted after TERM revalidation", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-abort-revalidated-term-");
    const controller = new AbortController();
    fixture.listenerPorts.mockImplementation((): number[] => {
      if (fixture.listenerPorts.mock.calls.length === 3) controller.abort();
      return [19999];
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("interrupted during offline restart"),
    });
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe(String(fixture.pid));
  });

  it("preserves the daemon when offline restart is aborted between TERM and KILL", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-abort-kill-");
    const controller = new AbortController();
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGTERM") controller.abort();
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("interrupted during offline restart"),
    });
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe(String(fixture.pid));
  });

  it("does not clean or spawn when TERM succeeds while the restart is aborted", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-abort-dead-after-term-");
    const controller = new AbortController();
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal !== "SIGTERM") return;
      fixture.removeProcess();
      rmSync(fixture.pidFile, { force: true });
      controller.abort();
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
    }))).resolves.toMatchObject({
      connected: false,
      spawned: false,
      restarted: false,
      warning: expect.stringContaining("interrupted during offline restart"),
    });
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidFile)).toBe(false);
    expect(existsSync(fixture.procPidDir)).toBe(false);
  });

  it("preserves the daemon when offline restart is aborted after KILL revalidation", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-abort-revalidated-kill-");
    const controller = new AbortController();
    fixture.listenerPorts.mockImplementation((): number[] => {
      if (fixture.listenerPorts.mock.calls.length === 4) controller.abort();
      return [19999];
    });
    fixture.killProcess.mockImplementation(() => undefined);

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("interrupted during offline restart"),
    });
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe(String(fixture.pid));
  });

  it("rechecks listener ownership after the complete fingerprint before SIGTERM", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-listener-race-term-");
    fixture.listenerPorts.mockImplementation((): number[] => (
      fixture.listenerPorts.mock.calls.length === 3 ? [] : [19999]
    ));

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("daemon identity changed before SIGTERM");

    expect(fixture.listenerPorts).toHaveBeenCalledTimes(3);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
  });

  it("rechecks listener ownership after the complete fingerprint before SIGKILL", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-listener-race-kill-");
    fixture.listenerPorts.mockImplementation((): number[] => (
      fixture.listenerPorts.mock.calls.length === 4 ? [] : [19999]
    ));
    fixture.killProcess.mockImplementation(() => undefined);

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("daemon identity changed before SIGKILL");

    expect(fixture.listenerPorts).toHaveBeenCalledTimes(4);
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
  });

  it("rechecks exact recovery authority after the final listener proof before SIGTERM", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-record-race-term-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    fixture.listenerPorts.mockImplementation((): number[] => {
      if (fixture.listenerPorts.mock.calls.length === 3) {
        writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
      }
      return [19999];
    });

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("recovery record changed before SIGTERM");

    expect(fixture.listenerPorts).toHaveBeenCalledTimes(3);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("rechecks exact recovery authority after the final listener proof before SIGKILL", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-record-race-kill-");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    fixture.listenerPorts.mockImplementation((): number[] => {
      if (fixture.listenerPorts.mock.calls.length === 4) {
        writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
      }
      return [19999];
    });
    fixture.killProcess.mockImplementation(() => undefined);

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("recovery record changed before SIGKILL");

    expect(fixture.listenerPorts).toHaveBeenCalledTimes(4);
    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("does not clean or spawn when KILL succeeds while the restart is aborted", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-abort-dead-after-kill-");
    const controller = new AbortController();
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal !== "SIGKILL") return;
      fixture.removeProcess();
      controller.abort();
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("interrupted during offline restart"),
    });
    expect(fixture.killProcess.mock.calls).toEqual([
      [fixture.pid, "SIGTERM"],
      [fixture.pid, "SIGKILL"],
    ]);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
  });

  it("checks cancellation again after stopped-process confirmation and before PID cleanup", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-abort-after-gone-proof-");
    const controller = new AbortController();
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGTERM") fixture.removeProcess();
    });
    const isAlive = vi.fn((candidate: number): boolean => {
      if (candidate !== fixture.pid) return false;
      if (existsSync(fixture.procPidDir)) return true;
      controller.abort();
      return false;
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
      _isProcessAliveOverride: isAlive,
    }))).resolves.toMatchObject({
      connected: false,
      spawned: false,
      restarted: false,
      warning: expect.stringContaining("interrupted during offline restart"),
    });
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
  });

  it("refuses SIGKILL when the process birth identity changes after TERM", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-birth-race-");
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGTERM") fixture.writeProcess({ startTime: "654321" });
    });

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("daemon identity changed before SIGKILL");

    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe(String(fixture.pid));
  });

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "re-resolves caller launch evidence immediately before $signal",
    async (signal: "SIGTERM" | "SIGKILL"): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-launch-signal-race-");
      const launchPath = join(fixture.root, "lcm");
      const alternateEntrypoint = join(fixture.root, "alternate-lcm.mjs");
      writeFileSync(alternateEntrypoint, readFileSync(fixture.entrypoint));
      symlinkSync(fixture.entrypoint, launchPath);
      setOfflineLaunchPath(fixture, launchPath);
      if (signal === "SIGKILL") {
        fixture.killProcess.mockImplementation((_pid: number, _signal?: NodeJS.Signals | number): void => {});
      }
      const mutateOnExecutableRead = signal === "SIGTERM" ? 3 : 5;
      let executableReads = 0;

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _realpathOverride: (path: string): string => {
          if (path === join(fixture.procPidDir, "exe")) {
            executableReads += 1;
            if (executableReads === mutateOnExecutableRead) {
              replaceLaunchSymlink(launchPath, alternateEntrypoint);
            }
          }
          return realpathSync(path);
        },
      })))
        .rejects.toThrow(signal === "SIGTERM"
          ? "identity changed before SIGTERM"
          : "identity changed before SIGKILL");

      expect(fixture.killProcess.mock.calls).toEqual(
        signal === "SIGTERM" ? [] : [[fixture.pid, "SIGTERM"]],
      );
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
    },
  );

  it.each([
    {
      label: "group-writable PID state",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        chmodSync(fixture.pidFile, 0o664);
        return {};
      },
    },
    {
      label: "non-private token state",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        chmodSync(fixture.tokenFile, 0o644);
        return {};
      },
    },
    {
      label: "wrong process uid",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        fixture.writeProcess({ uid: process.getuid() + 1 });
        return {};
      },
    },
    {
      label: "zero process birth time",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        fixture.writeProcess({ startTime: "0" });
        return {};
      },
    },
    {
      label: "different executable",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        fixture.writeProcess({ executable: "/bin/sh" });
        return {};
      },
    },
    {
      label: "noncanonical argv executable",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        fixture.writeProcess({
          argv: [
            "/different/node",
            fixture.entrypoint,
            "daemon",
            "start",
            "--foreground",
          ],
        });
        return {};
      },
    },
    {
      label: "symlinked argv entrypoint",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        const alias = join(fixture.root, "lcm-entrypoint-alias.mjs");
        symlinkSync(fixture.entrypoint, alias);
        fixture.writeProcess({
          argv: [process.execPath, alias, "daemon", "start", "--foreground"],
        });
        return {};
      },
    },
    {
      label: "additional daemon argument",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        fixture.writeProcess({
          argv: [
            process.execPath,
            fixture.entrypoint,
            "daemon",
            "start",
            "--foreground",
            "--unexpected",
          ],
        });
        return {};
      },
    },
    {
      label: "prepended daemon argument",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        fixture.writeProcess({
          argv: [
            process.execPath,
            fixture.entrypoint,
            "--unexpected",
            "daemon",
            "start",
            "--foreground",
          ],
        });
        return {};
      },
    },
    {
      label: "reordered daemon arguments",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        fixture.writeProcess({
          argv: [
            process.execPath,
            fixture.entrypoint,
            "start",
            "daemon",
            "--foreground",
          ],
        });
        return {};
      },
    },
    {
      label: "duplicated daemon arguments",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        fixture.writeProcess({
          argv: [
            process.execPath,
            fixture.entrypoint,
            "daemon",
            "start",
            "--foreground",
            "daemon",
            "start",
          ],
        });
        return {};
      },
    },
    {
      label: "runtime digest mismatch",
      prepare: (): Partial<Parameters<typeof restartDaemonProduction>[0]> => ({
        expectedRuntimeDigest: "f".repeat(64),
      }),
    },
    {
      label: "missing packaged runtime identity",
      prepare: (): Partial<Parameters<typeof restartDaemonProduction>[0]> => ({
        expectedEntrypoint: undefined,
        expectedRuntimeDigest: undefined,
        _packagedEntrypointOverride: undefined,
      }),
    },
    {
      label: "missing listener ownership",
      prepare: (): Partial<Parameters<typeof restartDaemonProduction>[0]> => ({
        _listeningPortsOverride: () => [],
      }),
    },
    {
      label: "state canonicalization failure",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => ({
        _realpathOverride: path => {
          if (path === dirname(fixture.pidFile)) throw new Error("state realpath failed");
          return realpathSync(path);
        },
      }),
    },
    {
      label: "canonical state path mismatch",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => ({
        _realpathOverride: path => path === dirname(fixture.pidFile)
          ? join(fixture.root, "different-state")
          : realpathSync(path),
      }),
    },
    {
      label: "process executable canonicalization failure",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => ({
        _realpathOverride: path => {
          if (path === join(fixture.procPidDir, "exe")) throw new Error("exe realpath failed");
          return realpathSync(path);
        },
      }),
    },
    {
      label: "missing entrypoint argv after the health request",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => ({
        _fetchOverride: vi.fn(async () => {
          writeFileSync(join(fixture.procPidDir, "cmdline"), `${process.execPath}\0`);
          throw new Error("health connection failed");
        }),
      }),
    },
    {
      label: "final executable canonicalization failure",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        let executableReads = 0;
        return {
          _realpathOverride: path => {
            if (path === join(fixture.procPidDir, "exe")) {
              executableReads += 1;
              if (executableReads === 2) throw new Error("final exe realpath failed");
            }
            return realpathSync(path);
          },
        };
      },
    },
    {
      label: "final argv disappearance",
      prepare: (fixture: OfflineRestartFixture): Partial<Parameters<typeof restartDaemonProduction>[0]> => {
        let processExecutableReads = 0;
        return {
          _realpathOverride: (path: string): string => {
            if (path === join(fixture.procPidDir, "exe")) {
              processExecutableReads += 1;
            }
            if (processExecutableReads === 1) {
            writeFileSync(join(fixture.procPidDir, "cmdline"), "");
              processExecutableReads += 1;
            }
            return realpathSync(path);
          }
        };
      },
    },
  ])("fails closed when offline proof has $label", async ({ prepare }) => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-proof-");
    const overrides = prepare(fixture);

    await expect(restartDaemon(offlineRestartOptions(fixture, overrides)))
      .rejects.toThrow("not a verified LCM daemon");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe(String(fixture.pid));
  });

  it("refuses TERM when PID state changes during the final offline proof", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-pid-race-");

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-sigterm-revalidation") writeFileSync(fixture.pidFile, "9999");
      },
    })))
      .rejects.toThrow("identity changed before SIGTERM");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("9999");
  });

  it.each(["malformed row", "wrong listener UID"] as const)(
    "refuses offline signaling when the original listener proof has a %s",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(
        `lcm-offline-restart-original-listener-${failure.replaceAll(" ", "-")}-`,
      );
      setOfflineOriginalListener(fixture);
      const tcpPath = join(fixture.procRoot, "net", "tcp");
      const [header, listener] = readFileSync(tcpPath, "utf8").split("\n");
      if (failure === "malformed row") {
        writeFileSync(tcpPath, `${header}\n${listener}\nmalformed row\n`);
      } else {
        const columns = listener!.trim().split(/\s+/u);
        columns[7] = String(process.getuid() + 1);
        writeFileSync(tcpPath, `${header}\n${columns.join(" ")}\n`);
      }

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _listeningPortsOverride: undefined,
      }))).rejects.toThrow("not a verified LCM daemon");

      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
    },
  );

  it("refuses TERM when the original listener inode changes before revalidation", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-restart-original-listener-term-race-",
    );
    setOfflineOriginalListener(fixture);

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _listeningPortsOverride: undefined,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-sigterm-revalidation") {
          setOfflineOriginalListener(fixture, "54321");
        }
      },
    }))).rejects.toThrow("identity changed before SIGTERM");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses KILL when the original listener inode changes after TERM", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-restart-original-listener-kill-race-",
    );
    setOfflineOriginalListener(fixture);
    fixture.killProcess.mockImplementation((): void => {});

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _listeningPortsOverride: undefined,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-sigterm") {
          setOfflineOriginalListener(fixture, "54321");
        }
      },
    }))).rejects.toThrow("identity changed before SIGKILL");

    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("uses a fresh strict listener baseline when resuming offline recovery", async () => {
    const fixture = createOfflineRestartFixture(
      "lcm-offline-restart-resumed-listener-baseline-",
    );
    setOfflineOriginalListener(fixture, "12345");
    await restartDaemon(offlineRestartOptions(fixture, {
      _listeningPortsOverride: undefined,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-recovery-backup-cleanup") {
          throw new Error("retain strict recovery record");
        }
      },
    })).catch(() => undefined);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
    expect(fixture.killProcess).not.toHaveBeenCalled();

    setOfflineOriginalListener(fixture, "54321");
    let reachedResumedTermRevalidation = false;
    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _listeningPortsOverride: undefined,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-sigterm-revalidation") {
          reachedResumedTermRevalidation = true;
          setOfflineOriginalListener(fixture, "67890");
        }
      },
    }))).rejects.toThrow("identity changed before SIGTERM");

    expect(reachedResumedTermRevalidation).toBe(true);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it.each(["ipv4", "ipv6"] as const)(
    "refuses offline signaling when a foreign %s wildcard listener shares the configured port",
    async (family): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-restart-${family}-wildcard-`);
      const fdRoot = join(fixture.procPidDir, "fd");
      mkdirSync(fdRoot);
      symlinkSync("socket:[12345]", join(fdRoot, "7"));
      fixture.setLoopbackListener(true);
      const tcpPath = join(fixture.procRoot, "net", family === "ipv4" ? "tcp" : "tcp6");
      const [header, listener] = readFileSync(
        join(fixture.procRoot, "net", "tcp"),
        "utf8",
      ).split("\n");
      const wildcard = listener!
        .replace(
          "0100007F",
          family === "ipv4"
            ? "00000000"
            : "00000000000000000000000000000000",
        )
        .replace("12345", "99999");
      writeFileSync(
        tcpPath,
        family === "ipv4"
          ? `${header}\n${listener}\n${wildcard}\n`
          : `${header}\n${wildcard}\n`,
      );

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _listeningPortsOverride: undefined,
      }))).rejects.toThrow("not a verified LCM daemon");

      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
    },
  );

  it("refuses TERM when token state is replaced during the final offline proof", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-token-race-");

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase !== "before-sigterm-revalidation") return;
        rmSync(fixture.tokenFile);
        writeFileSync(fixture.tokenFile, "replacement-token");
        chmodSync(fixture.tokenFile, 0o600);
      },
    })))
      .rejects.toThrow("identity changed before SIGTERM");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.tokenFile, "utf-8")).toBe("replacement-token");
  });

  it("refuses an in-place PID permission-mode change before SIGTERM", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-pid-mode-race-");
    const initialState = statSync(fixture.pidFile);

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-sigterm-revalidation") chmodSync(fixture.pidFile, 0o600);
      },
    })))
      .rejects.toThrow("identity changed before SIGTERM");

    const finalState = statSync(fixture.pidFile);
    expect(finalState.ino).toBe(initialState.ino);
    expect(finalState.size).toBe(initialState.size);
    expect(finalState.mode & 0o777).toBe(0o600);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("refuses ctime-only PID drift before SIGTERM", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-pid-ctime-race-");
    const fixedMtime = new Date(Date.now() - 120_000);
    const initialAtime = statSync(fixture.pidFile).atime;
    utimesSync(fixture.pidFile, initialAtime, fixedMtime);
    const baseline = statSync(fixture.pidFile);
    const establishCtimeOnlyPidDrift = (trusted: Stats, phase: string): Stats => {
      const trustedContent = readFileSync(fixture.pidFile, "utf8");
      const ctimeDeadline = Date.now() + 2_500;
      const restorePidLeaf = (): void => {
        try {
          writeFileSync(fixture.pidFile, trustedContent);
        } finally {
          try {
            chmodSync(fixture.pidFile, trusted.mode);
          } finally {
            utimesSync(fixture.pidFile, trusted.atime, trusted.mtime);
          }
        }
      };
      let ctimeChanged = false;
      try {
        do {
          try {
            chmodSync(fixture.pidFile, trusted.mode ^ 0o100);
          } finally {
            restorePidLeaf();
          }
          ctimeChanged = statSync(fixture.pidFile).ctimeMs !== trusted.ctimeMs;
          if (!ctimeChanged) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        } while (!ctimeChanged && Date.now() < ctimeDeadline);
      } finally {
        restorePidLeaf();
      }
      const changed = statSync(fixture.pidFile);
      if (!ctimeChanged || changed.ctimeMs === trusted.ctimeMs) {
        throw new Error(`could not establish ${phase} ctime-only PID drift within 2500ms`);
      }
      expect(changed.dev).toBe(trusted.dev);
      expect(changed.ino).toBe(trusted.ino);
      expect(changed.isFile()).toBe(true);
      expect(changed.mode).toBe(trusted.mode);
      expect(changed.uid).toBe(trusted.uid);
      expect(changed.nlink).toBe(trusted.nlink);
      expect(changed.size).toBe(trusted.size);
      expect(readFileSync(fixture.pidFile, "utf8")).toBe(trustedContent);
      expect(changed.mtimeMs).toBe(trusted.mtimeMs);
      expect(changed.ctimeMs).not.toBe(trusted.ctimeMs);
      return changed;
    };
    const trustedBeforeRestart = establishCtimeOnlyPidDrift(baseline, "initial calibration");
    let preTermCtimeMutationObserved = false;

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "before-sigterm-revalidation") {
          preTermCtimeMutationObserved = true;
        establishCtimeOnlyPidDrift(trustedBeforeRestart, "pre-SIGTERM");
        }
      },
    })))
      .rejects.toThrow("identity changed before SIGTERM");

    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
    expect(preTermCtimeMutationObserved).toBe(true);
    expect(fixture.listenerPorts).toHaveBeenCalledTimes(3);
  });

  it.each([
    { stage: "before SIGTERM", target: "PID" },
    { stage: "before SIGTERM", target: "token" },
    { stage: "before SIGKILL", target: "PID" },
    { stage: "before SIGKILL", target: "token" },
    { stage: "post-stop cleanup", target: "PID" },
    { stage: "post-stop cleanup", target: "token" },
  ] as const)(
    "refuses same-inode same-size $target timestamp drift $stage",
    async ({
      stage,
      target,
    }: {
      stage: "before SIGTERM" | "before SIGKILL" | "post-stop cleanup";
      target: "PID" | "token";
    }): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-state-timestamp-race-");
      const statePath = target === "PID" ? fixture.pidFile : fixture.tokenFile;
      const initialState = statSync(statePath);
      const driftTimestamp = (): void => {
        driftOfflineStateFileTimestamp(statePath);
      };
      const boundary = (phase: string): void => {
        if (
          (stage === "before SIGTERM" && phase === "before-sigterm-revalidation")
          || (stage === "before SIGKILL" && phase === "after-sigterm")
        ) {
          driftTimestamp();
        }
      };

      if (stage === "before SIGTERM" || stage === "before SIGKILL") {
        if (stage === "before SIGKILL") {
          fixture.killProcess.mockImplementation(
            (_pid: number, _signal?: NodeJS.Signals | number): void => {},
          );
        }
      } else {
        fixture.killProcess.mockImplementation(
          (_pid: number, signal?: NodeJS.Signals | number): void => {
            if (signal !== "SIGTERM") return;
            fixture.removeProcess();
            driftTimestamp();
          },
        );
      }

      const expectedReason = stage === "before SIGTERM"
        ? "identity changed before SIGTERM"
        : stage === "before SIGKILL"
          ? "identity changed before SIGKILL"
          : "stopped daemon trust evidence is incomplete";
      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlineRecoveryBoundaryOverride: boundary,
      })))
        .rejects.toThrow(expectedReason);

      expect(fixture.killProcess.mock.calls).toEqual(
        stage === "before SIGTERM" ? [] : [[fixture.pid, "SIGTERM"]],
      );
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      const finalState = statSync(statePath);
      expect(finalState.ino).toBe(initialState.ino);
      expect(finalState.size).toBe(initialState.size);
      expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
      expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
    },
  );

  it("refuses startup when the PID file is concurrently replaced after the original stops", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-post-stop-pid-race-");
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal !== "SIGTERM") return;
      fixture.removeProcess();
      writeFileSync(fixture.pidFile, "9999");
    });

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("stopped daemon trust evidence is incomplete");

    expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe("9999");
  });

  it("refuses startup when the PID inode is replaced after the original stops", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-post-stop-inode-race-");
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal !== "SIGTERM") return;
      fixture.removeProcess();
      const replacementPath = join(fixture.root, "replacement.pid");
      writeFileSync(replacementPath, String(fixture.pid));
      chmodSync(replacementPath, 0o644);
      renameSync(replacementPath, fixture.pidFile);
    });

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("stopped daemon trust evidence is incomplete");

    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe(String(fixture.pid));
  });

  it.each(["symlink", "hardlink", "directory"] as const)(
    "preserves a concurrent %s PID leaf after the original stops",
    async (kind): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-post-stop-unsafe-leaf-");
      fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal !== "SIGTERM") return;
        fixture.removeProcess();
        rmSync(fixture.pidFile, { force: true });
        if (kind === "directory") {
          mkdirSync(fixture.pidFile);
          return;
        }
        const target = join(fixture.root, `${kind}-target.pid`);
        writeFileSync(target, String(fixture.pid));
        if (kind === "symlink") symlinkSync(target, fixture.pidFile);
        else linkSync(target, fixture.pidFile);
      });
      const previousEntrypoint = process.argv[1];
      process.argv[1] = fixture.entrypoint;
      try {
        await expect(restartDaemon(offlineRestartOptions(fixture)))
          .rejects.toThrow("Offline restart recovery refused");
      } finally {
        process.argv[1] = previousEntrypoint;
      }

      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(existsSync(fixture.pidFile)).toBe(true);
      if (kind === "hardlink") expect(statSync(fixture.pidFile).nlink).toBe(2);
    },
  );

  it("retains a same-text untrusted inode raced into the final PID rename", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-final-rename-race-");
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    let replacementInode: number | undefined;
    const renamePid = vi.fn((from: string, to: string): void => {
      const replacementPath = join(fixture.root, "final-rename-replacement.pid");
      writeFileSync(replacementPath, String(fixture.pid));
      replacementInode = statSync(replacementPath).ino;
      renameSync(replacementPath, from);
      renameSync(from, to);
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlinePidRenameOverride: renamePid,
    }))).rejects.toThrow("untrusted quarantine retained at");

    expect(renamePid).toHaveBeenCalledOnce();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidFile)).toBe(false);
    const quarantineName = readdirSync(fixture.root)
      .find((name: string): boolean => name.startsWith(".daemon.pid.restart-"));
    expect(quarantineName).toBeDefined();
    expect(statSync(join(fixture.root, quarantineName!)).ino).toBe(replacementInode);
  });

  it("does not overwrite a quarantine leaf raced into the authenticated hard-link transition", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-quarantine-link-eexist-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const racedBytes = "preserve concurrent quarantine";
    const originalLink = nodeFs.linkSync;
    let linkPidCalls = 0;
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    const link = vi.spyOn(nodeFs, "linkSync").mockImplementation((
      from: import("node:fs").PathLike,
      to: import("node:fs").PathLike,
    ): void => {
      if (
        anchoredLeafMatches(String(from), fixture.pidFile)
        && anchoredLeafMatches(String(to), quarantinePath)
      ) {
        linkPidCalls += 1;
        writeFileSync(quarantinePath, racedBytes);
        const error = new Error("occupied quarantine") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      originalLink(from, to);
    });
    syncBuiltinESMExports();

    try {
      await expect(restartDaemon(offlineRestartOptions(fixture)))
        .rejects.toThrow("deterministic offline PID quarantine already exists");
    } finally {
      link.mockRestore();
      syncBuiltinESMExports();
    }

    expect(linkPidCalls).toBe(1);
    expect(readFileSync(quarantinePath, "utf8")).toBe(racedBytes);
    expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
    expect(statSync(fixture.pidFile).nlink).toBe(1);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
  });

  it("rejects a canonical PID substitution inside the no-overwrite link operation", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-quarantine-link-source-race-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const originalInode = statSync(fixture.pidFile).ino;
    const displaced = join(fixture.root, "displaced-original.pid");
    const originalLink = nodeFs.linkSync;
    let linkPidCalls = 0;
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    const link = vi.spyOn(nodeFs, "linkSync").mockImplementation((
      from: import("node:fs").PathLike,
      to: import("node:fs").PathLike,
    ): void => {
      if (
        anchoredLeafMatches(String(from), fixture.pidFile)
        && anchoredLeafMatches(String(to), quarantinePath)
      ) {
        linkPidCalls += 1;
        renameSync(fixture.pidFile, displaced);
        writeFileSync(fixture.pidFile, String(fixture.pid));
      }
      originalLink(from, to);
    });
    syncBuiltinESMExports();

    try {
      await expect(restartDaemon(offlineRestartOptions(fixture)))
        .rejects.toThrow("daemon PID state changed during quarantine linking");
    } finally {
      link.mockRestore();
      syncBuiltinESMExports();
    }

    expect(linkPidCalls).toBe(1);
    expect(statSync(displaced).ino).toBe(originalInode);
    expect(statSync(fixture.pidFile).ino).not.toBe(originalInode);
    expect(statSync(quarantinePath).ino).toBe(statSync(fixture.pidFile).ino);
    expect(readFileSync(quarantinePath, "utf8")).toBe(String(fixture.pid));
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("retains both exact PID references when canonical-source unlink is refused", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-quarantine-two-link-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const originalInode = statSync(fixture.pidFile).ino;
    const originalUnlink = nodeFs.unlinkSync;
    let sourceUnlinkCalls = 0;
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });

    const unlink = vi.spyOn(nodeFs, "unlinkSync").mockImplementation((
      path: import("node:fs").PathLike,
    ): void => {
      if (
        anchoredLeafMatches(String(path), fixture.pidFile)
        && existsSync(quarantinePath)
      ) {
        sourceUnlinkCalls += 1;
        throw new Error("source unlink denied");
      }
      originalUnlink(path);
    });
    syncBuiltinESMExports();

    try {
      await expect(restartDaemon(offlineRestartOptions(fixture)))
        .rejects.toThrow("exact two-link evidence retained");
    } finally {
      unlink.mockRestore();
      syncBuiltinESMExports();
    }

    expect(sourceUnlinkCalls).toBe(1);
    expect(statSync(fixture.pidFile).ino).toBe(originalInode);
    expect(statSync(quarantinePath).ino).toBe(originalInode);
    expect(statSync(fixture.pidFile).nlink).toBe(2);
    expect(statSync(quarantinePath).nlink).toBe(2);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
  });

  it("refuses a resumed two-link transition when its exact quarantine leaf becomes unreadable", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-quarantine-resume-read-failure-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const controller = new AbortController();
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    await restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-pid-quarantine-link") controller.abort();
      },
    }));
    const recordBefore = snapshotOfflineEvidenceLeaf(recordPath);
    const pidBefore = snapshotOfflineEvidenceLeaf(fixture.pidFile);
    const quarantineBefore = snapshotOfflineEvidenceLeaf(quarantinePath);
    const tokenBefore = snapshotOfflineEvidenceLeaf(fixture.tokenFile);
    fixture.killProcess.mockClear();
    fixture.ensureReplacement.mockClear();
    const originalOpen = nodeFs.openSync;
    let quarantineOpenFailures = 0;
    const open = vi.spyOn(nodeFs, "openSync").mockImplementation((path, flags, mode): number => {
      if (
        String(path) === quarantinePath
        && new Error().stack?.includes("transitionOfflinePidToQuarantine") === true
      ) {
        quarantineOpenFailures += 1;
        const error = new Error("synthetic quarantine read refusal") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalOpen(path, flags, mode);
    });
    syncBuiltinESMExports();

    try {
      await expect(restartDaemon(offlineRestartOptions(fixture)))
        .rejects.toThrow("PID quarantine transition is incomplete");
    } finally {
      open.mockRestore();
      syncBuiltinESMExports();
    }

    expect(quarantineOpenFailures).toBe(1);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(snapshotOfflineEvidenceLeaf(recordPath)).toEqual(recordBefore);
    expect(snapshotOfflineEvidenceLeaf(fixture.pidFile)).toEqual(pidBefore);
    expect(snapshotOfflineEvidenceLeaf(quarantinePath)).toEqual(quarantineBefore);
    expect(snapshotOfflineEvidenceLeaf(fixture.tokenFile)).toEqual(tokenBefore);
  });

  it.each(["abort", "occupied"] as const)(
    "handles an exact quarantine %s race before linking",
    async (outcome: "abort" | "occupied"): Promise<void> => {
    const fixture = createOfflineRestartFixture(`lcm-offline-quarantine-absence-${outcome}-`);
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const tokenBefore = snapshotOfflineEvidenceLeaf(fixture.tokenFile);
    const originalPid = snapshotOfflineEvidenceLeaf(fixture.pidFile);
    const controller = new AbortController();
    const originalLstat = nodeFs.lstatSync;
    let raceLookups = 0;
    let signalsAtRace = 0;
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    const lstat = vi.spyOn(nodeFs, "lstatSync").mockImplementation((path): Stats => {
      try {
        return originalLstat(path);
      } catch (error) {
        const target = String(path);
        if (
          target.startsWith("/proc/self/fd/")
          && anchoredLeafMatches(target, quarantinePath)
          && new Error().stack?.includes("transitionOfflinePidToQuarantine") === true
        ) {
          raceLookups += 1;
          signalsAtRace = fixture.killProcess.mock.calls.length;
          if (outcome === "occupied") {
            writeFileSync(quarantinePath, "preserve concurrent quarantine");
            return originalLstat(path);
          }
          controller.abort();
        }
        throw error;
      }
    });
    syncBuiltinESMExports();

    try {
      const operation = restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
      }));
      if (outcome === "abort") {
        await expect(operation).resolves.toMatchObject({
          connected: false,
          restarted: false,
          warning: expect.stringContaining("retained canonical evidence"),
        });
      } else {
        await expect(operation).rejects.toThrow("deterministic offline PID quarantine already exists");
      }
    } finally {
      lstat.mockRestore();
      syncBuiltinESMExports();
    }

    expect(raceLookups).toBe(1);
    expect(fixture.killProcess).toHaveBeenCalledTimes(signalsAtRace);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(snapshotOfflineEvidenceLeaf(fixture.pidFile)).toMatchObject({
      content: originalPid?.content,
      inode: originalPid?.inode,
      links: 1,
    });
    expect(snapshotOfflineEvidenceLeaf(fixture.tokenFile)).toEqual(tokenBefore);
    expect(existsSync(recordPath)).toBe(true);
    expect(existsSync(quarantinePath)).toBe(outcome === "occupied");
    if (outcome === "occupied") {
      expect(readFileSync(quarantinePath, "utf8")).toBe("preserve concurrent quarantine");
    }
  });

  it("observes an abort immediately after the native quarantine link", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-quarantine-native-link-abort-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const tokenBefore = snapshotOfflineEvidenceLeaf(fixture.tokenFile);
    const originalInode = statSync(fixture.pidFile).ino;
    const controller = new AbortController();
    const originalLink = nodeFs.linkSync;
    let linkAborts = 0;
    let signalsAtAbort = 0;
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    const link = vi.spyOn(nodeFs, "linkSync").mockImplementation((
      from: import("node:fs").PathLike,
      to: import("node:fs").PathLike,
    ): void => {
      originalLink(from, to);
      if (
        anchoredLeafMatches(String(from), fixture.pidFile)
        && anchoredLeafMatches(String(to), quarantinePath)
      ) {
        linkAborts += 1;
        signalsAtAbort = fixture.killProcess.mock.calls.length;
        controller.abort();
      }
    });
    syncBuiltinESMExports();

    try {
      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("both exact references"),
      });
    } finally {
      link.mockRestore();
      syncBuiltinESMExports();
    }

    expect(linkAborts).toBe(1);
    expect(fixture.killProcess).toHaveBeenCalledTimes(signalsAtAbort);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(statSync(fixture.pidFile).ino).toBe(originalInode);
    expect(statSync(quarantinePath).ino).toBe(originalInode);
    expect(statSync(fixture.pidFile).nlink).toBe(2);
    expect(snapshotOfflineEvidenceLeaf(fixture.tokenFile)).toEqual(tokenBefore);
    expect(existsSync(recordPath)).toBe(true);
  });

  it("observes an abort at the second post-link check after its boundary returns", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-quarantine-post-boundary-abort-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const tokenBefore = snapshotOfflineEvidenceLeaf(fixture.tokenFile);
    const originalInode = statSync(fixture.pidFile).ino;
    const controller = new AbortController();
    let armed = false;
    let armedAbortReads = 0;
    let signalsAtBoundary = 0;
    const signal = new Proxy(controller.signal, {
      get: (target, property): unknown => {
        if (property === "aborted" && armed) {
          armedAbortReads += 1;
          if (armedAbortReads >= 2) {
            controller.abort();
            return true;
          }
          return false;
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    fixture.killProcess.mockImplementation((_pid: number, killSignal?: NodeJS.Signals | number): void => {
      if (killSignal === "SIGKILL") fixture.removeProcess();
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: signal,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase !== "after-pid-quarantine-link") return;
        armed = true;
        signalsAtBoundary = fixture.killProcess.mock.calls.length;
      },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("both exact references"),
    });

    expect(armedAbortReads).toBe(2);
    expect(fixture.killProcess).toHaveBeenCalledTimes(signalsAtBoundary);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(statSync(fixture.pidFile).ino).toBe(originalInode);
    expect(statSync(quarantinePath).ino).toBe(originalInode);
    expect(statSync(fixture.pidFile).nlink).toBe(2);
    expect(snapshotOfflineEvidenceLeaf(fixture.tokenFile)).toEqual(tokenBefore);
    expect(existsSync(recordPath)).toBe(true);
  });

  it("observes a late abort after both linked PID proofs remain stable", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-quarantine-linked-proof-abort-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const tokenBefore = snapshotOfflineEvidenceLeaf(fixture.tokenFile);
    const originalInode = statSync(fixture.pidFile).ino;
    const controller = new AbortController();
    const originalFstat = nodeFs.fstatSync;
    let quarantineFstats = 0;
    let signalsAtAbort = 0;
    let restoreFstat: (() => void) | undefined;
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });

    try {
      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase !== "after-pid-quarantine-link") return;
          const fstat = vi.spyOn(nodeFs, "fstatSync").mockImplementation((descriptor): Stats => {
            const stats = originalFstat(descriptor);
            let target: string | undefined;
            try {
              target = readlinkSync(`/proc/self/fd/${String(descriptor)}`);
            } catch {
              target = undefined;
            }
            if (target === quarantinePath) {
              quarantineFstats += 1;
              if (quarantineFstats === 2) {
                signalsAtAbort = fixture.killProcess.mock.calls.length;
                controller.abort();
              }
            }
            return stats;
          });
          syncBuiltinESMExports();
          restoreFstat = (): void => {
            fstat.mockRestore();
            syncBuiltinESMExports();
          };
        },
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("both exact references"),
      });
    } finally {
      restoreFstat?.();
    }

    expect(quarantineFstats).toBe(2);
    expect(fixture.killProcess).toHaveBeenCalledTimes(signalsAtAbort);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(statSync(fixture.pidFile).ino).toBe(originalInode);
    expect(statSync(quarantinePath).ino).toBe(originalInode);
    expect(statSync(fixture.pidFile).nlink).toBe(2);
    expect(snapshotOfflineEvidenceLeaf(fixture.tokenFile)).toEqual(tokenBefore);
    expect(existsSync(recordPath)).toBe(true);
  });

  it("retains the exact quarantine inode when the authenticated parent is substituted after linking", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-quarantine-link-parent-race-");
    const movedRoot = `${fixture.root}-linked-parent`;
    tempDirs.push(movedRoot);
    const originalInode = statSync(fixture.pidFile).ino;
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const originalLink = nodeFs.linkSync;
    let linkPidCalls = 0;
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    const link = vi.spyOn(nodeFs, "linkSync").mockImplementation((
      from: import("node:fs").PathLike,
      to: import("node:fs").PathLike,
    ): void => {
      const isTarget = anchoredLeafMatches(String(from), fixture.pidFile)
        && anchoredLeafMatches(String(to), quarantinePath);
      originalLink(from, to);
      if (isTarget) {
        linkPidCalls += 1;
        renameSync(fixture.root, movedRoot);
        mkdirSync(fixture.root);
        chmodSync(fixture.root, 0o700);
      }
    });
    syncBuiltinESMExports();

    try {
      await expect(restartDaemon(offlineRestartOptions(fixture)))
        .rejects.toThrow("PID quarantine transition is incomplete");
    } finally {
      link.mockRestore();
      syncBuiltinESMExports();
    }

    expect(linkPidCalls).toBe(1);
    const retainedQuarantine = join(movedRoot, ".daemon.pid.restart-quarantine");
    expect(statSync(retainedQuarantine).ino).toBe(originalInode);
    expect(readFileSync(retainedQuarantine, "utf8")).toBe(String(fixture.pid));
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(false);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("reconciles the exact two-link PID transition on the next explicit restart", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-quarantine-two-link-resume-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const firstController = new AbortController();
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    const first = await restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: firstController.signal,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        if (phase === "after-pid-quarantine-link") firstController.abort();
      },
    }));
    const originalInode = statSync(fixture.pidFile).ino;

    expect(first).toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("both exact references"),
    });
    expect(statSync(quarantinePath).ino).toBe(originalInode);
    expect(statSync(fixture.pidFile).nlink).toBe(2);
    expect(existsSync(recordPath)).toBe(true);

    const resumed = await restartDaemon(offlineRestartOptions(fixture));
    expect(resumed).toMatchObject({ connected: true, restarted: true, stoppedPid: fixture.pid });
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
    expect(existsSync(quarantinePath)).toBe(false);
    expect(existsSync(recordPath)).toBe(false);
  });

  it.each(["transition-refused", "fence-interrupted", "fence-refused"] as const)(
    "preserves exact durable evidence when resumed two-link preparation is %s",
    async (outcome): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-two-link-${outcome}-`);
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const firstController = new AbortController();
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGKILL") fixture.removeProcess();
        },
      );
      await restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: firstController.signal,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "after-pid-quarantine-link") firstController.abort();
        },
      }));
      const recordBefore = snapshotOfflineEvidenceLeaf(recordPath);
      const quarantineBefore = snapshotOfflineEvidenceLeaf(quarantinePath);
      const pidBefore = snapshotOfflineEvidenceLeaf(fixture.pidFile);
      const tokenBefore = snapshotOfflineEvidenceLeaf(fixture.tokenFile);
      fixture.killProcess.mockClear();
      fixture.ensureReplacement.mockClear();
      const secondController = new AbortController();
      const capturedClose = closeSync;
      const capturedUnlink = nodeFs.unlinkSync;
      let postTransitionMutation = false;
      let transitionUnlinkCalls = 0;
      const closeSpy = outcome === "transition-refused"
        ? undefined
        : vi.spyOn(nodeFs, "closeSync").mockImplementation((descriptor: number): void => {
            capturedClose(descriptor);
            if (
              !postTransitionMutation
              && !existsSync(fixture.pidFile)
              && existsSync(quarantinePath)
            ) {
              postTransitionMutation = true;
              if (outcome === "fence-interrupted") secondController.abort();
              else fixture.setLoopbackListener(true);
            }
          });
      const unlinkSpy = outcome === "transition-refused"
        ? vi.spyOn(nodeFs, "unlinkSync").mockImplementation((
            path: import("node:fs").PathLike,
          ): void => {
            if (anchoredLeafMatches(String(path), fixture.pidFile)) {
              transitionUnlinkCalls += 1;
              throw new Error("retain exact linked PID evidence");
            }
            capturedUnlink(path);
          })
        : undefined;
      if (closeSpy || unlinkSpy) syncBuiltinESMExports();

      const operation = restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: secondController.signal,
      }));
      try {
        if (outcome === "fence-interrupted") {
          await expect(operation).resolves.toMatchObject({
            connected: false,
            restarted: false,
            warning: expect.stringContaining("PID quarantine retained at"),
          });
        } else {
          await expect(operation).rejects.toThrow(outcome === "transition-refused"
            ? "exact two-link evidence retained"
            : "stopped daemon trust evidence is incomplete");
        }
      } finally {
        closeSpy?.mockRestore();
        unlinkSpy?.mockRestore();
        if (closeSpy || unlinkSpy) syncBuiltinESMExports();
      }

      expect(postTransitionMutation).toBe(outcome !== "transition-refused");
      expect(transitionUnlinkCalls).toBe(outcome === "transition-refused" ? 1 : 0);
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(snapshotOfflineEvidenceLeaf(recordPath)).toEqual(recordBefore);
      expect(snapshotOfflineEvidenceLeaf(fixture.tokenFile)).toEqual(tokenBefore);
      const quarantineAfter = snapshotOfflineEvidenceLeaf(quarantinePath);
      expect(quarantineAfter).toMatchObject({
        content: quarantineBefore?.content,
        device: quarantineBefore?.device,
        inode: quarantineBefore?.inode,
        uid: quarantineBefore?.uid,
      });
      if (outcome === "transition-refused") {
        expect(snapshotOfflineEvidenceLeaf(fixture.pidFile)).toEqual(pidBefore);
        expect(quarantineAfter?.links).toBe(2);
      } else {
        expect(snapshotOfflineEvidenceLeaf(fixture.pidFile)).toBeNull();
        expect(quarantineAfter?.links).toBe(1);
      }
    },
  );

  it("retains a replacement displaced by parent substitution at the final PID rename", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-final-parent-race-");
    const movedRoot = `${fixture.root}-original`;
    tempDirs.push(movedRoot);
    const previousEntrypoint = process.argv[1];
    let replacementInode: number | undefined;
    const options = offlineRestartOptions(fixture, {
      _killOverride: vi.fn((_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGKILL") fixture.removeProcess();
      }),
      _offlinePidRenameOverride: (from: string, to: string): void => {
        renameSync(fixture.root, movedRoot);
        mkdirSync(fixture.root);
        chmodSync(fixture.root, 0o700);
        writeFileSync(from, String(fixture.pid));
        chmodSync(from, 0o644);
        replacementInode = statSync(from).ino;
        renameSync(from, to);
      },
    });
    process.argv[1] = fixture.entrypoint;
    try {
      await expect(restartDaemon(options))
        .rejects.toThrow("untrusted quarantine retained at");
    } finally {
      process.argv[1] = previousEntrypoint;
    }

    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidFile)).toBe(false);
    const quarantineName = readdirSync(fixture.root)
      .find((name: string): boolean => name.startsWith(".daemon.pid.restart-"));
    expect(quarantineName).toBeDefined();
    expect(statSync(join(fixture.root, quarantineName!)).ino).toBe(replacementInode);
    expect(readFileSync(join(movedRoot, "daemon.pid"), "utf8")).toBe(String(fixture.pid));
  });

  it("preserves a canonical replacement created during quarantine cleanup", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-final-unlink-race-");
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    const unlinkPid = vi.fn((quarantinePath: string): void => {
      const replacementPath = join(fixture.root, "final-unlink-replacement.pid");
      writeFileSync(replacementPath, "9999");
      renameSync(replacementPath, fixture.pidFile);
      expect(existsSync(quarantinePath)).toBe(true);
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlinePidUnlinkOverride: unlinkPid,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("PID quarantine changed"),
    });

    expect(unlinkPid).toHaveBeenCalledOnce();
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("9999");
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(true);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
  });

  it("refuses an occupied deterministic offline PID quarantine", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-quarantine-path-");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    writeFileSync(quarantinePath, "preserve me");

    await expect(restartDaemon(offlineRestartOptions(fixture)))
      .rejects.toThrow("recovery evidence is missing or malformed");

    expect(fixture.healthFetch).not.toHaveBeenCalled();
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
    expect(readFileSync(quarantinePath, "utf8")).toBe("preserve me");
  });

  it("refuses cleanup when the final PID rename cannot be performed", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-rename-failure-");
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlinePidRenameOverride: () => { throw new Error("rename denied"); },
    }))).rejects.toThrow("daemon PID state changed during cleanup");

    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe(String(fixture.pid));
  });

  it.each(["token", "digest", "launch", "listener"] as const)(
    "retains durable recovery evidence after post-rename %s drift",
    async (drift: "token" | "digest" | "launch" | "listener"): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-post-rename-fence-");
      const originalInode = statSync(fixture.pidFile).ino;
      const launchAlias = join(fixture.root, "post-rename-launch");
      symlinkSync(fixture.entrypoint, launchAlias);
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGKILL") fixture.removeProcess();
        },
      );
      let quarantinePath: string | undefined;
      const renamePid = vi.fn((from: string, to: string): void => {
        renameSync(from, to);
        quarantinePath = to;
        if (drift === "token") driftOfflineStateFileTimestamp(fixture.tokenFile);
        if (drift === "digest") writeFileSync(fixture.entrypoint, "changed runtime\n");
        if (drift === "launch") process.argv[1] = launchAlias;
        if (drift === "listener") fixture.setLoopbackListener(true);
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlinePidRenameOverride: renamePid,
      }))).rejects.toThrow("quarantine retained at");

      expect(renamePid).toHaveBeenCalledOnce();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(existsSync(fixture.pidFile)).toBe(false);
      expect(quarantinePath).toBeDefined();
      expect(statSync(quarantinePath!).ino).toBe(originalInode);
      expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
    },
  );

  it.each(["throw", "eexist"] as const)(
    "does not attempt legacy PID relink after durable evidence drift with %s",
    async (failureMode: "throw" | "eexist"): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-relink-failure-");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGKILL") fixture.removeProcess();
        },
      );
      const renamePid = vi.fn((from: string, to: string): void => {
        renameSync(from, to);
        driftOfflineStateFileTimestamp(fixture.tokenFile);
      });
      const originalLink = nodeFs.linkSync;
      let linkPidCalls = 0;
      const link = vi.spyOn(nodeFs, "linkSync").mockImplementation((
        from: import("node:fs").PathLike,
        to: import("node:fs").PathLike,
      ): void => {
        const fromPath = String(from);
        const toPath = String(to);
        const isStatePair = (
          anchoredLeafMatches(fromPath, fixture.pidFile)
          && anchoredLeafMatches(toPath, quarantinePath)
        ) || (
          anchoredLeafMatches(fromPath, quarantinePath)
          && anchoredLeafMatches(toPath, fixture.pidFile)
        );
        if (isStatePair) {
          linkPidCalls += 1;
          const error = new Error(
            failureMode === "eexist" ? "canonical occupied" : "link denied",
          ) as NodeJS.ErrnoException;
          if (failureMode === "eexist") {
            writeFileSync(fixture.pidFile, "9999");
            error.code = "EEXIST";
          }
          throw error;
        }
        originalLink(from, to);
      });
      syncBuiltinESMExports();

      try {
        await expect(restartDaemon(offlineRestartOptions(fixture, {
          _offlinePidRenameOverride: renamePid,
        }))).rejects.toThrow("quarantine retained at");
      } finally {
        link.mockRestore();
        syncBuiltinESMExports();
      }

      expect(linkPidCalls).toBe(0);
      expect(existsSync(quarantinePath)).toBe(true);
      expect(readFileSync(quarantinePath, "utf8")).toBe(String(fixture.pid));
      expect(existsSync(fixture.pidFile)).toBe(false);
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it.each(["token", "digest", "launch", "listener", "abort"] as const)(
    "revalidates %s trust immediately before publishing replacement state",
    async (
      drift: "token" | "digest" | "launch" | "listener" | "abort",
    ): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-pre-unlink-fence-");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const controller = new AbortController();
      const launchAlias = join(fixture.root, "pre-unlink-launch");
      symlinkSync(fixture.entrypoint, launchAlias);
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGKILL") fixture.removeProcess();
        },
      );
      const finalize = vi.fn((): void => {
        if (drift === "token") driftOfflineStateFileTimestamp(fixture.tokenFile);
        if (drift === "digest") writeFileSync(fixture.entrypoint, "changed runtime\n");
        if (drift === "launch") process.argv[1] = launchAlias;
        if (drift === "listener") fixture.listenerPorts.mockReturnValue([]);
        if (drift === "abort") controller.abort();
      });
      const operation = restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineRecoveryFinalizeOverride: finalize,
      }));

      await expect(operation).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("not publishable"),
      });
      expect(finalize).toHaveBeenCalledOnce();
      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
      expect(existsSync(quarantinePath)).toBe(true);
      expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
    },
  );

  it.each(["health", "auth", "quarantine", "abort"] as const)(
    "refuses replacement publication after %s proof fails inside the final snapshot",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-final-snapshot-${failure}-`);
      const controller = new AbortController();
      if (failure === "quarantine") {
        fixture.killProcess.mockImplementation(
          (_pid: number, signal?: NodeJS.Signals | number): void => {
            if (signal === "SIGKILL") fixture.removeProcess();
          },
        );
      }
      const fetch = vi.fn(async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        if (!existsSync(join(fixture.procRoot, "5252"))) {
          throw new Error("original daemon is wedged");
        }
        const url = String(input);
        if (url.endsWith("/stats/pool")) {
          return { ok: true, status: 200, json: async () => ({}) } as Response;
        }
        if (failure === "auth" && init?.headers !== undefined) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ error: "unauthorized" }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "ok",
            version: "1.4.2",
            storageBackend: "sqlite",
            pid: failure === "health" ? 9999 : 5252,
            entrypoint: fixture.entrypoint,
            runtimeDigest: fixture.runtimeDigest,
          }),
        } as Response;
      });
      const boundary = vi.fn((phase: string): void => {
        if (failure === "quarantine" && phase === "after-replacement-readiness") {
          chmodSync(join(fixture.root, ".daemon.pid.restart-quarantine"), 0o666);
        }
      });
      fixture.listenerPorts.mockImplementation((candidate?: number): number[] => {
        if (failure === "abort" && candidate === 5252) controller.abort();
        return [19999];
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _fetchOverride: fetch,
        _offlineRecoveryBoundaryOverride: boundary,
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("not publishable"),
      });

      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
      expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
    },
  );

  it.each([
    "quarantine-proof",
    "quarantine-persistence",
    "record-race",
    "abort",
    "record-persistence",
  ] as const)(
    "retains authoritative recovery after final cleanup fence %s fails",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture(`lcm-offline-final-cleanup-${failure}-`);
      const controller = new AbortController();
      const requiresQuarantine = failure.startsWith("quarantine");
      if (requiresQuarantine) {
        fixture.killProcess.mockImplementation(
          (_pid: number, signal?: NodeJS.Signals | number): void => {
            if (signal === "SIGKILL") fixture.removeProcess();
          },
        );
      }
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const boundary = vi.fn((phase: string): void => {
        if (failure === "quarantine-proof" && phase === "before-quarantine-cleanup") {
          writeFileSync(join(fixture.root, ".daemon.pid.restart-quarantine"), "changed\n");
        }
        if (failure === "record-race" && phase === "before-record-proof") {
          writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
        }
        if (failure === "abort" && phase === "before-record-cleanup") controller.abort();
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineRecoveryBoundaryOverride: boundary,
        _offlinePidUnlinkOverride: failure === "quarantine-persistence"
          ? (): never => { throw new Error("quarantine unlink refused"); }
          : undefined,
        _offlineRecordUnlinkOverride: failure === "record-persistence"
          ? (): never => { throw new Error("record unlink refused"); }
          : undefined,
      }))).resolves.toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining(
          failure === "record-race"
            ? "authority or durability is indeterminate"
            : "durable recovery authority remains",
        ),
      });

      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
      expect(existsSync(recordPath)).toBe(true);
    },
  );

  it.each(["listener", "abort"] as const)(
    "rechecks %s at the final stopped-fence boundary",
    async (drift: "listener" | "abort"): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-final-fence-");
      const controller = new AbortController();
      const finalizeFence = vi.fn((): void => {
        if (drift === "listener") fixture.setLoopbackListener(true);
        if (drift === "abort") controller.abort();
      });
      const operation = restartDaemon(offlineRestartOptions(fixture, {
        _abortSignal: controller.signal,
        _offlineTrustFenceFinalizeOverride: finalizeFence,
      }));

      if (drift === "abort") {
        await expect(operation).resolves.toMatchObject({
          connected: false,
          restarted: false,
          warning: "daemon lifecycle was interrupted during offline restart recovery",
        });
      } else {
        await expect(operation).rejects.toThrow("stopped daemon trust evidence changed");
      }
      expect(finalizeFence).toHaveBeenCalledOnce();
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    },
  );

  it("retains quarantine when interrupted immediately after rename", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-post-rename-abort-");
    const controller = new AbortController();
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGKILL") fixture.removeProcess();
      },
    );
    let quarantinePath: string | undefined;
    const renamePid = vi.fn((from: string, to: string): void => {
      renameSync(from, to);
      quarantinePath = to;
      controller.abort();
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
      _offlinePidRenameOverride: renamePid,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("PID quarantine retained at"),
    });

    expect(quarantinePath).toBeDefined();
    expect(existsSync(quarantinePath!)).toBe(true);
    expect(existsSync(fixture.pidFile)).toBe(false);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("retains quarantine when final unlink aborts and throws", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-final-unlink-abort-");
    const controller = new AbortController();
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGKILL") fixture.removeProcess();
      },
    );
    const unlinkPid = vi.fn((_path: string): never => {
      controller.abort();
      throw new Error("unlink interrupted");
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _abortSignal: controller.signal,
      _offlinePidUnlinkOverride: unlinkPid,
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("durable recovery authority remains"),
    });

    expect(unlinkPid).toHaveBeenCalledOnce();
    expect(readdirSync(fixture.root).some(
      (name: string): boolean => name.startsWith(".daemon.pid.restart-"),
    )).toBe(true);
    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
  });

  it.each([
    ["setuid", 0o4644],
    ["setgid", 0o2644],
    ["sticky", 0o1644],
  ] as const)(
    "refuses %s mode drift across the PID quarantine rename",
    async (_label: string, specialMode: number): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-rename-special-mode-");
      const beforeRename = statSync(fixture.pidFile);
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGTERM") fixture.removeProcess();
        },
      );
      const renamePid = vi.fn((from: string, to: string): void => {
        renameSync(from, to);
        chmodSync(to, specialMode);
        const changed = statSync(to);
        expect(changed.ino).toBe(beforeRename.ino);
        expect(changed.size).toBe(beforeRename.size);
        expect(changed.mode & 0o7000).toBe(specialMode & 0o7000);
        expect(changed.ctimeMs).toBeGreaterThanOrEqual(beforeRename.ctimeMs);
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlinePidRenameOverride: renamePid,
      }))).rejects.toThrow("untrusted quarantine retained at");

      expect(renamePid).toHaveBeenCalledOnce();
      expect(fixture.killProcess).toHaveBeenCalledExactlyOnceWith(fixture.pid, "SIGTERM");
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(existsSync(fixture.pidFile)).toBe(false);
      const quarantineName = readdirSync(fixture.root)
        .find((name: string): boolean => name.startsWith(".daemon.pid.restart-"));
      expect(quarantineName).toBeDefined();
      const retained = statSync(join(fixture.root, quarantineName!));
      expect(retained.ino).toBe(beforeRename.ino);
      expect(retained.mode & 0o7000).toBe(specialMode & 0o7000);
    },
  );

  it("preserves a canonical replacement created immediately after PID quarantine", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-post-quarantine-race-");
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    const renamePid = vi.fn((from: string, to: string): void => {
      renameSync(from, to);
      writeFileSync(from, "9999");
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlinePidRenameOverride: renamePid,
    }))).rejects.toThrow("untrusted quarantine retained at");

    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("9999");
    expect(readdirSync(fixture.root).some(name => name.startsWith(".daemon.pid.restart-")))
      .toBe(true);
  });

  it("does not delete quarantine after preserving a canonical replacement", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-post-quarantine-unlink-");
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    const renamePid = vi.fn((from: string, to: string): void => {
      renameSync(from, to);
      writeFileSync(from, "9999");
    });
    const unlinkPid = vi.fn((): void => { throw new Error("unlink denied"); });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlinePidRenameOverride: renamePid,
      _offlinePidUnlinkOverride: unlinkPid,
    }))).rejects.toThrow("untrusted quarantine retained at");

    expect(unlinkPid).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("9999");
    expect(readdirSync(fixture.root).some(name => name.startsWith(".daemon.pid.restart-")))
      .toBe(true);
  });

  it.each(["parent", "unsafe-canonical"] as const)(
    "retains authenticated quarantine across a post-rename %s race",
    async (race: "parent" | "unsafe-canonical"): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-retained-quarantine-race-");
      fixture.killProcess.mockImplementation(
        (_pid: number, signal?: NodeJS.Signals | number): void => {
          if (signal === "SIGKILL") fixture.removeProcess();
        },
      );
      let quarantinePath: string | undefined;
      const renamePid = vi.fn((from: string, to: string): void => {
        renameSync(from, to);
        quarantinePath = to;
        if (race === "parent") {
          chmodSync(fixture.root, 0o777);
        } else {
          const unsafeTarget = join(fixture.root, "unsafe-canonical-target.pid");
          writeFileSync(unsafeTarget, "9999");
          symlinkSync(unsafeTarget, from);
        }
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlinePidRenameOverride: renamePid,
      }))).rejects.toThrow(
        race === "unsafe-canonical"
          ? "state paths changed or escaped their canonical scope"
          : "quarantine retained at",
      );

      expect(quarantinePath).toBeDefined();
      expect(existsSync(quarantinePath!)).toBe(true);
      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      if (race === "unsafe-canonical") {
        expect(lstatSync(fixture.pidFile).isSymbolicLink()).toBe(true);
      } else {
        expect(existsSync(fixture.pidFile)).toBe(false);
      }
    },
  );

  it("retains the record and quarantine when stopped evidence drifts", async (): Promise<void> => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-restore-unlink-failure-");
    fixture.killProcess.mockImplementation(
      (_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGKILL") fixture.removeProcess();
      },
    );
    let quarantinePath: string | undefined;
    const renamePid = vi.fn((from: string, to: string): void => {
      renameSync(from, to);
      quarantinePath = to;
      driftOfflineStateFileTimestamp(fixture.tokenFile);
    });
    await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlinePidRenameOverride: renamePid,
      }))).rejects.toThrow("stopped daemon trust evidence is incomplete");

    expect(quarantinePath).toBeDefined();
    expect(existsSync(fixture.pidFile)).toBe(false);
    expect(readFileSync(quarantinePath!, "utf8")).toBe(String(fixture.pid));
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
  });

  it("retains authoritative recovery state when quarantine cleanup fails", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-unlink-failure-");
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _offlinePidUnlinkOverride: () => { throw new Error("unlink denied"); },
    }))).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("durable recovery authority remains"),
    });

    expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-quarantine"))).toBe(true);
    expect(existsSync(join(fixture.root, ".daemon.pid.restart-recovery.json"))).toBe(true);
  });

  it("reopens the quarantined PID proof immediately before unlink", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-final-proof-race-");
    let renamed = false;
    let renamedMissingChecks = 0;
    let replacementInode: number | undefined;
    fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === "SIGKILL") fixture.removeProcess();
    });
    const renamePid = vi.fn((from: string, to: string): void => {
      renameSync(from, to);
      renamed = true;
    });
    const isAlive = vi.fn((candidate: number): boolean => {
      if (candidate !== fixture.pid) return false;
      if (existsSync(fixture.procPidDir)) return true;
      if (renamed) {
        renamedMissingChecks += 1;
        if (renamedMissingChecks === 2) {
          const quarantineName = readdirSync(fixture.root)
            .find(name => name.startsWith(".daemon.pid.restart-"));
          expect(quarantineName).toBeDefined();
          const replacementPath = join(fixture.root, "final-proof-replacement.pid");
          writeFileSync(replacementPath, String(fixture.pid));
          replacementInode = statSync(replacementPath).ino;
          renameSync(replacementPath, join(fixture.root, quarantineName!));
        }
      }
      return false;
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _isProcessAliveOverride: isAlive,
      _offlinePidRenameOverride: renamePid,
    }))).rejects.toThrow("stopped daemon trust evidence changed");

    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidFile)).toBe(false);
    const quarantineName = readdirSync(fixture.root)
      .find((name: string): boolean => name.startsWith(".daemon.pid.restart-"));
    expect(quarantineName).toBeDefined();
    expect(statSync(join(fixture.root, quarantineName!)).ino).toBe(replacementInode);
  });

  it.each(["canonical-present", "parent-changed", "quarantine-missing"] as const)(
    "fails closed when restore sees $mode",
    async (mode): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-restore-failure-");
      fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal === "SIGKILL") fixture.removeProcess();
      });
      const renamePid = vi.fn((from: string, to: string): void => {
        renameSync(from, to);
        if (mode === "canonical-present") writeFileSync(from, "9999");
        if (mode === "parent-changed") chmodSync(fixture.root, 0o777);
        if (mode === "quarantine-missing") unlinkSync(to);
        else writeFileSync(to, "9999");
      });

      await expect(restartDaemon(offlineRestartOptions(fixture, {
        _offlinePidRenameOverride: renamePid,
      }))).rejects.toThrow("daemon PID state changed during cleanup");

      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      if (mode === "canonical-present") expect(readFileSync(fixture.pidFile, "utf8")).toBe("9999");
    },
  );

  it("refuses cleanup after the authenticated PID parent directory is substituted", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-parent-race-");
    const movedRoot = `${fixture.root}-original`;
    tempDirs.push(movedRoot);
    const previousEntrypoint = process.argv[1];
    const options = offlineRestartOptions(fixture, {
      _killOverride: vi.fn((_pid: number, signal?: NodeJS.Signals | number): void => {
        if (signal !== "SIGTERM") return;
        fixture.removeProcess();
        renameSync(fixture.root, movedRoot);
        mkdirSync(fixture.root);
      }),
    });
    process.argv[1] = fixture.entrypoint;
    try {
      await expect(restartDaemon(options))
        .rejects.toThrow("offline restart recovery record changed after SIGTERM");
    } finally {
      process.argv[1] = previousEntrypoint;
    }

    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(join(movedRoot, "daemon.pid"), "utf8")).toBe(String(fixture.pid));
    expect(existsSync(fixture.pidFile)).toBe(false);
  });

  it("refuses startup when the original fingerprint reappears before cleanup", async () => {
    const fixture = createOfflineRestartFixture("lcm-offline-restart-post-stop-reappearance-");
    let missingChecks = 0;
    const isAlive = vi.fn((pid: number): boolean => {
      if (pid !== fixture.pid) return false;
      if (existsSync(fixture.procPidDir)) return true;
      missingChecks += 1;
      if (missingChecks === 2) {
        fixture.writeProcess();
        writeFileSync(fixture.pidFile, String(fixture.pid));
        return true;
      }
      return false;
    });

    await expect(restartDaemon(offlineRestartOptions(fixture, {
      _isProcessAliveOverride: isAlive,
    }))).rejects.toThrow("stopped daemon trust evidence is incomplete");

    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidFile, "utf-8")).toBe(String(fixture.pid));
    expect(existsSync(fixture.procPidDir)).toBe(true);
  });

  it.each(["term", "kill", "survive"] as const)(
    "preserves state when offline %s termination cannot complete",
    async (failure): Promise<void> => {
      const fixture = createOfflineRestartFixture("lcm-offline-restart-stop-failure-");
      fixture.killProcess.mockImplementation((_pid: number, signal?: NodeJS.Signals | number): void => {
        if (failure === "term" && signal === "SIGTERM") throw new Error("term denied");
        if (failure === "kill" && signal === "SIGKILL") throw new Error("kill denied");
        if (failure !== "survive" && signal === "SIGKILL") fixture.removeProcess();
      });

      await expect(restartDaemon(offlineRestartOptions(fixture)))
        .rejects.toThrow(failure === "term"
          ? "SIGTERM could not be delivered"
          : failure === "kill"
            ? "SIGKILL could not be delivered"
            : "remained alive after SIGKILL");

      expect(fixture.ensureReplacement).not.toHaveBeenCalled();
      expect(readFileSync(fixture.pidFile, "utf-8")).toBe(String(fixture.pid));
    },
  );

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
