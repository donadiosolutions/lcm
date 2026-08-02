import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { platform as osPlatform } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";
import { ensureAuthToken, readAuthToken } from "./auth.js";
import { managedDaemonPath, SYSTEMD_DAEMON_PATH } from "./managed-path.js";
import { PACKAGED_RUNTIME_ENTRYPOINT, PKG_VERSION, RUNTIME_DIGEST } from "./version.js";
import type { StorageBackend } from "./config.js";
import {
  isStagedPostgreSqlHealth,
  STAGED_POSTGRESQL_ERROR_CODE,
} from "./staged-postgresql.js";
import {
  DAEMON_TEST_ENTRYPOINT_OPTION,
  DAEMON_TEST_OWNER_OPTION,
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

// The explicit-restart terminal verifier runs after the last injectable
// lifecycle boundary. Capture every native capability it needs while this
// module is initialized so syncBuiltinESMExports() or prototype replacement at
// that boundary cannot redirect a terminal proof or recovery-authority write.
const terminalOpenSync = openSync;
const terminalCloseSync = closeSync;
const terminalFstatSync = fstatSync;
const terminalFsyncSync = fsyncSync;
const terminalFchmodSync = fchmodSync;
const terminalReadSync = readSync;
const terminalWriteSync = writeSync;
const terminalLstatSync = lstatSync;
const terminalRealpathSync = realpathSync;
const terminalReaddirSync = readdirSync;
const terminalReadlinkSync = readlinkSync;
const terminalBufferAlloc = Buffer.alloc;
const terminalBufferFrom = Buffer.from;
const terminalReflectApply = Reflect.apply;
const terminalCreateHash = createHash;
const terminalHashSample = terminalCreateHash("sha256");
const terminalHashUpdate = terminalHashSample.update;
const terminalHashDigest = terminalHashSample.digest;
const TerminalInt32Array = Int32Array;
const terminalAbortAdd = EventTarget.prototype.addEventListener;
const terminalAbortRemove = EventTarget.prototype.removeEventListener;
const TERMINAL_O_RDONLY = constants.O_RDONLY;
const TERMINAL_O_WRONLY = constants.O_WRONLY;
const TERMINAL_O_CREAT = constants.O_CREAT;
const TERMINAL_O_EXCL = constants.O_EXCL;
const TERMINAL_O_NOFOLLOW = constants.O_NOFOLLOW;
const TERMINAL_O_NONBLOCK = constants.O_NONBLOCK;
const TERMINAL_O_DIRECTORY = constants.O_DIRECTORY;
const TERMINAL_S_IFMT = constants.S_IFMT;
const TERMINAL_S_IFREG = constants.S_IFREG;
const TERMINAL_S_IFDIR = constants.S_IFDIR;

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

type PublicHealthOutcome =
  | { kind: "no-response" }
  | { kind: "response"; health: HealthResponse | null };

type OfflineStateFileProof = Readonly<{
  path: string;
  device: number;
  inode: number;
  mode: number;
  uid: number;
  links: number;
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
  content?: string;
}>;

type OfflineContentStateFileProof = OfflineStateFileProof & Readonly<{
  content: string;
}>;

type OfflineStateDirectoryProof = Readonly<{
  path: string;
  device: number;
  inode: number;
  mode: number;
  uid: number;
  links: number;
}>;

type OfflineRestartFingerprint = Readonly<{
  pid: number;
  uid: number;
  processStartTime: string;
  execPath: string;
  executable: string;
  argv: readonly string[];
  launchPath: string;
  entrypoint: string;
  entrypointDigest: string;
  stateDirectory: OfflineStateDirectoryProof;
  pidFile: OfflineContentStateFileProof;
  tokenFile: OfflineStateFileProof;
  listenerPort: number;
  ownerId: string | null;
}>;

/**
 * Signal authorization also binds the exact listener socket set observed for
 * the original process. This proof deliberately remains operation-local: the
 * durable recovery record format stays stable, while every resumed explicit
 * restart captures a fresh baseline before any signal can be delivered.
 */
type OfflineRestartSignalProof = Readonly<{
  fingerprint: OfflineRestartFingerprint;
  listenerSocketInodes: readonly string[];
}>;

const OFFLINE_RECOVERY_RECORD_BASENAME = ".daemon.pid.restart-recovery.json";
const OFFLINE_RECOVERY_QUARANTINE_BASENAME = ".daemon.pid.restart-quarantine";
const OFFLINE_RECOVERY_RECORD_VERSION = 1 as const;
const MAX_OFFLINE_RECOVERY_RECORD_BYTES = 64 * 1024;
const MAX_OFFLINE_PID_BYTES = 64;
const MAX_OFFLINE_TOKEN_BYTES = 4 * 1024;
const MAX_OFFLINE_PROC_STAT_BYTES = 16 * 1024;
const MAX_OFFLINE_PROC_TEXT_BYTES = 64 * 1024;

type OfflineRecoveryRecord = Readonly<{
  version: typeof OFFLINE_RECOVERY_RECORD_VERSION;
  kind: "lcm-offline-restart";
  pidFilePath: string;
  tokenFilePath: string;
  quarantinePath: string;
  fingerprint: OfflineRestartFingerprint;
}>;

type OfflineRecoveryRecordRead =
  | { kind: "absent" }
  | { kind: "invalid"; proof?: OfflineContentStateFileProof }
  | {
    kind: "valid";
    record: OfflineRecoveryRecord;
    proof: OfflineContentStateFileProof;
    bytes: string;
  };

type OfflineRecoveryCreationResult =
  | { kind: "valid"; record: OfflineRecoveryRecordRead & { kind: "valid" } }
  | { kind: "invalid" }
  | { kind: "interrupted" };

type OfflineQuarantineEvidence =
  | { kind: "absent" }
  | { kind: "record-backup"; record: OfflineRecoveryRecordRead & { kind: "valid" } }
  | { kind: "original-pid"; proof: OfflineContentStateFileProof };

type OfflineReplacementStartupQuarantine = Exclude<
  OfflineQuarantineEvidence,
  { kind: "record-backup" }
>;

type OfflineAuthorizedCandidateProof = Readonly<{
  recoveryProof: OfflineStateFileProof;
  recoveryBytes: string;
  quarantine: OfflineQuarantineEvidence;
  fingerprint: OfflineRestartFingerprint;
}>;

type OfflineDirectDirectoryProof = Readonly<{
  path: string;
  device: number;
  inode: number;
  mode: number;
  uid: number;
}>;

type OfflineDirectParentProof = Readonly<{
  pid: number;
  processStartTime: string;
  processDirectory: OfflineDirectDirectoryProof;
  argv: readonly string[];
  executable: string;
}>;

type OfflineDirectCandidateProof = Readonly<{
  processDirectory: OfflineDirectDirectoryProof;
  parent: OfflineDirectParentProof;
  listenerSocketInodes: readonly string[];
}>;

type OfflineTerminalRootProof =
  | Readonly<{
    procRoot: OfflineDirectDirectoryProof;
    scopeDirectories: readonly [];
    scopeHomePath: null;
    scopeOwnerId: null;
    entrypointProofs: readonly [];
  }>
  | Readonly<{
    procRoot: OfflineDirectDirectoryProof;
    scopeDirectories: readonly OfflineDirectDirectoryProof[];
    scopeHomePath: string;
    scopeOwnerId: string | null;
    entrypointProofs: readonly [OfflineStateFileProof];
  }>;

type OfflineRecoveryAuthorizedCandidateProof = Readonly<{
  evidence: OfflineAuthorizedCandidateProof;
  direct: OfflineDirectCandidateProof;
}>;

type OfflineRecoveryEnsureAuthorization = Readonly<{
  recordProof: OfflineStateFileProof;
  quarantineProof: OfflineStateFileProof | null;
  stateDirectory: OfflineStateDirectoryProof;
  stoppedFingerprint: OfflineRestartFingerprint;
  abortSignal?: AbortSignal;
  validateStopped: () => boolean;
  captureCandidate: (pid: number) => OfflineRecoveryAuthorizedCandidateProof | null;
  candidateMatches: (
    left: OfflineRecoveryAuthorizedCandidateProof,
    right: OfflineRecoveryAuthorizedCandidateProof,
  ) => boolean;
  readCandidateToken: (
    path: string,
    candidate: OfflineRecoveryAuthorizedCandidateProof,
  ) => string | null;
  runBoundary: (boundary: string) => void;
}>;

type NormalizedWarningAuthority = Readonly<{
  kind: "warning";
  recordPath: string;
  quarantinePath: string;
  replacementFingerprint: OfflineRestartFingerprint;
  backup: OfflineRecoveryRecordRead & { kind: "valid" };
  warning: string;
}>;

type OfflineRecoveryFinalAuthority =
  | Readonly<{
    kind: "clean";
    recordPath: string;
    quarantinePath: string;
    recoveryBytes: string;
    originalFingerprint: OfflineRestartFingerprint;
    replacementFingerprint: OfflineRestartFingerprint;
    recordUnlink: "durable";
    quarantineUnlink: "durable";
  }>
  | NormalizedWarningAuthority;

type HeldOfflineUnlinkResult =
  | { kind: "durable" }
  | { kind: "unlinked-uncommitted"; reason: string }
  | { kind: "unlinked-undurable"; reason: string }
  | { kind: "refused"; reason: string };

type OfflinePidQuarantineTransitionResult =
  | { kind: "completed"; proof: OfflineContentStateFileProof }
  | { kind: "interrupted"; reason: string }
  | { kind: "refused"; reason: string };

const offlineRecoveryEnsureAuthorizations = new WeakMap<
  object,
  OfflineRecoveryEnsureAuthorization
>();

type LinuxProcessBirthState =
  | { kind: "exact"; startTime: string }
  | { kind: "reused"; startTime: string }
  | { kind: "gone" }
  | { kind: "unreadable" };

type OfflineStopResult =
  | { kind: "stopped" }
  | { kind: "interrupted" }
  | { kind: "refused"; reason: string };

type OfflineStatePreparationResult =
  | { kind: "prepared"; quarantineProof?: OfflineContentStateFileProof }
  | { kind: "interrupted"; reason?: string }
  | { kind: "refused"; reason: string };

type StoppedOfflineTrustFenceResult =
  | { kind: "trusted" }
  | { kind: "interrupted" }
  | { kind: "refused"; reason: string };

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
  /** @internal Deterministic trusted Windows PowerShell seam for lifecycle tests. */
  _windowsPowerShellPathOverride?: string | null;
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
  /** @internal Deterministic final offline PID quarantine seam for lifecycle tests. */
  _offlinePidRenameOverride?: typeof renameSync;
  /** @internal Deterministic pre-unlink PID-quarantine seam for lifecycle tests. */
  _offlinePidUnlinkOverride?: typeof unlinkSync;
  /** @internal Deterministic pre-unlink recovery-backup seam for lifecycle tests. */
  _offlineRecoveryBackupUnlinkOverride?: typeof unlinkSync;
  /** @internal Deterministic post-absence scope-race seam for lifecycle tests. */
  _offlinePreAbsentFenceOverride?: () => void;
  /** @internal Deterministic final trust-fence race seam for lifecycle tests. */
  _offlineTrustFenceFinalizeOverride?: () => void;
  /** @internal Deterministic recovery-record open seam for lifecycle tests. */
  _offlineRecordOpenOverride?: (path: string, flags: number, mode?: number) => number;
  /** @internal Deterministic recovery durability seam for lifecycle tests. */
  _offlineFsyncOverride?: (descriptor: number) => void;
  /** @internal Deterministic recovery-record write seam for lifecycle tests. */
  _offlineRecordWriteOverride?: (descriptor: number, bytes: Uint8Array) => number;
  /** @internal Deterministic pre-unlink recovery-record seam for lifecycle tests. */
  _offlineRecordUnlinkOverride?: (path: string) => void;
  /** @internal Deterministic recovery crash-boundary seam for lifecycle tests. */
  _offlineRecoveryBoundaryOverride?: (boundary: string) => void;
  /** @internal Deterministic recovery finalization seam for lifecycle tests. */
  _offlineRecoveryFinalizeOverride?: () => void;
  /** @internal Scoped global-listener proof seam for lifecycle tests. */
  _offlineScopedListenerStateOverride?: () => "absent" | "listening" | "unavailable";
  /** @internal Alternate proc-self-fd root for anchored-unlink refusal tests. */
  _offlineProcSelfFdRootOverride?: string;
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

type TerminalByteSequence = Readonly<{
  bytes: Buffer;
  length: number;
}>;

type TerminalDirectoryProof = Readonly<{
  path: string;
  device: number;
  inode: number;
  mode: number;
  uid: number;
  links: number | null;
}>;

type TerminalFileProof = Readonly<{
  path: string;
  device: number;
  inode: number;
  mode: number;
  uid: number;
  links: number;
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
}>;

type TerminalProcessPaths = Readonly<{
  directory: string;
  stat: string;
  status: string;
  cmdline: string;
  executable: string;
  fd: string;
}>;

type TerminalRecoveryAuthoritySeed = Readonly<{
  uid: number;
  recordPath: string;
  quarantinePath: string;
  recoveryBytes: TerminalByteSequence;
  stateDirectory: TerminalDirectoryProof;
  procRoot: TerminalDirectoryProof;
  scopeDirectories: readonly TerminalDirectoryProof[];
  scopeEntrypoints: readonly Readonly<{
    proof: TerminalFileProof;
    content: TerminalByteSequence;
  }>[];
  scopeOwnerId: string | null;
  originalDirectory: string;
  originalPid: number;
  replacementPid: number;
  replacementStartTime: TerminalByteSequence;
  replacementProcess: TerminalProcessPaths;
  replacementDirectoryProof: TerminalDirectoryProof;
  replacementFdDirectoryProof: TerminalDirectoryProof;
  replacementCmdline: TerminalByteSequence;
  replacementCmdlineProof: TerminalFileProof;
  replacementExecutable: string;
  replacementExecPath: string;
  replacementLaunchPath: string;
  replacementEntrypoint: string;
  replacementEntrypointProof: TerminalFileProof;
  replacementEntrypointContent: TerminalByteSequence;
  replacementEntrypointDigest: string;
  replacementStateDirectory: TerminalDirectoryProof;
  replacementPidFile: TerminalFileProof;
  replacementPidBytes: TerminalByteSequence;
  replacementTokenFile: TerminalFileProof;
  parentPid: number;
  parentStartTime: TerminalByteSequence;
  parentProcess: TerminalProcessPaths;
  parentDirectoryProof: TerminalDirectoryProof;
  parentCmdline: TerminalByteSequence;
  parentCmdlineProof: TerminalFileProof;
  parentExecutable: string;
  parentLaunchPath: string;
  tcpPath: string;
  tcp6Path: string;
  listenerPortHex: TerminalByteSequence;
  uidDecimal: TerminalByteSequence;
  parentPidDecimal: TerminalByteSequence;
  listenerInodes: readonly TerminalByteSequence[];
  listenerTargets: readonly string[];
  listenerMask: number;
  rawClientExecPath: string;
  rawClientLaunchPath: string;
  canonicalClientExecutable: string;
  canonicalClientEntrypoint: string;
} & (
  | { expectedAuthority: "clean"; expectedBackupProof: null }
  | { expectedAuthority: "backup"; expectedBackupProof: TerminalFileProof }
)>;

type TerminalFailureResults = Readonly<{
  abortRecord: RestartDaemonResult;
  abortBackup: RestartDaemonResult;
  abortIndeterminate: RestartDaemonResult;
  boundaryRecord: RestartDaemonResult;
  boundaryBackup: RestartDaemonResult;
  boundaryIndeterminate: RestartDaemonResult;
  proofRecord: RestartDaemonResult;
  proofBackup: RestartDaemonResult;
  proofIndeterminate: RestartDaemonResult;
}>;

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
      if ((fstatSync(existing).mode & 0o7777) !== 0o600) {
        fchmodSync(existing, 0o600);
      }
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
          if (columns.length < 10 || columns[3] !== "0A") continue;
          if (!socketInodes.has(columns[9])) continue;
          // Requests are sent specifically to 127.0.0.1. A socket on another
          // loopback address does not prove ownership of that endpoint.
          const [addressHex, portHex] = columns[1]!.split(":");
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

type LinuxLoopbackListenerState = "absent" | "listening" | "unavailable";

function linuxLoopbackListenerState(
  procRoot: string,
  targetPort: number,
): LinuxLoopbackListenerState {
  for (const table of ["tcp", "tcp6"] as const) {
    let rows: string;
    try {
      rows = readFileSync(join(procRoot, "net", table), "utf8");
    } catch {
      return "unavailable";
    }
    const lines = rows.split(/\r?\n/);
    if (!lines[0]!.includes("local_address")) return "unavailable";
    for (const row of lines.slice(1)) {
      if (row.trim().length === 0) continue;
      const columns = row.trim().split(/\s+/);
      if (columns.length < 4) return "unavailable";
      if (columns[3] !== "0A") continue;
      const local = /^([A-Fa-f0-9]+):([A-Fa-f0-9]{4})$/.exec(columns[1]!);
      if (!local) return "unavailable";
      const port = Number.parseInt(local[2]!, 16);
      if (port !== targetPort) continue;
      const address = local[1]!.toUpperCase();
      const acceptsIpv4Loopback = table === "tcp"
        ? address === "0100007F" || address === "00000000"
        : /^0+$/.test(address) || address.endsWith("0100007F");
      if (acceptsIpv4Loopback) return "listening";
    }
  }
  return "absent";
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

function readOfflineStateFileProof(
  path: string,
  expectedUid: number,
  options: {
    readContent: true;
    requirePrivate: boolean;
    expectedLinks?: number;
    maxBytes?: number;
  },
): OfflineContentStateFileProof | null;
function readOfflineStateFileProof(
  path: string,
  expectedUid: number,
  options: {
    readContent: false;
    requirePrivate: boolean;
    expectedLinks?: number;
    maxBytes?: number;
  },
): OfflineStateFileProof | null;
function readOfflineStateFileProof(
  path: string,
  expectedUid: number,
  options: {
    readContent: boolean;
    requirePrivate: boolean;
    expectedLinks?: number;
    maxBytes?: number;
  },
): OfflineStateFileProof | OfflineContentStateFileProof | null {
  const maximumBytes = options.maxBytes
    ?? (options.readContent ? MAX_OFFLINE_RECOVERY_RECORD_BYTES : Number.MAX_SAFE_INTEGER);
  const read = readStableBoundedDescriptor(path, maximumBytes, false, options.readContent);
  if (read.kind !== "valid") return null;
  const { before, after } = read;
  const permissions = before.mode & 0o777;
  if (
    !before.isFile()
    || before.nlink !== (options.expectedLinks ?? 1)
    || before.uid !== expectedUid
    || (options.requirePrivate
      ? (permissions & 0o077) !== 0
      : (permissions & 0o022) !== 0)
    || !stableDescriptorMetadataMatches(before, after)
    || (options.readContent && read.content.byteLength !== before.size)
  ) {
    return null;
  }
  const content = options.readContent ? read.content.toString("utf8") : undefined;
  return Object.freeze({
    path,
    device: before.dev,
    inode: before.ino,
    mode: before.mode,
    uid: before.uid,
    links: before.nlink,
    size: before.size,
    modifiedAtMs: before.mtimeMs,
    changedAtMs: before.ctimeMs,
    ...(content === undefined ? {} : { content }),
  });
}

type StableDescriptorStats = Stats;

type StableBoundedDescriptorRead =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | {
    kind: "valid";
    before: StableDescriptorStats;
    after: StableDescriptorStats;
    content: Buffer;
  };

type StableBoundedOpenDescriptorRead = Exclude<
  StableBoundedDescriptorRead,
  { kind: "absent" }
>;

function stableDescriptorMetadataMatches(
  before: StableDescriptorStats,
  after: StableDescriptorStats,
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.uid === after.uid
    && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function readStableBoundedDescriptor(
  path: string,
  maximumBytes: number,
  allowVirtualSize: boolean,
  readContent = true,
): StableBoundedDescriptorRead {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    return { kind: "unreadable" };
  }
  let descriptor: number | undefined;
  let result: StableBoundedDescriptorRead = { kind: "unreadable" };
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    result = readStableBoundedOpenDescriptor(
      descriptor,
      maximumBytes,
      allowVirtualSize,
      readContent,
    );
  } catch (error) {
    result = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable" };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        result = { kind: "unreadable" };
      }
    }
  }
  return result;
}

function readStableBoundedOpenDescriptor(
  descriptor: number,
  maximumBytes: number,
  allowVirtualSize: boolean,
  readContent = true,
): StableBoundedOpenDescriptorRead {
  try {
    const before = fstatSync(descriptor) as Stats;
    if (
      !before.isFile()
      || !Number.isSafeInteger(before.size)
      || before.size < 0
      || (!allowVirtualSize && before.size > maximumBytes)
    ) {
      return { kind: "unreadable" };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (readContent && total <= maximumBytes) {
      const remaining = maximumBytes + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(8192, remaining));
      const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const after = fstatSync(descriptor) as Stats;
    if (total > maximumBytes || !stableDescriptorMetadataMatches(before, after)) {
      return { kind: "unreadable" };
    }
    return {
      kind: "valid",
      before,
      after,
      content: Buffer.concat(chunks, total),
    };
  } catch {
    return { kind: "unreadable" };
  }
}

function readOfflineStateDirectoryProof(
  path: string,
  expectedUid: number,
): OfflineStateDirectoryProof | null {
  let descriptor: number | undefined;
  let proof: OfflineStateDirectoryProof | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const stats = fstatSync(descriptor);
    const permissions = stats.mode & 0o777;
    if (
      !stats.isDirectory()
      || stats.uid !== expectedUid
      || (permissions & 0o022) !== 0
    ) {
      return null;
    }
    proof = Object.freeze({
      path,
      device: stats.dev,
      inode: stats.ino,
      mode: stats.mode,
      uid: stats.uid,
      links: stats.nlink,
    });
  } catch {
    proof = null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        proof = null;
      }
    }
  }
  return proof;
}

function readOfflineDirectDirectoryProof(path: string): OfflineDirectDirectoryProof | null {
  let descriptor: number | undefined;
  let proof: OfflineDirectDirectoryProof | null = null;
  try {
    if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) return null;
    descriptor = openSync(
      path,
      constants.O_RDONLY
        | constants.O_DIRECTORY
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      !before.isDirectory()
      || !after.isDirectory()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.mode !== after.mode
      || before.uid !== after.uid
    ) {
      return null;
    }
    proof = Object.freeze({
      path,
      device: before.dev,
      inode: before.ino,
      mode: before.mode,
      uid: before.uid,
    });
  } catch {
    proof = null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        proof = null;
      }
    }
  }
  return proof;
}

function offlineDirectDirectoryProofMatches(
  expected: OfflineDirectDirectoryProof,
  current: OfflineDirectDirectoryProof | null | undefined,
): current is OfflineDirectDirectoryProof {
  if (!current) return false;
  return current.path === expected.path
    && current.device === expected.device
    && current.inode === expected.inode
    && current.mode === expected.mode
    && current.uid === expected.uid;
}

function offlineDirectDirectoryIsOwned(
  proof: OfflineDirectDirectoryProof | null,
  expectedUid: number,
): proof is OfflineDirectDirectoryProof {
  return proof !== null
    && proof.uid === expectedUid
    && (proof.mode & 0o022) === 0;
}

function offlineDirectPathIsWithin(child: string, parent: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent.length > 0
    && pathFromParent !== ".."
    && !pathFromParent.startsWith(`..${posix.sep}`)
    && !isAbsolute(pathFromParent);
}

function offlineDirectDirectoryProofsMatch(
  left: readonly OfflineDirectDirectoryProof[],
  right: readonly OfflineDirectDirectoryProof[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftProof = left[index];
    const rightProof = right[index];
    if (leftProof === undefined || !offlineDirectDirectoryProofMatches(leftProof, rightProof)) {
      return false;
    }
  }
  return true;
}

function offlineStateFileProofCollectionsMatch(
  left: readonly OfflineStateFileProof[],
  right: readonly OfflineStateFileProof[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftProof = left[index];
    const rightProof = right[index];
    if (
      leftProof === undefined
      || rightProof === undefined
      || !offlineStateFileProofMatches(leftProof, rightProof)
    ) {
      return false;
    }
  }
  return true;
}

function offlineStringSequencesMatch(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function offlineStateFileMetadataMatches(
  left: OfflineStateFileProof,
  right: OfflineStateFileProof,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.uid === right.uid
    && left.links === right.links
    && left.size === right.size
    && left.modifiedAtMs === right.modifiedAtMs
    && left.changedAtMs === right.changedAtMs;
}

function offlineStateFileProofMatches(
  left: OfflineStateFileProof,
  right: OfflineStateFileProof,
): boolean {
  return left.path === right.path
    && offlineStateFileMetadataMatches(left, right)
    && left.content === right.content;
}

function readTokenBoundToOfflineProof(
  path: string,
  expected: OfflineStateFileProof,
): string | null {
  const current = readOfflineStateFileProof(path, expected.uid, {
    readContent: true,
    requirePrivate: true,
    maxBytes: MAX_OFFLINE_TOKEN_BYTES,
  });
  if (
    current === null
    || current.content === undefined
    || !offlineStateFileMetadataMatches(expected, current)
  ) {
    return null;
  }
  const token = current.content.trim();
  return token.length > 0 ? token : null;
}

function offlineStateFileProofSurvivedRename(
  beforeRename: OfflineStateFileProof,
  afterRename: OfflineStateFileProof,
): boolean {
  return beforeRename.device === afterRename.device
    && beforeRename.inode === afterRename.inode
    && beforeRename.mode === afterRename.mode
    && beforeRename.uid === afterRename.uid
    && beforeRename.links === afterRename.links
    && beforeRename.size === afterRename.size
    && beforeRename.modifiedAtMs === afterRename.modifiedAtMs
    && afterRename.changedAtMs >= beforeRename.changedAtMs
    && beforeRename.content === afterRename.content;
}

function offlineStateFileProofIsLinkedQuarantineTransition(
  original: OfflineContentStateFileProof,
  canonical: OfflineContentStateFileProof,
  quarantine: OfflineContentStateFileProof,
): boolean {
  return original.links === 1
    && canonical.links === 2
    && quarantine.links === 2
    && canonical.path === original.path
    && canonical.device === original.device
    && canonical.inode === original.inode
    && canonical.mode === original.mode
    && canonical.uid === original.uid
    && canonical.size === original.size
    && canonical.modifiedAtMs === original.modifiedAtMs
    && canonical.changedAtMs >= original.changedAtMs
    && canonical.content === original.content
    && quarantine.path !== canonical.path
    && quarantine.device === canonical.device
    && quarantine.inode === canonical.inode
    && quarantine.mode === canonical.mode
    && quarantine.uid === canonical.uid
    && quarantine.size === canonical.size
    && quarantine.modifiedAtMs === canonical.modifiedAtMs
    && quarantine.changedAtMs === canonical.changedAtMs
    && quarantine.content === canonical.content;
}

function offlineStateDirectoryProofMatches(
  left: OfflineStateDirectoryProof,
  right: OfflineStateDirectoryProof,
): boolean {
  return left.path === right.path
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.uid === right.uid
    && left.links === right.links;
}

function offlineRecoveryPaths(pidFilePath: string): Readonly<{
  recordPath: string;
  quarantinePath: string;
}> {
  const parent = dirname(pidFilePath);
  return {
    recordPath: join(parent, OFFLINE_RECOVERY_RECORD_BASENAME),
    quarantinePath: join(parent, OFFLINE_RECOVERY_QUARANTINE_BASENAME),
  };
}

function offlineRecoveryLeafIsPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key: string, index: number): boolean => key === expected[index]);
}

function isFiniteProofNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeProofInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOfflineStateDirectoryProof(value: unknown): value is OfflineStateDirectoryProof {
  if (typeof value !== "object" || value === null) return false;
  const proof = value as Record<string, unknown>;
  return hasExactKeys(proof, ["path", "device", "inode", "mode", "uid", "links"])
    && typeof proof.path === "string"
    && isAbsolute(proof.path)
    && [proof.device, proof.inode, proof.mode, proof.uid, proof.links].every(isSafeProofInteger);
}

function isOfflineStateFileProof(
  value: unknown,
  content: "required",
): value is OfflineContentStateFileProof;
function isOfflineStateFileProof(
  value: unknown,
  content: "forbidden",
): value is OfflineStateFileProof;
function isOfflineStateFileProof(
  value: unknown,
  content: "required" | "forbidden",
): value is OfflineStateFileProof {
  if (typeof value !== "object" || value === null) return false;
  const proof = value as Record<string, unknown>;
  const keys = [
    "path",
    "device",
    "inode",
    "mode",
    "uid",
    "links",
    "size",
    "modifiedAtMs",
    "changedAtMs",
    ...(content === "required" ? ["content"] : []),
  ];
  return hasExactKeys(proof, keys)
    && typeof proof.path === "string"
    && isAbsolute(proof.path)
    && [
      proof.device,
      proof.inode,
      proof.mode,
      proof.uid,
      proof.links,
      proof.size,
    ].every(isSafeProofInteger)
    && [proof.modifiedAtMs, proof.changedAtMs].every(isFiniteProofNumber)
    && (content === "required"
      ? typeof proof.content === "string"
      : proof.content === undefined);
}

function isOfflineRestartFingerprint(value: unknown): value is OfflineRestartFingerprint {
  if (typeof value !== "object" || value === null) return false;
  const fingerprint = value as Record<string, unknown>;
  return hasExactKeys(fingerprint, [
    "pid",
    "uid",
    "processStartTime",
    "execPath",
    "executable",
    "argv",
    "launchPath",
    "entrypoint",
    "entrypointDigest",
    "stateDirectory",
    "pidFile",
    "tokenFile",
    "listenerPort",
    "ownerId",
  ])
    && Number.isSafeInteger(fingerprint.pid)
    && (fingerprint.pid as number) > 0
    && Number.isSafeInteger(fingerprint.uid)
    && (fingerprint.uid as number) >= 0
    && typeof fingerprint.processStartTime === "string"
    && /^[1-9]\d*$/u.test(fingerprint.processStartTime)
    && typeof fingerprint.execPath === "string"
    && isAbsolute(fingerprint.execPath)
    && typeof fingerprint.executable === "string"
    && isAbsolute(fingerprint.executable)
    && Array.isArray(fingerprint.argv)
    && fingerprint.argv.every((argument: unknown): argument is string => typeof argument === "string")
    && typeof fingerprint.launchPath === "string"
    && isAbsolute(fingerprint.launchPath)
    && typeof fingerprint.entrypoint === "string"
    && isAbsolute(fingerprint.entrypoint)
    && typeof fingerprint.entrypointDigest === "string"
    && /^[a-f0-9]{64}$/u.test(fingerprint.entrypointDigest)
    && isOfflineStateDirectoryProof(fingerprint.stateDirectory)
    && isOfflineStateFileProof(fingerprint.pidFile, "required")
    && isOfflineStateFileProof(fingerprint.tokenFile, "forbidden")
    && Number.isInteger(fingerprint.listenerPort)
    && (fingerprint.listenerPort as number) > 0
    && (fingerprint.listenerPort as number) <= 65_535
    && fingerprint.argv[0] === fingerprint.execPath
    && fingerprint.argv[1] === fingerprint.launchPath
    && fingerprint.argv[2] === "daemon"
    && fingerprint.argv[3] === "start"
    && fingerprint.argv[4] === "--foreground"
    && fingerprint.pidFile.path === join(fingerprint.stateDirectory.path, "daemon.pid")
    && fingerprint.pidFile.content === String(fingerprint.pid)
    && fingerprint.tokenFile.path === join(fingerprint.stateDirectory.path, "daemon.token")
    && (fingerprint.ownerId === null
      ? fingerprint.argv.length === 5
      : fingerprint.argv.length === 9
        && fingerprint.argv[5] === DAEMON_TEST_OWNER_OPTION
        && fingerprint.argv[6] === fingerprint.ownerId
        && fingerprint.argv[7] === DAEMON_TEST_ENTRYPOINT_OPTION
        && fingerprint.argv[8] === fingerprint.launchPath)
    && (fingerprint.ownerId === null
      || (typeof fingerprint.ownerId === "string" && fingerprint.ownerId.length > 0));
}

