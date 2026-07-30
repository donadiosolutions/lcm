import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
} from "node:path";
import { readBoundedRegularFile } from "./security-files.js";

const MAX_GIT_POINTER_BYTES = 64 * 1024;
const MAX_GIT_CONFIG_BYTES = 4 * 1024 * 1024;
const resolutionCache = new Map<string, GitProjectAnchor>();

export type GitProjectAnchor = {
  /** Stable local repository anchor shared by every linked worktree. */
  canonical: string;
  /** The checkout containing the requested working directory. */
  worktreeRoot: string;
  /** Git's shared repository directory (`git rev-parse --git-common-dir`). */
  commonDir: string;
};

function existingRealDirectory(path: string, label: string): string {
  const real = realpathSync(path);
  if (!statSync(real).isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
  return real;
}

function readGitMetadata(
  path: string,
  allowedRoot: string,
  label: string,
  maxBytes: number,
): string {
  try {
    return readBoundedRegularFile(path, {
      allowedRoot,
      maxBytes,
    });
  } catch (error) {
    throw new Error(`invalid ${label} metadata at ${path}: ${String(error)}`);
  }
}

function readGitPointer(path: string, allowedRoot: string, label: string): string {
  return readGitMetadata(path, allowedRoot, label, MAX_GIT_POINTER_BYTES);
}

function readGitConfig(path: string, allowedRoot: string, label: string): string {
  return readGitMetadata(path, allowedRoot, label, MAX_GIT_CONFIG_BYTES);
}

function parseGitDir(
  pointerPath: string,
  worktreeRoot: string,
): { readonly gitDir: string; readonly isRelative: boolean } {
  const content = readGitPointer(pointerPath, worktreeRoot, "Git worktree");
  const trimmed = content.trim();
  const match = /^gitdir:\s*(.+)$/iu.exec(trimmed);
  if (!match) {
    throw new Error(`invalid Git worktree metadata at ${pointerPath}: expected one gitdir line`);
  }
  const target = match[1]!;
  return {
    gitDir: existingRealDirectory(resolve(worktreeRoot, target), "Git directory"),
    isRelative: !isAbsolute(target),
  };
}

function resolveCommonDir(gitDir: string): string {
  const commonPointer = join(gitDir, "commondir");
  if (!existsSync(commonPointer)) return gitDir;
  const stat = lstatSync(commonPointer);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`invalid Git common-directory metadata at ${commonPointer}`);
  }
  const relative = readGitPointer(commonPointer, gitDir, "Git common-directory").trim();
  if (!relative || relative.includes("\0") || relative.includes("\n") || relative.includes("\r")) {
    throw new Error(`invalid Git common-directory metadata at ${commonPointer}: expected one path`);
  }
  return existingRealDirectory(resolve(gitDir, relative), "Git common directory");
}

function parseOnePath(content: string, path: string, label: string): string {
  const value = content.trim();
  if (!value || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`invalid ${label} metadata at ${path}: expected one path`);
  }
  return value;
}

function validateWorktreeBackpointer(
  marker: string,
  worktreeRoot: string,
  gitDir: string,
): void {
  const backpointerPath = join(gitDir, "gitdir");
  const backpointer = parseOnePath(
    readGitPointer(backpointerPath, gitDir, "Git worktree backpointer"),
    backpointerPath,
    "Git worktree backpointer",
  );
  const backpointerTarget = resolve(gitDir, backpointer);
  let resolvedBackpointer: string;
  let resolvedMarker: string;
  try {
    const targetStat = lstatSync(backpointerTarget);
    const markerStat = lstatSync(marker);
    if (
      !targetStat.isFile()
      || !markerStat.isFile()
    ) {
      throw new Error("backpointer target or worktree marker is not a regular file");
    }
    resolvedBackpointer = realpathSync(backpointerTarget);
    resolvedMarker = realpathSync(marker);
  } catch (error) {
    throw new Error(
      `invalid Git worktree backpointer metadata at ${backpointerPath}: ${String(error)}`,
    );
  }
  if (
    resolvedBackpointer !== resolvedMarker
    || resolvedMarker !== join(worktreeRoot, ".git")
  ) {
    throw new Error(
      `invalid Git worktree backpointer metadata at ${backpointerPath}: topology does not point to ${marker}`,
    );
  }
}

