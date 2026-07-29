import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { PostgreSqlQueryOptions } from "../../src/storage/postgresql/contracts.js";
import { derivePostgreSqlAdvisoryLockName } from "../../src/storage/postgresql/coordination.js";
import {
  PostgreSqlConversationDataError,
  type PostgreSqlConversationExecutor,
  type PostgreSqlConversationScopedExecutor,
  PostgreSqlConversationRepository,
} from "../../src/storage/postgresql/conversation-repository.js";
import {
  PostgreSqlCommitOutcomeUnknownError,
  PostgreSqlStorageOperationError,
} from "../../src/storage/postgresql/errors.js";

const projectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function executor(
  implementation: (
    config: QueryConfig<unknown[]>,
    options: PostgreSqlQueryOptions,
  ) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>,
): PostgreSqlConversationExecutor & {
  query: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(implementation);
  const db = {
    query,
    transaction: vi.fn(async (
      callback: Parameters<PostgreSqlConversationExecutor["transaction"]>[0],
    ) => callback(db)),
  } as unknown as PostgreSqlConversationExecutor & {
    query: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
  return db;
}

function scopedExecutor(
  query: ReturnType<typeof vi.fn>,
): PostgreSqlConversationScopedExecutor {
  let savepointOrdinal = 0;
  return {
    transactionScope: "active",
    query,
    savepoint: async (callback, options) => {
      savepointOrdinal += 1;
      const savepoint = `lcm_conversation_repository_${savepointOrdinal}`;
      await query({ text: `SAVEPOINT ${savepoint}` }, options);
      const inner = { query };
      try {
        const value = await callback(inner);
        await query({ text: `RELEASE SAVEPOINT ${savepoint}` }, options);
        return value;
      } catch (error) {
        try {
          await query({
            text: `ROLLBACK TO SAVEPOINT ${savepoint}`,
          }, options);
          await query({
            text: `RELEASE SAVEPOINT ${savepoint}`,
          }, options);
        } catch {
          // Runtime failure-state behavior is covered by runtime-specific tests.
        }
        throw error;
      }
    },
  };
}

const conversationRow = {
  conversation_id: "41",
  session_id: "session-a",
  title: "A",
  bootstrapped_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: new Date("2026-01-02T00:00:00.000Z"),
};

const messageRow = {
  message_id: 51n,
  conversation_id: "41",
  seq: 0,
  role: "user",
  content: "hello",
  token_count: "2",
  created_at: "2026-01-03T00:00:00.000Z",
};

const partRow = {
  part_id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9050",
  message_id: "51",
  session_id: "session-a",
  part_type: "text",
  ordinal: 0,
  text_content: "hello",
  tool_call_id: null,
  tool_name: null,
  tool_input: null,
  tool_output: null,
  metadata: " opaque ",
};

describe("PostgreSQL conversation repository", () => {
  it("implements every read and write with parameterized project-scoped SQL", async () => {
    const db = executor((config) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") return result([]);
      if (config.text.includes("pg_advisory_xact_lock")) return result([{ pg_advisory_xact_lock: null }]);
      if (config.text.includes("MAX(seq) AS max_seq")) return result([{ max_seq: null }]);
      if (config.text.includes("COUNT(*) AS count") || config.text.includes("COUNT(message.message_id)")) {
        return result([{ count: "2" }]);
      }
      if (config.text.includes("SELECT 1")) return result([{ exists: 1 }]);
      if (config.text.includes("message_parts") && config.text.includes("SELECT")) return result([partRow]);
      if (config.text.includes("message_parts")) return result([]);
      if (config.text.includes("deleted_messages")) return result([{ count: "2" }]);
      if (config.text.includes("lcm.messages")) return result([messageRow]);
      if (config.text.includes("lcm.conversations")) return result([conversationRow]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.createConversation({ sessionId: "session-a", title: "A" }))
      .resolves.toMatchObject({ conversationId: 41, title: "A" });
    await expect(repository.getConversation(41)).resolves.toMatchObject({ sessionId: "session-a" });
    await expect(repository.getConversationBySessionId("session-a"))
      .resolves.toMatchObject({ conversationId: 41 });
    await expect(repository.getOrCreateConversation("session-a", "ignored"))
      .resolves.toMatchObject({ conversationId: 41 });
    await expect(repository.markConversationBootstrapped(41)).resolves.toBeUndefined();
    await expect(repository.listConversations()).resolves.toHaveLength(1);
    await expect(repository.createMessage({
      conversationId: 41,
      seq: 0,
      role: "user",
      content: "hello",
      tokenCount: 2,
    })).resolves.toMatchObject({ messageId: 51, tokenCount: 2 });
    await expect(repository.createMessagesBulk([{
      conversationId: 41,
      seq: 0,
      role: "user",
      content: "hello",
      tokenCount: 2,
    }])).resolves.toHaveLength(1);
    await expect(repository.appendMessages(41, [{
      role: "user",
      content: "hello",
      tokenCount: 2,
    }])).resolves.toMatchObject([{ seq: 0 }]);
    await expect(repository.getMessages(41)).resolves.toHaveLength(1);
    await expect(repository.getMessages(41, { afterSeq: 0, limit: 1 }))
      .resolves.toHaveLength(1);
    await expect(repository.getLastMessage(41)).resolves.toMatchObject({ messageId: 51 });
    await expect(repository.hasMessage(41, "user", "hello")).resolves.toBe(true);
    await expect(repository.countMessagesByIdentity(41, "user", "hello")).resolves.toBe(2);
    await expect(repository.getMessageById(51)).resolves.toMatchObject({ conversationId: 41 });
    await expect(repository.createMessageParts(51, [{
      sessionId: "session-a",
      partType: "text",
      ordinal: 0,
      textContent: "hello",
      toolCallId: "call-a",
      toolName: "shell",
      toolInput: "{}",
      toolOutput: "done",
      metadata: "opaque",
    }, {
      sessionId: "session-a",
      partType: "reasoning",
      ordinal: 1,
    }])).resolves.toBeUndefined();
    await expect(repository.getMessageParts(51)).resolves.toMatchObject([{
      messageId: 51,
      metadata: " opaque ",
    }]);
    await expect(repository.getMessageCount(41)).resolves.toBe(2);
    await expect(repository.getMessageCountBySessionId("session-a")).resolves.toBe(2);
    await expect(repository.getMaxSeq(41)).resolves.toBe(0);
    await expect(repository.deleteMessages([51, 52])).resolves.toBe(2);

    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "conversations",
      operation: "getOrCreateConversation",
      projectId,
    });
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "conversations",
      operation: "appendMessages",
      projectId,
    });
    for (const [config, options] of db.query.mock.calls) {
      expect(options).toMatchObject({ domain: "conversations", projectId });
      if (config.text.includes("lcm.")) {
        expect(config.text).toContain("project_id");
        expect(config.values).toContain(projectId);
      }
      expect(config.text).not.toContain("session-a");
      expect(config.text).not.toContain("hello");
    }
    const sessionLookup = db.query.mock.calls.find(
      ([config]) => config.text.includes("session_id_sha256"),
    )?.[0];
    expect(sessionLookup).toMatchObject({ values: [projectId, "session-a"] });
    expect(sessionLookup.text).toContain("AND session_id = $2");
    expect(sessionLookup.text).toContain("ORDER BY created_at DESC, conversation_id DESC");
    const advisoryLock = db.query.mock.calls.find(
      ([config]) => config.text.includes("pg_advisory_xact_lock"),
    )?.[0];
    expect(advisoryLock).toMatchObject({
      values: [
        derivePostgreSqlAdvisoryLockName(
          projectId,
          "conversation",
          "session-a",
        ),
      ],
    });
    expect(advisoryLock?.text).toContain("$1::pg_catalog.text");
    const paginated = db.query.mock.calls.find(
      ([config]) => config.text.includes("LIMIT $4"),
    )?.[0];
    expect(paginated).toMatchObject({ values: [projectId, 41, 0, 1] });
  });

  it("creates a missing get-or-create segment after taking the advisory lock", async () => {
    const order: string[] = [];
    const db = executor((config) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        order.push("isolation");
        return result([]);
      }
      if (config.text.includes("pg_advisory_xact_lock")) {
        order.push("lock");
        return result([{ pg_advisory_xact_lock: null }]);
      }
      if (config.text.includes("session_id_sha256")) {
        order.push("lookup");
        return result([]);
      }
      if (config.text.includes("INSERT INTO lcm.conversations")) {
        order.push("insert");
        return result([{ ...conversationRow, session_id: "new-session", title: null }]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.getOrCreateConversation("new-session")).resolves.toMatchObject({
      sessionId: "new-session",
      title: null,
    });
    expect(order).toEqual(["isolation", "lock", "lookup", "insert"]);
    expect(db.query.mock.calls[0][0]).toEqual({
      text: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    });
    expect(db.query.mock.calls[1][0]).toMatchObject({
      values: [
        derivePostgreSqlAdvisoryLockName(
          projectId,
          "conversation",
          "new-session",
        ),
      ],
    });
  });

  it("fails closed before locking when the isolation fence cannot be established", async () => {
    const db = executor((config) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        throw Object.assign(new Error("isolation unavailable"), { code: "0A000" });
      }
      throw new Error(`unexpected SQL after isolation failure: ${config.text}`);
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.getOrCreateConversation("session-a"))
      .rejects.toMatchObject({ code: "0A000" });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledOnce();
    expect(db.query.mock.calls[0][0]).toEqual({
      text: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    });
  });

  it("establishes append isolation before its row lock and snapshot reads", async () => {
    const order: string[] = [];
    const db = executor((config) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        order.push("isolation");
        return result([]);
      }
      if (config.text.includes("FOR UPDATE")) {
        order.push("lock");
        return result([{ conversation_id: "41" }]);
      }
      if (config.text.includes("MAX(seq) AS max_seq")) {
        order.push("maximum");
        return result([{ max_seq: null }]);
      }
      if (config.text.includes("INSERT INTO lcm.messages")) {
        order.push("insert");
        return result([messageRow]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.appendMessages(41, [{
      role: "user",
      content: "append",
      tokenCount: 1,
    }])).resolves.toMatchObject([{ seq: 0 }]);
    expect(order).toEqual(["isolation", "lock", "maximum", "insert"]);
    expect(db.query.mock.calls[0][0]).toEqual({
      text: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    });
    expect(db.query.mock.calls[0][0]).not.toHaveProperty("values");
    expect(db.query.mock.calls[0][1]).toEqual({
      domain: "conversations",
      operation: "appendMessages",
      projectId,
    });
  });

  it("fails append before locking when its isolation fence cannot be established", async () => {
    const db = executor((config) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
        throw Object.assign(new Error("isolation unavailable"), { code: "0A000" });
      }
      throw new Error(`unexpected SQL after isolation failure: ${config.text}`);
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.appendMessages(41, [{
      role: "user",
      content: "append",
      tokenCount: 1,
    }])).rejects.toMatchObject({ code: "0A000" });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledOnce();
    expect(db.query.mock.calls[0][0]).toEqual({
      text: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    });
  });

  it("maps missing rows and false existence without exposing a cause", async () => {
    const db = executor(() => result([]));
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.getConversation(1)).resolves.toBeNull();
    await expect(repository.getConversationBySessionId("missing")).resolves.toBeNull();
    await expect(repository.getLastMessage(1)).resolves.toBeNull();
    await expect(repository.hasMessage(1, "user", "missing")).resolves.toBe(false);
    await expect(repository.getMessageById(1)).resolves.toBeNull();
    await expect(repository.getMessageParts(1)).resolves.toEqual([]);
    await expect(repository.getMessageCount(1)).resolves.toBe(0);
    await expect(repository.getMessageCountBySessionId("missing")).resolves.toBe(0);
    await expect(repository.getMaxSeq(1)).resolves.toBe(0);

    const conversationError = await repository.createConversation({
      sessionId: "contains postgresql://user:secret@example.test/db",
    }).catch((error: unknown) => error);
    expect(conversationError).toBeInstanceOf(PostgreSqlConversationDataError);
    expect(conversationError).toMatchObject({ field: "conversation" });
    expect(conversationError).not.toHaveProperty("cause");
    expect(JSON.stringify(conversationError)).not.toContain("secret");

    const messageError = await repository.createMessage({
      conversationId: 1,
      seq: 0,
      role: "user",
      content: "/private/secret/path",
      tokenCount: 1,
    }).catch((error: unknown) => error);
    expect(messageError).toBeInstanceOf(PostgreSqlConversationDataError);
    expect(messageError).toMatchObject({ field: "message" });
    expect(messageError).not.toHaveProperty("cause");
    expect(JSON.stringify(messageError)).not.toContain("/private/secret/path");
  });

  it("returns immediately for empty bulk, append, parts, and delete inputs", async () => {
    const db = executor(() => {
      throw new Error("empty operations must not query");
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.createMessagesBulk([])).resolves.toEqual([]);
    await expect(repository.appendMessages(1, [])).resolves.toEqual([]);
    await expect(repository.createMessageParts(1, [])).resolves.toBeUndefined();
    await expect(repository.deleteMessages([])).resolves.toBe(0);
    expect(db.query).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("omits LIMIT for negative sentinels and binds zero or positive limits", async () => {
    const db = executor(() => result([messageRow]));
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await repository.getMessages(41, { afterSeq: 0, limit: -1 });
    await repository.getMessages(41, { afterSeq: 0, limit: 0 });
    await repository.getMessages(41, { afterSeq: 0, limit: 2 });

    const [unlimited, zero, positive] = db.query.mock.calls.map(([config]) => config);
    expect(unlimited?.text).not.toContain("LIMIT");
    expect(unlimited?.values).toEqual([projectId, 41, 0]);
    expect(zero?.text).toContain("LIMIT $4");
    expect(zero?.values).toEqual([projectId, 41, 0, 0]);
    expect(positive?.text).toContain("LIMIT $4");
    expect(positive?.values).toEqual([projectId, 41, 0, 2]);
  });

  it("keeps message bulk and append inputs within a constant bind count", async () => {
    const db = executor((config) => {
      if (config.text.includes("FOR UPDATE")) return result([{ conversation_id: "41" }]);
      if (config.text.includes("MAX(seq) AS max_seq")) return result([{ max_seq: null }]);
      return result([]);
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);
    const inputCount = 10_924;
    const bulkInputs = Array.from({ length: inputCount }, (_, index) => ({
      conversationId: 41,
      seq: index,
      role: "user",
      content: index === inputCount - 1 ? " opaque \u2603 " : `message-${index}`,
      tokenCount: index,
    }));

    await expect(repository.createMessagesBulk(bulkInputs)).resolves.toEqual([]);
    await expect(repository.appendMessages(
      41,
      bulkInputs.map(({ role, content, tokenCount }) => ({ role, content, tokenCount })),
    )).resolves.toEqual([]);

    const payloadQueries = db.query.mock.calls
      .map(([config]) => config)
      .filter((config) => config.text.includes("jsonb_array_elements"));
    expect(payloadQueries).toHaveLength(2);
    for (const config of payloadQueries) {
      expect(config.values).toHaveLength(2);
      expect(config.text).toContain("$2::pg_catalog.jsonb");
      expect(config.text).not.toMatch(/\$(?:[3-9]|\d{2,})/u);
      expect(config.text).toContain("WITH ORDINALITY");
      expect(config.text).toContain("ORDER BY input.input_ordinal");
    }

    const bulkPayload = JSON.parse(payloadQueries[0]?.values?.[1] as string) as Array<
      Record<string, unknown>
    >;
    expect(bulkPayload).toHaveLength(inputCount);
    expect(bulkPayload[0]).toEqual({
      conversation_id: 41,
      seq: 0,
      role: "user",
      content: "message-0",
      token_count: 0,
    });
    expect(bulkPayload.at(-1)).toEqual({
      conversation_id: 41,
      seq: inputCount - 1,
      role: "user",
      content: " opaque \u2603 ",
      token_count: inputCount - 1,
    });

    const appendPayload = JSON.parse(payloadQueries[1]?.values?.[1] as string) as Array<
      Record<string, unknown>
    >;
    expect(appendPayload).toHaveLength(inputCount);
    expect(appendPayload[0]).toMatchObject({ seq: 0 });
    expect(appendPayload.at(-1)).toMatchObject({
      seq: inputCount - 1,
      content: " opaque \u2603 ",
    });
  });

  it("keeps large ordered message-part inputs within a constant bind count", async () => {
    const db = executor(() => result([]));
    const repository = new PostgreSqlConversationRepository(db, projectId);
    const inputCount = 7_283;
    const parts = Array.from({ length: inputCount }, (_, index) => ({
      sessionId: `session-${index}`,
      partType: index === inputCount - 1 ? "opaque-final" : "text",
      ordinal: index === inputCount - 1 ? Number.MAX_SAFE_INTEGER : index,
      textContent: index === inputCount - 1 ? " opaque \u2603 " : undefined,
      metadata: index === inputCount - 1 ? " { not-json } " : undefined,
    }));

    await expect(repository.createMessageParts(51, parts)).resolves.toBeUndefined();

    const config = db.query.mock.calls[0]?.[0];
    expect(config.values).toHaveLength(3);
    expect(config.text).toContain("$3::pg_catalog.jsonb");
    expect(config.text).toContain(
      "(element.payload ->> 'ordinal')::pg_catalog.int8 AS ordinal",
    );
    expect(config.text).not.toMatch(/\$(?:[4-9]|\d{2,})/u);
    expect(config.text).toContain("WITH ORDINALITY");
    expect(config.text).toContain("ORDER BY input.input_ordinal");
    const payload = JSON.parse(config.values?.[2] as string) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(inputCount);
    expect(payload[0]).toEqual({
      session_id: "session-0",
      part_type: "text",
      ordinal: 0,
      text_content: null,
      tool_call_id: null,
      tool_name: null,
      tool_input: null,
      tool_output: null,
      metadata: null,
    });
    expect(payload.at(-1)).toEqual({
      session_id: `session-${inputCount - 1}`,
      part_type: "opaque-final",
      ordinal: Number.MAX_SAFE_INTEGER,
      text_content: " opaque \u2603 ",
      tool_call_id: null,
      tool_name: null,
      tool_input: null,
      tool_output: null,
      metadata: " { not-json } ",
    });
  });

  it("keeps deletion within a constant bind count above PostgreSQL's limit", async () => {
    const db = executor(() => result([{ count: "0" }]));
    const repository = new PostgreSqlConversationRepository(db, projectId);
    const messageIds = Array.from({ length: 65_536 }, (_, index) => index + 1);

    await expect(repository.deleteMessages(messageIds)).resolves.toBe(0);

    const config = db.query.mock.calls[0]?.[0];
    expect(config.values).toHaveLength(2);
    expect(config.values?.[1]).toEqual(messageIds);
    expect(config.text).toContain("$2::pg_catalog.int8[]");
    expect(config.text).toContain("pg_catalog.unnest");
    expect(config.text).toContain("WITH ORDINALITY");
    expect(config.text).toMatch(
      /\/\* Data dependency: delete context rows before their messages\. \*\/\s+SELECT COUNT\(\*\) FROM deleted_context/u,
    );
    expect(config.text).not.toMatch(/\$(?:[3-9]|\d{2,})/u);
    expect((config.values?.[1] as number[])[0]).toBe(1);
    expect((config.values?.[1] as number[]).at(-1)).toBe(65_536);
  });

  it.each([
    [
      "createConversation",
      conversationRow,
      (repository: PostgreSqlConversationRepository) =>
        repository.createConversation({ sessionId: "unsafe-generated-conversation" }),
      "conversation_id",
    ],
    [
      "createMessage",
      messageRow,
      (repository: PostgreSqlConversationRepository) => repository.createMessage({
        conversationId: 41,
        seq: 0,
        role: "user",
        content: "unsafe-generated-message",
        tokenCount: 1,
      }),
      "message_id",
    ],
    [
      "createMessagesBulk",
      messageRow,
      (repository: PostgreSqlConversationRepository) => repository.createMessagesBulk([{
        conversationId: 41,
        seq: 0,
        role: "user",
        content: "unsafe-generated-bulk",
        tokenCount: 1,
      }]),
      "message_id",
    ],
    [
      "deleteMessages",
      { count: "0" },
      (repository: PostgreSqlConversationRepository) =>
        repository.deleteMessages([51]),
      "count",
    ],
  ])("rolls back %s when generated identity mapping is unsafe", async (
    _operation,
    safeRow,
    invoke,
    field,
  ) => {
    const unsafeRow = {
      ...safeRow,
      [field]: String(Number.MAX_SAFE_INTEGER + 1),
    };
    let residualWrites = 0;
    const query = vi.fn(() => {
      residualWrites += 1;
      return result([unsafeRow]);
    });
    const db = { query } as unknown as PostgreSqlConversationExecutor & {
      query: ReturnType<typeof vi.fn>;
      transaction: ReturnType<typeof vi.fn>;
    };
    db.transaction = vi.fn(async (
      callback: Parameters<PostgreSqlConversationExecutor["transaction"]>[0],
    ) => {
      const before = residualWrites;
      try {
        return await callback(db);
      } catch (error) {
        residualWrites = before;
        throw error;
      }
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(invoke(repository)).rejects.toMatchObject({ field });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(residualWrites).toBe(0);
  });

  it("maps direct writes inside an explicitly marked transaction scope", async () => {
    const query = vi.fn((config: QueryConfig<unknown[]>) =>
      config.text.includes("INSERT INTO lcm.messages")
        ? result([messageRow])
        : result([]));
    const scoped = scopedExecutor(query);
    const repository = new PostgreSqlConversationRepository(scoped, projectId);

    await expect(repository.createMessagesBulk([{
      conversationId: 41,
      seq: 0,
      role: "user",
      content: "already transactional",
      tokenCount: 1,
    }])).resolves.toMatchObject([{ messageId: 51 }]);
    expect(query.mock.calls.map(([config]) => config.text)).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("INSERT INTO lcm.messages"),
      "RELEASE SAVEPOINT lcm_conversation_repository_1",
    ]);
  });

  it("serializes concurrent scoped writes across repositories sharing one executor", async () => {
    const statements: string[] = [];
    let unblockFirstInsert!: () => void;
    let reportFirstInsert!: () => void;
    const firstInsertBlocked = new Promise<void>((resolve) => {
      reportFirstInsert = resolve;
    });
    const firstInsertGate = new Promise<void>((resolve) => {
      unblockFirstInsert = resolve;
    });
    let insertCount = 0;
    const query = vi.fn(async (config: QueryConfig<unknown[]>) => {
      statements.push(config.text);
      if (!config.text.includes("INSERT INTO lcm.messages")) return result([]);
      insertCount += 1;
      if (insertCount === 1) {
        reportFirstInsert();
        await firstInsertGate;
      }
      return result([{
        ...messageRow,
        message_id: String(50 + insertCount),
        seq: insertCount - 1,
      }]);
    });
    const scoped = scopedExecutor(query);
    const firstRepository = new PostgreSqlConversationRepository(scoped, projectId);
    const secondRepository = new PostgreSqlConversationRepository(scoped, projectId);

    const first = firstRepository.createMessage({
      conversationId: 41,
      seq: 0,
      role: "user",
      content: "first",
      tokenCount: 1,
    });
    const second = secondRepository.createMessage({
      conversationId: 41,
      seq: 1,
      role: "assistant",
      content: "second",
      tokenCount: 1,
    });
    await firstInsertBlocked;
    expect(statements).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("INSERT INTO lcm.messages"),
    ]);

    unblockFirstInsert();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { messageId: 51, seq: 0 },
      { messageId: 52, seq: 1 },
    ]);
    expect(statements).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("INSERT INTO lcm.messages"),
      "RELEASE SAVEPOINT lcm_conversation_repository_1",
      "SAVEPOINT lcm_conversation_repository_2",
      expect.stringContaining("INSERT INTO lcm.messages"),
      "RELEASE SAVEPOINT lcm_conversation_repository_2",
    ]);
  });

  it("reuses an active scope for contention operations without retry or isolation setup", async () => {
    const query = vi.fn((config: QueryConfig<unknown[]>) => {
      if (config.text.includes("transaction_isolation")) {
        return result([{ transaction_isolation: "read committed" }]);
      }
      if (config.text.includes("session_id_sha256")) return result([conversationRow]);
      if (config.text.includes("FOR UPDATE")) {
        return result([{ conversation_id: conversationRow.conversation_id }]);
      }
      if (config.text.includes("MAX(seq) AS max_seq")) return result([{ max_seq: null }]);
      if (config.text.includes("INSERT INTO lcm.messages")) return result([messageRow]);
      return result([]);
    });
    const scoped = scopedExecutor(query);
    const repository = new PostgreSqlConversationRepository(scoped, projectId);

    await expect(repository.getOrCreateConversation("session-a"))
      .resolves.toMatchObject({ conversationId: 41 });
    await expect(repository.appendMessages(41, [{
      role: "user",
      content: "scoped append",
      tokenCount: 1,
    }])).resolves.toMatchObject([{ seq: 0 }]);

    const statements = query.mock.calls.map(([config]) => config.text);
    expect(statements).not.toContain("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect(statements).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("transaction_isolation"),
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("session_id_sha256"),
      "RELEASE SAVEPOINT lcm_conversation_repository_1",
      "SAVEPOINT lcm_conversation_repository_2",
      expect.stringContaining("transaction_isolation"),
      expect.stringContaining("FOR UPDATE"),
      expect.stringContaining("MAX(seq) AS max_seq"),
      expect.stringContaining("INSERT INTO lcm.messages"),
      "RELEASE SAVEPOINT lcm_conversation_repository_2",
    ]);
  });

  it("fails scoped contention operations closed before locking under stronger isolation", async () => {
    const query = vi.fn((config: QueryConfig<unknown[]>) =>
      config.text.includes("transaction_isolation")
        ? result([{ transaction_isolation: "repeatable read" }])
        : result([]));
    const scoped = scopedExecutor(query);
    const repository = new PostgreSqlConversationRepository(scoped, projectId);

    for (const [operation, invoke] of [
      [
        "getOrCreateConversation",
        () => repository.getOrCreateConversation("scoped-isolation"),
      ],
      [
        "appendMessages",
        () => repository.appendMessages(41, [{
          role: "user",
          content: "scoped isolation",
          tokenCount: 1,
        }]),
      ],
    ] as const) {
      const error = await invoke().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PostgreSqlConversationDataError);
      expect(error).toMatchObject({
        backend: "postgresql",
        domain: "conversations",
        field: "transaction_isolation",
        operation,
        projectId,
      });
      expect(error).not.toHaveProperty("cause");
    }
    expect(query.mock.calls.map(([config]) => config.text)).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("transaction_isolation"),
      "ROLLBACK TO SAVEPOINT lcm_conversation_repository_1",
      "RELEASE SAVEPOINT lcm_conversation_repository_1",
      "SAVEPOINT lcm_conversation_repository_2",
      expect.stringContaining("transaction_isolation"),
      "ROLLBACK TO SAVEPOINT lcm_conversation_repository_2",
      "RELEASE SAVEPOINT lcm_conversation_repository_2",
    ]);
    expect(query.mock.calls.some(
      ([config]) =>
        config.text.includes("pg_advisory_xact_lock")
        || config.text.includes("FOR UPDATE"),
    )).toBe(false);
  });

  it.each([
    ["missing", []],
    ["malformed", [{ transaction_isolation: "READ COMMITTED" }]],
  ])("fails scoped contention closed for %s isolation state", async (
    _case,
    rows,
  ) => {
    const query = vi.fn((config: QueryConfig<unknown[]>) =>
      config.text.includes("transaction_isolation")
        ? result(rows)
        : result([]));
    const repository = new PostgreSqlConversationRepository(
      scopedExecutor(query),
      projectId,
    );

    const error = await repository.getOrCreateConversation("isolation-state")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgreSqlConversationDataError);
    expect(error).toMatchObject({
      field: "transaction_isolation",
      operation: "getOrCreateConversation",
    });
    expect(error).not.toHaveProperty("cause");
    expect(query.mock.calls.map(([config]) => config.text)).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("transaction_isolation"),
      "ROLLBACK TO SAVEPOINT lcm_conversation_repository_1",
      "RELEASE SAVEPOINT lcm_conversation_repository_1",
    ]);
    expect(query.mock.calls.some(
      ([config]) => config.text.includes("pg_advisory_xact_lock"),
    )).toBe(false);
  });

  it.each([
    ["unmarked", {}],
    ["marked without runtime savepoint capability", { transactionScope: "active" }],
  ])("rejects a %s query-only executor before issuing SQL", async (
    _case,
    marker,
  ) => {
    const query = vi.fn(() => result([messageRow]));
    const repository = new PostgreSqlConversationRepository(
      { ...marker, query } as unknown as PostgreSqlConversationScopedExecutor,
      projectId,
    );

    await expect(repository.createMessage({
      conversationId: 41,
      seq: 0,
      role: "user",
      content: "not proven transactional",
      tokenCount: 1,
    })).rejects.toMatchObject({
      code: "STORAGE_TRANSACTION_SCOPE",
      operation: "createMessage",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("rolls scoped mapping failures back to a serialized operation savepoint", async () => {
    const unsafeMessage = {
      ...messageRow,
      message_id: String(Number.MAX_SAFE_INTEGER + 1),
    };
    let insert = 0;
    const query = vi.fn((config: QueryConfig<unknown[]>) => {
      if (!config.text.includes("INSERT INTO lcm.messages")) return result([]);
      insert += 1;
      return result([insert === 1 ? unsafeMessage : messageRow]);
    });
    const scoped = scopedExecutor(query);
    const repository = new PostgreSqlConversationRepository(scoped, projectId);

    await expect(repository.createMessage({
      conversationId: 41,
      seq: 0,
      role: "user",
      content: "unsafe",
      tokenCount: 1,
    })).rejects.toMatchObject({ field: "message_id" });
    await expect(repository.createMessage({
      conversationId: 41,
      seq: 1,
      role: "assistant",
      content: "safe",
      tokenCount: 1,
    })).resolves.toMatchObject({ messageId: 51 });

    expect(query.mock.calls.map(([config]) => config.text)).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("INSERT INTO lcm.messages"),
      "ROLLBACK TO SAVEPOINT lcm_conversation_repository_1",
      "RELEASE SAVEPOINT lcm_conversation_repository_1",
      "SAVEPOINT lcm_conversation_repository_2",
      expect.stringContaining("INSERT INTO lcm.messages"),
      "RELEASE SAVEPOINT lcm_conversation_repository_2",
    ]);
  });

  it("preserves the scoped operation error when savepoint recovery itself fails", async () => {
    const unsafeMessage = {
      ...messageRow,
      message_id: String(Number.MAX_SAFE_INTEGER + 1),
    };
    const query = vi.fn((config: QueryConfig<unknown[]>) => {
      if (config.text.startsWith("ROLLBACK TO SAVEPOINT")) {
        throw new Error("rollback transport failure");
      }
      return config.text.includes("INSERT INTO lcm.messages")
        ? result([unsafeMessage])
        : result([]);
    });
    const repository = new PostgreSqlConversationRepository(
      scopedExecutor(query),
      projectId,
    );

    await expect(repository.createMessage({
      conversationId: 41,
      seq: 0,
      role: "user",
      content: "unsafe",
      tokenCount: 1,
    })).rejects.toMatchObject({ field: "message_id" });
    expect(query.mock.calls.map(([config]) => config.text)).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("INSERT INTO lcm.messages"),
      "ROLLBACK TO SAVEPOINT lcm_conversation_repository_1",
    ]);
  });

  it("serializes bootstrap and part writes behind a failing scoped mapped write", async () => {
    const unsafeMessage = {
      ...messageRow,
      message_id: String(Number.MAX_SAFE_INTEGER + 1),
    };
    const statements: string[] = [];
    let unblockMessageInsert!: () => void;
    let reportMessageInsert!: () => void;
    const messageInsertBlocked = new Promise<void>((resolve) => {
      reportMessageInsert = resolve;
    });
    const messageInsertGate = new Promise<void>((resolve) => {
      unblockMessageInsert = resolve;
    });
    let bootstrapped = false;
    let partCount = 0;
    let savepointState = { bootstrapped, partCount };
    const query = vi.fn(async (config: QueryConfig<unknown[]>) => {
      statements.push(config.text);
      if (config.text.startsWith("SAVEPOINT")) {
        savepointState = { bootstrapped, partCount };
      } else if (config.text.startsWith("ROLLBACK TO SAVEPOINT")) {
        ({ bootstrapped, partCount } = savepointState);
      } else if (config.text.includes("INSERT INTO lcm.messages")) {
        reportMessageInsert();
        await messageInsertGate;
        return result([unsafeMessage]);
      } else if (config.text.includes("UPDATE lcm.conversations")) {
        bootstrapped = true;
      } else if (config.text.includes("INSERT INTO lcm.message_parts")) {
        partCount += 1;
      }
      return result([]);
    });
    const scoped = scopedExecutor(query);
    const unsafeRepository = new PostgreSqlConversationRepository(scoped, projectId);
    const bootstrapRepository = new PostgreSqlConversationRepository(scoped, projectId);
    const partsRepository = new PostgreSqlConversationRepository(scoped, projectId);

    const unsafe = unsafeRepository.createMessage({
      conversationId: 41,
      seq: 0,
      role: "user",
      content: "unsafe",
      tokenCount: 1,
    });
    await messageInsertBlocked;
    const bootstrap = bootstrapRepository.markConversationBootstrapped(41);
    const parts = partsRepository.createMessageParts(51, [{
      sessionId: "serialized-direct-writes",
      partType: "text",
      ordinal: 0,
    }]);
    await Promise.resolve();
    expect(statements).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("INSERT INTO lcm.messages"),
    ]);

    unblockMessageInsert();
    await expect(unsafe).rejects.toMatchObject({ field: "message_id" });
    await expect(Promise.all([bootstrap, parts])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(statements).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("INSERT INTO lcm.messages"),
      "ROLLBACK TO SAVEPOINT lcm_conversation_repository_1",
      "RELEASE SAVEPOINT lcm_conversation_repository_1",
      "SAVEPOINT lcm_conversation_repository_2",
      expect.stringContaining("UPDATE lcm.conversations"),
      "RELEASE SAVEPOINT lcm_conversation_repository_2",
      "SAVEPOINT lcm_conversation_repository_3",
      expect.stringContaining("INSERT INTO lcm.message_parts"),
      "RELEASE SAVEPOINT lcm_conversation_repository_3",
    ]);
    expect({ bootstrapped, partCount }).toEqual({
      bootstrapped: true,
      partCount: 1,
    });
  });

  it("serializes scoped reads behind rollback of a failing mapped write", async () => {
    const unsafeMessage = {
      ...messageRow,
      message_id: String(Number.MAX_SAFE_INTEGER + 1),
    };
    const statements: string[] = [];
    let unblockMessageInsert!: () => void;
    let reportMessageInsert!: () => void;
    const messageInsertBlocked = new Promise<void>((resolve) => {
      reportMessageInsert = resolve;
    });
    const messageInsertGate = new Promise<void>((resolve) => {
      unblockMessageInsert = resolve;
    });
    const query = vi.fn(async (config: QueryConfig<unknown[]>) => {
      statements.push(config.text);
      if (config.text.includes("INSERT INTO lcm.messages")) {
        reportMessageInsert();
        await messageInsertGate;
        return result([unsafeMessage]);
      }
      if (
        config.text.includes("SELECT")
        && config.text.includes("FROM lcm.messages")
      ) {
        return result([]);
      }
      return result([]);
    });
    const scoped = scopedExecutor(query);
    const writer = new PostgreSqlConversationRepository(scoped, projectId);
    const reader = new PostgreSqlConversationRepository(scoped, projectId);

    const unsafe = writer.createMessage({
      conversationId: 41,
      seq: 0,
      role: "user",
      content: "unsafe",
      tokenCount: 1,
    });
    await messageInsertBlocked;
    const read = reader.getMessageById(51);
    await Promise.resolve();
    expect(statements).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("INSERT INTO lcm.messages"),
    ]);

    unblockMessageInsert();
    await expect(unsafe).rejects.toMatchObject({ field: "message_id" });
    await expect(read).resolves.toBeNull();
    expect(statements).toEqual([
      "SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("INSERT INTO lcm.messages"),
      "ROLLBACK TO SAVEPOINT lcm_conversation_repository_1",
      "RELEASE SAVEPOINT lcm_conversation_repository_1",
      expect.stringContaining("SELECT"),
    ]);
  });

  it("maps every PostgreSQL bigint representation only when safely integral", async () => {
    const safeRow = {
      ...messageRow,
      message_id: "53",
      conversation_id: 42n,
      seq: "3",
      token_count: 4,
    };
    const db = executor((config) => {
      if (config.text.includes("COUNT(*)")) return result([{ count: 5n }]);
      if (config.text.includes("COALESCE(MAX")) return result([{ max_seq: "6" }]);
      if (config.text.includes("message_parts")) {
        return result([{ ...partRow, message_id: 53n, ordinal: "7" }]);
      }
      if (config.text.includes("lcm.messages")) return result([safeRow]);
      return result([{
        ...conversationRow,
        conversation_id: 42n,
        bootstrapped_at: "2026-01-01T12:00:00.000Z",
      }]);
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.getConversation(42)).resolves.toMatchObject({
      conversationId: 42,
      bootstrappedAt: new Date("2026-01-01T12:00:00.000Z"),
    });
    await expect(repository.getMessageById(53)).resolves.toMatchObject({
      messageId: 53,
      conversationId: 42,
      seq: 3,
      tokenCount: 4,
    });
    await expect(repository.getMessageParts(53)).resolves.toMatchObject([{
      messageId: 53,
      ordinal: 7,
    }]);
    await expect(repository.getMessageCount(42)).resolves.toBe(5);
    await expect(repository.getMaxSeq(42)).resolves.toBe(6);
  });

  it.each([
    ["maximum string", String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ["minimum string", String(Number.MIN_SAFE_INTEGER), Number.MIN_SAFE_INTEGER],
    ["maximum bigint", BigInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ["minimum bigint", BigInt(Number.MIN_SAFE_INTEGER), Number.MIN_SAFE_INTEGER],
    ["maximum number", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ["minimum number", Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
    ["leading-zero string", "00000042", 42],
    ["negative-zero string", "-0", 0],
  ])("maps an exact safe bigint %s", async (_case, value, expected) => {
    const repository = new PostgreSqlConversationRepository(
      executor(() => result([{ count: value }])),
      projectId,
    );

    await expect(repository.getMessageCount(1)).resolves.toBe(expected);
  });

  it.each([
    ["maximum plus one string", "9007199254740992"],
    ["minimum minus one string", "-9007199254740992"],
    ["maximum plus one bigint", 9007199254740992n],
    ["minimum minus one bigint", -9007199254740992n],
    ["very large positive string", "9999999999999999999999999999999999999999"],
    ["very large negative string", "-9999999999999999999999999999999999999999"],
    ["positive exponent", "1e3"],
    ["negative exponent", "-1e3"],
    ["decimal", "1.0"],
    ["leading plus", "+1"],
    ["empty string", ""],
    ["whitespace", " 1 "],
    ["unsafe positive number", Number.MAX_SAFE_INTEGER + 1],
    ["unsafe negative number", Number.MIN_SAFE_INTEGER - 1],
    ["fractional number", 1.5],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("rejects an inexact or malformed bigint %s", async (_case, value) => {
    const repository = new PostgreSqlConversationRepository(
      executor(() => result([{ count: value }])),
      projectId,
    );

    await expect(repository.getMessageCount(1)).rejects.toMatchObject({
      field: "count",
      operation: "getMessageCount",
    });
  });

  it.each([
    ["conversation row", "conversation_id", async (repository: PostgreSqlConversationRepository) =>
      repository.getConversation(1), { ...conversationRow, conversation_id: "9007199254740992" }],
    ["message id", "message_id", async (repository: PostgreSqlConversationRepository) =>
      repository.getMessageById(1), { ...messageRow, message_id: 9007199254740992n }],
    ["message conversation", "conversation_id", async (repository: PostgreSqlConversationRepository) =>
      repository.getMessageById(1), { ...messageRow, conversation_id: 1.5 }],
    ["message seq", "seq", async (repository: PostgreSqlConversationRepository) =>
      repository.getMessageById(1), { ...messageRow, seq: "not-an-integer" }],
    ["message tokens", "token_count", async (repository: PostgreSqlConversationRepository) =>
      repository.getMessageById(1), { ...messageRow, token_count: Number.POSITIVE_INFINITY }],
    ["message part id", "message_id", async (repository: PostgreSqlConversationRepository) =>
      repository.getMessageParts(1), { ...partRow, message_id: "9007199254740992" }],
    ["message part ordinal", "ordinal", async (repository: PostgreSqlConversationRepository) =>
      repository.getMessageParts(1), { ...partRow, ordinal: "9007199254740992" }],
    ["count", "count", async (repository: PostgreSqlConversationRepository) =>
      repository.getMessageCount(1), { count: "9007199254740992" }],
    ["maximum", "max_seq", async (repository: PostgreSqlConversationRepository) =>
      repository.getMaxSeq(1), { max_seq: "9007199254740992" }],
  ])("rejects unsafe %s data as field %s", async (
    _case,
    field,
    invoke,
    row,
  ) => {
    const repository = new PostgreSqlConversationRepository(
      executor(() => result([row])),
      projectId,
    );

    const error = await invoke(repository).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgreSqlConversationDataError);
    expect(error).toMatchObject({
      field,
      backend: "postgresql",
      projectId,
      domain: "conversations",
    });
    expect(error).not.toHaveProperty("cause");
    expect((error as PostgreSqlConversationDataError).toJSON()).toMatchObject({ field });
  });

  it.each([
    ["getConversation", () => repositoryForInputs().getConversation(1.5), "conversation_id"],
    ["markConversationBootstrapped", () =>
      repositoryForInputs().markConversationBootstrapped(Number.POSITIVE_INFINITY), "conversation_id"],
    ["createMessage conversation", () => repositoryForInputs().createMessage({
      conversationId: Number.MAX_SAFE_INTEGER + 1,
      seq: 0,
      role: "user",
      content: "x",
      tokenCount: 1,
    }), "conversation_id"],
    ["createMessage seq", () => repositoryForInputs().createMessage({
      conversationId: 1,
      seq: 1.5,
      role: "user",
      content: "x",
      tokenCount: 1,
    }), "seq"],
    ["createMessage negative seq", () => repositoryForInputs().createMessage({
      conversationId: 1,
      seq: -1,
      role: "user",
      content: "x",
      tokenCount: 1,
    }), "seq"],
    ["createMessage tokens", () => repositoryForInputs().createMessage({
      conversationId: 1,
      seq: 0,
      role: "user",
      content: "x",
      tokenCount: Number.NaN,
    }), "token_count"],
    ["createMessage negative tokens", () => repositoryForInputs().createMessage({
      conversationId: 1,
      seq: 0,
      role: "user",
      content: "x",
      tokenCount: -1,
    }), "token_count"],
    ["getMessages afterSeq", () => repositoryForInputs().getMessages(1, { afterSeq: 0.5 }), "after_seq"],
    ["getMessages limit", () => repositoryForInputs().getMessages(1, { limit: 1.5 }), "limit"],
    ["createMessageParts ordinal", () => repositoryForInputs().createMessageParts(1, [{
      sessionId: "a",
      partType: "text",
      ordinal: 0.5,
    }]), "ordinal"],
    ["createMessageParts negative ordinal", () => repositoryForInputs().createMessageParts(1, [{
      sessionId: "a",
      partType: "text",
      ordinal: -1,
    }]), "ordinal"],
    ["appendMessages negative tokens", () => repositoryForInputs().appendMessages(1, [{
      role: "user",
      content: "negative tokens",
      tokenCount: -1,
    }]), "token_count"],
    ["deleteMessages", () => repositoryForInputs().deleteMessages([Number.NaN]), "message_id"],
  ])("rejects unsafe numeric input for %s", async (_case, invoke, field) => {
    const error = await invoke().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgreSqlConversationDataError);
    expect(error).toMatchObject({ field });
  });

  it("validates every explicit message batch before opening a transaction", async () => {
    const db = executor(() => {
      throw new Error("invalid batch must not query");
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.createMessagesBulk([
      {
        conversationId: 1,
        seq: 0,
        role: "user",
        content: "valid first member",
        tokenCount: 1,
      },
      {
        conversationId: 1,
        seq: -1,
        role: "assistant",
        content: "invalid second member",
        tokenCount: 1,
      },
    ])).rejects.toMatchObject({ field: "seq" });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    ["createMessage", (repository: PostgreSqlConversationRepository) =>
      repository.createMessage({
        conversationId: 1,
        seq: 0,
        role: "user",
        content: "before\0after",
        tokenCount: 1,
      })],
    ["createMessagesBulk", (repository: PostgreSqlConversationRepository) =>
      repository.createMessagesBulk([
        {
          conversationId: 1,
          seq: 0,
          role: "user",
          content: "valid",
          tokenCount: 1,
        },
        {
          conversationId: 1,
          seq: 1,
          role: "assistant",
          content: "before\0after",
          tokenCount: 1,
        },
      ])],
    ["appendMessages", (repository: PostgreSqlConversationRepository) =>
      repository.appendMessages(1, [{
        role: "user",
        content: "before\0after",
        tokenCount: 1,
      }])],
    ["hasMessage", (repository: PostgreSqlConversationRepository) =>
      repository.hasMessage(1, "user", "before\0after")],
    ["countMessagesByIdentity", (repository: PostgreSqlConversationRepository) =>
      repository.countMessagesByIdentity(1, "user", "before\0after")],
  ])("rejects NUL message content for %s before transaction or query", async (
    operation,
    invoke,
  ) => {
    const db = executor(() => {
      throw new Error("NUL content must not query");
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    const error = await invoke(repository).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgreSqlConversationDataError);
    expect(error).toMatchObject({
      field: "content",
      operation,
      projectId,
    });
    expect(JSON.stringify(error)).not.toContain("before");
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    [
      "createConversation session",
      "createConversation",
      "session_id",
      (repository: PostgreSqlConversationRepository) =>
        repository.createConversation({ sessionId: "before\0after" }),
    ],
    [
      "createConversation title",
      "createConversation",
      "title",
      (repository: PostgreSqlConversationRepository) =>
        repository.createConversation({
          sessionId: "valid",
          title: "before\0after",
        }),
    ],
    [
      "getConversationBySessionId",
      "getConversationBySessionId",
      "session_id",
      (repository: PostgreSqlConversationRepository) =>
        repository.getConversationBySessionId("before\0after"),
    ],
    [
      "getOrCreateConversation session",
      "getOrCreateConversation",
      "session_id",
      (repository: PostgreSqlConversationRepository) =>
        repository.getOrCreateConversation("before\0after"),
    ],
    [
      "getOrCreateConversation title",
      "getOrCreateConversation",
      "title",
      (repository: PostgreSqlConversationRepository) =>
        repository.getOrCreateConversation("valid", "before\0after"),
    ],
    [
      "getMessageCountBySessionId",
      "getMessageCountBySessionId",
      "session_id",
      (repository: PostgreSqlConversationRepository) =>
        repository.getMessageCountBySessionId("before\0after"),
    ],
  ])("rejects NUL conversation text for %s before transaction or query", async (
    _case,
    operation,
    field,
    invoke,
  ) => {
    const db = executor(() => {
      throw new Error("NUL conversation text must not query");
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    const error = await invoke(repository).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgreSqlConversationDataError);
    expect(error).toMatchObject({ field, operation, projectId });
    expect(JSON.stringify(error)).not.toContain("before");
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    ["session_id", { sessionId: "before\0after" }],
    ["text_content", { textContent: "before\0after" }],
    ["tool_call_id", { toolCallId: "before\0after" }],
    ["tool_name", { toolName: "before\0after" }],
    ["tool_input", { toolInput: "before\0after" }],
    ["tool_output", { toolOutput: "before\0after" }],
    ["metadata", { metadata: "before\0after" }],
  ])("rejects NUL message part %s before transaction or query", async (
    field,
    override,
  ) => {
    const db = executor(() => {
      throw new Error("NUL message part must not query");
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    const error = await repository.createMessageParts(1, [{
      sessionId: "valid",
      partType: "text",
      ordinal: 0,
      ...override,
    }]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgreSqlConversationDataError);
    expect(error).toMatchObject({
      field,
      operation: "createMessageParts",
      projectId,
    });
    expect(JSON.stringify(error)).not.toContain("before");
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects append sequence overflow before inserting", async () => {
    const db = executor((config) => {
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") return result([]);
      if (config.text.includes("FOR UPDATE")) return result([{ conversation_id: "1" }]);
      if (config.text.includes("MAX(seq)")) {
        return result([{ max_seq: String(Number.MAX_SAFE_INTEGER) }]);
      }
      throw new Error("append must stop before insert");
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.appendMessages(1, [
      { role: "user", content: "overflow", tokenCount: 1 },
      { role: "assistant", content: "also overflow", tokenCount: 1 },
    ])).rejects.toMatchObject({ field: "seq" });
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it("retries only serialization failures and deadlocks, at most three attempts", async () => {
    const success = executor(() => result([conversationRow]));
    success.transaction
      .mockRejectedValueOnce(Object.assign(new Error("serialization"), { code: "40001" }))
      .mockRejectedValueOnce(new PostgreSqlStorageOperationError(
        "STORAGE_OPERATION_FAILED",
        { domain: "conversations", operation: "getOrCreateConversation", projectId },
        "40P01",
        true,
      ));
    const repository = new PostgreSqlConversationRepository(success, projectId);
    await expect(repository.getOrCreateConversation("session-a")).resolves.toMatchObject({
      conversationId: 41,
    });
    expect(success.transaction).toHaveBeenCalledTimes(3);

    const exhausted = executor(() => result([]));
    exhausted.transaction.mockRejectedValue(
      Object.assign(new Error("serialization"), { code: "40001" }),
    );
    await expect(new PostgreSqlConversationRepository(exhausted, projectId)
      .getOrCreateConversation("session-a")).rejects.toMatchObject({ code: "40001" });
    expect(exhausted.transaction).toHaveBeenCalledTimes(3);
  });

  it("re-establishes READ COMMITTED before every retried get-or-create attempt", async () => {
    const statements: string[][] = [];
    let attempt = -1;
    const db = executor((config) => {
      statements[attempt].push(
        config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
          ? "isolation"
          : config.text.includes("pg_advisory_xact_lock")
            ? "lock"
            : "lookup",
      );
      if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED" && attempt < 2) {
        throw Object.assign(
          new Error("retry isolation setup"),
          { code: attempt === 0 ? "40001" : "40P01" },
        );
      }
      if (config.text.includes("pg_advisory_xact_lock")) {
        return result([{ pg_advisory_xact_lock: null }]);
      }
      return result([conversationRow]);
    });
    db.transaction.mockImplementation(async (
      callback: Parameters<PostgreSqlConversationExecutor["transaction"]>[0],
    ) => {
      attempt += 1;
      statements.push([]);
      return callback(db);
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.getOrCreateConversation("session-a"))
      .resolves.toMatchObject({ conversationId: 41 });
    expect(statements).toEqual([
      ["isolation"],
      ["isolation"],
      ["isolation", "lock", "lookup"],
    ]);
  });

  it("re-establishes READ COMMITTED before every retried append attempt", async () => {
    const statements: string[][] = [];
    let attempt = -1;
    const db = executor((config) => {
      statements[attempt].push(
        config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
          ? "isolation"
          : config.text.includes("FOR UPDATE")
            ? "lock"
            : config.text.includes("MAX(seq)")
              ? "maximum"
              : "insert",
      );
      if (config.text.includes("FOR UPDATE") && attempt === 0) {
        throw Object.assign(
          new Error("retry row lock"),
          { code: "40001" },
        );
      }
      if (config.text.includes("MAX(seq)") && attempt === 1) {
        throw Object.assign(new Error("retry maximum read"), { code: "40P01" });
      }
      if (config.text.includes("FOR UPDATE")) {
        return result([{ conversation_id: "41" }]);
      }
      if (config.text.includes("MAX(seq)")) {
        return result([{ max_seq: null }]);
      }
      return result([messageRow]);
    });
    db.transaction.mockImplementation(async (
      callback: Parameters<PostgreSqlConversationExecutor["transaction"]>[0],
    ) => {
      attempt += 1;
      statements.push([]);
      return callback(db);
    });
    const repository = new PostgreSqlConversationRepository(db, projectId);

    await expect(repository.appendMessages(41, [{
      role: "user",
      content: "append",
      tokenCount: 1,
    }])).resolves.toMatchObject([{ seq: 0 }]);
    expect(statements).toEqual([
      ["isolation", "lock"],
      ["isolation", "lock", "maximum"],
      ["isolation", "lock", "maximum", "insert"],
    ]);
  });

  it("never retries non-contention failures or ambiguous commits", async () => {
    const directContention = executor(() => result([]));
    directContention.transaction.mockRejectedValue(
      Object.assign(new Error("serialization"), { code: "40001" }),
    );
    await expect(new PostgreSqlConversationRepository(directContention, projectId)
      .createConversation({ sessionId: "direct-contention" }))
      .rejects.toMatchObject({ code: "40001" });
    expect(directContention.transaction).toHaveBeenCalledTimes(1);

    const directAmbiguous = executor(() => result([]));
    directAmbiguous.transaction.mockRejectedValue(new PostgreSqlCommitOutcomeUnknownError({
      domain: "conversations",
      operation: "createMessagesBulk",
      projectId,
    }));
    await expect(new PostgreSqlConversationRepository(directAmbiguous, projectId)
      .createMessagesBulk([{
        conversationId: 1,
        seq: 0,
        role: "user",
        content: "ambiguous",
        tokenCount: 1,
      }])).rejects.toBeInstanceOf(PostgreSqlCommitOutcomeUnknownError);
    expect(directAmbiguous.transaction).toHaveBeenCalledTimes(1);

    const ordinary = executor(() => result([]));
    ordinary.transaction.mockRejectedValue(
      Object.assign(new Error("connection unavailable"), { code: "53300" }),
    );
    await expect(new PostgreSqlConversationRepository(ordinary, projectId)
      .appendMessages(1, [{ role: "user", content: "x", tokenCount: 1 }]))
      .rejects.toMatchObject({ code: "53300" });
    expect(ordinary.transaction).toHaveBeenCalledTimes(1);

    const ambiguous = executor(() => result([]));
    ambiguous.transaction.mockRejectedValue(new PostgreSqlCommitOutcomeUnknownError({
      domain: "conversations",
      operation: "appendMessages",
      projectId,
    }));
    await expect(new PostgreSqlConversationRepository(ambiguous, projectId)
      .appendMessages(1, [{ role: "user", content: "x", tokenCount: 1 }]))
      .rejects.toBeInstanceOf(PostgreSqlCommitOutcomeUnknownError);
    expect(ambiguous.transaction).toHaveBeenCalledTimes(1);
  });
});

function repositoryForInputs(): PostgreSqlConversationRepository {
  return new PostgreSqlConversationRepository(executor(() => {
    throw new Error("unsafe input must not query");
  }), projectId);
}
