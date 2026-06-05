import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  watch,
  writeFileSync,
  copyFileSync,
  type FSWatcher,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { lcmHomeDir, projectsDir } from "./runtime-paths.js";

export type ProjectMapEntry = {
  canonical: string;
  aliases: string[];
};

export type ProjectMap = Record<string, ProjectMapEntry>;

export type ProjectIdentity = {
  id: string;
  canonical: string;
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
let cache: { path: string; mtimeMs: number | null; map: ProjectMap; metadataPopulated: boolean } | null = null;

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
      { canonical: entry.canonical, aliases: [...entry.aliases] },
    ]),
  );
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

function readMapFile(path: string): { content: string; mtimeMs: number | null } | null {
  try {
    return {
      content: readFileSync(path, "utf-8"),
      mtimeMs: statSync(path).mtimeMs,
    };
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
    map[hash] = {
      canonical: entry.canonical,
      aliases: [...entry.aliases],
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
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `map-${Math.floor(Date.now() / 1000)}.json`);
  if (!existsSync(backupPath)) {
    copyFileSync(path, backupPath);
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
  mkdirSync(dirname(path), { recursive: true });
  assertCurrentMapIsWritable(path);
  const backupPath = createBackupIfNeeded(path, homeDir);
  writeFileSync(path, prettyMap(map));
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

  if (cache?.path === path) {
    cache = { ...cache, map: cloneMap(map), metadataPopulated: true };
  }
  return map;
}

function collectPathOwners(map: ProjectMap): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const [hash, entry] of Object.entries(map)) {
    for (const rawPath of [entry.canonical, ...entry.aliases]) {
      const path = normalizeProjectPath(rawPath);
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
    const canonical = normalizeProjectPath(entry.canonical);
    const seen = new Set<string>();
    const aliases: string[] = [];
    for (const alias of entry.aliases) {
      const normalized = normalizeProjectPath(alias);
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
  const normalized = normalizeProjectPath(path);
  const matches = new Set<string>();
  for (const [hash, entry] of Object.entries(map)) {
    const paths = [entry.canonical, ...entry.aliases].map(normalizeProjectPath);
    if (paths.includes(normalized)) matches.add(hash);
  }
  return matches;
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
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { cwd?: unknown };
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
  const matches = findPathMatches(map, normalized);
  if (matches.size > 1) {
    throw new Error(`project path maps to multiple hashes: ${normalized} (${[...matches].join(", ")})`);
  }
  if (matches.size === 1) {
    const id = [...matches][0];
    return { id, canonical: normalizeProjectPath(map[id].canonical) };
  }

  const id = hashProjectPath(normalized);
  if (!map[id]) {
    map[id] = { canonical: normalized, aliases: [] };
    writeProjectMap(map, undefined, { metadataPopulated: true });
  }
  return { id, canonical: normalizeProjectPath(map[id].canonical) };
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
  return [...new Set([entry.canonical, ...entry.aliases].map(normalizeProjectPath))];
}

export function addProjectAlias(alias: string, opts: { canonical?: string; hash?: string } = {}): { hash: string; entry: ProjectMapEntry; warning?: string; backupPath?: string } {
  const normalizedAlias = normalizeProjectPath(alias);
  const warning = existsSync(normalizedAlias) ? undefined : `alias path does not exist: ${normalizedAlias}`;
  const target = resolveCliTarget(opts);
  const owners = collectPathOwners(target.map);
  const existingOwners = owners.get(normalizedAlias) ?? new Set<string>();
  if (existingOwners.has(target.hash)) {
    throw new Error(`alias is already mapped to ${target.hash}: ${normalizedAlias}`);
  }
  if (existingOwners.size > 0) {
    const adoptableOwners = [...existingOwners].filter((ownerHash) => {
      const entry = target.map[ownerHash];
      return entry
        && ownerHash === hashProjectPath(normalizedAlias)
        && normalizeProjectPath(entry.canonical) === normalizedAlias
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

  const canonical = normalizeProjectPath(target.entry.canonical);
  if (normalizedAlias === canonical) {
    throw new Error(`alias matches canonical path for ${target.hash}: ${normalizedAlias}`);
  }

  target.map[target.hash].aliases.push(normalizedAlias);
  const write = writeProjectMap(target.map);
  return { hash: target.hash, entry: target.map[target.hash], warning, backupPath: write.backupPath };
}

export function removeProjectAlias(alias: string, opts: { canonical?: string; hash?: string } = {}): { hash: string; entry: ProjectMapEntry; removed: boolean; backupPath?: string } {
  const normalizedAlias = normalizeProjectPath(alias);
  let map = loadProjectMap({ strict: true, reload: true });
  let hash: string;

  if (opts.canonical && opts.hash) {
    throw new Error("--canonical and --hash are mutually exclusive");
  }

  if (opts.canonical) {
    const canonical = normalizeProjectPath(opts.canonical);
    if (!existsSync(canonical)) throw new Error(`canonical path does not exist: ${canonical}`);
    if (!statSync(canonical).isDirectory()) throw new Error(`canonical path must be an existing directory: ${canonical}`);
    const owners = Object.entries(map)
      .filter(([, entry]) => normalizeProjectPath(entry.canonical) === canonical)
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
      .filter(([, entry]) => entry.aliases.map(normalizeProjectPath).includes(normalizedAlias))
      .map(([ownerHash]) => ownerHash);
    if (owners.length === 0) throw new Error(`alias is not mapped: ${normalizedAlias}`);
    if (owners.length > 1) throw new Error(`alias maps to multiple hashes: ${normalizedAlias} (${owners.join(", ")})`);
    hash = owners[0];
  }

  const entry = map[hash];
  const before = entry.aliases.length;
  entry.aliases = entry.aliases.filter((candidate) => normalizeProjectPath(candidate) !== normalizedAlias);
  const removed = entry.aliases.length !== before;
  const write: { backupPath?: string } = removed ? writeProjectMap(map) : {};
  return { hash, entry, removed, backupPath: write.backupPath };
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
  mkdirSync(dirname(path), { recursive: true });
  let closed = false;
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (closed) return;
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