function validateLinkedWorktreeTopology(
  marker: string,
  worktreeRoot: string,
  gitDir: string,
  commonDir: string,
): void {
  const worktreesPath = join(commonDir, "worktrees");
  const worktreesStat = (() => {
    try {
      return lstatSync(worktreesPath);
    } catch (error) {
      throw new Error(
        `invalid Git worktrees directory at ${worktreesPath}: ${String(error)}`,
      );
    }
  })();
  if (!worktreesStat.isDirectory() || worktreesStat.isSymbolicLink()) {
    throw new Error(`invalid Git worktrees directory at ${worktreesPath}`);
  }
  const worktreesDir = existingRealDirectory(
    worktreesPath,
    "Git worktrees directory",
  );
  if (worktreesDir !== worktreesPath) {
    throw new Error(`invalid Git worktrees directory at ${worktreesPath}`);
  }
  if (
    dirname(gitDir) !== worktreesDir
    || resolve(worktreesDir, basename(gitDir)) !== gitDir
  ) {
    throw new Error(
      `invalid Git linked-worktree topology: ${gitDir} is not a direct worktree entry under ${commonDir}`,
    );
  }

  validateWorktreeBackpointer(
    marker,
    worktreeRoot,
    gitDir,
  );

  // Re-read all three pointers after the topology check. Each individual read
  // is descriptor-bound; comparing the resolved relationship a second time
  // also fails closed when repository-controlled metadata is retargeted
  // between validation steps.
  if (parseGitDir(marker, worktreeRoot).gitDir !== gitDir) {
    throw new Error("Git worktree metadata changed during topology validation");
  }
  if (resolveCommonDir(gitDir) !== commonDir) {
    throw new Error("Git common-directory metadata changed during topology validation");
  }
  try {
    validateWorktreeBackpointer(
      marker,
      worktreeRoot,
      gitDir,
    );
  } catch (error) {
    throw new Error(
      `Git worktree backpointer changed during topology validation: ${String(error)}`,
    );
  }
}

function canonicalForCommonDir(commonDir: string): string {
  // Normal non-bare repositories keep the shared directory at <checkout>/.git.
  // Bare repositories and unusual layouts use the common directory itself as
  // the stable local anchor; this still distinguishes separate clones.
  return basename(commonDir) === ".git"
    ? existingRealDirectory(dirname(commonDir), "Git primary checkout")
    : commonDir;
}

function configHasCoreWorktree(config: string): boolean {
  let inCore = false;
  for (const line of config.split(/\r?\n/u)) {
    const section = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (section) {
      inCore = section[1]!.trim().toLowerCase() === "core";
      continue;
    }
    if (inCore && /^\s*worktree\s*=/iu.test(line)) return true;
  }
  return false;
}

function configEnablesWorktreeConfig(config: string): boolean {
  let inExtensions = false;
  for (const line of config.split(/\r?\n/u)) {
    const section = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (section) {
      inExtensions = section[1]!.trim().toLowerCase() === "extensions";
      continue;
    }
    if (
      inExtensions
      && /^\s*worktreeconfig(?:\s*=\s*(?:true|yes|on|1)\s*(?:[#;].*)?)?\s*$/iu.test(line)
    ) {
      return true;
    }
  }
  return false;
}

function hasConfiguredWorktree(gitDir: string): boolean {
  const config = readGitConfig(join(gitDir, "config"), gitDir, "Git config");
  if (configHasCoreWorktree(config)) return true;
  if (!configEnablesWorktreeConfig(config)) return false;
  const worktreeConfigPath = join(gitDir, "config.worktree");
  if (!existsSync(worktreeConfigPath)) return false;
  return configHasCoreWorktree(
    readGitConfig(worktreeConfigPath, gitDir, "Git worktree config"),
  );
}

function validateGitDirectory(gitDir: string, commonDir: string): void {
  for (const [path, label, read] of [
    [join(gitDir, "HEAD"), "Git HEAD", readGitPointer],
    [join(commonDir, "config"), "Git config", readGitConfig],
  ] as const) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`invalid ${label} metadata at ${path}`);
    }
    read(path, dirname(path), label);
  }
  const objects = lstatSync(join(commonDir, "objects"));
  if (!objects.isDirectory() || objects.isSymbolicLink()) {
    throw new Error(`invalid Git objects directory at ${join(commonDir, "objects")}`);
  }
}

