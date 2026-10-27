/**
 * Complete delivery of hook output before the process exits.
 *
 * Node writes to pipes asynchronously, and `process.exit()` discards whatever
 * is still queued. A hook that wrote its output and exited in the same tick
 * therefore lost everything past the first pipe chunk (#1636). Awaiting this
 * helper before `exit()` makes the output complete, whatever stdout is.
 */

/** The part of a writable stream that hook output delivery uses. */
export type HookOutputStream = Readonly<{
  write: (chunk: string, callback: (error?: Error | null) => void) => unknown;
  on: (event: "error", listener: (error: Error) => void) => unknown;
  off: (event: "error", listener: (error: Error) => void) => unknown;
}>;

/**
 * Writes `text` to `stream` and resolves once the stream has flushed it or
 * failed to (for example EPIPE when the reader has gone away). It never
 * rejects, so the caller's exit code is preserved, and it settles exactly once.
 * The error listener stays attached until the stream has emitted the error
 * that follows a failed write, so that emission cannot crash the process, and
 * is removed afterwards so repeated calls do not accumulate listeners.
 */
export function writeHookOutput(stream: HookOutputStream, text: string): Promise<void> {
  if (!text) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      stream.off("error", settle);
      resolve();
    };
    stream.on("error", settle);
    try {
      stream.write(text, (error) => {
        // A failed write emits "error" right after this callback. Wait for it
        // (or the next turn of the event loop, which follows it) before
        // releasing the listener.
        if (error) setImmediate(settle);
        else settle();
      });
    } catch {
      settle();
    }
  });
}
