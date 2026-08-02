import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { PostgreSqlQueryOptions } from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlCoordinationDataError,
} from "../../src/storage/postgresql/coordination.js";
import {
  PostgreSqlCoordinationRepository,
  PostgreSqlMemoryDataError,
  type PostgreSqlMemoryExecutor,
  type PostgreSqlMemoryScopedExecutor,
  PostgreSqlPromotedMemoryRepository,
  PostgreSqlRecallRepository,
  PostgreSqlRedactionAdminRepository,
} from "../../src/storage/postgresql/memory-repositories.js";
import { sessionInstructionsScopeHash } from "../../src/storage/session-instructions.js";

const projectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const machineId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9030";
const memoryId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9040";
const importedMemoryId = "550e8400-e29b-41d4-a716-446655440000";
const ingestKey = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9050";
const instructionScope = {
  clientName: "codex",
  sessionId: "session-a",
  worktreePath: "/repo/worktree-a",
  cwdPath: "/repo/worktree-a/src",
} as const;

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function executor(
  implementation: (
    config: QueryConfig<unknown[]>,
    options: PostgreSqlQueryOptions,
  ) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>,
): PostgreSqlMemoryExecutor & {
  query: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(implementation);
  const db = {
    query,
    transaction: vi.fn(async (
      callback: Parameters<PostgreSqlMemoryExecutor["transaction"]>[0],
    ) => callback(db)),
  } as unknown as PostgreSqlMemoryExecutor & {
    query: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
  return db;
}

function scopedExecutor(
  implementation: (
    config: QueryConfig<unknown[]>,
    options: PostgreSqlQueryOptions,
  ) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>,
): PostgreSqlMemoryScopedExecutor & {
  query: ReturnType<typeof vi.fn>;
  savepoint: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(implementation);
  const scoped = {
    transactionScope: "active",
    query,
    savepoint: vi.fn(async (
      callback: Parameters<PostgreSqlMemoryScopedExecutor["savepoint"]>[0],
    ) => callback({ query })),
  } as PostgreSqlMemoryScopedExecutor & {
    query: ReturnType<typeof vi.fn>;
    savepoint: ReturnType<typeof vi.fn>;
  };
  return scoped;
}

const memoryRow = {
  memory_id: memoryId,
  content: "durable",
  tags: ["architecture", "Mixed"],
  metadata: { source: "test" },
  source_summary_id: "summary-a",
  source_project_id: "source-a",
  session_id: "session-a",
  depth: "2",
  confidence: 0.75,
  created_at: "2026-01-01T00:00:00.000Z",
  archived_at: null,
};

const ingestRow = {
  ingest_key: ingestKey,
  session_id: "session-a",
  message_count: "3",
  completed_at: new Date("2026-01-02T00:00:00.000Z"),
};

describe("PostgreSQL memory repositories", () => {
  it("implements every promoted-memory operation with project-scoped SQL", async () => {
    const db = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.promoted_memories")) {
        return result([{ memory_id: memoryId }]);
      }
      if (config.text.includes("UPDATE lcm.promoted_memories")
          && config.text.includes("RETURNING memory_id")) {
        return result([{ memory_id: memoryId }]);
      }
      if (config.text.includes("days_since_created")) {
        return result([{
          ...memoryRow,
          surfacing_count: "2",
          usage_count: 0n,
          days_since_created: "120",
        }]);
      }
      if (config.text.includes("SELECT content")) {
        return result([{ content: "durable" }]);
      }
      if (config.text.includes("SELECT memory.memory_id")) {
        return result([memoryRow]);
      }
      return result([]);
    });
    const repository = new PostgreSqlPromotedMemoryRepository(db, projectId);

    await expect(repository.insert({
      content: "durable",
      tags: ["architecture", "Mixed"],
      metadata: { source: "test" },
      sourceSummaryId: "summary-a",
      sourceProjectId: "source-a",
      sessionId: "session-a",
      depth: 2,
      confidence: 0.75,
    })).resolves.toBe(memoryId);
    await expect(repository.insert({ content: "defaults" }))
      .resolves.toBe(memoryId);
    await expect(repository.getById(memoryId.toUpperCase())).resolves.toMatchObject({
      id: memoryId,
      tags: ["architecture", "Mixed"],
      metadata: { source: "test" },
      projectId: "source-a",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const importedDb = executor(() => result([{
      ...memoryRow,
      memory_id: importedMemoryId,
    }]));
    await expect(new PostgreSqlPromotedMemoryRepository(
      importedDb,
      projectId,
    ).getById(importedMemoryId.toUpperCase())).resolves.toMatchObject({
      id: importedMemoryId,
    });
    await expect(repository.getById("missing")).resolves.toBeNull();
    await expect(repository.getAll({
      sourceProjectId: "source-a",
      since: "2026-01-01T00:00:00.000Z",
      tags: ["Mixed"],
    })).resolves.toHaveLength(1);
    await expect(repository.getAll({
      since: "2026-01-01 00:00:00",
    })).resolves.toHaveLength(1);
    await expect(repository.getAll()).resolves.toHaveLength(1);
    await expect(repository.listContentPrefixes(0)).resolves.toEqual([]);
    await expect(repository.listContentPrefixes(-1)).resolves.toEqual(["durable"]);
    await expect(repository.listContentPrefixes(2)).resolves.toEqual(["durable"]);

    await expect(repository.update(memoryId, {
      content: "updated",
      confidence: 0.8,
      metadata: { revision: 2 },
      tags: ["updated"],
    })).resolves.toBeUndefined();
    await expect(repository.update(memoryId, {})).resolves.toBeUndefined();
    await expect(repository.update(memoryId, { tags: [] })).resolves.toBeUndefined();
    await expect(repository.update("missing", { content: "ignored" }))
      .resolves.toBeUndefined();
    await expect(repository.archive(memoryId)).resolves.toBeUndefined();
    await expect(repository.archive("missing")).resolves.toBeUndefined();
    await expect(repository.revive(memoryId)).resolves.toBeUndefined();
    await expect(repository.deleteById(memoryId)).resolves.toBeUndefined();
    await expect(repository.deleteById("missing")).resolves.toBeUndefined();
    await expect(repository.findStale({
      staleAfterDays: -1,
      staleSurfacingWithoutUseLimit: 2,
      sourceProjectId: "source-a",
    })).resolves.toMatchObject([{
      id: memoryId,
      surfacingCount: 2,
      usageCount: 0,
      daysSinceCreated: 120,
    }]);
    await expect(repository.findStale({
      staleAfterDays: 1,
      staleSurfacingWithoutUseLimit: 2,
    })).resolves.toHaveLength(1);

    const calls = db.query.mock.calls.map(([config]) =>
      config as QueryConfig<unknown[]>);
    expect(calls.every((config) =>
      config.values?.[0] === projectId)).toBe(true);
    const tagInsert = calls.find((config) =>
      config.text.includes("INSERT INTO lcm.promoted_memory_tags"));
    expect(tagInsert?.values).toEqual([
      projectId,
      memoryId,
      JSON.stringify(["architecture", "Mixed"]),
    ]);
    expect(tagInsert?.text).toContain("WITH ORDINALITY");
    expect(calls.find((config) => config.text.includes("getAll")))
      .toBeUndefined();
  });

  it("implements recall aggregation, redaction counters, and exact purge counts", async () => {
    const db = executor((config) => {
      if (config.text.includes("last_surfaced_at")) {
        return result([{
          memory_id: "memory-a",
          usage_count: "1",
          surfacing_count: 2n,
          last_surfaced_at: "2026-01-03T00:00:00.000Z",
        }]);
      }
      if (config.text.includes("top_recalled")) {
        return result([{
          memories_surfaced: "2",
          memories_acted_upon: 1n,
          top_recalled: [{
            id: "memory-a",
            content: "durable",
            actCount: "1",
          }],
        }]);
      }
      if (config.text.includes("AS gitleaks")) {
        return result([{
          gitleaks: "1",
          built_in: 2n,
          global: 3,
          project: "4",
        }]);
      }
      if (config.text.includes("WITH deleted AS")) {
        return result([{ count: "1" }]);
      }
      return result([]);
    });
    const recall = new PostgreSqlRecallRepository(db, projectId);
    const redaction = new PostgreSqlRedactionAdminRepository(db, projectId);

    await expect(recall.logSurfacing(
      ["memory-a", "memory-a"],
      "session-a",
    )).resolves.toBeUndefined();
    await expect(recall.logSurfacing(["memory-😀"], null))
      .resolves.toBeUndefined();
    await expect(recall.logSurfacing([], null)).resolves.toBeUndefined();
    await expect(recall.getFeedback([])).resolves.toEqual(new Map());
    await expect(recall.getFeedback(["memory-a", "memory-b"])).resolves
      .toEqual(new Map([
        ["memory-a", {
          usageCount: 1,
          surfacingCount: 2,
          lastSurfacedAt: "2026-01-03T00:00:00.000Z",
        }],
        ["memory-b", {
          usageCount: 0,
          surfacingCount: 0,
          lastSurfacedAt: null,
        }],
      ]));
    await expect(recall.getStats()).resolves.toEqual({
      memoriesSurfaced: 2,
      memoriesActedUpon: 1,
      recallPrecision: 50,
      topRecalled: [{
        id: "memory-a",
        content: "durable",
        actCount: 1,
      }],
    });

    await expect(redaction.upsertCounts({
      gitleaks: 1,
      builtIn: 2,
      global: 3,
      project: 4,
    })).resolves.toBeUndefined();
    await expect(redaction.upsertCounts({
      gitleaks: 0,
      builtIn: 0,
      global: 0,
      project: 0,
    })).resolves.toBeUndefined();
    await expect(redaction.getCounts()).resolves.toEqual({
      gitleaks: 1,
      builtIn: 2,
      global: 3,
      project: 4,
      total: 10,
    });
    await expect(redaction.purgeProjectState()).resolves.toEqual({
      promotedMemories: 1,
      promotedTags: 1,
      recallSurfacings: 1,
      redactionCounters: 1,
      sessionIngestLogs: 1,
      sessionInstructions: 1,
    });
    const surfacingInsert = db.query.mock.calls
      .map(([config]) => config as QueryConfig<unknown[]>)
      .find((config) => config.text.includes(
        "INSERT INTO lcm.recall_surfacing",
      ));
    expect(surfacingInsert?.values).toEqual([
      projectId,
      "session-a",
      JSON.stringify(["memory-a", "memory-a"]),
    ]);
  });

  it("deduplicates preserved usage markers while keeping the first ordered memory reference", async () => {
    const db = executor((config) => {
      if (config.text.includes("days_since_created")) return result([]);
      if (config.text.includes("last_surfaced_at")) {
        return result([{
          memory_id: "memory-a",
          usage_count: "1",
          surfacing_count: "0",
          last_surfaced_at: null,
        }]);
      }
      if (config.text.includes("top_recalled")) {
        return result([{
          memories_surfaced: "0",
          memories_acted_upon: "1",
          top_recalled: [{
            id: "memory-a",
            content: "(memory not found)",
            actCount: "1",
          }],
        }]);
      }
      return result([]);
    });
    const promoted = new PostgreSqlPromotedMemoryRepository(db, projectId);
    const recall = new PostgreSqlRecallRepository(db, projectId);

    await expect(promoted.findStale({
      staleAfterDays: 1,
      staleSurfacingWithoutUseLimit: 2,
    })).resolves.toEqual([]);
    await expect(recall.getFeedback(["memory-a"])).resolves.toEqual(new Map([[
      "memory-a",
      {
        usageCount: 1,
        surfacingCount: 0,
        lastSurfacedAt: null,
      },
    ]]));
    await expect(recall.getStats()).resolves.toMatchObject({
      memoriesActedUpon: 1,
      topRecalled: [{ id: "memory-a", actCount: 1 }],
    });

    const usageQueries = db.query.mock.calls
      .map(([config]) => config as QueryConfig<unknown[]>)
      .filter((config) => config.text.includes("signal:memory_used"));
    expect(usageQueries).toHaveLength(3);
    for (const config of usageQueries) {
      expect(config.text).toContain("AND EXISTS (");
      expect(config.text).not.toContain(
        "INNER JOIN lcm.promoted_memory_tags AS marker",
      );
      expect(config.text).toMatch(
        /ORDER BY candidate\.ordinal\s+LIMIT 1/u,
      );
    }
  });

  it("implements existing and new ingest paths plus machine-scoped instructions", async () => {
    const db = executor((config) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        return result([]);
      }
      if (config.text.includes("pg_advisory_xact_lock")) return result([]);
      if (config.text.includes("FROM lcm.session_ingest_log")) {
        return config.values?.[1] === "session-new"
          ? result([])
          : result([ingestRow]);
      }
      if (config.text.includes("FROM lcm.session_instructions")) {
        return result([{
          client_name: instructionScope.clientName,
          session_id: instructionScope.sessionId,
          worktree_path: instructionScope.worktreePath,
          cwd_path: instructionScope.cwdPath,
          content: "rules",
          content_hash: "hash",
          updated_at: "2026-01-04T00:00:00.000Z",
        }]);
      }
      if (config.text.includes("INSERT INTO lcm.session_instructions")) {
        return result([{ instruction_id: "1" }]);
      }
      return result([]);
    });
    const repository = new PostgreSqlCoordinationRepository(
      db,
      projectId,
      machineId,
    );

    await expect(repository.getSessionIngest("session-a")).resolves.toEqual({
      sessionId: "session-a",
      messageCount: 3,
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    await expect(repository.getSessionIngest("session-new")).resolves.toBeNull();
    await expect(repository.recordSessionIngest("session-a", 4))
      .resolves.toBeUndefined();
    await expect(repository.recordSessionIngest("session-new", 1))
      .resolves.toBeUndefined();
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "coordination",
      operation: "recordSessionIngest",
      projectId,
      transactionMode: "read-committed-read-write",
    });
    await expect(repository.getSessionInstructions(instructionScope)).resolves.toEqual({
      ...instructionScope,
      content: "rules",
      contentHash: "hash",
      updatedAt: "2026-01-04T00:00:00.000Z",
    });
    await expect(repository.upsertSessionInstructions(
      instructionScope,
      "rules",
      "hash",
    ))
      .resolves.toBeUndefined();
    await expect(repository.deleteSessionInstructions(instructionScope))
      .resolves.toBeUndefined();

    const calls = db.query.mock.calls.map(([config]) =>
      config as QueryConfig<unknown[]>);
    expect(calls.find((config) => config.text.includes(
      "UPDATE lcm.session_ingest_log",
    ))?.values).toEqual([projectId, ingestKey, 4]);
    expect(calls.find((config) => config.text.includes(
      "INSERT INTO lcm.session_ingest_log",
    ))?.values).toEqual([projectId, "session-new", 1]);
    expect(calls.find((config) => config.text.includes(
      "INSERT INTO lcm.session_instructions",
    ))?.values).toEqual([
      projectId,
      machineId,
      sessionInstructionsScopeHash(instructionScope),
      instructionScope.clientName,
      instructionScope.sessionId,
      instructionScope.worktreePath,
      instructionScope.cwdPath,
      "rules",
      "hash",
    ]);
  });

  it("serializes scoped operations and enforces READ COMMITTED ingest writes", async () => {
    let firstBlocked = true;
    let releaseFirst!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const scoped = scopedExecutor(async (config) => {
      if (config.text.includes("current_setting")) {
        return result([{ transaction_isolation: " READ COMMITTED " }]);
      }
      if (config.text.includes("SELECT content") && firstBlocked) {
        firstBlocked = false;
        await blocker;
        return result([{ content: "first" }]);
      }
      if (config.text.includes("SELECT content")) {
        return result([{ content: "second" }]);
      }
      return result([]);
    });
    const first = new PostgreSqlPromotedMemoryRepository(scoped, projectId);
    const second = new PostgreSqlPromotedMemoryRepository(scoped, projectId);
    const coordination = new PostgreSqlCoordinationRepository(
      scoped,
      projectId,
      machineId,
    );

    const firstRead = first.listContentPrefixes(1);
    const secondRead = second.listContentPrefixes(1);
    await Promise.resolve();
    expect(scoped.query).toHaveBeenCalledTimes(1);
    releaseFirst();
    await expect(firstRead).resolves.toEqual(["first"]);
    await expect(secondRead).resolves.toEqual(["second"]);
    await expect(first.archive(memoryId)).resolves.toBeUndefined();
    await expect(coordination.recordSessionIngest("session-new", 1))
      .resolves.toBeUndefined();
    expect(scoped.savepoint).toHaveBeenCalled();

    const wrongIsolation = scopedExecutor((config) =>
      config.text.includes("current_setting")
        ? result([{ transaction_isolation: "serializable" }])
        : result([]));
    await expect(new PostgreSqlCoordinationRepository(
      wrongIsolation,
      projectId,
      machineId,
    ).recordSessionIngest("session", 1)).rejects.toMatchObject({
      field: "transaction_isolation",
    });

    const invalidScope = {
      query: vi.fn(),
    } as unknown as PostgreSqlMemoryScopedExecutor;
    await expect(new PostgreSqlRecallRepository(
      invalidScope,
      projectId,
    ).getStats()).rejects.toMatchObject({
      code: "STORAGE_TRANSACTION_SCOPE",
      domain: "recall",
    });
  });

  it("fails closed for invalid inputs before database access", async () => {
    const db = executor(() => result([]));
    const promoted = new PostgreSqlPromotedMemoryRepository(db, projectId);
    const recall = new PostgreSqlRecallRepository(db, projectId);
    const redaction = new PostgreSqlRedactionAdminRepository(db, projectId);
    const coordination = new PostgreSqlCoordinationRepository(
      db,
      projectId,
      machineId,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidPromoted: Array<() => Promise<unknown>> = [
      () => promoted.insert({ content: "" }),
      () => promoted.insert({ content: "x", tags: ["bad\0tag"] }),
      () => promoted.insert({ content: "x", metadata: cyclic as never }),
      () => promoted.insert({ content: "x", depth: -1 }),
      () => promoted.insert({ content: "x", confidence: 2 }),
      () => promoted.insert({ content: "x", sourceSummaryId: "bad\0id" }),
      () => promoted.getAll({ since: "not-a-date" }),
      () => promoted.listContentPrefixes(1.5),
      () => promoted.update(memoryId, { content: "" }),
      () => promoted.update(memoryId, { confidence: -0.1 }),
      () => promoted.update(memoryId, { confidence: 2 }),
      () => promoted.update(memoryId, { confidence: Number.NaN }),
      () => promoted.findStale({
        staleAfterDays: Number.POSITIVE_INFINITY,
        staleSurfacingWithoutUseLimit: 1,
      }),
      () => promoted.findStale({
        staleAfterDays: 1,
        staleSurfacingWithoutUseLimit: -1,
      }),
    ];
    const invalidOther: Array<() => Promise<unknown>> = [
      () => recall.logSurfacing(["bad\0id"], null),
      () => recall.getFeedback(["bad\ud800"]),
      () => redaction.upsertCounts({
        gitleaks: -1,
        builtIn: 0,
        global: 0,
        project: 0,
      }),
      () => coordination.getSessionIngest("bad\0session"),
      () => coordination.recordSessionIngest("session", -1),
      () => coordination.getSessionInstructions({
        ...instructionScope,
        clientName: "other",
      } as never),
      () => coordination.getSessionInstructions({
        ...instructionScope,
        sessionId: "",
      }),
      () => coordination.getSessionInstructions({
        ...instructionScope,
        sessionId: "bad\ud800",
      }),
      () => coordination.getSessionInstructions({
        ...instructionScope,
        sessionId: "bad\udc00",
      }),
      () => coordination.getSessionInstructions({
        ...instructionScope,
        worktreePath: "",
      }),
      () => coordination.upsertSessionInstructions(
        instructionScope,
        "bad\0content",
        "hash",
      ),
      () => coordination.upsertSessionInstructions(
        instructionScope,
        "content",
        "bad\udfff",
      ),
      () => coordination.deleteSessionInstructions({
        ...instructionScope,
        cwdPath: "",
      }),
    ];
    for (const operation of [...invalidPromoted, ...invalidOther]) {
      await expect(operation()).rejects.toBeInstanceOf(
        PostgreSqlMemoryDataError,
      );
    }
    expect(db.query).not.toHaveBeenCalled();
    expect(() => new PostgreSqlPromotedMemoryRepository(
      db,
      "not-a-uuid",
    )).toThrow(PostgreSqlMemoryDataError);
    expect(() => new PostgreSqlPromotedMemoryRepository(
      db,
      importedMemoryId,
    )).toThrow(PostgreSqlMemoryDataError);
    expect(() => new PostgreSqlCoordinationRepository(
      db,
      projectId,
      "not-a-uuid",
    )).toThrow(PostgreSqlCoordinationDataError);
    expect(() => new PostgreSqlCoordinationRepository(
      db,
      projectId,
      importedMemoryId,
    )).toThrow(PostgreSqlCoordinationDataError);
    expect(() => new PostgreSqlCoordinationRepository(
      db,
      "not-a-uuid",
      machineId,
    )).toThrow(PostgreSqlCoordinationDataError);
    expect(() => new PostgreSqlCoordinationRepository(
      db,
      importedMemoryId,
      machineId,
    )).toThrow(PostgreSqlCoordinationDataError);
  });

  it("fails closed for malformed persisted rows and unsafe bigint values", async () => {
    expect(new PostgreSqlMemoryDataError(
      projectId,
      "recall",
      "operation",
      "field",
    ).toJSON()).toMatchObject({ field: "field", domain: "recall" });
    const malformedMemoryRows: Array<[string, unknown]> = [
      ["memory_id", "not-a-uuid"],
      ["content", 4],
      ["tags", "not-an-array"],
      ["tags", ["bad\0tag"]],
      ["metadata", []],
      ["source_summary_id", 1],
      ["source_project_id", 1],
      ["session_id", 1],
      ["depth", "-1"],
      ["confidence", Number.NaN],
      ["created_at", "not-a-date"],
      ["archived_at", "not-a-date"],
    ];
    for (const [field, value] of malformedMemoryRows) {
      const db = executor(() => result([{
        ...memoryRow,
        archived_at: "2026-01-02T00:00:00.000Z",
        [field]: value,
      }]));
      await expect(new PostgreSqlPromotedMemoryRepository(
        db,
        projectId,
      ).getById(memoryId)).rejects.toBeInstanceOf(
        PostgreSqlMemoryDataError,
      );
    }
    const nullableFields = executor(() => result([{
      ...memoryRow,
      source_summary_id: null,
      source_project_id: null,
      session_id: null,
      archived_at: "2026-01-02T00:00:00.000Z",
    }]));
    await expect(new PostgreSqlPromotedMemoryRepository(
      nullableFields,
      projectId,
    ).getById(memoryId)).resolves.toMatchObject({
      sourceSummaryId: null,
      projectId,
      sessionId: null,
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const missingMemory = executor(() => result([]));
    await expect(new PostgreSqlPromotedMemoryRepository(
      missingMemory,
      projectId,
    ).getById(memoryId)).resolves.toBeNull();

    const malformedFeedback = executor(() => result([{
      memory_id: "unexpected",
      usage_count: 0,
      surfacing_count: 0,
      last_surfaced_at: null,
    }]));
    await expect(new PostgreSqlRecallRepository(
      malformedFeedback,
      projectId,
    ).getFeedback(["expected"])).rejects.toMatchObject({
      field: "memory_id",
    });

    for (const [value, field] of [
      [String(BigInt(Number.MAX_SAFE_INTEGER) + 1n), "gitleaks"],
      [String(BigInt(Number.MIN_SAFE_INTEGER) - 1n), "gitleaks"],
    ]) {
      const unsafeCounts = executor((config) =>
        config.text.includes("AS gitleaks")
          ? result([{
              gitleaks: value,
              built_in: "0",
              global: "0",
              project: "0",
            }])
          : result([]));
      await expect(new PostgreSqlRedactionAdminRepository(
        unsafeCounts,
        projectId,
      ).getCounts()).rejects.toMatchObject({ field });
    }
    const unsafeTotal = executor((config) =>
      config.text.includes("AS gitleaks")
        ? result([{
            gitleaks: String(Number.MAX_SAFE_INTEGER),
            built_in: "1",
            global: "0",
            project: "0",
          }])
        : result([]));
    await expect(new PostgreSqlRedactionAdminRepository(
      unsafeTotal,
      projectId,
    ).getCounts()).rejects.toMatchObject({ field: "total" });
    for (const [counts, field] of [
      [{
        gitleaks: 1,
        builtIn: 0,
        global: 0,
        project: 0,
      }, "gitleaks"],
      [{
        gitleaks: 0,
        builtIn: 1,
        global: 0,
        project: 0,
      }, "total"],
    ] as const) {
      const overflowWrite = executor((config) =>
        config.text.includes("AS gitleaks")
          ? result([{
              gitleaks: String(Number.MAX_SAFE_INTEGER),
              built_in: "0",
              global: "0",
              project: "0",
            }])
          : result([]));
      await expect(new PostgreSqlRedactionAdminRepository(
        overflowWrite,
        projectId,
      ).upsertCounts(counts)).rejects.toMatchObject({ field });
      expect(overflowWrite.query.mock.calls.some(([config]) =>
        (config as QueryConfig<unknown[]>).text.includes(
          "INSERT INTO lcm.redaction_counters",
        ))).toBe(false);
    }

    const missingRows = executor(() => result([]));
    await expect(new PostgreSqlRecallRepository(
      missingRows,
      projectId,
    ).getStats()).rejects.toMatchObject({ field: "stats" });
    await expect(new PostgreSqlRedactionAdminRepository(
      missingRows,
      projectId,
    ).getCounts()).rejects.toMatchObject({ field: "counts" });
    await expect(new PostgreSqlRedactionAdminRepository(
      missingRows,
      projectId,
    ).purgeProjectState()).rejects.toMatchObject({
      field: "promoted_memories",
    });
  });

  it("rejects malformed recall, coordination, and aggregate result shapes", async () => {
    const feedbackWithNullTimestamp = executor(() => result([{
      memory_id: "memory-a",
      usage_count: 0,
      surfacing_count: 0,
      last_surfaced_at: null,
    }]));
    await expect(new PostgreSqlRecallRepository(
      feedbackWithNullTimestamp,
      projectId,
    ).getFeedback(["memory-a"])).resolves.toEqual(new Map([[
      "memory-a",
      { usageCount: 0, surfacingCount: 0, lastSurfacedAt: null },
    ]]));

    const zeroStats = executor(() => result([{
      memories_surfaced: 0,
      memories_acted_upon: 0,
      top_recalled: [],
    }]));
    await expect(new PostgreSqlRecallRepository(
      zeroStats,
      projectId,
    ).getStats()).resolves.toMatchObject({ recallPrecision: null });

    const malformedTopValues: unknown[] = ["not-an-array", [null], [1], [[]]];
    for (const top_recalled of malformedTopValues) {
      const malformed = executor(() => result([{
        memories_surfaced: 0,
        memories_acted_upon: 0,
        top_recalled,
      }]));
      await expect(new PostgreSqlRecallRepository(
        malformed,
        projectId,
      ).getStats()).rejects.toMatchObject({ field: "top_recalled" });
    }

    const invalidIngestDate = executor(() => result([{
      ...ingestRow,
      completed_at: 4,
    }]));
    await expect(new PostgreSqlCoordinationRepository(
      invalidIngestDate,
      projectId,
      machineId,
    ).getSessionIngest("session-a")).rejects.toMatchObject({
      field: "completed_at",
    });

    const invalidInstructionClient = executor(() => result([{
      client_name: "other",
      session_id: instructionScope.sessionId,
      worktree_path: instructionScope.worktreePath,
      cwd_path: instructionScope.cwdPath,
      content: "rules",
      content_hash: "hash",
      updated_at: "2026-01-04T00:00:00.000Z",
    }]));
    await expect(new PostgreSqlCoordinationRepository(
      invalidInstructionClient,
      projectId,
      machineId,
    ).getSessionInstructions(instructionScope)).rejects.toMatchObject({
      field: "client_name",
      operation: "getSessionInstructions",
    });

    const noInstructions = executor(() => result([]));
    await expect(new PostgreSqlCoordinationRepository(
      noInstructions,
      projectId,
      machineId,
    ).getSessionInstructions(instructionScope)).resolves.toBeNull();
    await expect(new PostgreSqlCoordinationRepository(
      noInstructions,
      projectId,
      machineId,
    ).upsertSessionInstructions(
      instructionScope,
      "collision must not overwrite",
      "hash",
    )).rejects.toMatchObject({
      field: "scope_hash",
      operation: "upsertSessionInstructions",
    });
  });
});
