import { describe, expect, it, vi } from "vitest";
import { createRetrievalEngine, RetrievalEngine } from "../src/retrieval.js";
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

type ConversationMethods = Pick<ConversationStore, "searchMessages" | "getMessageById">;
type SummaryMethods = Pick<
  SummaryStore,
  | "getSummary"
  | "getLargeFile"
  | "getSummaryParents"
  | "getSummaryChildren"
  | "getSummaryMessages"
  | "getSummarySubtree"
  | "searchSummaries"
>;

interface StoreOverrides {
  conversation?: Partial<ConversationMethods>;
  summaries?: Partial<SummaryMethods>;
}

interface StoreFixture {
  conversation: ConversationMethods;
  summaries: SummaryMethods;
  engine: RetrievalEngine;
}

function stores(overrides: StoreOverrides = {}): StoreFixture {
  const conversation: ConversationMethods = {
    searchMessages: vi.fn(async () => []),
    getMessageById: vi.fn(async () => null),
    ...overrides.conversation,
  };
  const summaries: SummaryMethods = {
    getSummary: vi.fn(async () => null),
    getLargeFile: vi.fn(async () => null),
    getSummaryParents: vi.fn(async () => []),
    getSummaryChildren: vi.fn(async () => []),
    getSummaryMessages: vi.fn(async () => []),
    getSummarySubtree: vi.fn(async () => []),
    searchSummaries: vi.fn(async () => []),
    ...overrides.summaries,
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
  it("adapts backend-neutral message and large-file repositories", async () => {
    const leaf = summary("sum_leaf");
    const file = {
      fileId: "file_adapter",
      conversationId: 1,
      fileName: null,
      mimeType: null,
      byteSize: null,
      storageUri: "memory://adapter",
      explorationSummary: null,
      createdAt: now,
    };
    const messageRecord = {
      messageId: 7,
      conversationId: 1,
      seq: 0,
      role: "user" as const,
      content: "adapter message",
      tokenCount: 2,
      createdAt: now,
    };
    const repositories = {
      conversations: { getMessageById: vi.fn(async () => messageRecord) },
      summaries: {
        getSummary: vi.fn(async () => leaf),
        getSummaryChildren: vi.fn(async () => []),
        getSummaryMessages: vi.fn(async () => [messageRecord.messageId]),
        getSummaryParents: vi.fn(async () => []),
        getSummarySubtree: vi.fn(async () => []),
      },
      largeFiles: { getLargeFile: vi.fn(async () => file) },
      lexicalSearch: {
        searchMessages: vi.fn(async () => []),
        searchSummaries: vi.fn(async () => []),
      },
    } as never;
    const engine = createRetrievalEngine(repositories);
    await expect(engine.describe(file.fileId)).resolves.toMatchObject({
      file: { storageUri: file.storageUri },
    });
    await expect(engine.expand({ summaryId: leaf.summaryId, includeMessages: true }))
      .resolves.toMatchObject({ messages: [{ messageId: messageRecord.messageId }] });
    await expect(engine.describe(leaf.summaryId)).resolves.toMatchObject({
      summary: { messageIds: [messageRecord.messageId] },
    });
    await expect(engine.grep({ query: "adapter", mode: "full_text", scope: "both" }))
      .resolves.toMatchObject({ totalMatches: 0 });
  });

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

  it("rejects an invalid runtime scope instead of treating it as both", async () => {
    const { engine, conversation, summaries } = stores();
    await expect(engine.grep({ query: "q", mode: "regex", scope: "invalid" as never })).rejects.toThrow("Invalid grep scope");
    expect(conversation.searchMessages).not.toHaveBeenCalled();
    expect(summaries.searchSummaries).not.toHaveBeenCalled();
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

  it("stops traversing siblings after a recursive child reaches the token cap", async () => {
    const root = summary("sum_root", "condensed");
    const child = summary("sum_child", "condensed");
    const grandchild = { ...summary("sum_grandchild"), tokenCount: 3 };
    const sibling = summary("sum_sibling", "condensed");
    const getSummary = vi.fn(async (id: string) => id === root.summaryId ? root : child);
    const { engine } = stores({
      summaries: {
        getSummary,
        getSummaryChildren: vi.fn(async (id: string) => id === root.summaryId
          ? [child, sibling]
          : [grandchild]),
      },
    });

    await expect(engine.expand({ summaryId: root.summaryId, depth: 2, tokenCap: 2 }))
      .resolves.toMatchObject({
        children: [{ summaryId: child.summaryId }],
        estimatedTokens: 2,
        truncated: true,
      });
    expect(getSummary).toHaveBeenCalledTimes(2);
    expect(getSummary).not.toHaveBeenCalledWith(sibling.summaryId);
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
