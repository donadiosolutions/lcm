import { describe, expect, it, vi } from "vitest";
import { RetrievalEngine } from "../src/retrieval.js";
import type { ConversationStore, MessageRecord } from "../src/store/conversation-store.js";
import type { SummaryRecord, SummaryStore } from "../src/store/summary-store.js";

const now = new Date("2026-01-01T00:00:00Z");

function summary(summaryId: string, kind: "leaf" | "condensed" = "leaf"): SummaryRecord {
  return {
    summaryId,
    conversationId: 1,
    kind,
    depth: kind === "leaf" ? 0 : 1,
    content: `${summaryId} content`,
    tokenCount: 2,
    fileIds: ["file_a"],
    earliestAt: now,
    latestAt: now,
    descendantCount: 1,
    descendantTokenCount: 2,
    sourceMessageTokenCount: 3,
    createdAt: now,
  };
}

function stores(overrides: Record<string, unknown> = {}) {
  const conversation = {
    searchMessages: vi.fn(async () => []),
    getMessageById: vi.fn(async () => null),
    ...overrides.conversation as object,
  };
  const summaries = {
    getSummary: vi.fn(async () => null),
    getLargeFile: vi.fn(async () => null),
    getSummaryParents: vi.fn(async () => []),
    getSummaryChildren: vi.fn(async () => []),
    getSummaryMessages: vi.fn(async () => []),
    getSummarySubtree: vi.fn(async () => []),
    searchSummaries: vi.fn(async () => []),
    ...overrides.summaries as object,
  };
  return {
    conversation,
    summaries,
    engine: new RetrievalEngine(
      conversation as unknown as ConversationStore,
      summaries as unknown as SummaryStore,
    ),
  };
}

describe("RetrievalEngine describe", () => {
  it("rejects unknown IDs and returns null for missing records", async () => {
    const { engine } = stores();
    await expect(engine.describe("other")).resolves.toBeNull();
    await expect(engine.describe("sum_missing")).resolves.toBeNull();
    await expect(engine.describe("file_missing")).resolves.toBeNull();
  });

  it("describes summaries with complete lineage", async () => {
    const root = summary("sum_root", "condensed");
    const child = summary("sum_child");
    const { engine } = stores({
      summaries: {
        getSummary: vi.fn(async () => root),
        getSummaryParents: vi.fn(async () => [summary("sum_parent", "condensed")]),
        getSummaryChildren: vi.fn(async () => [child]),
        getSummaryMessages: vi.fn(async () => [7]),
        getSummarySubtree: vi.fn(async () => [{
          ...child,
          parentSummaryId: root.summaryId,
          depthFromRoot: 1,
          childCount: 0,
          path: "sum_root/sum_child",
        }]),
      },
    });
    const result = await engine.describe(root.summaryId);
    expect(result).toMatchObject({
      id: root.summaryId,
      type: "summary",
      summary: {
        parentIds: ["sum_parent"],
        childIds: ["sum_child"],
        messageIds: [7],
        subtree: [{ summaryId: "sum_child", depthFromRoot: 1 }],
      },
    });
  });

  it("describes stored files", async () => {
    const file = {
      fileId: "file_a",
      conversationId: 1,
      fileName: null,
      mimeType: null,
      byteSize: null,
      storageUri: "memory://file_a",
      explorationSummary: null,
      createdAt: now,
    };
    const { engine } = stores({ summaries: { getLargeFile: vi.fn(async () => file) } });
    await expect(engine.describe(file.fileId)).resolves.toMatchObject({
      id: file.fileId,
      type: "file",
      file: { conversationId: 1, storageUri: "memory://file_a" },
    });
  });
});

