import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { daemonPidPath, lcmHomeDir } from "../runtime-paths.js";
import {
  OWNER_ONLY_FILE_MODES,
  assertPrivateDirectory,
  openPrivateDirectory,
  readBoundedRegularFileWithStat,
} from "../security-files.js";
import { processStartTime } from "../private-mutation-lock.js";
import { createSupervisor, createSupervisorSpec, managedLaunchEnvironment } from "./supervisor.js";
import { managedDaemonPathForStableLaunch } from "./managed-path.js";
import { PACKAGED_RUNTIME_ENTRYPOINT } from "./version.js";
import { packageExecutable } from "../runtime-root.js";
import {
  findListeningTcpPorts,
  isLikelyLcmDaemonCommand,
  readPlatformProcessCommand,
} from "./peer-attribution.js";

/** Local, pre-bearer proof of the process owning the configured loopback endpoint. */
export type DaemonPeerAdmission = Readonly<{ pid: number; birth: string }>;

export type DaemonPeerAdmissionCallback = (
  port: number,
  deadline: number,
  signal?: AbortSignal,
) => DaemonPeerAdmission | null | Promise<DaemonPeerAdmission | null>;

/** A refusal carries no process details, token or caller payload. */
export class DaemonPeerRefusalError extends Error {
  constructor() {
    super("Daemon peer could not be verified");
    this.name = "DaemonPeerRefusalError";
  }
}

/** Bound the callback itself, and never continue a late admission into a send. */
export async function awaitDaemonPeerAdmission(
  callback: DaemonPeerAdmissionCallback | undefined,
  port: number,
  deadline: number,
  signal?: AbortSignal,
  now: () => number = performance.now.bind(performance),
): Promise<DaemonPeerAdmission> {
  const remaining = deadline - now();
  if (callback === undefined || remaining <= 0 || signal?.aborted) throw new DaemonPeerRefusalError();
  let timer!: ReturnType<typeof setTimeout>;
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new DaemonPeerRefusalError());
    timer = setTimeout(abort, remaining);
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const peer = await Promise.race([Promise.resolve().then(() => {
      if (signal?.aborted || now() >= deadline) throw new DaemonPeerRefusalError();
      return callback(port, deadline, signal);
    }), stopped]);
    if (peer === null || signal?.aborted || now() >= deadline) throw new DaemonPeerRefusalError();
    return peer;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export type DaemonPeerAdmissionOptions = Readonly<{
  port: number;
  deadline: number;
  homeDir?: string;
  pidFilePath?: string;
  now?: () => number;
  /** A separately verified, fresh supervisor observation. Missing PID is replacement-only. */
  manager?: Readonly<{ pid: number; controlGroup?: string; allowMissingPid?: boolean }>;
  /** @internal Deterministic platform and process seams for focused tests. */
  _platform?: NodeJS.Platform;
  _procRoot?: string;
  _spawnSync?: typeof spawnSync;
  _processBirth?: typeof processStartTime;
  _uid?: number;
}>;

