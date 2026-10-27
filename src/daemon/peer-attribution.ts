import { existsSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, win32 } from "node:path";

export function readProcessCommand(pid: number, procRoot = "/proc"): string | null {
  try {
    return readFileSync(join(procRoot, String(pid), "cmdline"), "utf-8").replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}

export function isLikelyLcmDaemonCommand(command: string | null): boolean {
  if (!command) return false;
  const parts = command.split(/\s+/);
  return command.includes("lcm") && parts.includes("daemon") && parts.includes("start");
}

export function isLikelyLcmDaemonProcess(pid: number, procRoot = "/proc"): boolean {
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

export function resolveWindowsNetstatPath(
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

export function resolveWindowsPowerShellPath(
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

export function isLikelyLcmDaemonProcessForPlatform(
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

export function findListeningTcpPorts(
  pid: number,
  platform: NodeJS.Platform,
  spawnSyncImpl: typeof spawnSync,
  procRoot = "/proc",
  targetPort?: number,
  windowsNetstatPath = resolveWindowsNetstatPath(process.env.SystemRoot, process.env.WINDIR),
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
          readableDescriptors += 1;
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
      if (ports.size > 0 || readableDescriptors > 0 || descriptorEntries.length === 0) {
        return [...ports].sort((a, b) => a - b);
      }
    } catch {
      // A process in a sibling user namespace can expose the fd directory
      // while denying every descriptor target. Fall through to the bounded
      // manager-cgroup witness instead of treating that isolation as absence.
    }
    if (
      targetPort === undefined
      || !Number.isInteger(targetPort)
      || targetPort < 1
      || targetPort > 65_535
      || typeof systemdControlGroup !== "string"
      || !/^\/(?:[A-Za-z0-9_.:@-]+\/)*[A-Za-z0-9_.:@-]+$/u.test(systemdControlGroup)
      || Buffer.byteLength(systemdControlGroup, "utf8") > 4 * 1024
      || linuxSsPath === null
    ) return [];
    try {
      const result = spawnSyncImpl(linuxSsPath, ["-H", "-ltnpe4", `sport = :${String(targetPort)}`], {
        encoding: "utf-8",
        timeout: 1000,
        maxBuffer: 64 * 1024,
        shell: false,
        windowsHide: true,
      });
      if (result.status !== 0 || typeof result.stdout !== "string") return [];
      const localEndpoint = `127.0.0.1:${String(targetPort)}`;
      const matchingRows = result.stdout.split(/\r?\n/).filter((row) => {
        const columns = row.trim().split(/\s+/);
        return columns[0] === "LISTEN" && columns[3] === localEndpoint;
      });
      if (matchingRows.length === 0) return [];
      const everyRowOwned = matchingRows.every((row) => {
        const cgroups = row.trim().split(/\s+/).filter((column) => column.startsWith("cgroup:"));
        return cgroups.length === 1 && cgroups[0] === `cgroup:${systemdControlGroup}`;
      });
      return everyRowOwned ? [targetPort] : [];
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
