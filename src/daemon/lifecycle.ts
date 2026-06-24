import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

const USER_SYSTEMD_PID_CACHE_TTL_MS = 5000;
const userSystemdPidCache = new Map<string, { pid: number | null; expiresAt: number }>();

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

  const cacheKey = `${procRoot}:${uid}`;
  const cached = userSystemdPidCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.pid;
  const cache = (pid: number | null): number | null => {
    userSystemdPidCache.set(cacheKey, { pid, expiresAt: now + USER_SYSTEMD_PID_CACHE_TTL_MS });
    return pid;
  };

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
          return cache(pid);
        }
      } catch {
        // Process may exit while scanning /proc; ignore and continue.
      }
    }
  } catch {
    return cache(null);
  }

  return cache(null);
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

function parentInvariantWarning(parent: ParentInspection): string {
  switch (parent.reason) {
    case "missing-pid":
      return "daemon PID file missing; daemon parent invariant is not verified";
    case "dead-pid":
      return `daemon PID ${parent.pid} is not running; daemon parent invariant is not verified`;
    case "pid-not-lcm-daemon":
      return `daemon PID ${parent.pid} is not an LCM daemon; daemon parent invariant is not verified`;
    case "parent-unknown":
      return `daemon PID ${parent.pid} parent could not be read; daemon parent invariant is not verified`;
    case "user-systemd-unavailable":
      return "user systemd manager unavailable; daemon parent invariant is not verified";
    default:
      return "daemon parent invariant is not verified";
  }
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

const SYSTEMD_PROVIDER_SECRET_ENV_NAMES = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
const SYSTEMD_LCM_SECRET_ENV_NAMES = new Set(["LCM_SUMMARY_API_KEY"]);
const SYSTEMD_SECRET_ENV_PATTERN = /(?:API_)?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/;
const SYSTEMD_CREDENTIAL_DIR_PREFIX = "lcm-systemd-credentials-";
const SYSTEMD_CREDENTIAL_SOURCE_MAX_AGE_MS = 10 * 60 * 1000;

function shouldPropagateDaemonEnv(name: string, value: string | undefined): value is string {
  return value !== undefined && (name === "PATH" || name.startsWith("LCM_") || SYSTEMD_PROVIDER_SECRET_ENV_NAMES.has(name));
}

function isSecretDaemonEnvName(name: string): boolean {
  return SYSTEMD_PROVIDER_SECRET_ENV_NAMES.has(name) || SYSTEMD_LCM_SECRET_ENV_NAMES.has(name);
}

function cleanupOldSystemdCredentialDirs(baseDir: string): void {
  const cutoff = Date.now() - SYSTEMD_CREDENTIAL_SOURCE_MAX_AGE_MS;
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(SYSTEMD_CREDENTIAL_DIR_PREFIX)) continue;
      const entryPath = join(baseDir, entry.name);
      try {
        if (statSync(entryPath).mtimeMs < cutoff) {
          rmSync(entryPath, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup only.
      }
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function systemdDaemonSetenvArgs(env: NodeJS.ProcessEnv, credentialNames: string[]): string[] {
  const args = Object.entries(env)
    .filter(([name, value]) => shouldPropagateDaemonEnv(name, value) && !SYSTEMD_SECRET_ENV_PATTERN.test(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `--setenv=${name}=${value ?? ""}`);
  if (credentialNames.length > 0) {
    args.push(`--setenv=LCM_SYSTEMD_CRED_IDS=${credentialNames.join(",")}`);
  }
  return args;
}

function systemdRunProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(result)) {
    if (SYSTEMD_SECRET_ENV_PATTERN.test(name)) delete result[name];
  }
  return result;
}

function systemdCredentialCleanup(credentialDir: string): () => void {
  return () => {
    try {
      rmSync(credentialDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only; the age-based cleanup handles leftovers.
    }
  };
}

function systemdDaemonCredentialArgs(env: NodeJS.ProcessEnv): { args: string[]; names: string[]; cleanup?: () => void } {
  const secrets = Object.entries(env)
    .filter(([name, value]) => shouldPropagateDaemonEnv(name, value) && isSecretDaemonEnvName(name))
    .sort(([left], [right]) => left.localeCompare(right));
  if (secrets.length === 0) return { args: [], names: [] };
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) {
    throw new Error("current user id is unavailable");
  }
  const baseDir = `/run/user/${uid}`;
  const baseStats = statSync(baseDir);
  if (!baseStats.isDirectory()) {
    throw new Error(`${baseDir} is not a directory`);
  }
  let credentialDir: string | undefined;
  try {
    cleanupOldSystemdCredentialDirs(baseDir);
    credentialDir = mkdtempSync(join(baseDir, SYSTEMD_CREDENTIAL_DIR_PREFIX));
    chmodSync(credentialDir, 0o700);
    const createdCredentialDir = credentialDir;
    const names: string[] = [];
    const args = secrets.map(([name, value]) => {
      const credentialPath = join(createdCredentialDir, name);
      writeFileSync(credentialPath, value ?? "", { mode: 0o600 });
      names.push(name);
      return `--property=LoadCredential=${name}:${credentialPath}`;
    });
    return {
      args,
      names,
      cleanup: systemdCredentialCleanup(createdCredentialDir),
    };
  } catch (err) {
    if (credentialDir) systemdCredentialCleanup(credentialDir)();
    throw err;
  }
}

function startViaUserSystemd(
  opts: EnsureDaemonOptions,
  spawnCommand: string,
  spawnArgs: string[],
): { ok: boolean; warning?: string; cleanup?: () => void } {
  const spawnSyncImpl = opts._spawnSyncOverride ?? spawnSync;
  const unit = `lcm-daemon-${process.pid}-${Date.now()}`;
  let credentials: { args: string[]; names: string[]; cleanup?: () => void };
  try {
    credentials = systemdDaemonCredentialArgs(process.env);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      warning: `user systemd credential setup failed (${detail}); used detached spawn fallback; daemon parent invariant is not satisfied`,
    };
  }
  let result: ReturnType<typeof spawnSyncImpl>;
  try {
    result = spawnSyncImpl("systemd-run", [
      "--user",
      "--collect",
      "--no-block",
      "--quiet",
      `--unit=${unit}`,
      ...systemdDaemonSetenvArgs(process.env, credentials.names),
      ...credentials.args,
      spawnCommand,
      ...spawnArgs,
    ], { encoding: "utf-8", env: systemdRunProcessEnv(process.env), timeout: Math.max(1, opts.spawnTimeoutMs) });
  } catch (err) {
    credentials.cleanup?.();
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      warning: `user systemd start failed (${detail}); used detached spawn fallback; daemon parent invariant is not satisfied`,
    };
  }

  if (result.status === 0) return { ok: true, cleanup: credentials.cleanup };
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const error = result.error instanceof Error ? result.error.message : "";
  const signal = result.signal ? `signal ${result.signal}` : "";
  const detail = stderr || stdout || error || signal || `exit status ${result.status ?? "unknown"}`;
  return {
    ok: false,
    warning: `user systemd start failed (${detail}); used detached spawn fallback; daemon parent invariant is not satisfied`,
    cleanup: credentials.cleanup,
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
    if (pid !== null && isLikelyLcmDaemonProcess(pid, procRoot)) {
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
    accessAlreadyVerified = false,
  ): Promise<EnsureDaemonResult | null> {
    if (health?.status !== "ok") return null;
    if (opts.expectedVersion && health.version !== opts.expectedVersion) return null;
    if (!accessAlreadyVerified && !await checkDaemonAccess(opts.port, tokenPath, fetchFn)) return null;

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
            warning: warning ?? parentInvariantWarning(parent),
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
      const accepted = await daemonResult(health, false, "existing", undefined, false, true);
      if (accepted) return accepted;
      if (enforceParent) {
        const parent = inspectParent();
        if (parent.available && parent.pid !== undefined && isLikelyLcmDaemonProcess(parent.pid, procRoot)) {
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
        if (retry?.status === "ok") {
          const retryHasAccess = await checkDaemonAccess(opts.port, tokenPath, fetchFn);
          if (retryHasAccess && opts.expectedVersion && retry.version !== opts.expectedVersion) {
            await terminatePidFileProcess();
          } else if (retryHasAccess) {
            const accepted = await daemonResult(retry, false, "existing", undefined, false, retryHasAccess);
            if (accepted) {
              return accepted;
            }
          }
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
  let cleanupSystemdCredentials: (() => void) | undefined;

  if (enforceParent) {
    const systemdStart = startViaUserSystemd(opts, spawnCommand, spawnArgs);
    cleanupSystemdCredentials = systemdStart.cleanup;
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
    cleanupSystemdCredentials?.();
    return { connected: false, port: opts.port, spawned: true, startMethod, warning: combinedWarning, restartedForParent };
  }

  // Step 4: Wait for health — only connect if version matches (if expected)
  const deadline = Date.now() + opts.spawnTimeoutMs;
  while (Date.now() < deadline) {
    const h = await checkDaemonHealth(opts.port, fetchFn);
    const accepted = await daemonResult(h, true, startMethod, warning, warning !== undefined);
    if (accepted) {
      cleanupSystemdCredentials?.();
      return accepted;
    }
    await sleepFn(300);
  }

  const detachedWarning = detachedStart?.getWarning();
  const combinedWarning = warning && detachedWarning ? `${warning}; ${detachedWarning}` : warning ?? detachedWarning;
  cleanupSystemdCredentials?.();
  return { connected: false, port: opts.port, spawned: true, startMethod, warning: combinedWarning, restartedForParent };
}
