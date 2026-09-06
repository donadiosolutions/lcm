import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { PostgreSqlQueryOptions } from "../../src/storage/postgresql/contracts.js";
import { StorageOperationError } from "../../src/storage/errors.js";
import { derivePostgreSqlAdvisoryLockName } from "../../src/storage/postgresql/coordination.js";
import {
  PostgreSqlCommitOutcomeUnknownError,
  PostgreSqlStorageOperationError,
} from "../../src/storage/postgresql/errors.js";
import {
  PostgreSqlContextRepository,
  PostgreSqlLargeFileRepository,
  PostgreSqlSummaryContextConflictError,
  PostgreSqlSummaryContextDataError,
  type PostgreSqlSummaryContextExecutor,
  type PostgreSqlSummaryContextScopedExecutor,
  PostgreSqlSummaryContextNotFoundError,
  PostgreSqlSummaryRepository,
} from "../../src/storage/postgresql/summary-context-repositories.js";

const projectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const machineId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9030";
const summaryKey = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9040";
const parentKey = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9050";
const childKey = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9060";
const otherKey = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9070";
const wideKey = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9080";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

type QueryImplementation = (
  config: QueryConfig<unknown[]>,
  options: PostgreSqlQueryOptions,
) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>;

function executor(implementation: QueryImplementation): PostgreSqlSummaryContextExecutor & {
  query: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  savepoint: ReturnType<typeof vi.fn>;
  transactionOptions: PostgreSqlQueryOptions[];
  savepointOptions: PostgreSqlQueryOptions[];
} {
  const query = vi.fn(implementation);
  const transactionOptions: PostgreSqlQueryOptions[] = [];
  const savepointOptions: PostgreSqlQueryOptions[] = [];
  const db = {
    transactionScope: "active" as const,
    query,
    savepoint: vi.fn(async (
      callback: Parameters<PostgreSqlSummaryContextScopedExecutor["savepoint"]>[0],
      options: Parameters<PostgreSqlSummaryContextScopedExecutor["savepoint"]>[1],
    ) => {
      savepointOptions.push(options);
      return callback({ query });
    }),
    transaction: vi.fn(async (
      callback: Parameters<PostgreSqlSummaryContextExecutor["transaction"]>[0],
      options: Parameters<PostgreSqlSummaryContextExecutor["transaction"]>[1],
    ) => {
      transactionOptions.push(options);
      return callback(db);
    }),
    transactionOptions,
    savepointOptions,
  } as unknown as PostgreSqlSummaryContextExecutor & {
    query: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
    savepoint: ReturnType<typeof vi.fn>;
  };
  return db;
}

function scopedExecutor(
  implementation: QueryImplementation,
): PostgreSqlSummaryContextScopedExecutor & {
  query: ReturnType<typeof vi.fn>;
  savepoint: ReturnType<typeof vi.fn>;
  savepointOptions: PostgreSqlQueryOptions[];
} {
  const query = vi.fn(implementation);
  const savepointOptions: PostgreSqlQueryOptions[] = [];
  return {
    transactionScope: "active",
    query,
    savepoint: vi.fn(async (
      callback: Parameters<PostgreSqlSummaryContextScopedExecutor["savepoint"]>[0],
      options: Parameters<PostgreSqlSummaryContextScopedExecutor["savepoint"]>[1],
    ) => {
      savepointOptions.push(options);
      return callback({ query });
    }),
    savepointOptions,
  };
}

const summaryRow = {
  summary_id: "summary-a",
  conversation_id: "41",
  kind: "leaf",
  depth: 0,
  content: "summary",
  token_count: 7n,
  file_ids: ["opaque-a", "opaque-a", "missing"],
  earliest_at: "2026-01-01T00:00:00.000Z",
  latest_at: new Date("2026-01-02T00:00:00.000Z"),
  descendant_count: "2",
  descendant_token_count: 11,
  source_message_token_count: 13n,
  created_at: "2026-01-03T00:00:00.000Z",
};

const identityRow = {
  summary_key: summaryKey,
  summary_id: "summary-a",
  conversation_id: "41",
};

const parentIdentityRow = {
  summary_key: parentKey,
  summary_id: "parent-a",
  conversation_id: "41",
};

const contextMessageRow = {
  conversation_id: "41",
  ordinal: 0,
  item_type: "message",
  message_id: "51",
  summary_id: null,
  created_at: "2026-01-03T00:00:00.000Z",
};

const contextSummaryRow = {
  conversation_id: 41n,
  ordinal: "1",
  item_type: "summary",
  message_id: null,
  summary_id: "summary-a",
  created_at: new Date("2026-01-04T00:00:00.000Z"),
};

const largeFileRow = {
  file_id: "file-a",
  conversation_id: 41n,
  file_name: "archive.bin",
  mime_type: "application/octet-stream",
  byte_size: "9007199254740991",
  storage_uri: "s3://bucket/key",
  exploration_summary: "opaque",
  created_at: "2026-01-05T00:00:00.000Z",
};

function mutationPrelude(config: QueryConfig<unknown[]>): QueryResult<QueryResultRow> | null {
  if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
    return result([]);
  }
  if (config.text.includes("current_setting('lock_timeout')")) {
    return result([{ setting: "7s" }]);
  }
  if (config.text.includes("set_config(")) return result([]);
  if (config.text.includes("pg_advisory_xact_lock")) return result([]);
  return null;
}

