import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecallStats } from "../src/stats.js";

interface FakeDatabaseState {
  readonly project: string;
}

interface FakeStaleQuery {
  staleAfterDays: number;
  staleSurfacingWithoutUseLimit: number;
  projectId: string;
}

interface CountRow { count: number }
interface MessageStatsRow extends CountRow { tokens: number }
interface SummaryStatsRow extends MessageStatsRow { maxDepth: number }
interface RedactionRow { category: string; count: number }
interface ConversationRow {
  conversation_id: number;
  messages: number;
  summaries: number;
  max_depth: number;
  raw_tokens: number;
  summary_tokens: number;
}

type FakeGetRow = CountRow | MessageStatsRow | SummaryStatsRow;
type FakeAllRow = RedactionRow | ConversationRow;

interface FakeStatement {
  get(): FakeGetRow;
  all(): FakeAllRow[];
}

const mocks = vi.hoisted(() => ({
  baseExists: true,
  configError: null as Error | null,
  configBackend: "sqlite" as "sqlite" | "postgresql",
  eventsFail: false,
  entries: [] as Array<{ name: string; directory: boolean; dbExists: boolean }>,
  close: vi.fn<(project: string) => void>(),
  migrate: vi.fn<(db: FakeDatabaseState) => void>(),
  collectEvents: vi.fn<(maxDbs: number) => void>(),
  loadConfig: vi.fn<(path: string) => void>(),
  selectBackend: vi.fn<(backend: "sqlite" | "postgresql") => void>(),
  findStale: vi.fn<(args: FakeStaleQuery) => unknown[]>(),
  getRecallStats: vi.fn<() => RecallStats>(),
}));

const projects = new Map<string, {
  messages: number; messageTokens: number; summaries: number; summaryTokens: number; maxDepth: number;
  promoted: number; redactions: RedactionRow[];
  conversations: ConversationRow[];
}>();

vi.mock("node:fs", () => ({
  existsSync: (path: string) => path === "/coverage/projects"
    ? mocks.baseExists
    : mocks.entries.some((entry) => path === `/coverage/projects/${entry.name}/db.sqlite` && entry.dbExists),
  readdirSync: () => mocks.entries.map((entry) => ({ name: entry.name, isDirectory: () => entry.directory })),
}));
vi.mock("../src/runtime-paths.js", () => ({
  configPath: () => "/coverage/config.json",
  projectsDir: () => "/coverage/projects",
}));
vi.mock("../src/daemon/config.js", () => ({
  loadDaemonConfig: (path: string): {
    storage: { backend: "sqlite" | "postgresql" };
    restoration: { staleAfterDays: number; staleSurfacingWithoutUseLimit: number };
  } => {
    mocks.loadConfig(path);
    if (mocks.configError !== null) throw mocks.configError;
    return {
      storage: { backend: mocks.configBackend },
      restoration: { staleAfterDays: 12, staleSurfacingWithoutUseLimit: 3 },
    };
  },
}));
vi.mock("../src/storage/backend.js", () => ({
  selectStorageBackend: ({ backend }: { backend: "sqlite" | "postgresql" }) => {
    mocks.selectBackend(backend);
    if (backend === "postgresql") throw new Error("PostgreSQL backend rejected");
    return { backend: "sqlite" as const };
  },
}));
vi.mock("../src/db/migration.js", () => ({
  runLcmMigrations: (db: FakeDatabaseState): void => mocks.migrate(db),
}));
vi.mock("../src/db/events-stats.js", () => ({
  collectEventStats: async (maxDbs: number): Promise<{ captured: number; unprocessed: number; errors: number }> => {
    mocks.collectEvents(maxDbs);
    if (mocks.eventsFail) throw new Error("event db broken");
    return { captured: 9, unprocessed: 2, errors: 1 };
  },
}));
vi.mock("../src/db/recall.js", () => ({
  RecallStore: class { getStats(): RecallStats { return mocks.getRecallStats(); } },
}));
vi.mock("../src/db/promoted.js", () => ({
  PromotedStore: class { findStale(args: FakeStaleQuery): unknown[] { return mocks.findStale(args); } },
}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    readonly project: string;
    constructor(path: string) { this.project = path.split("/").at(-2)!; }
    exec(): void {}
    close(): void { mocks.close(this.project); }
    prepare(sql: string): FakeStatement {
      const data = projects.get(this.project)!;
      return {
        get(): FakeGetRow {
          if (sql.includes("FROM messages")) return { count: data.messages, tokens: data.messageTokens };
          if (sql.includes("FROM summaries")) return { count: data.summaries, tokens: data.summaryTokens, maxDepth: data.maxDepth };
          return { count: data.promoted };
        },
        all(): FakeAllRow[] {
          return sql.includes("redaction_stats") ? data.redactions : data.conversations;
        },
      };
    }
  },
}));

