import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { platform as osPlatform } from "node:os";
import { join, dirname } from "node:path";
import { ensureAuthToken, readAuthToken } from "./auth.js";

type KillProcess = (pid: number, signal?: NodeJS.Signals | number) => void;
type SleepFn = (ms: number) => Promise<void>;

export type EnsureDaemonOptions = {
  port: number;
  pidFilePath: string;
  spawnTimeoutMs: number;
  expectedVersion?: string;
  enforceUserManagerParent?: boolean;
  spawnCommand?: string;
  spawnArgs?: string[];
  _skipSpawn?: boolean; // for testing — don't attempt to spawn
  _spawnOverride?: typeof spawn;
  _spawnSyncOverride?: typeof spawnSync;
  _skipHealthWait?: boolean;
  _fetchOverride?: typeof globalThis.fetch;
  _platform?: NodeJS.Platform;
  _procRoot?: string;
  _uid?: number;
  _killOverride?: KillProcess;
  _sleepOverride?: SleepFn;
  _isProcessAliveOverride?: (pid: number) => boolean;
};

export type EnsureDaemonResult = {
  connected: boolean;
  port: number;
  spawned: boolean;
  pid?: number;
  parentPid?: number;
  userSystemdPid?: number;
  restartedForParent?: boolean;
  startMethod?: "existing" | "systemd-user" | "detached-spawn";
  warning?: string;
};

