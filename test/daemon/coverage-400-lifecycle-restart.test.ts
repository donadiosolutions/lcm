import { randomBytes } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureDaemon as ensureDaemonProduction,
  restartDaemon as restartDaemonProduction,
} from "../../src/daemon/lifecycle.js";
import { cleanupManagedCredentialDirectory } from "../../src/daemon/managed-credentials.js";
import {
  createDaemonLifecycleTestScope,
  type DaemonLifecycleHermeticTestSeams,
  type DaemonLifecycleTestScope,
} from "../../src/daemon/lifecycle-scope.js";
import { managedDaemonPath } from "../../src/daemon/managed-path.js";
import {
  createSupervisor,
  managedLaunchEnvironmentDigest,
  SUPERVISOR_DAEMON_TEMP_CREATION_WARNING,
  SupervisorDaemonTempCreationError,
} from "../../src/daemon/supervisor.js";

type EnsureDaemonOptions = Parameters<typeof ensureDaemonProduction>[0];
type RestartDaemonOptions = Parameters<typeof restartDaemonProduction>[0];
type FetchOverride = NonNullable<EnsureDaemonOptions["_fetchOverride"]>;
type SpawnOverride = NonNullable<EnsureDaemonOptions["_spawnOverride"]>;
type SpawnSyncOverride = NonNullable<EnsureDaemonOptions["_spawnSyncOverride"]>;
type Supervisor = NonNullable<EnsureDaemonOptions["_supervisorOverride"]>;
type SupervisorSpec = Parameters<Supervisor["probe"]>[0];
type ManagedCredentialSnapshot = {
  directory: string;
  files: readonly { name: string; path: string }[];
};

const legacyPidFileFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  mode: undefined as
    | "missing"
    | "replacement"
    | "unsafe"
    | "close-error"
    | "hardlink-on-open"
    | "after-stop-validation-missing"
    | "after-stop-validation-dangling-symlink"
    | "former-cleanup-replacement"
    | "former-cleanup-symlink"
    | "former-cleanup-hardlink"
    | undefined,
  openCalls: 0,
  openFlags: [] as Array<number | string>,
  parentPath: undefined as string | undefined,
  parentStatCalls: 0,
  parentFault: undefined as
    | "first-missing"
    | "first-non-directory"
    | "missing"
    | "non-directory"
    | "device-change"
    | "inode-change"
    | undefined,
  leafLstatError: undefined as "EACCES" | undefined,
  preflightArmed: false,
  closeErrorDescriptor: undefined as number | undefined,
  closeAttempts: 0,
  formerCleanupDescriptor: undefined as number | undefined,
  unlinkCalls: 0,
}));
const legacyTokenFileFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  code: "ENOENT" as "ENOENT" | "EACCES",
  openCalls: 0,
  openFlags: [] as Array<number | string>,
  countOnly: false,
  hardlinkOnOpen: false,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (legacyPidFileFault.path !== undefined && String(args[0]) === legacyPidFileFault.path) {
        legacyPidFileFault.openCalls += 1;
        legacyPidFileFault.openFlags.push(args[1]);
        if (legacyPidFileFault.openCalls === 1 && legacyPidFileFault.mode === "hardlink-on-open") {
          actual.linkSync(legacyPidFileFault.path, `${legacyPidFileFault.path}.alias`);
        }
        if (legacyPidFileFault.openCalls === 2 && legacyPidFileFault.mode === "missing") {
          const error = new Error("PID file disappeared") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        if (legacyPidFileFault.openCalls === 2 && (legacyPidFileFault.mode === "replacement" || legacyPidFileFault.mode === "unsafe")) {
          const oldPath = `${legacyPidFileFault.path}.old`;
          actual.renameSync(legacyPidFileFault.path, oldPath);
          actual.writeFileSync(legacyPidFileFault.path, legacyPidFileFault.mode === "replacement" ? "9999" : "not-a-pid", { mode: 0o600 });
        }
      }
      if (legacyTokenFileFault.path !== undefined && String(args[0]) === legacyTokenFileFault.path) {
        legacyTokenFileFault.openCalls += 1;
        legacyTokenFileFault.openFlags.push(args[1]);
        if (legacyTokenFileFault.openCalls === 1 && legacyTokenFileFault.hardlinkOnOpen) {
          actual.linkSync(legacyTokenFileFault.path, `${legacyTokenFileFault.path}.alias`);
        }
        if (!legacyTokenFileFault.countOnly && legacyTokenFileFault.openCalls === 2) {
          const error = new Error("token evidence disappeared") as NodeJS.ErrnoException;
          error.code = legacyTokenFileFault.code;
          throw error;
        }
      }
      const descriptor = actual.openSync(...args);
      if (
        legacyPidFileFault.path !== undefined
        && String(args[0]) === legacyPidFileFault.path
        && legacyPidFileFault.mode === "close-error"
        && legacyPidFileFault.closeErrorDescriptor === undefined
      ) {
        legacyPidFileFault.closeErrorDescriptor = descriptor;
      }
      if (
        legacyPidFileFault.path !== undefined
        && String(args[0]) === legacyPidFileFault.path
        && legacyPidFileFault.openCalls === 4
        && legacyPidFileFault.mode?.startsWith("former-cleanup-") === true
      ) {
        legacyPidFileFault.formerCleanupDescriptor = descriptor;
      }
      return descriptor;
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (
        legacyPidFileFault.path !== undefined
        && legacyPidFileFault.parentPath !== undefined
        && String(args[0]) === legacyPidFileFault.parentPath
        && legacyPidFileFault.preflightArmed
        && legacyPidFileFault.openCalls === 0
        && (
          legacyPidFileFault.parentFault !== undefined
          || legacyPidFileFault.leafLstatError !== undefined
        )
      ) {
        legacyPidFileFault.parentStatCalls += 1;
        const faultCall = legacyPidFileFault.parentFault?.startsWith("first-") === true ? 1 : 2;
        if (
          legacyPidFileFault.parentStatCalls === faultCall
          && legacyPidFileFault.parentFault?.endsWith("missing") === true
        ) {
          const error = new Error("PID parent disappeared") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        const current = actual.statSync(...args);
        if (legacyPidFileFault.parentStatCalls === faultCall) {
          return new Proxy(current, {
            get: (target, property, receiver) => {
              if (
                property === "isDirectory"
                && legacyPidFileFault.parentFault?.endsWith("non-directory") === true
              ) {
                return () => false;
              }
              if (property === "dev" && legacyPidFileFault.parentFault === "device-change") {
                return Number(Reflect.get(target, property, receiver)) + 1;
              }
              if (property === "ino" && legacyPidFileFault.parentFault === "inode-change") {
                return Number(Reflect.get(target, property, receiver)) + 1;
              }
              return Reflect.get(target, property, receiver);
            },
          });
        }
        return current;
      }
      if (
        legacyPidFileFault.path !== undefined
        && String(args[0]) === legacyPidFileFault.path
        && legacyPidFileFault.mode === "after-stop-validation-missing"
        && legacyPidFileFault.openCalls === 4
      ) {
        actual.unlinkSync(legacyPidFileFault.path);
        const error = new Error("PID file disappeared during validation") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return actual.statSync(...args);
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (
        legacyPidFileFault.path !== undefined
        && String(args[0]) === legacyPidFileFault.path
        && legacyPidFileFault.leafLstatError !== undefined
        && legacyPidFileFault.preflightArmed
        && legacyPidFileFault.parentStatCalls > 0
      ) {
        const error = new Error("PID leaf lstat failed") as NodeJS.ErrnoException;
        error.code = legacyPidFileFault.leafLstatError;
        throw error;
      }
      return actual.lstatSync(...args);
    },
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
      if (
        legacyPidFileFault.path !== undefined
        && String(args[0]) === legacyPidFileFault.path
        && legacyPidFileFault.mode === "after-stop-validation-dangling-symlink"
        && legacyPidFileFault.openCalls === 4
      ) {
        const openedPath = `${legacyPidFileFault.path}.opened`;
        actual.renameSync(legacyPidFileFault.path, openedPath);
        actual.symlinkSync(`${legacyPidFileFault.path}.missing-target`, legacyPidFileFault.path);
      }
      return actual.realpathSync(...args);
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      if (args[0] === legacyPidFileFault.closeErrorDescriptor) {
        legacyPidFileFault.closeAttempts += 1;
        legacyPidFileFault.closeErrorDescriptor = undefined;
        actual.closeSync(...args);
        throw new Error("injected legacy PID descriptor close failure");
      }
      const result = actual.closeSync(...args);
      if (args[0] === legacyPidFileFault.formerCleanupDescriptor && legacyPidFileFault.path !== undefined) {
        legacyPidFileFault.formerCleanupDescriptor = undefined;
        const originalPath = `${legacyPidFileFault.path}.authenticated`;
        actual.renameSync(legacyPidFileFault.path, originalPath);
        if (legacyPidFileFault.mode === "former-cleanup-replacement") {
          actual.writeFileSync(legacyPidFileFault.path, "9999", { mode: 0o600 });
        } else if (legacyPidFileFault.mode === "former-cleanup-symlink") {
          actual.symlinkSync(originalPath, legacyPidFileFault.path);
        } else if (legacyPidFileFault.mode === "former-cleanup-hardlink") {
          actual.linkSync(originalPath, legacyPidFileFault.path);
        }
      }
      return result;
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (legacyPidFileFault.path !== undefined && String(args[0]) === legacyPidFileFault.path) {
        legacyPidFileFault.unlinkCalls += 1;
      }
      return actual.unlinkSync(...args);
    },
  };
});

const cleanupFault = vi.hoisted(() => ({ throw: false }));
vi.mock("../../src/daemon/managed-credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/daemon/managed-credentials.js")>();
  return {
    ...actual,
    cleanupManagedCredentialDirectory: (...args: Parameters<typeof actual.cleanupManagedCredentialDirectory>) => {
      if (cleanupFault.throw) throw new Error("credential cleanup failed");
      return actual.cleanupManagedCredentialDirectory(...args);
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFault.throw = false;
  legacyPidFileFault.path = undefined;
  legacyPidFileFault.mode = undefined;
  legacyPidFileFault.openCalls = 0;
  legacyPidFileFault.openFlags = [];
  legacyPidFileFault.parentPath = undefined;
  legacyPidFileFault.parentStatCalls = 0;
  legacyPidFileFault.parentFault = undefined;
  legacyPidFileFault.leafLstatError = undefined;
  legacyPidFileFault.preflightArmed = false;
  legacyPidFileFault.closeErrorDescriptor = undefined;
  legacyPidFileFault.closeAttempts = 0;
  legacyPidFileFault.formerCleanupDescriptor = undefined;
  legacyPidFileFault.unlinkCalls = 0;
  legacyTokenFileFault.path = undefined;
  legacyTokenFileFault.code = "ENOENT";
  legacyTokenFileFault.openCalls = 0;
  legacyTokenFileFault.openFlags = [];
  legacyTokenFileFault.countOnly = false;
  legacyTokenFileFault.hardlinkOnOpen = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(prefix = "lcm-coverage-restart-"): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o700);
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function writePid(rootPath: string, pid: number): string {
  const path = join(rootPath, "daemon.pid");
  writeFileSync(path, String(pid), { mode: 0o600 });
  return path;
}

function writeProc(rootPath: string, pid: number, parentPid = 1, command = "node lcm daemon start --foreground"): void {
  const dir = join(rootPath, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status"), `Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t${parentPid}\n`);
  writeFileSync(join(dir, "cmdline"), command.replaceAll(" ", "\0"));
}

function writeProcListenerEvidence(rootPath: string, pid: number, port: number): void {
  const fdDirectory = join(rootPath, String(pid), "fd");
  mkdirSync(fdDirectory, { recursive: true });
  symlinkSync("socket:[424242]", join(fdDirectory, "3"));
  mkdirSync(join(rootPath, "net"), { recursive: true });
  const portHex = port.toString(16).toUpperCase();
  writeFileSync(join(rootPath, "net", "tcp"), `sl local_address rem_address st tx_queue tr tm->when retrnsmt uid timeout inode\n0: 0100007F:${portHex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 424242 1\n`);
}

function hermetic(options: EnsureDaemonOptions, environment: NodeJS.ProcessEnv = {}): EnsureDaemonOptions {
  const stateDir = dirname(options.pidFilePath);
  const seams: DaemonLifecycleHermeticTestSeams = {
    homeDir: stateDir,
    runtimeDir: join(stateDir, ".runtime"),
    stateDir,
    credentialDir: join(stateDir, ".credentials"),
    procRoot: options._procRoot === "/proc" ? join(stateDir, ".proc") : options._procRoot ?? join(stateDir, ".proc"),
    platform: options._platform ?? "linux",
    uid: options._uid ?? 1000,
    environment,
    fetch: options._fetchOverride ?? (vi.fn().mockRejectedValue(new Error("offline")) as FetchOverride),
    spawn: options._spawnOverride ?? (vi.fn(() => ({ pid: undefined, once: vi.fn().mockReturnThis(), unref: vi.fn() })) as unknown as SpawnOverride),
    spawnSync: options._spawnSyncOverride ?? (vi.fn(() => ({ status: 1, stdout: "", stderr: "offline" })) as unknown as SpawnSyncOverride),
    stopUnit: vi.fn(),
    killProcess: options._killOverride ?? vi.fn(),
    isProcessAlive: options._isProcessAliveOverride ?? (() => false),
    sleep: options._sleepOverride ?? (async () => undefined),
    realpath: options._realpathOverride ?? (path => path),
  };
  privateDirectory(seams.homeDir);
  for (const directory of [seams.runtimeDir, seams.credentialDir, seams.procRoot]) mkdirSync(directory, { recursive: true });
  return { ...options, _hermeticTestSeams: seams };
}

function ensure(options: EnsureDaemonOptions): ReturnType<typeof ensureDaemonProduction> {
  return ensureDaemonProduction(hermetic(options));
}

function restart(options: RestartDaemonOptions, environment: NodeJS.ProcessEnv = {}): ReturnType<typeof restartDaemonProduction> {
  return restartDaemonProduction(hermetic(options, environment));
}

function baseOptions(rootPath: string): EnsureDaemonOptions {
  return {
    port: 19_999,
    pidFilePath: join(rootPath, "daemon.pid"),
    spawnTimeoutMs: 100,
    expectedVersion: "1.0.0",
    expectedEntrypoint: "/lcm",
    _platform: "linux",
    _monotonicNowOverride: () => 0,
    _sleepOverride: async () => undefined,
    _skipSpawn: true,
  };
}

function health(pid: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "ok", version: "1.0.0", pid, storageBackend: "sqlite", entrypoint: "/lcm", ...extra };
}

function diagnosticsFetch(...bodies: readonly unknown[]): FetchOverride {
  let index = 0;
  return vi.fn(async (url: string): Promise<Response> => {
    if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
    const body = bodies[Math.min(index++, bodies.length - 1)];
    return response(body ?? health(20));
  }) as unknown as FetchOverride;
}

function unavailableSupervisor(reason: string = "manager-unavailable"): Supervisor {
  return {
    probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "unavailable" as const, reason, name: spec.name })),
    start: vi.fn(),
    stopAndStart: vi.fn(),
    stopAndAwaitAbsent: vi.fn(),
  } as unknown as Supervisor;
}

