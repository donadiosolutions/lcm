import { describe, expect, it, vi } from "vitest";
import {
  __compactionTestUtils as utils,
  CompactionEngine,
  formatTimestamp,
  type CompactionConfig,
  type CompactionResult,
} from "../src/compaction.js";
import type { ConversationStore, MessageRecord } from "../src/store/conversation-store.js";
import type { ContextItemRecord, SummaryRecord, SummaryStore } from "../src/store/summary-store.js";

const now = new Date("2026-01-02T03:04:00Z");

function config(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
  return {
    contextThreshold: 0.5,
    freshTailCount: 1,
    leafMinFanout: 2,
    condensedMinFanout: 3,
    condensedMinFanoutHard: 1,
    incrementalMaxDepth: 0,
    leafChunkTokens: 10,
    leafTargetTokens: 3,
    condensedTargetTokens: 2,
    maxRounds: 2,
    timezone: "UTC",
    ...overrides,
  };
}

function item(ordinal: number, type: "message" | "summary", id: number | string): ContextItemRecord {
  return {
    conversationId: 1,
    ordinal,
    itemType: type,
    messageId: type === "message" ? id as number : null,
    summaryId: type === "summary" ? id as string : null,
    createdAt: now,
  };
}

function message(messageId: number, tokenCount = 2, content = `message ${messageId}`): MessageRecord {
  return { messageId, conversationId: 1, seq: messageId, role: "user", content, tokenCount, createdAt: now };
}

function summary(summaryId: string, depth = 0, tokenCount = 2): SummaryRecord {
  return {
    summaryId, conversationId: 1, kind: depth === 0 ? "leaf" : "condensed", depth,
    content: `${summaryId} content`, tokenCount, fileIds: [], earliestAt: null, latestAt: null,
    descendantCount: 0, descendantTokenCount: 0, sourceMessageTokenCount: 0, createdAt: now,
  };
}

function fixture(configOverrides: Partial<CompactionConfig> = {}) {
  const conversations = {
    getMessageById: vi.fn(async () => null),
    getConversation: vi.fn(async () => null),
    getMaxSeq: vi.fn(async () => 0),
    createMessage: vi.fn(async () => ({ messageId: 99 })),
    createMessageParts: vi.fn(async () => undefined),
    withTransaction: vi.fn(async (callback: () => Promise<void>) => callback()),
  };
  const summaries = {
    getContextTokenCount: vi.fn(async () => 0),
    getContextItems: vi.fn(async () => [] as ContextItemRecord[]),
    getSummary: vi.fn(async () => null),
    getDistinctDepthsInContext: vi.fn(async () => [] as number[]),
    insertSummary: vi.fn(async () => undefined),
    linkSummaryToMessages: vi.fn(async () => undefined),
    linkSummaryToParents: vi.fn(async () => undefined),
    replaceContextRangeWithSummary: vi.fn(async () => undefined),
  };
  const cfg = config(configOverrides);
  return {
    conversations,
    summaries,
    cfg,
    engine: new CompactionEngine(
      conversations as unknown as ConversationStore,
      summaries as unknown as SummaryStore,
      cfg,
    ),
  };
}

function call<T>(engine: CompactionEngine, method: string, ...args: unknown[]): T {
  const fn = (engine as unknown as Record<string, (...values: unknown[]) => unknown>)[method];
  return fn.apply(engine, args) as T;
}

describe("compaction pure boundaries", () => {
  it("formats UTC, named, and invalid timezones", () => {
    expect(formatTimestamp(now)).toBe("2026-01-02 03:04 UTC");
    expect(formatTimestamp(now, "America/New_York")).toMatch(/^2026-01-01 22:04 /);
    expect(formatTimestamp(now, "invalid/timezone")).toBe("2026-01-02 03:04 UTC");
    expect(utils.shortTzAbbr(now, "invalid/timezone")).toBe("invalid/timezone");
  });

  it("estimates, hashes, and deduplicates deterministically", () => {
    expect(utils.estimateTokens("12345")).toBe(2);
    expect(utils.generateSummaryId("content")).toMatch(/^sum_[a-f0-9]{16}$/);
    expect(utils.dedupeOrderedIds(["a", "b", "a"])).toEqual(["a", "b"]);
  });
});

