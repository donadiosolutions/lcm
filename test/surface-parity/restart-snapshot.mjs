import assert from 'node:assert/strict';
import { assertLogicalSnapshotUnchanged } from './assertions.mjs';

// A completed daemon lifetime may close/recreate both WAL and SHM. Preserve
// the stricter live diagnostic/fault comparator by adapting only these exact
// existing database coordination leaves for this explicit restart boundary.
export function assertRestartSnapshotUnchanged(actual, expected, owner) {
  const entries = { ...actual.entries };
  for (const [path, prior] of Object.entries(expected.entries)) {
    const suffix = path.endsWith('-wal') ? '-wal' : path.endsWith('-shm') ? '-shm' : undefined;
    const current = entries[path];
    if (!suffix || !current || current.inode === prior.inode) continue;
    const base = path.slice(0, -suffix.length);
    const priorBase = expected.entries[base];
    const currentBase = entries[base];
    assert.ok(priorBase?.sqliteFile === true && currentBase?.sqliteFile === true,
      'surface-restart:coordination-base');
    assert.ok([prior, current].every(entry => entry.kind === 'file' && entry.mode === 0o100600
      && entry.uid === owner && entry.nlink === 1 && Number.isSafeInteger(entry.inode) && entry.inode > 0),
    'surface-restart:coordination-owner');
    assert.ok(prior.dev === priorBase.dev && current.dev === currentBase.dev, 'surface-restart:coordination-device');
    entries[path] = { ...current, inode: prior.inode };
  }
  // This retains exact native tables/schema/policy, base database identity,
  // protected files, directory identity, and every non-coordination witness.
  return assertLogicalSnapshotUnchanged({ ...actual, entries }, expected, 'restart', { owner });
}
