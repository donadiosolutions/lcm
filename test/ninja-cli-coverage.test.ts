import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NinjaRenderer } from "../src/cli/pipeline-runner.js";
import { makeProgressState, type ProgressState } from "../src/cli/progress-state.js";
import { renderFrame, type RenderOpts } from "../src/cli/render-frame.js";
import { printSummary } from "../src/cli/render-summary.js";
import type { CompactProgressEvent } from "../src/batch-compact.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function opts(overrides: Partial<RenderOpts> = {}): RenderOpts {
  return { isTTY: true, width: 80, color: false, verbose: false, ...overrides };
}

class AnsiScreen {
  private readonly rows: string[] = [""];
  private row = 0;
  private column = 0;

  write(chunk: string): void {
    for (let index = 0; index < chunk.length;) {
      const rest = chunk.slice(index);
      const csi = /^\u001b\[([0-9;]*)([A-Za-z])/u.exec(rest);
      if (csi) {
        const amount = Number(csi[1] || "1");
        if (csi[2] === "A") this.row = Math.max(0, this.row - amount);
        else if (csi[2] === "K" && csi[1] === "2") this.rows[this.row] = "";
        index += csi[0].length;
        continue;
      }
      const codePoint = chunk[index]!;
      if (codePoint === "\r") {
        this.column = 0;
      } else if (codePoint === "\n") {
        this.row += 1;
        this.column = 0;
        this.rows[this.row] ??= "";
      } else {
        const line = this.rows[this.row] ?? "";
        this.rows[this.row] = `${line.slice(0, this.column)}${codePoint}${line.slice(this.column + 1)}`;
        this.column += 1;
      }
      index += 1;
    }
  }

  visibleLines(): string[] {
    return this.rows.map(line => line.trimEnd()).filter(line => line.length > 0);
  }
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

  it("sanitizes completed-session and provider text in every frame mode", () => {
    const state = completedState({
      current: undefined,
      lastResult: {
        sessionId: "ses\u001b[31m\nsion",
        messages: 1,
        tokensBefore: 10,
        tokensAfter: 5,
        provider: "pro\u001b]8;;https://invalid\u0007vider",
        elapsed: 1,
      },
    });
    for (const renderOpts of [opts({ isTTY: false }), opts({ verbose: true }), opts()]) {
      const output = renderFrame(state, renderOpts, 0);
      expect(output).toContain("ses sion");
      expect(output).toContain("provider");
      expect(output).not.toContain("\u001b");
      expect(output).not.toContain("https://invalid");
    }
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

  it("preserves native TTY lifecycle lines above immediate and later frame redraws", () => {
    const screen = new AnsiScreen();
    const output = {
      columns: 100,
      write: (chunk: string | Uint8Array) => {
        screen.write(String(chunk));
        return true;
      },
    };
    const state = makeProgressState({ phases: [{ name: "Compact", status: "active" }], total: 2 });
    const renderer = new NinjaRenderer({ state, renderOpts: opts({ width: 100 }), output });
    renderer.start();
    renderer.handleEvent({ type: "discovery-start", total: 1 });
    renderer.handleEvent({
      type: "discovery-item-start",
      index: 1,
      total: 1,
      projectId: "a".repeat(64),
      project: "/project",
    });
    renderer.handleEvent({ type: "discovery-clear" });
    for (const [conversationId, sessionId, outcome] of [
      [41, "session-one", "done"],
      [42, "session-two", "skipped"],
    ] as const) {
      const identity = { project: "/project", sessionId, conversationId };
      renderer.handleEvent({
        type: "session-start",
        identity,
        messages: 9,
        tokens: 250,
        startedAt: NOW.getTime(),
      });
      renderer.handleEvent({
        type: "session-terminal",
        identity,
        outcome,
        messages: 9,
        tokensBefore: 250,
        tokensAfter: outcome === "done" ? 50 : undefined,
        elapsed: 10,
      });
    }
    vi.advanceTimersByTime(124);
    renderer.stop();

    const visible = screen.visibleLines();
    expect(visible.filter(line => line.includes("scanning project 1/1 /project"))).toHaveLength(1);
    expect(visible.filter(line => line.includes("done /project") && line.includes("session-one") && line.includes("conversation 41"))).toHaveLength(1);
    expect(visible.filter(line => line.includes("skipped /project") && line.includes("session-two") && line.includes("conversation 42"))).toHaveLength(1);
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
    expect(output).toContain("\u001b[31mfailure total 1\u001b[0m");
    expect(output).toContain("[dry-run]");
    expect(output).toContain("[░░░░░░░░░░░░░░░░░░░░░░] 0%");
    expect(output).toContain("  …");
  });

  it("renders a narrow terminal without a progress bar and with an uncolored failure", () => {
    const state = makeProgressState({ total: 2 });
    state.phaseErrors.push({ phase: "Promote", target: "/project", message: "failed" });
    const output = renderFrame(state, opts({ width: 20 }), 0);
    expect(output).toContain("failure total 1");
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
      total: 3,
      completed: 2,
      errors: [{ sessionId: "bro\u001b[31m\nken", message: "network\u001b]8;;https://invalid\u0007 failed" }],
      phaseErrors: [
        { phase: "Promote", message: "daemon unavailable" },
        { phase: "Pro\u001b[31m\nmote", target: "/pro\u001b[31m\nject", message: "request\nfailed" },
      ],
      messagesIn: 1_234,
      tokensIn: 1_000_000,
      tokensOut: 1_000,
      dag: { nodes: 10, newNodes: 2, depth: 3, memoriesPromoted: 4 },
      startedAt: NOW.getTime() - 2_500,
    });
    printSummary(state, opts());
    const output = writes.join("");
    expect(output).toContain("● Import  →  ● Compact          Failed ✗");
    expect(output).toContain("[██████████████████████] 100%  1,234 msgs  ~1.0M → ~1.0k tokens, 1000.0×");
    expect(output).toContain("Sessions       3 processed");
    expect(output).toContain("DAG nodes      10  (+2 new)");
    expect(output).toContain("DAG depth      3");
    expect(output).toContain("Memories       4 promoted");
    expect(output).toContain("Total time     2.5s");
    expect(output).toContain("Failed         1");
    expect(output).toContain("Phase failed   2");
    expect(output).toContain("Failure total  3");
    expect(output).toContain("bro ken: network failed");
    expect(output).toContain("Promote: daemon unavailable");
    expect(output).toContain("Pro mote (/pro ject): request failed");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("https://invalid");
  });

  it("prints an empty narrow summary with a 100 percent default", () => {
    const state = makeProgressState({ phases: [{ name: "Compact", status: "done" }] });
    state.startedAt = NOW.getTime();
    printSummary(state, opts({ width: 40 }));
    const output = writes.join("");
    expect(output).toContain("[████████████████████] 100%");
    expect(output).toContain("● Compact          Done ✓");
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

  it.each([
    ["native TTY", opts()],
    ["verbose TTY", opts({ verbose: true })],
    ["non-TTY", opts({ isTTY: false })],
    ["captured ANSI", opts({ color: true })],
  ] as const)("prints one canonical final failure total in %s summaries", (_name, renderOptions) => {
    writes.length = 0;
    const state = makeProgressState({ phases: [{ name: "Compact", status: "done" }], total: 1 });
    state.errors.push({
      project: "/project",
      sessionId: "session-one",
      conversationId: 41,
      message: "request failed",
    });

    printSummary(state, renderOptions);

    const normalized = writes.join("")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
      .replace(/\r/gu, "")
      .replace(/\s+/gu, " ");
    expect(normalized.match(/failure total 1/giu)).toHaveLength(1);
    expect(normalized.match(/\/project · session-one · conversation 41/gu)).toHaveLength(1);
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

  it("calls onReady once after setup across renderer restarts", () => {
    const onReady = vi.fn();
    const renderer = new NinjaRenderer({
      state: makeProgressState({ total: 1 }),
      renderOpts: opts({ isTTY: false }),
      onReady,
    });

    renderer.start();
    expect(onReady).toHaveBeenCalledOnce();
    renderer.stop();
    renderer.start();
    renderer.stop();

    expect(onReady).toHaveBeenCalledOnce();
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

  it.each([
    ["native TTY", opts()],
    ["verbose TTY", opts({ verbose: true })],
    ["non-TTY", opts({ isTTY: false })],
  ] as const)("owns sanitized discovery and terminal identity in %s", (name, renderOptions) => {
    const state = makeProgressState({ phases: [{ name: "Compact", status: "active" }], total: 2 });
    const renderer = new NinjaRenderer({ state, renderOpts: { ...renderOptions } });
    renderer.start();
    const events: CompactProgressEvent[] = [
      { type: "discovery-start", total: 1 },
      {
        type: "discovery-item-start",
        index: 1,
        total: 1,
        projectId: "a".repeat(64),
        project: `/project\u001b[31m\n${"p".repeat(100)}`,
      },
      { type: "discovery-clear" },
      {
        type: "session-start",
        identity: {
          project: "/project-one",
          sessionId: "session\none",
          conversationId: 41,
          sourceLocator: `source\u001b]8;;https://invalid\u0007-${"s".repeat(100)}`,
        },
        messages: 9,
        tokens: 250,
        startedAt: NOW.getTime(),
      },
      {
        type: "session-terminal",
        identity: {
          project: "/project-one",
          sessionId: "session\none",
          conversationId: 41,
          sourceLocator: "source-one",
        },
        outcome: "failed",
        messages: 9,
        tokensBefore: 250,
        message: `request\nfailed ${"m".repeat(200)}`,
        elapsed: 10,
      },
      {
        type: "session-start",
        identity: { project: "/project-two", sessionId: "session-two", conversationId: 42 },
        messages: 10,
        tokens: 300,
        startedAt: NOW.getTime(),
      },
      {
        type: "session-terminal",
        identity: { project: "/project-two", sessionId: "session-two", conversationId: 42 },
        outcome: "done",
        messages: 10,
        tokensBefore: 300,
        tokensAfter: 30,
        provider: `provider\n${"x".repeat(100)}`,
        elapsed: 20,
      },
    ];
    for (const event of events) renderer.handleEvent(event);
    renderer.stop();
    renderer.printSummary();

    const captured = writes.join("");
    const normalized = captured
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
      .replace(/\r/gu, "");
    expect(normalized).toContain("scanning project 1/1");
    expect(normalized).toContain("/project");
    expect(normalized).toContain("session one");
    expect(normalized).toContain("conversation 41");
    expect(normalized).toContain("source-one");
    expect(normalized).toContain("session-two");
    expect(normalized).toContain("conversation 42");
    expect(normalized).toContain("done");
    // Contract (reviewer thread 4028334454): a per-item session-terminal line
    // reports only that item's own outcome. The cumulative failure total must
    // not be appended there, even for an item that comes after a failure.
    const doneLine = normalized
      .split("\n")
      .find(line => /\bdone\b/u.test(line) && line.includes("session-two"));
    expect(doneLine).toBeDefined();
    expect(doneLine).not.toContain("failure total");
    // The cumulative total still belongs on the live TTY header (native,
    // non-verbose mode only) and in the final summary, which is always
    // rendered here via the trailing printSummary() call.
    if (name === "native TTY") {
      expect(normalized).toContain("failure total 1");
    }
    expect(normalized).toContain("Failure total  1");
    expect(normalized).not.toContain("https://invalid");
    expect(state.discovery).toBeUndefined();
    expect(state.errors).toEqual([
      expect.objectContaining({
        project: "/project-one",
        sessionId: "session\none",
        conversationId: 41,
        message: expect.stringContaining("request"),
      }),
    ]);
    const failedSection = normalized.slice(normalized.lastIndexOf("Failed:"));
    expect(failedSection.match(/session one/gu)).toHaveLength(1);
    expect(failedSection).not.toContain("failure total");
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

  it("uses the default signal handler when no external callback is supplied", () => {
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.on);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    const renderer = new NinjaRenderer({ state: makeProgressState({ total: 1 }), renderOpts: opts({ isTTY: false }) });
    renderer.start();
    expect(() => handlers.get("SIGTERM")?.()).toThrow("exit:143");
    expect(exit).toHaveBeenCalledWith(143);
    renderer.stop();
  });

  it("delegates command signals without exiting when an external lifecycle owns drain", () => {
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.on);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    const onSignal = vi.fn();
    const state = makeProgressState({ total: 1 });
    const renderer = new NinjaRenderer({
      state,
      renderOpts: opts({ isTTY: false }),
      handleSignals: false,
      onSignal,
    });

    renderer.start();
    expect(handlers.has("SIGINT")).toBe(false);
    expect(handlers.has("SIGTERM")).toBe(false);
    expect(() => handlers.get("SIGINT")?.()).not.toThrow();
    expect(onSignal).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    renderer.stop();
  });

  it("delegates SIGINT and SIGTERM to a command lifecycle without immediate exit", () => {
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.on);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    const onSignal = vi.fn();
    const state = makeProgressState({ total: 1 });
    const renderer = new NinjaRenderer({
      state,
      renderOpts: opts({ isTTY: false }),
      onSignal,
    });

    renderer.start();
    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);
    expect(() => handlers.get("SIGINT")?.()).not.toThrow();
    expect(() => handlers.get("SIGTERM")?.()).not.toThrow();
    expect(onSignal).toHaveBeenNthCalledWith(1, "SIGINT");
    expect(onSignal).toHaveBeenNthCalledWith(2, "SIGTERM");
    expect(state.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    renderer.stop();
  });

  it("records a phase-failure event with a target project and reports the running failure total", () => {
    const state = makeProgressState({ total: 1 });
    const renderer = new NinjaRenderer({ state, renderOpts: opts({ isTTY: false }) });
    renderer.handleEvent({ type: "phase-failure", phase: "Compact", project: "/project-one", message: "daemon unavailable" });
    expect(state.phaseErrors).toEqual([
      { phase: "Compact", target: "/project-one", message: "daemon unavailable" },
    ]);
    const captured = writes.join("");
    expect(captured).toContain("  failed /project-one: daemon unavailable (failure total 1)\n");
  });

  it("records a phase-failure event without a project and omits the target from state and the line", () => {
    const state = makeProgressState({ total: 1 });
    state.phaseErrors.push({ phase: "Import", message: "already failed once" });
    const renderer = new NinjaRenderer({ state, renderOpts: opts({ isTTY: false }) });
    renderer.handleEvent({ type: "phase-failure", phase: "Import", message: "project discovery failed" });
    expect(state.phaseErrors).toEqual([
      { phase: "Import", message: "already failed once" },
      { phase: "Import", message: "project discovery failed" },
    ]);
    expect(state.phaseErrors[1]).not.toHaveProperty("target");
    const captured = writes.join("");
    expect(captured).toContain("  failed: project discovery failed (failure total 2)\n");
  });

  it("falls back to the default failure message when a failed session-terminal event omits one", () => {
    const state = makeProgressState({ total: 1 });
    const renderer = new NinjaRenderer({ state, renderOpts: opts({ isTTY: false }) });
    const identity = { project: "/project", sessionId: "session-one", conversationId: 7 };
    renderer.handleEvent({
      type: "session-terminal",
      identity,
      outcome: "failed",
      messages: 3,
      tokensBefore: 100,
      elapsed: 5,
    });
    expect(state.errors).toEqual([
      expect.objectContaining({
        project: "/project",
        sessionId: "session-one",
        conversationId: 7,
        message: "compaction request failed",
      }),
    ]);
    expect(state.lastResult).toEqual(
      expect.objectContaining({ project: "/project", sessionId: "session-one", conversationId: 7, outcome: "failed" }),
    );
  });

  it("skips the ninja frame write when the renderer redraws before start() clears the first-frame flag", () => {
    const state = makeProgressState({ total: 1 });
    const renderer = new NinjaRenderer({ state, renderOpts: opts() });
    renderer.handleEvent({ type: "discovery-clear" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain("[3A");
    expect(writes[0]).not.toContain("");
    expect(writes[0]).toContain("  …");
  });
});
