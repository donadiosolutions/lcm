import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { lcmHomeDir, projectsDir } from "./runtime-paths.js";
import {
  atomicWritePrivateFile,
  deleteRegularFile,
  ensurePrivateDirectory,
  readBoundedRegularFile,
  readBoundedRegularFileWithStat,
  writePrivateFileExclusive,
} from "./security-files.js";
import { normalizeUuidV7 } from "./machine-identity.js";

export type ProjectMapEntry = {
  canonical: string;
  aliases: string[];
  remoteProjectId?: string;
};

export type ProjectMap = Record<string, ProjectMapEntry>;

function projectMapEntriesEqual(left: ProjectMapEntry, right: ProjectMapEntry): boolean {
  const leftAliases = left.aliases.map((path) => resolve(path)).sort();
  const rightAliases = right.aliases.map((path) => resolve(path)).sort();
  return left.remoteProjectId === right.remoteProjectId
    && resolve(left.canonical) === resolve(right.canonical)
    && leftAliases.length === rightAliases.length
    && leftAliases.every((path, index) => path === rightAliases[index]);
}

function assertExpectedProjectMapEntry(
  hash: string,
  actual: ProjectMapEntry,
  expected: ProjectMapEntry | undefined,
): void {
  if (expected && !projectMapEntriesEqual(actual, expected)) {
    throw new Error(`project map entry ${hash} changed during coordinated mutation`);
  }
}

export type ProjectIdentity = {
  id: string;
  canonical: string;
  remoteProjectId?: string;
};

export type ProjectMapValidation = {
  ok: boolean;
  map: ProjectMap | null;
  path: string;
  errors: string[];
  warnings: string[];
  fixApplied: boolean;
  backupPath?: string;
};

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_PROJECT_MAP_BYTES = 4 * 1024 * 1024;
const MAX_PROJECT_MAP_LOCK_BYTES = 1024;
let cache: { path: string; mtimeMs: number | null; map: ProjectMap; metadataPopulated: boolean } | null = null;

type ProjectMapLockOwner = {
  readonly version: 1;
  readonly pid: number;
  readonly processStartTime: string | null;
  readonly nonce: string;
};

export type ProjectMapLockObserver = (
  event: string,
  path: string,
  mutable?: { value: string },
) => void;

const NOOP_PROJECT_MAP_LOCK_OBSERVER: ProjectMapLockObserver = () => undefined;

function projectMapMutationLockPath(homeDir?: string): string {
  return `${projectMapPath(homeDir)}.lock`;
}

function processStartTime(
  pid: number,
  observer: ProjectMapLockObserver = NOOP_PROJECT_MAP_LOCK_OBSERVER,
): string | null {
  const currentPlatform = { value: platform() };
  observer("platform", "", currentPlatform);
  if (currentPlatform.value !== "linux") return null;
  try {
    const path = `/proc/${pid}/stat`;
    observer("before-process-stat-read", path);
    const observed = { value: readBoundedRegularFile(path, {
      maxBytes: 16 * 1024,
      allowedRoot: "/proc",
    }) };
    observer("after-process-stat-read", path, observed);
    const fields = observed.value.slice(observed.value.lastIndexOf(")") + 2).split(" ");
    return fields[19] || null;
  } catch {
    return null;
  }
}

function lockOwnerState(
  owner: ProjectMapLockOwner,
  observer: ProjectMapLockObserver = NOOP_PROJECT_MAP_LOCK_OBSERVER,
): "live" | "stale" | "ambiguous" {
  try {
    observer("before-process-probe", String(owner.pid));
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "stale" : "ambiguous";
  }
  const observedStartTime = processStartTime(owner.pid, observer);
  if (owner.processStartTime === null || observedStartTime === null) return "ambiguous";
  return observedStartTime === owner.processStartTime ? "live" : "stale";
}

function readProjectMapLockOwner(lockPath: string): {
  readonly content: string;
  readonly owner: ProjectMapLockOwner;
} {
  const content = readBoundedRegularFile(lockPath, {
    maxBytes: MAX_PROJECT_MAP_LOCK_BYTES,
    allowedRoot: dirname(lockPath),
  });
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(
      `project map lock is malformed; inspect ${lockPath} and remove it only after confirming no LCM mutation is active`,
    );
  }
  const owner = value as Partial<ProjectMapLockOwner>;
  if (
    !value
    || typeof value !== "object"
    || owner.version !== 1
    || !Number.isSafeInteger(owner.pid)
    || (owner.pid ?? 0) <= 0
    || (owner.processStartTime !== null && typeof owner.processStartTime !== "string")
    || typeof owner.nonce !== "string"
    || !/^[a-f0-9]{32}$/u.test(owner.nonce)
  ) {
    throw new Error(
      `project map lock has an invalid owner; inspect ${lockPath} and remove it only after confirming no LCM mutation is active`,
    );
  }
  return { content, owner: owner as ProjectMapLockOwner };
}