type HealthResponse = {
  status: string;
  version?: string;
  uptime?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(pidFilePath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidFilePath, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function cleanStalePid(pidFilePath: string): void {
  try {
    if (existsSync(pidFilePath)) unlinkSync(pidFilePath);
  } catch { /* ignore */ }
}

function statusField(status: string, name: string): string | null {
  const line = status.split("\n").find((value) => value.startsWith(`${name}:`));
  return line ? line.slice(name.length + 1).trim() : null;
}

function statusUid(status: string): number | null {
  const value = statusField(status, "Uid");
  const first = value?.split(/\s+/)[0];
  const uid = first === undefined ? NaN : Number.parseInt(first, 10);
  return Number.isInteger(uid) ? uid : null;
}

export function readProcessParentPid(pid: number, procRoot = "/proc"): number | null {
  try {
    const status = readFileSync(join(procRoot, String(pid), "status"), "utf-8");
    const value = statusField(status, "PPid");
    const parentPid = value === null ? NaN : Number.parseInt(value, 10);
    return Number.isInteger(parentPid) && parentPid >= 0 ? parentPid : null;
  } catch {
    return null;
  }
}

function readProcessCommand(pid: number, procRoot = "/proc"): string | null {
  try {
    return readFileSync(join(procRoot, String(pid), "cmdline"), "utf-8").replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}

function isLikelyLcmDaemonProcess(pid: number, procRoot = "/proc"): boolean {
  const command = readProcessCommand(pid, procRoot);
  if (!command) return false;
  const parts = command.split(/\s+/);
  return command.includes("lcm") && parts.includes("daemon") && parts.includes("start");
}

export function findUserSystemdPid(options: { procRoot?: string; uid?: number } = {}): number | null {
  const procRoot = options.procRoot ?? "/proc";
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (uid === undefined) return null;

  try {
    for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number.parseInt(entry.name, 10);
      try {
        const dir = join(procRoot, entry.name);
        const status = readFileSync(join(dir, "status"), "utf-8");
        if (statusUid(status) !== uid) continue;

        const command = readFileSync(join(dir, "cmdline"), "utf-8").replace(/\0/g, " ").trim();
        if (command.includes("systemd") && command.split(/\s+/).includes("--user")) {
          return pid;
        }
      } catch {
        // Process may exit while scanning /proc; ignore and continue.
      }
    }
  } catch {
    return null;
  }

  return null;
}

type ParentInspection = {
  satisfies: boolean;
  available: boolean;
  pid?: number;
  parentPid?: number;
  userSystemdPid?: number;
  reason?: string;
};

function inspectDaemonParent(
  pidFilePath: string,
  options: {
    platform: NodeJS.Platform;
    procRoot: string;
    uid?: number;
    isAlive: (pid: number) => boolean;
  },
): ParentInspection {
  if (options.platform !== "linux") {
    return { satisfies: true, available: false, reason: "not-linux" };
  }

  const pid = readPidFile(pidFilePath);
  if (pid === null) return { satisfies: false, available: false, reason: "missing-pid" };
  if (!options.isAlive(pid)) return { satisfies: false, available: false, pid, reason: "dead-pid" };
  if (!isLikelyLcmDaemonProcess(pid, options.procRoot)) {
    return { satisfies: false, available: false, pid, reason: "pid-not-lcm-daemon" };
  }

  const userSystemdPid = findUserSystemdPid({ procRoot: options.procRoot, uid: options.uid });
  if (userSystemdPid === null) {
    return { satisfies: false, available: false, pid, reason: "user-systemd-unavailable" };
  }

  const parentPid = readProcessParentPid(pid, options.procRoot);
  if (parentPid === null) {
    return { satisfies: false, available: false, pid, userSystemdPid, reason: "parent-unknown" };
  }

  return {
    satisfies: parentPid === userSystemdPid,
    available: true,
    pid,
    parentPid,
    userSystemdPid,
    reason: parentPid === userSystemdPid ? undefined : "wrong-parent",
  };
}

async function terminatePid(
  pid: number,
  options: {
    isAlive: (pid: number) => boolean;
    killProcess: KillProcess;
    sleepFn: SleepFn;
  },
): Promise<void> {
  if (!options.isAlive(pid)) return;
  try {
    options.killProcess(pid, "SIGTERM");
  } catch {
    return;
  }
  await options.sleepFn(500);
  if (options.isAlive(pid)) {
    try {
      options.killProcess(pid, "SIGKILL");
    } catch {
      // Best-effort termination; caller will fail readiness if the port remains occupied.
    }
  }
}

async function checkDaemonHealth(
  port: number,
  fetchFn: typeof globalThis.fetch,
): Promise<HealthResponse | null> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

async function checkDaemonAccess(
  port: number,
  tokenPath: string,
  fetchFn: typeof globalThis.fetch,
): Promise<boolean> {
  const token = readAuthToken(tokenPath);
  if (!token) return false;
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/stats/pool`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function startViaDetachedSpawn(
  opts: EnsureDaemonOptions,
  spawnCommand: string,
  spawnArgs: string[],
): { getWarning: () => string | undefined } {
  const spawnImpl = opts._spawnOverride ?? spawn;
  let errorMessage: string | undefined;
  let child: ChildProcess;
  try {
    child = spawnImpl(spawnCommand, spawnArgs, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    }) as ChildProcess;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    return { getWarning: () => `detached spawn failed (${errorMessage})` };
  }
  child.once("error", (err) => {
    errorMessage = err.message;
  });
  child.unref();

  if (child.pid) {
    writeFileSync(opts.pidFilePath, String(child.pid));
  }
  return {
    getWarning: () => errorMessage ? `detached spawn failed (${errorMessage})` : undefined,
  };
}

function startViaUserSystemd(
  opts: EnsureDaemonOptions,
  spawnCommand: string,
  spawnArgs: string[],
): { ok: boolean; warning?: string } {
  const spawnSyncImpl = opts._spawnSyncOverride ?? spawnSync;
  const unit = `lcm-daemon-${process.pid}-${Date.now()}`;
  const result = spawnSyncImpl("systemd-run", [
    "--user",
    "--collect",
    "--no-block",
    "--quiet",
    `--unit=${unit}`,
    spawnCommand,
    ...spawnArgs,
  ], { encoding: "utf-8", env: { ...process.env }, timeout: Math.max(1, opts.spawnTimeoutMs) });

  if (result.status === 0) return { ok: true };
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const error = result.error instanceof Error ? result.error.message : "";
  const signal = result.signal ? `signal ${result.signal}` : "";
  const detail = stderr || stdout || error || signal || `exit status ${result.status ?? "unknown"}`;
  return {
    ok: false,
    warning: `user systemd start failed (${detail}); used detached spawn fallback; daemon parent invariant is not satisfied`,
  };
}

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  const fetchFn = opts._fetchOverride ?? globalThis.fetch;
  const tokenPath = join(dirname(opts.pidFilePath), "daemon.token");
  const platform = opts._platform ?? osPlatform();
  const procRoot = opts._procRoot ?? "/proc";
  const sleepFn = opts._sleepOverride ?? sleep;
  const isAlive = opts._isProcessAliveOverride ?? isProcessAlive;
  const killProcess = opts._killOverride ?? ((pid, signal) => {
    process.kill(pid, signal);
  });
  const enforceParent = opts.enforceUserManagerParent === true && platform === "linux";
  let restartedForParent = false;

  function inspectParent(): ParentInspection {
    return inspectDaemonParent(opts.pidFilePath, {
      platform,
      procRoot,
      uid: opts._uid,
      isAlive,
    });
  }

  async function terminatePidFileProcess(): Promise<void> {
    const pid = readPidFile(opts.pidFilePath);
    if (pid !== null) {
      await terminatePid(pid, { isAlive, killProcess, sleepFn });
    }
    cleanStalePid(opts.pidFilePath);
  }

  async function daemonResult(
    health: HealthResponse | null,
    spawned: boolean,
    startMethod: EnsureDaemonResult["startMethod"],
    warning?: string,
    allowParentWarning = false,
  ): Promise<EnsureDaemonResult | null> {
    if (health?.status !== "ok") return null;
    if (opts.expectedVersion && health.version !== opts.expectedVersion) return null;
    if (!await checkDaemonAccess(opts.port, tokenPath, fetchFn)) return null;

    let parent: ParentInspection | undefined;
    if (enforceParent) {
      parent = inspectParent();
      if (!parent.satisfies) {
        if (!parent.available || allowParentWarning) {
          if (parent.reason === "dead-pid" || parent.reason === "pid-not-lcm-daemon") {
            cleanStalePid(opts.pidFilePath);
          }
          return {
            connected: true,
            port: opts.port,
            spawned,
            pid: parent.pid,
            parentPid: parent.parentPid,
            userSystemdPid: parent.userSystemdPid,
            restartedForParent,
            startMethod,
            warning: warning ?? "user systemd manager unavailable; daemon parent invariant is not verified",
          };
        }
        return null;
      }
    }

    return {
      connected: true,
      port: opts.port,
      spawned,
      pid: parent?.pid ?? readPidFile(opts.pidFilePath) ?? undefined,
      parentPid: parent?.parentPid,
      userSystemdPid: parent?.userSystemdPid,
      restartedForParent,
      startMethod,
      warning,
    };
  }

  // Step 1: Check if daemon is already running via health check
  const health = await checkDaemonHealth(opts.port, fetchFn);
  if (health?.status === "ok") {
    const hasAccess = await checkDaemonAccess(opts.port, tokenPath, fetchFn);
    if (hasAccess && opts.expectedVersion && health.version !== opts.expectedVersion) {
      await terminatePidFileProcess();
    } else if (hasAccess) {
      const accepted = await daemonResult(health, false, "existing");
      if (accepted) return accepted;
      if (enforceParent) {
        const parent = inspectParent();
        if (parent.available && parent.pid !== undefined) {
          await terminatePid(parent.pid, { isAlive, killProcess, sleepFn });
          restartedForParent = true;
        }
      }
      cleanStalePid(opts.pidFilePath);
    } else {
      cleanStalePid(opts.pidFilePath);
    }
  }

  // Step 2: Check PID file for stale process
  if (existsSync(opts.pidFilePath)) {
    try {
      const pid = parseInt(readFileSync(opts.pidFilePath, "utf-8").trim(), 10);
      if (!isNaN(pid) && isAlive(pid)) {
        await sleepFn(1000);
        const retry = await checkDaemonHealth(opts.port, fetchFn);
        const accepted = await daemonResult(retry, false, "existing");
        if (accepted) {
          return accepted;
        }
        if (enforceParent) {
          const parent = inspectParent();
          if (parent.available && parent.pid !== undefined) {
            if (isLikelyLcmDaemonProcess(parent.pid, procRoot)) {
              await terminatePid(parent.pid, { isAlive, killProcess, sleepFn });
              restartedForParent = true;
            }
          }
        }
      }
    } catch { /* ignore */ }
    cleanStalePid(opts.pidFilePath);
  }

  // Step 3: Spawn daemon (unless skipped for testing)
  if (opts._skipSpawn) {
    return { connected: false, port: opts.port, spawned: false };
  }

  // Ensure auth token exists before spawning
  ensureAuthToken(tokenPath);

  const spawnCommand = opts.spawnCommand ?? process.execPath;
  const spawnArgs = opts.spawnArgs ?? [process.argv[1], "daemon", "start", "--foreground"];
  let startMethod: EnsureDaemonResult["startMethod"] = "detached-spawn";
  let warning: string | undefined;
  let detachedStart: { getWarning: () => string | undefined } | undefined;

  if (enforceParent) {
    const systemdStart = startViaUserSystemd(opts, spawnCommand, spawnArgs);
    if (systemdStart.ok) {
      startMethod = "systemd-user";
    } else {
      warning = systemdStart.warning;
      detachedStart = startViaDetachedSpawn(opts, spawnCommand, spawnArgs);
    }
  } else {
    detachedStart = startViaDetachedSpawn(opts, spawnCommand, spawnArgs);
  }

  if (opts._skipHealthWait) {
    const detachedWarning = detachedStart?.getWarning();
    const combinedWarning = warning && detachedWarning ? `${warning}; ${detachedWarning}` : warning ?? detachedWarning;
    return { connected: false, port: opts.port, spawned: true, startMethod, warning: combinedWarning, restartedForParent };
  }

  // Step 4: Wait for health — only connect if version matches (if expected)
  const deadline = Date.now() + opts.spawnTimeoutMs;
  while (Date.now() < deadline) {
    const h = await checkDaemonHealth(opts.port, fetchFn);
    const accepted = await daemonResult(h, true, startMethod, warning, warning !== undefined);
    if (accepted) return accepted;
    await sleepFn(300);
  }

  const detachedWarning = detachedStart?.getWarning();
  const combinedWarning = warning && detachedWarning ? `${warning}; ${detachedWarning}` : warning ?? detachedWarning;
  return { connected: false, port: opts.port, spawned: true, startMethod, warning: combinedWarning, restartedForParent };
}
