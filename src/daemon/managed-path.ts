import { delimiter, dirname, isAbsolute, relative, sep } from "node:path";
import { homedir } from "node:os";

export const SYSTEMD_DAEMON_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

interface TrustedExecutableDir {
  directory: string;
  entrypoint: boolean;
}

function isWithin(directory: string, root: string): boolean {
  const path = relative(root, directory);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function homeScopedInstallationRoot(directory: string): string | undefined {
  const match = /^(.*)\/(?:\.nvm|\.npm-packages|\.volta|\.asdf|\.codex|\.claude)(?:\/|$)/.exec(directory);
  return match?.[1] || undefined;
}

function isTrustedInstallationDir(
  directory: string,
  workingDirectory: string,
  homeDirectory: string,
): boolean {
  if (/(?:^|\/)node_modules(?:\/|$)/.test(directory)) return false;
  const installationRoot = homeScopedInstallationRoot(directory);
  if (installationRoot && isWithin(workingDirectory, installationRoot)) {
    // The real per-user installation root remains trusted even when a command
    // is run from $HOME. Lookalike caches rooted in a checkout do not.
    if (relative(homeDirectory, installationRoot) !== "") return false;
  }
  // Project containment wins over recognizable install layouts. A checkout can
  // contain attacker-controlled .codex/.claude caches or package-manager paths
  // whose names would otherwise look like approved global trust anchors.
  if (
    (isWithin(directory, workingDirectory) || isWithin(workingDirectory, directory))
    && relative(homeDirectory, installationRoot ?? directory) !== ""
  ) return false;
  return true;
}

function trustedExecutableDirs(
  spawnCommand: string,
  spawnArgs: readonly string[],
  workingDirectory: string,
  homeDirectory: string,
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
      !directory.includes(delimiter) && isTrustedInstallationDir(directory, workingDirectory, homeDirectory)
    );
}

/** Build the executable path used by the managed Linux systemd daemon. */
export function managedDaemonPath(
  spawnCommand: string,
  spawnArgs: readonly string[],
  workingDirectory = process.cwd(),
  homeDirectory = homedir(),
): string {
  const systemDirs = SYSTEMD_DAEMON_PATH.split(":");
  const trustedDirs = trustedExecutableDirs(spawnCommand, spawnArgs, workingDirectory, homeDirectory)
    .filter(({ directory, entrypoint }) => entrypoint || !systemDirs.includes(directory))
    .map(({ directory }) => directory);
  return [...new Set([...trustedDirs, ...systemDirs])].join(":");
}
