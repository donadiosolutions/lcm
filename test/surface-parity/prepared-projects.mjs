import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { assertSemanticEqual, assertLogicalSnapshotUnchanged } from './assertions.mjs';

const CASES = {
  'identity-roots': ['identity', ['identity', 'identity-other']],
  'identity-rebound': ['identity', ['identity-alias']],
  'events-operator': ['events', ['events-operator']],
  'events-notify': ['events', ['events-notify']],
  'import-collisions': ['native-import', null],
  'sensitive-files': ['sensitive', ['sensitive']],
  'promotion-root': ['promotion', ['promotion']],
};
export const SCENARIO_ORDER = ['identity', 'admin', 'events', 'memory', 'compaction', 'native-import', 'knowledge', 'sensitive', 'hooks', 'promotion', 'diagnostics', 'fault-denial', 'fault-pool', 'fault-cancellation', 'fault-unavailable'];
const CASE_ORDER = Object.keys(CASES);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const safeFields = new Set(['mode', 'uid', 'gid', 'nlink', 'inode', 'dev', 'children', 'sha256', 'bytes', 'missing',
  'directory', 'leaves', 'parent', 'content', 'value', 'witness', 'canonical', 'aliases', 'remoteProjectId', 'discovery',
  'mapFingerprint', 'codexFingerprint', 'complete', 'sourceHashes', 'pendingSourceHashes', 'createdAt', 'updatedAt']);
function unequalField(a, b, depth = 0) {
  if (depth >= 3 || !a || !b || typeof a !== 'object' || typeof b !== 'object') return 'value';
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    const name = safeFields.has(key) ? key : /^\d+$/u.test(key) ? 'index' : 'entry';
    return `${name}.${unequalField(a[key], b[key], depth + 1)}`;
  }
  return 'order';
}
const equal = (a, b, id) => {
  try { return assertSemanticEqual(a, b, `prepared-${id}`); }
  catch (error) { error.surfacePreparedField = unequalField(a, b); throw error; }
};
const check = (condition, id) => assert.ok(condition, `surface-prepared:${id}`);
export function preparedCase(caseId, scenario, paths) {
  const spec = CASES[caseId];
  check(spec && spec[0] === scenario, 'case-scenario');
  return caseId === 'import-collisions'
    ? [join(paths.homeDir, 'import-collision-a'), join(paths.homeDir, 'import-collision', 'a')]
    : spec[1].map(label => join(dirname(paths.projectPath), `surface-${label}`));
}

// Both IPC endpoints use this terminal admission state. Completing cleanup is
// deliberately not an operation that can add a case or scenario receipt.
export function createAdmissionLedger({ requireCases = true } = {}) {
  let firstFailure;
  let active;
  let activeCase;
  const scenarios = [];
  const cases = [];
  return {
    fail(error) { firstFailure ??= error; return firstFailure; },
    assertHealthy() { if (firstFailure) throw firstFailure; },
    begin(scenario) {
      this.assertHealthy();
      check(!active && SCENARIO_ORDER[scenarios.length] === scenario, 'scenario-order');
      if (requireCases && scenario === 'diagnostics') equal(cases, CASE_ORDER, 'complete-cases');
      active = scenario;
    },
    complete(scenario) { this.assertHealthy(); check(active === scenario && !activeCase, 'scenario-completion'); scenarios.push(scenario); active = undefined; },
    beginCase(caseId) {
      this.assertHealthy();
      check(!activeCase && CASE_ORDER[cases.length] === caseId && CASES[caseId]?.[0] === active, 'case-order');
      activeCase = caseId;
    },
    completeCase(caseId) { this.assertHealthy(); check(activeCase === caseId, 'case-completion'); cases.push(caseId); activeCase = undefined; },
  };
}

