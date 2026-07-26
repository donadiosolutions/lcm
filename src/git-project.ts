import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  parse,
  resolve,
} from "node:path";
import { readBoundedRegularFile } from "./security-files.js";

const MAX_GIT_POINTER_BYTES = 64 * 1024;
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

function readGitPointer(path: string, allowedRoot: string, label: string): string {
  try {
    return readBoundedRegularFile(path, {
      allowedRoot,
      maxBytes: MAX_GIT_POINTER_BYTES,
    });
  } catch (error) {
    throw new Error(`invalid ${label} metadata at ${path}: ${String(error)}`);
  }
}

function parseGitDir(pointerPath: string, worktreeRoot: string): string {
  const content = readGitPointer(pointerPath, worktreeRoot, "Git worktree");
  const trimmed = content.trim();
  const match = /^gitdir:\s*(.+)$/iu.exec(trimmed);
  if (!match) {
    throw new Error(`invalid Git worktree metadata at ${pointerPath}: expected one gitdir line`);
  }
  return existingRealDirectory(resolve(worktreeRoot, match[1]), "Git directory");
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

function canonicalForCommonDir(commonDir: string): string {
  // Normal non-bare repositories keep the shared directory at <checkout>/.git.
  // Bare repositories and unusual layouts use the common directory itself as
  // the stable local anchor; this still distinguishes separate clones.
  return basename(commonDir) === ".git"
    ? existingRealDirectory(dirname(commonDir), "Git primary checkout")
    : commonDir;
}

function validateGitDirectory(gitDir: string, commonDir: string): void {
  for (const [path, label] of [
    [join(gitDir, "HEAD"), "Git HEAD"],
    [join(commonDir, "config"), "Git config"],
  ] as const) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`invalid ${label} metadata at ${path}`);
    }
    readGitPointer(path, dirname(path), label);
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
  if (stat.isDirectory()) {
    gitDir = existingRealDirectory(marker, "Git directory");
  } else if (stat.isFile()) {
    gitDir = parseGitDir(marker, worktreeRoot);
  } else {
    throw new Error(`invalid Git metadata type at ${marker}`);
  }

  const commonDir = resolveCommonDir(gitDir);
  validateGitDirectory(gitDir, commonDir);
  return {
    // A normal submodule has a `.git` pointer into the superproject's
    // `.git/modules/...` directory but no `commondir`. Its checkout—not that
    // metadata directory—is its independent local project anchor.
    canonical: stat.isFile() && commonDir === gitDir
      ? worktreeRoot
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
    current = dirname(current);
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
