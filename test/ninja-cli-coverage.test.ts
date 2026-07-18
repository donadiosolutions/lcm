import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NinjaRenderer } from "../src/cli/pipeline-runner.js";
import { makeProgressState, type ProgressState } from "../src/cli/progress-state.js";
import { renderFrame, type RenderOpts } from "../src/cli/render-frame.js";
import { printSummary } from "../src/cli/render-summary.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function opts(overrides: Partial<RenderOpts> = {}): RenderOpts {
  return { isTTY: true, width: 80, color: false, verbose: false, ...overrides };
}

function completedState(overrides: Partial<ProgressState> = {}): ProgressState {
  return {
    ...makeProgressState({ total: 2 }),
    completed: 1,
    messagesIn: 12,
    tokensIn: 2_000,
    tokensOut: 200,
    lastResult: {
      sessionId: "session-one",
      messages: 12,
      tokensBefore: 2_000,
      tokensAfter: 200,
      elapsed: 1_000,
    },
    ...overrides,
  };
}

describe("renderFrame coverage boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  it("formats non-TTY million-token, provider, and minute boundaries exactly", () => {
    const state = completedState({
      lastResult: {
        sessionId: "large",
        messages: 1,
        tokensBefore: 1_000_000,
        tokensAfter: 1_000,
        provider: "OpenAI",
        elapsed: 60_000,
      },
    });
    expect(renderFrame(state, opts({ isTTY: false }))).toBe(
      "  [1/2] large: 1 msgs, ~1.0M → ~1.0k [OpenAI] 1.0m\n",
    );
  });

  it.each([
    [10, "\u001b[32m10.0×\u001b[0m", "green"],
    [5, "\u001b[33m5.0×\u001b[0m", "yellow"],
    [2, "2.0×", "plain"],
  ] as const)("colors verbose compression ratio %s as %s", (ratio, expected) => {
    const state = completedState({
      lastResult: {
        sessionId: "ratio",
        messages: 2,
        tokensBefore: 1_000,
        tokensAfter: 1_000 / ratio,
        provider: "provider",
        elapsed: 1_000,
      },
    });
    const output = renderFrame(state, opts({ verbose: true, color: true }));
    expect(output).toContain(expected);
    expect(output).toContain("  [provider]");
  });

  it("renders verbose tokens without reduction, ratio, or provider", () => {
    const state = completedState({
      lastResult: { sessionId: "same", messages: 1, tokensBefore: 500, tokensAfter: 500, elapsed: 0 },
    });
    expect(renderFrame(state, opts({ verbose: true }))).toBe("  ✓ same  1 msgs  500  0.0s\n");
  });

  it("renders zero-total, failures, dry run, empty metrics, and idle detail", () => {
    const state = makeProgressState({ total: 0, dryRun: true });
    state.errors.push({ sessionId: "bad", message: "failed" });
    const output = renderFrame(state, opts({ color: true }), 0);
    expect(output).toContain("\u001b[31m1 failed\u001b[0m");
    expect(output).toContain("[dry-run]");
    expect(output).toContain("[░░░░░░░░░░░░░░░░░░░░░░] 0%");
    expect(output).toContain("  …");
  });

  it("renders a narrow terminal without a progress bar and with an uncolored failure", () => {
    const state = makeProgressState({ total: 2 });
    state.errors.push({ sessionId: "bad", message: "failed" });
    const output = renderFrame(state, opts({ width: 20 }), 0);
    expect(output).toContain("1 failed");
    expect(output).not.toContain("[");
  });

  it("renders current elapsed time and compressed colored running totals", () => {
    const state = completedState({
      current: { sessionId: "current", messages: 3, tokens: 10, startedAt: NOW.getTime() - 60_000 },
      tokensIn: 1_000_000,
      tokensOut: 100_000,
    });
    const output = renderFrame(state, opts({ color: true }), 0);
    expect(output).toContain("~1.0M → ~100.0k tokens");
    expect(output).toContain("\u001b[32m10.0×\u001b[0m");
    expect(output).toContain("processing...  1.0m");
  });

  it("renders last-result reduction and provider in the live detail line", () => {
    const state = completedState({ current: undefined });
    state.lastResult!.provider = "OpenAI";
    const output = renderFrame(state, opts(), 0);
    expect(output).toContain("session-one  12 msgs  ~2.0k → 200");
    expect(output).toContain("[OpenAI]");
  });

  it("renders last-result tokens without a provider when no reduction occurred", () => {
    const state = completedState({
      current: undefined,
      lastResult: { sessionId: "last", messages: 1, tokensBefore: 500, elapsed: 500 },
      tokensIn: 500,
      tokensOut: 0,
    });
    const output = renderFrame(state, opts(), 0);
    expect(output).toContain("last  1 msgs  500  0.5s");
    expect(output).toContain("(500 tokens)");
  });
});