function fileWitness(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { missing: true };
  check(stat.isFile() && stat.mode === 0o100600 && stat.uid === process.getuid() && stat.nlink === 1, 'private-file');
  const bytes = readFileSync(path);
  return { inode: stat.ino, dev: stat.dev, uid: stat.uid, gid: stat.gid, mode: stat.mode, nlink: stat.nlink, sha256: hash(bytes), bytes: bytes.length };
}
export function capturePreparedMetadata(homeDir) {
  const root = join(homeDir, '.lcm');
  const mapFile = fileWitness(join(root, 'map.json'));
  const map = mapFile.missing ? {} : JSON.parse(readFileSync(join(root, 'map.json'), 'utf8'));
  const backupRoot = join(root, 'oldmaps');
  const stat = lstatSync(backupRoot, { throwIfNoEntry: false });
  const backups = {};
  if (stat) {
    check(stat.isDirectory() && stat.mode === 0o40700 && stat.uid === process.getuid(), 'backup-directory');
    for (const name of readdirSync(backupRoot)) {
      check(/^map-[0-9]+(?:-[1-9][0-9]*)?\.json$/u.test(name), 'backup-name');
      backups[name] = fileWitness(join(backupRoot, name));
    }
  }
  const otherLeaves = {};
  let visited = 0;
  function visit(path, relative) {
    check(++visited <= 4096, 'metadata-bound');
    const stat = lstatSync(path);
    check(stat.isDirectory() || stat.isFile(), 'metadata-type');
    const identity = { inode: stat.ino, dev: stat.dev, uid: stat.uid, gid: stat.gid, mode: stat.mode, nlink: stat.nlink };
    if (stat.isDirectory()) {
      const children = readdirSync(path).sort();
      otherLeaves[relative] = { ...identity, children };
      for (const name of children) visit(join(path, name), `${relative}/${name}`);
    } else otherLeaves[relative] = { ...identity, sha256: hash(readFileSync(path)) };
  }
  for (const name of readdirSync(root).sort()) {
    if (!['config.json', 'map.json', 'machine.json', 'backend-publication', 'projects', 'events', 'oldmaps'].includes(name)) visit(join(root, name), name);
  }
  const journals = capturePreparedJournals(homeDir);
  return { map, mapFile, backups, otherLeaves, journals, backupRoot: stat ? { inode: stat.ino, dev: stat.dev, mode: stat.mode, uid: stat.uid, gid: stat.gid } : null };
}

export function validatePreparedBundle(caseId, scenario, paths, backend, bundle) {
  const targets = preparedCase(caseId, scenario, paths);
  check(bundle?.caseId === caseId && Array.isArray(bundle.created), 'bundle');
  const expected = caseId === 'sensitive-files' ? [] : backend === 'postgresql' || caseId === 'import-collisions' ? targets : [];
  equal(bundle.created.map(item => item.path), expected, 'result-paths');
  for (const item of bundle.created) {
    const local = backend === 'postgresql' ? item.parsed?.local : item.identity;
    check(local?.id === hash(item.path) && local.canonical === item.path, 'local-result');
    if (backend === 'postgresql') {
      check(item.result?.code === 0 && equal(JSON.parse(item.result.stdout), item.parsed, 'actual-cli-result') === undefined, 'cli-result');
      check(uuid(item.parsed.remote?.projectId) && local.remoteProjectId === item.parsed.remote.projectId, 'remote-result');
      const aliases = item.parsed.remote.aliases;
      check(Array.isArray(aliases) && aliases.length === 1 && aliases[0].path === item.path && aliases[0].normalizedPath === item.path && uuid(aliases[0].machineId), 'remote-alias');
    } else check(local.remoteProjectId === undefined, 'sqlite-unbound');
  }
  return targets;
}

