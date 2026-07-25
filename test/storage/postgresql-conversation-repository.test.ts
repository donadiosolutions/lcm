import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { PostgreSqlQueryOptions } from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlConversationDataError,
  type PostgreSqlConversationExecutor,
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
      values: [projectId, "new-session"],
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
      ordinal: index,
      textContent: index === inputCount - 1 ? " opaque \u2603 " : undefined,
      metadata: index === inputCount - 1 ? " { not-json } " : undefined,
    }));

    await expect(repository.createMessageParts(51, parts)).resolves.toBeUndefined();

    const config = db.query.mock.calls[0]?.[0];
    expect(config.values).toHaveLength(3);
    expect(config.text).toContain("$3::pg_catalog.jsonb");
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
      ordinal: inputCount - 1,
      text_content: " opaque \u2603 ",
      tool_call_id: null,
      tool_name: null,
      tool_input: null,
      tool_output: null,
      metadata: " { not-json } ",
    });
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
        return result([{ ...partRow, message_id: 53n }]);
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
    await expect(repository.getMessageParts(53)).resolves.toMatchObject([{ messageId: 53 }]);
    await expect(repository.getMessageCount(42)).resolves.toBe(5);
    await expect(repository.getMaxSeq(42)).resolves.toBe(6);
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
    ["createMessage tokens", () => repositoryForInputs().createMessage({
      conversationId: 1,
      seq: 0,
      role: "user",
      content: "x",
      tokenCount: Number.NaN,
    }), "token_count"],
    ["getMessages afterSeq", () => repositoryForInputs().getMessages(1, { afterSeq: 0.5 }), "after_seq"],
    ["getMessages limit", () => repositoryForInputs().getMessages(1, { limit: 1.5 }), "limit"],
    ["createMessageParts ordinal", () => repositoryForInputs().createMessageParts(1, [{
      sessionId: "a",
      partType: "text",
      ordinal: 0.5,
    }]), "ordinal"],
    ["deleteMessages", () => repositoryForInputs().deleteMessages([Number.NaN]), "message_id"],
  ])("rejects unsafe numeric input for %s", async (_case, invoke, field) => {
    const error = await invoke().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgreSqlConversationDataError);
    expect(error).toMatchObject({ field });
  });

  it("rejects append sequence overflow before inserting", async () => {
    const db = executor((config) => {
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
    expect(db.query).toHaveBeenCalledTimes(2);
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

  it("never retries non-contention failures or ambiguous commits", async () => {
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
