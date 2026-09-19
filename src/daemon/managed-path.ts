import { realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir, userInfo } from "node:os";

export const SYSTEMD_DAEMON_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

interface TrustedExecutableDir {
  directory: string;
  entrypoint: boolean;
  synthesizedNpmBin: boolean;
}

function isWithin(directory: string, root: string): boolean {
  const path = relative(root, directory);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function homeScopedInstallationRoot(
  directory: string,
  includeLocal: boolean,
): string | undefined {
  const pattern = includeLocal
    ? /^(.*)\/(?:\.local|\.nvm|\.npm-global|\.npm-packages|\.volta|\.asdf|\.codex|\.claude)(?:\/|$)/
    : /^(.*)\/(?:\.nvm|\.npm-global|\.npm-packages|\.volta|\.asdf|\.codex|\.claude)(?:\/|$)/;
  const match = pattern.exec(directory);
  return match?.[1] || undefined;
}

function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function authenticatedImplicitHomeDirectory(): string | undefined {
  try {
    const requestedHome = canonicalPath(homedir());
    const accountHome = canonicalPath(userInfo().homedir);
    if (!requestedHome || !accountHome) return undefined;
    if (requestedHome === accountHome) return requestedHome;

    const stats = statSync(requestedHome);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      uid === undefined
      || !stats.isDirectory()
      || stats.uid !== uid
      || (stats.mode & 0o022) !== 0
    ) return undefined;
    return requestedHome;
  } catch {
    return undefined;
  }
}

function trustedInstallationDirectory(
  directory: string,
  workingDirectory: string,
  homeDirectory: string | undefined,
  requireCanonicalHome: boolean,
  synthesizedNpmBin: boolean,
): string | undefined {
  if (/(?:^|\/)node_modules(?:\/|$)/.test(directory)) return undefined;
  const installationRoot = homeScopedInstallationRoot(directory, synthesizedNpmBin);
  const canonicalDirectory = requireCanonicalHome && installationRoot
    ? canonicalPath(directory)
    : directory;
  if (
    requireCanonicalHome
    && synthesizedNpmBin
    && canonicalDirectory?.includes(delimiter)
  ) return undefined;
  const canonicalInstallationRoot = requireCanonicalHome && canonicalDirectory && installationRoot
    ? homeScopedInstallationRoot(canonicalDirectory, synthesizedNpmBin)
    : installationRoot;
  const installationRootAtHome = installationRoot !== undefined
    && homeDirectory !== undefined
    && canonicalInstallationRoot !== undefined
    && canonicalDirectory !== undefined
    && relative(homeDirectory, canonicalInstallationRoot) === ""
    && isWithin(canonicalDirectory, homeDirectory);
  const installationRootOutsideHome = installationRoot !== undefined && !installationRootAtHome;
  if (requireCanonicalHome && synthesizedNpmBin && !installationRootAtHome) return undefined;
  if (requireCanonicalHome && installationRootOutsideHome) {
    // Recognized user-installation layouts are trusted only below the
    // canonical home root. This keeps checkout-controlled .codex/.claude and
    // package-manager lookalikes rejected even when a managed lifecycle uses a
    // stable supervisor anchor instead of the caller's working directory.
    return undefined;
  }
  if (installationRoot && isWithin(workingDirectory, installationRoot)) {
    // The real per-user installation root remains trusted even when a command
    // is run from $HOME. Lookalike caches rooted in a checkout do not.
    if (installationRootOutsideHome) return undefined;
  }
  // Project containment wins over recognizable install layouts. A checkout can
  // contain attacker-controlled .codex/.claude caches or package-manager paths
  // whose names would otherwise look like approved global trust anchors.
  if (
    (isWithin(directory, workingDirectory) || isWithin(workingDirectory, directory))
    && !installationRootAtHome
  ) return undefined;
  return requireCanonicalHome && synthesizedNpmBin ? canonicalDirectory : directory;
}

function npmGlobalBinForEntrypoint(path: string): string | undefined {
  const marker = `${sep}lib${sep}node_modules${sep}@donadiosolutions${sep}lcm${sep}`;
  const markerIndex = path.indexOf(marker);
  if (markerIndex <= 0) return undefined;
  return join(path.slice(0, markerIndex), "bin");
}

function trustedExecutableDirs(
  spawnCommand: string,
  spawnArgs: readonly string[],
  workingDirectory: string,
  homeDirectory: string | undefined,
  requireCanonicalHome: boolean,
): TrustedExecutableDir[] {
  const firstArg = spawnArgs[0];
  const executables: Array<{
    path: string;
    entrypoint: boolean;
    synthesizedNpmBin: boolean;
  }> = [];
  if (firstArg && isAbsolute(firstArg)) {
    executables.push({ path: firstArg, entrypoint: true, synthesizedNpmBin: false });
    const npmGlobalBin = npmGlobalBinForEntrypoint(firstArg);
    if (npmGlobalBin) {
      executables.push({
        path: join(npmGlobalBin, "lcm"),
        entrypoint: true,
        synthesizedNpmBin: true,
      });
    }
    if (isAbsolute(spawnCommand)) {
      executables.push({ path: spawnCommand, entrypoint: false, synthesizedNpmBin: false });
    }
  } else if (firstArg === "daemon" && isAbsolute(spawnCommand)) {
    executables.push({ path: spawnCommand, entrypoint: true, synthesizedNpmBin: false });
  }
  return executables.flatMap(({ path, entrypoint, synthesizedNpmBin }) => {
    const directory = dirname(path);
    if (directory.includes(delimiter)) return [];
    const trustedDirectory = trustedInstallationDirectory(
      directory,
      workingDirectory,
      homeDirectory,
      requireCanonicalHome,
      synthesizedNpmBin,
    );
    return trustedDirectory === undefined
      ? []
      : [{ directory: trustedDirectory, entrypoint, synthesizedNpmBin }];
  });
}

function buildManagedDaemonPath(
  spawnCommand: string,
  spawnArgs: readonly string[],
  workingDirectory: string,
  homeDirectory: string | undefined,
  requireCanonicalHome: boolean,
): string {
  const systemDirs = SYSTEMD_DAEMON_PATH.split(":");
  const trustedDirs = trustedExecutableDirs(
    spawnCommand,
    spawnArgs,
    workingDirectory,
    homeDirectory,
    requireCanonicalHome,
  )
    .filter(({ directory, entrypoint }) => entrypoint || !systemDirs.includes(directory))
    .map(({ directory }) => directory);
  return [...new Set([...trustedDirs, ...systemDirs])].join(":");
}

/** Build the executable path used by the managed Linux systemd daemon. */
export function managedDaemonPath(
  spawnCommand: string,
  spawnArgs: readonly string[],
  workingDirectory = process.cwd(),
  homeDirectory = homedir(),
): string {
  return buildManagedDaemonPath(spawnCommand, spawnArgs, workingDirectory, homeDirectory, false);
}

/** Build a stable managed-launch PATH with canonical home trust checks. */
export function managedDaemonPathForStableLaunch(
  spawnCommand: string,
  spawnArgs: readonly string[],
  workingDirectory: string,
  homeDirectory?: string,
): string {
  const authenticatedHome = homeDirectory === undefined
    ? authenticatedImplicitHomeDirectory()
    : canonicalPath(homeDirectory);
  return buildManagedDaemonPath(spawnCommand, spawnArgs, workingDirectory, authenticatedHome, true);
}