// Each writeProjectMap backs up the existing map once. New create: old ->
// unbound -> bound; rebound: old -> bound. No observed backup determines count.
export function validatePreparedDelta({ caseId, scenario, paths, backend, bundle, before, after, owner, umask = process.umask() }) {
  const targets = validatePreparedBundle(caseId, scenario, paths, backend, bundle);
  equal(after.authority, before.authority, 'authority');
  const prior = before.metadata;
  const current = after.metadata;
  const otherLeaves = { ...(current.otherLeaves ?? {}) };
  const name = 'home-parent-witness.json';
  const oldWitness = prior.otherLeaves?.[name];
  const newWitness = otherLeaves[name];
  if (oldWitness && newWitness && oldWitness.inode !== newWitness.inode) {
    for (const [metadata, leaf] of [[prior, oldWitness], [current, newWitness]]) {
      const witness = metadata.parentWitness;
      check(witness?.authority === 'direct-system-root', 'witness-authority');
      check(leaf.mode === 0o100600 && leaf.uid === owner && leaf.nlink === 1
        && /^[a-f0-9]{64}$/u.test(leaf.sha256) && Number.isSafeInteger(leaf.inode) && leaf.inode > 0, 'witness-file');
      equal(witness.actualPayload, witness.expectedPayload, 'witness-binding');
      check(/^[a-f0-9]{64}$/u.test(witness.checksumSha256), 'witness-checksum');
    }
    equal(current.parentWitness, prior.parentWitness, 'witness-preservation');
    // Existing CLI bootstrap republishes exactly this authenticated witness.
    // No other leaf or field acquires an atomic-publication exception.
    otherLeaves[name] = { ...newWitness, inode: oldWitness.inode };
  }
  if (after.journalProof) {
    check(journalProofs.has(after.journalProof), 'journal-proof-authority');
    equal(current.journals, after.journalProof.after, 'journal-final-capture');
    equal(prior.journals, after.journalProof.before, 'journal-before-capture');
    for (const path of after.journalProof.changedPaths) {
      if (Object.hasOwn(prior.otherLeaves, path)) otherLeaves[path] = prior.otherLeaves[path];
      else delete otherLeaves[path];
    }
  }
  equal(otherLeaves, prior.otherLeaves ?? {}, 'other-metadata');
  let map = structuredClone(prior.map);
  const expectedBackups = [];
  const publish = next => { expectedBackups.push(hash(JSON.stringify(map, null, 2) + '\n')); map = next; };
  const changes = caseId === 'sensitive-files' ? targets : bundle.created.map(item => item.path);
  for (const path of changes) {
    const id = hash(path);
    if (caseId !== 'identity-rebound') {
      check(!map[id], 'new-map-identity');
      publish({ ...map, [id]: { canonical: path, aliases: [] } });
    } else check(map[id]?.canonical === path && map[id].remoteProjectId === undefined, 'rebound-independent');
    if (backend === 'postgresql' && caseId !== 'sensitive-files') {
      const remote = bundle.created.find(item => item.path === path).parsed.remote.projectId;
      publish({ ...map, [id]: { ...map[id], remoteProjectId: remote } });
    }
  }
  equal(current.map, map, 'map-delta');
  if (prior.mapFile.missing) {
    check(backend === 'sqlite' && caseId === 'identity-roots' && changes.length === 0
      && Object.keys(prior.backups).length === 0 && prior.backupRoot === null, 'missing-map-case');
    equal(current.mapFile, prior.mapFile, 'absent-map-preserved');
  } else {
    check(!current.mapFile.missing, 'existing-map-required');
    for (const field of ['dev', 'mode', 'uid', 'gid', 'nlink']) equal(current.mapFile[field], prior.mapFile[field], 'map-owner');
    check(current.mapFile.sha256 === hash(JSON.stringify(map, null, 2) + '\n'), 'map-bytes');
    if (!changes.length) equal(current.mapFile, prior.mapFile, 'unchanged-map-file');
  }
  if (prior.backupRoot || !changes.length) equal(current.backupRoot, prior.backupRoot, 'backup-root');
  for (const [name, entry] of Object.entries(prior.backups)) equal(current.backups[name], entry, 'old-backup');
  const added = Object.keys(current.backups).filter(name => !Object.hasOwn(prior.backups, name));
  check(added.every(name => current.backups[name].dev === current.mapFile.dev), 'backup-device');
  equal(added.map(name => current.backups[name].sha256).sort(), expectedBackups.sort(), 'backup-sequence');

  const logical = structuredClone(after.logical);
  // Metadata is adapted only after independent result-backed proof above.
  check(logical.entries['map.json'].sha256 === current.mapFile.sha256 && before.logical.entries['map.json'].sha256 === prior.mapFile.sha256, 'map-capture');
  logical.entries['map.json'] = before.logical.entries['map.json'];
  if (caseId === 'sensitive-files' && backend === 'postgresql') {
    const directory = `projects/${hash(targets[0])}`;
    const leaf = `${directory}/sensitive-patterns.txt`;
    check(!Object.hasOwn(before.logical.entries, directory), 'sensitive-fresh');
    const dir = logical.entries[directory];
    const file = logical.entries[leaf];
    check(dir?.kind === 'directory' && dir.mode === (0o40000 | (0o777 & ~umask)) && dir.uid === owner && dir.dev === current.mapFile.dev, 'sensitive-directory');
    equal(dir.children, ['sensitive-patterns.txt'], 'sensitive-leaves');
    check(file?.kind === 'file' && file.mode === (0o100000 | (0o666 & ~umask)) && file.uid === owner && file.nlink === 1 && file.dev === dir.dev
      && file.bytes === 1 && file.sha256 === hash('\n'), 'sensitive-empty-pattern');
    delete logical.entries[directory]; delete logical.entries[leaf];
    const projects = logical.entries.projects;
    logical.entries.projects = { ...projects, nlink: projects.nlink - 1, children: projects.children.filter(name => name !== hash(targets[0])) };
  }
  if (backend === 'postgresql') {
    // The administrator independently compares all old catalog rows and every
    // other table before allowing these exact project additions.
    check(after.catalogValidated === true, 'catalog-required');
    logical.postgresql = before.logical.postgresql;
    logical.nativeCounts = before.logical.nativeCounts;
  }
  assertLogicalSnapshotUnchanged(logical, before.logical, 'prepared-window', { owner });
}