describe("evaluate and compact-until boundaries", () => {
  it.each([
    [undefined, 40, false],
    [Number.NaN, 40, false],
    [-1, 40, false],
    [60.9, 60, true],
  ])("evaluates observed tokens %#", async (observed, currentTokens, shouldCompact) => {
    const { engine, summaries } = fixture();
    summaries.getContextTokenCount.mockResolvedValue(40);
    await expect(engine.evaluate(1, 100, observed)).resolves.toMatchObject({ currentTokens, shouldCompact });
  });

  it("returns immediately below target and normalizes invalid targets", async () => {
    const { engine, summaries } = fixture();
    summaries.getContextTokenCount.mockResolvedValue(9);
    await expect(engine.compactUntilUnder({ conversationId: 1, tokenBudget: 10, currentTokens: 8, summarize: async () => "x" }))
      .resolves.toEqual({ success: true, rounds: 0, finalTokens: 9 });
    await expect(engine.compactUntilUnder({ conversationId: 1, tokenBudget: 10, targetTokens: Number.NaN, currentTokens: -1, summarize: async () => "x" }))
      .resolves.toEqual({ success: true, rounds: 0, finalTokens: 9 });
  });

  it("covers success, no-action, no-progress, and exhausted rounds", async () => {
    const cases: Array<{ results: CompactionResult[]; expected: object }> = [
      { results: [{ actionTaken: true, tokensBefore: 10, tokensAfter: 5, condensed: false }], expected: { success: true, rounds: 1, finalTokens: 5 } },
      { results: [{ actionTaken: false, tokensBefore: 10, tokensAfter: 9, condensed: false }], expected: { success: false, rounds: 1, finalTokens: 9 } },
      { results: [{ actionTaken: true, tokensBefore: 10, tokensAfter: 10, condensed: false }], expected: { success: false, rounds: 1, finalTokens: 10 } },
      { results: [
        { actionTaken: true, tokensBefore: 12, tokensAfter: 11, condensed: false },
        { actionTaken: true, tokensBefore: 11, tokensAfter: 10, condensed: false },
      ], expected: { success: false, rounds: 2, finalTokens: 10 } },
    ];
    for (const { results, expected } of cases) {
      const { engine, summaries } = fixture({ maxRounds: results.length });
      summaries.getContextTokenCount.mockResolvedValueOnce(12).mockResolvedValue(10);
      vi.spyOn(engine, "compact").mockImplementation(async () => results.shift()!);
      await expect(engine.compactUntilUnder({ conversationId: 1, tokenBudget: 10, targetTokens: 6, currentTokens: 12, summarize: async () => "x" }))
        .resolves.toMatchObject(expected);
    }
  });
});

describe("configuration and token helper boundaries", () => {
  it.each([
    ["resolveLeafChunkTokens", "leafChunkTokens", [2.9, Number.NaN, 0, undefined], [2, 20_000, 20_000, 20_000]],
    ["resolveFreshTailCount", "freshTailCount", [2.9, Number.NaN, 0], [2, 0, 0]],
    ["resolveLeafMinFanout", "leafMinFanout", [2.9, Number.NaN, 0], [2, 8, 8]],
    ["resolveCondensedMinFanout", "condensedMinFanout", [2.9, Number.NaN, 0], [2, 4, 4]],
    ["resolveCondensedMinFanoutHard", "condensedMinFanoutHard", [2.9, Number.NaN, 0], [2, 2, 2]],
  ] as const)("normalizes %s", (method, key, values, expected) => {
    const { engine, cfg } = fixture();
    values.forEach((value, index) => {
      (cfg as unknown as Record<string, unknown>)[key] = value;
      expect(call<number>(engine, method)).toBe(expected[index]);
    });
  });

  it("normalizes incremental depth and selects depth fanout", () => {
    const { engine, cfg } = fixture();
    for (const [value, expected] of [[-1, Infinity], [2.9, 2], [0, 0], [Number.NaN, 0]] as const) {
      cfg.incrementalMaxDepth = value;
      expect(call<number>(engine, "resolveIncrementalMaxDepth")).toBe(expected);
    }
    expect(call<number>(engine, "resolveFanoutForDepth", 0, false)).toBe(cfg.leafMinFanout);
    expect(call<number>(engine, "resolveFanoutForDepth", 1, false)).toBe(cfg.condensedMinFanout);
    expect(call<number>(engine, "resolveFanoutForDepth", 0, true)).toBe(cfg.condensedMinFanoutHard);
    expect(call<number>(engine, "resolveCondensedMinChunkTokens")).toBe(2);
  });

  it("resolves fresh-tail ordinals across empty, summary-only, and bounded contexts", () => {
    const { engine, cfg } = fixture();
    cfg.freshTailCount = 0;
    expect(call<number>(engine, "resolveFreshTailOrdinal", [])).toBe(Infinity);
    cfg.freshTailCount = 2;
    expect(call<number>(engine, "resolveFreshTailOrdinal", [item(0, "summary", "s")])).toBe(Infinity);
    expect(call<number>(engine, "resolveFreshTailOrdinal", [item(1, "message", 1), item(2, "message", 2), item(3, "message", 3)])).toBe(2);
  });

  it("resolves stored and estimated message and summary token counts", async () => {
    const { engine, conversations } = fixture();
    conversations.getMessageById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(message(1, 3))
      .mockResolvedValueOnce(message(2, 0, "12345"));
    await expect(call<Promise<number>>(engine, "getMessageTokenCount", 1)).resolves.toBe(0);
    await expect(call<Promise<number>>(engine, "getMessageTokenCount", 1)).resolves.toBe(3);
    await expect(call<Promise<number>>(engine, "getMessageTokenCount", 2)).resolves.toBe(2);
    expect(call<number>(engine, "resolveMessageTokenCount", message(1, 3))).toBe(3);
    expect(call<number>(engine, "resolveMessageTokenCount", message(1, Number.NaN, "12345"))).toBe(2);
    expect(call<number>(engine, "resolveSummaryTokenCount", summary("s", 0, 3))).toBe(3);
    expect(call<number>(engine, "resolveSummaryTokenCount", summary("s", 0, 0))).toBe(3);
  });
});