import { collectStats, formatNumber, formatRatio, printStats } from "../src/stats.js";
import { BackendPublicationJournalError } from "../src/storage/backend-publication.js";

type Stats = Parameters<typeof printStats>[0];

describe("stats service coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.baseExists = true;
    mocks.configError = null;
    mocks.configBackend = "sqlite";
    mocks.eventsFail = false;
    mocks.entries = [];
    projects.clear();
    mocks.getRecallStats.mockReturnValue({ memoriesSurfaced: 0, memoriesActedUpon: 0, recallPrecision: null, topRecalled: [] });
    mocks.findStale.mockReturnValue([]);
  });

  it("formats all numeric boundaries", () => {
    expect([formatNumber(1), formatNumber(1000), formatNumber(1_000_000)]).toEqual(["1", "1.0k", "1.0M"]);
    expect([formatRatio(10, 2), formatRatio(0, 2), formatRatio(2, 0)]).toEqual(["5.0", "–", "–"]);
  });

  it("returns the empty aggregate when the projects directory is absent", async () => {
    mocks.baseExists = false;
    expect(await collectStats()).toMatchObject({ projects: 0, messages: 0, staleCount: 0 });
    expect(mocks.collectEvents).not.toHaveBeenCalled();
    expect(mocks.selectBackend).toHaveBeenCalledWith("sqlite");
  });

  it("fails closed before the empty-projects return for publication errors and PostgreSQL", async () => {
    mocks.baseExists = false;
    mocks.configError = new BackendPublicationJournalError(
      "unresolved-publication",
      "backend publication is unresolved",
    );
    await expect(collectStats()).rejects.toMatchObject({ reason: "unresolved-publication" });
    expect(mocks.selectBackend).not.toHaveBeenCalled();

    mocks.configError = null;
    mocks.configBackend = "postgresql";
    await expect(collectStats()).rejects.toThrow("PostgreSQL backend rejected");
    expect(mocks.selectBackend).toHaveBeenCalledWith("postgresql");
    expect(mocks.collectEvents).not.toHaveBeenCalled();
  });

  it("aggregates valid projects while skipping directories, missing databases, empty projects, and corrupt databases", async () => {
    mocks.entries = [
      { name: "file", directory: false, dbExists: false },
      { name: "missing", directory: true, dbExists: false },
      { name: "empty", directory: true, dbExists: true },
      { name: "alpha", directory: true, dbExists: true },
      { name: "beta", directory: true, dbExists: true },
      { name: "corrupt", directory: true, dbExists: true },
    ];
    projects.set("empty", { messages: 0, messageTokens: 0, summaries: 0, summaryTokens: 0, maxDepth: 0, promoted: 0, redactions: [], conversations: [] });
    projects.set("alpha", {
      messages: 4, messageTokens: 110, summaries: 2, summaryTokens: 10, maxDepth: 2, promoted: 3,
      redactions: [{ category: "built_in", count: 2 }, { category: "global", count: 1 }, { category: "project", count: 4 }],
      conversations: [
        { conversation_id: 2, messages: 3, summaries: 2, max_depth: 2, raw_tokens: 100, summary_tokens: 10 },
        { conversation_id: 1, messages: 1, summaries: 0, max_depth: 0, raw_tokens: 10, summary_tokens: 0 },
      ],
    });
    projects.set("beta", {
      messages: 1, messageTokens: 5, summaries: 1, summaryTokens: 0, maxDepth: 3, promoted: 1,
      redactions: [],
      conversations: [{ conversation_id: 3, messages: 1, summaries: 1, max_depth: 3, raw_tokens: 0, summary_tokens: 0 }],
    });
    projects.set("corrupt", projects.get("empty")!);
    mocks.migrate.mockImplementation((db: FakeDatabaseState) => {
      if (db.project === "corrupt") throw new Error("corrupt");
    });
    mocks.getRecallStats
      .mockReturnValueOnce({ memoriesSurfaced: 0, memoriesActedUpon: 0, recallPrecision: null, topRecalled: [] })
      .mockReturnValueOnce({ memoriesSurfaced: 2, memoriesActedUpon: 4, recallPrecision: 100, topRecalled: [
        { id: "low", content: "low", actCount: 1 }, { id: "high", content: "high", actCount: 9 },
      ] })
      .mockReturnValueOnce({ memoriesSurfaced: 1, memoriesActedUpon: 0, recallPrecision: 0, topRecalled: [
        { id: "middle", content: "middle", actCount: 5 },
      ] });
    mocks.findStale.mockReturnValueOnce([1, 2]).mockImplementationOnce(() => { throw new Error("stale query"); });

    const result = await collectStats();
    expect(result).toMatchObject({
      projects: 2, conversations: 3, compactedConversations: 2, messages: 5, summaries: 3,
      maxDepth: 3, rawTokens: 100, summaryTokens: 10, ratio: 10, promotedCount: 4, staleCount: 0,
      redactionCounts: { builtIn: 2, global: 1, project: 4, total: 7 },
      eventsCaptured: 9, eventsUnprocessed: 2, eventsErrors: 1,
      recallStats: { memoriesSurfaced: 3, memoriesActedUpon: 4, recallPrecision: 100 },
    });
    expect(result.recallStats.topRecalled.map((entry) => entry.id)).toEqual(["high", "middle", "low"]);
    expect(mocks.close).toHaveBeenCalledTimes(4);
  });

  it("uses config and event fallbacks and produces a null global recall ratio", async () => {
    mocks.configError = new Error("config broken");
    mocks.eventsFail = true;
    mocks.entries = [{ name: "one", directory: true, dbExists: true }];
    projects.set("one", {
      messages: 1, messageTokens: 1, summaries: 0, summaryTokens: 0, maxDepth: 0, promoted: 0,
      redactions: [], conversations: [{ conversation_id: 1, messages: 1, summaries: 0, max_depth: 0, raw_tokens: 1, summary_tokens: 0 }],
    });
    const result = await collectStats();
    expect(result).toMatchObject({ ratio: 0, eventsCaptured: 0, recallStats: { recallPrecision: null } });
    expect(mocks.findStale).toHaveBeenCalledWith(expect.objectContaining({ staleAfterDays: 90, staleSurfacingWithoutUseLimit: 5 }));
  });

  it("prints every display section and conditional variant", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const base = {
      projects: 2, conversations: 2, compactedConversations: 1, messages: 2, summaries: 1, maxDepth: 2,
      rawTokens: 1000, summaryTokens: 10, ratio: 100, promotedCount: 1,
      conversationDetails: [
        { conversationId: 1, messages: 2, summaries: 1, maxDepth: 2, rawTokens: 1000, summaryTokens: 10, ratio: 100, promotedCount: 0 },
      ],
      redactionCounts: { builtIn: 1, global: 2, project: 3, total: 6 },
      eventsCaptured: 3, eventsUnprocessed: 1, eventsErrors: 1,
      recallStats: { memoriesSurfaced: 2, memoriesActedUpon: 1, recallPrecision: 50, topRecalled: [
        { id: "long", content: "x".repeat(70), actCount: 2 }, { id: "short", content: "short", actCount: 1 },
      ] }, staleCount: 2,
    } satisfies Stats;
    printStats(base, true);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Stale Memories");
    expect(output).toContain("Per Conversation");
    expect(output).toContain("…");
    expect(output).toContain("100.0x");

    log.mockClear();
    printStats({
      ...base, summaries: 1, rawTokens: 0, summaryTokens: 0, ratio: 0, eventsCaptured: 0,
      redactionCounts: { builtIn: 0, global: 0, project: 0, total: 0 },
      recallStats: { memoriesSurfaced: 0, memoriesActedUpon: 1, recallPrecision: null, topRecalled: [] },
      staleCount: 0, conversationDetails: [{ ...base.conversationDetails[0], ratio: 0 }],
    }, true);
    expect(log.mock.calls.flat().join("\n")).toContain("0.0% compressed");

    log.mockClear();
    printStats({
      ...base, summaries: 0, recallStats: { memoriesSurfaced: 0, memoriesActedUpon: 0, recallPrecision: null, topRecalled: [] },
      staleCount: 0, conversationDetails: [],
    }, true);
    expect(log.mock.calls.flat().join("\n")).not.toContain("Compression");
    log.mockRestore();
  });
});