export async function runPreparedCase(operations, runExistingSetup) {
  try {
    operations.assertAdmitted();
    await operations.settle();
    const previous = await operations.stop();
    operations.assertStopped();
    const before = await operations.captureBefore();
    const bundle = await runExistingSetup();
    operations.assertStopped();
    const after = await operations.captureAfter(bundle);
    await operations.validate(before, after, bundle);
    const current = await operations.start(previous.port);
    check(current.pid !== previous.pid && current.generation !== previous.generation && current.port === previous.port, 'new-lifetime');
    operations.assertRestartUnchanged(await operations.captureRestart(), after);
    operations.complete();
    return bundle;
  } catch (error) { throw operations.fail(error); }
}

// Raw rows remain inside OwnedAdministrator. This comparison returns no row,
// identity key, path or database error to the worker/evidence channel.
export function validatePreparedCatalog(before, after, created) {
  const ids = created.map(item => item.remote.projectId);
  check(ids.every(uuid) && new Set(ids).size === ids.length, 'catalog-result-ids');
  for (const table of ['projects', 'aliases']) {
    const key = row => table === 'projects' ? row.project_id : `${row.machine_id}\0${row.normalized_path}`;
    const old = new Map(before[table].map(row => [key(row), row]));
    const next = new Map(after[table].map(row => [key(row), row]));
    check(old.size === before[table].length && next.size === after[table].length, 'catalog-unique');
    for (const [id, row] of old) equal(next.get(id), row, 'old-catalog-row');
    const added = after[table].filter(row => !old.has(key(row)));
    check(added.length === ids.length && added.every(row => ids.includes(row.project_id)), 'catalog-additions');
    for (const item of created) {
      const remote = item.remote;
      check(!before.projects.some(row => row.project_id === remote.projectId), 'catalog-new-id');
      const rows = added.filter(row => row.project_id === remote.projectId);
      check(rows.length === 1, 'catalog-exact-row');
      const row = rows[0];
      const timestamp = value => { check(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'catalog-timestamp'); return new Date(value).toISOString(); };
      if (table === 'projects') {
        check(typeof row.identity_key === 'string' && /^[a-f0-9]{64}$/u.test(row.identity_key), 'catalog-identity-key');
        const { identity_key: _key, ...publicRow } = row;
        equal({ ...publicRow, created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at) },
          { project_id: remote.projectId, display_name: remote.displayName, created_at: remote.createdAt, updated_at: remote.updatedAt }, 'catalog-project');
      } else {
        check(remote.aliases?.length === 1, 'catalog-alias-count');
        const alias = remote.aliases[0];
        equal({ ...row, linked_at: timestamp(row.linked_at) }, { project_id: remote.projectId, machine_id: alias.machineId,
          path: alias.path, normalized_path: alias.normalizedPath, linked_at: alias.linkedAt }, 'catalog-alias');
      }
    }
  }
  const adjusted = structuredClone(after.snapshot);
  check(adjusted.counts.projects === before.snapshot.counts.projects + ids.length, 'catalog-project-count');
  for (const id of ids) {
    equal(adjusted.projectCounts[id], { messageCount: 0, summaryCount: 0, promotedCount: 0 }, 'catalog-empty-project');
    check(!adjusted.conversations.some(row => row.projectId === id), 'catalog-empty-conversations');
    delete adjusted.projectCounts[id];
  }
  adjusted.projectIds = adjusted.projectIds.filter(id => !ids.includes(id));
  adjusted.counts.projects -= ids.length;
  for (const table of ['projects', 'project_aliases']) adjusted.tables[table] = before.snapshot.tables[table];
  equal(adjusted, before.snapshot, 'catalog-preserved');
  return { validated: true, added: ids.length };
}

