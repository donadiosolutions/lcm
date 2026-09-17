import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NinjaRenderer } from "../../src/cli/pipeline-runner.js";
import { makeProgressState } from "../../src/cli/progress-state.js";
import { renderFrame, type RenderOpts } from "../../src/cli/render-frame.js";
import { printSummary } from "../../src/cli/render-summary.js";
import type { CompactItemOutcome, CompactProgressEvent } from "../../src/batch-compact.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function opts(overrides: Partial<RenderOpts> = {}): RenderOpts {
  return { isTTY: false, width: 80, color: false, verbose: false, ...overrides };
}

describe("NinjaRenderer session-terminal output contract", () => {
  let writes: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    writes = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeOutput(): { columns: number; write: (chunk: string | Uint8Array) => boolean } {
    return {
      columns: 80,
      write: (chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      },
    };
  }

  it("does not repeat the cumulative failure total on a later done/unchanged/skipped/dry-run/failed line after a failure", () => {
    const state = makeProgressState({ total: 6 });
    const renderer = new NinjaRenderer({ state, renderOpts: opts(), output: fakeOutput() });
    renderer.start();

    // Establish a nonzero cumulative failure total via a session failure.
    renderer.handleEvent({
      type: "session-start",
      identity: { project: "/project", sessionId: "session-zero", conversationId: 1 },
      messages: 1,
      tokens: 10,
      startedAt: NOW.getTime(),
    });
    renderer.handleEvent({
      type: "session-terminal",
      identity: { project: "/project", sessionId: "session-zero", conversationId: 1 },
      outcome: "failed",
      messages: 1,
      tokensBefore: 10,
      message: "provider unavailable",
      elapsed: 5,
    });
    writes.length = 0; // Only inspect lines emitted after the cumulative total became nonzero.

    const outcomes: readonly CompactItemOutcome[] = ["done", "unchanged", "skipped", "dry-run", "failed"];
    let conversationId = 2;
    for (const outcome of outcomes) {
      const sessionId = `session-${outcome}`;
      const identity = { project: "/project", sessionId, conversationId };
      renderer.handleEvent({ type: "session-start", identity, messages: 3, tokens: 30, startedAt: NOW.getTime() });
      renderer.handleEvent({
        type: "session-terminal",
        identity,
        outcome,
        messages: 3,
        tokensBefore: 30,
        elapsed: 1,
      });
      conversationId += 1;
    }
    renderer.stop();

    const captured = writes.join("");
    const terminalLines = captured
      .split("\n")
      .filter(line => outcomes.some(outcome => line.trim().startsWith(outcome)));
    expect(terminalLines).toHaveLength(outcomes.length);
    for (const line of terminalLines) {
      expect(line).not.toContain("failure total");
    }
  });

  it("keeps the cumulative failure total in the failure event, the live header, and the final summary", () => {
    const state = makeProgressState({ total: 2 });
    const renderer = new NinjaRenderer({ state, renderOpts: opts(), output: fakeOutput() });
    renderer.start();

    const identity = { project: "/project", sessionId: "session-one", conversationId: 1 };
    renderer.handleEvent({ type: "session-start", identity, messages: 1, tokens: 10, startedAt: NOW.getTime() });
    renderer.handleEvent({
      type: "session-terminal",
      identity,
      outcome: "failed",
      messages: 1,
      tokensBefore: 10,
      message: "provider unavailable",
      elapsed: 5,
    });

    // The failure event itself still reports the running cumulative total.
    renderer.handleEvent({ type: "phase-failure", phase: "Compact", project: "/broken", message: "daemon unavailable" });
    const captured = writes.join("");
    expect(captured).toContain("  failed /broken: daemon unavailable (failure total 2)\n");

    // The live TTY header still reports the running cumulative total.
    const headerFrame = renderFrame(state, { isTTY: true, width: 80, color: false, verbose: false }, 0);
    expect(headerFrame).toContain("failure total 2");

    // The final summary still reports the cumulative total exactly once.
    renderer.stop();
    writes.length = 0;
    renderer.printSummary();
    const summary = writes.join("");
    expect(summary).toContain("Failure total  2");
  });

  it("treats a discovery-item-terminal event as an intentional no-op", () => {
    const state = makeProgressState({ total: 1 });
    const renderer = new NinjaRenderer({ state, renderOpts: opts(), output: fakeOutput() });
    renderer.start();
    writes.length = 0;

    const event: CompactProgressEvent = {
      type: "discovery-item-terminal",
      index: 1,
      total: 1,
      projectId: "a".repeat(64),
      project: "/project",
      outcome: "done",
    };
    renderer.handleEvent(event);

    expect(writes).toEqual([]);
    expect(state.discovery).toBeUndefined();
    expect(state.completed).toBe(0);
    expect(state.errors).toEqual([]);
  });
});