function managedSupervisor(
  observation: (spec: SupervisorSpec, call: number) => Record<string, unknown>,
  startResult: Record<string, unknown> = { kind: "systemd-user", managerPid: 200 },
): { supervisor: Supervisor; probe: ReturnType<typeof vi.fn>; stopAndStart: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> } {
  let call = 0;
  const probe = vi.fn(async (spec: SupervisorSpec) => observation(spec, ++call));
  const start = vi.fn(async () => startResult);
  const stopAndStart = vi.fn(async () => startResult);
  return {
    supervisor: { probe, start, stopAndStart, stopAndAwaitAbsent: vi.fn() } as unknown as Supervisor,
    probe,
    stopAndStart,
    start,
  };
}

const SUPERVISOR_FAILURE_SECRET = "supervisor-secret-must-not-surface";
const supervisorFailureCases: readonly [
  string,
  () => Error,
  boolean,
][] = [
  ["the typed daemon-temp error", () => new SupervisorDaemonTempCreationError(), true],
  ["an ordinary secret-bearing error", () => new Error(SUPERVISOR_FAILURE_SECRET), false],
  ["a forged daemon-temp error", () => {
    const error = new Error(SUPERVISOR_DAEMON_TEMP_CREATION_WARNING);
    error.name = "SupervisorDaemonTempCreationError";
    return error;
  }, false],
  ["a typed daemon-temp error with a mutated message", () => {
    const error = new SupervisorDaemonTempCreationError();
    error.message = SUPERVISOR_FAILURE_SECRET;
    return error;
  }, true],
];

const LEGACY_INVOCATION_ID = "1234567890abcdef1234567890abcdef";
const CHANGED_LEGACY_INVOCATION_ID = "abcdef1234567890abcdef1234567890";

type LegacyUnit = Readonly<{ name: string; managerPid: number; invocationId: string }>;
type LegacyDiscovery =
  | Readonly<{ kind: "candidates"; candidates: readonly LegacyUnit[] }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

function legacyMigrationSupervisor(
  discovery: LegacyDiscovery,
  onStop?: (candidate: LegacyUnit) => void | Promise<void>,
  stopImplementation?: (
    candidate: LegacyUnit,
    options?: { readonly deadline?: number },
  ) => Promise<void>,
): {
  supervisor: Supervisor;
  probe: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stopAndStart: ReturnType<typeof vi.fn>;
  discoverLegacySystemdUnits: ReturnType<typeof vi.fn>;
  stopLegacySystemdUnit: ReturnType<typeof vi.fn>;
} {
  const probe = vi.fn(async (spec: SupervisorSpec) => {
    legacyPidFileFault.preflightArmed = true;
    return { kind: "absent" as const, name: spec.name };
  });
  const start = vi.fn(async () => ({ kind: "systemd-user" as const, managerPid: 5252 }));
  const stopAndStart = vi.fn();
  const discoverLegacySystemdUnits = vi.fn(async () => discovery);
  const stopLegacySystemdUnit = vi.fn(async (
    candidate: LegacyUnit,
    options?: { readonly deadline?: number },
  ) => {
    if (stopImplementation !== undefined) return stopImplementation(candidate, options);
    return onStop?.(candidate);
  });
  return {
    supervisor: {
      probe,
      start,
      stopAndStart,
      stopAndAwaitAbsent: vi.fn(),
      discoverLegacySystemdUnits,
      stopLegacySystemdUnit,
    } as unknown as Supervisor,
    probe,
    start,
    stopAndStart,
    discoverLegacySystemdUnits,
    stopLegacySystemdUnit,
  };
}

function legacyUnit(overrides: Partial<LegacyUnit> = {}): LegacyUnit {
  return {
    name: "lcm-daemon-1234-1720000000000.service",
    managerPid: 4242,
    invocationId: LEGACY_INVOCATION_ID,
    ...overrides,
  };
}

function legacyManagerState(
  activeState: "active" | "deactivating" | "not-found",
  mainPid: number,
  subState: "running" | "stop-sigterm" | "dead",
  invocationId: string = LEGACY_INVOCATION_ID,
): string {
  return [
    `LoadState=${activeState === "not-found" ? "not-found" : "loaded"}`,
    `ActiveState=${activeState === "not-found" ? "inactive" : activeState}`,
    `SubState=${subState}`,
    `MainPID=${mainPid}`,
    ...(activeState === "not-found" ? [] : [`InvocationID=${invocationId}`]),
  ].join("\n");
}

type LegacyFixtureConfig = Readonly<{
  pidState?: "valid" | "missing" | "malformed" | "symlink" | "directory" | "unsafe-number" | "boundary" | "oversized" | "hardlink";
  tokenState?: "valid" | "missing" | "symlink" | "empty" | "boundary" | "oversized" | "hardlink";
  tokenInvalidAfterInitialRead?: boolean;
  tokenErrorAfterInitialRead?: boolean;
  discoveries?: readonly LegacyDiscovery[];
  publicHealth?: Record<string, unknown> | null;
  publicStatus?: number;
  publicNoResponse?: boolean;
  authenticatedHealth?: Record<string, unknown> | null;
  accessStatus?: number;
  processCommand?: string;
  listenerPorts?: readonly number[];
  alive?: boolean;
  stopBehavior?: "remove-pid" | "keep-alive" | "replace-pid" | "replace-unsafe" | "leave-pid" | "throw";
  startBehavior?: "throw";
  startError?: Error;
  mutatePidBeforeSecondDiscovery?: boolean;
  discoveryThrows?: boolean;
  environment?: NodeJS.ProcessEnv;
  formerCleanupMutation?: "replacement" | "symlink" | "hardlink";
  pidCloseError?: boolean;
  pidValidationFaultAfterStop?: "missing" | "dangling-symlink";
  pidMissingParentFault?:
    | "first-missing"
    | "first-non-directory"
    | "missing"
    | "non-directory"
    | "device-change"
    | "inode-change";
  pidLeafLstatError?: "EACCES";
  useProcListener?: boolean;
  abortSignal?: AbortSignal;
  abortController?: AbortController;
  abortBeforePreStop?: boolean;
  expireBeforePreStop?: boolean;
  monotonicNow?: () => number;
}>;

async function runLegacyFixture(config: LegacyFixtureConfig = {}): Promise<{
  readonly result: Awaited<ReturnType<typeof restartDaemonProduction>>;
  readonly pidPath: string;
  readonly supervisor: ReturnType<typeof legacyMigrationSupervisor>;
  readonly ensure: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly fetch: ReturnType<typeof vi.fn>;
}> {
  const dir = root("issue-600-legacy-matrix-");
  const procRoot = join(dir, "proc");
  mkdirSync(procRoot, { recursive: true });
  const pidPath = join(dir, "daemon.pid");
  const pidState = config.pidState ?? "valid";
  if (pidState === "valid") writePid(dir, 4242);
  if (pidState === "boundary") writeFileSync(pidPath, "4242".padEnd(64, " "), { mode: 0o600 });
  if (pidState === "oversized") writeFileSync(pidPath, "4242".padEnd(65, " "), { mode: 0o600 });
  if (pidState === "hardlink") writePid(dir, 4242);
  if (pidState === "malformed") writeFileSync(pidPath, "not-a-pid", { mode: 0o600 });
  if (pidState === "directory") mkdirSync(pidPath);
  if (pidState === "unsafe-number") writeFileSync(pidPath, "9007199254740992", { mode: 0o600 });
  if (pidState === "symlink") {
    const external = join(root("issue-600-legacy-external-"), "daemon.pid");
    writeFileSync(external, "4242", { mode: 0o600 });
    symlinkSync(external, pidPath);
  }
  const tokenPath = join(dir, "daemon.token");
  const tokenState = config.tokenState ?? "valid";
  if (tokenState === "valid") writeFileSync(tokenPath, "legacy-token", { mode: 0o600 });
  if (tokenState === "boundary") writeFileSync(tokenPath, "legacy-token".padEnd(4_096, " "), { mode: 0o600 });
  if (tokenState === "oversized") writeFileSync(tokenPath, "legacy-token".padEnd(4_097, " "), { mode: 0o600 });
  if (tokenState === "hardlink") writeFileSync(tokenPath, "legacy-token", { mode: 0o600 });
  if (tokenState === "empty") writeFileSync(tokenPath, "", { mode: 0o600 });
  if (tokenState === "symlink") {
    const external = join(root("issue-600-legacy-token-external-"), "daemon.token");
    writeFileSync(external, "legacy-token", { mode: 0o600 });
    symlinkSync(external, tokenPath);
  }
  const aliveState = { value: config.alive ?? true };
  writeProc(procRoot, 4242, 1234, config.processCommand ?? "node lcm daemon start --foreground");
  const candidate = legacyUnit();
  const discoveries = config.discoveries ?? [{ kind: "candidates" as const, candidates: [candidate] }];
  let discoveryIndex = 0;
  const supervisor = legacyMigrationSupervisor(
    discoveries[0]!,
    async () => {
      const stopBehavior = config.stopBehavior ?? "remove-pid";
      if (stopBehavior === "throw") throw new Error("legacy stop failed");
      if (stopBehavior === "keep-alive") return;
      aliveState.value = false;
      if (stopBehavior === "replace-pid") writeFileSync(pidPath, "9999", { mode: 0o600 });
      else if (stopBehavior === "replace-unsafe") {
        const oldPath = `${pidPath}.old`;
        renameSync(pidPath, oldPath);
        symlinkSync(oldPath, pidPath);
      }
      else if (stopBehavior === "remove-pid") {
        try { unlinkSync(pidPath); } catch { /* preserve fixture state */ }
      }
    },
  );
  supervisor.discoverLegacySystemdUnits.mockImplementation(async () => {
    if (config.discoveryThrows) throw new Error("legacy discovery failed");
    const result = discoveries[Math.min(discoveryIndex++, discoveries.length - 1)]!;
    if (config.mutatePidBeforeSecondDiscovery && discoveryIndex === 1) writeFileSync(pidPath, "9999", { mode: 0o600 });
    return result;
  });
  if (config.startBehavior === "throw") supervisor.start.mockRejectedValue(new Error("stable start failed"));
  if (config.startError !== undefined) supervisor.start.mockRejectedValue(config.startError);
  const publicHealth = config.publicHealth === null ? null : config.publicHealth ?? health(4242, { version: "1.4.1", ownerId: "legacy-owner" });
  const authenticatedHealth = config.authenticatedHealth === null
    ? null
    : config.authenticatedHealth ?? publicHealth;
  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 }, config.accessStatus ?? 200);
    if (!init?.headers && config.publicNoResponse === true) throw new Error("legacy daemon offline");
    const body = init?.headers ? authenticatedHealth : publicHealth;
    return body === null ? response({ status: "warming" }, config.publicStatus ?? 200) : response(body, config.publicStatus ?? 200);
  }) as unknown as FetchOverride;
  const ensure = vi.fn(async () => ({ connected: true, port: 19_999, spawned: true, startMethod: "systemd-user" as const }));
  const kill = vi.fn();
  legacyPidFileFault.path = pidPath;
  legacyPidFileFault.parentPath = dirname(pidPath);
  legacyTokenFileFault.path = tokenPath;
  legacyTokenFileFault.countOnly = true;
  if (pidState === "hardlink") legacyPidFileFault.mode = "hardlink-on-open";
  if (tokenState === "hardlink") legacyTokenFileFault.hardlinkOnOpen = true;
  if (config.useProcListener) writeProcListenerEvidence(procRoot, 4242, 19_999);
  if (config.stopBehavior === "leave-pid") legacyPidFileFault.path = pidPath;
  if (config.pidCloseError === true) {
    legacyPidFileFault.mode = "close-error";
  }
  if (config.pidValidationFaultAfterStop !== undefined) {
    legacyPidFileFault.mode = config.pidValidationFaultAfterStop === "missing"
      ? "after-stop-validation-missing"
      : "after-stop-validation-dangling-symlink";
  }
  legacyPidFileFault.parentFault = config.pidMissingParentFault;
  legacyPidFileFault.leafLstatError = config.pidLeafLstatError;
  if (config.formerCleanupMutation !== undefined) {
    legacyPidFileFault.path = pidPath;
    legacyPidFileFault.mode = `former-cleanup-${config.formerCleanupMutation}`;
  }
  if (config.tokenInvalidAfterInitialRead || config.tokenErrorAfterInitialRead) {
    legacyTokenFileFault.countOnly = false;
    legacyTokenFileFault.code = config.tokenErrorAfterInitialRead ? "EACCES" : "ENOENT";
  }
  const preStopClock = { expired: false };
  const monotonicNow = config.expireBeforePreStop
    ? () => preStopClock.expired ? 100 : 0
    : config.monotonicNow ?? (() => 0);
  const result = await restart({
    ...baseOptions(dir),
    _skipSpawn: false,
    expectedVersion: "1.4.2",
    enforceUserManagerParent: true,
    _procRoot: procRoot,
    _isProcessAliveOverride: () => aliveState.value,
    ...(config.useProcListener ? {} : {
      _listeningPortsOverride: () => {
        if (config.abortBeforePreStop) config.abortController?.abort();
        if (config.expireBeforePreStop) preStopClock.expired = true;
        return [...(config.listenerPorts ?? [19_999])];
      },
    }),
    _abortSignal: config.abortSignal,
    _fetchOverride: fetch,
    _killOverride: kill,
    _supervisorOverride: supervisor.supervisor,
    _ensureDaemonOverride: ensure,
    _monotonicNowOverride: monotonicNow,
  }, config.environment);
  return { result, pidPath, supervisor, ensure, kill, fetch };
}

function testScopeFixture(prefix = "scope-"): { root: string; scope: DaemonLifecycleTestScope } {
  const dir = root(`lcm-coverage-restart-${prefix}`);
  const homeDir = join(dir, "home");
  const runtimeDir = join(homeDir, "runtime");
  const stateDir = join(homeDir, ".lcm");
  const credentialDir = join(homeDir, "credentials");
  const entrypoint = join(runtimeDir, "daemon.mjs");
  privateDirectory(homeDir);
  privateDirectory(stateDir);
  for (const path of [runtimeDir, credentialDir]) mkdirSync(path, { recursive: true });
  writeFileSync(entrypoint, "setTimeout(() => {}, 60_000);\n");
  const dependencies = {
    fetch: vi.fn().mockRejectedValue(new Error("offline")),
    spawn: vi.fn(() => ({
      pid: undefined,
      once: vi.fn().mockReturnThis(),
      unref: vi.fn(),
    })),
    spawnSync: vi.fn(),
    stopUnit: vi.fn(),
    killProcess: vi.fn(),
    isProcessAlive: vi.fn(() => false),
    sleep: vi.fn(async () => undefined),
  };
  return {
    root: dir,
    scope: createDaemonLifecycleTestScope({
      ownerId: "coverage-restart",
      homeDir,
      runtimeDir,
      stateDir,
      credentialDir,
      entrypoint,
      dependencies,
    }),
  };
}

