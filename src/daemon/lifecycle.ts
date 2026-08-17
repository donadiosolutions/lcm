import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { platform as osPlatform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { ensureAuthToken, readAuthToken } from "./auth.js";
import { PACKAGED_RUNTIME_ENTRYPOINT, PKG_VERSION, RUNTIME_DIGEST } from "./version.js";
import type { StorageBackend } from "./config.js";
import {
  isStagedPostgreSqlHealth,
  STAGED_POSTGRESQL_ERROR_CODE,
} from "./staged-postgresql.js";
import { managedDaemonPathForStableLaunch } from "./managed-path.js";
import {
  observeHttpHealth,
  type HealthObservation,
} from "./health-observation.js";
import {
  canonicalSupervisorScope,
  createSupervisor,
  createSupervisorSpec,
  isSupervisorPreflightUnavailableReason,
  managedLaunchEnvironment,
  type LegacySystemdUnit,
  type Supervisor,
  type SupervisorKind,
  type SupervisorObservation,
  type SupervisorSpec,
} from "./supervisor.js";
import {
  cleanupManagedCredentialDirectory,
  createManagedCredentialDirectory,
  writeManagedCredentialFiles,
  MANAGED_CREDENTIAL_NAMES,
} from "./managed-credentials.js";
import {
  daemonLifecycleTestIdentityArgs,
  type DaemonLifecycleHermeticTestSeams,
  type DaemonLifecycleTestScope,
  daemonEntrypointMatches,
  isDaemonLifecycleHermeticTestSeams,
  isDaemonLifecycleTestScope,
  isVitestWorkerEntrypoint,
  assertLifecycleScopeOwnsCurrentCleanupRoot,
  lifecycleHermeticSeamsOwnsExactStatePaths,
  lifecycleScopeFilesystemIsCurrent,
  lifecycleScopeOwnsExactStatePaths,
  lifecycleScopeUnitName,
} from "./lifecycle-scope.js";
import {
  assertStorageBackendPublication,
  withStorageBackendConsumerLock,
} from "../storage/backend.js";

type KillProcess = (pid: number, signal?: NodeJS.Signals | number) => void;
type SleepFn = (ms: number) => Promise<void>;
type SetTimeoutFn = (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
type ClearTimeoutFn = (timeout: ReturnType<typeof setTimeout>) => void;
type CleanupFn = () => void | Promise<void>;

function publicationHomeForPidPath(pidFilePath: string): string | undefined {
  const pidPath = resolve(pidFilePath);
  const stateRoot = dirname(pidPath);
  return basename(pidPath) === "daemon.pid" && basename(stateRoot) === ".lcm"
    ? dirname(stateRoot)
    : undefined;
}

function publicationHomeForLifecycle(
  opts: Pick<EnsureDaemonOptions, "pidFilePath" | "_testScope" | "_hermeticTestSeams">,
): string | undefined {
  return opts._hermeticTestSeams?.homeDir
    ?? opts._testScope?.homeDir
    ?? publicationHomeForPidPath(opts.pidFilePath);
}

function assertLifecycleBackendPublication(
  opts: Pick<EnsureDaemonOptions, "pidFilePath" | "expectedStorageBackend" | "_testScope" | "_hermeticTestSeams" | "_assertBackendPublication">,
): void {
  const homeDir = publicationHomeForLifecycle(opts);
  if (opts._assertBackendPublication !== undefined) {
    opts._assertBackendPublication(homeDir, opts.expectedStorageBackend ?? "sqlite");
    return;
  }
  withStorageBackendConsumerLock(homeDir, (lockToken) => {
    assertStorageBackendPublication({
      backend: opts.expectedStorageBackend ?? "sqlite",
      homeDir,
    }, lockToken);
  });
}

/** Bounded, non-sensitive reasons surfaced to callers when lifecycle refuses. */
export type DaemonLifecycleRefusalReason =
  | "live-no-response"
  | "response-invalid"
  | "response-timeout"
  | "response-auth-failure"
  | "stale-config"
  | "invalid-collision"
  | "ambiguous"
  | "detached-no-response"
  | "manager-unavailable"
  | "absent"
  | "not-running"
  | "startup-failure";
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
  /** @internal Prevent a post-manager-operation ensure from downgrading. */
  _suppressDetachedFallback?: boolean;
  /** @internal Authorize cleanup of one run-owned manager operation. */
  _managedOperationAuthorized?: boolean;
  /** @internal Expected PID for startup admission and cleanup after an explicit manager restart. */
  _managedOperationManagerPid?: number;
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
  /** @internal Deterministic trusted Windows PowerShell seam for lifecycle tests. */
  _windowsPowerShellPathOverride?: string | null;
  /** @internal Isolated manager seam used by lifecycle tests and adapters. */
  _supervisorOverride?: Supervisor;
  /** @internal Alias retained for integrations that inject a supervisor. */
  _supervisor?: Supervisor;
  /** @internal Complete run-owned lifecycle boundary for systemd integration tests. */
  _testScope?: DaemonLifecycleTestScope;
  /** @internal Complete hermetic side-effect boundary for production-mode lifecycle tests. */
  _hermeticTestSeams?: DaemonLifecycleHermeticTestSeams;
  /** @internal Test-only publication admission seam. */
  _assertBackendPublication?: (homeDir: string | undefined, backend: StorageBackend) => void;
  /** @internal Inject only the manager transport environment for lifecycle tests. */
  _managerTransportEnvironmentOverride?: NodeJS.ProcessEnv;
  /** @internal Deterministic per-start nonce seam for lifecycle tests. */
  _supervisorNonceOverride?: () => string;
  /** @internal Exact credential metadata seam for post-manager restart admission. */
  _supervisorCredentialDirectoryOverride?: string;
  /** @internal Exact credential metadata seam for post-manager restart admission. */
  _supervisorCredentialFilesOverride?: SupervisorSpec["credentialFiles"];
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
  startMethod?: "existing" | "systemd-user" | "launchd-user" | "detached-spawn";
  refusalReason?: DaemonLifecycleRefusalReason;
  warning?: string;
};

function isManagedInterruptionResult(
  result: EnsureDaemonResult,
  abortSignal: AbortSignal | undefined,
): boolean {
  return abortSignal?.aborted === true
    && result.connected === false
    && result.spawned === true
    && (result.startMethod === "systemd-user" || result.startMethod === "launchd-user");
}

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

type ManagedCredentialStage = Readonly<{
  spec: SupervisorSpec;
  credentialDirectory?: string;
}>;

function stageManagedCredentials(
  spec: SupervisorSpec,
  environment: NodeJS.ProcessEnv,
): ManagedCredentialStage {
  const values: Record<string, string> = {};
  for (const name of MANAGED_CREDENTIAL_NAMES) {
    const value = environment[name];
    if (typeof value === "string" && value.length > 0) values[name] = value;
  }
  if (Object.keys(values).length === 0) return { spec };

  // Credential directories are per manager mutation, not stable scope
  // identity.  A fresh suffix prevents a terminal registration's old
  // systemd files from colliding with its replacement.
  const credentialNonce = `${spec.nonce}-${randomBytes(8).toString("hex")}`;
  const directory = createManagedCredentialDirectory(spec.stateRoot, credentialNonce);
  try {
    const paths = writeManagedCredentialFiles(directory, values);
    return {
      spec: Object.freeze({
        ...spec,
        credentialDirectory: directory,
        credentialFiles: Object.freeze(paths.map((path) => ({
          name: path.slice(path.lastIndexOf("/") + 1),
          path,
        }))),
      }),
      credentialDirectory: directory,
    };
  } catch (error) {
    try { cleanupManagedCredentialDirectory(directory, spec.stateRoot); } catch { /* preserve cleanup evidence */ }
    throw error;
  }
}

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

function managedSupervisorKind(
  platform: NodeJS.Platform,
  enforceUserManagerParent: boolean | undefined,
): SupervisorKind | undefined {
  // The explicit flag is the compatibility boundary.  Callers that request a
  // managed/default launch are never silently downgraded to a different
  // manager, while detached/foreground test seams retain their historical
  // behavior when the flag is false or omitted.
  if (enforceUserManagerParent !== true) return undefined;
  if (platform === "linux") return "systemd-user";
  if (platform === "darwin") return "launchd-user";
  return undefined;
}

function managedLaunchEnvironmentFor(
  environment: NodeJS.ProcessEnv,
  spawnCommand: string,
  spawnArgs: readonly string[],
  workingDirectory: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...managedLaunchEnvironment(environment),
    PATH: managedDaemonPathForStableLaunch(spawnCommand, spawnArgs, workingDirectory),
  });
}

function supervisorNonce(): string {
  // The manager name is the stable state-root mutex; the nonce identifies one
  // concrete launch and must never be reused across starts or restarts.
  return randomBytes(16).toString("hex");
}

function supervisorCommandRunner(
  dependencies: ResolvedLifecycleDependencies,
  opts: EnsureDaemonOptions,
): (
  command: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    cwd?: string;
    env?: Readonly<Record<string, string>>;
  },
) => {
  code?: number | null;
  status?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
} {
  return (command, args, options) => {
    try {
      const result = dependencies.spawnSync(command, [...args], {
        encoding: "utf-8",
        timeout: options.timeoutMs,
        cwd: options.cwd,
        env: options.env === undefined
          ? managerTransportEnvironment(opts, dependencies)
          : { ...options.env },
        shell: false,
      });
      const error = result.error as NodeJS.ErrnoException | undefined;
      const code = typeof result.status === "number" || result.status === null
        ? result.status
        : null;
      return {
        code,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" && result.stderr.length > 0
          ? result.stderr
          : error?.code === "ENOENT" ? error.code : "",
        timedOut: error?.code === "ETIMEDOUT",
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        code: typeof code === "string" && code === "ETIMEDOUT" ? null : 127,
        stdout: "",
        stderr: typeof code === "string" ? code : "",
        timedOut: code === "ETIMEDOUT",
      };
    }
  };
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

function isStrictLegacyUpgradeVersion(
  observedVersion: string | undefined,
  installedVersion: string | undefined,
): boolean {
  const parse = (value: string | undefined): readonly [number, number, number] | undefined => {
    if (value === undefined || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(value)) return undefined;
    const parts = value.split(".").map(Number);
    return parts.every((part) => Number.isSafeInteger(part))
      ? [parts[0]!, parts[1]!, parts[2]!]
      : undefined;
  };
  const observed = parse(observedVersion);
  const installed = parse(installedVersion);
  return observed !== undefined
    && installed !== undefined
    && observed[0] === installed[0]
    && observed[1] === installed[1]
    && observed[2] < installed[2];
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
const MAX_SUPERVISOR_COMMAND_TIMEOUT_MS = 60_000;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function validateSpawnTimeout(spawnTimeoutMs: number): void {
  if (!Number.isFinite(spawnTimeoutMs) || spawnTimeoutMs < 0 || spawnTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`spawnTimeoutMs must be between 0 and ${MAX_TIMER_DELAY_MS}`);
  }
}

function supervisorCommandTimeoutMs(spawnTimeoutMs: number): number {
  return Math.max(1, Math.floor(Math.min(MAX_SUPERVISOR_COMMAND_TIMEOUT_MS, spawnTimeoutMs || 1_000)));
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

type LegacyPidFileEvidence =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unsafe" }>
  | Readonly<{ kind: "present"; pid: number; device: number; inode: number }>;

function readLegacyPidFileEvidence(path: string): LegacyPidFileEvidence {
  let descriptor: number | undefined;
  let evidence: LegacyPidFileEvidence;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1) {
      evidence = { kind: "unsafe" };
    } else {
      const value = readFileSync(descriptor, "utf-8").trim();
      const pid = Number(value);
      evidence = /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(pid) && pid > 0
        ? { kind: "present", pid, device: stats.dev, inode: stats.ino }
        : { kind: "unsafe" };
    }
  } catch (error) {
    evidence = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unsafe" };
  }
  if (descriptor !== undefined) {
    try { closeSync(descriptor); } catch { return { kind: "unsafe" }; }
  }
  return evidence;
}

