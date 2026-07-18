import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { legacyLcmHomeDirname } from "./legacy-names.js";
import { ensurePrivateDirectory } from "./security-files.js";

export const LCM_HOME_DIRNAME = ".lcm";
export const LEGACY_LCM_HOME_DIRNAME = legacyLcmHomeDirname();

export type RuntimeHomeMigration = {
  migrated: boolean;
  from: string;
  to: string;
};

export function lcmHomeDir(homeDir: string = homedir()): string {
  return join(homeDir, LCM_HOME_DIRNAME);
}

export function legacyLcmHomeDir(homeDir: string = homedir()): string {
  return join(homeDir, LEGACY_LCM_HOME_DIRNAME);
}

export function lcmPath(...segments: string[]): string {
  return join(lcmHomeDir(), ...segments);
}

export function configPath(homeDir: string = homedir()): string {
  return join(lcmHomeDir(homeDir), "config.json");
}

export function daemonPidPath(homeDir: string = homedir()): string {
  return join(lcmHomeDir(homeDir), "daemon.pid");
}

export function daemonTokenPath(homeDir: string = homedir()): string {
  return join(lcmHomeDir(homeDir), "daemon.token");
}

export function projectsDir(homeDir: string = homedir()): string {
  return join(lcmHomeDir(homeDir), "projects");
}

export function tmpDir(homeDir: string = homedir()): string {
  return join(lcmHomeDir(homeDir), "tmp");
}

export function migrateLegacyHomeIfNeeded(homeDir: string = homedir()): RuntimeHomeMigration {
  const from = legacyLcmHomeDir(homeDir);
  const to = lcmHomeDir(homeDir);
  if (!existsSync(from)) {
    if (existsSync(to)) ensurePrivateDirectory(to);
    return { migrated: false, from, to };
  }
  if (existsSync(join(to, "config.json")) || existsSync(join(to, "projects")) || existsSync(join(to, "events"))) {
    ensurePrivateDirectory(to);
    return { migrated: false, from, to };
  }

  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to)) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const sourcePath = join(from, entry.name);
      const targetPath = join(to, entry.name);
      if (existsSync(targetPath)) continue;
      renameSync(sourcePath, targetPath);
    }
    rmSync(from, { recursive: true, force: true });
    ensurePrivateDirectory(to);
    return { migrated: true, from, to };
  }
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(from, to, { recursive: true, errorOnExist: true });
    rmSync(from, { recursive: true, force: true });
  }

  ensurePrivateDirectory(to);

  return { migrated: true, from, to };
}