describe("PostgreSQL summary repository", () => {
  it("round-trips all summary operations with project scoping and stable ordering", async () => {
    const db = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("INSERT INTO lcm.summaries")) {
        return result([{ ...summaryRow, file_ids: [] }]);
      }
      if (config.text.includes("INSERT INTO lcm.summary_large_files")) return result([]);
      if (config.text.includes("SELECT summary_key, summary_id, conversation_id")) {
        return result([identityRow]);
      }
      if (config.text.includes("SELECT stored.summary_key")) {
        return result([parentIdentityRow]);
      }
      if (config.text.includes("WITH RECURSIVE descendants")) {
        return result([{ count: "0" }]);
      }
      if (config.text.includes("INSERT INTO lcm.summary_messages")) {
        return result([{ message_id: "51" }, { message_id: "52" }]);
      }
      if (config.text.includes("INSERT INTO lcm.summary_parents")) return result([]);
      if (config.text.includes("SELECT message_id")) {
        return result([{ message_id: "51" }, { message_id: 52n }]);
      }
      if (config.text.includes("WITH RECURSIVE reachable")) {
        return result([{
          ...summaryRow,
          summary_key: summaryKey,
          edge_parent_summary_key: null,
          edge_ordinal: null,
        }, {
          ...summaryRow,
          summary_id: "child-a",
          summary_key: childKey,
          edge_parent_summary_key: summaryKey,
          edge_ordinal: 0,
        }, {
          ...summaryRow,
          summary_id: "other",
          summary_key: otherKey,
          edge_parent_summary_key: summaryKey,
          edge_ordinal: 1,
        }, {
          ...summaryRow,
          summary_id: "child-a",
          summary_key: childKey,
          edge_parent_summary_key: otherKey,
          edge_ordinal: 0,
        }, {
          ...summaryRow,
          summary_id: "wide-a",
          summary_key: wideKey,
          edge_parent_summary_key: summaryKey,
          edge_ordinal: 10_000,
        }]);
      }
      if (config.text.includes("FROM lcm.summary_parents AS edge")) {
        return result([summaryRow]);
      }
      if (config.text.includes("FROM lcm.summaries AS s")) {
        return result([summaryRow]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlSummaryRepository(db, projectId, {
      lockTimeoutMs: 42,
    });

    await expect(repository.insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 7,
      fileIds: ["opaque-a", "opaque-a", "missing"],
      earliestAt: new Date("2026-01-01T00:00:00.000Z"),
      latestAt: new Date("2026-01-02T00:00:00.000Z"),
      descendantCount: 2.8,
      descendantTokenCount: 11,
      sourceMessageTokenCount: 13,
    })).resolves.toMatchObject({
      conversationId: 41,
      fileIds: ["opaque-a", "opaque-a", "missing"],
      descendantCount: 2,
    });
    await expect(repository.getSummary("summary-a")).resolves.toMatchObject({
      tokenCount: 7,
      earliestAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await expect(repository.getSummariesByConversation(41)).resolves.toHaveLength(1);
    await expect(repository.listRecentSummaries(-1)).resolves.toHaveLength(1);
    await expect(repository.listRecentSummaries(2)).resolves.toHaveLength(1);
    await expect(repository.listRecentSummariesForSession("session-a", -1))
      .resolves.toHaveLength(1);
    await expect(repository.listRecentSummariesForSession("session-a", 2))
      .resolves.toHaveLength(1);
    await expect(repository.linkSummaryToMessages("summary-a", [51, 52]))
      .resolves.toBeUndefined();
    await expect(repository.linkSummaryToParents("summary-a", ["parent-a"]))
      .resolves.toBeUndefined();
    await expect(repository.getSummaryMessages("summary-a"))
      .resolves.toEqual([51, 52]);
    await expect(repository.getSummaryChildren("summary-a")).resolves.toHaveLength(1);
    await expect(repository.getSummaryParents("summary-a")).resolves.toHaveLength(1);
    await expect(repository.getSummarySubtree("summary-a")).resolves.toMatchObject([
      { summaryId: "summary-a", depthFromRoot: 0, childCount: 3 },
      {
        summaryId: "child-a",
        depthFromRoot: 1,
        parentSummaryId: "summary-a",
        path: "0000000000",
      },
      { summaryId: "other", path: "0000000001" },
      { summaryId: "wide-a", path: "0000010000" },
    ]);
    const subtreeSql = db.query.mock.calls.find(
      ([config]) => config.text.includes("WITH RECURSIVE reachable"),
    )?.[0].text;
    expect(subtreeSql).toContain("UNION\n");
    expect(subtreeSql).not.toContain("UNION ALL");
    expect(subtreeSql).toContain("reachable_edges AS");
    await expect(repository.linkSummaryToMessages("summary-a", []))
      .resolves.toBeUndefined();
    await expect(repository.linkSummaryToParents("summary-a", []))
      .resolves.toBeUndefined();

    const lock = db.query.mock.calls.find(
      ([config]) => config.text.includes("pg_advisory_xact_lock"),
    )?.[0];
    expect(lock).toMatchObject({
      values: [
        derivePostgreSqlAdvisoryLockName(projectId, "conversation", "41"),
      ],
    });
    const fileInsert = db.query.mock.calls.find(
      ([config]) => config.text.includes("INSERT INTO lcm.summary_large_files"),
    )?.[0];
    expect(fileInsert).toMatchObject({
      values: [
        projectId,
        "summary-a",
        41,
        JSON.stringify(["opaque-a", "opaque-a", "missing"]),
      ],
    });
    expect(fileInsert?.text).toContain("ORDER BY files.input_ordinal");
    for (const [config, options] of db.query.mock.calls) {
      expect(options).toMatchObject({ projectId });
      if (config.text.includes("lcm.")) {
        expect(config.text).toContain("project_id");
        expect(config.values).toContain(projectId);
      }
      expect(config.text).not.toContain("summary-a");
      expect(config.text).not.toContain("session-a");
    }
  });

  it("applies defaults, skips empty file insertion, and returns missing reads", async () => {
    const db = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("INSERT INTO lcm.summaries")) {
        return result([{
          ...summaryRow,
          kind: "condensed",
          depth: 1,
          earliest_at: null,
          latest_at: null,
          descendant_count: 0,
          descendant_token_count: 0,
          source_message_token_count: 0,
          file_ids: [],
        }]);
      }
      return result([]);
    });
    const repository = new PostgreSqlSummaryRepository(db, projectId);

    await expect(repository.insertSummary({
      summaryId: "summary-b",
      conversationId: 41,
      kind: "condensed",
      content: "summary",
      tokenCount: 1,
      depth: Number.NaN,
      descendantCount: -1,
      descendantTokenCount: Infinity,
    })).resolves.toMatchObject({
      depth: 1,
      fileIds: [],
      descendantCount: 0,
      descendantTokenCount: 0,
    });
    await expect(repository.getSummary("missing")).resolves.toBeNull();
    await expect(repository.getSummaryMessages("missing")).resolves.toEqual([]);
    await expect(repository.getSummaryChildren("missing")).resolves.toEqual([]);
    await expect(repository.getSummaryParents("missing")).resolves.toEqual([]);
    await expect(repository.getSummarySubtree("missing")).resolves.toEqual([]);
    expect(db.query.mock.calls.some(
      ([config]) => config.text.includes("INSERT INTO lcm.summary_large_files"),
    )).toBe(false);
  });

  it("rejects invalid inputs, duplicate links, self-links, and corrupt rows", async () => {
    const repository = new PostgreSqlSummaryRepository(
      executor(() => result([])),
      projectId,
    );

    await expect(repository.insertSummary({
      summaryId: "bad\0id",
      conversationId: 1,
      kind: "leaf",
      content: "x",
      tokenCount: 1,
    })).rejects.toMatchObject({ field: "summary_id" });
    await expect(repository.insertSummary({
      summaryId: "id",
      conversationId: 1,
      kind: "invalid" as never,
      content: "x",
      tokenCount: 1,
    })).rejects.toMatchObject({ field: "kind" });
    await expect(repository.insertSummary({
      summaryId: "id",
      conversationId: 1,
      kind: "leaf",
      content: "x",
      tokenCount: 1,
      depth: 2_147_483_648,
    })).rejects.toMatchObject({ field: "depth" });
    await expect(repository.insertSummary({
      summaryId: "id",
      conversationId: 1,
      kind: "leaf",
      content: "x",
      tokenCount: 1,
      descendantCount: Number.MAX_VALUE,
    })).rejects.toMatchObject({ field: "descendant_count" });
    await expect(repository.insertSummary({
      summaryId: "id",
      conversationId: 1,
      kind: "leaf",
      content: "x",
      tokenCount: -1,
    })).rejects.toMatchObject({ field: "token_count" });
    await expect(repository.insertSummary({
      summaryId: "id",
      conversationId: 1,
      kind: "leaf",
      content: "x",
      tokenCount: 1,
      earliestAt: new Date(Number.NaN),
    })).rejects.toMatchObject({ field: "earliest_at" });
    await expect(repository.insertSummary({
      summaryId: "id",
      conversationId: 1,
      kind: "leaf",
      content: "x",
      tokenCount: 1,
      latestAt: "invalid" as never,
    })).rejects.toMatchObject({ field: "latest_at" });
    await expect(repository.insertSummary({
      summaryId: "id",
      conversationId: 1,
      kind: "leaf",
      content: "x",
      tokenCount: 1,
      earliestAt: "invalid" as never,
      latestAt: "invalid" as never,
    })).rejects.toMatchObject({ field: "earliest_at" });
    await expect(repository.insertSummary({
      summaryId: "id",
      conversationId: 1,
      kind: "leaf",
      content: "x",
      tokenCount: 1,
      earliestAt: new Date("2026-02-01T00:00:00Z"),
      latestAt: new Date("2026-01-01T00:00:00Z"),
    })).rejects.toMatchObject({ field: "summary_range" });
    await expect(repository.linkSummaryToMessages("id", [1, 1]))
      .rejects.toMatchObject({ conflict: "duplicate" });
    await expect(repository.linkSummaryToParents("id", ["id"]))
      .rejects.toMatchObject({ conflict: "cycle" });
    await expect(repository.listRecentSummaries(Number.NaN))
      .rejects.toMatchObject({ field: "limit" });

    const corrupt = new PostgreSqlSummaryRepository(
      executor(() => result([summaryRow, summaryRow])),
      projectId,
    );
    await expect(corrupt.getSummary("summary-a"))
      .rejects.toMatchObject({ conflict: "integrity" });

    const malformed = new PostgreSqlSummaryRepository(
      executor(() => result([{ ...summaryRow, file_ids: "{bad" }])),
      projectId,
    );
    await expect(malformed.getSummary("summary-a"))
      .rejects.toMatchObject({ field: "file_ids" });
  });

  it("classifies missing and cross-conversation link targets atomically", async () => {
    let identityCalls = 0;
    const db = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("SELECT summary_key, summary_id, conversation_id")) {
        identityCalls += 1;
        return result([identityRow]);
      }
      if (config.text.includes("INSERT INTO lcm.summary_messages")) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlSummaryRepository(db, projectId);
    await expect(repository.linkSummaryToMessages("summary-a", [999]))
      .rejects.toBeInstanceOf(PostgreSqlSummaryContextNotFoundError);
    expect(identityCalls).toBe(2);

    const cross = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("SELECT summary_key, summary_id, conversation_id")) {
        return result([identityRow]);
      }
      if (config.text.includes("SELECT stored.summary_key")) {
        return result([{ ...parentIdentityRow, conversation_id: "99" }]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlSummaryRepository(
      cross,
      projectId,
    ).linkSummaryToParents("summary-a", ["parent-a"]))
      .rejects.toMatchObject({ conflict: "cross-conversation" });
  });

  it("rejects recursive cycles and maps database integrity failures", async () => {
    const cyclic = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("SELECT summary_key, summary_id, conversation_id")) {
        return result([identityRow]);
      }
      if (config.text.includes("SELECT stored.summary_key")) {
        return result([parentIdentityRow]);
      }
      if (config.text.includes("WITH RECURSIVE descendants")) {
        return result([{ count: 1n }]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlSummaryRepository(
      cyclic,
      projectId,
    ).linkSummaryToParents("summary-a", ["parent-a"]))
      .rejects.toMatchObject({ conflict: "cycle" });

    const emptyCycleCount = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("SELECT summary_key, summary_id")) {
        return result([identityRow]);
      }
      if (config.text.includes("SELECT stored.summary_key")) {
        return result([parentIdentityRow]);
      }
      if (config.text.includes("WITH RECURSIVE descendants")) return result([]);
      if (config.text.includes("INSERT INTO lcm.summary_parents")) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlSummaryRepository(
      emptyCycleCount,
      projectId,
    ).linkSummaryToParents("summary-a", ["parent-a"]))
      .resolves.toBeUndefined();

    const integrity = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("INSERT INTO lcm.summaries")) {
        throw Object.assign(new Error("constraint details"), { code: "23505" });
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const error = await new PostgreSqlSummaryRepository(
      integrity,
      projectId,
    ).insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgreSqlSummaryContextConflictError);
    expect(error).toMatchObject({ conflict: "integrity" });
    expect(JSON.stringify(error)).not.toContain("constraint details");

    const trigger = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("INSERT INTO lcm.summaries")) {
        throw new PostgreSqlStorageOperationError(
          "STORAGE_OPERATION_FAILED",
          {
            domain: "summaries",
            operation: "insertSummary",
            projectId,
          },
          "P0001",
          false,
        );
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlSummaryRepository(
      trigger,
      projectId,
    ).insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    })).rejects.toMatchObject({ conflict: "cycle" });
  });

  it("retries only deterministic serialization failures", async () => {
    let transactions = 0;
    const db = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("INSERT INTO lcm.summaries")) {
        return result([{ ...summaryRow, file_ids: [] }]);
      }
      return result([]);
    });
    db.transaction.mockImplementation(async (callback) => {
      transactions += 1;
      if (transactions < 3) {
        throw Object.assign(new Error("retry"), { code: "40001" });
      }
      return callback(db);
    });
    await expect(new PostgreSqlSummaryRepository(
      db,
      projectId,
    ).insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    })).resolves.toMatchObject({ summaryId: "summary-a" });
    expect(transactions).toBe(3);
  });

  it("validates a bound lease after the conversation lock and before writes", async () => {
    const order: string[] = [];
    const db = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) {
        if (config.text.includes("pg_advisory_xact_lock")) order.push("lock");
        return prelude;
      }
      if (config.text.includes("current_setting(")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("FROM lcm.fenced_leases") && config.text.includes("SELECT 1")) {
        order.push("lease-row");
        return result([{ locked: 1 }]);
      }
      if (config.text.includes("SELECT fencing_token")) {
        order.push("fence");
        return result([{
          fencing_token: "7",
          validated_at: "2026-01-01T00:00:00.000Z",
        }]);
      }
      if (config.text.includes("INSERT INTO lcm.summaries")) {
        order.push("write");
        return result([{ ...summaryRow, file_ids: [] }]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlSummaryRepository(db, projectId, {
      fence: {
        machineId,
        processId: "process-a",
        operation: "compact",
        fencingToken: 7n,
      },
    });

    await repository.insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    });
    expect(order).toEqual(["lock", "lease-row", "fence", "write"]);
    const fenceQuery = db.query.mock.calls.find(
      ([config]) => config.text.includes("SELECT fencing_token"),
    )?.[0];
    expect(fenceQuery).toMatchObject({
      values: [
        projectId,
        "conversation",
        "41",
        machineId,
        "process-a",
        "compact",
        "7",
      ],
    });
  });
});

