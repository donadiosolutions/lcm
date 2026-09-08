import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
const equal = (a, b, id) => assertSemanticEqual(a, b, `prepared-${id}`);
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
  return { map, mapFile, backups, otherLeaves, backupRoot: stat ? { inode: stat.ino, dev: stat.dev, mode: stat.mode, uid: stat.uid, gid: stat.gid } : null };
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
  equal(current.otherLeaves ?? {}, prior.otherLeaves ?? {}, 'other-metadata');
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
export function validatePreparedInputs(caseId, scenario, paths, before, after, owner) {
  const targets = preparedCase(caseId, scenario, paths);
  if (caseId === 'identity-roots') targets.push(join(dirname(paths.projectPath), 'surface-identity-alias'));
  const allowed = new Map();
  const directory = path => allowed.set(path, { kind: 'directory' });
  const file = (path, bytes) => allowed.set(path, { kind: 'file', sha256: hash(bytes) });
  for (const target of targets) {
    directory(target); directory(join(target, '.git')); directory(join(target, '.git/objects'));
    file(join(target, '.git/HEAD'), 'ref: refs/heads/main\n');
    file(join(target, '.git/config'), '[core]\nrepositoryformatversion = 0\n'
      + (caseId === 'import-collisions' ? '[remote "origin"]\nurl = https://example.invalid/parity-import.git\n' : ''));
    if (caseId === 'import-collisions') {
      directory(join(paths.homeDir, 'import-collision'));
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
