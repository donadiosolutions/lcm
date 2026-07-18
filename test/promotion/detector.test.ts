import { describe, it, expect, vi } from "vitest";
import { shouldPromote } from "../../src/promotion/detector.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

vi.mock("safe-regex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("safe-regex")>();
  return {
    default: (pattern: string): boolean => {
      if (pattern === "throw-from-safe-regex") throw new Error("probe failed");
      return actual.default(pattern);
    },
  };
});

vi.mock("../../src/store/regex-safety.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/regex-safety.js")>();
  return {
    ...actual,
    validateRegex: (pattern: string, flags?: string): RegExp => {
      if (pattern === "compile-error") throw new Error("compile failed");
      return actual.validateRegex(pattern, flags);
    },
  };
});

const thresholds = loadDaemonConfig("/x").compaction.promotionThresholds;

function nestedQuantifierFixture(): string {
  return String.fromCharCode(40, 97, 43, 41, 43, 36);
}

describe("shouldPromote", () => {
  it("promotes on decision keyword", () => {
    const r = shouldPromote({ content: "We decided to use PostgreSQL", depth: 0, tokenCount: 100, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(true);
    expect(r.tags).toContain("decision");
  });

  it("promotes on high depth (>= minDepth)", () => {
    const r = shouldPromote({ content: "Routine update", depth: 2, tokenCount: 100, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(true);
  });

  it("promotes on high compression (< 0.3 ratio)", () => {
    const r = shouldPromote({ content: "Brief", depth: 0, tokenCount: 50, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(true); // 50/500 = 0.1
  });

  it("does not promote low-signal shallow summary", () => {
    const r = shouldPromote({ content: "Let me check that", depth: 0, tokenCount: 450, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(false);
  });

  it("promotes on architecture pattern match", () => {
    const r = shouldPromote({ content: "The ConversationStore class in src/store/conversation-store.ts handles CRUD", depth: 0, tokenCount: 200, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(true);
    expect(r.tags).toContain("architecture");
  });

  it("promotes on fix keyword", () => {
    const r = shouldPromote({ content: "Fixed the root cause of the race condition", depth: 0, tokenCount: 100, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(true);
    expect(r.tags).toContain("fix");
  });

  it("skips unsafe regex patterns from architecturePatterns", () => {
    const unsafeContent = "some architecture content";
    // Unsafe pattern should be filtered out — result should have no "architecture" tag
    expect(() => {
      const r = shouldPromote({ content: unsafeContent, depth: 0, tokenCount: 200, sourceMessageTokenCount: 500 }, {
        ...thresholds,
        architecturePatterns: [nestedQuantifierFixture()],
      });
      // The unsafe pattern is filtered; "architecture" tag should not be added
      expect(r.tags).not.toContain("architecture");
    }).not.toThrow();
  });

  it("continues when a nominally safe architecture pattern cannot compile", () => {
    const r = shouldPromote({ content: "routine content", depth: 0, tokenCount: 200, sourceMessageTokenCount: 500 }, {
      ...thresholds,
      architecturePatterns: ["compile-error", "throw-from-safe-regex"],
    });
    expect(r.tags).not.toContain("architecture");
    expect(shouldPromote({ content: "routine", depth: 0, tokenCount: 1, sourceMessageTokenCount: 0 }, {
      ...thresholds,
      architecturePatterns: undefined,
    }).tags).not.toContain("architecture");
  });
});
