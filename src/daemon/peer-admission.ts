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
import {
  findListeningTcpPorts,
  isLikelyLcmDaemonCommand,
  readPlatformProcessCommand,
} from "./peer-attribution.js";

/** Local, pre-bearer proof of the process owning the configured loopback endpoint. */
export type DaemonPeerAdmission = Readonly<{ pid: number; birth: string }>;

export type DaemonPeerAdmissionOptions = Readonly<{
  port: number;
  deadline: number;
  homeDir?: string;
  pidFilePath?: string;
  now?: () => number;
  /** A separately verified supervisor observation, only for a managed replacement. */
  manager?: Readonly<{ pid: number; controlGroup?: string }>;
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.manager === undefined) return null;
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.manager === undefined) return null;
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