export function capturePreparedInputs(paths) {
  const entries = {};
  let count = 0;
  function visit(path) {
    check(++count <= 4096, 'input-bound');
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    check(stat.isDirectory() || stat.isFile(), 'input-type');
    const identity = { inode: stat.ino, dev: stat.dev, uid: stat.uid, gid: stat.gid, mode: stat.mode, nlink: stat.nlink };
    if (stat.isDirectory()) {
      const children = readdirSync(path).sort();
      entries[path] = { ...identity, kind: 'directory', children };
      for (const child of children) visit(join(path, child));
    } else entries[path] = { ...identity, kind: 'file', sha256: hash(readFileSync(path)) };
  }
  for (const path of [dirname(paths.projectPath), join(paths.homeDir, '.claude'), join(paths.homeDir, '.codex'),
    join(paths.homeDir, 'import-collision-a'), join(paths.homeDir, 'import-collision')]) visit(path);
  return entries;
}
export function validatePreparedInputs(caseId, scenario, paths, before, after, owner, prefix = {}) {
  const targets = preparedCase(caseId, scenario, paths);
  if (caseId === 'identity-roots') targets.push(join(dirname(paths.projectPath), 'surface-identity-alias'));
  const allowed = new Map();
  const directory = path => allowed.set(path, { kind: 'directory' });
  const file = (path, bytes) => allowed.set(path, { kind: 'file', sha256: hash(bytes) });
  for (const [index, target] of targets.entries()) {
    if (index >= (prefix.targetCount ?? targets.length)) continue;
    directory(target); directory(join(target, '.git')); directory(join(target, '.git/objects'));
    file(join(target, '.git/HEAD'), 'ref: refs/heads/main\n');
    file(join(target, '.git/config'), '[core]\nrepositoryformatversion = 0\n'
      + (caseId === 'import-collisions' ? '[remote "origin"]\nurl = https://example.invalid/parity-import.git\n' : ''));
    if (caseId === 'import-collisions') {
      if (index === 1) directory(join(paths.homeDir, 'import-collision'));
      if (index >= (prefix.ownerCount ?? targets.length)) continue;
      directory(join(target, '.git/worktrees')); directory(join(target, '.git/worktrees/parity-owner'));
      file(join(target, '.git/worktrees/parity-owner/codex-thread.json'), '{"version":1,"ownerThreadId":"parity-ambiguous"}\n');
    }
  }
  const added = Object.keys(after).filter(path => !Object.hasOwn(before, path));
  for (const path of added) {
    const expected = allowed.get(path);
    const actual = after[path];
    check(expected && actual.kind === expected.kind && actual.uid === owner && actual.mode === (actual.kind === 'file' ? 0o100600 : 0o40700), 'input-new-leaf');
    if (actual.kind === 'file') check(actual.nlink === 1 && actual.sha256 === expected.sha256, 'input-new-bytes');
  }
  for (const [path, prior] of Object.entries(before)) {
    const current = after[path];
    if (prior.kind === 'directory') {
      const children = added.filter(child => dirname(child) === path);
      const directories = children.filter(child => after[child].kind === 'directory');
      equal(current, { ...prior, children: [...prior.children, ...children.map(child => child.slice(path.length + 1))].sort(), nlink: prior.nlink + directories.length }, 'input-old-directory');
    } else equal(current, prior, 'input-old-file');
  }
  // Each named Git fixture must exist with its exact source-derived files.
  for (const [path, expected] of allowed) {
    check(after[path]?.kind === expected.kind, 'input-required');
    if (expected.kind === 'file') check(after[path].sha256 === expected.sha256, 'input-required-bytes');
  }
}

const journalProofs = new WeakSet();
const journalKeys = new Set(['version', 'targetHash', 'canonical', 'sourceHashes', 'pendingSourceHashes', 'aliases',
  'remoteProjectId', 'createdAt', 'updatedAt', 'archiveAt', 'phase', 'blockedFrom', 'backupPaths', 'discovery', 'sourceComponents', 'reason']);
