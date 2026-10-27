import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withBackendPublicationConsumerLockAsync, assertBackendPublicationConsumerAccess } from '../../src/storage/backend-publication.js';
import { PrivateMutationLockContentionError, withPrivateMutationLockAsync } from '../../src/private-mutation-lock.js';
import { StorageOperationError } from '../../src/storage/errors.js';
import { createStorageBackendFactory } from '../../src/storage/factory.js';
import { resolveProjectIdentity, resolveExistingProjectIdentity, readProjectMapSnapshot } from '../../src/project-map.js';
import { withNativeObserverLease } from './native-observer.mjs';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), 'lcm-observer-'));
  roots.push(homeDir);
  mkdirSync(join(homeDir, '.lcm'), { mode: 0o700 });
  vi.stubEnv('HOME', homeDir);
  let liveToken: unknown;
  const close = vi.fn(async (token: unknown) => {
    expect(token).toBe(liveToken);
    assertBackendPublicationConsumerAccess({ homeDir, backend: 'sqlite', lockToken: token as never });
  });
  const callback = vi.fn(async () => {
    assertBackendPublicationConsumerAccess({ homeDir, backend: 'sqlite', lockToken: liveToken as never });
    return { count: 7, rows: ['original'] };
  });
  const options = {
    homeDir, backend: 'sqlite', preparing: () => false,
    admit: withBackendPublicationConsumerLockAsync,
    assertAccess: assertBackendPublicationConsumerAccess,
    ContentionError: PrivateMutationLockContentionError,
    cleanupFailures: [] as unknown[], callback,
    open: vi.fn(async (token: unknown) => { liveToken = token; return { close }; }),
  };
  return { options, close, callback, token: () => liveToken };
}
it('holds one real admission across open, unchanged result and close, then revokes it', async () => {
  const f = fixture();
  expect(await withNativeObserverLease(f.options)).toEqual({ count: 7, rows: ['original'] });
  expect(f.options.open).toHaveBeenCalledTimes(1);
  expect(f.callback).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(() => assertBackendPublicationConsumerAccess({ homeDir: f.options.homeDir, lockToken: f.token() as never })).toThrow();
  await withBackendPublicationConsumerLockAsync(f.options.homeDir, () => undefined);
});
it('rejects a real token for another root and expires tokens after callback failure', async () => {
  const f = fixture();
  const original = new Error('original native failure');
  f.callback.mockImplementation(async () => {
    expect(() => assertBackendPublicationConsumerAccess({ homeDir: join(f.options.homeDir, 'wrong'), lockToken: f.token() as never })).toThrow();
    throw original;
  });
  await expect(withNativeObserverLease(f.options)).rejects.toBe(original);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(() => assertBackendPublicationConsumerAccess({ homeDir: f.options.homeDir, lockToken: f.token() as never })).toThrow();
  await withBackendPublicationConsumerLockAsync(f.options.homeDir, () => undefined);
});
it('waits only for a real private owner before entry and retains the 2s/10ms bound', async () => {
  const f = fixture();
  let clock = 0;
  const wait = vi.fn(async (ms: number) => { expect(ms).toBe(10); clock += ms; });
  await withPrivateMutationLockAsync(join(f.options.homeDir, '.lcm.backend-publication.lock'), 'test owner', async () => {
    await expect(withNativeObserverLease({ ...f.options, now: () => clock, wait })).rejects.toBeInstanceOf(PrivateMutationLockContentionError);
    expect(f.callback).not.toHaveBeenCalled();
    expect(f.options.open).not.toHaveBeenCalled();
    expect(clock).toBe(2000);
  });
  await withNativeObserverLease(f.options);
  expect(f.callback).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledTimes(1);
});
it.each(['open', 'callback', 'close'])('never retries entered typed contention at %s', async phase => {
  const f = fixture();
  const error = new PrivateMutationLockContentionError('entered failure');
  const wait = vi.fn();
  if (phase === 'open') f.options.open.mockRejectedValue(error);
  if (phase === 'callback') f.callback.mockRejectedValue(error);
  if (phase === 'close') f.close.mockRejectedValue(error);
  await expect(withNativeObserverLease({ ...f.options, wait })).rejects.toBe(error);
  expect(wait).not.toHaveBeenCalled();
  expect(f.options.open).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledTimes(phase === 'open' ? 0 : 1);
  await withBackendPublicationConsumerLockAsync(f.options.homeDir, () => undefined);
});
it('preserves the first failure separately from cleanup failure', async () => {
  const f = fixture();
  const first = new StorageOperationError('STORAGE_OPERATION_FAILED', 'sqlite', undefined, 'conversations', 'listConversations');
  const cleanup = new Error('close failed');
  f.callback.mockRejectedValue(first);
  f.close.mockRejectedValue(cleanup);
  await expect(withNativeObserverLease(f.options)).rejects.toBe(first);
  expect(f.options.cleanupFailures).toEqual([cleanup]);
});
it('rejects HOME drift or preparing before any acquisition', async () => {
  const f = fixture();
  const admit = vi.fn(f.options.admit);
  await expect(withNativeObserverLease({ ...f.options, admit, preparing: () => true })).rejects.toThrow('observer-during-preparation');
  vi.stubEnv('HOME', join(f.options.homeDir, 'wrong'));
  await expect(withNativeObserverLease({ ...f.options, admit })).rejects.toThrow('observer-home-changed');
  expect(admit).not.toHaveBeenCalled();
});

it('uses the real SQLite factory and native list under one token, reusing only the factory', async () => {
  const f = fixture();
  const canonical = join(f.options.homeDir, 'project');
  mkdirSync(canonical);
  const identity = resolveProjectIdentity(canonical);
  const config = { backend: 'sqlite' as const };
  const factory = await createStorageBackendFactory(config, f.options.homeDir);
  const initial = await factory.openProject(identity);
  await initial.close();
  let previousToken: unknown;
  const observe = () => withNativeObserverLease({ ...f.options,
    open: async (token: unknown) => {
      if (previousToken) expect(token).not.toBe(previousToken);
      previousToken = token;
      const map = readProjectMapSnapshot(f.options.homeDir, token as never);
      expect(map[identity.id]?.canonical).toBe(canonical);
      const existing = resolveExistingProjectIdentity(canonical, token as never);
      expect(existing?.id).toBe(identity.id);
      // Exercise the actual fourth factory argument, not merely a fake token seam.
      const tokenFactory = await createStorageBackendFactory(config, f.options.homeDir, undefined, token as never);
      await tokenFactory.close();
      return factory.openExistingProject(identity, token as never);
    },
    callback: async (storage: { conversations: { listConversations(): Promise<unknown[]> } }) => storage.conversations.listConversations(),
  });
  try {
    expect(await observe()).toEqual([]);
    expect(await observe()).toEqual([]);
  } finally { await factory.close(); }
});

it('enters exactly once after the real private owner releases during acquisition', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const owner = withPrivateMutationLockAsync(join(f.options.homeDir, '.lcm.backend-publication.lock'), 'test owner', () => held);
  const wait = vi.fn(async (ms: number) => {
    expect(ms).toBe(10);
    expect(f.callback).not.toHaveBeenCalled();
    release();
    await owner;
  });
  await withNativeObserverLease({ ...f.options, wait });
  expect(wait).toHaveBeenCalledTimes(1);
  expect(f.options.open).toHaveBeenCalledTimes(1);
  expect(f.callback).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledTimes(1);
});
