export const TERMINAL_STDIN_MAX_BYTES = 1024 * 1024;

export type TerminalStdinResult =
  | Readonly<{ kind: "ok"; text: string }>
  | Readonly<{ kind: "deadline-exhausted" | "invalid-input" }>;

type TerminalInput = Pick<NodeJS.ReadableStream, "on" | "off"> & { destroy: () => unknown };

/**
 * Read a terminal hook payload. Success requires EOF within the caller's
 * signal and at most one MiB; on timeout, overflow or a stream error the input
 * is destroyed and the partial data is discarded without being parsed.
 */
export function readTerminalStdin(input: TerminalInput, signal: AbortSignal): Promise<TerminalStdinResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    // Removing the listeners first means each outcome can settle only once.
    const settle = (result: TerminalStdinResult, destroy: boolean): void => {
      signal.removeEventListener("abort", onAbort);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      chunks.length = 0;
      if (destroy) input.destroy();
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > TERMINAL_STDIN_MAX_BYTES) settle({ kind: "invalid-input" }, true);
      else chunks.push(chunk);
    };
    const onEnd = (): void => {
      const text = Buffer.concat(chunks).toString("utf-8");
      settle({ kind: "ok", text }, false);
    };
    const onError = (): void => settle({ kind: "invalid-input" }, true);
    const onAbort = (): void => settle({ kind: "deadline-exhausted" }, true);
    if (signal.aborted) {
      settle({ kind: "deadline-exhausted" }, true);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}