function createProjectMapReclaimClaim(
  claimPath: string,
  content: string,
  observer: ProjectMapLockObserver,
): boolean {
  try {
    observer("before-claim-mkdir", claimPath);
    mkdirSync(claimPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    observer("after-claim-mkdir", claimPath);
    if (!writePrivateFileExclusive(join(claimPath, "owner.json"), content)) {
      throw new Error(`project map reclaim claim owner already exists: ${claimPath}`);
    }
    return true;
  } catch (error) {
    try {
      rmdirSync(claimPath);
    } catch {
      // A partially initialized claim fails closed on the next attempt.
    }
    throw error;
  }
}

function acquireProjectMapReclaimClaim(
  claimPath: string,
  content: string,
  observer: ProjectMapLockObserver,
): void {
  if (createProjectMapReclaimClaim(claimPath, content, observer)) return;

  const ownerPath = join(claimPath, "owner.json");
  const existing = readProjectMapLockOwner(ownerPath);
  const state = lockOwnerState(existing.owner, observer);
  if (state !== "stale") {
    const reason = state === "live"
      ? `owned by live PID ${existing.owner.pid}`
      : "owner state is ambiguous";
    throw new Error(
      `stale project map lock reclamation is already in progress (${reason}); retry after it completes`,
    );
  }

  // The tombstone name is derived from the old claim generation and is never
  // removed. A delayed contender that read the same stale owner therefore
  // cannot rename a newly installed successor claim into its place.
  const tombstonePath = `${claimPath}.stale-${existing.owner.nonce}`;
  try {
    observer("before-claim-rename", claimPath);
    renameSync(claimPath, tombstonePath);
  } catch {
    throw new Error("project map lock reclamation changed during stale-owner recovery; retry the operation");
  }
  observer("after-claim-rename", claimPath);
  if (!createProjectMapReclaimClaim(claimPath, content, observer)) {
    throw new Error("project map lock reclamation was claimed concurrently; retry the operation");
  }
}

function releaseProjectMapReclaimClaim(
  claimPath: string,
  content: string,
  observer: ProjectMapLockObserver,
): void {
  const ownerPath = join(claimPath, "owner.json");
  observer("before-claim-release-read", ownerPath);
  if (readBoundedRegularFile(ownerPath, {
    maxBytes: MAX_PROJECT_MAP_LOCK_BYTES,
    allowedRoot: claimPath,
  }) !== content) {
    throw new Error("project map lock reclamation ownership changed before release");
  }
  observer("before-claim-release-delete", ownerPath);
  if (!deleteRegularFile(ownerPath)) {
    throw new Error("project map lock reclamation owner disappeared before release");
  }
  rmdirSync(claimPath);
}

function acquireProjectMapMutationLock(
  lockPath: string,
  content: string,
  observer: ProjectMapLockObserver,
): void {
  if (writePrivateFileExclusive(lockPath, content)) return;

  const existing = readProjectMapLockOwner(lockPath);
  const state = lockOwnerState(existing.owner, observer);
  if (state !== "stale") {
    const reason = state === "live" ? `owned by live PID ${existing.owner.pid}` : "owner state is ambiguous";
    throw new Error(`project map mutation is already in progress (${reason}); retry after the active operation completes`);
  }
  const reclaimPath = `${lockPath}.reclaim-${existing.owner.nonce}`;
  acquireProjectMapReclaimClaim(reclaimPath, content, observer);
  try {
    // The owner-nonce-specific reclaim claim serializes every contender that
    // observed this stale generation. Only its holder may perform the final
    // exact-content check and unlink, so no contender can delete a successor.
    const claimOwnerPath = join(reclaimPath, "owner.json");
    observer("before-claim-removal-read", claimOwnerPath);
    if (readBoundedRegularFile(claimOwnerPath, {
      maxBytes: MAX_PROJECT_MAP_LOCK_BYTES,
      allowedRoot: reclaimPath,
    }) !== content) {
      throw new Error("project map lock reclamation ownership changed before stale lock removal");
    }
    observer("before-stale-lock-read", lockPath);
    if (readBoundedRegularFile(lockPath, {
      maxBytes: MAX_PROJECT_MAP_LOCK_BYTES,
      allowedRoot: dirname(lockPath),
    }) !== existing.content) {
      throw new Error("project map lock changed while checking its stale owner; retry the operation");
    }
    observer("before-stale-lock-delete", lockPath);
    if (!deleteRegularFile(lockPath)) {
      throw new Error("project map lock disappeared during stale-owner recovery; retry the operation");
    }
    observer("before-successor-lock-create", lockPath);
    if (!writePrivateFileExclusive(lockPath, content)) {
      throw new Error("project map mutation lock was claimed concurrently; retry the operation");
    }
  } finally {
    releaseProjectMapReclaimClaim(reclaimPath, content, observer);
  }
}

function withProjectMapMutationLock<T>(
  callback: () => T,
  homeDir?: string,
  observer: ProjectMapLockObserver = NOOP_PROJECT_MAP_LOCK_OBSERVER,
): T {
  const lockPath = projectMapMutationLockPath(homeDir);
  const owner: ProjectMapLockOwner = {
    version: 1,
    pid: process.pid,
    processStartTime: processStartTime(process.pid, observer),
    nonce: randomBytes(16).toString("hex"),
  };
  const content = `${JSON.stringify(owner)}\n`;
  acquireProjectMapMutationLock(lockPath, content, observer);
  try {
    cache = null;
    return callback();
  } finally {
    if (readBoundedRegularFile(lockPath, {
      maxBytes: MAX_PROJECT_MAP_LOCK_BYTES,
      allowedRoot: dirname(lockPath),
    }) !== content) {
      throw new Error("project map mutation lock ownership changed before release");
    }
    deleteRegularFile(lockPath);
  }
}

export function projectMapPath(homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "map.json");
}

