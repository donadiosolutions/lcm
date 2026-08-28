import { createAbortError } from "./cancellation.js";

type QueueEntry = {
  chain: Promise<void>;
  pending: number;
};

const queues = new Map<string, QueueEntry>();

/**
 * Serialize work for one project while allowing cancellation before callback
 * entry. Once a callback starts, it owns settlement and may observe the signal
 * itself at its operation-specific checkpoints.
 */
export function enqueue<T>(projectId: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const entry = queues.get(projectId) ?? { chain: Promise.resolve(), pending: 0 };
  entry.pending += 1;
  queues.set(projectId, entry);

  let canceled = false;
  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const onAbort = (): void => {
    canceled = true;
    rejectResult(createAbortError(signal?.reason));
  };
  if (signal !== undefined) {
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  const run = async (): Promise<void> => {
    try {
      if (canceled || signal?.aborted) {
        signal?.removeEventListener("abort", onAbort);
        rejectResult(createAbortError(signal?.reason));
        return;
      }

      signal?.removeEventListener("abort", onAbort);
      try {
        const value = await fn();
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    } finally {
      entry.pending -= 1;
      if (entry.pending === 0 && queues.get(projectId) === entry) queues.delete(projectId);
    }
  };

  // `run` settles the caller's result for every ordinary path. Keeping the
  // slot itself also preserves the rejection handler for an unexpected outer
  // failure, so one failure cannot block the next operation for the project.
  const slot = entry.chain.then(run, run);
  entry.chain = slot;
  return result;
}