/** Never infer the initial peer from HTTP response fields. */
export function admitDaemonPeer(options: DaemonPeerAdmissionOptions): DaemonPeerAdmission | null {
  const now = options.now ?? performance.now.bind(performance);
  const remaining = (): number => Math.floor(options.deadline - now());
  const platform = options._platform ?? process.platform;
  const uid = options._uid ?? process.getuid?.();
  const homeDir = options.homeDir ?? homedir();
  const pidPath = options.pidFilePath ?? daemonPidPath(homeDir);
  const stateDir = lcmHomeDir(homeDir);
  // Windows needs process and private-state SID/ACL evidence, which the POSIX
  // descriptor and uid checks below cannot provide.
  if (platform === "win32" || uid === undefined || remaining() <= 0
    || resolve(pidPath) !== resolve(daemonPidPath(homeDir))) return null;

  let state: ReturnType<typeof openPrivateDirectory> | undefined;
  try {
    state = openPrivateDirectory(stateDir, { expectedUid: uid });
    const readPid = (): Readonly<{ pid: number; dev: number; ino: number }> => {
      const file = readBoundedRegularFileWithStat(pidPath, {
        allowedRoot: stateDir,
        maxBytes: 64,
        expectedUid: uid,
        allowedModes: OWNER_ONLY_FILE_MODES,
        requireSingleLink: true,
      });
      if (!/^[1-9][0-9]*$/u.test(file.content)) throw new Error("daemon PID is not canonical");
      const pid = Number(file.content);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("daemon PID is invalid");
      return { pid, dev: file.dev, ino: file.ino };
    };
    let first: ReturnType<typeof readPid> | null;
    try {
      first = readPid();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.manager?.allowMissingPid !== true) return null;
      first = null;
    }
    const pid = first?.pid ?? options.manager?.pid;
    if (pid === undefined || (options.manager !== undefined && options.manager.pid !== pid)
      || !Number.isSafeInteger(pid) || pid <= 0 || remaining() <= 0) return null;

    const birthProbe = options._processBirth ?? processStartTime;
    const birth = birthProbe(pid, undefined, { timeoutMs: remaining() });
    if (birth === null || remaining() <= 0) return null;
    const procRoot = options._procRoot ?? "/proc";
    let processUid: number | null = null;
    if (platform === "linux") {
      const status = readFileSync(`${procRoot}/${pid}/status`, "utf8");
      const match = /^Uid:\s+([0-9]+)(?:\s|$)/mu.exec(status);
      processUid = match === null ? null : Number(match[1]);
    } else if (platform === "darwin") {
      const result = (options._spawnSync ?? spawnSync)("/bin/ps", ["-p", String(pid), "-o", "uid="], {
        encoding: "utf8", timeout: Math.min(1000, remaining()), maxBuffer: 16 * 1024,
        shell: false, windowsHide: true,
      });
      const raw = typeof result.stdout === "string" ? result.stdout.trim() : "";
      processUid = result.status === 0 && /^[0-9]+$/u.test(raw) ? Number(raw) : null;
    }
    if (processUid !== uid || remaining() <= 0) return null;

    const budgetedSpawnSync: typeof spawnSync = ((command: string, args: readonly string[], settings: object) => {
      const budget = remaining();
      if (budget <= 0) throw new Error("daemon peer admission deadline expired");
      return (options._spawnSync ?? spawnSync)(command, [...args], {
        ...settings,
        timeout: Math.min(1000, budget),
      });
    }) as typeof spawnSync;
    if (options.manager === undefined) {
      const command = readPlatformProcessCommand(pid, platform, budgetedSpawnSync, procRoot);
      if (!isLikelyLcmDaemonCommand(command) || remaining() <= 0) return null;
    }
    if (!findListeningTcpPorts(
      pid, platform, budgetedSpawnSync, procRoot, options.port,
      undefined, options.manager?.controlGroup,
    ).includes(options.port) || remaining() <= 0) return null;

    let second: ReturnType<typeof readPid> | null;
    try {
      second = readPid();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.manager?.allowMissingPid !== true) return null;
      second = null;
    }
    if (first === null && second !== null && second.pid !== pid) return null;
    if (first !== null && (second === null || second.pid !== pid || second.dev !== first.dev
      || second.ino !== first.ino)) return null;
    assertPrivateDirectory(state, stateDir, state.witness, uid);
    if (remaining() <= 0 || birthProbe(pid, undefined, { timeoutMs: remaining() }) !== birth
      || remaining() <= 0) return null;
    return { pid, birth };
  } catch {
    return null;
  } finally {
    state?.close();
  }
}

/**
 * Current recipients normally prove their socket through process descriptors.
 * A sibling user namespace may hide those links: re-observe the exact existing
 * manager registration for each send, then bind its cgroup to the OS listener.
 * This path never permits an absent PID file or mutates manager state.
 */
