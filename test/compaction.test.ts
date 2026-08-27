import { describe, it, expect, vi } from "vitest";
import { CompactionEngine, type CompactionSummarizeFn } from "../src/compaction.js";
import { createAbortError, isAbortError } from "../src/daemon/cancellation.js";
import type { ConversationStore } from "../src/store/conversation-store.js";
import type { SummaryStore } from "../src/store/summary-store.js";

function makeMinimalStores(): { conversationStore: ConversationStore; summaryStore: SummaryStore } {
  const summaryStore = {
    getContextTokenCount: vi.fn().mockResolvedValue(50_000),
    getContextItems: vi.fn().mockResolvedValue([
      { ordinal: 0, itemType: "message", messageId: 1, summaryId: null, tokenCount: 50_000 },
    ]),
    getSummary: vi.fn().mockResolvedValue(null),
    insertSummary: vi.fn().mockResolvedValue(undefined),
    linkSummaryToMessages: vi.fn().mockResolvedValue(undefined),
    linkSummaryToParents: vi.fn().mockResolvedValue(undefined),
    replaceContextRangeWithSummary: vi.fn().mockResolvedValue(undefined),
    getDistinctDepthsInContext: vi.fn().mockResolvedValue([0]),
  } as unknown as SummaryStore;

  const conversationStore = {
    getConversation: vi.fn().mockResolvedValue({ conversationId: 1, sessionId: "sess-1" }),
    getMaxSeq: vi.fn().mockResolvedValue(0),
    createMessage: vi.fn().mockResolvedValue({ messageId: 1 }),
    createMessageParts: vi.fn().mockResolvedValue(undefined),
    getMessageById: vi.fn().mockResolvedValue({
      messageId: 1, role: "user", content: "hello",
      createdAt: new Date(), fileIds: [],
    }),
  } as unknown as ConversationStore;

  return { conversationStore, summaryStore };
}

