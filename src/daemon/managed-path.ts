import { delimiter, dirname, isAbsolute, relative, sep } from "node:path";

export const SYSTEMD_DAEMON_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

interface TrustedExecutableDir {
  directory: string;
  entrypoint: boolean;
}

function isWithin(directory: string, root: string): boolean {
  const path = relative(root, directory);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isKnownGlobalOrBundledDir(directory: string): boolean {
  if (SYSTEMD_DAEMON_PATH.split(":").includes(directory)) return true;
  if (/(?:^|\/)\.nvm\/versions\/node\/[^/]+\/bin$/.test(directory)) return true;
  if (/(?:^|\/)\.npm-packages\/bin$/.test(directory)) return true;
  if (/(?:^|\/)\.volta\/bin$/.test(directory)) return true;
  if (/(?:^|\/)\.asdf\/(?:shims|installs\/nodejs\/[^/]+\/bin)$/.test(directory)) return true;
  if (/(?:^|\/)codex-desktop\/resources\/node-runtime\/bin$/.test(directory)) return true;
  return /(?:^|\/)\.(?:codex|claude)\/plugins\/cache\//.test(directory);
}

function isTrustedInstallationDir(directory: string, workingDirectory: string): boolean {
  if (/(?:^|\/)node_modules(?:\/|$)/.test(directory)) return false;
  return isKnownGlobalOrBundledDir(directory)
    || (!isWithin(directory, workingDirectory) && !isWithin(workingDirectory, directory));
}

function trustedExecutableDirs(
  spawnCommand: string,
  spawnArgs: readonly string[],
  workingDirectory: string,
): TrustedExecutableDir[] {
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
    .filter(({ directory }) =>
      !directory.includes(delimiter) && isTrustedInstallationDir(directory, workingDirectory)
    );
}

/** Build the executable path used by the managed Linux systemd daemon. */
export function managedDaemonPath(
  spawnCommand: string,
  spawnArgs: readonly string[],
  workingDirectory = process.cwd(),
): string {
  const systemDirs = SYSTEMD_DAEMON_PATH.split(":");
  const trustedDirs = trustedExecutableDirs(spawnCommand, spawnArgs, workingDirectory)
    .filter(({ directory, entrypoint }) => entrypoint || !systemDirs.includes(directory))
    .map(({ directory }) => directory);
  return [...new Set([...trustedDirs, ...systemDirs])].join(":");
}