describe("ensureDaemon restart and terminal coverage", () => {
  it.each(supervisorFailureCases)("classifies %s during managed ensure start", async (_name, createError, typed) => {
    const dir = root("issue-944-ensure-start-");
    const managed = managedSupervisor(spec => ({ kind: "absent", name: spec.name }));
    managed.start.mockRejectedValue(createError());

    const result = await ensure({
      ...baseOptions(dir),
      _skipSpawn: false,
      enforceUserManagerParent: true,
      _supervisorOverride: managed.supervisor,
    });

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      refusalReason: "startup-failure",
      warning: typed
        ? SUPERVISOR_DAEMON_TEMP_CREATION_WARNING
        : "managed daemon supervisor start failed",
    });
    expect(result.pid).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SUPERVISOR_FAILURE_SECRET);
    expect(managed.start).toHaveBeenCalledOnce();
    expect(managed.stopAndStart).not.toHaveBeenCalled();
    expect(managed.supervisor.stopAndAwaitAbsent).not.toHaveBeenCalled();
  });

  it("revalidates and terminates an authenticated daemon with a wrong Linux parent", async () => {
    const dir = root();
    const procRoot = join(dir, "proc");
    mkdirSync(procRoot, { recursive: true });
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    writeProc(procRoot, 10, 1, "systemd --user");
    writeProc(procRoot, 20, 11);
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const fetch = diagnosticsFetch(health(20), health(20));
    // observeHttpHealth owns a real wall-clock deadline independent of
    // _monotonicNowOverride, so this fixture pins performance.now.
    vi.spyOn(performance, "now").mockReturnValue(0);
    const result = await ensure({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _procRoot: procRoot,
      _uid: 1000,
      _isProcessAliveOverride: () => alive,
      _killOverride: kill,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(20, "SIGTERM");
    expect(result.connected).toBe(false);
  });

  it("blocks an unauthenticated retry with a storage mismatch", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    let healthCalls = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/stats/pool")) return response({ error: "denied" }, 401);
      healthCalls += 1;
      if (healthCalls === 1) return response({ status: "warming", version: "1.0.0", pid: 999 });
      if (init?.headers) return response({ error: "denied" }, 401);
      return response(health(20, { storageBackend: "postgresql" }));
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(result.warning).toContain("storage-backend mismatch");
  });

  it("accepts a recognized retry endpoint after an initial PID collision", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    const fetch = diagnosticsFetch({ status: "warming", version: "1.0.0", pid: 999 }, health(20), health(20));
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result).toMatchObject({ connected: true, spawned: false, pid: 20, startMethod: "existing" });
  });

  it("preserves a busy Darwin PID after bounded health failure", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    const ps = vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground\n", stderr: "" }));
    const result = await ensure({
      ...baseOptions(dir),
      _platform: "darwin",
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _spawnSyncOverride: ps as unknown as SpawnSyncOverride,
      _fetchOverride: vi.fn(async (url: string) => url.endsWith("/health")
      ? response({ status: "warming", version: "1.0.0", pid: 999 })
        : response({ error: "no" }, 503)) as unknown as FetchOverride,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result).toMatchObject({ connected: false, spawned: false, pid: 20 });
    expect(result.warning).toContain("still owns configured port");
  });

  it("returns an ambiguous refusal when PID liveness cannot be rechecked", async () => {
    const dir = root();
    writePid(dir, 20);
    const alive = vi.fn()
      .mockReturnValueOnce(false)
      .mockImplementation(() => { throw new Error("liveness unavailable"); });
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: alive,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result).toMatchObject({ connected: false, refusalReason: "ambiguous", pid: 20 });
    expect(existsSync(join(dir, "daemon.pid"))).toBe(true);
  });

  it("returns a concurrent-replacement result when the PID file changes", async () => {
    const dir = root();
    writePid(dir, 20);
    const alive = vi.fn(() => false);
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        writePid(dir, 21);
        return response(health(999));
      }
      return response({});
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: alive,
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result.connected).toBe(false);
  });

  it("waits for a replacement PID after authenticated mismatch repair", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    let nowCalls = 0;
    let alive = true;
    let killed = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
      if (init?.headers) return response(health(20));
      if (killed) return response(health(21));
      if (url.endsWith("/health")) return response(killed ? health(21) : health(20));
      return response({});
    }) as unknown as FetchOverride;
    const kill = vi.fn(() => {
      killed = true;
      alive = false;
      writePid(dir, 21);
    });
    const result = await ensure({
      ...baseOptions(dir),
      expectedVersion: "2.0.0",
      _platform: "darwin",
      _isProcessAliveOverride: (pid) => pid === 20 ? alive : true,
      _killOverride: kill,
      _listeningPortsOverride: () => [19_999],
      _spawnSyncOverride: vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground\n", stderr: "" })) as unknown as SpawnSyncOverride,
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
      _monotonicNowOverride: () => nowCalls++ < 8 ? 0 : 200,
    });
    expect(kill).toHaveBeenCalledWith(20, "SIGTERM");
    expect(result.connected).toBe(false);
  });

  it("waits for a replacement PID from the retry mismatch path", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    let healthCalls = 0;
    let alive = true;
    const fetch = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
      healthCalls += 1;
      if (healthCalls === 1) return response({ status: "warming" });
      return response(health(20));
    }) as unknown as FetchOverride;
    const kill = vi.fn(() => {
      alive = false;
      writePid(dir, 21);
    });
    const result = await ensure({
      ...baseOptions(dir),
      expectedVersion: "2.0.0",
      _platform: "darwin",
      _isProcessAliveOverride: (pid) => pid === 20 && alive,
      _killOverride: kill,
      _listeningPortsOverride: () => [19_999],
      _spawnSyncOverride: vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground\n", stderr: "" })) as unknown as SpawnSyncOverride,
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(kill).toHaveBeenCalledWith(20, "SIGTERM");
    expect(result.connected).toBe(false);
  });

  it("waits on a PID replacement after an invalid retry response", async () => {
    const dir = root();
    writePid(dir, 20);
    let changed = false;
    const fetch = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        if (!changed) {
          changed = true;
          writePid(dir, 21);
          return response({ status: "warming" });
        }
        return response({}, 503);
      }
      return response({});
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: (pid) => pid === 20,
      _listeningPortsOverride: () => [],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result.connected).toBe(false);
  });

  it("waits on a PID replacement observed after the retry response", async () => {
    const dir = root();
    writePid(dir, 20);
    let calls = 0;
    const fetch = vi.fn(async (url: string): Promise<Response> => {
      if (!url.endsWith("/health")) return response({});
      calls += 1;
      if (calls === 1) return response({ status: "warming" });
      writePid(dir, 21);
      return response({}, 503);
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: (pid) => pid === 20,
      _listeningPortsOverride: () => [],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result.connected).toBe(false);
  });

  it("waits for a PID replacement discovered after stale-state inspection", async () => {
    const dir = root();
    writePid(dir, 20);
    let aliveCalls = 0;
    const result = await ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: (pid) => {
        aliveCalls += 1;
        if (aliveCalls === 1) writePid(dir, 21);
        return false && pid === 20;
      },
      _fetchOverride: vi.fn().mockResolvedValue(response({ status: "warming" })) as unknown as FetchOverride,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(result.connected).toBe(false);
  });

  it("rethrows an observable scoped-state error from the retry cleanup fence", async () => {
    const dir = root();
    const pidPath = writePid(dir, 20);
    const external = join(root(), "external.pid");
    writeFileSync(external, "20");
    let firstAliveCheck = true;
    const result = ensure({
      ...baseOptions(dir),
      _isProcessAliveOverride: () => {
        if (firstAliveCheck) {
          firstAliveCheck = false;
          unlinkSync(pidPath);
          symlinkSync(external, pidPath);
        }
        return true;
      },
      _fetchOverride: vi.fn().mockResolvedValue(response({ status: "warming" })) as unknown as FetchOverride,
    });
    await expect(result).rejects.toThrow("PID state is not a canonical owned file");
  });

  it("cleans a scoped PID when its retry health cannot be authenticated", async () => {
    const fixture = testScopeFixture("retry-auth-");
    const pidPath = writePid(fixture.scope.stateDir, 20);
    let healthCalls = 0;
    const fetch = fixture.scope.dependencies.fetch as unknown as ReturnType<typeof vi.fn>;
    const alive = fixture.scope.dependencies.isProcessAlive as unknown as ReturnType<typeof vi.fn>;
    const sleep = fixture.scope.dependencies.sleep as unknown as ReturnType<typeof vi.fn>;
    fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
      healthCalls += 1;
      return healthCalls === 1 ? response({ status: "warming" }) : response(health(20));
    });
    alive.mockReturnValue(true);
    sleep.mockResolvedValue(undefined);
    const result = await ensureDaemonProduction({
      port: 19_999,
      pidFilePath: pidPath,
      spawnTimeoutMs: 100,
      _platform: "linux",
      _testScope: fixture.scope,
      _listeningPortsOverride: () => [19_999],
      _monotonicNowOverride: () => 0,
      _skipSpawn: true,
    });
    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(result.warning).toContain("runtime-identity mismatch");
    expect(existsSync(pidPath)).toBe(false);
  });

  it("signals a parent-owned PID after an invalid retry health response", async () => {
    const dir = root();
    const procRoot = join(dir, "proc");
    mkdirSync(procRoot, { recursive: true });
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    writeProc(procRoot, 10, 1, "systemd --user");
    writeProc(procRoot, 20, 10);
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    let healthCalls = 0;
    const fetch = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) {
        healthCalls += 1;
        return healthCalls === 1 ? response({ status: "warming" }) : response({}, 503);
      }
      return response({});
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _procRoot: procRoot,
      _uid: 1000,
      _isProcessAliveOverride: () => alive,
      _killOverride: kill,
      _listeningPortsOverride: () => [],
      _fetchOverride: fetch,
      _supervisorOverride: unavailableSupervisor(),
    });
    expect(kill).toHaveBeenCalledWith(20, "SIGTERM");
    expect(result.connected).toBe(false);
  });

  it("cleans detached spawn state when an abort races the no-health result", async () => {
    const dir = root();
    const controller = new AbortController();
    const child = { pid: 321, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    const spawn = vi.fn(() => {
      queueMicrotask(() => controller.abort());
      return child;
    }) as unknown as SpawnOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _skipSpawn: false,
      _abortSignal: controller.signal,
      _spawnOverride: spawn,
      _fetchOverride: vi.fn(() => new Promise<Response>(() => undefined)) as unknown as FetchOverride,
    });
    expect(result).toMatchObject({ connected: false, spawned: true, warning: "daemon lifecycle was interrupted" });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("refuses detached fallback after a manager operation became unavailable", async () => {
    const dir = root();
    const result = await ensure({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _suppressDetachedFallback: true,
      _supervisorOverride: unavailableSupervisor("manager-unavailable"),
    });
    expect(result).toMatchObject({ connected: false, refusalReason: "manager-unavailable" });
  });

  it("accepts a detached spawn health response after writing its PID", async () => {
    const dir = root();
    const child = { pid: 321, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    const fetch = diagnosticsFetch(
      health(321, { runtimeDigest: "a".repeat(64) }),
      health(321, { runtimeDigest: "a".repeat(64) }),
    );
    const result = await ensure({
      ...baseOptions(dir),
      _skipSpawn: false,
      expectedRuntimeDigest: "a".repeat(64),
      _spawnOverride: vi.fn(() => child) as unknown as SpawnOverride,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
    });
    expect(result).toMatchObject({ connected: true, spawned: true, startMethod: "detached-spawn", pid: 321 });
  });

  it("cleans every owned test-scope resource after a detached test start", async () => {
    const fixture = testScopeFixture("detached-cleanup-");
    const pidPath = join(fixture.scope.stateDir, "daemon.pid");
    const child = { pid: 321, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    let alive = true;
    const spawn = fixture.scope.dependencies.spawn as unknown as ReturnType<typeof vi.fn>;
    const kill = fixture.scope.dependencies.killProcess as unknown as ReturnType<typeof vi.fn>;
    const isAlive = fixture.scope.dependencies.isProcessAlive as unknown as ReturnType<typeof vi.fn>;
    spawn.mockReturnValue(child);
    kill.mockImplementation(() => { alive = false; });
    isAlive.mockImplementation(() => alive);
    const result = await ensureDaemonProduction({
      port: 19_999,
      pidFilePath: pidPath,
      spawnTimeoutMs: 100,
      _platform: "linux",
      _testScope: fixture.scope,
      _skipHealthWait: true,
    });
    expect(result).toMatchObject({ connected: false, spawned: true });
    expect(kill).toHaveBeenCalledWith(321, "SIGTERM");
    expect(existsSync(fixture.scope.runtimeDir)).toBe(false);
    expect(existsSync(fixture.scope.credentialDir)).toBe(false);
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
  });

  it("runs abort cleanup when a scope is interrupted immediately after spawn", async () => {
    const fixture = testScopeFixture("abort-after-spawn-");
    const pidPath = join(fixture.scope.stateDir, "daemon.pid");
    const child = { pid: 322, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    const spawn = fixture.scope.dependencies.spawn as unknown as ReturnType<typeof vi.fn>;
    spawn.mockReturnValue(child);
    let reads = 0;
    const signal = {
      get aborted(): boolean {
        reads += 1;
        return reads >= 4;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const result = await ensureDaemonProduction({
      port: 19_999,
      pidFilePath: pidPath,
      spawnTimeoutMs: 100,
      _platform: "linux",
      _testScope: fixture.scope,
      _abortSignal: signal,
      _skipHealthWait: true,
    });
    expect(result.warning).toBe("daemon lifecycle was interrupted");
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("settles and reports an abort cleanup rejection through the catch fence", async () => {
    const fixture = testScopeFixture("abort-cleanup-error-");
    const pidPath = join(fixture.scope.stateDir, "daemon.pid");
    const child = { pid: 323, once: vi.fn(), unref: vi.fn() };
    child.once.mockImplementation(() => {
      rmSync(fixture.scope.runtimeDir, { recursive: true, force: true });
      mkdirSync(fixture.scope.runtimeDir, { recursive: true });
      return child;
    });
    const spawn = fixture.scope.dependencies.spawn as unknown as ReturnType<typeof vi.fn>;
    spawn.mockReturnValue(child);
    let reads = 0;
    const signal = {
      get aborted(): boolean {
        reads += 1;
        return reads >= 4;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    await expect(ensureDaemonProduction({
      port: 19_999,
      pidFilePath: pidPath,
      spawnTimeoutMs: 100,
      _platform: "linux",
      _testScope: fixture.scope,
      _abortSignal: signal,
      _skipHealthWait: true,
    })).rejects.toThrow("state paths changed");
  });

  it("observes an abort between stale PID handling and detached spawn", async () => {
    const dir = root();
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      throw new Error("offline");
    }) as unknown as FetchOverride;
    const result = await ensure({
      ...baseOptions(dir),
      _skipSpawn: false,
      _abortSignal: controller.signal,
      _fetchOverride: fetch,
    });
    expect(result.warning).toContain("interrupted before startup");
  });

  it("rejects a Vitest worker spawn entrypoint before registration", async () => {
    const dir = root();
    const originalArg = process.argv[1];
    process.argv[1] = "/tmp/lcm-cli.mjs";
    try {
      const result = await ensureDaemonProduction({
        port: 19_999,
        pidFilePath: join(dir, "daemon.pid"),
        spawnTimeoutMs: 100,
        _platform: "linux",
        _packagedEntrypointOverride: "/lcm",
        spawnArgs: ["/tmp/node_modules/vitest/dist/workers/run.js"],
        _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride,
        _monotonicNowOverride: () => 0,
      });
      expect(result.warning).toContain("refusing to register a Vitest worker");
    } finally {
      process.argv[1] = originalArg;
    }
  });

  it("creates the production token before an unscoped detached spawn", async () => {
    const dir = root();
    const child = { pid: 654, once: vi.fn().mockReturnThis(), unref: vi.fn() };
    const originalArg = process.argv[1];
    process.argv[1] = "/tmp/lcm-cli.mjs";
    try {
      const result = await ensureDaemonProduction({
        port: 19_999,
        pidFilePath: join(dir, "daemon.pid"),
        spawnTimeoutMs: 100,
        _platform: "linux",
        _packagedEntrypointOverride: "/lcm",
        _skipHealthWait: true,
        _spawnOverride: vi.fn(() => child) as unknown as SpawnOverride,
        _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride,
        _monotonicNowOverride: () => 0,
      });
      expect(result).toMatchObject({ spawned: true, startMethod: "detached-spawn" });
      expect(existsSync(join(dir, "daemon.token"))).toBe(true);
    } finally {
      process.argv[1] = originalArg;
    }
  });
});

describe("managed restart refusal and repair coverage", () => {
  it.each(supervisorFailureCases)("classifies %s during stale-config repair", async (_name, createError, typed) => {
    const dir = root("issue-944-stale-repair-");
    const managed = managedSupervisor(spec => ({
      kind: "registered-stale-config",
      reason: "metadata-mismatch",
      scopeDigest: spec.scopeDigest,
      name: spec.name,
    }));
    managed.stopAndStart.mockRejectedValue(createError());
    const ensureMock = vi.fn();

    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _supervisorOverride: managed.supervisor,
      _ensureDaemonOverride: ensureMock,
    });

    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      refusalReason: "startup-failure",
      warning: typed
        ? SUPERVISOR_DAEMON_TEMP_CREATION_WARNING
        : "managed daemon supervisor stale configuration repair failed",
    });
    expect(result.pid).toBeUndefined();
    expect(result.stoppedPid).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SUPERVISOR_FAILURE_SECRET);
    expect(managed.stopAndStart).toHaveBeenCalledOnce();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it.each(supervisorFailureCases)("classifies %s during a live manager restart", async (_name, createError, typed) => {
    const dir = root("issue-944-live-restart-");
    writePid(dir, 200);
    const managed = managedSupervisor(spec => ({
      kind: "registered-running-valid",
      managerPid: 200,
      scopeDigest: spec.scopeDigest,
      nonce: spec.nonce,
      name: spec.name,
    }));
    managed.stopAndStart.mockRejectedValue(createError());
    const ensureMock = vi.fn();

    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _supervisorOverride: managed.supervisor,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride,
      _ensureDaemonOverride: ensureMock,
    });

    expect(result).toMatchObject({
      connected: false,
      restarted: false,
      refusalReason: "startup-failure",
      pid: 200,
      warning: typed
        ? SUPERVISOR_DAEMON_TEMP_CREATION_WARNING
        : "managed daemon supervisor stop/start failed",
    });
    expect(result.stoppedPid).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SUPERVISOR_FAILURE_SECRET);
    expect(managed.stopAndStart).toHaveBeenCalledOnce();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("anchors restart admission to canonical state rather than caller cwd", async () => {
    const dir = root();
    const callerHome = homedir();
    const projectCwd = join(dir, "project");
    const spawnCommand = "/usr/bin/node";
    const spawnArgs = [
      join(callerHome, ".local", "lib", "node_modules", "@donadiosolutions", "lcm", "dist", "lcm.mjs"),
      "daemon",
      "start",
      "--foreground",
    ];
    let callerCwd = callerHome;
    vi.spyOn(process, "cwd").mockImplementation(() => callerCwd);
    const probed: SupervisorSpec[] = [];
    const managed = managedSupervisor((spec) => {
      probed.push(spec);
      return {
        kind: "registered-stale-config",
        reason: "metadata-mismatch",
        scopeDigest: spec.scopeDigest,
        name: spec.name,
      };
    });
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19_999, spawned: false }));
    const options = {
      ...baseOptions(dir),
      spawnCommand,
      spawnArgs,
      enforceUserManagerParent: true,
      _supervisorOverride: managed.supervisor,
      _ensureDaemonOverride: ensureMock,
    };

    await expect(restart(options)).resolves.toMatchObject({ restarted: true, connected: true });
    callerCwd = projectCwd;
    await expect(restart(options)).resolves.toMatchObject({ restarted: true, connected: true });

    expect(probed).toHaveLength(2);
    expect(probed[0]?.launchEnvironment?.PATH).toBe(probed[1]?.launchEnvironment?.PATH);
    expect(probed[0]?.launchEnvironment?.PATH).toContain(join(callerHome, ".local", "bin"));
    expect(probed[0]?.launchEnvironment?.PATH).toBe(
      managedDaemonPath(spawnCommand, spawnArgs, dir),
    );
    expect(managedLaunchEnvironmentDigest(
      probed[0]!,
      "systemd-user",
      1000,
      probed[0]!.launchEnvironment!,
    )).toBe(managedLaunchEnvironmentDigest(
      probed[1]!,
      "systemd-user",
      1000,
      probed[1]!.launchEnvironment!,
    ));
  });

  it.each([
    ["relative executable", { spawnCommand: "lcm" }],
    ["non-string argument", { spawnArgs: ["/tmp/lcm", 42] as unknown as string[] }],
  ])("refuses %s before manager probing", async (_name, extra) => {
    const dir = root();
    const probe = vi.fn();
    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      ...extra,
      _supervisorOverride: { probe, start: vi.fn(), stopAndStart: vi.fn(), stopAndAwaitAbsent: vi.fn() } as unknown as Supervisor,
    });
    expect(result).toMatchObject({ restarted: false, refusalReason: "ambiguous" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses a non-canonical manager state root", async () => {
    const dir = root();
    const probe = vi.fn();
    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _realpathOverride: () => { throw new Error("realpath unavailable"); },
      _supervisorOverride: { probe, start: vi.fn(), stopAndStart: vi.fn(), stopAndAwaitAbsent: vi.fn() } as unknown as Supervisor,
    });
    expect(result.refusalReason).toBe("ambiguous");
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses an invalid manager specification before probing", async () => {
    const dir = root();
    const probe = vi.fn();
    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      expectedRuntimeDigest: "not-a-digest",
      _supervisorOverride: { probe, start: vi.fn(), stopAndStart: vi.fn(), stopAndAwaitAbsent: vi.fn() } as unknown as Supervisor,
    });
    expect(result.refusalReason).toBe("ambiguous");
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    ["linux", "manager-unavailable"],
    ["linux", "manager-not-found"],
    ["darwin", "manager-unavailable"],
    ["darwin", "manager-not-found"],
  ] as const)("falls through %s restart when the selected manager preflight is %s", async (platform, reason) => {
    const dir = root(`issue-515-${platform}-${reason}-`);
    const pidPath = writePid(dir, 4242);
    const tokenPath = join(dir, "daemon.token");
    writeFileSync(tokenPath, "local-token", { mode: 0o600 });
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const ensureMock = vi.fn(async () => ({ connected: false, port: 19_999, spawned: false }));
    const supervisor = {
      probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "unavailable" as const, reason, name: spec.name })),
      start: vi.fn(),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(),
    } as unknown as Supervisor;

    const result = await restart({
      ...baseOptions(dir),
      _platform: platform,
      enforceUserManagerParent: true,
      _isProcessAliveOverride: () => alive,
      _isManagedProcessOverride: () => true,
      _killOverride: kill,
      _ensureDaemonOverride: ensureMock,
      _supervisorOverride: supervisor,
    });

    expect(result).toMatchObject({
      connected: false,
      spawned: false,
      restarted: true,
      stoppedPid: 4242,
    });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.stopAndStart).not.toHaveBeenCalled();
    expect(supervisor.stopAndAwaitAbsent).not.toHaveBeenCalled();
    expect(existsSync(pidPath)).toBe(false);
    expect(readFileSync(tokenPath, "utf8")).toBe("local-token");
  });

  it("uses the detached path only after authenticated legacy identity proof", async () => {
    const dir = root("issue-400-authenticated-detached-");
    const procRoot = join(dir, "proc");
    const pidPath = writePid(dir, 4242);
    writeFileSync(join(dir, "daemon.token"), "local-token", { mode: 0o600 });
    writeProc(procRoot, 4242);
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const ensureMock = vi.fn(async () => ({
      connected: false,
      port: 19_999,
      spawned: true,
      startMethod: "detached-spawn" as const,
    }));
    const supervisor = unavailableSupervisor("manager-unavailable");

    const result = await restart({
      ...baseOptions(dir),
      _procRoot: procRoot,
      enforceUserManagerParent: true,
      _isProcessAliveOverride: () => alive,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: diagnosticsFetch(health(4242), health(4242)),
      _killOverride: kill,
      _ensureDaemonOverride: ensureMock,
      _supervisorOverride: supervisor,
    });

    expect(result).toMatchObject({ restarted: true, stoppedPid: 4242, spawned: true, startMethod: "detached-spawn" });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(existsSync(pidPath)).toBe(false);
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.stopAndStart).not.toHaveBeenCalled();
  });

  it.each([
    ["no response", vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride],
    ["unverified PID", diagnosticsFetch(health(999), health(999))],
  ])("refuses detached fallback for %s before signaling", async (_case, fetch) => {
    const dir = root("issue-400-detached-refusal-");
    const pidPath = writePid(dir, 4242);
    writeFileSync(join(dir, "daemon.token"), "local-token", { mode: 0o600 });
    const kill = vi.fn();
    const ensureMock = vi.fn();
    const supervisor = unavailableSupervisor("manager-unavailable");

    await expect(restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _killOverride: kill,
      _ensureDaemonOverride: ensureMock,
      _supervisorOverride: supervisor,
    })).rejects.toThrow("not a verified LCM daemon");
    expect(kill).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
    expect(existsSync(pidPath)).toBe(true);
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.stopAndStart).not.toHaveBeenCalled();
  });

  it("refuses a selected-manager ambiguous preflight before legacy recovery", async () => {
    const dir = root("issue-515-ambiguous-");
    const pidPath = writePid(dir, 4242);
    const kill = vi.fn();
    const ensureMock = vi.fn();
    const supervisor = {
      probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "ambiguous" as const, reason: "state-conflict" as const, name: spec.name })),
      start: vi.fn(),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(),
    } as unknown as Supervisor;

    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _isProcessAliveOverride: () => true,
      _isManagedProcessOverride: () => true,
      _killOverride: kill,
      _ensureDaemonOverride: ensureMock,
      _supervisorOverride: supervisor,
    });

    expect(result).toMatchObject({ connected: false, spawned: false, restarted: false, refusalReason: "ambiguous" });
    expect(kill).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.stopAndStart).not.toHaveBeenCalled();
    expect(supervisor.stopAndAwaitAbsent).not.toHaveBeenCalled();
    expect(readFileSync(pidPath, "utf8")).toBe("4242");
  });

  it("retains legacy detached restart compatibility when no manager is selected", async () => {
    const dir = root("issue-515-detached-compatibility-");
    writePid(dir, 4242);
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const ensureMock = vi.fn(async () => ({ connected: false, port: 19_999, spawned: false }));

    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: false,
      _isProcessAliveOverride: () => alive,
      _isManagedProcessOverride: () => true,
      _killOverride: kill,
      _ensureDaemonOverride: ensureMock,
    });

    expect(result).toMatchObject({ restarted: true, stoppedPid: 4242 });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, "daemon.pid"))).toBe(false);
  });

  it("maps probe failures, collisions, ambiguous state, and unavailable manager reasons", async () => {
    const cases: readonly [string, Record<string, unknown>, string | undefined][] = [
      ["probe failure", { probe: vi.fn().mockRejectedValue(new Error("probe")) }, "ambiguous"],
      ["collision", { probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "registered-invalid-collision", reason: "foreign-job", name: spec.name })) }, "invalid-collision"],
      ["ambiguous", { probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "ambiguous", reason: "state-conflict", name: spec.name })) }, "ambiguous"],
      ["manager error", { probe: vi.fn(async (spec: SupervisorSpec) => ({ kind: "unavailable", reason: "metadata-mismatch", name: spec.name })) }, "manager-unavailable"],
    ];
    for (const [, supervisor, refusalReason] of cases) {
      const dir = root();
      const result = await restart({ ...baseOptions(dir), enforceUserManagerParent: true, _supervisorOverride: supervisor as unknown as Supervisor });
      expect(result.refusalReason).toBe(refusalReason);
    }
    const dir = root();
    const fallback = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: true,
      _supervisorOverride: unavailableSupervisor("manager-unavailable"),
      _ensureDaemonOverride: vi.fn(async () => ({ connected: false, port: 19_999, spawned: false })),
    });
    expect(fallback.restarted).toBe(false);
  });

  it("repairs stale registrations and propagates the normal CLI packaged entrypoint", async () => {
    const dir = root();
    const stopAndStart = vi.fn(async () => ({ kind: "systemd-user", managerPid: 200 }));
    const managed = managedSupervisor((spec) => ({
      kind: "registered-stale-config",
      reason: "metadata-mismatch",
      scopeDigest: spec.scopeDigest,
      name: spec.name,
    }), { kind: "systemd-user", managerPid: 200 });
    managed.stopAndStart.mockImplementation(stopAndStart);
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19_999, spawned: false }));
    const result = await restart({ ...baseOptions(dir), expectedEntrypoint: undefined, _packagedEntrypointOverride: "/packaged-lcm", enforceUserManagerParent: true, _supervisorOverride: managed.supervisor, _ensureDaemonOverride: ensureMock });
    expect(result).toMatchObject({ restarted: true, connected: true });
    expect(stopAndStart).toHaveBeenCalledOnce();
    expect(managed.probe).toHaveBeenCalledWith(
      expect.objectContaining({ entrypoint: "/packaged-lcm" }),
      { deadline: 100 },
    );
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ expectedEntrypoint: "/packaged-lcm" }));

    const mismatch = managedSupervisor((spec) => ({ kind: "registered-stale-config", reason: "metadata-mismatch", scopeDigest: "foreign", name: spec.name }));
    const refused = await restart({ ...baseOptions(root()), enforceUserManagerParent: true, _supervisorOverride: mismatch.supervisor });
    expect(refused.refusalReason).toBe("invalid-collision");

    const failed = managedSupervisor((spec) => ({ kind: "registered-stale-config", reason: "metadata-mismatch", scopeDigest: spec.scopeDigest, name: spec.name }));
    failed.stopAndStart.mockRejectedValue(new Error("stop/start"));
    const failure = await restart({ ...baseOptions(root()), enforceUserManagerParent: true, _supervisorOverride: failed.supervisor });
    expect(failure.refusalReason).toBe("startup-failure");
  });

  it("handles absent and terminal manager jobs with exact PID proof", async () => {
    for (const kind of ["absent", "registered-not-running-valid"] as const) {
      const dir = root();
      const managed = managedSupervisor((spec) => ({ kind, ...(kind === "registered-not-running-valid" ? { terminal: "inactive" } : {}), name: spec.name }));
      const skipped = await restart({ ...baseOptions(dir), enforceUserManagerParent: true, _skipSpawn: true, _supervisorOverride: managed.supervisor });
      expect(skipped.refusalReason).toBe(kind === "absent" ? "absent" : "not-running");
      expect(managed.start).not.toHaveBeenCalled();
    }
    const startDir = root();
    const startManaged = managedSupervisor((spec) => ({ kind: "absent", name: spec.name }), { kind: "systemd-user", managerPid: 201 });
    const ensured = vi.fn(async () => ({ connected: false, port: 19_999, spawned: true }));
    const started = await restart({ ...baseOptions(startDir), enforceUserManagerParent: true, _skipSpawn: false, _supervisorOverride: startManaged.supervisor, _ensureDaemonOverride: ensured });
    expect(started.restarted).toBe(false);
    expect(ensured).toHaveBeenCalledOnce();

    const changingDir = root();
    writePid(changingDir, 200);
    const changing = managedSupervisor((spec) => ({ kind: "absent", name: spec.name }));
    const changingResult = await restart({
      ...baseOptions(changingDir),
      enforceUserManagerParent: true,
      _supervisorOverride: changing.supervisor,
      _isProcessAliveOverride: () => {
        writePid(changingDir, 201);
        return false;
      },
    });
    expect(changingResult.refusalReason).toBe("not-running");

    const unsafeDir = root();
    const externalPid = join(root(), "external.pid");
    writeFileSync(externalPid, "200");
    symlinkSync(externalPid, join(unsafeDir, "daemon.pid"));
    const unsafe = managedSupervisor((spec) => ({ kind: "absent", name: spec.name }));
    const unsafeResult = await restart({ ...baseOptions(unsafeDir), enforceUserManagerParent: true, _supervisorOverride: unsafe.supervisor });
    expect(unsafeResult.warning).toContain("outside its state root");
    const dir = root();
    writePid(dir, 200);
    const live = managedSupervisor((spec) => ({ kind: "registered-not-running-valid", terminal: "failed", name: spec.name }));
    const refused = await restart({ ...baseOptions(dir), enforceUserManagerParent: true, _supervisorOverride: live.supervisor, _isProcessAliveOverride: () => true });
    expect(refused.refusalReason).toBe("not-running");
  });

  it("revalidates live manager endpoints for no-response and response branches", async () => {
    const make = (fetch: FetchOverride, extra: Record<string, unknown> = {}) => {
      const dir = root();
      writePid(dir, 200);
      writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
      const managed = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }));
      return restart({ ...baseOptions(dir), enforceUserManagerParent: true, _supervisorOverride: managed.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: fetch, ...extra });
    };
    const noResponse = await make(vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride);
    expect(noResponse.refusalReason).toBe("startup-failure");

    const noPidDir = root();
    const noPidSupervisor = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }));
    const noPid = await restart({ ...baseOptions(noPidDir), enforceUserManagerParent: true, _supervisorOverride: noPidSupervisor.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride });
    expect(noPid.refusalReason).toBe("live-no-response");

    const reprobe = managedSupervisor((spec, call) => call === 1
      ? { kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }
      : { kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name });
    reprobe.probe.mockImplementationOnce(async (spec: SupervisorSpec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name })).mockImplementationOnce(async () => { throw new Error("reprobe"); });
    const reprobeDir = root();
    writePid(reprobeDir, 200);
    const reprobeResult = await restart({ ...baseOptions(reprobeDir), enforceUserManagerParent: true, _supervisorOverride: reprobe.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride });
    expect(reprobeResult.refusalReason).toBe("live-no-response");

    const invalid = await make(vi.fn().mockResolvedValue(response({}, 500)) as unknown as FetchOverride);
    expect(invalid.refusalReason).toBe("response-invalid");
    const unknownBackend = await make(vi.fn().mockResolvedValue(response(health(200, { storageBackend: "oracle" }))) as unknown as FetchOverride);
    expect(unknownBackend.refusalReason).toBe("response-invalid");
    const authFailure = await make(vi.fn(async (url: string) => url.endsWith("/health")
      ? response(health(200))
      : response({ error: "unauthorized" }, 401)) as unknown as FetchOverride);
    expect(authFailure.refusalReason).toBe("response-auth-failure");

    const runtimeMismatch = await make(diagnosticsFetch(health(200, { runtimeDigest: "b".repeat(64) }), health(200, { runtimeDigest: "b".repeat(64) })), { expectedRuntimeDigest: "a".repeat(64) });
    expect(runtimeMismatch.refusalReason).toBe("response-invalid");
  });

  it("uses manager repair for responsive runtime mismatch and handles changed identity", async () => {
    const dir = root();
    writePid(dir, 200);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    const managed = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }), { kind: "systemd-user", managerPid: 201 });
    const fetch = diagnosticsFetch(
      health(200, { entrypoint: "/expected", runtimeDigest: "b".repeat(64) }),
      health(200, { entrypoint: "/expected", runtimeDigest: "b".repeat(64) }),
    );
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19_999, spawned: false }));
    let monotonicNow = 0;
    const clock = (): number => monotonicNow;
    managed.stopAndStart.mockImplementationOnce(async () => {
      monotonicNow = 30_000.75;
      return { kind: "systemd-user", managerPid: 200 };
    });
    const repaired = await restart({ ...baseOptions(dir), spawnTimeoutMs: 120_000, enforceUserManagerParent: true, expectedVersion: "2.0.0", expectedEntrypoint: "/expected", expectedRuntimeDigest: "b".repeat(64), spawnCommand: process.execPath, spawnArgs: ["/lcm", "daemon", "start", "--foreground"], _supervisorOverride: managed.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: fetch, _ensureDaemonOverride: ensureMock, _monotonicNowOverride: clock });
    expect(repaired.restarted).toBe(true);
    expect(managed.stopAndStart).toHaveBeenCalledWith(expect.anything(), { deadline: 120_000 });
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({
      spawnTimeoutMs: 89_999,
      _monotonicNowOverride: clock,
    }));

    const changed = managedSupervisor((spec, call) => call === 1
      ? { kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }
      : { kind: "ambiguous", reason: "state-conflict", name: spec.name });
    const changedDir = root();
    writePid(changedDir, 200);
    writeFileSync(join(changedDir, "daemon.token"), "token", { mode: 0o600 });
    const refused = await restart({ ...baseOptions(changedDir), enforceUserManagerParent: true, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: diagnosticsFetch(health(200), health(200)), _supervisorOverride: changed.supervisor });
    expect(refused.refusalReason).toBe("ambiguous");
  });

  it("floors exhausted managed restart admission budgets to zero", async () => {
    const dir = root();
    writePid(dir, 200);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    const managed = managedSupervisor((spec) => ({
      kind: "registered-running-valid",
      managerPid: 200,
      scopeDigest: spec.scopeDigest,
      nonce: spec.nonce,
      name: spec.name,
    }), { kind: "systemd-user", managerPid: 200 });
    let monotonicNow = 0;
    const clock = (): number => monotonicNow;
    managed.stopAndStart.mockImplementationOnce(async () => {
      monotonicNow = 120_000.25;
      return { kind: "systemd-user", managerPid: 200 };
    });
    const ensureMock = vi.fn(async () => ({ connected: false, port: 19_999, spawned: false }));

    await expect(restart({
      ...baseOptions(dir),
      spawnTimeoutMs: 120_000,
      enforceUserManagerParent: true,
      expectedVersion: "2.0.0",
      expectedEntrypoint: "/expected",
      expectedRuntimeDigest: "b".repeat(64),
      spawnCommand: process.execPath,
      spawnArgs: ["/lcm", "daemon", "start", "--foreground"],
      _supervisorOverride: managed.supervisor,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: diagnosticsFetch(
        health(200, { entrypoint: "/expected", runtimeDigest: "b".repeat(64) }),
        health(200, { entrypoint: "/expected", runtimeDigest: "b".repeat(64) }),
      ),
      _ensureDaemonOverride: ensureMock,
      _monotonicNowOverride: clock,
    })).resolves.toMatchObject({ restarted: true, connected: false });

    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({
      spawnTimeoutMs: 0,
      _monotonicNowOverride: clock,
    }));
  });

  it("passes the packaged entrypoint default through managed restart", async () => {
    const dir = root();
    writePid(dir, 200);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    const managed = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }));
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19_999, spawned: true }));
    const { expectedEntrypoint: _ignoredEntrypoint, ...withoutExplicitEntrypoint } = baseOptions(dir);
    const result = await restart({
      ...withoutExplicitEntrypoint,
      enforceUserManagerParent: true,
      _packagedEntrypointOverride: "/packaged/lcm.mjs",
      _supervisorOverride: managed.supervisor,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride,
      _ensureDaemonOverride: ensureMock,
    });
    expect(result.restarted).toBe(true);
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ expectedEntrypoint: "/packaged/lcm.mjs" }));
  });

  it("covers manager health deadline, endpoint collision, and stop/start failure", async () => {
    const expiredDir = root();
    writePid(expiredDir, 200);
    const expired = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }));
    let monotonicCalls = 0;
    const timeout = await restart({ ...baseOptions(expiredDir), enforceUserManagerParent: true, _monotonicNowOverride: () => monotonicCalls++ === 0 ? 0 : 100, _supervisorOverride: expired.supervisor, _isProcessAliveOverride: () => true });
    expect(timeout.refusalReason).toBe("response-timeout");

    const collisionDir = root();
    writePid(collisionDir, 200);
    const collision = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }));
    const collisionResult = await restart({ ...baseOptions(collisionDir), enforceUserManagerParent: true, _supervisorOverride: collision.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [], _fetchOverride: diagnosticsFetch(health(999)) });
    expect(collisionResult.refusalReason).toBe("invalid-collision");

    const failedDir = root();
    writePid(failedDir, 200);
    const failed = managedSupervisor((spec) => ({ kind: "registered-running-valid", managerPid: 200, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }));
    failed.stopAndStart.mockRejectedValue(new Error("manager stop"));
    const failure = await restart({ ...baseOptions(failedDir), enforceUserManagerParent: true, _supervisorOverride: failed.supervisor, _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [19_999], _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as unknown as FetchOverride });
    expect(failure.refusalReason).toBe("startup-failure");
  });

  it("fails closed when a verified detached daemon survives both termination signals", async () => {
    const dir = root("issue-600-detached-live-");
    writePid(dir, 200);
    const kill = vi.fn();
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19_999, spawned: false }));
    await expect(restart({
      ...baseOptions(dir),
      enforceUserManagerParent: false,
      _isManagedProcessOverride: () => true,
      _isProcessAliveOverride: () => true,
      _killOverride: kill,
      _sleepOverride: async () => undefined,
      _ensureDaemonOverride: ensureMock,
    })).rejects.toThrow("Unable to stop verified LCM daemon PID 200");
    expect(kill).toHaveBeenNthCalledWith(1, 200, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, 200, "SIGKILL");
    expect(ensureMock).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "daemon.pid"))).toBe(true);
  });

  it("migrates an authenticated legacy generated systemd daemon", async () => {
    const dir = root("issue-600-legacy-positive-");
    const procRoot = join(dir, "proc");
    mkdirSync(procRoot, { recursive: true });
    const pidPath = writePid(dir, 4242);
    writeFileSync(join(dir, "daemon.token"), "legacy-token", { mode: 0o600 });
    writeProc(procRoot, 4242, 1234, "node lcm daemon start --foreground");
    let alive = true;
    const events: string[] = [];
    const candidate = legacyUnit();
    const managed = legacyMigrationSupervisor(
      { kind: "candidates", candidates: [candidate] },
      () => {
        events.push("stop");
        alive = false;
        unlinkSync(pidPath);
      },
    );
    managed.probe.mockImplementation(async (spec: SupervisorSpec) => {
      events.push("stable-probe");
      return { kind: "absent" as const, name: spec.name };
    });
    managed.discoverLegacySystemdUnits.mockImplementation(async () => {
      events.push("discover");
      return { kind: "candidates" as const, candidates: [candidate] };
    });
    managed.start.mockImplementation(async () => {
      events.push("stable-start");
      return { kind: "systemd-user" as const, managerPid: 5252 };
    });
    const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/stats/pool")) {
        events.push("authenticated-access");
        return response({ totalConnections: 0 });
      }
      events.push(init?.headers ? "authenticated-health" : "public-health");
      return response(health(4242, {
        version: "1.4.1",
        ownerId: "legacy-owner",
        entrypoint: "/lcm",
      }));
    }) as unknown as FetchOverride;
    const ensureMock = vi.fn(async () => {
      events.push("stable-admission");
      return {
        connected: true,
        port: 19_999,
        spawned: true,
        pid: 5252,
        startMethod: "systemd-user" as const,
      };
    });
    const kill = vi.fn();

    const result = await restart({
      ...baseOptions(dir),
      _skipSpawn: false,
      expectedVersion: "1.4.2",
      enforceUserManagerParent: true,
      _procRoot: procRoot,
      _isProcessAliveOverride: () => alive,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _killOverride: kill,
      _supervisorOverride: managed.supervisor,
      _ensureDaemonOverride: ensureMock,
    });

    expect(result).toMatchObject({
      connected: true,
      restarted: true,
      stoppedPid: 4242,
      startMethod: "systemd-user",
    });
    expect(events).toEqual([
      "stable-probe",
      "discover",
      "public-health",
      "authenticated-health",
      "authenticated-access",
      "discover",
      "stop",
      "stable-start",
      "stable-admission",
    ]);
    expect(managed.stopAndStart).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(managed.stopLegacySystemdUnit).toHaveBeenCalledWith(candidate, { deadline: 100 });
    expect(managed.start).toHaveBeenCalledWith(expect.objectContaining({ nonce: expect.any(String) }), { deadline: 100 });
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({
      _managedOperationAuthorized: true,
      _managedOperationManagerPid: 5252,
    }));
    expect(existsSync(pidPath)).toBe(false);
  });

  it("starts stable after the real legacy supervisor observes one identity-bound deactivation", async () => {
    const dir = root("issue-614-legacy-transition-");
    const procRoot = join(dir, "proc");
    mkdirSync(procRoot, { recursive: true });
    const pidPath = writePid(dir, 4242);
    writeFileSync(join(dir, "daemon.token"), "legacy-token", { mode: 0o600 });
    writeProc(procRoot, 4242, 1234, "node lcm daemon start --foreground");
    let alive = true;
    const candidate = legacyUnit();
    const managerCalls: string[][] = [];
    const managerResults = [
      { code: 0, stdout: legacyManagerState("active", 4242, "running") },
      { code: 0, stdout: "stop queued" },
      { code: 0, stdout: legacyManagerState("deactivating", 0, "stop-sigterm") },
      { code: 0, stdout: legacyManagerState("not-found", 0, "dead") },
    ];
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      managerCalls.push([...args]);
      if (args[1] === "stop") {
        alive = false;
        unlinkSync(pidPath);
      }
      return managerResults.shift() ?? { code: 1, stderr: "unexpected manager call" };
    });
    const exactSupervisor = createSupervisor("systemd-user", {
      run,
      platform: "linux",
      stopTimeoutMs: 100,
      sleep: async () => undefined,
      now: () => 0,
    });
    const managed = legacyMigrationSupervisor(
      { kind: "candidates", candidates: [candidate] },
      undefined,
      exactSupervisor.stopLegacySystemdUnit,
    );
    managed.start.mockResolvedValue({ kind: "systemd-user", managerPid: 5252 });
    const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(health(4242, {
        version: "1.4.1",
        ownerId: "legacy-owner",
        entrypoint: "/lcm",
      }));
    }) as unknown as FetchOverride;
    const ensureMock = vi.fn(async () => ({
      connected: true,
      port: 19_999,
      spawned: true,
      pid: 5252,
      startMethod: "systemd-user" as const,
    }));

    await expect(restart({
      ...baseOptions(dir),
      _skipSpawn: false,
      expectedVersion: "1.4.2",
      enforceUserManagerParent: true,
      _procRoot: procRoot,
      _isProcessAliveOverride: () => alive,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _supervisorOverride: managed.supervisor,
      _ensureDaemonOverride: ensureMock,
    })).resolves.toMatchObject({
      connected: true,
      restarted: true,
      stoppedPid: 4242,
      startMethod: "systemd-user",
    });
    expect(managerCalls).toEqual([
      ["--user", "show", "--no-pager", "--property=LoadState,ActiveState,SubState,MainPID,InvocationID", candidate.name],
      ["--user", "stop", candidate.name],
      ["--user", "show", "--no-pager", "--property=LoadState,ActiveState,SubState,MainPID,InvocationID", candidate.name],
      ["--user", "show", "--no-pager", "--property=LoadState,ActiveState,SubState,MainPID,InvocationID", candidate.name],
    ]);
    expect(managed.start).toHaveBeenCalledOnce();
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(existsSync(pidPath)).toBe(false);
  });

  it("refuses stable start when the real legacy supervisor observes invocation drift", async () => {
    const dir = root("issue-614-legacy-invocation-drift-");
    const procRoot = join(dir, "proc");
    mkdirSync(procRoot, { recursive: true });
    const pidPath = writePid(dir, 4242);
    writeFileSync(join(dir, "daemon.token"), "legacy-token", { mode: 0o600 });
    writeProc(procRoot, 4242, 1234, "node lcm daemon start --foreground");
    let alive = true;
    const candidate = legacyUnit();
    const managerResults = [
      { code: 0, stdout: legacyManagerState("active", 4242, "running") },
      { code: 0, stdout: "stop queued" },
      {
        code: 0,
        stdout: legacyManagerState(
          "deactivating",
          0,
          "stop-sigterm",
          CHANGED_LEGACY_INVOCATION_ID,
        ),
      },
    ];
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[1] === "stop") {
        alive = false;
        unlinkSync(pidPath);
      }
      return managerResults.shift() ?? { code: 1, stderr: "unexpected manager call" };
    });
    const exactSupervisor = createSupervisor("systemd-user", {
      run,
      platform: "linux",
      stopTimeoutMs: 100,
      sleep: async () => undefined,
      now: () => 0,
    });
    const managed = legacyMigrationSupervisor(
      { kind: "candidates", candidates: [candidate] },
      undefined,
      exactSupervisor.stopLegacySystemdUnit,
    );
    const fetch = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(health(4242, {
        version: "1.4.1",
        ownerId: "legacy-owner",
        entrypoint: "/lcm",
      }));
    }) as unknown as FetchOverride;
    const ensureMock = vi.fn(async () => ({
      connected: true,
      port: 19_999,
      spawned: true,
      startMethod: "systemd-user" as const,
    }));

    await expect(restart({
      ...baseOptions(dir),
      _skipSpawn: false,
      expectedVersion: "1.4.2",
      enforceUserManagerParent: true,
      _procRoot: procRoot,
      _isProcessAliveOverride: () => alive,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _supervisorOverride: managed.supervisor,
      _ensureDaemonOverride: ensureMock,
    })).resolves.toMatchObject({
      restarted: false,
      refusalReason: "startup-failure",
      pid: 4242,
    });
    expect(run.mock.calls.filter(([, args]) => args[1] === "stop")).toHaveLength(1);
    expect(managed.start).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });
});

