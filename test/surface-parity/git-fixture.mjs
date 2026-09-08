import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Same on-disk fixture format as test/git-project.test.ts makeRepository and
// makeLinkedWorktree. The real resolver reads these files without invoking Git;
// this setup does not claim to exercise the Git executable or create commits.
export function createGitFixture(path, { remote } = {}) {
  assert.ok(isAbsolute(path), 'surface-git:owned-absolute-path');
  assert.ok(remote === undefined || remote === 'https://example.invalid/parity-import.git', 'surface-git:synthetic-remote');
  mkdirSync(join(path, '.git/objects'), { recursive: true, mode: 0o700 });
  writeFileSync(join(path, '.git/HEAD'), 'ref: refs/heads/main\n', { mode: 0o600 });
  writeFileSync(join(path, '.git/config'), '[core]\nrepositoryformatversion = 0\n'
    + (remote ? `[remote "origin"]\nurl = ${remote}\n` : ''), { mode: 0o600 });
  return path;
}

export function createLinkedWorktreeFixture(primary, linked, name = 'linked') {
  assert.ok(isAbsolute(primary) && isAbsolute(linked), 'surface-git:owned-absolute-path');
  assert.match(name, /^[a-z][a-z0-9-]*$/u, 'surface-git:worktree-name');
  const admin = join(primary, '.git/worktrees', name);
  mkdirSync(admin, { recursive: true, mode: 0o700 });
  mkdirSync(linked, { recursive: true, mode: 0o700 });
  writeFileSync(join(admin, 'commondir'), '../..\n', { mode: 0o600 });
  writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/linked\n', { mode: 0o600 });
  writeFileSync(join(linked, '.git'), `gitdir: ${admin}\n`, { mode: 0o600 });
  writeFileSync(join(admin, 'gitdir'), `${join(linked, '.git')}\n`, { mode: 0o600 });
  return linked;
}
