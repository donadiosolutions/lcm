import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const MAX_ENTRIES = 50_000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashPath = path => createHash('sha256').update(path).digest('hex');
const check = (condition, detail) => { if (!condition) throw new Error(`surface-prepared:inputs-${detail}`); };
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function statOrMissing(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// These are the exact directory-only source depths and exhaustion predicate.
// Transcript bytes belong to the independent prepared-input preservation check.
export function captureCodexCatalogue(homeDir, maxEntries = MAX_ENTRIES) {
  check(Number.isSafeInteger(maxEntries) && maxEntries > 0 && maxEntries <= MAX_ENTRIES, 'catalogue-bound');
  const root = join(resolve(homeDir), '.codex');
  const catalogue = [];
  function visit(path, relative, depth) {
    if (catalogue.length >= maxEntries) return;
    const stat = statOrMissing(path);
    if (!stat) return;
    const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file';
    catalogue.push([relative, type, stat.mtimeMs, stat.size]);
    if (type !== 'dir' || depth === 0) return;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      visit(join(path, entry.name), join(relative, entry.name), depth - 1);
      if (catalogue.length >= maxEntries) break;
    }
  }
  visit(join(root, 'worktrees'), 'worktrees', 3);
  visit(join(root, 'sessions'), 'sessions', 5);
  visit(join(root, 'archived_sessions'), 'archived_sessions', 2);
  const complete = catalogue.length < maxEntries;
  return freeze({ catalogue, complete, fingerprint: digest({ catalogue, complete }) });
}

function observe(path, resolveGitProjectAnchor) {
  const normalized = resolve(path);
  let stat;
  try { stat = lstatSync(normalized); } catch (error) {
    if (error.code === 'ENOENT') return [normalized, 'missing'];
    // Strictness is applied at fingerprint time for this particular target/history.
    if (error.code === 'ENOTDIR') return [normalized, 'unavailable', 'ENOTDIR'];
    throw error;
  }
  if (stat.isSymbolicLink()) return [normalized, 'symlink'];
  if (!stat.isDirectory()) return [normalized, 'non-directory'];
  let anchor;
  try { anchor = resolveGitProjectAnchor(normalized); } catch (error) {
    return [normalized, 'git-error', String(error)];
  }
  if (!anchor) return [normalized, 'directory'];
  check(typeof anchor.commonDir === 'string' && isAbsolute(anchor.commonDir)
    && anchor.commonDir === resolve(anchor.commonDir)
    && typeof anchor.canonical === 'string' && isAbsolute(anchor.canonical)
    && anchor.canonical === resolve(anchor.canonical), 'invalid-anchor');
  return [normalized, 'git', anchor.commonDir, anchor.canonical];
}

function ownerInputs(commonDir) {
  const root = join(commonDir, 'worktrees');
  const stat = statOrMissing(root);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return [];
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name, 'codex-thread.json');
    const leaf = statOrMissing(path);
    if (!leaf) continue;
    check(leaf.isFile() && !leaf.isSymbolicLink() && leaf.nlink === 1 && leaf.size <= 16 * 1024, 'unsupported-owner-file');
    const bytes = readFileSync(path, 'utf8');
    let metadata;
    try { metadata = JSON.parse(bytes); } catch { metadata = null; }
    const threadId = metadata?.version === 1 && typeof metadata.ownerThreadId === 'string' && metadata.ownerThreadId
      ? metadata.ownerThreadId : null;
    result.push({ path, bytes, threadId, hasGitdir: existsSync(join(root, entry.name, 'gitdir')), dev: leaf.dev, ino: leaf.ino, mode: leaf.mode, uid: leaf.uid, gid: leaf.gid, nlink: leaf.nlink });
  }
  return result;
}

