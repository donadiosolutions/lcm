import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { deduplicateAndInsert } from "../../src/promotion/dedup.js";
import type {
  LexicalSearchRepository,
  PromotedMemoryRepository,
} from "../../src/storage/contracts.js";
import type { PostgreSqlQueryOptions } from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlLexicalSearchDataError,
  type PostgreSqlLexicalSearchExecutor,
  PostgreSqlLexicalSearchRepository,
  type PostgreSqlLexicalSearchScopedExecutor,
} from "../../src/storage/postgresql/lexical-search-repository.js";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";

const projectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const memoryId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9030";
const secondMemoryId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9040";
const thirdMemoryId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9050";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

type QueryImplementation = (
  config: QueryConfig<unknown[]>,
  options: PostgreSqlQueryOptions
) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>;

function executor(
  implementation: QueryImplementation
): PostgreSqlLexicalSearchExecutor & {
  query: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(implementation);
  const database = {
    query,
    transaction: vi.fn(
      async (
        callback: Parameters<PostgreSqlLexicalSearchExecutor["transaction"]>[0]
      ) => callback(database)
    ),
  } as unknown as PostgreSqlLexicalSearchExecutor & {
    query: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
  return database;
}

function scopedExecutor(
  implementation: QueryImplementation
): PostgreSqlLexicalSearchScopedExecutor & {
  query: ReturnType<typeof vi.fn>;
  savepoint: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(implementation);
  const scoped = {
    transactionScope: "active",
    query,
    savepoint: vi.fn(
      async (
        callback: Parameters<
          PostgreSqlLexicalSearchScopedExecutor["savepoint"]
        >[0]
      ) => callback({ query })
    ),
  } as PostgreSqlLexicalSearchScopedExecutor & {
    query: ReturnType<typeof vi.fn>;
    savepoint: ReturnType<typeof vi.fn>;
  };
  return scoped;
}

function text(config: QueryConfig<unknown[]>): string {
  return typeof config.text === "string" ? config.text : "";
}

function timeoutRow(previous = "37s"): QueryResult<QueryResultRow> {
  return result([
    {
      previous_timeout: previous,
    },
  ]);
}

const messageRow = {
  message_id: "11",
  conversation_id: 7n,
  role: "user",
  snippet: "needle message",
  rank: 0.75,
  created_at: "2026-01-01T00:00:00.000Z",
};

const summaryRow = {
  summary_id: "summary-a",
  conversation_id: "7",
  kind: "leaf",
  snippet: "needle summary",
  rank: 0.5,
  created_at: new Date("2026-01-02T00:00:00.000Z"),
};

const promotedRow = {
  memory_id: memoryId,
  content: "needle memory",
  tags: ["one", "Two"],
  source_project_id: "source-a",
  session_id: null,
  confidence: 0.8,
  created_at: "2026-01-03T00:00:00.000Z",
  rank: -0.25,
};

const promotedFallbackRow = { ...promotedRow, rank: 0.25 };

describe("PostgreSQL lexical-search repository", () => {
  it("maps primary message, summary, and promoted rows with exact scoped SQL", async () => {
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("FROM lcm.messages")) {
        return result([
          messageRow,
          {
            ...messageRow,
            message_id: 12,
            role: "assistant",
            created_at: new Date("2026-01-01T01:00:00.000Z"),
          },
        ]);
      }
      if (sql.includes("FROM lcm.summaries")) {
        return result([
          summaryRow,
          {
            ...summaryRow,
            summary_id: "summary-b",
            kind: "condensed",
          },
        ]);
      }
      return result([
        promotedRow,
        {
          ...promotedRow,
          memory_id: secondMemoryId.toUpperCase(),
          session_id: "session-a",
          created_at: new Date("2026-01-03T01:00:00.000Z"),
        },
      ]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId.toUpperCase()
    );

    await expect(
      repository.searchMessages({
        query: "needle",
        mode: "full_text",
        conversationId: 7,
        since: new Date("2026-01-01T00:00:00.000Z"),
        before: new Date("2026-02-01T00:00:00.000Z"),
        limit: 2,
      })
    ).resolves.toEqual([
      {
        messageId: 11,
        conversationId: 7,
        role: "user",
        snippet: "needle message",
        rank: 0.75,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        messageId: 12,
        conversationId: 7,
        role: "assistant",
        snippet: "needle message",
        rank: 0.75,
        createdAt: new Date("2026-01-01T01:00:00.000Z"),
      },
    ]);
    await expect(
      repository.searchSummaries({
        query: "needle",
        mode: "full_text",
        conversationId: 7,
        limit: 2,
      })
    ).resolves.toMatchObject([
      { summaryId: "summary-a", kind: "leaf", conversationId: 7 },
      { summaryId: "summary-b", kind: "condensed", conversationId: 7 },
    ]);
    await expect(
      repository.searchPromoted("needle", 2, ["one"], "source-a")
    ).resolves.toMatchObject([
      {
        id: memoryId,
        tags: ["one", "Two"],
        projectId: "source-a",
        sessionId: null,
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: secondMemoryId,
        sessionId: "session-a",
      },
    ]);

    expect(database.transaction).toHaveBeenCalledTimes(3);
    for (const [config, options] of database.query.mock.calls) {
      const query = config as QueryConfig<unknown[]>;
      expect(query.text).toContain("lcm.");
      expect(query.text).not.toContain("needle");
      expect(options).toMatchObject({
        domain: "lexical-search",
        projectId,
      });
      expect(query.values?.[0]).toBe(projectId);
    }
    expect(database.query.mock.calls[0][0].values).toEqual([
      projectId,
      "needle",
      7,
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      2,
    ]);
    expect(database.query.mock.calls[2][0].values).toEqual([
      projectId,
      "needle",
      "source-a",
      ["one"],
      2,
    ]);
    const promotedSql = text(database.query.mock.calls[2][0]);
    expect(promotedSql).toContain(") AS relevance");
    expect(promotedSql).toContain(
      "OPERATOR(pg_catalog.-) ranked.relevance AS rank"
    );
    expect(promotedSql).toContain(
      "WHERE ranked.relevance OPERATOR(pg_catalog.>) 0::pg_catalog.float4"
    );
    expect(promotedSql).toContain(
      "ORDER BY\n  ranked.relevance DESC,\n  ranked.created_at DESC,\n  ranked.memory_id DESC"
    );
    expect(promotedSql).not.toContain("ORDER BY\n  ranked.rank DESC");
  });

  it("aligns primary headlines and trigram gates with database normalization", async () => {
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      return result([]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );
    const rawMultibyteQuery = "𝐚";

    await repository.searchMessages({
      query: rawMultibyteQuery,
      mode: "full_text",
    });
    await repository.searchSummaries({
      query: rawMultibyteQuery,
      mode: "full_text",
    });
    await repository.searchPromoted(rawMultibyteQuery, 5);

    const statements = database.query.mock.calls.map(
      ([config]) => config as QueryConfig<unknown[]>
    );
    const headlineStatements = statements.filter((config) =>
      text(config).includes("pg_catalog.ts_headline")
    );
    expect(headlineStatements).toHaveLength(2);
    expect(text(headlineStatements[0])).toMatch(
      /pg_catalog\.ts_headline\(\s*'lcm\.search_v1'::pg_catalog\.regconfig,\s*lcm\.normalize_search_text\(message\.content\),\s*input\.query,/u
    );
    expect(text(headlineStatements[1])).toMatch(
      /pg_catalog\.ts_headline\(\s*'lcm\.search_v1'::pg_catalog\.regconfig,\s*lcm\.normalize_search_text\(summary\.content\),\s*input\.query,/u
    );
    for (const config of headlineStatements) {
      expect(text(config)).toContain(
        "StartSel=, StopSel=, MaxWords=32, MinWords=8"
      );
      expect(text(config)).toContain("pg_catalog.left(");
    }

    const trigramStatements = statements.filter((config) =>
      text(config).includes("public.similarity")
    );
    expect(trigramStatements).toHaveLength(3);
    for (const config of trigramStatements) {
      const sql = text(config);
      const normalizedGate = sql.indexOf(
        "pg_catalog.octet_length(input.query)"
      );
      expect(config.values?.[1]).toBe(rawMultibyteQuery);
      expect(sql).toContain(
        "SELECT lcm.normalize_search_text($2::pg_catalog.text) AS query"
      );
      expect(sql).toContain("OPERATOR(pg_catalog.>=) 3");
      expect(normalizedGate).toBeGreaterThan(-1);
      expect(normalizedGate).toBeLessThan(sql.indexOf("OPERATOR(public.%)"));
      expect(normalizedGate).toBeLessThan(
        sql.indexOf("OPERATOR(pg_catalog.~~)")
      );
    }
  });

  it("fills only remaining slots with bounded, deduplicated trigram rows", async () => {
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
      if (
        sql.includes("FROM lcm.messages") &&
        sql.includes("public.similarity")
      ) {
        return result([
          messageRow,
          { ...messageRow, message_id: "12", snippet: "fallback two" },
          { ...messageRow, message_id: "13", snippet: "fallback three" },
          { ...messageRow, message_id: "14", snippet: "unreachable" },
        ]);
      }
      if (
        sql.includes("FROM lcm.summaries") &&
        sql.includes("public.similarity")
      ) {
        return result([
          summaryRow,
          { ...summaryRow, summary_id: "summary-b" },
          { ...summaryRow, summary_id: "summary-c" },
        ]);
      }
      if (
        sql.includes("FROM lcm.promoted_memories") &&
        sql.includes("public.similarity")
      ) {
        return result([
          promotedFallbackRow,
          { ...promotedFallbackRow, memory_id: secondMemoryId },
          { ...promotedFallbackRow, memory_id: thirdMemoryId },
        ]);
      }
      if (sql.includes("FROM lcm.messages")) return result([messageRow]);
      if (sql.includes("FROM lcm.summaries")) return result([summaryRow]);
      return result([promotedRow]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );

    await expect(
      repository.searchMessages({
        query: "needle",
        mode: "full_text",
        limit: 3,
      })
    ).resolves.toMatchObject([
      { messageId: 11 },
      { messageId: 12 },
      { messageId: 13 },
    ]);
    await expect(
      repository.searchSummaries({
        query: "needle",
        mode: "full_text",
        limit: 3,
      })
    ).resolves.toMatchObject([
      { summaryId: "summary-a" },
      { summaryId: "summary-b" },
      { summaryId: "summary-c" },
    ]);
    await expect(repository.searchPromoted("needle", 3)).resolves.toMatchObject(
      [{ id: memoryId }, { id: secondMemoryId }, { id: thirdMemoryId }]
    );

    const timeoutReads = database.query.mock.calls.filter(([config]) =>
      text(config as QueryConfig<unknown[]>).includes("previous_timeout")
    );
    const timeoutSets = database.query.mock.calls.filter(([config]) =>
      text(config as QueryConfig<unknown[]>).includes("set_config")
    );
    expect(timeoutReads).toHaveLength(3);
    expect(
      timeoutSets.map(
        ([config]) => (config as QueryConfig<unknown[]>).values?.[0]
      )
    ).toEqual(["5000ms", "37s", "5000ms", "37s", "5000ms", "37s"]);
    const trigramQueries = database.query.mock.calls
      .map(([config]) => config as QueryConfig<unknown[]>)
      .filter((config) => text(config).includes("public.similarity"));
    expect(trigramQueries[0].values).toEqual([
      projectId,
      "needle",
      null,
      null,
      null,
      [11],
      2,
    ]);
    expect(trigramQueries[1].values?.at(-1)).toBe(2);
    expect(trigramQueries[2].values?.at(-1)).toBe(2);
  });

  it("preserves promotion dedup semantics across primary and fallback rank signs", async () => {
    const primaryCandidate = {
      id: memoryId,
      content: "semantically related memory",
      tags: ["existing"],
      projectId: "source-a",
      sessionId: null,
      confidence: 0.8,
      createdAt: "2026-01-03T00:00:00.000Z",
      rank: -0.25,
    };
    const fallbackCandidate = {
      ...primaryCandidate,
      id: secondMemoryId,
      content: "needle memory fragment",
      rank: 0.25,
    };
    let candidates = [primaryCandidate, fallbackCandidate];
    const searchPromoted = vi.fn(
      async (
        _query: string,
        _limit: number
      ): Promise<
        Awaited<ReturnType<LexicalSearchRepository["searchPromoted"]>>
      > => candidates
    );
    const insert = vi.fn(
      async (
        _input: Parameters<PromotedMemoryRepository["insert"]>[0]
      ): Promise<string> => thirdMemoryId
    );
    const update = vi.fn(
      async (
        _id: string,
        _fields: Parameters<PromotedMemoryRepository["update"]>[1]
      ): Promise<void> => undefined
    );
    const archive = vi.fn(async (_id: string): Promise<void> => undefined);
    const repositories = {
      lexicalSearch: { searchPromoted },
      promotedMemory: { insert, update, archive },
    };
    const transaction = async <T>(
      callback: (available: typeof repositories) => Promise<T>
    ): Promise<T> => callback(repositories);
    const input = {
      transaction,
      content: "needle memory",
      tags: ["incoming"],
      sourceProjectId: "source-a",
      depth: 2,
      confidence: 0.7,
      thresholds: { dedupBm25Threshold: 0.2, dedupCandidateLimit: 10 },
    };

    await expect(deduplicateAndInsert(input)).resolves.toBe(memoryId);
    expect(update).toHaveBeenLastCalledWith(memoryId, {
      confidence: 0.8,
      tags: ["existing", "incoming"],
    });
    expect(insert).not.toHaveBeenCalled();

    candidates = [fallbackCandidate];
    await expect(deduplicateAndInsert(input)).resolves.toBe(thirdMemoryId);
    expect(insert).toHaveBeenCalledTimes(1);

    candidates = [{ ...fallbackCandidate, content: input.content }];
    await expect(deduplicateAndInsert(input)).resolves.toBe(secondMemoryId);
    expect(update).toHaveBeenLastCalledWith(secondMemoryId, {
      confidence: 0.8,
      tags: ["existing", "incoming"],
    });
  });

  it("runs validated regex searches under the bounded timeout", async () => {
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow("0");
      if (sql.includes("set_config")) return result([]);
      if (sql.includes("FROM lcm.messages")) {
        return result([{ ...messageRow, rank: 0 }]);
      }
      return result([{ ...summaryRow, rank: 0 }]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );

    await expect(
      repository.searchMessages({
        query: "needle-[0-9]+",
        mode: "regex",
      })
    ).resolves.toMatchObject([{ messageId: 11, rank: 0 }]);
    await expect(
      repository.searchSummaries({
        query: "summary-[0-9]+",
        mode: "regex",
      })
    ).resolves.toMatchObject([{ summaryId: "summary-a", rank: 0 }]);
    await expect(
      repository.searchMessages({
        query: "\u0301 \t \u20dd",
        mode: "regex",
      })
    ).resolves.toMatchObject([{ messageId: 11, rank: 0 }]);

    const regexQueries = database.query.mock.calls
      .map(([config]) => config as QueryConfig<unknown[]>)
      .filter((config) => text(config).includes("pg_catalog.regexp_substr"));
    expect(regexQueries).toHaveLength(3);
    expect(regexQueries[0].values?.[1]).toBe("needle-[0-9]+");
    expect(regexQueries[2].values?.[1]).toBe("\u0301 \t \u20dd");
    expect(
      database.query.mock.calls
        .filter(([config]) =>
          text(config as QueryConfig<unknown[]>).includes("set_config")
        )
        .map(([config]) => (config as QueryConfig<unknown[]>).values?.[0])
    ).toEqual(["5000ms", "0", "5000ms", "0", "5000ms", "0"]);
  });

  it("validates and snapshots every input before database I/O", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const database = executor(async (config) => {
      await gate;
      if (text(config).includes("FROM lcm.messages")) {
        return result([messageRow]);
      }
      return result([promotedRow]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );
    const since = new Date("2026-01-01T00:00:00.000Z");
    const before = new Date("2026-02-01T00:00:00.000Z");
    const messageInput = {
      query: "needle🚀",
      mode: "full_text",
      conversationId: 7,
      since,
      before,
      limit: 1,
    } as const;
    const messageSearch = repository.searchMessages(messageInput);
    const filterTags = ["one"];
    const promotedSearch = repository.searchPromoted(
      "needle🚀",
      1,
      filterTags,
      "source-a"
    );
    since.setUTCFullYear(2030);
    before.setUTCFullYear(2031);
    filterTags[0] = "mutated";
    release();
    await Promise.all([messageSearch, promotedSearch]);

    expect(database.query.mock.calls[0][0].values).toEqual([
      projectId,
      "needle🚀",
      7,
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      1,
    ]);
    expect(database.query.mock.calls[1][0].values).toEqual([
      projectId,
      "needle🚀",
      "source-a",
      ["one"],
      1,
    ]);
  });

  it("returns empty queries and zero limits without opening a transaction", async () => {
    const database = executor(() => result([]));
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );
    await expect(
      repository.searchMessages({
        query: " ",
        mode: "full_text",
      })
    ).resolves.toEqual([]);
    await expect(
      repository.searchMessages({
        query: " \u0301 \t \u20dd ",
        mode: "full_text",
      })
    ).resolves.toEqual([]);
    await expect(
      repository.searchMessages({
        query: "needle",
        mode: "full_text",
        limit: 0,
      })
    ).resolves.toEqual([]);
    await expect(
      repository.searchSummaries({
        query: "",
        mode: "full_text",
      })
    ).resolves.toEqual([]);
    await expect(
      repository.searchSummaries({
        query: "\u20de\n\u20e4",
        mode: "full_text",
      })
    ).resolves.toEqual([]);
    await expect(
      repository.searchSummaries({
        query: "needle",
        mode: "full_text",
        limit: 0,
      })
    ).resolves.toEqual([]);
    await expect(repository.searchPromoted(" ", 5)).resolves.toEqual([]);
    await expect(
      repository.searchPromoted("\u0362 \r\n \u20e0", 5)
    ).resolves.toEqual([]);
    await expect(repository.searchPromoted("needle", 0)).resolves.toEqual([]);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it("skips trigram fallback for fewer than three UTF-8 bytes", async () => {
    const database = executor(() => result([]));
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );
    await repository.searchMessages({ query: "a", mode: "full_text" });
    await repository.searchSummaries({ query: "é", mode: "full_text" });
    await repository.searchPromoted("ab", 5);
    expect(database.query).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["input number", () => 1],
    ["input null", () => null],
    ["input array", () => []],
    ["query type", () => ({ query: 1, mode: "full_text" })],
    ["query NUL", () => ({ query: "secret\0tail", mode: "full_text" })],
    ["query high surrogate", () => ({ query: "\ud800", mode: "full_text" })],
    ["query low surrogate", () => ({ query: "\udc00", mode: "full_text" })],
    ["mode", () => ({ query: "needle", mode: "semantic" })],
    [
      "conversation type",
      () => ({
        query: "needle",
        mode: "full_text",
        conversationId: "7",
      }),
    ],
    [
      "conversation negative",
      () => ({
        query: "needle",
        mode: "full_text",
        conversationId: -1,
      }),
    ],
    [
      "since type",
      () => ({
        query: "needle",
        mode: "full_text",
        since: "2026-01-01",
      }),
    ],
    [
      "since invalid",
      () => ({
        query: "needle",
        mode: "full_text",
        since: new Date(Number.NaN),
      }),
    ],
    [
      "before invalid",
      () => ({
        query: "needle",
        mode: "full_text",
        before: new Date(Number.NaN),
      }),
    ],
    [
      "limit type",
      () => ({
        query: "needle",
        mode: "full_text",
        limit: "5",
      }),
    ],
    [
      "limit fractional",
      () => ({
        query: "needle",
        mode: "full_text",
        limit: 1.5,
      }),
    ],
    [
      "limit negative",
      () => ({
        query: "needle",
        mode: "full_text",
        limit: -1,
      }),
    ],
    [
      "limit excessive",
      () => ({
        query: "needle",
        mode: "full_text",
        limit: 1_001,
      }),
    ],
    ["unsafe regex", () => ({ query: "(a+)+$", mode: "regex" })],
    ["invalid regex", () => ({ query: "[", mode: "regex" })],
  ])(
    "rejects malformed message input before I/O: %s",
    async (_name, create) => {
      const database = executor(() => result([]));
      const repository = new PostgreSqlLexicalSearchRepository(
        database,
        projectId
      );
      const error = await repository.searchMessages(create() as never).then(
        () => undefined,
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(PostgreSqlLexicalSearchDataError);
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(database.transaction).not.toHaveBeenCalled();
      expect(database.query).not.toHaveBeenCalled();
    }
  );

  it("rejects malformed promoted inputs before I/O", async () => {
    const database = executor(() => result([]));
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );
    const invalidCalls = [
      () => repository.searchPromoted(1 as never, 1),
      () => repository.searchPromoted("bad\0query", 1),
      () => repository.searchPromoted("needle", -1),
      () => repository.searchPromoted("needle", 1_001),
      () => repository.searchPromoted("needle", 1, 1 as never),
      () => repository.searchPromoted("needle", 1, null as never),
      () => repository.searchPromoted("needle", 1, [1 as never]),
      () => repository.searchPromoted("needle", 1, ["bad\ud800"]),
      () => repository.searchPromoted("needle", 1, [], "bad\udc00"),
    ];
    for (const call of invalidCalls) {
      await expect(call()).rejects.toBeInstanceOf(
        PostgreSqlLexicalSearchDataError
      );
    }
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("rejects invalid constructor executors and project identifiers", async () => {
    const database = executor(() => result([]));
    expect(
      () => new PostgreSqlLexicalSearchRepository(database, 1 as never)
    ).toThrow(PostgreSqlLexicalSearchDataError);
    expect(
      () =>
        new PostgreSqlLexicalSearchRepository(
          database,
          "550e8400-e29b-41d4-a716-446655440000"
        )
    ).toThrow(PostgreSqlLexicalSearchDataError);
    const invalidProject = "secret-invalid-project";
    let invalidProjectError: unknown;
    try {
      new PostgreSqlLexicalSearchRepository(database, invalidProject);
    } catch (error) {
      invalidProjectError = error;
    }
    expect(JSON.stringify(invalidProjectError)).not.toContain(invalidProject);

    const invalidScope = {
      query: vi.fn(),
    } as never;
    const repository = new PostgreSqlLexicalSearchRepository(
      invalidScope,
      projectId
    );
    await expect(
      repository.searchMessages({
        query: "needle",
        mode: "full_text",
      })
    ).rejects.toMatchObject({
      code: "STORAGE_TRANSACTION_SCOPE",
      domain: "lexical-search",
      projectId,
    });
  });

  it("serializes caller-owned savepoints and continues after a failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invocation = 0;
    const scoped = scopedExecutor(async (config) => {
      if (!text(config).includes("FROM lcm.messages")) return result([]);
      invocation += 1;
      if (invocation === 1) {
        await gate;
        throw new Error("first failure");
      }
      return result([messageRow]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(scoped, projectId);
    const first = repository.searchMessages({
      query: "a",
      mode: "full_text",
    });
    const second = repository.searchMessages({
      query: "b",
      mode: "full_text",
      limit: 1,
    });
    await vi.waitFor(() => expect(scoped.savepoint).toHaveBeenCalledTimes(1));
    release();
    await expect(first).rejects.toThrow("first failure");
    await expect(second).resolves.toMatchObject([{ messageId: 11 }]);
    expect(scoped.savepoint).toHaveBeenCalledTimes(2);
    expect(scoped.query).toHaveBeenCalledTimes(2);
  });

  it("never restores inside a cancelled statement or runs a broader fallback", async () => {
    const timeout = new PostgreSqlStorageOperationError(
      "STORAGE_OPERATION_FAILED",
      {
        domain: "lexical-search",
        operation: "searchMessages",
        projectId,
      },
      "57014",
      false
    );
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
      if (sql.includes("public.similarity")) throw timeout;
      return result([]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );
    await expect(
      repository.searchMessages({
        query: "needle",
        mode: "full_text",
      })
    ).rejects.toBe(timeout);
    const setCalls = database.query.mock.calls.filter(([config]) =>
      text(config as QueryConfig<unknown[]>).includes("set_config")
    );
    expect(setCalls).toHaveLength(1);
    expect(
      database.query.mock.calls.filter(([config]) =>
        text(config as QueryConfig<unknown[]>).includes("FROM lcm.messages")
      )
    ).toHaveLength(2);
    expect(timeout.toJSON()).toMatchObject({
      sqlState: "57014",
      retryable: false,
    });
  });

  it("keeps an unrelated regex-path failure distinct", async () => {
    const failure = "unrelated";
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
      throw failure;
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );
    await expect(
      repository.searchSummaries({
        query: "needle",
        mode: "regex",
      })
    ).rejects.toBe(failure);
  });

  it.each([
    ["1us", "1ms"],
    ["0.5ms", "1ms"],
    ["2ms", "2ms"],
    ["3s", "3000ms"],
    ["1min", "5000ms"],
    ["1h", "5000ms"],
    ["1d", "5000ms"],
    ["7", "7ms"],
    ["0", "5000ms"],
  ])("parses PostgreSQL statement timeout %s", async (previous, expected) => {
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow(previous);
      if (sql.includes("set_config")) return result([]);
      return result([{ ...messageRow, rank: 0 }]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );
    await expect(
      repository.searchMessages({
        query: "needle",
        mode: "regex",
        limit: 1,
      })
    ).resolves.toHaveLength(1);
    const setCall = database.query.mock.calls.find(([config]) =>
      text(config as QueryConfig<unknown[]>).includes("set_config")
    );
    expect((setCall?.[0] as QueryConfig<unknown[]>).values?.[0]).toBe(expected);
  });

  it.each([
    [{ previous_timeout: 1 }, "statement_timeout"],
    [{ previous_timeout: "bad" }, "statement_timeout"],
    [{ previous_timeout: "-1ms" }, "statement_timeout"],
    [{ previous_timeout: `${"9".repeat(400)}s` }, "statement_timeout"],
  ])("rejects malformed timeout state %#", async (row, field) => {
    const database = executor((config) => {
      if (text(config).includes("previous_timeout")) return result([row]);
      if (text(config).includes("FROM lcm.messages")) return result([]);
      return result([]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );
    await expect(
      repository.searchMessages({
        query: "needle",
        mode: "full_text",
      })
    ).rejects.toMatchObject({ field });
  });

  it("propagates timeout restoration failure so the enclosing scope rolls back", async () => {
    let setCount = 0;
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) {
        setCount += 1;
        if (setCount === 2) throw new Error("restore failed");
        return result([]);
      }
      if (sql.includes("FROM lcm.messages")) return result([messageRow]);
      return result([]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );
    await expect(
      repository.searchMessages({
        query: "needle",
        mode: "regex",
      })
    ).rejects.toThrow("restore failed");
  });

  it("turns every malformed message row field into a stable data error", async () => {
    const rows = [
      { ...messageRow, message_id: 1.5 },
      { ...messageRow, message_id: -1 },
      { ...messageRow, message_id: "9007199254740992" },
      { ...messageRow, message_id: {} },
      { ...messageRow, conversation_id: -1n },
      { ...messageRow, role: 1 },
      { ...messageRow, role: "developer" },
      { ...messageRow, snippet: null },
      { ...messageRow, created_at: "bad" },
      { ...messageRow, rank: Number.NaN },
    ];
    for (const row of rows) {
      const database = executor(() => result([row]));
      const repository = new PostgreSqlLexicalSearchRepository(
        database,
        projectId
      );
      await expect(
        repository.searchMessages({
          query: "needle",
          mode: "full_text",
          limit: 1,
        })
      ).rejects.toBeInstanceOf(PostgreSqlLexicalSearchDataError);
    }
  });

  it("turns every malformed summary row field into a stable data error", async () => {
    const rows = [
      { ...summaryRow, summary_id: null },
      { ...summaryRow, conversation_id: "bad" },
      { ...summaryRow, kind: 1 },
      { ...summaryRow, kind: "root" },
      { ...summaryRow, snippet: null },
      { ...summaryRow, created_at: {} },
      { ...summaryRow, rank: "0.5" },
    ];
    for (const row of rows) {
      const database = executor(() => result([row]));
      const repository = new PostgreSqlLexicalSearchRepository(
        database,
        projectId
      );
      await expect(
        repository.searchSummaries({
          query: "needle",
          mode: "full_text",
          limit: 1,
        })
      ).rejects.toBeInstanceOf(PostgreSqlLexicalSearchDataError);
    }
  });

  it("turns every malformed promoted row field into a stable data error", async () => {
    const rows = [
      { ...promotedRow, memory_id: "bad" },
      { ...promotedRow, content: null },
      { ...promotedRow, tags: {} },
      { ...promotedRow, tags: [1] },
      { ...promotedRow, source_project_id: null },
      { ...promotedRow, session_id: 1 },
      { ...promotedRow, confidence: "0.8" },
      { ...promotedRow, created_at: "bad" },
      { ...promotedRow, rank: Number.POSITIVE_INFINITY },
      { ...promotedRow, rank: 0 },
      { ...promotedRow, rank: -0 },
      { ...promotedRow, rank: 0.25 },
    ];
    for (const row of rows) {
      const database = executor(() => result([row]));
      const repository = new PostgreSqlLexicalSearchRepository(
        database,
        projectId
      );
      await expect(
        repository.searchPromoted("needle", 1)
      ).rejects.toBeInstanceOf(PostgreSqlLexicalSearchDataError);
    }
  });

  it("rejects a negative trigram fallback rank as malformed data", async () => {
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
      if (sql.includes("public.similarity")) return result([promotedRow]);
      return result([]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );

    await expect(repository.searchPromoted("needle", 1)).rejects.toBeInstanceOf(
      PostgreSqlLexicalSearchDataError
    );
  });
});
