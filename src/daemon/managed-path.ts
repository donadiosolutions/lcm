import { dirname, isAbsolute } from "node:path";

export const SYSTEMD_DAEMON_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function lcmEntrypoint(spawnCommand: string, spawnArgs: readonly string[]): string | undefined {
  const firstArg = spawnArgs[0];
  if (firstArg && isAbsolute(firstArg)) return firstArg;
  if (firstArg === "daemon" && isAbsolute(spawnCommand)) return spawnCommand;
  return undefined;
}

/** Build the executable path used by the managed Linux systemd daemon. */
export function managedDaemonPath(spawnCommand: string, spawnArgs: readonly string[]): string {
  const entrypoint = lcmEntrypoint(spawnCommand, spawnArgs);
  if (!entrypoint) return SYSTEMD_DAEMON_PATH;

  const launcherDir = dirname(entrypoint);
  const systemDirs = SYSTEMD_DAEMON_PATH.split(":");
  return [...new Set([launcherDir, ...systemDirs])].join(":");
}
