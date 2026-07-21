import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { platform as osPlatform } from "node:os";
import { join, dirname, win32 } from "node:path";
import { ensureAuthToken, readAuthToken } from "./auth.js";
import { managedDaemonPath, SYSTEMD_DAEMON_PATH } from "./managed-path.js";
import { PKG_VERSION } from "./version.js";
import type { StorageBackend } from "./config.js";

type KillProcess = (pid: number, signal?: NodeJS.Signals | number) => void;
type SleepFn = (ms: number) => Promise<void>;
type SetTimeoutFn = (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
type ClearTimeoutFn = (timeout: ReturnType<typeof setTimeout>) => void;
type RequestDeadline = {
  timeoutMs: number;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
};

export type EnsureDaemonOptions = {
  port: number;
  pidFilePath: string;
  spawnTimeoutMs: number;
  expectedVersion?: string;
  expectedStorageBackend?: StorageBackend;
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
  _monotonicNowOverride?: () => number;
  _setTimeoutOverride?: SetTimeoutFn;
  _clearTimeoutOverride?: ClearTimeoutFn;
  _isProcessAliveOverride?: (pid: number) => boolean;
  /** @internal Deterministic listener-ownership seam for lifecycle tests. */
  _listeningPortsOverride?: (pid: number) => number[];
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

export type RestartDaemonOptions = EnsureDaemonOptions & {
  /** Optional caller validation hook. It always completes before any signal is sent. */
  validateBeforeRestart?: () => void | Promise<void>;
  _ensureDaemonOverride?: (options: EnsureDaemonOptions) => Promise<EnsureDaemonResult>;
  _isManagedProcessOverride?: (pid: number) => boolean;
};

export type RestartDaemonResult = EnsureDaemonResult & {
  restarted: boolean;
  stoppedPid?: number;
};

type HealthResponse = {
  status: string;
  version?: string;
  storageBackend?: StorageBackend;
  uptime?: number;
  pid?: number;
};

function healthVersionMatches(health: HealthResponse | null, expectedVersion: string | undefined): boolean {
  return typeof expectedVersion === "string"
    && expectedVersion.length > 0
    && typeof health?.version === "string"
    && health.version === expectedVersion;
}

function healthStorageBackendMatches(
  health: HealthResponse | null,
  expectedStorageBackend: StorageBackend,
): boolean {
  // Daemons predating backend identity were necessarily SQLite-only.
  return (health?.storageBackend ?? "sqlite") === expectedStorageBackend;
}

const USER_SYSTEMD_PID_CACHE_TTL_MS = 5000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const STORAGE_BACKEND_AUTH_WARNING = "daemon reuse or replacement was blocked because the storage-backend mismatch could not be authenticated or terminated safely; verify the local daemon token, stop the existing daemon if necessary, and retry";
const userSystemdPidCache = new Map<string, { pid: number | null; expiresAt: number }>();

type ProcessDiagnosticSource =
  | "credential setup error"
  | "systemd start exception"
  | "systemd stderr"
  | "systemd stdout"
  | "systemd process error"
  | "detached spawn error";

const PROCESS_ERROR_CODES = new Set([
  "E2BIG", "EACCES", "EADDRINUSE", "EAGAIN", "ECONNREFUSED", "ECONNRESET",
  "EEXIST", "EHOSTUNREACH", "EINTR", "EINVAL", "EIO", "EISDIR", "EMFILE",
  "ENETUNREACH", "ENOENT", "ENOMEM", "ENOSPC", "ENOTDIR", "ENOTEMPTY",
  "ENOTFOUND", "ENOTSUP", "EPERM", "EPIPE", "ESRCH", "ETIMEDOUT",
]);
const PROCESS_ERROR_CLASSIFICATIONS = new Map<string, string>([
  ["EACCES", "permission denied"], ["EPERM", "permission denied"],
  ["ENOENT", "executable or resource unavailable"], ["ENOTDIR", "executable or resource unavailable"],
  ["ETIMEDOUT", "operation timed out"],
  ["ECONNREFUSED", "service unavailable"], ["ECONNRESET", "service unavailable"],
  ["EHOSTUNREACH", "service unavailable"], ["ENETUNREACH", "service unavailable"],
  ["ENOMEM", "local resource limit reached"], ["ENOSPC", "local resource limit reached"],
  ["EMFILE", "local resource limit reached"],
  ["EINVAL", "invalid process invocation"], ["E2BIG", "invalid process invocation"],
]);
const PROCESS_TEXT_CLASSIFICATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:permission denied|access denied)\b/i, "permission denied"],
  [/\b(?:not found|no such|no medium)\b/i, "executable or resource unavailable"],
  [/\b(?:timed out|timeout)\b/i, "operation timed out"],
  [/\b(?:connection refused|unreachable)\b/i, "service unavailable"],
];
const PROCESS_SIGNALS = new Set([
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP",
  "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGSTOP",
  "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGUSR1",
  "SIGUSR2", "SIGXCPU", "SIGXFSZ",
]);