function isOfflineRecoveryRecord(value: unknown): value is OfflineRecoveryRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return hasExactKeys(record, [
    "version",
    "kind",
    "pidFilePath",
    "tokenFilePath",
    "quarantinePath",
    "fingerprint",
  ])
    && record.version === OFFLINE_RECOVERY_RECORD_VERSION
    && record.kind === "lcm-offline-restart"
    && typeof record.pidFilePath === "string"
    && isAbsolute(record.pidFilePath)
    && typeof record.tokenFilePath === "string"
    && isAbsolute(record.tokenFilePath)
    && typeof record.quarantinePath === "string"
    && isAbsolute(record.quarantinePath)
    && isOfflineRestartFingerprint(record.fingerprint)
    && record.pidFilePath === record.fingerprint.pidFile.path
    && record.tokenFilePath === record.fingerprint.tokenFile.path
    && record.quarantinePath === join(
      record.fingerprint.stateDirectory.path,
      OFFLINE_RECOVERY_QUARANTINE_BASENAME,
    );
}

function serializeOfflineRecoveryRecord(record: OfflineRecoveryRecord): string {
  const orderedFileProof = (
    proof: OfflineStateFileProof,
    includeContent: boolean,
  ): Record<string, unknown> => ({
    path: proof.path,
    device: proof.device,
    inode: proof.inode,
    mode: proof.mode,
    uid: proof.uid,
    links: proof.links,
    size: proof.size,
    modifiedAtMs: proof.modifiedAtMs,
    changedAtMs: proof.changedAtMs,
    ...(includeContent ? { content: proof.content } : {}),
  });
  const fingerprint = record.fingerprint;
  const ordered = {
    version: record.version,
    kind: record.kind,
    pidFilePath: record.pidFilePath,
    tokenFilePath: record.tokenFilePath,
    quarantinePath: record.quarantinePath,
    fingerprint: {
      pid: fingerprint.pid,
      uid: fingerprint.uid,
      processStartTime: fingerprint.processStartTime,
      execPath: fingerprint.execPath,
      executable: fingerprint.executable,
      argv: [...fingerprint.argv],
      launchPath: fingerprint.launchPath,
      entrypoint: fingerprint.entrypoint,
      entrypointDigest: fingerprint.entrypointDigest,
      stateDirectory: {
        path: fingerprint.stateDirectory.path,
        device: fingerprint.stateDirectory.device,
        inode: fingerprint.stateDirectory.inode,
        mode: fingerprint.stateDirectory.mode,
        uid: fingerprint.stateDirectory.uid,
        links: fingerprint.stateDirectory.links,
      },
      pidFile: orderedFileProof(fingerprint.pidFile, true),
      tokenFile: orderedFileProof(fingerprint.tokenFile, false),
      listenerPort: fingerprint.listenerPort,
      ownerId: fingerprint.ownerId,
    },
  };
  return `${JSON.stringify(ordered)}\n`;
}

function readOfflineRecoveryRecord(
  recordPath: string,
  expectedUid: number,
): OfflineRecoveryRecordRead {
  if (!offlineRecoveryLeafIsPresent(recordPath)) return { kind: "absent" };
  const proof = readOfflineStateFileProof(
    recordPath,
    expectedUid,
    {
      readContent: true,
      requirePrivate: true,
      maxBytes: MAX_OFFLINE_RECOVERY_RECORD_BYTES,
    },
  );
  if (
    proof === null
    || (proof.mode & 0o777) !== 0o600
    || proof.size <= 0
    || proof.content === undefined
  ) {
    return proof === null ? { kind: "invalid" } : { kind: "invalid", proof };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(proof.content);
  } catch {
    return { kind: "invalid", proof };
  }
  if (!isOfflineRecoveryRecord(parsed)) return { kind: "invalid", proof };
  const canonical = serializeOfflineRecoveryRecord(parsed);
  return canonical === proof.content
    ? { kind: "valid", record: parsed, proof, bytes: canonical }
    : { kind: "invalid", proof };
}

function readOfflineRecoveryRecordMatchingBytes(
  recordPath: string,
  expectedUid: number,
  expectedBytes: string,
): (OfflineRecoveryRecordRead & { kind: "valid" }) | null {
  const proof = readOfflineStateFileProof(
    recordPath,
    expectedUid,
    {
      readContent: true,
      requirePrivate: true,
      maxBytes: MAX_OFFLINE_RECOVERY_RECORD_BYTES,
    },
  );
  if (
    proof === null
    || (proof.mode & 0o777) !== 0o600
    || proof.size <= 0
    || proof.content !== expectedBytes
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(proof.content);
  } catch {
    return null;
  }
  return isOfflineRecoveryRecord(parsed)
    ? { kind: "valid", record: parsed, proof, bytes: expectedBytes }
    : null;
}

function readBoundedProcText(
  path: string,
  maxBytes: number,
  expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined,
): string | null {
  if (expectedUid === undefined) return null;
  const read = readStableBoundedDescriptor(path, maxBytes, true);
  if (
    read.kind !== "valid"
    || read.before.uid !== expectedUid
    || read.before.nlink !== 1
    || (read.before.mode & 0o7022) !== 0
  ) {
    return null;
  }
  return read.content.toString("utf8");
}

function readLinuxProcessStartTime(
  pid: number,
  procRoot: string,
  expectedUid?: number,
): string | null {
  const value = readBoundedProcText(
    join(procRoot, String(pid), "stat"),
    MAX_OFFLINE_PROC_STAT_BYTES,
    expectedUid,
  );
  if (value === null) return null;
  const commandEnd = value.lastIndexOf(")");
  if (commandEnd < 2 || commandEnd + 2 >= value.length) return null;
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/);
  const startTime = fields[19];
  return startTime !== undefined && /^[1-9]\d*$/.test(startTime) ? startTime : null;
}

function readLinuxProcessArgv(
  pid: number,
  procRoot: string,
  expectedUid?: number,
): readonly string[] | null {
  const value = readBoundedProcText(
    join(procRoot, String(pid), "cmdline"),
    MAX_OFFLINE_PROC_TEXT_BYTES,
    expectedUid,
  );
  if (value === null || value.length === 0 || !value.endsWith("\0")) return null;
  const argv = value.slice(0, -1).split("\0");
  return argv.length > 0 && argv.every((argument: string): boolean => argument.length > 0)
    ? Object.freeze(argv)
    : null;
}

function linuxProcessBirthState(
  pid: number,
  procRoot: string,
  expectedStartTime: string,
  expectedUid: number,
): LinuxProcessBirthState {
  const statPath = join(procRoot, String(pid), "stat");
  const read = readStableBoundedDescriptor(
    statPath,
    MAX_OFFLINE_PROC_STAT_BYTES,
    true,
  );
  if (read.kind === "absent") {
    try {
      lstatSync(join(procRoot, String(pid)));
      return { kind: "unreadable" };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { kind: "gone" }
        : { kind: "unreadable" };
    }
  }
  if (read.kind !== "valid") return { kind: "unreadable" };
  if (
    read.before.uid !== expectedUid
    || read.before.nlink !== 1
    || (read.before.mode & 0o7022) !== 0
  ) {
    return { kind: "unreadable" };
  }
  const value = read.content.toString("utf8");
  const commandEnd = value.lastIndexOf(")");
  if (commandEnd < 2 || commandEnd + 2 >= value.length) return { kind: "unreadable" };
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/);
  const startTime = fields[19];
  if (startTime === undefined || !/^[1-9]\d*$/u.test(startTime)) {
    return { kind: "unreadable" };
  }
  return startTime === expectedStartTime
    ? { kind: "exact", startTime }
    : { kind: "reused", startTime };
}

function readOfflineDirectParentProof(
  pid: number,
  procRoot: string,
  expectedUid: number,
): OfflineDirectParentProof | null {
  const candidateStatus = readBoundedProcText(
    join(procRoot, String(pid), "status"),
    MAX_OFFLINE_PROC_TEXT_BYTES,
    expectedUid,
  );
  const parentText = candidateStatus === null ? null : statusField(candidateStatus, "PPid");
  if (parentText === null || !/^[1-9]\d*$/u.test(parentText)) return null;
  const parentPid = Number(parentText);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || String(parentPid) !== parentText) {
    return null;
  }
  const processDirectory = readOfflineDirectDirectoryProof(
    join(procRoot, String(parentPid)),
  );
  const status = readBoundedProcText(
    join(procRoot, String(parentPid), "status"),
    MAX_OFFLINE_PROC_TEXT_BYTES,
    expectedUid,
  );
  const processStartTime = readLinuxProcessStartTime(parentPid, procRoot, expectedUid);
  const argv = readLinuxProcessArgv(parentPid, procRoot, expectedUid);
  let executable: string;
  try {
    executable = realpathSync(join(procRoot, String(parentPid), "exe"));
  } catch {
    return null;
  }
  if (
    !offlineDirectDirectoryIsOwned(processDirectory, expectedUid)
    || status === null
    || statusUid(status) !== expectedUid
    || processStartTime === null
    || argv === null
    || argv.length !== 2
    || basename(argv[0]!) !== "systemd"
    || argv[1] !== "--user"
  ) {
    return null;
  }
  try {
    if (realpathSync(argv[0]!) !== executable) return null;
  } catch {
    return null;
  }
  const finalProcessDirectory = readOfflineDirectDirectoryProof(processDirectory.path);
  if (
    !offlineDirectDirectoryProofMatches(processDirectory, finalProcessDirectory)
    || readLinuxProcessStartTime(parentPid, procRoot, expectedUid) !== processStartTime
  ) {
    return null;
  }
  return Object.freeze({
    pid: parentPid,
    processStartTime,
    processDirectory,
    argv,
    executable,
  });
}

type OfflineListenerTableColumns = [
  slot: string,
  localAddress: string,
  remoteAddress: string,
  state: string,
  queue: string,
  timer: string,
  retransmits: string,
  uid: string,
  timeout: string,
  inode: string,
  ...extra: string[],
];

function hasOfflineListenerTableColumns(
  columns: string[],
): columns is OfflineListenerTableColumns {
  return columns.length >= 10;
}

function readOfflineDirectListenerSocketInodes(
  pid: number,
  procRoot: string,
  port: number,
  expectedUid: number,
): readonly string[] | null {
  const fdPath = join(procRoot, String(pid), "fd");
  const fdDirectory = readOfflineDirectDirectoryProof(fdPath);
  if (!offlineDirectDirectoryIsOwned(fdDirectory, expectedUid)) return null;
  const processSocketInodes = new Set<string>();
  try {
    for (const entry of readdirSync(fdPath)) {
      if (!/^\d+$/u.test(entry)) return null;
      const target = readlinkSync(join(fdPath, entry));
      const socket = /^socket:\[(\d+)\]$/u.exec(target);
      if (socket !== null) processSocketInodes.add(socket[1]!);
    }
  } catch {
    return null;
  }
  if (
    processSocketInodes.size === 0
    || !offlineDirectDirectoryProofMatches(
      fdDirectory,
      readOfflineDirectDirectoryProof(fdPath),
    )
  ) {
    return null;
  }

  const listenerSocketInodes = new Set<string>();
  for (const table of ["tcp", "tcp6"] as const) {
    const read = readStableBoundedDescriptor(
      join(procRoot, "net", table),
      1024 * 1024,
      true,
    );
    if (
      read.kind !== "valid"
      || read.before.nlink !== 1
      || (read.before.mode & 0o7022) !== 0
    ) {
      return null;
    }
    const lines = read.content.toString("utf8").split(/\r?\n/u);
    const header = lines.shift()?.trim().split(/\s+/u);
    if (
      header === undefined
      || header[0] !== "sl"
      || header[1] !== "local_address"
      || header[2] !== "rem_address"
      || header[3] !== "st"
      || !header.includes("uid")
      || !header.includes("inode")
    ) {
      return null;
    }
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const columns = line.trim().split(/\s+/u);
      if (!hasOfflineListenerTableColumns(columns)) return null;
      const [addressText, portText, ...extraLocalParts] = columns[1].split(":");
      if (
        addressText === undefined
        || portText === undefined
        || extraLocalParts.length !== 0
        || !/^\d+:$/u.test(columns[0])
        || !/^(?:[A-Fa-f0-9]{8}|[A-Fa-f0-9]{32})$/u.test(addressText)
        || !/^[A-Fa-f0-9]{4}$/u.test(portText)
        || !/^[A-Fa-f0-9]{2}$/u.test(columns[3])
        || !/^\d+$/u.test(columns[7])
        || !/^\d+$/u.test(columns[9])
      ) {
        return null;
      }
      const address = addressText.toUpperCase();
      const isExactLoopback = table === "tcp"
        ? address === "0100007F"
        : address === "0000000000000000FFFF00000100007F";
      const isWildcard = table === "tcp"
        ? address === "00000000"
        : address === "00000000000000000000000000000000";
      const parsedPort = Number.parseInt(portText, 16);
      const parsedUid = Number(columns[7]);
      if (columns[3] === "0A" && isWildcard && parsedPort === port) return null;
      if (
        columns[3] === "0A"
        && isExactLoopback
        && parsedPort === port
      ) {
        if (
          parsedUid !== expectedUid
          || !processSocketInodes.has(columns[9])
        ) {
          return null;
        }
        listenerSocketInodes.add(columns[9]);
      }
    }
  }
  return listenerSocketInodes.size > 0
    ? Object.freeze([...listenerSocketInodes].sort())
    : null;
}

function captureOfflineDirectCandidateProof(
  fingerprint: OfflineRestartFingerprint,
  procRoot: string,
): OfflineDirectCandidateProof | null {
  const processDirectory = readOfflineDirectDirectoryProof(
    join(procRoot, String(fingerprint.pid)),
  );
  if (!offlineDirectDirectoryIsOwned(processDirectory, fingerprint.uid)) return null;
  const birth = linuxProcessBirthState(
    fingerprint.pid,
    procRoot,
    fingerprint.processStartTime,
    fingerprint.uid,
  );
  const status = readBoundedProcText(
    join(procRoot, String(fingerprint.pid), "status"),
    MAX_OFFLINE_PROC_TEXT_BYTES,
    fingerprint.uid,
  );
  const argv = readLinuxProcessArgv(fingerprint.pid, procRoot, fingerprint.uid);
  const launchPath = process.argv[1];
  let executable: string;
  let canonicalExecPath: string;
  let canonicalLaunchPath: string;
  try {
    executable = realpathSync(join(procRoot, String(fingerprint.pid), "exe"));
    canonicalExecPath = realpathSync(process.execPath);
    if (typeof launchPath !== "string" || !isAbsolute(launchPath)) return null;
    canonicalLaunchPath = realpathSync(launchPath);
  } catch {
    return null;
  }
  const parent = readOfflineDirectParentProof(
    fingerprint.pid,
    procRoot,
    fingerprint.uid,
  );
  const listenerSocketInodes = readOfflineDirectListenerSocketInodes(
    fingerprint.pid,
    procRoot,
    fingerprint.listenerPort,
    fingerprint.uid,
  );
  if (
    birth.kind !== "exact"
    || status === null
    || statusUid(status) !== fingerprint.uid
    || argv === null
    || !offlineStringSequencesMatch(argv, fingerprint.argv)
    || executable !== fingerprint.executable
    || process.execPath !== fingerprint.execPath
    || canonicalExecPath !== fingerprint.executable
    || launchPath !== fingerprint.launchPath
    || canonicalLaunchPath !== fingerprint.entrypoint
    || isVitestWorkerEntrypoint(launchPath)
    || sha256File(canonicalLaunchPath) !== fingerprint.entrypointDigest
    || parent === null
    || listenerSocketInodes === null
    || !offlineDirectDirectoryProofMatches(
      processDirectory,
      readOfflineDirectDirectoryProof(processDirectory.path),
    )
  ) {
    return null;
  }
  return Object.freeze({ processDirectory, parent, listenerSocketInodes });
}

function offlineDirectCandidateProofsMatch(
  left: OfflineDirectCandidateProof,
  right: OfflineDirectCandidateProof,
): boolean {
  return offlineDirectDirectoryProofMatches(left.processDirectory, right.processDirectory)
    && left.parent.pid === right.parent.pid
    && left.parent.processStartTime === right.parent.processStartTime
    && left.parent.executable === right.parent.executable
    && offlineDirectDirectoryProofMatches(
      left.parent.processDirectory,
      right.parent.processDirectory,
    )
    && offlineStringSequencesMatch(left.parent.argv, right.parent.argv)
    && offlineStringSequencesMatch(left.listenerSocketInodes, right.listenerSocketInodes);
}

function offlineDirectPathIsAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

type TerminalExactFileCapability =
  | Readonly<{
    kind: "retained-regular";
    expectedProof: TerminalFileProof;
    expectedContent: TerminalByteSequence;
    maximumBytes: number;
    expectedSha256: string | null;
  }>
  | Readonly<{
    kind: "proc-cmdline";
    expectedProof: TerminalFileProof;
    expectedContent: TerminalByteSequence;
    maximumBytes: number;
  }>
  | Readonly<{
    kind: "discover-recovery";
    path: string;
    expectedUid: number;
    expectedContent: TerminalByteSequence;
    maximumBytes: number;
  }>;

type TerminalDynamicProcCapability =
  | Readonly<{
    kind: "process";
    path: string;
    uid: number;
    maximumBytes: number;
  }>
  | Readonly<{
    kind: "network";
    path: string;
    maximumBytes: number;
  }>;

function terminalByteSequence(value: string): TerminalByteSequence {
  const bytes = terminalBufferFrom(value, "utf8");
  return Object.freeze({ bytes, length: bytes.length });
}

function terminalCopiedByteSequence(value: Buffer): TerminalByteSequence {
  const bytes = terminalBufferFrom(value);
  return Object.freeze({ bytes, length: bytes.length });
}

const TERMINAL_UID_LABEL = terminalByteSequence("Uid:");
const TERMINAL_PPID_LABEL = terminalByteSequence("PPid:");
const TERMINAL_TCP_HEADER_SL = terminalByteSequence("sl");
const TERMINAL_TCP_HEADER_LOCAL = terminalByteSequence("local_address");
const TERMINAL_TCP_HEADER_REMOTE = terminalByteSequence("rem_address");
const TERMINAL_TCP_HEADER_STATE = terminalByteSequence("st");
const TERMINAL_TCP_HEADER_UID = terminalByteSequence("uid");
const TERMINAL_TCP_HEADER_INODE = terminalByteSequence("inode");
const TERMINAL_TCP_LISTEN = terminalByteSequence("0A");
const TERMINAL_IPV4_LOOPBACK = terminalByteSequence("0100007F");
const TERMINAL_IPV4_WILDCARD = terminalByteSequence("00000000");
const TERMINAL_IPV6_LOOPBACK = terminalByteSequence(
  "0000000000000000FFFF00000100007F",
);
const TERMINAL_IPV6_WILDCARD = terminalByteSequence(
  "00000000000000000000000000000000",
);
const TERMINAL_MAX_TCP_BYTES = 1024 * 1024;

function terminalFileProof(proof: OfflineStateFileProof): TerminalFileProof {
  return Object.freeze({
    path: proof.path,
    device: proof.device,
    inode: proof.inode,
    mode: proof.mode,
    uid: proof.uid,
    links: proof.links,
    size: proof.size,
    modifiedAtMs: proof.modifiedAtMs,
    changedAtMs: proof.changedAtMs,
  });
}

function terminalDirectoryProof(
  proof: OfflineStateDirectoryProof | OfflineDirectDirectoryProof,
): TerminalDirectoryProof {
  return Object.freeze({
    path: proof.path,
    device: proof.device,
    inode: proof.inode,
    mode: proof.mode,
    uid: proof.uid,
    links: "links" in proof ? proof.links : null,
  });
}

