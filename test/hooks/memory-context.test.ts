import { describe, expect, it } from "vitest";
import {
  buildMemoryContext,
  selectMemoryHintsWithinBudget,
} from "../../src/hooks/memory-context.js";

const options = {
  totalByteBudget: 500,
  reservedForLearningInstruction: 0,
  learningInstructionBytes: 0,
  maxEmitted: 5,
  dedupMinPrefix: 4,
};

describe("memory context", () => {
  it("builds optional id metadata and handles no hints", () => {
    expect(buildMemoryContext([])).toBeNull();
    expect(buildMemoryContext(["hint"])).not.toContain("surfaced-memory-ids");
    expect(buildMemoryContext(["hint"], ["id-1"])).toContain("surfaced-memory-ids: id-1");
  });

  it("deduplicates exact and prefix-equivalent normalized hints", () => {
    const result = selectMemoryHintsWithinBudget([
      { id: "blank", hint: "   " },
      { id: "one", hint: "  Use   SQLite  " },
      { id: "two", hint: "use sqlite" },
      { id: "three", hint: "use another choice" },
    ], options);
    expect(result.ids).toEqual(["one"]);
    expect(result.dedupedCount).toBe(2);
  });

  it("truncates Unicode hints to the longest fitting prefix", () => {
    const result = selectMemoryHintsWithinBudget([
      { id: "one", hint: "🙂".repeat(100) + "..." },
    ], { ...options, totalByteBudget: 150, dedupMinPrefix: 0 });
    expect(result.hints[0]).toMatch(/\.\.\.$/);
    expect(result.usedHintBytes).toBeLessThanOrEqual(result.availableHintBytes);
  });

  it("budgets a truncated hint after an already selected hint", () => {
    const result = selectMemoryHintsWithinBudget([
      { id: "one", hint: "short" },
      { id: "two", hint: "x".repeat(300) },
    ], { ...options, totalByteBudget: 180 });
    expect(result.ids).toEqual(["one", "two"]);
    expect(result.hints[1]).toMatch(/\.\.\.$/);
  });

  it("drops hints when no prefix or emission slot fits", () => {
    const noBudget = selectMemoryHintsWithinBudget(
      [{ id: "one", hint: "content" }],
      { ...options, totalByteBudget: -1, reservedForLearningInstruction: -2 },
    );
    expect(noBudget.hints).toEqual([]);
    expect(noBudget.droppedForBudget).toBe(1);

    const noSlots = selectMemoryHintsWithinBudget(
      [{ id: "one", hint: "content" }],
      { ...options, maxEmitted: -1 },
    );
    expect(noSlots.droppedForBudget).toBe(1);
  });

  it("uses the larger floored learning reservation", () => {
    const result = selectMemoryHintsWithinBudget([], {
      ...options,
      totalByteBudget: 100.9,
      reservedForLearningInstruction: 20.9,
      learningInstructionBytes: 30.9,
    });
    expect(result.availableHintBytes).toBe(70);
    expect(result.usedHintBytes).toBe(0);
  });
});