function inspectGitMarker(worktreeRoot: string): GitProjectAnchor | null {
  const marker = join(worktreeRoot, ".git");
  if (!existsSync(marker)) return null;
  const stat = lstatSync(marker);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing symlink Git metadata: ${marker}`);
  }

  let gitDir: string;
  let relativeGitPointer = false;
  if (stat.isDirectory()) {
    gitDir = existingRealDirectory(marker, "Git directory");
  } else if (stat.isFile()) {
    const parsedPointer = parseGitDir(marker, worktreeRoot);
    gitDir = parsedPointer.gitDir;
    relativeGitPointer = parsedPointer.isRelative;
  } else {
    throw new Error(`invalid Git metadata type at ${marker}`);
  }

  const commonDir = resolveCommonDir(gitDir);
  if (stat.isFile() && commonDir !== gitDir) {
    validateLinkedWorktreeTopology(marker, worktreeRoot, gitDir, commonDir);
  }
  validateGitDirectory(gitDir, commonDir);
  return {
    // A normal submodule has a `.git` pointer into the superproject's
    // `.git/modules/...` directory, no `commondir`, and an explicit core
    // worktree. A primary checkout created with `--separate-git-dir` also has
    // no `commondir`, but Git writes its pointer as an absolute path. Keep that
    // external directory as the anchor so linked worktrees resolve identically.
    canonical: stat.isFile() && relativeGitPointer && commonDir === gitDir
      ? hasConfiguredWorktree(commonDir) ? worktreeRoot : canonicalForCommonDir(commonDir)
      : canonicalForCommonDir(commonDir),
    worktreeRoot,
    commonDir,
  };
}

function anchorsEqual(left: GitProjectAnchor, right: GitProjectAnchor): boolean {
  return left.canonical === right.canonical
    && left.worktreeRoot === right.worktreeRoot
    && left.commonDir === right.commonDir;
}

function scanForGitProjectAnchor(start: string): GitProjectAnchor | null {
  let current = start;
  for (;;) {
    const anchor = inspectGitMarker(current);
    if (anchor) return anchor;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return null;
    current = parent;
  }
}

function revalidateCachedAnchor(
  start: string,
  cached: GitProjectAnchor,
): GitProjectAnchor | undefined {
  let current = start;
  for (;;) {
    const anchor = inspectGitMarker(current);
    if (anchor) return anchorsEqual(anchor, cached) ? cached : anchor;
    if (current === cached.worktreeRoot) return undefined;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return undefined;
    current = parent;
  }
}

/**
 * Resolve a working directory to its shared local Git repository identity.
 *
 * The nearest ancestor containing `.git` wins, so nested repositories remain
 * separate projects. Repository remotes are deliberately not inspected.
 */
export function resolveGitProjectAnchor(cwd: string): GitProjectAnchor | null {
  const requested = resolve(cwd);
  let real: string;
  try {
    real = existingRealDirectory(requested, "working directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const cached = resolutionCache.get(real);
  if (cached !== undefined) {
    const revalidated = revalidateCachedAnchor(real, cached);
    if (revalidated !== undefined) {
      resolutionCache.set(real, revalidated);
      return revalidated;
    }
  }

  const anchor = scanForGitProjectAnchor(real);
  if (anchor) resolutionCache.set(real, anchor);
  else resolutionCache.delete(real);
  return anchor;
}

export function clearGitProjectAnchorCache(): void {
  resolutionCache.clear();
}