describe("authenticated legacy generated systemd refusal matrix", () => {
  const candidate = legacyUnit();
  const otherCandidate = legacyUnit({
    name: "lcm-daemon-5678-1720000000001.service",
    managerPid: 5678,
    invocationId: CHANGED_LEGACY_INVOCATION_ID,
  });
  const legacyHealth = (extra: Record<string, unknown> = {}): Record<string, unknown> => health(4242, {
    version: "1.4.1",
    ownerId: "legacy-owner",
    ...extra,
  });

  it.each([
    ["malformed PID before authentication", { pidState: "malformed" as const }, "ambiguous"],
    ["symlink PID before authentication", { pidState: "symlink" as const }, undefined],
    ["non-regular PID before authentication", { pidState: "directory" as const }, undefined],
    ["unrepresentable PID before authentication", { pidState: "unsafe-number" as const }, "ambiguous"],
    ["missing token", { tokenState: "missing" as const }, "response-auth-failure"],
    ["empty token", { tokenState: "empty" as const }, "response-auth-failure"],
    ["symlink token", { tokenState: "symlink" as const }, undefined],
    ["dead PID", { alive: false }, "ambiguous"],
    ["zero candidates", { discoveries: [{ kind: "candidates" as const, candidates: [] }] }, "ambiguous"],
    ["multiple candidates", { discoveries: [{ kind: "candidates" as const, candidates: [candidate, otherCandidate] }] }, "ambiguous"],
    ["disappearing candidate", { discoveries: [
      { kind: "candidates" as const, candidates: [candidate] },
      { kind: "candidates" as const, candidates: [] },
    ] }, "ambiguous"],
    ["manager PID mismatch", { discoveries: [{ kind: "candidates" as const, candidates: [{ ...candidate, managerPid: 5678 }] }] }, "invalid-collision"],
    ["invalid public health", { publicHealth: {} }, "response-invalid"],
    ["unrecognized public health", { publicHealth: { status: "warming", version: "1.4.1", pid: 4242 } }, "response-invalid"],
    ["unknown storage backend", { publicHealth: legacyHealth({ storageBackend: "oracle" }) }, "response-invalid"],
    ["public health timeout", { publicNoResponse: true }, "response-timeout"],
    ["public health PID mismatch", { publicHealth: legacyHealth({ pid: 9999 }) }, "invalid-collision"],
    ["authenticated identity mismatch", { authenticatedHealth: legacyHealth({ pid: 9999 }) }, "response-auth-failure"],
    ["token evidence changes during diagnostics", { tokenInvalidAfterInitialRead: true }, "response-auth-failure"],
    ["token evidence read fails during diagnostics", { tokenErrorAfterInitialRead: true }, "response-auth-failure"],
    ["diagnostics access failure", { accessStatus: 401 }, "response-auth-failure"],
    ["current version", { publicHealth: legacyHealth({ version: "1.4.2" }), authenticatedHealth: legacyHealth({ version: "1.4.2" }) }, "response-invalid"],
    ["newer version", { publicHealth: legacyHealth({ version: "1.4.3" }), authenticatedHealth: legacyHealth({ version: "1.4.3" }) }, "response-invalid"],
    ["cross-minor version", { publicHealth: legacyHealth({ version: "1.5.1" }), authenticatedHealth: legacyHealth({ version: "1.5.1" }) }, "response-invalid"],
    ["prerelease version", { publicHealth: legacyHealth({ version: "1.4.1-beta.1" }), authenticatedHealth: legacyHealth({ version: "1.4.1-beta.1" }) }, "response-invalid"],
    ["unrepresentable legacy version", { publicHealth: legacyHealth({ version: "1.4.9007199254740992" }), authenticatedHealth: legacyHealth({ version: "1.4.9007199254740992" }) }, "response-invalid"],
    ["wrong process", { processCommand: "node unrelated-service start --foreground" }, "invalid-collision"],
    ["wrong entrypoint", { publicHealth: legacyHealth({ entrypoint: "/wrong" }), authenticatedHealth: legacyHealth({ entrypoint: "/wrong" }) }, "response-invalid"],
    ["wrong listener", { listenerPorts: [] }, "invalid-collision"],
    ["pre-stop candidate change", { discoveries: [
      { kind: "candidates" as const, candidates: [candidate] },
      { kind: "candidates" as const, candidates: [otherCandidate] },
    ] }, "ambiguous"],
    ["pre-stop invocation witness change", { discoveries: [
      { kind: "candidates" as const, candidates: [candidate] },
      { kind: "candidates" as const, candidates: [{ ...candidate, invocationId: CHANGED_LEGACY_INVOCATION_ID }] },
    ] }, "ambiguous"],
    ["pre-stop discovery refusal", { discoveries: [
      { kind: "candidates" as const, candidates: [candidate] },
      { kind: "unavailable" as const, reason: "manager-timeout" },
    ] }, "ambiguous"],
    ["stop failure", { stopBehavior: "throw" as const }, "startup-failure"],
    ["changed PID file after stop", { stopBehavior: "replace-pid" as const }, "ambiguous"],
    ["unsafe PID file after stop", { stopBehavior: "replace-unsafe" as const }, "ambiguous"],
    ["PID remains alive after stop", { stopBehavior: "keep-alive" as const }, "startup-failure"],
    ["descriptor replacement between reads", { mutatePidBeforeSecondDiscovery: true }, "ambiguous"],
    ["manager discovery unavailable", { discoveries: [{ kind: "unavailable" as const, reason: "manager-timeout" }] }, "manager-unavailable"],
    ["manager discovery failure", { discoveryThrows: true }, "manager-unavailable"],
  ] as const)("refuses $0 without broad mutation", async (_name, config, refusalReason) => {
    const fixture = await runLegacyFixture(config);
    expect(fixture.result).toMatchObject({ restarted: false });
    if (refusalReason === undefined) expect(fixture.result.refusalReason).toBeUndefined();
    else expect(fixture.result.refusalReason).toBe(refusalReason);
    if (config.stopBehavior === undefined) expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    else expect(fixture.supervisor.stopLegacySystemdUnit).toHaveBeenCalledOnce();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
    expect(fixture.kill).not.toHaveBeenCalled();
  });

  it("refuses stable start when a remaining PID path is unchanged after the exact legacy stop", async () => {
    const fixture = await runLegacyFixture({ stopBehavior: "leave-pid" });
    expect(fixture.result).toMatchObject({ restarted: false, refusalReason: "ambiguous", pid: 4242 });
    expect(fixture.supervisor.stopLegacySystemdUnit).toHaveBeenCalledOnce();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidPath, "utf-8")).toBe("4242");
    expect(legacyPidFileFault.unlinkCalls).toBe(0);
  });

  it("refuses missing PID evidence when strict discovery finds a legacy candidate", async () => {
    const fixture = await runLegacyFixture({ pidState: "missing" });
    expect(fixture.result).toMatchObject({ restarted: false, refusalReason: "ambiguous" });
    expect(fixture.result.warning).toContain("PID evidence was missing");
    expect(fixture.supervisor.discoverLegacySystemdUnits).toHaveBeenCalledWith({ deadline: 100 });
    expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
  });

  it("refuses missing PID evidence when strict discovery is unavailable", async () => {
    const fixture = await runLegacyFixture({
      pidState: "missing",
      discoveries: [{ kind: "unavailable", reason: "manager-timeout" }],
    });
    expect(fixture.result).toMatchObject({ restarted: false, refusalReason: "manager-unavailable" });
    expect(fixture.supervisor.discoverLegacySystemdUnits).toHaveBeenCalledWith({ deadline: 100 });
    expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
  });

  it.each(["reloading", "refreshing", "activating", "deactivating", "maintenance", "inactive", "failed"] as const)(
    "refuses missing PID evidence while a strict legacy unit is %s",
    async () => {
      const fixture = await runLegacyFixture({
        pidState: "missing",
        discoveries: [{ kind: "unavailable", reason: "state-conflict" }],
      });
      expect(fixture.result).toMatchObject({ restarted: false, refusalReason: "manager-unavailable" });
      expect(fixture.supervisor.discoverLegacySystemdUnits).toHaveBeenCalledWith({ deadline: 100 });
      expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
      expect(fixture.supervisor.start).not.toHaveBeenCalled();
      expect(fixture.ensure).not.toHaveBeenCalled();
    },
  );

  it("treats a legacy PID descriptor close failure as unsafe evidence", async () => {
    const fixture = await runLegacyFixture({ pidCloseError: true });
    expect(fixture.result).toMatchObject({ restarted: false, refusalReason: "ambiguous" });
    expect(fixture.result.warning).toContain("legacy daemon PID evidence was not a safe regular file");
    expect(legacyPidFileFault.closeAttempts).toBe(1);
    expect(legacyPidFileFault.openCalls).toBe(1);
    expect(legacyTokenFileFault.openCalls).toBe(0);
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.supervisor.discoverLegacySystemdUnits).not.toHaveBeenCalled();
    expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(legacyPidFileFault.unlinkCalls).toBe(0);
    expect(readFileSync(fixture.pidPath, "utf-8")).toBe("4242");
  });

  it("opens boundary-sized legacy evidence without following or blocking", async () => {
    const fixture = await runLegacyFixture({
      pidState: "boundary",
      tokenState: "boundary",
    });
    const expectedFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    expect(fixture.result).toMatchObject({
      connected: true,
      restarted: true,
      stoppedPid: 4242,
    });
    expect(legacyPidFileFault.openFlags).toEqual(Array(3).fill(expectedFlags));
    expect(legacyTokenFileFault.openFlags).toEqual(Array(2).fill(expectedFlags));
  });

  it("refuses a 65-byte PID before discovery, authentication, or mutation", async () => {
    const fixture = await runLegacyFixture({ pidState: "oversized" });
    expect(fixture.result).toMatchObject({
      restarted: false,
      refusalReason: "ambiguous",
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.supervisor.discoverLegacySystemdUnits).not.toHaveBeenCalled();
    expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
  });

  it("refuses a 4097-byte token before authenticated diagnostics or mutation", async () => {
    const fixture = await runLegacyFixture({ tokenState: "oversized" });
    expect(fixture.result).toMatchObject({
      restarted: false,
      refusalReason: "response-auth-failure",
    });
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture.fetch.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
  });

  it.each([
    ["PID", { pidState: "hardlink" as const }, "ambiguous", 0],
    ["token", { tokenState: "hardlink" as const }, "response-auth-failure", 1],
  ])("refuses multiply-linked legacy %s evidence", async (_name, config, refusalReason, fetchCalls) => {
    const fixture = await runLegacyFixture(config);
    expect(fixture.result).toMatchObject({ restarted: false, refusalReason });
    expect(fixture.fetch).toHaveBeenCalledTimes(fetchCalls);
    expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
  });

  it("refuses PID pathname disappearance during post-stop descriptor validation", async () => {
    const fixture = await runLegacyFixture({
      stopBehavior: "leave-pid",
      pidValidationFaultAfterStop: "missing",
    });
    expect(fixture.result).toMatchObject({
      connected: false,
      restarted: false,
      refusalReason: "ambiguous",
      pid: 4242,
    });
    expect(fixture.supervisor.stopLegacySystemdUnit).toHaveBeenCalledOnce();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
    expect(existsSync(fixture.pidPath)).toBe(false);
  });

  it("refuses a dangling PID symlink installed after the post-stop open", async () => {
    const fixture = await runLegacyFixture({
      stopBehavior: "leave-pid",
      pidValidationFaultAfterStop: "dangling-symlink",
    });
    expect(fixture.result).toMatchObject({
      connected: false,
      restarted: false,
      refusalReason: "ambiguous",
      pid: 4242,
    });
    expect(fixture.supervisor.stopLegacySystemdUnit).toHaveBeenCalledOnce();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
    expect(lstatSync(fixture.pidPath).isSymbolicLink()).toBe(true);
  });

  it.each([
    "first-missing",
    "first-non-directory",
    "missing",
    "non-directory",
    "device-change",
    "inode-change",
  ] as const)(
    "refuses direct PID absence when the parent is %s during classification",
    async (parentFault) => {
      const fixture = await runLegacyFixture({
        pidState: "missing",
        pidMissingParentFault: parentFault,
        discoveries: [{ kind: "candidates", candidates: [] }],
      });
      expect(fixture.result).toMatchObject({
        connected: false,
        restarted: false,
        refusalReason: "ambiguous",
      });
      expect(fixture.supervisor.discoverLegacySystemdUnits).not.toHaveBeenCalled();
      expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
      expect(fixture.supervisor.start).not.toHaveBeenCalled();
      expect(fixture.ensure).not.toHaveBeenCalled();
    },
  );

  it("refuses a non-ENOENT PID leaf lstat failure before authentication", async () => {
    const fixture = await runLegacyFixture({ pidLeafLstatError: "EACCES" });
    expect(fixture.result).toMatchObject({
      connected: false,
      restarted: false,
      refusalReason: "ambiguous",
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.supervisor.discoverLegacySystemdUnits).not.toHaveBeenCalled();
    expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
  });

  it("preserves normal absent startup when missing PID evidence has no legacy candidates", async () => {
    const fixture = await runLegacyFixture({
      pidState: "missing",
      discoveries: [{ kind: "candidates", candidates: [] }],
    });
    expect(fixture.result).toMatchObject({ connected: true, restarted: false });
    expect(fixture.supervisor.discoverLegacySystemdUnits).toHaveBeenCalledWith({ deadline: 100 });
    expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.ensure).toHaveBeenCalledOnce();
  });

  it.each(["replacement", "symlink", "hardlink"] as const)(
    "refuses a %s inserted at the former cleanup seam without unlink or stable start",
    async (mutation) => {
      const fixture = await runLegacyFixture({
        stopBehavior: "leave-pid",
        formerCleanupMutation: mutation,
      });
      expect(fixture.result).toMatchObject({ restarted: false, refusalReason: "ambiguous", pid: 4242 });
      expect(fixture.supervisor.stopLegacySystemdUnit).toHaveBeenCalledOnce();
      expect(fixture.supervisor.start).not.toHaveBeenCalled();
      expect(fixture.ensure).not.toHaveBeenCalled();
      expect(existsSync(fixture.pidPath)).toBe(true);
      expect(legacyPidFileFault.unlinkCalls).toBe(0);
      if (mutation === "replacement") expect(readFileSync(fixture.pidPath, "utf-8")).toBe("9999");
      if (mutation === "symlink") expect(lstatSync(fixture.pidPath).isSymbolicLink()).toBe(true);
      if (mutation === "hardlink") expect(statSync(fixture.pidPath).nlink).toBe(2);
    },
  );

  it.each([
    ["PID evidence is replaced between reads", "replacement" as const, "legacy daemon PID evidence changed between reads"],
    ["PID evidence becomes unsafe between reads", "unsafe" as const, "legacy daemon PID evidence changed to an unsafe file"],
    ["PID evidence disappears after preflight", "missing" as const, "legacy daemon PID evidence changed to an unsafe file"],
  ])("refuses $0 before manager discovery", async (_name, mode, warning) => {
    const dir = root("issue-600-legacy-pid-race-");
    const pidPath = writePid(dir, 4242);
    writeFileSync(join(dir, "daemon.token"), "legacy-token", { mode: 0o600 });
    const supervisor = legacyMigrationSupervisor({ kind: "candidates", candidates: [legacyUnit()] });
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19_999, spawned: false }));
    legacyPidFileFault.path = pidPath;
    legacyPidFileFault.mode = mode;
    vi.resetModules();
    const { restartDaemon } = await import("../../src/daemon/lifecycle.js");
    const result = await restartDaemon(hermetic({
      ...baseOptions(dir),
      _skipSpawn: false,
      expectedVersion: "1.4.2",
      enforceUserManagerParent: true,
      _supervisorOverride: supervisor.supervisor,
      _isProcessAliveOverride: () => true,
      _ensureDaemonOverride: ensureMock,
    }));
    expect(result).toMatchObject({ restarted: false, refusalReason: "ambiguous" });
    expect(result.warning).toContain(warning);
    expect(supervisor.discoverLegacySystemdUnits).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("preserves staged credentials when stable admission cleanup fails", async () => {
    cleanupFault.throw = true;
    const fixture = await runLegacyFixture({ environment: { OPENAI_API_KEY: "legacy-cleanup-secret" } });
    expect(fixture.result).toMatchObject({ connected: true, restarted: true, stoppedPid: 4242 });
    expect(fixture.ensure).toHaveBeenCalledOnce();
    expect(readdirSync(join(dirname(fixture.pidPath), "credentials"))).not.toHaveLength(0);
  });

  it("starts the stable daemon only after exact stop removes the legacy PID file", async () => {
    const fixture = await runLegacyFixture({ stopBehavior: "remove-pid" });
    expect(fixture.result).toMatchObject({ connected: true, restarted: true, stoppedPid: 4242 });
    expect(fixture.supervisor.stopLegacySystemdUnit).toHaveBeenCalledOnce();
    expect(fixture.supervisor.start).toHaveBeenCalledOnce();
    expect(existsSync(fixture.pidPath)).toBe(false);
  });

  it("refuses a remaining legacy PID path without a scoped test-state seam", async () => {
    const dir = root("issue-600-legacy-unscoped-cleanup-");
    const procRoot = join(dir, "proc");
    mkdirSync(procRoot, { recursive: true });
    const pidPath = writePid(dir, 4242);
    writeFileSync(join(dir, "daemon.token"), "legacy-token", { mode: 0o600 });
    writeProc(procRoot, 4242, 1234, "node lcm daemon start --foreground");
    let alive = true;
    const candidate = legacyUnit();
    const supervisor = legacyMigrationSupervisor(
      { kind: "candidates", candidates: [candidate] },
      () => { alive = false; },
    );
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19_999, spawned: true, startMethod: "systemd-user" as const }));
    const previousArgv = process.argv[1];
    process.argv[1] = "/tmp/lcm-production-entrypoint.js";
    try {
      const result = await restartDaemonProduction({
        ...baseOptions(dir),
        _skipSpawn: false,
        expectedVersion: "1.4.2",
        enforceUserManagerParent: true,
        _procRoot: procRoot,
        _isProcessAliveOverride: () => alive,
        _listeningPortsOverride: () => [19_999],
        _fetchOverride: diagnosticsFetch(health(4242, { version: "1.4.1" })),
        _supervisorOverride: supervisor.supervisor,
        _ensureDaemonOverride: ensureMock,
      });
      expect(result).toMatchObject({ connected: false, restarted: false, refusalReason: "ambiguous", pid: 4242 });
      expect(readFileSync(pidPath, "utf-8")).toBe("4242");
      expect(supervisor.start).not.toHaveBeenCalled();
      expect(ensureMock).not.toHaveBeenCalled();
    } finally {
      process.argv[1] = previousArgv;
    }
  });

  it("refuses a multiply-linked legacy PID file before authentication", async () => {
    const dir = root("issue-600-legacy-hardlink-");
    const procRoot = join(dir, "proc");
    mkdirSync(procRoot, { recursive: true });
    const pidPath = writePid(dir, 4242);
    linkSync(pidPath, `${pidPath}.alias`);
    writeFileSync(join(dir, "daemon.token"), "legacy-token", { mode: 0o600 });
    writeProc(procRoot, 4242, 1234, "node lcm daemon start --foreground");
    const candidate = legacyUnit();
    const supervisor = legacyMigrationSupervisor({ kind: "candidates", candidates: [candidate] });
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19_999, spawned: false }));
    const previousArgv = process.argv[1];
    process.argv[1] = "/tmp/lcm-production-entrypoint.js";
    try {
      const result = await restartDaemonProduction({
        ...baseOptions(dir),
        _skipSpawn: false,
        expectedVersion: "1.4.2",
        enforceUserManagerParent: true,
        _procRoot: procRoot,
        _isProcessAliveOverride: () => true,
        _listeningPortsOverride: () => [19_999],
        _fetchOverride: diagnosticsFetch(health(4242, { version: "1.4.1", ownerId: "legacy-owner" })),
        _supervisorOverride: supervisor.supervisor,
        _ensureDaemonOverride: ensureMock,
      });
      expect(result).toMatchObject({ restarted: false, refusalReason: "ambiguous" });
      expect(supervisor.discoverLegacySystemdUnits).not.toHaveBeenCalled();
      expect(supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
      expect(ensureMock).not.toHaveBeenCalled();
    } finally {
      process.argv[1] = previousArgv;
    }
  });

  it("uses authenticated procfs listener ownership when no listener override is supplied", async () => {
    const fixture = await runLegacyFixture({ useProcListener: true });
    expect(fixture.result).toMatchObject({ connected: true, restarted: true, stoppedPid: 4242 });
    expect(fixture.supervisor.stopLegacySystemdUnit).toHaveBeenCalledOnce();
    expect(fixture.supervisor.start).toHaveBeenCalledOnce();
  });

  it("refuses a scoped legacy daemon whose public owner identity collides", async () => {
    const fixture = testScopeFixture("legacy-owner-collision-");
    const pidPath = writePid(fixture.scope.stateDir, 4242);
    writeFileSync(join(fixture.scope.stateDir, "daemon.token"), "legacy-token", { mode: 0o600 });
    const candidate = legacyUnit();
    const supervisor = legacyMigrationSupervisor({ kind: "candidates", candidates: [candidate] });
    const fetch = fixture.scope.dependencies.fetch as unknown as ReturnType<typeof vi.fn>;
    fetch.mockImplementation(async (url: string) => url.endsWith("/stats/pool")
      ? response({ totalConnections: 0 })
      : response(health(4242, { version: "1.4.1", ownerId: "foreign-owner", entrypoint: fixture.scope.entrypoint })));
    const alive = fixture.scope.dependencies.isProcessAlive as unknown as ReturnType<typeof vi.fn>;
    alive.mockReturnValue(true);
    const result = await restartDaemonProduction({
      port: 19_999,
      pidFilePath: pidPath,
      spawnTimeoutMs: 100,
      expectedVersion: "1.4.2",
      expectedEntrypoint: fixture.scope.entrypoint,
      enforceUserManagerParent: true,
      _platform: "linux",
      _testScope: fixture.scope,
      _supervisorOverride: supervisor.supervisor,
      _listeningPortsOverride: () => [19_999],
      _monotonicNowOverride: () => 0,
      _skipSpawn: false,
      _ensureDaemonOverride: vi.fn(async () => ({ connected: true, port: 19_999, spawned: true })),
    });
    expect(result).toMatchObject({ restarted: false, refusalReason: "invalid-collision" });
    expect(supervisor.discoverLegacySystemdUnits).toHaveBeenCalledOnce();
  });

  it("refuses an authenticated legacy migration interrupted before exact stop", async () => {
    const controller = new AbortController();
    const fixture = await runLegacyFixture({ abortController: controller, abortSignal: controller.signal, abortBeforePreStop: true });
    expect(fixture.result).toMatchObject({ restarted: false, refusalReason: "response-timeout" });
    expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
  });

  it("refuses an authenticated legacy migration whose deadline expires before exact stop", async () => {
    const fixture = await runLegacyFixture({ expireBeforePreStop: true });
    expect(fixture.result).toMatchObject({ restarted: false, refusalReason: "response-timeout" });
    expect(fixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
  });

  it("does not report a migrated restart when the stable start fails", async () => {
    const fixture = await runLegacyFixture({ startBehavior: "throw" });
    expect(fixture.result).toMatchObject({
      restarted: false,
      refusalReason: "startup-failure",
      stoppedPid: 4242,
    });
    expect(fixture.supervisor.start).toHaveBeenCalledOnce();
    expect(fixture.ensure).not.toHaveBeenCalled();
  });

  it.each(supervisorFailureCases)("classifies %s during stable start after legacy migration", async (_name, createError, typed) => {
    const fixture = await runLegacyFixture({ startError: createError() });
    expect(fixture.result).toMatchObject({
      connected: false,
      restarted: false,
      refusalReason: "startup-failure",
      stoppedPid: 4242,
      warning: typed
        ? SUPERVISOR_DAEMON_TEMP_CREATION_WARNING
        : "stable daemon start failed after authenticated legacy migration",
    });
    expect(fixture.result.pid).toBeUndefined();
    expect(JSON.stringify(fixture.result)).not.toContain(SUPERVISOR_FAILURE_SECRET);
    expect(fixture.supervisor.start).toHaveBeenCalledOnce();
    expect(fixture.ensure).not.toHaveBeenCalled();
  });

  it("refuses interruption and deadline exhaustion before legacy mutation", async () => {
    const interrupted = root("issue-600-legacy-interrupted-");
    const signal = new AbortController();
    signal.abort();
    const interruptedFixture = legacyMigrationSupervisor({ kind: "candidates", candidates: [candidate] });
    const interruptedResult = await restart({
      ...baseOptions(interrupted),
      enforceUserManagerParent: true,
      _abortSignal: signal.signal,
      _supervisorOverride: interruptedFixture.supervisor,
    });
    expect(interruptedResult).toMatchObject({ restarted: false });
    expect(interruptedFixture.discoverLegacySystemdUnits).not.toHaveBeenCalled();
    expect(interruptedFixture.stopLegacySystemdUnit).not.toHaveBeenCalled();

    const deadlineClock = vi.fn().mockReturnValueOnce(0).mockReturnValue(100);
    const deadlineFixture = await runLegacyFixture({ monotonicNow: deadlineClock });
    // The fixture's clock expires after the stable probe and before the first
    // authenticated legacy request, so no stop or stable start is allowed.
    expect(deadlineFixture.result).toMatchObject({ restarted: false, refusalReason: "response-timeout" });
    expect(deadlineFixture.supervisor.stopLegacySystemdUnit).not.toHaveBeenCalled();
    expect(deadlineFixture.supervisor.start).not.toHaveBeenCalled();
  });
});