describe("selection and prior-context boundaries", () => {
  it("counts raw tokens before the fresh tail while skipping summaries and missing IDs", async () => {
    const { engine, summaries, conversations } = fixture({ freshTailCount: 1 });
    summaries.getContextItems.mockResolvedValue([
      item(0, "summary", "s"), item(1, "message", 1), { ...item(2, "message", 2), messageId: null }, item(3, "message", 3),
    ]);
    conversations.getMessageById.mockImplementation(async (id) => message(id, 2));
    await expect(call<Promise<number>>(engine, "countRawTokensOutsideFreshTail", 1)).resolves.toBe(2);
    await expect(engine.evaluateLeafTrigger(1)).resolves.toMatchObject({ rawTokensOutsideTail: 2, shouldCompact: false });
  });

  it("selects the oldest contiguous leaf chunk at token boundaries", async () => {
    const { engine, summaries, conversations } = fixture({ freshTailCount: 1, leafChunkTokens: 3 });
    summaries.getContextItems.mockResolvedValue([
      item(0, "summary", "prior"), item(1, "message", 1), item(2, "message", 2), item(3, "summary", "stop"), item(4, "message", 4),
    ]);
    conversations.getMessageById.mockImplementation(async (id) => message(id, 2));
    await expect(call<Promise<{ items: ContextItemRecord[]; rawTokensOutsideTail: number }>>(engine, "selectOldestLeafChunk", 1))
      .resolves.toMatchObject({ items: [{ ordinal: 1 }], rawTokensOutsideTail: 4 });
  });

  it.each([
    [
      [item(0, "message", 1), item(1, "message", 2)],
      { freshTailCount: 1, leafChunkTokens: 10 },
      1,
    ],
    [
      [item(0, "message", 1), item(1, "summary", "stop")],
      { freshTailCount: 0, leafChunkTokens: 10 },
      1,
    ],
    [
      [item(0, "message", 1), item(1, "message", 2), item(2, "message", 3)],
      { freshTailCount: 0, leafChunkTokens: 2 },
      1,
    ],
  ] as const)("covers leaf selection stop case %#", async (items, overrides, expectedItems) => {
    const { engine, summaries, conversations } = fixture(overrides);
    summaries.getContextItems.mockResolvedValue([...items]);
    conversations.getMessageById.mockImplementation(async (id) => message(id, 2));
    const result = await call<Promise<{ items: ContextItemRecord[] }>>(engine, "selectOldestLeafChunk", 1);
    expect(result.items).toHaveLength(expectedItems);
  });

  it("resolves prior leaf summaries and ignores missing, blank, and invalid entries", async () => {
    const { engine, summaries } = fixture();
    await expect(call<Promise<string | undefined>>(engine, "resolvePriorLeafSummaryContext", 1, [])).resolves.toBeUndefined();
    summaries.getContextItems.mockResolvedValue([item(0, "summary", "a"), item(1, "summary", "b"), item(2, "message", 1)]);
    summaries.getSummary.mockImplementation(async (id) => id === "a" ? summary("a") : { ...summary("b"), content: " " });
    await expect(call<Promise<string | undefined>>(engine, "resolvePriorLeafSummaryContext", 1, [item(2, "message", 1)])).resolves.toBe("a content");
    summaries.getContextItems.mockResolvedValue([]);
    await expect(call<Promise<string | undefined>>(engine, "resolvePriorLeafSummaryContext", 1, [item(2, "message", 1)])).resolves.toBeUndefined();
    summaries.getContextItems.mockResolvedValue([item(0, "summary", "blank"), item(2, "message", 1)]);
    summaries.getSummary.mockResolvedValue({ ...summary("blank"), content: " " });
    await expect(call<Promise<string | undefined>>(engine, "resolvePriorLeafSummaryContext", 1, [item(2, "message", 1)])).resolves.toBeUndefined();
  });

  it("selects same-depth summary chunks and candidate fanout/token thresholds", async () => {
    const { engine, summaries } = fixture({ freshTailCount: 0, leafChunkTokens: 5, condensedTargetTokens: 1 });
    summaries.getContextItems.mockResolvedValue([
      item(0, "message", 1), item(1, "summary", "missing"), item(2, "summary", "wrong"),
      item(3, "summary", "a"), item(4, "summary", "b"), item(5, "message", 2),
    ]);
    summaries.getSummary.mockImplementation(async (id) => {
      if (id === "missing") return null;
      if (id === "wrong") return summary("wrong", 1, 1);
      return summary(String(id), 0, id === "a" ? 3 : 3);
    });
    const chunk = await call<Promise<{ items: ContextItemRecord[]; summaryTokens: number }>>(engine, "selectOldestChunkAtDepth", 1, 0);
    expect(chunk).toMatchObject({ items: [{ ordinal: 3 }], summaryTokens: 3 });

    summaries.getDistinctDepthsInContext.mockResolvedValue([1, 0]);
    vi.spyOn(engine as never, "selectOldestChunkAtDepth" as never)
      .mockResolvedValueOnce({ items: [], summaryTokens: 0 } as never)
      .mockResolvedValueOnce({ items: [item(1, "summary", "a"), item(2, "summary", "b")], summaryTokens: 5 } as never);
    await expect(call<Promise<object | null>>(engine, "selectShallowestCondensationCandidate", { conversationId: 1, hardTrigger: false }))
      .resolves.toMatchObject({ targetDepth: 0 });
  });

  it("rejects candidates below the token threshold", async () => {
    const { engine, summaries } = fixture({ condensedTargetTokens: 5, leafMinFanout: 1 });
    summaries.getDistinctDepthsInContext.mockResolvedValue([0]);
    const privateEngine = engine as unknown as Record<string, (...args: unknown[]) => unknown>;
    privateEngine.selectOldestChunkAtDepth = vi.fn(async () => ({ items: [item(0, "summary", "a")], summaryTokens: 1 }));
    await expect(call<Promise<object | null>>(engine, "selectShallowestCondensationCandidate", { conversationId: 1, hardTrigger: false })).resolves.toBeNull();
  });

  it.each([
    ["fresh tail", [item(0, "summary", "a"), item(1, "message", 1)], { freshTailCount: 1, leafChunkTokens: 10 }],
    ["non-summary after start", [item(0, "summary", "a"), item(1, "message", 1)], { freshTailCount: 0, leafChunkTokens: 10 }],
    ["missing after start", [item(0, "summary", "a"), item(1, "summary", "missing")], { freshTailCount: 0, leafChunkTokens: 10 }],
    ["wrong depth after start", [item(0, "summary", "a"), item(1, "summary", "wrong")], { freshTailCount: 0, leafChunkTokens: 10 }],
    ["exact budget", [item(0, "summary", "a")], { freshTailCount: 0, leafChunkTokens: 2 }],
  ] as const)("stops a summary chunk at %s", async (_label, items, overrides) => {
    const { engine, summaries } = fixture(overrides);
    summaries.getContextItems.mockResolvedValue([...items]);
    summaries.getSummary.mockImplementation(async (id) => id === "missing" ? null : summary(String(id), id === "wrong" ? 1 : 0, 2));
    const result = await call<Promise<{ items: ContextItemRecord[] }>>(engine, "selectOldestChunkAtDepth", 1, 0);
    expect(result.items).toHaveLength(1);
  });

  it("resolves prior same-depth context", async () => {
    const { engine, summaries } = fixture();
    await expect(call<Promise<string | undefined>>(engine, "resolvePriorSummaryContextAtDepth", 1, [], 0)).resolves.toBeUndefined();
    summaries.getContextItems.mockResolvedValue([item(0, "summary", "wrong"), item(1, "summary", "a"), item(2, "summary", "blank"), item(3, "summary", "current")]);
    summaries.getSummary.mockImplementation(async (id) => {
      if (id === "wrong") return summary("wrong", 1);
      if (id === "blank") return { ...summary("blank"), content: " " };
      return summary(String(id));
    });
    await expect(call<Promise<string | undefined>>(engine, "resolvePriorSummaryContextAtDepth", 1, [item(3, "summary", "current")], 0)).resolves.toBe("a content");
    summaries.getContextItems.mockResolvedValue([]);
    await expect(call<Promise<string | undefined>>(engine, "resolvePriorSummaryContextAtDepth", 1, [item(3, "summary", "current")], 0)).resolves.toBeUndefined();
    summaries.getContextItems.mockResolvedValue([item(0, "summary", "wrong"), item(3, "summary", "current")]);
    summaries.getSummary.mockResolvedValue(summary("wrong", 1));
    await expect(call<Promise<string | undefined>>(engine, "resolvePriorSummaryContextAtDepth", 1, [item(3, "summary", "current")], 0)).resolves.toBeUndefined();
  });
});