export async function admitCurrentDaemonPeer(
  options: Omit<DaemonPeerAdmissionOptions, "manager"> & { signal?: AbortSignal },
): Promise<DaemonPeerAdmission | null> {
  const now = options.now ?? performance.now.bind(performance);
  if (options.signal?.aborted || now() >= options.deadline) return null;
  const direct = admitDaemonPeer(options);
  if (direct !== null || (options._platform ?? process.platform) !== "linux") return direct;
  const uid = options._uid ?? process.getuid?.();
  if (uid === undefined || options.signal?.aborted || now() >= options.deadline) return null;
  const homeDir = options.homeDir ?? homedir();
  const stateRoot = lcmHomeDir(homeDir);
  const pidPath = options.pidFilePath ?? daemonPidPath(homeDir);
  if (resolve(pidPath) !== resolve(daemonPidPath(homeDir))) return null;
  let state: ReturnType<typeof openPrivateDirectory> | undefined;
  try {
    state = openPrivateDirectory(stateRoot, { expectedUid: uid });
    const file = readBoundedRegularFileWithStat(pidPath, {
      allowedRoot: stateRoot, maxBytes: 64, expectedUid: uid,
      allowedModes: OWNER_ONLY_FILE_MODES, requireSingleLink: true,
    });
    if (!/^[1-9][0-9]*$/u.test(file.content)) return null;
    const pid = Number(file.content);
    if (!Number.isSafeInteger(pid) || pid <= 0 || now() >= options.deadline) return null;
    const birthProbe = options._processBirth ?? processStartTime;
    const birth = birthProbe(pid, undefined, { timeoutMs: Math.floor(options.deadline - now()) });
    if (birth === null || now() >= options.deadline) return null;
    const entrypoint = PACKAGED_RUNTIME_ENTRYPOINT ?? packageExecutable(import.meta.url, 3);
    const requested = createSupervisorSpec({
      kind: "systemd-user", stateRoot, port: options.port, executable: process.execPath,
      args: [entrypoint, "daemon", "start", "--foreground"], nonce: "peer-observation",
    });
    const environment = managedLaunchEnvironment(process.env);
    const supervisor = createSupervisor("systemd-user", {
      platform: "linux", uid, now, environment,
      commandTimeoutMs: Math.min(1_000, Math.floor(options.deadline - now())),
      run: (command, args, settings) => {
        const remainingMs = Math.floor(options.deadline - now());
        const timeoutMs = Math.min(settings.timeoutMs, remainingMs);
        if (options.signal?.aborted || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new DaemonPeerRefusalError();
        const result = (options._spawnSync ?? spawnSync)(command, [...args], {
          encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 64 * 1024,
          timeout: timeoutMs, env: environment,
        });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr,
          timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" };
      },
    });
    const observed = await awaitDaemonPeerAdmission(async () => {
      const first = await supervisor.probe(requested, { deadline: options.deadline });
      if (options.signal?.aborted || now() >= options.deadline
        || (first.kind !== "registered-running-valid" && first.kind !== "registered-stale-config")
        || first.marker !== requested.marker || first.scopeDigest !== requested.scopeDigest
        || first.stateRoot !== requested.stateRoot || first.name !== requested.name
        || first.port !== options.port || first.managerPid !== pid
        || first.nonce === undefined || first.executable === undefined || first.args === undefined) return null;
      const args: unknown = JSON.parse(first.args);
      if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")
        || !isLikelyLcmDaemonCommand([first.executable, ...args].join(" "))) return null;
      const adopted = createSupervisorSpec({
        kind: "systemd-user", stateRoot, port: options.port, nonce: first.nonce,
        executable: first.executable, args,
        ...(first.cwd ? { cwd: first.cwd } : {}),
        ...(first.entrypoint ? { entrypoint: first.entrypoint } : {}),
        ...(first.runtimeDigest ? { runtimeDigest: first.runtimeDigest } : {}),
        ...(first.storageBackend ? { storageBackend: first.storageBackend } : {}),
        ...(first.postgresCaFile ? { postgresCaFile: first.postgresCaFile } : {}),
        credentialDirectory: first.credentialDirectory, credentialFiles: first.credentialFiles,
        launchEnvironment: {
          ...environment,
          PATH: managedDaemonPathForStableLaunch(first.executable, args, requested.stateRoot),
        },
      });
      const second = await supervisor.probe(adopted, { deadline: options.deadline });
      if (options.signal?.aborted || now() >= options.deadline
        || second.kind !== "registered-running-valid" || second.managerPid !== pid
        || second.scopeDigest !== adopted.scopeDigest || second.name !== adopted.name
        || second.nonce !== adopted.nonce || second.controlGroup === undefined
        || first.controlGroup !== second.controlGroup) return null;
      const peer = admitDaemonPeer({ ...options, manager: { pid, controlGroup: second.controlGroup } });
      return peer?.birth === birth ? peer : null;
    }, options.port, options.deadline, options.signal, now);
    assertPrivateDirectory(state, stateRoot, state.witness, uid);
    const after = readBoundedRegularFileWithStat(pidPath, {
      allowedRoot: stateRoot, maxBytes: 64, expectedUid: uid,
      allowedModes: OWNER_ONLY_FILE_MODES, requireSingleLink: true,
    });
    return options.signal?.aborted || now() >= options.deadline || after.dev !== file.dev
      || after.ino !== file.ino || after.content !== file.content ? null : observed;
  } catch {
    return null;
  } finally {
    state?.close();
  }
}
