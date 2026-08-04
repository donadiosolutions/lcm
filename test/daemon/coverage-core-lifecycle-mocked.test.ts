import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSync, openSync, writeSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fs = vi.hoisted(() => ({
  chmod: vi.fn(), exists: vi.fn(), lstat: vi.fn(), mkdtemp: vi.fn(), read: vi.fn(),
  readdir: vi.fn(), realpath: vi.fn(), rm: vi.fn(), stat: vi.fn(), unlink: vi.fn(),
  write: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    chmodSync: fs.chmod,
    existsSync: fs.exists,
    lstatSync: fs.lstat,
    mkdtempSync: fs.mkdtemp,
    readFileSync: (path: unknown, ...args: unknown[]) => (
      typeof path === "number"
        ? Reflect.apply(original.readFileSync, original, [path, ...args])
        : Reflect.apply(fs.read, fs, [path, ...args])
    ),
    readdirSync: fs.readdir,
    realpathSync: fs.realpath,
    rmSync: fs.rm,
    statSync: fs.stat,
    unlinkSync: fs.unlink,
    writeFileSync: fs.write,
  };
});

import {
  __lifecycleTestUtils,
  ensureDaemon as ensureDaemonProduction,
} from "../../src/daemon/lifecycle.js";
import type { DaemonLifecycleHermeticTestSeams } from "../../src/daemon/lifecycle-scope.js";

type EnsureDaemonOptions = Parameters<typeof ensureDaemonProduction>[0];
type SpawnOverride = NonNullable<EnsureDaemonOptions["_spawnOverride"]>;

