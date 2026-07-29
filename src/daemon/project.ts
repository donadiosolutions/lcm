import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, normalize, join as pathJoin, dirname, basename, parse } from "node:path";
import { lcmHomeDir } from "../runtime-paths.js";
import { resolveProjectIdentity, type ProjectIdentity } from "../project-map.js";
import { atomicWritePrivateFile, ensurePrivateDirectory, readBoundedRegularFile } from "../security-files.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import { resolveStorageIdentityContext } from "../storage/identity-context.js";
import type { ResolvedStorageConfig } from "./config.js";
import { ensureWorktreeProjectReconciled } from "../worktree-reconciliation.js";

const MAX_PROJECT_METADATA_BYTES = 1024 * 1024;

export function projectIdentity(cwd: string): ProjectIdentity;
export function projectIdentity(
  cwd: string,
  config: ResolvedStorageConfig,
): StorageIdentityContext & { readonly localProjectId: string };
export function projectIdentity(
  cwd: string,
  config?: ResolvedStorageConfig,
): ProjectIdentity | StorageIdentityContext {
  if (config) ensureWorktreeProjectReconciled(cwd);
  const local = resolveProjectIdentity(cwd);
  return config ? resolveStorageIdentityContext(config, local) : local;
}

export const projectId = (cwd: string): string =>
  projectIdentity(cwd).id;

export const projectCanonicalPath = (cwd: string): string =>
  projectIdentity(cwd).canonical;

export function projectPaths(cwd: string): ProjectIdentity & { dir: string; dbPath: string; metaPath: string } {
  ensureWorktreeProjectReconciled(cwd);
  // Reconciliation may atomically replace a legacy worktree hash while this
  // call is in flight. Resolve again after the commit point before deriving
  // any storage paths.
  const identity = projectIdentity(cwd);
  const dir = join(lcmHomeDir(), "projects", identity.id);
  return {
    ...identity,
    dir,
    dbPath: join(dir, "db.sqlite"),
    metaPath: join(dir, "meta.json"),
  };
}

export const projectDir = (cwd: string): string =>
  projectPaths(cwd).dir;

export const projectDbPath = (cwd: string): string =>
  projectPaths(cwd).dbPath;

export const projectMetaPath = (cwd: string): string =>
  projectPaths(cwd).metaPath;

function tryRealpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function allowedTranscriptBases(cwd: string): string[] {
  const bases = [
    tryRealpath(pathJoin(homedir(), ".claude", "projects")),
    tryRealpath(pathJoin(homedir(), ".codex", "sessions")),
    tryRealpath(pathJoin(homedir(), ".codex", "archived_sessions")),
  ];
  const workspace = tryRealpath(resolve(cwd));
  if (workspace !== parse(workspace).root) bases.push(workspace);
  return bases;
}

/**
 * Like realpathSync but handles non-existent paths by resolving the nearest
 * existing ancestor and appending the remaining components.
 * This ensures symlinked parent directories are resolved even when the leaf
 * path doesn't exist yet (e.g. a transcript file not yet created).
 */
function realpathDeep(p: string): string {
  try { return realpathSync(p); } catch { /* fall through */ }
  // Walk up to find the nearest existing ancestor, then reconstruct
  const parts: string[] = [];
  let cur = p;
  while (true) {
    const parent = dirname(cur);
    if (parent === cur) break; // reached root
    parts.unshift(basename(cur));
    cur = parent;
    try {
      const real = realpathSync(cur);
      return join(real, ...parts);
    } catch { /* keep walking up */ }
  }
  return p; // fallback: return original
}

export function isSafeTranscriptPath(transcriptPath: string, cwd: string): string | false {
  const resolved = resolve(transcriptPath);

  // Check for symlinks: if the resolved path is a symlink, follow it and re-validate.
  let lstat: ReturnType<typeof lstatSync> | null = null;
  try { lstat = lstatSync(resolved); } catch { /* file doesn't exist */ }

  if (lstat?.isSymbolicLink()) {
    // Follow symlink to real path and re-validate against allowed bases
    let real: string;
    try { real = realpathSync(resolved); } catch { return false; }
    const allowedBases = allowedTranscriptBases(cwd);
    for (const base of allowedBases) {
      const normalBase = normalize(base + "/");
      if (real.startsWith(normalBase) || real === normalize(base)) {
        return real;
      }
    }
    return false;
  }

  // Not a symlink (or doesn't exist yet): validate using resolve() — consistent with cwd.
  // Canonicalize both the candidate path and the allowed bases via realpathSync so that
  // a symlinked parent directory (e.g. /tmp -> /private/tmp on macOS) doesn't create
  // a bypass in either direction.
  // Use realpathDeep so non-existent leaf paths still get their parent directories
  // resolved (e.g. /tmp/transcript.jsonl -> /private/tmp/transcript.jsonl on macOS).
  const candidate = realpathDeep(resolved);
  const allowedBases = allowedTranscriptBases(cwd);
  for (const base of allowedBases) {
    const normalBase = normalize(base + "/");
    if (candidate.startsWith(normalBase) || candidate === normalize(base)) {
      return candidate;
    }
  }
  return false;
}

/** Ensures the snapshotted project dir exists and writes its canonical cwd to meta.json. */
export const ensureProjectDirForIdentity = (identity: ProjectIdentity): string => {
  const dir = join(lcmHomeDir(), "projects", identity.id);
  ensurePrivateDirectory(lcmHomeDir());
  ensurePrivateDirectory(join(lcmHomeDir(), "projects"));
  ensurePrivateDirectory(dir);
  const metaPath = join(dir, "meta.json");
  let meta: Record<string, unknown> = { cwd: identity.canonical };
  try {
    const existing = JSON.parse(readBoundedRegularFile(metaPath, {
      allowedRoot: dir,
      maxBytes: MAX_PROJECT_METADATA_BYTES,
    })) as Record<string, unknown>;
    if (existing.cwd === identity.canonical) return dir;
    meta = { ...existing, cwd: identity.canonical };
  } catch { /* keep default */ }
  atomicWritePrivateFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return dir;
};

/** Ensures the current project dir exists and writes cwd to meta.json. */
export const ensureProjectDir = (cwd: string): string => {
  ensureWorktreeProjectReconciled(cwd);
  return ensureProjectDirForIdentity(resolveProjectIdentity(cwd));
};
