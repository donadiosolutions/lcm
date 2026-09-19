import { spawnSync as defaultSpawnSync, type spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readlinkSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, join, win32 } from "node:path";
import { platform as currentPlatform } from "node:os";
import { processStartTime } from "../private-mutation-lock.js";
import { readBoundedRegularFileWithStat } from "../security-files.js";
import { daemonEntrypointMatches } from "./lifecycle-scope.js";

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
    readProcessArguments?: (pid: number, platform: NodeJS.Platform) => readonly string[] | null;
    readProcessExecutable?: (pid: number, platform: NodeJS.Platform) => string | null;
    readProcessOwnerUid?: (pid: number, platform: NodeJS.Platform) => number | null;
    readProcessOwnerIdentity?: (pid: number, platform: NodeJS.Platform) => string | null;
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

export function parseProcessCommandLine(
  command: string,
  platform: NodeJS.Platform,
): string[] | null {
  if (platform === "win32") {
    const args: string[] = [];
    let index = 0;
    while (index < command.length) {
      while (/\s/u.test(command[index] ?? "")) index++;
      if (index >= command.length) break;
      let current = "";
      let quoted = false;
      while (index < command.length) {
        let backslashes = 0;
        while (command[index] === "\\") {
          backslashes++;
          index++;
        }
        if (command[index] === '"') {
          current += "\\".repeat(Math.floor(backslashes / 2));
          if (backslashes % 2 === 1) {
            current += '"';
            index++;
          } else {
            quoted = !quoted;
            index++;
          }
          continue;
        }
        current += "\\".repeat(backslashes);
        const character = command[index];
        if (character === undefined || (!quoted && /\s/u.test(character))) break;
        current += character;
        index++;
      }
      if (quoted) return null;
      args.push(current);
      while (/\s/u.test(command[index] ?? "")) index++;
    }
    return args.length > 0 ? args : null;
  }
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
        started = true;
      } else if (character === "\\" && quote === '"' && command[index + 1] === '"') {
        current += '"';
        index++;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (character === "\\" && (command[index + 1] === '"' || command[index + 1] === "'")) {
      current += command[index + 1];
      index++;
      started = true;
      continue;
    }
    current += character;
    started = true;
  }
  if (quote !== undefined) return null;
  if (started) args.push(current);
  return args.length > 0 ? args : null;
}

export type DarwinProcessSnapshot = Readonly<{
  executable: string;
  arguments: readonly string[];
}>;

export function parseDarwinProcessSnapshot(buffer: Buffer): DarwinProcessSnapshot | null {
  if (buffer.length < 5 || buffer.length > 64 * 1_024) return null;
  const argumentCount = buffer.readInt32LE(0);
  if (!Number.isInteger(argumentCount) || argumentCount < 1 || argumentCount > 1_024) return null;
  const executableEnd = buffer.indexOf(0, 4);
  if (executableEnd <= 4) return null;
  const executable = buffer.subarray(4, executableEnd).toString("utf8");
  if (!executable.startsWith("/") || executable.includes("\uFFFD")) return null;
  let offset = executableEnd + 1;
  while (offset < buffer.length && buffer[offset] === 0) offset++;
  const args: string[] = [];
  while (offset < buffer.length && args.length < argumentCount) {
    const end = buffer.indexOf(0, offset);
    if (end < offset) return null;
    const argument = buffer.subarray(offset, end).toString("utf8");
    if (argument.includes("\uFFFD")) return null;
    args.push(argument);
    offset = end + 1;
  }
  return args.length === argumentCount ? { executable, arguments: args } : null;
}

function readDarwinProcessSnapshot(
  pid: number,
  spawnSyncImpl: typeof spawnSync,
): DarwinProcessSnapshot | null {
  try {
    const result = spawnSyncImpl("/usr/sbin/sysctl", ["-b", `kern.procargs2.${String(pid)}`], {
      encoding: "buffer",
      timeout: 1_000,
      maxBuffer: 64 * 1_024,
      shell: false,
      windowsHide: true,
    });
    return result.status === 0 && Buffer.isBuffer(result.stdout)
      ? parseDarwinProcessSnapshot(result.stdout)
      : null;
  } catch {
    return null;
  }
}

