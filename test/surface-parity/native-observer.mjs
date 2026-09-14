import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Only admission before entry may retry. The opaque production token owns the
// entire open/read/close interval; it never escapes into a cached project.
export async function withNativeObserverLease({ homeDir, backend, preparing, admit, assertAccess,
  open, callback, cleanupFailures, ContentionError, now = () => performance.now(), wait = delay }) {
  const root = resolve(homeDir, '.lcm');
  const assertHome = () => {
    assert.ok(process.env.HOME && resolve(process.env.HOME, '.lcm') === root
      && resolve(homedir(), '.lcm') === root, 'surface-worker:observer-home-changed');
  };
  assert.ok(!preparing(), 'surface-worker:observer-during-preparation');
  assertHome();
  const deadline = now() + 2000;
  for (;;) {
    let entered = false;
    try {
      return await admit(homeDir, async token => {
        entered = true;
        assertHome();
        assertAccess({ homeDir, backend, lockToken: token });
        const storage = await open(token);
        assert.ok(storage, 'surface-worker:existing-project');
        let failed = false;
        let firstError;
        let result;
        try { result = await callback(storage); }
        catch (error) { failed = true; firstError = error; }
        try { await storage.close(token); }
        catch (error) {
          cleanupFailures.push(error);
          if (!failed) { failed = true; firstError = error; }
        }
        try {
          assertHome();
          assertAccess({ homeDir, backend, lockToken: token });
        } catch (error) {
          if (!failed) { failed = true; firstError = error; }
          else cleanupFailures.push(error);
        }
        if (failed) throw firstError;
        return result;
      });
    } catch (error) {
      if (entered || !(error instanceof ContentionError) || now() >= deadline) throw error;
      await wait(10);
      assertHome();
      assert.ok(!preparing(), 'surface-worker:observer-during-preparation');
    }
  }
}
