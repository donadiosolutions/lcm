import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { platform as osPlatform } from "node:os";
import { join, dirname, posix, win32 } from "node:path";
import { ensureAuthToken, readAuthToken } from "./auth.js";
import { managedDaemonPath, SYSTEMD_DAEMON_PATH } from "./managed-path.js";
import { PACKAGED_RUNTIME_ENTRYPOINT, PKG_VERSION, RUNTIME_DIGEST } from "./version.js";
import type { StorageBackend } from "./config.js";
import {
  isStagedPostgreSqlHealth,
  STAGED_POSTGRESQL_ERROR_CODE,
} from "./staged-postgresql.js";
import {
  daemonLifecycleTestIdentityArgs,
  type DaemonLifecycleHermeticTestSeams,
  type DaemonLifecycleTestScope,
  isDaemonLifecycleHermeticTestSeams,
  isDaemonLifecycleTestScope,
  isVitestWorkerEntrypoint,
  assertLifecycleScopeOwnsCurrentCleanupRoot,
  lifecycleHermeticSeamsOwnsExactStatePaths,
  lifecycleScopeFilesystemIsCurrent,
  lifecycleScopeOwnsExactStatePaths,
  lifecycleScopeUnitName,
} from "./lifecycle-scope.js";

type KillProcess = (pid: number, signal?: NodeJS.Signals | number) => void;
type SleepFn = (ms: number) => Promise<void>;
type SetTimeoutFn = (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
type ClearTimeoutFn = (timeout: ReturnType<typeof setTimeout>) => void;
type CleanupFn = () => void | Promise<void>;
type RequestDeadline = {
  timeoutMs: number;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  abortSignal?: AbortSignal;
};

async function runCleanupStages(stages: readonly CleanupFn[]): Promise<void> {
  const errors: unknown[] = [];
  for (const stage of stages) {
    try {
      await stage();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "daemon lifecycle cleanup failed");
  }
}

function defaultKillProcess(pid: number, signal?: NodeJS.Signals | number): void {
  process.kill(pid, signal);
}

export type EnsureDaemonOptions = {
  port: number;
  pidFilePath: string;
  spawnTimeoutMs: number;
  expectedVersion?: string;
  expectedStorageBackend?: StorageBackend;
  expectedEntrypoint?: string;
  expectedRuntimeDigest?: string;
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
  /** @internal Deterministic executable-canonicalization seam for lifecycle tests. */
  _realpathOverride?: (path: string) => string;
  /** @internal Deterministic packaged-entrypoint seam for lifecycle tests. */
  _packagedEntrypointOverride?: string;
  /** @internal Deterministic listener-ownership seam for lifecycle tests. */
  _listeningPortsOverride?: (pid: number) => number[];
  /** @internal Complete run-owned lifecycle boundary for systemd integration tests. */
  _testScope?: DaemonLifecycleTestScope;
  /** @internal Complete hermetic side-effect boundary for production-mode lifecycle tests. */
  _hermeticTestSeams?: DaemonLifecycleHermeticTestSeams;
  /** @internal Deterministic interruption seam for lifecycle tests. */
  _abortSignal?: AbortSignal;
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

type ResolvedLifecycleDependencies = Readonly<{
  environment: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  spawn: typeof spawn;
  spawnSync: typeof spawnSync;
  killProcess: KillProcess;
  isProcessAlive: (pid: number) => boolean;
  sleep: SleepFn;
  realpath: (path: string) => string;
  platform: NodeJS.Platform;
  procRoot: string;
  uid: number | undefined;
}>;

function scopedLifecycleEnvironment(
  scope: DaemonLifecycleTestScope,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.LCM_DATABASE_PATH;
  return {
    ...environment,
    HOME: scope.homeDir,
    USERPROFILE: scope.homeDir,
    XDG_RUNTIME_DIR: scope.runtimeDir,
    LCM_DAEMON_OWNER_ID: scope.ownerId,
  };
}

function resolveLifecycleDependencies(
  opts: EnsureDaemonOptions,
): ResolvedLifecycleDependencies {
  const testDependencies = opts._testScope?.dependencies;
  const hermeticSeams = opts._hermeticTestSeams;
  return {
    environment: opts._testScope
      ? scopedLifecycleEnvironment(opts._testScope)
      : hermeticSeams?.environment ?? process.env,
    fetch: testDependencies?.fetch
      ?? hermeticSeams?.fetch
      ?? opts._fetchOverride
      ?? globalThis.fetch,
    spawn: testDependencies?.spawn
      ?? hermeticSeams?.spawn
      ?? opts._spawnOverride
      ?? spawn,
    spawnSync: testDependencies?.spawnSync
      ?? hermeticSeams?.spawnSync
      ?? opts._spawnSyncOverride
      ?? spawnSync,
    killProcess: testDependencies?.killProcess
      ?? hermeticSeams?.killProcess
      ?? opts._killOverride
      ?? defaultKillProcess,
    isProcessAlive: testDependencies?.isProcessAlive
      ?? hermeticSeams?.isProcessAlive
      ?? opts._isProcessAliveOverride
      ?? isProcessAlive,
    sleep: testDependencies?.sleep
      ?? hermeticSeams?.sleep
      ?? opts._sleepOverride
      ?? sleep,
    realpath: hermeticSeams?.realpath ?? opts._realpathOverride ?? realpathSync,
    platform: hermeticSeams?.platform ?? opts._platform ?? osPlatform(),
    procRoot: hermeticSeams?.procRoot ?? opts._procRoot ?? "/proc",
    uid: hermeticSeams?.uid ?? opts._uid,
  };
}

function lifecycleUnitName(
  opts: EnsureDaemonOptions,
  pid: number,
  nonce: number,
): string {
  if (opts._testScope) return lifecycleScopeUnitName(opts._testScope, pid, nonce);
  if (opts._hermeticTestSeams) return `lcm-test-daemon-hermetic-${pid}-${nonce}`;
  return `lcm-daemon-${pid}-${nonce}`;
}

function lifecycleSpawnEnvironment(
  opts: EnsureDaemonOptions,
  dependencies: ResolvedLifecycleDependencies,
): NodeJS.ProcessEnv {
  if (opts._testScope) return { ...dependencies.environment };
  if (opts._hermeticTestSeams) {
    return {
      ...dependencies.environment,
      HOME: opts._hermeticTestSeams.homeDir,
      USERPROFILE: opts._hermeticTestSeams.homeDir,
      XDG_RUNTIME_DIR: opts._hermeticTestSeams.runtimeDir,
    };
  }
  return { ...process.env };
}

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
  entrypoint?: string;
  runtimeDigest?: string;
  ownerId?: string;
  httpStatus?: number;
  storage?: {
    status?: string;
    error?: {
      code?: string;
      backend?: string;
      domain?: string;
      operation?: string;
    };
  };
};

function isRecognizedDaemonHealth(health: HealthResponse | null): health is HealthResponse {
  return health?.status === "ok"
    || isStagedPostgreSqlHealth(health?.httpStatus ?? 0, health);
}

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

function healthRuntimeDigestMatches(
  health: HealthResponse | null,
  expectedRuntimeDigest: string | undefined,
): boolean {
  // Source-only development has no packaged single-file runtime to hash. Every
  // packaged invocation has a digest and therefore takes the strict branch.
  if (expectedRuntimeDigest === undefined) return true;
  return typeof health?.runtimeDigest === "string"
    && health.runtimeDigest === expectedRuntimeDigest;
}

function recognizedHealthStorageBackend(health: HealthResponse): StorageBackend | null {
  const backend = health.storageBackend ?? "sqlite";
  return backend === "sqlite" || backend === "postgresql" ? backend : null;
}

const USER_SYSTEMD_PID_CACHE_TTL_MS = 5000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const STORAGE_BACKEND_AUTH_WARNING = "daemon reuse or replacement was blocked because the storage-backend mismatch could not be authenticated or terminated safely; verify the local daemon token, stop the existing daemon if necessary, and retry";
const RUNTIME_IDENTITY_AUTH_WARNING = "daemon reuse or replacement was blocked because the runtime-identity mismatch (entrypoint or packaged-runtime digest) could not be authenticated or terminated safely; verify the local daemon token, stop the existing daemon if necessary, and retry";
const userSystemdPidCache = new Map<string, { pid: number | null; expiresAt: number }>();

function mismatchAuthWarning(storageBackendMatches: boolean): string {
  return storageBackendMatches
    ? RUNTIME_IDENTITY_AUTH_WARNING
    : STORAGE_BACKEND_AUTH_WARNING;
}

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

type ScopedStateAccess = Readonly<({
  scope: DaemonLifecycleTestScope;
} | {
  hermeticSeams: DaemonLifecycleHermeticTestSeams;
}) & {
  pidPath: string;
  tokenPath: string;
}>;

class LifecycleTestScopeStateError extends Error {}

function assertScopedStateAccess(access: ScopedStateAccess): void {
  const ownsState = "scope" in access
    ? lifecycleScopeOwnsExactStatePaths(access.scope, access.pidPath, access.tokenPath)
    : lifecycleHermeticSeamsOwnsExactStatePaths(
        access.hermeticSeams,
        access.pidPath,
        access.tokenPath,
      );
  if (!ownsState) {
    throw new LifecycleTestScopeStateError(
      "daemon lifecycle test state paths changed or escaped their canonical scope",
    );
  }
}

function scopedStateDir(access: ScopedStateAccess): string {
  return "scope" in access ? access.scope.stateDir : access.hermeticSeams.stateDir;
}

function requireRegularFileDescriptor(descriptor: number): void {
  const stats = fstatSync(descriptor);
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new LifecycleTestScopeStateError(
      "daemon lifecycle test state leaf is not a single-link regular file",
    );
  }
}

