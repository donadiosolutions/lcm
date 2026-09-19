import { spawnSync as defaultSpawnSync, type spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readlinkSync,
  readdirSync,
} from "node:fs";
import { dirname, join, win32 } from "node:path";
import { platform as currentPlatform } from "node:os";
import { processStartTime } from "../private-mutation-lock.js";
import { readBoundedRegularFileWithStat } from "../security-files.js";

export type ManagedDaemonPeerAuthority =
  | Readonly<{
    kind: "pid-file";
    pidFilePath: string;
    expectedUid?: number;
  }>
  | Readonly<{
    kind: "manager";
    pid: number;
    revalidate: () => boolean;
    systemdControlGroup?: string;
  }>;

export type ManagedDaemonPeerEvidence = Readonly<{
  pid: number;
  birth: string;
}>;

export type ManagedDaemonPeerAdmissionOptions = Readonly<{
  authority: ManagedDaemonPeerAuthority;
  port: number;
  platform?: NodeJS.Platform;
  procRoot?: string;
  expectedEntrypoint?: string;
  _seams?: Readonly<{
    isProcessAlive?: (pid: number) => boolean;
    processBirth?: (pid: number) => string | null;
    readProcessCommand?: (pid: number, platform: NodeJS.Platform) => string | null;
    findListeningTcpPorts?: (
      pid: number,
      platform: NodeJS.Platform,
      port: number,
      systemdControlGroup?: string,
    ) => number[];
    spawnSync?: typeof spawnSync;
  }>;
}>;

type PidFileEvidence = Readonly<{
  pid: number;
  dev: number;
  ino: number;
}>;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFileEvidence(
  authority: Extract<ManagedDaemonPeerAuthority, { kind: "pid-file" }>,
): PidFileEvidence | null {
  try {
    const result = readBoundedRegularFileWithStat(authority.pidFilePath, {
      allowedRoot: dirname(authority.pidFilePath),
      maxBytes: 64,
      expectedUid: authority.expectedUid,
      requireSingleLink: true,
    });
    const value = result.content.trim();
    const pid = Number(value);
    if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(pid) || pid <= 0) return null;
    return { pid, dev: result.dev, ino: result.ino };
  } catch {
    return null;
  }
}

function samePidFileEvidence(left: PidFileEvidence, right: PidFileEvidence): boolean {
  return left.pid === right.pid && left.dev === right.dev && left.ino === right.ino;
}

function resolveWindowsSystemExecutable(
  relativeSegments: readonly string[],
  systemRoot: string | undefined,
  windir: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  for (const candidate of [systemRoot, windir]) {
    if (typeof candidate !== "string") continue;
    const normalized = win32.normalize(candidate.trim()).replace(/[\\/]+$/u, "");
    if (!/^[A-Za-z]:\\Windows$/iu.test(normalized)) continue;
    const executable = win32.join(normalized, ...relativeSegments);
    if (fileExists(executable)) return executable;
  }
  return null;
}

export function resolveWindowsNetstatPath(
  systemRoot: string | undefined = process.env.SystemRoot,
  windir: string | undefined = process.env.WINDIR,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  return resolveWindowsSystemExecutable(["System32", "netstat.exe"], systemRoot, windir, fileExists);
}

export function resolveWindowsPowerShellPath(
  systemRoot: string | undefined = process.env.SystemRoot,
  windir: string | undefined = process.env.WINDIR,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  return resolveWindowsSystemExecutable(
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    systemRoot,
    windir,
    fileExists,
  );
}