type LegacyTokenEvidence =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unsafe" }>
  | Readonly<{ kind: "present"; token: string }>;

function readLegacyTokenEvidence(path: string): LegacyTokenEvidence {
  try {
    const token = readRegularFileNoFollow(path).trim();
    return token.length === 0 ? { kind: "unsafe" } : { kind: "present", token };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unsafe" };
  }
}

function sameLegacyPidFileIdentity(
  left: Extract<LegacyPidFileEvidence, { kind: "present" }>,
  right: Extract<LegacyPidFileEvidence, { kind: "present" }>,
): boolean {
  return left.pid === right.pid && left.device === right.device && left.inode === right.inode;
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
  if (typeof health.entrypoint === "string") {
    return daemonEntrypointMatches(health.entrypoint, expectedEntrypoint, platform, realpath);
  }
  if (expectedEntrypoint === undefined) return true;
  if (platform !== "linux" || health.pid === undefined) return false;
  try {
    const args = readFileSync(join(procRoot, String(health.pid), "cmdline"), "utf-8")
      .split("\0")
      .filter((arg) => arg.length > 0);
    return args.some(actual => daemonEntrypointMatches(actual, expectedEntrypoint, platform, realpath));
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

function resolveWindowsSystemExecutable(
  relativeSegments: readonly string[],
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
    const executable = win32.join(normalized, ...relativeSegments);
    if (fileExists(executable)) return executable;
  }
  return null;
}

function resolveWindowsNetstatPath(
  systemRoot: string | undefined,
  windir: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  return resolveWindowsSystemExecutable(
    ["System32", "netstat.exe"],
    systemRoot,
    windir,
    fileExists,
  );
}

function resolveWindowsPowerShellPath(
  systemRoot: string | undefined,
  windir: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  return resolveWindowsSystemExecutable(
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    systemRoot,
    windir,
    fileExists,
  );
}

function readPlatformProcessCommand(
  pid: number,
  platform: NodeJS.Platform,
  spawnSyncImpl: typeof spawnSync,
  procRoot = "/proc",
  windowsPowerShellPath: string | null = resolveWindowsPowerShellPath(
    process.env.SystemRoot,
    process.env.WINDIR,
  ),
): string | null {
  if (platform === "linux") return readProcessCommand(pid, procRoot);

  let executable: string;
  let args: string[];
  if (platform === "darwin") {
    executable = "/bin/ps";
    args = ["-p", String(pid), "-o", "command="];
  } else if (platform === "win32" && windowsPowerShellPath !== null) {
    executable = windowsPowerShellPath;
    args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${String(pid)}'; if ($null -ne $process) { [Console]::Out.Write($process.CommandLine) }`,
    ];
  } else {
    return null;
  }

  try {
    const result = spawnSyncImpl(executable, args, {
      encoding: "utf-8",
      timeout: 1000,
      maxBuffer: 64 * 1024,
      shell: false,
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const command = result.stdout.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

function isLikelyLcmDaemonProcessForPlatform(
  pid: number,
  platform: NodeJS.Platform,
  spawnSyncImpl: typeof spawnSync,
  procRoot: string,
  windowsPowerShellPath: string | null,
): boolean {
  return isLikelyLcmDaemonCommand(
    readPlatformProcessCommand(
      pid,
      platform,
      spawnSyncImpl,
      procRoot,
      windowsPowerShellPath,
    ),
  );
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

function normalizeHealthResponse(response: Response): Response {
  // A few hermetic lifecycle seams historically returned `{ ok, json }`
  // without a numeric status.  Keep those seams useful while still routing
  // every production exchange through the monotonic observation boundary.
  let status: unknown;
  try {
    status = response.status;
  } catch {
    status = undefined;
  }
  if (typeof status === "number" && Number.isInteger(status) && status >= 0) return response;
  const inferred = (() => {
    try {
      return response.ok === false ? 500 : 200;
    } catch {
      return 0;
    }
  })();
  return new Proxy(response, {
    get(target, property, receiver) {
      if (property === "status") return inferred;
      if (property === "json") return target.json.bind(target);
      return Reflect.get(target, property, receiver);
    },
  });
}

async function observeDaemonHealth(
  port: number,
  fetchFn: typeof globalThis.fetch,
  deadline: RequestDeadline,
  token?: string,
): Promise<HealthObservation<HealthResponse>> {
  const observed = await observeHttpHealth<HealthResponse>({
    input: `http://127.0.0.1:${port}/health`,
    fetchFn: async (input, init) => normalizeHealthResponse(await fetchFn(input, init)),
    requestInit: token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined,
    headerTimeoutMs: deadline.timeoutMs,
    bodyTimeoutMs: deadline.timeoutMs,
    setTimeoutFn: (callback, delayMs) => deadline.setTimeoutFn(callback, delayMs),
    clearTimeoutFn: (handle) => deadline.clearTimeoutFn(handle as ReturnType<typeof setTimeout>),
    signal: deadline.abortSignal,
    validateBody: (body, response): HealthResponse | undefined => {
      if (typeof body !== "object" || body === null || typeof (body as HealthResponse).status !== "string") {
        return undefined;
      }
      return { ...(body as HealthResponse), httpStatus: response.status };
    },
  });
  return observed;
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
  const observation = await observeDaemonHealth(port, fetchFn, deadline, token);
  return observation.kind === "response" && observation.body === "valid"
    ? observation.parsedBody!
    : null;
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

function sanitizedManagerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NUMERIC",
    "LC_TIME",
    "TZ",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ]) {
    const value = env[name];
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) continue;
    if (/[\u0000\r\n]/u.test(value)) continue;
    if (name === "XDG_RUNTIME_DIR") {
      if (!isAbsolute(value)) continue;
      try {
        const stats = lstatSync(value);
        if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
      } catch {
        continue;
      }
    }
    if (name === "DBUS_SESSION_BUS_ADDRESS" && !/^(?:unix|tcp|unixexec):/u.test(value)) continue;
    result[name] = value;
  }
  return result;
}

function managerTransportEnvironment(
  opts: EnsureDaemonOptions,
  dependencies: ResolvedLifecycleDependencies,
): NodeJS.ProcessEnv {
  const source = opts._managerTransportEnvironmentOverride
    ?? (opts._testScope ? process.env : dependencies.environment);
  return sanitizedManagerEnvironment(source);
}

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  validateSpawnTimeout(opts.spawnTimeoutMs);
  // Keep publication admission short. The child performs its own config
  // admission, so retaining the lock over spawn and health waits would deadlock.
  assertLifecycleBackendPublication(opts);
  const result = await ensureDaemonUnlocked(opts);
  assertLifecycleBackendPublication(opts);
  return result;
}

async function ensureDaemonUnlocked(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
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
  const managerKind = managedSupervisorKind(platform, opts.enforceUserManagerParent);
  const expectedVersion = opts.expectedVersion ?? PKG_VERSION;
  const expectedStorageBackend = opts.expectedStorageBackend ?? "sqlite";
  const expectedEntrypoint = testScope?.entrypoint
    ?? opts.expectedEntrypoint
    ?? opts._packagedEntrypointOverride
    ?? PACKAGED_RUNTIME_ENTRYPOINT;
  const expectedRuntimeDigest = opts.expectedRuntimeDigest ?? RUNTIME_DIGEST;
  const expectedOwnerId = testScope?.ownerId;
  const windowsPowerShellPath = opts._windowsPowerShellPathOverride === undefined
    ? resolveWindowsPowerShellPath(
        dependencies.environment.SystemRoot,
        dependencies.environment.WINDIR,
      )
    : opts._windowsPowerShellPathOverride;
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

  function ownedPidIsLiveLikelyDaemon(pid: number): boolean {
    return readOwnedPid() === pid
      && isAlive(pid)
      && isLikelyLcmDaemonProcessForPlatform(
        pid,
        platform,
        dependencies.spawnSync,
        procRoot,
        windowsPowerShellPath,
      );
  }

  function ownedPidConfiguredListenerStateMatches(
    pid: number,
    expectedToOwnListener: boolean,
  ): boolean {
    if (
      !ownedPidIsLiveLikelyDaemon(pid)
    ) {
      return false;
    }
    const listenerPorts = opts._listeningPortsOverride
      ? opts._listeningPortsOverride(pid)
      : findListeningTcpPorts(
          pid,
          platform,
          dependencies.spawnSync,
          procRoot,
          opts.port,
        );
    return listenerPorts.includes(opts.port) === expectedToOwnListener
      && ownedPidIsLiveLikelyDaemon(pid);
  }

  function preserveBusyOwnedDaemon(pid: number): EnsureDaemonResult | null {
    if (!ownedPidConfiguredListenerStateMatches(pid, true)) {
      return null;
    }
    // Revalidate the exact PID, process identity, and listener immediately
    // before returning. Health may have been unavailable long enough for a
    // concurrent lifecycle operation to replace any one of them.
    if (!ownedPidConfiguredListenerStateMatches(pid, true)) {
      return null;
    }
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      pid,
      warning: `daemon PID ${pid} still owns configured port ${opts.port} but health remained unavailable after bounded retries; it may be busy, so it was preserved without signaling or replacement. Retry after the current operation completes; if it remains unavailable, inspect or explicitly stop the daemon before retrying`,
    };
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

  type MismatchRepair =
    | { outcome: "none" }
    | { outcome: "terminated" }
    | { outcome: "replacement"; pid: number }
    | { outcome: "blocked" };

  async function terminateAuthenticatedDaemon(health: HealthResponse): Promise<MismatchRepair> {
    const authenticatedPid = health.pid;
    if (authenticatedPid === undefined || !endpointIdentityMatches(health)) return { outcome: "blocked" };
    if (!isLikelyLcmDaemonProcessForPlatform(
      authenticatedPid,
      platform,
      dependencies.spawnSync,
      procRoot,
      windowsPowerShellPath,
    )) {
      return { outcome: "blocked" };
    }
    // Health/authentication may have completed well before signaling. Re-read
    // the exact PID-file binding, liveness, executable identity, and listener
    // ownership immediately before the signal, then repeat the proof once to
    // close the replacement/reused-PID window.
    if (!endpointIdentityMatches(health)
      || readOwnedPid() !== authenticatedPid
      || !isAlive(authenticatedPid)
      || !isLikelyLcmDaemonProcessForPlatform(
        authenticatedPid,
        platform,
        dependencies.spawnSync,
        procRoot,
        windowsPowerShellPath,
      )) {
      return { outcome: "blocked" };
    }
    if (!endpointIdentityMatches(health) || readOwnedPid() !== authenticatedPid) {
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
      return terminateAuthenticatedDaemon(health);
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

  function refusalResult(
    refusalReason: DaemonLifecycleRefusalReason,
    warning: string,
    extra: Partial<EnsureDaemonResult> = {},
  ): EnsureDaemonResult {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      refusalReason,
      warning,
      ...extra,
    };
  }

  function observationRefusalReason(
    observation: Extract<HealthObservation<HealthResponse>, { kind: "response" }>,
  ): DaemonLifecycleRefusalReason {
    if (observation.body === "timeout") return "response-timeout";
    return "response-invalid";
  }

  function supervisorMetadataMatches(
    observation: SupervisorObservation,
    spec: SupervisorSpec,
  ): boolean {
    return observation.kind === "registered-running-valid"
      && observation.scopeDigest === spec.scopeDigest
      && observation.nonce === spec.nonce
      && observation.name === spec.name
      && Number.isSafeInteger(observation.managerPid)
      && observation.managerPid > 0;
  }

  function managerEndpointIdentityMatches(
    observation: SupervisorObservation,
    health: HealthResponse,
    spec: SupervisorSpec,
  ): boolean {
    if (!supervisorMetadataMatches(observation, spec)) return false;
    const managerPid = observation.managerPid;
    if (health.pid !== managerPid || readOwnedPid() !== managerPid || !isAlive(managerPid)) return false;
    const listenerPorts = opts._listeningPortsOverride
      ? opts._listeningPortsOverride(managerPid)
      : findListeningTcpPorts(
          managerPid,
          platform,
          dependencies.spawnSync,
          procRoot,
          opts.port,
        );
    return listenerPorts.includes(opts.port);
  }

  function observedCredentialMetadataIsSafe(
    requested: SupervisorSpec,
    observation: SupervisorObservation,
  ): boolean {
    const directory = observation.credentialDirectory;
    const files = observation.credentialFiles;
    const managerPid = observation.managerPid;
    // A deleted one-shot directory is expected during normal reuse.  Validate
    // only the immutable manager metadata below; never reread or recreate its
    // credential files.
    if (directory === undefined && files === undefined) return true;
    if (
      typeof directory !== "string"
      || !Array.isArray(files)
      || files.length === 0
      || files.length > MANAGED_CREDENTIAL_NAMES.length
      || typeof managerPid !== "number"
      || !Number.isSafeInteger(managerPid)
      || managerPid < 1
      || typeof observation.nonce !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(observation.nonce)
    ) return false;
    const directoryPrefix = join(requested.stateRoot, "credentials", `${observation.nonce}-`);
    if (
      !directory.startsWith(directoryPrefix)
      || !/^[a-f0-9]{16}$/u.test(directory.slice(directoryPrefix.length))
    ) return false;
    const names = new Set<string>();
    return files.every((credential) => {
      if (
        credential === undefined
        || credential === null
        || typeof credential !== "object"
        || typeof credential.name !== "string"
        || typeof credential.path !== "string"
        || !MANAGED_CREDENTIAL_NAMES.some((name) => name === credential.name)
        || names.has(credential.name)
        || credential.path !== join(directory, credential.name)
      ) return false;
      names.add(credential.name);
      return true;
    });
  }

  function observedSupervisorSpec(
    requested: SupervisorSpec,
    observation: SupervisorObservation,
  ): SupervisorSpec | undefined {
    if (
      observation.kind !== "registered-stale-config"
      && observation.kind !== "registered-running-valid"
      && observation.kind !== "registered-not-running-valid"
      || observation.marker !== requested.marker
      || observation.scopeDigest !== requested.scopeDigest
      || observation.stateRoot !== requested.stateRoot
      || observation.name !== requested.name
      || observation.port === undefined
      || observation.port !== requested.port
      || observation.nonce === undefined
      || observation.executable === undefined
      || observation.args === undefined
    ) return undefined;
    let args: readonly string[];
    try {
      const parsed: unknown = JSON.parse(observation.args);
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) return undefined;
      args = Object.freeze([...parsed]);
    } catch {
      return undefined;
    }
    const optionalMetadataMatches = (observed: string | undefined, expected: string | undefined): boolean =>
      (observed ?? "") === (expected ?? "");
    const sameCredentials = requested.credentialDirectory === undefined
      ? observedCredentialMetadataIsSafe(requested, observation)
      : observation.credentialDirectory === requested.credentialDirectory
        && (requested.credentialFiles ?? []).length === (observation.credentialFiles ?? []).length
        && (requested.credentialFiles ?? []).every((credential, index) => {
          const observed = observation.credentialFiles?.[index];
          return observed?.name === credential.name && observed.path === credential.path;
        });
    if (!sameCredentials
      || observation.executable !== requested.executable
      || observation.args !== JSON.stringify(requested.args)
      || observation.cwd !== (requested.cwd ?? "")
      || !optionalMetadataMatches(observation.entrypoint, requested.entrypoint)
      || !optionalMetadataMatches(observation.runtimeDigest, requested.runtimeDigest)
      || !optionalMetadataMatches(observation.storageBackend, requested.storageBackend)
      || !optionalMetadataMatches(observation.postgresCaFile, requested.postgresCaFile)
    ) return undefined;
    try {
      return createSupervisorSpec({
        kind: requested.kind,
        stateRoot: requested.stateRoot,
        port: observation.port,
        nonce: observation.nonce,
        executable: observation.executable,
        args,
        ...(observation.entrypoint === undefined ? {} : { entrypoint: observation.entrypoint }),
        ...(observation.runtimeDigest === undefined ? {} : { runtimeDigest: observation.runtimeDigest }),
        storageBackend: requested.storageBackend!,
        ...(requested.postgresCaFile === undefined ? {} : { postgresCaFile: requested.postgresCaFile }),
        launchEnvironment: requested.launchEnvironment,
        ...(observation.credentialDirectory === undefined ? {} : { credentialDirectory: observation.credentialDirectory }),
        ...(observation.credentialFiles === undefined ? {} : { credentialFiles: observation.credentialFiles }),
        stopTimeoutMs: requested.stopTimeoutMs,
        realpath,
      });
    } catch {
      return undefined;
    }
  }

  function exactNoLivePidProof(): boolean {
    try {
      const first = readOwnedPid();
      if (first !== null && isAlive(first)) return false;
      const second = readOwnedPid();
      if (second !== first) return false;
      return second === null || !isAlive(second);
    } catch {
      // Incomplete process evidence is not a live-PID proof. Preserve the
      // fail-closed refusal result rather than leaking a seam/host exception.
      return false;
    }
  }

  let managedSupervisorForCleanup: Supervisor | undefined;
  let managedSpecForCleanup: SupervisorSpec | undefined;
  // Keep the exact one-launch credential directory separate from manager
  // observations.  Cleanup may use it only after the operation-owned manager
  // stop has proved that this exact job is absent.
  let managedCredentialDirectoryForCleanup: string | undefined;
  let managedCleanupAuthorized = opts._managedOperationAuthorized === true;
  let managedOperationOwned = opts._managedOperationAuthorized === true;
  let managedOperationAmbiguous = false;
  let managedOperationManagerPid: number | undefined = opts._managedOperationManagerPid;

  async function createManagedSupervisor(kind: SupervisorKind): Promise<{
    spec: SupervisorSpec;
    supervisor: Supervisor;
  } | null> {
    const stateRoot = dirname(opts.pidFilePath);
    const executable = opts.spawnCommand ?? process.execPath;
    const baseSpawnArgs = opts.spawnArgs
      ?? [testScope?.entrypoint ?? expectedEntrypoint ?? process.argv[1], "daemon", "start", "--foreground"];
    const args = testScope
      ? [...baseSpawnArgs, ...daemonLifecycleTestIdentityArgs(testScope)]
      : baseSpawnArgs;
    if (!isAbsolute(executable) || args.some((arg) => typeof arg !== "string")) {
      return null;
    }
    let scope: ReturnType<typeof canonicalSupervisorScope>;
    try {
      scope = canonicalSupervisorScope(stateRoot, realpath);
    } catch {
      return null;
    }
    // The managed PATH participates in the authenticated manager identity.
    // Anchor it to the canonical supervisor state root, never to the caller's
    // mutable process.cwd(), while managedDaemonPath retains its public
    // caller-cwd default for doctor and other direct consumers.
    const launchEnvironment = managedLaunchEnvironmentFor(
      dependencies.environment,
      executable,
      args,
      scope.stateRoot,
    );
    let spec: SupervisorSpec;
    try {
      spec = createSupervisorSpec({
        kind,
        stateRoot: scope.stateRoot,
        port: opts.port,
        nonce: opts._supervisorNonceOverride?.() ?? supervisorNonce(),
        executable,
        args,
        entrypoint: expectedEntrypoint,
        runtimeDigest: expectedRuntimeDigest,
        storageBackend: expectedStorageBackend,
        postgresCaFile: dependencies.environment.LCM_POSTGRES_CA_FILE,
        // Manager transport is deliberately narrower than the managed child
        // environment. Filter the full lifecycle source independently so
        // non-secret configuration/runtime values such as HOME and the
        // PostgreSQL CA pathname are not lost while credentials remain out.
        launchEnvironment,
        stopTimeoutMs: supervisorCommandTimeoutMs(opts.spawnTimeoutMs),
        realpath,
        ...(opts._supervisorCredentialDirectoryOverride === undefined ? {} : { credentialDirectory: opts._supervisorCredentialDirectoryOverride }),
        ...(opts._supervisorCredentialFilesOverride === undefined ? {} : { credentialFiles: opts._supervisorCredentialFilesOverride }),
      });
    } catch {
      return null;
    }
    const supervisor = opts._supervisorOverride
      ?? opts._supervisor
      ?? createSupervisor(kind, {
          run: supervisorCommandRunner(dependencies, opts),
          environment: launchEnvironment,
          platform,
          uid: dependencies.uid,
          commandTimeoutMs: supervisorCommandTimeoutMs(opts.spawnTimeoutMs),
          stopTimeoutMs: supervisorCommandTimeoutMs(opts.spawnTimeoutMs),
          sleep: sleepFn,
          now: monotonicNow,
        });
    managedSupervisorForCleanup = supervisor;
    managedSpecForCleanup = spec;
    return { spec, supervisor };
  }

  async function cleanupManagedScopeResources(): Promise<void> {
    if (
      (managedOperationAmbiguous && testScope === undefined)
      || (!testScope && (!managedCleanupAuthorized || !managedOperationOwned))
      || (managedOperationOwned && !managedOperationAmbiguous && (
        managedSupervisorForCleanup === undefined
        || managedSpecForCleanup === undefined
      ))
    ) return;
    const stages: Array<() => void | Promise<void>> = [];
    const managerAbsenceRequired = managedOperationOwned && !managedOperationAmbiguous;
    let managerAbsenceProven = !managerAbsenceRequired;
    if (managerAbsenceRequired) {
      stages.push(
        async () => {
          await managedSupervisorForCleanup!.stopAndAwaitAbsent(
            managedSpecForCleanup!,
            { deadline },
          );
          managerAbsenceProven = true;
        },
      );
      if (managedCredentialDirectoryForCleanup !== undefined) {
        const credentialDirectory = managedCredentialDirectoryForCleanup;
        const credentialStateRoot = managedSpecForCleanup!.stateRoot;
        stages.push(() => {
          if (!managerAbsenceProven) return;
          // The directory is authenticated at staging time and revalidated by
          // the descriptor-safe cleanup helper.  Missing consumed files and a
          // directory already removed by the supervisor are idempotent.
          cleanupManagedCredentialDirectory(credentialDirectory, credentialStateRoot);
        });
      }
      stages.push(
        () => {
          if (!managerAbsenceProven) return;
          const currentPid = readOwnedPid();
          if (
            managedOperationManagerPid === undefined
            || currentPid !== managedOperationManagerPid
          ) return;
          cleanOwnedPid();
        },
      );
      if (scopedState !== undefined) {
        stages.push(() => {
          if (!managerAbsenceProven) return;
          assertScopedStateAccess(scopedState!);
          rmSync(tokenPath, { force: true });
          assertScopedStateAccess(scopedState!);
        });
      }
    }
    if (testScope !== undefined) {
      stages.push(...[testScope.runtimeDir, testScope.credentialDir].map((path) => () => {
        assertLifecycleScopeOwnsCurrentCleanupRoot(testScope!, path);
        rmSync(path, { recursive: true, force: true });
      }));
      stages.push(() => {
        if (!managerAbsenceProven) return;
        assertLifecycleScopeOwnsCurrentCleanupRoot(testScope!, testScope.stateDir);
        rmSync(testScope.stateDir, { recursive: true, force: true });
      });
    }
    await runCleanupStages(stages);
  }

  async function runManagedEnsure(kind: SupervisorKind): Promise<EnsureDaemonResult | null> {
    const managed = await createManagedSupervisor(kind);
    if (managed === null) return refusalResult(
      "ambiguous",
      "managed daemon supervisor could not be constructed; inspect the daemon configuration and retry",
    );
    const { spec, supervisor } = managed;
    let requestedSpec = spec;
    let observation: SupervisorObservation;
    try {
      observation = await supervisor.probe(spec, { deadline });
    } catch {
      return refusalResult(
        "ambiguous",
        "managed daemon supervisor probe failed; inspect the daemon manager and retry",
      );
    }

    // A fresh per-start nonce is not part of the stable manager name. When a
    // registered job exposes a different authenticated launch nonce, rebuild
    // its exact observed spec and adopt that launch identity only after a
    // second manager probe. Credential metadata must remain safely bounded;
    // never infer or recreate consumed one-shot credential files.
    if (
      observation.kind === "registered-stale-config"
      || (
        (observation.kind === "registered-running-valid" || observation.kind === "registered-not-running-valid")
        && observation.nonce !== spec.nonce
      )
    ) {
      const observedSpec = observedSupervisorSpec(spec, observation);
      if (observedSpec !== undefined) {
        try {
          const observed = await supervisor.probe(observedSpec, { deadline });
          if (
            observed.kind === "registered-running-valid"
            || (
              observed.kind === "registered-not-running-valid"
              && observedSpec.credentialDirectory === undefined
              && (observedSpec.credentialFiles?.length ?? 0) === 0
            )
          ) {
            requestedSpec = observedSpec;
            observation = observed;
          }
        } catch {
          // Preserve the stale/ambiguous refusal below.
        }
      }
    }

    // The only compatibility downgrade is an unavailable manager during the
    // initial preflight. Every other manager observation remains authoritative.
    if (observation.kind === "unavailable") {
      if (!isSupervisorPreflightUnavailableReason(observation.reason)) {
        return refusalResult(
          "manager-unavailable",
          `managed daemon supervisor preflight failed (${observation.reason}); refusing detached fallback`,
        );
      }
      managerPreflightUnavailable = true;
      return null;
    }
    if (observation.kind === "registered-stale-config") {
      return refusalResult(
        "stale-config",
        "managed daemon supervisor has stale configuration; run 'lcm daemon restart' explicitly",
      );
    }
    if (observation.kind === "registered-invalid-collision") {
      return refusalResult(
        "invalid-collision",
        "managed daemon supervisor found a foreign job for this state root; inspect the manager and retry",
      );
    }
    if (observation.kind === "ambiguous") {
      return refusalResult(
        "ambiguous",
        "managed daemon supervisor returned ambiguous state; inspect the manager and retry",
      );
    }
    if (opts._abortSignal?.aborted) {
      return {
        connected: false,
        port: opts.port,
        spawned: false,
        warning: "daemon lifecycle was interrupted before startup",
      };
    }

    const noLivePid = exactNoLivePidProof();
    if (observation.kind === "registered-not-running-valid") {
      if (!noLivePid) {
        return refusalResult(
          "not-running",
          "managed daemon was registered but its PID state is still live; refusing replacement",
        );
      }
      cleanOwnedPid();
      if (opts._skipSpawn || monotonicNow() >= deadline) {
        return refusalResult("not-running", "managed daemon is not running; explicit start is required");
      }
      return startManagedDaemon(requestedSpec, supervisor, true);
    }
    if (observation.kind === "absent") {
      // Probe first, then take one bounded endpoint observation before
      // registering a new job. A responsive endpoint is a collision even when
      // the manager has no matching registration; a pre-header no-response is
      // the only observation that permits the managed start path.
      const preStartDeadline = remainingRequestDeadline();
      if (preStartDeadline) {
        const preStartHealth = await observeDaemonHealth(opts.port, fetchFn, preStartDeadline);
        if (opts._abortSignal?.aborted) {
          return {
            connected: false,
            port: opts.port,
            spawned: false,
            warning: "daemon lifecycle was interrupted before startup",
          };
        }
        if (preStartHealth.kind === "response") {
          return refusalResult(
            preStartHealth.body === "timeout" ? "response-timeout" : "invalid-collision",
            "managed daemon endpoint responded while its supervisor job was absent; refusing replacement",
          );
        }
      }
      if (!noLivePid) {
        return refusalResult(
          "invalid-collision",
          "managed daemon is absent but a live PID owns its state; refusing replacement",
        );
      }
      cleanOwnedPid();
      if (opts._skipSpawn || monotonicNow() >= deadline) {
        return refusalResult("absent", "managed daemon is not registered; explicit start is required");
      }
      return startManagedDaemon(spec, supervisor, false);
    }

    // A registered-running job must be admitted through a responsive,
    // authenticated endpoint. There is no offline ensure recovery path.
    const authorizedManagerPid = opts._managedOperationAuthorized === true
      ? opts._managedOperationManagerPid
      : undefined;
    const hasAuthorizedManagerStartup = authorizedManagerPid !== undefined;
    const exactAuthorizedManagerObservation = (candidate: SupervisorObservation): boolean =>
      hasAuthorizedManagerStartup
      && supervisorMetadataMatches(candidate, requestedSpec)
      && candidate.managerPid === authorizedManagerPid;
    if (hasAuthorizedManagerStartup && !exactAuthorizedManagerObservation(observation)) {
      managedOperationAmbiguous = true;
      return refusalResult(
        "ambiguous",
        "managed daemon manager identity changed before startup admission",
        { pid: authorizedManagerPid },
      );
    }
    const healthDeadline = remainingRequestDeadline();
    if (!healthDeadline) return refusalResult("startup-failure", "managed daemon health deadline expired");
    let healthObservation = await observeDaemonHealth(opts.port, fetchFn, healthDeadline);
    if (healthObservation.kind === "no-response" && hasAuthorizedManagerStartup) {
      // A manager operation authorized by explicit restart has already proved
      // the exact replacement registration. Give that process a bounded
      // admission window to publish daemon.pid and answer health. This is
      // deliberately scoped to the authenticated manager name/scope/nonce/PID;
      // ordinary ensure/doctor still refuses a live no-response immediately.
      const maxStartupAdmissionAttempts = Math.max(1, Math.ceil(opts.spawnTimeoutMs / 300));
      for (
        let attempt = 0;
        attempt < maxStartupAdmissionAttempts && healthObservation.kind === "no-response";
        attempt += 1
      ) {
        let startupProbe: SupervisorObservation;
        try {
          startupProbe = await supervisor.probe(requestedSpec, { deadline });
        } catch {
          managedOperationAmbiguous = true;
          return refusalResult(
            "ambiguous",
            "managed daemon supervisor could not be re-probed during startup admission",
            { pid: authorizedManagerPid },
          );
        }
        if (!exactAuthorizedManagerObservation(startupProbe)) {
          managedOperationAmbiguous = true;
          return refusalResult(
            "ambiguous",
            "managed daemon manager identity changed during startup admission",
            { pid: authorizedManagerPid },
          );
        }
        const remainingMs = deadline - monotonicNow();
        if (remainingMs <= 0) break;
        await sleepFn(Math.min(300, remainingMs));
        const nextHealthDeadline = remainingRequestDeadline();
        if (!nextHealthDeadline) break;
        healthObservation = await observeDaemonHealth(opts.port, fetchFn, nextHealthDeadline);
      }
      if (healthObservation.kind === "no-response") {
        let finalStartupProbe: SupervisorObservation;
        try {
          finalStartupProbe = await supervisor.probe(requestedSpec, { deadline });
        } catch {
          managedOperationAmbiguous = true;
          return refusalResult(
            "ambiguous",
            "managed daemon supervisor could not be re-probed after startup admission",
            { pid: authorizedManagerPid },
          );
        }
        if (!exactAuthorizedManagerObservation(finalStartupProbe)) {
          managedOperationAmbiguous = true;
          return refusalResult(
            "ambiguous",
            "managed daemon manager identity changed after startup admission",
            { pid: authorizedManagerPid },
          );
        }
        return refusalResult(
          "startup-failure",
          "managed daemon supervisor started a job but its endpoint was not admitted before the deadline",
          { pid: authorizedManagerPid },
        );
      }
    }
    if (healthObservation.kind === "no-response") {
      let secondProbe: SupervisorObservation;
      try {
        secondProbe = await supervisor.probe(requestedSpec, { deadline });
      } catch {
        return refusalResult("ambiguous", "managed daemon supervisor could not be re-probed after the no-response observation", { pid: observation.managerPid });
      }
      const sameManager = supervisorMetadataMatches(secondProbe, requestedSpec)
        && secondProbe.managerPid === observation.managerPid;
      const sameEndpoint = observation.managerPid !== undefined
        && readOwnedPid() === observation.managerPid
        && isAlive(observation.managerPid)
        && (opts._listeningPortsOverride
          ? opts._listeningPortsOverride(observation.managerPid).includes(opts.port)
          : findListeningTcpPorts(observation.managerPid, platform, dependencies.spawnSync, procRoot, opts.port).includes(opts.port));
      if (!sameManager || !sameEndpoint) {
        return refusalResult("ambiguous", "managed daemon manager or endpoint identity changed during the no-response observation", { pid: observation.managerPid });
      }
      return refusalResult(
        "live-no-response",
        "managed daemon is running but gave no HTTP response; explicit restart is required",
        { pid: observation.managerPid },
      );
    }
    if (healthObservation.body !== "valid" || healthObservation.parsedBody === undefined) {
      return refusalResult(
        observationRefusalReason(healthObservation),
        "managed daemon returned an invalid health response; inspect the daemon and retry",
        { pid: observation.managerPid },
      );
    }
    const health = healthObservation.parsedBody;
    let secondProbe: SupervisorObservation;
    try {
      secondProbe = await supervisor.probe(requestedSpec, { deadline });
    } catch {
      managedOperationAmbiguous = true;
      return refusalResult("ambiguous", "managed daemon supervisor could not be re-probed before endpoint admission", { pid: observation.managerPid });
    }
    if (hasAuthorizedManagerStartup && !exactAuthorizedManagerObservation(secondProbe)) {
      managedOperationAmbiguous = true;
      return refusalResult("ambiguous", "managed daemon manager identity changed before authenticated admission", { pid: authorizedManagerPid });
    }
    if (!isRecognizedDaemonHealth(health)
      || !supervisorMetadataMatches(secondProbe, requestedSpec)
      || secondProbe.managerPid !== observation.managerPid
      || !managerEndpointIdentityMatches(secondProbe, health, requestedSpec)) {
      return refusalResult(
        "invalid-collision",
        "managed daemon endpoint identity did not match its supervisor job; refusing reuse",
        { pid: observation.managerPid },
      );
    }
    const publicStorageBackend = recognizedHealthStorageBackend(health);
    if (publicStorageBackend === null) {
      return refusalResult("response-invalid", "managed daemon reported an unknown storage backend", { pid: observation.managerPid });
    }
    const authenticated = await checkDaemonDiagnostics(
      opts.port,
      tokenPath,
      fetchFn,
      remainingRequestDeadline,
      health,
      publicStorageBackend,
      readOwnedToken,
    );
    if (authenticated === null) {
      return refusalResult("response-auth-failure", "managed daemon health could not be authenticated", { pid: observation.managerPid });
    }
    let finalProbe: SupervisorObservation;
    try {
      finalProbe = await supervisor.probe(requestedSpec, { deadline });
    } catch {
      managedOperationAmbiguous = true;
      return refusalResult("ambiguous", "managed daemon supervisor could not be re-probed after authenticated admission", { pid: observation.managerPid });
    }
    if (!managerEndpointIdentityMatches(finalProbe, authenticated, requestedSpec)
      || finalProbe.managerPid !== observation.managerPid) {
      managedOperationAmbiguous = true;
      return refusalResult("ambiguous", "managed daemon manager identity changed after authenticated admission", { pid: observation.managerPid });
    }
    const accepted = await daemonResult(
      authenticated,
      false,
      managerKind,
      { alreadyVerified: true },
      undefined,
      true,
    );
    return accepted ?? refusalResult("response-invalid", "managed daemon identity could not be admitted", { pid: observation.managerPid });
  }

  async function startManagedDaemon(
    spec: SupervisorSpec,
    supervisor: Supervisor,
    recreateRegisteredJob: boolean,
  ): Promise<EnsureDaemonResult> {
    if (opts._abortSignal?.aborted) {
      return {
        connected: false,
        port: opts.port,
        spawned: false,
        warning: "daemon lifecycle was interrupted before startup",
      };
    }
    managedCleanupAuthorized = true;
    // Credential staging is preparation, not manager ownership.  Do not let a
    // staging failure trigger cleanup against a registration that may have
    // appeared concurrently while no mutation was attempted.
    managedOperationOwned = false;
    let launchSpec: SupervisorSpec;
    try {
      const staged = stageManagedCredentials(spec, dependencies.environment);
      launchSpec = staged.spec;
      managedSpecForCleanup = staged.spec;
      managedCredentialDirectoryForCleanup = staged.credentialDirectory;
    } catch {
      return refusalResult("startup-failure", "managed daemon credentials could not be prepared", { spawned: false });
    }
    managedOperationOwned = true;
    const managerOperation = { deadline };
    let started: { managerPid?: number };
    try {
      started = recreateRegisteredJob
        ? await supervisor.stopAndStart(launchSpec, managerOperation)
        : await supervisor.start(launchSpec, managerOperation);
    } catch {
      // A settled manager mutation that throws may have raced a concurrent
      // winner.  The supervisor owns its own absent-proof cleanup; lifecycle
      // must not issue a second stop against unresolved manager state.
      managedOperationOwned = false;
      managedOperationAmbiguous = true;
      return refusalResult("startup-failure", "managed daemon supervisor start failed", { spawned: false });
    }
    let second: SupervisorObservation;
    try {
      second = await supervisor.probe(launchSpec, managerOperation);
    } catch {
      // A post-start re-probe is part of the ownership proof.  If it cannot
      // settle, the manager mutation may have raced a concurrent winner; do
      // not issue lifecycle cleanup against unresolved manager state.
      managedOperationOwned = false;
      managedOperationAmbiguous = true;
      return refusalResult("startup-failure", "managed daemon supervisor could not be re-probed after start", { spawned: true, startMethod: managerKind });
    }
    if (!supervisorMetadataMatches(second, launchSpec)
      || (started.managerPid !== undefined && second.managerPid !== started.managerPid)) {
      managedOperationOwned = false;
      managedOperationAmbiguous = true;
      return refusalResult("ambiguous", "managed daemon supervisor identity changed during start", { spawned: true, startMethod: managerKind });
    }
    const managerPid = second.managerPid;
    managedOperationManagerPid = managerPid;
    if (opts._abortSignal?.aborted) {
      return {
        connected: false,
        port: opts.port,
        spawned: true,
        startMethod: managerKind,
        warning: "daemon lifecycle was interrupted",
      };
    }
    if (opts._skipHealthWait) {
      return {
        connected: false,
        port: opts.port,
        spawned: true,
        pid: managerPid,
        startMethod: managerKind,
        restartedForParent,
      };
    }
    while (true) {
      if (opts._abortSignal?.aborted) {
        return {
          connected: false,
          port: opts.port,
          spawned: true,
          pid: managerPid,
          startMethod: managerKind,
          warning: "daemon lifecycle was interrupted",
        };
      }
      const healthDeadline = remainingRequestDeadline();
      if (!healthDeadline) break;
      const healthObservation = await observeDaemonHealth(opts.port, fetchFn, healthDeadline);
      if (healthObservation.kind === "response" && healthObservation.body === "valid" && healthObservation.parsedBody !== undefined) {
        const health = healthObservation.parsedBody;
        if (isRecognizedDaemonHealth(health) && managerEndpointIdentityMatches(second, health, launchSpec)) {
          const storage = recognizedHealthStorageBackend(health);
          if (storage !== null) {
            const authenticated = await checkDaemonDiagnostics(
              opts.port,
              tokenPath,
              fetchFn,
              remainingRequestDeadline,
              health,
              storage,
              readOwnedToken,
            );
            if (authenticated !== null) {
              let finalProbe: SupervisorObservation;
              try {
                finalProbe = await supervisor.probe(launchSpec, managerOperation);
              } catch {
                managedOperationOwned = false;
                managedOperationAmbiguous = true;
                return refusalResult(
                  "ambiguous",
                  "managed daemon supervisor could not be re-probed after authenticated admission",
                  { spawned: true, pid: managerPid, startMethod: managerKind },
                );
              }
              if (!managerEndpointIdentityMatches(finalProbe, authenticated, launchSpec)
                || finalProbe.managerPid !== managerPid) {
                managedOperationOwned = false;
                managedOperationAmbiguous = true;
                return refusalResult(
                  "ambiguous",
                  "managed daemon manager identity changed after authenticated admission",
                  { spawned: true, pid: managerPid, startMethod: managerKind },
                );
              }
              const accepted = await daemonResult(
                authenticated,
                true,
                managerKind,
                { alreadyVerified: true },
                undefined,
                true,
              );
              if (accepted) {
                if (managedCredentialDirectoryForCleanup !== undefined) {
                  try {
                    cleanupManagedCredentialDirectory(
                      managedCredentialDirectoryForCleanup,
                      launchSpec.stateRoot,
                    );
                    managedCredentialDirectoryForCleanup = undefined;
                  } catch {
                    return refusalResult(
                      "startup-failure",
                      "managed daemon was admitted but its staged credentials could not be erased",
                      { spawned: true, pid: managerPid, startMethod: managerKind },
                    );
                  }
                }
                return accepted;
              }
            }
          }
        }
      }
      const remainingMs = deadline - monotonicNow();
      if (remainingMs <= 0) break;
      await sleepFn(Math.min(300, remainingMs));
    }
    return refusalResult(
      "startup-failure",
      "managed daemon supervisor started a job but its endpoint was not admitted before the deadline",
      { spawned: true, pid: managerPid, startMethod: managerKind },
    );
  }

  let concurrentReplacementPid: number | undefined;
  let managerPreflightUnavailable = false;

  if (managerKind !== undefined) {
    const managedResult = await runManagedEnsure(managerKind);
    if (managedResult !== null) {
      const hasPrimaryManagedOutcome = managedResult.refusalReason !== undefined
        || isManagedInterruptionResult(managedResult, opts._abortSignal);
      const failedManagedOperation = managedCleanupAuthorized
        && managedOperationOwned
        && !managedOperationAmbiguous
        && !managedResult.connected
        && (managedResult.refusalReason !== undefined || opts._abortSignal?.aborted === true);
      const ownedTestStart = testScope
        && managedResult.spawned
        && managedOperationOwned
        && !managedOperationAmbiguous;
      // Hermetic test roots remain independently fenced even when manager
      // ownership is ambiguous; production manager/PID cleanup stays
      // suppressed by cleanupManagedScopeResources in that case.
      const failedTestOperation = testScope !== undefined
        && managedCleanupAuthorized
        && !managedResult.connected;
      if (ownedTestStart || failedManagedOperation || failedTestOperation) {
        try {
          await cleanupManagedScopeResources();
        } catch (error) {
          if (!failedManagedOperation || !hasPrimaryManagedOutcome) throw error;
        }
      }
      return managedResult;
    }
    if (managerPreflightUnavailable && opts._suppressDetachedFallback) {
      return refusalResult(
        "manager-unavailable",
        "managed daemon supervisor became unavailable after a manager operation; refusing detached fallback",
      );
    }
  }

  // Step 1: Check if daemon is already running via health check
  const initialHealthDeadline = remainingRequestDeadline();
  const initialHealthObservation: HealthObservation<HealthResponse> = initialHealthDeadline
    ? await observeDaemonHealth(opts.port, fetchFn, initialHealthDeadline)
    : { kind: "no-response", reason: "header-timeout" };
  const health = initialHealthObservation.kind === "response"
    && initialHealthObservation.body === "valid"
    ? initialHealthObservation.parsedBody!
    : null;
  const detachedCompatibility = managerKind === undefined;
  if ((managerPreflightUnavailable || detachedCompatibility) && initialHealthObservation.kind === "no-response") {
    try {
      const existingPid = readOwnedPid();
      if (existingPid !== null && isAlive(existingPid)) {
        return refusalResult(
          "detached-no-response",
          "detached daemon gave no HTTP response; refusing offline PID recovery",
          { pid: existingPid },
        );
      }
    } catch {
      // Preserve best-effort detached stale-state behavior when process
      // inspection itself is unavailable; the subsequent PID path remains
      // fail-closed and never signals an unverified process.
    }
  }
  if (
    (managerPreflightUnavailable || detachedCompatibility)
    && initialHealthObservation.kind === "response"
    && initialHealthObservation.body !== "valid"
  ) {
    try {
      const existingPid = readOwnedPid();
      if (existingPid !== null && isAlive(existingPid)) {
        return refusalResult(
          observationRefusalReason(initialHealthObservation),
          "detached daemon returned an invalid health response; refusing PID recovery",
          { pid: existingPid },
        );
      }
    } catch {
      // Fall through to the existing scoped-state checks.
    }
  }
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
        if (!isRecognizedDaemonHealth(retry) && !opts._abortSignal?.aborted) {
          const preserved = preserveBusyOwnedDaemon(pid);
          if (preserved) return preserved;
          const replacementPid = readOwnedPid();
          if (replacementPid !== null && replacementPid !== pid) {
            return waitForConcurrentReplacement(replacementPid);
          }
        }
        if (enforceParent && !repairedMismatch) {
          const parent = inspectParent();
          const signalStateMatches = isRecognizedDaemonHealth(retry)
            ? ownedPidConfiguredListenerStateMatches(pid, true)
            : opts._abortSignal?.aborted
              ? ownedPidIsLiveLikelyDaemon(pid)
              : ownedPidConfiguredListenerStateMatches(pid, false);
          if (
            parent.available
            && parent.pid === pid
            && signalStateMatches
          ) {
            await terminatePid(pid, { isAlive, killProcess, sleepFn });
            restartedForParent = true;
          }
        }
      }
    } catch (error) {
      if (error instanceof LifecycleTestScopeStateError) throw error;
    }
    if (!repairedMismatch) {
      const currentPid = readOwnedPid();
      if (currentPid !== null && currentPid !== pidFilePid) {
        return waitForConcurrentReplacement(currentPid);
      }
      let currentPidIsAlive = false;
      try {
        currentPidIsAlive = currentPid === pidFilePid && isAlive(pidFilePid);
      } catch {
        return refusalResult(
          "ambiguous",
          "daemon PID liveness could not be verified; preserving the PID file and refusing replacement",
          { pid: pidFilePid },
        );
      }
      if (currentPidIsAlive) {
        return refusalResult(
          "ambiguous",
          "daemon PID state is still live but its identity could not be proven; preserving the PID file and refusing replacement",
          { pid: pidFilePid },
        );
      }
      cleanOwnedPid();
    }
  }

  // Step 3: Spawn daemon (unless skipped for testing)
  if (opts._skipSpawn || monotonicNow() >= deadline) {
    return { connected: false, port: opts.port, spawned: false };
  }

  const spawnCommand = opts.spawnCommand ?? process.execPath;
  const baseSpawnArgs = opts.spawnArgs
    ?? [testScope?.entrypoint ?? expectedEntrypoint ?? process.argv[1], "daemon", "start", "--foreground"];
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

  // Managed starts are handled entirely by runManagedEnsure above. Reaching
  // this branch means either detached mode was explicitly requested or the
  // initial manager preflight was unavailable; only that preflight boundary
  // permits the compatibility detached spawn.
  if (managerPreflightUnavailable) {
    warning = "user service manager unavailable; used detached spawn compatibility fallback; daemon parent invariant is not verified";
  }
  detachedStart = startViaDetachedSpawn(
    opts,
    spawnCommand,
    spawnArgs,
    dependencies,
    scopedState,
  );

  let cleanupPromise: Promise<void> | undefined;
  const cleanupOwnedLifecycle = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async (): Promise<void> => {
      const stages: CleanupFn[] = [];
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
  assertLifecycleBackendPublication(opts);
  const result = await restartDaemonUnlocked(opts);
  assertLifecycleBackendPublication(opts);
  return result;
}

