import { fchmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, normalize, join as pathJoin, dirname, basename, parse } from "node:path";
import { lcmHomeDir } from "../runtime-paths.js";
import {
  hashProjectPath,
  normalizeProjectIdentityPath,
  projectMapPath,
  resolveProjectIdentity,
  type ProjectIdentity,
} from "../project-map.js";
import {
  atomicWritePrivateFile,
  assertPrivateDirectory,
  assertPrivateDirectoryEntry,
  openPrivateDirectory,
  openPrivateDirectoryIfExists,
  openPrivateDirectoryForCreation,
  readBoundedRegularFile,
  type PrivateDirectoryHandle,
  type PrivateDirectoryWitness,
} from "../security-files.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import type { BackendPublicationLockToken } from "../storage/backend-publication.js";
import { resolveStorageIdentityContext } from "../storage/identity-context.js";
import type { ResolvedStorageConfig } from "./config.js";
import { ensureWorktreeProjectReconciled } from "../worktree-reconciliation.js";

export const MAX_PROJECT_METADATA_BYTES = 1024 * 1024;
const MAX_PROJECT_MAP_COMPATIBILITY_BYTES = 4 * 1024 * 1024;
const PROJECT_HASH_PATTERN = /^[a-f0-9]{64}$/u;

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function assertStablePrivateRoot(
  handle: PrivateDirectoryHandle,
  path: string,
  expected: PrivateDirectoryWitness,
): void {
  const actual = assertPrivateDirectory(handle, path);
  assertPrivateDirectoryEntry(handle, path, expected.uid);
  if (
    actual.mode !== expected.mode
    || actual.uid !== expected.uid
    || actual.gid !== expected.gid
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
  ) {
    throw new Error("private directory witness changed");
  }
}

function assertProjectTopology(
  root: PrivateDirectoryHandle,
  rootPath: string,
  projects: PrivateDirectoryHandle,
  projectsPath: string,
  leaf: PrivateDirectoryHandle,
  leafPath: string,
): void {
  assertPrivateDirectoryEntry(root, rootPath, root.witness.uid);
  assertPrivateDirectoryEntry(projects, projectsPath, projects.witness.uid);
  assertPrivateDirectoryEntry(leaf, leafPath, leaf.witness.uid);
}

function closeProjectChildAndRethrow(
  child: PrivateDirectoryHandle | undefined,
  primaryError: unknown,
): never {
  try {
    child?.close();
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "project child admission and cleanup failed",
      { cause: primaryError },
    );
  }
  throw primaryError;
}