describe("PostgreSQL context repository", () => {
  it("implements ordered reads, depths, appends, replacement, and token totals", async () => {
    const db = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("FROM lcm.conversations")) {
        return result([{ conversation_id: "41" }]);
      }
      if (config.text.includes("SELECT summary_key, summary_id, conversation_id")) {
        return result([identityRow]);
      }
      if (config.text.includes("INSERT INTO lcm.context_items")
          && config.text.includes("RETURNING message_id")) {
        const ids = JSON.parse(String(config.values?.[3])) as string[];
        return result(ids.map((messageId) => ({ message_id: messageId })));
      }
      if (config.text.includes("COUNT(*) AS total_count")) {
        const start = Number(config.values?.[2]);
        const end = Number(config.values?.[3]);
        return result([{
          total_count: "4",
          range_count: String(end - start + 1),
          min_ordinal: 0,
          max_ordinal: 3,
        }]);
      }
      if (config.text.includes("COALESCE(MAX(ordinal)")) {
        return result([{ max_ordinal: "1" }]);
      }
      if (config.text.includes("SELECT ordinal")
          && config.text.includes("ORDER BY ordinal")) {
        return result([{ ordinal: 2 }, { ordinal: "3" }]);
      }
      if (config.text.includes("SELECT COALESCE(SUM")) {
        return result([{ total: "18" }]);
      }
      if (config.text.includes("SELECT DISTINCT summary.depth")) {
        return result([{ depth: "0" }, { depth: 2n }]);
      }
      if (config.text.includes("FROM lcm.context_items AS item")
          && config.text.includes("LEFT JOIN")) {
        return result([contextMessageRow, contextSummaryRow]);
      }
      if (
        config.text.includes("INSERT INTO lcm.context_items")
        || config.text.includes("DELETE FROM lcm.context_items")
        || config.text.includes("UPDATE lcm.context_items")
      ) {
        return result([]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlContextRepository(db, projectId);

    await expect(repository.getContextItems(41)).resolves.toMatchObject([
      { ordinal: 0, itemType: "message", messageId: 51 },
      { ordinal: 1, itemType: "summary", summaryId: "summary-a" },
    ]);
    await expect(repository.getDistinctDepthsInContext(41))
      .resolves.toEqual([0, 2]);
    await expect(repository.getDistinctDepthsInContext(
      41,
      { maxOrdinalExclusive: 2.9 },
    )).resolves.toEqual([0, 2]);
    await expect(repository.getDistinctDepthsInContext(
      41,
      { maxOrdinalExclusive: -0.25 },
    )).resolves.toEqual([0, 2]);
    await expect(repository.getDistinctDepthsInContext(
      41,
      { maxOrdinalExclusive: 1e100 },
    )).resolves.toEqual([0, 2]);
    await expect(repository.appendContextMessage(41, 51))
      .resolves.toBeUndefined();
    await expect(repository.appendContextMessages(41, [51, 52]))
      .resolves.toBeUndefined();
    await expect(repository.appendContextSummary(41, "summary-a"))
      .resolves.toBeUndefined();
    await expect(repository.replaceContextRangeWithSummary({
      conversationId: 41,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: "summary-a",
    })).resolves.toBeUndefined();
    await expect(repository.replaceContextRangeWithSummary({
      conversationId: 41,
      startOrdinal: 1,
      endOrdinal: 1,
      summaryId: "summary-a",
    })).resolves.toBeUndefined();
    await expect(repository.getContextTokenCount(41)).resolves.toBe(18);
    await expect(repository.appendContextMessages(41, []))
      .resolves.toBeUndefined();

    const boundedDepths = db.query.mock.calls.filter(
      ([config]) => config.text.includes("item.ordinal::pg_catalog.numeric"),
    ).map(([config]) => config.values?.[2]);
    expect(boundedDepths).toEqual([
      "2",
      "-1",
      BigInt(Math.floor(1e100)).toString(),
    ]);
    const append = db.query.mock.calls.find(
      ([config]) => config.text.includes("RETURNING message_id"),
    )?.[0];
    expect(append?.text).toContain("ORDER BY input.ordinal");
    const singleAppendOptions = db.query.mock.calls.find(
      ([config, options]) => (
        config.text.includes("RETURNING message_id")
        && options.operation === "appendContextMessage"
      ),
    )?.[1];
    expect(singleAppendOptions).toMatchObject({
      domain: "context",
      operation: "appendContextMessage",
      projectId,
    });
    const replaceQueries = db.query.mock.calls.filter(
      ([config]) => (
        config.text.includes("DELETE FROM lcm.context_items")
        || config.text.includes("UPDATE lcm.context_items")
      ),
    );
    expect(replaceQueries.map(([config]) => config.text.trim().split(/\s+/u)[0]))
      .toEqual(["DELETE", "UPDATE", "UPDATE", "DELETE"]);
    expect(replaceQueries.slice(1, 3).map(([config]) => config.values))
      .toEqual([
        [projectId, 41, 1, 2],
        [projectId, 41, 2, 3],
      ]);
  });

  it("rejects missing, duplicate, cross-conversation, and partial-range writes", async () => {
    const missingConversation = executor((config) => {
      const prelude = mutationPrelude(config);
      return prelude ?? result([]);
    });
    await expect(new PostgreSqlContextRepository(
      missingConversation,
      projectId,
    ).appendContextMessage(41, 51))
      .rejects.toMatchObject({ entity: "conversation" });

    const repository = new PostgreSqlContextRepository(
      executor(() => result([])),
      projectId,
    );
    await expect(repository.appendContextMessages(41, [51, 51]))
      .rejects.toMatchObject({ conflict: "duplicate" });
    await expect(repository.replaceContextRangeWithSummary({
      conversationId: 41,
      startOrdinal: 2,
      endOrdinal: 1,
      summaryId: "summary-a",
    })).rejects.toMatchObject({ conflict: "range" });
    await expect(repository.replaceContextRangeWithSummary({
      conversationId: 41,
      startOrdinal: 2_147_483_648,
      endOrdinal: 2_147_483_648,
      summaryId: "summary-a",
    })).rejects.toMatchObject({ field: "start_ordinal" });
    await expect(repository.getDistinctDepthsInContext(
      41,
      { maxOrdinalExclusive: Number.NaN },
    )).resolves.toEqual([]);
    await expect(repository.getDistinctDepthsInContext(
      41,
      { maxOrdinalExclusive: Number.NEGATIVE_INFINITY },
    )).resolves.toEqual([]);

    const cross = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("FROM lcm.conversations")) {
        return result([{ conversation_id: 41 }]);
      }
      if (config.text.includes("SELECT summary_key")) {
        return result([{ ...identityRow, conversation_id: 99 }]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlContextRepository(
      cross,
      projectId,
    ).appendContextSummary(41, "summary-a"))
      .rejects.toMatchObject({ conflict: "cross-conversation" });

    const partial = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("FROM lcm.conversations")) {
        return result([{ conversation_id: 41 }]);
      }
      if (config.text.includes("SELECT summary_key")) return result([identityRow]);
      if (config.text.includes("COUNT(*)")) {
        return result([{
          total_count: "2",
          range_count: "1",
          min_ordinal: 0,
          max_ordinal: 1,
        }]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlContextRepository(
      partial,
      projectId,
    ).replaceContextRangeWithSummary({
      conversationId: 41,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: "summary-a",
    })).rejects.toMatchObject({ conflict: "range" });
  });

  it("fails closed for malformed context rows and unsafe totals", async () => {
    const malformed = executor((config) => {
      if (config.text.includes("LEFT JOIN")) {
        return result([{
          ...contextMessageRow,
          item_type: "message",
          summary_id: "also-summary",
        }]);
      }
      return result([{ total: (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString() }]);
    });
    const repository = new PostgreSqlContextRepository(malformed, projectId);
    await expect(repository.getContextItems(41))
      .rejects.toMatchObject({ field: "item_reference" });
    await expect(repository.getContextTokenCount(41))
      .rejects.toMatchObject({ field: "total" });
  });
});

describe("PostgreSQL large-file repository", () => {
  it("inserts and reads project-scoped opaque metadata deterministically", async () => {
    const db = executor(() => result([largeFileRow]));
    const repository = new PostgreSqlLargeFileRepository(db, projectId);

    await expect(repository.insertLargeFile({
      fileId: "file-a",
      conversationId: 41,
      fileName: "archive.bin",
      mimeType: "application/octet-stream",
      byteSize: Number.MAX_SAFE_INTEGER,
      storageUri: "s3://bucket/key",
      explorationSummary: "opaque",
    })).resolves.toMatchObject({
      fileId: "file-a",
      byteSize: Number.MAX_SAFE_INTEGER,
    });
    await expect(repository.getLargeFile("file-a")).resolves.toMatchObject({
      conversationId: 41,
    });
    await expect(repository.getLargeFilesByConversation(41))
      .resolves.toHaveLength(1);

    expect(db.query.mock.calls[0]?.[0].text)
      .toContain("INSERT INTO lcm.large_files");
    const lookup = db.query.mock.calls.find(
      ([config]) => config.text.includes("file_id_sha256"),
    )?.[0];
    expect(lookup).toMatchObject({ values: [projectId, "file-a"] });
    expect(lookup?.text).toContain("AND file_id = $2");
    expect(db.query.mock.calls.at(-1)?.[0].text)
      .toContain("ORDER BY created_at, file_key");
  });

  it("returns null, classifies missing conversations, and rejects invalid metadata", async () => {
    const missing = new PostgreSqlLargeFileRepository(
      executor(() => result([])),
      projectId,
    );
    await expect(missing.getLargeFile("missing")).resolves.toBeNull();
    await expect(missing.insertLargeFile({
      fileId: "file-a",
      conversationId: 41,
      storageUri: "s3://bucket/key",
    })).rejects.toMatchObject({ entity: "conversation" });

    await expect(missing.insertLargeFile({
      fileId: "file-a",
      conversationId: 41,
      storageUri: " ",
    })).rejects.toMatchObject({ field: "storage_uri" });
    await expect(missing.insertLargeFile({
      fileId: "file-a",
      conversationId: 41,
      byteSize: -1,
      storageUri: "s3://bucket/key",
    })).rejects.toMatchObject({ field: "byte_size" });

    const duplicate = new PostgreSqlLargeFileRepository(
      executor(() => result([largeFileRow, largeFileRow])),
      projectId,
    );
    await expect(duplicate.getLargeFile("file-a"))
      .rejects.toMatchObject({ conflict: "integrity" });
  });

  it("fails closed for unsafe bigint rows", async () => {
    const repository = new PostgreSqlLargeFileRepository(
      executor(() => result([{
        ...largeFileRow,
        byte_size: (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(),
      }])),
      projectId,
    );
    await expect(repository.getLargeFile("file-a"))
      .rejects.toMatchObject({ field: "byte_size" });
  });
});

describe("PostgreSQL summary/context transaction seams", () => {
  it("carries fence machine identity through central contexts and omits it when unfenced", async () => {
    const fencedRoot = executor((config) => {
      if (config.text.includes("FROM lcm.summaries")) return result([summaryRow]);
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("current_setting('lock_timeout')")) {
        return result([{ setting: "7s" }]);
      }
      if (config.text.includes("set_config(")
          || config.text.includes("pg_advisory_xact_lock")) {
        return result([]);
      }
      if (config.text.includes("FROM lcm.fenced_leases")
          && config.text.includes("SELECT 1")) {
        return result([{ locked: 1 }]);
      }
      if (config.text.includes("SELECT fencing_token")) {
        return result([{ fencing_token: "1", validated_at: "2026-01-01T00:00:00.000Z" }]);
      }
      if (config.text.includes("INSERT INTO lcm.summaries")) {
        return result([{ ...summaryRow, file_ids: [] }]);
      }
      return result([]);
    });
    const fenced = new PostgreSqlSummaryRepository(fencedRoot, projectId, {
      fence: {
        machineId,
        processId: "process-a",
        operation: "compact",
        fencingToken: 1n,
      },
    });
    await expect(fenced.getSummary("summary-a")).resolves.toMatchObject({
      summaryId: "summary-a",
    });
    await fenced.insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    });
    for (const [, options] of fencedRoot.query.mock.calls) {
      expect(options).toMatchObject({
        projectId,
        machineId,
      });
      expect(["summaries", "coordination"]).toContain(options.domain);
    }
    expect(fencedRoot.transactionOptions).toHaveLength(1);
    expect(fencedRoot.transactionOptions[0]).toMatchObject({
      domain: "summaries",
      projectId,
      machineId,
    });

    const fencedScoped = scopedExecutor((config) => {
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("INSERT INTO lcm.summaries")) {
        return result([{ ...summaryRow, file_ids: [] }]);
      }
      if (config.text.includes("FROM lcm.fenced_leases")
          && config.text.includes("SELECT 1")) {
        return result([{ locked: 1 }]);
      }
      if (config.text.includes("SELECT fencing_token")) {
        return result([{ fencing_token: "1", validated_at: "2026-01-01T00:00:00.000Z" }]);
      }
      return result([]);
    });
    await new PostgreSqlSummaryRepository(fencedScoped, projectId, {
      fence: {
        machineId,
        processId: "process-a",
        operation: "compact",
        fencingToken: 1n,
      },
    }).insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    });
    for (const options of fencedScoped.savepointOptions) {
      expect(options).toMatchObject({
        domain: "summaries",
        projectId,
        machineId,
      });
    }
    for (const [, options] of fencedScoped.query.mock.calls) {
      expect(options).toMatchObject({
        projectId,
        machineId,
      });
      expect(["summaries", "coordination"]).toContain(options.domain);
    }

    const fencedFileRoot = executor((config) =>
      config.text.includes("INSERT INTO lcm.large_files")
        ? result([largeFileRow])
        : result([]));
    await new PostgreSqlLargeFileRepository(fencedFileRoot, projectId, {
      fence: {
        machineId,
        processId: "process-a",
        operation: "compact",
        fencingToken: 1n,
      },
    }).insertLargeFile({
      fileId: "file-a",
      conversationId: 41,
      storageUri: "s3://bucket/key",
    });
    expect(fencedFileRoot.transactionOptions).toHaveLength(1);
    expect(fencedFileRoot.transactionOptions[0]).toMatchObject({
      domain: "large-files",
      operation: "insertLargeFile",
      projectId,
      machineId,
    });

    const unfencedShared = executor((config) => {
      if (config.text.includes("FROM lcm.context_items")) return result([]);
      if (config.text.includes("FROM lcm.large_files")) return result([]);
      return result([]);
    });
    await new PostgreSqlContextRepository(unfencedShared, projectId)
      .getContextItems(41);
    await new PostgreSqlLargeFileRepository(unfencedShared, projectId)
      .getLargeFilesByConversation(41);
    for (const [, options] of unfencedShared.query.mock.calls) {
      expect(options).not.toHaveProperty("machineId");
    }

    const unfenced = executor((config) => config.text.includes("FROM lcm.summaries")
      ? result([summaryRow])
      : result([]));
    await new PostgreSqlSummaryRepository(unfenced, projectId)
      .getSummary("summary-a");
    for (const [, options] of unfenced.query.mock.calls) {
      expect(options).not.toHaveProperty("machineId");
    }
  });

  it("uses savepoints and asserts read committed for scoped mutations", async () => {
    const scoped = scopedExecutor((config) => {
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("INSERT INTO lcm.summaries")) {
        return result([{ ...summaryRow, file_ids: [] }]);
      }
      return result([]);
    });
    await expect(new PostgreSqlSummaryRepository(
      scoped,
      projectId,
    ).insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    })).resolves.toMatchObject({ summaryId: "summary-a" });
    expect(scoped.savepoint).toHaveBeenCalled();

    const wrongIsolation = scopedExecutor((config) => {
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "serializable" }]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlSummaryRepository(
      wrongIsolation,
      projectId,
    ).insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    })).rejects.toMatchObject({ field: "transaction_isolation" });
  });

  it("rejects invalid construction and non-transaction scoped executors", async () => {
    expect(() => new PostgreSqlSummaryRepository(
      executor(() => result([])),
      projectId,
      { lockTimeoutMs: 0 },
    )).toThrowError(PostgreSqlSummaryContextDataError);
    expect(() => new PostgreSqlSummaryRepository(
      executor(() => result([])),
      projectId,
      {
        fence: {
          machineId,
          processId: "",
          operation: "compact",
          fencingToken: 1n,
        },
      },
    )).toThrowError(PostgreSqlSummaryContextDataError);

    const unscoped = {
      query: vi.fn(() => result([])),
    };
    const repository = new PostgreSqlSummaryRepository(
      unscoped as never,
      projectId,
    );
    await expect(repository.getSummary("summary-a"))
      .rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
  });

  it("validates fenced machine IDs before any executor access", () => {
    const constructors = [
      (db: ReturnType<typeof executor>, fence: never) =>
        new PostgreSqlSummaryRepository(db, projectId, { fence }),
      (db: ReturnType<typeof executor>, fence: never) =>
        new PostgreSqlContextRepository(db, projectId, { fence }),
      (db: ReturnType<typeof executor>, fence: never) =>
        new PostgreSqlLargeFileRepository(db, projectId, { fence }),
    ];
    const invalidMachineIds: unknown[] = [
      "opaque-caller-id",
      "018f22c4-6d2a-4f10-8a4c-6b8d3e5f9030",
      "018f22c4-6d2a-7f10-ca4c-6b8d3e5f9030",
      ` ${machineId}`,
      `${machineId} `,
      "",
      "   ",
      1,
      "bad\0machine",
      "\ud800",
    ];

    for (const create of constructors) {
      for (const invalidMachineId of invalidMachineIds) {
        const db = executor(() => {
          throw new Error("executor must not be accessed");
        });
        const fence = {
          machineId: invalidMachineId,
          processId: "process-a",
          operation: "compact",
          fencingToken: 1n,
        } as never;
        let caught: unknown;
        try {
          create(db, fence);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(PostgreSqlSummaryContextDataError);
        expect(caught).toMatchObject({
          domain: "summaries",
          operation: "construct",
          field: "machine_id",
        });
        const serialized = JSON.stringify(caught);
        expect(serialized).not.toContain("machineId");
        expect(serialized).not.toContain("executor must not be accessed");
        if (typeof invalidMachineId === "string" && invalidMachineId.length > 0) {
          expect(serialized).not.toContain(invalidMachineId);
          expect(serialized).not.toContain(JSON.stringify(invalidMachineId).slice(1, -1));
        }
        expect(db.query).not.toHaveBeenCalled();
        expect(db.transaction).not.toHaveBeenCalled();
      }
    }
  });
});