const hashString = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function journalSchema(value, name) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => journalKeys.has(key)), 'journal-schema');
  check(value.version === 1 && hashString(value.targetHash) && name === `${value.targetHash}.json`
    && isAbsolute(value.canonical) && resolve(value.canonical) === value.canonical, 'journal-target');
  check(Array.isArray(value.sourceHashes) && value.sourceHashes.every(hashString) && !value.sourceHashes.includes(value.targetHash)
    && new Set(value.sourceHashes).size === value.sourceHashes.length, 'journal-sources');
  check(value.pendingSourceHashes === undefined || (Array.isArray(value.pendingSourceHashes)
    && value.pendingSourceHashes.every(id => value.sourceHashes.includes(id))
    && new Set(value.pendingSourceHashes).size === value.pendingSourceHashes.length), 'journal-pending');
  for (const key of ['aliases', 'backupPaths']) check(Array.isArray(value[key]) && value[key].every(path => typeof path === 'string' && isAbsolute(path)), `journal-${key}`);
  check(iso(value.createdAt) && iso(value.updatedAt) && (value.archiveAt === undefined || iso(value.archiveAt)), 'journal-times');
  check(['planned', 'merged', 'archived', 'completed', 'blocked'].includes(value.phase)
    && (value.blockedFrom === undefined || ['planned', 'merged', 'archived'].includes(value.blockedFrom)), 'journal-phase');
  check((value.remoteProjectId === undefined || uuid(value.remoteProjectId)) && (value.reason === undefined || typeof value.reason === 'string'), 'journal-optionals');
  if (value.discovery !== undefined) check(value.discovery && Object.keys(value.discovery).sort().join(',') === 'codexFingerprint,complete,mapFingerprint'
    && hashString(value.discovery.mapFingerprint) && hashString(value.discovery.codexFingerprint) && typeof value.discovery.complete === 'boolean', 'journal-discovery');
  if (value.sourceComponents !== undefined) {
    check(value.sourceComponents && typeof value.sourceComponents === 'object' && !Array.isArray(value.sourceComponents), 'journal-components');
    for (const [id, component] of Object.entries(value.sourceComponents)) check(value.sourceHashes.includes(id) && component
      && Object.keys(component).every(key => ['projectDb', 'eventsDb', 'patterns', 'patternsDigest'].includes(key))
      && ['projectDb', 'eventsDb', 'patterns'].every(key => typeof component[key] === 'boolean')
      && (component.patternsDigest === undefined || hashString(component.patternsDigest)), 'journal-component');
  }
}
function directoryIdentity(stat) {
  check(stat.isDirectory() && stat.uid === process.getuid(), 'journal-root-authority');
  return { inode: stat.ino, dev: stat.dev, uid: stat.uid, gid: stat.gid, mode: stat.mode, nlink: stat.nlink };
}
export function capturePreparedJournals(homeDir) {
  const path = join(homeDir, '.lcm/reconciliations');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { directory: null, leaves: {}, parent: directoryIdentity(lstatSync(join(homeDir, '.lcm'))) };
  check(stat.isDirectory() && stat.mode === 0o40700 && stat.uid === process.getuid(), 'journal-directory');
  const children = readdirSync(path).sort();
  check(children.length <= 4096 && children.every(name => /^[a-f0-9]{64}\.json$/u.test(name)), 'journal-boundary-children');
  const directory = { inode: stat.ino, dev: stat.dev, uid: stat.uid, gid: stat.gid, mode: stat.mode, nlink: stat.nlink, children };
  const leaves = {};
  for (const name of children) {
    const leaf = join(path, name);
    const stat = lstatSync(leaf);
    check(stat.isFile() && stat.size <= 4 * 1024 * 1024, 'journal-file-bound');
    const witness = fileWitness(leaf);
    check(witness.dev === directory.dev, 'journal-device');
    const content = readFileSync(leaf, 'utf8');
    check(hash(content) === witness.sha256, 'journal-capture-race');
    const value = JSON.parse(content);
    journalSchema(value, name);
    leaves[name] = { witness, content, value };
  }
  return { directory, leaves, parent: directoryIdentity(lstatSync(join(homeDir, '.lcm'))) };
}
function assertJournalBytes(actual, expected, id) {
  // Diagnose only the fixed schema field, never emit journal values or paths.
  for (const key of journalKeys) check(JSON.stringify(actual.value[key]) === JSON.stringify(expected[key]), `journal-${id}-${key}`);
  check(actual.content === JSON.stringify(expected, null, 2) + '\n', `journal-${id}-serialization`);
  check(actual.witness.sha256 === hash(actual.content) && actual.witness.bytes === Buffer.byteLength(actual.content), 'journal-byte-witness');
}
export function validateJournalCall(before, after, operation, owner) {
  equal({ ...after.parent, nlink: before.parent.nlink }, before.parent, 'journal-root-preserved');
  const target = operation?.target;
  const name = target === undefined ? undefined : `${hash(target)}.json`;
  const old = name && before.leaves[name];
  const current = name && after.leaves[name];
  const changed = [];
  let write = false;
  if (target !== undefined) {
    check(operation.reference?.sourceHashes.length === 0, 'journal-current-sources');
    const { discovery, aliases, remoteProjectId } = operation.reference;
    const fastDiscovery = operation.fastDiscovery ?? discovery;
    const skip = old?.value.phase === 'completed' && old.value.canonical === target
      && old.value.discovery?.complete === true && fastDiscovery.complete === true
      && old.value.discovery.mapFingerprint === fastDiscovery.mapFingerprint && old.value.discovery.codexFingerprint === fastDiscovery.codexFingerprint;
    if (!skip) {
      check(current, 'journal-required');
      const inWindow = value => iso(value) && Date.parse(value) >= Math.min(operation.start, operation.end)
        && Date.parse(value) <= Math.max(operation.start, operation.end);
      check(Number.isFinite(operation.start) && Number.isFinite(operation.end) && inWindow(current.value.updatedAt), 'journal-updatedAt-window');
      if (!old) check(inWindow(current.value.createdAt), 'journal-createdAt-window');
      else {
        check(old.value.canonical === target, 'journal-old-canonical');
        const retry = old.value.phase === 'blocked' && (old.value.blockedFrom ?? 'planned') === 'planned'
          && old.value.pendingSourceHashes?.length === 0;
        check(old.value.phase === 'completed' || retry || (old.value.pendingSourceHashes ?? old.value.sourceHashes).length === 0, 'journal-old-pending');
        check(old.value.phase === 'completed' || remoteProjectId === old.value.remoteProjectId
          || (retry && old.value.sourceHashes.length === 0 && old.value.remoteProjectId === undefined), 'journal-old-binding');
      }
      const expected = old ? structuredClone(old.value) : {
        version: 1, targetHash: hash(target), canonical: target, sourceHashes: [], aliases,
        ...(remoteProjectId ? { remoteProjectId } : {}), createdAt: current.value.createdAt,
        updatedAt: current.value.updatedAt, phase: 'completed', backupPaths: [],
      };
      expected.aliases = [...new Set([...(old?.value.aliases ?? []), ...aliases])];
      expected.pendingSourceHashes = [];
      expected.discovery = discovery;
      expected.phase = 'completed';
      delete expected.reason;
      expected.updatedAt = current.value.updatedAt;
      assertJournalBytes(current, expected, 'write');
      const witness = current.witness;
      check(witness.mode === 0o100600 && witness.uid === owner && witness.nlink === 1 && witness.dev === after.directory?.dev
        && witness.gid === after.directory.gid
        && Number.isSafeInteger(witness.inode) && witness.inode > 0, 'journal-write-owner');
      if (old) for (const field of ['mode', 'uid', 'gid', 'nlink', 'dev']) equal(witness[field], old.witness[field], `journal-owner-${field}`);
      changed.push(`reconciliations/${name}`);
      write = true;
    }
  }
  const expectedNames = [...new Set([...Object.keys(before.leaves), ...(write ? [name] : [])])].sort();
  equal(Object.keys(after.leaves).sort(), expectedNames, 'journal-exact-leaves');
  for (const [key, leaf] of Object.entries(before.leaves)) if (!write || key !== name) equal(after.leaves[key], leaf, 'journal-preserved-leaf');
  if (before.directory) equal(after.directory, { ...before.directory, children: expectedNames }, 'journal-preserved-directory');
  else if (write) {
    const directory = after.directory;
    check(directory?.mode === 0o40700 && directory.uid === owner && directory.nlink === 2
      && directory.dev === before.parent.dev && directory.gid === before.parent.gid
      && Number.isSafeInteger(directory.inode) && directory.inode > 0, 'journal-created-directory');
    equal(directory.children, expectedNames, 'journal-new-directory-children');
  } else equal(after.directory, before.directory, 'journal-absent-directory');
  if (write && (!before.directory || expectedNames.length !== Object.keys(before.leaves).length)) changed.push('reconciliations');
  return changed;
}