describe("RetrievalEngine grep", () => {
  const oldMessage = { messageId: 1, conversationId: 1, role: "user", snippet: "old", createdAt: now };
  const newMessage = { ...oldMessage, messageId: 2, snippet: "new", createdAt: new Date(now.getTime() + 1) };
  const oldSummary = { summaryId: "sum_old", conversationId: 1, kind: "leaf", snippet: "old", createdAt: now };
  const newSummary = { ...oldSummary, summaryId: "sum_new", snippet: "new", createdAt: new Date(now.getTime() + 1) };

  it.each(["messages", "summaries", "both"] as const)("searches and sorts %s scope", async (scope) => {
    const { engine, conversation, summaries } = stores({
      conversation: { searchMessages: vi.fn(async () => [oldMessage, newMessage]) },
      summaries: { searchSummaries: vi.fn(async () => [oldSummary, newSummary]) },
    });
    const result = await engine.grep({ query: "q", mode: "regex", scope });
    expect(result.totalMatches).toBe(scope === "both" ? 4 : 2);
    if (scope !== "summaries") expect(result.messages.map((item) => item.snippet)).toEqual(["new", "old"]);
    if (scope !== "messages") expect(result.summaries.map((item) => item.snippet)).toEqual(["new", "old"]);
    expect(conversation.searchMessages).toHaveBeenCalledTimes(scope === "summaries" ? 0 : 1);
    expect(summaries.searchSummaries).toHaveBeenCalledTimes(scope === "messages" ? 0 : 1);
  });
});

describe("RetrievalEngine expand", () => {
  it("returns early for zero depth, truncation, and missing summaries", async () => {
    const { engine, summaries } = stores();
    await expect(engine.expand({ summaryId: "sum_x", depth: 0 })).resolves.toMatchObject({ children: [] });
    expect(summaries.getSummary).not.toHaveBeenCalled();
    await expect(engine.expand({ summaryId: "sum_x" })).resolves.toMatchObject({ children: [] });
  });

  it("expands condensed DAGs recursively and stops at the token cap", async () => {
    const root = summary("sum_root", "condensed");
    const child = summary("sum_child", "condensed");
    const grandchild = summary("sum_grandchild");
    const tooLarge = { ...summary("sum_large"), tokenCount: 10 };
    const { engine } = stores({
      summaries: {
        getSummary: vi.fn(async (id: string) => id === root.summaryId ? root : child),
        getSummaryChildren: vi.fn(async (id: string) => id === root.summaryId
          ? [child, tooLarge]
          : [grandchild]),
      },
    });
    await expect(engine.expand({ summaryId: root.summaryId, depth: 2, tokenCap: 5 })).resolves.toMatchObject({
      children: [{ summaryId: "sum_child" }, { summaryId: "sum_grandchild" }],
      estimatedTokens: 4,
      truncated: true,
    });
  });

  it("loads leaf messages, skips missing ones, estimates zero token counts, and truncates", async () => {
    const leaf = summary("sum_leaf");
    const message = (messageId: number, content: string, tokenCount: number): MessageRecord => ({
      messageId, conversationId: 1, seq: messageId, role: "user", content, tokenCount, createdAt: now,
    });
    const { engine } = stores({
      summaries: {
        getSummary: vi.fn(async () => leaf),
        getSummaryMessages: vi.fn(async () => [1, 2, 3]),
      },
      conversation: {
        getMessageById: vi.fn(async (id: number) => id === 1 ? null : message(id, id === 2 ? "12345678" : "x", id === 2 ? 0 : 4)),
      },
    });
    await expect(engine.expand({ summaryId: leaf.summaryId, includeMessages: true, tokenCap: 3 })).resolves.toMatchObject({
      messages: [{ messageId: 2, tokenCount: 2 }],
      estimatedTokens: 2,
      truncated: true,
    });
  });

  it("does not load leaf messages unless requested", async () => {
    const { engine, summaries } = stores({ summaries: { getSummary: vi.fn(async () => summary("sum_leaf")) } });
    await engine.expand({ summaryId: "sum_leaf" });
    expect(summaries.getSummaryMessages).not.toHaveBeenCalled();
  });
});