describe("summarization escalation", () => {
  it("covers scrubbed-empty, normal, aggressive, and both fallback sizes", async () => {
    const empty = fixture({ scrubber: { scrub: () => "" } as never }).engine;
    await expect(call<Promise<object>>(empty, "summarizeWithEscalation", { sourceText: "secret", summarize: async () => "x" }))
      .resolves.toEqual({ content: "[Truncated from 0 tokens]", level: "fallback" });

    const { engine } = fixture();
    await expect(call<Promise<object>>(engine, "summarizeWithEscalation", { sourceText: "12345678", summarize: async () => "x" }))
      .resolves.toEqual({ content: "x", level: "normal" });
    let calls = 0;
    await expect(call<Promise<object>>(engine, "summarizeWithEscalation", {
      sourceText: "12345678", summarize: async () => ++calls === 1 ? "12345678" : "x",
    })).resolves.toEqual({ content: "x", level: "aggressive" });
    await expect(call<Promise<{ content: string; level: string }>>(engine, "summarizeWithEscalation", {
      sourceText: "short", summarize: async () => "unchanged",
    })).resolves.toMatchObject({ content: expect.stringContaining("[Truncated from 2 tokens]"), level: "fallback" });
    await expect(call<Promise<{ content: string; level: string }>>(engine, "summarizeWithEscalation", {
      sourceText: "x".repeat(3000), summarize: async () => "x".repeat(3000),
    })).resolves.toMatchObject({ content: expect.stringContaining("[Truncated from 750 tokens]"), level: "fallback" });
  });
});