export function oldMapsDir(homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "oldmaps");
}

export function normalizeProjectPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function hashProjectPath(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

export function clearProjectMapCache(): void {
  cache = null;
}

function emptyMap(): ProjectMap {
  return {};
}

function cloneMap(map: ProjectMap): ProjectMap {
  return Object.fromEntries(
    Object.entries(map).map(([hash, entry]) => [
      hash,
      {
        canonical: entry.canonical,
        aliases: [...entry.aliases],
        ...(entry.remoteProjectId ? { remoteProjectId: entry.remoteProjectId } : {}),
      },
    ]),
  );
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

function readMapFile(path: string): { content: string; mtimeMs: number | null } | null {
  try {
    return readBoundedRegularFileWithStat(path, {
      allowedRoot: dirname(path),
      maxBytes: MAX_PROJECT_MAP_BYTES,
    });
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

function parseProjectMap(content: string): ProjectMap {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("map.json must be an object");
  }

  const map: ProjectMap = {};
  for (const [hash, value] of Object.entries(parsed)) {
    if (!HASH_RE.test(hash)) {
      throw new Error(`map entry key must be a 64-character lowercase sha256 hash: ${hash}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`map entry ${hash} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.canonical !== "string" || entry.canonical.length === 0) {
      throw new Error(`map entry ${hash}.canonical must be a non-empty string`);
    }
    if (!isAbsolute(entry.canonical)) {
      throw new Error(`map entry ${hash}.canonical must be an absolute path`);
    }
    if (!Array.isArray(entry.aliases) || !entry.aliases.every((alias) => typeof alias === "string" && alias.length > 0)) {
      throw new Error(`map entry ${hash}.aliases must be an array of non-empty strings`);
    }
    for (const alias of entry.aliases) {
      if (!isAbsolute(alias)) {
        throw new Error(`map entry ${hash}.aliases must contain only absolute paths: ${alias}`);
      }
    }
    const remoteProjectId = typeof entry.remoteProjectId === "string"
      ? normalizeUuidV7(entry.remoteProjectId)
      : null;
    if (entry.remoteProjectId !== undefined && remoteProjectId === null) {
      throw new Error(`map entry ${hash}.remoteProjectId must be a PostgreSQL UUIDv7`);
    }
    map[hash] = {
      canonical: entry.canonical,
      aliases: [...entry.aliases],
      ...(remoteProjectId
        ? { remoteProjectId }
        : {}),
    };
  }
  return map;
}

function prettyMap(map: ProjectMap): string {
  return JSON.stringify(map, null, 2) + "\n";
}

function createBackupIfNeeded(path: string, homeDir?: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const backupDir = oldMapsDir(homeDir);
  ensurePrivateDirectory(backupDir);
  const backupPath = join(backupDir, `map-${Math.floor(Date.now() / 1000)}.json`);
  if (!existsSync(backupPath)) {
    writePrivateFileExclusive(backupPath, readBoundedRegularFile(path, {
      allowedRoot: dirname(path),
      maxBytes: MAX_PROJECT_MAP_BYTES,
    }));
  }
  return backupPath;
}

function assertCurrentMapIsWritable(path: string): void {
  const file = readMapFile(path);
  if (!file) return;
  try {
    parseProjectMap(file.content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "map.json is invalid";
    throw new Error(`refusing to overwrite invalid map.json: ${detail}`);
  }
}

export function writeProjectMap(
  map: ProjectMap,
  homeDir?: string,
  opts: { metadataPopulated?: boolean } = {},
): { path: string; backupPath?: string } {
  const path = projectMapPath(homeDir);
  ensurePrivateDirectory(dirname(path));
  assertCurrentMapIsWritable(path);
  const backupPath = createBackupIfNeeded(path, homeDir);
  atomicWritePrivateFile(path, prettyMap(map));
  cache = {
    path,
    mtimeMs: statSync(path).mtimeMs,
    map: cloneMap(map),
    metadataPopulated: opts.metadataPopulated ?? cache?.metadataPopulated ?? false,
  };
  return { path, backupPath };
}

function loadProjectMap(opts: { strict?: boolean; reload?: boolean; homeDir?: string } = {}): ProjectMap {
  const path = projectMapPath(opts.homeDir);
  const file = readMapFile(path);
  if (!file) {
    if (!opts.strict && cache?.path === path) {
      return cloneMap(cache.map);
    }
    const map = emptyMap();
    cache = { path, mtimeMs: null, map, metadataPopulated: false };
    return cloneMap(map);
  }

  if (!opts.reload && cache?.path === path && cache.mtimeMs === file.mtimeMs) {
    return cloneMap(cache.map);
  }

  try {
    const map = parseProjectMap(file.content);
    cache = { path, mtimeMs: file.mtimeMs, map: cloneMap(map), metadataPopulated: false };
    return map;
  } catch (err) {
    if (opts.strict || !cache || cache.path !== path) {
      throw err;
    }
    return cloneMap(cache.map);
  }
}

function loadProjectMapWithMetadata(opts: { strict?: boolean; reload?: boolean; homeDir?: string } = {}): ProjectMap {
  const path = projectMapPath(opts.homeDir);
  const map = loadProjectMap(opts);
  if (!opts.reload && cache?.path === path && cache.metadataPopulated) {
    return map;
  }

  const populated = populateFromExistingProjectMetadata(map, opts.homeDir);
  if (populated.changed) {
    writeProjectMap(populated.map, opts.homeDir, { metadataPopulated: true });
    return populated.map;
  }

  cache = { ...cache!, map: cloneMap(map), metadataPopulated: true };
  return map;
}

function collectPathOwners(map: ProjectMap): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const [hash, entry] of Object.entries(map)) {
    for (const rawPath of [entry.canonical, ...entry.aliases]) {
      const path = resolve(rawPath);
      const set = owners.get(path) ?? new Set<string>();
      set.add(hash);
      owners.set(path, set);
    }
  }
  return owners;
}

function repairSameHashDuplicates(map: ProjectMap): { map: ProjectMap; changed: boolean; warnings: string[] } {
  const repaired = cloneMap(map);
  const warnings: string[] = [];
  let changed = false;

  for (const [hash, entry] of Object.entries(repaired)) {
    const canonical = resolve(entry.canonical);
    const seen = new Set<string>();
    const aliases: string[] = [];
    for (const alias of entry.aliases) {
      const normalized = resolve(alias);
      if (normalized === canonical) {
        changed = true;
        warnings.push(`${hash.slice(0, 8)} removed alias equal to canonical path: ${alias}`);
        continue;
      }
      if (seen.has(normalized)) {
        changed = true;
        warnings.push(`${hash.slice(0, 8)} removed duplicate alias: ${alias}`);
        continue;
      }
      seen.add(normalized);
      aliases.push(alias);
    }
    entry.aliases = aliases;
  }

  return { map: repaired, changed, warnings };
}

function findPathMatches(map: ProjectMap, path: string): Set<string> {
  const lexical = resolve(path);
  const aliasMatches = new Set<string>();
  const lexicalCanonicalMatches = new Set<string>();
  for (const [hash, entry] of Object.entries(map)) {
    if (entry.aliases.some((alias) => resolve(alias) === lexical)) aliasMatches.add(hash);
    if (resolve(entry.canonical) === lexical) lexicalCanonicalMatches.add(hash);
  }
  if (aliasMatches.size > 0) {
    // A manually edited map may assign the same lexical path as both an alias
    // and another hash's canonical path. Return every owner so the caller fails
    // closed instead of silently preferring either entry.
    for (const hash of lexicalCanonicalMatches) aliasMatches.add(hash);
    return aliasMatches;
  }

  const canonical = normalizeProjectPath(path);
  const canonicalMatches = new Set<string>();
  for (const [hash, entry] of Object.entries(map)) {
    if (resolve(entry.canonical) === canonical) canonicalMatches.add(hash);
  }
  return canonicalMatches;
}

function populateFromExistingProjectMetadata(map: ProjectMap, homeDir?: string): { map: ProjectMap; changed: boolean } {
  const next = cloneMap(map);
  let changed = false;
  const root = projectsDir(homeDir);
  if (!existsSync(root)) return { map: next, changed };

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !HASH_RE.test(entry.name)) continue;
    const metaPath = join(root, entry.name, "meta.json");
    if (!existsSync(metaPath) || next[entry.name]) continue;
    try {
      const meta = JSON.parse(readBoundedRegularFile(metaPath, {
        allowedRoot: join(root, entry.name),
        maxBytes: 1024 * 1024,
      })) as { cwd?: unknown };
      if (typeof meta.cwd !== "string" || meta.cwd.length === 0) continue;
      const canonical = normalizeProjectPath(meta.cwd);
      if (findPathMatches(next, canonical).size > 0) continue;
      next[entry.name] = { canonical, aliases: [] };
      changed = true;
    } catch {
      // Ignore corrupt project metadata; doctor handles project health separately.
    }
  }
  return { map: next, changed };
}

function existingProjectHasStoredData(hash: string): boolean {
  return existsSync(join(projectsDir(), hash, "db.sqlite"))
    || existsSync(join(lcmHomeDir(), "events", `${hash}.db`));
}

export function resolveProjectIdentity(cwd: string): ProjectIdentity {
  const map = loadProjectMapWithMetadata();

  const normalized = normalizeProjectPath(cwd);
  const matches = findPathMatches(map, cwd);
  if (matches.size > 1) {
    throw new Error(`project path maps to multiple hashes: ${normalized} (${[...matches].join(", ")})`);
  }
  if (matches.size === 1) {
    const id = [...matches][0];
    return {
      id,
      canonical: resolve(map[id].canonical),
      ...(map[id].remoteProjectId ? { remoteProjectId: map[id].remoteProjectId } : {}),
    };
  }

  const id = hashProjectPath(normalized);
  if (!map[id]) {
    map[id] = { canonical: normalized, aliases: [] };
    writeProjectMap(map, undefined, { metadataPopulated: true });
  }
  return {
    id,
    canonical: resolve(map[id].canonical),
    ...(map[id].remoteProjectId ? { remoteProjectId: map[id].remoteProjectId } : {}),
  };
}

export function listProjectMapEntries(): ProjectMap {
  return loadProjectMapWithMetadata({ strict: true, reload: true });
}

export function showProjectMapEntry(target?: string): { hash: string; entry: ProjectMapEntry; transient?: boolean } {
  const map = loadProjectMapWithMetadata({ strict: true, reload: true });
  const targetPath = target ?? process.cwd();
  if (!target) {
    const matches = findPathMatches(map, targetPath);
    if (matches.size > 1) throw new Error(`project path maps to multiple hashes: ${targetPath} (${[...matches].join(", ")})`);
    if (matches.size === 1) {
      const hash = [...matches][0];
      return { hash, entry: map[hash] };
    }
    const canonical = normalizeProjectPath(targetPath);
    return { hash: hashProjectPath(canonical), entry: { canonical, aliases: [] }, transient: true };
  }
  if (HASH_RE.test(target)) {
    const entry = map[target];
    if (!entry) throw new Error(`unknown project hash: ${target}`);
    return { hash: target, entry };
  }
  const remoteProjectId = normalizeUuidV7(target);
  if (remoteProjectId) {
    const matches = Object.entries(map).filter(
      ([, entry]) => entry.remoteProjectId === remoteProjectId,
    );
    if (matches.length === 0) throw new Error(`unknown remote project UUIDv7: ${remoteProjectId}`);
    if (matches.length > 1) {
      throw new Error(
        `remote project UUIDv7 maps to multiple local hashes: ${remoteProjectId} (${matches.map(([hash]) => hash).join(", ")})`,
      );
    }
    return { hash: matches[0][0], entry: matches[0][1] };
  }
  const matches = findPathMatches(map, target);
  if (matches.size > 1) throw new Error(`project path maps to multiple hashes: ${target} (${[...matches].join(", ")})`);
  if (matches.size === 1) {
    const hash = [...matches][0];
    return { hash, entry: map[hash] };
  }
  const canonical = normalizeProjectPath(target);
  return { hash: hashProjectPath(canonical), entry: { canonical, aliases: [] }, transient: true };
}

function resolveCliTarget(opts: { canonical?: string; hash?: string }): { hash: string; entry: ProjectMapEntry; map: ProjectMap } {
  if (opts.canonical && opts.hash) {
    throw new Error("--canonical and --hash are mutually exclusive");
  }
  if (opts.canonical) {
    const canonical = normalizeProjectPath(opts.canonical);
    if (!existsSync(canonical)) throw new Error(`canonical path does not exist: ${canonical}`);
    if (!statSync(canonical).isDirectory()) throw new Error(`canonical path must be an existing directory: ${canonical}`);
    const identity = resolveProjectIdentity(canonical);
    const map = listProjectMapEntries();
    return { hash: identity.id, entry: map[identity.id], map };
  }
  const map = listProjectMapEntries();
  if (opts.hash) {
    if (!HASH_RE.test(opts.hash)) throw new Error(`invalid project hash: ${opts.hash}`);
    const entry = map[opts.hash];
    if (!entry) throw new Error(`unknown project hash: ${opts.hash}`);
    return { hash: opts.hash, entry, map };
  }
  const identity = resolveProjectIdentity(process.cwd());
  const refreshed = listProjectMapEntries();
  return { hash: identity.id, entry: refreshed[identity.id], map: refreshed };
}

export function projectMapPathsForHash(hash: string): string[] {
  const map = loadProjectMapWithMetadata();
  const entry = map[hash];
  if (!entry) return [];
  return [...new Set([entry.canonical, ...entry.aliases].map((path) => resolve(path)))];
}

export function isProjectHash(value: string): boolean {
  return HASH_RE.test(value);
}

export function projectMapEntryHasStoredData(hash: string): boolean {
  return existingProjectHasStoredData(hash);
}

export function setRemoteProjectBinding(
  remoteProjectId: string,
  opts: {
    readonly canonical?: string;
    readonly hash?: string;
    readonly allowExistingData?: boolean;
    readonly expectedEntry?: ProjectMapEntry;
    /** @internal Test-only synchronization seam for deterministic race coverage. */
    readonly _afterLockForTesting?: () => void;
    /** @internal Test-only failure injection for lock protocol boundaries. */
    readonly _lockObserverForTesting?: ProjectMapLockObserver;
  } = {},
): {
  readonly hash: string;
  readonly entry: ProjectMapEntry;
  readonly changed: boolean;
  readonly backupPath?: string;
} {
  const normalizedRemoteProjectId = normalizeUuidV7(remoteProjectId);
  if (!normalizedRemoteProjectId) {
    throw new Error(`invalid remote project UUIDv7: ${remoteProjectId}`);
  }
  return withProjectMapMutationLock(() => {
    opts._afterLockForTesting?.();
    const target = resolveCliTarget({ canonical: opts.canonical, hash: opts.hash });
    assertExpectedProjectMapEntry(target.hash, target.entry, opts.expectedEntry);
    const current = target.entry.remoteProjectId;
    if (current === normalizedRemoteProjectId) {
      return { hash: target.hash, entry: target.entry, changed: false };
    }
    if (
      current !== undefined
      && existingProjectHasStoredData(target.hash)
      && !opts.allowExistingData
    ) {
      throw new Error(
        `project ${target.hash} already has local data; rerun with --allow-existing-data to rebind it explicitly`,
      );
    }
    target.map[target.hash].remoteProjectId = normalizedRemoteProjectId;
    const write = writeProjectMap(target.map);
    return {
      hash: target.hash,
      entry: target.map[target.hash],
      changed: true,
      backupPath: write.backupPath,
    };
  }, undefined, opts._lockObserverForTesting);
}

export function clearRemoteProjectBinding(
  target: string | undefined,
  expectedRemoteProjectId: string,
  opts: {
    readonly expectedEntry?: ProjectMapEntry;
    /** @internal Test-only synchronization seam for deterministic race coverage. */
    readonly _afterLockForTesting?: () => void;
  } = {},
): {
  readonly hash: string;
  readonly entry: ProjectMapEntry;
  readonly remoteProjectId?: string;
  readonly changed: boolean;
  readonly backupPath?: string;
} {
  const normalizedExpectedRemoteProjectId = normalizeUuidV7(expectedRemoteProjectId);
  if (!normalizedExpectedRemoteProjectId) {
    throw new Error(`invalid expected remote project UUIDv7: ${expectedRemoteProjectId}`);
  }
  return withProjectMapMutationLock(() => {
    opts._afterLockForTesting?.();
    const shown = showProjectMapEntry(target);
    if (shown.transient) {
      throw new Error(`project is not mapped: ${target ?? process.cwd()}`);
    }
    const map = listProjectMapEntries();
    // The lock makes the non-transient result and this same cached map one
    // synchronous mutation snapshot.
    const entry = map[shown.hash]!;
    assertExpectedProjectMapEntry(shown.hash, entry, opts.expectedEntry);
    if (entry.remoteProjectId !== normalizedExpectedRemoteProjectId) {
      throw new Error(
        `project ${shown.hash} remote binding changed; expected ${expectedRemoteProjectId}`,
      );
    }
    delete entry.remoteProjectId;
    const write = writeProjectMap(map);
    return {
      hash: shown.hash,
      entry,
      remoteProjectId: normalizedExpectedRemoteProjectId,
      changed: true,
      backupPath: write.backupPath,
    };
  });
}

export function addProjectAlias(alias: string, opts: {
  canonical?: string;
  hash?: string;
  expectedEntry?: ProjectMapEntry;
  _afterLockForTesting?: () => void;
} = {}): { hash: string; entry: ProjectMapEntry; warning?: string; backupPath?: string } {
  const normalizedAlias = resolve(alias);
  if (!existsSync(normalizedAlias)) throw new Error(`alias path does not exist: ${normalizedAlias}`);
  if (!statSync(normalizedAlias).isDirectory()) throw new Error(`alias path must be an existing directory: ${normalizedAlias}`);
  return withProjectMapMutationLock(() => {
    opts._afterLockForTesting?.();
    const target = resolveCliTarget(opts);
    assertExpectedProjectMapEntry(target.hash, target.entry, opts.expectedEntry);
    const canonical = resolve(target.entry.canonical);
    if (normalizedAlias === canonical) {
      throw new Error(`alias matches canonical path for ${target.hash}: ${normalizedAlias}`);
    }

    const owners = collectPathOwners(target.map);
    const existingOwners = owners.get(normalizedAlias) ?? new Set<string>();
    if (existingOwners.has(target.hash)) {
      throw new Error(`alias is already mapped to ${target.hash}: ${normalizedAlias}`);
    }
    if (existingOwners.size > 0) {
      const canonicalAlias = normalizeProjectPath(normalizedAlias);
      const adoptableOwners = [...existingOwners].filter((ownerHash) => {
        const entry = target.map[ownerHash];
        return entry
          && ownerHash === hashProjectPath(canonicalAlias)
          && normalizeProjectPath(entry.canonical) === canonicalAlias
          && entry.aliases.length === 0;
      });
      if (existingOwners.size === 1 && adoptableOwners.length === 1) {
        if (existingProjectHasStoredData(adoptableOwners[0])) {
          throw new Error(`alias is already a project with stored data: ${normalizedAlias} (${adoptableOwners[0]})`);
        }
        delete target.map[adoptableOwners[0]];
      } else {
        throw new Error(`alias is already mapped to another hash: ${normalizedAlias} (${[...existingOwners].join(", ")})`);
      }
    }

    target.map[target.hash].aliases.push(normalizedAlias);
    const write = writeProjectMap(target.map);
    return { hash: target.hash, entry: target.map[target.hash], backupPath: write.backupPath };
  });
}

export function removeProjectAlias(alias: string, opts: {
  canonical?: string;
  hash?: string;
  expectedEntry?: ProjectMapEntry;
  _afterLockForTesting?: () => void;
} = {}): { hash: string; entry: ProjectMapEntry; removed: boolean; backupPath?: string } {
  const normalizedAlias = resolve(alias);
  return withProjectMapMutationLock(() => {
    opts._afterLockForTesting?.();
    const map = loadProjectMap({ strict: true, reload: true });
    let hash: string;

  if (opts.canonical && opts.hash) {
    throw new Error("--canonical and --hash are mutually exclusive");
  }

  if (opts.canonical) {
    const canonical = normalizeProjectPath(opts.canonical);
    if (!existsSync(canonical)) throw new Error(`canonical path does not exist: ${canonical}`);
    if (!statSync(canonical).isDirectory()) throw new Error(`canonical path must be an existing directory: ${canonical}`);
    const owners = Object.entries(map)
      .filter(([, entry]) => resolve(entry.canonical) === canonical)
      .map(([ownerHash]) => ownerHash);
    if (owners.length === 0) throw new Error(`unknown canonical project path: ${canonical}`);
    if (owners.length > 1) throw new Error(`canonical path maps to multiple hashes: ${canonical} (${owners.join(", ")})`);
    hash = owners[0];
  } else if (opts.hash) {
    if (!HASH_RE.test(opts.hash)) throw new Error(`invalid project hash: ${opts.hash}`);
    if (!map[opts.hash]) throw new Error(`unknown project hash: ${opts.hash}`);
    hash = opts.hash;
  } else {
    const owners = Object.entries(map)
      .filter(([, entry]) => entry.aliases.map((candidate) => resolve(candidate)).includes(normalizedAlias))
      .map(([ownerHash]) => ownerHash);
    if (owners.length === 0) throw new Error(`alias is not mapped: ${normalizedAlias}`);
    if (owners.length > 1) throw new Error(`alias maps to multiple hashes: ${normalizedAlias} (${owners.join(", ")})`);
    hash = owners[0];
  }

    const entry = map[hash];
    assertExpectedProjectMapEntry(hash, entry, opts.expectedEntry);
    const before = entry.aliases.length;
    entry.aliases = entry.aliases.filter((candidate) => resolve(candidate) !== normalizedAlias);
    const removed = entry.aliases.length !== before;
    const write: { backupPath?: string } = removed ? writeProjectMap(map) : {};
    return { hash, entry, removed, backupPath: write.backupPath };
  });
}

export function validateProjectMap(opts: { homeDir?: string; fix?: boolean } = {}): ProjectMapValidation {
  const path = projectMapPath(opts.homeDir);
  const file = readMapFile(path);
  if (!file) {
    return { ok: true, map: emptyMap(), path, errors: [], warnings: ["map.json does not exist yet"], fixApplied: false };
  }

  let parsed: ProjectMap;
  try {
    parsed = parseProjectMap(file.content);
  } catch (err) {
    return {
      ok: false,
      map: null,
      path,
      errors: [err instanceof Error ? err.message : "map.json is invalid"],
      warnings: [],
      fixApplied: false,
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const owners = collectPathOwners(parsed);
  for (const [mappedPath, hashes] of owners.entries()) {
    if (hashes.size > 1) {
      errors.push(`path maps to multiple hashes: ${mappedPath} (${[...hashes].join(", ")})`);
    }
  }

  const repaired = repairSameHashDuplicates(parsed);
  warnings.push(...repaired.warnings);
  const desiredMap = opts.fix && repaired.changed && errors.length === 0 ? repaired.map : parsed;
  const needsFormat = file.content !== prettyMap(desiredMap);
  let backupPath: string | undefined;
  let fixApplied = false;

  if (opts.fix && errors.length === 0 && (repaired.changed || needsFormat)) {
    const write = writeProjectMap(desiredMap, opts.homeDir);
    backupPath = write.backupPath;
    fixApplied = true;
  }

  return {
    ok: errors.length === 0,
    map: desiredMap,
    path,
    errors,
    warnings,
    fixApplied,
    backupPath,
  };
}

export function reloadProjectMapCache(opts: { reformat?: boolean } = {}): boolean {
  const path = projectMapPath();
  const file = readMapFile(path);
  if (!file) {
    if (cache?.path === path) {
      return true;
    }
    cache = { path, mtimeMs: null, map: emptyMap(), metadataPopulated: false };
    return true;
  }
  try {
    const map = parseProjectMap(file.content);
    cache = { path, mtimeMs: file.mtimeMs, map: cloneMap(map), metadataPopulated: false };
    if (opts.reformat && file.content !== prettyMap(map)) {
      writeProjectMap(map);
    }
    return true;
  } catch {
    return false;
  }
}

export function watchProjectMap(): { close: () => void } {
  const path = projectMapPath();
  ensurePrivateDirectory(dirname(path));
  let closed = false;
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    try {
      watcher?.close();
      const watchPath = existsSync(path) ? path : dirname(path);
      watcher = watch(watchPath, (_event, filename) => {
        if (watchPath !== path && filename && filename.toString() !== "map.json") return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          reloadProjectMapCache({ reformat: true });
          if (!closed && !existsSync(path)) arm();
          if (!closed && watchPath === path) arm();
        }, 25);
      });
      watcher.unref();
    } catch {
      // Watch support varies by filesystem; map resolution still reloads by mtime.
    }
  };

  reloadProjectMapCache({ reformat: true });
  arm();

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}