describe("managed restart staged credential cleanup", () => {
  function snapshotStagedCredentials(spec: SupervisorSpec): ManagedCredentialSnapshot {
    expect(spec.credentialDirectory).toBeDefined();
    return {
      directory: spec.credentialDirectory!,
      files: (spec.credentialFiles ?? []).map((file) => ({
        name: file.name,
        path: file.path,
      })),
    };
  }

  function expectPreservedSnapshot(
    snapshot: ManagedCredentialSnapshot,
    stateRoot: string,
    credentialValues: Record<string, string>,
  ): void {
    const canonicalRoot = realpathSync(stateRoot);
    const canonicalDirectory = realpathSync(snapshot.directory);
    expect(canonicalDirectory.startsWith(`${canonicalRoot}/`)).toBe(true);
    expect(readdirSync(canonicalDirectory).sort()).toEqual(snapshot.files.map((file) => file.name).sort());
    for (const file of snapshot.files) {
      expect(readFileSync(file.path, "utf-8")).toBe(credentialValues[file.name]);
    }
  }

  function runningManagerSetup(): { supervisor: Supervisor; staged: () => ManagedCredentialSnapshot | undefined } {
    let staged: ManagedCredentialSnapshot | undefined;
    const probe = vi.fn(async (spec: SupervisorSpec) => ({
      kind: "registered-running-valid" as const,
      managerPid: 200,
      scopeDigest: spec.scopeDigest,
      nonce: spec.nonce,
      name: spec.name,
    }));
    const stopAndStart = vi.fn(async (spec: SupervisorSpec) => {
      staged = snapshotStagedCredentials(spec);
      return { kind: "launchd-user" as const, name: spec.name, scopeDigest: spec.scopeDigest, port: 19_999, nonce: spec.nonce, managerPid: 201 };
    });
    return {
      staged: () => staged,
      supervisor: {
        probe,
        start: vi.fn(),
        stopAndStart,
        stopAndAwaitAbsent: vi.fn(async (spec: SupervisorSpec) => {
          if (spec.credentialDirectory !== undefined) {
            cleanupManagedCredentialDirectory(spec.credentialDirectory, spec.stateRoot);
          }
        }),
      } as unknown as Supervisor,
    };
  }

  function credentialRestartWith(
    dir: string,
    supervisor: Supervisor,
    ensureMock: (o: EnsureDaemonOptions) => Promise<Record<string, unknown>>,
    values: Record<string, string>,
  ) {
    writePid(dir, 200);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    const options: RestartDaemonOptions = {
      ...baseOptions(dir),
      _platform: "darwin",
      enforceUserManagerParent: true,
      _supervisorOverride: supervisor,
      _isProcessAliveOverride: () => true,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: diagnosticsFetch(health(200), health(200)),
      _ensureDaemonOverride: ensureMock as NonNullable<RestartDaemonOptions["_ensureDaemonOverride"]>,
    };
    const hermeticOptions = hermetic(options);
    hermeticOptions._hermeticTestSeams!.environment = values;
    return restartDaemonProduction(hermeticOptions);
  }

  const stagedCredentialValues = (): Record<string, string> => ({
    OPENAI_API_KEY: `restart-staged-secret-${randomBytes(4).toString("hex")}`,
  });

  it("removes the staged directory only after authenticated admission inside its state root", async () => {
    const dir = root("staged-success-");
    const { supervisor, staged } = runningManagerSetup();
    const values = stagedCredentialValues();
    const result = await credentialRestartWith(
      dir,
      supervisor,
      async () => ({ connected: true, port: 19_999, spawned: true, startMethod: "launchd-user" }),
      values,
    );
    expect(result).toMatchObject({ connected: true, restarted: true, startMethod: "launchd-user" });
    const snapshot = staged();
    expect(snapshot).toBeDefined();
    expect(snapshot!.files).toEqual([{ name: "OPENAI_API_KEY", path: join(snapshot!.directory, "OPENAI_API_KEY") }]);
    expect(existsSync(snapshot!.directory)).toBe(false);
    expect(realpathSync(dir)).toBe(dir);
  });

  it("preserves exact staged evidence when manager stop/start fails unresolved", async () => {
    const dir = root("staged-throw-");
    const { supervisor, staged } = runningManagerSetup();
    const values = stagedCredentialValues();
    let capturedStaged: SupervisorSpec | undefined;
    (supervisor.stopAndStart as ReturnType<typeof vi.fn>).mockImplementation(async (spec: SupervisorSpec) => {
      capturedStaged = spec;
      throw new Error("manager stop/start failed");
    });
    const ensureMock = vi.fn(async () => ({ connected: true, port: 19_999, spawned: false }));
    const result = await credentialRestartWith(dir, supervisor, ensureMock, values);
    expect(result).toMatchObject({ connected: false, restarted: false, refusalReason: "startup-failure" });
    expect(ensureMock).not.toHaveBeenCalled();
    expect(capturedStaged?.credentialDirectory).toBeDefined();
    const directory = capturedStaged!.credentialDirectory!;
    const files = (capturedStaged!.credentialFiles ?? []).map((file) => ({ name: file.name, path: file.path }));
    expectPreservedSnapshot({ directory, files }, dir, values);
    expect(staged()).toBeUndefined();
  });

  it("preserves exact staged evidence when the post-start ensure is not admitted", async () => {
    const dir = root("staged-unadmitted-");
    const { supervisor, staged } = runningManagerSetup();
    const values = stagedCredentialValues();
    const ensureMock = vi.fn(async () => ({ connected: false, port: 19_999, spawned: true, refusalReason: "response-timeout" as const, warning: "mooted" }));
    const observation = await credentialRestartWith(dir, supervisor, ensureMock, values);
    expect(observation).toMatchObject({ connected: false, restarted: true, refusalReason: "response-timeout", warning: "mooted" });
    expect(ensureMock).toHaveBeenCalledOnce();
    const snapshot = staged();
    expect(snapshot).toBeDefined();
    expectPreservedSnapshot(snapshot!, dir, values);
  });

  it("treats an already-consumed missing staged directory after admission as clean", async () => {
    const dir = root("staged-consumed-");
    const { supervisor, staged } = runningManagerSetup();
    const values = stagedCredentialValues();
    const ensureMock = vi.fn(async (o: EnsureDaemonOptions) => {
      const directory = o._supervisorCredentialDirectoryOverride!;
      rmSync(directory, { recursive: true, force: true });
      return { connected: true, port: 19_999, spawned: true, startMethod: "launchd-user" };
    });
    const result = await credentialRestartWith(dir, supervisor, ensureMock, values);
    expect(result).toMatchObject({ connected: true, restarted: true });
    expect(staged()?.directory).toBeDefined();
  });

  it("never lets lifecycle cleanup remove credentials owned by a neighbor state root", async () => {
    const dir = root("staged-isolation-");
    const neighbor = root("staged-neighbor-");
    mkdirSync(join(neighbor, "credentials"), { recursive: true, mode: 0o700 });
    writeFileSync(join(neighbor, "credentials", "OPENAI_API_KEY"), "neighbor-secret", { mode: 0o600 });
    const { supervisor } = runningManagerSetup();
    const ensureMock = vi.fn(async (o: EnsureDaemonOptions) => {
      const statedDirectory = o._supervisorCredentialDirectoryOverride!;
      const foreignDirectory = join(neighbor, "credentials");
      expect(statedDirectory).not.toBe(foreignDirectory);
      try {
        cleanupManagedCredentialDirectory(foreignDirectory, dir);
        throw new Error("cleanup accepted a credential directory outside its state root");
      } catch (error) {
        expect(String(error)).toContain("escapes state root");
      }
      expect(readFileSync(join(foreignDirectory, "OPENAI_API_KEY"), "utf-8")).toBe("neighbor-secret");
      return { connected: true, port: 19_999, spawned: true, startMethod: "launchd-user" };
    });
    const result = await credentialRestartWith(dir, supervisor, ensureMock, stagedCredentialValues());
    expect(result).toMatchObject({ connected: true, restarted: true });
    expect(readFileSync(join(neighbor, "credentials", "OPENAI_API_KEY"), "utf-8")).toBe("neighbor-secret");
  });
});