describe("leaf and condensed persistence passes", () => {
  it("persists leaf messages, timestamps, file IDs, context range, and aggregate tokens", async () => {
    const { engine, conversations, summaries } = fixture();
    const first = { ...message(1, -2, "first file_AABBCCDDEEFF0011"), createdAt: new Date(now.getTime() - 1000) };
    const second = { ...message(2, 3, "second file_aabbccddeeff0011"), createdAt: now };
    conversations.getMessageById.mockImplementation(async (id) => id === 1 ? first : id === 2 ? second : null);
    const result = await call<Promise<{ summaryId: string; content: string }>>(engine, "leafPass", 1, [
      { ...item(0, "message", 1), messageId: null }, item(1, "message", 99), item(2, "message", 1), item(3, "message", 2),
    ], async () => "leaf summary", "prior");
    expect(result.summaryId).toMatch(/^sum_/);
    expect(summaries.insertSummary).toHaveBeenCalledWith(expect.objectContaining({
      kind: "leaf", fileIds: ["file_aabbccddeeff0011"], earliestAt: first.createdAt,
      latestAt: second.createdAt, sourceMessageTokenCount: 10,
    }));
    expect(summaries.linkSummaryToMessages).toHaveBeenCalledWith(result.summaryId, [1, 2]);
    expect(summaries.replaceContextRangeWithSummary).toHaveBeenCalledWith(expect.objectContaining({ startOrdinal: 0, endOrdinal: 3 }));
  });

  it("persists an empty leaf selection through deterministic fallback metadata", async () => {
    const { engine, summaries } = fixture();
    await call<Promise<object>>(engine, "leafPass", 1, [item(4, "message", 4)], async () => "summary");
    expect(summaries.insertSummary).toHaveBeenCalledWith(expect.objectContaining({
      earliestAt: undefined, latestAt: undefined, sourceMessageTokenCount: 0,
    }));
  });

  it("persists condensed lineage, time range, files, and valid/invalid descendant metrics", async () => {
    const { engine, summaries } = fixture();
    const a = {
      ...summary("a", 0, -2), content: "a file_AABBCCDDEEFF0011", fileIds: ["file_existing"],
      earliestAt: new Date(now.getTime() - 2000), latestAt: null,
      descendantCount: 2.9, descendantTokenCount: 4.9, sourceMessageTokenCount: 5.9,
    };
    const b = {
      ...summary("b", 0, 3), earliestAt: null, latestAt: new Date(now.getTime() + 1000),
      descendantCount: Number.NaN, descendantTokenCount: Number.NaN, sourceMessageTokenCount: Number.NaN,
    };
    summaries.getSummary.mockImplementation(async (id) => id === "a" ? a : id === "b" ? b : null);
    summaries.getContextItems.mockResolvedValue([]);
    const result = await call<Promise<{ summaryId: string }>>(engine, "condensedPass", 1, [
      { ...item(0, "summary", "a"), summaryId: null }, item(1, "summary", "missing"), item(2, "summary", "a"), item(3, "summary", "b"),
    ], 0, async () => "condensed");
    expect(summaries.insertSummary).toHaveBeenCalledWith(expect.objectContaining({
      kind: "condensed", depth: 1,
      fileIds: ["file_existing", "file_aabbccddeeff0011"],
      earliestAt: a.earliestAt, latestAt: b.latestAt,
      descendantCount: 4, descendantTokenCount: 7, sourceMessageTokenCount: 5,
    }));
    expect(summaries.linkSummaryToParents).toHaveBeenCalledWith(result.summaryId, ["a", "b"]);
    expect(summaries.replaceContextRangeWithSummary).toHaveBeenCalledWith(expect.objectContaining({ startOrdinal: 0, endOrdinal: 3 }));
  });

  it("persists empty higher-depth condensation metadata", async () => {
    const { engine, summaries } = fixture();
    await call<Promise<object>>(engine, "condensedPass", 1, [item(5, "summary", "missing")], 2, async () => "summary");
    expect(summaries.insertSummary).toHaveBeenCalledWith(expect.objectContaining({
      depth: 3, earliestAt: undefined, latestAt: undefined,
      descendantCount: 0, descendantTokenCount: 0, sourceMessageTokenCount: 0,
    }));
  });
});

