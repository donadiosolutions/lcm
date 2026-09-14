import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// An observed admission precondition, not a guarantee against future writers.
// The actual token is released by admit() before the single tool invocation.
export async function invokeAfterConsumerAdmission({ admit, observeAuthority, expectedAuthority, invoke, ContentionError,
  now = () => performance.now(), wait = delay }) {
  const deadline = now() + 2000;
  for (;;) {
    try {
      admit(() => assert.ok(JSON.stringify(observeAuthority()) === JSON.stringify(expectedAuthority),
        'surface-mcp:readiness-authority-changed'));
      break;
    } catch (error) {
      if (!(error instanceof ContentionError) || now() >= deadline) throw error;
      await wait(10);
    }
  }
  return invoke();
}