describe("printSummary", () => {
  let writes: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    writes = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("prints full phases, compression, DAG, promoted memories, and errors", () => {
    const state = completedState({
      phases: [{ name: "Import", status: "done" }, { name: "Compact", status: "done" }],
      completed: 2,
      errors: [{ sessionId: "broken", message: "network failed" }],
      messagesIn: 1_234,
      tokensIn: 1_000_000,
      tokensOut: 1_000,
      dag: { nodes: 10, newNodes: 2, depth: 3, memoriesPromoted: 4 },
      startedAt: NOW.getTime() - 2_500,
    });
    printSummary(state, opts());
    const output = writes.join("");
    expect(output).toContain("● Import  →  ● Compact          Done ✓");
    expect(output).toContain("[██████████████████████] 67%  1,234 msgs  ~1.0M → ~1.0k tokens, 1000.0×");
    expect(output).toContain("Sessions     3 processed");
    expect(output).toContain("DAG nodes    10  (+2 new)");
    expect(output).toContain("DAG depth    3");
    expect(output).toContain("Memories     4 promoted");
    expect(output).toContain("Total time   2.5s");
    expect(output).toContain("Failed       1");
    expect(output).toContain("broken: network failed");
  });

  it("prints an empty narrow summary with a 100 percent default", () => {
    const state = makeProgressState({});
    state.startedAt = NOW.getTime();
    printSummary(state, opts({ width: 40 }));
    const output = writes.join("");
    expect(output).toContain("[████████████████████] 100%");
    expect(output).toContain("Sessions    0 processed");
    expect(output).toContain("Total time  0.0s");
    expect(output).not.toContain("Compression");
    expect(output).not.toContain("Failed:");
  });

  it("prints aborted phases, uncompressed tokens, and omits zero promoted memories", () => {
    const state = completedState({
      phases: [{ name: "Import", status: "active" }],
      aborted: true,
      tokensIn: 500,
      tokensOut: 0,
      messagesIn: 0,
      dag: { nodes: 1, newNodes: 0, depth: 1, memoriesPromoted: 0 },
      startedAt: NOW.getTime(),
    });
    printSummary(state, opts());
    const output = writes.join("");
    expect(output).toContain("Aborted");
    expect(output).toContain("500 tokens");
    expect(output).not.toContain("Memories");
  });
});

describe("NinjaRenderer lifecycle", () => {
  let writes: string[];
  let stdoutColumnsDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    writes = [];
    stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    if (stdoutColumnsDescriptor) {
      Object.defineProperty(process.stdout, "columns", stdoutColumnsDescriptor);
    } else {
      delete (process.stdout as Partial<typeof process.stdout>).columns;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops safely before start and writes the first TTY frame without cursor movement", () => {
    const renderer = new NinjaRenderer({ state: makeProgressState({ total: 1 }), renderOpts: opts() });
    renderer.stop();
    expect(writes.join("")).not.toContain("\u001b[3A");
  });

  it("runs and stops the TTY loop, handles resize, updates opts, and prints summary", () => {
    const state = completedState();
    const rendererOpts = opts();
    const renderer = new NinjaRenderer({ state, renderOpts: rendererOpts });
    renderer.start();
    expect(writes.shift()).toBe("\n\n\n");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: undefined });
    process.emit("SIGWINCH");
    expect(rendererOpts.width).toBe(80);
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 100 });
    process.emit("SIGWINCH");
    expect(rendererOpts.width).toBe(100);
    vi.advanceTimersByTime(62);
    expect(writes.join("")).toContain("\u001b[3A");
    state.lastResult = undefined;
    renderer.updateOpts({ isTTY: false });
    vi.advanceTimersByTime(62);
    renderer.updateOpts({ isTTY: true, color: true });
    expect(rendererOpts.color).toBe(true);
    renderer.stop();
    renderer.stop();
    renderer.printSummary();
    expect(writes.join("")).toContain("Sessions");
  });

  it("emits session lines for non-TTY and verbose modes", () => {
    const state = completedState();
    const nonTty = new NinjaRenderer({ state, renderOpts: opts({ isTTY: false }) });
    nonTty.start();
    nonTty.sessionDone();
    nonTty.stop();
    const verbose = new NinjaRenderer({ state, renderOpts: opts({ verbose: true }) });
    verbose.start();
    verbose.sessionDone();
    verbose.stop();
    expect(writes.join("")).toContain("[1/2]");
    expect(writes.join("")).toContain("✓ session-one");
  });

  it("does not write an empty non-TTY session frame", () => {
    const renderer = new NinjaRenderer({
      state: makeProgressState({ total: 1 }),
      renderOpts: opts({ isTTY: false }),
    });
    renderer.sessionDone();
    expect(writes).toEqual([]);
  });

  it("lets the TTY render loop own session completion output", () => {
    const renderer = new NinjaRenderer({ state: completedState(), renderOpts: opts() });
    renderer.sessionDone();
    expect(writes).toEqual([]);
  });

  it("handles SIGINT with an aborted partial summary and exit code 130", () => {
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.on);
    vi.spyOn(process, "removeListener").mockImplementation(((event: string) => {
      handlers.delete(event);
      return process;
    }) as typeof process.removeListener);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    const state = makeProgressState({ total: 1 });
    const renderer = new NinjaRenderer({ state, renderOpts: opts({ isTTY: false }) });
    renderer.start();
    expect(() => handlers.get("SIGINT")?.()).toThrow("exit:130");
    expect(state.aborted).toBe(true);
    expect(exit).toHaveBeenCalledWith(130);
    expect(writes.join("")).toContain("Sessions");
  });
});
