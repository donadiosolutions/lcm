import { describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import {
  ExpansionOrchestrator,
  buildExpansionToolDefinition,
  distillForSubagent,
  resolveExpansionTokenCap,
  type ExpansionResult,
} from "../src/expansion.js";
import type { ExpandResult, GrepResult, RetrievalEngine } from "../src/retrieval.js";

const CONFIG = {
  maxExpandTokens: 250,
} as LcmConfig;

function retrievalFixture(input: {
  expand?: ReturnType<typeof vi.fn>;
  grep?: ReturnType<typeof vi.fn>;
}): RetrievalEngine {
  // RetrievalEngine owns private stores; orchestration tests exercise only these public seams.
  return {
    expand: input.expand ?? vi.fn(),
    grep: input.grep ?? vi.fn(),
  } as unknown as RetrievalEngine;
}

function rawExpansion(overrides: Partial<ExpandResult> = {}): ExpandResult {
  return {
    children: [],
    messages: [],
    estimatedTokens: 0,
    truncated: false,
    ...overrides,
  };
}

describe("expansion boundaries", () => {
  it.each([
    [{ maxExpandTokens: 0 }, 1],
    [{ maxExpandTokens: 10.9 }, 10],
    [{ maxExpandTokens: 10, requestedTokenCap: Number.NaN }, 10],
    [{ maxExpandTokens: 10, requestedTokenCap: Number.POSITIVE_INFINITY }, 10],
    [{ maxExpandTokens: 10, requestedTokenCap: -5 }, 1],
    [{ maxExpandTokens: 10, requestedTokenCap: 4.9 }, 4],
    [{ maxExpandTokens: 10, requestedTokenCap: 20 }, 10],
  ])("bounds expansion token caps %#", (input, expected) => {
    expect(resolveExpansionTokenCap(input)).toBe(expected);
  });

  it("expands entries with defaults, snippets, cited-id deduplication, and raw truncation", async () => {
    const expand = vi.fn()
      .mockResolvedValueOnce(rawExpansion({
        children: [{ summaryId: "child", kind: "leaf", content: "x".repeat(201), tokenCount: 30 }],
        messages: [{ messageId: 1, role: "user", content: "short", tokenCount: 2 }],
        estimatedTokens: 32,
      }))
      .mockResolvedValueOnce(rawExpansion({
        children: [{ summaryId: "child", kind: "condensed", content: "again", tokenCount: 5 }],
        estimatedTokens: 5,
        truncated: true,
      }));
    const orchestrator = new ExpansionOrchestrator(retrievalFixture({ expand }));

    const result = await orchestrator.expand({ summaryIds: ["root", "other", "ignored"] });

    expect(expand).toHaveBeenCalledTimes(2);
    expect(expand).toHaveBeenNthCalledWith(1, {
      summaryId: "root",
      depth: 3,
      includeMessages: false,
      tokenCap: Infinity,
    });
    expect(result.expansions[0].children[0].snippet).toBe(`${"x".repeat(200)}...`);
    expect(result.expansions[0].messages[0].snippet).toBe("short");
    expect(result.citedIds).toEqual(["root", "child", "other"]);
    expect(result.totalTokens).toBe(37);
    expect(result.truncated).toBe(true);
  });

  it("stops before a later expansion when the global budget is exhausted", async () => {
    const expand = vi.fn().mockResolvedValue(rawExpansion({ estimatedTokens: 5 }));
    const orchestrator = new ExpansionOrchestrator(retrievalFixture({ expand }));
    const result = await orchestrator.expand({
      summaryIds: ["one", "two"],
      maxDepth: 1,
      tokenCap: 5,
      includeMessages: true,
    });
    expect(expand).toHaveBeenCalledOnce();
    expect(expand).toHaveBeenCalledWith({
      summaryId: "one",
      depth: 1,
      includeMessages: true,
      tokenCap: 5,
    });
    expect(result.truncated).toBe(true);
  });

  it("sorts grep results by recency then rank and handles an empty match set", async () => {
    const grep = vi.fn()
      .mockResolvedValueOnce({
        messages: [],
        totalMatches: 4,
        summaries: [
          { summaryId: "old", conversationId: 4, kind: "leaf", snippet: "", createdAt: new Date(0), rank: 0 },
          { summaryId: "unranked", conversationId: 4, kind: "leaf", snippet: "", createdAt: new Date(100) },
          { summaryId: "unranked-2", conversationId: 4, kind: "leaf", snippet: "", createdAt: new Date(100) },
          { summaryId: "ranked", conversationId: 4, kind: "leaf", snippet: "", createdAt: new Date(100), rank: 2 },
        ],
      } satisfies GrepResult)
      .mockResolvedValueOnce({
        messages: [], totalMatches: 1,
        summaries: [{ summaryId: "default-conversation", conversationId: 0, kind: "leaf", snippet: "", createdAt: new Date(0) }],
      } satisfies GrepResult)
      .mockResolvedValueOnce({ messages: [], summaries: [], totalMatches: 0 } satisfies GrepResult);
    const expand = vi.fn().mockResolvedValue(rawExpansion());
    const orchestrator = new ExpansionOrchestrator(retrievalFixture({ grep, expand }));

    await orchestrator.describeAndExpand({
      query: "needle",
      mode: "regex",
      conversationId: 4,
      maxDepth: 2,
      tokenCap: 20,
    });
    expect(grep).toHaveBeenNthCalledWith(1, {
      query: "needle",
      mode: "regex",
      scope: "summaries",
      conversationId: 4,
    });
    expect(expand.mock.calls.map(([input]) => input.summaryId)).toEqual([
      "ranked", "unranked", "unranked-2", "old",
    ]);

    await orchestrator.describeAndExpand({ query: "default", mode: "full_text" });
    expect(expand).toHaveBeenLastCalledWith(expect.objectContaining({ summaryId: "default-conversation" }));
    expect(await orchestrator.describeAndExpand({ query: "none", mode: "full_text" })).toEqual({
      expansions: [], citedIds: [], totalTokens: 0, truncated: false,
    });
  });

  it("distills condensed and leaf results with optional details", () => {
    const result: ExpansionResult = {
      expansions: [
        {
          summaryId: "condensed",
          children: [
            { summaryId: "child-empty", kind: "leaf", snippet: "", tokenCount: 2 },
            { summaryId: "child-text", kind: "leaf", snippet: "snippet", tokenCount: 3 },
          ],
          messages: [{ messageId: 7, role: "assistant", snippet: "message", tokenCount: 4 }],
        },
        { summaryId: "leaf", children: [], messages: [] },
      ],
      citedIds: ["condensed", "child-text"],
      totalTokens: 9,
      truncated: true,
    };
    const text = distillForSubagent(result);
    expect(text).toContain("### condensed (condensed, 9 tokens)");
    expect(text).toContain("Children: child-empty, child-text");
    expect(text).toContain("Messages: msg#7 (assistant, 4 tokens)");
    expect(text).toContain("[Snippet: snippet]");
    expect(text).toContain("### leaf (leaf, 0 tokens)");
    expect(text).toContain("Cited IDs for follow-up: condensed, child-text");
    expect(text).toContain("[Truncated: yes]");

    expect(distillForSubagent({ expansions: [], citedIds: [], totalTokens: 0, truncated: false }))
      .not.toContain("Cited IDs for follow-up");
  });

  it("routes tool queries, direct IDs, normalized options, and invalid requests", async () => {
    const result: ExpansionResult = {
      expansions: [], citedIds: ["sum-a"], totalTokens: 3, truncated: false,
    };
    const orchestrator = {
      expand: vi.fn().mockResolvedValue(result),
      describeAndExpand: vi.fn().mockResolvedValue(result),
    };
    const tool = buildExpansionToolDefinition({
      orchestrator: orchestrator as unknown as ExpansionOrchestrator,
      config: CONFIG,
      conversationId: 8,
    });

    const queryResult = await tool.execute("q", {
      query: "  topic  ", maxDepth: 2.9, tokenCap: 50.8, includeMessages: "yes",
    });
    expect(orchestrator.describeAndExpand).toHaveBeenCalledWith({
      query: "topic", mode: "full_text", conversationId: 8, maxDepth: 2, tokenCap: 50,
    });
    expect(queryResult.details).toEqual({
      expansionCount: 0, citedIds: ["sum-a"], totalTokens: 3, truncated: false,
    });

    await tool.execute("ids", {
      query: "   ", summaryIds: ["sum-a"], maxDepth: "bad", tokenCap: "bad", includeMessages: true,
    });
    expect(orchestrator.expand).toHaveBeenCalledWith({
      summaryIds: ["sum-a"], maxDepth: undefined, tokenCap: 250,
      includeMessages: true, conversationId: 8,
    });

    const invalid = await tool.execute("bad", { summaryIds: [] });
    expect(invalid).toEqual({
      content: [{ type: "text", text: "Error: either summaryIds or query must be provided." }],
      details: { error: "Error: either summaryIds or query must be provided." },
    });
  });
});