function readRegularFileNoFollow(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    requireRegularFileDescriptor(descriptor);
    return readFileSync(descriptor, "utf-8");
  } finally {
    closeSync(descriptor);
  }
}

function readPidFile(
  pidFilePath: string,
  scopedState?: ScopedStateAccess,
): number | null {
  try {
    if (scopedState) assertScopedStateAccess(scopedState);
    const content = scopedState
      ? readRegularFileNoFollow(pidFilePath)
      : readFileSync(pidFilePath, "utf-8");
    if (scopedState) assertScopedStateAccess(scopedState);
    const pid = Number.parseInt(content.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (
      scopedState
      && (
        error instanceof LifecycleTestScopeStateError
        || (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
    ) {
      throw new LifecycleTestScopeStateError(
        "daemon lifecycle test PID state is not a canonical owned file",
      );
    }
    return null;
  }
}

function cleanStalePid(
  pidFilePath: string,
  scopedState?: ScopedStateAccess,
): void {
  if (scopedState) {
    assertScopedStateAccess(scopedState);
    if ("scope" in scopedState) {
      rmSync(pidFilePath, { force: true });
    } else {
      try {
        if (existsSync(pidFilePath)) unlinkSync(pidFilePath);
      } catch {
        // Preserve production best-effort stale PID cleanup.
      }
    }
    assertScopedStateAccess(scopedState);
    return;
  }
  try {
    if (existsSync(pidFilePath)) unlinkSync(pidFilePath);
  } catch { /* Preserve production best-effort stale PID cleanup. */ }
}

function readScopedAuthToken(access: ScopedStateAccess): string | null {
  try {
    assertScopedStateAccess(access);
    const token = readRegularFileNoFollow(access.tokenPath).trim();
    assertScopedStateAccess(access);
    return token || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LifecycleTestScopeStateError(
      `refusing unsafe daemon lifecycle token read: ${String(error)}`,
    );
  }
}

function ensureScopedAuthToken(access: ScopedStateAccess): void {
  try {
    assertScopedStateAccess(access);
    const existing = openSync(
      access.tokenPath,
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    try {
      requireRegularFileDescriptor(existing);
      fchmodSync(existing, 0o600);
    } finally {
      closeSync(existing);
    }
    assertScopedStateAccess(access);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new LifecycleTestScopeStateError(
        `refusing unsafe daemon lifecycle token access: ${String(error)}`,
      );
    }
  }

  const temporaryPath = join(
    scopedStateDir(access),
    `.lcm-token-${randomBytes(8).toString("hex")}.tmp`,
  );
  const descriptor = openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(descriptor, randomBytes(32).toString("hex"));
  } finally {
    closeSync(descriptor);
  }
  try {
    assertScopedStateAccess(access);
    renameSync(temporaryPath, access.tokenPath);
    const installed = openSync(
      access.tokenPath,
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    try {
      requireRegularFileDescriptor(installed);
      fchmodSync(installed, 0o600);
    } finally {
      closeSync(installed);
    }
    assertScopedStateAccess(access);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The atomic rename consumes the temporary path on success.
    }
  }
}

function writeScopedPidFile(access: ScopedStateAccess, pid: number): void {
  assertScopedStateAccess(access);
  const descriptor = openSync(
    access.pidPath,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    requireRegularFileDescriptor(descriptor);
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, String(pid));
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
  assertScopedStateAccess(access);
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

function processEntrypointMatches(
  health: HealthResponse,
  expectedEntrypoint: string | undefined,
  platform: NodeJS.Platform,
  procRoot = "/proc",
  realpath: (path: string) => string = realpathSync,
): boolean {
  if (isVitestWorkerEntrypoint(health.entrypoint)) return false;
  if (expectedEntrypoint === undefined) return true;
  const pathApi = platform === "win32" ? win32 : posix;
  const normalize = (path: string): string => {
    let canonical = path;
    if (pathApi.isAbsolute(path)) {
      try {
        canonical = realpath(path);
      } catch {
        // Legacy or remote health paths may no longer exist. Preserve the
        // direct normalized comparison instead of treating resolution failure
        // as evidence that two different paths are equivalent.
      }
    }
    const normalized = pathApi.normalize(canonical);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const matches = (actual: string): boolean =>
    actual === expectedEntrypoint || normalize(actual) === normalize(expectedEntrypoint);
  if (typeof health.entrypoint === "string") return matches(health.entrypoint);
  if (platform !== "linux" || health.pid === undefined) return false;
  try {
    const args = readFileSync(join(procRoot, String(health.pid), "cmdline"), "utf-8")
      .split("\0")
      .filter((arg) => arg.length > 0);
    return args.some(matches);
  } catch {
    return false;
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
  readPid: (path: string) => number | null = readPidFile,
): ParentInspection {
  const pid = readPid(pidFilePath);
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
  token?: string,
): Promise<HealthResponse | null> {
  try {
    const url = `http://127.0.0.1:${port}/health`;
    const res = await fetchFn(url, {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      signal,
    });
    if (!res.ok && res.status !== 503) return null;
    const body = await res.json() as unknown;
    if (typeof body !== "object" || body === null || typeof (body as HealthResponse).status !== "string") {
      return null;
    }
    return { ...(body as HealthResponse), httpStatus: res.status };
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
  const abort = (): void => {
    controller.abort();
    rejectTimeout(new Error("daemon request interrupted"));
  };
  if (deadline.abortSignal?.aborted) abort();
  else deadline.abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    deadline.abortSignal?.removeEventListener("abort", abort);
    deadline.clearTimeoutFn(timeoutHandle);
  }
}

async function checkDaemonHealth(
  port: number,
  fetchFn: typeof globalThis.fetch,
  deadline: RequestDeadline,
  token?: string,
): Promise<HealthResponse | null> {
  try {
    return await runWithDeadline(
      (signal: AbortSignal): Promise<HealthResponse | null> => requestDaemonHealth(port, fetchFn, signal, token),
      deadline,
    );
  } catch {
    return null;
  }
}

async function checkDaemonAccess(
  port: number,
  token: string,
  fetchFn: typeof globalThis.fetch,
  deadline: RequestDeadline,
  expectedStorageBackend: StorageBackend,
): Promise<boolean> {
  const request = async (signal: AbortSignal): Promise<boolean> => {
    const res = await fetchFn(`http://127.0.0.1:${port}/stats/pool`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (res.ok) return true;
    if (expectedStorageBackend !== "postgresql" || res.status !== 503) return false;
    const body = await res.json() as unknown;
    return typeof body === "object"
      && body !== null
      && (body as { storageBackend?: unknown }).storageBackend === "postgresql"
      && (body as { code?: unknown }).code === STAGED_POSTGRESQL_ERROR_CODE;
  };
  try {
    return await runWithDeadline((signal: AbortSignal): Promise<boolean> => request(signal), deadline);
  } catch {
    return false;
  }
}

function sameHealthIdentity(publicHealth: HealthResponse, authenticatedHealth: HealthResponse): boolean {
  return publicHealth.pid === authenticatedHealth.pid
    && publicHealth.version === authenticatedHealth.version
    && (publicHealth.storageBackend ?? "sqlite") === (authenticatedHealth.storageBackend ?? "sqlite")
    && publicHealth.ownerId === authenticatedHealth.ownerId;
}

async function checkDaemonDiagnostics(
  port: number,
  tokenPath: string,
  fetchFn: typeof globalThis.fetch,
  remainingDeadline: () => RequestDeadline | null,
  publicHealth: HealthResponse,
  expectedStorageBackend: StorageBackend,
  readToken: (path: string) => string | null = readAuthToken,
): Promise<HealthResponse | null> {
  const token = readToken(tokenPath);
  if (!token) return null;
  const healthDeadline = remainingDeadline();
  if (!healthDeadline) return null;
  const authenticatedHealth = await checkDaemonHealth(port, fetchFn, healthDeadline, token);
  if (
    !isRecognizedDaemonHealth(authenticatedHealth)
    || !sameHealthIdentity(publicHealth, authenticatedHealth)
  ) {
    return null;
  }
  const accessDeadline = remainingDeadline();
  if (!accessDeadline) return null;
  return await checkDaemonAccess(
    port,
    token,
    fetchFn,
    accessDeadline,
    expectedStorageBackend,
  )
    ? authenticatedHealth
    : null;
}

function startViaDetachedSpawn(
  opts: EnsureDaemonOptions,
  spawnCommand: string,
  spawnArgs: string[],
  dependencies: ResolvedLifecycleDependencies,
  scopedState?: ScopedStateAccess,
): { getWarning: () => string | undefined; pid?: number } {
  let errorMessage: string | undefined;
  let child: ChildProcess;
  try {
    child = dependencies.spawn(spawnCommand, spawnArgs, {
      detached: true,
      stdio: "ignore",
      env: lifecycleSpawnEnvironment(opts, dependencies),
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
    if (scopedState) writeScopedPidFile(scopedState, child.pid);
    else writeFileSync(opts.pidFilePath, String(child.pid));
  }
  return {
    getWarning: () => errorMessage ? `detached spawn failed (${errorMessage})` : undefined,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
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
  testScope?: DaemonLifecycleTestScope,
  hermeticSeams?: DaemonLifecycleHermeticTestSeams,
): string[] {
  const args = Object.entries(env)
    .filter(([name, value]) => (
      shouldPropagateDaemonEnv(name, value)
      && !isSecretDaemonEnvName(name)
      && !SYSTEMD_SECRET_ENV_PATTERN.test(name)
    ))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `--setenv=${name}=${value}`);
  if (testScope) {
    args.push(
      `--setenv=HOME=${testScope.homeDir}`,
      `--setenv=LCM_DAEMON_OWNER_ID=${testScope.ownerId}`,
      `--setenv=USERPROFILE=${testScope.homeDir}`,
      `--setenv=XDG_RUNTIME_DIR=${testScope.runtimeDir}`,
    );
  } else if (hermeticSeams) {
    args.push(
      `--setenv=HOME=${hermeticSeams.homeDir}`,
      `--setenv=USERPROFILE=${hermeticSeams.homeDir}`,
      `--setenv=XDG_RUNTIME_DIR=${hermeticSeams.runtimeDir}`,
    );
  }
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

function systemdManagerProcessEnv(
  lifecycleEnv: NodeJS.ProcessEnv,
  testScope?: DaemonLifecycleTestScope,
): NodeJS.ProcessEnv {
  if (!testScope) return systemdRunProcessEnv(lifecycleEnv);
  return systemdRunProcessEnv({
    ...lifecycleEnv,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  });
}

function systemdCredentialCleanup(
  credentialDir: string,
  testScope?: DaemonLifecycleTestScope,
): () => void {
  return () => {
    try {
      if (testScope && !lifecycleScopeFilesystemIsCurrent(testScope)) {
        throw new LifecycleTestScopeStateError(
          "refusing cleanup through a changed lifecycle test credential root",
        );
      }
      rmSync(credentialDir, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof LifecycleTestScopeStateError) throw error;
      // Best-effort cleanup only; the age-based cleanup handles leftovers.
    }
  };
}

function systemdDaemonCredentialArgs(
  env: NodeJS.ProcessEnv,
  testScope?: DaemonLifecycleTestScope,
  hermeticSeams?: DaemonLifecycleHermeticTestSeams,
): { args: string[]; names: string[]; cleanup?: CleanupFn } {
  const secrets = Object.entries(env)
    .filter(([name, value]) => shouldPropagateDaemonEnv(name, value) && isSecretDaemonEnvName(name))
    .sort(([left], [right]) => left.localeCompare(right));
  if (secrets.length === 0) return { args: [], names: [] };
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!testScope && !hermeticSeams && uid === undefined) {
    throw new Error("current user id is unavailable");
  }
  const baseDir = testScope?.credentialDir
    ?? hermeticSeams?.credentialDir
    ?? `/run/user/${uid!}`;
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
      cleanup: systemdCredentialCleanup(createdCredentialDir, testScope),
    };
  } catch (err) {
    if (credentialDir) systemdCredentialCleanup(credentialDir, testScope)();
    throw err;
  }
}

async function startViaUserSystemd(
  opts: EnsureDaemonOptions,
  spawnCommand: string,
  spawnArgs: string[],
  dependencies: ResolvedLifecycleDependencies,
): Promise<{ ok: boolean; warning?: string; cleanup?: CleanupFn; unitName: string }> {
  const testScope = opts._testScope;
  const hermeticSeams = opts._hermeticTestSeams;
  const lifecycleEnv = dependencies.environment;
  const spawnSyncImpl = dependencies.spawnSync;
  const unit = lifecycleUnitName(opts, process.pid, Date.now());
  let credentials: { args: string[]; names: string[]; cleanup?: CleanupFn };
  try {
    credentials = systemdDaemonCredentialArgs(lifecycleEnv, testScope, hermeticSeams);
  } catch (err) {
    const detail = summarizeProcessDiagnostic("credential setup error", err);
    return {
      ok: false,
      warning: `user systemd credential setup failed (${detail}); used detached spawn fallback; daemon parent invariant is not satisfied`,
      unitName: unit,
    };
  }
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    const stopUnit = testScope?.dependencies.stopUnit ?? hermeticSeams?.stopUnit;
    await runCleanupStages([
      ...(stopUnit ? [(): void | Promise<void> => stopUnit(unit)] : []),
      ...(credentials.cleanup ? [credentials.cleanup] : []),
    ]);
  };
  let result: ReturnType<typeof spawnSyncImpl>;
  try {
    result = spawnSyncImpl("systemd-run", [
      "--user",
      "--collect",
      "--no-block",
      "--quiet",
      `--unit=${unit}`,
      ...systemdDaemonSetenvArgs(
        lifecycleEnv,
        credentials.names,
        managedDaemonPath(spawnCommand, spawnArgs),
        testScope,
        hermeticSeams,
      ),
      ...credentials.args,
      spawnCommand,
      ...spawnArgs,
    ], {
      encoding: "utf-8",
      env: systemdManagerProcessEnv(lifecycleEnv, testScope),
      timeout: Math.max(1, opts.spawnTimeoutMs),
    });
  } catch (err) {
    await cleanup();
    const detail = summarizeProcessDiagnostic("systemd start exception", err);
    return {
      ok: false,
      warning: `user systemd start failed (${detail}); used detached spawn fallback; daemon parent invariant is not satisfied`,
      cleanup,
      unitName: unit,
    };
  }

  if (result.status === 0) return { ok: true, cleanup, unitName: unit };
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
    cleanup,
    unitName: unit,
  };
}

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  validateSpawnTimeout(opts.spawnTimeoutMs);

  const hasTestScopeProperty = Object.prototype.hasOwnProperty.call(opts, "_testScope");
  if (hasTestScopeProperty && !isDaemonLifecycleTestScope(opts._testScope)) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon lifecycle test scope is incomplete or malformed",
    };
  }
  const testScope = opts._testScope;
  const hasHermeticSeamsProperty = Object.prototype.hasOwnProperty.call(
    opts,
    "_hermeticTestSeams",
  );
  if (
    hasHermeticSeamsProperty
    && !isDaemonLifecycleHermeticTestSeams(opts._hermeticTestSeams)
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon lifecycle hermetic test seams are incomplete or malformed",
    };
  }
  const hermeticSeams = opts._hermeticTestSeams;
  if (testScope && hermeticSeams) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon lifecycle test scope conflicts with hermetic test seams",
    };
  }
  const tokenPath = join(dirname(opts.pidFilePath), "daemon.token");
  if (
    testScope
    && !lifecycleScopeOwnsExactStatePaths(testScope, opts.pidFilePath, tokenPath)
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon lifecycle test PID or token state is not exact canonical owned state",
    };
  }
  if (
    hermeticSeams
    && !lifecycleHermeticSeamsOwnsExactStatePaths(
      hermeticSeams,
      opts.pidFilePath,
      tokenPath,
    )
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon lifecycle hermetic PID or token state is outside its state root",
    };
  }
  const unscopedVitestWorker = testScope === undefined
    && isVitestWorkerEntrypoint(process.argv[1])
    && hermeticSeams === undefined;
  if (unscopedVitestWorker) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon lifecycle is disabled for an unscoped Vitest worker",
    };
  }
  if (opts._abortSignal?.aborted) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon lifecycle was interrupted before startup",
    };
  }

  const dependencies = resolveLifecycleDependencies(opts);
  const scopedState = testScope
    ? { scope: testScope, pidPath: opts.pidFilePath, tokenPath }
    : hermeticSeams
      ? { hermeticSeams, pidPath: opts.pidFilePath, tokenPath }
      : undefined;
  const readOwnedPid = (): number | null => readPidFile(opts.pidFilePath, scopedState);
  const cleanOwnedPid = (): void => cleanStalePid(opts.pidFilePath, scopedState);
  const readOwnedToken = (path: string): string | null => scopedState
    ? readScopedAuthToken(scopedState)
    : readAuthToken(path);
  const fetchFn = dependencies.fetch;
  const platform = dependencies.platform;
  const procRoot = dependencies.procRoot;
  const sleepFn = dependencies.sleep;
  const monotonicNow = opts._monotonicNowOverride ?? performance.now.bind(performance);
  const setTimeoutFn = opts._setTimeoutOverride ?? setTimeout;
  const clearTimeoutFn = opts._clearTimeoutOverride ?? clearTimeout;
  const realpath = dependencies.realpath;
  const deadline = monotonicNow() + opts.spawnTimeoutMs;
  const isAlive = dependencies.isProcessAlive;
  const killProcess = dependencies.killProcess;
  const enforceParent = opts.enforceUserManagerParent === true && platform === "linux";
  const expectedVersion = opts.expectedVersion ?? PKG_VERSION;
  const expectedStorageBackend = opts.expectedStorageBackend ?? "sqlite";
  const expectedEntrypoint = testScope?.entrypoint
    ?? opts.expectedEntrypoint
    ?? opts._packagedEntrypointOverride
    ?? PACKAGED_RUNTIME_ENTRYPOINT;
  const expectedRuntimeDigest = opts.expectedRuntimeDigest ?? RUNTIME_DIGEST;
  const expectedOwnerId = testScope?.ownerId;
  let restartedForParent = false;

  if (testScope && opts.expectedEntrypoint !== undefined && opts.expectedEntrypoint !== testScope.entrypoint) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon lifecycle test entrypoint does not match the owned test scope",
    };
  }
  if (isVitestWorkerEntrypoint(expectedEntrypoint)) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "refusing to use a Vitest worker as a daemon entrypoint",
    };
  }

  if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon identity could not be verified because the installed version is unknown",
    };
  }

  function endpointIdentityMatches(health: HealthResponse | null): boolean {
    if (!isRecognizedDaemonHealth(health) || health?.pid === undefined) return false;
    if (expectedOwnerId !== undefined && health.ownerId !== expectedOwnerId) return false;
    const pid = readOwnedPid();
    if (pid === null || health.pid !== pid || !isAlive(pid)) return false;
    const listenerPorts = opts._listeningPortsOverride
      ? opts._listeningPortsOverride(pid)
      : findListeningTcpPorts(
          pid,
          platform,
          dependencies.spawnSync,
          procRoot,
          opts.port,
        );
    return listenerPorts.includes(opts.port);
  }

  function remainingRequestDeadline(): RequestDeadline | null {
    const timeoutMs = deadline - monotonicNow();
    return timeoutMs <= 0
      ? null
      : { timeoutMs, setTimeoutFn, clearTimeoutFn, abortSignal: opts._abortSignal };
  }

  function inspectParent(): ParentInspection {
    return inspectDaemonParent(opts.pidFilePath, {
      procRoot,
      uid: dependencies.uid,
      isAlive,
    }, () => readOwnedPid());
  }

  async function terminatePidFileProcess(): Promise<void> {
    const pid = readOwnedPid();
    if (pid !== null && isLikelyLcmDaemonProcess(pid, procRoot)) {
      await terminatePid(pid, { isAlive, killProcess, sleepFn });
    }
    cleanOwnedPid();
  }

  type MismatchRepair =
    | { outcome: "none" }
    | { outcome: "terminated" }
    | { outcome: "replacement"; pid: number }
    | { outcome: "blocked" };

  async function terminateAuthenticatedDaemon(health: HealthResponse): Promise<MismatchRepair> {
    const authenticatedPid = health.pid;
    if (authenticatedPid === undefined || !endpointIdentityMatches(health)) return { outcome: "blocked" };
    if (platform === "linux" && !isLikelyLcmDaemonProcess(authenticatedPid, procRoot)) {
      return { outcome: "blocked" };
    }
    await terminatePid(authenticatedPid, { isAlive, killProcess, sleepFn });
    if (isAlive(authenticatedPid)) return { outcome: "blocked" };
    const currentPid = readOwnedPid();
    if (currentPid === authenticatedPid) {
      cleanOwnedPid();
      return { outcome: "terminated" };
    }
    return currentPid === null
      ? { outcome: "terminated" }
      : { outcome: "replacement", pid: currentPid };
  }

  /** Retain legacy version repair, but never disclose the token to an unexpected public identity. */
  async function repairMismatchedDaemon(
    health: HealthResponse,
    identityMatches: boolean,
    versionMatches: boolean,
    storageBackendMatches: boolean,
    entrypointMatches: boolean,
    runtimeDigestMatches: boolean,
    hasAccess: boolean,
  ): Promise<MismatchRepair> {
    if (!identityMatches) return { outcome: "none" };
    if (!storageBackendMatches && !hasAccess) return { outcome: "blocked" };
    if (!versionMatches) {
      await terminatePidFileProcess();
      return { outcome: "terminated" };
    }
    if (!storageBackendMatches || !entrypointMatches || !runtimeDigestMatches) {
      if (!hasAccess) return { outcome: "blocked" };
      return terminateAuthenticatedDaemon(health);
    }
    return { outcome: "none" };
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
    let verifiedHealth = health;
    if (!access.alreadyVerified) {
      const authenticated = await checkDaemonDiagnostics(
        opts.port,
        tokenPath,
        fetchFn,
        (): RequestDeadline | null => {
          const timeoutMs = access.deadline - monotonicNow();
          return timeoutMs <= 0
            ? null
            : { timeoutMs, setTimeoutFn, clearTimeoutFn, abortSignal: opts._abortSignal };
        },
        health,
        expectedStorageBackend,
        readOwnedToken,
      );
      if (!authenticated) return null;
      verifiedHealth = authenticated;
    }
    if (!processEntrypointMatches(verifiedHealth, expectedEntrypoint, platform, procRoot, realpath)) return null;
    if (!healthRuntimeDigestMatches(verifiedHealth, expectedRuntimeDigest)) return null;

    let parent: ParentInspection | undefined;
    if (enforceParent) {
      parent = inspectParent();
      if (!parent.satisfies) {
        if (!parent.available || allowParentWarning) {
          if (parent.reason === "dead-pid" || parent.reason === "pid-not-lcm-daemon") {
            cleanOwnedPid();
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
      pid: parent?.pid ?? verifiedHealth.pid,
      parentPid: parent?.parentPid,
      userSystemdPid: parent?.userSystemdPid,
      restartedForParent,
      startMethod,
      warning,
    };
  }

  async function waitForConcurrentReplacement(pid: number): Promise<EnsureDaemonResult> {
    while (readOwnedPid() === pid && isAlive(pid)) {
      const healthDeadline = remainingRequestDeadline();
      if (!healthDeadline) break;
      const replacementHealth = await checkDaemonHealth(opts.port, fetchFn, healthDeadline);
      const accepted = await daemonResult(
        replacementHealth,
        false,
        "existing",
        { alreadyVerified: false, deadline },
      );
      if (accepted) return accepted;
      const remainingMs = deadline - monotonicNow();
      if (remainingMs <= 0) break;
      await sleepFn(Math.min(300, remainingMs));
    }
    return { connected: false, port: opts.port, spawned: false };
  }

  let concurrentReplacementPid: number | undefined;

  // Step 1: Check if daemon is already running via health check
  const initialHealthDeadline = remainingRequestDeadline();
  const health = initialHealthDeadline
    ? await checkDaemonHealth(opts.port, fetchFn, initialHealthDeadline)
    : null;
  if (isRecognizedDaemonHealth(health)) {
    const identityMatches = endpointIdentityMatches(health);
    const versionMatches = healthVersionMatches(health, expectedVersion);
    const storageBackendMatches = healthStorageBackendMatches(health, expectedStorageBackend);
    const publicStorageBackend = recognizedHealthStorageBackend(health);
    const authenticatedHealth = identityMatches && versionMatches && publicStorageBackend !== null
      ? await checkDaemonDiagnostics(
          opts.port,
          tokenPath,
          fetchFn,
          remainingRequestDeadline,
          health,
          publicStorageBackend,
          readOwnedToken,
        )
      : null;
    const entrypointMatches = authenticatedHealth !== null
      && processEntrypointMatches(
        authenticatedHealth,
        expectedEntrypoint,
        platform,
        procRoot,
        realpath,
      );
    const runtimeDigestMatches = healthRuntimeDigestMatches(
      authenticatedHealth,
      expectedRuntimeDigest,
    );
    const hasAccess = authenticatedHealth !== null;
    const mismatchRepair = await repairMismatchedDaemon(
      authenticatedHealth ?? health,
      identityMatches,
      versionMatches,
      storageBackendMatches,
      entrypointMatches,
      runtimeDigestMatches,
      hasAccess,
    );
    if (mismatchRepair.outcome === "blocked") {
      return {
        connected: false,
        port: opts.port,
        spawned: false,
        warning: mismatchAuthWarning(storageBackendMatches),
      };
    }
    if (mismatchRepair.outcome === "replacement") {
      concurrentReplacementPid = mismatchRepair.pid;
    }
    if (mismatchRepair.outcome === "none") {
      if (authenticatedHealth) {
        const accepted = await daemonResult(authenticatedHealth, false, "existing", { alreadyVerified: true });
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
          && authenticatedHealth.pid !== undefined
          && parent.pid === authenticatedHealth.pid
          && isLikelyLcmDaemonProcess(parent.pid, procRoot)) {
          await terminatePid(parent.pid, { isAlive, killProcess, sleepFn });
          restartedForParent = true;
        }
      }
      cleanOwnedPid();
    }
  }

  // Step 2: Check PID file for stale process
  if (concurrentReplacementPid !== undefined) {
    return waitForConcurrentReplacement(concurrentReplacementPid);
  }
  const pidFilePid = (
    scopedState && "scope" in scopedState
      ? true
      : existsSync(opts.pidFilePath)
  )
    ? readOwnedPid()
    : null;
  if (pidFilePid !== null) {
    let repairedMismatch = false;
    try {
      const pid = pidFilePid;
      if (isAlive(pid)) {
        const sleepRemainingMs = deadline - monotonicNow();
        if (sleepRemainingMs > 0) await sleepFn(Math.min(1000, sleepRemainingMs));
        const retryHealthDeadline = remainingRequestDeadline();
        const retry = retryHealthDeadline
          ? await checkDaemonHealth(opts.port, fetchFn, retryHealthDeadline)
          : null;
        if (isRecognizedDaemonHealth(retry)) {
          const retryIdentityMatches = endpointIdentityMatches(retry);
          const retryVersionMatches = healthVersionMatches(retry, expectedVersion);
          const retryStorageBackendMatches = healthStorageBackendMatches(retry, expectedStorageBackend);
          const retryPublicStorageBackend = recognizedHealthStorageBackend(retry);
          const authenticatedRetry = retryIdentityMatches
            && retryVersionMatches
            && retryPublicStorageBackend !== null
            ? await checkDaemonDiagnostics(
                opts.port,
                tokenPath,
                fetchFn,
                remainingRequestDeadline,
                retry,
                retryPublicStorageBackend,
                readOwnedToken,
              )
            : null;
          const retryEntrypointMatches = authenticatedRetry !== null
            && processEntrypointMatches(
              authenticatedRetry,
              expectedEntrypoint,
              platform,
              procRoot,
              realpath,
            );
          const retryRuntimeDigestMatches = healthRuntimeDigestMatches(
            authenticatedRetry,
            expectedRuntimeDigest,
          );
          const retryHasAccess = authenticatedRetry !== null;
          if (testScope && authenticatedRetry === null) {
            cleanOwnedPid();
            return {
              connected: false,
              port: opts.port,
              spawned: false,
              warning: mismatchAuthWarning(retryStorageBackendMatches),
            };
          }
          const mismatchRepair = await repairMismatchedDaemon(
            authenticatedRetry ?? retry,
            retryIdentityMatches,
            retryVersionMatches,
            retryStorageBackendMatches,
            retryEntrypointMatches,
            retryRuntimeDigestMatches,
            retryHasAccess,
          );
          if (mismatchRepair.outcome === "blocked") {
            return {
              connected: false,
              port: opts.port,
              spawned: false,
              warning: mismatchAuthWarning(retryStorageBackendMatches),
            };
          }
          if (mismatchRepair.outcome === "replacement") {
            return waitForConcurrentReplacement(mismatchRepair.pid);
          }
          repairedMismatch = mismatchRepair.outcome === "terminated";
          if (mismatchRepair.outcome === "none" && authenticatedRetry) {
            const accepted = await daemonResult(authenticatedRetry, false, "existing", { alreadyVerified: true });
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
    } catch (error) {
      if (error instanceof LifecycleTestScopeStateError) throw error;
    }
    if (!repairedMismatch) cleanOwnedPid();
  }

  // Step 3: Spawn daemon (unless skipped for testing)
  if (opts._skipSpawn || monotonicNow() >= deadline) {
    return { connected: false, port: opts.port, spawned: false };
  }

  const spawnCommand = opts.spawnCommand ?? process.execPath;
  const baseSpawnArgs = opts.spawnArgs
    ?? [testScope?.entrypoint ?? process.argv[1], "daemon", "start", "--foreground"];
  const spawnArgs = testScope
    ? [...baseSpawnArgs, ...daemonLifecycleTestIdentityArgs(testScope)]
    : baseSpawnArgs;
  if (
    isVitestWorkerEntrypoint(spawnArgs[0])
    && hermeticSeams === undefined
    && opts._spawnOverride === undefined
    && opts._spawnSyncOverride === undefined
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "refusing to register a Vitest worker as a daemon entrypoint",
    };
  }
  if (opts._abortSignal?.aborted) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon lifecycle was interrupted before startup",
    };
  }

  // Ensure auth token exists only after the daemon entrypoint is trusted.
  if (scopedState) ensureScopedAuthToken(scopedState);
  else ensureAuthToken(tokenPath);

  let startMethod: EnsureDaemonResult["startMethod"] = "detached-spawn";
  let warning: string | undefined;
  let detachedStart: { getWarning: () => string | undefined; pid?: number } | undefined;
  let cleanupSystemdResources: CleanupFn | undefined;

  if (enforceParent) {
    const systemdStart = await startViaUserSystemd(
      opts,
      spawnCommand,
      spawnArgs,
      dependencies,
    );
    cleanupSystemdResources = systemdStart.cleanup;
    if (systemdStart.ok) {
      startMethod = "systemd-user";
    } else {
      warning = systemdStart.warning;
      detachedStart = startViaDetachedSpawn(
        opts,
        spawnCommand,
        spawnArgs,
        dependencies,
        scopedState,
      );
    }
  } else {
    detachedStart = startViaDetachedSpawn(
      opts,
      spawnCommand,
      spawnArgs,
      dependencies,
      scopedState,
    );
  }

  let cleanupPromise: Promise<void> | undefined;
  const cleanupOwnedLifecycle = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async (): Promise<void> => {
      const stages: CleanupFn[] = [];
      if (cleanupSystemdResources) stages.push(cleanupSystemdResources);
      if (testScope && detachedStart?.pid !== undefined) {
        stages.push(() => terminatePid(detachedStart.pid!, {
          isAlive,
          killProcess,
          sleepFn,
        }));
      }
      if (testScope) {
        stages.push(
          () => cleanStalePid(opts.pidFilePath, scopedState),
          () => {
            assertScopedStateAccess(scopedState!);
            rmSync(tokenPath, { force: true });
            assertScopedStateAccess(scopedState!);
          },
        );
        for (const path of [
          testScope.runtimeDir,
          testScope.credentialDir,
          testScope.stateDir,
        ]) {
          stages.push(() => {
            assertLifecycleScopeOwnsCurrentCleanupRoot(testScope, path);
            rmSync(path, { recursive: true, force: true });
          });
        }
      }
      await runCleanupStages(stages);
    })();
    return cleanupPromise;
  };
  let interrupted = false;
  const onAbort = (): void => {
    interrupted = true;
    void cleanupOwnedLifecycle().catch(() => undefined);
  };
  if (opts._abortSignal?.aborted) onAbort();
  else opts._abortSignal?.addEventListener("abort", onAbort, { once: true });
  const finish = async (result: EnsureDaemonResult): Promise<EnsureDaemonResult> => {
    opts._abortSignal?.removeEventListener("abort", onAbort);
    await cleanupOwnedLifecycle();
    return interrupted
      ? {
          connected: false,
          port: opts.port,
          spawned: result.spawned,
          startMethod: result.startMethod,
          warning: "daemon lifecycle was interrupted",
        }
      : result;
  };

  if (opts._skipHealthWait) {
    const detachedWarning = detachedStart?.getWarning();
    const combinedWarning = warning && detachedWarning ? `${warning}; ${detachedWarning}` : warning ?? detachedWarning;
    return finish({
      connected: false,
      port: opts.port,
      spawned: true,
      startMethod,
      warning: combinedWarning,
      restartedForParent,
    });
  }

  // Step 4: Wait for health — only connect if version matches (if expected)
  while (true) {
    if (interrupted) break;
    const attemptTimeoutMs = deadline - monotonicNow();
    if (attemptTimeoutMs <= 0) break;
    const h = await checkDaemonHealth(opts.port, fetchFn, {
      timeoutMs: attemptTimeoutMs,
      setTimeoutFn,
      clearTimeoutFn,
      abortSignal: opts._abortSignal,
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
      return finish(accepted);
    }
    const remainingMs = deadline - monotonicNow();
    if (remainingMs <= 0) break;
    await sleepFn(Math.min(300, remainingMs));
  }

  const detachedWarning = detachedStart?.getWarning();
  const combinedWarning = warning && detachedWarning ? `${warning}; ${detachedWarning}` : warning ?? detachedWarning;
  return finish({
    connected: false,
    port: opts.port,
    spawned: true,
    startMethod,
    warning: combinedWarning,
    restartedForParent,
  });
}