describe("durable compaction events", () => {
  const base = {
    conversationId: 1, tokensBefore: 10, tokensAfterLeaf: 7, tokensAfterFinal: 3,
  };

  it("returns for empty results or missing conversations", async () => {
    const { engine, conversations } = fixture();
    await call<Promise<void>>(engine, "persistCompactionEvents", { ...base, leafResult: null, condenseResult: null });
    expect(conversations.getConversation).not.toHaveBeenCalled();
    await call<Promise<void>>(engine, "persistCompactionEvents", {
      ...base, leafResult: { summaryId: "leaf", level: "normal" }, condenseResult: null,
    });
    expect(conversations.createMessage).not.toHaveBeenCalled();
  });

  it("writes leaf and condensed events with shared created summary IDs", async () => {
    const { engine, conversations } = fixture();
    conversations.getConversation.mockResolvedValue({ conversationId: 1, sessionId: "session" } as never);
    await call<Promise<void>>(engine, "persistCompactionEvents", {
      ...base,
      leafResult: { summaryId: "leaf", level: "normal" },
      condenseResult: { summaryId: "condensed", level: "aggressive" },
    });
    expect(conversations.createMessage).toHaveBeenCalledTimes(2);
    expect(conversations.createMessageParts).toHaveBeenCalledTimes(2);
    const metadata = JSON.parse(conversations.createMessageParts.mock.calls[0][1][0].metadata!);
    expect(metadata).toMatchObject({ createdSummaryIds: ["leaf", "condensed"], condensedPassOccurred: true });
  });

  it("writes a condensed-only event and swallows transaction failures", async () => {
    const { engine, conversations } = fixture();
    conversations.getConversation.mockResolvedValue({ conversationId: 1, sessionId: "session" } as never);
    conversations.withTransaction.mockRejectedValueOnce(new Error("write failed"));
    await expect(call<Promise<void>>(engine, "persistCompactionEvents", {
      ...base, leafResult: null, condenseResult: { summaryId: "condensed", level: "fallback" },
    })).resolves.toBeUndefined();
  });
});