describe("legacy restart and terminal cleanup coverage", () => {
  it("rejects conflicting and out-of-scope restart state", async () => {
    const fixture = testScopeFixture("conflict-");
    const conflictRoot = root();
    const conflictOptions = hermetic({ ...baseOptions(conflictRoot) });
    const conflict = await restartDaemonProduction({
      ...conflictOptions,
      _testScope: fixture.scope,
    });
    expect(conflict.warning).toContain("conflicts with hermetic");

    const outside = root();
    const outsideResult = await restartDaemonProduction({
      ...baseOptions(join(outside, "state")),
      _testScope: fixture.scope,
    });
    expect(outsideResult.warning).toContain("not exact canonical owned state");
  });

  it("refuses a scoped restart when its filesystem changes during validation", async () => {
    const fixture = testScopeFixture("validation-");
    const pidPath = join(fixture.scope.stateDir, "daemon.pid");
    const tokenPath = join(fixture.scope.stateDir, "daemon.token");
    const result = await restartDaemonProduction({
      port: 19_999,
      pidFilePath: pidPath,
      spawnTimeoutMs: 100,
      _testScope: fixture.scope,
      validateBeforeRestart: () => {
        renameSync(fixture.scope.stateDir, join(fixture.root, "state-before-validation"));
        mkdirSync(fixture.scope.stateDir);
      },
    });
    expect(result).toMatchObject({
      connected: false,
      port: 19_999,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle test state changed during restart validation",
    });
    expect(fixture.scope.dependencies.fetch).not.toHaveBeenCalled();
    expect(fixture.scope.dependencies.spawn).not.toHaveBeenCalled();
    expect(fixture.scope.dependencies.spawnSync).not.toHaveBeenCalled();
    expect(fixture.scope.dependencies.killProcess).not.toHaveBeenCalled();
    expect(tokenPath).toContain("daemon.token");
  });

  it("refuses a hermetic restart when state changes during validation", async () => {
    const dir = root();
    const result = await restart({
      ...baseOptions(dir),
      validateBeforeRestart: () => {
        rmSync(dir, { recursive: true, force: true });
        privateDirectory(dir);
      },
    });
    expect(result.warning).toContain("hermetic state changed during restart validation");
  });

  it("disables restart in an unscoped Vitest worker", async () => {
    const originalArg = process.argv[1];
    process.argv[1] = "/tmp/node_modules/vitest/dist/workers/run.js";
    try {
      const result = await restartDaemonProduction({
        port: 19_999,
        pidFilePath: join(root(), "daemon.pid"),
        spawnTimeoutMs: 100,
      });
      expect(result.warning).toContain("disabled for an unscoped Vitest worker");
    } finally {
      process.argv[1] = originalArg;
    }
  });

  it("returns a not-running refusal when the exact PID proof catches an unsafe replacement", async () => {
    const dir = root();
    const external = join(root(), "outside.pid");
    writeFileSync(external, "200");
    const supervisor = managedSupervisor((spec) => {
      symlinkSync(external, join(dir, "daemon.pid"));
      return { kind: "absent", name: spec.name };
    });
    const result = await restart({ ...baseOptions(dir), enforceUserManagerParent: true, _supervisorOverride: supervisor.supervisor });
    expect(result.refusalReason).toBe("not-running");
  });

  it("reports a legacy PID binding change before signaling", async () => {
    const dir = root();
    writePid(dir, 20);
    const ensureMock = vi.fn();
    const resultPromise = restart({
      ...baseOptions(dir),
      enforceUserManagerParent: false,
      _isManagedProcessOverride: () => {
        writePid(dir, 21);
        return true;
      },
      _isProcessAliveOverride: () => true,
      _ensureDaemonOverride: ensureMock,
    });
    await expect(resultPromise).rejects.toThrow("PID changed before restart signaling");
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("refuses a Darwin legacy PID whose ps identity changes before signaling", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    let psCalls = 0;
    const ps = vi.fn(() => ({
      status: 0,
      stdout: ++psCalls === 1 ? "node lcm daemon start --foreground\n" : "node unrelated\n",
      stderr: "",
    }));
    const fetch = diagnosticsFetch(health(20), health(20));
    const kill = vi.fn();
    await expect(restart({
      ...baseOptions(dir),
      enforceUserManagerParent: false,
      _platform: "darwin",
      _spawnSyncOverride: ps as unknown as SpawnSyncOverride,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: fetch,
      _isProcessAliveOverride: () => true,
      _killOverride: kill,
    })).rejects.toThrow("identity changed before signaling");
    expect(kill).not.toHaveBeenCalled();
  });

  it("returns the interrupted result before signaling a verified legacy PID", async () => {
    const dir = root();
    writePid(dir, 20);
    const controller = new AbortController();
    const ensureMock = vi.fn(async () => ({ connected: false, port: 19_999, spawned: true }));
    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: false,
      _abortSignal: controller.signal,
      _isManagedProcessOverride: () => {
        controller.abort();
        return true;
      },
      _isProcessAliveOverride: () => true,
      _ensureDaemonOverride: ensureMock,
    });
    expect(result.restarted).toBe(false);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("revalidates Darwin ps identity immediately before signaling", async () => {
    const dir = root();
    writePid(dir, 20);
    writeFileSync(join(dir, "daemon.token"), "token", { mode: 0o600 });
    let alive = true;
    const kill = vi.fn(() => { alive = false; });
    const ps = vi.fn(() => ({ status: 0, stdout: "node lcm daemon start --foreground\n", stderr: "" }));
    const result = await restart({
      ...baseOptions(dir),
      enforceUserManagerParent: false,
      _platform: "darwin",
      _isProcessAliveOverride: () => alive,
      _spawnSyncOverride: ps as unknown as SpawnSyncOverride,
      _listeningPortsOverride: () => [19_999],
      _fetchOverride: diagnosticsFetch(health(20), health(20), health(20)),
      _killOverride: kill,
      _ensureDaemonOverride: vi.fn(async () => ({ connected: false, port: 19_999, spawned: true })),
      _sleepOverride: async () => undefined,
    });
    expect(result).toMatchObject({ restarted: true, stoppedPid: 20 });
    expect(kill).toHaveBeenCalledWith(20, "SIGTERM");
    expect(ps).toHaveBeenCalled();
  });

  it("rejects malformed restart seams and state mutation before validation", async () => {
    const dir = root();
    const malformedScope = await restart({ ...baseOptions(dir), _testScope: {} as never });
    expect(malformedScope.warning).toContain("test scope is incomplete");
    const malformedHermetic = await restartDaemonProduction({ ...baseOptions(root()), _hermeticTestSeams: {} as never });
    expect(malformedHermetic.warning).toContain("hermetic test seams are incomplete");
  });
});