/** Summarize untrusted process output without reproducing any of its text. */
function summarizeProcessDiagnostic(source: ProcessDiagnosticSource, value: unknown): string {
  let text = "";
  let suppliedCode: unknown;
  try {
    if (value instanceof Error) {
      text = value.message.slice(0, 4096);
      suppliedCode = (value as NodeJS.ErrnoException).code;
    } else if (typeof value === "string") {
      text = value.slice(0, 4096);
    }
  } catch {
    // Hostile Error subclasses must not escape diagnostic handling.
  }
  // Normalize controls only for classification. No portion of this text is returned.
  text = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

  const normalizedCode = typeof suppliedCode === "string" ? suppliedCode.toUpperCase() : "";
  const textCode = text.toUpperCase().match(/\bE[A-Z0-9_]{2,31}\b/g)
    ?.find((candidate) => PROCESS_ERROR_CODES.has(candidate));
  const code = PROCESS_ERROR_CODES.has(normalizedCode) ? normalizedCode : textCode;

  const classification = code
    ? PROCESS_ERROR_CLASSIFICATIONS.get(code) ?? "process reported a failure"
    : PROCESS_TEXT_CLASSIFICATIONS.find(([pattern]) => pattern.test(text))?.[1]
      ?? "process reported a failure";

  return `${source}: ${classification}${code ? `; code ${code}` : ""}`;
}

