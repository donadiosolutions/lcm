import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { findUserSystemdPid } from '../../src/daemon/lifecycle.js';

export const LOCAL_ISOLATION_UNAVAILABLE = 'surface-parity-parent:local-isolation-unavailable';
// A private user+PID+mount namespace keeps the caller's uid and gives the
// worker a /proc without the host's per-user service manager.
export const UNSHARE_FLAGS = ['--user', '--map-current-user', '--pid', '--fork', '--mount-proc'];

function executable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

export function findUnshare(searchPath = process.env.PATH ?? '') {
  for (const directory of [...searchPath.split(delimiter), '/usr/bin', '/bin']) {
    if (directory && executable(join(directory, 'unshare'))) return join(directory, 'unshare');
  }
  return undefined;
}

export function probeUnshare(unshare) {
  const result = spawnSync(unshare, [...UNSHARE_FLAGS, 'true'], { stdio: 'ignore', timeout: 10_000 });
  return result.status === 0 && result.error === undefined;
}

/**
 * Fork options for the surface-parity worker. The worker refuses to start while
 * a same-uid `systemd --user` manager is visible (CI has none), so a desktop
 * session runs it under unshare instead. With no visible manager the worker is
 * forked directly, unchanged.
 */
export function workerLaunchOptions({ findManager = findUserSystemdPid, resolveUnshare = findUnshare, probe = probeUnshare, nodePath = process.execPath } = {}) {
  if (findManager() === null) return { execArgv: [] };
  const unshare = resolveUnshare();
  if (unshare === undefined) throw new Error(`${LOCAL_ISOLATION_UNAVAILABLE}:unshare-missing`);
  if (!probe(unshare)) throw new Error(`${LOCAL_ISOLATION_UNAVAILABLE}:user-namespace-denied`);
  return { execPath: unshare, execArgv: [...UNSHARE_FLAGS, nodePath] };
}