describe("compactLeaf orchestration", () => {
  const summarize = async () => "summary";

  it("does nothing below all triggers or when no leaf chunk exists", async () => {
    const { engine, summaries } = fixture();
    summaries.getContextTokenCount.mockResolvedValue(1);
    await expect(engine.compactLeaf({ conversationId: 1, tokenBudget: 10, summarize })).resolves.toMatchObject({ actionTaken: false });
    await expect(engine.compactLeaf({ conversationId: 1, tokenBudget: 10, summarize, force: true })).resolves.toMatchObject({ actionTaken: false });
  });

  it("runs one leaf pass with resolved prior context and no incremental phase", async () => {
    const { engine, summaries } = fixture();
    summaries.getContextTokenCount.mockResolvedValueOnce(10).mockResolvedValue(4);
    const privateEngine = engine as unknown as Record<string, (...args: unknown[]) => unknown>;
    privateEngine.selectOldestLeafChunk = vi.fn(async () => ({ items: [item(1, "message", 1)], rawTokensOutsideTail: 2, threshold: 10 }));
    privateEngine.resolvePriorLeafSummaryContext = vi.fn(async () => "prior");
    privateEngine.leafPass = vi.fn(async () => ({ summaryId: "leaf", level: "normal", content: "summary" }));
    privateEngine.persistCompactionEvents = vi.fn(async () => undefined);
    await expect(engine.compactLeaf({ conversationId: 1, tokenBudget: 10, summarize, force: true })).resolves.toMatchObject({
      actionTaken: true, tokensAfter: 4, createdSummaryId: "leaf", condensed: false,
    });
    expect(privateEngine.leafPass).toHaveBeenCalledWith(1, expect.any(Array), summarize, "prior");
  });

  it("runs incremental condensation and stops on no progress", async () => {
    const { engine, summaries } = fixture({ incrementalMaxDepth: 2, leafMinFanout: 1, condensedMinFanout: 1, condensedTargetTokens: 1 });
    summaries.getContextTokenCount
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(8);
    const privateEngine = engine as unknown as Record<string, (...args: unknown[]) => unknown>;
    privateEngine.selectOldestLeafChunk = vi.fn(async () => ({ items: [item(1, "message", 1)], rawTokensOutsideTail: 2, threshold: 10 }));
    privateEngine.leafPass = vi.fn(async () => ({ summaryId: "leaf", level: "normal", content: "summary" }));
    privateEngine.selectOldestChunkAtDepth = vi.fn(async () => ({ items: [item(1, "summary", "leaf")], summaryTokens: 2 }));
    privateEngine.condensedPass = vi.fn(async () => ({ summaryId: "condensed", level: "aggressive" }));
    privateEngine.persistCompactionEvents = vi.fn(async () => undefined);
    await expect(engine.compactLeaf({ conversationId: 1, tokenBudget: 10, summarize, force: true, previousSummaryContent: "seed" })).resolves.toMatchObject({
      actionTaken: true, condensed: true, createdSummaryId: "condensed", level: "aggressive",
    });
  });

  it("stops incremental condensation for insufficient fanout or token volume", async () => {
    for (const chunk of [
      { items: [] as ContextItemRecord[], summaryTokens: 10 },
      { items: [item(1, "summary", "leaf"), item(2, "summary", "leaf2")], summaryTokens: 0 },
    ]) {
      const { engine, summaries } = fixture({ incrementalMaxDepth: 1, leafMinFanout: 2 });
      summaries.getContextTokenCount.mockResolvedValueOnce(10).mockResolvedValue(8);
      const privateEngine = engine as unknown as Record<string, (...args: unknown[]) => unknown>;
      privateEngine.selectOldestLeafChunk = vi.fn(async () => ({ items: [item(1, "message", 1)], rawTokensOutsideTail: 2, threshold: 10 }));
      privateEngine.leafPass = vi.fn(async () => ({ summaryId: "leaf", level: "normal", content: "summary" }));
      privateEngine.selectOldestChunkAtDepth = vi.fn(async () => chunk);
      privateEngine.persistCompactionEvents = vi.fn(async () => undefined);
      await expect(engine.compactLeaf({ conversationId: 1, tokenBudget: 10, summarize, force: true })).resolves.toMatchObject({ condensed: false });
    }
  });

  it("continues incremental condensation while each depth makes progress", async () => {
    const { engine, summaries } = fixture({ incrementalMaxDepth: 2, leafMinFanout: 1, condensedMinFanout: 1, condensedTargetTokens: 1 });
    summaries.getContextTokenCount
      .mockResolvedValueOnce(12).mockResolvedValueOnce(10)
      .mockResolvedValueOnce(10).mockResolvedValueOnce(8)
      .mockResolvedValueOnce(8).mockResolvedValueOnce(6);
    const privateEngine = engine as unknown as Record<string, (...args: unknown[]) => unknown>;
    privateEngine.selectOldestLeafChunk = vi.fn(async () => ({ items: [item(0, "message", 1)], rawTokensOutsideTail: 2, threshold: 10 }));
    privateEngine.leafPass = vi.fn(async () => ({ summaryId: "leaf", level: "normal", content: "leaf" }));
    privateEngine.selectOldestChunkAtDepth = vi.fn(async (_id, depth) => ({ items: [item(0, "summary", `s${depth}`)], summaryTokens: 2 }));
    privateEngine.condensedPass = vi.fn(async (_id, _items, depth) => ({ summaryId: `c${depth}`, level: "normal" }));
    privateEngine.persistCompactionEvents = vi.fn(async () => undefined);
    await expect(engine.compactLeaf({ conversationId: 1, tokenBudget: 10, summarize, force: true })).resolves.toMatchObject({ tokensAfter: 6, createdSummaryId: "c1" });
  });
});

