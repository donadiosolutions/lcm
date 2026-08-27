/** The marker is intentionally private to this module and never serialized. */
const INTENTIONAL_ABORT = Symbol("lcm.intentionalAbort");

export type IntentionalAbortError = Error & {
  readonly name: "AbortError";
  readonly [INTENTIONAL_ABORT]?: true;
};

/** Create the one error shape used for caller-requested cancellation. */
export function createAbortError(reason?: unknown): IntentionalAbortError {
  if (reason instanceof Error && (reason as IntentionalAbortError)[INTENTIONAL_ABORT] === true) {
    return reason as IntentionalAbortError;
  }
  const message = reason instanceof Error && reason.name !== "AbortError" && reason.message.length > 0
    ? reason.message
    : "The operation was aborted";
  const error = new Error(message) as IntentionalAbortError;
  Object.defineProperty(error, "name", { value: "AbortError", configurable: true });
  Object.defineProperty(error, INTENTIONAL_ABORT, { value: true, configurable: false });
  return error;
}

/** Throw synchronously when a caller has already cancelled the operation. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason);
}

/** Identify intentional cancellation without classifying transport failures as aborts. */
export function isAbortError(error: unknown): error is IntentionalAbortError {
  return error instanceof Error
    && (error as IntentionalAbortError)[INTENTIONAL_ABORT] === true
    || error instanceof Error && error.name === "AbortError";
}

export type AbortSignalComposition = Readonly<{
  signal: AbortSignal;
  cleanup: () => void;
}>;

/**
 * Compose zero or more signals.  Every listener is removed when the first
 * source aborts or when the caller explicitly cleans up the composition.
 */
export function composeAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignalComposition {
  const controller = new AbortController();
  const sources = [...new Set(
    signals.filter((signal): signal is AbortSignal => signal !== undefined),
  )];
  const listeners = new Map<AbortSignal, () => void>();
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const [source, listener] of listeners) source.removeEventListener("abort", listener);
    listeners.clear();
  };

  const abortFrom = (source: AbortSignal): void => {
    controller.abort(createAbortError(source.reason));
    cleanup();
  };

  for (const source of sources) {
    if (source.aborted) {
      abortFrom(source);
      break;
    }
    const listener = (): void => abortFrom(source);
    listeners.set(source, listener);
    source.addEventListener("abort", listener, { once: true });
  }
  return { signal: controller.signal, cleanup };
}

/** Compatibility alias for callers that use the platform's `any` terminology. */
export const anyAbortSignal = composeAbortSignals;

export type CancellationTimerOptions = Readonly<{
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}>;

/** Wait for a bounded delay, rejecting with intentional AbortError on abort. */
export function abortableDelay(
  delayMs: number,
  signal?: AbortSignal,
  options?: CancellationTimerOptions,
): Promise<void> {
  throwIfAborted(signal);
  const setTimer = options?.setTimeout ?? setTimeout;
  const clearTimer = options?.clearTimeout ?? clearTimeout;
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    return Promise.reject(new RangeError("delay must be a non-negative finite number"));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) {
        const handle = timer;
        timer = undefined;
        clearTimer(handle);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => settle(() => reject(createAbortError(signal?.reason)));
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (settled) return;
    try {
      timer = setTimer(() => settle(resolve), delayMs);
      // A deterministic timer seam may invoke its callback synchronously,
      // before the assignment above has completed.  Clear that returned
      // handle explicitly so the settled operation never retains a timer.
      if (settled && timer !== undefined) {
        const handle = timer;
        timer = undefined;
        clearTimer(handle);
      }
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error("delay timer failed")));
    }
  });
}

/** Race an existing operation against intentional caller cancellation. */
export function waitForAbortable<T>(
  operation: PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) return Promise.resolve(operation);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => settle(() => reject(createAbortError(signal.reason)));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    );
  });
}

/** Compatibility alias used by retry and transport callers. */
export const waitWithAbort = waitForAbortable;
