import { describe, expect, it, vi } from "vitest";
import {
  createTerminalDeadline,
  terminalOutcomeBudgetMs,
  terminalPhaseBudgetMs,
} from "../../src/cli/terminal-deadline.js";

describe("terminal hook time budget", () => {
  it("caps stdin and verification and gives the POST the rest of the work window", () => {
    expect(terminalPhaseBudgetMs("stdin", 100)).toBe(200);
    expect(terminalPhaseBudgetMs("verify", 100)).toBe(400);
    expect(terminalPhaseBudgetMs("post", 100)).toBe(1250);
  });

  it("never lets a phase run past the 1350ms cutoff", () => {
    expect(terminalPhaseBudgetMs("stdin", 1300)).toBe(50);
    expect(terminalPhaseBudgetMs("verify", 1200)).toBe(150);
    expect(terminalPhaseBudgetMs("post", 1349)).toBe(1);
    expect(terminalPhaseBudgetMs("post", 1350)).toBe(0);
    expect(terminalPhaseBudgetMs("verify", 1400)).toBeLessThan(0);
  });

  it("keeps the last 150ms of the 1500ms budget for the outcome", () => {
    expect(terminalOutcomeBudgetMs(1350)).toBe(150);
    expect(terminalOutcomeBudgetMs(1499)).toBe(1);
    expect(terminalOutcomeBudgetMs(2000)).toBe(0);
  });

  it("aborts a phase when its budget ends and disposes the timer", () => {
    vi.useFakeTimers();
    try {
      const deadline = createTerminalDeadline({ elapsedMs: () => 100 });
      const scope = deadline.openPhase("stdin");
      expect(scope.budgetMs).toBe(200);
      expect(scope.signal.aborted).toBe(false);
      vi.advanceTimersByTime(199);
      expect(scope.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(scope.signal.aborted).toBe(true);

      const finished = deadline.openPhase("verify");
      finished.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(finished.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens an already aborted phase without a timer once the cutoff has passed", () => {
    const setTimer = vi.fn();
    const deadline = createTerminalDeadline({
      elapsedMs: () => 1400,
      setTimeout: setTimer as unknown as typeof setTimeout,
    });
    const scope = deadline.openPhase("post");
    expect(scope.signal.aborted).toBe(true);
    expect(scope.budgetMs).toBeLessThan(0);
    scope.dispose();
    expect(setTimer).not.toHaveBeenCalled();
    expect(deadline.outcomeBudgetMs()).toBe(100);
  });

  it("measures Node uptime by default", () => {
    const deadline = createTerminalDeadline();
    const scope = deadline.openPhase("stdin");
    scope.dispose();
    expect(scope.budgetMs).toBeGreaterThan(0);
    expect(scope.budgetMs).toBeLessThanOrEqual(200);
    expect(deadline.outcomeBudgetMs()).toBeGreaterThan(0);
  });
});