export function readPlatformProcessArguments(
  pid: number,
  platform: NodeJS.Platform,
  spawnSyncImpl: typeof spawnSync = defaultSpawnSync,
  procRoot = "/proc",
  windowsPowerShellPath = resolveWindowsPowerShellPath(),
): string[] | null {
  if (platform === "linux") {
    try {
      const args = readFileSync(join(procRoot, String(pid), "cmdline"), "utf8")
        .split("\0")
        .filter((argument) => argument.length > 0);
      return args.length > 0 ? args : null;
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    const snapshot = readDarwinProcessSnapshot(pid, spawnSyncImpl);
    return snapshot === null ? null : [...snapshot.arguments];
  }
  const command = readPlatformProcessCommand(
    pid,
    platform,
    spawnSyncImpl,
    procRoot,
    windowsPowerShellPath,
  );
  return command === null ? null : parseProcessCommandLine(command, platform);
}

export function readPlatformProcessOwnerIdentity(
  pid: number,
  platform: NodeJS.Platform,
  spawnSyncImpl: typeof spawnSync = defaultSpawnSync,
  procRoot = "/proc",
  windowsPowerShellPath = resolveWindowsPowerShellPath(),
): string | null {
  if (platform === "linux" || platform === "darwin") {
    const uid = readPlatformProcessOwnerUid(pid, platform, spawnSyncImpl, procRoot);
    return uid === null ? null : `uid:${String(uid)}`;
  }
  if (platform !== "win32" || windowsPowerShellPath === null) return null;
  try {
    const result = spawnSyncImpl(windowsPowerShellPath, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${String(pid)}'; if ($null -ne $process) { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid; if ($owner.ReturnValue -eq 0) { [Console]::Out.Write($owner.Sid) } }`,
    ], {
      encoding: "utf-8",
      timeout: 1_000,
      maxBuffer: 4 * 1_024,
      shell: false,
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const sid = result.stdout.trim();
    return /^S-\d-(?:\d+-){1,14}\d+$/iu.test(sid) ? sid.toUpperCase() : null;
  } catch {
    return null;
  }
}

export function readPlatformProcessExecutable(
  pid: number,
  platform: NodeJS.Platform,
  spawnSyncImpl: typeof spawnSync = defaultSpawnSync,
  procRoot = "/proc",
  windowsPowerShellPath = resolveWindowsPowerShellPath(),
): string | null {
  if (platform === "linux") {
    try {
      const executable = readlinkSync(join(procRoot, String(pid), "exe"));
      return executable.startsWith("/") ? executable : null;
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    return readDarwinProcessSnapshot(pid, spawnSyncImpl)?.executable ?? null;
  }
  const command = platform === "win32" ? windowsPowerShellPath : null;
  if (command === null) return null;
  const args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${String(pid)}'; if ($null -ne $process) { [Console]::Out.Write($process.ExecutablePath) }`,
      ];
  try {
    const result = spawnSyncImpl(command, args, {
      encoding: "utf-8",
      timeout: 1_000,
      maxBuffer: 64 * 1_024,
      shell: false,
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export function readPlatformProcessOwnerUid(
  pid: number,
  platform: NodeJS.Platform,
  spawnSyncImpl: typeof spawnSync = defaultSpawnSync,
  procRoot = "/proc",
): number | null {
  let output: string;
  if (platform === "linux") {
    try {
      output = readFileSync(join(procRoot, String(pid), "status"), "utf8");
      const match = /^Uid:\s+(\d+)(?:\s+\d+){3}\s*$/mu.exec(output);
      const uid = match?.[1] === undefined ? NaN : Number.parseInt(match[1], 10);
      return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
    } catch {
      return null;
    }
  }
  if (platform !== "darwin") return null;
  try {
    const result = spawnSyncImpl("/bin/ps", ["-p", String(pid), "-o", "uid="], {
      encoding: "utf-8",
      timeout: 1_000,
      maxBuffer: 1_024,
      shell: false,
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const value = result.stdout.trim();
    const uid = /^\d+$/u.test(value) ? Number.parseInt(value, 10) : NaN;
    return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
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
  const command = readPlatformProcessCommand(
    pid,
    platform,
    spawnSyncImpl,
    procRoot,
    windowsPowerShellPath,
  );
  if (command === null) return false;
  const parts = command.split(/\s+/u);
  return command.includes("lcm") && parts.includes("daemon") && parts.includes("start");
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
  args: readonly string[] | null,
  processExecutable: string | null,
  expectedEntrypoint: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (args === null || processExecutable === null || expectedEntrypoint === undefined) return false;
  const daemonIndex = args.findIndex((argument, index) => (
    argument === "daemon" && args[index + 1] === "start"
  ));
  if (daemonIndex < 1) return false;
  const entrypointIndex = daemonIndex - 1;
  if (!daemonEntrypointMatches(args[entrypointIndex], expectedEntrypoint, platform)) return false;
  const prefix = args.slice(0, entrypointIndex);
  if (prefix.length === 0) {
    return daemonEntrypointMatches(processExecutable, expectedEntrypoint, platform);
  }
  const executable = platform === "win32"
    ? win32.basename(prefix[0]!)
    : basename(prefix[0]!);
  return prefix.length === 1
    && /^node(?:\.exe)?$/iu.test(executable)
    && daemonEntrypointMatches(processExecutable, process.execPath, platform);
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
  const readArguments = options._seams?.readProcessArguments
    ?? (options._seams?.readProcessCommand === undefined
      ? ((pid: number, requestedPlatform: NodeJS.Platform) => readPlatformProcessArguments(
          pid,
          requestedPlatform,
          spawnSyncImpl,
          procRoot,
        ))
      : ((pid: number, requestedPlatform: NodeJS.Platform) => {
          const command = readCommand(pid, requestedPlatform);
          return command === null ? null : parseProcessCommandLine(command, requestedPlatform);
        }));
  const readOwnerUid = options._seams?.readProcessOwnerUid
    ?? ((pid: number, requestedPlatform: NodeJS.Platform) => readPlatformProcessOwnerUid(
      pid,
      requestedPlatform,
      spawnSyncImpl,
      procRoot,
    ));
  const readOwnerIdentity = options._seams?.readProcessOwnerIdentity
    ?? ((pid: number, requestedPlatform: NodeJS.Platform) => readPlatformProcessOwnerIdentity(
      pid,
      requestedPlatform,
      spawnSyncImpl,
      procRoot,
    ));
  const readExecutable = options._seams?.readProcessExecutable
    ?? ((pid: number, requestedPlatform: NodeJS.Platform) => readPlatformProcessExecutable(
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
  const executableBefore = readExecutable(pid, platform);
  const expectedProcessOwner = options.authority.kind !== "pid-file"
    ? undefined
    : options.authority.expectedUid !== undefined
      ? `uid:${String(options.authority.expectedUid)}`
      : platform === "win32"
        ? readOwnerIdentity(process.pid, platform)
        : null;
  const ownerBefore = expectedProcessOwner === undefined
    ? undefined
    : expectedProcessOwner === null
      ? null
      : options.authority.kind === "pid-file" && options.authority.expectedUid !== undefined
        ? (() => {
            const uid = readOwnerUid(pid, platform);
            return uid === null ? null : `uid:${String(uid)}`;
          })()
        : readOwnerIdentity(pid, platform);
  if (
    birthBefore === null
    || expectedProcessOwner === null
    || (expectedProcessOwner !== undefined && ownerBefore !== expectedProcessOwner)
    || !commandMatches(readArguments(pid, platform), executableBefore, options.expectedEntrypoint, platform)
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
    || (expectedProcessOwner !== undefined && (
      options.authority.kind === "pid-file" && options.authority.expectedUid !== undefined
        ? (() => {
            const uid = readOwnerUid(pid, platform);
            return uid === null ? null : `uid:${String(uid)}`;
          })()
        : readOwnerIdentity(pid, platform)
    ) !== ownerBefore)
    || !daemonEntrypointMatches(readExecutable(pid, platform) ?? undefined, executableBefore ?? undefined, platform)
    || !commandMatches(readArguments(pid, platform), executableBefore, options.expectedEntrypoint, platform)
    || !listeningPorts(pid, platform, options.port, options.authority.kind === "manager" ? options.authority.systemdControlGroup : undefined).includes(options.port)
  ) return null;

  return { pid, birth: birthBefore };
}
