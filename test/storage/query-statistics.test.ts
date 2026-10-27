import type { QueryConfig, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";
import {
  QUERY_OPERATION_CATALOG,
  QUERY_OPERATION_IDS,
} from "../../src/storage/postgresql/query-operations.js";
import {
  collectPostgreSqlQueryStatistics,
  createPostgreSqlQueryStatisticsCollector,
  createQueryStatisticsFamily,
  QUERY_STATISTIC_METRICS,
} from "../../src/storage/postgresql/query-statistics.js";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";
import {
  QUERY_GET_CONVERSATION_BY_SESSION_ID,
  QUERY_GET_LAST_MESSAGE,
  QUERY_GET_MAX_SEQ,
  QUERY_GET_MAX_SEQ_FOR_APPEND,
  QUERY_GET_MESSAGE_COUNT,
  QUERY_GET_MESSAGES,
  QUERY_GET_MESSAGES_LIMITED,
  QUERY_LIST_CONVERSATIONS,
  QUERY_LOCK_CONVERSATION_FOR_APPEND,
  QUERY_MARK_CONVERSATION_BOOTSTRAPPED,
} from "../../src/storage/postgresql/conversation-repository.js";
import { QUERY_GET_PROMOTED_MEMORY_BY_ID } from "../../src/storage/postgresql/memory-repositories.js";
import {
  QUERY_GET_CONTEXT_ITEMS,
  QUERY_GET_CONTEXT_TOKEN_COUNT,
  QUERY_GET_SUMMARY,
} from "../../src/storage/postgresql/summary-context-repositories.js";

const epoch = "2026-10-19T12:34:56.123456Z";

function result<R extends QueryResultRow>(rows: R[]) {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}

function sourceRow(queryid: string, overrides: Record<string, unknown> = {}) {
  return {
    queryid,
    calls: "2",
    rows: "3",
    total_exec_time: 8,
    min_exec_time: 2,
    max_exec_time: 6,
    mean_exec_time: 4,
    stddev_exec_time: 1,
    total_plan_time: 1,
    shared_blks_hit: "4",
    shared_blks_read: "5",
    shared_blks_dirtied: "6",
    shared_blks_written: "7",
    local_blks_hit: "8",
    local_blks_read: "9",
    local_blks_dirtied: "10",
    local_blks_written: "11",
    temp_blks_read: "12",
    temp_blks_written: "13",
    shared_blk_read_time: 14,
    shared_blk_write_time: 15,
    wal_records: "16",
    wal_bytes: "17",
    stats_since: epoch,
    minmax_stats_since: epoch,
    postmaster_start: epoch,
    stats_reset: epoch,
    ...overrides,
  };
}

function storageError(sqlState: string | null): PostgreSqlStorageOperationError {
  return new PostgreSqlStorageOperationError(
    "STORAGE_OPERATION_FAILED", { domain: "factory", operation: "fixture" }, sqlState, false,
  );
}

function executorFixture(options: {
  track?: unknown;
  trackPlanning?: unknown;
  trackIoTiming?: unknown;
  plans?: readonly (string | null)[];
  planPayloads?: readonly unknown[];
  missingPlanRows?: ReadonlySet<number>;
  rows?: Record<string, unknown>[];
  context?: Record<string, unknown>;
  contextRows?: Record<string, unknown>[];
  contextError?: unknown;
  probeErrors?: ReadonlyMap<number, unknown>;
  rowsError?: unknown;
  onQuery?: (phase: "context" | "probe" | "rows", index: number) => void;
} = {}): PostgreSqlQueryExecutor & { query: ReturnType<typeof vi.fn> } {
  const plans = options.plans ?? QUERY_OPERATION_CATALOG.flatMap((operation, index) =>
    operation.templates.map(() => String(index + 100)));
  let probe = 0;
  const query = vi.fn(async (config: QueryConfig, callOptions: PostgreSqlQueryOptions) => {
    expect(callOptions).toMatchObject({ domain: "factory" });
    expect(callOptions.projectId).toBeUndefined();
    expect(callOptions.projectIds).toBeUndefined();
    if (config.text.includes("current_setting('pg_stat_statements.track'")) {
      options.onQuery?.("context", 0);
      if (options.contextError !== undefined) throw options.contextError;
      return result(options.contextRows ?? [{
        track: Object.hasOwn(options, "track") ? options.track : "top",
        track_planning: Object.hasOwn(options, "trackPlanning") ? options.trackPlanning : "on",
        track_io_timing: Object.hasOwn(options, "trackIoTiming") ? options.trackIoTiming : "on",
        block_size: "8192",
        role_oid: "42",
        database_oid: "84",
        postmaster_start: epoch,
        stats_reset: epoch,
        dealloc: "7",
        ...options.context,
      }]);
    }
    if (config.text.startsWith("EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON)")) {
      const probeIndex = probe;
      options.onQuery?.("probe", probeIndex);
      const probeError = options.probeErrors?.get(probeIndex);
      if (probeError !== undefined) { probe += 1; throw probeError; }
      const queryid = plans[probe++];
      const parser = config.types?.getTypeParser(114);
      expect(parser?.("raw-plan")).toBe("raw-plan");
      if (options.missingPlanRows?.has(probeIndex)) return result([]);
      const supplied = options.planPayloads !== undefined
        && Object.hasOwn(options.planPayloads, probeIndex)
        ? options.planPayloads[probeIndex] : undefined;
      return result([{ "QUERY PLAN": supplied ?? (queryid === null
        ? '[{"Plan":{"Node Type":"Result"}}]'
        : `[{"Plan":{"Node Type":"Result"},"Query Identifier":${queryid}}]`) }]);
    }
    options.onQuery?.("rows", 0);
    expect(config.text).toContain("public.pg_stat_statements(false)");
    if (options.rowsError !== undefined) throw options.rowsError;
    const ids = QUERY_OPERATION_CATALOG.map((_, index) => String(index + 100));
    return result(options.rows ?? ids.map((id) => sourceRow(id)));
  });
  return { query } as unknown as PostgreSqlQueryExecutor & { query: ReturnType<typeof vi.fn> };
}

describe("PostgreSQL query operation catalog", () => {
  it("keeps the frozen starter catalog bounded and deterministic", () => {
    expect(QUERY_OPERATION_IDS).toEqual([
      "conversations.getConversationBySessionId",
      "conversations.lockConversationForAppend",
      "conversations.getMaxSeqForAppend",
      "conversations.getMaxSeq",
      "conversations.getMessages",
      "conversations.getLastMessage",
      "conversations.getMessageCount",
      "conversations.markConversationBootstrapped",
      "conversations.listConversations",
      "summaries.getSummary",
      "context.getContextItems",
      "context.getContextTokenCount",
      "promoted-memory.getById",
    ]);
    expect(QUERY_OPERATION_CATALOG).toHaveLength(13);
    expect(QUERY_OPERATION_CATALOG.flatMap(operation => operation.templates)).toHaveLength(14);
    expect(new Set(QUERY_OPERATION_CATALOG.flatMap(operation => operation.templates)).size).toBe(14);
    expect(QUERY_OPERATION_CATALOG.map(operation => operation.templates)).toEqual([
      [QUERY_GET_CONVERSATION_BY_SESSION_ID],
      [QUERY_LOCK_CONVERSATION_FOR_APPEND],
      [QUERY_GET_MAX_SEQ_FOR_APPEND],
      [QUERY_GET_MAX_SEQ],
      [QUERY_GET_MESSAGES, QUERY_GET_MESSAGES_LIMITED],
      [QUERY_GET_LAST_MESSAGE],
      [QUERY_GET_MESSAGE_COUNT],
      [QUERY_MARK_CONVERSATION_BOOTSTRAPPED],
      [QUERY_LIST_CONVERSATIONS],
      [QUERY_GET_SUMMARY],
      [QUERY_GET_CONTEXT_ITEMS],
      [QUERY_GET_CONTEXT_TOKEN_COUNT],
      [QUERY_GET_PROMOTED_MEMORY_BY_ID],
    ]);
  });
});

describe("PostgreSQL query statistics", () => {
  it("maps packaged statements and exports only bounded numeric aggregates", async () => {
    const executor = executorFixture();
    const collector = createPostgreSqlQueryStatisticsCollector();
    const observation = await collector.collect(executor, {
      publicationWitness: "witness-a",
      signal: new AbortController().signal,
      observedAt: 1234,
    });

    expect(observation.family).toMatchObject({
      status: "observed",
      observedAt: 1234,
      scope: "aggregate",
      statementsDeallocTotal: 7,
      statementsStatsReset: epoch,
      blockSize: 8192,
    });
    expect(observation.family.operations).toHaveLength(13);
    expect(observation.family.operations?.[0]).toEqual({
      operation: QUERY_OPERATION_IDS[0],
      values: {
        queryCallsTotal: 2,
        queryRowsTotal: 3,
        queryExecTimeTotalMs: 8,
        queryExecTimeMinMs: 2,
        queryExecTimeMaxMs: 6,
        queryExecTimeMeanMs: 4,
        queryExecTimeStddevMs: 1,
        queryPlanTimeTotalMs: 1,
        querySharedBlksHitTotal: 4,
        querySharedBlksReadTotal: 5,
        querySharedBlksDirtiedTotal: 6,
        querySharedBlksWrittenTotal: 7,
        queryLocalBlksHitTotal: 8,
        queryLocalBlksReadTotal: 9,
        queryLocalBlksDirtiedTotal: 10,
        queryLocalBlksWrittenTotal: 11,
        queryTempBlksReadTotal: 12,
        queryTempBlksWrittenTotal: 13,
        querySharedBlkReadTimeMs: 14,
        querySharedBlkWriteTimeMs: 15,
        queryWalRecordsTotal: 16,
        queryWalBytesTotal: 17,
      },
      omitted: {},
    });
    expect(new Set(Object.keys(observation.family.operations?.[0]?.values ?? {}))).toEqual(
      new Set(QUERY_STATISTIC_METRICS),
    );
    expect(JSON.stringify(observation.family)).not.toMatch(/queryid|Query Identifier|Node Type/u);
    expect(observation.commit()).toBe(true);
    expect(executor.query).toHaveBeenCalledTimes(16);
    const statements = executor.query.mock.calls.map(call => (call[0] as QueryConfig).text);
    const rowsStatement = statements.find(statement => statement.includes("public.pg_stat_statements(false)"));
    expect(rowsStatement).toContain("public.pg_stat_statements(false)");
    expect(rowsStatement).not.toMatch(/\bquery\b/u);
    const mappingStatements = statements.filter(statement => statement.startsWith("EXPLAIN"));
    const collectorStatements = statements.filter(statement => !statement.startsWith("EXPLAIN"));
    expect(mappingStatements).toHaveLength(14);
    expect(mappingStatements.every(statement => statement.startsWith(
      "EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON)",
    ))).toBe(true);
    expect(mappingStatements.join("\n")).not.toMatch(/\bANALYZE\b/u);
    expect(collectorStatements.join("\n")).not.toMatch(/\b(?:RESET|SET)\b/u);
  });

  it("records observedAt when a successful status is decided", async () => {
    let clock = 100;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const observation = await createPostgreSqlQueryStatisticsCollector().collect(
        executorFixture({ onQuery: () => { clock += 10; } }),
        { publicationWitness: "witness-a" },
      );
      expect(observation.family).toMatchObject({ status: "observed", observedAt: 260 });
    } finally { now.mockRestore(); }
  });

  it("records observedAt when a failed status is decided", async () => {
    let clock = 300;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const observation = await createPostgreSqlQueryStatisticsCollector().collect(
        executorFixture({
          contextError: new Error("private"),
          onQuery: () => { clock = 420; },
        }),
        { publicationWitness: "witness-a" },
      );
      expect(observation.family).toMatchObject({ status: "unavailable", observedAt: 420 });
    } finally { now.mockRestore(); }
  });

  it("reports disabled without mapping or reading statement rows", async () => {
    const executor = executorFixture({ track: "none" });
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(executor, {
      publicationWitness: "witness-a",
    });
    expect(observation.family).toMatchObject({ status: "disabled", scope: "aggregate" });
    expect(observation.family.operations).toBeUndefined();
    expect(observation.commit()).toBe(false);
    expect(executor.query).toHaveBeenCalledOnce();
  });

  it("omits disabled-setting fields without lowering an otherwise complete family", async () => {
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ trackPlanning: "off", trackIoTiming: "off" }),
      { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("observed");
    expect(observation.family.operations?.[0]?.omitted).toMatchObject({
      queryPlanTimeTotalMs: "disabled-setting",
      querySharedBlkReadTimeMs: "disabled-setting",
      querySharedBlkWriteTimeMs: "disabled-setting",
    });
  });

  it.each([
    ["42501", "permission-denied"],
    ["28000", "permission-denied"],
    ["28P01", "permission-denied"],
    ["57014", "timeout"],
    [null, "unavailable"],
  ] as const)("classifies a context failure with SQLSTATE %s as %s", async (sqlState, status) => {
    const error = new PostgreSqlStorageOperationError(
      "STORAGE_OPERATION_FAILED", { domain: "factory", operation: "fixture" }, sqlState, false,
    );
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ contextError: error }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe(status);
    expect(JSON.stringify(observation.family)).not.toContain(String(sqlState));
  });

  it("uses the caller signal when a failing query observes cancellation", async () => {
    const controller = new AbortController();
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({
        contextError: new Error("private"),
        onQuery: phase => { if (phase === "context") controller.abort(); },
      }),
      { publicationWitness: "witness-a", signal: controller.signal },
    );
    expect(observation.family.status).toBe("timeout");
  });

  it.each([
    { contextRows: [] },
    { contextRows: [{}, {}] },
  ])("rejects a context result whose row count is not one", async ({ contextRows }) => {
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ contextRows }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("unavailable");
  });

  it("classifies an already-aborted observation as timeout without a query", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = executorFixture();
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(executor, {
      publicationWitness: "witness-a", signal: controller.signal,
    });
    expect(observation.family.status).toBe("timeout");
    expect(executor.query).not.toHaveBeenCalled();
  });

  it.each([null, "", "invalid"])("fails closed for an invalid track setting %j", async track => {
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ track }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("unavailable");
  });

  it("accepts track=all and omits a missing reset epoch without lowering status", async () => {
    const rows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(
      String(index + 100), { stats_reset: null },
    ));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ track: "all", context: { stats_reset: null }, rows }),
      { publicationWitness: "witness-a" },
    );
    expect(observation.family).toMatchObject({
      status: "observed",
      omitted: { statementsStatsReset: "no-baseline" },
    });
    expect(observation.family.statementsStatsReset).toBeUndefined();
  });

  it.each([
    { role_oid: "0" },
    { database_oid: "4294967296" },
    { postmaster_start: "invalid" },
    { stats_reset: "invalid" },
  ])("rejects invalid context identity or epoch values %#", async context => {
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ context }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("unavailable");
  });

  it("treats unknown dependent settings as partial and unavailable per field", async () => {
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ trackPlanning: "unexpected", trackIoTiming: null }),
      { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("partial");
    expect(observation.family.operations?.[0]?.omitted).toMatchObject({
      queryPlanTimeTotalMs: "unavailable",
      querySharedBlkReadTimeMs: "unavailable",
      querySharedBlkWriteTimeMs: "unavailable",
    });
  });

  it("rejects zero block size while retaining a valid zero deallocation count", async () => {
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ context: { block_size: "0", dealloc: "0" } }),
      { publicationWitness: "witness-a" },
    );
    expect(observation.family).toMatchObject({
      status: "partial",
      statementsDeallocTotal: 0,
      omitted: { blockSize: "out-of-range" },
    });
  });

  it("preserves a signed 64-bit query identifier without numeric coercion", async () => {
    const ids = QUERY_OPERATION_CATALOG.flatMap((operation, index) =>
      operation.templates.map(() => index === 0 ? "9223372036854775807" : String(index + 100)));
    const rows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(
      index === 0 ? "9223372036854775807" : String(index + 100),
    ));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ plans: ids, rows }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("observed");
    expect(JSON.stringify(observation.family)).not.toContain("9223372036854775807");
  });

  it("parses whitespace and escaped top-level plan keys without reading nested identifiers", async () => {
    const payload = ` [ { "Escaped\\\"Key" : {"Query Identifier":9999}, "Query Identifier" : -100 } ] `;
    const rows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(
      index === 0 ? "-100" : String(index + 100),
    ));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ planPayloads: [payload], rows }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("observed");
  });

  it.each([
    7,
    "x".repeat(256 * 1024 + 1),
    "{}",
    "[]",
    '[{"Query Identifier":"not-an-integer"}]',
    '[{"Query Identifier":123.5}]',
    '[{"Query Identifier":123e5}]',
    '[{"Query Identifier":123,"Query Identifier":124}]',
    '[{"Query Identifier":9223372036854775808}]',
    '[{"unterminated}',
    '[{"Plan":{}',
    '[{"Plan":{}}] trailing',
  ])("fails one operation closed for malformed or oversized plan payload %#", async payload => {
    const rows = QUERY_OPERATION_CATALOG.slice(1).map((_, index) => sourceRow(String(index + 101)));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ planPayloads: [payload], rows }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("partial");
    expect(observation.family.operations?.[0]?.omitted).toEqual(allMetricReasons("unavailable"));
  });

  it("fails one operation closed when a mapping query returns no row", async () => {
    const rows = QUERY_OPERATION_CATALOG.slice(1).map((_, index) => sourceRow(String(index + 101)));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ missingPlanRows: new Set([0]), rows }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("partial");
  });

  it("keeps the highest-ranked failure for a multi-template operation", async () => {
    const errors = new Map<number, unknown>([
      [4, storageError("57014")],
      [5, storageError("42501")],
    ]);
    const rows = QUERY_OPERATION_CATALOG
      .filter(operation => operation.id !== "conversations.getMessages")
      .map((_, index) => sourceRow(String(index < 4 ? index + 100 : index + 101)));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ probeErrors: errors, rows }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("partial");
    expect(observation.family.operations?.[4]?.omitted).toEqual(allMetricReasons("permission-denied"));
  });

  it("does not let a mapping cap clobber a ranked multi-template failure", async () => {
    const rows = QUERY_OPERATION_CATALOG.slice(0, 4)
      .map((_, index) => sourceRow(String(index + 100)));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({
        probeErrors: new Map([[4, storageError("42501")]]),
        rows,
      }),
      { publicationWitness: "witness-a", _limits: { maxMappingProbes: 5 } },
    );
    expect(observation.family.status).toBe("partial");
    expect(observation.family.operations?.[4]?.omitted).toEqual(
      allMetricReasons("permission-denied"),
    );
  });

  it("uses the highest-ranked failure when every mapping probe fails", async () => {
    const errors = new Map<number, unknown>();
    for (let index = 0; index < 14; index += 1) errors.set(index, new Error("private"));
    errors.set(1, storageError("57014"));
    errors.set(2, storageError("42501"));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ probeErrors: errors }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("permission-denied");
  });

  it("classifies a probe failure from an aborted signal as timeout", async () => {
    const controller = new AbortController();
    const rows = QUERY_OPERATION_CATALOG.slice(1).map((_, index) => sourceRow(String(index + 101)));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({
        probeErrors: new Map([[0, new Error("private")]]), rows,
        onQuery: (phase, index) => { if (phase === "probe" && index === 0) controller.abort(); },
      }),
      { publicationWitness: "witness-a", signal: controller.signal },
    );
    expect(observation.family.status).toBe("partial");
    expect(observation.family.operations?.[0]?.omitted).toEqual(allMetricReasons("timeout"));
  });

  it("reports partial when one mapping probe is malformed and another remains usable", async () => {
    const rows = QUERY_OPERATION_CATALOG.slice(1).map((_, index) => sourceRow(String(index + 101)));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ planPayloads: ["not-json"], rows }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("partial");
    expect(observation.family.operations?.[0]?.omitted).toEqual(allMetricReasons("unavailable"));
    expect(observation.commit()).toBe(false);
  });

  it("reports unavailable when no probe yields an effective identifier", async () => {
    const plans = QUERY_OPERATION_CATALOG.flatMap(operation => operation.templates.map(() => null));
    const executor = executorFixture({ plans });
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(executor, {
      publicationWitness: "witness-a",
    });
    expect(observation.family.status).toBe("unavailable");
    expect(executor.query).toHaveBeenCalledTimes(15);
  });

  it("fails closed when cross-operation identifiers collide", async () => {
    const plans = QUERY_OPERATION_CATALOG.flatMap(operation => operation.templates.map(() => "1"));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ plans }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("unavailable");
  });

  it("reports partial when no-identifier and colliding operations leave other mappings usable", async () => {
    const noIdentifierPlans = QUERY_OPERATION_CATALOG.flatMap((operation, index) =>
      operation.templates.map(() => index === 0 ? null : String(index + 100)));
    const noIdentifierRows = QUERY_OPERATION_CATALOG.slice(1)
      .map((_, index) => sourceRow(String(index + 101)));
    const noIdentifier = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ plans: noIdentifierPlans, rows: noIdentifierRows }),
      { publicationWitness: "witness-a" },
    );
    expect(noIdentifier.family.status).toBe("partial");
    expect(noIdentifier.family.operations?.[0]?.omitted).toEqual(allMetricReasons("unavailable"));

    const collidedPlans = QUERY_OPERATION_CATALOG.flatMap((operation, index) =>
      operation.templates.map(() => index < 2 ? "1" : String(index + 100)));
    const collidedRows = QUERY_OPERATION_CATALOG.slice(2)
      .map((_, index) => sourceRow(String(index + 102)));
    const collided = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ plans: collidedPlans, rows: collidedRows }),
      { publicationWitness: "witness-a" },
    );
    expect(collided.family.status).toBe("partial");
    expect(collided.family.operations?.[0]?.omitted).toEqual(allMetricReasons("unavailable"));
    expect(collided.family.operations?.[1]?.omitted).toEqual(allMetricReasons("unavailable"));
  });

  it("reports an all-no-entry observation from the epoch sentinel", async () => {
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ rows: [{ queryid: null, postmaster_start: epoch, stats_reset: epoch }] }),
      { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("observed");
    expect(observation.family.operations).toHaveLength(13);
    expect(observation.family.operations?.every(operation =>
      Object.values(operation.omitted).every(reason => reason === "no-entry"))).toBe(true);
    expect(observation.commit()).toBe(true);
  });

  it("rejects inconsistent epoch carriers as stale and malformed rows as unavailable", async () => {
    const stale = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ rows: [sourceRow("100", { stats_reset: "2026-10-19T12:34:57.123456Z" })] }),
      { publicationWitness: "witness-a" },
    );
    expect(stale.family.status).toBe("stale");
    expect(stale.family.operations).toBeUndefined();
    const malformed = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ rows: [sourceRow("9999")] }), { publicationWitness: "witness-a" },
    );
    expect(malformed.family.status).toBe("unavailable");
  });

  it.each([
    [storageError("42501"), "permission-denied"],
    [storageError("57014"), "timeout"],
    [new Error("private"), "unavailable"],
  ] as const)("classifies a rows-read failure as %s", async (rowsError, status) => {
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ rowsError }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe(status);
  });

  it("classifies a rows-read failure after caller cancellation as timeout", async () => {
    const controller = new AbortController();
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({
        rowsError: new Error("private"),
        onQuery: phase => { if (phase === "rows") controller.abort(); },
      }),
      { publicationWitness: "witness-a", signal: controller.signal },
    );
    expect(observation.family.status).toBe("timeout");
  });

  it.each([
    { rows: [] },
    { rows: [sourceRow("100"), { queryid: null, postmaster_start: epoch, stats_reset: epoch }] },
    { rows: [sourceRow("100", { postmaster_start: null })] },
    { rows: [sourceRow("100", { stats_reset: "invalid" })] },
    { rows: [sourceRow("100"), sourceRow("101", { stats_reset: "2026-10-19T12:34:57.123456Z" })] },
  ])("rejects malformed, missing, or inconsistent row carriers %#", async ({ rows }) => {
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ rows }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("unavailable");
  });

  it.each([
    { rows: [sourceRow("not-an-id")] },
    { rows: [sourceRow("9223372036854775808")] },
    { rows: [sourceRow("100"), sourceRow("100")] },
    { rows: [sourceRow("100", { stats_since: "invalid" })] },
    { rows: [sourceRow("100", { minmax_stats_since: null })] },
  ])("rejects malformed candidate identity or entry epochs %#", async ({ rows }) => {
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ rows }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("unavailable");
  });

  it("omits invalid counters and family values rather than rounding or clamping", async () => {
    const rows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(String(index + 100)));
    rows[0] = sourceRow("100", { calls: "9007199254740992", total_exec_time: -1 });
    rows[1] = sourceRow("101", { calls: "bad" });
    rows[2] = sourceRow("102", { rows: "bad" });
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ context: { block_size: "-1", dealloc: "bad" }, rows }),
      { publicationWitness: "witness-a" },
    );
    expect(observation.family).toMatchObject({
      status: "partial",
      omitted: { blockSize: "out-of-range", statementsDeallocTotal: "out-of-range" },
    });
    expect(observation.family.operations?.[0]?.omitted).toMatchObject({
      queryCallsTotal: "out-of-range",
      queryExecTimeTotalMs: "out-of-range",
      queryExecTimeMeanMs: "out-of-range",
    });
    expect(observation.family.operations?.[1]?.omitted).toMatchObject({
      queryCallsTotal: "out-of-range",
      queryExecTimeMeanMs: "out-of-range",
      queryExecTimeStddevMs: "out-of-range",
    });
    expect(observation.family.operations?.[2]?.omitted).toMatchObject({
      queryRowsTotal: "out-of-range",
    });
  });

  it("omits zero-call derived values with no-baseline without lowering status", async () => {
    const rows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(String(index + 100), {
      calls: "0", rows: "0", total_exec_time: 0, mean_exec_time: 0,
      stddev_exec_time: 0, min_exec_time: 0, max_exec_time: 0,
    }));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ rows }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("observed");
    expect(observation.family.operations?.[0]?.omitted).toMatchObject({
      queryExecTimeMeanMs: "no-baseline",
      queryExecTimeStddevMs: "no-baseline",
      queryExecTimeMinMs: "no-baseline",
      queryExecTimeMaxMs: "no-baseline",
    });
  });

  it("marks invalid float totals, dispersion, and extrema out of range", async () => {
    const rows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(
      String(index + 100), index === 0 ? {
        total_plan_time: "not-a-number",
        shared_blk_read_time: -1,
        shared_blk_write_time: Number.POSITIVE_INFINITY,
        mean_exec_time: null,
        stddev_exec_time: null,
        min_exec_time: -1,
        max_exec_time: Number.NaN,
      } : {},
    ));
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ rows }), { publicationWitness: "witness-a" },
    );
    expect(observation.family.status).toBe("partial");
    expect(observation.family.operations?.[0]?.omitted).toMatchObject({
      queryPlanTimeTotalMs: "out-of-range",
      querySharedBlkReadTimeMs: "out-of-range",
      querySharedBlkWriteTimeMs: "out-of-range",
      queryExecTimeStddevMs: "out-of-range",
      queryExecTimeMinMs: "out-of-range",
      queryExecTimeMaxMs: "out-of-range",
    });
  });

  it("omits overflowing pooled totals, means, and variance", async () => {
    const plans = QUERY_OPERATION_CATALOG.flatMap((operation, index) =>
      operation.templates.map((_, template) => operation.id === "conversations.getMessages"
        ? String(400 + template) : String(index + 100)));
    const rows = QUERY_OPERATION_CATALOG
      .filter(operation => operation.id !== "conversations.getMessages")
      .map((_, index) => sourceRow(String(index < 4 ? index + 100 : index + 101)))
      .concat([
        sourceRow("400", { calls: "1", total_exec_time: Number.MAX_VALUE }),
        sourceRow("401", { calls: "1", total_exec_time: Number.MAX_VALUE }),
      ]);
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ plans, rows }), { publicationWitness: "witness-a" },
    );
    const messages = observation.family.operations?.[4];
    expect(observation.family.status).toBe("partial");
    expect(messages?.omitted).toMatchObject({
      queryExecTimeTotalMs: "out-of-range",
      queryExecTimeMeanMs: "out-of-range",
      queryExecTimeStddevMs: "out-of-range",
    });
  });

  it("does not compare counters for disabled settings", async () => {
    const collector = createPostgreSqlQueryStatisticsCollector();
    const first = await collector.collect(executorFixture({
      trackPlanning: "off", trackIoTiming: "off",
    }), { publicationWitness: "witness-a" });
    expect(first.commit()).toBe(true);
    const rows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(String(index + 100), {
      total_plan_time: 0, shared_blk_read_time: 0, shared_blk_write_time: 0,
    }));
    const second = await collector.collect(executorFixture({
      trackPlanning: "off", trackIoTiming: "off", rows,
    }), { publicationWitness: "witness-a" });
    expect(second.family.status).toBe("observed");
  });

  it("pools multiple identifiers with the stable population variance formula", async () => {
    const plans = QUERY_OPERATION_CATALOG.flatMap((operation, index) =>
      operation.templates.map((_, template) => operation.id === "conversations.getMessages"
        ? String(400 + template) : String(index + 100)));
    const rows = QUERY_OPERATION_CATALOG
      .filter(operation => operation.id !== "conversations.getMessages")
      .map((_, index) => sourceRow(String(index < 4 ? index + 100 : index + 101)))
      .concat([
        sourceRow("400", { calls: "2", total_exec_time: 4, mean_exec_time: 2, stddev_exec_time: 1 }),
        sourceRow("401", { calls: "2", total_exec_time: 12, mean_exec_time: 6, stddev_exec_time: 1 }),
      ]);
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ plans, rows }), { publicationWitness: "witness-a" },
    );
    const messages = observation.family.operations?.find(operation =>
      operation.operation === "conversations.getMessages");
    expect(messages?.values).toMatchObject({
      queryCallsTotal: 4,
      queryExecTimeTotalMs: 16,
      queryExecTimeMeanMs: 4,
      queryExecTimeStddevMs: Math.sqrt(5),
    });
  });

  it("marks shortened probe, row, and context limits partial", async () => {
    const one = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ rows: [sourceRow("100")] }),
      { publicationWitness: "witness-a", _limits: { maxMappingProbes: 1 } },
    );
    expect(one.family.status).toBe("partial");
    const truncated = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ rows: [sourceRow("100"), sourceRow("101")] }),
      { publicationWitness: "witness-a", _limits: { maxCandidateRows: 1 } },
    );
    expect(truncated.family.status).toBe("partial");
    const contextBound = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture(),
      { publicationWitness: "witness-a", _limits: { maxComparisonEntries: 1 } },
    );
    expect(contextBound.family.status).toBe("partial");
    expect(contextBound.commit()).toBe(false);
  });

  it("bounds the catalog and handles a zero probe budget without reading rows", async () => {
    const oneOperation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture({ rows: [sourceRow("100")] }),
      { publicationWitness: "witness-a", _limits: { maxOperations: 1 } },
    );
    expect(oneOperation.family.status).toBe("partial");
    expect(oneOperation.family.operations).toHaveLength(13);

    const executor = executorFixture();
    const noProbes = await createPostgreSqlQueryStatisticsCollector().collect(executor, {
      publicationWitness: "witness-a", _limits: { maxMappingProbes: 0 },
    });
    expect(noProbes.family.status).toBe("unavailable");
    expect(executor.query).toHaveBeenCalledOnce();
  });

  it("ignores invalid test-only limit overrides", async () => {
    const observation = await createPostgreSqlQueryStatisticsCollector().collect(
      executorFixture(), {
        publicationWitness: "witness-a",
        _limits: {
          maxOperations: -1,
          maxMappingProbes: Number.NaN,
          maxCandidateRows: 1.5,
          maxComparisonEntries: Number.POSITIVE_INFINITY,
        },
      },
    );
    expect(observation.family.status).toBe("observed");
  });

  it("uses compare-and-swap so overlapping observations cannot overwrite a newer context", async () => {
    const collector = createPostgreSqlQueryStatisticsCollector();
    const first = await collector.collect(executorFixture(), { publicationWitness: "witness-a" });
    const second = await collector.collect(executorFixture(), { publicationWitness: "witness-a" });
    expect(first.commit()).toBe(true);
    expect(first.commit()).toBe(false);
    expect(second.commit()).toBe(false);
  });

  it("does not let a probe-failed partial replace the stored comparison context", async () => {
    const collector = createPostgreSqlQueryStatisticsCollector();
    const first = await collector.collect(executorFixture(), { publicationWitness: "witness-a" });
    expect(first.commit()).toBe(true);
    const partialRows = QUERY_OPERATION_CATALOG.slice(1).map((_, index) => sourceRow(String(index + 101)));
    const partial = await collector.collect(executorFixture({
      probeErrors: new Map([[0, storageError("57014")]]), rows: partialRows,
    }), { publicationWitness: "witness-a" });
    expect(partial.family.status).toBe("partial");
    expect(partial.commit()).toBe(false);
    const decreasedRows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(
      String(index + 100), index === 0 ? { calls: "1" } : {},
    ));
    const compared = await collector.collect(executorFixture({ rows: decreasedRows }), {
      publicationWitness: "witness-a",
    });
    expect(compared.family.status).toBe("partial");
  });

  it("invalidates comparison state when the publication witness changes", async () => {
    const collector = createPostgreSqlQueryStatisticsCollector();
    const first = await collector.collect(executorFixture(), { publicationWitness: "witness-a" });
    expect(first.commit()).toBe(true);
    const decreasedRows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(
      String(index + 100), index === 0 ? { calls: "1" } : {},
    ));
    const next = await collector.collect(executorFixture({ rows: decreasedRows }), {
      publicationWitness: "witness-b",
    });
    expect(next.family.status).toBe("observed");
  });

  it("reports disappearance once and reappearance in a new entry epoch as reset", async () => {
    const collector = createPostgreSqlQueryStatisticsCollector();
    const fullRows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(String(index + 100)));
    const first = await collector.collect(executorFixture({ rows: fullRows }), { publicationWitness: "witness-a" });
    expect(first.commit()).toBe(true);
    const missingRows = fullRows.slice(1);
    const missing = await collector.collect(executorFixture({ rows: missingRows }), { publicationWitness: "witness-a" });
    expect(missing.family.status).toBe("partial");
    expect(missing.commit()).toBe(true);
    const stillMissing = await collector.collect(executorFixture({ rows: missingRows }), { publicationWitness: "witness-a" });
    expect(stillMissing.family.status).toBe("observed");
    expect(stillMissing.commit()).toBe(true);
    const reappeared = await collector.collect(executorFixture({ rows: [
      sourceRow("100", { stats_since: "2026-10-19T12:35:00.000000Z", minmax_stats_since: "2026-10-19T12:35:00.000000Z" }),
      ...missingRows,
    ] }), { publicationWitness: "witness-a" });
    expect(reappeared.family.status).toBe("reset");
  });

  it("accepts a tombstoned identifier that reappears in the same entry epoch", async () => {
    const collector = createPostgreSqlQueryStatisticsCollector();
    const fullRows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(String(index + 100)));
    const first = await collector.collect(executorFixture({ rows: fullRows }), {
      publicationWitness: "witness-a",
    });
    expect(first.commit()).toBe(true);
    const missing = await collector.collect(executorFixture({ rows: fullRows.slice(1) }), {
      publicationWitness: "witness-a",
    });
    expect(missing.commit()).toBe(true);
    const reappeared = await collector.collect(executorFixture({ rows: fullRows }), {
      publicationWitness: "witness-a",
    });
    expect(reappeared.family.status).toBe("observed");
  });

  it("detects an epoch change and a same-epoch monotonic decrease", async () => {
    const collector = createPostgreSqlQueryStatisticsCollector();
    const first = await collector.collect(executorFixture(), { publicationWitness: "witness-a" });
    expect(first.commit()).toBe(true);
    const decreasedRows = QUERY_OPERATION_CATALOG.map((_, index) =>
      sourceRow(String(index + 100), index === 0 ? { calls: "1" } : {}));
    const decreased = await collector.collect(executorFixture({ rows: decreasedRows }), { publicationWitness: "witness-a" });
    expect(decreased.family.status).toBe("partial");
    expect(decreased.commit()).toBe(true);
    const resetEpoch = "2026-10-19T12:36:00.000000Z";
    const resetRows = decreasedRows.map(row => ({ ...row, stats_reset: resetEpoch }));
    const reset = await collector.collect(executorFixture({
      context: { stats_reset: resetEpoch }, rows: resetRows,
    }), { publicationWitness: "witness-a" });
    expect(reset.family.status).toBe("reset");
  });

  it("requires evidence after a min/max-only reset before emitting extrema", async () => {
    const collector = createPostgreSqlQueryStatisticsCollector();
    const minmaxEpoch = "2026-10-19T12:35:00.000000Z";
    const ambiguousRows = QUERY_OPERATION_CATALOG.map((_, index) => sourceRow(
      String(index + 100), index === 0 ? { minmax_stats_since: minmaxEpoch } : {},
    ));
    const first = await collector.collect(executorFixture({ rows: ambiguousRows }), { publicationWitness: "witness-a" });
    expect(first.family.operations?.[0]?.omitted).toMatchObject({
      queryExecTimeMinMs: "no-baseline", queryExecTimeMaxMs: "no-baseline",
    });
    expect(first.commit()).toBe(true);
    const resumedRows = ambiguousRows.map((row, index) => index === 0 ? { ...row, calls: "3" } : row);
    const resumed = await collector.collect(executorFixture({ rows: resumedRows }), { publicationWitness: "witness-a" });
    expect(resumed.family.operations?.[0]?.values).toMatchObject({
      queryExecTimeMinMs: 2, queryExecTimeMaxMs: 6,
    });
  });

  it("constructs status-only families without accepting arbitrary fields", () => {
    expect(createQueryStatisticsFamily("not-applicable", 9)).toEqual({
      status: "not-applicable", observedAt: 9, scope: "aggregate",
    });
  });

  it("uses the module-level collector entrypoint", async () => {
    const observation = await collectPostgreSqlQueryStatistics(
      executorFixture(), { publicationWitness: "default-entrypoint" },
    );
    expect(observation.family.status).toBe("observed");
  });
});

function allMetricReasons(reason: string): Record<string, string> {
  return Object.fromEntries(QUERY_STATISTIC_METRICS.map(metric => [metric, reason]));
}