function acquireProjectChild(
  parent: PrivateDirectoryHandle,
  parentPath: string,
  childPath: string,
  expectedUid: number | undefined,
): PrivateDirectoryHandle {
  assertPrivateDirectoryEntry(parent, parentPath, expectedUid);
  const existing = openPrivateDirectoryIfExists(childPath, { expectedUid });
  if (existing !== undefined) {
    try {
      assertPrivateDirectoryEntry(existing, childPath, expectedUid);
      return existing;
    } catch (error) {
      closeProjectChildAndRethrow(existing, error);
    }
  }

  let created = false;
  try {
    mkdirSync(childPath, { recursive: false, mode: 0o700 });
    created = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  let child: PrivateDirectoryHandle | undefined;
  try {
    child = created
      ? openPrivateDirectoryForCreation(childPath, { expectedUid })
      : openPrivateDirectory(childPath, { expectedUid });
    if (created) {
      fchmodSync(child.fd, 0o700);
    }
    assertPrivateDirectoryEntry(child, childPath, expectedUid);
    return child;
  } catch (error) {
    closeProjectChildAndRethrow(child, error);
  }
}

export type LocalProjectIdentity = Readonly<{
  id: string;
  canonical: string;
}>;

function parseLocalProjectMapCompatibility(
  cwd: string,
  homeDir?: string,
): LocalProjectIdentity {
  const canonical = normalizeProjectIdentityPath(cwd);
  const fallback: LocalProjectIdentity = {
    id: hashProjectPath(canonical),
    canonical,
  };

  // Hook durability cannot depend on project-map reconciliation or backend
  // publication state. A read-only compatibility snapshot is useful only for
  // preserving the sidecar ID of an already-mapped alias/worktree; malformed,
  // missing, or concurrently changing metadata always falls back to the
  // established path hash and still permits local enqueue.
  try {
    const path = projectMapPath(homeDir);
    const content = readBoundedRegularFile(path, {
      allowedRoot: lcmHomeDir(homeDir),
      maxBytes: MAX_PROJECT_MAP_COMPATIBILITY_BYTES,
    });
    const value: unknown = JSON.parse(content);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fallback;

    const matches: LocalProjectIdentity[] = [];
    for (const [id, entry] of Object.entries(value)) {
      if (!PROJECT_HASH_PATTERN.test(id) || entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const candidate = entry as { canonical?: unknown; aliases?: unknown };
      if (typeof candidate.canonical !== "string" || !Array.isArray(candidate.aliases)) continue;
      const paths = [candidate.canonical, ...candidate.aliases.filter((alias): alias is string => typeof alias === "string")];
      if (!paths.some((pathValue) => {
        try {
          return normalizeProjectIdentityPath(pathValue) === canonical;
        } catch {
          return false;
        }
      })) continue;
      matches.push({
        id,
        canonical: resolve(candidate.canonical),
      });
    }
    if (matches.length !== 1) return fallback;
    const matched = matches[0]!;
    // Map keys are historical storage names and may be replaced atomically
    // during worktree reconciliation. Derive the hook ID from the stable
    // canonical path so an old/new map pair cannot make eventsDbPath oscillate.
    return {
      id: hashProjectPath(normalizeProjectIdentityPath(matched.canonical)),
      canonical: matched.canonical,
    };
  } catch {
    return fallback;
  }
}

/**
 * Resolve the backend-independent identity used by hook sidecars.
 *
 * This deliberately never calls resolveProjectIdentity, project-map
 * reconciliation, storage selection, or daemon bootstrap. It keeps the
 * historical SHA-256 path identity for new projects and consults only a
 * bounded read-only map snapshot to preserve IDs for existing aliases and
 * linked worktrees.
 */
export function localProjectIdentity(cwd: string, homeDir?: string): LocalProjectIdentity {
  return parseLocalProjectMapCompatibility(cwd, homeDir);
}

export const localProjectId = (cwd: string, homeDir?: string): string =>
  localProjectIdentity(cwd, homeDir).id;

export const localProjectDir = (cwd: string, homeDir?: string): string =>
  join(lcmHomeDir(homeDir), "projects", localProjectId(cwd, homeDir));

export function projectIdentity(cwd: string): ProjectIdentity;
export function projectIdentity(
  cwd: string,
  config: ResolvedStorageConfig,
  publicationLockToken?: BackendPublicationLockToken,
): StorageIdentityContext & { readonly localProjectId: string };
export function projectIdentity(
  cwd: string,
  config?: ResolvedStorageConfig,
  publicationLockToken?: BackendPublicationLockToken,
): ProjectIdentity | StorageIdentityContext {
  if (config) {
    ensureWorktreeProjectReconciled(cwd, undefined, {
      _publicationLockToken: publicationLockToken,
    });
  }
  const local = resolveProjectIdentity(cwd, {
    _publicationLockToken: publicationLockToken,
  });
  if (!config) return local;
  const resolved = resolveStorageIdentityContext(config, local, undefined, resolve(cwd));
  const { selectedPath, ...identity } = resolved;
  Object.defineProperty(identity, "selectedPath", {
    configurable: false,
    enumerable: false,
    value: selectedPath,
    writable: false,
  });
  return identity;
}

export const projectId = (cwd: string): string =>
  projectIdentity(cwd).id;

export const projectCanonicalPath = (cwd: string): string =>
  projectIdentity(cwd).canonical;

export function projectPathsForIdentity(
  identity: ProjectIdentity,
): ProjectIdentity & { dir: string; dbPath: string; metaPath: string } {
  const dir = join(lcmHomeDir(), "projects", identity.id);
  return {
    ...identity,
    dir,
    dbPath: join(dir, "db.sqlite"),
    metaPath: join(dir, "meta.json"),
  };
}

export function projectPaths(
  cwd: string,
  publicationLockToken?: BackendPublicationLockToken,
): ProjectIdentity & { dir: string; dbPath: string; metaPath: string } {
  ensureWorktreeProjectReconciled(cwd, undefined, {
    _publicationLockToken: publicationLockToken,
  });
  // Reconciliation may atomically replace a legacy worktree hash while this
  // call is in flight. Resolve again after the commit point before deriving
  // any storage paths.
  const identity = resolveProjectIdentity(cwd, {
    _publicationLockToken: publicationLockToken,
  });
  return projectPathsForIdentity(identity);
}

export const projectDir = (cwd: string, publicationLockToken?: BackendPublicationLockToken): string =>
  projectPaths(cwd, publicationLockToken).dir;

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

type EnsureProjectDirOptions = Readonly<{
  writeMetadata?: boolean;
}>;

/** Ensures the snapshotted project dir exists and optionally writes its canonical cwd to meta.json. */
export const ensureProjectDirForIdentity = (
  identity: ProjectIdentity,
  options: EnsureProjectDirOptions = {},
): string => {
  if (!PROJECT_HASH_PATTERN.test(identity.id)) {
    throw new Error("project identity id is not a valid hash");
  }
  const rootPath = lcmHomeDir();
  const rootHandle = openPrivateDirectory(rootPath);
  const rootWitness = rootHandle.witness;
  const expectedUid = rootWitness.uid;
  let projectsHandle: PrivateDirectoryHandle | undefined;
  let leafHandle: PrivateDirectoryHandle | undefined;
  let result: string | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    assertStablePrivateRoot(rootHandle, rootPath, rootWitness);
    const dir = join(rootPath, "projects", identity.id);
    const projectsPath = join(rootPath, "projects");
    projectsHandle = acquireProjectChild(rootHandle, rootPath, projectsPath, expectedUid);
    leafHandle = acquireProjectChild(projectsHandle, projectsPath, dir, expectedUid);
    assertProjectTopology(rootHandle, rootPath, projectsHandle, projectsPath, leafHandle, dir);
    // /promote alone defers metadata to its existing dry-run-aware post-operation write.
    if (options.writeMetadata === false) {
      assertStablePrivateRoot(rootHandle, rootPath, rootWitness);
      assertProjectTopology(rootHandle, rootPath, projectsHandle, projectsPath, leafHandle, dir);
      result = dir;
    } else {
      const metaPath = join(dir, "meta.json");
      let meta: Record<string, unknown> = { cwd: identity.canonical };
      let content: string | undefined;
      try {
        content = readBoundedRegularFile(metaPath, {
          allowedRoot: dir,
          maxBytes: MAX_PROJECT_METADATA_BYTES,
        });
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      if (content !== undefined) {
        let existing: unknown;
        try {
          existing = JSON.parse(content);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (
          existing !== null
          && typeof existing === "object"
          && !Array.isArray(existing)
        ) {
          const existingRecord = existing as Record<string, unknown>;
          if (existingRecord.cwd === identity.canonical) {
            assertProjectTopology(rootHandle, rootPath, projectsHandle, projectsPath, leafHandle, dir);
            result = dir;
          } else {
            meta = { ...existingRecord, cwd: identity.canonical };
          }
        }
      }
      if (result === undefined) {
        assertProjectTopology(rootHandle, rootPath, projectsHandle, projectsPath, leafHandle, dir);
        atomicWritePrivateFile(metaPath, JSON.stringify(meta, null, 2) + "\n", {}, leafHandle);
        assertProjectTopology(rootHandle, rootPath, projectsHandle, projectsPath, leafHandle, dir);
        result = dir;
      }
      assertStablePrivateRoot(rootHandle, rootPath, rootWitness);
    }
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const handle of [leafHandle, projectsHandle, rootHandle]) {
      if (handle === undefined) continue;
      try {
        handle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!hasPrimaryError && cleanupErrors.length === 1) {
      hasPrimaryError = true;
      primaryError = cleanupErrors[0];
    } else if (!hasPrimaryError && cleanupErrors.length > 1) {
      hasPrimaryError = true;
      primaryError = new AggregateError(cleanupErrors, "project directory cleanup failed");
    } else if (hasPrimaryError && cleanupErrors.length > 0) {
      primaryError = new AggregateError(
        [primaryError, ...cleanupErrors],
        "project directory operation and cleanup failed",
        { cause: primaryError },
      );
    }
  }
  if (hasPrimaryError) throw primaryError;
  return result!;
};

/** Ensures the current project dir exists and writes cwd to meta.json. */
export const ensureProjectDir = (cwd: string, publicationLockToken?: BackendPublicationLockToken): string => {
  ensureWorktreeProjectReconciled(cwd, undefined, {
    _publicationLockToken: publicationLockToken,
  });
  return ensureProjectDirForIdentity(resolveProjectIdentity(cwd, {
    _publicationLockToken: publicationLockToken,
  }));
};
