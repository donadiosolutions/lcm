import { AsyncLocalStorage } from "node:async_hooks";
import { PrivateMutationLockContentionError } from "../private-mutation-lock.js";
import { createAbortError, throwIfAborted } from "./cancellation.js";

/** Serialize daemon-owned acquisitions without granting publication authority. */
export function createPublicationQueue() {
  const context = new AsyncLocalStorage<{ active: boolean }>();
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T> | T, signal: AbortSignal): Promise<T> => {
    if (context.getStore()?.active) {
      throw new PrivateMutationLockContentionError(
        "backend publication mutation is already in progress (nested daemon admission); retry after the active operation completes",
      );
    }
    throwIfAborted(signal);
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const onAbort = () => rejectResult(createAbortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    const execution = tail.then(async () => {
      // Remove before callback entry, including synchronous aborts inside it.
      signal.removeEventListener("abort", onAbort);
      throwIfAborted(signal);
      const marker = { active: true };
      return context.run(marker, async () => {
        try {
          return await operation();
        } finally {
          marker.active = false;
        }
      });
    });
    // The slot follows actual settlement, never the caller's abort race.
    tail = execution.then(resolveResult, rejectResult);
    return result;
  };
}