export function resolveLinuxSsPath(
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  for (const candidate of ["/usr/bin/ss", "/usr/sbin/ss"]) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function readPlatformProcessCommand(
  pid: number,
  platform: NodeJS.Platform,
  spawnSyncImpl: typeof spawnSync = defaultSpawnSync,
  procRoot = "/proc",
  windowsPowerShellPath = resolveWindowsPowerShellPath(),
): string | null {
  if (platform === "linux") {
    try {
      return readFileSync(join(procRoot, String(pid), "cmdline"), "utf8")
        .replace(/\0/gu, " ")
        .trim() || null;
    } catch {
      return null;
    }
  }

  const executable = platform === "darwin"
    ? "/bin/ps"
    : platform === "win32"
      ? windowsPowerShellPath
      : null;
  if (executable === null) return null;
  const args = platform === "darwin"
    ? ["-p", String(pid), "-o", "command="]
    : [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${String(pid)}'; if ($null -ne $process) { [Console]::Out.Write($process.CommandLine) }`,
    ];
  try {
    const result = spawnSyncImpl(executable, args, {
      encoding: "utf-8",
      timeout: 1_000,
      maxBuffer: 64 * 1_024,
      shell: false,
      windowsHide: true,
    });
    return result.status === 0 && typeof result.stdout === "string"
      ? result.stdout.trim() || null
      : null;
  } catch {
    return null;
  }
}

export function isLikelyLcmDaemonProcessForPlatform(
  pid: number,
  platform: NodeJS.Platform,
  spawnSyncImpl: typeof spawnSync,
  procRoot: string,
  windowsPowerShellPath: string | null,
): boolean {
  return commandMatches(
    readPlatformProcessCommand(
      pid,
      platform,
      spawnSyncImpl,
      procRoot,
      windowsPowerShellPath,
    ),
    undefined,
    platform,
  );
}

export function findListeningTcpPorts(
  pid: number,
  platform: NodeJS.Platform,
  spawnSyncImpl: typeof spawnSync = defaultSpawnSync,
  procRoot = "/proc",
  targetPort?: number,
  windowsNetstatPath = resolveWindowsNetstatPath(),
  systemdControlGroup?: string,
  linuxSsPath = resolveLinuxSsPath(),
): number[] {
  if (platform === "linux") {
    try {
      const socketInodes = new Set<string>();
      const descriptorEntries = readdirSync(join(procRoot, String(pid), "fd"));
      let readableDescriptors = 0;
      for (const entry of descriptorEntries) {
        try {
          const target = readlinkSync(join(procRoot, String(pid), "fd", entry));
          readableDescriptors++;
          const match = /^socket:\[(\d+)\]$/u.exec(target);
          if (match) socketInodes.add(match[1]!);
        } catch {
          // Descriptors can disappear between enumeration and inspection.
        }
      }
      const ports = new Set<number>();
      for (const table of ["tcp", "tcp6"]) {
        let rows: string;
        try {
          rows = readFileSync(join(procRoot, "net", table), "utf8");
        } catch {
          continue;
        }
        for (const row of rows.split(/\r?\n/u).slice(1)) {
          const columns = row.trim().split(/\s+/u);
          if (columns.length < 10 || columns[3] !== "0A" || !socketInodes.has(columns[9]!)) continue;
          const [addressHex, portHex] = columns[1]!.split(":");
          if (addressHex !== "0100007F") continue;
          const port = portHex ? Number.parseInt(portHex, 16) : NaN;
          if (Number.isInteger(port) && port >= 1 && port <= 65_535 && (targetPort === undefined || port === targetPort)) ports.add(port);
        }
      }
      if (ports.size > 0 || readableDescriptors > 0 || descriptorEntries.length === 0) {
        return [...ports].sort((left, right) => left - right);
      }
    } catch {
      // Manager-scoped ss is the only allowed Linux fallback.
    }
    if (
      targetPort === undefined
      || !Number.isInteger(targetPort)
      || targetPort < 1
      || targetPort > 65_535
      || typeof systemdControlGroup !== "string"
      || !/^\/(?:[A-Za-z0-9_.:@-]+\/)*[A-Za-z0-9_.:@-]+$/u.test(systemdControlGroup)
      || Buffer.byteLength(systemdControlGroup, "utf8") > 4 * 1_024
      || linuxSsPath === null
    ) return [];
    try {
      const result = spawnSyncImpl(linuxSsPath, ["-H", "-ltnpe4", `sport = :${String(targetPort)}`], {
        encoding: "utf-8",
        timeout: 1_000,
        maxBuffer: 64 * 1_024,
        shell: false,
        windowsHide: true,
      });
      if (result.status !== 0 || typeof result.stdout !== "string") return [];
      const endpoint = `127.0.0.1:${String(targetPort)}`;
      const rows = result.stdout.split(/\r?\n/u).filter((row) => {
        const columns = row.trim().split(/\s+/u);
        return columns[0] === "LISTEN" && columns[3] === endpoint;
      });
      return rows.length > 0 && rows.every((row) => {
        const cgroups = row.trim().split(/\s+/u).filter((column) => column.startsWith("cgroup:"));
        return cgroups.length === 1 && cgroups[0] === `cgroup:${systemdControlGroup}`;
      }) ? [targetPort] : [];
    } catch {
      return [];
    }
  }

  if (platform === "win32") {
    if (windowsNetstatPath === null) return [];
    try {
      const result = spawnSyncImpl(windowsNetstatPath, ["-ano", "-p", "tcp"], {
        encoding: "utf-8",
        timeout: 1_000,
        maxBuffer: 256 * 1_024,
      });
      if (result.status !== 0 || typeof result.stdout !== "string") return [];
      const ports = new Set<number>();
      for (const line of result.stdout.split(/\r?\n/u)) {
        const columns = line.trim().split(/\s+/u);
        if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP" || columns[3]?.toUpperCase() !== "LISTENING") continue;
        if (Number.parseInt(columns[4]!, 10) !== pid || !columns[1]?.startsWith("127.0.0.1:")) continue;
        const port = Number.parseInt(columns[1].match(/:(\d+)$/u)?.[1] ?? "", 10);
        if (Number.isInteger(port) && port >= 1 && port <= 65_535 && (targetPort === undefined || port === targetPort)) ports.add(port);
      }
      return [...ports].sort((left, right) => left - right);
    } catch {
      return [];
    }
  }

  if (platform !== "darwin") return [];
  try {
    const result = spawnSyncImpl("/usr/sbin/lsof", [
      "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn",
    ], {
      encoding: "utf-8",
      timeout: 1_000,
      maxBuffer: 64 * 1_024,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    const ports = new Set<number>();
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (!line.startsWith("n127.0.0.1:")) continue;
      const match = line.match(/:(\d+)(?:\s+\(LISTEN\))?$/u);
      if (!match) continue;
      const port = Number.parseInt(match[1]!, 10);
      if (Number.isInteger(port) && port >= 1 && port <= 65_535 && (targetPort === undefined || port === targetPort)) ports.add(port);
      if (targetPort !== undefined && ports.has(targetPort)) break;
      if (ports.size >= 32) break;
    }
    return [...ports].sort((left, right) => left - right);
  } catch {
    return [];
  }
}

function commandMatches(
  command: string | null,
  _expectedEntrypoint: string | undefined,
  _platform: NodeJS.Platform,
): boolean {
  if (command === null) return false;
  const parts = command.split(/\s+/u);
  return command.includes("lcm") && parts.includes("daemon") && parts.includes("start");
}

export function admitManagedDaemonPeer(
  options: ManagedDaemonPeerAdmissionOptions,
): ManagedDaemonPeerEvidence | null {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) return null;
  const platform = options.platform ?? currentPlatform();
  const procRoot = options.procRoot ?? "/proc";
  const spawnSyncImpl = options._seams?.spawnSync ?? defaultSpawnSync;
  const alive = options._seams?.isProcessAlive ?? isProcessAlive;
  const birth = options._seams?.processBirth ?? ((pid: number) => processStartTime(pid));
  const readCommand = options._seams?.readProcessCommand
    ?? ((pid: number, requestedPlatform: NodeJS.Platform) => readPlatformProcessCommand(
      pid,
      requestedPlatform,
      spawnSyncImpl,
      procRoot,
    ));
  const listeningPorts = options._seams?.findListeningTcpPorts
    ?? ((pid: number, requestedPlatform: NodeJS.Platform, port: number, controlGroup?: string) => findListeningTcpPorts(
      pid,
      requestedPlatform,
      spawnSyncImpl,
      procRoot,
      port,
      undefined,
      controlGroup,
    ));

  const firstPidEvidence = options.authority.kind === "pid-file"
    ? readPidFileEvidence(options.authority)
    : null;
  const pid = options.authority.kind === "pid-file"
    ? firstPidEvidence?.pid
    : options.authority.pid;
  if (
    pid === undefined
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || (options.authority.kind === "manager" && !options.authority.revalidate())
    || !alive(pid)
  ) return null;

  const birthBefore = birth(pid);
  if (
    birthBefore === null
    || !commandMatches(readCommand(pid, platform), options.expectedEntrypoint, platform)
    || !listeningPorts(pid, platform, options.port, options.authority.kind === "manager" ? options.authority.systemdControlGroup : undefined).includes(options.port)
  ) return null;

  if (options.authority.kind === "pid-file") {
    const secondPidEvidence = readPidFileEvidence(options.authority);
    if (firstPidEvidence === null || secondPidEvidence === null || !samePidFileEvidence(firstPidEvidence, secondPidEvidence)) return null;
  } else if (!options.authority.revalidate()) {
    return null;
  }

  if (
    !alive(pid)
    || birth(pid) !== birthBefore
    || !commandMatches(readCommand(pid, platform), options.expectedEntrypoint, platform)
    || !listeningPorts(pid, platform, options.port, options.authority.kind === "manager" ? options.authority.systemdControlGroup : undefined).includes(options.port)
  ) return null;

  return { pid, birth: birthBefore };
}