function summarizeProcessExit(status: unknown, signal: unknown): string {
  if (typeof signal === "string" && PROCESS_SIGNALS.has(signal)) return `signal ${signal}`;
  if (typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 255) {
    return `exit status ${status}`;
  }
  return "process exit unavailable";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function validateSpawnTimeout(spawnTimeoutMs: number): void {
  if (!Number.isFinite(spawnTimeoutMs) || spawnTimeoutMs < 0 || spawnTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`spawnTimeoutMs must be between 0 and ${MAX_TIMER_DELAY_MS}`);
  }
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

function isLikelyLcmDaemonCommand(command: string | null): boolean {
  if (!command) return false;
  const parts = command.split(/\s+/);
  return command.includes("lcm") && parts.includes("daemon") && parts.includes("start");
}

function isLikelyLcmDaemonProcess(pid: number, procRoot = "/proc"): boolean {
  return isLikelyLcmDaemonCommand(readProcessCommand(pid, procRoot));
}

function resolveWindowsNetstatPath(
  systemRoot: string | undefined,
  windir: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  for (const candidate of [systemRoot, windir]) {
    if (typeof candidate !== "string") continue;
    const normalized = win32.normalize(candidate.trim()).replace(/[\\/]+$/, "");
    // SystemRoot/WINDIR should identify the OS Windows directory itself. Do
    // not accept arbitrary absolute directories supplied through the process
    // environment, UNC paths, relative paths, or executable search fallback.
    if (!/^[A-Za-z]:\\Windows$/i.test(normalized)) continue;
    const executable = win32.join(normalized, "System32", "netstat.exe");
    if (fileExists(executable)) return executable;
  }
  return null;
}

function findListeningTcpPorts(
  pid: number,
  platform: NodeJS.Platform,
  spawnSyncImpl: typeof spawnSync,
  procRoot = "/proc",
  targetPort?: number,
  windowsNetstatPath = resolveWindowsNetstatPath(process.env.SystemRoot, process.env.WINDIR),
): number[] {
  if (platform === "linux") {
    try {
      const socketInodes = new Set<string>();
      for (const entry of readdirSync(join(procRoot, String(pid), "fd"))) {
        try {
          const target = readlinkSync(join(procRoot, String(pid), "fd", entry));
          const match = /^socket:\[(\d+)\]$/.exec(target);
          if (match) socketInodes.add(match[1]);
        } catch {
          // File descriptors can disappear while the process is running.
        }
      }
      const ports = new Set<number>();
      for (const table of ["tcp", "tcp6"]) {
        let rows: string;
        try {
          rows = readFileSync(join(procRoot, "net", table), "utf-8");
        } catch {
          continue;
        }
        for (const row of rows.split(/\r?\n/).slice(1)) {
          const columns = row.trim().split(/\s+/);
          // Canonical /proc/net/tcp tokenization is: sl=0, local=1,
          // remote=2, state=3, queues/timers=4..6, uid=7, timeout=8,
          // inode=9, followed by ref/pointer fields.
          if (columns.length < 10 || columns[3] !== "0A" || !socketInodes.has(columns[9])) continue;
          const [addressHex, portHex] = columns[1]!.split(":");
          // Requests are sent specifically to 127.0.0.1. A socket on another
          // loopback address does not prove ownership of that endpoint.
          if (addressHex !== "0100007F") continue;
          const port = portHex ? Number.parseInt(portHex, 16) : NaN;
          if (Number.isInteger(port) && port >= 1 && port <= 65_535 && (targetPort === undefined || port === targetPort)) ports.add(port);
        }
      }
      return [...ports].sort((a, b) => a - b);
    } catch {
      return [];
    }
  }
  if (platform === "win32") {
    if (windowsNetstatPath === null) return [];
    try {
      const result = spawnSyncImpl(windowsNetstatPath, ["-ano", "-p", "tcp"], {
        encoding: "utf-8", timeout: 1000, maxBuffer: 256 * 1024,
      });
      if (result.status !== 0 || typeof result.stdout !== "string") return [];
      const ports = new Set<number>();
      for (const line of result.stdout.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP" || columns[3]?.toUpperCase() !== "LISTENING") continue;
        if (Number.parseInt(columns[4], 10) !== pid) continue;
        if (!columns[1]?.startsWith("127.0.0.1:")) continue;
        const port = Number.parseInt(columns[1]?.match(/:(\d+)$/)?.[1] ?? "", 10);
        if (Number.isInteger(port) && port >= 1 && port <= 65_535 && (targetPort === undefined || port === targetPort)) ports.add(port);
      }
      return [...ports].sort((a, b) => a - b);
    } catch {
      return [];
    }
  }
  try {
    const command = platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
    const result = spawnSyncImpl(command, [
      "-nP",
      "-a",
      "-p", String(pid),
      "-iTCP",
      "-sTCP:LISTEN",
      "-Fn",
    ], {
      encoding: "utf-8",
      timeout: 1000,
      maxBuffer: 64 * 1024,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    const ports = new Set<number>();
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.startsWith("n127.0.0.1:")) continue;
      const match = line.match(/:(\d+)(?:\s+\(LISTEN\))?$/);
      if (!match) continue;
      const port = Number.parseInt(match[1], 10);
      if (Number.isInteger(port) && port >= 1 && port <= 65_535 && (targetPort === undefined || port === targetPort)) ports.add(port);
      if (targetPort !== undefined && ports.has(targetPort)) break;
      if (ports.size >= 32) break;
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
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
    procRoot: string;
    uid?: number;
    isAlive: (pid: number) => boolean;
  },
): ParentInspection {
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

async function requestDaemonHealth(
  port: number,
  fetchFn: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<HealthResponse | null> {
  try {
    const url = `http://127.0.0.1:${port}/health`;
    const res = await fetchFn(url, { signal });
    return res.ok ? (await res.json()) as HealthResponse : null;
  } catch {
    return null;
  }
}

async function runWithDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  deadline: RequestDeadline,
): Promise<T> {
  const controller = new AbortController();
  let rejectTimeout!: (reason?: unknown) => void;
  const timeout = new Promise<never>((
    _resolve: (value: never | PromiseLike<never>) => void,
    reject: (reason?: unknown) => void,
  ): void => {
    rejectTimeout = reject;
  });
  const timeoutHandle = deadline.setTimeoutFn((): void => {
    controller.abort();
    rejectTimeout(new Error("daemon request timed out"));
  }, deadline.timeoutMs);
  try {
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    deadline.clearTimeoutFn(timeoutHandle);
  }
}

async function checkDaemonHealth(
  port: number,
  fetchFn: typeof globalThis.fetch,
  deadline: RequestDeadline,
): Promise<HealthResponse | null> {
  try {
    return await runWithDeadline(
      (signal: AbortSignal): Promise<HealthResponse | null> => requestDaemonHealth(port, fetchFn, signal),
      deadline,
    );
  } catch {
    return null;
  }
}

async function checkDaemonAccess(
  port: number,
  tokenPath: string,
  fetchFn: typeof globalThis.fetch,
  deadline: RequestDeadline,
): Promise<boolean> {
  const token = readAuthToken(tokenPath);
  if (!token) return false;
  const request = async (signal: AbortSignal): Promise<boolean> => {
    const res = await fetchFn(`http://127.0.0.1:${port}/stats/pool`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    return res.ok;
  };
  try {
    return await runWithDeadline((signal: AbortSignal): Promise<boolean> => request(signal), deadline);
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
    errorMessage = summarizeProcessDiagnostic("detached spawn error", err);
    return { getWarning: () => `detached spawn failed (${errorMessage})` };
  }
  child.once("error", (err) => {
    errorMessage = summarizeProcessDiagnostic("detached spawn error", err);
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
const SYSTEMD_LCM_SECRET_ENV_NAMES = new Set(["LCM_SUMMARY_API_KEY", "LCM_POSTGRES_URL"]);
const SYSTEMD_SECRET_ENV_PATTERN = /(?:API_)?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/;
const SYSTEMD_CREDENTIAL_DIR_PREFIX = "lcm-systemd-credentials-";
const SYSTEMD_CREDENTIAL_SOURCE_MAX_AGE_MS = 10 * 60 * 1000;
function shouldPropagateDaemonEnv(name: string, value: string | undefined): value is string {
  return value !== undefined && (name.startsWith("LCM_") || SYSTEMD_PROVIDER_SECRET_ENV_NAMES.has(name));
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

function systemdDaemonSetenvArgs(
  env: NodeJS.ProcessEnv,
  credentialNames: string[],
  executablePath = SYSTEMD_DAEMON_PATH,
): string[] {
  const args = Object.entries(env)
    .filter(([name, value]) => (
      shouldPropagateDaemonEnv(name, value)
      && !isSecretDaemonEnvName(name)
      && !SYSTEMD_SECRET_ENV_PATTERN.test(name)
    ))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `--setenv=${name}=${value}`);
  args.push(`--setenv=PATH=${executablePath}`);
  if (credentialNames.length > 0) {
    args.push(`--setenv=LCM_SYSTEMD_CRED_IDS=${credentialNames.join(",")}`);
  }
  return args;
}

function systemdRunProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(result)) {
    if (isSecretDaemonEnvName(name) || SYSTEMD_SECRET_ENV_PATTERN.test(name)) delete result[name];
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
      writeFileSync(credentialPath, value!, { mode: 0o600 });
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
    const detail = summarizeProcessDiagnostic("credential setup error", err);
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
      ...systemdDaemonSetenvArgs(process.env, credentials.names, managedDaemonPath(spawnCommand, spawnArgs)),
      ...credentials.args,
      spawnCommand,
      ...spawnArgs,
    ], { encoding: "utf-8", env: systemdRunProcessEnv(process.env), timeout: Math.max(1, opts.spawnTimeoutMs) });
  } catch (err) {
    credentials.cleanup?.();
    const detail = summarizeProcessDiagnostic("systemd start exception", err);
    return {
      ok: false,
      warning: `user systemd start failed (${detail}); used detached spawn fallback; daemon parent invariant is not satisfied`,
    };
  }

  if (result.status === 0) return { ok: true, cleanup: credentials.cleanup };
  const stderr = typeof result.stderr === "string" && result.stderr.length > 0
    ? summarizeProcessDiagnostic("systemd stderr", result.stderr)
    : "";
  const stdout = typeof result.stdout === "string" && result.stdout.length > 0
    ? summarizeProcessDiagnostic("systemd stdout", result.stdout)
    : "";
  const error = result.error instanceof Error
    ? summarizeProcessDiagnostic("systemd process error", result.error)
    : "";
  const detail = stderr || stdout || error || summarizeProcessExit(result.status, result.signal);
  return {
    ok: false,
    warning: `user systemd start failed (${detail}); used detached spawn fallback; daemon parent invariant is not satisfied`,
    cleanup: credentials.cleanup,
  };
}

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  validateSpawnTimeout(opts.spawnTimeoutMs);

  const fetchFn = opts._fetchOverride ?? globalThis.fetch;
  const tokenPath = join(dirname(opts.pidFilePath), "daemon.token");
  const platform = opts._platform ?? osPlatform();
  const procRoot = opts._procRoot ?? "/proc";
  const sleepFn = opts._sleepOverride ?? sleep;
  const monotonicNow = opts._monotonicNowOverride ?? performance.now.bind(performance);
  const setTimeoutFn = opts._setTimeoutOverride ?? setTimeout;
  const clearTimeoutFn = opts._clearTimeoutOverride ?? clearTimeout;
  const deadline = monotonicNow() + opts.spawnTimeoutMs;
  const isAlive = opts._isProcessAliveOverride ?? isProcessAlive;
  const killProcess = opts._killOverride ?? ((pid, signal) => {
    process.kill(pid, signal);
  });
  const enforceParent = opts.enforceUserManagerParent === true && platform === "linux";
  const expectedVersion = opts.expectedVersion ?? PKG_VERSION;
  const expectedStorageBackend = opts.expectedStorageBackend ?? "sqlite";
  let restartedForParent = false;

  if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon identity could not be verified because the installed version is unknown",
    };
  }

  function endpointIdentityMatches(health: HealthResponse | null): boolean {
    if (health?.status !== "ok" || health.pid === undefined) return false;
    const pid = readPidFile(opts.pidFilePath);
    if (pid === null || health.pid !== pid || !isAlive(pid)) return false;
    const listenerPorts = opts._listeningPortsOverride
      ? opts._listeningPortsOverride(pid)
      : findListeningTcpPorts(pid, platform, opts._spawnSyncOverride ?? spawnSync, procRoot, opts.port);
    return listenerPorts.includes(opts.port);
  }

  function remainingRequestDeadline(): RequestDeadline | null {
    const timeoutMs = deadline - monotonicNow();
    return timeoutMs <= 0 ? null : { timeoutMs, setTimeoutFn, clearTimeoutFn };
  }

  function inspectParent(): ParentInspection {
    return inspectDaemonParent(opts.pidFilePath, {
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

  async function terminateAuthenticatedDaemon(health: HealthResponse): Promise<boolean> {
    const authenticatedPid = health.pid;
    if (authenticatedPid === undefined || !endpointIdentityMatches(health)) return false;
    if (!isLikelyLcmDaemonProcess(authenticatedPid, procRoot)) return false;
    await terminatePid(authenticatedPid, { isAlive, killProcess, sleepFn });
    if (isAlive(authenticatedPid)) return false;
    const currentPid = readPidFile(opts.pidFilePath);
    if (currentPid === authenticatedPid) cleanStalePid(opts.pidFilePath);
    return currentPid === null || currentPid === authenticatedPid;
  }

  /** Stop backend transitions only after local-token access; retain legacy version-repair behavior. */
  async function repairMismatchedDaemon(
    health: HealthResponse,
    identityMatches: boolean,
    versionMatches: boolean,
    storageBackendMatches: boolean,
    hasAccess: boolean,
  ): Promise<"none" | "terminated" | "blocked"> {
    if (!identityMatches) return "none";
    if (!storageBackendMatches) {
      if (!hasAccess) return "blocked";
      return await terminateAuthenticatedDaemon(health) ? "terminated" : "blocked";
    }
    if (versionMatches) return "none";
    await terminatePidFileProcess();
    return "terminated";
  }

  async function daemonResult(
    health: HealthResponse | null,
    spawned: boolean,
    startMethod: EnsureDaemonResult["startMethod"],
    access: { alreadyVerified: true } | { alreadyVerified: false; deadline: number },
    warning?: string,
    allowParentWarning = false,
  ): Promise<EnsureDaemonResult | null> {
    if (health === null || !endpointIdentityMatches(health)) return null;
    if (!healthVersionMatches(health, expectedVersion)) return null;
    if (!healthStorageBackendMatches(health, expectedStorageBackend)) return null;
    if (!access.alreadyVerified) {
      const accessTimeoutMs = access.deadline - monotonicNow();
      if (accessTimeoutMs <= 0) return null;
      const deadlineOptions = {
        timeoutMs: accessTimeoutMs,
        setTimeoutFn,
        clearTimeoutFn,
      };
      if (!await checkDaemonAccess(opts.port, tokenPath, fetchFn, deadlineOptions)) return null;
    }

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
      // Endpoint identity verification above proves health.pid is the live
      // PID-file process, so it is the authoritative fallback here.
      pid: parent?.pid ?? health.pid,
      parentPid: parent?.parentPid,
      userSystemdPid: parent?.userSystemdPid,
      restartedForParent,
      startMethod,
      warning,
    };
  }

  // Step 1: Check if daemon is already running via health check
  const initialHealthDeadline = remainingRequestDeadline();
  const health = initialHealthDeadline
    ? await checkDaemonHealth(opts.port, fetchFn, initialHealthDeadline)
    : null;
  if (health?.status === "ok") {
    const initialAccessDeadline = remainingRequestDeadline();
    const identityMatches = endpointIdentityMatches(health);
    const versionMatches = healthVersionMatches(health, expectedVersion);
    const storageBackendMatches = healthStorageBackendMatches(health, expectedStorageBackend);
    const hasAccess = identityMatches && (versionMatches || !storageBackendMatches) && initialAccessDeadline
      ? await checkDaemonAccess(opts.port, tokenPath, fetchFn, initialAccessDeadline)
      : false;
    const mismatchRepair = await repairMismatchedDaemon(
      health,
      identityMatches,
      versionMatches,
      storageBackendMatches,
      hasAccess,
    );
    if (mismatchRepair === "blocked") {
      return { connected: false, port: opts.port, spawned: false, warning: STORAGE_BACKEND_AUTH_WARNING };
    }
    if (mismatchRepair === "none") {
      if (hasAccess) {
        const accepted = await daemonResult(health, false, "existing", { alreadyVerified: true });
        if (accepted) return accepted;
        // A null result here can only be the verified wrong-parent case: health,
        // access, and version were already accepted, while unavailable identity
        // metadata returns a connected result with a warning.
        const parent = inspectParent();
        // Revalidate the authenticated endpoint and PID immediately before a
        // signal; concurrent lifecycle operations may have replaced either.
        if (endpointIdentityMatches(health)
          && parent.available
          && parent.pid !== undefined
          && health.pid !== undefined
          && parent.pid === health.pid
          && isLikelyLcmDaemonProcess(parent.pid, procRoot)) {
          await terminatePid(parent.pid, { isAlive, killProcess, sleepFn });
          restartedForParent = true;
        }
      }
      cleanStalePid(opts.pidFilePath);
    }
  }

  // Step 2: Check PID file for stale process
  if (existsSync(opts.pidFilePath)) {
    let repairedMismatch = false;
    try {
      const pid = parseInt(readFileSync(opts.pidFilePath, "utf-8").trim(), 10);
      if (!isNaN(pid) && isAlive(pid)) {
        const sleepRemainingMs = deadline - monotonicNow();
        if (sleepRemainingMs > 0) await sleepFn(Math.min(1000, sleepRemainingMs));
        const retryHealthDeadline = remainingRequestDeadline();
        const retry = retryHealthDeadline
          ? await checkDaemonHealth(opts.port, fetchFn, retryHealthDeadline)
          : null;
        if (retry?.status === "ok") {
          const retryAccessDeadline = remainingRequestDeadline();
          const retryIdentityMatches = endpointIdentityMatches(retry);
          const retryVersionMatches = healthVersionMatches(retry, expectedVersion);
          const retryStorageBackendMatches = healthStorageBackendMatches(retry, expectedStorageBackend);
          const retryHasAccess = retryIdentityMatches && (retryVersionMatches || !retryStorageBackendMatches) && retryAccessDeadline
            ? await checkDaemonAccess(opts.port, tokenPath, fetchFn, retryAccessDeadline)
            : false;
          const mismatchRepair = await repairMismatchedDaemon(
            retry,
            retryIdentityMatches,
            retryVersionMatches,
            retryStorageBackendMatches,
            retryHasAccess,
          );
          if (mismatchRepair === "blocked") {
            return { connected: false, port: opts.port, spawned: false, warning: STORAGE_BACKEND_AUTH_WARNING };
          }
          repairedMismatch = mismatchRepair === "terminated";
          if (mismatchRepair === "none" && retryHasAccess) {
            const accepted = await daemonResult(retry, false, "existing", { alreadyVerified: true });
            if (accepted) {
              return accepted;
            }
          }
        }
        if (enforceParent && !repairedMismatch) {
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
    if (!repairedMismatch) cleanStalePid(opts.pidFilePath);
  }

  // Step 3: Spawn daemon (unless skipped for testing)
  if (opts._skipSpawn || monotonicNow() >= deadline) {
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
  while (true) {
    const attemptTimeoutMs = deadline - monotonicNow();
    if (attemptTimeoutMs <= 0) break;
    const h = await checkDaemonHealth(opts.port, fetchFn, {
      timeoutMs: attemptTimeoutMs,
      setTimeoutFn,
      clearTimeoutFn,
    });
    const accepted = await daemonResult(
      h,
      true,
      startMethod,
      { alreadyVerified: false, deadline },
      warning,
      warning !== undefined,
    );
    if (accepted) {
      cleanupSystemdCredentials?.();
      return accepted;
    }
    const remainingMs = deadline - monotonicNow();
    if (remainingMs <= 0) break;
    await sleepFn(Math.min(300, remainingMs));
  }

  const detachedWarning = detachedStart?.getWarning();
  const combinedWarning = warning && detachedWarning ? `${warning}; ${detachedWarning}` : warning ?? detachedWarning;
  cleanupSystemdCredentials?.();
  return { connected: false, port: opts.port, spawned: true, startMethod, warning: combinedWarning, restartedForParent };
}

/**
 * Safely stop the verified PID-file daemon and ensure a daemon is running with
 * the caller's already-resolved options. Callers should derive `port` and other
 * options from validated configuration; `validateBeforeRestart` is available
 * when validation and restart need to be kept in one operation.
 */
export async function restartDaemon(opts: RestartDaemonOptions): Promise<RestartDaemonResult> {
  validateSpawnTimeout(opts.spawnTimeoutMs);
  const {
    validateBeforeRestart,
    _ensureDaemonOverride,
    _isManagedProcessOverride,
    ...ensureOptions
  } = opts;
  await validateBeforeRestart?.();

  const isAlive = opts._isProcessAliveOverride ?? isProcessAlive;
  const platform = opts._platform ?? osPlatform();
  const fetchFn = opts._fetchOverride ?? globalThis.fetch;
  const tokenPath = join(dirname(opts.pidFilePath), "daemon.token");
  const expectedVersion = opts.expectedVersion ?? PKG_VERSION;
  const monotonicNow = opts._monotonicNowOverride ?? performance.now.bind(performance);
  const setTimeoutFn = opts._setTimeoutOverride ?? setTimeout;
  const clearTimeoutFn = opts._clearTimeoutOverride ?? clearTimeout;
  const verificationDeadline = monotonicNow() + opts.spawnTimeoutMs;
  function remainingVerificationDeadline(): RequestDeadline | null {
    const timeoutMs = verificationDeadline - monotonicNow();
    return timeoutMs <= 0 ? null : { timeoutMs, setTimeoutFn, clearTimeoutFn };
  }
  async function isAuthenticatedDaemonAtPort(port: number, pid: number): Promise<boolean> {
    const healthDeadline = remainingVerificationDeadline();
    if (!healthDeadline) return false;
    const health = await checkDaemonHealth(port, fetchFn, healthDeadline);
    if (health?.status !== "ok" || health.pid !== pid) return false;
    if (!healthVersionMatches(health, expectedVersion)) return false;
    // The current daemon may legitimately use a different backend during a
    // configured transition. Authenticate it independently; ensureOptions
    // applies expectedStorageBackend to the replacement below.
    const accessDeadline = remainingVerificationDeadline();
    if (!accessDeadline || !await checkDaemonAccess(port, tokenPath, fetchFn, accessDeadline)) return false;
    return true;
  }
  async function isManaged(pid: number): Promise<boolean> {
    if (_isManagedProcessOverride) return _isManagedProcessOverride(pid);
    if (platform === "linux" && !isLikelyLcmDaemonProcess(pid, opts._procRoot ?? "/proc")) return false;
    const listenerPorts = opts._listeningPortsOverride
      ? opts._listeningPortsOverride(pid)
      : findListeningTcpPorts(pid, platform, opts._spawnSyncOverride ?? spawnSync, opts._procRoot ?? "/proc", opts.port);
    if (!listenerPorts.includes(opts.port)) return false;
    return await isAuthenticatedDaemonAtPort(opts.port, pid);
  }
  const killProcess = opts._killOverride ?? ((pid: number, signal?: NodeJS.Signals | number) => {
    process.kill(pid, signal);
  });
  const sleepFn = opts._sleepOverride ?? sleep;
  let restarted = false;
  let stoppedPid: number | undefined;

  const pid = readPidFile(opts.pidFilePath);
  if (pid === null) {
    cleanStalePid(opts.pidFilePath);
  } else if (!isAlive(pid)) {
    cleanStalePid(opts.pidFilePath);
  } else {
    if (!await isManaged(pid)) {
      throw new Error(`Refusing to restart: PID ${pid} is running but is not a verified LCM daemon.`);
    }
    await terminatePid(pid, { isAlive, killProcess, sleepFn });
    if (isAlive(pid)) {
      throw new Error(`Unable to stop verified LCM daemon PID ${pid}; restart aborted.`);
    }
    cleanStalePid(opts.pidFilePath);
    restarted = true;
    stoppedPid = pid;
  }

  const ensure = _ensureDaemonOverride ?? ensureDaemon;
  const result = await ensure(ensureOptions);
  if (!restarted && result.connected && !result.spawned) {
    throw new Error(
      "Refusing to report a restart: a daemon is reachable but no verified daemon PID was available to stop.",
    );
  }
  return { ...result, restarted, stoppedPid };
}

/** Internal branch-level seams used by the daemon lifecycle test suite. */
export const __lifecycleTestUtils = {
  findListeningTcpPorts,
  healthVersionMatches,
  healthStorageBackendMatches,
  inspectDaemonParent,
  parentInvariantWarning,
  resolveWindowsNetstatPath,
  systemdDaemonSetenvArgs,
  systemdRunProcessEnv,
};