// The exact finite table is scoped to original stopped callbacks. Public show
// is deliberately a map read, never a reconciliation or refresh operation.
export function preparedCallSequence(caseId, scenario, paths, backend) {
  const targets = preparedCase(caseId, scenario, paths);
  const call = (args, target, options = {}, transition) => ({ args, cwd: options.cwd ?? paths.projectPath, target, transition });
  const create = (path, name, cwd) => call(['project', 'create', path, ...(name ? ['--name', name] : []), '--json'], backend === 'postgresql' ? path : undefined, { cwd }, backend === 'postgresql' ? path : undefined);
  const show = path => call(['project', 'show', path, '--json']);
  switch (caseId) {
    case 'identity-roots': return [call(['project', 'create', targets[0], '--surface-parity-invalid-option']),
      create(targets[0], 'Surface parity identity'), ...(backend === 'postgresql' ? [show(targets[0]), create(targets[1], 'Surface parity unrelated')] : [])];
    case 'identity-rebound': return backend === 'postgresql' ? [create(targets[0]), show(targets[0]), show(join(dirname(paths.projectPath), 'surface-identity'))] : [];
    case 'events-operator': return backend === 'postgresql' ? [create(targets[0], 'Surface event operator')] : [];
    case 'events-notify': return backend === 'postgresql' ? [create(targets[0])] : [];
    case 'import-collisions': return backend === 'postgresql' ? targets.map(path => create(path)) : [];
    case 'promotion-root': return backend === 'postgresql' ? [create(targets[0], undefined, targets[0])] : [];
    case 'sensitive-files': {
      const pattern = 'parity_private_[0-9]{4}';
      const args = [[], ['add'], ['add', pattern], ['add', pattern], ['list'], ['test'], ['test', 'before parity_private_1234 after'],
        ['remove'], ['remove', pattern], ['remove', pattern], ['purge'], ['purge', '--yes']];
      const reconciles = new Set([2, 3, 4, 6, 8, 9, ...(backend === 'sqlite' ? [11] : [])]);
      return args.map((args, index) => call(['sensitive', ...args], reconciles.has(index) ? targets[0] : undefined,
        { cwd: targets[0] }, index === 2 ? targets[0] : undefined));
    }
    default: throw new Error('surface-prepared:unknown-call-case');
  }
}

