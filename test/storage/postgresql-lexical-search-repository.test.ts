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
  match_phase: 0,
};

const summaryRow = {
  summary_id: "summary-a",
  conversation_id: "7",
  kind: "leaf",
  snippet: "needle summary",
  rank: 0.5,
  created_at: new Date("2026-01-02T00:00:00.000Z"),
  match_phase: 0,
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
  match_phase: 0,
};

const promotedFallbackRow = {
  ...promotedRow,
  rank: 0.25,
  match_phase: 1,
};

describe("PostgreSQL lexical-search repository", () => {
  it("maps primary message, summary, and promoted rows with exact scoped SQL", async () => {
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
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
    const dataQueries = database.query.mock.calls.filter(([config]) =>
      text(config as QueryConfig<unknown[]>).includes("FROM combined")
    );
    expect(dataQueries).toHaveLength(3);
    for (const [config, options] of dataQueries) {
      const query = config as QueryConfig<unknown[]>;
      expect(query.text).toContain("lcm.");
      expect(query.text).not.toContain("needle");
      expect(options).toMatchObject({
        domain: "lexical-search",
        projectId,
      });
      expect(query.values?.[0]).toBe(projectId);
    }
    expect(dataQueries[0][0].values).toEqual([
      projectId,
      "needle",
      7,
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      2,
    ]);
    expect(dataQueries[2][0].values).toEqual([
      projectId,
      "needle",
      "source-a",
      ["one"],
      2,
    ]);
    const promotedSql = text(dataQueries[2][0]);
    expect(promotedSql).toContain(") AS relevance");
    expect(promotedSql).toContain(
      "OPERATOR(pg_catalog.-) ranked.relevance AS rank"
    );
    expect(promotedSql).toContain(
      "WHERE ranked.relevance OPERATOR(pg_catalog.>) 0::pg_catalog.float4"
    );
    expect(promotedSql).toMatch(
      /ORDER BY\s+ranked\.relevance DESC,\s+ranked\.created_at DESC,\s+ranked\.memory_id DESC/u
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
    const normalizedShortQuery = "𝐚";

    await repository.searchMessages({
      query: normalizedShortQuery,
      mode: "full_text",
    });
    await repository.searchSummaries({
      query: normalizedShortQuery,
      mode: "full_text",
    });
    await repository.searchPromoted(normalizedShortQuery, 5);

    const statements = database.query.mock.calls.map(
      ([config]) => config as QueryConfig<unknown[]>
    );
    const headlineStatements = statements.filter((config) =>
      text(config).includes("pg_catalog.ts_headline")
    );
    expect(headlineStatements).toHaveLength(2);
    expect(text(headlineStatements[0])).toMatch(
      /pg_catalog\.ts_headline\(\s*'lcm\.search_v1'::pg_catalog\.regconfig,\s*lcm\.normalize_search_text\(message\.content\),\s*input\.full_text_query,/u
    );
    expect(text(headlineStatements[1])).toMatch(
      /pg_catalog\.ts_headline\(\s*'lcm\.search_v1'::pg_catalog\.regconfig,\s*lcm\.normalize_search_text\(summary\.content\),\s*input\.full_text_query,/u
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
      expect(config.values?.[1]).toBe(normalizedShortQuery);
      expect(config.values).not.toContain(true);
      expect(config.values).not.toContain(false);
      expect(config.values).toHaveLength(
        sql.includes("FROM lcm.promoted_memories") ? 5 : 6
      );
      expect(sql).not.toContain("allow_trigram");
      expect(sql).toContain(
        "SELECT lcm.normalize_search_text($2::pg_catalog.text) AS query"
      );
      expect(sql).toContain("primary_rows AS MATERIALIZED");
      expect(sql).toContain("fallback_rows AS MATERIALIZED");
      expect(sql).toContain("fallback_budget AS MATERIALIZED");
      expect(sql).toContain("CROSS JOIN LATERAL");
      expect(sql).toContain("FROM primary_rows AS primary_row");
      expect(sql).toContain("UNION ALL");
      expect(sql).toContain("combined.match_phase");
      expect(sql).toContain("combined.match_order DESC");
      expect(sql).toContain("OPERATOR(pg_catalog.>=) 3");
      expect(sql).toMatch(
        /fallback_budget AS MATERIALIZED \(\s*SELECT GREATEST\(\s*\$(?:5|6)::pg_catalog\.int8\s+OPERATOR\(pg_catalog\.-\)\s+pg_catalog\.count\(\*\)::pg_catalog\.int8,\s+0::pg_catalog\.int8\s*\) AS remaining\s+FROM primary_rows\s*\)/u
      );
      expect(sql).toMatch(
        /LIMIT CASE\s+WHEN pg_catalog\.octet_length\(input\.query\)\s+OPERATOR\(pg_catalog\.>=\) 3\s+AND fallback_budget\.remaining OPERATOR\(pg_catalog\.>\) 0\s+THEN GREATEST\(\s*fallback_budget\.remaining,\s+0::pg_catalog\.int8\s*\)\s+ELSE 0::pg_catalog\.int8\s+END/u
      );
      expect(sql.match(/LIMIT CASE/gu)).toHaveLength(1);
      expect(sql).toMatch(
        /combined AS \(\s*SELECT \* FROM primary_rows\s+UNION ALL\s+SELECT \* FROM fallback_rows\s*\)/u
      );
      expect(sql).toMatch(
        /FROM combined\s+ORDER BY\s+combined\.match_phase,\s+combined\.match_order DESC,\s+combined\.created_at DESC,\s+combined\.(?:message_id|summary_id|memory_id) DESC\s+LIMIT \$(?:5|6)::pg_catalog\.int8$/u
      );
      expect(normalizedGate).toBeGreaterThan(-1);
      const guardedFallback = sql.slice(normalizedGate);
      expect(guardedFallback).toContain("OPERATOR(public.%)");
      expect(guardedFallback).toContain("OPERATOR(pg_catalog.~~)");
    }
  });

  it("maps nullable legacy provenance to the owner for primary and trigram rows", async () => {
    const legacyPrimary = {
      ...promotedRow,
      source_project_id: null,
    };
    const primaryDatabase = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
      return result([legacyPrimary]);
    });
    const primaryRepository = new PostgreSqlLexicalSearchRepository(
      primaryDatabase,
      projectId
    );
    await expect(
      primaryRepository.searchPromoted("needle", 1)
    ).resolves.toMatchObject([
      {
        id: memoryId,
        projectId,
        rank: -0.25,
      },
    ]);

    const fallbackDatabase = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
      if (sql.includes("public.similarity")) {
        return result([
          {
            ...promotedFallbackRow,
            source_project_id: null,
          },
        ]);
      }
      return result([]);
    });
    const fallbackRepository = new PostgreSqlLexicalSearchRepository(
      fallbackDatabase,
      projectId
    );
    await expect(
      fallbackRepository.searchPromoted("needle", 1)
    ).resolves.toMatchObject([
      {
        id: memoryId,
        projectId,
        rank: 0.25,
      },
    ]);
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
          { ...messageRow, match_phase: 1 },
          {
            ...messageRow,
            message_id: "12",
            snippet: "fallback two",
            match_phase: 1,
          },
          {
            ...messageRow,
            message_id: "13",
            snippet: "fallback three",
            match_phase: 1,
          },
          {
            ...messageRow,
            message_id: "14",
            snippet: "unreachable",
            match_phase: 1,
          },
        ]);
      }
      if (
        sql.includes("FROM lcm.summaries") &&
        sql.includes("public.similarity")
      ) {
        return result([
          summaryRow,
          { ...summaryRow, match_phase: 1 },
          { ...summaryRow, summary_id: "summary-b", match_phase: 1 },
          { ...summaryRow, summary_id: "summary-c", match_phase: 1 },
        ]);
      }
      if (
        sql.includes("FROM lcm.promoted_memories") &&
        sql.includes("public.similarity")
      ) {
        return result([
          promotedRow,
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
    const dataQueries = database.query.mock.calls
      .map(([config]) => config as QueryConfig<unknown[]>)
      .filter((config) => text(config).includes("FROM combined"));
    expect(dataQueries).toHaveLength(3);
    expect(dataQueries[0].values).toEqual([
      projectId,
      "needle",
      null,
      null,
      null,
      3,
    ]);
    expect(dataQueries[1].values).toEqual([
      projectId,
      "needle",
      null,
      null,
      null,
      3,
    ]);
    expect(dataQueries[2].values).toEqual([projectId, "needle", null, [], 3]);
  });

  it("truncates malformed over-limit primary output before fallback", async () => {
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
      return result([
        messageRow,
        { ...messageRow, message_id: "12" },
        { ...messageRow, message_id: "13" },
        { ...messageRow, message_id: "14", match_phase: 1 },
      ]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );

    const rows = await repository.searchMessages({
      query: "needle",
      mode: "full_text",
      limit: 2,
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.messageId)).toEqual([11, 12]);
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
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
      if (sql.includes("FROM lcm.messages")) {
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

    const dataQueries = database.query.mock.calls
      .map(([config]) => config as QueryConfig<unknown[]>)
      .filter((config) => text(config).includes("FROM combined"));
    expect(dataQueries).toHaveLength(2);
    const messageQuery = dataQueries.find((config) =>
      text(config).includes("FROM lcm.messages")
    );
    const promotedQuery = dataQueries.find((config) =>
      text(config).includes("FROM lcm.promoted_memories")
    );
    expect(messageQuery?.values).toEqual([
      projectId,
      "needle🚀",
      7,
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      1,
    ]);
    expect(promotedQuery?.values).toEqual([
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

  it("binds omitted defaults and leaves short-query gating to normalized SQL", async () => {
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      return result([]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );
    await repository.searchMessages({ query: "a", mode: "full_text" });
    await repository.searchSummaries({ query: "é", mode: "full_text" });
    await repository.searchPromoted("ab", 5);
    const dataQueries = database.query.mock.calls
      .map(([config]) => config as QueryConfig<unknown[]>)
      .filter((config) => text(config).includes("FROM combined"));
    expect(dataQueries).toHaveLength(3);
    expect(dataQueries.map((config) => config.values)).toEqual([
      [projectId, "a", null, null, null, 50],
      [projectId, "é", null, null, null, 50],
      [projectId, "ab", null, [], 5],
    ]);
    for (const config of dataQueries) {
      expect(config.values).not.toContain(true);
      expect(config.values).not.toContain(false);
      expect(text(config)).not.toContain("allow_trigram");
      expect(text(config)).toContain("pg_catalog.octet_length(input.query)");
    }
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
      "limit null",
      () => ({
        query: "needle",
        mode: "full_text",
        limit: null,
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

  it("rejects an explicit null summary limit before I/O", async () => {
    const database = executor(() => result([]));
    const repository = new PostgreSqlLexicalSearchRepository(
      database,
      projectId
    );

    await expect(
      repository.searchSummaries({
        query: "needle",
        mode: "full_text",
        limit: null as never,
      })
    ).rejects.toBeInstanceOf(PostgreSqlLexicalSearchDataError);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

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
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
      if (!sql.includes("FROM lcm.messages")) return result([]);
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
    expect(
      scoped.query.mock.calls.filter(([config]) =>
        text(config as QueryConfig<unknown[]>).includes("FROM combined")
      )
    ).toHaveLength(2);
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
    ).toHaveLength(1);
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
      { ...messageRow, match_phase: null },
      { ...messageRow, match_phase: -1 },
      { ...messageRow, match_phase: 2 },
    ];
    for (const row of rows) {
      const database = executor((config) => {
        const sql = text(config);
        if (sql.includes("previous_timeout")) return timeoutRow();
        if (sql.includes("set_config")) return result([]);
        return result([row]);
      });
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
      const database = executor((config) => {
        const sql = text(config);
        if (sql.includes("previous_timeout")) return timeoutRow();
        if (sql.includes("set_config")) return result([]);
        return result([row]);
      });
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
      { ...promotedRow, source_project_id: 1 },
      { ...promotedRow, session_id: 1 },
      { ...promotedRow, confidence: "0.8" },
      { ...promotedRow, created_at: "bad" },
      { ...promotedRow, rank: Number.POSITIVE_INFINITY },
      { ...promotedRow, rank: 0 },
      { ...promotedRow, rank: -0 },
      { ...promotedRow, rank: 0.25 },
    ];
    for (const row of rows) {
      const database = executor((config) => {
        const sql = text(config);
        if (sql.includes("previous_timeout")) return timeoutRow();
        if (sql.includes("set_config")) return result([]);
        return result([row]);
      });
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
      if (sql.includes("public.similarity")) {
        return result([{ ...promotedRow, match_phase: 1 }]);
      }
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

describe("PostgreSQL promoted recall evidence", () => {
  it("keeps ordinary selection and public rows while adding complete native evidence", async () => {
    const database = executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
      if (sql.includes("AS canonical_query")) {
        return result([{ canonical_query: "'needle' | 'needle':*A | !'hidden' | 'memory'" }]);
      }
      return result([
        { ...promotedRow, matched_terms: "2" },
        { ...promotedFallbackRow, memory_id: secondMemoryId, matched_terms: 0n },
      ]);
    });
    const repository = new PostgreSqlLexicalSearchRepository(database, projectId);
    const ordinary = await repository.searchPromoted("needle OR memory", 2, ["one"], "source-a");
    const recall = await repository.searchPromotedForRecall("needle OR memory", 2, ["one"], "source-a");
    expect(recall).toEqual({ candidates: [
      { result: ordinary[0], evidence: { queryTermCount: 2, matchedTermCount: 2 } },
      { result: ordinary[1], evidence: { queryTermCount: 2, matchedTermCount: 0 } },
    ] });
    expect(ordinary[0]).not.toHaveProperty("matched_terms");
    expect(ordinary[0]).not.toHaveProperty("match_order");
    const calls = database.query.mock.calls.map(([config]) => config as QueryConfig<unknown[]>);
    const canonical = calls.filter((config) => text(config).includes("AS canonical_query"));
    expect(canonical).toHaveLength(1);
    expect(canonical[0].values).toEqual(["needle OR memory"]);
    const evidence = calls.find((config) => text(config).includes("AS matched_terms"))!;
    expect(evidence.values?.slice(0, 5)).toEqual([projectId, "needle OR memory", "source-a", ["one"], 2]);
    expect(evidence.values?.slice(5, 7)).toEqual([["'needle'", "'needle':*A", "'memory'"], [0, 0, 1]]);
    expect(evidence.text).toContain("selected AS MATERIALIZED");
    expect(evidence.text).toContain("combined.match_order");
    expect(evidence.text).toContain("count(DISTINCT terms.group_id)");
    // PostgreSQL only rewrites unqualified multi-argument UNNEST. Keep each
    // built-in pinned while zipping both arrays through native ROWS FROM.
    expect(evidence.text).toContain(`FROM ROWS FROM (
    pg_catalog.unnest($6::pg_catalog.text[]),
    pg_catalog.unnest($7::pg_catalog.int8[])
  ) AS evidence(atom, group_id)`);
    expect(evidence.text).toContain("tag.search_document OPERATOR(pg_catalog.@@)");
    expect(evidence.text).toContain("memory.project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid");
    expect(evidence.text).not.toContain("needle");
    expect(database.transaction).toHaveBeenCalledTimes(2);
    expect(database.transaction.mock.calls[1][1]).toMatchObject({ operation: "searchPromotedForRecall" });
  });
});

describe("PostgreSQL recall evidence validation", () => {
  function recallExecutor(canonicalRows: QueryResultRow[], rows: QueryResultRow[] = []) {
    return executor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow();
      if (sql.includes("set_config")) return result([]);
      if (sql.includes("AS canonical_query")) return result(canonicalRows);
      return result(rows);
    });
  }

  it("keeps complete zero-evidence envelopes for empty and negative canonical queries", async () => {
    for (const canonical_query of ["", "!'needle'"]) {
      const database = recallExecutor([{ canonical_query }], [
        { ...promotedFallbackRow, matched_terms: "0" },
        { ...promotedFallbackRow, memory_id: secondMemoryId, matched_terms: 0 },
      ]);
      const repository = new PostgreSqlLexicalSearchRepository(database, projectId);
      const recall = await repository.searchPromotedForRecall("-needle", 5);
      expect(recall.candidates.map(({ result: row, evidence }) => ({ id: row.id, ...evidence })))
        .toEqual([
          { id: memoryId, queryTermCount: 0, matchedTermCount: 0 },
          { id: secondMemoryId, queryTermCount: 0, matchedTermCount: 0 },
        ]);
      const data = database.query.mock.calls.find(([config]) => text(config).includes("AS matched_terms"))![0];
      expect(data.values.slice(5, 7)).toEqual([[], []]);
    }
  });

  it("does not silently truncate more than 256 native groups", async () => {
    const atoms = Array.from({ length: 600 }, (_, index) => `'term${index}'`);
    const database = recallExecutor([{ canonical_query: atoms.join(" | ") }], [
      { ...promotedRow, matched_terms: "600" },
    ]);
    const repository = new PostgreSqlLexicalSearchRepository(database, projectId);
    expect((await repository.searchPromotedForRecall("large query", 1)).candidates[0].evidence)
      .toEqual({ queryTermCount: 600, matchedTermCount: 600 });
    const data = database.query.mock.calls.find(([config]) => text(config).includes("AS matched_terms"))![0];
    expect(data.values[5]).toEqual(atoms);
    expect(data.values[6]).toEqual(Array.from({ length: 600 }, (_, index) => index));
  });

  it("validates admitted input and returns empty before opening a transaction", async () => {
    const database = recallExecutor([]);
    const repository = new PostgreSqlLexicalSearchRepository(database, projectId);
    for (const query of ["", "\r\n ", "\u0362 \u20e0"]) {
      expect(await repository.searchPromotedForRecall(query, 10)).toEqual({ candidates: [] });
    }
    expect(await repository.searchPromotedForRecall("needle", 0)).toEqual({ candidates: [] });
    for (const invoke of [
      () => repository.searchPromotedForRecall(null as never, 1),
      () => repository.searchPromotedForRecall("bad\0query", 1),
      () => repository.searchPromotedForRecall("needle", 1001),
      () => repository.searchPromotedForRecall("needle", 1, [null as never]),
      () => repository.searchPromotedForRecall("needle", 1, [], "bad\ud800"),
    ]) {
      await expect(invoke()).rejects.toMatchObject({ operation: "searchPromotedForRecall" });
    }
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("rejects missing, duplicate, malformed and incompletely consumed canonical query results", async () => {
    for (const rows of [
      [], [{ canonical_query: "'needle'" }, { canonical_query: "'needle'" }],
      [{ canonical_query: null }], [{ canonical_query: "'needle' |" }],
      [{ canonical_query: "'needle' ignored" }], [{ canonical_query: "'bad\0query'" }],
    ]) {
      const database = recallExecutor(rows);
      const repository = new PostgreSqlLexicalSearchRepository(database, projectId);
      const error = await repository.searchPromotedForRecall("private query", 1).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(PostgreSqlLexicalSearchDataError);
      expect(error).toMatchObject({ field: "canonical_query", operation: "searchPromotedForRecall" });
      expect(JSON.stringify(error)).not.toContain("private query");
      expect(database.query.mock.calls.some(([config]) => text(config).includes("AS matched_terms"))).toBe(false);
    }
  });

  it("rejects every invalid count and never returns a valid prefix of a damaged result", async () => {
    for (const matched_terms of [null, undefined, -1, "-1", 2, "2", 0.5, "0.5", Number.NaN,
      Infinity, "9007199254740992", 9007199254740992n, {}, true]) {
      const database = recallExecutor([{ canonical_query: "'needle'" }], [
        { ...promotedRow, matched_terms: "1" },
        { ...promotedRow, memory_id: secondMemoryId, matched_terms },
      ]);
      const repository = new PostgreSqlLexicalSearchRepository(database, projectId);
      await expect(repository.searchPromotedForRecall("needle", 2)).rejects.toMatchObject({
        field: "matched_terms", operation: "searchPromotedForRecall",
      });
    }
  });

  it("rejects duplicate selected IDs and result overflow instead of silently dropping evidence", async () => {
    for (const rows of [
      [{ ...promotedRow, matched_terms: 1 }, { ...promotedRow, matched_terms: 1 }],
      [{ ...promotedRow, matched_terms: 1 }, { ...promotedFallbackRow, matched_terms: 1 }],
      [{ ...promotedRow, matched_terms: 1 }, { ...promotedRow, memory_id: secondMemoryId, matched_terms: 1 },
        { ...promotedRow, memory_id: thirdMemoryId, matched_terms: 1 }],
    ]) {
      const repository = new PostgreSqlLexicalSearchRepository(
        recallExecutor([{ canonical_query: "'needle'" }], rows), projectId
      );
      await expect(repository.searchPromotedForRecall("needle", 2)).rejects.toMatchObject({
        field: "recall_candidates", operation: "searchPromotedForRecall",
      });
    }
  });

  it("preserves typed executor failures and uses the scoped savepoint without nesting", async () => {
    const failure = new PostgreSqlStorageOperationError(
      "STORAGE_OPERATION_FAILED", { projectId, domain: "lexical-search", operation: "searchPromotedForRecall" }, "57014", false
    );
    const database = scopedExecutor((config) => {
      const sql = text(config);
      if (sql.includes("previous_timeout")) return timeoutRow("2s");
      if (sql.includes("set_config")) return result([]);
      if (sql.includes("AS canonical_query")) return result([{ canonical_query: "'needle'" }]);
      throw failure;
    });
    const repository = new PostgreSqlLexicalSearchRepository(database, projectId);
    await expect(repository.searchPromotedForRecall("needle", 1)).rejects.toBe(failure);
    expect(database.savepoint).toHaveBeenCalledTimes(1);
  });
});