function remoteOrigin(canonical) {
  try {
    return execFileSync('git', ['-C', canonical, 'config', '--get', 'remote.origin.url'],
      { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 2_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null;
  } catch (error) {
    // The pinned slim runtime has no Git executable. Production repositoryUrl
    // catches this exact spawn failure and has no remote for tombstone discovery.
    if (error.code === 'ENOENT' && error.path === 'git' && error.status === null && error.signal === null) return null;
    // git --get exits 1 for an absent key. The fixed synthetic repository has
    // no refs directory; Git exits 128 although the read-only LCM anchor is valid.
    // Retain only this exact known fixture failure, never timeout/signal/other IO.
    if (error.status === 1 && !error.signal) return null;
    const config = join(canonical, '.git', 'config');
    const synthetic = '[core]\nrepositoryformatversion = 0\n';
    if (error.status === 128 && !error.signal && !existsSync(join(canonical, '.git', 'refs'))
      && existsSync(config) && [synthetic, synthetic + '[remote \"origin\"]\nurl = https://example.invalid/parity-import.git\n'].includes(readFileSync(config, 'utf8'))) return null;
    throw new Error('surface-prepared:inputs-unsupported-remote-observation', { cause: error });
  }
}

/** Read-only reference capture. The caller must first authenticate the raw/enriched
 * map against its independently predicted prefix, and preserve ordinary inputs.
 * No journal is read here; extra paths include all declared fixture targets.
 */
export function captureJournalInputs(homeDir, map, { resolveGitProjectAnchor, paths = [], maxEntries } = {}) {
  check(typeof resolveGitProjectAnchor === 'function', 'anchor-resolver-required');
  const requested = new Set(paths.map(path => resolve(path)));
  for (const entry of Object.values(map)) {
    check(typeof entry.canonical === 'string' && Array.isArray(entry.aliases)
      && entry.aliases.every(alias => typeof alias === 'string'), 'invalid-map-entry');
    for (const path of [entry.canonical, ...entry.aliases]) requested.add(resolve(path));
  }
  const observations = Object.fromEntries([...requested].sort().map(path => [path, observe(path, resolveGitProjectAnchor)]));
  const repositories = {};
  for (const observation of Object.values(observations)) {
    if (observation[1] !== 'git' || repositories[observation[2]]) continue;
    repositories[observation[2]] = { canonical: observation[3], remote: remoteOrigin(observation[3]), owners: ownerInputs(observation[2]) };
  }
  return freeze({ homeDir: resolve(homeDir), map: structuredClone(map), observations, repositories,
    codex: captureCodexCatalogue(homeDir, maxEntries) });
}

export function discoveryForJournal(inputs, map, target, oldSourceHashes = []) {
  check(isDeepStrictEqual(inputs.map, map), 'unvalidated-map-prefix');
  const canonical = resolve(typeof target === 'string' ? target : target.canonical);
  const targetHash = hashPath(canonical);
  if (typeof target === 'object' && target.hash !== undefined) check(target.hash === targetHash, 'wrong-target-hash');
  const anchor = inputs.observations[canonical];
  check(anchor?.[1] === 'git' && anchor[3] === canonical, 'target-anchor');
  const strict = new Set([targetHash, ...oldSourceHashes]);
  const rows = Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).map(([hash, entry]) => {
    const observations = [entry.canonical, ...entry.aliases].map(path => {
      const observation = inputs.observations[resolve(path)];
      check(observation, 'uncaptured-map-path');
      check(!(strict.has(hash) && observation[1] === 'unavailable'), 'strict-parent-ENOTDIR');
      return observation;
    }).sort(([a], [b]) => a.localeCompare(b));
    return [hash, resolve(entry.canonical), entry.aliases.map(path => resolve(path)).sort(), entry.remoteProjectId ?? null, observations];
  });
  // Reproduce the historical index's commonDir representative selection. Equal
  // remotes never establish a current source, nor an indexed target project.
  const indexed = new Map();
  for (const [hash, entry] of Object.entries(map)) {
    for (const path of [entry.canonical, ...entry.aliases]) {
      const observation = inputs.observations[resolve(path)];
      if (observation[1] !== 'git') continue;
      if (!indexed.has(observation[2]) || hash === hashPath(observation[3])) {
        indexed.set(observation[2], { hash, canonical: observation[3] });
      }
    }
  }
  const project = indexed.get(anchor[2]);
  const hasProject = project?.canonical === canonical;
  if (hasProject) {
    const targetThreads = new Set();
    for (const [commonDir, indexedProject] of indexed) {
      if (indexedProject.hash !== project.hash) continue;
      for (const owner of inputs.repositories[commonDir].owners) if (owner.threadId) targetThreads.add(owner.threadId);
    }
    // Only a thread owned by this indexed target can contribute a historical
    // owner path. Other repositories' real worktree records are irrelevant.
    for (const commonDir of indexed.keys()) {
      for (const owner of inputs.repositories[commonDir].owners) {
        check(!(owner.hasGitdir && targetThreads.has(owner.threadId)), 'unsupported-historical-gitdir');
      }
    }
  }
  const hasTombstones = inputs.codex.catalogue.some(row => row[0] === 'worktrees' && row[1] === 'dir');
  // With no indexed target, or no remote, or no tombstone directory, source's
  // historical tombstone branch cannot add paths. Relevant owner gitdir is checked above.
  check(!hasProject || !inputs.repositories[anchor[2]].remote || !hasTombstones, 'unsupported-historical-tombstones');
  const aliases = new Set([canonical]);
  const sourceHashes = [];
  const bindings = new Set();
  for (const [hash, entry] of Object.entries(map)) {
    const observation = inputs.observations[resolve(entry.canonical)];
    check(observation[1] !== 'symlink', 'unsupported-canonical-symlink');
    if (hash !== targetHash && !(observation[1] === 'git' && observation[2] === anchor[2])) continue;
    for (const path of [entry.canonical, ...entry.aliases]) aliases.add(resolve(path));
    if (hash !== targetHash) sourceHashes.push(hash);
    if (entry.remoteProjectId) bindings.add(entry.remoteProjectId);
  }
  check(bindings.size <= 1, 'conflicting-bindings');
  check(sourceHashes.length === 0, 'nonzero-current-sources');
  check(inputs.codex.fingerprint === digest({ catalogue: inputs.codex.catalogue, complete: inputs.codex.complete }), 'catalogue-fingerprint');
  return freeze({ discovery: { mapFingerprint: digest(rows), codexFingerprint: inputs.codex.fingerprint, complete: inputs.codex.complete },
    aliases: [...aliases], sourceHashes, ...([...bindings][0] ? { remoteProjectId: [...bindings][0] } : {}) });
}

/** Only declared fixed createGitFixture transitions may replace prior missing
 * observations. Prefix map/owner-file bytes are authenticated by the caller's
 * prepared-input validator; old mapped-path observations and catalogue are exact.
 */
export function assertJournalInputTransition(before, current, { newTargets = [] } = {}) {
  check(before.homeDir === current.homeDir, 'changed-home');
  check(isDeepStrictEqual(before.codex, current.codex), 'changed-codex-catalogue');
  const created = new Set(newTargets.map(path => resolve(path)));
  for (const [path, prior] of Object.entries(before.observations)) {
    const next = current.observations[path];
    if (created.has(path) && prior[1] === 'missing') {
      check(isDeepStrictEqual(next, [path, 'git', join(path, '.git'), path]), 'wrong-new-anchor');
    } else check(isDeepStrictEqual(prior, next), 'changed-mapped-path');
  }
  for (const path of created) {
    check(before.observations[path]?.[1] === 'missing', 'new-target-not-missing-before');
    check(isDeepStrictEqual(current.observations[path], [path, 'git', join(path, '.git'), path]), 'wrong-new-anchor');
  }
}