/**
 * Safely stop the verified PID-file daemon and ensure a daemon is running with
 * the caller's already-resolved options. Callers should derive `port` and other
 * options from validated configuration; `validateBeforeRestart` is available
 * when validation and restart need to be kept in one operation.
 */
export async function restartDaemon(opts: RestartDaemonOptions): Promise<RestartDaemonResult> {
  validateSpawnTimeout(opts.spawnTimeoutMs);
  const hasTestScopeProperty = Object.prototype.hasOwnProperty.call(opts, "_testScope");
  if (hasTestScopeProperty && !isDaemonLifecycleTestScope(opts._testScope)) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle test scope is incomplete or malformed",
    };
  }
  const testScope = opts._testScope;
  const hasHermeticSeamsProperty = Object.prototype.hasOwnProperty.call(
    opts,
    "_hermeticTestSeams",
  );
  if (
    hasHermeticSeamsProperty
    && !isDaemonLifecycleHermeticTestSeams(opts._hermeticTestSeams)
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle hermetic test seams are incomplete or malformed",
    };
  }
  const hermeticSeams = opts._hermeticTestSeams;
  if (testScope && hermeticSeams) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle test scope conflicts with hermetic test seams",
    };
  }
  const tokenPath = join(dirname(opts.pidFilePath), "daemon.token");
  if (
    testScope
    && !lifecycleScopeOwnsExactStatePaths(testScope, opts.pidFilePath, tokenPath)
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle test PID or token state is not exact canonical owned state",
    };
  }
  if (
    hermeticSeams
    && !lifecycleHermeticSeamsOwnsExactStatePaths(
      hermeticSeams,
      opts.pidFilePath,
      tokenPath,
    )
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle hermetic PID or token state is outside its state root",
    };
  }
  const unscopedVitestWorker = testScope === undefined
    && isVitestWorkerEntrypoint(process.argv[1])
    && hermeticSeams === undefined;
  if (unscopedVitestWorker) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle is disabled for an unscoped Vitest worker",
    };
  }
  const {
    validateBeforeRestart,
    _ensureDaemonOverride,
    _isManagedProcessOverride,
    ...ensureOptions
  } = opts;
  await validateBeforeRestart?.();
  if (
    testScope
    && !lifecycleScopeOwnsExactStatePaths(testScope, opts.pidFilePath, tokenPath)
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle test state changed during restart validation",
    };
  }
  if (
    hermeticSeams
    && !lifecycleHermeticSeamsOwnsExactStatePaths(
      hermeticSeams,
      opts.pidFilePath,
      tokenPath,
    )
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle hermetic state changed during restart validation",
    };
  }

  const dependencies = resolveLifecycleDependencies(opts);
  const scopedState = testScope
    ? { scope: testScope, pidPath: opts.pidFilePath, tokenPath }
    : hermeticSeams
      ? { hermeticSeams, pidPath: opts.pidFilePath, tokenPath }
      : undefined;
  const readOwnedPid = (): number | null => readPidFile(opts.pidFilePath, scopedState);
  const cleanOwnedPid = (): void => cleanStalePid(opts.pidFilePath, scopedState);
  const readOwnedToken = (path: string): string | null => scopedState
    ? readScopedAuthToken(scopedState)
    : readAuthToken(path);
  const isAlive = dependencies.isProcessAlive;
  const platform = dependencies.platform;
  const fetchFn = dependencies.fetch;
  const procRoot = dependencies.procRoot;
  const realpath = dependencies.realpath;
  const expectedVersion = opts.expectedVersion ?? PKG_VERSION;
  const monotonicNow = opts._monotonicNowOverride ?? performance.now.bind(performance);
  const setTimeoutFn = opts._setTimeoutOverride ?? setTimeout;
  const clearTimeoutFn = opts._clearTimeoutOverride ?? clearTimeout;
  const verificationDeadline = monotonicNow() + opts.spawnTimeoutMs;
  function remainingVerificationDeadline(): RequestDeadline | null {
    const timeoutMs = verificationDeadline - monotonicNow();
    return timeoutMs <= 0
      ? null
      : { timeoutMs, setTimeoutFn, clearTimeoutFn, abortSignal: opts._abortSignal };
  }
  async function isAuthenticatedDaemonAtPort(port: number, pid: number): Promise<boolean> {
    const healthDeadline = remainingVerificationDeadline();
    if (!healthDeadline) return false;
    const health = await checkDaemonHealth(port, fetchFn, healthDeadline);
    if (!isRecognizedDaemonHealth(health) || health.pid !== pid) return false;
    if (testScope && health.ownerId !== testScope.ownerId) return false;
    if (!healthVersionMatches(health, expectedVersion)) return false;
    // The current daemon may legitimately use a different backend during a
    // configured transition. Authenticate it independently; ensureOptions
    // applies expectedStorageBackend to the replacement below.
    const currentStorageBackend = health.storageBackend ?? "sqlite";
    if (currentStorageBackend !== "sqlite" && currentStorageBackend !== "postgresql") return false;
    const authenticatedHealth = await checkDaemonDiagnostics(
      port,
      tokenPath,
      fetchFn,
      remainingVerificationDeadline,
      health,
      currentStorageBackend,
      readOwnedToken,
    );
    return authenticatedHealth !== null
      && processEntrypointMatches(
        authenticatedHealth,
        testScope?.entrypoint ?? opts.expectedEntrypoint,
        platform,
        procRoot,
        realpath,
      );
  }
  async function isManaged(pid: number): Promise<boolean> {
    if (_isManagedProcessOverride) return _isManagedProcessOverride(pid);
    if (platform === "linux" && !isLikelyLcmDaemonProcess(pid, procRoot)) return false;
    const listenerPorts = opts._listeningPortsOverride
      ? opts._listeningPortsOverride(pid)
      : findListeningTcpPorts(
          pid,
          platform,
          dependencies.spawnSync,
          procRoot,
          opts.port,
        );
    if (!listenerPorts.includes(opts.port)) return false;
    return await isAuthenticatedDaemonAtPort(opts.port, pid);
  }
  const killProcess = dependencies.killProcess;
  const sleepFn = dependencies.sleep;
  let restarted = false;
  let stoppedPid: number | undefined;

  const pid = readOwnedPid();
  if (pid === null) {
    cleanOwnedPid();
  } else if (!isAlive(pid)) {
    cleanOwnedPid();
  } else {
    if (!await isManaged(pid)) {
      throw new Error(`Refusing to restart: PID ${pid} is running but is not a verified LCM daemon.`);
    }
    if (readOwnedPid() !== pid) {
      throw new LifecycleTestScopeStateError(
        "daemon lifecycle test PID changed before restart signaling",
      );
    }
    await terminatePid(pid, { isAlive, killProcess, sleepFn });
    if (isAlive(pid)) {
      throw new Error(`Unable to stop verified LCM daemon PID ${pid}; restart aborted.`);
    }
    cleanOwnedPid();
    restarted = true;
    stoppedPid = pid;
  }

  if (scopedState) assertScopedStateAccess(scopedState);
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
  defaultKillProcess,
  findListeningTcpPorts,
  healthVersionMatches,
  healthStorageBackendMatches,
  inspectDaemonParent,
  isProcessAlive,
  parentInvariantWarning,
  requireRegularFileDescriptor,
  resolveWindowsNetstatPath,
  resolveLifecycleDependencies,
  lifecycleUnitName,
  lifecycleSpawnEnvironment,
  runCleanupStages,
  sleep,
  systemdDaemonSetenvArgs,
  systemdDaemonCredentialArgs,
  systemdManagerProcessEnv,
  systemdRunProcessEnv,
};