describe("PostgreSQL summary/context defensive branches", () => {
  it("serializes stable error details without retaining sensitive causes", async () => {
    const repository = new PostgreSqlSummaryRepository(
      executor(() => result([])),
      projectId,
    );
    const dataError = await repository.getSummary("\0secret")
      .catch((error: unknown) => error);
    expect(dataError).toBeInstanceOf(PostgreSqlSummaryContextDataError);
    expect((dataError as PostgreSqlSummaryContextDataError).toJSON())
      .toMatchObject({ field: "summary_id" });

    const notFound = await repository.linkSummaryToMessages("missing", [1])
      .catch((error: unknown) => error);
    expect(notFound).toBeInstanceOf(PostgreSqlSummaryContextNotFoundError);
    expect((notFound as PostgreSqlSummaryContextNotFoundError).toJSON())
      .toMatchObject({ entity: "summary" });
  });

  it("rejects malformed UTF-16 and wrong-type caller text before database access", async () => {
    const db = executor(() => result([]));
    const summaries = new PostgreSqlSummaryRepository(db, projectId);
    const context = new PostgreSqlContextRepository(db, projectId);
    const files = new PostgreSqlLargeFileRepository(db, projectId);

    for (const malformed of ["\ud800", "\udc00"]) {
      await expect(summaries.getSummary(malformed))
        .rejects.toMatchObject({ field: "summary_id" });
      await expect(summaries.insertSummary({
        summaryId: "summary-a",
        conversationId: 41,
        kind: "leaf",
        content: malformed,
        tokenCount: 1,
      })).rejects.toMatchObject({ field: "content" });
      await expect(summaries.insertSummary({
        summaryId: "summary-a",
        conversationId: 41,
        kind: "leaf",
        content: "content",
        tokenCount: 1,
        fileIds: [malformed],
      })).rejects.toMatchObject({ field: "file_id" });
      await expect(summaries.listRecentSummariesForSession(malformed, 1))
        .rejects.toMatchObject({ field: "session_id" });
      await expect(summaries.linkSummaryToParents("summary-a", [malformed]))
        .rejects.toMatchObject({ field: "parent_summary_id" });
      await expect(context.appendContextSummary(41, malformed))
        .rejects.toMatchObject({ domain: "context", field: "summary_id" });
      await expect(context.replaceContextRangeWithSummary({
        conversationId: 41,
        startOrdinal: 0,
        endOrdinal: 0,
        summaryId: malformed,
      })).rejects.toMatchObject({ domain: "context", field: "summary_id" });
      await expect(files.insertLargeFile({
        fileId: malformed,
        conversationId: 41,
        storageUri: "file:///safe",
      })).rejects.toMatchObject({ field: "file_id" });
    }

    await expect(summaries.getSummary(undefined as never))
      .rejects.toMatchObject({ field: "summary_id" });
    await expect(summaries.insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: undefined as never,
      tokenCount: 1,
    })).rejects.toMatchObject({ field: "content" });
    await expect(summaries.insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "content",
      tokenCount: 1,
      fileIds: [undefined as never],
    })).rejects.toMatchObject({ field: "file_id" });
    await expect(summaries.listRecentSummariesForSession(undefined as never, 1))
      .rejects.toMatchObject({ field: "session_id" });
    await expect(summaries.linkSummaryToMessages(undefined as never, []))
      .rejects.toMatchObject({ field: "summary_id" });
    await expect(summaries.linkSummaryToParents(
      "summary-a",
      [undefined as never],
    )).rejects.toMatchObject({ field: "parent_summary_id" });
    await expect(context.appendContextSummary(41, undefined as never))
      .rejects.toMatchObject({ domain: "context", field: "summary_id" });
    await expect(files.insertLargeFile({
      fileId: undefined as never,
      conversationId: 41,
      storageUri: "file:///safe",
    })).rejects.toMatchObject({ field: "file_id" });
    await expect(files.insertLargeFile({
      fileId: "file-a",
      conversationId: 41,
      storageUri: undefined as never,
    })).rejects.toMatchObject({ field: "storage_uri" });
    await expect(files.insertLargeFile({
      fileId: "file-a",
      conversationId: 41,
      fileName: 1 as never,
      storageUri: "file:///safe",
    })).rejects.toMatchObject({ field: "file_name" });

    expect(db.query).not.toHaveBeenCalled();
    await expect(summaries.getSummary("valid-\ud83d\ude00"))
      .resolves.toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);

    expect(() => new PostgreSqlSummaryRepository(
      db,
      `bad-\ud800`,
    )).toThrowError(PostgreSqlSummaryContextDataError);
    for (const [field, fence] of [
      ["machine_id", {
        machineId: "\ud800",
        processId: "process",
        operation: "operation",
        fencingToken: 1n,
      }],
      ["owner_process_id", {
        machineId,
        processId: "\ud800",
        operation: "operation",
        fencingToken: 1n,
      }],
      ["lease_operation", {
        machineId,
        processId: "process",
        operation: "\ud800",
        fencingToken: 1n,
      }],
    ] as const) {
      expect(() => new PostgreSqlSummaryRepository(
        db,
        projectId,
        { fence },
      )).toThrowError(expect.objectContaining({ field }));
    }
  });

  it.each([
    [{ depth: {} }, "depth"],
    [{ depth: "1.5" }, "depth"],
    [{ summary_id: 1 }, "summary_id"],
    [{ summary_id: "bad\0id" }, "summary_id"],
    [{ summary_id: "\ud800" }, "summary_id"],
    [{ created_at: "not-a-date" }, "created_at"],
    [{ kind: "unknown" }, "kind"],
    [{ file_ids: [1] }, "file_ids"],
    [{ file_ids: ["bad\0file"] }, "file_ids"],
    [{ file_ids: ["bad\ud800file"] }, "file_ids"],
  ])("fails closed for malformed summary row %#", async (patch, field) => {
    const repository = new PostgreSqlSummaryRepository(
      executor(() => result([{ ...summaryRow, ...patch }])),
      projectId,
    );
    await expect(repository.getSummary("summary-a"))
      .rejects.toMatchObject({ field });
  });

  it("fails closed for damaged bounded-subtree rows", async () => {
    const rootRow = {
      ...summaryRow,
      summary_key: summaryKey,
      edge_parent_summary_key: null,
      edge_ordinal: null,
    };
    const childRow = {
      ...summaryRow,
      summary_id: "child-a",
      summary_key: childKey,
      edge_parent_summary_key: summaryKey,
      edge_ordinal: 0,
    };
    const subtree = (rows: QueryResultRow[]) =>
      new PostgreSqlSummaryRepository(executor((config) => {
        if (config.text.includes("SELECT summary_key, summary_id")) {
          return result([identityRow]);
        }
        if (config.text.includes("WITH RECURSIVE reachable")) {
          return result(rows);
        }
        throw new Error(`unexpected SQL: ${config.text}`);
      }), projectId);

    for (const rows of [
      [
        rootRow,
        childRow,
        { ...childRow, summary_id: "conflicting-child" },
      ],
      [
        rootRow,
        { ...childRow, edge_parent_summary_key: null },
      ],
      [
        rootRow,
        { ...childRow, edge_ordinal: null },
      ],
      [
        rootRow,
        { ...childRow, edge_ordinal: -1 },
      ],
      [
        rootRow,
        { ...childRow, edge_ordinal: 2_147_483_648 },
      ],
      [
        rootRow,
        childRow,
        childRow,
      ],
      [{
        ...childRow,
        edge_parent_summary_key: null,
        edge_ordinal: null,
      }],
      [
        rootRow,
        { ...childRow, edge_parent_summary_key: otherKey },
      ],
      [
        rootRow,
        {
          ...childRow,
          edge_parent_summary_key: null,
          edge_ordinal: null,
        },
      ],
    ]) {
      await expect(subtree(rows).getSummarySubtree("summary-a"))
        .rejects.toBeInstanceOf(StorageOperationError);
    }
  });

  it("chooses canonical bounded BFS metadata across layered diamonds", async () => {
    const targetOne = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9090";
    const targetTwo = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f90a0";
    const targetThree = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f90b0";
    const targetFour = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f90c0";
    const targetFive = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f90d0";
    const edgeRow = (
      key: string,
      id: string,
      parent: string | null,
      ordinal: number | null,
      createdAt = "2026-01-03T00:00:00.000Z",
    ): QueryResultRow => ({
      ...summaryRow,
      summary_key: key,
      summary_id: id,
      created_at: createdAt,
      edge_parent_summary_key: parent,
      edge_ordinal: ordinal,
    });
    const rows = [
      edgeRow(summaryKey, "summary-a", null, null),
      edgeRow(
        otherKey,
        "parent-b",
        summaryKey,
        10_000,
        "2026-01-01T00:00:00.000Z",
      ),
      edgeRow(
        childKey,
        "parent-a",
        summaryKey,
        2_000,
        "2026-01-02T00:00:00.000Z",
      ),
      edgeRow(
        wideKey,
        "equal-path-parent",
        summaryKey,
        2_000,
        "2026-01-01T00:00:00.000Z",
      ),
      edgeRow(targetOne, "target-one", otherKey, 1),
      edgeRow(targetOne, "target-one", childKey, 0),
      edgeRow(targetTwo, "target-two", otherKey, 0),
      edgeRow(targetTwo, "target-two", childKey, 1),
      edgeRow(targetThree, "target-three", otherKey, 0),
      edgeRow(targetThree, "target-three", childKey, 0),
      edgeRow(targetFour, "target-four", wideKey, 1),
      edgeRow(targetFour, "target-four", childKey, 0),
      edgeRow(targetFive, "target-five", wideKey, 0),
      edgeRow(targetFive, "target-five", childKey, 0),
    ];
    const repository = new PostgreSqlSummaryRepository(
      executor((config) => {
        if (config.text.includes("SELECT summary_key, summary_id")) {
          return result([identityRow]);
        }
        if (config.text.includes("WITH RECURSIVE reachable")) {
          return result(rows);
        }
        throw new Error(`unexpected SQL: ${config.text}`);
      }),
      projectId,
    );

    const resultRows = await repository.getSummarySubtree("summary-a");
    expect(resultRows.find((row) => row.summaryId === "target-one"))
      .toMatchObject({
        depthFromRoot: 2,
        parentSummaryId: "parent-a",
        path: "0000002000.0000000000",
      });
    expect(resultRows.find((row) => row.summaryId === "target-two"))
      .toMatchObject({
        depthFromRoot: 2,
        parentSummaryId: "parent-a",
        path: "0000002000.0000000001",
      });
    expect(resultRows.find((row) => row.summaryId === "target-three"))
      .toMatchObject({
        depthFromRoot: 2,
        parentSummaryId: "parent-a",
        path: "0000002000.0000000000",
      });
    expect(resultRows.find((row) => row.summaryId === "target-four"))
      .toMatchObject({
        parentSummaryId: "parent-a",
        path: "0000002000.0000000000",
      });
    expect(resultRows.find((row) => row.summaryId === "target-five"))
      .toMatchObject({
        parentSummaryId: "parent-a",
        path: "0000002000.0000000000",
      });
  });

  it("emits a direct child once when an indirect copy is already queued", async () => {
    const edgeRow = (
      key: string,
      id: string,
      parent: string | null,
      ordinal: number | null,
    ): QueryResultRow => ({
      ...summaryRow,
      summary_key: key,
      summary_id: id,
      edge_parent_summary_key: parent,
      edge_ordinal: ordinal,
    });
    const repository = new PostgreSqlSummaryRepository(
      executor((config) => {
        if (config.text.includes("SELECT summary_key, summary_id")) {
          return result([identityRow]);
        }
        if (config.text.includes("WITH RECURSIVE reachable")) {
          return result([
            edgeRow(summaryKey, "summary-a", null, null),
            edgeRow(otherKey, "bridge", summaryKey, 2_000),
            edgeRow(childKey, "direct-child", summaryKey, 10_000),
            edgeRow(childKey, "direct-child", otherKey, 0),
          ]);
        }
        throw new Error(`unexpected SQL: ${config.text}`);
      }),
      projectId,
    );

    const rows = await repository.getSummarySubtree("summary-a");
    expect(rows.map((row) => row.summaryId)).toEqual([
      "summary-a",
      "bridge",
      "direct-child",
    ]);
    expect(rows.filter((row) => row.summaryId === "direct-child"))
      .toEqual([
        expect.objectContaining({
          depthFromRoot: 1,
          parentSummaryId: "summary-a",
          path: "0000010000",
        }),
      ]);
  });

  it("parses valid JSON file IDs and nullable large-file metadata", async () => {
    const summaries = new PostgreSqlSummaryRepository(
      executor(() => result([{
        ...summaryRow,
        file_ids: JSON.stringify(["same", "same", "missing"]),
      }])),
      projectId,
    );
    await expect(summaries.getSummary("summary-a")).resolves.toMatchObject({
      fileIds: ["same", "same", "missing"],
    });

    const files = new PostgreSqlLargeFileRepository(
      executor(() => result([{
        ...largeFileRow,
        file_name: null,
        mime_type: null,
        byte_size: null,
        exploration_summary: null,
      }])),
      projectId,
    );
    await expect(files.getLargeFile("file-a")).resolves.toMatchObject({
      fileName: null,
      mimeType: null,
      byteSize: null,
      explorationSummary: null,
    });
  });

  it("rejects malformed item types and project identities", async () => {
    const context = new PostgreSqlContextRepository(
      executor(() => result([{
        ...contextMessageRow,
        item_type: "damaged",
      }])),
      projectId,
    );
    await expect(context.getContextItems(41))
      .rejects.toMatchObject({ field: "item_type" });
    expect(() => new PostgreSqlSummaryRepository(
      executor(() => result([])),
      "",
    )).toThrowError(PostgreSqlSummaryContextDataError);
    expect(() => new PostgreSqlSummaryRepository(
      executor(() => result([])),
      `${projectId}\0`,
    )).toThrowError(PostgreSqlSummaryContextDataError);
  });

  it("propagates signals through reads, locks, and final fence validation", async () => {
    const controller = new AbortController();
    const db = executor((config, options) => {
      expect(options.signal).toBe(controller.signal);
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("current_setting(")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("FROM lcm.fenced_leases")
          && config.text.includes("SELECT 1")) {
        return result([{ locked: 1 }]);
      }
      if (config.text.includes("SELECT fencing_token")) {
        return result([{
          fencing_token: 7n,
          validated_at: "2026-01-01T00:00:00.000Z",
        }]);
      }
      if (config.text.includes("INSERT INTO lcm.summaries")) {
        return result([{ ...summaryRow, file_ids: [] }]);
      }
      if (config.text.includes("FROM lcm.summaries AS s")) {
        return result([summaryRow]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlSummaryRepository(db, projectId, {
      signal: controller.signal,
      fence: {
        machineId,
        processId: "process-a",
        operation: "compact",
        fencingToken: 7n,
      },
    });
    await repository.getSummary("summary-a");
    await repository.insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    });
  });

  it("requires read committed before a scoped atomic large-file insertion", async () => {
    const scoped = scopedExecutor((config) =>
      config.text.includes("transaction_isolation")
        ? result([{ transaction_isolation: "read committed" }])
        : result([largeFileRow]));
    await expect(new PostgreSqlLargeFileRepository(
      scoped,
      projectId,
    ).insertLargeFile({
      fileId: "file-a",
      conversationId: 41,
      storageUri: "s3://bucket/key",
    })).resolves.toMatchObject({ fileId: "file-a" });
    expect(scoped.savepoint).toHaveBeenCalledOnce();
    expect(scoped.query.mock.calls[0]?.[0].text)
      .toContain("transaction_isolation");

    const wrongIsolation = scopedExecutor((config) =>
      config.text.includes("transaction_isolation")
        ? result([{ transaction_isolation: "repeatable read" }])
        : result([largeFileRow]));
    await expect(new PostgreSqlLargeFileRepository(
      wrongIsolation,
      projectId,
    ).insertLargeFile({
      fileId: "file-b",
      conversationId: 41,
      storageUri: "s3://bucket/other",
    })).rejects.toMatchObject({
      domain: "large-files",
      field: "transaction_isolation",
      operation: "insertLargeFile",
    });
    expect(wrongIsolation.savepoint).not.toHaveBeenCalled();
    expect(wrongIsolation.query.mock.calls.some(
      ([config]) => config.text.includes("INSERT INTO lcm.large_files"),
    )).toBe(false);
  });

  it("bounds atomic retries and never replays ambiguous commits", async () => {
    const retry = executor(() => result([largeFileRow]));
    let attempts = 0;
    retry.transaction.mockImplementation(async (callback) => {
      attempts += 1;
      if (attempts < 3) {
        throw new PostgreSqlStorageOperationError(
          "STORAGE_OPERATION_FAILED",
          { domain: "large-files", operation: "insertLargeFile", projectId },
          attempts === 1 ? "40001" : "40P01",
          true,
        );
      }
      return callback(retry);
    });
    await expect(new PostgreSqlLargeFileRepository(
      retry,
      projectId,
    ).insertLargeFile({
      fileId: "file-a",
      conversationId: 41,
      storageUri: "s3://bucket/key",
    })).resolves.toMatchObject({ fileId: "file-a" });
    expect(attempts).toBe(3);

    const exhausted = executor(() => result([largeFileRow]));
    exhausted.transaction.mockRejectedValue(new PostgreSqlStorageOperationError(
      "STORAGE_OPERATION_FAILED",
      { domain: "large-files", operation: "insertLargeFile", projectId },
      "40P01",
      true,
    ));
    await expect(new PostgreSqlLargeFileRepository(
      exhausted,
      projectId,
    ).insertLargeFile({
      fileId: "file-a",
      conversationId: 41,
      storageUri: "s3://bucket/key",
    })).rejects.toMatchObject({ sqlState: "40P01" });
    expect(exhausted.transaction).toHaveBeenCalledTimes(3);

    const unknown = executor(() => result([largeFileRow]));
    const commitUnknown = new PostgreSqlCommitOutcomeUnknownError({
      domain: "large-files",
      operation: "insertLargeFile",
      projectId,
    });
    unknown.transaction.mockRejectedValue(commitUnknown);
    await expect(new PostgreSqlLargeFileRepository(
      unknown,
      projectId,
    ).insertLargeFile({
      fileId: "file-a",
      conversationId: 41,
      storageUri: "s3://bucket/key",
    })).rejects.toBe(commitUnknown);
    expect(unknown.transaction).toHaveBeenCalledOnce();

    const mutationUnknown = executor(() => result([]));
    const summaryCommitUnknown = new PostgreSqlCommitOutcomeUnknownError({
      domain: "summaries",
      operation: "insertSummary",
      projectId,
    });
    mutationUnknown.transaction.mockRejectedValue(summaryCommitUnknown);
    await expect(new PostgreSqlSummaryRepository(
      mutationUnknown,
      projectId,
    ).insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    })).rejects.toBe(summaryCommitUnknown);
    expect(mutationUnknown.transaction).toHaveBeenCalledOnce();
  });

  it("restores lock timeout and classifies lock lifecycle failures", async () => {
    const lockFailure = executor((config) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        return result([]);
      }
      if (config.text.includes("current_setting('lock_timeout')")) {
        return result([{ setting: "7s" }]);
      }
      if (config.text.includes("set_config(")) return result([]);
      if (config.text.includes("pg_advisory_xact_lock")) {
        throw Object.assign(new Error("lock secret"), { code: "55P03" });
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlSummaryRepository(
      lockFailure,
      projectId,
    ).insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    })).rejects.toMatchObject({ sqlState: "55P03" });
    expect(lockFailure.query.mock.calls.filter(
      ([config]) => config.text.includes("set_config("),
    )).toHaveLength(2);

    let setCalls = 0;
    const restoreFailure = executor((config) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        return result([]);
      }
      if (config.text.includes("current_setting('lock_timeout')")) {
        return result([{ setting: "7s" }]);
      }
      if (config.text.includes("set_config(")) {
        setCalls += 1;
        if (setCalls === 2) {
          throw Object.assign(new Error("restore"), { code: "08006" });
        }
        return result([]);
      }
      if (config.text.includes("pg_advisory_xact_lock")) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlSummaryRepository(
      restoreFailure,
      projectId,
    ).insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    })).rejects.toMatchObject({ sqlState: "08006" });
  });

  it("normalizes unclassified executor failures", async () => {
    const repository = new PostgreSqlSummaryRepository(
      executor(() => {
        throw new Error("postgresql://user:secret@example.test/db");
      }),
      projectId,
    );
    const error = await repository.getSummary("summary-a")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgreSqlStorageOperationError);
    expect(error).toMatchObject({ sqlState: null });
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it("maps fenced aborts and driver cancellations with a safe machine context", async () => {
    const fence = {
      machineId,
      processId: "process-a",
      operation: "compact",
      fencingToken: 1n,
    } as const;
    const direct = new PostgreSqlSummaryRepository(
      executor((_config, options) => {
        throw new PostgreSqlStorageOperationError(
          "STORAGE_OPERATION_FAILED",
          {
            domain: options.domain,
            operation: options.operation,
            projectId: options.projectId,
            machineId: options.machineId,
          },
          null,
          false,
        );
      }),
      projectId,
      { fence },
    );
    const directError = await direct.getSummary("summary-a")
      .catch((error: unknown) => error);
    expect(directError).toMatchObject({
      projectId,
      domain: "summaries",
      operation: "getSummary",
      machineId,
      sqlState: null,
      retryable: false,
    });

    const driverError = Object.assign(
      new Error("private SQL cancellation with bound secret postgres://url"),
      {
        code: "57014",
        detail: "private detail",
        schema: "private_schema",
        table: "private_table",
        routine: "private_routine",
        address: "10.0.0.9",
      },
    );
    const driver = new PostgreSqlSummaryRepository(
      executor(() => { throw driverError; }),
      projectId,
      { fence },
    );
    const driverMapped = await driver.getSummary("summary-a")
      .catch((error: unknown) => error);
    expect(driverMapped).toMatchObject({
      projectId,
      domain: "summaries",
      operation: "getSummary",
      machineId,
      sqlState: "57014",
      retryable: false,
    });
    const serialized = JSON.stringify(driverMapped);
    expect(Object.keys(JSON.parse(serialized)).sort()).toEqual([
      "backend",
      "code",
      "domain",
      "machineId",
      "message",
      "name",
      "operation",
      "projectId",
      "retryable",
      "sqlState",
    ]);
    for (const canary of [
      "private SQL cancellation",
      "bound secret",
      "postgres://url",
      "private detail",
      "private_schema",
      "private_table",
      "private_routine",
      "10.0.0.9",
    ]) {
      expect(serialized).not.toContain(canary);
    }

    const contextDriver = new PostgreSqlContextRepository(
      executor((_config, options) => { throw driverError; }),
      projectId,
      { fence },
    );
    const contextMapped = await contextDriver.getContextItems(41)
      .catch((error: unknown) => error);
    expect(contextMapped).toMatchObject({
      projectId,
      domain: "context",
      operation: "getContextItems",
      machineId,
      sqlState: "57014",
      retryable: false,
    });
    const contextSerialized = JSON.stringify(contextMapped);
    expect(Object.keys(JSON.parse(contextSerialized)).sort()).toEqual([
      "backend",
      "code",
      "domain",
      "machineId",
      "message",
      "name",
      "operation",
      "projectId",
      "retryable",
      "sqlState",
    ]);
    for (const canary of [
      "private SQL cancellation",
      "bound secret",
      "postgres://url",
      "private detail",
      "private_schema",
      "private_table",
      "private_routine",
      "10.0.0.9",
    ]) {
      expect(contextSerialized).not.toContain(canary);
    }
  });

  it("normalizes fenced machine IDs across all repository diagnostics", async () => {
    const canonical = machineId;
    const uppercase = machineId.toUpperCase();
    const directRead = [
      async (db: ReturnType<typeof executor>, fence: never) =>
        new PostgreSqlSummaryRepository(db, projectId, { fence })
          .getSummary("summary-a"),
      async (db: ReturnType<typeof executor>, fence: never) =>
        new PostgreSqlContextRepository(db, projectId, { fence })
          .getContextItems(41),
      async (db: ReturnType<typeof executor>, fence: never) =>
        new PostgreSqlLargeFileRepository(db, projectId, { fence })
          .getLargeFile("file-a"),
    ];

    for (const machine of [canonical, uppercase]) {
      for (const read of directRead) {
        const fence = {
          machineId: machine,
          processId: "process-a",
          operation: "compact",
          fencingToken: 1n,
        } as never;
        const directDb = executor((_config, options) => {
          throw new PostgreSqlStorageOperationError(
            "STORAGE_OPERATION_FAILED",
            {
              domain: options.domain,
              operation: options.operation,
              projectId: options.projectId,
              machineId: options.machineId,
            },
            null,
            false,
          );
        });
        const directError = await read(directDb, fence)
          .catch((error: unknown) => error);
        expect(directError).toMatchObject({ machineId: canonical });
        expect(JSON.stringify(directError)).toContain(`"machineId":"${canonical}"`);

        const driverDb = executor(() => {
          throw Object.assign(new Error("private cancellation"), {
            code: "57014",
          });
        });
        const driverError = await read(driverDb, fence)
          .catch((error: unknown) => error);
        expect(driverError).toMatchObject({
          machineId: canonical,
          sqlState: "57014",
          retryable: false,
        });
        expect(JSON.stringify(driverError)).toContain(`"machineId":"${canonical}"`);
      }
    }

    const callerFence = {
      machineId: uppercase,
      processId: "process-a",
      operation: "compact",
      fencingToken: 1n,
    };
    const snapshotDb = executor((config, options) => {
      expect(options.machineId).toBe(canonical);
      return config.text.includes("FROM lcm.summaries")
        ? result([summaryRow])
        : result([]);
    });
    const snapshotRepository = new PostgreSqlSummaryRepository(
      snapshotDb,
      projectId,
      { fence: callerFence },
    );
    callerFence.machineId = "opaque-caller-id";
    await expect(snapshotRepository.getSummary("summary-a"))
      .resolves.toMatchObject({ summaryId: "summary-a" });
  });

  it("classifies corrupt identities, missing targets, and conversation races", async () => {
    const corruptIdentity = new PostgreSqlSummaryRepository(
      executor(() => result([identityRow, identityRow])),
      projectId,
    );
    await expect(corruptIdentity.getSummaryMessages("summary-a"))
      .rejects.toMatchObject({ conflict: "integrity" });

    const noSummary = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("FROM lcm.conversations")) {
        return result([{ conversation_id: 41 }]);
      }
      return result([]);
    });
    await expect(new PostgreSqlContextRepository(
      noSummary,
      projectId,
    ).appendContextSummary(41, "missing"))
      .rejects.toMatchObject({ entity: "summary" });

    const missingConversation = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("INSERT INTO lcm.summaries")) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlSummaryRepository(
      missingConversation,
      projectId,
    ).insertSummary({
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf",
      content: "summary",
      tokenCount: 1,
    })).rejects.toMatchObject({ entity: "conversation" });

    let identityCalls = 0;
    const moved = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("SELECT summary_key")) {
        identityCalls += 1;
        return result([{
          ...identityRow,
          conversation_id: identityCalls === 1 ? 41 : 42,
        }]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlSummaryRepository(
      moved,
      projectId,
    ).linkSummaryToMessages("summary-a", [51]))
      .rejects.toMatchObject({ conflict: "cross-conversation" });

    const missingParent = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("SELECT summary_key")) return result([identityRow]);
      if (config.text.includes("SELECT stored.summary_key")) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlSummaryRepository(
      missingParent,
      projectId,
    ).linkSummaryToParents("summary-a", ["missing"]))
      .rejects.toMatchObject({ entity: "summary" });
  });

  it("handles absent aggregates and aborts unsafe or partial context appends", async () => {
    for (const [maximum, ids] of [
      [Number.MAX_SAFE_INTEGER, [51]],
      [2_147_483_647, [51]],
      [2_147_483_646, [51, 52]],
    ] as const) {
      const overflow = executor((config) => {
        const prelude = mutationPrelude(config);
        if (prelude) return prelude;
        if (config.text.includes("FROM lcm.conversations")) {
          return result([{ conversation_id: 41 }]);
        }
        if (config.text.includes("MAX(ordinal)")) {
          return result([{ max_ordinal: maximum }]);
        }
        throw new Error(`unexpected SQL: ${config.text}`);
      });
      await expect(new PostgreSqlContextRepository(
        overflow,
        projectId,
      ).appendContextMessages(41, [...ids]))
        .rejects.toMatchObject({ field: "ordinal" });
    }

    for (const maximum of [2_147_483_647, Number.MAX_SAFE_INTEGER]) {
      const overflow = executor((config) => {
        const prelude = mutationPrelude(config);
        if (prelude) return prelude;
        if (config.text.includes("FROM lcm.conversations")) {
          return result([{ conversation_id: 41 }]);
        }
        if (config.text.includes("SELECT summary_key")) {
          return result([identityRow]);
        }
        if (config.text.includes("MAX(ordinal)")) {
          return result([{ max_ordinal: maximum }]);
        }
        throw new Error(`unexpected SQL: ${config.text}`);
      });
      await expect(new PostgreSqlContextRepository(
        overflow,
        projectId,
      ).appendContextSummary(41, "summary-a"))
        .rejects.toMatchObject({ field: "ordinal" });
    }

    const partial = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("FROM lcm.conversations")) {
        return result([{ conversation_id: 41 }]);
      }
      if (config.text.includes("MAX(ordinal)")) return result([]);
      if (config.text.includes("RETURNING message_id")) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlContextRepository(
      partial,
      projectId,
    ).appendContextMessage(41, 51))
      .rejects.toMatchObject({ entity: "message" });

    const absentMaximum = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("FROM lcm.conversations")) {
        return result([{ conversation_id: 41 }]);
      }
      if (config.text.includes("SELECT summary_key")) {
        return result([identityRow]);
      }
      if (config.text.includes("MAX(ordinal)")) return result([]);
      if (config.text.includes("INSERT INTO lcm.context_items")) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    await expect(new PostgreSqlContextRepository(
      absentMaximum,
      projectId,
    ).appendContextSummary(41, "summary-a")).resolves.toBeUndefined();
    expect(absentMaximum.query.mock.calls.find(
      ([config]) => config.text.includes("INSERT INTO lcm.context_items"),
    )?.[0].values).toEqual([projectId, 41, 0, summaryKey]);

    const noTotal = new PostgreSqlContextRepository(
      executor(() => result([])),
      projectId,
    );
    await expect(noTotal.getContextTokenCount(41)).resolves.toBe(0);
  });

  it("rejects cross-conversation replacement and each damaged-range shape", async () => {
    function rangeExecutor(row: QueryResultRow, conversationId = 41) {
      return executor((config) => {
        const prelude = mutationPrelude(config);
        if (prelude) return prelude;
        if (config.text.includes("FROM lcm.conversations")) {
          return result([{ conversation_id: 41 }]);
        }
        if (config.text.includes("SELECT summary_key")) {
          return result([{ ...identityRow, conversation_id: conversationId }]);
        }
        if (config.text.includes("COUNT(*) AS total_count")) return result([row]);
        throw new Error(`unexpected SQL: ${config.text}`);
      });
    }

    await expect(new PostgreSqlContextRepository(
      rangeExecutor({}, 99),
      projectId,
    ).replaceContextRangeWithSummary({
      conversationId: 41,
      startOrdinal: 0,
      endOrdinal: 0,
      summaryId: "summary-a",
    })).rejects.toMatchObject({ conflict: "cross-conversation" });

    for (const row of [
      {},
      {
        total_count: 1,
        range_count: 1,
        min_ordinal: 1,
        max_ordinal: 1,
      },
      {
        total_count: 2,
        range_count: 1,
        min_ordinal: 0,
        max_ordinal: 2,
      },
    ]) {
      await expect(new PostgreSqlContextRepository(
        rangeExecutor(row),
        projectId,
      ).replaceContextRangeWithSummary({
        conversationId: 41,
        startOrdinal: 0,
        endOrdinal: 0,
        summaryId: "summary-a",
      })).rejects.toMatchObject({ conflict: "range" });
    }
  });

  it("snapshots mutable fence and method inputs before awaiting", async () => {
    let releaseFirst = (): void => {};
    const firstWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let blocked = false;
    const summaryDb = executor(async (config) => {
      if (!blocked && config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        blocked = true;
        await firstWait;
        return result([]);
      }
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("current_setting(")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("FROM lcm.fenced_leases")
          && config.text.includes("SELECT 1")) {
        return result([{ locked: 1 }]);
      }
      if (config.text.includes("SELECT fencing_token")) {
        return result([{
          fencing_token: 7n,
          validated_at: "2026-01-01T00:00:00.000Z",
        }]);
      }
      if (config.text.includes("INSERT INTO lcm.summaries")) {
        return result([{ ...summaryRow, file_ids: [] }]);
      }
      if (config.text.includes("summary_large_files")) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const mutableFence = {
      machineId,
      processId: "process-a",
      operation: "compact",
      fencingToken: 7n,
    };
    const summaryInput = {
      summaryId: "summary-a",
      conversationId: 41,
      kind: "leaf" as const,
      content: "original",
      tokenCount: 1,
      fileIds: ["file-a"],
      earliestAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const summaryPromise = new PostgreSqlSummaryRepository(
      summaryDb,
      projectId,
      { fence: mutableFence },
    ).insertSummary(summaryInput);
    mutableFence.processId = "redirected";
    mutableFence.operation = "other";
    mutableFence.fencingToken = 99n;
    summaryInput.content = "mutated";
    summaryInput.fileIds.push("file-b");
    summaryInput.earliestAt.setUTCFullYear(2030);
    releaseFirst();
    await summaryPromise;
    const fence = summaryDb.query.mock.calls.find(
      ([config]) => config.text.includes("SELECT fencing_token"),
    )?.[0];
    expect(fence?.values).toEqual([
      projectId,
      "conversation",
      "41",
      machineId,
      "process-a",
      "compact",
      "7",
    ]);
    const insertedSummary = summaryDb.query.mock.calls.find(
      ([config]) => config.text.includes("INSERT INTO lcm.summaries"),
    )?.[0];
    expect(insertedSummary?.values?.[5]).toBe("original");
    expect(insertedSummary?.values?.[7]).toEqual(
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const insertedFiles = summaryDb.query.mock.calls.find(
      ([config]) => config.text.includes("summary_large_files"),
    )?.[0];
    expect(insertedFiles?.values?.[3]).toBe(JSON.stringify(["file-a"]));
  });

  it("snapshots link, context, range, and large-file inputs before awaiting", async () => {
    const linkDb = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("SELECT summary_key, summary_id")) {
        return result([identityRow]);
      }
      if (config.text.includes("INSERT INTO lcm.summary_messages")) {
        return result([{ message_id: 51 }]);
      }
      if (config.text.includes("SELECT stored.summary_key")) {
        return result([parentIdentityRow]);
      }
      if (config.text.includes("WITH RECURSIVE descendants")) {
        return result([{ count: 0 }]);
      }
      if (config.text.includes("INSERT INTO lcm.summary_parents")) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const summaries = new PostgreSqlSummaryRepository(linkDb, projectId);
    const messageIds = [51];
    const messagesPromise = summaries.linkSummaryToMessages(
      "summary-a",
      messageIds,
    );
    messageIds[0] = 999;
    await messagesPromise;
    const messageLink = linkDb.query.mock.calls.find(
      ([config]) => config.text.includes("INSERT INTO lcm.summary_messages"),
    )?.[0];
    expect(messageLink?.values?.[3]).toBe(JSON.stringify([51]));

    const parentIds = ["parent-a"];
    const parentsPromise = summaries.linkSummaryToParents(
      "summary-a",
      parentIds,
    );
    parentIds[0] = "redirected";
    await parentsPromise;
    const parentLookup = linkDb.query.mock.calls.find(
      ([config]) => config.text.includes("SELECT stored.summary_key"),
    )?.[0];
    expect(parentLookup?.values?.[1]).toBe(JSON.stringify(["parent-a"]));

    const contextDb = executor((config) => {
      const prelude = mutationPrelude(config);
      if (prelude) return prelude;
      if (config.text.includes("FROM lcm.conversations")) {
        return result([{ conversation_id: 41 }]);
      }
      if (config.text.includes("RETURNING message_id")) {
        return result([{ message_id: 51 }]);
      }
      if (config.text.includes("SELECT summary_key")) return result([identityRow]);
      if (config.text.includes("COUNT(*) AS total_count")) {
        return result([{
          total_count: 1,
          range_count: 1,
          min_ordinal: 0,
          max_ordinal: 0,
        }]);
      }
      if (config.text.includes("MAX(ordinal)")) {
        return result([{ max_ordinal: -1 }]);
      }
      if (
        config.text.includes("DELETE FROM lcm.context_items")
        || config.text.includes("INSERT INTO lcm.context_items")
      ) {
        return result([]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const context = new PostgreSqlContextRepository(contextDb, projectId);
    const contextIds = [51];
    const appendPromise = context.appendContextMessages(41, contextIds);
    contextIds[0] = 999;
    await appendPromise;
    const append = contextDb.query.mock.calls.find(
      ([config]) => config.text.includes("RETURNING message_id"),
    )?.[0];
    expect(append?.values?.[3]).toBe(JSON.stringify([51]));

    const range = {
      conversationId: 41,
      startOrdinal: 0,
      endOrdinal: 0,
      summaryId: "summary-a",
    };
    const replacePromise = context.replaceContextRangeWithSummary(range);
    range.conversationId = 99;
    range.startOrdinal = 5;
    range.endOrdinal = 9;
    range.summaryId = "redirected";
    await replacePromise;
    const rangeRead = contextDb.query.mock.calls.find(
      ([config]) => config.text.includes("COUNT(*) AS total_count"),
    )?.[0];
    expect(rangeRead?.values).toEqual([projectId, 41, 0, 0]);

    const fileDb = executor(() => result([largeFileRow]));
    const fileInput = {
      fileId: "file-a",
      conversationId: 41,
      fileName: "original.bin",
      mimeType: "application/original",
      byteSize: 7,
      storageUri: "s3://original",
      explorationSummary: "original",
    };
    const filePromise = new PostgreSqlLargeFileRepository(
      fileDb,
      projectId,
    ).insertLargeFile(fileInput);
    fileInput.fileName = "redirected.bin";
    fileInput.mimeType = "application/redirected";
    fileInput.byteSize = 99;
    fileInput.storageUri = "s3://redirected";
    fileInput.explorationSummary = "redirected";
    await filePromise;
    const fileInsert = fileDb.query.mock.calls.find(
      ([config]) => config.text.includes("INSERT INTO lcm.large_files"),
    )?.[0];
    expect(fileInsert?.values).toEqual([
      projectId,
      "file-a",
      41,
      "original.bin",
      "application/original",
      7,
      "s3://original",
      "original",
    ]);
  });
});