function terminalStatsStable(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function terminalFileProofMatchesStats(proof: TerminalFileProof, stats: Stats): boolean {
  return (stats.mode & TERMINAL_S_IFMT) === TERMINAL_S_IFREG
    && stats.dev === proof.device
    && stats.ino === proof.inode
    && stats.mode === proof.mode
    && stats.uid === proof.uid
    && stats.nlink === proof.links
    && stats.size === proof.size
    && stats.mtimeMs === proof.modifiedAtMs
    && stats.ctimeMs === proof.changedAtMs;
}

function terminalFileProofMatchesProof(
  left: TerminalFileProof,
  right: TerminalFileProof,
): boolean {
  return left.path === right.path
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.uid === right.uid
    && left.links === right.links
    && left.size === right.size
    && left.modifiedAtMs === right.modifiedAtMs
    && left.changedAtMs === right.changedAtMs;
}

function terminalDirectoryProofMatchesStats(
  proof: TerminalDirectoryProof,
  stats: Stats,
): boolean {
  return (stats.mode & TERMINAL_S_IFMT) === TERMINAL_S_IFDIR
    && stats.dev === proof.device
    && stats.ino === proof.inode
    && stats.mode === proof.mode
    && stats.uid === proof.uid
    && (proof.links === null || stats.nlink === proof.links);
}

function terminalBytesMatch(
  left: TerminalByteSequence,
  right: TerminalByteSequence,
): boolean {
  let index = 0;
  while (index < left.length) {
    if (left.bytes[index] !== right.bytes[index]) return false;
    index += 1;
  }
  return true;
}

function terminalTokenMatches(
  content: TerminalByteSequence,
  start: number,
  end: number,
  expected: TerminalByteSequence,
): boolean {
  if (end - start !== expected.length) return false;
  let index = 0;
  while (index < expected.length) {
    if (content.bytes[start + index] !== expected.bytes[index]) return false;
    index += 1;
  }
  return true;
}

function terminalReadExactFile(
  capability: TerminalExactFileCapability,
): TerminalFileProof | null {
  const expectedContent = capability.expectedContent;
  let expectedProof: TerminalFileProof | null;
  let path: string;
  let expectedUid: number;
  if (capability.kind === "discover-recovery") {
    expectedProof = null;
    path = capability.path;
    expectedUid = capability.expectedUid;
  } else {
    expectedProof = capability.expectedProof;
    path = capability.expectedProof.path;
    expectedUid = capability.expectedProof.uid;
  }
  // Exact capabilities have closed private constructors: frozen seed capabilities
  // validate retained bytes, while terminalExactAuthorityAt uses bounded seed bytes
  // and the fresh proof from its discover read for the retained second read.
  let descriptor = -1;
  let result: TerminalFileProof | null = null;
  try {
    descriptor = terminalOpenSync(
      path,
      TERMINAL_O_RDONLY | TERMINAL_O_NOFOLLOW | TERMINAL_O_NONBLOCK,
    );
    const before = terminalFstatSync(descriptor);
    if (
      (before.mode & TERMINAL_S_IFMT) !== TERMINAL_S_IFREG
      || before.uid !== expectedUid
      || before.nlink !== 1
      || (before.mode & 0o7022) !== 0
      || before.size < 0
      || (capability.kind === "discover-recovery"
        && ((before.mode & 0o777) !== 0o600 || before.size !== expectedContent.length))
    ) {
      result = null;
    } else {
      const bytes = terminalBufferAlloc(expectedContent.length + 1);
      let offset = 0;
      let eofObserved = false;
      let readValid = true;
      while (readValid && !eofObserved && offset <= expectedContent.length) {
        const remaining = expectedContent.length + 1 - offset;
        const count = terminalReadSync(descriptor, bytes, offset, remaining, offset);
        if (count === 0) {
          eofObserved = true;
        } else if (count < 0 || count > remaining) {
          readValid = false;
        } else {
          offset += count;
        }
      }
      const content: TerminalByteSequence = { bytes, length: offset };
      if (
        readValid
        && eofObserved
        && offset === expectedContent.length
        && terminalBytesMatch(content, expectedContent)
      ) {
        const after = terminalFstatSync(descriptor);
        if (expectedProof === null) {
          if (
            terminalStatsStable(before, after)
            && (after.mode & TERMINAL_S_IFMT) === TERMINAL_S_IFREG
            && after.uid === expectedUid
            && after.nlink === 1
            && (after.mode & 0o777) === 0o600
            && after.size === expectedContent.length
          ) {
            result = {
              path,
              device: after.dev,
              inode: after.ino,
              mode: after.mode,
              uid: after.uid,
              links: after.nlink,
              size: after.size,
              modifiedAtMs: after.mtimeMs,
              changedAtMs: after.ctimeMs,
            };
          }
        } else if (
          terminalFileProofMatchesStats(expectedProof, before)
          && terminalFileProofMatchesStats(expectedProof, after)
          && (capability.kind !== "retained-regular"
            || capability.expectedSha256 === null
            || terminalSha256(content) === capability.expectedSha256)
        ) {
          result = expectedProof;
        }
      }
    }
  } catch {
    result = null;
  } finally {
    if (descriptor >= 0) {
      try {
        terminalCloseSync(descriptor);
      } catch {
        result = null;
      }
    }
  }
  return result;
}

function terminalReadDynamicProc(
  capability: TerminalDynamicProcCapability,
): TerminalByteSequence | null {
  const path = capability.path;
  const maximumBytes = capability.maximumBytes;
  const expectedUid = capability.kind === "process" ? capability.uid : null;
  // The six closed seed families are replacement and parent stat/status plus tcp/tcp6.
  let descriptor = -1;
  let result: TerminalByteSequence | null = null;
  try {
    descriptor = terminalOpenSync(
      path,
      TERMINAL_O_RDONLY | TERMINAL_O_NOFOLLOW | TERMINAL_O_NONBLOCK,
    );
    const before = terminalFstatSync(descriptor);
    if (
      (before.mode & TERMINAL_S_IFMT) !== TERMINAL_S_IFREG
      || (expectedUid !== null && before.uid !== expectedUid)
      || before.nlink !== 1
      || (before.mode & 0o7022) !== 0
      || before.size < 0
    ) {
      result = null;
    } else {
      const bytes = terminalBufferAlloc(maximumBytes + 1);
      let offset = 0;
      let eofObserved = false;
      let readValid = true;
      while (readValid && !eofObserved && offset <= maximumBytes) {
        const remaining = maximumBytes + 1 - offset;
        const count = terminalReadSync(descriptor, bytes, offset, remaining, offset);
        if (count === 0) {
          eofObserved = true;
        } else if (count < 0 || count > remaining) {
          readValid = false;
        } else {
          offset += count;
        }
      }
      if (readValid && eofObserved && offset <= maximumBytes) {
        const after = terminalFstatSync(descriptor);
        if (
          terminalStatsStable(before, after)
          && (after.mode & TERMINAL_S_IFMT) === TERMINAL_S_IFREG
          && (expectedUid === null || after.uid === expectedUid)
          && after.nlink === 1
          && (after.mode & 0o7022) === 0
          && after.size >= 0
          && (after.size === 0 || after.size === offset)
        ) {
          result = { bytes, length: offset };
        }
      }
    }
  } catch {
    result = null;
  } finally {
    if (descriptor >= 0) {
      try {
        terminalCloseSync(descriptor);
      } catch {
        result = null;
      }
    }
  }
  return result;
}

function terminalReadStableMetadata(
  path: string,
  expectedUid: number,
): TerminalFileProof | null {
  let descriptor = -1;
  try {
    descriptor = terminalOpenSync(
      path,
      TERMINAL_O_RDONLY | TERMINAL_O_NOFOLLOW | TERMINAL_O_NONBLOCK,
    );
    const before = terminalFstatSync(descriptor);
    const after = terminalFstatSync(descriptor);
    if (
      !terminalStatsStable(before, after)
      || (after.mode & TERMINAL_S_IFMT) !== TERMINAL_S_IFREG
      || after.uid !== expectedUid
      || after.nlink !== 1
      || (after.mode & 0o7022) !== 0
    ) {
      return null;
    }
    return {
      path,
      device: after.dev,
      inode: after.ino,
      mode: after.mode,
      uid: after.uid,
      links: after.nlink,
      size: after.size,
      modifiedAtMs: after.mtimeMs,
      changedAtMs: after.ctimeMs,
    };
  } catch {
    return null;
  } finally {
    if (descriptor >= 0) {
      try {
        terminalCloseSync(descriptor);
      } catch {
        return null;
      }
    }
  }
}

function terminalDirectoryMatches(proof: TerminalDirectoryProof): boolean {
  let descriptor = -1;
  try {
    descriptor = terminalOpenSync(
      proof.path,
      TERMINAL_O_RDONLY
        | TERMINAL_O_NOFOLLOW
        | TERMINAL_O_NONBLOCK
        | TERMINAL_O_DIRECTORY,
    );
    const before = terminalFstatSync(descriptor);
    const after = terminalFstatSync(descriptor);
    return terminalStatsStable(before, after)
      && terminalDirectoryProofMatchesStats(proof, after);
  } catch {
    return false;
  } finally {
    if (descriptor >= 0) {
      try {
        terminalCloseSync(descriptor);
      } catch {
        return false;
      }
    }
  }
}

function terminalSyncDirectoryMatches(proof: TerminalDirectoryProof): boolean {
  let descriptor = -1;
  try {
    descriptor = terminalOpenSync(
      proof.path,
      TERMINAL_O_RDONLY
        | TERMINAL_O_NOFOLLOW
        | TERMINAL_O_NONBLOCK
        | TERMINAL_O_DIRECTORY,
    );
    const before = terminalFstatSync(descriptor);
    if (!terminalDirectoryProofMatchesStats(proof, before)) return false;
    terminalFsyncSync(descriptor);
    const after = terminalFstatSync(descriptor);
    return terminalStatsStable(before, after)
      && terminalDirectoryProofMatchesStats(proof, after);
  } catch {
    return false;
  } finally {
    if (descriptor >= 0) {
      try {
        terminalCloseSync(descriptor);
      } catch {
        return false;
      }
    }
  }
}

function terminalSyncFileMatches(proof: TerminalFileProof): boolean {
  let descriptor = -1;
  try {
    descriptor = terminalOpenSync(
      proof.path,
      TERMINAL_O_RDONLY | TERMINAL_O_NOFOLLOW | TERMINAL_O_NONBLOCK,
    );
    const before = terminalFstatSync(descriptor);
    if (!terminalFileProofMatchesStats(proof, before)) return false;
    terminalFsyncSync(descriptor);
    const after = terminalFstatSync(descriptor);
    return terminalStatsStable(before, after)
      && terminalFileProofMatchesStats(proof, after);
  } catch {
    return false;
  } finally {
    if (descriptor >= 0) {
      try {
        terminalCloseSync(descriptor);
      } catch {
        return false;
      }
    }
  }
}

function terminalPathIsAbsent(path: string): boolean {
  try {
    return terminalLstatSync(path, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

function terminalFieldEquals(
  content: TerminalByteSequence,
  label: TerminalByteSequence,
  expected: TerminalByteSequence,
): boolean {
  let lineStart = 0;
  while (lineStart < content.length) {
    let lineEnd = lineStart;
    while (lineEnd < content.length && content.bytes[lineEnd] !== 10) lineEnd += 1;
    if (lineEnd - lineStart > label.length) {
      let labelMatches = true;
      let labelIndex = 0;
      while (labelIndex < label.length) {
        if (content.bytes[lineStart + labelIndex] !== label.bytes[labelIndex]) {
          labelMatches = false;
          break;
        }
        labelIndex += 1;
      }
      if (labelMatches) {
        let valueStart = lineStart + label.length;
        while (
          valueStart < lineEnd
          && (content.bytes[valueStart] === 32 || content.bytes[valueStart] === 9)
        ) {
          valueStart += 1;
        }
        const valueEnd = valueStart + expected.length;
        if (valueEnd > lineEnd) return false;
        if (!terminalTokenMatches(content, valueStart, valueEnd, expected)) return false;
        return valueEnd === lineEnd
          || content.bytes[valueEnd] === 32
          || content.bytes[valueEnd] === 9
          || content.bytes[valueEnd] === 13;
      }
    }
    lineStart = lineEnd + 1;
  }
  return false;
}

function terminalStatStartTimeEquals(
  content: TerminalByteSequence,
  expected: TerminalByteSequence,
): boolean {
  let commandEnd = content.length - 1;
  while (commandEnd >= 0 && content.bytes[commandEnd] !== 41) commandEnd -= 1;
  if (commandEnd < 2) return false;
  let position = commandEnd + 1;
  let tokenIndex = 0;
  while (position < content.length) {
    while (
      position < content.length
      && (content.bytes[position] === 32
        || content.bytes[position] === 9
        || content.bytes[position] === 10
        || content.bytes[position] === 13)
    ) {
      position += 1;
    }
    if (position >= content.length) break;
    const tokenStart = position;
    while (
      position < content.length
      && content.bytes[position] !== 32
      && content.bytes[position] !== 9
      && content.bytes[position] !== 10
      && content.bytes[position] !== 13
    ) {
      position += 1;
    }
    if (tokenIndex === 19) {
      return terminalTokenMatches(content, tokenStart, position, expected);
    }
    tokenIndex += 1;
  }
  return false;
}

function terminalDecimalToken(
  content: TerminalByteSequence,
  start: number,
  end: number,
): boolean {
  let index = start;
  while (index < end) {
    const byte = content.bytes[index];
    if (byte < 48 || byte > 57) return false;
    index += 1;
  }
  return true;
}

function terminalHexToken(
  content: TerminalByteSequence,
  start: number,
  end: number,
): boolean {
  let index = start;
  while (index < end) {
    const byte = content.bytes[index];
    if (
      !(
        (byte >= 48 && byte <= 57)
        || (byte >= 65 && byte <= 70)
        || (byte >= 97 && byte <= 102)
      )
    ) {
      return false;
    }
    index += 1;
  }
  return true;
}

function terminalTcpHeaderValid(
  content: TerminalByteSequence,
  starts: Int32Array,
  ends: Int32Array,
  count: number,
): boolean {
  if (count < 6) return false;
  if (
    !terminalTokenMatches(content, starts[0]!, ends[0]!, TERMINAL_TCP_HEADER_SL)
    || !terminalTokenMatches(content, starts[1]!, ends[1]!, TERMINAL_TCP_HEADER_LOCAL)
    || !terminalTokenMatches(content, starts[2]!, ends[2]!, TERMINAL_TCP_HEADER_REMOTE)
    || !terminalTokenMatches(content, starts[3]!, ends[3]!, TERMINAL_TCP_HEADER_STATE)
  ) {
    return false;
  }
  let uidSeen = false;
  let inodeSeen = false;
  let index = 4;
  while (index < count) {
    if (terminalTokenMatches(content, starts[index]!, ends[index]!, TERMINAL_TCP_HEADER_UID)) {
      uidSeen = true;
    }
    if (terminalTokenMatches(content, starts[index]!, ends[index]!, TERMINAL_TCP_HEADER_INODE)) {
      inodeSeen = true;
    }
    index += 1;
  }
  return uidSeen && inodeSeen;
}

function terminalTcpListenerMask(
  content: TerminalByteSequence,
  ipv6: boolean,
  seed: TerminalRecoveryAuthoritySeed,
): number {
  const starts = new TerminalInt32Array(32);
  const ends = new TerminalInt32Array(32);
  let lineStart = 0;
  let lineIndex = 0;
  let matchedMask = 0;
  while (lineStart <= content.length) {
    let lineEnd = lineStart;
    while (lineEnd < content.length && content.bytes[lineEnd] !== 10) lineEnd += 1;
    let position = lineStart;
    let count = 0;
    while (position < lineEnd) {
      while (
        position < lineEnd
        && (content.bytes[position] === 32
          || content.bytes[position] === 9
          || content.bytes[position] === 13)
      ) {
        position += 1;
      }
      if (position >= lineEnd) break;
      if (count >= 32) return -1;
      starts[count] = position;
      while (
        position < lineEnd
        && content.bytes[position] !== 32
        && content.bytes[position] !== 9
        && content.bytes[position] !== 13
      ) {
        position += 1;
      }
      ends[count] = position;
      count += 1;
    }
    if (count > 0) {
      if (lineIndex === 0) {
        if (!terminalTcpHeaderValid(content, starts, ends, count)) return -1;
      } else {
        if (count < 10) return -1;
        const slStart = starts[0]!;
        const slEnd = ends[0]!;
        if (
          slEnd - slStart < 2
          || content.bytes[slEnd - 1] !== 58
          || !terminalDecimalToken(content, slStart, slEnd - 1)
        ) {
          return -1;
        }
        const localStart = starts[1]!;
        const localEnd = ends[1]!;
        const addressLength = ipv6 ? 32 : 8;
        if (
          localEnd - localStart !== addressLength + 5
          || content.bytes[localStart + addressLength] !== 58
          || !terminalHexToken(content, localStart, localStart + addressLength)
          || !terminalHexToken(content, localStart + addressLength + 1, localEnd)
          || !terminalHexToken(content, starts[3]!, ends[3]!)
          || !terminalDecimalToken(content, starts[7]!, ends[7]!)
          || !terminalDecimalToken(content, starts[9]!, ends[9]!)
        ) {
          return -1;
        }
        const loopback = terminalTokenMatches(
          content,
          localStart,
          localStart + addressLength,
          ipv6 ? TERMINAL_IPV6_LOOPBACK : TERMINAL_IPV4_LOOPBACK,
        );
        const wildcard = terminalTokenMatches(
          content,
          localStart,
          localStart + addressLength,
          ipv6 ? TERMINAL_IPV6_WILDCARD : TERMINAL_IPV4_WILDCARD,
        );
        const listeningOnConfiguredPort = (
          terminalTokenMatches(content, starts[3]!, ends[3]!, TERMINAL_TCP_LISTEN)
          && terminalTokenMatches(
            content,
            localStart + addressLength + 1,
            localEnd,
            seed.listenerPortHex,
          )
        );
        if (wildcard && listeningOnConfiguredPort) return -1;
        const configuredListener = (
          loopback
          && listeningOnConfiguredPort
        );
        if (configuredListener) {
          if (!terminalTokenMatches(
            content,
            starts[7]!,
            ends[7]!,
            seed.uidDecimal,
          )) {
            return -1;
          }
          let inodeIndex = 0;
          let inodeMatch = -1;
          while (inodeIndex < seed.listenerInodes.length) {
            if (
              terminalTokenMatches(
                content,
                starts[9]!,
                ends[9]!,
                seed.listenerInodes[inodeIndex]!,
              )
            ) {
              inodeMatch = inodeIndex;
              break;
            }
            inodeIndex += 1;
          }
          if (inodeMatch < 0) return -1;
          matchedMask |= 1 << inodeMatch;
        }
      }
      lineIndex += 1;
    }
    if (lineEnd >= content.length) break;
    lineStart = lineEnd + 1;
  }
  return lineIndex > 0 ? matchedMask : -1;
}

function terminalListenerMatches(seed: TerminalRecoveryAuthoritySeed): boolean {
  let fdDescriptor = -1;
  let descriptorValid = true;
  let before: Stats | null = null;
  let fdMask = 0;
  try {
    fdDescriptor = terminalOpenSync(
      seed.replacementProcess.fd,
      TERMINAL_O_RDONLY
        | TERMINAL_O_NOFOLLOW
        | TERMINAL_O_NONBLOCK
        | TERMINAL_O_DIRECTORY,
    );
    before = terminalFstatSync(fdDescriptor);
    if (!terminalDirectoryProofMatchesStats(seed.replacementFdDirectoryProof, before)) {
      descriptorValid = false;
    }
    let entries: string[] = [];
    if (descriptorValid) {
      entries = terminalReaddirSync(seed.replacementProcess.fd);
    }
    let entryIndex = 0;
    while (descriptorValid && entryIndex < entries.length) {
      const entry = entries[entryIndex]!;
      let character = 0;
      if (entry.length === 0) descriptorValid = false;
      while (descriptorValid && character < entry.length) {
        const value = entry[character];
        if (value === undefined || value < "0" || value > "9") {
          descriptorValid = false;
        }
        character += 1;
      }
      if (descriptorValid) {
        const target = terminalReadlinkSync(seed.replacementProcess.fd + "/" + entry);
        let targetIndex = 0;
        while (targetIndex < seed.listenerTargets.length) {
          if (target === seed.listenerTargets[targetIndex]) fdMask |= 1 << targetIndex;
          targetIndex += 1;
        }
      }
      entryIndex += 1;
    }
    if (descriptorValid) {
      const after = terminalFstatSync(fdDescriptor);
      if (
        before === null
        || !terminalStatsStable(before, after)
        || !terminalDirectoryProofMatchesStats(seed.replacementFdDirectoryProof, after)
      ) {
        descriptorValid = false;
      }
    }
  } catch {
    descriptorValid = false;
  } finally {
    if (fdDescriptor >= 0) {
      try {
        terminalCloseSync(fdDescriptor);
      } catch {
        descriptorValid = false;
      }
    }
  }
  if (
    !descriptorValid
    || !terminalDirectoryMatches(seed.replacementFdDirectoryProof)
  ) {
    return false;
  }
  if (fdMask !== seed.listenerMask) return false;
  const tcp = terminalReadDynamicProc({
    kind: "network",
    path: seed.tcpPath,
    maximumBytes: TERMINAL_MAX_TCP_BYTES,
  });
  const tcp6 = terminalReadDynamicProc({
    kind: "network",
    path: seed.tcp6Path,
    maximumBytes: TERMINAL_MAX_TCP_BYTES,
  });
  if (tcp === null || tcp6 === null) return false;
  const tcpMask = terminalTcpListenerMask(tcp, false, seed);
  const tcp6Mask = terminalTcpListenerMask(tcp6, true, seed);
  return tcpMask >= 0 && tcp6Mask >= 0 && (tcpMask | tcp6Mask) === seed.listenerMask;
}

function terminalSha256(content: TerminalByteSequence): string | null {
  try {
    const exactBytes = terminalBufferAlloc(content.length);
    let index = 0;
    while (index < content.length) {
      exactBytes[index] = content.bytes[index]!;
      index += 1;
    }
    const hash = terminalCreateHash("sha256");
    terminalReflectApply(terminalHashUpdate, hash, [exactBytes]);
    const digest = terminalReflectApply(terminalHashDigest, hash, ["hex"]);
    return typeof digest === "string" ? digest : null;
  } catch {
    return null;
  }
}

function terminalRecoveryProofSnapshot(seed: TerminalRecoveryAuthoritySeed): boolean {
  try {
    if (
      seed.rawClientExecPath !== seed.replacementExecPath
      || seed.rawClientLaunchPath !== seed.replacementLaunchPath
      || seed.canonicalClientExecutable !== seed.replacementExecutable
      || seed.canonicalClientEntrypoint !== seed.replacementEntrypoint
      || !terminalDirectoryMatches(seed.procRoot)
      || !terminalDirectoryMatches(seed.stateDirectory)
      || !terminalDirectoryMatches(seed.replacementStateDirectory)
      || !terminalPathIsAbsent(seed.originalDirectory)
      || !terminalPathIsAbsent(seed.recordPath)
    ) {
      return false;
    }
    let scopeIndex = 0;
    while (scopeIndex < seed.scopeDirectories.length) {
      if (!terminalDirectoryMatches(seed.scopeDirectories[scopeIndex]!)) return false;
      scopeIndex += 1;
    }
    let entrypointIndex = 0;
    while (entrypointIndex < seed.scopeEntrypoints.length) {
      const entrypoint = seed.scopeEntrypoints[entrypointIndex]!;
      if (terminalReadExactFile({
        kind: "retained-regular",
        expectedProof: entrypoint.proof,
        expectedContent: entrypoint.content,
        maximumBytes: MAX_OFFLINE_RUNTIME_BYTES,
        expectedSha256: null,
      }) === null) {
        return false;
      }
      entrypointIndex += 1;
    }
    if (seed.expectedAuthority === "clean") {
      if (
        !terminalPathIsAbsent(seed.recordPath)
        || !terminalPathIsAbsent(seed.quarantinePath)
        || !terminalSyncDirectoryMatches(seed.stateDirectory)
        || !terminalPathIsAbsent(seed.recordPath)
        || !terminalPathIsAbsent(seed.quarantinePath)
      ) {
        return false;
      }
    } else {
      const backupProof = seed.expectedBackupProof;
      if (
        terminalReadExactFile({
          kind: "retained-regular",
          expectedProof: backupProof,
          expectedContent: seed.recoveryBytes,
          maximumBytes: MAX_OFFLINE_RECOVERY_RECORD_BYTES,
          expectedSha256: null,
        }) === null
        || !terminalSyncFileMatches(backupProof)
        || !terminalSyncDirectoryMatches(seed.stateDirectory)
      ) {
        return false;
      }
    }
    if (
      !terminalDirectoryMatches(seed.replacementDirectoryProof)
      || terminalRealpathSync(seed.replacementProcess.executable)
        !== seed.canonicalClientExecutable
      || terminalRealpathSync(seed.replacementEntrypointProof.path)
        !== seed.canonicalClientEntrypoint
    ) {
      return false;
    }
    const replacementStat = terminalReadDynamicProc({
      kind: "process",
      path: seed.replacementProcess.stat,
      uid: seed.uid,
      maximumBytes: MAX_OFFLINE_PROC_STAT_BYTES,
    });
    const replacementStatus = terminalReadDynamicProc({
      kind: "process",
      path: seed.replacementProcess.status,
      uid: seed.uid,
      maximumBytes: MAX_OFFLINE_PROC_TEXT_BYTES,
    });
    const replacementCmdline = terminalReadExactFile({
      kind: "proc-cmdline",
      expectedProof: seed.replacementCmdlineProof,
      expectedContent: seed.replacementCmdline,
      maximumBytes: MAX_OFFLINE_PROC_TEXT_BYTES,
    });
    if (
      replacementStat === null
      || replacementStatus === null
      || replacementCmdline === null
      || !terminalStatStartTimeEquals(replacementStat, seed.replacementStartTime)
      || !terminalFieldEquals(replacementStatus, TERMINAL_UID_LABEL, seed.uidDecimal)
      || !terminalFieldEquals(
        replacementStatus,
        TERMINAL_PPID_LABEL,
        seed.parentPidDecimal,
      )
      || terminalReadExactFile({
        kind: "retained-regular",
        expectedProof: seed.replacementEntrypointProof,
        expectedContent: seed.replacementEntrypointContent,
        maximumBytes: MAX_OFFLINE_RUNTIME_BYTES,
        expectedSha256: seed.replacementEntrypointDigest,
      }) === null
    ) {
      return false;
    }
    const pidFile = terminalReadExactFile({
      kind: "retained-regular",
      expectedProof: seed.replacementPidFile,
      expectedContent: seed.replacementPidBytes,
      maximumBytes: MAX_OFFLINE_PID_BYTES,
      expectedSha256: null,
    });
    const tokenFile = terminalReadStableMetadata(seed.replacementTokenFile.path, seed.uid);
    if (
      pidFile === null
      || tokenFile === null
      || !terminalFileProofMatchesProof(tokenFile, seed.replacementTokenFile)
      || !terminalDirectoryMatches(seed.parentDirectoryProof)
      || terminalRealpathSync(seed.parentProcess.executable) !== seed.parentExecutable
      || terminalRealpathSync(seed.parentLaunchPath) !== seed.parentExecutable
    ) {
      return false;
    }
    const parentStat = terminalReadDynamicProc({
      kind: "process",
      path: seed.parentProcess.stat,
      uid: seed.uid,
      maximumBytes: MAX_OFFLINE_PROC_STAT_BYTES,
    });
    const parentStatus = terminalReadDynamicProc({
      kind: "process",
      path: seed.parentProcess.status,
      uid: seed.uid,
      maximumBytes: MAX_OFFLINE_PROC_TEXT_BYTES,
    });
    const parentCmdline = terminalReadExactFile({
      kind: "proc-cmdline",
      expectedProof: seed.parentCmdlineProof,
      expectedContent: seed.parentCmdline,
      maximumBytes: MAX_OFFLINE_PROC_TEXT_BYTES,
    });
    return parentStat !== null
      && parentStatus !== null
      && parentCmdline !== null
      && terminalStatStartTimeEquals(parentStat, seed.parentStartTime)
      && terminalFieldEquals(parentStatus, TERMINAL_UID_LABEL, seed.uidDecimal)
      && terminalListenerMatches(seed)
      && terminalDirectoryMatches(seed.replacementDirectoryProof)
      && terminalDirectoryMatches(seed.parentDirectoryProof);
  } catch {
    return false;
  }
}

function terminalRecoveryProof(seed: TerminalRecoveryAuthoritySeed): boolean {
  // The second complete physical snapshot catches evidence consumed and then
  // changed while the first snapshot was still validating later capabilities.
  return terminalRecoveryProofSnapshot(seed) && terminalRecoveryProofSnapshot(seed);
}

function terminalExactAuthorityAt(
  seed: TerminalRecoveryAuthoritySeed,
  path: string,
): boolean {
  const first = terminalReadExactFile({
    kind: "discover-recovery",
    path,
    expectedUid: seed.uid,
    expectedContent: seed.recoveryBytes,
    maximumBytes: MAX_OFFLINE_RECOVERY_RECORD_BYTES,
  });
  if (
    first === null
    || !terminalSyncFileMatches(first)
    || !terminalSyncDirectoryMatches(seed.stateDirectory)
  ) {
    return false;
  }
  return terminalReadExactFile({
    kind: "retained-regular",
    expectedProof: first,
    expectedContent: seed.recoveryBytes,
    maximumBytes: MAX_OFFLINE_RECOVERY_RECORD_BYTES,
    expectedSha256: null,
  }) !== null;
}

function terminalWriteRecoveryBackup(seed: TerminalRecoveryAuthoritySeed): boolean {
  if (
    !terminalPathIsAbsent(seed.recordPath)
    || !terminalPathIsAbsent(seed.quarantinePath)
    || !terminalDirectoryMatches(seed.stateDirectory)
  ) {
    return false;
  }
  let descriptor = -1;
  try {
    descriptor = terminalOpenSync(
      seed.quarantinePath,
      TERMINAL_O_WRONLY
        | TERMINAL_O_CREAT
        | TERMINAL_O_EXCL
        | TERMINAL_O_NOFOLLOW
        | TERMINAL_O_NONBLOCK,
      0o600,
    );
    terminalFchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < seed.recoveryBytes.length) {
      const count = terminalWriteSync(
        descriptor,
        seed.recoveryBytes.bytes,
        offset,
        seed.recoveryBytes.length - offset,
        offset,
      );
      if (count <= 0) return false;
      offset += count;
    }
    const before = terminalFstatSync(descriptor);
    if (
      (before.mode & TERMINAL_S_IFMT) !== TERMINAL_S_IFREG
      || before.uid !== seed.uid
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
      || before.size !== seed.recoveryBytes.length
    ) {
      return false;
    }
    terminalFsyncSync(descriptor);
    const after = terminalFstatSync(descriptor);
    if (!terminalStatsStable(before, after)) return false;
  } catch {
    return false;
  } finally {
    if (descriptor >= 0) {
      try {
        terminalCloseSync(descriptor);
      } catch {
        return false;
      }
    }
  }
  return terminalSyncDirectoryMatches(seed.stateDirectory)
    && terminalPathIsAbsent(seed.recordPath)
    && terminalExactAuthorityAt(seed, seed.quarantinePath);
}

function terminalRestoreRecoveryAuthority(
  seed: TerminalRecoveryAuthoritySeed,
): "record" | "backup" | "indeterminate" {
  if (terminalExactAuthorityAt(seed, seed.recordPath)) return "record";
  if (!terminalPathIsAbsent(seed.recordPath)) return "indeterminate";
  if (terminalExactAuthorityAt(seed, seed.quarantinePath)) return "backup";
  if (!terminalPathIsAbsent(seed.quarantinePath)) return "indeterminate";
  return terminalWriteRecoveryBackup(seed) ? "backup" : "indeterminate";
}

type Sha256FileStats = Readonly<{
  device: number;
  inode: number;
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
  isFile: () => boolean;
}>;

type Sha256FileDependencies = Readonly<{
  open: (path: string, flags: number) => number;
  fstat: (descriptor: number) => Sha256FileStats;
  read: (descriptor: number, maximumBytes: number) => Buffer;
  close: (descriptor: number) => void;
  nonblockingFlag?: number;
}>;

const MAX_OFFLINE_RUNTIME_BYTES = 16 * 1024 * 1024;

function readBoundedFileDescriptor(descriptor: number, maximumBytes: number): Buffer {
  const content = Buffer.alloc(maximumBytes);
  let offset = 0;
  while (offset < maximumBytes) {
    const bytesRead = readSync(
      descriptor,
      content,
      offset,
      maximumBytes - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return content.subarray(0, offset);
}

function sha256File(
  path: string,
  dependencies: Sha256FileDependencies = {
    open: openSync,
    fstat: (descriptor: number): Sha256FileStats => {
      const stats = fstatSync(descriptor);
      return {
        device: stats.dev,
        inode: stats.ino,
        size: stats.size,
        modifiedAtMs: stats.mtimeMs,
        changedAtMs: stats.ctimeMs,
        isFile: (): boolean => stats.isFile(),
      };
    },
    read: readBoundedFileDescriptor,
    close: closeSync,
    nonblockingFlag: constants.O_NONBLOCK,
  },
): string | null {
  let descriptor: number;
  try {
    const nonblocking = dependencies.nonblockingFlag ?? 0;
    descriptor = dependencies.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | nonblocking,
    );
  } catch {
    return null;
  }

  let digest: string | null = null;
  try {
    const before = dependencies.fstat(descriptor);
    if (
      before.isFile()
      && Number.isSafeInteger(before.size)
      && before.size > 0
      && before.size <= MAX_OFFLINE_RUNTIME_BYTES
    ) {
      const content = dependencies.read(descriptor, before.size + 1);
      const after = dependencies.fstat(descriptor);
      if (
        after.isFile()
        && content.byteLength === before.size
        && after.device === before.device
        && after.inode === before.inode
        && after.size === before.size
        && after.modifiedAtMs === before.modifiedAtMs
        && after.changedAtMs === before.changedAtMs
      ) {
        digest = createHash("sha256").update(content).digest("hex");
      }
    }
  } catch {
    digest = null;
  } finally {
    try {
      dependencies.close(descriptor);
    } catch {
      digest = null;
    }
  }
  return digest;
}

function offlineFingerprintsMatch(
  left: OfflineRestartFingerprint,
  right: OfflineRestartFingerprint,
): boolean {
  return left.pid === right.pid
    && left.uid === right.uid
    && left.processStartTime === right.processStartTime
    && left.execPath === right.execPath
    && left.executable === right.executable
    && offlineStringSequencesMatch(left.argv, right.argv)
    && left.launchPath === right.launchPath
    && left.entrypoint === right.entrypoint
    && left.entrypointDigest === right.entrypointDigest
    && offlineStateDirectoryProofMatches(left.stateDirectory, right.stateDirectory)
    && offlineStateFileProofMatches(left.pidFile, right.pidFile)
    && offlineStateFileProofMatches(left.tokenFile, right.tokenFile)
    && left.listenerPort === right.listenerPort
    && left.ownerId === right.ownerId;
}

function offlineRestartSignalProofsMatch(
  left: OfflineRestartSignalProof,
  right: OfflineRestartSignalProof,
): boolean {
  return offlineFingerprintsMatch(left.fingerprint, right.fingerprint)
    && offlineStringSequencesMatch(
      left.listenerSocketInodes,
      right.listenerSocketInodes,
    );
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

async function checkDaemonPublicHealthOutcome(
  port: number,
  fetchFn: typeof globalThis.fetch,
  deadline: RequestDeadline,
): Promise<PublicHealthOutcome> {
  let receivedResponse = false;
  try {
    const health = await runWithDeadline(
      async (signal: AbortSignal): Promise<HealthResponse | null> => {
        const response = await fetchFn(`http://127.0.0.1:${port}/health`, { signal });
        receivedResponse = true;
        if (!response.ok && response.status !== 503) return null;
        const body = await response.json() as unknown;
        if (
          typeof body !== "object"
          || body === null
          || typeof (body as HealthResponse).status !== "string"
        ) {
          return null;
        }
        return { ...(body as HealthResponse), httpStatus: response.status };
      },
      deadline,
    );
    return { kind: "response", health };
  } catch {
    return receivedResponse
      ? { kind: "response", health: null }
      : { kind: "no-response" };
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
  validateEvidence?: () => boolean,
): Promise<HealthResponse | null> {
  if (validateEvidence !== undefined && !validateEvidence()) return null;
  const token = readToken(tokenPath);
  if (!token) return null;
  if (validateEvidence !== undefined && !validateEvidence()) return null;
  const healthDeadline = remainingDeadline();
  if (!healthDeadline) return null;
  const authenticatedHealth = await checkDaemonHealth(port, fetchFn, healthDeadline, token);
  if (validateEvidence !== undefined && !validateEvidence()) return null;
  if (
    !isRecognizedDaemonHealth(authenticatedHealth)
    || !sameHealthIdentity(publicHealth, authenticatedHealth)
  ) {
    return null;
  }
  const accessDeadline = remainingDeadline();
  if (!accessDeadline) return null;
  const accessible = await checkDaemonAccess(
    port,
    token,
    fetchFn,
    accessDeadline,
    expectedStorageBackend,
  );
  if (validateEvidence !== undefined && !validateEvidence()) return null;
  return accessible ? authenticatedHealth : null;
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

function systemdCredentialSourceDisposal(
  credentialDir: string,
  testScope?: DaemonLifecycleTestScope,
): () => void {
  return () => {
    if (testScope && !lifecycleScopeFilesystemIsCurrent(testScope)) {
      throw new LifecycleTestScopeStateError(
        "refusing credential-source disposal through a changed lifecycle test root",
      );
    }
    rmSync(credentialDir, { recursive: true, force: true });
    try {
      lstatSync(credentialDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error("systemd credential source remained after disposal");
  };
}

function systemdDaemonCredentialArgs(
  env: NodeJS.ProcessEnv,
  testScope?: DaemonLifecycleTestScope,
  hermeticSeams?: DaemonLifecycleHermeticTestSeams,
): {
  args: string[];
  names: string[];
  cleanup?: CleanupFn;
  dispose?: CleanupFn;
} {
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
      dispose: systemdCredentialSourceDisposal(createdCredentialDir, testScope),
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
  validateBeforeSpawn?: () => boolean,
): Promise<{
  ok: boolean;
  authorizationRefused?: boolean;
  warning?: string;
  cleanup?: CleanupFn;
  disposeCredentialSources?: CleanupFn;
  unitName: string;
}> {
  const testScope = opts._testScope;
  const hermeticSeams = opts._hermeticTestSeams;
  const lifecycleEnv = dependencies.environment;
  const spawnSyncImpl = dependencies.spawnSync;
  const unit = lifecycleUnitName(opts, process.pid, Date.now());
  const recoveryAuthorized = validateBeforeSpawn !== undefined;
  let credentials: {
    args: string[];
    names: string[];
    cleanup?: CleanupFn;
    dispose?: CleanupFn;
  };
  try {
    credentials = systemdDaemonCredentialArgs(lifecycleEnv, testScope, hermeticSeams);
  } catch (err) {
    const detail = summarizeProcessDiagnostic("credential setup error", err);
    return {
      ok: false,
      ...(recoveryAuthorized ? { authorizationRefused: true } : {}),
      warning: recoveryAuthorized
        ? `user systemd credential setup failed (${detail}); authorized recovery preserved without fallback`
        : `user systemd credential setup failed (${detail}); used detached spawn fallback; daemon parent invariant is not satisfied`,
      unitName: unit,
    };
  }
  let credentialSourcesDisposed = false;
  const disposeCredentialSources = async (): Promise<void> => {
    if (credentialSourcesDisposed) return;
    if (credentials.dispose) await credentials.dispose();
    credentialSourcesDisposed = true;
  };
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
  const systemdArgs = [
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
  ];
  if (validateBeforeSpawn !== undefined) {
    let authorized = false;
    try {
      authorized = validateBeforeSpawn();
    } catch {
      authorized = false;
    }
    if (!authorized) {
      return {
        ok: false,
        authorizationRefused: true,
        warning: "daemon restart recovery authorization changed before systemd startup",
        disposeCredentialSources,
        unitName: unit,
      };
    }
  }
  let result: ReturnType<typeof spawnSyncImpl>;
  try {
    result = spawnSyncImpl("systemd-run", systemdArgs, {
      encoding: "utf-8",
      env: systemdManagerProcessEnv(lifecycleEnv, testScope),
      timeout: Math.max(1, opts.spawnTimeoutMs),
    });
  } catch (err) {
    if (!recoveryAuthorized) await cleanup();
    const detail = summarizeProcessDiagnostic("systemd start exception", err);
    return {
      ok: false,
      ...(recoveryAuthorized ? { authorizationRefused: true } : {}),
      warning: recoveryAuthorized
        ? `user systemd start was ambiguous (${detail}); authorized recovery preserved without fallback`
        : `user systemd start failed (${detail}); used detached spawn fallback; daemon parent invariant is not satisfied`,
      cleanup,
      disposeCredentialSources,
      unitName: unit,
    };
  }

  if (result.status === 0) {
    return { ok: true, cleanup, disposeCredentialSources, unitName: unit };
  }
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
    ...(recoveryAuthorized ? { authorizationRefused: true } : {}),
    warning: recoveryAuthorized
      ? `user systemd start failed (${detail}); authorized recovery preserved without fallback`
      : `user systemd start failed (${detail}); used detached spawn fallback; daemon parent invariant is not satisfied`,
    cleanup,
    disposeCredentialSources,
    unitName: unit,
  };
}

async function ensureDaemonImpl(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
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
  const dependencies = resolveLifecycleDependencies(opts);
  const scopedState = testScope
    ? { scope: testScope, pidPath: opts.pidFilePath, tokenPath }
    : hermeticSeams
      ? { hermeticSeams, pidPath: opts.pidFilePath, tokenPath }
      : undefined;
  const {
    recordPath: offlineRecoveryRecordPath,
    quarantinePath: offlineRecoveryQuarantinePath,
  } = offlineRecoveryPaths(opts.pidFilePath);
  const recoveryAuthorization = offlineRecoveryEnsureAuthorizations.get(opts);
  offlineRecoveryEnsureAuthorizations.delete(opts);
  if (recoveryAuthorization !== undefined) {
    const recoveryAuthorized = recoveryAuthorization.abortSignal?.aborted !== true
      && recoveryAuthorization.recordProof.path === offlineRecoveryRecordPath
      && recoveryAuthorization.stateDirectory.path === dirname(opts.pidFilePath)
      && recoveryAuthorization.stoppedFingerprint.pidFile.path === opts.pidFilePath
      && recoveryAuthorization.validateStopped();
    if (!recoveryAuthorized) {
      return {
        connected: false,
        port: opts.port,
        spawned: false,
        warning: `daemon restart recovery authorization changed at ${offlineRecoveryRecordPath}; no cleanup or replacement was attempted`,
      };
    }
  } else if (
    offlineRecoveryLeafIsPresent(offlineRecoveryRecordPath)
    || offlineRecoveryLeafIsPresent(offlineRecoveryQuarantinePath)
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: `daemon restart recovery is unresolved at ${offlineRecoveryRecordPath}; run lcm daemon restart to reconcile it and do not delete recovery evidence manually`,
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
  if (recoveryAuthorization !== undefined && !recoveryAuthorization.validateStopped()) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon restart recovery authorization changed immediately before replacement startup",
    };
  }
  type OrdinaryPidOperations = Readonly<{
    readOwnedPid: () => number | null;
    cleanOwnedPid: () => void;
  }>;
  type LifecycleMode =
    | Readonly<{ kind: "ordinary"; operations: OrdinaryPidOperations }>
    | Readonly<{
      kind: "authorized";
      authorization: OfflineRecoveryEnsureAuthorization;
    }>;
  const lifecycleMode: LifecycleMode = recoveryAuthorization === undefined
    ? Object.freeze({
        kind: "ordinary",
        operations: Object.freeze({
          readOwnedPid: (): number | null => readPidFile(opts.pidFilePath, scopedState),
          cleanOwnedPid: (): void => cleanStalePid(opts.pidFilePath, scopedState),
        }),
      })
    : Object.freeze({ kind: "authorized", authorization: recoveryAuthorization });
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
  const windowsPowerShellPath = opts._windowsPowerShellPathOverride === undefined
    ? resolveWindowsPowerShellPath(
        dependencies.environment.SystemRoot,
        dependencies.environment.WINDIR,
      )
    : opts._windowsPowerShellPathOverride;
  let restartedForParent = false;
  let retainedRecoveryCandidate: OfflineRecoveryAuthorizedCandidateProof | undefined;
  let retainedRecoveryPublicationParent: ParentInspection | null | undefined;

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

  function endpointIdentityMatches(
    operations: OrdinaryPidOperations,
    health: HealthResponse | null,
  ): boolean {
    if (!isRecognizedDaemonHealth(health) || health?.pid === undefined) return false;
    if (expectedOwnerId !== undefined && health.ownerId !== expectedOwnerId) return false;
    const pid = operations.readOwnedPid();
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

  function ownedPidIsLiveLikelyDaemon(
    operations: OrdinaryPidOperations,
    pid: number,
  ): boolean {
    return operations.readOwnedPid() === pid
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
    operations: OrdinaryPidOperations,
    pid: number,
    expectedToOwnListener: boolean,
  ): boolean {
    if (
      !ownedPidIsLiveLikelyDaemon(operations, pid)
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
      && ownedPidIsLiveLikelyDaemon(operations, pid);
  }

  function preserveBusyOwnedDaemon(
    operations: OrdinaryPidOperations,
    pid: number,
  ): EnsureDaemonResult | null {
    if (!ownedPidConfiguredListenerStateMatches(operations, pid, true)) {
      return null;
    }
    // Revalidate the exact PID, process identity, and listener immediately
    // before returning. Health may have been unavailable long enough for a
    // concurrent lifecycle operation to replace any one of them.
    if (!ownedPidConfiguredListenerStateMatches(operations, pid, true)) {
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

  function inspectOrdinaryParent(
    operations: OrdinaryPidOperations,
  ): ParentInspection {
    return inspectDaemonParent(opts.pidFilePath, {
      procRoot,
      uid: dependencies.uid,
      isAlive,
    }, operations.readOwnedPid);
  }

  function findAuthorizedUserSystemdPid(uid: number): number | null {
    try {
      for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[1-9]\d*$/u.test(entry.name)) continue;
        const pid = Number(entry.name);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        const status = readBoundedProcText(
          join(procRoot, entry.name, "status"),
          MAX_OFFLINE_PROC_TEXT_BYTES,
          uid,
        );
        const argv = readLinuxProcessArgv(pid, procRoot, uid);
        if (
          status !== null
          && statusUid(status) === uid
          && argv !== null
          && basename(argv[0]!) === "systemd"
          && argv.includes("--user")
        ) {
          return pid;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  function inspectAuthorizedParent(
    candidate: OfflineRecoveryAuthorizedCandidateProof,
    authorization: OfflineRecoveryEnsureAuthorization,
  ): ParentInspection {
    const fingerprint = candidate.evidence.fingerprint;
    authorization.runBoundary("before-authorized-parent-inspection");
    const birth = linuxProcessBirthState(
      fingerprint.pid,
      procRoot,
      fingerprint.processStartTime,
      fingerprint.uid,
    );
    if (birth.kind === "gone") {
      return { satisfies: false, available: false, pid: fingerprint.pid, reason: "dead-pid" };
    }
    if (birth.kind === "reused") {
      return { satisfies: false, available: false, pid: fingerprint.pid, reason: "pid-reused" };
    }
    if (birth.kind !== "exact") {
      return { satisfies: false, available: false, pid: fingerprint.pid, reason: "parent-unknown" };
    }
    const status = readBoundedProcText(
      join(procRoot, String(fingerprint.pid), "status"),
      MAX_OFFLINE_PROC_TEXT_BYTES,
      fingerprint.uid,
    );
    const parentText = status === null ? null : statusField(status, "PPid");
    if (parentText === null || !/^(?:0|[1-9]\d*)$/u.test(parentText)) {
      return { satisfies: false, available: false, pid: fingerprint.pid, reason: "parent-unknown" };
    }
    const parentPid = Number(parentText);
    if (!Number.isSafeInteger(parentPid) || parentPid < 0 || String(parentPid) !== parentText) {
      return { satisfies: false, available: false, pid: fingerprint.pid, reason: "parent-unknown" };
    }
    authorization.runBoundary("during-authorized-parent-inspection");
    const userSystemdPid = findAuthorizedUserSystemdPid(fingerprint.uid);
    if (userSystemdPid === null) {
      return {
        satisfies: false,
        available: false,
        pid: fingerprint.pid,
        parentPid,
        reason: "user-systemd-unavailable",
      };
    }
    return {
      satisfies: parentPid === userSystemdPid,
      available: true,
      pid: fingerprint.pid,
      parentPid,
      userSystemdPid,
      reason: parentPid === userSystemdPid ? undefined : "wrong-parent",
    };
  }

  function parentInspectionsMatch(left: ParentInspection, right: ParentInspection): boolean {
    return left.satisfies === right.satisfies
      && left.available === right.available
      && left.pid === right.pid
      && left.parentPid === right.parentPid
      && left.userSystemdPid === right.userSystemdPid
      && left.reason === right.reason;
  }

  function authorizedReadinessResult(
    result: EnsureDaemonResult,
  ): EnsureDaemonResult {
    const refused: EnsureDaemonResult = {
      connected: false,
      port: opts.port,
      spawned: result.spawned,
      startMethod: result.startMethod,
      warning: "daemon restart recovery authorization changed before recovery finalization",
    };
    if (
      retainedRecoveryCandidate === undefined
      || retainedRecoveryPublicationParent === undefined
      || result.connected !== true
      || result.pid !== retainedRecoveryCandidate.evidence.fingerprint.pid
      || opts._abortSignal?.aborted === true
    ) {
      return refused;
    }
    return result;
  }

  async function terminatePidFileProcess(
    operations: OrdinaryPidOperations,
  ): Promise<void> {
    const pid = operations.readOwnedPid();
    if (pid !== null && isLikelyLcmDaemonProcess(pid, procRoot)) {
      await terminatePid(pid, { isAlive, killProcess, sleepFn });
    }
    operations.cleanOwnedPid();
  }

  type MismatchRepair =
    | { outcome: "none" }
    | { outcome: "terminated" }
    | { outcome: "replacement"; pid: number }
    | { outcome: "blocked" };

  async function terminateAuthenticatedDaemon(
    operations: OrdinaryPidOperations,
    health: HealthResponse,
  ): Promise<MismatchRepair> {
    const authenticatedPid = health.pid;
    if (authenticatedPid === undefined || !endpointIdentityMatches(operations, health)) {
      return { outcome: "blocked" };
    }
    if (platform === "linux" && !isLikelyLcmDaemonProcess(authenticatedPid, procRoot)) {
      return { outcome: "blocked" };
    }
    await terminatePid(authenticatedPid, { isAlive, killProcess, sleepFn });
    if (isAlive(authenticatedPid)) return { outcome: "blocked" };
    const currentPid = operations.readOwnedPid();
    if (currentPid === authenticatedPid) {
      operations.cleanOwnedPid();
      return { outcome: "terminated" };
    }
    return currentPid === null
      ? { outcome: "terminated" }
      : { outcome: "replacement", pid: currentPid };
  }

  /** Retain legacy version repair, but never disclose the token to an unexpected public identity. */
  async function repairMismatchedDaemon(
    operations: OrdinaryPidOperations,
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
      await terminatePidFileProcess(operations);
      return { outcome: "terminated" };
    }
    if (!storageBackendMatches || !entrypointMatches || !runtimeDigestMatches) {
      if (!hasAccess) return { outcome: "blocked" };
      return terminateAuthenticatedDaemon(operations, health);
    }
    return { outcome: "none" };
  }

  async function daemonResult(
    mode: LifecycleMode,
    health: HealthResponse | null,
    spawned: boolean,
    startMethod: EnsureDaemonResult["startMethod"],
    access: { alreadyVerified: true } | { alreadyVerified: false; deadline: number },
    warning?: string,
    allowParentWarning = false,
  ): Promise<EnsureDaemonResult | null> {
    type AuthorizedCandidateContext = Readonly<{
      kind: "authorized";
      authorization: OfflineRecoveryEnsureAuthorization;
      candidate: OfflineRecoveryAuthorizedCandidateProof;
    }>;
    type CandidateContext =
      | Readonly<{ kind: "ordinary"; operations: OrdinaryPidOperations }>
      | AuthorizedCandidateContext;
    let candidateContext: CandidateContext;
    if (mode.kind === "authorized") {
      if (!isRecognizedDaemonHealth(health) || health.pid === undefined) return null;
      const currentCandidate = mode.authorization.captureCandidate(health.pid);
      if (
        currentCandidate === null
        || (retainedRecoveryCandidate !== undefined
          && !mode.authorization.candidateMatches(
            retainedRecoveryCandidate,
            currentCandidate,
          ))
      ) {
        return null;
      }
      retainedRecoveryCandidate ??= currentCandidate;
      candidateContext = Object.freeze({
        kind: "authorized",
        authorization: mode.authorization,
        candidate: retainedRecoveryCandidate,
      });
    } else {
      if (health === null || !endpointIdentityMatches(mode.operations, health)) return null;
      candidateContext = mode;
    }
    if (!healthVersionMatches(health, expectedVersion)) return null;
    if (!healthStorageBackendMatches(health, expectedStorageBackend)) return null;
    const recaptureAuthorizedCandidate = (
      context: AuthorizedCandidateContext,
    ): OfflineRecoveryAuthorizedCandidateProof | null => {
      const current = context.authorization.captureCandidate(
        context.candidate.evidence.fingerprint.pid,
      );
      return current !== null
        && context.authorization.candidateMatches(context.candidate, current)
        ? current
        : null;
    };
    const validateAuthorizedCandidate = (context: CandidateContext): boolean => (
      context.kind === "ordinary" || recaptureAuthorizedCandidate(context) !== null
    );
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
        candidateContext.kind === "ordinary"
          ? readOwnedToken
          : (path: string): string | null => candidateContext.authorization.readCandidateToken(
              path,
              candidateContext.candidate,
            ),
        candidateContext.kind === "ordinary"
          ? undefined
          : (): boolean => validateAuthorizedCandidate(candidateContext),
      );
      if (!authenticated) return null;
      verifiedHealth = authenticated;
    }
    if (candidateContext.kind === "authorized") {
      if (
        typeof verifiedHealth.entrypoint !== "string"
        || isVitestWorkerEntrypoint(verifiedHealth.entrypoint)
      ) {
        return null;
      }
      let authenticatedEntrypoint: string;
      try {
        authenticatedEntrypoint = realpath(verifiedHealth.entrypoint);
      } catch {
        return null;
      }
      if (authenticatedEntrypoint !== candidateContext.candidate.evidence.fingerprint.entrypoint) {
        return null;
      }
    } else if (!processEntrypointMatches(
      verifiedHealth,
      expectedEntrypoint,
      platform,
      procRoot,
      realpath,
    )) {
      return null;
    }
    if (!healthRuntimeDigestMatches(verifiedHealth, expectedRuntimeDigest)) return null;
    if (!validateAuthorizedCandidate(candidateContext)) return null;

    let parent: ParentInspection | undefined;
    if (enforceParent) {
      parent = candidateContext.kind === "authorized"
        ? inspectAuthorizedParent(
            candidateContext.candidate,
            candidateContext.authorization,
          )
        : inspectOrdinaryParent(candidateContext.operations);
      if (
        candidateContext.kind === "authorized"
        && parent.reason !== undefined
        && parent.reason !== "user-systemd-unavailable"
        && parent.reason !== "wrong-parent"
      ) {
        return null;
      }
      if (
        candidateContext.kind === "authorized"
        && recaptureAuthorizedCandidate(candidateContext) === null
      ) {
        return null;
      }
      if (!parent.satisfies) {
        if (!parent.available || allowParentWarning) {
          if (
            candidateContext.kind === "ordinary"
            && (parent.reason === "dead-pid" || parent.reason === "pid-not-lcm-daemon")
          ) {
            candidateContext.operations.cleanOwnedPid();
          }
          if (candidateContext.kind === "authorized") {
            candidateContext.authorization.runBoundary(
              "before-authorized-connected-publication",
            );
            const publicationParent = inspectAuthorizedParent(
              candidateContext.candidate,
              candidateContext.authorization,
            );
            if (
              !parentInspectionsMatch(parent, publicationParent)
              || recaptureAuthorizedCandidate(candidateContext) === null
            ) {
              return null;
            }
            retainedRecoveryPublicationParent = parent;
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

    if (candidateContext.kind === "authorized") {
      candidateContext.authorization.runBoundary("before-authorized-connected-publication");
      if (parent !== undefined) {
        const publicationParent = inspectAuthorizedParent(
          candidateContext.candidate,
          candidateContext.authorization,
        );
        if (!parentInspectionsMatch(parent, publicationParent)) return null;
      }
      if (recaptureAuthorizedCandidate(candidateContext) === null) return null;
      retainedRecoveryPublicationParent = parent ?? null;
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

  async function waitForConcurrentReplacement(
    operations: OrdinaryPidOperations,
    pid: number,
  ): Promise<EnsureDaemonResult> {
    const mode: LifecycleMode = Object.freeze({ kind: "ordinary", operations });
    while (operations.readOwnedPid() === pid && isAlive(pid)) {
      const healthDeadline = remainingRequestDeadline();
      if (!healthDeadline) break;
      const replacementHealth = await checkDaemonHealth(opts.port, fetchFn, healthDeadline);
      const accepted = await daemonResult(
        mode,
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

  if (lifecycleMode.kind === "ordinary") {
    const ordinaryOperations = lifecycleMode.operations;
    let concurrentReplacementPid: number | undefined;

  // Step 1: Check if daemon is already running via health check
  const initialHealthDeadline = remainingRequestDeadline();
  const health = initialHealthDeadline
    ? await checkDaemonHealth(opts.port, fetchFn, initialHealthDeadline)
    : null;
  if (isRecognizedDaemonHealth(health)) {
    const identityMatches = endpointIdentityMatches(ordinaryOperations, health);
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
      ordinaryOperations,
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
        const accepted = await daemonResult(
          lifecycleMode,
          authenticatedHealth,
          false,
          "existing",
          { alreadyVerified: true },
        );
        if (accepted) return accepted;
        // A null result here can only be the verified wrong-parent case: health,
        // access, and version were already accepted, while unavailable identity
        // metadata returns a connected result with a warning.
        const parent = inspectOrdinaryParent(ordinaryOperations);
        // Revalidate the authenticated endpoint and PID immediately before a
        // signal; concurrent lifecycle operations may have replaced either.
        if (endpointIdentityMatches(ordinaryOperations, health)
          && parent.available
          && parent.pid !== undefined
          && authenticatedHealth.pid !== undefined
          && parent.pid === authenticatedHealth.pid
          && isLikelyLcmDaemonProcess(parent.pid, procRoot)) {
          await terminatePid(parent.pid, { isAlive, killProcess, sleepFn });
          restartedForParent = true;
        }
      }
      ordinaryOperations.cleanOwnedPid();
    }
  }

  // Step 2: Check PID file for stale process
    if (concurrentReplacementPid !== undefined) {
      return waitForConcurrentReplacement(ordinaryOperations, concurrentReplacementPid);
    }
  const pidFilePid = (
    scopedState && "scope" in scopedState
      ? true
      : existsSync(opts.pidFilePath)
  )
    ? ordinaryOperations.readOwnedPid()
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
          const retryIdentityMatches = endpointIdentityMatches(ordinaryOperations, retry);
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
            ordinaryOperations.cleanOwnedPid();
            return {
              connected: false,
              port: opts.port,
              spawned: false,
              warning: mismatchAuthWarning(retryStorageBackendMatches),
            };
          }
          const mismatchRepair = await repairMismatchedDaemon(
            ordinaryOperations,
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
            return waitForConcurrentReplacement(ordinaryOperations, mismatchRepair.pid);
          }
          repairedMismatch = mismatchRepair.outcome === "terminated";
          if (mismatchRepair.outcome === "none" && authenticatedRetry) {
            const accepted = await daemonResult(
              lifecycleMode,
              authenticatedRetry,
              false,
              "existing",
              { alreadyVerified: true },
            );
            if (accepted) {
              return accepted;
            }
          }
        }
        if (!isRecognizedDaemonHealth(retry) && !opts._abortSignal?.aborted) {
          const preserved = preserveBusyOwnedDaemon(ordinaryOperations, pid);
          if (preserved) return preserved;
          const replacementPid = ordinaryOperations.readOwnedPid();
          if (replacementPid !== null && replacementPid !== pid) {
            return waitForConcurrentReplacement(ordinaryOperations, replacementPid);
          }
        }
        if (enforceParent && !repairedMismatch) {
          const parent = inspectOrdinaryParent(ordinaryOperations);
          const signalStateMatches = isRecognizedDaemonHealth(retry)
            ? ownedPidConfiguredListenerStateMatches(ordinaryOperations, pid, true)
            : opts._abortSignal?.aborted
              ? ownedPidIsLiveLikelyDaemon(ordinaryOperations, pid)
              : ownedPidConfiguredListenerStateMatches(ordinaryOperations, pid, false);
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
      const currentPid = ordinaryOperations.readOwnedPid();
      if (currentPid !== null && currentPid !== pidFilePid) {
        return waitForConcurrentReplacement(ordinaryOperations, currentPid);
      }
      ordinaryOperations.cleanOwnedPid();
    }
    }
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

  if (
    lifecycleMode.kind === "authorized"
    && !lifecycleMode.authorization.validateStopped()
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      warning: "daemon restart recovery authorization changed at the final spawn boundary",
    };
  }

  // Ensure auth token exists only after the daemon entrypoint is trusted.
  // Offline-restart authorization already proves the exact existing token
  // leaf. Reapplying its mode here would change ctime and invalidate the
  // immutable recovery fingerprint before replacement authentication.
  if (lifecycleMode.kind === "ordinary") {
    if (scopedState) ensureScopedAuthToken(scopedState);
    else ensureAuthToken(tokenPath);
  }

  let startMethod: EnsureDaemonResult["startMethod"] = "detached-spawn";
  let warning: string | undefined;
  let detachedStart: { getWarning: () => string | undefined; pid?: number } | undefined;
  let cleanupSystemdResources: CleanupFn | undefined;
  let disposeSystemdCredentialSources: CleanupFn | undefined;

  if (enforceParent) {
    const systemdStart = await startViaUserSystemd(
      opts,
      spawnCommand,
      spawnArgs,
      dependencies,
      lifecycleMode.kind === "ordinary"
        ? undefined
        : (): boolean => {
            lifecycleMode.authorization.runBoundary("after-systemd-credential-preparation");
            return lifecycleMode.authorization.validateStopped();
          },
    );
    cleanupSystemdResources = systemdStart.cleanup;
    disposeSystemdCredentialSources = systemdStart.disposeCredentialSources;
    if (lifecycleMode.kind === "authorized" && !systemdStart.ok) {
      try {
        lifecycleMode.authorization.runBoundary(
          "before-authorized-credential-source-disposal",
        );
        await disposeSystemdCredentialSources?.();
      } catch {
        return {
          connected: false,
          port: opts.port,
          spawned: false,
          startMethod: "systemd-user",
          warning: "authorized systemd credential-source cleanup failed; recovery evidence was preserved",
        };
      }
      return {
        connected: false,
        port: opts.port,
        spawned: false,
        startMethod: "systemd-user",
        warning: systemdStart.warning,
      };
    }
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
      if (lifecycleMode.kind === "authorized") {
        lifecycleMode.authorization.runBoundary(
          "before-authorized-credential-source-disposal",
        );
        if (disposeSystemdCredentialSources) stages.push(disposeSystemdCredentialSources);
        await runCleanupStages(stages);
        return;
      }
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
          lifecycleMode.operations.cleanOwnedPid,
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
    try {
      await cleanupOwnedLifecycle();
    } catch (error) {
      if (lifecycleMode.kind === "ordinary") throw error;
      return {
        connected: false,
        port: opts.port,
        spawned: result.spawned,
        startMethod: result.startMethod,
        warning: "authorized systemd credential-source cleanup failed; recovery evidence was preserved",
      };
    }
    if (interrupted) {
      return {
        connected: false,
        port: opts.port,
        spawned: result.spawned,
        startMethod: result.startMethod,
        warning: "daemon lifecycle was interrupted",
      };
    }
    if (lifecycleMode.kind === "authorized" && result.connected) {
      lifecycleMode.authorization.runBoundary(
        "after-authorized-cleanup-before-final-publication",
      );
      return authorizedReadinessResult(result);
    }
    return result;
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
      lifecycleMode,
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

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  return ensureDaemonImpl(opts);
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
  const hermeticOwnsRestartState = (
    seams: DaemonLifecycleHermeticTestSeams,
  ): boolean => {
    if (lifecycleHermeticSeamsOwnsExactStatePaths(
      seams,
      opts.pidFilePath,
      tokenPath,
    )) {
      return true;
    }
    const paths = offlineRecoveryPaths(opts.pidFilePath);
    if (!lifecycleHermeticSeamsOwnsExactStatePaths(
      seams,
      paths.recordPath,
      tokenPath,
    )) {
      return false;
    }
    const recovery = readOfflineRecoveryRecord(paths.recordPath, seams.uid);
    if (recovery.kind !== "valid") return false;
    const canonical = readOfflineStateFileProof(
      opts.pidFilePath,
      seams.uid,
      {
        readContent: true,
        requirePrivate: false,
        expectedLinks: 2,
        maxBytes: MAX_OFFLINE_PID_BYTES,
      },
    );
    const quarantine = readOfflineStateFileProof(
      paths.quarantinePath,
      seams.uid,
      {
        readContent: true,
        requirePrivate: false,
        expectedLinks: 2,
        maxBytes: MAX_OFFLINE_PID_BYTES,
      },
    );
    return canonical !== null
      && quarantine !== null
      && offlineStateFileProofIsLinkedQuarantineTransition(
        recovery.record.fingerprint.pidFile,
        canonical,
        quarantine,
      );
  };
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
    && !hermeticOwnsRestartState(hermeticSeams)
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
  const dependencies = resolveLifecycleDependencies(opts);
  const platform = dependencies.platform;
  const procRoot = dependencies.procRoot;
  const expectedOfflineEntrypoint = testScope?.entrypoint
    ?? opts.expectedEntrypoint
    ?? opts._packagedEntrypointOverride
    ?? PACKAGED_RUNTIME_ENTRYPOINT;
  const expectedOfflineRuntimeDigest = opts.expectedRuntimeDigest ?? RUNTIME_DIGEST;
  const currentUid = dependencies.uid
    ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const initialTerminalRootProof = captureOfflineTerminalRootProof();
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
    && !hermeticOwnsRestartState(hermeticSeams)
  ) {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle hermetic state changed during restart validation",
    };
  }

  const scopedState = testScope
    ? { scope: testScope, pidPath: opts.pidFilePath, tokenPath }
    : hermeticSeams
      ? { hermeticSeams, pidPath: opts.pidFilePath, tokenPath }
      : undefined;
  const assertCurrentScopedState = (): void => {
    if (hermeticSeams && hermeticOwnsRestartState(hermeticSeams)) return;
    if (scopedState) assertScopedStateAccess(scopedState);
  };
  assertCurrentScopedState();
  const readOwnedPid = (): number | null => readPidFile(opts.pidFilePath, scopedState);
  const cleanOwnedPid = (): void => cleanStalePid(opts.pidFilePath, scopedState);
  const readOwnedToken = (path: string): string | null => scopedState
    ? readScopedAuthToken(scopedState)
    : readAuthToken(path);
  const isAlive = dependencies.isProcessAlive;
  const fetchFn = dependencies.fetch;
  const realpath = dependencies.realpath;
  const expectedVersion = opts.expectedVersion ?? PKG_VERSION;
  const recoveryPaths = offlineRecoveryPaths(opts.pidFilePath);
  const openRecoveryRecord = opts._offlineRecordOpenOverride
    ?? ((path: string, flags: number, mode?: number): number => openSync(path, flags, mode));
  const fsyncRecovery = opts._offlineFsyncOverride ?? fsyncSync;
  const writeRecoveryRecord = opts._offlineRecordWriteOverride
    ?? ((descriptor: number, bytes: Uint8Array): number => writeSync(descriptor, bytes));

  function recoveryBoundary(boundary: string): void {
    opts._offlineRecoveryBoundaryOverride?.(boundary);
  }

  function fsyncRecoveryParent(expectedParent: OfflineStateDirectoryProof): boolean {
    let descriptor: number | undefined;
    let authenticated = false;
    try {
      const currentParent = readOfflineStateDirectoryProof(expectedParent.path, expectedParent.uid);
      if (
        currentParent === null
        || !offlineStateDirectoryProofMatches(expectedParent, currentParent)
      ) {
        return false;
      }
      descriptor = openRecoveryRecord(
        expectedParent.path,
        constants.O_RDONLY
          | constants.O_DIRECTORY
          | constants.O_NOFOLLOW
          | constants.O_NONBLOCK,
      );
      const before = fstatSync(descriptor);
      if (
        !before.isDirectory()
        || before.dev !== expectedParent.device
        || before.ino !== expectedParent.inode
        || before.mode !== expectedParent.mode
        || before.uid !== expectedParent.uid
        || before.nlink !== expectedParent.links
      ) {
        return false;
      }
      fsyncRecovery(descriptor);
      const after = fstatSync(descriptor);
      const parentAfterFsync = readOfflineStateDirectoryProof(
        expectedParent.path,
        expectedParent.uid,
      );
      authenticated = after.isDirectory()
        && before.dev === after.dev
        && before.ino === after.ino
        && before.mode === after.mode
        && before.uid === after.uid
        && before.nlink === after.nlink
        && parentAfterFsync !== null
        && offlineStateDirectoryProofMatches(expectedParent, parentAfterFsync)
        && after.dev === parentAfterFsync.device
        && after.ino === parentAfterFsync.inode
        && after.mode === parentAfterFsync.mode
        && after.uid === parentAfterFsync.uid
        && after.nlink === parentAfterFsync.links;
    } catch {
      authenticated = false;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          authenticated = false;
        }
      }
    }
    return authenticated;
  }

  function writeExactRecoveryRecordLeaf(
    path: string,
    bytes: string,
    fingerprint: OfflineRestartFingerprint,
  ): (OfflineRecoveryRecordRead & { kind: "valid" }) | null {
    const encoded = Buffer.from(bytes, "utf8");
    if (
      encoded.byteLength <= 0
      || encoded.byteLength > MAX_OFFLINE_RECOVERY_RECORD_BYTES
      || offlineRecoveryLeafIsPresent(path)
    ) {
      return null;
    }
    const parentBefore = readOfflineStateDirectoryProof(
      fingerprint.stateDirectory.path,
      fingerprint.uid,
    );
    if (
      parentBefore === null
      || !offlineStateDirectoryProofMatches(fingerprint.stateDirectory, parentBefore)
    ) {
      return null;
    }
    let descriptor: number | undefined;
    let writtenAndSynced = false;
    try {
      descriptor = openRecoveryRecord(
        path,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW
          | constants.O_NONBLOCK,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      let offset = 0;
      while (offset < encoded.byteLength) {
        const written = writeRecoveryRecord(descriptor, encoded.subarray(offset));
        if (!Number.isSafeInteger(written) || written <= 0) {
          throw new Error("short recovery write");
        }
        offset += written;
      }
      const beforeFsync = fstatSync(descriptor);
      if (
        !beforeFsync.isFile()
        || beforeFsync.uid !== fingerprint.uid
        || beforeFsync.nlink !== 1
        || (beforeFsync.mode & 0o777) !== 0o600
        || beforeFsync.size !== encoded.byteLength
      ) {
        throw new Error("untrusted recovery descriptor");
      }
      fsyncRecovery(descriptor);
      const afterFsync = fstatSync(descriptor);
      writtenAndSynced = stableDescriptorMetadataMatches(beforeFsync, afterFsync);
    } catch {
      writtenAndSynced = false;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          writtenAndSynced = false;
        }
      }
    }
    if (!writtenAndSynced || !fsyncRecoveryParent(fingerprint.stateDirectory)) return null;
    const reopened = readOfflineRecoveryRecordMatchingBytes(path, fingerprint.uid, bytes);
    const parentAfter = readOfflineStateDirectoryProof(
      fingerprint.stateDirectory.path,
      fingerprint.uid,
    );
    return reopened !== null
      && parentAfter !== null
      && offlineStateDirectoryProofMatches(fingerprint.stateDirectory, parentAfter)
      ? reopened
      : null;
  }

  function heldOfflineLeafProofToUnlink(
    expected: OfflineContentStateFileProof,
    parent: OfflineStateDirectoryProof,
  ): HeldOfflineUnlinkResult {
    const path = expected.path;
    const procSelfFdRoot = opts._offlineProcSelfFdRootOverride ?? "/proc/self/fd";
    let parentDescriptor: number | undefined;
    let targetDescriptor: number | undefined;
    let canonicalParentDescriptor: number | undefined;
    let unlinked = false;
    let unlinkCommitProofComplete = false;
    let result: HeldOfflineUnlinkResult = {
      kind: "refused",
      reason: "anchored unlink proof failed before the syscall",
    };
    try {
      parentDescriptor = openSync(
        parent.path,
        constants.O_RDONLY
          | constants.O_DIRECTORY
          | constants.O_NOFOLLOW
          | constants.O_NONBLOCK,
      );
      const parentBefore = fstatSync(parentDescriptor, { bigint: true });
      if (
        !parentBefore.isDirectory()
        || parentBefore.dev !== BigInt(parent.device)
        || parentBefore.ino !== BigInt(parent.inode)
        || parentBefore.mode !== BigInt(parent.mode)
        || parentBefore.uid !== BigInt(parent.uid)
        || parentBefore.nlink !== BigInt(parent.links)
      ) {
        throw new Error("held parent proof mismatch");
      }
      const anchoredParent = join(procSelfFdRoot, String(parentDescriptor));
      if (realpathSync(anchoredParent) !== parent.path) {
        throw new Error("procfd parent anchor mismatch");
      }
      const anchoredPath = join(anchoredParent, basename(path));
      targetDescriptor = openSync(
        anchoredPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const bounded = readStableBoundedOpenDescriptor(
        targetDescriptor,
        expected.size,
        false,
        true,
      );
      const targetBefore = fstatSync(targetDescriptor, { bigint: true });
      if (
        bounded.kind !== "valid"
        || bounded.content.toString("utf8") !== expected.content
        || !offlineStateFileProofMatches(expected, Object.freeze({
          path,
          device: bounded.before.dev,
          inode: bounded.before.ino,
          mode: bounded.before.mode,
          uid: bounded.before.uid,
          links: bounded.before.nlink,
          size: bounded.before.size,
          modifiedAtMs: bounded.before.mtimeMs,
          changedAtMs: bounded.before.ctimeMs,
          content: bounded.content.toString("utf8"),
        }))
        || !targetBefore.isFile()
        || targetBefore.dev !== BigInt(expected.device)
        || targetBefore.ino !== BigInt(expected.inode)
        || targetBefore.mode !== BigInt(expected.mode)
        || targetBefore.uid !== BigInt(expected.uid)
        || targetBefore.nlink !== 1n
        || targetBefore.size !== BigInt(expected.size)
      ) {
        throw new Error("held target proof mismatch");
      }

      // No injected callback, awaited work, or unanchored pathname operation
      // is permitted between the held-leaf proof and this syscall.
      unlinkSync(anchoredPath);
      unlinked = true;
      const targetAfter = fstatSync(targetDescriptor, { bigint: true });
      if (
        targetAfter.dev !== targetBefore.dev
        || targetAfter.ino !== targetBefore.ino
        || targetAfter.nlink !== 0n
      ) {
        result = {
          kind: "unlinked-uncommitted",
          reason: "the held leaf could not prove same-inode link count zero",
        };
        throw new Error("held target post-unlink mismatch");
      }
      let anchoredLeafIsAbsent = false;
      try {
        lstatSync(anchoredPath);
      } catch (error) {
        anchoredLeafIsAbsent = (error as NodeJS.ErrnoException).code === "ENOENT";
      }
      if (!anchoredLeafIsAbsent) {
        result = {
          kind: "unlinked-uncommitted",
          reason: "anchored leaf absence could not be proved",
        };
        throw new Error("anchored leaf remained after unlink");
      }
      unlinkCommitProofComplete = true;

      try {
        fsyncRecovery(parentDescriptor);
      } catch {
        result = {
          kind: "unlinked-undurable",
          reason: "parent directory fsync failed after exact unlink",
        };
        throw new Error("held parent fsync failed");
      }
      const parentAfter = fstatSync(parentDescriptor, { bigint: true });
      if (
        !parentAfter.isDirectory()
        || parentAfter.dev !== parentBefore.dev
        || parentAfter.ino !== parentBefore.ino
        || parentAfter.mode !== parentBefore.mode
        || parentAfter.uid !== parentBefore.uid
        || parentAfter.nlink !== parentBefore.nlink
        || realpathSync(anchoredParent) !== parent.path
      ) {
        result = {
          kind: "unlinked-undurable",
          reason: "held parent identity changed after exact unlink",
        };
        throw new Error("held parent identity changed");
      }
      canonicalParentDescriptor = openSync(
        parent.path,
        constants.O_RDONLY
          | constants.O_DIRECTORY
          | constants.O_NOFOLLOW
          | constants.O_NONBLOCK,
      );
      const canonicalParent = fstatSync(canonicalParentDescriptor, { bigint: true });
      if (
        !canonicalParent.isDirectory()
        || canonicalParent.dev !== parentAfter.dev
        || canonicalParent.ino !== parentAfter.ino
        || canonicalParent.mode !== parentAfter.mode
        || canonicalParent.uid !== parentAfter.uid
        || canonicalParent.nlink !== parentAfter.nlink
      ) {
        result = {
          kind: "unlinked-undurable",
          reason: "canonical parent no longer names the held directory",
        };
        throw new Error("canonical parent identity changed");
      }
      result = { kind: "durable" };
    } catch {
      if (unlinked && result.kind === "refused") {
        result = unlinkCommitProofComplete
          ? { kind: "unlinked-undurable", reason: "anchored unlink durability proof failed" }
          : { kind: "unlinked-uncommitted", reason: "anchored unlink commit proof failed" };
      } else if (!unlinked) {
        result = { kind: "refused", reason: "anchored unlink proof failed before the syscall" };
      }
    } finally {
      for (const descriptor of [canonicalParentDescriptor, targetDescriptor, parentDescriptor]) {
        if (descriptor === undefined) continue;
        try {
          closeSync(descriptor);
        } catch {
          result = unlinked
            ? unlinkCommitProofComplete
              ? { kind: "unlinked-undurable", reason: "held unlink descriptor close failed" }
              : { kind: "unlinked-uncommitted", reason: "held unlink descriptor close failed" }
            : { kind: "refused", reason: "held unlink descriptor close failed" };
        }
      }
    }
    return result;
  }

  function transitionOfflinePidToQuarantine(
    expected: OfflineContentStateFileProof,
    parent: OfflineStateDirectoryProof,
    resumeLinkedTransition: boolean,
  ): OfflinePidQuarantineTransitionResult {
    const procSelfFdRoot = opts._offlineProcSelfFdRootOverride ?? "/proc/self/fd";
    const quarantinePath = recoveryPaths.quarantinePath;
    let parentDescriptor: number | undefined;
    let sourceDescriptor: number | undefined;
    let quarantineDescriptor: number | undefined;
    let canonicalParentDescriptor: number | undefined;
    let linkCreated = resumeLinkedTransition;
    let sourceUnlinked = false;
    let result: OfflinePidQuarantineTransitionResult = {
      kind: "refused",
      reason: "daemon PID quarantine transition could not be authenticated",
    };
    try {
      parentDescriptor = openSync(
        parent.path,
        constants.O_RDONLY
          | constants.O_DIRECTORY
          | constants.O_NOFOLLOW
          | constants.O_NONBLOCK,
      );
      const parentBefore = fstatSync(parentDescriptor, { bigint: true });
      if (
        !parentBefore.isDirectory()
        || parentBefore.dev !== BigInt(parent.device)
        || parentBefore.ino !== BigInt(parent.inode)
        || parentBefore.mode !== BigInt(parent.mode)
        || parentBefore.uid !== BigInt(parent.uid)
        || parentBefore.nlink !== BigInt(parent.links)
      ) {
        throw new Error("PID quarantine parent proof mismatch");
      }
      const anchoredParent = join(procSelfFdRoot, String(parentDescriptor));
      if (realpathSync(anchoredParent) !== parent.path) {
        throw new Error("PID quarantine parent anchor mismatch");
      }
      const anchoredSource = join(anchoredParent, basename(expected.path));
      const anchoredQuarantine = join(anchoredParent, basename(quarantinePath));
      sourceDescriptor = openSync(
        anchoredSource,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const sourceRead = readStableBoundedOpenDescriptor(
        sourceDescriptor,
        expected.size,
        false,
        true,
      );
      if (sourceRead.kind !== "valid") {
        throw new Error("PID quarantine source is unreadable");
      }
      const sourceBefore = Object.freeze({
        path: expected.path,
        device: sourceRead.before.dev,
        inode: sourceRead.before.ino,
        mode: sourceRead.before.mode,
        uid: sourceRead.before.uid,
        links: sourceRead.before.nlink,
        size: sourceRead.before.size,
        modifiedAtMs: sourceRead.before.mtimeMs,
        changedAtMs: sourceRead.before.ctimeMs,
        content: sourceRead.content.toString("utf8"),
      });
      if (resumeLinkedTransition) {
        const existingQuarantine = readOfflineStateFileProof(
          quarantinePath,
          expected.uid,
          {
            readContent: true,
            requirePrivate: false,
            expectedLinks: 2,
            maxBytes: MAX_OFFLINE_PID_BYTES,
          },
        );
        if (
          existingQuarantine === null
          || !offlineStateFileProofIsLinkedQuarantineTransition(
            expected,
            sourceBefore,
            existingQuarantine,
          )
        ) {
          throw new Error("incomplete PID quarantine transition changed");
        }
      } else {
        if (!offlineStateFileProofMatches(expected, sourceBefore)) {
          throw new Error("PID quarantine source proof mismatch");
        }
        let quarantineAbsent = false;
        try {
          lstatSync(anchoredQuarantine);
        } catch (error) {
          quarantineAbsent = (error as NodeJS.ErrnoException).code === "ENOENT";
        }
        if (!quarantineAbsent || opts._abortSignal?.aborted) {
          return opts._abortSignal?.aborted
            ? {
                kind: "interrupted",
                reason: `PID quarantine transition retained canonical evidence at ${expected.path}`,
              }
            : {
                kind: "refused",
                reason: "deterministic offline PID quarantine already exists",
              };
        }
        linkSync(anchoredSource, anchoredQuarantine);
        linkCreated = true;
        if (opts._abortSignal?.aborted) {
          return {
            kind: "interrupted",
            reason: `PID quarantine transition retained both exact references at ${expected.path} and ${quarantinePath}`,
          };
        }
        recoveryBoundary("after-pid-quarantine-link");
        if (opts._abortSignal?.aborted) {
          return {
            kind: "interrupted",
            reason: `PID quarantine transition retained both exact references at ${expected.path} and ${quarantinePath}`,
          };
        }
      }

      if (opts._abortSignal?.aborted) {
        return {
          kind: "interrupted",
          reason: `PID quarantine transition retained both exact references at ${expected.path} and ${quarantinePath}`,
        };
      }

      closeSync(sourceDescriptor);
      sourceDescriptor = undefined;
      sourceDescriptor = openSync(
        anchoredSource,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      quarantineDescriptor = openSync(
        anchoredQuarantine,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const sourceLinkedRead = readStableBoundedOpenDescriptor(
        sourceDescriptor,
        expected.size,
        false,
        true,
      );
      const quarantineLinkedRead = readStableBoundedOpenDescriptor(
        quarantineDescriptor,
        expected.size,
        false,
        true,
      );
      if (
        sourceLinkedRead.kind !== "valid"
        || quarantineLinkedRead.kind !== "valid"
      ) {
        throw new Error("linked PID quarantine evidence is unreadable");
      }
      const canonicalLinked = Object.freeze({
        path: expected.path,
        device: sourceLinkedRead.before.dev,
        inode: sourceLinkedRead.before.ino,
        mode: sourceLinkedRead.before.mode,
        uid: sourceLinkedRead.before.uid,
        links: sourceLinkedRead.before.nlink,
        size: sourceLinkedRead.before.size,
        modifiedAtMs: sourceLinkedRead.before.mtimeMs,
        changedAtMs: sourceLinkedRead.before.ctimeMs,
        content: sourceLinkedRead.content.toString("utf8"),
      });
      const quarantineLinked = Object.freeze({
        path: quarantinePath,
        device: quarantineLinkedRead.before.dev,
        inode: quarantineLinkedRead.before.ino,
        mode: quarantineLinkedRead.before.mode,
        uid: quarantineLinkedRead.before.uid,
        links: quarantineLinkedRead.before.nlink,
        size: quarantineLinkedRead.before.size,
        modifiedAtMs: quarantineLinkedRead.before.mtimeMs,
        changedAtMs: quarantineLinkedRead.before.ctimeMs,
        content: quarantineLinkedRead.content.toString("utf8"),
      });
      if (
        !offlineStateFileProofIsLinkedQuarantineTransition(
          expected,
          canonicalLinked,
          quarantineLinked,
        )
        || opts._abortSignal?.aborted
      ) {
        return opts._abortSignal?.aborted
          ? {
              kind: "interrupted",
              reason: `PID quarantine transition retained both exact references at ${expected.path} and ${quarantinePath}`,
            }
          : {
              kind: "refused",
              reason: `daemon PID state changed during quarantine linking; preserve ${expected.path} and ${quarantinePath}`,
            };
      }

      // No callback, await, or unanchored lookup may occur between this exact
      // two-link proof and removing the held canonical source reference.
      try {
        unlinkSync(anchoredSource);
      } catch {
        return {
          kind: "refused",
          reason: `canonical PID cleanup failed; exact two-link evidence retained at ${expected.path} and ${quarantinePath}`,
        };
      }
      sourceUnlinked = true;
      const sourceAfter = fstatSync(sourceDescriptor, { bigint: true });
      const quarantineAfter = fstatSync(quarantineDescriptor, { bigint: true });
      if (
        sourceAfter.dev !== BigInt(expected.device)
        || sourceAfter.ino !== BigInt(expected.inode)
        || sourceAfter.nlink !== 1n
        || quarantineAfter.dev !== sourceAfter.dev
        || quarantineAfter.ino !== sourceAfter.ino
        || quarantineAfter.nlink !== 1n
      ) {
        throw new Error("PID quarantine unlink proof mismatch");
      }
      let canonicalAbsent = false;
      try {
        lstatSync(anchoredSource);
      } catch (error) {
        canonicalAbsent = (error as NodeJS.ErrnoException).code === "ENOENT";
      }
      if (!canonicalAbsent) throw new Error("canonical PID leaf remained after unlink");
      fsyncRecovery(parentDescriptor);
      const parentAfter = fstatSync(parentDescriptor, { bigint: true });
      if (
        !parentAfter.isDirectory()
        || parentAfter.dev !== parentBefore.dev
        || parentAfter.ino !== parentBefore.ino
        || parentAfter.mode !== parentBefore.mode
        || parentAfter.uid !== parentBefore.uid
        || parentAfter.nlink !== parentBefore.nlink
        || realpathSync(anchoredParent) !== parent.path
      ) {
        throw new Error("PID quarantine parent changed after unlink");
      }
      canonicalParentDescriptor = openSync(
        parent.path,
        constants.O_RDONLY
          | constants.O_DIRECTORY
          | constants.O_NOFOLLOW
          | constants.O_NONBLOCK,
      );
      const canonicalParent = fstatSync(canonicalParentDescriptor, { bigint: true });
      if (
        !canonicalParent.isDirectory()
        || canonicalParent.dev !== parentAfter.dev
        || canonicalParent.ino !== parentAfter.ino
        || canonicalParent.mode !== parentAfter.mode
        || canonicalParent.uid !== parentAfter.uid
        || canonicalParent.nlink !== parentAfter.nlink
      ) {
        throw new Error("canonical PID parent changed after unlink");
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      result = {
        kind: "refused",
        reason: code === "EEXIST"
          ? "deterministic offline PID quarantine already exists"
          : linkCreated
            ? `PID quarantine transition is incomplete; preserve exact evidence at ${expected.path} and ${quarantinePath}`
            : "daemon PID state changed during cleanup",
      };
    } finally {
      for (const descriptor of [
        canonicalParentDescriptor,
        quarantineDescriptor,
        sourceDescriptor,
        parentDescriptor,
      ]) {
        if (descriptor === undefined) continue;
        try {
          closeSync(descriptor);
        } catch {
          result = {
            kind: "refused",
            reason: sourceUnlinked
              ? `PID quarantine descriptor cleanup was uncertain; preserve ${quarantinePath}`
              : `PID quarantine descriptor cleanup failed; preserve ${expected.path} and ${quarantinePath}`,
          };
        }
      }
    }
    if (result.kind !== "refused" || !sourceUnlinked) return result;
    const quarantineProof = readOfflineStateFileProof(
      quarantinePath,
      expected.uid,
      {
        readContent: true,
        requirePrivate: false,
        maxBytes: MAX_OFFLINE_PID_BYTES,
      },
    );
    const parentAfterClose = readOfflineStateDirectoryProof(parent.path, parent.uid);
    if (
      quarantineProof !== null
      && offlineStateFileProofSurvivedRename(expected, quarantineProof)
      && parentAfterClose !== null
      && offlineStateDirectoryProofMatches(parent, parentAfterClose)
      && offlinePathIsSafelyAbsent(expected.path)
    ) {
      return { kind: "completed", proof: quarantineProof };
    }
    return result;
  }

  function runOfflineUnlinkSeam(
    seam: ((path: string) => void) | undefined,
    path: string,
  ): boolean {
    try {
      seam?.(path);
      return true;
    } catch {
      return false;
    }
  }

  function createOfflineRecoveryRecord(
    fingerprint: OfflineRestartFingerprint,
  ): OfflineRecoveryCreationResult {
    const record: OfflineRecoveryRecord = Object.freeze({
      version: OFFLINE_RECOVERY_RECORD_VERSION,
      kind: "lcm-offline-restart",
      pidFilePath: opts.pidFilePath,
      tokenFilePath: tokenPath,
      quarantinePath: recoveryPaths.quarantinePath,
      fingerprint,
    });
    const bytes = serializeOfflineRecoveryRecord(record);
    const encoded = Buffer.from(bytes, "utf8");
    if (
      encoded.byteLength <= 0
      || encoded.byteLength > MAX_OFFLINE_RECOVERY_RECORD_BYTES
      ||
      offlineRecoveryLeafIsPresent(recoveryPaths.recordPath)
      || offlineRecoveryLeafIsPresent(recoveryPaths.quarantinePath)
    ) {
      return { kind: "invalid" };
    }
    recoveryBoundary("before-record-create");
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    const parentBefore = readOfflineStateDirectoryProof(
      dirname(opts.pidFilePath),
      fingerprint.uid,
    );
    if (
      parentBefore === null
      || !offlineStateDirectoryProofMatches(fingerprint.stateDirectory, parentBefore)
    ) {
      return { kind: "invalid" };
    }
    const backup = writeExactRecoveryRecordLeaf(
      recoveryPaths.quarantinePath,
      bytes,
      fingerprint,
    );
    if (backup === null) return { kind: "invalid" };
    recoveryBoundary("after-recovery-backup-create");
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    const reopened = writeExactRecoveryRecordLeaf(
      recoveryPaths.recordPath,
      bytes,
      fingerprint,
    );
    if (reopened === null) return { kind: "invalid" };
    recoveryBoundary("after-record-create");
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    return { kind: "valid", record: reopened };
  }

  function recoveryRecordMatchesCurrentOperation(record: OfflineRecoveryRecord): boolean {
    const currentLaunchPath = process.argv[1];
    if (
      currentUid === undefined
      || record.pidFilePath !== opts.pidFilePath
      || record.tokenFilePath !== tokenPath
      || record.quarantinePath !== recoveryPaths.quarantinePath
      || record.fingerprint.uid !== currentUid
      || record.fingerprint.listenerPort !== opts.port
      || record.fingerprint.ownerId !== (testScope?.ownerId ?? null)
      || record.fingerprint.execPath !== process.execPath
      || typeof currentLaunchPath !== "string"
      || record.fingerprint.launchPath !== currentLaunchPath
      || record.fingerprint.entrypointDigest !== expectedOfflineRuntimeDigest
      || record.fingerprint.pidFile.path !== opts.pidFilePath
      || record.fingerprint.tokenFile.path !== tokenPath
      || record.fingerprint.stateDirectory.path !== dirname(opts.pidFilePath)
    ) {
      return false;
    }
    try {
      return realpath(expectedOfflineEntrypoint as string) === record.fingerprint.entrypoint
        && realpath(process.execPath) === record.fingerprint.executable
        && realpath(currentLaunchPath) === record.fingerprint.entrypoint;
    } catch {
      return false;
    }
  }

  function readExactOfflineRecoveryRecordAt(
    expected: OfflineRecoveryRecordRead & { kind: "valid" },
    path: string,
  ): (OfflineRecoveryRecordRead & { kind: "valid" }) | null {
    const current = readOfflineRecoveryRecordMatchingBytes(
      path,
      expected.record.fingerprint.uid,
      expected.bytes,
    );
    if (
      current === null
      || !offlineStateFileProofMatches(expected.proof, current.proof)
      || !recoveryRecordMatchesCurrentOperation(current.record)
    ) {
      return null;
    }
    const parent = readOfflineStateDirectoryProof(
      dirname(opts.pidFilePath),
      expected.record.fingerprint.uid,
    );
    return parent !== null
      && offlineStateDirectoryProofMatches(expected.record.fingerprint.stateDirectory, parent)
      ? current
      : null;
  }

  function readExactOfflineRecoveryRecord(
    expected: OfflineRecoveryRecordRead & { kind: "valid" },
  ): (OfflineRecoveryRecordRead & { kind: "valid" }) | null {
    return readExactOfflineRecoveryRecordAt(expected, recoveryPaths.recordPath);
  }

  function durablyRevalidateOfflineRecoveryRecord(
    expected: OfflineRecoveryRecordRead & { kind: "valid" },
  ): (OfflineRecoveryRecordRead & { kind: "valid" }) | null {
    const path = expected.proof.path;
    if (readExactOfflineRecoveryRecordAt(expected, path) === null) return null;
    let descriptor: number | undefined;
    let durable = false;
    try {
      descriptor = openRecoveryRecord(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = fstatSync(descriptor);
      if (
        !before.isFile()
        || before.dev !== expected.proof.device
        || before.ino !== expected.proof.inode
        || before.mode !== expected.proof.mode
        || before.uid !== expected.proof.uid
        || before.nlink !== expected.proof.links
        || before.size !== Buffer.byteLength(expected.bytes)
      ) {
        return null;
      }
      fsyncRecovery(descriptor);
      const after = fstatSync(descriptor);
      durable = stableDescriptorMetadataMatches(before, after);
    } catch {
      durable = false;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          durable = false;
        }
      }
    }
    if (!durable || !fsyncRecoveryParent(expected.record.fingerprint.stateDirectory)) return null;
    return readExactOfflineRecoveryRecordAt(expected, path);
  }
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
  async function authenticateDaemonAtPort(
    port: number,
    pid: number,
  ): Promise<"authenticated" | "no-response" | "refused"> {
    const healthDeadline = remainingVerificationDeadline();
    if (!healthDeadline) return "refused";
    const outcome = await checkDaemonPublicHealthOutcome(port, fetchFn, healthDeadline);
    if (outcome.kind === "no-response") return "no-response";
    const health = outcome.health;
    if (!isRecognizedDaemonHealth(health) || health.pid !== pid) return "refused";
    if (testScope && health.ownerId !== testScope.ownerId) return "refused";
    if (!healthVersionMatches(health, expectedVersion)) return "refused";
    // The current daemon may legitimately use a different backend during a
    // configured transition. Authenticate it independently; ensureOptions
    // applies expectedStorageBackend to the replacement below.
    const currentStorageBackend = health.storageBackend ?? "sqlite";
    if (currentStorageBackend !== "sqlite" && currentStorageBackend !== "postgresql") {
      return "refused";
    }
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
      )
      ? "authenticated"
      : "refused";
  }
  async function inspectManagedDaemon(
    pid: number,
  ): Promise<"authenticated" | "no-response" | "refused"> {
    if (_isManagedProcessOverride) {
      return await _isManagedProcessOverride(pid) ? "authenticated" : "refused";
    }
    if (platform === "linux" && !isLikelyLcmDaemonProcess(pid, procRoot)) return "refused";
    const listenerPorts = opts._listeningPortsOverride
      ? opts._listeningPortsOverride(pid)
      : findListeningTcpPorts(
          pid,
          platform,
          dependencies.spawnSync,
          procRoot,
          opts.port,
        );
    if (!listenerPorts.includes(opts.port)) return "refused";
    return authenticateDaemonAtPort(opts.port, pid);
  }

  function captureOfflineRestartSignalProof(pid: number): OfflineRestartSignalProof | null {
    const launchPath = process.argv[1];
    if (
      platform !== "linux"
      || (opts._listeningPortsOverride !== undefined
        && testScope === undefined
        && hermeticSeams === undefined)
      || initialTerminalRootProof === null
      || !offlineTerminalRootProofMatches(initialTerminalRootProof)
      || currentUid === undefined
      || typeof launchPath !== "string"
      || !isAbsolute(launchPath)
      || isVitestWorkerEntrypoint(launchPath)
      || typeof expectedOfflineEntrypoint !== "string"
      || expectedOfflineEntrypoint.length === 0
      || isVitestWorkerEntrypoint(expectedOfflineEntrypoint)
      || typeof expectedOfflineRuntimeDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(expectedOfflineRuntimeDigest)
      || (testScope !== undefined && opts._offlineScopedListenerStateOverride === undefined)
      || basename(opts.pidFilePath) !== "daemon.pid"
      || basename(tokenPath) !== "daemon.token"
    ) {
      return null;
    }

    let canonicalStateDir: string;
    let canonicalExecutable: string;
    let canonicalEntrypoint: string;
    let trustedLaunchEntrypoint: string;
    try {
      canonicalStateDir = realpath(dirname(opts.pidFilePath));
      canonicalExecutable = realpath(process.execPath);
      canonicalEntrypoint = realpath(expectedOfflineEntrypoint);
      trustedLaunchEntrypoint = realpath(launchPath);
    } catch {
      return null;
    }
    if (
      opts.pidFilePath !== join(canonicalStateDir, "daemon.pid")
      || tokenPath !== join(canonicalStateDir, "daemon.token")
      || trustedLaunchEntrypoint !== canonicalEntrypoint
    ) {
      return null;
    }

    assertCurrentScopedState();
    const stateDirectory = readOfflineStateDirectoryProof(canonicalStateDir, currentUid);
    const pidFile = readOfflineStateFileProof(
      opts.pidFilePath,
      currentUid,
      { readContent: true, requirePrivate: false, maxBytes: MAX_OFFLINE_PID_BYTES },
    );
    const tokenFile = readOfflineStateFileProof(
      tokenPath,
      currentUid,
      { readContent: false, requirePrivate: true },
    );
    const stateDirectoryAfterFiles = readOfflineStateDirectoryProof(
      canonicalStateDir,
      currentUid,
    );
    assertCurrentScopedState();
    if (
      stateDirectory === null
      || stateDirectoryAfterFiles === null
      || !offlineStateDirectoryProofMatches(stateDirectory, stateDirectoryAfterFiles)
      || pidFile === null
      || tokenFile === null
      || pidFile.content !== String(pid)
      || !isAlive(pid)
    ) {
      return null;
    }

    const status = readBoundedProcText(
      join(procRoot, String(pid), "status"),
      MAX_OFFLINE_PROC_TEXT_BYTES,
      currentUid,
    );
    const processStartTime = readLinuxProcessStartTime(pid, procRoot, currentUid);
    const argv = readLinuxProcessArgv(pid, procRoot, currentUid);
    if (
      status === null
      || statusUid(status) !== currentUid
      || processStartTime === null
      || argv === null
    ) {
      return null;
    }

    let executable: string;
    let entrypoint: string;
    try {
      executable = realpath(join(procRoot, String(pid), "exe"));
      entrypoint = realpath(argv[1] ?? "");
    } catch {
      return null;
    }
    const expectedArgs = [
      "daemon",
      "start",
      "--foreground",
      ...(testScope ? daemonLifecycleTestIdentityArgs(testScope) : []),
    ];
    if (
      executable !== canonicalExecutable
      || entrypoint !== canonicalEntrypoint
      || argv[0] !== process.execPath
      || argv[1] !== launchPath
      || isVitestWorkerEntrypoint(argv[1])
      || argv.length !== expectedArgs.length + 2
      || !argv.slice(2).every(
        (argument: string, index: number): boolean => argument === expectedArgs[index],
      )
    ) {
      return null;
    }

    const entrypointDigest = sha256File(canonicalEntrypoint);
    if (entrypointDigest !== expectedOfflineRuntimeDigest) return null;
    if (
      !isAlive(pid)
      || readLinuxProcessStartTime(pid, procRoot, currentUid) !== processStartTime
    ) {
      return null;
    }

    assertCurrentScopedState();
    const finalStateDirectory = readOfflineStateDirectoryProof(
      canonicalStateDir,
      currentUid,
    );
    const finalPidFile = readOfflineStateFileProof(
      opts.pidFilePath,
      currentUid,
      { readContent: true, requirePrivate: false, maxBytes: MAX_OFFLINE_PID_BYTES },
    );
    const finalTokenFile = readOfflineStateFileProof(
      tokenPath,
      currentUid,
      { readContent: false, requirePrivate: true },
    );
    const finalStateDirectoryAfterFiles = readOfflineStateDirectoryProof(
      canonicalStateDir,
      currentUid,
    );
    assertCurrentScopedState();
    const finalStatus = readBoundedProcText(
      join(procRoot, String(pid), "status"),
      MAX_OFFLINE_PROC_TEXT_BYTES,
      currentUid,
    );
    const finalArgv = readLinuxProcessArgv(pid, procRoot, currentUid);
    const finalLaunchPath = process.argv[1];
    let finalExecutable: string;
    let finalEntrypoint: string;
    let finalTrustedLaunchEntrypoint: string;
    try {
      finalExecutable = realpath(join(procRoot, String(pid), "exe"));
      finalEntrypoint = realpath(finalArgv?.[1] ?? "");
      if (typeof finalLaunchPath !== "string" || !isAbsolute(finalLaunchPath)) return null;
      finalTrustedLaunchEntrypoint = realpath(finalLaunchPath);
    } catch {
      return null;
    }
    if (
      finalStateDirectory === null
      || finalStateDirectoryAfterFiles === null
      || !offlineStateDirectoryProofMatches(stateDirectory, finalStateDirectory)
      || !offlineStateDirectoryProofMatches(finalStateDirectory, finalStateDirectoryAfterFiles)
      || finalPidFile === null
      || finalTokenFile === null
      || finalStatus === null
      || finalArgv === null
      || !offlineStateFileProofMatches(finalPidFile, pidFile)
      || !offlineStateFileProofMatches(finalTokenFile, tokenFile)
      || statusUid(finalStatus) !== currentUid
      || readLinuxProcessStartTime(pid, procRoot, currentUid) !== processStartTime
      || finalExecutable !== executable
      || finalEntrypoint !== entrypoint
      || finalLaunchPath !== launchPath
      || finalTrustedLaunchEntrypoint !== canonicalEntrypoint
      || !offlineStringSequencesMatch(finalArgv, argv)
      || sha256File(canonicalEntrypoint) !== entrypointDigest
      || !isAlive(pid)
    ) {
      return null;
    }

    const listenerSocketInodes = opts._listeningPortsOverride
      ? opts._listeningPortsOverride(pid).includes(opts.port)
        ? Object.freeze([`test-listener:${opts.port}`])
        : null
      : readOfflineDirectListenerSocketInodes(
          pid,
          procRoot,
          opts.port,
          currentUid,
        );
    if (listenerSocketInodes === null) return null;

    const fingerprint = Object.freeze({
      pid,
      uid: currentUid,
      processStartTime,
      execPath: process.execPath,
      executable,
      argv,
      launchPath,
      entrypoint,
      entrypointDigest,
      stateDirectory,
      pidFile,
      tokenFile,
      listenerPort: opts.port,
      ownerId: testScope?.ownerId ?? null,
    });
    return Object.freeze({ fingerprint, listenerSocketInodes });
  }

  function captureOfflineRestartFingerprint(pid: number): OfflineRestartFingerprint | null {
    return captureOfflineRestartSignalProof(pid)?.fingerprint ?? null;
  }

  function originalOfflineProcessIsGone(fingerprint: OfflineRestartFingerprint): boolean {
    return linuxProcessBirthState(
      fingerprint.pid,
      procRoot,
      fingerprint.processStartTime,
      fingerprint.uid,
    ).kind === "gone";
  }

  function removeRecoveryBackupBeforeSignal(
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
  ): OfflineStopResult {
    const exactRecord = readExactOfflineRecoveryRecord(recovery);
    if (exactRecord === null) {
      return { kind: "refused", reason: "offline restart recovery record changed before backup cleanup" };
    }
    const backup = readOfflineRecoveryRecord(
      recoveryPaths.quarantinePath,
      recovery.record.fingerprint.uid,
    );
    if (backup.kind === "absent") return { kind: "stopped" };
    if (
      backup.kind !== "valid"
      || backup.bytes !== exactRecord.bytes
      || !recoveryRecordMatchesCurrentOperation(backup.record)
    ) {
      return { kind: "refused", reason: "offline restart quarantine is not the exact recovery backup" };
    }
    recoveryBoundary("before-recovery-backup-cleanup");
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    if (!runOfflineUnlinkSeam(
      opts._offlineRecoveryBackupUnlinkOverride,
      recoveryPaths.quarantinePath,
    )) {
      return { kind: "refused", reason: "offline restart recovery backup cleanup was not durable" };
    }
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    const exactBackup = readExactOfflineRecoveryRecordAt(
      backup,
      recoveryPaths.quarantinePath,
    );
    const recordBeforeUnlink = readExactOfflineRecoveryRecord(exactRecord);
    const backupUnlink = exactBackup !== null
      && recordBeforeUnlink !== null
      && exactBackup.bytes === recordBeforeUnlink.bytes
      ? heldOfflineLeafProofToUnlink(
          exactBackup.proof,
          recovery.record.fingerprint.stateDirectory,
        )
      : null;
    if (
      exactBackup === null
      || recordBeforeUnlink === null
      || exactBackup.bytes !== recordBeforeUnlink.bytes
      || backupUnlink?.kind !== "durable"
    ) {
      return { kind: "refused", reason: "offline restart recovery backup cleanup was not durable" };
    }
    recoveryBoundary("after-recovery-backup-cleanup");
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    return readExactOfflineRecoveryRecord(recordBeforeUnlink) !== null
      && offlinePathIsSafelyAbsent(recoveryPaths.quarantinePath)
      ? { kind: "stopped" }
      : { kind: "refused", reason: "offline restart recovery authority changed after backup cleanup" };
  }

  async function stopOfflineVerifiedDaemon(
    signalProof: OfflineRestartSignalProof,
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
  ): Promise<OfflineStopResult> {
    const fingerprint = signalProof.fingerprint;
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    const backupCleanup = removeRecoveryBackupBeforeSignal(recovery);
    if (backupCleanup.kind !== "stopped") return backupCleanup;
    recoveryBoundary("before-sigterm-revalidation");
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    if (readExactOfflineRecoveryRecord(recovery) === null) {
      return { kind: "refused", reason: "offline restart recovery record changed before SIGTERM" };
    }
    const beforeTerm = captureOfflineRestartSignalProof(fingerprint.pid);
    if (
      beforeTerm === null
      || !offlineRestartSignalProofsMatch(signalProof, beforeTerm)
    ) {
      return { kind: "refused", reason: "daemon identity changed before SIGTERM" };
    }
    if (readExactOfflineRecoveryRecord(recovery) === null) {
      return { kind: "refused", reason: "offline restart recovery record changed before SIGTERM" };
    }
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    try {
      killProcess(fingerprint.pid, "SIGTERM");
      if (opts._abortSignal?.aborted) return { kind: "interrupted" };
      recoveryBoundary("after-sigterm");
    } catch {
      return { kind: "refused", reason: "SIGTERM could not be delivered" };
    }
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    if (readExactOfflineRecoveryRecord(recovery) === null) {
      return { kind: "refused", reason: "offline restart recovery record changed after SIGTERM" };
    }
    await sleepFn(500);
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    if (readExactOfflineRecoveryRecord(recovery) === null) {
      return { kind: "refused", reason: "offline restart recovery record changed after SIGTERM wait" };
    }
    if (originalOfflineProcessIsGone(fingerprint)) return { kind: "stopped" };
    if (readExactOfflineRecoveryRecord(recovery) === null) {
      return { kind: "refused", reason: "offline restart recovery record changed before SIGKILL" };
    }
    const beforeKill = captureOfflineRestartSignalProof(fingerprint.pid);
    if (
      beforeKill === null
      || !offlineRestartSignalProofsMatch(signalProof, beforeKill)
    ) {
      return { kind: "refused", reason: "daemon identity changed before SIGKILL" };
    }
    if (readExactOfflineRecoveryRecord(recovery) === null) {
      return { kind: "refused", reason: "offline restart recovery record changed before SIGKILL" };
    }
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    try {
      killProcess(fingerprint.pid, "SIGKILL");
      if (opts._abortSignal?.aborted) return { kind: "interrupted" };
      recoveryBoundary("after-sigkill");
    } catch {
      return { kind: "refused", reason: "SIGKILL could not be delivered" };
    }
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    if (readExactOfflineRecoveryRecord(recovery) === null) {
      return { kind: "refused", reason: "offline restart recovery record changed after SIGKILL" };
    }
    await sleepFn(500);
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    if (readExactOfflineRecoveryRecord(recovery) === null) {
      return { kind: "refused", reason: "offline restart recovery record changed after SIGKILL wait" };
    }
    return originalOfflineProcessIsGone(fingerprint)
      ? { kind: "stopped" }
      : { kind: "refused", reason: "daemon remained alive after SIGKILL" };
  }

  function offlinePathIsSafelyAbsent(path: string): boolean {
    assertCurrentScopedState();
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    } finally {
      assertCurrentScopedState();
    }
  }

  function readOfflineCanonicalPid(
    expectedUid: number,
  ): Readonly<{ pid: number; proof: OfflineContentStateFileProof }> | null {
    const proof = readOfflineStateFileProof(
      opts.pidFilePath,
      expectedUid,
      { readContent: true, requirePrivate: false, maxBytes: MAX_OFFLINE_PID_BYTES },
    );
    if (proof === null || !/^[1-9]\d*$/u.test(proof.content)) return null;
    const pid = Number(proof.content);
    return Number.isSafeInteger(pid) && pid > 0 && String(pid) === proof.content
      ? Object.freeze({ pid, proof })
      : null;
  }

  function stoppedLoopbackListenerState(
    fingerprint: OfflineRestartFingerprint,
  ): "absent" | "listening" | "unavailable" {
    if (!testScope) return linuxLoopbackListenerState(procRoot, fingerprint.listenerPort);
    return opts._offlineScopedListenerStateOverride!();
  }

  type StoppedOfflineSnapshot = Readonly<{
    recoveryProof: OfflineStateFileProof;
    quarantine: OfflineQuarantineEvidence;
    stateDirectory: OfflineStateDirectoryProof;
    tokenFile: OfflineStateFileProof;
    canonicalPidFile: OfflineStateFileProof | null;
    launchPath: string;
    executable: string;
    entrypoint: string;
    entrypointDigest: string;
    listenerState: "absent";
    scopeOwnerId: string | null;
  }>;

  function stoppedOfflineSnapshotsMatch(
    left: StoppedOfflineSnapshot,
    right: StoppedOfflineSnapshot,
  ): boolean {
    return offlineStateFileProofMatches(left.recoveryProof, right.recoveryProof)
      && offlineQuarantineEvidenceMatches(left.quarantine, right.quarantine)
      && offlineStateDirectoryProofMatches(left.stateDirectory, right.stateDirectory)
      && offlineStateFileProofMatches(left.tokenFile, right.tokenFile)
      && (left.canonicalPidFile === null
        ? right.canonicalPidFile === null
        : right.canonicalPidFile !== null
          && offlineStateFileProofMatches(left.canonicalPidFile, right.canonicalPidFile))
      && left.launchPath === right.launchPath
      && left.executable === right.executable
      && left.entrypoint === right.entrypoint
      && left.entrypointDigest === right.entrypointDigest
      && left.listenerState === right.listenerState
      && left.scopeOwnerId === right.scopeOwnerId;
  }

  function captureStoppedOfflineSnapshotOnce(
    fingerprint: OfflineRestartFingerprint,
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
    requirePidAbsent: boolean,
  ): StoppedOfflineSnapshot | null {
    if (opts._abortSignal?.aborted) return null;
    assertCurrentScopedState();
    const exactRecoveryBefore = readExactOfflineRecoveryRecord(recovery);
    const birth = linuxProcessBirthState(
      fingerprint.pid,
      procRoot,
      fingerprint.processStartTime,
      fingerprint.uid,
    );
    const stateDirectory = readOfflineStateDirectoryProof(
      fingerprint.stateDirectory.path,
      fingerprint.uid,
    );
    const tokenFile = readOfflineStateFileProof(
      tokenPath,
      fingerprint.uid,
      { readContent: false, requirePrivate: true },
    );
    const canonicalPidFile = readOfflineStateFileProof(
      opts.pidFilePath,
      fingerprint.uid,
      { readContent: true, requirePrivate: false, maxBytes: MAX_OFFLINE_PID_BYTES },
    );
    const quarantine = quarantineEvidenceForRecord(recovery);
    const launchPath = process.argv[1];
    let executable: string;
    let entrypoint: string;
    let trustedLaunchEntrypoint: string;
    try {
      executable = realpath(process.execPath);
      entrypoint = realpath(expectedOfflineEntrypoint as string);
      if (typeof launchPath !== "string" || !isAbsolute(launchPath)) return null;
      trustedLaunchEntrypoint = realpath(launchPath);
    } catch {
      return null;
    }
    const entrypointDigest = sha256File(entrypoint);
    const listenerState = stoppedLoopbackListenerState(fingerprint);
    const exactRecoveryAfter = readExactOfflineRecoveryRecord(recovery);
    const stateDirectoryAfter = readOfflineStateDirectoryProof(
      fingerprint.stateDirectory.path,
      fingerprint.uid,
    );
    const linkedPidQuarantine = canonicalPidFile !== null
      && quarantine?.kind === "original-pid"
      && offlineStateFileProofIsLinkedQuarantineTransition(
        fingerprint.pidFile,
        canonicalPidFile,
        quarantine.proof,
      );
    assertCurrentScopedState();
    if (
      exactRecoveryBefore === null
      || exactRecoveryAfter === null
      || !offlineStateFileProofMatches(exactRecoveryBefore.proof, exactRecoveryAfter.proof)
      || birth.kind !== "gone"
      || isAlive(fingerprint.pid)
      || stateDirectory === null
      || stateDirectoryAfter === null
      || !offlineStateDirectoryProofMatches(fingerprint.stateDirectory, stateDirectory)
      || !offlineStateDirectoryProofMatches(stateDirectory, stateDirectoryAfter)
      || tokenFile === null
      || !offlineStateFileProofMatches(fingerprint.tokenFile, tokenFile)
      || quarantine === null
      || (canonicalPidFile !== null
        && !offlineStateFileProofMatches(fingerprint.pidFile, canonicalPidFile)
        && !linkedPidQuarantine)
      || (requirePidAbsent && canonicalPidFile !== null)
      || launchPath !== fingerprint.launchPath
      || process.execPath !== fingerprint.execPath
      || executable !== fingerprint.executable
      || entrypoint !== fingerprint.entrypoint
      || trustedLaunchEntrypoint !== fingerprint.entrypoint
      || entrypointDigest !== fingerprint.entrypointDigest
      || expectedOfflineRuntimeDigest !== fingerprint.entrypointDigest
      || listenerState !== "absent"
      || opts._abortSignal?.aborted
    ) {
      return null;
    }
    return Object.freeze({
      recoveryProof: exactRecoveryAfter.proof,
      quarantine,
      stateDirectory,
      tokenFile,
      canonicalPidFile,
      launchPath,
      executable,
      entrypoint,
      entrypointDigest,
      listenerState,
      scopeOwnerId: testScope?.ownerId ?? null,
    });
  }

  function captureStableStoppedOfflineSnapshot(
    fingerprint: OfflineRestartFingerprint,
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
    requirePidAbsent: boolean,
  ): StoppedOfflineSnapshot | null {
    const before = captureStoppedOfflineSnapshotOnce(
      fingerprint,
      recovery,
      requirePidAbsent,
    );
    const after = captureStoppedOfflineSnapshotOnce(
      fingerprint,
      recovery,
      requirePidAbsent,
    );
    return before !== null
      && after !== null
      && stoppedOfflineSnapshotsMatch(before, after)
      ? after
      : null;
  }

  function stoppedOfflineTrustFence(
    fingerprint: OfflineRestartFingerprint,
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
    requirePidAbsent: boolean,
  ): StoppedOfflineTrustFenceResult {
    const interrupted = (): boolean => opts._abortSignal?.aborted === true;
    if (interrupted()) return { kind: "interrupted" };
    try {
      recoveryBoundary("before-stopped-trust-fence");
      if (interrupted()) return { kind: "interrupted" };
      let snapshot = captureStableStoppedOfflineSnapshot(
        fingerprint,
        recovery,
        requirePidAbsent,
      );
      if (snapshot === null) {
        return interrupted()
          ? { kind: "interrupted" }
          : { kind: "refused", reason: "stopped daemon trust evidence is incomplete" };
      }
      recoveryBoundary("after-original-gone-proof");
      if (interrupted()) return { kind: "interrupted" };
      let next = captureStableStoppedOfflineSnapshot(fingerprint, recovery, requirePidAbsent);
      if (next === null || !stoppedOfflineSnapshotsMatch(snapshot, next)) {
        return interrupted()
          ? { kind: "interrupted" }
          : { kind: "refused", reason: "stopped daemon trust evidence changed" };
      }
      snapshot = next;
      recoveryBoundary("after-final-original-gone-proof");
      if (interrupted()) return { kind: "interrupted" };
      next = captureStableStoppedOfflineSnapshot(fingerprint, recovery, requirePidAbsent);
      if (next === null || !stoppedOfflineSnapshotsMatch(snapshot, next)) {
        return interrupted()
          ? { kind: "interrupted" }
          : { kind: "refused", reason: "stopped daemon trust evidence changed" };
      }
      snapshot = next;
      opts._offlineTrustFenceFinalizeOverride?.();
      if (interrupted()) return { kind: "interrupted" };
      next = captureStableStoppedOfflineSnapshot(fingerprint, recovery, requirePidAbsent);
      if (next === null || !stoppedOfflineSnapshotsMatch(snapshot, next)) {
        return interrupted()
          ? { kind: "interrupted" }
          : { kind: "refused", reason: "stopped daemon trust evidence changed" };
      }
      snapshot = next;
      recoveryBoundary("before-stopped-fence-publication");
      if (interrupted()) return { kind: "interrupted" };
      const finalSnapshot = captureStableStoppedOfflineSnapshot(
        fingerprint,
        recovery,
        requirePidAbsent,
      );
      if (finalSnapshot !== null && stoppedOfflineSnapshotsMatch(snapshot, finalSnapshot)) {
        return { kind: "trusted" };
      }
      return interrupted()
        ? { kind: "interrupted" }
        : { kind: "refused", reason: "stopped daemon trust evidence changed" };
    } catch {
      return { kind: "refused", reason: "stopped daemon trust evidence is unreadable" };
    }
  }

  function captureOfflineTerminalRootProof(): OfflineTerminalRootProof | null {
    if (platform !== "linux" || currentUid === undefined) return null;
    const procRootProof = readOfflineDirectDirectoryProof(procRoot);
    if (procRootProof === null) return null;
    if (testScope === undefined && hermeticSeams === undefined) {
      if (procRoot === "/proc" && opts._procRoot === undefined) {
        const scopeDirectories: readonly [] = Object.freeze([]);
        const entrypointProofs: readonly [] = Object.freeze([]);
        return Object.freeze({
            procRoot: procRootProof,
            scopeDirectories,
            scopeHomePath: null,
            scopeOwnerId: null,
            entrypointProofs,
          });
      }
      return null;
    }
    if (typeof opts._procRoot !== "string" || opts._procRoot !== procRoot || procRoot === "/proc") {
      return null;
    }
    const scopeHomePath = testScope?.homeDir ?? hermeticSeams!.homeDir;
    const scopeEntrypointPath = testScope?.entrypoint ?? expectedOfflineEntrypoint;
    if (
      typeof scopeEntrypointPath !== "string"
      || !isAbsolute(scopeEntrypointPath)
      || !offlineDirectPathIsWithin(procRoot, scopeHomePath)
    ) {
      return null;
    }
    const directoryPaths = [
      scopeHomePath,
      testScope?.runtimeDir ?? hermeticSeams!.runtimeDir,
      testScope?.stateDir ?? hermeticSeams!.stateDir,
      testScope?.credentialDir ?? hermeticSeams!.credentialDir,
      procRoot,
    ].filter((path: string, index: number, paths: string[]): boolean => (
      paths.indexOf(path) === index
    ));
    const exactDirectories: OfflineDirectDirectoryProof[] = [];
    for (const path of directoryPaths) {
      const proof = readOfflineDirectDirectoryProof(path);
      if (!offlineDirectDirectoryIsOwned(proof, currentUid)) return null;
      exactDirectories.push(proof);
    }
    const home = exactDirectories.find(
      (proof: OfflineDirectDirectoryProof): boolean => proof.path === scopeHomePath,
    );
    const boundProcRoot = exactDirectories.find(
      (proof: OfflineDirectDirectoryProof): boolean => proof.path === procRoot,
    );
    const scopeEntrypoint = readOfflineStateFileProof(
      scopeEntrypointPath,
      currentUid,
      { readContent: false, requirePrivate: false, maxBytes: MAX_OFFLINE_RUNTIME_BYTES },
    );
    if (
      home === undefined
      || boundProcRoot === undefined
      || !offlineDirectDirectoryProofMatches(procRootProof, boundProcRoot)
      || scopeEntrypoint === null
      || scopeEntrypoint.links !== 1
      || (testScope !== undefined
        && (
          home.device !== testScope.filesystem.homeDir.device
          || home.inode !== testScope.filesystem.homeDir.inode
          || scopeEntrypoint.device !== testScope.filesystem.entrypoint.device
          || scopeEntrypoint.inode !== testScope.filesystem.entrypoint.inode
        ))
    ) {
      return null;
    }
    const entrypointProofs: readonly [OfflineStateFileProof] = Object.freeze([
      scopeEntrypoint,
    ]);
    return Object.freeze({
      procRoot: procRootProof,
      scopeDirectories: Object.freeze(exactDirectories),
      scopeHomePath,
      scopeOwnerId: testScope?.ownerId ?? null,
      entrypointProofs,
    });
  }

  function offlineTerminalRootProofMatches(expected: OfflineTerminalRootProof): boolean {
    const currentProcRoot = readOfflineDirectDirectoryProof(expected.procRoot.path);
    if (!offlineDirectDirectoryProofMatches(expected.procRoot, currentProcRoot)) return false;
    const currentDirectories: OfflineDirectDirectoryProof[] = [];
    for (const proof of expected.scopeDirectories) {
      const current = readOfflineDirectDirectoryProof(proof.path);
      if (current !== null) currentDirectories.push(current);
    }
    const currentEntrypointProofs: OfflineStateFileProof[] = [];
    for (const proof of expected.entrypointProofs) {
      const current = readOfflineStateFileProof(
        proof.path,
        proof.uid,
        { readContent: false, requirePrivate: false, maxBytes: MAX_OFFLINE_RUNTIME_BYTES },
      );
      if (current !== null) currentEntrypointProofs.push(current);
    }
    const directoriesMatch = offlineDirectDirectoryProofsMatch(
      expected.scopeDirectories,
      currentDirectories,
    );
    const entrypointProofsMatch = offlineStateFileProofCollectionsMatch(
      expected.entrypointProofs,
      currentEntrypointProofs,
    );
    return directoriesMatch && entrypointProofsMatch;
  }

  function captureTerminalRecoveryAuthoritySeed(
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
    authority: OfflineRecoveryFinalAuthority,
    readiness: OfflineReadinessPrimitives,
    stopped: number | undefined,
  ): TerminalRecoveryAuthoritySeed | null {
    if (
      initialTerminalRootProof === null
      || currentUid === undefined
      || stopped !== recovery.record.fingerprint.pid
      || authority.recordPath !== recoveryPaths.recordPath
      || authority.quarantinePath !== recoveryPaths.quarantinePath
      || authority.replacementFingerprint.ownerId !== initialTerminalRootProof.scopeOwnerId
      || readiness.connected !== true
      || readiness.pid !== authority.replacementFingerprint.pid
      || readiness.port !== authority.replacementFingerprint.listenerPort
    ) {
      return null;
    }
    const replacement = authority.replacementFingerprint;
    const direct = captureOfflineDirectCandidateProof(replacement, procRoot);
    if (
      direct === null
      || direct.listenerSocketInodes.length === 0
      || direct.listenerSocketInodes.length > 30
      || (readiness.parentPid !== undefined && readiness.parentPid !== direct.parent.pid)
      || (readiness.userSystemdPid !== undefined
        && readiness.userSystemdPid !== direct.parent.pid)
    ) {
      return null;
    }
    const replacementFdPath = join(procRoot, String(replacement.pid), "fd");
    const replacementFdProof = readOfflineDirectDirectoryProof(replacementFdPath);
    if (!offlineDirectDirectoryIsOwned(replacementFdProof, currentUid)) return null;
    const entrypointProof = readOfflineStateFileProof(
      replacement.entrypoint,
      currentUid,
      { readContent: false, requirePrivate: false, maxBytes: MAX_OFFLINE_RUNTIME_BYTES },
    );
    const entrypointRead = readStableBoundedDescriptor(
      replacement.entrypoint,
      MAX_OFFLINE_RUNTIME_BYTES,
      false,
    );
    if (
      entrypointProof === null
      || entrypointRead.kind !== "valid"
      || entrypointRead.content.length !== entrypointProof.size
      || entrypointRead.before.dev !== entrypointProof.device
      || entrypointRead.before.ino !== entrypointProof.inode
      || entrypointRead.before.mode !== entrypointProof.mode
      || entrypointRead.before.uid !== entrypointProof.uid
      || entrypointRead.before.nlink !== entrypointProof.links
      || entrypointRead.before.mtimeMs !== entrypointProof.modifiedAtMs
      || entrypointRead.before.ctimeMs !== entrypointProof.changedAtMs
    ) {
      return null;
    }
    const scopeDirectories: TerminalDirectoryProof[] = [];
    let scopeIndex = 0;
    while (scopeIndex < initialTerminalRootProof.scopeDirectories.length) {
      scopeDirectories[scopeIndex] = terminalDirectoryProof(
        initialTerminalRootProof.scopeDirectories[scopeIndex]!,
      );
      scopeIndex += 1;
    }
    const scopeEntrypoints: Array<Readonly<{
      proof: TerminalFileProof;
      content: TerminalByteSequence;
    }>> = [];
    let scopeEntrypointIndex = 0;
    while (scopeEntrypointIndex < initialTerminalRootProof.entrypointProofs.length) {
      const scopeProof = initialTerminalRootProof.entrypointProofs[scopeEntrypointIndex]!;
      const scopeRead = readStableBoundedDescriptor(
        scopeProof.path,
        MAX_OFFLINE_RUNTIME_BYTES,
        false,
      );
      if (
        scopeRead.kind !== "valid"
        || scopeRead.content.length !== scopeProof.size
        || scopeRead.before.dev !== scopeProof.device
        || scopeRead.before.ino !== scopeProof.inode
        || scopeRead.before.mode !== scopeProof.mode
        || scopeRead.before.uid !== scopeProof.uid
        || scopeRead.before.nlink !== scopeProof.links
        || scopeRead.before.mtimeMs !== scopeProof.modifiedAtMs
        || scopeRead.before.ctimeMs !== scopeProof.changedAtMs
      ) {
        return null;
      }
      scopeEntrypoints[scopeEntrypointIndex] = Object.freeze({
        proof: terminalFileProof(scopeProof),
        content: terminalCopiedByteSequence(scopeRead.content),
      });
      scopeEntrypointIndex += 1;
    }
    const listenerInodes: TerminalByteSequence[] = [];
    const listenerTargets: string[] = [];
    let listenerIndex = 0;
    while (listenerIndex < direct.listenerSocketInodes.length) {
      const inode = direct.listenerSocketInodes[listenerIndex]!;
      listenerInodes[listenerIndex] = terminalByteSequence(inode);
      listenerTargets[listenerIndex] = `socket:[${inode}]`;
      listenerIndex += 1;
    }
    const replacementDirectory = join(procRoot, String(replacement.pid));
    const parentDirectory = join(procRoot, String(direct.parent.pid));
    const replacementCmdlinePath = join(replacementDirectory, "cmdline");
    const parentCmdlinePath = join(parentDirectory, "cmdline");
    const replacementCmdlineProof = terminalReadStableMetadata(
      replacementCmdlinePath,
      currentUid,
    );
    const parentCmdlineProof = terminalReadStableMetadata(parentCmdlinePath, currentUid);
    const replacementCmdlineBytes = terminalByteSequence(`${replacement.argv.join("\0")}\0`);
    const parentCmdlineBytes = terminalByteSequence(`${direct.parent.argv.join("\0")}\0`);
    const parentLaunchPath = direct.parent.argv[0];
    const rawClientExecPath = process.execPath;
    const rawClientLaunchPath = process.argv[1];
    if (
      replacementCmdlineProof === null
      || parentCmdlineProof === null
      || (replacementCmdlineProof.size !== 0
        && replacementCmdlineProof.size !== replacementCmdlineBytes.length)
      || (parentCmdlineProof.size !== 0
        && parentCmdlineProof.size !== parentCmdlineBytes.length)
      || typeof parentLaunchPath !== "string"
      || typeof rawClientLaunchPath !== "string"
    ) {
      return null;
    }
    let canonicalClientExecutable: string;
    let canonicalClientEntrypoint: string;
    try {
      canonicalClientExecutable = terminalRealpathSync(rawClientExecPath);
      canonicalClientEntrypoint = terminalRealpathSync(rawClientLaunchPath);
    } catch {
      return null;
    }
    if (
      rawClientLaunchPath !== replacement.launchPath
      || rawClientExecPath !== replacement.execPath
      || canonicalClientExecutable !== replacement.executable
      || canonicalClientEntrypoint !== replacement.entrypoint
    ) {
      return null;
    }
    const portHex = replacement.listenerPort.toString(16).padStart(4, "0").toUpperCase();
    const recoveryBytes = terminalByteSequence(recovery.bytes);
    return Object.freeze({
      uid: currentUid,
      recordPath: recoveryPaths.recordPath,
      quarantinePath: recoveryPaths.quarantinePath,
      recoveryBytes,
      stateDirectory: terminalDirectoryProof(recovery.record.fingerprint.stateDirectory),
      ...(authority.kind === "clean"
        ? { expectedAuthority: "clean" as const, expectedBackupProof: null }
        : {
            expectedAuthority: "backup" as const,
            expectedBackupProof: terminalFileProof(authority.backup.proof),
          }),
      procRoot: terminalDirectoryProof(initialTerminalRootProof.procRoot),
      scopeDirectories: Object.freeze(scopeDirectories),
      scopeEntrypoints: Object.freeze(scopeEntrypoints),
      scopeOwnerId: initialTerminalRootProof.scopeOwnerId,
      originalDirectory: join(procRoot, String(recovery.record.fingerprint.pid)),
      originalPid: recovery.record.fingerprint.pid,
      replacementPid: replacement.pid,
      replacementStartTime: terminalByteSequence(replacement.processStartTime),
      replacementProcess: Object.freeze({
        directory: replacementDirectory,
        stat: join(replacementDirectory, "stat"),
        status: join(replacementDirectory, "status"),
        cmdline: replacementCmdlinePath,
        executable: join(replacementDirectory, "exe"),
        fd: replacementFdPath,
      }),
      replacementDirectoryProof: terminalDirectoryProof(direct.processDirectory),
      replacementFdDirectoryProof: terminalDirectoryProof(replacementFdProof),
      replacementCmdline: replacementCmdlineBytes,
      replacementCmdlineProof,
      replacementExecutable: replacement.executable,
      replacementExecPath: replacement.execPath,
      replacementLaunchPath: replacement.launchPath,
      replacementEntrypoint: replacement.entrypoint,
      replacementEntrypointProof: terminalFileProof(entrypointProof),
      replacementEntrypointContent: terminalCopiedByteSequence(entrypointRead.content),
      replacementEntrypointDigest: replacement.entrypointDigest,
      replacementStateDirectory: terminalDirectoryProof(replacement.stateDirectory),
      replacementPidFile: terminalFileProof(replacement.pidFile),
      replacementPidBytes: terminalByteSequence(String(replacement.pid)),
      replacementTokenFile: terminalFileProof(replacement.tokenFile),
      parentPid: direct.parent.pid,
      parentStartTime: terminalByteSequence(direct.parent.processStartTime),
      parentProcess: Object.freeze({
        directory: parentDirectory,
        stat: join(parentDirectory, "stat"),
        status: join(parentDirectory, "status"),
        cmdline: parentCmdlinePath,
        executable: join(parentDirectory, "exe"),
        fd: join(parentDirectory, "fd"),
      }),
      parentDirectoryProof: terminalDirectoryProof(direct.parent.processDirectory),
      parentCmdline: parentCmdlineBytes,
      parentCmdlineProof,
      parentExecutable: direct.parent.executable,
      parentLaunchPath,
      tcpPath: join(procRoot, "net", "tcp"),
      tcp6Path: join(procRoot, "net", "tcp6"),
      listenerPortHex: terminalByteSequence(portHex),
      uidDecimal: terminalByteSequence(String(currentUid)),
      parentPidDecimal: terminalByteSequence(String(direct.parent.pid)),
      listenerInodes: Object.freeze(listenerInodes),
      listenerTargets: Object.freeze(listenerTargets),
      listenerMask: (1 << direct.listenerSocketInodes.length) - 1,
      rawClientExecPath,
      rawClientLaunchPath,
      canonicalClientExecutable,
      canonicalClientEntrypoint,
    });
  }

  function buildOfflineRecoveryEnsureAuthorization(
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
    quarantine: OfflineReplacementStartupQuarantine,
  ): OfflineRecoveryEnsureAuthorization | null {
    const fingerprint = recovery.record.fingerprint;
    const snapshot = captureStableStoppedOfflineSnapshot(
      fingerprint,
      recovery,
      true,
    );
    if (
      snapshot === null
      || !offlineQuarantineEvidenceMatches(quarantine, snapshot.quarantine)
      || snapshot.canonicalPidFile !== null
    ) {
      return null;
    }
    const terminalRootProof = initialTerminalRootProof;
    if (
      terminalRootProof === null
      || !offlineTerminalRootProofMatches(terminalRootProof)
    ) {
      return null;
    }
    const quarantineProof = quarantine.kind === "absent"
      ? null
      : quarantine.proof;
    const captureCandidate = (
      pid: number,
    ): OfflineRecoveryAuthorizedCandidateProof | null => {
      const before = captureOfflineAuthorizedCandidate(recovery, quarantine, pid);
      if (before === null) return null;
      const direct = captureOfflineDirectCandidateProof(before.fingerprint, procRoot);
      const after = captureOfflineAuthorizedCandidate(recovery, quarantine, pid);
      return direct === null
        || after === null
        || !offlineAuthorizedCandidateProofsMatch(before, after)
        ? null
        : Object.freeze({ evidence: after, direct });
    };
    return Object.freeze({
      recordProof: snapshot.recoveryProof,
      quarantineProof,
      stateDirectory: snapshot.stateDirectory,
      stoppedFingerprint: fingerprint,
      abortSignal: opts._abortSignal,
      validateStopped: (): boolean => {
        if (opts._abortSignal?.aborted) return false;
        const current = captureStableStoppedOfflineSnapshot(
          fingerprint,
          recovery,
          true,
        );
        return current !== null
          && stoppedOfflineSnapshotsMatch(snapshot, current)
          && offlineQuarantineEvidenceMatches(quarantine, current.quarantine)
          && current.canonicalPidFile === null;
      },
      captureCandidate,
      candidateMatches: (
        left: OfflineRecoveryAuthorizedCandidateProof,
        right: OfflineRecoveryAuthorizedCandidateProof,
      ): boolean => offlineAuthorizedCandidateProofsMatch(left.evidence, right.evidence)
        && offlineDirectCandidateProofsMatch(left.direct, right.direct),
      readCandidateToken: (
        path: string,
        candidate: OfflineRecoveryAuthorizedCandidateProof,
      ): string | null => {
        const current = captureOfflineAuthorizedCandidate(
          recovery,
          quarantine,
          candidate.evidence.fingerprint.pid,
        );
        if (
          current === null
          || !offlineAuthorizedCandidateProofsMatch(candidate.evidence, current)
        ) {
          return null;
        }
        return readTokenBoundToOfflineProof(path, current.fingerprint.tokenFile);
      },
      runBoundary: recoveryBoundary,
    });
  }

  function prepareStoppedOfflineState(
    fingerprint: OfflineRestartFingerprint,
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
  ): OfflineStatePreparationResult {
    if (readExactOfflineRecoveryRecord(recovery) === null) {
      return { kind: "refused", reason: "offline restart recovery record changed before stopped-state preparation" };
    }
    const initialFence = stoppedOfflineTrustFence(fingerprint, recovery, false);
    if (initialFence.kind !== "trusted") return initialFence;
    recoveryBoundary("after-initial-stopped-fence");
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    const existingQuarantine = readOfflineStateFileProof(
      recoveryPaths.quarantinePath,
      fingerprint.uid,
      {
        readContent: true,
        requirePrivate: false,
        maxBytes: MAX_OFFLINE_RECOVERY_RECORD_BYTES,
      },
    ) ?? readOfflineStateFileProof(
      recoveryPaths.quarantinePath,
      fingerprint.uid,
      {
        readContent: true,
        requirePrivate: false,
        expectedLinks: 2,
        maxBytes: MAX_OFFLINE_PID_BYTES,
      },
    );
    if (existingQuarantine !== null) {
      const linkedCanonical = readOfflineStateFileProof(
        opts.pidFilePath,
        fingerprint.uid,
        {
          readContent: true,
          requirePrivate: false,
          expectedLinks: 2,
          maxBytes: MAX_OFFLINE_PID_BYTES,
        },
      );
      const linkedTransition = linkedCanonical !== null
        && offlineStateFileProofIsLinkedQuarantineTransition(
          fingerprint.pidFile,
          linkedCanonical,
          existingQuarantine,
        );
      if (linkedTransition) {
        const resumed = transitionOfflinePidToQuarantine(
          fingerprint.pidFile,
          fingerprint.stateDirectory,
          true,
        );
        if (resumed.kind !== "completed") return resumed;
        const resumedFence = stoppedOfflineTrustFence(fingerprint, recovery, true);
        if (resumedFence.kind !== "trusted") {
          return resumedFence.kind === "interrupted"
            ? {
                kind: "interrupted",
                reason: `PID quarantine retained at ${recoveryPaths.quarantinePath}`,
              }
            : resumedFence;
        }
        return { kind: "prepared", quarantineProof: resumed.proof };
      }
      if (
        !offlinePathIsSafelyAbsent(opts.pidFilePath)
        || !offlineStateFileProofSurvivedRename(fingerprint.pidFile, existingQuarantine)
      ) {
        return {
          kind: "refused",
          reason: `offline restart recovery evidence is ambiguous; preserve ${recoveryPaths.recordPath} and ${recoveryPaths.quarantinePath}`,
        };
      }
      const quarantinedFence = stoppedOfflineTrustFence(fingerprint, recovery, true);
      if (quarantinedFence.kind !== "trusted") {
        return quarantinedFence.kind === "interrupted"
          ? {
              kind: "interrupted",
              reason: `PID quarantine retained at ${recoveryPaths.quarantinePath}`,
            }
          : quarantinedFence;
      }
      return { kind: "prepared", quarantineProof: existingQuarantine };
    }
    if (offlineRecoveryLeafIsPresent(recoveryPaths.quarantinePath)) {
      return {
        kind: "refused",
        reason: `offline restart quarantine is untrusted at ${recoveryPaths.quarantinePath}`,
      };
    }
    const currentProof = readOfflineStateFileProof(
      opts.pidFilePath,
      fingerprint.uid,
      { readContent: true, requirePrivate: false, maxBytes: MAX_OFFLINE_PID_BYTES },
    );
    if (currentProof === null) {
      if (!offlinePathIsSafelyAbsent(opts.pidFilePath)) {
        return { kind: "refused", reason: "daemon PID state is not safely absent" };
      }
      try {
        opts._offlinePreAbsentFenceOverride?.();
      } catch {
        return { kind: "refused", reason: "stopped daemon trust evidence changed before PID absence verification" };
      }
      if (opts._abortSignal?.aborted) return { kind: "interrupted" };
      const absentFence = stoppedOfflineTrustFence(fingerprint, recovery, true);
      return absentFence.kind === "trusted" ? { kind: "prepared" } : absentFence;
    }
    if (
      currentProof.content.trim() !== String(fingerprint.pid)
      || !offlineStateFileProofMatches(fingerprint.pidFile, currentProof)
    ) {
      return { kind: "refused", reason: "daemon PID state was concurrently replaced" };
    }
    recoveryBoundary("before-pid-quarantine");
    if (opts._abortSignal?.aborted) return { kind: "interrupted" };
    const preRenameFence = stoppedOfflineTrustFence(fingerprint, recovery, false);
    if (preRenameFence.kind !== "trusted") return preRenameFence;
    if (readExactOfflineRecoveryRecord(recovery) === null) {
      return { kind: "refused", reason: "offline restart recovery record changed before PID quarantine" };
    }
    try {
      opts._offlinePidRenameOverride?.(opts.pidFilePath, recoveryPaths.quarantinePath);
    } catch {
      return { kind: "refused", reason: "daemon PID state changed during cleanup" };
    }
    if (opts._abortSignal?.aborted) {
      return {
        kind: "interrupted",
        reason: `PID quarantine retained at ${recoveryPaths.quarantinePath}`,
      };
    }
    const seamQuarantine = readOfflineStateFileProof(
      recoveryPaths.quarantinePath,
      fingerprint.uid,
      { readContent: true, requirePrivate: false, maxBytes: MAX_OFFLINE_PID_BYTES },
    );
    let transition: OfflinePidQuarantineTransitionResult;
    if (
      seamQuarantine !== null
      && offlineStateFileProofSurvivedRename(fingerprint.pidFile, seamQuarantine)
      && offlinePathIsSafelyAbsent(opts.pidFilePath)
    ) {
      transition = Object.freeze({ kind: "completed", proof: seamQuarantine });
    } else if (opts._offlinePidRenameOverride !== undefined) {
      return {
        kind: "refused",
        reason: `daemon PID state changed during cleanup; untrusted quarantine retained at ${recoveryPaths.quarantinePath}`,
      };
    } else {
      transition = transitionOfflinePidToQuarantine(
        fingerprint.pidFile,
        fingerprint.stateDirectory,
        false,
      );
    }
    if (transition.kind !== "completed") return transition;
    recoveryBoundary("after-pid-quarantine");
    if (opts._abortSignal?.aborted) {
      return {
        kind: "interrupted",
        reason: `PID quarantine retained at ${recoveryPaths.quarantinePath}`,
      };
    }
    const quarantinedProof = transition.proof;
    const parentAfterRename = readOfflineStateDirectoryProof(
      dirname(opts.pidFilePath),
      fingerprint.uid,
    );
    if (
      parentAfterRename === null
      || !offlineStateDirectoryProofMatches(fingerprint.stateDirectory, parentAfterRename)
      || quarantinedProof === null
      || !offlineStateFileProofSurvivedRename(fingerprint.pidFile, quarantinedProof)
      || readExactOfflineRecoveryRecord(recovery) === null
      || !offlinePathIsSafelyAbsent(opts.pidFilePath)
    ) {
      return {
        kind: "refused",
        reason: `daemon PID state changed during cleanup; untrusted quarantine retained at ${recoveryPaths.quarantinePath}`,
      };
    }
    const postRenameFence = stoppedOfflineTrustFence(fingerprint, recovery, true);
    if (postRenameFence.kind === "interrupted") {
      return {
        kind: "interrupted",
        reason: `PID quarantine retained at ${recoveryPaths.quarantinePath}`,
      };
    }
    if (postRenameFence.kind === "refused") {
      return {
        kind: "refused",
        reason: `${postRenameFence.reason}; PID quarantine retained at ${recoveryPaths.quarantinePath}`,
      };
    }
    return { kind: "prepared", quarantineProof: quarantinedProof };
  }

  type OfflineRecoveryReplacementSnapshot = Readonly<{
    recoveryProof: OfflineStateFileProof;
    quarantine: OfflineQuarantineEvidence;
    replacement: OfflineRestartFingerprint;
    healthIdentity: string;
  }>;

  function offlineQuarantineEvidenceMatches(
    left: OfflineQuarantineEvidence,
    right: OfflineQuarantineEvidence,
  ): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "absent" && right.kind === "absent") return true;
    if (left.kind === "original-pid" && right.kind === "original-pid") {
      return offlineStateFileProofMatches(left.proof, right.proof);
    }
    return left.kind === "record-backup"
      && right.kind === "record-backup"
      && left.record.bytes === right.record.bytes
      && offlineStateFileProofMatches(left.record.proof, right.record.proof);
  }

  function offlineAuthorizedCandidateProofsMatch(
    left: OfflineAuthorizedCandidateProof,
    right: OfflineAuthorizedCandidateProof,
  ): boolean {
    return offlineStateFileProofMatches(left.recoveryProof, right.recoveryProof)
      && left.recoveryBytes === right.recoveryBytes
      && offlineQuarantineEvidenceMatches(left.quarantine, right.quarantine)
      && offlineFingerprintsMatch(left.fingerprint, right.fingerprint);
  }

  function captureOfflineAuthorizedCandidate(
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
    requiredQuarantine: OfflineQuarantineEvidence,
    expectedResultPid?: number,
    authorityPath = recoveryPaths.recordPath,
    requireRecordAbsent = false,
  ): OfflineAuthorizedCandidateProof | null {
    if (opts._abortSignal?.aborted) return null;
    const authorityBefore = readExactOfflineRecoveryRecordAt(recovery, authorityPath);
    if (
      authorityBefore === null
      || (requireRecordAbsent && !offlinePathIsSafelyAbsent(recoveryPaths.recordPath))
    ) {
      return null;
    }
    const canonicalPid = readOfflineCanonicalPid(recovery.record.fingerprint.uid);
    if (
      canonicalPid === null
      || (expectedResultPid !== undefined && canonicalPid.pid !== expectedResultPid)
    ) {
      return null;
    }
    const fingerprint = captureOfflineRestartFingerprint(canonicalPid.pid);
    const quarantine = quarantineEvidenceForRecord(recovery);
    const authorityAfter = readExactOfflineRecoveryRecordAt(recovery, authorityPath);
    if (
      fingerprint === null
      || quarantine === null
      || authorityAfter === null
      || !offlineStateFileProofMatches(authorityBefore.proof, authorityAfter.proof)
      || !offlineStateFileProofMatches(canonicalPid.proof, fingerprint.pidFile)
      || !offlineQuarantineEvidenceMatches(requiredQuarantine, quarantine)
      || linuxProcessBirthState(
        recovery.record.fingerprint.pid,
        procRoot,
        recovery.record.fingerprint.processStartTime,
        recovery.record.fingerprint.uid,
      ).kind !== "gone"
      || !offlineStateFileProofMatches(
        recovery.record.fingerprint.tokenFile,
        fingerprint.tokenFile,
      )
      || !offlineStateDirectoryProofMatches(
        recovery.record.fingerprint.stateDirectory,
        fingerprint.stateDirectory,
      )
      || (requireRecordAbsent && !offlinePathIsSafelyAbsent(recoveryPaths.recordPath))
      || opts._abortSignal?.aborted
    ) {
      return null;
    }
    return Object.freeze({
      recoveryProof: authorityAfter.proof,
      recoveryBytes: authorityAfter.bytes,
      quarantine,
      fingerprint,
    });
  }

  async function captureAuthenticatedReplacementSnapshot(
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
    requiredQuarantine: OfflineQuarantineEvidence,
    expectedResultPid?: number,
    authorityPath = recoveryPaths.recordPath,
    requireRecordAbsent = false,
  ): Promise<OfflineRecoveryReplacementSnapshot | null> {
    const candidateBeforeAuthentication = captureOfflineAuthorizedCandidate(
      recovery,
      requiredQuarantine,
      expectedResultPid,
      authorityPath,
      requireRecordAbsent,
    );
    if (candidateBeforeAuthentication === null) return null;
    const replacementPid = candidateBeforeAuthentication.fingerprint.pid;
    const finalizeDeadline = monotonicNow() + opts.spawnTimeoutMs;
    const deadline = (): RequestDeadline | null => {
      const timeoutMs = finalizeDeadline - monotonicNow();
      return timeoutMs <= 0
        ? null
        : { timeoutMs, setTimeoutFn, clearTimeoutFn, abortSignal: opts._abortSignal };
    };
    const publicDeadline = deadline();
    if (publicDeadline === null) return null;
    const outcome = await checkDaemonPublicHealthOutcome(opts.port, fetchFn, publicDeadline);
    if (outcome.kind !== "response") return null;
    const candidateAfterPublicHealth = captureOfflineAuthorizedCandidate(
      recovery,
      requiredQuarantine,
      replacementPid,
      authorityPath,
      requireRecordAbsent,
    );
    if (
      candidateAfterPublicHealth === null
      || !offlineAuthorizedCandidateProofsMatch(
        candidateBeforeAuthentication,
        candidateAfterPublicHealth,
      )
    ) {
      return null;
    }
    const health = outcome.health;
    const expectedStorageBackend = opts.expectedStorageBackend ?? "sqlite";
    if (
      !isRecognizedDaemonHealth(health)
      || health.pid !== replacementPid
      || !healthVersionMatches(health, expectedVersion)
      || !healthStorageBackendMatches(health, expectedStorageBackend)
      || (testScope && health.ownerId !== testScope.ownerId)
    ) {
      return null;
    }
    const validateCandidate = (): boolean => {
      const current = captureOfflineAuthorizedCandidate(
        recovery,
        requiredQuarantine,
        replacementPid,
        authorityPath,
        requireRecordAbsent,
      );
      return current !== null
        && offlineAuthorizedCandidateProofsMatch(candidateAfterPublicHealth, current);
    };
    const authenticated = await checkDaemonDiagnostics(
      opts.port,
      tokenPath,
      fetchFn,
      deadline,
      health,
      expectedStorageBackend,
      (path: string): string | null => {
        if (!validateCandidate()) return null;
        return readTokenBoundToOfflineProof(
          path,
          candidateAfterPublicHealth.fingerprint.tokenFile,
        );
      },
      validateCandidate,
    );
    if (
      authenticated === null
      || !processEntrypointMatches(
        authenticated,
        testScope?.entrypoint ?? opts.expectedEntrypoint,
        platform,
        procRoot,
        realpath,
      )
      || !healthRuntimeDigestMatches(authenticated, expectedOfflineRuntimeDigest)
    ) {
      return null;
    }
    const candidateAfterAuthentication = captureOfflineAuthorizedCandidate(
      recovery,
      requiredQuarantine,
      replacementPid,
      authorityPath,
      requireRecordAbsent,
    );
    if (
      candidateAfterAuthentication === null
      || !offlineAuthorizedCandidateProofsMatch(
        candidateAfterPublicHealth,
        candidateAfterAuthentication,
      )
    ) {
      return null;
    }
    return Object.freeze({
      recoveryProof: candidateAfterAuthentication.recoveryProof,
      quarantine: candidateAfterAuthentication.quarantine,
      replacement: candidateAfterAuthentication.fingerprint,
      healthIdentity: JSON.stringify({
        pid: authenticated.pid,
        version: authenticated.version,
        storageBackend: authenticated.storageBackend ?? "sqlite",
        ownerId: authenticated.ownerId ?? null,
        entrypoint: authenticated.entrypoint,
        runtimeDigest: authenticated.runtimeDigest,
      }),
    });
  }

  function recoveryReplacementSnapshotsMatch(
    left: OfflineRecoveryReplacementSnapshot,
    right: OfflineRecoveryReplacementSnapshot,
  ): boolean {
    return offlineStateFileProofMatches(left.recoveryProof, right.recoveryProof)
      && offlineQuarantineEvidenceMatches(left.quarantine, right.quarantine)
      && offlineFingerprintsMatch(left.replacement, right.replacement)
      && left.healthIdentity === right.healthIdentity;
  }

  type OfflineRecoveryEvidenceState =
    | { kind: "ordinary" }
    | { kind: "interrupted" }
    | { kind: "invalid"; reason: string }
    | {
      kind: "recovery";
      record: OfflineRecoveryRecordRead & { kind: "valid" };
      quarantine: OfflineQuarantineEvidence;
    };

  type PreparedOfflineRecovery = Readonly<{
    record: OfflineRecoveryRecordRead & { kind: "valid" };
    quarantine: OfflineReplacementStartupQuarantine;
  }>;

  type ReplacementStartupState =
    | Readonly<{ kind: "ordinary" }>
    | Readonly<{ kind: "prepared"; recovery: PreparedOfflineRecovery }>
    | Readonly<{ kind: "reconciled"; result: EnsureDaemonResult }>;

  function preparedOfflineRecovery(
    record: OfflineRecoveryRecordRead & { kind: "valid" },
    preparation: OfflineStatePreparationResult & { kind: "prepared" },
  ): PreparedOfflineRecovery {
    return Object.freeze({
      record,
      quarantine: preparation.quarantineProof === undefined
        ? { kind: "absent" }
        : { kind: "original-pid", proof: preparation.quarantineProof },
    });
  }

  function quarantineEvidenceForRecord(
    record: OfflineRecoveryRecordRead & { kind: "valid" },
  ): OfflineQuarantineEvidence | null {
    const backup = readOfflineRecoveryRecord(
      recoveryPaths.quarantinePath,
      record.record.fingerprint.uid,
    );
    if (backup.kind === "absent") return { kind: "absent" };
    if (backup.kind === "valid") {
      return backup.bytes === record.bytes
        && recoveryRecordMatchesCurrentOperation(backup.record)
        ? { kind: "record-backup", record: backup }
        : null;
    }
    const originalProof = readOfflineStateFileProof(
      recoveryPaths.quarantinePath,
      record.record.fingerprint.uid,
      {
        readContent: true,
        requirePrivate: false,
        maxBytes: MAX_OFFLINE_PID_BYTES,
      },
    );
    if (
      originalProof !== null
      && offlineStateFileProofSurvivedRename(record.record.fingerprint.pidFile, originalProof)
    ) {
      return { kind: "original-pid", proof: originalProof };
    }
    const linkedQuarantine = readOfflineStateFileProof(
      recoveryPaths.quarantinePath,
      record.record.fingerprint.uid,
      {
        readContent: true,
        requirePrivate: false,
        expectedLinks: 2,
        maxBytes: MAX_OFFLINE_PID_BYTES,
      },
    );
    const linkedCanonical = readOfflineStateFileProof(
      opts.pidFilePath,
      record.record.fingerprint.uid,
      {
        readContent: true,
        requirePrivate: false,
        expectedLinks: 2,
        maxBytes: MAX_OFFLINE_PID_BYTES,
      },
    );
    return linkedQuarantine !== null
      && linkedCanonical !== null
      && offlineStateFileProofIsLinkedQuarantineTransition(
        record.record.fingerprint.pidFile,
        linkedCanonical,
        linkedQuarantine,
      )
      ? { kind: "original-pid", proof: linkedQuarantine }
      : null;
  }

  function inspectOrRepairRecoveryEvidence(): OfflineRecoveryEvidenceState {
    if (currentUid === undefined) {
      return offlineRecoveryLeafIsPresent(recoveryPaths.recordPath)
        || offlineRecoveryLeafIsPresent(recoveryPaths.quarantinePath)
        ? { kind: "invalid", reason: "current UID is unavailable" }
        : { kind: "ordinary" };
    }
    let record = readOfflineRecoveryRecord(recoveryPaths.recordPath, currentUid);
    const backup = readOfflineRecoveryRecord(recoveryPaths.quarantinePath, currentUid);
    if (record.kind === "absent" && backup.kind === "absent") return { kind: "ordinary" };
    if (record.kind !== "valid" && backup.kind === "valid") {
      if (!recoveryRecordMatchesCurrentOperation(backup.record)) {
        return { kind: "invalid", reason: "recovery backup does not match current configuration" };
      }
      const durableBackup = durablyRevalidateOfflineRecoveryRecord(backup);
      if (durableBackup === null) {
        return { kind: "invalid", reason: "recovery backup is not durably authenticated" };
      }
      recoveryBoundary("before-record-repair");
      if (opts._abortSignal?.aborted) return { kind: "interrupted" };
      if (record.kind === "invalid") {
        if (
          record.proof === undefined
          || !runOfflineUnlinkSeam(
            opts._offlineRecordUnlinkOverride,
            recoveryPaths.recordPath,
          )
        ) {
          return { kind: "invalid", reason: "invalid recovery record cannot be repaired safely" };
        }
        if (opts._abortSignal?.aborted) return { kind: "interrupted" };
        const backupBeforeRepair = readExactOfflineRecoveryRecordAt(
          durableBackup,
          recoveryPaths.quarantinePath,
        );
        const invalidRecordUnlink = backupBeforeRepair !== null
          ? heldOfflineLeafProofToUnlink(
              record.proof,
              durableBackup.record.fingerprint.stateDirectory,
            )
          : null;
        if (
          backupBeforeRepair === null
          || invalidRecordUnlink?.kind !== "durable"
        ) {
          return { kind: "invalid", reason: "invalid recovery record cannot be repaired safely" };
        }
      }
      const repaired = writeExactRecoveryRecordLeaf(
        recoveryPaths.recordPath,
        durableBackup.bytes,
        durableBackup.record.fingerprint,
      );
      if (repaired === null) {
        return { kind: "invalid", reason: "recovery record repair failed; backup remains authoritative" };
      }
      recoveryBoundary("after-record-repair");
      if (opts._abortSignal?.aborted) return { kind: "interrupted" };
      const exactBackup = readExactOfflineRecoveryRecordAt(
        durableBackup,
        recoveryPaths.quarantinePath,
      );
      if (exactBackup === null || exactBackup.bytes !== repaired.bytes) {
        return { kind: "invalid", reason: "recovery authority changed during record repair" };
      }
      record = repaired;
    }
    if (record.kind !== "valid") {
      return { kind: "invalid", reason: "recovery evidence is missing or malformed" };
    }
    if (!recoveryRecordMatchesCurrentOperation(record.record)) {
      return { kind: "invalid", reason: "recovery record does not match current configuration" };
    }
    const quarantine = quarantineEvidenceForRecord(record);
    if (quarantine === null) {
      return { kind: "invalid", reason: "recovery record and quarantine roles conflict" };
    }
    return { kind: "recovery", record, quarantine };
  }

  async function finalizeOfflineRecovery(
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
    requiredQuarantine: OfflineQuarantineEvidence,
    replacementPid: number,
  ): Promise<
    | { ok: true; authority: OfflineRecoveryFinalAuthority }
    | { ok: false; reason: string; authority: "record" | "backup" | "indeterminate" }
  > {
    recoveryBoundary("after-replacement-readiness");
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "recovery finalization was interrupted", authority: "record" };
    }
    const beforeFinalize = await captureAuthenticatedReplacementSnapshot(
      recovery,
      requiredQuarantine,
      replacementPid,
    );
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "recovery finalization was interrupted", authority: "record" };
    }
    if (beforeFinalize === null) {
      return {
        ok: false,
        reason: "replacement could not be independently authenticated",
        authority: "record",
      };
    }
    opts._offlineRecoveryFinalizeOverride?.();
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "recovery finalization was interrupted", authority: "record" };
    }
    const afterFinalize = await captureAuthenticatedReplacementSnapshot(
      recovery,
      requiredQuarantine,
      replacementPid,
    );
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "recovery finalization was interrupted", authority: "record" };
    }
    if (
      afterFinalize === null
      || !recoveryReplacementSnapshotsMatch(beforeFinalize, afterFinalize)
    ) {
      return {
        ok: false,
        reason: "recovery evidence changed across finalization",
        authority: "record",
      };
    }

    let currentSnapshot = afterFinalize;
    const quarantine = afterFinalize.quarantine;
    type ExactRecoveryBackup = Readonly<{
      kind: "record-backup";
      record: OfflineRecoveryRecordRead & { kind: "valid" };
    }>;
    let exactRecoveryBackup: ExactRecoveryBackup;
    if (quarantine.kind === "record-backup") {
      exactRecoveryBackup = Object.freeze({
        kind: "record-backup",
        record: quarantine.record,
      });
    } else {
      if (quarantine.kind === "original-pid") {
        recoveryBoundary("before-quarantine-cleanup");
        if (opts._abortSignal?.aborted) {
          return { ok: false, reason: "PID quarantine cleanup was interrupted", authority: "record" };
        }
        if (!runOfflineUnlinkSeam(
          opts._offlinePidUnlinkOverride,
          recoveryPaths.quarantinePath,
        )) {
          return { ok: false, reason: "PID quarantine cleanup failed", authority: "record" };
        }
        if (opts._abortSignal?.aborted) {
          return { ok: false, reason: "PID quarantine cleanup was interrupted", authority: "record" };
        }
        const beforeOriginalCleanup = await captureAuthenticatedReplacementSnapshot(
          recovery,
          quarantine,
          replacementPid,
        );
        if (opts._abortSignal?.aborted) {
          return { ok: false, reason: "PID quarantine cleanup was interrupted", authority: "record" };
        }
        const originalQuarantineUnlink = beforeOriginalCleanup !== null
          && recoveryReplacementSnapshotsMatch(currentSnapshot, beforeOriginalCleanup)
          && beforeOriginalCleanup.quarantine.kind === "original-pid"
          ? heldOfflineLeafProofToUnlink(
              beforeOriginalCleanup.quarantine.proof,
              recovery.record.fingerprint.stateDirectory,
            )
          : null;
        if (
          beforeOriginalCleanup === null
          || !recoveryReplacementSnapshotsMatch(currentSnapshot, beforeOriginalCleanup)
          || beforeOriginalCleanup.quarantine.kind !== "original-pid"
          || originalQuarantineUnlink?.kind !== "durable"
        ) {
          return {
            ok: false,
            reason: `PID quarantine changed at ${recoveryPaths.quarantinePath}`,
            authority: "record",
          };
        }
        recoveryBoundary("after-quarantine-cleanup");
        if (opts._abortSignal?.aborted) {
          return { ok: false, reason: "PID quarantine cleanup was interrupted", authority: "record" };
        }
        const afterQuarantineCleanup = await captureAuthenticatedReplacementSnapshot(
          recovery,
          { kind: "absent" },
          replacementPid,
        );
        if (opts._abortSignal?.aborted) {
          return { ok: false, reason: "PID quarantine cleanup was interrupted", authority: "record" };
        }
        if (
          afterQuarantineCleanup === null
          || !offlineStateFileProofMatches(
            currentSnapshot.recoveryProof,
            afterQuarantineCleanup.recoveryProof,
          )
          || !offlineFingerprintsMatch(
            currentSnapshot.replacement,
            afterQuarantineCleanup.replacement,
          )
          || currentSnapshot.healthIdentity !== afterQuarantineCleanup.healthIdentity
        ) {
          return {
            ok: false,
            reason: "replacement evidence changed during quarantine cleanup",
            authority: "record",
          };
        }
        currentSnapshot = afterQuarantineCleanup;
      }

      recoveryBoundary("before-final-backup-create");
      if (opts._abortSignal?.aborted) {
        return { ok: false, reason: "recovery backup creation was interrupted", authority: "record" };
      }
      const beforeBackupCreate = await captureAuthenticatedReplacementSnapshot(
        recovery,
        { kind: "absent" },
        replacementPid,
      );
      if (opts._abortSignal?.aborted) {
        return { ok: false, reason: "recovery backup creation was interrupted", authority: "record" };
      }
      if (
        beforeBackupCreate === null
        || !recoveryReplacementSnapshotsMatch(currentSnapshot, beforeBackupCreate)
      ) {
        return { ok: false, reason: "replacement changed before backup creation", authority: "record" };
      }
      const backup = writeExactRecoveryRecordLeaf(
        recoveryPaths.quarantinePath,
        recovery.bytes,
        recovery.record.fingerprint,
      );
      if (backup === null) {
        return { ok: false, reason: "recovery backup creation failed", authority: "record" };
      }
      recoveryBoundary("after-final-backup-create");
      if (opts._abortSignal?.aborted) {
        return { ok: false, reason: "recovery backup creation was interrupted", authority: "record" };
      }
      const createdQuarantine: OfflineQuarantineEvidence = {
        kind: "record-backup",
        record: backup,
      };
      const afterBackupCreate = await captureAuthenticatedReplacementSnapshot(
        recovery,
        createdQuarantine,
        replacementPid,
      );
      if (opts._abortSignal?.aborted) {
        return { ok: false, reason: "recovery backup creation was interrupted", authority: "record" };
      }
      if (
        afterBackupCreate === null
        || !offlineFingerprintsMatch(currentSnapshot.replacement, afterBackupCreate.replacement)
        || currentSnapshot.healthIdentity !== afterBackupCreate.healthIdentity
        || !offlineStateFileProofMatches(currentSnapshot.recoveryProof, afterBackupCreate.recoveryProof)
      ) {
        return { ok: false, reason: "replacement changed during backup creation", authority: "record" };
      }
      currentSnapshot = afterBackupCreate;
      exactRecoveryBackup = Object.freeze({
        kind: "record-backup",
        record: backup,
      });
    }

    recoveryBoundary("before-record-proof");
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "recovery record cleanup was interrupted", authority: "record" };
    }
    const beforeRecordCleanup = await captureAuthenticatedReplacementSnapshot(
      recovery,
      exactRecoveryBackup,
      replacementPid,
    );
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "recovery record cleanup was interrupted", authority: "record" };
    }
    if (beforeRecordCleanup === null) {
      return { ok: false, reason: "replacement changed before record cleanup", authority: "record" };
    }
    recoveryBoundary("before-record-cleanup");
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "recovery record cleanup was interrupted", authority: "record" };
    }
    if (!runOfflineUnlinkSeam(
      opts._offlineRecordUnlinkOverride,
      recoveryPaths.recordPath,
    )) {
      return { ok: false, reason: "recovery record cleanup failed", authority: "record" };
    }
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "recovery record cleanup was interrupted", authority: "record" };
    }
    const afterRecordCleanupSeam = await captureAuthenticatedReplacementSnapshot(
      recovery,
      exactRecoveryBackup,
      replacementPid,
    );
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "recovery record cleanup was interrupted", authority: "record" };
    }
    const exactRecord = readExactOfflineRecoveryRecord(recovery);
    const recordUnlink = afterRecordCleanupSeam !== null
      && recoveryReplacementSnapshotsMatch(beforeRecordCleanup, afterRecordCleanupSeam)
      && exactRecord !== null
      ? heldOfflineLeafProofToUnlink(
          exactRecord.proof,
          recovery.record.fingerprint.stateDirectory,
        )
      : null;
    if (
      afterRecordCleanupSeam === null
      || !recoveryReplacementSnapshotsMatch(beforeRecordCleanup, afterRecordCleanupSeam)
      || exactRecord === null
      || recordUnlink?.kind !== "durable"
    ) {
      return {
        ok: false,
        reason: "recovery record cleanup failed",
        authority: recordUnlink !== null && recordUnlink.kind !== "refused"
          ? "backup"
          : "record",
      };
    }
    recoveryBoundary("after-record-cleanup");
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "recovery record cleanup was interrupted", authority: "backup" };
    }
    const backupAuthority = readExactOfflineRecoveryRecordAt(
      exactRecoveryBackup.record,
      recoveryPaths.quarantinePath,
    );
    if (backupAuthority === null) {
      return { ok: false, reason: "recovery backup authority changed", authority: "backup" };
    }
    const afterRecordCleanup = await captureAuthenticatedReplacementSnapshot(
      backupAuthority,
      { kind: "record-backup", record: backupAuthority },
      replacementPid,
      recoveryPaths.quarantinePath,
      true,
    );
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "recovery record cleanup was interrupted", authority: "backup" };
    }
    if (
      afterRecordCleanup === null
      || !offlineFingerprintsMatch(afterRecordCleanupSeam.replacement, afterRecordCleanup.replacement)
      || afterRecordCleanupSeam.healthIdentity !== afterRecordCleanup.healthIdentity
    ) {
      return { ok: false, reason: "replacement changed after record cleanup", authority: "backup" };
    }

    recoveryBoundary("before-final-backup-cleanup");
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "final recovery cleanup was interrupted", authority: "backup" };
    }
    if (!runOfflineUnlinkSeam(
      opts._offlineRecoveryBackupUnlinkOverride,
      recoveryPaths.quarantinePath,
    )) {
      return { ok: false, reason: "final recovery backup cleanup failed", authority: "backup" };
    }
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "final recovery cleanup was interrupted", authority: "backup" };
    }
    const finalBackup = readExactOfflineRecoveryRecordAt(
      backupAuthority,
      recoveryPaths.quarantinePath,
    );
    const finalSnapshot = finalBackup === null
      ? null
      : await captureAuthenticatedReplacementSnapshot(
        finalBackup,
        { kind: "record-backup", record: finalBackup },
        replacementPid,
        recoveryPaths.quarantinePath,
        true,
      );
    if (opts._abortSignal?.aborted) {
      return { ok: false, reason: "final recovery cleanup was interrupted", authority: "backup" };
    }
    if (
      finalBackup === null
      || finalSnapshot === null
      || !recoveryReplacementSnapshotsMatch(afterRecordCleanup, finalSnapshot)
    ) {
      return { ok: false, reason: "final recovery backup cleanup failed", authority: "backup" };
    }
    const finalBackupUnlink = heldOfflineLeafProofToUnlink(
      finalBackup.proof,
      recovery.record.fingerprint.stateDirectory,
    );
    if (finalBackupUnlink.kind === "durable") {
      return {
        ok: true,
        authority: Object.freeze({
          kind: "clean",
          recordPath: recoveryPaths.recordPath,
          quarantinePath: recoveryPaths.quarantinePath,
          recoveryBytes: recovery.bytes,
          originalFingerprint: recovery.record.fingerprint,
          replacementFingerprint: finalSnapshot.replacement,
          recordUnlink: "durable",
          quarantineUnlink: "durable",
        }),
      };
    }
    if (finalBackupUnlink.kind === "refused") {
      return { ok: false, reason: finalBackupUnlink.reason, authority: "backup" };
    }
    const restoredBackup = writeExactRecoveryRecordLeaf(
      recoveryPaths.quarantinePath,
      recovery.bytes,
      recovery.record.fingerprint,
    );
    if (restoredBackup === null || restoredBackup.bytes !== recovery.bytes) {
      return {
        ok: false,
        reason: `${finalBackupUnlink.reason}; recovery-marker authority and cleanup durability are indeterminate`,
        authority: "indeterminate",
      };
    }
    return {
      ok: true,
      authority: Object.freeze({
        kind: "warning",
        recordPath: recoveryPaths.recordPath,
        quarantinePath: recoveryPaths.quarantinePath,
        replacementFingerprint: finalSnapshot.replacement,
        backup: restoredBackup,
        warning: "replacement is ready, but final cleanup durability was uncertain; an exact authenticated quarantine recovery backup was durably restored and will block generic lifecycle operations until explicit restart reconciliation",
      }),
    };
  }

  type OfflineReadinessPrimitives = Readonly<{
    connected: boolean;
    port: number;
    spawned: boolean;
    pid: number | undefined;
    parentPid: number | undefined;
    userSystemdPid: number | undefined;
    restartedForParent: boolean | undefined;
    startMethod: EnsureDaemonResult["startMethod"];
    warning: string | undefined;
  }>;

  function captureOfflineReadinessPrimitives(
    result: EnsureDaemonResult,
  ): OfflineReadinessPrimitives {
    return Object.freeze({
      connected: result.connected,
      port: result.port,
      spawned: result.spawned,
      pid: result.pid,
      parentPid: result.parentPid,
      userSystemdPid: result.userSystemdPid,
      restartedForParent: result.restartedForParent,
      startMethod: result.startMethod,
      warning: result.warning,
    });
  }

  function buildOfflineRestartResult(
    readiness: OfflineReadinessPrimitives,
    connected: boolean,
    restartedResult: boolean,
    stopped: number,
    warning: string | undefined,
  ): RestartDaemonResult {
    const result: RestartDaemonResult = {
      connected,
      port: readiness.port,
      spawned: readiness.spawned,
      restarted: restartedResult,
      stoppedPid: stopped,
    };
    if (readiness.pid !== undefined) result.pid = readiness.pid;
    if (readiness.parentPid !== undefined) result.parentPid = readiness.parentPid;
    if (readiness.userSystemdPid !== undefined) {
      result.userSystemdPid = readiness.userSystemdPid;
    }
    if (readiness.restartedForParent !== undefined) {
      result.restartedForParent = readiness.restartedForParent;
    }
    if (readiness.startMethod !== undefined) result.startMethod = readiness.startMethod;
    if (warning !== undefined) result.warning = warning;
    return result;
  }

  function exactDurableRecoveryAuthorityAt(
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
    path: string,
  ): (OfflineRecoveryRecordRead & { kind: "valid" }) | null {
    const current = readOfflineRecoveryRecordMatchingBytes(
      path,
      recovery.record.fingerprint.uid,
      recovery.bytes,
    );
    if (
      current === null
      || !offlineFingerprintsMatch(
        current.record.fingerprint,
        recovery.record.fingerprint,
      )
      || !recoveryRecordMatchesCurrentOperation(current.record)
    ) {
      return null;
    }
    return durablyRevalidateOfflineRecoveryRecord(current);
  }

  function currentOfflineRecoveryAuthority(
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
  ): "record" | "backup" | "indeterminate" {
    if (exactDurableRecoveryAuthorityAt(recovery, recoveryPaths.recordPath) !== null) {
      return "record";
    }
    if (
      offlineDirectPathIsAbsent(recoveryPaths.recordPath)
      && exactDurableRecoveryAuthorityAt(recovery, recoveryPaths.quarantinePath) !== null
    ) {
      return "backup";
    }
    return "indeterminate";
  }

  function restoreOfflineRecoveryAuthority(
    recovery: OfflineRecoveryRecordRead & { kind: "valid" },
  ): "record" | "backup" | "indeterminate" {
    const current = currentOfflineRecoveryAuthority(recovery);
    if (current !== "indeterminate") return current;
    if (
      !offlineDirectPathIsAbsent(recoveryPaths.recordPath)
      || !offlineDirectPathIsAbsent(recoveryPaths.quarantinePath)
    ) {
      return "indeterminate";
    }
    const restored = writeExactRecoveryRecordLeaf(
      recoveryPaths.quarantinePath,
      recovery.bytes,
      recovery.record.fingerprint,
    );
    return restored !== null
      && restored.bytes === recovery.bytes
      && durablyRevalidateOfflineRecoveryRecord(restored) !== null
      && offlineDirectPathIsAbsent(recoveryPaths.recordPath)
      ? "backup"
      : "indeterminate";
  }
  const killProcess = dependencies.killProcess;
  const sleepFn = dependencies.sleep;
  let restarted = false;
  let stoppedPid: number | undefined;
  let usedOfflineRecovery = false;
  let activeRecovery: (OfflineRecoveryRecordRead & { kind: "valid" }) | undefined;
  let activeQuarantine: OfflineQuarantineEvidence = { kind: "absent" };
  let replacementStartup: ReplacementStartupState = { kind: "ordinary" };

  const recoveryAtStart = inspectOrRepairRecoveryEvidence();
  if (recoveryAtStart.kind === "interrupted") {
    return {
      connected: false,
      port: opts.port,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle was interrupted while reconciling durable offline restart evidence",
    };
  }
  if (recoveryAtStart.kind === "invalid") {
    throw new Error(
      `Offline restart recovery evidence is malformed, conflicting, or untrusted: ${recoveryAtStart.reason}; preserve ${recoveryPaths.recordPath} and ${recoveryPaths.quarantinePath} and retry only after correcting the conflict.`,
    );
  }

  if (recoveryAtStart.kind === "recovery") {
    const durableRecovery = durablyRevalidateOfflineRecoveryRecord(recoveryAtStart.record);
    if (durableRecovery === null) {
      throw new Error(
        `Offline restart recovery record could not be durably revalidated at ${recoveryPaths.recordPath}; preserve it and retry lcm daemon restart.`,
      );
    }
    activeRecovery = durableRecovery;
    usedOfflineRecovery = true;
    restarted = true;
    stoppedPid = durableRecovery.record.fingerprint.pid;
    const fingerprint = durableRecovery.record.fingerprint;
    activeQuarantine = recoveryAtStart.quarantine;
    const canonicalProof = readOfflineStateFileProof(
      opts.pidFilePath,
      fingerprint.uid,
      { readContent: true, requirePrivate: false, maxBytes: MAX_OFFLINE_PID_BYTES },
    );
    const birth = linuxProcessBirthState(
      fingerprint.pid,
      procRoot,
      fingerprint.processStartTime,
      fingerprint.uid,
    );
    if (birth.kind === "unreadable" || birth.kind === "reused") {
      throw new Error(
        `Offline restart recovery cannot prove original PID ${fingerprint.pid} is exact or gone; preserve all recovery evidence.`,
      );
    }
    if (birth.kind === "exact") {
      const signalProof = captureOfflineRestartSignalProof(fingerprint.pid);
      if (
        canonicalProof === null
        || !offlineStateFileProofMatches(fingerprint.pidFile, canonicalProof)
        || signalProof === null
        || !offlineFingerprintsMatch(fingerprint, signalProof.fingerprint)
        || activeQuarantine.kind === "original-pid"
      ) {
        throw new Error(
          `Offline restart recovery evidence is ambiguous while original PID ${fingerprint.pid} is still alive; preserve ${recoveryPaths.recordPath} and ${recoveryPaths.quarantinePath}.`,
        );
      }
      const stopped = await stopOfflineVerifiedDaemon(signalProof, durableRecovery);
      if (stopped.kind === "interrupted") {
        return {
          connected: false,
          port: opts.port,
          spawned: false,
          restarted: false,
          warning: `daemon lifecycle was interrupted during offline restart recovery; recovery record retained at ${recoveryPaths.recordPath}`,
        };
      }
      if (stopped.kind === "refused") {
        throw new Error(`Offline restart recovery refused for PID ${fingerprint.pid}: ${stopped.reason}.`);
      }
      activeQuarantine = { kind: "absent" };
    }
    const canonicalAfterStop = readOfflineStateFileProof(
      opts.pidFilePath,
      fingerprint.uid,
      { readContent: true, requirePrivate: false, maxBytes: MAX_OFFLINE_PID_BYTES },
    );
    const isOriginalCanonical = canonicalAfterStop !== null
      && offlineStateFileProofMatches(fingerprint.pidFile, canonicalAfterStop);
    const isLinkedOriginalCanonical = canonicalAfterStop !== null
      && activeQuarantine.kind === "original-pid"
      && offlineStateFileProofIsLinkedQuarantineTransition(
        fingerprint.pidFile,
        canonicalAfterStop,
        activeQuarantine.proof,
      );
    if (canonicalAfterStop === null || isOriginalCanonical || isLinkedOriginalCanonical) {
      if (activeQuarantine.kind === "record-backup") {
        const removed = removeRecoveryBackupBeforeSignal(durableRecovery);
        if (removed.kind === "interrupted") {
          return {
            connected: false,
            port: opts.port,
            spawned: false,
            restarted: false,
            warning: "daemon lifecycle was interrupted while reconciling recovery backup evidence",
          };
        }
        if (removed.kind === "refused") {
          throw new Error(`Offline restart recovery refused: ${removed.reason}.`);
        }
        activeQuarantine = { kind: "absent" };
      }
      const preparation = prepareStoppedOfflineState(fingerprint, durableRecovery);
      if (preparation.kind === "interrupted") {
        return {
          connected: false,
          port: opts.port,
          spawned: false,
          restarted: false,
          warning: `daemon lifecycle was interrupted during offline restart recovery; ${preparation.reason ?? `recovery record retained at ${recoveryPaths.recordPath}`}`,
        };
      }
      if (preparation.kind === "refused") {
        throw new Error(
          `Offline restart recovery refused for PID ${fingerprint.pid}: ${preparation.reason}.`,
        );
      }
      const prepared = preparedOfflineRecovery(durableRecovery, preparation);
      replacementStartup = { kind: "prepared", recovery: prepared };
      activeQuarantine = prepared.quarantine;
    } else {
      const candidate = await captureAuthenticatedReplacementSnapshot(
        durableRecovery,
        activeQuarantine,
      );
      if (candidate === null) {
        throw new Error(
          `Offline restart recovery found an unauthenticated or ambiguous replacement; preserve ${recoveryPaths.recordPath} and ${recoveryPaths.quarantinePath}.`,
        );
      }
      replacementStartup = {
        kind: "reconciled",
        result: {
          connected: true,
          port: opts.port,
          spawned: false,
          pid: candidate.replacement.pid,
          startMethod: "existing",
        },
      };
    }
  }

  const pid = activeRecovery ? null : readOwnedPid();
  if (!activeRecovery && pid === null) {
    cleanOwnedPid();
  } else if (!activeRecovery && pid !== null && !isAlive(pid)) {
    cleanOwnedPid();
  } else if (!activeRecovery && pid !== null) {
    const inspection = await inspectManagedDaemon(pid);
    if (inspection === "refused") {
      throw new Error(`Refusing to restart: PID ${pid} is running but is not a verified LCM daemon.`);
    }
    if (inspection === "no-response") {
      if (opts._abortSignal?.aborted) {
        return {
          connected: false,
          port: opts.port,
          spawned: false,
          restarted: false,
          warning: "daemon lifecycle was interrupted before startup",
        };
      }
      const signalProof = captureOfflineRestartSignalProof(pid);
      if (signalProof === null) {
        throw new Error(
          `Refusing to restart: PID ${pid} is not a verified LCM daemon because it did not return an HTTP response and its complete offline identity could not be verified.`,
        );
      }
      const fingerprint = signalProof.fingerprint;
      const createdRecovery = createOfflineRecoveryRecord(fingerprint);
      if (createdRecovery.kind === "interrupted") {
        return {
          connected: false,
          port: opts.port,
          spawned: false,
          restarted: false,
          warning: "daemon lifecycle was interrupted while creating durable offline restart evidence",
        };
      }
      if (createdRecovery.kind !== "valid") {
        throw new Error(
          `Offline restart recovery could not create and durably authenticate ${recoveryPaths.recordPath}; preserve any evidence and retry lcm daemon restart.`,
        );
      }
      activeRecovery = createdRecovery.record;
      const stopped = await stopOfflineVerifiedDaemon(signalProof, createdRecovery.record);
      if (stopped.kind === "interrupted") {
        return {
          connected: false,
          port: opts.port,
          spawned: false,
          restarted: false,
          warning: `daemon lifecycle was interrupted during offline restart recovery; recovery record retained at ${recoveryPaths.recordPath}`,
        };
      }
      if (stopped.kind === "refused") {
        throw new Error(`Offline restart recovery refused for PID ${pid}: ${stopped.reason}.`);
      }
      const preparation = prepareStoppedOfflineState(fingerprint, createdRecovery.record);
      if (preparation.kind === "interrupted") {
        const interruptionWarning = "daemon lifecycle was interrupted during offline restart recovery";
        return {
          connected: false,
          port: opts.port,
          spawned: false,
          restarted: false,
          warning: preparation.reason
            ? `${interruptionWarning}; ${preparation.reason}`
            : interruptionWarning,
        };
      }
      if (preparation.kind === "refused") {
        throw new Error(`Offline restart recovery refused for PID ${pid}: ${preparation.reason}.`);
      }
      const prepared = preparedOfflineRecovery(createdRecovery.record, preparation);
      replacementStartup = { kind: "prepared", recovery: prepared };
      activeQuarantine = prepared.quarantine;
      restarted = true;
      stoppedPid = pid;
      usedOfflineRecovery = true;
    } else {
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
      await terminatePid(pid, { isAlive, killProcess, sleepFn });
      if (isAlive(pid)) {
        throw new Error(`Unable to stop verified LCM daemon PID ${pid}; restart aborted.`);
      }
      cleanOwnedPid();
      restarted = true;
      stoppedPid = pid;
    }
  }

  assertCurrentScopedState();
  let result: EnsureDaemonResult;
  if (replacementStartup.kind === "reconciled") {
    result = replacementStartup.result;
  } else {
    let recoveryAuthorization: OfflineRecoveryEnsureAuthorization | undefined;
    if (replacementStartup.kind === "prepared") {
      const preparedRecovery = replacementStartup.recovery;
      recoveryBoundary("before-replacement-startup");
      if (opts._abortSignal?.aborted) {
        return {
          connected: false,
          port: opts.port,
          spawned: false,
          restarted: false,
          stoppedPid,
          warning: "daemon lifecycle was interrupted before replacement startup",
        };
      }
      const exactRecovery = readExactOfflineRecoveryRecord(preparedRecovery.record);
      const beforeAuthorization = buildOfflineRecoveryEnsureAuthorization(
        preparedRecovery.record,
        preparedRecovery.quarantine,
      );
      if (exactRecovery === null || beforeAuthorization === null) {
        throw new Error(
          `Offline restart recovery evidence changed before replacement startup at ${recoveryPaths.recordPath}.`,
        );
      }
      recoveryBoundary("before-authorized-ensure");
      if (opts._abortSignal?.aborted) {
        return {
          connected: false,
          port: opts.port,
          spawned: false,
          restarted: false,
          stoppedPid,
          warning: "daemon lifecycle was interrupted before authorized replacement startup",
        };
      }
      recoveryAuthorization = buildOfflineRecoveryEnsureAuthorization(
        preparedRecovery.record,
        preparedRecovery.quarantine,
      ) ?? undefined;
      if (recoveryAuthorization === undefined || !recoveryAuthorization.validateStopped()) {
        throw new Error(
          `Offline restart recovery evidence changed at the final replacement-startup boundary.`,
        );
      }
    }
    if (_ensureDaemonOverride) {
      result = await _ensureDaemonOverride(ensureOptions);
    } else {
      if (recoveryAuthorization !== undefined) {
        offlineRecoveryEnsureAuthorizations.set(ensureOptions, recoveryAuthorization);
      }
      result = await ensureDaemonImpl(ensureOptions);
    }
  }
  if (usedOfflineRecovery) {
    const offlineStoppedPid = stoppedPid as number;
    const readiness = captureOfflineReadinessPrimitives(result);
    const terminalAbortSignal = opts._abortSignal;
    if (terminalAbortSignal?.aborted) {
      return buildOfflineRestartResult(
        readiness,
        false,
        false,
        offlineStoppedPid,
        "daemon lifecycle was interrupted before restart success publication",
      );
    }
    if (!readiness.connected) {
      return buildOfflineRestartResult(
        readiness,
        false,
        false,
        offlineStoppedPid,
        readiness.warning
          ? `offline restart stopped PID ${offlineStoppedPid}, but replacement readiness failed: ${readiness.warning}`
          : `offline restart stopped PID ${offlineStoppedPid}, but replacement readiness failed`,
      );
    }
    if (activeRecovery === undefined || readiness.pid === undefined) {
      return buildOfflineRestartResult(
        readiness,
        false,
        false,
        offlineStoppedPid,
        "offline restart replacement is not publishable because its recovery record or replacement PID is unavailable; recovery-marker authority is indeterminate",
      );
    }
    const finalized = await finalizeOfflineRecovery(
      activeRecovery,
      activeQuarantine,
      readiness.pid,
    );
    if (!finalized.ok) {
      const currentAuthority = currentOfflineRecoveryAuthority(activeRecovery);
      const authoritySuffix = currentAuthority === "indeterminate"
        ? "recovery-marker authority or durability is indeterminate; retry explicit daemon restart without manually editing lifecycle state"
        : `exact durable recovery authority remains at ${currentAuthority === "record"
            ? recoveryPaths.recordPath
            : recoveryPaths.quarantinePath}`;
      return buildOfflineRestartResult(
        readiness,
        false,
        false,
        offlineStoppedPid,
        `offline restart replacement is not publishable because ${finalized.reason}; ${authoritySuffix}`,
      );
    }
    const finalWarning = finalized.authority.kind === "warning"
      ? readiness.warning
        ? `${readiness.warning}; ${finalized.authority.warning}`
        : finalized.authority.warning
      : readiness.warning;
    const prebuiltSuccess = buildOfflineRestartResult(
      readiness,
      true,
      true,
      offlineStoppedPid,
      finalWarning,
    );
    const terminalSeed = captureTerminalRecoveryAuthoritySeed(
      activeRecovery,
      finalized.authority,
      readiness,
      offlineStoppedPid,
    );
    const recordSuffix = `exact durable recovery authority remains at ${recoveryPaths.recordPath}`;
    const backupSuffix = `exact durable recovery backup was restored or preserved at ${recoveryPaths.quarantinePath}; generic lifecycle operations remain blocked until explicit restart reconciliation`;
    const indeterminateSuffix = "recovery-marker authority or durability is indeterminate; explicit restart is required and lifecycle state must not be edited manually";
    const terminalFailureResult = (
      failure: string,
      authority: string,
    ): RestartDaemonResult => buildOfflineRestartResult(
      readiness,
      false,
      false,
      offlineStoppedPid,
      `offline restart replacement is unavailable because ${failure}; ${authority}`,
    );
    const terminalFailures: TerminalFailureResults = Object.freeze({
      abortRecord: terminalFailureResult(
        "daemon lifecycle was interrupted at terminal restart publication",
        recordSuffix,
      ),
      abortBackup: terminalFailureResult(
        "daemon lifecycle was interrupted at terminal restart publication",
        backupSuffix,
      ),
      abortIndeterminate: terminalFailureResult(
        "daemon lifecycle was interrupted at terminal restart publication",
        indeterminateSuffix,
      ),
      boundaryRecord: terminalFailureResult(
        "terminal restart publication boundary failed",
        recordSuffix,
      ),
      boundaryBackup: terminalFailureResult(
        "terminal restart publication boundary failed",
        backupSuffix,
      ),
      boundaryIndeterminate: terminalFailureResult(
        "terminal restart publication boundary failed",
        indeterminateSuffix,
      ),
      proofRecord: terminalFailureResult(
        "terminal callback-free replacement and recovery-authority proof failed",
        recordSuffix,
      ),
      proofBackup: terminalFailureResult(
        "terminal callback-free replacement and recovery-authority proof failed",
        backupSuffix,
      ),
      proofIndeterminate: terminalFailureResult(
        "terminal callback-free replacement and recovery-authority proof failed",
        indeterminateSuffix,
      ),
    });
    if (terminalSeed === null) {
      const authority = restoreOfflineRecoveryAuthority(activeRecovery);
      return authority === "backup"
          ? terminalFailures.proofBackup
          : terminalFailures.proofIndeterminate;
    }
    let terminalAborted = terminalAbortSignal?.aborted === true;
    let terminalDetachAbort: (() => void) | undefined;
    if (terminalAbortSignal !== undefined) {
      const terminalAbortListener = (): void => {
        terminalAborted = true;
      };
      const terminalAttachAbort = terminalAbortAdd.bind(
        terminalAbortSignal,
        "abort",
        terminalAbortListener,
      );
      terminalDetachAbort = terminalAbortRemove.bind(
        terminalAbortSignal,
        "abort",
        terminalAbortListener,
      );
      terminalAttachAbort();
      if (terminalAbortSignal.aborted) terminalAborted = true;
    }
    let terminalBoundaryFailed = false;
    try {
      recoveryBoundary("before-terminal-restart-publication");
    } catch {
      terminalBoundaryFailed = true;
    }
    if (terminalDetachAbort !== undefined) {
      try {
        terminalDetachAbort();
      } catch {
        terminalBoundaryFailed = true;
      }
    }
    if (
      !terminalAborted
      && !terminalBoundaryFailed
      && terminalRecoveryProof(terminalSeed)
    ) {
      return prebuiltSuccess;
    }
    const restoredAuthority = terminalRestoreRecoveryAuthority(terminalSeed);
    if (terminalAborted) {
      return restoredAuthority === "record"
        ? terminalFailures.abortRecord
        : restoredAuthority === "backup"
          ? terminalFailures.abortBackup
          : terminalFailures.abortIndeterminate;
    }
    if (terminalBoundaryFailed) {
      return restoredAuthority === "record"
        ? terminalFailures.boundaryRecord
        : restoredAuthority === "backup"
          ? terminalFailures.boundaryBackup
          : terminalFailures.boundaryIndeterminate;
    }
    return restoredAuthority === "record"
      ? terminalFailures.proofRecord
      : restoredAuthority === "backup"
        ? terminalFailures.proofBackup
        : terminalFailures.proofIndeterminate;
  }
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
  readBoundedProcText,
  readOfflineStateFileProof,
  readLinuxProcessArgv,
  readLinuxProcessStartTime,
  readOfflineRecoveryRecord,
  readOfflineStateDirectoryProof,
  isOfflineRecoveryRecord,
  requireRegularFileDescriptor,
  resolveWindowsNetstatPath,
  resolveLifecycleDependencies,
  lifecycleUnitName,
  lifecycleSpawnEnvironment,
  linuxLoopbackListenerState,
  runCleanupStages,
  sha256File,
  startViaUserSystemd,
  sleep,
  systemdCredentialCleanup,
  systemdDaemonSetenvArgs,
  systemdDaemonCredentialArgs,
  systemdManagerProcessEnv,
  systemdRunProcessEnv,
};