describe("full-sweep orchestration", () => {
  const summarize = async () => "summary";

  it("does nothing below triggers or with empty context", async () => {
    const { engine, summaries } = fixture();
    summaries.getContextTokenCount.mockResolvedValue(1);
    await expect(engine.compactFullSweep({ conversationId: 1, tokenBudget: 10, summarize })).resolves.toMatchObject({ actionTaken: false });
    await expect(engine.compactFullSweep({ conversationId: 1, tokenBudget: 10, summarize, force: true })).resolves.toMatchObject({ actionTaken: false });
  });

  it("runs leaf and condensed phases with seed truncation and hard fanout", async () => {
    const { engine, summaries } = fixture();
    summaries.getContextItems.mockResolvedValue([item(0, "message", 1)]);
    summaries.getContextTokenCount
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(20).mockResolvedValueOnce(10)
      .mockResolvedValueOnce(10).mockResolvedValueOnce(5)
      .mockResolvedValueOnce(5);
    const privateEngine = engine as unknown as Record<string, (...args: unknown[]) => unknown>;
    privateEngine.selectOldestLeafChunk = vi.fn()
      .mockResolvedValueOnce({ items: [item(0, "message", 1)], rawTokensOutsideTail: 2, threshold: 10 })
      .mockResolvedValueOnce({ items: [], rawTokensOutsideTail: 0, threshold: 10 });
    privateEngine.leafPass = vi.fn(async () => ({ summaryId: "leaf", level: "normal", content: "leaf content" }));
    privateEngine.selectShallowestCondensationCandidate = vi.fn()
      .mockResolvedValueOnce({ targetDepth: 0, chunk: { items: [item(0, "summary", "leaf")], summaryTokens: 3 } })
      .mockResolvedValueOnce(null);
    privateEngine.condensedPass = vi.fn(async () => ({ summaryId: "condensed", level: "aggressive" }));
    privateEngine.persistCompactionEvents = vi.fn(async () => undefined);
    await expect(engine.compactFullSweep({
      conversationId: 1, tokenBudget: 10, summarize, force: true, hardTrigger: true,
      previousSummaryContent: "x".repeat(60_000),
    })).resolves.toMatchObject({ actionTaken: true, condensed: true, createdSummaryId: "condensed", tokensAfter: 5 });
    expect(privateEngine.leafPass).toHaveBeenCalledWith(1, expect.any(Array), summarize, "x".repeat(50_000));
    expect(privateEngine.selectShallowestCondensationCandidate).toHaveBeenCalledWith({ conversationId: 1, hardTrigger: true });
  });

  it("stops leaf and condensed phases independently on no progress", async () => {
    const { engine, summaries } = fixture();
    summaries.getContextItems.mockResolvedValue([item(0, "message", 1)]);
    summaries.getContextTokenCount.mockResolvedValue(10);
    const privateEngine = engine as unknown as Record<string, (...args: unknown[]) => unknown>;
    privateEngine.selectOldestLeafChunk = vi.fn(async () => ({ items: [item(0, "message", 1)], rawTokensOutsideTail: 2, threshold: 10 }));
    privateEngine.resolvePriorLeafSummaryContext = vi.fn(async () => undefined);
    privateEngine.leafPass = vi.fn(async () => ({ summaryId: "leaf", level: "normal", content: "leaf" }));
    privateEngine.selectShallowestCondensationCandidate = vi.fn(async () => ({ targetDepth: 0, chunk: { items: [item(0, "summary", "leaf")], summaryTokens: 3 } }));
    privateEngine.condensedPass = vi.fn(async () => ({ summaryId: "condensed", level: "normal" }));
    privateEngine.persistCompactionEvents = vi.fn(async () => undefined);
    await expect(engine.compactFullSweep({ conversationId: 1, tokenBudget: 10, summarize, force: true })).resolves.toMatchObject({ condensed: true });
  });

  it("runs multiple progressing leaf passes before selection is exhausted", async () => {
    const { engine, summaries } = fixture();
    summaries.getContextItems.mockResolvedValue([item(0, "message", 1)]);
    summaries.getContextTokenCount
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(20).mockResolvedValueOnce(15)
      .mockResolvedValueOnce(15).mockResolvedValueOnce(10)
      .mockResolvedValueOnce(10);
    const privateEngine = engine as unknown as Record<string, (...args: unknown[]) => unknown>;
    privateEngine.selectOldestLeafChunk = vi.fn()
      .mockResolvedValueOnce({ items: [item(0, "message", 1)], rawTokensOutsideTail: 2, threshold: 10 })
      .mockResolvedValueOnce({ items: [item(1, "message", 2)], rawTokensOutsideTail: 2, threshold: 10 })
      .mockResolvedValueOnce({ items: [], rawTokensOutsideTail: 0, threshold: 10 });
    privateEngine.resolvePriorLeafSummaryContext = vi.fn(async () => undefined);
    privateEngine.leafPass = vi.fn(async (_id, items) => ({ summaryId: `leaf${(items as ContextItemRecord[])[0].ordinal}`, level: "normal", content: "leaf" }));
    privateEngine.selectShallowestCondensationCandidate = vi.fn(async () => null);
    privateEngine.persistCompactionEvents = vi.fn(async () => undefined);
    await expect(engine.compactFullSweep({ conversationId: 1, tokenBudget: 10, summarize, force: true })).resolves.toMatchObject({ createdSummaryId: "leaf1", tokensAfter: 10 });
  });
});
