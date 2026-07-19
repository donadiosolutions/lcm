import { delimiter, dirname, isAbsolute } from "node:path";

export const SYSTEMD_DAEMON_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

interface TrustedExecutableDir {
  directory: string;
  entrypoint: boolean;
}

function trustedExecutableDirs(spawnCommand: string, spawnArgs: readonly string[]): TrustedExecutableDir[] {
  const firstArg = spawnArgs[0];
  const executables: Array<{ path: string; entrypoint: boolean }> = [];
  if (firstArg && isAbsolute(firstArg)) {
    executables.push({ path: firstArg, entrypoint: true });
    if (isAbsolute(spawnCommand)) executables.push({ path: spawnCommand, entrypoint: false });
  } else if (firstArg === "daemon" && isAbsolute(spawnCommand)) {
    executables.push({ path: spawnCommand, entrypoint: true });
  }
  return executables
    .map(({ path, entrypoint }) => ({ directory: dirname(path), entrypoint }))
    .filter(({ directory }) => !directory.includes(delimiter));
}

/** Build the executable path used by the managed Linux systemd daemon. */
export function managedDaemonPath(spawnCommand: string, spawnArgs: readonly string[]): string {
  const systemDirs = SYSTEMD_DAEMON_PATH.split(":");
  const trustedDirs = trustedExecutableDirs(spawnCommand, spawnArgs)
    .filter(({ directory, entrypoint }) => entrypoint || !systemDirs.includes(directory))
    .map(({ directory }) => directory);
  return [...new Set([...trustedDirs, ...systemDirs])].join(":");
}