export function createPreparedCallRecorder({ caseId, scenario, paths, backend, before, readEnrichedMap, captureInputs,
  captureDiscoveryInputs, assertDiscoveryTransition, discoveryForJournal, owner }) {
  const sequence = preparedCallSequence(caseId, scenario, paths, backend);
  let map = structuredClone(before.metadata.map);
  let index = 0;
  let active;
  let finished = false;
  let journals = before.metadata.journals;
  const changedPaths = new Set();
  const calls = [];
  let lastInputs = before.inputs;
  const verifyMap = () => {
    const actual = capturePreparedMetadata(paths.homeDir).map;
    equal(actual, map, 'call-prefix-map');
    equal(readEnrichedMap(), map, 'call-prefix-enriched-map');
  };
  verifyMap();
  const baselineInputs = captureDiscoveryInputs(map);
  const targets = preparedCase(caseId, scenario, paths);
  const prefix = () => caseId === 'import-collisions' ? { targetCount: Math.min(index + 1, targets.length), ownerCount: index } : {};
  const verifyInputs = stage => {
    const spec = stage === 'after' && caseId === 'import-collisions'
      ? { targetCount: index + 1, ownerCount: index } : prefix();
    const currentInputs = captureInputs();
    validatePreparedInputs(caseId, scenario, paths, before.inputs, currentInputs, owner, spec);
    validatePreparedInputs(caseId, scenario, paths, lastInputs, currentInputs, owner, spec);
    lastInputs = currentInputs;
    const inputs = captureDiscoveryInputs(map);
    const newTargets = targets.filter(path => !Object.hasOwn(before.inputs, path) && inputs.observations[path]?.[1] === 'git');
    if (caseId === 'identity-roots' && !Object.hasOwn(before.inputs, join(dirname(paths.projectPath), 'surface-identity-alias'))) newTargets.push(join(dirname(paths.projectPath), 'surface-identity-alias'));
    assertDiscoveryTransition(baselineInputs, inputs, { newTargets });
    return inputs;
  };
  return {
    beforeCall(args, options = {}) {
      check(!finished && !active && sequence[index], 'call-order');
      const spec = sequence[index];
      equal(args, spec.args, `call-${index}-args`);
      equal(options.cwd ?? paths.projectPath, spec.cwd, `call-${index}-cwd`);
      check(options.stdin === undefined && options.administrator === undefined, 'call-options');
      verifyMap();
      const current = capturePreparedJournals(paths.homeDir);
      validateJournalCall(journals, current, undefined, owner);
      const inputs = verifyInputs('before');
      const oldSourceHashes = spec.target ? journals.leaves[`${hash(spec.target)}.json`]?.value.sourceHashes ?? [] : [];
      active = { ...spec, ...(spec.target ? {
        reference: discoveryForJournal(inputs, map, spec.target),
        fastDiscovery: discoveryForJournal(inputs, map, spec.target, oldSourceHashes).discovery,
      } : {}) };
      // The CLI seam sets this immediately before launching the original child.
      return () => { check(active && active.start === undefined, 'call-start'); active.start = Date.now(); };
    },
    afterCall(result, end) {
      check(active && active.start !== undefined, 'call-exit');
      active.end = end;
      const current = capturePreparedJournals(paths.homeDir);
      for (const path of validateJournalCall(journals, current, active, owner)) changedPaths.add(path);
      journals = current;
      if (active.transition) {
        const path = active.transition;
        const id = hash(path);
        if (caseId !== 'identity-rebound') {
          check(!map[id], 'call-new-map-entry');
          map = { ...map, [id]: { canonical: path, aliases: [] } };
        } else check(map[id]?.canonical === path && map[id].remoteProjectId === undefined, 'call-unbound-alias');
        if (backend === 'postgresql' && caseId !== 'sensitive-files') {
          check(result.code === 0, 'call-create-result');
          const parsed = JSON.parse(result.stdout);
          check(parsed.local?.id === id && parsed.local.canonical === path && uuid(parsed.remote?.projectId)
            && parsed.local.remoteProjectId === parsed.remote.projectId, 'call-create-identity');
          map = { ...map, [id]: { ...map[id], remoteProjectId: parsed.remote.projectId } };
        }
      }
      verifyMap();
      verifyInputs('after');
      calls.push({ start: active.start, end, target: active.target });
      active = undefined;
      index++;
    },
    finish() {
      check(!finished && !active && index === sequence.length, 'call-complete');
      // SQLite collision identity writes have no CLI and no journal authority.
      if (backend === 'sqlite' && caseId === 'import-collisions') for (const path of targets) {
        check(!map[hash(path)], 'call-sqlite-new-map');
        map = { ...map, [hash(path)]: { canonical: path, aliases: [] } };
      }
      verifyMap();
      const after = capturePreparedJournals(paths.homeDir);
      validateJournalCall(journals, after, undefined, owner);
      const proof = { before: before.metadata.journals, after, changedPaths: [...changedPaths], calls };
      journalProofs.add(proof);
      finished = true;
      return proof;
    },
  };
}