describe("CompactionEngine.compact — previousSummaryContent seeding", () => {
  it("passes previousSummaryContent to summarize on the first leaf call", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();

    const summarizeCalls: { previousSummary?: string }[] = [];
    const summarize: CompactionSummarizeFn = vi.fn().mockImplementation(
      async (_text: string, _aggressive?: boolean, options?: { previousSummary?: string }) => {
        summarizeCalls.push({ previousSummary: options?.previousSummary });
        return "summary content";
      }
    );

    const storage = {
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction: async (callback: (repositories: {
        conversations: ConversationStore;
        summaries: SummaryStore;
        context: SummaryStore;
      }) => Promise<unknown>) => callback({
        conversations: conversationStore,
        summaries: summaryStore,
        context: summaryStore,
      }),
    } as never;
    const engine = new CompactionEngine(storage, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedMinFanoutHard: 5,
      incrementalMaxDepth: 0,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxRounds: 1,
    });

    await engine.compact({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize,
      force: true,
      previousSummaryContent: "prior context",
    });

    expect(summarizeCalls.length).toBeGreaterThan(0);
    expect(summarizeCalls[0].previousSummary).toBe("prior context");
    expect(summaryStore.insertSummary).toHaveBeenCalledOnce();
    expect(summaryStore.linkSummaryToMessages).toHaveBeenCalledOnce();
    expect(summaryStore.replaceContextRangeWithSummary).toHaveBeenCalledOnce();
  });

  it("rejects before provider work when its invocation signal is already aborted", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();
    const controller = new AbortController();
    controller.abort();
    const summarize = vi.fn<CompactionSummarizeFn>();
    const transaction = vi.fn(async (callback: (repositories: unknown) => Promise<unknown>) => callback({}));
    const storage = {
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction,
    } as never;
    const engine = new CompactionEngine(storage, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedMinFanoutHard: 5,
      incrementalMaxDepth: 0,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxRounds: 1,
    });

    const result = engine.compact({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize,
      force: true,
      signal: controller.signal,
    });

    await expect(result).rejects.toSatisfy(error => isAbortError(error));
    expect(summarize).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("checks cancellation after an abort-ignoring provider before writing", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const summarize: CompactionSummarizeFn = vi.fn(async (_text, _aggressive, options) => {
      observedSignal = options?.signal;
      controller.abort();
      return "summary content";
    });
    const transaction = vi.fn(async (callback: (repositories: unknown) => Promise<unknown>) => callback({}));
    const storage = {
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction,
    } as never;
    const engine = new CompactionEngine(storage, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedMinFanoutHard: 5,
      incrementalMaxDepth: 0,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxRounds: 1,
    });

    await expect(engine.compact({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize,
      force: true,
      signal: controller.signal,
    })).rejects.toSatisfy(error => isAbortError(error));
    expect(observedSignal).toBe(controller.signal);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("allows one pre-latched commit to finish and releases it before later passes", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();
    const controller = new AbortController();
    const permit = { release: vi.fn() };
    const acquireCommit = vi.fn(() => {
      const admitted = permit;
      controller.abort();
      return admitted;
    });
    const transaction = vi.fn(async (callback: (repositories: unknown) => Promise<unknown>) => callback({
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
    }));
    const storage = {
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction,
    } as never;
    const engine = new CompactionEngine(storage, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedMinFanoutHard: 5,
      incrementalMaxDepth: 0,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxRounds: 1,
    });

    await expect(engine.compact({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize: async () => "summary content",
      force: true,
      signal: controller.signal,
      acquireCommit,
    })).rejects.toSatisfy(error => isAbortError(error));
    expect(transaction).toHaveBeenCalledOnce();
    expect(permit.release).toHaveBeenCalledOnce();
    expect(acquireCommit).toHaveBeenCalledOnce();
  });

  it("threads the invocation context through compactLeaf", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();
    const controller = new AbortController();
    const permit = { release: vi.fn() };
    const acquireCommit = vi.fn(() => permit);
    let observedSignal: AbortSignal | undefined;
    const summarize: CompactionSummarizeFn = vi.fn(async (_text, _aggressive, options) => {
      observedSignal = options?.signal;
      return "short";
    });
    const storage = {
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction: async (callback: (repositories: unknown) => Promise<unknown>) => callback({
        conversations: conversationStore,
        summaries: summaryStore,
        context: summaryStore,
      }),
    } as never;
    const engine = new CompactionEngine(storage, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedMinFanoutHard: 5,
      incrementalMaxDepth: 1,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxRounds: 1,
    });

    await expect(engine.compactLeaf({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize,
      force: true,
      signal: controller.signal,
      acquireCommit,
    })).resolves.toMatchObject({ actionTaken: true });
    expect(observedSignal).toBe(controller.signal);
    expect(acquireCommit).toHaveBeenCalled();
    expect(permit.release).toHaveBeenCalled();
  });

  it("threads invocation context through a full sweep and later selection pass", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();
    const controller = new AbortController();
    const permit = { release: vi.fn() };
    const acquireCommit = vi.fn(() => permit);
    const storage = {
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction: async (callback: (repositories: unknown) => Promise<unknown>) => callback({
        conversations: conversationStore,
        summaries: summaryStore,
        context: summaryStore,
      }),
    } as never;
    const engine = new CompactionEngine(storage, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedMinFanoutHard: 5,
      incrementalMaxDepth: 0,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxRounds: 1,
    });

    await expect(engine.compactFullSweep({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize: async () => "short",
      force: true,
      signal: controller.signal,
      acquireCommit,
    })).resolves.toMatchObject({ actionTaken: true });
    expect(acquireCommit).toHaveBeenCalled();
    expect(permit.release).toHaveBeenCalled();
  });

  it("handles an empty invocation-aware leaf chunk without provider work", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();
    const controller = new AbortController();
    const engine = new CompactionEngine({
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction: async (callback: (repositories: unknown) => Promise<unknown>) => callback({
        conversations: conversationStore,
        summaries: summaryStore,
        context: summaryStore,
      }),
    } as never, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedMinFanoutHard: 5,
      incrementalMaxDepth: 0,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxRounds: 1,
    });
    const selectOldestLeafChunk = vi.spyOn(engine as never, "selectOldestLeafChunk" as never)
      .mockResolvedValue({ items: [], rawTokensOutsideTail: 0, threshold: 10 } as never);
    const summarize = vi.fn<CompactionSummarizeFn>();

    await expect(engine.compactFullSweep({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize,
      force: true,
      signal: controller.signal,
    })).resolves.toMatchObject({ actionTaken: false, condensed: false });
    expect(selectOldestLeafChunk).toHaveBeenCalledWith(1, controller.signal);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("runs an invocation-aware condensed pass and persists its event", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();
    const contextItems = [
      { ordinal: 0, itemType: "summary", summaryId: "leaf-a", messageId: null },
      { ordinal: 1, itemType: "summary", summaryId: "leaf-b", messageId: null },
    ];
    summaryStore.getContextItems.mockResolvedValue(contextItems as never);
    summaryStore.getDistinctDepthsInContext.mockResolvedValue([0]);
    summaryStore.getSummary.mockImplementation(async (summaryId: string) => ({
      summaryId,
      conversationId: 1,
      kind: "leaf",
      depth: 0,
      content: `${summaryId} content`,
      tokenCount: 2,
      fileIds: [],
      earliestAt: null,
      latestAt: null,
      descendantCount: 0,
      descendantTokenCount: 0,
      sourceMessageTokenCount: 0,
      createdAt: new Date(),
    }));
    const transaction = vi.fn(async (callback: (repositories: unknown) => Promise<unknown>) => callback({
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
    }));
    const storage = {
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction,
    } as never;
    const controller = new AbortController();
    const permit = { release: vi.fn() };
    const acquireCommit = vi.fn(() => permit);
    const summarize: CompactionSummarizeFn = vi.fn(async (_text, aggressive, options) => {
      expect(aggressive).toBe(false);
      expect(options?.signal).toBe(controller.signal);
      return "condensed";
    });
    const engine = new CompactionEngine(storage, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 2,
      condensedMinFanoutHard: 1,
      incrementalMaxDepth: 0,
      leafChunkTokens: 10,
      leafTargetTokens: 600,
      condensedTargetTokens: 1,
      maxRounds: 1,
    });

    await expect(engine.compactFullSweep({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize,
      force: true,
      signal: controller.signal,
      acquireCommit,
    })).resolves.toMatchObject({ actionTaken: true, condensed: true });
    expect(summaryStore.linkSummaryToParents).toHaveBeenCalledWith(
      expect.any(String),
      ["leaf-a", "leaf-b"],
    );
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(acquireCommit).toHaveBeenCalledTimes(2);
    expect(permit.release).toHaveBeenCalledTimes(2);
  });

  it("stops the condensed phase when no eligible summary candidate exists", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();
    summaryStore.getContextItems.mockResolvedValue([
      { ordinal: 0, itemType: "summary", summaryId: "missing", messageId: null },
    ] as never);
    summaryStore.getDistinctDepthsInContext.mockResolvedValue([0]);
    const transaction = vi.fn(async (callback: (repositories: unknown) => Promise<unknown>) => callback({
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
    }));
    const storage = {
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction,
    } as never;
    const engine = new CompactionEngine(storage, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 1,
      condensedMinFanoutHard: 1,
      incrementalMaxDepth: 0,
      leafChunkTokens: 10,
      leafTargetTokens: 600,
      condensedTargetTokens: 1,
      maxRounds: 1,
    });

    await expect(engine.compactFullSweep({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize: async () => "short",
      force: true,
    })).resolves.toMatchObject({ actionTaken: false, condensed: false });
    expect(summaryStore.getSummary).toHaveBeenCalledWith("missing");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("passes the invocation signal to an aggressive retry", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();
    const transaction = vi.fn(async (callback: (repositories: unknown) => Promise<unknown>) => callback({
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
    }));
    const storage = {
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction,
    } as never;
    const controller = new AbortController();
    const summarize: CompactionSummarizeFn = vi.fn(async (text, aggressive, options) => {
      expect(options?.signal).toBe(controller.signal);
      return aggressive ? "short" : text;
    });
    const engine = new CompactionEngine(storage, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedMinFanoutHard: 5,
      incrementalMaxDepth: 0,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxRounds: 1,
    });

    await expect(engine.compact({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize,
      force: true,
      signal: controller.signal,
    })).resolves.toMatchObject({ actionTaken: true, level: "aggressive" });
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("rethrows intentional event admission cancellation while preserving best effort errors", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();
    const engine = new CompactionEngine({
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction: async (callback: (repositories: unknown) => Promise<unknown>) => callback({
        conversations: conversationStore,
        summaries: summaryStore,
        context: summaryStore,
      }),
    } as never, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedMinFanoutHard: 5,
      incrementalMaxDepth: 0,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxRounds: 1,
    });
    const privateEngine = engine as unknown as Record<string, (...args: unknown[]) => unknown>;
    conversationStore.getConversation.mockResolvedValue({ conversationId: 1, sessionId: "events" });
    const acquireCommit = () => { throw createAbortError(); };

    await expect(privateEngine.persistCompactionEvents({
      conversationId: 1,
      tokensBefore: 10,
      tokensAfterLeaf: 5,
      tokensAfterFinal: 5,
      leafResult: { summaryId: "summary", level: "normal" },
      condenseResult: null,
      context: { acquireCommit },
    })).rejects.toSatisfy(error => isAbortError(error));
  });

  it("runs the incremental condensed pass when invocation context is supplied", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();
    const controller = new AbortController();
    const permit = { release: vi.fn() };
    const acquireCommit = vi.fn(() => permit);
    const privateEngine = new CompactionEngine({
      conversations: conversationStore,
      summaries: summaryStore,
      context: summaryStore,
      transaction: async (callback: (repositories: unknown) => Promise<unknown>) => callback({
        conversations: conversationStore,
        summaries: summaryStore,
        context: summaryStore,
      }),
    } as never, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 1,
      condensedMinFanoutHard: 1,
      incrementalMaxDepth: 1,
      leafChunkTokens: 1,
      leafTargetTokens: 1,
      condensedTargetTokens: 1,
      maxRounds: 1,
    });
    const engine = privateEngine as unknown as Record<string, (...args: unknown[]) => unknown>;
    engine.selectOldestLeafChunk = vi.fn(async () => ({
      items: [{ ordinal: 0, itemType: "message", messageId: 1 }],
      rawTokensOutsideTail: 10,
      threshold: 1,
    }));
    engine.leafPass = vi.fn(async () => ({ summaryId: "leaf", level: "normal", content: "short" }));
    engine.selectOldestChunkAtDepth = vi.fn(async () => ({
      items: [{ ordinal: 0, itemType: "summary", summaryId: "leaf" }],
      summaryTokens: 2,
    }));
    engine.condensedPass = vi.fn(async () => ({ summaryId: "condensed", level: "normal" }));
    engine.persistCompactionEvents = vi.fn(async () => undefined);
    summaryStore.getContextTokenCount
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(2);

    const result = await privateEngine.compactLeaf({
      conversationId: 1,
      tokenBudget: 10,
      summarize: async () => "short",
      force: true,
      signal: controller.signal,
      acquireCommit,
    });
    expect(result).toMatchObject({ condensed: true });
    expect(engine.condensedPass).toHaveBeenCalled();
  });
});