async function restartDaemonUnlocked(opts: RestartDaemonOptions): Promise<RestartDaemonResult> {
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
  const windowsPowerShellPath = opts._windowsPowerShellPathOverride === undefined
    ? resolveWindowsPowerShellPath(
        dependencies.environment.SystemRoot,
        dependencies.environment.WINDIR,
      )
    : opts._windowsPowerShellPathOverride;
  const expectedVersion = opts.expectedVersion ?? PKG_VERSION;
  const expectedEntrypoint = testScope?.entrypoint
    ?? opts.expectedEntrypoint
    ?? opts._packagedEntrypointOverride
    ?? PACKAGED_RUNTIME_ENTRYPOINT;
  const ensureOptionsWithEntrypoint = { ...ensureOptions, expectedEntrypoint };
  const monotonicNow = opts._monotonicNowOverride ?? performance.now.bind(performance);
  const setTimeoutFn = opts._setTimeoutOverride ?? setTimeout;
  const clearTimeoutFn = opts._clearTimeoutOverride ?? clearTimeout;
  const verificationDeadline = monotonicNow() + opts.spawnTimeoutMs;
  const managerKind = managedSupervisorKind(platform, opts.enforceUserManagerParent);
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
        expectedEntrypoint,
        platform,
        procRoot,
        realpath,
      );
  }

  function restartRefusal(
    refusalReason: DaemonLifecycleRefusalReason,
    warning: string,
    extra: Partial<RestartDaemonResult> = {},
  ): RestartDaemonResult {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      restarted: false,
      refusalReason,
      warning,
      ...extra,
    };
  }

  function exactNoLivePidProof(): boolean {
    try {
      const first = readOwnedPid();
      if (first !== null && isAlive(first)) return false;
      const second = readOwnedPid();
      if (second !== first) return false;
      return second === null || !isAlive(second);
    } catch {
      return false;
    }
  }

  async function runManagedRestart(managerKind: SupervisorKind): Promise<RestartDaemonResult | null> {
    const stateRoot = dirname(opts.pidFilePath);
    const executable = opts.spawnCommand ?? process.execPath;
    const baseSpawnArgs = opts.spawnArgs
      ?? [testScope?.entrypoint ?? expectedEntrypoint ?? process.argv[1], "daemon", "start", "--foreground"];
    const args = testScope
      ? [...baseSpawnArgs, ...daemonLifecycleTestIdentityArgs(testScope)]
      : baseSpawnArgs;
    if (!isAbsolute(executable) || args.some((arg) => typeof arg !== "string")) {
      return restartRefusal("ambiguous", "managed daemon supervisor could not be constructed; inspect the daemon configuration and retry");
    }
    let scope: ReturnType<typeof canonicalSupervisorScope>;
    try {
      scope = canonicalSupervisorScope(stateRoot, realpath);
    } catch {
      return restartRefusal("ambiguous", "managed daemon state root is not canonical; inspect the daemon configuration and retry");
    }
    const launchEnvironment = managedLaunchEnvironmentFor(
      dependencies.environment,
      executable,
      args,
      scope.stateRoot,
    );
    let spec: SupervisorSpec;
    try {
      spec = createSupervisorSpec({
        kind: managerKind,
        stateRoot: scope.stateRoot,
        port: opts.port,
        nonce: opts._supervisorNonceOverride?.() ?? supervisorNonce(),
        executable,
        args,
        entrypoint: expectedEntrypoint,
        runtimeDigest: opts.expectedRuntimeDigest ?? RUNTIME_DIGEST,
        storageBackend: opts.expectedStorageBackend ?? "sqlite",
        postgresCaFile: dependencies.environment.LCM_POSTGRES_CA_FILE,
        launchEnvironment,
        stopTimeoutMs: supervisorCommandTimeoutMs(opts.spawnTimeoutMs),
        realpath,
      });
    } catch {
      return restartRefusal("ambiguous", "managed daemon supervisor specification is invalid; inspect the daemon configuration and retry");
    }
    const supervisor = opts._supervisorOverride
      ?? opts._supervisor
      ?? createSupervisor(managerKind, {
          run: supervisorCommandRunner(dependencies, opts),
          environment: launchEnvironment,
          platform,
          uid: dependencies.uid,
          commandTimeoutMs: supervisorCommandTimeoutMs(opts.spawnTimeoutMs),
          stopTimeoutMs: supervisorCommandTimeoutMs(opts.spawnTimeoutMs),
          sleep: dependencies.sleep,
          now: monotonicNow,
        });
    if (opts._abortSignal?.aborted) {
      return restartRefusal("response-timeout", "daemon lifecycle was interrupted before legacy migration");
    }
    let observation: SupervisorObservation;
    try {
      // Probe before any PID read, health request, signal, or start. Only an
      // allowlisted preflight-unavailable result may fall through before mutation.
      observation = await supervisor.probe(spec, { deadline: verificationDeadline });
    } catch {
      return restartRefusal("ambiguous", "managed daemon supervisor probe failed; inspect the manager and retry");
    }
    if (observation.kind === "unavailable") {
      if (!isSupervisorPreflightUnavailableReason(observation.reason)) {
        return restartRefusal(
          "manager-unavailable",
          `managed daemon supervisor preflight failed (${observation.reason}); refusing detached fallback`,
        );
      }
      return null;
    }
    if (observation.kind === "registered-invalid-collision") {
      return restartRefusal("invalid-collision", "managed daemon supervisor found a foreign job for this state root; refusing restart");
    }
    if (observation.kind === "ambiguous") {
      return restartRefusal("ambiguous", "managed daemon supervisor returned ambiguous state; refusing restart");
    }
    const ensure = _ensureDaemonOverride ?? ensureDaemon;
    const ensureAfterManagerOperation = async (
      managerPid?: number,
      admittedSpec?: SupervisorSpec,
      restarted = false,
      stoppedPidOverride?: number,
    ): Promise<RestartDaemonResult> => {
      const remainingSpawnTimeoutMs = Math.max(0, Math.floor(verificationDeadline - monotonicNow()));
      const ensured = await ensure({
        ...ensureOptions,
        spawnTimeoutMs: remainingSpawnTimeoutMs,
        expectedEntrypoint,
        _monotonicNowOverride: monotonicNow,
        _suppressDetachedFallback: true,
        _managedOperationAuthorized: true,
        ...(managerPid === undefined ? {} : { _managedOperationManagerPid: managerPid }),
        ...(admittedSpec === undefined ? {} : {
          _supervisorNonceOverride: () => admittedSpec.nonce,
          _supervisorCredentialDirectoryOverride: admittedSpec.credentialDirectory,
          _supervisorCredentialFilesOverride: admittedSpec.credentialFiles,
        }),
      });
      return {
        ...ensured,
        restarted,
        stoppedPid: stoppedPidOverride
          ?? (observation.kind === "registered-running-valid" ? observation.managerPid : undefined),
      };
    };
    const stopStartAndEnsure = async (): Promise<RestartDaemonResult> => {
      const staged = stageManagedCredentials(spec, dependencies.environment);
      // The staged one-launch credential directory belongs to the launched
      // daemon until endpoint admission succeeds: a throwing stop/start leaves
      // the manager state unresolved, and until admission the launchd daemon
      // may still consume the secrets from this directory.  Delete it only
      // after admission; on every other outcome preserve it as evidence.  A
      // failsafe refusal here must leak the directory rather than destroy
      // live launch evidence, so no cleanup satisfies its own refusal.
      let admitted = false;
      try {
        const started = await supervisor.stopAndStart(staged.spec, { deadline: verificationDeadline });
        const ensured = await ensureAfterManagerOperation(started.managerPid, staged.spec, true);
        admitted = ensured.connected === true;
        return ensured;
      } finally {
        if (admitted && staged.credentialDirectory !== undefined) {
          try { cleanupManagedCredentialDirectory(staged.credentialDirectory, spec.stateRoot); } catch { /* preserve unresolved evidence */ }
        }
      }
    };
    const startStableAndEnsure = async (stoppedPid: number): Promise<RestartDaemonResult> => {
      const staged = stageManagedCredentials(spec, dependencies.environment);
      let admitted = false;
      try {
        const started = await supervisor.start(staged.spec, { deadline: verificationDeadline });
        const ensured = await ensureAfterManagerOperation(started.managerPid, staged.spec, true, stoppedPid);
        admitted = ensured.connected === true;
        return ensured;
      } finally {
        if (admitted && staged.credentialDirectory !== undefined) {
          try { cleanupManagedCredentialDirectory(staged.credentialDirectory, spec.stateRoot); } catch { /* preserve unresolved evidence */ }
        }
      }
    };

    type LegacyMigrationAttempt =
      | Readonly<{ kind: "not-applicable" }>
      | Readonly<{ kind: "refused"; refusalReason: DaemonLifecycleRefusalReason; warning: string; pid?: number }>
      | Readonly<{ kind: "migrated"; stoppedPid: number }>;

    const legacyRefusal = (
      refusalReason: DaemonLifecycleRefusalReason,
      warning: string,
      pid?: number,
    ): Extract<LegacyMigrationAttempt, { kind: "refused" }> => ({
      kind: "refused",
      refusalReason,
      warning,
      ...(pid === undefined ? {} : { pid }),
    });

    const migrateAuthenticatedLegacyDaemon = async (): Promise<LegacyMigrationAttempt> => {
      if (
        managerKind !== "systemd-user"
        || supervisor.discoverLegacySystemdUnits === undefined
        || supervisor.stopLegacySystemdUnit === undefined
      ) return { kind: "not-applicable" };

      const discover = async (): Promise<
        | Readonly<{ kind: "refused"; refusalReason: DaemonLifecycleRefusalReason; warning: string; pid?: number }>
        | Readonly<{ kind: "candidates"; candidates: readonly LegacySystemdUnit[] }>
      > => {
        try {
          const found = await supervisor.discoverLegacySystemdUnits!({ deadline: verificationDeadline });
          if (found.kind === "unavailable") {
            return legacyRefusal(
              "manager-unavailable",
              `legacy daemon systemd discovery was unavailable (${found.reason}); refusing migration`,
            );
          }
          return found;
        } catch {
          return legacyRefusal("manager-unavailable", "legacy daemon systemd discovery failed; refusing migration");
        }
      };
      const firstPid = readLegacyPidFileEvidence(opts.pidFilePath);
      if (firstPid.kind === "unsafe") {
        return legacyRefusal("ambiguous", "legacy daemon PID evidence was not a safe regular file; refusing migration");
      }
      const secondPid = readLegacyPidFileEvidence(opts.pidFilePath);
      if (secondPid.kind === "unsafe") {
        return legacyRefusal("ambiguous", "legacy daemon PID evidence changed to an unsafe file; refusing migration");
      }
      if (
        firstPid.kind === "present"
        && secondPid.kind === "present"
        && !sameLegacyPidFileIdentity(firstPid, secondPid)
      ) {
        return legacyRefusal("ambiguous", "legacy daemon PID evidence changed between reads; refusing migration", firstPid.pid);
      }
      if (firstPid.kind === "missing" && secondPid.kind === "missing") {
        const missingPidDiscovery = await discover();
        if (missingPidDiscovery.kind === "refused") return missingPidDiscovery;
        if (missingPidDiscovery.candidates.length === 0) return { kind: "not-applicable" };
        return legacyRefusal(
          "ambiguous",
          "legacy daemon PID evidence was missing while a historical systemd candidate remained; stable replacement was not started",
        );
      }
      if (firstPid.kind === "missing" || secondPid.kind === "missing") {
        return legacyRefusal("ambiguous", "legacy daemon PID evidence disappeared between reads; refusing migration");
      }
      const discovered = await discover();
      if (discovered.kind === "refused") return discovered;
      if (discovered.candidates.length === 0) {
        return legacyRefusal("ambiguous", "legacy daemon systemd discovery found no authenticated candidate; refusing migration", firstPid.pid);
      }
      if (discovered.candidates.length !== 1) {
        return legacyRefusal("ambiguous", "legacy daemon systemd discovery found multiple candidates; refusing migration", firstPid.pid);
      }
      const candidate = discovered.candidates[0]!;
      const pid = firstPid.pid;
      if (candidate.managerPid !== pid || !Number.isSafeInteger(candidate.managerPid) || candidate.managerPid <= 0) {
        return legacyRefusal("invalid-collision", "legacy daemon manager PID did not match its owned PID file", pid);
      }
      if (!isAlive(pid)) return legacyRefusal("ambiguous", "legacy daemon PID is no longer live; refusing migration", pid);
      const publicDeadline = remainingVerificationDeadline();
      if (!publicDeadline) return legacyRefusal("response-timeout", "legacy daemon health verification deadline expired", pid);
      const publicObservation = await observeDaemonHealth(opts.port, fetchFn, publicDeadline);
      if (publicObservation.kind === "no-response") {
        return legacyRefusal("response-timeout", "legacy daemon health did not respond during migration", pid);
      }
      if (publicObservation.body !== "valid" || publicObservation.parsedBody === undefined) {
        return legacyRefusal("response-invalid", "legacy daemon returned invalid public health during migration", pid);
      }
      const publicHealth = publicObservation.parsedBody;
      if (!isRecognizedDaemonHealth(publicHealth)) {
        return legacyRefusal("response-invalid", "legacy daemon returned unrecognized public health during migration", pid);
      }
      if (publicHealth.pid !== pid || (testScope !== undefined && publicHealth.ownerId !== testScope.ownerId)) {
        return legacyRefusal("invalid-collision", "legacy daemon public health did not match its manager PID", pid);
      }
      if (!isStrictLegacyUpgradeVersion(publicHealth.version, expectedVersion)) {
        return legacyRefusal("response-invalid", "legacy daemon version was not a strict older patch in the installed release line", pid);
      }
      const storage = recognizedHealthStorageBackend(publicHealth);
      if (storage === null) return legacyRefusal("response-invalid", "legacy daemon reported an unknown storage backend", pid);
      const tokenEvidence = readLegacyTokenEvidence(tokenPath);
      if (tokenEvidence.kind !== "present") {
        return legacyRefusal("response-auth-failure", "legacy daemon token evidence was missing or unsafe", pid);
      }
      const authenticated = await checkDaemonDiagnostics(
        opts.port,
        tokenPath,
        fetchFn,
        remainingVerificationDeadline,
        publicHealth,
        storage,
        (path: string) => {
          const current = readLegacyTokenEvidence(path);
          return current.kind === "present" ? current.token : null;
        },
      );
      if (authenticated === null) return legacyRefusal("response-auth-failure", "legacy daemon health could not be authenticated", pid);
      if (!processEntrypointMatches(authenticated, expectedEntrypoint, platform, procRoot, realpath)) {
        return legacyRefusal("response-invalid", "legacy daemon entrypoint did not match the requested runtime", pid);
      }
      if (!isLikelyLcmDaemonProcessForPlatform(pid, platform, dependencies.spawnSync, procRoot, windowsPowerShellPath)) {
        return legacyRefusal("invalid-collision", "legacy daemon process command was not an LCM daemon", pid);
      }
      const listenerPorts = opts._listeningPortsOverride
        ? opts._listeningPortsOverride(pid)
        : findListeningTcpPorts(pid, platform, dependencies.spawnSync, procRoot, opts.port);
      if (!listenerPorts.includes(opts.port)) return legacyRefusal("invalid-collision", "legacy daemon did not own the configured loopback listener", pid);
      if (opts._abortSignal?.aborted) return legacyRefusal("response-timeout", "legacy daemon migration was interrupted", pid);
      if (!remainingVerificationDeadline()) return legacyRefusal("response-timeout", "legacy daemon migration deadline expired", pid);
      const preStopPid = readLegacyPidFileEvidence(opts.pidFilePath);
      if (preStopPid.kind !== "present" || !sameLegacyPidFileIdentity(firstPid, preStopPid) || preStopPid.pid !== pid || !isAlive(pid)) {
        return legacyRefusal("ambiguous", "legacy daemon PID evidence changed before exact stop", pid);
      }
      const preStopDiscovery = await discover();
      if (preStopDiscovery.kind === "refused") return { ...preStopDiscovery, refusalReason: "ambiguous", pid };
      if (
        preStopDiscovery.candidates.length !== 1
        || preStopDiscovery.candidates[0]!.name !== candidate.name
        || preStopDiscovery.candidates[0]!.managerPid !== candidate.managerPid
        || preStopDiscovery.candidates[0]!.invocationId !== candidate.invocationId
      ) {
        return legacyRefusal("ambiguous", "legacy daemon candidate changed before exact stop", pid);
      }
      try {
        await supervisor.stopLegacySystemdUnit(candidate, { deadline: verificationDeadline });
      } catch {
        return legacyRefusal("startup-failure", "legacy daemon exact stop failed; stable replacement was not started", pid);
      }
      if (isAlive(pid)) return legacyRefusal("startup-failure", "legacy daemon remained live after exact stop; stable replacement was not started", pid);
      const afterStopPid = readLegacyPidFileEvidence(opts.pidFilePath);
      if (afterStopPid.kind === "unsafe") return legacyRefusal("ambiguous", "legacy daemon PID evidence became unsafe after exact stop", pid);
      if (afterStopPid.kind === "present") {
        return legacyRefusal("ambiguous", "legacy daemon PID path remained after exact stop; stable replacement was not started", pid);
      }
      return { kind: "migrated", stoppedPid: pid };
    };
    if (observation.kind === "registered-stale-config") {
      // Explicit restart is the sole operation authorized to replace stale
      // manager configuration.  Require the old registration to carry the
      // exact stable scope identity before mutating it; ensure/doctor remain
      // read-only refusal paths for the same observation.
      if (observation.scopeDigest !== spec.scopeDigest || observation.name !== spec.name) {
        return restartRefusal("invalid-collision", "managed daemon supervisor stale registration did not match the requested scope; refusing restart");
      }
      try {
        return await stopStartAndEnsure();
      } catch {
        return restartRefusal("startup-failure", "managed daemon supervisor stale configuration repair failed");
      }
    }
    if (observation.kind === "absent") {
      const legacyMigration = await migrateAuthenticatedLegacyDaemon();
      if (legacyMigration.kind === "refused") {
        return restartRefusal(
          legacyMigration.refusalReason,
          legacyMigration.warning,
          legacyMigration.pid === undefined ? {} : { pid: legacyMigration.pid },
        );
      }
      if (legacyMigration.kind === "migrated") {
        try {
          return await startStableAndEnsure(legacyMigration.stoppedPid);
        } catch {
          return restartRefusal(
            "startup-failure",
            "stable daemon start failed after authenticated legacy migration",
            { stoppedPid: legacyMigration.stoppedPid },
          );
        }
      }
    }
    if (observation.kind === "absent" || observation.kind === "registered-not-running-valid") {
      if (!exactNoLivePidProof()) {
        return restartRefusal(
          "not-running",
          "managed daemon is not running but its PID state is live; refusing replacement",
        );
      }
      cleanOwnedPid();
      if (opts._skipSpawn) return restartRefusal(
        observation.kind === "absent" ? "absent" : "not-running",
        "managed daemon is not running; explicit start is required",
      );
      return ensureAfterManagerOperation();
    }

    const managerPid = observation.managerPid;
    const localManagerEndpoint = (): boolean => {
      if (managerPid === undefined || readOwnedPid() !== managerPid || !isAlive(managerPid)) return false;
      const listenerPorts = opts._listeningPortsOverride
        ? opts._listeningPortsOverride(managerPid)
        : findListeningTcpPorts(managerPid, platform, dependencies.spawnSync, procRoot, opts.port);
      return listenerPorts.includes(opts.port);
    };
    const secondProbeMatches = async (): Promise<boolean> => {
      let second: SupervisorObservation;
      try {
        second = await supervisor.probe(spec, { deadline: verificationDeadline });
      } catch {
        return false;
      }
      return second.kind === "registered-running-valid"
        && second.scopeDigest === spec.scopeDigest
        && second.nonce === (observation.nonce ?? spec.nonce)
        && second.name === spec.name
        && second.managerPid === managerPid;
    };
    const healthDeadline = remainingVerificationDeadline();
    if (!healthDeadline) return restartRefusal("response-timeout", "daemon restart verification deadline expired");
    const healthObservation = await observeDaemonHealth(opts.port, fetchFn, healthDeadline);
    if (healthObservation.kind === "no-response") {
      // Explicit restart is the one operation allowed to recover a live job
      // with no HTTP response, but only with the manager PID/listener proof.
      if (!localManagerEndpoint() || !(await secondProbeMatches())) {
        return restartRefusal("live-no-response", "managed daemon gave no HTTP response but manager/PID identity was not revalidated", { pid: managerPid });
      }
    } else if (healthObservation.body !== "valid" || healthObservation.parsedBody === undefined) {
      return restartRefusal(
        healthObservation.body === "timeout" ? "response-timeout" : "response-invalid",
        "managed daemon returned an invalid health response; refusing restart",
        { pid: managerPid },
      );
    } else {
      const health = healthObservation.parsedBody;
      if (!isRecognizedDaemonHealth(health) || health.pid !== managerPid || !localManagerEndpoint()) {
        return restartRefusal("invalid-collision", "managed daemon endpoint identity did not match its supervisor job; refusing restart", { pid: managerPid });
      }
      const storage = recognizedHealthStorageBackend(health);
      if (storage === null) return restartRefusal("response-invalid", "managed daemon reported an unknown storage backend", { pid: managerPid });
      const authenticated = await checkDaemonDiagnostics(
        opts.port,
        tokenPath,
        fetchFn,
        remainingVerificationDeadline,
        health,
        storage,
        readOwnedToken,
      );
      if (authenticated === null) return restartRefusal("response-auth-failure", "managed daemon health could not be authenticated; refusing restart", { pid: managerPid });
      if (!processEntrypointMatches(authenticated, expectedEntrypoint, platform, procRoot, realpath)
        || !healthRuntimeDigestMatches(authenticated, opts.expectedRuntimeDigest)) {
        return restartRefusal("response-invalid", "managed daemon identity did not match the requested runtime; refusing restart", { pid: managerPid });
      }
      // An authenticated, responsive version mismatch is an explicit manager
      // repair case.  It must never fall through to bare-PID signaling or
      // detached spawn; the exact scoped registration is stopped and
      // recreated below after the final identity re-probe.
      if (!(await secondProbeMatches())) return restartRefusal("ambiguous", "managed daemon supervisor identity changed before restart", { pid: managerPid });
    }

    try {
      return await stopStartAndEnsure();
    } catch {
      return restartRefusal("startup-failure", "managed daemon supervisor stop/start failed", { pid: managerPid });
    }
  }

  if (managerKind !== undefined) {
    const managedResult = await runManagedRestart(managerKind);
    if (managedResult !== null) return managedResult;
  }

  async function isManaged(pid: number): Promise<boolean> {
    if (_isManagedProcessOverride) return _isManagedProcessOverride(pid);
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
    if (!await isAuthenticatedDaemonAtPort(opts.port, pid)) return false;
    return isLikelyLcmDaemonProcessForPlatform(
      pid,
      platform,
      dependencies.spawnSync,
      procRoot,
      windowsPowerShellPath,
    );
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
    if (opts._abortSignal?.aborted) {
      return {
        connected: false,
        port: opts.port,
        spawned: false,
        restarted: false,
        warning: "daemon lifecycle was interrupted before startup",
      };
    }
    // Revalidate platform-native command identity immediately before the
    // signal.  Darwin has no procfs fallback: an unavailable or changed ps
    // observation preserves the PID file and refuses the offline repair.
    if (_isManagedProcessOverride === undefined) {
      if (
        readOwnedPid() !== pid
        || !isAlive(pid)
        || !isLikelyLcmDaemonProcessForPlatform(
          pid,
          platform,
          dependencies.spawnSync,
          procRoot,
          windowsPowerShellPath,
        )
        || !(await isManaged(pid))
      ) {
        throw new Error(`Refusing to restart: PID ${pid} identity changed before signaling.`);
      }
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
  const result = await ensure(ensureOptionsWithEntrypoint);
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
  managerTransportEnvironment,
  supervisorCommandRunner,
  runCleanupStages,
  sleep,
};