const saved = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY, lcm: process.env.LCM_SUMMARY_API_KEY };
const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
let runtimeRoot: string;
beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "lcm-mocked-lifecycle-"));
  await mkdir(join(runtimeRoot, ".hermetic-runtime"));
  await mkdir(join(runtimeRoot, ".hermetic-credentials"));
  await mkdir(join(runtimeRoot, ".hermetic-proc"));
  await writeFile(join(runtimeRoot, "daemon.token"), "token", { mode: 0o600 });
  Object.defineProperty(process, "getuid", { configurable: true, value: vi.fn(() => 1000) });
  vi.clearAllMocks();
  fs.exists.mockImplementation((path: string) => path.endsWith("daemon.token"));
  fs.lstat.mockImplementation((path: string) => {
    if (path.endsWith("daemon.pid") || path.endsWith("daemon.token")) {
      if (!fs.exists(path)) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return {
        dev: 1,
        ino: 2,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        nlink: 1,
      };
    }
    return {
      dev: 1,
      ino: 1,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
      nlink: 1,
    };
  });
  fs.mkdtemp.mockReturnValue(
    join(runtimeRoot, ".hermetic-credentials", "lcm-systemd-credentials-test"),
  );
  fs.realpath.mockImplementation((path: string) => path);
  fs.stat.mockReturnValue({ isDirectory: () => true, mtimeMs: 0 }); fs.readdir.mockReturnValue([]);
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.LCM_SUMMARY_API_KEY;
});
afterEach(async () => {
  if (originalGetuid) Object.defineProperty(process, "getuid", originalGetuid);
  else Reflect.deleteProperty(process, "getuid");
  vi.restoreAllMocks();
  if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.anthropic;
  if (saved.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.openai;
  if (saved.lcm === undefined) delete process.env.LCM_SUMMARY_API_KEY; else process.env.LCM_SUMMARY_API_KEY = saved.lcm;
  await rm(runtimeRoot, { recursive: true, force: true });
});

const base = (): EnsureDaemonOptions => ({
  port: 1, pidFilePath: join(runtimeRoot, "daemon.pid"), spawnTimeoutMs: 1, expectedVersion: "1", _platform: "linux" as const,
  enforceUserManagerParent: true, _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
  _spawnOverride: vi.fn(() => ({ pid: undefined, once: vi.fn(), unref: vi.fn() })) as unknown as SpawnOverride,
  _monotonicNowOverride: (): number => 0,
  _skipHealthWait: true,
});

const writePidLeaf = (pid: number): void => {
  const descriptor = openSync(join(runtimeRoot, "daemon.pid"), "w", 0o600);
  try {
    writeSync(descriptor, String(pid));
  } finally {
    closeSync(descriptor);
  }
};

function ensureDaemon(options: EnsureDaemonOptions): ReturnType<typeof ensureDaemonProduction> {
  const seams: DaemonLifecycleHermeticTestSeams = {
    homeDir: runtimeRoot,
    runtimeDir: join(runtimeRoot, ".hermetic-runtime"),
    stateDir: runtimeRoot,
    credentialDir: join(runtimeRoot, ".hermetic-credentials"),
    procRoot: join(runtimeRoot, ".hermetic-proc"),
    platform: options._platform ?? "linux",
    uid: options._uid ?? 1000,
    environment: { ...process.env },
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
  return ensureDaemonProduction({ ...options, _hermeticTestSeams: seams });
}

describe("mocked lifecycle identity boundaries", () => {

  it("does not terminate when a verified retry PID changes identity before signaling", async () => {
    let daemonCommandReads = 0;
    writePidLeaf(20);
    fs.exists.mockReturnValue(true);
    fs.readdir.mockReturnValue([{ isDirectory: () => true, name: "11" }]);
    fs.read.mockImplementation((path: string) => {
      if (path.endsWith("daemon.pid")) return "20";
      if (path.endsWith("/11/status")) return "Uid:\t1000\nPPid:\t1\n";
      if (path.endsWith("/11/cmdline")) return "systemd\0--user";
      if (path.endsWith("/20/status")) return "Uid:\t1000\nPPid:\t10\n";
      if (path.endsWith("/20/cmdline")) {
        daemonCommandReads++;
        return daemonCommandReads === 1 ? "node\0lcm\0daemon\0start\0--foreground" : "node\0other";
      }
      if (path.endsWith("daemon.token")) return "token";
      throw new Error(`unexpected read ${path}`);
    });
    const kill = vi.fn();
    const result = await ensureDaemon({
      ...base(), _procRoot: "/proc", _uid: 1000, _skipSpawn: true, _skipHealthWait: false,
      _isProcessAliveOverride: () => true, _killOverride: kill, _sleepOverride: async () => {},
    });
    expect(result.connected).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not terminate when an existing healthy PID changes identity before signaling", async () => {
    let daemonCommandReads = 0;
    writePidLeaf(20);
    fs.exists.mockImplementation((path: string) => path.endsWith("daemon.token"));
    fs.readdir.mockReturnValue([{ isDirectory: () => true, name: "10" }]);
    fs.read.mockImplementation((path: string) => {
      if (path.endsWith("daemon.pid")) return "20";
      if (path.endsWith("/10/status")) return "Uid:\t1000\nPPid:\t1\n";
      if (path.endsWith("/10/cmdline")) return "systemd\0--user";
      if (path.endsWith("/20/status")) return "Uid:\t1000\nPPid:\t10\n";
      if (path.endsWith("/20/cmdline")) return ++daemonCommandReads === 1 ? "node\0lcm\0daemon\0start" : "node\0other";
      if (path.endsWith("daemon.token")) return "token";
      throw new Error(`unexpected read ${path}`);
    });
    const fetch = vi.fn(async (url: string) => url.endsWith("/health")
      ? { ok: true, json: async () => ({ status: "ok", pid: 20 }) }
      : { ok: true, json: async () => ({}) });
    const kill = vi.fn();
    const result = await ensureDaemon({
      ...base(), _procRoot: "/proc", _uid: 1000, _skipSpawn: true, _skipHealthWait: false,
      _fetchOverride: fetch as never, _isProcessAliveOverride: () => true, _killOverride: kill,
    });
    expect(result.connected).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not signal when a wrong-parent first inspection becomes unavailable on reinspection", async () => {
    writePidLeaf(20);
    fs.exists.mockImplementation((path: string) => path.endsWith("daemon.token"));
    fs.readdir.mockReturnValue([{ isDirectory: () => true, name: "11" }]);
    fs.read.mockImplementation((path: string) => {
      if (path.endsWith("daemon.pid")) return "20";
      if (path.endsWith("/11/status")) return "Uid:\t1000\nPPid:\t1\n";
      if (path.endsWith("/11/cmdline")) return "systemd\0--user";
      if (path.endsWith("/20/status")) return "Uid:\t1000\nPPid:\t10\n";
      if (path.endsWith("/20/cmdline")) {
        writePidLeaf(Number.NaN);
        return "node\0lcm\0daemon\0start";
      }
      if (path.endsWith("daemon.token")) return "token";
      throw new Error(`unexpected read ${path}`);
    });
    const fetch = vi.fn(async (url: string) => url.endsWith("/health")
      ? { ok: true, json: async () => ({ status: "ok", pid: 20 }) }
      : { ok: true, json: async () => ({}) });
    const kill = vi.fn();
    const result = await ensureDaemon({
      ...base(), _procRoot: "/proc", _uid: 1000, _skipSpawn: true, _skipHealthWait: false,
      _fetchOverride: fetch as never, _isProcessAliveOverride: () => true, _killOverride: kill,
    });
    expect(result.connected).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
